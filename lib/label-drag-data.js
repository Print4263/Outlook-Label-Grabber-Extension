(function () {
  "use strict";

  function getData(transfer, type) {
    try {
      return transfer?.getData(type) || "";
    } catch (_) {
      return "";
    }
  }

  function candidateFromDownloadUrl(value) {
    if (!value) return null;
    const parts = String(value).split(":");
    const url = parts.length >= 3 ? parts.slice(2).join(":") : String(value);
    return url ? { url, type: parts[0] || "" } : null;
  }

  function firstUriListUrl(value) {
    return String(value || "").split(/\r?\n/).find((line) => line && !line.startsWith("#")) || "";
  }

  function firstHtmlUrl(value) {
    const match = String(value || "").match(/\b(?:href|src)=["']([^"']+)["']/i);
    return match ? match[1] : "";
  }

  function candidateFromTransfer(transfer) {
    if (!transfer) return null;

    const download = candidateFromDownloadUrl(getData(transfer, "DownloadURL"));
    if (download?.url) return download;

    const uri = firstUriListUrl(getData(transfer, "text/uri-list"));
    if (uri) return { url: uri, type: "" };

    const plain = getData(transfer, "text/plain");
    if (/^(https?|blob):/i.test(plain)) return { url: plain, type: "" };

    const html = firstHtmlUrl(getData(transfer, "text/html"));
    if (html) return { url: html, type: "" };

    return null;
  }

  function firstUrlFromTransfer(transfer) {
    return candidateFromTransfer(transfer)?.url || "";
  }

  function filenameFromUrl(url, fallback = "dragged-label") {
    try {
      const parsed = new URL(url, location.href);
      const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      return name || fallback;
    } catch (_) {
      return fallback;
    }
  }

  window.LabelExtractorDragData = {
    candidateFromTransfer,
    firstUrlFromTransfer,
    filenameFromUrl
  };
})();
