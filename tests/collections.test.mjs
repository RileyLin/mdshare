// Collections (migration 012). Contracts proven here:
//  - a collection slug is validated; anonymous creates can't put documents in a collection
//  - the collection action: GET owner|documents:read; POST owner, or a write/publish token on rows
//    it created (same 404 for not-yours and missing), for the whole version family, metadata only
//  - /c and /c/:slug answer everyone but the owner with the same 401 gate and zero queries,
//    for an existing, a missing and a malformed slug alike, Bearer tokens included
//  - the owner's table of contents: newest version only (superseded hidden), a zh/en pair is one
//    entry with both links, series order, read status and kept
//  - a page costs a fixed number of queries: TOC 3, index 1, for 5 or 60 documents
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
test.after(() => db.close());

const { default: authHandler } = await import('../api/auth.js');
const { default: docHandler } = await import('../api/doc.js');
const { default: shareHandler } = await import('../api/share.js');
const { default: renderHandler } = await import('../api/render.js');
const { default: pastesHandler } = await import('../api/pastes.js');
const { createToken } = await import('../api/_lib/agent-tokens.js');
const { parseCollection, patchMeta } = await import('../api/_lib/collections.js');

let ip = 0;
const nextIp = () => `10.4.0.${++ip % 250}`;
async function ownerCookie() {
  const res = responseRecorder();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.41' } }, res);
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}
const COOKIE = await ownerCookie();
const OWNER = { cookie: COOKIE };
const tok = async (scopes) => createToken({ name: `t-${Math.random()}`, expiresInDays: 1, scopes });
const bearer = (t) => ({ authorization: ['Bea', 'rer'].join('') + ' ' + (t.token || t) });

async function call(handler, { method = 'GET', query = {}, body, headers = {} }) {
  const res = responseRecorder();
  await handler({ method, query, body, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: nextIp() } }, res);
  return res;
}
const create = (body, headers = {}) => call(shareHandler, { method: 'POST', body, headers });
const cpage = (slug, headers = {}) => call(renderHandler, { query: slug === undefined ? { kind: 'collection' } : { kind: 'collection', slug }, headers });
const api = (query, headers = {}) => call(docHandler, { query: { action: 'collection', ...query }, headers });
const setColl = (body, headers = {}) => call(docHandler, { method: 'POST', query: { action: 'collection' }, body, headers });
const row = (id) => db.sb.tables.mdshare_pastes.find((p) => p.id === id);
let n = 0;
async function seed(extra = {}) {
  const id = `c${Math.random().toString(36).slice(2, 11)}`;
  const created_at = new Date(Date.UTC(2026, 0, 1) + (++n) * 3600000).toISOString();
  db.sb.seed('mdshare_pastes', { id, content: `# Doc ${id}\n\nbody`, title: `Doc ${id}`, expires_at: '2999-01-01T00:00:00Z', created_at, ...extra });
  return id;
}
const count = async (fn) => { const before = db.calls.length; const r = await fn(); return { r, n: db.calls.length - before }; };

test('slug format', () => {
  for (const ok of ['a', 'glm-study', 'kimi-prep-2', 'x9', '0-0']) assert.equal(parseCollection(ok), ok);
  assert.equal(parseCollection(' GLM-Study '), 'glm-study', 'trimmed and lowercased');
  for (const bad of ['-a', 'a-', 'a b', 'a_b', '中文', 'a/b', 'a.b', 'x'.repeat(49), '../x', 'a,b', 7, {}, ['a']]) assert.equal(parseCollection(bad), undefined, JSON.stringify(bad));
  assert.equal(parseCollection(null), null);
  assert.equal(parseCollection(''), null);
});

