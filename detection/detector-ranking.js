(function () {
  "use strict";

  const LABEL_SHAPE_STRONG_DISTANCE = 0.08;
  const LABEL_SHAPE_EXACT_DISTANCE = 0.035;
  const LABEL_SHAPE_NEAR_DISTANCE = 0.15;
  const LABEL_SHAPE_EXTREME_MIN_ASPECT = 0.45;
  const LABEL_SHAPE_EXTREME_MAX_ASPECT = 2.3;

  function create(deps) {
    // Reward crops that already match a 4x6 label in either orientation and
    // demote extreme screenshot or banner shapes.
    function labelShapeRankScore(candidate) {
      const label = candidate?.label;
      const width = Number(label?.width || 0);
      const height = Number(label?.height || 0);
      if (!width || !height) return 0;
      const aspect = width / height;
      const distance = Math.min(Math.abs(aspect - 2 / 3), Math.abs(aspect - 1.5));
      if (distance <= LABEL_SHAPE_EXACT_DISTANCE) return 1.35;
      if (distance <= LABEL_SHAPE_STRONG_DISTANCE) return 0.8;
      if (distance <= LABEL_SHAPE_NEAR_DISTANCE) return 0.4;
      if (aspect < LABEL_SHAPE_EXTREME_MIN_ASPECT || aspect > LABEL_SHAPE_EXTREME_MAX_ASPECT) return -0.8;
      return 0;
    }

    function detectionRankScore(candidate) {
      const page = deps.findPage(candidate.pages || [], candidate.pageIndex);
      return Number(candidate.qualityScore || 0)
        + Number(candidate.confidence || 0)
        + deps.labelTextScore(page?.text)
        + deps.carrierTextPreferenceScore(candidate, page)
        + deps.barcodeContainmentPenalty(candidate, page)
        + labelShapeRankScore(candidate)
        + deps.orderDetailsPagePenalty(page);
    }

    function scoreBreakdown(candidate) {
      const page = deps.findPage(candidate?.pages || [], candidate?.pageIndex);
      const qualityScore = Number(candidate?.qualityScore || 0);
      const confidence = Number(candidate?.confidence || 0);
      const textScore = deps.labelTextScore(page?.text);
      const carrierPref = deps.carrierTextPreferenceScore(candidate, page);
      const barcodePenalty = deps.barcodeContainmentPenalty(candidate, page);
      const shapeScore = labelShapeRankScore(candidate);
      const orderPenalty = deps.orderDetailsPagePenalty(page);
      return {
        qualityScore,
        confidence,
        labelTextScore: textScore,
        carrierPref,
        barcodePenalty,
        shapeScore,
        orderPenalty,
        total: qualityScore + confidence + textScore + carrierPref + barcodePenalty + shapeScore + orderPenalty
      };
    }

    function compareDetections(a, b) {
      if (deps.shouldBorderOverrideEmbeddedUsps(a, b)) return -1;
      if (deps.shouldBorderOverrideEmbeddedUsps(b, a)) return 1;
      if (a?.reason === "embedded-usps-label" && b?.reason !== "embedded-usps-label") return -1;
      if (b?.reason === "embedded-usps-label" && a?.reason !== "embedded-usps-label") return 1;
      return detectionRankScore(b) - detectionRankScore(a);
    }

    return { compareDetections, detectionRankScore, scoreBreakdown, labelShapeRankScore };
  }

  window.LabelExtractorDetectorRanking = { create };
})();
