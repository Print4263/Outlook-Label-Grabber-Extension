const state = {
  file: null,
  results: [],
  selectedLabelIndex: -1,
  cropTargetIndex: -1,
  cropRect: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
  printWidth: 4,
  printLeft: 0,
  printTop: 0,
  printMode: "label",
  downloadsRefreshTimer: null,
  downloadPreviewUrl: "",
  inactivityTimer: null,
  inactivityCountdownTimer: null,
  inactivityCountdownSeconds: 0,
  seenDownloadIds: new Set(),
  suppressedDownloadIds: new Set(),
  downloadsClearedAt: 0,
  firstPollDone: false,
  downloadCleanupInProgress: false,
  labelsPrintedCount: 0,
  extractionRunId: 0,
  extractionInProgress: false,
  cachedPages: null,
  cachedPagesKey: "",
  modelWarmupStarted: false,
  activeDownloadId: null,
  clearMode: "idle",
  uiMode: "staff",
  lastExtractionSummary: null
};

const LOCAL_DETECTOR_REASONS = new Set([
  "trained-model",
  "page-dimensions",
  "dashed-border",
  "solid-border",
  "keywords",
  "lower-barcode-label",
  "barcode-density",
  "text-label-page",
  "embedded-label-page",
  "image-label-fallback",
  "manual-image-fallback",
  "fashion-nova-lower-barcode"
]);

const MIN_FULL_LABEL_CONFIDENCE = 0.45;
const MIN_CROP_VARIANT_CONFIDENCE = 0.35;
const FALLBACK_MIN_CONFIDENCE = 0.1;
const FALLBACK_PAGE_LIMIT = 6;
const FALLBACK_CONTENT_PADDING_RATIO = 0.14;
const FALLBACK_CENTER_SCALE = 0.88;
const FALLBACK_WARNING = "Fallback result; crop/rotate before printing.";
const LABEL_ASPECT_4X6 = 4 / 6;
const FALLBACK_CROP_INITIAL_WIDTH = 0.78;
const FALLBACK_CROP_MAX_SIZE = 0.88;
const DOWNLOAD_FALLBACK_POLL_MS = 25000;
const RECENT_DOWNLOAD_LIMIT = 50;
const AUTO_CLEANUP_THRESHOLD = 15;
const AUTO_CLEANUP_KEEP = 3;
const MANUAL_CLEANUP_KEEP = 1;
const CLEAR_WARNING_DELAY_MS = 40000;
const CLEAR_COUNTDOWN_SECONDS = 60;
const POPOUT_WIDTH_RATIO = 0.30;
const POPOUT_MIN_WIDTH = 520;
const POPOUT_MAX_WIDTH = 760;
const TRUSTED_LOCAL_CONFIDENCE = 0.90;
const STALE_DOWNLOAD_MS = 10 * 60 * 1000;
const NEW_DOWNLOAD_MS = 4 * 60 * 1000;
const REVIEW_CLEAR_WARNING_DELAY_MS = 70000;

const els = {
  statusText: document.getElementById("statusText"),
  modeToggle: document.getElementById("modeToggle"),
  popoutButton: document.getElementById("popoutButton"),
  resetLayoutButton: document.getElementById("resetLayoutButton"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  pickFile: document.getElementById("pickFile"),
  grabOutlookAttachment: document.getElementById("grabOutlookAttachment"),
  clearDownloads: document.getElementById("clearDownloads"),
  refreshDownloads: document.getElementById("refreshDownloads"),
  downloadsList: document.getElementById("downloadsList"),
  downloadPreview: document.getElementById("downloadPreview"),
  recentDownloads: document.querySelector(".recent-downloads"),
  fileName: document.getElementById("fileName"),
  clearButton: document.getElementById("clearButton"),
  clearReminder: document.getElementById("clearReminder"),
  extractButton: document.getElementById("extractButton"),
  progress: document.getElementById("progress"),
  progressText: document.getElementById("progressText"),
  progressNote: document.getElementById("progressNote"),
  loadingBarFill: document.getElementById("loadingBarFill"),
  results: document.getElementById("results"),
  labPanel: document.getElementById("labPanel"),
  copyDebugReport: document.getElementById("copyDebugReport"),
  debugReportStatus: document.getElementById("debugReportStatus"),
  printSettings: document.getElementById("printSettings"),
  sheetPreviewLabel: document.getElementById("sheetPreviewLabel"),
  cropEditor: document.getElementById("cropEditor"),
  closeCropEditor: document.getElementById("closeCropEditor"),
  cropStage: document.querySelector(".crop-stage"),
  cropImage: document.getElementById("cropImage"),
  cropLayer: document.getElementById("cropLayer"),
  cropBox: document.getElementById("cropBox"),
  applyCrop: document.getElementById("applyCrop"),
  resetCrop: document.getElementById("resetCrop"),
  alertBanner: document.getElementById("alertBanner"),
  inactivityWarning: document.getElementById("inactivityWarning"),
  inactivityText: document.getElementById("inactivityText"),
  inactivityProgress: document.getElementById("inactivityProgress"),
  inactivityCancel: document.getElementById("inactivityCancel")
};

init();

async function init() {
  const saved = await chrome.storage.local.get([
    "letterLabelPrintWidth",
    "letterLabelPrintLeft",
    "letterLabelPrintTop",
    "labelExtractorPrintMode",
    "labelDownloadsClearedAt"
  ]);
  state.printWidth = Number(saved.letterLabelPrintWidth ?? 4);
  state.printLeft = Number(saved.letterLabelPrintLeft ?? 0);
  state.printTop = Number(saved.letterLabelPrintTop ?? 0);
  state.printMode = "label";
  state.downloadsClearedAt = Number(saved.labelDownloadsClearedAt || 0);
  state.uiMode = "staff";
  syncPrintControls();
  applyUiMode();

  bindEvents();
  setStatus("Ready.");
  loadRecentDownloads();
  startDownloadsPolling();
}

function bindEvents() {
  els.modeToggle?.addEventListener("click", toggleUiMode);
  els.copyDebugReport?.addEventListener("click", copyDebugReport);
  els.popoutButton?.addEventListener("click", openPopoutWindow);
  els.resetLayoutButton?.addEventListener("click", resetSavedPopoutLayout);
  els.pickFile.addEventListener("click", () => els.fileInput.click());
  els.grabOutlookAttachment?.addEventListener("click", grabOutlookAttachment);
  els.clearDownloads.addEventListener("click", clearRecentDownloadsList);
  els.refreshDownloads.addEventListener("click", () => loadRecentDownloads({ manual: true }));
  els.fileInput.addEventListener("change", () => setFile(els.fileInput.files?.[0] || null));
  els.clearButton.addEventListener("click", clearCurrentWork);
  els.extractButton.addEventListener("click", extractSelectedFile);
  els.closeCropEditor.addEventListener("click", closeCropEditor);
  els.applyCrop.addEventListener("click", applyManualCrop);
  els.resetCrop.addEventListener("click", resetCropBox);
  els.inactivityCancel.addEventListener("click", () => {
    clearInactivityWarning();
    resetInactivityTimer();
  });
  bindCropBoxEvents();

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragging");
    });
  });

  els.dropZone.addEventListener("drop", handleDrop);
}

function toggleUiMode() {
  state.uiMode = state.uiMode === "lab" ? "staff" : "lab";
  applyUiMode();
  renderResults({ labels: state.results });
}

function applyUiMode() {
  const labMode = state.uiMode === "lab";
  document.body.classList.toggle("lab-mode", labMode);
  document.body.classList.toggle("staff-mode", !labMode);
  if (els.modeToggle) {
    els.modeToggle.textContent = labMode ? "Staff mode" : "Lab mode";
    els.modeToggle.title = labMode ? "Hide lab tools and debug details" : "Show lab tools and debug details";
  }
  if (els.labPanel) els.labPanel.hidden = !labMode;
}

async function copyDebugReport() {
  const report = buildDebugReport();
  try {
    await navigator.clipboard.writeText(report);
    if (els.debugReportStatus) els.debugReportStatus.textContent = "Debug report copied.";
    setStatus("Debug report copied.");
  } catch (error) {
    if (els.debugReportStatus) els.debugReportStatus.textContent = "Could not copy debug report.";
    setStatus(`Could not copy debug report: ${error.message}`, "error");
  }
}

