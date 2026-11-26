// Chinese/English versions linked (migration 012). Contracts proven here:
//  - linking a translation: the owner, any pair; a token only a pair it created (target and its
//    group), never via documents:read; anonymous never, even to a public document
//  - translation_of always stores the group root; versions inherit lang/translation_of
//  - the reader page shows the 中文/English switch to the owner, and to a reader only when the
//    translation is public; ?as=reader is the reader view
//  - a page view costs the same 2 queries however many versions and translations exist
//  - the translation action (link later) has its own auth matrix and the same 404 for not-yours
//    and missing; it never writes content, visibility or expiry
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
const { createToken } = await import('../api/_lib/agent-tokens.js');

let ip = 0;
const nextIp = () => `10.3.0.${++ip % 250}`;
async function ownerCookie() {
  const res = responseRecorder();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.31' } }, res);
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}
const COOKIE = await ownerCookie();
const OWNER = { cookie: COOKIE };
const tok = async (scopes) => createToken({ name: `t-${Math.random()}`, expiresInDays: 1, scopes });
const bearer = (t) => ({ authorization: ['Bea', 'rer'].join('') + ' ' + t.token });

async function call(handler, { method = 'GET', query = {}, body, headers = {} }) {
  const res = responseRecorder();
  await handler({ method, query, body, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: nextIp() } }, res);
  return res;
}
const create = (body, headers = {}) => call(shareHandler, { method: 'POST', body, headers });
const page = (id, headers = {}, query = {}) => call(renderHandler, { query: { id, ...query }, headers });
const link = (body, headers = {}) => call(docHandler, { method: 'POST', query: { action: 'translation' }, body, headers });
const row = (id) => db.sb.tables.mdshare_pastes.find((p) => p.id === id);
const ZH = '# 缓存命中率\n\n' + '缓存命中越多，首字延迟越低，这是推理服务里最重要的指标之一。'.repeat(3);
const EN = '# Cache hit rate\n\nThe more cache hits, the lower the time to first token.';
async function seed(extra = {}) {
  const id = `t${Math.random().toString(36).slice(2, 11)}`;
  db.sb.seed('mdshare_pastes', { id, content: EN, title: `Doc ${id}`, expires_at: '2999-01-01T00:00:00Z', ...extra });
  return id;
}

test('linking at publish: the owner or the token that created the target; anonymous never, even to a public document', async () => {
  const en = await seed({ lang: 'en' });
  const pub = await seed({ lang: 'en', is_public: true });
  const before = db.sb.tables.mdshare_pastes.length;
  assert.equal((await create({ markdown: ZH, lang: 'zh', translation_of: en })).statusCode, 404);
  const anonPub = await create({ markdown: ZH, lang: 'zh', translation_of: pub });
  assert.equal(anonPub.statusCode, 404, 'a public target does not let a stranger attach a translation');
  assert.match(anonPub.body.error, /translation_of not found/);
  assert.equal(db.sb.tables.mdshare_pastes.length, before, 'nothing was inserted');

  const writeOnly = await tok(['documents:write']);
  assert.equal((await create({ markdown: ZH, lang: 'zh', translation_of: en }, bearer(writeOnly))).statusCode, 404, 'write-only token cannot link to a row it did not create');
  const own = await create({ markdown: EN, lang: 'en' }, bearer(writeOnly));
  const ownZh = await create({ markdown: ZH, lang: 'zh', translation_of: own.body.id }, bearer(writeOnly));
  assert.equal(ownZh.statusCode, 200, 'a token may translate its own document');
  assert.equal(row(ownZh.body.id).translation_of, own.body.id);

  // Changed by ADV-B finding 2 (2026-11-26): documents:read no longer lets a token link onto a
  // document it did not create (see the last test in this file).
  const reader = await tok(['documents:read', 'documents:write']);
  const r = await create({ markdown: ZH, lang: 'zh', translation_of: en }, bearer(reader));
  assert.equal(r.statusCode, 404, 'documents:read does not let a token link onto the owner\'s document');
  assert.equal(r.body.translation_of, undefined);
  const o = await create({ markdown: ZH, translation_of: pub }, OWNER);
  assert.equal(o.statusCode, 200);
  assert.equal(o.body.lang, 'zh', 'lang is detected from the text when not given');
  assert.equal(row(o.body.id).is_public, false, 'a translation is private by default');

  const legacy = await tok(undefined);
  assert.equal((await create({ markdown: ZH, translation_of: en }, bearer(legacy))).statusCode, 404, 'legacy token: only its own rows');
  assert.equal((await create({ markdown: ZH, translation_of: 'bad id!' }, OWNER)).statusCode, 404);
  assert.equal((await create({ markdown: ZH, translation_of: 'zzzzzzzzz0' }, OWNER)).statusCode, 404);
  assert.equal((await create({ markdown: ZH, translation_of: await seed({ expires_at: '2000-01-01T00:00:00Z' }) }, OWNER)).statusCode, 404, 'an expired target is missing');
});

