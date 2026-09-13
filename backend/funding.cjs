const { payoutAging } = require("./payout-aging.cjs");
const { z } = require("zod");
const { Op } = require("sequelize");
const { check } = require("./validation.cjs");
const { releasedAmount } = require("./billing.cjs");
const { cents, amount } = require("./money.cjs");
const money = z
  .number()
  .finite()
  .min(0.5)
  .max(999999.99)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001,
    "At most two decimal places",
  );
const key = z.uuid();
const schemas = {
  account: z
    .object({ org_id: z.number().int().positive().optional() })
    .strict(),
  funding: z.object({ amount: money, request_key: key }).strict(),
  release: z
    .object({
      application_id: z.number().int().positive(),
      amount: money,
      request_key: key,
    })
    .strict(),
  refund: z
    .object({
      amount: money,
      reason: z.string().trim().min(1).max(2000),
      request_key: key,
    })
    .strict(),
  payout: z.object({ amount: money, request_key: key }).strict(),
};
const RANK = { pending: 0, processing: 1, succeeded: 2, failed: 2, expired: 2 };
// A disputed card payment cannot fund releases until Stripe closes the dispute in our favour.
const blocked = (f) =>
  f.provider_dispute_status && f.provider_dispute_status !== "won";
const unavailable = () => {
  const error = new Error(
    "Online funding is not configured. Add Stripe test keys to enable it.",
  );
  error.status = 503;
  return error;
};
class FundingService {
  constructor(platform, billing, provider, { appUrl, logger = console } = {}) {
    this.platform = platform;
    this.billing = billing;
    this.provider = provider;
    this.db = platform.db;
    this.m = platform.m;
    this.appUrl = appUrl;
    this.logger = logger;
    // Later releases (disputes) register additional hold sources here.
    this.holdSources = [];
  }
  get configured() {
    return !!this.provider;
  }
  requireProvider() {
    if (!this.provider) throw unavailable();
    return this.provider;
  }
  url(origin, hash) {
    return `${this.appUrl || origin}/console#${hash}`;
  }
  // ---- Connected accounts -------------------------------------------------
  async ownerFor(user, orgId, t) {
    if (orgId) await this.platform.member(user, orgId, t, true);
    return orgId ? { owner_org_id: orgId } : { owner_user_id: user };
  }
  async accountFor(userId, orgId, t) {
    return this.m.PaymentAccount.findOne({
      where: orgId ? { owner_org_id: orgId } : { owner_user_id: userId },
      transaction: t,
    });
  }
  async startOnboarding(user, input, origin) {
    const provider = this.requireProvider();
    const { org_id } = schemas.account.parse(input);
    const owner = await this.ownerFor(user, org_id);
    let account = await this.m.PaymentAccount.findOne({ where: owner });
    if (!account) {
      const u = await this.platform.get("User", user);
      const created = await provider.createAccount({
        email: u.email,
        metadata: {
          workorder_owner: org_id ? `org:${org_id}` : `user:${user}`,
        },
      });
      try {
        account = await this.m.PaymentAccount.create({
          ...owner,
          provider: "stripe",
          provider_account_id: created.id,
          country: provider.country,
          default_currency: "usd",
          ...this.accountFlags(created),
          created_by_user_id: user,
        });
      } catch (error) {
        // A concurrent request created the owner's account first; reuse it.
        if (error.name !== "SequelizeUniqueConstraintError") throw error;
        account = await this.m.PaymentAccount.findOne({ where: owner });
      }
    }
    const url = await provider.accountLink(
      account.provider_account_id,
      this.url(origin, "billing/payouts?onboarding=refresh"),
      this.url(origin, "billing/payouts?onboarding=return"),
    );
    return { account: this.publicAccount(account), url };
  }
  accountFlags(a) {
    return {
      details_submitted: a.details_submitted,
      charges_enabled: a.charges_enabled,
      payouts_enabled: a.payouts_enabled,
      transfers_active: a.transfers_active,
      requirements: a.requirements,
      updated_at: new Date(),
    };
  }
  publicAccount(a) {
    const {
      id,
      owner_user_id,
      owner_org_id,
      country,
      default_currency,
      details_submitted,
      payouts_enabled,
      transfers_active,
      requirements,
      updated_at,
    } = a.get ? a.get({ plain: true }) : a;
    return {
      id,
      owner_user_id,
      owner_org_id,
      country,
      default_currency,
      details_submitted,
      payouts_enabled,
      transfers_active,
      requirements,
      updated_at,
    };
  }
  async manageAccount(user, id, t) {
    const account = await this.platform.get("PaymentAccount", id, t);
    if (account.owner_org_id)
      await this.platform.member(user, account.owner_org_id, t, true);
    else
      check(
        account.owner_user_id === user,
        403,
        "Only the account owner can manage payouts",
      );
    return account;
  }
  async refreshAccount(user, id) {
    const provider = this.requireProvider();
    const account = await this.manageAccount(user, id);
    const remote = await provider.retrieveAccount(account.provider_account_id);
    await account.update(this.accountFlags(remote));
    return this.publicAccount(account);
  }
  async accounts(user) {
    const memberships = await this.m.OrganizationMember.findAll({
      where: {
        user_id: user,
        internal_role: { [Op.in]: ["owner", "manager"] },
      },
    });
    const rows = await this.m.PaymentAccount.findAll({
      where: {
        [Op.or]: [
          { owner_user_id: user },
          { owner_org_id: { [Op.in]: memberships.map((m) => m.org_id) } },
        ],
      },
      order: [["id", "ASC"]],
    });
    return Promise.all(
      rows.map(async (account) => {
        const payouts = await this.m.ProviderPayout.findAll({
          where: { payment_account_id: account.id },
          order: [["id", "DESC"]],
          raw: true,
        });
        const releases = await this.m.ScopeRelease.findAll({
          where: { payment_account_id: account.id },
          raw: true,
        });
        const aging = payoutAging(releases, payouts, account.country);
        let balance = null;
        if (this.provider && account.transfers_active)
          balance = await this.provider
            .balance(account.provider_account_id)
            .catch((error) => {
              this.logger.warn(error.message);
              return null;
            });
        return {
          ...this.publicAccount(account),
          balance,
          payouts: payouts.slice(0, 20),
          aging,
          oldest_unpaid_release_at: aging.oldest_unpaid_release_at,
        };
      }),
    );
  }
  async holdingReport(user) {
    const actor = await this.platform.get("User", user);
    check(
      actor.platform_role === "admin",
      403,
      "Platform administrator access required",
    );
    return this.db.transaction(
      { isolationLevel: "REPEATABLE READ" },
      async (t) => {
        const accounts = await this.m.PaymentAccount.findAll({
          order: [["id", "ASC"]],
          transaction: t,
          raw: true,
        });
        const releases = await this.m.ScopeRelease.findAll({
          transaction: t,
          raw: true,
        });
        const payouts = await this.m.ProviderPayout.findAll({
          transaction: t,
          raw: true,
        });
        return accounts
          .map((a) => ({
            id: a.id,
            owner_user_id: a.owner_user_id,
            owner_org_id: a.owner_org_id,
            country: a.country,
            ...payoutAging(
              releases.filter((r) => r.payment_account_id === a.id),
              payouts.filter((p) => p.payment_account_id === a.id),
              a.country,
            ),
          }))
          .sort((a, b) =>
            (a.next_deadline || "9999").localeCompare(
              b.next_deadline || "9999",
            ),
          );
      },
    );
  }
  // ---- Scope ledger -------------------------------------------------------
  async ledgerRecords(id, t, lock = false) {
    const options = {
      where: { subdivision_id: id },
      order: [["id", "ASC"]],
      transaction: t,
      ...(lock ? { lock: t.LOCK.UPDATE } : {}),
    };
    return {
      fundings: await this.m.ScopeFunding.findAll(options),
      refunds: await this.m.ScopeRefund.findAll(options),
      releases: await this.m.ScopeRelease.findAll(options),
    };
  }
  async holds(id, t) {
    let total = 0n;
    for (const source of this.holdSources) total += await source(id, t);
    return total;
  }
  fundingAvailable(f, records) {
    if (f.status !== "succeeded" || !f.charge_id || blocked(f)) return 0n;
    const refunded = records.refunds
      .filter(
        (r) =>
          r.funding_id === f.id &&
          ["processing", "succeeded"].includes(r.status),
      )
      .reduce((n, r) => n + cents(r.amount), 0n);
    const released = releasedAmount(
      records.releases.filter((r) => r.funding_id === f.id),
    );
    return cents(f.amount_received) - refunded - released;
  }
  summarize(records, held = 0n) {
    const succeeded = records.fundings.filter((f) => f.status === "succeeded");
    const received = succeeded.reduce(
      (n, f) => n + cents(f.amount_received),
      0n,
    );
    const refunded = records.refunds
      .filter((r) => r.status === "succeeded")
      .reduce((n, r) => n + cents(r.amount), 0n);
    const unreleased = succeeded.reduce(
      (n, f) => n + this.fundingAvailable(f, records),
      0n,
    );
    const disputed = succeeded
      .filter(blocked)
      .reduce((n, f) => n + cents(f.amount_received), 0n);
    const available = unreleased > held ? unreleased - held : 0n;
    return {
      currency: "USD",
      funded: amount(received),
      refunded: amount(refunded),
      released: amount(
        releasedAmount(
          records.releases.filter((r) => r.status !== "processing"),
        ),
      ),
      releasing: amount(
        records.releases
          .filter((r) => r.status === "processing")
          .reduce((n, r) => n + cents(r.amount), 0n),
      ),
      pending: amount(
        records.fundings
          .filter((f) => ["pending", "processing"].includes(f.status))
          .reduce((n, f) => n + cents(f.amount), 0n),
      ),
      unreleased: amount(unreleased),
      held: amount(held),
      disputed: amount(disputed),
      available: amount(available),
    };
  }
  async detail(user, id) {
    return this.db.transaction(async (t) => {
      const ctx = await this.billing.context(user, id, t);
      const records = await this.ledgerRecords(id, t);
      const contractorAccount = await this.accountFor(
        ctx.s.awarded_user_id,
        ctx.s.awarded_org_id,
        t,
      );
      return {
        configured: this.configured,
        live: !!this.provider?.live,
        permissions: { payer: ctx.payer, contractor: ctx.contractor },
        contractor_account: {
          exists: !!contractorAccount,
          transfers_active: !!contractorAccount?.transfers_active,
          id: ctx.contractor ? contractorAccount?.id || null : null,
        },
        totals: this.summarize(records, await this.holds(id, t)),
        fundings: records.fundings.map((f) => {
          const { checkout_url, request_key, ...rest } = f.get({ plain: true });
          // Only the paying party may reopen its pending checkout.
          return {
            ...rest,
            checkout_url:
              ctx.payer && f.status === "pending" ? checkout_url : null,
            available: amount(this.fundingAvailable(f, records)),
          };
        }),
        refunds: records.refunds,
        releases: records.releases,
      };
    });
  }
  // ---- Funding via Checkout ----------------------------------------------
  async fund(user, id, input, origin) {
    const provider = this.requireProvider();
    const data = schemas.funding.parse(input);
    const prepared = await this.db.transaction(async (t) => {
      const ctx = await this.billing.context(user, id, t);
      check(
        ctx.payer && !ctx.contractor,
        403,
        "Only the paying party can fund this scope",
      );
      const existing = await this.m.ScopeFunding.findOne({
        where: { request_key: data.request_key },
        transaction: t,
      });
      if (existing) {
        check(
          existing.subdivision_id === id &&
            existing.funded_by_user_id === user &&
            cents(existing.amount) === cents(data.amount),
          409,
          "This request key was already used",
        );
        return { funding: existing, ctx, retry: true };
      }
      const records = await this.ledgerRecords(id, t);
      check(
        !records.fundings.some((f) =>
          ["pending", "processing"].includes(f.status),
        ),
        409,
        "Finish, cancel or refresh the open funding checkout before starting another",
      );
      const billingRecords = await this.billing.records(id, t);
      const contract = cents(
        this.billing.totals(ctx, billingRecords).contract_value,
      );
      const committed =
        records.fundings
          .filter((f) => f.status === "succeeded")
          .reduce((n, f) => n + cents(f.amount_received), 0n) -
        records.refunds
          .filter((r) => ["processing", "succeeded"].includes(r.status))
          .reduce((n, r) => n + cents(r.amount), 0n);
      // Funds already released to the contractor remain committed to the contract.
      check(
        committed + cents(data.amount) <= contract,
        409,
        `Funding cannot exceed the amended contract price. Up to USD ${amount(contract - committed)} can still be funded.`,
      );
      const funding = await this.m.ScopeFunding.create(
        {
          subdivision_id: id,
          funded_by_user_id: user,
          amount: data.amount,
          request_key: data.request_key,
          status: "pending",
        },
        { transaction: t },
      );
      return { funding, ctx };
    });
    const { funding, ctx } = prepared;
    if (funding.checkout_session_id || funding.status !== "pending")
      return this.publicFunding(funding);
    const payer = await this.platform.get("User", user);
    let session;
    try {
      session = await provider.createCheckout({
        amount: funding.amount,
        description: `WorkOrder scope funding · ${ctx.p.title} · ${ctx.s.scope}`,
        transferGroup: `scope_${id}`,
        successUrl: this.url(origin, `billing/${id}?funding=${funding.id}`),
        cancelUrl: this.url(origin, `billing/${id}?funding=${funding.id}`),
        metadata: {
          workorder_funding_id: String(funding.id),
          workorder_subdivision_id: String(id),
        },
        idempotencyKey: `funding-${funding.id}`,
        email: payer.email,
      });
    } catch (error) {
      if (error.definitive)
        await funding.update({
          status: "failed",
          failure_message: error.message.slice(0, 2000),
          updated_at: new Date(),
        });
      throw error;
    }
    await funding.update({
      checkout_session_id: session.id,
      checkout_url: session.url,
      updated_at: new Date(),
    });
    return this.publicFunding(funding);
  }
  publicFunding(f) {
    const { request_key, ...rest } = f.get({ plain: true });
    return rest;
  }
  async refreshFunding(user, id) {
    const provider = this.requireProvider();
    const funding = await this.platform.get("ScopeFunding", id);
    await this.db.transaction((t) =>
      this.billing.context(user, funding.subdivision_id, t),
    );
    if (!funding.checkout_session_id) return this.publicFunding(funding);
    await this.applySession(
      await provider.retrieveCheckout(funding.checkout_session_id),
    );
    return this.publicFunding(await funding.reload());
  }
  sessionState(session) {
    if (session.status === "expired") return "expired";
    if (session.status !== "complete") return "pending";
    if (
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required"
    )
      return "succeeded";
    if (
      ["canceled", "requires_payment_method"].includes(
        session.payment_intent_status,
      )
    )
      return "failed";
    return "processing";
  }
  async applySession(session, forced, outer) {
    const run = async (t) => {
      const funding = await this.m.ScopeFunding.findOne({
        where: { checkout_session_id: session.id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!funding) return null;
      const next = forced || this.sessionState(session);
      // States only move forward, so late or replayed events cannot undo a confirmed payment.
      if (RANK[next] < RANK[funding.status] || RANK[funding.status] === 2)
        return funding;
      if (next === funding.status) return funding;
      const update = { status: next, updated_at: new Date() };
      if (session.payment_intent_id)
        update.payment_intent_id = session.payment_intent_id;
      if (session.charge_id) update.charge_id = session.charge_id;
      if (next === "succeeded") {
        check(
          session.charge_id,
          502,
          "Stripe confirmed payment without a charge; retry reconciliation",
        );
        const received = cents(session.amount_total);
        update.amount_received = amount(
          received > cents(funding.amount) ? cents(funding.amount) : received,
        );
      }
      if (next === "failed")
        update.failure_message = (session.last_error || "Payment failed").slice(
          0,
          2000,
        );
      await funding.update(update, { transaction: t });
      if (["succeeded", "failed"].includes(next)) {
        const ctx = await this.scopeParties(funding.subdivision_id, t);
        await this.billing.notify(
          ctx,
          null,
          next === "succeeded" ? "Scope funded" : "Scope funding failed",
          `${ctx.s.scope} · USD ${amount(cents(next === "succeeded" ? update.amount_received : funding.amount))}`,
          t,
        );
      }
      return funding;
    };
    return outer ? run(outer) : this.db.transaction(run);
  }
  // Minimal context for provider-driven notifications, which have no acting user.
  async scopeParties(id, t) {
    const s = await this.platform.get("ProjectSubdivision", id, t);
    const p = await this.platform.get("Project", s.project_id, t);
    const parent = s.parent_subdivision_id
      ? await this.platform.get(
          "ProjectSubdivision",
          s.parent_subdivision_id,
          t,
        )
      : null;
    const payerOrg = parent?.awarded_org_id || null;
    return {
      s,
      p,
      payerOrg,
      payerUser: payerOrg ? null : parent?.awarded_user_id || p.client_user_id,
    };
  }
  // ---- Releases (transfers to the contractor's connected account) --------
  async release(user, id, input) {
    const provider = this.requireProvider();
    const data = schemas.release.parse(input);
    const rows = await this.db.transaction(async (t) => {
      const ctx = await this.billing.context(user, id, t);
      check(
        ctx.payer && !ctx.contractor,
        403,
        "Only the paying party can release funds",
      );
      const existing = await this.m.ScopeRelease.findAll({
        where: { request_key: data.request_key },
        transaction: t,
      });
      if (existing.length) {
        check(
          existing.every(
            (r) =>
              r.subdivision_id === id &&
              r.application_id === data.application_id,
          ) &&
            existing.reduce((n, r) => n + cents(r.amount), 0n) ===
              cents(data.amount),
          409,
          "This request key was already used",
        );
        return existing;
      }
      const application = await this.platform.get(
        "PayApplication",
        data.application_id,
        t,
        true,
      );
      check(
        application.subdivision_id === id,
        422,
        "The application belongs to another scope",
      );
      check(
        application.status === "approved",
        409,
        "Approve the application before releasing funds",
      );
      await this.billing.waivers.sync(application.id, t);
      check(
        await this.m.LienWaiver.findOne({
          where: {
            application_id: application.id,
            conditional: true,
            status: "signed",
          },
          transaction: t,
        }),
        409,
        "The contractor must sign the conditional lien waiver for this application before funds are released",
      );
      const account = await this.accountFor(
        ctx.s.awarded_user_id,
        ctx.s.awarded_org_id,
        t,
      );
      check(
        account?.transfers_active,
        409,
        "The contractor must finish payout onboarding before funds can be released",
      );
      const records = await this.ledgerRecords(id, t, true);
      const billingRecords = await this.billing.records(id, t);
      const external = billingRecords.payments
        .filter((p) => p.application_id === application.id)
        .reduce(
          (n, p) =>
            n + (p.reverses_payment_id ? -cents(p.amount) : cents(p.amount)),
          0n,
        );
      const already = releasedAmount(
        records.releases.filter((r) => r.application_id === application.id),
      );
      const unpaid = cents(application.amount_due) - external - already;
      check(
        cents(data.amount) <= unpaid,
        409,
        `Release cannot exceed the application's unpaid certified balance of USD ${amount(unpaid > 0n ? unpaid : 0n)}`,
      );
      const summary = this.summarize(records, await this.holds(id, t));
      check(
        cents(data.amount) <= cents(summary.available),
        409,
        `Only USD ${summary.available} is funded and available to release on this scope`,
      );
      let remaining = cents(data.amount);
      const created = [];
      for (const funding of records.fundings) {
        if (remaining === 0n) break;
        const available = this.fundingAvailable(funding, {
          ...records,
          releases: [...records.releases, ...created],
        });
        if (available <= 0n) continue;
        const part = available < remaining ? available : remaining;
        created.push(
          await this.m.ScopeRelease.create(
            {
              subdivision_id: id,
              application_id: application.id,
              funding_id: funding.id,
              payment_account_id: account.id,
              amount: amount(part),
              status: "processing",
              approved_by_user_id: user,
              request_key: data.request_key,
            },
            { transaction: t },
          ),
        );
        remaining -= part;
      }
      check(remaining === 0n, 409, "Funds are not available to release");
      return created;
    });
    for (const row of rows) await this.sendRelease(row, provider);
    return Promise.all(rows.map((r) => r.reload()));
  }
  async sendRelease(row, provider = this.requireProvider()) {
    if (row.status !== "processing" || row.provider_transfer_id) return row;
    const funding = await this.platform.get("ScopeFunding", row.funding_id);
    const account = await this.platform.get(
      "PaymentAccount",
      row.payment_account_id,
    );
    try {
      const transfer = await provider.createTransfer({
        amount: row.amount,
        destination: account.provider_account_id,
        sourceTransaction: funding.charge_id,
        transferGroup: `scope_${row.subdivision_id}`,
        metadata: {
          workorder_release_id: String(row.id),
          workorder_application_id: String(row.application_id),
        },
        idempotencyKey: `release-${row.id}`,
      });
      await this.db.transaction(async (t) => {
        // Same lock order as release(): project → scope → ledger rows → waivers.
        await this.platform.work(row.subdivision_id, t);
        await row.update(
          {
            status: "paid",
            provider_transfer_id: transfer.id,
            failure_message: "",
            updated_at: new Date(),
          },
          { transaction: t },
        );
        if (row.application_id)
          await this.billing.waivers.sync(row.application_id, t);
        const ctx = await this.scopeParties(row.subdivision_id, t);
        await this.billing.notify(
          ctx,
          null,
          "Funds released",
          `${ctx.s.scope} · USD ${amount(cents(row.amount))} to the contractor's payout balance${row.dispute_id ? " under a dispute resolution" : ""}`,
          t,
        );
      });
    } catch (error) {
      await row.update({
        // Ambiguous failures stay reserved until a retry with the same idempotency key resolves them.
        status: error.definitive ? "failed" : "processing",
        failure_message: error.message.slice(0, 2000),
        updated_at: new Date(),
      });
      if (!error.definitive) throw error;
    }
    return row;
  }
  async retryRelease(user, id) {
    const row = await this.platform.get("ScopeRelease", id);
    const ctx = await this.db.transaction((t) =>
      this.billing.context(user, row.subdivision_id, t),
    );
    check(ctx.payer && !ctx.contractor, 403, "Only the paying party can retry");
    check(
      row.status === "processing",
      409,
      "Only processing releases can be retried",
    );
    return this.sendRelease(row);
  }
  // ---- Refunds of unreleased funding -------------------------------------
  async refund(user, fundingId, input) {
    const provider = this.requireProvider();
    const data = schemas.refund.parse(input);
    const row = await this.db.transaction(async (t) => {
      const first = await this.platform.get("ScopeFunding", fundingId, t);
      const ctx = await this.billing.context(user, first.subdivision_id, t);
      check(
        ctx.payer && !ctx.contractor,
        403,
        "Only the paying party can refund funding",
      );
      const existing = await this.m.ScopeRefund.findOne({
        where: { request_key: data.request_key },
        transaction: t,
      });
      if (existing) {
        check(
          existing.funding_id === fundingId &&
            cents(existing.amount) === cents(data.amount),
          409,
          "This request key was already used",
        );
        return existing;
      }
      const records = await this.ledgerRecords(first.subdivision_id, t, true);
      const funding = records.fundings.find((f) => f.id === fundingId);
      const available = this.fundingAvailable(funding, records);
      const held = await this.holds(first.subdivision_id, t);
      const scopeAvailable = cents(this.summarize(records, held).available);
      const limit = available < scopeAvailable ? available : scopeAvailable;
      check(
        cents(data.amount) <= limit,
        409,
        `Only USD ${amount(limit > 0n ? limit : 0n)} of this funding is unreleased and refundable`,
      );
      return this.m.ScopeRefund.create(
        {
          funding_id: fundingId,
          subdivision_id: first.subdivision_id,
          amount: data.amount,
          reason: data.reason,
          requested_by_user_id: user,
          request_key: data.request_key,
          status: "processing",
        },
        { transaction: t },
      );
    });
    return this.sendRefund(row, provider);
  }
  async sendRefund(row, provider = this.requireProvider()) {
    if (row.provider_refund_id || row.status !== "processing") return row;
    const funding = await this.platform.get("ScopeFunding", row.funding_id);
    try {
      const refund = await provider.createRefund({
        paymentIntent: funding.payment_intent_id,
        amount: row.amount,
        metadata: { workorder_refund_id: String(row.id) },
        idempotencyKey: `refund-${row.id}`,
      });
      await this.applyRefund(refund, row.id);
    } catch (error) {
      if (!error.definitive) throw error;
      await row.update({
        status: "failed",
        failure_message: error.message.slice(0, 2000),
        updated_at: new Date(),
      });
    }
    return row.reload();
  }
  async applyRefund(refund, localId, outer) {
    const run = async (t) => {
      const row = await this.m.ScopeRefund.findOne({
        where: localId ? { id: localId } : { provider_refund_id: refund.id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row || row.status !== "processing") return row;
      const status =
        refund.status === "succeeded"
          ? "succeeded"
          : ["failed", "canceled"].includes(refund.status)
            ? "failed"
            : "processing";
      await row.update(
        {
          provider_refund_id: refund.id,
          status,
          failure_message: refund.failure_reason || "",
          updated_at: new Date(),
        },
        { transaction: t },
      );
      if (status === "succeeded") {
        const ctx = await this.scopeParties(row.subdivision_id, t);
        await this.billing.notify(
          ctx,
          null,
          "Scope funding refunded",
          `${ctx.s.scope} · USD ${amount(cents(row.amount))}`,
          t,
        );
      }
      return row;
    };
    return outer ? run(outer) : this.db.transaction(run);
  }
  // ---- Contractor-initiated payouts --------------------------------------
  async payout(user, accountId, input) {
    const provider = this.requireProvider();
    const data = schemas.payout.parse(input);
    const account = await this.manageAccount(user, accountId);
    check(
      account.payouts_enabled,
      409,
      "Finish payout onboarding before paying out",
    );
    const existing = await this.m.ProviderPayout.findOne({
      where: { request_key: data.request_key },
    });
    if (existing) {
      check(
        existing.payment_account_id === accountId &&
          cents(existing.amount) === cents(data.amount),
        409,
        "This request key was already used",
      );
      return existing;
    }
    const balance = await provider.balance(account.provider_account_id);
    check(
      cents(data.amount) <= cents(balance.available),
      409,
      `Only USD ${balance.available} is available to pay out`,
    );
    const row = await this.m.ProviderPayout.create({
      payment_account_id: accountId,
      amount: data.amount,
      requested_by_user_id: user,
      request_key: data.request_key,
      status: "requested",
    });
    try {
      const payout = await provider.createPayout({
        account: account.provider_account_id,
        amount: row.amount,
        metadata: { workorder_payout_id: String(row.id) },
        idempotencyKey: `payout-${row.id}`,
      });
      await row.update({
        provider_payout_id: payout.id,
        status: payout.status,
        failure_message: payout.failure_message || "",
        updated_at: new Date(),
      });
    } catch (error) {
      if (error.definitive)
        await row.update({
          status: "failed",
          failure_message: error.message.slice(0, 2000),
          updated_at: new Date(),
        });
      throw error;
    }
    return row;
  }
  // ---- Webhooks ------------------------------------------------------------
  async webhook(rawBody, signature) {
    const provider = this.requireProvider();
    const event = provider.constructEvent(rawBody, signature);
    const object = event.data?.object || {};
    // Checkout state is re-read from Stripe so out-of-order deliveries apply the latest truth.
    const session = event.type.startsWith("checkout.session.")
      ? await provider.retrieveCheckout(object.id)
      : null;
    return this.db.transaction(async (t) => {
      await this.db.query(
        `INSERT INTO provider_events(id,type,account,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        {
          bind: [
            event.id,
            event.type,
            event.account || null,
            JSON.stringify(event),
          ],
          transaction: t,
        },
      );
      const [[stored]] = await this.db.query(
        "SELECT processed_at FROM provider_events WHERE id=$1 FOR UPDATE",
        { bind: [event.id], transaction: t },
      );
      if (stored.processed_at) return { received: true, duplicate: true };
      await this.handle(event, object, session, t);
      await this.db.query(
        "UPDATE provider_events SET processed_at=now() WHERE id=$1",
        {
          bind: [event.id],
          transaction: t,
        },
      );
      return { received: true };
    });
  }
  async handle(event, object, session, t) {
    if (session) {
      const forced =
        event.type === "checkout.session.async_payment_failed"
          ? "failed"
          : undefined;
      return this.applySession(session, forced, t);
    }
    if (event.type === "account.updated") {
      const { normalizeAccount } = require("./payments.cjs");
      const account = await this.m.PaymentAccount.findOne({
        where: { provider_account_id: object.id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (account)
        await account.update(this.accountFlags(normalizeAccount(object)), {
          transaction: t,
        });
      return;
    }
    if (event.type.startsWith("refund."))
      return this.applyRefund(object, null, t);
    if (
      event.type === "transfer.reversed" ||
      event.type === "transfer.updated"
    ) {
      const found = await this.m.ScopeRelease.findOne({
        where: { provider_transfer_id: object.id },
        transaction: t,
      });
      if (!found) return;
      await this.platform.work(found.subdivision_id, t);
      const release = await this.platform.get(
        "ScopeRelease",
        found.id,
        t,
        true,
      );
      const reversed = (Number(object.amount_reversed || 0) / 100).toFixed(2);
      if (cents(reversed) <= cents(release.amount_reversed)) return;
      await release.update(
        {
          amount_reversed: reversed,
          status:
            cents(reversed) === cents(release.amount)
              ? "reversed"
              : release.status,
          updated_at: new Date(),
        },
        { transaction: t },
      );
      if (release.application_id)
        await this.billing.waivers.sync(release.application_id, t);
      return;
    }
    if (event.type.startsWith("payout.")) {
      const payout = await this.m.ProviderPayout.findOne({
        where: { provider_payout_id: object.id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!payout) return;
      const account = await this.platform.get(
        "PaymentAccount",
        payout.payment_account_id,
        t,
      );
      check(
        event.account === account.provider_account_id,
        400,
        "Payout event account does not match",
      );
      // A bank can return a payout after Stripe initially reported it paid.
      // Failed/canceled remain terminal; stale pending events cannot undo paid.
      if (
        ["failed", "canceled"].includes(payout.status) ||
        (payout.status === "paid" && object.status !== "failed")
      )
        return;
      await payout.update(
        {
          status: object.status,
          failure_message: object.failure_message || "",
          updated_at: new Date(),
        },
        { transaction: t },
      );
      return;
    }
    if (event.type.startsWith("charge.dispute.")) {
      const funding = await this.m.ScopeFunding.findOne({
        where: {
          charge_id:
            typeof object.charge === "string"
              ? object.charge
              : object.charge?.id,
        },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!funding) return;
      await funding.update(
        { provider_dispute_status: object.status, updated_at: new Date() },
        { transaction: t },
      );
      const ctx = await this.scopeParties(funding.subdivision_id, t);
      await this.billing.notify(
        ctx,
        null,
        "Card payment disputed",
        `${ctx.s.scope} · funding ${funding.id} is ${object.status}; releases from it are paused`,
        t,
      );
    }
  }
}
module.exports = { FundingService };