function buildDebugReport() {
  const file = state.file;
  const cachedPages = (state.cachedPages || []).map((page) => ({
    pageIndex: page.pageIndex,
    pageCount: page.pageCount,
    type: page.type,
    width: page.canvas?.width || null,
    height: page.canvas?.height || null,
    textLength: String(page.text || "").length,
    embeddedImageCount: page.embeddedImageCount || 0
  }));
  const results = state.results.map((label, index) => ({
    index,
    variantName: label.variantName || "",
    action: getLabelActionState(label).label,
    carrier: label.carrier || "",
    confidence: Number(label.confidence || 0),
    reason: label.localReason || "",
    sourcePage: label.sourcePage || null,
    pageCount: label.pageCount || null,
    size: `${label.width || 0}x${label.height || 0}`,
    needsCrop: Boolean(label.needsCrop),
    warnings: label.warnings || []
  }));
  return JSON.stringify({
    app: "Domain Expansion: Print Label",
    time: new Date().toISOString(),
    mode: state.uiMode,
    status: els.statusText?.textContent || "",
    file: file ? {
      name: file.name,
      type: file.type,
      size: file.size,
      cacheKey: fileCacheKey(file)
    } : null,
    activeDownloadId: state.activeDownloadId,
    extraction: state.lastExtractionSummary,
    cachedPages,
    results,
    print: {
      mode: state.printMode,
      width: state.printWidth,
      left: state.printLeft,
      top: state.printTop
    }
  }, null, 2);
}

async function openPopoutWindow() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "open-label-popout" });
    if (response?.ok) return;
  } catch (_) {}

  openFallbackPopoutWindow();
}

function openFallbackPopoutWindow() {
  const url = chrome.runtime.getURL("sidepanel.html");
  const bounds = getSidePopoutBounds();
  window.open(url, "_blank", `width=${bounds.width},height=${bounds.height},left=${bounds.left},top=${bounds.top},resizable=yes`);
}

async function resetSavedPopoutLayout() {
  const bounds = getSidePopoutBounds();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "reset-label-popout-layout",
      bounds
    });
    if (!response?.ok) throw new Error(response?.message || "Reset failed.");
    setStatus("Popout layout reset.");
  } catch (error) {
    setStatus(`Could not reset layout: ${error.message}`, "error");
  }
}

async function grabOutlookAttachment() {
  if (!chrome.runtime?.sendMessage) {
    setStatus("Outlook grab is not available here.", "error");
    return;
  }

  const button = els.grabOutlookAttachment;
  if (button) button.disabled = true;
  setStatus("Looking for a label attachment in Outlook...", "loading");

  try {
    const response = await chrome.runtime.sendMessage({ type: "grab-outlook-label-attachment" });
    if (!response?.ok) throw new Error(response?.message || "No Outlook label attachment found.");

    const method = outlookGrabMethodName(response.method);
    setStatus(response.fileName
      ? `Started Outlook download from ${method}: ${response.fileName}`
      : `Started Outlook download from ${method}.`, "loading");
    scheduleFastDownloadChecks();
  } catch (error) {
    setStatus(`Outlook grab failed: ${error.message}`, "error");
    showBanner(`Outlook grab failed: ${error.message}`, "error", 7000);
  } finally {
    if (button) button.disabled = false;
  }
}

function outlookGrabMethodName(method) {
  if (method === "preview-download-action") return "preview toolbar";
  if (method === "keyboard-menu-download-action") return "keyboard menu";
  if (method === "page-download-action") return "page toolbar";
  return "attachment menu";
}

function scheduleFastDownloadChecks() {
  [350, 900, 1600].forEach((ms) => {
    setTimeout(() => loadRecentDownloads({ manual: true }), ms);
  });
}

function getSidePopoutBounds() {
  const screenLeft = Number(window.screen.availLeft || 0);
  const screenTop = Number(window.screen.availTop || 0);
  const screenWidth = Number(window.screen.availWidth || window.screen.width || 1280);
  const screenHeight = Number(window.screen.availHeight || window.screen.height || 900);
  const width = Math.round(clamp(screenWidth * POPOUT_WIDTH_RATIO, POPOUT_MIN_WIDTH, POPOUT_MAX_WIDTH));

  return {
    left: Math.round(screenLeft + screenWidth - width),
    top: Math.round(screenTop),
    width,
    height: Math.round(screenHeight)
  };
}

const MEMORY_CLEANUP_EVERY = 4;

async function backgroundMemoryCleanup() {
  if (chrome.storage?.session) {
    chrome.storage.session.clear().catch(() => {});
  }

  state.seenDownloadIds.clear();

  if (chrome.downloads?.erase && chrome.downloads?.search) {
    try {
      const downloads = await chrome.downloads.search({
        limit: RECENT_DOWNLOAD_LIMIT,
        orderBy: ["-startTime"],
        state: "complete"
      });
      const labelDownloads = downloads.filter(isSupportedDownload);
      const toErase = labelDownloads.slice(AUTO_CLEANUP_KEEP);
      for (const dl of toErase) {
        chrome.downloads.erase({ id: dl.id }).catch(() => {});
        state.suppressedDownloadIds.delete(dl.id);
      }
    } catch (_) {}
  }
}

function resetInactivityTimer(mode = "review") {
  if (!state.file) return;
  state.clearMode = mode;
  clearInactivityWarning();
  clearTimeout(state.inactivityTimer);
  const delayMs = mode === "printed" ? CLEAR_WARNING_DELAY_MS : REVIEW_CLEAR_WARNING_DELAY_MS;
  state.inactivityTimer = setTimeout(startInactivityWarning, delayMs);
}

function startInactivityWarning() {
  if (!state.file) return;
  if (!els.progress.hidden) {
    resetInactivityTimer();
    return;
  }
  state.inactivityCountdownSeconds = CLEAR_COUNTDOWN_SECONDS;
  els.inactivityWarning.hidden = false;
  updateInactivityWarning();
  state.inactivityCountdownTimer = setInterval(() => {
    state.inactivityCountdownSeconds--;
    updateInactivityWarning();
    if (state.inactivityCountdownSeconds <= 0) {
      clearInactivityWarning();
      clearCurrentWork();
      showBanner(
        state.clearMode === "printed"
          ? "Printed label auto-cleared — load the next customer's label."
          : "Label review timed out — load the next customer's label.",
        "warning",
        5000
      );
    }
  }, 1000);
}

function clearInactivityWarning() {
  clearInterval(state.inactivityCountdownTimer);
  state.inactivityCountdownTimer = null;
  els.inactivityWarning.hidden = true;
  els.inactivityProgress.style.width = "100%";
}

function updateInactivityWarning() {
  const s = state.inactivityCountdownSeconds;
  els.inactivityText.textContent = `Label auto-clearing in ${s}s — tap Keep to cancel`;
  els.inactivityProgress.style.width = `${(s / CLEAR_COUNTDOWN_SECONDS) * 100}%`;
}

function showBanner(message, type = "info", duration = 4000) {
  els.alertBanner.textContent = message;
  els.alertBanner.className = `alert-banner ${type}`;
  els.alertBanner.hidden = false;
  clearTimeout(els.alertBanner._dismissTimer);
  els.alertBanner._dismissTimer = setTimeout(() => {
    els.alertBanner.hidden = true;
  }, duration);
}

function setFile(file) {
  clearLoadedLabelState();
  resetFileSelection();

  if (!file) return;
  if (!isSupportedFile(file)) {
    setStatus("Choose a PDF, PNG, JPG, or JPEG file.");
    return;
  }
  if (file.size > LabelExtractorConfig.MAX_UPLOAD_BYTES) {
    setStatus("File is too large for this first version.");
    return;
  }

  state.file = file;
  els.fileName.textContent = `${file.name} (${formatBytes(file.size)})`;
  els.extractButton.disabled = false;
  els.clearButton.disabled = false;
  scheduleModelWarmup(700);
  resetInactivityTimer();
}

