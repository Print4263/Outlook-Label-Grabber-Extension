/* Bundled fixture smoke harness
 * -----------------------------
 * Runs the no-PII bundled Studio fixtures through the real detector and returns
 * a compact table for regression checks. This is a pipeline smoke, not a crop
 * quality oracle: a few bundled debug image fragments are intentionally odd
 * shapes and only prove that the detector still completes without hanging.
 *
 * Usage from dev/test.html:
 *   const s = document.createElement("script");
 *   s.src = "bundled-fixtures-harness.js";
 *   document.head.append(s);
 *   s.onload = () => runBundledFixtureSmoke();
 */
(function () {
  "use strict";

  function guessType(path) {
    if (/\.pdf$/i.test(path)) return "application/pdf";
    if (/\.png$/i.test(path)) return "image/png";
    if (/\.jpe?g$/i.test(path)) return "image/jpeg";
    if (/\.gif$/i.test(path)) return "image/gif";
    if (/\.webp$/i.test(path)) return "image/webp";
    return "";
  }

  function summarizeCandidate(top) {
    const label = top?.label || {};
    const width = Number(label.width || label.canvas?.width || 0);
    const height = Number(label.height || label.canvas?.height || 0);
    return {
      reason: top?.reason || "",
      confidence: Number(top?.confidence || 0),
      label: width && height ? `${width}x${height}` : "",
      aspect: width && height ? Number((width / height).toFixed(3)) : 0,
      carrier: top?.carrier || "",
      validated: Boolean(top?.carrierValidated),
      needsCrop: Boolean(top?.needsCrop)
    };
  }

  async function fileForFixture(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return new File([blob], path.split("/").pop(), {
      type: blob.type || guessType(path)
    });
  }

  async function runBundledFixtureSmoke(options = {}) {
    if (!window.Studio?.detect) {
      throw new Error("Open dev/test.html first; Studio.detect is missing.");
    }
    const fixtures = options.fixtures || window.Studio.FIXTURES || [];
    const rows = [];
    const started = performance.now();
    for (const fixture of fixtures) {
      const row = { fixture, ok: false };
      const t0 = performance.now();
      try {
        const file = await fileForFixture(fixture);
        const out = await window.Studio.detect(file);
        const candidates = (out?.candidates || []).filter(Boolean);
        Object.assign(row, {
          ok: candidates.length > 0,
          ms: Math.round(performance.now() - t0),
          candidateCount: candidates.length,
          ...summarizeCandidate(candidates[0])
        });
        if (!row.ok) row.error = "no candidates";
      } catch (error) {
        row.ms = Math.round(performance.now() - t0);
        row.error = String(error?.message || error);
      }
      rows.push(row);
    }
    const summary = {
      ok: rows.every((row) => row.ok),
      total: rows.length,
      passed: rows.filter((row) => row.ok).length,
      failed: rows.filter((row) => !row.ok).length,
      ms: Math.round(performance.now() - started),
      rows
    };
    window.__bundledFixtureSmoke = summary;
    console.table(rows.map((row) => ({
      fixture: row.fixture,
      ok: row.ok,
      ms: row.ms,
      reason: row.reason || "",
      label: row.label || "",
      aspect: row.aspect || "",
      carrier: row.carrier || "",
      validated: row.validated || false,
      error: row.error || ""
    })));
    return summary;
  }

  window.runBundledFixtureSmoke = runBundledFixtureSmoke;
})();
