(function () {
  "use strict";
  const Studio = window.Studio;
  if (!Studio) return;
  const { util, state } = Studio;

  const KNOWN_REASONS = [
    "embedded-usps-label", "embedded-image-label", "dashed-border", "solid-border",
    "fold-here", "label-sized", "trained-model", "keywords", "barcode",
    "image-label-fallback", "text-label-page", "single-page-pdf"
  ];

  let panel = null;

  // --- Context derived from a label's page, used to evaluate rule conditions ---
  function contextFor(candidates, page) {
    const det = window.LabelExtractorDetector;
    const text = page?.text || "";
    let carrier = "";
    try { carrier = det?.guessCarrier?.(text) || ""; } catch (_) {}
    if (!carrier) carrier = candidates.find((c) => c.carrier)?.carrier || "";
    let barcodeCount = 0;
    try { if (page?.canvas && det?.findBarcodeRegions) barcodeCount = det.findBarcodeRegions(page.canvas).length; } catch (_) {}
    const pageCount = Number(candidates[0]?.pageCount || 0) || (page ? 1 : 0);
    return { carrier, barcodeCount, pageCount, text: String(text).toUpperCase() };
  }

  function aspectOf(candidate) {
    const w = Number(candidate?.label?.width || 0), h = Number(candidate?.label?.height || 0);
    return h ? w / h : 0;
  }

  function ruleMatches(rule, ctx) {
    const w = rule.when || {};
    if (w.carrier && String(w.carrier).toLowerCase() !== String(ctx.carrier).toLowerCase()) return false;
    if (Number.isFinite(w.barcodeCountMin) && ctx.barcodeCount < w.barcodeCountMin) return false;
    if (Number.isFinite(w.pageCount) && ctx.pageCount !== w.pageCount) return false;
    if (w.keyword && !ctx.text.includes(String(w.keyword).toUpperCase())) return false;
    return true;
  }

  function targetMatches(rule, candidate) {
    if (rule.forceReason && candidate.reason !== rule.forceReason) return false;
    const w = rule.when || {};
    const aspect = aspectOf(candidate);
    if (Number.isFinite(w.aspectMin) && aspect < w.aspectMin) return false;
    if (Number.isFinite(w.aspectMax) && aspect > w.aspectMax) return false;
    return true;
  }

  // Studio-only re-rank: the first enabled, matching rule whose target variant
  // exists wins; that variant is moved to the top. Returns names of fired rules.
  function applyToCandidates(key, candidates, ctxInfo = {}) {
    if (!candidates || candidates.length < 2) return [];
    const ctx = contextFor(candidates, ctxInfo.page);
    const fired = [];
    for (const rule of state.rules) {
      if (rule.enabled === false) continue;
      if (!ruleMatches(rule, ctx)) continue;
      const idx = candidates.findIndex((c) => targetMatches(rule, c));
      if (idx > 0) {
        const [picked] = candidates.splice(idx, 1);
        candidates.unshift(picked);
        fired.push(rule.name || `rule#${rule.id}`);
        break; // top is now decided
      } else if (idx === 0) {
        fired.push(rule.name || `rule#${rule.id}`);
        break;
      }
    }
    return fired;
  }

  // --- Persistence -----------------------------------------------------------
  function addRule(rule) {
    rule.id = Date.now() + Math.floor(Math.random() * 1000);
    rule.enabled = true;
    state.rules.push(rule);
    Studio.save("rules");
    renderPanel();
  }
  function deleteRule(id) {
    state.rules = state.rules.filter((r) => r.id !== id);
    Studio.save("rules");
    renderPanel();
  }
  function toggleRule(id, enabled) {
    const r = state.rules.find((x) => x.id === id);
    if (r) { r.enabled = enabled; Studio.save("rules"); }
  }

  // --- Spec export -----------------------------------------------------------
  function describe(rule) {
    const w = rule.when || {};
    const conds = [];
    if (w.carrier) conds.push(`carrier = ${w.carrier}`);
    if (Number.isFinite(w.barcodeCountMin)) conds.push(`barcodes ≥ ${w.barcodeCountMin}`);
    if (Number.isFinite(w.pageCount)) conds.push(`page count = ${w.pageCount}`);
    if (w.keyword) conds.push(`text contains "${w.keyword}"`);
    if (Number.isFinite(w.aspectMin)) conds.push(`aspect ≥ ${w.aspectMin}`);
    if (Number.isFinite(w.aspectMax)) conds.push(`aspect ≤ ${w.aspectMax}`);
    const when = conds.length ? conds.join(" AND ") : "(always)";
    return `When ${when} → force \`${rule.forceReason}\` to top`;
  }

  function exportSpec() {
    if (!state.rules.length) { Studio.setStatus("No rules to export."); return; }
    const ts = util.timestampSlug();
    const lines = [
      "# Label variant-forcing rules — spec",
      "",
      `Exported ${new Date().toISOString()} from the training studio. ${state.rules.length} rule(s).`,
      "",
      "These are **studio-only** preferences for which detector variant should win,",
      "to be baked by hand into `compareDetections` / `detectionRankScore` in",
      "`detection/label-detector.js`. They do not ship as a runtime file.",
      ""
    ];
    state.rules.forEach((r, i) => {
      lines.push(`## ${i + 1}. ${r.name || "(unnamed)"}${r.enabled === false ? " *(disabled)*" : ""}`);
      lines.push("");
      lines.push(describe(r));
      lines.push("");
    });
    util.downloadText(lines.join("\n"), `label-rules-spec-${ts}.md`);
    util.downloadJson({ schemaVersion: 2, exportedAt: new Date().toISOString(), rules: state.rules }, `label-rules-${ts}.json`);
    Studio.setStatus(`Exported ${state.rules.length} rule(s) as spec + JSON.`);
  }

  // --- UI --------------------------------------------------------------------
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "rules-panel";
    panel.style.display = "none";
    Studio.els.groupbar.insertAdjacentElement("afterend", panel);
    return panel;
  }

  function renderPanel() {
    const el = ensurePanel();
    el.replaceChildren();
    const head = document.createElement("div");
    head.className = "rules-head";
    head.innerHTML = "<strong>Variant-forcing rules</strong> (studio-only) — re-rank candidates by major keys.";
    el.append(head);

    const table = document.createElement("table");
    table.className = "rules-table";
    table.innerHTML = "<thead><tr><th>on</th><th>rule</th><th></th></tr></thead>";
    const tbody = document.createElement("tbody");
    if (!state.rules.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="3" class="muted">No rules yet. Add one below, or click “+rule” on a candidate you re-ranked.</td>';
      tbody.append(tr);
    }
    for (const rule of state.rules) {
      const tr = document.createElement("tr");
      const onTd = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = rule.enabled !== false;
      cb.addEventListener("change", () => toggleRule(rule.id, cb.checked));
      onTd.append(cb);
      tr.append(onTd);
      const desc = document.createElement("td");
      desc.innerHTML = `<strong>${util.escapeHtml(rule.name || "(unnamed)")}</strong><br><span class="muted">${util.escapeHtml(describe(rule))}</span>`;
      tr.append(desc);
      const del = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.type = "button"; delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteRule(rule.id));
      del.append(delBtn);
      tr.append(del);
      tbody.append(tr);
    }
    table.append(tbody);
    el.append(table);
    el.append(buildForm());

    const actions = document.createElement("div");
    actions.className = "rules-actions";
    const exp = document.createElement("button");
    exp.type = "button"; exp.textContent = "Export spec + JSON";
    exp.addEventListener("click", exportSpec);
    const rerun = document.createElement("button");
    rerun.type = "button"; rerun.textContent = "Re-run current group with rules";
    rerun.addEventListener("click", () => Studio.els.runCorpusGroup.click());
    actions.append(exp, rerun);
    el.append(actions);
    return el;
  }

  function buildForm(prefill = {}) {
    const form = document.createElement("div");
    form.className = "rule-form";
    const reasonOptions = Array.from(new Set([...KNOWN_REASONS,
      ...state.currentCards.flatMap((c) => (c.candidates || []).map((x) => x.reason).filter(Boolean))]));
    form.innerHTML = `
      <div class="rule-form-row">
        <input data-f="name" placeholder="rule name" value="${util.escapeHtml(prefill.name || "")}">
        <input data-f="carrier" placeholder="carrier (e.g. USPS)" value="${util.escapeHtml(prefill.carrier || "")}">
        <input data-f="barcodeCountMin" type="number" min="0" placeholder="min barcodes">
        <input data-f="pageCount" type="number" min="1" placeholder="page count">
        <input data-f="keyword" placeholder="text keyword">
        <input data-f="aspectMin" type="number" step="0.01" placeholder="aspect min">
        <input data-f="aspectMax" type="number" step="0.01" placeholder="aspect max">
        <select data-f="forceReason"></select>
        <button type="button" data-act="add">Add rule</button>
      </div>`;
    const sel = form.querySelector('[data-f="forceReason"]');
    for (const r of reasonOptions) {
      const opt = document.createElement("option"); opt.value = r; opt.textContent = r; sel.append(opt);
    }
    if (prefill.forceReason) sel.value = prefill.forceReason;
    form.querySelector('[data-act="add"]').addEventListener("click", () => {
      const get = (f) => form.querySelector(`[data-f="${f}"]`).value.trim();
      const num = (f) => { const v = get(f); return v === "" ? undefined : Number(v); };
      const when = {};
      if (get("carrier")) when.carrier = get("carrier");
      if (num("barcodeCountMin") !== undefined) when.barcodeCountMin = num("barcodeCountMin");
      if (num("pageCount") !== undefined) when.pageCount = num("pageCount");
      if (get("keyword")) when.keyword = get("keyword");
      if (num("aspectMin") !== undefined) when.aspectMin = num("aspectMin");
      if (num("aspectMax") !== undefined) when.aspectMax = num("aspectMax");
      const forceReason = get("forceReason") || sel.value;
      if (!forceReason) { Studio.setStatus("Pick a variant reason to force."); return; }
      addRule({ name: get("name") || `force ${forceReason}`, when, forceReason });
    });
    return form;
  }

  // Clicking "Make top" on a card offers to capture it as a rule.
  function onManualPrefer(cardModel, candidate) {
    show();
    const ctx = contextFor(cardModel.candidates, cardModel.page);
    const existing = panel.querySelector(".rule-form");
    const fresh = buildForm({
      name: `${ctx.carrier || "any"} → ${candidate.reason}`,
      carrier: ctx.carrier || "",
      forceReason: candidate.reason
    });
    if (existing) existing.replaceWith(fresh);
    Studio.setStatus(`Pre-filled a rule to force “${candidate.reason}” — adjust conditions and click Add rule.`);
  }

  let visible = false;
  function show() { ensurePanel().style.display = ""; visible = true; renderPanel(); }
  function hide() { if (panel) panel.style.display = "none"; visible = false; }
  function toggle() { visible ? hide() : show(); }

  Studio.rules = { applyToCandidates, onManualPrefer, exportSpec };
  Studio.toolbarHooks.push((toolbar) => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = "Rules";
    btn.title = "Variant-forcing rules";
    btn.addEventListener("click", toggle);
    toolbar.append(btn);
  });
})();
