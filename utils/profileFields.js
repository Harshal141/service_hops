// Field rules for profile content. Pure. Resume normalization caps at the same limits that
// apply validation enforces, so a draft sent back unedited always passes.

const { ValidationError } = require('./errors');
const { requireText } = require('./validate');

// title is VARCHAR(500) in the DB.
const FIELD_LIMITS = Object.freeze({
  name: 200,
  title: 500,
  bio: 5000,
  location: 200,
  company: 200,
  role: 200,
  description: 5000,
  institution: 200,
  degree: 200,
  url: 2048,
});

const LINK_TYPES = Object.freeze(['linkedin', 'github', 'twitter', 'portfolio', 'other']);

const MAX_ITEMS = Object.freeze({ links: 10, experience: 15, education: 10, skills: 40 });

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// "2021", "2021-2024", "2021-" (still studying, v6 allows it)
const EDU_YEAR_RE = /^\d{4}(-(\d{4})?)?$/;

/** A real calendar date in YYYY-MM-DD form. */
function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const isEduYear = (value) => typeof value === 'string' && EDU_YEAR_RE.test(value);

/** http(s) URL with a dotted host. Returns the parsed URL or null. */
function parseHttpUrl(value) {
  if (typeof value !== 'string' || value.length > FIELD_LIMITS.url) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  return u;
}

// ── validators: return the cleaned value or throw ValidationError ──────────

const text = (value, field) => requireText(value, field, { max: FIELD_LIMITS[field] });
const optionalText = (value, field) => requireText(value, field, { max: FIELD_LIMITS[field], optional: true });

function optionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!isIsoDate(value)) throw new ValidationError(`${field} must be a YYYY-MM-DD date`);
  return value;
}

function list(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list`);
  if (value.length > MAX_ITEMS[field]) {
    throw new ValidationError(`${field} can have at most ${MAX_ITEMS[field]} items`);
  }
  return value;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const item = (value, field) => {
  if (!isObject(value)) throw new ValidationError(`each ${field} entry must be an object`);
  return value;
};

function validateLink(raw) {
  const l = item(raw, 'link');
  if (!LINK_TYPES.includes(l.type)) throw new ValidationError('link type is not allowed');
  if (!parseHttpUrl(l.url)) throw new ValidationError('link url must be an http(s) URL');
  return { type: l.type, url: l.url };
}

function validateExperience(raw) {
  const e = item(raw, 'experience');
  const currently = e.currently_working === undefined ? false : e.currently_working;
  if (typeof currently !== 'boolean') throw new ValidationError('currently_working must be true or false');
  const started = optionalDate(e.started_at, 'started_at');
  const ended = currently ? null : optionalDate(e.ended_at, 'ended_at');
  if (started && ended && ended < started) throw new ValidationError('ended_at is before started_at');
  return {
    company: text(e.company, 'company'),
    role: text(e.role, 'role'),
    started_at: started,
    ended_at: ended,
    currently_working: currently,
    description: optionalText(e.description, 'description'),
  };
}

function validateEducation(raw) {
  const e = item(raw, 'education');
  const year = e.year === undefined || e.year === null || e.year === '' ? null : e.year;
  if (year !== null && !isEduYear(year)) throw new ValidationError('year must look like 2021 or 2021-2024');
  return {
    institution: text(e.institution, 'institution'),
    degree: optionalText(e.degree, 'degree'),
    year,
  };
}

function validateSkillIds(value) {
  const ids = list(value, 'skills');
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('skill ids must be positive integers');
  }
  return [...new Set(ids)];
}

/**
 * Validates the reviewed draft the FE sends to apply:
 *   { full_name, profile: { title, bio, location }, links, experience, education, skill_ids }
 * A null text field leaves the stored value alone. sort_order is the array position.
 */
function validateImportPayload(body) {
  if (!isObject(body)) throw new ValidationError('Request body must be an object');
  const profile = body.profile ?? {};
  if (!isObject(profile)) throw new ValidationError('profile must be an object');

  const withOrder = (rows) => rows.map((r, i) => ({ ...r, sort_order: i }));
  return {
    name: optionalText(body.full_name, 'name'),
    title: optionalText(profile.title, 'title'),
    bio: optionalText(profile.bio, 'bio'),
    location: optionalText(profile.location, 'location'),
    links: withOrder(list(body.links, 'links').map(validateLink)),
    experience: withOrder(list(body.experience, 'experience').map(validateExperience)),
    education: withOrder(list(body.education, 'education').map(validateEducation)),
    skillIds: validateSkillIds(body.skill_ids),
  };
}

module.exports = {
  FIELD_LIMITS,
  LINK_TYPES,
  MAX_ITEMS,
  isIsoDate,
  isEduYear,
  parseHttpUrl,
  validateImportPayload,
};
