"use strict";

const assert = require("node:assert/strict");
const RuntimeHealth = require("../app/runtime-health.js");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test("healthy runtime stays silent", async () => {
    const result = await RuntimeHealth.checkRuntimeHealth({
      checkFileAccess: async () => true,
      probeAsset: async () => true
    });
    assert.equal(result.ok, true);
    assert.equal(result.message, "");
    assert.deepEqual(result.missingAssets, []);
  });

  await test("unknown file permission does not create a false warning", async () => {
    const result = await RuntimeHealth.checkRuntimeHealth({
      checkFileAccess: async () => null,
      probeAsset: async () => true
    });
    assert.equal(result.ok, true);
    assert.equal(result.fileAccessAllowed, null);
  });

  await test("disabled file access gets one actionable message", async () => {
    const result = await RuntimeHealth.checkRuntimeHealth({
      checkFileAccess: async () => false,
      probeAsset: async () => true
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Allow access to file URLs/);
    assert.match(result.message, /reload/i);
  });

  await test("missing files are summarized by dependency group", async () => {
    const result = await RuntimeHealth.checkRuntimeHealth({
      checkFileAccess: async () => true,
      probeAsset: async (path) => !path.includes("zxing") && !path.includes("pdf.worker")
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingAssets, ["PDF reader", "barcode reader"]);
    assert.match(result.message, /reinstall/i);
  });

  await test("probe failures become a warning instead of rejecting", async () => {
    const result = await RuntimeHealth.checkRuntimeHealth({
      checkFileAccess: async () => { throw new Error("permission API failed"); },
      probeAsset: async (path) => {
        if (path.includes("shipping-label")) throw new Error("missing model");
        return true;
      }
    });
    assert.equal(result.fileAccessAllowed, null);
    assert.deepEqual(result.missingAssets, ["AI label model"]);
  });

  console.log(`\nRuntime health tests PASS ${passed}/5`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
