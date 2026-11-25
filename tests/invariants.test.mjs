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
};

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
