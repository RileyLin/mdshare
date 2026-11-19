// Server-side contracts added with the 2026-11-19 redesign: keep-on-create, keep-on-publish,
// finite unkeep, archify/diagram delete, sign-out, safe data embedding, classic/reader views.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const { default: authHandler } = await import('../api/auth.js');
const { default: shareHandler } = await import('../api/share.js');
const { default: diagramHandler } = await import('../api/diagram.js');
const { default: archifyHandler } = await import('../api/archify.js');
const { default: pinHandler } = await import('../api/pin.js');
const { default: renderHandler } = await import('../api/render.js');
const { default: dashboardHandler } = await import('../api/dashboard.js');
const { sha256Hex } = await import('../api/_lib/agent-tokens.js');
const { jsonForScript } = await import('../api/_lib/ui.js');

function rec() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    json(v) { this.body = v; return this; },
    send(v) { this.body = v; return this; },
    end() { return this; },
  };
}
let loginN = 0; // a fresh source IP per login so the login rate limiter never kicks in
async function ownerCookie() {
  const res = rec();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: `127.0.1.${++loginN}` } }, res);
  return res.headers['set-cookie'].split(';')[0];
}
function router(rules) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    for (const r of rules) if ((!r.method || r.method === method) && r.test.test(String(url))) return r.respond(url, opts);
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
}
const originalFetch = global.fetch;
const restore = () => { global.fetch = originalFetch; };
const ip = (n) => ({ remoteAddress: `10.0.0.${n}` });

test('POST /api/share keep:true is ignored for anonymous callers (no permanent rows from the open endpoint)', async () => {
  let inserted;
  global.fetch = router([{ method: 'POST', test: /mdshare_pastes$/, respond: async (u, o) => { inserted = JSON.parse(o.body); return { ok: true }; } }]);
  try {
    const res = rec();
    await shareHandler({ method: 'POST', body: { markdown: '# a', keep: true }, headers: {}, socket: ip(1) }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(inserted.pinned, false);
    assert.ok(inserted.expires_at < '2099');
    assert.equal(inserted.is_public, false);
    assert.equal(res.body.kept, false);
    assert.equal(res.body.expires_in, 86400);
    assert.match(res.body.format_guide, /\/llms\.txt$/);
  } finally { restore(); }
});

test('POST /api/share keep:true is honoured for the owner and for a valid token', async () => {
  const cookie = await ownerCookie();
  const raw = 'mds_keep_test_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const inserted = [];
  global.fetch = router([
    { method: 'GET', test: new RegExp(`mdshare_agent_tokens\\?token_hash=eq\\.${sha256Hex(raw)}`), respond: async () => ({ ok: true, json: async () => [{ id: 'tok_k', name: 'k', expires_at: '2999-01-01T00:00:00Z', revoked_at: null }] }) },
    { method: 'POST', test: /mdshare_pastes$/, respond: async (u, o) => { inserted.push(JSON.parse(o.body)); return { ok: true }; } },
  ]);
  try {
    const r1 = rec();
    await shareHandler({ method: 'POST', body: { markdown: '# owner', keep: true }, headers: { cookie }, socket: ip(2) }, r1);
    const r2 = rec();
    await shareHandler({ method: 'POST', body: { markdown: '# agent', keep: true }, headers: { authorization: `Bearer ${raw}` }, socket: ip(3) }, r2);
    for (const [i, r] of [[0, r1], [1, r2]]) {
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.kept, true);
      assert.equal(r.body.expires_in, null);
      assert.equal(inserted[i].pinned, true);
      assert.equal(inserted[i].expires_at, '2099-12-31T00:00:00Z');
      assert.equal(inserted[i].is_public, false, 'keep never implies public');
    }
  } finally { restore(); }
});

test('POST /api/diagram and /api/archify honour keep for the owner only', async () => {
  const cookie = await ownerCookie();
  const rows = {};
  global.fetch = router([{ method: 'POST', test: /mdshare_(diagrams|archify)$/, respond: async (u, o) => { rows[String(u).split('/').pop()] = JSON.parse(o.body); return { ok: true, text: async () => '' }; } }]);
  try {
    const r1 = rec();
    await diagramHandler({ method: 'POST', body: { svg: '<svg></svg>', keep: true }, headers: { cookie } }, r1);
    assert.equal(r1.statusCode, 200);
    assert.equal(rows.mdshare_diagrams.pinned, true);
    const r2 = rec();
    await archifyHandler({ method: 'POST', body: { kind: 'architecture', html: '<svg></svg>', keep: true }, headers: {} }, r2);
    assert.equal(r2.statusCode, 200);
    assert.equal(rows.mdshare_archify.pinned, false);
    assert.equal(r2.body.kept, false);
  } finally { restore(); }
});

