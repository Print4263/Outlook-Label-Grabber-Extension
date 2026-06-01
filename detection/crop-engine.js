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
    const normalized = normalizeRect(expandRect(rect, sourceCanvas, CROP_SAFETY_PADDING_RATIO, resolved), sourceCanvas);
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
    imageDataToCanvas
  };
})();
