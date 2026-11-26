// Agent access to documents (Tier 2 A2): /v/:id with a Bearer token returns Markdown under the
// exact /raw/:id rules; failures say how to authenticate; nothing reveals whether an id exists.
// Contracts proven here:
//  - /v/:id + Bearer documents:read -> 200 text/markdown, exact stored content
//  - /v/:id + Bearer that created the row (no documents:read) -> 200; legacy own row -> 200
//  - invalid Bearer -> 401 + WWW-Authenticate + hint; x-api-key / ?key= -> 401 hint, no DB read
//  - token without access -> the same 404 body for an existing private id and a missing id
//  - owner session + Accept: text/markdown -> Markdown; owner without it -> HTML page
//  - anonymous (with or without Accept: text/markdown) -> unchanged sign-in gate, no content
//  - /raw/:id keeps its statuses and text/plain; private gate never carries rel=alternate
//  - the HTML page advertises the Markdown (rel=alternate) only once the viewer may read it
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
test.after(() => db.close());

const { default: authHandler } = await import('../api/auth.js');
const { default: renderHandler } = await import('../api/render.js');
const { default: shareHandler } = await import('../api/share.js');
const { createToken } = await import('../api/_lib/agent-tokens.js');
const { acceptsMarkdown, apiKeyMisuse } = await import('../api/_lib/raw.js');

let ip = 0;
async function ownerCookie() {
  const res = responseRecorder();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.9' } }, res);
  return res.headers['set-cookie'].split(';')[0];
}
const COOKIE = await ownerCookie();
const mint = async (scopes) => createToken({ name: `t-${Math.random()}`, expiresInDays: 1, scopes });
const bearer = (t) => ({ authorization: 'Bearer ' + t });

async function get(handler, query, headers = {}) {
  const res = responseRecorder();
  await handler({ method: 'GET', query, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: `10.2.0.${++ip % 250}` } }, res);
  return res;
}
const view = (id, headers, extra = {}) => get(renderHandler, { id, ...extra }, headers);
const raw = (id, headers, extra = {}) => get(shareHandler, { id, ...extra }, headers);
let n = 0;
function seed(extra = {}) {
  const id = `r${(++n).toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  db.sb.seed('mdshare_pastes', { id, title: 'Secret plan', content: `# Secret plan ${id}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nsecret-marker-${id}`, expires_at: '2999-01-01T00:00:00Z', ...extra });
  return id;
}
const contentOf = (id) => db.sb.tables.mdshare_pastes.find((r) => r.id === id).content;

test('/v/:id with a documents:read Bearer returns the stored Markdown', async () => {
  const id = seed();
  const { token } = await mint(['documents:read']);
  const r = await view(id, bearer(token));
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(r.body, contentOf(id), 'exact stored content');
  assert.equal(r.headers['cache-control'], 'private, no-store');
  assert.match(r.headers.vary, /Authorization/);
  assert.match(r.headers['x-robots-tag'], /noindex/);
});