test('validation: lang values, same-language links and links into the own version family', async () => {
  const en = await seed({ lang: 'en' });
  for (const lang of ['fr', 'chinese', 1, true, ['zh']]) assert.equal((await create({ markdown: ZH, lang }, OWNER)).statusCode, 400, JSON.stringify(lang));
  assert.equal((await create({ markdown: ZH, lang: ' ZH ' }, OWNER)).body.lang, 'zh', 'lang is trimmed and lowercased');
  const anon = await create({ markdown: ZH, lang: 'zh' });
  assert.equal(anon.statusCode, 200, 'lang alone is harmless metadata, fine for anonymous creates');
  assert.equal(row(anon.body.id).lang, 'zh');
  const same = await create({ markdown: EN, lang: 'en', translation_of: en }, OWNER);
  assert.equal(same.statusCode, 400);
  assert.match(same.body.error, /already a en document/);
  const v1 = await seed({ lang: 'en' });
  const self = await create({ markdown: ZH, lang: 'zh', parent: v1, translation_of: v1 }, OWNER);
  assert.equal(self.statusCode, 400, 'a version cannot be a translation of its own family');
});

test('translation_of stores the group root; versions inherit language, link and collection', async () => {
  const en1 = await seed({ lang: 'en', collection: 'glm-study' });
  const en2 = await seed({ lang: 'en', parent_id: en1, root_id: en1, version_no: 2, collection: 'glm-study' });
  const zh = await create({ markdown: ZH, lang: 'zh', translation_of: en2 }, OWNER);
  assert.equal(row(zh.body.id).translation_of, en1, 'linking to v2 stores the version root');
  assert.equal(row(zh.body.id).collection, 'glm-study', 'a translation joins the collection of its original');
  const zh2 = await create({ markdown: ZH + '\n\n第二版。', parent: zh.body.id }, OWNER);
  assert.equal(zh2.statusCode, 200);
  assert.deepEqual([row(zh2.body.id).lang, row(zh2.body.id).translation_of, row(zh2.body.id).collection], ['zh', en1, 'glm-study'], 'a new version keeps lang, translation_of and collection');
  // Linking to a translation joins its group instead of chaining.
  const other = await create({ markdown: EN, lang: 'en', translation_of: zh2.body.id }, OWNER);
  assert.equal(row(other.body.id).translation_of, en1);
});

