// SQL integration tests for the resume-import store, against a real Postgres that has v15 + v16.
// Skipped unless RESUME_IMPORT_DB_URL is set. Point it ONLY at a throwaway Neon branch: the
// tests seed fake users (and delete them afterwards) and take the global import slots.
//
//   RESUME_IMPORT_DB_URL=<branch connection string> npx vitest run services/aiEnrichmentService.db.test.js

const DB_URL = process.env.RESUME_IMPORT_DB_URL;
// Both env slots point at the test branch so nothing here can reach a real database.
process.env.NEON_STAGE_URL = DB_URL || 'postgresql://user:pass@localhost.invalid/db';
process.env.NEON_PROD_URL = DB_URL || 'postgresql://user:pass@localhost.invalid/db';

const crypto = require('crypto');
const store = require('./aiEnrichmentService');
const { getDb } = require('../config/db');
const { AI } = require('../config/ai');

const ENV = 'stage';
const sql = getDb(ENV);
const q = (text, params = []) => sql.query(text, params);

const seededUsers = [];
const hash = () => crypto.randomBytes(32).toString('hex');
const plan = { provider: 'gemini', model: 'test-model' };

async function newUser() {
  const tag = crypto.randomBytes(6).toString('hex');
  const [u] = await q(
    `INSERT INTO users (user_id, name, email) VALUES ($1, 'Resume Import Test', $2) RETURNING id`,
    [`ri-test-${tag}`, `ri-test-${tag}@example.invalid`]);
  seededUsers.push(u.id);
  return u.id;
}

/** An ai_enrichment row in a given state. `startedAgo` in seconds. */
async function enrichment(userId, { status = 'queued', startedAgo = null, result = null, inputHash = hash() } = {}) {
  const [r] = await q(
    `INSERT INTO ai_enrichment (user_id, kind, input_hash, pipeline_version, status, result, started_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
             CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $7::int) END)
     RETURNING id`,
    [userId, AI.KIND, inputHash, AI.PIPELINE_VERSION, status, result && JSON.stringify(result), startedAgo]);
  return r.id;
}

/** An ai_enrichment_call row created at an explicit SQL timestamp expression. */
async function seedCall(enrichmentId, userId, { provider = 'gemini', status = 'succeeded', at = 'NOW()', tokens = [null, null, null] } = {}) {
  await q(
    `INSERT INTO ai_enrichment_call
       (enrichment_id, user_id, step, attempt, provider, model, prompt_version, input, status,
        tokens_in, tokens_out, tokens_thinking, created_at)
     VALUES ($1, $2, $3, 1, $4, 'test-model', $5, '{}'::jsonb, $6, $7, $8, $9, ${at})`,
    [enrichmentId, userId, AI.STEP, provider, AI.PIPELINE_VERSION, status, ...tokens]);
}

const freshProcessingCount = async () => (await q(
  `SELECT count(*)::int AS n FROM ai_enrichment
   WHERE status = 'processing' AND started_at > NOW() - make_interval(secs => $1)`, [AI.STALE_SECONDS]))[0].n;

// Seeded 'processing' rows hold global slots; release them so later tests can claim.
const releaseSlots = () => q(
  `UPDATE ai_enrichment SET status = 'failed' WHERE status = 'processing' AND user_id = ANY($1::uuid[])`, [seededUsers]);

const describeDb = DB_URL ? describe : describe.skip;

