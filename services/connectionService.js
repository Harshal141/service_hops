const { getDb } = require('../config/db');
const {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} = require('../utils/errors');

// A person may re-request after being declined only once this has elapsed.
// Withdrawing your own request carries no cooldown — there is no one to harass.
const DECLINE_COOLDOWN_DAYS = 7;

// Traversal queries enumerate simple paths, which grows fast with graph density.
// The walk is bounded by a server-side timeout rather than trusting maxHops.
const TRAVERSAL_TIMEOUT_MS = 3000;

/**
 * Runs one pre-built query under a statement timeout.
 *
 * `sql.transaction` is a non-interactive batch: every statement is built upfront,
 * so it cannot read a row and then write using its values. That makes it useless
 * for the accept flow, but exactly right here — SET LOCAL plus the query, both
 * known in advance.
 */
async function withTimeout(sql, query) {
  // SET takes no bind parameters, so the value has to be part of the statement
  // text. Number() makes that explicit — this is a module constant, never input.
  const setTimeout = sql.query(
    `SET LOCAL statement_timeout = ${Number(TRAVERSAL_TIMEOUT_MS)}`,
  );
  const [, rows] = await sql.transaction([setTimeout, query]);
  return rows;
}

// ── Send Request ──────────────────────────────────────────

const sendRequest = async (requesterId, addresseeId, note, env) => {
  const sql = getDb(env);

  if (requesterId === addresseeId) throw new ValidationError('Cannot connect to yourself');

  // One round trip for every precondition, so each rejection can name its own
  // reason instead of surfacing whichever constraint happened to fire.
  const [state] = await sql`
    SELECT
      (SELECT status FROM users WHERE id = ${addresseeId}::uuid) AS addressee_status,
      EXISTS (
        SELECT 1 FROM connection
        WHERE status = 'active'
          AND LEAST(user_a_id, user_b_id) = LEAST(${requesterId}::uuid, ${addresseeId}::uuid)
          AND GREATEST(user_a_id, user_b_id) = GREATEST(${requesterId}::uuid, ${addresseeId}::uuid)
      ) AS already_connected,
      (
        SELECT CASE WHEN requester_id = ${requesterId}::uuid THEN 'outgoing' ELSE 'incoming' END
        FROM connection_request
        WHERE status = 'pending'
          AND LEAST(requester_id, addressee_id) = LEAST(${requesterId}::uuid, ${addresseeId}::uuid)
          AND GREATEST(requester_id, addressee_id) = GREATEST(${requesterId}::uuid, ${addresseeId}::uuid)
        LIMIT 1
      ) AS pending_direction,
      EXISTS (
        SELECT 1 FROM connection_request
        WHERE status = 'declined'
          AND requester_id = ${requesterId}::uuid
          AND addressee_id = ${addresseeId}::uuid
          AND updated_at > NOW() - (${DECLINE_COOLDOWN_DAYS} || ' days')::interval
      ) AS recently_declined
  `;

  if (state.addressee_status === null) throw new NotFoundError('That user does not exist');
  if (state.addressee_status !== 'active') throw new ValidationError('That user is not active');
  if (state.already_connected) throw new ConflictError('Already connected');
  if (state.pending_direction === 'outgoing') throw new ConflictError('Request already sent');
  if (state.pending_direction === 'incoming') {
    throw new ConflictError('You have a pending request from this user');
  }
  if (state.recently_declined) {
    throw new ConflictError(
      `This person declined recently — you can ask again in ${DECLINE_COOLDOWN_DAYS} days`,
    );
  }

  // uq_cr_pair is the race backstop: two simultaneous sends leave one winner and
  // the loser's unique violation maps to 409.
  const [row] = await sql`
    INSERT INTO connection_request (requester_id, addressee_id, requester_note)
    VALUES (${requesterId}::uuid, ${addresseeId}::uuid, ${note})
    RETURNING *
  `;
  return row;
};

// ── Accept Request ────────────────────────────────────────

/**
 * One statement, so a connection and its request row can never disagree.
 *
 * The DELETE ... RETURNING makes the request row itself the arbiter: two
 * simultaneous accepts mean the loser deletes nothing, selects nothing, and
 * inserts nothing — it gets a clean "not found" rather than a unique-violation
 * on an operation that in fact succeeded.
 *
 * Note there is deliberately no cleanup of an older `disconnected` row for this
 * pair: uq_conn_pair is partial on status='active', so the history can coexist,
 * and deleting it would destroy both parties' original notes.
 */
const acceptRequest = async (requestId, addresseeId, note, env) => {
  const sql = getDb(env);

  const [connection] = await sql`
    WITH taken AS (
      DELETE FROM connection_request cr
      WHERE cr.id = ${requestId}::uuid
        AND cr.addressee_id = ${addresseeId}::uuid
        AND cr.status = 'pending'
        -- never resurrect a request from an account that has since been disabled
        AND EXISTS (
          SELECT 1 FROM users u WHERE u.id = cr.requester_id AND u.status = 'active'
        )
      RETURNING cr.requester_id, cr.addressee_id, cr.requester_note
    )
    INSERT INTO connection (user_a_id, user_b_id, note_by_a, note_by_b)
    SELECT t.requester_id, t.addressee_id, t.requester_note, ${note}
    FROM taken t
    RETURNING *
  `;

  if (!connection) await explainRequestFailure(sql, requestId, addresseeId, 'accept');
  return connection;
};

