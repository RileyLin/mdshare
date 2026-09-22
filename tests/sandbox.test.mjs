import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Needed because this file now also does a real dynamic import of archify-html.js (to test
// applyWarmPaperDefault directly), which transitively imports auth.js — that module throws at
// load time if no HMAC key is configured. Matches the convention in auth.test.mjs / etc.
process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const archifyRenderSrc = fs.readFileSync(new URL('../api/archify-render.js', import.meta.url), 'utf8');
const archifyHtmlSrc = fs.readFileSync(new URL('../api/archify-html.js', import.meta.url), 'utf8');

test('archify-render.js embeds the stored archify HTML only via a sandboxed iframe', () => {
  assert.match(archifyRenderSrc, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.match(archifyRenderSrc, /src="\/api\/archify-html\?id=/);
});

test('archify-render.js iframe sandbox never combines allow-scripts with allow-same-origin', () => {
  // Extract every sandbox="..." attribute value in the file and assert none of them contain
  // "allow-same-origin" — that combination would defeat the sandbox by handing the framed
  // (attacker-reachable) archify HTML the real mdshare origin's cookies and API access.
  const sandboxAttrs = [...archifyRenderSrc.matchAll(/sandbox="([^"]*)"/g)].map(m => m[1]);
  assert.ok(sandboxAttrs.length > 0, 'expected at least one sandbox attribute in archify-render.js');
  for (const attr of sandboxAttrs) {
    assert.doesNotMatch(attr, /allow-same-origin/, `sandbox="${attr}" must not include allow-same-origin`);
  }
});

test('archify-render.js no longer inlines the raw archify HTML into the top-level document', () => {
  // The old (pre-privacy) implementation merged the stored HTML directly into the response via a
  // string like `html.replace(/<body\b[^>]*>/...)`. Guard against that pattern coming back.
  assert.doesNotMatch(archifyRenderSrc, /injectMdshareBar/);
});

test('archify-html.js enforces a restrictive CSP with frame-ancestors self', () => {
  assert.match(archifyHtmlSrc, /Content-Security-Policy/);
  assert.match(archifyHtmlSrc, /default-src 'none'/);
  assert.match(archifyHtmlSrc, /frame-ancestors 'self'/);
  assert.match(archifyHtmlSrc, /connect-src 'none'/);
});

test('archify-html.js never renders a password/login form (auth stays on the parent page)', () => {
  assert.doesNotMatch(archifyHtmlSrc, /type="password"/);
});

test('archify-html.js forces the editorial warm-paper preset + light theme before serving stored HTML', () => {
  // Regression guard: the pre-privacy-rollout archify-render.js forced data-preset="editorial"
  // and data-theme="light" on every served archify diagram (mdshare house look). That forcing was
  // dropped when rendering moved into a sandboxed iframe served by this file, and needs to live
  // here instead. Assert the function exists and is actually applied to what gets sent to the
  // client, not just defined and unused.
  assert.match(archifyHtmlSrc, /function applyWarmPaperDefault/);
  assert.match(archifyHtmlSrc, /data-preset="editorial"/);
  assert.match(archifyHtmlSrc, /data-theme="light"/);
  assert.match(archifyHtmlSrc, /res\.send\(applyWarmPaperDefault\(row\.html\)\)/);
});

test('applyWarmPaperDefault forces editorial+light on unpinned HTML and overrides an existing preset, preserving other attributes', async () => {
  const mod = await import('../api/archify-html.js');
  const fn = mod.applyWarmPaperDefault;
  assert.equal(typeof fn, 'function', 'applyWarmPaperDefault must be exported for testability');
  assert.equal(fn('<html lang="en"><body>x</body></html>'), '<html lang="en" data-preset="editorial" data-theme="light"><body>x</body></html>');
  assert.equal(
    fn('<html data-preset="classic" data-theme="dark"><body>x</body></html>'),
    '<html data-preset="editorial" data-theme="dark"><body>x</body></html>'
  );
});
