const { classifyHttp, parseModelJson } = require('./shared');

describe('classifyHttp', () => {
  it('maps statuses to error codes', () => {
    expect(classifyHttp(429)).toBe('ai_rate_limited');
    expect(classifyHttp(413)).toBe('ai_input_too_large');
    expect(classifyHttp(503)).toBe('ai_unavailable');
    expect(classifyHttp(500)).toBe('ai_unavailable');
    expect(classifyHttp(401)).toBe('ai_auth');
    expect(classifyHttp(403)).toBe('ai_auth');
    expect(classifyHttp(400)).toBe('ai_bad_request');
    expect(classifyHttp(404)).toBe('ai_bad_request');
  });
});

describe('parseModelJson', () => {
  it('flags cut-off JSON as truncated', () => {
    expect(parseModelJson('{"is_resume": true, "experience": [{"company": "A').error_code).toBe('ai_truncated');
  });
  it('flags balanced garbage and empty output as invalid', () => {
    expect(parseModelJson('{not json}').error_code).toBe('ai_invalid_output');
    expect(parseModelJson('  ').error_code).toBe('ai_invalid_output');
  });
  it('parses valid JSON', () => {
    expect(parseModelJson('{"a":1}').json).toEqual({ a: 1 });
  });
});

describe('post', () => {
  const { post } = require('./shared');
  afterEach(() => vi.unstubAllGlobals());

  it('sends JSON with the provider headers and hands the response to classify', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, text: async () => '{"ok":1}' }));
    vi.stubGlobal('fetch', fetchMock);
    const classify = vi.fn((status, body, out) => ({ ...out, ok: true, json: JSON.parse(body) }));
    const r = await post({ provider: 'groq', model: 'm', url: 'https://x.test', headers: { authorization: 'Bearer k' }, body: { a: 1 }, timeoutMs: 1000, classify });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json', authorization: 'Bearer k' } });
    expect(classify).toHaveBeenCalledWith(200, '{"ok":1}', expect.objectContaining({ provider: 'groq', model: 'm', http_status: 200 }));
    expect(r).toMatchObject({ ok: true, json: { ok: 1 } });
  });

  it('classifies network failures and timeouts without calling classify', async () => {
    const classify = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('fail'), { cause: { code: 'ECONNRESET' } }); }));
    expect(await post({ provider: 'gemini', model: 'm', url: 'u', headers: {}, body: {}, timeoutMs: 1000, classify }))
      .toMatchObject({ ok: false, error_code: 'ai_unavailable', error_message: 'network: ECONNRESET' });
    vi.stubGlobal('fetch', vi.fn((_u, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    expect((await post({ provider: 'gemini', model: 'm', url: 'u', headers: {}, body: {}, timeoutMs: 5, classify })).error_code).toBe('ai_timeout');
    expect(classify).not.toHaveBeenCalled();
  });
});