/**
 * Only runs when a request mutation matched no row. Turns "nothing happened"
 * into the specific reason — a missing row is 404, someone else's row is 403,
 * an already-resolved row is 409.
 */
async function explainRequestFailure(sql, requestId, userId, action) {
  const [request] = await sql`
    SELECT requester_id, addressee_id, status
    FROM connection_request
    WHERE id = ${requestId}::uuid
  `;

  if (!request) throw new NotFoundError('Request not found');

  const owner = action === 'withdraw' ? request.requester_id : request.addressee_id;
  if (owner !== userId) throw new ForbiddenError('That request is not yours');

  if (request.status !== 'pending') {
    throw new ConflictError(`Request was already ${request.status}`);
  }

  // Row is pending and ours, so the only remaining guard is the active-user check.
  throw new ConflictError('That user is no longer active');
}

// ── Decline / Withdraw ────────────────────────────────────

// Resolved rows are retained, not deleted: they are the audit trail, and the
// decline cooldown in sendRequest reads them.
const declineRequest = async (requestId, addresseeId, env) => {
  const sql = getDb(env);
  const [row] = await sql`
    UPDATE connection_request
    SET status = 'declined'
    WHERE id = ${requestId}::uuid AND addressee_id = ${addresseeId}::uuid AND status = 'pending'
    RETURNING *
  `;
  if (!row) await explainRequestFailure(sql, requestId, addresseeId, 'decline');
  return row;
};

const withdrawRequest = async (requestId, requesterId, env) => {
  const sql = getDb(env);
  const [row] = await sql`
    UPDATE connection_request
    SET status = 'withdrawn'
    WHERE id = ${requestId}::uuid AND requester_id = ${requesterId}::uuid AND status = 'pending'
    RETURNING *
  `;
  if (!row) await explainRequestFailure(sql, requestId, requesterId, 'withdraw');
  return row;
};

// ── Disconnect ────────────────────────────────────────────

const disconnect = async (connectionId, userId, env) => {
  const sql = getDb(env);

  const [row] = await sql`
    UPDATE connection
    SET status = 'disconnected', disconnected_at = NOW()
    WHERE id = ${connectionId}::uuid
      AND status = 'active'
      AND (user_a_id = ${userId}::uuid OR user_b_id = ${userId}::uuid)
    RETURNING *
  `;
  if (row) return row;

  const [existing] = await sql`
    SELECT user_a_id, user_b_id, status FROM connection WHERE id = ${connectionId}::uuid
  `;
  if (!existing) throw new NotFoundError('Connection not found');
  if (existing.user_a_id !== userId && existing.user_b_id !== userId) {
    throw new ForbiddenError('That connection is not yours');
  }
  throw new ConflictError('Already disconnected');
};

// ── Getters ───────────────────────────────────────────────

const getPending = async (userId, env) => {
  const sql = getDb(env);
  return await sql`
    SELECT cr.*, u.name, u.user_id, u.icon, p.title
    FROM connection_request cr
    JOIN users u ON u.id = cr.requester_id AND u.status = 'active'
    LEFT JOIN profile p ON p.id = u.id AND p.status <> 'private'
    WHERE cr.addressee_id = ${userId}::uuid AND cr.status = 'pending'
    ORDER BY cr.created_at DESC
  `;
};

const getSent = async (userId, env) => {
  const sql = getDb(env);
  return await sql`
    SELECT cr.*, u.name, u.user_id, u.icon, p.title
    FROM connection_request cr
    JOIN users u ON u.id = cr.addressee_id AND u.status = 'active'
    LEFT JOIN profile p ON p.id = u.id AND p.status <> 'private'
    WHERE cr.requester_id = ${userId}::uuid AND cr.status = 'pending'
    ORDER BY cr.created_at DESC
  `;
};

/**
 * Both directions in one array, each row tagged with which way it points, so the
 * requests UI needs a single call. A list endpoint returns an array, never an
 * envelope, so `direction` travels on the row.
 */
const getRequests = async (userId, env) => {
  const sql = getDb(env);
  return await sql`
    SELECT
      cr.*,
      CASE WHEN cr.requester_id = ${userId}::uuid THEN 'outgoing' ELSE 'incoming' END AS direction,
      other.id      AS other_id,
      other.name    AS other_name,
      other.user_id AS other_handle,
      other.icon    AS other_icon,
      p.title       AS other_title
    FROM connection_request cr
    JOIN users other
      ON other.id = CASE
           WHEN cr.requester_id = ${userId}::uuid THEN cr.addressee_id
           ELSE cr.requester_id
         END
     AND other.status = 'active'
    LEFT JOIN profile p ON p.id = other.id AND p.status <> 'private'
    WHERE cr.status = 'pending'
      AND (cr.requester_id = ${userId}::uuid OR cr.addressee_id = ${userId}::uuid)
    ORDER BY cr.created_at DESC
  `;
};

