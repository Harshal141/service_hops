const Sentry = require('@sentry/node');
const { currentTraceId } = require('../utils/sentry');

// Vercel exposes the invocation's waitUntil on this global (it is what @vercel/functions
// reads). Sentry's own helper only uses it on the Edge runtime, so on Node it is done here.
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

function waitUntil(task) {
  const ctx = globalThis[VERCEL_REQUEST_CONTEXT]?.get?.();
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

// Per request: echo the trace id so a caller can match its error to ours, tag which
// database the request hit, and make sure queued Sentry events are sent before Vercel
// freezes the function. Runs after attachEnv, which resolves req.env.
function traceContext(req, res, next) {
  const traceId = currentTraceId();
  if (traceId) res.set('X-Trace-Id', traceId);

  Sentry.getIsolationScope().setTag('db_env', req.env);

  res.on('finish', () => waitUntil(Sentry.flush(2000)));
  next();
}

module.exports = { traceContext };
