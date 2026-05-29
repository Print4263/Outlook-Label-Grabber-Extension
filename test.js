(function () {
  "use strict";

  // Bundled sample labels. Add filenames here as you drop new samples into the folders.
  const FIXTURES = [
    "debug-ebay-images/page1_image1_Im3.png",
    "debug-ebay-images/page1_image2_Im4.png",
    "debug-ebay-images/page1_image3_Im1.png",
    "debug-ebay-images/page1_image4_Im2.png",
    "debug-online-return-images/page2_image1_Im1.png",
    "debug-online-return-images/page2_image2_Im2.png"
  ];

  // Confidence floors mirrored from sidepanel.js so the harness grades the same way the app does.
  const TRUSTED_CONFIDENCE = 0.90;
  const MIN_FULL_LABEL_CONFIDENCE = 0.45;

  const els = {
    runFixtures: document.getElementById("runFixtures"),
    filePicker: document.getElementById("filePicker"),
    status: document.getElementById("status"),
    summary: document.getElementById("summary"),
    results: document.getElementById("results")
  };

  els.runFixtures.addEventListener("click", runFixtures);
  els.filePicker.addEventListener("change", () => {
    const file = els.filePicker.files?.[0];
    if (file) runOne(file.name, file).then((card) => {
      els.results.prepend(card.element);
      setSummary([card]);
    });
  });

  async function runFixtures() {
    els.results.replaceChildren();
    setStatus("Running…");
    const cards = [];
    for (const path of FIXTURES) {
      setStatus(`Running ${path}…`);
      try {
        const blob = await (await fetch(path)).blob();
        const file = new File([blob], path.split("/").pop(), { type: blob.type || guessType(path) });
        const card = await runOne(path, file);
        cards.push(card);
        els.results.append(card.element);
      } catch (error) {
        const card = errorCard(path, error?.message || "could not load fixture");
        cards.push(card);
        els.results.append(card.element);
      }
    }
    setStatus("Done.");
    setSummary(cards);
  }

  // Mirrors sidepanel.js runLocalDetector — the exact production path.
  async function detect(file) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      const processed = await window.LabelExtractorPDF.process({
        buffer: await file.arrayBuffer(),
        type: "application/pdf",
        name: file.name
      });
      if (Array.isArray(processed)) return { candidates: processed, page: null };
      if (processed?.pages) {
        const candidates = await window.LabelExtractorDetector.detectPdfCandidates(processed.pages);
        return { candidates: candidates.length ? candidates : [processed], page: processed.pages[0] || null };
      }
      return { candidates: [processed], page: null };
    }

    const page = await window.LabelExtractorPNG.process({ blob: file, type: file.type, name: file.name }, 0);
    const candidates = await window.LabelExtractorDetector.detectAllPngCandidates([page]);
    return { candidates, page };
  }

  async function runOne(label, file) {
    const started = performance.now();
    let candidates = [];
    let page = null;
    let error = null;
    try {
      const out = await detect(file);
      candidates = (out.candidates || []).filter(Boolean);
      page = out.page;
    } catch (e) {
      error = e?.message || String(e);
    }
    const ms = Math.round(performance.now() - started);
    return buildCard({ label, file, candidates, page, error, ms });
  }

  function grade(top) {
    if (!top || !top.label) return { cls: "err", text: "NO LABEL" };
    const conf = Number(top.confidence || 0);
    if (conf >= TRUSTED_CONFIDENCE) return { cls: "ok", text: `TRUSTED ${conf.toFixed(2)}` };
    if (conf >= MIN_FULL_LABEL_CONFIDENCE) return { cls: "warn", text: `REVIEW ${conf.toFixed(2)}` };
    return { cls: "bad", text: `LOW ${conf.toFixed(2)}` };
  }

  function buildCard({ label, file, candidates, page, error, ms }) {
    const top = candidates[0];
    const g = error ? { cls: "err", text: "ERROR" } : grade(top);

    const card = document.createElement("div");
    card.className = "case";

    const h2 = document.createElement("h2");
    const pill = document.createElement("span");
    pill.className = `pill ${g.cls}`;
    pill.textContent = g.text;
    h2.append(pill);
    h2.append(document.createTextNode(file.name + " "));
    const pathSpan = document.createElement("span");
    pathSpan.className = "path";
    pathSpan.textContent = `(${label} · ${ms}ms)`;
    h2.append(pathSpan);
    card.append(h2);

    if (error) {
      const p = document.createElement("p");
      p.className = "warns";
      p.textContent = `Detection threw: ${error}`;
      card.append(p);
      return { element: card, grade: g, top, candidates };
    }

    const row = document.createElement("div");
    row.className = "row";

    // Source thumbnail
    const source = document.createElement("div");
    source.className = "source";
    const srcImg = document.createElement("img");
    srcImg.src = URL.createObjectURL(file);
    source.append(srcImg);
    if (page?.canvas) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${page.canvas.width}×${page.canvas.height}px`;
      source.append(meta);
    }
    row.append(source);

    // Candidate table
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>#</th><th>reason</th><th>conf</th><th>size</th><th>variant / warnings</th><th>crop</th></tr></thead>";
    const tbody = document.createElement("tbody");
    if (!candidates.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="6" class="warns">No candidates produced.</td>';
      tbody.append(tr);
    }
    candidates.forEach((c, i) => {
      const tr = document.createElement("tr");
      if (i === 0) tr.className = "chosen";

      const warnText = (c.warnings || []).join(" · ");
      const variant = [c.variantName, warnText].filter(Boolean).join(" — ");

      tr.append(td(i === 0 ? "★ 0" : String(i)));
      tr.append(td(c.reason || "—"));
      tr.append(td(Number(c.confidence || 0).toFixed(3), "conf"));
      tr.append(td(c.label ? `${c.label.width}×${c.label.height}` : "—"));
      const vtd = td("");
      const vtext = document.createElement("div");
      vtext.textContent = c.variantName || "";
      const wtext = document.createElement("div");
      wtext.className = "warns";
      wtext.textContent = warnText;
      vtd.append(vtext, wtext);
      tr.append(vtd);

      const cropTd = document.createElement("td");
      if (c.label?.dataUrl) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.src = c.label.dataUrl;
        cropTd.append(img);
      } else {
        cropTd.textContent = "—";
      }
      tr.append(cropTd);

      tbody.append(tr);
    });
    table.append(tbody);
    row.append(table);
    card.append(row);

    return { element: card, grade: g, top, candidates };
  }

  function errorCard(label, message) {
    return buildCard({ label, file: { name: label }, candidates: [], page: null, error: message, ms: 0 });
  }

  function td(text, cls) {
    const cell = document.createElement("td");
    if (cls) cell.className = cls;
    cell.textContent = text;
    return cell;
  }

  function setStatus(text) { els.status.textContent = text; }

  function setSummary(cards) {
    const counts = { ok: 0, warn: 0, bad: 0, err: 0 };
    cards.forEach((c) => { counts[c.grade.cls] = (counts[c.grade.cls] || 0) + 1; });
    els.summary.textContent =
      `${cards.length} case(s): ` +
      `${counts.ok} trusted · ${counts.warn} review · ${counts.bad} low · ${counts.err} error`;
  }

  function guessType(path) {
    if (/\.pdf$/i.test(path)) return "application/pdf";
    if (/\.png$/i.test(path)) return "image/png";
    if (/\.jpe?g$/i.test(path)) return "image/jpeg";
    if (/\.gif$/i.test(path)) return "image/gif";
    return "";
  }

  // Auto-run on load.
  runFixtures();
})();
