#!/usr/bin/env node
/**
 * Edge-case harness for the connection feature. Drives the live API with real
 * session tokens and asserts on the EXACT status and error message, not just the
 * status class — an earlier version of this file passed several checks while the
 * real failure was `invalid input syntax for type uuid`, which is precisely how
 * an edge case escapes.
 *
 *   node scripts/verify-connections.mjs
 *
 * Resets the fixture graph first, so it is re-runnable. Stage only.
 */
import { sql, findUser, callAs, mintRaw, TARGET_ENV, BE_URL } from './lib/devSession.mjs';

// ── Reporting ─────────────────────────────────────────────

let passed = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
  } else {
    failures.push(`${label}${detail ? `  — got ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  — got ${detail}` : ''}`);
  }
}

/** Asserts an exact status and, when given, an exact error message. */
function expect(label, result, status, error) {
  const statusOk = result.status === status;
  const errorOk = error === undefined || result.body?.error === error;
  ok(label, statusOk && errorOk, `${result.status} ${JSON.stringify(result.body?.error ?? result.body)?.slice(0, 90)}`);
}

const section = (name) => console.log(`\n── ${name}`);

// ── Actors ────────────────────────────────────────────────

/**
 * The harness owns its own throwaway users and NEVER touches the real account or
 * the demo cohort you interact with in the app.
 *
 * This matters: reset() deletes every edge between its actors. An earlier version
 * ran against the real account and the demo users, so running the harness deleted
 * connections that had been accepted through the UI and overwrote their notes.
 *
 * The `.harness@demo.hops` suffix keeps them inside the '%@demo.hops' marker, so
 * v12_remove_demo_data.sql still removes them at go-live.
 */
const FIXTURES = [
  ['self', 'QA Self'],
  ['ana', 'QA Ana'],
  ['ben', 'QA Ben'],
  ['cleo', 'QA Cleo'],
  ['dev', 'QA Dev'],
  ['eve', 'QA Eve'],
];

async function ensureFixture(slug, name) {
  const email = `qa-${slug}.harness@demo.hops`;
  await sql`
    INSERT INTO users (user_id, name, email, status)
    VALUES (${`qa-${slug}-harness`}, ${name}, ${email}, 'active')
    ON CONFLICT (email) DO NOTHING
  `;
  await sql`
    INSERT INTO profile (id, title, status)
    SELECT id, 'QA Fixture', 'public' FROM users WHERE email = ${email}
    ON CONFLICT (id) DO NOTHING
  `;
  return findUser(email);
}

const [HP, PRIYA, JORDAN, ELENA, MARCUS, JOHN] = await Promise.all(
  FIXTURES.map(([slug, name]) => ensureFixture(slug, name)),
);

// Refuse to run if the actor set ever drifts back onto real data.
for (const actor of [HP, PRIYA, JORDAN, ELENA, MARCUS, JOHN]) {
  if (!actor.email.endsWith('.harness@demo.hops')) {
    console.error(`refusing to run: ${actor.email} is not a harness fixture`);
    process.exit(1);
  }
}

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

// ── Fixture reset ─────────────────────────────────────────

// Rebuilt exactly each run. Safe because these are harness-only users, and
// necessary because retained declined rows would otherwise leave a live cooldown
// behind and make the second run fail.
const BASELINE = [
  [HP, PRIYA], [PRIYA, JORDAN], [PRIYA, MARCUS],
  [JORDAN, ELENA], [MARCUS, ELENA], [JORDAN, JOHN],
];

async function reset() {
  const ids = [HP, PRIYA, JORDAN, ELENA, MARCUS, JOHN].map((u) => u.id);
  await sql`DELETE FROM connection_request WHERE requester_id = ANY(${ids}::uuid[]) OR addressee_id = ANY(${ids}::uuid[])`;
  await sql`DELETE FROM connection WHERE user_a_id = ANY(${ids}::uuid[]) OR user_b_id = ANY(${ids}::uuid[])`;
  for (const [a, b] of BASELINE) {
    await sql`
      INSERT INTO connection (user_a_id, user_b_id, note_by_a, note_by_b)
      VALUES (${a.id}::uuid, ${b.id}::uuid, 'seeded fixture', 'seeded fixture')
    `;
  }
  console.log(`reset: ${BASELINE.length} edges between QA fixtures only  [${TARGET_ENV} · ${BE_URL}]`);
}