const getConnections = async (userId, env) => {
  const sql = getDb(env);
  return await sql`
    SELECT
      c.*,
      u.id      AS other_id,
      u.name    AS other_name,
      u.user_id AS other_user_id,
      u.icon    AS other_icon,
      p.title   AS other_title
    FROM connection c
    JOIN users u
      ON u.id = CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END
     AND u.status = 'active'
    LEFT JOIN profile p ON p.id = u.id AND p.status <> 'private'
    WHERE c.status = 'active'
      AND (c.user_a_id = ${userId}::uuid OR c.user_b_id = ${userId}::uuid)
    ORDER BY c.connected_at DESC
  `;
};

// ── Reachable (N-degree traversal) ────────────────────────

/**
 * Breadth-first walk of the connection graph via a recursive CTE.
 *
 * Returns everyone reachable within maxHops, excluding yourself and anyone you
 * are already directly connected to, each at their SHORTEST hop count and
 * annotated with the first hop from you (`via`).
 *
 * Inactive users are excluded inside the recursive join, not just on output, so
 * a disabled account cannot relay hops between two strangers.
 */
const getReachable = async (userId, maxHops, limit, env) => {
  const sql = getDb(env);

  return await withTimeout(sql, sql`
    WITH RECURSIVE walk AS (
      -- seed: your 1st-degree connections
      SELECT
        CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END AS peer_id,
        1 AS hops,
        ARRAY[${userId}::uuid] AS visited,
        CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END AS via_id
      FROM connection c
      JOIN users peer
        ON peer.id = CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END
       AND peer.status = 'active'
      WHERE c.status = 'active'
        AND (c.user_a_id = ${userId}::uuid OR c.user_b_id = ${userId}::uuid)

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
      JOIN users peer
        ON peer.id = CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
       AND peer.status = 'active'
      WHERE w.hops < ${maxHops}
        AND NOT (
          CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
          = ANY(w.visited)
        )
    )
    SELECT * FROM (
      -- via_id is in the ORDER BY so two equal-length paths resolve the same way
      -- every time; without it the "via" name flips between requests
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
      LEFT JOIN profile p ON p.id = w.peer_id AND p.status <> 'private'
      WHERE w.peer_id <> ${userId}::uuid
        -- drop anyone already a direct connection (this also drops all hops = 1)
        AND NOT EXISTS (
          SELECT 1 FROM connection dc
          WHERE dc.status = 'active'
            AND LEAST(dc.user_a_id, dc.user_b_id) = LEAST(${userId}::uuid, w.peer_id)
            AND GREATEST(dc.user_a_id, dc.user_b_id) = GREATEST(${userId}::uuid, w.peer_id)
        )
      ORDER BY w.peer_id, w.hops ASC, w.via_id ASC
    ) shortest
    ORDER BY shortest.hops ASC, shortest.name ASC
    LIMIT ${limit}
  `);
};

// ── Shortest path to one person ───────────────────────────

/**
 * Same walk as getReachable, but keeps the whole chain instead of just the first
 * hop and resolves it to people in order. Returns null when no path exists
 * within maxHops. `path[0]` is always you; the last element is the target.
 */
const getPathTo = async (userId, targetId, maxHops, env) => {
  const sql = getDb(env);

  const rows = await withTimeout(sql, sql`
    WITH RECURSIVE walk AS (
      SELECT
        CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END AS peer_id,
        1 AS hops,
        ARRAY[
          ${userId}::uuid,
          CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END
        ] AS path
      FROM connection c
      JOIN users peer
        ON peer.id = CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END
       AND peer.status = 'active'
      WHERE c.status = 'active'
        AND (c.user_a_id = ${userId}::uuid OR c.user_b_id = ${userId}::uuid)

      UNION ALL

      SELECT
        CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END,
        w.hops + 1,
        w.path || CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
      FROM walk w
      JOIN connection c
        ON c.status = 'active'
       AND (c.user_a_id = w.peer_id OR c.user_b_id = w.peer_id)
      JOIN users peer
        ON peer.id = CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
       AND peer.status = 'active'
      WHERE w.hops < ${maxHops}
        -- stop expanding a branch once it has arrived
        AND w.peer_id <> ${targetId}::uuid
        AND NOT (
          CASE WHEN c.user_a_id = w.peer_id THEN c.user_b_id ELSE c.user_a_id END
          = ANY(w.path)
        )
    ),
    best AS (
      SELECT hops, path
      FROM walk
      WHERE peer_id = ${targetId}::uuid
      -- path breaks ties so the same chain is returned every time
      ORDER BY hops ASC, path ASC
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
    LEFT JOIN profile p ON p.id = u.id AND p.status <> 'private'
    ORDER BY step.idx
  `);

  if (rows.length === 0) return null;

  return {
    hops: rows[0].hops,
    path: rows.map(({ id, user_id, name, icon, title }) => ({
      id, user_id, name, icon, title,
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
  getRequests,
  getConnections,
  getReachable,
  getPathTo,
  getConnectionBetween,
  DECLINE_COOLDOWN_DAYS,
};
