// POST /api/auth — password login, sets HttpOnly cookie
// GET  /api/auth — check auth status (returns {ok: true/false})

import { createHmac } from 'crypto';

const PASSWORD = process.env.MDSHARE_PASSWORD;
const HMAC_KEY = process.env.MDSHARE_HMAC_SECRET || process.env.SUPABASE_SERVICE_KEY;
if (!HMAC_KEY) throw new Error('MDSHARE_HMAC_SECRET or SUPABASE_SERVICE_KEY required');
const COOKIE_NAME = 'mdshare_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

function computeToken(password) {
  return createHmac('sha256', HMAC_KEY).update(password).digest('hex');
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

export function isAuthenticated(req) {
  if (!PASSWORD) return false; // no password set → fail closed
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  const expected = computeToken(PASSWORD);
  // constant-time compare via HMAC
  return computeToken(token) === computeToken(expected);
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

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authRateLimitMap) {
    if (now > entry.resetAt) authRateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ok = isAuthenticated(req);
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

    if (password !== PASSWORD) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    const token = computeToken(password);
    const cookieValue = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      `Max-Age=${COOKIE_MAX_AGE}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Secure',
    ].join('; ');

    res.setHeader('Set-Cookie', cookieValue);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
