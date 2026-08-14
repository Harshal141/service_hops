const { neon } = require('@neondatabase/serverless');

const connections = {
  stage: neon(process.env.NEON_STAGE_URL),
  prod: neon(process.env.NEON_PROD_URL),
};

// Explicit allowlist — never index `connections` with a caller-supplied string,
// or an `X-Env: constructor` header resolves to Object.prototype members.
function getDb(env) {
  return env === 'prod' ? connections.prod : connections.stage;
}

async function testDBConnection(env) {
  try {
    const sql = getDb(env);
    await sql`SELECT 1`;
    console.log(`[Database] connected — env=${env}`);
  } catch (err) {
    console.error(`[Database] connection failed — env=${env}:`, err.message);
  }
}

module.exports = { getDb, testDBConnection };