const send = (from, to, note = 'A genuinely strong connection.') =>
  callAs(from, 'POST', '/connection/request', { addresseeId: to.id, note });
const pendingFor = async (user) => (await callAs(user, 'GET', '/connection/request/pending')).body;
const sentFor = async (user) => (await callAs(user, 'GET', '/connection/request/sent')).body;

await reset();

// ── 1. Happy path ─────────────────────────────────────────

section('1. happy path: send -> accept -> graph reshapes -> disconnect -> reverts');
{
  const before = (await callAs(HP, 'GET', '/connection/reachable?maxHops=3')).body;
  ok('baseline: hp reaches 4 people', before.length === 4,
    before.map((r) => `${r.name.split(' ')[0]}@${r.hops}`).join(','));

  const created = await send(HP, JOHN, 'You rebuilt the platform my team deploys on.');
  expect('send -> 201', created, 201);
  const requestId = created.body.id;

  // the joined title belongs to the *requester* (hp), whose profile has none set
  const johnsPending = await pendingFor(JOHN);
  ok('John sees it, with the requester joined',
    johnsPending.length === 1 && johnsPending[0].name === HP.name && 'title' in johnsPending[0],
    JSON.stringify(johnsPending.map((r) => [r.name, r.title])));

  // a requester who does have a title proves the join carries it through
  const fromPriya = await send(PRIYA, JOHN, 'Long-time collaborator.');
  const withTitle = (await pendingFor(JOHN)).find((r) => r.requester_id === PRIYA.id);
  ok('a titled requester surfaces their title', withTitle?.title === 'QA Fixture', withTitle?.title);
  await callAs(PRIYA, 'PUT', `/connection/request/${fromPriya.body.id}/withdraw`);

  const accepted = await callAs(JOHN, 'PUT', `/connection/request/${requestId}/accept`, { note: 'Glad to.' });
  expect('accept -> 200', accepted, 200);
  const connectionId = accepted.body.id;

  ok('request row is gone', (await pendingFor(JOHN)).length === 0);

  const after = (await callAs(HP, 'GET', '/connection/reachable?maxHops=3')).body;
  ok('John left the reachable set (now direct)', !after.some((r) => r.id === JOHN.id),
    after.map((r) => r.name.split(' ')[0]).join(','));

  const list = (await callAs(HP, 'GET', '/connection/list')).body;
  ok('hp has 2 direct connections', list.length === 2, list.map((c) => c.other_name).join(' + '));
  ok('connection rows carry other_id and other_title',
    list.every((c) => c.other_id && 'other_title' in c));

  const gone = await callAs(HP, 'PUT', `/connection/${connectionId}/disconnect`);
  expect('disconnect -> 200', gone, 200);
  ok('back to 1 direct connection', (await callAs(HP, 'GET', '/connection/list')).body.length === 1);

  const reverted = (await callAs(HP, 'GET', '/connection/reachable?maxHops=3')).body;
  ok('reachable reverts to 4', reverted.length === 4, `${reverted.length}`);

  // disconnect history is retained rather than deleted, so the notes survive
  const [history] = await sql`SELECT status, note_by_a, note_by_b FROM connection WHERE id = ${connectionId}::uuid`;
  ok('disconnected row retained with both notes',
    history?.status === 'disconnected' && history.note_by_a && history.note_by_b,
    JSON.stringify(history?.status));

  // and a fresh request for the same pair still works afterwards
  const again = await send(HP, JOHN, 'Reconnecting after a disconnect.');
  expect('re-request after disconnect -> 201', again, 201);
  await callAs(JOHN, 'PUT', `/connection/request/${again.body.id}/accept`, { note: 'Again, sure.' });
  ok('reconnect succeeds despite the disconnected row',
    (await callAs(HP, 'GET', '/connection/list')).body.length === 2);
  await callAs(HP, 'PUT', `/connection/${(await callAs(HP, 'GET', '/connection/list')).body.find((c) => c.other_id === JOHN.id).id}/disconnect`);
}

// ── 2. Duplicate and state transitions ────────────────────

