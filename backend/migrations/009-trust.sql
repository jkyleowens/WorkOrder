-- Release Two: stored files, credentials, reviews and disputes.
ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user','admin'));

CREATE TABLE files (
  id SERIAL PRIMARY KEY,
  uploaded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 4194304),
  sha256 CHAR(64) NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX files_uploader ON files(uploaded_by_user_id, id);

CREATE TABLE credentials (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id),
  owner_org_id INTEGER REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('trade_license','general_liability','workers_compensation','certification')),
  title VARCHAR(160) NOT NULL,
  issuer VARCHAR(200) NOT NULL,
  number VARCHAR(120) NOT NULL,
  jurisdiction VARCHAR(120) NOT NULL DEFAULT '',
  coverage_amount NUMERIC(14,2) CHECK (coverage_amount IS NULL OR coverage_amount > 0),
  effective_on DATE,
  expires_on DATE NOT NULL,
  file_id INTEGER REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','withdrawn')),
  checked TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_user_id, owner_org_id) = 1),
  CHECK (effective_on IS NULL OR effective_on <= expires_on),
  CHECK ((status IN ('verified','rejected')) = (reviewed_at IS NOT NULL))
);
CREATE INDEX credentials_user ON credentials(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX credentials_org ON credentials(owner_org_id) WHERE owner_org_id IS NOT NULL;
CREATE INDEX credentials_queue ON credentials(status, id);

ALTER TABLE project_subdivisions ADD COLUMN required_credentials JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(required_credentials) = 'array');

CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  subdivision_id INTEGER NOT NULL UNIQUE REFERENCES project_subdivisions(id),
  reviewer_user_id INTEGER NOT NULL REFERENCES users(id),
  reviewer_org_id INTEGER REFERENCES organizations(id),
  reviewee_user_id INTEGER REFERENCES users(id),
  reviewee_org_id INTEGER REFERENCES organizations(id),
  schedule SMALLINT NOT NULL CHECK (schedule BETWEEN 1 AND 5),
  quality SMALLINT NOT NULL CHECK (quality BETWEEN 1 AND 5),
  communication SMALLINT NOT NULL CHECK (communication BETWEEN 1 AND 5),
  closeout SMALLINT NOT NULL CHECK (closeout BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  contract_value NUMERIC(14,2) NOT NULL CHECK (contract_value >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(reviewee_user_id, reviewee_org_id) = 1)
);
CREATE INDEX reviews_user ON reviews(reviewee_user_id) WHERE reviewee_user_id IS NOT NULL;
CREATE INDEX reviews_org ON reviews(reviewee_org_id) WHERE reviewee_org_id IS NOT NULL;

CREATE TABLE disputes (
  id SERIAL PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  opened_by_user_id INTEGER NOT NULL REFERENCES users(id),
  opened_side TEXT NOT NULL CHECK (opened_side IN ('payer','contractor')),
  reason TEXT NOT NULL,
  amount_held NUMERIC(14,2) NOT NULL CHECK (amount_held >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','withdrawn')),
  proposal_contractor NUMERIC(14,2) CHECK (proposal_contractor >= 0),
  proposal_payer NUMERIC(14,2) CHECK (proposal_payer >= 0),
  proposal_note TEXT NOT NULL DEFAULT '',
  proposed_side TEXT CHECK (proposed_side IN ('payer','contractor')),
  proposed_by_user_id INTEGER REFERENCES users(id),
  proposed_at TIMESTAMPTZ,
  resolved_contractor NUMERIC(14,2) CHECK (resolved_contractor >= 0),
  resolved_payer NUMERIC(14,2) CHECK (resolved_payer >= 0),
  resolution_method TEXT CHECK (resolution_method IN ('agreement','mediation')),
  resolution_note TEXT NOT NULL DEFAULT '',
  resolved_by_user_id INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  packet JSONB,
  packet_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND packet IS NOT NULL)),
  CHECK (status <> 'resolved' OR resolved_contractor + resolved_payer = amount_held)
);
CREATE UNIQUE INDEX disputes_one_open ON disputes(subdivision_id) WHERE status = 'open';

CREATE TABLE dispute_events (
  id SERIAL PRIMARY KEY,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  side TEXT NOT NULL CHECK (side IN ('payer','contractor','mediator')),
  kind TEXT NOT NULL CHECK (kind IN ('opened','comment','evidence','proposal','accepted','rejected','withdrawn','resolved')),
  body TEXT NOT NULL DEFAULT '',
  file_id INTEGER REFERENCES files(id),
  amount_contractor NUMERIC(14,2),
  amount_payer NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dispute_events_dispute ON dispute_events(dispute_id, id);

CREATE FUNCTION protect_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER reviews_immutable BEFORE UPDATE OR DELETE ON reviews FOR EACH ROW EXECUTE FUNCTION protect_append_only();
CREATE TRIGGER dispute_events_immutable BEFORE UPDATE OR DELETE ON dispute_events FOR EACH ROW EXECUTE FUNCTION protect_append_only();

-- Dispute settlements move held funds without a pay application.
ALTER TABLE scope_releases ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE scope_releases ADD COLUMN dispute_id INTEGER REFERENCES disputes(id);
ALTER TABLE scope_releases ADD CONSTRAINT scope_release_source CHECK (num_nonnulls(application_id, dispute_id) = 1);
ALTER TABLE scope_refunds ADD COLUMN dispute_id INTEGER REFERENCES disputes(id);