test('PATCH /api/pin publish with keep:true keeps in the same write; invalid keep is a 400', async () => {
  const cookie = await ownerCookie();
  let patched, table;
  global.fetch = router([{ method: 'PATCH', test: /rest\/v1\/mdshare_/, respond: async (u, o) => { patched = JSON.parse(o.body); table = String(u).match(/v1\/(\w+)\?/)[1]; return { ok: true, json: async () => [{ id: 'abc1234567' }] }; } }]);
  try {
    const r = rec();
    await pinHandler({ method: 'PATCH', body: { id: 'abc1234567', kind: 'archify', is_public: true, keep: true }, headers: { cookie } }, r);
    assert.equal(r.statusCode, 200);
    assert.equal(table, 'mdshare_archify');
    assert.deepEqual(patched, { is_public: true, pinned: true, expires_at: '2099-12-31T00:00:00Z' });
    assert.equal(r.body.kept, true);
    const bad = rec();
    await pinHandler({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: true, keep: 'yes' }, headers: { cookie } }, bad);
    assert.equal(bad.statusCode, 400);
    const plain = rec();
    await pinHandler({ method: 'PATCH', body: { id: 'abc1234567', kind: 'paste', is_public: false }, headers: { cookie } }, plain);
    assert.deepEqual(patched, { is_public: false }, 'without keep only is_public changes');
  } finally { restore(); }
});

test('PATCH /api/pin unkeep gives a finite 7-day expiry; archify type hits its own table', async () => {
  const cookie = await ownerCookie();
  const calls = [];
  global.fetch = router([{ method: 'PATCH', test: /rest\/v1\/mdshare_/, respond: async (u, o) => { calls.push({ url: String(u), body: JSON.parse(o.body) }); return { ok: true, text: async () => '' }; } }]);
  try {
    const r = rec();
    const before = Date.now();
    await pinHandler({ method: 'PATCH', body: { id: 'abc1234567', type: 'archify', pinned: false }, headers: { cookie } }, r);
    assert.equal(r.statusCode, 200);
    assert.match(calls[0].url, /mdshare_archify\?id=eq\.abc1234567/);
    assert.equal(calls[0].body.pinned, false);
    const exp = new Date(calls[0].body.expires_at).getTime();
    assert.ok(exp > before + 6.9 * 864e5 && exp < before + 7.1 * 864e5);
    assert.equal(r.body.expires_at, calls[0].body.expires_at);
    const k = rec();
    await pinHandler({ method: 'PATCH', body: { id: 'abc1234567', pinned: true }, headers: { cookie } }, k);
    assert.match(calls[1].url, /mdshare_pastes/, 'omitted type keeps the old default (pastes)');
    assert.deepEqual(calls[1].body, { expires_at: '2099-12-31T00:00:00Z', pinned: true });
    const bad = rec();
    await pinHandler({ method: 'PATCH', body: { id: 'abc1234567', type: 'nope', pinned: true }, headers: { cookie } }, bad);
    assert.equal(bad.statusCode, 500);
    assert.equal(calls.length, 2, 'invalid type never reaches Supabase');
  } finally { restore(); }
});

test('DELETE /api/diagram and /api/archify are owner-only', async () => {
  const cookie = await ownerCookie();
  const deleted = [];
  global.fetch = router([{ method: 'DELETE', test: /rest\/v1\/mdshare_/, respond: async (u) => { deleted.push(String(u)); return { ok: true }; } }]);
  try {
    for (const [h, table] of [[diagramHandler, 'mdshare_diagrams'], [archifyHandler, 'mdshare_archify']]) {
      const anon = rec();
      await h({ method: 'DELETE', query: { id: 'abc1234567' }, headers: {} }, anon);
      assert.equal(anon.statusCode, 401);
      const own = rec();
      await h({ method: 'DELETE', query: { id: 'abc1234567' }, headers: { cookie } }, own);
      assert.equal(own.statusCode, 200);
      assert.match(deleted.at(-1), new RegExp(`${table}\\?id=eq\\.abc1234567$`));
    }
    assert.equal(deleted.length, 2);
  } finally { restore(); }
});

