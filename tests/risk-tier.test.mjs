import test from 'node:test';
import assert from 'node:assert/strict';
const { classify } = await import('../scripts/risk-tier.mjs');
const f = (path, added = 1, deleted = 0) => ({ path, added, deleted });

test('UI, renderer, docs and added tests ship automatically', () => {
  const r = classify([f('public/assets/render.js', 20, 5), f('public/assets/mdshare.css', 3, 3), f('api/render.js', 4, 2), f('CLAUDE.md', 1, 1), f('e2e/run.mjs', 30, 0), f('tests/new.test.mjs', 40, 0), f('e2e/proof/x.png', 0, 9)]);
  assert.equal(r.tier, 'auto');
  assert.deepEqual(r.reasons, []);
});

test('privacy, auth, routes, deps, schema and the pipeline need the owner', () => {
  for (const p of ['api/auth.js', 'api/_lib/access.js', 'api/_lib/agent-tokens.js', 'api/pin.js', 'api/archify-render.js', 'vercel.json', 'package.json', 'package-lock.json', 'migrations/009_x.sql', '.github/workflows/ci.yml', 'scripts/risk-tier.mjs', 'scripts/check-invariants.mjs', 'eslint.config.js', 'api/health.js']) {
    const r = classify([f(p)]);
    assert.equal(r.tier, 'owner', p);
    assert.match(r.reasons[0], new RegExp(`^${p.replace(/[.]/g, '\\.')}: `));
  }
});

test('path tricks, new server files and deletions need the owner (adversarial review findings)', () => {
  for (const p of ['./api/auth.js', 'api/../api/auth.js', 'api//auth.js', '././scripts/risk-tier.mjs']) assert.equal(classify([f(p)]).tier, 'owner', p);
  assert.equal(classify([{ path: 'api/_lib/new-helper.js', added: 10, deleted: 0, status: 'A' }]).tier, 'owner');
  assert.equal(classify([{ path: 'api/render.js', added: 3, deleted: 1, status: 'M' }]).tier, 'auto');
  assert.equal(classify([{ path: 'e2e/old-feature.mjs', added: 0, deleted: 0, status: 'D' }]).tier, 'owner');
});

test('a sensitive file renamed to an innocent path is still owner tier (git diff --no-renames)', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { changedFiles } = await import('../scripts/risk-tier.mjs');
  const d = mkdtempSync(join(tmpdir(), 'tier-'));
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(d, 'api'));
  writeFileSync(join(d, 'api', 'auth.js'), 'export const x = 1;\n'.repeat(20));
  git('add', '.'); git('commit', '-q', '-m', 'base');
  mkdirSync(join(d, 'lib')); git('mv', 'api/auth.js', 'lib/helper.js'); git('commit', '-q', '-m', 'rename');
  const cwd = process.cwd(); process.chdir(d);
  try {
    const files = changedFiles('HEAD~1', 'HEAD');
    assert.deepEqual(files.map((x) => `${x.status} ${x.path}`).sort(), ['A lib/helper.js', 'D api/auth.js']);
    assert.equal(classify(files).tier, 'owner');
  } finally { process.chdir(cwd); }
});

test('removing or rewriting test lines needs the owner, even in a UI change', () => {
  const r = classify([f('public/assets/app.js', 10, 2), f('e2e/run.mjs', 3, 1)]);
  assert.equal(r.tier, 'owner');
  assert.deepEqual(r.reasons, ['e2e/run.mjs: removes or rewrites 1 line(s) of tests']);
  assert.equal(classify([f('tests/visibility.test.mjs', 0, 5)]).tier, 'owner');
});
