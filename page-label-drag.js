(function () {
  "use strict";

  const RECENT_DRAGGED_LABEL_KEY = "recentDraggedLabel";
  // The captured blob is base64-encoded into the payload and held in
  // storage.session (10 MB quota). Cap the blob so the payload stays under it
  // (base64 inflates ~33%): 7 MB -> ~9.4 MB. Larger drags fall back to the
  // url-only payload, which the panel resolves via the background all-frames read.
  const MAX_DRAG_CAPTURE_BYTES = 7 * 1024 * 1024;
  const RECENT_DRAGGED_LABEL_MAX_AGE_MS = 2 * 60 * 1000;
  let recentDragCleanupTimer = null;

  document.addEventListener("dragstart", (event) => {
    captureDraggedLabel(event).catch(() => {});
    setTimeout(() => {
      captureDraggedLabel(event).catch(() => {});
    }, 0);
  }, true);

  async function captureDraggedLabel(event) {
    const dragData = window.LabelExtractorDragData;
    const candidate = dragData?.candidateFromTransfer?.(event.dataTransfer) || labelDragCandidate(event.target);
    if (!candidate?.url) return;

    const payload = {
      url: candidate.url,
      name: dragData?.filenameFromUrl?.(candidate.url) || "dragged-label",
      type: candidate.type || "",
      captureId: globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: Date.now()
    };

    if (/^blob:/i.test(candidate.url)) {
      // Read the blob to a data URL NOW — while the drag is live and the blob is
      // still valid in this frame's origin. The panel (a different context) can't
      // fetch it later. On failure, leave the url-only payload so the panel can
      // fall back to the background all-frames resolve.
      try {
        const blobPayload = await blobUrlPayload(candidate.url, payload.name);
        if (blobPayload) Object.assign(payload, blobPayload);
      } catch (_) { /* keep url-only payload */ }
    }

    await chrome.storage.session.set({ [RECENT_DRAGGED_LABEL_KEY]: payload });
    // A large data-URL payload alongside a sibling pending-context label could exceed
    // the 10 MB session quota; a new intake supersedes the other, so drop it when we
    // just stored a big one. (Small url-only payloads can't blow the quota.)
    if (payload.dataUrl) chrome.storage.session.remove("pendingContextLabel").catch(() => {});
    scheduleRecentDragCleanup(payload.captureId);
  }

  function scheduleRecentDragCleanup(captureId) {
    clearTimeout(recentDragCleanupTimer);
    recentDragCleanupTimer = setTimeout(async () => {
      try {
        const data = await chrome.storage.session.get(RECENT_DRAGGED_LABEL_KEY);
        if (data[RECENT_DRAGGED_LABEL_KEY]?.captureId === captureId) {
          await chrome.storage.session.remove(RECENT_DRAGGED_LABEL_KEY);
        }
      } catch (_) { /* best-effort expiry; the panel also removes stale entries */ }
    }, RECENT_DRAGGED_LABEL_MAX_AGE_MS);
  }

  function labelDragCandidate(target) {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return null;
    const element = target.closest("a[href], img[src], iframe[src], embed[src], object[data]");
    if (!element) return null;

    if (element.tagName === "A") {
      return { url: element.href || "", type: "" };
    }
    if (element.tagName === "IMG") {
      return { url: element.currentSrc || element.src || "", type: "" };
    }
    if (element.tagName === "IFRAME" || element.tagName === "EMBED") {
      return { url: element.src || "", type: "" };
    }
    if (element.tagName === "OBJECT") {
      return { url: element.data || "", type: "" };
    }
    return null;
  }

  async function blobUrlPayload(url, name) {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > MAX_DRAG_CAPTURE_BYTES) return null;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read dragged label."));
      reader.readAsDataURL(blob);
    });
    return {
      dataUrl,
      name,
      type: blob.type || ""
    };
  }

})();