test('POST /api/auth {action:logout} clears the session cookie', async () => {
  const r = rec();
  await authHandler({ method: 'POST', body: { action: 'logout' }, headers: {}, socket: ip(9) }, r);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['set-cookie'], /^mdshare_auth=; Max-Age=0; Path=\/; HttpOnly/);
});

test('jsonForScript output can never close a <script> element', () => {
  const nasty = { content: '</script><script>alert(1)</script>\u2028<!--' };
  const out = jsonForScript(nasty);
  assert.doesNotMatch(out, /<\/script/i);
  assert.doesNotMatch(out, /<!--/);
  assert.deepEqual(JSON.parse(out), nasty);
});

function rowFetch(row) { global.fetch = async () => ({ ok: true, json: async () => [row] }); }
const ROW = { content: '# Title\n\n</script><img src=x onerror=alert(1)>\n', expires_at: '2999-01-01T00:00:00Z', is_public: true, pinned: false, created_at: '2026-11-01T00:00:00Z' };

test('render.js embeds content as escaped JSON, never as raw markup', async () => {
  rowFetch(ROW);
  try {
    const r = rec();
    await renderHandler({ query: { id: 'abc1234567' }, headers: {} }, r);
    assert.equal(r.statusCode, 200);
    const data = r.body.match(/<script type="application\/json" id="mdshare-data">([\s\S]*?)<\/script>/)[1];
    assert.equal(JSON.parse(data).content, ROW.content);
    assert.doesNotMatch(data, /<\/script/i);
    assert.doesNotMatch(r.body.replace(/<noscript>[\s\S]*?<\/noscript>/, ''), /<img src=x/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(r.headers['cache-control'], 'private, no-store');
  } finally { restore(); }
});

test('render.js: reader view has no owner controls; owner view does; ?as=reader hides them; ?classic=1 serves the old page', async () => {
  const cookie = await ownerCookie();
  rowFetch(ROW);
  try {
    const anon = rec();
    await renderHandler({ query: { id: 'abc1234567' }, headers: {} }, anon);
    assert.doesNotMatch(anon.body, /id="btn-delete"|id="status-pill"|id="btn-edit"/);
    assert.match(anon.body, /id="btn-copy-link"/);
    const own = rec();
    await renderHandler({ query: { id: 'abc1234567' }, headers: { cookie } }, own);
    for (const idAttr of ['status-pill', 'btn-share', 'btn-edit', 'btn-aa', 'btn-more', 'btn-delete', 'public-toggle', 'keep-toggle', 'md-editor']) assert.match(own.body, new RegExp(`id="${idAttr}"`));
    assert.doesNotMatch(own.body, /Notion|>rendered</);
    const asReader = rec();
    await renderHandler({ query: { id: 'abc1234567', as: 'reader' }, headers: { cookie } }, asReader);
    assert.doesNotMatch(asReader.body, /id="status-pill"/);
    const classic = rec();
    await renderHandler({ query: { id: 'abc1234567', classic: '1' }, headers: { cookie } }, classic);
    assert.match(classic.body, /Classic view/);
    assert.match(classic.body, /id="btn-delete" onclick="deletePaste\(\)"/);
    assert.doesNotMatch(classic.body, /Notion/);
    assert.doesNotMatch(classic.body, /<\/script><img/, 'classic view also escapes stored content');
  } finally { restore(); }
});

test('dashboard: anonymous gets the sign-in card (401); owner gets Library or Settings', async () => {
  const cookie = await ownerCookie();
  const anon = rec();
  await dashboardHandler({ query: {}, headers: {} }, anon);
  assert.equal(anon.statusCode, 401);
  assert.match(anon.body, /window\.location\.reload\(\)/);
  assert.doesNotMatch(anon.body, /window\.location\.href\s*=/);
  const lib = rec();
  await dashboardHandler({ query: {}, headers: { cookie } }, lib);
  assert.equal(lib.statusCode, 200);
  assert.match(lib.body, /id="lib-list"/);
  const set = rec();
  await dashboardHandler({ query: { view: 'settings' }, headers: { cookie } }, set);
  assert.match(set.body, /id="btn-create-token"/);
  assert.match(set.body, /id="pref-autokeep"/);
});
