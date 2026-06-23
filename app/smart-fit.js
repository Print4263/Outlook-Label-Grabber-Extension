// Smart fit (prototype, Approach A) — structure-aware crop that builds the 4x6
// label rectangle from its real landmarks (the tracking barcode + the dark
// content box) instead of nibbling all four edges blindly. The pure geometry
// (smartFit4x6Rect) is node-testable; the canvas helper (barcodeBoxWithin)
// reuses the existing barcode-pixel-analysis grid scan. App-layer only: nothing
// here runs in the automatic detection path, so it cannot change the 65/65 gate.
(function (global) {
  "use strict";

  const TARGET_ASPECT = 4 / 6;            // 4x6 portrait, width / height
  const BARCODE_WIDTH_FRACTION = 0.9;     // the tracking barcode spans ~90% of label width
  const BOTTOM_MARGIN_FRACTION = 0.06;    // label edge sits just below the barcode

  function roundRect(rect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function clampRect(rect, width, height) {
    const x = Math.max(0, Math.min(rect.x, width));
    const y = Math.max(0, Math.min(rect.y, height));
    const right = Math.max(x, Math.min(rect.x + rect.width, width));
    const bottom = Math.max(y, Math.min(rect.y + rect.height, height));
    return { x, y, width: right - x, height: bottom - y };
  }

  // Grow the shorter dimension so the rect matches the target aspect, keeping its
  // center fixed. Growing (never shrinking) guarantees the landmark stays inside.
  function growToAspect(rect, aspect) {
    let { x, y, width, height } = rect;
    const cx = x + width / 2;
    const cy = y + height / 2;
    if (width / height > aspect) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
    return { x: cx - width / 2, y: cy - height / 2, width, height };
  }

  // Build the 4x6 label rectangle from landmarks (all in source/page pixels):
  //   barcodeRect  - tracking barcode bbox, or null
  //   contentRect  - dark-content box within the base crop, or null
  //   baseRect     - the current auto-crop (required for bounds/fallback)
  // When a horizontal barcode is known, the label is reconstructed from it (so a
  // packing slip beside the label is left out); otherwise it falls back to the
  // minimal 4x6 that contains the content box. Returns null when unusable.
  function smartFit4x6Rect(opts) {
    const sourceWidth = Number(opts && opts.sourceWidth) || 0;
    const sourceHeight = Number(opts && opts.sourceHeight) || 0;
    const aspect = Number(opts && opts.targetAspect) || TARGET_ASPECT;
    const base = opts && opts.baseRect;
    const content = (opts && opts.contentRect) || null;
    const barcode = (opts && opts.barcodeRect) || null;
    if (!sourceWidth || !sourceHeight || !base) return null;

    let fit;
    const hasBarcode = barcode && barcode.width > 0 && barcode.height > 0;
    if (hasBarcode && barcode.width >= barcode.height) {
      // Upright label: the tracking barcode is horizontal, spans ~90% of the
      // label width, and sits near the bottom. Build the 4x6 from it.
      const labelWidth = barcode.width / BARCODE_WIDTH_FRACTION;
      const labelHeight = labelWidth / aspect;
      const centerX = barcode.x + barcode.width / 2;
      const bottom = barcode.y + barcode.height + labelHeight * BOTTOM_MARGIN_FRACTION;
      fit = {
        x: centerX - labelWidth / 2,
        y: bottom - labelHeight,
        width: labelWidth,
        height: labelHeight
      };
    } else if (hasBarcode) {
      // Sideways label (its barcode reads vertical): the label is rotated 90 in a
      // wide page, often flanked by packing-slip text on both sides. Build a
      // LANDSCAPE 4x6 anchored on the barcode so the slips are excluded; the
      // downstream orientation pass turns the crop upright. Centered on the
      // barcode is approximate (the label extends mostly to one side), but it is
      // bounded to ~label size instead of grabbing the whole content box + slips.
      const labelShort = barcode.height / BARCODE_WIDTH_FRACTION; // 4in side, now vertical
      const labelLong = labelShort / aspect;                      // 6in side, now horizontal
      const centerX = barcode.x + barcode.width / 2;
      const centerY = barcode.y + barcode.height / 2;
      fit = {
        x: centerX - labelLong / 2,
        y: centerY - labelShort / 2,
        width: labelLong,
        height: labelShort
      };
    } else if (content && content.width > 0 && content.height > 0) {
      fit = growToAspect(content, aspect);
    } else {
      return null;
    }

    fit = clampRect(fit, sourceWidth, sourceHeight);
    if (fit.width < 1 || fit.height < 1) return null;
    return roundRect(fit);
  }

  // --- Canvas-side barcode location (browser only) ---------------------------

  let analyzer = null;
  function getAnalyzer() {
    if (analyzer) return analyzer;
    const lib = typeof window !== "undefined" && window.LabelExtractorBarcodePixelAnalysis;
    if (!lib) return null;
    const getCanvasData = (canvas) =>
      canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    analyzer = lib.create({ getCanvasData });
    return analyzer;
  }

  function regionCenterInside(region, rect) {
    if (!rect) return true;
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
  }

  function unionRegions(regions) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of regions) {
      left = Math.min(left, r.x);
      top = Math.min(top, r.y);
      right = Math.max(right, r.x + r.width);
      bottom = Math.max(bottom, r.y + r.height);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // Greedy adjacency clustering: a real barcode is a contiguous block of dense
  // grid cells. Group touching cells (expanded by one cell) and keep the cluster
  // with the highest total transition score — that is the dominant barcode, so a
  // separate slip barcode elsewhere does not get merged in.
  function largestRegionCluster(regions) {
    const used = new Array(regions.length).fill(false);
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < regions.length; i += 1) {
      if (used[i]) continue;
      const stack = [i];
      used[i] = true;
      const cluster = [];
      let score = 0;
      while (stack.length) {
        const k = stack.pop();
        cluster.push(regions[k]);
        score += Number(regions[k].score || 0);
        for (let j = 0; j < regions.length; j += 1) {
          if (used[j]) continue;
          if (regionsAdjacent(regions[k], regions[j])) {
            used[j] = true;
            stack.push(j);
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    }
    return best || [];
  }

  function regionsAdjacent(a, b) {
    const ax2 = a.x + a.width;
    const ay2 = a.y + a.height;
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const gapX = Math.max(b.x - ax2, a.x - bx2);
    const gapY = Math.max(b.y - ay2, a.y - by2);
    const tolX = Math.max(a.width, b.width) * 0.5;
    const tolY = Math.max(a.height, b.height) * 0.5;
    return gapX <= tolX && gapY <= tolY;
  }

  // Locate the dominant barcode bbox inside `withinRect` on a page canvas, or
  // null. Used by the Smart fit action to anchor the 4x6 construction.
  function barcodeBoxWithin(canvas, withinRect) {
    const a = getAnalyzer();
    if (!a || !canvas) return null;
    const regions = a.findBarcodeRegions(canvas).filter((r) => regionCenterInside(r, withinRect));
    if (!regions.length) return null;
    const cluster = largestRegionCluster(regions);
    return cluster.length ? unionRegions(cluster) : null;
  }

  // --- Increment 2: barcode-driven upright orientation ----------------------
  // Rather than guess the 90 direction for a sideways label, score the as-is /
  // CW / CCW rotations by where the strongest horizontal barcode band lands and
  // pick the upright one (strong band in the lower half). Self-correcting — no
  // direction assumption — so it works without a hand-tuned per-carrier rule.
  function chooseRotationByBand(scored, options) {
    const minMass = Number((options && options.minMass) || 600);
    const lowerMin = Number((options && options.lowerMin) || 0.45);
    const valid = (Array.isArray(scored) ? scored : []).filter((s) => s && Number(s.mass) >= minMass);
    if (!valid.length) return 0; // no confident band anywhere: leave as-is
    const upright = valid.filter((s) => Number(s.centroidRatio) >= lowerMin);
    const pool = (upright.length ? upright : valid).slice().sort((a, b) => b.mass - a.mass);
    return Number(pool[0].turns) || 0;
  }

  function rotateCanvas(canvas, quarterTurns) {
    const turns = ((quarterTurns % 4) + 4) % 4;
    if (!turns) return canvas;
    const sideways = turns % 2 === 1;
    const out = document.createElement("canvas");
    out.width = sideways ? canvas.height : canvas.width;
    out.height = sideways ? canvas.width : canvas.height;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((Math.PI / 2) * turns);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  }

  // Turn a cropped label upright using its barcode band. Browser-only (needs the
  // canvas + LabelExtractorCrop.barcodeBandStats); a no-op when unavailable.
  function orientCanvasUpright(canvas) {
    const crop = (typeof window !== "undefined" && window.LabelExtractorCrop) || null;
    const bandStats = crop && crop.barcodeBandStats;
    if (!bandStats || !canvas) return canvas;
    const scored = [0, 1, 3].map((turns) => {
      const s = bandStats(rotateCanvas(canvas, turns)) || {};
      return { turns, mass: Number(s.mass || 0), centroidRatio: Number(s.centroidRatio || 0) };
    });
    return rotateCanvas(canvas, chooseRotationByBand(scored, { minMass: Number(crop.FLIP_MIN_MASS || 600) }));
  }

  const api = {
    TARGET_ASPECT,
    smartFit4x6Rect,
    growToAspect,
    barcodeBoxWithin,
    chooseRotationByBand,
    orientCanvasUpright
  };

  global.LabelExtractorSmartFit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
