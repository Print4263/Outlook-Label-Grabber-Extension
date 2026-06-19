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
  nibble: null,
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
  lastExtractionSummary: null,
  runtimeHealth: null,
  reprintHideTimer: null
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
const LAST_PRINTED_LABEL_KEY = "lastPrintedLabel";
const REPRINT_MAX_AGE_MS = 10 * 60 * 1000;
const LabelFeedback = window.LabelExtractorFeedback;
const RuntimeHealth = window.LabelExtractorRuntimeHealth;
let labelLogWriteErrorCount = 0;
const failureLogStore = LabelFeedback.createFailureLogStore({
  storage: chrome.storage?.local,
  getSenderInfo: () => getStoredSenderInfo(),
  createEventId: () => globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
});

const els = {
  statusText: document.getElementById("statusText"),
  modeToggle: document.getElementById("modeToggle"),
  reprintButton: document.getElementById("reprintButton"),
  popoutButton: document.getElementById("popoutButton"),
  resetLayoutButton: document.getElementById("resetLayoutButton"),
  dropZone: document.getElementById("dropZone"),
  dropOverlay: document.getElementById("dropOverlay"),
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
  copyPrivateFailureLog: document.getElementById("copyPrivateFailureLog"),
  clearFailureLog: document.getElementById("clearFailureLog"),
  flagLabel: document.getElementById("flagLabel"),
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
    "labelDownloadsClearedAt",
    PENDING_CONTEXT_LABEL_KEY
  ]);
  state.downloadsClearedAt = Number(saved.labelDownloadsClearedAt || 0);
  state.uiMode = "staff";
  initUiScale();
  updateSheetPreview();
  applyUiMode();

  bindEvents();
  setStatus("Ready — open an Outlook email or choose a file.");
  void runRuntimeSelfCheck();
  loadRecentDownloads();
  startDownloadsPolling();
  refreshReprintButton();
  processPendingContextLabel(saved[PENDING_CONTEXT_LABEL_KEY]);
  // Warm the ONNX model shortly after the panel opens so the first ambiguous
  // label doesn't pay the full single-threaded load cost mid-workflow.
  scheduleModelWarmup();
}

function bindEvents() {
  els.modeToggle?.addEventListener("click", toggleUiMode);
  els.reprintButton?.addEventListener("click", reprintLastLabel);
  els.copyDebugReport?.addEventListener("click", copyDebugReport);
  els.copyFailureLog?.addEventListener("click", copyFailureLog);
  els.copyPrivateFailureLog?.addEventListener("click", copyPrivateFailureLog);
  els.clearFailureLog?.addEventListener("click", clearFailureLog);
  els.flagLabel?.addEventListener("click", flagCurrentLabel);
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

  // Whole-panel drop target. A drag from Outlook can land anywhere on the panel,
  // not just the (collapsed) "Choose file manually" box — and without a
  // document-level dragover+drop the browser falls back to NAVIGATING to the
  // dropped blob: URL (the dead-blob tab). dragover MUST preventDefault or the
  // drop event never fires at all.
  document.addEventListener("dragenter", (event) => {
    event.preventDefault();
    showDropOverlay(event);
  });
  document.addEventListener("dragover", (event) => {
    event.preventDefault();
    showDropOverlay(event);
  });
  document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget) return; // only the real "left the window" leave
    hideDropOverlay();
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    hideDropOverlay();
    handleDrop(event);
  });

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

function showDropOverlay(event) {
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "copy";
  if (els.dropOverlay) els.dropOverlay.hidden = false;
  document.body.classList.add("panel-dragging");
  els.dropZone?.classList.add("dragging");
}

function hideDropOverlay() {
  if (els.dropOverlay) els.dropOverlay.hidden = true;
  document.body.classList.remove("panel-dragging");
  els.dropZone?.classList.remove("dragging");
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

async function loadFailureLog() {
  return failureLogStore.read();
}

function noteLabelLogFailure(action, error, showToOwner = false) {
  labelLogWriteErrorCount += 1;
  console.warn(`[Label Extractor] Could not ${action}`, error);
  if (showToOwner || state.uiMode === "lab") {
    const message = `Bad-label log error (${labelLogWriteErrorCount}): could not ${action}.`;
    if (els.debugReportStatus) els.debugReportStatus.textContent = message;
    setStatus(message, "error");
  }
}

async function copyTextWithFallback(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable.");
    await navigator.clipboard.writeText(text);
    return;
  } catch (clipboardError) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand?.("copy");
    textarea.remove();
    if (!copied) throw clipboardError;
  }
}

