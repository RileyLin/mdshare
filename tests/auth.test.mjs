import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const {
  default: authHandler,
  isAuthenticated,
  signSessionToken,
  verifySessionToken,
  verifyLegacyCookie,
  LEGACY_COOKIE_CUTOFF,
} = await import('../api/auth.js');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; },
  };
}

function reqWithCookie(cookieValue) {
  return { headers: { cookie: cookieValue ? `mdshare_auth=${encodeURIComponent(cookieValue)}` : '' } };
}

// --- signed v2 token ---

test('valid, unexpired session token authenticates', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signSessionToken(now + 1000);
  assert.equal(verifySessionToken(token, now), true);
});

test('expired session token is rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signSessionToken(now - 10); // already expired
  assert.equal(verifySessionToken(token, now), false);
});

test('tampered signature is rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signSessionToken(now + 1000);
  const [exp, sig] = token.split('.');
  const flippedChar = sig[0] === 'a' ? 'b' : 'a';
  const tampered = `${exp}.${flippedChar}${sig.slice(1)}`;
  assert.equal(verifySessionToken(tampered, now), false);
});

test('password rotation invalidates existing session tokens', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signSessionToken(now + 1000, 'test-password');
  assert.equal(verifySessionToken(token, now, 'a-different-password'), false);
});

test('malformed cookie values never throw and are treated as unauthenticated', () => {
  const now = Math.floor(Date.now() / 1000);
  const malformed = [
    '',
    'no-dot-at-all',
    '.',
    'notanumber.abc123',
    '123.', // empty signature
    '123.not-hex!!',
    `${now + 1000}.` + 'a'.repeat(10), // wrong-length signature
    null,
    undefined,
    {},
  ];
  for (const value of malformed) {
    assert.doesNotThrow(() => verifySessionToken(value, now));
    assert.equal(verifySessionToken(value, now), false, `expected false for ${JSON.stringify(value)}`);
  }
});

test('isAuthenticated is false with no cookie, no password, or garbage cookie', () => {
  assert.equal(isAuthenticated(reqWithCookie(undefined)), false);
  assert.equal(isAuthenticated(reqWithCookie('garbage')), false);
  assert.equal(isAuthenticated({ headers: {} }), false);
});

test('isAuthenticated accepts a freshly issued v2 cookie end-to-end via POST /api/auth', async () => {
  const req = { method: 'POST', body: { password: 'test-password' }, headers: {}, socket: { remoteAddress: '10.0.0.1' } };
  const res = responseRecorder();
  await authHandler(req, res);
  assert.equal(res.statusCode, 200);
  const cookieHeader = res.headers['set-cookie'];
  assert.match(cookieHeader, /Max-Age=15552000/); // 180 days
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /Secure/);
  assert.match(cookieHeader, /SameSite=Lax/);
  const cookieValue = cookieHeader.split(';')[0];
  assert.equal(isAuthenticated({ headers: { cookie: cookieValue } }), true);
});

// --- legacy cookie bounded transition ---

test('legacy (pre-v2) cookie format verifies against the password with verifyLegacyCookie', () => {
  const legacyToken = legacyTokenFor('test-password');
  assert.equal(verifyLegacyCookie(legacyToken, 'test-password'), true);
  assert.equal(verifyLegacyCookie(legacyToken, 'wrong-password'), false);
  assert.equal(verifyLegacyCookie('not-the-right-value', 'test-password'), false);
  assert.equal(verifyLegacyCookie(null, 'test-password'), false);
});

test('LEGACY_COOKIE_CUTOFF is a real future-bounded Date, not perpetual', () => {
  assert.ok(LEGACY_COOKIE_CUTOFF instanceof Date);
  assert.ok(!Number.isNaN(LEGACY_COOKIE_CUTOFF.getTime()));
  // Bounded: some year, not "no expiry" (e.g. not more than 2 years out from rollout).
  const twoYearsOut = new Date('2028-09-22T00:00:00Z');
  assert.ok(LEGACY_COOKIE_CUTOFF < twoYearsOut, 'legacy transition must be bounded, not perpetual');
});

test('isAuthenticated accepts a legacy cookie before the cutoff and rejects it after', () => {
  const legacyToken = legacyTokenFor('test-password');
  const req = reqWithCookie(legacyToken);
  const beforeCutoff = new Date(LEGACY_COOKIE_CUTOFF.getTime() - 1000);
  const afterCutoff = new Date(LEGACY_COOKIE_CUTOFF.getTime() + 1000);
  assert.equal(isAuthenticated(req, beforeCutoff), true);
  assert.equal(isAuthenticated(req, afterCutoff), false);
});

// Reproduces the legacy cookie value the pre-rollout code used to issue:
// computeToken(password) = HMAC-SHA256(HMAC_KEY, password) hex, with HMAC_KEY falling back to
// MDSHARE_HMAC_SECRET here (same secret auth.js resolves internally).
function legacyTokenFor(password) {
  return createHmac('sha256', process.env.MDSHARE_HMAC_SECRET).update(password).digest('hex');
}
