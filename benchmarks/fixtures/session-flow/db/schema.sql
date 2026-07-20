CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  token VARCHAR(128) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  actor_user_id UUID NULL,
  event_type VARCHAR(80) NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
