-- ============================================================
-- v16_ai_enrichment — resume import: stored uploads, AI tasks, AI call log
-- Targets: stage + prod
-- Depends on: v1_init (users, set_updated_at()), v2_profile_tables (profile_education),
--             v6_education_year_text, v15_schema_migration
-- ============================================================
--
-- Three new tables (see prds/resume-import.md §4):
--   resume_upload       one row per (user, file hash). Text only: the PDF bytes are NOT stored.
--   ai_enrichment       one row per task (user, kind, input hash, pipeline version).
--   ai_enrichment_call  one row per model call, inserted as 'pending' before the fetch.
-- Idempotent: safe to re-run.

-- ── profile_education.degree → nullable ─────────────────────
-- Destructive-ish: relaxes a constraint, no data change. Safe: every existing row already
-- satisfies NOT NULL; readers already handle '' (FE normalizes null → ""). Re-run is a no-op.
ALTER TABLE profile_education ALTER COLUMN degree DROP NOT NULL;

-- ── resume_upload ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resume_upload (
  id             SERIAL      PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256         CHAR(64)    NOT NULL,
  file_name      TEXT,                                  -- display only
  size_bytes     INTEGER     NOT NULL,
  page_count     SMALLINT    NOT NULL,
  extracted_text TEXT        NOT NULL,                  -- post-cleanup, pre-PII-strip
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT resume_upload_user_sha_key UNIQUE (user_id, sha256),
  CONSTRAINT resume_upload_file_name_len_check CHECK (file_name IS NULL OR char_length(file_name) <= 200)
);

-- ── ai_enrichment ───────────────────────────────────────────
-- status:
--   queued      upserted just before the slot claim; never run, or its claim was refused
--               (429). A refused claim leaves the row here.
--   processing  a run owns it; started_at is that run's compare-and-set token
--   succeeded / failed  terminal for that run
CREATE TABLE IF NOT EXISTS ai_enrichment (
  id               SERIAL      PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT        NOT NULL,
  upload_id        INTEGER     REFERENCES resume_upload(id) ON DELETE SET NULL,
  input_hash       CHAR(64)    NOT NULL,                -- cache key (sha256 of the PDF bytes)
  pipeline_version TEXT        NOT NULL,                -- 'resume-v1'
  status           TEXT        NOT NULL DEFAULT 'queued',
  result           JSONB,                               -- normalized draft, skill NAMES only
  error_code       TEXT,
  error_message    TEXT,                                -- internal only
  attempt_count    SMALLINT    NOT NULL DEFAULT 0,
  -- SET NULL so deleting the source user (which cascades its rows) never fails with 23503
  cache_source_id  INTEGER     REFERENCES ai_enrichment(id) ON DELETE SET NULL,
  started_at       TIMESTAMPTZ,                         -- current run's compare-and-set token
  finished_at      TIMESTAMPTZ,
  applied_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_enrichment_kind_check   CHECK (kind IN ('resume_import')),
  CONSTRAINT ai_enrichment_status_check CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  CONSTRAINT ai_enrichment_task_key     UNIQUE (user_id, kind, input_hash, pipeline_version)
);

CREATE OR REPLACE TRIGGER ai_enrichment_updated_at
  BEFORE UPDATE ON ai_enrichment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- cross-user cache lookup
CREATE INDEX IF NOT EXISTS ai_enrichment_cache_idx
  ON ai_enrichment (kind, input_hash, pipeline_version) WHERE status = 'succeeded';
-- slot claim: fresh processing rows (global + per-user concurrency)
CREATE INDEX IF NOT EXISTS ai_enrichment_processing_idx
  ON ai_enrichment (status, started_at) WHERE status = 'processing';
-- per-user history (support / monitoring)
CREATE INDEX IF NOT EXISTS ai_enrichment_user_created_idx
  ON ai_enrichment (user_id, created_at DESC);

-- ── ai_enrichment_call ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_enrichment_call (
  id             SERIAL      PRIMARY KEY,
  enrichment_id  INTEGER     NOT NULL REFERENCES ai_enrichment(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL,                  -- denormalized for the per-user quota count
  step           TEXT        NOT NULL,                  -- 'extract_all'
  attempt        SMALLINT    NOT NULL,
  provider       TEXT        NOT NULL,
  model          TEXT        NOT NULL,
  prompt_version TEXT        NOT NULL,
  input          JSONB       NOT NULL,                  -- { system, user, schema, settings } as sent
  raw_output     TEXT,
  parsed_output  JSONB,
  status         TEXT        NOT NULL DEFAULT 'pending',
  finish_reason  TEXT,
  error_code     TEXT,
  error_message  TEXT,
  http_status    SMALLINT,
  latency_ms     INTEGER,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  tokens_thinking INTEGER,                              -- reasoning tokens, counted in the Groq budget
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_enrichment_call_status_check CHECK (status IN ('pending', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS ai_enrichment_call_enrichment_idx    ON ai_enrichment_call (enrichment_id);
CREATE INDEX IF NOT EXISTS ai_enrichment_call_provider_time_idx ON ai_enrichment_call (provider, created_at);
CREATE INDEX IF NOT EXISTS ai_enrichment_call_user_time_idx     ON ai_enrichment_call (user_id, created_at);

INSERT INTO schema_migration (version) VALUES ('v16_ai_enrichment') ON CONFLICT (version) DO NOTHING;
