// Multi-user P1 (2026-11-27): sessions carry a user id, and api/_lib/tenant.js mints the only
// principals the data layer accepts. The cross-user behaviour of every route is in
// tests/cross-user.test.mjs; this file pins the building blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, userCookie } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const session = await import('../api/_lib/session.js');
const tenant = await import('../api/_lib/tenant.js');
const { default: authHandler } = await import('../api/auth.js');

const now = () => Math.floor(Date.now() / 1000);
const cookieReq = (value) => ({ headers: { cookie: `mdshare_auth=${encodeURIComponent(value)}` } });

test('v3 cookie: carries the uid, verifies, and a changed uid, expiry or signature is rejected', () => {
  const t = session.signUserSession(7, now() + 100);
  assert.match(t, /^v3\.7\.\d+\.[0-9a-f]{64}$/);
  assert.equal(session.verifyUserSession(t, now()), 7);
  const [, , exp, sig] = t.split('.');
  assert.equal(session.verifyUserSession(`v3.8.${exp}.${sig}`, now()), null, 'another uid with the same signature');
  assert.equal(session.verifyUserSession(`v3.7.${Number(exp) + 1}.${sig}`, now()), null, 'a longer expiry');
  assert.equal(session.verifyUserSession(t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'), now()), null, 'a changed signature');
  assert.equal(session.verifyUserSession(session.signUserSession(7, now() - 1), now()), null, 'expired');
  assert.equal(session.verifyUserSession(session.signUserSession(7, now() + 100, 'test-password'), now(), 'another-password'), null, 'rotating the password logs everyone out');
  for (const bad of ['', 'v3', 'v3.0.1.x', 'v3.-1.9999999999.' + 'a'.repeat(64), 'v3.1e3.9999999999.' + 'a'.repeat(64), null, 42]) assert.equal(session.verifyUserSession(bad, now()), null);
  assert.throws(() => session.signUserSession(0, now() + 1));
});

test('sessionUid: v3 is its uid, a v2 cookie is user #1, garbage and no cookie are nobody', () => {
  assert.equal(session.sessionUid(cookieReq(session.signUserSession(2, now() + 100))), 2);
  assert.equal(session.sessionUid(cookieReq(session.signSessionToken(now() + 100))), 1, 'pre-multi-user cookies keep working as the owner');
  assert.equal(session.sessionUid(cookieReq('garbage')), null);
  assert.equal(session.sessionUid({ headers: {} }), null);
  assert.equal(session.sessionUid({ headers: { cookie: 'mdshare_auth=%E0%A4%A' } }), null, 'a malformed cookie is no cookie, not a crash');
});

test('the password login issues a v3 cookie for user #1', async () => {
  const res = responseRecorder();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '10.88.0.1' } }, res);
  assert.equal(res.statusCode, 200);
  const value = decodeURIComponent(res.headers['set-cookie'].split(';')[0].split('=')[1]);
  assert.match(value, /^v3\.1\./);
  assert.equal(session.sessionUid(cookieReq(value)), 1);
});

test('principals: ownerOf prefers a present Bearer; an invalid one is nobody, never the cookie', async () => {
  const req = { headers: { cookie: await userCookie(2) } };
  assert.equal(tenant.ownerOf(req, undefined, { present: false }).uid, 2);
  assert.equal(tenant.ownerOf(req, undefined, null).via, 'cookie');
  const tok = tenant.ownerOf(req, undefined, { present: true, valid: true, id: 'tok_x', ownerId: 3 });
  assert.deepEqual({ uid: tok.uid, via: tok.via, tokenId: tok.tokenId }, { uid: 3, via: 'token', tokenId: 'tok_x' });
  assert.equal(tenant.ownerOf(req, undefined, { present: true, valid: false }), null);
  assert.equal(tenant.ownerOf(req, undefined, { present: true, valid: true, id: 'tok_y', ownerId: null }), null, 'an ownerless token is nobody');
  assert.throws(() => tenant.ownerOf(req), /resolve the Bearer token first/);
  assert.equal(tenant.ownerOf({ headers: {} }, undefined, null), null);
  assert.ok(Object.isFrozen(tok));
});

