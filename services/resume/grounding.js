// Grounding: is each extracted value actually in the text the model saw (cleaned and
// PII-stripped)? Pure. Failures add a reason and set low_confidence (the review shows the item
// unticked with a hint); ungrounded skills are dropped.

// lowercase, NFKC, hyphens REMOVED ("infra-structure" = "infrastructure"), other punctuation
// → space, whitespace collapsed.
function normalize(s) {
  return String(s ?? '').toLowerCase().normalize('NFKC')
    .replace(/[-\u2010\u2011\u2012\u2013\u2014]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s) => (s ? s.split(' ') : []);

// Scripts written without spaces (CJK, Thai, …) don't tokenize on whitespace: compare
// character bigrams instead.
const NON_LATIN_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
function bigrams(s) {
  const t = s.replace(/ /g, '');
  const out = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  return out.length ? out : [t];
}

class Source {
  constructor(text) {
    this.raw = String(text ?? '');
    this.lower = this.raw.toLowerCase();
    this.norm = normalize(this.raw);
    this.padded = ` ${this.norm} `;
    this.tokenSet = new Set(tokens(this.norm));
    this.bigramSet = new Set(bigrams(this.norm));
  }
}

/** Contiguous phrase match, else token (or bigram) coverage ≥ 0.8. */
function phraseGrounded(value, src) {
  const v = normalize(value);
  if (!v) return true;
  if (src.padded.includes(` ${v} `)) return true;
  if (NON_LATIN_RE.test(v)) {
    if (src.norm.includes(v)) return true;
    const grams = bigrams(v);
    return grams.filter((g) => src.bigramSet.has(g)).length / grams.length >= 0.8;
  }
  const t = tokens(v);
  return t.filter((x) => src.tokenSet.has(x)).length / t.length >= 0.8;
}

/** The year appears in the source as 2021, '21, or a range end like "2019–21". */
function yearGrounded(year, src) {
  if (!year) return true;
  const yy = year.slice(2, 4);
  return src.lower.includes(year) || src.lower.includes(`'${yy}`) || new RegExp(`[\\u2013\\u2014-]\\s*${yy}\\b`).test(src.raw);
}

/** ≥ 70% of the description's word 4-grams appear in the source. */
function descriptionGrounded(text, src, n = 4) {
  const t = tokens(normalize(text));
  if (!t.length) return true;
  if (t.length < n) return src.padded.includes(` ${t.join(' ')} `);
  let hit = 0;
  let total = 0;
  for (let i = 0; i + n <= t.length; i++) {
    total++;
    if (src.padded.includes(` ${t.slice(i, i + n).join(' ')} `)) hit++;
  }
  return hit / total >= 0.7;
}

const skillGrounded = (name, src) => src.lower.includes(name.toLowerCase()) || phraseGrounded(name, src);

function withReasons(item, extra) {
  const reasons = [...item.reasons];
  for (const r of extra) if (!reasons.includes(r)) reasons.push(r);
  return { ...item, reasons, low_confidence: reasons.length > 0 };
}

/** Normalized draft (draft.normalizeExtraction) → grounded draft. */
function groundDraft(draft, sourceText) {
  const src = new Source(sourceText);

  const experience = draft.experience.map((e) => {
    const r = [];
    for (const f of ['company', 'role']) if (e[f] && !phraseGrounded(e[f], src)) r.push(`grounding_${f}`);
    if (!yearGrounded(e.started_at?.slice(0, 4), src) || !yearGrounded(e.ended_at?.slice(0, 4), src)) r.push('grounding_date');
    if (e.description && !descriptionGrounded(e.description, src)) r.push('grounding_description');
    return withReasons(e, r);
  });

  const education = draft.education.map((e) => {
    const r = [];
    for (const f of ['institution', 'degree']) if (e[f] && !phraseGrounded(e[f], src)) r.push(`grounding_${f}`);
    const years = (e.year ?? '').match(/\d{4}/g) ?? [];
    if (!years.every((y) => yearGrounded(y, src))) r.push('grounding_date');
    return withReasons(e, r);
  });

  return {
    ...draft,
    experience,
    education,
    skill_names: draft.skill_names.filter((s) => skillGrounded(s, src)),
  };
}

module.exports = { normalize, groundDraft };
