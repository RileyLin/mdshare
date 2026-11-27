// GET /api/doc?action=search is rate-limited per credential (ADV-A finding 2, 2026-11-26): a
// documents:read token, or the owner session per client IP, gets READ_RATE_LIMIT searches a
// minute; past that a 429 with Retry-After and no database call. Other credentials are unaffected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, asUser } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
test.after(() => db.close());

const { default: authHandler } = await import('../api/auth.js');
const { default: docHandler } = await import('../api/doc.js');
const { createToken } = await import('../api/_lib/agent-tokens.js');

const res0 = responseRecorder();
await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.9' } }, res0);
const COOKIE = res0.headers['set-cookie'].split(';')[0];
db.sb.seed('mdshare_pastes', { id: 'rate000001', title: 'Rate', content: '# Rate\n\nbody', expires_at: '2999-01-01T00:00:00Z' });

let ipn = 0;
async function search(headers, ip = `10.3.0.${++ipn % 250}`) {
  const res = responseRecorder();
  await docHandler({ method: 'GET', query: { action: 'search', q: 'body' }, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: ip } }, res);
  return res;
}
const mint = async () => (await createToken(await asUser(1), { name: `t-${Math.random()}`, expiresInDays: 1, scopes: ['documents:read'] })).token;
const LIMIT = 60;

test('a documents:read token: 60 searches a minute, then 429 + Retry-After, no database call', async () => {
  const a = await mint();
  const b = await mint();
  for (let i = 0; i < LIMIT; i++) {
    const r = await search({ authorization: 'Bearer ' + a });
    assert.equal(r.statusCode, 200, `search ${i + 1}`);
  }
  const searchCalls = () => db.calls.filter((c) => c.path === '/rest/v1/rpc/mdshare_search_owned').length;
  const before = searchCalls();
  const over = await search({ authorization: 'Bearer ' + a });
  assert.equal(over.statusCode, 429);
  const retry = Number(over.headers['retry-after']);
  assert.ok(retry >= 1 && retry <= 60, `Retry-After ${over.headers['retry-after']}`);
  assert.equal(over.body.retry_after, retry);
  assert.match(over.body.error, /60/);
  assert.equal(searchCalls(), before, 'no search query once limited');
  assert.equal((await search({ authorization: 'Bearer ' + b })).statusCode, 200, 'another token is unaffected');
  assert.equal((await search({ cookie: COOKIE })).statusCode, 200, 'the owner is unaffected');
});

test('the owner session is limited per client IP', async () => {
  for (let i = 0; i < LIMIT; i++) assert.equal((await search({ cookie: COOKIE }, '10.4.4.4')).statusCode, 200);
  const over = await search({ cookie: COOKIE }, '10.4.4.4');
  assert.equal(over.statusCode, 429);
  assert.ok(Number(over.headers['retry-after']) >= 1);
  assert.equal((await search({ cookie: COOKIE }, '10.4.4.5')).statusCode, 200, 'another IP is unaffected');
});

test('refused requests do not use up anyone\'s allowance', async () => {
  for (let i = 0; i < LIMIT + 5; i++) assert.equal((await search({}, '10.5.5.5')).statusCode, 401);
  assert.equal((await search({ cookie: COOKIE }, '10.5.5.5')).statusCode, 200, 'anonymous 401s are not counted');
});
