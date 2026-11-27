// ADV-MU-A F1 (2026-11-27): user SVG/HTML served raw on the main origin must not run script there.
// GET /api/diagram (and the other raw user-content routes) send a sandbox CSP + nosniff, and the SVG
// is sanitised when it is stored. Markers are benign strings ('MARKER'), never real payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, userCookie } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
const { default: diagram } = await import('../api/diagram.js');
const { default: archifyHtml } = await import('../api/archify-html.js');
const { default: archify } = await import('../api/archify.js');
const { default: share } = await import('../api/share.js');
test.after(() => db.close());

const SANDBOX_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
let ipN = 0;
const call = async (h, req) => {
  const res = responseRecorder();
  ipN += 1;
  await h({ headers: {}, query: {}, socket: { remoteAddress: `192.0.2.${ipN % 250}` }, ...req }, res);
  return res;
};

const ACTIVE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" onload="MARKER()">',
  '<script>MARKER</script>',
  '<rect width="10" height="10" onclick="MARKER()" fill="red"/>',
  '<foreignObject width="10" height="10"><div>MARKER-FO</div></foreignObject>',
  '<a href="javascript:MARKER()"><text>link</text></a>',
  '<a xlink:href="data:text/html,MARKER"><text>link2</text></a>',
  '<a href="java&#x09;script:MARKER()"><text>link3</text></a>',
  '<animate attributeName="href" to="javascript:MARKER()"/>',
  '<set attributeName="onmouseover" to="MARKER()"/>',
  '<text x="1" y="2">keep me &amp; this</text>',
  '</svg>',
].join('');

