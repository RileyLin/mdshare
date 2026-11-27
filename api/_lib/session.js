// Signed session cookies: who a browser is. Moved out of api/auth.js (2026-11-27, multi-user P1) so
// api/_lib/tenant.js can read the session without an import cycle; api/auth.js re-exports every
// name here, so older imports keep working. Underscore directory: not a Vercel function.
//
// Session token formats (all HMAC-SHA256 with HMAC_KEY, all bound to computeToken(PASSWORD), so
// rotating MDSHARE_PASSWORD still invalidates every session):
//   v3  "v3.<uid>.<expEpochSeconds>.<hmacHex>"   (current; multi-user)
//       hmacHex = HMAC(HMAC_KEY, "mdshare-session:v3:" + uid + ":" + exp + ":" + computeToken(PASSWORD))
//   v2  "<expEpochSeconds>.<hmacHex>"            (single-owner era; still valid, means user #1)
//       hmacHex = HMAC(HMAC_KEY, "mdshare-session:v2:" + exp + ":" + computeToken(PASSWORD))
//   legacy  bare computeToken(PASSWORD) hex, accepted only before LEGACY_COOKIE_CUTOFF (user #1).
// The expiry lives in the token itself and is checked on every request.
import { createHmac, timingSafeEqual } from 'crypto';

const PASSWORD = process.env.MDSHARE_PASSWORD;
const HMAC_KEY = process.env.MDSHARE_HMAC_SECRET || process.env.SUPABASE_SERVICE_KEY;
if (!HMAC_KEY) throw new Error('MDSHARE_HMAC_SECRET or SUPABASE_SERVICE_KEY required');
export const COOKIE_NAME = 'mdshare_auth';
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days in seconds ("six month session")
// The owner's password login and every pre-multi-user cookie belong to user #1 (migration 013).
export const OWNER_UID = 1;

// Bounded transition window for legacy (pre-v2) cookies (rollout 2026-09-22 + ~30 days).
export const LEGACY_COOKIE_CUTOFF = new Date('2026-10-22T00:00:00Z');

export function computeToken(password) {
  return createHmac('sha256', HMAC_KEY).update(password).digest('hex');
}

export function safeHexEqual(a, b) {
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
    if (!k) continue;
    try { cookies[k.trim()] = decodeURIComponent(v.join('=').trim()); } catch { /* a malformed cookie is no cookie */ }
  }
  return cookies;
}

const isUid = (n) => Number.isSafeInteger(n) && n > 0;

// --- v2 (single owner) ---
export function signSessionToken(expSeconds, password = PASSWORD, hmacKey = HMAC_KEY) {
  const sig = createHmac('sha256', hmacKey)
    .update(`mdshare-session:v2:${expSeconds}:${computeToken(password)}`)
    .digest('hex');
  return `${expSeconds}.${sig}`;
}

// Pure, dependency-injectable verifier. Never throws; always a boolean.
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

// --- v3 (multi-user): the user id is part of the signed string ---
export function signUserSession(uid, expSeconds, password = PASSWORD, hmacKey = HMAC_KEY) {
  if (!isUid(uid)) throw new Error('signUserSession: uid must be a positive integer');
  const sig = createHmac('sha256', hmacKey)
    .update(`mdshare-session:v3:${uid}:${expSeconds}:${computeToken(password)}`)
    .digest('hex');
  return `v3.${uid}.${expSeconds}.${sig}`;
}

// The user id of a valid, unexpired v3 token, else null. Never throws.
export function verifyUserSession(cookieValue, nowSeconds, password = PASSWORD, hmacKey = HMAC_KEY) {
  if (typeof cookieValue !== 'string' || !password) return null;
  const m = /^v3\.([1-9]\d{0,15})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(cookieValue);
  if (!m) return null;
  const uid = Number(m[1]);
  const exp = Number(m[2]);
  if (!isUid(uid) || !Number.isSafeInteger(exp) || exp <= nowSeconds) return null;
  const expected = createHmac('sha256', hmacKey)
    .update(`mdshare-session:v3:${m[1]}:${m[2]}:${computeToken(password)}`)
    .digest('hex');
  return safeHexEqual(m[3], expected) ? uid : null;
}

// Pure legacy verifier: bare hex digest, no embedded expiry. Caller applies the cutoff.
export function verifyLegacyCookie(cookieValue, password = PASSWORD, hmacKey = HMAC_KEY) {
  if (typeof cookieValue !== 'string' || !password) return false;
  void hmacKey;
  const expected = computeToken(password);
  return safeHexEqual(cookieValue, expected);
}

export function buildSessionCookieHeader(token) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

// A fresh cookie for `uid` (password login, legacy upgrade).
export function freshSessionCookie(uid, nowSeconds = Math.floor(Date.now() / 1000)) {
  return buildSessionCookieHeader(signUserSession(uid, nowSeconds + COOKIE_MAX_AGE));
}

// The signed-in user's id, or null. A legacy cookie (before the cutoff) is user #1 and, when `res`
// is given, is silently re-issued as a fresh v2 cookie (also user #1) on this same response.
export function sessionUid(req, res, now = new Date()) {
  if (!PASSWORD) return null; // no password set -> fail closed
  const token = parseCookies(req && req.headers && req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const uid = verifyUserSession(token, nowSeconds);
  if (uid) return uid;
  if (verifySessionToken(token, nowSeconds)) return OWNER_UID;
  if (now < LEGACY_COOKIE_CUTOFF && verifyLegacyCookie(token)) {
    if (res && typeof res.setHeader === 'function') res.setHeader('Set-Cookie', buildSessionCookieHeader(signSessionToken(nowSeconds + COOKIE_MAX_AGE)));
    return OWNER_UID;
  }
  return null;
}

// "Is there a signed-in user?" (any user). Which rows they may touch is api/_lib/tenant.js's job.
export function isAuthenticated(req, now = new Date()) {
  return sessionUid(req, undefined, now) !== null;
}

// Same as isAuthenticated(), plus the silent legacy-cookie upgrade when `res` is given.
export function checkAuthAndRefresh(req, res, now = new Date()) {
  return sessionUid(req, res, now) !== null;
}
