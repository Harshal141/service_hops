const { getDb } = require('../config/db');
const { ValidationError, ForbiddenError, NotFoundError, ConflictError } = require('../utils/errors');

// DATE columns as 'YYYY-MM-DD' text: the driver turns a DATE into a JS Date at server-local
// midnight, which serializes as the previous day when the server runs east of UTC.
const EXPERIENCE_COLUMNS = `id, profile_id, company, role,
  to_char(started_at, 'YYYY-MM-DD') AS started_at, to_char(ended_at, 'YYYY-MM-DD') AS ended_at,
  currently_working, description, sort_order, created_at`;

// ── Profile ────────────────────────────────────────────────

// `viewerId` is the authenticated caller, or null. Email is returned only to the
// owner: this endpoint is public, so selecting u.email unconditionally let any
// unauthenticated caller read any user's email address.
const getByUserId = async (userId, viewerId, env) => {
  const sql = getDb(env);
  const isOwner = Boolean(viewerId) && viewerId === userId;

  const [profile] = await sql`
    SELECT
      p.*,
      u.name,
      u.icon,
      u.user_id,
      CASE WHEN ${isOwner} THEN u.email ELSE NULL END AS email
    FROM profile p
    JOIN users u ON u.id = p.id
    WHERE p.id = ${userId}::uuid
  `;
  if (!profile) return null;

  const [links, experience, education, skills] = await Promise.all([
    sql`SELECT * FROM profile_link WHERE profile_id = ${userId} ORDER BY sort_order`,
    sql`SELECT ${sql.unsafe(EXPERIENCE_COLUMNS)} FROM profile_experience WHERE profile_id = ${userId} ORDER BY sort_order`,
    sql`SELECT * FROM profile_education WHERE profile_id = ${userId} ORDER BY sort_order`,
    sql`
      SELECT s.id, s.name, s.level, s.parent_id
      FROM profile_skill ps
      JOIN skill s ON s.id = ps.skill_id
      WHERE ps.profile_id = ${userId}
    `,
  ]);

  return { ...profile, links, experience, education, skills };
};

// ── Save (PATCH /profile) ──────────────────────────────────

// Serializes every write to one user's profile (this save and the resume import's apply), so
// two saves can't both pass the stale-write check against the same version.
const PROFILE_WRITE_LOCK_KEY = 'profile_apply';

// The list sections a save can replace. Table and column names are constants, never input, so
// building SQL from them is safe; adding a section is one entry here plus its validator.
const SECTIONS = {
  links: {
    table: 'profile_link',
    columns: { type: 'text', url: 'text', sort_order: 'smallint' },
  },
  experience: {
    table: 'profile_experience',
    columns: {
      company: 'text', role: 'text', started_at: 'date', ended_at: 'date',
      currently_working: 'boolean', description: 'text', sort_order: 'smallint',
    },
  },
  education: {
    table: 'profile_education',
    columns: { institution: 'text', degree: 'text', year: 'text', sort_order: 'smallint' },
  },
};

// $1 user id · $2 scalar fields (jsonb, only the keys being set) · $3 updated_at the client
// edited (or null) · then one jsonb param per section: its final rows, or null to leave it alone.
const SECTION_PARAM = Object.fromEntries(Object.keys(SECTIONS).map((key, i) => [key, `$${i + 4}::jsonb`]));

function sectionCtes(key) {
  const { table, columns } = SECTIONS[key];
  const param = SECTION_PARAM[key];
  const cols = Object.keys(columns);
  const recordType = ['id int', ...cols.map((c) => `${c} ${columns[c]}`)].join(', ');
  const t = cols.map((c) => `t.${c}`).join(', ');
  const i = cols.map((c) => `i.${c}`).join(', ');
  return {
    input: `in_${key} AS (SELECT * FROM jsonb_to_recordset(COALESCE(${param}, '[]')) AS x(${recordType}))`,
    // every incoming id must be one of this user's rows, or the whole save is refused
    owned: `NOT EXISTS (SELECT 1 FROM in_${key} i WHERE i.id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM ${table} t WHERE t.id = i.id AND t.profile_id = $1))`,
    writes: [
      // rows left out of a sent list are deleted; an unsent list (null) deletes nothing
      `del_${key} AS (DELETE FROM ${table} t USING gate g
         WHERE ${param} IS NOT NULL AND t.profile_id = g.user_id
           AND NOT EXISTS (SELECT 1 FROM in_${key} i WHERE i.id = t.id))`,
      // only rows whose values actually changed are rewritten
      `upd_${key} AS (UPDATE ${table} t SET (${cols.join(', ')}) = (${i})
         FROM in_${key} i, gate g
         WHERE t.id = i.id AND t.profile_id = g.user_id AND (${t}) IS DISTINCT FROM (${i}))`,
      `ins_${key} AS (INSERT INTO ${table} (profile_id, ${cols.join(', ')})
         SELECT g.user_id, ${i} FROM in_${key} i, gate g WHERE i.id IS NULL)`,
    ],
  };
}

const SECTION_SQL = Object.keys(SECTIONS).map(sectionCtes);

