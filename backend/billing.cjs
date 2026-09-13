const { z } = require("zod");
const { Op } = require("sequelize");
const { date, schemas, check } = require("./validation.cjs");
const { cents, amount } = require("./money.cjs");
const { WaiverService } = require("./waivers.cjs");
const sum = (rows, key) => rows.reduce((n, row) => n + cents(row[key]), 0n);
const money = z
  .number()
  .finite()
  .min(0)
  .max(9999999999.99)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001,
    "At most two decimal places",
  );
const note = z.string().trim().max(4000).default("");
const period = z
  .object({
    from: date,
    to: date,
    stored_materials: money.default(0),
    retainage_percent: z.number().int().min(0).max(100).default(5),
  })
  .strict();
const decision = z
  .object({
    status: z.enum(["accepted", "approved", "rejected", "withdrawn"]),
    note,
  })
  .strict();
const changes = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(10000),
    amount: z
      .number()
      .finite()
      .min(-9999999999.99)
      .max(9999999999.99)
      .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001),
    schedule_days: z.number().int().min(-3660).max(3660).default(0),
  })
  .strict();
const utcToday = () => new Date().toISOString().slice(0, 10);
// In-flight and completed provider releases both settle certified amounts; reversals restore them.
const releasedAmount = (releases) =>
  releases
    .filter((r) => ["processing", "paid", "reversed"].includes(r.status))
    .reduce((n, r) => n + cents(r.amount) - cents(r.amount_reversed), 0n);
