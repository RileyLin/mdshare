// Multi-user beta P3 (2026-11-27): sign-up, the private entry link, quotas, the kill switch and the
// owner's stats, against the in-memory Supabase (tests/_fakedb.mjs). Contract: multiuser PLAN.md
// "API contract"; design decisions: PLAN-P3.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, userCookie } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
delete process.env.MDSHARE_MAX_USERS;

const db = await useFakeDb();
const { default: auth, SIGNUP_SCOPES, SIGNUP_LIMIT, entryHash } = await import('../api/auth.js');
const { default: share } = await import('../api/share.js');
const { default: diagram } = await import('../api/diagram.js');
const { default: render } = await import('../api/render.js');
const { default: pin } = await import('../api/pin.js');
const { default: doc } = await import('../api/doc.js');
const { default: dashboard } = await import('../api/dashboard.js');
const { default: pastes } = await import('../api/pastes.js');
const { sessionUid } = await import('../api/_lib/session.js');
const { maxUsers, DEFAULT_MAX_USERS } = await import('../api/_lib/tenant.js');
const { SITE_ORIGIN } = await import('../api/_lib/content.js');
test.after(() => db.close());

let ipSeq = 0;
const freshIp = () => `10.130.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const bearer = (raw) => ['Bea', 'rer'].join('') + ' ' + raw;
async function call(handler, req = {}) {
  const res = responseRecorder();
  await handler({ method: 'GET', query: {}, body: undefined, ...req, headers: { host: '127.0.0.1:3000', ...(req.headers || {}) }, socket: { remoteAddress: req.ip || freshIp() } }, res);
  return res;
}
const signup = (body = {}, extra = {}) => call(auth, { method: 'POST', query: { action: 'signup' }, body, ...extra });
const enter = (secret, extra = {}) => call(auth, { method: 'POST', query: { action: 'enter' }, body: { secret }, ...extra });
const secretOf = (entryUrl) => entryUrl.split('#')[1];
const cookieFrom = (res) => res.headers['set-cookie'].split(';')[0];
const OWNER = await userCookie(1);
function reset() { db.sb.reset(); db.calls.length = 0; delete process.env.MDSHARE_MAX_USERS; }

// ---------- Sign-up ----------
test('sign-up: 201 {user_id, token, entry_url, guide}; the token has read+write+publish and works', async () => {
  reset();
  const r = await signup({ label: '  Ana\u0007 ' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ['entry_url', 'guide', 'token', 'user_id']);
  assert.equal(r.body.user_id, 2, 'the first user after the owner is #2');
  assert.match(r.body.token, /^mds_/);
  assert.match(r.body.entry_url, /^http:\/\/127\.0\.0\.1:3000\/enter#[A-Za-z0-9_-]{43}$/);
  assert.equal(r.body.guide, 'http://127.0.0.1:3000/llms.txt');
  assert.equal(r.headers['cache-control'], 'no-store');
  const user = db.sb.tables.mdshare_users.find((u) => u.id === 2);
  assert.equal(user.label, 'Ana', 'label trimmed, control characters removed');
  assert.deepEqual([user.disabled, user.quota_docs_per_day, user.quota_bytes], [false, 200, 524288], 'the beta defaults');
  assert.deepEqual(SIGNUP_SCOPES, ['documents:read', 'documents:write', 'documents:publish']);
  const who = await call(auth, { query: { action: 'whoami' }, headers: { authorization: bearer(r.body.token) } });
  assert.deepEqual([who.body.user_id, who.body.scopes], [2, SIGNUP_SCOPES]);
  // Publish, read back, make public (the skill's --public) with that token.
  const made = await call(share, { method: 'POST', body: { markdown: '# Hello from C\n\nbody', keep: true }, headers: { authorization: bearer(r.body.token) } });
  assert.equal(made.statusCode, 200);
  assert.equal(db.sb.tables.mdshare_pastes.find((p) => p.id === made.body.id).owner_id, 2);
  const pub = await call(pin, { method: 'PATCH', body: { id: made.body.id, kind: 'paste', is_public: true, keep: true }, headers: { authorization: bearer(r.body.token) } });
  assert.equal(pub.statusCode, 200, JSON.stringify(pub.body));
  const read = await call(render, { query: { id: made.body.id }, headers: { authorization: bearer(r.body.token) } });
  assert.match(String(read.body), /Hello from C/);
});

test('sign-up: entry_url and guide use the canonical origin, never a forged Host header', async () => {
  reset();
  const r = await signup({}, { headers: { host: 'evil.example' } });
  assert.equal(r.statusCode, 201);
  assert.ok(r.body.entry_url.startsWith(`${SITE_ORIGIN}/enter#`), r.body.entry_url);
  assert.equal(r.body.guide, `${SITE_ORIGIN}/llms.txt`);
});

