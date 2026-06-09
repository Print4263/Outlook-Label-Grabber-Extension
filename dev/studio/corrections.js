(function () {
  "use strict";
  const Studio = window.Studio;
  if (!Studio) return;
  const { util, state } = Studio;

  const CATEGORIES = [
    "", "wrong-crop", "wrong-variant-chosen", "missed-label", "bad-rotation",
    "content-cut-off", "extra-whitespace", "wrong-carrier", "low-confidence-but-correct"
  ];

  function save() { Studio.save("corrections"); Studio.refreshSummary(); }

  function recordFor(key) { return state.corrections[key] || null; }

  function upsert(cardModel, patch) {
    const key = cardModel.key;
    const top = cardModel.top || {};
    // Prefer the pristine detector snapshot (captured before any manual crop) so
    // the report's "before" is what the detector actually chose, not the user's fix.
    const det = cardModel.detectorOriginal || {};
    const base = state.corrections[key] || {
      detector: det.reason || top.reason || "",
      carrier: det.carrier || top.carrier || "",
      group: cardModel.group || "",
      fileName: cardModel.file?.name || "",
      original: {
        reason: det.reason || top.reason || "",
        confidence: Number(det.confidence ?? top.confidence ?? 0),
        width: Number(det.width || top.label?.width || 0),
        height: Number(det.height || top.label?.height || 0),
        cropRect: det.cropRect || top.cropRect || null,
        sourceWidth: Number(det.sourceWidth || top.sourceWidth || 0),
        sourceHeight: Number(det.sourceHeight || top.sourceHeight || 0)
      },
      corrected: null
    };
    const merged = { ...base, ...patch, at: new Date().toISOString() };
    // Drop the record entirely if it carries no signal.
    if (!merged.category && !merged.note && !merged.corrected) {
      delete state.corrections[key];
    } else {
      state.corrections[key] = merged;
    }
    save();
  }

  // --- Per-card UI -----------------------------------------------------------
  function attach(cardModel) {
    if (cardModel.error) return;
    const rec = recordFor(cardModel.key);
    const wrap = document.createElement("div");
    wrap.className = "correction-row";

    const tag = document.createElement("span");
    tag.className = "correction-tag";
    tag.textContent = "Correction:";
    wrap.append(tag);

    const sel = document.createElement("select");
    sel.className = "correction-cat";
    for (const c of CATEGORIES) {
      const opt = document.createElement("option");
      opt.value = c; opt.textContent = c || "(no issue)";
      sel.append(opt);
    }
    sel.value = rec?.category || "";
    sel.addEventListener("change", () => {
      upsert(cardModel, { category: sel.value });
      mark();
      if (sel.value && sel.value !== "low-confidence-but-correct" && !state.judgements[cardModel.key]) {
        Studio.setJudgement(cardModel.key, "fail");
        const buttons = cardModel.element.querySelectorAll(".judgement button");
        buttons.forEach((b) => b.classList.toggle("active", b.classList.contains("fail")));
      }
    });
    wrap.append(sel);

    const note = document.createElement("input");
    note.className = "correction-note";
    note.placeholder = "what's wrong / how to fix…";
    note.value = rec?.note || "";
    note.addEventListener("change", () => { upsert(cardModel, { note: note.value.trim() }); mark(); });
    wrap.append(note);

    const fixBtn = document.createElement("button");
    fixBtn.type = "button";
    fixBtn.className = "correction-fix";
    fixBtn.textContent = "Capture corrected crop";
    fixBtn.addEventListener("click", () => {
      Studio.openCropTweak(cardModel, {
        onApply: ({ rect, label, canvas }) => {
          upsert(cardModel, {
            category: sel.value || "wrong-crop",
            corrected: {
              rect: { x: util.round(rect.x, 4), y: util.round(rect.y, 4), width: util.round(rect.width, 4), height: util.round(rect.height, 4) },
              pixelRect: {
                x: Math.round(rect.x * canvas.width), y: Math.round(rect.y * canvas.height),
                width: Math.round(rect.width * canvas.width), height: Math.round(rect.height * canvas.height)
              },
              width: label.width, height: label.height,
              sourceWidth: canvas.width, sourceHeight: canvas.height
            }
          });
          if (!sel.value) sel.value = "wrong-crop";
          mark();
        }
      });
    });
    wrap.append(fixBtn);

    const status = document.createElement("span");
    status.className = "correction-status";
    wrap.append(status);

    function mark() {
      const r = recordFor(cardModel.key);
      const flags = [];
      if (r?.category) flags.push(r.category);
      if (r?.corrected) flags.push("crop captured");
      status.textContent = flags.length ? `● ${flags.join(" · ")}` : "";
      wrap.classList.toggle("has-correction", Boolean(r && (r.category || r.note || r.corrected)));
    }
    mark();
    cardModel.element.append(wrap);
  }

  // --- Fix-report export -----------------------------------------------------
  function exportReport() {
    const entries = Object.entries(state.corrections);
    if (!entries.length) { Studio.setStatus("No corrections recorded yet."); return; }

    // Group by detector -> category.
    const byDetector = new Map();
    for (const [key, rec] of entries) {
      const det = rec.detector || rec.original?.reason || "(unknown)";
      if (!byDetector.has(det)) byDetector.set(det, new Map());
      const byCat = byDetector.get(det);
      const cat = rec.category || "(untagged)";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ key, rec });
    }

    const lines = [
      "# Label detection — fix report",
      "",
      `Exported ${new Date().toISOString()} from the training studio. ${entries.length} correction(s).`,
      "",
      "Grouped by **detector → failure category**. Each item is a label the detector",
      "got wrong, with the note and (where captured) the geometry of the correct crop.",
      "Use this as the to-do list for tuning `detection/label-detector.js`.",
      ""
    ];

    // Summary counts.
    const catCounts = {};
    for (const [, rec] of entries) { const c = rec.category || "(untagged)"; catCounts[c] = (catCounts[c] || 0) + 1; }
    lines.push("## Summary by category", "");
    for (const [cat, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) lines.push(`- **${cat}**: ${n}`);
    lines.push("");

    for (const [det, byCat] of Array.from(byDetector.entries()).sort()) {
      lines.push(`## Detector: \`${det}\``, "");
      for (const [cat, items] of Array.from(byCat.entries()).sort()) {
        lines.push(`### ${cat} (${items.length})`, "");
        for (const { key, rec } of items) {
          lines.push(`- **${key}**${rec.carrier ? ` _(${rec.carrier})_` : ""}`);
          if (rec.note) lines.push(`  - note: ${rec.note}`);
          const o = rec.original || {};
          lines.push(`  - chose: \`${o.reason || "?"}\` conf ${Number(o.confidence || 0).toFixed(2)}, ` +
            `crop ${o.width || "?"}×${o.height || "?"}` +
            (o.cropRect ? ` @ (${Math.round(o.cropRect.x)},${Math.round(o.cropRect.y)}) ${Math.round(o.cropRect.width)}×${Math.round(o.cropRect.height)} of ${o.sourceWidth}×${o.sourceHeight}` : ""));
          if (rec.corrected) {
            const c = rec.corrected, p = c.pixelRect || {};
            lines.push(`  - **corrected crop**: ${c.width}×${c.height} ` +
              `@ (${p.x},${p.y}) ${p.width}×${p.height} of ${c.sourceWidth}×${c.sourceHeight} ` +
              `[x ${c.rect.x}, y ${c.rect.y}, w ${c.rect.width}, h ${c.rect.height}]`);
          }
        }
        lines.push("");
      }
    }

    const ts = util.timestampSlug();
    util.downloadText(lines.join("\n"), `fix-report-${ts}.md`);
    util.downloadJson({ schemaVersion: 2, exportedAt: new Date().toISOString(), corrections: state.corrections }, `fix-report-${ts}.json`);
    Studio.setStatus(`Exported fix-report with ${entries.length} correction(s).`);
  }

  // Add corrected/untagged counts to the summary line.
  function summaryHook() {
    const n = Object.keys(state.corrections).length;
    if (!n) return;
    Studio.els.summary.textContent += ` | ${n} correction(s) saved`;
  }

  Studio.corrections = { attach, exportReport, recordFor };
  Studio.cardHooks.push((cardModel) => { try { attach(cardModel); } catch (e) { console.warn("[studio] corrections failed", e); } });
  Studio.summaryHooks.push(summaryHook);
  Studio.toolbarHooks.push((toolbar) => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = "Export fix-report";
    btn.title = "Download the tagged correction report (.md + .json)";
    btn.addEventListener("click", exportReport);
    toolbar.append(btn);
  });
})();
