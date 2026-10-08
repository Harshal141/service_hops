const Sentry = require('@sentry/node');

// Headers that carry credentials. Sentry attaches request headers to server events, and
// X-Internal-Secret is the FE↔BE shared secret — none of these may leave the server.
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-internal-secret']);

/** beforeSend / beforeSendTransaction: strips credentials from an event before it is sent. */
function scrubEvent(event) {
  const request = event?.request;
  if (!request) return event;

  if (request.headers) {
    for (const key of Object.keys(request.headers)) {
      if (SECRET_HEADERS.has(key.toLowerCase())) delete request.headers[key];
    }
  }
  delete request.cookies;
  return event;
}

/**
 * The trace id of the request being handled. The FE propagates its trace in the
 * `sentry-trace` header, so this is the same id the FE's errors for this request carry.
 * Returns null when no trace is active.
 */
function currentTraceId() {
  const header = Sentry.getTraceData()['sentry-trace'];
  const traceId = header?.split('-')[0];
  return traceId || null;
}

module.exports = { scrubEvent, currentTraceId, SECRET_HEADERS };
