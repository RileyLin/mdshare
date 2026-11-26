// mdshare-cli reading-loop commands: the right request for each, publish checks summarised on
// stderr, --strict fails on problems, the token only ever travels in the Authorization header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MDSHARE_AGENT_TOKEN = 'mds_test_token_value';
const cli = await import('../mcp/bin/mdshare-cli.mjs');

function capture(fn) {
  const out = []; const err = [];
  const o = process.stdout.write; const e = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = o; process.stderr.write = e; }).then(() => ({ out: out.join(''), err: err.join('') }), (x) => { x.out = out.join(''); x.err = err.join(''); throw x; });
}
function mockFetch(reply) {
  const calls = [];
  global.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return { ok: reply.status < 300, status: reply.status, json: async () => reply.body, text: async () => JSON.stringify(reply.body) }; };
  return calls;
}

test('create sends keep/parent/origin and summarises checks on stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const f = join(dir, 'a.md'); writeFileSync(f, '# A\n');
  const calls = mockFetch({ status: 200, body: { id: 'abc', url: 'u', kept: true, checks: { ok: false, warnings: [{ rule: 'unclosed-fence', severity: 'warn', line: 3, message: 'm' }, { rule: 'no-title', severity: 'info', line: 1, message: 'm' }] } } });
  const r = await capture(() => cli.cmdCreate(['paste', f], { keep: true, parent: 'old123', origin: 'agent:main:x' }));
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual([body.keep, body.parent, body.origin], [true, 'old123', 'agent:main:x']);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + 'mds_test_token_value');
  assert.match(r.err, /checks: 1 problem\(s\): line 3 unclosed-fence/);
  assert.doesNotMatch(r.out + r.err, /mds_test_token_value/, 'token never printed');
  await assert.rejects(capture(() => cli.cmdCreate(['paste', f], { strict: true })), /publish checks found problems/);
});

test('feedback, resolve, reads, versions hit /api/doc with the right action', async () => {
  let calls = mockFetch({ status: 200, body: { items: [] } });
  await capture(() => cli.cmdFeedback([], {}));
  assert.match(calls[0].url, /\/api\/doc\?action=feedback&status=open$/);
  calls = mockFetch({ status: 200, body: { items: [] } });
  await capture(() => cli.cmdFeedback(['doc1'], {}));
  assert.match(calls[0].url, /action=feedback&id=doc1$/);
  calls = mockFetch({ status: 200, body: { ok: true, updated: ['fb_1'] } });
  await capture(() => cli.cmdResolve(['fb_1', 'fb_2'], { in: 'new1' }));
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { ids: ['fb_1', 'fb_2'], status: 'resolved', resolved_in: 'new1' });
  calls = mockFetch({ status: 200, body: { items: [] } });
  await capture(() => cli.cmdReads([], { days: 3 }));
  assert.match(calls[0].url, /action=reads&unread=1&days=3$/);
  calls = mockFetch({ status: 200, body: { versions: [] } });
  await capture(() => cli.cmdVersions(['v2'], {}));
  assert.match(calls[0].url, /action=versions&id=v2$/);
  mockFetch({ status: 403, body: { error: 'This token needs the activity:read scope' } });
  await assert.rejects(capture(() => cli.cmdFeedback([], {})), /feedback failed \(403\): This token needs the activity:read scope/);
});

// Tier 2 (2026-11-26): full-text search and read-by-link.
test('search "<text>" calls the full-text action and prints hits; --json prints the response', async () => {
  let calls = mockFetch({ status: 200, body: { q: '缓存命中', results: [{ id: 'abc123', title: 'KV 缓存', snippet: '…提高缓存命中率…', kept: true, is_public: false }], total: 1, next_offset: null } });
  const r = await capture(() => cli.cmdSearch(['缓存命中'], { limit: '5' }));
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/api/doc');
  assert.deepEqual([u.searchParams.get('action'), u.searchParams.get('q'), u.searchParams.get('limit')], ['search', '缓存命中', '5']);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + 'mds_test_token_value');
  assert.match(r.out, /abc123 {2}KV 缓存 {2}⭐/);
  assert.match(r.out, /\/v\/abc123/);
  assert.match(r.out, /…提高缓存命中率…/);
  assert.match(r.out, /1 match$/m);
  calls = mockFetch({ status: 200, body: { results: [], total: 0 } });
  const j = await capture(() => cli.cmdSearch(['a,b(c)*'], { json: true }));
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'a,b(c)*', 'special characters travel intact as one parameter');
  assert.deepEqual(JSON.parse(j.out), { results: [], total: 0 });
  // The old flag form still lists the catalog.
  calls = mockFetch({ status: 200, body: { ok: true, items: [] } });
  await capture(() => cli.cmdSearch([], { q: 'x', kind: 'paste' }));
  assert.match(calls[0].url, /\/api\/pastes\?q=x&kind=paste$/);
  mockFetch({ status: 403, body: { error: 'This token needs the documents:read scope' } });
  await assert.rejects(capture(() => cli.cmdSearch(['x'], {})), /search failed \(403\): This token needs the documents:read scope/);
  assert.doesNotMatch(r.out + r.err + j.out, /mds_test_token_value/, 'token never printed');
});

test('read accepts a full /v/ link on this site and refuses a link on another host', async () => {
  const base = (process.env.MDSHARE_BASE_URL || 'https://mdshare-rileylins-projects.vercel.app').replace(/\/$/, '');
  let calls = mockFetch({ status: 200, body: '# Doc' });
  await capture(() => cli.cmdRead([`${base}/v/AbC_12-x9`], {}));
  assert.equal(calls[0].url, `${base}/api/share?id=AbC_12-x9`);
  calls = mockFetch({ status: 200, body: '# Doc' });
  await capture(() => cli.cmdRead([`${base}/d/dg12345678`], {}));
  assert.equal(calls[0].url, `${base}/api/diagram?id=dg12345678`);
  calls = mockFetch({ status: 200, body: '# Doc' });
  await capture(() => cli.cmdRead(['plainId123'], {}));
  assert.equal(calls[0].url, `${base}/api/share?id=plainId123`, 'a bare id defaults to a document');
  calls = mockFetch({ status: 200, body: '# Doc' });
  await assert.rejects(capture(() => cli.cmdRead(['https://evil.example/v/abc123'], {})), /that link is on https:\/\/evil\.example/);
  assert.equal(calls.length, 0, 'no request (and no token) goes to another host');
  await assert.rejects(capture(() => cli.cmdRead([`${base}/settings`], {})), /not a document link/);
  await assert.rejects(capture(() => cli.cmdRead([`${base}/v/abc123`], { kind: 'diagram' })), /does not match/);
  mockFetch({ status: 404, body: { error: 'Not found or expired', hint: 'Private documents need the owner session or a token with documents:read' } });
  await assert.rejects(capture(() => cli.cmdRead(['abc123'], {})), /read failed \(404\): Not found or expired — Private documents need/);
});
