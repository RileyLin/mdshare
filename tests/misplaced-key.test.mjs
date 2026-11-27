// Adversarial review 2026-11-26 (ADV-A findings 1, 3, 4). A misplaced credential (x-api-key header,
// ?key / ?token / ?access_token / ?api_key / ?apikey) is only a hint on a request that is already
// being refused. It never turns an allowed request into a 401: the owner session, a valid Bearer,
// and anonymous reads of a PUBLIC document answer exactly as without the parameter.
// Also: every content response carries X-Content-Type-Options: nosniff, and the guide link in an
// agent hint uses the canonical site origin, never a spoofed Host header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, asUser } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
test.after(() => db.close());

const { default: authHandler } = await import('../api/auth.js');
const { default: renderHandler } = await import('../api/render.js');
const { default: shareHandler } = await import('../api/share.js');
const { default: docHandler } = await import('../api/doc.js');
const { createToken } = await import('../api/_lib/agent-tokens.js');

let ip = 0;
async function ownerCookie() {
  const res = responseRecorder();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.9' } }, res);
  return res.headers['set-cookie'].split(';')[0];
}
const COOKIE = await ownerCookie();
const OWNER = { cookie: COOKIE };
const bearer = (t) => ({ authorization: 'Bearer ' + t });
const CANONICAL_GUIDE = 'https://mdshare-rileylins-projects.vercel.app/llms.txt';
const STRAY = ['key', 'token', 'access_token', 'api_key', 'apikey'];

async function get(handler, query, headers = {}) {
  const res = responseRecorder();
  await handler({ method: 'GET', query, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: `10.7.0.${++ip % 250}` } }, res);
  return res;
}
const view = (id, headers, extra = {}) => get(renderHandler, { id, ...extra }, headers);
const raw = (id, headers, extra = {}) => get(shareHandler, { id, ...extra }, headers);
const search = (query, headers) => get(docHandler, { action: 'search', ...query }, headers);
let n = 0;
function seed(extra = {}) {
  const id = `m${(++n).toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  db.sb.seed('mdshare_pastes', { id, title: 'Body plan', content: `# Body plan ${id}\n\nbody secret-marker-${id}`, expires_at: '2999-01-01T00:00:00Z', ...extra });
  return id;
}
const contentOf = (id) => db.sb.tables.mdshare_pastes.find((r) => r.id === id).content;
// Everything about a response except per-request noise (Set-Cookie refreshes).
const shape = (r) => ({ status: r.statusCode, type: r.headers['content-type'], body: typeof r.body === 'string' ? r.body.replace(/secret-marker-\w+|Body plan \w+/g, 'X') : r.body });

