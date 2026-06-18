(function () {
  "use strict";

  // ===========================================================================
  // Page-text cues — pure PDF/page text-layer classification helpers.
  // Extracted verbatim from label-detector.js (behaviour-neutral). Pure: text in
  // → boolean/number out. No pixel/canvas/barcode access. The only runtime
  // dependency is window.LabelExtractorCarrier (loaded earlier). Detectors and
  // ranking/selection consume these via window.LabelExtractorPageText.
  // ===========================================================================

  const ORDER_DETAILS_PAGE_PATTERN = new RegExp([
    "PACKING SLIP PUT THIS IN THE BOX",
    "PACKING SLIP",
    "PACKING LIST",
    "QTY\\s+SKU",
    "ITEM DESCRIPTIONS\\s+QUANTITY",
    "AMAZON RETURN ID:",
    "RETURN ORDER NUMBER:",
    "ORDER SUMMARY",
    // Invoice / order-summary wording: any one of these alone could appear in
    // marketing footers, so pair the looser ones with a second signal.
    "\\bINVOICE\\b[\\s\\S]{0,400}(SUBTOTAL|TOTAL DUE|BILL TO)",
    "SUBTOTAL[\\s\\S]{0,200}(SHIPPING & HANDLING|GRAND TOTAL|ORDER TOTAL)",
    "PAYMENT METHOD[\\s\\S]{0,300}(SUBTOTAL|ORDER TOTAL)",
    "BILLING ADDRESS[\\s\\S]{0,300}(SUBTOTAL|ORDER TOTAL|PAYMENT)"
  ].join("|"));
  function isOrderDetailsText(text) {
    return ORDER_DETAILS_PAGE_PATTERN.test(String(text || "").toUpperCase());
  }

  const FASHION_NOVA_PATTERN = /\bFASHION\s*NOVA\b/i;
  const FASHION_NOVA_COMPACT_PATTERNS = [
    /FASHI[O0]NN[O0]VA/,
    /FASHI[O0]N[O0]VA/,
    /FASHI[O0][O0]VA/
  ];

  const LABEL_CARRIER_PAGE_PATTERN = /CUT THIS LABEL|PLACE THIS LABEL|AFFIX THIS LABEL|ATTACH THIS LABEL/;

  function labelTextScore(text) {
    const value = String(text || "").toUpperCase();
    let score = 0;
    if (/USPS|POSTAL SERVICE|GROUND ADVANTAGE|PRIORITY MAIL/.test(value)) score += 1.2;
    if (/RETURN MAILING LABEL|MAILING LABEL|RETURN LABEL/.test(value)) score += 1;
    if (/TRACKING|SHIP TO|SHIP FROM/.test(value)) score += 0.6;
    // "Cut this label…" / "Place this label on the outside…" — the page is
    // announcing it CARRIES the label. Multi-page return packets pair one such
    // page with instruction pages whose hallucinated border boxes otherwise
    // outrank the real label page (its dashed candidate eats the UPS-text
    // demotion; the instruction page eats nothing).
    if (LABEL_CARRIER_PAGE_PATTERN.test(value)) score += 1;
    return score;
  }

  function declaresLabelPage(page) {
    return LABEL_CARRIER_PAGE_PATTERN.test(String(page?.text || "").toUpperCase());
  }

  function instructionTextScore(text) {
    const value = String(text || "").toUpperCase();
    let score = 0;
    if (/ADDITIONAL INSTRUCTIONS|RETURN REQUIREMENTS|IMPORTANT NOTE|EXCHANGES/.test(value)) score += 1;
    if (/CONTACT US|APOLOGIZE|MERCHANDISE|REFUND|ELIGIBLE/.test(value)) score += 0.5;
    return score;
  }

  function isLikelyTextInstructionPage(page, reason) {
    if (!page || reason === "solid-border" || reason === "trained-model" || reason === "embedded-label-page") return false;
    return instructionTextScore(page.text) >= 1 && !hasStrongLabelCue(page.text);
  }

  function hasStrongLabelCue(text) {
    const value = String(text || "").toUpperCase();
    return /RETURN MAILING LABEL|USPS TRACKING|UPS TRACKING|FEDEX TRACKING|GROUND ADVANTAGE|SHIP TO/.test(value);
  }

  function isUpsLabelText(text) {
    return Boolean(window.LabelExtractorCarrier?.isUpsText(text));
  }

  function isReturnMailingLabelPage(text) {
    return /RETURN MAILING LABEL/.test(text) && /CUT THIS LABEL|AFFIX|OUTSIDE OF THE RETURN PACKAGE/.test(text);
  }

  function isOnlineReturnAuthorizationSlip(text) {
    const value = String(text || "").toUpperCase();
    return value.includes("RETURN AUTHORIZATION SLIP");
  }

  function isOnlineReturnMailingLabelPage(text) {
    const value = String(text || "").toUpperCase();
    return value.includes("RETURN MAILING LABEL");
  }

  function isOnlineReturnCenterDocument(pages) {
    return pages.some((page) => isOnlineReturnAuthorizationSlip(page?.text));
  }

  function normalizeText(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  function isFashionNovaText(text) {
    const normalized = normalizeText(text);
    if (FASHION_NOVA_PATTERN.test(normalized)) return true;

    const compact = normalized
      .toUpperCase()
      .replace(/[|!1]/g, "I")
      .replace(/0/g, "O")
      .replace(/5/g, "S")
      .replace(/[^A-Z0-9]/g, "");

    return FASHION_NOVA_COMPACT_PATTERNS.some((pattern) => pattern.test(compact));
  }

  window.LabelExtractorPageText = {
    isOrderDetailsText,
    labelTextScore,
    declaresLabelPage,
    instructionTextScore,
    hasStrongLabelCue,
    isLikelyTextInstructionPage,
    isUpsLabelText,
    isReturnMailingLabelPage,
    isOnlineReturnAuthorizationSlip,
    isOnlineReturnMailingLabelPage,
    isOnlineReturnCenterDocument,
    normalizeText,
    isFashionNovaText
  };
})();