test('publish: owner and tokens can set a collection; anonymous is ignored with a reason; bad slugs are 400', async () => {
  const anon = await create({ markdown: '# a', collection: 'glm-study' });
  assert.equal(anon.statusCode, 200);
  assert.equal(row(anon.body.id).collection, null, 'anonymous creates are in no collection');
  assert.match(anon.body.collection_ignored, /owner session or an agent token/);
  const t = await tok(['documents:write']);
  const agent = await create({ markdown: '# b', collection: 'GLM-study' }, bearer(t));
  assert.equal(agent.body.collection, 'glm-study');
  assert.equal(row(agent.body.id).collection, 'glm-study');
  assert.equal(row(agent.body.id).is_public, false, 'still private by default');
  const owner = await create({ markdown: '# c', collection: 'kimi-prep' }, OWNER);
  assert.equal(row(owner.body.id).collection, 'kimi-prep');
  const bad = await create({ markdown: '# d', collection: 'not a slug' }, OWNER);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /collection must be a slug/);
  const v2 = await create({ markdown: '# c v2', parent: owner.body.id }, OWNER);
  assert.equal(row(v2.body.id).collection, 'kimi-prep', 'a new version stays in the collection');
});

test('collection action: auth matrix; tokens only on their own rows, same 404 as missing; whole family; metadata only', async () => {
  const v1 = await seed();
  const v2 = await seed({ parent_id: v1, root_id: v1, version_no: 2 });
  const body = { id: v2, collection: 'mdshare' };
  assert.equal((await setColl(body)).statusCode, 401);
  assert.match((await setColl(body)).headers['www-authenticate'] || '', /^Bearer/);
  assert.equal((await setColl(body, bearer(await tok(['documents:read'])))).statusCode, 403);
  assert.equal((await setColl(body, bearer(await tok(undefined)))).statusCode, 403, 'legacy token');
  assert.equal((await setColl(body, bearer('mds_not_a_real_token'))).statusCode, 401);
  for (const scopes of [['documents:write'], ['documents:publish']]) {
    const t = await tok(scopes);
    const notMine = await setColl(body, bearer(t));
    const missing = await setColl({ ...body, id: 'zzzzzzzzz0' }, bearer(t));
    assert.equal(notMine.statusCode, 404, `${scopes}: not its row`);
    assert.deepEqual(notMine.body, missing.body, `${scopes}: same answer as a missing id`);
  }
  assert.equal(row(v1).collection, null, 'nothing changed');

  const before = JSON.stringify(db.sb.tables.mdshare_pastes.map((p) => [p.id, p.content, p.is_public, p.expires_at, p.pinned, p.title]));
  const ok = await setColl(body, OWNER);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.updated.sort(), [v1, v2].sort(), 'the whole version family, in one write');
  assert.deepEqual([row(v1).collection, row(v2).collection], ['mdshare', 'mdshare']);
  assert.equal(JSON.stringify(db.sb.tables.mdshare_pastes.map((p) => [p.id, p.content, p.is_public, p.expires_at, p.pinned, p.title])), before, 'content, title, visibility and expiry untouched');

  const t = await tok(['documents:write', 'documents:read']);
  const mine = await create({ markdown: '# mine' }, bearer(t));
  const ownerV2 = await create({ markdown: '# mine v2', parent: mine.body.id }, OWNER);
  const mineSet = await setColl({ id: mine.body.id, collection: 'agent-notes' }, bearer(t));
  assert.equal(mineSet.statusCode, 200, 'a write token may file its own document');
  assert.deepEqual(mineSet.body.updated, [mine.body.id], 'but never the owner\'s version of it');
  assert.equal(row(ownerV2.body.id).collection, null);

  assert.equal((await setColl({ id: v1, collection: 'Bad Slug!' }, OWNER)).statusCode, 400);
  assert.equal((await setColl({ id: v1 }, OWNER)).statusCode, 400, 'collection is required (null removes)');
  const rm = await setColl({ id: v1, collection: null }, OWNER);
  assert.equal(rm.statusCode, 200);
  assert.equal(row(v2).collection, null, 'null removes the family from the collection');
  assert.equal((await setColl({ id: 'bad id!', collection: 'x' }, OWNER)).statusCode, 400);
  await assert.rejects(patchMeta('id=eq.x', { content: 'pwned' }), /only lang, translation_of, collection/);
  await assert.rejects(patchMeta('id=eq.x', { collection: 'a', is_public: true }), /only lang, translation_of, collection/);

  assert.equal((await api({})).statusCode, 401);
  assert.equal((await api({}, bearer(await tok(['documents:write'])))).statusCode, 403);
  assert.equal((await api({}, bearer(await tok(['documents:read'])))).statusCode, 200, 'documents:read lists collections');
  assert.equal((await api({ slug: 'Bad Slug' }, OWNER)).statusCode, 400);
});

