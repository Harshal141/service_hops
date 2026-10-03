// All SQL for resume import (tables from v16_ai_enrichment). Every write that must be atomic is
// one statement (CTEs) or one non-interactive transaction.

const { getDb } = require('../config/db');
const { AI } = require('../config/ai');

const SLOT_LOCK_KEY = 'ai_enrichment_slot';
const APPLY_LOCK_KEY = 'profile_apply';

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

// ── import: cache lookups ───────────────────────────────────────────────────

/** Imports only go into an empty profile (no experience and no education). */
async function profileHasContent(env, userId) {
  const [r] = await getDb(env).query(
    `SELECT EXISTS (SELECT 1 FROM profile_experience WHERE profile_id = $1)
         OR EXISTS (SELECT 1 FROM profile_education  WHERE profile_id = $1) AS has_content`,
    [userId]);
  return r.has_content;
}

/** This user's row for this file, with whether a run on it is still live. */
async function findOwnEnrichment(env, userId, hash) {
  const [r] = await getDb(env).query(
    `SELECT id, status, result,
            (status = 'processing' AND started_at > NOW() - make_interval(secs => $4)) AS fresh
     FROM ai_enrichment
     WHERE user_id = $1 AND kind = $2 AND input_hash = $3 AND pipeline_version = $5`,
    [userId, AI.KIND, hash, AI.STALE_SECONDS, AI.PIPELINE_VERSION]);
  return r ?? null;
}

/**
 * Cross-user cache: copy another user's succeeded result for byte-identical input into this
 * user's row (insert or overwrite a non-live row). Returns { id, result } or null when there
 * is no source, or when this user's row has a live run (the claim will answer 409 then).
 */
async function copyCrossUserResult(env, userId, hash) {
  const [r] = await getDb(env).query(
    `INSERT INTO ai_enrichment
       (user_id, kind, input_hash, pipeline_version, status, result, cache_source_id, started_at, finished_at)
     SELECT $1, kind, input_hash, pipeline_version, 'succeeded', result, id, NOW(), NOW()
     FROM ai_enrichment
     WHERE kind = $2 AND input_hash = $3 AND pipeline_version = $4 AND status = 'succeeded'
       AND user_id <> $1
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 1
     ON CONFLICT (user_id, kind, input_hash, pipeline_version) DO UPDATE SET
       status = 'succeeded', result = EXCLUDED.result, cache_source_id = EXCLUDED.cache_source_id,
       started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
       error_code = NULL, error_message = NULL
     WHERE NOT (ai_enrichment.status = 'processing'
                AND ai_enrichment.started_at > NOW() - make_interval(secs => $5))
     RETURNING id, result`,
    [userId, AI.KIND, hash, AI.PIPELINE_VERSION, AI.STALE_SECONDS]);
  return r ?? null;
}

// ── import: claim ───────────────────────────────────────────────────────────

