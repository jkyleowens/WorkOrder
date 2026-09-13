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
  assert.equal(rows[0].n, 3);
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
