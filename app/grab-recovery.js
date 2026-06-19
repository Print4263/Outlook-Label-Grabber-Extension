(function initGrabRecovery(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LabelExtractorGrabRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createGrabRecoveryApi() {
  "use strict";

  const ARRIVAL_TIMEOUT_MS = 6000;
  const COMPLETION_TIMEOUT_MS = 45000;
  const MAX_ATTEMPT_AGE_MS = 2 * 60 * 1000;
  const START_TIME_SLOP_MS = 1500;
  const SUPPORTED_FILE = /\.(pdf|png|jpe?g|gif|webp|hei[cf])$/i;

  function beginAttempt(options = {}) {
    const now = finiteNumber(options.now, Date.now());
    return {
      id: Number(options.id || 0),
      status: "looking",
      reason: "",
      detail: "",
      startedAt: now,
      acceptedAt: 0,
      downloadDetectedAt: 0,
      completedAt: 0,
      expectedFileName: "",
      downloadId: null,
      baselineIds: Array.from(options.baselineIds || [], Number).filter(Number.isFinite)
    };
  }

  function acceptAttempt(attempt, options = {}) {
    if (!attempt) return null;
    return {
      ...attempt,
      status: attempt.status === "looking" ? "awaiting-download" : attempt.status,
      acceptedAt: finiteNumber(options.now, Date.now()),
      expectedFileName: basename(options.expectedFileName || attempt.expectedFileName || "")
    };
  }

  function failAttempt(attempt, detail = "") {
    if (!attempt) return null;
    return {
      ...attempt,
      status: "recovery",
      reason: "outlook-failed",
      detail: String(detail || "")
    };
  }

  function noteDownloadCreated(attempt, download, now = Date.now()) {
    if (!matchesDownload(attempt, download, now)) return attempt;
    const complete = download?.state === "complete";
    return {
      ...attempt,
      status: complete ? "complete" : "downloading",
      reason: "",
      detail: "",
      downloadId: Number(download.id),
      downloadDetectedAt: finiteNumber(attempt.downloadDetectedAt, 0) || finiteNumber(now, Date.now()),
      completedAt: complete ? finiteNumber(now, Date.now()) : 0
    };
  }

  function noteDownloadChanged(attempt, delta, now = Date.now()) {
    if (!attempt || Number(delta?.id) !== Number(attempt.downloadId)) return attempt;
    if (delta?.error?.current || delta?.state?.current === "interrupted") {
      return {
        ...attempt,
        status: "recovery",
        reason: "download-interrupted",
        detail: String(delta?.error?.current || "The Chrome download was interrupted.")
      };
    }
    if (delta?.state?.current !== "complete") return attempt;
    return {
      ...attempt,
      status: "complete",
      reason: "",
      detail: "",
      completedAt: finiteNumber(now, Date.now())
    };
  }

  function reconcileCompletedDownloads(attempt, downloads, now = Date.now()) {
    if (!attempt) return null;
    const match = (downloads || []).find((download) => matchesDownload(attempt, download, now));
    return match ? noteDownloadCreated(attempt, { ...match, state: "complete" }, now) : attempt;
  }

  function checkTimeout(attempt, now = Date.now()) {
    if (!attempt || attempt.status === "complete") return attempt;
    const current = finiteNumber(now, Date.now());
    if (current - attempt.startedAt > MAX_ATTEMPT_AGE_MS) {
      return { ...attempt, status: "expired", reason: "attempt-expired" };
    }
    if ((attempt.status === "looking" || attempt.status === "awaiting-download")
      && current - attempt.startedAt >= ARRIVAL_TIMEOUT_MS) {
      return { ...attempt, status: "recovery", reason: "no-download", detail: "" };
    }
    if (attempt.status === "downloading"
      && attempt.downloadDetectedAt
      && current - attempt.downloadDetectedAt >= COMPLETION_TIMEOUT_MS) {
      return { ...attempt, status: "recovery", reason: "download-slow", detail: "" };
    }
    return attempt;
  }

  function matchesDownload(attempt, download, now = Date.now()) {
    if (!attempt || attempt.status === "complete" || attempt.status === "expired") return false;
    const id = Number(download?.id);
    const filename = basename(download?.filename || "");
    if (!Number.isFinite(id) || !SUPPORTED_FILE.test(filename)) return false;
    if (attempt.baselineIds.includes(id)) return false;
    if (finiteNumber(now, Date.now()) - attempt.startedAt > MAX_ATTEMPT_AGE_MS) return false;

    const downloadStartedAt = Date.parse(download?.startTime || "");
    if (Number.isFinite(downloadStartedAt) && downloadStartedAt < attempt.startedAt - START_TIME_SLOP_MS) return false;

    const expected = canonicalFileName(attempt.expectedFileName);
    if (expected && canonicalFileName(filename) !== expected) return false;
    return true;
  }

  function canonicalFileName(value) {
    return basename(value)
      .toLowerCase()
      .replace(/\s*\(\d+\)(?=\.[^.]+$)/, "");
  }

  function basename(value) {
    return String(value || "").split(/[\\/]/).pop() || "";
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  return {
    ARRIVAL_TIMEOUT_MS,
    COMPLETION_TIMEOUT_MS,
    MAX_ATTEMPT_AGE_MS,
    beginAttempt,
    acceptAttempt,
    failAttempt,
    noteDownloadCreated,
    noteDownloadChanged,
    reconcileCompletedDownloads,
    checkTimeout,
    matchesDownload,
    canonicalFileName
  };
});
