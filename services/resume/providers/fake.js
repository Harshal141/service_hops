// Fixture provider for local dev and Vitest. No network; same result shape as the real ones.
// Enabled by AI_FAKE_PROVIDER=1 and refused on production deploys (config/ai.useFakeProvider).
//
// Steering, per provider: AI_FAKE_RESULT=gemini:ai_unavailable,groq:ok
//   ok (default)   → fixtures/resume.json
//   not_a_resume   → fixtures/not_resume.json (is_resume: false)
//   any other code → that error code, e.g. ai_auth, ai_rate_limited

const resumeFixture = require('../fixtures/resume.json');
const notResumeFixture = require('../fixtures/not_resume.json');
const { baseResult } = require('./shared');

const HTTP_FOR = { ai_rate_limited: 429, ai_unavailable: 503, ai_input_too_large: 413, ai_bad_request: 400, ai_auth: 401 };

function forcedResult(provider) {
  for (const part of (process.env.AI_FAKE_RESULT || '').split(',')) {
    const [p, code] = part.trim().split(':');
    if (p === provider && code) return code;
  }
  return 'ok';
}

function fakeComplete(provider) {
  return async function complete({ model, user }) {
    const out = { ...baseResult(provider, `fake:${model}`), latency_ms: 1 };
    const forced = forcedResult(provider);
    if (forced !== 'ok' && forced !== 'not_a_resume') {
      return { ...out, http_status: HTTP_FOR[forced] ?? null, error_code: forced, error_message: 'fake provider error' };
    }
    const json = forced === 'not_a_resume' ? notResumeFixture : resumeFixture;
    const raw = JSON.stringify(json);
    return {
      ...out, ok: true, json: structuredClone(json), raw, http_status: 200,
      finish_reason: provider === 'gemini' ? 'STOP' : 'stop',
      usage: { in: Math.ceil(user.length / 4), out: Math.ceil(raw.length / 4), thinking: 0 },
    };
  };
}

module.exports = { gemini: fakeComplete('gemini'), groq: fakeComplete('groq') };
