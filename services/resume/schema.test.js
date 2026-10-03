const { RESUME_SCHEMA, resumeZod, toGemini, toGroq } = require('./schema');
const resumeFixture = require('./fixtures/resume.json');

// Every node of a JSON Schema that describes an object.
const objects = (node, acc = []) => {
  if (node && typeof node === 'object') {
    if (node.properties) acc.push(node);
    Object.values(node).forEach((v) => objects(v, acc));
  }
  return acc;
};
const has = (node, key) => JSON.stringify(node).includes(`"${key}":`);

describe('resumeZod', () => {
  const empty = { is_resume: true, full_name: null, headline: null, location: null, summary: null, links: [], experience: [], education: [], skills: [] };

  it('parses the fixture the fake provider returns', () => {
    expect(resumeZod.safeParse(resumeFixture).success).toBe(true);
  });
  it('enforces the patterns and caps a provider may drop, and rejects extra keys', () => {
    expect(resumeZod.safeParse(empty).success).toBe(true);
    expect(resumeZod.safeParse({ ...empty, skills: Array(41).fill('x') }).success).toBe(false);
    expect(resumeZod.safeParse({ ...empty, education: [{ institution: 'X', degree: null, start_year: '21', end_year: null }] }).success).toBe(false);
    expect(resumeZod.safeParse({ ...empty, extra: 1 }).success).toBe(false);
  });
});

describe('RESUME_SCHEMA', () => {
  it('keeps is_resume first, since Gemini generates keys in schema order', () => {
    expect(Object.keys(RESUME_SCHEMA.properties)[0]).toBe('is_resume');
  });
  it('writes nullable fields as ["string","null"], never anyOf', () => {
    expect(RESUME_SCHEMA.properties.full_name.type).toEqual(['string', 'null']);
    expect(RESUME_SCHEMA.properties.experience.items.properties.start.type).toEqual(['string', 'null']);
    expect(has(RESUME_SCHEMA, 'anyOf')).toBe(false);
  });
});

describe('provider schemas', () => {
  it('Gemini: no pattern, source untouched', () => {
    expect(has(toGemini(RESUME_SCHEMA), 'pattern')).toBe(false);
    expect(has(RESUME_SCHEMA, 'pattern')).toBe(true);
  });
  it('Groq: every object closed and requiring every property, no pattern / maxItems', () => {
    const q = toGroq(RESUME_SCHEMA);
    expect(objects(q)).toHaveLength(4);
    for (const o of objects(q)) {
      expect(o.additionalProperties).toBe(false);
      expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort());
    }
    expect(has(q, 'pattern') || has(q, 'maxItems')).toBe(false);
  });
});
