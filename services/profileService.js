const { getDb } = require('../config/db');

// ── Profile ────────────────────────────────────────────────

const getByUserId = async (userId, env) => {
  const sql = getDb(env);

  const [profile] = await sql`SELECT * FROM profile WHERE id = ${userId}`;
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
  const { bio, title, location, status } = data;

  const [profile] = await sql`
    INSERT INTO profile (id, bio, title, location, status)
    VALUES (${userId}, ${bio ?? null}, ${title ?? null}, ${location ?? null}, ${status ?? 'public'})
    ON CONFLICT (id) DO UPDATE
      SET bio      = COALESCE(EXCLUDED.bio,      profile.bio),
          title    = COALESCE(EXCLUDED.title,    profile.title),
          location = COALESCE(EXCLUDED.location, profile.location),
          status   = COALESCE(EXCLUDED.status,   profile.status),
          updated_at = NOW()
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
  if (!link) throw new Error('Not found or not yours');
  return link;
};

const deleteLink = async (userId, linkId, env) => {
  const sql = getDb(env);

  const [deleted] = await sql`
    DELETE FROM profile_link
    WHERE id = ${linkId} AND profile_id = ${userId}
    RETURNING id
  `;
  if (!deleted) throw new Error('Not found or not yours');
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
  if (!row) throw new Error('Not found or not yours');
  return row;
};

const deleteExperience = async (userId, expId, env) => {
  const sql = getDb(env);

  const [deleted] = await sql`
    DELETE FROM profile_experience
    WHERE id = ${expId} AND profile_id = ${userId}
    RETURNING id
  `;
  if (!deleted) throw new Error('Not found or not yours');
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
  if (!row) throw new Error('Not found or not yours');
  return row;
};

const deleteEducation = async (userId, eduId, env) => {
  const sql = getDb(env);

  const [deleted] = await sql`
    DELETE FROM profile_education
    WHERE id = ${eduId} AND profile_id = ${userId}
    RETURNING id
  `;
  if (!deleted) throw new Error('Not found or not yours');
};

// ── Skills ─────────────────────────────────────────────────

const addSkill = async (userId, skillId, env) => {
  const sql = getDb(env);

  // ensure only level 3 skills can be tagged
  const [skill] = await sql`SELECT level FROM skill WHERE id = ${skillId}`;
  if (!skill) throw new Error('Skill not found');
  if (skill.level !== 3) throw new Error('Only level 3 skills can be tagged');

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

module.exports = {
  getByUserId,
  upsert,
  addLink, updateLink, deleteLink,
  addExperience, updateExperience, deleteExperience,
  addEducation, updateEducation, deleteEducation,
  addSkill, removeSkill,
  searchSkills,
};
