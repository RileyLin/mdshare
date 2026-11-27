// Proves each invariant in scripts/check-invariants.mjs actually fires: copy the repo to a temp
// dir, break exactly one invariant, and expect that check (and only a failure) to be reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'check-invariants.mjs');

function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mdshare-inv-'));
  for (const p of ['api', 'migrations', 'scripts', 'vercel.json', 'CLAUDE.md', 'README.md', 'public/enter.html']) {
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
  'version-parent-gated': (d) => edit(d, 'api/_lib/activity.js', (s) => s.replace("if (!row) return { ok: false };\n  if (me.via === 'cookie') return { ok: true, row };\n  if (agentAuth", "if (!row) return { ok: false };\n  if (row.is_public === true) return { ok: true, row };\n  if (me.via === 'cookie') return { ok: true, row };\n  if (agentAuth")),
  'loop-owner-only': (d) => edit(d, 'api/_lib/diagram-page.js', (s) => s.replace("${scripts(['marked', 'purify', 'hljs', 'render', 'app'])}", "${scripts(['marked', 'purify', 'hljs', 'render', 'app', 'loop'])}")),
  'publish-checks': (d) => edit(d, 'api/share.js', (s) => s.replace(', checks: lintMarkdown(markdown) }', ' }')),
  'version-reads-constant': (d) => edit(d, 'api/_lib/activity.js', (s) => s.replace("  const mine = versionNoOf(row);", "  const mine = versionNoOf(row);\n  for (let cur = row && row.parent_id, k = 0; cur && k < 20; k++) cur = (await selectOwned('mdshare_pastes', rowOwner(row), `id=eq.${encodeURIComponent(cur)}&select=parent_id`))[0]?.parent_id;")),
  // Search + agent access (2026-11-26).
  'search-no-filter-injection': (d) => edit(d, 'api/_lib/search.js', (s) => s.replace('`${process.env.SUPABASE_URL}/rest/v1/rpc/mdshare_search_owned`', '`${process.env.SUPABASE_URL}/rest/v1/mdshare_pastes?or=(title.ilike.*${encodeURIComponent(q)}*,content.ilike.*${encodeURIComponent(q)}*)`')),
  'markdown-route-gating': (d) => edit(d, 'api/_lib/raw.js', (s) => s.replace('if (!row || !isVisible(row, req, res, { agentOwns })) {', 'if (!row || !(row.is_public === true || agentOwns)) {')),
  'agent-auth-hints': (d) => edit(d, 'api/doc.js', (s) => s.replace("return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid, scope });", "return res.status(401).json({ error: 'Invalid or expired token' });")),
};

