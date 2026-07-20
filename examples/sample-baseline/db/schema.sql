CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  display_name VARCHAR(120) NULL,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  token VARCHAR(256) NOT NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL,
  CONSTRAINT fk_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  actor_user_id UUID NULL,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