class BillingService {
  constructor(platform) {
    this.platform = platform;
    this.db = platform.db;
    this.m = platform.m;
    this.waivers = new WaiverService(platform, this);
  }
  async manages(user, org, t) {
    if (!org) return false;
    const member = await this.m.OrganizationMember.findOne({
      where: { user_id: user, org_id: org },
      transaction: t,
      ...(t ? { lock: t.LOCK.SHARE } : {}),
    });
    return !!member?.canManage();
  }
  async context(user, id, t) {
    const { p, s } = await this.platform.work(id, t);
    check(
      ["awarded", "active", "completed"].includes(s.status),
      409,
      "Award this scope before opening billing",
    );
    const parent = s.parent_subdivision_id
      ? await this.platform.get(
          "ProjectSubdivision",
          s.parent_subdivision_id,
          t,
        )
      : null;
    // Subcontracts are billed to the immediate awarded parent, never to an unrelated project client.
    const payerOrg = parent?.awarded_org_id || null;
    const payerUser = payerOrg
      ? null
      : parent?.awarded_user_id || p.client_user_id;
    const payer = payerOrg
      ? await this.manages(user, payerOrg, t)
      : payerUser === user;
    const contractor = s.awarded_org_id
      ? await this.manages(user, s.awarded_org_id, t)
      : s.awarded_user_id === user;
    check(
      payer || contractor || p.client_user_id === user,
      403,
      "Billing is visible only to the contracting parties and project client",
    );
    const bid = await this.m.Bid.findOne({
      where: { subdivision_id: s.id, status: "accepted" },
      transaction: t,
    });
    check(bid, 409, "An accepted bid is required for billing");
    const partyName = async (userId, orgId) =>
      orgId
        ? (await this.platform.get("Organization", orgId, t)).name
        : (await this.platform.get("User", userId, t)).full_name;
    return {
      p,
      s,
      bid,
      payer,
      contractor,
      payerUser,
      payerOrg,
      payerName: await partyName(payerUser, payerOrg),
      contractorName: await partyName(s.awarded_user_id, s.awarded_org_id),
    };
  }
  async records(id, t) {
    const options = {
      where: { subdivision_id: id },
      order: [["id", "ASC"]],
      transaction: t,
      raw: true,
    };
    const change_orders = await this.m.ScopeChangeOrder.findAll(options);
    const applications = await this.m.PayApplication.findAll(options);
    const payments = await this.m.BillingPayment.findAll(options);
    const releases = await this.m.ScopeRelease.findAll(options);
    const userIds = [
      ...new Set(
        [
          ...change_orders.flatMap((r) => [
            r.proposed_by_user_id,
            r.decided_by_user_id,
          ]),
          ...applications.flatMap((r) => [
            r.submitted_by_user_id,
            r.decided_by_user_id,
          ]),
          ...payments.map((r) => r.recorded_by_user_id),
        ].filter(Boolean),
      ),
    ];
    const people = userIds.length
      ? await this.m.User.findAll({
          where: { id: { [Op.in]: userIds } },
          attributes: ["id", "full_name"],
          transaction: t,
          raw: true,
        })
      : [];
    return { change_orders, applications, payments, releases, people };
  }
  totals(ctx, records) {
    const accepted = records.change_orders.filter(
      (c) => c.status === "accepted",
    );
    const approved = records.applications.filter(
      (a) => a.status === "approved",
    );
    const paid = records.payments.reduce(
      (n, p) =>
        n + (p.reverses_payment_id ? -cents(p.amount) : cents(p.amount)),
      0n,
    );
    const released = releasedAmount(records.releases);
    const latest = approved.at(-1);
    return {
      currency: "USD",
      awarded: amount(cents(ctx.bid.amount)),
      accepted_changes: amount(sum(accepted, "amount")),
      contract_value: amount(cents(ctx.bid.amount) + sum(accepted, "amount")),
      certified: amount(sum(approved, "amount_due")),
      paid: amount(paid),
      released: amount(released),
      outstanding: amount(sum(approved, "amount_due") - paid - released),
      retainage: latest?.snapshot.retainage || "0.00",
      schedule_days: accepted.reduce((n, c) => n + c.schedule_days, 0),
    };
  }
  async detail(user, id) {
    return this.db.transaction(async (t) => {
      const ctx = await this.context(user, id, t);
      const records = await this.records(id, t);
      const [costs] = await this.db.query(
        `SELECT
        (SELECT COALESCE(sum(round(hours*hourly_rate,2)),0)::text FROM timesheets WHERE subdivision_id=$id) AS labor_cost,
        (SELECT COALESCE(sum(qty*unit_cost),0)::text FROM project_inventory WHERE subdivision_id=$id) AS material_cost`,
        { bind: { id }, transaction: t },
      );
      return {
        subdivision: ctx.s,
        project: ctx.p,
        payer_name: ctx.payerName,
        contractor_name: ctx.contractorName,
        permissions: { payer: ctx.payer, contractor: ctx.contractor },
        ...records,
        totals: this.totals(ctx, records),
        costs: costs[0],
      };
    });
  }
  async list(user, input) {
    const { project_id, ...page } = schemas.page
      .extend({
        project_id: z.coerce
          .number()
          .int()
          .positive()
          .max(2147483647)
          .optional(),
      })
      .parse(input);
    const [rows] = await this.db.query(
      `SELECT s.id, s.scope, s.status, s.project_id, s.parent_subdivision_id, p.title AS project_title,
      COALESCE(o.name,u.full_name) AS contractor_name,
      b.amount::text AS awarded,
      COALESCE((SELECT sum(amount) FROM scope_change_orders WHERE subdivision_id=s.id AND status='accepted'),0)::text AS accepted_changes,
      COALESCE((SELECT sum(amount_due) FROM pay_applications WHERE subdivision_id=s.id AND status='approved'),0)::text AS certified,
      COALESCE((SELECT sum(CASE WHEN reverses_payment_id IS NULL THEN amount ELSE -amount END) FROM billing_payments WHERE subdivision_id=s.id),0)::text AS paid,
      COALESCE((SELECT sum(amount-amount_reversed) FROM scope_releases WHERE subdivision_id=s.id AND status IN ('processing','paid','reversed')),0)::text AS released,
      COALESCE((SELECT sum(amount_received) FROM scope_fundings WHERE subdivision_id=s.id AND status='succeeded'),0)::text AS funded,
      (SELECT count(*)::int FROM pay_applications WHERE subdivision_id=s.id AND status='submitted') AS pending_applications,
      (SELECT count(*)::int FROM scope_change_orders WHERE subdivision_id=s.id AND status='proposed') AS pending_changes
      FROM project_subdivisions s JOIN projects p ON p.id=s.project_id
      JOIN bids b ON b.subdivision_id=s.id AND b.status='accepted'
      LEFT JOIN project_subdivisions parent ON parent.id=s.parent_subdivision_id
      LEFT JOIN organizations o ON o.id=s.awarded_org_id LEFT JOIN users u ON u.id=s.awarded_user_id
      WHERE ($project::int IS NULL OR p.id=$project) AND (p.client_user_id=$user OR s.awarded_user_id=$user OR parent.awarded_user_id=$user OR EXISTS (
        SELECT 1 FROM organization_members m WHERE m.user_id=$user AND m.internal_role IN ('owner','manager') AND m.org_id IN (s.awarded_org_id,parent.awarded_org_id)))
      ORDER BY s.id DESC LIMIT $limit OFFSET $offset`,
      { bind: { user, project: project_id || null, ...page } },
    );
    return rows;
  }
  async notify(ctx, actor, title, body, t, side) {
    const route = `billing/${ctx.s.id}`;
    if (side !== "contractor")
      await this.platform.notify(
        ctx.payerUser,
        ctx.payerOrg,
        actor,
        title,
        body,
        route,
        t,
      );
    if (side !== "payer")
      await this.platform.notify(
        ctx.s.awarded_user_id,
        ctx.s.awarded_org_id,
        actor,
        title,
        body,
        route,
        t,
      );
  }
  async propose(user, id, input) {
    const data = changes.parse(input);
    return this.db.transaction(async (t) => {
      const ctx = await this.context(user, id, t);
      check(
        ctx.payer || ctx.contractor,
        403,
        "Only contracting parties can propose changes",
      );
      check(
        ctx.s.status !== "completed",
        409,
        "Completed scopes are closed to new changes",
      );
      const result = await this.m.ScopeChangeOrder.create(
        {
          ...data,
          subdivision_id: id,
          proposed_by_user_id: user,
          proposed_side: ctx.payer ? "payer" : "contractor",
          status: "proposed",
        },
        { transaction: t },
      );
      await this.notify(ctx, user, "Change order proposed", data.title, t);
      return result;
    });
  }
  async decideChange(user, id, input) {
    const data = decision.parse(input);
    check(
      data.status !== "approved",
      422,
      "Choose accepted, rejected or withdrawn",
    );
    return this.db.transaction(async (t) => {
      const first = await this.platform.get("ScopeChangeOrder", id, t);
      const ctx = await this.context(user, first.subdivision_id, t);
      const change = await this.platform.get("ScopeChangeOrder", id, t, true);
      check(
        change.status === "proposed",
        409,
        "This change has already been decided",
      );
      const sameSide =
        change.proposed_side === "payer" ? ctx.payer : ctx.contractor;
      const otherSide =
        change.proposed_side === "payer" ? ctx.contractor : ctx.payer;
      check(
        data.status === "withdrawn" ? sameSide : otherSide && !sameSide,
        403,
        "The other contracting party must review the change",
      );
      if (data.status === "accepted") {
        check(
          ctx.s.status !== "completed",
          409,
          "Completed scopes are closed to changes",
        );
        const records = await this.records(ctx.s.id, t);
        const revised =
          cents(this.totals(ctx, records).contract_value) +
          cents(change.amount);
        const billed = records.applications
          .filter((a) => ["approved", "submitted"].includes(a.status))
          .reduce(
            (n, a) =>
              cents(a.snapshot.gross) > n ? cents(a.snapshot.gross) : n,
            0n,
          );
        check(
          revised >= billed && revised >= 0n,
          409,
          "The amended price cannot be below amounts already applied for",
        );
      }
      await change.update(
        {
          status: data.status,
          decided_by_user_id: user,
          decided_at: new Date(),
          decision_note: data.note,
        },
        { transaction: t },
      );
      await this.notify(
        ctx,
        user,
        `Change order ${data.status}`,
        change.title,
        t,
      );
      return change;
    });
  }
  async applicationSnapshot(ctx, data, records, t) {
    schemas.range.parse({ from: data.from, to: data.to });
    check(
      data.to <= utcToday(),
      422,
      "A billing period cannot end in the future",
    );
    check(
      !records.applications.some((a) => a.status === "submitted"),
      409,
      "Resolve the submitted application before starting another",
    );
    const previous = records.applications
      .filter((a) => a.status === "approved")
      .at(-1);
    if (previous) {
      check(
        data.from > previous.period_to,
        409,
        "The next period must start after the last approved period",
      );
      check(
        data.retainage_percent === previous.snapshot.retainage_percent ||
          (ctx.s.status === "completed" && data.retainage_percent === 0),
        409,
        "Keep the agreed retainage rate until a completed scope releases it at closeout",
      );
    }
    const [labor] = await this.db.query(
      `SELECT t.id,t.user_id,u.full_name,t.date,t.hours::text,t.hourly_rate::text,round(t.hours*t.hourly_rate,2)::text AS cost FROM timesheets t JOIN users u ON u.id=t.user_id WHERE t.subdivision_id=$id AND t.date <= $to ORDER BY t.date,t.id`,
      { bind: { id: ctx.s.id, to: data.to }, transaction: t },
    );
    const [materials] = await this.db.query(
      `SELECT pi.id,pi.item_id,i.item_name,pi.qty,pi.unit_cost::text,(pi.qty*pi.unit_cost)::text AS cost,pi.consumed_at FROM project_inventory pi JOIN inventory_items i ON i.id=pi.item_id WHERE pi.subdivision_id=$id AND pi.consumed_at < ($to::date + interval '1 day') AT TIME ZONE 'UTC' ORDER BY pi.consumed_at,pi.id`,
      { bind: { id: ctx.s.id, to: data.to }, transaction: t },
    );
    const laborCost = sum(labor, "cost"),
      materialCost = sum(materials, "cost");
    const gross = laborCost + materialCost + cents(data.stored_materials);
    const totals = this.totals(ctx, records);
    check(
      gross <= cents(totals.contract_value),
      409,
      "Recorded costs and stored materials exceed the amended contract price; agree a change before applying",
    );
    const retainage = (gross * BigInt(data.retainage_percent) + 50n) / 100n;
    const net = gross - retainage;
    const prior = cents(totals.certified);
    check(net > prior, 409, "No new amount is due for this period");
    return {
      currency: "USD",
      basis:
        "Recorded labor and consumed materials, plus declared stored materials",
      scope: ctx.s.scope,
      project: ctx.p.title,
      payer: ctx.payerName,
      contractor: ctx.contractorName,
      award_id: ctx.bid.id,
      awarded: totals.awarded,
      accepted_changes: totals.accepted_changes,
      contract_value: totals.contract_value,
      labor_cost: amount(laborCost),
      material_cost: amount(materialCost),
      stored_materials: amount(cents(data.stored_materials)),
      gross: amount(gross),
      retainage_percent: data.retainage_percent,
      retainage: amount(retainage),
      net_earned: amount(net),
      previous_certified: amount(prior),
      previous_payments: totals.paid,
      amount_due: amount(net - prior),
      sources: {
        labor,
        materials,
        change_orders: records.change_orders.filter(
          (c) => c.status === "accepted",
        ),
      },
    };
  }
  async preview(user, id, input) {
    const data = period.parse(input);
    return this.db.transaction(async (t) => {
      const ctx = await this.context(user, id, t);
      check(
        ctx.contractor,
        403,
        "Only the contractor can prepare an application",
      );
      return this.applicationSnapshot(ctx, data, await this.records(id, t), t);
    });
  }
  async submitApplication(user, id, input) {
    const { expected, ...data } = period
      .extend({ expected: z.string().min(1).max(64) })
      .parse(input);
    return this.db.transaction(async (t) => {
      const ctx = await this.context(user, id, t);
      check(
        ctx.contractor,
        403,
        "Only the contractor can submit an application",
      );
      const snapshot = await this.applicationSnapshot(
        ctx,
        data,
        await this.records(id, t),
        t,
      );
      check(
        fingerprint(snapshot) === expected,
        409,
        "The costs or contract changed. Close this form and prepare the application again.",
      );
      const result = await this.m.PayApplication.create(
        {
          subdivision_id: id,
          period_from: data.from,
          period_to: data.to,
          snapshot,
          amount_due: snapshot.amount_due,
          status: "submitted",
          submitted_by_user_id: user,
        },
        { transaction: t },
      );
      await this.waivers.sync(result.id, t);
      await this.notify(
        ctx,
        user,
        "Pay application submitted",
        `${ctx.s.scope} · USD ${snapshot.amount_due}`,
        t,
        "payer",
      );
      return result;
    });
  }
  async decideApplication(user, id, input) {
    const data = decision.parse(input);
    check(
      data.status !== "accepted",
      422,
      "Choose approved, rejected or withdrawn",
    );
    return this.db.transaction(async (t) => {
      const first = await this.platform.get("PayApplication", id, t);
      const ctx = await this.context(user, first.subdivision_id, t);
      const application = await this.platform.get(
        "PayApplication",
        id,
        t,
        true,
      );
      check(
        application.status === "submitted",
        409,
        "This application has already been decided",
      );
      check(
        data.status === "withdrawn"
          ? ctx.contractor
          : ctx.payer && !ctx.contractor,
        403,
        "Only the paying party can approve or reject an application",
      );
      await application.update(
        {
          status: data.status,
          decided_by_user_id: user,
          decided_at: new Date(),
          decision_note: data.note,
        },
        { transaction: t },
      );
      await this.waivers.sync(application.id, t);
      await this.notify(
        ctx,
        user,
        `Pay application ${data.status}`,
        ctx.s.scope,
        t,
      );
      return application;
    });
  }
  async recordPayment(user, id, input) {
    const data = z
      .object({
        amount: money.refine((n) => n > 0),
        paid_on: date,
        reference: z.string().trim().min(1).max(200),
        note,
        request_key: z.uuid(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (t) => {
      const first = await this.platform.get("PayApplication", id, t);
      const ctx = await this.context(user, first.subdivision_id, t);
      check(
        ctx.payer && !ctx.contractor,
        403,
        "Only the paying party can record a payment",
      );
      const existing = await this.m.BillingPayment.findOne({
        where: { request_key: data.request_key },
        transaction: t,
      });
      if (existing) {
        check(
          existing.application_id === id &&
            existing.recorded_by_user_id === user &&
            !existing.reverses_payment_id &&
            cents(existing.amount) === cents(data.amount) &&
            existing.reference === data.reference &&
            existing.paid_on === data.paid_on &&
            existing.note === data.note,
          409,
          "This request key was already used",
        );
        return existing;
      }
      check(
        first.status === "approved",
        409,
        "Approve the application before recording a payment",
      );
      check(
        data.paid_on <= utcToday(),
        422,
        "Payment date cannot be in the future",
      );
      const records = await this.records(ctx.s.id, t);
      const paid = records.payments
        .filter((p) => p.application_id === id)
        .reduce(
          (n, p) =>
            n + (p.reverses_payment_id ? -cents(p.amount) : cents(p.amount)),
          0n,
        );
      const released = releasedAmount(
        records.releases.filter((r) => r.application_id === id),
      );
      check(
        paid + released + cents(data.amount) <= cents(first.amount_due),
        409,
        "Payment exceeds the application’s unpaid balance",
      );
      const result = await this.m.BillingPayment.create(
        {
          ...data,
          subdivision_id: ctx.s.id,
          application_id: id,
          recorded_by_user_id: user,
        },
        { transaction: t },
      );
      await this.waivers.sync(id, t);
      await this.notify(
        ctx,
        user,
        "External payment recorded",
        `${ctx.s.scope} · USD ${amount(cents(data.amount))} · ${data.reference}`,
        t,
        "contractor",
      );
      return result;
    });
  }
  async reversePayment(user, id, input) {
    const data = z
      .object({
        note: z.string().trim().min(1).max(4000),
        request_key: z.uuid(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (t) => {
      const original = await this.platform.get("BillingPayment", id, t);
      const ctx = await this.context(user, original.subdivision_id, t);
      check(
        ctx.payer && !ctx.contractor,
        403,
        "Only the paying party can correct a payment record",
      );
      check(
        !original.reverses_payment_id,
        409,
        "A reversal cannot be reversed",
      );
      const existing = await this.m.BillingPayment.findOne({
        where: { reverses_payment_id: id },
        transaction: t,
      });
      if (existing) {
        check(
          existing.request_key === data.request_key &&
            existing.note === data.note,
          409,
          "This payment is already reversed",
        );
        return existing;
      }
      const result = await this.m.BillingPayment.create(
        {
          ...data,
          subdivision_id: ctx.s.id,
          application_id: original.application_id,
          amount: original.amount,
          paid_on: utcToday(),
          reference: `Reversal of payment ${id}`,
          recorded_by_user_id: user,
          reverses_payment_id: id,
        },
        { transaction: t },
      );
      await this.waivers.sync(original.application_id, t);
      await this.notify(
        ctx,
        user,
        "Payment record corrected",
        `${ctx.s.scope} · ${data.note}`,
        t,
      );
      return result;
    });
  }
}
const fingerprint = (snapshot) =>
  require("node:crypto")
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
module.exports = { BillingService, fingerprint, cents, amount, releasedAmount };
