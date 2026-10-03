const { classifyResponse, buildBody } = require('./groq');
const { baseResult } = require('./shared');

const out = () => baseResult('groq', 'groq-test');
const ok = (content, finish = 'stop') => JSON.stringify({
  model: 'openai/gpt-oss-120b',
  choices: [{ finish_reason: finish, message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } },
});
const err = (status, error) => [status, JSON.stringify({ error })];

describe('groq buildBody', () => {
  it('uses strict json_schema, low reasoning and the output cap', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const b = buildBody({ model: 'm', system: 's', user: 'u', schema, maxOutputTokens: 4000 });
    expect(b).toMatchObject({ max_completion_tokens: 4000, reasoning_effort: 'low', temperature: 0 });
    expect(b.response_format.json_schema.strict).toBe(true);
    expect(b.response_format.json_schema.schema.required).toEqual(['a']);
  });
});

describe('groq classifyResponse', () => {
  it('parses a good response and reads usage', () => {
    expect(classifyResponse(200, ok('{"a":1}'), out())).toMatchObject({
      ok: true, json: { a: 1 }, finish_reason: 'stop', usage: { in: 100, out: 50, thinking: 20 },
    });
  });
  it('finish_reason length → ai_truncated', () => {
    expect(classifyResponse(200, ok('{"a":', 'length'), out()).error_code).toBe('ai_truncated');
  });
  it('400 json_validate_failed → ai_truncated, with or without failed_generation', () => {
    const a = classifyResponse(...err(400, {
      code: 'json_validate_failed',
      message: 'max completion tokens reached before generating a valid document',
      failed_generation: '{"is_resume": true, "experience": [',
    }), out());
    expect(a).toMatchObject({ ok: false, error_code: 'ai_truncated', raw: '{"is_resume": true, "experience": [' });
    expect(classifyResponse(...err(400, { code: 'json_validate_failed', message: 'Failed to validate JSON', failed_generation: '' }), out()).error_code).toBe('ai_truncated');
    expect(classifyResponse(...err(400, { code: 'json_validate_failed', message: 'Failed to validate JSON' }), out()).error_code).toBe('ai_truncated');
  });
  it('other 400 → ai_bad_request; 413 → ai_input_too_large; 401 → ai_auth; 429; 5xx', () => {
    expect(classifyResponse(...err(400, { code: 'invalid_request_error', message: 'x' }), out()).error_code).toBe('ai_bad_request');
    expect(classifyResponse(...err(413, { message: 'Request too large' }), out()).error_code).toBe('ai_input_too_large');
    expect(classifyResponse(...err(401, { message: 'Invalid API Key' }), out()).error_code).toBe('ai_auth');
    expect(classifyResponse(...err(429, { message: 'rate' }), out()).error_code).toBe('ai_rate_limited');
    expect(classifyResponse(502, '<html>bad gateway</html>', out()).error_code).toBe('ai_unavailable');
  });
});
