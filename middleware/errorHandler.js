const Sentry = require('@sentry/node');
const { consoleSandbox } = require('@sentry/core');
const { MulterError } = require('multer');
const { AppError } = require('../utils/errors');
const { currentTraceId } = require('../utils/sentry');

// Postgres error codes with a meaningful status — a client mistake, or a timeout — rather than a bug.
// The client gets the generic meaning; the driver's message stays in the log,
// because it contains column names, constraint names and sometimes values.
const PG_STATUS = {
  '23505': [409, 'Already exists'],                        // unique_violation
  '23503': [404, 'Referenced record does not exist'],       // foreign_key_violation
  '23502': [400, 'Missing required value'],                 // not_null_violation
  '23514': [400, 'Value is not allowed'],                   // check_violation
  '22P02': [400, 'Malformed identifier'],                   // invalid_text_representation
  '22001': [400, 'Value is too long'],                      // string_data_right_truncation
  '57014': [503, 'That took too long. Try again in a moment.'], // query_canceled (statement_timeout)
};

// Which request this was, for the log line: env and user are what triage needs first
// (did it hit stage or prod, who saw it), and neither is in the URL. The trace id
// matches the Sentry trace, so a Vercel log line can be found there and vice versa.
const context = (req) =>
  `${req.method} ${req.originalUrl} env=${req.env ?? '-'} user=${req.userId ?? '-'} trace=${currentTraceId() ?? '-'}`;

// Envelope: `{ error }`, plus `code` when the error carries one, plus `trace_id` when
// a trace is active so the FE can tie its own error to this one.
function envelope(message, code) {
  const body = code ? { error: message, code } : { error: message };
  const traceId = currentTraceId();
  if (traceId) body.trace_id = traceId;
  return body;
}

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    // Expected outcomes, but not silent ones: an auth or quota problem that only ever reaches
    // the client is invisible in the runtime logs.
    const log = err.status >= 500 ? console.error : console.warn;
    log(`[error] ${err.status}${err.code ? ` ${err.code}` : ''} on ${context(req)}: ${err.message}`);
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    return res.status(err.status).json(envelope(err.message, err.code));
  }

  // Route-level upload limits (routes/profileImport.js). MulterError.code is
  // multer's own constant, never forwarded as our `code`.
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json(envelope('That file is too big', 'file_too_big'));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json(envelope('Upload exactly one PDF in the "file" field', 'no_file'));
    }
    return res.status(400).json(envelope('Invalid upload'));
  }

  // express.json() body errors: the client's fault, not a 500.
  if (err?.type === 'entity.too.large') return res.status(413).json(envelope('Request body too large'));
  if (err?.type === 'entity.parse.failed') return res.status(400).json(envelope('Malformed JSON body'));

  const mapped = PG_STATUS[err?.code];
  if (mapped) {
    const [status, message] = mapped;
    console.error(`[error] pg ${err.code} on ${context(req)}: ${err.message}`);
    return res.status(status).json(envelope(message));
  }

  // Sent to Sentry as an exception (real stack, grouped by type) rather than as the
  // log line below. Sentry sends only message and stack, never a driver error's `detail`.
  Sentry.captureException(err);
  // The stack, not the whole error object: a driver error's `detail` can carry row values.
  // Sandboxed so the console capture does not report this a second time as a message.
  consoleSandbox(() => console.error(`[error] unhandled on ${context(req)}: ${err?.stack ?? err}`));
  res.status(500).json(envelope('Internal error'));
}

module.exports = { errorHandler };
