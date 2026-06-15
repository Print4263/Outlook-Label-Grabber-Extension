(function () {
  "use strict";
  const Studio = window.Studio;
  if (!Studio) return;

  // ===========================================================================
  // Barcode A/B compare
  // Runs the CURRENT set (loaded corpus group, or the bundled fixtures) twice
  // through the real detector — once with the barcode-decode confirmation OFF
  // (production baseline) and once ON — then renders a per-label side-by-side
  // and an aggregate before/after chart. This is how you SEE whether decoding
  // the candidate barcode is actually helping, instead of guessing.
  // ===========================================================================

  let panel = null;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "stats-panel";
    panel.style.borderColor = "#bfdbfe";
    Studio.els.groupbar.insertAdjacentElement("afterend", panel);
    return panel;
  }

  function barcodeCfg() {
    return (typeof LabelExtractorConfig !== "undefined" && LabelExtractorConfig.BARCODE) || null;
  }

  // Collect the files for the current view: a selected/loaded corpus group if
  // present, otherwise the bundled fixtures (fetched the same way core does).
  async function filesToRun() {
    const group = Studio.state.currentGroup;
    if (group && Studio.state.corpusGroups.has(group)) {
      return Studio.state.corpusGroups.get(group)
        .map((file) => ({ label: Studio.util.corpusPath(file), file }));
    }
    const out = [];
    for (const path of Studio.FIXTURES) {
      try {
        const blob = await (await fetch(path)).blob();
        out.push({
          label: path,
          file: new File([blob], path.split("/").pop(), { type: blob.type || Studio.util.guessType(path) })
        });
      } catch (_) { /* skip a missing fixture */ }
    }
    return out;
  }

  async function runPass(files, setStatus, tag) {
    const rows = [];
    for (let i = 0; i < files.length; i += 1) {
      const { label, file } = files[i];
      setStatus(`A/B (${tag}) ${i + 1}/${files.length}: ${label}`);
      let top = null;
      try {
        const out = await Studio.detect(file);
        top = (out.candidates || []).filter(Boolean)[0] || null;
      } catch (_) { /* leave top null — shows as "no label" */ }
      rows.push({
        label,
        reason: top?.reason || "",
        carrier: top?.carrier || "",
        confident: Boolean(top?.carrierConfident),
        validated: Boolean(top?.carrierValidated),
        tracking: top?.trackingNumber || "",
        conf: Number(top?.confidence || 0),
        w: Number(top?.label?.width || 0),
        h: Number(top?.label?.height || 0)
      });
    }
    return rows;
  }

  function sizeChanged(a, b) {
    if (!a.w || !b.w) return a.w !== b.w || a.h !== b.h;
    return Math.abs(a.w - b.w) / a.w > 0.04 || Math.abs(a.h - b.h) / Math.max(1, a.h) > 0.04;
  }

  function classify(before, after) {
    const reranked = before.reason !== after.reason || sizeChanged(before, after);
    const carrierGained = !before.carrier && Boolean(after.carrier);
    const carrierChanged = Boolean(before.carrier) && Boolean(after.carrier) && before.carrier !== after.carrier;
    return { reranked, carrierGained, carrierChanged };
  }

  function aggregate(before, after) {
    const agg = {
      labels: after.length,
      confidentBefore: 0, confidentAfter: 0,
      validatedAfter: 0,
      trackingBefore: 0, trackingAfter: 0,
      reranked: 0, carrierGained: 0
    };
    for (let i = 0; i < after.length; i += 1) {
      const b = before[i], a = after[i];
      if (b.confident) agg.confidentBefore += 1;
      if (a.confident) agg.confidentAfter += 1;
      if (a.validated) agg.validatedAfter += 1;
      if (b.tracking) agg.trackingBefore += 1;
      if (a.tracking) agg.trackingAfter += 1;
      const c = classify(b, a);
      if (c.reranked) agg.reranked += 1;
      if (c.carrierGained || c.carrierChanged) agg.carrierGained += 1;
    }
    return agg;
  }

  // Small grouped before/after bar chart, pure SVG so it needs no chart lib.
  function chartSvg(agg) {
    const metrics = [
      { label: "Confident carrier", before: agg.confidentBefore, after: agg.confidentAfter },
      { label: "Tracking # read", before: agg.trackingBefore, after: agg.trackingAfter },
      { label: "Validated (check-digit)", before: 0, after: agg.validatedAfter },
      { label: "Winner reranked", before: 0, after: agg.reranked }
    ];
    const max = Math.max(1, agg.labels);
    const W = 560, rowH = 34, padL = 150, padR = 40, barMax = W - padL - padR;
    const H = metrics.length * rowH + 30;
    const bar = (x, y, w, h, fill) =>
      `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${h}" rx="3" fill="${fill}"></rect>`;
    const text = (x, y, t, anchor, cls) =>
      `<text x="${x}" y="${y}" text-anchor="${anchor || "start"}" font-size="11" font-family="Segoe UI, Arial" fill="${cls || "#374151"}">${t}</text>`;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">`;
    metrics.forEach((m, i) => {
      const y = 10 + i * rowH;
      const bw = (m.before / max) * barMax;
      const aw = (m.after / max) * barMax;
      svg += text(padL - 8, y + 11, m.label, "end");
      svg += bar(padL, y, bw, 11, "#cbd5e1");
      svg += bar(padL, y + 13, aw, 11, "#2563eb");
      svg += text(padL + Math.max(bw, aw) + 6, y + 11, String(m.before), "start", "#94a3b8");
      svg += text(padL + Math.max(bw, aw) + 6, y + 24, String(m.after), "start", "#1d4ed8");
    });
    svg += text(padL, H - 4, "▉ baseline (off)", "start", "#94a3b8");
    svg += text(padL + 110, H - 4, "▉ barcode confirm (on)", "start", "#1d4ed8");
    svg += "</svg>";
    return svg;
  }

  function diffTable(before, after) {
    const table = document.createElement("table");
    table.className = "stats-table";
    table.innerHTML =
      "<thead><tr><th>label</th>" +
      "<th>reason →</th><th>carrier →</th><th>tracking (on)</th><th>Δ</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (let i = 0; i < after.length; i += 1) {
      const b = before[i], a = after[i];
      const c = classify(b, a);
      const tr = document.createElement("tr");
      if (c.reranked) tr.style.background = "#eff6ff";

      const reasonCell = b.reason === a.reason ? a.reason || "—" : `${b.reason || "—"} → ${a.reason || "—"}`;
      const carrierBefore = b.carrier || "—";
      const carrierAfter = a.carrier ? `${a.carrier}${a.validated ? " ✓" : a.confident ? " •" : ""}` : "—";
      const carrierCell = carrierBefore === a.carrier ? carrierAfter : `${carrierBefore} → ${carrierAfter}`;
      const tags = [c.reranked ? "rerank" : "", c.carrierGained ? "carrier+" : "", c.carrierChanged ? "carrier→" : ""]
        .filter(Boolean).join(" ");

      [a.label.split("/").pop(), reasonCell, carrierCell, a.tracking || "—", tags || ""]
        .forEach((t, j) => tr.append(Studio.util.td(t, j === 0 ? "" : "")));
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  async function runCompare() {
    const cfg = barcodeCfg();
    if (!cfg) { Studio.setStatus("BARCODE config missing (config.js not loaded?)."); return; }
    if (!Studio.detect) { Studio.setStatus("Studio.detect unavailable — update core.js."); return; }

    const el = ensurePanel();
    el.replaceChildren();
    const head = document.createElement("div");
    head.className = "stats-head";
    head.innerHTML = "<strong>Barcode A/B</strong> — running the set twice (baseline vs barcode-confirm)…";
    el.append(head);

    const files = await filesToRun();
    if (!files.length) { head.innerHTML = "<strong>Barcode A/B</strong> — no files to run."; return; }

    const saved = { ...cfg };
    let before, after;
    try {
      Object.assign(cfg, { ENRICH: false, RERANK: false });
      before = await runPass(files, Studio.setStatus, "baseline");
      Object.assign(cfg, { ENRICH: true, RERANK: true });
      after = await runPass(files, Studio.setStatus, "barcode-on");
    } finally {
      Object.assign(cfg, saved); // never leave the studio in an opted-in state
    }
    Studio.setStatus("Barcode A/B done.");

    const agg = aggregate(before, after);
    head.innerHTML =
      `<strong>Barcode A/B</strong> — ${agg.labels} label(s). ` +
      `Confident carrier ${agg.confidentBefore} → <strong>${agg.confidentAfter}</strong>, ` +
      `tracking # ${agg.trackingBefore} → <strong>${agg.trackingAfter}</strong>, ` +
      `<strong>${agg.validatedAfter}</strong> check-digit-validated, ` +
      `<strong>${agg.reranked}</strong> winner(s) reranked.`;

    const chart = document.createElement("div");
    chart.innerHTML = chartSvg(agg);
    el.append(chart);

    const sub = document.createElement("div");
    sub.className = "stats-subhead";
    sub.textContent = "Per-label (baseline → barcode-confirm)";
    el.append(sub);
    el.append(diffTable(before, after));
  }

  Studio.toolbarHooks.push((toolbar) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Barcode A/B";
    btn.title = "Run the current set twice (barcode-confirm off vs on) and chart the difference";
    btn.style.background = "linear-gradient(180deg,#3b82f6,#2563eb)";
    btn.style.color = "#fff";
    btn.style.borderColor = "#1d4ed8";
    btn.addEventListener("click", () => { btn.disabled = true; runCompare().finally(() => { btn.disabled = false; }); });
    toolbar.append(btn);
  });

  Studio.abCompare = { runCompare };
})();