test('/c and /c/:slug: the same gate for everyone but the owner, before any query', async () => {
  const id = await seed({ collection: 'secret-plans', title: 'Top secret title' });
  void id;
  const readTok = await tok(['documents:read', 'documents:write', 'documents:publish:any']);
  const shapes = [];
  for (const headers of [{}, bearer(readTok), bearer('mds_not_a_real_token'), { 'x-api-key': readTok.token }, { cookie: 'mdshare_auth=forged' }]) {
    for (const slug of ['secret-plans', 'no-such-thing', 'Bad Slug!', undefined, '']) {
      const { r, n: q } = await count(() => cpage(slug, headers));
      assert.equal(r.statusCode, 401, `${JSON.stringify(headers)} ${slug}`);
      assert.equal(q, 0, `no database call before the gate (${slug}): ${q}`);
      assert.doesNotMatch(r.body, /Top secret title|secret-plans/);
      assert.equal(r.headers['cache-control'], 'private, no-store');
      assert.match(r.headers['www-authenticate'] || '', /^Bearer/);
      shapes.push(r.body);
    }
  }
  assert.equal(new Set(shapes).size, 1, 'byte-identical body for every slug and credential');
  assert.match(shapes[0], /Collections are owner-only pages/);
});

test('owner TOC: newest version only, a zh/en pair is one entry, series order, read status and kept', async () => {
  const slug = 'glm-toc';
  const a1 = await seed({ collection: slug, title: 'Part 1 draft', lang: 'en' });
  const a2 = await seed({ collection: slug, title: 'Part 1', parent_id: a1, root_id: a1, version_no: 2, lang: 'en', pinned: true, expires_at: '2099-12-31T00:00:00Z' });
  const aZh = await seed({ collection: slug, title: '第一部分', lang: 'zh', translation_of: a1 });
  const b = await seed({ collection: slug, title: 'Part 2' });
  const bNewer = await seed({ title: 'Part 2 (revised, filed nowhere)', parent_id: b, root_id: b, version_no: 2 });
  const cZh = await seed({ collection: slug, title: '第三部分', lang: 'zh' });
  const cEn = await seed({ title: 'Part 3', lang: 'en', translation_of: cZh });   // translation not in the collection
  await seed({ collection: slug, title: 'Gone', expires_at: '2000-01-01T00:00:00Z' });
  await seed({ collection: 'other', title: 'Elsewhere' });
  db.sb.seed('mdshare_reads', { doc_id: a2, open_count: 2, max_scroll: 80 });
  db.sb.seed('mdshare_reads', { doc_id: b, open_count: 1, max_scroll: 100 });   // read the superseded v1 only

  const { r, n: q } = await count(() => api({ slug }, OWNER));
  assert.equal(r.statusCode, 200);
  assert.equal(q, 3, `TOC: ${q} queries`);
  const items = r.body.items;
  assert.deepEqual(items.map((e) => e.title), ['Part 1', 'Part 2 (revised, filed nowhere)', '第三部分'], 'series order, newest titles, expired and other collections left out');
  assert.deepEqual(items[0].links.map((l) => [l.lang, l.id]), [['zh', aZh], ['en', a2]], 'the pair is one entry, 中文 first, newest en version');
  assert.equal(items[0].superseded, 1);
  assert.equal(items[0].kept, true);
  assert.equal(items[0].opened, true);
  assert.equal(items[0].max_scroll, 80);
  assert.deepEqual(items[1].links.map((l) => l.id), [bNewer], 'a newer version outside the collection replaces the old one');
  assert.equal(items[1].opened, false, 'reading the old version does not mark the new one read');
  assert.deepEqual(items[2].links.map((l) => [l.lang, l.id]), [['zh', cZh], ['en', cEn]], 'a translation outside the collection still pairs');
  assert.ok(!JSON.stringify(r.body).includes('"content"'), 'no document bodies in the TOC');

  const html = await cpage(slug, OWNER);
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers['cache-control'], 'private, no-store');
  const rows = [...html.body.matchAll(/<li class="coll-row" data-key="([^"]+)" data-id="([^"]+)">/g)].map((m) => m[2]);
  assert.deepEqual(rows, [a2, bNewer, cZh]);
  assert.match(html.body, new RegExp(`<a href="/v/${aZh}" lang="zh" hreflang="zh" data-lang="zh">中文</a><a href="/v/${a2}" lang="en" hreflang="en" data-lang="en" class="seen">English</a>`));
  assert.match(html.body, /<span class="tag read" data-read="1">Read · 80%<\/span>/);
  assert.match(html.body, /⭐ Kept/);
  assert.match(html.body, /3 documents · 1 read/);
  assert.doesNotMatch(html.body, new RegExp(`/v/${a1}"|/v/${b}"`), 'superseded versions are not linked');
  assert.doesNotMatch(html.body, /loop\.js/);

  assert.equal((await cpage('no-such-thing', OWNER)).statusCode, 404);
  assert.equal((await cpage('Bad Slug!', OWNER)).statusCode, 404);
  const idx = await count(() => cpage(undefined, OWNER));
  assert.equal(idx.r.statusCode, 200);
  assert.equal(idx.n, 1, 'index: one query');
  assert.match(idx.r.body, /<a href="\/c\/glm-toc" data-slug="glm-toc"><b>glm-toc<\/b><span>3 documents/);
  const list = await api({}, OWNER);
  assert.deepEqual(list.body.collections.find((c) => c.slug === slug).count, 3, 'the index counts entries (a pair counts once)');

  const lib = await call(pastesHandler, { headers: OWNER });
  assert.equal(lib.body.find((p) => p.id === aZh).collection, slug, 'the Library listing carries the collection');
  assert.equal(lib.body.find((p) => p.id === aZh).lang, 'zh');
});

