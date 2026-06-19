(function initRuntimeHealth(global) {
  "use strict";

  const ASSET_GROUPS = Object.freeze([
    Object.freeze({
      key: "model",
      label: "AI label model",
      paths: Object.freeze(["lib/ort.min.js", "models/shipping-label.onnx"])
    }),
    Object.freeze({
      key: "pdf",
      label: "PDF reader",
      paths: Object.freeze(["lib/pdf.min.js", "lib/pdf.worker.min.js"])
    }),
    Object.freeze({
      key: "barcode",
      label: "barcode reader",
      paths: Object.freeze(["lib/zxing-reader.js", "lib/zxing_reader.wasm"])
    })
  ]);

  async function safeCheck(check, fallback) {
    try {
      return await check();
    } catch (_) {
      return fallback;
    }
  }

  async function checkAssetGroup(group, probeAsset) {
    const results = await Promise.all(group.paths.map((path) => safeCheck(
      () => probeAsset(path),
      false
    )));
    return {
      key: group.key,
      label: group.label,
      ready: results.every(Boolean)
    };
  }

  function formatList(items) {
    if (items.length < 2) return items[0] || "";
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }

  function buildMessage(fileAccessAllowed, missingAssets) {
    const fileAccessMissing = fileAccessAllowed === false;
    if (fileAccessMissing && missingAssets.length) {
      return `Setup needed: enable “Allow access to file URLs” and reload. Also missing: ${formatList(missingAssets)}.`;
    }
    if (fileAccessMissing) {
      return "Recent downloads need file access. Enable “Allow access to file URLs” for this extension, then reload.";
    }
    if (missingAssets.length) {
      return `Label tools are incomplete (${formatList(missingAssets)}). Reload the extension; reinstall it if this remains.`;
    }
    return "";
  }

  async function checkRuntimeHealth(options = {}) {
    const checkFileAccess = options.checkFileAccess || (() => Promise.resolve(null));
    const probeAsset = options.probeAsset || (() => Promise.resolve(false));
    const [fileAccessAllowed, assetGroups] = await Promise.all([
      safeCheck(checkFileAccess, null),
      Promise.all(ASSET_GROUPS.map((group) => checkAssetGroup(group, probeAsset)))
    ]);
    const missingAssets = assetGroups.filter((group) => !group.ready).map((group) => group.label);
    const ok = fileAccessAllowed !== false && missingAssets.length === 0;
    return {
      ok,
      fileAccessAllowed,
      missingAssets,
      message: buildMessage(fileAccessAllowed, missingAssets)
    };
  }

  const api = Object.freeze({ ASSET_GROUPS, buildMessage, checkRuntimeHealth });
  global.LabelExtractorRuntimeHealth = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
