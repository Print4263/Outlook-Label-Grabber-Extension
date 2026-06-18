// Canonical detection script load order, shared by every dev harness page so a
// new detection module is wired in ONE place (here) instead of editing each page.
// Mirrors the production sidepanel.html order. document.write preserves the
// synchronous load order the detector/studio globals depend on; Date.now() cache-
// busts so a plain http.server never grades a stale cached copy after an edit.
// Paths are relative to the dev/*.html that loads this file (all live in dev/).
(function () {
  var v = Date.now();
  [
    "../detection/crop-engine.js",
    "../detection/pixel-analysis.js",
    "../detection/carrier-utils.js",
    "../detection/page-text-cues.js",
    "../detection/model-detector.js",
    "../detection/barcode-decoder.js",
    "../detection/detector-ranking.js",
    "../detection/candidate-selection.js",
    "../detection/barcode-confirmation.js",
    "../detection/pdf-text-detectors.js",
    "../detection/embedded-image-detectors.js",
    "../detection/label-detector.js",
    "../detection/pdf-processor.js",
    "../detection/png-processor.js"
  ].forEach(function (src) {
    document.write('<script src="' + src + "?v=" + v + '"><\/script>');
  });
})();
