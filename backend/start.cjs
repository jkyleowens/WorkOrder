const { createDatabase, migrate } = require("./database.cjs");
const { createApp } = require("./app.cjs");
async function main() {
  const database = createDatabase(process.env.DATABASE_URL);
  try {
    await migrate(database.db);
    if (process.argv.includes("--migrate")) {
      await database.db.close();
      return;
    }
    const runtime = createApp(database, {
      databaseUrl: process.env.DATABASE_URL,
      sessionSecret: process.env.SESSION_SECRET,
      production: process.env.NODE_ENV === "production",
    });
    const server = runtime.app.listen(
      Number(process.env.PORT || 3000),
      process.env.HOST || "127.0.0.1",
      () =>
        console.log(
          "WorkOrder API listening on port " + (process.env.PORT || 3000),
        ),
    );
    const shutdown = () =>
      server.close(async () => {
        await runtime.close();
        await database.db.close();
      });
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    await database.db.close();
    throw error;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
