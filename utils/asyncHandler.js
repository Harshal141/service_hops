/**
 * Wraps an async route handler so a rejection reaches the error middleware
 * instead of hanging the request. Replaces hand-rolled try/catch in routes.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { asyncHandler };
