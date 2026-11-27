import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { default: authHandler } = await import('../api/auth.js');
const { default: renderHandler } = await import('../api/render.js');
// /d/:id is served by api/render.js with kind=diagram since 2026-11-25 (vercel.json rewrite).
const diagramRenderHandler = (req, res) => renderHandler({ ...req, query: { ...req.query, kind: 'diagram' } }, res);
const { default: archifyRenderHandler } = await import('../api/archify-render.js');
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
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}

// Answers exactly one Supabase GET select with the given row (or no rows if row is null/undefined).
function mockRowFetch(row) {
  global.fetch = async () => ({ ok: true, json: async () => (row ? [row] : []) });
}

function mockDbErrorFetch() {
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
}

function mockThrowingFetch() {
  global.fetch = async () => { throw new Error('network down'); };
}

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

// --- HTML render routes (/v, /d, /a): anonymous + private -> same-URL login gate, no content leak ---

test('render.js: anonymous request to a private paste gets a login gate, never the title/content', async () => {
  mockRowFetch({ owner_id: 1, content: '# Super Secret Title\n\nsecret body', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const req = { query: { id: 'abc1234567' }, headers: {} };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.match(res.body, /sign in/i);
    assert.doesNotMatch(res.body, /Super Secret Title/);
    assert.doesNotMatch(res.body, /secret body/);
  } finally { restoreFetch(); }
});

test('render.js: owner (authenticated) sees a private paste', async () => {
  const cookie = await ownerCookie();
  mockRowFetch({ owner_id: 1, content: '# Owner Title\n\nbody', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const req = { query: { id: 'abc1234567' }, headers: { cookie } };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Owner Title/);
  } finally { restoreFetch(); }
});

test('render.js: anonymous sees a public paste', async () => {
  mockRowFetch({ owner_id: 1, content: '# Public Title\n\nbody', expires_at: '2999-01-01T00:00:00Z', is_public: true });
  try {
    const req = { query: { id: 'abc1234567' }, headers: {} };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Public Title/);
  } finally { restoreFetch(); }
});

test('render.js: stop-sharing (is_public: false again) re-denies anonymous access to the same id', async () => {
  mockRowFetch({ owner_id: 1, content: '# Was Public\n\nbody', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const req = { query: { id: 'abc1234567' }, headers: {} };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, /Was Public/);
  } finally { restoreFetch(); }
});

