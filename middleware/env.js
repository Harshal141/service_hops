// X-Env chooses which database a request hits, so it is attacker-controlled
// input. Resolve it once here, through an allowlist, and let every route read
// req.env instead of re-reading the header (it was duplicated in all five route
// files). Anything that is not exactly 'prod' resolves to stage — never the
// other way round.
const resolveEnv = (raw) => (raw === 'prod' ? 'prod' : 'stage');

function attachEnv(req, _res, next) {
  req.env = resolveEnv(req.headers['x-env']);
  next();
}

module.exports = { attachEnv, resolveEnv };
