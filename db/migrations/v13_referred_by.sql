-- ============================================================
-- v13_referred_by — track which user referred a new signup
-- Targets: stage + prod
-- Depends on: v1_init.sql
-- ============================================================
--
-- Nullable, set once at insert time by userService.upsert when a new signup
-- arrives via a /invite/<id> link. Never updated after insert — see
-- prds/referral-signin-redirect.md Part 2.
--
-- ON DELETE SET NULL: if the referrer's account is later removed, the
-- referred user's row must not be deleted or blocked — the attribution is
-- just no longer resolvable.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