function clearLoadedLabelState() {
  state.extractionRunId++;
  state.extractionInProgress = false;
  state.cachedPages = null;
  state.cachedPagesKey = "";
  state.results = [];
  state.selectedLabelIndex = -1;
  state.activeDownloadId = null;
  state.lastExtractionSummary = null;
  closeCropEditor();
  clearDownloadPreview();
  clearInactivityWarning();
  els.progress.hidden = true;
  setLoadingProgress(0);
  els.results.replaceChildren();
  els.clearButton.classList.remove("needs-clear");
  els.clearReminder.hidden = true;
  els.printSettings.classList.add("inactive");
  updateSheetPreview();
}

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
      if (isSupportedDownload(download)) setTimeout(loadRecentDownloads, 800);
    });
  }

  if (chrome.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      if (delta.state?.current !== "complete") return;
      chrome.downloads.search({ id: delta.id }, (items) => {
        if (isSupportedDownload(items?.[0])) setTimeout(loadRecentDownloads, 500);
      });
    });
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
  return /\.(pdf|png|jpe?g|gif)$/i.test(download.filename);
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
      : "No recent label downloads found. Try Refresh after the Outlook download finishes.";
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
      setStatus(`Could not load download directly: ${error.message}. Enable file URL access for this extension, or click Show and drag the file from the folder.`);
    }
  }
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
    setStatus(`Could not preview download: ${error.message}. Enable file URL access for this extension.`);
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
  return "application/octet-stream";
}

function formatDownloadTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function clearCurrentWork() {
  clearLoadedLabelState();
  state.clearMode = "idle";
  clearTimeout(state.inactivityTimer);
  state.inactivityTimer = null;
  resetFileSelection();
  setStatus("Cleared. Drop the next label file.");
}

function resetFileSelection() {
  state.file = null;
  els.fileInput.value = "";
  els.extractButton.disabled = true;
  els.clearButton.disabled = true;
  els.fileName.textContent = "None";
}

async function handleDrop(event) {
  const transfer = event.dataTransfer;
  const downloadId = transfer?.getData("application/x-label-download-id");
  if (downloadId) {
    await useDownloadedId(Number(downloadId));
    return;
  }

  const file = firstDroppedFile(transfer);
  if (file) {
    setFile(file);
    return;
  }

  const url = firstDroppedUrl(transfer);
  if (url) {
    await tryDroppedUrl(url);
    return;
  }

  setStatus("Drop did not include a readable file. Use Recent downloads or Choose file.");
}

async function useDownloadedId(id) {
  const matches = await chrome.downloads.search({ id });
  if (!matches.length) {
    setStatus("Recent download was not found anymore.");
    return;
  }
  await useDownloadedFile(matches[0]);
}

