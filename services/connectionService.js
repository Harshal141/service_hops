const { getDb } = require('../config/db');

// ── Send Request ──────────────────────────────────────────

const sendRequest = async (requesterId, addresseeId, note, env) => {
  const sql = getDb(env);

  // check not self
  if (requesterId === addresseeId) throw new Error('Cannot connect to yourself');

  // check no active connection already exists
  const [existing] = await sql`
    SELECT id FROM connection
    WHERE status = 'active'
      AND LEAST(user_a_id, user_b_id) = LEAST(${requesterId}::uuid, ${addresseeId}::uuid)
      AND GREATEST(user_a_id, user_b_id) = GREATEST(${requesterId}::uuid, ${addresseeId}::uuid)
  `;
  if (existing) throw new Error('Already connected');

  // check no pending request exists between these two
  const [pendingReq] = await sql`
    SELECT id, requester_id FROM connection_request
    WHERE status = 'pending'
      AND LEAST(requester_id, addressee_id) = LEAST(${requesterId}::uuid, ${addresseeId}::uuid)
      AND GREATEST(requester_id, addressee_id) = GREATEST(${requesterId}::uuid, ${addresseeId}::uuid)
  `;
  if (pendingReq) {
    if (pendingReq.requester_id === requesterId) {
      throw new Error('Request already sent');
    }
    throw new Error('You have a pending request from this user');
  }

  // clean up old declined/withdrawn requests between this pair
  await sql`
    DELETE FROM connection_request
    WHERE status IN ('declined', 'withdrawn')
      AND LEAST(requester_id, addressee_id) = LEAST(${requesterId}::uuid, ${addresseeId}::uuid)
      AND GREATEST(requester_id, addressee_id) = GREATEST(${requesterId}::uuid, ${addresseeId}::uuid)
  `;

  const [row] = await sql`
    INSERT INTO connection_request (requester_id, addressee_id, requester_note)
    VALUES (${requesterId}, ${addresseeId}, ${note})
    RETURNING *
  `;
  return row;
};

// ── Accept Request ────────────────────────────────────────

const acceptRequest = async (requestId, addresseeId, note, env) => {
  const sql = getDb(env);

  const [request] = await sql`
    SELECT * FROM connection_request
    WHERE id = ${requestId} AND addressee_id = ${addresseeId} AND status = 'pending'
  `;
  if (!request) throw new Error('Request not found or not yours');

  // clean up old disconnected connection between this pair
  await sql`
    DELETE FROM connection
    WHERE status = 'disconnected'
      AND LEAST(user_a_id, user_b_id) = LEAST(${request.requester_id}::uuid, ${addresseeId}::uuid)
      AND GREATEST(user_a_id, user_b_id) = GREATEST(${request.requester_id}::uuid, ${addresseeId}::uuid)
  `;

  // insert into connection table (requester = user_a, addressee = user_b)
  const [connection] = await sql`
    INSERT INTO connection (user_a_id, user_b_id, note_by_a, note_by_b)
    VALUES (${request.requester_id}, ${addresseeId}, ${request.requester_note}, ${note})
    RETURNING *
  `;

  // delete the request row — it served its purpose
  await sql`
    DELETE FROM connection_request WHERE id = ${requestId}
  `;

  return connection;
};

// ── Decline Request ───────────────────────────────────────

const declineRequest = async (requestId, addresseeId, env) => {
  const sql = getDb(env);

  const [row] = await sql`
    UPDATE connection_request
    SET status = 'declined'
    WHERE id = ${requestId} AND addressee_id = ${addresseeId} AND status = 'pending'
    RETURNING *
  `;
  if (!row) throw new Error('Request not found or not yours');
  return row;
};

// ── Withdraw Request ──────────────────────────────────────

const withdrawRequest = async (requestId, requesterId, env) => {
  const sql = getDb(env);

  const [row] = await sql`
    UPDATE connection_request
    SET status = 'withdrawn'
    WHERE id = ${requestId} AND requester_id = ${requesterId} AND status = 'pending'
    RETURNING *
  `;
  if (!row) throw new Error('Request not found or not yours');
  return row;
};

// ── Disconnect ────────────────────────────────────────────

const disconnect = async (connectionId, userId, env) => {
  const sql = getDb(env);

  const [row] = await sql`
    UPDATE connection
    SET status = 'disconnected', disconnected_at = NOW()
    WHERE id = ${connectionId}
      AND status = 'active'
      AND (user_a_id = ${userId} OR user_b_id = ${userId})
    RETURNING *
  `;
  if (!row) throw new Error('Connection not found or not yours');
  return row;
};

// ── Getters ───────────────────────────────────────────────

const getPending = async (userId, env) => {
  const sql = getDb(env);

  return await sql`
    SELECT cr.*, u.name, u.user_id, u.icon
    FROM connection_request cr
    JOIN users u ON u.id = cr.requester_id
    WHERE cr.addressee_id = ${userId} AND cr.status = 'pending'
    ORDER BY cr.created_at DESC
  `;
};

const getSent = async (userId, env) => {
  const sql = getDb(env);

  return await sql`
    SELECT cr.*, u.name, u.user_id, u.icon
    FROM connection_request cr
    JOIN users u ON u.id = cr.addressee_id
    WHERE cr.requester_id = ${userId} AND cr.status = 'pending'
    ORDER BY cr.created_at DESC
  `;
};

