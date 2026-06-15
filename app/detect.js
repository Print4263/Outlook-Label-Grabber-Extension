// Detection candidate building: runs the local detector, turns its output into
// label candidates, builds page/zoom fallbacks, and dedupes/scores/ranks them.
// Plain (non-module) script: all stay global and are driven by extractSelectedFile
// in sidepanel.js. They use shared globals (state, window.LabelExtractor*, fileCacheKey,
// normalizeFileForExtraction, constants) defined in sidepanel.js, resolved at call time.

async function tryLocalDetectorCandidate(file) {
  if (!file || !window.LabelExtractorPDF || !window.LabelExtractorPNG) return null;

  try {
    const result = await runLocalDetector(file);
    const results = Array.isArray(result) ? result : [result];
    const labels = results
      .map(localDetectionToLabel)
      .filter(Boolean);
    return labels.length ? labels : null;
  } catch (error) {
    console.warn("[Label Extractor] Local detection failed.", error);
    return null;
  }
}

function localDetectionToLabel(result) {
  if (!result?.label || !LOCAL_DETECTOR_REASONS.has(result.reason)) return null;
  const likelyPartial = isLikelyPartialLocalDetection(result);
  if (likelyPartial && !canShowAsCropVariant(result)) return null;

  const source = result.label;
  // Canvas-backed labels (crop-engine canvasToLabel) defer the PNG encode:
  // base64 is a lazy getter below, so candidates the variant limit cuts never
  // pay toDataURL. Pre-encoded labels (no canvas) keep the eager validity check.
  if (!source.canvas) {
    const base64 = String(source.dataUrl || "").split(",")[1];
    if (!base64) return null;
  }

  const label = {
    carrier: result.carrier || "Model",
    // Barcode-decode metadata (present only when the decode confirmation ran and
    // read a carrier barcode off this crop). Surfaced as a badge in renderResults.
    trackingNumber: result.trackingNumber || "",
    trackingUrl: result.trackingUrl || "",
    carrierConfident: Boolean(result.carrierConfident),
    carrierValidated: Boolean(result.carrierValidated),
    confidence: Math.min(0.99, Number(result.confidence || 0)),
    outputMimeType: "image/png",
    sourceCanvas: source.canvas || null,
    width: source.width,
    height: source.height,
    variantName: result.variantName || localVariantName(result),
    warnings: labelWarnings(result, likelyPartial),
    sourcePage: Number(result.pageIndex || 0) + 1,
    pageCount: Number(result.pageCount || 0),
    localReason: result.reason,
    needsCrop: likelyPartial || Boolean(result.needsCrop),
    twinLabelIndex: result.twinLabelIndex || null,
    twinLabelCount: result.twinLabelCount || null
  };
  defineLazyBase64(label, source);
  return label;
}

// base64 materializes (and is cached on the object) the first time something
// reads it; assigning a new value (e.g. after a rotation) replaces the getter.
// Enumerable so spreads ({...label}) keep carrying base64, just as plain data.
function defineLazyBase64(label, source) {
  Object.defineProperty(label, "base64", {
    enumerable: true,
    configurable: true,
    get() {
      const value = String(source.dataUrl || "").split(",")[1] || "";
      Object.defineProperty(this, "base64", { value, enumerable: true, configurable: true, writable: true });
      return value;
    },
    set(value) {
      Object.defineProperty(this, "base64", { value, enumerable: true, configurable: true, writable: true });
    }
  });
}

function canShowAsCropVariant(result) {
  return result.reason === "keywords"
    || result.reason === "barcode-density"
    || result.reason === "text-label-page"
    || result.reason === "embedded-label-page"
    || result.reason === "image-label-fallback"
    || result.reason === "manual-image-fallback"
    || result.reason === "lower-barcode-label"
    || result.reason === "fashion-nova-lower-barcode";
}

