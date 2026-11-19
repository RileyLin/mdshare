// Monitoring contracts: /api/health liveness + commit, key-gated event summary, client error
// intake (privacy + limits), and withErrors() recording server errors.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.MDSHARE_MONITOR_KEY = 'monitor-key-for-tests-0123456789';

const { default: health } = await import('../api/health.js');
const { withErrors } = await import('../api/_lib/events.js');

function rec() {
  return { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    json(v) { this.body = v; this.headersSent = true; return this; }, send(v) { this.body = v; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
}
const original = global.fetch;
const restore = () => { global.fetch = original; };

test('GET /api/health reports ok + commit when the database answers, 503 when it does not', async () => {
  global.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    const r = rec(); await health({ method: 'GET', query: {}, headers: {} }, r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.equal(r.body.commit, 'local'); assert.equal(r.headers['cache-control'], 'no-store');
    global.fetch = async () => ({ ok: false, status: 500 });
    const r2 = rec(); await health({ method: 'GET', query: {}, headers: {} }, r2);
    assert.equal(r2.statusCode, 503); assert.equal(r2.body.ok, false);
  } finally { restore(); }
});

test('GET /api/health?events=1 is hidden (404) without the monitor key and summarises with it', async () => {
  let asked = null;
  global.fetch = async (url) => { asked = String(url); return { ok: true, json: async () => [
    { kind: 'client_error', message: 'TypeError: x', created_at: '2026-11-19T00:00:00Z' },
    { kind: 'client_error', message: 'TypeError: x', created_at: '2026-11-19T00:00:01Z' },
    { kind: 'server_error', message: 'render: boom', created_at: '2026-11-19T00:00:02Z' }] }; };
  try {
    const no = rec(); await health({ method: 'GET', query: { events: '1' }, headers: {} }, no);
    assert.equal(no.statusCode, 404); assert.equal(asked, null, 'no database read without the key');
    const bad = rec(); await health({ method: 'GET', query: { events: '1' }, headers: { 'x-monitor-key': 'wrong-key-wrong-key-wrong-key-00' } }, bad);
    assert.equal(bad.statusCode, 404);
    const ok = rec(); await health({ method: 'GET', query: { events: '1', since: '30' }, headers: { 'x-monitor-key': process.env.MDSHARE_MONITOR_KEY } }, ok);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body.counts, { client_error: 2, server_error: 1 });
    assert.deepEqual(ok.body.top[0], { n: 2, m: 'client_error: TypeError: x' });
    assert.match(asked, /mdshare_events\?select=.*created_at=gte\./);
  } finally { restore(); }
});

test('POST /api/health stores client errors without query strings, rejects junk, caps size and rate', async () => {
  const stored = [];
  global.fetch = async (url, o) => { stored.push(JSON.parse(o.body)); return { ok: true }; };
  try {
    const r = rec();
    await health({ method: 'POST', headers: { 'x-forwarded-for': '10.1.1.1' }, body: { type: 'client_error', message: 'TypeError: a is null', source: 'https://x/assets/app.js?v=1', line: 10, col: 3, page: '/v/abc?token=secret#frag' } }, r);
    assert.equal(r.statusCode, 204);
    assert.equal(stored[0].kind, 'client_error');
    assert.equal(stored[0].detail.page, '/v/:id', 'document ids are never stored');
    assert.equal(stored[0].detail.source, '/assets/app.js');
    assert.doesNotMatch(JSON.stringify(stored[0]), /secret/);
    const junk = rec(); await health({ method: 'POST', headers: { 'x-forwarded-for': '10.1.1.2' }, body: { type: 'other' } }, junk);
    assert.equal(junk.statusCode, 400);
    const big = rec(); await health({ method: 'POST', headers: { 'x-forwarded-for': '10.1.1.3' }, body: { type: 'client_error', message: 'x'.repeat(5000) } }, big);
    assert.equal(big.statusCode, 413);
    let last;
    for (let i = 0; i < 31; i++) { last = rec(); await health({ method: 'POST', headers: { 'x-forwarded-for': '10.1.1.4' }, body: { type: 'client_error', message: 'm' } }, last); }
    assert.equal(last.statusCode, 429, 'more than 30 reports per 10 minutes from one address are refused');
  } finally { restore(); }
});

test('withErrors records an uncaught exception as server_error and answers 500', async () => {
  const stored = [];
  global.fetch = async (url, o) => { stored.push({ url: String(url), body: JSON.parse(o.body) }); return { ok: true }; };
  const origErr = console.error; console.error = () => {};
  try {
    const h = withErrors('render', async () => { throw new Error('boom'); });
    const r = rec(); await h({ method: 'GET' }, r);
    assert.equal(r.statusCode, 500); assert.deepEqual(r.body, { error: 'Internal error' });
    assert.match(stored[0].url, /mdshare_events$/);
    assert.equal(stored[0].body.kind, 'server_error');
    assert.equal(stored[0].body.message, 'render: boom');
    global.fetch = async () => { throw new Error('db down'); };
    const r2 = rec(); await withErrors('x', async () => { throw new Error('again'); })({}, r2);
    assert.equal(r2.statusCode, 500, 'still answers when the event log itself is down');
  } finally { restore(); console.error = origErr; }
});
