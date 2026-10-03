-- ============================================================
-- v17_schema_migration_prod_fix — un-record the demo migrations that never ran on prod
-- Targets: PROD ONLY — never run on stage, where these rows are true
-- Depends on: v15_schema_migration.sql
-- ============================================================
--
-- v15 backfilled v1..v14 as applied on every environment it ran on, but four of those never
-- ran on prod. v15 is frozen (applied on stage and prod), so this corrects the record:
--   v9_demo_connections, v11_demo_profiles, v12_remove_demo_data: stage-only per their headers.
--   v8_demo_users: its header says "both stage and prod", but it never ran on prod. Its only
--     effect is '@demo.hops' users, the only thing that removes them (v12) is stage-only, and
--     prod has none.
--
-- DESTRUCTIVE (tracking rows only; no schema or user data). Idempotent: safe to re-run.

DELETE FROM schema_migration
WHERE version IN ('v8_demo_users', 'v9_demo_connections', 'v11_demo_profiles', 'v12_remove_demo_data');

INSERT INTO schema_migration (version) VALUES ('v17_schema_migration_prod_fix') ON CONFLICT (version) DO NOTHING;
