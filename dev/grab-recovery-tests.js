const assert = require("assert");
const GrabRecovery = require("../app/grab-recovery.js");

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function begin(now = 10000, baselineIds = [4]) {
  return GrabRecovery.beginAttempt({ id: 1, now, baselineIds });
}

function download(overrides = {}) {
  return {
    id: 9,
    filename: "C:\\Downloads\\return-label.pdf",
    startTime: new Date(10500).toISOString(),
    state: "in_progress",
    ...overrides
  };
}

test("Outlook failure enters guided recovery", () => {
  const failed = GrabRecovery.failAttempt(begin(), "No attachment found.");
  assert.equal(failed.status, "recovery");
  assert.equal(failed.reason, "outlook-failed");
});

test("accepted Outlook click waits for a Chrome download", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { now: 10100, expectedFileName: "return-label.pdf" });
  assert.equal(accepted.status, "awaiting-download");
  assert.equal(accepted.expectedFileName, "return-label.pdf");
});

test("a download present before the grab is never selected", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  assert.equal(GrabRecovery.matchesDownload(accepted, download({ id: 4 }), 11000), false);
});

test("an older customer download is never selected", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  const older = download({ startTime: new Date(1000).toISOString() });
  assert.equal(GrabRecovery.matchesDownload(accepted, older, 11000), false);
});

test("Chrome duplicate suffix still matches the expected attachment", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  assert.equal(GrabRecovery.matchesDownload(accepted, download({ filename: "C:\\Downloads\\return-label (2).pdf" }), 11000), true);
});

test("a different new file is rejected when Outlook supplied a filename", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  assert.equal(GrabRecovery.matchesDownload(accepted, download({ filename: "C:\\Downloads\\other-label.pdf" }), 11000), false);
});

test("download creation distinguishes downloading from complete", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  const active = GrabRecovery.noteDownloadCreated(accepted, download(), 11000);
  assert.equal(active.status, "downloading");
  assert.equal(active.downloadId, 9);
});

test("arrival timeout guides recovery instead of claiming success", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  const timedOut = GrabRecovery.checkTimeout(accepted, 10000 + GrabRecovery.ARRIVAL_TIMEOUT_MS);
  assert.equal(timedOut.status, "recovery");
  assert.equal(timedOut.reason, "no-download");
});

test("slow active download is not called failed before its completion timeout", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  const active = GrabRecovery.noteDownloadCreated(accepted, download(), 11000);
  assert.equal(GrabRecovery.checkTimeout(active, 11000 + GrabRecovery.COMPLETION_TIMEOUT_MS - 1).status, "downloading");
  assert.equal(GrabRecovery.checkTimeout(active, 11000 + GrabRecovery.COMPLETION_TIMEOUT_MS).reason, "download-slow");
});

test("completed Chrome event closes the attempt", () => {
  const accepted = GrabRecovery.acceptAttempt(begin(), { expectedFileName: "return-label.pdf" });
  const active = GrabRecovery.noteDownloadCreated(accepted, download(), 11000);
  const complete = GrabRecovery.noteDownloadChanged(active, { id: 9, state: { current: "complete" } }, 12000);
  assert.equal(complete.status, "complete");
});

test("interrupted Chrome download enters recovery", () => {
  const active = GrabRecovery.noteDownloadCreated(begin(), download(), 11000);
  const interrupted = GrabRecovery.noteDownloadChanged(active, {
    id: 9,
    state: { current: "interrupted" },
    error: { current: "NETWORK_FAILED" }
  }, 12000);
  assert.equal(interrupted.status, "recovery");
  assert.equal(interrupted.reason, "download-interrupted");
});

test("a late manual download can close an existing recovery prompt", () => {
  const failed = GrabRecovery.failAttempt(begin(), "Outlook did not expose Download.");
  const accepted = GrabRecovery.acceptAttempt(failed, { expectedFileName: "return-label.pdf" });
  const complete = GrabRecovery.reconcileCompletedDownloads(accepted, [download({ state: "complete" })], 12000);
  assert.equal(complete.status, "complete");
});

console.log(`\nGrab recovery tests PASS ${passed}/${passed}`);
