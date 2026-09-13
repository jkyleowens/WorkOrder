// Stripe Connect adapter. The funding service talks only to this interface so tests can
// substitute a deterministic provider and no Stripe types leak into domain code.
const cents = (amount) => Math.round(Number(amount) * 100);
const dollars = (value) => (Number(value || 0) / 100).toFixed(2);
const id = (value) => (value && typeof value === "object" ? value.id : value);
function normalizeAccount(a) {
  return {
    id: a.id,
    details_submitted: !!a.details_submitted,
    charges_enabled: !!a.charges_enabled,
    payouts_enabled: !!a.payouts_enabled,
    transfers_active: a.capabilities?.transfers === "active",
    requirements: [
      ...new Set([
        ...(a.requirements?.currently_due || []),
        ...(a.requirements?.past_due || []),
      ]),
    ].slice(0, 50),
    disabled_reason: a.requirements?.disabled_reason || null,
  };
}
function normalizeSession(s) {
  const intent = s.payment_intent && typeof s.payment_intent === "object"
    ? s.payment_intent
    : null;
  return {
    id: s.id,
    url: s.url || null,
    status: s.status,
    payment_status: s.payment_status,
    amount_total: dollars(s.amount_total),
    payment_intent_id: id(s.payment_intent) || null,
    payment_intent_status: intent?.status || null,
    charge_id: id(intent?.latest_charge) || null,
    last_error: intent?.last_payment_error?.message || "",
    metadata: s.metadata || {},
  };
}
// Only errors where Stripe rejected the request are definitive. Network and API
// failures may have succeeded remotely and must be retried with the same idempotency key.
const definitive = (error) =>
  ["StripeInvalidRequestError", "StripeCardError", "StripePermissionError"].includes(
    error?.type,
  );
function providerError(error) {
  const wrapped = new Error(error?.message || "Payment provider request failed");
  wrapped.status = 502;
  wrapped.definitive = definitive(error);
  return wrapped;
}
function createStripeProvider({
  secretKey,
  webhookSecret,
  live = false,
  country = "US",
  logger = console,
  client,
}) {
  if (!secretKey) return null;
  if (secretKey.startsWith("sk_live_") && !live) {
    logger.warn(
      "Stripe live key supplied without PAYMENTS_LIVE=true; online funding is disabled",
    );
    return null;
  }
  const Stripe = require("stripe");
  const stripe = client || new Stripe(secretKey, { maxNetworkRetries: 2 });
  const call = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      throw providerError(error);
    }
  };
  return {
    name: "stripe",
    live: secretKey.startsWith("sk_live_"),
    country,
    async createAccount({ email, metadata }) {
      return call(async () =>
        normalizeAccount(
          await stripe.accounts.create({
            country,
            email,
            controller: {
              fees: { payer: "application" },
              losses: { payments: "application" },
              requirement_collection: "stripe",
              stripe_dashboard: { type: "express" },
            },
            capabilities: { transfers: { requested: true } },
            settings: { payouts: { schedule: { interval: "manual" } } },
            metadata,
          }),
        ),
      );
    },
    async accountLink(account, refreshUrl, returnUrl) {
      return call(
        async () =>
          (
            await stripe.accountLinks.create({
              account,
              refresh_url: refreshUrl,
              return_url: returnUrl,
              type: "account_onboarding",
            })
          ).url,
      );
    },
    async retrieveAccount(account) {
      return call(async () =>
        normalizeAccount(await stripe.accounts.retrieve(account)),
      );
    },
    async createCheckout({
      amount,
      description,
      transferGroup,
      successUrl,
      cancelUrl,
      metadata,
      idempotencyKey,
      email,
    }) {
      return call(async () =>
        normalizeSession(
          await stripe.checkout.sessions.create(
            {
              mode: "payment",
              line_items: [
                {
                  quantity: 1,
                  price_data: {
                    currency: "usd",
                    unit_amount: cents(amount),
                    product_data: { name: description.slice(0, 250) },
                  },
                },
              ],
              payment_intent_data: { transfer_group: transferGroup, metadata },
              customer_email: email,
              metadata,
              success_url: successUrl,
              cancel_url: cancelUrl,
            },
            { idempotencyKey },
          ),
        ),
      );
    },
    async retrieveCheckout(session) {
      return call(async () =>
        normalizeSession(
          await stripe.checkout.sessions.retrieve(session, {
            expand: ["payment_intent"],
          }),
        ),
      );
    },
    async createTransfer({
      amount,
      destination,
      sourceTransaction,
      transferGroup,
      metadata,
      idempotencyKey,
    }) {
      return call(async () => {
        const t = await stripe.transfers.create(
          {
            amount: cents(amount),
            currency: "usd",
            destination,
            source_transaction: sourceTransaction,
            transfer_group: transferGroup,
            metadata,
          },
          { idempotencyKey },
        );
        return { id: t.id, amount_reversed: dollars(t.amount_reversed) };
      });
    },
    async createRefund({ paymentIntent, amount, metadata, idempotencyKey }) {
      return call(async () => {
        const r = await stripe.refunds.create(
          { payment_intent: paymentIntent, amount: cents(amount), metadata },
          { idempotencyKey },
        );
        return { id: r.id, status: r.status, failure_reason: r.failure_reason };
      });
    },
    async balance(account) {
      return call(async () => {
        const b = await stripe.balance.retrieve({}, { stripeAccount: account });
        const usd = (rows) =>
          dollars(
            rows
              .filter((r) => r.currency === "usd")
              .reduce((n, r) => n + r.amount, 0),
          );
        return { available: usd(b.available), pending: usd(b.pending) };
      });
    },
    async createPayout({ account, amount, metadata, idempotencyKey }) {
      return call(async () => {
        const p = await stripe.payouts.create(
          { amount: cents(amount), currency: "usd", metadata },
          { stripeAccount: account, idempotencyKey },
        );
        return { id: p.id, status: p.status, failure_message: p.failure_message };
      });
    },
    constructEvent(rawBody, signature) {
      if (!webhookSecret) {
        const error = new Error("Webhook signing secret is not configured");
        error.status = 503;
        throw error;
      }
      try {
        return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch {
        const error = new Error("Invalid webhook signature");
        error.status = 400;
        throw error;
      }
    },
  };
}
module.exports = {
  createStripeProvider,
  normalizeAccount,
  normalizeSession,
  providerError,
};
