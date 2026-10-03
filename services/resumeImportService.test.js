// No DB, no network: the store (all SQL) is stubbed and the AI is the fixture provider unless a
// test stubs fetch. The PDF is the synthetic fixture that the fake provider's resume.json mirrors.
const fs = require('fs');
const path = require('path');

// config/db.js builds neon() clients at require time; it needs a URL-shaped string, not a DB.
process.env.NEON_STAGE_URL ??= 'postgresql://user:pass@localhost.invalid/db';
process.env.NEON_PROD_URL ??= 'postgresql://user:pass@localhost.invalid/db';

// Spied before the service captures it, so a test can make post-processing throw.
const draftModule = require('./resume/draft');
const normalizeSpy = vi.spyOn(draftModule, 'normalizeExtraction');

const store = require('./aiEnrichmentService');
const profileService = require('./profileService');
const { importResume, applyImport } = require('./resumeImportService');
const resumeFixture = require('./resume/fixtures/resume.json');

const PDF = fs.readFileSync(path.join(__dirname, 'resume', 'fixtures', 'pdf', 'plain.pdf'));
const USER = '550e8400-e29b-41d4-a716-446655440000';

const errorOf = async (p) => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };
const run = (buffer = PDF) => importResume({ userId: USER, file: { buffer, originalname: 'resume.pdf', size: buffer.length }, env: 'stage' });
const budgets = (gemini_calls, groq_tokens, gemini_reset_secs = 7200) => ({ gemini_calls, groq_tokens, gemini_reset_secs, groq_reset_secs: 3600 });

// The final state of the run's row, as finishRun last left it.
let finished;
const lastFinish = () => finished.at(-1);

