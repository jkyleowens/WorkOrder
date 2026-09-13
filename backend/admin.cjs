// Grants or revokes platform administrator access (credential review and dispute mediation).
// Usage: npm run admin -- grant person@example.com
const { createDatabase } = require("./database.cjs");
async function main() {
  const [command, email] = process.argv.slice(2);
  if (!["grant", "revoke"].includes(command) || !email) {
    console.error("Usage: npm run admin -- grant|revoke <email>");
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  const database = createDatabase(url, {
    ssl:
      process.env.NODE_ENV === "production" &&
      !/localhost|127\.0\.0\.1/.test(url || ""),
  });
  try {
    const [rows] = await database.db.query(
      "UPDATE users SET platform_role=$1 WHERE email=$2 RETURNING id",
      { bind: [command === "grant" ? "admin" : "user", email.toLowerCase()] },
    );
    if (!rows.length) {
      console.error("No account uses that email address");
      process.exitCode = 1;
    } else
      console.log(
        `${email} ${command === "grant" ? "is now a platform administrator" : "is no longer a platform administrator"}`,
      );
  } finally {
    await database.db.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
