// POST /api/auth — password login (the owner, user #1), sets a signed, server-expiring HttpOnly cookie
// GET  /api/auth — check auth status (returns {ok: true/false})
// Token management (?action=tokens, create_token, DELETE revoke_token) and whoami, below.
// Multi-user beta P3 (2026-11-27), POST ?action=…:
//   signup        {label?} -> 201 {user_id, token, entry_url, guide}. No password, no email: a new user,
//                 one agent token (documents:read+write+publish) and a private entry link. 5 per IP an
//                 hour (429 + Retry-After); MDSHARE_MAX_USERS seats besides user #1 (403 "beta full").
//   enter         {secret} -> sets the v3 session cookie for the link's user. Called only by
//                 /enter (public/enter.html), which reads the secret from the URL fragment.
//   entry-link    Bearer (documents:write) or the user's cookie -> 200 {entry_url}; the old link stops,
//                 and browsers signed in before now are signed out (the asking browser is re-issued).
//   disable-user  {user_id, disabled} -> the kill switch. User #1's session only; never user #1.
// The entry secret exists only in the link (a URL fragment never reaches a server log) and in the
// one response that creates it; the database keeps entryHash(secret) (invariant "entry-secret-hashed").
//
// Sessions: api/_lib/session.js (v3 cookies carry the user id; v2 and legacy cookies are user #1).
// Every token operation is scoped to the signed-in user through api/_lib/tenant.js: a user lists,
// creates and revokes only their own tokens.

import { randomBytes } from 'crypto';
import {
  COOKIE_NAME, OWNER_UID, computeToken, safeHexEqual, freshSessionCookie, checkAuthAndRefresh,
} from './_lib/session.js';
import { createToken, listTokens, revokeToken, resolveAgentToken, hasScope, sha256Hex, ALLOWED_SCOPES } from './_lib/agent-tokens.js';
import { sessionOwner, ownerOf, isAdmin, maxUsers, createUser, findUserByEntry, rotateEntry, setUserDisabled } from './_lib/tenant.js';
import { parseJsonBody } from './_lib/body.js';
import { withErrors } from './_lib/events.js';
import { rateLimiter, clientIp } from './_lib/rate-limit.js';
import { siteOrigin, guideUrl } from './_lib/content.js';

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

// --- Sign-up and entry links (multi-user beta P3) ---
// The sign-up token can publish what it creates (documents:publish: pin.js lets it toggle only rows
// it created, which is what the skill's `publish --public` does), never documents:publish:any.
export const SIGNUP_SCOPES = ['documents:read', 'documents:write', 'documents:publish'];
export const SIGNUP_LIMIT = rateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
const ENTER_LIMIT = rateLimiter({ limit: 20, windowMs: 15 * 60 * 1000 });
const newEntrySecret = () => randomBytes(32).toString('base64url');
const ENTRY_SECRET = /^[A-Za-z0-9_-]{43}$/;
// The only form of the secret the database ever sees (tenant.js refuses anything but 64 hex chars).
export const entryHash = (secret) => sha256Hex(`mdshare-entry-v1:${secret}`);
// The canonical origin (loopback only for a local dev server), never the Host header; the secret in the fragment.
const entryUrl = (req, secret) => `${siteOrigin(req)}/enter#${secret}`;
const ENTRY_FAILED = 'This entry link does not work (it may have been replaced by a newer one). Ask your agent for a fresh link.';

function cleanLabel(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = [...v].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').trim();
  return s.length > 100 ? undefined : s || null;
}

function tooMany(res, rate, what) {
  res.setHeader('Retry-After', String(rate.retryAfter));
  return res.status(429).json({ error: `Too many ${what} from this network. Retry in ${rate.retryAfter}s.`, retry_after: rate.retryAfter });
}

