-- ============================================================
-- v3_experience_currently_working
-- Adds currently_working flag to profile_experience
-- Run on both stage and prod Neon instances
-- ============================================================

ALTER TABLE profile_experience
  ADD COLUMN currently_working BOOLEAN NOT NULL DEFAULT false;
