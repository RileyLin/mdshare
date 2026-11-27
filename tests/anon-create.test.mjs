// ADV-MU-B 4 (2026-11-27): anonymous diagram/archify creates had no rate limit and no size cap, and
// every one is filed under user #1. Now: 50 creates per IP an hour and the paste size cap on all
// three create routes, and MDSHARE_ANON_CREATE=off turns every anonymous create into a 401 + hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, userCookie } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
const { default: diagram } = await import('../api/diagram.js');
const { default: archify } = await import('../api/archify.js');
const { default: share } = await import('../api/share.js');
const { sha256Hex } = await import('../api/_lib/agent-tokens.js');
test.after(() => db.close());

const call = async (h, ip, req) => {
  const res = responseRecorder();
  await h({ method: 'POST', headers: {}, query: {}, socket: { remoteAddress: ip }, ...req }, res);
  return res;
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const ARCH = (pad = 0) => ({ kind: 'architecture', html: `<html><body><svg></svg>${'x'.repeat(pad)}</body></html>`, title: 'a' });

const RAW_B = `mds_${'b'.repeat(40)}`;
function seedUserB() {
  db.sb.seed('mdshare_users', { id: 2, label: 'B', disabled: false, quota_docs_per_day: null, quota_bytes: null });
  db.sb.seed('mdshare_agent_tokens', { id: 'tok_B', owner_id: 2, name: 'b', token_hash: sha256Hex(RAW_B), scopes: ['documents:read', 'documents:write', 'documents:publish'] });
  return { authorization: `Bearer ${RAW_B}` };
}

test('anonymous diagram creates: 50 per IP an hour, then 429 with Retry-After', async () => {
  db.sb.reset();
  const ip = '198.51.100.10';
  for (let i = 0; i < 50; i++) assert.equal((await call(diagram, ip, { body: { svg: SVG } })).statusCode, 200, `create ${i + 1}`);
  const r = await call(diagram, ip, { body: { svg: SVG } });
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.equal(db.sb.tables.mdshare_diagrams.length, 50);
  assert.equal((await call(diagram, '198.51.100.11', { body: { svg: SVG } })).statusCode, 200, 'another network is not affected');
});

test('anonymous archify creates: 50 per IP an hour, then 429', async () => {
  db.sb.reset();
  const ip = '198.51.100.20';
  for (let i = 0; i < 50; i++) assert.equal((await call(archify, ip, { body: ARCH() })).statusCode, 200, `create ${i + 1}`);
  assert.equal((await call(archify, ip, { body: ARCH() })).statusCode, 429);
});

test('diagram size cap matches a paste: over 100 KB of SVG or Markdown is a 413, nothing stored', async () => {
  db.sb.reset();
  const big = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'A'.repeat(100001)}</text></svg>`;
  assert.equal((await call(diagram, '198.51.100.30', { body: { svg: big } })).statusCode, 413);
  assert.equal((await call(diagram, '198.51.100.30', { body: { svg: SVG, markdown: 'm'.repeat(100001) } })).statusCode, 413);
  assert.equal(db.sb.tables.mdshare_diagrams.length, 0);
});

test('anonymous archify over 100 KB is a 413; a signed-in 600 KB archify (as the owner publishes today) still works', async () => {
  db.sb.reset();
  assert.equal((await call(archify, '198.51.100.40', { body: ARCH(100001) })).statusCode, 413);
  assert.equal(db.sb.tables.mdshare_archify.length, 0);
  const owner = await call(archify, '198.51.100.41', { headers: { cookie: await userCookie(1) }, body: ARCH(600000) });
  assert.equal(owner.statusCode, 200, JSON.stringify(owner.body));
  assert.equal((await call(archify, '198.51.100.41', { headers: { cookie: await userCookie(1) }, body: ARCH(2000001) })).statusCode, 413);
});

test('MDSHARE_ANON_CREATE unset or "on": anonymous creates work as before', async () => {
  db.sb.reset();
  for (const v of [undefined, 'on']) {
    if (v === undefined) delete process.env.MDSHARE_ANON_CREATE; else process.env.MDSHARE_ANON_CREATE = v;
    assert.equal((await call(share, '198.51.100.50', { body: { markdown: '# hi' } })).statusCode, 200);
    assert.equal((await call(diagram, '198.51.100.50', { body: { svg: SVG } })).statusCode, 200);
    assert.equal((await call(archify, '198.51.100.50', { body: ARCH() })).statusCode, 200);
  }
  delete process.env.MDSHARE_ANON_CREATE;
});

test('MDSHARE_ANON_CREATE=off: every anonymous create is a 401 with a sign-up hint; tokens and sessions still create', async () => {
  db.sb.reset();
  const auth = seedUserB();
  process.env.MDSHARE_ANON_CREATE = 'off';
  try {
    for (const [h, body] of [[share, { markdown: '# hi' }], [diagram, { svg: SVG }], [archify, ARCH()]]) {
      const r = await call(h, '198.51.100.60', { body });
      assert.equal(r.statusCode, 401, JSON.stringify(r.body));
      assert.match(r.body.hint, /sign up/i);
      assert.equal(r.body.signup, '/api/auth?action=signup');
      assert.equal((await call(h, '198.51.100.61', { headers: auth, body })).statusCode, 200, 'a token still creates');
      assert.equal((await call(h, '198.51.100.62', { headers: { cookie: await userCookie(1) }, body })).statusCode, 200, 'the owner session still creates');
    }
    const anonRows = ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify'].flatMap((t) => db.sb.tables[t]).filter((r) => r.owner_id === 1 && !r.created_by_token);
    assert.equal(anonRows.length, 3, 'only the three owner-session rows are filed under user #1');
  } finally {
    delete process.env.MDSHARE_ANON_CREATE;
  }
});
