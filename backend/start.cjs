const { Op } = require("sequelize");
const { createDatabase, migrate } = require("./database.cjs");
const { createApp } = require("./app.cjs");
const { createStripeProvider } = require("./payments.cjs");
// Advisory only: warns if fixtures that look like QA/test data are visible in a
// production database (see the field review's finding on shared QA/prod data).
// Never blocks startup — a false positive here must not take the app down.
async function warnOnQaFixtures(models) {
  try {
    const count = await models.Project.count({
      where: {
        [Op.or]: [
          { title: { [Op.iLike]: "QA-%" } },
          { title: { [Op.iLike]: "%test only%" } },
        ],
      },
    });
    if (count > 0)
      console.warn(
        `WARNING: ${count} project(s) with QA/test-looking titles are visible in this database. ` +
          "If this is production, remove them and keep QA fixtures in a separate database.",
      );
  } catch {
    // Best-effort check; never fail startup over it.
  }
}
async function main() {
  const database = createDatabase(process.env.DATABASE_URL);
  try {
    await migrate(database.db);
    if (process.argv.includes("--migrate")) {
      await database.db.close();
      return;
    }
    if (process.env.NODE_ENV === "production")
      await warnOnQaFixtures(database.models);
    const runtime = createApp(database, {
      databaseUrl: process.env.DATABASE_URL,
      sessionSecret: process.env.SESSION_SECRET,
      production: process.env.NODE_ENV === "production",
      paymentProvider: createStripeProvider({
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        live: process.env.PAYMENTS_LIVE === "true",
      }),
      appUrl: process.env.APP_URL,
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
