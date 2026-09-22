import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