// Lab-only weekly pull. The default summary deliberately excludes sender and
// filename so it is safe to share for diagnosis.
async function copyFailureLog() {
  return copyFailureLogCsv(false);
}

async function copyPrivateFailureLog() {
  const approved = window.confirm(
    "Private locator log includes customer sender details and original filenames. Keep it local and do not paste it into chat. Copy it now?"
  );
  if (!approved) return;
  return copyFailureLogCsv(true);
}

async function copyFailureLogCsv(includePrivate) {
  try {
    const log = await loadFailureLog();
    if (!log.length) {
      if (els.debugReportStatus) els.debugReportStatus.textContent = "No bad labels logged yet.";
      setStatus("No bad labels logged yet.");
      return;
    }
    const csv = LabelFeedback.formatFailureLogCsv(log, { includePrivate });
    await copyTextWithFallback(csv);
    const oldest = LabelFeedback.oldestFailureDate(log);
    const exportName = includePrivate ? "Private locator log" : "Privacy-safe summary";
    const msg = `${exportName} copied (${log.length} entries since ${oldest}).`;
    if (els.debugReportStatus) els.debugReportStatus.textContent = msg;
    setStatus(`${exportName} copied (${log.length} entries).`);
  } catch (error) {
    noteLabelLogFailure("copy the bad-label log", error, true);
  }
}

// Lab-only: explicitly record the label currently on screen into the weekly log,
// even if it detected cleanly (the auto-capture only fires on corrections/fallbacks,
// so a confident-but-wrong crop would otherwise never be captured). Lab-mode only.
async function flagCurrentLabel() {
  const list = state.results || [];
  const label = list[state.selectedLabelIndex] || list[0];
  if (!label) {
    if (els.debugReportStatus) els.debugReportStatus.textContent = "No label on screen to flag.";
    setStatus("No label on screen to flag.");
    return;
  }
  const result = await logLabelIssue("flagged", label, state.file?.name || "");
  if (!result.ok) {
    if (els.debugReportStatus) els.debugReportStatus.textContent = `Could not flag label: ${result.error.message}`;
    setStatus(`Could not flag label: ${result.error.message}`, "error");
    return;
  }
  const message = result.duplicate
    ? "This label was already flagged recently."
    : "Label flagged for the weekly report.";
  if (els.debugReportStatus) els.debugReportStatus.textContent = message;
  setStatus(message);
}

// Clearing is destructive, so require an explicit confirmation and serialize it
// behind any in-flight writes.
async function clearFailureLog() {
  const approved = window.confirm("Clear the entire bad-label log? Copy a summary first if you still need it.");
  if (!approved) return;
  try {
    const { count } = await failureLogStore.clear();
    if (els.debugReportStatus) els.debugReportStatus.textContent = `Bad-label log cleared (${count} removed).`;
    setStatus(`Bad-label log cleared (${count} removed).`);
  } catch (error) {
    noteLabelLogFailure("clear the bad-label log", error, true);
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
    runtimeHealth: state.runtimeHealth,
    cachedPages,
    results
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
    // Preserve the reprint entry across the session wipe — it expires on its
    // own schedule, and losing it here would defeat reprint right after the
    // print that triggered this cleanup.
    const lastPrinted = await getFreshLastPrintedLabel();
    try {
      await chrome.storage.session.clear();
    } catch (_) {}
    if (lastPrinted) {
      chrome.storage.session.set({ [LAST_PRINTED_LABEL_KEY]: lastPrinted }).catch(() => {});
    }
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
  els.alertBanner._dismissTimer = null;
  if (duration > 0) {
    els.alertBanner._dismissTimer = setTimeout(() => {
      els.alertBanner.hidden = true;
      if (state.runtimeHealth?.ok === false && state.runtimeHealth.message) {
        showBanner(state.runtimeHealth.message, "warning", 0);
      }
    }, duration);
  }
}

async function runRuntimeSelfCheck() {
  if (!RuntimeHealth?.checkRuntimeHealth) return;
  try {
    const health = await RuntimeHealth.checkRuntimeHealth({
      checkFileAccess: checkFileUrlAccess,
      probeAsset: probePackagedAsset
    });
    state.runtimeHealth = health;
    if (!health.ok && health.message) showBanner(health.message, "warning", 0);
  } catch (error) {
    state.runtimeHealth = { ok: false, checkFailed: true };
    console.warn("[Label Extractor] Startup dependency check failed.", error);
    showBanner("Startup check could not finish. Reload this extension.", "warning", 0);
  }
}

function checkFileUrlAccess() {
  const check = chrome.extension?.isAllowedFileSchemeAccess;
  if (typeof check !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    check.call(chrome.extension, (allowed) => {
      if (chrome.runtime?.lastError) {
        resolve(null);
        return;
      }
      resolve(Boolean(allowed));
    });
  });
}

