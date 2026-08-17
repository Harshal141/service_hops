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

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }

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
