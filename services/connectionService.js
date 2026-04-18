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
      AND LEAST(user_a_id, user_b_id) = LEAST(${requesterId}, ${addresseeId})
      AND GREATEST(user_a_id, user_b_id) = GREATEST(${requesterId}, ${addresseeId})
  `;
  if (existing) throw new Error('Already connected');

  // check no pending request exists between these two
  const [pendingReq] = await sql`
    SELECT id, requester_id FROM connection_request
    WHERE status = 'pending'
      AND LEAST(requester_id, addressee_id) = LEAST(${requesterId}, ${addresseeId})
      AND GREATEST(requester_id, addressee_id) = GREATEST(${requesterId}, ${addresseeId})
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
      AND LEAST(requester_id, addressee_id) = LEAST(${requesterId}, ${addresseeId})
      AND GREATEST(requester_id, addressee_id) = GREATEST(${requesterId}, ${addresseeId})
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
      AND LEAST(user_a_id, user_b_id) = LEAST(${request.requester_id}, ${addresseeId})
      AND GREATEST(user_a_id, user_b_id) = GREATEST(${request.requester_id}, ${addresseeId})
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

const getConnectionBetween = async (userA, userB, env) => {
  const sql = getDb(env);

  const [row] = await sql`
    SELECT * FROM connection
    WHERE status = 'active'
      AND LEAST(user_a_id, user_b_id) = LEAST(${userA}, ${userB})
      AND GREATEST(user_a_id, user_b_id) = GREATEST(${userA}, ${userB})
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
  getConnectionBetween,
};
