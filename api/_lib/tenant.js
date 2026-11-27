// The tenant layer (multi-user beta, 2026-11-27): who is asking, and every read and write of a user
// table. This is the only file that builds a PostgREST table URL (invariant "tenant-scoped"); the
// server uses the Supabase service key, so isolation between users lives here and nowhere else.
// Underscore directory: not a Vercel function.
//
// Who is asking — a "principal", minted only here and frozen:
//   sessionOwner(req, res)          the signed-in browser user (v3 cookie uid; v2/legacy = user #1)
//   tokenOwner(agentAuth)           the owner of a valid agent token
//   ownerOf(req, res, agentAuth)    a present Bearer decides (its owner; invalid -> null), else the cookie
//   creatorOf(req, res, agentAuth)  ownerOf, or for an anonymous create the site owner (user #1, as
//                                   before multi-user); that principal can insert but never read
//   rowOwner(row)                   the owner of a row this file returned (a document's own page)
// Scoped helpers accept only these principals (a WeakSet), so `{ uid: body.user }` is refused.
// `null` means "nobody": scoped reads find nothing, scoped writes change nothing.
//
// Rows: readOwned / selectOwned / patchOwned / deleteOwned put `owner_id=eq.<uid>` first in every
// query, insertOwned sets owner_id from the principal (invariant "owner-on-insert"). UNSCOPED lists
// the few reads that are not per-user by nature; adding one means changing the invariant.
// Missing and not-yours look the same to callers: a scoped lookup simply finds nothing.
import { sessionUid } from './session.js';

export const USER_TABLES = ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify', 'mdshare_agent_tokens', 'mdshare_events', 'mdshare_reads', 'mdshare_feedback'];
export const CONTENT_TABLES = ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify'];
export const SITE_OWNER_UID = 1;
// Not scoped to one user, on purpose: a document's own page (then isVisible), the credential
// lookup, the token last-used touch, the health ping and the monitor's event counts.
export const UNSCOPED = ['readForView', 'findTokenByHash', 'touchToken', 'pingDb', 'recentEventsAllUsers'];

// mdshare ids are nanoid(10) from the base64url alphabet; anything else never reaches a filter.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

// ---------- Principals ----------
const PRINCIPALS = new WeakSet();
const FROM_DB = new WeakSet();
const isUid = (n) => Number.isSafeInteger(n) && n > 0;

function principal(uid, via, extra) {
  const p = Object.freeze({ uid, via, ...(extra || {}) });
  PRINCIPALS.add(p);
  return p;
}
const ANON_CREATE = principal(SITE_OWNER_UID, 'anonymous-create');

export function sessionOwner(req, res) {
  const uid = sessionUid(req, res);
  return isUid(uid) ? principal(uid, 'cookie') : null;
}

export function tokenOwner(agentAuth) {
  return agentAuth && agentAuth.present === true && agentAuth.valid === true && isUid(agentAuth.ownerId)
    ? principal(agentAuth.ownerId, 'token', { tokenId: agentAuth.id })
    : null;
}

// agentAuth: the route's resolveAgentToken() result, or null for a route that takes no tokens.
export function ownerOf(req, res, agentAuth) {
  if (agentAuth === undefined) throw new Error('ownerOf(req, res, agentAuth): resolve the Bearer token first, or pass null for a cookie-only route');
  if (agentAuth && agentAuth.present) return tokenOwner(agentAuth);
  return sessionOwner(req, res);
}

export function creatorOf(req, res, agentAuth) {
  return ownerOf(req, res, agentAuth) || ANON_CREATE;
}

export function rowOwner(row) {
  return row && FROM_DB.has(row) && isUid(row.owner_id) ? principal(row.owner_id, 'row') : null;
}

const readable = (me) => !!me && PRINCIPALS.has(me) && me.via !== 'anonymous-create' && isUid(me.uid);

// Does principal `me` own `row`? False for anonymous, the anonymous-create principal and ownerless rows.
export function owns(me, row) {
  return readable(me) && !!row && isUid(row.owner_id) && row.owner_id === me.uid;
}

// The user id for a scoped query; throws on anything that isn't a readable principal.
export function uidOf(me) {
  if (!readable(me)) throw new Error('tenant: a scoped query needs a principal from ownerOf()/sessionOwner()/tokenOwner()/rowOwner()');
  return me.uid;
}

function ownerFilter(me) {
  return `owner_id=eq.${encodeURIComponent(uidOf(me))}`;
}

// ---------- PostgREST ----------
export const dbConfigured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

function dbHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { Authorization: `Bearer ${key}`, apikey: key, ...(extra || {}) };
}

