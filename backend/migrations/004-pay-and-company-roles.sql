CREATE TABLE organization_roles (
 id SERIAL PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES organizations(id),
 name VARCHAR(160) NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 skills JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(skills) = 'array'),
 hourly_rate NUMERIC(12,2) NOT NULL CHECK(hourly_rate >= 0),
 UNIQUE(id,org_id), UNIQUE(org_id,name)
);
ALTER TABLE organization_members
 ADD COLUMN company_role_id INTEGER,
 ADD COLUMN hourly_rate NUMERIC(12,2) CHECK(hourly_rate >= 0),
 ADD FOREIGN KEY(company_role_id,org_id) REFERENCES organization_roles(id,org_id);
ALTER TABLE job_postings
 ADD COLUMN company_role_id INTEGER,
 ADD COLUMN hourly_rate NUMERIC(12,2) CHECK(hourly_rate >= 0),
 ADD FOREIGN KEY(company_role_id,posted_by_org_id) REFERENCES organization_roles(id,org_id),
 ADD CHECK(company_role_id IS NULL OR posted_by_org_id IS NOT NULL);
ALTER TABLE job_applications
 ADD COLUMN desired_rate NUMERIC(12,2) CHECK(desired_rate >= 0),
 ADD COLUMN offered_rate NUMERIC(12,2) CHECK(offered_rate >= 0),
 ADD COLUMN revision INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN negotiation JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(negotiation) = 'array');