beforeEach(() => {
  process.env.AI_FAKE_PROVIDER = '1';
  delete process.env.AI_FAKE_RESULT;
  finished = [];
  let nextCallId = 7;
  Object.assign(store, {
    profileHasContent: vi.fn(async () => false),
    findOwnEnrichment: vi.fn(async () => null),
    copyCrossUserResult: vi.fn(async () => null),
    upsertEnrichment: vi.fn(async () => 42),
    readBudgets: vi.fn(async () => budgets(0, 0)),
    claimSlot: vi.fn(async () => ({ id: 42, run_token: 'token' })),
    claimRefusalReason: vi.fn(async () => ({ reason: 'busy', daily_cap_retry_after: null })),
    attachUpload: vi.fn(async () => {}),
    insertCall: vi.fn(async () => nextCallId++),
    recordAttempt: vi.fn(async () => {}),
    finishRun: vi.fn(async (_env, args) => { finished.push({ ...args, callIds: [...args.callIds] }); return 1; }),
    findActiveSkills: vi.fn(async () => [{ id: 5, name: 'Go' }, { id: 9, name: 'Kubernetes' }]),
    applyDraft: vi.fn(async () => 1),
    applyRefusal: vi.fn(async () => null),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.AI_FAKE_PROVIDER;
  delete process.env.AI_FAKE_RESULT;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
  vi.mocked(console.error).mockRestore();
});

describe('importResume — a fresh run', () => {
  it('returns the draft with skills resolved and stores the result as succeeded', async () => {
    const out = await run();

    expect(out).toMatchObject({ enrichment_id: 42, status: 'succeeded', warnings: [] });
    expect(out.draft.full_name).toBe('Alex Synthetic');
    expect(out.draft.profile).toEqual({
      title: 'Senior Software Engineer', bio: expect.stringContaining('Backend engineer'), location: 'Bengaluru, India',
    });
    expect(out.draft.experience.map((e) => [e.company, e.started_at, e.reasons])).toEqual([
      ['Acme Payments', '2021-03-01', []],
      ['Globex', '2021-03-01', []],
      ['Initech', '2019-01-01', []],
    ]);
    expect(out.draft.education[0]).toMatchObject({ year: '2015-2019', low_confidence: false });
    expect(out.draft.links[0]).toMatchObject({ source: 'regex', url: expect.stringMatching(/^https:\/\/www\.example-portfolio-site\.dev\//) });
    expect(out.draft.skills).toEqual([{ key: 'skill-5', id: 5, name: 'Go' }, { key: 'skill-9', id: 9, name: 'Kubernetes' }]);
    expect(out.draft.unmatched_skills).toEqual(['Java', 'Kotlin', 'PostgreSQL', 'Kafka', 'Terraform', 'AWS']);

    expect(lastFinish()).toMatchObject({ status: 'succeeded', callIds: [7] });
    expect(lastFinish().result.draft.skill_names).toContain('Kafka');
  });

  it('never stores or sends the email or phone number', async () => {
    await run();
    const stored = JSON.stringify([store.attachUpload.mock.calls, store.insertCall.mock.calls]);
    expect(stored).toContain('[email]');
    expect(stored).not.toContain('alex.synthetic@example.com');
    expect(stored).not.toContain('98765');
  });

  it('succeeds via Groq when Gemini fails, including ai_auth and ai_bad_request', async () => {
    for (const code of ['ai_unavailable', 'ai_auth', 'ai_bad_request']) {
      process.env.AI_FAKE_RESULT = `gemini:${code}`;
      expect((await run()).status).toBe('succeeded');
      expect(lastFinish().callIds).toHaveLength(2);
    }
  });

  it('a revoked Gemini key (HTTP 400 API_KEY_INVALID) falls back to Groq and logs no secrets', async () => {
    delete process.env.AI_FAKE_PROVIDER;
    vi.stubEnv('GEMINI_API_KEY', 'gemini-secret-for-test');
    vi.stubEnv('GROQ_API_KEY', 'groq-secret-for-test');
    vi.stubGlobal('fetch', vi.fn(async (url) => (url.includes('generativelanguage.googleapis.com')
      ? { status: 400, text: async () => JSON.stringify({ error: {
        code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
        details: [{ reason: 'API_KEY_INVALID' }],
      } }) }
      : { status: 200, text: async () => JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(resumeFixture) } }],
        usage: { prompt_tokens: 3000, completion_tokens: 900 },
      }) })));

    expect((await run()).status).toBe('succeeded');
    const logged = vi.mocked(console.error).mock.calls.join('\n');
    expect(logged).toMatch(/\[ai\] enrichment=42 attempt=1 provider=gemini code=ai_auth/);
    expect(logged).not.toContain('gemini-secret-for-test');
    expect(logged).not.toContain('API key not valid');
  });

  it('succeeds when only Groq has budget', async () => {
    store.readBudgets.mockResolvedValue(budgets(400, 0));
    expect((await run()).status).toBe('succeeded');
  });

  it('429 quota_exhausted with Retry-After = the earlier reset when no provider has budget', async () => {
    store.readBudgets.mockResolvedValue(budgets(400, 180_000));
    expect(await errorOf(run())).toMatchObject({ status: 429, code: 'quota_exhausted', retryAfter: 3600 });
    store.readBudgets.mockResolvedValue(budgets(400, 180_000, 600));
    expect(await errorOf(run())).toMatchObject({ status: 429, code: 'quota_exhausted', retryAfter: 600 });
    expect(finished).toEqual([]);
  });

  it('502 ai_failed after both attempts fail; the run ends failed with the last code', async () => {
    process.env.AI_FAKE_RESULT = 'gemini:ai_unavailable,groq:ai_rate_limited';
    const err = await errorOf(run());
    expect(err).toMatchObject({ status: 502, code: 'ai_failed' });
    expect(err.message).not.toMatch(/fake provider/);
    expect(lastFinish()).toMatchObject({ status: 'failed', errorCode: 'ai_rate_limited', callIds: [7, 8] });
  });

  it('422 not_a_resume when the model says so, without a second attempt', async () => {
    process.env.AI_FAKE_RESULT = 'gemini:not_a_resume';
    expect(await errorOf(run())).toMatchObject({ status: 422, code: 'not_a_resume' });
    expect(lastFinish()).toMatchObject({ status: 'failed', errorCode: 'not_a_resume', callIds: [7] });
  });
});

describe('importResume — failures inside a claimed run', () => {
  it('a throw before the model ends the run failed', async () => {
    store.insertCall.mockRejectedValue(new Error('db down'));
    await expect(run()).rejects.toThrow('db down');
    expect(lastFinish()).toMatchObject({ status: 'failed', errorCode: 'internal', callIds: [] });
  });

  it('a throw after the model answered ends the run failed, closing its call row', async () => {
    normalizeSpy.mockImplementationOnce(() => { throw new TypeError('boom'); });
    await expect(run()).rejects.toThrow('boom');
    expect(lastFinish()).toMatchObject({ status: 'failed', errorCode: 'internal', callIds: [7] });
    expect(vi.mocked(console.error).mock.calls.join('\n')).toMatch(/run_failed TypeError: boom/);
  });

  it('a failed recordAttempt still ends the run with that call id, logging only the code', async () => {
    store.recordAttempt.mockRejectedValueOnce(Object.assign(new Error('conn reset'), { name: 'NeonDbError', code: '08006' }));
    await expect(run()).rejects.toThrow('conn reset');
    expect(lastFinish()).toMatchObject({ status: 'failed', callIds: [7] });
    expect(vi.mocked(console.error).mock.calls.join('\n')).toContain('run_failed NeonDbError code=08006');
  });

  it('survives one failed success-finish', async () => {
    store.finishRun.mockRejectedValueOnce(new Error('blip'));
    expect((await run()).status).toBe('succeeded');
    expect(lastFinish().status).toBe('succeeded');
  });

  it('502 ai_failed when the success-finish fails twice; the run then ends failed', async () => {
    store.finishRun.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
    expect(await errorOf(run())).toMatchObject({ status: 502, code: 'ai_failed' });
    expect(lastFinish()).toMatchObject({ status: 'failed', errorCode: 'internal', callIds: [7] });
  });

  it('still returns its draft after losing the row to a stale reclaim', async () => {
    store.finishRun.mockResolvedValueOnce(0);
    expect((await run()).status).toBe('succeeded');
  });
});

