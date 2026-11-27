// ADV-MU-B 1 (2026-11-27): every per-IP limit was keyed on the FIRST x-forwarded-for hop, which is
// whatever the client wrote. clientIp() now prefers x-vercel-forwarded-for, then x-real-ip, then the
// LAST x-forwarded-for hop (the one our nearest proxy appended), then the socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
const { clientIp } = await import('../api/_lib/rate-limit.js');
const { default: auth } = await import('../api/auth.js');
test.after(() => db.close());

test('clientIp: x-vercel-forwarded-for, then x-real-ip, then the last x-forwarded-for hop, then the socket', () => {
  const sock = { remoteAddress: '10.0.0.9' };
  assert.equal(clientIp({ headers: { 'x-vercel-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '1.1.1.1, 198.51.100.3' }, socket: sock }), '198.51.100.1');
  assert.equal(clientIp({ headers: { 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '1.1.1.1, 198.51.100.3' }, socket: sock }), '198.51.100.2');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 198.51.100.3' }, socket: sock }), '198.51.100.3');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.4' }, socket: sock }), '198.51.100.4');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': ' , ' }, socket: sock }), '10.0.0.9');
  assert.equal(clientIp({ headers: {}, socket: sock }), '10.0.0.9');
  assert.equal(clientIp({ headers: {} }), 'unknown');
  assert.ok(clientIp({ headers: { 'x-real-ip': 'x'.repeat(500) } }).length <= 64);
});

// Same transport-level client (socket + the hop our proxy appended), a different forged first hop on
// every request: the limits must still count it as one client.
const forged = (i) => ({ 'x-forwarded-for': `203.0.113.${i}, 198.51.100.77`, host: '127.0.0.1:3000' });

test('sign-up: 5 an hour per client even when each request forges a new first x-forwarded-for hop', async () => {
  db.sb.reset();
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const res = responseRecorder();
    await auth({ method: 'POST', query: { action: 'signup' }, body: {}, headers: forged(i), socket: { remoteAddress: '10.0.0.5' } }, res);
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
});

test('owner password login: 5 tries per 15 min per client even with forged first hops', async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const res = responseRecorder();
    await auth({ method: 'POST', query: {}, body: { password: 'wrong' }, headers: { ...forged(100 + i), 'x-forwarded-for': `203.0.113.${100 + i}, 198.51.100.88` }, socket: { remoteAddress: '10.0.0.6' } }, res);
    codes.push(res.statusCode);
  }
  assert.equal(codes[5], 429, `got ${codes.join(',')}`);
});
