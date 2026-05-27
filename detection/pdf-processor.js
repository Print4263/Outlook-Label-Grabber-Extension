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
      canvasContext: canvas.getContext("2d"),
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

  window.LabelExtractorPDF = { process };
})();
