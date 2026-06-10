(function () {
  "use strict";

  // Detected borders often sit just inside the printable label area. Keep enough
  // surrounding room for edge-aligned address text and carrier marks.
  const CROP_SAFETY_PADDING_RATIO = 0.12;
  const CROP_SAFETY_LEFT_EXTRA_RATIO = 0.035;
  const CROP_SAFETY_RIGHT_EXTRA_RATIO = 0.01;
  const CROP_SAFETY_TOP_EXTRA_RATIO = 0.07;
  const CROP_SAFETY_BOTTOM_EXTRA_RATIO = 0.035;
  const CROP_SAFETY_MIN_PADDING = 16;
  const CONTENT_SCAN_ROW_STEP = 2;

  // How far outside the threshold-detected bounds to rescue faint edge content
  // (a thin barcode end, a single address line) that the row/col thresholds drop.
  const BORDER_RESCUE_PIXELS = 15;

  // Padding presets. Each sets the ratio knobs consumed by expandRect(); any
  // explicit option the caller passes still overrides the preset value because
  // resolveCropOptions() layers the caller's options on top.
  const CROP_PRESETS = {
    tight: {
      paddingRatio: 0.06,
      minPadding: 8,
      leftExtraRatio: 0.015,
      rightExtraRatio: 0.005,
      topExtraRatio: 0.03,
      bottomExtraRatio: 0,
      replaceBottomExtraRatio: true
    },
    relaxed: {
      paddingRatio: 0.16,
      minPadding: 24,
      leftExtraRatio: 0.05,
      rightExtraRatio: 0.02,
      topExtraRatio: 0.09,
      bottomExtraRatio: 0.05,
      replaceBottomExtraRatio: true
    },
    // Extra bottom room for USPS Intelligent Mail barcode / endorsement block.
    "carrier-usps": {
      bottomExtraRatio: 0.05
    }
  };

  function resolveCropOptions(options = {}) {
    const presetName = options.preset;
    if (!presetName) return options;
    const preset = CROP_PRESETS[presetName];
    if (!preset) {
      console.warn(`[crop-engine] unknown preset "${presetName}", ignoring`);
      return options;
    }
    // Preset is the base; caller's explicit options win.
    return { ...preset, ...options };
  }

  function imageDataToCanvas(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    return canvas;
  }

  async function autoCropCanvas(sourceCanvas, padding = 6, options = {}) {
    const resolved = resolveCropOptions(options);
    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = sourceCanvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const bounds = findContentBounds(data, width, height, resolved);

    if (!bounds) {
      console.warn("[crop-engine] no content detected (blank or all-white image); returning source uncropped");
      return canvasToLabel(sourceCanvas);
    }

    return cropCanvas(sourceCanvas, {
      x: Math.max(0, bounds.left - padding),
      y: Math.max(0, bounds.top - padding),
      width: Math.min(width - Math.max(0, bounds.left - padding), bounds.right - bounds.left + 1 + padding * 2),
      height: Math.min(height - Math.max(0, bounds.top - padding), bounds.bottom - bounds.top + 1 + padding * 2)
    }, resolved);
  }

  function findContentBounds(data, width, height, options = {}) {
    const rowCounts = new Uint32Array(height);
    const colCounts = new Uint32Array(width);
    const whiteThreshold = 246;

    for (let y = 0; y < height; y += CONTENT_SCAN_ROW_STEP) {
      const rowBase = y * width;
      const colStep = y % (CONTENT_SCAN_ROW_STEP * 2) === 0 ? 1 : 2;
      for (let x = 0; x < width; x += colStep) {
        const i = (rowBase + x) * 4;
        if (data[i + 3] < 16) continue;
        if (data[i] >= whiteThreshold && data[i + 1] >= whiteThreshold && data[i + 2] >= whiteThreshold) continue;
        rowCounts[y] += colStep;
        colCounts[x] += CONTENT_SCAN_ROW_STEP;
      }
    }

    const rowThreshold = Math.max(2, Math.floor(width * 0.002));
    const colThreshold = Math.max(2, Math.floor(height * 0.001));
    let top = firstIndexAtLeast(rowCounts, rowThreshold);
    let bottom = lastIndexAtLeast(rowCounts, rowThreshold);
    let left = firstIndexAtLeast(colCounts, colThreshold);
    let right = lastIndexAtLeast(colCounts, colThreshold);

    if (left < 0 || right < 0 || top < 0 || bottom < 0 || left >= right || top >= bottom) return null;

    // Border rescue: the row/col thresholds intentionally ignore very faint
    // edges, but a barcode end or a single address line just outside the
    // detected box should not be clipped. Re-include any line within
    // borderPixels that holds even one content pixel.
    const borderScan = options.borderScan !== false;
    if (borderScan) {
      const reach = Number.isFinite(options.borderPixels) ? options.borderPixels : BORDER_RESCUE_PIXELS;
      top = extendOutward(rowCounts, top, -1, reach);
      bottom = extendOutward(rowCounts, bottom, 1, reach);
      left = extendOutward(colCounts, left, -1, reach);
      right = extendOutward(colCounts, right, 1, reach);
    }

    return { left, right, top, bottom };
  }

  // Walk outward from an edge index by up to `reach`, advancing the edge to the
  // farthest line that still carries content (count >= 1). Stops at the first
  // fully-empty line so it never runs across a gap into unrelated content.
  function extendOutward(counts, edge, direction, reach) {
    let result = edge;
    for (let step = 1; step <= reach; step += 1) {
      const idx = edge + direction * step;
      if (idx < 0 || idx >= counts.length) break;
      if (counts[idx] < 1) break;
      result = idx;
    }
    return result;
  }

  function firstIndexAtLeast(values, threshold) {
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] >= threshold) return i;
    }
    return -1;
  }

  function lastIndexAtLeast(values, threshold) {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (values[i] >= threshold) return i;
    }
    return -1;
  }

  async function cropCanvas(sourceCanvas, rect, options = {}) {
    const resolved = resolveCropOptions(options);
    let normalized = normalizeRect(expandRect(rect, sourceCanvas, CROP_SAFETY_PADDING_RATIO, resolved), sourceCanvas);
    if (resolved.gapClamp !== false) {
      normalized = clampPaddingAtGaps(sourceCanvas, normalizeRect(rect, sourceCanvas), normalized);
    }
    const { x, y, width, height } = normalized;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);
    return canvasToLabel(canvas);
  }

  // The safety padding in expandRect() is content-blind: it grows the detected
  // rect by a fixed ratio, so unrelated print within the padding band (browser
  // page furniture, instruction text near the label) gets annexed into the
  // crop. Real label overflow — address text hugging the detected border —
  // touches the detected edge with no white gap before it, while unrelated
  // content sits beyond one. So walk each side outward from the detected edge:
  // pass through blank lines and edge-contiguous content freely, but stop just
  // short of content that lies beyond a sustained white gap. Pass
  // `gapClamp: false` in the crop options to skip this.
  const GAP_CLAMP_MIN_PIXELS = 6;
  const GAP_CLAMP_MIN_RATIO = 0.004; // of the canvas' smaller dimension

  function clampPaddingAtGaps(sourceCanvas, inner, outer) {
    if (outer.width <= 0 || outer.height <= 0) return outer;
    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(outer.x, outer.y, outer.width, outer.height).data;
    const whiteThreshold = 246;
    const gapMin = Math.max(
      GAP_CLAMP_MIN_PIXELS,
      Math.round(Math.min(sourceCanvas.width, sourceCanvas.height) * GAP_CLAMP_MIN_RATIO)
    );

    const rowHasContent = (y) => {
      const base = (y - outer.y) * outer.width;
      const minCount = Math.max(2, Math.floor(outer.width * 0.002));
      let count = 0;
      for (let x = 0; x < outer.width; x += 1) {
        const i = (base + x) * 4;
        if (data[i + 3] < 16) continue;
        if (data[i] >= whiteThreshold && data[i + 1] >= whiteThreshold && data[i + 2] >= whiteThreshold) continue;
        count += 1;
        if (count >= minCount) return true;
      }
      return false;
    };

    const colHasContent = (x) => {
      const col = x - outer.x;
      const minCount = Math.max(2, Math.floor(outer.height * 0.002));
      let count = 0;
      for (let y = 0; y < outer.height; y += 1) {
        const i = (y * outer.width + col) * 4;
        if (data[i + 3] < 16) continue;
        if (data[i] >= whiteThreshold && data[i + 1] >= whiteThreshold && data[i + 2] >= whiteThreshold) continue;
        count += 1;
        if (count >= minCount) return true;
      }
      return false;
    };

    // Walk from just outside the detected edge toward the padded edge. On
    // hitting a content line that follows a gap of at least gapMin blank
    // lines, clamp the padding on the gap side of that content.
    const clampSide = (start, limit, direction, hasContent) => {
      let blanks = 0;
      for (let pos = start; direction > 0 ? pos <= limit : pos >= limit; pos += direction) {
        if (hasContent(pos)) {
          if (blanks >= gapMin) return pos - direction;
          blanks = 0;
        } else {
          blanks += 1;
        }
      }
      return limit;
    };

    const top = clampSide(inner.y - 1, outer.y, -1, rowHasContent);
    const bottom = clampSide(inner.y + inner.height, outer.y + outer.height - 1, 1, rowHasContent);
    const left = clampSide(inner.x - 1, outer.x, -1, colHasContent);
    const right = clampSide(inner.x + inner.width, outer.x + outer.width - 1, 1, colHasContent);

    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }

  function normalizeRect(rect, canvas) {
    const left = clamp(Math.floor(rect.x), 0, canvas.width - 1);
    const top = clamp(Math.floor(rect.y), 0, canvas.height - 1);
    const right = clamp(Math.ceil(rect.x + rect.width), left + 1, canvas.width);
    const bottom = clamp(Math.ceil(rect.y + rect.height), top + 1, canvas.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function expandRect(rect, canvas, ratio, options = {}) {
    const paddingRatio = Number.isFinite(options.paddingRatio) ? options.paddingRatio : ratio;
    const minPadding = Number.isFinite(options.minPadding) ? options.minPadding : CROP_SAFETY_MIN_PADDING;
    const leftExtraRatio = Number.isFinite(options.leftExtraRatio) ? options.leftExtraRatio : CROP_SAFETY_LEFT_EXTRA_RATIO;
    const rightExtraRatio = Number.isFinite(options.rightExtraRatio) ? options.rightExtraRatio : CROP_SAFETY_RIGHT_EXTRA_RATIO;
    const topExtraRatio = Number.isFinite(options.topExtraRatio) ? options.topExtraRatio : CROP_SAFETY_TOP_EXTRA_RATIO;
    const bottomExtraRatio = options.replaceBottomExtraRatio
      ? Number(options.bottomExtraRatio || 0)
      : CROP_SAFETY_BOTTOM_EXTRA_RATIO + Number(options.bottomExtraRatio || 0);
    const growX = Math.max(minPadding, rect.width * paddingRatio);
    const growLeft = growX + rect.width * leftExtraRatio;
    const growRight = growX + rect.width * rightExtraRatio;
    const growY = Math.max(minPadding, rect.height * paddingRatio);
    const growTop = growY + rect.height * topExtraRatio;
    const growBottom = growY + rect.height * (
      bottomExtraRatio
    );
    return {
      x: rect.x - growLeft,
      y: rect.y - growTop,
      width: rect.width + growLeft + growRight,
      height: rect.height + growTop + growBottom
    };
  }

  // ── Upright orientation ─────────────────────────────────────────────────
  // A 4x6 shipping label reads sender top-left with the main 1D tracking
  // barcode in the lower half. Auto-rotation to portrait can land upside down
  // (the source was rotated the other way), so detect it from pixels: 1D
  // barcode bands are long runs of near-identical rows, each with many
  // dark/light transitions (vertical bars). Text rows also have many
  // transitions but change row to row, so the similarity test filters them
  // out. Labels carry several barcodes (routing, tracking) on both halves, so
  // the whole-image centroid is ambiguous — but the HEAVIEST single band is
  // the tracking barcode, and its position discriminates cleanly (measured
  // 0.58 upright vs 0.42 flipped on UPS, stronger on USPS). Flip only when
  // that band sits clearly in the top half; never flip on a guess.
  const FLIP_MIN_TRANSITIONS = 24;     // fewer transitions = not a barcode row
  const FLIP_ROW_DIFF_RATIO = 0.04;    // sampled-bit mismatch allowed between barcode rows
  const FLIP_BAND_GAP_ROWS = 6;        // sampled blank rows that end a band
  const FLIP_CENTROID_MAX = 0.45;      // heaviest band above this (from top) = leave alone
  const FLIP_MIN_MASS = 600;           // band transition mass needed to trust the call

  function detectUprightFlip(canvas) {
    const { width, height } = canvas;
    if (!width || !height) return false;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, width, height).data;
    const rowStep = 2;
    const colStep = 2;
    const cols = Math.max(1, Math.floor(width / colStep));

    const rowBits = [];
    for (let y = 0; y < height; y += rowStep) {
      const bits = new Uint8Array(cols);
      for (let c = 0; c < cols; c += 1) {
        const i = (y * width + c * colStep) * 4;
        if (data[i + 3] < 16) continue;
        const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (lum < 128) bits[c] = 1;
      }
      rowBits.push(bits);
    }

    const transitions = rowBits.map((bits) => {
      let t = 0;
      for (let c = 1; c < bits.length; c += 1) {
        if (bits[c] !== bits[c - 1]) t += 1;
      }
      return t;
    });

    // A row belongs to a barcode band when it is transition-dense AND nearly
    // identical to the row ~4px below it (vertical bars repeat; text doesn't).
    const lookahead = Math.max(1, Math.round(4 / rowStep));
    const total = rowBits.length;
    let heaviest = null;
    let band = null;
    for (let r = 0; r < total; r += 1) {
      let isBarcodeRow = false;
      if (r + lookahead < total && transitions[r] >= FLIP_MIN_TRANSITIONS) {
        const a = rowBits[r];
        const b = rowBits[r + lookahead];
        let diff = 0;
        for (let c = 0; c < a.length; c += 1) {
          if (a[c] !== b[c]) diff += 1;
        }
        isBarcodeRow = diff <= a.length * FLIP_ROW_DIFF_RATIO;
      }
      if (isBarcodeRow) {
        if (!band) band = { start: r, end: r, mass: 0, moment: 0 };
        band.end = r;
        band.mass += transitions[r];
        band.moment += transitions[r] * r;
      } else if (band && r - band.end > FLIP_BAND_GAP_ROWS) {
        if (!heaviest || band.mass > heaviest.mass) heaviest = band;
        band = null;
      }
    }
    if (band && (!heaviest || band.mass > heaviest.mass)) heaviest = band;

    if (!heaviest || heaviest.mass < FLIP_MIN_MASS) return false;
    const centroidRatio = heaviest.moment / heaviest.mass / total;
    return centroidRatio < FLIP_CENTROID_MAX;
  }

  // ── Faint rule removal ──────────────────────────────────────────────────
  // Carrier "View/Print Label" sheets (UPS CampusShip etc.) draw long light-grey
  // fold/separator rules across the page. They are decorative, but every pixel
  // scan (content bounds, whitespace trim, crop snap) reads them as content, so
  // automatic crops stop at the rule instead of the label. A rule line is mostly
  // faint-grey, spans a wide run, holds almost no dark pixels, and the whole band
  // is only a few pixels thick — erase the faint pixels in such bands to white.
  // Dark pixels are never touched, so label borders, text, and barcodes are safe.
  const RULE_FAINT_MIN_LUM = 140;        // below this = real (dark) content, never erased
  const RULE_FAINT_MAX_LUM = 245;        // above this = already treated as white
  const RULE_MIN_SPAN_RATIO = 0.25;      // rule must cross at least this much of the page
  const RULE_MAX_DARK_RATIO = 0.003;     // more dark pixels than this = text/graphics line
  const RULE_MAX_THICKNESS_RATIO = 0.008;// thicker faint bands are shading, not rules

  function eraseFaintRules(canvas) {
    const { width, height } = canvas;
    if (!width || !height) return false;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, width, height);
    const erasedRows = eraseFaintRuleBands(imageData, "row");
    const erasedCols = eraseFaintRuleBands(imageData, "column");
    if (erasedRows || erasedCols) ctx.putImageData(imageData, 0, 0);
    return erasedRows || erasedCols;
  }

  function eraseFaintRuleBands(imageData, axis) {
    const { width, height, data } = imageData;
    const horizontal = axis === "row";
    const lineCount = horizontal ? height : width;
    const lineLength = horizontal ? width : height;
    const minSpan = Math.floor(lineLength * RULE_MIN_SPAN_RATIO);
    const maxDark = Math.max(2, Math.floor(lineLength * RULE_MAX_DARK_RATIO));
    const maxThickness = Math.max(4, Math.round(lineCount * RULE_MAX_THICKNESS_RATIO));

    // Pass 1: classify each line. Bails out of a line at the first sign of real
    // (dark) content, so text/barcode lines cost almost nothing.
    const ruleLike = new Uint8Array(lineCount);
    for (let line = 0; line < lineCount; line += 1) {
      let faint = 0;
      let dark = 0;
      for (let pos = 0; pos < lineLength; pos += 1) {
        const x = horizontal ? pos : line;
        const y = horizontal ? line : pos;
        const i = (y * width + x) * 4;
        if (data[i + 3] < 16) continue;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < RULE_FAINT_MIN_LUM) {
          dark += 1;
          if (dark > maxDark) break;
        } else if (lum <= RULE_FAINT_MAX_LUM) {
          faint += 1;
        }
      }
      ruleLike[line] = dark <= maxDark && faint >= minSpan ? 1 : 0;
    }

    // Pass 2: erase faint pixels inside thin runs of rule-like lines. Runs
    // thicker than maxThickness are left alone — that is shading, not a rule.
    let erased = false;
    let runStart = -1;
    for (let line = 0; line <= lineCount; line += 1) {
      if (line < lineCount && ruleLike[line]) {
        if (runStart < 0) runStart = line;
        continue;
      }
      if (runStart >= 0 && line - runStart <= maxThickness) {
        for (let bandLine = runStart; bandLine < line; bandLine += 1) {
          for (let pos = 0; pos < lineLength; pos += 1) {
            const x = horizontal ? pos : bandLine;
            const y = horizontal ? bandLine : pos;
            const i = (y * width + x) * 4;
            if (data[i + 3] < 16) continue;
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum >= RULE_FAINT_MIN_LUM && lum <= RULE_FAINT_MAX_LUM) {
              data[i] = data[i + 1] = data[i + 2] = 255;
              data[i + 3] = 255;
              erased = true;
            }
          }
        }
      }
      runStart = -1;
    }
    return erased;
  }

  async function rotateDataUrl(dataUrl, degrees) {
    const image = await loadImage(dataUrl);
    const radians = (degrees * Math.PI) / 180;
    const swap = Math.abs(degrees % 180) === 90;
    const canvas = document.createElement("canvas");
    canvas.width = swap ? image.height : image.width;
    canvas.height = swap ? image.width : image.height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(radians);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    return canvasToLabel(canvas);
  }

  function canvasToLabel(canvas) {
    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height
    };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  window.LabelExtractorCrop = {
    autoCropCanvas,
    cropCanvas,
    rotateDataUrl,
    canvasToLabel,
    imageDataToCanvas,
    eraseFaintRules,
    detectUprightFlip
  };
})();
