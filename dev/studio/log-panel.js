(function () {
  "use strict";
  const Studio = window.Studio;
  if (!Studio) return;
  const { escapeHtml } = Studio.util;

  // Builds the collapsible per-label log from the trace emitted by detection/*.js.
  function buildLog(cardModel) {
    const trace = cardModel.trace || [];
    const details = document.createElement("details");
    details.className = "log-panel";
    const summary = document.createElement("summary");
    const stageEvents = trace.filter((e) => e.stage === "stage");
    const earlyExit = trace.find((e) => e.stage === "early-exit");
    summary.innerHTML = `Log — ${stageEvents.length} stage(s) ran` +
      (earlyExit ? ` · <span class="log-early">early-exit @ ${escapeHtml(earlyExit.detector || earlyExit.reason)}</span>` : "") +
      (cardModel.rulesFired?.length ? ` · <span class="log-rule">rule: ${escapeHtml(cardModel.rulesFired.join(", "))}</span>` : "");
    details.append(summary);

    const body = document.createElement("div");
    body.className = "log-body";

    if (!trace.length) {
      body.innerHTML = "<em>No trace captured (detection threw before tracing, or trace sink unavailable).</em>";
      details.append(body);
      return details;
    }

    // 1. Cascade stages, in order.
    const cascade = document.createElement("div");
    cascade.className = "log-section";
    cascade.innerHTML = "<div class='log-h'>Cascade stages</div>";
    const list = document.createElement("ol");
    list.className = "log-stages";
    for (const e of trace) {
      if (e.stage === "run-start") {
        const li = document.createElement("li");
        li.className = "log-run";
        li.textContent = `run: ${e.path} path, ${e.pages} page(s)` +
          (e.onlineReturnCenterDocument ? " · online-return-center doc" : "");
        list.append(li);
      } else if (e.stage === "stage") {
        const li = document.createElement("li");
        const made = Number(e.produced || 0);
        li.className = made > 0 ? "log-stage made" : (e.skipped ? "log-stage skipped" : "log-stage none");
        let text = `${e.detector}: `;
        if (e.skipped) text += "skipped";
        else if (made > 0) text += `+${made} candidate(s)`;
        else text += "no candidate";
        if (e.detector === "trained-model" && e.available === false) text += " (model not loaded)";
        li.textContent = text;
        list.append(li);
      } else if (e.stage === "early-exit") {
        const li = document.createElement("li");
        li.className = "log-stage early";
        li.textContent = `EARLY EXIT @ ${e.detector || e.reason} (conf ${Number(e.confidence || 0).toFixed(2)}` +
          (e.score != null ? `, score ${Number(e.score).toFixed(2)}` : "") + `) — ${e.note || ""}`;
        list.append(li);
      }
    }
    cascade.append(list);
    body.append(cascade);

    // 2. ONNX model prediction (if it ran).
    const model = trace.find((e) => e.stage === "model-prediction");
    if (model) {
      const sec = document.createElement("div");
      sec.className = "log-section";
      sec.innerHTML = "<div class='log-h'>ONNX model</div>";
      const p = document.createElement("div");
      p.className = "log-model";
      if (!model.found) {
        p.textContent = "Model returned no box above the candidate threshold.";
      } else {
        const r = model.rect || {};
        p.textContent =
          `raw conf ${Number(model.rawConfidence || 0).toFixed(3)} · score ${Number(model.score || 0).toFixed(3)} · ` +
          `${model.accepted ? "ACCEPTED" : "rejected (below threshold / shape)"}` +
          (r.width ? ` · box ${Math.round(r.width)}×${Math.round(r.height)} @ (${Math.round(r.x)},${Math.round(r.y)})` : "") +
          (model.acceptedConfidence ? ` · rescued conf ${Number(model.acceptedConfidence).toFixed(2)}` : "");
      }
      sec.append(p);
      body.append(sec);
    }

    // 3. Final ranking with score breakdown — why each variant placed where it did.
    const ranked = trace.find((e) => e.stage === "ranked");
    if (ranked?.order?.length) {
      const sec = document.createElement("div");
      sec.className = "log-section";
      sec.innerHTML = "<div class='log-h'>Ranking — score breakdown</div>";
      const table = document.createElement("table");
      table.className = "log-rank";
      table.innerHTML = "<thead><tr><th>#</th><th>reason</th><th>carrier</th><th>conf</th>" +
        "<th>quality</th><th>+conf</th><th>+text</th><th>+carrier</th><th>barcode pen.</th><th>= total</th></tr></thead>";
      const tbody = document.createElement("tbody");
      ranked.order.forEach((o, i) => {
        const b = o.breakdown || {};
        const tr = document.createElement("tr");
        if (i === 0) tr.className = "winner";
        const cells = [
          String(i), o.reason || "—", o.carrier || "", Number(o.confidence || 0).toFixed(2),
          fmt(b.qualityScore), fmt(b.confidence), fmt(b.labelTextScore), fmt(b.carrierPref),
          fmt(b.barcodePenalty), fmt(b.total != null ? b.total : o.score)
        ];
        cells.forEach((c, idx) => tr.append(Studio.util.td(c, idx <= 2 ? "" : "num")));
        tbody.append(tr);
      });
      table.append(tbody);
      sec.append(table);
      const note = document.createElement("div");
      note.className = "log-note";
      note.textContent = "total = quality + conf + text + carrier-pref + barcode-penalty (−5 if the crop excludes every barcode on a page that has one). Highest total wins.";
      sec.append(note);
      body.append(sec);
    }

    details.append(body);
    return details;
  }

  function fmt(v) {
    const n = Number(v || 0);
    if (!n) return "0";
    return (n > 0 ? "+" : "") + n.toFixed(2);
  }

  Studio.log = { buildLog };
  Studio.cardHooks.push((cardModel) => {
    try { cardModel.element.append(buildLog(cardModel)); }
    catch (e) { console.warn("[studio] log panel failed", e); }
  });
})();