describe('importResume — caches and refusals', () => {
  const stored = { draft: { full_name: 'X', profile: {}, links: [], experience: [], education: [], skill_names: ['go', 'Rust'] }, warnings: ['input_truncated'] };

  it('own succeeded row: returned with skills re-resolved, without running', async () => {
    store.findOwnEnrichment.mockResolvedValue({ id: 3, status: 'succeeded', result: stored, fresh: false });
    const out = await run();
    expect(out).toMatchObject({ enrichment_id: 3, warnings: ['input_truncated'] });
    expect(out.draft.skills).toEqual([{ key: 'skill-5', id: 5, name: 'Go' }]);
    expect(out.draft.unmatched_skills).toEqual(['Rust']);
    expect(finished).toEqual([]);
  });

  it('cross-user cache hit: the copied result, without running', async () => {
    store.copyCrossUserResult.mockResolvedValue({ id: 8, result: stored });
    expect((await run()).enrichment_id).toBe(8);
    expect(finished).toEqual([]);
  });

  it('a parallel upload that already succeeded: its draft is returned', async () => {
    store.claimSlot.mockResolvedValue(null);
    store.claimRefusalReason.mockResolvedValue({ reason: 'succeeded', daily_cap_retry_after: null });
    store.findOwnEnrichment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 42, status: 'succeeded', result: stored, fresh: false });
    expect(await run()).toMatchObject({ enrichment_id: 42, status: 'succeeded' });
  });

  it('maps live runs, non-empty profiles, refused claims and bad bytes to their errors', async () => {
    store.findOwnEnrichment.mockResolvedValueOnce({ id: 3, status: 'processing', result: null, fresh: true });
    expect(await errorOf(run())).toMatchObject({ status: 409, code: 'already_processing' });

    store.profileHasContent.mockResolvedValueOnce(true);
    expect(await errorOf(run())).toMatchObject({ status: 409, code: 'profile_not_empty' });

    expect(await errorOf(run(Buffer.from('nope')))).toMatchObject({ status: 400, code: 'not_pdf' });

    store.claimSlot.mockResolvedValue(null);
    const refusals = [['daily_cap', 429, 'daily_cap'], ['already_processing', 409, 'already_processing'], ['busy', 429, 'busy'], ['not_found', 429, 'busy']];
    for (const [reason, status, code] of refusals) {
      store.claimRefusalReason.mockResolvedValue({ reason, daily_cap_retry_after: null });
      expect(await errorOf(run())).toMatchObject({ status, code });
    }
    expect(finished).toEqual([]);
  });

  it('daily_cap Retry-After is when the oldest counted call leaves the 24h window', async () => {
    store.claimSlot.mockResolvedValue(null);
    store.claimRefusalReason.mockResolvedValue({ reason: 'daily_cap', daily_cap_retry_after: 5400 });
    expect(await errorOf(run())).toMatchObject({ status: 429, code: 'daily_cap', retryAfter: 5400 });
  });
});

describe('applyImport', () => {
  const payload = { name: null, title: null, bio: null, location: null, links: [], experience: [], education: [], skillIds: [] };
  const apply = () => applyImport({ userId: USER, enrichmentId: 42, payload, env: 'stage' });

  it('returns the refreshed profile on success', async () => {
    vi.spyOn(profileService, 'getByUserId').mockResolvedValueOnce({ id: USER, experience: [] });
    expect(await apply()).toEqual({ id: USER, experience: [] });
  });

  it('maps a refused apply to 404 / 403 / 409', async () => {
    store.applyDraft.mockResolvedValue(0);
    const cases = [
      [null, 404, undefined],
      [{ owned: false }, 403, undefined],
      [{ owned: true, applied: true }, 409, 'already_applied'],
      [{ owned: true, applied: false, not_empty: true }, 409, 'profile_not_empty'],
      [{ owned: true, applied: false, not_empty: false, status: 'failed' }, 404, undefined],
      [{ owned: true, applied: false, not_empty: false, status: 'succeeded' }, 409, 'already_applied'],
    ];
    for (const [row, status, code] of cases) {
      store.applyRefusal.mockResolvedValue(row);
      const err = await errorOf(apply());
      expect([err.status, err.code]).toEqual([status, code]);
    }
  });
});
