// Shared isolated PostgreSQL fixture for backend suites added after platform.test.cjs.
const { before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createDatabase, migrate } = require("../../backend/database.cjs");
const { PlatformService } = require("../../backend/services.cjs");
const { createApp } = require("../../backend/app.cjs");
function setup(appOptions = {}) {
  const ctx = { serial: 0 };
  let pg, dir;
  before(
    async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "workorder-tests-"));
      const probe = net.createServer();
      await new Promise((r, j) => {
        probe.once("error", j);
        probe.listen(0, "127.0.0.1", r);
      });
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
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
      ctx.url = `postgres://postgres:test-password@127.0.0.1:${port}/workorder_test`;
      ctx.database = createDatabase(ctx.url);
      await migrate(ctx.database.db);
      ctx.s = new PlatformService(ctx.database);
      ctx.runtime = createApp(ctx.database, {
        databaseUrl: ctx.url,
        sessionSecret: "test-secret-0123456789-0123456789-0123456789",
        authLimit: 1000,
        logger: { error: console.error, warn: () => {} },
        ...(typeof appOptions === "function" ? appOptions(ctx) : appOptions),
      });
    },
    { timeout: 60000 },
  );
  after(async () => {
    if (ctx.runtime) await ctx.runtime.close();
    if (ctx.database) await ctx.database.db.close();
    if (pg) await pg.stop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });
  ctx.user = () =>
    ctx.s.register({
      full_name: `Test Person ${ctx.serial + 1}`,
      email: `user${++ctx.serial}@example.com`,
      password: "test-password-123",
    });
  ctx.reject = (fn, status) =>
    assert.rejects(fn, (e) => {
      if (e.status !== status)
        throw new Error(`Expected ${status}, got ${e.status}: ${e.message}`);
      return true;
    });
  ctx.work = async (org = false, amount = 1000) => {
    const client = await ctx.user(),
      worker = await ctx.user();
    let organization;
    if (org)
      organization = await ctx.s.createOrg(worker.id, { name: "Acme" });
    const p = await ctx.s.postProject(client.id, { title: "Driveway" });
    const sub = p.subdivisions[0];
    const bid = await ctx.s.submitBid(worker.id, sub.id, {
      amount,
      ...(org ? { org_id: organization.id } : {}),
    });
    await ctx.s.award(client.id, bid.id);
    return { client, worker, organization, p, sub, bid };
  };
  return ctx;
}
module.exports = { setup };
