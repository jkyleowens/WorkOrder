// Opaque, database-checked bearer tokens for native (Capacitor) clients.
//
// WKWebView drops cross-site cookies, so an app served from capacitor://localhost
// cannot use the cookie session the web console relies on. Native clients send
// `Authorization: Bearer <access token>` instead.
//
// Deliberately NOT JWT: every authenticated request already loads the user row
// from PostgreSQL, so a stateless token buys no saved round trip while making
// revocation hard. Tokens are random 256-bit secrets and only their SHA-256
// hashes are persisted, so a database leak cannot be replayed against the API.
const { createHash, randomBytes } = require("node:crypto");
const { QueryTypes } = require("sequelize");
const { check } = require("./validation.cjs");
const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 86400000; // 30 days
const DEFAULT_CONTEXT = { mode: "personal" };
const hash = (raw) => createHash("sha256").update(String(raw)).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const label = (value) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null;
function createTokenStore(db) {
  const select = (sql, bind, transaction) =>
    db.query(sql, { bind, transaction, type: QueryTypes.SELECT });
  const write = (sql, bind, transaction) =>
    db.query(sql, { bind, transaction, type: QueryTypes.UPDATE });
  async function insert(
    { userId, context, deviceLabel, accessRaw, refreshRaw },
    transaction,
  ) {
    const [row] = await select(
      `INSERT INTO auth_tokens
         (user_id, refresh_hash, access_hash, context, device_label,
          access_expires_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5,
               now() + ($6 || ' milliseconds')::interval,
               now() + ($7 || ' milliseconds')::interval)
       RETURNING id, user_id, context`,
      [
        userId,
        hash(refreshRaw),
        hash(accessRaw),
        JSON.stringify(context || DEFAULT_CONTEXT),
        deviceLabel,
        String(ACCESS_TTL_MS),
        String(REFRESH_TTL_MS),
      ],
      transaction,
    );
    return row;
  }
  const payload = (row, accessRaw, refreshRaw) => ({
    token_type: "Bearer",
    access_token: accessRaw,
    refresh_token: refreshRaw,
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_expires_in: Math.floor(REFRESH_TTL_MS / 1000),
    context: row.context,
  });
  // Refresh-token reuse detection: a revoked refresh token means the secret
  // leaked, so the whole rotation chain (earlier and later links alike) burns.
  async function revokeChain(tokenId, transaction) {
    await write(
      `WITH RECURSIVE chain AS (
           SELECT id, replaced_by FROM auth_tokens WHERE id = $1
         UNION
           SELECT t.id, t.replaced_by FROM auth_tokens t
             JOIN chain c ON t.id = c.replaced_by OR t.replaced_by = c.id
       )
       UPDATE auth_tokens SET revoked_at = now()
         WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL`,
      [tokenId],
      transaction,
    );
  }
  return {
    // Mint a fresh pair for a user who just proved their password.
    async issue(userId, { deviceLabel, context } = {}) {
      const accessRaw = secret(),
        refreshRaw = secret();
      const row = await insert({
        userId,
        context: context || DEFAULT_CONTEXT,
        deviceLabel: label(deviceLabel),
        accessRaw,
        refreshRaw,
      });
      return payload(row, accessRaw, refreshRaw);
    },
    // One statement: validates the token and stamps last_used_at in a single
    // round trip, so bearer auth costs no more than the session lookup did.
    async resolveAccess(raw) {
      if (!raw) return null;
      const [row] = await select(
        `UPDATE auth_tokens SET last_used_at = now()
           WHERE access_hash = $1
             AND revoked_at IS NULL
             AND access_expires_at > now()
         RETURNING id, user_id, context`,
        [hash(raw)],
      );
      return row || null;
    },
    revokeChain,
    async revoke(tokenId) {
      await write(
        "UPDATE auth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        [tokenId],
      );
    },
    async setContext(tokenId, context) {
      await write("UPDATE auth_tokens SET context = $1::jsonb WHERE id = $2", [
        JSON.stringify(context),
        tokenId,
      ]);
    },
    // Rotation: the presented refresh token is retired and points at its
    // replacement, so a later replay is recognisable as reuse.
    async refresh(raw, { deviceLabel } = {}) {
      check(raw && typeof raw === "string", 401, "Invalid refresh token");
      // Reuse revocation must outlive the rollback this rotation triggers, so
      // the chain is burned after the transaction unwinds, never inside it.
      let reused = null;
      try {
        return await db.transaction(async (transaction) => {
          const [row] = await select(
            `SELECT id, user_id, context, device_label, revoked_at,
                    expires_at <= now() AS expired
               FROM auth_tokens WHERE refresh_hash = $1 FOR UPDATE`,
            [hash(raw)],
            transaction,
          );
          check(row, 401, "Invalid refresh token");
          if (row.revoked_at) {
            reused = row.id;
            check(false, 401, "Refresh token reuse detected; session revoked");
          }
          check(!row.expired, 401, "Refresh token expired");
          const accessRaw = secret(),
            refreshRaw = secret();
          const next = await insert(
            {
              userId: row.user_id,
              context: row.context,
              deviceLabel: label(deviceLabel) ?? row.device_label,
              accessRaw,
              refreshRaw,
            },
            transaction,
          );
          await write(
            "UPDATE auth_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1",
            [row.id, next.id],
            transaction,
          );
          return payload(next, accessRaw, refreshRaw);
        });
      } finally {
        if (reused) await revokeChain(reused);
      }
    },
  };
}
module.exports = {
  createTokenStore,
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  DEFAULT_CONTEXT,
};
