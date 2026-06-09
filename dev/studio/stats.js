(function () {
  "use strict";
  const Studio = window.Studio;
  if (!Studio) return;

  let panel = null;
  let visible = true;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "stats-panel";
    Studio.els.groupbar.insertAdjacentElement("afterend", panel);
    return panel;
  }

  // Counts how often each detector wins (is the top choice) vs merely appears,
  // plus pass/fail and a per-carrier breakdown. Answers "how often does the ONNX
  // model (trained-model) actually fire?".
  function computeTally(cards) {
    const byReason = new Map();
    const byCarrier = new Map();
    const get = (map, key) => {
      if (!map.has(key)) map.set(key, { key, top: 0, appeared: 0, confSum: 0, pass: 0, fail: 0, trusted: 0 });
      return map.get(key);
    };

    for (const card of cards) {
      const judgement = Studio.state.judgements[card.key] || "";
      const top = card.top;
      const seenReasons = new Set();
      (card.candidates || []).forEach((c) => {
        const reason = c.reason || "—";
        if (seenReasons.has(reason)) return;
        seenReasons.add(reason);
        get(byReason, reason).appeared += 1;
      });
      if (top) {
        const row = get(byReason, top.reason || "—");
        row.top += 1;
        row.confSum += Number(top.confidence || 0);
        if (judgement === "pass") row.pass += 1;
        if (judgement === "fail") row.fail += 1;
        if (Number(top.confidence || 0) >= Studio.TRUSTED_CONFIDENCE) row.trusted += 1;

        const carrier = top.carrier || "(unknown)";
        const crow = get(byCarrier, carrier);
        crow.top += 1;
        crow.confSum += Number(top.confidence || 0);
        if (judgement === "pass") crow.pass += 1;
        if (judgement === "fail") crow.fail += 1;
        if (Number(top.confidence || 0) >= Studio.TRUSTED_CONFIDENCE) crow.trusted += 1;
      }
    }
    return {
      reasons: Array.from(byReason.values()).sort((a, b) => b.top - a.top || b.appeared - a.appeared),
      carriers: Array.from(byCarrier.values()).sort((a, b) => b.top - a.top)
    };
  }

  function pct(n, d) { return d ? `${Math.round((n / d) * 100)}%` : "—"; }

  function reasonTable(rows, total) {
    const table = document.createElement("table");
    table.className = "stats-table";
    table.innerHTML =
      "<thead><tr><th>detector (reason)</th><th>wins</th><th>win share</th>" +
      "<th>appeared</th><th>win rate</th><th>avg conf</th><th>trusted</th>" +
      "<th>✓</th><th>✗</th><th>unjudged</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      if (r.key === "trained-model") tr.className = "model-row";
      const unjudged = r.top - r.pass - r.fail;
      const cells = [
        r.key,
        String(r.top),
        pct(r.top, total),
        String(r.appeared),
        pct(r.top, r.appeared),
        r.top ? (r.confSum / r.top).toFixed(2) : "—",
        String(r.trusted),
        String(r.pass),
        String(r.fail),
        String(unjudged < 0 ? 0 : unjudged)
      ];
      cells.forEach((c, i) => tr.append(Studio.util.td(c, i === 0 ? "" : "num")));
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  function carrierTable(rows) {
    const table = document.createElement("table");
    table.className = "stats-table";
    table.innerHTML = "<thead><tr><th>carrier</th><th>labels</th><th>avg conf</th><th>trusted</th><th>✓</th><th>✗</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      const cells = [r.key, String(r.top), r.top ? (r.confSum / r.top).toFixed(2) : "—", String(r.trusted), String(r.pass), String(r.fail)];
      cells.forEach((c, i) => tr.append(Studio.util.td(c, i === 0 ? "" : "num")));
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  function render(cards) {
    const el = ensurePanel();
    el.style.display = visible ? "" : "none";
    if (!visible) return;
    el.replaceChildren();
    if (!cards.length) { el.textContent = ""; return; }

    const { reasons, carriers } = computeTally(cards);
    const total = cards.length;
    const modelWins = reasons.find((r) => r.key === "trained-model")?.top || 0;

    const head = document.createElement("div");
    head.className = "stats-head";
    head.innerHTML =
      `<strong>Wins by detector</strong> — ${total} label(s). ` +
      `ONNX model (<code>trained-model</code>) fired as top choice on <strong>${modelWins}</strong> ` +
      `(${pct(modelWins, total)}).`;
    el.append(head);
    el.append(reasonTable(reasons, total));

    const carHead = document.createElement("div");
    carHead.className = "stats-subhead";
    carHead.textContent = "By carrier";
    el.append(carHead);
    el.append(carrierTable(carriers));
  }

  Studio.stats = { render, computeTally };

  Studio.toolbarHooks.push((toolbar) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Stats";
    btn.title = "Toggle the wins-by-detector tally";
    btn.addEventListener("click", () => { visible = !visible; render(Studio.state.currentCards); });
    toolbar.append(btn);
  });

  Studio.summaryHooks.push(render);
})();