function firstDroppedFile(transfer) {
  if (!transfer) return null;
  if (transfer.files?.length) return transfer.files[0];

  for (const item of Array.from(transfer.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function firstDroppedUrl(transfer) {
  if (!transfer) return "";
  const downloadUrl = transfer.getData("DownloadURL");
  if (downloadUrl) {
    const parts = downloadUrl.split(":");
    return parts.length >= 3 ? parts.slice(2).join(":") : downloadUrl;
  }

  const uriList = transfer.getData("text/uri-list");
  if (uriList) {
    return uriList.split(/\r?\n/).find((line) => line && !line.startsWith("#")) || "";
  }

  const plain = transfer.getData("text/plain");
  if (/^https?:\/\//i.test(plain) || /^blob:/i.test(plain)) return plain;

  const html = transfer.getData("text/html");
  const match = html.match(/\b(?:href|src)=["']([^"']+)["']/i);
  return match ? match[1] : "";
}

async function tryDroppedUrl(url) {
  if (url.startsWith("blob:")) {
    setStatus("That drag was a protected browser link. Download the label first, then drag the saved PDF/image here.");
    return;
  }

  setStatus("That drag was a link, not a saved PDF/image. Download the label first, then drag the saved file here.");
}

function isSupportedFile(file) {
  const name = file.name.toLowerCase();
  return LabelExtractorConfig.SUPPORTED_TYPES.includes(file.type)
    || [".pdf", ".png", ".jpg", ".jpeg", ".gif"].some((ext) => name.endsWith(ext));
}

async function normalizeFileForExtraction(file) {
  if (!isGifFile(file)) return file;

  setProgressMessage("Converting GIF label - please wait", "Turning the GIF into a PNG so the label reader can extract it.");
  setLoadingProgress(20);
  const imageUrl = URL.createObjectURL(file);
  let image;
  try {
    image = await loadImage(imageUrl);
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("GIF label could not be converted to PNG.")), "image/png");
  });
  return new File([pngBlob], replaceExtension(file.name, ".png"), { type: "image/png" });
}

function isGifFile(file) {
  return file?.type === "image/gif" || /\.gif$/i.test(file?.name || "");
}

function replaceExtension(name, ext) {
  const base = String(name || "label").replace(/\.[^.]*$/, "");
  return `${base}${ext}`;
}

async function extractSelectedFile() {
  if (!state.file) return;
  if (state.extractionInProgress) {
    setStatus("Extraction already running - please wait.");
    return;
  }

  const runId = ++state.extractionRunId;
  state.extractionInProgress = true;
  els.progress.hidden = false;
  setProgressMessage("Extracting label - please wait", "Do not print, clear, or load another label until this finishes.");
  setLoadingProgress(12);
  els.extractButton.disabled = true;
  els.results.replaceChildren();
    setStatus("Extracting label - please wait...", "loading");

  try {
    const normalizedFile = await normalizeFileForExtraction(state.file);
    if (runId !== state.extractionRunId) return;
    setLoadingProgress(30);

    const result = await tryLocalDetectorCandidate(normalizedFile);
    if (runId !== state.extractionRunId) return;
    setLoadingProgress(85);

    const localLabels = normalizeLocalResults(result);
    let candidates = await fullLabelCandidates(localLabels);
    if (!candidates.length && hasCachedCanvasPages()) {
      candidates = await fileFallbackCandidates(localLabels);
    }
    if (runId !== state.extractionRunId) return;

    setLoadingProgress(100);
    state.lastExtractionSummary = {
      fileName: normalizedFile.name,
      fileType: normalizedFile.type,
      rawLocalCount: localLabels.length,
      finalCandidateCount: candidates.length,
      usedFallback: candidates.some((label) => String(label.localReason || "").includes("fallback")),
      pageCount: state.cachedPages?.length || 0
    };
    state.results = candidates;
    state.selectedLabelIndex = candidates.length ? 0 : -1;
    renderResults({ labels: state.results });
    updateSheetPreview();
    setStatus(candidates.length ? "Ready to print." : "No label candidates found - try another file or crop manually.");
    if (candidates.length) resetInactivityTimer();
  } catch (error) {
    if (runId !== state.extractionRunId) return;
    const message = error.message || "Unknown error";
    setStatus(`Extraction failed: ${message}`);
    showBanner(`Extraction failed: ${message}`, "error", 8000);
  } finally {
    if (runId === state.extractionRunId) {
      state.extractionInProgress = false;
      els.progress.hidden = true;
      setLoadingProgress(0);
      els.extractButton.disabled = !state.file;
    }
  }
}

function setProgressMessage(title, note) {
  if (els.progressText) els.progressText.textContent = title;
  if (els.progressNote) els.progressNote.textContent = note || "";
}

function setLoadingProgress(percent) {
  if (!els.loadingBarFill) return;
  els.loadingBarFill.style.width = `${clamp(Number(percent) || 0, 0, 100)}%`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryLocalDetectorCandidate(file) {
  if (!file || !window.LabelExtractorPDF || !window.LabelExtractorPNG) return null;

  try {
    const result = await runLocalDetector(file);
    const results = Array.isArray(result) ? result : [result];
    const labels = results
      .map(localDetectionToLabel)
      .filter(Boolean);
    return labels.length ? labels : null;
  } catch (error) {
    console.warn("[Label Extractor] Local detection failed.", error);
    return null;
  }
}

function localDetectionToLabel(result) {
  if (!result?.label || !LOCAL_DETECTOR_REASONS.has(result.reason)) return null;
  const likelyPartial = isLikelyPartialLocalDetection(result);
  if (likelyPartial && !canShowAsCropVariant(result)) return null;

  const dataUrl = result.label.dataUrl;
  const base64 = dataUrl.split(",")[1];
  if (!base64) return null;

  return {
    carrier: result.carrier || "Model",
    confidence: Math.min(0.99, Number(result.confidence || 0)),
    outputMimeType: "image/png",
    base64,
    width: result.label.width,
    height: result.label.height,
    variantName: result.variantName || localVariantName(result),
    warnings: labelWarnings(result, likelyPartial),
    sourcePage: Number(result.pageIndex || 0) + 1,
    pageCount: Number(result.pageCount || 0),
    localReason: result.reason,
    localCropRect: result.cropRect || null,
    needsCrop: likelyPartial || Boolean(result.needsCrop)
  };
}

function canShowAsCropVariant(result) {
  return result.reason === "keywords"
    || result.reason === "barcode-density"
    || result.reason === "text-label-page"
    || result.reason === "embedded-label-page"
    || result.reason === "image-label-fallback"
    || result.reason === "manual-image-fallback"
    || result.reason === "lower-barcode-label"
    || result.reason === "fashion-nova-lower-barcode";
}

function labelWarnings(result, likelyPartial) {
  const warnings = Array.isArray(result.warnings) ? result.warnings.slice() : [];
  if (likelyPartial && !warnings.some((warning) => /crop|partial/i.test(warning))) {
    warnings.push("Crop-needed variant; review and crop before printing.");
  }
  return warnings;
}

function isLikelyPartialLocalDetection(result) {
  const width = Number(result.label?.width || 0);
  const height = Number(result.label?.height || 0);
  if (!width || !height) return true;

  const aspect = width / height;
  if (aspect < 0.45 || aspect > 2.6) return true;

  const rect = result.cropRect;
  const sourceWidth = Number(result.sourceWidth || 0);
  const sourceHeight = Number(result.sourceHeight || 0);
  if (!rect || !sourceWidth || !sourceHeight) return false;

  const areaRatio = (rect.width * rect.height) / Math.max(1, sourceWidth * sourceHeight);
  const touchesEdge = rect.x <= 2 || rect.y <= 2 ||
    rect.x + rect.width >= sourceWidth - 2 ||
    rect.y + rect.height >= sourceHeight - 2;
  return areaRatio < 0.12 || (touchesEdge && areaRatio < 0.22);
}

function localVariantName(result) {
  const page = Number(result.pageIndex || 0) + 1;
  if (result.reason === "solid-border") return `Local label page ${page}`;
  if (result.reason === "keywords") return `Carrier text label page ${page}`;
  if (result.reason === "text-label-page") return `Text label page ${page}`;
  if (result.reason === "barcode-density") return `Barcode label page ${page}`;
  if (result.reason === "embedded-label-page") return `Embedded label page ${page}`;
  if (result.reason === "image-label-fallback") return `Image label fallback page ${page}`;
  if (result.reason === "manual-image-fallback") return `Manual image crop page ${page}`;
  return `Model full label page ${page}`;
}

function normalizeLocalResults(result) {
  if (!result) return [];
  return Array.isArray(result) ? result.filter(Boolean) : [result].filter(Boolean);
}

async function runLocalDetector(file) {
  const cacheKey = fileCacheKey(file);
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const processed = await window.LabelExtractorPDF.process({
      buffer: await file.arrayBuffer(),
      type: "application/pdf",
      name: file.name
    });
    if (Array.isArray(processed)) return processed;
    if (processed?.pages && window.LabelExtractorDetector.detectPdfCandidates) {
      state.cachedPages = processed.pages;
      state.cachedPagesKey = cacheKey;
      const candidates = await window.LabelExtractorDetector.detectPdfCandidates(processed.pages);
      return candidates.length ? candidates : processed;
    }
    return processed;
  }

  if (file.type.startsWith("image/") || /\.(png|jpe?g|hei[cf])$/i.test(file.name)) {
    const page = await window.LabelExtractorPNG.process({
      blob: file,
      type: file.type,
      name: file.name
    }, 0);
    state.cachedPages = [page];
    state.cachedPagesKey = cacheKey;
    if (window.LabelExtractorDetector.detectAllPngCandidates) {
      const candidates = await window.LabelExtractorDetector.detectAllPngCandidates([page]);
      return candidates.length ? candidates : window.LabelExtractorDetector.detectPngPages([page]);
    }
    return window.LabelExtractorDetector.detectPngPages([page]);
  }

  return null;
}

async function fullLabelCandidates(labels) {
  const sorted = labels
    .sort(compareLabelQuality);
  const clean = sorted.filter((label) => {
    const confidence = Number(label.confidence || 0);
    return confidence >= MIN_FULL_LABEL_CONFIDENCE
      && !isFallbackOrPartialCrop(label)
      && !label.needsCrop;
  });
  const cropNeeded = sorted.filter((label) => {
    const confidence = Number(label.confidence || 0);
    return confidence >= MIN_CROP_VARIANT_CONFIDENCE
      && (label.needsCrop || isFallbackOrPartialCrop(label) || hasCropWarning(label));
  });
  const limit = getVariantLimit(labels);
  const merged = dedupeLabels([...clean, ...cropNeeded]);
  return merged.slice(0, limit);
}

function dedupeLabels(labels) {
  const seen = new Set();
  return labels.filter((label) => {
    const key = [
      label.variantName || "",
      label.sourcePage || "",
      label.width || "",
      label.height || "",
      label.localReason || ""
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasCropWarning(label) {
  return (label.warnings || []).some((warning) => /crop|partial|review/i.test(String(warning)));
}

async function fileFallbackCandidates(labels) {
  const fallbackFromLabels = labels
    .filter((label) => Number(label.confidence || 0) >= FALLBACK_MIN_CONFIDENCE)
    .sort(compareLabelQuality)
    .map((label) => ({
      ...label,
      needsCrop: true,
      warnings: ensureWarning(label.warnings, FALLBACK_WARNING)
    }));

  const fallbackFromPages = await cachedFilePageFallbackLabels();
  const limit = getVariantLimit([...labels, ...fallbackFromPages]);
  return dedupeLabels([...fallbackFromLabels, ...fallbackFromPages]).slice(0, Math.max(4, limit));
}

async function cachedFilePageFallbackLabels() {
  if (!state.cachedPages?.length) return [];

  const pages = state.cachedPages
    .filter((page) => page?.canvas)
    .slice()
    .sort(compareFallbackPages)
    .slice(0, FALLBACK_PAGE_LIMIT);

  return pages.map(fileFallbackLabelFromPage).filter((label) => label.base64);
}

function fileFallbackLabelFromPage(page) {
  const fallback = zoomedFallbackCanvas(page.canvas);
  const dataUrl = fallback.canvas.toDataURL("image/png");
  const pageNumber = Number(page.pageIndex || 0) + 1;
  return {
    carrier: fileFallbackCarrier(page),
    confidence: 0.32,
    outputMimeType: "image/png",
    base64: dataUrl.split(",")[1],
    width: fallback.canvas.width,
    height: fallback.canvas.height,
    variantName: `${fileFallbackPageTitle(page, pageNumber)} crop option`,
    warnings: [FALLBACK_WARNING],
    sourcePage: pageNumber,
    pageCount: Number(page.pageCount || state.cachedPages.length),
    localReason: "file-page-fallback",
    localCropRect: fallback.rect,
    pageText: page.text || "",
    needsCrop: true
  };
}

function fileFallbackCarrier(page) {
  return page?.type === "pdf" ? "PDF" : "File";
}

function fileFallbackPageTitle(page, pageNumber) {
  if (page?.type === "pdf" && page.embeddedImageCount) {
    return `Embedded PDF page ${pageNumber}`;
  }
  return `${String(page?.type || "file").toUpperCase()} page ${pageNumber}`;
}

function zoomedFallbackCanvas(sourceCanvas) {
  const contentRect = findDarkContentRect(sourceCanvas);
  const rect = contentRect
    ? expandContentRect(contentRect, sourceCanvas, FALLBACK_CONTENT_PADDING_RATIO)
    : centeredZoomRect(sourceCanvas, FALLBACK_CENTER_SCALE);
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return { canvas, rect };
}

function findDarkContentRect(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const step = Math.max(2, Math.floor(Math.min(width, height) / 900));
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 24) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum > 225) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: Math.min(width - left, right - left + step),
    height: Math.min(height - top, bottom - top + step)
  };
}

function expandContentRect(rect, canvas, paddingRatio) {
  const padX = Math.max(24, Math.round(rect.width * paddingRatio));
  const padY = Math.max(24, Math.round(rect.height * paddingRatio));
  const x = Math.max(0, rect.x - padX);
  const y = Math.max(0, rect.y - padY);
  const right = Math.min(canvas.width, rect.x + rect.width + padX);
  const bottom = Math.min(canvas.height, rect.y + rect.height + padY);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

function centeredZoomRect(canvas, scale) {
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  return {
    x: Math.max(0, Math.round((canvas.width - width) / 2)),
    y: Math.max(0, Math.round((canvas.height - height) / 2)),
    width,
    height
  };
}

function compareFallbackPages(a, b) {
  return fallbackPageScore(b) - fallbackPageScore(a);
}

function fallbackPageScore(page) {
  const text = String(page?.text || "").toUpperCase();
  let score = Number(page?.embeddedImageCount || 0) * 3;
  if (/RETURN MAILING LABEL|RETURN AUTHORIZATION SLIP|PLACE THIS BARCODE/.test(text)) score += 5;
  if (/UPS|USPS|FEDEX|TRACKING|SHIP TO|SHIP FROM/.test(text)) score += 3;
  if (/INSTRUCTIONS|REFUND|EXCHANGE|ELIGIBLE/.test(text)) score -= 1;
  return score;
}

function ensureWarning(warnings, message) {
  const next = Array.isArray(warnings) ? warnings.slice() : [];
  if (!next.includes(message)) next.push(message);
  return next;
}

function hasCachedCanvasPages() {
  return state.cachedPages?.some((page) => page?.canvas);
}

function getVariantLimit(labels = []) {
  const pageCount = labels.reduce((max, label) => Math.max(max, Number(label?.pageCount || 0)), 0);
  if (pageCount >= 3) return 6;
  if (pageCount > 0) return 4;

  const name = String(state.file?.name || "").toLowerCase();
  const type = String(state.file?.type || "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return 4;
  return 2;
}

function isFallbackOrPartialCrop(label) {
  const name = String(label.variantName || "").toLowerCase();
  const warnings = (label.warnings || []).join(" ").toLowerCase();

  return warnings.includes("fallback crop")
    || name.includes("lower half")
    || name.includes("lower-left label")
    || name.includes("center label")
    || name.includes("full page")
    || name.includes("barcode only")
    || name.includes("barcode-only");
}

function compareLabelQuality(a, b) {
  const confidenceDelta = Number(b.confidence || 0) - Number(a.confidence || 0);
  if (Math.abs(confidenceDelta) > 0.03) return confidenceDelta;
  return localLabelScore(b) - localLabelScore(a);
}

function localLabelScore(label) {
  const reason = String(label.localReason || "");
  const carrier = String(label.carrier || "").toUpperCase();
  const text = String(label.pageText || "").toUpperCase();
  const isUps = carrier === "UPS" || /\bUPS\b|UPS TRACKING|UPS GROUND|UPS 2ND DAY AIR|UPS NEXT DAY AIR|\b1Z[0-9A-Z]{16}\b/.test(text);
  if (isUps && reason === "keywords") return 7;
  if (isUps && reason === "text-label-page") return 6;
  if (isUps && reason === "dashed-border") return 1;
  if (reason === "keywords") return 5;
  if (reason === "solid-border") return 4;
  if (reason === "trained-model") return 3;
  if (reason === "text-label-page") return 3;
  if (reason === "embedded-label-page") return 2;
  if (reason === "image-label-fallback") return 2;
  if (reason === "manual-image-fallback") return -1;
  if (reason === "lower-barcode-label" || reason === "barcode-density") return 1;
  return 0;
}

function renderResults(payload) {
  els.results.replaceChildren();

  if (!payload.labels?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = payload.warnings?.join(" ") || "No label candidate was returned.";
    els.results.append(empty);
    els.printSettings.classList.add("inactive");
    return;
  }

  els.printSettings.classList.remove("inactive");

  payload.labels.forEach((label, index) => {
    const card = document.createElement("article");
    card.className = "label-card";

    const title = document.createElement("div");
    title.className = "card-title";
    const actionState = getLabelActionState(label);
    title.innerHTML = `<strong>${escapeHtml(resultDisplayName(label, index))}</strong><span class="${actionState.className}">${actionState.label}</span>`;

    const dataUrl = `data:${label.outputMimeType || "image/png"};base64,${label.base64}`;
    const preview = document.createElement(label.outputMimeType === "application/pdf" ? "iframe" : "img");
    preview.className = "preview";
    preview.src = dataUrl;
    preview.title = `Extracted label ${index + 1}`;

    const warnings = document.createElement("ul");
    warnings.className = "warnings";
    (label.warnings || []).forEach((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      warnings.append(item);
    });

    const debugMeta = document.createElement("dl");
    debugMeta.className = "label-debug-meta";
    appendDebugMeta(debugMeta, "Variant", label.variantName || "Crop option");
    appendDebugMeta(debugMeta, "Reason", label.localReason || "unknown");
    appendDebugMeta(debugMeta, "Confidence", Number(label.confidence || 0).toFixed(2));
    appendDebugMeta(debugMeta, "Page", label.pageCount ? `${label.sourcePage || 1}/${label.pageCount}` : String(label.sourcePage || 1));
    appendDebugMeta(debugMeta, "Size", `${label.width || 0}x${label.height || 0}`);

    const actions = document.createElement("div");
    actions.className = "actions";
    const actionHints = getLabelActionHints(label);
    const rotateButton = makeRotateButton(index, actionHints);
    const cropButton = makeCropButton(index, actionHints);
    const expandButton = makeExpandButton(index, label);
    const printButton = makePrintButton(index, actionHints);
    actions.append(rotateButton, cropButton, printButton, expandButton);

    if (preview.tagName === "IMG") {
      preview.addEventListener("load", () => {
        const imageHints = getLabelActionHints({
          ...label,
          width: preview.naturalWidth,
          height: preview.naturalHeight
        });
        decorateActionButton(rotateButton, "rotate", imageHints.rotate);
        decorateActionButton(cropButton, "crop", imageHints.crop);
        decorateActionButton(printButton, "print", imageHints.printReady);
      }, { once: true });
    }

    card.append(title, actions, preview, warnings, debugMeta);
    if (index === state.selectedLabelIndex) card.classList.add("selected");
    els.results.append(card);
  });
}

function resultDisplayName(label, index) {
  if (state.uiMode === "lab") return label.variantName || `Candidate ${index + 1}`;
  const hints = getLabelActionHints(label);
  if (hints.printReady) return "Label ready";
  if (hints.rotate) return "Rotate label";
  if (hints.crop) return "Crop label";
  return "Review label";
}

function appendDebugMeta(list, term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = String(value);
  list.append(dt, dd);
}

function getLabelActionHints(label) {
  const confidence = Number(label.confidence || 0);
  const warnings = (label.warnings || []).join(" ").toLowerCase();
  const variantName = String(label.variantName || "").toLowerCase();
  const width = Number(label.width || 0);
  const height = Number(label.height || 0);
  const looksLandscape = width > 0 && height > 0 && width > height * 1.08;
  const clearCropSignal = warnings.includes("partial")
    || warnings.includes("fallback")
    || warnings.includes("missing")
    || warnings.includes("cut off")
    || warnings.includes("cropped")
    || warnings.includes("crop failed")
    || variantName.includes("full page")
    || variantName.includes("lower")
    || variantName.includes("center");
  const likelyNeedsCrop = clearCropSignal || confidence < 0.62;

  return {
    printReady: confidence >= 0.86 && !looksLandscape && !clearCropSignal,
    rotate: looksLandscape || warnings.includes("rotate") || warnings.includes("orientation"),
    crop: likelyNeedsCrop
  };
}

function getLabelActionState(label) {
  const hints = getLabelActionHints(label);
  if (hints.rotate) return { label: "Rotate first", className: "conf-rotate" };
  if (hints.crop) return { label: "Needs crop", className: "conf-crop" };
  if (hints.printReady) return { label: "Ready", className: "conf-high" };
  return { label: "Review", className: "conf-mid" };
}

function decorateActionButton(button, action, shouldGlow) {
  button.className = `label-action label-action-${action}${shouldGlow ? " label-action-glow" : ""}`;
  button.dataset.action = action;
}

function makeRotateButton(index, actionHints) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Rotate";
  decorateActionButton(button, "rotate", actionHints.rotate);
  button.addEventListener("click", async () => {
    state.results[index] = await rotateLabel(state.results[index]);
    state.selectedLabelIndex = index;
    renderResults({ labels: state.results });
    updateSheetPreview();
  });
  return button;
}

function makeCropButton(index, actionHints) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Crop";
  decorateActionButton(button, "crop", actionHints.crop);
  button.addEventListener("click", () => openCropEditor(index));
  return button;
}

function makePrintButton(index, actionHints) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Print";
  decorateActionButton(button, "print", actionHints.printReady);
  button.addEventListener("click", async () => {
    state.selectedLabelIndex = index;
    updateSheetPreview();
    const rawUrl = labelToDataUrl(state.results[index]);
    const scaledUrl = await resizeToLabelDpi(rawUrl, 203);
    const printUrl = await prepareForPrint(scaledUrl);
    printDataUrl(printUrl);
    resetInactivityTimer("printed");
    markActiveDownloadPrinted();
    els.clearButton.classList.add("needs-clear");
    els.clearReminder.hidden = false;
    state.labelsPrintedCount++;
    if (state.labelsPrintedCount % MEMORY_CLEANUP_EVERY === 0) {
      backgroundMemoryCleanup().catch(() => {});
    }
  });
  return button;
}

function makeExpandButton(index, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Expand";
  button.className = "label-action label-action-expand";
  button.dataset.action = "expand";
  const isManual = /manual/i.test(label.variantName || "");
  button.disabled = isManual;
  button.title = isManual
    ? "Not available for manually adjusted labels"
    : "Last resort: show the full source page only if Crop cannot reach the label.";
  button.addEventListener("click", () => expandToSourcePage(index));
  return button;
}

async function expandToSourcePage(index) {
  const label = state.results[index];
  if (!label || !state.file || state.extractionInProgress) return;

  setStatus("Loading full source page — please wait...");
  els.extractButton.disabled = true;

  try {
    const currentCacheKey = fileCacheKey(state.file);
    const targetPageIndex = Math.max(0, (label.sourcePage || 1) - 1);
    let sourceCanvas = null;

    if (state.cachedPages?.length && state.cachedPagesKey === currentCacheKey) {
      const page = state.cachedPages.find((p) => p.pageIndex === targetPageIndex) || state.cachedPages[0];
      sourceCanvas = page?.canvas || null;
    }

    if (!sourceCanvas) {
      const normalizedFile = await normalizeFileForExtraction(state.file);
      if (normalizedFile.type === "application/pdf" || normalizedFile.name.toLowerCase().endsWith(".pdf")) {
        const processed = await window.LabelExtractorPDF.process({
          buffer: await normalizedFile.arrayBuffer(),
          type: "application/pdf",
          name: normalizedFile.name
        });
        const pages = processed?.pages || [];
        state.cachedPages = pages;
        state.cachedPagesKey = fileCacheKey(normalizedFile);
        const page = pages.find((p) => p.pageIndex === targetPageIndex) || pages[0];
        sourceCanvas = page?.canvas || null;
      } else {
        const page = await window.LabelExtractorPNG.process({
          blob: normalizedFile,
          type: normalizedFile.type,
          name: normalizedFile.name
        }, 0);
        state.cachedPages = [page];
        state.cachedPagesKey = fileCacheKey(normalizedFile);
        sourceCanvas = page?.canvas || null;
      }
    }

    if (!sourceCanvas) {
      setStatus("Could not load source page. Try using Crop instead.");
      return;
    }

    const dataUrl = sourceCanvas.toDataURL("image/png");
    const fullPageLabel = {
      ...label,
      base64: dataUrl.split(",")[1],
      outputMimeType: "image/png",
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      variantName: `Full page ${targetPageIndex + 1} — crop to label`,
      confidence: 0.5,
      warnings: ["Full source page shown — drag the crop handles to the label area then click Apply crop."],
      localReason: null
    };

    state.results.unshift(fullPageLabel);
    state.selectedLabelIndex = 0;
    renderResults({ labels: state.results });
    updateSheetPreview();
    openCropEditor(0);
    setStatus("Full page loaded — drag the crop box to the label then click Apply crop.");
  } catch (error) {
    setStatus(`Expand failed: ${error.message}`);
  } finally {
    els.extractButton.disabled = !state.file;
  }
}

function fileCacheKey(file) {
  if (!file) return "";
  return [
    file.name || "",
    file.size || 0,
    file.lastModified || 0,
    file.type || ""
  ].join(":");
}

function scheduleModelWarmup(delayMs = 2500) {
  if (state.modelWarmupStarted || !window.LabelExtractorModelDetector?.warmUp) return;
  state.modelWarmupStarted = true;
  setTimeout(() => {
    window.LabelExtractorModelDetector.warmUp().catch(() => {});
  }, delayMs);
}

function markActiveDownloadPrinted() {
  if (state.activeDownloadId) {
    state.suppressedDownloadIds.add(state.activeDownloadId);
    renderDownloadsMessage("Printed label hidden. Waiting for the next label download.");
    state.activeDownloadId = null;
  }
}

function applyUnsharpMask(lums, width, height, radius, amount) {
  const kernelSize = radius * 2 + 1;
  const invK = 1 / kernelSize;
  const temp = new Float32Array(lums.length);
  const blurred = new Float32Array(lums.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        sum += lums[row + Math.max(0, Math.min(width - 1, x + dx))];
      }
      temp[row + x] = sum * invK;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        sum += temp[Math.max(0, Math.min(height - 1, y + dy)) * width + x];
      }
      blurred[y * width + x] = sum * invK;
    }
  }

  for (let i = 0; i < lums.length; i++) {
    lums[i] = Math.max(0, Math.min(255, Math.round(lums[i] + amount * (lums[i] - blurred[i]))));
  }
}