test('a collection page costs the same queries for 5 or 60 documents (with versions and translations)', async () => {
  const build = async (slug, k) => {
    for (let i = 0; i < k; i++) {
      const en = await seed({ collection: slug, lang: 'en' });
      if (i % 3 === 0) await seed({ collection: slug, lang: 'en', parent_id: en, root_id: en, version_no: 2 });
      if (i % 2 === 0) await seed({ collection: slug, lang: 'zh', translation_of: en });
    }
  };
  await build('small-one', 5);
  await build('big-one', 60);
  const small = await count(() => cpage('small-one', OWNER));
  const big = await count(() => cpage('big-one', OWNER));
  assert.equal(small.r.statusCode, 200);
  assert.equal(big.r.statusCode, 200);
  assert.equal((big.r.body.match(/class="coll-row"/g) || []).length, 60, 'one entry per original');
  assert.equal(small.n, big.n, `fixed cost: ${small.n} vs ${big.n}`);
  assert.ok(big.n <= 3, `${big.n} queries`);
  const idx1 = await count(() => api({}, OWNER));
  await build('third-one', 20);
  const idx2 = await count(() => api({}, OWNER));
  assert.equal(idx1.n, idx2.n, 'the index is one query however many collections');
});

test('a database error is a 503 page, never a partial list', async () => {
  const original = global.fetch;
  global.fetch = async (url, opts) => (String(url).includes('/rest/v1/mdshare_pastes') && !(opts && opts.method) ? { ok: false, status: 500, json: async () => ({}), text: async () => '' } : original(url, opts));
  try {
    assert.equal((await cpage('glm-study', OWNER)).statusCode, 503);
    assert.equal((await cpage(undefined, OWNER)).statusCode, 503);
    assert.equal((await api({ slug: 'glm-study' }, OWNER)).statusCode, 503);
  } finally { global.fetch = original; }
});
