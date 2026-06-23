"use strict";

const assert = require("node:assert/strict");
const SmartFit = require("../app/smart-fit.js");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

(async () => {
  await test("growToAspect grows height when the rect is too wide", () => {
    const out = SmartFit.growToAspect({ x: 0, y: 0, width: 600, height: 600 }, 4 / 6);
    assert.equal(Math.round(out.width), 600);
    assert.equal(Math.round(out.height), 900); // 600 / (4/6)
    assert.equal(Math.round(out.x + out.width / 2), 300); // centered
  });
  await test("growToAspect grows width when the rect is too tall", () => {
    const out = SmartFit.growToAspect({ x: 0, y: 0, width: 200, height: 900 }, 4 / 6);
    assert.equal(Math.round(out.height), 900);
    assert.equal(Math.round(out.width), 600); // 900 * (4/6)
  });

  await test("smartFit returns null without source dimensions or base", () => {
    assert.equal(SmartFit.smartFit4x6Rect({ baseRect: { x: 0, y: 0, width: 10, height: 10 } }), null);
    assert.equal(SmartFit.smartFit4x6Rect({ sourceWidth: 100, sourceHeight: 100 }), null);
  });

  await test("horizontal barcode anchors a 4x6 that excludes a side slip", () => {
    // Label barcode spans the left ~60% (a packing slip sits on the right).
    const rect = SmartFit.smartFit4x6Rect({
      sourceWidth: 1000,
      sourceHeight: 1500,
      baseRect: { x: 0, y: 0, width: 1000, height: 1500 },
      barcodeRect: { x: 100, y: 1100, width: 600, height: 120 }
    });
    // width = 600 / 0.9 = 667; height = 667 / (4/6) = 1000.
    assert.equal(rect.width, 667);
    assert.equal(rect.height, 1000);
    // centered on the barcode center (x=400), so the right-side slip (x>734) is left out.
    assert.equal(rect.x, 67);
    assert.ok(rect.x + rect.width < 800, "fit excludes the right-side slip region");
    // bottom sits just below the barcode (1220 + 1000*0.06 = 1280), top = 280.
    assert.equal(rect.y, 280);
  });

  await test("the barcode stays fully inside the fitted rectangle", () => {
    const barcode = { x: 200, y: 1000, width: 600, height: 100 };
    const rect = SmartFit.smartFit4x6Rect({
      sourceWidth: 1000,
      sourceHeight: 1500,
      baseRect: { x: 0, y: 0, width: 1000, height: 1500 },
      barcodeRect: barcode
    });
    assert.ok(rect.x <= barcode.x, "left contains barcode");
    assert.ok(rect.x + rect.width >= barcode.x + barcode.width, "right contains barcode");
    assert.ok(rect.y <= barcode.y, "top above barcode");
    assert.ok(rect.y + rect.height >= barcode.y + barcode.height, "bottom below barcode");
  });

  await test("a vertical barcode builds a landscape 4x6 anchored on it (sideways label)", () => {
    const barcode = { x: 900, y: 600, width: 120, height: 700 }; // vertical bars
    const rect = SmartFit.smartFit4x6Rect({
      sourceWidth: 2000,
      sourceHeight: 2000,
      baseRect: { x: 0, y: 0, width: 2000, height: 2000 },
      barcodeRect: barcode
    });
    // labelShort = 700/0.9 = 778 (the 4in side, now vertical); labelLong = 778/(4/6) = 1167.
    assert.equal(rect.height, 778);
    assert.equal(rect.width, 1167);
    assert.ok(rect.width > rect.height, "sideways label fits a landscape box (orientation pass rotates it)");
    assert.ok(rect.x <= barcode.x && rect.x + rect.width >= barcode.x + barcode.width, "contains barcode horizontally");
    assert.ok(rect.y <= barcode.y && rect.y + rect.height >= barcode.y + barcode.height, "contains barcode vertically");
  });

  await test("no barcode falls back to a 4x6 around the content box", () => {
    const rect = SmartFit.smartFit4x6Rect({
      sourceWidth: 1000,
      sourceHeight: 1500,
      baseRect: { x: 0, y: 0, width: 1000, height: 1500 },
      contentRect: { x: 300, y: 300, width: 300, height: 900 } // centered, too tall -> widen to 600
    });
    assert.equal(rect.height, 900);
    assert.equal(rect.width, 600);
  });

  await test("the fit is clamped to the source bounds", () => {
    const rect = SmartFit.smartFit4x6Rect({
      sourceWidth: 800,
      sourceHeight: 1200,
      baseRect: { x: 0, y: 0, width: 800, height: 1200 },
      barcodeRect: { x: 50, y: 1150, width: 700, height: 80 } // tall fit will overflow bottom/top
    });
    assert.ok(rect.x >= 0 && rect.y >= 0, "origin within source");
    assert.ok(rect.x + rect.width <= 800, "right within source");
    assert.ok(rect.y + rect.height <= 1200, "bottom within source");
  });

  await test("rotation chooser leaves it as-is when no orientation has a confident band", () => {
    const turns = SmartFit.chooseRotationByBand([
      { turns: 0, mass: 100, centroidRatio: 0.6 },
      { turns: 1, mass: 50, centroidRatio: 0.6 },
      { turns: 3, mass: 80, centroidRatio: 0.6 }
    ]);
    assert.equal(turns, 0);
  });
  await test("rotation chooser picks the upright orientation (strong band, lower half)", () => {
    const turns = SmartFit.chooseRotationByBand([
      { turns: 0, mass: 900, centroidRatio: 0.20 }, // strong but band in top half (upside down)
      { turns: 1, mass: 800, centroidRatio: 0.70 }, // strong AND lower half -> upright
      { turns: 3, mass: 200, centroidRatio: 0.70 }
    ]);
    assert.equal(turns, 1);
  });
  await test("rotation chooser falls back to max mass when none read upright", () => {
    const turns = SmartFit.chooseRotationByBand([
      { turns: 0, mass: 700, centroidRatio: 0.10 },
      { turns: 3, mass: 1200, centroidRatio: 0.20 } // strongest, still top half (180 flip left to autoOrient)
    ]);
    assert.equal(turns, 3);
  });
  await test("rotation chooser prefers the strongest among upright candidates", () => {
    const turns = SmartFit.chooseRotationByBand([
      { turns: 1, mass: 650, centroidRatio: 0.55 },
      { turns: 3, mass: 1500, centroidRatio: 0.55 }
    ]);
    assert.equal(turns, 3);
  });

  console.log(`\nSmart fit tests PASS ${passed}/${passed}`);
})().catch((error) => {
  console.error("Smart fit tests FAIL", error);
  process.exitCode = 1;
});
