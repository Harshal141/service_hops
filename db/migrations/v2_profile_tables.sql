-- ============================================================
-- v2_profile_tables — Extended Profile Schema
-- Run on both stage and prod Neon instances
-- ============================================================

-- ============================================================
-- Profile (1:1 with users — uses same UUID as PK)
-- users is auth-only, all professional info lives here
-- ============================================================
CREATE TABLE profile (
  id         UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio        TEXT,
  title      VARCHAR(500),
  location   TEXT,
  status     VARCHAR(20) NOT NULL DEFAULT 'public',   -- "public" | "private"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_profile_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profile_updated_at
  BEFORE UPDATE ON profile
  FOR EACH ROW EXECUTE FUNCTION set_profile_updated_at();


-- ============================================================
-- Profile Link  (child of profile)
-- ============================================================
CREATE TABLE profile_link (
  id         SERIAL      PRIMARY KEY,
  profile_id UUID        NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL,   -- "github" | "linkedin" | "twitter" | etc.
  url        TEXT        NOT NULL,
  sort_order SMALLINT    NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON profile_link(profile_id);


-- ============================================================
-- Profile Experience  (child of profile)
-- ============================================================
CREATE TABLE profile_experience (
  id          SERIAL      PRIMARY KEY,
  profile_id  UUID        NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  company     TEXT        NOT NULL,
  role        TEXT        NOT NULL,
  started_at        DATE,
  ended_at          DATE,
  currently_working BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  sort_order  SMALLINT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON profile_experience(profile_id);


-- ============================================================
-- Profile Education  (child of profile)
-- ============================================================
CREATE TABLE profile_education (
  id          SERIAL      PRIMARY KEY,
  profile_id  UUID        NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  institution TEXT        NOT NULL,
  degree      TEXT        NOT NULL,
  year        SMALLINT,
  sort_order  SMALLINT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON profile_education(profile_id);


-- ============================================================
-- Skill — 3-level hierarchy in a single adjacency list table
-- level 1: category    (e.g. "Engineering")   parent_id = NULL
-- level 2: subcategory (e.g. "Frontend")       parent_id → level 1
-- level 3: skill       (e.g. "React")          parent_id → level 2
-- only level 3 rows can be tagged to profiles
-- ============================================================
CREATE TABLE skill (
  id           SERIAL  PRIMARY KEY,
  name         TEXT    NOT NULL,
  level        SMALLINT NOT NULL CHECK (level IN (1, 2, 3)),
  parent_id    INTEGER REFERENCES skill(id) ON DELETE CASCADE,  -- NULL for level 1
  user_created BOOLEAN NOT NULL DEFAULT false,  -- false = seeded, shown first in suggestions
  status       VARCHAR(20) NOT NULL DEFAULT 'active',  -- "active" | "inactive" | "pending"
  UNIQUE(parent_id, name)
);

CREATE INDEX ON skill(parent_id);
CREATE INDEX ON skill(name);    -- for autocomplete search
CREATE INDEX ON skill(level);

-- Junction: profile <-> skill (level 3 only)
CREATE TABLE profile_skill (
  profile_id UUID    NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, skill_id)
);

CREATE INDEX ON profile_skill(profile_id);