function labelWarnings(result, likelyPartial) {
  const warnings = Array.isArray(result.warnings) ? result.warnings.slice() : [];
  if (likelyPartial && !warnings.some((warning) => /crop|partial/i.test(warning))) {
    warnings.push("Crop-needed variant; review and crop before printing.");
  }
  return warnings;
}

function isLikelyPartialLocalDetection(result) {
  const width = Number(result.label?.width || 0);
  const height = Number(result.label?.height || 0);
  if (!width || !height) return true;

  const aspect = width / height;
  if (aspect < 0.45 || aspect > 2.6) return true;

  const rect = result.cropRect;
  const sourceWidth = Number(result.sourceWidth || 0);
  const sourceHeight = Number(result.sourceHeight || 0);
  if (!rect || !sourceWidth || !sourceHeight) return false;

  const areaRatio = (rect.width * rect.height) / Math.max(1, sourceWidth * sourceHeight);
  const touchesEdge = rect.x <= 2 || rect.y <= 2 ||
    rect.x + rect.width >= sourceWidth - 2 ||
    rect.y + rect.height >= sourceHeight - 2;
  return areaRatio < 0.12 || (touchesEdge && areaRatio < 0.22);
}

function localVariantName(result) {
  if (result.reason === "embedded-twin-label") return result.variantName || `Label ${result.twinLabelIndex || 1} of ${result.twinLabelCount || 2}`;
  const page = Number(result.pageIndex || 0) + 1;
  if (result.reason === "embedded-usps-label") return `USPS embedded label page ${page}`;
  if (result.reason === "fold-here-label") return `Label below FOLD HERE page ${page}`;
  if (result.reason === "solid-border") return `Local label page ${page}`;
  if (result.reason === "keywords") return `Carrier text label page ${page}`;
  if (result.reason === "text-label-page") return `Text label page ${page}`;
  if (result.reason === "barcode-density") return `Barcode label page ${page}`;
  if (result.reason === "embedded-label-page") return `Embedded label page ${page}`;
  if (result.reason === "image-label-fallback") return `Image label fallback page ${page}`;
  if (result.reason === "manual-image-fallback") return `Manual image crop page ${page}`;
  return `Model full label page ${page}`;
}

function normalizeLocalResults(result) {
  if (!result) return [];
  return Array.isArray(result) ? result.filter(Boolean) : [result].filter(Boolean);
}

async function runLocalDetector(file) {
  const cacheKey = fileCacheKey(file);
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const processed = await window.LabelExtractorPDF.process({
      buffer: await file.arrayBuffer(),
      type: "application/pdf",
      name: file.name
    });
    if (Array.isArray(processed)) return processed;
    if (processed?.pages && window.LabelExtractorDetector.detectPdfCandidates) {
      state.cachedPages = processed.pages;
      state.cachedPagesKey = cacheKey;
      const candidates = await window.LabelExtractorDetector.detectPdfCandidates(processed.pages);
      return candidates.length ? candidates : processed;
    }
    return processed;
  }

  if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|hei[cf])$/i.test(file.name)) {
    const page = await window.LabelExtractorPNG.process({
      blob: file,
      type: file.type,
      name: file.name
    }, 0);
    state.cachedPages = [page];
    state.cachedPagesKey = cacheKey;
    if (window.LabelExtractorDetector.detectAllPngCandidates) {
      const candidates = await window.LabelExtractorDetector.detectAllPngCandidates([page]);
      return candidates.length ? candidates : window.LabelExtractorDetector.detectPngPages([page]);
    }
    return window.LabelExtractorDetector.detectPngPages([page]);
  }

  return null;
}

