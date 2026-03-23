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

const update = async (id, userData, env) => {
  const sql = getDb(env);
  const { name, email } = userData;
  const rows = await sql`UPDATE users SET name = ${name}, email = ${email} WHERE id = ${id} RETURNING *`;
  return rows[0];
};

const remove = async (id, env) => {
  const sql = getDb(env);
  await sql`DELETE FROM users WHERE id = ${id}`;
  return true;
};

module.exports = { findAll, findById, create, update, remove };
