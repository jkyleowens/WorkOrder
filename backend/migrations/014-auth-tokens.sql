-- Opaque bearer tokens for native clients (iOS/Android). Web keeps cookie
-- sessions; the "sessions" table stays owned by connect-pg-simple.
-- Only SHA-256 hashes are stored, never the raw token material.
CREATE TABLE auth_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  access_hash TEXT NOT NULL UNIQUE,
  context JSONB NOT NULL DEFAULT '{"mode":"personal"}',
  device_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  -- expires_at bounds the refresh token; the access token dies sooner.
  access_expires_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by INTEGER REFERENCES auth_tokens(id)
);
CREATE INDEX auth_tokens_user_id_idx ON auth_tokens (user_id);
CREATE INDEX auth_tokens_replaced_by_idx ON auth_tokens (replaced_by);