test('owner session + a stray ?token on search: same 200 as without it', async () => {
  seed();
  const base = await search({ q: 'body' }, OWNER);
  assert.equal(base.statusCode, 200);
  for (const k of STRAY) {
    const r = await search({ q: 'body', [k]: 'some-unrelated-value' }, OWNER);
    assert.equal(r.statusCode, 200, `owner + ?${k}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.results) && r.body.results.length > 0);
  }
  const hdr = await search({ q: 'body' }, { ...OWNER, 'x-api-key': 'something' });
  assert.equal(hdr.statusCode, 200, 'owner + x-api-key header still searches');
});

test('owner session + ?key on their own private document: the normal page', async () => {
  const id = seed();
  const base = await view(id, OWNER);
  assert.equal(base.statusCode, 200);
  assert.match(base.headers['content-type'], /text\/html/);
  for (const k of STRAY) {
    const r = await view(id, OWNER, { [k]: 'whatever' });
    assert.deepEqual(shape(r), shape(base), `owner + ?${k} gets exactly the page`);
  }
  const hdr = await view(id, { ...OWNER, 'x-api-key': 'whatever' });
  assert.deepEqual(shape(hdr), shape(base), 'owner + x-api-key gets exactly the page');
});

test('anonymous + ?token on a PUBLIC document: the normal public page and raw text', async () => {
  const id = seed({ is_public: true });
  const page = await view(id, {});
  const text = await raw(id, {});
  assert.equal(page.statusCode, 200);
  assert.equal(text.body, contentOf(id));
  for (const k of STRAY) {
    assert.deepEqual(shape(await view(id, {}, { [k]: 'utm-garbage' })), shape(page), `anon public /v + ?${k}`);
    assert.deepEqual(shape(await raw(id, {}, { [k]: 'utm-garbage' })), shape(text), `anon public /raw + ?${k}`);
  }
  assert.deepEqual(shape(await view(id, { 'x-api-key': 'x' })), shape(page), 'anon public /v + x-api-key');
});

test('owner session + ?apikey on /raw: the stored text', async () => {
  const id = seed();
  for (const k of STRAY) {
    const r = await raw(id, OWNER, { [k]: 'abc' });
    assert.equal(r.statusCode, 200, `owner /raw + ?${k}`);
    assert.equal(r.body, contentOf(id));
  }
  const md = await view(id, { ...OWNER, accept: 'text/markdown' }, { apikey: 'abc' });
  assert.equal(md.statusCode, 200);
  assert.equal(md.headers['content-type'], 'text/markdown; charset=utf-8', 'owner Markdown via Accept unchanged');
});

test('a valid Bearer + a stray ?key or x-api-key reads exactly as without it', async () => {
  const { token } = await createToken(await asUser(1), { name: 'reader', expiresInDays: 1, scopes: ['documents:read'] });
  const id = seed();
  const base = await view(id, bearer(token));
  assert.equal(base.statusCode, 200);
  for (const k of STRAY) assert.deepEqual(shape(await view(id, bearer(token), { [k]: 'x' })), shape(base));
  assert.deepEqual(shape(await view(id, { ...bearer(token), 'x-api-key': 'x' })), shape(base));
  assert.equal((await search({ q: 'body', token: 'x' }, bearer(token))).statusCode, 200);
});

test('without valid credentials the misplaced-key hint is extra text on the refusal', async () => {
  const before = db.calls.length;
  const s = await search({ q: 'body', key: 'mds_abc' });
  assert.equal(s.statusCode, 401);
  assert.match(s.headers['www-authenticate'], /^Bearer/);
  assert.match(s.body.hint, /Send the token as Authorization: Bearer <token>/);
  const sh = await search({ q: 'body' }, { 'x-api-key': 'mds_abc' });
  assert.equal(sh.statusCode, 401);
  assert.match(sh.body.hint, /x-api-key headers/);
  assert.equal(db.calls.length, before, 'refused search: no database call');
  const plain = await search({ q: 'body' });
  assert.doesNotMatch(plain.body.hint, /x-api-key/, 'no misplaced-key text without a misplaced key');

  const id = seed();
  for (const [headers, extra] of [[{ 'x-api-key': 'mds_abc' }, {}], [{}, { token: 'mds_abc' }]]) {
    const r = await raw(id, headers, extra);
    const missing = await raw('missingId123', headers, extra);
    assert.equal(r.statusCode, 404, '/raw keeps its 404');
    assert.deepEqual(r.body, missing.body, 'same answer for an existing private id and a missing id');
    assert.match(r.body.hint, /Send the token as Authorization: Bearer <token>/);
    assert.doesNotMatch(JSON.stringify(r.body), /secret-marker/);
    const v = await view(id, headers, extra);
    assert.equal(v.statusCode, 401, '/v keeps its sign-in gate');
    assert.match(v.headers['content-type'], /text\/html/);
    assert.match(v.body, /id="pwd"/);
    assert.match(v.body, /x-api-key headers and \?key= query parameters are not read/);
    assert.doesNotMatch(v.body, /secret-marker|Body plan/);
  }
  assert.doesNotMatch((await view(id, {})).body, /are not read/, 'no misplaced-key text on the plain gate');
});

test('X-Content-Type-Options: nosniff on /v Markdown, /raw and the HTML page', async () => {
  const { token } = await createToken(await asUser(1), { name: 'r2', expiresInDays: 1, scopes: ['documents:read'] });
  const id = seed();
  const pub = seed({ is_public: true });
  const cases = {
    'v markdown': await view(id, bearer(token)),
    raw: await raw(id, OWNER),
    'raw public anon': await raw(pub, {}),
    'html page': await view(id, OWNER),
    'html public anon': await view(pub, {}),
    'private gate': await view(id, {}),
    'raw 404': await raw('missingId123', {}),
  };
  for (const [name, r] of Object.entries(cases)) assert.equal(r.headers['x-content-type-options'], 'nosniff', name);
  assert.equal(cases['v markdown'].headers['content-type'], 'text/markdown; charset=utf-8');
  assert.match(cases['html page'].headers['content-type'], /text\/html/);
});

test('the guide link in an agent hint ignores a spoofed Host header', async () => {
  const evil = { host: 'attacker.example' };
  const s = await search({ q: 'body' }, evil);
  assert.equal(s.statusCode, 401);
  assert.equal(s.body.guide, CANONICAL_GUIDE);
  const bad = await view(seed(), { ...evil, ...bearer('mds_not_a_real_token') });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.body.guide, CANONICAL_GUIDE);
  const r = await raw('missingId123', evil);
  assert.equal(r.body.guide, CANONICAL_GUIDE);
  for (const host of ['localhost.attacker.example', '127.0.0.1.evil.example', 'evil.example:3000']) {
    assert.equal((await search({ q: 'x' }, { host })).body.guide, CANONICAL_GUIDE, host);
  }
  assert.equal((await search({ q: 'x' }, { host: 'localhost:3000' })).body.guide, 'http://localhost:3000/llms.txt', 'a local dev server links to itself');
});
