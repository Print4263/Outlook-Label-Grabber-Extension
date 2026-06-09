(function () {
  "use strict";

  // pdf.min.js (~320 KB) is only needed for PDF labels, so load it on first use
  // instead of at panel open. Image-only and idle sessions never pay for it.
  // (dev/test.html loads pdf.min.js itself, so window.pdfjsLib is already present there.)
  let pdfJsLoadPromise = null;
  const scriptUrl = document.currentScript?.src || "";

  function assetUrl(path) {
    if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
    return new URL(`../${path}`, scriptUrl || window.location.href).href;
  }

  function ensurePdfJsScript() {
    if (window.pdfjsLib) return Promise.resolve();
    if (pdfJsLoadPromise) return pdfJsLoadPromise;
    pdfJsLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = assetUrl("lib/pdf.min.js");
      script.onload = () => resolve();
      script.onerror = () => {
        pdfJsLoadPromise = null;
        reject(new Error("PDF reader could not load."));
      };
      document.head.append(script);
    });
    return pdfJsLoadPromise;
  }

  async function loadPdfJs() {
    await ensurePdfJsScript();
    if (!window.pdfjsLib) throw new Error("PDF reader could not start.");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl("lib/pdf.worker.min.js");
    return window.pdfjsLib;
  }

  const MAX_TEXT_PAGES = 20;
  const MAX_RENDER_PAGES = 6;
  const STRONG_DETECTION_CONFIDENCE = 0.93;
  const TWIN_LABEL_MIN_BAND_RATIO = 0.18;
  const TWIN_LABEL_ACTIVE_RATIO = 0.018;

  // Keywords that indicate this page is likely a shipping label
  // Twin-label splitting reads the same page canvas up to four times (two axis
  // scans plus a per-band rescan). Share one getImageData read per canvas.
  const pixelCache = new WeakMap();
  function pixelsFor(canvas) {
    let data = pixelCache.get(canvas);
    if (data) return data;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    pixelCache.set(canvas, data);
    return data;
  }

  const LABEL_CUES = [
    "USPS TRACKING", "UPS TRACKING", "FEDEX TRACKING",
    "GROUND ADVANTAGE", "RETURN MAILING LABEL", "RETURN LABEL",
    "RETURN AUTHORIZATION SLIP", "PLACE THIS BARCODE",
    "SHIP TO", "SHIP FROM", "PRIORITY MAIL", "TRACKING NUMBER", "USPS",
  ];

  // Keywords that indicate this is an instruction / return-policy page
  const INSTRUCTION_CUES = [
    "instructions", "return requirements", "refund", "exchange",
    "contact us", "damaged", "eligible", "merchandise",
  ];

  function scoreLabelPage(text) {
    const upper = text.toUpperCase();
    const lower = text.toLowerCase();
    let score = 0;
    for (const cue of LABEL_CUES) {
      if (upper.includes(cue)) score += 1;
    }
    for (const cue of INSTRUCTION_CUES) {
      if (lower.includes(cue)) score -= 0.5;
    }
    return score;
  }

  // Locate the "FOLD HERE" divider and return its position as a fraction from the
  // top of the page (0 = top, 1 = bottom). On UPS "View/Print Label" sheets the
  // actual shipping label sits below this line; everything above it is instructions.
  // Returns null when the page has no fold line.
  function findFoldRatio(items, page, joinedText) {
    if (!/fold\s*here/i.test(joinedText || "")) return null;
    const pageHeight = page.getViewport({ scale: 1 }).height;
    if (!pageHeight) return null;
    // "FOLD HERE" may be one item or split into "FOLD" / "HERE"; the FOLD token's
    // baseline y (transform[5], measured from the page bottom) marks the line.
    const foldItem = items.find((it) => /\bfold\b/i.test(it.str)) || items.find((it) => /fold/i.test(it.str));
    if (!foldItem?.transform) return null;
    const ratioFromTop = 1 - (foldItem.transform[5] / pageHeight);
    return (ratioFromTop > 0.05 && ratioFromTop < 0.95) ? ratioFromTop : null;
  }

  // Bounding rects (scale-1 viewport coords, y from top) of standalone
  // "FOLD HERE" marker text items. The markers are fold instructions in the page
  // margin, not label content — left in place, their dark glyphs survive the
  // faint-rule eraser and keep anchoring content-bounds scans (auto-crop and the
  // print trim) to the margin instead of the label. Only whole-item matches are
  // taken ("FOLD HERE" / "FOLD"; "HERE" only near a matched FOLD), so body text
  // that merely contains the word "fold" is never touched. The rect is built from
  // the item's baseline transform, so rotated/vertical markers are covered too.
  function findFoldMarkerRects(items, page) {
    const pageHeight = page.getViewport({ scale: 1 }).height;
    const foldItems = [];
    const hereItems = [];
    for (const item of items || []) {
      const str = String(item.str || "").trim();
      if (!item.transform) continue;
      if (/^fold(\s+here)?$/i.test(str)) foldItems.push(item);
      else if (/^here$/i.test(str)) hereItems.push(item);
    }
    if (!foldItems.length) return [];

    // "HERE" alone is only a marker when it sits right next to a "FOLD" item
    // (the marker is sometimes split into two text items).
    const near = (a, b, reach) =>
      Math.hypot(a.transform[4] - b.transform[4], a.transform[5] - b.transform[5]) <= reach;
    const markers = foldItems.concat(hereItems.filter((here) => {
      const reach = Math.hypot(here.transform[0], here.transform[1]) * 12;
      return foldItems.some((fold) => near(here, fold, reach));
    }));

    return markers.map((item) => {
      const t = item.transform;
      const baselineLen = Math.hypot(t[0], t[1]) || 1;
      const ux = t[0] / baselineLen;
      const uy = t[1] / baselineLen;
      const vx = -uy;
      const vy = ux;
      const w = Number(item.width || 0) || baselineLen;
      const h = Number(item.height || 0) || baselineLen;
      // Corners in PDF space (y up), with a descender allowance below the baseline.
      const corners = [
        [t[4] - vx * h * 0.35, t[5] - vy * h * 0.35],
        [t[4] + ux * w - vx * h * 0.35, t[5] + uy * w - vy * h * 0.35],
        [t[4] + vx * h, t[5] + vy * h],
        [t[4] + ux * w + vx * h, t[5] + uy * w + vy * h]
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => pageHeight - c[1]); // flip to viewport coords
      const pad = Math.max(2, h * 0.3);
      return {
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + pad * 2,
        height: Math.max(...ys) - Math.min(...ys) + pad * 2
      };
    });
  }

  async function process(captured) {
    try {
      const pdfjsLib = await loadPdfJs();
      const pdf = await pdfjsLib.getDocument({ data: captured.buffer.slice(0) }).promise;
      const textPageLimit = Math.min(pdf.numPages, MAX_TEXT_PAGES);

      // --- Step 1: extract text from all pages in parallel (cheap) ---
      const pageEntries = await Promise.all(
        Array.from({ length: textPageLimit }, async (_, idx) => {
          const pageNum = idx + 1;
          const page = await pdf.getPage(pageNum);
          let text = "";
          let foldRatio = null;
          let foldMarkerRects = [];
          try {
            const textContent = await page.getTextContent();
            text = textContent.items.map((item) => item.str).join(" ");
            foldRatio = findFoldRatio(textContent.items, page, text);
            foldMarkerRects = findFoldMarkerRects(textContent.items, page);
          } catch (_) {}
          const embeddedImageInfo = await extractEmbeddedImages(page, pdfjsLib);
          const embeddedImages = embeddedImageInfo.images;
          const embeddedImageCount = embeddedImageInfo.count;
          return {
            pageIndex: idx,
            pageNum,
            page,
            text,
            foldRatio,
            foldMarkerRects,
            embeddedImages,
            embeddedImageCount,
            priority: scoreLabelPage(text) + Math.min(embeddedImageCount, 3) * 0.75
          };
        })
      );

      // --- Step 2: sort by label priority (highest first) ---
      pageEntries.sort((a, b) => b.priority - a.priority);
      const renderQueue = pageEntries.slice(0, MAX_RENDER_PAGES);

      // --- Step 3: render the best text match first; only stop early for single-page PDFs.
      const pages = [];
      if (renderQueue.length) {
        pages.push(await renderPageEntry(renderQueue[0], pdf.numPages));
        // A single-page PDF has nothing more to render, so a confident hit here
        // lets us return immediately. (firstPass is only meaningful for one-page
        // docs — running it for multi-page PDFs just wastes a detection pass.)
        if (pdf.numPages === 1) {
          const firstPass = await window.LabelExtractorDetector.detectPdfPages(pages);
          if (Number(firstPass?.confidence || 0) >= STRONG_DETECTION_CONFIDENCE) {
            return firstPass;
          }
        }
      }

      for (const entry of renderQueue.slice(1)) {
        pages.push(await renderPageEntry(entry, pdf.numPages));
      }

      const twinLabels = await splitTwinEmbeddedLabelPage(pages);
      if (twinLabels.length === 2) return twinLabels;

      // Hand the rendered pages back without detecting here. The caller
      // (runLocalDetector) runs detectPdfCandidates on these same pages, so
      // running the full cascade here too would double the most expensive step —
      // including ONNX model inference — on every multi-page PDF.
      return { pages };
    } catch (error) {
      console.warn("[Label Extractor] PDF processing failed", error);
      return {
        confidence: 0,
        pageIndex: 0,
        pageCount: 0,
        label: null,
        error
      };
    }
  }

  // Render a single page to a canvas with no detection. Used by Expand, which
  // just needs the raw source page regardless of what the detection cascade did.
  async function renderPage(captured, pageIndex = 0) {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: captured.buffer.slice(0) }).promise;
    const idx = Math.min(Math.max(0, Number(pageIndex) || 0), pdf.numPages - 1);
    const page = await pdf.getPage(idx + 1);
    let text = "";
    let foldMarkerRects = [];
    try {
      const textContent = await page.getTextContent();
      text = textContent.items.map((item) => item.str).join(" ");
      foldMarkerRects = findFoldMarkerRects(textContent.items, page);
    } catch (_) {}
    return renderPageEntry({
      pageIndex: idx,
      page,
      text,
      embeddedImages: [],
      embeddedImageCount: 0,
      foldRatio: null,
      foldMarkerRects
    }, pdf.numPages);
  }

  async function renderPageEntry(entry, pageCount) {
    const { pageIndex, page, text, embeddedImages, embeddedImageCount, foldRatio, foldMarkerRects } = entry;
    const naturalViewport = page.getViewport({ scale: 1 });
    const renderScale = Math.min(4, Math.max(3, 1200 / naturalViewport.width));
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({
      // willReadFrequently: the detectors call getImageData on this canvas many
      // times, so request a CPU-backed context up front to avoid readback warnings.
      canvasContext: canvas.getContext("2d", { willReadFrequently: true }),
      viewport
    }).promise;

    // Erase "FOLD HERE" marker text and the long faint-grey fold/separator rules
    // (UPS "View/Print Label" sheets) before anything reads pixels — both otherwise
    // count as content and stop auto-crop/whitespace-trim at the page margin
    // instead of the label's true edge. The fold detection itself is unaffected:
    // foldRatio comes from the text items, not from pixels. Must run before the
    // pixel caches (pixelsFor here, getCanvasData in the detector) take their
    // snapshot of this canvas.
    if (Array.isArray(foldMarkerRects) && foldMarkerRects.length) {
      const eraseCtx = canvas.getContext("2d", { willReadFrequently: true });
      eraseCtx.fillStyle = "#fff";
      for (const rect of foldMarkerRects) {
        eraseCtx.fillRect(
          Math.floor(rect.x * renderScale),
          Math.floor(rect.y * renderScale),
          Math.ceil(rect.width * renderScale),
          Math.ceil(rect.height * renderScale)
        );
      }
    }
    try { window.LabelExtractorCrop.eraseFaintRules(canvas); } catch (_) {}

    return {
      pageIndex,
      type: "pdf",
      canvas,
      width: canvas.width,
      height: canvas.height,
      naturalWidth: naturalViewport.width,
      naturalHeight: naturalViewport.height,
      pageCount,
      text,
      foldRatio: Number.isFinite(foldRatio) ? foldRatio : null,
      embeddedImages: Array.isArray(embeddedImages) ? embeddedImages : [],
      embeddedImageCount: Number(embeddedImageCount || 0)
    };
  }

  async function extractEmbeddedImages(page, pdfjsLib) {
    try {
      const ops = await page.getOperatorList();
      const objectImageOps = new Set([
        pdfjsLib.OPS.paintImageXObject,
        pdfjsLib.OPS.paintImageXObjectRepeat,
        pdfjsLib.OPS.paintJpegXObject
      ].filter(Number.isFinite));
      const inlineImageOps = new Set([
        pdfjsLib.OPS.paintInlineImageXObject
      ].filter(Number.isFinite));
      const countedImageOps = new Set([
        ...objectImageOps,
        ...inlineImageOps,
        pdfjsLib.OPS.paintInlineImageXObjectGroup,
        pdfjsLib.OPS.paintImageMaskXObject,
        pdfjsLib.OPS.paintImageMaskXObjectRepeat
      ].filter(Number.isFinite));
      const images = [];
      const seen = new Set();
      let count = 0;

      for (let index = 0; index < ops.fnArray.length; index += 1) {
        const fn = ops.fnArray[index];
        const args = ops.argsArray[index] || [];
        let image = null;
        if (countedImageOps.has(fn)) count += 1;

        if (objectImageOps.has(fn) && typeof args[0] === "string") {
          image = await getPageObject(page, args[0]);
        } else if (inlineImageOps.has(fn)) {
          image = args[0];
        }

        const canvas = embeddedImageCanvas(image);
        if (!canvas || canvas.width < 160 || canvas.height < 160) continue;
        const key = `${canvas.width}x${canvas.height}:${args[0] || index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(canvas);
      }

      return { images, count };
    } catch (_) {
      return { images: [], count: 0 };
    }
  }

  function getPageObject(page, objectId) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || null);
      };
      try {
        const immediate = page.objs.get(objectId, finish);
        if (immediate) finish(immediate);
      } catch (_) {
        finish(null);
      }
      setTimeout(() => finish(null), 1200);
    });
  }

  function embeddedImageCanvas(image) {
    if (!image) return null;
    const source = image.bitmap || image;
    const width = Number(source.width || image.width || 0);
    const height = Number(source.height || image.height || 0);
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    try {
      if (source.data) {
        const rgba = rgbaImageData(source.data, width, height);
        if (!rgba) return null;
        ctx.putImageData(rgba, 0, 0);
      } else {
        ctx.drawImage(source, 0, 0, width, height);
      }
      return canvas;
    } catch (_) {
      return null;
    }
  }

  function rgbaImageData(data, width, height) {
    if (!data || data.length !== width * height * 4) return null;
    return new ImageData(new Uint8ClampedArray(data), width, height);
  }

  async function splitTwinEmbeddedLabelPage(pages) {
    const twinPages = pages.filter((page) => Number(page.embeddedImageCount || 0) === 2);
    const totalEmbeddedImages = pages.reduce((sum, page) => sum + Number(page.embeddedImageCount || 0), 0);
    if (twinPages.length !== 1 || totalEmbeddedImages !== 2) return [];

    const page = twinPages[0];
    const rects = findTwinLabelRects(page.canvas);
    if (rects.length !== 2) return [];

    const labels = [];
    for (let index = 0; index < rects.length; index += 1) {
      const label = await cropPortraitLabel(page.canvas, rects[index]);
      labels.push({
        confidence: 0.96,
        reason: "embedded-twin-label",
        carrier: guessCarrier(page.text),
        pageIndex: page.pageIndex,
        pageCount: page.pageCount,
        label,
        cropRect: rects[index],
        sourceWidth: page.canvas.width,
        sourceHeight: page.canvas.height,
        twinLabelIndex: index + 1,
        twinLabelCount: 2,
        variantName: `Label ${index + 1} of 2`,
        warnings: ["Two labels found in this PDF. Print or crop each label before clearing."]
      });
    }
    return labels;
  }

  function findTwinLabelRects(canvas) {
    const yBands = majorContentBands(canvas, "y");
    if (yBands.length === 2) return yBands.map((band) => rectForBand(canvas, "y", band));

    const xBands = majorContentBands(canvas, "x");
    if (xBands.length === 2) return xBands.map((band) => rectForBand(canvas, "x", band));

    return [];
  }

  function majorContentBands(canvas, axis) {
    const { width, height } = canvas;
    const data = pixelsFor(canvas);
    const primarySize = axis === "y" ? height : width;
    const secondarySize = axis === "y" ? width : height;
    const counts = new Uint32Array(primarySize);
    const step = Math.max(1, Math.floor(secondarySize / 900));

    for (let primary = 0; primary < primarySize; primary += 1) {
      let dark = 0;
      for (let secondary = 0; secondary < secondarySize; secondary += step) {
        const x = axis === "y" ? secondary : primary;
        const y = axis === "y" ? primary : secondary;
        const i = (y * width + x) * 4;
        if (data[i + 3] > 16 && data[i] + data[i + 1] + data[i + 2] < 690) dark += step;
      }
      counts[primary] = dark;
    }

    const activeThreshold = Math.max(8, Math.floor(secondarySize * TWIN_LABEL_ACTIVE_RATIO));
    const minBand = Math.floor(primarySize * TWIN_LABEL_MIN_BAND_RATIO);
    const gapLimit = Math.max(16, Math.floor(primarySize * 0.025));
    const bands = [];
    let start = -1;
    let end = -1;
    let lastActive = -1;
    let weight = 0;

    for (let i = 0; i < primarySize; i += 1) {
      if (counts[i] >= activeThreshold) {
        if (start < 0) start = i;
        end = i;
        lastActive = i;
        weight += counts[i];
      } else if (start >= 0 && i - lastActive > gapLimit) {
        if (end - start + 1 >= minBand) bands.push({ start, end, weight });
        start = -1;
        end = -1;
        lastActive = -1;
        weight = 0;
      }
    }

    if (start >= 0 && end - start + 1 >= minBand) bands.push({ start, end, weight });

    return bands
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .sort((a, b) => a.start - b.start);
  }

  function rectForBand(canvas, axis, band) {
    const { width, height } = canvas;
    const data = pixelsFor(canvas);
    const primaryStart = Math.max(0, band.start);
    const primaryEnd = Math.min(axis === "y" ? height - 1 : width - 1, band.end);
    const secondarySize = axis === "y" ? width : height;
    const primaryLength = primaryEnd - primaryStart + 1;
    const threshold = Math.max(4, Math.floor(primaryLength * 0.012));
    let secondaryStart = -1;
    let secondaryEnd = -1;

    for (let secondary = 0; secondary < secondarySize; secondary += 1) {
      let dark = 0;
      for (let primary = primaryStart; primary <= primaryEnd; primary += 2) {
        const x = axis === "y" ? secondary : primary;
        const y = axis === "y" ? primary : secondary;
        const i = (y * width + x) * 4;
        if (data[i + 3] > 16 && data[i] + data[i + 1] + data[i + 2] < 690) dark += 2;
      }
      if (dark >= threshold) {
        if (secondaryStart < 0) secondaryStart = secondary;
        secondaryEnd = secondary;
      }
    }

    const padX = Math.round(width * 0.012);
    const padY = Math.round(height * 0.012);
    if (axis === "y") {
      const x = Math.max(0, secondaryStart - padX);
      const y = Math.max(0, primaryStart - padY);
      const right = Math.min(width, secondaryEnd + padX);
      const bottom = Math.min(height, primaryEnd + padY);
      return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
    }

    const x = Math.max(0, primaryStart - padX);
    const y = Math.max(0, secondaryStart - padY);
    const right = Math.min(width, primaryEnd + padX);
    const bottom = Math.min(height, secondaryEnd + padY);
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  async function cropPortraitLabel(canvas, rect) {
    const label = await window.LabelExtractorCrop.cropCanvas(canvas, rect);
    if (label.width <= label.height) return label;

    const image = await loadImage(label.dataUrl);
    const rotated = document.createElement("canvas");
    rotated.width = image.height;
    rotated.height = image.width;
    const ctx = rotated.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, rotated.width, rotated.height);
    ctx.translate(rotated.width / 2, rotated.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    return {
      dataUrl: rotated.toDataURL("image/png"),
      width: rotated.width,
      height: rotated.height
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

  function guessCarrier(text) {
    const value = String(text || "").toUpperCase();
    if (/\bUPS\b|UPS TRACKING|UPS GROUND|1Z[0-9A-Z]{16}/.test(value)) return "UPS";
    if (/USPS|POSTAL SERVICE|GROUND ADVANTAGE|PRIORITY MAIL/.test(value)) return "USPS";
    if (/FEDEX|FEDERAL EXPRESS/.test(value)) return "FedEx";
    return "Model";
  }

  window.LabelExtractorPDF = { process, renderPage };
})();