// New rows start 'queued'. On conflict only touch updated_at, never the status of a live run.
async function upsertEnrichment(env, userId, hash) {
  const [r] = await getDb(env).query(
    `INSERT INTO ai_enrichment (user_id, kind, input_hash, pipeline_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind, input_hash, pipeline_version) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [userId, AI.KIND, hash, AI.PIPELINE_VERSION]);
  return r.id;
}

/**
 * Provider usage in each provider's current free-tier day, and seconds until that day rolls
 * over. Gemini: requests since midnight Pacific. Groq: tokens since midnight UTC, an in-flight
 * ('pending') call counted at its worst case. The day start is converted explicitly: a plain
 * date_trunc('day', NOW()) follows the session time zone. Read just before the claim, outside
 * the lock: budgets are soft limits and may overshoot by a call or two.
 */
async function readBudgets(env) {
  const [r] = await getDb(env).query(
    `WITH day AS (
       SELECT date_trunc('day', NOW() AT TIME ZONE $2::text) AS gemini_day,
              date_trunc('day', NOW() AT TIME ZONE $3::text) AS groq_day
     )
     SELECT
       (SELECT count(*)::int FROM ai_enrichment_call
         WHERE provider = 'gemini'
           AND created_at >= (SELECT gemini_day FROM day) AT TIME ZONE $2::text) AS gemini_calls,
       (SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN $1::int
                                 ELSE COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(tokens_thinking, 0)
                            END), 0)::int
          FROM ai_enrichment_call
         WHERE provider = 'groq'
           AND created_at >= (SELECT groq_day FROM day) AT TIME ZONE $3::text) AS groq_tokens,
       (SELECT EXTRACT(EPOCH FROM ((gemini_day + INTERVAL '1 day') AT TIME ZONE $2::text) - NOW())::int FROM day) AS gemini_reset_secs,
       (SELECT EXTRACT(EPOCH FROM ((groq_day + INTERVAL '1 day') AT TIME ZONE $3::text) - NOW())::int FROM day) AS groq_reset_secs`,
    [AI.GROQ_PENDING_CALL_TOKENS, AI.GEMINI_BUDGET_TZ, AI.GROQ_BUDGET_TZ]);
  return r;
}

/**
 * [lock, update] in one non-interactive transaction. The xact lock serializes every claimer;
 * under READ COMMITTED the UPDATE takes its snapshot after the lock is granted, so it sees
 * every earlier claimer's committed row and the global cap holds under parallel claims.
 * Returns { id, run_token } or null. run_token is started_at as TEXT: a JS Date drops the
 * microseconds and the compare-and-set would match nothing.
 */
async function claimSlot(env, { id, userId }) {
  const sql = getDb(env);
  const [, rows] = await sql.transaction([
    sql.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [SLOT_LOCK_KEY]),
    sql.query(
      `UPDATE ai_enrichment
       SET status = 'processing', started_at = NOW(), finished_at = NULL,
           error_code = NULL, error_message = NULL
       WHERE id = $1 AND user_id = $2
         -- a parallel upload of the same file already finished it: don't pay for it twice
         AND status <> 'succeeded'
         -- this exact row isn't already running (double upload of the same file)
         AND NOT (status = 'processing' AND started_at > NOW() - make_interval(secs => $3))
         -- this user has nothing else running
         AND NOT EXISTS (SELECT 1 FROM ai_enrichment
                         WHERE user_id = $2 AND status = 'processing'
                           AND started_at > NOW() - make_interval(secs => $3))
         -- global concurrency
         AND (SELECT count(*) FROM ai_enrichment
              WHERE status = 'processing'
                AND started_at > NOW() - make_interval(secs => $3)) < $4
         -- per-user daily calls (pending included, so in-flight calls count)
         AND (SELECT count(*) FROM ai_enrichment_call
              WHERE user_id = $2 AND created_at > NOW() - INTERVAL '24 hours') < $5
       RETURNING id, started_at::text AS run_token`,
      [id, userId, AI.STALE_SECONDS, AI.MAX_CONCURRENT, AI.USER_DAILY_CALLS]),
  ]);
  return rows[0] ?? null;
}

/**
 * Why a claim was refused: { reason, daily_cap_retry_after }.
 * reason: 'not_found' | 'succeeded' | 'already_processing' | 'daily_cap' | 'busy'. Outside the
 * lock, so it can race; anything not clearly one of the others is 'busy' (retryable).
 * daily_cap_retry_after: seconds until enough of the rolling 24h window's calls age out for
 * the user to be under the cap again (null when not capped).
 */
async function claimRefusalReason(env, { id, userId }) {
  const [r] = await getDb(env).query(
    `WITH recent AS (
       SELECT created_at,
              row_number() OVER (ORDER BY created_at) AS rn,
              count(*) OVER () AS n
       FROM ai_enrichment_call
       WHERE user_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
     )
     SELECT CASE
       WHEN NOT EXISTS (SELECT 1 FROM ai_enrichment WHERE id = $1 AND user_id = $2) THEN 'not_found'
       WHEN EXISTS (SELECT 1 FROM ai_enrichment
                    WHERE id = $1 AND user_id = $2 AND status = 'succeeded')        THEN 'succeeded'
       WHEN EXISTS (SELECT 1 FROM ai_enrichment
                    WHERE user_id = $2 AND status = 'processing'
                      AND started_at > NOW() - make_interval(secs => $3))           THEN 'already_processing'
       WHEN (SELECT count(*) FROM recent) >= $4                                     THEN 'daily_cap'
       ELSE 'busy'
     END AS reason,
     -- the call whose expiry brings the count back to cap - 1
     (SELECT CEIL(EXTRACT(EPOCH FROM (created_at + INTERVAL '24 hours' - NOW())))::int
        FROM recent WHERE rn = n - $4 + 1) AS daily_cap_retry_after`,
    [id, userId, AI.STALE_SECONDS, AI.USER_DAILY_CALLS]);
  return r;
}

// ── import: run ─────────────────────────────────────────────────────────────

/**
 * Upload record + link it to the enrichment, one statement. `text` is already PII-stripped
 * (v16's column comment says pre-strip; it no longer is). The PDF bytes are never stored.
 * A re-upload of the same bytes refreshes the text: extraction may have changed since.
 */
async function attachUpload(env, { enrichmentId, userId, sha256, fileName, sizeBytes, pageCount, text }) {
  await getDb(env).query(
    `WITH u AS (
       INSERT INTO resume_upload (user_id, sha256, file_name, size_bytes, page_count, extracted_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, sha256) DO UPDATE SET
         file_name = EXCLUDED.file_name, size_bytes = EXCLUDED.size_bytes,
         page_count = EXCLUDED.page_count, extracted_text = EXCLUDED.extracted_text
       RETURNING id
     )
     UPDATE ai_enrichment SET upload_id = (SELECT id FROM u) WHERE id = $7 AND user_id = $1`,
    [userId, sha256, clip(fileName, 200), sizeBytes, pageCount, text, enrichmentId]);
}

/** Inserts the 'pending' call row BEFORE the fetch (so it counts toward quotas) and bumps attempt_count. */
async function insertCall(env, { enrichmentId, userId, attempt, plan, input }) {
  const [r] = await getDb(env).query(
    `WITH c AS (
       INSERT INTO ai_enrichment_call
         (enrichment_id, user_id, step, attempt, provider, model, prompt_version, input, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
       RETURNING id
     ),
     e AS (UPDATE ai_enrichment SET attempt_count = attempt_count + 1 WHERE id = $1)
     SELECT id FROM c`,
    [enrichmentId, userId, AI.STEP, attempt, plan.provider, plan.model, AI.PIPELINE_VERSION, JSON.stringify(input)]);
  return r.id;
}

/**
 * Records a finished attempt on its call row, as soon as the provider answers: the token count
 * feeds the Groq budget and the parsed output survives even if the run fails afterwards.
 */
async function recordAttempt(env, callId, res) {
  await getDb(env).query(
    `UPDATE ai_enrichment_call
     SET status = $2, model = $3, raw_output = $4, parsed_output = $5::jsonb, finish_reason = $6,
         error_code = $7, error_message = $8, http_status = $9, latency_ms = $10,
         tokens_in = $11, tokens_out = $12, tokens_thinking = $13
     WHERE id = $1`,
    [callId, res.ok ? 'succeeded' : 'failed', res.model, res.raw,
      res.parsed == null ? null : JSON.stringify(res.parsed), clip(res.finish_reason, 50),
      res.error_code, clip(res.error_message, 2000), res.http_status, res.latency_ms,
      res.usage?.in ?? null, res.usage?.out ?? null, res.usage?.thinking ?? null]);
}

/**
 * Ends a run, one statement. Compare-and-set on the run token: a run reclaimed as stale
 * finishes 0 rows and leaves the new owner alone. Independently of that, any of this run's
 * call rows still 'pending' (the run died between the fetch and recordAttempt) are closed as
 * failed, so they stop counting as in-flight against the Groq budget.
 * Returns the number of enrichment rows finished (1, or 0 when the run lost the row).
 */
async function finishRun(env, { enrichmentId, runToken, status, result = null, errorCode = null, errorMessage = null, callIds = [] }) {
  const rows = await getDb(env).query(
    `WITH orphaned AS (
       UPDATE ai_enrichment_call
       SET status = 'failed', error_code = 'internal', error_message = 'run ended before the call was recorded'
       WHERE id = ANY($7::int[]) AND status = 'pending'
     )
     UPDATE ai_enrichment
     SET status = $3, result = $4::jsonb, error_code = $5, error_message = $6, finished_at = NOW()
     WHERE id = $1 AND started_at = $2::timestamptz AND status = 'processing'
     RETURNING id`,
    [enrichmentId, runToken, status, result == null ? null : JSON.stringify(result),
      errorCode, clip(errorMessage, 2000), callIds]);
  return rows.length;
}

/** Active level-3 skills by lowercase name. One query. */
async function findActiveSkills(env, lowerNames) {
  if (!lowerNames.length) return [];
  return getDb(env).query(
    `SELECT id, name FROM skill
     WHERE level = 3 AND status = 'active' AND lower(name) = ANY($1::text[])`,
    [lowerNames]);
}

// ── apply ───────────────────────────────────────────────────────────────────

// One statement: the claim CTE gates every write (owned, succeeded, unapplied, profile still
// empty), so either everything lands or nothing does. Works with no profile row yet (the FK is
// satisfied by the sibling insert), skips inactive or non-level-3 skills and links the profile
// already has, a bad date anywhere rolls back everything, and a NULL name leaves users.name.
const APPLY_SQL = `
WITH claim AS (
  UPDATE ai_enrichment SET applied_at = NOW()
  WHERE id = $1 AND user_id = $2 AND status = 'succeeded' AND applied_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM profile_experience WHERE profile_id = $2)
    AND NOT EXISTS (SELECT 1 FROM profile_education  WHERE profile_id = $2)
  RETURNING user_id
),
prof AS (
  -- the profile row may not exist yet; keep any existing non-empty title/bio/location
  INSERT INTO profile (id, title, bio, location)
  SELECT user_id, $3::text, $4::text, $5::text FROM claim
  ON CONFLICT (id) DO UPDATE SET
    title    = COALESCE(NULLIF(profile.title, ''),    EXCLUDED.title),
    bio      = COALESCE(NULLIF(profile.bio, ''),      EXCLUDED.bio),
    location = COALESCE(NULLIF(profile.location, ''), EXCLUDED.location),
    updated_at = NOW()
  RETURNING id
),
l AS (
  -- links are allowed on an "empty" profile: skip ones it already has, append after them
  INSERT INTO profile_link (profile_id, type, url, sort_order)
  SELECT c.user_id, x.type, x.url,
         x.sort_order + COALESCE((SELECT max(sort_order) + 1 FROM profile_link WHERE profile_id = c.user_id), 0)
  FROM claim c, jsonb_to_recordset($6::jsonb) AS x(type text, url text, sort_order smallint)
  WHERE NOT EXISTS (SELECT 1 FROM profile_link pl WHERE pl.profile_id = c.user_id AND pl.url = x.url)
),
e AS (
  INSERT INTO profile_experience
    (profile_id, company, role, started_at, ended_at, currently_working, description, sort_order)
  SELECT c.user_id, x.company, x.role, x.started_at, x.ended_at,
         COALESCE(x.currently_working, false), x.description, x.sort_order
  FROM claim c, jsonb_to_recordset($7::jsonb) AS x(
    company text, role text, started_at date, ended_at date,
    currently_working boolean, description text, sort_order smallint)
),
d AS (
  INSERT INTO profile_education (profile_id, institution, degree, year, sort_order)
  SELECT c.user_id, x.institution, x.degree, x.year, x.sort_order
  FROM claim c, jsonb_to_recordset($8::jsonb) AS x(
    institution text, degree text, year text, sort_order smallint)
),
s AS (
  -- only level-3 active skills; anything else is silently skipped
  INSERT INTO profile_skill (profile_id, skill_id)
  SELECT c.user_id, sk.id FROM claim c
  JOIN skill sk ON sk.id = ANY($9::int[]) AND sk.level = 3 AND sk.status = 'active'
  ON CONFLICT DO NOTHING
),
n AS (
  UPDATE users SET name = $10::text FROM claim c
  WHERE $10::text IS NOT NULL AND users.id = c.user_id
)
SELECT count(*)::int AS claimed FROM claim`;

/**
 * Writes a validated draft into the profile. The per-user xact lock serializes applies, so two
 * different enrichments applied in parallel can't both see an empty profile and both write.
 * Returns 1 if applied, 0 if the gate refused.
 */
async function applyDraft(env, { id, userId, payload: p }) {
  const sql = getDb(env);
  const [, rows] = await sql.transaction([
    sql.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2::text))`, [APPLY_LOCK_KEY, userId]),
    sql.query(APPLY_SQL, [
      id, userId, p.title, p.bio, p.location,
      JSON.stringify(p.links), JSON.stringify(p.experience), JSON.stringify(p.education),
      p.skillIds, p.name,
    ]),
  ]);
  return rows[0].claimed;
}

/** Follow-up read after a refused apply: which 404 / 403 / 409 it was. */
async function applyRefusal(env, { id, userId }) {
  const [r] = await getDb(env).query(
    `SELECT e.user_id = $2::uuid AS owned, e.status, e.applied_at IS NOT NULL AS applied,
            EXISTS (SELECT 1 FROM profile_experience WHERE profile_id = $2)
         OR EXISTS (SELECT 1 FROM profile_education  WHERE profile_id = $2) AS not_empty
     FROM ai_enrichment e WHERE e.id = $1`,
    [id, userId]);
  return r ?? null;
}

module.exports = {
  profileHasContent, findOwnEnrichment, copyCrossUserResult,
  upsertEnrichment, readBudgets, claimSlot, claimRefusalReason,
  attachUpload, insertCall, recordAttempt, finishRun, findActiveSkills,
  applyDraft, applyRefusal,
};
