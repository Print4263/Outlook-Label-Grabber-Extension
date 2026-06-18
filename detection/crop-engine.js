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

  async function autoCropCanvas(sourceCanvas, padding = 6, options = {}) {
    const resolved = resolveCropOptions(options);
    const { width, height } = sourceCanvas;
    const data = pixelsFor(sourceCanvas);
    const bounds = findContentBounds(data, width, height, resolved);

    if (!bounds) {
      console.warn("[crop-engine] no content detected (blank or all-white image); returning source uncropped");
      const label = canvasToLabel(sourceCanvas);
      label.sourceRect = { x: 0, y: 0, width, height };
      return label;
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
    const inner = innerContentRect(sourceCanvas, rect, resolved);
    let normalized = normalizeRect(expandRect(inner, sourceCanvas, CROP_SAFETY_PADDING_RATIO, resolved), sourceCanvas);
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
    const label = canvasToLabel(canvas);
    // Where this crop came from in the source canvas, for diagnostics and the
    // training studio's correction scoring. Plain data; costs nothing.
    label.sourceRect = { x, y, width, height };
    return label;
  }

  // Detected rects routinely carry blank margins INSIDE them — the model box
  // pads its prediction, border frames have a quiet inset, barcode-union rects
  // are padded by ratio. Printed at 4x6 those margins scale the actual label
  // content DOWN, so shrink the rect to the content it contains before any
  // padding/rescue runs. Content overflowing the original rect stays safe: it
  // is contiguous through the old edge, so extendThroughContent walks back out
  // to it. A rect with no detectable content (blank page region) is returned
  // unshrunk. Pass `shrinkToContent: false` to skip.
  function innerContentRect(sourceCanvas, rect, options = {}) {
    const inner = normalizeRect(rect, sourceCanvas);
    if (options.shrinkToContent === false) return inner;
    const data = pixelsFor(sourceCanvas);
    const W = sourceCanvas.width;
    const whiteThreshold = 246;
    const x0 = inner.x, x1 = inner.x + inner.width;
    const y0 = inner.y, y1 = inner.y + inner.height;

    const rowHasContent = (y) => {
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

    let top = y0;
    while (top < y1 - 1 && !rowHasContent(top)) top += 1;
    let bottom = y1 - 1;
    while (bottom > top && !rowHasContent(bottom)) bottom -= 1;
    let left = x0;
    while (left < x1 - 1 && !colHasContent(left)) left += 1;
    let right = x1 - 1;
    while (right > left && !colHasContent(right)) right -= 1;

    // Nothing (or a sliver) found: trust the original rect over a degenerate shrink.
    if (right - left < 4 || bottom - top < 4) return inner;
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }

  // The safety padding in expandRect() is content-blind: it grows the detected
  // rect by a fixed ratio, so unrelated print within the padding band (browser
  // page furniture, instruction text near the label) gets annexed into the
  // crop. Real label overflow — address text hugging the detected border —
  // touches the detected edge with no white gap before it, while unrelated
  // content sits beyond one. So walk each side outward from the detected edge:
  // pass through blank lines and edge-contiguous content freely, but stop just
  // short of content that lies beyond a sustained white gap — and keep only a
  // small white margin past the farthest content line, never the full blank
  // padding band (blank padding scales the label content down at print time).
  // Pass `gapClamp: false` in the crop options to skip this.
  const GAP_CLAMP_MIN_PIXELS = 6;
  const GAP_CLAMP_MIN_RATIO = 0.004; // of the canvas' smaller dimension
  const GAP_CLAMP_MARGIN_PIXELS = 12;
  const GAP_CLAMP_MARGIN_RATIO = 0.006; // of the canvas' smaller dimension

  function clampPaddingAtGaps(sourceCanvas, inner, outer) {
    if (outer.width <= 0 || outer.height <= 0) return outer;
    const data = pixelsFor(sourceCanvas);
    const canvasWidth = sourceCanvas.width;
    const whiteThreshold = 246;
    const gapMin = Math.max(
      GAP_CLAMP_MIN_PIXELS,
      Math.round(Math.min(sourceCanvas.width, sourceCanvas.height) * GAP_CLAMP_MIN_RATIO)
    );
    const margin = Math.max(
      GAP_CLAMP_MARGIN_PIXELS,
      Math.round(Math.min(sourceCanvas.width, sourceCanvas.height) * GAP_CLAMP_MARGIN_RATIO)
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

    // Walk from just outside the detected edge toward the padded edge,
    // tracking the farthest content line. On hitting content that follows a
    // gap of at least gapMin blank lines, stop — that content is unrelated.
    // Either way the final edge is the farthest related content plus a small
    // white margin, never the whole blank padding band. Content the old
    // behavior kept is still kept; only trailing blank lines are trimmed.
    const clampSide = (start, limit, direction, hasContent) => {
      let last = start - direction; // the detected edge itself
      let cap = limit;              // never move past this (gap side of unrelated content)
      let blanks = 0;
      for (let pos = start; direction > 0 ? pos <= limit : pos >= limit; pos += direction) {
        if (hasContent(pos)) {
          if (blanks >= gapMin) { cap = pos - direction; break; }
          last = pos;
          blanks = 0;
        } else {
          blanks += 1;
        }
      }
      const edge = last + direction * margin;
      return direction > 0 ? Math.min(edge, cap) : Math.max(edge, cap);
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
    const inner = innerContentRect(sourceCanvas, rect, resolved);
    const expanded = normalizeRect(expandRect(inner, sourceCanvas, CROP_SAFETY_PADDING_RATIO, resolved), sourceCanvas);
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

  // Mirror of clampRectBottomAboveBlockers for the rect's TOP: push it below
  // known non-label text printed directly above the label ("Cut this label
  // and affix…" on return sheets whose labels have no top border line, so the
  // border detector anchors on a heading higher up and annexes instructions).
  // Blockers in the rect's lower half are ignored, and a clamp that would gut
  // the rect is skipped.
  function clampRectTopBelowBlockers(rect, blockers, canvas) {
    if (!rect || !Array.isArray(blockers) || !blockers.length || !canvas) return rect;
    const minDim = Math.min(canvas.width || 0, canvas.height || 0);
    const margin = Math.max(28, Math.round(minDim * CONTENT_EXTEND_GAP_RATIO) + 10);
    let top = rect.y;
    for (const blocker of blockers) {
      if (!blocker || !(blocker.width > 0)) continue;
      // No horizontal-overlap requirement: these sheets are single-column and
      // the cut-line text often sits at the left margin while the label is
      // centered/right. The vertical guards below do the protecting.
      const cut = blocker.y + blocker.height + margin;
      if (cut >= rect.y + rect.height * 0.5) continue;
      if (cut > top) top = cut;
    }
    if (top <= rect.y) return rect;
    const bottom = rect.y + rect.height;
    if (bottom - top < rect.height * BLOCKER_KEEP_MIN_RATIO) return rect;
    return { ...rect, y: top, height: bottom - top };
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
    const stats = barcodeBandStats(canvas);
    if (!stats || stats.mass < FLIP_MIN_MASS) return false;
    return stats.centroidRatio < FLIP_CENTROID_MAX;
  }

  // Heaviest 1D-barcode band on the canvas: { mass, centroidRatio } or null.
  // Exposed so the orientation pass can compare band strength between a label
  // as-is and after a quarter turn — a label lying SIDEWAYS in a portrait crop
  // scans near zero upright and strongly once turned.
  function barcodeBandStats(canvas) {
    const { width, height } = canvas;
    if (!width || !height) return null;
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

    if (!heaviest || !heaviest.mass) return null;
    return {
      mass: heaviest.mass,
      centroidRatio: heaviest.moment / heaviest.mass / total
    };
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

  // dataUrl is a cached lazy getter: the PNG encode is the most expensive part
  // of producing a crop, and most candidates are ranked out without ever being
  // displayed. Only the labels something actually reads pay the encode. The
  // canvas rides along so consumers that can draw directly (orientation pass,
  // previews) skip the encode/decode round-trip entirely.
  function canvasToLabel(canvas) {
    let encoded = "";
    return {
      canvas,
      get dataUrl() {
        if (!encoded) encoded = canvas.toDataURL("image/png");
        return encoded;
      },
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

  // [BANKAI] Tighten a detector crop down to the label "card" when the box also
  // grabbed phone/app chrome around a SCREENSHOT or PHOTO of a label. The label
  // always holds the densest dark band (its primary barcode), so anchor on that
  // band and score sustained background gaps around it. We score both axes: the
  // common case trims top/bottom, but a landscape label inside a portrait
  // screenshot sometimes needs a left/right trim instead. A fixed gap threshold
  // can't separate the card-to-chrome gap from internal label whitespace, so we
  // evaluate every strong before/after gap pair and keep only the bounds that
  // move the crop closest to a real 4x6. The anchor band itself is never cut.
  // Returns the INPUT rect unchanged whenever the
  // tightened box would not be a clearer 4x6, so a bad guess can never make the
  // crop worse.
  const CARD_DARK_LUM = 120;
  const LABEL_ASPECTS = [2 / 3, 3 / 2]; // 4x6 portrait / landscape
  const CARD_PROFILE_ACTIVE = 0.006;
  // A single trim may discard at most this fraction of the crop's lines as ACTIVE
  // (content-bearing) rows/cols. Phone/app chrome that we legitimately trim — status
  // bar, URL bar, app buttons — is thin and discards little content (measured <=10%
  // of the dimension). The ship-to/from address block is dense (measured ~16%), so
  // capping here stops the refine from anchoring on a lower barcode and cutting the
  // address off the top. Tunable: lower = more conservative (more no-ops).
  const CARD_MAX_TRIM_ACTIVE = 0.12;
  function refineCardWithinRect(canvas, rect) {
    const data = pixelsFor(canvas);
    const W = canvas.width, H = canvas.height;
    const x0 = clamp(Math.round(rect.x), 0, W - 1);
    const x1 = clamp(Math.round(rect.x + rect.width), x0 + 1, W);
    const y0 = clamp(Math.round(rect.y), 0, H - 1);
    const y1 = clamp(Math.round(rect.y + rect.height), y0 + 1, H);
    const rw = x1 - x0, rh = y1 - y0;
    if (rh < 80 || rw < 40) return rect;
    const originalDistance = labelAspectDistance(rw / rh);
    const vertical = refinedCardRectForAxis(data, W, x0, x1, y0, y1, rect, "vertical", originalDistance);
    const horizontal = refinedCardRectForAxis(data, W, x0, x1, y0, y1, rect, "horizontal", originalDistance);
    if (vertical && horizontal) {
      return vertical.distance <= horizontal.distance ? vertical : horizontal;
    }
    return vertical || horizontal || rect;
  }

  function labelAspectDistance(aspect) {
    return Math.min(Math.abs(aspect - LABEL_ASPECTS[0]), Math.abs(aspect - LABEL_ASPECTS[1]));
  }

  function refinedCardRectForAxis(data, canvasWidth, x0, x1, y0, y1, rect, axis, originalDistance) {
    const lineCount = axis === "vertical" ? y1 - y0 : x1 - x0;
    const profile = darkFractionProfile(data, canvasWidth, x0, x1, y0, y1, axis);
    if (!profile) return null;

    const minGap = Math.max(24, Math.round(lineCount * 0.02));
    // Prefix sum of active (content-bearing) lines, so the active content a trim
    // would discard above/below the kept span is an O(1) lookup below.
    const activePrefix = new Int32Array(lineCount + 1);
    for (let i = 0; i < lineCount; i += 1) {
      activePrefix[i + 1] = activePrefix[i] + (profile.values[i] >= CARD_PROFILE_ACTIVE ? 1 : 0);
    }
    const maxTrimActive = Math.round(lineCount * CARD_MAX_TRIM_ACTIVE);
    const startOptions = [{ value: 0, support: 0 }];
    const endOptions = [{ value: lineCount, support: 0 }];
    let gapStart = -1;
    for (let line = 0; line <= lineCount; line += 1) {
      const inactive = line < lineCount ? profile.values[line] < CARD_PROFILE_ACTIVE : true;
      if (inactive) {
        if (gapStart < 0) gapStart = line;
        continue;
      }
      if (gapStart >= 0) {
        const len = line - gapStart;
        if (len >= minGap) {
          if (line <= profile.peakIndex) startOptions.push({ value: line, support: len });
          else if (gapStart >= profile.peakIndex) endOptions.push({ value: gapStart, support: len });
        }
        gapStart = -1;
      }
    }

    let best = null;
    for (const start of startOptions) {
      for (const end of endOptions) {
        const newSpan = end.value - start.value;
        if (newSpan < lineCount * 0.4) continue;
        const trimmedAspect = axis === "vertical"
          ? (x1 - x0) / newSpan
          : newSpan / (y1 - y0);
        const trimmedDistance = labelAspectDistance(trimmedAspect);
        if (trimmedDistance >= originalDistance) continue;
        // Never trim away a content-dense band (a real label region like the
        // ship-to/from block) — only thin chrome. Reject this bound pair otherwise.
        if (activePrefix[start.value] > maxTrimActive) continue;
        if (activePrefix[lineCount] - activePrefix[end.value] > maxTrimActive) continue;
        const candidate = {
          start: start.value,
          end: end.value,
          support: start.support + end.support,
          span: newSpan,
          distance: trimmedDistance
        };
        if (!best
          || candidate.distance < best.distance - 1e-6
          || (Math.abs(candidate.distance - best.distance) <= 1e-6 && candidate.support > best.support)
          || (Math.abs(candidate.distance - best.distance) <= 1e-6 && candidate.support === best.support && candidate.span > best.span)) {
          best = candidate;
        }
      }
    }

    if (!best || (best.start <= 0 && best.end >= lineCount)) return null;
    return axis === "vertical"
      ? { x: rect.x, y: y0 + best.start, width: rect.width, height: best.span, axis, distance: best.distance }
      : { x: x0 + best.start, y: rect.y, width: best.span, height: rect.height, axis, distance: best.distance };
  }

  function darkFractionProfile(data, canvasWidth, x0, x1, y0, y1, axis) {
    const span = axis === "vertical" ? x1 - x0 : y1 - y0;
    const lineCount = axis === "vertical" ? y1 - y0 : x1 - x0;
    if (span < 1 || lineCount < 1) return null;
    const step = Math.max(1, Math.floor(span / 240));
    const values = new Float32Array(lineCount);
    let peakValue = 0;
    let peakIndex = 0;

    for (let line = 0; line < lineCount; line += 1) {
      let dark = 0;
      let samples = 0;
      if (axis === "vertical") {
        const base = (y0 + line) * canvasWidth;
        for (let x = x0; x < x1; x += step) {
          const i = (base + x) * 4;
          if (data[i + 3] < 16) continue;
          samples += 1;
          if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < CARD_DARK_LUM) dark += 1;
        }
      } else {
        const x = x0 + line;
        for (let y = y0; y < y1; y += step) {
          const i = (y * canvasWidth + x) * 4;
          if (data[i + 3] < 16) continue;
          samples += 1;
          if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < CARD_DARK_LUM) dark += 1;
        }
      }
      const fraction = samples ? dark / samples : 0;
      values[line] = fraction;
      if (fraction > peakValue) {
        peakValue = fraction;
        peakIndex = line;
      }
    }

    return { values, peakIndex };
  }

  // OCR-free screenshot chrome trim. Some image labels arrive with app/browser
  // furniture inside an otherwise-good detector rect: a colored app header, or
  // Amazon's "Return Mailing Label / Cut this label" instruction band. Text-layer
  // clamps cannot help because screenshots have no text layer, so look only at
  // near-edge pixel bands and accept a cut only when it materially improves the
  // 4x6 aspect. PDFs never call this helper.
  const CHROME_ROW_STEP = 4;
  const CHROME_MIN_BAND = 40;
  const CHROME_MIN_IMPROVEMENT = 0.02;
  const CHROME_MAX_EDGE_RATIO = 0.24;

  function trimImageChromeBands(canvas, rect, options = {}) {
    if (!canvas || !rect) return rect;
    const W = canvas.width, H = canvas.height;
    const x0 = clamp(Math.round(rect.x), 0, W - 1);
    const x1 = clamp(Math.round(rect.x + rect.width), x0 + 1, W);
    const y0 = clamp(Math.round(rect.y), 0, H - 1);
    const y1 = clamp(Math.round(rect.y + rect.height), y0 + 1, H);
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 160 || rh < 240) return rect;

    const originalDistance = labelAspectDistance(rw / rh);
    if (originalDistance < 0.012 && options.allowAspectNeutralBottom !== true) return rect;

    const rows = chromeRowProfile(canvas, x0, x1, y0, y1);
    if (!rows.length) return rect;

    const topCuts = imageChromeTopCuts(rows, rh);
    const bottomCuts = imageChromeBottomCuts(rows, rh, options);
    if (topCuts.length < 2 && bottomCuts.length < 2) return rect;

    let best = null;
    for (const top of topCuts) {
      for (const bottom of bottomCuts) {
        if (top <= 0 && bottom >= rh) continue;
        if (top >= bottom) continue;
        const topTrim = top;
        const bottomTrim = rh - bottom;
        if (topTrim > rh * CHROME_MAX_EDGE_RATIO || bottomTrim > rh * CHROME_MAX_EDGE_RATIO) continue;
        const newHeight = bottom - top;
        if (newHeight < rh * 0.58) continue;
        const nextDistance = labelAspectDistance(rw / newHeight);
        const improvement = originalDistance - nextDistance;
        const aspectNeutralBottom = options.allowAspectNeutralBottom === true
          && topTrim === 0
          && bottomTrim > 0
          && bottomTrim <= rh * 0.06
          && nextDistance <= 0.04;
        if (improvement < CHROME_MIN_IMPROVEMENT && !aspectNeutralBottom) continue;
        const candidate = {
          top,
          bottom,
          distance: nextDistance,
          trimmed: topTrim + bottomTrim
        };
        if (!best
          || candidate.distance < best.distance - 1e-6
          || (Math.abs(candidate.distance - best.distance) <= 1e-6 && candidate.trimmed < best.trimmed)) {
          best = candidate;
        }
      }
    }

    if (!best) return rect;
    return {
      x: x0,
      y: y0 + best.top,
      width: rw,
      height: best.bottom - best.top,
      chromeTrimmed: true
    };
  }

  function chromeRowProfile(canvas, x0, x1, y0, y1) {
    const data = pixelsFor(canvas);
    const rows = [];
    const stepX = Math.max(1, Math.floor((x1 - x0) / 240));
    for (let y = y0; y < y1; y += CHROME_ROW_STEP) {
      let samples = 0;
      let dark = 0;
      let color = 0;
      let transitions = 0;
      let previous = null;
      for (let x = x0; x < x1; x += stepX) {
        const i = (y * canvas.width + x) * 4;
        if (data[i + 3] < 16) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const isDarkPixel = lum < 145;
        if (isDarkPixel) dark += 1;
        if (chroma > 45 && lum < 245) color += 1;
        if (previous !== null && previous !== isDarkPixel) transitions += 1;
        previous = isDarkPixel;
        samples += 1;
      }
      rows.push({
        rel: y - y0,
        dark: samples ? dark / samples : 0,
        color: samples ? color / samples : 0,
        transitions: samples ? transitions / samples * 100 : 0
      });
    }
    return rows;
  }

  function imageChromeTopCuts(rows, height) {
    const cuts = [0];
    const maxScan = height * CHROME_MAX_EDGE_RATIO;
    const color = firstNearEdgeBand(rows, maxScan, (row) => row.color >= 0.12);
    if (color && color.len >= CHROME_MIN_BAND && color.avgColor >= 0.22) {
      cuts.push(clampChromeCut(color.to + CHROME_ROW_STEP, height));
    }

    const text = lastInstructionBandBeforeQuietGap(rows, maxScan, 1);
    if (text) cuts.push(clampChromeCut(text.to + CHROME_ROW_STEP, height));
    return uniqueCuts(cuts);
  }

  function imageChromeBottomCuts(rows, height, options = {}) {
    const cuts = [height];
    const minScan = height * (1 - CHROME_MAX_EDGE_RATIO);
    const text = firstInstructionBandAfterQuietGap(rows, minScan, height);
    if (text) cuts.push(clampChromeCut(text.from, height));
    if (options.allowAspectNeutralBottom === true) {
      const tail = bottomTailAfterQuietGap(rows, height);
      // Step a couple of sampled rows into the proven quiet gap so no antialiased
      // top pixels from the URL/navigation band survive and falsely split output.
      if (tail) cuts.push(clampChromeCut(tail.from - (tail.dense ? CHROME_ROW_STEP * 2 : 0), height));
    }
    return uniqueCuts(cuts);
  }

  function firstNearEdgeBand(rows, maxRel, test) {
    let start = null;
    let sumColor = 0;
    let count = 0;
    for (const row of rows) {
      if (row.rel > maxRel) break;
      if (test(row)) {
        if (!start) {
          if (row.rel > CHROME_MIN_BAND) return null;
          start = row;
          sumColor = 0;
          count = 0;
        }
        sumColor += row.color;
        count += 1;
      } else if (start) {
        return {
          from: start.rel,
          to: row.rel - CHROME_ROW_STEP,
          len: row.rel - start.rel,
          avgColor: count ? sumColor / count : 0
        };
      }
    }
    return null;
  }

  function lastInstructionBandBeforeQuietGap(rows, maxRel, direction) {
    let best = null;
    let start = null;
    let lastActive = null;
    let inactive = 0;
    const near = rows.filter((row) => row.rel <= maxRel);
    for (let i = 0; i < near.length; i += 1) {
      const row = near[i];
      const active = looksLikeInstructionInk(row);
      if (active) {
        if (!start) start = { row, index: i };
        lastActive = { row, index: i };
        inactive = 0;
        continue;
      }
      if (!start) continue;
      inactive += CHROME_ROW_STEP;
      if (quietRunLength(near, i, direction) < CHROME_MIN_BAND) {
        if (inactive <= CHROME_ROW_STEP * 3) continue;
        start = null;
        lastActive = null;
        inactive = 0;
        continue;
      }
      const prev = lastActive?.row || near[i - 1];
      const len = prev.rel - start.row.rel + CHROME_ROW_STEP;
      if (len >= CHROME_MIN_BAND && quietRunLength(near, i, direction) >= CHROME_MIN_BAND) {
        best = { from: start.row.rel, to: prev.rel, len };
      }
      start = null;
      lastActive = null;
      inactive = 0;
    }
    return best;
  }

  function firstInstructionBandAfterQuietGap(rows, minRel, height) {
    const near = rows.filter((row) => row.rel >= minRel && row.rel <= height);
    let start = null;
    let lastActive = null;
    let inactive = 0;
    for (let i = 0; i < near.length; i += 1) {
      const row = near[i];
      if (looksLikeInstructionInk(row)) {
        if (!start) start = { row, index: i };
        lastActive = { row, index: i };
        inactive = 0;
        continue;
      }
      if (!start) continue;
      inactive += CHROME_ROW_STEP;
      if (inactive <= CHROME_ROW_STEP * 3) continue;
      const prev = lastActive?.row || near[i - 1];
      const len = prev.rel - start.row.rel + CHROME_ROW_STEP;
      if (len >= CHROME_MIN_BAND && quietRunLength(near, start.index - 1, -1) >= CHROME_MIN_BAND) {
        return { from: start.row.rel, to: prev.rel, len };
      }
      start = null;
      lastActive = null;
      inactive = 0;
    }
    if (start) {
      const prev = lastActive?.row || near[near.length - 1];
      const len = prev.rel - start.row.rel + CHROME_ROW_STEP;
      if (len >= CHROME_MIN_BAND && quietRunLength(near, start.index - 1, -1) >= CHROME_MIN_BAND) {
        return { from: start.row.rel, to: prev.rel, len };
      }
    }
    return null;
  }

  function looksLikeInstructionInk(row) {
    return row.transitions >= 12 && row.dark >= 0.06 && row.dark <= 0.38 && row.color < 0.08;
  }

  function looksLikeBottomChromeInk(row) {
    return row.color >= 0.08
      || row.dark >= 0.55
      || (row.transitions >= 1.5 && row.dark >= 0.012 && row.dark < 0.45 && row.color < 0.08);
  }

  function bottomTailAfterQuietGap(rows, height) {
    const maxTail = height * 0.08;
    let end = null;
    let start = null;
    let holes = 0;
    let denseTail = false;
    const maxInterBandGap = Math.max(CHROME_MIN_BAND * 3, Math.round(height * 0.035));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const fromBottom = height - row.rel;
      if (fromBottom > maxTail && !end) return null;
      if (looksLikeBottomChromeInk(row)) {
        if (!end) end = { row, index: i };
        start = { row, index: i };
        if (row.color >= 0.08 || row.dark >= 0.55) denseTail = true;
        holes = 0;
        continue;
      }
      if (!end) continue;
      holes += CHROME_ROW_STEP;
      if (holes <= (denseTail ? maxInterBandGap : CHROME_ROW_STEP * 3)) continue;
      break;
    }
    if (!start || !end) return null;
    const len = end.row.rel - start.row.rel + CHROME_ROW_STEP;
    if (len < CHROME_MIN_BAND) return null;
    if (quietRunLength(rows, start.index - 1, -1) < CHROME_MIN_BAND) return null;
    return { from: start.row.rel, to: end.row.rel, len, dense: denseTail };
  }

  function quietRunLength(rows, index, direction) {
    let length = 0;
    for (let i = index; i >= 0 && i < rows.length; i += direction) {
      const row = rows[i];
      if (row.dark >= 0.025 || row.transitions >= 3 || row.color >= 0.05) break;
      length += CHROME_ROW_STEP;
    }
    return length;
  }

  function clampChromeCut(value, height) {
    return clamp(Math.round(value), 0, height);
  }

  function uniqueCuts(cuts) {
    return [...new Set(cuts.map((value) => Math.round(value)))].sort((a, b) => a - b);
  }

  // Remove only a very large, truly quiet trailing margin from an already-rendered
  // IMAGE model crop. This operates on the output label (not the source page), so
  // it can undo cropCanvas content-rescue reaching the page edge while preserving
  // every active row plus an explicit safety margin. The model detector is the
  // sole caller; PDFs and border crops never enter this path.
  const QUIET_TAIL_MIN_RATIO = 0.18;
  const QUIET_TAIL_ACTIVE_RATIO = 0.006;
  function trimQuietImageTail(label, options = {}) {
    const canvas = label?.canvas;
    const sourceRect = label?.sourceRect;
    if (!canvas || !sourceRect || canvas.width < 160 || canvas.height < 240) return label;
    const data = pixelsFor(canvas);
    const stepX = Math.max(1, Math.floor(canvas.width / 300));
    const stepY = Math.max(1, Math.floor(canvas.height / 800));
    const activeRows = [];
    for (let y = 0; y < canvas.height; y += stepY) {
      let dark = 0;
      let samples = 0;
      for (let x = 0; x < canvas.width; x += stepX) {
        const i = (y * canvas.width + x) * 4;
        if (data[i + 3] < 16) continue;
        samples += 1;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 180) dark += 1;
      }
      activeRows.push({ y, active: samples > 0 && dark / samples >= QUIET_TAIL_ACTIVE_RATIO });
    }
    let lastActive = -1;
    for (let i = 0; i < activeRows.length; i += 1) {
      if (!activeRows[i].active) continue;
      let support = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(activeRows.length - 1, i + 2); j += 1) {
        if (activeRows[j].active) support += 1;
      }
      // Ignore a lone antialiased/speckled row left at a just-trimmed chrome
      // boundary; real label content sustains activity across nearby samples.
      if (support >= 3) lastActive = activeRows[i].y;
    }
    if (lastActive < 0) return label;
    const tail = canvas.height - Math.min(canvas.height, lastActive + stepY);
    const minimumTailRatio = Number.isFinite(options.minimumTailRatio)
      ? options.minimumTailRatio
      : QUIET_TAIL_MIN_RATIO;
    if (tail / canvas.height < minimumTailRatio) return label;
    const margin = Math.max(12, Math.round(canvas.height * 0.012));
    const nextHeight = Math.min(canvas.height, lastActive + stepY + margin);
    if (nextHeight >= canvas.height) return label;
    const beforeDistance = labelAspectDistance(canvas.width / canvas.height);
    const afterDistance = labelAspectDistance(canvas.width / nextHeight);
    if (options.requireAspectImprovement !== false && afterDistance >= beforeDistance - 0.02) return label;

    const nextCanvas = document.createElement("canvas");
    nextCanvas.width = canvas.width;
    nextCanvas.height = nextHeight;
    const context = nextCanvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
    context.drawImage(canvas, 0, 0, canvas.width, nextHeight, 0, 0, canvas.width, nextHeight);
    const next = canvasToLabel(nextCanvas);
    next.sourceRect = {
      x: sourceRect.x,
      y: sourceRect.y,
      width: sourceRect.width,
      height: sourceRect.height * (nextHeight / canvas.height)
    };
    next.quietTailTrimmed = true;
    next.quietTailPixels = canvas.height - nextHeight;
    return next;
  }

  window.LabelExtractorCrop = {
    autoCropCanvas,
    cropCanvas,
    measureCropRect,
    clampRectBottomAboveBlockers,
    clampRectTopBelowBlockers,
    rotateDataUrl,
    canvasToLabel,
    eraseFaintRules,
    detectUprightFlip,
    barcodeBandStats,
    refineCardWithinRect,
    trimImageChromeBands,
    trimQuietImageTail,
    // Band mass below this is too weak to trust for orientation decisions.
    FLIP_MIN_MASS,
    pixelsFor
  };
})();
