import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { default: authHandler } = await import('../api/auth.js');
const { default: visibilityHandler } = await import('../api/pin.js');
const { default: shareHandler } = await import('../api/share.js');
const { default: diagramHandler } = await import('../api/diagram.js');
const { default: archifyHandler } = await import('../api/archify.js');

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

async function ownerCookie() {
  const req = { method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = responseRecorder();
  await authHandler(req, res);
  return res.headers['set-cookie'].split(';')[0];
}

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

// --- PATCH /api/visibility is auth-only ---

test('PATCH /api/visibility rejects unauthenticated requests before touching Supabase', async () => {
  let called = false;
  global.fetch = async () => { called = true; throw new Error('must not run'); };
  try {
    const req = { method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true }, headers: {} };
    const res = responseRecorder();
    await visibilityHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(called, false);
  } finally { restoreFetch(); }
});

test('PATCH /api/visibility rejects invalid kind and invalid id even when authenticated', async () => {
  const cookie = await ownerCookie();
  const res1 = responseRecorder();
  await visibilityHandler({ method: 'PATCH', body: { id: 'abc1234567', kind: 'not-a-kind', is_public: true }, headers: { cookie } }, res1);
  assert.equal(res1.statusCode, 400);

  const res2 = responseRecorder();
  await visibilityHandler({ method: 'PATCH', body: { id: 'has spaces/slash', kind: 'paste', is_public: true }, headers: { cookie } }, res2);
  assert.equal(res2.statusCode, 400);

  const res3 = responseRecorder();
  await visibilityHandler({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: 'yes' }, headers: { cookie } }, res3);
  assert.equal(res3.statusCode, 400);
});

test('PATCH /api/visibility authenticated: publishes and unpublishes each kind', async () => {
  const cookie = await ownerCookie();
  for (const kind of ['paste', 'diagram', 'archify']) {
    let patchedTable, patchedBody;
    global.fetch = async (url, opts) => {
      patchedTable = String(url);
      patchedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => [{ owner_id: 1, id: 'abc1234567', is_public: patchedBody.is_public }] };
    };
    try {
      const res = responseRecorder();
      await visibilityHandler({ method: 'PATCH', body: { id: 'abc1234567', kind, is_public: true }, headers: { cookie } }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { ok: true, id: 'abc1234567', kind, is_public: true });
      assert.match(patchedTable, /id=eq\.abc1234567/);
      assert.deepEqual(patchedBody, { is_public: true });
    } finally { restoreFetch(); }
  }
});

test('PATCH /api/visibility surfaces a Supabase "not found" as a 404, not a false success', async () => {
  const cookie = await ownerCookie();
  global.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    const res = responseRecorder();
    await visibilityHandler({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true }, headers: { cookie } }, res);
    assert.equal(res.statusCode, 404);
  } finally { restoreFetch(); }
});

// --- POST create can never set is_public, no matter what the request body contains ---

test('POST /api/share ignores an is_public:true in the request body and always creates a private row', async () => {
  let insertedBody;
  global.fetch = async (url, opts) => {
    insertedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const req = { method: 'POST', body: { markdown: '# hi', is_public: true }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(insertedBody.is_public, false);
  } finally { restoreFetch(); }
});

test('POST /api/diagram ignores is_public:true in the request body', async () => {
  let insertedBody;
  global.fetch = async (url, opts) => {
    insertedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const req = { method: 'POST', body: { svg: '<svg></svg>', is_public: true }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await diagramHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(insertedBody.is_public, false);
  } finally { restoreFetch(); }
});

test('POST /api/archify ignores is_public:true in the request body', async () => {
  let insertedBody;
  global.fetch = async (url, opts) => {
    insertedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const req = {
      method: 'POST',
      body: { kind: 'architecture', html: '<svg></svg><html></html>', is_public: true },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = responseRecorder();
    await archifyHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(insertedBody.is_public, false);
  } finally { restoreFetch(); }
});
