(function () {
  "use strict";

  function create({
    dedupeDetections,
    isLikelyTextInstructionPage,
    isOrderDetailsText,
    findPage,
    compareDetections,
    detectionRankScore,
    labelShapeRankScore,
    contentSeparationScore,
    trace,
    screenshotPageMinAspect
  }) {
    const SCREENSHOT_PAGE_MIN_ASPECT = screenshotPageMinAspect;

    function rankedDetections(candidates, pages) {
      const ranked = dedupeDetections(candidates)
        .filter((candidate) => !isLikelyTextInstructionPage(findPage(candidate.pages || pages, candidate.pageIndex), candidate.reason))
        .sort(compareDetections);
      return demoteOrderDetailsPages(promoteModelOverBorder(promoteDetectionOverTextGuess(preferContainingBorderCrop(ranked)), pages), pages);
    }

    // [BANKAI] Theme 1 completeness tiebreak. detectionRankScore is additive and
    // rewards nothing for completeness, so a TIGHTER border crop that drops the
    // logo/header (but keeps a slightly higher detector confidence) can edge out the
    // crop that holds the whole label. When the top crop is a border crop and a
    // near-tie border crop of the OTHER kind (dashed vs solid) on the same page
    // CONTAINS it, prefer the container — gated on the container still being a clean
    // ~4x6, so a "label + packing-slip" container (too tall, not near 4x6) can never
    // win. Measured: Attachment-1 solid contains dashed (cover 1.00), gap 0.07, solid
    // a0.63 -> promote; IMG_8289 solid gap 1.12 AND a0.48 -> left alone (correct).
    const BORDER_TIEBREAK_WINDOW = 0.5;
    const BORDER_CONTAIN_MIN_COVER = 0.92;

    function isBorderReason(reason) {
      return reason === "dashed-border" || reason === "solid-border";
    }

    // Fraction of `inner`'s area that falls inside `outer`.
    function rectCoverage(outer, inner) {
      const ix = Math.max(outer.x, inner.x);
      const iy = Math.max(outer.y, inner.y);
      const ax = Math.min(outer.x + outer.width, inner.x + inner.width);
      const ay = Math.min(outer.y + outer.height, inner.y + inner.height);
      const iw = Math.max(0, ax - ix);
      const ih = Math.max(0, ay - iy);
      const innerArea = inner.width * inner.height;
      return innerArea > 0 ? (iw * ih) / innerArea : 0;
    }

    function preferContainingBorderCrop(ranked) {
      const top = ranked[0];
      if (!top || !isBorderReason(top.reason) || !top.cropRect) return ranked;
      const topScore = detectionRankScore(top);
      for (let i = 1; i < ranked.length; i += 1) {
        const cand = ranked[i];
        if (topScore - detectionRankScore(cand) > BORDER_TIEBREAK_WINDOW) break; // sorted desc: no more near-ties
        if (!isBorderReason(cand.reason) || cand.reason === top.reason) continue;
        if (!cand.cropRect || cand.pageIndex !== top.pageIndex) continue;
        const candArea = cand.cropRect.width * cand.cropRect.height;
        const topArea = top.cropRect.width * top.cropRect.height;
        if (candArea <= topArea) continue; // the container must be the larger crop
        if (rectCoverage(cand.cropRect, top.cropRect) < BORDER_CONTAIN_MIN_COVER) continue; // and contain the top
        if (labelShapeRankScore(cand) < 0.4) continue; // and still be a clean ~4x6 (not label+slip)
        trace("border-containment", {
          promoted: cand.reason,
          over: top.reason,
          cover: Number(rectCoverage(cand.cropRect, top.cropRect).toFixed(2)),
          scoreGap: Number((topScore - detectionRankScore(cand)).toFixed(3))
        });
        return [cand, ...ranked.filter((c) => c !== cand)];
      }
      return ranked;
    }

    const ORDER_DETAILS_DEMOTE_REASONS = ["keywords", "embedded-label-page", "text-label-page"];

    function demoteOrderDetailsPages(ranked, pages) {
      if (ranked.length < 2) return ranked;
      const shouldDemote = (candidate) => ORDER_DETAILS_DEMOTE_REASONS.includes(candidate?.reason)
        && isOrderDetailsText(findPage(candidate.pages || pages, candidate.pageIndex)?.text);
      const demoted = ranked.filter(shouldDemote);
      if (!demoted.length || demoted.length === ranked.length) return ranked;
      trace("order-details-demoted", {
        demoted: demoted.map((candidate) => `${candidate.reason}@${candidate.pageIndex}`),
        note: "weak text-fallback candidates on order-details/packing-slip pages moved to the end"
      });
      return ranked.filter((candidate) => !shouldDemote(candidate)).concat(demoted);
    }

    // Text-keyword fallbacks score high on pages FULL of carrier wording — which
    // is exactly what a return-instructions page is — so a no-rect "keywords"
    // candidate can outrank the actually-detected label (its labelTextScore +
    // carrier preference outweigh the border's confidence). A text guess without
    // geometry should never beat a confident detection that has a real crop rect:
    // promote the best rect-backed border/model candidate over it.
    const TEXT_GUESS_REASONS = ["keywords", "embedded-label-page"];
    const TEXT_GUESS_MIN_BORDER_CONFIDENCE = 0.85;

    function promoteDetectionOverTextGuess(ranked) {
      const top = ranked[0];
      if (!TEXT_GUESS_REASONS.includes(top?.reason) || top?.cropRect) return ranked;
      const real = ranked.find((candidate) => candidate?.cropRect && candidate.label && (
        (MODEL_BORDER_REASONS.includes(candidate.reason)
          && Number(candidate.confidence || 0) >= TEXT_GUESS_MIN_BORDER_CONFIDENCE)
        || (candidate.reason === "trained-model"
          && Number(candidate.confidence || 0) >= MODEL_OVER_BORDER_MIN_CONFIDENCE)
      ));
      if (!real) return ranked;
      trace("detection-over-text-guess", {
        demotedReason: top.reason,
        promotedReason: real.reason,
        promotedConfidence: real.confidence,
        note: "no-rect text-keyword candidate outranked a confident rect-backed detection; detection promoted"
      });
      return [real, ...ranked.filter((candidate) => candidate !== real)];
    }

    // The border detectors (solid/dashed) lock onto the printed frame, which on
    // return-label sheets encloses the carrier's instruction block ("To complete
    // your return…", "Cut this label…") together with the label, so the crop comes
    // out bloated with text. Measured across the real corpus, whenever the trained
    // model fires CONFIDENTLY on a border-won page it boxes just the 4x6 label and
    // drops the instructions — the cleaner crop every time. So when a confident,
    // label-shaped model candidate exists on the same page, promote it over the
    // border. The confidence floor skips shaky low-confidence model boxes (those
    // keep the border crop); the aspect guard blocks a degenerate, non-label box
    // from ever winning. Borders still win on pages where the model didn't fire or
    // isn't confident.
    const MODEL_OVER_BORDER_MIN_CONFIDENCE = 0.80;
    const MODEL_OVER_BORDER_MAX_ASPECT_DISTANCE = 0.45;
    const MODEL_OVER_BORDER_KEEP_BORDER_MAX_DISTANCE = 0.06;
    const MODEL_OVER_BORDER_MIN_SHAPE_ADVANTAGE = 0.08;
    const MODEL_OVER_SEPARATED_BORDER_MIN_GAP = 0.20;
    const MODEL_OVER_SEPARATED_BORDER_MAX_MODEL_GAP = 0.10;
    const MODEL_BORDER_REASONS = ["solid-border", "dashed-border"];
    // Tall phone screenshots: a "border" whose crop is basically the whole screen
    // found the screen bezel/app chrome, not a label frame. There the model's box
    // is trusted at a lower confidence floor.
    const SCREENSHOT_BORDER_MIN_AREA_RATIO = 0.85;   // border output vs page
    const SCREENSHOT_MODEL_MIN_CONFIDENCE = 0.55;

    function promoteModelOverBorder(ranked, pages) {
      const top = ranked[0];
      if (!MODEL_BORDER_REASONS.includes(top?.reason) || !top.cropRect) return ranked;
      const model = ranked.find((candidate) => candidate?.reason === "trained-model");
      if (!model || model.pageIndex !== top.pageIndex || !model.cropRect) return ranked;
      const separatedBorderOverride = shouldPromoteCleanerModelOverSeparatedBorder(top, model);
      if (labelAspectDistance(model.cropRect) > MODEL_OVER_BORDER_MAX_ASPECT_DISTANCE
        && !(separatedBorderOverride && labelOutputAspectDistance(model) <= MODEL_OVER_BORDER_MAX_ASPECT_DISTANCE)) return ranked;
      if (shouldKeepBetterShapedBorder(top, model) && !separatedBorderOverride) return ranked;
      const confidence = Number(model.confidence || 0);
      const confident = confidence >= MODEL_OVER_BORDER_MIN_CONFIDENCE;
      if (!confident && !(confidence >= SCREENSHOT_MODEL_MIN_CONFIDENCE
        && isFullPageBorderOnTallPage(top, pages))) return ranked;
      trace("model-over-border", {
        borderReason: top.reason,
        borderRect: top.cropRect,
        modelRect: model.cropRect,
        modelConfidence: model.confidence,
        note: separatedBorderOverride
          ? "border output contains a large quiet split; equally confident complete model output promoted"
          : confident
          ? "confident, label-shaped trained-model promoted over border crop"
          : "screenshot-shaped page: whole-screen border crop demoted below accepted model box"
      });
      return [model, ...ranked.filter((candidate) => candidate !== model)];
    }

    function shouldPromoteCleanerModelOverSeparatedBorder(border, model) {
      if (typeof contentSeparationScore !== "function") return false;
      const borderConfidence = Number(border?.confidence || 0);
      const modelConfidence = Number(model?.confidence || 0);
      if (modelConfidence < MODEL_OVER_BORDER_MIN_CONFIDENCE || modelConfidence < borderConfidence) return false;
      const borderGap = contentSeparationScore(border?.label?.canvas);
      const modelGap = contentSeparationScore(model?.label?.canvas);
      return borderGap >= MODEL_OVER_SEPARATED_BORDER_MIN_GAP
        && modelGap <= MODEL_OVER_SEPARATED_BORDER_MAX_MODEL_GAP
        && borderGap - modelGap >= 0.10;
    }

    function shouldKeepBetterShapedBorder(border, model) {
      const borderDistance = labelOutputAspectDistance(border);
      const modelDistance = labelOutputAspectDistance(model);
      return borderDistance <= MODEL_OVER_BORDER_KEEP_BORDER_MAX_DISTANCE
        && modelDistance - borderDistance >= MODEL_OVER_BORDER_MIN_SHAPE_ADVANTAGE;
    }

    function labelOutputAspectDistance(candidate) {
      const label = candidate?.label;
      const width = Number(label?.width || candidate?.cropRect?.width || 0);
      const height = Number(label?.height || candidate?.cropRect?.height || 0);
      if (!width || !height) return Infinity;
      return Math.min(Math.abs(width / height - 1.5), Math.abs(width / height - 2 / 3));
    }

    function isFullPageBorderOnTallPage(candidate, pages) {
      const page = findPage(candidate.pages || pages || [], candidate.pageIndex);
      const canvas = page?.canvas;
      if (!canvas || canvas.height < canvas.width * SCREENSHOT_PAGE_MIN_ASPECT) return false;
      const out = candidate.label?.sourceRect || candidate.cropRect;
      return (out.width * out.height) / Math.max(1, canvas.width * canvas.height)
        >= SCREENSHOT_BORDER_MIN_AREA_RATIO;
    }

    // Distance from a 4x6 thermal label's aspect ratio (either orientation); 0 = exact.
    function labelAspectDistance(rect) {
      const ratio = rect.width / Math.max(1, rect.height);
      return Math.min(Math.abs(ratio - 1.5), Math.abs(ratio - 2 / 3));
    }

    return { rankedDetections, isBorderReason };
  }

  window.LabelExtractorCandidateSelection = { create };
})();
