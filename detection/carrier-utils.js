(function () {
  "use strict";

  function upperText(text) {
    return String(text || "").toUpperCase();
  }

  function isUpsText(text) {
    const value = upperText(text);
    return /\b1Z[0-9A-Z]{16}\b/.test(value)
      || /\bUPS\b|UPS TRACKING|UPS GROUND|UPS 2ND DAY AIR|UPS NEXT DAY AIR/.test(value);
  }

  function isUspsText(text) {
    const value = upperText(text);
    return /\b(9\d{21,}|92\d{20,})\b/.test(value)
      || /USPS|POSTAL SERVICE|PRIORITY MAIL|GROUND ADVANTAGE/.test(value);
  }

  function isFedExText(text, options = {}) {
    const value = upperText(text);
    return /FEDEX|FEDERAL EXPRESS/.test(value)
      || (options.includeGenericNumbers && /\b(\d{12}|\d{15}|\d{20})\b/.test(value));
  }

  function isDhlText(text) {
    return /DHL|EXPRESS WORLDWIDE/.test(upperText(text));
  }

  function guessCarrier(text, options = {}) {
    const value = upperText(text);
    if (!value) return options.fallback || "";
    if (isUpsText(value)) return "UPS";
    if (isUspsText(value)) return "USPS";
    if (isFedExText(value, options)) return "FedEx";
    if (isDhlText(value)) return "DHL";

    if (options.includeMarketplaces) {
      if (/AMAZON|RETURN MAILING LABEL/.test(value)) return "Amazon";
      if (/SHIPSTATION/.test(value)) return "ShipStation";
      if (/PIRATE SHIP/.test(value)) return "Pirate Ship";
      if (/EBAY/.test(value)) return "eBay";
      if (/ETSY/.test(value)) return "Etsy";
    }

    return options.fallback || "";
  }

  window.LabelExtractorCarrier = {
    upperText,
    guessCarrier,
    isUpsText,
    isUspsText,
    isFedExText,
    isDhlText
  };
})();
