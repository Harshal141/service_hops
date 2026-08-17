# service_hops — Backend

Express 5 API deployed on Vercel. Neon Postgres with two separate instances (stage / prod),
selected per-request from the `X-Env` header via `config/db.js` → `getDb(env)`.

Root `../CLAUDE.md` covers project-wide conventions. This file is the backend contract and
takes precedence for anything under `service_hops/`.

---

## 1. Layer contract — separation of concerns

Four layers with a strict one-way dependency: **routes → services → config**.
Never sideways, never backwards.

| Layer | Owns | Must never |
|---|---|---|
| `routes/` | HTTP only — read `req`, validate input shape, choose status, send JSON | contain SQL, contain business rules |
| `services/` | Business logic and **all** SQL | touch `req` / `res`, know about HTTP status codes |
| `middleware/` | Cross-cutting request concerns — auth, env resolution, error handling | contain domain logic |
| `config/` | Connections and environment wiring | contain queries |
| `utils/` | Pure, reusable, I/O-free helpers | import from routes or services |

**How to decide where code goes:**
- Takes `(req, res)` → routes or middleware.
- Takes domain arguments, returns data, talks to the DB → services.
- Takes plain values, returns plain values, no I/O → utils.

A route handler should read as a single sentence: pull inputs, call one service method,
return. If a handler has branching business rules in it, that logic belongs in the service.

---

## 2. `utils/` — the shared layer

**`utils/` currently exists and is empty. That is a defect, not a starting state.**

The rule: **the moment a helper is needed in a second file, it moves to `utils/` and both
files import it.** Do not copy. Today `const getEnv = (req) => req.headers['x-env'] ?? 'stage'`
is duplicated in all five route files — that is exactly the drift this rule exists to stop.

Modules that belong there:

| Module | Purpose |
|---|---|
| `utils/errors.js` | `AppError` base + `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError` |
| `utils/asyncHandler.js` | Wraps an async route handler so rejections reach the error middleware |
| `utils/validate.js` | Small input assertions — `isUuid`, `requireFields`, `clampInt` |
| `utils/pairMatch.js` | The `LEAST/GREATEST` user-pair predicate, currently written out 8× — 6 in `connectionService`, 2 in `userService` |

Env resolution is a *request* concern, so it is middleware, not a util: a single
`middleware/env.js` should set `req.env` once and every route reads `req.env`.

**Do not create a util for something used once.** Three similar lines in one file is fine.
A wrapper with a single caller is not.

---

## 3. Error handling

Services throw typed errors. Routes never guess status codes. One middleware turns errors
into responses.

```js
// services/ — throw meaning, not HTTP
if (!row) throw new NotFoundError('Experience not found');
if (row.profile_id !== userId) throw new ForbiddenError('Not yours');

// routes/ — no try/catch, no status guessing
router.put('/experience/:id', asyncHandler(async (req, res) => {
  const row = await profileService.updateExperience(req.userId, req.params.id, req.body, req.env);
  res.json(row);
}));
```

**Rules:**
- **No `try/catch` in route handlers.** Use `asyncHandler`. The 31 hand-rolled try/catch
  blocks currently in `routes/` are the pattern being replaced.
- **Never send `error.message` from an unknown error.** Only `AppError` instances carry a
  client-safe message; everything else becomes a generic 500 with the detail logged
  server-side. Raw Postgres errors must not reach the client.
- **`'Not found or not yours'` is two different errors.** Split them — a missing row is 404,
  someone else's row is 403. Returning 400 for both (the current behaviour) makes the API
  undebuggable from the FE.
- One error envelope, always: `{ "error": "<message>" }`. See §8.

---

## 4. Input validation

`req.body` is untrusted. Validate at the route boundary before it reaches a service.

- Required fields → 400 with a message naming the missing field.
- Route params that are UUIDs → validate the format (`/connection/path/:targetId` already
  does this; the pattern should be shared, not re-declared).
- Numeric query params → parse and clamp to an explicit ceiling.
- Enum-ish fields (`link.type`, `profile.status`) → check against an allowlist. Do not pass
  arbitrary strings into a column that the FE will later branch on.

A service may assume its arguments are shape-correct. It may not assume they are
authorised — ownership checks belong in the service, in the SQL `WHERE` clause.

---

## 5. Data access

- **Always parameterize.** Template-literal interpolation into `sql` is already correct
  everywhere — keep it that way. Never build SQL by string concatenation.
- **Never `SELECT *` or `RETURNING *` on a table whose columns the caller should not see.**
  Enumerate them. Two live examples worth fixing: `GET /users` is `SELECT * FROM users`, and
  `GET /profile/:userId` — which is **public** (`optionalAuth`) — selects `u.email`, so any
  unauthenticated caller can read any user's email address. `RETURNING *` is fine when the
  row is going back to its own owner; it is not fine on `users`.
- **Ownership in the query, not after it.** `WHERE id = ${id} AND profile_id = ${userId}` —
  never fetch, then compare in JS.
