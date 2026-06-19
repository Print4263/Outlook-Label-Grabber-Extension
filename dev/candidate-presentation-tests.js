"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let carrierGuessCalls = 0;
const context = {
  console,
  state: {
    file: { name: "sample.pdf", type: "application/pdf" },
    cachedPages: [
      { pageIndex: 0, canvas: {} },
      { pageIndex: 1, canvas: {} }
    ]
  },
  window: {
    LabelExtractorCarrier: {
      guessCarrier(text, options = {}) {
        carrierGuessCalls += 1;
        return options.includeGenericNumbers && /\b\d{12}\b/.test(String(text || "")) ? "FedEx" : "";
      },
      isUpsText() { return false; }
    }
  },
  LOCAL_DETECTOR_REASONS: new Set(),
  MIN_FULL_LABEL_CONFIDENCE: 0.45,
  MIN_CROP_VARIANT_CONFIDENCE: 0.35,
  FALLBACK_MIN_CONFIDENCE: 0.1,
  FALLBACK_PAGE_LIMIT: 6,
  FALLBACK_WARNING: "Fallback result; crop/rotate before printing.",
  FALLBACK_CONTENT_PADDING_RATIO: 0.14,
  FALLBACK_CENTER_SCALE: 0.88
};
vm.createContext(context);
const detectSource = fs.readFileSync(path.join(__dirname, "..", "app", "detect.js"), "utf8");
vm.runInContext(detectSource, context, { filename: "app/detect.js" });

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test("missing-page fallback cannot evict a validated carrier candidate", async () => {
    const tracked = {
      variantName: "Validated USPS label",
      sourcePage: 1,
      pageCount: 2,
      width: 1226,
      height: 842,
      localReason: "trained-model",
      confidence: 0.90,
      carrier: "USPS",
      carrierValidated: true,
      carrierConfident: true,
      trackingNumber: "test-tracking"
    };
    const candidates = [
      { variantName: "Dashed", sourcePage: 1, pageCount: 2, width: 1214, height: 830, localReason: "dashed-border", confidence: 0.97 },
      { variantName: "Keywords", sourcePage: 1, pageCount: 2, width: 1226, height: 842, localReason: "keywords", confidence: 0.92 },
      { variantName: "Solid", sourcePage: 1, pageCount: 2, width: 1116, height: 842, localReason: "solid-border", confidence: 0.92 },
      tracked
    ];
    const packingSlip = {
      variantName: "Packing slip page - review only",
      sourcePage: 2,
      pageCount: 2,
      width: 712,
      height: 1572,
      localReason: "file-page-fallback",
      confidence: 0.32,
      needsCrop: true
    };
    context.cachedFilePageFallbackLabels = async () => [packingSlip];

    const output = await context.addMissingPageCropOptions(candidates, candidates);
    assert.equal(output.length, 4);
    assert.deepEqual(Array.from(output, (label) => label.variantName), candidates.map((label) => label.variantName));
    assert.equal(output.includes(tracked), true);
    assert.equal(output.includes(packingSlip), false);
  });

  await test("fallback remains available when no detector candidate exists", async () => {
    const fallback = {
      variantName: "Packing slip page - review only",
      sourcePage: 2,
      pageCount: 2,
      width: 700,
      height: 1500,
      localReason: "file-page-fallback",
      confidence: 0.32
    };
    context.cachedFilePageFallbackLabels = async () => [fallback];
    const output = await context.addMissingPageCropOptions([], []);
    assert.equal(output.length, 1);
    assert.equal(output[0].variantName, fallback.variantName);
  });

  await test("packing-slip fallback does not infer FedEx from a generic number", () => {
    carrierGuessCalls = 0;
    const carrier = context.fileFallbackCarrier({
      type: "pdf",
      text: "PACKING SLIP ITEM# 123456789012"
    });
    assert.equal(carrier, "PDF");
    assert.equal(carrierGuessCalls, 0);
  });

  await test("non-packing fallback keeps the existing generic-number behavior", () => {
    carrierGuessCalls = 0;
    const carrier = context.fileFallbackCarrier({ type: "pdf", text: "123456789012" });
    assert.equal(carrier, "FedEx");
    assert.equal(carrierGuessCalls, 1);
  });

  await test("dashed-border candidate has an honest variant name", () => {
    assert.equal(
      context.localVariantName({ reason: "dashed-border", pageIndex: 0 }),
      "Dashed border label page 1"
    );
  });

  console.log(`\nCandidate presentation tests PASS ${passed}/${passed}`);
})().catch((error) => {
  console.error("Candidate presentation tests FAIL", error);
  process.exitCode = 1;
});
