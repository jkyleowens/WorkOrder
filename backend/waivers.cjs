const { createHash } = require("node:crypto");
const { z } = require("zod");
const { Op } = require("sequelize");
const { check } = require("./validation.cjs");
const { cents, amount } = require("./money.cjs");
const signature = z
  .object({
    signer_name: z.string().trim().min(2).max(120),
    signer_title: z.string().trim().max(120).default(""),
    exceptions: z.string().trim().max(4000).default(""),
    confirm: z.literal(true),
  })
  .strict();
const LABELS = {
  conditional_progress: "Conditional waiver and release on progress payment",
  unconditional_progress: "Unconditional waiver and release on progress payment",
  conditional_final: "Conditional waiver and release on final payment",
  unconditional_final: "Unconditional waiver and release on final payment",
};
// Plain-language waiver text. It is not a statutory form; several US states mandate exact wording.
function waiverText(s) {
  const final = s.kind.endsWith("final");
  const scopeLine = `${s.project} · ${s.scope}`;
  const through = final ? "for all labor, services, equipment and materials furnished" : `for labor, services, equipment and materials furnished through ${s.through_date}`;
  return [
    s.conditional
      ? `Upon receipt by ${s.claimant} of payment of USD ${s.amount} from ${s.payer} under pay application PA-${String(s.application_id).padStart(4, "0")}, and when that payment has cleared, ${s.claimant} waives and releases any mechanic's lien, stop payment notice and payment bond rights it has on the work described below ${through}.`
      : `${s.claimant} has received payment of USD ${s.amount} from ${s.payer} under pay application PA-${String(s.application_id).padStart(4, "0")} and unconditionally waives and releases any mechanic's lien, stop payment notice and payment bond rights it has on the work described below ${through}.`,
    `Work: ${scopeLine}. Project client: ${s.owner}.`,
    final
      ? "This release covers the final payment, including retainage, for this work package."
      : "This release does not cover retainage, pending change orders, or work performed after the date above.",
    s.conditional
      ? "This waiver is conditional. It has no effect until the payment above has actually been received and cleared."
      : "This waiver is unconditional and effective on signature. Do not sign it until payment has been received.",
    "This document is a WorkOrder record, not a jurisdiction-specific statutory form. Confirm whether local law requires specific wording before relying on it.",
  ];
}
class WaiverService {
  constructor(platform, billing) {
    this.platform = platform;
    this.billing = billing;
    this.db = platform.db;
    this.m = platform.m;
  }
  async settled(application, t) {
    const [[row]] = await this.db.query(
      `SELECT
        COALESCE((SELECT sum(CASE WHEN reverses_payment_id IS NULL THEN amount ELSE -amount END) FROM billing_payments WHERE application_id=$1),0)::text AS external,
        COALESCE((SELECT sum(amount-amount_reversed) FROM scope_releases WHERE application_id=$1 AND status IN ('paid','reversed')),0)::text AS released`,
      { bind: [application.id], transaction: t },
    );
    return cents(row.external) + cents(row.released);
  }
  async parties(s, t) {
    const p = await this.platform.get("Project", s.project_id, t);
    const parent = s.parent_subdivision_id
      ? await this.platform.get("ProjectSubdivision", s.parent_subdivision_id, t)
      : null;
    const payer_org_id = parent?.awarded_org_id || null;
    const payer_user_id = payer_org_id
      ? null
      : parent?.awarded_user_id || p.client_user_id;
    const name = async (user, org) =>
      org
        ? (await this.platform.get("Organization", org, t)).name
        : (await this.platform.get("User", user, t)).full_name;
    return {
      p,
      payer_user_id,
      payer_org_id,
      claimant: await name(s.awarded_user_id, s.awarded_org_id),
      payer: await name(payer_user_id, payer_org_id),
      owner: await name(p.client_user_id, null),
    };
  }
  // Idempotently aligns waivers with the application's current state; call inside the writer's transaction.
  async sync(applicationId, t) {
    const application = await this.platform.get("PayApplication", applicationId, t);
    const s = await this.platform.get("ProjectSubdivision", application.subdivision_id, t);
    const waivers = await this.m.LienWaiver.findAll({
      where: { application_id: application.id, status: { [Op.ne]: "void" } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const final = application.snapshot.retainage_percent === 0 && s.status === "completed";
    const live = ["submitted", "approved"].includes(application.status);
    const settled =
      application.status === "approved" &&
      (await this.settled(application, t)) >= cents(application.amount_due);
    await this.ensure(application, s, true, live, final, waivers, t);
    await this.ensure(application, s, false, settled, final, waivers, t);
  }
  async ensure(application, s, conditional, wanted, final, waivers, t) {
    const existing = waivers.find((w) => w.conditional === conditional);
    if (!wanted) {
      if (existing?.status === "requested")
        await existing.update(
          {
            status: "void",
            void_reason: conditional
              ? `Application ${application.status}`
              : "Payment no longer covers the application",
            updated_at: new Date(),
          },
          { transaction: t },
        );
      return;
    }
    if (existing) return;
    const parties = await this.parties(s, t);
    const kind = `${conditional ? "conditional" : "unconditional"}_${final ? "final" : "progress"}`;
    const snapshot = {
      kind,
      title: LABELS[kind],
      conditional,
      application_id: application.id,
      amount: amount(cents(application.amount_due)),
      currency: "USD",
      through_date: application.period_to,
      project: parties.p.title,
      scope: s.scope,
      claimant: parties.claimant,
      payer: parties.payer,
      owner: parties.owner,
    };
    snapshot.text = waiverText(snapshot);
    await this.m.LienWaiver.create(
      {
        project_id: s.project_id,
        subdivision_id: s.id,
        application_id: application.id,
        conditional,
        kind,
        amount: snapshot.amount,
        through_date: application.period_to,
        claimant_user_id: s.awarded_org_id ? null : s.awarded_user_id,
        claimant_org_id: s.awarded_org_id || null,
        payer_user_id: parties.payer_user_id,
        payer_org_id: parties.payer_org_id,
        status: "requested",
        snapshot,
      },
      { transaction: t },
    );
    await this.platform.notify(
      s.awarded_user_id,
      s.awarded_org_id,
      null,
      "Lien waiver ready to sign",
      `${LABELS[kind]} · ${s.scope} · USD ${snapshot.amount}`,
      `billing/${s.id}`,
      t,
    );
  }
  async list(user, id) {
    return this.db.transaction(async (t) => {
      const ctx = await this.billing.context(user, id, t);
      // Applications created before waivers existed receive them on first view.
      if (ctx.payer || ctx.contractor)
        for (const a of await this.m.PayApplication.findAll({
          where: { subdivision_id: id },
          transaction: t,
        }))
          await this.sync(a.id, t);
      return this.m.LienWaiver.findAll({
        where: { subdivision_id: id },
        order: [["id", "ASC"]],
        transaction: t,
      });
    });
  }
  async get(user, id) {
    return this.db.transaction(async (t) => {
      const waiver = await this.platform.get("LienWaiver", id, t);
      const ctx = await this.billing.context(user, waiver.subdivision_id, t);
      return {
        waiver,
        permissions: { payer: ctx.payer, contractor: ctx.contractor },
        signer: waiver.signed_by_user_id
          ? (await this.platform.get("User", waiver.signed_by_user_id, t)).full_name
          : null,
      };
    });
  }
  async chain(user, projectId) {
    const p = await this.platform.get("Project", projectId);
    const scopes = await this.m.ProjectSubdivision.findAll({
      where: { project_id: projectId },
      order: [["sequence", "ASC"]],
    });
    const visible = [];
    for (const s of scopes) {
      if (!["awarded", "active", "completed"].includes(s.status)) continue;
      try {
        await this.db.transaction((t) => this.billing.context(user, s.id, t));
        visible.push(s);
      } catch (error) {
        if (![403, 409].includes(error.status)) throw error;
      }
    }
    check(
      visible.length || p.client_user_id === user,
      403,
      "Waivers are visible only to contracting parties and the project client",
    );
    const waivers = visible.length
      ? await this.m.LienWaiver.findAll({
          where: { subdivision_id: { [Op.in]: visible.map((s) => s.id) } },
          order: [["subdivision_id", "ASC"], ["id", "ASC"]],
        })
      : [];
    return {
      project: { id: p.id, title: p.title, client_user_id: p.client_user_id },
      scopes: visible.map((s) => ({
        id: s.id,
        scope: s.scope,
        parent_subdivision_id: s.parent_subdivision_id,
        status: s.status,
      })),
      waivers,
      complete:
        waivers.length > 0 &&
        waivers.every((w) => w.status !== "requested"),
    };
  }
  async sign(user, id, input) {
    const data = signature.parse(input);
    return this.db.transaction(async (t) => {
      const first = await this.platform.get("LienWaiver", id, t);
      const ctx = await this.billing.context(user, first.subdivision_id, t);
      check(
        ctx.contractor && !ctx.payer,
        403,
        "Only the claimant (the contractor on this scope) can sign its lien waiver",
      );
      await this.sync(first.application_id, t);
      const waiver = await this.platform.get("LienWaiver", id, t, true);
      check(
        waiver.status === "requested",
        409,
        waiver.status === "void"
          ? "This waiver was voided because the application or payment changed"
          : "This waiver is already signed",
      );
      const signed_at = new Date();
      const content_hash = createHash("sha256")
        .update(
          JSON.stringify({
            snapshot: waiver.snapshot,
            exceptions: data.exceptions,
            signer_name: data.signer_name,
            signer_title: data.signer_title,
            signed_by_user_id: user,
            signed_at: signed_at.toISOString(),
          }),
        )
        .digest("hex");
      await waiver.update(
        {
          status: "signed",
          exceptions: data.exceptions,
          signer_name: data.signer_name,
          signer_title: data.signer_title,
          signed_by_user_id: user,
          signed_at,
          content_hash,
          updated_at: signed_at,
        },
        { transaction: t },
      );
      await this.billing.notify(
        ctx,
        user,
        "Lien waiver signed",
        `${waiver.snapshot.title} · ${ctx.s.scope} · USD ${waiver.amount}`,
        t,
        "payer",
      );
      return waiver;
    });
  }
}
module.exports = { WaiverService, waiverText, LABELS };
