CREATE TABLE app.users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE app.sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  CONSTRAINT fk_session_user
    FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE
);

CREATE TABLE app.audit_events (
  id UUID PRIMARY KEY,
  actor_user_id UUID,
  event_type VARCHAR(80) NOT NULL
);

ALTER TABLE app.audit_events
  ADD CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id)
  REFERENCES app.users(id) ON DELETE SET NULL;
