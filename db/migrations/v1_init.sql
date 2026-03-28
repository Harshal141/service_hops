-- ============================================================
-- v1_init — Hops Initial Schema
-- Run on both stage and prod Neon instances
-- ============================================================

CREATE TABLE users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        UNIQUE NOT NULL,              -- unique handle/slug for the user
  name           TEXT,
  email          TEXT        UNIQUE NOT NULL,
  email_verified TIMESTAMPTZ,
  icon           TEXT,                                     -- custom icon per user
  status         VARCHAR(20) NOT NULL DEFAULT 'active',    -- "active" | "inactive" | "banned"
  sub_status     VARCHAR(20),                              -- reserved for future use
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- auto-update updated_at on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- OAuth accounts
-- one user can have multiple providers linked
CREATE TABLE accounts (
  id                  UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                TEXT   NOT NULL,
  provider            TEXT   NOT NULL,             -- "linkedin"
  provider_account_id TEXT   NOT NULL,             -- LinkedIn sub/id
  access_token        TEXT,
  refresh_token       TEXT,
  expires_at          BIGINT,                      -- Unix timestamp
  token_type          TEXT,
  scope               TEXT,
  id_token            TEXT,
  session_state       TEXT,
  UNIQUE(provider, provider_account_id)
);

-- Sessions
CREATE TABLE sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token TEXT        UNIQUE NOT NULL,
  expires       TIMESTAMPTZ NOT NULL
);

-- Magic link / email verification tokens
CREATE TABLE verification_tokens (
  identifier TEXT        NOT NULL,
  token      TEXT        NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- Connections graph
-- directional: user_id -> connected_to
-- query both directions for mutual connections
CREATE TABLE connections (
  id           SERIAL      PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connected_to UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, connected_to)
);

-- Indexes
CREATE INDEX ON accounts(user_id);
CREATE INDEX ON sessions(user_id);
CREATE INDEX ON connections(user_id);
CREATE INDEX ON connections(connected_to);
