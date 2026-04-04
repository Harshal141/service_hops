-- ============================================================
-- v6_education_year_text
-- Change profile_education.year from SMALLINT to TEXT
-- to support "2021-2024", "2021-" (currently studying), "2021"
-- Run on both stage and prod Neon instances
-- ============================================================

ALTER TABLE profile_education
  ALTER COLUMN year TYPE TEXT USING year::TEXT;
