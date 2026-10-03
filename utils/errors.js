/**
 * Typed errors. Services throw meaning; routes never guess a status code; one
 * middleware turns these into responses.
 *
 * Only an AppError carries a message that is safe to send to a client. Anything
 * else becomes a generic 500 with the detail logged server-side.
 */
class AppError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.expose = true;
    if (code) this.code = code;
  }
}

class ValidationError extends AppError {
  constructor(message = 'Invalid input', code) { super(message, 400, code); }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code) { super(message, 401, code); }
}

/** Authenticated, but this is not yours. Distinct from NotFound on purpose. */
class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code) { super(message, 403, code); }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found', code) { super(message, 404, code); }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict', code) { super(message, 409, code); }
}

class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large', code) { super(message, 413, code); }
}

/** Well-formed input we cannot work with (a scanned PDF, not a resume). */
class UnprocessableError extends AppError {
  constructor(message = 'Unprocessable input', code) { super(message, 422, code); }
}

/** `retryAfter` (seconds) becomes the Retry-After header. */
class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', code, retryAfter) {
    super(message, 429, code);
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

/** An upstream dependency (an AI provider) failed. Never carries its raw error. */
class UpstreamError extends AppError {
  constructor(message = 'Upstream failure', code) { super(message, 502, code); }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  UnprocessableError,
  TooManyRequestsError,
  UpstreamError,
};
