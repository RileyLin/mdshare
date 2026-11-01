import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { default: authHandler } = await import('../api/auth.js');
const { default: shareHandler } = await import('../api/share.js');
const { default: diagramHandler } = await import('../api/diagram.js');
const { default: pinHandler } = await import('../api/pin.js');
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

// Each call gets its own fake source IP: auth.js's login rate limiter (AUTH_LIMIT = 5/hour,
// checkAuthRateLimit) is in-memory and keyed by IP, shared across the whole node --test process
// (auth.js is imported once, its rate-limit Map persists for every test file in this run). This
// suite alone calls ownerCookie() more than 5 times; reusing one fake IP across all of them would
// trip that limiter and 429 a later, unrelated test — not a bug in the feature, just shared
// module state colliding with test volume. A distinct IP per call keeps each call in its own
// bucket, matching how real distinct clients would never share a rate-limit window either.
let ownerCookieCallCount = 0;
async function ownerCookie() {
  ownerCookieCallCount += 1;
  const req = { method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: `10.77.0.${ownerCookieCallCount}` } };
  const res = responseRecorder();
  await authHandler(req, res);
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

// Routes a mock global.fetch across the several sequential Supabase calls one request can now
// trigger (token lookup, best-effort last_used_at touch, the actual content insert/select).
// First matching rule wins; anything unmatched gets a generic { ok: true } so the fire-and-forget
// touchLastUsed() call (which nothing awaits or asserts on) never needs its own rule.
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

// A fabricated, never-persisted-for-real token + its hash, wired into a fake DB row via `router`.
function fakeToken(raw, { id, name = 'test-agent', expiresAt = '2999-01-01T00:00:00Z', revokedAt = null } = {}) {
  const hash = sha256Hex(raw);
  return {
    raw,
    hash,
    lookupRule: {
      method: 'GET',
      test: new RegExp(`mdshare_agent_tokens\\?token_hash=eq\\.${hash}`),
      respond: async () => ({
        ok: true,
        json: async () => [{ id, name, expires_at: expiresAt, revoked_at: revokedAt }],
      }),
    },
  };
}

// ============================================================================
// Bearer resolution: absent header -> unchanged anonymous path
// ============================================================================

test('POST /api/share with no Authorization header: unchanged anonymous create, created_by_token is null', async () => {
  let insertedBody;
  global.fetch = router([
    { method: 'POST', test: /mdshare_pastes$/, respond: async (u, o) => { insertedBody = JSON.parse(o.body); return { ok: true, json: async () => ({}) }; } },
  ]);
  try {
    const req = { method: 'POST', body: { markdown: '# hi' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(insertedBody.is_public, false);
    assert.equal(insertedBody.created_by_token, null);
  } finally { restoreFetch(); }
});

// ============================================================================
// Valid token: create + read-own-only
// ============================================================================

test('POST /api/share with a valid bearer token: creation is attributed to that token', async () => {
  const t = fakeToken('mds_valid_token_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { id: 'tok_abc' });
  let insertedBody;
  global.fetch = router([
    t.lookupRule,
    { method: 'POST', test: /mdshare_pastes$/, respond: async (u, o) => { insertedBody = JSON.parse(o.body); return { ok: true, json: async () => ({}) }; } },
  ]);
  try {
    const req = { method: 'POST', body: { markdown: '# hi' }, headers: { authorization: `Bearer ${t.raw}` }, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(insertedBody.is_public, false, 'a bearer token can never make a row public on create');
    assert.equal(insertedBody.created_by_token, 'tok_abc');
  } finally { restoreFetch(); }
});

test('GET /api/share: a token can read back a private row it created itself', async () => {
  const t = fakeToken('mds_owner_read_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', { id: 'tok_owner' });
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_pastes\?id=eq\./, respond: async () => ({
      ok: true,
      json: async () => [{ content: 'own-private-content', expires_at: '2999-01-01T00:00:00Z', is_public: false, created_by_token: 'tok_owner' }],
    }) },
  ]);
  try {
    const req = { method: 'GET', query: { id: 'abc1234567' }, headers: { authorization: `Bearer ${t.raw}` } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'own-private-content');
  } finally { restoreFetch(); }
});

test('GET /api/share: a DIFFERENT valid token cannot read a private row it did not create (404, same as anonymous)', async () => {
  const t = fakeToken('mds_other_token_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', { id: 'tok_other' });
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_pastes\?id=eq\./, respond: async () => ({
      ok: true,
      json: async () => [{ content: 'not-yours', expires_at: '2999-01-01T00:00:00Z', is_public: false, created_by_token: 'tok_owner' }],
    }) },
  ]);
  try {
    const req = { method: 'GET', query: { id: 'abc1234567' }, headers: { authorization: `Bearer ${t.raw}` } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 404);
    assert.notEqual(res.body?.error === undefined ? res.body : JSON.stringify(res.body), 'not-yours');
  } finally { restoreFetch(); }
});