test('creatorOf: anonymous creates go to the site owner, but that principal can never read', async () => {
  const anon = tenant.creatorOf({ headers: {} }, undefined, { present: false });
  assert.equal(anon.uid, 1);
  assert.equal(anon.via, 'anonymous-create');
  assert.throws(() => tenant.uidOf(anon), /needs a principal/);
  assert.equal(tenant.owns(anon, { owner_id: 1 }), false);
  await assert.rejects(tenant.selectOwned('mdshare_pastes', anon, 'select=id'), /needs a principal/);
});

test('only tenant-minted principals are accepted: a lookalike object is refused everywhere', async () => {
  const fake = Object.freeze({ uid: 1, via: 'cookie' });
  assert.throws(() => tenant.uidOf(fake), /needs a principal/);
  assert.equal(tenant.owns(fake, { owner_id: 1 }), false);
  await assert.rejects(tenant.selectOwned('mdshare_pastes', fake, 'select=id'), /needs a principal/);
  await assert.rejects(tenant.insertOwned('mdshare_pastes', fake, { id: 'x' }), /must be a principal/);
  await assert.rejects(tenant.patchOwned('mdshare_pastes', fake, 'id=eq.x', { title: 't' }), /needs a principal/);
  assert.equal(tenant.rowOwner({ owner_id: 1 }), null, 'rowOwner only for rows tenant.js returned');
});

test('owner_id is never taken from a row or patch, and the owner filter comes first', async () => {
  const db = await useFakeDb();
  try {
    db.sb.seed('mdshare_users', { id: 2, label: 'B' });
    const a = tenant.sessionOwner({ headers: { cookie: await userCookie(1) } });
    const b = tenant.sessionOwner({ headers: { cookie: await userCookie(2) } });
    await assert.rejects(tenant.insertOwned('mdshare_pastes', b, { id: 'aaaaaaaaaa', content: 'x', owner_id: 1 }), /owner_id is set only by insertOwned/);
    await assert.rejects(tenant.patchOwned('mdshare_pastes', b, 'id=eq.aaaaaaaaaa', { owner_id: 1 }), /owner_id is set only by insertOwned/);
    await assert.rejects(tenant.insertOwned('mdshare_pastes', null, { id: 'aaaaaaaaaa' }), /always have an owner/);
    await tenant.insertOwned('mdshare_pastes', b, { id: 'bbbbbbbbbb', content: 'b', expires_at: '2999-01-01T00:00:00Z' });
    assert.equal(db.sb.tables.mdshare_pastes[0].owner_id, 2);
    db.sb.seed('mdshare_pastes', { id: 'aaaaaaaaaa', content: 'a', expires_at: '2999-01-01T00:00:00Z' });
    assert.deepEqual((await tenant.selectOwned('mdshare_pastes', b, 'select=id')).map((r) => r.id), ['bbbbbbbbbb']);
    assert.equal((await tenant.readOwned('mdshare_pastes', b, 'aaaaaaaaaa', 'id')).row, null, "another user's id is the same null as a missing one");
    assert.equal((await tenant.readOwned('mdshare_pastes', a, 'aaaaaaaaaa', 'id')).row.id, 'aaaaaaaaaa');
    const r = await tenant.patchOwned('mdshare_pastes', b, 'id=eq.aaaaaaaaaa', { title: 'pwned' });
    assert.deepEqual(r, { ok: true, rows: [] });
    assert.equal(db.sb.tables.mdshare_pastes.find((x) => x.id === 'aaaaaaaaaa').title ?? null, null);
    assert.deepEqual(await tenant.deleteOwned('mdshare_pastes', b, 'aaaaaaaaaa'), []);
    assert.equal(db.sb.tables.mdshare_pastes.length, 2);
    // Every user-table query is scoped (the accounts table, read for B's quota, is keyed by id).
    const scoped = db.calls.filter((c) => c.method !== 'POST' && c.path !== '/rest/v1/mdshare_users');
    assert.ok(scoped.every((c) => /^\?owner_id=eq\.[12]&/.test(c.query)), scoped.map((c) => c.query).join('\n'));
    const { row } = await tenant.readForView('mdshare_pastes', 'aaaaaaaaaa', 'id,is_public');
    assert.equal(row.owner_id, 1, 'readForView always returns the owner so isVisible can decide');
    assert.equal(tenant.rowOwner(row).uid, 1);
    assert.equal(tenant.owns(b, row), false);
    assert.equal(tenant.owns(a, row), true);
  } finally { await db.close(); }
});
