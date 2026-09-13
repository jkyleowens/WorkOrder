// Vercel serverless entry point. Reuses one Express app instance and one
// database connection pool per warm lambda container; runs migrations once
// per cold start (guarded so concurrent cold invocations don't race).
const { createDatabase, migrate } = require("../backend/database.cjs");
const { createApp } = require("../backend/app.cjs");

let appPromise;

async function bootstrap() {
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;
  const production = process.env.NODE_ENV === "production";
  const database = createDatabase(databaseUrl, { ssl: production });
  await migrate(database.db);
  const runtime = createApp(database, {
    databaseUrl,
    sessionSecret,
    production,
    // Vercel terminates TLS and forwards the original protocol/host; trust
    // its proxy so secure cookies and req.protocol behave correctly.
    trustProxy: 1,
  });
  return runtime.app;
}

module.exports = async (req, res) => {
  if (!appPromise) appPromise = bootstrap().catch((error) => {
    appPromise = undefined;
    throw error;
  });
  try {
    const app = await appPromise;
    app(req, res);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
};
module.exports.config = { maxDuration: 30 };