test('GET /api/diagram serves the stored SVG with a sandbox CSP and nosniff', async () => {
  db.sb.reset();
  db.sb.seed('mdshare_diagrams', { id: 'svgRaw0001', owner_id: 1, svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>MARKER</script></svg>', title: 't', expires_at: '2099-01-01T00:00:00Z', is_public: true });
  const r = await call(diagram, { method: 'GET', query: { id: 'svgRaw0001' }, headers: { cookie: await userCookie(1) } });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /image\/svg\+xml/);
  assert.equal(r.headers['content-security-policy'], SANDBOX_CSP);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('a created SVG is stored without script, handlers, foreignObject or javascript:/data:text/html links', async () => {
  db.sb.reset();
  const c = await call(diagram, { method: 'POST', body: { svg: ACTIVE_SVG, title: 'x' } });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  const stored = db.sb.tables.mdshare_diagrams.find((d) => d.id === c.body.id).svg;
  assert.doesNotMatch(stored, /<script/i);
  assert.doesNotMatch(stored, /\son\w+=/i);
  assert.doesNotMatch(stored, /foreignObject|MARKER-FO/i);
  assert.doesNotMatch(stored, /javascript:|java\s*script|data:text\/html/i);
  assert.doesNotMatch(stored, /<animate|<set/i);
  assert.match(stored, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg">/);
  assert.match(stored, /<rect width="10" height="10" fill="red"\/>/);
  assert.match(stored, /<text x="1" y="2">keep me &amp; this<\/text>/);
});

test('an SVG that is nothing but active content is refused, not stored', async () => {
  db.sb.reset();
  const c = await call(diagram, { method: 'POST', body: { svg: '<?xml version="1.0"?><script>MARKER</script>' } });
  assert.equal(c.statusCode, 400);
  assert.equal(db.sb.tables.mdshare_diagrams.length, 0);
});

test('a PATCH of a diagram svg through the tenant layer is sanitised too', async () => {
  db.sb.reset();
  db.sb.seed('mdshare_diagrams', { id: 'svgPatch01', owner_id: 1, svg: '<svg></svg>', title: 't', expires_at: '2099-01-01T00:00:00Z' });
  const { patchOwned } = await import('../api/_lib/tenant.js');
  const { asUser } = await import('./_fakedb.mjs');
  const r = await patchOwned('mdshare_diagrams', await asUser(1), 'id=eq.svgPatch01', { svg: ACTIVE_SVG });
  assert.equal(r.ok, true);
  const stored = db.sb.tables.mdshare_diagrams[0].svg;
  assert.doesNotMatch(stored, /<script|onload|foreignObject|javascript:/i);
});

test('raw archify HTML keeps its scripts but is sandboxed (opaque origin) even when opened directly', async () => {
  db.sb.reset();
  db.sb.seed('mdshare_archify', { id: 'arcRaw0001', owner_id: 1, kind: 'architecture', html: '<html><body><svg></svg><script>MARKER</script></body></html>', title: 't', expires_at: '2099-01-01T00:00:00Z', is_public: true });
  const r = await call(archifyHtml, { method: 'GET', query: { id: 'arcRaw0001' } });
  assert.equal(r.statusCode, 200);
  const csp = r.headers['content-security-policy'];
  assert.match(csp, /(^|;)\s*sandbox allow-scripts\s*(;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('raw Markdown and archify IR responses carry the sandbox CSP too', async () => {
  db.sb.reset();
  db.sb.seed('mdshare_pastes', { id: 'mdRaw00001', owner_id: 1, content: '<script>MARKER</script>', expires_at: '2099-01-01T00:00:00Z', is_public: true });
  db.sb.seed('mdshare_archify', { id: 'arcIr00001', owner_id: 1, kind: 'architecture', html: '<svg></svg>', ir: { meta: { title: 'MARKER' } }, title: 't', expires_at: '2099-01-01T00:00:00Z', is_public: true });
  const raw = await call(share, { method: 'GET', query: { id: 'mdRaw00001' } });
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.headers['content-security-policy'], SANDBOX_CSP);
  const ir = await call(archify, { method: 'GET', query: { id: 'arcIr00001' } });
  assert.equal(ir.statusCode, 200);
  assert.equal(ir.headers['content-security-policy'], SANDBOX_CSP);
});

test('sanitizeSvg: unit cases', async () => {
  const { sanitizeSvg, safeSvgUrl } = await import('../api/_lib/svg-sanitize.js');
  assert.equal(sanitizeSvg('<svg><!-- MARKER --><g/></svg>'), '<svg><g/></svg>');
  assert.equal(sanitizeSvg('<svg><use href="#a"/><use href="other.svg#a"/></svg>'), '<svg><use href="#a"/><use/></svg>');
  assert.equal(sanitizeSvg('<!DOCTYPE svg [<!ENTITY m "MARKER">]><svg>&m;</svg>').startsWith('<svg>'), true);
  assert.equal(sanitizeSvg('<?xml-stylesheet href="x.xsl"?><svg/>'), '<svg/>');
  assert.equal(sanitizeSvg('<svg><style>.a{fill:red}</style></svg>'), '<svg><style>.a{fill:red}</style></svg>');
  assert.doesNotMatch(sanitizeSvg('<svg><style>@import url(x.css);</style></svg>'), /@import/);
  assert.equal(sanitizeSvg('<svg><text>1 < 2</text></svg>'), '<svg><text>1 &lt; 2</text></svg>');
  assert.equal(sanitizeSvg('<svg><g>'), '<svg><g></g></svg>');
  assert.equal(safeSvgUrl('https://example.com/a.png'), true);
  assert.equal(safeSvgUrl('data:image/png;base64,AAAA'), true);
  assert.equal(safeSvgUrl('data:image/svg+xml,<svg/>'), false);
  assert.equal(safeSvgUrl(' JaVaScRiPt:MARKER'), false);
  assert.equal(safeSvgUrl('vbscript:MARKER'), false);
  // Built to make every '<' scan to the end: refused quickly instead of a quadratic scan.
  const t = Date.now();
  assert.throws(() => sanitizeSvg('<a "'.repeat(30000)), /too complex/);
  assert.ok(Date.now() - t < 2000);
});