const getConnections = async (userId, env) => {
  const sql = getDb(env);

  return await sql`
    SELECT
      c.*,
      u.id AS other_id,
      u.name AS other_name,
      u.user_id AS other_user_id,
      u.icon AS other_icon
    FROM connection c
    JOIN users u ON u.id = CASE
      WHEN c.user_a_id = ${userId} THEN c.user_b_id
      ELSE c.user_a_id
    END
    WHERE c.status = 'active'
      AND (c.user_a_id = ${userId} OR c.user_b_id = ${userId})
    ORDER BY c.connected_at DESC
  `;
};

// ── Reachable (N-degree traversal) ────────────────────────

// Breadth-first walk of the connection graph via a recursive CTE.
// Returns everyone reachable within maxHops, excluding yourself and anyone
// you're already directly connected to — each at their SHORTEST hop count,
// annotated with the first hop from you (`via`).
const getReachable = async (userId, maxHops, limit, env) => {
  const sql = getDb(env);

  return await sql`
    WITH RECURSIVE walk AS (
      -- seed: your 1st-degree connections
      SELECT
        CASE WHEN user_a_id = ${userId} THEN user_b_id ELSE user_a_id END AS peer_id,
        1 AS hops,
        ARRAY[${userId}::uuid] AS visited,
        CASE WHEN user_a_id = ${userId} THEN user_b_id ELSE user_a_id END AS via_id
      FROM connection
      WHERE status = 'active'
        AND (user_a_id = ${userId} OR user_b_id = ${userId})

      UNION ALL

      -- step out one hop, carrying the original first hop along
      SELECT
        CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END,
        w.hops + 1,
        w.visited || w.peer_id,
        w.via_id
      FROM walk w
      JOIN connection c
        ON c.status = 'active'
       AND (c.user_a_id = w.peer_id OR c.user_b_id = w.peer_id)
      WHERE w.hops < ${maxHops}
        AND NOT (
          CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
          = ANY(w.visited)
        )
    )
    SELECT * FROM (
      SELECT DISTINCT ON (w.peer_id)
        w.peer_id       AS id,
        u.user_id,
        u.name,
        u.icon,
        p.title,
        w.hops,
        w.via_id,
        via.name        AS via_name
      FROM walk w
      JOIN users u   ON u.id = w.peer_id AND u.status = 'active'
      JOIN users via ON via.id = w.via_id
      LEFT JOIN profile p ON p.id = w.peer_id
      WHERE w.peer_id <> ${userId}
        -- drop anyone already a direct connection (this also drops all hops = 1)
        AND NOT EXISTS (
          SELECT 1 FROM connection dc
          WHERE dc.status = 'active'
            AND LEAST(dc.user_a_id, dc.user_b_id) = LEAST(${userId}, w.peer_id)
            AND GREATEST(dc.user_a_id, dc.user_b_id) = GREATEST(${userId}, w.peer_id)
        )
      ORDER BY w.peer_id, w.hops ASC
    ) shortest
    ORDER BY shortest.hops ASC, shortest.name ASC
    LIMIT ${limit}
  `;
};

// ── Shortest path to one person ───────────────────────────

// Same walk as getReachable, but keeps the whole chain instead of just the first
// hop, and resolves it to people in order. Returns null when no path exists
// within maxHops. `path[0]` is always you; the last element is the target.
const getPathTo = async (userId, targetId, maxHops, env) => {
  const sql = getDb(env);

  const rows = await sql`
    WITH RECURSIVE walk AS (
      SELECT
        CASE WHEN user_a_id = ${userId} THEN user_b_id ELSE user_a_id END AS peer_id,
        1 AS hops,
        ARRAY[
          ${userId}::uuid,
          CASE WHEN user_a_id = ${userId} THEN user_b_id ELSE user_a_id END
        ] AS path
      FROM connection
      WHERE status = 'active'
        AND (user_a_id = ${userId} OR user_b_id = ${userId})

      UNION ALL

      SELECT
        CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END,
        w.hops + 1,
        w.path || CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
      FROM walk w
      JOIN connection c
        ON c.status = 'active'
       AND (c.user_a_id = w.peer_id OR c.user_b_id = w.peer_id)
      WHERE w.hops < ${maxHops}
        -- stop expanding a branch once it has arrived
        AND w.peer_id <> ${targetId}
        AND NOT (
          CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
          = ANY(w.path)
        )
    ),
    best AS (
      SELECT hops, path
      FROM walk
      WHERE peer_id = ${targetId}
      ORDER BY hops ASC
      LIMIT 1
    )
    SELECT
      b.hops,
      step.idx,
      u.id,
      u.user_id,
      u.name,
      u.icon,
      p.title
    FROM best b
    CROSS JOIN unnest(b.path) WITH ORDINALITY AS step(id, idx)
    JOIN users u ON u.id = step.id
    LEFT JOIN profile p ON p.id = u.id
    ORDER BY step.idx
  `;

  if (rows.length === 0) return null;

  return {
    hops: rows[0].hops,
    path: rows.map(({ id, user_id, name, icon, title }) => ({
      id,
      user_id,
      name,
      icon,
      title,
    })),
  };
};

const getConnectionBetween = async (userA, userB, env) => {
  const sql = getDb(env);

  const [row] = await sql`
    SELECT * FROM connection
    WHERE status = 'active'
      AND LEAST(user_a_id, user_b_id) = LEAST(${userA}::uuid, ${userB}::uuid)
      AND GREATEST(user_a_id, user_b_id) = GREATEST(${userA}::uuid, ${userB}::uuid)
  `;
  return row || null;
};

module.exports = {
  sendRequest,
  acceptRequest,
  declineRequest,
  withdrawRequest,
  disconnect,
  getPending,
  getSent,
  getConnections,
  getReachable,
  getPathTo,
  getConnectionBetween,
};