function otsuThreshold(lums) {
  const hist = new Int32Array(256);
  for (let i = 0; i < lums.length; i++) hist[lums[i]]++;
  const total = lums.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; threshold = t; }
  }
  return threshold;
}

async function resizeToLabelDpi(dataUrl, dpi = 203) {
  const targetW = Math.round(4 * dpi);
  const targetH = Math.round(6 * dpi);
  const image = await loadImage(dataUrl);
  if (image.naturalWidth === targetW && image.naturalHeight === targetH) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(image, 0, 0, targetW, targetH);
  return canvas.toDataURL("image/png");
}

async function prepareForPrint(dataUrl) {
  const image = await loadImage(dataUrl);

  const probe = document.createElement("canvas");
  probe.width = Math.min(200, image.naturalWidth);
  probe.height = Math.min(200, image.naturalHeight);
  const pCtx = probe.getContext("2d", { willReadFrequently: true });
  pCtx.drawImage(image, 0, 0, probe.width, probe.height);
  const sample = pCtx.getImageData(0, 0, probe.width, probe.height).data;
  let colored = 0;
  for (let i = 0; i < sample.length; i += 16) {
    if (Math.max(sample[i], sample[i + 1], sample[i + 2]) - Math.min(sample[i], sample[i + 1], sample[i + 2]) > 28) colored++;
  }
  const isColorLabel = colored / (sample.length / 16) > 0.12;
  if (isColorLabel) return dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  const pixelCount = d.length / 4;
  const lums = new Uint8Array(pixelCount);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    lums[j] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  applyUnsharpMask(lums, canvas.width, canvas.height, 1, 1.5);
  const threshold = otsuThreshold(lums);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const val = lums[j] < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = val;
    d[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return canvas.toDataURL("image/png");
}

function printDataUrl(dataUrl) {
  const bounds = getPrintPopupBounds();
  const printWindow = window.open("", "_blank", [
    `width=${bounds.width}`,
    `height=${bounds.height}`,
    `left=${bounds.left}`,
    `top=${bounds.top}`,
    `screenX=${bounds.left}`,
    `screenY=${bounds.top}`
  ].join(","));
  if (printWindow) {
    positionPrintWindow(printWindow, bounds);
    printWindow.document.open();
    printWindow.document.write(makePrintHtml(dataUrl, true, bounds));
    printWindow.document.close();
    triggerPrintDialog(printWindow, bounds);
    return;
  }

  const frame = document.createElement("iframe");
  frame.className = "print-frame";
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(makePrintHtml(dataUrl, false, bounds));
  doc.close();

  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 30000);
  }, 300);
}

