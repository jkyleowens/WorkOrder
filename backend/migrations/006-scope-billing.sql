-- Billing records are denominated in USD. They do not hold or move money.
CREATE TABLE scope_change_orders (
  id SERIAL PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  schedule_days INTEGER NOT NULL DEFAULT 0 CHECK (schedule_days BETWEEN -3660 AND 3660),
  proposed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  proposed_side TEXT NOT NULL CHECK (proposed_side IN ('payer','contractor')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected','withdrawn')),
  decided_by_user_id INTEGER REFERENCES users(id),
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX scope_changes_scope ON scope_change_orders(subdivision_id, id);
CREATE TABLE pay_applications (
  id SERIAL PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL CHECK (period_to >= period_from),
  snapshot JSONB NOT NULL,
  amount_due NUMERIC(14,2) NOT NULL CHECK (amount_due > 0),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','withdrawn')),
  submitted_by_user_id INTEGER NOT NULL REFERENCES users(id),
  decided_by_user_id INTEGER REFERENCES users(id),
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX pay_applications_scope ON pay_applications(subdivision_id, id);
CREATE UNIQUE INDEX one_submitted_application_per_scope ON pay_applications(subdivision_id) WHERE status='submitted';
CREATE TABLE billing_payments (
  id SERIAL PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  application_id INTEGER NOT NULL REFERENCES pay_applications(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_on DATE NOT NULL,
  reference VARCHAR(200) NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  recorded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  reverses_payment_id INTEGER UNIQUE REFERENCES billing_payments(id),
  request_key UUID UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX billing_payments_scope ON billing_payments(subdivision_id, id);
CREATE UNIQUE INDEX billing_payment_reference ON billing_payments(subdivision_id, lower(reference)) WHERE reverses_payment_id IS NULL;
CREATE FUNCTION protect_billing_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Payment records are append-only; record a reversal instead'; END;
$$;
CREATE TRIGGER billing_payments_immutable BEFORE UPDATE OR DELETE ON billing_payments FOR EACH ROW EXECUTE FUNCTION protect_billing_payment();