async function fullLabelCandidates(labels) {
  const twinLabels = labels.filter((label) => Number(label.twinLabelCount || 0) > 1);
  if (getTwinLabelCount(twinLabels) > 1) {
    return twinLabels
      .sort((a, b) => Number(a.twinLabelIndex || 0) - Number(b.twinLabelIndex || 0))
      .slice(0, Number(twinLabels[0].twinLabelCount || twinLabels.length));
  }

  const sorted = labels
    .sort(compareLabelQuality);
  const clean = sorted.filter((label) => {
    const confidence = Number(label.confidence || 0);
    return confidence >= MIN_FULL_LABEL_CONFIDENCE
      && !isFallbackOrPartialCrop(label)
      && !label.needsCrop;
  });
  const cropNeeded = sorted.filter((label) => {
    const confidence = Number(label.confidence || 0);
    return confidence >= MIN_CROP_VARIANT_CONFIDENCE
      && (label.needsCrop || isFallbackOrPartialCrop(label) || hasCropWarning(label));
  });
  const limit = getVariantLimit(labels);
  const merged = dedupeLabels([...clean, ...cropNeeded]);
  return merged.slice(0, limit);
}

async function addMissingPageCropOptions(candidates, labels) {
  if (!hasCachedCanvasPages()) return candidates;

  const missingPages = missingRenderedPages(candidates);
  if (!missingPages.length) return candidates;

  // Restrict to the missing pages BEFORE building fallbacks: each one costs a
  // full-page dark-content scan plus a PNG encode, so building them for pages
  // that are then filtered out is pure waste.
  const fallbackOptions = (await cachedFilePageFallbackLabels(missingPages))
    .filter((label) => missingPages.includes(Number(label.sourcePage || 0)));
  if (!fallbackOptions.length) return candidates;

  const limit = Math.max(4, getVariantLimit([...labels, ...candidates, ...fallbackOptions]));
  const prioritizedFallbacks = fallbackOptions.sort(compareMissingPageFallbackLabels);
  const ordered = prioritizedFallbacks.some((label) => Number(label.sourcePage || 0) === 2)
    ? [...prioritizedFallbacks, ...candidates]
    : [...candidates, ...prioritizedFallbacks];
  return dedupeLabels(ordered).slice(0, limit);
}

function missingRenderedPages(candidates) {
  const shownPages = new Set(
    candidates
      .map((label) => Number(label?.sourcePage || 0))
      .filter(Boolean)
  );

  return state.cachedPages
    .filter((page) => page?.canvas)
    .map((page) => Number(page.pageIndex || 0) + 1)
    .filter((pageNumber) => !shownPages.has(pageNumber));
}

function compareMissingPageFallbackLabels(a, b) {
  return missingPageFallbackScore(b) - missingPageFallbackScore(a);
}

function missingPageFallbackScore(label) {
  const pageNumber = Number(label?.sourcePage || 0);
  let score = 0;
  if (pageNumber === 2) score += 100;
  if (pageNumber > 1) score += 10;
  score += Number(label?.confidence || 0);
  return score;
}

