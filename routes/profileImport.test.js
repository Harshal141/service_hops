// HTTP-level checks through the real app (server.js): upload limits handled by multer +
// errorHandler, and the mount order that keeps GET /profile/:handle reachable for 'import'.
// No DB and no AI: every request here is answered before the service would run.

process.env.NEON_STAGE_URL = 'postgresql://user:pass@localhost.invalid/db';
process.env.NEON_PROD_URL = 'postgresql://user:pass@localhost.invalid/db';
process.env.AUTH_SECRET = 'test-secret-for-profile-import-route-tests';
process.env.VERCEL = '1'; // server.js only listens outside Vercel

const { hkdf } = require('@panva/hkdf');
const db = require('../config/db');
const userService = require('../services/userService');
const resumeImportService = require('../services/resumeImportService');

db.testDBConnection = async () => {}; // server.js pings both DBs at load
const app = require('../server');

const USER = '550e8400-e29b-41d4-a716-446655440000';
let server;
let base;
let token;

async function sessionToken(payload) {
  const salt = 'authjs.session-token';
  const key = await hkdf('sha256', process.env.AUTH_SECRET, salt, `Auth.js Generated Encryption Key (${salt})`, 64);
  const { EncryptJWT } = await import('jose');
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256CBC-HS512' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .encrypt(key);
}

const upload = (form, headers = { authorization: `Bearer ${token}` }) =>
  fetch(`${base}/profile/import`, { method: 'POST', body: form, headers });

const pdfForm = (field, bytes) => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: 'application/pdf' }), 'resume.pdf');
  return form;
};

beforeAll(async () => {
  token = await sessionToken({ id: USER, env: 'stage' });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
afterEach(() => vi.restoreAllMocks());

describe('POST /profile/import', () => {
  it('413 file_too_big for a file over the limit, before the service runs', async () => {
    const spy = vi.spyOn(resumeImportService, 'importResume');
    const res = await upload(pdfForm('file', Buffer.alloc(resumeImportService.MAX_FILE_BYTES + 1, 0x41)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'That file is too big', code: 'file_too_big' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('400 no_file for a file in the wrong field, or no file at all', async () => {
    const wrong = await upload(pdfForm('resume', Buffer.from('%PDF-1.7')));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe('no_file');

    const form = new FormData();
    form.append('note', 'hello');
    const none = await upload(form);
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe('no_file');
  });

  it('401 without a session, before the body is read', async () => {
    const res = await upload(pdfForm('file', Buffer.from('%PDF-1.7')), {});
    expect(res.status).toBe(401);
  });

  it('400 for a non-numeric apply id', async () => {
    const res = await fetch(`${base}/profile/import/abc/apply`, {
      method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});

describe('mount order', () => {
  it('GET /profile/import still reaches the public profile route (a user handled "import")', async () => {
    const spy = vi.spyOn(userService, 'findByHandle').mockResolvedValue(null);
    const res = await fetch(`${base}/profile/import`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Profile not found' });
    expect(spy).toHaveBeenCalledWith('import', 'stage');
  });
});
