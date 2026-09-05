const { ValidationError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

// The public handle used in URLs — `users.user_id` — lowercase slug characters
// only. A raw UUID also matches this shape, which is deliberate: it lets a
// handle-based lookup accept either without the caller having to know which
// kind of identifier it was given (see userService.findByHandle).
const HANDLE_RE = /^[a-z0-9-]{1,150}$/;

const isHandle = (value) => typeof value === 'string' && HANDLE_RE.test(value);

function requireHandle(value, field) {
  if (!isHandle(value)) throw new ValidationError(`${field} must be a valid handle`);
  return value;
}

/**
 * Validates a UUID and returns it lowercased. Canonical case matters: Postgres
 * compares uuids case-insensitively but JS `===` does not, so an uppercased uuid
 * would otherwise slip past self-comparison checks.
 */
function requireUuid(value, field) {
  if (!isUuid(value)) throw new ValidationError(`${field} must be a UUID`);
  return value.toLowerCase();
}

/** Requires a non-blank string and returns it trimmed. Rejects whitespace-only. */
function requireText(value, field, { max = 1000 } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${field} cannot be empty`);
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be ${max} characters or fewer`);
  }
  return trimmed;
}

/**
 * Parses an integer query param and clamps it into range. Out-of-range values
 * clamp silently; genuinely non-numeric input is an error rather than a silent
 * default, so a typo is visible instead of quietly becoming 3.
 */
function clampInt(raw, { fallback, min, max, field }) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new ValidationError(`${field} must be an integer`);
  }
  return Math.min(Math.max(Number.parseInt(raw, 10), min), max);
}

module.exports = { isUuid, requireUuid, requireText, clampInt, isHandle, requireHandle };
