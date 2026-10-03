-- ============================================================
-- v15_schema_migration — migration tracking table
-- Targets: stage + prod
-- Depends on: nothing (backfills v1..v14 as already applied)
-- ============================================================
--
-- There is no migration runner. From v15 on, every migration file ends with its own
-- INSERT INTO schema_migration ... ON CONFLICT DO NOTHING, so "was vN run on prod?"
-- is one query:
--   SELECT version, applied_at FROM schema_migration ORDER BY applied_at DESC LIMIT 5;
--
-- The backfill assumes v1..v14 are already applied on the environment this runs on.
-- Confirm that first (e.g. the user_flag table from v14 exists).
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS schema_migration (
  version    TEXT        PRIMARY KEY,          -- file name without .sql, e.g. 'v15_schema_migration'
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migration (version) VALUES
  ('v1_init'),
  ('v2_profile_tables'),
  ('v3_experience_currently_working'),
  ('v4_profile_section_order'),
  ('v5_skill_seed'),
  ('v6_education_year_text'),
  ('v7_connection'),
  ('v8_demo_users'),
  ('v9_demo_connections'),
  ('v10_connection_status_check'),
  ('v11_demo_profiles'),
  ('v12_remove_demo_data'),
  ('v13_referred_by'),
  ('v14_user_flag'),
  ('v15_schema_migration')
ON CONFLICT (version) DO NOTHING;