async function probePackagedAsset(path) {
  if (!chrome.runtime?.getURL) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(chrome.runtime.getURL(path), {
      cache: "no-store",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal
    });
    try { await response.body?.cancel(); } catch (_) {}
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function setFile(file) {
  clearLoadedLabelState();
  resetFileSelection();

  if (!file) return;
  if (!isSupportedFile(file)) {
    setStatus("Choose a PDF or image file (PNG, JPG, GIF, WEBP, HEIC).");
    return;
  }
  if (file.size > LabelExtractorConfig.MAX_UPLOAD_BYTES) {
    setStatus("File is too large. Use a smaller PDF or image.");
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
    // Auto-extract on drop — staff shouldn't have to find the Extract button as a
    // separate next step. (The dropped-URL path below already auto-extracts via
    // loadContextLabel*; this matches it for a dropped File / dragged image.)
    await extractSelectedFile();
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
  // Dragging a recent-download row onto the panel auto-extracts too.
  await useDownloadedFile(matches[0], { extractAfterLoad: true });
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
  return window.LabelExtractorDragData?.firstUrlFromTransfer?.(transfer) || "";
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
    || [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"].some((ext) => name.endsWith(ext));
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

// When the barcode decode identified a real carrier tracking number on a variant
// (the one showing the 📦 carrier+tracking badge), that variant is almost
// certainly the actual shipping label — float it to the top so it's the selected,
// previewed, and printed one. Skip multi-label (twin) sheets, where every
// candidate is a real label and their order is meaningful ("Label 1 of 2").
function promoteTrackedLabel(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) return candidates;
  if (getTwinLabelCount(candidates) > 1) return candidates;
  const index = candidates.findIndex((label) => label && label.carrierConfident && label.trackingNumber);
  if (index <= 0) return candidates;
  const promoted = candidates.slice();
  const [tracked] = promoted.splice(index, 1);
  promoted.unshift(tracked);
  return promoted;
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
    // Stage timings land in the debug report (lab mode > Copy debug report) so a
    // slow extraction can be traced to its stage instead of guessed at.
    const tStart = performance.now();
    const normalizedFile = await normalizeFileForExtraction(state.file);
    if (runId !== state.extractionRunId) return;
    setLoadingProgress(30);
    const tNormalized = performance.now();

    const result = await tryLocalDetectorCandidate(normalizedFile);
    if (runId !== state.extractionRunId) return;
    setLoadingProgress(85);
    const tDetected = performance.now();

    const localLabels = normalizeLocalResults(result);
    let candidates = await fullLabelCandidates(localLabels);
    if (getTwinLabelCount(candidates) <= 1) {
      candidates = await addMissingPageCropOptions(candidates, localLabels);
    }
    if (!candidates.length && hasCachedCanvasPages()) {
      candidates = await fileFallbackCandidates(localLabels);
    }
    if (runId !== state.extractionRunId) return;
    const tCandidates = performance.now();

    // Rotate any sideways/landscape result upright so it displays and prints as a
    // portrait 4x6 without the operator needing to hit Rotate first.
    candidates = await Promise.all(candidates.map(orientLabelToPortrait));
    if (runId !== state.extractionRunId) return;
    const tOriented = performance.now();

    setLoadingProgress(100);
    state.lastExtractionSummary = {
      fileName: normalizedFile.name,
      fileType: normalizedFile.type,
      rawLocalCount: localLabels.length,
      finalCandidateCount: candidates.length,
      usedFallback: candidates.some((label) => String(label.localReason || "").includes("fallback")),
      pageCount: state.cachedPages?.length || 0,
      timings: {
        totalMs: Math.round(tOriented - tStart),
        normalizeMs: Math.round(tNormalized - tStart),
        detectMs: Math.round(tDetected - tNormalized),
        candidatesMs: Math.round(tCandidates - tDetected),
        orientMs: Math.round(tOriented - tCandidates)
      }
    };
    state.results = promoteTrackedLabel(candidates);
    state.selectedLabelIndex = state.results.length ? 0 : -1;
    renderResults({ labels: state.results });
    updateSheetPreview();
    const twinCount = getTwinLabelCount(candidates);
    const topHints = candidates[0] ? getLabelActionHints(candidates[0]) : null;
    const completionStatus = !candidates.length
      ? "No printable label found. Try the original PDF/image or Recent downloads."
      : isTrustedLabel(candidates[0], topHints)
        ? "Label ready — check the preview, then print."
        : "Check the preview before printing.";
    setStatus(twinCount > 1
      ? `${twinCount} labels found — check and print each one.`
      : completionStatus);
    if (candidates.length) resetInactivityTimer();

    // Telemetry: note cases where detection didn't cleanly nail the label.
    const topResult = candidates[0];
    const detectionFellBack = !topResult
      || Boolean(topResult.needsCrop)
      || /fallback/i.test(topResult.localReason || "");
    if (detectionFellBack) logLabelIssue(topResult ? "fallback" : "no-candidates", topResult, normalizedFile.name);
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
    empty.textContent = payload.warnings?.join(" ") || "No printable label found. Try the original PDF or image.";
    els.results.append(empty);
    els.printSettings.classList.add("inactive");
    return;
  }

  els.printSettings.classList.remove("inactive");

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
    const printButton = makePrintButton(index, label, actionHints);
    const nibbleControls = makeNibbleControls(index, label);
    actions.append(printButton, cropButton, rotateButton, expandButton);
    if (nibbleControls) actions.append(nibbleControls);

    if (preview.tagName === "IMG") {
      preview.addEventListener("load", () => {
        const imageLabel = {
          ...label,
          width: preview.naturalWidth,
          height: preview.naturalHeight
        };
        const imageHints = getLabelActionHints(imageLabel);
        decorateActionButton(rotateButton, "rotate", imageHints.rotate);
        decorateActionButton(cropButton, "crop", imageHints.crop);
        decorateActionButton(printButton, "print", isTrustedLabel(imageLabel, imageHints));
      }, { once: true });
    }

    const carrierBadge = makeCarrierBadge(label);
    card.append(title);
    if (carrierBadge) card.append(carrierBadge);
    card.append(actions, preview, warnings, debugMeta);
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

// A staff-visible carrier + tracking badge built from the decoded barcode. Shows
// only when the barcode-decode confirmation actually read a carrier code off this
// crop (carrierConfident) or extracted a tracking number — a bare text-guessed
// carrier with no number stays out of the way. The ✓ marks a check-digit-validated
// number; the tracking number copies to the clipboard on click.
function makeCarrierBadge(label) {
  const tracking = String(label.trackingNumber || "").trim();
  const carrier = String(label.carrier || "").trim();
  const confident = label.carrierConfident && carrier && carrier !== "Model";
  if (!tracking && !confident) return null;

  const badge = document.createElement("div");
  badge.className = "carrier-badge";

  const icon = document.createElement("span");
  icon.className = "carrier-badge-icon";
  icon.textContent = "📦";
  const carrierEl = document.createElement("strong");
  carrierEl.textContent = carrier && carrier !== "Model" ? carrier : "Barcode";
  badge.append(icon, carrierEl);

  if (tracking) {
    const trk = document.createElement("button");
    trk.type = "button";
    trk.className = "carrier-badge-tracking";
    trk.textContent = tracking;
    trk.title = "Click to copy tracking number";
    trk.addEventListener("click", () => {
      navigator.clipboard?.writeText(tracking).then(
        () => setStatus(`Copied tracking ${tracking}`),
        () => {}
      );
    });
    badge.append(trk);
  }

  if (label.carrierValidated) {
    const check = document.createElement("span");
    check.className = "carrier-badge-valid";
    check.textContent = "✓";
    check.title = "Check-digit validated";
    badge.append(check);
  }

  return badge;
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
  if (isTrustedLabel(label, hints)) return "Label ready";
  if (hints.printReady) return "Check before printing";
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
  if (hints.printReady) {
    // "Ready" (green) only when the extension is actually sure: a check-digit
    // validated carrier barcode, or detector confidence at/above the trust floor.
    // A geometrically-fine but uncertain crop (e.g. 0.86-0.899, no validated
    // barcode) gets "Check preview" so staff verify the preview instead of
    // trusting a confident-looking guess. No detection change — display only.
    return isTrustedLabel(label, hints)
      ? { label: "Ready", className: "conf-high" }
      : { label: "Check preview", className: "conf-mid" };
  }
  return { label: "Review", className: "conf-mid" };
}

function isTrustedLabel(label, hints = getLabelActionHints(label)) {
  return LabelFeedback.isTrustedLabel(label, hints, TRUSTED_LOCAL_CONFIDENCE);
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

// --- Result-card Tighten/Loosen crop nibble (Phase 1 / B3) -------------------
// Two small buttons per card that step the crop inward (-) or outward (+) without
// opening the editor. State lives on `state.nibble` as a baseline rect + an
// integer level, so every tap recomputes from the baseline (exact and reversible)
// and level 0 restores the original auto-crop untouched. When the cached source
// PAGE is available we crop from it (true inward AND outward nibble); otherwise we
// fall back to the label's own image (tighten works; loosen points to Expand).
// Straight pixel copy only - never the content-aware crop, which would re-absorb
// chrome on tighten or re-trim on loosen. App-layer only: nothing here touches
// detection, ranking, candidate selection, or crop-engine.
const NIBBLE_STEP = 0.04;             // loosen: fraction of the baseline crop added per level, per edge pair (feel the user signed off on)
const NIBBLE_MIN_BASE_FRACTION = 0.4; // floor for the uniform-inset tighten fallback
const TIGHTEN_GAP_FRACTION = 0.25;    // tighten: fraction of the remaining gap to the label box closed per level
const TIGHTEN_UNIFORM_STEP = 0.025;   // tighten fallback (no content box found): gentler than a loosen step

function makeNibbleControls(index, label) {
  if (label?.outputMimeType === "application/pdf") return null;
  const group = document.createElement("div");
  group.className = "nibble-controls";

  const tighten = document.createElement("button");
  tighten.type = "button";
  tighten.className = "label-action label-action-nibble";
  tighten.textContent = "−";
  tighten.setAttribute("aria-label", "Tighten crop");
  tighten.title = "Tighten - crop in a little (remove an even margin all around)";
  tighten.addEventListener("click", () => nibbleCrop(index, -1));

  const loosen = document.createElement("button");
  loosen.type = "button";
  loosen.className = "label-action label-action-nibble";
  loosen.textContent = "+";
  loosen.setAttribute("aria-label", "Loosen crop");
  loosen.title = "Loosen - crop out a little (add back an even margin all around)";
  loosen.addEventListener("click", () => nibbleCrop(index, 1));

  group.append(tighten, loosen);
  return group;
}

async function nibbleCrop(index, direction) {
  const current = state.results[index];
  if (!current) return;

  // Rebuild the baseline whenever a different card, or a non-nibble action
  // (rotate/crop/expand/new extraction), replaced what we last produced here.
  let nib = state.nibble;
  if (!nib || nib.index !== index || nib.lastResult !== current) {
    nib = await buildNibbleBaseline(index, current);
    if (!nib) {
      setStatus("Tighten/Loosen isn't available for this label - use Crop or Expand.");
      return;
    }
    state.nibble = nib;
  }

  const nextLevel = nib.level + direction;
  const rect = rectForNibbleLevel(nib, nextLevel);
  if (!rect) {
    setStatus(direction > 0
      ? "Can't loosen any further - use Expand to recover more of the page."
      : "Can't tighten any further.");
    return;
  }

  let nextLabel;
  if (nextLevel === 0) {
    nextLabel = nib.original;
  } else {
    const canvas = straightCropCanvas(nib.source, rect);
    const named = labelFromCanvas(canvas, nib.original, nibbleVariantName(nib.original, nextLevel));
    // labelFromCanvas spreads the original (carrying its sourceCanvas), but
    // autoOrientLabel prefers sourceCanvas over base64 - so without this it would
    // orient the ORIGINAL canvas and throw away this nibble. Null it so the
    // freshly cropped base64 is what gets oriented.
    named.sourceCanvas = null;
    const [oriented] = await autoOrientLabel(named);
    nextLabel = oriented;
  }

  nib.level = nextLevel;
  nib.lastResult = nextLabel;
  state.results[index] = nextLabel;
  state.selectedLabelIndex = index;
  renderResults({ labels: state.results });
  updateSheetPreview();
  setStatus(nextLevel === 0
    ? "Crop reset to the original."
    : `Crop ${nextLevel < 0 ? "tightened" : "loosened"} (${nextLevel > 0 ? "+" : ""}${nextLevel}).`);
}

async function buildNibbleBaseline(index, label) {
  // Prefer the cached source page: it holds the pixels outside the current crop,
  // so loosen can grow the crop back outward, not just undo a tighten.
  const page = pageCanvasForLabel(label);
  const sourceWidth = Number(label?.sourceWidth || 0);
  const sourceHeight = Number(label?.sourceHeight || 0);
  if (page && label?.sourceRect && sourceWidth && sourceHeight
      && Math.abs(page.width - sourceWidth) <= 2 && Math.abs(page.height - sourceHeight) <= 2) {
    const base = clampRectToCanvas(label.sourceRect, page);
    if (base) {
      return { index, source: page, baseRect: base, tightRect: contentRectWithin(page, base), original: label, level: 0, lastResult: label, canLoosen: true };
    }
  }

  // Fallback: crop the label's own image. Tighten works; loosen has no outward
  // pixels here, so it is capped at the original crop and nudges toward Expand.
  const img = await loadImage(labelToDataUrl(label)).catch(() => null);
  if (!img) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  if (!canvas.width || !canvas.height) return null;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const base = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  return { index, source: canvas, baseRect: base, tightRect: contentRectWithin(canvas, base), original: label, level: 0, lastResult: label, canLoosen: false };
}

function pageCanvasForLabel(label) {
  const pageNumber = Number(label?.sourcePage || 0);
  if (!pageNumber) return null;
  const page = (state.cachedPages || []).find(
    (entry) => entry?.canvas && (Number(entry.pageIndex || 0) + 1) === pageNumber
  );
  return page?.canvas || null;
}

function rectForNibbleLevel(nib, level) {
  const base = nib.baseRect;
  if (level === 0) return { ...base };

  if (level < 0) {
    // Tighten homes in on the actual label - the dark-content box - so it trims
    // the emptiest margins first instead of shaving all four edges equally, and
    // converges on the label rather than over-cropping into it.
    const target = nib.tightRect;
    if (target && rectIsInside(target, base) && rectArea(target) < rectArea(base) * 0.98) {
      const steps = Math.abs(level);
      const t = Math.min(1, steps * TIGHTEN_GAP_FRACTION);
      if (t >= 1 && steps > Math.ceil(1 / TIGHTEN_GAP_FRACTION)) return null; // already snug on the label
      const x = base.x + (target.x - base.x) * t;
      const y = base.y + (target.y - base.y) * t;
      const right = (base.x + base.width) + ((target.x + target.width) - (base.x + base.width)) * t;
      const bottom = (base.y + base.height) + ((target.y + target.height) - (base.y + base.height)) * t;
      return roundRect(x, y, right - x, bottom - y);
    }
    // No usable content box (already snug, or unreadable): gentle uniform inset.
    return uniformNibbleRect(nib, level, TIGHTEN_UNIFORM_STEP);
  }

  // Loosen: uniform outward, the feel the user signed off on.
  if (!nib.canLoosen) return null;
  return uniformNibbleRect(nib, level, NIBBLE_STEP);
}

function uniformNibbleRect(nib, level, step) {
  const base = nib.baseRect;
  const src = nib.source;
  const dx = base.width * step * level;
  const dy = base.height * step * level;
  let x = base.x - dx;
  let y = base.y - dy;
  let w = base.width + 2 * dx;
  let h = base.height + 2 * dy;

  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > src.width) w = src.width - x;
  if (y + h > src.height) h = src.height - y;

  if (level < 0 && (w < base.width * NIBBLE_MIN_BASE_FRACTION || h < base.height * NIBBLE_MIN_BASE_FRACTION)) {
    return null;
  }
  if (w < 8 || h < 8) return null;
  return roundRect(x, y, w, h);
}

function roundRect(x, y, width, height) {
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function rectArea(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function rectIsInside(inner, outer) {
  return inner.x >= outer.x - 1
    && inner.y >= outer.y - 1
    && inner.x + inner.width <= outer.x + outer.width + 1
    && inner.y + inner.height <= outer.y + outer.height + 1;
}

// Dark-content bounding box inside `rect` of the source canvas, padded slightly so
// the label's own edge ink is never shaved. Returns source-pixel coords, or null
// when the region is blank/uniform or the canvas can't be read.
function contentRectWithin(source, rect) {
  const x0 = clamp(Math.round(rect.x), 0, source.width - 1);
  const y0 = clamp(Math.round(rect.y), 0, source.height - 1);
  const w = clamp(Math.round(rect.width), 1, source.width - x0);
  const h = clamp(Math.round(rect.height), 1, source.height - y0);

  let data;
  try {
    const ctx = source.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    data = ctx.getImageData(x0, y0, w, h).data;
  } catch (_) {
    return null;
  }

  const step = Math.max(2, Math.floor(Math.min(w, h) / 700));
  let left = w, top = h, right = -1, bottom = -1;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 24) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum > 225) continue;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x > right) right = x;
      if (y > bottom) bottom = y;
    }
  }
  if (right <= left || bottom <= top) return null;

  const padX = Math.max(4, Math.round(w * 0.02));
  const padY = Math.max(4, Math.round(h * 0.02));
  const cx = clamp(x0 + left - padX, x0, x0 + w);
  const cy = clamp(y0 + top - padY, y0, y0 + h);
  const cRight = clamp(x0 + right + step + padX, cx + 1, x0 + w);
  const cBottom = clamp(y0 + bottom + step + padY, cy + 1, y0 + h);
  return { x: cx, y: cy, width: cRight - cx, height: cBottom - cy };
}