test('a token cannot claim a pre-existing row by id: an anonymously-created row (created_by_token null) stays unreadable to any token', async () => {
  const t = fakeToken('mds_cannot_claim_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', { id: 'tok_claim' });
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_diagrams\?id=eq\./, respond: async () => ({
      ok: true,
      json: async () => [{ svg: '<svg>anon</svg>', expires_at: '2999-01-01T00:00:00Z', is_public: false, created_by_token: null }],
    }) },
  ]);
  try {
    const req = { method: 'GET', query: { id: 'sv12345678' }, headers: { authorization: `Bearer ${t.raw}` } };
    const res = responseRecorder();
    await diagramHandler(req, res);
    assert.equal(res.statusCode, 404);
  } finally { restoreFetch(); }
});

test('public content is still readable by a valid token even though the token did not create it (is_public wins independently)', async () => {
  const t = fakeToken('mds_public_read_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', { id: 'tok_reader' });
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_diagrams\?id=eq\./, respond: async () => ({
      ok: true,
      json: async () => [{ svg: '<svg>public</svg>', expires_at: '2999-01-01T00:00:00Z', is_public: true, created_by_token: null }],
    }) },
  ]);
  try {
    const req = { method: 'GET', query: { id: 'sv12345678' }, headers: { authorization: `Bearer ${t.raw}` } };
    const res = responseRecorder();
    await diagramHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '<svg>public</svg>');
  } finally { restoreFetch(); }
});

// ============================================================================
// Invalid bearer must 401, never fall back to anonymous
// ============================================================================

test('revoked token: POST /api/share 401s and never touches the insert', async () => {
  const t = fakeToken('mds_revoked_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', { id: 'tok_revoked', revokedAt: '2026-01-01T00:00:00Z' });
  let insertCalled = false;
  global.fetch = router([
    t.lookupRule,
    { method: 'POST', test: /mdshare_pastes$/, respond: async () => { insertCalled = true; return { ok: true, json: async () => ({}) }; } },
  ]);
  try {
    const req = { method: 'POST', body: { markdown: '# hi' }, headers: { authorization: `Bearer ${t.raw}` }, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(insertCalled, false, 'a revoked bearer must never fall back to anonymous creation');
  } finally { restoreFetch(); }
});

test('expired token: GET /api/share 401s (fail closed, not "expired == readable")', async () => {
  const t = fakeToken('mds_expired_GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', { id: 'tok_expired', expiresAt: '2000-01-01T00:00:00Z' });
  global.fetch = router([t.lookupRule]);
  try {
    const req = { method: 'GET', query: { id: 'abc1234567' }, headers: { authorization: `Bearer ${t.raw}` } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 401);
  } finally { restoreFetch(); }
});

test('unknown token (not in the DB at all): 401', async () => {
  global.fetch = router([
    { method: 'GET', test: /mdshare_agent_tokens\?token_hash=eq\./, respond: async () => ({ ok: true, json: async () => [] }) },
  ]);
  try {
    const req = { method: 'POST', body: { svg: '<svg></svg>' }, headers: { authorization: 'Bearer mds_totally_unknown_HHHHHHHHHHHHHHHHHHHHHHHHHHHHH' }, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await diagramHandler(req, res);
    assert.equal(res.statusCode, 401);
  } finally { restoreFetch(); }
});

test('malformed bearer (too short) is rejected before any DB lookup', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('must not be called for a malformed bearer'); };
  try {
    const req = { method: 'POST', body: { markdown: '# hi' }, headers: { authorization: 'Bearer short' }, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(fetchCalled, false);
  } finally { restoreFetch(); }
});

test('a Supabase lookup error for the bearer fails closed (401), never treated as valid or as anonymous', async () => {
  const raw = 'mds_lookup_error_IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII';
  global.fetch = router([
    { method: 'GET', test: /mdshare_agent_tokens\?token_hash=eq\./, respond: async () => ({ ok: false, status: 500, text: async () => 'boom' }) },
  ]);
  try {
    const req = { method: 'POST', body: { markdown: '# hi' }, headers: { authorization: `Bearer ${raw}` }, socket: { remoteAddress: '127.0.0.1' } };
    const res = responseRecorder();
    await shareHandler(req, res);
    assert.equal(res.statusCode, 401);
  } finally { restoreFetch(); }
});

// ============================================================================
// A bearer token cannot toggle visibility or delete — those routes never added bearer support
// ============================================================================

test('PATCH /api/pin (visibility/pin) with only a bearer token, no owner cookie, is still 401', async () => {
  const t = fakeToken('mds_no_pin_power_JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ', { id: 'tok_nopin' });
  let patchCalled = false;
  global.fetch = router([
    t.lookupRule,
    { method: 'PATCH', test: /mdshare_pastes/, respond: async () => { patchCalled = true; return { ok: true, json: async () => [{}] }; } },
  ]);
  try {
    const req = { method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true }, headers: { authorization: `Bearer ${t.raw}` } };
    const res = responseRecorder();
    await pinHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(patchCalled, false, 'a bearer token must never be able to flip is_public');
  } finally { restoreFetch(); }
});