section('2. duplicate and state transitions');
await reset();
{
  const first = await send(HP, JOHN);
  expect('first send -> 201', first, 201);

  expect('duplicate send -> 409', await send(HP, JOHN), 409, 'Request already sent');
  expect('reverse send while pending -> 409', await send(JOHN, HP), 409,
    'You have a pending request from this user');

  expect('send to an existing connection -> 409', await send(HP, PRIYA), 409, 'Already connected');

  // double accept: the DELETE...RETURNING makes the request row the arbiter, so
  // the loser gets a clean not-found rather than a unique-violation
  const id = first.body.id;
  expect('accept -> 200', await callAs(JOHN, 'PUT', `/connection/request/${id}/accept`, { note: 'ok' }), 200);
  expect('second accept -> 404', await callAs(JOHN, 'PUT', `/connection/request/${id}/accept`, { note: 'ok' }),
    404, 'Request not found');

  const conn = (await callAs(HP, 'GET', '/connection/list')).body.find((c) => c.other_id === JOHN.id);
  expect('disconnect -> 200', await callAs(HP, 'PUT', `/connection/${conn.id}/disconnect`), 200);
  expect('second disconnect -> 409', await callAs(HP, 'PUT', `/connection/${conn.id}/disconnect`),
    409, 'Already disconnected');
}

section('2b. decline, withdraw, and the re-request cooldown');
await reset();
{
  const req = await send(HP, JOHN);
  expect('decline -> 200', await callAs(JOHN, 'PUT', `/connection/request/${req.body.id}/decline`), 200);
  ok('declined row retained as audit',
    (await sql`SELECT status FROM connection_request WHERE id = ${req.body.id}::uuid`)[0]?.status === 'declined');
  ok('no connection was created', (await callAs(HP, 'GET', '/connection/list')).body.length === 1);
  expect('second decline -> 409', await callAs(JOHN, 'PUT', `/connection/request/${req.body.id}/decline`),
    409, 'Request was already declined');

  const blocked = await send(HP, JOHN);
  ok('re-request after decline is blocked by cooldown', blocked.status === 409 &&
    /declined recently/.test(blocked.body?.error ?? ''), `${blocked.status} ${blocked.body?.error}`);

  // withdrawing your own request carries no cooldown
  const out = await send(HP, MARCUS);
  expect('send to Marcus -> 201', out, 201);
  expect('withdraw -> 200', await callAs(HP, 'PUT', `/connection/request/${out.body.id}/withdraw`), 200);
  ok('withdrawn leaves the sent list', (await sentFor(HP)).length === 0);
  expect('re-request after withdraw -> 201 (no cooldown)', await send(HP, MARCUS), 201);
  expect('withdraw an already-withdrawn request -> 409',
    await callAs(HP, 'PUT', `/connection/request/${out.body.id}/withdraw`), 409,
    'Request was already withdrawn');
}

// ── 3. Authorization ──────────────────────────────────────

section('3. authorization: only the right party may act');
await reset();
{
  const req = await send(HP, JOHN);
  const id = req.body.id;

  expect('third party accepts -> 403', await callAs(MARCUS, 'PUT', `/connection/request/${id}/accept`, { note: 'x' }),
    403, 'That request is not yours');
  expect('requester accepts own request -> 403',
    await callAs(HP, 'PUT', `/connection/request/${id}/accept`, { note: 'x' }), 403, 'That request is not yours');
  expect('third party declines -> 403', await callAs(MARCUS, 'PUT', `/connection/request/${id}/decline`),
    403, 'That request is not yours');
  expect('addressee withdraws (not theirs to withdraw) -> 403',
    await callAs(JOHN, 'PUT', `/connection/request/${id}/withdraw`), 403, 'That request is not yours');

  const someoneElses = (await callAs(PRIYA, 'GET', '/connection/list')).body[0];
  expect('uninvolved user disconnects -> 403',
    await callAs(JOHN, 'PUT', `/connection/${someoneElses.id}/disconnect`), 403,
    'That connection is not yours');
}

// ── 4. Validation ─────────────────────────────────────────

