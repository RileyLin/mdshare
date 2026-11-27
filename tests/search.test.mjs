// Full-text search (migration 011, api/doc.js action=search, api/_lib/search.js).
// Contracts proven here:
//  - auth: anonymous 401 (with WWW-Authenticate + hint), invalid token 401, x-api-key 401 hint,
//    documents:read token ok, token without documents:read 403, legacy token 403, owner ok
//  - matching: Chinese (缓存命中) in titles and bodies, case-insensitive Latin, literal special
//    characters (, ( ) * % _ \) that neither error nor widen the result set
//  - expired unkept rows are excluded; kept rows are found however old
//  - snippets are short plain text around the match, never HTML, never the full content
//  - ranking: title matches first, then newest; limit/offset bounds; 400 on empty/too-long q
//  - cost: one database call per search, the same for 5 rows and 60 rows; the text never
//    appears in a URL (it travels in the rpc JSON body)
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
const { snippetFor, plainText, validateSearch } = await import('../api/_lib/search.js');

let ip = 0;
async function ownerCookie() {
  const res = responseRecorder();
  await authHandler({ method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '127.0.0.9' } }, res);
  assert.equal(res.statusCode, 200);
  return res.headers['set-cookie'].split(';')[0];
}
const COOKIE = await ownerCookie();
const OWNER = { cookie: COOKIE };
const tok = async (scopes) => (await createToken(await asUser(1), { name: `t-${Math.random()}`, expiresInDays: 1, scopes })).token;
const bearer = (t) => ({ authorization: 'Bearer ' + t });

async function search(query, headers = {}) {
  const res = responseRecorder();
  await docHandler({ method: 'GET', query: { action: 'search', ...query }, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: `10.1.0.${++ip % 250}` } }, res);
  return res;
}
const ids = (res) => res.body.results.map((r) => r.id);
let n = 0;
function seed(extra) {
  const id = extra.id || `s${(++n).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const content = extra.content ?? `# ${extra.title || 'Untitled'}\n\nbody`;
  db.sb.seed('mdshare_pastes', { id, title: extra.title ?? null, expires_at: '2999-01-01T00:00:00Z', created_at: new Date(Date.now() - n * 1000).toISOString(), ...extra, content });
  return id;
}
function reset() { db.sb.reset(); db.calls.length = 0; }

test('auth matrix: anonymous, invalid, misplaced key, legacy, wrong scope, read scope, owner', async () => {
  reset();
  seed({ title: 'Cache notes', content: '# Cache notes\n\n缓存命中率' });
  const legacy = await tok(undefined);
  const writeOnly = await tok(['documents:write']);
  const activity = await tok(['activity:read']);
  const reader = await tok(['documents:read']);

  const anon = await search({ q: 'cache' });
  assert.equal(anon.statusCode, 401);
  assert.match(anon.headers['www-authenticate'], /^Bearer realm="mdshare"/);
  assert.match(anon.body.hint, /Authorization: Bearer/);
  assert.match(anon.body.guide, /\/llms\.txt$/);
  assert.equal(anon.body.results, undefined, 'no results for anonymous');

  const bad = await search({ q: 'cache' }, bearer('mds_not_a_real_token_value'));
  assert.equal(bad.statusCode, 401);
  assert.match(bad.headers['www-authenticate'], /Bearer/);
  assert.match(bad.body.hint, /Bearer <token>/);

  const before = db.calls.length;
  const misplaced = await search({ q: 'cache' }, { 'x-api-key': reader });
  assert.equal(misplaced.statusCode, 401);
  assert.match(misplaced.body.hint, /Authorization: Bearer <token>; x-api-key/);
  assert.equal(db.calls.length, before, 'a misplaced key is refused before any database call');
  const misplacedQuery = await search({ q: 'cache', key: reader });
  assert.equal(misplacedQuery.statusCode, 401);
  assert.match(misplacedQuery.body.hint, /\?key=/);

  assert.equal((await search({ q: 'cache' }, bearer(legacy))).statusCode, 403, 'legacy token has no library-wide read');
  const wrong = await search({ q: 'cache' }, bearer(writeOnly));
  assert.equal(wrong.statusCode, 403);
  assert.match(wrong.body.error, /documents:read/);
  assert.equal((await search({ q: 'cache' }, bearer(activity))).statusCode, 403);

  const okToken = await search({ q: 'cache' }, bearer(reader));
  assert.equal(okToken.statusCode, 200);
  assert.equal(okToken.body.results.length, 1);
  const okOwner = await search({ q: 'cache' }, OWNER);
  assert.equal(okOwner.statusCode, 200);
  assert.deepEqual(Object.keys(okOwner.body.results[0]).sort(), ['created_at', 'expires_at', 'id', 'is_public', 'kept', 'kind', 'snippet', 'title', 'url']);
  assert.equal(okOwner.body.results[0].kind, 'paste');
  assert.equal(okOwner.headers['cache-control'], 'private, no-store');
});

