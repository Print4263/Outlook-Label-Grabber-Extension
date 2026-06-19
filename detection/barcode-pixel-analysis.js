(function () {
  "use strict";

  function create({ getCanvasData }) {
    // Memoizes the default-grid barcode scan per canvas. The cascade asks the same
    // page.canvas for its barcode regions from many detectors; without this each
    // call repeats a full getImageData + transition scan.
    const barcodeRegionCache = new WeakMap();

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
    // crop is clipping, but only cells within `margin` of the crop, so a separate
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
        // Skip barcode cells that aren't near this crop - not part of this label.
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

    // Barcodes read as a run of dark/light transitions perpendicular to their bars.
    // A normal portrait label scans best horizontally; a label rotated 90 degrees
    // (common on UPS/return PDFs where the label image is placed sideways) scans best
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

    return {
      findBarcodeRegions,
      findBarcodeRegionsInGrid,
      expandRectToClippedBarcodes
    };
  }

  window.LabelExtractorBarcodePixelAnalysis = { create };
})();
