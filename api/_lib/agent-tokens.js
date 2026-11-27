// User-issued, per-agent bearer API credentials — additive and parallel to the password/cookie
// flow in api/auth.js. Deliberately does NOT import from access.js or auth.js: auth.js imports this
// file to expose the token management endpoints, so importing either of those back here would
// create a circular module graph. Database access goes through api/_lib/tenant.js (multi-user,
// 2026-11-27): a token belongs to the user who created it (owner_id), resolves to that user, and
// is listed and revoked only by them.
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
//
// Scopes (added 2026-10-08, migration 006, see AGENT-SEARCH-PLAN.md): a token's `scopes` column
// is either `null` ("legacy" — every token that existed before migration 006, by construction,
// since the column has no backfill) or a text[] array ("scoped" — only produced going forward by
// api/auth.js's create_token when the owner explicitly passes a `scopes` array). Legacy tokens
// keep the exact pre-scopes behavior: unconditional create + own-row-read, no catalog, no
// publish — hasScope() always returns false for them, so no code path can accidentally grant a
// legacy token a new capability by checking a scope it was never given. Scoped tokens'
// capabilities come only from their array (plus the same universal own-row-read floor every
// token has always had — that floor is not one of the three scopes below and is never gated by
// them).
//
// documents:publish:any (added 2026-10-08, same evening follow-up): a deliberately SEPARATE,
// strictly broader scope — never implied by documents:publish alone, never implied by any
// combination of the other scopes, only ever active when the owner explicitly includes this
// exact string in a token's scopes array at creation time. documents:publish stays own-rows-only
// by default (security UX requirement: explicit + scoped to own-created docs unless the owner
// directly grants the broader capability) — see api/pin.js for the gate that checks this scope
// before, not instead of, the own-row check.
import { randomBytes, createHash } from 'crypto';
import { findTokenByHash, touchToken, insertOwned, selectOwned, patchOwned } from './tenant.js';

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

// The only scope strings a scoped token may ever be issued with (activity:* added 2026-11-25 for
// read receipts and feedback, api/doc.js). Enforced in api/auth.js
// before createToken() is ever called (reject unknown values there, 400, before any Supabase
// write) — this constant is exported so that validation and this module's own usage never drift
// out of sync. documents:publish:any is intentionally separate from documents:publish (see the
// comment above and api/pin.js) — it is never implied by it.
export const ALLOWED_SCOPES = ['documents:read', 'documents:write', 'documents:publish', 'documents:publish:any', 'activity:read', 'activity:write'];

// true only for a token row whose `scopes` column is literally null — i.e. every token that
// existed before migration 006 ran, by construction (no backfill), plus any new token created by
// explicitly omitting `scopes` from the create_token request body (see api/auth.js). A legacy
// token's capabilities never depend on hasScope() — they're the unconditional pre-scopes floor.
export function isLegacyToken(tokenResult) {
  return tokenResult?.valid === true && tokenResult.scopes == null;
}

