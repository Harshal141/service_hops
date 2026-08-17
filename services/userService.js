const crypto = require('crypto');
const { getDb } = require('../config/db');

// Columns safe to return to any authenticated caller. `email`, `status` and
// `sub_status` are deliberately absent — a user directory must not double as an
// email harvester.
const findById = async (id, env) => {
  const sql = getDb(env);
  const rows = await sql`
    SELECT id, user_id, name, icon, created_at
    FROM users
    WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
};

const update = async (id, { name }, env) => {
  const sql = getDb(env);
  const rows = await sql`
    UPDATE users SET name = ${name}, updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING id, user_id, name, icon
  `;
  return rows[0] ?? null;
};

const remove = async (id, env) => {
  const sql = getDb(env);
  const rows = await sql`DELETE FROM users WHERE id = ${id}::uuid RETURNING id`;
  return rows.length > 0;
};

// Called on every OAuth sign-in — creates user on first login, updates name/icon on return
const upsert = async (userData, env) => {
  const sql = getDb(env);
  const { name, email, icon } = userData;
  // Random suffix, not a timestamp: the last 4 base36 digits of epoch-ms cycle
  // every ~28 minutes, and user_id is UNIQUE, so two same-named sign-ins could
  // collide and fail the whole upsert.
  const slug = (name ?? 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user';
  const handle = `${slug}-${crypto.randomUUID().slice(0, 8)}`;

  // Never RETURNING * here — the caller is the sign-in flow, which only needs the
  // id to put in the token. Returning the whole row leaked email/status.
  const rows = await sql`
    INSERT INTO users (user_id, name, email, icon)
    VALUES (${handle}, ${name}, ${email}, ${icon})
    ON CONFLICT (email) DO UPDATE
      SET name = EXCLUDED.name, icon = EXCLUDED.icon, updated_at = NOW()
    RETURNING id, user_id, name, icon
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

module.exports = { findById, update, remove, upsert, searchByName };
