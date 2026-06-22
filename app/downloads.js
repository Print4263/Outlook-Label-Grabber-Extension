// Recent downloads + label intake: polling the downloads list, the Use/Show/Clear
// actions, loading a file from a download, context-menu (Send to Extractor) intake,
// and the download preview. Plain (non-module) script: functions stay global and are
// called from sidepanel.js (init/bindEvents) exactly as before, using shared helpers
// (state, els, setStatus, setFile, extractSelectedFile, formatBytes, ...) defined there.

async function loadRecentDownloads(options = {}) {
  if (!chrome.downloads?.search) {
    renderDownloadsMessage("Recent downloads are not available in this extension context.");
    return;
  }

  const manual = options.manual === true;
  els.refreshDownloads.disabled = true;
  if (manual || (!els.downloadsList.dataset.signature && !els.downloadsList.dataset.message)) {
    renderDownloadsMessage("Checking recent label files...");
  }

  try {
    const [downloads, senderInfo] = await Promise.all([
      chrome.downloads.search({
        limit: RECENT_DOWNLOAD_LIMIT,
        orderBy: ["-startTime"],
        state: "complete"
      }),
      getStoredSenderInfo()
    ]);
    const labelDownloads = downloads
      .filter(isSupportedDownload)
      .filter(isAfterDownloadsClearedAt);
    renderRecentDownloads(labelDownloads.slice(0, 1), senderInfo);
    reconcileGrabCompletedDownloads(labelDownloads);
    maybeAutoCleanDownloads(labelDownloads);
  } catch (error) {
    renderDownloadsMessage(`Could not read downloads: ${error.message}`);
  } finally {
    els.refreshDownloads.disabled = false;
  }
}

async function getStoredSenderInfo() {
  if (!chrome.storage?.session) return null;
  try {
    const data = await chrome.storage.session.get("outlookSender");
    return data.outlookSender || null;
  } catch (_) {
    return null;
  }
}

function startDownloadsPolling() {
  if (state.downloadsRefreshTimer) clearInterval(state.downloadsRefreshTimer);
  state.downloadsRefreshTimer = setInterval(loadRecentDownloads, DOWNLOAD_FALLBACK_POLL_MS);

  if (chrome.downloads?.onCreated) {
    chrome.downloads.onCreated.addListener((download) => {
      if (!isSupportedDownload(download)) return;
      handleGrabDownloadCreated(download);
      setTimeout(loadRecentDownloads, 300);
    });
  }

  if (chrome.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      handleGrabDownloadChanged(delta);
      if (delta.state?.current !== "complete") return;
      chrome.downloads.search({ id: delta.id }, (items) => {
        // The file is on disk once state is "complete" — only a short settle
        // delay is needed before the Use row can appear.
        if (isSupportedDownload(items?.[0])) setTimeout(loadRecentDownloads, 150);
      });
    });
  }
}

async function snapshotSupportedDownloadIds() {
  if (!chrome.downloads?.search) return [];
  try {
    const downloads = await chrome.downloads.search({
      limit: RECENT_DOWNLOAD_LIMIT,
      orderBy: ["-startTime"]
    });
    return downloads.filter(isSupportedDownload).map((download) => Number(download.id));
  } catch (_) {
    return [];
  }
}

function maybeAutoCleanDownloads(labelDownloads) {
  if (state.downloadCleanupInProgress) return;
  if (labelDownloads.length <= AUTO_CLEANUP_THRESHOLD) return;
  clearOldLabelDownloads({
    keepNewest: AUTO_CLEANUP_KEEP,
    automatic: true,
    downloads: labelDownloads
  }).catch((error) => console.warn("[Label Extractor] Auto cleanup failed.", error));
}

async function clearOldLabelDownloads(options = {}) {
  if (!chrome.downloads?.erase) return;

  state.downloadCleanupInProgress = true;

  try {
    const keepNewest = Number(options.keepNewest ?? AUTO_CLEANUP_KEEP);
    const labelDownloads = options.downloads || (await chrome.downloads.search({
      limit: RECENT_DOWNLOAD_LIMIT,
      orderBy: ["-startTime"],
      state: "complete"
    })).filter(isSupportedDownload);
    const toErase = labelDownloads.slice(Math.max(0, keepNewest));

    for (const download of toErase) {
      chrome.downloads.erase({ id: download.id }).catch(() => {});
      state.suppressedDownloadIds.delete(download.id);
      state.seenDownloadIds.delete(download.id);
    }

    await loadRecentDownloads();
  } finally {
    state.downloadCleanupInProgress = false;
  }
}