// More ways to break the 2026-11-26 rules; each must be caught by the named check.
const extraMutations = [
  ['migrations-additive', 'a migration replaces a function body', (d) => writeFileSync(join(d, 'migrations', '998_replace.sql'), 'CREATE OR REPLACE FUNCTION public.mdshare_search(q text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n')],
  ['search-no-filter-injection', 'the search action passes raw query.q', (d) => edit(d, 'api/doc.js', (s) => s.replace('const r = await searchDocs(me, v.value);', 'const r = await searchDocs(me, { ...v.value, q: query.q });'))],
  ['search-no-filter-injection', 'api/doc.js builds an ilike filter', (d) => edit(d, 'api/doc.js', (s) => s.replace('const r = await searchDocs(me, v.value);', 'const r = await searchDocs(me, v.value); const f = `title=ilike.*${encodeURIComponent(v.value.q)}*`; void f;'))],
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
  // Every GET action is rate-limited (search: ADV-A; collection and the rest: ADV-B, 2026-11-26).
  ['doc-reads-rate-limited', 'the handler stops checking the limit', (d) => edit(d, 'api/doc.js', (s) => s.replace('    if (!rate.allowed) {', '    if (false) {'))],
  ['doc-reads-rate-limited', 'only search is limited', (d) => edit(d, 'api/doc.js', (s) => s.replace("  if (req.method === 'GET') {\n    const rate", "  if (req.method === 'GET' && name === 'search') {\n    const rate"))],
  ['doc-reads-rate-limited', 'the collection action loses its limiter', (d) => edit(d, 'api/doc.js', (s) => s.replace(", rate: readLimiter('collection lookups')", ''))],
  ['doc-reads-rate-limited', 'a new GET action has no limiter', (d) => edit(d, 'api/doc.js', (s) => s.replace('const ACTIONS = {\n', "const ACTIONS = {\n  stats: {\n    auth: 'owner|documents:read', httpMethod: 'GET',\n    async run() { return [200, {}]; },\n  },\n"))],
  ['doc-reads-rate-limited', 'two actions share one allowance', (d) => edit(d, 'api/doc.js', (s) => s.replace("rate: readLimiter('version lookups')", "rate: readLimiter('searches')"))],
  ['doc-reads-rate-limited', 'the limit is checked after the query runs', (d) => edit(d, 'api/doc.js', (s) => {
    const start = s.indexOf("  if (req.method === 'GET') {\n    const rate");
    const end = s.indexOf('  const [status, payload] = await action.run(');
    const block = s.slice(start, end);
    const after = s.indexOf('\n', end) + 1;
    return s.slice(0, start) + s.slice(end, after) + block + s.slice(after);
  })],
  ['doc-reads-rate-limited', 'refused requests are counted', (d) => edit(d, 'api/doc.js', (s) => {
    const start = s.indexOf("  if (req.method === 'GET') {\n    const rate");
    const end = s.indexOf('  const [status, payload] = await action.run(');
    const block = s.slice(start, end);
    const gate = s.indexOf('  if (!allowed(auth, req, res, agentAuth)) {');
    return s.slice(0, gate) + block + s.slice(gate, start) + s.slice(end);
  })],
  ['doc-reads-rate-limited', 'a limiter call moves back inside run()', (d) => edit(d, 'api/doc.js', (s) => s.replace('      const r = await searchDocs(me, v.value);', "      const extra = rateLimiter({ limit: 1000, windowMs: 1000 }); void extra;\n      const r = await searchDocs(me, v.value);"))],
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
  ['translation-gated', 'share.js links a translation without canLinkTranslation', 'api/share.js', (s) => s.replace('      const t = await canLinkTranslation(body.translation_of, req, res, agentAuth);', "      const t = { ok: true, row: { id: body.translation_of } };")],
  ['translation-gated', 'share.js stores translation_of from the request body', 'api/share.js', (s) => s.replace('      translationOf = translationFields(t.row).translation_of;', '      translationOf = body.translation_of;')],
  ['translation-gated', 'a reader sees a private translation', 'api/_lib/activity.js', (s) => s.replace('.filter((r) => r.id !== root && r.root_id !== root && (owner || r.is_public === true))', '.filter((r) => r.id !== root && r.root_id !== root)')],
  ['translation-gated', 'the translation action skips canLinkTranslation', 'api/doc.js', (s) => s.replace('        const t = await canLinkTranslation(body.translation_of, req, res, agentAuth);', "        const t = { ok: true, row: { id: body.translation_of, lang: null } };")],
  // ADV-B finding 2: a token links only a pair it created; documents:read is not enough.
  ['translation-gated', 'share.js goes back to canUseParent (documents:read links anything)', 'api/share.js', (s) => s.replace('      const t = await canLinkTranslation(body.translation_of, req, res, agentAuth);', '      const t = await canUseParent(body.translation_of, req, res, agentAuth);')],
  ['translation-gated', 'the translation action goes back to canUseParent', 'api/doc.js', (s) => s.replace('        const t = await canLinkTranslation(body.translation_of, req, res, agentAuth);', '        const t = await canUseParent(body.translation_of, req, res, agentAuth);')],
  ['translation-gated', 'canLinkTranslation lets documents:read link to any document', 'api/_lib/activity.js', (s) => s.replace('  if (!mine(row)) return { ok: false };', "  if (!mine(row) && !hasScope(agentAuth, 'documents:read')) return { ok: false };")],
  ['translation-gated', 'canLinkTranslation grants a public target', 'api/_lib/activity.js', (s) => s.replace('  if (!mine(row)) return { ok: false };', '  if (!mine(row) && row.is_public !== true) return { ok: false };')],
  ['translation-gated', 'canLinkTranslation stops checking who created the group', 'api/_lib/activity.js', (s) => s.replace('  return mine(g.row) ? { ok: true, row } : { ok: false };', '  return g.row ? { ok: true, row } : { ok: false };')],
  ['translation-gated', 'canLinkTranslation skips the group lookup', 'api/_lib/activity.js', (s) => s.replace('  if (group === row.id) return { ok: true, row };', '  return { ok: true, row };')],
  // ADV-B finding 3: the self/circular-link guard is part of the invariant, not just a unit test.
  ['translation-gated', 'the translation action drops the self/circular-link guard', 'api/doc.js', (s) => s.replace("        if ((t.row.root_id || t.row.id) === own || link === own) return [400, { error: 'translation_of is this document or already its translation; link the translation to the original instead' }];\n", '')],
  ['translation-gated', 'the translation action only checks its own family, not the circular link', 'api/doc.js', (s) => s.replace('if ((t.row.root_id || t.row.id) === own || link === own) return [400,', 'if ((t.row.root_id || t.row.id) === own) return [400,')],
  ['translation-gated', 'the guard moves after the write', 'api/doc.js', (s) => s.replace("        if ((t.row.root_id || t.row.id) === own || link === own) return [400, { error: 'translation_of is this document or already its translation; link the translation to the original instead' }];\n", '').replace('      return w.dbError ? [503, { error: \'Temporarily unavailable\' }] : [200, { ok: true, id: e.row.id, ...patch,', "      if ((t.row.root_id || t.row.id) === own || link === own) return [400, {}];\n      return w.dbError ? [503, { error: 'Temporarily unavailable' }] : [200, { ok: true, id: e.row.id, ...patch,")],
  ['translation-gated', 'share.js drops the own-family guard', 'api/share.js', (s) => s.replace("      if (version.root_id && (t.row.root_id || t.row.id) === version.root_id) return res.status(400).json({ error: 'translation_of is a version of this same document; use parent for a revision' });\n", '')],
  ['translation-gated', 'the translation action stores the body value', 'api/doc.js', (s) => s.replace('        patch.translation_of = link;', '        patch.translation_of = body.translation_of;')],
  ['version-parent-gated', 'canUseParent grants access to a public target', 'api/_lib/activity.js', (s) => s.replace("  if (me.via === 'cookie') return { ok: true, row };\n  if (agentAuth", "  if (row.is_public === true || me.via === 'cookie') return { ok: true, row };\n  if (agentAuth")],
  ['collection-owner-only', 'the collection page queries before the owner gate', 'api/_lib/collection-page.js', (s) => s.replace("  res.setHeader('Vary', 'Authorization, Cookie');\n", "  res.setHeader('Vary', 'Authorization, Cookie');\n  const early = await listCollections(); void early;\n")],
  ['collection-owner-only', 'the collection page validates the slug before the gate', 'api/_lib/collection-page.js', (s) => s.replace("  res.setHeader('Vary', 'Authorization, Cookie');\n", "  res.setHeader('Vary', 'Authorization, Cookie');\n  if (req.query.slug && !parseCollection(req.query.slug)) return res.status(404).send(notFoundPage('collection'));\n")],
  ['collection-owner-only', 'the collection page accepts a token', 'api/_lib/collection-page.js', (s) => s.replace('  if (!checkAuthAndRefresh(req, res)) {', '  const agentAuth = await resolveAgentToken(req);\n  if (!checkAuthAndRefresh(req, res) && !agentAuth.valid) {')],
  ['collection-owner-only', 'patchMeta accepts any field', 'api/_lib/collections.js', (s) => s.replace("  if (!keys.length || keys.some((k) => !META_FIELDS.includes(k))) throw new Error(`patchMeta: only ${META_FIELDS.join(', ')} may be changed here`);\n", '')],
  ['collection-owner-only', 'META_FIELDS grows to include is_public', 'api/_lib/collections.js', (s) => s.replace("export const META_FIELDS = ['lang', 'translation_of', 'collection'];", "export const META_FIELDS = ['lang', 'translation_of', 'collection', 'is_public'];")],
  ['collection-owner-only', 'canEditMeta lets any write token edit any row', 'api/_lib/collections.js', (s) => s.replace('if (row && agentAuth && agentAuth.valid && row.created_by_token === agentAuth.id)', "if (row && agentAuth && agentAuth.valid && hasScope(agentAuth, 'documents:write'))")],
  ['collection-owner-only', 'a token edits the whole family, not just its rows', 'api/doc.js', (s) => s.replace('      const w = await patchMeta(me, familyFilter(e.row, e.owner ? null : agentAuth.id), { collection: coll });', '      const w = await patchMeta(me, familyFilter(e.row, null), { collection: coll });')],
  ['collection-owner-only', 'the collection action POST is opened to documents:read', 'api/doc.js', (s) => s.replace("auth: { GET: 'owner|documents:read', POST: 'owner|documents:write,documents:publish' }", "auth: { GET: 'owner|documents:read', POST: 'owner|documents:read' }")],
  ['collection-owner-only', 'the TOC queries once per entry', 'api/_lib/collections.js', (s) => s.replace('    for (const e of entries) {\n', '    for (const e of entries) {\n      e.extra = await selectOwned(\'mdshare_pastes\', me, `id=eq.${encodeURIComponent(e.id)}&select=id`);\n')],
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

// Multi-user beta (2026-11-27): the three tenant invariants. Each line removes one scope (or adds
// one unscoped path) and must be caught by the named check.
const tenantMutations = [
  ['tenant-scoped', 'the library queries PostgREST directly', 'api/pastes.js', (s) => s.replace("  const me = sessionOwner(req, res);\n", "  const me = sessionOwner(req, res);\n  const raw = await fetch(`${process.env.SUPABASE_URL}/rest/v1/mdshare_pastes?select=id`); void raw;\n")],
  ['tenant-scoped', 'selectOwned drops the owner filter', 'api/_lib/tenant.js', (s) => s.replace("const res = await request(table, `${ownerFilter(me)}${query ? `&${query}` : ''}`);", "const res = await request(table, query || '');")],
  ['tenant-scoped', 'readOwned becomes an unscoped by-id read', 'api/_lib/tenant.js', (s) => s.replace("return byId(table, `${ownerFilter(me)}&`, id, select);", "return byId(table, '', id, select);")],
  ['tenant-scoped', 'a new unscoped export joins UNSCOPED', 'api/_lib/tenant.js', (s) => s.replace("'recentEventsAllUsers', 'ownerlessTables'];", "'recentEventsAllUsers', 'ownerlessTables', 'allPastes'];\nexport async function allPastes() { return rowsOf(await request('mdshare_pastes', 'select=id')); }")],
  ['tenant-scoped', 'a new export queries without the owner filter', 'api/_lib/tenant.js', (s) => s + "\nexport async function everyFeedback() {\n  return rowsOf(await request('mdshare_feedback', 'select=*'));\n}\n"],
  ['tenant-scoped', 'ownerFilter stops encoding / scoping', 'api/_lib/tenant.js', (s) => s.replace('return `owner_id=eq.${encodeURIComponent(uidOf(me))}`;', 'return `owner_id=not.is.null`;')],
  ['tenant-scoped', 'the anonymous-create principal becomes readable', 'api/_lib/tenant.js', (s) => s.replace(" && me.via !== 'anonymous-create'", '')],
  ['tenant-scoped', 'isVisible goes back to "any signed-in user sees everything"', 'api/_lib/access.js', (s) => s.replace('if (owns(sessionOwner(req, res), row)) return true;', 'if (sessionOwner(req, res)) return true;')],
  ['tenant-scoped', 'tokenCanRead stops checking the token\'s user', 'api/_lib/access.js', (s) => s.replace('  if (!owns(tokenOwner(agentAuth), row)) return false;\n', '')],
  ['tenant-scoped', 'the reader page shows owner controls to any session', 'api/render.js', (s) => s.replace("import { readForView } from './_lib/tenant.js';", "import { readForView } from './_lib/tenant.js';\nimport { checkAuthAndRefresh } from './_lib/session.js';").replace('const authed = viewerOwns(row, req, res);', 'const authed = checkAuthAndRefresh(req, res);')],
  ['tenant-scoped', 'the doc API reads a row without scoping it', 'api/doc.js', (s) => s.replace("const { row, dbError } = await readOwned('mdshare_pastes', me, body.id, 'id,expires_at');", "const { row, dbError } = await readForView('mdshare_pastes', body.id, 'id,expires_at');").replace("import { ownerOf, readOwned } from './_lib/tenant.js';", "import { ownerOf, readOwned, readForView } from './_lib/tenant.js';")],
  ['tenant-scoped', 'a route reads the service key itself', 'api/pin.js', (s) => s + '\nexport const leakKey = () => process.env.SUPABASE_SERVICE_KEY;\n'],
  ['tenant-scoped', 'the old getRow helper comes back', 'api/_lib/access.js', (s) => s + '\nexport async function getRow(table, id) { return { table, id }; }\n'],
  ['tenant-scoped', 'the diagram API computes the token branch itself', 'api/diagram.js', (s) => s.replace('const agentOwns = tokenCanRead(agentAuth, row);', "const agentOwns = !!(agentAuth.valid && row && hasScope(agentAuth, 'documents:read'));")],
  ['owner-on-insert', 'share.js takes the owner from the body', 'api/share.js', (s) => s.replace('origin: links.origin || null,', 'origin: links.origin || null, owner_id: body?.owner_id,')],
  ['owner-on-insert', 'insertOwned lets the row carry its own owner', 'api/_lib/tenant.js', (s) => s.replace("  assertNoOwner(row, 'insertOwned');\n", '')],
  ['owner-on-insert', 'insertOwned lets the row override the owner', 'api/_lib/tenant.js', (s) => s.replace('body: JSON.stringify({ ...row, owner_id: uid }),', 'body: JSON.stringify({ owner_id: uid, ...row }),')],
  ['owner-on-insert', 'insertOwned accepts a lookalike principal', 'api/_lib/tenant.js', (s) => s.replace('if (!PRINCIPALS.has(owner) || !isUid(owner.uid)) throw', 'if (!isUid(owner.uid)) throw')],
  ['owner-on-insert', 'a diagram create stops naming its owner', 'api/diagram.js', (s) => s.replace('await supabaseSet(creatorOf(req, res, agentAuth), id,', 'await supabaseSet(null, id,')],
  ['owner-on-insert', 'tenant.js grows a second insert path', 'api/_lib/tenant.js', (s) => s + "\nexport function rawInsert(table, row) {\n  return request(table, '', { method: 'POST', body: JSON.stringify(row) });\n}\n"],
  ['owner-on-insert', 'patchOwned may move a row to another owner', 'api/_lib/tenant.js', (s) => s.replace("  assertNoOwner(patch, 'patchOwned');\n", '')],
  ['owner-on-insert', 'a read path uses creatorOf (anonymous would read as the site owner)', 'api/pastes.js', (s) => s.replace('const me = sessionOwner(req, res);', 'const me = creatorOf(req, res, null);')],
  ['search-owner-param', 'search stops sending p_owner', 'api/_lib/search.js', (s) => s.replace('body: JSON.stringify({ q, lim: limit, skip: offset, p_owner: owner }),', 'body: JSON.stringify({ q, lim: limit, skip: offset }),')],
  ['search-owner-param', 'search sends a fixed owner', 'api/_lib/search.js', (s) => s.replace('const owner = uidOf(me);', 'const owner = 1;')],
  ['search-owner-param', 'search goes back to the unscoped rpc', 'api/_lib/search.js', (s) => s.replace('/rest/v1/rpc/mdshare_search_owned`', '/rest/v1/rpc/mdshare_search`')],
  ['search-owner-param', 'the search action drops the principal', 'api/doc.js', (s) => s.replace('const r = await searchDocs(me, v.value);', 'const r = await searchDocs(null, v.value);')],
  ['search-owner-param', 'the migration function stops filtering by owner', 'migrations/013_multiuser_owner.sql', (s) => s.replace('WHERE t.owner_id = p_owner\n            AND', 'WHERE')],
];
for (const [id, label, file, fn] of tenantMutations) {
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

// Worktrees symlink node_modules; git then lists the link itself (".gitignore: node_modules/" only
// matches a real directory) and no-secrets used to crash reading it (EISDIR, REPORT-P4).
test('invariant "no-secrets" skips a symlinked node_modules in a git checkout (no EISDIR crash)', () => {
  const dir = copyRepo();
  const target = mkdtempSync(join(tmpdir(), 'mdshare-nm-'));
  try {
    writeFileSync(join(target, 'x.js'), 'export {};\n');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    symlinkSync(target, join(dir, 'node_modules'));
    const g = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    const listed = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n');
    assert.ok(listed.includes('node_modules'), 'git lists the symlink itself (the case that crashed)');
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /check crashed|EISDIR/, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

// Multi-user beta P3 (2026-11-27): sign-up, entry links, user #1, admin, the kill switch. Each line
// breaks one rule and must be caught by the named check.
const p3Mutations = [
  ['signup-rate-limited-and-capped', 'the per-IP sign-up limit is skipped', 'api/auth.js', (s) => s.replace("  const rate = SIGNUP_LIMIT.check(clientIp(req));\n  if (!rate.allowed) return tooMany(res, rate, `sign-ups (at most ${SIGNUP_LIMIT.limit} an hour)`);\n", '')],
  ['signup-rate-limited-and-capped', 'the limit grows to 50 an hour', 'api/auth.js', (s) => s.replace('rateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 })', 'rateLimiter({ limit: 50, windowMs: 60 * 60 * 1000 })')],
  ['signup-rate-limited-and-capped', 'createUser() no longer gets the cap', 'api/auth.js', (s) => s.replace('const me = await createUser({ label, entryHash: entryHash(secret), max: cap });', 'const me = await createUser({ label, entryHash: entryHash(secret), max: 1e9 });')],
  ['signup-rate-limited-and-capped', 'a full beta still creates a user', 'api/auth.js', (s) => s.replace("  if (!me) return res.status(403).json({ error: 'beta full' });\n", '')],
  ['signup-rate-limited-and-capped', 'createUser goes back to count-then-insert', 'api/_lib/tenant.js', (s) => s.replace("const r = await request(SIGNUP_RPC, '', jsonInit('POST', { p_label: typeof label === 'string' ? label : null, p_entry_hash: entryHash, p_max: max }));", "const r = await request(USERS, 'select=id', jsonInit('POST', { label: typeof label === 'string' ? label : null, entry_hash: entryHash }));")],
  ['signup-rate-limited-and-capped', 'the sign-up function loses its lock', 'migrations/016_atomic_signup_quota.sql', (s) => s.replace("        PERFORM pg_advisory_xact_lock(hashtext('mdshare_signup_user')::bigint);\n", '')],
  ['signup-rate-limited-and-capped', 'the sign-up token gets documents:publish:any', 'api/auth.js', (s) => s.replace("export const SIGNUP_SCOPES = ['documents:read', 'documents:write', 'documents:publish'];", "export const SIGNUP_SCOPES = ['documents:read', 'documents:write', 'documents:publish', 'documents:publish:any'];")],
  ['signup-rate-limited-and-capped', 'the 429 loses Retry-After', 'api/auth.js', (s) => s.replace("function tooMany(res, rate, what) {\n  res.setHeader('Retry-After', String(rate.retryAfter));\n", 'function tooMany(res, rate, what) {\n')],
  ['signup-rate-limited-and-capped', 'the default cap becomes 500', 'api/_lib/tenant.js', (s) => s.replace('export const DEFAULT_MAX_USERS = 50;', 'export const DEFAULT_MAX_USERS = 500;')],
  ['signup-rate-limited-and-capped', 'the seat count includes user #1', 'migrations/016_atomic_signup_quota.sql', (s) => s.replace('FROM mdshare_users WHERE id > 1;', 'FROM mdshare_users WHERE id > 0;')],
  ['entry-secret-hashed', 'the plain secret is stored', 'api/auth.js', (s) => s.replace('const me = await createUser({ label, entryHash: entryHash(secret), max: cap });', 'const me = await createUser({ label, entryHash: secret, max: cap });')],
  ['entry-secret-hashed', 'createUser stops checking it got a hash', 'api/_lib/tenant.js', (s) => s.replace("export async function createUser({ label, entryHash, max }) {\n  assertEntryHash(entryHash);\n", 'export async function createUser({ label, entryHash, max }) {\n')],
  ['entry-secret-hashed', 'the secret is logged', 'api/auth.js', (s) => s.replace("  if (!uid) return res.status(401).json({ error: ENTRY_FAILED });", "  console.log('entry attempt', secret);\n  if (!uid) return res.status(401).json({ error: ENTRY_FAILED });")],
  ['entry-secret-hashed', 'the link puts the secret in the query string', 'api/auth.js', (s) => s.replace('const entryUrl = (req, secret) => `${siteOrigin(req)}/enter#${secret}`;', 'const entryUrl = (req, secret) => `${siteOrigin(req)}/enter?s=${secret}`;')],
  ['entry-secret-hashed', 'the link is built from the Host header', 'api/auth.js', (s) => s.replace('const entryUrl = (req, secret) => `${siteOrigin(req)}/enter#${secret}`;', 'const entryUrl = (req, secret) => `https://${req.headers.host}/enter#${secret}`;')],
  ['entry-secret-hashed', 'the lookup compares with ===', 'api/_lib/tenant.js', (s) => s.replace('!safeHexEqual(String(u.entry_hash), hash)', 'u.entry_hash !== hash')],
  ['entry-secret-hashed', 'the stats select entry_hash', 'api/_lib/tenant.js', (s) => s.replace("const r = await request(STATS_RPC, '', jsonInit('POST', {})).catch(() => null);", "const r = await request(STATS_RPC, '', jsonInit('POST', { extra: 'entry_hash' })).catch(() => null);")],
  ['entry-secret-hashed', '/enter reads the query string', 'public/enter.html', (s) => s.replace('var secret = location.hash.slice(1);', "var secret = location.hash.slice(1) || new URLSearchParams(location.search).get('s');")],
  ['entry-secret-hashed', '/enter leaves the secret in the address bar', 'public/enter.html', (s) => s.replace("  history.replaceState(null, '', location.pathname);\n", '')],
  ['entry-secret-hashed', '/enter keeps the secret in localStorage', 'public/enter.html', (s) => s.replace("  history.replaceState(null, '', location.pathname);\n", "  history.replaceState(null, '', location.pathname);\n  localStorage.setItem('mdshare-entry', secret);\n")],
  ['entry-secret-hashed', 'the /enter rewrite is gone', 'vercel.json', (s) => { const v = JSON.parse(s); v.rewrites = v.rewrites.filter((r) => r.source !== '/enter'); return JSON.stringify(v); }],
  ['user-one-protected', 'user #1 gets a quota', 'api/_lib/tenant.js', (s) => s.replace('async function enforceQuota(owner, row, { daily }) {\n  if (owner.uid === SITE_OWNER_UID) return;\n', 'async function enforceQuota(owner, row, { daily }) {\n')],
  ['user-one-protected', 'user #1 can be disabled', 'api/_lib/tenant.js', (s) => s.replace("  if (uid === SITE_OWNER_UID) throw new Refused(400, 'User #1 (the owner) can never be disabled');\n", '')],
  ['user-one-protected', 'user #1 is looked up like anyone else', 'api/_lib/tenant.js', (s) => s.replace('export async function userActive(uid) {\n  if (uid === SITE_OWNER_UID) return true;\n', 'export async function userActive(uid) {\n')],
  ['user-one-protected', 'an entry link can sign in user #1', 'api/_lib/tenant.js', (s) => s.replace(' || u.id === SITE_OWNER_UID) return null;', ') return null;')],
  ['user-one-protected', 'the password signs in whoever the body names', 'api/auth.js', (s) => s.replace("    res.setHeader('Set-Cookie', freshSessionCookie(OWNER_UID));", "    res.setHeader('Set-Cookie', freshSessionCookie(Number(body.user_id) || OWNER_UID));")],
  ['user-one-protected', 'the route stops refusing user #1', 'api/auth.js', (s) => s.replace("  if (uid === OWNER_UID) return res.status(400).json({ error: 'User #1 (the owner) can never be disabled' });\n", '')],
  ['user-one-protected', 'migration 014 stops making user #1 unlimited', 'migrations/014_signup_quotas_stats.sql', (s) => s.replace('UPDATE mdshare_users SET quota_docs_per_day = NULL, quota_bytes = NULL WHERE id = 1', 'UPDATE mdshare_users SET quota_docs_per_day = NULL WHERE id = 1')],
  ['owner-only-admin', 'any user may read the stats', 'api/doc.js', (s) => s.replace("auth: 'admin|activity:read', httpMethod: 'GET'", "auth: 'owner|activity:read', httpMethod: 'GET'")],
  ['owner-only-admin', "allowed() stops checking for user #1", 'api/_lib/activity.js', (s) => s.replace("  if (auth.startsWith('admin') && me.uid !== SITE_OWNER_UID) return false;\n", '')],
  ['owner-only-admin', 'userStats() trusts its caller', 'api/_lib/tenant.js', (s) => s.replace("  if (!readable(me) || me.uid !== SITE_OWNER_UID) throw new Refused(403, 'Owner only');\n", '')],
  ['owner-only-admin', 'setUserDisabled() trusts its caller', 'api/_lib/tenant.js', (s) => s.replace("export async function setUserDisabled(me, uid, disabled) {\n  if (!isAdmin(me)) throw new Refused(403, 'Owner only');\n", 'export async function setUserDisabled(me, uid, disabled) {\n')],
  ['owner-only-admin', 'isAdmin accepts a token', 'api/_lib/tenant.js', (s) => s.replace("return readable(me) && me.via === 'cookie' && me.uid === SITE_OWNER_UID;", 'return readable(me) && me.uid === SITE_OWNER_UID;')],
  ['owner-only-admin', 'the kill switch takes any session', 'api/auth.js', (s) => s.replace("  const me = sessionOwner(req, res);\n  if (!isAdmin(me)) return res.status(me ? 403 : 401).json({ error: 'Owner only' });\n", "  const me = sessionOwner(req, res);\n  if (!me) return res.status(401).json({ error: 'Owner only' });\n")],
  ['disabled-user-gated', 'withErrors skips the session gate', 'api/_lib/events.js', (s) => s.replace('      await gateSession(req);\n', '')],
  ['disabled-user-gated', 'sessionUid ignores a rejected session', 'api/_lib/session.js', (s) => s.replace('  if (sessionRejected(req)) return null; // a disabled or unknown user (gateSession)\n', '')],
  ['disabled-user-gated', "a disabled user's public page stays up", 'api/_lib/tenant.js', (s) => s.replace("  if (found.row && found.row.owner_id !== SITE_OWNER_UID && !(await userActive(found.row.owner_id))) return { row: null };\n", '')],
  ['disabled-user-gated', "a disabled user's token keeps working", 'api/_lib/agent-tokens.js', (s) => s.replace("    if (row.ownerDisabled) return { present: true, valid: false, reason: 'disabled' };\n", '')],
  ['disabled-user-gated', 'a user with no row counts as active', 'api/_lib/tenant.js', (s) => s.replace('  return !!u && u.disabled === false;', '  return !u || u.disabled === false;')],
  ['disabled-user-gated', 'a database error lets the user in', 'api/_lib/tenant.js', (s) => s.replace('    if (!r.ok) return null;\n    const rows = await rowsOf(r);\n    return rows.length === 1 ? rows[0] : null;', "    if (!r.ok) return { disabled: false };\n    const rows = await rowsOf(r);\n    return rows.length === 1 ? rows[0] : null;")],
  ['disabled-user-gated', 'the gate forgets the disabled flag', 'api/_lib/tenant.js', (s) => s.replace('  if (!u || u.disabled !== false || signedInBefore(req, u.sessions_valid_after)) rejectSession(req);', '  if (!u || signedInBefore(req, u.sessions_valid_after)) rejectSession(req);')],
  ['disabled-user-gated', 'a session from a rotated link survives', 'api/_lib/tenant.js', (s) => s.replace('  if (!u || u.disabled !== false || signedInBefore(req, u.sessions_valid_after)) rejectSession(req);', '  if (!u || u.disabled !== false) rejectSession(req);')],
  ['disabled-user-gated', 'rotation stops ending old sessions', 'api/_lib/tenant.js', (s) => s.replace("jsonInit('PATCH', { entry_hash: hash, sessions_valid_after: now })", "jsonInit('PATCH', { entry_hash: hash })")],
  ['user-one-protected', 'rotation re-issues a cookie for whoever asks, before the user #1 refusal', 'api/auth.js', (s) => s.replace("  if (me.uid === OWNER_UID) return res.status(403)", "  res.setHeader('Set-Cookie', freshSessionCookie(me.uid));\n  if (me.uid === OWNER_UID) return res.status(403)")],
  ['disabled-user-gated', "a disabled user's create is filed under user #1", 'api/_lib/tenant.js', (s) => s.replace("  if (sessionRejected(req)) throw new Refused(403, 'This account is disabled.');\n", '')],
  ['tenant-scoped', 'a new accounts function reads a user table', 'api/_lib/tenant.js', (s) => s + "\nexport async function everyonesPastes() {\n  return rowsOf(await request('mdshare_pastes', 'select=id'));\n}\n"],
  ['tenant-scoped', 'the users table is queried outside the Accounts section', 'api/_lib/tenant.js', (s) => s.replace('export async function pingDb() {\n', "export async function pingDb() {\n  await request(USERS, 'select=id');\n")],
  ['tenant-scoped', 'ACCOUNTS grows without the invariant', 'api/_lib/tenant.js', (s) => s.replace("'setUserDisabled', 'userStats'];", "'setUserDisabled', 'userStats', 'listUsers'];")],
];
for (const [id, label, file, fn] of p3Mutations) {
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

// Security fixes batch 1 (ADV-MU-A/B, 2026-11-27). Each line breaks one rule and must be caught by
// the named check. [id, label, file, mutate, needs public/]
const fix1Mutations = [
  ['user-content-sandboxed', 'GET /api/diagram drops the sandbox headers', 'api/diagram.js', (s) => s.replace('    setUserContentHeaders(res);\n', '')],
  ['user-content-sandboxed', 'the CSP loses sandbox', 'api/_lib/access.js', (s) => s.replace("style-src 'unsafe-inline'; sandbox\";", "style-src 'unsafe-inline'\";")],
  ['user-content-sandboxed', 'the CSP allows inline script', 'api/_lib/access.js', (s) => s.replace("\"default-src 'none'; img-src data:;", "\"default-src 'none'; script-src 'unsafe-inline'; img-src data:;")],
  ['user-content-sandboxed', 'setUserContentHeaders forgets nosniff', 'api/_lib/access.js', (s) => s.replace("  res.setHeader('Content-Security-Policy', USER_CONTENT_CSP);\n  res.setHeader('X-Content-Type-Options', 'nosniff');\n", "  res.setHeader('Content-Security-Policy', USER_CONTENT_CSP);\n")],
  ['user-content-sandboxed', 'raw Markdown drops the sandbox headers', 'api/_lib/raw.js', (s) => s.replace('  setUserContentHeaders(res);\n', '')],
  ['user-content-sandboxed', 'a new route answers image/svg+xml without them', 'api/pin.js', (s) => s + "\nexport function svgOut(res, svg) { res.setHeader('Content-Type', 'image/svg+xml'); return res.send(svg); }\n"],
  ['user-content-sandboxed', 'archify HTML loses its CSP sandbox', 'api/archify-html.js', (s) => s.replace("; sandbox allow-scripts\");", '");')],
  ['user-content-sandboxed', 'archify HTML gets allow-same-origin', 'api/archify-html.js', (s) => s.replace('; sandbox allow-scripts");', '; sandbox allow-scripts allow-same-origin");')],
  ['user-content-sandboxed', 'diagram inserts skip the sanitiser', 'api/_lib/tenant.js', (s) => s.replace('  row = cleanStored(table, row);\n', '')],
  ['user-content-sandboxed', 'diagram patches skip the sanitiser', 'api/_lib/tenant.js', (s) => s.replace('  patch = cleanStored(table, patch);\n', '')],
  ['user-content-sandboxed', 'cleanStored stops sanitising', 'api/_lib/tenant.js', (s) => s.replace('    svg = sanitizeSvg(row.svg);', '    svg = String(row.svg);')],
  ['user-content-sandboxed', 'the sanitiser keeps foreignObject', 'api/_lib/svg-sanitize.js', (s) => s.replace("'script', 'foreignobject', ", "'script', ")],
  ['user-content-sandboxed', 'the sanitiser keeps on* handlers', 'api/_lib/svg-sanitize.js', (s) => s.replace("    if (local.startsWith('on')) continue;\n", '')],
  ['user-content-sandboxed', '/d/:id inlines the raw SVG', 'api/_lib/diagram-page.js', (s) => s.replace('<div class="svg-frame" id="svg-frame" role="img" aria-label="${esc(title)}"></div>', '<div class="svg-frame" id="svg-frame" role="img" aria-label="${esc(title)}">${row.svg}</div>')],
  ['creates-limited', 'diagram creates lose the rate limit', 'api/diagram.js', (s) => s.replace('    if (!rate.allowed) {\n', '    if (false) {\n')],
  ['creates-limited', 'archify checks the rate limit after the insert', 'api/archify.js', (s) => s.replace('    const rate = CREATE_LIMIT.check(clientIp(req));\n', '').replace('    const base = baseUrl(req);\n    return res.status(200).json({ url: `${base}/a/', '    const rate = CREATE_LIMIT.check(clientIp(req)); void rate;\n    const base = baseUrl(req);\n    return res.status(200).json({ url: `${base}/a/')],
  ['creates-limited', 'the diagram limit grows', 'api/diagram.js', (s) => s.replace('rateLimiter({ limit: CREATES_PER_HOUR,', 'rateLimiter({ limit: 5000,')],
  ['creates-limited', 'diagram creates lose the size cap', 'api/diagram.js', (s) => s.replace('if (svg.length > MAX_PASTE_SIZE || ', 'if (')],
  ['creates-limited', 'anonymous archify gets the signed-in ceiling', 'api/archify.js', (s) => s.replace('const maxSize = ownerOf(req, res, agentAuth) ? MAX_ARCHIFY_SIZE : MAX_PASTE_SIZE;', 'const maxSize = MAX_ARCHIFY_SIZE;')],
  ['creates-limited', 'the paste size cap grows', 'api/_lib/content.js', (s) => s.replace('export const MAX_PASTE_SIZE = 100000;', 'export const MAX_PASTE_SIZE = 10000000;')],
  ['creates-limited', 'creatorOf ignores MDSHARE_ANON_CREATE', 'api/_lib/tenant.js', (s) => s.replace("  if (!anonCreateAllowed()) throw new Refused(401, 'Sign up or sign in to create documents.', { extra: ANON_CREATE_OFF });\n", '')],
  ['creates-limited', 'the anonymous-create switch defaults to off', 'api/_lib/tenant.js', (s) => s.replace("process.env.MDSHARE_ANON_CREATE ?? 'on'", "process.env.MDSHARE_ANON_CREATE ?? 'off'")],
  ['creates-limited', 'a Refused answer drops the hint', 'api/_lib/events.js', (s) => s.replace('json({ ...(err.extra || {}), error: err.message,', 'json({ error: err.message,')],
  ['client-ip-one-helper', 'share.js parses x-forwarded-for inline again', 'api/share.js', (s) => s.replace('    const rateCheck = checkRateLimit(clientIp(req));', "    const rateCheck = checkRateLimit(req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown');")],
  ['client-ip-one-helper', 'clientIp() keys on the first hop', 'api/_lib/rate-limit.js', (s) => s.replace(".filter(Boolean).pop() || '';", ".filter(Boolean)[0] || '';")],
  ['client-ip-one-helper', 'clientIp() prefers x-forwarded-for', 'api/_lib/rate-limit.js', (s) => s.replace("lastHop(h['x-vercel-forwarded-for']) || lastHop(h['x-real-ip']) || lastHop(h['x-forwarded-for'])", "lastHop(h['x-forwarded-for']) || lastHop(h['x-vercel-forwarded-for']) || lastHop(h['x-real-ip'])")],
  ['client-ip-one-helper', 'the auth login limiter reads the socket itself', 'api/auth.js', (s) => s.replace('    const rateCheck = checkAuthRateLimit(clientIp(req));', "    const rateCheck = checkAuthRateLimit(req.socket?.remoteAddress || 'unknown');")],
  ['user-content-sandboxed', '/d/:id inserts the SVG without DOMPurify', 'public/assets/app.js', (s) => s.replace('frame.innerHTML = DOMPurify.sanitize(svg, {', 'frame.innerHTML = (svg, {'), true],
];
for (const [id, label, file, fn, withPublic] of fix1Mutations) {
  test(`invariant "${id}" fails when ${label}`, () => {
    const dir = withPublic ? copyWithPublic() : copyRepo();
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
