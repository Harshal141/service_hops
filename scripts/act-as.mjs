#!/usr/bin/env node
/**
 * Call any API endpoint as any user, using a real session token.
 *
 *   node scripts/act-as.mjs <who> <METHOD> <path> [jsonBody]
 *
 *   node scripts/act-as.mjs john-doe-34f6ae GET /connection/request/pending
 *   node scripts/act-as.mjs priya.sharma@demo.hops POST /connection/request \
 *     '{"addresseeId":"<uuid>","note":"why they are a strong connection"}'
 *
 * <who> is a handle, an email, or a uuid.
 */
import { findUser, callAs, BE_URL, TARGET_ENV } from './lib/devSession.mjs';

const [who, method = 'GET', path, rawBody] = process.argv.slice(2);

if (!who || !path) {
  console.error('usage: act-as.mjs <who> <METHOD> <path> [jsonBody]');
  process.exit(1);
}

const user = await findUser(who);
const body = rawBody ? JSON.parse(rawBody) : undefined;

console.log(`${method} ${path}  as ${user.name} <${user.email}>  [${TARGET_ENV} · ${BE_URL}]`);
const { status, body: response } = await callAs(user, method.toUpperCase(), path, body);
console.log(status);
console.log(JSON.stringify(response, null, 2));

process.exit(status >= 400 ? 1 : 0);