function dedupeLabels(labels) {
  const seen = new Set();
  return labels.filter((label) => {
    const key = [
      label.variantName || "",
      label.sourcePage || "",
      label.width || "",
      label.height || "",
      label.localReason || ""
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasCropWarning(label) {
  return (label.warnings || []).some((warning) => /crop|partial|review/i.test(String(warning)));
}

async function fileFallbackCandidates(labels) {
  const fallbackFromLabels = labels
    .filter((label) => Number(label.confidence || 0) >= FALLBACK_MIN_CONFIDENCE)
    .sort(compareLabelQuality)
    .map((label) => ({
      ...label,
      needsCrop: true,
      warnings: ensureWarning(label.warnings, FALLBACK_WARNING)
    }));

  const fallbackFromPages = await cachedFilePageFallbackLabels();
  const limit = getVariantLimit([...labels, ...fallbackFromPages]);
  return dedupeLabels([...fallbackFromLabels, ...fallbackFromPages]).slice(0, Math.max(4, limit));
}

async function cachedFilePageFallbackLabels(onlyPageNumbers) {
  if (!state.cachedPages?.length) return [];

  const pages = state.cachedPages
    .filter((page) => page?.canvas)
    .slice()
    .sort(compareFallbackPages)
    .slice(0, FALLBACK_PAGE_LIMIT)
    // Same page selection as always (sort + limit over all pages); the filter
    // only skips building labels that the caller would discard anyway.
    .filter((page) => !onlyPageNumbers || onlyPageNumbers.includes(Number(page.pageIndex || 0) + 1));

  return pages.map(fileFallbackLabelFromPage).filter((label) => label.base64);
}

function fileFallbackLabelFromPage(page) {
  const fallback = zoomedFallbackCanvas(page.canvas);
  const dataUrl = fallback.canvas.toDataURL("image/png");
  const pageNumber = Number(page.pageIndex || 0) + 1;
  const pageText = page.text || "";
  return {
    carrier: fileFallbackCarrier(page),
    confidence: 0.32,
    outputMimeType: "image/png",
    base64: dataUrl.split(",")[1],
    width: fallback.canvas.width,
    height: fallback.canvas.height,
    variantName: fileFallbackPageTitle(page, pageNumber),
    warnings: [fileFallbackWarning(page)],
    sourcePage: pageNumber,
    pageCount: Number(page.pageCount || state.cachedPages.length),
    localReason: "file-page-fallback",
    pageText,
    needsCrop: true
  };
}

function fileFallbackCarrier(page) {
  const carrier = guessLabelCarrier(page?.text);
  if (carrier) return carrier;
  return page?.type === "pdf" ? "PDF" : "File";
}

function fileFallbackPageTitle(page, pageNumber) {
  if (isPackingSlipFallbackPage(page)) return "Packing slip page - review only";
  if (isLikelyLabelFallbackPage(page)) return "Likely label page - crop if needed";
  return `Page ${pageNumber} - review only`;
}

function fileFallbackWarning(page) {
  if (isPackingSlipFallbackPage(page)) return "Review only; this page looks like order details.";
  if (isLikelyLabelFallbackPage(page)) return "Crop if needed before printing.";
  return FALLBACK_WARNING;
}

function isPackingSlipFallbackPage(page) {
  const text = String(page?.text || "").toUpperCase();
  return /PACKING SLIP|ORDER DETAILS|ITEM#|RMA#/.test(text) && !/SHIPPING LABEL|RETURN LABEL|TRACKING/.test(text);
}

function isLikelyLabelFallbackPage(page) {
  const text = String(page?.text || "").toUpperCase();
  return /SHIPPING LABEL|RETURN LABEL|RETURN MAILING LABEL|AFFIX|TRACKING|SHIP TO|SHIP FROM|USPS|UPS|FEDEX|DHL|ATTACHED RETURN LABEL/.test(text);
}

function guessLabelCarrier(text) {
  const value = String(text || "").toUpperCase();
  if (/\b1Z[0-9A-Z]{16}\b/.test(value) || /\bUPS\b|UPS TRACKING|UPS GROUND/.test(value)) return "UPS";
  if (/\b(9\d{21,}|92\d{20,})\b/.test(value) || /USPS|POSTAL SERVICE|PRIORITY MAIL|GROUND ADVANTAGE/.test(value)) return "USPS";
  if (/\b(\d{12}|\d{15}|\d{20})\b/.test(value) || /FEDEX|FEDERAL EXPRESS/.test(value)) return "FedEx";
  if (/DHL/.test(value)) return "DHL";
  return "";
}

function zoomedFallbackCanvas(sourceCanvas) {
  const contentRect = findDarkContentRect(sourceCanvas);
  const rect = contentRect
    ? expandContentRect(contentRect, sourceCanvas, FALLBACK_CONTENT_PADDING_RATIO)
    : centeredZoomRect(sourceCanvas, FALLBACK_CENTER_SCALE);
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return { canvas, rect };
}

function findDarkContentRect(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const step = Math.max(2, Math.floor(Math.min(width, height) / 900));
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 24) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum > 225) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: Math.min(width - left, right - left + step),
    height: Math.min(height - top, bottom - top + step)
  };
}

function expandContentRect(rect, canvas, paddingRatio) {
  const padX = Math.max(24, Math.round(rect.width * paddingRatio));
  const padY = Math.max(24, Math.round(rect.height * paddingRatio));
  const x = Math.max(0, rect.x - padX);
  const y = Math.max(0, rect.y - padY);
  const right = Math.min(canvas.width, rect.x + rect.width + padX);
  const bottom = Math.min(canvas.height, rect.y + rect.height + padY);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

function centeredZoomRect(canvas, scale) {
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  return {
    x: Math.max(0, Math.round((canvas.width - width) / 2)),
    y: Math.max(0, Math.round((canvas.height - height) / 2)),
    width,
    height
  };
}

function compareFallbackPages(a, b) {
  return fallbackPageScore(b) - fallbackPageScore(a);
}

function fallbackPageScore(page) {
  const text = String(page?.text || "").toUpperCase();
  let score = Number(page?.embeddedImageCount || 0) * 3;
  if (/RETURN MAILING LABEL|RETURN AUTHORIZATION SLIP|PLACE THIS BARCODE/.test(text)) score += 5;
  if (/UPS|USPS|FEDEX|TRACKING|SHIP TO|SHIP FROM/.test(text)) score += 3;
  if (/INSTRUCTIONS|REFUND|EXCHANGE|ELIGIBLE/.test(text)) score -= 1;
  return score;
}

function ensureWarning(warnings, message) {
  const next = Array.isArray(warnings) ? warnings.slice() : [];
  if (!next.includes(message)) next.push(message);
  return next;
}

function hasCachedCanvasPages() {
  return state.cachedPages?.some((page) => page?.canvas);
}

function getVariantLimit(labels = []) {
  const pageCount = labels.reduce((max, label) => Math.max(max, Number(label?.pageCount || 0)), 0);
  if (pageCount >= 3) return 6;
  if (pageCount > 0) return 4;

  const name = String(state.file?.name || "").toLowerCase();
  const type = String(state.file?.type || "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return 4;
  return 2;
}

function isFallbackOrPartialCrop(label) {
  const name = String(label.variantName || "").toLowerCase();
  const warnings = (label.warnings || []).join(" ").toLowerCase();

  return warnings.includes("fallback crop")
    || name.includes("lower half")
    || name.includes("lower-left label")
    || name.includes("center label")
    || name.includes("full page")
    || name.includes("barcode only")
    || name.includes("barcode-only");
}

function compareLabelQuality(a, b) {
  const confidenceDelta = Number(b.confidence || 0) - Number(a.confidence || 0);
  if (Math.abs(confidenceDelta) > 0.03) return confidenceDelta;
  return localLabelScore(b) - localLabelScore(a);
}

function localLabelScore(label) {
  const reason = String(label.localReason || "");
  const carrier = String(label.carrier || "").toUpperCase();
  const text = String(label.pageText || "").toUpperCase();
  const isUps = carrier === "UPS" || /\bUPS\b|UPS TRACKING|UPS GROUND|UPS 2ND DAY AIR|UPS NEXT DAY AIR|\b1Z[0-9A-Z]{16}\b/.test(text);
  if (isUps && reason === "keywords") return 7;
  if (isUps && reason === "text-label-page") return 6;
  if (isUps && reason === "dashed-border") return 1;
  if (reason === "keywords") return 5;
  if (reason === "solid-border") return 4;
  if (reason === "trained-model") return 3;
  if (reason === "text-label-page") return 3;
  if (reason === "embedded-label-page") return 2;
  if (reason === "image-label-fallback") return 2;
  if (reason === "manual-image-fallback") return -1;
  if (reason === "lower-barcode-label" || reason === "barcode-density") return 1;
  return 0;
}
