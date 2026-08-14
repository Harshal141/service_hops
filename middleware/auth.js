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

// Identity comes from a cryptographically verified token only. The old
// X-User-Id header is deliberately not honoured: it let any caller act as any
// user simply by naming their UUID.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const payload = await verifySessionToken(token);
  // `id` is the DB user id, written into the token by the FE jwt callback
  if (!payload?.id) return res.status(401).json({ error: 'Unauthorized' });

  req.userId = payload.id;
  next();
}

// For routes that are public but behave differently for the owner: populates
// req.userId when a valid token is present, and never rejects.
async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) {
    const payload = await verifySessionToken(token);
    if (payload?.id) req.userId = payload.id;
  }
  next();
}

module.exports = { requireAuth, optionalAuth, verifySessionToken };
