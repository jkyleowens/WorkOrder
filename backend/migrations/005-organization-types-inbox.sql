ALTER TABLE organizations ADD COLUMN organization_types jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE notifications (
 id serial PRIMARY KEY,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title varchar(200) NOT NULL,
 body text NOT NULL,
 route varchar(200) NOT NULL,
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_recent ON notifications(user_id, id DESC);
CREATE INDEX notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
