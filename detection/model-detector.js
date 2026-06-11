(function () {
  "use strict";

  // Optional, no-op-by-default trace sink for the dev training studio (mirrors the
  // one in label-detector.js). Production never sets it. Never throws.
  let traceSink = null;
  function setTraceSink(fn) { traceSink = typeof fn === "function" ? fn : null; }
  function clearTrace() { traceSink = null; }
  function trace(stage, payload) {
    if (!traceSink) return;
    try { traceSink({ stage, ...(payload || {}) }); } catch (_) {}
  }

  // Resolve extension assets without chrome.runtime so the dev training studio
  // (plain file/http, no extension context) can run the model too. Mirrors
  // assetUrl() in pdf-processor.js.
  const scriptUrl = document.currentScript?.src || "";

  function assetUrl(path) {
    if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
    return new URL(`../${path}`, scriptUrl || window.location.href).href;
  }

  const MODEL_SIZE = 960;
  const MODEL_PATH = "models/shipping-label.onnx";
  const MIN_CONFIDENCE = 0.5;
  const CANDIDATE_CONFIDENCE = 0.01;
  const MODEL_BOX_PADDING = 0.12;
  let sessionPromise = null;
  let ortLoadPromise = null;

  // The ONNX runtime (~360 KB) is only needed when the heuristic cascade falls
  // through to model detection. Load it on first use instead of at panel open so
  // it doesn't sit in the startup critical path. Mirrors how heic2any is loaded.
  function ensureOrt() {
    if (window.ort) return Promise.resolve(window.ort);
    if (ortLoadPromise) return ortLoadPromise;
    ortLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = assetUrl("lib/ort.min.js");
      script.onload = () => resolve(window.ort);
      script.onerror = () => {
        ortLoadPromise = null;
        reject(new Error("Model runtime could not load."));
      };
      document.head.append(script);
    });
    return ortLoadPromise;
  }

  async function detectPages(pages) {
    if (!pages || !pages.length) return null;
    const ort = await ensureOrt().catch(() => null);
    if (!ort) return null;

    let best = null;
    for (const page of pages) {
      if (!page || !page.canvas || page.isCropOption) continue;
      const prediction = await detectCanvas(page.canvas);
      if (!prediction) continue;
      if (!best || prediction.score > best.prediction.score) {
        best = { page, prediction };
      }
    }

    if (!best) {
      trace("model-prediction", { found: false, note: "model returned no box above candidate threshold" });
      return null;
    }
    const accepted = isAcceptedPrediction(best.prediction, best.page.canvas);
    trace("model-prediction", {
      found: true,
      accepted,
      pageIndex: best.page.pageIndex,
      rawConfidence: best.prediction.confidence,
      acceptedConfidence: best.prediction.acceptedConfidence,
      score: best.prediction.score,
      rect: best.prediction.rect
    });
    if (!accepted) return null;

    // Keep the page's "Return Authorization Slip" section (slipRects, from
    // pdf-processor) out of the model's box — the model happily includes it
    // when the sheet prints the slip inside the same cut-frame as the label.
    const rect = best.page.slipRects?.length
      ? window.LabelExtractorCrop.clampRectBottomAboveBlockers(best.prediction.rect, best.page.slipRects, best.page.canvas)
      : best.prediction.rect;

    return {
      confidence: Math.max(best.prediction.confidence, best.prediction.acceptedConfidence),
      reason: "trained-model",
      pageIndex: best.page.pageIndex,
      pageCount: pages.reduce((max, page) => Math.max(max, Number(page.pageCount || 0)), pages.length),
      pages,
      sourceKind: best.page.sourceKind || best.page.type || "",
      sourceWidth: best.page.width || best.page.canvas.width,
      sourceHeight: best.page.height || best.page.canvas.height,
      cropRect: rect,
      label: await window.LabelExtractorCrop.cropCanvas(best.page.canvas, rect)
    };
  }

  async function detectCanvas(canvas) {
    const session = await getSession();
    const input = canvasToTensor(canvas);
    const feeds = {};
    feeds[session.inputNames[0]] = input;
    const outputMap = await session.run(feeds);
    const output = outputMap[session.outputNames[0]];
    return bestPrediction(output, canvas);
  }

  async function getSession() {
    if (!sessionPromise) {
      window.ort.env.wasm.wasmPaths = assetUrl("lib/");
      window.ort.env.wasm.numThreads = 1;
      sessionPromise = window.ort.InferenceSession.create(assetUrl(MODEL_PATH), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all"
      });
    }
    return sessionPromise;
  }

  function canvasToTensor(sourceCanvas) {
    const canvas = document.createElement("canvas");
    canvas.width = MODEL_SIZE;
    canvas.height = MODEL_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
    ctx.drawImage(sourceCanvas, 0, 0, MODEL_SIZE, MODEL_SIZE);

    const image = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    const planeSize = MODEL_SIZE * MODEL_SIZE;
    const tensor = new Float32Array(3 * planeSize);

    for (let i = 0, pixel = 0; i < image.length; i += 4, pixel += 1) {
      tensor[pixel] = image[i] / 255;
      tensor[planeSize + pixel] = image[i + 1] / 255;
      tensor[planeSize * 2 + pixel] = image[i + 2] / 255;
    }

    return new window.ort.Tensor("float32", tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  }

  function bestPrediction(output, canvas) {
    const data = output.data;
    const dims = output.dims || [];
    const attributes = dims.length >= 3 ? dims[1] : 5;
    const candidates = dims.length >= 3 ? dims[2] : Math.floor(data.length / attributes);
    if (attributes < 5 || candidates <= 0) return null;

    let best = null;
    for (let i = 0; i < candidates; i += 1) {
      const confidence = data[4 * candidates + i];
      if (confidence < CANDIDATE_CONFIDENCE) continue;

      const x = data[i];
      const y = data[candidates + i];
      const width = data[2 * candidates + i];
      const height = data[3 * candidates + i];
      if (!Number.isFinite(x + y + width + height)) continue;

      const rect = modelBoxToCanvasRect({ x, y, width, height }, canvas);
      const score = confidence + labelShapeBonus(rect, canvas);
      if (!best || score > best.score) best = { confidence, rect, score, acceptedConfidence: 0 };
    }

    return best;
  }

  function isAcceptedPrediction(prediction, canvas) {
    if (prediction.confidence >= MIN_CONFIDENCE) return true;

    if (isTallPageTopLabel(prediction.rect, canvas)) {
      prediction.acceptedConfidence = 0.62;
      return true;
    }

    return false;
  }

  function modelBoxToCanvasRect(box, canvas) {
    const scaleX = canvas.width / MODEL_SIZE;
    const scaleY = canvas.height / MODEL_SIZE;
    const padX = box.width * scaleX * MODEL_BOX_PADDING;
    const padY = box.height * scaleY * MODEL_BOX_PADDING;
    const left = clamp((box.x - box.width / 2) * scaleX - padX, 0, canvas.width - 1);
    const top = clamp((box.y - box.height / 2) * scaleY - padY, 0, canvas.height - 1);
    const right = clamp((box.x + box.width / 2) * scaleX + padX, left + 1, canvas.width);
    const bottom = clamp((box.y + box.height / 2) * scaleY + padY, top + 1, canvas.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function labelShapeBonus(rect, canvas) {
    const area = rect.width * rect.height / Math.max(1, canvas.width * canvas.height);
    const aspect = rect.width / Math.max(1, rect.height);
    const aspectDistance = Math.min(Math.abs(aspect - 1.88), Math.abs(aspect - 0.53));
    const areaBonus = area >= 0.18 && area <= 0.42 ? 0.08 : 0;
    const aspectBonus = aspectDistance < 0.2 ? 0.06 : 0;
    return areaBonus + aspectBonus;
  }

  function isTallPageTopLabel(rect, canvas) {
    const pageAspect = canvas.height / Math.max(1, canvas.width);
    const area = rect.width * rect.height / Math.max(1, canvas.width * canvas.height);
    const aspect = rect.width / Math.max(1, rect.height);
    const centerY = (rect.y + rect.height / 2) / Math.max(1, canvas.height);
    return pageAspect >= 2.2 &&
      area >= 0.025 &&
      area <= 0.25 &&
      aspect >= 0.45 &&
      aspect <= 0.95 &&
      centerY >= 0.12 &&
      centerY <= 0.48;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  async function warmUp() {
    try {
      await ensureOrt();
      await getSession();
    } catch (_) {}
  }

  window.LabelExtractorModelDetector = {
    detectPages,
    warmUp,
    // Dev training studio hooks (no-op in production):
    setTraceSink,
    clearTrace
  };
})();
