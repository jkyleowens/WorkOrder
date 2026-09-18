const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup } = require("./harness.cjs");
const { BillingService } = require("../../backend/billing.cjs");
const { FundingService } = require("../../backend/funding.cjs");
const { FileService } = require("../../backend/files.cjs");
const { TrustService } = require("../../backend/trust.cjs");
const { FieldService } = require("../../backend/field.cjs");
const t = setup();
let services;
function svc() {
  if (!services) {
    const billing = new BillingService(t.s),
      funding = new FundingService(t.s, billing),
      files = new FileService(t.s),
      trust = new TrustService(t.s, billing, funding, files),
      field = new FieldService(t.s, billing, files, trust);
    services = { field, trust, files };
  }
  return services;
}
const interval = (
  date = "2026-09-01",
  start_time = "08:00",
  end_time = "16:00",
) => ({ date, start_time, end_time, note: "Field work" });
const batch = (w, entries = [interval()]) => ({
  request_key: randomUUID(),
  subdivision_id: w.sub.id,
  user_ids: [w.worker.id],
  entries,
});
test("field time sync captures rates once, replays safely, rejects conflicts and rolls back a whole crew", async () => {
  const { field } = svc();
  const w = await t.work(true),
    other = await t.user();
  await t.s.profile(w.worker.id, { hourly_rate: 40 });
  const input = batch(w);
  const [a, b] = await Promise.all([
    field.syncTime(w.worker.id, input),
    field.syncTime(w.worker.id, input),
  ]);
  assert.deepEqual(a.ids, b.ids);
  assert.equal(
    (await t.database.models.Timesheet.findByPk(a.ids[0])).hours,
    "8.00",
  );
  await t.reject(
    () =>
      field.syncTime(w.worker.id, {
        ...input,
        entries: [interval("2026-09-02")],
      }),
    409,
  );
  await t.reject(
    () =>
      field.syncTime(
        w.worker.id,
        batch(w, [interval("2026-09-01", "15:00", "17:00")]),
      ),
    409,
  );
  await t.reject(
    () =>
      field.syncTime(w.worker.id, {
        ...batch(w, [interval("2026-09-02")]),
        user_ids: [w.worker.id, other.id],
      }),
    403,
  );
  assert.equal(
    await t.database.models.Timesheet.count({
      where: { date: "2026-09-02", user_id: w.worker.id },
    }),
    0,
  );
  await t.database.models.OrganizationMember.create({
    org_id: w.organization.id,
    user_id: other.id,
    internal_role: "member",
  });
  const crew = {
    ...batch(w, [interval("2026-09-02")]),
    user_ids: [w.worker.id, other.id],
  };
  await t.reject(() => field.syncTime(other.id, crew), 403);
  const recorded = await field.syncTime(w.worker.id, crew);
  assert.equal(recorded.ids.length, 2);
  const week = Array.from({ length: 7 }, (_, i) =>
    interval(`2026-09-${String(i + 10).padStart(2, "0")}`),
  );
  assert.equal(
    (await field.syncTime(w.worker.id, batch(w, week))).ids.length,
    7,
  );
  await t.s.subdivisionStatus(w.client.id, w.sub.id, { status: "completed" });
  assert.equal((await field.syncTime(w.worker.id, input)).replayed, true);
  await t.reject(
    () => field.syncTime(w.worker.id, batch(w, [interval("2026-09-25")])),
    409,
  );
});
test("dependency dates propagate, cycles and stale schedule writes roll back, crew only sees authorized scopes", async () => {
  const { field } = svc();
  const w = await t.work(),
    outsider = await t.user();
  const [child] = await t.s.addChild(w.worker.id, w.sub.id, {
    scopes: ["Finish work"],
  });
  await t.s.award(
    w.worker.id,
    (await t.s.submitBid(outsider.id, child.id, { amount: 200 })).id,
  );
  const plan = (
    planned_start,
    predecessor_id = null,
    expected_version = 0,
  ) => ({ planned_start, predecessor_id, expected_version, duration_days: 3 });
  await field.plan(w.client.id, w.sub.id, plan("2026-09-01"));
  let schedule = await field.plan(w.client.id, child.id, plan(null, w.sub.id));
  assert.equal(
    schedule.scopes.find((s) => s.id === child.id).effective_start,
    "2026-09-04",
  );
  schedule = await field.plan(
    w.client.id,
    w.sub.id,
    plan("2026-09-08", null, 1),
  );
  assert.equal(
    schedule.scopes.find((s) => s.id === child.id).effective_start,
    "2026-09-11",
  );
  assert.equal(schedule.project.end, "2026-09-13");
  await t.reject(
    () => field.plan(w.client.id, w.sub.id, plan("2026-09-08", child.id, 2)),
    409,
  );
  await t.reject(
    () => field.plan(w.client.id, w.sub.id, plan("2026-09-09", null, 1)),
    409,
  );
  const visible = await field.bootstrap(outsider.id);
  assert.equal(visible.scopes.length, 1);
  assert.equal(visible.scopes[0].id, child.id);
  const stranger = await t.user();
  await t.reject(() => field.schedule(stranger.id, w.p.id), 403);
});
test("photo reports are private, immutable and included in frozen dispute evidence", async () => {
  const { field, files, trust } = svc();
  const w = await t.work(),
    stranger = await t.user();
  const png = await files.upload(w.worker.id, {
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("photo"),
    ]),
    contentType: "image/png",
    filename: "progress.png",
  });
  const report = {
    report_date: "2026-09-01",
    progress: "Framing complete",
    headcount: 3,
    weather: "Clear",
    deliveries: "Lumber",
    delays: "None",
    file_ids: [png.id],
  };
  await t.reject(() => field.report(stranger.id, w.sub.id, report), 403);
  const saved = await field.report(w.worker.id, w.sub.id, report);
  assert.equal((await field.reports(w.client.id, w.sub.id))[0].id, saved.id);
  await files.download(w.client.id, png.id);
  await t.reject(() => files.download(stranger.id, png.id), 403);
  await assert.rejects(
    () =>
      field.query("UPDATE daily_reports SET progress=$1 WHERE id=$2", [
        "Changed",
        saved.id,
      ]),
    /append-only/,
  );
  const d = await trust.openDispute(w.client.id, w.sub.id, {
    reason: "Review the site report before closeout",
    amount_held: 0,
  });
  await trust.propose(w.client.id, d.id, { to_contractor: 0, to_payer: 0 });
  await trust.respond(w.worker.id, d.id, { decision: "accept" });
  const packet = await trust.packet(w.client.id, d.id);
  assert.equal(packet.frozen, true);
  assert.equal(packet.packet.daily_reports[0].id, saved.id);
  assert.equal(packet.packet.daily_reports[0].photos[0].sha256, png.sha256);
  assert.ok(packet.packet.documents.some((d) => d.kind === "agreement"));
  await field.report(w.worker.id, w.sub.id, {
    ...report,
    progress: "Later report",
  });
  assert.equal(
    (await trust.packet(w.client.id, d.id)).packet.daily_reports.length,
    1,
  );
});
test("awards create immutable signable agreements and versions retain signatures and view history", async () => {
  const { field } = svc();
  const w = await t.work(),
    stranger = await t.user();
  let docs = await field.documents(w.client.id, w.p.id, w.sub.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].kind, "agreement");
  assert.match(docs[0].body, /Accepted bid: USD 1000/);
  const first = await field.document(w.worker.id, docs[0].id);
  assert.deepEqual(first.can_sign, ["contractor"]);
  const sign = {
    party: "contractor",
    signer_name: "Contractor Signer",
    content_hash: first.content_hash,
    confirm: true,
  };
  await t.reject(() => field.document(stranger.id, first.id, sign), 403);
  await field.document(w.worker.id, first.id, sign);
  await t.reject(() => field.document(w.worker.id, first.id, sign), 409);
  const next = await field.addDocument(w.client.id, w.p.id, w.sub.id, {
    title: "Updated agreement",
    body: "Revised scope terms",
    previous_id: first.id,
  });
  assert.equal(next.version, 2);
  await t.reject(
    () => field.document(w.client.id, first.id, { ...sign, party: "payer" }),
    409,
  );
  const old = await field.document(w.client.id, first.id);
  assert.ok(old.superseded);
  assert.ok(old.events.some((e) => e.kind === "signed"));
  assert.ok(old.events.some((e) => e.kind === "viewed"));
  assert.equal(
    (await field.document(w.worker.id, next.id)).events.filter(
      (e) => e.kind === "signed",
    ).length,
    0,
  );
  const projectDoc = await field.addDocument(w.client.id, w.p.id, null, {
    title: "Site instructions",
    body: "Use the north entrance",
    kind: "scope",
  });
  assert.equal(
    (await field.documents(w.worker.id, w.p.id))[0].id,
    projectDoc.id,
  );
  await assert.rejects(
    () => field.query("DELETE FROM field_documents WHERE id=$1", [first.id]),
    /append-only/,
  );
});

