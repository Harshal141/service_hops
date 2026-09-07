const { getDb } = require('../config/db');
const { ValidationError } = require('../utils/errors');

// The only flows this store currently holds. Gatekeeping the key here — not in
// the table — is what keeps "one common place for small per-user flags" from
// turning into an unbounded bag of ad hoc, typo-prone keys. A flow's internal
// field shape belongs to whichever feature reads/writes it, not to this file.
const KNOWN_FLOWS = ['onboarding', 'resume_prompt'];

function requireFlow(flow) {
  if (!KNOWN_FLOWS.includes(flow)) throw new ValidationError(`Unknown flag flow: ${flow}`);
  return flow;
}

const getAll = async (userId, env) => {
  const sql = getDb(env);
  const rows = await sql`SELECT data FROM user_flag WHERE user_id = ${userId}::uuid`;
  return rows[0]?.data ?? {};
};

// Merges `patch` into `data->flow` only — every other flow, and every sibling
// field already on this flow, is left untouched. Upserts the row on first
// write so the caller never has to create it explicitly.
const patchFlow = async (userId, flow, patch, env) => {
  requireFlow(flow);
  const sql = getDb(env);
  const patchJson = JSON.stringify(patch);

  // Every bare ${flow} below needs an explicit ::text cast. neon's driver sends
  // it as an untyped bind parameter, and jsonb_build_object/ARRAY[] give
  // Postgres no argument type to infer it from — left uncast this fails at
  // execute time with "could not determine data type of parameter" (42P18).
  const rows = await sql`
    INSERT INTO user_flag (user_id, data)
    VALUES (${userId}::uuid, jsonb_build_object(${flow}::text, ${patchJson}::jsonb))
    ON CONFLICT (user_id) DO UPDATE
      SET data = jsonb_set(
        user_flag.data,
        ARRAY[${flow}::text],
        COALESCE(user_flag.data->${flow}::text, '{}'::jsonb) || ${patchJson}::jsonb
      )
    RETURNING data
  `;
  return rows[0].data;
};

module.exports = { getAll, patchFlow, KNOWN_FLOWS };
