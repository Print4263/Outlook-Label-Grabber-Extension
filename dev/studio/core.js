(function () {
  "use strict";

  // ===========================================================================
  // Label Detection Training Studio — core
  // Runs the REAL detection pipeline (heuristics + ONNX) over fixtures or a local
  // label corpus, captures the per-label trace emitted by detection/*.js, and
  // renders one card per label. Feature modules (stats, log-panel, preview, rules,
  // corrections) attach themselves to window.Studio and are invoked via hooks.
  // ===========================================================================

  // Bundled sample labels. Add filenames as you drop new samples into the folders.
  const FIXTURES = [
    "debug-ebay-images/page1_image1_Im3.png",
    "debug-ebay-images/page1_image2_Im4.png",
    "debug-ebay-images/page1_image3_Im1.png",
    "debug-ebay-images/page1_image4_Im2.png",
    "debug-online-return-images/page2_image1_Im1.png",
    "debug-online-return-images/page2_image2_Im2.png",
    "debug-pdf-labels/ups-view-print-foldhere.pdf"
  ];

  // Confidence floors mirrored from sidepanel.js so the harness grades like the app.
  const TRUSTED_CONFIDENCE = 0.90;
  const MIN_FULL_LABEL_CONFIDENCE = 0.45;

  // Schema v2 storage keys. v1 keys are migrated in once on first load.
  const STORAGE_KEYS = {
    judgements: "label-studio-judgements-v2",
    baselines: "label-studio-baselines-v2",
    manualCrops: "label-studio-manual-crops-v2",
    corrections: "label-studio-corrections-v2",
    rules: "label-studio-rules-v2"
  };
  const LEGACY_KEYS = {
    judgements: "label-harness-judgements-v1",
    baselines: "label-harness-baselines-v1",
    manualCrops: "label-harness-manual-crops-v1"
  };

  const util = {
    readJson(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key) || "") || fallback; }
      catch (_) { return fallback; }
    },
    writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
    clamp(v, min, max) { return Math.max(min, Math.min(max, v)); },
    round(value, places) { const m = 10 ** places; return Math.round(value * m) / m; },
    timestampSlug() { return new Date().toISOString().replace(/[:.]/g, "-"); },
    guessType(path) {
      if (/\.pdf$/i.test(path)) return "application/pdf";
      if (/\.png$/i.test(path)) return "image/png";
      if (/\.jpe?g$/i.test(path)) return "image/jpeg";
      if (/\.gif$/i.test(path)) return "image/gif";
      return "";
    },
    corpusPath(file) { return (file.webkitRelativePath || file.name || "").replace(/\\/g, "/"); },
    escapeHtml(text) {
      return String(text == null ? "" : text)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    },
    loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
    },
    td(text, cls) {
      const cell = document.createElement("td");
      if (cls) cell.className = cls;
      cell.textContent = text;
      return cell;
    },
    downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    downloadJson(payload, filename) {
      util.downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename);
    },
    downloadText(text, filename) {
      util.downloadBlob(new Blob([text], { type: "text/markdown" }), filename);
    }
  };

  // One-time migration: copy v1 values into v2 keys if v2 is still empty.
  function migrateLegacy() {
    for (const [name, v2key] of Object.entries(STORAGE_KEYS)) {
      const legacyKey = LEGACY_KEYS[name];
      if (!legacyKey) continue;
      if (localStorage.getItem(v2key) != null) continue;
      const legacy = localStorage.getItem(legacyKey);
      if (legacy != null) localStorage.setItem(v2key, legacy);
    }
  }
  migrateLegacy();

  const state = {
    corpusGroups: new Map(),
    currentGroup: "",
    currentCards: [],
    judgements: util.readJson(STORAGE_KEYS.judgements, {}),
    baselines: util.readJson(STORAGE_KEYS.baselines, {}),
    manualCrops: util.readJson(STORAGE_KEYS.manualCrops, {}),
    corrections: util.readJson(STORAGE_KEYS.corrections, {}),
    rules: util.readJson(STORAGE_KEYS.rules, []),
    _traceBuffer: null
  };

  const Studio = {
    FIXTURES,
    TRUSTED_CONFIDENCE,
    MIN_FULL_LABEL_CONFIDENCE,
    STORAGE_KEYS,
    util,
    state,
    els: {},
    // Hook arrays — feature modules push into these.
    cardHooks: [],        // fn(cardModel) -> augment a finished card
    toolbarHooks: [],     // fn(toolbarEl) -> add controls
    summaryHooks: [],     // fn(cards) -> react to a (re)summary
    save(name) { util.writeJson(STORAGE_KEYS[name], state[name]); },
    refreshSummary() { setSummary(state.currentCards); }
  };
  window.Studio = Studio;

  // --- Trace capture ---------------------------------------------------------
  function installTraceSink() {
    const sink = (evt) => { if (state._traceBuffer) state._traceBuffer.push(evt); };
    window.LabelExtractorDetector?.setTraceSink?.(sink);
    window.LabelExtractorModelDetector?.setTraceSink?.(sink);
  }

  // --- Pipeline (mirrors sidepanel.js runLocalDetector) ----------------------
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
    let trace = [];
    let rulesFired = [];
    let detectorOriginal = null;
    try {
      state._traceBuffer = [];
      const out = await detect(file);
      trace = state._traceBuffer || [];
      candidates = (out.candidates || []).filter(Boolean);
      page = out.page;
      // Studio-only re-ranking via the rules engine (replaces v1 preferred-candidate).
      rulesFired = Studio.rules?.applyToCandidates?.(label, candidates, { page }) || [];
      // Snapshot the detector's REAL top choice before any stored manual crop or
      // in-session edit can mutate it — this is the "before" for the fix-report.
      detectorOriginal = snapshotCandidate(candidates[0]);
      await applyStoredManualCrop(label, candidates, page);
    } catch (e) {
      error = e?.message || String(e);
    } finally {
      state._traceBuffer = null;
    }
    const ms = Math.round(performance.now() - started);
    return buildCard({ label, file, group, candidates, page, error, ms, trace, rulesFired, detectorOriginal });
  }

  // Pristine snapshot of the detector's chosen candidate (geometry + reason),
  // used by the corrections fix-report as the untouched "before".
  function snapshotCandidate(c) {
    if (!c) return null;
    return {
      reason: c.reason || "",
      confidence: Number(c.confidence || 0),
      carrier: c.carrier || "",
      variantName: c.variantName || "",
      width: Number(c.label?.width || 0),
      height: Number(c.label?.height || 0),
      cropRect: c.cropRect ? { ...c.cropRect } : null,
      sourceWidth: Number(c.sourceWidth || 0),
      sourceHeight: Number(c.sourceHeight || 0),
      needsCrop: Boolean(c.needsCrop)
    };
  }
  Studio.snapshotCandidate = snapshotCandidate;

  // --- Grading ---------------------------------------------------------------
  function grade(top) {
    if (!top || !top.label) return { cls: "err", text: "NO LABEL" };
    const conf = Number(top.confidence || 0);
    if (conf >= TRUSTED_CONFIDENCE) return { cls: "ok", text: `TRUSTED ${conf.toFixed(2)}` };
    if (conf >= MIN_FULL_LABEL_CONFIDENCE) return { cls: "warn", text: `REVIEW ${conf.toFixed(2)}` };
    return { cls: "bad", text: `LOW ${conf.toFixed(2)}` };
  }

  function scoreFor(candidate) {
    try { return Number(window.LabelExtractorDetector?.detectionRankScore?.(candidate) ?? 0); }
    catch (_) { return 0; }
  }
  Studio.scoreFor = scoreFor;
  Studio.breakdownFor = function (candidate) {
    try { return window.LabelExtractorDetector?.scoreBreakdown?.(candidate) || null; }
    catch (_) { return null; }
  };

  // --- Card rendering --------------------------------------------------------
  function buildCard({ label, file, group = "", candidates, page, error, ms, trace = [], rulesFired = [], detectorOriginal = null }) {
    const top = candidates[0];
    const g = error ? { cls: "err", text: "ERROR" } : grade(top);
    const key = label;

    const card = document.createElement("div");
    card.className = "case";
    const cardModel = { element: card, grade: g, top, candidates, group, key, ms, page, file, trace, error, rulesFired, detectorOriginal };

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
    if (top?.carrier) {
      const car = document.createElement("span");
      car.className = "pill carrier";
      car.textContent = top.carrier;
      h2.append(car);
    }
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
      runCardHooks(cardModel);
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

    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>#</th><th></th><th>reason</th><th>conf</th><th>score</th><th>size</th><th>variant / warnings</th><th>crop</th></tr></thead>";
    const tbody = document.createElement("tbody");
    if (!candidates.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="8" class="warns">No candidates produced.</td>';
      tbody.append(tr);
    }
    candidates.forEach((c, i) => {
      const tr = document.createElement("tr");
      if (i === 0) tr.className = "chosen";
      const warnText = (c.warnings || []).join(" · ");

      tr.append(util.td(String(i)));
      tr.append(candidateChoiceCell(cardModel, c, tr));
      tr.append(util.td(c.reason || "—"));
      tr.append(util.td(Number(c.confidence || 0).toFixed(3), "conf"));
      tr.append(util.td(scoreFor(c).toFixed(2), "conf"));
      tr.append(util.td(c.label ? `${c.label.width}×${c.label.height}` : "—"));

      const vtd = document.createElement("td");
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
        img.title = "Click for in-store 4×6 preview";
        Studio.preview?.bindThumb?.(img, c, cardModel);
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

    runCardHooks(cardModel);
    return cardModel;
  }

  function runCardHooks(cardModel) {
    for (const hook of Studio.cardHooks) {
      try { hook(cardModel); } catch (e) { console.warn("[studio] card hook failed", e); }
    }
  }

  function errorCard(label, message) {
    return buildCard({ label, file: { name: label }, candidates: [], page: null, error: message, ms: 0, trace: [] });
  }

  // --- Candidate prefer (ephemeral reorder; rules module handles persistence) -
  function candidateChoiceCell(cardModel, candidate, row) {
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "prefer-candidate";
    button.textContent = candidate === cardModel.top ? "Top" : "Make top";
    button.addEventListener("click", () => selectPreferredCandidate(cardModel, candidate, row));
    cell.append(button);
    return cell;
  }

  function selectPreferredCandidate(cardModel, candidate, row) {
    const rest = cardModel.candidates.filter((item) => item !== candidate);
    cardModel.candidates = [candidate, ...rest];
    cardModel.top = candidate;
    for (const tr of cardModel.element.querySelectorAll("tbody tr")) {
      tr.classList.toggle("chosen", tr === row);
      const button = tr.querySelector(".prefer-candidate");
      if (button) button.textContent = tr === row ? "Top" : "Make top";
    }
    if (candidate.label) updateTopPreview(cardModel, candidate.label);
    Studio.rules?.onManualPrefer?.(cardModel, candidate);
    setSummary(state.currentCards);
  }

  function updateTopPreview(cardModel, label) {
    if (!cardModel.previewCell) return;
    cardModel.previewCell.replaceChildren();
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = label.dataUrl;
    Studio.preview?.bindThumb?.(img, cardModel.top, cardModel);
    cardModel.previewCell.append(img);
  }
  Studio.updateTopPreview = updateTopPreview;

  // --- Judgements ------------------------------------------------------------
  function judgementControls(key) {
    const wrap = document.createElement("span");
    wrap.className = "judgement";
    wrap.append(judgementButton(key, "pass", "✓"), judgementButton(key, "fail", "✗"));
    return wrap;
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
      Studio.save("judgements");
      for (const b of btn.parentElement.querySelectorAll("button")) b.classList.remove("active");
      if (state.judgements[key] === value) btn.classList.add("active");
      setSummary(state.currentCards);
    });
    return btn;
  }
  Studio.setJudgement = function (key, value) {
    if (value) state.judgements[key] = value; else delete state.judgements[key];
    Studio.save("judgements");
  };

  // --- Baselines / regression ------------------------------------------------
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
  function signatureFor(card) {
    const top = card?.top;
    const label = top?.label;
    return {
      reason: top?.reason || "",
      confidence: util.round(Number(top?.confidence || 0), 3),
      width: Number(label?.width || 0),
      height: Number(label?.height || 0),
      aspect: util.round(Number(label?.width || 0) / Math.max(1, Number(label?.height || 0)), 3),
      needsCrop: Boolean(top?.needsCrop),
      variantName: top?.variantName || ""
    };
  }
  Studio.signatureFor = signatureFor;
  function compareBaseline(before, after) {
    const reasons = [];
    if (!after?.width || !after?.height) reasons.push("no label");
    if (before?.needsCrop !== after?.needsCrop) reasons.push("crop flag changed");
    if (Math.abs(Number(before?.aspect || 0) - Number(after?.aspect || 0)) > 0.08) reasons.push("aspect changed");
    if (Math.abs(Number(before?.confidence || 0) - Number(after?.confidence || 0)) > 0.18) reasons.push("confidence changed");
    if (before?.reason && after?.reason && before.reason !== after.reason) reasons.push("detector reason changed");
    return { ok: reasons.length === 0, reasons };
  }
  Studio.compareBaseline = compareBaseline;

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
    Studio.save("baselines");
    Studio.els.runLocked.disabled = false;
    updateGroupbar();
    setSummary(state.currentCards);
    setStatus(`Locked ${state.currentCards.length} baseline(s) for ${group}.`);
  }

  // --- Corpus loading --------------------------------------------------------
  function loadCorpus() {
    const files = Array.from(Studio.els.corpusPicker.files || [])
      .filter((file) => /\.(pdf|png|jpe?g|gif|hei[cf])$/i.test(file.name))
      .filter((file) => !util.corpusPath(file).toLowerCase().includes("/codex build/"));

    state.corpusGroups = new Map();
    for (const file of files) {
      const group = groupNameForFile(file);
      if (!group) continue;
      if (!state.corpusGroups.has(group)) state.corpusGroups.set(group, []);
      state.corpusGroups.get(group).push(file);
    }
    for (const groupFiles of state.corpusGroups.values()) {
      groupFiles.sort((a, b) => util.corpusPath(a).localeCompare(util.corpusPath(b)));
    }
    renderGroupPicker();
    state.currentGroup = Studio.els.groupPicker.value;
    updateGroupbar();
    setStatus(`Loaded ${files.length} label file(s) in ${state.corpusGroups.size} group(s).`);
  }
  function groupNameForFile(file) {
    const parts = util.corpusPath(file).split("/").filter(Boolean);
    const skip = new Set(["labels", "label corpus", "shipping labels", "samples"]);
    let group = parts[0] || "";
    if (skip.has(group.toLowerCase()) && parts[1]) group = parts[1];
    if (!group || group.toLowerCase() === "codex build") return "";
    return group;
  }
  function renderGroupPicker() {
    const groups = Array.from(state.corpusGroups.keys()).sort((a, b) => a.localeCompare(b));
    Studio.els.groupPicker.replaceChildren();
    for (const group of groups) {
      const option = document.createElement("option");
      option.value = group;
      option.textContent = `${group} (${state.corpusGroups.get(group).length})`;
      Studio.els.groupPicker.append(option);
    }
    const hasGroups = groups.length > 0;
    Studio.els.groupPicker.disabled = !hasGroups;
    Studio.els.runCorpusGroup.disabled = !hasGroups;
    Studio.els.runLocked.disabled = !Object.keys(state.baselines).length;
    Studio.els.lockGroup.disabled = true;
  }

  // --- Run drivers -----------------------------------------------------------
  async function runFixtures() {
    Studio.els.results.replaceChildren();
    setStatus("Running…");
    const cards = [];
    for (const path of FIXTURES) {
      setStatus(`Running ${path}…`);
      try {
        const blob = await (await fetch(path)).blob();
        const file = new File([blob], path.split("/").pop(), { type: blob.type || util.guessType(path) });
        const card = await runOne(path, file);
        cards.push(card);
        Studio.els.results.append(card.element);
      } catch (error) {
        const card = errorCard(path, error?.message || "could not load fixture");
        cards.push(card);
        Studio.els.results.append(card.element);
      }
    }
    setStatus("Done.");
    state.currentGroup = "Bundled fixtures";
    state.currentCards = cards;
    setSummary(cards);
  }

  async function runFiles(group, files, baselineOnly = false) {
    Studio.els.results.replaceChildren();
    setStatus(`Running ${group}...`);
    updateGroupbar();
    const cards = [];
    for (const file of files) {
      const key = util.corpusPath(file);
      if (baselineOnly && !state.baselines[group]?.[key]) continue;
      setStatus(`Running ${key}...`);
      try {
        const card = await runOne(key, file, group);
        cards.push(card);
        Studio.els.results.append(card.element);
      } catch (error) {
        const card = errorCard(key, error?.message || "could not run file");
        card.group = group;
        card.key = key;
        cards.push(card);
        Studio.els.results.append(card.element);
      }
    }
    state.currentCards = cards;
    Studio.els.lockGroup.disabled = !cards.length;
    setStatus(`Done running ${group}.`);
    setSummary(cards);
  }

  async function runSelectedGroup() {
    const group = Studio.els.groupPicker.value;
    if (!group || !state.corpusGroups.has(group)) return;
    state.currentGroup = group;
    await runFiles(group, state.corpusGroups.get(group));
  }

  async function runLockedBaselines() {
    const groups = Object.keys(state.baselines).sort((a, b) => a.localeCompare(b));
    if (!groups.length) return;
    Studio.els.results.replaceChildren();
    const allCards = [];
    for (const group of groups) {
      const files = state.corpusGroups.get(group) || [];
      if (!files.length) continue;
      setStatus(`Regression running ${group}...`);
      for (const file of files) {
        const key = util.corpusPath(file);
        if (!state.baselines[group]?.[key]) continue;
        const card = await runOne(key, file, group);
        allCards.push(card);
        Studio.els.results.append(card.element);
      }
    }
    state.currentGroup = "Locked baselines";
    state.currentCards = allCards;
    Studio.els.lockGroup.disabled = true;
    setStatus("Done running locked baselines.");
    setSummary(allCards);
    updateGroupbar();
  }

  // --- Manual crop (inline editor) ------------------------------------------
  function tweakCropButton(cardModel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "crop-tweak";
    btn.textContent = "Tweak crop";
    btn.addEventListener("click", () => openCropTweak(cardModel));
    return btn;
  }

  async function openCropTweak(cardModel, opts = {}) {
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
    const apply = mkBtn("Apply crop");
    const reset = mkBtn("Reset box");
    const full = mkBtn("Full source");
    const close = mkBtn("Close");
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
    const renderBox = () => {
      box.style.left = `${rect.x * 100}%`;
      box.style.top = `${rect.y * 100}%`;
      box.style.width = `${rect.width * 100}%`;
      box.style.height = `${rect.height * 100}%`;
    };
    renderBox();

    box.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const bounds = cropCanvas.getBoundingClientRect();
      const startX = (event.clientX - bounds.left) / bounds.width;
      const startY = (event.clientY - bounds.top) / bounds.height;
      const startRect = { ...rect };
      const handle = event.target?.dataset?.handle || "move";
      box.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const x = (moveEvent.clientX - bounds.left) / bounds.width;
        const y = (moveEvent.clientY - bounds.top) / bounds.height;
        if (handle !== "move") rect = resizeRectFromHandle(startRect, handle, x, y);
        else {
          rect.x = util.clamp(startRect.x + x - startX, 0, 1 - startRect.width);
          rect.y = util.clamp(startRect.y + y - startY, 0, 1 - startRect.height);
        }
        renderBox();
      };
      const up = (upEvent) => {
        box.releasePointerCapture(upEvent.pointerId);
        box.removeEventListener("pointermove", move);
        box.removeEventListener("pointerup", up);
      };
      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", up);
    });

    reset.addEventListener("click", () => { rect = initialCropRect(cardModel.top, source.canvas); renderBox(); });
    full.addEventListener("click", () => { rect = { x: 0, y: 0, width: 1, height: 1 }; renderBox(); });
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
      Studio.save("manualCrops");
      updateTopPreview(cardModel, label);
      status.textContent = "Manual crop applied.";
      if (typeof opts.onApply === "function") opts.onApply({ rect, label, canvas: source.canvas });
      else {
        Studio.setJudgement(cardModel.key, "pass");
        const buttons = cardModel.element.querySelectorAll(".judgement button");
        buttons.forEach((b) => b.classList.toggle("active", b.classList.contains("pass")));
      }
      setSummary(state.currentCards);
    });
  }
  Studio.openCropTweak = openCropTweak;

  function mkBtn(text) { const b = document.createElement("button"); b.type = "button"; b.textContent = text; return b; }

  function sourcePageFor(candidate, fallbackPage) {
    if (candidate?.sourceCanvas) return { pageIndex: candidate.pageIndex, canvas: candidate.sourceCanvas };
    const pages = Array.isArray(candidate?.pages) ? candidate.pages : [];
    const pageIndex = Number(candidate?.pageIndex || 0);
    return pages.find((item) => Number(item?.pageIndex || 0) === pageIndex) || pages[pageIndex] || fallbackPage;
  }
  Studio.sourcePageFor = sourcePageFor;

  async function labelSourceFor(candidate) {
    const dataUrl = candidate?.label?.dataUrl;
    if (!dataUrl) return null;
    const width = Number(candidate.label.width || 0);
    const height = Number(candidate.label.height || 0);
    if (!width || !height) return null;
    const image = await util.loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, pageIndex: candidate.pageIndex, currentLabelOnly: true };
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
        x: suggested.x / canvas.width, y: suggested.y / canvas.height,
        width: suggested.width / canvas.width, height: suggested.height / canvas.height
      });
    }
    return { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
  }

  async function cropCanvasToLabel(canvas, rect) {
    return window.LabelExtractorCrop.cropCanvas(canvas, percentRectToPixels(rect, canvas), {
      paddingRatio: 0, minPadding: 0, leftExtraRatio: 0, rightExtraRatio: 0,
      topExtraRatio: 0, bottomExtraRatio: 0, replaceBottomExtraRatio: true
    });
  }
  Studio.cropCanvasToLabel = cropCanvasToLabel;

  function percentRectToPixels(rect, canvas) {
    return {
      x: Math.round(rect.x * canvas.width), y: Math.round(rect.y * canvas.height),
      width: Math.round(rect.width * canvas.width), height: Math.round(rect.height * canvas.height)
    };
  }
  function clampRect(rect) {
    const width = util.clamp(Number(rect.width || 0.9), 0.03, 1);
    const height = util.clamp(Number(rect.height || 0.9), 0.03, 1);
    return { x: util.clamp(Number(rect.x || 0), 0, 1 - width), y: util.clamp(Number(rect.y || 0), 0, 1 - height), width, height };
  }
  function resizeRectFromHandle(startRect, handle, x, y) {
    let left = startRect.x, top = startRect.y, right = startRect.x + startRect.width, bottom = startRect.y + startRect.height;
    const minSize = 0.01;
    if (handle.includes("w")) left = util.clamp(x, 0, right - minSize);
    if (handle.includes("e")) right = util.clamp(x, left + minSize, 1);
    if (handle.includes("n")) top = util.clamp(y, 0, bottom - minSize);
    if (handle.includes("s")) bottom = util.clamp(y, top + minSize, 1);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // --- Summary / status ------------------------------------------------------
  function setStatus(text) { Studio.els.status.textContent = text; }
  Studio.setStatus = setStatus;

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
    Studio.els.summary.textContent =
      `${cards.length} case(s): ${counts.ok} trusted / ${counts.warn} review / ${counts.bad} low / ${counts.err} error` +
      ` | judged ${judged.pass} pass / ${judged.fail} fail` +
      (baselineChanged ? ` | ${baselineChanged} baseline changed` : "");
    for (const hook of Studio.summaryHooks) { try { hook(cards); } catch (e) { console.warn(e); } }
  }
  Studio.setSummary = setSummary;

  function updateGroupbar() {
    const group = state.currentGroup || Studio.els.groupPicker.value || "";
    const count = group && state.corpusGroups.has(group) ? state.corpusGroups.get(group).length : 0;
    const locked = group && state.baselines[group] ? Object.keys(state.baselines[group]).length : 0;
    Studio.els.groupbar.textContent = group
      ? `${group}: ${count || state.currentCards.length} file(s), ${locked} locked baseline(s)`
      : "";
  }
  Studio.updateGroupbar = updateGroupbar;

  // --- Export / import all studio state (portable across machines) -----------
  function exportAll() {
    const payload = {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      judgements: state.judgements,
      baselines: state.baselines,
      manualCrops: state.manualCrops,
      corrections: state.corrections,
      rules: state.rules
    };
    util.downloadJson(payload, `label-studio-state-${util.timestampSlug()}.json`);
    setStatus("Exported all studio state (judgements, baselines, crops, corrections, rules).");
  }

  async function importAll(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload.judgements) state.judgements = { ...state.judgements, ...payload.judgements };
      if (payload.manualCrops) state.manualCrops = { ...state.manualCrops, ...payload.manualCrops };
      if (payload.corrections) state.corrections = { ...state.corrections, ...payload.corrections };
      if (Array.isArray(payload.rules)) {
        const seen = new Set(state.rules.map((r) => r.id));
        for (const r of payload.rules) if (!seen.has(r.id)) state.rules.push(r);
      }
      if (payload.baselines) {
        const merged = { ...state.baselines };
        for (const [k, v] of Object.entries(payload.baselines)) merged[k] = { ...(merged[k] || {}), ...v };
        state.baselines = merged;
      }
      ["judgements", "baselines", "manualCrops", "corrections", "rules"].forEach((k) => Studio.save(k));
      Studio.els.runLocked.disabled = !Object.keys(state.baselines).length;
      setSummary(state.currentCards);
      updateGroupbar();
      setStatus(`Imported studio state from ${file.name}.`);
    } catch (error) {
      setStatus(`Import failed: ${error?.message || error}`);
    }
  }

  // --- Init ------------------------------------------------------------------
  function init() {
    const byId = (id) => document.getElementById(id);
    Object.assign(Studio.els, {
      runFixtures: byId("runFixtures"),
      corpusPicker: byId("corpusPicker"),
      groupPicker: byId("groupPicker"),
      runCorpusGroup: byId("runCorpusGroup"),
      runLocked: byId("runLocked"),
      lockGroup: byId("lockGroup"),
      filePicker: byId("filePicker"),
      exportAll: byId("exportAll"),
      importAll: byId("importAll"),
      resetCrops: byId("resetCrops"),
      status: byId("status"),
      groupbar: byId("groupbar"),
      summary: byId("summary"),
      results: byId("results"),
      toolbarExtra: byId("toolbarExtra")
    });

    installTraceSink();

    Studio.els.runFixtures.addEventListener("click", runFixtures);
    Studio.els.corpusPicker.addEventListener("change", loadCorpus);
    Studio.els.groupPicker.addEventListener("change", () => { state.currentGroup = Studio.els.groupPicker.value; updateGroupbar(); });
    Studio.els.runCorpusGroup.addEventListener("click", runSelectedGroup);
    Studio.els.runLocked.addEventListener("click", runLockedBaselines);
    Studio.els.lockGroup.addEventListener("click", lockCurrentGroup);
    Studio.els.filePicker.addEventListener("change", () => {
      const file = Studio.els.filePicker.files?.[0];
      if (file) runOne(file.name, file).then((card) => {
        Studio.els.results.prepend(card.element);
        state.currentCards = [card];
        setSummary(state.currentCards);
      });
    });
    Studio.els.exportAll?.addEventListener("click", exportAll);
    Studio.els.resetCrops?.addEventListener("click", () => {
      const n = Object.keys(state.manualCrops).length;
      if (!n) { setStatus("No stored crop edits to clear."); return; }
      if (!confirm(`Clear ${n} stored manual crop edit(s)? Your corrections and fix-report are kept. Re-run a group afterward to see the detector's raw output.`)) return;
      state.manualCrops = {};
      Studio.save("manualCrops");
      setStatus(`Cleared ${n} crop edit(s). Re-run a group to see raw detector output.`);
    });
    Studio.els.importAll?.addEventListener("change", () => {
      const file = Studio.els.importAll.files?.[0];
      if (file) importAll(file).finally(() => { Studio.els.importAll.value = ""; });
    });

    // Let feature modules add toolbar controls.
    for (const hook of Studio.toolbarHooks) {
      try { hook(Studio.els.toolbarExtra); } catch (e) { console.warn("[studio] toolbar hook failed", e); }
    }
    if (Studio.onReady) { try { Studio.onReady(); } catch (e) { console.warn(e); } }

    Studio.els.runLocked.disabled = !Object.keys(state.baselines).length;
    runFixtures();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