test("crew can read scope instructions but cannot see contract values or sign for their organization", async () => {
  const { field, files } = svc();
  const w = await t.work(true),
    crew = await t.user();
  await t.database.models.OrganizationMember.create({
    org_id: w.organization.id,
    user_id: crew.id,
    internal_role: "member",
  });
  const agreement = (await field.documents(w.client.id, w.p.id, w.sub.id))[0];
  await t.reject(() => field.document(crew.id, agreement.id), 403);
  assert.equal((await field.documents(crew.id, w.p.id, w.sub.id)).length, 0);
  const file = await files.upload(w.worker.id, {
    buffer: Buffer.from("%PDF-1.7 financial contract"),
    contentType: "application/pdf",
    filename: "agreement.pdf",
  });
  const next = await field.addDocument(w.worker.id, w.p.id, w.sub.id, {
    title: "Attached agreement",
    body: "Agreement",
    file_id: file.id,
    previous_id: agreement.id,
  });
  await t.reject(() => files.download(crew.id, file.id), 403);
  await field.addDocument(w.worker.id, w.p.id, w.sub.id, {
    title: "Crew instructions",
    body: "Install per drawing A2",
    kind: "scope",
  });
  const visible = await field.documents(crew.id, w.p.id, w.sub.id);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].kind, "scope");
  const view = await field.document(crew.id, visible[0].id);
  assert.deepEqual(view.can_sign, []);
  assert.equal(view.can_edit, false);
});

