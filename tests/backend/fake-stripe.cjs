// Deterministic stand-in for the Stripe adapter. Webhooks are still signed and verified
// with the real Stripe SDK so signature handling is exercised end to end.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const request = require("supertest");
const Stripe = require("stripe");
const SECRET = "whsec_test_secret";
const stripe = new Stripe("sk_test_signing_only");
function fakeProvider() {
  const state = {
    n: 0,
    accounts: new Map(),
    sessions: new Map(),
    transfers: [],
    refunds: [],
    payouts: [],
    balances: {},
    transferErrors: [],
  };
  const next = (prefix) => `${prefix}_${++state.n}`;
  return {
    name: "stripe",
    live: false,
    country: "US",
    state,
    async createAccount() {
      const a = {
        id: next("acct"),
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        transfers_active: false,
        requirements: ["external_account"],
      };
      state.accounts.set(a.id, a);
      return { ...a };
    },
    async accountLink(id, refresh, ret) {
      return `https://connect.stripe.test/${id}?return=${encodeURIComponent(ret)}`;
    },
    async retrieveAccount(id) {
      return { ...state.accounts.get(id) };
    },
    async createCheckout(o) {
      const s = {
        id: next("cs"),
        url: `https://checkout.stripe.test/${state.n}`,
        status: "open",
        payment_status: "unpaid",
        amount_total: Number(o.amount).toFixed(2),
        payment_intent_id: null,
        payment_intent_status: null,
        charge_id: null,
        last_error: "",
        metadata: o.metadata,
        options: o,
      };
      state.sessions.set(s.id, s);
      return { ...s };
    },
    async retrieveCheckout(id) {
      return { ...state.sessions.get(id) };
    },
    async createTransfer(o) {
      const error = state.transferErrors.shift();
      if (error) throw error;
      const found = state.transfers.find((t) => t.idempotencyKey === o.idempotencyKey);
      if (found) return found;
      const t = { id: next("tr"), amount_reversed: "0.00", ...o };
      state.transfers.push(t);
      return t;
    },
    async createRefund(o) {
      const r = { id: next("re"), status: "pending", ...o };
      state.refunds.push(r);
      return { id: r.id, status: r.status };
    },
    async balance(id) {
      return state.balances[id] || { available: "0.00", pending: "0.00" };
    },
    async createPayout(o) {
      const p = { id: next("po"), status: "pending", ...o };
      state.payouts.push(p);
      return { id: p.id, status: p.status };
    },
    constructEvent(raw, signature) {
      try {
        return stripe.webhooks.constructEvent(raw, signature, SECRET);
      } catch {
        const error = new Error("Invalid webhook signature");
        error.status = 400;
        throw error;
      }
    },
  };
}
const webhook = (getApp) => (type, object, extra = {}) => {
  const payload = JSON.stringify({
    id: extra.id || `evt_${randomUUID()}`,
    object: "event",
    type,
    data: { object },
    ...extra,
  });
  return request(getApp())
    .post("/api/webhooks/stripe")
    .set("content-type", "application/json")
    .set("stripe-signature", stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }))
    .send(payload);
};
// Funds a scope end to end: checkout, provider confirmation, signed webhook.
async function fundScope(ctx, funding, deliver, w, value) {
  const row = await funding.fund(w.client.id, w.sub.id, { amount: value, request_key: randomUUID() }, "https://ignored.test");
  Object.assign(ctx.provider.state.sessions.get(row.checkout_session_id), {
    status: "complete",
    payment_status: "paid",
    payment_intent_id: `pi_${row.checkout_session_id}`,
    payment_intent_status: "succeeded",
    charge_id: `ch_${row.checkout_session_id}`,
  });
  const res = await deliver("checkout.session.completed", { id: row.checkout_session_id });
  assert.equal(res.status, 200, res.text);
  return row;
}
async function onboard(ctx, funding, deliver, w) {
  const { account } = await funding.startOnboarding(
    w.worker.id,
    w.organization ? { org_id: w.organization.id } : {},
    "https://ignored.test",
  );
  const row = await ctx.database.models.PaymentAccount.findByPk(account.id);
  const res = await deliver("account.updated", {
    id: row.provider_account_id,
    details_submitted: true,
    charges_enabled: false,
    payouts_enabled: true,
    capabilities: { transfers: "active" },
    requirements: { currently_due: [], past_due: [] },
  });
  assert.equal(res.status, 200, res.text);
  return account;
}
module.exports = { fakeProvider, webhook, fundScope, onboard, SECRET, stripe };