test('render.js: login gate reloads the same URL (no external redirect target embedded)', async () => {
  mockRowFetch({ owner_id: 1, content: '# X\n\nbody', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const req = { query: { id: 'abc1234567' }, headers: {} };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.match(res.body, /window\.location\.reload\(\)/);
    assert.doesNotMatch(res.body, /window\.location\.href\s*=/);
  } finally { restoreFetch(); }
});

test('render.js: Supabase error fails closed (never 200, never leaks content)', async () => {
  mockDbErrorFetch();
  try {
    const req = { query: { id: 'abc1234567' }, headers: {} };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(String(res.body), /secret/i);
  } finally { restoreFetch(); }

  mockThrowingFetch();
  try {
    const req = { query: { id: 'abc1234567' }, headers: {} };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.equal(res.statusCode, 503);
  } finally { restoreFetch(); }
});

test('render.js: expired row is denied even to a cookie-carrying request (fail closed, not "expired == public")', async () => {
  const cookie = await ownerCookie();
  mockRowFetch({ owner_id: 1, content: '# Expired\n\nbody', expires_at: '2000-01-01T00:00:00Z', is_public: true });
  try {
    const req = { query: { id: 'abc1234567' }, headers: { cookie } };
    const res = responseRecorder();
    await renderHandler(req, res);
    assert.equal(res.statusCode, 404);
  } finally { restoreFetch(); }
});

test('diagram-render.js (/d/:id): anonymous private deny, owner allow, public allow', async () => {
  const cookie = await ownerCookie();

  mockRowFetch({ owner_id: 1, svg: '<svg>secret-svg-marker</svg>', title: 'Secret Diagram', markdown: null, expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await diagramRenderHandler({ query: { id: 'diag123456' }, headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, /secret-svg-marker/);
  } finally { restoreFetch(); }

  mockRowFetch({ owner_id: 1, svg: '<svg>secret-svg-marker</svg>', title: 'Secret Diagram', markdown: null, expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await diagramRenderHandler({ query: { id: 'diag123456' }, headers: { cookie } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /secret-svg-marker/);
  } finally { restoreFetch(); }

  mockRowFetch({ owner_id: 1, svg: '<svg>public-svg-marker</svg>', title: 'Public Diagram', markdown: null, expires_at: '2999-01-01T00:00:00Z', is_public: true });
  try {
    const res = responseRecorder();
    await diagramRenderHandler({ query: { id: 'diag123456' }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /public-svg-marker/);
  } finally { restoreFetch(); }
});

test('archify-render.js (/a/:id): anonymous private deny, owner allow, public allow', async () => {
  const cookie = await ownerCookie();
  const html = '<!DOCTYPE html><html><body><svg></svg>secret-archify-marker</body></html>';

  mockRowFetch({ owner_id: 1, html, ir: {}, kind: 'architecture', title: 'Secret Arch', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await archifyRenderHandler({ query: { id: 'arch123456' }, headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, /secret-archify-marker/);
    assert.doesNotMatch(res.body, /Secret Arch/);
  } finally { restoreFetch(); }

  mockRowFetch({ owner_id: 1, html, ir: {}, kind: 'architecture', title: 'Secret Arch', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await archifyRenderHandler({ query: { id: 'arch123456' }, headers: { cookie } }, res);
    assert.equal(res.statusCode, 200);
    // Owner view is the wrapper page (iframe), not an inlined copy of the archify HTML.
    assert.doesNotMatch(res.body, /secret-archify-marker/);
    assert.match(res.body, /iframe/);
    assert.match(res.body, /\/api\/archify-html\?id=arch123456/);
  } finally { restoreFetch(); }

  mockRowFetch({ owner_id: 1, html, ir: {}, kind: 'architecture', title: 'Public Arch', expires_at: '2999-01-01T00:00:00Z', is_public: true });
  try {
    const res = responseRecorder();
    await archifyRenderHandler({ query: { id: 'arch123456' }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /iframe/);
  } finally { restoreFetch(); }
});

// --- Raw / IR endpoints: same enforcement, generic deny (no login UI expected here) ---

test('share.js GET (raw markdown): anonymous private deny, owner allow, public allow', async () => {
  const cookie = await ownerCookie();

  mockRowFetch({ owner_id: 1, content: 'secret-raw-markdown', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await shareHandler({ method: 'GET', query: { id: 'raw1234567' }, headers: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.notEqual(res.body, 'secret-raw-markdown');
  } finally { restoreFetch(); }

  mockRowFetch({ owner_id: 1, content: 'secret-raw-markdown', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await shareHandler({ method: 'GET', query: { id: 'raw1234567' }, headers: { cookie } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'secret-raw-markdown');
  } finally { restoreFetch(); }

  mockRowFetch({ owner_id: 1, content: 'public-raw-markdown', expires_at: '2999-01-01T00:00:00Z', is_public: true });
  try {
    const res = responseRecorder();
    await shareHandler({ method: 'GET', query: { id: 'raw1234567' }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'public-raw-markdown');
  } finally { restoreFetch(); }
});

test('diagram.js GET (raw SVG): anonymous private deny, public allow', async () => {
  mockRowFetch({ owner_id: 1, svg: '<svg>secret</svg>', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await diagramHandler({ method: 'GET', query: { id: 'sv12345678' }, headers: {} }, res);
    assert.equal(res.statusCode, 404);
  } finally { restoreFetch(); }

  mockRowFetch({ owner_id: 1, svg: '<svg>public</svg>', expires_at: '2999-01-01T00:00:00Z', is_public: true });
  try {
    const res = responseRecorder();
    await diagramHandler({ method: 'GET', query: { id: 'sv12345678' }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '<svg>public</svg>');
  } finally { restoreFetch(); }
});

test('archify.js GET (raw IR): anonymous private deny, public allow', async () => {
  mockRowFetch({ ir: { secret: true }, kind: 'workflow', title: 'Secret', expires_at: '2999-01-01T00:00:00Z', is_public: false });
  try {
    const res = responseRecorder();
    await archifyHandler({ method: 'GET', query: { id: 'ir12345678' }, headers: {} }, res);
    assert.equal(res.statusCode, 404);
  } finally { restoreFetch(); }

  mockRowFetch({ ir: { public: true }, kind: 'workflow', title: 'Public', expires_at: '2999-01-01T00:00:00Z', is_public: true });
  try {
    const res = responseRecorder();
    await archifyHandler({ method: 'GET', query: { id: 'ir12345678' }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { kind: 'workflow', title: 'Public', ir: { public: true } });
  } finally { restoreFetch(); }
});

// --- Missing / never-created id ---

// Multi-user (2026-11-27): a missing id must not look different from a private one, or a link
// would reveal that a document exists. Anonymous: the same 401 sign-in card; signed in: the same 404.
test('render.js: a never-created id gets exactly the answer a private one gets', async () => {
  const { userCookie } = await import('./_fakedb.mjs');
  const cookie = await userCookie(1);
  const answer = async (row, headers) => {
    mockRowFetch(row);
    try {
      const res = responseRecorder();
      await renderHandler({ query: { id: 'nonexistent1' }, headers }, res);
      return [res.statusCode, res.body];
    } finally { restoreFetch(); }
  };
  const privateRow = { owner_id: 2, content: '# Someone else\n\nbody', expires_at: '2999-01-01T00:00:00Z', is_public: false };
  const anonMissing = await answer(null, {});
  assert.equal(anonMissing[0], 401);
  assert.match(anonMissing[1], /id="pwd"/, 'anonymous: the sign-in card, so an owner can open their own link');
  assert.deepEqual(await answer(privateRow, {}), anonMissing);
  const signedMissing = await answer(null, { cookie });
  assert.equal(signedMissing[0], 404);
  assert.match(signedMissing[1], /This link has expired/);
  assert.deepEqual(await answer(privateRow, { cookie }), signedMissing, "another user's private document is the same 404 as a missing one");
});
