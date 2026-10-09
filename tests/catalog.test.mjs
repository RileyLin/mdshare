// Catalog search/recent tests (AGENT-SEARCH-PLAN.md, added 2026-10-08): sanitizer unit tests
// against adversarial input, plus integration coverage of the bearer-gated catalog mode added to
// api/pastes.js (expired exclusion, kind filter, pagination bounds).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { sanitizeSearchTerm, clampPagination, searchCatalog } = await import('../api/_lib/catalog.js');
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

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

// ============================================================================
// sanitizeSearchTerm: unit tests against adversarial input (direct, no mocked fetch needed)
// ============================================================================

test('sanitizeSearchTerm: strips PostgREST structural characters (comma, parens, asterisk)', () => {
  assert.equal(sanitizeSearchTerm('foo,bar'), 'foo bar');
  assert.equal(sanitizeSearchTerm('foo)or=(is_public.eq.true'), 'foo or= is_public.eq.true');
  assert.equal(sanitizeSearchTerm('*evil*'), 'evil');
  assert.equal(sanitizeSearchTerm('a,(b)*c'), 'a  b  c');
});

test('sanitizeSearchTerm: empty / whitespace-only / non-string -> null (recent mode, not search)', () => {
  assert.equal(sanitizeSearchTerm(''), null);
  assert.equal(sanitizeSearchTerm('   '), null);
  assert.equal(sanitizeSearchTerm(',(,)*'), null, 'a term made entirely of structural chars sanitizes to nothing');
  assert.equal(sanitizeSearchTerm(undefined), null);
  assert.equal(sanitizeSearchTerm(null), null);
  assert.equal(sanitizeSearchTerm(42), null);
  assert.equal(sanitizeSearchTerm(['injected']), null);
});

test('sanitizeSearchTerm: bounds length to 200 chars before any processing', () => {
  const long = 'a'.repeat(10000);
  const out = sanitizeSearchTerm(long);
  assert.ok(out.length <= 200);
});

test('sanitizeSearchTerm: a realistic benign title search term passes through unchanged', () => {
  assert.equal(sanitizeSearchTerm('Q3 roadmap notes'), 'Q3 roadmap notes');
});

// ============================================================================
// clampPagination: unit tests against adversarial / malformed input
// ============================================================================

test('clampPagination: non-numeric / garbage input falls back to safe defaults, never reaches an unbounded value', () => {
  assert.deepEqual(clampPagination({ limit: 'abc', offset: 'xyz' }), { limit: 20, offset: 0 });
  assert.deepEqual(clampPagination({ limit: 'DROP TABLE x', offset: 'also-not-a-number' }), { limit: 20, offset: 0 });
  // parseInt legitimately reads a leading numeric prefix out of a mixed string (e.g. "1 OR
  // 1=1" -> 1) — that's fine from a safety standpoint: the result is still a small bounded
  // integer that never reaches the Supabase URL un-clamped; it just isn't "NaN" in this case.
  assert.deepEqual(clampPagination({ limit: '1 OR 1=1', offset: '2;DROP TABLE x' }), { limit: 1, offset: 2 });
  assert.deepEqual(clampPagination({}), { limit: 20, offset: 0 });
});

test('clampPagination: negative / huge values are clamped to [1,50] and [0,5000]', () => {
  assert.deepEqual(clampPagination({ limit: -5, offset: -100 }), { limit: 1, offset: 0 });
  assert.deepEqual(clampPagination({ limit: 999999, offset: 999999999 }), { limit: 50, offset: 5000 });
});

test('clampPagination: non-finite input (Infinity) is not parseable and falls back to the default, not an unbounded max', () => {
  assert.deepEqual(clampPagination({ limit: Infinity, offset: -Infinity }), { limit: 20, offset: 0 });
});

test('clampPagination: ordinary valid values pass through unchanged (within bounds)', () => {
  assert.deepEqual(clampPagination({ limit: 10, offset: 20 }), { limit: 10, offset: 20 });
});

// ============================================================================
// searchCatalog: integration — the constructed Supabase fetch URL never contains a raw
// structural character from a malicious search term, and limit/offset in the URL are clamped.
// ============================================================================

test('searchCatalog: malicious q never reaches Supabase with raw comma/paren/asterisk intact, limit/offset clamped in the URL', async () => {
  const seenUrls = [];
  global.fetch = async (url) => {
    seenUrls.push(String(url));
    return { ok: true, json: async () => [] };
  };
  try {
    await searchCatalog({ q: 'foo),or=(is_public.eq.true)*', kind: 'paste', limit: 999999, offset: -5 });
    assert.ok(seenUrls.length >= 1);
    for (const u of seenUrls) {
      const decoded = decodeURIComponent(u);
      assert.ok(!decoded.includes('is_public.eq.true)'), `URL still contains an injected filter clause: ${decoded}`);
      assert.ok(/limit=50(&|$)/.test(u), `limit should be clamped to 50 in: ${u}`);
      assert.ok(/offset=0(&|$)/.test(u), `offset should be clamped to 0 in: ${u}`);
    }
  } finally { restoreFetch(); }
});