// One statement, gated: if the client's version is stale or any id isn't the user's, the gate
// is empty and nothing below writes. A present key in $2 sets its column (null clears it); an
// absent key keeps the stored value. The profile UPDATE always runs, so its trigger bumps
// updated_at on every save, including list-only ones, which is what the stale check relies on.
const SAVE_SQL = `
WITH
${SECTION_SQL.map((s) => s.input).join(',\n')},
gate AS (
  SELECT $1::uuid AS user_id
  WHERE NOT EXISTS (
          SELECT 1 FROM profile p
          WHERE p.id = $1 AND $3::timestamptz IS NOT NULL
            -- the client holds a millisecond JS timestamp; Postgres keeps microseconds
            AND date_trunc('milliseconds', p.updated_at) > $3::timestamptz)
    AND ${SECTION_SQL.map((s) => s.owned).join('\n    AND ')}
),
prof AS (
  UPDATE profile p SET
    bio            = CASE WHEN $2::jsonb ? 'bio'            THEN $2::jsonb->>'bio'            ELSE p.bio END,
    title          = CASE WHEN $2::jsonb ? 'title'          THEN $2::jsonb->>'title'          ELSE p.title END,
    location       = CASE WHEN $2::jsonb ? 'location'       THEN $2::jsonb->>'location'       ELSE p.location END,
    section_config = CASE WHEN $2::jsonb ? 'section_config' THEN $2::jsonb->'section_config' ELSE p.section_config END
  FROM gate g WHERE p.id = g.user_id
),
usr AS (
  UPDATE users u SET name = $2::jsonb->>'name'
  FROM gate g WHERE u.id = g.user_id AND $2::jsonb ? 'name'
),
${SECTION_SQL.flatMap((s) => s.writes).join(',\n')}
SELECT count(*)::int AS saved FROM gate`;

/** After a refused save: why. Outside the transaction, so it can race; the fallback is 404. */
async function saveRefusal(sql, userId, patch) {
  const idsOf = (key) => (patch.sections[key] ?? []).flatMap((row) => (row.id ? [row.id] : []));
  const foreign = Object.entries(SECTIONS).map(([key, { table }]) => {
    const ids = idsOf(key);
    return ids.length ? sql.query(`SELECT 1 FROM ${table} WHERE id = ANY($1::int[]) AND profile_id <> $2 LIMIT 1`, [ids, userId]) : [];
  });
  const [stale, ...owned] = await Promise.all([
    patch.updatedAt
      ? sql.query(`SELECT 1 FROM profile WHERE id = $1 AND date_trunc('milliseconds', updated_at) > $2::timestamptz`, [userId, patch.updatedAt])
      : [],
    ...foreign,
  ]);
  if (stale.length) throw new ConflictError('Your profile changed since you started editing. Reload and try again.', 'stale_profile');
  if (owned.some((rows) => rows.length)) throw new ForbiddenError('That entry is not yours');
  throw new NotFoundError('Some entries no longer exist. Reload and try again.');
}

/**
 * Applies a validated patch (see utils/profileFields validateProfilePatch) in one transaction:
 * [per-user lock, make sure the profile row exists, the gated save]. One round trip; everything
 * lands or nothing does. Returns the saved profile, same shape as GET.
 */
const savePatch = async (userId, patch, env) => {
  const sql = getDb(env);
  const results = await sql.transaction([
    sql.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2::text))`, [PROFILE_WRITE_LOCK_KEY, userId]),
    // a first save may come before any profile row exists; an empty row is harmless if refused
    sql.query(`INSERT INTO profile (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [userId]),
    sql.query(SAVE_SQL, [
      userId,
      JSON.stringify(patch.fields),
      patch.updatedAt,
      ...Object.keys(SECTIONS).map((key) => (patch.sections[key] ? JSON.stringify(patch.sections[key]) : null)),
    ]),
  ]);
  if (!results[2][0].saved) await saveRefusal(sql, userId, patch);
  return getByUserId(userId, userId, env);
};

// ── Skills ─────────────────────────────────────────────────

const addSkill = async (userId, skillId, env) => {
  const sql = getDb(env);

  // ensure only level 3 skills can be tagged
  const [skill] = await sql`SELECT level FROM skill WHERE id = ${skillId}`;
  if (!skill) throw new NotFoundError('Skill not found');
  if (skill.level !== 3) throw new ValidationError('Only level 3 skills can be tagged');

  const [row] = await sql`
    INSERT INTO profile_skill (profile_id, skill_id)
    VALUES (${userId}, ${skillId})
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  return row;
};

const removeSkill = async (userId, skillId, env) => {
  const sql = getDb(env);

  await sql`
    DELETE FROM profile_skill
    WHERE profile_id = ${userId} AND skill_id = ${skillId}
  `;
};

// ── Skill search (autocomplete) ────────────────────────────

const searchSkills = async (query, env) => {
  const sql = getDb(env);

  // seeded skills first, then user-created, both filtered by name match
  return await sql`
    SELECT id, name, level, parent_id, user_created
    FROM skill
    WHERE level = 3
      AND status = 'active'
      AND name ILIKE ${'%' + query + '%'}
    ORDER BY user_created ASC, name ASC
    LIMIT 20
  `;
};

const getDefaultSkills = async (env) => {
  const sql = getDb(env);

  // top seeded skills alphabetically — shown before the user types anything
  return await sql`
    SELECT id, name, level, parent_id, user_created
    FROM skill
    WHERE level = 3
      AND status = 'active'
      AND user_created = false
    ORDER BY name ASC
    LIMIT 15
  `;
};

module.exports = {
  PROFILE_WRITE_LOCK_KEY,
  getByUserId,
  savePatch,
  addSkill, removeSkill,
  searchSkills, getDefaultSkills,
};
