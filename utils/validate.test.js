const { requireUuid, clampInt } = require('./validate');
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
