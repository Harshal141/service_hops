// Attempt planning and one extraction attempt (provider call → zod → is_resume). No SQL.

const { AI, keys, useFakeProvider } = require('../../config/ai');
const { RESUME_SCHEMA, resumeZod, SYSTEM, buildUser } = require('./schema');
const gemini = require('./providers/gemini');
const groq = require('./providers/groq');
const fake = require('./providers/fake');

const PROVIDERS = { gemini, groq };

// The model answered and the answer is "not a resume": asking the other one won't change that.
const TERMINAL = new Set(['not_a_resume']);
// Worth retrying the same provider (long inputs can't go to Groq).
const TRANSIENT = new Set(['ai_unavailable', 'ai_rate_limited', 'ai_timeout']);

/**
 * Which provider runs attempt 1 or 2. Pure.
 *   ≤ GROQ_MAX_INPUT_CHARS: Gemini → Groq after any non-terminal failure (auth and bad-request
 *                           included: a broken Gemini key must not take imports down)
 *   longer:                 Gemini → Gemini again, only after a transient failure
 *   Gemini over budget:     Groq   → Groq again, only after ai_unavailable
 * Returns 'gemini' | 'groq' | null (null on attempt 1: no provider has budget for this input).
 */
function chooseProvider({ attempt, inputChars, geminiOk, groqOk, firstProvider, lastError }) {
  const groqOkForInput = groqOk && inputChars <= AI.GROQ_MAX_INPUT_CHARS;
  if (attempt === 1) {
    if (geminiOk) return 'gemini';
    return groqOkForInput ? 'groq' : null;
  }
  if (attempt > 2 || TERMINAL.has(lastError)) return null;
  if (firstProvider === 'gemini') {
    if (groqOkForInput) return 'groq';
    return TRANSIENT.has(lastError) ? 'gemini' : null;
  }
  return lastError === 'ai_unavailable' ? 'groq' : null;
}

/**
 * Attempt timeout under the run deadline: min(provider timeout, deadline − now − margin).
 * Returns null when less than MIN_ATTEMPT_MS is left: never start a doomed attempt.
 */
function attemptTimeout(provider, { deadline, now }) {
  const left = deadline - now;
  if (left < AI.MIN_ATTEMPT_MS) return null;
  const providerMs = provider === 'gemini' ? AI.GEMINI_TIMEOUT_MS : AI.GROQ_TIMEOUT_MS;
  return Math.min(providerMs, left - AI.DEADLINE_MARGIN_MS);
}

/** Full plan for one attempt, or null. */
function planAttempt(args) {
  const provider = chooseProvider(args);
  if (!provider) return null;
  const timeoutMs = attemptTimeout(provider, args);
  if (timeoutMs === null) return null;
  return provider === 'gemini'
    ? { provider, model: AI.GEMINI_MODEL, timeoutMs, maxOutputTokens: AI.GEMINI_MAX_OUTPUT_TOKENS }
    : { provider, model: AI.GROQ_MODEL, timeoutMs, maxOutputTokens: AI.GROQ_MAX_OUTPUT_TOKENS };
}

/**
 * Seconds until a provider that could serve this input has budget again, for Retry-After when
 * attempt 1 has no provider. Gemini can always serve; Groq only an input it fits. Every such
 * provider is exhausted at this point, so the earliest of their resets is when a retry can work.
 * `resets` = { gemini, groq } seconds until each budget window rolls over.
 */
function quotaRetryAfter({ inputChars, resets }) {
  const candidates = [resets.gemini];
  if (inputChars <= AI.GROQ_MAX_INPUT_CHARS) candidates.push(resets.groq);
  return Math.max(1, Math.ceil(Math.min(...candidates)));
}

// Stored in ai_enrichment_call.input. The prompt and schema are fixed per pipeline_version, so
// only the PII-stripped text and the request settings vary.
function callInput(plan, text) {
  return {
    text,
    pipeline_version: AI.PIPELINE_VERSION,
    settings: { ...PROVIDERS[plan.provider].settings(plan), timeoutMs: plan.timeoutMs },
  };
}

const zodSummary = (error) => error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

/**
 * Runs one attempt. Never throws for provider failures. `parsed` is set only when the output
 * passed zod (stored as parsed_output, including an is_resume:false answer).
 */
async function extractOnce(plan, text) {
  const complete = useFakeProvider() ? fake[plan.provider] : PROVIDERS[plan.provider].complete;
  const res = await complete({
    apiKey: keys()[plan.provider],
    model: plan.model,
    system: SYSTEM,
    user: buildUser(text),
    schema: RESUME_SCHEMA,
    maxOutputTokens: plan.maxOutputTokens,
    timeoutMs: plan.timeoutMs,
  });
  if (!res.ok) return { ...res, parsed: null };
  const z = resumeZod.safeParse(res.json);
  if (!z.success) return { ...res, ok: false, parsed: null, error_code: 'ai_invalid_output', error_message: zodSummary(z.error) };
  if (!z.data.is_resume) return { ...res, ok: false, parsed: z.data, error_code: 'not_a_resume', error_message: 'is_resume false' };
  return { ...res, parsed: z.data };
}

module.exports = { chooseProvider, attemptTimeout, planAttempt, quotaRetryAfter, callInput, extractOnce };
