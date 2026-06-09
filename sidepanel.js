// Apply the saved per-device display scale synchronously, before the panel
// paints, so low-resolution register screens don't flash at 100% then resize.
const UI_SCALE_KEY = "labelUiScale";
const UI_SCALE_MIN = 50;
const UI_SCALE_MAX = 110;
try {
  const cached = Number(localStorage.getItem(UI_SCALE_KEY));
  if (Number.isFinite(cached) && cached > 0) {
    document.documentElement.style.zoom = String(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, cached)) / 100);
  }
} catch (_) {}

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
  idleScrollTimer: null,
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
  "fold-here-label",
  "keywords",
  "lower-barcode-label",
  "barcode-density",
  "text-label-page",
  "embedded-twin-label",
  "embedded-usps-label",
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
// After this much complete inactivity (no pointer/key/scroll/touch), scroll the
// panel back to the top so the next person starts at a clean view. Tunable.
const IDLE_SCROLL_TO_TOP_MS = 120000;
const POPOUT_WIDTH_RATIO = 0.30;
const POPOUT_MIN_WIDTH = 520;
const POPOUT_MAX_WIDTH = 760;
const TRUSTED_LOCAL_CONFIDENCE = 0.90;
const STALE_DOWNLOAD_MS = 10 * 60 * 1000;
const NEW_DOWNLOAD_MS = 4 * 60 * 1000;
const REVIEW_CLEAR_WARNING_DELAY_MS = 70000;
const PENDING_CONTEXT_LABEL_KEY = "pendingContextLabel";
const RECENT_DRAGGED_LABEL_KEY = "recentDraggedLabel";
const RECENT_DRAGGED_LABEL_MAX_AGE_MS = 2 * 60 * 1000;

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
  copyFailureLog: document.getElementById("copyFailureLog"),
  debugReportStatus: document.getElementById("debugReportStatus"),
  printSettings: document.getElementById("printSettings"),
  manualCropTip: document.getElementById("manualCropTip"),
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
  inactivityCancel: document.getElementById("inactivityCancel"),
  uiScaleRange: document.getElementById("uiScaleRange"),
  uiScaleValue: document.getElementById("uiScaleValue"),
  uiScaleSummary: document.getElementById("uiScaleSummary"),
  uiScaleDown: document.getElementById("uiScaleDown"),
  uiScaleUp: document.getElementById("uiScaleUp"),
  uiScaleReset: document.getElementById("uiScaleReset")
};

init();

async function init() {
  const saved = await chrome.storage.local.get([
    "letterLabelPrintWidth",
    "letterLabelPrintLeft",
    "letterLabelPrintTop",
    "labelExtractorPrintMode",
    "labelDownloadsClearedAt",
    PENDING_CONTEXT_LABEL_KEY
  ]);
  state.printWidth = Number(saved.letterLabelPrintWidth ?? 4);
  state.printLeft = Number(saved.letterLabelPrintLeft ?? 0);
  state.printTop = Number(saved.letterLabelPrintTop ?? 0);
  state.printMode = "label";
  state.downloadsClearedAt = Number(saved.labelDownloadsClearedAt || 0);
  state.uiMode = "staff";
  initUiScale();
  syncPrintControls();
  applyUiMode();

  bindEvents();
  setStatus("Ready.");
  loadRecentDownloads();
  startDownloadsPolling();
  processPendingContextLabel(saved[PENDING_CONTEXT_LABEL_KEY]);
  // Warm the ONNX model shortly after the panel opens so the first ambiguous
  // label doesn't pay the full single-threaded load cost mid-workflow.
  scheduleModelWarmup();
}

