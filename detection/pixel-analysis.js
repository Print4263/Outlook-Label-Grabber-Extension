(function () {
  "use strict";

  const LABEL_FRAME_MIN_ASPECT = 0.42;
  const LABEL_FRAME_MAX_ASPECT = 2.4;
  const dashedBorderCache = new WeakMap();
  // Memoizes the default-grid barcode scan per canvas. The cascade asks the same
  // page.canvas for its barcode regions from many detectors; without this each
  // call repeats a full getImageData + transition scan.
  const barcodeRegionCache = new WeakMap();
  // Memoizes the raw RGBA pixel buffer per canvas. getImageData on a full source
  // page is one of the most expensive operations in the cascade, and several
  // detectors (border scans, barcode grid, snap scoring) each re-read the same
  // canvas. Share one read instead.
  const canvasDataCache = new WeakMap();
  // Candidate-label completeness is consumed by both selection and barcode
  // calibration. Cache the pure row-profile result on the rendered label canvas
  // so those consumers never repeat the same scan.
  const contentSeparationCache = new WeakMap();

  function getCanvasData(canvas) {
    // Prefer the shared snapshot in crop-engine so the same canvas isn't read
    // back and held in memory once per module.
    const shared = window.LabelExtractorCrop?.pixelsFor;
    if (shared) return shared(canvas);
    let data = canvasDataCache.get(canvas);
    if (data) return data;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    canvasDataCache.set(canvas, data);
    return data;
  }

  // Fraction of the rendered output occupied by its longest sustained quiet row
  // run BETWEEN content-bearing rows. A large value means two visually separate
  // blocks were annexed into one crop (or a border selected only one sparse block).
  // Edge whitespace is intentionally excluded; trim helpers own edge cleanup.
  function contentSeparationScore(canvas) {
    if (!canvas || canvas.width < 40 || canvas.height < 80) return 0;
    const cached = contentSeparationCache.get(canvas);
    if (cached !== undefined) return cached;
    const data = getCanvasData(canvas);
    const stepX = Math.max(1, Math.floor(canvas.width / 300));
    const stepY = Math.max(1, Math.floor(canvas.height / 800));
    const active = [];
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
      active.push(samples > 0 && dark / samples >= 0.006);
    }
    const first = active.indexOf(true);
    const last = active.lastIndexOf(true);
    let longest = 0;
    let quietStart = -1;
    if (first >= 0 && last > first) {
      for (let i = first; i <= last + 1; i += 1) {
        if (i <= last && !active[i]) {
          if (quietStart < 0) quietStart = i;
          continue;
        }
        if (quietStart >= 0) {
          longest = Math.max(longest, (i - quietStart) * stepY);
          quietStart = -1;
        }
      }
    }
    const score = Math.min(1, longest / canvas.height);
    contentSeparationCache.set(canvas, score);
    return score;
  }

  function detectDashedBorder(canvas) {
    if (dashedBorderCache.has(canvas)) return dashedBorderCache.get(canvas);

    const result = detectDashedBorderUncached(canvas);
    dashedBorderCache.set(canvas, result);
    return result;
  }

  function detectSolidLabelBorder(canvas) {
    const { width, height } = canvas;
    const data = getCanvasData(canvas);
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

    const plausible = [];
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
            plausible.push(rect);
          }
        }
      }
    }
    if (!plausible.length) return null;

    // A dense row/col of TEXT passes the dark-count threshold just like a
    // drawn line does, so the biggest box often has a phantom edge sitting on
    // a heading ("Additional Instructions…") instead of the label frame —
    // annexing the instruction block above the label. Require every edge of
    // the winning box to individually look like a drawn border line; fall back
    // to the old biggest-box pick when nothing qualifies (faint/scanned
    // borders must keep detecting).
    plausible.sort((a, b) => b.width * b.height - a.width * a.height);
    const qualified = plausible
      .slice(0, SOLID_BORDER_EDGE_CHECK_LIMIT)
      .find((rect) => minBorderEdgeDarkness(rect, canvas) >= SOLID_BORDER_MIN_EDGE_DARKNESS);
    return qualified || plausible[0];
  }

  // A printed border line is CONTINUOUS along its whole run. Phantom edges are
  // not: a heading underline tops a box whose sides only carry the real label
  // frame for part of their span (the stretch above the label is white), so
  // whole-edge averages still look decent (~0.8). Checking each edge in
  // quarter segments exposes the white stretch — every segment of every edge
  // must be mostly dark. The biggest-box fallback keeps faint/scanned borders
  // detecting as before.
  const SOLID_BORDER_MIN_EDGE_DARKNESS = 0.5;
  const SOLID_BORDER_EDGE_SEGMENTS = 4;
  const SOLID_BORDER_EDGE_CHECK_LIMIT = 12;

  // Weakest segment fraction across all four edges. Samples a 3px band so
  // group-centring drift and photo blur don't miss a thin line.
  function minBorderEdgeDarkness(rect, canvas) {
    const data = getCanvasData(canvas);
    const left = clamp(Math.round(rect.x), 0, canvas.width - 1);
    const right = clamp(Math.round(rect.x + rect.width), 0, canvas.width - 1);
    const top = clamp(Math.round(rect.y), 0, canvas.height - 1);
    const bottom = clamp(Math.round(rect.y + rect.height), 0, canvas.height - 1);
    const rowDark = (y, x) => {
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = clamp(y + dy, 0, canvas.height - 1);
        if (isDark(data, (yy * canvas.width + x) * 4)) return true;
      }
      return false;
    };
    const colDark = (x, y) => {
      for (let dx = -1; dx <= 1; dx += 1) {
        const xx = clamp(x + dx, 0, canvas.width - 1);
        if (isDark(data, (y * canvas.width + xx) * 4)) return true;
      }
      return false;
    };
    const edgeMinSegment = (length, test) => {
      const segment = Math.max(1, Math.floor(length / SOLID_BORDER_EDGE_SEGMENTS));
      let weakest = 1;
      for (let s = 0; s < SOLID_BORDER_EDGE_SEGMENTS; s += 1) {
        const from = s * segment;
        const to = s === SOLID_BORDER_EDGE_SEGMENTS - 1 ? length : from + segment;
        let dark = 0;
        let sampled = 0;
        for (let i = from; i <= to; i += 3) {
          if (test(i)) dark += 1;
          sampled += 1;
        }
        weakest = Math.min(weakest, dark / Math.max(1, sampled));
      }
      return weakest;
    };
    return Math.min(
      edgeMinSegment(right - left, (i) => rowDark(top, left + i)),
      edgeMinSegment(right - left, (i) => rowDark(bottom, left + i)),
      edgeMinSegment(bottom - top, (i) => colDark(left, top + i)),
      edgeMinSegment(bottom - top, (i) => colDark(right, top + i))
    );
  }

  function looksLikeLabelRect(rect, canvas) {
    if (rect.width < canvas.width * 0.28 || rect.height < canvas.height * 0.28) return false;
    if (rect.width * rect.height < canvas.width * canvas.height * 0.12) return false;
    const ratio = rect.height / Math.max(1, rect.width);
    return ratio >= LABEL_FRAME_MIN_ASPECT && ratio <= LABEL_FRAME_MAX_ASPECT;
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
    const { width, height } = canvas;
    const data = getCanvasData(canvas);
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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

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
  // crop is clipping — but only cells within `margin` of the crop, so a separate
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
      // Skip barcode cells that aren't near this crop — not part of this label.
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

  function borderLineScore(rect, canvas) {
    const data = getCanvasData(canvas);
    const left = clamp(Math.round(rect.x), 0, canvas.width - 1);
    const right = clamp(Math.round(rect.x + rect.width), 0, canvas.width - 1);
    const top = clamp(Math.round(rect.y), 0, canvas.height - 1);
    const bottom = clamp(Math.round(rect.y + rect.height), 0, canvas.height - 1);
    let dark = 0;
    let sampled = 0;

    for (let x = left; x <= right; x += 3) {
      dark += isDark(data, (top * canvas.width + x) * 4) ? 1 : 0;
      dark += isDark(data, (bottom * canvas.width + x) * 4) ? 1 : 0;
      sampled += 2;
    }
    for (let y = top; y <= bottom; y += 3) {
      dark += isDark(data, (y * canvas.width + left) * 4) ? 1 : 0;
      dark += isDark(data, (y * canvas.width + right) * 4) ? 1 : 0;
      sampled += 2;
    }
    return dark / Math.max(1, sampled);
  }

  // Barcodes read as a run of dark/light transitions perpendicular to their bars.
  // A normal portrait label scans best horizontally; a label rotated 90° (common
  // on UPS/return PDFs where the label image is placed sideways) scans best
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

  window.LabelExtractorPixelAnalysis = {
    getCanvasData,
    detectDashedBorder,
    detectSolidLabelBorder,
    findBarcodeRegions,
    findBarcodeRegionsInGrid,
    expandRectToClippedBarcodes,
    borderLineScore,
    contentSeparationScore
  };
})();
