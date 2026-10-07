// SQL integration tests for the profile editor's one-call save, against a real Postgres.
// Skipped unless TEST_DB_URL is set. Point it ONLY at a throwaway Neon branch: the tests seed
// fake users and delete them afterwards.
//
//   TEST_DB_URL=<branch connection string> npx vitest run services/profileService.db.test.js

const DB_URL = process.env.TEST_DB_URL;
// Both env slots point at the test branch so nothing here can reach a real database.
process.env.NEON_STAGE_URL = DB_URL || 'postgresql://user:pass@localhost.invalid/db';
process.env.NEON_PROD_URL = DB_URL || 'postgresql://user:pass@localhost.invalid/db';

const crypto = require('crypto');
const profileService = require('./profileService');
const { validateProfilePatch } = require('../utils/profileFields');
const { getDb } = require('../config/db');
const { ForbiddenError, ConflictError } = require('../utils/errors');

const ENV = 'stage';
const q = (text, params = []) => getDb(ENV).query(text, params);
const seededUsers = [];

/** A user with a profile and two links. */
async function newUser() {
  const tag = crypto.randomBytes(6).toString('hex');
  const [u] = await q(
    `INSERT INTO users (user_id, name, email) VALUES ($1, 'Profile Save Test', $2) RETURNING id`,
    [`ps-test-${tag}`, `ps-test-${tag}@example.invalid`]);
  seededUsers.push(u.id);
  await q(`INSERT INTO profile (id, bio) VALUES ($1, 'old bio')`, [u.id]);
  await q(
    `INSERT INTO profile_link (profile_id, type, url, sort_order)
     VALUES ($1, 'github', 'https://github.com/a', 0), ($1, 'other', 'https://a.dev', 1)`, [u.id]);
  return u.id;
}

const save = (userId, body) => profileService.savePatch(userId, validateProfilePatch(body), ENV);
const linkRows = (userId) => q(
  `SELECT id, type, url, sort_order, xmin::text AS version FROM profile_link WHERE profile_id = $1 ORDER BY sort_order`, [userId]);

const describeDb = DB_URL ? describe : describe.skip;

describeDb('profileService.savePatch against Postgres', () => {
  afterAll(async () => {
    if (seededUsers.length) await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [seededUsers]);
  });

  it('applies an add, an edit and a delete in one save, and leaves unchanged rows alone', async () => {
    const user = await newUser();
    const [github, site] = await linkRows(user);
    const before = await profileService.getByUserId(user, user, ENV);

    const saved = await save(user, {
      // the version exactly as GET serialized it: millisecond JSON vs microsecond Postgres
      updated_at: JSON.parse(JSON.stringify(before.updated_at)),
      name: 'Renamed',
      links: [
        { id: github.id, type: 'github', url: 'https://github.com/a' },   // unchanged
        { type: 'linkedin', url: 'https://www.linkedin.com/in/a' },        // added
      ],                                                                  // site: deleted
      experience: [{ company: 'Acme', role: 'Dev' }],
    });

    const after = await linkRows(user);
    expect(after.map((l) => l.url)).toEqual(['https://github.com/a', 'https://www.linkedin.com/in/a']);
    expect(after.find((l) => l.id === site.id)).toBeUndefined();
    // xmin changes on any write: the unchanged row was not rewritten
    expect(after[0].version).toBe(github.version);
    // unsent keys keep their stored values
    expect(saved).toMatchObject({ name: 'Renamed', bio: before.bio });
    expect(saved.experience).toHaveLength(1);
  });

  it('refuses the whole save, writing nothing, for a foreign id or a stale version', async () => {
    const user = await newUser();
    const other = await newUser();
    const [theirs] = await linkRows(other);
    const original = await linkRows(user);

    await expect(save(user, { bio: 'new', links: [{ id: theirs.id, type: 'other', url: 'https://x.com' }] }))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(save(user, { bio: 'new', links: [], updated_at: '2000-01-01T00:00:00.000Z' }))
      .rejects.toBeInstanceOf(ConflictError);

    expect(await linkRows(user)).toEqual(original);
    expect((await q(`SELECT bio FROM profile WHERE id = $1`, [user]))[0].bio).toBe('old bio');
  });
});

describeDb('profileService.addSkill against Postgres', () => {
  afterAll(async () => {
    if (seededUsers.length) await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [seededUsers]);
  });

  it('works for a user with no profile row yet, and a repeat add is a no-op', async () => {
    const tag = crypto.randomBytes(6).toString('hex');
    const [u] = await q(
      `INSERT INTO users (user_id, name, email) VALUES ($1, 'Skill Test', $2) RETURNING id`,
      [`sk-test-${tag}`, `sk-test-${tag}@example.invalid`]);
    seededUsers.push(u.id);
    const [skill] = await q(`SELECT id FROM skill WHERE level = 3 LIMIT 1`);

    await profileService.addSkill(u.id, skill.id, ENV);
    expect(await profileService.addSkill(u.id, skill.id, ENV)).toMatchObject({ profile_id: u.id, skill_id: skill.id });
    expect(await q(`SELECT skill_id FROM profile_skill WHERE profile_id = $1`, [u.id])).toEqual([{ skill_id: skill.id }]);
  });
});
