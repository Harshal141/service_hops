const { requireUuid, requireText, clampInt, searchQuery, containsPattern } = require('./validate');
const { ValidationError } = require('./errors');

describe('requireUuid', () => {
  it('accepts a valid UUID and lowercases it for consistent self-comparison', () => {
    expect(requireUuid('550E8400-E29B-41D4-A716-446655440000', 'id')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('rejects a non-UUID value', () => {
    expect(() => requireUuid('not-a-uuid', 'id')).toThrow(ValidationError);
  });
});

describe('clampInt', () => {
  it('clamps an in-range value and caps out-of-range values at the ceiling', () => {
    expect(clampInt('3', { fallback: 3, min: 1, max: 6, field: 'maxHops' })).toBe(3);
    expect(clampInt('99', { fallback: 3, min: 1, max: 6, field: 'maxHops' })).toBe(6);
  });

  it('rejects non-integer input instead of silently falling back', () => {
    expect(() => clampInt('abc', { fallback: 3, min: 1, max: 6, field: 'maxHops' })).toThrow(
      ValidationError,
    );
  });
});

describe('requireText', () => {
  it('trims, and rejects missing, blank or over-long text', () => {
    expect(requireText('  hi ', 'note')).toBe('hi');
    expect(() => requireText(undefined, 'note')).toThrow(ValidationError);
    expect(() => requireText('   ', 'note')).toThrow(ValidationError);
    expect(() => requireText('abcd', 'note', { max: 3 })).toThrow(ValidationError);
  });

  it('optional: missing or blank is null, a non-string is still rejected', () => {
    expect(requireText(null, 'bio', { optional: true })).toBeNull();
    expect(requireText('  ', 'bio', { optional: true })).toBeNull();
    expect(requireText(' x ', 'bio', { optional: true })).toBe('x');
    expect(() => requireText(5, 'bio', { optional: true })).toThrow('bio must be text');
  });
});

describe('searchQuery', () => {
  it('trims and caps a string, and treats anything else (a repeated ?q=a&q=b) as empty', () => {
    expect(searchQuery('  ada ')).toBe('ada');
    expect(searchQuery('x'.repeat(150))).toHaveLength(100);
    expect(searchQuery(['a', 'b'])).toBe('');
    expect(searchQuery(undefined)).toBe('');
  });
});

describe('containsPattern', () => {
  it('escapes LIKE wildcards so they match literally', () => {
    expect(containsPattern('ada')).toBe('%ada%');
    expect(containsPattern(String.raw`100%_a\b`)).toBe(String.raw`%100\%\_a\\b%`);
  });
});
