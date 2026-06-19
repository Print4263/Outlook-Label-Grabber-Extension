"use strict";

const assert = require("node:assert/strict");
const Feedback = require("../app/label-feedback.js");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStorage(initial = {}, options = {}) {
  let data = clone(initial);
  return {
    async get(key) {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return { [key]: clone(data[key] || []) };
    },
    async set(update) {
      if (options.failSet) throw new Error("mock write failed");
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      data = { ...data, ...clone(update) };
    },
    snapshot() {
      return clone(data);
    }
  };
}

(async () => {
  await test("trusted label accepts validated print-ready result", () => {
    assert.equal(Feedback.isTrustedLabel({ confidence: 0.86, carrierValidated: true }, { printReady: true }), true);
  });
  await test("trusted label accepts confidence at trust floor", () => {
    assert.equal(Feedback.isTrustedLabel({ confidence: 0.90 }, { printReady: true }), true);
  });
  await test("trusted label rejects unvalidated result below trust floor", () => {
    assert.equal(Feedback.isTrustedLabel({ confidence: 0.899 }, { printReady: true }), false);
  });
  await test("trusted label rejects non-print-ready result", () => {
    assert.equal(Feedback.isTrustedLabel({ confidence: 0.99 }, { printReady: false }), false);
  });

  const now = Date.parse("2026-06-18T20:00:00.000Z");
  const fresh = { at: "2026-06-18T19:00:00.000Z", kind: "flagged" };
  const old = { at: "2026-05-01T19:00:00.000Z", kind: "flagged" };
  const future = { at: "2026-06-19T20:00:00.000Z", kind: "flagged" };
  await test("retention removes expired and invalid future entries", () => {
    assert.deepEqual(Feedback.pruneFailureLog([old, fresh, future], { nowMs: now }), [fresh]);
  });
  await test("retention enforces maximum entry count", () => {
    const log = [1, 2, 3].map((n) => ({ ...fresh, eventId: String(n) }));
    assert.deepEqual(Feedback.pruneFailureLog(log, { nowMs: now, maxEntries: 2 }).map((e) => e.eventId), ["2", "3"]);
  });

  const baseEntry = {
    at: "2026-06-18T20:00:00.000Z",
    kind: "expand",
    fileName: "label.pdf",
    reason: "keywords",
    page: "1/2"
  };
  await test("dedupe catches the same event fingerprint inside 60 seconds", () => {
    const next = { ...baseEntry, at: "2026-06-18T20:00:45.000Z" };
    assert.equal(Feedback.isDuplicateFailure([baseEntry], next), true);
  });
  await test("dedupe permits the same event after the time window", () => {
    const next = { ...baseEntry, at: "2026-06-18T20:01:01.000Z" };
    assert.equal(Feedback.isDuplicateFailure([baseEntry], next), false);
  });
  await test("dedupe permits a different correction kind", () => {
    assert.equal(Feedback.isDuplicateFailure([baseEntry], { ...baseEntry, kind: "manual-crop" }), false);
  });

  await test("failure entries retain private locator fields locally", () => {
    const entry = Feedback.createFailureEntry({
      kind: "flagged",
      label: { width: 400, height: 600, confidence: 0.88, localReason: "keywords", sourcePage: 1, pageCount: 2 },
      fileName: "customer.pdf",
      sender: { email: "customer@example.com" },
      at: baseEntry.at,
      eventId: "evt-1"
    });
    assert.equal(entry.sender, "customer@example.com");
    assert.equal(entry.fileName, "customer.pdf");
    assert.equal(entry.aspect, 0.667);
  });
  await test("safe CSV excludes sender and filename", () => {
    const csv = Feedback.formatFailureLogCsv([{ ...baseEntry, sender: "private@example.com", fileName: "private.pdf" }]);
    assert.equal(csv.includes("sender"), false);
    assert.equal(csv.includes("private@example.com"), false);
    assert.equal(csv.includes("private.pdf"), false);
  });
  await test("private CSV includes sender and filename", () => {
    const csv = Feedback.formatFailureLogCsv([{ ...baseEntry, sender: "private@example.com", fileName: "private.pdf" }], { includePrivate: true });
    assert.match(csv, /sender,file/);
    assert.match(csv, /private@example\.com/);
    assert.match(csv, /private\.pdf/);
  });
  await test("CSV neutralizes spreadsheet formulas", () => {
    const csv = Feedback.formatFailureLogCsv([{ ...baseEntry, reason: "=HYPERLINK(\"bad\")" }]);
    assert.match(csv, /'=/);
  });
  await test("oldest date is computed instead of trusting array order", () => {
    assert.equal(Feedback.oldestFailureDate([
      { at: "2026-06-18T00:00:00.000Z" },
      { at: "2026-06-15T00:00:00.000Z" },
      { at: "2026-06-17T00:00:00.000Z" }
    ]), "2026-06-15");
  });

  await test("serialized concurrent writes preserve both events", async () => {
    const storage = createStorage({}, { delayMs: 5 });
    let id = 0;
    const store = Feedback.createFailureLogStore({
      storage,
      now: () => now,
      createEventId: () => `evt-${++id}`
    });
    await Promise.all([
      store.record("expand", { localReason: "keywords" }, "a.pdf"),
      store.record("manual-crop", { localReason: "keywords" }, "a.pdf")
    ]);
    assert.equal(storage.snapshot().labelFailureLog.length, 2);
  });
  await test("store dedupes a repeated event", async () => {
    const storage = createStorage();
    const store = Feedback.createFailureLogStore({ storage, now: () => now });
    const first = await store.record("expand", { localReason: "keywords" }, "a.pdf");
    const second = await store.record("expand", { localReason: "keywords" }, "a.pdf");
    assert.equal(first.recorded, true);
    assert.equal(second.duplicate, true);
    assert.equal(storage.snapshot().labelFailureLog.length, 1);
  });
  await test("store write failures reject to the caller", async () => {
    const store = Feedback.createFailureLogStore({ storage: createStorage({}, { failSet: true }), now: () => now });
    await assert.rejects(store.record("flagged", { localReason: "keywords" }, "a.pdf"), /mock write failed/);
  });
  await test("clear waits behind writes and leaves an empty log", async () => {
    const storage = createStorage({}, { delayMs: 5 });
    const store = Feedback.createFailureLogStore({ storage, now: () => now });
    const write = store.record("flagged", { localReason: "keywords" }, "a.pdf");
    const clear = store.clear();
    const [, cleared] = await Promise.all([write, clear]);
    assert.equal(cleared.count, 1);
    assert.deepEqual(storage.snapshot().labelFailureLog, []);
  });

  console.log(`\nLabel feedback tests PASS ${passed}/${passed}`);
})().catch((error) => {
  console.error("Label feedback tests FAIL", error);
  process.exitCode = 1;
});