function triggerPrintDialog(win, bounds) {
  let printed = false;
  const printOnce = () => {
    if (printed || win.closed) return;
    printed = true;
    positionPrintWindow(win, bounds);
    try {
      win.focus();
      win.print();
    } catch (_) {}
  };

  try {
    win.addEventListener("load", () => setTimeout(printOnce, 150), { once: true });
  } catch (_) {}

  setTimeout(printOnce, 450);
  setTimeout(printOnce, 1200);
}

function getPrintPopupBounds() {
  const screenLeft = Number(window.screen.availLeft || 0);
  const screenTop = Number(window.screen.availTop || 0);
  const screenWidth = Number(window.screen.availWidth || window.screen.width || 1280);
  const screenHeight = Number(window.screen.availHeight || window.screen.height || 900);
  const width = Math.max(900, Math.min(1180, screenWidth - 40));
  const height = Math.max(760, Math.min(980, screenHeight - 40));
  return {
    width,
    height,
    left: Math.max(screenLeft, Math.round(screenLeft + (screenWidth - width) / 2)),
    top: Math.max(screenTop, Math.round(screenTop + (screenHeight - height) / 2))
  };
}

function positionPrintWindow(win, bounds) {
  try {
    win.moveTo(bounds.left, bounds.top);
    win.resizeTo(bounds.width, bounds.height);
    win.focus();
  } catch (_) {}
}

