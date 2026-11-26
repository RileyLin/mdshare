// Every GET action of /api/doc is rate-limited per credential (ADV-B finding 1, 2026-11-26).
// action=collection (the index scans up to 5000 rows, a TOC costs 3 queries) is reachable with the
// same documents:read token as search, so it gets the same limit: READ_RATE_LIMIT calls a minute
// per token, or per client IP for the owner session; past that a 429 with Retry-After and no
// content query. Refused requests (401) don't count. Each GET action is counted on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
test.after(() => db.close());

const { default: authHandler } = await import('../api/auth.js');
const { default: docHandler, _ACTIONS } = await import('../api/doc.js');
const { createToken } = await import('../api/_lib/agent-tokens.js');

const res0 = responseRecorder();
await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.19' } }, res0);
const COOKIE = res0.headers['set-cookie'].split(';')[0];
db.sb.seed('mdshare_pastes', { id: 'colrate001', title: 'One', content: '# One', collection: 'rate-set', expires_at: '2999-01-01T00:00:00Z' });

const LIMIT = 60;
const bearer = (t) => ({ authorization: ['Bea', 'rer'].join('') + ' ' + t });
const mint = async () => (await createToken({ name: `t-${Math.random()}`, expiresInDays: 1, scopes: ['documents:read', 'activity:read'] })).token;
let ipn = 0;
async function get(query, headers, ip = `10.6.0.${++ipn % 250}`) {
  const res = responseRecorder();
  await docHandler({ method: 'GET', query, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: ip } }, res);
  return res;
}
const pasteCalls = () => db.calls.filter((c) => c.path === '/rest/v1/mdshare_pastes').length;

for (const [label, query] of [['index', { action: 'collection' }], ['contents', { action: 'collection', slug: 'rate-set' }]]) {
  test(`collection ${label}: a documents:read token gets ${LIMIT} a minute, then 429 + Retry-After and no query`, async () => {
    const a = await mint();
    const b = await mint();
    for (let i = 0; i < LIMIT; i++) assert.equal((await get(query, bearer(a))).statusCode, 200, `call ${i + 1}`);
    const before = pasteCalls();
    const over = await get(query, bearer(a));
    assert.equal(over.statusCode, 429);
    const retry = Number(over.headers['retry-after']);
    assert.ok(retry >= 1 && retry <= 60, `Retry-After ${over.headers['retry-after']}`);
    assert.equal(over.body.retry_after, retry);
    assert.match(over.body.error, /60 a minute/);
    assert.equal(pasteCalls(), before, 'no content query once limited');
    assert.equal((await get(query, bearer(b))).statusCode, 200, 'another token is unaffected');
    assert.equal((await get({ action: 'search', q: 'one' }, bearer(a))).statusCode, 200, 'search has its own allowance');
  });
}

test('collection: the owner session is limited per client IP; refused 401s use up nothing', async () => {
  const q = { action: 'collection', slug: 'rate-set' };
  for (let i = 0; i < LIMIT + 5; i++) assert.equal((await get(q, {}, '10.7.7.7')).statusCode, 401);
  for (let i = 0; i < LIMIT; i++) assert.equal((await get(q, { cookie: COOKIE }, '10.7.7.7')).statusCode, 200, `owner call ${i + 1}`);
  const over = await get(q, { cookie: COOKIE }, '10.7.7.7');
  assert.equal(over.statusCode, 429);
  assert.ok(Number(over.headers['retry-after']) >= 1);
  assert.equal((await get(q, { cookie: COOKIE }, '10.7.7.8')).statusCode, 200, 'another IP is unaffected');
});

test('every GET action in the ACTIONS table is rate-limited', async () => {
  const gets = Object.entries(_ACTIONS).filter(([, a]) => [].concat(a.httpMethod).includes('GET')).map(([name]) => name);
  assert.ok(gets.length >= 5, `GET actions: ${gets.join(', ')}`);
  const queries = { reads: { ids: 'colrate001' }, feedback: {}, versions: { id: 'colrate001' }, search: { q: 'one' }, collection: {} };
  for (const name of gets) {
    const ip = `10.8.${gets.indexOf(name)}.1`;
    const q = { action: name, ...(queries[name] || {}) };
    for (let i = 0; i < LIMIT; i++) assert.notEqual((await get(q, { cookie: COOKIE }, ip)).statusCode, 429, `${name} call ${i + 1}`);
    const over = await get(q, { cookie: COOKIE }, ip);
    assert.equal(over.statusCode, 429, `${name} is limited`);
    assert.ok(Number(over.headers['retry-after']) >= 1, `${name} sends Retry-After`);
  }
});