test('reader page: owner sees the switch; a reader only once the translation is public; ?as=reader is the reader view', async () => {
  const en = await seed({ lang: 'en', is_public: true, content: EN });
  const zh = (await create({ markdown: ZH, lang: 'zh', translation_of: en }, OWNER)).body.id;
  const ownerEn = await page(en, OWNER);
  assert.match(ownerEn.body, /id="lang-switch"/);
  assert.match(ownerEn.body, new RegExp(`<a href="/v/${zh}" lang="zh" hreflang="zh" id="lang-other"[^>]*>中文<i class="lock"`), 'the owner sees the private translation, marked private');
  assert.match(ownerEn.body, /<span class="on" aria-current="true" lang="en">English<\/span>/);
  const ownerZh = await page(zh, OWNER);
  assert.match(ownerZh.body, new RegExp(`<a href="/v/${en}" lang="en" hreflang="en" id="lang-other"[^>]*>English</a>`), 'a public original has no lock');
  assert.match(ownerZh.body, /aria-label="语言"/, 'the switch speaks the page language');

  const anon = await page(en);
  assert.equal(anon.statusCode, 200);
  assert.doesNotMatch(anon.body, /lang-switch/, 'a private translation is not revealed');
  assert.doesNotMatch(anon.body, new RegExp(zh), 'not even its id');
  assert.doesNotMatch((await page(en, OWNER, { as: 'reader' })).body, /lang-switch/, '?as=reader shows what a reader sees');

  row(zh).is_public = true;
  const anon2 = await page(en);
  assert.match(anon2.body, new RegExp(`href="/v/${zh}" lang="zh"`), 'a public translation gets the switch');
  assert.doesNotMatch(anon2.body, /class="lock"/, 'readers never see the owner hint');
  const data = JSON.parse(/<script type="application\/json" id="mdshare-data">([^<]*)<\/script>/.exec(anon2.body)[1]);
  assert.equal(data.translationId, zh);
  assert.ok(anon2.body.indexOf('id="lang-switch"') < anon2.body.indexOf('id="content"'), 'the switch sits outside the document body');
  assert.equal(row(en).content, EN, 'stored Markdown unchanged');

  // A reader on the private side gets the gate, never a hint of the public sibling.
  row(zh).is_public = false;
  const gate = await page(zh);
  assert.equal(gate.statusCode, 401);
  assert.doesNotMatch(gate.body, new RegExp(en));
});

test('the switch links the newest live version of the translation; an untagged original still pairs', async () => {
  const en = await seed({ is_public: true });          // no lang
  const zh1 = await seed({ lang: 'zh', translation_of: en, is_public: true, content: ZH, created_at: '2026-01-01T00:00:00Z' });
  const zh2 = await seed({ lang: 'zh', translation_of: en, parent_id: zh1, root_id: zh1, version_no: 2, is_public: true, content: ZH, created_at: '2026-02-01T00:00:00Z' });
  await seed({ lang: 'zh', translation_of: en, parent_id: zh2, root_id: zh1, version_no: 3, is_public: true, expires_at: '2000-01-01T00:00:00Z' });
  const p = await page(en);
  assert.match(p.body, new RegExp(`href="/v/${zh2}" lang="zh"`), 'newest live zh version, expired v3 skipped');
  assert.match(p.body, /<span class="on" aria-current="true" lang="en">English/, 'the untagged original is labelled by the other side');
  const back = await page(zh1);
  assert.match(back.body, new RegExp(`href="/v/${en}" lang="en"`), 'an old zh version still links the original');
  // A private newest version: the reader falls back to the newest public one.
  row(zh2).is_public = false;
  assert.match((await page(en)).body, new RegExp(`href="/v/${zh1}" lang="zh"`));
});

test('a page view costs 2 queries however many versions and translations exist', async () => {
  const count = async (fn) => { const before = db.calls.length; const r = await fn(); return { r, n: db.calls.length - before }; };
  const build = async (n) => {
    const en = [await seed({ lang: 'en', is_public: true })];
    for (let i = 1; i < n; i++) en.push(await seed({ lang: 'en', is_public: true, parent_id: en[i - 1], root_id: en[0], version_no: i + 1 }));
    const zh = [await seed({ lang: 'zh', translation_of: en[0], is_public: true, content: ZH })];
    for (let i = 1; i < n; i++) zh.push(await seed({ lang: 'zh', translation_of: en[0], is_public: true, parent_id: zh[i - 1], root_id: zh[0], version_no: i + 1, content: ZH }));
    return { en, zh };
  };
  const small = await build(1);
  const big = await build(30);
  for (const [label, f] of [['small', small], ['big', big]]) {
    const anon = await count(() => page(f.en[0]));
    assert.match(anon.r.body, new RegExp(`href="/v/${f.zh[f.zh.length - 1]}" lang="zh"`), `${label}: the switch links the newest zh version`);
    assert.ok(anon.n <= 2, `${label}: anonymous view of the original: ${anon.n} queries`);
    const owner = await count(() => page(f.zh[Math.floor(f.zh.length / 2)], OWNER));
    assert.ok(owner.n <= 2, `${label}: owner view in the middle of the zh chain: ${owner.n} queries`);
    assert.match(owner.r.body, new RegExp(`href="/v/${f.en[f.en.length - 1]}" lang="en"`));
  }
});

