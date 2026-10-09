// Scope model regression tests (AGENT-SEARCH-PLAN.md, added 2026-10-08). Builds on the fixtures
// and conventions already established in tests/agent-auth.test.mjs: a `router(rules)` fake
// global.fetch and a `fakeToken(raw, {...})` helper, duplicated here (not imported) because that
// file doesn't export them — keeping this suite self-contained and independently runnable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { default: authHandler } = await import('../api/auth.js');
const { default: shareHandler } = await import('../api/share.js');
const { default: pinHandler } = await import('../api/pin.js');
const { default: pastesHandler } = await import('../api/pastes.js');
const { sha256Hex } = await import('../api/_lib/agent-tokens.js');

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

let ipCounter = 0;
function fakeReq(overrides) {
  ipCounter += 1;
  return { headers: {}, socket: { remoteAddress: `10.88.0.${ipCounter}` }, ...overrides };
}

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

function router(rules) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    for (const r of rules) {
      if (r.method && r.method !== method) continue;
      if (r.test.test(String(url))) return r.respond(url, opts);
    }
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
}

function fakeToken(raw, { id, name = 'test-agent', expiresAt = '2999-01-01T00:00:00Z', revokedAt = null, scopes = null } = {}) {
  const hash = sha256Hex(raw);
  return {
    raw,
    hash,
    id,
    lookupRule: {
      method: 'GET',
      test: new RegExp(`mdshare_agent_tokens\\?token_hash=eq\\.${hash}`),
      respond: async () => ({
        ok: true,
        json: async () => [{ id, name, expires_at: expiresAt, revoked_at: revokedAt, scopes }],
      }),
    },
  };
}

// ============================================================================
// Legacy tokens (scopes: null) are completely unaffected by the scope model
// ============================================================================

