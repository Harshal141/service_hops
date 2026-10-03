const { MulterError } = require('multer');
const { errorHandler } = require('./errorHandler');
const { ConflictError, TooManyRequestsError, NotFoundError } = require('../utils/errors');

function run(err) {
  const res = {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
  errorHandler(err, { method: 'POST', originalUrl: '/x' }, res, () => {});
  return res;
}

describe('errorHandler', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
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
});
