// ADV-MU-B 2 + 3 (2026-11-27): the seat cap and the daily document quota were check-then-act
// (a count, then a separate insert), so concurrent requests overshot both. Now each is one atomic
// SQL call (migration 016: mdshare_signup_user, mdshare_reserve_doc); the fake database runs them
// atomically too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, userCookie } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = '***';
process.env.MDSHARE_HMAC_SECRET = '***';
process.env.SUPABASE_SERVICE_KEY = '***';

const db = await useFakeDb();
const { default: auth } = await import('../api/auth.js');
const { default: share } = await import('../api/share.js');
test.after(() => db.close());

const signupReq = (i) => {
  const res = responseRecorder();
  return auth({ method: 'POST', query: { action: 'signup' }, body: {}, headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: `198.51.100.${i}` } }, res).then(() => res);
};

test('20 concurrent sign-ups against a cap of 3 create exactly 3 users; the rest are 403 "beta full"', async () => {
  db.sb.reset();
  process.env.MDSHARE_MAX_USERS = '3';
  try {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => signupReq(i)));
    const created = results.filter((r) => r.statusCode === 201).length;
    const full = results.filter((r) => r.statusCode === 403 && r.body.error === 'beta full').length;
    assert.equal(created, 3);
    assert.equal(full, 17);
    assert.equal(db.sb.tables.mdshare_users.filter((u) => u.id > 1).length, 3);
    assert.equal(db.sb.tables.mdshare_agent_tokens.length, 3, 'only the created users got a token');
  } finally {
    delete process.env.MDSHARE_MAX_USERS;
  }
});

test('15 concurrent creates against a daily quota of 3 create exactly 3 documents; the rest are 429', async () => {
  db.sb.reset();
  const s = await signupReq(200);
  assert.equal(s.statusCode, 201);
  const u = db.sb.tables.mdshare_users.find((x) => x.id === s.body.user_id);
  u.quota_docs_per_day = 3;
  const tok = { authorization: ['Bearer', s.body.token].join(' ') };
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => {
    const res = responseRecorder();
    return share({ method: 'POST', query: {}, headers: tok, body: { markdown: `# doc ${i}` }, socket: { remoteAddress: `198.51.100.${100 + i}` } }, res).then(() => res);
  }));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 3);
  const refused = results.filter((r) => r.statusCode === 429);
  assert.equal(refused.length, 12);
  assert.ok(refused.every((r) => Number(r.headers['retry-after']) > 0 && /Daily limit reached/.test(r.body.error)));
  assert.equal(db.sb.tables.mdshare_pastes.filter((p) => p.owner_id === u.id).length, 3);
});

test('user #1 never takes a quota reservation (G2)', async () => {
  db.sb.reset();
  const owner = db.sb.tables.mdshare_users.find((x) => x.id === 1);
  owner.quota_docs_per_day = 1;
  const before = db.calls.length;
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => {
    const res = responseRecorder();
    return userCookie(1).then((cookie) => share({ method: 'POST', query: {}, headers: { cookie }, body: { markdown: `# owner ${i}` }, socket: { remoteAddress: '198.51.100.250' } }, res)).then(() => res);
  }));
  assert.ok(results.every((r) => r.statusCode === 200));
  assert.equal(db.calls.slice(before).filter((c) => /rpc\/mdshare_reserve_doc/.test(c.path)).length, 0);
  assert.equal(db.sb.tables.mdshare_quota_usage.length, 0);
});
