(function () {
  "use strict";

  const { isOnlineReturnAuthorizationSlip } = window.LabelExtractorPageText;

  function create({ findBarcodeRegions, getPageCount }) {
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

    return {
      embeddedUspsLabelDetection,
      embeddedImageLabelDetections
    };
  }

  window.LabelExtractorEmbeddedImageDetectors = { create };
})();
