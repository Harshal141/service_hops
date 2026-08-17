const { hkdf } = require('@panva/hkdf');
const { jwtDecrypt } = require('jose');

// Auth.js encrypts its session JWT (JWE, dir + A256CBC-HS512) with a key derived
// from AUTH_SECRET salted with the *session cookie name*. That name differs
// between http and https deployments, so both are tried.
const COOKIE_SALTS = ['authjs.session-token', '__Secure-authjs.session-token'];
const ENC = 'A256CBC-HS512';
const KEY_BYTES = 64; // required length for A256CBC-HS512

if (!process.env.AUTH_SECRET) {
  console.error('[auth] AUTH_SECRET is not set — every authenticated request will be rejected');
}

const keyCache = new Map();

async function encryptionKeyFor(salt) {
  if (!keyCache.has(salt)) {
    const key = await hkdf(
      'sha256',
      process.env.AUTH_SECRET,
      salt,
      `Auth.js Generated Encryption Key (${salt})`,
      KEY_BYTES,
    );
    keyCache.set(salt, key);
  }
  return keyCache.get(salt);
}

async function verifySessionToken(token) {
  if (!process.env.AUTH_SECRET) return null;

  for (const salt of COOKIE_SALTS) {
    try {
      const { payload } = await jwtDecrypt(token, await encryptionKeyFor(salt), {
        clockTolerance: 15,
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: [ENC],
      });
      return payload;
    } catch {
      // wrong salt, expired, or forged — fall through and try the next salt
    }
  }
  return null;
}

const bearerFrom = (req) => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

// Which database this token may reach. A token carrying no env claim is treated
// as stage, so an older token can never be used to select prod.
const tokenEnv = (payload) => (payload.env === 'prod' ? 'prod' : 'stage');

// Postgres compares uuids case-insensitively but JS `===` does not, so an
// uppercased uuid could slip past self-comparison checks. Canonicalise once,
// here, and every downstream comparison is safe.
const canonicalId = (id) => (typeof id === 'string' ? id.toLowerCase() : id);

// Identity comes from a cryptographically verified token only. The old
// X-User-Id header is deliberately not honoured: it let any caller act as any
// user simply by naming their UUID.
async function requireAuth(req, res, next) {
  const token = bearerFrom(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const payload = await verifySessionToken(token);
  // `id` is the DB user id, written into the token by the FE jwt callback
  if (!payload?.id) return res.status(401).json({ error: 'Unauthorized' });

  // X-Env selects the database, so without this a stage session could send
  // `X-Env: prod` and read production data.
  if (tokenEnv(payload) !== req.env) {
    return res.status(403).json({ error: 'Token is not valid for this environment' });
  }

  req.userId = canonicalId(payload.id);
  next();
}

// For routes that are public but behave differently for the owner: populates
// req.userId when a valid token is present, and never rejects.
async function optionalAuth(req, _res, next) {
  const token = bearerFrom(req);
  if (token) {
    const payload = await verifySessionToken(token);
    if (payload?.id && tokenEnv(payload) === req.env) {
      req.userId = canonicalId(payload.id);
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth, verifySessionToken, canonicalId };
