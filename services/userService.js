const crypto = require('crypto');
const { getDb } = require('../config/db');
const { isHandle } = require('../utils/validate');

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

// Resolves the public URL identifier — `user_id` (the slug) or, for
// already-shared links, a raw UUID — to the user row. A transitional dual
// lookup so switching routing to slugs doesn't 404 any link that's already
// out in the wild.
const findByHandle = async (handle, env) => {
  const sql = getDb(env);
  const rows = await sql`
    SELECT id, user_id, name, icon, created_at
    FROM users
    WHERE (user_id = ${handle} OR id::text = ${handle}) AND status = 'active'
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

// Called on every OAuth sign-in — creates user on first login, updates name/icon on return.
// `referredBy`, if present, is only ever considered for a brand-new row (see the
// `inserted` flag below) — an existing user can never retroactively become
// "referred". referred_by is deliberately left out of the ON CONFLICT SET clause
// so a returning user's row is never touched by it.
const upsert = async (userData, env) => {
  const sql = getDb(env);
  const { name, email, icon, referredBy } = userData;
  // Random suffix, not a timestamp: the last 4 base36 digits of epoch-ms cycle
  // every ~28 minutes, and user_id is UNIQUE, so two same-named sign-ins could
  // collide and fail the whole upsert.
  const slug = (name ?? 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user';
  const handle = `${slug}-${crypto.randomUUID().slice(0, 8)}`;

  // A garbage/deleted id must never block signup — just drop it silently and
  // proceed with no referral, per the referral guards in the PRD. `referredBy`
  // comes from the `/invite/<handle>` link's slug now, not a UUID — accept
  // either, since an already-shared invite link still carries the old UUID.
  let validReferredBy = null;
  if (referredBy && isHandle(referredBy)) {
    const referrer = await sql`
      SELECT id FROM users
      WHERE (user_id = ${referredBy} OR id::text = ${referredBy}) AND status = 'active'
    `;
    if (referrer[0]) validReferredBy = referrer[0].id;
  }

  // Never RETURNING * here — the caller is the sign-in flow, which only needs the
  // id to put in the token. Returning the whole row leaked email/status.
  // `(xmax = 0) AS inserted` is the standard Postgres trick to tell an actual
  // insert apart from the ON CONFLICT DO UPDATE branch firing.
  const rows = await sql`
    INSERT INTO users (user_id, name, email, icon, referred_by)
    VALUES (${handle}, ${name}, ${email}, ${icon}, ${validReferredBy})
    ON CONFLICT (email) DO UPDATE
      SET name = EXCLUDED.name, icon = EXCLUDED.icon, updated_at = NOW()
    RETURNING id, user_id, name, icon, (xmax = 0) AS inserted
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

module.exports = { findById, findByHandle, update, remove, upsert, searchByName };
