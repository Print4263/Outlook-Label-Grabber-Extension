// Print pipeline: monochrome conversion, 4x6/letter print HTML, and the print
// window/iframe flow. Plain (non-module) script: these functions stay global and
// are called from sidepanel.js (printLabelAtIndex) exactly as before. They rely on
// loadImage, escapeHtml, clamp, and state, which remain defined in sidepanel.js.

// Quiet-zone border left around the trimmed label content when filling the 4x6
// sheet, in inches, equal on all sides. Tunable: lower = bigger label (and closer
// to the printer's non-printable edge, so watch for edge clipping), higher = more
// breathing room.
const LABEL_PRINT_MARGIN_INCH = 0;

function applyUnsharpMask(lums, width, height, radius, amount) {
  const kernelSize = radius * 2 + 1;
  const invK = 1 / kernelSize;
  const temp = new Float32Array(lums.length);
  const blurred = new Float32Array(lums.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        sum += lums[row + Math.max(0, Math.min(width - 1, x + dx))];
      }
      temp[row + x] = sum * invK;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        sum += temp[Math.max(0, Math.min(height - 1, y + dy)) * width + x];
      }
      blurred[y * width + x] = sum * invK;
    }
  }

  for (let i = 0; i < lums.length; i++) {
    lums[i] = Math.max(0, Math.min(255, Math.round(lums[i] + amount * (lums[i] - blurred[i]))));
  }
}

function otsuThreshold(lums) {
  const hist = new Int32Array(256);
  for (let i = 0; i < lums.length; i++) hist[lums[i]]++;
  const total = lums.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; threshold = t; }
  }
  return threshold;
}

async function resizeToLabelDpi(dataUrl, dpi = 203) {
  const targetW = Math.round(4 * dpi);
  const targetH = Math.round(6 * dpi);
  const image = await loadImage(dataUrl);

  const trimmed = trimWhitespaceCanvas(image);

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, targetW, targetH);
  // Source has already been whitespace-trimmed to the label's true content. Place
  // it inside a quiet-zone margin instead of flush to the edges, so content isn't
  // jammed against the physical cut edge (thermal printers can clip the very edge,
  // and barcodes need a quiet zone). The remaining area stays the label's ~4:6
  // aspect, so this is a near-uniform scale into the inset box.
  const m = Math.round(LABEL_PRINT_MARGIN_INCH * dpi);
  ctx.drawImage(trimmed.canvas, 0, 0, trimmed.width, trimmed.height, m, m, targetW - m * 2, targetH - m * 2);
  return canvas.toDataURL("image/png");
}

// Crop surrounding white margins off a label image so the content fills the 4x6
// print area instead of printing small with big white borders. Returns the
// content-bounds canvas (or the original if it is already edge-to-edge / blank).
function trimWhitespaceCanvas(image) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(image, 0, 0);
  const data = sctx.getImageData(0, 0, w, h).data;
  const whiteThreshold = 246;
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  const rowHasContent = (y) => {
    const base = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = base + x * 4;
      if (data[i + 3] < 16) continue;
      if (data[i] < whiteThreshold || data[i + 1] < whiteThreshold || data[i + 2] < whiteThreshold) return true;
    }
    return false;
  };
  const colHasContent = (x) => {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 16) continue;
      if (data[i] < whiteThreshold || data[i + 1] < whiteThreshold || data[i + 2] < whiteThreshold) return true;
    }
    return false;
  };
  while (top < bottom && !rowHasContent(top)) top++;
  while (bottom > top && !rowHasContent(bottom)) bottom--;
  while (left < right && !colHasContent(left)) left++;
  while (right > left && !colHasContent(right)) right--;

  const cw = right - left + 1;
  const ch = bottom - top + 1;
  if (cw <= 0 || ch <= 0 || (cw === w && ch === h)) {
    return { canvas: src, width: w, height: h };
  }
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(src, left, top, cw, ch, 0, 0, cw, ch);
  return { canvas: out, width: cw, height: ch };
}

async function prepareForPrint(dataUrl) {
  const image = await loadImage(dataUrl);

  const probe = document.createElement("canvas");
  probe.width = Math.min(200, image.naturalWidth);
  probe.height = Math.min(200, image.naturalHeight);
  const pCtx = probe.getContext("2d", { willReadFrequently: true });
  pCtx.drawImage(image, 0, 0, probe.width, probe.height);
  const sample = pCtx.getImageData(0, 0, probe.width, probe.height).data;
  let colored = 0;
  for (let i = 0; i < sample.length; i += 16) {
    if (Math.max(sample[i], sample[i + 1], sample[i + 2]) - Math.min(sample[i], sample[i + 1], sample[i + 2]) > 28) colored++;
  }
  const isColorLabel = colored / (sample.length / 16) > 0.12;
  if (isColorLabel) return dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  const pixelCount = d.length / 4;
  const lums = new Uint8Array(pixelCount);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    lums[j] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  applyUnsharpMask(lums, canvas.width, canvas.height, 1, 1.5);
  const threshold = otsuThreshold(lums);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const val = lums[j] < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = val;
    d[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return canvas.toDataURL("image/png");
}

function printDataUrl(dataUrl) {
  // Open an independent, screen-centered print window (what staff prefer to see).
  // Printing is driven from here (the parent) once the label image has actually
  // loaded, then the window closes itself after printing — a single deterministic
  // trigger, instead of the blank/early dialog the old timed retries could cause.
  const bounds = getPrintPopupBounds();
  const printWindow = window.open("", "_blank", [
    `width=${bounds.width}`,
    `height=${bounds.height}`,
    `left=${bounds.left}`,
    `top=${bounds.top}`,
    `screenX=${bounds.left}`,
    `screenY=${bounds.top}`
  ].join(","));

  if (printWindow) {
    positionPrintWindow(printWindow, bounds);
    printWindow.document.open();
    printWindow.document.write(makePrintHtml(dataUrl));
    printWindow.document.close();
    printWindowWhenReady(printWindow);
    return;
  }

  // Popup was blocked — fall back to a hidden off-screen iframe so printing
  // still works without a visible window.
  const frame = document.createElement("iframe");
  frame.className = "print-frame";
  frame.setAttribute("aria-hidden", "true");

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    frame.remove();
  };

  frame.addEventListener("load", () => {
    const win = frame.contentWindow;
    if (!win) { cleanup(); return; }
    whenLabelImageReady(frame.contentDocument, () => {
      try {
        win.addEventListener("afterprint", () => setTimeout(cleanup, 250), { once: true });
        win.focus();
        win.print();
      } catch (_) {
        cleanup();
        return;
      }
      setTimeout(cleanup, 120000); // backstop if afterprint never fires
    });
  }, { once: true });

  document.body.append(frame);
  frame.srcdoc = makePrintHtml(dataUrl);
}

