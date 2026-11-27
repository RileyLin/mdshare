// Reading loop (migration 009): read receipts, feedback, versions, publish checks, origin.
// Contracts proven here:
//  - every api/doc.js action enforces its declared auth (anonymous, legacy, wrong-scope, right-scope, owner)
//  - the read beacon answers 204 to everyone but writes only for the owner
//  - feedback and receipts never write a content table (stored Markdown and visibility untouched)
//  - only the owner or a token that can read the parent can create a version; anonymous never,
//    even when the parent is public
//  - origin is stored only for trusted creators; keep:true that isn't honoured says why
//  - every create response carries publish checks
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, asUser } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
test.after(() => db.close());

const { default: authHandler } = await import('../api/auth.js');
const { default: docHandler, _ACTIONS } = await import('../api/doc.js');
const { default: shareHandler } = await import('../api/share.js');
const { default: renderHandler } = await import('../api/render.js');
const { createToken } = await import('../api/_lib/agent-tokens.js');
const { activityWrite, ACTIVITY_TABLES } = await import('../api/_lib/activity.js');

let ip = 0;
const nextIp = () => `10.0.0.${++ip}`;
async function ownerCookie() {
  const res = responseRecorder();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.9' } }, res);
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}
const COOKIE = await ownerCookie();
const tok = async (scopes) => (await createToken(await asUser(1), { name: `t-${Math.random()}`, expiresInDays: 1, scopes })).token;
const bearer = (t) => ({ authorization: `Bearer ${t}` });

async function call(handler, { method = 'GET', query = {}, body, headers = {} }) {
  const res = responseRecorder();
  await handler({ method, query, body, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: nextIp() } }, res);
  return res;
}
const doc = (q, o) => call(docHandler, { ...o, query: q });
async function seedPaste(extra = {}) {
  const id = `p${Math.random().toString(36).slice(2, 11)}`;
  db.sb.seed('mdshare_pastes', { id, content: `# Doc ${id}\n\nHello world.`, title: `Doc ${id}`, expires_at: '2999-01-01T00:00:00Z', ...extra });
  return id;
}
const contentWrites = () => db.writes().filter((c) => /mdshare_(pastes|diagrams|archify)/.test(c.path));

// ---------- auth matrix ----------
test('every action declares auth, and the matrix holds for each one', async () => {
  const id = await seedPaste();
  const legacy = await tok(undefined);
  const readOnly = await tok(['documents:read']);
  const actRead = await tok(['activity:read']);
  const actWrite = await tok(['activity:write']);
  const docsRead = await tok(['documents:read']);
  for (const [name, a] of Object.entries(_ACTIONS)) assert.ok(a.auth, `${name} declares auth`);

  // reads: owner | activity:read
  assert.equal((await doc({ action: 'reads', ids: id }, {})).statusCode, 401);
  assert.equal((await doc({ action: 'reads', ids: id }, { headers: bearer(legacy) })).statusCode, 403);
  assert.equal((await doc({ action: 'reads', ids: id }, { headers: bearer(readOnly) })).statusCode, 403);
  assert.equal((await doc({ action: 'reads', ids: id }, { headers: bearer(actRead) })).statusCode, 200);
  assert.equal((await doc({ action: 'reads', ids: id }, { headers: { cookie: COOKIE } })).statusCode, 200);
  assert.equal((await doc({ action: 'reads', ids: id }, { headers: bearer('mds_not_a_real_token') })).statusCode, 401);

  // feedback GET: owner | activity:read ; POST: owner only (no token may post feedback)
  assert.equal((await doc({ action: 'feedback', id }, {})).statusCode, 401);
  assert.equal((await doc({ action: 'feedback', id }, { headers: bearer(actRead) })).statusCode, 200);
  const fbBody = { id, kind: 'unclear', quote: 'Hello world' };
  assert.equal((await doc({ action: 'feedback' }, { method: 'POST', body: fbBody })).statusCode, 401);
  assert.equal((await doc({ action: 'feedback' }, { method: 'POST', body: fbBody, headers: bearer(actWrite) })).statusCode, 403);
  assert.equal((await doc({ action: 'feedback' }, { method: 'POST', body: fbBody, headers: { cookie: COOKIE } })).statusCode, 200);

  // resolve: owner | activity:write
  const fb = (await doc({ action: 'feedback', id }, { headers: { cookie: COOKIE } })).body.items[0];
  assert.equal((await doc({ action: 'resolve' }, { method: 'POST', body: { ids: [fb.id] } })).statusCode, 401);
  assert.equal((await doc({ action: 'resolve' }, { method: 'POST', body: { ids: [fb.id] }, headers: bearer(actRead) })).statusCode, 403);
  assert.equal((await doc({ action: 'resolve' }, { method: 'POST', body: { ids: [fb.id] }, headers: bearer(actWrite) })).statusCode, 200);

  // versions: owner | documents:read
  assert.equal((await doc({ action: 'versions', id }, {})).statusCode, 401);
  assert.equal((await doc({ action: 'versions', id }, { headers: bearer(actRead) })).statusCode, 403);
  assert.equal((await doc({ action: 'versions', id }, { headers: bearer(docsRead) })).statusCode, 200);

  // unknown action and wrong method
  assert.equal((await doc({ action: 'drop' }, {})).statusCode, 400);
  assert.equal((await doc({ action: 'read' }, { method: 'GET' })).statusCode, 405);
});

