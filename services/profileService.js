const { getDb } = require('../config/db');
const { ValidationError, ForbiddenError, NotFoundError } = require('../utils/errors');

// Child rows are always written with `WHERE id = … AND profile_id = …`, so a
// zero-row result means either "no such row" or "someone else's row". Those are
// different answers and deserve different statuses, so on the failure path only,
// ask which one it was.
const CHILD_TABLES = {
  link: 'profile_link',
  experience: 'profile_experience',
  education: 'profile_education',
};

async function rejectChildFailure(sql, kind, rowId, userId) {
  const table = CHILD_TABLES[kind];
  const rows = await sql.query(`SELECT profile_id FROM ${table} WHERE id = $1`, [rowId]);
  const row = rows[0];
  if (!row) throw new NotFoundError(`${kind} not found`);
  if (row.profile_id !== userId) throw new ForbiddenError(`That ${kind} is not yours`);
  throw new NotFoundError(`${kind} not found`);
}

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
    sql`SELECT * FROM profile_experience WHERE profile_id = ${userId} ORDER BY sort_order`,
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

const upsert = async (userId, data, env) => {
  const sql = getDb(env);
  const { bio, title, location, status, section_config } = data;

  const defaultSectionConfig = [
    { key: 'links',      visible: true },
    { key: 'about',      visible: true },
    { key: 'skills',     visible: true },
    { key: 'experience', visible: true },
    { key: 'education',  visible: true },
  ];

  const [profile] = await sql`
    INSERT INTO profile (id, bio, title, location, status, section_config)
    VALUES (${userId}, ${bio ?? null}, ${title ?? null}, ${location ?? null}, ${status ?? 'public'}, ${JSON.stringify(section_config ?? defaultSectionConfig)})
    ON CONFLICT (id) DO UPDATE
      SET bio            = COALESCE(EXCLUDED.bio,            profile.bio),
          title          = COALESCE(EXCLUDED.title,          profile.title),
          location       = COALESCE(EXCLUDED.location,       profile.location),
          status         = COALESCE(EXCLUDED.status,         profile.status),
          section_config = COALESCE(EXCLUDED.section_config, profile.section_config),
          updated_at     = NOW()
    RETURNING *
  `;
  return profile;
};

// ── Links ──────────────────────────────────────────────────

const addLink = async (userId, data, env) => {
  const sql = getDb(env);
  const { type, url, sort_order } = data;

  const [link] = await sql`
    INSERT INTO profile_link (profile_id, type, url, sort_order)
    VALUES (${userId}, ${type}, ${url}, ${sort_order ?? 0})
    RETURNING *
  `;
  return link;
};

const updateLink = async (userId, linkId, data, env) => {
  const sql = getDb(env);
  const { type, url, sort_order } = data;

  const [link] = await sql`
    UPDATE profile_link
    SET type = ${type}, url = ${url}, sort_order = ${sort_order ?? 0}
    WHERE id = ${linkId} AND profile_id = ${userId}
    RETURNING *
  `;
  if (!link) await rejectChildFailure(sql, 'link', linkId, userId);
  return link;
};

const deleteLink = async (userId, linkId, env) => {
  const sql = getDb(env);

  const [deleted] = await sql`
    DELETE FROM profile_link
    WHERE id = ${linkId} AND profile_id = ${userId}
    RETURNING id
  `;
  if (!deleted) await rejectChildFailure(sql, 'link', linkId, userId);
};

// ── Experience ─────────────────────────────────────────────

const addExperience = async (userId, data, env) => {
  const sql = getDb(env);
  const { company, role, started_at, ended_at, currently_working, description, sort_order } = data;

  const [row] = await sql`
    INSERT INTO profile_experience (profile_id, company, role, started_at, ended_at, currently_working, description, sort_order)
    VALUES (${userId}, ${company}, ${role}, ${started_at ?? null}, ${ended_at ?? null}, ${currently_working ?? false}, ${description ?? null}, ${sort_order ?? 0})
    RETURNING *
  `;
  return row;
};

const updateExperience = async (userId, expId, data, env) => {
  const sql = getDb(env);
  const { company, role, started_at, ended_at, currently_working, description, sort_order } = data;

  const [row] = await sql`
    UPDATE profile_experience
    SET company = ${company}, role = ${role}, started_at = ${started_at ?? null},
        ended_at = ${currently_working ? null : (ended_at ?? null)},
        currently_working = ${currently_working ?? false},
        description = ${description ?? null}, sort_order = ${sort_order ?? 0}
    WHERE id = ${expId} AND profile_id = ${userId}
    RETURNING *
  `;
  if (!row) await rejectChildFailure(sql, 'experience', expId, userId);
  return row;
};

const deleteExperience = async (userId, expId, env) => {
  const sql = getDb(env);

  const [deleted] = await sql`
    DELETE FROM profile_experience
    WHERE id = ${expId} AND profile_id = ${userId}
    RETURNING id
  `;
  if (!deleted) await rejectChildFailure(sql, 'experience', expId, userId);
};

// ── Education ──────────────────────────────────────────────

const addEducation = async (userId, data, env) => {
  const sql = getDb(env);
  const { institution, degree, year, sort_order } = data;

  const [row] = await sql`
    INSERT INTO profile_education (profile_id, institution, degree, year, sort_order)
    VALUES (${userId}, ${institution}, ${degree}, ${year ?? null}, ${sort_order ?? 0})
    RETURNING *
  `;
  return row;
};

const updateEducation = async (userId, eduId, data, env) => {
  const sql = getDb(env);
  const { institution, degree, year, sort_order } = data;

  const [row] = await sql`
    UPDATE profile_education
    SET institution = ${institution}, degree = ${degree}, year = ${year ?? null}, sort_order = ${sort_order ?? 0}
    WHERE id = ${eduId} AND profile_id = ${userId}
    RETURNING *
  `;
  if (!row) await rejectChildFailure(sql, 'education', eduId, userId);
  return row;
};

const deleteEducation = async (userId, eduId, env) => {
  const sql = getDb(env);

  const [deleted] = await sql`
    DELETE FROM profile_education
    WHERE id = ${eduId} AND profile_id = ${userId}
    RETURNING id
  `;
  if (!deleted) await rejectChildFailure(sql, 'education', eduId, userId);
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
  getByUserId,
  upsert,
  addLink, updateLink, deleteLink,
  addExperience, updateExperience, deleteExperience,
  addEducation, updateEducation, deleteEducation,
  addSkill, removeSkill,
  searchSkills, getDefaultSkills,
};
