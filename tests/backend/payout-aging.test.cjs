const { test } = require("node:test");
const assert = require("node:assert/strict");
const { payoutAging } = require("../../backend/payout-aging.cjs");
const release = (id, amount, at, extra = {}) => ({ id, subdivision_id: id, amount, amount_reversed: 0, status: "paid", created_at: at, ...extra });
const payout = (id, amount, at, status = "paid") => ({ id, amount, created_at: at, status });
test("partial payouts preserve oldest funds, consume FIFO, and use all historical payouts", () => {
  const releases = [release(1, 100, "2024-01-01"), release(2, 100, "2024-02-01")];
  let aging = payoutAging(releases, [payout(1, 40, "2024-03-01")], "US", new Date("2025-12-15"));
  assert.equal(aging.remaining, "160.00");
  assert.equal(aging.lots[0].remaining, "60.00");
  assert.equal(aging.next_deadline, "2026-01-01T00:00:00.000Z");
  assert.equal(aging.lots[0].urgency, "due_soon");
  aging = payoutAging(releases, Array.from({ length: 25 }, (_, i) => payout(i, 5, "2024-03-01")), "US");
  assert.equal(aging.remaining, "75.00");
  assert.equal(aging.lots[0].release_id, 2);
});
test("pending and returned payouts keep deadlines; payouts never consume future releases", () => {
  const releases = [release(1, 100, "2024-02-01")];
  for (const status of ["pending", "requested", "in_transit", "failed", "canceled"]) {
    assert.equal(payoutAging(releases, [payout(1, 100, "2024-03-01", status)], "US").remaining, "100.00");
  }
  const result = payoutAging(releases, [payout(1, 100, "2024-01-01")], "US");
  assert.equal(result.remaining, "100.00");
  assert.equal(result.unmatched_payouts, "100.00");
  assert.equal(result.needs_reconciliation, true);
});
test("reversals cannot silently pay down another scope; country deadlines are calculated in UTC", () => {
  const releases = [release(1, 100, "2024-01-01", { amount_reversed: 100, status: "reversed" }), release(2, 100, "2024-02-01")];
  const result = payoutAging(releases, [payout(1, 100, "2024-01-02")], "US");
  assert.equal(result.remaining, "100.00");
  assert.equal(result.reversed_after_payout, "100.00");
  assert.equal(payoutAging([releases[1]], [], "TH").next_deadline, "2024-02-11T00:00:00.000Z");
  assert.equal(payoutAging([releases[1]], [], "GB").next_deadline, "2024-05-01T00:00:00.000Z");
});
