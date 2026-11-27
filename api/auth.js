// POST /api/auth — password login (the owner, user #1), sets a signed, server-expiring HttpOnly cookie
// GET  /api/auth — check auth status (returns {ok: true/false})
// Token management (?action=tokens, create_token, DELETE revoke_token) and whoami, below.
//
// Sessions: api/_lib/session.js (v3 cookies carry the user id; v2 and legacy cookies are user #1).
// Every token operation is scoped to the signed-in user through api/_lib/tenant.js: a user lists,
// creates and revokes only their own tokens.

import {
  COOKIE_NAME, OWNER_UID, computeToken, safeHexEqual, freshSessionCookie, checkAuthAndRefresh,
} from './_lib/session.js';
import { createToken, listTokens, revokeToken, resolveAgentToken, ALLOWED_SCOPES } from './_lib/agent-tokens.js';
import { sessionOwner } from './_lib/tenant.js';
import { parseJsonBody } from './_lib/body.js';
import { withErrors } from './_lib/events.js';

// The session cookie code lives in api/_lib/session.js since the multi-user change (2026-11-27);
// these re-exports keep every older import of it from this file working.
export {
  LEGACY_COOKIE_CUTOFF, signSessionToken, verifySessionToken, verifyLegacyCookie, signUserSession, verifyUserSession,
  sessionUid, isAuthenticated, checkAuthAndRefresh,
} from './_lib/session.js';

const PASSWORD = process.env.MDSHARE_PASSWORD;

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

// --- Owner-only per-agent bearer token management (additive, parallel to the password/cookie
// flow above). Dispatched by method + an explicit `action` field so the existing bare
// GET/POST{password} paths above are completely untouched (no `action` field -> old behavior).
// See api/_lib/agent-tokens.js for the token model itself; this file only wires it to HTTP and
// enforces that every one of these three routes requires the owner's cookie.

async function handler(req, res) {
  if (req.method === 'GET') {
    if (req.query && req.query.action === 'tokens') {
      const me = sessionOwner(req, res);
      if (!me) return res.status(401).json({ error: 'Unauthorized' });
      try {
        const tokens = await listTokens(me);
        return res.status(200).json({ ok: true, tokens });
      } catch (e) {
        return res.status(502).json({ error: 'Failed to list tokens' });
      }
    }

    // Bearer-only self-introspection (added 2026-10-08, AGENT-SEARCH-PLAN.md). No owner cookie is
    // involved or accepted here — a token asks "what am I", never "what is the owner's status".
    // Absent header -> 401 (there is no anonymous meaning for "who am I" without a token); present
    // but invalid (malformed/unknown/revoked/expired) -> 401, same fail-closed rule as every other
    // bearer-consuming route; never falls back to the owner-cookie status check below.
    if (req.query && req.query.action === 'whoami') {
      res.setHeader('Cache-Control', 'no-store');
      const agentAuth = await resolveAgentToken(req);
      if (!agentAuth.present || !agentAuth.valid) return res.status(401).json({ error: 'Unauthorized' });
      return res.status(200).json({
        ok: true,
        id: agentAuth.id,
        name: agentAuth.name,
        user_id: agentAuth.ownerId,
        legacy: agentAuth.scopes == null,
        scopes: agentAuth.scopes ?? [],
      });
    }

    const ok = checkAuthAndRefresh(req, res);
    return res.status(ok ? 200 : 401).json({ ok });
  }

  if (req.method === 'POST') {
    let body = parseJsonBody(req.body);

    // Owner-only agent-token creation. Requires an already-valid owner cookie — issuing a new
    // credential is never itself a way to authenticate. Raw token is returned exactly once, in
    // this response body, and is never logged or persisted anywhere else.
    if (body && body.action === 'create_token') {
      const me = sessionOwner(req, res);
      if (!me) return res.status(401).json({ error: 'Unauthorized' });
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 100) {
        return res.status(400).json({ error: 'name is required (max 100 chars)' });
      }

      // `scopes` (added 2026-10-08, AGENT-SEARCH-PLAN.md) is optional. Omitted entirely ->
      // undefined is passed through to createToken(), which leaves the DB column at its default
      // (null) -> a legacy token, preserving every existing caller of this endpoint byte-for-byte.
      // Present -> must be an array of at most ALLOWED_SCOPES.length distinct strings, each one of ALLOWED_SCOPES;
      // anything else is a 400 before any Supabase call, never silently dropped/ignored/clamped.
      let scopes;
      if (body.scopes !== undefined) {
        if (!Array.isArray(body.scopes) || body.scopes.length > ALLOWED_SCOPES.length) {
          return res.status(400).json({ error: `scopes must be an array of up to ${ALLOWED_SCOPES.length} strings from: ${ALLOWED_SCOPES.join(', ')}` });
        }
        const deduped = [...new Set(body.scopes)];
        const invalid = deduped.filter((s) => !ALLOWED_SCOPES.includes(s));
        if (invalid.length) {
          return res.status(400).json({ error: `Unknown scope(s): ${invalid.join(', ')}. Allowed: ${ALLOWED_SCOPES.join(', ')}` });
        }
        scopes = deduped;
      }

      if (body.never_expires !== undefined && typeof body.never_expires !== 'boolean') {
        return res.status(400).json({ error: 'never_expires must be a boolean' });
      }
      try {
        const created = await createToken(me, { name, expiresInDays: body.expires_in_days, scopes, neverExpires: body.never_expires === true });
        return res.status(200).json({ ok: true, ...created });
      } catch (e) {
        return res.status(502).json({ error: 'Failed to create token' });
      }
    }

    // Sign out: clears this browser's session cookie. Sessions are stateless HMAC tokens, so
    // there is nothing server-side to revoke; no auth needed to drop your own cookie.
    if (body && body.action === 'logout') {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`);
      return res.status(200).json({ ok: true });
    }

    // --- existing password login flow (unchanged) ---
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const rateCheck = checkAuthRateLimit(ip);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfter));
      return res.status(429).json({ error: 'Too many login attempts. Try again later.', retry_after: rateCheck.retryAfter });
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

    // The password is the owner's: user #1 (migration 013). The cookie carries the user id (v3).
    res.setHeader('Set-Cookie', freshSessionCookie(OWNER_UID));
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const me = sessionOwner(req, res);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });

    let body = parseJsonBody(req.body);
    body = body || {};

    if (body.action && body.action !== 'revoke_token') {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const id = body.id || req.query?.id;
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing id' });

    const result = await revokeToken(me, id);
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error || 'Revoke failed' });
    return res.status(200).json({ ok: true, id: result.id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withErrors('auth', handler);
