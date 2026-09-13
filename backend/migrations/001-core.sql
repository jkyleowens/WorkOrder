CREATE TABLE users (
 id SERIAL PRIMARY KEY, full_name VARCHAR(120) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE CHECK (email = lower(email)),
 password_hash TEXT NOT NULL, skills JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(skills) = 'array'),
 hourly_rate NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(hourly_rate >= 0),
 availability_status TEXT NOT NULL DEFAULT 'available' CHECK(availability_status IN ('available','busy','unavailable'))
);
CREATE TABLE organizations (id SERIAL PRIMARY KEY, name VARCHAR(160) NOT NULL, created_by_user_id INTEGER NOT NULL REFERENCES users(id), trade_focus VARCHAR(160) NOT NULL DEFAULT '');
CREATE TABLE organization_members (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), org_id INTEGER NOT NULL REFERENCES organizations(id), internal_role TEXT NOT NULL CHECK(internal_role IN ('owner','manager','member')), joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id,org_id));
CREATE TABLE job_postings (id SERIAL PRIMARY KEY, posted_by_user_id INTEGER NOT NULL REFERENCES users(id), posted_by_org_id INTEGER REFERENCES organizations(id), title VARCHAR(200) NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')));
CREATE TABLE job_applications (id SERIAL PRIMARY KEY, job_posting_id INTEGER NOT NULL REFERENCES job_postings(id), applicant_user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','offered','accepted','rejected','withdrawn')), submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(job_posting_id,applicant_user_id));
CREATE TABLE projects (id SERIAL PRIMARY KEY, client_user_id INTEGER NOT NULL REFERENCES users(id), title VARCHAR(200) NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','active','completed','cancelled')), posted_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE project_subdivisions (id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), awarded_user_id INTEGER REFERENCES users(id), awarded_org_id INTEGER REFERENCES organizations(id), scope TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0), status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','awarded','active','completed','cancelled')), UNIQUE(project_id,sequence), CHECK(num_nonnulls(awarded_user_id,awarded_org_id) <= 1), CHECK((status IN ('awarded','active','completed')) = (num_nonnulls(awarded_user_id,awarded_org_id) = 1)));
CREATE TABLE bids (id SERIAL PRIMARY KEY, subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id), bidding_user_id INTEGER REFERENCES users(id), bidding_org_id INTEGER REFERENCES organizations(id), amount NUMERIC(12,2) NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','withdrawn')), CHECK(num_nonnulls(bidding_user_id,bidding_org_id) = 1));
CREATE UNIQUE INDEX bids_user_unique ON bids(subdivision_id,bidding_user_id) WHERE status IN ('pending','accepted');
CREATE UNIQUE INDEX bids_org_unique ON bids(subdivision_id,bidding_org_id) WHERE status IN ('pending','accepted');
CREATE UNIQUE INDEX bids_one_award ON bids(subdivision_id) WHERE status = 'accepted';
CREATE TABLE inventory_items (id SERIAL PRIMARY KEY, owner_user_id INTEGER REFERENCES users(id), owner_org_id INTEGER REFERENCES organizations(id), item_name VARCHAR(200) NOT NULL, stock INTEGER NOT NULL CHECK(stock >= 0), unit VARCHAR(40) NOT NULL DEFAULT 'each', unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(unit_cost >= 0), CHECK(num_nonnulls(owner_user_id,owner_org_id) = 1));
CREATE TABLE project_inventory (id SERIAL PRIMARY KEY, subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id), item_id INTEGER NOT NULL REFERENCES inventory_items(id), qty INTEGER NOT NULL CHECK(qty > 0), unit_cost NUMERIC(12,2) NOT NULL CHECK(unit_cost >= 0), consumed_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE inventory_movements (id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES inventory_items(id), actor_user_id INTEGER NOT NULL REFERENCES users(id), quantity INTEGER NOT NULL CHECK(quantity <> 0), reason VARCHAR(500) NOT NULL, project_inventory_id INTEGER UNIQUE REFERENCES project_inventory(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE timesheets (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id), org_id INTEGER REFERENCES organizations(id), hours NUMERIC(4,2) NOT NULL CHECK(hours > 0 AND hours <= 24), date DATE NOT NULL, note VARCHAR(2000) NOT NULL DEFAULT '', hourly_rate NUMERIC(12,2) NOT NULL CHECK(hourly_rate >= 0));
CREATE INDEX timesheets_user_date ON timesheets(user_id,date);
CREATE INDEX timesheets_org_date ON timesheets(org_id,date);
CREATE INDEX timesheets_subdivision ON timesheets(subdivision_id);
CREATE INDEX subdivisions_project ON project_subdivisions(project_id);
CREATE TABLE sessions (sid VARCHAR(255) PRIMARY KEY, expires TIMESTAMPTZ NOT NULL, data JSONB NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires);
