const { chooseProvider, attemptTimeout, planAttempt, quotaRetryAfter, extractOnce, callInput } = require('./extract');
const { AI } = require('../../config/ai');

const SHORT = 5_000;
const LONG = 20_000;
const both = { geminiOk: true, groqOk: true };

describe('chooseProvider', () => {
  it('≤ 10k: Gemini, then Groq after any non-terminal failure', () => {
    expect(chooseProvider({ ...both, attempt: 1, inputChars: SHORT })).toBe('gemini');
    for (const e of ['ai_unavailable', 'ai_timeout', 'ai_truncated', 'ai_invalid_output', 'ai_blocked', 'ai_rate_limited', 'ai_auth', 'ai_bad_request']) {
      expect(chooseProvider({ ...both, attempt: 2, inputChars: SHORT, firstProvider: 'gemini', lastError: e })).toBe('groq');
    }
  });

  it('> 10k: Gemini, then Gemini again only after transient failures', () => {
    expect(chooseProvider({ ...both, attempt: 1, inputChars: LONG })).toBe('gemini');
    for (const e of ['ai_unavailable', 'ai_rate_limited', 'ai_timeout']) {
      expect(chooseProvider({ ...both, attempt: 2, inputChars: LONG, firstProvider: 'gemini', lastError: e })).toBe('gemini');
    }
    for (const e of ['ai_truncated', 'ai_invalid_output', 'ai_blocked', 'ai_auth', 'ai_bad_request']) {
      expect(chooseProvider({ ...both, attempt: 2, inputChars: LONG, firstProvider: 'gemini', lastError: e })).toBeNull();
    }
  });

  it('Gemini over budget: Groq, then Groq again after ai_unavailable only; long input → none', () => {
    const g = { geminiOk: false, groqOk: true };
    expect(chooseProvider({ ...g, attempt: 1, inputChars: SHORT })).toBe('groq');
    expect(chooseProvider({ ...g, attempt: 2, inputChars: SHORT, firstProvider: 'groq', lastError: 'ai_unavailable' })).toBe('groq');
    expect(chooseProvider({ ...g, attempt: 2, inputChars: SHORT, firstProvider: 'groq', lastError: 'ai_timeout' })).toBeNull();
    expect(chooseProvider({ ...g, attempt: 1, inputChars: LONG })).toBeNull();
  });

  it('Groq over budget is skipped', () => {
    const g = { geminiOk: true, groqOk: false };
    expect(chooseProvider({ ...g, attempt: 2, inputChars: SHORT, firstProvider: 'gemini', lastError: 'ai_unavailable' })).toBe('gemini');
    expect(chooseProvider({ ...g, attempt: 2, inputChars: SHORT, firstProvider: 'gemini', lastError: 'ai_truncated' })).toBeNull();
    expect(chooseProvider({ geminiOk: false, groqOk: false, attempt: 1, inputChars: SHORT })).toBeNull();
  });

  it('not_a_resume never gets attempt 2; there is no attempt 3', () => {
    expect(chooseProvider({ ...both, attempt: 2, inputChars: SHORT, firstProvider: 'gemini', lastError: 'not_a_resume' })).toBeNull();
    expect(chooseProvider({ ...both, attempt: 3, inputChars: SHORT, firstProvider: 'gemini', lastError: 'ai_unavailable' })).toBeNull();
  });
});

describe('attemptTimeout (run deadline)', () => {
  const now = 1_000_000;
  it('uses the provider timeout when there is room', () => {
    expect(attemptTimeout('gemini', { deadline: now + 50_000, now })).toBe(30_000);
    expect(attemptTimeout('groq', { deadline: now + 50_000, now })).toBe(15_000);
  });
  it('caps at deadline − now − 3s', () => {
    expect(attemptTimeout('gemini', { deadline: now + 20_000, now })).toBe(17_000);
    expect(attemptTimeout('groq', { deadline: now + 8_000, now })).toBe(5_000);
  });
  it('refuses to start with less than 8s left', () => {
    expect(attemptTimeout('groq', { deadline: now + 7_999, now })).toBeNull();
  });
  it('planAttempt combines both and returns the model and output cap', () => {
    expect(planAttempt({ ...both, attempt: 1, inputChars: SHORT, deadline: now + 50_000, now }))
      .toEqual({ provider: 'gemini', model: AI.GEMINI_MODEL, timeoutMs: 30_000, maxOutputTokens: 8192 });
    expect(planAttempt({ ...both, attempt: 2, inputChars: SHORT, firstProvider: 'gemini', lastError: 'ai_timeout', deadline: now + 18_000, now }))
      .toEqual({ provider: 'groq', model: AI.GROQ_MODEL, timeoutMs: 15_000, maxOutputTokens: 4000 });
    expect(planAttempt({ ...both, attempt: 2, inputChars: SHORT, firstProvider: 'gemini', lastError: 'ai_timeout', deadline: now + 5_000, now })).toBeNull();
  });
});

describe('quotaRetryAfter', () => {
  const resets = { gemini: 7200, groq: 3600.4 };
  it('uses the earlier reset when both providers could serve the input', () => {
    expect(quotaRetryAfter({ inputChars: SHORT, resets })).toBe(3601);
    expect(quotaRetryAfter({ inputChars: SHORT, resets: { gemini: 60, groq: 3600 } })).toBe(60);
  });
  it('ignores the Groq reset for input Groq cannot take', () => {
    expect(quotaRetryAfter({ inputChars: LONG, resets })).toBe(7200);
  });
  it('never returns less than 1s', () => {
    expect(quotaRetryAfter({ inputChars: SHORT, resets: { gemini: 0, groq: 0 } })).toBe(1);
  });
});

describe('extractOnce with the fake provider', () => {
  const plan = { provider: 'gemini', model: 'm', timeoutMs: 30_000, maxOutputTokens: 8192 };
  beforeEach(() => { process.env.AI_FAKE_PROVIDER = '1'; });
  afterEach(() => { delete process.env.AI_FAKE_PROVIDER; delete process.env.AI_FAKE_RESULT; delete process.env.VERCEL_ENV; });

  it('returns zod-parsed output', async () => {
    const r = await extractOnce(plan, 'any resume text');
    expect(r.ok).toBe(true);
    expect(r.parsed.full_name).toBe('Alex Synthetic');
    expect(r.model).toBe('fake:m');
  });
  it('is_resume false → not_a_resume with the parsed output kept', async () => {
    process.env.AI_FAKE_RESULT = 'gemini:not_a_resume';
    const r = await extractOnce(plan, 'any resume text');
    expect(r).toMatchObject({ ok: false, error_code: 'not_a_resume' });
    expect(r.parsed.is_resume).toBe(false);
  });
  it('passes through provider errors', async () => {
    process.env.AI_FAKE_RESULT = 'groq:ok, gemini:ai_unavailable';
    expect(await extractOnce(plan, 'x')).toMatchObject({ ok: false, error_code: 'ai_unavailable', parsed: null });
  });
  it('is never used on a production deploy', async () => {
    process.env.VERCEL_ENV = 'production';
    const fetchMock = vi.fn(async () => ({ status: 503, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect((await extractOnce(plan, 'x')).error_code).toBe('ai_unavailable');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('records the text, pipeline version and request settings, not the prompt or schema', () => {
    expect(callInput({ ...plan, provider: 'groq', maxOutputTokens: 4000 }, 'TEXT')).toEqual({
      text: 'TEXT',
      pipeline_version: AI.PIPELINE_VERSION,
      settings: { temperature: 0, max_completion_tokens: 4000, reasoning_effort: 'low', timeoutMs: 30_000 },
    });
  });
});
