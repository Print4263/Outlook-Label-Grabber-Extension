(function () {
  "use strict";

  // Optional, no-op-by-default trace sink for the dev training studio. Production
  // never sets it, so trace() is a single null check and costs nothing. It never
  // throws — a broken sink must not break detection.
  let traceSink = null;
  function setTraceSink(fn) { traceSink = typeof fn === "function" ? fn : null; }
  function clearTrace() { traceSink = null; }
  function trace(stage, payload) {
    if (!traceSink) return;
    try { traceSink({ stage, ...(payload || {}) }); } catch (_) {}
  }

  const KEYWORDS = [
    "USPS TRACKING",
    "UPS TRACKING",
    "FEDEX TRACKING",
    "SHIP TO",
    "SHIP FROM",
    "USPS GROUND ADVANTAGE",
    "UPS GROUND",
    "PRIORITY MAIL",
    "RETURN LABEL",
    "RETURN MAILING LABEL",
    "USPS",
    "UPS",
    "FEDEX",
    "DHL",
    "GROUND ADVANTAGE"
  ];
  const FASHION_NOVA_PATTERN = /\bFASHION\s*NOVA\b/i;
  const FASHION_NOVA_COMPACT_PATTERNS = [
    /FASHI[O0]NN[O0]VA/,
    /FASHI[O0]N[O0]VA/,
    /FASHI[O0][O0]VA/
  ];
  const LABEL_FRAME_MIN_ASPECT = 0.42;
  const LABEL_FRAME_MAX_ASPECT = 2.4;
  const ONLINE_RETURN_LABEL_ASPECT = 1200 / 1800;
  const ONLINE_RETURN_TOP_TRIM_RATIO = 0;
  const ONLINE_RETURN_BOTTOM_PAD_RATIO = 0.12;
  const dashedBorderCache = new WeakMap();
  // Memoizes the default-grid barcode scan per canvas. The cascade asks the same
  // page.canvas for its barcode regions from many detectors; without this each
  // call repeats a full getImageData + transition scan.
  const barcodeRegionCache = new WeakMap();
  // Memoizes the raw RGBA pixel buffer per canvas. getImageData on a full source
  // page is one of the most expensive operations in the cascade, and several
  // detectors (border scans, barcode grid, snap scoring) each re-read the same
  // canvas. Share one read instead.
  const canvasDataCache = new WeakMap();
  const BARCODE_EXCLUSION_PENALTY = -5;

  function getCanvasData(canvas) {
    // Prefer the shared snapshot in crop-engine so the same canvas isn't read
    // back and held in memory once per module.
    const shared = window.LabelExtractorCrop?.pixelsFor;
    if (shared) return shared(canvas);
    let data = canvasDataCache.get(canvas);
    if (data) return data;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    canvasDataCache.set(canvas, data);
    return data;
  }
  const EMBEDDED_USPS_BORDER_OVERRIDE_CONFIDENCE = 0.97;

  async function detectPdfPages(pages) {
    const candidates = await detectPdfCandidates(pages);
    return candidates[0] || emptyPdfResult(pages);
  }

  async function detectPdfCandidates(pages) {
    if (!pages.length) return [];

    const candidates = [];
    const onlineReturnCenterDocument = isOnlineReturnCenterDocument(pages);

    // Records how many candidates the last stage added, for the studio log.
    let mark = 0;
    const stage = (detector, extra) => {
      trace("stage", { detector, produced: candidates.length - mark, total: candidates.length, ...(extra || {}) });
      mark = candidates.length;
    };
    trace("run-start", { path: "pdf", pages: pages.length, onlineReturnCenterDocument });

    const embeddedUspsHit = onlineReturnCenterDocument ? null : await embeddedUspsLabelDetection(pages);
    if (embeddedUspsHit) candidates.push(embeddedUspsHit);
    stage("embedded-usps", { skipped: onlineReturnCenterDocument });

    const embeddedImageHits = await embeddedImageLabelDetections(pages);
    candidates.push(...embeddedImageHits);
    stage("embedded-image");

    candidates.push(...await dashedBorderLabelDetections(pages));
    stage("dashed-border");
    candidates.push(...await solidBorderLabelDetections(pages));
    stage("solid-border");

    const foldHereHit = await foldHereLabelDetection(pages);
    if (foldHereHit && isUpsLabelText(findPage(pages, foldHereHit.pageIndex)?.text)) {
      trace("early-exit", { detector: "fold-here", reason: foldHereHit.reason, confidence: Number(foldHereHit.confidence || 0), note: "UPS fold-here sheet forced as sole result" });
      return [foldHereHit];
    }
    if (foldHereHit) candidates.push(foldHereHit);
    stage("fold-here");

    const labelSizedHit = await labelSizedPageDetection(pages);
    if (labelSizedHit) candidates.push(labelSizedHit);
    stage("label-sized");

    const rankedEarly = rankedDetections(candidates, pages);
    const strongEarly = rankedEarly[0];
    if (Number(strongEarly?.confidence || 0) >= 0.95
      && !shouldPreferCarrierText(strongEarly, pages)
      && !isTallOverstuffedBorder(strongEarly, pages)
      && cropContainsBarcodeOrUnknown(strongEarly, pages)) {
      trace("early-exit", { detector: strongEarly.reason, reason: strongEarly.reason, confidence: Number(strongEarly.confidence || 0), score: detectionRankScore(strongEarly), note: "deterministic hit >=0.95 short-circuited the ONNX model" });
      // Same speed win (model + later stages skipped), but keep the other
      // candidates computed so far: when the strong hit boxes the wrong region
      // (e.g. a dashed frame around instructions + label), the picker still
      // offers the alternatives instead of a single take-it-or-leave-it crop.
      return rankedEarly;
    }

    const modelScope = modelInferencePageScope(candidates, pages);
    const modelHit = modelScope.skip ? null : await trainedModelDetection(pages, modelScope.pageIndexes);
    if (modelHit) candidates.push(modelHit);
    stage("trained-model", { available: Boolean(window.LabelExtractorModelDetector), scope: modelScope.note });

    const fashionNovaHit = await fashionNovaLowerBarcodeDetection(pages);
    if (fashionNovaHit) candidates.push(fashionNovaHit);
    stage("fashion-nova");

    const lowerLabelHit = await lowerContentLabelDetection(pages);
    if (lowerLabelHit) candidates.push(lowerLabelHit);
    stage("lower-content");

    const keywordHit = await keywordDetection(pages);
    if (keywordHit) candidates.push(keywordHit);
    stage("keywords");

    const barcodeHit = await barcodeDetection(pages);
    if (barcodeHit) candidates.push(barcodeHit);
    stage("barcode");

    // The page fallbacks cost a full-page content scan + crop chain per page,
    // and their low-confidence whole-page candidates never outrank a solid
    // detection — they only matter when nothing strong was found. Multi-page
    // return packets (5 pages) spent ~1.5s here for variants the app's
    // missing-page crop options provide anyway.
    const hasStrongRect = candidates.some((candidate) => candidate?.cropRect
      && Number(candidate.confidence || 0) >= 0.9
      && cropContainsBarcodeOrUnknown(candidate, pages));
    if (!hasStrongRect) {
      candidates.push(...await textLabelPageFallbacks(pages));
      stage("text-label-fallback");
      candidates.push(...await embeddedLabelPageFallbacks(pages));
      stage("embedded-label-fallback");
    } else {
      stage("text-label-fallback", { skipped: true, note: "strong rect-backed candidate present" });
      stage("embedded-label-fallback", { skipped: true, note: "strong rect-backed candidate present" });
    }

    if (!candidates.length && pages.length === 1) {
      candidates.push({
        confidence: 0.74,
        reason: "single-page-pdf",
        pageIndex: 0,
        pageCount: 1,
        pages,
        label: await autoCropPageCanvas(pages[0])
      });
      stage("single-page-pdf");
    }

    const ranked = rankedDetections(candidates, pages);
    traceRanked(ranked);
    return ranked;
  }

  // Emits the final ranked order with each candidate's score so the studio can
  // show why the winner won and each loser lost.
  function traceRanked(ranked) {
    if (!traceSink) return;
    trace("ranked", {
      order: ranked.map((c) => ({
        reason: c.reason || "",
        variantName: c.variantName || "",
        carrier: c.carrier || "",
        confidence: Number(c.confidence || 0),
        score: detectionRankScore(c),
        breakdown: scoreBreakdown(c)
      }))
    });
  }

  function rankedDetections(candidates, pages) {
    const ranked = dedupeDetections(candidates)
      .filter((candidate) => !isLikelyTextInstructionPage(findPage(candidate.pages || pages, candidate.pageIndex), candidate.reason))
      .sort(compareDetections);
    return demoteOrderDetailsPages(promoteModelOverBorder(promoteDetectionOverTextGuess(ranked), pages), pages);
  }

  // Multi-page label PDFs ride along with order-details pages — packing slips,
  // item lists with quantities and SKUs, return-ID summaries — that the store
  // never prints. Only the weak text-fallback detectors fire on them (strong
  // geometry detectors have nothing to find there), and those cards then sit
  // above better candidates in the picker. They can't be dropped outright:
  // label pages MENTION the packing slip in their instructions, and some
  // sheets print order text on the same page as the label, so the patterns
  // below anchor on distinctive order-page strings and only candidates from
  // weak detectors are moved — to the END of the list, never removed. A strong
  // detection on a page that happens to carry order text is untouched.
  const ORDER_DETAILS_PAGE_PATTERN = new RegExp([
    "PACKING SLIP PUT THIS IN THE BOX",
    "PACKING SLIP",
    "PACKING LIST",
    "QTY\\s+SKU",
    "ITEM DESCRIPTIONS\\s+QUANTITY",
    "AMAZON RETURN ID:",
    "RETURN ORDER NUMBER:",
    "ORDER SUMMARY",
    // Invoice / order-summary wording: any one of these alone could appear in
    // marketing footers, so pair the looser ones with a second signal.
    "\\bINVOICE\\b[\\s\\S]{0,400}(SUBTOTAL|TOTAL DUE|BILL TO)",
    "SUBTOTAL[\\s\\S]{0,200}(SHIPPING & HANDLING|GRAND TOTAL|ORDER TOTAL)",
    "PAYMENT METHOD[\\s\\S]{0,300}(SUBTOTAL|ORDER TOTAL)",
    "BILLING ADDRESS[\\s\\S]{0,300}(SUBTOTAL|ORDER TOTAL|PAYMENT)"
  ].join("|"));
  const ORDER_DETAILS_DEMOTE_REASONS = ["keywords", "embedded-label-page", "text-label-page"];

  function isOrderDetailsText(text) {
    return ORDER_DETAILS_PAGE_PATTERN.test(String(text || "").toUpperCase());
  }

  function demoteOrderDetailsPages(ranked, pages) {
    if (ranked.length < 2) return ranked;
    const shouldDemote = (candidate) => ORDER_DETAILS_DEMOTE_REASONS.includes(candidate?.reason)
      && isOrderDetailsText(findPage(candidate.pages || pages, candidate.pageIndex)?.text);
    const demoted = ranked.filter(shouldDemote);
    if (!demoted.length || demoted.length === ranked.length) return ranked;
    trace("order-details-demoted", {
      demoted: demoted.map((candidate) => `${candidate.reason}@${candidate.pageIndex}`),
      note: "weak text-fallback candidates on order-details/packing-slip pages moved to the end"
    });
    return ranked.filter((candidate) => !shouldDemote(candidate)).concat(demoted);
  }

  // Text-keyword fallbacks score high on pages FULL of carrier wording — which
  // is exactly what a return-instructions page is — so a no-rect "keywords"
  // candidate can outrank the actually-detected label (its labelTextScore +
  // carrier preference outweigh the border's confidence). A text guess without
  // geometry should never beat a confident detection that has a real crop rect:
  // promote the best rect-backed border/model candidate over it.
  const TEXT_GUESS_REASONS = ["keywords", "embedded-label-page"];
  const TEXT_GUESS_MIN_BORDER_CONFIDENCE = 0.85;

  function promoteDetectionOverTextGuess(ranked) {
    const top = ranked[0];
    if (!TEXT_GUESS_REASONS.includes(top?.reason) || top?.cropRect) return ranked;
    const real = ranked.find((candidate) => candidate?.cropRect && candidate.label && (
      (MODEL_BORDER_REASONS.includes(candidate.reason)
        && Number(candidate.confidence || 0) >= TEXT_GUESS_MIN_BORDER_CONFIDENCE)
      || (candidate.reason === "trained-model"
        && Number(candidate.confidence || 0) >= MODEL_OVER_BORDER_MIN_CONFIDENCE)
    ));
    if (!real) return ranked;
    trace("detection-over-text-guess", {
      demotedReason: top.reason,
      promotedReason: real.reason,
      promotedConfidence: real.confidence,
      note: "no-rect text-keyword candidate outranked a confident rect-backed detection; detection promoted"
    });
    return [real, ...ranked.filter((candidate) => candidate !== real)];
  }

  // The border detectors (solid/dashed) lock onto the printed frame, which on
  // return-label sheets encloses the carrier's instruction block ("To complete
  // your return…", "Cut this label…") together with the label, so the crop comes
  // out bloated with text. Measured across the real corpus, whenever the trained
  // model fires CONFIDENTLY on a border-won page it boxes just the 4x6 label and
  // drops the instructions — the cleaner crop every time. So when a confident,
  // label-shaped model candidate exists on the same page, promote it over the
  // border. The confidence floor skips shaky low-confidence model boxes (those
  // keep the border crop); the aspect guard blocks a degenerate, non-label box
  // from ever winning. Borders still win on pages where the model didn't fire or
  // isn't confident.
  const MODEL_OVER_BORDER_MIN_CONFIDENCE = 0.80;
  const MODEL_OVER_BORDER_MAX_ASPECT_DISTANCE = 0.45;
  const MODEL_BORDER_REASONS = ["solid-border", "dashed-border"];
  // Tall phone screenshots: a "border" whose crop is basically the whole screen
  // found the screen bezel/app chrome, not a label frame. There the model's box
  // is trusted at a lower confidence floor.
  const SCREENSHOT_PAGE_MIN_ASPECT = 1.8;          // page h/w
  const SCREENSHOT_BORDER_MIN_AREA_RATIO = 0.85;   // border output vs page
  const SCREENSHOT_MODEL_MIN_CONFIDENCE = 0.55;

  function promoteModelOverBorder(ranked, pages) {
    const top = ranked[0];
    if (!MODEL_BORDER_REASONS.includes(top?.reason) || !top.cropRect) return ranked;
    const model = ranked.find((candidate) => candidate?.reason === "trained-model");
    if (!model || model.pageIndex !== top.pageIndex || !model.cropRect) return ranked;
    if (labelAspectDistance(model.cropRect) > MODEL_OVER_BORDER_MAX_ASPECT_DISTANCE) return ranked;
    const confidence = Number(model.confidence || 0);
    const confident = confidence >= MODEL_OVER_BORDER_MIN_CONFIDENCE;
    if (!confident && !(confidence >= SCREENSHOT_MODEL_MIN_CONFIDENCE
      && isFullPageBorderOnTallPage(top, pages))) return ranked;
    trace("model-over-border", {
      borderReason: top.reason,
      borderRect: top.cropRect,
      modelRect: model.cropRect,
      modelConfidence: model.confidence,
      note: confident
        ? "confident, label-shaped trained-model promoted over border crop"
        : "screenshot-shaped page: whole-screen border crop demoted below accepted model box"
    });
    return [model, ...ranked.filter((candidate) => candidate !== model)];
  }

  function isFullPageBorderOnTallPage(candidate, pages) {
    const page = findPage(candidate.pages || pages || [], candidate.pageIndex);
    const canvas = page?.canvas;
    if (!canvas || canvas.height < canvas.width * SCREENSHOT_PAGE_MIN_ASPECT) return false;
    const out = candidate.label?.sourceRect || candidate.cropRect;
    return (out.width * out.height) / Math.max(1, canvas.width * canvas.height)
      >= SCREENSHOT_BORDER_MIN_AREA_RATIO;
  }

  // Distance from a 4x6 thermal label's aspect ratio (either orientation); 0 = exact.
  function labelAspectDistance(rect) {
    const ratio = rect.width / Math.max(1, rect.height);
    return Math.min(Math.abs(ratio - 1.5), Math.abs(ratio - 2 / 3));
  }

  function emptyPdfResult(pages) {
    return {
      confidence: 0,
      pageIndex: 0,
      pageCount: getPageCount(pages),
      pages,
      label: null
    };
  }

  async function detectPngPages(pages) {
    if (!pages.length) return null;

    const borderHits = [
      ...await dashedBorderLabelDetections(pages),
      ...await solidBorderLabelDetections(pages)
    ].sort(compareDetections);
    if (borderHits[0]) {
      trace("early-exit", { detector: borderHits[0].reason, reason: borderHits[0].reason, confidence: Number(borderHits[0].confidence || 0), note: "border hit returned before model (png single-result path)" });
      return borderHits[0];
    }

    const modelHit = await trainedModelDetection(pages);
    if (modelHit) return modelHit;

    const barcodeHit = await barcodeDetection(pages);
    if (barcodeHit) return barcodeHit;

    const imageFallbacks = await imageLabelFallbacks(pages);
    if (imageFallbacks[0]) return imageFallbacks[0];

    const manualFallback = await manualImageFallback(pages);
    if (manualFallback) return manualFallback;

    return {
      confidence: 0,
      pageIndex: pages.length - 1,
      pageCount: getPageCount(pages),
      pages,
      label: null
    };
  }

  // Returns all PNG candidates sorted by quality — mirrors detectPdfCandidates for images.
  async function detectAllPngCandidates(pages) {
    if (!pages.length) return [];

    const candidates = [];
    let mark = 0;
    const stage = (detector, extra) => {
      trace("stage", { detector, produced: candidates.length - mark, total: candidates.length, ...(extra || {}) });
      mark = candidates.length;
    };
    trace("run-start", { path: "png", pages: pages.length });

    candidates.push(...await dashedBorderLabelDetections(pages));
    stage("dashed-border");
    candidates.push(...await solidBorderLabelDetections(pages));
    stage("solid-border");

    const modelHit = await trainedModelDetection(pages);
    if (modelHit) candidates.push(modelHit);
    stage("trained-model", { available: Boolean(window.LabelExtractorModelDetector) });

    const keywordHit = await keywordDetection(pages);
    if (keywordHit) candidates.push(keywordHit);
    stage("keywords");

    const barcodeHit = await barcodeDetection(pages);
    if (barcodeHit) candidates.push(barcodeHit);
    stage("barcode");

    candidates.push(...await imageLabelFallbacks(pages));
    stage("image-label-fallback");

    if (!candidates.length) {
      const fallback = await detectPngPages(pages);
      if (fallback?.label) candidates.push(fallback);
      stage("png-single-fallback");
    }

    if (!candidates.length) {
      const manualFallback = await manualImageFallback(pages);
      if (manualFallback?.label) candidates.push(manualFallback);
      stage("manual-image-fallback");
    }

    // Same ranking pipeline as the PDF path — without it, images never get
    // model-over-border promotion, so a screenshot whose solid border wraps
    // the whole phone screen beat the model's label box every time.
    const ranked = rankedDetections(candidates, pages);
    traceRanked(ranked);
    return ranked;
  }

  async function manualImageFallback(pages) {
    const page = pages.find((item) => item?.canvas) || pages[0];
    if (!page?.canvas) return null;

    return {
      confidence: 0.36,
      reason: "manual-image-fallback",
      pageIndex: page.pageIndex,
      pageCount: getPageCount(pages),
      pages,
      label: await autoCropPageCanvas(page, 24),
      cropRect: null,
      sourceWidth: page.canvas.width,
      sourceHeight: page.canvas.height,
      variantName: `Manual image crop page ${Number(page.pageIndex || 0) + 1}`,
      warnings: ["No detector found a clean label; manually crop this image before printing."],
      needsCrop: true,
      qualityScore: -1
    };
  }

  async function imageLabelFallbacks(pages) {
    const detections = [];

    for (const page of pages) {
      const regions = findBarcodeRegions(page.canvas);
      if (regions.length < 1) continue;

      const rect = expandRect(unionRects(regions), page.canvas, 0.95);
      const expanded = expandToLabelLikeRect(rect, page.canvas);
      detections.push({
        confidence: 0.42,
        reason: "image-label-fallback",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label: await cropPageCanvas(page, expanded),
        cropRect: expanded,
        sourceWidth: page.canvas.width,
        sourceHeight: page.canvas.height,
        variantName: `Image label fallback page ${Number(page.pageIndex || 0) + 1}`,
        warnings: ["Image fallback; crop/rotate before printing."],
        needsCrop: true,
        qualityScore: regions.length
      });
    }

    return detections;
  }

  function expandToLabelLikeRect(rect, canvas) {
    const targetAspect = 4 / 6;
    let { x, y, width, height } = rect;
    const aspect = width / Math.max(1, height);

    if (aspect > targetAspect * 1.35) {
      const nextHeight = width / targetAspect;
      y -= (nextHeight - height) / 2;
      height = nextHeight;
    } else if (aspect < targetAspect * 0.75) {
      const nextWidth = height * targetAspect;
      x -= (nextWidth - width) / 2;
      width = nextWidth;
    }

    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.min(canvas.width - x, width);
    height = Math.min(canvas.height - y, height);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    };
  }

  function isLabelSizedPage(width, height) {
    const orientations = [
      [288, 432],
      [432, 288],
      [288, 576],
      [576, 288]
    ];
    return orientations.some(([targetW, targetH]) => close(width, targetW, 0.15) && close(height, targetH, 0.15));
  }

  function close(value, target, tolerance) {
    return Math.abs(value - target) / target <= tolerance;
  }

  function getPageCount(pages) {
    return pages.reduce((max, page) => Math.max(max, Number(page.pageCount || 0)), pages.length);
  }

  function findPage(pages, pageIndex) {
    return pages.find((p) => p.pageIndex === pageIndex) || pages[0] || null;
  }

  function cropOptionsForPage(page) {
    const text = String(page?.text || "").toUpperCase();
    const isOnlineReturnForm = isOnlineReturnAuthorizationSlip(text);
    const isUspsPdf = page?.type === "pdf"
      && !isOnlineReturnForm
      && /USPS|POSTAL SERVICE|GROUND ADVANTAGE|PRIORITY MAIL/.test(text);
    return isUspsPdf ? { bottomExtraRatio: 0.035 } : {};
  }

  function cropPageCanvas(page, rect, options = {}) {
    return window.LabelExtractorCrop.cropCanvas(page.canvas, rect, { ...cropOptionsForPage(page), ...options });
  }

  // Clamp a detection rect above the page's "Return Authorization Slip" header
  // (slipRects, exported by pdf-processor in canvas coords). Newer Online Return
  // Center sheets print the slip on the SAME page as the label, inside the same
  // cut-frame, so border/model rects wrap it in with the label. No-op on pages
  // without slip text.
  function clampRectAboveSlip(rect, page) {
    if (!rect) return rect;
    let next = rect;
    if (page?.slipRects?.length) {
      next = window.LabelExtractorCrop.clampRectBottomAboveBlockers(next, page.slipRects, page.canvas);
    }
    if (page?.cutLineRects?.length) {
      next = window.LabelExtractorCrop.clampRectTopBelowBlockers(next, page.cutLineRects, page.canvas);
    }
    return next;
  }

  function autoCropPageCanvas(page, padding = 6) {
    return window.LabelExtractorCrop.autoCropCanvas(page.canvas, padding, cropOptionsForPage(page));
  }

  async function embeddedUspsLabelDetection(pages) {
    let best = null;

    for (const page of pages) {
      const text = String(page?.text || "").toUpperCase();
      if (page?.type !== "pdf" || !/USPS|POSTAL SERVICE|GROUND ADVANTAGE|PRIORITY MAIL/.test(text)) continue;

      for (const canvas of page.embeddedImages || []) {
        if (!canvas || canvas.width < 300 || canvas.height < 300) continue;
        const aspect = canvas.width / Math.max(1, canvas.height);
        if (aspect < 0.38 || aspect > 2.65) continue;

        const barcodeRegions = findBarcodeRegions(canvas);
        if (!barcodeRegions.length) continue;
        const score = canvas.width * canvas.height + barcodeRegions.length * 100000;
        if (!best || score > best.score) best = { page, canvas, score };
      }
    }

    if (!best) return null;
    let label = window.LabelExtractorCrop.canvasToLabel(best.canvas);
    if (label.width > label.height) {
      label = await window.LabelExtractorCrop.rotateDataUrl(label.dataUrl, 90);
    }

    return {
      confidence: 0.99,
      reason: "embedded-usps-label",
      carrier: "USPS",
      pageIndex: best.page.pageIndex,
      pageCount: getPageCount(pages),
      pages,
      label,
      cropRect: null,
      sourceWidth: best.canvas.width,
      sourceHeight: best.canvas.height,
      qualityScore: 12
    };
  }

  async function embeddedImageLabelDetections(pages) {
    const detections = [];

    for (const page of pages) {
      if (isOnlineReturnAuthorizationSlip(page?.text)) continue;

      for (const canvas of page.embeddedImages || []) {
        if (!canvas || canvas.width < 300 || canvas.height < 300) continue;
        const aspect = canvas.width / Math.max(1, canvas.height);
        if (aspect < 0.38 || aspect > 2.65) continue;
        if (isTemplateBackgroundImage(canvas, page)) continue;

        const barcodeRegions = findBarcodeRegions(canvas);
        if (!looksLikeCompleteEmbeddedLabel(canvas, barcodeRegions)) continue;

        let label = window.LabelExtractorCrop.canvasToLabel(canvas);
        if (label.width > label.height) {
          label = await window.LabelExtractorCrop.rotateDataUrl(label.dataUrl, 90);
        }

        detections.push({
          confidence: 0.985,
          reason: "embedded-image-label",
          pageIndex: page.pageIndex,
          pageCount: getPageCount(pages),
          pages,
          label,
          cropRect: null,
          sourceWidth: canvas.width,
          sourceHeight: canvas.height,
          sourceCanvas: canvas,
          variantName: `Embedded image label page ${Number(page.pageIndex || 0) + 1}`,
          qualityScore: 10 + barcodeRegions.length
        });
      }
    }

    return detections;
  }

  function looksLikeCompleteEmbeddedLabel(canvas, barcodeRegions) {
    if (barcodeRegions.length >= 2) return true;
    // No barcode detected (common on image-only PDFs where the scan misses):
    // a large, cleanly 4:6/6:4-shaped embedded image is almost certainly the
    // whole label on its own. Trust the geometry so we don't fall through to a
    // border detector that grabs an inner sub-section ("doesn't fully show").
    if (!barcodeRegions.length) return isLabelSizedImage(canvas);

    const area = canvas.width * canvas.height;
    const barcodeArea = barcodeRegions.reduce((sum, region) => sum + region.width * region.height, 0);
    const barcodeAreaRatio = barcodeArea / Math.max(1, area);
    if (barcodeAreaRatio > 0.035) return true;

    const hasLargeHorizontalBarcode = barcodeRegions.some((region) => (
      region.width > canvas.width * 0.38
      && region.height > canvas.height * 0.06
      && region.y > canvas.height * 0.45
    ));
    return hasLargeHorizontalBarcode && canvas.height > canvas.width * 1.15;
  }

  // Some PDFs compose the label from a full-page background TEMPLATE image
  // (frame lines, "UPS GROUND" bar) with the variable data — addresses,
  // tracking number, barcodes — drawn on top as separate text/image objects.
  // The raw template prints as a blank skeleton. Detect it by ink: a template
  // has far less dark content than the rendered page that includes the
  // overlays. Only fires for full-page-shaped images on pages that have a
  // real text layer, so image-only label PDFs (no overlays, no text) keep
  // using the embedded image untouched.
  function isTemplateBackgroundImage(canvas, page) {
    if (!page?.canvas) return false;
    const pageAspect = page.canvas.width / Math.max(1, page.canvas.height);
    const imgAspect = canvas.width / Math.max(1, canvas.height);
    if (Math.abs(imgAspect - pageAspect) / pageAspect > 0.05) return false;
    if (String(page.text || "").trim().length < 50) return false;
    const imgInk = canvasInkRatio(canvas);
    const pageInk = canvasInkRatio(page.canvas);
    return pageInk > imgInk * 1.5 && pageInk - imgInk > 0.03;
  }

  // Dark-pixel ratio on a downsampled copy (cheap, ~400px wide readback).
  function canvasInkRatio(canvas) {
    const scale = Math.min(1, 400 / Math.max(1, canvas.width));
    const sample = document.createElement("canvas");
    sample.width = Math.max(1, Math.round(canvas.width * scale));
    sample.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 128 && data[i + 3] > 100) dark++;
    }
    return dark / (sample.width * sample.height);
  }

  // A large embedded image whose aspect is ~4:6 or ~6:4 is a label by shape
  // alone, even when no barcode is detected on it.
  function isLabelSizedImage(canvas) {
    const aspect = canvas.width / Math.max(1, canvas.height);
    const tol = 0.05;
    const labelShaped = Math.abs(aspect - 4 / 6) <= tol || Math.abs(aspect - 6 / 4) <= tol;
    return labelShaped && Math.min(canvas.width, canvas.height) >= 600;
  }

  // UPS "View/Print Label" / fold-and-tear sheets: instructions on top, the real
  // shipping label below a "FOLD HERE" divider. pdf-processor records the fold's
  // position (page.foldRatio); here we crop everything below it, rotate a landscape
  // label upright, and only accept it when that lower section actually contains a
  // barcode (so we never mistakenly grab an instruction block).
  async function foldHereLabelDetection(pages) {
    let best = null;

    for (const page of pages) {
      const ratio = Number(page.foldRatio);
      if (!page.canvas || !(ratio > 0.05 && ratio < 0.95)) continue;

      const canvas = page.canvas;
      const margin = Math.round(canvas.height * 0.012);
      const cutY = Math.max(0, Math.round(canvas.height * ratio) - margin);
      const regionHeight = canvas.height - cutY;
      if (regionHeight < canvas.height * 0.1) continue;

      const region = document.createElement("canvas");
      region.width = canvas.width;
      region.height = regionHeight;
      const ctx = region.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, region.width, region.height);
      ctx.drawImage(canvas, 0, cutY, canvas.width, regionHeight, 0, 0, region.width, regionHeight);

      // Guard: the section below the fold must contain a barcode, or this isn't
      // the "label below the fold" layout we're targeting.
      if (findBarcodeRegions(region).length < 1) continue;

      // The lower fold section is already the label area. Preserve it as-is:
      // generic auto-crop can shave off quiet margins and outer label edges.
      let label = window.LabelExtractorCrop.canvasToLabel(region);
      if (label.width > label.height) {
        label = await window.LabelExtractorCrop.rotateDataUrl(label.dataUrl, 90);
      }

      const score = (label.width * label.height) / Math.max(1, region.width * region.height);
      if (!best || score > best.score) {
        best = { page, label, score };
      }
    }

    if (!best) return null;

    return {
      confidence: 0.97,
      reason: "fold-here-label",
      pageIndex: best.page.pageIndex,
      pageCount: getPageCount(pages),
      pages,
      label: best.label,
      sourceWidth: best.page.canvas.width,
      sourceHeight: best.page.canvas.height,
      qualityScore: 5
    };
  }

  async function labelSizedPageDetection(pages) {
    for (const page of pages) {
      if (!isLabelSizedPage(page.naturalWidth, page.naturalHeight)) continue;
      return {
        confidence: 0.96,
        reason: "page-dimensions",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        // This PDF page is already label-sized. Keep the complete page so quiet
        // margins and outer label edges are never shaved off before printing.
        label: window.LabelExtractorCrop.canvasToLabel(page.canvas)
      };
    }
    return null;
  }

  async function dashedBorderLabelDetections(pages) {
    const detections = [];
    const onlineReturnCenterDocument = isOnlineReturnCenterDocument(pages);
    for (const page of pages) {
      if (onlineReturnCenterDocument && isOnlineReturnAuthorizationSlip(page?.text)) continue;
      const knownOnlineReturnForm = onlineReturnCenterDocument && isOnlineReturnMailingLabelPage(page?.text);
      const borderRect = trimKnownDashedBorderForm(detectDashedBorder(page.canvas), page, knownOnlineReturnForm);
      if (!borderRect) continue;
      // Known online-return forms get their own precise trimming; leave them be.
      const rect = clampRectAboveSlip(
        knownOnlineReturnForm ? borderRect : expandRectToClippedBarcodes(borderRect, page.canvas),
        page
      );
      if (!knownOnlineReturnForm) {
        const fullPage = await fullPageLabelIfShaped(page, pages, rect);
        if (fullPage) { detections.push(fullPage); continue; }
      }
      const areaRatio = (rect.width * rect.height) / Math.max(1, page.canvas.width * page.canvas.height);
      if (areaRatio < 0.08) continue;
      let label = await cropPageCanvas(page, rect, knownOnlineReturnForm ? {
        paddingRatio: 0.018,
        minPadding: 3,
        leftExtraRatio: 0,
        rightExtraRatio: 0,
        topExtraRatio: 0,
        bottomExtraRatio: 0,
        replaceBottomExtraRatio: true
      } : {});
      if (knownOnlineReturnForm && label.width > label.height) {
        label = await window.LabelExtractorCrop.rotateDataUrl(label.dataUrl, 90);
      }
      detections.push({
        confidence: 0.97,
        reason: "dashed-border",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label,
        cropRect: rect,
        sourceWidth: page.canvas.width,
        sourceHeight: page.canvas.height,
        qualityScore: 3
      });
    }
    return detections;
  }

  function trimKnownDashedBorderForm(rect, page, knownOnlineReturnForm) {
    if (!rect || !knownOnlineReturnForm) return rect;

    const landscapeLabelHeight = Math.round(rect.width * ONLINE_RETURN_LABEL_ASPECT);
    const trimTop = Math.round(landscapeLabelHeight * ONLINE_RETURN_TOP_TRIM_RATIO);
    const padBottom = Math.round(landscapeLabelHeight * ONLINE_RETURN_BOTTOM_PAD_RATIO);

    return {
      ...rect,
      y: Math.min(rect.y + trimTop, rect.y + rect.height - 1),
      height: Math.max(1, Math.min(rect.height - trimTop, landscapeLabelHeight + padBottom))
    };
  }

  function isOnlineReturnAuthorizationSlip(text) {
    const value = String(text || "").toUpperCase();
    return value.includes("RETURN AUTHORIZATION SLIP");
  }

  function isOnlineReturnMailingLabelPage(text) {
    const value = String(text || "").toUpperCase();
    return value.includes("RETURN MAILING LABEL");
  }

  function isOnlineReturnCenterDocument(pages) {
    return pages.some((page) => isOnlineReturnAuthorizationSlip(page?.text));
  }

  async function solidBorderLabelDetections(pages) {
    const detections = [];

    for (const page of pages) {
      const borderRect = detectSolidLabelBorder(page.canvas);
      if (!borderRect) continue;
      const rect = clampRectAboveSlip(expandRectToClippedBarcodes(borderRect, page.canvas), page);

      const fullPage = await fullPageLabelIfShaped(page, pages, rect);
      if (fullPage) { detections.push(fullPage); continue; }

      const areaRatio = rect.width * rect.height / Math.max(1, page.canvas.width * page.canvas.height);
      const score = areaRatio + labelTextScore(page.text) + (page.pageIndex || 0) * 0.01;
      detections.push({
        confidence: Math.min(0.97, 0.88 + score * 0.02),
        reason: "solid-border",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label: await cropPageCanvas(page, rect),
        cropRect: rect,
        sourceWidth: page.canvas.width,
        sourceHeight: page.canvas.height,
        qualityScore: score + 2
      });
    }

    return detections;
  }

  function labelTextScore(text) {
    const value = String(text || "").toUpperCase();
    let score = 0;
    if (/USPS|POSTAL SERVICE|GROUND ADVANTAGE|PRIORITY MAIL/.test(value)) score += 1.2;
    if (/RETURN MAILING LABEL|MAILING LABEL|RETURN LABEL/.test(value)) score += 1;
    if (/TRACKING|SHIP TO|SHIP FROM/.test(value)) score += 0.6;
    // "Cut this label…" / "Place this label on the outside…" — the page is
    // announcing it CARRIES the label. Multi-page return packets pair one such
    // page with instruction pages whose hallucinated border boxes otherwise
    // outrank the real label page (its dashed candidate eats the UPS-text
    // demotion; the instruction page eats nothing).
    if (LABEL_CARRIER_PAGE_PATTERN.test(value)) score += 1;
    return score;
  }

  const LABEL_CARRIER_PAGE_PATTERN = /CUT THIS LABEL|PLACE THIS LABEL|AFFIX THIS LABEL|ATTACH THIS LABEL/;

  function declaresLabelPage(page) {
    return LABEL_CARRIER_PAGE_PATTERN.test(String(page?.text || "").toUpperCase());
  }

  function instructionTextScore(text) {
    const value = String(text || "").toUpperCase();
    let score = 0;
    if (/ADDITIONAL INSTRUCTIONS|RETURN REQUIREMENTS|IMPORTANT NOTE|EXCHANGES/.test(value)) score += 1;
    if (/CONTACT US|APOLOGIZE|MERCHANDISE|REFUND|ELIGIBLE/.test(value)) score += 0.5;
    return score;
  }

  function isLikelyTextInstructionPage(page, reason) {
    if (!page || reason === "solid-border" || reason === "trained-model" || reason === "embedded-label-page") return false;
    return instructionTextScore(page.text) >= 1 && !hasStrongLabelCue(page.text);
  }

  function hasStrongLabelCue(text) {
    const value = String(text || "").toUpperCase();
    return /RETURN MAILING LABEL|USPS TRACKING|UPS TRACKING|FEDEX TRACKING|GROUND ADVANTAGE|SHIP TO/.test(value);
  }

  function compareDetections(a, b) {
    if (shouldBorderOverrideEmbeddedUsps(a, b)) return -1;
    if (shouldBorderOverrideEmbeddedUsps(b, a)) return 1;
    if (a?.reason === "embedded-usps-label" && b?.reason !== "embedded-usps-label") return -1;
    if (b?.reason === "embedded-usps-label" && a?.reason !== "embedded-usps-label") return 1;

    const scoreA = detectionRankScore(a);
    const scoreB = detectionRankScore(b);
    return scoreB - scoreA;
  }

  function shouldBorderOverrideEmbeddedUsps(borderCandidate, otherCandidate) {
    if (otherCandidate?.reason !== "embedded-usps-label") return false;
    if (!["dashed-border", "solid-border"].includes(borderCandidate?.reason)) return false;
    if (Number(borderCandidate.confidence || 0) < EMBEDDED_USPS_BORDER_OVERRIDE_CONFIDENCE) return false;
    return cropContainsBarcodeOrUnknown(borderCandidate, borderCandidate.pages || []);
  }

  function detectionRankScore(candidate) {
    const page = findPage(candidate.pages || [], candidate.pageIndex);
    return Number(candidate.qualityScore || 0)
      + Number(candidate.confidence || 0)
      + labelTextScore(page?.text)
      + carrierTextPreferenceScore(candidate, page)
      + barcodeContainmentPenalty(candidate, page)
      + labelShapeRankScore(candidate)
      + orderDetailsPagePenalty(page);
  }

  // Same components as detectionRankScore, itemized for the dev studio log so the
  // ranking is explainable per candidate. total must equal detectionRankScore().
  function scoreBreakdown(candidate) {
    const page = findPage(candidate?.pages || [], candidate?.pageIndex);
    const qualityScore = Number(candidate?.qualityScore || 0);
    const confidence = Number(candidate?.confidence || 0);
    const textScore = labelTextScore(page?.text);
    const carrierPref = carrierTextPreferenceScore(candidate, page);
    const barcodePenalty = barcodeContainmentPenalty(candidate, page);
    const shapeScore = labelShapeRankScore(candidate);
    const orderPenalty = orderDetailsPagePenalty(page);
    return {
      qualityScore,
      confidence,
      labelTextScore: textScore,
      carrierPref,
      barcodePenalty,
      shapeScore,
      orderPenalty,
      total: qualityScore + confidence + textScore + carrierPref + barcodePenalty + shapeScore + orderPenalty
    };
  }

  // A 4x6 thermal label prints best when the crop already IS 4x6-shaped
  // (either orientation — landscape sources are auto-rotated). Reward crops
  // whose final output is label-shaped and penalize extreme aspect ratios
  // (full phone screenshots, banner strips) so a clean 4x6 candidate sits
  // above them in the picker. Sized to order border/model candidates
  // (quality 2-4) without upsetting the embedded-label hierarchy (10+).
  const LABEL_SHAPE_STRONG_DISTANCE = 0.08;
  const LABEL_SHAPE_NEAR_DISTANCE = 0.15;
  const LABEL_SHAPE_EXTREME_MIN_ASPECT = 0.45;
  const LABEL_SHAPE_EXTREME_MAX_ASPECT = 2.3;

  function labelShapeRankScore(candidate) {
    const label = candidate?.label;
    const width = Number(label?.width || 0);
    const height = Number(label?.height || 0);
    if (!width || !height) return 0;
    const aspect = width / height;
    const distance = Math.min(Math.abs(aspect - 2 / 3), Math.abs(aspect - 1.5));
    if (distance <= LABEL_SHAPE_STRONG_DISTANCE) return 0.8;
    if (distance <= LABEL_SHAPE_NEAR_DISTANCE) return 0.4;
    if (aspect < LABEL_SHAPE_EXTREME_MIN_ASPECT || aspect > LABEL_SHAPE_EXTREME_MAX_ASPECT) return -0.8;
    return 0;
  }

  // Candidates living on a pure order-details page (packing slip, invoice,
  // order summary) sink below same-document label pages: the page talks about
  // the ORDER but shows no shipping-label wording at all. Pages that carry
  // both (label printed above the slip section) keep their score — the strong
  // label cue vetoes the penalty.
  function orderDetailsPagePenalty(page) {
    if (!page || !isOrderDetailsText(page.text)) return 0;
    if (hasStrongLabelCue(page.text)) return 0;
    return -2;
  }

  // A real shipping-label crop must contain a barcode. When a crop with explicit
  // bounds excludes every barcode on the page — e.g. a border drawn around the
  // instruction block on UPS "View/Print Label" / FOLD HERE sheets — it is almost
  // certainly not the label, so we demote it heavily. Whole-page auto-crops (no
  // cropRect) and pages with no detectable barcode are left untouched, so
  // legitimate labels are never penalized.
  function pageBarcodeRegions(canvas) {
    return findBarcodeRegions(canvas);
  }

  function rectContainsAnyBarcode(rect, regions) {
    return regions.some((region) => {
      const cx = region.x + region.width / 2;
      const cy = region.y + region.height / 2;
      return cx >= rect.x && cx <= rect.x + rect.width
        && cy >= rect.y && cy <= rect.y + rect.height;
    });
  }

  function barcodeContainmentPenalty(candidate, page) {
    if (!candidate?.cropRect || !page?.canvas) return 0;
    const regions = pageBarcodeRegions(page.canvas);
    if (regions.length < 1) return 0;
    return rectContainsAnyBarcode(candidate.cropRect, regions) ? 0 : BARCODE_EXCLUSION_PENALTY;
  }

  // True unless the crop has explicit bounds that exclude every barcode on a page
  // that has barcodes — i.e. don't let such a crop short-circuit the cascade.
  function cropContainsBarcodeOrUnknown(candidate, pages) {
    const page = findPage(candidate?.pages || pages || [], candidate?.pageIndex);
    return barcodeContainmentPenalty(candidate, page) === 0;
  }

  function shouldPreferCarrierText(candidate, pages) {
    const page = findPage(candidate.pages || [], candidate.pageIndex) || findPage(pages || [], candidate.pageIndex);
    return candidate?.reason === "dashed-border" && isUpsLabelText(page?.text);
  }

  // A border box much taller than a 4x6 frame that also fills most of the page
  // is the "instructions + label inside one cut frame" layout (UPS View/Print
  // sheets exported as image-only PDFs — no text, so the fold/carrier checks
  // can't catch them). Don't let it short-circuit the cascade: the model boxes
  // just the label on these and wins via promoteModelOverBorder.
  const TALL_BORDER_MIN_HEIGHT_RATIO = 1.65; // rect h/w; 4x6 portrait is 1.5
  const TALL_BORDER_MIN_AREA_RATIO = 0.45;   // of the page

  function isTallOverstuffedBorder(candidate, pages) {
    if (!MODEL_BORDER_REASONS.includes(candidate?.reason) || !candidate.cropRect) return false;
    const rect = candidate.cropRect;
    if (rect.height < rect.width * TALL_BORDER_MIN_HEIGHT_RATIO) return false;
    const canvas = findPage(candidate.pages || pages || [], candidate.pageIndex)?.canvas;
    if (!canvas) return false;
    return rect.width * rect.height >= canvas.width * canvas.height * TALL_BORDER_MIN_AREA_RATIO;
  }

  function carrierTextPreferenceScore(candidate, page) {
    if (!isUpsLabelText(page?.text)) return 0;
    if (candidate?.reason === "keywords") return 3;
    if (candidate?.reason === "text-label-page") return 2;
    if (candidate?.reason === "dashed-border") return -1.5;
    return 0;
  }

  function isUpsLabelText(text) {
    const value = String(text || "").toUpperCase();
    return /\b1Z[0-9A-Z]{16}\b/.test(value) || /\bUPS\b|UPS TRACKING|UPS GROUND|UPS 2ND DAY AIR|UPS NEXT DAY AIR/.test(value);
  }

  function dedupeDetections(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
      if (!candidate?.label) return false;
      const key = `${candidate.reason}:${candidate.pageIndex}:${candidate.label.width}x${candidate.label.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function trainedModelDetection(pages, pageIndexes) {
    if (!window.LabelExtractorModelDetector) return null;
    try {
      return withCarrierMetadata(await window.LabelExtractorModelDetector.detectPages(pages, pageIndexes), pages);
    } catch (error) {
      console.warn("[Label Extractor] Trained model detection failed", error);
      return null;
    }
  }

  // ONNX inference costs ~0.7 s per page, and detectPages keeps only its single
  // best prediction for the whole document — so inferring pages that prediction
  // can't come from (or can't matter on) is pure wall-time waste. The model's
  // runtime jobs are (a) refine a page some detector already flagged
  // (promoteModelOverBorder / ranking) and (b) find the label when no detector
  // saw anything. So:
  //  - Pages with any rect-backed candidate are inferred: if a detector saw the
  //    label, its page is in this set, so the model's best prediction is the
  //    same one it would have picked scanning every page.
  //  - Pages that look like embedded-label pages (same signal
  //    embeddedLabelPageFallbacks uses: embedded images, 2+ barcode regions, or
  //    return-label wording) are inferred too: a borderless label image gives
  //    the heuristics no rect, but the model can still box it (Online Return
  //    Center 5's page-1 USPS label lives here). findBarcodeRegions is
  //    memoized, so asking early costs nothing — the fallback stage re-asks the
  //    same canvas later anyway.
  //  - N-up duplicate sheets (the same border rect on 3+ pages — e.g. a 6-up
  //    twin-label PDF) skip the model entirely: per-page borders fill the
  //    variant list above the model's single lower-confidence candidate, and
  //    inferring only some pages could flip same-page promotion on whichever
  //    page happened to be scanned — changing today's verified winner.
  //  - No candidates at all keeps the old behavior (every page): the model is
  //    the only detector left.
  const NUP_MIN_DUPLICATE_PAGES = 3;
  const NUP_RECT_TOLERANCE_RATIO = 0.02;

  function modelInferencePageScope(candidates, pages) {
    const rectBacked = candidates.filter((candidate) => candidate?.cropRect);
    if (!rectBacked.length) return { pageIndexes: null, note: "all pages (no rect-backed candidates)" };
    if (isNUpDuplicateSheet(rectBacked, pages)) {
      // Every duplicate page would give the same prediction, so one inference
      // covers the sheet. Use the page the ranking favors (highest pageIndex —
      // detectionRankScore adds a small later-page bonus) so same-page
      // model-over-border promotion still applies to the winner.
      const topPage = Math.max(...rectBacked.map((candidate) => Number(candidate.pageIndex || 0)));
      trace("model-scope", { note: `n-up duplicate sheet; model on page ${topPage} only` });
      return { pageIndexes: new Set([topPage]), note: `page ${topPage} only (n-up duplicate sheet)` };
    }
    // Pages that DECLARE they carry the label ("Cut this label…") narrow the
    // scope further: a 5-page return packet has rect-backed candidates on
    // instruction pages too (hallucinated boxes), and each skipped page saves
    // a ~0.7s inference. Without a declaration, every rect-backed page stays.
    const declared = pages.filter((page) => page?.canvas && !page.isCropOption && declaresLabelPage(page))
      .map((page) => Number(page.pageIndex || 0));
    const pageIndexes = declared.length
      ? new Set(declared)
      : new Set(rectBacked.map((candidate) => Number(candidate.pageIndex || 0)));
    // With a declared label page, only hard evidence re-adds other pages:
    // every page of a return packet carries embedded LOGO images, and the
    // embeddedImageCount trigger alone would put the whole document back in
    // scope (~0.7s inference per page).
    const looksRelevant = declared.length ? hasBarcodeOrReturnLabelCue : looksLikeEmbeddedLabelPage;
    for (const page of pages) {
      if (!page?.canvas || page.isCropOption) continue;
      const index = Number(page.pageIndex || 0);
      if (pageIndexes.has(index)) continue;
      if (looksRelevant(page)) pageIndexes.add(index);
    }
    return { pageIndexes, note: `pages ${[...pageIndexes].sort((a, b) => a - b).join(",")} of ${pages.length}` };
  }

  function looksLikeEmbeddedLabelPage(page) {
    if (Number(page.embeddedImageCount || 0) > 0) return true;
    return hasBarcodeOrReturnLabelCue(page);
  }

  function hasBarcodeOrReturnLabelCue(page) {
    const text = String(page.text || "").toUpperCase();
    if (/RETURN AUTHORIZATION SLIP|PLACE THIS BARCODE|RETURN MAILING LABEL/.test(text)) return true;
    return findBarcodeRegions(page.canvas).length >= 2;
  }

  function isNUpDuplicateSheet(rectBacked, pages) {
    if (pages.length < NUP_MIN_DUPLICATE_PAGES) return false;
    const groups = new Map();
    for (const candidate of rectBacked) {
      if (!MODEL_BORDER_REASONS.includes(candidate.reason)) continue;
      const rect = candidate.cropRect;
      const page = findPage(candidate.pages || pages, candidate.pageIndex);
      const dim = Math.max(1, Math.max(page?.canvas?.width || 0, page?.canvas?.height || 0));
      const tolerance = Math.max(8, dim * NUP_RECT_TOLERANCE_RATIO);
      const key = [
        candidate.reason,
        Math.round(rect.x / tolerance),
        Math.round(rect.y / tolerance),
        Math.round(rect.width / tolerance),
        Math.round(rect.height / tolerance)
      ].join(":");
      const seenPages = groups.get(key) || new Set();
      seenPages.add(Number(candidate.pageIndex || 0));
      groups.set(key, seenPages);
      if (seenPages.size >= NUP_MIN_DUPLICATE_PAGES) return true;
    }
    return false;
  }

  function withCarrierMetadata(result, pages) {
    if (!result) return result;
    const page = pages && findPage(pages, result.pageIndex || 0);
    const carrier = guessCarrier(page && page.text);
    if (carrier) result.carrier = carrier;
    return result;
  }

  function guessCarrier(text) {
    const value = String(text || "").toUpperCase();
    if (!value) return "";
    if (/\b1Z[0-9A-Z]{16}\b/.test(value) || /\bUPS\b|UPS TRACKING|UPS GROUND/.test(value)) return "UPS";
    if (/\b(9\d{21,}|92\d{20,})\b/.test(value) || /USPS|POSTAL SERVICE|PRIORITY MAIL|GROUND ADVANTAGE/.test(value)) return "USPS";
    if (/\b(\d{12}|\d{15}|\d{20})\b/.test(value) || /FEDEX|FEDERAL EXPRESS/.test(value)) return "FedEx";
    if (/DHL|EXPRESS WORLDWIDE/.test(value)) return "DHL";
    if (/AMAZON|RETURN MAILING LABEL/.test(value)) return "Amazon";
    if (/SHIPSTATION/.test(value)) return "ShipStation";
    if (/PIRATE SHIP/.test(value)) return "Pirate Ship";
    if (/EBAY/.test(value)) return "eBay";
    if (/ETSY/.test(value)) return "Etsy";
    return "";
  }

  async function keywordDetection(pages) {
    let best = null;

    for (const page of pages) {
      const text = (page.text || "").toUpperCase();
      let score = 0;
      for (const keyword of KEYWORDS) {
        if (text.includes(keyword)) score += 1;
      }
      if (/\b(9\d{21,}|92\d{20,}|1Z[0-9A-Z]{16}|[0-9]{20,})\b/i.test(text)) score += 2;

      if (!best || score > best.score) best = { page, score };
    }

    if (best && best.score >= 2) {
      const text = (best.page.text || "").toUpperCase();
      const useWholeTextPage = isReturnMailingLabelPage(text);
      const barcodeBox = useWholeTextPage ? null : findBarcodeBoundingBox(best.page.canvas);
      let rect = null;
      if (barcodeBox) {
        const padX = Math.round(best.page.canvas.width * 0.20);
        const padY = Math.round(best.page.canvas.height * 0.20);
        const rx = Math.max(0, barcodeBox.x - padX);
        const ry = Math.max(0, barcodeBox.y - padY);
        rect = {
          x: rx,
          y: ry,
          width: Math.min(best.page.canvas.width - rx, barcodeBox.width + padX * 2),
          height: Math.min(best.page.canvas.height - ry, barcodeBox.height + padY * 2)
        };
      }
      const label = rect ? await cropPageCanvas(best.page, rect) : await autoCropPageCanvas(best.page);
      return {
        confidence: useWholeTextPage ? 0.58 : Math.min(0.92, 0.68 + best.score * 0.08),
        reason: "keywords",
        pageIndex: best.page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label,
        cropRect: rect,
        sourceWidth: best.page.canvas.width,
        sourceHeight: best.page.canvas.height,
        variantName: useWholeTextPage ? `Return mailing label page ${Number(best.page.pageIndex || 0) + 1}` : undefined,
        warnings: useWholeTextPage ? ["Text fallback; crop to the actual label before printing."] : []
      };
    }

    return null;
  }

  function isReturnMailingLabelPage(text) {
    return /RETURN MAILING LABEL/.test(text) && /CUT THIS LABEL|AFFIX|OUTSIDE OF THE RETURN PACKAGE/.test(text);
  }

  async function textLabelPageFallbacks(pages) {
    const detections = [];

    for (const page of pages) {
      const text = String(page.text || "").toUpperCase();
      if (!hasStrongLabelCue(text)) continue;
      if (instructionTextScore(text) >= 1 && !/USPS TRACKING|UPS TRACKING|FEDEX TRACKING|TRACKING #/.test(text)) continue;

      detections.push({
        confidence: 0.62,
        reason: "text-label-page",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label: await autoCropPageCanvas(page),
        cropRect: null,
        sourceWidth: page.canvas.width,
        sourceHeight: page.canvas.height,
        variantName: `Text label page ${Number(page.pageIndex || 0) + 1}`,
        warnings: ["Text-based PDF label candidate; review before printing."],
        needsCrop: false,
        qualityScore: 2 + labelTextScore(page.text)
      });
    }

    return detections;
  }

  async function lowerContentLabelDetection(pages) {
    let best = null;

    for (const page of pages) {
      const regions = findBarcodeRegions(page.canvas).filter((region) => {
        const centerY = region.y + region.height / 2;
        return centerY > page.canvas.height * 0.55;
      });

      if (regions.length < 2) continue;
      const rect = findLowerContentRect(page.canvas, regions);
      if (!rect) continue;

      const score = regions.length + rect.width * rect.height / Math.max(1, page.canvas.width * page.canvas.height);
      if (!best || score > best.score) best = { page, rect, score, regions };
    }

    if (!best) return null;

    return {
      confidence: Math.min(0.9, 0.7 + best.regions.length * 0.04),
      reason: "lower-barcode-label",
      pageIndex: best.page.pageIndex,
      pageCount: getPageCount(pages),
      pages,
      label: await cropPageCanvas(best.page, best.rect),
      cropRect: best.rect,
      sourceWidth: best.page.canvas.width,
      sourceHeight: best.page.canvas.height
    };
  }

  async function fashionNovaLowerBarcodeDetection(pages) {
    let best = null;

    for (const page of pages) {
      if (!isFashionNovaText(page.text || "")) continue;

      const regions = findLowerBarcodeRegions(page.canvas, true);

      if (!regions.length) continue;
      const rect = findLowerContentRect(page.canvas, regions) || findLowerBarcodeOnlyRect(page.canvas, regions);
      if (!rect) continue;

      const score = regions.length + rect.width * rect.height / Math.max(1, page.canvas.width * page.canvas.height);
      if (!best || score > best.score) best = { page, rect, score, regions };
    }

    if (!best) return null;

    return {
      confidence: 0.91,
      reason: "fashion-nova-lower-barcode",
      pageIndex: best.page.pageIndex,
      pageCount: getPageCount(pages),
      pages,
      label: await cropPageCanvas(best.page, best.rect),
      cropRect: best.rect,
      sourceWidth: best.page.canvas.width,
      sourceHeight: best.page.canvas.height
    };
  }

  function normalizeText(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  function isFashionNovaText(text) {
    const normalized = normalizeText(text);
    if (FASHION_NOVA_PATTERN.test(normalized)) return true;

    const compact = normalized
      .toUpperCase()
      .replace(/[|!1]/g, "I")
      .replace(/0/g, "O")
      .replace(/5/g, "S")
      .replace(/[^A-Z0-9]/g, "");

    return FASHION_NOVA_COMPACT_PATTERNS.some((pattern) => pattern.test(compact));
  }

  function findLowerBarcodeRegions(canvas, relaxed) {
    const lowerRegions = findBarcodeRegions(canvas).filter((region) => {
      const centerY = region.y + region.height / 2;
      return centerY > canvas.height * 0.55;
    });
    if (lowerRegions.length || !relaxed) return lowerRegions;

    return findBarcodeRegionsInGrid(canvas, 8, 12, 22)
      .filter((region) => {
        const centerY = region.y + region.height / 2;
        return centerY > canvas.height * 0.55;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  }

  function findLowerContentRect(canvas, barcodeRegions) {
    const { width, height } = canvas;
    const data = getCanvasData(canvas);
    const lowerStart = Math.floor(height * 0.42);
    const whiteThreshold = 245;
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;

    for (let y = lowerStart; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const content = data[i] < whiteThreshold || data[i + 1] < whiteThreshold || data[i + 2] < whiteThreshold;
        if (!content) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }

    if (left >= right || top >= bottom) return null;

    const barcodeBox = unionRects(barcodeRegions);
    if (barcodeBox.y + barcodeBox.height < top || barcodeBox.y > bottom) return null;

    const padX = Math.round(width * 0.015);
    const padY = Math.round(height * 0.015);
    const x = Math.max(0, left - padX);
    const y = Math.max(0, top - padY);
    return {
      x,
      y,
      width: Math.min(width - x, right - left + padX * 2),
      height: Math.min(height - y, bottom - top + padY * 2)
    };
  }

  function findLowerBarcodeOnlyRect(canvas, barcodeRegions) {
    const barcodeBox = unionRects(barcodeRegions);
    return expandRect(barcodeBox, canvas, 1.1);
  }

  async function barcodeDetection(pages) {
    let best = null;

    for (const page of pages) {
      const regions = findBarcodeRegions(page.canvas);
      if (!best || regions.length > best.regions.length) best = { page, regions };
    }

    if (best && best.regions.length >= 2) {
      const box = unionRects(best.regions);
      const padX = Math.round(best.page.canvas.width * 0.20);
      const padY = Math.round(best.page.canvas.height * 0.20);
      const rx = Math.max(0, box.x - padX);
      const ry = Math.max(0, box.y - padY);
      const rect = {
        x: rx,
        y: ry,
        width: Math.min(best.page.canvas.width - rx, box.width + padX * 2),
        height: Math.min(best.page.canvas.height - ry, box.height + padY * 2)
      };
      return {
        confidence: Math.min(0.88, 0.66 + best.regions.length * 0.08),
        reason: "barcode-density",
        pageIndex: best.page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label: await cropPageCanvas(best.page, rect),
        cropRect: rect,
        sourceWidth: best.page.canvas.width,
        sourceHeight: best.page.canvas.height
      };
    }

    return null;
  }

  async function embeddedLabelPageFallbacks(pages) {
    const detections = [];
    const onlineReturnCenterDocument = isOnlineReturnCenterDocument(pages);

    for (const page of pages) {
      if (onlineReturnCenterDocument && isOnlineReturnAuthorizationSlip(page?.text)) continue;
      const regions = findBarcodeRegions(page.canvas);
      const text = String(page.text || "").toUpperCase();
      const looksLikeEmbeddedReturnPage = Number(page.embeddedImageCount || 0) > 0
        || regions.length >= 2
        || /RETURN AUTHORIZATION SLIP|PLACE THIS BARCODE|RETURN MAILING LABEL/.test(text);
      if (!looksLikeEmbeddedReturnPage) continue;

      const rect = regions.length >= 2
        ? clampRectAboveSlip(expandRect(unionRects(regions), page.canvas, 0.65), page)
        : null;
      const label = rect
        ? await cropPageCanvas(page, rect)
        : await autoCropPageCanvas(page);

      detections.push({
        confidence: 0.56,
        reason: "embedded-label-page",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label,
        cropRect: rect,
        sourceWidth: page.canvas.width,
        sourceHeight: page.canvas.height,
        variantName: `Embedded label page ${Number(page.pageIndex || 0) + 1}`,
        warnings: ["Embedded PDF label candidate; crop/rotate if needed before printing."],
        needsCrop: true,
        qualityScore: regions.length + labelTextScore(page.text)
      });
    }

    return detections;
  }

  function detectDashedBorder(canvas) {
    if (dashedBorderCache.has(canvas)) return dashedBorderCache.get(canvas);

    const result = detectDashedBorderUncached(canvas);
    dashedBorderCache.set(canvas, result);
    return result;
  }

  function detectSolidLabelBorder(canvas) {
    const { width, height } = canvas;
    const data = getCanvasData(canvas);
    const rowThreshold = width * 0.28;
    const colThreshold = height * 0.22;
    const rows = [];
    const cols = [];
    const stepY = Math.max(1, Math.floor(height / 900));
    const stepX = Math.max(1, Math.floor(width / 700));

    for (let y = 0; y < height; y += stepY) {
      let darkCount = 0;
      for (let x = 0; x < width; x += stepX) {
        if (isDark(data, (y * width + x) * 4)) darkCount += stepX;
      }
      if (darkCount >= rowThreshold) rows.push(y);
    }

    for (let x = 0; x < width; x += stepX) {
      let darkCount = 0;
      for (let y = 0; y < height; y += stepY) {
        if (isDark(data, (y * width + x) * 4)) darkCount += stepY;
      }
      if (darkCount >= colThreshold) cols.push(x);
    }

    const rowGroups = groupNearbyValues(rows, Math.max(3, stepY * 3));
    const colGroups = groupNearbyValues(cols, Math.max(3, stepX * 3));
    if (rowGroups.length < 2 || colGroups.length < 2) return null;

    const plausible = [];
    for (let topIndex = 0; topIndex < rowGroups.length - 1; topIndex += 1) {
      for (let bottomIndex = topIndex + 1; bottomIndex < rowGroups.length; bottomIndex += 1) {
        for (let leftIndex = 0; leftIndex < colGroups.length - 1; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < colGroups.length; rightIndex += 1) {
            const top = rowGroups[topIndex];
            const bottom = rowGroups[bottomIndex];
            const left = colGroups[leftIndex];
            const right = colGroups[rightIndex];
            const rect = {
              x: left.value,
              y: top.value,
              width: right.value - left.value,
              height: bottom.value - top.value
            };
            if (!looksLikeLabelRect(rect, canvas)) continue;
            plausible.push(rect);
          }
        }
      }
    }
    if (!plausible.length) return null;

    // A dense row/col of TEXT passes the dark-count threshold just like a
    // drawn line does, so the biggest box often has a phantom edge sitting on
    // a heading ("Additional Instructions…") instead of the label frame —
    // annexing the instruction block above the label. Require every edge of
    // the winning box to individually look like a drawn border line; fall back
    // to the old biggest-box pick when nothing qualifies (faint/scanned
    // borders must keep detecting).
    plausible.sort((a, b) => b.width * b.height - a.width * a.height);
    const qualified = plausible
      .slice(0, SOLID_BORDER_EDGE_CHECK_LIMIT)
      .find((rect) => minBorderEdgeDarkness(rect, canvas) >= SOLID_BORDER_MIN_EDGE_DARKNESS);
    return qualified || plausible[0];
  }

  // A printed border line is CONTINUOUS along its whole run. Phantom edges are
  // not: a heading underline tops a box whose sides only carry the real label
  // frame for part of their span (the stretch above the label is white), so
  // whole-edge averages still look decent (~0.8). Checking each edge in
  // quarter segments exposes the white stretch — every segment of every edge
  // must be mostly dark. The biggest-box fallback keeps faint/scanned borders
  // detecting as before.
  const SOLID_BORDER_MIN_EDGE_DARKNESS = 0.5;
  const SOLID_BORDER_EDGE_SEGMENTS = 4;
  const SOLID_BORDER_EDGE_CHECK_LIMIT = 12;

  // Weakest segment fraction across all four edges. Samples a 3px band so
  // group-centring drift and photo blur don't miss a thin line.
  function minBorderEdgeDarkness(rect, canvas) {
    const data = getCanvasData(canvas);
    const left = clamp(Math.round(rect.x), 0, canvas.width - 1);
    const right = clamp(Math.round(rect.x + rect.width), 0, canvas.width - 1);
    const top = clamp(Math.round(rect.y), 0, canvas.height - 1);
    const bottom = clamp(Math.round(rect.y + rect.height), 0, canvas.height - 1);
    const rowDark = (y, x) => {
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = clamp(y + dy, 0, canvas.height - 1);
        if (isDark(data, (yy * canvas.width + x) * 4)) return true;
      }
      return false;
    };
    const colDark = (x, y) => {
      for (let dx = -1; dx <= 1; dx += 1) {
        const xx = clamp(x + dx, 0, canvas.width - 1);
        if (isDark(data, (y * canvas.width + xx) * 4)) return true;
      }
      return false;
    };
    const edgeMinSegment = (length, test) => {
      const segment = Math.max(1, Math.floor(length / SOLID_BORDER_EDGE_SEGMENTS));
      let weakest = 1;
      for (let s = 0; s < SOLID_BORDER_EDGE_SEGMENTS; s += 1) {
        const from = s * segment;
        const to = s === SOLID_BORDER_EDGE_SEGMENTS - 1 ? length : from + segment;
        let dark = 0;
        let sampled = 0;
        for (let i = from; i <= to; i += 3) {
          if (test(i)) dark += 1;
          sampled += 1;
        }
        weakest = Math.min(weakest, dark / Math.max(1, sampled));
      }
      return weakest;
    };
    return Math.min(
      edgeMinSegment(right - left, (i) => rowDark(top, left + i)),
      edgeMinSegment(right - left, (i) => rowDark(bottom, left + i)),
      edgeMinSegment(bottom - top, (i) => colDark(left, top + i)),
      edgeMinSegment(bottom - top, (i) => colDark(right, top + i))
    );
  }

  function looksLikeLabelRect(rect, canvas) {
    if (rect.width < canvas.width * 0.28 || rect.height < canvas.height * 0.28) return false;
    if (rect.width * rect.height < canvas.width * canvas.height * 0.12) return false;
    const ratio = rect.height / Math.max(1, rect.width);
    return ratio >= LABEL_FRAME_MIN_ASPECT && ratio <= LABEL_FRAME_MAX_ASPECT;
  }

  function groupNearbyValues(values, tolerance) {
    const groups = [];
    for (const value of values) {
      const last = groups[groups.length - 1];
      if (last && value - last.end <= tolerance) {
        last.end = value;
        last.count += 1;
      } else {
        groups.push({ start: value, end: value, count: 1 });
      }
    }
    return groups
      .filter((group) => group.count >= 1)
      .map((group) => ({
        ...group,
        value: Math.round((group.start + group.end) / 2)
      }));
  }

  function detectDashedBorderUncached(canvas) {
    const { width, height } = canvas;
    const data = getCanvasData(canvas);
    const horizontalLines = [];
    const verticalLines = [];
    const minLine = Math.round(Math.min(width, height) * 0.35);
    const step = Math.max(1, Math.floor(Math.min(width, height) / 800));

    for (let y = 0; y < height; y += step) {
      const segments = darkSegmentsInRow(data, width, y, 0, width);
      const line = dashedLineFromSegments(segments, minLine);
      if (line) horizontalLines.push({ y, x1: line.start, x2: line.end, score: line.score });
    }

    for (let x = 0; x < width; x += step) {
      const segments = darkSegmentsInColumn(data, width, height, x, 0, height);
      const line = dashedLineFromSegments(segments, minLine);
      if (line) verticalLines.push({ x, y1: line.start, y2: line.end, score: line.score });
    }

    const h = clusterHorizontal(horizontalLines);
    const v = clusterVertical(verticalLines);

    for (let topIndex = 0; topIndex < h.length; topIndex += 1) {
      for (let bottomIndex = h.length - 1; bottomIndex > topIndex; bottomIndex -= 1) {
        const top = h[topIndex];
        const bottom = h[bottomIndex];
        if (bottom.y - top.y < height * 0.18) continue;

        for (let leftIndex = 0; leftIndex < v.length; leftIndex += 1) {
          for (let rightIndex = v.length - 1; rightIndex > leftIndex; rightIndex -= 1) {
            const left = v[leftIndex];
            const right = v[rightIndex];
            if (right.x - left.x < width * 0.25) continue;

            const aligns = Math.abs(top.x1 - left.x) < width * 0.08 &&
              Math.abs(bottom.x1 - left.x) < width * 0.08 &&
              Math.abs(top.x2 - right.x) < width * 0.08 &&
              Math.abs(bottom.x2 - right.x) < width * 0.08 &&
              Math.abs(left.y1 - top.y) < height * 0.08 &&
              Math.abs(right.y1 - top.y) < height * 0.08 &&
              Math.abs(left.y2 - bottom.y) < height * 0.08 &&
              Math.abs(right.y2 - bottom.y) < height * 0.08;

            if (aligns) {
              return {
                x: Math.max(0, left.x - 2),
                y: Math.max(0, top.y - 2),
                width: Math.min(width - left.x, right.x - left.x + 4),
                height: Math.min(height - top.y, bottom.y - top.y + 4)
              };
            }
          }
        }
      }
    }

    return null;
  }

  function darkSegmentsInRow(data, width, y, startX, endX) {
    const segments = [];
    let start = -1;
    for (let x = startX; x < endX; x += 1) {
      const dark = isDark(data, (y * width + x) * 4);
      if (dark && start === -1) start = x;
      if ((!dark || x === endX - 1) && start !== -1) {
        const end = dark && x === endX - 1 ? x : x - 1;
        if (end - start >= 3) segments.push([start, end]);
        start = -1;
      }
    }
    return segments;
  }

  function darkSegmentsInColumn(data, width, height, x, startY, endY) {
    const segments = [];
    let start = -1;
    for (let y = startY; y < endY; y += 1) {
      const dark = isDark(data, (y * width + x) * 4);
      if (dark && start === -1) start = y;
      if ((!dark || y === endY - 1) && start !== -1) {
        const end = dark && y === endY - 1 ? y : y - 1;
        if (end - start >= 3) segments.push([start, end]);
        start = -1;
      }
    }
    return segments;
  }

  function dashedLineFromSegments(segments, minSpan) {
    if (segments.length < 5) return null;

    let best = null;
    for (let i = 0; i < segments.length; i += 1) {
      let gaps = 0;
      let dark = 0;
      for (let j = i + 1; j < segments.length; j += 1) {
        const gap = segments[j][0] - segments[j - 1][1];
        const dash = segments[j][1] - segments[j][0];
        if (gap > 2 && gap < 60 && dash > 3 && dash < 80) gaps += 1;
        dark += dash;
        const span = segments[j][1] - segments[i][0];
        if (span >= minSpan && gaps >= 4) {
          const score = gaps + dark / span;
          if (!best || score > best.score) {
            best = { start: segments[i][0], end: segments[j][1], score };
          }
        }
      }
    }
    return best;
  }

  function clusterHorizontal(lines) {
    return cluster(lines, "y").map((group) => ({
      y: median(group.map((line) => line.y)),
      x1: median(group.map((line) => line.x1)),
      x2: median(group.map((line) => line.x2)),
      score: group.reduce((sum, line) => sum + line.score, 0)
    })).sort((a, b) => a.y - b.y);
  }

  function clusterVertical(lines) {
    return cluster(lines, "x").map((group) => ({
      x: median(group.map((line) => line.x)),
      y1: median(group.map((line) => line.y1)),
      y2: median(group.map((line) => line.y2)),
      score: group.reduce((sum, line) => sum + line.score, 0)
    })).sort((a, b) => a.x - b.x);
  }

  function cluster(lines, axis) {
    const sorted = lines.slice().sort((a, b) => a[axis] - b[axis]);
    const groups = [];
    for (const line of sorted) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(last[last.length - 1][axis] - line[axis]) < 6) last.push(line);
      else groups.push([line]);
    }
    return groups.filter((group) => group.length >= 2);
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function isDark(data, index) {
    return data[index] < 170 && data[index + 1] < 170 && data[index + 2] < 170 && data[index + 3] > 20;
  }

  // Local on purpose: outside the sidepanel (training studio, dev harnesses)
  // no global clamp exists, and this module's snap/border paths need one.
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function findBarcodeRegions(canvas) {
    if (!canvas) return [];
    const cached = barcodeRegionCache.get(canvas);
    if (cached) return cached;
    const regions = findBarcodeRegionsInGrid(canvas, 6, 8, 30);
    barcodeRegionCache.set(canvas, regions);
    return regions;
  }

  function findBarcodeRegionsInGrid(canvas, cols, rows, threshold) {
    const { width, height } = canvas;
    const data = getCanvasData(canvas);
    const regions = [];

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = Math.floor((col / cols) * width);
        const y = Math.floor((row / rows) * height);
        const w = Math.floor(width / cols);
        const h = Math.floor(height / rows);
        const score = barcodeTransitionScore(data, width, x, y, w, h);
        if (score > threshold) regions.push({ x, y, width: w, height: h, score });
      }
    }

    return regions;
  }

  function findBarcodeBoundingBox(canvas) {
    const regions = findBarcodeRegions(canvas);
    return regions.length ? unionRects(regions) : null;
  }

  // Fine barcode grid (matches suggestLabelRect's resolution), memoized per canvas.
  const fineBarcodeRegionCache = new WeakMap();
  function findFineBarcodeRegions(canvas) {
    let regions = fineBarcodeRegionCache.get(canvas);
    if (regions) return regions;
    regions = findBarcodeRegionsInGrid(canvas, 8, 12, 22);
    fineBarcodeRegionCache.set(canvas, regions);
    return regions;
  }

  // A border detector locks onto the printed label frame, but on many USPS labels
  // the data matrix / a barcode sits right at or just outside that frame and gets
  // clipped. Grow the detected crop outward to include any barcode cell that the
  // crop is clipping — but only cells within `margin` of the crop, so a separate
  // barcode elsewhere on the page (e.g. a packing slip) is not swallowed.
  function expandRectToClippedBarcodes(rect, canvas) {
    if (!rect || !canvas) return rect;
    const regions = findFineBarcodeRegions(canvas);
    if (!regions.length) return rect;

    const margin = Math.round(Math.min(canvas.width, canvas.height) * 0.06);
    let left = rect.x;
    let top = rect.y;
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    const bandLeft = left - margin;
    const bandTop = top - margin;
    const bandRight = right + margin;
    const bandBottom = bottom + margin;
    let grew = false;

    for (const region of regions) {
      const rl = region.x;
      const rt = region.y;
      const rr = region.x + region.width;
      const rb = region.y + region.height;
      // Skip barcode cells that aren't near this crop — not part of this label.
      if (rr < bandLeft || rl > bandRight || rb < bandTop || rt > bandBottom) continue;
      if (rl < left) { left = rl; grew = true; }
      if (rt < top) { top = rt; grew = true; }
      if (rr > right) { right = rr; grew = true; }
      if (rb > bottom) { bottom = rb; grew = true; }
    }

    if (!grew) return rect;
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(canvas.width, right);
    bottom = Math.min(canvas.height, bottom);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // A page whose own aspect is ~4:6 (or ~6:4) IS a single label. On these,
  // a border detector that locks onto an internal dashed/solid line and crops
  // to a sub-region is wrong (the "zoomed in too deep" symptom) — the whole
  // auto-trimmed page is the label.
  const LABEL_PAGE_ASPECT_TOL = 0.03;
  const FULL_PAGE_LABEL_AREA_RATIO = 0.85;
  function isLabelShapedPage(canvas) {
    if (!canvas) return false;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const portrait = 4 / 6;
    return Math.abs(aspect - portrait) <= LABEL_PAGE_ASPECT_TOL
      || Math.abs(aspect - 1 / portrait) <= LABEL_PAGE_ASPECT_TOL;
  }

  // When a border crop is suspiciously small on a label-shaped page, returns a
  // full-page auto-cropped detection to use instead; otherwise null.
  async function fullPageLabelIfShaped(page, pages, rect) {
    const areaRatio = (rect.width * rect.height) / Math.max(1, page.canvas.width * page.canvas.height);
    if (!isLabelShapedPage(page.canvas) || areaRatio >= FULL_PAGE_LABEL_AREA_RATIO) return null;
    return {
      confidence: 0.9,
      reason: "label-shaped-page",
      pageIndex: page.pageIndex,
      pageCount: getPageCount(pages),
      pages,
      label: await autoCropPageCanvas(page),
      cropRect: null,
      sourceWidth: page.canvas.width,
      sourceHeight: page.canvas.height,
      qualityScore: 3.5
    };
  }

  function suggestLabelRect(canvas, pageText = "") {
    if (!canvas) return null;
    const barcodeRegions = findBarcodeRegionsInGrid(canvas, 8, 12, 22);
    if (!barcodeRegions.length) return detectDashedBorder(canvas) || detectSolidLabelBorder(canvas);

    const barcodeBox = unionRects(barcodeRegions);
    const candidates = [
      { rect: detectDashedBorder(canvas), kind: "dashed-border" },
      { rect: detectSolidLabelBorder(canvas), kind: "solid-border" },
      { rect: labelShapedRectAroundBarcode(barcodeBox, canvas, "portrait"), kind: "portrait-4x6" },
      { rect: labelShapedRectAroundBarcode(barcodeBox, canvas, "landscape"), kind: "landscape-4x6" }
    ].filter((candidate) => candidate.rect && rectContainsAnyBarcode(candidate.rect, barcodeRegions));

    return candidates
      .map((candidate) => ({
        ...candidate,
        score: snapCandidateScore(candidate.rect, candidate.kind, barcodeRegions, canvas, pageText)
      }))
      .sort((a, b) => b.score - a.score)[0]?.rect || null;
  }

  function labelShapedRectAroundBarcode(barcodeBox, canvas, orientation) {
    const landscape = orientation === "landscape";
    const targetAspect = landscape ? 6 / 4 : 4 / 6;
    let width = landscape
      ? Math.max(barcodeBox.width * 1.35, canvas.width * 0.42)
      : Math.max(barcodeBox.width * 1.7, canvas.width * 0.34);
    let height = width / targetAspect;

    if (height < barcodeBox.height * 2.6) {
      height = barcodeBox.height * 2.6;
      width = height * targetAspect;
    }
    if (width > canvas.width * 0.96) {
      width = canvas.width * 0.96;
      height = width / targetAspect;
    }
    if (height > canvas.height * 0.96) {
      height = canvas.height * 0.96;
      width = height * targetAspect;
    }

    const centerX = barcodeBox.x + barcodeBox.width / 2;
    const centerY = barcodeBox.y + barcodeBox.height / 2;
    const x = clamp(centerX - width / 2, 0, canvas.width - width);
    const y = clamp(centerY - height * 0.72, 0, canvas.height - height);
    return { x, y, width, height };
  }

  function snapCandidateScore(rect, kind, barcodeRegions, canvas, pageText) {
    const aspect = rect.width / Math.max(1, rect.height);
    const aspectError = Math.min(Math.abs(aspect - 4 / 6), Math.abs(aspect - 6 / 4));
    const areaRatio = rect.width * rect.height / Math.max(1, canvas.width * canvas.height);
    const barcodeCoverage = barcodeRegions.filter((region) => rectContainsAnyBarcode(rect, [region])).length;
    const blackLineScore = borderLineScore(rect, canvas);
    const borderBonus = kind.includes("border") && blackLineScore >= 0.28 ? 7 : 0;
    const textBonus = /USPS|UPS|FEDEX|TRACKING|SHIP TO|SHIP FROM|GROUND ADVANTAGE|PRIORITY MAIL/i.test(pageText || "") ? 2 : 0;
    const areaPenalty = areaRatio < 0.08 || areaRatio > 0.92 ? 4 : 0;
    return barcodeCoverage * 2 + borderBonus + blackLineScore * 4 + textBonus - aspectError * 5 - areaPenalty;
  }

  function borderLineScore(rect, canvas) {
    const data = getCanvasData(canvas);
    const left = clamp(Math.round(rect.x), 0, canvas.width - 1);
    const right = clamp(Math.round(rect.x + rect.width), 0, canvas.width - 1);
    const top = clamp(Math.round(rect.y), 0, canvas.height - 1);
    const bottom = clamp(Math.round(rect.y + rect.height), 0, canvas.height - 1);
    let dark = 0;
    let sampled = 0;

    for (let x = left; x <= right; x += 3) {
      dark += isDark(data, (top * canvas.width + x) * 4) ? 1 : 0;
      dark += isDark(data, (bottom * canvas.width + x) * 4) ? 1 : 0;
      sampled += 2;
    }
    for (let y = top; y <= bottom; y += 3) {
      dark += isDark(data, (y * canvas.width + left) * 4) ? 1 : 0;
      dark += isDark(data, (y * canvas.width + right) * 4) ? 1 : 0;
      sampled += 2;
    }
    return dark / Math.max(1, sampled);
  }

  // Barcodes read as a run of dark/light transitions perpendicular to their bars.
  // A normal portrait label scans best horizontally; a label rotated 90° (common
  // on UPS/return PDFs where the label image is placed sideways) scans best
  // vertically. Score both directions and keep the stronger one so a rotated
  // label is still recognized instead of falling through to a manual crop.
  function barcodeTransitionScore(data, imageWidth, x, y, width, height) {
    return Math.max(
      directionalTransitionScore(data, imageWidth, x, y, width, height, "horizontal"),
      directionalTransitionScore(data, imageWidth, x, y, width, height, "vertical")
    );
  }

  function directionalTransitionScore(data, imageWidth, x, y, width, height, axis) {
    const horizontal = axis === "horizontal";
    const lineCount = horizontal ? height : width;
    const scanLength = horizontal ? width : height;
    const step = Math.max(1, Math.floor(lineCount / 20));
    let linesSampled = 0;
    let totalTransitions = 0;

    for (let line = 0; line < lineCount; line += step) {
      let transitions = 0;
      let previous = null;
      for (let pos = 0; pos < scanLength; pos += 1) {
        const px = horizontal ? x + pos : x + line;
        const py = horizontal ? y + line : y + pos;
        const i = (py * imageWidth + px) * 4;
        const dark = data[i] + data[i + 1] + data[i + 2] < 360;
        if (previous !== null && dark !== previous) transitions += 1;
        previous = dark;
      }
      totalTransitions += transitions / Math.max(1, scanLength / 100);
      linesSampled += 1;
    }

    return totalTransitions / Math.max(1, linesSampled);
  }

  function unionRects(rects) {
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function expandRect(rect, canvas, amount) {
    const growX = rect.width * amount;
    const growY = rect.height * amount;
    const x = Math.max(0, rect.x - growX);
    const y = Math.max(0, rect.y - growY);
    return {
      x,
      y,
      width: Math.min(canvas.width - x, rect.width + growX * 2),
      height: Math.min(canvas.height - y, rect.height + growY * 2)
    };
  }

  window.LabelExtractorDetector = {
    detectPdfPages,
    detectPdfCandidates,
    detectPngPages,
    detectAllPngCandidates,
    suggestLabelRect,
    findBarcodeRegions,
    // Dev training studio hooks (no-op in production — traceSink stays null):
    setTraceSink,
    clearTrace,
    guessCarrier,
    detectionRankScore,
    scoreBreakdown
  };
})();
