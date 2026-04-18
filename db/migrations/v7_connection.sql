-- ============================================================
-- v7_connection — Connection Request + Connection Tables
-- Run on both stage and prod Neon instances
-- ============================================================

-- Drop the unused v1 connections table (no data, no code references it)
DROP TABLE IF EXISTS connections;

-- ── Connection Request (transient workflow) ────────────────

CREATE TABLE connection_request (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | declined | withdrawn
  requester_note  TEXT        NOT NULL,   -- why requester considers addressee a strong connection
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cr_no_self CHECK (requester_id <> addressee_id)
);

-- Only ONE pending request per user pair (regardless of direction)
CREATE UNIQUE INDEX uq_cr_pair
  ON connection_request (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))
  WHERE status = 'pending';

CREATE INDEX idx_cr_addressee ON connection_request(addressee_id) WHERE status = 'pending';
CREATE INDEX idx_cr_requester ON connection_request(requester_id) WHERE status = 'pending';

CREATE TRIGGER connection_request_updated_at
  BEFORE UPDATE ON connection_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Connection (the actual graph) ─────────────────────────

CREATE TABLE connection (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_by_a       TEXT        NOT NULL,   -- why user_a considers user_b a strong connection
  note_by_b       TEXT        NOT NULL,   -- why user_b considers user_a a strong connection
  status          VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | disconnected
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT conn_no_self CHECK (user_a_id <> user_b_id)
);

-- Only ONE active connection per user pair
CREATE UNIQUE INDEX uq_conn_pair
  ON connection (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id))
  WHERE status = 'active';

-- Graph traversal indexes (for BFS / 6-degrees queries)
CREATE INDEX idx_conn_a ON connection(user_a_id) WHERE status = 'active';
CREATE INDEX idx_conn_b ON connection(user_b_id) WHERE status = 'active';

CREATE TRIGGER connection_updated_at
  BEFORE UPDATE ON connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
