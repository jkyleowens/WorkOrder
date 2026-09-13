const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./harness.cjs");
const t = setup();
test("bulk time saves rates and organization attribution, rolls back invalid days, and serializes competing batches", async () => {
  const w = await t.work(true);
  await t.s.profile(w.worker.id, { hourly_rate: 37 });
  const input = {
    subdivision_id: w.sub.id,
    entries: [
      { date: "2026-09-07", hours: 2 },
      { date: "2026-09-08", hours: 3 },
    ],
  };
  const saved = await t.s.logTimeBulk(w.worker.id, input);
  assert.equal(saved.length, 2);
  assert.ok(
    saved.every(
      (e) => e.org_id === w.organization.id && Number(e.hourly_rate) === 37,
    ),
  );
  await t.reject(() => t.s.logTimeBulk(w.client.id, input), 403);
  await t.reject(
    () =>
      t.s.logTimeBulk(w.worker.id, {
        ...input,
        entries: [
          { date: "2026-09-09", hours: 1 },
          { date: "2026-09-07", hours: 23 },
        ],
      }),
    409,
  );
  assert.equal(await t.database.models.Timesheet.count(), 2);
  const batch = {
    ...input,
    entries: [
      { date: "2026-09-10", hours: 8 },
      { date: "2026-09-10", hours: 8 },
    ],
  };
  const results = await Promise.allSettled([
    t.s.logTimeBulk(w.worker.id, batch),
    t.s.logTimeBulk(w.worker.id, batch),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    Number(
      await t.database.models.Timesheet.sum("hours", {
        where: { date: "2026-09-10" },
      }),
    ),
    16,
  );
});
