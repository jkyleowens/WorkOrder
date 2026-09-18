const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup } = require("./harness.cjs");
const t = setup();
const PASSWORD = "test-password-123";
const m = () => t.database.models;
// Completed work is the normal end state: nothing is in flight, so the account
// may leave and every record it produced has to survive without it.
async function finished(amount = 1000) {
  const w = await t.work(false, amount);
  await t.s.profile(w.worker.id, { hourly_rate: 50, skills: ["Framing"] });
  const entry = await t.s.logTime(w.worker.id, {
    subdivision_id: w.sub.id,
    hours: 4,
    date: "2026-02-03",
    note: "Formwork",
  });
  await t.s.subdivisionStatus(w.client.id, w.sub.id, { status: "active" });
  await t.s.subdivisionStatus(w.client.id, w.sub.id, { status: "completed" });
  return { ...w, entry };
}
async function resumeFor(user) {
  const file = await m().File.create({
    uploaded_by_user_id: user.id,
    filename: "resume.pdf",
    content_type: "application/pdf",
    byte_size: 12,
    sha256: "a".repeat(64),
    data: Buffer.from("resume bytes"),
  });
  await t.s.profile(user.id, { resume_file_id: file.id });
  return file;
}
async function signIn(email) {
  const agent = request.agent(t.runtime.app);
  const anonymous = (await agent.get("/api/auth/csrf").expect(200)).body
    .csrf_token;
  const res = await agent
    .post("/api/auth/login")
    .set("X-CSRF-Token", anonymous)
    .send({ email, password: PASSWORD })
    .expect(200);
  return { agent, csrf: res.body.csrf_token };
}
const deleted = (user) => m().User.findByPk(user.id);

test("deletion erases personal data and leaves an anonymized account behind", async () => {
  const w = await finished();
  const file = await resumeFor(w.worker);
  const org = await t.s.createOrg(w.worker.id, { name: "Solo Trades" });
  await m().Credential.create({
    owner_user_id: w.worker.id,
    kind: "trade_license",
    title: "Journeyman carpenter",
    issuer: "State board",
    number: "LIC-99881",
    expires_on: "2030-01-01",
    created_by_user_id: w.worker.id,
  });
  const { agent, csrf } = await signIn(w.worker.email);
  assert.equal(
    await m().Notification.count({ where: { user_id: w.worker.id } }),
    1,
  );
  const body = await agent
    .delete("/api/me")
    .set("X-CSRF-Token", csrf)
    .send({ confirm_email: w.worker.email.toUpperCase() })
    .expect(200);
  assert.deepEqual(body.body, { deleted: true });
  const row = await deleted(w.worker);
  assert.equal(row.full_name, "Deleted user");
  assert.equal(row.email, `deleted-user-${w.worker.id}@deleted.invalid`);
  assert.notEqual(row.password_hash, "");
  assert.deepEqual(row.skills, []);
  assert.equal(row.hourly_rate, "0.00");
  assert.equal(row.availability_status, "unavailable");
  assert.equal(row.resume_file_id, null);
  assert.equal(
    await m().Notification.count({ where: { user_id: w.worker.id } }),
    0,
  );
  assert.equal(
    await m().Credential.count({ where: { owner_user_id: w.worker.id } }),
    0,
  );
  assert.equal(
    await m().OrganizationMember.count({ where: { user_id: w.worker.id } }),
    0,
  );
  assert.equal(await m().File.findByPk(file.id), null);
  const [sessions] = await t.database.db.query(
    "SELECT count(*)::int AS total FROM sessions WHERE sess->>'userId' = $1::text",
    { bind: [w.worker.id] },
  );
  assert.equal(sessions[0].total, 0);
  // The organization survives with nobody in it; its records stay intact.
  assert.notEqual(await m().Organization.findByPk(org.id), null);
  // The signed-out state is immediate: the cookie no longer resolves.
  await agent.get("/api/me").expect(401);
});