test('sign-up: only the hash of the entry secret is stored; the secret is in no row and no query', async () => {
  reset();
  const r = await signup({ label: 'hash check' });
  const secret = secretOf(r.body.entry_url);
  const user = db.sb.tables.mdshare_users.find((u) => u.id === r.body.user_id);
  assert.equal(user.entry_hash, entryHash(secret));
  assert.match(user.entry_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(db.sb.tables).includes(secret), 'no table holds the secret');
  assert.ok(!JSON.stringify(db.calls).includes(secret), 'no database request carried the secret');
  assert.ok(!JSON.stringify(db.sb.tables).includes(r.body.token), 'nor the raw token');
});

test('sign-up: at most 5 per IP an hour (429 + Retry-After), counted per IP', async () => {
  reset();
  assert.equal(SIGNUP_LIMIT.limit, 5);
  const ip = freshIp();
  for (let i = 0; i < 5; i++) assert.equal((await signup({}, { ip })).statusCode, 201, `sign-up ${i + 1}`);
  const sixth = await signup({}, { ip });
  assert.equal(sixth.statusCode, 429);
  assert.ok(Number(sixth.headers['retry-after']) > 0, 'Retry-After');
  assert.ok(sixth.body.retry_after > 0 && /sign-ups/.test(sixth.body.error), JSON.stringify(sixth.body));
  assert.equal(db.sb.tables.mdshare_users.length, 6, 'the refused one created nothing');
  assert.equal((await signup({}, { ip: freshIp() })).statusCode, 201, 'another network is unaffected');
});

test('sign-up: MDSHARE_MAX_USERS seats besides user #1 (default 50), then 403 {error:"beta full"}', async () => {
  reset();
  assert.equal(maxUsers(), DEFAULT_MAX_USERS);
  assert.equal(DEFAULT_MAX_USERS, 50);
  process.env.MDSHARE_MAX_USERS = 'not a number';
  assert.equal(maxUsers(), 50);
  process.env.MDSHARE_MAX_USERS = '2';
  assert.equal((await signup()).statusCode, 201);
  db.sb.tables.mdshare_users.find((u) => u.id === 2).disabled = true; // a disabled user still holds a seat
  assert.equal((await signup()).statusCode, 201);
  const full = await signup();
  assert.equal(full.statusCode, 403);
  assert.deepEqual(full.body, { error: 'beta full' });
  assert.equal(db.sb.tables.mdshare_users.length, 3, 'user #1 + 2 seats; nothing created when full');
  process.env.MDSHARE_MAX_USERS = '0';
  assert.equal((await signup()).statusCode, 403, '0 closes sign-up');
  delete process.env.MDSHARE_MAX_USERS;
});

test('sign-up: a bad label is a 400 and creates nothing; unknown POST actions are 400, not a password attempt', async () => {
  reset();
  assert.equal((await signup({ label: 'x'.repeat(101) })).statusCode, 400);
  assert.equal((await signup({ label: 42 })).statusCode, 400);
  assert.equal(db.sb.tables.mdshare_users.length, 1);
  const typo = await call(auth, { method: 'POST', query: { action: 'sigup' }, body: { password: 'test-password' } });
  assert.equal(typo.statusCode, 400);
  assert.equal(typo.headers['set-cookie'], undefined);
});

