(function () {
  "use strict";

  // Hairline label borders and dash patterns on phone screenshots are 1-2px
  // at native resolution — at or under the border detectors' sampling steps.
  // Upscaling to ~2700px wide makes them 3-4px, which measurably improves
  // detection (2026-06-11 corpus test at 2.25x: +0.22 and +0.10 IoU on the
  // two worst screenshot files, small gains on most others, ~+30% processing
  // time on images only). This mirrors what converting the image to a PDF and
  // letting pdf.js render it at scale 3 would do — same pixels, none of the
  // encode/decode overhead, so images are normalized here instead.
  // Target sized so phone screenshots (1080-1320px wide) land at ~2.3x — the
  // factor the corpus test validated; at 2.0x the hairline dashes on the two
  // worst screenshot files still go undetected.
  const UPSCALE_TRIGGER_WIDTH = 2400;
  const UPSCALE_TARGET_WIDTH = 3000;
  const UPSCALE_MAX_FACTOR = 3;
  const UPSCALE_MAX_PIXELS = 20000000;

  async function process(captured, pageIndex) {
    const imageBlob = await normalizeImageBlob(captured.blob, captured.type);
    const image = await blobToImage(imageBlob);
    const maxPixels = captured.type && /image\/gif/i.test(captured.type) ? 32000000 : 120000000;
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    let scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, naturalWidth * naturalHeight)));
    if (naturalWidth * scale < UPSCALE_TRIGGER_WIDTH) {
      const upscale = Math.min(
        UPSCALE_MAX_FACTOR,
        UPSCALE_TARGET_WIDTH / Math.max(1, naturalWidth * scale),
        Math.sqrt(UPSCALE_MAX_PIXELS / Math.max(1, naturalWidth * naturalHeight * scale * scale))
      );
      scale *= Math.max(1, upscale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = scale !== 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    return {
      pageIndex,
      type: "png",
      canvas,
      width: canvas.width,
      height: canvas.height,
      sourceUrl: captured.url
    };
  }

  async function normalizeImageBlob(blob, type) {
    if (/image\/hei[cf]/i.test(type || "")) {
      return convertHeicBlob(blob);
    }

    try {
      await canDecodeImage(blob);
      return blob;
    } catch (error) {
      if (/application\/octet-stream|^$/i.test(type || "")) {
        return convertHeicBlob(blob);
      }
      throw error;
    }
  }

  async function canDecodeImage(blob) {
    const image = await blobToImage(blob);
    return image;
  }

  async function convertHeicBlob(blob) {
    await ensureHeicConverter();
    if (!window.heic2any) {
      throw new Error("HEIC image support is not available.");
    }

    const converted = await window.heic2any({
      blob,
      toType: "image/png",
      quality: 1
    });

    return Array.isArray(converted) ? converted[0] : converted;
  }

  function ensureHeicConverter() {
    if (window.heic2any) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("lib/heic2any.min.js");
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("HEIC image support could not load."));
      document.head.append(script);
    });
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Image attachment page could not be read."));
      };
      image.src = url;
    });
  }

  window.LabelExtractorPNG = { process };
})();
