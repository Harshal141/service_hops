/**
 * Mints a real Auth.js session token for any user, so a developer can drive the
 * API as a demo account.
 *
 * This exists because demo users cannot sign in — their email domain is not
 * real — yet accepting a connection request is inherently a second-party action.
 * Rather than teach the backend to auto-respond on their behalf (which would put
 * fake behaviour on the production code path and reintroduce "identity from
 * something other than the token"), we mint a token here and call the very same
 * endpoints a real second party would.
 *
 * Stage only, by refusal. Nothing in this directory is reachable over HTTP.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT, calculateJwkThumbprint, base64url } from 'jose';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const ENV_FILE = readFileSync(resolve(ROOT, '.env'), 'utf8');
const readEnv = (key) => {
  const match = ENV_FILE.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
};

export const TARGET_ENV = process.env.HOPS_ENV ?? 'stage';
export const BE_URL = process.env.BE_URL ?? 'http://localhost:8080';

if (TARGET_ENV !== 'stage') {
  console.error(`refusing to run against env="${TARGET_ENV}" — these scripts are stage-only`);
  process.exit(1);
}

const SALT = 'authjs.session-token';
const ENC = 'A256CBC-HS512';

const key = await hkdf('sha256', readEnv('AUTH_SECRET'), SALT,
  `Auth.js Generated Encryption Key (${SALT})`, 64);
const kid = await calculateJwkThumbprint({ kty: 'oct', k: base64url.encode(key) }, 'sha512');

const sql = neon(readEnv(`NEON_${TARGET_ENV.toUpperCase()}_URL`));

/** Resolves a handle, email, or uuid to a user row. */
export async function findUser(who) {
  const rows = await sql`
    SELECT id, user_id, name, email
    FROM users
    WHERE user_id = ${who} OR email = ${who} OR id::text = ${who}
    LIMIT 1
  `;
  if (!rows.length) throw new Error(`no user matching "${who}"`);
  return rows[0];
}

/** Read-only escape hatch for scripts that need to inspect or reset fixtures. */
export { sql };

/**
 * Low-level mint. Only the verification harness should need the odd shapes —
 * everything else wants mintFor().
 */
export async function mintRaw({ id, env = TARGET_ENV, expiresInSec = 900, omitId = false } = {}) {
  const claims = omitId ? { sub: id, env } : { id, sub: id, env };
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: 'dir', enc: ENC, kid })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
    .setJti(crypto.randomUUID())
    .encrypt(key);
}

export async function mintFor(user) {
  return mintRaw({ id: user.id });
}

/** Calls the API as `user`, exactly as that user's browser session would. */
export async function callAs(user, method, path, body) {
  const token = await mintFor(user);
  const res = await fetch(BE_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Env': TARGET_ENV,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
