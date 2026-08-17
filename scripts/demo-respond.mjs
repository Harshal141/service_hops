#!/usr/bin/env node
/**
 * Respond to connection requests on behalf of a demo user.
 *
 *   node scripts/demo-respond.mjs <who> [accept|decline] [--note "..."]
 *
 * With no action it just lists what is pending; with one, it responds to every
 * pending request that user has. Every response goes through the
 * real endpoint with a real token, so this exercises exactly the code path a
 * second human would — nothing is special-cased in the backend.
 */
import { findUser, callAs, TARGET_ENV } from './lib/devSession.mjs';

const argv = process.argv.slice(2);
const noteIndex = argv.indexOf('--note');
const note = noteIndex === -1 ? null : argv[noteIndex + 1];
// drop the flag and its value; when the flag is absent there is nothing to drop
const positional = argv.filter((_, i) => noteIndex === -1 || (i !== noteIndex && i !== noteIndex + 1));

const [who, action] = positional;

if (!who) {
  console.error('usage: demo-respond.mjs <who> [accept|decline] [--note "..."]');
  process.exit(1);
}
if (action && !['accept', 'decline'].includes(action)) {
  console.error(`unknown action "${action}" — expected accept or decline`);
  process.exit(1);
}

const DEFAULT_NOTE = 'Worked together closely and would vouch for them.';

const user = await findUser(who);
console.log(`${user.name} <${user.email}>  [${TARGET_ENV}]`);

const pending = await callAs(user, 'GET', '/connection/request/pending');
if (pending.status !== 200) {
  console.error(`could not read pending requests: ${pending.status}`, pending.body);
  process.exit(1);
}

if (pending.body.length === 0) {
  console.log('  no pending requests');
  process.exit(0);
}

for (const request of pending.body) {
  console.log(`  from ${request.name}: "${request.requester_note}"`);

  if (!action) continue;

  const result = action === 'accept'
    ? await callAs(user, 'PUT', `/connection/request/${request.id}/accept`, { note: note ?? DEFAULT_NOTE })
    : await callAs(user, 'PUT', `/connection/request/${request.id}/decline`);

  const ok = result.status < 400;
  console.log(`    ${action} -> ${result.status} ${ok ? 'ok' : JSON.stringify(result.body)}`);
  if (!ok) process.exitCode = 1;
}

if (!action) console.log('\n  (pass "accept" or "decline" to respond)');
