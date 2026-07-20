CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  owner_id UUID NULL,
  legacy_code VARCHAR(40) NULL
);
