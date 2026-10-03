const {
  trimHeadline, capAtLine, toDate, normalizeUrl, mergeLinks, normalizeExtraction,
} = require('./draft');

describe('post-model field rules', () => {
  it('trims headline trailing separators', () => {
    expect(trimHeadline('  Senior Engineer | ')).toBe('Senior Engineer');
    expect(trimHeadline('Designer ·')).toBe('Designer');
    expect(trimHeadline('Engineer -')).toBe('Engineer');
    expect(trimHeadline('   ')).toBeNull();
  });
  it('caps at a line boundary', () => {
    expect(capAtLine('aaa\nbbb\nccc', 7)).toEqual({ text: 'aaa\nbbb', cut: true });
    expect(capAtLine('short', 10)).toEqual({ text: 'short', cut: false });
    expect(capAtLine('x'.repeat(20), 5)).toEqual({ text: 'xxxxx', cut: true });
  });
  it('maps dates to a day with a precision', () => {
    expect(toDate('2021-03')).toEqual({ date: '2021-03-01', precision: 'month' });
    expect(toDate('2021')).toEqual({ date: '2021-01-01', precision: 'year' });
    expect(toDate(null)).toEqual({ date: null, precision: null });
  });
  it('accepts http(s) and bare domains, rejects junk', () => {
    expect(normalizeUrl('github.com/jane')).toBe('https://github.com/jane');
    expect(normalizeUrl('http://jane.dev.')).toBe('http://jane.dev');
    expect(normalizeUrl('@jane')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('Jane Doe')).toBeNull();
  });
  it('merges regex and model links, regex first, domain overriding type, deduped', () => {
    const links = mergeLinks(
      [{ url: 'jane.dev', type: 'portfolio' }],
      [{ url: 'https://jane.dev/', type: 'other' }, { url: 'https://github.com/jane', type: 'other' }, { url: 'nonsense', type: 'other' }],
    );
    expect(links.map((l) => [l.key, l.url, l.type, l.source])).toEqual([
      ['link-0', 'https://jane.dev', 'portfolio', 'regex'],
      ['link-1', 'https://github.com/jane', 'github', 'model'],
    ]);
  });
});

describe('normalizeExtraction', () => {
  const base = {
    is_resume: true, full_name: ' Jane Doe ', headline: 'Engineer |', location: ' Pune ', summary: null,
    links: [], experience: [], education: [], skills: [],
  };
  const today = '2026-10-02';

  it('maps experience, flags missing required fields and invalid dates', () => {
    const { draft } = normalizeExtraction({
      ...base,
      experience: [
        { company: 'Acme', role: null, start: '2022', end: null, is_current: true, description: 'Did x' },
        { company: 'Globex', role: 'Dev', start: '2030-01', end: null, is_current: false, description: null },
        { company: 'Initech', role: 'Dev', start: '2021-03', end: '2020', is_current: false, description: null },
        { company: 'Hooli', role: 'Dev', start: '2021-03', end: '2021', is_current: false, description: null },
        { company: null, role: null, start: null, end: null, is_current: false, description: null },
      ],
    }, { today });
    expect(draft.full_name).toBe('Jane Doe');
    expect(draft.profile).toEqual({ title: 'Engineer', bio: null, location: 'Pune' });
    expect(draft.experience).toHaveLength(4); // the all-null entry is dropped
    const [a, b, c, d] = draft.experience;
    expect(a).toMatchObject({
      key: 'exp-0', sort_order: 0, started_at: '2022-01-01', started_at_precision: 'year',
      ended_at: null, currently_working: true, low_confidence: true, reasons: ['missing_required'], null_fields: ['role'],
    });
    expect(b).toMatchObject({ started_at: null, reasons: ['date_invalid'] });
    expect(c).toMatchObject({ started_at: '2021-03-01', ended_at: null, reasons: ['date_invalid'] });
    // same year at year precision is not "before"
    expect(d).toMatchObject({ ended_at: '2021-01-01', reasons: [], low_confidence: false });
  });

  it('truncates long descriptions with a warning', () => {
    const description = Array.from({ length: 40 }, (_, i) => `Bullet ${i} ${'word '.repeat(10)}`).join('\n');
    const { draft, warnings } = normalizeExtraction({
      ...base, experience: [{ company: 'A', role: 'B', start: null, end: null, is_current: false, description }],
    }, { today });
    expect(warnings).toEqual(['description_truncated']);
    expect(draft.experience[0].description.length).toBeLessThanOrEqual(1500);
    expect(draft.experience[0].description.endsWith('word')).toBe(true);
  });

  it('builds education year strings and allows a null degree', () => {
    const { draft } = normalizeExtraction({
      ...base,
      education: [
        { institution: 'MIT', degree: null, start_year: '2018', end_year: '2022' },
        { institution: null, degree: 'BSc', start_year: null, end_year: '2016' },
      ],
    }, { today });
    expect(draft.education[0]).toMatchObject({ year: '2018-2022', degree: null, reasons: [], null_fields: ['degree'] });
    expect(draft.education[1]).toMatchObject({ year: '2016', reasons: ['missing_required'], low_confidence: true });
  });

  it('dedupes skill names case-insensitively', () => {
    const { draft } = normalizeExtraction({ ...base, skills: ['React', 'react', ' Go ', ''] }, { today });
    expect(draft.skill_names).toEqual(['React', 'Go']);
  });
});