test('/v/:id Bearer follows the /raw rules: own rows, legacy own rows, no access to others', async () => {
  const writer = await mint(['documents:write']);
  const legacy = await mint(undefined);
  const mine = seed({ created_by_token: writer.id });
  const legacyRow = seed({ created_by_token: legacy.id });
  const other = seed();
  assert.equal((await view(mine, bearer(writer.token))).body, contentOf(mine), 'a token reads a row it created');
  assert.equal((await view(legacyRow, bearer(legacy.token))).body, contentOf(legacyRow), 'a legacy token reads its own row');
  for (const t of [writer.token, legacy.token]) {
    const r = await view(other, bearer(t));
    const missing = await view('doesNotExist1', bearer(t));
    assert.equal(r.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(r.body, missing.body, 'same response for an existing private id and a missing id');
    assert.doesNotMatch(JSON.stringify(r.body), /secret|Secret/);
    assert.match(r.body.hint, /documents:read/);
    // /raw answers identically to /v for the same credential.
    assert.deepEqual((await raw(other, bearer(t))).body, r.body);
  }
  const pub = seed({ is_public: true });
  assert.equal((await view(pub, bearer(writer.token))).body, contentOf(pub), 'a public doc is readable with any valid token');
});

test('invalid Bearer -> 401 with WWW-Authenticate and a hint, never the page or a fallback', async () => {
  const pub = seed({ is_public: true });
  for (const id of [pub, seed(), 'missingId123']) {
    const r = await view(id, bearer('mds_this_is_not_a_valid_token'));
    assert.equal(r.statusCode, 401);
    assert.match(r.headers['www-authenticate'], /^Bearer realm="mdshare"/);
    assert.equal(r.body.error, 'Invalid or expired token');
    assert.match(r.body.hint, /Authorization: Bearer <token>/);
    assert.equal(r.body.guide, 'http://localhost:3000/llms.txt');
    assert.doesNotMatch(JSON.stringify(r.body), /secret-marker/);
  }
  const rawBad = await raw(pub, bearer('mds_this_is_not_a_valid_token'));
  assert.equal(rawBad.statusCode, 401, '/raw keeps the hard 401');
  assert.equal(rawBad.body.error, 'Invalid or expired token');
  assert.match(rawBad.headers['www-authenticate'], /Bearer/);
});

test('a token sent as x-api-key or ?key= gets the Bearer hint, before any lookup, same for every id', async () => {
  const { token } = await mint(['documents:read']);
  const id = seed();
  const before = db.calls.length;
  const bodies = [];
  for (const [target, headers, extra] of [[id, { 'x-api-key': token }, {}], ['missingId123', { 'x-api-key': token }, {}], [id, {}, { key: token }], [id, { 'api-key': token }, {}]]) {
    const r = await view(target, headers, extra);
    assert.equal(r.statusCode, 401);
    assert.match(r.headers['www-authenticate'], /Bearer/);
    assert.match(r.body.hint, /Send the token as Authorization: Bearer <token>/);
    bodies.push(JSON.stringify(r.body));
    const rr = await raw(target, headers, extra);
    assert.equal(rr.statusCode, 401, '/raw gives the same hint');
    assert.equal(JSON.stringify(rr.body), JSON.stringify(r.body));
  }
  assert.equal(new Set(bodies).size, 1, 'identical answer whatever the id');
  assert.equal(db.calls.length, before, 'no database call for a misplaced key');
  assert.equal(apiKeyMisuse({ headers: { authorization: 'Bearer ' + token, 'x-api-key': 'x' }, query: {} }), false, 'a real Bearer header wins');
});

test('owner: Accept: text/markdown gets Markdown, a normal browser request gets the page', async () => {
  const id = seed();
  const md = await view(id, { cookie: COOKIE, accept: 'text/markdown' });
  assert.equal(md.statusCode, 200);
  assert.equal(md.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(md.body, contentOf(id));
  const page = await view(id, { cookie: COOKIE, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /<link rel="alternate" type="text\/markdown" href="\/raw\//, 'owner page advertises the Markdown');
  assert.ok(acceptsMarkdown({ headers: { accept: 'text/markdown, text/html;q=0.9' } }));
  assert.ok(!acceptsMarkdown({ headers: { accept: 'text/html, text/markdown;q=0.5' } }));
  assert.ok(!acceptsMarkdown({ headers: { accept: 'text/markdown;q=0' } }));
  assert.ok(!acceptsMarkdown({ headers: {} }));
});

test('anonymous: unchanged gate (with or without Accept: text/markdown), no content, no alternate link', async () => {
  const id = seed();
  for (const headers of [{}, { accept: 'text/markdown' }, { accept: 'text/html' }]) {
    const r = await view(id, headers);
    assert.equal(r.statusCode, 401);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, /id="pwd"/, 'the sign-in card');
    assert.doesNotMatch(r.body, /secret-marker|Secret plan/, 'no title or body');
    assert.doesNotMatch(r.body, /rel="alternate"/, 'no Markdown link for a document the viewer cannot read');
    assert.match(r.body, /Authorization: Bearer &lt;token&gt;/, 'the gate tells an agent how to authenticate');
    assert.match(r.headers['www-authenticate'], /^Bearer/);
  }
  const missing = await view('missingId123', {});
  assert.equal(missing.statusCode, 404, 'missing id unchanged');
  assert.doesNotMatch(missing.body, /rel="alternate"/);
  const pub = seed({ is_public: true });
  const page = await view(pub, {});
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/, 'anonymous Accept-less request for a public doc is still the page');
  assert.match(page.body, /rel="alternate" type="text\/markdown" href="\/raw\/[^"]+"/, 'public page may advertise its raw Markdown');
  assert.equal((await raw(pub, {})).body, contentOf(pub));
});

test('/raw keeps its contract: text/plain, owner 200, anonymous private 404 with a hint', async () => {
  const id = seed();
  const owner = await raw(id, { cookie: COOKIE });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(owner.body, contentOf(id));
  const anon = await raw(id, {});
  const anonMissing = await raw('missingId123', {});
  assert.equal(anon.statusCode, 404);
  assert.equal(anon.body.error, 'Not found or expired');
  assert.deepEqual(anon.body, anonMissing.body, 'anonymous: same 404 for existing and missing');
  assert.match(anon.body.hint, /Bearer/);
  assert.equal((await raw(undefined, {})).statusCode, 400);
});

test('/v and /raw read a document with the same number of database calls', async () => {
  const { token } = await mint(['documents:read']);
  const id = seed();
  const count = async (fn) => { const b = db.calls.length; await fn(); await new Promise((r) => setTimeout(r, 20)); return db.calls.length - b; };
  const v = await count(() => view(id, bearer(token)));
  const r = await count(() => raw(id, bearer(token)));
  assert.equal(v, r);
  assert.ok(v <= 3, `token lookup + row (+ last_used touch): ${v}`);
});