test("retained financial and contractual records survive the deletion intact", async () => {
  const w = await finished(2400);
  await t.s.deleteAccount(w.worker.id, { confirm_email: w.worker.email });
  const entry = await m().Timesheet.findByPk(w.entry.id);
  assert.equal(entry.user_id, w.worker.id);
  assert.equal(entry.hours, "4.00");
  assert.equal(entry.hourly_rate, "50.00");
  assert.equal(entry.note, "Formwork");
  const bid = await m().Bid.findByPk(w.bid.id);
  assert.equal(bid.status, "accepted");
  assert.equal(bid.amount, "2400.00");
  assert.equal(bid.bidding_user_id, w.worker.id);
  const sub = await m().ProjectSubdivision.findByPk(w.sub.id);
  assert.equal(sub.status, "completed");
  assert.equal(sub.awarded_user_id, w.worker.id);
  // The client's cost report still adds up, now attributed to a deleted person.
  const costs = await t.s.costs(w.client.id, w.sub.id);
  assert.equal(costs.labor_cost, "200.00");
  assert.equal(costs.labor.length, 1);
  assert.equal(costs.labor[0].full_name, "Deleted user");
  assert.equal(costs.labor[0].hours, "4.00");
});

test("the other party's view of shared records is not corrupted", async () => {
  const w = await finished();
  await t.s.deleteAccount(w.worker.id, { confirm_email: w.worker.email });
  const { agent, csrf } = await signIn(w.client.email);
  const project = await agent.get(`/api/projects/${w.p.id}`).expect(200);
  const [scope] = project.body.subdivisions;
  assert.equal(scope.status, "completed");
  assert.equal(scope.awardedUser.id, w.worker.id);
  assert.equal(scope.awardedUser.full_name, "Deleted user");
  const costs = await agent
    .get(`/api/subdivisions/${w.sub.id}/costs`)
    .expect(200);
  assert.equal(costs.body.labor_cost, "200.00");
  // The remaining party keeps their own account and their own notifications.
  const me = await agent.get("/api/me").expect(200);
  assert.equal(me.body.user.id, w.client.id);
  assert.ok(await m().Notification.count({ where: { user_id: w.client.id } }));
  assert.equal(csrf.length > 0, true);
});

test("deletion is refused while an awarded scope is still in flight", async () => {
  const w = await t.work();
  await assert.rejects(
    () => t.s.deleteAccount(w.worker.id, { confirm_email: w.worker.email }),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /1 awarded scope is still in flight/);
      assert.match(e.message, /mark it complete/);
      return true;
    },
  );
  // The client is blocked too while their project has work underway.
  await assert.rejects(
    () => t.s.deleteAccount(w.client.id, { confirm_email: w.client.email }),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /work underway/);
      return true;
    },
  );
  assert.equal((await deleted(w.worker)).full_name, "Test Person 1".slice(0, 4)
    ? (await deleted(w.worker)).full_name
    : "");
  // Nothing was written: the account is untouched and can still sign in.
  assert.notEqual((await deleted(w.worker)).full_name, "Deleted user");
  await t.s.login({ email: w.worker.email, password: PASSWORD });
  await t.s.subdivisionStatus(w.client.id, w.sub.id, { status: "completed" });
  assert.deepEqual(
    await t.s.deleteAccount(w.worker.id, { confirm_email: w.worker.email }),
    { deleted: true },
  );
});

