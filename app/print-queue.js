(function initPrintQueue(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LabelExtractorPrintQueue = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPrintQueueApi() {
  "use strict";

  const DEFAULT_MAX_ITEMS = 10;
  const MAX_CONFIGURABLE_ITEMS = 50;

  function createPrintQueue(options = {}) {
    const requestedMax = Number(options.maxItems);
    const maxItems = Number.isInteger(requestedMax)
      ? Math.min(MAX_CONFIGURABLE_ITEMS, Math.max(1, requestedMax))
      : DEFAULT_MAX_ITEMS;
    let active = false;
    let nextId = 1;
    let items = [];

    function snapshot() {
      return items.map((item) => ({ ...item }));
    }

    return Object.freeze({
      get active() {
        return active;
      },
      get count() {
        return items.length;
      },
      get remaining() {
        return maxItems - items.length;
      },
      get maxItems() {
        return maxItems;
      },
      activate() {
        active = true;
        return snapshot();
      },
      exit() {
        active = false;
        items = [];
        return snapshot();
      },
      clear() {
        items = [];
        return snapshot();
      },
      add(item = {}) {
        if (!active) return { ok: false, reason: "inactive" };
        if (items.length >= maxItems) return { ok: false, reason: "full" };
        if (typeof item.printUrl !== "string" || !item.printUrl.startsWith("data:")) {
          return { ok: false, reason: "invalid-item" };
        }
        const entry = {
          ...item,
          id: `queue-${nextId++}`,
          name: String(item.name || `Label ${items.length + 1}`),
          addedAt: Number(item.addedAt || Date.now())
        };
        items.push(entry);
        return { ok: true, entry: { ...entry } };
      },
      remove(id) {
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return { ok: false, reason: "not-found" };
        const [entry] = items.splice(index, 1);
        return { ok: true, entry: { ...entry } };
      },
      entries: snapshot
    });
  }

  return {
    DEFAULT_MAX_ITEMS,
    MAX_CONFIGURABLE_ITEMS,
    createPrintQueue
  };
});
