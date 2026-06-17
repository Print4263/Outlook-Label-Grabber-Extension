/* Single staged-fixture diagnostic helper for dev/test.html.
 *
 * Usage:
 *   await runStagedFixture("example.pdf", "application/pdf")
 *
 * The file must be staged under dev/_diag. The helper uses the real Studio
 * pipeline, captures its trace, and renders every candidate without changing
 * ranking or detector behavior.
 */
(function () {
  "use strict";

  function candidateSummary(candidate, index) {
    const label = candidate?.label || {};
    return {
      index,
      reason: candidate?.reason || "",
      variantName: candidate?.variantName || "",
      confidence: Number(candidate?.confidence || 0),
      score: Number(window.Studio?.scoreFor?.(candidate) || 0),
      breakdown: window.Studio?.breakdownFor?.(candidate) || null,
      carrier: candidate?.carrier || "",
      validated: Boolean(candidate?.carrierValidated),
      trackingNumber: candidate?.trackingNumber || "",
      barcodeSignal: Boolean(candidate?.barcodeSignal),
      barcodeFormats: (candidate?.barcodeResults || []).map((result) => result.format),
      cropRect: candidate?.cropRect || null,
      sourceWidth: Number(candidate?.sourceWidth || 0),
      sourceHeight: Number(candidate?.sourceHeight || 0),
      width: Number(label.width || 0),
      height: Number(label.height || 0),
      aspect: label.width && label.height ? Number((label.width / label.height).toFixed(4)) : 0,
      warnings: candidate?.warnings || []
    };
  }

  function renderCandidates(filename, candidates) {
    document.getElementById("__single_fixture")?.remove();
    const panel = document.createElement("section");
    panel.id = "__single_fixture";
    panel.style.cssText = "position:relative;z-index:9999;background:#111827;color:#f9fafb;padding:16px;margin:12px 0;font:12px sans-serif";
    const title = document.createElement("h2");
    title.textContent = `${filename} - ${candidates.length} raw candidate(s)`;
    title.style.cssText = "margin:0 0 12px;font-size:16px";
    panel.append(title);

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px";
    candidates.forEach((candidate, index) => {
      const item = document.createElement("figure");
      item.style.cssText = "margin:0;background:#fff;color:#111827;padding:8px";
      const caption = document.createElement("figcaption");
      const label = candidate?.label || {};
      caption.textContent = `#${index} ${candidate?.reason || "unknown"} ${label.width || 0}x${label.height || 0}`;
      caption.style.cssText = "font-weight:700;margin-bottom:6px";
      const image = document.createElement("img");
      image.src = label.dataUrl || "";
      image.alt = `Candidate ${index}: ${candidate?.reason || "unknown"}`;
      image.style.cssText = "display:block;width:100%;height:360px;object-fit:contain;background:#f3f4f6";
      item.append(caption, image);
      grid.append(item);
    });
    panel.append(grid);
    document.body.prepend(panel);
  }

  async function runStagedFixture(filename, mime = "application/pdf") {
    if (!window.Studio?.detect) throw new Error("Open dev/test.html before running the staged fixture helper.");
    const response = await fetch(`_diag/${encodeURIComponent(filename)}`);
    if (!response.ok) throw new Error(`Could not load staged fixture (${response.status}).`);
    const blob = await response.blob();
    const trace = [];
    window.Studio.state._traceBuffer = trace;
    let output;
    const started = performance.now();
    try {
      output = await window.Studio.detect(new File([blob], filename, { type: mime }));
    } finally {
      window.Studio.state._traceBuffer = null;
    }
    const candidates = (output?.candidates || []).filter(Boolean);
    renderCandidates(filename, candidates);
    const result = {
      filename,
      elapsedMs: Math.round(performance.now() - started),
      page: output?.page ? {
        width: output.page.canvas?.width || 0,
        height: output.page.canvas?.height || 0,
        textLength: (output.page.text || "").length,
        embeddedImages: (output.page.images || []).length
      } : null,
      candidates: candidates.map(candidateSummary),
      trace
    };
    window.__singleFixture = result;
    console.table(result.candidates);
    return result;
  }

  window.runStagedFixture = runStagedFixture;

  const params = new URLSearchParams(location.search);
  const autoFilename = params.get("stagedFixture");
  if (autoFilename) {
    window.addEventListener("DOMContentLoaded", async () => {
      const output = document.createElement("pre");
      output.id = "__single_fixture_json";
      document.body.prepend(output);
      try {
        const result = await runStagedFixture(autoFilename, params.get("mime") || "application/pdf");
        output.textContent = JSON.stringify(result, null, 2);
      } catch (error) {
        output.textContent = JSON.stringify({ error: String(error?.message || error) }, null, 2);
      }
    });
  }
})();