describeDb('aiEnrichmentService against Postgres', () => {
  afterAll(async () => {
    if (seededUsers.length) await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [seededUsers]);
  });
  afterEach(releaseSlots);

  describe('claim, run token and finishRun', () => {
    it('round-trips the run token through a compare-and-set finish, and closes pending calls', async () => {
      const user = await newUser();
      const id = await store.upsertEnrichment(ENV, user, hash());
      const claim = await store.claimSlot(ENV, { id, userId: user });
      expect(claim.id).toBe(id);
      expect(claim.run_token).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\+00$/);

      const recorded = await store.insertCall(ENV, { enrichmentId: id, userId: user, attempt: 1, plan, input: { a: 1 } });
      const orphan = await store.insertCall(ENV, { enrichmentId: id, userId: user, attempt: 2, plan, input: { a: 2 } });
      await store.recordAttempt(ENV, recorded, {
        ok: true, model: 'm2', raw: '{}', parsed: { is_resume: true }, finish_reason: 'STOP',
        error_code: null, error_message: null, http_status: 200, latency_ms: 12, usage: { in: 10, out: 5, thinking: 1 },
      });

      // a wrong token (another run's) finishes nothing
      expect(await store.finishRun(ENV, { enrichmentId: id, runToken: '2001-01-01 00:00:00+00', status: 'failed', callIds: [] })).toBe(0);

      const result = { draft: { skill_names: ['Go'] }, warnings: [] };
      expect(await store.finishRun(ENV, { enrichmentId: id, runToken: claim.run_token, status: 'succeeded', result, callIds: [recorded, orphan] })).toBe(1);
      // finished once: the same token no longer matches a processing row
      expect(await store.finishRun(ENV, { enrichmentId: id, runToken: claim.run_token, status: 'failed', callIds: [] })).toBe(0);

      const [row] = await q(`SELECT status, result, attempt_count, finished_at IS NOT NULL AS done FROM ai_enrichment WHERE id = $1`, [id]);
      expect(row).toMatchObject({ status: 'succeeded', result, attempt_count: 2, done: true });
      const calls = await q(`SELECT id, status, error_code, model, tokens_in FROM ai_enrichment_call WHERE enrichment_id = $1 ORDER BY id`, [id]);
      expect(calls).toEqual([
        { id: recorded, status: 'succeeded', error_code: null, model: 'm2', tokens_in: 10 },
        { id: orphan, status: 'failed', error_code: 'internal', model: 'test-model', tokens_in: null },
      ]);
    });

    it('never re-claims a succeeded row, and says why', async () => {
      const user = await newUser();
      const id = await enrichment(user, { status: 'succeeded', result: { draft: {} } });
      expect(await store.claimSlot(ENV, { id, userId: user })).toBeNull();
      expect((await store.claimRefusalReason(ENV, { id, userId: user })).reason).toBe('succeeded');
    });

    it('per user: one live run at a time; a stale run does not count', async () => {
      const user = await newUser();
      await enrichment(user, { status: 'processing', startedAgo: 5 });
      const id = await enrichment(user);
      expect(await store.claimSlot(ENV, { id, userId: user })).toBeNull();
      expect((await store.claimRefusalReason(ENV, { id, userId: user })).reason).toBe('already_processing');

      const other = await newUser();
      await enrichment(other, { status: 'processing', startedAgo: AI.STALE_SECONDS + 10 });
      const otherId = await enrichment(other);
      expect(await store.claimSlot(ENV, { id: otherId, userId: other })).not.toBeNull();
    });

    it('global: at most MAX_CONCURRENT fresh runs', async () => {
      const already = await freshProcessingCount();
      for (let i = already; i < AI.MAX_CONCURRENT; i++) {
        await enrichment(await newUser(), { status: 'processing', startedAgo: 1 });
      }
      const user = await newUser();
      const id = await enrichment(user);
      expect(await store.claimSlot(ENV, { id, userId: user })).toBeNull();
      expect((await store.claimRefusalReason(ENV, { id, userId: user })).reason).toBe('busy');

      await releaseSlots();
      if (already === 0) expect(await store.claimSlot(ENV, { id, userId: user })).not.toBeNull();
    });

    it('parallel claims never exceed the global cap', async () => {
      const already = await freshProcessingCount();
      const rows = [];
      for (let i = 0; i < AI.MAX_CONCURRENT + 3; i++) {
        const user = await newUser();
        rows.push({ id: await enrichment(user), userId: user });
      }
      const claims = await Promise.all(rows.map((r) => store.claimSlot(ENV, r)));
      expect(claims.filter(Boolean).length).toBe(Math.max(0, AI.MAX_CONCURRENT - already));
    });

    it('daily cap: refused at USER_DAILY_CALLS, Retry-After when enough calls leave the 24h window', async () => {
      const user = await newUser();
      const seedId = await enrichment(user, { status: 'failed' });
      await seedCall(seedId, user, { at: `NOW() - INTERVAL '23 hours'` });
      await seedCall(seedId, user, { at: `NOW() - INTERVAL '22 hours'` });
      await seedCall(seedId, user, { at: `NOW() - INTERVAL '25 hours'` }); // outside the window
      for (let i = 2; i < AI.USER_DAILY_CALLS; i++) await seedCall(seedId, user, { status: 'pending', at: `NOW() - INTERVAL '1 hour'` });

      const id = await enrichment(user);
      expect(await store.claimSlot(ENV, { id, userId: user })).toBeNull();
      let r = await store.claimRefusalReason(ENV, { id, userId: user });
      expect(r.reason).toBe('daily_cap');
      expect(Math.abs(r.daily_cap_retry_after - 3600)).toBeLessThanOrEqual(5); // the -23h call

      // over the cap by one: two calls must age out, so it's the second-oldest
      await seedCall(seedId, user, { at: 'NOW()' });
      r = await store.claimRefusalReason(ENV, { id, userId: user });
      expect(Math.abs(r.daily_cap_retry_after - 7200)).toBeLessThanOrEqual(5);
    });
  });

  describe('caches and uploads', () => {
    it('copies another user\'s succeeded result, but never over a live run', async () => {
      const h = hash();
      const source = await newUser();
      const sourceId = await enrichment(source, { status: 'succeeded', result: { draft: { full_name: 'Shared' } }, inputHash: h });

      const copier = await newUser();
      const copied = await store.copyCrossUserResult(ENV, copier, h);
      expect(copied.result).toEqual({ draft: { full_name: 'Shared' } });
      const [row] = await q(`SELECT user_id, status, cache_source_id FROM ai_enrichment WHERE id = $1`, [copied.id]);
      expect(row).toEqual({ user_id: copier, status: 'succeeded', cache_source_id: sourceId });

      const busyUser = await newUser();
      const liveId = await enrichment(busyUser, { status: 'processing', startedAgo: 1, inputHash: h });
      expect(await store.copyCrossUserResult(ENV, busyUser, h)).toBeNull();
      expect((await q(`SELECT status FROM ai_enrichment WHERE id = $1`, [liveId]))[0].status).toBe('processing');

      expect(await store.copyCrossUserResult(ENV, await newUser(), hash())).toBeNull();
      expect((await store.findOwnEnrichment(ENV, copier, h))).toMatchObject({ id: copied.id, status: 'succeeded', fresh: false });
    });

    it('a re-upload of the same bytes refreshes the stored text', async () => {
      const user = await newUser();
      const sha = hash();
      const id = await store.upsertEnrichment(ENV, user, sha);
      const base = { enrichmentId: id, userId: user, sha256: sha, sizeBytes: 100 };
      await store.attachUpload(ENV, { ...base, fileName: 'a.pdf', pageCount: 1, text: 'old text' });
      await store.attachUpload(ENV, { ...base, fileName: 'b.pdf', pageCount: 2, text: 'new text' });
      const uploads = await q(`SELECT file_name, page_count, extracted_text FROM resume_upload WHERE user_id = $1`, [user]);
      expect(uploads).toEqual([{ file_name: 'b.pdf', page_count: 2, extracted_text: 'new text' }]);
      const [e] = await q(`SELECT upload_id IS NOT NULL AS linked FROM ai_enrichment WHERE id = $1`, [id]);
      expect(e.linked).toBe(true);
    });
  });

  describe('budgets', () => {
    it('counts Gemini calls since midnight Pacific and Groq tokens since midnight UTC, pending at worst case', async () => {
      const user = await newUser();
      const id = await enrichment(user, { status: 'failed' });
      const before = await store.readBudgets(ENV);

      const pacificStart = `(date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles')`;
      const utcStart = `(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
      await seedCall(id, user, { provider: 'gemini', at: `${pacificStart} + INTERVAL '1 second'` });
      await seedCall(id, user, { provider: 'gemini', at: `${pacificStart} - INTERVAL '1 second'` });
      await seedCall(id, user, { provider: 'groq', status: 'pending', at: `${utcStart} + INTERVAL '1 second'` });
      await seedCall(id, user, { provider: 'groq', tokens: [100, 50, 20] });
      await seedCall(id, user, { provider: 'groq', tokens: [1000, 0, 0], at: `${utcStart} - INTERVAL '1 second'` });

      const after = await store.readBudgets(ENV);
      expect(after.gemini_calls - before.gemini_calls).toBe(1);
      expect(after.groq_tokens - before.groq_tokens).toBe(AI.GROQ_PENDING_CALL_TOKENS + 170);
    });

    it('reports seconds until each provider\'s next midnight', async () => {
      const { gemini_reset_secs: g, groq_reset_secs: u } = await store.readBudgets(ENV);
      const secondsPastMidnight = (secs, timeZone) => {
        const at = new Date(Date.now() + secs * 1000);
        const [h, m, s] = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
          .format(at).split(':').map(Number);
        const t = h * 3600 + m * 60 + s;
        return Math.min(t, 86400 - t); // distance to the nearest midnight
      };
      for (const [secs, tz] of [[g, 'America/Los_Angeles'], [u, 'UTC']]) {
        expect(secs).toBeGreaterThan(0);
        expect(secs).toBeLessThanOrEqual(25 * 3600);
        expect(secondsPastMidnight(secs, tz)).toBeLessThanOrEqual(60); // local vs DB clock skew
      }
    });
  });

  describe('apply', () => {
    const skillIds = async () => {
      const [ok] = await q(`SELECT id FROM skill WHERE level = 3 AND status = 'active' ORDER BY id LIMIT 1`);
      const [notLeaf] = await q(`SELECT id FROM skill WHERE level <> 3 ORDER BY id LIMIT 1`);
      return { ok: ok.id, notLeaf: notLeaf.id };
    };
    const payload = (overrides = {}) => ({
      name: 'Applied Name', title: 'Engineer', bio: 'Bio', location: 'Pune',
      links: [{ type: 'github', url: 'https://github.com/ri-test', sort_order: 0 }],
      experience: [{ company: 'Acme', role: 'Dev', started_at: '2021-03-01', ended_at: null, currently_working: true, description: 'Did things', sort_order: 0 }],
      education: [{ institution: 'Example Institute', degree: null, year: '2015-2019', sort_order: 0 }],
      skillIds: [],
      ...overrides,
    });
    const counts = async (user) => (await q(
      `SELECT (SELECT count(*)::int FROM profile WHERE id = $1) AS profile,
              (SELECT count(*)::int FROM profile_link WHERE profile_id = $1) AS links,
              (SELECT count(*)::int FROM profile_experience WHERE profile_id = $1) AS experience,
              (SELECT count(*)::int FROM profile_education WHERE profile_id = $1) AS education,
              (SELECT count(*)::int FROM profile_skill WHERE profile_id = $1) AS skills`, [user]))[0];

    it('applies everything into a user with no profile row, keeping only level-3 active skills', async () => {
      const { ok, notLeaf } = await skillIds();
      const user = await newUser();
      const id = await enrichment(user, { status: 'succeeded', result: { draft: {} } });

      expect(await store.applyDraft(ENV, { id, userId: user, payload: payload({ skillIds: [ok, notLeaf] }) })).toBe(1);
      expect(await counts(user)).toEqual({ profile: 1, links: 1, experience: 1, education: 1, skills: 1 });
      const [skill] = await q(`SELECT skill_id FROM profile_skill WHERE profile_id = $1`, [user]);
      expect(skill.skill_id).toBe(ok);
      const [u] = await q(`SELECT name FROM users WHERE id = $1`, [user]);
      expect(u.name).toBe('Applied Name');

      // a second apply is refused, and the refusal read says why
      expect(await store.applyDraft(ENV, { id, userId: user, payload: payload() })).toBe(0);
      expect(await store.applyRefusal(ENV, { id, userId: user })).toMatchObject({ owned: true, applied: true, not_empty: true });
    });

    it('rolls back every write when one row is bad', async () => {
      const user = await newUser();
      const id = await enrichment(user, { status: 'succeeded', result: { draft: {} } });
      const bad = payload({ experience: [{ company: 'Acme', role: 'Dev', started_at: '2021-02-30', ended_at: null, currently_working: false, description: null, sort_order: 0 }] });
      await expect(store.applyDraft(ENV, { id, userId: user, payload: bad })).rejects.toThrow();
      expect(await counts(user)).toEqual({ profile: 0, links: 0, experience: 0, education: 0, skills: 0 });
      const [row] = await q(`SELECT applied_at FROM ai_enrichment WHERE id = $1`, [id]);
      expect(row.applied_at).toBeNull();
    });

    it('skips links the profile already has and appends the rest after them', async () => {
      const user = await newUser();
      await q(`INSERT INTO profile (id) VALUES ($1)`, [user]);
      await q(`INSERT INTO profile_link (profile_id, type, url, sort_order) VALUES ($1, 'github', 'https://github.com/dup', 0)`, [user]);
      const id = await enrichment(user, { status: 'succeeded', result: { draft: {} } });

      const links = [
        { type: 'github', url: 'https://github.com/dup', sort_order: 0 },
        { type: 'portfolio', url: 'https://ri-test.example.dev', sort_order: 1 },
      ];
      expect(await store.applyDraft(ENV, { id, userId: user, payload: payload({ links }) })).toBe(1);
      const rows = await q(`SELECT url, sort_order FROM profile_link WHERE profile_id = $1 ORDER BY sort_order, url`, [user]);
      expect(rows).toEqual([
        { url: 'https://github.com/dup', sort_order: 0 },
        { url: 'https://ri-test.example.dev', sort_order: 2 },
      ]);
    });

    it('refuses someone else\'s import, and one that has not succeeded', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const id = await enrichment(owner, { status: 'succeeded', result: { draft: {} } });
      expect(await store.applyDraft(ENV, { id, userId: stranger, payload: payload() })).toBe(0);
      expect(await store.applyRefusal(ENV, { id, userId: stranger })).toMatchObject({ owned: false });

      const failedId = await enrichment(owner, { status: 'failed' });
      expect(await store.applyDraft(ENV, { id: failedId, userId: owner, payload: payload() })).toBe(0);
      expect(await store.applyRefusal(ENV, { id: failedId, userId: owner })).toMatchObject({ owned: true, status: 'failed', applied: false });
    });
  });
});
