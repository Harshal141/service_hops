// Model output → the draft the FE reviews: field caps, dates with a precision, merged links,
// education years. Uses the same field limits as apply validation, so a draft sent back
// unedited always passes. Pure.

const { FIELD_LIMITS, LINK_TYPES, MAX_ITEMS, parseHttpUrl } = require('../../utils/profileFields');
const { linkKey, linkTypeFromUrl } = require('./text');

// Tighter than FIELD_LIMITS: past these a model answer is mostly noise the user would trim.
const DRAFT_CAPS = Object.freeze({ bio: 2000, description: 1500, skill: 100 });

const cleanStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function cap(v, max) {
  const s = cleanStr(v);
  return s && s.length > max ? s.slice(0, max).trim() : s;
}

// Cut at the last whole line that fits; a single over-long first line is hard-cut.
function capAtLine(text, max) {
  if (text.length <= max) return { text, cut: false };
  let out = '';
  for (const line of text.split('\n')) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > max) break;
    out = next;
  }
  return { text: (out || text.slice(0, max)).trim(), cut: true };
}

// "Senior Engineer |" → "Senior Engineer"
const trimHeadline = (v) => cap(cleanStr(v)?.replace(/[\s|\u00B7\u2022\-\u2013\u2014,]+$/u, ''), FIELD_LIMITS.title);

function capBio(v) {
  const s = cleanStr(v);
  return s ? capAtLine(s, DRAFT_CAPS.bio).text : null;
}

// "2021-03" → month precision, "2021" → year precision.
function toDate(v) {
  if (typeof v !== 'string') return { date: null, precision: null };
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return { date: `${v}-01`, precision: 'month' };
  if (/^\d{4}$/.test(v)) return { date: `${v}-01-01`, precision: 'year' };
  return { date: null, precision: null };
}

// Compare at the coarser of the two precisions: "2021" is not before "2021-03".
function isBefore(a, b) {
  if (a.precision === 'year' || b.precision === 'year') return a.date.slice(0, 4) < b.date.slice(0, 4);
  return a.date < b.date;
}

function normalizeUrl(raw) {
  let s = cleanStr(raw);
  if (!s) return null;
  s = s.replace(/[.,;:!?]+$/, '');
  // prefix https:// only when it starts with a domain
  if (!/^https?:\/\//i.test(s)) {
    if (!/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?:[/?#]|$)/i.test(s)) return null;
    s = `https://${s}`;
  }
  return parseHttpUrl(s) ? s : null;
}

function mergeLinks(regexLinks, modelLinks) {
  const seen = new Set();
  const out = [];
  const add = (rawUrl, type, source) => {
    const url = normalizeUrl(rawUrl);
    if (!url || out.length >= MAX_ITEMS.links) return;
    const key = linkKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    // a recognised domain beats whatever the model or label said
    const byUrl = linkTypeFromUrl(url);
    const finalType = byUrl !== 'other' ? byUrl : LINK_TYPES.includes(type) ? type : 'other';
    out.push({ key: `link-${out.length}`, sort_order: out.length, type: finalType, url, source, low_confidence: false, reasons: [] });
  };
  // regex links first: their LinkedIn labels beat the model's "other"
  for (const l of regexLinks) add(l.url, l.type, 'regex');
  for (const l of modelLinks) add(l.url, l.type, 'model');
  return out;
}

const nullFields = (obj, fields) => fields.filter((f) => obj[f] === null);

function normalizeExperience(raw, today, warnings) {
  const out = [];
  for (const e of raw) {
    const company = cap(e.company, FIELD_LIMITS.company);
    const role = cap(e.role, FIELD_LIMITS.role);
    let description = cleanStr(e.description);
    if (description) {
      const capped = capAtLine(description, DRAFT_CAPS.description);
      if (capped.cut && !warnings.includes('description_truncated')) warnings.push('description_truncated');
      description = capped.text;
    }
    if (!company && !role && !description && !e.start && !e.end) continue; // nothing to show

    const reasons = [];
    const current = e.is_current === true;
    let start = toDate(e.start);
    let end = current ? { date: null, precision: null } : toDate(e.end);
    if (start.date && start.date > today) {
      start = { date: null, precision: null };
      reasons.push('date_invalid');
    }
    if (start.date && end.date && isBefore(end, start)) {
      end = { date: null, precision: null };
      if (!reasons.includes('date_invalid')) reasons.push('date_invalid');
    }
    if (!company || !role) reasons.push('missing_required');

    const i = out.length;
    const item = {
      key: `exp-${i}`, sort_order: i, company, role,
      started_at: start.date, started_at_precision: start.precision,
      ended_at: end.date, ended_at_precision: end.precision,
      currently_working: current, description,
      low_confidence: reasons.length > 0, reasons, null_fields: [],
    };
    item.null_fields = nullFields(item, current
      ? ['company', 'role', 'started_at', 'description']
      : ['company', 'role', 'started_at', 'ended_at', 'description']);
    out.push(item);
  }
  return out;
}

function normalizeEducation(raw) {
  const out = [];
  for (const e of raw) {
    const institution = cap(e.institution, FIELD_LIMITS.institution);
    const degree = cap(e.degree, FIELD_LIMITS.degree);
    const years = [e.start_year, e.end_year].filter((y) => typeof y === 'string' && /^\d{4}$/.test(y));
    const year = years.length === 2 ? `${years[0]}-${years[1]}` : years[0] ?? null;
    if (!institution && !degree && !year) continue;
    const reasons = institution ? [] : ['missing_required'];
    const i = out.length;
    const item = {
      key: `edu-${i}`, sort_order: i, institution, degree, year,
      low_confidence: reasons.length > 0, reasons, null_fields: [],
    };
    item.null_fields = nullFields(item, ['institution', 'degree', 'year']);
    out.push(item);
  }
  return out;
}

function normalizeSkillNames(raw) {
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const name = cap(s, DRAFT_CAPS.skill);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= MAX_ITEMS.skills) break;
  }
  return out;
}

/**
 * zod-validated model output → the stored draft (skill NAMES only; ids are resolved at
 * response time). `today` is 'YYYY-MM-DD' (injected for tests).
 * Returns { draft, warnings } — warnings are only the ones normalization adds.
 */
function normalizeExtraction(parsed, { regexLinks = [], today }) {
  const warnings = [];
  const draft = {
    full_name: cap(parsed.full_name, FIELD_LIMITS.name),
    profile: {
      title: trimHeadline(parsed.headline),
      bio: capBio(parsed.summary),
      location: cap(parsed.location, FIELD_LIMITS.location),
    },
    links: mergeLinks(regexLinks, parsed.links ?? []),
    experience: normalizeExperience(parsed.experience ?? [], today, warnings),
    education: normalizeEducation(parsed.education ?? []),
    skill_names: normalizeSkillNames(parsed.skills ?? []),
  };
  return { draft, warnings };
}

module.exports = { trimHeadline, capAtLine, toDate, normalizeUrl, mergeLinks, normalizeExtraction };
