(function () {
  "use strict";

  async function loadPdfJs() {
    if (!window.pdfjsLib) throw new Error("PDF reader could not start.");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
    return window.pdfjsLib;
  }

  const MAX_TEXT_PAGES = 20;
  const MAX_RENDER_PAGES = 6;
  const STRONG_DETECTION_CONFIDENCE = 0.93;
  const TWIN_LABEL_MIN_BAND_RATIO = 0.18;
  const TWIN_LABEL_ACTIVE_RATIO = 0.018;

  // Keywords that indicate this page is likely a shipping label
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
          try {
            const textContent = await page.getTextContent();
            text = textContent.items.map((item) => item.str).join(" ");
          } catch (_) {}
          const embeddedImageCount = await countEmbeddedImages(page, pdfjsLib);
          return {
            pageIndex: idx,
            pageNum,
            page,
            text,
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
        const firstPass = await window.LabelExtractorDetector.detectPdfPages(pages);
        if (pdf.numPages === 1 && Number(firstPass?.confidence || 0) >= STRONG_DETECTION_CONFIDENCE) {
          return firstPass;
        }
      }

      for (const entry of renderQueue.slice(1)) {
        pages.push(await renderPageEntry(entry, pdf.numPages));
      }

      const twinLabels = await splitTwinEmbeddedLabelPage(pages);
      if (twinLabels.length === 2) return twinLabels;

      return window.LabelExtractorDetector.detectPdfPages(pages);
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

  async function renderPageEntry(entry, pageCount) {
    const { pageIndex, page, text, embeddedImageCount } = entry;
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
      embeddedImageCount: Number(embeddedImageCount || 0)
    };
  }

  async function countEmbeddedImages(page, pdfjsLib) {
    try {
      const ops = await page.getOperatorList();
      const imageOps = new Set([
        pdfjsLib.OPS.paintImageXObject,
        pdfjsLib.OPS.paintImageXObjectRepeat,
        pdfjsLib.OPS.paintInlineImageXObject,
        pdfjsLib.OPS.paintInlineImageXObjectGroup,
        pdfjsLib.OPS.paintImageMaskXObject,
        pdfjsLib.OPS.paintImageMaskXObjectRepeat,
        pdfjsLib.OPS.paintJpegXObject
      ].filter(Number.isFinite));
      return ops.fnArray.reduce((count, fn) => count + (imageOps.has(fn) ? 1 : 0), 0);
    } catch (_) {
      return 0;
    }
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
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
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
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
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

  window.LabelExtractorPDF = { process };
})();
