// POST /api/auth — password login, sets a signed, server-expiring HttpOnly cookie
// GET  /api/auth — check auth status (returns {ok: true/false})
//
// Session token format (v2): "<expEpochSeconds>.<hmacHex>"
//   hmacHex = HMAC-SHA256(HMAC_KEY, "mdshare-session:v2:" + expEpochSeconds + ":" + computeToken(PASSWORD))
// Binding the signature to computeToken(PASSWORD) means rotating MDSHARE_PASSWORD invalidates
// every existing session, same as before. The expiry lives in the token itself (server-verified on
// every request) instead of relying solely on the browser honoring Max-Age.
//
// Legacy transition: cookies issued before this change are a bare hex digest equal to
// computeToken(PASSWORD) (no embedded expiry). Those remain valid — checked with
// timingSafeEqual — only until LEGACY_COOKIE_CUTOFF below. This is a bounded, documented
// grace period, not a perpetual token: after the cutoff every browser must re-authenticate to
// receive a v2 token. Bump the cutoff forward (and note why) if more transition time is needed;
// do not remove it entirely.
//
// Seamless upgrade: checkAuthAndRefresh() (used by every authenticated route instead of a bare
// isAuthenticated() check) silently re-issues a fresh v2 cookie whenever it validates a request
// via the legacy path — so an existing owner session gets upgraded to v2 (full new 180-day
// lifetime) on its very next authenticated request, with no re-login, no visible change, and no
// extra step. In practice this means LEGACY_COOKIE_CUTOFF only matters for a browser that makes
// zero authenticated requests between rollout and the cutoff date; any browser that's used at
// least once during that window is already upgraded before the cutoff ever applies to it.

import { createHmac, timingSafeEqual } from 'crypto';

const PASSWORD = process.env.MDSHARE_PASSWORD;
const HMAC_KEY = process.env.MDSHARE_HMAC_SECRET || process.env.SUPABASE_SERVICE_KEY;
if (!HMAC_KEY) throw new Error('MDSHARE_HMAC_SECRET or SUPABASE_SERVICE_KEY required');
const COOKIE_NAME = 'mdshare_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days in seconds ("six month session")

// Bounded transition window for legacy (pre-v2) cookies. Chosen as ~30 days from the rollout of
// this change (2026-09-22); after this date only v2 signed tokens are accepted.
export const LEGACY_COOKIE_CUTOFF = new Date('2026-10-22T00:00:00Z');

function computeToken(password) {
  return createHmac('sha256', HMAC_KEY).update(password).digest('hex');
}

function safeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
  }
  return cookies;
}

// --- v2 signed, server-expiring session token ---

export function signSessionToken(expSeconds, password = PASSWORD, hmacKey = HMAC_KEY) {
  const sig = createHmac('sha256', hmacKey)
    .update(`mdshare-session:v2:${expSeconds}:${computeToken(password)}`)
    .digest('hex');
  return `${expSeconds}.${sig}`;
}

// Pure, dependency-injectable verifier so tests can pass an explicit "now" instead of mocking
// the system clock. Never throws on malformed input — always returns a boolean.
export function verifySessionToken(cookieValue, nowSeconds, password = PASSWORD, hmacKey = HMAC_KEY) {
  if (typeof cookieValue !== 'string') return false;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return false;
  const expStr = cookieValue.slice(0, dot);
  const sigHex = cookieValue.slice(dot + 1);
  if (!/^\d+$/.test(expStr)) return false;
  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp)) return false;
  if (exp <= nowSeconds) return false; // expired
  if (!password) return false; // no password configured -> fail closed
  const expected = createHmac('sha256', hmacKey)
    .update(`mdshare-session:v2:${expStr}:${computeToken(password)}`)
    .digest('hex');
  return safeHexEqual(sigHex, expected);
}

// Pure legacy verifier: bare hex digest, no embedded expiry. Caller applies the cutoff.
export function verifyLegacyCookie(cookieValue, password = PASSWORD, hmacKey = HMAC_KEY) {
  if (typeof cookieValue !== 'string' || !password) return false;
  const expected = computeToken(password);
  return safeHexEqual(cookieValue, expected);
}

function buildSessionCookieHeader(token) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

export function isAuthenticated(req, now = new Date()) {
  if (!PASSWORD) return false; // no password set -> fail closed
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (verifySessionToken(token, nowSeconds)) return true;

  // Bounded legacy transition — see LEGACY_COOKIE_CUTOFF above.
  if (now < LEGACY_COOKIE_CUTOFF && verifyLegacyCookie(token)) return true;

  return false;
}

// Preferred entry point for every HTTP handler that has a `res` to write to. Identical to
// isAuthenticated(), except that when it validates the request via the legacy-cookie path it
// also transparently sets a fresh v2 Set-Cookie header on `res` (full 180-day lifetime) — the
// "seamless upgrade" described above. Safe to call even when the response has already started
// being built; it only ever *adds* a Set-Cookie header, never removes/blocks anything. `res` is
// optional so this can still be used where only a boolean is needed (e.g. isVisible() call sites
// without a natural `res`), in which case it behaves exactly like isAuthenticated().
export function checkAuthAndRefresh(req, res, now = new Date()) {
  if (!PASSWORD) return false;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (verifySessionToken(token, nowSeconds)) return true;

  if (now < LEGACY_COOKIE_CUTOFF && verifyLegacyCookie(token)) {
    if (res && typeof res.setHeader === 'function') {
      const freshToken = signSessionToken(nowSeconds + COOKIE_MAX_AGE);
      res.setHeader('Set-Cookie', buildSessionCookieHeader(freshToken));
    }
    return true;
  }

  return false;
}

// --- Auth Rate Limiting (5 attempts per IP per 15 min) ---
const authRateLimitMap = new Map();
const AUTH_LIMIT = 5;
const AUTH_WINDOW = 15 * 60 * 1000;

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const entry = authRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    authRateLimitMap.set(ip, { count: 1, resetAt: now + AUTH_WINDOW });
    return { allowed: true, remaining: AUTH_LIMIT - 1 };
  }
  if (entry.count >= AUTH_LIMIT) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }
  entry.count++;
  return { allowed: true, remaining: AUTH_LIMIT - entry.count };
}

const authRateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authRateLimitMap) {
    if (now > entry.resetAt) authRateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);
authRateLimitCleanup.unref?.();

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ok = checkAuthAndRefresh(req, res);
    return res.status(ok ? 200 : 401).json({ ok });
  }

  if (req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const rateCheck = checkAuthRateLimit(ip);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfter));
      return res.status(429).json({ error: 'Too many login attempts. Try again later.', retry_after: rateCheck.retryAfter });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const { password } = body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Missing password' });
    }

    if (!PASSWORD) {
      return res.status(500).json({ error: 'MDSHARE_PASSWORD not configured' });
    }

    if (!safeHexEqual(computeToken(password), computeToken(PASSWORD))) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = signSessionToken(nowSeconds + COOKIE_MAX_AGE, password);
    res.setHeader('Set-Cookie', buildSessionCookieHeader(token));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
