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

test("clock times derive duration, survive edits and reports, and validate all rows atomically", async () => {
  const w = await t.work(true);
  const input = {
    subdivision_id: w.sub.id,
    date: "2026-08-01",
    start_time: "08:30",
    end_time: "10:45",
  };
  const entry = await t.s.logTime(w.worker.id, input);
  assert.equal(Number(entry.hours), 2.25);
  assert.equal(entry.start_time, "08:30:00");
  const edited = await t.s.editTime(w.worker.id, entry.id, {
    end_time: "11:00",
  });
  assert.equal(Number(edited.hours), 2.5);
  await t.s.editTime(w.worker.id, entry.id, { note: "Keep clocks" });
  const report = await t.s.timeReport(
    w.worker.id,
    { from: input.date, to: input.date },
    w.organization.id,
  );
  assert.equal(report.entries[0].start_time, "08:30:00");
  await assert.rejects(() => t.s.logTime(w.worker.id, { ...input, hours: 7 }));
  await assert.rejects(() =>
    t.s.logTime(w.worker.id, { ...input, end_time: "08:00" }),
  );
  const count = await t.database.models.Timesheet.count();
  await assert.rejects(() =>
    t.s.logTimeBulk(w.worker.id, {
      subdivision_id: w.sub.id,
      entries: [
        { date: "2026-08-02", start_time: "09:00", end_time: "12:00" },
        { date: "2026-08-03", start_time: "25:00", end_time: "12:00" },
      ],
    }),
  );
  assert.equal(await t.database.models.Timesheet.count(), count);
  const [midnight] = await t.s.logTimeBulk(w.worker.id, {
    subdivision_id: w.sub.id,
    entries: [{ date: "2026-08-04", start_time: "22:15", end_time: "00:00" }],
  });
  assert.equal(Number(midnight.hours), 1.75);
  assert.equal(midnight.end_time, "24:00:00");
});
