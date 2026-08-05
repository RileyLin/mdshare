import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { default: authHandler } = await import('../api/auth.js');
const { default: shareHandler } = await import('../api/share.js');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; },
  };
}

async function authenticatedCookie() {
  const req = {
    method: 'POST',
    body: { password: 'test-password' },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = responseRecorder();
  await authHandler(req, res);
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}

test('DELETE rejects unauthenticated requests before touching Supabase', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('must not run'); };
  try {
    const req = { method: 'DELETE', query: { id: 'paste-1' }, headers: {} };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('authenticated DELETE requires an id', async () => {
  const cookie = await authenticatedCookie();
  const req = { method: 'DELETE', query: {}, headers: { cookie } };
  const res = responseRecorder();
  await shareHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Missing id' });
});

test('authenticated DELETE removes the requested paste', async () => {
  const cookie = await authenticatedCookie();
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };
  try {
    const req = { method: 'DELETE', query: { id: 'paste/with spaces' }, headers: { cookie } };
    const res = responseRecorder();
    await shareHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, deleted: 'paste/with spaces' });
    assert.equal(request.options.method, 'DELETE');
    assert.match(request.url, /mdshare_pastes\?id=eq\.paste%2Fwith%20spaces$/);
    assert.equal(request.options.headers.Authorization, 'Bearer test-service-key');
  } finally {
    global.fetch = originalFetch;
  }
});

test('rendered delete button has a complete browser-side handler', () => {
  const source = fs.readFileSync(new URL('../api/render.js', import.meta.url), 'utf8');
  assert.match(source, /id="btn-delete" onclick="deletePaste\(\)"/);
  assert.match(source, /async function deletePaste\(\)/);
  assert.match(source, /window\.confirm\('Delete this paste permanently\? This cannot be undone\.'\)/);
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /encodeURIComponent\(pasteId\)/);
  assert.match(source, /window\.location\.replace\('\/dashboard\?deleted=1'\)/);
  assert.match(source, /⚠ Failed — retry/);
});
