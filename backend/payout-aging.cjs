const { cents, amount } = require("./money.cjs");
// A conservative FIFO attribution of recorded bank payouts to released funds.
// Never carry excess payouts forward to releases that did not yet exist.
function payoutAging(releases, payouts, country, now = new Date()) {
  const lots = releases
    .filter((r) => ["paid", "reversed"].includes(r.status))
    .map((r) => ({
      id: r.id,
      subdivision_id: r.subdivision_id,
      at: new Date(r.created_at),
      remaining: cents(r.amount),
      reversed: cents(r.amount_reversed || 0),
    }))
    .sort((a, b) => a.at - b.at || a.id - b.id);
  let unmatched = 0n;
  for (const p of payouts
    .filter((p) => p.status === "paid")
    .sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id,
    )) {
    let remaining = cents(p.amount);
    for (const lot of lots) {
      if (lot.at > new Date(p.created_at)) break;
      const used = remaining < lot.remaining ? remaining : lot.remaining;
      lot.remaining -= used;
      remaining -= used;
      if (!remaining) break;
    }
    unmatched += remaining;
  }
  let reversalAfterPayout = 0n;
  for (const lot of lots) {
    // A reversal of already-paid money is a reconciliation exception, not a
    // credit that can silently clear another scope's holding deadline.
    if (lot.reversed > lot.remaining)
      reversalAfterPayout += lot.reversed - lot.remaining;
    lot.remaining =
      lot.remaining > lot.reversed ? lot.remaining - lot.reversed : 0n;
  }
  const rows = lots
    .filter((l) => l.remaining > 0n)
    .map((lot) => {
      const deadline = new Date(lot.at);
      if (country === "US")
        deadline.setUTCFullYear(deadline.getUTCFullYear() + 2);
      else
        deadline.setUTCDate(
          deadline.getUTCDate() + (country === "TH" ? 10 : 90),
        );
      const days = Math.ceil((deadline - now) / 86400000);
      return {
        release_id: lot.id,
        subdivision_id: lot.subdivision_id,
        released_at: lot.at.toISOString(),
        remaining: amount(lot.remaining),
        deadline: deadline.toISOString(),
        days_remaining: days,
        urgency: days <= 0 ? "overdue" : days <= 30 ? "due_soon" : "scheduled",
      };
    });
  return {
    lots: rows,
    remaining: amount(lots.reduce((sum, l) => sum + l.remaining, 0n)),
    oldest_unpaid_release_at: rows[0]?.released_at || null,
    next_deadline: rows[0]?.deadline || null,
    unmatched_payouts: amount(unmatched),
    reversed_after_payout: amount(reversalAfterPayout),
    needs_reconciliation: unmatched > 0n || reversalAfterPayout > 0n,
  };
}
module.exports = { payoutAging };
