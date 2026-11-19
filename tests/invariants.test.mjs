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
};

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