test('Chinese text matches in titles and bodies, including partial words', async () => {
  reset();
  const inBody = seed({ title: 'Inference notes', content: `# Inference notes\n\n${'前言。'.repeat(120)}\n\n这一节讲缓存命中：命中率越高，延迟越低。` });
  const inTitle = seed({ title: '缓存命中率调优', content: '# 缓存命中率调优\n\n正文' });
  seed({ title: 'Unrelated', content: '# Unrelated\n\n缓冲区与命令' });
  const r = await search({ q: '缓存命中' }, OWNER);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(ids(r).sort(), [inBody, inTitle].sort());
  assert.equal(ids(r)[0], inTitle, 'title match ranks first');
  const body = r.body.results.find((x) => x.id === inBody);
  assert.match(body.snippet, /缓存命中/, 'snippet shows the match even when it is far into the document');
  assert.ok([...body.snippet].length <= 200, `snippet is short (${[...body.snippet].length})`);
  assert.equal(r.body.total, 2);
  assert.deepEqual(ids(await search({ q: '缓存' }, OWNER)).sort(), [inBody, inTitle].sort(), 'a shorter Chinese term matches too');
  assert.deepEqual(ids(await search({ q: '  缓存命中  ' }, OWNER)).sort(), [inBody, inTitle].sort(), 'surrounding spaces are trimmed');
});

test('Latin matching is case-insensitive', async () => {
  reset();
  const a = seed({ title: 'KV Cache', content: '# KV Cache\n\nPaged attention' });
  const r = await search({ q: 'kv CACHE' }, OWNER);
  assert.deepEqual(ids(r), [a]);
  assert.deepEqual(ids(await search({ q: 'PAGED' }, OWNER)), [a]);
});

test('special characters are literal: no errors, no widened results', async () => {
  reset();
  const pct = seed({ title: 'Growth', content: '# Growth\n\nRevenue up 50% year over year.' });
  const under = seed({ title: 'Config', content: '# Config\n\nset max_tokens to 4096' });
  const comma = seed({ title: 'List', content: '# List\n\nalpha,beta(gamma)*delta' });
  const slash = seed({ title: 'Paths', content: '# Paths\n\nC:\\temp\\file' });
  seed({ title: 'Plain', content: '# Plain\n\nnothing special here at all' });
  const expect = {
    '%': [pct], '50%': [pct], '_': [under], 'max_tokens': [under], 'max%tokens': [], 'x_y': [],
    ',': [comma], 'alpha,beta': [comma], '(gamma)': [comma], ')*delta': [comma], '*': [comma], 'a*': [], 'a)*': [comma],
    'title.ilike.*': [], 'id.eq.x)': [], '\\temp': [slash], '\\': [slash], ',or=(id.neq.0': [], '*,*': [],
  };
  for (const [q, want] of Object.entries(expect)) {
    const r = await search({ q }, OWNER);
    assert.equal(r.statusCode, 200, `q=${JSON.stringify(q)} answers 200`);
    assert.deepEqual(ids(r).sort(), want.sort(), `q=${JSON.stringify(q)} matches only the literal text`);
  }
  // The text never travels in a URL: only in the rpc JSON body.
  const rpc = db.calls.filter((c) => c.path === '/rest/v1/rpc/mdshare_search_owned');
  assert.ok(rpc.length >= Object.keys(expect).length);
  for (const c of rpc) {
    assert.equal(c.method, 'POST');
    assert.equal(c.query, '', 'no query string on the rpc call');
    assert.deepEqual(Object.keys(c.body).sort(), ['lim', 'p_owner', 'q', 'skip']);
    assert.equal(c.body.p_owner, 1, 'the owner session searches user #1 only');
  }
  assert.ok(!db.calls.some((c) => /ilike|or=/.test(decodeURIComponent(c.query || ''))), 'no filter string built from the text');
});