// ---------- read receipts ----------
test('read beacon: 204 for everyone, but only the owner is recorded', async () => {
  const id = await seedPaste();
  const t = await tok(['activity:write', 'activity:read', 'documents:read']);
  const readWrites = () => db.writes().filter((c) => c.path.endsWith('/mdshare_reads')).length;
  const before = readWrites();
  const anon = await doc({ action: 'read' }, { method: 'POST', body: { id, open: true, scroll: 40, seconds: 10 } });
  const agent = await doc({ action: 'read' }, { method: 'POST', body: { id, open: true }, headers: bearer(t) });
  assert.equal(anon.statusCode, 204);
  assert.equal(agent.statusCode, 204);
  assert.equal(readWrites(), before, 'anonymous and token beacons write nothing');
  assert.equal(db.sb.tables.mdshare_reads.filter((r) => r.doc_id === id).length, 0);

  assert.equal((await doc({ action: 'read' }, { method: 'POST', body: { id, open: true, scroll: 40, seconds: 12 }, headers: { cookie: COOKIE } })).statusCode, 204);
  assert.equal((await doc({ action: 'read' }, { method: 'POST', body: { id, scroll: 90, seconds: 30 }, headers: { cookie: COOKIE } })).statusCode, 204);
  assert.equal((await doc({ action: 'read' }, { method: 'POST', body: { id, scroll: 20, seconds: 99999 }, headers: { cookie: COOKIE } })).statusCode, 204);
  const row = db.sb.tables.mdshare_reads.find((r) => r.doc_id === id);
  assert.equal(row.open_count, 1, 'only beacons with open:true count as opens');
  assert.equal(row.max_scroll, 90, 'max scroll never goes down');
  assert.equal(row.active_seconds, 12 + 30 + 900, 'seconds are clamped to 900 per beacon');
  assert.equal(contentWrites().length, 0, 'receipts never write a content table');

  const r = await doc({ action: 'reads', ids: id }, { headers: { cookie: COOKIE } });
  assert.equal(r.body.items[0].opened, true);
  assert.equal(r.body.items[0].max_scroll, 90);

  const unreadId = await seedPaste({ created_at: new Date().toISOString(), origin: 'agent:main:telegram:group:-1' });
  const u = await doc({ action: 'reads', unread: '1', days: '3' }, { headers: { cookie: COOKIE } });
  const ids = u.body.items.map((x) => x.id);
  assert.ok(ids.includes(unreadId), 'a new unopened document is listed as unread');
  assert.ok(!ids.includes(id), 'an opened document is not');
  assert.equal(u.body.items.find((x) => x.id === unreadId).origin, 'agent:main:telegram:group:-1');

  assert.equal((await doc({ action: 'read' }, { method: 'POST', body: { id: 'nope_missing', open: true }, headers: { cookie: COOKIE } })).statusCode, 404);
  assert.equal((await doc({ action: 'read' }, { method: 'POST', body: { id: 'bad id!' }, headers: { cookie: COOKIE } })).statusCode, 400);
});