function request(table, query, init = {}) {
  if (!USER_TABLES.includes(table)) throw new Error(`tenant: ${table} is not a user table`);
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`, { ...init, headers: dbHeaders(init.headers) });
}

const mark = (r) => { if (r && typeof r === 'object') FROM_DB.add(r); return r; };
async function rowsOf(res) {
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map(mark) : [];
}
const withOwnerColumn = (select) => (String(select).split(',').includes('owner_id') ? select : `${select},owner_id`);
const expired = (row) => !!row.expires_at && new Date(row.expires_at) < new Date();
const assertNoOwner = (obj, fn) => { if (obj && Object.prototype.hasOwnProperty.call(obj, 'owner_id')) throw new Error(`${fn}: owner_id is set only by insertOwned() from the request owner`); };

// { row } | { row: null } (missing, expired, invalid id, not yours) | { row: null, dbError: true }
async function byId(table, scope, id, select) {
  if (!CONTENT_TABLES.includes(table)) throw new Error(`tenant: ${table} is not a content table`);
  if (!isValidId(id)) return { row: null };
  try {
    const res = await request(table, `${scope}id=eq.${encodeURIComponent(id)}&select=${withOwnerColumn(select)}`);
    if (!res.ok) return { row: null, dbError: true };
    const rows = await rowsOf(res);
    if (!rows.length || expired(rows[0])) return { row: null };
    return { row: rows[0] };
  } catch {
    return { row: null, dbError: true };
  }
}

// The one unscoped document read: by id, for the document's own page or raw route. The caller must
// pass the row through isVisible() (api/_lib/access.js) before returning anything from it.
export function readForView(table, id, select) {
  return byId(table, '', id, select);
}

// One of `me`'s documents by id (same result shape as readForView).
export function readOwned(table, me, id, select) {
  if (me === null) return Promise.resolve({ row: null });
  return byId(table, `${ownerFilter(me)}&`, id, select);
}

// `me`'s rows matching a PostgREST query. Throws on a database error.
export async function selectOwned(table, me, query) {
  if (me === null) return [];
  const res = await request(table, `${ownerFilter(me)}${query ? `&${query}` : ''}`);
  if (!res.ok) throw new Error(`Supabase select ${table} failed: ${res.status}`);
  return rowsOf(res);
}

// Update `me`'s rows matching `filter`. { ok: true, rows } (rows = what changed) | { ok: false, status, error }.
export async function patchOwned(table, me, filter, patch) {
  if (!filter) throw new Error('patchOwned: a filter is required');
  assertNoOwner(patch, 'patchOwned');
  if (me === null) return { ok: true, rows: [] };
  const res = await request(table, `${ownerFilter(me)}&${filter}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return { ok: false, status: 502, error: await res.text() };
  return { ok: true, rows: await rowsOf(res) };
}

// Delete one of `me`'s content rows. Returns the deleted rows (empty: missing or not yours).
export async function deleteOwned(table, me, id) {
  if (!CONTENT_TABLES.includes(table)) throw new Error(`tenant: ${table} is not a content table`);
  if (me === null) return [];
  const res = await request(table, `${ownerFilter(me)}&id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!res.ok) throw new Error(`Supabase delete failed: ${res.status}`);
  return rowsOf(res);
}

// Insert one row owned by `owner` (a principal from ownerOf()/creatorOf()/sessionOwner(); null only
// for an event with no signed-in user). owner_id never comes from the row itself.
export async function insertOwned(table, owner, row, { returning = false } = {}) {
  assertNoOwner(row, 'insertOwned');
  let uid = null;
  if (owner === null) {
    if (table !== 'mdshare_events') throw new Error(`insertOwned: ${table} rows always have an owner`);
  } else {
    if (!PRINCIPALS.has(owner) || !isUid(owner.uid)) throw new Error('insertOwned: the owner must be a principal from ownerOf()/creatorOf()/sessionOwner()');
    uid = owner.uid;
  }
  const res = await request(table, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: returning ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify({ ...row, owner_id: uid }),
  });
  if (!res.ok) throw new Error(`Supabase insert into ${table} failed: ${res.status} — ${await res.text()}`);
  return returning ? rowsOf(res) : [];
}

// ---------- Unscoped by nature (UNSCOPED) ----------
// Credential lookup: the hash is the secret. { row: {..., ownerId} } | { row: null } | { error }.
export async function findTokenByHash(hash) {
  const res = await request('mdshare_agent_tokens', `token_hash=eq.${encodeURIComponent(hash)}&select=id,name,expires_at,revoked_at,scopes,owner_id`);
  if (!res.ok) return { error: 'lookup_failed' };
  const rows = await rowsOf(res);
  if (!rows.length) return { row: null };
  const { owner_id: ownerId, ...rest } = rows[0];
  return { row: { ...rest, ownerId: isUid(ownerId) ? ownerId : null } };
}

// Best-effort last-used stamp for a token that was just validated. Never throws.
export function touchToken(id) {
  if (!dbConfigured()) return;
  request('mdshare_agent_tokens', `id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
}

export async function pingDb() {
  try {
    const r = await request('mdshare_pastes', 'select=id&limit=1');
    return r.ok ? 'ok' : `error ${r.status}`;
  } catch {
    return 'unreachable';
  }
}

// The monitor's error log (api/health.js, x-monitor-key only): kinds and messages, no owner.
export async function recentEventsAllUsers(sinceIso) {
  const r = await request('mdshare_events', `select=kind,message,commit,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=500`);
  if (!r.ok) return { error: `events query failed: ${r.status}` };
  return { rows: await rowsOf(r) };
}