// ---------- Entry link ----------
test('enter: the link signs the user in (v3 cookie for their uid); wrong, malformed, rotated, disabled and user #1 get one generic 401', async () => {
  reset();
  const c = await signup({ label: 'C' });
  const secret = secretOf(c.body.entry_url);
  const ok = await enter(secret);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, { ok: true, redirect: '/dashboard' });
  const cookie = cookieFrom(ok);
  assert.match(decodeURIComponent(cookie), /^mdshare_auth=v3\.2\./);
  assert.equal(sessionUid({ headers: { cookie } }), 2);
  assert.match(ok.headers['set-cookie'], /HttpOnly; SameSite=Lax; Secure/);

  const wrong = await enter('A'.repeat(43));
  const malformed = await enter('short');
  const missing = await call(auth, { method: 'POST', query: { action: 'enter' }, body: {} });
  for (const r of [wrong, malformed, missing]) {
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.body, wrong.body);
    assert.equal(r.headers['set-cookie'], undefined);
  }
  // Rotation: the old link stops at once, the new one works.
  const rot = await call(auth, { method: 'POST', query: { action: 'entry-link' }, headers: { authorization: bearer(c.body.token) } });
  assert.equal(rot.statusCode, 200);
  assert.deepEqual(Object.keys(rot.body), ['entry_url']);
  assert.deepEqual((await enter(secret)).body, wrong.body, 'the old link fails exactly like a wrong one');
  assert.equal((await enter(secretOf(rot.body.entry_url))).statusCode, 200);
  // Disabled: the same failure.
  const newSecret = secretOf(rot.body.entry_url);
  db.sb.tables.mdshare_users.find((u) => u.id === 2).disabled = true;
  assert.deepEqual([(await enter(newSecret)).statusCode, (await enter(newSecret)).body], [401, wrong.body]);
  // User #1 never signs in by link, even with a planted hash.
  const planted = 'B'.repeat(43);
  db.sb.tables.mdshare_users.find((u) => u.id === 1).entry_hash = entryHash(planted);
  const owner = await enter(planted);
  assert.deepEqual([owner.statusCode, owner.body, owner.headers['set-cookie']], [401, wrong.body, undefined]);
});

test('enter: 20 attempts per IP per 15 minutes', async () => {
  reset();
  const ip = freshIp();
  for (let i = 0; i < 20; i++) assert.equal((await enter('C'.repeat(43), { ip })).statusCode, 401);
  const r = await enter('C'.repeat(43), { ip });
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
});