// ---------- feedback ----------
test('feedback: validated, stored with context, listed with doc title and origin, never touches content', async () => {
  const id = await seedPaste({ origin: 'agent:main:telegram:group:-5096572127' });
  const original = db.sb.tables.mdshare_pastes.find((p) => p.id === id).content;
  const bad = [
    { id, kind: 'hack', quote: 'x y' },
    { id, kind: 'unclear' },
    { id, kind: 'note', quote: 'some text' },
    { id: 'bad id', kind: 'unclear', quote: 'abc' },
  ];
  for (const body of bad) assert.equal((await doc({ action: 'feedback' }, { method: 'POST', body, headers: { cookie: COOKIE } })).statusCode, 400, JSON.stringify(body));
  assert.equal((await doc({ action: 'feedback' }, { method: 'POST', body: { id: 'zzzzzzzzz0', kind: 'unclear', quote: 'abc' }, headers: { cookie: COOKIE } })).statusCode, 404);

  const ok = await doc({ action: 'feedback' }, { method: 'POST', headers: { cookie: COOKIE }, body: { id, kind: 'example', quote: 'Hello world'.repeat(200), note: 'n'.repeat(5000), context: { heading: 'Intro', before: 'b', after: 'a', extra: 'dropped' }, status: 'resolved' } });
  assert.equal(ok.statusCode, 200);
  const stored = db.sb.tables.mdshare_feedback.find((f) => f.id === ok.body.feedback.id);
  assert.match(stored.id, /^fb_/);
  assert.equal(stored.status, 'open', 'status from the request body is ignored');
  assert.equal(stored.quote.length, 1000);
  assert.equal(stored.note.length, 2000);
  assert.deepEqual(stored.context, { heading: 'Intro', before: 'b', after: 'a' });

  const list = await doc({ action: 'feedback', status: 'open' }, { headers: { cookie: COOKIE } });
  const item = list.body.items.find((f) => f.id === stored.id);
  assert.equal(item.doc_title, `Doc ${id}`);
  assert.equal(item.origin, 'agent:main:telegram:group:-5096572127');
  assert.equal((await doc({ action: 'feedback', status: 'weird' }, { headers: { cookie: COOKIE } })).statusCode, 400);

  const newer = await seedPaste({ parent_id: id });
  const res = await doc({ action: 'resolve' }, { method: 'POST', headers: { cookie: COOKIE }, body: { ids: [stored.id], status: 'resolved', resolved_in: newer } });
  assert.deepEqual(res.body.updated, [stored.id]);
  const after = db.sb.tables.mdshare_feedback.find((f) => f.id === stored.id);
  assert.equal(after.status, 'resolved');
  assert.equal(after.resolved_in, newer);
  assert.ok(after.resolved_at);
  assert.equal((await doc({ action: 'resolve' }, { method: 'POST', headers: { cookie: COOKIE }, body: { ids: ['not-an-fb'] } })).statusCode, 400);
  assert.equal((await doc({ action: 'resolve' }, { method: 'POST', headers: { cookie: COOKIE }, body: { ids: [stored.id], resolved_in: 'bad id' } })).statusCode, 400);

  assert.equal(db.sb.tables.mdshare_pastes.find((p) => p.id === id).content, original, 'stored Markdown unchanged');
  assert.equal(contentWrites().length, 0, 'feedback never writes a content table');
});

test('activityWrite refuses every non-activity table', async () => {
  assert.deepEqual(ACTIVITY_TABLES, ['mdshare_reads', 'mdshare_feedback']);
  for (const t of ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify', 'mdshare_agent_tokens', 'mdshare_events']) {
    await assert.rejects(activityWrite(t, 'PATCH', 'id=eq.x', { content: 'pwned' }), /not an activity table/);
  }
  await assert.rejects(activityWrite('mdshare_feedback', 'DELETE', 'id=eq.x', {}), /unsupported method/);
});

// ---------- versions ----------
async function create(body, headers = {}) { return call(shareHandler, { method: 'POST', body, headers }); }