// Print the centered popup window once its label image is loaded, then let it
// close itself after the print dialog is dismissed.
function printWindowWhenReady(win) {
  let printed = false;
  const fire = () => {
    if (printed || win.closed) return;
    printed = true;
    try {
      win.addEventListener("afterprint", () => {
        setTimeout(() => { try { win.close(); } catch (_) {} }, 250);
      }, { once: true });
      win.focus();
      win.print();
    } catch (_) {}
  };

  whenLabelImageReady(win.document, fire);
  // Safety net: a data-URL image is effectively instant, but never leave the
  // window hanging if the load event somehow doesn't arrive.
  setTimeout(fire, 3000);
}

// Invoke callback once the #label image in doc has loaded (or immediately if
// it is already complete / missing).
function whenLabelImageReady(doc, callback) {
  const img = doc && doc.getElementById("label");
  if (!img || img.complete) {
    callback();
    return;
  }
  img.addEventListener("load", callback, { once: true });
  img.addEventListener("error", callback, { once: true });
}

function getPrintPopupBounds() {
  const screenLeft = Number(window.screen.availLeft || 0);
  const screenTop = Number(window.screen.availTop || 0);
  const screenWidth = Number(window.screen.availWidth || window.screen.width || 1280);
  const screenHeight = Number(window.screen.availHeight || window.screen.height || 900);
  const width = Math.max(900, Math.min(1180, screenWidth - 40));
  const height = Math.max(760, Math.min(980, screenHeight - 40));
  return {
    width,
    height,
    left: Math.max(screenLeft, Math.round(screenLeft + (screenWidth - width) / 2)),
    top: Math.max(screenTop, Math.round(screenTop + (screenHeight - height) / 2))
  };
}

function positionPrintWindow(win, bounds) {
  try {
    win.moveTo(bounds.left, bounds.top);
    win.resizeTo(bounds.width, bounds.height);
    win.focus();
  } catch (_) {}
}

function makePrintHtml(dataUrl) {
  const escaped = escapeHtml(dataUrl);
  const width = clamp(Number(state.printWidth || 4), 2.5, 8.5);
  const left = clamp(Number(state.printLeft || 0), 0, 7.5);
  const top = clamp(Number(state.printTop || 0), 0, 10);
  const isLabelMode = state.printMode === "label";
  if (isLabelMode) return makeLabelPrintHtml(escaped);
  const maxWidth = Math.max(0.5, 8.5 - left);
  const maxHeight = Math.max(0.5, 11 - top);
  const labelWidth = Math.min(width, maxWidth);
  const labelHeight = Math.min(labelWidth * 1.5, maxHeight);
  const viewportWidth = 980;
  const scale = Math.max(0.72, Math.min(1, (viewportWidth - 80) / 816));
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Print Label</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: 8.5in 11in; margin: 0; }
    html { margin: 0; padding: 0; min-height: 100%; background: #e8eaed; }
    body {
      margin: 0 auto; padding: 0; width: 8.5in; height: 11in;
      background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      position: relative; overflow: hidden;
      transform: scale(${scale}); transform-origin: top center;
    }
    .label {
      position: absolute; left: ${left}in; top: ${top}in;
      width: ${labelWidth}in; height: ${labelHeight}in;
      overflow: hidden; background: #fff;
    }
    img {
      width: 100%; height: 100%; display: block;
      image-rendering: pixelated;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    }
    @media print {
      html { background: #fff; }
      body { margin: 0; box-shadow: none; transform: none; width: 8.5in; height: 11in; }
    }
  </style>
</head>
<body>
  <div class="label"><img id="label" src="${escaped}" alt="Shipping label"></div>
</body>
</html>`;
}

function makeLabelPrintHtml(escapedDataUrl) {
  const viewportWidth = 980;
  const scale = Math.max(0.85, Math.min(1.3, (viewportWidth - 120) / 384));
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Print 4x6 Label</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: 4in 6in; margin: 0; }
    html { margin: 0; padding: 0; min-height: 100%; background: #e8eaed; }
    body {
      margin: 0 auto; padding: 0; width: 4in; height: 6in;
      background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      overflow: hidden; transform: scale(${scale}); transform-origin: top center;
    }
    img {
      width: 4in; height: 6in; display: block; object-fit: contain;
      background: #fff;
      image-rendering: pixelated;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
    }
    @media print {
      html { background: #fff; }
      body { margin: 0; box-shadow: none; transform: none; width: 4in; height: 6in; }
    }
  </style>
</head>
<body>
  <img id="label" src="${escapedDataUrl}" alt="Shipping label">
</body>
</html>`;
}
