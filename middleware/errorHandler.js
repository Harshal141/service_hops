const { MulterError } = require('multer');
const { AppError } = require('../utils/errors');

// Postgres error codes that correspond to a client mistake rather than a bug.
// The client gets the generic meaning; the driver's message stays in the log,
// because it contains column names, constraint names and sometimes values.
const PG_STATUS = {
  '23505': [409, 'Already exists'],                        // unique_violation
  '23503': [404, 'Referenced record does not exist'],       // foreign_key_violation
  '23502': [400, 'Missing required value'],                 // not_null_violation
  '23514': [400, 'Value is not allowed'],                   // check_violation
  '22P02': [400, 'Malformed identifier'],                   // invalid_text_representation
  '22001': [400, 'Value is too long'],                      // string_data_right_truncation
};

// Envelope: `{ error }`, plus `code` when the error carries one.
const envelope = (message, code) => (code ? { error: message, code } : { error: message });

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
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
    console.error(`[error] pg ${err.code} on ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(status).json({ error: message });
  }

  console.error(`[error] unhandled on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Internal error' });
}

module.exports = { errorHandler };