function bindEvents() {
  els.modeToggle?.addEventListener("click", toggleUiMode);
  els.copyDebugReport?.addEventListener("click", copyDebugReport);
  els.copyFailureLog?.addEventListener("click", copyFailureLog);
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

  els.uiScaleRange?.addEventListener("input", () => applyUiScale(els.uiScaleRange.value, false));
  els.uiScaleRange?.addEventListener("change", () => applyUiScale(els.uiScaleRange.value, true));
  els.uiScaleDown?.addEventListener("click", () => stepUiScale(-5));
  els.uiScaleUp?.addEventListener("click", () => stepUiScale(5));
  els.uiScaleReset?.addEventListener("click", () => applyUiScale(autoFitScale(), true));

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

  // Idle-scroll-to-top: any real activity re-arms the timer (throttled so a burst
  // of mousemove/scroll events doesn't thrash). When it fires, the panel eases
  // back to the top. The programmatic scroll that results is a no-op once at top.
  let lastIdleReset = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastIdleReset < 1000) return;
    lastIdleReset = now;
    resetIdleScrollTimer();
  };
  ["pointerdown", "keydown", "wheel", "touchstart", "scroll", "mousemove"].forEach((evt) => {
    window.addEventListener(evt, onActivity, { passive: true });
  });
  resetIdleScrollTimer();

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const pending = changes[PENDING_CONTEXT_LABEL_KEY]?.newValue;
    if (pending) processPendingContextLabel(pending);
  });
}

// Display scale (zoom) lets a single low-resolution register screen shrink the
// whole panel so nothing is clipped. Stored in localStorage because it's a
// per-device screen preference, not synced workflow state.
function initUiScale() {
  let stored = NaN;
  try {
    stored = Number(localStorage.getItem(UI_SCALE_KEY));
  } catch (_) {}
  const initial = Number.isFinite(stored) && stored > 0 ? stored : autoFitScale();
  applyUiScale(initial, false);
}

// Largest 5% step that keeps the 720px-min content inside the current window.
// Measure with zoom temporarily neutralized so the result is the same whether
// Fit is pressed at 100% or while already scaled down (no paint happens between
// the reset and restore, so there's no visible flicker).
function autoFitScale() {
  const root = document.documentElement;
  const prevZoom = root.style.zoom;
  root.style.zoom = "1";
  const width = window.innerWidth || 720;
  root.style.zoom = prevZoom;
  const pct = Math.floor((width / 720) * 20) * 5;
  return clamp(pct, UI_SCALE_MIN, 100);
}

function applyUiScale(percent, persist = false) {
  const pct = clamp(Math.round(Number(percent) || 100), UI_SCALE_MIN, UI_SCALE_MAX);
  document.documentElement.style.zoom = String(pct / 100);
  if (els.uiScaleRange) els.uiScaleRange.value = String(pct);
  if (els.uiScaleValue) els.uiScaleValue.textContent = `${pct}%`;
  if (els.uiScaleSummary) els.uiScaleSummary.textContent = `${pct}%`;
  if (persist) {
    try {
      localStorage.setItem(UI_SCALE_KEY, String(pct));
    } catch (_) {}
  }
  return pct;
}

