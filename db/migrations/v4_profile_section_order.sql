-- ============================================================
-- v4_profile_section_order
-- Adds section_config JSONB to profile
-- Stores per-section order + config (visible, etc.) in one place
-- Extensible without future migrations for new section properties
-- Run on both stage and prod Neon instances
-- ============================================================

ALTER TABLE profile
  ADD COLUMN section_config JSONB NOT NULL DEFAULT '[
    {"key": "links",      "visible": true},
    {"key": "about",      "visible": true},
    {"key": "skills",     "visible": true},
    {"key": "experience", "visible": true},
    {"key": "education",  "visible": true}
  ]'::jsonb;
