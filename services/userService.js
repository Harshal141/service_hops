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

module.exports = { findAll, findById, create, update, remove, upsert };