function stepUiScale(delta) {
  applyUiScale((Number(els.uiScaleRange?.value) || 100) + delta, true);
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

// Copies the detection-fallback telemetry as CSV (paste into a spreadsheet) so
// you can see which senders/carriers most often need manual cropping.
async function copyFailureLog() {
  try {
    const data = await chrome.storage?.local?.get("labelFailureLog");
    const log = Array.isArray(data?.labelFailureLog) ? data.labelFailureLog : [];
    if (!log.length) {
      if (els.debugReportStatus) els.debugReportStatus.textContent = "No detection fallbacks logged yet.";
      setStatus("No detection fallbacks logged yet.");
      return;
    }
    const csv = ["timestamp,sender,carrier,reason,confidence,file"]
      .concat(log.map((e) =>
        [e.at, e.sender, e.carrier, e.reason, e.confidence, e.fileName]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")))
      .join("\n");
    await navigator.clipboard.writeText(csv);
    if (els.debugReportStatus) els.debugReportStatus.textContent = `Failure log copied (${log.length} entries).`;
    setStatus(`Failure log copied (${log.length} entries).`);
  } catch (error) {
    setStatus(`Could not copy failure log: ${error.message}`, "error");
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
    twinLabelIndex: label.twinLabelIndex || null,
    twinLabelCount: label.twinLabelCount || null,
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

// Independent of the auto-clear timer: staff often leave the panel scrolled
// halfway down. After a stretch of complete idle, ease it back to the top so the
// next label starts at a clean view. Re-armed by any real user activity.
function resetIdleScrollTimer() {
  clearTimeout(state.idleScrollTimer);
  state.idleScrollTimer = setTimeout(scrollPanelToTop, IDLE_SCROLL_TO_TOP_MS);
}

function scrollPanelToTop() {
  const current = window.scrollY || document.documentElement.scrollTop || 0;
  if (current <= 4) return; // already at top — nothing to do
  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (_) {
    window.scrollTo(0, 0);
  }
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

// --- Recent downloads + intake extracted to app/downloads.js ---

function clearCurrentWork() {
  clearLoadedLabelState();
  state.clearMode = "idle";
  clearTimeout(state.inactivityTimer);
  state.inactivityTimer = null;
  resetFileSelection();
  setStatus("Cleared. Drop the next label file.");
  // Whether cleared by the auto-clear timer or the Clear button, reset the view
  // to the top so the next customer's label starts at a clean panel.
  scrollPanelToTop();
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
  const recent = await recentDraggedLabelForUrl(url);
  if (recent?.dataUrl) {
    await loadContextLabelDataUrl(recent.dataUrl, recent.name, recent.type);
    return;
  }

  if (/^blob:/i.test(url)) {
    await tryResolveDroppedBlobLabel(url);
    return;
  }

  await loadContextLabelUrl(url, basename(url));
}

async function tryResolveDroppedBlobLabel(url) {
  try {
    setStatus("Reading protected label from Outlook...", "loading");
    const response = await chrome.runtime.sendMessage({
      type: "resolve-dropped-blob-label",
      url
    });
    if (!response?.ok || !response.payload?.dataUrl) {
      throw new Error(response?.message || "Could not read protected label.");
    }
    await loadContextLabelDataUrl(response.payload.dataUrl, response.payload.name, response.payload.type);
  } catch (error) {
    setStatus(`Could not read dragged label: ${error.message}`, "error");
  }
}

async function recentDraggedLabelForUrl(url) {
  try {
    const data = await chrome.storage.local.get(RECENT_DRAGGED_LABEL_KEY);
    const recent = data[RECENT_DRAGGED_LABEL_KEY];
    if (!recent?.url && !recent?.dataUrl) return null;
    if (Date.now() - Number(recent.createdAt || 0) > RECENT_DRAGGED_LABEL_MAX_AGE_MS) return null;
    if (recent.url && url && recent.url !== url) return null;
    await chrome.storage.local.remove(RECENT_DRAGGED_LABEL_KEY).catch(() => {});
    return recent;
  } catch (_) {
    return null;
  }
}

function isSupportedFile(file) {
  const name = file.name.toLowerCase();
  return LabelExtractorConfig.SUPPORTED_TYPES.includes(file.type)
    || [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".heic", ".heif"].some((ext) => name.endsWith(ext));
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
    if (getTwinLabelCount(candidates) <= 1) {
      candidates = await addMissingPageCropOptions(candidates, localLabels);
    }
    if (!candidates.length && hasCachedCanvasPages()) {
      candidates = await fileFallbackCandidates(localLabels);
    }
    if (runId !== state.extractionRunId) return;

    // Rotate any sideways/landscape result upright so it displays and prints as a
    // portrait 4x6 without the operator needing to hit Rotate first.
    candidates = await Promise.all(candidates.map(orientLabelToPortrait));
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
    const twinCount = getTwinLabelCount(candidates);
    setStatus(twinCount > 1
      ? `${twinCount} labels found - print each one from this screen.`
      : candidates.length ? "Ready to print." : "No label candidates found - try another file or crop manually.");
    if (candidates.length) resetInactivityTimer();

    // Telemetry: note cases where detection didn't cleanly nail the label.
    const topResult = candidates[0];
    const detectionFellBack = !topResult
      || Boolean(topResult.needsCrop)
      || /fallback/i.test(topResult.localReason || "");
    if (detectionFellBack) logDetectionFallback(topResult, normalizedFile.name);
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

// --- Detection candidate building extracted to app/detect.js ---

function renderResults(payload) {
  els.results.replaceChildren();

  if (!payload.labels?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = payload.warnings?.join(" ") || "No label candidate was returned.";
    els.results.append(empty);
    els.printSettings.classList.add("inactive");
    // Nothing detected — surface the manual crop/expand guidance.
    if (els.manualCropTip) els.manualCropTip.hidden = false;
    return;
  }

  els.printSettings.classList.remove("inactive");

  // Only nudge staff to Crop/Expand when the top result actually needs it. On a
  // clean, print-ready label the tip is hidden so they trust the preview as-is.
  if (els.manualCropTip) {
    const topForTip = payload.labels[state.selectedLabelIndex] || payload.labels[0];
    els.manualCropTip.hidden = Boolean(getLabelActionHints(topForTip).printReady);
  }

  const multiLabelCount = getTwinLabelCount(payload.labels);
  if (multiLabelCount > 1) {
    els.results.append(makeMultiLabelNotice(payload.labels, multiLabelCount));
  }

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
    // Show what actually prints (white-trimmed, filled, sharpened) so staff can
    // trust the preview and skip needless Crop/Expand.
    if (preview.tagName === "IMG") {
      printPreviewDataUrl(label).then((url) => {
        if (url && url !== dataUrl && preview.isConnected) preview.src = url;
      });
    }

    const warnings = document.createElement("ul");
    warnings.className = "warnings";
    visibleWarnings(label).forEach((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      warnings.append(item);
    });

    const debugMeta = document.createElement("dl");
    debugMeta.className = "label-debug-meta";
    appendDebugMeta(debugMeta, "Tags", labDiagnosticTags(label).join(" / "));
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

function getTwinLabelCount(labels = []) {
  const count = labels.reduce((max, label) => Math.max(max, Number(label?.twinLabelCount || 0)), 0);
  const found = labels.filter((label) => Number(label?.twinLabelCount || 0) === count).length;
  return count > 1 && found >= count ? count : 0;
}

function makeMultiLabelNotice(labels, count) {
  const notice = document.createElement("div");
  notice.className = "multi-label-notice";

  const copy = document.createElement("div");
  copy.innerHTML = `<strong>${count} labels found in this PDF</strong><span>Print Label 1 and Label 2 from here. No redownload needed.</span>`;

  const printBoth = document.createElement("button");
  printBoth.type = "button";
  printBoth.className = "label-action label-action-print";
  printBoth.textContent = "Print both";
  printBoth.addEventListener("click", () => printLabelsInOrder(labels));

  notice.append(copy, printBoth);
  return notice;
}

function visibleWarnings(label) {
  if (state.uiMode === "lab") return label.warnings || [];
  return (label.warnings || []).filter((warning) => !isTechnicalFallbackWarning(warning));
}

function isTechnicalFallbackWarning(warning) {
  return /fallback result|source page|text-based pdf|embedded pdf/i.test(String(warning || ""));
}

function labDiagnosticTags(label) {
  const tags = [];
  if (label.pageCount) tags.push(`Page ${label.sourcePage || 1}`);
  if (label.carrier) tags.push(label.carrier);
  if (isFallbackLabel(label)) tags.push("fallback");
  if (label.needsCrop || hasCropWarning(label)) tags.push("crop-needed");
  if (!tags.length) tags.push("standard");
  return tags;
}

function isFallbackLabel(label) {
  return /fallback/i.test(String(label?.localReason || ""))
    || /fallback/i.test((label?.warnings || []).join(" "))
    || /fallback/i.test(String(label?.variantName || ""));
}

function resultDisplayName(label, index) {
  if (state.uiMode === "lab") return label.variantName || `Candidate ${index + 1}`;
  if (isFallbackLabel(label) && label.variantName) return label.variantName;
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
  button.addEventListener("click", () => printLabelAtIndex(index));
  return button;
}

async function printLabelsInOrder(labels) {
  const ordered = labels
    .map((label, index) => ({ label, index }))
    .filter(({ label }) => Number(label.twinLabelCount || 0) > 1)
    .sort((a, b) => Number(a.label.twinLabelIndex || a.index + 1) - Number(b.label.twinLabelIndex || b.index + 1));

  for (const item of ordered) {
    await printLabelAtIndex(item.index, { keepDownloadVisible: item !== ordered[ordered.length - 1] });
    await delay(350);
  }
}

async function printLabelAtIndex(index, options = {}) {
  const label = state.results[index];
  if (!label) return;

  state.selectedLabelIndex = index;
  updateSheetPreview();
  const rawUrl = labelToDataUrl(label);
  const scaledUrl = await resizeToLabelDpi(rawUrl, 203);
  const printUrl = await prepareForPrint(scaledUrl);
  printDataUrl(printUrl);
  resetInactivityTimer("printed");
  if (!options.keepDownloadVisible) markActiveDownloadPrinted();
  els.clearButton.classList.add("needs-clear");
  els.clearReminder.hidden = false;
  state.labelsPrintedCount++;
  if (state.labelsPrintedCount % MEMORY_CLEANUP_EVERY === 0) {
    backgroundMemoryCleanup().catch(() => {});
  }
}

function makeExpandButton(index, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Expand";
  button.className = "label-action label-action-expand";
  button.dataset.action = "expand";
  button.disabled = !state.file;
  button.title = state.file
    ? "Show the full source page so you can crop to the label yourself."
    : "No source file loaded.";
  button.addEventListener("click", () => expandToSourcePage(index));
  return button;
}

async function expandToSourcePage(index) {
  const label = state.results[index];
  if (!label || !state.file) {
    setStatus("Expand unavailable — load a label file first.");
    return;
  }
  if (state.extractionInProgress) {
    setStatus("Still extracting — wait for it to finish, then try Expand.");
    return;
  }

  setStatus("Loading full source page — please wait...");
  els.extractButton.disabled = true;

  try {
    const currentCacheKey = fileCacheKey(state.file);
    const targetPageIndex = Math.max(0, (label.sourcePage || 1) - 1);
    let sourceCanvas = null;
    let sourcePageText = "";

    if (state.cachedPages?.length && state.cachedPagesKey === currentCacheKey) {
      const page = state.cachedPages.find((p) => p.pageIndex === targetPageIndex) || state.cachedPages[0];
      sourceCanvas = page?.canvas || null;
      sourcePageText = page?.text || "";
    }

    if (!sourceCanvas) {
      const normalizedFile = await normalizeFileForExtraction(state.file);
      if (normalizedFile.type === "application/pdf" || normalizedFile.name.toLowerCase().endsWith(".pdf")) {
        // Render the page directly — no detection — so Expand works regardless of
        // what the detection cascade cached or returned.
        const page = await window.LabelExtractorPDF.renderPage({
          buffer: await normalizedFile.arrayBuffer(),
          type: "application/pdf",
          name: normalizedFile.name
        }, targetPageIndex);
        if (page?.canvas) {
          state.cachedPages = [page];
          state.cachedPagesKey = fileCacheKey(normalizedFile);
        }
        sourceCanvas = page?.canvas || null;
        sourcePageText = page?.text || "";
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
      if (state.uiMode === "lab") {
        console.warn("[Label Extractor] Expand: no source canvas", {
          cachedPages: state.cachedPages?.length || 0,
          keyMatch: state.cachedPagesKey === currentCacheKey,
          targetPageIndex
        });
      }
      setStatus("Could not load source page. Try using Crop instead.");
      return;
    }

    const suggestedCropRect = snapCropRectToSource(
      window.LabelExtractorDetector?.suggestLabelRect?.(sourceCanvas, sourcePageText),
      sourceCanvas
    );
    const dataUrl = sourceCanvas.toDataURL("image/png");
    const fullPageLabel = {
      ...label,
      base64: dataUrl.split(",")[1],
      outputMimeType: "image/png",
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      variantName: `Full page ${targetPageIndex + 1} — crop to label`,
      confidence: 0.5,
      suggestedCropRect,
      warnings: ["Full source page shown — drag the crop handles to the label area then click Apply crop."],
      localReason: null
    };

    state.results.unshift(fullPageLabel);
    state.selectedLabelIndex = 0;
    renderResults({ labels: state.results });
    updateSheetPreview();
    openCropEditor(0);
    setStatus(suggestedCropRect
      ? "Full page loaded - crop box snapped to the likely label. Adjust if needed, then click Apply crop."
      : "Full page loaded - drag the crop box to the label then click Apply crop.");
  } catch (error) {
    if (state.uiMode === "lab") console.error("[Label Extractor] Expand failed", error);
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

// Quietly record when detection couldn't produce a clean label and fell back to
// a crop/manual variant (or found nothing). Over time this reveals which senders
// or carriers need a dedicated detection rule. View it via lab mode > Copy failure log.
async function logDetectionFallback(label, fileName) {
  if (!chrome.storage?.local) return;
  try {
    const sender = await getStoredSenderInfo();
    const entry = {
      at: new Date().toISOString(),
      sender: sender?.email || sender?.name || "",
      carrier: label?.carrier || "",
      reason: label ? (label.localReason || "unknown") : "no-candidates",
      confidence: label ? Number(label.confidence || 0) : 0,
      fileName: fileName || ""
    };
    const data = await chrome.storage.local.get("labelFailureLog");
    const log = Array.isArray(data.labelFailureLog) ? data.labelFailureLog : [];
    log.push(entry);
    await chrome.storage.local.set({ labelFailureLog: log.slice(-300) });
  } catch (_) {}
}

function markActiveDownloadPrinted() {
  if (state.activeDownloadId) {
    state.suppressedDownloadIds.add(state.activeDownloadId);
    renderDownloadsMessage("Printed label hidden. Waiting for the next label download.");
    state.activeDownloadId = null;
  }
}

// --- Print pipeline extracted to app/print.js ---

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
  // Upgrade to the print-accurate image (white-trimmed, filled, sharpened) once
  // ready, so the sheet preview matches the printed output.
  printPreviewDataUrl(label).then((url) => {
    if (url && state.results[state.selectedLabelIndex] === label) els.sheetPreviewLabel.src = url;
  });
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

// The on-screen preview must match what actually prints, so staff trust it and
// don't needlessly Crop/Expand. Runs the label through the exact print pipeline
// (white-trim + fill to 4x6 via resizeToLabelDpi, then prepareForPrint sharpen),
// the same steps printLabelAtIndex uses. Cached on the label object so each one
// is processed once; rotate/crop/expand create new label objects, so the cache
// naturally invalidates.
async function printPreviewDataUrl(label) {
  if (!label) return "";
  const raw = labelToDataUrl(label);
  if (label.outputMimeType === "application/pdf") return raw;
  if (label._printPreviewUrl) return label._printPreviewUrl;
  try {
    const scaled = await resizeToLabelDpi(raw, 203);
    const prepared = await prepareForPrint(scaled);
    label._printPreviewUrl = prepared;
    return prepared;
  } catch (_) {
    return raw;
  }
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

// --- Crop editor + image transforms extracted to app/crop.js ---

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
