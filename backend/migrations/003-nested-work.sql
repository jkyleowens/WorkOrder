ALTER TABLE project_subdivisions ADD COLUMN parent_subdivision_id INTEGER REFERENCES project_subdivisions(id);
CREATE INDEX subdivision_parent_idx ON project_subdivisions(parent_subdivision_id);
