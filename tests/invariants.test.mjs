// Proves each invariant in scripts/check-invariants.mjs actually fires: copy the repo to a temp
// dir, break exactly one invariant, and expect that check (and only a failure) to be reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'check-invariants.mjs');

function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mdshare-inv-'));
  for (const p of ['api', 'migrations', 'scripts', 'vercel.json', 'CLAUDE.md', 'README.md']) {
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  }
  return dir;
}

function run(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

function edit(dir, file, fn) {
  const p = join(dir, file);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

test('baseline copy passes every invariant', () => {
  const dir = copyRepo();
  try {
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const mutations = {
  'function-cap': (d) => {
    // Add however many functions it takes to reach 13 (the cap is 12).
    const have = readdirSync(join(d, 'api')).filter((f) => f.endsWith('.js')).length;
    for (let i = have; i < 13; i++) writeFileSync(join(d, 'api', `extra${i}.js`), 'export default () => {};\n');
  },
  rewrites: (d) => edit(d, 'vercel.json', (s) => {
    const v = JSON.parse(s); v.rewrites.push({ ...v.rewrites[0] }, { source: '/x/:id', destination: '/api/missing?id=:id' });
    return JSON.stringify(v);
  }),
  'migrations-additive': (d) => writeFileSync(join(d, 'migrations', '999_backfill.sql'), 'UPDATE mdshare_pastes SET is_public = false;\n'),
  'private-by-default': (d) => edit(d, 'api/share.js', (s) => s.replace('is_public: false, created_by_token', 'is_public: body.is_public === true, created_by_token')),
  'content-route-gating': (d) => edit(d, 'api/render.js', (s) => s.replace('setPrivacyHeaders(res);', '')),
  'postgrest-id-encoding': (d) => appendFileSync(join(d, 'api', 'pin.js'), '\nconst bad = (id) => `${process.env.SUPABASE_URL}/rest/v1/x?id=eq.${id}`;\n'),
  'archify-sandbox': (d) => edit(d, 'api/archify-render.js', (s) => s.replace('sandbox="allow-scripts"', 'sandbox="allow-scripts allow-same-origin"')),
  'timers-unref': (d) => edit(d, 'api/share.js', (s) => s.replace('rateLimitCleanup.unref?.();', '')),
  'no-secrets': (d) => appendFileSync(join(d, 'api', 'pin.js'), `\n// ${'ghp_'}${'a'.repeat(36)}\n`),
  'error-reporting': (d) => edit(d, 'api/render.js', (s) => s.replace("export default withErrors('render', handler);", 'export default handler;')),
  'no-redacted-placeholders': (d) => appendFileSync(join(d, 'api', 'pin.js'), '\n// key: ' + '*'.repeat(3) + '\n'),
  'root-markdown': (d) => writeFileSync(join(d, 'NEW-PLAN.md'), '# plan\n'),
  'claude-md-size': (d) => appendFileSync(join(d, 'CLAUDE.md'), 'more prose\n'.repeat(100)),
  // Reading loop (2026-11-25).
  'activity-actions-auth': (d) => edit(d, 'api/doc.js', (s) => s.replace("auth: 'owner|activity:write', httpMethod: 'POST',", "httpMethod: 'POST',")),
  'activity-writes-allowlist': (d) => edit(d, 'api/_lib/activity.js', (s) => s.replace("export const ACTIVITY_TABLES = ['mdshare_reads', 'mdshare_feedback'];", "export const ACTIVITY_TABLES = ['mdshare_reads', 'mdshare_feedback', 'mdshare_pastes'];")),
  'version-parent-gated': (d) => edit(d, 'api/_lib/activity.js', (s) => s.replace("if (!row) return { ok: false };\n  if (checkAuthAndRefresh(req, res)) return { ok: true, row };", "if (!row) return { ok: false };\n  if (row.is_public === true) return { ok: true, row };\n  if (checkAuthAndRefresh(req, res)) return { ok: true, row };")),
  'loop-owner-only': (d) => edit(d, 'api/_lib/diagram-page.js', (s) => s.replace("${scripts(['marked', 'purify', 'hljs', 'render', 'app'])}", "${scripts(['marked', 'purify', 'hljs', 'render', 'app', 'loop'])}")),
  'publish-checks': (d) => edit(d, 'api/share.js', (s) => s.replace(', checks: lintMarkdown(markdown) }', ' }')),
  'version-reads-constant': (d) => edit(d, 'api/_lib/activity.js', (s) => s.replace("  const mine = versionNoOf(row);", "  const mine = versionNoOf(row);\n  for (let cur = row && row.parent_id, k = 0; cur && k < 20; k++) cur = (await sbSelect('mdshare_pastes', `id=eq.${encodeURIComponent(cur)}&select=parent_id`))[0]?.parent_id;")),
  // Search + agent access (2026-11-26).
  'search-no-filter-injection': (d) => edit(d, 'api/_lib/search.js', (s) => s.replace('`${process.env.SUPABASE_URL}/rest/v1/rpc/mdshare_search`', '`${process.env.SUPABASE_URL}/rest/v1/mdshare_pastes?or=(title.ilike.*${encodeURIComponent(q)}*,content.ilike.*${encodeURIComponent(q)}*)`')),
  'markdown-route-gating': (d) => edit(d, 'api/_lib/raw.js', (s) => s.replace('if (!row || !isVisible(row, req, res, { agentOwns })) {', 'if (!row || !(row.is_public === true || agentOwns)) {')),
  'agent-auth-hints': (d) => edit(d, 'api/doc.js', (s) => s.replace("return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid, scope });", "return res.status(401).json({ error: 'Invalid or expired token' });")),
};

// More ways to break the 2026-11-26 rules; each must be caught by the named check.
const extraMutations = [
  ['migrations-additive', 'a migration replaces a function body', (d) => writeFileSync(join(d, 'migrations', '998_replace.sql'), 'CREATE OR REPLACE FUNCTION public.mdshare_search(q text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n')],
  ['search-no-filter-injection', 'the search action passes raw query.q', (d) => edit(d, 'api/doc.js', (s) => s.replace('const r = await searchDocs(v.value);', 'const r = await searchDocs({ ...v.value, q: query.q });'))],
  ['search-no-filter-injection', 'api/doc.js builds an ilike filter', (d) => edit(d, 'api/doc.js', (s) => s.replace('const r = await searchDocs(v.value);', 'const r = await searchDocs(v.value); const f = `title=ilike.*${encodeURIComponent(v.value.q)}*`; void f;'))],
  ['search-no-filter-injection', 'search makes a second database call', (d) => edit(d, 'api/_lib/search.js', (s) => s.replace('  if (!Array.isArray(rows)) return { dbError: true };', '  if (!Array.isArray(rows)) return { dbError: true };\n  await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/mdshare_search`, { method: \'POST\' });'))],
  ['search-no-filter-injection', 'search is reachable without documents:read', (d) => edit(d, 'api/doc.js', (s) => s.replace("  search: {\n    auth: 'owner|documents:read',", "  search: {\n    auth: 'owner|documents:write',"))],
  ['markdown-route-gating', '/v serves Markdown itself', (d) => edit(d, 'api/render.js', (s) => s.replace("  if (wantsMarkdown(req, res)) return sendRawMarkdown(req, res, { contentType: 'text/markdown; charset=utf-8' });", "  if (req.headers.authorization) { const { row: r0 } = await getRow('mdshare_pastes', id, 'content'); res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); return res.send(r0.content); }"))],
  ['markdown-route-gating', '/raw stops using the shared read path', (d) => edit(d, 'api/share.js', (s) => s.replace("  if (req.method === 'GET') return sendRawMarkdown(req, res);", "  if (req.method === 'GET') return res.status(200).send('');"))],
  ['markdown-route-gating', 'an invalid Bearer falls back to the public check', (d) => edit(d, 'api/_lib/raw.js', (s) => s.replace("  if (agentAuth.present && !agentAuth.valid) return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid });\n", ''))],
  // A misplaced key may only change the hint on a refused request (adversarial review 2026-11-26).
  ['agent-auth-hints', '/raw refuses a misplaced key before the visibility check', (d) => edit(d, 'api/_lib/raw.js', (s) => s.replace('  // A present-but-invalid Bearer', "  if (apiKeyMisuse(req)) return authHint(req, res, { error: 'Unsupported credential', hint: HINTS.misplaced });\n  // A present-but-invalid Bearer"))],
  ['agent-auth-hints', '/v treats a stray ?token= as an agent request', (d) => edit(d, 'api/_lib/raw.js', (s) => s.replace('  if (parseBearer(req)) return true;\n', '  if (parseBearer(req) || apiKeyMisuse(req)) return true;\n'))],
  ['agent-auth-hints', 'api/doc.js refuses a misplaced key before the owner check', (d) => edit(d, 'api/doc.js', (s) => s.replace('  const agentAuth = await resolveAgentToken(req);\n', "  if (refusalHint(req, null)) return authHint(req, res, { error: 'Unsupported credential', hint: HINTS.missing, scope });\n  const agentAuth = await resolveAgentToken(req);\n"))],
  ['agent-auth-hints', '/raw consults the misplaced-key hint before the row lookup', (d) => edit(d, 'api/_lib/raw.js', (s) => s.replace('  // A present-but-invalid Bearer', '  const early = refusalHint(req, null); void early;\n  // A present-but-invalid Bearer'))],
  ['search-rate-limited', 'the search action stops checking the limit', (d) => edit(d, 'api/doc.js', (s) => s.replace('      if (!rate.allowed) {', '      if (false) {'))],
  ['search-rate-limited', 'the limit is checked after the query runs', (d) => edit(d, 'api/doc.js', (s) => s.replace('      const r = await searchDocs(v.value);\n', '').replace('      const rate = searchRate.check(', '      const r = await searchDocs(v.value);\n      const rate = searchRate.check('))],
  ['agent-auth-hints', 'authHint stops sending WWW-Authenticate', (d) => edit(d, 'api/_lib/raw.js', (s) => s.replace("  res.setHeader('WWW-Authenticate', `Bearer realm=\"mdshare\"${scope ? `, scope=\"${scope}\"` : ''}`);\n", ''))],
];
for (const [id, label, mutate] of extraMutations) {
  test(`invariant "${id}" fails when ${label}`, () => {
    const dir = copyRepo();
    try {
      const before = readFileSync(join(dir, 'api', 'doc.js'), 'utf8') + readFileSync(join(dir, 'api', '_lib', 'raw.js'), 'utf8') + readFileSync(join(dir, 'api', '_lib', 'search.js'), 'utf8') + readFileSync(join(dir, 'api', 'render.js'), 'utf8') + readFileSync(join(dir, 'api', 'share.js'), 'utf8');
      mutate(dir);
      const after = readFileSync(join(dir, 'api', 'doc.js'), 'utf8') + readFileSync(join(dir, 'api', '_lib', 'raw.js'), 'utf8') + readFileSync(join(dir, 'api', '_lib', 'search.js'), 'utf8') + readFileSync(join(dir, 'api', 'render.js'), 'utf8') + readFileSync(join(dir, 'api', 'share.js'), 'utf8');
      if (!/migrations/.test(id)) assert.notEqual(after, before, 'the mutation applied');
      const r = run(dir);
      assert.equal(r.code, 1, `expected failure for ${id} (${label})\n${r.out}`);
      assert.match(r.out, new RegExp(`✗ ${id.replace(/[-]/g, '\\-')} `), r.out);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// Hint links never echo the Host header (adversarial review 2026-11-26).
const originMutations = [
  ['authHint links with baseUrl()', 'api/_lib/raw.js', (s) => s.replace('return res.status(status).json({ error, hint, guide: guideUrl(req) });', 'return res.status(status).json({ error, hint, guide: `${baseUrl(req)}/llms.txt` });')],
  ['siteOrigin echoes any Host', 'api/_lib/content.js', (s) => s.replace('return LOOPBACK_HOST.test(host) ? `http://${host}` : SITE_ORIGIN;', 'return host ? `https://${host}` : SITE_ORIGIN;')],
  ['a guide link is built from the Host header', 'api/share.js', (s) => s.replace("guide: guideUrl(req) });", "guide: `https://${req.headers.host}/llms.txt` });")],
];
for (const [label, file, fn] of originMutations) {
  test(`invariant "guide-link-origin" fails when ${label}`, () => {
    const dir = copyRepo();
    try {
      const before = readFileSync(join(dir, file), 'utf8');
      edit(dir, file, fn);
      assert.notEqual(readFileSync(join(dir, file), 'utf8'), before, 'the mutation applied');
      const r = run(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /✗ guide-link-origin /, r.out);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// Translations and collections (2026-11-26, migration 012): each mutation must be caught by the named check.
const batchBMutations = [
  ['translation-gated', 'share.js links a translation without canUseParent', 'api/share.js', (s) => s.replace('      const t = await canUseParent(body.translation_of, req, res, agentAuth);', "      const t = { ok: true, row: { id: body.translation_of } };")],
  ['translation-gated', 'share.js stores translation_of from the request body', 'api/share.js', (s) => s.replace('      translationOf = translationFields(t.row).translation_of;', '      translationOf = body.translation_of;')],
  ['translation-gated', 'a reader sees a private translation', 'api/_lib/activity.js', (s) => s.replace('.filter((r) => r.id !== root && r.root_id !== root && (owner || r.is_public === true))', '.filter((r) => r.id !== root && r.root_id !== root)')],
  ['translation-gated', 'the translation action skips canUseParent', 'api/doc.js', (s) => s.replace('        const t = await canUseParent(body.translation_of, req, res, agentAuth);', "        const t = { ok: true, row: { id: body.translation_of, lang: null } };")],
  ['translation-gated', 'the translation action stores the body value', 'api/doc.js', (s) => s.replace('        patch.translation_of = link;', '        patch.translation_of = body.translation_of;')],
  ['version-parent-gated', 'canUseParent grants access to a public target', 'api/_lib/activity.js', (s) => s.replace("  if (checkAuthAndRefresh(req, res)) return { ok: true, row };\n  if (agentAuth", "  if (row.is_public === true || checkAuthAndRefresh(req, res)) return { ok: true, row };\n  if (agentAuth")],
  ['collection-owner-only', 'the collection page queries before the owner gate', 'api/_lib/collection-page.js', (s) => s.replace("  res.setHeader('Vary', 'Authorization, Cookie');\n", "  res.setHeader('Vary', 'Authorization, Cookie');\n  const early = await listCollections(); void early;\n")],
  ['collection-owner-only', 'the collection page validates the slug before the gate', 'api/_lib/collection-page.js', (s) => s.replace("  res.setHeader('Vary', 'Authorization, Cookie');\n", "  res.setHeader('Vary', 'Authorization, Cookie');\n  if (req.query.slug && !parseCollection(req.query.slug)) return res.status(404).send(notFoundPage('collection'));\n")],
  ['collection-owner-only', 'the collection page accepts a token', 'api/_lib/collection-page.js', (s) => s.replace('  if (!checkAuthAndRefresh(req, res)) {', '  const agentAuth = await resolveAgentToken(req);\n  if (!checkAuthAndRefresh(req, res) && !agentAuth.valid) {')],
  ['collection-owner-only', 'patchMeta accepts any field', 'api/_lib/collections.js', (s) => s.replace("  if (!keys.length || keys.some((k) => !META_FIELDS.includes(k))) throw new Error(`patchMeta: only ${META_FIELDS.join(', ')} may be changed here`);\n", '')],
  ['collection-owner-only', 'META_FIELDS grows to include is_public', 'api/_lib/collections.js', (s) => s.replace("export const META_FIELDS = ['lang', 'translation_of', 'collection'];", "export const META_FIELDS = ['lang', 'translation_of', 'collection', 'is_public'];")],
  ['collection-owner-only', 'canEditMeta lets any write token edit any row', 'api/_lib/collections.js', (s) => s.replace('if (row && agentAuth && agentAuth.valid && row.created_by_token === agentAuth.id)', "if (row && agentAuth && agentAuth.valid && hasScope(agentAuth, 'documents:write'))")],
  ['collection-owner-only', 'a token edits the whole family, not just its rows', 'api/doc.js', (s) => s.replace('      const w = await patchMeta(familyFilter(e.row, e.owner ? null : agentAuth.id), { collection: coll });', '      const w = await patchMeta(familyFilter(e.row, null), { collection: coll });')],
  ['collection-owner-only', 'the collection action POST is opened to documents:read', 'api/doc.js', (s) => s.replace("auth: { GET: 'owner|documents:read', POST: 'owner|documents:write,documents:publish' }", "auth: { GET: 'owner|documents:read', POST: 'owner|documents:read' }")],
  ['collection-owner-only', 'the TOC queries once per entry', 'api/_lib/collections.js', (s) => s.replace('    for (const e of entries) {\n', '    for (const e of entries) {\n      e.extra = await sbSelect(\'mdshare_pastes\', `id=eq.${encodeURIComponent(e.id)}&select=id`);\n')],
  ['collection-owner-only', 'the /c/:slug rewrite goes elsewhere', 'vercel.json', (s) => s.replace('/api/render?kind=collection&slug=:slug', '/api/pastes?collection=:slug')],
  ['activity-actions-auth', 'a multi-scope auth names a scope that does not exist', 'api/doc.js', (s) => s.replace("auth: 'owner|documents:write,documents:publish', httpMethod: 'POST',", "auth: 'owner|documents:write,documents:everything', httpMethod: 'POST',")],
];
for (const [id, label, file, fn] of batchBMutations) {
  test(`invariant "${id}" fails when ${label}`, () => {
    const dir = copyRepo();
    try {
      const before = readFileSync(join(dir, file), 'utf8');
      edit(dir, file, fn);
      assert.notEqual(readFileSync(join(dir, file), 'utf8'), before, 'the mutation applied');
      const r = run(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`✗ ${id.replace(/[-]/g, '\\-')} `), r.out);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// Second mutation for the write allowlist: a direct write from api/doc.js.
test('invariant "activity-writes-allowlist" fails when api/doc.js writes directly', () => {
  const dir = copyRepo();
  try {
    appendFileSync(join(dir, 'api', 'doc.js'), "\nconst sneak = () => fetch(process.env.SUPABASE_URL + '/rest/v1/mdshare_pastes', { method: 'PATCH' });\n");
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ activity-writes-allowlist /, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [id, mutate] of Object.entries(mutations)) {
  test(`invariant "${id}" fails when broken`, () => {
    const dir = copyRepo();
    try {
      mutate(dir);
      const r = run(dir);
      assert.equal(r.code, 1, `expected failure for ${id}\n${r.out}`);
      assert.match(r.out, new RegExp(`✗ ${id.replace(/[-]/g, '\\-')} `), r.out);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('invariant "activity-actions-auth" fails when an action hides behind a quoted key', () => {
  const dir = copyRepo();
  try {
    edit(dir, 'api/doc.js', (s) => s.replace('const ACTIONS = {\n', "const ACTIONS = {\n  'sneak': { httpMethod: 'GET', async run() { return [200, {}]; } },\n"));
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ activity-actions-auth /, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invariant "loop-owner-only" fails when a page links loop.js directly', () => {
  const dir = copyRepo();
  try {
    edit(dir, 'api/_lib/diagram-page.js', (s) => s.replace('</body></html>', '<script src="/assets/loop.js"></script></body></html>'));
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ loop-owner-only /, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invariant "version-reads-constant" fails when a new version stops storing root_id', () => {
  const dir = copyRepo();
  try {
    edit(dir, 'api/share.js', (s) => s.replace('root_id: links.rootId || null, ', ''));
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ version-reads-constant /, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// mermaid-vendored reads public/, which copyRepo() leaves out; copy it for these two cases.
function copyWithPublic() { const dir = copyRepo(); cpSync(join(ROOT, 'public'), join(dir, 'public'), { recursive: true }); return dir; }
test('invariant "mermaid-vendored" passes on the real public/ and fails when the vendored file is missing or a CDN URL returns', () => {
  for (const [label, mutate, expectFail] of [
    ['baseline', () => {}, false],
    ['missing file', (d) => rmSync(join(d, 'public', 'vendor', readdirSync(join(d, 'public', 'vendor')).find((f) => f.startsWith('mermaid-')))), true],
    ['CDN url', (d) => appendFileSync(join(d, 'public', 'assets', 'render.js'), "\n// x\nvar back = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';\n"), true],
    ['CDN url in a server template', (d) => edit(d, 'api/_lib/classic.js', (s) => s.replace('<script src="/vendor/mermaid-11.17.2.min.js"></script>', '<script src="https://unpkg.com/mermaid@11/dist/mermaid.min.js"></script>')), true],
    ['loose security level', (d) => edit(d, 'api/_lib/classic.js', (s) => s.replace("securityLevel: 'strict'", "securityLevel: 'loose'")), true],
    ['vendored path that does not exist', (d) => edit(d, 'api/_lib/classic.js', (s) => s.replace('/vendor/mermaid-11.17.2.min.js', '/vendor/mermaid-9.0.0.min.js')), true],
  ]) {
    const dir = copyWithPublic();
    try {
      mutate(dir);
      const r = run(dir);
      if (expectFail) { assert.equal(r.code, 1, `${label}\n${r.out}`); assert.match(r.out, /✗ mermaid-vendored /, r.out); }
      else assert.equal(r.code, 0, `${label}\n${r.out}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
