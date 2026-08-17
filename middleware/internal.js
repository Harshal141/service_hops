const crypto = require('crypto');

function secretsMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check that first
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Gate for endpoints the FE server calls before a session exists.
 *
 * `/auth/upsert` cannot use requireAuth — it runs during sign-in, when there is
 * no session token yet. Left open it accepted an identity straight from the
 * request body, so anyone could POST a known email and overwrite that user's
 * name and avatar, read back their internal id, or create unlimited user rows.
 */
function requireInternalSecret(req, res, next) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    console.error('[auth] INTERNAL_API_SECRET is not set — rejecting internal calls');
    return res.status(503).json({ error: 'Server not configured' });
  }

  const provided = req.headers['x-internal-secret'];
  if (typeof provided !== 'string' || !secretsMatch(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = { requireInternalSecret };