function makePrintHtml(dataUrl, closeAfterPrint, bounds) {
  const escaped = escapeHtml(dataUrl);
  const width = clamp(Number(state.printWidth || 4), 2.5, 8.5);
  const left = clamp(Number(state.printLeft || 0), 0, 7.5);
  const top = clamp(Number(state.printTop || 0), 0, 10);
  const isLabelMode = state.printMode === "label";
  if (isLabelMode) return makeLabelPrintHtml(escaped, closeAfterPrint, bounds);
  const maxWidth = Math.max(0.5, 8.5 - left);
  const maxHeight = Math.max(0.5, 11 - top);
  const labelWidth = Math.min(width, maxWidth);
  const labelHeight = Math.min(labelWidth * 1.5, maxHeight);
  const viewportWidth = bounds?.width || 980;
  const scale = Math.max(0.72, Math.min(1, (viewportWidth - 80) / 816));
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Print Label</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: 8.5in 11in; margin: 0; }
    html { margin: 0; padding: 0; min-height: 100%; background: #e8eaed; }
    body {
      margin: 0 auto; padding: 0; width: 8.5in; height: 11in;
      background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      position: relative; overflow: hidden;
      transform: scale(${scale}); transform-origin: top center;
    }
    .label {
      position: absolute; left: ${left}in; top: ${top}in;
      width: ${labelWidth}in; height: ${labelHeight}in;
      overflow: hidden; background: #fff;
    }
    img {
      width: 100%; height: 100%; display: block;
      image-rendering: pixelated;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    }
    @media print {
      html { background: #fff; }
      body { margin: 0; box-shadow: none; transform: none; width: 8.5in; height: 11in; }
    }
  </style>
</head>
<body>
  <div class="label"><img id="label" src="${escaped}" alt="Shipping label"></div>
  <script>
    const closeAfterPrint = ${closeAfterPrint ? "true" : "false"};
    function doPrint() { setTimeout(function () { window.focus(); window.print(); }, 300); }
    const image = document.getElementById("label");
    if (image.complete) doPrint();
    else image.addEventListener("load", doPrint, { once: true });
    ${closeAfterPrint ? 'window.addEventListener("afterprint", function () { setTimeout(function () { window.close(); }, 250); }, { once: true });' : ''}
  </script>
</body>
</html>`;
}

function makeLabelPrintHtml(escapedDataUrl, closeAfterPrint, bounds) {
  const viewportWidth = bounds?.width || 980;
  const scale = Math.max(0.85, Math.min(1.3, (viewportWidth - 120) / 384));
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Print 4x6 Label</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: 4in 6in; margin: 0; }
    html { margin: 0; padding: 0; min-height: 100%; background: #e8eaed; }
    body {
      margin: 0 auto; padding: 0; width: 4in; height: 6in;
      background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      overflow: hidden; transform: scale(${scale}); transform-origin: top center;
    }
    img {
      width: 4in; height: 6in; display: block; object-fit: fill;
      image-rendering: pixelated;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    }
    @media print {
      html { background: #fff; }
      body { margin: 0; box-shadow: none; transform: none; width: 4in; height: 6in; }
    }
  </style>
</head>
<body>
  <img id="label" src="${escapedDataUrl}" alt="Shipping label">
  <script>
    function doPrint() { setTimeout(function () { window.focus(); window.print(); }, 300); }
    const image = document.getElementById("label");
    if (image.complete) doPrint();
    else image.addEventListener("load", doPrint, { once: true });
    ${closeAfterPrint ? 'window.addEventListener("afterprint", function () { setTimeout(function () { window.close(); }, 250); }, { once: true });' : ''}
  </script>
</body>
</html>`;
}

function updatePrintSetting(key, value) {
  state[key] = Number(value);
  syncPrintControls();
  chrome.storage.local.set({
    letterLabelPrintWidth: state.printWidth,
    letterLabelPrintLeft: state.printLeft,
    letterLabelPrintTop: state.printTop,
    labelExtractorPrintMode: state.printMode
  }).catch(() => {});
}

function setPrintMode(mode) {
  state.printMode = mode === "label" ? "label" : "letter";
  if (state.printMode === "label") {
    state.printWidth = 4;
    state.printLeft = 0;
    state.printTop = 0;
  }
  syncPrintControls();
  chrome.storage.local.set({
    labelExtractorPrintMode: state.printMode,
    letterLabelPrintWidth: state.printWidth,
    letterLabelPrintLeft: state.printLeft,
    letterLabelPrintTop: state.printTop
  }).catch(() => {});
}

function syncPrintControls() {
  els.printSettings.classList.add("label-mode");
  updateSheetPreview();
}

function updateSheetPreview() {
  const label = state.results[state.selectedLabelIndex];
  if (!label) {
    els.sheetPreviewLabel.removeAttribute("src");
    return;
  }
  els.sheetPreviewLabel.src = labelToDataUrl(label);
  const sheet = els.sheetPreviewLabel.parentElement;
  const labelMode = state.printMode === "label";
  sheet.classList.toggle("label-sheet", labelMode);
  if (labelMode) {
    els.sheetPreviewLabel.style.left = "0";
    els.sheetPreviewLabel.style.top = "0";
    els.sheetPreviewLabel.style.width = "100%";
    els.sheetPreviewLabel.style.height = "100%";
  } else {
    els.sheetPreviewLabel.style.left = `${(state.printLeft / 8.5) * 100}%`;
    els.sheetPreviewLabel.style.top = `${(state.printTop / 11) * 100}%`;
    els.sheetPreviewLabel.style.width = `${(state.printWidth / 8.5) * 100}%`;
    els.sheetPreviewLabel.style.height = "auto";
  }
}

function labelToDataUrl(label) {
  return `data:${label.outputMimeType || "image/png"};base64,${label.base64}`;
}

async function rotateLabel(label) {
  const image = await loadImage(labelToDataUrl(label));
  const canvas = document.createElement("canvas");
  canvas.width = image.height;
  canvas.height = image.width;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(image, -image.width / 2, -image.height / 2);
  return labelFromCanvas(canvas, label, "Manual rotate");
}

function openCropEditor(index) {
  state.cropTargetIndex = index;
  resetCropBox();
  els.cropImage.src = labelToDataUrl(state.results[index]);
  els.cropEditor.hidden = false;

  if (usesTallCropSource(state.results[index])) {
    els.cropImage.addEventListener("load", () => {
      const containerWidth = els.cropStage.clientWidth || 400;
      const naturalAspect = (els.cropImage.naturalWidth || 1) / Math.max(1, els.cropImage.naturalHeight || 1);
      const idealHeight = Math.round(containerWidth / naturalAspect);
      const maxHeight = Math.round(window.innerHeight * 0.92);
      els.cropStage.style.height = `${Math.min(idealHeight, maxHeight)}px`;
      positionCropLayerToImage();
    }, { once: true });
  } else {
    els.cropStage.style.height = "";
    els.cropImage.addEventListener("load", positionCropLayerToImage, { once: true });
  }

  setTimeout(positionCropLayerToImage, 50);
  requestAnimationFrame(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
}

function closeCropEditor() {
  els.cropEditor.hidden = true;
  state.cropTargetIndex = -1;
  els.cropStage.style.height = "";
}

function resetCropBox() {
  const label = state.results[state.cropTargetIndex];

  state.cropRect = usesTallCropSource(label)
    ? initialFallbackCropRect(label)
    : { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
  renderCropBox();
}

function initialFallbackCropRect(label) {
  const imgW = Number(label?.width || 0);
  const imgH = Number(label?.height || 0);
  if (imgW <= 0 || imgH <= 0) {
    return { x: 0.18, y: 0.08, width: 0.64, height: 0.84 };
  }

  const imageAspect = imgW / imgH;
  let width = FALLBACK_CROP_INITIAL_WIDTH;
  let height = width * imageAspect / LABEL_ASPECT_4X6;
  if (height > FALLBACK_CROP_MAX_SIZE) {
    height = FALLBACK_CROP_MAX_SIZE;
    width = height * LABEL_ASPECT_4X6 / imageAspect;
  }
  if (width > FALLBACK_CROP_MAX_SIZE) {
    width = FALLBACK_CROP_MAX_SIZE;
    height = width * imageAspect / LABEL_ASPECT_4X6;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

function usesTallCropSource(label) {
  const name = String(label?.variantName || "").toLowerCase();
  const reason = String(label?.localReason || "").toLowerCase();
  const warnings = (label?.warnings || []).join(" ").toLowerCase();
  return name.includes("full page")
    || reason.includes("fallback")
    || warnings.includes("fallback");
}

async function autoOrientLabel(label) {
  const img = await loadImage(labelToDataUrl(label));
  if (img.naturalWidth <= img.naturalHeight) return [label, false];
  return [await rotateLabel(label), true];
}

async function applyManualCrop() {
  try {
    const index = state.cropTargetIndex;
    const label = state.results[index];
    if (!label) {
      setStatus("Crop failed: no crop target selected.");
      return;
    }

    const image = await loadImage(labelToDataUrl(label));
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const sx = Math.round(state.cropRect.x * sourceWidth);
    const sy = Math.round(state.cropRect.y * sourceHeight);
    const sw = Math.max(1, Math.round(state.cropRect.width * sourceWidth));
    const sh = Math.max(1, Math.round(state.cropRect.height * sourceHeight));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

    const [croppedLabel, wasRotated] = await autoOrientLabel(labelFromCanvas(canvas, label, "Manual crop"));
    state.results.splice(index, 1);
    state.results.unshift(croppedLabel);
    state.selectedLabelIndex = 0;
    closeCropEditor();
    renderResults({ labels: state.results });
    updateSheetPreview();
    setStatus(wasRotated ? "Manual crop applied — auto-rotated to portrait." : "Manual crop applied.");
    document.querySelector(".label-card")?.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    setStatus(`Crop failed: ${error.message}`);
  }
}

function labelFromCanvas(canvas, prior, variantName) {
  const dataUrl = canvas.toDataURL("image/png");
  return {
    ...prior,
    variantName,
    outputMimeType: "image/png",
    base64: dataUrl.split(",")[1],
    confidence: Math.max(prior.confidence || 0, 0.5),
    warnings: ["Manually adjusted in extension; review before printing."]
  };
}

function bindCropBoxEvents() {
  let dragging = null;
  let start = null;
  els.cropBox.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = event.target.dataset.handle || "move";
    start = { x: event.clientX, y: event.clientY, rect: { ...state.cropRect } };
    els.cropBox.setPointerCapture(event.pointerId);
  });
  els.cropBox.addEventListener("pointermove", (event) => {
    if (!dragging || !start) return;
    event.preventDefault();
    const bounds = els.cropLayer.getBoundingClientRect();
    const dx = (event.clientX - start.x) / Math.max(1, bounds.width);
    const dy = (event.clientY - start.y) / Math.max(1, bounds.height);
    if (dragging === "move") {
      state.cropRect.x = clamp(start.rect.x + dx, 0, 1 - start.rect.width);
      state.cropRect.y = clamp(start.rect.y + dy, 0, 1 - start.rect.height);
    } else {
      resizeCropRect(start.rect, dragging, dx, dy);
    }
    renderCropBox();
  });
  els.cropBox.addEventListener("pointerup", (event) => {
    event.preventDefault();
    dragging = null;
  });
  els.cropBox.addEventListener("pointercancel", () => {
    dragging = null;
  });
}

function resizeCropRect(original, handle, dx, dy) {
  const min = 0.08;
  const CROP_DRAG_SPEED = 1.5;
  const SHRINK = 0.375;

  const fastDx = dx * CROP_DRAG_SPEED;
  const fastDy = dy * CROP_DRAG_SPEED;
  const adx = ((handle.includes("w") && fastDx > 0) || (handle.includes("e") && fastDx < 0)) ? fastDx * SHRINK : fastDx;
  const ady = ((handle.includes("n") && fastDy > 0) || (handle.includes("s") && fastDy < 0)) ? fastDy * SHRINK : fastDy;

  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;
  if (handle.includes("w")) left = clamp(original.x + adx, 0, right - min);
  if (handle.includes("e")) right = clamp(original.x + original.width + adx, left + min, 1);
  if (handle.includes("n")) top = clamp(original.y + ady, 0, bottom - min);
  if (handle.includes("s")) bottom = clamp(original.y + original.height + ady, top + min, 1);
  state.cropRect = { x: left, y: top, width: right - left, height: bottom - top };
}

function renderCropBox() {
  els.cropBox.style.left = `${state.cropRect.x * 100}%`;
  els.cropBox.style.top = `${state.cropRect.y * 100}%`;
  els.cropBox.style.width = `${state.cropRect.width * 100}%`;
  els.cropBox.style.height = `${state.cropRect.height * 100}%`;
}

function positionCropLayerToImage() {
  if (els.cropEditor.hidden) return;
  const stageRect = els.cropImage.parentElement.getBoundingClientRect();
  const imageRect = fittedImageRect(els.cropImage);
  els.cropLayer.style.left = `${imageRect.left - stageRect.left}px`;
  els.cropLayer.style.top = `${imageRect.top - stageRect.top}px`;
  els.cropLayer.style.width = `${imageRect.width}px`;
  els.cropLayer.style.height = `${imageRect.height}px`;
}

function fittedImageRect(image) {
  const box = image.getBoundingClientRect();
  const naturalWidth = image.naturalWidth || image.width || 1;
  const naturalHeight = image.naturalHeight || image.height || 1;
  const imageAspect = naturalWidth / Math.max(1, naturalHeight);
  const boxAspect = box.width / Math.max(1, box.height);

  if (boxAspect > imageAspect) {
    const width = box.height * imageAspect;
    return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
  }

  const height = box.width / imageAspect;
  return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function setStatus(message, dotState) {
  els.statusText.textContent = message;
  els.statusText.classList.remove("connected", "error", "loading");
  if (dotState) els.statusText.classList.add(dotState);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
