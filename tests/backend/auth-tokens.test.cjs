// Bearer tokens for the native (Capacitor) apps: issuance, rotation, reuse
// detection, CSRF exemption boundaries, context isolation and CORS preflight.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createHash } = require("node:crypto");
const { setup } = require("./harness.cjs");
const ctx = setup();
const PASSWORD = "test-password-123";
const sha256 = (raw) => createHash("sha256").update(raw).digest("hex");
const app = () => ctx.runtime.app;
const issue = async (user, extra = {}) => {
  const r = await request(app())
    .post("/api/auth/token")
    .send({ email: user.email, password: PASSWORD, ...extra })
    .expect(200);
  return r.body;
};
// A cookie-session agent, the way the web console authenticates.
const webAgent = async (user) => {
  const agent = request.agent(app());
  const csrf = (await agent.get("/api/auth/csrf").expect(200)).body.csrf_token;
  const r = await agent
    .post("/api/auth/login")
    .set("X-CSRF-Token", csrf)
    .send({ email: user.email, password: PASSWORD })
    .expect(200);
  return { agent, csrf: r.body.csrf_token };
};
test("password exchange issues a bearer pair that authenticates without cookies", async () => {
  const user = await ctx.user();
  const body = await issue(user, { device_label: "Pixel 8 — crew lead" });
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.user.id, user.id);
  assert.equal(body.user.password_hash, undefined);
  assert.ok(body.access_token && body.refresh_token);
  assert.notEqual(body.access_token, body.refresh_token);
  assert.deepEqual(body.context, { mode: "personal" });
  assert.ok(body.expires_in > 0 && body.refresh_expires_in > body.expires_in);
  // No Set-Cookie at all: the native client never gets a session.
  const me = await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${body.access_token}`)
    .expect(200);
  assert.equal(me.headers["set-cookie"], undefined);
  assert.equal(me.body.user.id, user.id);
  // Raw tokens are never persisted, only their SHA-256 hashes.
  const [row] = await ctx.database.db.query(
    "SELECT device_label, last_used_at, refresh_hash, access_hash FROM auth_tokens WHERE user_id = $1",
    { bind: [user.id], type: "SELECT" },
  );
  assert.equal(row.device_label, "Pixel 8 — crew lead");
  assert.ok(row.last_used_at);
  for (const stored of [row.refresh_hash, row.access_hash]) {
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.notEqual(stored, body.access_token);
    assert.notEqual(stored, body.refresh_token);
  }
  await request(app())
    .post("/api/auth/token")
    .send({ email: user.email, password: "wrong-password-123" })
    .expect(401);
  await request(app())
    .get("/api/me")
    .set("Authorization", "Bearer not-a-real-token")
    .expect(401);
  await request(app()).get("/api/me").expect(401);
});
test("CSRF is skipped for cookieless bearer writes and still enforced with a session cookie", async () => {
  const user = await ctx.user();
  const { access_token } = await issue(user);
  // No cookie jar, no CSRF token, and the write still lands.
  await request(app())
    .patch("/api/me")
    .set("Authorization", `Bearer ${access_token}`)
    .send({ full_name: "Field Lead" })
    .expect(200);
  // The cookie session keeps its CSRF requirement untouched.
  const web = await webAgent(user);
  await web.agent.patch("/api/me").send({ full_name: "No" }).expect(403);
  await web.agent
    .patch("/api/me")
    .set("X-CSRF-Token", web.csrf)
    .send({ full_name: "Yes" })
    .expect(200);
  // Cookie present means CSRF applies even when a bearer token rides along:
  // the exemption is what makes the cookieless case safe.
  await web.agent
    .patch("/api/me")
    .set("Authorization", `Bearer ${access_token}`)
    .send({ full_name: "Nope" })
    .expect(403);
  // Login itself no longer 403s for a client with no cookie jar.
  await request(app())
    .post("/api/auth/login")
    .send({ email: user.email, password: PASSWORD })
    .expect(200);
});
test("refreshing rotates the pair and retires the presented token", async () => {
  const user = await ctx.user();
  const first = await issue(user, { device_label: "iPhone" });
  const second = await request(app())
    .post("/api/auth/token/refresh")
    .send({ refresh_token: first.refresh_token })
    .expect(200);
  assert.notEqual(second.body.access_token, first.access_token);
  assert.notEqual(second.body.refresh_token, first.refresh_token);
  await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${second.body.access_token}`)
    .expect(200);
  // The rotated-away access token dies with its row.
  await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${first.access_token}`)
    .expect(401);
  const [row] = await ctx.database.db.query(
    "SELECT revoked_at, replaced_by, device_label FROM auth_tokens WHERE refresh_hash = $1",
    { bind: [sha256(first.refresh_token)], type: "SELECT" },
  );
  assert.ok(row.revoked_at);
  assert.ok(row.replaced_by);
  assert.equal(row.device_label, "iPhone");
  await request(app())
    .post("/api/auth/token/refresh")
    .send({ refresh_token: "nonsense" })
    .expect(401);
});
test("replaying a rotated refresh token burns the whole chain", async () => {
  const user = await ctx.user();
  const first = await issue(user);
  const second = (
    await request(app())
      .post("/api/auth/token/refresh")
      .send({ refresh_token: first.refresh_token })
      .expect(200)
  ).body;
  const third = (
    await request(app())
      .post("/api/auth/token/refresh")
      .send({ refresh_token: second.refresh_token })
      .expect(200)
  ).body;
  await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${third.access_token}`)
    .expect(200);
  // Reuse of the oldest refresh token: the leak invalidates every link.
  await request(app())
    .post("/api/auth/token/refresh")
    .send({ refresh_token: first.refresh_token })
    .expect(401);
  await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${third.access_token}`)
    .expect(401);
  await request(app())
    .post("/api/auth/token/refresh")
    .send({ refresh_token: third.refresh_token })
    .expect(401);
  const [{ live }] = await ctx.database.db.query(
    "SELECT count(*)::int AS live FROM auth_tokens WHERE user_id = $1 AND revoked_at IS NULL",
    { bind: [user.id], type: "SELECT" },
  );
  assert.equal(live, 0);
});
test("logout revokes only the presenting token", async () => {
  const user = await ctx.user();
  const phone = await issue(user, { device_label: "phone" });
  const tablet = await issue(user, { device_label: "tablet" });
  await request(app())
    .post("/api/auth/logout")
    .set("Authorization", `Bearer ${phone.access_token}`)
    .expect(204);
  await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${phone.access_token}`)
    .expect(401);
  await request(app())
    .post("/api/auth/token/refresh")
    .send({ refresh_token: phone.refresh_token })
    .expect(401);
  await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${tablet.access_token}`)
    .expect(200);
});
test("token context is per credential and survives rotation, and a demotion persists", async () => {
  const user = await ctx.user();
  const org = await ctx.s.createOrg(user.id, { name: "Bearer Builders" });
  const web = await webAgent(user);
  const token = await issue(user);
  const bearer = () => ({ Authorization: `Bearer ${token.access_token}` });
  const switched = await request(app())
    .put("/api/context")
    .set(bearer())
    .send({ mode: "organization", org_id: org.id })
    .expect(200);
  assert.deepEqual(switched.body, { mode: "organization", org_id: org.id });
  const onPhone = await request(app()).get("/api/me").set(bearer()).expect(200);
  assert.equal(onPhone.body.context.mode, "organization");
  // Intended: the phone switching to organization mode leaves the desktop
  // session in personal mode. Each credential carries its own context.
  const onDesktop = await web.agent.get("/api/me").expect(200);
  assert.deepEqual(onDesktop.body.context, { mode: "personal" });
  // Rotation carries the context forward.
  const rotated = (
    await request(app())
      .post("/api/auth/token/refresh")
      .send({ refresh_token: token.refresh_token })
      .expect(200)
  ).body;
  assert.equal(rotated.context.mode, "organization");
  // Losing management rights downgrades the token row itself, not just this
  // request, so an app restart cannot resurrect organization mode.
  await ctx.database.models.OrganizationMember.update(
    { internal_role: "member" },
    { where: { user_id: user.id, org_id: org.id } },
  );
  const after = await request(app())
    .get("/api/me")
    .set("Authorization", `Bearer ${rotated.access_token}`)
    .expect(200);
  assert.deepEqual(after.body.context, { mode: "personal" });
  const [row] = await ctx.database.db.query(
    "SELECT context FROM auth_tokens WHERE access_hash = $1",
    { bind: [sha256(rotated.access_token)], type: "SELECT" },
  );
  assert.deepEqual(row.context, { mode: "personal" });
});
test("CORS preflight answers native origins before routing can 404 it", async () => {
  const preflight = await request(app())
    .options("/api/auth/token")
    .set("Origin", "capacitor://localhost")
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "authorization, content-type")
    .expect(204);
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    "capacitor://localhost",
  );
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  assert.match(
    preflight.headers["access-control-allow-headers"],
    /Authorization/,
  );
  assert.match(
    preflight.headers["access-control-allow-headers"],
    /X-CSRF-Token/,
  );
  assert.match(preflight.headers["access-control-allow-methods"], /PATCH/);
  assert.match(preflight.headers.vary || "", /Origin/);
  for (const origin of ["http://localhost", "https://localhost"]) {
    const r = await request(app())
      .options("/api/me")
      .set("Origin", origin)
      .expect(204);
    assert.equal(r.headers["access-control-allow-origin"], origin);
  }
  // Unknown origins are answered but never allowed.
  const evil = await request(app())
    .options("/api/me")
    .set("Origin", "https://evil.example")
    .expect(204);
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
  const user = await ctx.user();
  const { access_token } = await issue(user);
  const real = await request(app())
    .get("/api/me")
    .set("Origin", "capacitor://localhost")
    .set("Authorization", `Bearer ${access_token}`)
    .expect(200);
  assert.equal(
    real.headers["access-control-allow-origin"],
    "capacitor://localhost",
  );
});
