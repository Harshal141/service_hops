const Sentry = require('@sentry/node');
const { scrubEvent, currentTraceId } = require('./sentry');

describe('scrubEvent', () => {
  it('drops credential headers regardless of case and keeps the rest', () => {
    const event = {
      request: {
        headers: {
          Authorization: 'Bearer abc',
          cookie: 'a=b',
          'X-Internal-Secret': 's3cret',
          'user-agent': 'Mozilla/5.0',
          'x-env': 'prod',
        },
        cookies: { a: 'b' },
      },
    };
    expect(scrubEvent(event).request).toEqual({
      headers: { 'user-agent': 'Mozilla/5.0', 'x-env': 'prod' },
    });
  });

  it('passes through events without a request', () => {
    const event = { message: 'boom' };
    expect(scrubEvent(event)).toBe(event);
  });
});

describe('currentTraceId', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is null when Sentry is not running', () => {
    expect(currentTraceId()).toBeNull();
  });

  it('extracts the trace id from the sentry-trace header value', () => {
    vi.spyOn(Sentry, 'getTraceData').mockReturnValue({
      'sentry-trace': '771a43a4192642f0b136d5159a501700-b7ad6b7169203331-1',
    });
    expect(currentTraceId()).toBe('771a43a4192642f0b136d5159a501700');
  });
});
