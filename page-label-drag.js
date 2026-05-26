(function () {
  "use strict";

  const RECENT_DRAGGED_LABEL_KEY = "recentDraggedLabel";
  const MAX_DRAG_CAPTURE_BYTES = 35 * 1024 * 1024;

  document.addEventListener("dragstart", (event) => {
    captureDraggedLabel(event).catch(() => {});
    setTimeout(() => {
      captureDraggedLabel(event).catch(() => {});
    }, 0);
  }, true);

  async function captureDraggedLabel(event) {
    const candidate = dragDataCandidate(event.dataTransfer) || labelDragCandidate(event.target);
    if (!candidate?.url) return;

    const payload = {
      url: candidate.url,
      name: filenameFromUrl(candidate.url),
      type: candidate.type || "",
      createdAt: Date.now()
    };

    if (/^blob:/i.test(candidate.url)) {
      const blobPayload = await blobUrlPayload(candidate.url, payload.name);
      if (blobPayload) Object.assign(payload, blobPayload);
    }

    await chrome.storage.local.set({ [RECENT_DRAGGED_LABEL_KEY]: payload });
  }

  function dragDataCandidate(transfer) {
    if (!transfer) return null;

    const downloadUrl = transfer.getData("DownloadURL");
    if (downloadUrl) {
      const parts = downloadUrl.split(":");
      const url = parts.length >= 3 ? parts.slice(2).join(":") : downloadUrl;
      if (url) return { url, type: parts[0] || "" };
    }

    const uriList = transfer.getData("text/uri-list");
    if (uriList) {
      const url = uriList.split(/\r?\n/).find((line) => line && !line.startsWith("#")) || "";
      if (url) return { url, type: "" };
    }

    const plain = transfer.getData("text/plain");
    if (/^(https?|blob):/i.test(plain)) return { url: plain, type: "" };

    return null;
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

  function filenameFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      return name || "dragged-label";
    } catch (_) {
      return "dragged-label";
    }
  }
})();
