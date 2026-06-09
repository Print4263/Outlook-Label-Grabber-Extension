(function () {
  "use strict";

  // Bundled sample labels. Add filenames here as you drop new samples into the folders.
  const FIXTURES = [
    "debug-ebay-images/page1_image1_Im3.png",
    "debug-ebay-images/page1_image2_Im4.png",
    "debug-ebay-images/page1_image3_Im1.png",
    "debug-ebay-images/page1_image4_Im2.png",
    "debug-online-return-images/page2_image1_Im1.png",
    "debug-online-return-images/page2_image2_Im2.png",
    "debug-pdf-labels/ups-view-print-foldhere.pdf"
  ];

  // Confidence floors mirrored from sidepanel.js so the harness grades the same way the app does.
  const TRUSTED_CONFIDENCE = 0.90;
  const MIN_FULL_LABEL_CONFIDENCE = 0.45;

  const els = {
    runFixtures: document.getElementById("runFixtures"),
    corpusPicker: document.getElementById("corpusPicker"),
    groupPicker: document.getElementById("groupPicker"),
    runCorpusGroup: document.getElementById("runCorpusGroup"),
    runLocked: document.getElementById("runLocked"),
    lockGroup: document.getElementById("lockGroup"),
    exportTraining: document.getElementById("exportTraining"),
    importTraining: document.getElementById("importTraining"),
    filePicker: document.getElementById("filePicker"),
    status: document.getElementById("status"),
    groupbar: document.getElementById("groupbar"),
    summary: document.getElementById("summary"),
    results: document.getElementById("results")
  };

  const STORAGE_KEYS = {
    judgements: "label-harness-judgements-v1",
    baselines: "label-harness-baselines-v1",
    manualCrops: "label-harness-manual-crops-v1",
    preferredCandidates: "label-harness-preferred-candidates-v1"
  };
  const state = {
    corpusGroups: new Map(),
    currentGroup: "",
    currentCards: [],
    judgements: readJson(STORAGE_KEYS.judgements, {}),
    baselines: readJson(STORAGE_KEYS.baselines, {}),
    manualCrops: readJson(STORAGE_KEYS.manualCrops, {}),
    preferredCandidates: readJson(STORAGE_KEYS.preferredCandidates, {})
  };

  els.runFixtures.addEventListener("click", runFixtures);
  els.corpusPicker.addEventListener("change", loadCorpus);
  els.groupPicker.addEventListener("change", () => {
    state.currentGroup = els.groupPicker.value;
    updateGroupbar();
  });
  els.runCorpusGroup.addEventListener("click", runSelectedGroup);
  els.runLocked.addEventListener("click", runLockedBaselines);
  els.lockGroup.addEventListener("click", lockCurrentGroup);
  els.exportTraining.addEventListener("click", exportTrainingData);
  els.importTraining.addEventListener("change", importTrainingData);
  els.filePicker.addEventListener("change", () => {
    const file = els.filePicker.files?.[0];
    if (file) runOne(file.name, file).then((card) => {
      els.results.prepend(card.element);
      state.currentCards = [card];
      setSummary(state.currentCards);
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
    state.currentGroup = "Bundled fixtures";
    state.currentCards = cards;
    setSummary(cards);
  }

  function loadCorpus() {
    const files = Array.from(els.corpusPicker.files || [])
      .filter((file) => /\.(pdf|png|jpe?g|gif|hei[cf])$/i.test(file.name))
      .filter((file) => !corpusPath(file).toLowerCase().includes("/codex build/"));

    state.corpusGroups = new Map();
    for (const file of files) {
      const group = groupNameForFile(file);
      if (!group) continue;
      if (!state.corpusGroups.has(group)) state.corpusGroups.set(group, []);
      state.corpusGroups.get(group).push(file);
    }

    for (const groupFiles of state.corpusGroups.values()) {
      groupFiles.sort((a, b) => corpusPath(a).localeCompare(corpusPath(b)));
    }

    renderGroupPicker();
    state.currentGroup = els.groupPicker.value;
    updateGroupbar();
    setStatus(`Loaded ${files.length} label file(s) in ${state.corpusGroups.size} group(s).`);
  }

  function renderGroupPicker() {
    const groups = Array.from(state.corpusGroups.keys()).sort((a, b) => a.localeCompare(b));
    els.groupPicker.replaceChildren();
    for (const group of groups) {
      const option = document.createElement("option");
      option.value = group;
      option.textContent = `${group} (${state.corpusGroups.get(group).length})`;
      els.groupPicker.append(option);
    }
    const hasGroups = groups.length > 0;
    els.groupPicker.disabled = !hasGroups;
    els.runCorpusGroup.disabled = !hasGroups;
    els.runLocked.disabled = !Object.keys(state.baselines).length;
    els.lockGroup.disabled = true;
  }

  async function runSelectedGroup() {
    const group = els.groupPicker.value;
    if (!group || !state.corpusGroups.has(group)) return;
    state.currentGroup = group;
    await runFiles(group, state.corpusGroups.get(group));
  }

  async function runFiles(group, files, baselineOnly = false) {
    els.results.replaceChildren();
    setStatus(`Running ${group}...`);
    updateGroupbar();
    const cards = [];
    for (const file of files) {
      const key = corpusPath(file);
      if (baselineOnly && !state.baselines[group]?.[key]) continue;
      setStatus(`Running ${key}...`);
      try {
        const card = await runOne(key, file, group);
        cards.push(card);
        els.results.append(card.element);
      } catch (error) {
        const card = errorCard(key, error?.message || "could not run file");
        card.group = group;
        card.key = key;
        cards.push(card);
        els.results.append(card.element);
      }
    }
    state.currentCards = cards;
    els.lockGroup.disabled = !cards.length;
    setStatus(`Done running ${group}.`);
    setSummary(cards);
  }

  async function runLockedBaselines() {
    const groups = Object.keys(state.baselines).sort((a, b) => a.localeCompare(b));
    if (!groups.length) return;

    els.results.replaceChildren();
    const allCards = [];
    for (const group of groups) {
      const files = state.corpusGroups.get(group) || [];
      if (!files.length) continue;
      setStatus(`Regression running ${group}...`);
      for (const file of files) {
        const key = corpusPath(file);
        if (!state.baselines[group]?.[key]) continue;
        const card = await runOne(key, file, group);
        allCards.push(card);
        els.results.append(card.element);
      }
    }
    state.currentGroup = "Locked baselines";
    state.currentCards = allCards;
    els.lockGroup.disabled = true;
    setStatus("Done running locked baselines.");
    setSummary(allCards);
    updateGroupbar();
  }

  function lockCurrentGroup() {
    const group = state.currentGroup;
    if (!group || group === "Locked baselines" || !state.currentCards.length) return;
    state.baselines[group] = state.baselines[group] || {};
    for (const card of state.currentCards) {
      if (!card.key) continue;
      state.baselines[group][card.key] = {
        judgement: state.judgements[card.key] || "",
        signature: signatureFor(card),
        lockedAt: new Date().toISOString()
      };
    }
    writeJson(STORAGE_KEYS.baselines, state.baselines);
    els.runLocked.disabled = false;
    updateGroupbar();
    setSummary(state.currentCards);
    setStatus(`Locked ${state.currentCards.length} baseline(s) for ${group}.`);
  }

  function exportTrainingData() {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      harness: {
        currentGroup: state.currentGroup || "",
        groups: Array.from(state.corpusGroups.entries()).map(([group, files]) => ({
          group,
          files: files.map((file) => ({
            key: corpusPath(file),
            name: file.name,
            size: file.size,
            type: file.type || guessType(file.name)
          }))
        }))
      },
      storageKeys: STORAGE_KEYS,
      judgements: state.judgements,
      manualCrops: state.manualCrops,
      preferredCandidates: state.preferredCandidates,
      baselines: state.baselines,
      currentRun: state.currentCards.map(trainingRecordForCard)
    };

    downloadJson(payload, `label-training-data-${timestampSlug()}.json`);
    setStatus(`Exported ${payload.currentRun.length} current result(s) plus saved training decisions.`);
  }

  function trainingRecordForCard(card) {
    return {
      key: card.key,
      group: card.group || "",
      fileName: card.file?.name || "",
      fileType: card.file?.type || guessType(card.file?.name || ""),
      fileSize: Number(card.file?.size || 0),
      judgement: state.judgements[card.key] || "",
      manualCrop: state.manualCrops[card.key] || null,
      preferredCandidate: state.preferredCandidates[card.key] || null,
      top: candidateTrainingRecord(card.top),
      candidates: (card.candidates || []).map(candidateTrainingRecord),
      baseline: state.baselines[card.group]?.[card.key] || null,
      error: card.error || card.top?.error?.message || ""
    };
  }

  function candidateTrainingRecord(candidate) {
    if (!candidate) return null;
    return {
      reason: candidate.reason || "",
      confidence: Number(candidate.confidence || 0),
      carrier: candidate.carrier || "",
      pageIndex: Number(candidate.pageIndex || 0),
      pageCount: Number(candidate.pageCount || 0),
      cropRect: candidate.cropRect || null,
      sourceWidth: Number(candidate.sourceWidth || 0),
      sourceHeight: Number(candidate.sourceHeight || 0),
      labelWidth: Number(candidate.label?.width || 0),
      labelHeight: Number(candidate.label?.height || 0),
      variantName: candidate.variantName || "",
      warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
      needsCrop: Boolean(candidate.needsCrop),
      signature: signatureFor({ top: candidate })
    };
  }

  async function importTrainingData() {
    const file = els.importTraining.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      state.judgements = { ...state.judgements, ...(payload.judgements || {}) };
      state.manualCrops = { ...state.manualCrops, ...(payload.manualCrops || {}) };
      state.preferredCandidates = { ...state.preferredCandidates, ...(payload.preferredCandidates || {}) };
      state.baselines = mergeNestedObjects(state.baselines, payload.baselines || {});
      writeJson(STORAGE_KEYS.judgements, state.judgements);
      writeJson(STORAGE_KEYS.manualCrops, state.manualCrops);
      writeJson(STORAGE_KEYS.preferredCandidates, state.preferredCandidates);
      writeJson(STORAGE_KEYS.baselines, state.baselines);
      els.runLocked.disabled = !Object.keys(state.baselines).length;
      setSummary(state.currentCards);
      updateGroupbar();
      setStatus(`Imported training data from ${file.name}.`);
    } catch (error) {
      setStatus(`Import failed: ${error?.message || error}`);
    } finally {
      els.importTraining.value = "";
    }
  }

  function mergeNestedObjects(target, source) {
    const merged = { ...(target || {}) };
    for (const [key, value] of Object.entries(source || {})) {
      merged[key] = { ...(merged[key] || {}), ...(value || {}) };
    }
    return merged;
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

  async function runOne(label, file, group = "") {
    const started = performance.now();
    let candidates = [];
    let page = null;
    let error = null;
    try {
      const out = await detect(file);
      candidates = (out.candidates || []).filter(Boolean);
      page = out.page;
      applyStoredPreferredCandidate(label, candidates);
      await applyStoredManualCrop(label, candidates, page);
    } catch (e) {
      error = e?.message || String(e);
    }
    const ms = Math.round(performance.now() - started);
    return buildCard({ label, file, group, candidates, page, error, ms });
  }

  function grade(top) {
    if (!top || !top.label) return { cls: "err", text: "NO LABEL" };
    const conf = Number(top.confidence || 0);
    if (conf >= TRUSTED_CONFIDENCE) return { cls: "ok", text: `TRUSTED ${conf.toFixed(2)}` };
    if (conf >= MIN_FULL_LABEL_CONFIDENCE) return { cls: "warn", text: `REVIEW ${conf.toFixed(2)}` };
    return { cls: "bad", text: `LOW ${conf.toFixed(2)}` };
  }

  function buildCard({ label, file, group = "", candidates, page, error, ms }) {
    const top = candidates[0];
    const g = error ? { cls: "err", text: "ERROR" } : grade(top);
    const key = label;

    const card = document.createElement("div");
    card.className = "case";
    const cardModel = { element: card, grade: g, top, candidates, group, key, ms, page, file };

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
    h2.append(judgementControls(key));
    h2.append(tweakCropButton(cardModel));
    const baseline = baselineStatus(group, key, top);
    if (baseline) h2.append(baseline);
    card.append(h2);

    if (error) {
      const p = document.createElement("p");
      p.className = "warns";
      p.textContent = `Detection threw: ${error}`;
      card.append(p);
      cardModel.error = error;
      return cardModel;
    }

    if (top?.error) {
      const p = document.createElement("p");
      p.className = "warns";
      p.textContent = `PDF processing failed: ${top.error?.message || top.error}`;
      card.append(p);
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

      tr.append(candidateChoiceCell(cardModel, c, i, tr));
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
        if (i === 0) cardModel.previewCell = cropTd;
      } else {
        cropTd.textContent = "—";
      }
      if (i === 0 && !cardModel.previewCell) cardModel.previewCell = cropTd;
      tr.append(cropTd);

      tbody.append(tr);
    });
    table.append(tbody);
    row.append(table);
    card.append(row);

    return cardModel;
  }

  function errorCard(label, message) {
    return buildCard({ label, file: { name: label }, candidates: [], page: null, error: message, ms: 0 });
  }

  function candidateChoiceCell(cardModel, candidate, index, row) {
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "prefer-candidate";
    button.textContent = index === 0 ? "Preferred" : "Prefer";
    button.addEventListener("click", () => {
      selectPreferredCandidate(cardModel, candidate, row);
    });
    cell.append(button);
    return cell;
  }

  function selectPreferredCandidate(cardModel, candidate, row) {
    const previous = cardModel.candidates.filter((item) => item !== candidate);
    cardModel.candidates = [candidate, ...previous];
    cardModel.top = candidate;
    state.preferredCandidates[cardModel.key] = preferredCandidateRecord(candidate);
    delete state.manualCrops[cardModel.key];
    writeJson(STORAGE_KEYS.preferredCandidates, state.preferredCandidates);
    writeJson(STORAGE_KEYS.manualCrops, state.manualCrops);

    for (const tr of cardModel.element.querySelectorAll("tbody tr")) {
      tr.classList.toggle("chosen", tr === row);
      const button = tr.querySelector(".prefer-candidate");
      if (button) button.textContent = tr === row ? "Preferred" : "Prefer";
    }

    if (candidate.label) updateTopPreview(cardModel, candidate.label);
    setSummary(state.currentCards);
  }

  function preferredCandidateRecord(candidate) {
    return {
      signature: signatureFor({ top: candidate }),
      reason: candidate?.reason || "",
      variantName: candidate?.variantName || ""
    };
  }

  function judgementControls(key) {
    const wrap = document.createElement("span");
    wrap.className = "judgement";
    wrap.append(judgementButton(key, "pass", "✓"), judgementButton(key, "fail", "✗"));
    return wrap;
  }

  function tweakCropButton(cardModel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "crop-tweak";
    btn.textContent = "Tweak crop";
    btn.addEventListener("click", () => openCropTweak(cardModel));
    return btn;
  }

  async function openCropTweak(cardModel) {
    cardModel.element.querySelector(".crop-editor-inline")?.remove();
    const source = sourcePageFor(cardModel.top, cardModel.page) || await labelSourceFor(cardModel.top);
    if (!source?.canvas) {
      const note = document.createElement("p");
      note.className = "warns crop-editor-inline";
      note.textContent = "No source image is available for manual crop on this result.";
      cardModel.element.append(note);
      return;
    }

    const editor = document.createElement("div");
    editor.className = "crop-editor-inline";

    const toolbar = document.createElement("div");
    toolbar.className = "crop-edit-toolbar";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Apply crop";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset box";
    const full = document.createElement("button");
    full.type = "button";
    full.textContent = "Full source";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    const status = document.createElement("span");
    status.className = "manual-badge";
    toolbar.append(apply, reset, full, close, status);

    const stage = document.createElement("div");
    stage.className = "crop-stage";
    const cropCanvas = document.createElement("div");
    cropCanvas.className = "crop-canvas";
    const img = document.createElement("img");
    img.alt = "Source page";
    img.src = source.canvas.toDataURL("image/png");
    const box = document.createElement("div");
    box.className = "crop-box";
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const node = document.createElement("span");
      node.className = `crop-handle ${handle}`;
      node.dataset.handle = handle;
      box.append(node);
    }
    cropCanvas.append(img, box);
    stage.append(cropCanvas);
    editor.append(toolbar, stage);
    cardModel.element.append(editor);

    let rect = source.currentLabelOnly ? { x: 0, y: 0, width: 1, height: 1 } : initialCropRect(cardModel.top, source.canvas);
    function renderBox() {
      box.style.left = `${rect.x * 100}%`;
      box.style.top = `${rect.y * 100}%`;
      box.style.width = `${rect.width * 100}%`;
      box.style.height = `${rect.height * 100}%`;
    }
    renderBox();

    box.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const bounds = cropCanvas.getBoundingClientRect();
      const startX = (event.clientX - bounds.left) / bounds.width;
      const startY = (event.clientY - bounds.top) / bounds.height;
      const startRect = { ...rect };
      const handle = event.target?.dataset?.handle || "move";
      box.setPointerCapture(event.pointerId);

      function move(moveEvent) {
        const x = (moveEvent.clientX - bounds.left) / bounds.width;
        const y = (moveEvent.clientY - bounds.top) / bounds.height;
        if (handle !== "move") {
          rect = resizeRectFromHandle(startRect, handle, x, y);
        } else {
          rect.x = clamp(startRect.x + x - startX, 0, 1 - startRect.width);
          rect.y = clamp(startRect.y + y - startY, 0, 1 - startRect.height);
        }
        renderBox();
      }

      function up(upEvent) {
        box.releasePointerCapture(upEvent.pointerId);
        box.removeEventListener("pointermove", move);
        box.removeEventListener("pointerup", up);
      }

      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", up);
    });

    reset.addEventListener("click", () => {
      rect = initialCropRect(cardModel.top, source.canvas);
      renderBox();
    });
    full.addEventListener("click", () => {
      rect = { x: 0, y: 0, width: 1, height: 1 };
      renderBox();
    });
    close.addEventListener("click", () => editor.remove());
    apply.addEventListener("click", async () => {
      const label = await cropCanvasToLabel(source.canvas, rect);
      cardModel.top = {
        ...(cardModel.top || {}),
        confidence: Math.max(Number(cardModel.top?.confidence || 0), 0.99),
        reason: "manual-harness-crop",
        label,
        cropRect: percentRectToPixels(rect, source.canvas),
        sourceWidth: source.canvas.width,
        sourceHeight: source.canvas.height,
        variantName: "Manual harness crop",
        needsCrop: false
      };
      cardModel.candidates[0] = cardModel.top;
      state.manualCrops[cardModel.key] = rect;
      writeJson(STORAGE_KEYS.manualCrops, state.manualCrops);
      updateTopPreview(cardModel, label);
      state.judgements[cardModel.key] = "pass";
      writeJson(STORAGE_KEYS.judgements, state.judgements);
      const buttons = cardModel.element.querySelectorAll(".judgement button");
      buttons.forEach((button) => button.classList.toggle("active", button.classList.contains("pass")));
      status.textContent = "Manual crop applied.";
      setSummary(state.currentCards);
    });
  }

  function judgementButton(key, value, text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = value;
    btn.textContent = text;
    if (state.judgements[key] === value) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.judgements[key] = state.judgements[key] === value ? "" : value;
      if (!state.judgements[key]) delete state.judgements[key];
      writeJson(STORAGE_KEYS.judgements, state.judgements);
      for (const button of btn.parentElement.querySelectorAll("button")) button.classList.remove("active");
      if (state.judgements[key] === value) btn.classList.add("active");
      setSummary(state.currentCards);
    });
    return btn;
  }

  function baselineStatus(group, key, top) {
    const baseline = state.baselines[group]?.[key];
    if (!baseline) return null;
    const diff = compareBaseline(baseline.signature, signatureFor({ top }));
    const pill = document.createElement("span");
    pill.className = `pill ${diff.ok ? "pass" : "fail"}`;
    pill.textContent = diff.ok ? "BASELINE OK" : "BASELINE CHANGED";
    if (!diff.ok) pill.title = diff.reasons.join("; ");
    return pill;
  }

  function sourcePageFor(candidate, fallbackPage) {
    if (candidate?.sourceCanvas) {
      return {
        pageIndex: candidate.pageIndex,
        canvas: candidate.sourceCanvas
      };
    }
    const pages = Array.isArray(candidate?.pages) ? candidate.pages : [];
    const pageIndex = Number(candidate?.pageIndex || 0);
    return pages.find((item) => Number(item?.pageIndex || 0) === pageIndex)
      || pages[pageIndex]
      || fallbackPage;
  }

  async function labelSourceFor(candidate) {
    const dataUrl = candidate?.label?.dataUrl;
    if (!dataUrl) return null;
    const width = Number(candidate.label.width || 0);
    const height = Number(candidate.label.height || 0);
    if (!width || !height) return null;
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      canvas,
      pageIndex: candidate.pageIndex,
      currentLabelOnly: true
    };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function applyStoredPreferredCandidate(key, candidates) {
    const preferred = state.preferredCandidates[key];
    if (!preferred || candidates.length < 2) return;
    let bestIndex = -1;
    let bestScore = 0;
    candidates.forEach((candidate, index) => {
      const score = candidatePreferenceScore(preferred, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex <= 0 || bestScore < 2) return;
    const [selected] = candidates.splice(bestIndex, 1);
    candidates.unshift(selected);
  }

  function candidatePreferenceScore(preferred, candidate) {
    const sig = signatureFor({ top: candidate });
    const saved = preferred.signature || {};
    let score = 0;
    if (preferred.reason && preferred.reason === candidate.reason) score += 2;
    if (preferred.variantName && preferred.variantName === candidate.variantName) score += 1;
    if (saved.reason && saved.reason === sig.reason) score += 1;
    if (Math.abs(Number(saved.aspect || 0) - Number(sig.aspect || 0)) < 0.03) score += 1;
    if (Math.abs(Number(saved.width || 0) - Number(sig.width || 0)) < Math.max(12, Number(saved.width || 0) * 0.03)) score += 1;
    if (Math.abs(Number(saved.height || 0) - Number(sig.height || 0)) < Math.max(12, Number(saved.height || 0) * 0.03)) score += 1;
    return score;
  }

  async function applyStoredManualCrop(key, candidates, fallbackPage) {
    const rect = state.manualCrops[key];
    const top = candidates[0];
    if (!rect || !top) return;
    const source = sourcePageFor(top, fallbackPage);
    if (!source?.canvas) return;
    const label = await cropCanvasToLabel(source.canvas, clampRect(rect));
    candidates[0] = {
      ...top,
      confidence: Math.max(Number(top.confidence || 0), 0.99),
      reason: "manual-harness-crop",
      label,
      cropRect: percentRectToPixels(clampRect(rect), source.canvas),
      sourceWidth: source.canvas.width,
      sourceHeight: source.canvas.height,
      variantName: "Manual harness crop",
      needsCrop: false,
      manualOverride: true
    };
  }

  function initialCropRect(candidate, canvas) {
    const crop = candidate?.cropRect;
    const sourceWidth = Number(candidate?.sourceWidth || canvas.width);
    const sourceHeight = Number(candidate?.sourceHeight || canvas.height);
    if (crop && sourceWidth > 0 && sourceHeight > 0) {
      return clampRect({
        x: Number(crop.x || 0) / sourceWidth,
        y: Number(crop.y || 0) / sourceHeight,
        width: Number(crop.width || 0) / sourceWidth,
        height: Number(crop.height || 0) / sourceHeight
      });
    }

    const suggested = window.LabelExtractorDetector?.suggestLabelRect?.(canvas, "");
    if (suggested) {
      return clampRect({
        x: suggested.x / canvas.width,
        y: suggested.y / canvas.height,
        width: suggested.width / canvas.width,
        height: suggested.height / canvas.height
      });
    }

    return { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
  }

  async function cropCanvasToLabel(canvas, rect) {
    return window.LabelExtractorCrop.cropCanvas(canvas, percentRectToPixels(rect, canvas), {
      paddingRatio: 0,
      minPadding: 0,
      leftExtraRatio: 0,
      rightExtraRatio: 0,
      topExtraRatio: 0,
      bottomExtraRatio: 0,
      replaceBottomExtraRatio: true
    });
  }

  function percentRectToPixels(rect, canvas) {
    return {
      x: Math.round(rect.x * canvas.width),
      y: Math.round(rect.y * canvas.height),
      width: Math.round(rect.width * canvas.width),
      height: Math.round(rect.height * canvas.height)
    };
  }

  function updateTopPreview(cardModel, label) {
    if (!cardModel.previewCell) return;
    cardModel.previewCell.replaceChildren();
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = label.dataUrl;
    cardModel.previewCell.append(img);
  }

  function clampRect(rect) {
    const width = clamp(Number(rect.width || 0.9), 0.03, 1);
    const height = clamp(Number(rect.height || 0.9), 0.03, 1);
    return {
      x: clamp(Number(rect.x || 0), 0, 1 - width),
      y: clamp(Number(rect.y || 0), 0, 1 - height),
      width,
      height
    };
  }

  function resizeRectFromHandle(startRect, handle, x, y) {
    let left = startRect.x;
    let top = startRect.y;
    let right = startRect.x + startRect.width;
    let bottom = startRect.y + startRect.height;
    const minSize = 0.01;

    if (handle.includes("w")) left = clamp(x, 0, right - minSize);
    if (handle.includes("e")) right = clamp(x, left + minSize, 1);
    if (handle.includes("n")) top = clamp(y, 0, bottom - minSize);
    if (handle.includes("s")) bottom = clamp(y, top + minSize, 1);

    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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

  function setSummary(cards) {
    const counts = { ok: 0, warn: 0, bad: 0, err: 0 };
    const judged = { pass: 0, fail: 0 };
    let baselineChanged = 0;
    cards.forEach((c) => { counts[c.grade.cls] = (counts[c.grade.cls] || 0) + 1; });
    cards.forEach((c) => {
      if (state.judgements[c.key]) judged[state.judgements[c.key]] += 1;
      const baseline = state.baselines[c.group]?.[c.key];
      if (baseline && !compareBaseline(baseline.signature, signatureFor(c)).ok) baselineChanged += 1;
    });
    els.summary.textContent =
      `${cards.length} case(s): ` +
      `${counts.ok} trusted / ${counts.warn} review / ${counts.bad} low / ${counts.err} error` +
      ` | judged ${judged.pass} pass / ${judged.fail} fail` +
      (baselineChanged ? ` | ${baselineChanged} baseline changed` : "");
  }

  function updateGroupbar() {
    const group = state.currentGroup || els.groupPicker.value || "";
    const count = group && state.corpusGroups.has(group) ? state.corpusGroups.get(group).length : 0;
    const locked = group && state.baselines[group] ? Object.keys(state.baselines[group]).length : 0;
    els.groupbar.textContent = group
      ? `${group}: ${count || state.currentCards.length} file(s), ${locked} locked baseline(s)`
      : "";
  }

  function corpusPath(file) {
    return (file.webkitRelativePath || file.name || "").replace(/\\/g, "/");
  }

  function groupNameForFile(file) {
    const parts = corpusPath(file).split("/").filter(Boolean);
    const skip = new Set(["labels", "label corpus", "shipping labels"]);
    let group = parts[0] || "";
    if (skip.has(group.toLowerCase()) && parts[1]) group = parts[1];
    if (!group || group.toLowerCase() === "codex build") return "";
    return group;
  }

  function signatureFor(card) {
    const top = card?.top;
    const label = top?.label;
    return {
      reason: top?.reason || "",
      confidence: round(Number(top?.confidence || 0), 3),
      width: Number(label?.width || 0),
      height: Number(label?.height || 0),
      aspect: round(Number(label?.width || 0) / Math.max(1, Number(label?.height || 0)), 3),
      needsCrop: Boolean(top?.needsCrop),
      variantName: top?.variantName || ""
    };
  }

  function compareBaseline(before, after) {
    const reasons = [];
    if (!after?.width || !after?.height) reasons.push("no label");
    if (before?.needsCrop !== after?.needsCrop) reasons.push("crop flag changed");
    if (Math.abs(Number(before?.aspect || 0) - Number(after?.aspect || 0)) > 0.08) reasons.push("aspect changed");
    if (Math.abs(Number(before?.confidence || 0) - Number(after?.confidence || 0)) > 0.18) reasons.push("confidence changed");
    if (before?.reason && after?.reason && before.reason !== after.reason) reasons.push("detector reason changed");
    return { ok: reasons.length === 0, reasons };
  }

  function round(value, places) {
    const mult = 10 ** places;
    return Math.round(value * mult) / mult;
  }

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "") || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function timestampSlug() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  // Auto-run on load.
  runFixtures();
})();