// ============================================================================
// Owner-only token management endpoints (api/auth.js)
// ============================================================================

test('POST /api/auth {action:create_token} requires the owner cookie', async () => {
  let insertCalled = false;
  global.fetch = router([
    { method: 'POST', test: /mdshare_agent_tokens$/, respond: async () => { insertCalled = true; return { ok: true, json: async () => [{}] }; } },
  ]);
  try {
    const req = { method: 'POST', body: { action: 'create_token', name: 'x' }, headers: {} };
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(insertCalled, false);
  } finally { restoreFetch(); }
});

test('POST /api/auth {action:create_token} (owner): returns the raw token exactly once, with a bounded expiry', async () => {
  const cookie = await ownerCookie();
  let insertedBody;
  global.fetch = router([
    { method: 'POST', test: /mdshare_agent_tokens$/, respond: async (u, o) => { insertedBody = JSON.parse(o.body); return { ok: true, json: async () => [{ created_at: '2026-09-25T00:00:00Z' }] }; } },
  ]);
  try {
    const req = { method: 'POST', body: { action: 'create_token', name: 'Kit', expires_in_days: 90 }, headers: { cookie } };
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, 'Kit');
    assert.ok(typeof res.body.token === 'string' && res.body.token.startsWith('mds_'));
    assert.ok(res.body.expires_at);
    // What actually got persisted has a hash, never the raw value.
    assert.equal(insertedBody.token_hash, sha256Hex(res.body.token));
    assert.equal(insertedBody.token_hash === res.body.token, false);
    assert.equal(JSON.stringify(insertedBody).includes(res.body.token), false, 'raw token must never appear in the persisted row');
  } finally { restoreFetch(); }
});

test('POST /api/auth {action:create_token} rejects a missing/empty name', async () => {
  const cookie = await ownerCookie();
  const req = { method: 'POST', body: { action: 'create_token', name: '' }, headers: { cookie } };
  const res = responseRecorder();
  await authHandler(req, res);
  assert.equal(res.statusCode, 400);
});

test('GET /api/auth?action=tokens requires the owner cookie and never returns token_hash', async () => {
  const unauthedReq = { method: 'GET', query: { action: 'tokens' }, headers: {} };
  const unauthedRes = responseRecorder();
  await authHandler(unauthedReq, unauthedRes);
  assert.equal(unauthedRes.statusCode, 401);

  const cookie = await ownerCookie();
  global.fetch = router([
    { method: 'GET', test: /mdshare_agent_tokens\?select=/, respond: async () => ({
      ok: true,
      json: async () => [{ id: 'tok_1', name: 'Kit', created_at: '2026-09-01T00:00:00Z', expires_at: '2999-01-01T00:00:00Z', revoked_at: null, last_used_at: null }],
    }) },
  ]);
  try {
    const req = { method: 'GET', query: { action: 'tokens' }, headers: { cookie } };
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.tokens.length, 1);
    assert.equal(res.body.tokens[0].status, 'active');
    assert.equal(JSON.stringify(res.body).includes('token_hash'), false);
  } finally { restoreFetch(); }
});

