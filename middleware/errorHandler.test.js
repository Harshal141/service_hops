const Sentry = require('@sentry/node');
const { MulterError } = require('multer');
const { errorHandler } = require('./errorHandler');
const { ConflictError, TooManyRequestsError, NotFoundError } = require('../utils/errors');

function run(err, req = { method: 'POST', originalUrl: '/x' }) {
  const res = {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
  errorHandler(err, req, res, () => {});
  return res;
}

describe('errorHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends code only when the error has one', () => {
    expect(run(new NotFoundError('Nope')).body).toEqual({ error: 'Nope' });
    expect(run(new ConflictError('Busy', 'already_processing'))).toMatchObject({ statusCode: 409, body: { error: 'Busy', code: 'already_processing' } });
  });

  it('sets Retry-After for 429s', () => {
    const r = run(new TooManyRequestsError('Slow down', 'busy', 30));
    expect(r).toMatchObject({ statusCode: 429, headers: { 'Retry-After': '30' }, body: { code: 'busy' } });
  });

  it('maps multer errors', () => {
    expect(run(new MulterError('LIMIT_FILE_SIZE'))).toMatchObject({ statusCode: 413, body: { code: 'file_too_big' } });
    expect(run(new MulterError('LIMIT_UNEXPECTED_FILE', 'other'))).toMatchObject({ statusCode: 400, body: { code: 'no_file' } });
    expect(run(new MulterError('LIMIT_PART_COUNT')).body).toEqual({ error: 'Invalid upload' });
  });

  it('maps JSON body errors and never leaks unknown messages', () => {
    expect(run(Object.assign(new Error('too large'), { type: 'entity.too.large' })).statusCode).toBe(413);
    expect(run(new Error('secret detail'))).toMatchObject({ statusCode: 500, body: { error: 'Internal error' } });
  });

  it('logs handled errors with env and user, so they show up in runtime logs', () => {
    run(new ConflictError('Busy', 'already_processing'), { method: 'POST', originalUrl: '/x', env: 'prod', userId: 'u1' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/409 already_processing on POST \/x env=prod user=u1/));
  });

  it('adds the active trace id to the envelope and the log line', () => {
    vi.spyOn(Sentry, 'getTraceData').mockReturnValue({ 'sentry-trace': 'abc123-def456-1' });
    expect(run(new NotFoundError('Nope')).body).toEqual({ error: 'Nope', trace_id: 'abc123' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/trace=abc123/));
  });

  it('reports an unhandled error to Sentry as an exception', () => {
    const capture = vi.spyOn(Sentry, 'captureException').mockReturnValue('id');
    const err = new Error('secret detail');
    run(err);
    expect(capture).toHaveBeenCalledWith(err);
  });

  it('turns a statement timeout into a 503 rather than a generic 500', () => {
    expect(run(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })).statusCode).toBe(503);
  });
});
