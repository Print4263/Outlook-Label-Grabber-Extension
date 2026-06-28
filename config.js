const LabelExtractorConfig = {
  MAX_UPLOAD_BYTES: 35 * 1024 * 1024,
  SUPPORTED_TYPES: [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif"
  ],

  // Phase 1 — barcode-decode confirmation (detection/barcode-decoder.js).
  //   ENRICH  decode the top candidate's barcode and stamp carrier/tracking/GS1
  //           metadata onto it (NO ranking change — pure information). ON by
  //           default: it powers the carrier+tracking badge in the panel and
  //           cannot change which label is chosen, so it is regression-safe.
  //   RERANK  let a confident, check-digit-validated carrier barcode promote a
  //           near-tie candidate that has one over a top candidate that doesn't.
  //           OFF by default (it can change the chosen label) — A/B it in the
  //           studio before enabling. Override either via the hooks below.
  BARCODE: {
    ENRICH: true,
    RERANK: false,
    RERANK_SCORE_WINDOW: 1.5   // max rank-score gap a decoded carrier may close
  }
};

// Let the studio / DevTools console flip the flags without editing this file:
//   localStorage.setItem("LX_BARCODE", JSON.stringify({ ENRICH: true, RERANK: true }))
// or set window.__LX_BARCODE = { ENRICH: true } before a run. Never throws.
//
// ENRICH is information-only and safe to override anywhere. RERANK can change WHICH
// label is chosen, so a forgotten localStorage/window flag must not silently alter
// the shipped side panel: a RERANK override is honored only in a dev context (the
// Studio and dev/ harness pages), never in the production panel. To enable RERANK in
// production, change the default above on purpose.
(function applyBarcodeOverrides() {
  const isDevContext = typeof location !== "undefined"
    && /\/dev\//.test(location.pathname || "");

  function applyOverride(override) {
    if (!override || typeof override !== "object") return;
    const safe = { ...override };
    if (!isDevContext && "RERANK" in safe) delete safe.RERANK;
    Object.assign(LabelExtractorConfig.BARCODE, safe);
  }

  try {
    const stored = globalThis.localStorage && JSON.parse(localStorage.getItem("LX_BARCODE") || "null");
    applyOverride(stored);
  } catch (_) {}
  applyOverride(globalThis.__LX_BARCODE);
})();
