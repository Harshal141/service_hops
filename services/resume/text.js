// Resume text before the model sees it: cleanup, wrapped URL/email rejoin, link extraction,
// PII strip, and the is-this-a-resume heuristic. Pure.

const { UnprocessableError } = require('../../utils/errors');

// ── cleanup ─────────────────────────────────────────────────────────────────

// Labels LinkedIn prints after each Contact link, and the link type each one means.
const LABEL_TYPE = Object.freeze({
  LinkedIn: 'linkedin', Portfolio: 'portfolio', Personal: 'portfolio', Blog: 'portfolio',
  Company: 'other', 'RSS Feed': 'other', Other: 'other',
});
const LINK_LABELS = Object.keys(LABEL_TYPE).join('|');
const LINK_LABEL_RE = new RegExp(`\\s*\\((${LINK_LABELS})\\)\\s*$`);
const URL_START_RE = /^(?:https?:\/\/|www\.)/i;
// A line that is one URL-ish token: scheme/www, or domain followed by a path.
const URL_LINE_RE = /^(?:https?:\/\/\S+|www\.\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*)$/i;
const URL_BREAK_END_RE = /[/\-._=?&#~%]$/;
const URL_CONT_START_RE = /^[a-z0-9/@?#&=_%~.-]/;

// LinkedIn's Contact block (and narrow sidebars) wrap long URLs over several lines:
//   www.linkedin.com/in/      →  www.linkedin.com/in/jane-doe-1234 (LinkedIn)
//   jane-doe-1234 (LinkedIn)
function rejoinWrappedUrls(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let cur = lines[i];
    while (i + 1 < lines.length && URL_LINE_RE.test(cur) && !LINK_LABEL_RE.test(cur)) {
      const nextToken = lines[i + 1].replace(LINK_LABEL_RE, '');
      const isSingleToken = nextToken.length > 0 && !/\s/.test(nextToken);
      const startsNewThing = URL_START_RE.test(nextToken) || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(nextToken);
      const continues = URL_BREAK_END_RE.test(cur) || URL_CONT_START_RE.test(nextToken);
      const looksLikeHeading = /^[A-Z][A-Za-z]*:?$/.test(nextToken); // "SKILLS", "Summary"
      if (!isSingleToken || startsNewThing || looksLikeHeading || !continues) break;
      cur += lines[i + 1];
      i++;
    }
    out.push(cur);
  }
  return out.join('\n');
}

// LinkedIn wraps long emails too: "jane.doe.example@gmail.c\nom". Rejoin when the first line
// is a single token with an incomplete domain and the next is a bare domain fragment.
function rejoinWrappedEmails(text) {
  return text.replace(
    /^([^\s@]+@[^\s@]*?)\n([A-Za-z0-9.-]+)$/gm,
    (m, head, tail) => (/@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(head) || /^\d+$/.test(tail) ? m : head + tail),
  );
}

// "infra-\nstructure" → "infra-structure". The hyphen is KEPT: generators like LinkedIn don't
// auto-hyphenate, so a line-final hyphen is usually a real compound ("problem-solving", German
// "Contract-Tests"). Grounding removes hyphens on both sides, so either reading matches.
function rejoinHyphenatedBreaks(text) {
  return text.replace(/(\p{L})-\n(\p{L})/gu, '$1-$2');
}

function cleanText(raw) {
  let t = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00AD/g, '')                        // soft hyphen
    .replace(/[\u00A0\u2007\u202F\t\f\v]/g, ' ')   // NBSP, figure / narrow NBSP, tabs
    .replace(/[\u200B-\u200D\uFEFF]/g, '')         // zero-width characters, BOM
    .normalize('NFC');
  t = t.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).join('\n');
  t = t.replace(/^Page \d+ of \d+$/gim, ''); // LinkedIn page footer
  t = rejoinWrappedEmails(t);
  t = rejoinWrappedUrls(t);
  t = rejoinHyphenatedBreaks(t);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// ── links ───────────────────────────────────────────────────────────────────

function hostOf(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function linkTypeFromUrl(url) {
  const host = hostOf(url);
  if (!host) return 'other';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'github.com' || host.endsWith('.github.io')) return 'github';
  if (host === 'twitter.com' || host === 'x.com') return 'twitter';
  return 'other';
}

// Explicit URLs (scheme/www), domain+path, or a bare domain only when a LinkedIn label follows
// it (bare-domain matching without a label would catch "B.Tech", "Node.js").
const URL_IN_TEXT_RE = new RegExp(
  String.raw`(?<![@\w.])(`
    + String.raw`(?:https?:\/\/|www\.)[^\s()<>"']+`
    + String.raw`|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s()<>"']*`
    + String.raw`|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?=\s*\((?:${LINK_LABELS})\))`
    + String.raw`)(?:\s*\((${LINK_LABELS})\))?`,
  'gi',
);

// Dedupe key: host without www + path without trailing slash, lowercased.
function linkKey(url) {
  return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/#?]+$/, '');
}

function extractUrls(text) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(URL_IN_TEXT_RE)) {
    const url = m[1].replace(/[.,;:!?]+$/, '');
    const key = linkKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const byUrl = linkTypeFromUrl(url);
    out.push({ url, type: byUrl !== 'other' ? byUrl : LABEL_TYPE[m[2]] ?? 'other' });
  }
  return out;
}

// ── PII strip ───────────────────────────────────────────────────────────────

