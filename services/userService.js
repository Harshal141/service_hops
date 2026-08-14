const { getDb } = require('../config/db');

const findAll = async (env) => {
  const sql = getDb(env);
  return await sql`SELECT * FROM users`;
};

const findById = async (id, env) => {
  const sql = getDb(env);
  const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
  if (!rows.length) throw new Error('User not found');
  return rows[0];
};

const create = async (userData, env) => {
  const sql = getDb(env);
  const { name, email } = userData;
  const rows = await sql`INSERT INTO users (name, email) VALUES (${name}, ${email}) RETURNING *`;
  return rows[0];
};

const update = async (id, { name }, env) => {
  const sql = getDb(env);
  const rows = await sql`
    UPDATE users SET name = ${name}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0];
};

const remove = async (id, env) => {
  const sql = getDb(env);
  await sql`DELETE FROM users WHERE id = ${id}`;
  return true;
};

// Called on every OAuth sign-in — creates user on first login, updates name/icon on return
const upsert = async (userData, env) => {
  const sql = getDb(env);
  const { name, email, icon } = userData;
  const handle = (name ?? 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);

  const rows = await sql`
    INSERT INTO users (user_id, name, email, icon)
    VALUES (${handle}, ${name}, ${email}, ${icon})
    ON CONFLICT (email) DO UPDATE
      SET name = EXCLUDED.name, icon = EXCLUDED.icon, updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
};

// Name search from a viewer's perspective. Excludes the viewer and annotates
// each result with the existing relationship, so the caller can render the right
// action (connect / pending / respond / connected) without a query per row.
const searchByName = async (query, viewerId, env) => {
  const sql = getDb(env);
  return await sql`
    SELECT
      u.id, u.user_id, u.name, u.icon, p.title,
      EXISTS (
        SELECT 1 FROM connection c
        WHERE c.status = 'active'
          AND LEAST(c.user_a_id, c.user_b_id) = LEAST(${viewerId}, u.id)
          AND GREATEST(c.user_a_id, c.user_b_id) = GREATEST(${viewerId}, u.id)
      ) AS is_connected,
      (
        SELECT CASE WHEN cr.requester_id = ${viewerId} THEN 'outgoing' ELSE 'incoming' END
        FROM connection_request cr
        WHERE cr.status = 'pending'
          AND LEAST(cr.requester_id, cr.addressee_id) = LEAST(${viewerId}, u.id)
          AND GREATEST(cr.requester_id, cr.addressee_id) = GREATEST(${viewerId}, u.id)
        LIMIT 1
      ) AS pending_direction
    FROM users u
    LEFT JOIN profile p ON p.id = u.id
    WHERE u.name ILIKE ${'%' + query + '%'}
      AND u.status = 'active'
      AND u.id <> ${viewerId}
    ORDER BY u.name ASC
    LIMIT 20
  `;
};

module.exports = { findAll, findById, create, update, remove, upsert, searchByName };
