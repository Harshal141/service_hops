const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isPdfMagic, readPdf, groupLines, findGutter, columnOrderedText } = require('./pdf');
const { ValidationError } = require('../../utils/errors');

// Synthetic PDFs generated with pdfkit (no real personal data).
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'pdf', `${name}.pdf`));

const codeOf = async (promise) => {
  try { await promise; } catch (err) { return err instanceof ValidationError ? err.code : `untyped:${err.message}`; }
  return null;
};

describe('isPdfMagic', () => {
  it('requires the %PDF- header', () => {
    expect(isPdfMagic(Buffer.from('%PDF-1.7\n'))).toBe(true);
    expect(isPdfMagic(Buffer.from('PK\u0003\u0004'))).toBe(false);
    expect(isPdfMagic(Buffer.from('%PD'))).toBe(false);
  });
});

describe('readPdf', () => {
  it('rejects non-PDF bytes and a corrupt PDF as not_pdf', async () => {
    expect(await codeOf(readPdf(Buffer.from('hello world'), { maxPages: 5 }))).toBe('not_pdf');
    expect(await codeOf(readPdf(Buffer.from('%PDF-1.7\ngarbage garbage'), { maxPages: 5 }))).toBe('not_pdf');
  });

  it('rejects a user-password PDF as encrypted, accepts an owner-password-only PDF', async () => {
    expect(await codeOf(readPdf(fixture('user_password'), { maxPages: 5 }))).toBe('encrypted');
    const { pageCount } = await readPdf(fixture('owner_password'), { maxPages: 5 });
    expect(pageCount).toBe(1);
  });

  it('enforces the page limit', async () => {
    expect(await codeOf(readPdf(fixture('seven_pages'), { maxPages: 5 }))).toBe('too_many_pages');
    const { pageCount } = await readPdf(fixture('seven_pages'), { maxPages: 8 });
    expect(pageCount).toBe(7);
  });

  it('extracts text and leaves the caller buffer intact for hashing', async () => {
    const buf = fixture('plain');
    const before = crypto.createHash('sha256').update(buf).digest('hex');
    const { text } = await readPdf(buf, { maxPages: 5 });
    expect(text).toContain('Staff Engineer, Acme Payments');
    expect(crypto.createHash('sha256').update(buf).digest('hex')).toBe(before);
  });

  it('reorders an interleaved two-column page into whole columns', async () => {
    const { text } = await readPdf(fixture('two_column'), { maxPages: 5 });
    const lines = text.split('\n');
    // the sidebar (CONTACT … LANGUAGES) comes out as one block before the main column
    expect(lines.indexOf('SKILLS')).toBeLessThan(lines.indexOf('Sam Designer'));
    expect(lines.indexOf('Figma') + 1).toBe(lines.indexOf('Sketch'));
    expect(text).toContain('Owned the checkout redesign end to end, raising');
  });
});

describe('column ordering on synthetic items', () => {
  const item = (str, x, y, width = str.length * 5) => ({ str, transform: [1, 0, 0, 1, x, y], width, height: 10, hasEOL: true });

  it('keeps stream order when there is no gutter (single column, right-aligned dates)', () => {
    const items = [];
    for (let i = 0; i < 8; i++) {
      items.push(item(`Line ${i} with a long body of text that spans the page`, 50, 800 - i * 20, 300));
      items.push(item('2020', 500, 800 - i * 20, 20));
    }
    const lines = groupLines(items);
    expect(findGutter(lines, 600)).toBeNull();
    expect(columnOrderedText(items, 600).startsWith('Line 0')).toBe(true);
  });

  it('finds a gutter between two text columns and emits left then right', () => {
    const items = [];
    for (let i = 0; i < 6; i++) {
      items.push(item(`Left ${i} sidebar entry`, 40, 800 - i * 20, 150));
      items.push(item(`Right ${i} main column entry text`, 300, 800 - i * 20, 250));
    }
    const text = columnOrderedText(items, 600);
    expect(text.split('\n')).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((i) => `Left ${i} sidebar entry`),
      ...[0, 1, 2, 3, 4, 5].map((i) => `Right ${i} main column entry text`),
    ]);
  });
});
