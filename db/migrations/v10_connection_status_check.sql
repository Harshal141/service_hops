-- ============================================================
-- v10_connection_status_check — constrain connection status values
-- Targets: stage + prod
-- Depends on: v7_connection.sql
-- ============================================================
--
-- Why: both uniqueness guarantees in v7 are PARTIAL indexes keyed to a literal
-- status string —
--   uq_cr_pair   ... WHERE status = 'pending'
--   uq_conn_pair ... WHERE status = 'active'
-- so any code path that writes a status outside the intended set silently exits
-- the index and duplicate pairs become possible. Nothing in the schema stopped
-- that until now: the only constraints on these tables were the self-reference
-- checks and the foreign keys.
--
-- Safe to run on a populated database: every existing row already holds one of
-- these values (verified on stage before writing this).

ALTER TABLE connection_request
  DROP CONSTRAINT IF EXISTS cr_status_valid;
ALTER TABLE connection_request
  ADD CONSTRAINT cr_status_valid
  CHECK (status IN ('pending', 'declined', 'withdrawn'));

ALTER TABLE connection
  DROP CONSTRAINT IF EXISTS conn_status_valid;
ALTER TABLE connection
  ADD CONSTRAINT conn_status_valid
  CHECK (status IN ('active', 'disconnected'));

-- Resolved requests are now retained rather than deleted (they are what makes a
-- re-request cooldown possible), so the lookup for "did this pair resolve
-- recently" needs an index.
CREATE INDEX IF NOT EXISTS idx_cr_pair_resolved
  ON connection_request (
    LEAST(requester_id, addressee_id),
    GREATEST(requester_id, addressee_id),
    updated_at DESC
  )
  WHERE status IN ('declined', 'withdrawn');
