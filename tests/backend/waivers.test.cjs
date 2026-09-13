const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup } = require("./harness.cjs");
const { BillingService, fingerprint } = require("../../backend/billing.cjs");
const t = setup();
const billing = () => new BillingService(t.s);
async function application(w, scope, contractor, from, to, extra = {}) {
  const data = {
    from,
    to,
    stored_materials: 0,
    retainage_percent: 5,
    ...extra,
  };
  const snapshot = await billing().preview(contractor.id, scope.id, data);
  return billing().submitApplication(contractor.id, scope.id, {
    ...data,
    expected: fingerprint(snapshot),
  });
}
const waiversFor = (a) =>
  t.database.models.LienWaiver.findAll({
    where: { application_id: a.id },
    order: [["id", "ASC"]],
  });
const sign = { signer_name: "Tobias Reyes", signer_title: "Owner", confirm: true };
test("submission requests a conditional waiver that only the claimant signs, and signatures are immutable", async () => {
  const w = await t.work(),
    stranger = await t.user();
  await t.s.profile(w.worker.id, { hourly_rate: 100 });
  await t.s.logTime(w.worker.id, { subdivision_id: w.sub.id, hours: 1, date: "2026-01-05" });
  const a = await application(w, w.sub, w.worker, "2026-01-01", "2026-01-31");
  const [conditional] = await waiversFor(a);
  assert.equal(conditional.kind, "conditional_progress");
  assert.equal(conditional.status, "requested");
  assert.equal(conditional.amount, "95.00");
  assert.equal(conditional.through_date, "2026-01-31");
  assert.equal(conditional.claimant_user_id, w.worker.id);
  assert.equal(conditional.payer_user_id, w.client.id);
  assert.match(conditional.snapshot.text[0], /Upon receipt/);
  assert.match(conditional.snapshot.text.at(-1), /not a jurisdiction-specific statutory form/);
  const notices = await t.database.models.Notification.findAll({
    where: { user_id: w.worker.id, title: "Lien waiver ready to sign" },
  });
  assert.equal(notices.length, 1);
  await t.reject(() => billing().waivers.sign(w.client.id, conditional.id, sign), 403);
  await t.reject(() => billing().waivers.get(stranger.id, conditional.id), 403);
  await assert.rejects(
    () => billing().waivers.sign(w.worker.id, conditional.id, { ...sign, confirm: false }),
    { name: "ZodError" },
  );
  const signed = await billing().waivers.sign(w.worker.id, conditional.id, {
    ...sign,
    exceptions: "Disputed change order CO-0002",
  });
  assert.equal(signed.status, "signed");
  assert.match(signed.content_hash, /^[0-9a-f]{64}$/);
  await t.reject(() => billing().waivers.sign(w.worker.id, conditional.id, sign), 409);
  await assert.rejects(
    () =>
      t.database.models.LienWaiver.update(
        { exceptions: "" },
        { where: { id: conditional.id } },
      ),
    /immutable/,
  );
  // Rejecting the application keeps the signed conditional waiver on record.
  await billing().decideApplication(w.client.id, a.id, { status: "rejected", note: "Hold" });
  assert.equal((await waiversFor(a))[0].status, "signed");
});
test("withdrawn applications void unsigned waivers; full external payment requests an unconditional waiver; reversals void it", async () => {
  const w = await t.work();
  await t.s.profile(w.worker.id, { hourly_rate: 100 });
  await t.s.logTime(w.worker.id, { subdivision_id: w.sub.id, hours: 1, date: "2026-01-05" });
  const withdrawn = await application(w, w.sub, w.worker, "2026-01-01", "2026-01-31");
  await billing().decideApplication(w.worker.id, withdrawn.id, { status: "withdrawn" });
  const [voided] = await waiversFor(withdrawn);
  assert.equal(voided.status, "void");
  await t.reject(() => billing().waivers.sign(w.worker.id, voided.id, sign), 409);
  const a = await application(w, w.sub, w.worker, "2026-01-01", "2026-01-31");
  await billing().decideApplication(w.client.id, a.id, { status: "approved" });
  const pay = (amount, reference) =>
    billing().recordPayment(w.client.id, a.id, {
      amount,
      paid_on: "2026-02-01",
      reference,
      request_key: randomUUID(),
    });
  const partial = await pay(50, "CHK-1");
  assert.equal((await waiversFor(a)).length, 1);
  await pay(45, "CHK-2");
  let [, unconditional] = await waiversFor(a);
  assert.equal(unconditional.kind, "unconditional_progress");
  assert.match(unconditional.snapshot.text[0], /has received payment/);
  await billing().reversePayment(w.client.id, partial.id, {
    note: "Check bounced",
    request_key: randomUUID(),
  });
  [, unconditional] = await waiversFor(a);
  assert.equal(unconditional.status, "void");
  await t.reject(() => billing().waivers.sign(w.worker.id, unconditional.id, sign), 409);
  await pay(50, "CHK-3");
  const current = (await waiversFor(a)).filter((x) => x.status === "requested" && !x.conditional);
  assert.equal(current.length, 1);
  const signed = await billing().waivers.sign(w.worker.id, current[0].id, sign);
  assert.equal(signed.status, "signed");
});
test("closeout generates final waivers and the project chain includes subcontracts by visibility", async () => {
  const w = await t.work(true),
    sub = await t.user();
  const [child] = await t.s.addChild(w.worker.id, w.sub.id, { scopes: ["Child framing"] });
  const bid = await t.s.submitBid(sub.id, child.id, { amount: 300 });
  await t.s.award(w.worker.id, bid.id);
  await t.s.profile(sub.id, { hourly_rate: 50 });
  await t.s.logTime(sub.id, { subdivision_id: child.id, hours: 2, date: "2026-01-06" });
  const childApp = await application({}, child, sub, "2026-01-01", "2026-01-31");
  // The organization owner (w.worker) is the payer for the child scope.
  await billing().decideApplication(w.worker.id, childApp.id, { status: "approved" });
  await t.s.subdivisionStatus(sub.id, child.id, { status: "completed" });
  const closeout = await application({}, child, sub, "2026-02-01", "2026-02-28", {
    retainage_percent: 0,
  });
  const [finalWaiver] = await waiversFor(closeout);
  assert.equal(finalWaiver.kind, "conditional_final");
  assert.equal(finalWaiver.payer_org_id, w.organization.id);
  assert.match(finalWaiver.snapshot.text[2], /final payment, including retainage/);
  await t.s.profile(w.worker.id, { hourly_rate: 80 });
  await t.s.logTime(w.worker.id, { subdivision_id: w.sub.id, hours: 1, date: "2026-01-07" });
  await application(w, w.sub, w.worker, "2026-01-01", "2026-01-31");
  const clientChain = await billing().waivers.chain(w.client.id, w.p.id);
  assert.equal(clientChain.scopes.length, 2);
  assert.equal(clientChain.waivers.length, 3);
  assert.equal(clientChain.complete, false);
  const subChain = await billing().waivers.chain(sub.id, w.p.id);
  assert.deepEqual(subChain.scopes.map((s) => s.id), [child.id]);
  const outsider = await t.user();
  await t.reject(() => billing().waivers.chain(outsider.id, w.p.id), 403);
  // Subcontract waivers are signed by the subcontractor, never the project client or payer.
  await t.reject(() => billing().waivers.sign(w.client.id, finalWaiver.id, sign), 403);
  await t.reject(() => billing().waivers.sign(w.worker.id, finalWaiver.id, sign), 403);
  await billing().waivers.sign(sub.id, finalWaiver.id, sign);
});
test("waivers backfill for applications that predate them", async () => {
  const w = await t.work();
  await t.s.profile(w.worker.id, { hourly_rate: 100 });
  await t.s.logTime(w.worker.id, { subdivision_id: w.sub.id, hours: 1, date: "2026-01-05" });
  const a = await application(w, w.sub, w.worker, "2026-01-01", "2026-01-31");
  await t.database.db.query("ALTER TABLE lien_waivers DISABLE TRIGGER lien_waivers_immutable");
  await t.database.models.LienWaiver.destroy({ where: { application_id: a.id } });
  await t.database.db.query("ALTER TABLE lien_waivers ENABLE TRIGGER lien_waivers_immutable");
  const listed = await billing().waivers.list(w.client.id, w.sub.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "requested");
});
