// Resume import orchestration; SQL lives in aiEnrichmentService. Synchronous: the whole run
// fits inside the function time limit.

const crypto = require('crypto');
const { AI } = require('../config/ai');
const store = require('./aiEnrichmentService');
const profileService = require('./profileService');
const { readPdf } = require('./resume/pdf');
const { prepareResumeText } = require('./resume/text');
const { normalizeExtraction } = require('./resume/draft');
const { groundDraft } = require('./resume/grounding');
const { lookupNames, matchSkills } = require('./resume/skillMatch');
const { planAttempt, quotaRetryAfter, callInput, extractOnce } = require('./resume/extract');
const {
  ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError, UnprocessableError, UpstreamError,
} = require('../utils/errors');

const BUSY_RETRY_SECONDS = 30;
const DAILY_CAP_FALLBACK_RETRY_SECONDS = 3600;

// Logging: ids, codes, latency, provider only. Never resume text, model I/O, error_message
// bodies, keys, or the raw message of an error that may echo user data.
function logAttempt(enrichmentId, attempt, plan, res) {
  const line = `[ai] enrichment=${enrichmentId} attempt=${attempt} provider=${plan.provider} code=${res.error_code} http=${res.http_status ?? '-'} latency_ms=${res.latency_ms ?? '-'}`;
  if (res.error_code === 'ai_auth') console.error(`${line} — ${plan.provider} API key wrong or revoked`);
  else console.warn(line);
}

// The cause of an internal failure, for the log. A coded (Postgres) error logs its class and
// code only: its message can quote the values that failed. A code bug logs its message.
const cause = (err) => (err?.code
  ? `${err.name} code=${err.code}`
  : `${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 200)}`);

const notEmpty = () => new ConflictError('Your profile already has experience or education', 'profile_not_empty');
const stillProcessing = () => new ConflictError('Your last upload is still being read', 'already_processing');
const busy = () => new TooManyRequestsError('Imports are busy right now, try again shortly', 'busy', BUSY_RETRY_SECONDS);
const aiFailed = () => new UpstreamError("We couldn't read your resume this time", 'ai_failed');

/** Stored result → response body. Skill ids are resolved now, never cached. */
async function respond(env, enrichmentId, result) {
  const { skill_names: names = [], ...draft } = result.draft;
  const rows = await store.findActiveSkills(env, lookupNames(names));
  return {
    enrichment_id: enrichmentId,
    status: 'succeeded',
    warnings: result.warnings ?? [],
    draft: { ...draft, ...matchSkills(names, rows) },
  };
}

/** A refused claim: the right error, or the cached draft when a parallel run just finished it. */
async function refusedClaim(env, { enrichmentId, userId, sha256 }) {
  const { reason, daily_cap_retry_after: dailyRetry } = await store.claimRefusalReason(env, { id: enrichmentId, userId });
  if (reason === 'succeeded') {
    const own = await store.findOwnEnrichment(env, userId, sha256);
    if (own?.status === 'succeeded') return respond(env, own.id, own.result);
  }
  if (reason === 'already_processing') throw stillProcessing();
  if (reason === 'daily_cap') {
    const retryAfter = Math.max(1, dailyRetry ?? DAILY_CAP_FALLBACK_RETRY_SECONDS);
    throw new TooManyRequestsError("You've reached the import limit for the last 24 hours", 'daily_cap', retryAfter);
  }
  throw busy();
}

/**
 * Runs up to two attempts under the run deadline. Each attempt writes a 'pending' call row
 * before the fetch (its id goes into callIds at once, so finishRun can close it if anything
 * throws) and records the outcome as soon as the provider answers. Returns the last result.
 */
async function runAttempts(env, { enrichmentId, userId, text, first, budget, deadline, callIds }) {
  let plan = first;
  for (let attempt = 1; ; attempt++) {
    const callId = await store.insertCall(env, { enrichmentId, userId, attempt, plan, input: callInput(plan, text) });
    callIds.push(callId);
    const res = await extractOnce(plan, text);
    await store.recordAttempt(env, callId, res);
    if (res.ok) return res;

    logAttempt(enrichmentId, attempt, plan, res);
    const next = planAttempt({
      ...budget, inputChars: text.length, attempt: attempt + 1,
      firstProvider: first.provider, lastError: res.error_code, deadline, now: Date.now(),
    });
    if (!next) return res;
    plan = next;
  }
}

/** Model failure code → the error the client gets. Raw provider errors stay in the DB. */
function failureError(code) {
  if (code === 'not_a_resume') return new UnprocessableError('That file does not look like a resume', 'not_a_resume');
  return aiFailed();
}

/**
 * POST /profile/import. `file` is multer's { buffer, originalname, size }.
 * Returns the draft; throws typed errors carrying the API error codes.
 */
