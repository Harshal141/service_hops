/**
 * Typed errors. Services throw meaning; routes never guess a status code; one
 * middleware turns these into responses.
 *
 * Only an AppError carries a message that is safe to send to a client. Anything
 * else becomes a generic 500 with the detail logged server-side.
 */
class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.expose = true;
  }
}

class ValidationError extends AppError {
  constructor(message = 'Invalid input') { super(message, 400); }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') { super(message, 401); }
}

/** Authenticated, but this is not yours. Distinct from NotFound on purpose. */
class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') { super(message, 403); }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(message, 404); }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict') { super(message, 409); }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};
