const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");
const { Op } = require("sequelize");
const { check, date } = require("./validation.cjs");
const { cents, amount } = require("./money.cjs");
const KINDS = [
  "trade_license",
  "general_liability",
  "workers_compensation",
  "certification",
];
const KIND_LABELS = {
  trade_license: "Trade license",
  general_liability: "General liability insurance",
  workers_compensation: "Workers’ compensation insurance",
  certification: "Certification",
};
const id = z.number().int().positive().max(2147483647);
const twoDecimals = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001;
const money = z.number().finite().min(0).max(9999999999.99).refine(twoDecimals, "At most two decimal places");
const rating = z.number().int().min(1).max(5);
const unique = (v) => new Set(v).size === v.length;
const schemas = {
  credential: z
    .object({
      org_id: id.optional(),
      kind: z.enum(KINDS),
      title: z.string().trim().min(1).max(160),
      issuer: z.string().trim().min(1).max(200),
      number: z.string().trim().min(1).max(120),
      jurisdiction: z.string().trim().max(120).default(""),
      coverage_amount: z
        .number()
        .finite()
        .positive()
        .max(9999999999.99)
        .refine(twoDecimals)
        .nullable()
        .optional(),
      effective_on: date.optional(),
      expires_on: date,
      file_id: id.optional(),
    })
    .strict()
    .refine(
      (d) => !d.effective_on || d.effective_on <= d.expires_on,
      "The effective date must be on or before expiry",
    ),
  credentialReview: z
    .object({
      status: z.enum(["verified", "rejected"]),
      checked: z.string().trim().min(3).max(1000),
      note: z.string().trim().max(2000).default(""),
    })
    .strict(),
  requirements: z
    .object({
      required_credentials: z.array(z.enum(KINDS)).max(4).refine(unique, "Choose each credential once"),
    })
    .strict(),
  review: z
    .object({
      schedule: rating,
      quality: rating,
      communication: rating,
      closeout: rating,
      comment: z.string().trim().max(4000).default(""),
    })
    .strict(),
  dispute: z
    .object({
      reason: z.string().trim().min(10).max(10000),
      amount_held: money.optional(),
    })
    .strict(),
  comment: z
    .object({
      body: z.string().trim().max(10000).default(""),
      file_id: id.optional(),
    })
    .strict()
    .refine((d) => d.body || d.file_id, "Add a note or attach a file"),
  split: z
    .object({
      to_contractor: money,
      to_payer: money,
      note: z.string().trim().max(4000).default(""),
    })
    .strict(),
  response: z
    .object({
      decision: z.enum(["accept", "reject"]),
      note: z.string().trim().max(4000).default(""),
    })
    .strict(),
  note: z.object({ note: z.string().trim().max(4000).default("") }).strict(),
};
const utcToday = () => new Date().toISOString().slice(0, 10);
const toCents = (n) => cents(Number(n).toFixed(2));
const mask = (number) =>
  number.length > 4 ? `•••• ${number.slice(-4)}` : number;
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
class TrustService {
  constructor(platform, billing, funding, files) {
    this.platform = platform;
    this.billing = billing;
    this.funding = funding;
    this.files = files;
    this.db = platform.db;
    this.m = platform.m;
    // Field records (Release Three) contribute sections to the evidence packet.
    this.packetSources = [];
    platform.bidRules.push((ctx, t) => this.bidRule(ctx, t));
    funding.holdSources.push((scope, t) => this.heldOn(scope, t));
    files.rules.push((user, fileId) => this.canViewFile(user, fileId));
  }
  async requireAdmin(user, t) {
    const u = await this.platform.get("User", user, t);
    check(u.platform_role === "admin", 403, "Platform administrator access required");
    return u;
  }
  owner(user, orgId) {
    return orgId ? { owner_org_id: orgId } : { owner_user_id: user };
  }
  async ownerCheck(user, orgId, t) {
    if (orgId) await this.platform.member(user, orgId, t, true);
  }
  // ---- Credentials -------------------------------------------------------
  decorate(row) {
    const v = row.get ? row.get({ plain: true }) : row;
    return { ...v, label: KIND_LABELS[v.kind], expired: v.expires_on < utcToday() };
  }
  async addCredential(user, input) {
    const { org_id, file_id, ...d } = schemas.credential.parse(input);
    return this.db.transaction(async (t) => {
      await this.ownerCheck(user, org_id, t);
      if (file_id) await this.files.ensureUploader(user, file_id, t);
      check(d.expires_on >= utcToday(), 422, "This credential has already expired");
      const row = await this.m.Credential.create(
        {
          ...d,
          coverage_amount: d.coverage_amount ?? null,
          effective_on: d.effective_on ?? null,
          file_id: file_id ?? null,
          ...this.owner(user, org_id),
          status: "pending",
          created_by_user_id: user,
        },
        { transaction: t },
      );
      const admins = await this.m.User.findAll({
        where: { platform_role: "admin" },
        transaction: t,
      });
      for (const admin of admins)
        await this.platform.notify(
          admin.id,
          null,
          user,
          "Credential awaiting review",
          `${KIND_LABELS[d.kind]} · ${d.issuer}`,
          "admin",
          t,
        );
      return this.decorate(row);
    });
  }
  async credentials(user, input) {
    const { org_id } = z
      .object({ org_id: z.coerce.number().int().positive().max(2147483647).optional() })
      .strict()
      .parse(input);
    await this.ownerCheck(user, org_id);
    const rows = await this.m.Credential.findAll({
      where: this.owner(user, org_id),
      order: [
        ["expires_on", "DESC"],
        ["id", "DESC"],
      ],
    });
    return rows.map((r) => this.decorate(r));
  }
  async withdrawCredential(user, id) {
    return this.db.transaction(async (t) => {
      const row = await this.platform.get("Credential", id, t, true);
      if (row.owner_org_id) await this.ownerCheck(user, row.owner_org_id, t);
      else check(row.owner_user_id === user, 403, "Only the credential owner can withdraw it");
      check(["pending", "verified"].includes(row.status), 409, "This credential is no longer active");
      await row.update({ status: "withdrawn", updated_at: new Date() }, { transaction: t });
      return this.decorate(row);
    });
  }
  async reviewQueue(user, input) {
    await this.requireAdmin(user);
    const { status } = z
      .object({ status: z.enum(["pending", "verified", "rejected", "withdrawn"]).default("pending") })
      .strict()
      .parse(input);
    const [rows] = await this.db.query(
      `SELECT c.*, COALESCE(o.name,u.full_name) AS owner_name FROM credentials c
       LEFT JOIN organizations o ON o.id=c.owner_org_id LEFT JOIN users u ON u.id=c.owner_user_id
       WHERE c.status=$1 ORDER BY c.id ASC LIMIT 200`,
      { bind: [status] },
    );
    const files = await this.files.find(rows.map((r) => r.file_id));
    return rows.map((r) => ({
      ...this.decorate(r),
      coverage_amount: r.coverage_amount,
      file: files.find((f) => f.id === r.file_id) || null,
    }));
  }
  async reviewCredential(user, id, input) {
    const d = schemas.credentialReview.parse(input);
    return this.db.transaction(async (t) => {
      await this.requireAdmin(user, t);
      const row = await this.platform.get("Credential", id, t, true);
      check(row.status === "pending", 409, "Only pending credentials can be reviewed");
      await row.update(
        {
          status: d.status,
          checked: d.checked,
          review_note: d.note,
          reviewed_by_user_id: user,
          reviewed_at: new Date(),
          updated_at: new Date(),
        },
        { transaction: t },
      );
      await this.platform.notify(
        row.owner_user_id,
        row.owner_org_id,
        user,
        d.status === "verified" ? "Credential verified" : "Credential not verified",
        `${KIND_LABELS[row.kind]} · ${row.issuer}${d.note ? ` · ${d.note}` : ""}`,
        "profile",
        t,
      );
      return this.decorate(row);
    });
  }
  async publicCredentials(userId, orgId, t) {
    const rows = await this.m.Credential.findAll({
      where: {
        ...(orgId ? { owner_org_id: orgId } : { owner_user_id: userId }),
        status: { [Op.in]: ["pending", "verified"] },
      },
      order: [["expires_on", "DESC"]],
      transaction: t,
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: KIND_LABELS[r.kind],
      title: r.title,
      issuer: r.issuer,
      jurisdiction: r.jurisdiction,
      number: mask(r.number),
      coverage_amount: r.coverage_amount,
      expires_on: r.expires_on,
      expired: r.expires_on < utcToday(),
      status: r.status,
      checked: r.status === "verified" ? r.checked : "",
      reviewed_at: r.status === "verified" ? r.reviewed_at : null,
      has_document: !!r.file_id,
    }));
  }
  async standing(userId, orgId, required = [], t) {
    const rows = await this.m.Credential.findAll({
      where: {
        ...(orgId ? { owner_org_id: orgId } : { owner_user_id: userId }),
        status: { [Op.in]: ["pending", "verified"] },
      },
      transaction: t,
    });
    const today = utcToday();
    const current = rows.filter((r) => r.expires_on >= today);
    // An expired certificate stops blocking once a current one of the same kind is on file.
    const expired = rows
      .filter((r) => r.expires_on < today && !current.some((c) => c.kind === r.kind))
      .sort((a, b) => (a.expires_on < b.expires_on ? 1 : -1));
    const kinds = (status) => [
      ...new Set(current.filter((r) => r.status === status).map((r) => r.kind)),
    ];
    return {
      verified: kinds("verified"),
      pending: kinds("pending").filter((k) => !kinds("verified").includes(k)),
      expired: expired
        .filter((r, i, all) => all.findIndex((x) => x.kind === r.kind) === i)
        .map((r) => ({ kind: r.kind, label: KIND_LABELS[r.kind], expires_on: r.expires_on })),
      missing: required.filter((k) => !current.some((c) => c.kind === k)),
      required,
    };
  }
  async bidRule({ userId, orgId, s, phase }, t) {
    const st = await this.standing(userId, orgId, s.required_credentials || [], t);
    const bidding = phase === "bid";
    if (st.expired.length)
      check(
        false,
        409,
        `${bidding ? "Your" : "The bidder’s"} ${st.expired[0].label.toLowerCase()} expired on ${st.expired[0].expires_on}. ${bidding ? "Add a current certificate before bidding." : "The award is blocked until they add a current certificate."}`,
      );
    if (st.missing.length)
      check(
        false,
        409,
        `This work package requires ${st.missing.map((k) => KIND_LABELS[k].toLowerCase()).join(", ")}. ${bidding ? "Add a current credential before bidding." : "The bidder has not provided a current one."}`,
      );
  }
  async setRequirements(user, scopeId, input) {
    const d = schemas.requirements.parse(input);
    return this.db.transaction(async (t) => {
      const { p, s } = await this.platform.work(scopeId, t);
      await this.platform.canCommission(user, p, s, t);
      check(s.status === "open", 409, "Requirements can change only while the work package is open for bids");
      await s.update({ required_credentials: d.required_credentials }, { transaction: t });
      return s;
    });
  }
  // ---- Reviews -------------------------------------------------------------
  async review(user, scopeId, input) {
    const d = schemas.review.parse(input);
    return this.db.transaction(async (t) => {
      const ctx = await this.billing.context(user, scopeId, t);
      check(ctx.payer && !ctx.contractor, 403, "Only the party that paid for this work can rate it");
      check(ctx.s.status === "completed", 409, "Ratings open once the work package is completed");
      check(
        !(await this.m.Review.findOne({ where: { subdivision_id: scopeId }, transaction: t })),
        409,
        "This work package has already been rated",
      );
      const totals = this.billing.totals(ctx, await this.billing.records(scopeId, t));
      const review = await this.m.Review.create(
        {
          ...d,
          subdivision_id: scopeId,
          reviewer_user_id: user,
          reviewer_org_id: ctx.payerOrg,
          reviewee_user_id: ctx.s.awarded_org_id ? null : ctx.s.awarded_user_id,
          reviewee_org_id: ctx.s.awarded_org_id || null,
          contract_value: totals.contract_value,
        },
        { transaction: t },
      );
      const overall = ((d.schedule + d.quality + d.communication + d.closeout) / 4).toFixed(1);
      await this.billing.notify(ctx, user, "New rating received", `${ctx.s.scope} · ${overall} / 5`, t, "contractor");
      return review;
    });
  }
  async scopeReview(user, scopeId) {
    return this.db.transaction(async (t) => {
      const ctx = await this.billing.context(user, scopeId, t);
      const review = await this.m.Review.findOne({ where: { subdivision_id: scopeId }, transaction: t });
      return {
        review,
        can_review: ctx.payer && !ctx.contractor && ctx.s.status === "completed" && !review,
      };
    });
  }
  async reputation(userId, orgId) {
    const where = orgId ? "r.reviewee_org_id=$1" : "r.reviewee_user_id=$1";
    const bind = [orgId || userId];
    const [[summary]] = await this.db.query(
      `SELECT count(*)::int AS count,
        round(avg((schedule+quality+communication+closeout)/4.0),2)::text AS overall,
        round(avg(schedule),2)::text AS schedule, round(avg(quality),2)::text AS quality,
        round(avg(communication),2)::text AS communication, round(avg(closeout),2)::text AS closeout,
        COALESCE(sum(contract_value),0)::text AS value
       FROM reviews r WHERE ${where}`,
      { bind },
    );
    const [recent] = await this.db.query(
      `SELECT r.id, r.schedule, r.quality, r.communication, r.closeout, r.comment, r.contract_value::text, r.created_at,
        s.scope, p.title AS project_title, COALESCE(o.name,u.full_name) AS reviewer_name
       FROM reviews r JOIN project_subdivisions s ON s.id=r.subdivision_id JOIN projects p ON p.id=s.project_id
       JOIN users u ON u.id=r.reviewer_user_id LEFT JOIN organizations o ON o.id=r.reviewer_org_id
       WHERE ${where} ORDER BY r.id DESC LIMIT 10`,
      { bind },
    );
    return { ...summary, recent };
  }
  async organizationProfile(orgId) {
    const org = await this.platform.get("Organization", orgId);
    return {
      id: org.id,
      name: org.name,
      trade_focus: org.trade_focus,
      organization_types: org.organization_types,
      credentials: await this.publicCredentials(null, orgId),
      reputation: await this.reputation(null, orgId),
    };
  }
  // ---- Disputes ------------------------------------------------------------
  side(ctx) {
    if (ctx.payer && !ctx.contractor) return "payer";
    if (ctx.contractor && !ctx.payer) return "contractor";
    return null;
  }
  async heldOn(scopeId, t) {
    const rows = await this.m.Dispute.findAll({
      where: { subdivision_id: scopeId, status: "open" },
      transaction: t,
    });
    return rows.reduce((n, d) => n + cents(d.amount_held), 0n);
  }
  async event(dispute, user, side, kind, data, t) {
    return this.m.DisputeEvent.create(
      { dispute_id: dispute.id, user_id: user, side, kind, ...data },
      { transaction: t },
    );
  }
  async openDispute(user, scopeId, input) {
    const d = schemas.dispute.parse(input);
    return this.db.transaction(async (t) => {
      const ctx = await this.billing.context(user, scopeId, t);
      const side = this.side(ctx);
      check(side, 403, "Only the contracting parties can open a dispute");
      check(
        !(await this.m.Dispute.findOne({ where: { subdivision_id: scopeId, status: "open" }, transaction: t })),
        409,
        "A dispute is already open on this work package",
      );
      const records = await this.funding.ledgerRecords(scopeId, t, true);
      const summary = this.funding.summarize(records, await this.funding.holds(scopeId, t));
      const held = d.amount_held === undefined ? cents(summary.available) : toCents(d.amount_held);
      check(
        held <= cents(summary.available),
        409,
        `Only USD ${summary.available} is funded and unreleased on this work package`,
      );
      const dispute = await this.m.Dispute.create(
        {
          subdivision_id: scopeId,
          opened_by_user_id: user,
          opened_side: side,
          reason: d.reason,
          amount_held: amount(held),
          status: "open",
        },
        { transaction: t },
      );
      await this.event(dispute, user, side, "opened", { body: d.reason }, t);
      await this.billing.notify(
        ctx,
        user,
        "Dispute opened",
        `${ctx.s.scope} · USD ${amount(held)} held on this work package only`,
        t,
        side === "payer" ? "contractor" : "payer",
      );
      return dispute;
    });
  }
  async load(user, id, t, lock = false) {
    const first = await this.platform.get("Dispute", id, t);
    const ctx = await this.billing.context(user, first.subdivision_id, t);
    const dispute = lock ? await this.platform.get("Dispute", id, t, true) : first;
    return { ctx, dispute, side: this.side(ctx) };
  }
  async disputeDetail(user, id) {
    return this.db.transaction(async (t) => {
      let ctx, dispute, side, mediator = false;
      try {
        ({ ctx, dispute, side } = await this.load(user, id, t));
      } catch (error) {
        if (error.status !== 403) throw error;
        await this.requireAdmin(user, t);
        mediator = true;
        dispute = await this.platform.get("Dispute", id, t);
      }
      const events = await this.m.DisputeEvent.findAll({ where: { dispute_id: id }, order: [["id", "ASC"]], transaction: t, raw: true });
      const people = await this.m.User.findAll({
        where: { id: [...new Set([...events.map((e) => e.user_id), dispute.opened_by_user_id])] },
        attributes: ["id", "full_name"],
        transaction: t,
        raw: true,
      });
      const files = await this.files.find(events.map((e) => e.file_id), t);
      const s = ctx?.s || (await this.platform.get("ProjectSubdivision", dispute.subdivision_id, t));
      const open = dispute.status === "open";
      return {
        dispute,
        scope: { id: s.id, scope: s.scope, project_id: s.project_id },
        events: events.map((e) => ({
          ...e,
          user_name: people.find((p) => p.id === e.user_id)?.full_name,
          file: files.find((f) => f.id === e.file_id) || null,
        })),
        permissions: {
          side: mediator ? "mediator" : side,
          can_comment: open && (!!side || mediator),
          can_propose: open && !!side,
          can_respond: open && !!side && !!dispute.proposed_side && dispute.proposed_side !== side,
          can_withdraw: open && side === dispute.opened_side,
          can_mediate: open && mediator,
        },
      };
    });
  }
  async disputesForScope(user, scopeId) {
    return this.db.transaction(async (t) => {
      await this.billing.context(user, scopeId, t);
      return this.m.Dispute.findAll({
        where: { subdivision_id: scopeId },
        attributes: { exclude: ["packet"] },
        order: [["id", "DESC"]],
        transaction: t,
      });
    });
  }
  async comment(user, id, input) {
    const d = schemas.comment.parse(input);
    return this.db.transaction(async (t) => {
      let ctx, dispute, side;
      try {
        ({ ctx, dispute, side } = await this.load(user, id, t, true));
      } catch (error) {
        if (error.status !== 403) throw error;
        await this.requireAdmin(user, t);
        dispute = await this.platform.get("Dispute", id, t, true);
        side = "mediator";
        ctx = await this.funding.scopeParties(dispute.subdivision_id, t);
      }
      check(side, 403, "Only the contracting parties can add to this dispute");
      check(dispute.status === "open", 409, "This dispute is closed");
      if (d.file_id) await this.files.ensureUploader(user, d.file_id, t);
      const event = await this.event(
        dispute,
        user,
        side,
        d.file_id ? "evidence" : "comment",
        { body: d.body, file_id: d.file_id ?? null },
        t,
      );
      await this.billing.notify(
        ctx,
        user,
        d.file_id ? "Dispute evidence added" : "Dispute note added",
        ctx.s.scope,
        t,
        side === "payer" ? "contractor" : side === "contractor" ? "payer" : undefined,
      );
      return event;
    });
  }
  async propose(user, id, input) {
    const d = schemas.split.parse(input);
    return this.db.transaction(async (t) => {
      const { ctx, dispute, side } = await this.load(user, id, t, true);
      check(side, 403, "Only the contracting parties can propose a resolution");
      check(dispute.status === "open", 409, "This dispute is closed");
      check(
        toCents(d.to_contractor) + toCents(d.to_payer) === cents(dispute.amount_held),
        422,
        `The split must add up to the held USD ${dispute.amount_held}`,
      );
      await dispute.update(
        {
          proposal_contractor: d.to_contractor,
          proposal_payer: d.to_payer,
          proposal_note: d.note,
          proposed_side: side,
          proposed_by_user_id: user,
          proposed_at: new Date(),
          updated_at: new Date(),
        },
        { transaction: t },
      );
      await this.event(dispute, user, side, "proposal", {
        body: d.note,
        amount_contractor: d.to_contractor,
        amount_payer: d.to_payer,
      }, t);
      await this.billing.notify(
        ctx,
        user,
        "Dispute resolution proposed",
        `${ctx.s.scope} · USD ${amount(toCents(d.to_contractor))} to contractor, USD ${amount(toCents(d.to_payer))} back to payer`,
        t,
        side === "payer" ? "contractor" : "payer",
      );
      return dispute;
    });
  }
  async respond(user, id, input) {
    const d = schemas.response.parse(input);
    const outcome = await this.db.transaction(async (t) => {
      const { ctx, dispute, side } = await this.load(user, id, t, true);
      check(side, 403, "Only the contracting parties can respond");
      check(dispute.status === "open", 409, "This dispute is closed");
      check(dispute.proposed_side, 409, "There is no proposal to respond to");
      check(side !== dispute.proposed_side, 403, "The other party must respond to this proposal");
      if (d.decision === "reject") {
        await this.event(dispute, user, side, "rejected", {
          body: d.note,
          amount_contractor: dispute.proposal_contractor,
          amount_payer: dispute.proposal_payer,
        }, t);
        await dispute.update(
          {
            proposal_contractor: null,
            proposal_payer: null,
            proposal_note: "",
            proposed_side: null,
            proposed_by_user_id: null,
            proposed_at: null,
            updated_at: new Date(),
          },
          { transaction: t },
        );
        await this.billing.notify(ctx, user, "Dispute proposal rejected", ctx.s.scope, t, side === "payer" ? "contractor" : "payer");
        return { dispute, releases: [], refunds: [] };
      }
      await this.event(dispute, user, side, "accepted", {
        body: d.note,
        amount_contractor: dispute.proposal_contractor,
        amount_payer: dispute.proposal_payer,
      }, t);
      return this.resolve(dispute, user, "agreement", {
        to_contractor: dispute.proposal_contractor,
        to_payer: dispute.proposal_payer,
        note: d.note || dispute.proposal_note,
      }, side, t);
    });
    return this.settle(outcome);
  }
  async mediate(user, id, input) {
    const d = schemas.split.parse(input);
    const outcome = await this.db.transaction(async (t) => {
      await this.requireAdmin(user, t);
      const first = await this.platform.get("Dispute", id, t);
      await this.platform.work(first.subdivision_id, t);
      const dispute = await this.platform.get("Dispute", id, t, true);
      check(dispute.status === "open", 409, "This dispute is closed");
      check(
        toCents(d.to_contractor) + toCents(d.to_payer) === cents(dispute.amount_held),
        422,
        `The split must add up to the held USD ${dispute.amount_held}`,
      );
      return this.resolve(dispute, user, "mediation", d, "mediator", t);
    });
    return this.settle(outcome);
  }
  async withdraw(user, id, input) {
    const d = schemas.note.parse(input);
    return this.db.transaction(async (t) => {
      const { ctx, dispute, side } = await this.load(user, id, t, true);
      check(side && side === dispute.opened_side, 403, "Only the party that opened the dispute can withdraw it");
      check(dispute.status === "open", 409, "This dispute is closed");
      await dispute.update({ status: "withdrawn", updated_at: new Date() }, { transaction: t });
      await this.event(dispute, user, side, "withdrawn", { body: d.note }, t);
      await this.billing.notify(ctx, user, "Dispute withdrawn", `${ctx.s.scope} · held funds are available again`, t, side === "payer" ? "contractor" : "payer");
      return dispute;
    });
  }
  // Writes the agreed split to the release ledger inside the caller's transaction (scope already locked).
  async resolve(dispute, user, method, split, side, t) {
    const s = await this.platform.get("ProjectSubdivision", dispute.subdivision_id, t);
    const held = cents(dispute.amount_held);
    const toContractor = toCents(split.to_contractor);
    const toPayer = toCents(split.to_payer);
    const records = await this.funding.ledgerRecords(s.id, t, true);
    const otherHolds = (await this.funding.holds(s.id, t)) - held;
    check(
      cents(this.funding.summarize(records, 0n).unreleased) - otherHolds >= held,
      409,
      "The held funds are no longer fully available. Refresh the ledger and try again.",
    );
    const releases = [];
    const refunds = [];
    let account = null;
    if (toContractor > 0n) {
      account = await this.funding.accountFor(s.awarded_user_id, s.awarded_org_id, t);
      check(account?.transfers_active, 409, "The contractor must finish payout onboarding before a split can pay them");
    }
    const allocate = async (total, create) => {
      let remaining = total;
      for (const f of records.fundings) {
        if (remaining === 0n) break;
        const available = this.funding.fundingAvailable(f, {
          ...records,
          releases: [...records.releases, ...releases],
          refunds: [...records.refunds, ...refunds],
        });
        if (available <= 0n) continue;
        const part = available < remaining ? available : remaining;
        await create(f, part);
        remaining -= part;
      }
      check(remaining === 0n, 409, "Held funds could not be allocated to confirmed payments");
    };
    const releaseKey = randomUUID();
    await allocate(toContractor, async (f, part) =>
      releases.push(
        await this.m.ScopeRelease.create(
          {
            subdivision_id: s.id,
            dispute_id: dispute.id,
            funding_id: f.id,
            payment_account_id: account.id,
            amount: amount(part),
            status: "processing",
            approved_by_user_id: user,
            request_key: releaseKey,
          },
          { transaction: t },
        ),
      ),
    );
    await allocate(toPayer, async (f, part) =>
      refunds.push(
        await this.m.ScopeRefund.create(
          {
            funding_id: f.id,
            subdivision_id: s.id,
            dispute_id: dispute.id,
            amount: amount(part),
            status: "processing",
            reason: `Dispute ${dispute.id} resolution`,
            requested_by_user_id: user,
            request_key: randomUUID(),
          },
          { transaction: t },
        ),
      ),
    );
    await this.event(dispute, user, side, "resolved", {
      body: split.note || "",
      amount_contractor: amount(toContractor),
      amount_payer: amount(toPayer),
    }, t);
    const resolvedAt = new Date();
    await dispute.update(
      {
        status: "resolved",
        resolved_contractor: amount(toContractor),
        resolved_payer: amount(toPayer),
        resolution_method: method,
        resolution_note: split.note || "",
        resolved_by_user_id: user,
        resolved_at: resolvedAt,
        updated_at: resolvedAt,
      },
      { transaction: t },
    );
    const packet = await this.assemble(dispute, t);
    await dispute.update({ packet, packet_hash: hash(packet) }, { transaction: t });
    const parties = await this.funding.scopeParties(s.id, t);
    await this.billing.notify(
      parties,
      null,
      "Dispute resolved",
      `${s.scope} · USD ${amount(toContractor)} to contractor, USD ${amount(toPayer)} refunded to payer`,
      t,
    );
    return { dispute, releases, refunds };
  }
  // Provider calls run after the resolution commits; ambiguous failures stay processing for retry.
  async settle({ dispute, releases, refunds }) {
    const warnings = [];
    for (const row of releases)
      await this.funding.sendRelease(row).catch((e) => warnings.push(e.message));
    for (const row of refunds)
      await this.funding.sendRefund(row).catch((e) => warnings.push(e.message));
    return {
      dispute: await dispute.reload(),
      releases: await Promise.all(releases.map((r) => r.reload())),
      refunds: await Promise.all(refunds.map((r) => r.reload())),
      warnings,
    };
  }
  async assemble(dispute, t) {
    const s = await this.platform.get("ProjectSubdivision", dispute.subdivision_id, t);
    const p = await this.platform.get("Project", s.project_id, t);
    const parties = await this.billing.waivers.parties(s, t);
    const bid = await this.m.Bid.findOne({ where: { subdivision_id: s.id, status: "accepted" }, transaction: t, raw: true });
    const billingRecords = await this.billing.records(s.id, t);
    const ledger = await this.funding.ledgerRecords(s.id, t);
    const [labor] = await this.db.query(
      `SELECT t.id, t.date, u.full_name AS worker, t.hours::text, t.hourly_rate::text, round(t.hours*t.hourly_rate,2)::text AS cost, t.note
       FROM timesheets t JOIN users u ON u.id=t.user_id WHERE t.subdivision_id=$1 ORDER BY t.date, t.id`,
      { bind: [s.id], transaction: t },
    );
    const [materials] = await this.db.query(
      `SELECT pi.id, i.item_name, pi.qty, pi.unit_cost::text, (pi.qty*pi.unit_cost)::text AS cost, pi.consumed_at
       FROM project_inventory pi JOIN inventory_items i ON i.id=pi.item_id WHERE pi.subdivision_id=$1 ORDER BY pi.consumed_at, pi.id`,
      { bind: [s.id], transaction: t },
    );
    const events = await this.m.DisputeEvent.findAll({ where: { dispute_id: dispute.id }, order: [["id", "ASC"]], transaction: t, raw: true });
    const people = await this.m.User.findAll({ where: { id: [...new Set(events.map((e) => e.user_id))] }, attributes: ["id", "full_name"], transaction: t, raw: true });
    const files = await this.files.find(events.map((e) => e.file_id), t);
    const waivers = await this.m.LienWaiver.findAll({ where: { subdivision_id: s.id }, order: [["id", "ASC"]], transaction: t, raw: true });
    const sum = (rows, key) => amount(rows.reduce((n, r) => n + cents(r[key]), 0n));
    const packet = {
      generated_at: new Date().toISOString(),
      currency: "USD",
      dispute: {
        id: dispute.id,
        status: dispute.status,
        opened_side: dispute.opened_side,
        opened_at: dispute.created_at,
        reason: dispute.reason,
        amount_held: dispute.amount_held,
        resolution: dispute.status === "resolved"
          ? {
              method: dispute.resolution_method,
              to_contractor: dispute.resolved_contractor,
              to_payer: dispute.resolved_payer,
              note: dispute.resolution_note,
              resolved_at: dispute.resolved_at,
            }
          : null,
      },
      project: { id: p.id, title: p.title },
      scope: { id: s.id, scope: s.scope, status: s.status },
      parties: { contractor: parties.claimant, payer: parties.payer, client: parties.owner },
      contract: {
        awarded: bid?.amount,
        change_orders: billingRecords.change_orders.map((c) => ({
          id: c.id, title: c.title, amount: c.amount, schedule_days: c.schedule_days, status: c.status, decided_at: c.decided_at,
        })),
        contract_value: this.billing.totals({ bid: bid || { amount: 0 } }, billingRecords).contract_value,
      },
      labor: { entries: labor, hours: amount(labor.reduce((n, r) => n + cents(r.hours), 0n)), cost: sum(labor, "cost") },
      materials: { entries: materials, cost: sum(materials, "cost") },
      applications: billingRecords.applications.map((a) => ({
        id: a.id, period_from: a.period_from, period_to: a.period_to, status: a.status, amount_due: a.amount_due,
        gross: a.snapshot.gross, retainage: a.snapshot.retainage,
      })),
      external_payments: billingRecords.payments.map((x) => ({
        id: x.id, amount: x.amount, paid_on: x.paid_on, reference: x.reference, reverses_payment_id: x.reverses_payment_id,
      })),
      funding: {
        fundings: ledger.fundings.map((f) => ({ id: f.id, amount_received: f.amount_received, status: f.status, created_at: f.created_at })),
        releases: ledger.releases.map((r) => ({ id: r.id, amount: r.amount, status: r.status, application_id: r.application_id, dispute_id: r.dispute_id, created_at: r.created_at })),
        refunds: ledger.refunds.map((r) => ({ id: r.id, amount: r.amount, status: r.status, created_at: r.created_at })),
      },
      lien_waivers: waivers.map((w) => ({ id: w.id, kind: w.kind, status: w.status, amount: w.amount, signed_at: w.signed_at })),
      record: events.map((e) => ({
        at: e.created_at,
        by: people.find((x) => x.id === e.user_id)?.full_name,
        side: e.side,
        kind: e.kind,
        body: e.body,
        amount_contractor: e.amount_contractor,
        amount_payer: e.amount_payer,
        file: files.find((f) => f.id === e.file_id) || null,
      })),
    };
    for (const source of this.packetSources) Object.assign(packet, await source(s.id, t));
    return packet;
  }
  async packet(user, id) {
    return this.db.transaction(async (t) => {
      let dispute;
      try {
        ({ dispute } = await this.load(user, id, t));
      } catch (error) {
        if (error.status !== 403) throw error;
        await this.requireAdmin(user, t);
        dispute = await this.platform.get("Dispute", id, t);
      }
      if (dispute.packet) return { packet: dispute.packet, hash: dispute.packet_hash, frozen: true };
      const packet = await this.assemble(dispute, t);
      return { packet, hash: hash(packet), frozen: false };
    });
  }
  async adminDisputes(user) {
    await this.requireAdmin(user);
    const [rows] = await this.db.query(
      `SELECT d.id, d.status, d.amount_held::text, d.opened_side, d.created_at, d.proposed_side, s.id AS subdivision_id, s.scope, p.title AS project_title
       FROM disputes d JOIN project_subdivisions s ON s.id=d.subdivision_id JOIN projects p ON p.id=s.project_id
       WHERE d.status='open' ORDER BY d.id ASC LIMIT 200`,
    );
    return rows;
  }
  // ---- File visibility -----------------------------------------------------
  async canViewFile(user, fileId) {
    const u = await this.platform.get("User", user);
    const [disputeScopes] = await this.db.query(
      "SELECT DISTINCT d.subdivision_id FROM dispute_events e JOIN disputes d ON d.id=e.dispute_id WHERE e.file_id=$1",
      { bind: [fileId] },
    );
    const [credentialOwners] = await this.db.query(
      "SELECT owner_user_id, owner_org_id FROM credentials WHERE file_id=$1",
      { bind: [fileId] },
    );
    if (u.platform_role === "admin" && (disputeScopes.length || credentialOwners.length)) return true;
    for (const row of disputeScopes) {
      try {
        await this.db.transaction((t) => this.billing.context(user, row.subdivision_id, t));
        return true;
      } catch (error) {
        if (![403, 409].includes(error.status)) throw error;
      }
    }
    for (const owner of credentialOwners) {
      if (owner.owner_user_id === user) return true;
      const [[row]] = await this.db.query(
        `SELECT (
          EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id=$1 AND m.org_id=$3 AND m.internal_role IN ('owner','manager'))
          OR EXISTS (
            SELECT 1 FROM bids b JOIN project_subdivisions s ON s.id=b.subdivision_id JOIN projects p ON p.id=s.project_id
            LEFT JOIN project_subdivisions parent ON parent.id=s.parent_subdivision_id
            WHERE (b.bidding_user_id=$2 OR b.bidding_org_id=$3)
              AND (p.client_user_id=$1 OR parent.awarded_user_id=$1 OR EXISTS (
                SELECT 1 FROM organization_members m WHERE m.user_id=$1 AND m.org_id=parent.awarded_org_id AND m.internal_role IN ('owner','manager'))))
        ) AS allowed`,
        { bind: [user, owner.owner_user_id, owner.owner_org_id] },
      );
      if (row.allowed) return true;
    }
    return false;
  }
}
module.exports = { TrustService, KIND_LABELS, KINDS };