async function importResume({ userId, file, env }) {
  const deadline = Date.now() + AI.RUN_DEADLINE_MS;
  const pdf = await readPdf(file.buffer, { maxPages: AI.MAX_PDF_PAGES });
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const [hasContent, own] = await Promise.all([
    store.profileHasContent(env, userId),
    store.findOwnEnrichment(env, userId, sha256),
  ]);
  if (hasContent) throw notEmpty();
  if (own?.status === 'succeeded') return respond(env, own.id, own.result);
  if (own?.fresh) throw stillProcessing();

  const cached = await store.copyCrossUserResult(env, userId, sha256);
  if (cached) return respond(env, cached.id, cached.result);

  const { text, regexLinks, warnings } = prepareResumeText(pdf.text, {
    minChars: AI.MIN_TEXT_CHARS, maxChars: AI.MAX_TEXT_CHARS,
  });

  const enrichmentId = await store.upsertEnrichment(env, userId, sha256);
  const usage = await store.readBudgets(env);
  const budget = {
    geminiOk: usage.gemini_calls < AI.GEMINI_DAILY_BUDGET,
    groqOk: usage.groq_tokens < AI.GROQ_DAILY_TOKEN_BUDGET,
  };
  const first = planAttempt({ ...budget, inputChars: text.length, attempt: 1, deadline, now: Date.now() });
  if (!first) {
    const retryAfter = quotaRetryAfter({
      inputChars: text.length, resets: { gemini: usage.gemini_reset_secs, groq: usage.groq_reset_secs },
    });
    throw new TooManyRequestsError('Imports are paused until the daily AI quota resets', 'quota_exhausted', retryAfter);
  }

  const claim = await store.claimSlot(env, { id: enrichmentId, userId });
  if (!claim) return refusedClaim(env, { enrichmentId, userId, sha256 });

  // From here the run owns the row: every exit must finish it, or the user is locked out with
  // 409 until the stale window passes.
  const callIds = [];
  const finish = (args) => store.finishRun(env, { enrichmentId, runToken: claim.run_token, callIds, ...args });
  let finished = false;
  let failure = { errorCode: 'internal', errorMessage: null };
  try {
    // Stored only after the claim, so a refused upload leaves nothing behind.
    await store.attachUpload(env, {
      enrichmentId, userId, sha256, fileName: file.originalname, sizeBytes: file.size,
      pageCount: pdf.pageCount, text,
    });
    const res = await runAttempts(env, { enrichmentId, userId, text, first, budget, deadline, callIds });
    if (!res.ok) {
      failure = { errorCode: res.error_code, errorMessage: res.error_message };
      throw failureError(res.error_code);
    }

    const normalized = normalizeExtraction(res.parsed, { regexLinks, today: new Date().toISOString().slice(0, 10) });
    const result = {
      draft: groundDraft(normalized.draft, text),
      warnings: [...warnings, ...normalized.warnings],
    };

    // Apply needs the stored 'succeeded' row, so a draft is only returned once this lands.
    // One retry for a transient DB error.
    const succeed = () => finish({ status: 'succeeded', result });
    let finishedRows;
    try {
      finishedRows = await succeed().catch((err) => {
        console.error(`[ai] enrichment=${enrichmentId} finish_retry ${cause(err)}`);
        return succeed();
      });
    } catch (err) {
      console.error(`[ai] enrichment=${enrichmentId} finish_failed ${cause(err)}`);
      throw aiFailed();
    }
    finished = true;
    if (!finishedRows) console.warn(`[ai] enrichment=${enrichmentId} finish_lost (run reclaimed as stale)`);

    return await respond(env, enrichmentId, result);
  } catch (err) {
    if (!finished) {
      if (failure.errorCode === 'internal') {
        console.error(`[ai] enrichment=${enrichmentId} run_failed ${cause(err)}`);
        failure.errorMessage = err?.message ?? null; // stored internally, never logged or sent
      }
      await finish({ status: 'failed', ...failure })
        .catch((finishErr) => console.error(`[ai] enrichment=${enrichmentId} finish_failed ${cause(finishErr)}`));
    }
    throw err;
  }
}

/** POST /profile/import/:id/apply. `payload` is already validated. Returns the refreshed own profile. */
async function applyImport({ userId, enrichmentId, payload, env }) {
  const claimed = await store.applyDraft(env, { id: enrichmentId, userId, payload });
  if (!claimed) {
    const r = await store.applyRefusal(env, { id: enrichmentId, userId });
    if (!r) throw new NotFoundError('Import not found');
    if (!r.owned) throw new ForbiddenError('That import is not yours');
    if (r.applied) throw new ConflictError('That import was already applied', 'already_applied');
    if (r.not_empty) throw notEmpty();
    if (r.status !== 'succeeded') throw new NotFoundError('Import not found or not finished');
    throw new ConflictError('That import was already applied', 'already_applied'); // lost a race
  }
  return profileService.getByUserId(userId, userId, env);
}

module.exports = { importResume, applyImport, MAX_FILE_BYTES: AI.MAX_FILE_BYTES };
