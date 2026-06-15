(function () {
  "use strict";

  // Optional, no-op-by-default trace sink for the dev training studio (mirrors the
  // one in label-detector.js / model-detector.js). Production never sets it.
  let traceSink = null;
  function setTraceSink(fn) { traceSink = typeof fn === "function" ? fn : null; }
  function clearTrace() { traceSink = null; }
  function trace(stage, payload) {
    if (!traceSink) return;
    try { traceSink({ stage, ...(payload || {}) }); } catch (_) {}
  }

  // Resolve extension assets without chrome.runtime so the dev training studio
  // (plain file/http, no extension context) can decode too. Mirrors assetUrl()
  // in model-detector.js / pdf-processor.js.
  const scriptUrl = (typeof document !== "undefined" && document.currentScript?.src) || "";
  function assetUrl(path) {
    if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
    return new URL(`../${path}`, scriptUrl || (typeof window !== "undefined" ? window.location.href : "")).href;
  }

  // Shipping symbologies only — keeps the decode fast and avoids matching stray
  // retail/EAN codes on packing slips. MaxiCode / QRCode / Aztec are intentionally
  // omitted from the default scan: MaxiCode is by far zxing's slowest decode and
  // UPS already reads via its 1Z Code128, while QR/Aztec mostly hit stray retail
  // codes. Callers that need them can still pass opts.formats. Override per-call.
  const DEFAULT_FORMATS = [
    "Code128", "PDF417", "DataMatrix", "Code39", "ITF"
  ];
  // tryRotate stays ON — real label crops present the barcode at varied angles and
  // it's load-bearing for the 1Z read rate (and usually FASTER overall, since a
  // successful whole-crop decode skips the region-fallback passes). Speed is kept
  // in check by the resolution cap below and by dropping MaxiCode, not by crippling
  // the scan. Symbol cap trimmed from 8 to 4 — we only need the carrier barcode.
  const DEFAULT_READER_OPTIONS = {
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    maxNumberOfSymbols: 4
  };

  // zxing decode time scales with pixel count, and a 4x6 label rendered at 3x DPI
  // is ~2500x3800 — far more than a barcode needs. Cap the longest side so a
  // single decode stays fast (and bounded) no matter the source resolution.
  const MAX_DECODE_DIM = 1600;

  // The reader (~38 KB JS + ~1.06 MB wasm) is only needed when the cascade wants
  // to confirm a candidate. Load it on first use, never at panel open — mirrors
  // how ensureOrt() lazy-loads the ONNX runtime in model-detector.js.
  let zxingLoadPromise = null;
  let zxingReady = false;

  function ensureZXing() {
    if (zxingReady && globalThis.ZXingReader) return Promise.resolve(globalThis.ZXingReader);
    if (zxingLoadPromise) return zxingLoadPromise;
    zxingLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = assetUrl("lib/zxing-reader.js");
      script.onload = async () => {
        try {
          // Point the reader at the local wasm — the analog of
          // ort.env.wasm.wasmPaths = assetUrl("lib/") in model-detector.js.
          await globalThis.ZXingReader.prepareZXingModule({
            overrides: {
              locateFile: (path, prefix) =>
                path.endsWith(".wasm") ? assetUrl("lib/zxing_reader.wasm") : ((prefix || "") + path)
            },
            fireImmediately: true
          });
          zxingReady = true;
          trace("barcode-runtime", { loaded: true });
          resolve(globalThis.ZXingReader);
        } catch (err) {
          zxingLoadPromise = null;
          trace("barcode-runtime", { loaded: false, error: String(err && err.message || err) });
          reject(err);
        }
      };
      script.onerror = () => {
        zxingLoadPromise = null;
        reject(new Error("Barcode reader could not load."));
      };
      document.head.append(script);
    });
    return zxingLoadPromise;
  }

  // Labels are white; phone screenshots / pasted PNGs occasionally carry an alpha
  // channel where transparent pixels read as black and wipe out the bars. Flatten
  // onto white before decoding. No-op (and no allocation) when already opaque.
  function compositeOnWhite(imageData) {
    const { data, width, height } = imageData;
    let hasAlpha = false;
    for (let i = 3; i < data.length; i += 4) { if (data[i] !== 255) { hasAlpha = true; break; } }
    if (!hasAlpha) return imageData;
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      out[i]     = Math.round(data[i]     * a + 255 * (1 - a));
      out[i + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
      out[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
      out[i + 3] = 255;
    }
    return { data: out, width, height };
  }

  // Downscale a too-large decode input so a single zxing pass stays fast. No-op
  // when already within MAX_DECODE_DIM. Uses high-quality smoothing so barcode
  // bars stay clean at the reduced size.
  function capImageDataSize(image, maxDim) {
    const cap = maxDim || MAX_DECODE_DIM;
    const longest = Math.max(image.width, image.height);
    if (longest <= cap) return image;
    const scale = cap / longest;
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const src = document.createElement("canvas");
    src.width = image.width; src.height = image.height;
    src.getContext("2d", { willReadFrequently: true })
      .putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    const dst = document.createElement("canvas");
    dst.width = w; dst.height = h;
    const ctx = dst.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  // Pure-pixel crop so a region decode never needs a canvas. rect is in source
  // pixels {x, y, width, height}; values are clamped to the image bounds.
  function cropImageData(imageData, rect) {
    const { data, width, height } = imageData;
    const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
    const w = Math.max(1, Math.min(width - x, Math.round(rect.width)));
    const h = Math.max(1, Math.min(height - y, Math.round(rect.height)));
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row += 1) {
      const srcStart = ((y + row) * width + x) * 4;
      out.set(data.subarray(srcStart, srcStart + w * 4), row * w * 4);
    }
    return { data: out, width: w, height: h };
  }

  // ── Carrier classification ────────────────────────────────────────────────
  //
  // Three tiers, strongest first:
  //   1. ts-tracking-number (bundled as window.TrackingNumber) — the community
  //      jkeen/tracking_number_data regexes WITH check-digit validation. This is
  //      what rejects an order number that merely looks like a tracking number.
  //   2. Symbology / prefix signatures the dataset doesn't cover (MaxiCode → UPS,
  //      Amazon TBA, PDF417 numeric → USPS).
  //   3. Bare-numeric fallback (not confident) so the carrier badge can still
  //      show a guess without being trusted upstream.

  function mk(carrier, confident, trackingUrl, extra) {
    return { carrier, confident, trackingUrl: trackingUrl || null, trackingNumber: null, validated: false, ...(extra || {}) };
  }

  // Normalize whatever shape the bundled ts-tracking-number exposes. The package
  // has shipped both getTracking(value) → Tracking|undefined and
  // findTracking(text) → Tracking[] across versions; support both, plus a
  // possible default export, and fail closed (null) if the bundle is absent.
  function validatedCarrier(raw) {
    const lib = globalThis.TrackingNumber;
    if (!lib) return null;
    let hit = null;
    try {
      const get = lib.getTracking || lib.default?.getTracking;
      const find = lib.findTracking || lib.default?.findTracking;
      if (get) hit = get(raw);
      if (!hit && find) hit = (find(raw) || [])[0];
    } catch (_) {
      return null;
    }
    if (!hit) return null;
    const courier = hit.courier || hit.carrier || {};
    const name = normalizeCarrierName(courier.name || courier.code || hit.courierCode || "");
    if (!name) return null;
    // ts-tracking-number's trackingUrl is a TEMPLATE with a %s placeholder, not a
    // ready URL — fill it, then fall back to our own builder if it had none.
    const tracking = hit.trackingNumber || raw;
    const filled = hit.trackingUrl ? String(hit.trackingUrl).replace(/%s/g, encodeURIComponent(tracking)) : null;
    return mk(name, true, filled || trackingUrlFor(name, raw), {
      trackingNumber: tracking,
      validated: true
    });
  }

  function normalizeCarrierName(name) {
    const v = String(name || "").toLowerCase();
    if (!v) return null;
    if (v.includes("ups")) return "UPS";
    if (v.includes("usps") || v.includes("postal")) return "USPS";
    if (v.includes("fedex") || v.includes("federal express")) return "FedEx";
    if (v.includes("dhl")) return "DHL";
    if (v.includes("amazon")) return "Amazon";
    if (v.includes("ontrac")) return "OnTrac";
    if (v.includes("s10")) return "Postal";
    // Title-case anything else the dataset names (e.g. a national post).
    return String(name).replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function trackingUrlFor(carrier, t) {
    switch (carrier) {
      case "UPS": return `https://www.ups.com/track?tracknum=${t}`;
      case "USPS": return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
      case "FedEx": return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
      case "DHL": return `https://www.dhl.com/en/express/tracking.html?AWB=${t}`;
      default: return null;
    }
  }

  function classifyCarrier(text, format) {
    const raw = String(text || "");
    const t = raw.replace(/\s+/g, "").toUpperCase();

    // Tier 1 — validated lookup (check digits). ONLY for a single clean code:
    // ts-tracking-number strips punctuation and will otherwise swallow a
    // structured PDF417 / multi-AI GS1 string and hand back the whole blob as the
    // "tracking number", pre-empting the precise FedEx/USPS parsing below.
    const validated = /^[0-9A-Z]{8,26}$/.test(t) ? validatedCarrier(t) : null;
    if (validated) return validated;

    // UPS 1Z (Code128 / MaxiCode).
    if (/^1Z[0-9A-Z]{16}$/.test(t)) return mk("UPS", true, trackingUrlFor("UPS", t), { trackingNumber: t });
    if (format === "MaxiCode") return mk("UPS", true, null);

    // FedEx — its structured PDF417 ("[)>…FDE…FDX…" data-identifier format) names
    // the carrier, and its ship barcode is a 30–34 digit Code128 whose LAST 12
    // digits are the human tracking number. The 9[1-5] guard hands long USPS IMpb
    // codes to the USPS branch instead (FedEx Ground starts 96, not 91–95).
    if (format === "PDF417" && /\bFDE\b|\bFDX\b|FEDEX|FDEG/.test(t)) {
      return mk("FedEx", true, trackingUrlFor("FedEx", fedexTrackingFromPdf(t)), { trackingNumber: fedexTrackingFromPdf(t) });
    }
    if ((format === "Code128" || format === "ITF") && /^\d{30,34}$/.test(t) && !/^9[1-5]/.test(t)) {
      const tn = t.slice(-12);
      return mk("FedEx", true, trackingUrlFor("FedEx", tn), { trackingNumber: tn });
    }

    // Amazon / DHL prefixes.
    if (/^TBA\d{12,}$/.test(t)) return mk("Amazon", true, null, { trackingNumber: t });
    if (/^JJD\d{14,20}$/.test(t) || /^JD\d{16,20}$/.test(t))
      return mk("DHL", true, trackingUrlFor("DHL", t), { trackingNumber: t });

    // USPS — GS1 (420)/(9x) IMpb (incl. the human-readable (AI) form zxing emits),
    // or a bare 9x IMpb numeric.
    const gs1 = parseGs1(t, format);
    if (gs1?.carrier) return mk(gs1.carrier, true, gs1.trackingUrl, { trackingNumber: gs1.trackingNumber || t, gs1: gs1.fields });
    if (/^(94|93|92|95|91|82)\d{18,24}$/.test(t)) return mk("USPS", true, trackingUrlFor("USPS", t), { trackingNumber: t });

    // Tier 3 — bare numeric guess (NOT confident; an order number can match).
    if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t) || /^\d{20}$/.test(t) || /^\d{22}$/.test(t))
      return mk("FedEx", false, trackingUrlFor("FedEx", t), { trackingNumber: t });
    return mk(null, false, null);
  }

  // FedEx's PDF417 carries the 12-digit tracking inside its 30–34 digit routing
  // field; fall back to any 12–15 digit run, taking its last 12.
  function fedexTrackingFromPdf(t) {
    const routing = t.match(/\d{30,34}/);
    if (routing) return routing[0].slice(-12);
    const run = t.match(/\d{12,15}/);
    return run ? run[0].slice(-12) : "";
  }

  // ── GS1 / IMpb field parse (#5) ───────────────────────────────────────────
  //
  // USPS IMpb and many carrier 1D codes are GS1-128 (Code128 with FNC1 group
  // separators) carrying Application Identifiers. zxing surfaces FNC1 as the
  // GS (\x1d) char or a leading "]C1" symbology id. Pull the AIs we care about:
  //   (420) ship-to ZIP5, (92x) routing, plus the long numeric tracking string.
  // Best-effort and defensive — returns null when the string isn't GS1-shaped.
  const FIXED_AI_LEN = { "00": 18, "01": 14, "420": 5 };

  function parseGs1(text, format) {
    if (format !== "Code128" && format !== "DataMatrix" && format !== "ITF") return null;
    let s = String(text || "");
    if (s.startsWith("]C1") || s.startsWith("]d2") || s.startsWith("]e0")) s = s.slice(3);
    const GS = "";
    const hasFnc1 = s.includes(GS) || /^\(?\d{2,4}\)?/.test(s);
    if (!hasFnc1) return null;

    const fields = {};
    // Human-readable (AI) form e.g. "(420)90220(94)9405..." — put the separator
    // BEFORE each AI so "(94)…" starts a new segment instead of trailing the ZIP.
    let rest = s.replace(/\((\d{2,4})\)/g, GS + "$1");
    const segments = rest.split(GS).filter(Boolean);
    for (let seg of segments) {
      // Pull a leading AI off each FNC1-delimited segment.
      const ai2 = seg.slice(0, 2);
      const ai3 = seg.slice(0, 3);
      if (ai3 === "420") { fields["420"] = seg.slice(3, 3 + FIXED_AI_LEN["420"]); continue; }
      if (ai2 === "00" || ai2 === "01") { fields[ai2] = seg.slice(2, 2 + FIXED_AI_LEN[ai2]); continue; }
      if (/^9[1-5]/.test(ai2)) { fields[ai2] = seg.slice(2); continue; }
    }
    if (!Object.keys(fields).length) return null;

    // A bare (420)ZIP is destination routing that UPS / FedEx / USPS all print —
    // NOT a carrier signal on its own. (The studio A/B caught this misreading a
    // UPS fold-here label as USPS.) Only a USPS IMpb channel AI (91–95) with a
    // full-length payload identifies the carrier; the ZIP stays as metadata.
    // The USPS tracking number INCLUDES its leading 9x channel digits (a label's
    // "9405 5…" is the whole barcode), so keep the routing segment intact.
    const routing = segments.find((seg) => /^9[1-5]\d{18,}/.test(seg)) || "";
    const isUsps = Boolean(routing);
    const trackingNumber = routing || null;
    return {
      carrier: isUsps ? "USPS" : null,
      trackingUrl: isUsps && trackingNumber ? trackingUrlFor("USPS", trackingNumber) : null,
      trackingNumber,
      fields
    };
  }

  function normalizeResults(raw) {
    return (raw || []).map((r) => {
      const carrier = classifyCarrier(r.text, r.format);
      return {
        format: r.format,
        text: r.text,
        carrier: carrier.carrier,
        carrierConfident: carrier.confident,
        trackingNumber: carrier.trackingNumber || null,
        trackingUrl: carrier.trackingUrl,
        validated: carrier.validated || false,
        gs1: carrier.gs1 || null,
        corners: r.position || null
      };
    });
  }

  // True when any decoded symbol is a confident carrier signature OR a symbology
  // that effectively only appears on real shipping labels (MaxiCode / PDF417).
  // This is the signal the cascade uses to confirm/boost a candidate and reject
  // packing slips whose only barcode is an order number.
  function isCarrierLabelSignal(results) {
    return (results || []).some((r) =>
      r.carrierConfident || r.format === "MaxiCode" || r.format === "PDF417"
    );
  }

  // The strongest single decoded result (a confident carrier wins over a bare
  // numeric guess; ties keep the first). Convenience for the cascade.
  function bestCarrierResult(results) {
    let best = null;
    for (const r of results || []) {
      const rank = (r.carrierConfident ? 2 : 0) + (r.validated ? 1 : 0);
      if (!best || rank > best.rank) best = { rank, result: r };
    }
    return best ? best.result : null;
  }

  // Decode straight from ImageData (what the crop pipeline produces). opts:
  //   { rect, formats, readerOptions } — rect crops a region first; formats
  //   overrides DEFAULT_FORMATS; readerOptions is merged into the defaults.
  async function decodeImageData(imageData, opts = {}) {
    if (!imageData || !imageData.data || !imageData.width) return [];
    const reader = await ensureZXing().catch((err) => {
      trace("barcode-decode", { ok: false, error: String(err && err.message || err) });
      return null;
    });
    if (!reader) return [];

    let image = imageData;
    if (opts.rect) image = cropImageData(image, opts.rect);
    image = compositeOnWhite(image);
    image = capImageDataSize(image, opts.maxDim);

    const readerOptions = {
      ...DEFAULT_READER_OPTIONS,
      formats: opts.formats || DEFAULT_FORMATS,
      ...(opts.readerOptions || {})
    };

    let raw;
    try {
      raw = await reader.readBarcodesFromImageData(image, readerOptions);
    } catch (err) {
      trace("barcode-decode", { ok: false, error: String(err && err.message || err) });
      return [];
    }
    const results = normalizeResults(raw);
    trace("barcode-decode", {
      ok: true,
      count: results.length,
      carrierSignal: isCarrierLabelSignal(results),
      carriers: results.map((r) => r.carrier).filter(Boolean),
      formats: results.map((r) => r.format),
      texts: results.map((r) => r.text)
    });
    return results;
  }

  // Convenience: accept a canvas or an ImageData. A canvas region read uses
  // getImageData so callers that already hold a canvas don't have to convert.
  async function decode(source, opts = {}) {
    if (source && typeof source.getContext === "function") {
      const rect = opts.rect || { x: 0, y: 0, width: source.width, height: source.height };
      const ctx = source.getContext("2d", { willReadFrequently: true });
      const id = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
      return decodeImageData(id, { ...opts, rect: undefined });
    }
    return decodeImageData(source, opts);
  }

  async function warmUp() {
    try { await ensureZXing(); } catch (_) {}
  }

  // In-extension smoke test: decodes an embedded Code128 ("1Z999AA10123456784")
  // through the real ImageData path. Resolves { ok, format, text } — call once
  // from the side panel console to confirm the wasm instantiates under MV3 CSP.
  async function selfTest() {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAMUAAAAgCAYAAACisbzBAAAAHnRFWHRTb2Z0d2FyZQBid2lwLWpzLm1ldGFmbG9vci5jb21Tnbi0AAAA+klEQVR4nO3TUQrCMBAE0Nz/0goFoW430/hRtPgGBGnSNDvwxkNE3jK+fQGRXwsUIiVQiJQcUIwxtt/r//55t7e+1z3r1uve/Xmzs7r3rtzbzX1279W9q52l7lKfK2vderd29k4322q/aZ5Zj5/MujLT4c7dEFBAAUVzQHex2cDdh2eXhQKK1AMUUEABBRRQ5B6ggAIKKKCAIvcABRRQQAEFFLkHKKCAAgoooMg9QAEFFFBAAUXuAQoooIACCihyD1BAAQUUUECRe4ACCiiggAKK3AMUUEABBRRQ5B6ggAIKKKCAIvcABRRQ3AGFyL8HCpESKERKoBApeQJmQh27FUL0UAAAAABJRU5ErkJggg==";
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const r = await decodeImageData(id, { formats: ["Code128"] });
      const ok = r.length > 0 && r[0].text === "1Z999AA10123456784";
      return { ok, format: r[0]?.format || null, text: r[0]?.text || null, carrier: r[0]?.carrier || null, validated: r[0]?.validated || false };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  window.LabelExtractorBarcode = {
    decode,
    decodeImageData,
    classifyCarrier,
    parseGs1,
    isCarrierLabelSignal,
    bestCarrierResult,
    compositeOnWhite,
    cropImageData,
    warmUp,
    selfTest,
    // Dev training studio hooks (no-op in production):
    setTraceSink,
    clearTrace
  };
})();
