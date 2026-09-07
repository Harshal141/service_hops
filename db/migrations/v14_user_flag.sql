-- ============================================================
-- v14_user_flag — shared per-user flag/checklist store
-- Targets: stage + prod
-- Depends on: v1_init.sql (users, set_updated_at())
-- ============================================================
--
-- One row per user, one JSONB bag. Every "has the user seen X / dismissed Y /
-- reached step Z" fact for any feature lives here as a named flow inside
-- `data`, instead of a bespoke column or table per feature (onboarding,
-- resume-completion nudge, and anything similar that comes later all share
-- this one table).
--
-- A flow's internal shape (which fields it carries) is owned by whichever
-- feature reads/writes it, not by this table — see flagService.js's
-- KNOWN_FLOWS allowlist for which flow keys currently exist.

CREATE TABLE IF NOT EXISTS user_flag (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER user_flag_updated_at
  BEFORE UPDATE ON user_flag
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