section('4. validation');
await reset();
{
  expect('self request -> 400', await send(HP, HP), 400, 'Cannot connect to yourself');
  expect('missing note -> 400',
    await callAs(HP, 'POST', '/connection/request', { addresseeId: JOHN.id }), 400, 'note is required');
  expect('whitespace-only note -> 400',
    await callAs(HP, 'POST', '/connection/request', { addresseeId: JOHN.id, note: '   ' }), 400,
    'note cannot be empty');
  expect('over-long note -> 400',
    await callAs(HP, 'POST', '/connection/request', { addresseeId: JOHN.id, note: 'x'.repeat(501) }), 400,
    'note must be 500 characters or fewer');
  expect('non-string note -> 400',
    await callAs(HP, 'POST', '/connection/request', { addresseeId: JOHN.id, note: { evil: true } }), 400,
    'note is required');
  expect('non-uuid addressee -> 400',
    await callAs(HP, 'POST', '/connection/request', { addresseeId: 'nope', note: 'hi' }), 400,
    'addresseeId must be a UUID');
  expect('missing addressee -> 400',
    await callAs(HP, 'POST', '/connection/request', { note: 'hi' }), 400, 'addresseeId must be a UUID');
  expect('absent addressee uuid -> 404',
    await callAs(HP, 'POST', '/connection/request', { addresseeId: ABSENT_UUID, note: 'hi' }), 404,
    'That user does not exist');

  expect('uppercased own uuid is still self -> 400',
    await callAs(HP, 'POST', '/connection/request', { addresseeId: HP.id.toUpperCase(), note: 'hi' }), 400,
    'Cannot connect to yourself');

  expect('non-uuid request id -> 400',
    await callAs(HP, 'PUT', '/connection/request/abc/decline'), 400, 'request id must be a UUID');
  expect('absent request id -> 404',
    await callAs(HP, 'PUT', `/connection/request/${ABSENT_UUID}/decline`), 404, 'Request not found');
  expect('non-uuid connection id -> 400',
    await callAs(HP, 'PUT', '/connection/abc/disconnect'), 400, 'connection id must be a UUID');
  expect('absent connection id -> 404',
    await callAs(HP, 'PUT', `/connection/${ABSENT_UUID}/disconnect`), 404, 'Connection not found');
}

// ── 5. Auth layer ─────────────────────────────────────────

section('5. auth layer');
{
  const raw = async (headers) => {
    const res = await fetch(`${BE_URL}/connection/list`, { headers: { 'X-Env': 'stage', ...headers } });
    let body; const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };

  expect('no token -> 401', await raw({}), 401, 'Unauthorized');
  expect('forged X-User-Id -> 401', await raw({ 'X-User-Id': HP.id }), 401, 'Unauthorized');
  expect('garbage bearer -> 401', await raw({ Authorization: 'Bearer not.a.token' }), 401, 'Unauthorized');
  expect('raw uuid as bearer -> 401', await raw({ Authorization: `Bearer ${HP.id}` }), 401, 'Unauthorized');
  expect('Basic auth -> 401', await raw({ Authorization: 'Basic abc' }), 401, 'Unauthorized');

  const good = await mintRaw({ id: HP.id });
  expect('tampered token -> 401', await raw({ Authorization: `Bearer ${good}x` }), 401, 'Unauthorized');
  expect('expired token -> 401',
    await raw({ Authorization: `Bearer ${await mintRaw({ id: HP.id, expiresInSec: -60 })}` }), 401, 'Unauthorized');
  expect('token without id claim -> 401',
    await raw({ Authorization: `Bearer ${await mintRaw({ id: HP.id, omitId: true })}` }), 401, 'Unauthorized');

  const prodToken = await mintRaw({ id: HP.id, env: 'prod' });
  expect('prod token against stage -> 403', await raw({ Authorization: `Bearer ${prodToken}` }), 403,
    'Token is not valid for this environment');

  const stageProd = await fetch(`${BE_URL}/connection/list`, {
    headers: { Authorization: `Bearer ${good}`, 'X-Env': 'prod' },
  });
  ok('stage token + X-Env: prod -> 403', stageProd.status === 403, `${stageProd.status}`);
}

// ── 6. Graph traversal ────────────────────────────────────

