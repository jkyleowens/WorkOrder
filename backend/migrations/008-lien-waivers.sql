-- Lien waivers generated from pay applications and the payments that settle them.
CREATE TABLE lien_waivers (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
  application_id INTEGER NOT NULL REFERENCES pay_applications(id),
  conditional BOOLEAN NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conditional_progress','unconditional_progress','conditional_final','unconditional_final')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  through_date DATE NOT NULL,
  claimant_user_id INTEGER REFERENCES users(id),
  claimant_org_id INTEGER REFERENCES organizations(id),
  payer_user_id INTEGER REFERENCES users(id),
  payer_org_id INTEGER REFERENCES organizations(id),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','signed','void')),
  snapshot JSONB NOT NULL,
  exceptions TEXT NOT NULL DEFAULT '',
  signed_by_user_id INTEGER REFERENCES users(id),
  signer_name VARCHAR(120),
  signer_title VARCHAR(120),
  signed_at TIMESTAMPTZ,
  content_hash CHAR(64),
  void_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(claimant_user_id, claimant_org_id) = 1),
  CHECK (num_nonnulls(payer_user_id, payer_org_id) = 1),
  CHECK ((status = 'signed') = (signed_at IS NOT NULL AND content_hash IS NOT NULL))
);
CREATE UNIQUE INDEX lien_waivers_active ON lien_waivers(application_id, conditional) WHERE status <> 'void';
CREATE INDEX lien_waivers_project ON lien_waivers(project_id, id);
CREATE INDEX lien_waivers_scope ON lien_waivers(subdivision_id, id);
CREATE FUNCTION protect_signed_waiver() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'signed' THEN
    RAISE EXCEPTION 'Signed lien waivers are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lien_waivers_immutable BEFORE UPDATE OR DELETE ON lien_waivers FOR EACH ROW EXECUTE FUNCTION protect_signed_waiver();