test('versions: owner and readers of the parent can link; anonymous never, even to a public parent', async () => {
  const parent = await seedPaste();
  const pub = await seedPaste({ is_public: true });

  const anon = await create({ markdown: '# v2', parent });
  assert.equal(anon.statusCode, 404);
  const anonPub = await create({ markdown: '# v2', parent: pub });
  assert.equal(anonPub.statusCode, 404, 'a public parent does not let a stranger attach a version');
  assert.ok(!db.sb.tables.mdshare_pastes.some((p) => p.parent_id === pub), 'nothing was inserted');

  const owner = await create({ markdown: '# v2 owner', parent }, { cookie: COOKIE });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body.parent, parent);
  assert.equal(db.sb.tables.mdshare_pastes.find((p) => p.id === owner.body.id).parent_id, parent);

  const writeOnly = await tok(['documents:write']);
  assert.equal((await create({ markdown: '# v2', parent }, bearer(writeOnly))).statusCode, 404, 'write-only token cannot link to a row it did not create');
  const own = await create({ markdown: '# mine v1' }, bearer(writeOnly));
  const ownV2 = await create({ markdown: '# mine v2', parent: own.body.id }, bearer(writeOnly));
  assert.equal(ownV2.statusCode, 200, 'a token may version its own document');
  const reader = await tok(['documents:read', 'documents:write']);
  assert.equal((await create({ markdown: '# v3', parent: owner.body.id }, bearer(reader))).statusCode, 200, 'documents:read may version any document');

  assert.equal((await create({ markdown: '# x', parent: 'bad id!' }, { cookie: COOKIE })).statusCode, 404);
  assert.equal((await create({ markdown: '# x', parent: 'zzzzzzzzz0' }, { cookie: COOKIE })).statusCode, 404);

  const chain = await doc({ action: 'versions', id: owner.body.id }, { headers: { cookie: COOKIE } });
  assert.deepEqual(chain.body.versions.map((v) => v.version), [1, 2, 3]);
  assert.equal(chain.body.versions[0].id, parent);
  const v3row = db.sb.tables.mdshare_pastes.find((p) => p.parent_id === owner.body.id);
  assert.equal(v3row.root_id, parent, 'every version stores the first version as root_id');
  assert.equal(v3row.version_no, 3, 'and its own number');
  assert.equal(db.sb.tables.mdshare_pastes.find((p) => p.id === owner.body.id).version_no, 2);
});

test('reader page: owner sees version line and newer banner; a reader sees the banner only when the newer version is public', async () => {
  const v1 = await seedPaste({ is_public: true, content: '# 第一版\n\n' + '中文内容'.repeat(20) });
  const v2 = await seedPaste({ parent_id: v1, root_id: v1, version_no: 2, is_public: false, title: 'Second' });
  const ownerV1 = await call(renderHandler, { query: { id: v1 }, headers: { cookie: COOKIE } });
  assert.match(ownerV1.body, /id="version-banner" href="\/v\/[^"]+"/);
  assert.match(ownerV1.body, /这篇已有新版本/, 'Chinese document gets a Chinese banner');
  assert.match(ownerV1.body, /\/assets\/loop\.js/, 'owner page loads the loop script');
  const anonV1 = await call(renderHandler, { query: { id: v1 } });
  assert.equal(anonV1.statusCode, 200);
  assert.doesNotMatch(anonV1.body, /version-banner/, 'private newer version is not revealed');
  assert.doesNotMatch(anonV1.body, /loop\.js/, 'readers never load the loop script');
  assert.doesNotMatch(anonV1.body, new RegExp(v2));

  db.sb.tables.mdshare_pastes.find((p) => p.id === v2).is_public = true;
  const anonV1b = await call(renderHandler, { query: { id: v1 } });
  assert.match(anonV1b.body, new RegExp(`href="/v/${v2}"`), 'public newer version is announced to readers');

  const ownerV2 = await call(renderHandler, { query: { id: v2 }, headers: { cookie: COOKIE } });
  assert.match(ownerV2.body, /id="version-line"/);
  assert.match(ownerV2.body, /v2/);
  assert.match(ownerV2.body, /id="btn-diff"/);
  const asReader = await call(renderHandler, { query: { id: v2, as: 'reader' }, headers: { cookie: COOKIE } });
  assert.doesNotMatch(asReader.body, /version-line|loop\.js/, '?as=reader shows the reader view');
});