// Full email, for detection.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Strip pattern is deliberately looser: also catches a truncated/wrapped email ("jane@gmail.c")
// in case the rejoin missed it. Needs a local part, so "medium.com/@jane" and "@handle" survive,
// and a dot after the domain label, so "Engineer@Acme" in a headline survives.
const EMAIL_STRIP_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*/g;

// Date forms protected before phone matching. Horizontal whitespace only ([ \t]), never \n,
// and a year range is not protected if it directly continues a digit run (it'd be in a phone).
const DATE_PROTECT_RES = [
  // 2019 - 2021, 2019–21, 2019/20
  /(?<!\d[ \t.-]?)\b(?:19|20)\d{2}[ \t]*[-\u2013\u2014/][ \t]*(?:(?:19|20)\d{2}|\d{2})\b/g,
  // 15.03.2021, 15/03/2021, 2021-03-15
  /\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b/g,
  /\b(?:19|20)\d{2}-\d{1,2}-\d{1,2}\b/g,
  // 03/2021, 03.2021, 3-2021, 2021/03, 2021.03
  /\b(?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b/g,
  /\b(?:19|20)\d{2}[./](?:0?[1-9]|1[0-2])\b/g,
];

// Candidate phone run: optional +, digits, spaces/tabs, dots, dashes, parentheses.
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d \t.()-]*\d/g;
const TRAILING_RANGE_RE = /[ \t]+(?:19|20)\d{2}[ \t]*[-\u2013\u2014][ \t]*(?:(?:19|20)\d{2}|\d{2})$/;

function isPhoneRun(run) {
  const digits = run.replace(/\D/g, '').length;
  const opens = (run.match(/\(/g) || []).length;
  const closes = (run.match(/\)/g) || []).length;
  return digits >= 10 && opens <= 1 && closes <= 1;
}

// Known limit: phone numbers under 10 digits are not stripped.
function stripPII(text) {
  let t = text.replace(EMAIL_STRIP_RE, '[email]');
  const saved = [];
  for (const re of DATE_PROTECT_RES) {
    t = t.replace(re, (m) => `\u0000${saved.push(m) - 1}\u0000`);
  }
  t = t.replace(PHONE_CANDIDATE_RE, (m) => {
    if (!isPhoneRun(m)) return m;
    // "+91 98765 43210 2019 - 2021": the range wasn't protected (it follows a digit run).
    // Give it back if the phone part alone still qualifies, so dates aren't eaten.
    const tail = m.match(TRAILING_RANGE_RE);
    if (tail && isPhoneRun(m.slice(0, tail.index))) return `[phone]${tail[0]}`;
    return '[phone]';
  });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]);
}

// ── resume heuristic ───────────────────────────────────────────────────────

const HEADING_WORDS = [
  'experience', 'work experience', 'professional experience', 'employment', 'employment history', 'work history',
  'education', 'skills', 'top skills', 'technical skills', 'summary', 'profile', 'projects', 'certifications',
  'berufserfahrung', 'ausbildung', 'kenntnisse', 'fähigkeiten', 'bildung', 'werdegang',
  'experiencia', 'experiencia laboral', 'educación', 'formación', 'habilidades', 'competencias',
  'expérience', 'expérience professionnelle', 'formation', 'compétences',
];
const HEADING_RE = new RegExp(`^\\s*(?:${HEADING_WORDS.join('|')})\\b[^\\n]{0,30}$`, 'imu');
const PRESENT_WORDS = "present|current|now|today|heute|actualidad|presente|aujourd'hui|jetzt";
const YEAR_RANGE_RE = new RegExp(`\\b(?:19|20)\\d{2}\\s*[-\\u2013\\u2014]\\s*(?:(?:19|20)\\d{2}|\\d{2}\\b|[\\p{L}]+\\s+(?:19|20)\\d{2}|${PRESENT_WORDS})`, 'iu');
const MMYYYY_RANGE_RE = /\b\d{1,2}[./](?:19|20)\d{2}\s*[-\u2013\u2014]\s*(?:\d{1,2}[./](?:19|20)\d{2})/;

// A section heading is required, plus a year range or contact details: an invoice has the
// latter two but no heading.
function looksLikeResume(text) {
  if (!HEADING_RE.test(text)) return false;
  return YEAR_RANGE_RE.test(text) || MMYYYY_RANGE_RE.test(text)
    || new RegExp(EMAIL_RE.source).test(text) || stripPII(text).includes('[phone]');
}

/**
 * Raw PDF text → { text, regexLinks, warnings }. Throws 422 `scanned` / `not_a_resume`.
 * `text` is cleaned, PII-stripped and truncated: what the model sees, what grounding checks
 * against, and the only form that is stored.
 */
function prepareResumeText(raw, { minChars, maxChars }) {
  const cleaned = cleanText(raw);
  if (cleaned.length < minChars) {
    throw new UnprocessableError('No readable text found in that PDF', 'scanned');
  }
  const head = cleaned.slice(0, maxChars);
  if (!looksLikeResume(head)) {
    throw new UnprocessableError('That file does not look like a resume', 'not_a_resume');
  }
  // Strip before truncating so a cut can't leave a partial phone number too short to match.
  const stripped = stripPII(cleaned);
  return {
    text: stripped.slice(0, maxChars),
    regexLinks: extractUrls(head),
    warnings: stripped.length > maxChars ? ['input_truncated'] : [],
  };
}

module.exports = {
  cleanText, rejoinWrappedUrls, rejoinWrappedEmails, rejoinHyphenatedBreaks,
  extractUrls, linkTypeFromUrl, linkKey, stripPII, looksLikeResume, prepareResumeText,
};
