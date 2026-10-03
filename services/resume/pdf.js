// PDF validation and text extraction. CPU only, no I/O. unpdf (pdf.js) is ESM-only, so it
// is loaded with a cached dynamic import(), the same pattern as `jose` in middleware/auth.js.

const { ValidationError } = require('../../utils/errors');

let unpdfPromise;
const loadUnpdf = () => (unpdfPromise ??= import('unpdf'));

const isPdfMagic = (buf) => buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

// ── column-aware ordering ───────────────────────────────────────────────────

// Same as unpdf's extractText: content-stream order, '\n' on hasEOL.
function itemsToStreamText(items) {
  return items.filter((it) => it.str != null).map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
}

// Groups positioned items into visual lines (same baseline within tolerance), left→right.
function groupLines(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const tol = Math.max(2, (it.height || 10) * 0.4);
    let line = lines.find((l) => Math.abs(l.y - y) <= tol && x >= l.x1 - 2 && x - l.x1 < 30);
    if (!line) { line = { y, x0: x, x1: x, parts: [] }; lines.push(line); }
    line.parts.push({ x, str: it.str });
    line.x1 = Math.max(line.x1, x + (it.width || 0));
    line.x0 = Math.min(line.x0, x);
  }
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    l.text = l.parts.map((p) => p.str).join(' ').replace(/[ \t]+/g, ' ').trim();
  }
  return lines;
}

// Finds a vertical gutter: an x that no body line crosses, with both sides carrying ≥ 15% of
// lines AND characters (the char share stops right-aligned dates from counting as a column).
// Up to 3 lines may cross it if they all sit above the columns (a full-width header).
// Returns null for single-column pages.
function findGutter(lines, pageWidth) {
  if (lines.length < 6) return null;
  const chars = (ls) => ls.reduce((n, l) => n + l.text.length, 0);
  let best = null;
  for (let g = pageWidth * 0.15; g <= pageWidth * 0.85; g += 2) {
    const crossing = lines.filter((l) => l.x0 < g - 1 && l.x1 > g + 1);
    if (crossing.length > 3) continue;
    const body = lines.filter((l) => !crossing.includes(l));
    const bodyTop = Math.max(...body.map((l) => l.y));
    if (crossing.some((l) => l.y <= bodyTop)) continue;
    const left = body.filter((l) => l.x1 <= g);
    const right = body.filter((l) => l.x0 >= g);
    const minLines = Math.min(left.length, right.length);
    const minChars = Math.min(chars(left), chars(right));
    if (minLines < Math.max(3, body.length * 0.15) || minChars < chars(body) * 0.15) continue;
    if (!best || minChars > best.minChars) best = { g, minChars, header: crossing };
  }
  return best;
}

// Header, then left column top→bottom, then right column top→bottom. Falls back to content-
// stream order when no gutter is found — never to a y-sort, which would interleave a sidebar
// that the stream already kept as a block (LinkedIn exports).
function columnOrderedText(items, pageWidth) {
  const lines = groupLines(items);
  const found = findGutter(lines, pageWidth);
  if (!found) return itemsToStreamText(items);
  const byY = (a, b) => b.y - a.y; // PDF y grows upward
  const { g, header } = found;
  const body = lines.filter((l) => !header.includes(l));
  const left = body.filter((l) => l.x1 <= g).sort(byY);
  const right = body.filter((l) => l.x0 >= g).sort(byY);
  return [...[...header].sort(byY), ...left, ...right].map((l) => l.text).join('\n');
}

// ── validation + extraction ─────────────────────────────────────────────────

/**
 * Validates the bytes and extracts column-ordered text from every page.
 * Throws 400 `not_pdf` / `encrypted` / `too_many_pages`.
 * Owner-password-only PDFs open normally and are accepted.
 * Hash `buf` with the caller's own copy: pdf.js detaches the array it is given, so it gets a copy.
 */
async function readPdf(buf, { maxPages }) {
  if (!isPdfMagic(buf)) throw new ValidationError('That file is not a PDF', 'not_pdf');
  const { getDocumentProxy } = await loadUnpdf();
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch (err) {
    // PasswordException: code 1 = needs a password, 2 = wrong password
    if (err?.name === 'PasswordException') {
      throw new ValidationError('That PDF is password protected', 'encrypted');
    }
    throw new ValidationError('That file is not a readable PDF', 'not_pdf');
  }
  try {
    const pageCount = pdf.numPages;
    if (pageCount > maxPages) {
      throw new ValidationError(`That PDF has more than ${maxPages} pages`, 'too_many_pages');
    }
    const pages = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const { items } = await page.getTextContent();
      pages.push(columnOrderedText(items, page.getViewport({ scale: 1 }).width));
    }
    return { pageCount, text: pages.join('\n') };
  } finally {
    await pdf.destroy();
  }
}

module.exports = { isPdfMagic, readPdf, groupLines, findGutter, columnOrderedText };
