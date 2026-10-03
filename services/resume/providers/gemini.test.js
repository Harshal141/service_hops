const { classifyResponse, buildBody } = require('./gemini');
const { baseResult } = require('./shared');

const out = () => baseResult('gemini', 'gemini-test');
const ok = (candidate) => JSON.stringify({
  candidates: [candidate],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
});

describe('gemini buildBody', () => {
  it('sends thinkingLevel and never thinkingBudget', () => {
    const b = buildBody({ system: 's', user: 'u', schema: { type: 'object', properties: {} }, maxOutputTokens: 8192 });
    expect(b.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(b.generationConfig).toMatchObject({ maxOutputTokens: 8192, temperature: 0, responseMimeType: 'application/json' });
  });
});

describe('gemini classifyResponse', () => {
  it('parses a good response and reads usage', () => {
    const r = classifyResponse(200, ok({ finishReason: 'STOP', content: { parts: [{ text: '{"a":1}' }] } }), out());
    expect(r).toMatchObject({ ok: true, json: { a: 1 }, finish_reason: 'STOP', usage: { in: 10, out: 5, thinking: 2 } });
  });
  it('ignores thought parts', () => {
    const r = classifyResponse(200, ok({ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hmm' }, { text: '{"a":1}' }] } }), out());
    expect(r.json).toEqual({ a: 1 });
  });
  it('MAX_TOKENS, or unterminated JSON → ai_truncated', () => {
    expect(classifyResponse(200, ok({ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a":' }] } }), out()).error_code).toBe('ai_truncated');
    expect(classifyResponse(200, ok({ finishReason: 'STOP', content: { parts: [{ text: '{"a": [1' }] } }), out()).error_code).toBe('ai_truncated');
  });
  it('blocked prompt, empty candidates, SAFETY / RECITATION → ai_blocked', () => {
    expect(classifyResponse(200, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), out()).error_code).toBe('ai_blocked');
    expect(classifyResponse(200, JSON.stringify({ candidates: [] }), out()).error_code).toBe('ai_blocked');
    expect(classifyResponse(200, ok({ finishReason: 'SAFETY' }), out()).error_code).toBe('ai_blocked');
    expect(classifyResponse(200, ok({ finishReason: 'RECITATION' }), out()).error_code).toBe('ai_blocked');
  });
  it('HTTP errors', () => {
    const body = JSON.stringify({ error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } });
    expect(classifyResponse(503, body, out())).toMatchObject({ ok: false, error_code: 'ai_unavailable', error_message: 'high demand' });
    expect(classifyResponse(429, '{}', out()).error_code).toBe('ai_rate_limited');
    expect(classifyResponse(400, '{"error":{"message":"bad"}}', out()).error_code).toBe('ai_bad_request');
    expect(classifyResponse(403, 'denied', out()).error_code).toBe('ai_auth');
  });
  it('a bad or revoked key arrives as HTTP 400 and is ai_auth, not ai_bad_request', () => {
    const invalid = JSON.stringify({ error: {
      code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
    } });
    expect(classifyResponse(400, invalid, out()).error_code).toBe('ai_auth');
    expect(classifyResponse(400, JSON.stringify({ error: { code: 400, status: 'PERMISSION_DENIED', message: 'x' } }), out()).error_code).toBe('ai_auth');
    expect(classifyResponse(400, JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad schema' } }), out()).error_code).toBe('ai_bad_request');
  });
});