test('expired unkept rows are excluded; kept rows are found however old', async () => {
  reset();
  const live = seed({ title: 'Live tracker', content: '# Live tracker\n\nshared-term' });
  seed({ title: 'Expired tracker', content: '# Expired tracker\n\nshared-term', expires_at: '2020-01-01T00:00:00Z', pinned: false });
  const kept = seed({ title: 'Kept tracker', content: '# Kept tracker\n\nshared-term', expires_at: '2020-01-01T00:00:00Z', pinned: true, created_at: '2021-01-01T00:00:00Z' });
  const r = await search({ q: 'shared-term' }, OWNER);
  assert.deepEqual(ids(r), [live, kept], 'newest first, expired gone');
  assert.equal(r.body.results.find((x) => x.id === kept).kept, true);
  assert.equal(r.body.total, 2);
});

test('snippets are plain text, never HTML, never the full content', async () => {
  reset();
  const filler = 'lorem ipsum dolor sit amet '.repeat(40);
  const id = seed({ title: 'XSS probe', content: `# XSS probe\n\n${filler}<script>alert(1)</script><img src=x onerror="alert(2)"> 缓存命中 **bold** [link](https://example.com) <b>tag</b>\n\n${filler}` });
  const r = await search({ q: '缓存命中' }, OWNER);
  const s = r.body.results.find((x) => x.id === id).snippet;
  assert.match(s, /缓存命中/);
  assert.doesNotMatch(s, /<[a-z/!]/i, `no tags in snippet: ${s}`);
  assert.doesNotMatch(s, /onerror|\*\*|\]\(/, 'markup removed');
  assert.match(s, /bold link/, 'link and emphasis text kept');
  assert.ok(s.length < 220 && s.length < filler.length, 'snippet is a short window');
  assert.ok(!JSON.stringify(r.body).includes(filler), 'the full content is never returned');
  // Unit level: a window that cuts a tag in half still yields no tag.
  assert.doesNotMatch(plainText('foo <img src=x onerror=alert(1) and bar'), /<img/i);
  assert.doesNotMatch(plainText('<!-- hidden --> text <div class="x">y</div>'), /<|hidden/);
  assert.equal(snippetFor('abc', 'zzz'), 'abc', 'no match in body (title match): leading text');
  // Real-data gap found on production excerpts (2026-11-26): single-asterisk emphasis leaked.
  assert.equal(plainText('*2026-11-23. First* point, 2 * 3 = 6'), '2026-11-23. First point, 2 * 3 = 6');
  const cut = snippetFor('abcdefghij '.repeat(30) + 'needle ' + 'klmnopqrst '.repeat(30), 'needle');
  assert.match(cut, /^…abcdefghij /, `the window starts on a word boundary: ${cut}`);
  assert.match(cut, / klmnopqrst…$/, `and ends on one: ${cut}`);
});

