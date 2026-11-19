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

test('removing or rewriting test lines needs the owner, even in a UI change', () => {
  const r = classify([f('public/assets/app.js', 10, 2), f('e2e/run.mjs', 3, 1)]);
  assert.equal(r.tier, 'owner');
  assert.deepEqual(r.reasons, ['e2e/run.mjs: removes or rewrites 1 line(s) of tests']);
  assert.equal(classify([f('tests/visibility.test.mjs', 0, 5)]).tier, 'owner');
});