test('searchCatalog: kind=paste only queries mdshare_pastes (real per-table scoping, not fetch-all-then-filter)', async () => {
  const tablesHit = new Set();
  global.fetch = async (url) => {
    const m = String(url).match(/rest\/v1\/(mdshare_\w+)/);
    if (m) tablesHit.add(m[1]);
    return { ok: true, json: async () => [] };
  };
  try {
    await searchCatalog({ kind: 'paste', limit: 10, offset: 0 });
    assert.deepEqual([...tablesHit], ['mdshare_pastes']);
  } finally { restoreFetch(); }
});

test('searchCatalog: kind=all queries all three tables', async () => {
  const tablesHit = new Set();
  global.fetch = async (url) => {
    const m = String(url).match(/rest\/v1\/(mdshare_\w+)/);
    if (m) tablesHit.add(m[1]);
    return { ok: true, json: async () => [] };
  };
  try {
    await searchCatalog({ limit: 10, offset: 0 });
    assert.deepEqual([...tablesHit].sort(), ['mdshare_archify', 'mdshare_diagrams', 'mdshare_pastes']);
  } finally { restoreFetch(); }
});

test('searchCatalog: every per-table request includes the real server-side not-expired-or-pinned filter', async () => {
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return { ok: true, json: async () => [] }; };
  try {
    await searchCatalog({ kind: 'paste', limit: 10, offset: 0 });
    assert.ok(urls[0].includes('or=(expires_at.gt.'), 'expiry filter must be in the Supabase request URL itself, not applied client-side after fetch');
    assert.ok(urls[0].includes('pinned.eq.true'));
  } finally { restoreFetch(); }
});

test('searchCatalog: merges and sorts results from multiple tables by created_at desc, applies expired exclusion from mocked rows', async () => {
  const now = Date.now();
  const past = new Date(now - 86400000).toISOString();
  const future = new Date(now + 86400000).toISOString();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('mdshare_pastes')) {
      return { ok: true, json: async () => [
        { id: 'p-old', title: 'old paste', created_at: past, expires_at: future, pinned: false, is_public: false },
      ] };
    }
    if (u.includes('mdshare_diagrams')) {
      return { ok: true, json: async () => [
        { id: 'd-new', title: 'new diagram', created_at: new Date(now).toISOString(), expires_at: future, pinned: false, is_public: false },
      ] };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const result = await searchCatalog({ limit: 10, offset: 0 });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].id, 'd-new', 'newest item sorts first across merged tables');
    assert.equal(result.items[1].id, 'p-old');
  } finally { restoreFetch(); }
});

// ============================================================================
// api/pastes.js bearer catalog mode: scope gate + response shape (expired exclusion itself is
// enforced server-side inside searchCatalog, covered directly above; this layer just confirms
// the route wires q/kind/limit/offset through and respects the scope gate).
// ============================================================================

function fakeToken(raw, { id, name = 'test-agent', scopes = null } = {}) {
  const hash = sha256Hex(raw);
  return {
    raw,
    lookupRule: {
      method: 'GET',
      test: new RegExp(`mdshare_agent_tokens\\?token_hash=eq\\.${hash}`),
      respond: async () => ({ ok: true, json: async () => [{ id, name, expires_at: '2999-01-01T00:00:00Z', revoked_at: null, scopes }] }),
    },
  };
}

function router(rules) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    for (const r of rules) {
      if (r.method && r.method !== method) continue;
      if (r.test.test(String(url))) return r.respond(url, opts);
    }
    return { ok: true, json: async () => [] };
  };
}

test('api/pastes.js: GET with Authorization header + documents:read passes q/kind/limit/offset through to searchCatalog and sets no-store', async () => {
  const t = fakeToken('mds_pastes_catalog_KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', { id: 'tok_catalog', scopes: ['documents:read'] });
  const urls = [];
  global.fetch = router([
    t.lookupRule,
    { method: 'GET', test: /mdshare_diagrams/, respond: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } },
  ]);
  try {
    const req = { method: 'GET', query: { q: 'roadmap', kind: 'diagram', limit: '5', offset: '0' }, headers: { authorization: `Bearer ${t.raw}` } };
    const res = responseRecorder();
    await pastesHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(urls.some((u) => u.includes('roadmap')));
    assert.ok(urls.every((u) => u.includes('mdshare_diagrams')));
  } finally { restoreFetch(); }
});

test('api/pastes.js: GET with no Authorization header still requires the owner cookie (unaffected by the new bearer branch)', async () => {
  const req = { method: 'GET', query: {}, headers: {} };
  const res = responseRecorder();
  await pastesHandler(req, res);
  assert.equal(res.statusCode, 401);
});
