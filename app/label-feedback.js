(function initLabelFeedback(global) {
  "use strict";

  const DEFAULT_MAX_ENTRIES = 1500;
  const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const DEFAULT_DEDUPE_MS = 60 * 1000;

  function pruneFailureLog(log, options = {}) {
    const nowMs = Number(options.nowMs ?? Date.now());
    const retentionMs = Number(options.retentionMs ?? DEFAULT_RETENTION_MS);
    const maxEntries = Number(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    const cutoff = nowMs - retentionMs;
    return (Array.isArray(log) ? log : [])
      .filter((entry) => {
        const timestamp = Date.parse(entry?.at || "");
        return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= nowMs + 60 * 1000;
      })
      .slice(-Math.max(0, maxEntries));
  }

  function failureFingerprint(entry) {
    return [entry?.kind, entry?.fileName, entry?.reason, entry?.page]
      .map((value) => String(value ?? "").trim().toLowerCase())
      .join("|");
  }

  function isDuplicateFailure(log, entry, options = {}) {
    const dedupeMs = Number(options.dedupeMs ?? DEFAULT_DEDUPE_MS);
    const entryTime = Date.parse(entry?.at || "");
    if (!Number.isFinite(entryTime)) return false;
    const fingerprint = failureFingerprint(entry);
    return (Array.isArray(log) ? log : []).some((candidate) => {
      if (failureFingerprint(candidate) !== fingerprint) return false;
      const candidateTime = Date.parse(candidate?.at || "");
      return Number.isFinite(candidateTime) && Math.abs(entryTime - candidateTime) <= dedupeMs;
    });
  }

  function createFailureEntry({ kind, label, fileName, sender, at, eventId }) {
    const width = Number(label?.width || 0);
    const height = Number(label?.height || 0);
    return {
      at: at || new Date().toISOString(),
      eventId: String(eventId || ""),
      kind: String(kind || "unknown"),
      sender: sender?.email || sender?.name || "",
      carrier: label?.carrier || "",
      validated: Boolean(label?.carrierValidated),
      reason: label ? (label.localReason || "unknown") : "no-candidates",
      confidence: label ? Number(label.confidence || 0) : 0,
      size: width && height ? `${width}x${height}` : "",
      aspect: width && height ? Number((width / height).toFixed(3)) : 0,
      page: label?.pageCount ? `${label.sourcePage || 1}/${label.pageCount}` : String(label?.sourcePage || ""),
      fileName: fileName || ""
    };
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function formatFailureLogCsv(log, options = {}) {
    const includePrivate = Boolean(options.includePrivate);
    const columns = [
      ["timestamp", "at"],
      ["event_id", "eventId"],
      ["kind", "kind"],
      ["carrier", "carrier"],
      ["validated", "validated"],
      ["reason", "reason"],
      ["confidence", "confidence"],
      ["size", "size"],
      ["aspect", "aspect"],
      ["page", "page"]
    ];
    if (includePrivate) columns.push(["sender", "sender"], ["file", "fileName"]);
    return [columns.map(([heading]) => heading).join(",")]
      .concat((Array.isArray(log) ? log : []).map((entry) =>
        columns.map(([, key]) => csvCell(entry?.[key])).join(",")))
      .join("\n");
  }

  function oldestFailureDate(log) {
    const timestamps = (Array.isArray(log) ? log : [])
      .map((entry) => Date.parse(entry?.at || ""))
      .filter(Number.isFinite);
    if (!timestamps.length) return "";
    return new Date(Math.min(...timestamps)).toISOString().slice(0, 10);
  }

  function isTrustedLabel(label, hints, trustFloor = 0.90) {
    return Boolean(hints?.printReady) && (
      Boolean(label?.carrierValidated)
      || Number(label?.confidence || 0) >= Number(trustFloor)
    );
  }

  function createFailureLogStore(options = {}) {
    const storage = options.storage;
    const key = options.key || "labelFailureLog";
    const maxEntries = Number(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    const retentionMs = Number(options.retentionMs ?? DEFAULT_RETENTION_MS);
    const dedupeMs = Number(options.dedupeMs ?? DEFAULT_DEDUPE_MS);
    const now = options.now || (() => Date.now());
    const getSenderInfo = options.getSenderInfo || (async () => ({}));
    const createEventId = options.createEventId || (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    let queue = Promise.resolve();

    function enqueue(task) {
      const run = queue.then(task);
      queue = run.catch(() => {});
      return run;
    }

    function requireStorage() {
      if (!storage?.get || !storage?.set) throw new Error("Local extension storage is unavailable.");
      return storage;
    }

    async function readInternal(persistPruned = true, nowMs = Number(now())) {
      const target = requireStorage();
      const data = await target.get(key);
      const original = Array.isArray(data?.[key]) ? data[key] : [];
      const pruned = pruneFailureLog(original, { nowMs, maxEntries, retentionMs });
      if (persistPruned && pruned.length !== original.length) {
        await target.set({ [key]: pruned });
      }
      return pruned;
    }

    return Object.freeze({
      read() {
        return enqueue(() => readInternal(true));
      },
      clear() {
        return enqueue(async () => {
          const target = requireStorage();
          const log = await readInternal(false);
          await target.set({ [key]: [] });
          return { count: log.length };
        });
      },
      record(kind, label, fileName) {
        return enqueue(async () => {
          const target = requireStorage();
          const nowMs = Number(now());
          const sender = await getSenderInfo();
          const entry = createFailureEntry({
            kind,
            label,
            fileName,
            sender,
            at: new Date(nowMs).toISOString(),
            eventId: createEventId()
          });
          const log = await readInternal(false, nowMs);
          if (isDuplicateFailure(log, entry, { dedupeMs })) {
            return { ok: true, recorded: false, duplicate: true };
          }
          log.push(entry);
          await target.set({
            [key]: pruneFailureLog(log, { nowMs, maxEntries, retentionMs })
          });
          return { ok: true, recorded: true, duplicate: false, eventId: entry.eventId };
        });
      }
    });
  }

  const api = Object.freeze({
    DEFAULT_MAX_ENTRIES,
    DEFAULT_RETENTION_MS,
    DEFAULT_DEDUPE_MS,
    pruneFailureLog,
    isDuplicateFailure,
    createFailureEntry,
    formatFailureLogCsv,
    oldestFailureDate,
    isTrustedLabel,
    createFailureLogStore
  });

  global.LabelExtractorFeedback = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
