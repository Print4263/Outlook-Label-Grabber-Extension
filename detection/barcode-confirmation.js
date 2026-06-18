(function () {
  "use strict";

  function create({
    findPage,
    findBarcodeRegions,
    unionRects,
    expandRect,
    detectionRankScore,
    contentSeparationScore,
    trace,
    screenshotPageMinAspect
  }) {
    const SCREENSHOT_PAGE_MIN_ASPECT = screenshotPageMinAspect;

    function barcodeConfig() {
      const cfg = (typeof LabelExtractorConfig !== "undefined" && LabelExtractorConfig.BARCODE) || null;
      return cfg && (cfg.ENRICH || cfg.RERANK) ? cfg : null;
    }

    async function decodeCandidate(candidate, pages) {
      const decoder = window.LabelExtractorBarcode;
      if (!decoder || !candidate) return [];
      const page = findPage(candidate.pages || pages || [], candidate.pageIndex);
      const target = candidate.sourceCanvas || page?.canvas;
      if (!target) return [];
      // Embedded labels are their own canvas (decode the whole thing); rect-backed
      // detections decode just the crop region in source-canvas pixels.
      const rect = candidate.sourceCanvas ? null : candidate.cropRect || null;
      try {
        // 1) Whole-crop decode — fast, and reads big UPS MaxiCode / 1Z Code128.
        const whole = await decoder.decode(target, rect ? { rect } : {});
        if (decoder.isCarrierLabelSignal(whole)) return whole;
        // 2) No carrier signal yet — FedEx PDF417 and USPS IMpb are small, dense,
        //    and get lost in a full-page scan. Re-try on tight, padded crops around
        //    each detected barcode region (reusing the cascade's findBarcodeRegions).
        const regional = await decodeBarcodeRegions(decoder, target, rect);
        return regional.length ? regional : whole;
      } catch (_) {
        return [];
      }
    }

    // Decode each detected barcode CLUSTER on its own tight crop at FULL source
    // resolution. The whole-crop pass downsamples (fast, fine for a 1D UPS 1Z) but
    // destroys a dense FedEx PDF417 or a wide USPS IMpb; a small region bbox stays
    // sharp AND cheap at native pixels (maxDim large = no downscale). The grid from
    // findBarcodeRegions is memoized, so this only costs the decodes themselves, and
    // only runs when the whole-crop pass found no carrier barcode.
    const REGION_FORMATS = ["Code128", "PDF417", "DataMatrix", "Code39", "ITF"];
    // [BANKAI] Bounds so the region fallback can never hang on image-heavy sheets
    // (e.g. UPS View/Print, where dense fold-rules/instructions look barcode-like):
    // cap each decode's resolution, skip clusters too big to be a real barcode, and
    // time-budget the whole loop. Normal barcode regions are well under these.
    const REGION_MAX_DIM = 2000;          // PDF417/IMpb native regions decode fine here
    const REGION_MAX_AREA_RATIO = 0.5;    // a barcode is a band/block, not half the crop
    const REGION_DECODE_BUDGET_MS = 500;  // total wall-clock for the whole fallback

    async function decodeBarcodeRegions(decoder, canvas, rect) {
      let regions = findBarcodeRegions(canvas);
      if (rect) {
        regions = regions.filter((region) => {
          const cx = region.x + region.width / 2;
          const cy = region.y + region.height / 2;
          return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
        });
      }
      if (!regions.length) return [];
      // Merge adjacent grid cells into whole-barcode clusters so one PDF417 / IMpb
      // isn't sliced down the middle. Drop clusters too large to be a barcode (dense
      // content on instruction sheets — slow to decode and never a carrier), then
      // decode the strongest few within a wall-clock budget.
      const canvasArea = Math.max(1, canvas.width * canvas.height);
      const clusters = clusterBarcodeRegions(regions)
        .filter((c) => (c.width * c.height) / canvasArea <= REGION_MAX_AREA_RATIO)
        .slice(0, 3);
      const all = [];
      const seen = new Set();
      const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
      const start = now();
      for (const cluster of clusters) {
        if (now() - start > REGION_DECODE_BUDGET_MS) break;
        const box = expandRect(cluster, canvas, 0.3); // include the quiet zone
        let results;
        try { results = await decoder.decode(canvas, { rect: box, formats: REGION_FORMATS, maxDim: REGION_MAX_DIM }); }
        catch (_) { results = []; }
        for (const r of results) { if (!seen.has(r.text)) { seen.add(r.text); all.push(r); } }
        if (decoder.isCarrierLabelSignal(all)) break;
      }
      return all;
    }

    // Connected-component merge of barcode grid cells: cells whose boxes touch (or
    // sit within a small gap) belong to the same physical barcode. Returns each
    // cluster's bounding box with the summed cell score, strongest first.
    function clusterBarcodeRegions(regions) {
      const used = new Array(regions.length).fill(false);
      const adjacent = (a, b) => {
        const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
        const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
        const tol = 0.6 * Math.min(a.width, a.height, b.width, b.height);
        return gapX <= tol && gapY <= tol;
      };
      const clusters = [];
      for (let i = 0; i < regions.length; i += 1) {
        if (used[i]) continue;
        used[i] = true;
        const members = [regions[i]];
        const stack = [i];
        while (stack.length) {
          const k = stack.pop();
          for (let j = 0; j < regions.length; j += 1) {
            if (!used[j] && adjacent(regions[k], regions[j])) { used[j] = true; stack.push(j); members.push(regions[j]); }
          }
        }
        const bbox = unionRects(members);
        bbox.score = members.reduce((sum, m) => sum + Number(m.score || 0), 0);
        clusters.push(bbox);
      }
      return clusters.sort((a, b) => b.score - a.score);
    }

    function applyBarcodeMetadata(candidate, results) {
      const decoder = window.LabelExtractorBarcode;
      const best = decoder.bestCarrierResult(results);
      candidate.barcodeFormats = results.map((r) => r.format);
      candidate.barcodeSignal = decoder.isCarrierLabelSignal(results);
      if (best) {
        if (best.carrier) candidate.carrier = best.carrier;
        if (best.trackingNumber) candidate.trackingNumber = best.trackingNumber;
        if (best.trackingUrl) candidate.trackingUrl = best.trackingUrl;
        candidate.carrierConfident = Boolean(best.carrierConfident);
        candidate.carrierValidated = Boolean(best.validated);
      }
      return best;
    }

    // [BANKAI] #3 barcode-anchored card crop. On a phone SCREENSHOT/PHOTO the detector
    // box often also catches app chrome around the label. When such a crop holds a
    // confident carrier barcode, tighten it to the label card. Gated to image pages
    // (never PDFs — clean carrier sheets already crop tight); refineCardWithinRect only
    // commits a trim that lands closer to a real 4x6, so it is a safe no-op on anything
    // it can't improve. The crop image is regenerated with a straight pixel copy (see
    // below for why, not content-aware cropPageCanvas).
    async function maybeRefineCard(candidate, pages) {
      if (!candidate || !candidate.barcodeSignal || !candidate.cropRect) return;
      const page = findPage(candidate.pages || pages, candidate.pageIndex);
      if (!page || page.type !== "png" || !page.canvas) return;
      const r = candidate.cropRect;
      let refined = window.LabelExtractorCrop.refineCardWithinRect(page.canvas, r);
      if (refined && page.canvas.height >= page.canvas.width * SCREENSHOT_PAGE_MIN_ASPECT) {
        refined = window.LabelExtractorCrop.trimImageChromeBands(page.canvas, refined, { allowAspectNeutralBottom: true });
      }
      if (!refined || (refined.x === r.x && refined.y === r.y && refined.width === r.width && refined.height === r.height)) return;
      try {
        // Crop EXACTLY to the refined card. Do NOT route through cropPageCanvas — its
        // content-aware extendThroughContent walks back outward and re-absorbs the very
        // chrome (status/URL bar) we just trimmed. The profile method already bounded
        // the card precisely, so a straight pixel copy is what we want.
        const rc = document.createElement("canvas");
        rc.width = Math.max(1, Math.round(refined.width));
        rc.height = Math.max(1, Math.round(refined.height));
        const rx = rc.getContext("2d", { willReadFrequently: true });
        rx.fillStyle = "#fff";
        rx.fillRect(0, 0, rc.width, rc.height);
        rx.drawImage(page.canvas, Math.round(refined.x), Math.round(refined.y), rc.width, rc.height, 0, 0, rc.width, rc.height);
        let label = window.LabelExtractorCrop.canvasToLabel(rc);
        label.sourceRect = { x: refined.x, y: refined.y, width: refined.width, height: refined.height };
        // Once browser chrome is proven and removed, a large quiet gap that sat
        // between the label and that chrome is surrounding page whitespace, not
        // useful 4x6 padding. Trim it without the usual aspect-improvement gate.
        if (refined.chromeTrimmed && window.LabelExtractorCrop.trimQuietImageTail) {
          label = window.LabelExtractorCrop.trimQuietImageTail(label, { requireAspectImprovement: false });
        }
        candidate.cropRect = label.sourceRect || { x: refined.x, y: refined.y, width: refined.width, height: refined.height };
        candidate.label = label;
        candidate.cardRefined = true;
        candidate.cardRefineAxis = refined.axis || "vertical";
        trace("card-refine", {
          reason: candidate.reason || "",
          carrier: candidate.carrier || "",
          axis: candidate.cardRefineAxis,
          from: [Math.round(r.width), Math.round(r.height)].join("x"),
          to: [Math.round(refined.width), Math.round(refined.height)].join("x")
        });
      } catch (_) { /* keep the original crop on any failure */ }
    }

    const VALIDATED_CONFIDENCE_MIN_DETECTOR = 0.80;
    const VALIDATED_CONFIDENCE_FLOOR = 0.90;
    const VALIDATED_CONFIDENCE_MAX_SEPARATION = 0.18;

    function maybeCalibrateValidatedConfidence(candidate) {
      if (!candidate?.carrierValidated || !candidate.barcodeSignal || !candidate.label) return;
      const confidence = Number(candidate.confidence || 0);
      if (confidence < VALIDATED_CONFIDENCE_MIN_DETECTOR || confidence >= VALIDATED_CONFIDENCE_FLOOR) return;
      if (candidate.needsCrop || (Array.isArray(candidate.warnings) && candidate.warnings.length)) return;
      const separation = typeof contentSeparationScore === "function"
        ? contentSeparationScore(candidate.label.canvas)
        : 1;
      if (separation >= VALIDATED_CONFIDENCE_MAX_SEPARATION) return;
      candidate.confidence = VALIDATED_CONFIDENCE_FLOOR;
      candidate.validatedConfidenceCalibrated = true;
      trace("validated-confidence", {
        reason: candidate.reason || "",
        carrier: candidate.carrier || "",
        from: confidence,
        to: candidate.confidence,
        separation: Number(separation.toFixed(3)),
        note: "independent check-digit validation calibrated an already-strong complete-label detection"
      });
    }

    async function confirmBarcodeSignal(ranked, pages) {
      const cfg = barcodeConfig();
      const decoder = window.LabelExtractorBarcode;
      if (!cfg || !decoder || !ranked.length) return ranked;

      const top = ranked[0];
      const topResults = await decodeCandidate(top, pages);
      if (cfg.ENRICH) applyBarcodeMetadata(top, topResults);
      const topSignal = decoder.isCarrierLabelSignal(topResults);
      trace("barcode-confirm", {
        reason: top.reason || "",
        carrier: top.carrier || "",
        carrierSignal: topSignal,
        formats: topResults.map((r) => r.format)
      });

      if (!cfg.RERANK || topSignal) {
        if (topSignal) {
          await maybeRefineCard(top, pages);
          maybeCalibrateValidatedConfidence(top);
        }
        return ranked;
      }

      // Top crop decoded no confident carrier barcode — scan near-tie candidates
      // for one that does, and promote it.
      const topScore = detectionRankScore(top);
      const scoreWindow = Number(cfg.RERANK_SCORE_WINDOW || 1.5);
      for (let i = 1; i < ranked.length && i < 4; i += 1) {
        const candidate = ranked[i];
        if (topScore - detectionRankScore(candidate) > scoreWindow) break;
        const results = await decodeCandidate(candidate, pages);
        if (cfg.ENRICH) applyBarcodeMetadata(candidate, results);
        if (decoder.isCarrierLabelSignal(results)) {
          trace("barcode-rerank", {
            promotedReason: candidate.reason,
            promotedCarrier: candidate.carrier || "",
            overReason: top.reason,
            scoreGap: Number((topScore - detectionRankScore(candidate)).toFixed(3)),
            note: "near-tie candidate with a confident carrier barcode promoted over a top crop that decoded none"
          });
          await maybeRefineCard(candidate, pages);
          maybeCalibrateValidatedConfidence(candidate);
          return [candidate, ...ranked.filter((c) => c !== candidate)];
        }
      }
      return ranked;
    }

    return { confirmBarcodeSignal };
  }

  window.LabelExtractorBarcodeConfirmation = { create };
})();
