const assert = require("assert");
const PrintQueue = require("../app/print-queue.js");

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function label(name = "Label") {
  return { name, printUrl: "data:image/png;base64,AAAA" };
}

test("queue starts inactive and empty", () => {
  const queue = PrintQueue.createPrintQueue();
  assert.equal(queue.active, false);
  assert.equal(queue.count, 0);
  assert.equal(queue.maxItems, 10);
});

test("inactive queue rejects labels", () => {
  const queue = PrintQueue.createPrintQueue();
  assert.equal(queue.add(label()).reason, "inactive");
  assert.equal(queue.count, 0);
});

test("activation permits a print-ready label snapshot", () => {
  const queue = PrintQueue.createPrintQueue();
  queue.activate();
  const added = queue.add(label("Return label"));
  assert.equal(added.ok, true);
  assert.equal(added.entry.name, "Return label");
  assert.equal(queue.count, 1);
  assert.equal(queue.remaining, 9);
});

test("invalid non-data URLs are rejected", () => {
  const queue = PrintQueue.createPrintQueue();
  queue.activate();
  assert.equal(queue.add({ printUrl: "https://example.test/label.png" }).reason, "invalid-item");
});

test("configured capacity is enforced", () => {
  const queue = PrintQueue.createPrintQueue({ maxItems: 2 });
  queue.activate();
  assert.equal(queue.add(label("One")).ok, true);
  assert.equal(queue.add(label("Two")).ok, true);
  assert.equal(queue.add(label("Three")).reason, "full");
  assert.equal(queue.count, 2);
  assert.equal(queue.remaining, 0);
});

test("removing one entry preserves order of the rest", () => {
  const queue = PrintQueue.createPrintQueue();
  queue.activate();
  const first = queue.add(label("One")).entry;
  queue.add(label("Two"));
  queue.add(label("Three"));
  assert.equal(queue.remove(first.id).ok, true);
  assert.deepEqual(queue.entries().map((item) => item.name), ["Two", "Three"]);
});

test("unknown remove is harmless", () => {
  const queue = PrintQueue.createPrintQueue();
  queue.activate();
  assert.equal(queue.remove("missing").reason, "not-found");
});

test("clear empties labels but keeps queue mode active", () => {
  const queue = PrintQueue.createPrintQueue();
  queue.activate();
  queue.add(label());
  queue.clear();
  assert.equal(queue.active, true);
  assert.equal(queue.count, 0);
});

test("exit clears labels and disables queue mode", () => {
  const queue = PrintQueue.createPrintQueue();
  queue.activate();
  queue.add(label());
  queue.exit();
  assert.equal(queue.active, false);
  assert.equal(queue.count, 0);
  assert.equal(queue.add(label()).reason, "inactive");
});

test("entries returns a defensive snapshot", () => {
  const queue = PrintQueue.createPrintQueue();
  queue.activate();
  queue.add(label("Original"));
  const copy = queue.entries();
  copy[0].name = "Changed";
  copy.push(label("Injected"));
  assert.equal(queue.entries()[0].name, "Original");
  assert.equal(queue.count, 1);
});

console.log(`\nPrint queue tests PASS ${passed}/${passed}`);
