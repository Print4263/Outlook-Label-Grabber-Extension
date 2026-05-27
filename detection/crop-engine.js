(function () {
  "use strict";

  const CROP_SAFETY_PADDING_RATIO = 0.018;
  const CROP_SAFETY_MIN_PADDING = 3;
  const CONTENT_SCAN_ROW_STEP = 2;

  function imageDataToCanvas(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    return canvas;
  }

  async function autoCropCanvas(sourceCanvas, padding = 6) {
    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = sourceCanvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const bounds = findContentBounds(data, width, height);

    if (!bounds) {
      return canvasToLabel(sourceCanvas);
    }

    return cropCanvas(sourceCanvas, {
      x: Math.max(0, bounds.left - padding),
      y: Math.max(0, bounds.top - padding),
      width: Math.min(width - Math.max(0, bounds.left - padding), bounds.right - bounds.left + 1 + padding * 2),
      height: Math.min(height - Math.max(0, bounds.top - padding), bounds.bottom - bounds.top + 1 + padding * 2)
    });
  }

  function findContentBounds(data, width, height) {
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
    const top = firstIndexAtLeast(rowCounts, rowThreshold);
    const bottom = lastIndexAtLeast(rowCounts, rowThreshold);
    const left = firstIndexAtLeast(colCounts, colThreshold);
    const right = lastIndexAtLeast(colCounts, colThreshold);

    if (left < 0 || right < 0 || top < 0 || bottom < 0 || left >= right || top >= bottom) return null;
    return { left, right, top, bottom };
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

  async function cropCanvas(sourceCanvas, rect) {
    const normalized = normalizeRect(expandRect(rect, sourceCanvas, CROP_SAFETY_PADDING_RATIO), sourceCanvas);
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

  function expandRect(rect, canvas, ratio) {
    const growX = Math.max(CROP_SAFETY_MIN_PADDING, rect.width * ratio);
    const growY = Math.max(CROP_SAFETY_MIN_PADDING, rect.height * ratio);
    return {
      x: rect.x - growX,
      y: rect.y - growY,
      width: rect.width + growX * 2,
      height: rect.height + growY * 2
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

  async function printLabel(label) {
    const printWidth = clamp(Number(label.printWidth || 4), 2, 7.5);
    const printLeft = clamp(Number(label.printLeft || 0), 0, 7.5);
    const printTop = clamp(Number(label.printTop || 0), -1, 10);
    const maxWidth = Math.max(0.5, 8.5 - printLeft);
    const maxHeight = Math.max(0.5, 11 - Math.max(0, printTop));
    const outputWidthIn = Math.min(printWidth, maxWidth);
    const printDataUrl = await renderForPrint(label, outputWidthIn, maxHeight, 600);
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);

    let removed = false;
    const removeFrame = () => {
      if (removed) return;
      removed = true;
      iframe.remove();
    };

    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`<!doctype html>
<html>
<head>
  <title>Print Label</title>
  <style>
    @page label-extractor-letter {
      size: 8.5in 11in;
      margin: 0;
    }
    @page {
      size: 8.5in 11in;
      margin: 0;
    }
    html,
    body {
      margin: 0 !important;
      padding: 0 !important;
      width: 8.5in !important;
      min-width: 8.5in !important;
      max-width: 8.5in !important;
      height: 11in !important;
      min-height: 11in !important;
      max-height: 11in !important;
      background: #fff !important;
      overflow: hidden !important;
    }
    body {
      page: label-extractor-letter;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    .sheet {
      box-sizing: border-box;
      width: 8.5in !important;
      height: 11in !important;
      overflow: hidden;
      background: #fff;
      page-break-after: avoid;
      break-after: avoid;
    }
    img {
      display: block;
      margin-left: ${printLeft}in;
      margin-top: ${printTop}in;
      width: ${outputWidthIn}in;
      height: auto;
      max-width: ${maxWidth}in;
      max-height: ${maxHeight}in;
      image-rendering: pixelated;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    }
    @media print {
      @page {
        size: 8.5in 11in;
        margin: 0;
      }
      html,
      body,
      .sheet {
        width: 8.5in !important;
        height: 11in !important;
      }
    }
  </style>
</head>
<body>
  <main class="sheet" aria-label="Letter size print sheet">
    <img src="${printDataUrl}" alt="Shipping label">
  </main>
</body>
</html>`);
    doc.close();

    iframe.onload = () => {
      setTimeout(() => {
        iframe.contentWindow.addEventListener("afterprint", removeFrame, { once: true });
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(removeFrame, 120000);
      }, 100);
    };
  }

  async function renderForPrint(label, widthIn, maxHeightIn, dpi) {
    const image = await loadImage(label.dataUrl);
    const aspect = image.width / Math.max(1, image.height);
    let targetWidth = Math.max(image.width, Math.round(widthIn * dpi));
    let targetHeight = Math.round(targetWidth / aspect);
    const maxHeightPx = Math.round(maxHeightIn * dpi);

    if (targetHeight > maxHeightPx) {
      targetHeight = maxHeightPx;
      targetWidth = Math.round(targetHeight * aspect);
    }

    if (targetWidth === image.width && targetHeight === image.height) {
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      enhanceLabelForPrint(canvas);
      return canvas.toDataURL("image/png");
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    enhanceLabelForPrint(canvas);
    return canvas.toDataURL("image/png");
  }

  function enhanceLabelForPrint(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;
    let sampled = 0;
    let colored = 0;

    for (let i = 0; i < data.length; i += 160) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      sampled += 1;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 28) colored += 1;
    }

    if (sampled && colored / sampled > 0.16) return;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let next = lum;

      if (lum < 128) next = 0;
      else next = 255;

      data[i] = next;
      data[i + 1] = next;
      data[i + 2] = next;
      data[i + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
  }

  window.LabelExtractorCrop = {
    autoCropCanvas,
    cropCanvas,
    rotateDataUrl,
    canvasToLabel,
    imageDataToCanvas,
    printLabel
  };
})();
