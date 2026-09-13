ALTER TABLE project_subdivisions ADD COLUMN planned_start DATE;
ALTER TABLE project_subdivisions ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 1 CHECK (duration_days BETWEEN 1 AND 3650);
ALTER TABLE project_subdivisions ADD COLUMN predecessor_id INTEGER REFERENCES project_subdivisions(id);
ALTER TABLE project_subdivisions ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_subdivisions ADD CONSTRAINT predecessor_not_self CHECK (predecessor_id IS DISTINCT FROM id);
CREATE TABLE field_time_batches (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), request_key UUID NOT NULL,
 payload_hash TEXT NOT NULL, timesheet_ids JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id,request_key)
);
CREATE TABLE daily_reports (
 id SERIAL PRIMARY KEY, subdivision_id INTEGER NOT NULL REFERENCES project_subdivisions(id),
 author_user_id INTEGER NOT NULL REFERENCES users(id), report_date DATE NOT NULL,
 progress TEXT NOT NULL, headcount INTEGER NOT NULL CHECK(headcount BETWEEN 0 AND 10000),
 weather TEXT NOT NULL DEFAULT '', deliveries TEXT NOT NULL DEFAULT '', delays TEXT NOT NULL DEFAULT '',
 file_ids JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX daily_reports_scope ON daily_reports(subdivision_id,report_date);
CREATE TRIGGER daily_reports_immutable BEFORE UPDATE OR DELETE ON daily_reports FOR EACH ROW EXECUTE FUNCTION protect_append_only();
CREATE TABLE field_documents (
 id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), subdivision_id INTEGER REFERENCES project_subdivisions(id),
 previous_id INTEGER UNIQUE REFERENCES field_documents(id), version INTEGER NOT NULL DEFAULT 1,
 kind TEXT NOT NULL CHECK(kind IN ('agreement','scope','certificate','waiver','other')),
 title TEXT NOT NULL, body TEXT NOT NULL, file_id INTEGER REFERENCES files(id),
 parties JSONB NOT NULL, content_hash TEXT NOT NULL, created_by_user_id INTEGER NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX field_agreement_scope ON field_documents(subdivision_id) WHERE kind='agreement' AND previous_id IS NULL;
CREATE INDEX field_documents_project ON field_documents(project_id,subdivision_id);
CREATE TRIGGER field_documents_immutable BEFORE UPDATE OR DELETE ON field_documents FOR EACH ROW EXECUTE FUNCTION protect_append_only();
CREATE TABLE field_document_events (
 id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES field_documents(id), user_id INTEGER NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('viewed','signed')), party TEXT CHECK(party IN ('payer','contractor','client')),
 signer_name TEXT, content_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX field_document_signature ON field_document_events(document_id,party) WHERE kind='signed';
CREATE TRIGGER field_document_events_immutable BEFORE UPDATE OR DELETE ON field_document_events FOR EACH ROW EXECUTE FUNCTION protect_append_only();
