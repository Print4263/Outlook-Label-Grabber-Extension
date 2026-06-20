const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app", "print.js"), "utf8");
const context = {
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
};
vm.createContext(context);
vm.runInContext(source, context);

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const urls = [
  "data:image/png;base64,ONE",
  "data:image/png;base64,TWO",
  "data:image/png;base64,THREE"
];

test("single-label print document keeps one 4x6 page", () => {
  const html = context.makePrintHtml(urls[0]);
  assert.match(html, /@page \{ size: 4in 6in; margin: 0; \}/);
  assert.match(html, /<img id="label"/);
  assert.doesNotMatch(html, /print-summary/);
});

test("queue print document contains every label in order", () => {
  const html = context.makeQueuePrintHtml(urls);
  assert.equal((html.match(/data-print-label/g) || []).length, 3);
  assert.ok(html.indexOf("base64,ONE") < html.indexOf("base64,TWO"));
  assert.ok(html.indexOf("base64,TWO") < html.indexOf("base64,THREE"));
});

test("queue print document is one job with one 4x6 page per label", () => {
  const html = context.makeQueuePrintHtml(urls);
  assert.match(html, /<title>Print 3 Labels<\/title>/);
  assert.match(html, /3 labels in this print job/);
  assert.match(html, /@page \{ size: 4in 6in; margin: 0; \}/);
  assert.match(html, /page-break-after: always/);
});

test("queue print preview summary is excluded from paper", () => {
  const html = context.makeQueuePrintHtml(urls);
  assert.match(html, /@media print[\s\S]*\.print-summary \{ display: none; \}/);
});

test("multiple URLs use one combined print document", () => {
  let captured = "";
  context.printHtmlDocument = (html) => { captured = html; };
  assert.equal(context.printQueueDataUrls(urls), true);
  assert.equal((captured.match(/data-print-label/g) || []).length, 3);
});

test("empty queue refuses to open a print document", () => {
  let called = false;
  context.printHtmlDocument = () => { called = true; };
  assert.equal(context.printQueueDataUrls([]), false);
  assert.equal(called, false);
});

console.log(`\nPrint output tests PASS ${passed}/${passed}`);