- **Multi-write operations must be atomic** — and know what the driver can actually do.
  `acceptRequest` currently performs select → delete → insert → delete as four independent
  HTTP round-trips; a failure partway leaves a request accepted with no connection row.
  `neon()` over HTTP provides `sql.transaction([q1, q2, …])`, which is **non-interactive**:
  every query is built upfront, so it *cannot* express "read a row, then write using its
  values". Two valid ways out:
  - **Preferred — collapse into one statement with data-modifying CTEs**
    (`WITH req AS (DELETE … RETURNING *) INSERT … SELECT … FROM req`). One round-trip,
    atomic, no new connection type. This is what `acceptRequest` needs.
  - Where the logic genuinely cannot be one statement, use `Pool` / `Client` from
    `@neondatabase/serverless` (WebSocket) with explicit `BEGIN` / `COMMIT`. That requires a
    new export from `config/db.js` — never open a connection ad hoc inside a service.
- **Keep SQL in services.** Do not push query fragments up into routes or down into utils.
  A util may return a *predicate builder*; it may not run a query.
- Comment the intent of non-obvious SQL. The recursive CTEs in `connectionService` are the
  standard to match — explain the traversal, not the syntax.

---

## 6. Migrations — immutable, always

**A migration file is frozen the moment it is written. It is never edited again — not to fix
a typo, not to add a column, not even if it has only run on stage.**

Why this is absolute: migrations are applied by hand to two live databases. Editing an
applied file makes the file a lie about the state of any database that already ran it, and
there is no way to detect the divergence.

- Corrections go in a **new** `vN+1_*.sql`. Wrong column type in `v6`? Write `v7`.
- Sequential, gapless, descriptive names: `v10_connection_index.sql`.
- Every file starts with a header stating: what it does, **which environments it targets**,
  and what it depends on.

```sql
-- ============================================================
-- v10_connection_index — index connection lookups by user
-- Targets: stage + prod
-- Depends on: v7_connection.sql
-- ============================================================
```

- **Environment targeting is part of the contract.** `v9_demo_connections.sql` is stage-only
  and says so in a comment — that comment is load-bearing. Never write demo or seed data
  that is safe to run on prod by accident.
- Write migrations to be **idempotent** where the syntax allows: `IF NOT EXISTS`,
  `ON CONFLICT DO NOTHING`. Re-running a migration should not destroy anything.
- **Destructive statements need a note.** `v7` drops the unused v1 `connections` table and
  explains why it is safe. Every `DROP` / `ALTER ... TYPE` gets that treatment.
- There is no migration runner and no tracking table. Until there is, the applied version
  per environment must be recorded somewhere durable — a `schema_migrations` table is the
  right fix and should land as its own migration.

---

## 7. Security

The auth layer is correct and load-bearing — read `middleware/auth.js` before changing
anything near it.

- **Identity comes only from the verified session JWT.** Never trust a header, a body field,
  or a query param to say who the caller is. The `X-User-Id` header was removed for exactly
  this reason and must not come back.
- Every route that reads or writes user-owned data uses `requireAuth`. Routes that are
  public but behave differently for the owner use `optionalAuth` (see `GET /profile/:userId`).
- **`X-Env` selects a database, so it is attacker-controlled input.** `getDb` uses an
  explicit allowlist and must stay that way — never index a connection map with a
  caller-supplied string.
- Keep the CORS origin allowlist explicit. No wildcards, no regex origins.
- Never log tokens, `AUTH_SECRET`, connection strings, or full request bodies.

---

## 8. API conventions (shared with the FE)

The FE depends on these. Changing one is a cross-repo change.

- **Error envelope:** `{ "error": "<human-readable message>" }`. Always. Never a bare string,
  never `{ message }`, never a 200 carrying an error body.
- **Status codes:**
  | Code | Meaning |
  |---|---|
  | 200 | OK with a body |
  | 201 | Created — returns the created row |
  | 204 | Deleted / no content — empty body |
  | 400 | Malformed or missing input |
  | 401 | Missing or invalid token |
  | 403 | Authenticated but not permitted (someone else's row, private profile) |
  | 404 | Resource does not exist |
  | 409 | Conflict — already connected, duplicate request |
  | 500 | Unexpected — generic message to the client, full detail in the log |
- Responses use `snake_case` keys, matching the DB columns. The FE normalises at its
  boundary; the BE does not camelCase on the way out.
- A list endpoint returns a JSON array, never `{ items: [...] }`.

---

## 9. Logging

- Prefixed and structured: `[auth]`, `[Database]`, `[connection]`. Match the existing style.
- Log the *cause* on the server, return the *safe summary* to the client.
- `console.error` for anything that reaches the error middleware as a non-`AppError`.
- No per-request success logging in hot paths.

---

## 10. Definition of done

Before a backend change is finished:

- [ ] Route handlers contain no SQL and no `try/catch`.
- [ ] Services contain no `req` / `res`.
- [ ] Nothing is copy-pasted between two files — shared code is in `utils/`.
- [ ] New errors are typed; no raw `error.message` reaches the client.
- [ ] New/changed inputs are validated at the route boundary.
- [ ] Multi-write operations are atomic — one statement with CTEs, or an explicit transaction.
- [ ] Schema changes are a **new** migration file with a header — no existing migration was
      edited.
- [ ] `LOG.md` (or the current log file) has an entry if this is a feature, migration, or
      refactor.
