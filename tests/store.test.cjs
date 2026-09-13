const test = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../electron/store.cjs");
const workspace = () => ({
  version: 1,
  projects: [],
  inventory: [],
  employees: [],
  sessions: [],
  activity: [],
});
test("accepts a valid empty workspace", () =>
  assert.doesNotThrow(() => validate(workspace())));
test("rejects incompatible or malformed workspace data", () => {
  for (const data of [
    null,
    {},
    { ...workspace(), version: 2 },
    { ...workspace(), projects: {} },
  ])
    assert.throws(() => validate(data), /Invalid workspace/);
});
test("rejects negative and nonnumeric inventory quantities", () => {
  for (const quantity of [-1, "2", NaN])
    assert.throws(
      () => validate({ ...workspace(), inventory: [{ quantity, minimum: 0 }] }),
      /Invalid stock/,
    );
});
test("limits workspace payload size", () =>
  assert.throws(
    () => validate({ ...workspace(), notes: "a".repeat(5_000_001) }),
    /exceeds/,
  ));