function clampRectToCanvas(rect, canvas) {
  const x = clamp(Math.round(Number(rect.x) || 0), 0, canvas.width - 1);
  const y = clamp(Math.round(Number(rect.y) || 0), 0, canvas.height - 1);
  const w = clamp(Math.round(Number(rect.width) || 0), 1, canvas.width - x);
  const h = clamp(Math.round(Number(rect.height) || 0), 1, canvas.height - y);
  if (w < 8 || h < 8) return null;
  return { x, y, width: w, height: h };
}

function straightCropCanvas(source, rect) {
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return canvas;
}

function nibbleVariantName(original, level) {
  const base = String(original?.variantName || "Crop");
  return `${base} (${level < 0 ? "tightened" : "loosened"} ${Math.abs(level)})`;
}

function makePrintButton(index, label, actionHints) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Print";
  decorateActionButton(button, "print", isTrustedLabel(label, actionHints));
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
  await saveLastPrintedLabel(printUrl);
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

  // Lab-only telemetry: staff expanding to the source page means the auto-crop
  // wasn't usable. Log the rejected auto-result so it surfaces in the weekly pull.
  logLabelIssue("expand", label, state.file?.name || "");

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

// Quietly record bad/uncertain labels so the owner can pull a privacy-safe Lab
// summary and report patterns for a dedicated detection rule. Captures
// detection fallbacks/no-candidates AND manual corrections (the strongest "the
// auto-crop was wrong" signal: staff re-cropped or expanded the chosen result).
// Owner-only — never surfaced to counter staff. Local storage; never committed.
async function logLabelIssue(kind, label, fileName) {
  try {
    return await failureLogStore.record(kind, label, fileName);
  } catch (error) {
    // Surface instead of swallowing — a silent failure here is why a "didn't
    // record" issue is hard to diagnose. Lab owners can see it in the console.
    noteLabelLogFailure(`record ${kind || "unknown"} label issue`, error);
    return { ok: false, recorded: false, error };
  }
}

