// Crop editor + image transforms: opening/closing the crop UI, the snap-to-label
// suggestion, crop-box drag/resize math, applying a manual crop, and the canvas
// helpers (autoOrientLabel, orientLabelToPortrait, labelFromCanvas) used by crop and
// by the extraction orchestrator. Plain (non-module) script: all stay global and use
// shared helpers (state, els, loadImage, labelToDataUrl, rotateLabel, setStatus,
// renderResults, updateSheetPreview, LabelExtractorDetector) defined in sidepanel.js.

function openCropEditor(index) {
  state.cropTargetIndex = index;
  resetCropBox();
  els.cropImage.src = labelToDataUrl(state.results[index]);
  els.cropEditor.hidden = false;
  els.cropImage.addEventListener("load", snapCropBoxToCurrentImage, { once: true });

  if (usesTallCropSource(state.results[index])) {
    els.cropImage.addEventListener("load", () => {
      const containerWidth = els.cropStage.clientWidth || 400;
      const naturalAspect = (els.cropImage.naturalWidth || 1) / Math.max(1, els.cropImage.naturalHeight || 1);
      const idealHeight = Math.round(containerWidth / naturalAspect);
      const maxHeight = Math.round(window.innerHeight * 0.92);
      els.cropStage.style.height = `${Math.min(idealHeight, maxHeight)}px`;
      positionCropLayerToImage();
    }, { once: true });
  } else {
    els.cropStage.style.height = "";
    els.cropImage.addEventListener("load", positionCropLayerToImage, { once: true });
  }

  setTimeout(positionCropLayerToImage, 50);
  requestAnimationFrame(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
}

function snapCropBoxToCurrentImage() {
  const label = state.results[state.cropTargetIndex];
  if (!label || label.suggestedCropRect) return;

  const canvas = document.createElement("canvas");
  canvas.width = els.cropImage.naturalWidth || els.cropImage.width;
  canvas.height = els.cropImage.naturalHeight || els.cropImage.height;
  if (!canvas.width || !canvas.height) return;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(els.cropImage, 0, 0, canvas.width, canvas.height);
  const rect = window.LabelExtractorDetector?.suggestLabelRect?.(canvas, label.pageText || "");
  const snapped = snapCropRectToSource(rect, canvas);
  if (!snapped) {
    setStatus("Couldn't auto-detect the label — drag the crop box to the label, then click Apply crop.");
    return;
  }

  state.cropRect = snapped;
  renderCropBox();
  setStatus("Crop box snapped to the likely label. Adjust if needed, then click Apply crop.");
}

function closeCropEditor() {
  els.cropEditor.hidden = true;
  state.cropTargetIndex = -1;
  els.cropStage.style.height = "";
}

function resetCropBox() {
  const label = state.results[state.cropTargetIndex];

  state.cropRect = label?.suggestedCropRect
    ? { ...label.suggestedCropRect }
    : usesTallCropSource(label)
    ? initialFallbackCropRect(label)
    : { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
  renderCropBox();
}

function snapCropRectToSource(rect, canvas) {
  if (!rect || !canvas?.width || !canvas?.height) return null;
  const padX = Math.max(12, Number(rect.width || 0) * 0.035);
  const padY = Math.max(12, Number(rect.height || 0) * 0.035);
  const left = clamp(Number(rect.x || 0) - padX, 0, canvas.width - 1);
  const top = clamp(Number(rect.y || 0) - padY, 0, canvas.height - 1);
  const right = clamp(Number(rect.x || 0) + Number(rect.width || 0) + padX, left + 1, canvas.width);
  const bottom = clamp(Number(rect.y || 0) + Number(rect.height || 0) + padY, top + 1, canvas.height);
  return {
    x: left / canvas.width,
    y: top / canvas.height,
    width: (right - left) / canvas.width,
    height: (bottom - top) / canvas.height
  };
}

function initialFallbackCropRect(label) {
  const imgW = Number(label?.width || 0);
  const imgH = Number(label?.height || 0);
  if (imgW <= 0 || imgH <= 0) {
    return { x: 0.18, y: 0.08, width: 0.64, height: 0.84 };
  }

  const imageAspect = imgW / imgH;
  let width = FALLBACK_CROP_INITIAL_WIDTH;
  let height = width * imageAspect / LABEL_ASPECT_4X6;
  if (height > FALLBACK_CROP_MAX_SIZE) {
    height = FALLBACK_CROP_MAX_SIZE;
    width = height * LABEL_ASPECT_4X6 / imageAspect;
  }
  if (width > FALLBACK_CROP_MAX_SIZE) {
    width = FALLBACK_CROP_MAX_SIZE;
    height = width * imageAspect / LABEL_ASPECT_4X6;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

function usesTallCropSource(label) {
  const name = String(label?.variantName || "").toLowerCase();
  const reason = String(label?.localReason || "").toLowerCase();
  const warnings = (label?.warnings || []).join(" ").toLowerCase();
  return name.includes("full page")
    || reason.includes("fallback")
    || warnings.includes("fallback");
}

async function autoOrientLabel(label) {
  const oriented = await orientLabelToPortrait(label);
  return [oriented, oriented !== label];
}

function drawRotated(img, quarterTurns) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  const sideways = turns % 2 === 1;
  const canvas = document.createElement("canvas");
  canvas.width = sideways ? img.height : img.width;
  canvas.height = sideways ? img.width : img.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((Math.PI / 2) * turns);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return canvas;
}

// 4x6 shipping labels are portrait; the print path forces portrait dimensions, so
// a landscape result (common when a label image was placed sideways/rotated in the
// source PDF) would print squished. Rotate any landscape candidate upright while
// preserving its variant name and metadata. The rotation direction is decided by
// content, not fixed: a source rotated the "other way" used to land upside down
// after the blind clockwise turn. detectUprightFlip() finds the 1D barcode bands
// and flags a label whose barcodes sit at the top, so both landscape directions
// and upside-down portrait sources all come out reading sender top-left, barcode
// at the bottom. No-op when the label is already portrait and looks upright.
async function orientLabelToPortrait(label) {
  if (!label) return label;
  // Prefer the detection pipeline's canvas (sourceCanvas, carried by
  // localDetectionToLabel): drawing from it skips the base64 PNG decode that
  // every candidate used to pay here. Checking sourceCanvas FIRST also matters
  // for laziness — reading .base64 on a canvas-backed label forces its encode.
  const sourceCanvas = label.sourceCanvas || null;
  if (!sourceCanvas && !label.base64) return label;

  let img = sourceCanvas;
  if (!img) {
    try {
      img = await loadImage(labelToDataUrl(label));
    } catch (_) {
      return label;
    }
  }
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return label;

  const crop = window.LabelExtractorCrop || {};
  const detectFlip = crop.detectUprightFlip;
  const bandStats = crop.barcodeBandStats;
  const minMass = Number(crop.FLIP_MIN_MASS || 600);
  let canvas;
  if (w > h) {
    canvas = drawRotated(img, 1);
    if (detectFlip && detectFlip(canvas)) canvas = drawRotated(img, 3);
  } else if (bandStats) {
    // A canvas source is scanned in place (crops are white-backed already);
    // decoded images still need the white-backed copy drawRotated produces.
    const probe = sourceCanvas || drawRotated(img, 0);
    const upright = bandStats(probe);
    if (upright && upright.mass >= minMass) {
      // Confident horizontal tracking band: a normal portrait label. Flip
      // 180 only when that band sits in the top half (upside-down source).
      if (upright.centroidRatio >= 0.45) return label;
      canvas = drawRotated(img, 2);
    } else {
      // No horizontal band — the label may be lying SIDEWAYS inside this
      // portrait crop (a photo of a label rotated 90°). Probe a quarter
      // turn: the bars only scan as a band when that's actually the case,
      // so upright barcode-less labels are never touched. Normal labels
      // never reach this probe (their upright band is strong).
      const turned = drawRotated(img, 1);
      const stats = bandStats(turned);
      if (!stats || stats.mass < minMass || stats.mass <= (upright?.mass || 0) * 1.5) return label;
      const uprightCanvas = stats.centroidRatio < 0.45 ? drawRotated(img, 3) : turned;
      // The quarter-turned canvas is landscape, and the print path squishes
      // landscape into the 4x6 box. When a tight PORTRAIT label rect exists
      // inside the upright view (a rotated 4x6 photographed with junk around
      // it), snap-crop it out — that prints upright. Otherwise the label is a
      // portrait-shaped sideways design (Amazon mobile return labels): keep
      // portrait and only normalize the facing direction, so every sideways
      // print reads the same way when the sheet is turned clockwise.
      const rect = window.LabelExtractorDetector?.suggestLabelRect?.(uprightCanvas, "");
      if (rect && rect.height > rect.width) {
        const snapped = await window.LabelExtractorCrop.cropCanvas(uprightCanvas, rect);
        if (snapped?.canvas && snapped.canvas.width <= snapped.canvas.height) {
          canvas = snapped.canvas;
          return orientedLabelFromCanvas(label, canvas);
        }
      }
      if (stats.centroidRatio >= 0.45) return label; // already faces the conventional way
      canvas = drawRotated(img, 2);
    }
  } else {
    if (!detectFlip) return label;
    const probe = sourceCanvas || drawRotated(img, 0);
    if (!detectFlip(probe)) return label;
    canvas = drawRotated(img, 2);
  }

  return orientedLabelFromCanvas(label, canvas);
}

// Copy the label's plain fields without touching base64 (reading it would
// force the pre-rotation encode nobody needs), then hang the rotated canvas's
// own lazy base64 on the copy.
function orientedLabelFromCanvas(label, canvas) {
  const next = {};
  for (const key of Object.keys(label)) {
    if (key === "base64") continue;
    next[key] = label[key];
  }
  next.sourceCanvas = canvas;
  next.outputMimeType = "image/png";
  next.width = canvas.width;
  next.height = canvas.height;
  next.autoOriented = true;
  defineLazyBase64(next, window.LabelExtractorCrop.canvasToLabel(canvas));
  return next;
}

async function applyManualCrop() {
  try {
    const index = state.cropTargetIndex;
    const label = state.results[index];
    if (!label) {
      setStatus("Crop failed: no crop target selected.");
      return;
    }

    const image = await loadImage(labelToDataUrl(label));
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const sx = Math.round(state.cropRect.x * sourceWidth);
    const sy = Math.round(state.cropRect.y * sourceHeight);
    const sw = Math.max(1, Math.round(state.cropRect.width * sourceWidth));
    const sh = Math.max(1, Math.round(state.cropRect.height * sourceHeight));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

    const cropName = label.twinLabelCount > 1
      ? `Label ${label.twinLabelIndex || index + 1} of ${label.twinLabelCount} crop`
      : "Manual crop";
    const [croppedLabel, wasRotated] = await autoOrientLabel(labelFromCanvas(canvas, label, cropName));
    if (label.twinLabelCount > 1) {
      state.results[index] = croppedLabel;
      state.selectedLabelIndex = index;
    } else {
      state.results.splice(index, 1);
      state.results.unshift(croppedLabel);
      state.selectedLabelIndex = 0;
    }
    closeCropEditor();
    renderResults({ labels: state.results });
    updateSheetPreview();
    setStatus(wasRotated ? "Manual crop applied — auto-rotated to portrait." : "Manual crop applied.");
    document.querySelector(".label-card")?.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    setStatus(`Crop failed: ${error.message}`);
  }
}

function labelFromCanvas(canvas, prior, variantName) {
  const dataUrl = canvas.toDataURL("image/png");
  return {
    ...prior,
    variantName,
    outputMimeType: "image/png",
    base64: dataUrl.split(",")[1],
    // The canvas is the new image, so its dimensions are authoritative. Without
    // this, a rotated/cropped label keeps its pre-change width/height.
    width: canvas.width,
    height: canvas.height,
    confidence: Math.max(prior.confidence || 0, 0.5),
    warnings: ["Manually adjusted in extension; review before printing."]
  };
}

function bindCropBoxEvents() {
  let dragging = null;
  let start = null;
  els.cropBox.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = event.target.dataset.handle || "move";
    start = { x: event.clientX, y: event.clientY, rect: { ...state.cropRect } };
    els.cropBox.setPointerCapture(event.pointerId);
  });
  els.cropBox.addEventListener("pointermove", (event) => {
    if (!dragging || !start) return;
    event.preventDefault();
    const bounds = els.cropLayer.getBoundingClientRect();
    const dx = (event.clientX - start.x) / Math.max(1, bounds.width);
    const dy = (event.clientY - start.y) / Math.max(1, bounds.height);
    if (dragging === "move") {
      state.cropRect.x = clamp(start.rect.x + dx, 0, 1 - start.rect.width);
      state.cropRect.y = clamp(start.rect.y + dy, 0, 1 - start.rect.height);
    } else {
      resizeCropRect(start.rect, dragging, dx, dy);
    }
    renderCropBox();
  });
  els.cropBox.addEventListener("pointerup", (event) => {
    event.preventDefault();
    dragging = null;
  });
  els.cropBox.addEventListener("pointercancel", () => {
    dragging = null;
  });
}

function resizeCropRect(original, handle, dx, dy) {
  const min = 0.08;
  const CROP_DRAG_SPEED = 1.5;
  const SHRINK = 0.375;

  const fastDx = dx * CROP_DRAG_SPEED;
  const fastDy = dy * CROP_DRAG_SPEED;
  const adx = ((handle.includes("w") && fastDx > 0) || (handle.includes("e") && fastDx < 0)) ? fastDx * SHRINK : fastDx;
  const ady = ((handle.includes("n") && fastDy > 0) || (handle.includes("s") && fastDy < 0)) ? fastDy * SHRINK : fastDy;

  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;
  if (handle.includes("w")) left = clamp(original.x + adx, 0, right - min);
  if (handle.includes("e")) right = clamp(original.x + original.width + adx, left + min, 1);
  if (handle.includes("n")) top = clamp(original.y + ady, 0, bottom - min);
  if (handle.includes("s")) bottom = clamp(original.y + original.height + ady, top + min, 1);
  state.cropRect = { x: left, y: top, width: right - left, height: bottom - top };
}

function renderCropBox() {
  els.cropBox.style.left = `${state.cropRect.x * 100}%`;
  els.cropBox.style.top = `${state.cropRect.y * 100}%`;
  els.cropBox.style.width = `${state.cropRect.width * 100}%`;
  els.cropBox.style.height = `${state.cropRect.height * 100}%`;
}

function positionCropLayerToImage() {
  if (els.cropEditor.hidden) return;
  const stageRect = els.cropImage.parentElement.getBoundingClientRect();
  const imageRect = fittedImageRect(els.cropImage);
  els.cropLayer.style.left = `${imageRect.left - stageRect.left}px`;
  els.cropLayer.style.top = `${imageRect.top - stageRect.top}px`;
  els.cropLayer.style.width = `${imageRect.width}px`;
  els.cropLayer.style.height = `${imageRect.height}px`;
}

function fittedImageRect(image) {
  const box = image.getBoundingClientRect();
  const naturalWidth = image.naturalWidth || image.width || 1;
  const naturalHeight = image.naturalHeight || image.height || 1;
  const imageAspect = naturalWidth / Math.max(1, naturalHeight);
  const boxAspect = box.width / Math.max(1, box.height);

  if (boxAspect > imageAspect) {
    const width = box.height * imageAspect;
    return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
  }

  const height = box.width / imageAspect;
  return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height };
}