function isSupportedDownload(download) {
  if (!download?.filename || download.exists === false) return false;
  return /\.(pdf|png|jpe?g|gif|webp|hei[cf])$/i.test(download.filename);
}

function isAfterDownloadsClearedAt(download) {
  if (!state.downloadsClearedAt) return true;
  const startedAt = download.startTime ? Date.parse(download.startTime) : 0;
  return startedAt > state.downloadsClearedAt;
}

async function clearRecentDownloadsList() {
  state.downloadsClearedAt = Date.now();
  state.seenDownloadIds.clear();
  state.suppressedDownloadIds.clear();
  clearDownloadPreview();
  clearCurrentWork();
  await chrome.storage.local.set({ labelDownloadsClearedAt: state.downloadsClearedAt });
  renderDownloadsMessage("Download list cleared. Waiting for the next label download.");
  setStatus("Recent download list cleared.");
}

function renderRecentDownloads(downloads, senderInfo) {
  const visible = downloads.filter((d) => !state.suppressedDownloadIds.has(d.id));

  if (!visible.length) {
    const msg = downloads.length
      ? "Last label processed — waiting for next download."
      : "No recent label found. Finish Outlook's Download, then select Refresh.";
    renderDownloadsMessage(msg);
    state.firstPollDone = true;
    return;
  }

  const nextSignature = visible.map((d) => `${d.id}:${d.filename}:${d.fileSize || d.totalBytes || 0}`).join("|");
  if (els.downloadsList.dataset.signature === nextSignature) {
    state.firstPollDone = true;
    return;
  }

  const newIds = state.firstPollDone
    ? visible.filter((d) => !state.seenDownloadIds.has(d.id)).map((d) => d.id)
    : [];

  visible.forEach((d) => state.seenDownloadIds.add(d.id));
  state.firstPollDone = true;

  els.downloadsList.dataset.signature = nextSignature;
  els.downloadsList.dataset.message = "";
  els.downloadsList.replaceChildren();

  if (newIds.length) {
    triggerNewDownloadIndicator();
  }

  for (const download of visible) {
    const isNew = newIds.includes(download.id);
    const freshness = getDownloadFreshness(download);
    const isStale = freshness.state === "older";
    const row = document.createElement("article");
    row.className = [
      "download-row",
      isNew ? "new-row selected-download" : "",
      freshness.state === "new" ? "fresh-row" : "",
      freshness.state === "recent" ? "recent-row" : "",
      isStale ? "stale-row" : ""
    ].filter(Boolean).join(" ");
    row.draggable = true;
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-label-download-id", String(download.id));
      event.dataTransfer.effectAllowed = "copy";
    });

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = basename(download.filename);

    const meta = document.createElement("span");
    meta.className = "download-meta";
    const sizePart = formatBytes(download.fileSize || download.totalBytes || 0);
    const timePart = download.startTime ? formatDownloadTime(download.startTime) : "";

    let senderPart = "";
    if (senderInfo?.name) {
      const age = Date.now() - (senderInfo.timestamp || 0);
      if (age < 300000) {
        senderPart = senderInfo.email
          ? `${senderInfo.name} <${senderInfo.email}>`
          : senderInfo.name;
      }
    }

    const sizeNode = document.createElement("span");
    sizeNode.textContent = sizePart;
    meta.append(sizeNode);
    if (timePart) {
      const timeNode = document.createElement("strong");
      timeNode.className = "download-time";
      timeNode.textContent = timePart;
      meta.append(timeNode);
    }
    if (freshness.label) {
      const freshnessNode = document.createElement("span");
      freshnessNode.textContent = freshness.label;
      meta.append(freshnessNode);
    }
    if (senderPart) {
      const senderNode = document.createElement("span");
      senderNode.textContent = senderPart;
      meta.append(senderNode);
    }
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "download-actions";

    const useButton = document.createElement("button");
    useButton.type = "button";
    useButton.textContent = isStale ? "Confirm use" : "Use";
    useButton.className = isStale ? "use-download-button stale-use-button" : "use-download-button";
    if (state.suppressedDownloadIds.has(download.id)) {
      useButton.textContent = "Used";
      useButton.disabled = true;
      row.classList.add("used-row");
    } else if ((isNew || freshness.state === "new") && !isStale) {
      useButton.autofocus = true;
    }
    useButton.addEventListener("click", () => useDownloadedFile(download, {
      extractAfterLoad: true,
      requireStaleConfirm: isStale
    }));

    const showButton = document.createElement("button");
    showButton.type = "button";
    showButton.textContent = "Show";
    showButton.addEventListener("click", () => previewDownloadedFile(download));

    actions.append(useButton, showButton);
    row.append(info, actions);
    els.downloadsList.append(row);

    if ((isNew || freshness.state === "new") && !isStale) {
      requestAnimationFrame(() => useButton.focus({ preventScroll: true }));
    }
  }

}

