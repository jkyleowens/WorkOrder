ALTER TABLE users ADD COLUMN resume_file_id INTEGER REFERENCES files(id);