// ---------- create response: checks, origin, keep ----------
test('create: checks always present; origin only for trusted creators; ignored keep says why', async () => {
  const anon = await create({ markdown: '# T\n\n```js\nunclosed', origin: 'agent:main:x', keep: true });
  assert.equal(anon.statusCode, 200);
  assert.equal(anon.body.checks.ok, false);
  assert.ok(anon.body.checks.warnings.some((w) => w.rule === 'unclosed-fence'));
  assert.equal(anon.body.kept, false);
  assert.match(anon.body.keep_ignored, /owner session or an agent token/);
  assert.equal(anon.body.origin, undefined);
  assert.equal(db.sb.tables.mdshare_pastes.find((p) => p.id === anon.body.id).origin, null, 'anonymous origin is not stored');

  const t = await tok(['documents:write']);
  const agent = await create({ markdown: '# Fine\n\nok', origin: 'agent:main:telegram:group:-5096572127', keep: true }, bearer(t));
  assert.equal(agent.body.kept, true);
  assert.equal(agent.body.keep_ignored, undefined);
  assert.equal(agent.body.checks.ok, true);
  assert.equal(agent.body.origin, 'agent:main:telegram:group:-5096572127');
  const bad = await create({ markdown: '# o', origin: '<script>alert(1)</script>' }, bearer(t));
  assert.equal(bad.body.origin, undefined, 'origin with unsafe characters is dropped');
  const row = db.sb.tables.mdshare_pastes.find((p) => p.id === agent.body.id);
  assert.equal(row.is_public, false, 'still private by default');
});

// Adversarial review 2026-11-25, finding 1: version lookups used to walk the chain one query per
// hop on every page view. They are now O(1); these counts are the contract.
test('version lookups cost a fixed number of queries however long the chain is', async () => {
  const N = 30;
  const ids = [];
  for (let i = 0; i < N; i++) {
    const extra = i === 0 ? { is_public: true } : { is_public: true, parent_id: ids[i - 1], root_id: ids[0], version_no: i + 1 };
    ids.push(await seedPaste(extra));
  }
  const count = async (fn) => { const before = db.calls.length; const r = await fn(); return { r, n: db.calls.length - before }; };

  const anonOld = await count(() => call(renderHandler, { query: { id: ids[0] } }));
  assert.equal(anonOld.r.statusCode, 200);
  assert.match(anonOld.r.body, new RegExp(`href="/v/${ids[N - 1]}"`), 'the oldest version points at the newest');
  assert.ok(anonOld.n <= 2, `anonymous page view of the oldest version: ${anonOld.n} queries (row + family)`);

  const ownerMid = await count(() => call(renderHandler, { query: { id: ids[12] }, headers: { cookie: COOKIE } }));
  assert.match(ownerMid.r.body, /v13/, 'owner sees the stored version number');
  assert.ok(ownerMid.n <= 2, `owner page view in the middle of the chain: ${ownerMid.n} queries`);

  const api = await count(() => doc({ action: 'versions', id: ids[12] }, { headers: { cookie: COOKIE } }));
  assert.equal(api.r.body.versions.length, N);
  assert.deepEqual(api.r.body.versions.map((v) => v.version), Array.from({ length: N }, (_, i) => i + 1));
  assert.ok(api.n <= 3, `versions API: ${api.n} queries (token check aside: row + family)`);

  const newest = await count(() => call(renderHandler, { query: { id: ids[N - 1] } }));
  assert.doesNotMatch(newest.r.body, /version-banner/, 'the newest version has no banner');
  assert.ok(newest.n <= 2);
});

test('a branch (two versions of one parent) points the old version at the newest of them', async () => {
  const v1 = await seedPaste({ is_public: true });
  await seedPaste({ parent_id: v1, root_id: v1, version_no: 2, is_public: true, created_at: '2026-01-01T00:00:00Z' });
  const b = await seedPaste({ parent_id: v1, root_id: v1, version_no: 2, is_public: true, created_at: '2026-02-01T00:00:00Z' });
  const expired = await seedPaste({ parent_id: b, root_id: v1, version_no: 3, is_public: true, expires_at: '2000-01-01T00:00:00Z' });
  const page = await call(renderHandler, { query: { id: v1 } });
  assert.match(page.body, new RegExp(`href="/v/${b}"`), 'newest live version wins; an expired v3 is skipped');
  assert.doesNotMatch(page.body, new RegExp(expired));
});