function getDownloadFreshness(download) {
  const startedAt = download?.startTime ? Date.parse(download.startTime) : 0;
  if (!startedAt) return { state: "unknown", label: "" };

  const age = Date.now() - startedAt;
  if (age > STALE_DOWNLOAD_MS) return { state: "older", label: "Older label" };
  if (age <= NEW_DOWNLOAD_MS) return { state: "new", label: "New" };
  return { state: "recent", label: "Recent" };
}

function triggerNewDownloadIndicator() {
  els.recentDownloads.classList.remove("has-new-download");
  void els.recentDownloads.offsetWidth;
  els.recentDownloads.classList.add("has-new-download");
  setTimeout(() => {
    els.recentDownloads.classList.remove("has-new-download");
    els.downloadsList.querySelectorAll(".new-row").forEach((row) => row.classList.remove("new-row"));
  }, 12000);
}

function renderDownloadsMessage(message) {
  if (els.downloadsList.dataset.message === message) return;
  els.downloadsList.dataset.message = message;
  els.downloadsList.dataset.signature = "";
  els.downloadsList.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = message;
  els.downloadsList.append(empty);
}

async function useDownloadedFile(download, options = {}) {
  if (options.requireStaleConfirm && !window.confirm("This label download is older than 10 minutes. Use it anyway?")) {
    setStatus("Older label not used.");
    return;
  }

  try {
    setStatus(options.automatic ? "Loading newest download..." : "Loading downloaded file...", "loading");
    const response = await fetch(pathToFileUrl(download.filename));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const name = basename(download.filename);
    const file = new File([blob], name, { type: blob.type || mimeTypeFromName(name) });

    setFile(file);
    if (download?.id) {
      state.activeDownloadId = download.id;
      state.suppressedDownloadIds.add(download.id);
      renderDownloadsMessage("Download marked used. Waiting for the next label download.");
    }
    if (options.extractAfterLoad) {
      setStatus("Downloaded file loaded. Extracting label...", "loading");
      await extractSelectedFile();
    } else {
      setStatus("Downloaded file loaded. Click Extract Label.");
    }
  } catch (error) {
    if (!options.automatic) {
      setStatus(`Could not open the downloaded file: ${error.message}. In chrome://extensions, enable “Allow access to file URLs”, then retry. Or select Show and drag the file here.`, "error");
      showBanner("Could not open that download. Enable “Allow access to file URLs” in chrome://extensions, then retry — or use Show and drag the file in.", "error", 9000);
    }
  }
}

async function processPendingContextLabel(pending) {
  if (!pending) return;

  await chrome.storage.local.remove(PENDING_CONTEXT_LABEL_KEY).catch(() => {});
  if (pending.error && !pending.dataUrl) {
    setStatus(`Could not send label from page: ${pending.error}`, "error");
    return;
  }

  if (pending.dataUrl) {
    await loadContextLabelDataUrl(pending.dataUrl, pending.name, pending.type);
    return;
  }

  if (pending.url) await loadContextLabelUrl(pending.url, pending.name);
}