test('translation action: auth matrix, same 404 for not-yours and missing, family-wide, metadata only', async () => {
  const en = await seed({ lang: 'en' });
  const zh1 = await seed({ content: ZH });
  const zh2 = await seed({ content: ZH, parent_id: zh1, root_id: zh1, version_no: 2 });
  const body = { id: zh2, translation_of: en, lang: 'zh' };
  assert.equal((await link(body)).statusCode, 401);
  assert.match((await link(body)).headers['www-authenticate'] || '', /^Bearer/);
  assert.equal((await link(body, bearer(await tok(['documents:read'])))).statusCode, 403, 'read-only token');
  assert.equal((await link(body, bearer(await tok(undefined)))).statusCode, 403, 'legacy token');
  const writer = await tok(['documents:write', 'documents:read']);
  const notMine = await link(body, bearer(writer));
  const missing = await link({ ...body, id: 'zzzzzzzzz0' }, bearer(writer));
  assert.equal(notMine.statusCode, 404, 'a token may not relink a document it did not create');
  assert.deepEqual(notMine.body, missing.body, 'same answer as a missing id');

  const contentBefore = JSON.stringify(db.sb.tables.mdshare_pastes.map((p) => [p.id, p.content, p.is_public, p.expires_at, p.pinned]));
  const ok = await link(body, OWNER);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.updated.sort(), [zh1, zh2].sort(), 'the whole version family is linked in one write');
  assert.deepEqual([row(zh1).translation_of, row(zh1).lang, row(zh2).translation_of], [en, 'zh', en]);
  assert.equal(JSON.stringify(db.sb.tables.mdshare_pastes.map((p) => [p.id, p.content, p.is_public, p.expires_at, p.pinned])), contentBefore, 'content, visibility and expiry untouched');
  assert.match((await page(en, OWNER)).body, new RegExp(`href="/v/${zh2}" lang="zh"`));

  // A token with documents:publish on its own rows; the target must be its own too (canLinkTranslation).
  const pubTok = await tok(['documents:write', 'documents:publish']);
  const mine = await create({ markdown: ZH, lang: 'zh' }, bearer(pubTok));
  assert.equal((await link({ id: mine.body.id, translation_of: en }, bearer(pubTok))).statusCode, 404, 'target not readable by this token');
  const myEn = await create({ markdown: EN, lang: 'en' }, bearer(pubTok));
  assert.equal((await link({ id: mine.body.id, translation_of: myEn.body.id }, bearer(pubTok))).statusCode, 200, 'own document to own target');

  // Validation
  assert.equal((await link({ id: zh2, translation_of: zh1 }, OWNER)).statusCode, 400, 'own family');
  assert.equal((await link({ id: en, translation_of: zh2 }, OWNER)).statusCode, 400, 'circular: the original cannot translate its own translation');
  assert.equal((await link({ id: en, lang: 'xx' }, OWNER)).statusCode, 400);
  assert.equal((await link({ id: en }, OWNER)).statusCode, 400, 'nothing to change');
  const untagged = await seed();
  assert.equal((await link({ id: untagged, translation_of: en }, OWNER)).statusCode, 400, 'needs a lang');
  assert.equal((await link({ id: untagged, translation_of: en, lang: 'en' }, OWNER)).statusCode, 400, 'same language');
  const unl = await link({ id: zh2, translation_of: null }, OWNER);
  assert.equal(unl.statusCode, 200);
  assert.equal(row(zh1).translation_of, null, 'null unlinks the family');
  assert.doesNotMatch((await page(en, OWNER)).body, /lang-switch/);
});

