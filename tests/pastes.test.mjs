// Owner-dashboard GET /api/pastes regression tests (fix added 2026-10-08, live-production bug
// report: filtering/pagination must happen before the limit, plus a genuine latest-sort option).
// Builds the same lightweight fetch-router/response-recorder fixtures used in
// tests/scopes.test.mjs / tests/catalog.test.mjs — duplicated here rather than imported, keeping
// each test file independently runnable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MDSHARE_PASSWORD = '***';
process.env.MDSHARE_HMAC_SECRET = '***';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = '***';

const { default: authHandler } = await import('../api/auth.js');
const { default: pastesHandler } = await import('../api/pastes.js');

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

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

async function ownerCookie() {
  const req = { method: 'POST', body: { password: '***' }, headers: {} };
  const res = responseRecorder();
  await authHandler(req, res);
  return res.headers['set-cookie'].split(';')[0];
}

function router(rules) {
  return async (url) => {
    for (const r of rules) {
      if (r.test.test(String(url))) return r.respond(url);
    }
    return { ok: true, json: async () => [] };
  };
}

test('GET /api/pastes (owner): the expiry filter is a real Supabase query-string parameter on every one of the three per-table requests, not a post-fetch JS filter applied after an unconditional limit', async () => {
  const cookie = await ownerCookie();
  const urls = [];
  global.fetch = router([
    { test: /mdshare_pastes\?/, respond: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } },
    { test: /mdshare_diagrams\?/, respond: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } },
    { test: /mdshare_archify\?/, respond: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } },
  ]);
  try {
    const req = { method: 'GET', query: {}, headers: { cookie } };
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(urls.length, 3);
    for (const u of urls) {
      // The filter must appear in the same query string as limit=100, i.e. applied by Postgres
      // itself as part of the bounded fetch -- not something this handler does afterward in JS.
      assert.ok(u.includes('or=(expires_at.gt.'), `expected a real server-side expiry filter in: ${u}`);
      assert.ok(u.includes('pinned.eq.true'));
      assert.ok(u.includes('limit=100'));
    }
  } finally { restoreFetch(); }
});

test('GET /api/pastes (owner): an expired, non-pinned, non-returned-by-mock row never reaches the response (defense-in-depth JS filter still holds if a stale mock ever violated the server-side contract)', async () => {
  const cookie = await ownerCookie();
  const now = Date.now();
  const past = new Date(now - 86400000).toISOString();
  const future = new Date(now + 86400000).toISOString();
  global.fetch = router([
    { test: /mdshare_pastes\?/, respond: async () => ({ ok: true, json: async () => [
      { id: 'fresh', title: 'Fresh', content: '# Fresh\nhi', created_at: new Date(now).toISOString(), expires_at: future, pinned: false, is_public: false },
      // A mock that violates the server-side contract (simulates a stale/misbehaving backend) --
      // the handler's own JS filter must still exclude it as defense-in-depth.
      { id: 'stale', title: 'Stale', content: '# Stale\nold', created_at: past, expires_at: past, pinned: false, is_public: false },
    ] }) },
    { test: /mdshare_diagrams\?/, respond: async () => ({ ok: true, json: async () => [] }) },
    { test: /mdshare_archify\?/, respond: async () => ({ ok: true, json: async () => [] }) },
  ]);
  try {
    const req = { method: 'GET', query: {}, headers: { cookie } };
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.equal(res.statusCode, 200);
    const ids = res.body.map((r) => r.id);
    assert.deepEqual(ids, ['fresh']);
  } finally { restoreFetch(); }
});

test('GET /api/pastes (owner): ?sort=latest sorts purely by created_at desc, ignoring pinned priority', async () => {
  const cookie = await ownerCookie();
  const now = Date.now();
  const future = new Date(now + 86400000).toISOString();
  global.fetch = router([
    { test: /mdshare_pastes\?/, respond: async () => ({ ok: true, json: async () => [
      { id: 'old-pinned', title: 'Old pinned', content: '# Old', created_at: new Date(now - 3600000).toISOString(), expires_at: future, pinned: true, is_public: false },
      { id: 'new-unpinned', title: 'New', content: '# New', created_at: new Date(now).toISOString(), expires_at: future, pinned: false, is_public: false },
    ] }) },
    { test: /mdshare_diagrams\?/, respond: async () => ({ ok: true, json: async () => [] }) },
    { test: /mdshare_archify\?/, respond: async () => ({ ok: true, json: async () => [] }) },
  ]);
  try {
    const req = { method: 'GET', query: { sort: 'latest' }, headers: { cookie } };
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.deepEqual(res.body.map((r) => r.id), ['new-unpinned', 'old-pinned'], '?sort=latest must put the newest row first even though the other row is pinned');
  } finally { restoreFetch(); }
});

test('GET /api/pastes (owner): default (no ?sort) keeps pinned-first priority, unaffected by the fix', async () => {
  const cookie = await ownerCookie();
  const now = Date.now();
  const future = new Date(now + 86400000).toISOString();
  global.fetch = router([
    { test: /mdshare_pastes\?/, respond: async () => ({ ok: true, json: async () => [
      { id: 'old-pinned', title: 'Old pinned', content: '# Old', created_at: new Date(now - 3600000).toISOString(), expires_at: future, pinned: true, is_public: false },
      { id: 'new-unpinned', title: 'New', content: '# New', created_at: new Date(now).toISOString(), expires_at: future, pinned: false, is_public: false },
    ] }) },
    { test: /mdshare_diagrams\?/, respond: async () => ({ ok: true, json: async () => [] }) },
    { test: /mdshare_archify\?/, respond: async () => ({ ok: true, json: async () => [] }) },
  ]);
  try {
    const req = { method: 'GET', query: {}, headers: { cookie } };
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.deepEqual(res.body.map((r) => r.id), ['old-pinned', 'new-unpinned'], 'default behavior (pinned first) must be unchanged');
  } finally { restoreFetch(); }
});

test('GET /api/pastes (owner): order clause switches to pure created_at.desc in the actual request URL when ?sort=latest', async () => {
  const cookie = await ownerCookie();
  const urls = [];
  global.fetch = router([
    { test: /mdshare_pastes\?/, respond: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } },
    { test: /mdshare_diagrams\?/, respond: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } },
    { test: /mdshare_archify\?/, respond: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } },
  ]);
  try {
    const req = { method: 'GET', query: { sort: 'latest' }, headers: { cookie } };
    const res = responseRecorder();
    await pastesHandler(req, res);
    for (const u of urls) {
      assert.ok(u.includes('order=created_at.desc'), `expected pure-recency order in: ${u}`);
      assert.ok(!u.includes('order=pinned.desc'), `pinned priority must not appear in the query when sort=latest: ${u}`);
    }
  } finally { restoreFetch(); }
});