test('legacy token (scopes: null): create still unconditional, unaffected by documents:write gate', async () => {
  const t = fakeToken('mds_legacy_create_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { id: 'tok_legacy1', scopes: null });
  let insertedBody;
  global.fetch = router([
    t.lookupRule,
    { method: 'POST', test: /mdshare_pastes$/, respond: async (u, o) => { insertedBody = JSON.parse(o.body); return { ok: true, json: async () => ({}) }; } },
  ]);
  try {
    const req = fakeReq({ method: 'POST', body: { markdown: '# hi' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(insertedBody.created_by_token, 'tok_legacy1');
  } finally { restoreFetch(); }
});

test('legacy token (scopes: null): denied the new catalog mode (403, not silently granted)', async () => {
  const t = fakeToken('mds_legacy_catalog_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', { id: 'tok_legacy2', scopes: null });
  global.fetch = router([t.lookupRule]);
  try {
    const req = fakeReq({ method: 'GET', query: {}, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.equal(res.statusCode, 403);
  } finally { restoreFetch(); }
});

test('legacy token (scopes: null): denied publish on its own row (403/401, no scope at all)', async () => {
  const t = fakeToken('mds_legacy_publish_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', { id: 'tok_legacy3', scopes: null });
  let patchCalled = false;
  global.fetch = router([
    t.lookupRule,
    { method: 'PATCH', test: /mdshare_pastes/, respond: async () => { patchCalled = true; return { ok: true, json: async () => [{}] }; } },
  ]);
  try {
    const req = fakeReq({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pinHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(patchCalled, false);
  } finally { restoreFetch(); }
});

// ============================================================================
// Scope isolation: a scoped token with exactly one scope cannot use the other two
// ============================================================================

test('scoped token with ONLY documents:write: can create, 403 on catalog, 403 on publish', async () => {
  const t = fakeToken('mds_write_only_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', { id: 'tok_write', scopes: ['documents:write'] });

  global.fetch = router([t.lookupRule, { method: 'POST', test: /mdshare_pastes$/, respond: async () => ({ ok: true, json: async () => ({}) }) }]);
  try {
    const req = fakeReq({ method: 'POST', body: { markdown: '# hi' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 200, 'documents:write grants create');
  } finally { restoreFetch(); }

  global.fetch = router([t.lookupRule]);
  try {
    const req = fakeReq({ method: 'GET', query: { q: 'x' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.equal(res.statusCode, 403, 'documents:write alone does not grant catalog read');
  } finally { restoreFetch(); }

  global.fetch = router([t.lookupRule]);
  try {
    const req = fakeReq({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pinHandler(req, res);
    assert.equal(res.statusCode, 401, 'documents:write alone does not grant publish');
  } finally { restoreFetch(); }
});

test('scoped token with ONLY documents:read: 403 on create, can search catalog, 403/401 on publish', async () => {
  const t = fakeToken('mds_read_only_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', { id: 'tok_read', scopes: ['documents:read'] });

  let insertCalled = false;
  global.fetch = router([t.lookupRule, { method: 'POST', test: /mdshare_pastes$/, respond: async () => { insertCalled = true; return { ok: true, json: async () => ({}) }; } }]);
  try {
    const req = fakeReq({ method: 'POST', body: { markdown: '# hi' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 403, 'documents:read alone does not grant create');
    assert.equal(insertCalled, false);
  } finally { restoreFetch(); }

  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_pastes\?/, respond: async () => ({ ok: true, json: async () => [] }) },
    { method: 'GET', test: /mdshare_diagrams\?/, respond: async () => ({ ok: true, json: async () => [] }) },
    { method: 'GET', test: /mdshare_archify\?/, respond: async () => ({ ok: true, json: async () => [] }) },
  ]);
  try {
    const req = fakeReq({ method: 'GET', query: {}, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.equal(res.statusCode, 200, 'documents:read grants catalog access');
    assert.ok(Array.isArray(res.body.items));
  } finally { restoreFetch(); }

  global.fetch = router([t.lookupRule]);
  try {
    const req = fakeReq({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pinHandler(req, res);
    assert.equal(res.statusCode, 401, 'documents:read alone does not grant publish');
  } finally { restoreFetch(); }
});

test('scoped token with ONLY documents:publish: 403 on create, 403 on catalog, can publish own row, denied on a non-own row', async () => {
  const t = fakeToken('mds_publish_only_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', { id: 'tok_pub', scopes: ['documents:publish'] });

  let insertCalled = false;
  global.fetch = router([t.lookupRule, { method: 'POST', test: /mdshare_pastes$/, respond: async () => { insertCalled = true; return { ok: true, json: async () => ({}) }; } }]);
  try {
    const req = fakeReq({ method: 'POST', body: { markdown: '# hi' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(insertCalled, false);
  } finally { restoreFetch(); }

  global.fetch = router([t.lookupRule]);
  try {
    const req = fakeReq({ method: 'GET', query: {}, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.equal(res.statusCode, 403);
  } finally { restoreFetch(); }

  // Owns the row -> publish succeeds
  let patchedBody;
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_pastes\?id=eq\./, respond: async () => ({ ok: true, json: async () => [{ created_by_token: 'tok_pub' }] }) },
    { method: 'PATCH', test: /mdshare_pastes\?id=eq\./, respond: async (u, o) => { patchedBody = JSON.parse(o.body); return { ok: true, json: async () => [{ id: 'abc1234567', is_public: true }] }; } },
  ]);
  try {
    const req = fakeReq({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pinHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(patchedBody.is_public, true);
  } finally { restoreFetch(); }

  // Does NOT own the row -> denied, even though it holds documents:publish
  let patchCalled = false;
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_pastes\?id=eq\./, respond: async () => ({ ok: true, json: async () => [{ created_by_token: 'tok_someone_else' }] }) },
    { method: 'PATCH', test: /mdshare_pastes\?id=eq\./, respond: async () => { patchCalled = true; return { ok: true, json: async () => [{}] }; } },
  ]);
  try {
    const req = fakeReq({ method: 'PATCH', body: { id: 'xyz1234567', kind: 'paste', is_public: true }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await pinHandler(req, res);
    assert.equal(res.statusCode, 404, 'own-row-only enforcement: documents:publish never applies to another token\'s row');
    assert.equal(patchCalled, false);
  } finally { restoreFetch(); }
});

// ============================================================================
// Cross-token read with explicit documents:read scope
// ============================================================================

test('cross-token read: a token with documents:read can read a DIFFERENT token\'s private row', async () => {
  const t = fakeToken('mds_cross_read_GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', { id: 'tok_reader', scopes: ['documents:read'] });
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_pastes\?id=eq\./, respond: async () => ({
      ok: true,
      json: async () => [{ content: 'someone-elses-private-content', expires_at: '2999-01-01T00:00:00Z', is_public: false, created_by_token: 'tok_other_owner' }],
    }) },
  ]);
  try {
    const req = fakeReq({ method: 'GET', query: { id: 'abc1234567' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'someone-elses-private-content');
  } finally { restoreFetch(); }
});

// ============================================================================
// Owner-only token management is never reachable via a bearer token
// ============================================================================

test('scopes validation: unknown scope string is rejected with 400 before any Supabase call', async () => {
  const req = fakeReq({ method: 'POST', body: { password: 'test-password' }, headers: {} });
  const loginRes = responseRecorder();
  await authHandler(req, loginRes);
  const cookie = loginRes.headers['set-cookie'].split(';')[0];

  let insertCalled = false;
  global.fetch = router([{ method: 'POST', test: /mdshare_agent_tokens$/, respond: async () => { insertCalled = true; return { ok: true, json: async () => [{}] }; } }]);
  try {
    const createReq = fakeReq({ method: 'POST', body: { action: 'create_token', name: 'x', scopes: ['documents:read', 'documents:delete'] }, headers: { cookie } });
    const res = responseRecorder();
    await authHandler(createReq, res);
    assert.equal(res.statusCode, 400);
    assert.equal(insertCalled, false);
  } finally { restoreFetch(); }
});

test('scopes validation: omitting scopes entirely still produces a legacy (scopes: null) token', async () => {
  const req = fakeReq({ method: 'POST', body: { password: 'test-password' }, headers: {} });
  const loginRes = responseRecorder();
  await authHandler(req, loginRes);
  const cookie = loginRes.headers['set-cookie'].split(';')[0];

  let insertedBody;
  global.fetch = router([{ method: 'POST', test: /mdshare_agent_tokens$/, respond: async (u, o) => { insertedBody = JSON.parse(o.body); return { ok: true, json: async () => [{ created_at: '2026-10-08T00:00:00Z' }] }; } }]);
  try {
    const createReq = fakeReq({ method: 'POST', body: { action: 'create_token', name: 'legacy-style' }, headers: { cookie } });
    const res = responseRecorder();
    await authHandler(createReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.scopes, null);
    assert.equal('scopes' in insertedBody, false, 'omitted scopes field is never sent to Supabase, leaving the DB column at its null default');
  } finally { restoreFetch(); }
});

test('scopes validation: an explicit array is stored verbatim and returned in the create response', async () => {
  const req = fakeReq({ method: 'POST', body: { password: 'test-password' }, headers: {} });
  const loginRes = responseRecorder();
  await authHandler(req, loginRes);
  const cookie = loginRes.headers['set-cookie'].split(';')[0];

  let insertedBody;
  global.fetch = router([{ method: 'POST', test: /mdshare_agent_tokens$/, respond: async (u, o) => { insertedBody = JSON.parse(o.body); return { ok: true, json: async () => [{ created_at: '2026-10-08T00:00:00Z' }] }; } }]);
  try {
    const createReq = fakeReq({ method: 'POST', body: { action: 'create_token', name: 'scoped-agent', scopes: ['documents:read', 'documents:read', 'documents:write'] }, headers: { cookie } });
    const res = responseRecorder();
    await authHandler(createReq, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.scopes, ['documents:read', 'documents:write'], 'duplicates are deduped');
    assert.deepEqual(insertedBody.scopes, ['documents:read', 'documents:write']);
  } finally { restoreFetch(); }
});

// ============================================================================
// Agent auth introspection (whoami)
// ============================================================================

test('GET /api/auth?action=whoami: no header -> 401', async () => {
  const req = fakeReq({ method: 'GET', query: { action: 'whoami' } });
  const res = responseRecorder();
  await authHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('GET /api/auth?action=whoami: invalid bearer -> 401, never falls back to owner-cookie status', async () => {
  global.fetch = router([
    { method: 'GET', test: /mdshare_agent_tokens\?token_hash=eq\./, respond: async () => ({ ok: true, json: async () => [] }) },
  ]);
  try {
    const req = fakeReq({ method: 'GET', query: { action: 'whoami' }, headers: { authorization: 'Bearer mds_unknown_HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH' } });
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 401);
  } finally { restoreFetch(); }
});

test('GET /api/auth?action=whoami: valid scoped token -> its own id/name/scopes, legacy:false, no other data', async () => {
  const t = fakeToken('mds_whoami_IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII', { id: 'tok_who', name: 'Kit-whoami', scopes: ['documents:read'] });
  global.fetch = router([t.lookupRule]);
  try {
    const req = fakeReq({ method: 'GET', query: { action: 'whoami' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 'tok_who');
    assert.equal(res.body.name, 'Kit-whoami');
    assert.equal(res.body.legacy, false);
    assert.deepEqual(res.body.scopes, ['documents:read']);
    assert.equal('token_hash' in res.body, false);
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally { restoreFetch(); }
});

test('GET /api/auth?action=whoami: valid legacy token -> legacy:true, scopes: []', async () => {
  const t = fakeToken('mds_whoami_legacy_JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ', { id: 'tok_who_legacy', scopes: null });
  global.fetch = router([t.lookupRule]);
  try {
    const req = fakeReq({ method: 'GET', query: { action: 'whoami' }, headers: { authorization: `Bearer ${t.raw}` } });
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.legacy, true);
    assert.deepEqual(res.body.scopes, []);
  } finally { restoreFetch(); }
});
