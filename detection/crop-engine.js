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

  // One full-canvas pixel snapshot per canvas, shared by every pass that reads
  // pixels (content bounds, gap clamp, content rescue, upright flip) and
  // exported so label-detector / pdf-processor reuse the same snapshot instead
  // of each keeping their own copy. WeakMap: entries release with the canvas.
  // eraseFaintRules mutates canvases and invalidates its entry below.
  const pixelCache = new WeakMap();
  function pixelsFor(canvas) {
    let data = pixelCache.get(canvas);
    if (!data) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      pixelCache.set(canvas, data);
    }
    return data;
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
    const { width, height } = sourceCanvas;
    const data = pixelsFor(sourceCanvas);
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
    const inner = normalizeRect(rect, sourceCanvas);
    let normalized = normalizeRect(expandRect(rect, sourceCanvas, CROP_SAFETY_PADDING_RATIO, resolved), sourceCanvas);
    if (resolved.contentExtend !== false) {
      normalized = unionFarther(normalized, extendThroughContent(sourceCanvas, inner, resolved), sourceCanvas);
    }
    if (resolved.gapClamp !== false) {
      normalized = clampPaddingAtGaps(sourceCanvas, inner, normalized);
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
    const data = pixelsFor(sourceCanvas);
    const canvasWidth = sourceCanvas.width;
    const whiteThreshold = 246;
    const gapMin = Math.max(
      GAP_CLAMP_MIN_PIXELS,
      Math.round(Math.min(sourceCanvas.width, sourceCanvas.height) * GAP_CLAMP_MIN_RATIO)
    );

    const rowHasContent = (y) => {
      const base = y * canvasWidth;
      const minCount = Math.max(2, Math.floor(outer.width * 0.002));
      let count = 0;
      for (let x = outer.x; x < outer.x + outer.width; x += 1) {
        const i = (base + x) * 4;
        if (data[i + 3] < 16) continue;
        if (data[i] >= whiteThreshold && data[i + 1] >= whiteThreshold && data[i + 2] >= whiteThreshold) continue;
        count += 1;
        if (count >= minCount) return true;
      }
      return false;
    };

    const colHasContent = (x) => {
      const minCount = Math.max(2, Math.floor(outer.height * 0.002));
      let count = 0;
      for (let y = outer.y; y < outer.y + outer.height; y += 1) {
        const i = (y * canvasWidth + x) * 4;
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

  // Diagnostic: return the rect at each stage cropCanvas() would produce, without
  // drawing. inner = the detector's raw box; expanded = after content-blind safety
  // padding (what gapClamp:false yields); clamped = after the gap-aware clamp (the
  // production crop). The per-edge difference between expanded and clamped is exactly
  // what clampPaddingAtGaps removed on each side. Used by the training studio.
  function measureCropRect(sourceCanvas, rect, options = {}) {
    const resolved = resolveCropOptions(options);
    const inner = normalizeRect(rect, sourceCanvas);
    const expanded = normalizeRect(expandRect(rect, sourceCanvas, CROP_SAFETY_PADDING_RATIO, resolved), sourceCanvas);
    let outer = expanded;
    if (resolved.contentExtend !== false) {
      outer = unionFarther(outer, extendThroughContent(sourceCanvas, inner, resolved), sourceCanvas);
    }
    const extended = outer;
    const clamped = resolved.gapClamp !== false
      ? clampPaddingAtGaps(sourceCanvas, inner, outer)
      : outer;
    return { inner, expanded, extended, clamped };
  }

  // Outward content rescue. A detected border can sit INSIDE label content: an
  // address that overruns the cut line, a barcode end poking past the frame. The
  // fixed safety padding is a constant ratio, so when content reaches farther out
  // than the padding it gets clipped (e.g. a ship-to "Indianapolis" sheared to
  // "lianapolis"). From each inner edge, walk outward and advance the edge through
  // content, bridging the small gaps between letters/words/lines, and stop at the
  // first SUSTAINED white gap — the real margin. White immediately outside the edge
  // (a clean border with its own margin) yields no extension, so labels that sit
  // alone on the page are untouched. maxReach caps how far a single edge can grow so
  // a neighbouring label on a multi-label sheet is never annexed.
  const CONTENT_EXTEND_MAX_REACH_RATIO = 0.30; // of the inner rect's own dimension
  const CONTENT_EXTEND_GAP_RATIO = 0.012;      // sustained white = real margin
  const CONTENT_EXTEND_MIN_GAP = 14;

  function extendThroughContent(sourceCanvas, inner, options = {}) {
    const W = sourceCanvas.width, H = sourceCanvas.height;
    if (inner.width <= 0 || inner.height <= 0) return inner;
    // One shared snapshot instead of a getImageData readback per scanned line —
    // the walk covers hundreds of lines per side, and a readback each was the
    // single biggest cost in the whole extraction pipeline.
    const data = pixelsFor(sourceCanvas);
    const whiteThreshold = 246;
    const gap = Math.max(
      CONTENT_EXTEND_MIN_GAP,
      Math.round(Math.min(W, H) * (Number.isFinite(options.contentExtendGapRatio) ? options.contentExtendGapRatio : CONTENT_EXTEND_GAP_RATIO))
    );
    const reachRatio = Number.isFinite(options.contentExtendReachRatio) ? options.contentExtendReachRatio : CONTENT_EXTEND_MAX_REACH_RATIO;
    const reachX = Math.round(inner.width * reachRatio);
    const reachY = Math.round(inner.height * reachRatio);

    const x0 = clamp(Math.floor(inner.x), 0, W);
    const x1 = clamp(Math.ceil(inner.x + inner.width), 0, W);
    const y0 = clamp(Math.floor(inner.y), 0, H);
    const y1 = clamp(Math.ceil(inner.y + inner.height), 0, H);

    // A row/column counts as content when it carries more than a trace of dark
    // pixels across the inner span (matches the threshold used elsewhere).
    const rowHasContent = (y) => {
      if (y < 0 || y >= H || x1 <= x0) return false;
      const base = y * W;
      const need = Math.max(2, Math.floor((x1 - x0) * 0.004));
      let c = 0;
      for (let x = x0; x < x1; x += 1) {
        const i = (base + x) * 4;
        if (data[i + 3] < 16) continue;
        if (data[i] >= whiteThreshold && data[i + 1] >= whiteThreshold && data[i + 2] >= whiteThreshold) continue;
        if (++c >= need) return true;
      }
      return false;
    };
    const colHasContent = (x) => {
      if (x < 0 || x >= W || y1 <= y0) return false;
      const need = Math.max(2, Math.floor((y1 - y0) * 0.004));
      let c = 0;
      for (let y = y0; y < y1; y += 1) {
        const i = (y * W + x) * 4;
        if (data[i + 3] < 16) continue;
        if (data[i] >= whiteThreshold && data[i + 1] >= whiteThreshold && data[i + 2] >= whiteThreshold) continue;
        if (++c >= need) return true;
      }
      return false;
    };

    // Walk outward from `start` (first line outside the edge) by `dir` up to `limit`.
    // Advance the edge to the farthest content line seen; bail after `gap` blanks.
    const walk = (start, limit, dir, hasContent, fallback) => {
      let edge = fallback;
      let blanks = 0;
      for (let pos = start; dir > 0 ? pos <= limit : pos >= limit; pos += dir) {
        if (hasContent(pos)) { edge = pos; blanks = 0; }
        else if (++blanks >= gap) break;
      }
      return edge;
    };

    const left = walk(x0 - 1, Math.max(0, x0 - reachX), -1, colHasContent, x0);
    const right = walk(x1, Math.min(W - 1, x1 - 1 + reachX), 1, colHasContent, x1 - 1) + 1;
    const top = walk(y0 - 1, Math.max(0, y0 - reachY), -1, rowHasContent, y0);
    const bottom = walk(y1, Math.min(H - 1, y1 - 1 + reachY), 1, rowHasContent, y1 - 1) + 1;

    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  // Pull a detection rect's bottom up above known non-label "blocker" regions —
  // e.g. the "Return Authorization Slip" header on Amazon Online Return Center
  // sheets, whose section is printed inside the same cut-frame as the label and
  // therefore lands inside border/model rects. The clamp margin is sized to beat
  // the content-extend bridge gap, so the safety padding can never walk back
  // across it into the excluded section. Blockers in the rect's upper half are
  // ignored (a slip ABOVE the label means this rect isn't the label/slip layout
  // this clamp understands), and a clamp that would gut the rect is skipped.
  const BLOCKER_KEEP_MIN_RATIO = 0.45;

  function clampRectBottomAboveBlockers(rect, blockers, canvas) {
    if (!rect || !Array.isArray(blockers) || !blockers.length || !canvas) return rect;
    const minDim = Math.min(canvas.width || 0, canvas.height || 0);
    const margin = Math.max(28, Math.round(minDim * CONTENT_EXTEND_GAP_RATIO) + 10);
    let bottom = rect.y + rect.height;
    for (const blocker of blockers) {
      if (!blocker || !(blocker.width > 0)) continue;
      const overlapX = Math.min(rect.x + rect.width, blocker.x + blocker.width) - Math.max(rect.x, blocker.x);
      if (overlapX <= 0) continue;
      const cut = blocker.y - margin;
      if (cut <= rect.y + rect.height * 0.5) continue;
      if (cut < bottom) bottom = cut;
    }
    if (bottom >= rect.y + rect.height) return rect;
    if (bottom - rect.y < rect.height * BLOCKER_KEEP_MIN_RATIO) return rect;
    return { ...rect, height: bottom - rect.y };
  }

  // Per-edge union: take whichever rect reaches farther from centre on each side,
  // clamped to the canvas. Used to merge fixed safety padding with content rescue.
  function unionFarther(a, b, canvas) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return normalizeRect({ x: left, y: top, width: right - left, height: bottom - top }, canvas);
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
    const data = pixelsFor(canvas);
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
    if (erasedRows || erasedCols) {
      ctx.putImageData(imageData, 0, 0);
      // The canvas changed — drop any cached snapshot so readers see the erase.
      pixelCache.delete(canvas);
    }
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
    measureCropRect,
    clampRectBottomAboveBlockers,
    rotateDataUrl,
    canvasToLabel,
    imageDataToCanvas,
    eraseFaintRules,
    detectUprightFlip,
    pixelsFor
  };
})();
