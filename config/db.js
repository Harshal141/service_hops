const { neon } = require('@neondatabase/serverless');

const connections = {
  stage: neon(process.env.NEON_STAGE_URL),
  prod: neon(process.env.NEON_PROD_URL),
};

function getDb(env) {
  return connections[env] ?? connections.stage;
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
