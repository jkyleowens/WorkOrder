const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const request = require("supertest");
const { createDatabase, migrate } = require("../../backend/database.cjs");
const { PlatformService } = require("../../backend/services.cjs");
const { createApp } = require("../../backend/app.cjs");
let pg, database, s, runtime, dir, url;
let serial = 0;
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
before(
  async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "workorder-tests-"));
    const port = await freePort();
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    pg = new EmbeddedPostgres({
      databaseDir: path.join(dir, "data"),
      port,
      user: "postgres",
      password: "test-password",
      persistent: false,
      postgresFlags: ["-h", "127.0.0.1", "-k", dir],
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("workorder_test");
    url = `postgres://postgres:test-password@127.0.0.1:${port}/workorder_test`;
    database = createDatabase(url);
    await migrate(database.db);
    s = new PlatformService(database);
    runtime = createApp(database, {
      databaseUrl: url,
      sessionSecret: "test-secret-0123456789-0123456789-0123456789",
      authLimit: 1000,
    });
  },
  { timeout: 60000 },
);
after(async () => {
  if (runtime) await runtime.close();
  if (database) await database.db.close();
  if (pg) await pg.stop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});
const user = () =>
  s.register({
    full_name: "Test Person",
    email: `user${++serial}@example.com`,
    password: "test-password-123",
  });
