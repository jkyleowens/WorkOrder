const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createDatabase, migrate } = require("../../backend/database.cjs");
const { createApp } = require("../../backend/app.cjs");
async function main() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workorder-browser-"));
  const postgres = new EmbeddedPostgres({
    databaseDir: path.join(dir, "db"),
    port,
    user: "postgres",
    password: "browser-tests",
    persistent: false,
    postgresFlags: ["-h", "127.0.0.1", "-k", dir],
    onLog: () => {},
    onError: () => {},
  });
  let database, runtime, server;
  const cleanup = async () => {
    if (server) await new Promise((r) => server.close(r));
    if (runtime) await runtime.close();
    if (database) await database.db.close();
    await postgres.stop();
    await fs.rm(dir, { recursive: true, force: true });
  };
  process.once("SIGTERM", () => cleanup().then(() => process.exit()));
  process.once("SIGINT", () => cleanup().then(() => process.exit()));
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("console_test");
    const url = `postgres://postgres:browser-tests@127.0.0.1:${port}/console_test`;
    database = createDatabase(url);
    await migrate(database.db);
    runtime = createApp(database, {
      databaseUrl: url,
      sessionSecret: "browser-tests-secret-0123456789-0123456789",
      authLimit: 1000,
    });
    server = runtime.app.listen(3210, "127.0.0.1", () =>
      console.log("Browser test app ready"),
    );
  } catch (e) {
    await cleanup();
    throw e;
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
