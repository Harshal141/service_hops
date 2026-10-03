const { normalize, groundDraft } = require('./grounding');

const SOURCE = `Alex Synthetic
Experience
Staff Engineer, Acme Payments
Mar 2021 - Present
Led migration of the ledger infra-structure to an event-sourced design processing 4M transactions per day.
Engineer, Initech
2019 - 21
Education
B.Tech Computer Science, Example Institute of Technology, 2015–19
Skills
Go, Kotlin, PostgreSQL
東京大学 工学部`;


const draft = (overrides = {}) => ({
  full_name: 'Alex', profile: {}, links: [], experience: [], education: [], skill_names: [], ...overrides,
});
const exp = (fields) => ({
  key: 'exp-0', company: null, role: null, started_at: null, ended_at: null, description: null,
  reasons: [], low_confidence: false, ...fields,
});
const edu = (fields) => ({ key: 'edu-0', institution: null, degree: null, year: null, reasons: [], low_confidence: false, ...fields });

describe('normalize', () => {
  it('lowercases, removes hyphens, strips punctuation', () => {
    expect(normalize('Infra-Structure, Inc.')).toBe('infrastructure inc');
    expect(normalize('B.Tech')).toBe('b tech');
  });
});

describe('field checks', () => {
  // Each check runs through groundDraft on a single experience entry.
  const reasonsFor = (fields) => groundDraft(draft({ experience: [exp(fields)] }), SOURCE).experience[0].reasons;
  const phraseGrounded = (company) => !reasonsFor({ company }).includes('grounding_company');
  const yearGrounded = (y) => !reasonsFor({ started_at: y ? `${y}-01-01` : null }).includes('grounding_date');
  const descriptionGrounded = (description) => !reasonsFor({ description }).includes('grounding_description');

  it('phrase match first, then ≥ 0.8 token coverage', () => {
    expect(phraseGrounded('Acme Payments')).toBe(true);
    expect(phraseGrounded('Payments Acme')).toBe(true); // reordered, full coverage
    expect(phraseGrounded('B.Tech Computer Science')).toBe(true);
    // 3 of 4 tokens (0.75) must not pass
    expect(phraseGrounded('M.Tech Computer Science')).toBe(false);
  });
  it('non-Latin text uses character bigrams', () => {
    expect(phraseGrounded('東京大学')).toBe(true);
    expect(phraseGrounded('京都大学')).toBe(false);
  });
  it('years match as 2021, a range end like "2019 - 21", or not at all', () => {
    expect(yearGrounded('2021')).toBe(true);
    expect(yearGrounded('2019')).toBe(true);
    expect(yearGrounded('2010')).toBe(false);
    expect(yearGrounded(undefined)).toBe(true);
  });
  it('description needs ≥ 70% of its 4-grams', () => {
    expect(descriptionGrounded('Led migration of the ledger infrastructure')).toBe(true);
    expect(descriptionGrounded('Led migration of the payroll system to the cloud')).toBe(false);
  });
});

describe('groundDraft', () => {
  it('passes a faithful entry, including the hyphen variant', () => {
    const g = groundDraft(draft({ experience: [exp({
      company: 'Acme Payments', role: 'Staff Engineer', started_at: '2021-03-01',
      description: 'Led migration of the ledger infrastructure to an event-sourced design processing 4M transactions per day.',
    })] }), SOURCE);
    expect(g.experience[0]).toMatchObject({ reasons: [], low_confidence: false });
  });

  it('flags invented companies, roles, years and descriptions', () => {
    const g = groundDraft(draft({ experience: [exp({
      company: 'Globex Corporation', role: 'Principal Architect', started_at: '2012-01-01',
      description: 'Managed a team of forty engineers across three continents and shipped many products.',
    })] }), SOURCE);
    expect(g.experience[0].reasons).toEqual(['grounding_company', 'grounding_role', 'grounding_date', 'grounding_description']);
    expect(g.experience[0].low_confidence).toBe(true);
  });

  it('flags a fake degree and checks both education years', () => {
    const g = groundDraft(draft({ education: [
      edu({ institution: 'Example Institute of Technology', degree: 'M.Tech Data Science', year: '2015-2019' }),
      edu({ institution: 'Example Institute of Technology', degree: null, year: '2015-2011' }),
    ] }), SOURCE);
    expect(g.education[0].reasons).toEqual(['grounding_degree']);
    expect(g.education[1].reasons).toEqual(['grounding_date']);
  });

  it('keeps earlier reasons without duplicating', () => {
    const g = groundDraft(draft({ experience: [exp({ company: 'Acme Payments', reasons: ['missing_required'], low_confidence: true })] }), SOURCE);
    expect(g.experience[0].reasons).toEqual(['missing_required']);
  });

  it('drops ungrounded skills', () => {
    const g = groundDraft(draft({ skill_names: ['Go', 'Kotlin', 'Rust', 'postgresql'] }), SOURCE);
    expect(g.skill_names).toEqual(['Go', 'Kotlin', 'postgresql']);
  });
});