const reject = (fn, status) => assert.rejects(fn, (e) => e.status === status);
async function work(org = false) {
  const client = await user(),
    worker = await user();
  let organization;
  if (org) organization = await s.createOrg(worker.id, { name: "Acme" });
  const p = await s.postProject(client.id, { title: "Driveway" });
  const sub = p.subdivisions[0];
  const bid = await s.submitBid(worker.id, sub.id, {
    amount: 1000,
    ...(org ? { org_id: organization.id } : {}),
  });
  await s.award(client.id, bid.id);
  return { client, worker, organization, p, sub, bid };
}
test("versioned migrations are repeatable and model associations resolve", async () => {
  await migrate(database.db);
  const [rows] = await database.db.query(
    "SELECT count(*)::int AS n FROM schema_migrations",
  );
  const files = (
    await fs.readdir(path.join(__dirname, "../../backend/migrations"))
  ).filter((name) => name.endsWith(".sql"));
  assert.equal(rows[0].n, files.length);
  const u = await user(),
    o = await s.createOrg(u.id, { name: "Builder" });
  assert.equal((await o.getCreator()).id, u.id);
  const member = await database.models.OrganizationMember.findOne({
    where: { org_id: o.id },
  });
  assert.equal(member.canManage(), true);
  assert.equal(member.internal_role, "owner");
});
test("registration hashes passwords, normalizes email, rejects duplicates and invalid profile fields", async () => {
  const u = await s.register({
    full_name: "Named",
    email: "Mixed@Example.com",
    password: "test-password-123",
  });
  assert.equal(u.email, "mixed@example.com");
  assert.equal(u.password_hash, undefined);
  const stored = await s.get("User", u.id);
  assert.notEqual(stored.password_hash, "test-password-123");
  assert.equal(stored.toJSON().password_hash, undefined);
  assert.equal(
    (
      await s.login({
        email: "MIXED@example.com",
        password: "test-password-123",
      })
    ).id,
    u.id,
  );
  await reject(() => s.login({ email: u.email, password: "incorrect" }), 401);
  await assert.rejects(
    () =>
      s.register({
        full_name: "Again",
        email: u.email,
        password: "test-password-123",
      }),
    { name: "SequelizeUniqueConstraintError" },
  );
  await assert.rejects(() => s.profile(u.id, { password_hash: "injected" }));
  await assert.rejects(() => s.profile(u.id, { hourly_rate: -2 }));
  await assert.rejects(() =>
    s.register({
      full_name: "X",
      email: "unicode@example.com",
      password: "🙂".repeat(30),
    }),
  );
});
test("employment offer requires applicant consent and creates a single member atomically", async () => {
  const owner = await user(),
    worker = await user(),
    outsider = await user();
  const org = await s.createOrg(owner.id, { name: "Hiring" });
  const job = await s.postJob(owner.id, {
    title: "Plumber",
    description: "Work here",
    org_id: org.id,
  });
  const app = await s.apply(worker.id, job.id);
  await reject(() => s.applicationAction(outsider.id, app.id, "offered"), 403);
  await reject(() => s.applicationAction(worker.id, app.id, "accepted"), 409);
  await s.applicationAction(owner.id, app.id, "offered");
  assert.equal(
    await database.models.OrganizationMember.count({
      where: { org_id: org.id, user_id: worker.id },
    }),
    0,
  );
  await reject(() => s.applicationAction(owner.id, app.id, "accepted"), 403);
  const attempts = await Promise.allSettled([
    s.applicationAction(worker.id, app.id, "accepted"),
    s.applicationAction(worker.id, app.id, "accepted"),
  ]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    await database.models.OrganizationMember.count({
      where: { org_id: org.id, user_id: worker.id },
    }),
    1,
  );
  await reject(
    () => s.switchContext(worker.id, { mode: "organization", org_id: org.id }),
    403,
  );
  await s.setMember(owner.id, org.id, {
    user_id: worker.id,
    internal_role: "manager",
  });
  assert.equal(
    (await s.switchContext(worker.id, { mode: "organization", org_id: org.id }))
      .org_id,
    org.id,
  );
  await s.setMember(owner.id, org.id, {
    user_id: worker.id,
    internal_role: "member",
  });
  await reject(
    () =>
      s.postJob(worker.id, { title: "No", description: "No", org_id: org.id }),
    403,
  );
  await reject(
    () =>
      s.setMember(owner.id, org.id, {
        user_id: owner.id,
        internal_role: "member",
      }),
    403,
  );
});
test("personal hiring, withdrawal, rejection and job closure do not create organizations", async () => {
  const poster = await user(),
    applicant = await user();
  const job = await s.postJob(poster.id, {
    title: "Assistant",
    description: "Help",
  });
  await reject(() => s.apply(poster.id, job.id), 403);
  const a = await s.apply(applicant.id, job.id);
  await s.applicationAction(poster.id, a.id, "offered");
  await s.applicationAction(applicant.id, a.id, "accepted");
  assert.equal(
    await database.models.OrganizationMember.count({
      where: { user_id: applicant.id },
    }),
    0,
  );
  const other = await user();
  const b = await s.apply(other.id, job.id);
  await s.applicationAction(other.id, b.id, "withdrawn");
  await reject(() => s.applicationAction(poster.id, b.id, "offered"), 409);
  const third = await user();
  const c = await s.apply(third.id, job.id);
  await s.closeJob(poster.id, job.id);
  assert.equal((await s.get("JobApplication", c.id)).status, "rejected");
  await reject(() => s.apply(third.id, job.id), 409);
});
test("subdivisions support mixed solo and organization awards and aggregate completion", async () => {
  const client = await user(),
    solo = await user(),
    manager = await user();
  const org = await s.createOrg(manager.id, { name: "Electric" });
  let p = await s.postProject(client.id, { title: "Build" });
  assert.equal(p.subdivisions.length, 1);
  p = await s.subdivide(client.id, p.id, {
    scopes: ["Plumbing", "Electrical"],
  });
  assert.equal(p.subdivisions.length, 2);
  const a = await s.submitBid(solo.id, p.subdivisions[0].id, { amount: 500 });
  const b = await s.submitBid(manager.id, p.subdivisions[1].id, {
    amount: 700,
    org_id: org.id,
  });
  await reject(
    () => s.subdivide(client.id, p.id, { scopes: ["Replace"] }),
    409,
  );
  await reject(() => s.award(solo.id, a.id), 403);
  await s.award(client.id, a.id);
  await s.award(client.id, b.id);
  await s.subdivisionStatus(solo.id, p.subdivisions[0].id, {
    status: "active",
  });
  await s.subdivisionStatus(client.id, p.subdivisions[0].id, {
    status: "completed",
  });
  assert.equal((await s.get("Project", p.id)).status, "active");
  await s.subdivisionStatus(manager.id, p.subdivisions[1].id, {
    status: "completed",
  });
  assert.equal((await s.get("Project", p.id)).status, "completed");
  await reject(
    () =>
      s.logTime(solo.id, {
        subdivision_id: p.subdivisions[0].id,
        hours: 1,
        date: "2026-09-12",
      }),
    409,
  );
});
test("simultaneous awards yield one winner and reject competing bids", async () => {
  const client = await user(),
    a = await user(),
    b = await user();
  const p = await s.postProject(client.id, { title: "Concurrent" }),
    id = p.subdivisions[0].id;
  const bids = await Promise.all([
    s.submitBid(a.id, id, { amount: 1 }),
    s.submitBid(b.id, id, { amount: 2 }),
  ]);
  const results = await Promise.allSettled(
    bids.map((b) => s.award(client.id, b.id)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rows = await database.models.Bid.findAll({
    where: { subdivision_id: id },
  });
  assert.deepEqual(rows.map((b) => b.status).sort(), ["accepted", "rejected"]);
});
test("withdrawn bids can be replaced, self bids and cancelled work are denied", async () => {
  const client = await user(),
    bidder = await user();
  const p = await s.postProject(client.id, { title: "Cancel" }),
    id = p.subdivisions[0].id;
  await reject(() => s.submitBid(client.id, id, { amount: 1 }), 403);
  const b = await s.submitBid(bidder.id, id, { amount: 10 });
  await s.withdrawBid(bidder.id, b.id);
  const second = await s.submitBid(bidder.id, id, { amount: 11 });
  await s.cancelProject(client.id, p.id);
  assert.equal((await s.get("Bid", second.id)).status, "rejected");
  await reject(() => s.award(client.id, second.id), 409);
  await reject(() => s.submitBid(bidder.id, id, { amount: 12 }), 409);
});
test("time is user-owned, rolls up to the award organization and snapshots historical rates", async () => {
  const { client, worker, organization, sub } = await work(true);
  await s.profile(worker.id, {
    hourly_rate: 25.5,
    skills: ["Paving"],
    availability_status: "busy",
  });
  const entry = await s.logTime(worker.id, {
    subdivision_id: sub.id,
    hours: 4,
    date: "2026-09-12",
  });
  assert.equal(entry.org_id, organization.id);
  assert.equal(entry.isOnBehalfOfOrg(), true);
  await s.profile(worker.id, { hourly_rate: 100 });
  const range = { from: "2026-09-07", to: "2026-09-13" };
  const personal = await s.timeReport(worker.id, range),
    org = await s.timeReport(worker.id, range, organization.id);
  assert.equal(personal.hours, "4.00");
  assert.equal(org.hours, personal.hours);
  assert.equal(org.labor_cost, "102.00");
  assert.equal((await s.costs(client.id, sub.id)).labor_cost, "102.00");
  const outsider = await user();
  await reject(
    () =>
      s.logTime(outsider.id, {
        subdivision_id: sub.id,
        hours: 1,
        date: "2026-09-12",
      }),
    403,
  );
  await reject(() => s.timeReport(outsider.id, range, organization.id), 403);
  await reject(
    () =>
      s.logTime(worker.id, {
        subdivision_id: sub.id,
        hours: 1,
        date: "2026-09-12",
        org_id: 9999,
      }),
    403,
  );
  await assert.rejects(() =>
    s.logTime(worker.id, {
      subdivision_id: sub.id,
      hours: 1,
      date: "2026-02-30",
    }),
  );
  await reject(() => s.deleteTime(client.id, entry.id), 403);
  await s.deleteTime(worker.id, entry.id);
  assert.equal((await s.timeReport(worker.id, range)).hours, "0");
});
test("concurrent daily time entries cannot exceed 24 hours, across subdivisions", async () => {
  const { worker, sub, client } = await work();
  const p = await s.postProject(client.id, { title: "Second" });
  const bid = await s.submitBid(worker.id, p.subdivisions[0].id, { amount: 1 });
  await s.award(client.id, bid.id);
  const results = await Promise.allSettled(
    [sub.id, p.subdivisions[0].id].map((id) =>
      s.logTime(worker.id, {
        subdivision_id: id,
        hours: 13,
        date: "2026-09-10",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    Number(
      await database.models.Timesheet.sum("hours", {
        where: { user_id: worker.id },
      }),
    ),
    13,
  );
});
test("inventory consumption is atomic, auditable and uses historical cost", async () => {
  const { client, worker, sub } = await work();
  const item = await s.addItem(worker.id, {
    item_name: "Concrete",
    stock: 10,
    unit_cost: 7.25,
  });
  const result = await Promise.allSettled([
    s.consume(worker.id, sub.id, { item_id: item.id, qty: 7 }),
    s.consume(worker.id, sub.id, { item_id: item.id, qty: 7 }),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await s.get("InventoryItem", item.id)).stock, 3);
  assert.equal(
    await database.models.ProjectInventory.count({
      where: { item_id: item.id },
    }),
    1,
  );
  await s.receive(worker.id, item.id, {
    quantity: 2,
    reason: "Delivery",
    unit_cost: 99,
  });
  assert.equal((await s.costs(client.id, sub.id)).material_cost, "50.75");
  const movements = await database.models.InventoryMovement.findAll({
    where: { item_id: item.id },
  });
  assert.equal(
    movements.reduce((sum, r) => sum + r.quantity, 0),
    5,
  );
  const outsider = await user();
  await reject(
    () => s.receive(outsider.id, item.id, { quantity: 1, reason: "No" }),
    403,
  );
  const other = await s.addItem(outsider.id, {
    item_name: "Private",
    stock: 10,
  });
  await reject(
    () => s.consume(worker.id, sub.id, { item_id: other.id, qty: 1 }),
    403,
  );
  assert.equal((await s.get("InventoryItem", other.id)).stock, 10);
});
test("database constraints reject invalid ownership, orphan references, negative stock and duplicate membership", async () => {
  const u = await user(),
    o = await s.createOrg(u.id, { name: "Constraints" });
  for (const sql of [
    `INSERT INTO inventory_items(owner_user_id,owner_org_id,item_name,stock) VALUES (${u.id},${o.id},'bad',1)`,
    "INSERT INTO inventory_items(item_name,stock) VALUES ('bad',1)",
    `INSERT INTO inventory_items(owner_user_id,item_name,stock) VALUES (${u.id},'bad',-1)`,
    "INSERT INTO projects(client_user_id,title) VALUES (2147483647,'bad')",
    `INSERT INTO organization_members(user_id,org_id,internal_role) VALUES (${u.id},${o.id},'member')`,
    "INSERT INTO bids(subdivision_id,amount) VALUES (1,5)",
  ])
    await assert.rejects(() => database.db.query(sql));
});
test("failed multi-write transactions roll back entirely", async () => {
  const { worker, sub } = await work();
  const item = await s.addItem(worker.id, { item_name: "Rollback", stock: 5 });
  const hook = () => {
    throw new Error("injected ledger failure");
  };
  database.models.InventoryMovement.addHook(
    "beforeCreate",
    "testFailure",
    hook,
  );
  try {
    await assert.rejects(
      () => s.consume(worker.id, sub.id, { item_id: item.id, qty: 2 }),
      /injected ledger failure/,
    );
  } finally {
    database.models.InventoryMovement.removeHook("beforeCreate", "testFailure");
  }
  assert.equal((await s.get("InventoryItem", item.id)).stock, 5);
  assert.equal(
    await database.models.ProjectInventory.count({
      where: { item_id: item.id },
    }),
    0,
  );
});
test("HTTP session, CSRF, privacy, validation and logout boundaries", async () => {
  const agent = request.agent(runtime.app);
  await agent.get("/api/me").expect(401);
  await agent.post("/api/auth/register").send({}).expect(403);
  const token = (await agent.get("/api/auth/csrf").expect(200)).body.csrf_token;
  const auth = await agent
    .post("/api/auth/register")
    .set("X-CSRF-Token", token)
    .send({
      full_name: "HTTP",
      email: "http@example.com",
      password: "test-password-123",
    })
    .expect(201);
  const csrf = auth.body.csrf_token;
  assert.notEqual(token, csrf);
  assert.equal(auth.body.user.password_hash, undefined);
  assert.match(auth.headers["set-cookie"][0], /HttpOnly/);
  assert.match(auth.headers["set-cookie"][0], /SameSite=Strict/);
  await agent.get("/api/me").expect(200);
  await agent
    .patch("/api/me")
    .set("X-CSRF-Token", token)
    .send({ full_name: "No" })
    .expect(403);
  await agent
    .patch("/api/me")
    .set("X-CSRF-Token", csrf)
    .send({ id: 22 })
    .expect(422);
  await agent.get("/api/projects/not-an-id").expect(422);
  await agent.get("/api/projects?limit=1000").expect(422);
  const users = await agent.get("/api/users").expect(200);
  assert.ok(
    users.body.every((u) => !("password_hash" in u) && !("email" in u)),
  );
  const org = await agent
    .post("/api/organizations")
    .set("X-CSRF-Token", csrf)
    .send({ name: "HTTP Org" })
    .expect(201);
  await agent
    .put("/api/context")
    .set("X-CSRF-Token", csrf)
    .send({ mode: "organization", org_id: org.body.id })
    .expect(200);
  await agent
    .get("/api/time/week?date=2026-09-12")
    .expect(200)
    .expect((r) => assert.equal(r.body.from, "2026-09-07"));
  await agent
    .post("/api/projects")
    .set("X-CSRF-Token", csrf)
    .set("Content-Type", "application/json")
    .send("{")
    .expect(400);
  await agent
    .post("/api/auth/logout")
    .set("X-CSRF-Token", csrf)
    .send({})
    .expect(204);
  await agent.get("/api/me").expect(401);
});
test("HTTP day-in-the-life crosses employment, markets and resource APIs", async () => {
  async function account() {
    const agent = request.agent(runtime.app);
    const csrf = (await agent.get("/api/auth/csrf")).body.csrf_token;
    const r = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        full_name: "API",
        email: `api${++serial}@example.com`,
        password: "test-password-123",
      })
      .expect(201);
    return { agent, token: r.body.csrf_token, id: r.body.user.id };
  }
  const owner = await account(),
    worker = await account(),
    client = await account();
  const write = (a, method, url, body = {}) =>
    a.agent[method]("/api" + url)
      .set("X-CSRF-Token", a.token)
      .send(body);
  const org = (
    await write(owner, "post", "/organizations", { name: "API Acme" }).expect(
      201,
    )
  ).body;
  const job = (
    await write(owner, "post", "/jobs", {
      title: "Builder",
      description: "Join",
      org_id: org.id,
    }).expect(201)
  ).body;
  const application = (
    await write(worker, "post", `/jobs/${job.id}/applications`).expect(201)
  ).body;
  await write(owner, "patch", `/applications/${application.id}`, {
    status: "offered",
  }).expect(200);
  await write(worker, "post", `/applications/${application.id}/accept`).expect(
    200,
  );
  const p = (
    await write(client, "post", "/projects", { title: "Driveway" }).expect(201)
  ).body;
  const sub = p.subdivisions[0];
  const bid = (
    await write(owner, "post", `/subdivisions/${sub.id}/bids`, {
      amount: 1200,
      org_id: org.id,
    }).expect(201)
  ).body;
  await write(client, "post", `/bids/${bid.id}/award`).expect(200);
  await write(worker, "patch", "/me", { hourly_rate: 30 }).expect(200);
  await write(worker, "post", "/time", {
    subdivision_id: sub.id,
    hours: 4,
    date: "2026-09-12",
  }).expect(201);
  const item = (
    await write(owner, "post", "/inventory", {
      item_name: "Stone",
      stock: 20,
      unit_cost: 2,
      org_id: org.id,
    }).expect(201)
  ).body;
  await write(worker, "post", `/subdivisions/${sub.id}/materials`, {
    item_id: item.id,
    qty: 5,
  }).expect(201);
  await worker.agent
    .get(`/api/organizations/${org.id}/dashboard?from=2026-09-01&to=2026-09-30`)
    .expect(403);
  const report = await owner.agent
    .get(`/api/organizations/${org.id}/dashboard?from=2026-09-01&to=2026-09-30`)
    .expect(200);
  assert.equal(report.body.hours, "4.00");
  assert.equal(report.body.labor_cost, "120.00");
  const costs = await client.agent
    .get(`/api/subdivisions/${sub.id}/costs`)
    .expect(200);
  assert.equal(costs.body.material_cost, "10.00");
});
test("timesheet corrections preserve rates and daily caps", async () => {
  const { worker, sub, client } = await work();
  await s.profile(worker.id, { hourly_rate: 10 });
  const entry = await s.logTime(worker.id, {
    subdivision_id: sub.id,
    hours: 4,
    date: "2026-09-12",
  });
  await s.logTime(worker.id, {
    subdivision_id: sub.id,
    hours: 21,
    date: "2026-09-13",
  });
  await reject(
    () => s.editTime(worker.id, entry.id, { date: "2026-09-13" }),
    409,
  );
  await reject(() => s.editTime(client.id, entry.id, { hours: 2 }), 403);
  await s.profile(worker.id, { hourly_rate: 100 });
  await s.editTime(worker.id, entry.id, {
    hours: 2,
    date: "2026-09-13",
    note: "Corrected",
  });
  const rows = await s.timeEntries(worker.id, {
    from: "2026-09-13",
    to: "2026-09-13",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === entry.id).hourly_rate, "10.00");
  await assert.rejects(() =>
    s.editTime(worker.id, entry.id, { hourly_rate: 999 }),
  );
});
test("organization inventory cannot be charged to another organization and rolls up material costs", async () => {
  const { worker, organization, sub } = await work(true);
  const other = await s.createOrg(worker.id, { name: "Other" });
  const forbidden = await s.addItem(worker.id, {
    item_name: "Other company stock",
    stock: 10,
    org_id: other.id,
  });
  await reject(
    () => s.consume(worker.id, sub.id, { item_id: forbidden.id, qty: 1 }),
    403,
  );
  const item = await s.addItem(worker.id, {
    item_name: "Owned",
    stock: 10,
    org_id: organization.id,
    unit_cost: 2.25,
  });
  await s.consume(worker.id, sub.id, { item_id: item.id, qty: 4 });
  const today = new Date().toISOString().slice(0, 10);
  const report = await s.orgDashboard(worker.id, organization.id, {
    from: today,
    to: today,
  });
  assert.equal(report.material_cost, "9.00");
});
test("failed membership creation leaves offer unaccepted", async () => {
  const owner = await user(),
    worker = await user();
  const org = await s.createOrg(owner.id, { name: "Rollback hiring" });
  const job = await s.postJob(owner.id, {
    title: "Work",
    description: "Work",
    org_id: org.id,
  });
  const app = await s.apply(worker.id, job.id);
  await s.applicationAction(owner.id, app.id, "offered");
  database.models.OrganizationMember.addHook(
    "beforeCreate",
    "failOffer",
    () => {
      throw new Error("membership failure");
    },
  );
  try {
    await assert.rejects(
      () => s.applicationAction(worker.id, app.id, "accepted"),
      /membership failure/,
    );
  } finally {
    database.models.OrganizationMember.removeHook("beforeCreate", "failOffer");
  }
  assert.equal((await s.get("JobApplication", app.id)).status, "offered");
  assert.equal(
    await database.models.OrganizationMember.count({
      where: { user_id: worker.id, org_id: org.id },
    }),
    0,
  );
});
test("sessions survive a new application instance, expire in PostgreSQL and reject malformed CSRF", async () => {
  const agent = request.agent(runtime.app);
  let token = (await agent.get("/api/auth/csrf")).body.csrf_token;
  const response = await agent
    .post("/api/auth/login")
    .set("X-CSRF-Token", token)
    .send({ email: "http@example.com", password: "test-password-123" })
    .expect(200);
  token = response.body.csrf_token;
  await agent
    .patch("/api/me")
    .set("X-CSRF-Token", "é".repeat(token.length))
    .send({ full_name: "Bad" })
    .expect(403);
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  const second = createApp(database, {
    databaseUrl: url,
    sessionSecret: "test-secret-0123456789-0123456789-0123456789",
  });
  try {
    await request(second.app).get("/api/me").set("Cookie", cookie).expect(200);
    await database.db.query(
      "UPDATE sessions SET expire=now()-interval '1 hour'",
    );
    await request(second.app).get("/api/me").set("Cookie", cookie).expect(401);
  } finally {
    await second.close();
  }
});
test("authentication rate limiting rejects repeated password guesses", async () => {
  const limited = createApp(database, {
    databaseUrl: url,
    sessionSecret: "test-secret-0123456789-0123456789-0123456789",
    authLimit: 1,
  });
  try {
    const agent = request.agent(limited.app);
    const token = (await agent.get("/api/auth/csrf")).body.csrf_token;
    const attempt = () =>
      agent
        .post("/api/auth/login")
        .set("X-CSRF-Token", token)
        .send({ email: "unknown@example.com", password: "wrong-password" });
    await attempt().expect(401);
    await attempt()
      .expect(429)
      .expect((response) => assert.match(response.body.error, /Too many/));
  } finally {
    await limited.close();
  }
});
test("console read models include safe names, closed hiring history and scoped assignments", async () => {
  const owner = await user(),
    outsider = await user();
  const org = await s.createOrg(owner.id, { name: "Console reads" });
  const ownJob = await s.postJob(owner.id, {
    title: "Personal history",
    description: "Role",
  });
  await s.closeJob(owner.id, ownJob.id);
  const orgJob = await s.postJob(owner.id, {
    title: "Organization history",
    description: "Role",
    org_id: org.id,
  });
  await s.closeJob(owner.id, orgJob.id);
  async function agentFor(u) {
    const agent = request.agent(runtime.app);
    const csrf = (await agent.get("/api/auth/csrf")).body.csrf_token;
    await agent
      .post("/api/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ email: u.email, password: "test-password-123" })
      .expect(200);
    return agent;
  }
  const agent = await agentFor(owner),
    other = await agentFor(outsider);
  const personal = await agent.get("/api/me/jobs").expect(200);
  assert.deepEqual(
    personal.body.map((j) => j.id),
    [ownJob.id],
  );
  assert.equal(personal.body[0].status, "closed");
  assert.equal(personal.body[0].poster.password_hash, undefined);
  assert.equal(personal.body[0].poster.email, undefined);
  const hiring = await agent
    .get(`/api/organizations/${org.id}/jobs`)
    .expect(200);
  assert.deepEqual(
    hiring.body.map((j) => j.id),
    [orgJob.id],
  );
  assert.equal(hiring.body[0].organization.name, "Console reads");
  await other.get(`/api/organizations/${org.id}/jobs`).expect(403);
  await other.get(`/api/organizations/${org.id}/assignments`).expect(403);
  await agent
    .get(`/api/organizations/${org.id}/assignments?limit=20&offset=0`)
    .expect(200)
    .expect((r) => assert.deepEqual(r.body, []));
  await request(runtime.app)
    .get("/register")
    .expect(200)
    .expect("Content-Type", /html/);
  await request(runtime.app).get("/assets/app.js").expect(200);
  await request(runtime.app).get("/assets/../../.env").expect(404);
});

test("nested contractors commission children and cannot finish unfinished branches", async () => {
  const client = await user(),
    contractor = await user(),
    sub = await user(),
    outsider = await user();
  const p = await s.postProject(client.id, { title: "Nested delivery" });
  const root = p.subdivisions[0];
  const bid = await s.submitBid(contractor.id, root.id, { amount: 1000 });
  await s.award(client.id, bid.id);
  const [child] = await s.addChild(contractor.id, root.id, {
    scopes: ["Specialist work"],
  });
  await reject(
    () => s.addChild(outsider.id, child.id, { scopes: ["Unauthorized"] }),
    403,
  );
  await reject(() => s.submitBid(contractor.id, child.id, { amount: 50 }), 403);
  const childBid = await s.submitBid(sub.id, child.id, { amount: 500 });
  await reject(() => s.award(outsider.id, childBid.id), 403);
  await s.award(contractor.id, childBid.id);
  const [grandchild] = await s.addChild(sub.id, child.id, {
    scopes: ["Finishing"],
  });
  const finishBid = await s.submitBid(outsider.id, grandchild.id, {
    amount: 100,
  });
  await s.award(sub.id, finishBid.id);
  await reject(
    () => s.subdivisionStatus(contractor.id, root.id, { status: "completed" }),
    409,
  );
  await s.subdivisionStatus(outsider.id, grandchild.id, {
    status: "completed",
  });
  await s.subdivisionStatus(sub.id, child.id, { status: "completed" });
  await s.subdivisionStatus(contractor.id, root.id, { status: "completed" });
  assert.equal((await s.projectDetail(p.id)).status, "completed");
});

test("organization settings require management membership", async () => {
  const owner = await user(),
    outsider = await user();
  const org = await s.createOrg(owner.id, { name: "Original" });
  await reject(
    () => s.editOrg(outsider.id, org.id, { name: "Forbidden" }),
    403,
  );
  await s.editOrg(owner.id, org.id, {
    name: "Updated",
    trade_focus: "Construction",
  });
  assert.equal((await s.get("Organization", org.id)).name, "Updated");
});

test("pay negotiation requires current consent and snapshots organization agreements", async () => {
  const { worker: owner, organization: org, client, sub } = await work(true);
  const worker = await user(),
    stranger = await user();
  await s.profile(worker.id, { hourly_rate: 90 });
  const role = await s.saveCompanyRole(owner.id, org.id, null, {
    name: "Electrician",
    description: "Install and inspect",
    skills: ["Wiring"],
    hourly_rate: 30,
  });
  const job = await s.postJob(owner.id, {
    org_id: org.id,
    company_role_id: role.id,
    title: "Electrician",
    description: "Join us",
  });
  assert.equal(Number(job.hourly_rate), 30);
  const app = await s.apply(worker.id, job.id, {
    desired_rate: 35,
    note: "Experienced installer",
  });
  await reject(
    () => s.counterOffer(stranger.id, app.id, { desired_rate: 5, revision: 0 }),
    403,
  );
  const offer = await s.applicationAction(owner.id, app.id, "offered", {
    offered_rate: 32,
    revision: 0,
  });
  await reject(() => s.applicationAction(worker.id, app.id, "accepted"), 409);
  const counter = await s.counterOffer(worker.id, app.id, {
    desired_rate: 34,
    revision: offer.revision,
    note: "Can we meet at 34?",
  });
  assert.equal(counter.status, "pending");
  assert.equal(counter.offered_rate, null);
  await reject(
    () =>
      s.applicationAction(worker.id, app.id, "accepted", {
        revision: offer.revision,
      }),
    409,
  );
  await reject(
    () =>
      s.applicationAction(owner.id, app.id, "offered", {
        offered_rate: 1,
        revision: offer.revision,
      }),
    409,
  );
  const final = await s.applicationAction(owner.id, app.id, "offered", {
    offered_rate: 34,
    revision: counter.revision,
  });
  await s.applicationAction(worker.id, app.id, "accepted", {
    revision: final.revision,
  });
  const member = await s.member(worker.id, org.id);
  assert.equal(Number(member.hourly_rate), 34);
  assert.equal(member.company_role_id, role.id);
  assert.equal(member.internal_role, "member");
  await reject(
    () =>
      s.setMemberPay(worker.id, org.id, {
        user_id: worker.id,
        company_role_id: role.id,
        hourly_rate: 500,
      }),
    403,
  );
  const first = await s.logTime(worker.id, {
    subdivision_id: sub.id,
    hours: 2.5,
    date: "2026-09-13",
  });
  assert.equal(Number(first.hourly_rate), 34);
  await s.saveCompanyRole(owner.id, org.id, role.id, {
    name: "Lead electrician",
    description: "Supervise installation",
    skills: ["Wiring", "Inspection"],
    hourly_rate: 40,
  });
  await s.profile(worker.id, { hourly_rate: 200 });
  const second = await s.logTime(worker.id, {
    subdivision_id: sub.id,
    hours: 1,
    date: "2026-09-13",
  });
  assert.equal(Number(second.hourly_rate), 34);
  await s.setMemberPay(owner.id, org.id, {
    user_id: worker.id,
    company_role_id: role.id,
    hourly_rate: null,
  });
  const third = await s.logTime(worker.id, {
    subdivision_id: sub.id,
    hours: 2,
    date: "2026-09-13",
  });
  assert.equal(Number(third.hourly_rate), 40);
  await s.editTime(worker.id, first.id, { hours: 3 });
  assert.equal(Number((await s.get("Timesheet", first.id)).hourly_rate), 34);
  await s.setMemberPay(owner.id, org.id, {
    user_id: owner.id,
    company_role_id: null,
    hourly_rate: 20,
  });
  await s.logTime(owner.id, {
    subdivision_id: sub.id,
    hours: 1,
    date: "2026-09-13",
  });
  const costs = await s.costs(client.id, sub.id);
  assert.equal(Number(costs.labor_cost), 236);
  assert.equal(costs.labor.length, 3);
  assert.equal(costs.labor.filter((r) => r.user_id === worker.id).length, 2);
  assert.equal(costs.labor.filter((r) => r.user_id === owner.id).length, 1);
  const report = await s.orgDashboard(owner.id, org.id, {
    from: "2026-09-13",
    to: "2026-09-13",
  });
  assert.equal(Number(report.labor_cost), 236);
  assert.deepEqual(
    report.entries.map((e) => Number(e.hourly_rate)).sort(),
    [20, 34, 40],
  );
  assert.equal((await s.get("JobApplication", app.id)).negotiation.length, 5);
});

test("company roles stay within an organization and zero pay overrides role defaults", async () => {
  const { worker: owner, organization: org, sub } = await work(true);
  const other = await s.createOrg(owner.id, { name: "Other company" });
  const role = await s.saveCompanyRole(owner.id, org.id, null, {
    name: "Trainee",
    hourly_rate: 20,
  });
  const stranger = await user();
  await reject(
    () =>
      s.saveCompanyRole(stranger.id, org.id, role.id, {
        name: "Hijacked",
        hourly_rate: 999,
      }),
    403,
  );
  await reject(
    () =>
      s.saveCompanyRole(owner.id, other.id, role.id, {
        name: "Wrong org",
        hourly_rate: 40,
      }),
    403,
  );
  await reject(
    () =>
      s.postJob(owner.id, {
        org_id: other.id,
        company_role_id: role.id,
        title: "Invalid",
        description: "Invalid",
      }),
    403,
  );
  await reject(
    () =>
      s.setMemberPay(owner.id, other.id, {
        user_id: owner.id,
        company_role_id: role.id,
        hourly_rate: 30,
      }),
    403,
  );
  await assert.rejects(() =>
    s.saveCompanyRole(owner.id, org.id, null, {
      name: "Invalid",
      hourly_rate: -1,
    }),
  );
  await assert.rejects(() => s.apply(stranger.id, 1, { desired_rate: 10.001 }));
  await s.setMemberPay(owner.id, org.id, {
    user_id: owner.id,
    company_role_id: role.id,
    hourly_rate: 0,
  });
  const entry = await s.logTime(owner.id, {
    subdivision_id: sub.id,
    hours: 1,
    date: "2026-09-13",
  });
  assert.equal(Number(entry.hourly_rate), 0);
  const otherMember = await s.member(owner.id, other.id);
  assert.equal(otherMember.hourly_rate, null);
});

test("organization types persist independently from access roles", async () => {
  const owner = await user(),
    outsider = await user();
  const org = await s.createOrg(owner.id, {
    name: "Flexible team",
    organization_types: ["contractor", "supplier", "labor_union"],
  });
  assert.deepEqual(org.organization_types, [
    "contractor",
    "supplier",
    "labor_union",
  ]);
  await s.editOrg(owner.id, org.id, {
    name: "Flexible team",
    organization_types: ["supplier"],
  });
  assert.deepEqual((await s.get("Organization", org.id)).organization_types, [
    "supplier",
  ]);
  await s.editOrg(owner.id, org.id, { name: "Renamed" });
  assert.deepEqual((await s.get("Organization", org.id)).organization_types, [
    "supplier",
  ]);
  await reject(
    () =>
      s.editOrg(outsider.id, org.id, {
        name: "Hijacked",
        organization_types: [],
      }),
    403,
  );
  await assert.rejects(() =>
    s.createOrg(owner.id, { name: "Invalid", organization_types: ["admin"] }),
  );
});

test("notifications are transactional, private, and retain read state", async () => {
  const owner = await user(),
    applicant = await user();
  const job = await s.postJob(owner.id, {
    title: "Installer",
    description: "Install fixtures",
    hourly_rate: 30,
  });
  const application = await s.apply(applicant.id, job.id);
  const notifications = () =>
    database.models.Notification.findAll({ where: { user_id: owner.id } });
  assert.equal((await notifications()).length, 1);
  await assert.rejects(() => s.apply(applicant.id, job.id));
  assert.equal((await notifications()).length, 1);
  await s.applicationAction(owner.id, application.id, "offered", {
    offered_rate: 32,
  });
  const login = async (u) => {
    const agent = request.agent(runtime.app);
    const csrf = (await agent.get("/api/auth/csrf")).body.csrf_token;
    const response = await agent
      .post("/api/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ email: u.email, password: "test-password-123" })
      .expect(200);
    return { agent, token: response.body.csrf_token };
  };
  const a = await login(applicant),
    b = await login(owner);
  const inbox = (await a.agent.get("/api/notifications").expect(200)).body;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].title, "Application offered");
  await b.agent
    .patch(`/api/notifications/${inbox[0].id}`)
    .set("X-CSRF-Token", b.token)
    .send({})
    .expect(404);
  await a.agent
    .patch(`/api/notifications/${inbox[0].id}`)
    .set("X-CSRF-Token", a.token)
    .send({})
    .expect(200);
  assert.equal(
    (await a.agent.get("/api/notifications/unread-count")).body.count,
    0,
  );
  assert.equal(
    (await a.agent.get("/api/notifications?unread=true")).body.length,
    0,
  );
  assert.ok((await a.agent.get("/api/notifications")).body[0].read_at);
  await b.agent
    .patch("/api/notifications/read-all")
    .set("X-CSRF-Token", b.token)
    .send({})
    .expect(200);
  assert.equal(
    (await b.agent.get("/api/notifications/unread-count")).body.count,
    0,
  );
});

const { BillingService, fingerprint } = require("../../backend/billing.cjs");
const { randomUUID } = require("node:crypto");
const billing = () => new BillingService(s);
async function applicationFor(
  w,
  from = "2026-01-01",
  to = "2026-01-31",
  extra = {},
) {
  const data = {
    from,
    to,
    retainage_percent: 5,
    stored_materials: 0,
    ...extra,
  };
  const snapshot = await billing().preview(w.worker.id, w.sub.id, data);
  return billing().submitApplication(w.worker.id, w.sub.id, {
    ...data,
    expected: fingerprint(snapshot),
  });
}
test("billing requires counterparty acceptance and preserves commercial history", async () => {
  const w = await work(),
    stranger = await user();
  await reject(() => billing().detail(stranger.id, w.sub.id), 403);
  const co = await billing().propose(w.worker.id, w.sub.id, {
    title: "Added landing",
    description: "Extend landing by two feet",
    amount: 250.01,
    schedule_days: 2,
  });
  assert.equal(
    (await billing().detail(w.client.id, w.sub.id)).totals.contract_value,
    "1000.00",
  );
  await reject(
    () => billing().decideChange(w.worker.id, co.id, { status: "accepted" }),
    403,
  );
  await billing().decideChange(w.client.id, co.id, {
    status: "accepted",
    note: "Agreed",
  });
  const detail = await billing().detail(w.worker.id, w.sub.id);
  assert.equal(detail.totals.contract_value, "1250.01");
  assert.equal(detail.totals.schedule_days, 2);
  assert.equal(detail.change_orders[0].decided_by_user_id, w.client.id);
  assert.equal(detail.change_orders[0].decision_note, "Agreed");
  await reject(
    () => billing().decideChange(w.client.id, co.id, { status: "accepted" }),
    409,
  );
  const decrease = await billing().propose(w.client.id, w.sub.id, {
    title: "Deduct",
    description: "Remove work",
    amount: -1500,
  });
  await reject(
    () =>
      billing().decideChange(w.worker.id, decrease.id, { status: "accepted" }),
    409,
  );
  await billing().decideChange(w.worker.id, decrease.id, {
    status: "rejected",
    note: "Price below zero",
  });
});
test("progress applications snapshot source rates, reject stale previews, and carry retainage without double billing", async () => {
  const w = await work();
  await s.profile(w.worker.id, { hourly_rate: 50.01 });
  await s.logTime(w.worker.id, {
    subdivision_id: w.sub.id,
    hours: 2,
    date: "2026-01-10",
  });
  const data = {
    from: "2026-01-01",
    to: "2026-01-31",
    stored_materials: 20,
    retainage_percent: 5,
  };
  const snapshot = await billing().preview(w.worker.id, w.sub.id, data);
  assert.equal(snapshot.labor_cost, "100.02");
  assert.equal(snapshot.retainage, "6.00");
  assert.equal(snapshot.amount_due, "114.02");
  await s.logTime(w.worker.id, {
    subdivision_id: w.sub.id,
    hours: 1,
    date: "2026-01-11",
  });
  await reject(
    () =>
      billing().submitApplication(w.worker.id, w.sub.id, {
        ...data,
        expected: fingerprint(snapshot),
      }),
    409,
  );
  const a = await applicationFor(w);
  assert.equal(a.snapshot.amount_due, "142.53");
  await reject(
    () =>
      billing().decideApplication(w.worker.id, a.id, { status: "approved" }),
    403,
  );
  await reject(() => applicationFor(w), 409);
  await billing().decideApplication(w.client.id, a.id, { status: "approved" });
  await reject(() => applicationFor(w), 409);
  await s.profile(w.worker.id, { hourly_rate: 60 });
  await s.logTime(w.worker.id, {
    subdivision_id: w.sub.id,
    hours: 1,
    date: "2026-02-11",
  });
  const second = await applicationFor(w, "2026-02-01", "2026-02-28");
  assert.equal(second.snapshot.previous_certified, "142.53");
  assert.equal(second.snapshot.previous_payments, "0.00");
  assert.equal(second.snapshot.labor_cost, "210.03");
  assert.equal(second.snapshot.amount_due, "57.00");
  await billing().decideApplication(w.client.id, second.id, {
    status: "approved",
  });
  await s.subdivisionStatus(w.client.id, w.sub.id, { status: "completed" });
  const closeout = await applicationFor(w, "2026-03-01", "2026-03-31", {
    retainage_percent: 0,
  });
  assert.equal(closeout.snapshot.amount_due, "10.50");
  await billing().decideApplication(w.client.id, closeout.id, {
    status: "approved",
  });
  const detail = await billing().detail(w.client.id, w.sub.id);
  assert.equal(detail.totals.certified, "210.03");
  assert.equal(detail.totals.retainage, "0.00");
  assert.equal(
    detail.applications[0].snapshot.sources.labor[0].hourly_rate,
    "50.01",
  );
});
test("external payments serialize balance checks, retry safely, and use append-only reversals", async () => {
  const w = await work();
  await s.profile(w.worker.id, { hourly_rate: 100 });
  await s.logTime(w.worker.id, {
    subdivision_id: w.sub.id,
    hours: 1,
    date: "2026-01-05",
  });
  const a = await applicationFor(w);
  const data = {
    amount: 60,
    paid_on: "2026-02-01",
    reference: "CHECK-001",
    request_key: randomUUID(),
  };
  await reject(() => billing().recordPayment(w.client.id, a.id, data), 409);
  await billing().decideApplication(w.client.id, a.id, { status: "approved" });
  await reject(() => billing().recordPayment(w.worker.id, a.id, data), 403);
  const results = await Promise.allSettled([
    billing().recordPayment(w.client.id, a.id, data),
    billing().recordPayment(w.client.id, a.id, {
      ...data,
      request_key: randomUUID(),
      reference: "CHECK-002",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  const payment = results.find((r) => r.status === "fulfilled").value;
  const retry = {
    amount: 60,
    paid_on: payment.paid_on,
    reference: payment.reference,
    request_key: payment.request_key,
  };
  assert.equal(
    (await billing().recordPayment(w.client.id, a.id, retry)).id,
    payment.id,
  );
  await reject(
    () => billing().recordPayment(w.client.id, a.id, { ...retry, amount: 1 }),
    409,
  );
  assert.equal(
    (await billing().detail(w.client.id, w.sub.id)).totals.outstanding,
    "35.00",
  );
  await assert.rejects(
    () =>
      database.models.BillingPayment.update(
        { amount: 1 },
        { where: { id: payment.id } },
      ),
    /append-only/,
  );
  const reversal = { note: "Wrong check reference", request_key: randomUUID() };
  await billing().reversePayment(w.client.id, payment.id, reversal);
  await billing().reversePayment(w.client.id, payment.id, reversal);
  const detail = await billing().detail(w.client.id, w.sub.id);
  assert.equal(detail.payments.length, 2);
  assert.equal(detail.totals.paid, "0.00");
  assert.equal(detail.totals.outstanding, "95.00");
  await reject(
    () =>
      billing().reversePayment(w.client.id, payment.id, {
        ...reversal,
        request_key: randomUUID(),
      }),
    409,
  );
});
test("subcontract billing is approved by the immediate payer, with project-client read access only", async () => {
  const w = await work(true),
    childWorker = await user(),
    member = await user();
  const [child] = await s.addChild(w.worker.id, w.sub.id, {
    scopes: ["Child contract"],
  });
  const bid = await s.submitBid(childWorker.id, child.id, { amount: 200 });
  await s.award(w.worker.id, bid.id);
  const co = await billing().propose(childWorker.id, child.id, {
    title: "Adjustment",
    description: "More work",
    amount: 10,
  });
  await reject(
    () => billing().decideChange(w.client.id, co.id, { status: "accepted" }),
    403,
  );
  await database.models.OrganizationMember.create({
    user_id: member.id,
    org_id: w.organization.id,
    internal_role: "member",
  });
  await reject(() => billing().detail(member.id, child.id), 403);
  await billing().decideChange(w.worker.id, co.id, { status: "accepted" });
  const detail = await billing().detail(w.client.id, child.id);
  assert.deepEqual(detail.permissions, { payer: false, contractor: false });
  assert.equal(detail.totals.contract_value, "210.00");
  const co2 = await billing().propose(w.worker.id, child.id, {
    title: "Reduced work",
    description: "Deduct work",
    amount: -5,
  });
  await billing().decideChange(childWorker.id, co2.id, { status: "accepted" });
  assert.equal(
    (await billing().detail(childWorker.id, child.id)).totals.contract_value,
    "205.00",
  );
});

test("billing reconciles saved material costs and preserves approved snapshots after corrections", async () => {
  const w = await work();
  const item = await s.addItem(w.worker.id, {
    item_name: "Board",
    stock: 10,
    unit_cost: 12.34,
  });
  const usage = await s.consume(w.worker.id, w.sub.id, {
    item_id: item.id,
    qty: 2,
  });
  // The fixture uses a historical consumption date so billing is deterministic.
  await database.models.ProjectInventory.update(
    { consumed_at: "2026-01-15T12:00:00Z" },
    { where: { id: usage.id } },
  );
  await s.profile(w.worker.id, { hourly_rate: 20 });
  const time = await s.logTime(w.worker.id, {
    subdivision_id: w.sub.id,
    date: "2026-01-15",
    hours: 1,
  });
  const a = await applicationFor(w);
  assert.equal(a.snapshot.material_cost, "24.68");
  assert.equal(a.snapshot.labor_cost, "20.00");
  assert.equal(a.snapshot.amount_due, "42.45");
  await billing().decideApplication(w.client.id, a.id, { status: "approved" });
  const co = await billing().propose(w.worker.id, w.sub.id, {
    title: "Deduct",
    description: "Remove nearly all work",
    amount: -990,
  });
  await reject(
    () => billing().decideChange(w.client.id, co.id, { status: "accepted" }),
    409,
  );
  await database.models.Timesheet.update(
    { hours: 2 },
    { where: { id: time.id } },
  );
  assert.equal(
    (await billing().detail(w.client.id, w.sub.id)).applications[0].snapshot
      .labor_cost,
    "20.00",
  );
  const listing = await billing().list(w.worker.id, { project_id: w.p.id });
  assert.equal(listing.length, 1);
  assert.equal(listing[0].certified, "42.45");
  const stranger = await user();
  assert.equal(
    (await billing().list(stranger.id, { project_id: w.p.id })).length,
    0,
  );
});
