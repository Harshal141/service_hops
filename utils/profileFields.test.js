const { isIsoDate, isEduYear, parseHttpUrl, validateImportPayload, validateProfilePatch } = require('./profileFields');
const { ValidationError } = require('./errors');

describe('shape checks', () => {
  it('isIsoDate requires a real calendar date', () => {
    expect(isIsoDate('2021-03-01')).toBe(true);
    expect(isIsoDate('2021-02-30')).toBe(false);
    expect(isIsoDate('2021-03')).toBe(false);
    expect(isIsoDate(20210301)).toBe(false);
  });
  it('isEduYear accepts a year, a range, or an open range', () => {
    for (const y of ['2021', '2021-2024', '2021-']) expect(isEduYear(y)).toBe(true);
    for (const y of ['21', '2021-24', 'B.Tech']) expect(isEduYear(y)).toBe(false);
  });
  it('parseHttpUrl only accepts http(s) with a dotted host', () => {
    expect(parseHttpUrl('https://github.com/jane')).not.toBeNull();
    expect(parseHttpUrl('javascript:alert(1)')).toBeNull();
    expect(parseHttpUrl('ftp://x.com')).toBeNull();
    expect(parseHttpUrl('https://localhost')).toBeNull();
  });
});

describe('validateImportPayload', () => {
  const good = {
    full_name: ' Jane Doe ',
    profile: { title: 'Engineer', bio: '', location: 'Pune' },
    links: [{ key: 'link-0', type: 'github', url: 'https://github.com/jane', source: 'regex' }],
    experience: [
      { company: 'Acme', role: 'Dev', started_at: '2021-03-01', ended_at: '2020-01-01', currently_working: true, description: 'x' },
      { company: 'Globex', role: 'Dev', started_at: '2019-01-01', ended_at: '2021-01-01', currently_working: false, description: null },
    ],
    education: [{ institution: 'MIT', degree: null, year: '2018-2022' }],
    skill_ids: [3, 3, 7],
  };

  it('trims, drops blanks, numbers rows and dedupes skill ids', () => {
    const v = validateImportPayload(good);
    expect(v).toMatchObject({ name: 'Jane Doe', title: 'Engineer', bio: null, location: 'Pune', skillIds: [3, 7] });
    expect(v.links).toEqual([{ type: 'github', url: 'https://github.com/jane', sort_order: 0 }]);
    // currently_working forces ended_at to null (and skips the ordering check)
    expect(v.experience[0]).toMatchObject({ ended_at: null, currently_working: true, sort_order: 0 });
    expect(v.experience[1].sort_order).toBe(1);
    expect(v.education[0]).toEqual({ institution: 'MIT', degree: null, year: '2018-2022', sort_order: 0 });
  });

  it('accepts the exact FE apply payload', () => {
    const v = validateImportPayload({
      full_name: null,
      profile: { title: null, bio: 'Hi', location: null },
      links: [{ type: 'linkedin', url: 'https://www.linkedin.com/in/jane', sort_order: 0 }],
      experience: [{ company: 'Acme', role: 'Dev', started_at: '2021-03-01', ended_at: null, currently_working: false, description: null, sort_order: 0 }],
      education: [{ institution: 'MIT', degree: null, year: null, sort_order: 0 }],
      skill_ids: [17],
    });
    expect(v).toEqual({
      name: null, title: null, bio: 'Hi', location: null,
      links: [{ type: 'linkedin', url: 'https://www.linkedin.com/in/jane', sort_order: 0 }],
      experience: [{ company: 'Acme', role: 'Dev', started_at: '2021-03-01', ended_at: null, currently_working: false, description: null, sort_order: 0 }],
      education: [{ institution: 'MIT', degree: null, year: null, sort_order: 0 }],
      skillIds: [17],
    });
  });

  it('ignores fields outside the documented shape', () => {
    const v = validateImportPayload({ name: 'J', title: 'T', skills: [{ id: 1 }] });
    expect(v).toMatchObject({ name: null, title: null, skillIds: [], experience: [], education: [], links: [] });
  });

  const rejects = {
    'missing company': { experience: [{ role: 'Dev' }] },
    'blank role': { experience: [{ company: 'A', role: '  ' }] },
    'missing institution': { education: [{ degree: 'BSc' }] },
    'bad date': { experience: [{ company: 'A', role: 'B', started_at: '2021-13-01' }] },
    'end before start': { experience: [{ company: 'A', role: 'B', started_at: '2021-01-01', ended_at: '2020-01-01' }] },
    'non-boolean currently_working': { experience: [{ company: 'A', role: 'B', currently_working: 'yes' }] },
    'bad education year': { education: [{ institution: 'MIT', year: 'twenty' }] },
    'link type not allowed': { links: [{ type: 'myspace', url: 'https://x.com/a' }] },
    'non-http link': { links: [{ type: 'other', url: 'javascript:alert(1)' }] },
    'too many links': { links: Array.from({ length: 11 }, () => ({ type: 'other', url: 'https://a.com' })) },
    'title too long': { profile: { title: 'x'.repeat(501) } },
    'bad skill id': { skill_ids: ['3'] },
    'non-text name': { full_name: 42 },
    'profile not an object': { profile: 'Engineer' },
    'not a list': { experience: { company: 'A' } },
    'array body': [],
  };
  for (const [name, body] of Object.entries(rejects)) {
    it(`rejects: ${name}`, () => expect(() => validateImportPayload(body)).toThrow(ValidationError));
  }
});

describe('validateProfilePatch', () => {
  it('keeps only sent keys, trims, numbers rows and carries ids', () => {
    const v = validateProfilePatch({
      name: ' Jane ',
      bio: '  ',
      links: [
        { id: 9, type: 'github', url: 'https://github.com/jane', profile_id: 'x', created_at: 'y' },
        { type: 'other', url: 'https://jane.dev' },
      ],
      updated_at: '2026-10-02T15:17:10.500Z',
    });
    // bio blank clears it; title/location/experience/education were not sent, so they stay absent
    expect(v).toEqual({
      fields: { name: 'Jane', bio: null },
      sections: {
        links: [
          { id: 9, type: 'github', url: 'https://github.com/jane', sort_order: 0 },
          { type: 'other', url: 'https://jane.dev', sort_order: 1 },
        ],
      },
      updatedAt: '2026-10-02T15:17:10.500Z',
    });
  });

  const link = (extra = {}) => ({ type: 'other', url: 'https://a.com', ...extra });
  const rejects = {
    'nothing to save': { updated_at: '2026-10-02T15:17:10.500Z' },
    'empty name': { name: '  ' },
    'more than 10 links': { links: Array.from({ length: 11 }, () => link()) },
    'link type not allowed': { links: [link({ type: 'myspace' })] },
    'non-integer id': { links: [link({ id: '9' })] },
    'same id twice': { links: [link({ id: 9 }), link({ id: 9 })] },
    'invalid row': { experience: [{ id: 3, company: 'Acme' }] },
    'incomplete section_config': { section_config: [{ key: 'about', visible: true }] },
    'bad updated_at': { bio: 'x', updated_at: 'yesterday' },
  };
  for (const [name, body] of Object.entries(rejects)) {
    it(`rejects: ${name}`, () => expect(() => validateProfilePatch(body)).toThrow(ValidationError));
  }
});