test('DELETE /api/auth {action:revoke_token} requires the owner cookie', async () => {
  const req = { method: 'DELETE', body: { action: 'revoke_token', id: 'tok_1' }, headers: {} };
  const res = responseRecorder();
  await authHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('DELETE /api/auth {action:revoke_token} (owner): revokes, is idempotent, and a revoked token then fails bearer auth', async () => {
  const cookie = await ownerCookie();
  global.fetch = router([
    { method: 'PATCH', test: /mdshare_agent_tokens\?id=eq\.tok_1&revoked_at=is\.null/, respond: async () => ({ ok: true, json: async () => [{ id: 'tok_1', revoked_at: '2026-09-25T00:00:00Z' }] }) },
  ]);
  try {
    const req = { method: 'DELETE', body: { action: 'revoke_token', id: 'tok_1' }, headers: { cookie } };
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, id: 'tok_1' });
  } finally { restoreFetch(); }

  // Second revoke of the same id: PATCH matches nothing (already revoked_at is not null), the
  // existence check finds it -> idempotent 200, not a false 404.
  global.fetch = router([
    { method: 'PATCH', test: /mdshare_agent_tokens\?id=eq\.tok_1&revoked_at=is\.null/, respond: async () => ({ ok: true, json: async () => [] }) },
    { method: 'GET', test: /mdshare_agent_tokens\?id=eq\.tok_1&select=id/, respond: async () => ({ ok: true, json: async () => [{ id: 'tok_1' }] }) },
  ]);
  try {
    const req = { method: 'DELETE', body: { action: 'revoke_token', id: 'tok_1' }, headers: { cookie } };
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 200);
  } finally { restoreFetch(); }
});

test('DELETE /api/auth {action:revoke_token} for a never-existing id is a 404', async () => {
  const cookie = await ownerCookie();
  global.fetch = router([
    { method: 'PATCH', test: /mdshare_agent_tokens\?id=eq\./, respond: async () => ({ ok: true, json: async () => [] }) },
    { method: 'GET', test: /mdshare_agent_tokens\?id=eq\..*select=id/, respond: async () => ({ ok: true, json: async () => [] }) },
  ]);
  try {
    const req = { method: 'DELETE', body: { action: 'revoke_token', id: 'tok_never_existed' }, headers: { cookie } };
    const res = responseRecorder();
    await authHandler(req, res);
    assert.equal(res.statusCode, 404);
  } finally { restoreFetch(); }
});

test('owner GET/POST(password) status-check paths are completely unaffected by the new action dispatch', async () => {
  const okRes = responseRecorder();
  await authHandler({ method: 'GET', headers: {}, query: {} }, okRes);
  assert.equal(okRes.statusCode, 401);
  assert.deepEqual(okRes.body, { ok: false });

  const cookie = await ownerCookie();
  const okRes2 = responseRecorder();
  await authHandler({ method: 'GET', headers: { cookie }, query: {} }, okRes2);
  assert.equal(okRes2.statusCode, 200);
  assert.deepEqual(okRes2.body, { ok: true });
});

test('owner may explicitly create a never-expiring token; false keeps finite expiry', async () => {
  const cookie = await ownerCookie();
  let inserted;
  global.fetch = router([{method:'POST',test:/mdshare_agent_tokens$/,respond:async(u,o)=>{inserted=JSON.parse(o.body);return {ok:true,json:async()=>[{}]};}}]);
  try {
    for (const never of [true, false]) {
      const res=responseRecorder();
      await authHandler({method:'POST',headers:{cookie},body:{action:'create_token',name:'expiry-test',scopes:['documents:read'],expires_in_days:30,never_expires:never}},res);
      assert.equal(res.statusCode,200);
      if(never){assert.equal(res.body.expires_at,null);assert.equal(inserted.expires_at,null);}
      else assert.ok(Date.parse(res.body.expires_at)>Date.now());
      assert.deepEqual(inserted.scopes,['documents:read']);
    }
  } finally {restoreFetch();}
});
test('never_expires rejects non-boolean inputs', async()=>{
 const cookie=await ownerCookie();
 for(const invalid of ['true',1,null]){
  const res=responseRecorder();await authHandler({method:'POST',headers:{cookie},body:{action:'create_token',name:'bad',never_expires:invalid}},res);assert.equal(res.statusCode,400);
 }
});
test('no-expiry bearer authenticates but revocation still wins',async()=>{
 const {resolveAgentToken}=await import('../api/_lib/agent-tokens.js');
 for(const revokedAt of [null,'2026-01-01T00:00:00Z']){
  const token=fakeToken('mds_never_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',{id:'tok_never',expiresAt:null,revokedAt});
  global.fetch=router([token.lookupRule]);
  try{const result=await resolveAgentToken({headers:{authorization:'Bearer '+token.raw}});assert.equal(result.valid,revokedAt===null);}finally{restoreFetch();}
 }
});
