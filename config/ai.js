// Resume import settings. Keys are read here and nowhere else; never log them.

const positiveInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Each timeout must outlive the one inside it: per AI call (30s / 15s) < run deadline (50s)
// < BE function (55s) < FE route (75s) < FE client abort (80s) < stale-run window (85s).
const FUNCTION_MAX_SECONDS = 55; // must match vercel.json "maxDuration"

const AI = Object.freeze({
  KIND: 'resume_import',
  // Part of the cache key and tags every stored call: bump on any prompt, schema or
  // normalization change.
  PIPELINE_VERSION: 'resume-v1',
  STEP: 'extract_all',

  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_PDF_PAGES: 5,
  MIN_TEXT_CHARS: 300,
  MAX_TEXT_CHARS: 30_000,

  GEMINI_MODEL: process.env.AI_PRIMARY_MODEL || 'gemini-3.5-flash-lite',
  GROQ_MODEL: process.env.AI_FALLBACK_GROQ_MODEL || 'openai/gpt-oss-120b',
  GEMINI_TIMEOUT_MS: 30_000,
  GROQ_TIMEOUT_MS: 15_000,
  GEMINI_MAX_OUTPUT_TOKENS: 8192,
  GROQ_MAX_OUTPUT_TOKENS: 4000,
  // ≈ 3.5k prompt tokens + 4000 output = 7.5k, under Groq's 8K TPM request cap.
  GROQ_MAX_INPUT_CHARS: 10_000,

  RUN_DEADLINE_MS: 50_000,
  MIN_ATTEMPT_MS: 8_000,     // never start an attempt with less than this left
  DEADLINE_MARGIN_MS: 3_000, // attempt timeout = min(provider timeout, deadline − now − margin)

  MAX_CONCURRENT: positiveInt('AI_MAX_CONCURRENT', 3),
  USER_DAILY_CALLS: positiveInt('AI_USER_DAILY_CALLS', 10),
  GEMINI_DAILY_BUDGET: positiveInt('GEMINI_DAILY_BUDGET', 400),
  GROQ_DAILY_TOKEN_BUDGET: positiveInt('GROQ_DAILY_TOKEN_BUDGET', 180_000),
  GROQ_PENDING_CALL_TOKENS: 7_500, // an in-flight Groq call counts as its worst case
  // Each provider's free-tier day: Gemini resets at midnight Pacific, Groq at midnight UTC.
  GEMINI_BUDGET_TZ: 'America/Los_Angeles',
  GROQ_BUDGET_TZ: 'UTC',
  // A 'processing' row older than this is presumed dead (its function was killed).
  STALE_SECONDS: FUNCTION_MAX_SECONDS + 30,
});

const keys = () => ({
  gemini: process.env.GEMINI_API_KEY || '',
  groq: process.env.GROQ_API_KEY || '',
});

// Read live because tests toggle it; refused on production so a stray env var can't fake imports.
const useFakeProvider = () =>
  process.env.AI_FAKE_PROVIDER === '1' && process.env.VERCEL_ENV !== 'production';

module.exports = { AI, keys, useFakeProvider };