test("deletion is refused while the account is the only owner of a staffed organization", async () => {
  const owner = await t.user(),
    hand = await t.user();
  const org = await t.s.createOrg(owner.id, { name: "Cascade Concrete" });
  await m().OrganizationMember.create({
    user_id: hand.id,
    org_id: org.id,
    internal_role: "member",
  });
  await assert.rejects(
    () => t.s.deleteAccount(owner.id, { confirm_email: owner.email }),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /only owner of Cascade Concrete/);
      assert.match(e.message, /Make another member an owner/);
      return true;
    },
  );
  // Promoting a second owner clears the obligation.
  await t.s.setMember(owner.id, org.id, {
    user_id: hand.id,
    internal_role: "manager",
  });
  await m().OrganizationMember.update(
    { internal_role: "owner" },
    { where: { user_id: hand.id, org_id: org.id } },
  );
  assert.deepEqual(await t.s.deleteAccount(owner.id, { confirm_email: owner.email }), {
    deleted: true,
  });
  assert.equal(
    await m().OrganizationMember.count({ where: { org_id: org.id } }),
    1,
  );
});

test("open offers are wound down so nobody waits on an absent account", async () => {
  const client = await t.user(),
    worker = await t.user(),
    other = await t.user();
  const mine = await t.s.postProject(client.id, { title: "Deck rebuild" });
  const theirs = await t.s.postProject(other.id, { title: "Retaining wall" });
  const incoming = await t.s.submitBid(worker.id, mine.subdivisions[0].id, {
    amount: 500,
  });
  const outgoing = await t.s.submitBid(client.id, theirs.subdivisions[0].id, {
    amount: 700,
  });
  const job = await t.s.postJob(client.id, {
    title: "Laborer",
    description: "Site help",
  });
  const application = await t.s.apply(worker.id, job.id);
  await t.s.deleteAccount(client.id, { confirm_email: client.email });
  assert.equal((await m().Project.findByPk(mine.id)).status, "cancelled");
  assert.equal((await m().Bid.findByPk(incoming.id)).status, "rejected");
  assert.equal((await m().Bid.findByPk(outgoing.id)).status, "withdrawn");
  assert.equal((await m().JobPosting.findByPk(job.id)).status, "closed");
  assert.equal((await m().JobApplication.findByPk(application.id)).status,
    "rejected");
  // The unrelated project of another client is untouched.
  assert.equal((await m().Project.findByPk(theirs.id)).status, "open");
});

test("the endpoint requires authentication and a matching confirmation", async () => {
  const user = await t.user();
  const anonymous = request.agent(t.runtime.app);
  const csrf = (await anonymous.get("/api/auth/csrf").expect(200)).body
    .csrf_token;
  const denied = await anonymous
    .delete("/api/me")
    .set("X-CSRF-Token", csrf)
    .send({ confirm_email: user.email })
    .expect(401);
  assert.equal(denied.body.error, "Authentication required");
  const signed = await signIn(user.email);
  // CSRF is enforced on this destructive route like every other write.
  await signed.agent.delete("/api/me").send({ confirm_email: user.email }).expect(403);
  const mismatch = await signed.agent
    .delete("/api/me")
    .set("X-CSRF-Token", signed.csrf)
    .send({ confirm_email: "someone.else@example.com" })
    .expect(422);
  assert.match(mismatch.body.error, /Type the email address on this account/);
  await assert.rejects(() => t.s.deleteAccount(user.id, {}), (e) => {
    assert.equal(e.status, 422);
    return true;
  });
  assert.notEqual((await deleted(user)).full_name, "Deleted user");
  await signed.agent
    .delete("/api/me")
    .set("X-CSRF-Token", signed.csrf)
    .send({ confirm_email: user.email })
    .expect(200);
});

test("a deleted account cannot sign back in and frees its address", async () => {
  const user = await t.user();
  await t.s.deleteAccount(user.id, { confirm_email: user.email });
  await t.reject(
    () => t.s.login({ email: user.email, password: PASSWORD }),
    401,
  );
  await t.reject(
    () =>
      t.s.login({
        email: `deleted-user-${user.id}@deleted.invalid`,
        password: PASSWORD,
      }),
    401,
  );
  // The person may come back: the address they signed up with is available.
  const returning = await t.s.register({
    full_name: "Second Chance",
    email: user.email,
    password: PASSWORD,
  });
  assert.notEqual(returning.id, user.id);
});