test('entry-link: Bearer with documents:write or the user\'s cookie; never a read-only token, never user #1', async () => {
  reset();
  const c = await signup({ label: 'C' });
  const cookie = cookieFrom(await enter(secretOf(c.body.entry_url)));
  const viaCookie = await call(auth, { method: 'POST', query: { action: 'entry-link' }, headers: { cookie } });
  assert.equal(viaCookie.statusCode, 200);
  assert.match(viaCookie.body.entry_url, /\/enter#[A-Za-z0-9_-]{43}$/);
  // A read-only token of C (created from C's own Settings).
  const ro = await call(auth, { method: 'POST', body: { action: 'create_token', name: 'reader', scopes: ['documents:read'] }, headers: { cookie } });
  assert.equal(ro.statusCode, 200);
  assert.equal((await call(auth, { method: 'POST', query: { action: 'entry-link' }, headers: { authorization: bearer(ro.body.token) } })).statusCode, 403);
  assert.equal((await call(auth, { method: 'POST', query: { action: 'entry-link' }, headers: { authorization: bearer('mds_' + 'x'.repeat(43)) } })).statusCode, 401);
  assert.equal((await call(auth, { method: 'POST', query: { action: 'entry-link' } })).statusCode, 401);
  const owner = await call(auth, { method: 'POST', query: { action: 'entry-link' }, headers: { cookie: OWNER } });
  assert.equal(owner.statusCode, 403);
  assert.equal(db.sb.tables.mdshare_users.find((u) => u.id === 1).entry_hash, null, 'user #1 never gets an entry link');
});

test('password login stays user #1 only', async () => {
  reset();
  await signup();
  const r = await call(auth, { method: 'POST', body: { password: 'test-password' } });
  assert.equal(r.statusCode, 200);
  assert.equal(sessionUid({ headers: { cookie: cookieFrom(r) } }), 1);
  const withAction = await call(auth, { method: 'POST', body: { password: 'test-password', user_id: 2 } });
  assert.equal(sessionUid({ headers: { cookie: cookieFrom(withAction) } }), 1, 'a body field never picks the user');
});

// ---------- Quotas ----------
test('quotas: 413 over the per-document size, 429 + Retry-After over the daily count (all content kinds)', async () => {
  reset();
  const c = await signup({ label: 'C' });
  const tok = { authorization: bearer(c.body.token) };
  const u = db.sb.tables.mdshare_users.find((x) => x.id === 2);
  u.quota_bytes = 1000;
  const big = await call(share, { method: 'POST', body: { markdown: '# big\n\n' + 'é'.repeat(600) }, headers: tok });
  assert.equal(big.statusCode, 413, JSON.stringify(big.body));
  assert.match(big.body.error, /too large: 2 KB.*at most 1 KB/);
  assert.equal(db.sb.tables.mdshare_pastes.length, 0);
  u.quota_bytes = 524288;
  u.quota_docs_per_day = 3;
  assert.equal((await call(share, { method: 'POST', body: { markdown: '# one' }, headers: tok })).statusCode, 200);
  assert.equal((await call(diagram, { method: 'POST', body: { svg: '<svg></svg>' }, headers: tok })).statusCode, 200);
  // An old document doesn't count.
  db.sb.seed('mdshare_pastes', { id: 'oldOldOld1', owner_id: 2, content: 'old', created_at: new Date(Date.now() - 25 * 3600e3).toISOString(), expires_at: '2999-01-01T00:00:00Z' });
  assert.equal((await call(share, { method: 'POST', body: { markdown: '# three' }, headers: tok })).statusCode, 200);
  const over = await call(share, { method: 'POST', body: { markdown: '# four' }, headers: tok });
  assert.equal(over.statusCode, 429, JSON.stringify(over.body));
  assert.match(over.body.error, /Daily limit reached: at most 3 documents in 24 hours/);
  const ra = Number(over.headers['retry-after']);
  assert.ok(ra > 23 * 3600 && ra <= 24 * 3600, `Retry-After ${ra}`);
  assert.equal(over.body.retry_after, ra);
  assert.equal((await call(diagram, { method: 'POST', body: { svg: '<svg></svg>' }, headers: tok })).statusCode, 429, 'the count covers every content kind');
  // An edit over the size limit is refused too (cookie edits).
  u.quota_bytes = 100;
  const cookie = cookieFrom(await enter(secretOf(c.body.entry_url)));
  const id = db.sb.tables.mdshare_pastes.find((p) => p.owner_id === 2 && p.content === '# one').id;
  const edit = await call(share, { method: 'PATCH', body: { id, content: 'x'.repeat(500) }, headers: { cookie } });
  assert.equal(edit.statusCode, 413);
  // NULL means unlimited.
  u.quota_bytes = null; u.quota_docs_per_day = null;
  assert.equal((await call(share, { method: 'POST', body: { markdown: '# five' }, headers: tok })).statusCode, 200);
  assert.ok(!db.sb.tables.mdshare_events.some((e) => e.kind === 'server_error'), 'a refusal is not a server error');
});

test('quotas: user #1 is never limited, whatever its row says (G2), and anonymous creates (user #1) neither', async () => {
  reset();
  const owner = db.sb.tables.mdshare_users.find((x) => x.id === 1);
  owner.quota_bytes = 10; owner.quota_docs_per_day = 1;
  for (let i = 0; i < 3; i++) assert.equal((await call(share, { method: 'POST', body: { markdown: `# owner ${i}\n\n${'long '.repeat(50)}` }, headers: { cookie: OWNER } })).statusCode, 200);
  assert.equal((await call(share, { method: 'POST', body: { markdown: '# anon' } })).statusCode, 200);
  assert.equal(db.calls.filter((c) => c.path === '/rest/v1/mdshare_users').length, 0, "the owner's requests never even read the users table");
});

// ---------- Kill switch ----------
test('kill switch: owner-only; a disabled user\'s pages answer like missing ones (public too), tokens 401, cookie = signed out; re-enable restores', async () => {
  reset();
  const c = await signup({ label: 'C' });
  const tok = { authorization: bearer(c.body.token) };
  const cookie = cookieFrom(await enter(secretOf(c.body.entry_url)));
  const made = await call(share, { method: 'POST', body: { markdown: '# C public page\n\nhello world' }, headers: tok });
  assert.equal((await call(pin, { method: 'PATCH', body: { id: made.body.id, kind: 'paste', is_public: true }, headers: tok })).statusCode, 200);
  const anonBefore = await call(render, { query: { id: made.body.id } });
  assert.equal(anonBefore.statusCode, 200);
  assert.match(String(anonBefore.body), /C public page/);

  const disable = (who, body) => call(auth, { method: 'POST', query: { action: 'disable-user' }, body, headers: who });
  assert.equal((await disable({}, { user_id: 2, disabled: true })).statusCode, 401, 'anonymous');
  assert.equal((await disable({ cookie }, { user_id: 2, disabled: true })).statusCode, 403, 'another user');
  const ownerTok = await call(auth, { method: 'POST', body: { action: 'create_token', name: 'kit', scopes: ['documents:read', 'activity:read'] }, headers: { cookie: OWNER } });
  assert.equal((await disable({ authorization: bearer(ownerTok.body.token) }, { user_id: 2, disabled: true })).statusCode, 401, "the owner's token is not the owner's session");
  const one = await disable({ cookie: OWNER }, { user_id: 1, disabled: true });
  assert.deepEqual([one.statusCode, one.body.error], [400, 'User #1 (the owner) can never be disabled']);
  assert.equal(db.sb.tables.mdshare_users.find((u) => u.id === 1).disabled, false);
  assert.equal((await disable({ cookie: OWNER }, { user_id: 99, disabled: true })).statusCode, 404);
  assert.equal((await disable({ cookie: OWNER }, { user_id: 2, disabled: 'yes' })).statusCode, 400);
  const off = await disable({ cookie: OWNER }, { user_id: 2, disabled: true });
  assert.deepEqual([off.statusCode, off.body], [200, { ok: true, user_id: 2, disabled: true }]);

  // Pages: exactly a missing id, for anonymous and for a signed-in reader.
  const missingAnon = await call(render, { query: { id: 'zzMissing1' } });
  const anon = await call(render, { query: { id: made.body.id } });
  assert.deepEqual([anon.statusCode, String(anon.body).split(made.body.id).join('X')], [missingAnon.statusCode, String(missingAnon.body).split('zzMissing1').join('X')]);
  const ownerView = await call(render, { query: { id: made.body.id }, headers: { cookie: OWNER } });
  assert.equal(ownerView.statusCode, 404);
  assert.equal((await call(share, { method: 'GET', query: { id: made.body.id } })).statusCode, 404, '/raw too');
  // Tokens: 401 everywhere.
  assert.equal((await call(share, { method: 'POST', body: { markdown: '# more' }, headers: tok })).statusCode, 401);
  assert.equal((await call(auth, { query: { action: 'whoami' }, headers: tok })).statusCode, 401);
  assert.equal((await call(doc, { query: { action: 'search', q: 'hello' }, headers: tok })).statusCode, 401);
  // Session: signed out; creates are refused rather than filed under the owner.
  assert.equal((await call(dashboard, { query: {}, headers: { cookie } })).statusCode, 401);
  assert.equal((await call(auth, { query: {}, headers: { cookie } })).body.ok, false);
  const anonCreate = await call(share, { method: 'POST', body: { markdown: '# sneaky' }, headers: { cookie } });
  assert.deepEqual([anonCreate.statusCode, anonCreate.body.error], [403, 'This account is disabled.']);
  assert.ok(!db.sb.tables.mdshare_pastes.some((p) => p.content === '# sneaky'));

  // Re-enable: everything is back.
  assert.equal((await disable({ cookie: OWNER }, { user_id: 2, disabled: false })).statusCode, 200);
  assert.equal((await call(render, { query: { id: made.body.id } })).statusCode, 200);
  assert.equal((await call(auth, { query: { action: 'whoami' }, headers: tok })).statusCode, 200);
  assert.equal((await call(dashboard, { query: {}, headers: { cookie } })).statusCode, 200);
});

test('a cookie for a user with no row (never signed up) is signed out', async () => {
  reset();
  const ghost = await userCookie(77);
  assert.equal((await call(pastes, { headers: { cookie: ghost } })).statusCode, 401);
  assert.equal((await call(dashboard, { headers: { cookie: ghost } })).statusCode, 401);
});

// ---------- Stats ----------
test('stats: the owner only (cookie, or a user-#1 token with activity:read); counts, no titles or content', async () => {
  reset();
  const c = await signup({ label: 'C stats' });
  const tok = { authorization: bearer(c.body.token) };
  for (const m of ['# Secret title one\n\nsecret body', '# Secret title two']) await call(share, { method: 'POST', body: { markdown: m }, headers: tok });
  db.sb.seed('mdshare_pastes', { id: 'lastWeek01', owner_id: 2, title: 'Secret old', content: 'x', created_at: new Date(Date.now() - 9 * 86400e3).toISOString(), expires_at: '2999-01-01T00:00:00Z' });
  const cookie = cookieFrom(await enter(secretOf(c.body.entry_url)));
  const id = db.sb.tables.mdshare_pastes.find((p) => p.owner_id === 2).id;
  assert.equal((await call(doc, { method: 'POST', query: { action: 'read' }, body: { id, open: true, scroll: 10, seconds: 3 }, headers: { cookie } })).statusCode, 204);

  const r = await call(doc, { query: { action: 'stats' }, headers: { cookie: OWNER } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const cRow = r.body.users.find((u) => u.user_id === 2);
  assert.deepEqual({ ...cRow, created_at: 'T', last_active: !!cRow.last_active }, { user_id: 2, label: 'C stats', created_at: 'T', disabled: false, docs_this_week: 2, docs_last_week: 1, docs_total: 3, opened_by_owner: 1, opened_this_week: 1, last_active: true });
  assert.deepEqual(r.body.seats, { used: 1, max: 50 });
  assert.deepEqual(r.body.totals, { users: 1, publishing_this_week: 1, publishing_both_weeks: 1, opening_their_pages_this_week: 1 });
  assert.doesNotMatch(JSON.stringify(r.body), /Secret|secret body|entry_hash|token/i, 'no titles, content, hashes or tokens');

  const kit = await call(auth, { method: 'POST', body: { action: 'create_token', name: 'kit', scopes: ['activity:read'] }, headers: { cookie: OWNER } });
  assert.equal((await call(doc, { query: { action: 'stats' }, headers: { authorization: bearer(kit.body.token) } })).statusCode, 200);
  const kitRo = await call(auth, { method: 'POST', body: { action: 'create_token', name: 'kit-ro', scopes: ['documents:read'] }, headers: { cookie: OWNER } });
  assert.equal((await call(doc, { query: { action: 'stats' }, headers: { authorization: bearer(kitRo.body.token) } })).statusCode, 403);
  const cAct = await call(auth, { method: 'POST', body: { action: 'create_token', name: 'c-act', scopes: ['activity:read'] }, headers: { cookie } });
  for (const who of [{ cookie }, tok, { authorization: bearer(cAct.body.token) }]) {
    const x = await call(doc, { query: { action: 'stats' }, headers: who });
    assert.ok(x.statusCode === 401 || x.statusCode === 403, `refused (${x.statusCode})`);
    assert.doesNotMatch(JSON.stringify(x.body), /C stats|docs_total/);
  }
  assert.equal((await call(doc, { query: { action: 'stats' } })).statusCode, 401);
});

// ---------- Settings ----------
test('Settings: a new user gets the entry-link card and only their own tokens; the owner gets neither change', async () => {
  reset();
  const c = await signup({ label: 'C' });
  const cookie = cookieFrom(await enter(secretOf(c.body.entry_url)));
  const mine = await call(dashboard, { query: { view: 'settings' }, headers: { cookie } });
  assert.match(String(mine.body), /id="btn-entry-link"/);
  assert.doesNotMatch(String(mine.body), /Signed in as the owner/);
  const owners = await call(dashboard, { query: { view: 'settings' }, headers: { cookie: OWNER } });
  assert.doesNotMatch(String(owners.body), /btn-entry-link/);
  assert.match(String(owners.body), /Signed in as the owner/);
  await call(auth, { method: 'POST', body: { action: 'create_token', name: 'owner-kit' }, headers: { cookie: OWNER } });
  const list = await call(auth, { query: { action: 'tokens' }, headers: { cookie } });
  assert.deepEqual(list.body.tokens.map((t) => t.name), ['mdshare skill (C)']);
});
