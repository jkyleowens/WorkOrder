-- Provider-confirmed funding for awarded scopes (Stripe Connect, separate charges and transfers).
-- These rows are separate from billing_payments, which only annotate payments made elsewhere.
CREATE TABLE payment_accounts (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id),
  owner_org_id INTEGER REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_account_id VARCHAR(255) NOT NULL UNIQUE,
  country CHAR(2) NOT NULL,
  default_currency CHAR(3) NOT NULL DEFAULT 'usd',
  details_submitted BOOLEAN NOT NULL DEFAULT false,
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  transfers_active BOOLEAN NOT NULL DEFAULT false,
  requirements JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(requirements) = 'array'),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_user_id, owner_org_id) = 1)
);
CREATE UNIQUE INDEX payment_accounts_user ON payment_accounts(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX payment_accounts_org ON payment_accounts(owner_org_id) WHERE owner_org_id IS NOT NULL;

CREATE TABLE scope_fundings (
  id SERIAL PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  funded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','failed','expired')),
  amount_received NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_received >= 0 AND amount_received <= amount),
  checkout_session_id VARCHAR(255) UNIQUE,
  checkout_url TEXT,
  payment_intent_id VARCHAR(255),
  charge_id VARCHAR(255),
  provider_dispute_status TEXT,
  request_key UUID NOT NULL UNIQUE,
  failure_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scope_fundings_scope ON scope_fundings(subdivision_id, id);

CREATE TABLE scope_refunds (
  id SERIAL PRIMARY KEY,
  funding_id INTEGER NOT NULL REFERENCES scope_fundings(id),
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','succeeded','failed')),
  provider_refund_id VARCHAR(255) UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  requested_by_user_id INTEGER REFERENCES users(id),
  request_key UUID NOT NULL UNIQUE,
  failure_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scope_refunds_scope ON scope_refunds(subdivision_id, id);

CREATE TABLE scope_releases (
  id SERIAL PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  application_id INTEGER NOT NULL REFERENCES pay_applications(id),
  funding_id INTEGER NOT NULL REFERENCES scope_fundings(id),
  payment_account_id INTEGER NOT NULL REFERENCES payment_accounts(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','paid','failed','reversed')),
  provider_transfer_id VARCHAR(255) UNIQUE,
  amount_reversed NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_reversed >= 0 AND amount_reversed <= amount),
  approved_by_user_id INTEGER NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  failure_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_key, funding_id)
);
CREATE INDEX scope_releases_scope ON scope_releases(subdivision_id, id);

CREATE TABLE provider_payouts (
  id SERIAL PRIMARY KEY,
  payment_account_id INTEGER NOT NULL REFERENCES payment_accounts(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','pending','in_transit','paid','failed','canceled')),
  provider_payout_id VARCHAR(255) UNIQUE,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL UNIQUE,
  failure_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provider_payouts_account ON provider_payouts(payment_account_id, id);

-- Every verified provider event is stored once; replays are acknowledged without reprocessing.
CREATE TABLE provider_events (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(255) NOT NULL,
  account VARCHAR(255),
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