async function loadContextLabelUrl(url, suggestedName) {
  if (state.extractionInProgress) {
    setStatus("Finish the current extraction before sending another label.", "error");
    return;
  }

  try {
    clearDownloadPreview();
    setStatus("Loading label from page...", "loading");
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = cleanMimeType(response.headers.get("content-type"));
    const blob = await response.blob();
    const type = cleanMimeType(blob.type) || contentType || mimeTypeFromName(suggestedName || url);
    const name = filenameForContextLabel(suggestedName || url, type);
    const file = new File([blob], name, { type });

    if (!isSupportedFile(file)) {
      throw new Error("That link did not return a PDF, PNG, JPG, JPEG, GIF, or WEBP label.");
    }

    setFile(file);
    state.activeDownloadId = null;
    setStatus("Page label loaded. Extracting label...", "loading");
    await extractSelectedFile();
  } catch (error) {
    setStatus(`Could not send label from page: ${error.message}`, "error");
    showBanner(`Could not load that label: ${error.message}. Try Recent downloads or Choose file.`, "error", 8000);
  }
}

async function loadContextLabelDataUrl(dataUrl, suggestedName, suggestedType) {
  if (state.extractionInProgress) {
    setStatus("Finish the current extraction before sending another label.", "error");
    return;
  }

  try {
    clearDownloadPreview();
    setStatus("Loading protected label from page...", "loading");
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const type = cleanMimeType(blob.type) || cleanMimeType(suggestedType) || mimeTypeFromName(suggestedName || "");
    const name = filenameForContextLabel(suggestedName || "sent-label", type);
    const file = new File([blob], name, { type });

    if (!isSupportedFile(file)) {
      throw new Error("That page item did not provide a PDF, PNG, JPG, JPEG, GIF, or WEBP label.");
    }

    setFile(file);
    state.activeDownloadId = null;
    setStatus("Page label loaded. Extracting label...", "loading");
    await extractSelectedFile();
  } catch (error) {
    setStatus(`Could not send label from page: ${error.message}`, "error");
    showBanner(`Could not load that label: ${error.message}. Try Recent downloads or Choose file.`, "error", 8000);
  }
}

function cleanMimeType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function filenameForContextLabel(value, type) {
  const raw = basename(value).split(/[?#]/)[0] || "sent-label";
  const clean = raw.replace(/[<>:"|?*\x00-\x1f]/g, "-") || "sent-label";
  if (/\.(pdf|png|jpe?g|gif|webp|hei[cf])$/i.test(clean)) return clean;

  if (type === "application/pdf") return `${clean}.pdf`;
  if (type === "image/png") return `${clean}.png`;
  if (type === "image/jpeg") return `${clean}.jpg`;
  if (type === "image/gif") return `${clean}.gif`;
  if (type === "image/webp") return `${clean}.webp`;
  if (type === "image/heic") return `${clean}.heic`;
  if (type === "image/heif") return `${clean}.heif`;
  return clean;
}

async function previewDownloadedFile(download) {
  try {
    setStatus("Loading preview...", "loading");
    clearDownloadPreview();
    const response = await fetch(pathToFileUrl(download.filename));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const name = basename(download.filename);
    const type = blob.type || mimeTypeFromName(name);
    const url = URL.createObjectURL(new Blob([blob], { type }));
    state.downloadPreviewUrl = url;

    const header = document.createElement("div");
    header.className = "download-preview-header";
    const title = document.createElement("strong");
    title.textContent = name;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", clearDownloadPreview);
    header.append(title, closeButton);

    const viewer = type === "application/pdf" || /\.pdf$/i.test(name)
      ? document.createElement("iframe")
      : document.createElement("img");
    viewer.src = url;
    viewer.title = name;
    if (viewer.tagName === "IMG") viewer.alt = name;

    els.downloadPreview.replaceChildren(header, viewer);
    els.downloadPreview.hidden = false;
    setStatus("Preview loaded.");
  } catch (error) {
    clearDownloadPreview();
    setStatus(`Could not preview the download: ${error.message}. In chrome://extensions, enable “Allow access to file URLs”, then retry.`);
  }
}

function clearDownloadPreview() {
  if (state.downloadPreviewUrl) {
    URL.revokeObjectURL(state.downloadPreviewUrl);
    state.downloadPreviewUrl = "";
  }
  els.downloadPreview.replaceChildren();
  els.downloadPreview.hidden = true;
}

function pathToFileUrl(filename) {
  const normalized = filename.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${prefixed.split("/").map((part, index) => {
    if (index === 1 && /^[A-Za-z]:$/.test(part)) return part;
    return encodeURIComponent(part);
  }).join("/")}`;
}

function basename(filename) {
  return String(filename || "").split(/[\\/]/).pop() || "downloaded-label";
}

function mimeTypeFromName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return "application/octet-stream";
}

function formatDownloadTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
