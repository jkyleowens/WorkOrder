const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const request = require("supertest");
const Stripe = require("stripe");
const { setup } = require("./harness.cjs");
const { BillingService, fingerprint } = require("../../backend/billing.cjs");
const { FundingService } = require("../../backend/funding.cjs");
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
      const found = state.transfers.find(
        (t) => t.idempotencyKey === o.idempotencyKey,
      );
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
const provider = fakeProvider();
const t = setup({ paymentProvider: provider, appUrl: "https://app.test" });
const billing = () => new BillingService(t.s);
const funding = () =>
  new FundingService(t.s, billing(), provider, { appUrl: "https://app.test" });
const deliver = (type, object, extra = {}) => {
  const payload = JSON.stringify({
    id: extra.id || `evt_${randomUUID()}`,
    object: "event",
    type,
    data: { object },
    ...extra,
  });
  return request(t.runtime.app)
    .post("/api/webhooks/stripe")
    .set("content-type", "application/json")
    .set(
      "stripe-signature",
      stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }),
    )
    .send(payload);
};
const pay = (sessionId, { paid = true } = {}) => {
  const s = provider.state.sessions.get(sessionId);
  Object.assign(s, {
    status: "complete",
    payment_status: paid ? "paid" : "unpaid",
    payment_intent_id: `pi_${sessionId}`,
    payment_intent_status: paid ? "succeeded" : "processing",
    charge_id: paid ? `ch_${sessionId}` : null,
  });
  return s;
};
async function funded(w, amount) {
  const row = await funding().fund(
    w.client.id,
    w.sub.id,
    { amount, request_key: randomUUID() },
    "https://ignored.test",
  );
  pay(row.checkout_session_id);
  const res = await deliver("checkout.session.completed", {
    id: row.checkout_session_id,
  });
  assert.equal(res.status, 200, res.text);
  return row;
}
async function approvedApplication(w, hours = 1, rate = 100, sign = true) {
  await t.s.profile(w.worker.id, { hourly_rate: rate });
  await t.s.logTime(w.worker.id, {
    subdivision_id: w.sub.id,
    hours,
    date: "2026-01-05",
  });
  const data = {
    from: "2026-01-01",
    to: "2026-01-31",
    stored_materials: 0,
    retainage_percent: 5,
  };
  const snapshot = await billing().preview(w.worker.id, w.sub.id, data);
  const a = await billing().submitApplication(w.worker.id, w.sub.id, {
    ...data,
    expected: fingerprint(snapshot),
  });
  await billing().decideApplication(w.client.id, a.id, { status: "approved" });
  if (sign) await signConditional(w, a);
  return a;
}
async function signConditional(w, a) {
  const waiver = await t.database.models.LienWaiver.findOne({
    where: { application_id: a.id, conditional: true, status: "requested" },
  });
  return billing().waivers.sign(w.worker.id, waiver.id, {
    signer_name: "Test Signer",
    confirm: true,
  });
}
async function onboarded(w) {
  const { account, url } = await funding().startOnboarding(
    w.worker.id,
    w.organization ? { org_id: w.organization.id } : {},
    "https://ignored.test",
  );
  assert.match(url, /billing%2Fpayouts/);
  const remote = provider.state.accounts.get(
    (await t.database.models.PaymentAccount.findByPk(account.id))
      .provider_account_id,
  );
  Object.assign(remote, {
    details_submitted: true,
    payouts_enabled: true,
    transfers_active: true,
    requirements: [],
  });
  const res = await deliver("account.updated", {
    id: remote.id,
    details_submitted: true,
    charges_enabled: false,
    payouts_enabled: true,
    capabilities: { transfers: "active" },
    requirements: { currently_due: [], past_due: [] },
  });
  assert.equal(res.status, 200, res.text);
  return account;
}
test("migration adds the funding ledger and an unconfigured provider is reported, not faked", async () => {
  const w = await t.work();
  const off = new FundingService(t.s, billing(), null);
  const detail = await off.detail(w.client.id, w.sub.id);
  assert.equal(detail.configured, false);
  await t.reject(
    () =>
      off.fund(w.client.id, w.sub.id, { amount: 10, request_key: randomUUID() }),
    503,
  );
});
test("funding is payer-only, capped at the amended price, and confirmed only by provider state", async () => {
  const w = await t.work(),
    stranger = await t.user();
  await t.reject(
    () =>
      funding().fund(w.worker.id, w.sub.id, {
        amount: 100,
        request_key: randomUUID(),
      }),
    403,
  );
  await t.reject(() => funding().detail(stranger.id, w.sub.id), 403);
  const key = randomUUID();
  const first = await funding().fund(
    w.client.id,
    w.sub.id,
    { amount: 600, request_key: key },
    "https://ignored.test",
  );
  assert.equal(first.status, "pending");
  assert.equal(first.request_key, undefined);
  const session = provider.state.sessions.get(first.checkout_session_id);
  assert.equal(session.options.transferGroup, `scope_${w.sub.id}`);
  assert.equal(
    session.options.successUrl,
    `https://app.test/console#billing/${w.sub.id}?funding=${first.id}`,
  );
  assert.equal(session.options.idempotencyKey, `funding-${first.id}`);
  // A retried request returns the same funding rather than opening a second checkout.
  const retry = await funding().fund(w.client.id, w.sub.id, {
    amount: 600,
    request_key: key,
  });
  assert.equal(retry.id, first.id);
  await t.reject(
    () =>
      funding().fund(w.client.id, w.sub.id, {
        amount: 10,
        request_key: randomUUID(),
      }),
    409,
  );
  // Returning from Checkout proves nothing: the scope stays unfunded until Stripe confirms.
  assert.equal((await funding().detail(w.worker.id, w.sub.id)).totals.funded, "0.00");
  const bad = await request(t.runtime.app)
    .post("/api/webhooks/stripe")
    .set("content-type", "application/json")
    .set("stripe-signature", "t=1,v1=forged")
    .send(JSON.stringify({ id: "evt_forged", type: "account.updated", data: {} }));
  assert.equal(bad.status, 400);
  pay(first.checkout_session_id, { paid: false });
  await deliver("checkout.session.completed", { id: first.checkout_session_id });
  assert.equal(
    (await t.database.models.ScopeFunding.findByPk(first.id)).status,
    "processing",
  );
  pay(first.checkout_session_id);
  const eventId = `evt_${randomUUID()}`;
  const ok = await deliver(
    "checkout.session.async_payment_succeeded",
    { id: first.checkout_session_id },
    { id: eventId },
  );
  assert.deepEqual(ok.body, { received: true });
  const dup = await deliver(
    "checkout.session.async_payment_succeeded",
    { id: first.checkout_session_id },
    { id: eventId },
  );
  assert.deepEqual(dup.body, { received: true, duplicate: true });
  // A late expiry for the same session cannot undo the confirmed payment.
  provider.state.sessions.get(first.checkout_session_id).status = "expired";
  await deliver("checkout.session.expired", { id: first.checkout_session_id });
  provider.state.sessions.get(first.checkout_session_id).status = "complete";
  const detail = await funding().detail(w.worker.id, w.sub.id);
  assert.equal(detail.totals.funded, "600.00");
  assert.equal(detail.totals.available, "600.00");
  assert.equal(detail.fundings[0].charge_id, `ch_${first.checkout_session_id}`);
  assert.equal(detail.fundings[0].checkout_url, null);
  const inbox = await t.database.models.Notification.findAll({
    where: { user_id: w.worker.id, title: "Scope funded" },
  });
  assert.equal(inbox.length, 1);
  await t.reject(
    () =>
      funding().fund(w.client.id, w.sub.id, {
        amount: 400.01,
        request_key: randomUUID(),
      }),
    409,
  );
  const expiring = await funding().fund(w.client.id, w.sub.id, {
    amount: 400,
    request_key: randomUUID(),
  });
  provider.state.sessions.get(expiring.checkout_session_id).status = "expired";
  assert.equal(
    (await funding().refreshFunding(w.client.id, expiring.id)).status,
    "expired",
  );
  assert.equal((await funding().detail(w.client.id, w.sub.id)).totals.pending, "0.00");
});
test("releases require approval, onboarding and funds, split across charges, and never double pay", async () => {
  const w = await t.work(true);
  await funded(w, 60);
  await funded(w, 40);
  const a = await approvedApplication(w);
  const key = randomUUID();
  await t.reject(
    () =>
      funding().release(w.client.id, w.sub.id, {
        application_id: a.id,
        amount: 95,
        request_key: key,
      }),
    409,
  );
  const account = await onboarded(w);
  await t.reject(
    () =>
      funding().release(w.worker.id, w.sub.id, {
        application_id: a.id,
        amount: 95,
        request_key: randomUUID(),
      }),
    403,
  );
  await t.reject(
    () =>
      funding().release(w.client.id, w.sub.id, {
        application_id: a.id,
        amount: 95.01,
        request_key: randomUUID(),
      }),
    409,
  );
  const results = await Promise.allSettled([
    funding().release(w.client.id, w.sub.id, {
      application_id: a.id,
      amount: 95,
      request_key: key,
    }),
    funding().release(w.client.id, w.sub.id, {
      application_id: a.id,
      amount: 95,
      request_key: randomUUID(),
    }),
  ]);
  assert.equal(
    results.filter((r) => r.status === "fulfilled").length,
    1,
    results.map((r) => r.reason?.message).join(" | "),
  );
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  const rows = results.find((r) => r.status === "fulfilled").value;
  assert.deepEqual(
    rows.map((r) => [r.amount, r.status]),
    [
      ["60.00", "paid"],
      ["35.00", "paid"],
    ],
  );
  const transfers = provider.state.transfers.slice(-2);
  assert.deepEqual(
    transfers.map((x) => x.idempotencyKey),
    rows.map((r) => `release-${r.id}`),
  );
  assert.ok(transfers.every((x) => x.sourceTransaction.startsWith("ch_")));
  assert.equal(
    transfers[0].destination,
    (await t.database.models.PaymentAccount.findByPk(account.id))
      .provider_account_id,
  );
  const again = await funding().release(w.client.id, w.sub.id, {
    application_id: a.id,
    amount: 95,
    request_key: key,
  });
  assert.deepEqual(
    again.map((r) => r.id),
    rows.map((r) => r.id),
  );
  assert.equal(provider.state.transfers.length, 2);
  const b = await billing().detail(w.client.id, w.sub.id);
  assert.equal(b.totals.released, "95.00");
  assert.equal(b.totals.outstanding, "0.00");
  // External payment annotations cannot pay an application already settled by a release.
  await t.reject(
    () =>
      billing().recordPayment(w.client.id, a.id, {
        amount: 1,
        paid_on: "2026-02-01",
        reference: "CHK-1",
        request_key: randomUUID(),
      }),
    409,
  );
  const f = await funding().detail(w.worker.id, w.sub.id);
  assert.equal(f.totals.released, "95.00");
  assert.equal(f.totals.available, "5.00");
  assert.equal(f.contractor_account.id, account.id);
  assert.equal(
    (await funding().detail(w.client.id, w.sub.id)).contractor_account.id,
    null,
  );
});
test("releases need the signed conditional waiver, and a cleared release requests the unconditional waiver", async () => {
  const w = await t.work();
  await funded(w, 200);
  const a = await approvedApplication(w, 1, 100, false);
  await onboarded(w);
  const attempt = () =>
    funding().release(w.client.id, w.sub.id, {
      application_id: a.id,
      amount: 95,
      request_key: randomUUID(),
    });
  await t.reject(attempt, 409);
  await signConditional(w, a);
  await attempt();
  const waivers = await billing().waivers.list(w.client.id, w.sub.id);
  const unconditional = waivers.find((x) => !x.conditional);
  assert.equal(unconditional.kind, "unconditional_progress");
  assert.equal(unconditional.status, "requested");
  assert.equal(unconditional.amount, "95.00");
});
test("ambiguous transfer failures stay reserved for retry; definitive failures free the funds", async () => {
  const w = await t.work();
  await funded(w, 200);
  const a = await approvedApplication(w);
  await onboarded(w);
  const ambiguous = Object.assign(new Error("Network timeout"), {
    status: 502,
    definitive: false,
  });
  provider.state.transferErrors.push(ambiguous);
  await t.reject(
    () =>
      funding().release(w.client.id, w.sub.id, {
        application_id: a.id,
        amount: 50,
        request_key: randomUUID(),
      }),
    502,
  );
  const [pending] = await t.database.models.ScopeRelease.findAll({
    where: { subdivision_id: w.sub.id },
  });
  assert.equal(pending.status, "processing");
  assert.equal((await funding().detail(w.client.id, w.sub.id)).totals.available, "150.00");
  const retried = await funding().retryRelease(w.client.id, pending.id);
  assert.equal(retried.status, "paid");
  provider.state.transferErrors.push(
    Object.assign(new Error("Insufficient funds"), {
      status: 502,
      definitive: true,
    }),
  );
  const [failed] = await funding().release(w.client.id, w.sub.id, {
    application_id: a.id,
    amount: 45,
    request_key: randomUUID(),
  });
  assert.equal(failed.status, "failed");
  const detail = await funding().detail(w.client.id, w.sub.id);
  assert.equal(detail.totals.available, "150.00");
  assert.equal(detail.totals.released, "50.00");
});
test("refunds use only unreleased funds; disputes pause releases; reversals restore availability", async () => {
  const w = await t.work();
  const f = await funded(w, 300);
  const a = await approvedApplication(w);
  await onboarded(w);
  const [released] = await funding().release(w.client.id, w.sub.id, {
    application_id: a.id,
    amount: 95,
    request_key: randomUUID(),
  });
  await t.reject(
    () =>
      funding().refund(w.client.id, f.id, {
        amount: 205.01,
        reason: "Too much",
        request_key: randomUUID(),
      }),
    409,
  );
  await t.reject(
    () =>
      funding().refund(w.worker.id, f.id, {
        amount: 5,
        reason: "No",
        request_key: randomUUID(),
      }),
    403,
  );
  const refund = await funding().refund(w.client.id, f.id, {
    amount: 100,
    reason: "Scope reduced",
    request_key: randomUUID(),
  });
  assert.equal(refund.status, "processing");
  assert.equal((await funding().detail(w.client.id, w.sub.id)).totals.available, "105.00");
  await deliver("refund.updated", {
    id: refund.provider_refund_id,
    status: "succeeded",
  });
  let detail = await funding().detail(w.client.id, w.sub.id);
  assert.equal(detail.totals.refunded, "100.00");
  assert.equal(detail.totals.available, "105.00");
  await deliver("charge.dispute.created", {
    id: "dp_1",
    charge: f.charge_id || `ch_${f.checkout_session_id}`,
    status: "needs_response",
  });
  detail = await funding().detail(w.client.id, w.sub.id);
  assert.equal(detail.totals.available, "0.00");
  assert.equal(detail.totals.disputed, "300.00");
  await deliver("charge.dispute.closed", {
    id: "dp_1",
    charge: `ch_${f.checkout_session_id}`,
    status: "won",
  });
  await deliver("transfer.reversed", {
    id: released.provider_transfer_id,
    amount_reversed: 9500,
  });
  detail = await funding().detail(w.client.id, w.sub.id);
  assert.equal(detail.releases[0].status, "reversed");
  assert.equal(detail.totals.available, "200.00");
  assert.equal((await billing().detail(w.client.id, w.sub.id)).totals.outstanding, "95.00");
});
test("payout accounts are owner-managed, payouts check the connected balance and follow provider events", async () => {
  const w = await t.work();
  await funded(w, 100);
  const a = await approvedApplication(w);
  const account = await onboarded(w);
  await funding().release(w.client.id, w.sub.id, {
    application_id: a.id,
    amount: 95,
    request_key: randomUUID(),
  });
  const row = await t.database.models.PaymentAccount.findByPk(account.id);
  provider.state.balances[row.provider_account_id] = {
    available: "95.00",
    pending: "0.00",
  };
  await t.reject(
    () =>
      funding().payout(w.client.id, account.id, {
        amount: 10,
        request_key: randomUUID(),
      }),
    403,
  );
  await t.reject(
    () =>
      funding().payout(w.worker.id, account.id, {
        amount: 95.01,
        request_key: randomUUID(),
      }),
    409,
  );
  let [listed] = await funding().accounts(w.worker.id);
  assert.ok(listed.oldest_unpaid_release_at);
  assert.equal(listed.balance.available, "95.00");
  assert.equal(listed.provider_account_id, undefined);
  const payout = await funding().payout(w.worker.id, account.id, {
    amount: 95,
    request_key: randomUUID(),
  });
  assert.equal(payout.status, "pending");
  assert.equal(provider.state.payouts.at(-1).account, row.provider_account_id);
  await deliver(
    "payout.paid",
    { id: payout.provider_payout_id, status: "paid" },
    { account: row.provider_account_id },
  );
  [listed] = await funding().accounts(w.worker.id);
  assert.equal(listed.payouts[0].status, "paid");
  assert.equal(listed.oldest_unpaid_release_at, null);
});
test("funding HTTP routes require CSRF and authentication", async () => {
  const agent = request.agent(t.runtime.app);
  const csrf = (await agent.get("/api/auth/csrf")).body.csrf_token;
  const res = await agent
    .post("/api/subdivisions/1/fundings")
    .set("X-CSRF-Token", csrf)
    .send({ amount: 10, request_key: randomUUID() });
  assert.equal(res.status, 401);
  const noToken = await agent.post("/api/payment-accounts").send({});
  assert.equal(noToken.status, 403);
});