async function signup(req, res, body) {
  res.setHeader('Cache-Control', 'no-store');
  const rate = SIGNUP_LIMIT.check(clientIp(req));
  if (!rate.allowed) return tooMany(res, rate, `sign-ups (at most ${SIGNUP_LIMIT.limit} an hour)`);
  const label = cleanLabel(body.label);
  if (label === undefined) return res.status(400).json({ error: 'label must be a string of at most 100 characters' });
  // The seat check and the insert are one atomic SQL call (createUser -> mdshare_signup_user).
  const cap = maxUsers();
  const secret = newEntrySecret();
  const me = await createUser({ label, entryHash: entryHash(secret), max: cap });
  if (!me) return res.status(403).json({ error: 'beta full' });
  const name = (label ? `mdshare skill (${label})` : 'mdshare skill').slice(0, 100);
  const created = await createToken(me, { name, expiresInDays: 365, scopes: SIGNUP_SCOPES });
  // token and entry_url: returned exactly once, here; never logged or stored in plain text.
  return res.status(201).json({ user_id: me.uid, token: created.token, entry_url: entryUrl(req, secret), guide: guideUrl(req) });
}

async function enter(req, res, body) {
  res.setHeader('Cache-Control', 'no-store');
  const rate = ENTER_LIMIT.check(clientIp(req));
  if (!rate.allowed) return tooMany(res, rate, 'entry attempts');
  const secret = typeof body.secret === 'string' ? body.secret : '';
  // Wrong, rotated, disabled or user #1: the same answer.
  const uid = ENTRY_SECRET.test(secret) ? await findUserByEntry(entryHash(secret)) : null;
  if (!uid) return res.status(401).json({ error: ENTRY_FAILED });
  res.setHeader('Set-Cookie', freshSessionCookie(uid));
  return res.status(200).json({ ok: true, redirect: '/dashboard' });
}

async function rotateEntryLink(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const agentAuth = await resolveAgentToken(req);
  if (agentAuth.present && !agentAuth.valid) return res.status(401).json({ error: 'Invalid or expired token' });
  const me = ownerOf(req, res, agentAuth);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });
  // A new link is a full browser session: a read-only token must not be able to mint one.
  if (me.via === 'token' && !hasScope(agentAuth, 'documents:write')) return res.status(403).json({ error: 'A new entry link needs a token with documents:write' });
  if (me.uid === OWNER_UID) return res.status(403).json({ error: 'The owner signs in with the password; user #1 has no entry link.' });
  const secret = newEntrySecret();
  if (!(await rotateEntry(me, entryHash(secret)))) return res.status(401).json({ error: 'Unauthorized' });
  // Rotation signs out every browser signed in before now; the one asking (Settings) stays in.
  if (me.via === 'cookie') res.setHeader('Set-Cookie', freshSessionCookie(me.uid));
  return res.status(200).json({ entry_url: entryUrl(req, secret) });
}

// The kill switch (owner only). A disabled user's pages answer like missing ones (public too), their
// tokens 401 and their sessions count as signed out, at once (tenant.js); enabling restores all three.
async function disableUser(req, res, body) {
  const me = sessionOwner(req, res);
  if (!isAdmin(me)) return res.status(me ? 403 : 401).json({ error: 'Owner only' });
  if (typeof body.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be true or false' });
  const uid = Number(body.user_id);
  if (uid === OWNER_UID) return res.status(400).json({ error: 'User #1 (the owner) can never be disabled' });
  if (!Number.isSafeInteger(uid) || uid < 1) return res.status(400).json({ error: 'user_id must be a positive integer' });
  const r = await setUserDisabled(me, uid, body.disabled);
  if (!r) return res.status(404).json({ error: 'No such user' });
  return res.status(200).json({ ok: true, ...r });
}

const POST_ACTIONS = { signup, enter, 'entry-link': rotateEntryLink, 'disable-user': disableUser };

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
    const action = String((req.query && req.query.action) || (body && body.action) || '');
    if (Object.prototype.hasOwnProperty.call(POST_ACTIONS, action)) return POST_ACTIONS[action](req, res, body || {});
    if (action && action !== 'create_token' && action !== 'logout') return res.status(400).json({ error: `Unknown action. Use one of: ${[...Object.keys(POST_ACTIONS), 'create_token', 'logout'].join(', ')}` });

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
    const rateCheck = checkAuthRateLimit(clientIp(req));
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