section('6. graph traversal');
await reset();
{
  const at = async (hops) => (await callAs(HP, 'GET', `/connection/reachable?maxHops=${hops}`)).body;

  ok('maxHops=1 -> [] (Priya is direct, so excluded)', (await at(1)).length === 0);
  const two = await at(2);
  ok('maxHops=2 -> Jordan + Marcus', two.length === 2 && two.every((r) => r.hops === 2),
    two.map((r) => `${r.name.split(' ')[0]}@${r.hops}`).join(','));
  const three = await at(3);
  ok('maxHops=3 -> 4 people', three.length === 4, three.map((r) => `${r.name.split(' ')[0]}@${r.hops}`).join(','));
  ok('Elena appears once despite two equal 3-hop paths',
    three.filter((r) => r.id === ELENA.id).length === 1);
  ok('maxHops=99 clamps to 6, no error', (await at(99)).length === 4);
  ok('maxHops=0 clamps to 1', (await at(0)).length === 0);
  ok('maxHops=-5 clamps to 1', (await at(-5)).length === 0);

  expect('maxHops=abc -> 400', await callAs(HP, 'GET', '/connection/reachable?maxHops=abc'), 400,
    'maxHops must be an integer');
  expect('maxHops=3abc -> 400 (no prefix parsing)',
    await callAs(HP, 'GET', '/connection/reachable?maxHops=3abc'), 400, 'maxHops must be an integer');
  expect('limit=abc -> 400', await callAs(HP, 'GET', '/connection/reachable?limit=abc'), 400,
    'limit must be an integer');
  ok('limit=1 truncates', (await callAs(HP, 'GET', '/connection/reachable?maxHops=3&limit=1')).body.length === 1);

  // via is deterministic across repeated calls
  const runs = await Promise.all([at(3), at(3), at(3)]);
  const vias = runs.map((r) => r.find((x) => x.id === ELENA.id)?.via_name);
  ok('via_name is stable across calls', new Set(vias).size === 1, vias.join('|'));

  const path = await callAs(HP, 'GET', `/connection/path/${ELENA.id}`);
  expect('path to Elena -> 200', path, 200);
  ok('path starts at hp and ends at Elena',
    path.body.path[0].id === HP.id && path.body.path.at(-1).id === ELENA.id,
    `${path.body.path.map((p) => p.name.split(' ')[0]).join('->')}`);
  ok('path hops matches chain length', path.body.hops === path.body.path.length - 1);

  expect('path maxHops=2 to a 3-hop person -> 404',
    await callAs(HP, 'GET', `/connection/path/${ELENA.id}?maxHops=2`), 404, 'No path found within 2 hops');
  expect('path to self -> 400', await callAs(HP, 'GET', `/connection/path/${HP.id}`), 400, 'That is you');
  expect('path to non-uuid -> 400', await callAs(HP, 'GET', '/connection/path/nope'), 400,
    'targetId must be a UUID');
  expect('path to an unconnected stranger -> 404',
    await callAs(HP, 'GET', `/connection/path/${ABSENT_UUID}`), 404, 'No path found within 6 hops');

  const direct = await callAs(HP, 'GET', `/connection/path/${PRIYA.id}`);
  ok('path to a direct connection is 1 hop', direct.body.hops === 1 && direct.body.path.length === 2);
}

// ── 7. Requests aggregate ─────────────────────────────────

section('7. combined requests endpoint');
await reset();
{
  await send(HP, JOHN);
  await send(MARCUS, HP);

  const requests = (await callAs(HP, 'GET', '/connection/requests')).body;
  ok('returns a JSON array, not an envelope', Array.isArray(requests));
  ok('both directions present', requests.length === 2);

  const outgoing = requests.find((r) => r.direction === 'outgoing');
  const incoming = requests.find((r) => r.direction === 'incoming');
  ok('outgoing points at John', outgoing?.other_id === JOHN.id, outgoing?.other_name);
  ok('incoming comes from Marcus', incoming?.other_id === MARCUS.id, incoming?.other_name);
  ok('rows carry the counterparty title', requests.every((r) => 'other_title' in r));
  ok('requester_id / addressee_id preserved for status derivation',
    requests.every((r) => r.requester_id && r.addressee_id));
  ok('agrees with the split endpoints',
    (await pendingFor(HP)).length === 1 && (await sentFor(HP)).length === 1);
}

// ── Done ──────────────────────────────────────────────────

await reset();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('ALL CONNECTION CHECKS PASSED\n');
