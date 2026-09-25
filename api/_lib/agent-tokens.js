// Owner-issued, per-agent bearer API credentials — additive and parallel to the owner
// password/cookie flow in api/auth.js. Deliberately does NOT import from access.js or auth.js:
// auth.js imports this file to expose the owner-only management endpoints, so importing either
// of those back here would create a circular module graph. Keep this file dependency-free
// (only 'crypto') on purpose.
//
// Security model:
//   - Raw token is generated with 256 bits of crypto-random entropy and a "mds_" prefix. It is
//     returned to the owner exactly once (at creation) and never stored anywhere — only its
//     SHA-256 hash is persisted (mdshare_agent_tokens.token_hash).
//   - A token that is malformed, unknown, revoked, or past expires_at resolves to
//     { valid: false } — every caller (api/share.js, api/diagram.js, api/archify.js) MUST treat
//     that as a hard 401, never as "fall back to anonymous". Only the complete ABSENCE of an
//     Authorization header ({ present: false }) is the signal to keep existing anonymous
//     behavior.
//   - Any Supabase lookup error fails closed (valid: false), same convention as
//     access.js#getRow's dbError handling.
import { randomBytes, createHash } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = 'mdshare_agent_tokens';

const TOKEN_PREFIX = 'mds_';
const MIN_EXPIRES_DAYS = 1;
const MAX_EXPIRES_DAYS = 365;
const DEFAULT_EXPIRES_DAYS = 90;

// Same shape as access.js's ID_PATTERN — token ids are app-generated ("tok_" + base64url), never
// user-supplied at creation, but revoke() takes an id from the (owner-authenticated) request body
// so it still gets validated before hitting a PostgREST filter string.
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidTokenId(id) {
  return typeof id === 'string' && TOKEN_ID_PATTERN.test(id);
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function nanoid(size = 16) {
  return randomBytes(size).toString('base64url').slice(0, size);
}

export function generateRawToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url'); // ~256 bits of entropy
}

export function clampExpiresDays(days) {
  const n = Number.isFinite(days) ? Math.floor(days) : DEFAULT_EXPIRES_DAYS;
  return Math.min(MAX_EXPIRES_DAYS, Math.max(MIN_EXPIRES_DAYS, n));
}

export function parseBearer(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  const raw = m ? m[1].trim() : null;
  return raw && raw.length ? raw : null;
}

// Best-effort attribution touch. Never awaited by callers, never throws, never blocks the
// response — same "best effort" spirit as the in-memory rate limiters elsewhere in this repo.
function touchLastUsed(id) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
}

/**
 * Resolves the Authorization header (if any) against the agent-token table.
 * Returns exactly one of:
 *   { present: false }                              — no Authorization header. Callers keep
 *                                                      their existing anonymous behavior, unchanged.
 *   { present: true, valid: true, id, name }         — a currently-usable token.
 *   { present: true, valid: false, reason }          — header was present but unusable
 *     (malformed | not_found | revoked | expired | lookup_failed | lookup_error). Callers MUST
 *     respond 401 and must NOT fall back to treating the request as anonymous.
 */
export async function resolveAgentToken(req) {
  const raw = parseBearer(req);
  if (!raw) return { present: false };
  if (raw.length < 16 || raw.length > 512) {
    return { present: true, valid: false, reason: 'malformed' };
  }
  const hash = sha256Hex(raw);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${TABLE}?token_hash=eq.${encodeURIComponent(hash)}&select=id,name,expires_at,revoked_at`,
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
    );
    if (!res.ok) return { present: true, valid: false, reason: 'lookup_failed' };
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return { present: true, valid: false, reason: 'not_found' };
    const row = rows[0];
    if (row.revoked_at) return { present: true, valid: false, reason: 'revoked' };
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { present: true, valid: false, reason: 'expired' };
    touchLastUsed(row.id);
    return { present: true, valid: true, id: row.id, name: row.name };
  } catch {
    return { present: true, valid: false, reason: 'lookup_error' };
  }
}

// --- Owner-only management operations (called only from api/auth.js, itself owner-cookie-gated) ---

export async function createToken({ name, expiresInDays }) {
  const id = 'tok_' + nanoid(16);
  const raw = generateRawToken();
  const hash = sha256Hex(raw);
  const days = clampExpiresDays(expiresInDays);
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    // Explicit field list — never a body spread. token_hash only, the raw value never touches
    // storage at all (it exists only in this function's local variables and the response below).
    body: JSON.stringify({ id, name, token_hash: hash, expires_at: expiresAt }),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status} — ${await res.text()}`);
  const rows = await res.json().catch(() => []);
  const created_at = rows?.[0]?.created_at || new Date().toISOString();
  // token: raw is returned to the caller exactly once, here. Callers must send it straight to the
  // HTTP response and never log it.
  return { id, name, token: raw, expires_at: expiresAt, created_at };
}

export async function listTokens() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLE}?select=id,name,created_at,expires_at,revoked_at,last_used_at&order=created_at.desc`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  );
  if (!res.ok) throw new Error(`Supabase list failed: ${res.status} — ${await res.text()}`);
  const rows = await res.json();
  const now = new Date();
  // token_hash is never selected above, so there is nothing sensitive to strip — this map only
  // adds a derived, human-readable status.
  return rows.map((r) => ({
    ...r,
    status: r.revoked_at ? 'revoked' : r.expires_at && new Date(r.expires_at) < now ? 'expired' : 'active',
  }));
}

export async function revokeToken(id) {
  if (!isValidTokenId(id)) return { ok: false, status: 400, error: 'Invalid id' };
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&revoked_at=is.null`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) return { ok: false, status: 502, error: await res.text() };
  const rows = await res.json().catch(() => []);
  if (Array.isArray(rows) && rows.length > 0) return { ok: true, id, already: false };

  // No row matched "id + not already revoked" — distinguish "already revoked" (idempotent ok)
  // from "never existed" (404) with one more read.
  const check = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&select=id`, {
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
  });
  const checkRows = check.ok ? await check.json().catch(() => []) : [];
  if (Array.isArray(checkRows) && checkRows.length > 0) return { ok: true, id, already: true };
  return { ok: false, status: 404, error: 'Not found' };
}
