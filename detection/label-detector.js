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

  const ONLINE_RETURN_LABEL_ASPECT = 1200 / 1800;
  const ONLINE_RETURN_TOP_TRIM_RATIO = 0;
  const ONLINE_RETURN_BOTTOM_PAD_RATIO = 0.12;
  const BARCODE_EXCLUSION_PENALTY = -5;

  const {
    getCanvasData,
    detectDashedBorder,
    detectSolidLabelBorder,
    findBarcodeRegions,
    findBarcodeRegionsInGrid,
    expandRectToClippedBarcodes,
    borderLineScore,
    contentSeparationScore
  } = window.LabelExtractorPixelAnalysis;
  const {
    isOrderDetailsText,
    labelTextScore,
    declaresLabelPage,
    instructionTextScore,
    hasStrongLabelCue,
    isLikelyTextInstructionPage,
    isUpsLabelText,
    isReturnMailingLabelPage,
    isOnlineReturnAuthorizationSlip,
    isOnlineReturnMailingLabelPage,
    isOnlineReturnCenterDocument,
    normalizeText,
    isFashionNovaText
  } = window.LabelExtractorPageText;
  const EMBEDDED_USPS_BORDER_OVERRIDE_CONFIDENCE = 0.97;
  const {
    embeddedUspsLabelDetection,
    embeddedImageLabelDetections
  } = window.LabelExtractorEmbeddedImageDetectors.create({
    findBarcodeRegions,
    getPageCount
  });

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
      && (!isBorderReason(strongEarly?.reason) || labelShapeRankScore(strongEarly) >= 0.4)
      && !shouldPreferCarrierText(strongEarly, pages)
      && !isTallOverstuffedBorder(strongEarly, pages)
      && cropContainsBarcodeOrUnknown(strongEarly, pages)) {
      trace("early-exit", { detector: strongEarly.reason, reason: strongEarly.reason, confidence: Number(strongEarly.confidence || 0), score: detectionRankScore(strongEarly), note: "deterministic hit >=0.95 short-circuited the ONNX model" });
      // Same speed win (model + later stages skipped), but keep the other
      // candidates computed so far: when the strong hit boxes the wrong region
      // (e.g. a dashed frame around instructions + label), the picker still
      // offers the alternatives instead of a single take-it-or-leave-it crop.
      return await confirmBarcodeSignal(rankedEarly, pages);
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

    const ranked = await confirmBarcodeSignal(rankedDetections(candidates, pages), pages);
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
  // Shared by candidate selection and barcode-confirmation card refinement.

  const SCREENSHOT_PAGE_MIN_ASPECT = 1.8;          // page h/w
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
    const ranked = await confirmBarcodeSignal(rankedDetections(candidates, pages), pages);
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
      const expanded = clampImageChromeRect(page, expandToLabelLikeRect(rect, page.canvas));
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

  function clampImageChromeRect(page, rect) {
    if (!rect || page?.type !== "png" || !page?.canvas || !window.LabelExtractorCrop?.trimImageChromeBands) return rect;
    const next = window.LabelExtractorCrop.trimImageChromeBands(page.canvas, rect);
    if (next && (next.x !== rect.x || next.y !== rect.y || next.width !== rect.width || next.height !== rect.height)) {
      trace("image-chrome-trim", {
        from: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(","),
        to: [Math.round(next.x), Math.round(next.y), Math.round(next.width), Math.round(next.height)].join(",")
      });
    }
    return next || rect;
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
      let rect = clampRectAboveSlip(
        knownOnlineReturnForm ? borderRect : expandRectToClippedBarcodes(borderRect, page.canvas),
        page
      );
      rect = clampImageChromeRect(page, rect);
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

  async function solidBorderLabelDetections(pages) {
    const detections = [];

    for (const page of pages) {
      const borderRect = detectSolidLabelBorder(page.canvas);
      if (!borderRect) continue;
      const rect = clampImageChromeRect(page, clampRectAboveSlip(expandRectToClippedBarcodes(borderRect, page.canvas), page));

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

  function shouldBorderOverrideEmbeddedUsps(borderCandidate, otherCandidate) {
    if (otherCandidate?.reason !== "embedded-usps-label") return false;
    if (!["dashed-border", "solid-border"].includes(borderCandidate?.reason)) return false;
    if (Number(borderCandidate.confidence || 0) < EMBEDDED_USPS_BORDER_OVERRIDE_CONFIDENCE) return false;
    return cropContainsBarcodeOrUnknown(borderCandidate, borderCandidate.pages || []);
  }

  // A 4x6 thermal label prints best when the crop already IS 4x6-shaped
  // (either orientation — landscape sources are auto-rotated). Reward crops
  // whose final output is label-shaped and penalize extreme aspect ratios
  // (full phone screenshots, banner strips) so a clean 4x6 candidate sits
  // above them in the picker. Sized to order border/model candidates
  // (quality 2-4) without upsetting the embedded-label hierarchy (10+).
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
    if (!isBorderReason(candidate?.reason) || !candidate.cropRect) return false;
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
      if (!isBorderReason(candidate.reason)) continue;
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
    const carrier = window.LabelExtractorCarrier?.guessCarrier(page && page.text, {
      includeGenericNumbers: true,
      includeMarketplaces: true
    }) || "";
    if (carrier) result.carrier = carrier;
    return result;
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

  // Local on purpose: outside the sidepanel (training studio, dev harnesses)
  // no global clamp exists, and this module's snap path needs one.
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function findBarcodeBoundingBox(canvas) {
    const regions = findBarcodeRegions(canvas);
    return regions.length ? unionRects(regions) : null;
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

  const {
    compareDetections,
    detectionRankScore,
    scoreBreakdown,
    labelShapeRankScore
  } = window.LabelExtractorDetectorRanking.create({
    findPage,
    labelTextScore,
    carrierTextPreferenceScore,
    barcodeContainmentPenalty,
    orderDetailsPagePenalty,
    shouldBorderOverrideEmbeddedUsps
  });

  const { rankedDetections, isBorderReason } = window.LabelExtractorCandidateSelection.create({
    dedupeDetections,
    isLikelyTextInstructionPage,
    isOrderDetailsText,
    findPage,
    compareDetections,
    detectionRankScore,
    labelShapeRankScore,
    contentSeparationScore,
    trace,
    screenshotPageMinAspect: SCREENSHOT_PAGE_MIN_ASPECT
  });
  const { confirmBarcodeSignal } = window.LabelExtractorBarcodeConfirmation.create({
    findPage,
    findBarcodeRegions,
    unionRects,
    expandRect,
    detectionRankScore,
    contentSeparationScore,
    trace,
    screenshotPageMinAspect: SCREENSHOT_PAGE_MIN_ASPECT
  });
  const {
    keywordDetection,
    textLabelPageFallbacks,
    lowerContentLabelDetection,
    fashionNovaLowerBarcodeDetection
  } = window.LabelExtractorPdfTextDetectors.create({
    getPageCount,
    cropPageCanvas,
    autoCropPageCanvas,
    findBarcodeBoundingBox,
    unionRects,
    expandRect,
    findBarcodeRegions,
    findBarcodeRegionsInGrid,
    getCanvasData
  });
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
    guessCarrier: (text) => window.LabelExtractorCarrier?.guessCarrier(text, {
      includeGenericNumbers: true,
      includeMarketplaces: true
    }) || "",
    detectionRankScore,
    scoreBreakdown
  };
})();