// false for a legacy token (scopes == null) in every case, by construction — Array.isArray(null)
// is false, so there is no way for a legacy token to accidentally pass a scope check. For a
// scoped token, true only if the exact scope string is present in its array.
export function hasScope(tokenResult, scope) {
  return Array.isArray(tokenResult?.scopes) && tokenResult.scopes.includes(scope);
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

/**
 * Resolves the Authorization header (if any) against the agent-token table.
 * Returns exactly one of:
 *   { present: false }                              — no Authorization header. Callers keep
 *                                                      their existing anonymous behavior, unchanged.
 *   { present: true, valid: true, id, name, scopes, ownerId } — a currently-usable token; ownerId
 *                                                      is the user it acts for (tenant.js tokenOwner).
 *   { present: true, valid: false, reason }          — header was present but unusable
 *     (malformed | not_found | revoked | expired | no_owner | lookup_failed | lookup_error). Callers MUST
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
    const found = await findTokenByHash(hash);
    if (found.error) return { present: true, valid: false, reason: 'lookup_failed' };
    const row = found.row;
    if (!row) return { present: true, valid: false, reason: 'not_found' };
    if (row.revoked_at) return { present: true, valid: false, reason: 'revoked' };
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { present: true, valid: false, reason: 'expired' };
    // A token acts for exactly one user; an ownerless row (impossible after migration 013) fails closed.
    if (!row.ownerId) return { present: true, valid: false, reason: 'no_owner' };
    touchToken(row.id);
    // row.scopes is `null` for a legacy (pre-migration-006 or scopes-omitted-at-creation) token,
    // or an array for a scoped one — passed through verbatim; see isLegacyToken()/hasScope() above.
    return { present: true, valid: true, id: row.id, name: row.name, scopes: row.scopes ?? null, ownerId: row.ownerId };
  } catch {
    return { present: true, valid: false, reason: 'lookup_error' };
  }
}

// --- Management operations (called only from api/auth.js, cookie-gated). `me` is the signed-in
// user (tenant.js sessionOwner): a token is created for them and only they list or revoke it. ---

export async function createToken(me, { name, expiresInDays, scopes, neverExpires = false }) {
  // Only a signed-in user mints tokens; a token can't mint another one.
  if (!me || me.via !== 'cookie') throw new Error('createToken: needs the signed-in user (sessionOwner)');
  const id = 'tok_' + nanoid(16);
  const raw = generateRawToken();
  const hash = sha256Hex(raw);
  const days = clampExpiresDays(expiresInDays);
  const expiresAt = neverExpires === true ? null : new Date(Date.now() + days * 86400000).toISOString();
  // `scopes` is undefined unless the caller (api/auth.js) explicitly validated and passed an
  // array — omitting the field entirely from this insert leaves the column at its DB default
  // (null), producing a legacy token. Never defaulted to [] here: that would silently turn "owner
  // didn't ask for scopes" into "scoped token with zero scopes" (create+own-read would then stop
  // working for it), breaking the "omit scopes = old simple token" contract from the plan.
  const insertBody = { id, name, token_hash: hash, expires_at: expiresAt };
  if (Array.isArray(scopes)) insertBody.scopes = scopes;
  // Explicit field list — never a body spread. token_hash only, the raw value never touches
  // storage at all (it exists only in this function's local variables and the response below).
  // owner_id comes from `me` (insertOwned), never from the request.
  const rows = await insertOwned(TABLE, me, insertBody, { returning: true });
  const created_at = rows?.[0]?.created_at || new Date().toISOString();
  // token: raw is returned to the caller exactly once, here. Callers must send it straight to the
  // HTTP response and never log it.
  return { id, name, token: raw, expires_at: expiresAt, created_at, scopes: Array.isArray(scopes) ? scopes : null };
}

export async function listTokens(me) {
  const rows = await selectOwned(TABLE, me, 'select=id,name,created_at,expires_at,revoked_at,last_used_at,scopes&order=created_at.desc');
  const now = new Date();
  // token_hash is never selected above, so there is nothing sensitive to strip — this map only
  // adds a derived, human-readable status (and normalizes scopes to null for a legacy row, same
  // shape resolveAgentToken() returns).
  return rows.map((r) => ({
    ...r,
    scopes: r.scopes ?? null,
    status: r.revoked_at ? 'revoked' : r.expires_at && new Date(r.expires_at) < now ? 'expired' : 'active',
  }));
}

export async function revokeToken(me, id) {
  if (!isValidTokenId(id)) return { ok: false, status: 400, error: 'Invalid id' };
  const result = await patchOwned(TABLE, me, `id=eq.${encodeURIComponent(id)}&revoked_at=is.null`, { revoked_at: new Date().toISOString() });
  if (!result.ok) return { ok: false, status: 502, error: result.error };
  if (result.rows.length > 0) return { ok: true, id, already: false };

  // No row of `me` matched "id + not already revoked" — distinguish "already revoked" (idempotent
  // ok) from "never existed or someone else's" (the same 404) with one more scoped read.
  const checkRows = await selectOwned(TABLE, me, `id=eq.${encodeURIComponent(id)}&select=id`).catch(() => []);
  if (checkRows.length > 0) return { ok: true, id, already: true };
  return { ok: false, status: 404, error: 'Not found' };
}