// ADV-B finding 2 (2026-11-26): a token links a translation only between documents it created
// itself, the target and the group the link joins; documents:read is not enough. The owner can
// link any pair. Refusals are the same 404 as a missing id, at publish and in the action.
test('a token links only a pair it created; never its document to the owner\'s, private or public', async () => {
  const t = await tok(['documents:read', 'documents:write', 'documents:publish']);
  const missingPub = await create({ markdown: ZH, lang: 'zh', translation_of: 'zzzzzzzzz0' }, bearer(t));
  const missingAct = await link({ id: (await create({ markdown: ZH, lang: 'zh' }, bearer(t))).body.id, translation_of: 'zzzzzzzzz0' }, bearer(t));
  assert.equal(missingPub.statusCode, 404);
  assert.equal(missingAct.statusCode, 404);

  // Its own pair: fine at publish and through the action.
  const myEn = await create({ markdown: EN, lang: 'en' }, bearer(t));
  const myZh = await create({ markdown: ZH, lang: 'zh', translation_of: myEn.body.id }, bearer(t));
  assert.equal(myZh.statusCode, 200, 'own pair at publish');
  assert.equal(row(myZh.body.id).translation_of, myEn.body.id);
  const myZh2 = await create({ markdown: ZH, lang: 'zh' }, bearer(t));
  const myEn2 = await create({ markdown: EN, lang: 'en' }, bearer(t));
  assert.equal((await link({ id: myZh2.body.id, translation_of: myEn2.body.id }, bearer(t))).statusCode, 200, 'own pair through the action');

  // The owner's documents, private or public: refused, with the same answer as a missing id.
  for (const [label, extra] of [['private', {}], ['public', { is_public: true }]]) {
    const ownerEn = await seed({ lang: 'en', ...extra });
    const before = db.sb.tables.mdshare_pastes.length;
    const pub = await create({ markdown: ZH, lang: 'zh', translation_of: ownerEn }, bearer(t));
    assert.equal(pub.statusCode, 404, `publish onto the owner's ${label} document`);
    assert.deepEqual(pub.body, missingPub.body, `${label}: same 404 as a missing target at publish`);
    assert.equal(db.sb.tables.mdshare_pastes.length, before, `${label}: nothing was inserted`);
    const mine = await create({ markdown: ZH, lang: 'zh' }, bearer(t));
    const act = await link({ id: mine.body.id, translation_of: ownerEn }, bearer(t));
    assert.equal(act.statusCode, 404, `action onto the owner's ${label} document`);
    assert.deepEqual(act.body, missingAct.body, `${label}: same 404 as a missing target in the action`);
    assert.equal(row(mine.body.id).translation_of, null, `${label}: not linked`);
    assert.doesNotMatch((await page(ownerEn, OWNER)).body, /lang-switch/, `${label}: no switch on the owner's page`);
  }

  // Its own version of the owner's document is not its own group: the link would join the owner's
  // original (translation_of stores the group root), so it is refused too.
  const ownerV1 = await seed({ lang: 'en' });
  const tokV2 = await create({ markdown: EN + '\n\nv2', parent: ownerV1 }, bearer(t));
  assert.equal(tokV2.statusCode, 200, 'documents:read may still make a version (unchanged)');
  assert.equal((await create({ markdown: ZH, lang: 'zh', translation_of: tokV2.body.id }, bearer(t))).statusCode, 404, 'own version of the owner\'s document');
  assert.doesNotMatch((await page(ownerV1, OWNER)).body, /lang-switch/);

  // The other direction: the owner's document can't be linked onto the token's.
  const ownerZh = await seed({ lang: 'zh', content: ZH });
  assert.equal((await link({ id: ownerZh, translation_of: myEn.body.id }, bearer(t))).statusCode, 404, 'not the token\'s document to edit');

  // The owner may link any pair, including onto a token's document.
  assert.equal((await link({ id: ownerZh, translation_of: myEn2.body.id }, OWNER)).statusCode, 200, 'owner: the owner\'s document onto a token\'s');
  const ownerEn = await seed({ lang: 'en' });
  assert.equal((await link({ id: ownerZh, translation_of: ownerEn }, OWNER)).statusCode, 200, 'owner: own pair');
  const tokZh = await create({ markdown: ZH, lang: 'zh' }, bearer(t));
  assert.equal((await link({ id: tokZh.body.id, translation_of: ownerEn }, OWNER)).statusCode, 200, 'owner: a token\'s document onto the owner\'s');
  assert.equal((await create({ markdown: ZH, lang: 'zh', translation_of: myEn.body.id }, OWNER)).statusCode, 200, 'owner: publish onto a token\'s document');
});