test("clock location is stored when offered, optional when not, and validated", async () => {
  const { field } = svc();
  const w = await t.work(true);
  const at = {
    clock_latitude: 32.397_22,
    clock_longitude: -90.107_5,
    clock_accuracy_m: 12.5,
  };
  const located = await field.syncTime(
    w.worker.id,
    batch(w, [{ ...interval("2026-09-02"), ...at }]),
  );
  const row = await t.database.models.Timesheet.findByPk(located.ids[0]);
  assert.equal(Number(row.clock_latitude), at.clock_latitude);
  assert.equal(Number(row.clock_longitude), at.clock_longitude);
  assert.equal(Number(row.clock_accuracy_m), at.clock_accuracy_m);

  // Refusing location must never stop someone recording their hours.
  const without = await field.syncTime(
    w.worker.id,
    batch(w, [interval("2026-09-03")]),
  );
  const plain = await t.database.models.Timesheet.findByPk(without.ids[0]);
  assert.equal(plain.clock_latitude, null);
  assert.equal(plain.clock_longitude, null);
  assert.equal(plain.hours, "8.00");

  // A lone coordinate is not a location. Schema failures reach the client as
  // 422 through the ZodError handler in app.cjs; called directly the service
  // rejects with the ZodError itself.
  await assert.rejects(
    () =>
      field.syncTime(
        w.worker.id,
        batch(w, [{ ...interval("2026-09-04"), clock_latitude: 32.4 }]),
      ),
    /latitude and longitude/,
  );
  // Nor is a point off the globe.
  await assert.rejects(
    () =>
      field.syncTime(
        w.worker.id,
        batch(w, [
          {
            ...interval("2026-09-05"),
            clock_latitude: 99,
            clock_longitude: -90.1,
          },
        ]),
      ),
    (e) => e.name === "ZodError",
  );
});
