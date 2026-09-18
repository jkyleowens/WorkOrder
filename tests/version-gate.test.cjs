const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// version-gate.js is a browser ES module in a project with no bundler, so the
// comparison is lifted out and evaluated directly rather than imported. It is
// the part worth testing: an ordering bug here either strands every user behind
// an upgrade wall or lets a build the server rejected keep running.
const source = fs.readFileSync(
  path.join(__dirname, "../web/public/version-gate.js"),
  "utf8",
);
const start = source.indexOf("const parts =");
const end = source.indexOf("function block(");
const olderThan = vm.runInNewContext(
  `${source.slice(start, end).replace("export function olderThan", "function olderThan")}\nolderThan`,
);

test("version comparison orders releases numerically, not as text", () => {
  // The case string comparison gets wrong.
  assert.equal(olderThan("0.9.0", "0.10.0"), true);
  assert.equal(olderThan("0.10.0", "0.9.0"), false);
  assert.equal(olderThan("1.2.3", "1.2.4"), true);
  assert.equal(olderThan("1.2.4", "1.2.3"), false);
});

test("an equal version is supported, and missing parts count as zero", () => {
  assert.equal(olderThan("1.2.3", "1.2.3"), false);
  assert.equal(olderThan("1.2", "1.2.0"), false);
  assert.equal(olderThan("1.2", "1.2.1"), true);
  assert.equal(olderThan("2", "1.9.9"), false);
});

test("an unparseable or absent version is treated as the oldest", () => {
  assert.equal(olderThan(undefined, "1.0.0"), true);
  assert.equal(olderThan("", "0.0.1"), true);
  assert.equal(olderThan("not-a-version", "1.0.0"), true);
  // The default floor blocks nobody.
  assert.equal(olderThan("0.1.0", "0.0.0"), false);
});
