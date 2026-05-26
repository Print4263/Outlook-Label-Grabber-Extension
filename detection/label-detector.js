(function () {
  "use strict";

  const CONFIDENCE_THRESHOLD = 0.72;
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
  const dashedBorderCache = new WeakMap();

  async function detectPdfPages(pages) {
    const candidates = await detectPdfCandidates(pages);
    return candidates[0] || emptyPdfResult(pages);
  }

  async function detectPdfCandidates(pages) {
    if (!pages.length) return [];

    const candidates = [];

    candidates.push(...await dashedBorderLabelDetections(pages));
    candidates.push(...await solidBorderLabelDetections(pages));

    const labelSizedHit = await labelSizedPageDetection(pages);
    if (labelSizedHit) candidates.push(labelSizedHit);

    const strongEarly = rankedDetections(candidates, pages)[0];
    if (Number(strongEarly?.confidence || 0) >= 0.95 && !shouldPreferCarrierText(strongEarly, pages)) return [strongEarly];

    const modelHit = await trainedModelDetection(pages);
    if (modelHit) candidates.push(modelHit);

    const fashionNovaHit = await fashionNovaLowerBarcodeDetection(pages);
    if (fashionNovaHit) candidates.push(fashionNovaHit);

    const lowerLabelHit = await lowerContentLabelDetection(pages);
    if (lowerLabelHit) candidates.push(lowerLabelHit);

    const keywordHit = await keywordDetection(pages);
    if (keywordHit) candidates.push(keywordHit);

    const barcodeHit = await barcodeDetection(pages);
    if (barcodeHit) candidates.push(barcodeHit);

    candidates.push(...await textLabelPageFallbacks(pages));
    candidates.push(...await embeddedLabelPageFallbacks(pages));

    if (!candidates.length && pages.length === 1) {
      candidates.push({
        confidence: 0.74,
        reason: "single-page-pdf",
        pageIndex: 0,
        pageCount: 1,
        pages,
        label: await window.LabelExtractorCrop.autoCropCanvas(pages[0].canvas)
      });
    }

    return rankedDetections(candidates, pages);
  }

  function rankedDetections(candidates, pages) {
    return dedupeDetections(candidates)
      .filter((candidate) => !isLikelyTextInstructionPage(findPage(candidate.pages || pages, candidate.pageIndex), candidate.reason))
      .sort(compareDetections);
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
    if (borderHits[0]) return borderHits[0];

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

    candidates.push(...await dashedBorderLabelDetections(pages));
    candidates.push(...await solidBorderLabelDetections(pages));

    const modelHit = await trainedModelDetection(pages);
    if (modelHit) candidates.push(modelHit);

    const keywordHit = await keywordDetection(pages);
    if (keywordHit) candidates.push(keywordHit);

    const barcodeHit = await barcodeDetection(pages);
    if (barcodeHit) candidates.push(barcodeHit);

    candidates.push(...await imageLabelFallbacks(pages));

    if (!candidates.length) {
      const fallback = await detectPngPages(pages);
      if (fallback?.label) candidates.push(fallback);
    }

    if (!candidates.length) {
      const manualFallback = await manualImageFallback(pages);
      if (manualFallback?.label) candidates.push(manualFallback);
    }

    return dedupeDetections(candidates).sort(compareDetections);
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
      label: await window.LabelExtractorCrop.autoCropCanvas(page.canvas, 24),
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
        label: await window.LabelExtractorCrop.cropCanvas(page.canvas, expanded),
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

  async function labelSizedPageDetection(pages) {
    for (const page of pages) {
      if (!isLabelSizedPage(page.naturalWidth, page.naturalHeight)) continue;
      return {
        confidence: 0.96,
        reason: "page-dimensions",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label: await window.LabelExtractorCrop.autoCropCanvas(page.canvas)
      };
    }
    return null;
  }

  async function dashedBorderLabelDetections(pages) {
    const detections = [];
    for (const page of pages) {
      const rect = detectDashedBorder(page.canvas);
      if (!rect) continue;
      const areaRatio = (rect.width * rect.height) / Math.max(1, page.canvas.width * page.canvas.height);
      if (areaRatio < 0.08) continue;
      detections.push({
        confidence: 0.97,
        reason: "dashed-border",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label: await window.LabelExtractorCrop.cropCanvas(page.canvas, rect),
        cropRect: rect,
        sourceWidth: page.canvas.width,
        sourceHeight: page.canvas.height,
        qualityScore: 3
      });
    }
    return detections;
  }

  async function solidBorderLabelDetections(pages) {
    const detections = [];

    for (const page of pages) {
      const rect = detectSolidLabelBorder(page.canvas);
      if (!rect) continue;

      const areaRatio = rect.width * rect.height / Math.max(1, page.canvas.width * page.canvas.height);
      const score = areaRatio + labelTextScore(page.text) + (page.pageIndex || 0) * 0.01;
      detections.push({
        confidence: Math.min(0.97, 0.88 + score * 0.02),
        reason: "solid-border",
        pageIndex: page.pageIndex,
        pageCount: getPageCount(pages),
        pages,
        label: await window.LabelExtractorCrop.cropCanvas(page.canvas, rect),
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
    return score;
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
    const scoreA = detectionRankScore(a);
    const scoreB = detectionRankScore(b);
    return scoreB - scoreA;
  }

  function detectionRankScore(candidate) {
    const page = findPage(candidate.pages || [], candidate.pageIndex);
    return Number(candidate.qualityScore || 0)
      + Number(candidate.confidence || 0)
      + labelTextScore(page?.text)
      + carrierTextPreferenceScore(candidate, page);
  }

  function shouldPreferCarrierText(candidate, pages) {
    const page = findPage(candidate.pages || [], candidate.pageIndex) || findPage(pages || [], candidate.pageIndex);
    return candidate?.reason === "dashed-border" && isUpsLabelText(page?.text);
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

  async function trainedModelDetection(pages) {
    if (!window.LabelExtractorModelDetector) return null;
    try {
      return withCarrierMetadata(await window.LabelExtractorModelDetector.detectPages(pages), pages);
    } catch (error) {
      console.warn("[Label Extractor] Trained model detection failed", error);
      return null;
    }
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
      const label = rect ? await window.LabelExtractorCrop.cropCanvas(best.page.canvas, rect) : await window.LabelExtractorCrop.autoCropCanvas(best.page.canvas);
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
        label: await window.LabelExtractorCrop.autoCropCanvas(page.canvas),
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
      label: await window.LabelExtractorCrop.cropCanvas(best.page.canvas, best.rect),
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
      label: await window.LabelExtractorCrop.cropCanvas(best.page.canvas, best.rect),
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
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
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
        label: await window.LabelExtractorCrop.cropCanvas(best.page.canvas, rect),
        cropRect: rect,
        sourceWidth: best.page.canvas.width,
        sourceHeight: best.page.canvas.height
      };
    }

    return null;
  }

  async function embeddedLabelPageFallbacks(pages) {
    const detections = [];

    for (const page of pages) {
      const regions = findBarcodeRegions(page.canvas);
      const text = String(page.text || "").toUpperCase();
      const looksLikeEmbeddedReturnPage = Number(page.embeddedImageCount || 0) > 0
        || regions.length >= 2
        || /RETURN AUTHORIZATION SLIP|PLACE THIS BARCODE|RETURN MAILING LABEL/.test(text);
      if (!looksLikeEmbeddedReturnPage) continue;

      const rect = regions.length >= 2
        ? expandRect(unionRects(regions), page.canvas, 0.65)
        : null;
      const label = rect
        ? await window.LabelExtractorCrop.cropCanvas(page.canvas, rect)
        : await window.LabelExtractorCrop.autoCropCanvas(page.canvas);

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
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
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

    let best = null;
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
            const score = rect.width * rect.height;
            if (!best || score > best.score) best = { rect, score };
          }
        }
      }
    }

    return best && best.rect;
  }

  function looksLikeLabelRect(rect, canvas) {
    if (rect.width < canvas.width * 0.28 || rect.height < canvas.height * 0.28) return false;
    if (rect.width * rect.height < canvas.width * canvas.height * 0.12) return false;
    const ratio = rect.height / Math.max(1, rect.width);
    return ratio >= 1.1 && ratio <= 2.4;
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
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { width, height, data } = image;
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

  function findBarcodeRegions(canvas) {
    return findBarcodeRegionsInGrid(canvas, 6, 8, 30);
  }

  function findBarcodeRegionsInGrid(canvas, cols, rows, threshold) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
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

  function barcodeTransitionScore(data, imageWidth, x, y, width, height) {
    let rowsSampled = 0;
    let totalTransitions = 0;
    const rowStep = Math.max(1, Math.floor(height / 20));

    for (let yy = y; yy < y + height; yy += rowStep) {
      let transitions = 0;
      let previous = null;
      for (let xx = x; xx < x + width; xx += 1) {
        const i = (yy * imageWidth + xx) * 4;
        const dark = data[i] + data[i + 1] + data[i + 2] < 360;
        if (previous !== null && dark !== previous) transitions += 1;
        previous = dark;
      }
      totalTransitions += transitions / Math.max(1, width / 100);
      rowsSampled += 1;
    }

    return totalTransitions / Math.max(1, rowsSampled);
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
    CONFIDENCE_THRESHOLD,
    detectPdfPages,
    detectPdfCandidates,
    detectPngPages,
    detectAllPngCandidates,
    detectDashedBorder,
    findBarcodeRegions
  };
})();
