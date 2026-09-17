const { FieldService } = require("./field.cjs");
const { BillingService, fingerprint } = require("./billing.cjs");
const { FundingService } = require("./funding.cjs");
const { FileService, FILE_TYPES } = require("./files.cjs");
const { TrustService } = require("./trust.cjs");
const express = require("express");
const path = require("node:path");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { ZodError } = require("zod");
const { Op } = require("sequelize");
const { PlatformService, publicUser } = require("./services.cjs");
const { schemas, id, date, check } = require("./validation.cjs");
const { withNoVerifySsl } = require("./database.cjs");
const { createTokenStore } = require("./auth-tokens.cjs");
// Native shells load the bundled web assets from these origins; everything else
// is same-origin and never sends an Origin the browser will check.
const NATIVE_ORIGINS = [
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
];
function createApp(
  database,
  {
    sessionSecret,
    databaseUrl,
    production = false,
    authLimit = 30,
    logger = console,
    trustProxy,
    pool: sharedPool,
    paymentProvider = null,
    appUrl,
    allowedOrigins = [],
  } = {},
) {
  if (!sessionSecret || sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must have at least 32 characters");
  if (!databaseUrl)
    throw new Error("Database URL is required for the session store");
  const app = express(),
    service = new PlatformService(database),
    m = database.models;
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  const ownsPool = !sharedPool;
  const useSsl = production && !/localhost|127\.0\.0\.1/.test(databaseUrl);
  const pool =
    sharedPool ||
    new Pool({
      connectionString: useSsl ? withNoVerifySsl(databaseUrl) : databaseUrl,
      max: production ? 3 : 10,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });
  const store = new PgStore({
    pool,
    tableName: "sessions",
    pruneSessionInterval: 900,
  });
  // connect-pg-simple uses the conventional sess/expire columns, mapped by migration 002.
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": production ? [] : null },
      },
    }),
  );
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "../web/views"));
  app.get("/field", (req, res) =>
    res.sendFile(path.join(__dirname, "../web/public/field.html")),
  );
  app.get("/field-sw.js", (req, res) =>
    res
      .set("Cache-Control", "no-cache")
      .sendFile(path.join(__dirname, "../web/public/field-sw.js")),
  );
  app.use("/assets", express.static(path.join(__dirname, "../web/public")));
  const billing = new BillingService(service);
  const funding = new FundingService(service, billing, paymentProvider, {
    appUrl,
    logger,
  });
  const files = new FileService(service);
  files.rules.push((user, fileId) => service.canViewResume(user, fileId));
  const trust = new TrustService(service, billing, funding, files);
  const field = new FieldService(service, billing, files, trust);
  // Stripe signs the exact bytes it sends, so this route must read the raw body before JSON parsing.
  app.post(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) =>
      res.json(await funding.webhook(req.body, req.get("stripe-signature"))),
  );
  // CORS for the native shells. Mounted ahead of every /api route because
  // Express 5 answers unmatched OPTIONS preflights with 404 before any handler
  // further down could reply. Hand-rolled: `cors` is not a dependency here.
  const origins = new Set([...NATIVE_ORIGINS, ...allowedOrigins]);
  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");
    res.vary("Origin");
    if (origin && origins.has(origin))
      res.set({
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-CSRF-Token, X-Filename",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
      });
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use(
    session({
      name: "workorder.sid",
      secret: sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: production,
        maxAge: 7 * 86400000,
      },
    }),
  );
  const tokens = createTokenStore(database.db);
  // Native clients authenticate with `Authorization: Bearer <token>` because
  // WKWebView will not keep a cross-site cookie. This deliberately leaves
  // req.session untouched — establish() regenerates and saves the session, and
  // a faked session object would fight it.
  const TOKEN_ROUTES = new Set(["/auth/token", "/auth/token/refresh"]);
  app.use("/api", async (req, res, next) => {
    const header = req.get("authorization") || "";
    const raw = /^Bearer[ ]+(\S+)$/i.exec(header.trim())?.[1];
    // A stale access token must not block the endpoints used to replace it.
    if (!raw || TOKEN_ROUTES.has(req.path)) return next();
    const row = await tokens.resolveAccess(raw);
    check(row, 401, "Invalid or expired access token");
    req.auth = { userId: row.user_id, tokenId: row.id, context: row.context };
    next();
  });
  app.get("/", (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .render("home", { title: "WorkOrder — Your work, in order." }),
  );
  app.get(["/login", "/register", "/console"], (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .render("index", { title: "WorkOrder — Your work, in order." }),
  );
  const csrf = (req) =>
    req.session.csrf || (req.session.csrf = randomBytes(32).toString("hex"));
  app.get("/api/health", async (req, res) => {
    await database.db.authenticate();
    res.json({ status: "ok" });
  });
  app.get("/api/auth/csrf", (req, res) =>
    res.set("Cache-Control", "no-store").json({ csrf_token: csrf(req) }),
  );
  // Entry points a cookieless client must reach before it holds any token.
  const ENTRY_ROUTES = new Set([
    "/auth/login",
    "/auth/register",
    "/auth/token",
    "/auth/token/refresh",
  ]);
  const hasSessionCookie = (req) =>
    /(?:^|;\s*)workorder\.sid=/.test(req.get("cookie") || "");
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    // CSRF defends the ambient cookie session. A request that carries no
    // session cookie has no ambient authority to abuse: a cross-site form can
    // be forced, but an attacker cannot set an Authorization header — it is not
    // CORS-safelisted, so it forces a preflight this server answers.
    const exempt =
      !hasSessionCookie(req) && (req.auth || ENTRY_ROUTES.has(req.path));
    if (!exempt && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const token = Buffer.from(req.get("X-CSRF-Token") || "");
      const expected = Buffer.from(req.session.csrf || "");
      check(
        expected.length &&
          token.length === expected.length &&
          timingSafeEqual(token, expected),
        403,
        "Invalid CSRF token",
      );
    }
    next();
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: authLimit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many authentication attempts; try again later" },
  });
  // Personal/organization mode lives on whichever credential made the request:
  // the cookie session for the web console, the token row for a native client.
  // Consequence, and it is the intended one: switching to organization mode on
  // the phone does NOT switch the same user's desktop session, and vice versa.
  // Each credential carries its own context.
  const getContext = (req) => req.session.context ?? req.auth?.context;
  const setContext = async (req, context) => {
    if (req.session.userId) req.session.context = context;
    else {
      await tokens.setContext(req.auth.tokenId, context);
      req.auth.context = context;
    }
    return context;
  };
  const establish = async (req, user) => {
    await new Promise((resolve, reject) =>
      req.session.regenerate((e) => (e ? reject(e) : resolve())),
    );
    req.session.userId = user.id;
    await setContext(req, { mode: "personal" });
    const token = csrf(req);
    await new Promise((resolve, reject) =>
      req.session.save((e) => (e ? reject(e) : resolve())),
    );
    return { user, context: getContext(req), csrf_token: token };
  };
  app.post("/api/auth/register", authLimiter, async (req, res) =>
    res
      .status(201)
      .json(await establish(req, await service.register(req.body))),
  );
  app.post("/api/auth/login", authLimiter, async (req, res) =>
    res.json(await establish(req, await service.login(req.body))),
  );
  // Native sign-in: same credentials, a token pair instead of a cookie.
  app.post("/api/auth/token", authLimiter, async (req, res) => {
    const { device_label, ...credentials } = req.body || {};
    const user = await service.login(credentials);
    res.json({
      user,
      ...(await tokens.issue(user.id, { deviceLabel: device_label })),
    });
  });
  app.post("/api/auth/token/refresh", authLimiter, async (req, res) => {
    const { refresh_token, device_label } = req.body || {};
    res.json(
      await tokens.refresh(refresh_token, { deviceLabel: device_label }),
    );
  });
  app.use("/api", async (req, res, next) => {
    const userId = req.session.userId ?? req.auth?.userId;
    check(userId, 401, "Authentication required");
    req.user = await service.get("User", userId);
    const context = getContext(req);
    if (context?.mode === "organization") {
      const member = await m.OrganizationMember.findOne({
        where: { user_id: req.user.id, org_id: context.org_id },
      });
      // The downgrade has to persist on the token too, or a demoted manager
      // comes back in organization mode after the app restarts.
      if (!member?.canManage()) await setContext(req, { mode: "personal" });
    }
    next();
  });
  app.post("/api/auth/logout", async (req, res) => {
    if (req.auth) await tokens.revoke(req.auth.tokenId);
    await new Promise((resolve, reject) =>
      req.session.destroy((e) => (e ? reject(e) : resolve())),
    );
    res.clearCookie("workorder.sid", {
      httpOnly: true,
      sameSite: "strict",
      secure: production,
    });
    res.status(204).end();
  });
  app.get("/api/me", (req, res) =>
    res.json({ user: publicUser(req.user), context: getContext(req) }),
  );
  app.patch("/api/me", async (req, res) =>
    res.json(await service.profile(req.user.id, req.body)),
  );
  app.put("/api/context", async (req, res) => {
    res.json(
      await setContext(req, await service.switchContext(req.user.id, req.body)),
    );
  });
  const param = (req, name = "id") => id.parse(Number(req.params[name]));
  const page = (req) => schemas.page.parse(req.query);
  const userInclude = (as) => ({
    model: m.User,
    as,
    attributes: [
      "id",
      "full_name",
      "skills",
      "hourly_rate",
      "availability_status",
    ],
  });
  const orgInclude = (as = "organization") => ({
    model: m.Organization,
    as,
    attributes: ["id", "name", "trade_focus", "organization_types"],
  });
  const bidIncludes = [
    userInclude("user"),
    orgInclude(),
    {
      model: m.ProjectSubdivision,
      as: "subdivision",
      include: [{ model: m.Project, as: "project" }],
    },
  ];
  const jobIncludes = [userInclude("poster"), orgInclude()];
  const send = (method, path, fn, status = 200) =>
    app[method](`/api${path}`, async (req, res) =>
      res.status(status).json(await fn(req)),
    );
  send("get", "/notifications", (req) =>
    m.Notification.findAll({
      where: {
        user_id: req.user.id,
        ...(req.query.unread === "true" ? { read_at: null } : {}),
      },
      ...schemas.page.parse({
        limit: req.query.limit,
        offset: req.query.offset,
      }),
      order: [["id", "DESC"]],
    }),
  );
  send("get", "/notifications/unread-count", async (req) => ({
    count: await m.Notification.count({
      where: { user_id: req.user.id, read_at: null },
    }),
  }));
  send("patch", "/notifications/read-all", async (req) => {
    await m.Notification.update(
      { read_at: new Date() },
      { where: { user_id: req.user.id, read_at: null } },
    );
    return { ok: true };
  });
  send("patch", "/notifications/:id", async (req) => {
    const item = await m.Notification.findOne({
      where: { id: param(req), user_id: req.user.id },
    });
    check(item, 404, "Notification not found");
    return item.update({ read_at: item.read_at || new Date() });
  });
  send("get", "/users", async (req) =>
    m.User.findAll({
      ...page(req),
      attributes: [
        "id",
        "full_name",
        "skills",
        "hourly_rate",
        "availability_status",
      ],
      order: [["id", "ASC"]],
    }),
  );
  send("get", "/users/:id", async (req) => {
    const u = await service.get("User", param(req));
    const canSeeResume =
      u.resume_file_id &&
      (await service.canViewResume(req.user.id, u.resume_file_id));
    return {
      id: u.id,
      full_name: u.full_name,
      skills: u.skills,
      hourly_rate: u.hourly_rate,
      availability_status: u.availability_status,
      resume: canSeeResume ? (await files.find([u.resume_file_id]))[0] : null,
      credentials: await trust.publicCredentials(u.id, null),
      reputation: await trust.reputation(u.id, null),
    };
  });
  send("get", "/organizations/:id/profile", (req) =>
    trust.organizationProfile(param(req)),
  );
  send(
    "post",
    "/organizations",
    (req) => service.createOrg(req.user.id, req.body),
    201,
  );
  send("get", "/organizations", (req) =>
    m.OrganizationMember.findAll({
      where: { user_id: req.user.id },
      include: [
        { model: m.Organization, as: "organization" },
        { model: m.OrganizationRole, as: "companyRole" },
      ],
      ...page(req),
      order: [["id", "ASC"]],
    }),
  );
  send("get", "/organizations/:id/members", async (req) => {
    await service.member(req.user.id, param(req));
    return m.OrganizationMember.findAll({
      where: { org_id: param(req) },
      include: [
        userInclude("user"),
        { model: m.OrganizationRole, as: "companyRole" },
      ],
      ...page(req),
      order: [["id", "ASC"]],
    });
  });
  send("patch", "/organizations/:id", (req) =>
    service.editOrg(req.user.id, param(req), req.body),
  );
  send(
    "post",
    "/subdivisions/:id/children",
    (req) => service.addChild(req.user.id, param(req), req.body),
    201,
  );
  send("put", "/organizations/:id/members", (req) =>
    service.setMember(req.user.id, param(req), req.body),
  );
  send("get", "/organizations/:id/roles", async (req) => {
    await service.member(req.user.id, param(req));
    return m.OrganizationRole.findAll({
      where: { org_id: param(req) },
      ...page(req),
      order: [["name", "ASC"]],
    });
  });
  send(
    "post",
    "/organizations/:id/roles",
    (req) => service.saveCompanyRole(req.user.id, param(req), null, req.body),
    201,
  );
  send("patch", "/organizations/:id/roles/:roleId", (req) =>
    service.saveCompanyRole(
      req.user.id,
      param(req),
      id.parse(Number(req.params.roleId)),
      req.body,
    ),
  );
  send("put", "/organizations/:id/pay", (req) =>
    service.setMemberPay(req.user.id, param(req), req.body),
  );
  send("post", "/applications/:id/counter", (req) =>
    service.counterOffer(req.user.id, param(req), req.body),
  );
  send("post", "/jobs", (req) => service.postJob(req.user.id, req.body), 201);
  send("get", "/jobs", (req) =>
    m.JobPosting.findAll({
      where: { status: "open" },
      include: jobIncludes,
      ...page(req),
      order: [["id", "DESC"]],
    }),
  );
  send("get", "/me/jobs", (req) =>
    m.JobPosting.findAll({
      where: { posted_by_user_id: req.user.id, posted_by_org_id: null },
      include: jobIncludes,
      ...page(req),
      order: [["id", "DESC"]],
    }),
  );
  send("get", "/organizations/:id/jobs", async (req) => {
    await service.member(req.user.id, param(req), null, true);
    return m.JobPosting.findAll({
      where: { posted_by_org_id: param(req) },
      include: jobIncludes,
      ...page(req),
      order: [["id", "DESC"]],
    });
  });
  send("get", "/jobs/:id", (req) => service.get("JobPosting", param(req)));
  send("post", "/jobs/:id/close", (req) =>
    service.closeJob(req.user.id, param(req)),
  );
  send(
    "post",
    "/jobs/:id/applications",
    (req) => service.apply(req.user.id, param(req), req.body),
    201,
  );
  send("get", "/jobs/:id/applications", async (req) => {
    const job = await service.get("JobPosting", param(req));
    await service.manageJob(req.user.id, job);
    return m.JobApplication.findAll({
      where: { job_posting_id: job.id },
      include: [userInclude("applicant")],
      ...page(req),
      order: [["id", "ASC"]],
    });
  });
  send("get", "/applications", (req) =>
    m.JobApplication.findAll({
      where: { applicant_user_id: req.user.id },
      include: [{ model: m.JobPosting, as: "posting", include: jobIncludes }],
      ...page(req),
      order: [["id", "DESC"]],
    }),
  );
  send("patch", "/applications/:id", (req) =>
    service.applicationAction(
      req.user.id,
      param(req),
      schemas.decision.parse(req.body).status,
      req.body,
    ),
  );
  send("post", "/applications/:id/accept", (req) =>
    service.applicationAction(req.user.id, param(req), "accepted", req.body),
  );
  send("post", "/applications/:id/withdraw", (req) =>
    service.applicationAction(req.user.id, param(req), "withdrawn"),
  );
  send(
    "post",
    "/projects",
    (req) => service.postProject(req.user.id, req.body),
    201,
  );
  send("get", "/projects", (req) =>
    m.Project.findAll({
      where: { status: { [Op.in]: ["open", "active"] } },
      include: [userInclude("client"), orgInclude("clientOrganization")],
      ...page(req),
      order: [["id", "DESC"]],
    }),
  );
  send("get", "/me/projects", (req) =>
    m.Project.findAll({
      where: { client_user_id: req.user.id },
      include: [userInclude("client"), orgInclude("clientOrganization")],
      ...page(req),
      order: [["id", "DESC"]],
    }),
  );
  send("get", "/projects/:id", (req) => service.projectDetail(param(req)));
  send("put", "/projects/:id/subdivisions", (req) =>
    service.subdivide(req.user.id, param(req), req.body),
  );
  send("post", "/projects/:id/cancel", (req) =>
    service.cancelProject(req.user.id, param(req)),
  );
  send(
    "post",
    "/subdivisions/:id/bids",
    (req) => service.submitBid(req.user.id, param(req), req.body),
    201,
  );
  send("get", "/subdivisions/:id/bids", async (req) => {
    const s = await service.get("ProjectSubdivision", param(req));
    const p = await service.get("Project", s.project_id);
    await service.canCommission(req.user.id, p, s);
    const bids = await m.Bid.findAll({
      where: { subdivision_id: s.id },
      include: bidIncludes,
      ...page(req),
      order: [["id", "ASC"]],
    });
    // Commissioners see each bidder's current credential standing and computed rating.
    return Promise.all(
      bids.map(async (b) => ({
        ...b.toJSON(),
        standing: await trust.standing(
          b.bidding_user_id,
          b.bidding_org_id,
          s.required_credentials,
        ),
        reputation: await trust
          .reputation(b.bidding_user_id, b.bidding_org_id)
          .then(({ count, overall, value }) => ({ count, overall, value })),
      })),
    );
  });
  send("get", "/me/assignments", async (req) => {
    const memberships = await m.OrganizationMember.findAll({
      where: { user_id: req.user.id },
    });
    return m.ProjectSubdivision.findAll({
      include: [
        { model: m.Project, as: "project" },
        orgInclude("awardedOrganization"),
      ],
      where: {
        [Op.or]: [
          { awarded_user_id: req.user.id },
          { awarded_org_id: { [Op.in]: memberships.map((row) => row.org_id) } },
        ],
      },
      ...page(req),
      order: [["id", "DESC"]],
    });
  });
  send("get", "/bids", (req) =>
    m.Bid.findAll({
      where: { bidding_user_id: req.user.id },
      include: bidIncludes,
      ...page(req),
      order: [["id", "DESC"]],
    }),
  );
  send("get", "/organizations/:id/assignments", async (req) => {
    await service.member(req.user.id, param(req));
    return m.ProjectSubdivision.findAll({
      where: { awarded_org_id: param(req) },
      include: [
        { model: m.Project, as: "project" },
        orgInclude("awardedOrganization"),
      ],
      ...page(req),
      order: [["id", "DESC"]],
    });
  });
  send("get", "/organizations/:id/bids", async (req) => {
    await service.member(req.user.id, param(req), null, true);
    return m.Bid.findAll({
      where: { bidding_org_id: param(req) },
      include: bidIncludes,
      ...page(req),
      order: [["id", "DESC"]],
    });
  });
  send("post", "/bids/:id/withdraw", (req) =>
    service.withdrawBid(req.user.id, param(req)),
  );
  send("post", "/bids/:id/award", (req) =>
    service.award(req.user.id, param(req)),
  );
  send("patch", "/subdivisions/:id", (req) =>
    service.subdivisionStatus(req.user.id, param(req), req.body),
  );
  send("get", "/subdivisions/:id/costs", (req) =>
    service.costs(req.user.id, param(req)),
  );
  send(
    "post",
    "/inventory",
    (req) => service.addItem(req.user.id, req.body),
    201,
  );
  send("get", "/inventory", (req) =>
    m.InventoryItem.findAll({
      where: { owner_user_id: req.user.id },
      ...page(req),
      order: [["id", "ASC"]],
    }),
  );
  send("get", "/organizations/:id/inventory", async (req) => {
    await service.member(req.user.id, param(req));
    return m.InventoryItem.findAll({
      where: { owner_org_id: param(req) },
      ...page(req),
      order: [["id", "ASC"]],
    });
  });
  send("post", "/inventory/:id/receipts", (req) =>
    service.receive(req.user.id, param(req), req.body),
  );
  send("get", "/inventory/:id/movements", async (req) => {
    const item = await service.get("InventoryItem", param(req));
    await service.itemOwner(req.user.id, item);
    return m.InventoryMovement.findAll({
      where: { item_id: item.id },
      ...page(req),
      order: [["id", "DESC"]],
    });
  });
  send(
    "post",
    "/subdivisions/:id/materials",
    (req) => service.consume(req.user.id, param(req), req.body),
    201,
  );
  send("post", "/time", (req) => service.logTime(req.user.id, req.body), 201);
  send(
    "post",
    "/time/bulk",
    (req) => service.logTimeBulk(req.user.id, req.body),
    201,
  );
  send("patch", "/time/:id", (req) =>
    service.editTime(req.user.id, param(req), req.body),
  );
  send("get", "/time/entries", (req) =>
    service.timeEntries(req.user.id, req.query),
  );
  send("delete", "/time/:id", (req) =>
    service.deleteTime(req.user.id, param(req)),
  );
  send("get", "/time", (req) => service.timeReport(req.user.id, req.query));
  send("get", "/time/week", (req) => {
    const start = date.parse(req.query.date);
    const monday = new Date(start + "T00:00:00Z");
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const end = new Date(monday);
    end.setUTCDate(end.getUTCDate() + 6);
    return service.timeReport(req.user.id, {
      from: monday.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    });
  });
  send("get", "/organizations/:id/time", (req) =>
    service.timeReport(req.user.id, req.query, param(req)),
  );
  send("get", "/organizations/:id/dashboard", (req) =>
    service.orgDashboard(req.user.id, param(req), req.query),
  );
  const origin = (req) => `${req.protocol}://${req.get("host")}`;
  send("get", "/admin/payout-holding", (req) =>
    funding.holdingReport(req.user.id),
  );
  send("get", "/payment-accounts", async (req) => ({
    configured: funding.configured,
    live: !!paymentProvider?.live,
    accounts: await funding.accounts(req.user.id),
  }));
  send("post", "/payment-accounts", (req) =>
    funding.startOnboarding(req.user.id, req.body, origin(req)),
  );
  send("post", "/payment-accounts/:id/refresh", (req) =>
    funding.refreshAccount(req.user.id, param(req)),
  );
  send(
    "post",
    "/payment-accounts/:id/payouts",
    (req) => funding.payout(req.user.id, param(req), req.body),
    201,
  );
  send("get", "/subdivisions/:id/funding", (req) =>
    funding.detail(req.user.id, param(req)),
  );
  send(
    "post",
    "/subdivisions/:id/fundings",
    (req) => funding.fund(req.user.id, param(req), req.body, origin(req)),
    201,
  );
  send("post", "/fundings/:id/refresh", (req) =>
    funding.refreshFunding(req.user.id, param(req)),
  );
  send(
    "post",
    "/fundings/:id/refunds",
    (req) => funding.refund(req.user.id, param(req), req.body),
    201,
  );
  send(
    "post",
    "/subdivisions/:id/releases",
    (req) => funding.release(req.user.id, param(req), req.body),
    201,
  );
  send("post", "/releases/:id/retry", (req) =>
    funding.retryRelease(req.user.id, param(req)),
  );
  send("get", "/subdivisions/:id/waivers", (req) =>
    billing.waivers.list(req.user.id, param(req)),
  );
  send("get", "/projects/:id/waivers", (req) =>
    billing.waivers.chain(req.user.id, param(req)),
  );
  send("get", "/waivers/:id", (req) =>
    billing.waivers.get(req.user.id, param(req)),
  );
  send("post", "/waivers/:id/sign", (req) =>
    billing.waivers.sign(req.user.id, param(req), req.body),
  );
  app.post(
    "/api/files",
    express.raw({ type: FILE_TYPES, limit: "4mb" }),
    async (req, res) =>
      res.status(201).json(
        await files.upload(req.user.id, {
          buffer: Buffer.isBuffer(req.body) ? req.body : null,
          contentType: req.get("content-type"),
          filename: req.get("x-filename"),
        }),
      ),
  );
  app.get("/api/files/:id", async (req, res) => {
    const file = await files.download(req.user.id, param(req));
    const inline = file.content_type.startsWith("image/");
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    res
      .set({
        "Content-Type": file.content_type,
        "Content-Length": String(file.byte_size),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "private, no-store",
      })
      .send(file.data);
  });
  send("get", "/field", (req) => field.bootstrap(req.user.id));
  send(
    "post",
    "/field/time",
    (req) => field.syncTime(req.user.id, req.body),
    201,
  );
  send("get", "/subdivisions/:id/reports", (req) =>
    field.reports(req.user.id, param(req)),
  );
  send(
    "post",
    "/subdivisions/:id/reports",
    (req) => field.report(req.user.id, param(req), req.body),
    201,
  );
  send("get", "/projects/:id/schedule", (req) =>
    field.schedule(req.user.id, param(req)),
  );
  send("put", "/subdivisions/:id/schedule", (req) =>
    field.plan(req.user.id, param(req), req.body),
  );
  send("get", "/projects/:id/documents", (req) =>
    field.documents(req.user.id, param(req)),
  );
  send(
    "post",
    "/projects/:id/documents",
    (req) => field.addDocument(req.user.id, param(req), null, req.body),
    201,
  );
  send("get", "/subdivisions/:id/documents", async (req) => {
    const s = await service.get("ProjectSubdivision", param(req));
    return field.documents(req.user.id, s.project_id, s.id);
  });
  send(
    "post",
    "/subdivisions/:id/documents",
    async (req) => {
      const s = await service.get("ProjectSubdivision", param(req));
      return field.addDocument(req.user.id, s.project_id, s.id, req.body);
    },
    201,
  );
  send("get", "/documents/:id", (req) =>
    field.document(req.user.id, param(req)),
  );
  send("post", "/documents/:id/sign", (req) =>
    field.document(req.user.id, param(req), req.body),
  );
  send("get", "/credentials", (req) =>
    trust.credentials(req.user.id, req.query),
  );
  send(
    "post",
    "/credentials",
    (req) => trust.addCredential(req.user.id, req.body),
    201,
  );
  send("post", "/credentials/:id/withdraw", (req) =>
    trust.withdrawCredential(req.user.id, param(req)),
  );
  send("put", "/subdivisions/:id/requirements", (req) =>
    trust.setRequirements(req.user.id, param(req), req.body),
  );
  send("get", "/subdivisions/:id/review", (req) =>
    trust.scopeReview(req.user.id, param(req)),
  );
  send(
    "post",
    "/subdivisions/:id/review",
    (req) => trust.review(req.user.id, param(req), req.body),
    201,
  );
  send("get", "/subdivisions/:id/disputes", (req) =>
    trust.disputesForScope(req.user.id, param(req)),
  );
  send(
    "post",
    "/subdivisions/:id/disputes",
    (req) => trust.openDispute(req.user.id, param(req), req.body),
    201,
  );
  send("get", "/disputes/:id", (req) =>
    trust.disputeDetail(req.user.id, param(req)),
  );
  send("get", "/disputes/:id/packet", (req) =>
    trust.packet(req.user.id, param(req)),
  );
  send(
    "post",
    "/disputes/:id/comments",
    (req) => trust.comment(req.user.id, param(req), req.body),
    201,
  );
  send("post", "/disputes/:id/proposals", (req) =>
    trust.propose(req.user.id, param(req), req.body),
  );
  send("post", "/disputes/:id/response", (req) =>
    trust.respond(req.user.id, param(req), req.body),
  );
  send("post", "/disputes/:id/withdraw", (req) =>
    trust.withdraw(req.user.id, param(req), req.body),
  );
  send("get", "/admin/credentials", (req) =>
    trust.reviewQueue(req.user.id, req.query),
  );
  send("patch", "/admin/credentials/:id", (req) =>
    trust.reviewCredential(req.user.id, param(req), req.body),
  );
  send("get", "/admin/disputes", (req) => trust.adminDisputes(req.user.id));
  send("post", "/admin/disputes/:id/resolve", (req) =>
    trust.mediate(req.user.id, param(req), req.body),
  );
  send("get", "/billing", (req) => billing.list(req.user.id, req.query));
  send("get", "/subdivisions/:id/billing", (req) =>
    billing.detail(req.user.id, param(req)),
  );
  send("get", "/pay-applications/:id", async (req) => {
    const application = await service.get("PayApplication", param(req));
    return billing.detail(req.user.id, application.subdivision_id);
  });
  send(
    "post",
    "/subdivisions/:id/changes",
    (req) => billing.propose(req.user.id, param(req), req.body),
    201,
  );
  send("patch", "/changes/:id", (req) =>
    billing.decideChange(req.user.id, param(req), req.body),
  );
  send("post", "/subdivisions/:id/pay-applications/preview", async (req) => {
    const snapshot = await billing.preview(req.user.id, param(req), req.body);
    return { snapshot, fingerprint: fingerprint(snapshot) };
  });
  send(
    "post",
    "/subdivisions/:id/pay-applications",
    (req) => billing.submitApplication(req.user.id, param(req), req.body),
    201,
  );
  send("patch", "/pay-applications/:id", (req) =>
    billing.decideApplication(req.user.id, param(req), req.body),
  );
  send(
    "post",
    "/pay-applications/:id/payments",
    (req) => billing.recordPayment(req.user.id, param(req), req.body),
    201,
  );
  send(
    "post",
    "/billing-payments/:id/reversal",
    (req) => billing.reversePayment(req.user.id, param(req), req.body),
    201,
  );
  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use((err, req, res, next) => {
    if (err instanceof ZodError)
      return res.status(422).json({
        error: "Validation failed",
        details: err.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if (err.name === "SequelizeUniqueConstraintError")
      return res.status(409).json({
        error: "Record already exists or conflicts with an existing record",
      });
    if (err.name === "SequelizeForeignKeyConstraintError")
      return res.status(422).json({ error: "Referenced record is invalid" });
    if (err.original?.code === "23514" || err.original?.code === "22003")
      return res.status(422).json({ error: "Database constraint violated" });
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ error: "Invalid JSON" });
    if (err.type === "entity.too.large")
      return res.status(413).json({ error: "Request too large" });
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return {
    app,
    service,
    close: async () => {
      store.close();
      if (ownsPool) await pool.end();
    },
  };
}
module.exports = { createApp };
