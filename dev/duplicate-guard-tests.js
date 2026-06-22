const assert = require("assert");
const Guard = require("../app/duplicate-guard.js");

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const IMG_A = "data:image/png;base64,AAAAAAAAAAAAAAAA";
const IMG_B = "data:image/png;base64,BBBBBBBBBBBBBBBB";

test("tracking number drives the fingerprint when present", () => {
  const fp = Guard.fingerprintLabel({ trackingNumber: "1Z 999 AA1 01234 5678" }, IMG_A);
  assert.equal(fp.kind, "tracking");
  assert.equal(fp.key, "trk:1Z999AA1012345678");
  assert.equal(fp.tracking, "1Z999AA1012345678");
});

test("short/absent tracking falls back to an image hash", () => {
  const fp = Guard.fingerprintLabel({ trackingNumber: "12" }, IMG_A);
  assert.equal(fp.kind, "image");
  assert.ok(fp.key.startsWith("img:"));
});

test("identical print images produce identical fingerprints", () => {
  const a = Guard.fingerprintLabel({ name: "B2B label" }, IMG_A);
  const b = Guard.fingerprintLabel({ name: "B2B label (redownloaded)" }, IMG_A);
  assert.equal(a.key, b.key);
});

test("different print images produce different fingerprints", () => {
  const a = Guard.fingerprintLabel({}, IMG_A);
  const b = Guard.fingerprintLabel({}, IMG_B);
  assert.notEqual(a.key, b.key);
});

test("full-image hashing catches same-length changes between former sample points", () => {
  const first = "A".repeat(8192);
  const second = `${first.slice(0, 4095)}B${first.slice(4096)}`;
  assert.equal(first.length, second.length);
  assert.notEqual(Guard.hashString(first), Guard.hashString(second));
});

test("a freshly recorded print is detected as a duplicate", () => {
  const fp = Guard.fingerprintLabel({ trackingNumber: "9400111899223333444455" }, IMG_A);
  const history = Guard.recordPrint([], fp, { now: 1000 });
  assert.ok(Guard.findDuplicate(history, fp, { now: 2000 }));
});

test("a print outside the window is not a duplicate", () => {
  const fp = Guard.fingerprintLabel({ trackingNumber: "9400111899223333444455" }, IMG_A);
  const history = Guard.recordPrint([], fp, { now: 0 });
  const later = Guard.DEFAULT_WINDOW_MS + 1;
  assert.equal(Guard.findDuplicate(history, fp, { now: later }), null);
  assert.equal(Guard.pruneHistory(history, { now: later }).length, 0);
});

test("a different label is not flagged against history", () => {
  const first = Guard.fingerprintLabel({}, IMG_A);
  const second = Guard.fingerprintLabel({}, IMG_B);
  const history = Guard.recordPrint([], first, { now: 1000 });
  assert.equal(Guard.findDuplicate(history, second, { now: 1100 }), null);
});

test("recording the same fingerprint refreshes rather than stacks", () => {
  const fp = Guard.fingerprintLabel({ trackingNumber: "9400111899223333444455" }, IMG_A);
  let history = Guard.recordPrint([], fp, { now: 1000 });
  history = Guard.recordPrint(history, fp, { now: 5000 });
  assert.equal(history.length, 1);
  assert.equal(history[0].printedAt, 5000);
});

test("history is capped at the configured maximum", () => {
  let history = [];
  for (let i = 0; i < 60; i++) {
    history = Guard.recordPrint(history, Guard.fingerprintLabel({}, `data:image/png;base64,${"X".repeat(i + 1)}`), { now: 1000 + i, max: 5 });
  }
  assert.equal(history.length, 5);
});

test("malformed history input is tolerated", () => {
  assert.deepEqual(Guard.pruneHistory(null, { now: 1000 }), []);
  assert.deepEqual(Guard.pruneHistory([null, {}, { key: "" }], { now: 1000 }), []);
  assert.equal(Guard.findDuplicate(undefined, { key: "img:x" }, { now: 1000 }), null);
});

test("future-dated history is rejected", () => {
  const history = [{ key: "img:x", printedAt: 2000 }];
  assert.deepEqual(Guard.pruneHistory(history, { now: 1000 }), []);
});

console.log(`\nDuplicate guard tests PASS ${passed}/${passed}`);
