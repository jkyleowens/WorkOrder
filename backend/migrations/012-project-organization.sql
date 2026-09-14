ALTER TABLE projects ADD COLUMN client_org_id INTEGER REFERENCES organizations(id);
CREATE INDEX projects_client_org_idx ON projects(client_org_id) WHERE client_org_id IS NOT NULL;