test('ranking, pagination bounds and input validation', async () => {
  reset();
  const older = seed({ title: 'Token budget', content: '# Token budget\n\nbudget', created_at: '2026-01-01T00:00:00Z' });
  const newer = seed({ title: 'Other', content: '# Other\n\nthe token budget again', created_at: '2026-06-01T00:00:00Z' });
  const newest = seed({ title: 'Third', content: '# Third\n\ntoken budget', created_at: '2026-09-01T00:00:00Z' });
  const r = await search({ q: 'token budget' }, OWNER);
  assert.deepEqual(ids(r), [older, newest, newer], 'title match first, then newest');
  const p1 = await search({ q: 'token budget', limit: '1' }, OWNER);
  assert.deepEqual([ids(p1), p1.body.next_offset, p1.body.total], [[older], 1, 3]);
  const p2 = await search({ q: 'token budget', limit: '1', offset: '1' }, OWNER);
  assert.deepEqual([ids(p2), p2.body.next_offset], [[newest], 2]);
  const p3 = await search({ q: 'token budget', limit: '1', offset: '2' }, OWNER);
  assert.deepEqual([ids(p3), p3.body.next_offset], [[newer], null]);
  assert.equal((await search({ q: 'token budget', limit: '999' }, OWNER)).body.limit, 50);
  assert.equal((await search({ q: 'token budget', limit: '-3' }, OWNER)).body.limit, 1);
  assert.equal((await search({ q: 'token budget', offset: '99999' }, OWNER)).body.offset, 1000);
  assert.equal((await search({ q: 'token budget', limit: 'abc' }, OWNER)).body.limit, 20);
  assert.equal((await search({}, OWNER)).statusCode, 400);
  assert.equal((await search({ q: '   ' }, OWNER)).statusCode, 400);
  assert.equal((await search({ q: 'x'.repeat(201) }, OWNER)).statusCode, 400);
  assert.equal((await search({ q: '缓'.repeat(200) }, OWNER)).statusCode, 200, '200 characters (not bytes) is the limit');
  assert.equal(validateSearch({ q: ['a', 'b'] }).error !== undefined, true, 'a repeated q parameter is rejected');
  assert.equal((await search({ q: 'a\u0000b' }, OWNER)).statusCode, 400, 'NUL is refused before the database');
  assert.equal((await search({ q: 'a\ud800b' }, OWNER)).statusCode, 400, 'a lone surrogate is refused before the database');
  assert.equal((await search({ q: '😀 emoji' }, OWNER)).statusCode, 200, 'a well-formed astral character is fine');
});

test('database calls per search are fixed: 5 rows vs 60 rows', async () => {
  const measure = async (rows, who) => {
    reset();
    const headers = who === 'owner' ? OWNER : bearer(await tok(['documents:read']));
    for (let i = 0; i < rows; i++) seed({ title: `Doc ${i} cost-term`, content: `# Doc ${i} cost-term\n\nbody cost-term ${i}` });
    db.calls.length = 0;
    const r = await search({ q: 'cost-term', limit: '50' }, headers);
    assert.equal(r.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the fire-and-forget last_used_at touch land
    return { calls: db.calls.length, reads: db.calls.filter((c) => c.path.includes('mdshare_pastes') || c.path.includes('/rpc/')).length, n: r.body.results.length };
  };
  const ownerSmall = await measure(5, 'owner');
  const ownerBig = await measure(60, 'owner');
  assert.deepEqual([ownerSmall.calls, ownerBig.calls], [1, 1], 'owner search = one rpc call');
  assert.deepEqual([ownerSmall.n, ownerBig.n], [5, 50]);
  const tokSmall = await measure(5, 'token');
  const tokBig = await measure(60, 'token');
  assert.equal(tokSmall.calls, tokBig.calls, 'token search cost does not grow with the data');
  assert.ok(tokBig.calls <= 3, `token lookup + rpc (+ last_used touch): ${tokBig.calls}`);
  assert.equal(tokBig.reads, 1, 'exactly one content read (the rpc)');
});

test('a database error fails closed with 503, not an empty or partial list', async () => {
  reset();
  const original = global.fetch;
  global.fetch = async (url, opts) => (String(url).includes('/rpc/') ? { ok: false, status: 500, json: async () => ({}), text: async () => '' } : original(url, opts));
  try {
    const r = await search({ q: 'anything' }, OWNER);
    assert.equal(r.statusCode, 503);
  } finally { global.fetch = original; }
});