// --- Reprint last label ------------------------------------------------------
// Keeps the final print-ready image of the most recent print for a short window
// so a paper jam or wrong-tray misprint doesn't force redoing the whole
// download-and-extract flow. Stored in storage.session: survives Clear and
// panel reloads, expires after REPRINT_MAX_AGE_MS, and is wiped when the
// browser closes (so it never lingers overnight on a register).
async function saveLastPrintedLabel(printUrl) {
  if (!chrome.storage?.session) return;
  try {
    await chrome.storage.session.set({
      [LAST_PRINTED_LABEL_KEY]: {
        printUrl,
        name: state.file?.name || "label",
        printedAt: Date.now()
      }
    });
  } catch (_) {}
  refreshReprintButton();
}

async function getFreshLastPrintedLabel() {
  if (!chrome.storage?.session) return null;
  try {
    const data = await chrome.storage.session.get(LAST_PRINTED_LABEL_KEY);
    const entry = data[LAST_PRINTED_LABEL_KEY];
    if (!entry?.printUrl) return null;
    if (Date.now() - Number(entry.printedAt || 0) > REPRINT_MAX_AGE_MS) return null;
    return entry;
  } catch (_) {
    return null;
  }
}

async function refreshReprintButton() {
  if (!els.reprintButton) return;
  const entry = await getFreshLastPrintedLabel();
  els.reprintButton.hidden = !entry;
  clearTimeout(state.reprintHideTimer);
  if (!entry) return;
  const expiresAt = new Date(Number(entry.printedAt) + REPRINT_MAX_AGE_MS);
  els.reprintButton.title =
    `Print "${entry.name}" again (kept until ${expiresAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
  // Hide the button on its own once the entry expires.
  const remaining = Number(entry.printedAt) + REPRINT_MAX_AGE_MS - Date.now();
  state.reprintHideTimer = setTimeout(refreshReprintButton, Math.max(1000, remaining + 250));
}

async function reprintLastLabel() {
  const entry = await getFreshLastPrintedLabel();
  if (!entry) {
    if (els.reprintButton) els.reprintButton.hidden = true;
    setStatus("No recent label to reprint - the last print has expired.");
    return;
  }
  printDataUrl(entry.printUrl);
  setStatus(`Reprinting "${entry.name}".`);
}

function markActiveDownloadPrinted() {
  if (state.activeDownloadId) {
    state.suppressedDownloadIds.add(state.activeDownloadId);
    renderDownloadsMessage("Printed label hidden. Waiting for the next label download.");
    state.activeDownloadId = null;
  }
}

// --- Print pipeline extracted to app/print.js ---

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
  sheet.classList.add("label-sheet");
  els.sheetPreviewLabel.style.left = "0";
  els.sheetPreviewLabel.style.top = "0";
  els.sheetPreviewLabel.style.width = "100%";
  els.sheetPreviewLabel.style.height = "100%";
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
  // Cache keyed by the image itself: crop/rotate spread the prior label (carrying
  // _printPreviewUrl), so without comparing base64 a cropped label would keep
  // showing the pre-crop preview.
  if (label._printPreviewUrl && label._printPreviewKey === label.base64) return label._printPreviewUrl;
  try {
    const scaled = await resizeToLabelDpi(raw, 203);
    const prepared = await prepareForPrint(scaled);
    label._printPreviewUrl = prepared;
    label._printPreviewKey = label.base64;
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
