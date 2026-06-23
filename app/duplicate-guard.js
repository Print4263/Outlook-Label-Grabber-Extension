// Duplicate-print protection: a small, pure helper that fingerprints a
// print-ready label and checks it against a short-lived history of recently
// printed labels. Plain (non-module) script exposing window.LabelExtractorDuplicateGuard;
// also CommonJS-exported so dev/duplicate-guard-tests.js can require it directly.
//
// The goal is to catch accidental re-prints — especially B2B labels that staff
// download and print twice — before a duplicate shipment goes out. A decoded
// carrier tracking number is the strongest signal; when none decodes (common on
// B2B labels) we fall back to a hash of the exact print image, so two downloads
// of the identical label still collide on the same fingerprint.
(function initDuplicateGuard(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LabelExtractorDuplicateGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDuplicateGuardApi() {
  "use strict";

  // How long a printed label keeps "blocking" a re-print. Long enough to cover a
  // realistic mistaken re-download/re-print of the same order, short enough that a
  // genuinely new same-tracking reship later in the shift is not flagged forever.
  const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
  const DEFAULT_MAX_ENTRIES = 40;
  const DEFAULT_DAILY_MAX_ENTRIES = 80;
  const MIN_TRACKING_LENGTH = 8;

  function normalizeTracking(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // Fast, allocation-light 32-bit FNV-1a over the complete print image. This
  // runs only at print time; reading the full string avoids blind spots where
  // two same-length labels differ only between sampled characters.
  function hashString(value) {
    const str = String(value || "");
    const len = str.length;
    if (!len) return "0:0";
    let h = 0x811c9dc5;
    for (let i = 0; i < len; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${(h >>> 0).toString(36)}:${len.toString(36)}`;
  }

  function hashBytes(value) {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(0);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return `${(h >>> 0).toString(36)}:${bytes.length.toString(36)}`;
  }

  // Build the duplicate fingerprint for a label + its print-ready data URL.
  function fingerprintLabel(label = {}, printUrl = "") {
    const tracking = normalizeTracking(label.trackingNumber);
    const name = String(label.name || label.variantName || "label");
    if (tracking.length >= MIN_TRACKING_LENGTH) {
      return { key: `trk:${tracking}`, kind: "tracking", tracking, name };
    }
    return { key: `img:${hashString(printUrl)}`, kind: "image", tracking: "", name };
  }

  function fingerprintSourceBytes(value) {
    return { key: `src:${hashBytes(value)}`, kind: "source" };
  }

  function pruneHistory(history, options = {}) {
    const now = Number(options.now != null ? options.now : Date.now());
    const windowMs = Number(options.windowMs != null ? options.windowMs : DEFAULT_WINDOW_MS);
    return (Array.isArray(history) ? history : []).filter((entry) => {
      if (!entry || !entry.key) return false;
      const printedAt = Number(entry.printedAt);
      const age = now - printedAt;
      return Number.isFinite(printedAt) && age >= 0 && age <= windowMs;
    });
  }

  // Returns the matching prior-print entry (within the window) or null.
  function findDuplicate(history, fingerprint, options = {}) {
    if (!fingerprint || !fingerprint.key) return null;
    const fresh = pruneHistory(history, options);
    return fresh.find((entry) => entry.key === fingerprint.key) || null;
  }

  // Returns a new history array with this fingerprint recorded, pruned to the
  // window and capped at `max`. Replaces any earlier entry with the same key so a
  // confirmed re-print refreshes the timestamp instead of stacking duplicates.
  function recordPrint(history, fingerprint, options = {}) {
    const pruned = pruneHistory(history, options);
    if (!fingerprint || !fingerprint.key) return pruned;
    const now = Number(options.now != null ? options.now : Date.now());
    const max = Math.max(1, Number(options.max != null ? options.max : DEFAULT_MAX_ENTRIES));
    const fresh = pruned.filter((entry) => entry.key !== fingerprint.key);
    fresh.push({
      key: fingerprint.key,
      kind: fingerprint.kind || "image",
      tracking: fingerprint.tracking || "",
      name: fingerprint.name || "label",
      printedAt: now
    });
    return fresh.slice(-max);
  }

  function startOfLocalDay(now = Date.now()) {
    const date = new Date(Number(now));
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function pruneDailyHistory(history, options = {}) {
    const now = Number(options.now != null ? options.now : Date.now());
    const dayStart = startOfLocalDay(now);
    return (Array.isArray(history) ? history : []).filter((entry) => {
      if (!entry || !entry.key) return false;
      const printedAt = Number(entry.printedAt);
      return Number.isFinite(printedAt) && printedAt >= dayStart && printedAt <= now;
    });
  }

  function findPrintedToday(history, fingerprint, options = {}) {
    if (!fingerprint?.key) return null;
    return pruneDailyHistory(history, options).find((entry) => entry.key === fingerprint.key) || null;
  }

  function recordPrintedToday(history, fingerprint, options = {}) {
    const fresh = pruneDailyHistory(history, options);
    if (!fingerprint?.key) return fresh;
    const now = Number(options.now != null ? options.now : Date.now());
    const max = Math.max(1, Number(options.max != null ? options.max : DEFAULT_DAILY_MAX_ENTRIES));
    return fresh
      .filter((entry) => entry.key !== fingerprint.key)
      .concat({ key: fingerprint.key, printedAt: now })
      .slice(-max);
  }

  function assessDownloadReplacement(options = {}) {
    const hasCurrent = options.hasCurrent === true;
    const currentPrintedAt = Number(options.currentPrintedAt || 0);
    const incomingPrintedAt = Number(options.incomingPrintedAt || 0);
    return {
      currentState: hasCurrent ? (currentPrintedAt > 0 ? "printed-today" : "unprinted") : "none",
      incomingState: incomingPrintedAt > 0 ? "printed-today" : "new",
      requiresConfirmation: hasCurrent || incomingPrintedAt > 0
    };
  }

  return {
    DEFAULT_WINDOW_MS,
    DEFAULT_MAX_ENTRIES,
    DEFAULT_DAILY_MAX_ENTRIES,
    MIN_TRACKING_LENGTH,
    normalizeTracking,
    hashString,
    hashBytes,
    fingerprintLabel,
    fingerprintSourceBytes,
    pruneHistory,
    findDuplicate,
    recordPrint,
    startOfLocalDay,
    pruneDailyHistory,
    findPrintedToday,
    recordPrintedToday,
    assessDownloadReplacement
  };
});
