(function () {
  "use strict";

  // ===========================================================================
  // PDF text-layer detectors — keyword / text-label-page / lower-barcode /
  // Fashion Nova fallbacks. Extracted verbatim from label-detector.js
  // (behaviour-neutral). Factory: label-detector creates the instance at load
  // and injects the crop/pixel/geometry helpers it owns; page-text cues come
  // from window.LabelExtractorPageText.
  // ===========================================================================

  function create(deps) {
    const {
      getPageCount,
      cropPageCanvas,
      autoCropPageCanvas,
      findBarcodeBoundingBox,
      unionRects,
      expandRect,
      findBarcodeRegions,
      findBarcodeRegionsInGrid,
      getCanvasData
    } = deps;
    const {
      isReturnMailingLabelPage,
      hasStrongLabelCue,
      instructionTextScore,
      labelTextScore,
      isFashionNovaText
    } = window.LabelExtractorPageText;

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

    return {
      keywordDetection,
      textLabelPageFallbacks,
      lowerContentLabelDetection,
      fashionNovaLowerBarcodeDetection
    };
  }

  window.LabelExtractorPdfTextDetectors = { create };
})();
