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
//
// Accounts (P3): the users table (mdshare_users) and the owner's stats rpc are touched only by the
// ACCOUNTS functions at the end of this file. A disabled user is shut out in three places, all here:
// gateSession (their cookie), findTokenByHash (their tokens), readForView (their pages, public ones
// too). User #1 is never limited and never disabled (COMPAT-CHECK G2), and is never looked up.
// Quotas (users other than #1) are enforced inside insertOwned/patchOwned, so no create path skips them.
import { sessionUid, sessionIssuedAt, rejectSession, sessionRejected, safeHexEqual } from './session.js';
import { sanitizeSvg, SvgRejected } from './svg-sanitize.js';

export const USER_TABLES = ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify', 'mdshare_agent_tokens', 'mdshare_events', 'mdshare_reads', 'mdshare_feedback'];
export const CONTENT_TABLES = ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify'];
export const SITE_OWNER_UID = 1;
// Not scoped to one user, on purpose: a document's own page (then isVisible), the credential
// lookup, the token last-used touch, the health ping, the monitor's event counts and its
// "every row has an owner" check.
export const UNSCOPED = ['readForView', 'findTokenByHash', 'touchToken', 'pingDb', 'recentEventsAllUsers', 'ownerlessTables'];
// Tables where every row must have an owner (COMPAT-CHECK G1). mdshare_events is not one: an event
// with no signed-in user (an anonymous browser error, a crash before auth) is ownerless by design.
export const OWNED_TABLES = USER_TABLES.filter((t) => t !== 'mdshare_events');
// The accounts table (013) and the owner's stats rpc (014): no owner_id; only ACCOUNTS touch them.
const USERS = 'mdshare_users';
const STATS_RPC = 'rpc/mdshare_user_stats';
const ACCOUNT_PATHS = [USERS, STATS_RPC];
export const ACCOUNTS = ['userActive', 'gateSession', 'countSeats', 'createUser', 'findUserByEntry', 'rotateEntry', 'setUserDisabled', 'userStats'];

// A request refused for a reason the caller should see (a quota, a disabled account, owner-only):
// withErrors() (api/_lib/events.js) answers it with `status` and `message`, never a 500.
export class Refused extends Error {
  constructor(status, message, { retryAfter } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

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

// A disabled user's rejected session must not turn into an anonymous create filed under user #1.
export function creatorOf(req, res, agentAuth) {
  const me = ownerOf(req, res, agentAuth);
  if (me) return me;
  if (sessionRejected(req)) throw new Refused(403, 'This account is disabled.');
  return ANON_CREATE;
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
  if (!USER_TABLES.includes(table) && !ACCOUNT_PATHS.includes(table)) throw new Error(`tenant: ${table} is not a user table`);
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
// pass the row through isVisible() (api/_lib/access.js) before returning anything from it. A row of
// a disabled user (or with no owner) is missing, public or not (the kill switch).
export async function readForView(table, id, select) {
  const found = await byId(table, '', id, select);
  if (found.row && found.row.owner_id !== SITE_OWNER_UID && !(await userActive(found.row.owner_id))) return { row: null };
  return found;
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
  patch = cleanStored(table, patch);
  if (CONTENT_TABLES.includes(table) && Object.keys(patch).some((k) => BODY_FIELDS.includes(k))) await enforceQuota(me, patch, { daily: false });
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

// Stored user markup that a browser could run: a diagram's SVG is sanitised on every insert and
// patch (api/_lib/svg-sanitize.js; invariant "user-content-sandboxed"), so no write path skips it.
// Archify HTML is not: it runs only in its sandbox (api/archify-render.js, api/archify-html.js).
function cleanStored(table, row) {
  if (table !== 'mdshare_diagrams' || !row || !Object.prototype.hasOwnProperty.call(row, 'svg')) return row;
  let svg;
  try {
    svg = sanitizeSvg(row.svg);
  } catch (e) {
    if (e instanceof SvgRejected) throw new Refused(400, `svg rejected: ${e.message}`);
    throw e;
  }
  if (!/^\s*<svg[\s>/]/i.test(svg)) throw new Refused(400, 'svg field must be valid SVG markup (an <svg> root element)');
  return { ...row, svg };
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
  row = cleanStored(table, row);
  if (CONTENT_TABLES.includes(table)) await enforceQuota(owner, row, { daily: true });
  const res = await request(table, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: returning ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify({ ...row, owner_id: uid }),
  });
  if (!res.ok) throw new Error(`Supabase insert into ${table} failed: ${res.status} — ${await res.text()}`);
  return returning ? rowsOf(res) : [];
}

// ---------- Quotas (users other than #1; mdshare_users quota_* columns, NULL = unlimited) ----------
const BODY_FIELDS = ['content', 'svg', 'html', 'markdown', 'ir'];
const DAY_MS = 24 * 3600 * 1000;
const kb = (n) => Math.ceil(n / 1024);
// The stored size of a row: UTF-8 bytes of its strings plus the JSON of its objects (archify IR).
export function rowBytes(row) {
  let n = 0;
  for (const v of Object.values(row || {})) {
    if (typeof v === 'string') n += Buffer.byteLength(v);
    else if (v && typeof v === 'object') n += Buffer.byteLength(JSON.stringify(v));
  }
  return n;
}

// Throws Refused: 413 over the per-document size, 429 (+ Retry-After) when `daily` and the owner
// already created quota_docs_per_day documents in the last 24 hours (all three content tables).
// User #1 (and the anonymous-create principal, which is user #1) is never limited (G2).
async function enforceQuota(owner, row, { daily }) {
  if (owner.uid === SITE_OWNER_UID) return;
  const q = await quotaRow(owner.uid);
  if (!q) throw new Refused(503, 'Temporarily unavailable');
  if (q.disabled !== false) throw new Refused(403, 'This account is disabled.');
  const bytes = rowBytes(row);
  if (Number.isSafeInteger(q.quota_bytes) && bytes > q.quota_bytes) throw new Refused(413, `Document too large: ${kb(bytes)} KB. Each document may be at most ${kb(q.quota_bytes)} KB during the beta.`);
  const max = q.quota_docs_per_day;
  if (!daily || !Number.isSafeInteger(max)) return;
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const lists = await Promise.all(CONTENT_TABLES.map(async (t) => {
    const res = await request(t, `${ownerFilter(owner)}&created_at=gte.${encodeURIComponent(since)}&select=created_at&order=created_at.asc&limit=${Math.max(1, max)}`);
    if (!res.ok) throw new Refused(503, 'Temporarily unavailable');
    return rowsOf(res);
  }));
  const times = lists.flat().map((x) => Date.parse(x.created_at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < max) return;
  // The count drops below the limit when the (count - max + 1)-th oldest document leaves the window.
  const retryAfter = Math.max(1, Math.ceil(((times[times.length - max] ?? Date.now()) + DAY_MS - Date.now()) / 1000));
  throw new Refused(429, `Daily limit reached: at most ${max} documents in 24 hours during the beta. Retry in ${Math.ceil(retryAfter / 60)} min.`, { retryAfter });
}

// ---------- Unscoped by nature (UNSCOPED) ----------
// Credential lookup: the hash is the secret. { row: {..., ownerId} } | { row: null } | { error }.
export async function findTokenByHash(hash) {
  const res = await request('mdshare_agent_tokens', `token_hash=eq.${encodeURIComponent(hash)}&select=id,name,expires_at,revoked_at,scopes,owner_id`);
  if (!res.ok) return { error: 'lookup_failed' };
  const rows = await rowsOf(res);
  if (!rows.length) return { row: null };
  const { owner_id: ownerId, ...rest } = rows[0];
  // The kill switch: a token of a disabled user resolves, but as unusable (api/_lib/agent-tokens.js -> 401).
  const ownerDisabled = isUid(ownerId) && ownerId !== SITE_OWNER_UID && !(await userActive(ownerId));
  return { row: { ...rest, ownerId: isUid(ownerId) ? ownerId : null, ownerDisabled } };
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

// The monitor's G1 check (api/health.js, x-monitor-key only): the names of OWNED_TABLES that have
// at least one row without an owner. One `limit=1` probe per table; never counts or ids.
// { ok: true, ownerless: [] } | { ok: false, ownerless: [...] } | { error }.
export async function ownerlessTables() {
  const found = await Promise.all(OWNED_TABLES.map(async (t) => {
    const r = await request(t, `select=${t === 'mdshare_reads' ? 'doc_id' : 'id'}&owner_id=is.null&limit=1`);
    if (!r.ok) throw new Error(`${t}: ${r.status}`);
    return (await rowsOf(r)).length ? t : null;
  })).catch((e) => ({ error: `owner check failed: ${e.message}` }));
  if (found.error) return found;
  const ownerless = found.filter(Boolean);
  return { ok: ownerless.length === 0, ownerless };
}

// ---------- Accounts (mdshare_users and the stats rpc; ACCOUNTS) ----------
// Only these functions touch USERS / STATS_RPC, and they touch nothing else (invariant
// "tenant-scoped"). The entry-link secret never reaches this file: only its sha256 hex (64 chars).
const ENTRY_HASH = /^[0-9a-f]{64}$/;
function assertEntryHash(hash) {
  if (typeof hash !== 'string' || !ENTRY_HASH.test(hash)) throw new Error('tenant: store the sha256 hex of the entry secret (entryHash() in api/auth.js), never the secret');
}
const jsonInit = (method, body) => ({ method, headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body) });

// The gate's view of user `uid`: { id, disabled, sessions_valid_after } or null (no such user, or a
// database error: fail closed).
async function accountRow(uid) {
  try {
    const r = await request(USERS, `id=eq.${encodeURIComponent(uid)}&select=id,disabled,sessions_valid_after`);
    if (!r.ok) return null;
    const rows = await rowsOf(r);
    return rows.length === 1 ? rows[0] : null;
  } catch {
    return null;
  }
}

// May user `uid` in? User #1 always, without a query (G2: never disabled). Anyone else: an existing,
// not disabled row. A database error is a no (fail closed).
export async function userActive(uid) {
  if (uid === SITE_OWNER_UID) return true;
  if (!isUid(uid)) return false;
  const u = await accountRow(uid);
  return !!u && u.disabled === false;
}

// A session issued before the user's last entry-link rotation (it may have come from the old link).
function signedInBefore(req, validAfter) {
  if (!validAfter) return false;
  const issued = sessionIssuedAt(req);
  return issued === null || issued * 1000 < Date.parse(validAfter);
}

// Run by withErrors() before every handler: the cookie of a disabled or unknown user, or one issued
// before their last entry-link rotation, is rejected for this request, so every sessionOwner() /
// sessionUid() after it sees nobody (the kill switch; a rotated link leaves no session behind).
export async function gateSession(req) {
  const uid = sessionUid(req);
  if (!isUid(uid) || uid === SITE_OWNER_UID) return;
  const u = await accountRow(uid);
  if (!u || u.disabled !== false || signedInBefore(req, u.sessions_valid_after)) rejectSession(req);
}

// A user's quota row for enforceQuota(): { disabled, quota_docs_per_day, quota_bytes } | null (error).
// A missing user reads as disabled.
async function quotaRow(uid) {
  const r = await request(USERS, `id=eq.${encodeURIComponent(uid)}&select=disabled,quota_docs_per_day,quota_bytes`).catch(() => null);
  if (!r || !r.ok) return null;
  const [q] = await rowsOf(r);
  return q || { disabled: true };
}

// Seats for users besides #1: MDSHARE_MAX_USERS (read per request; 0 closes sign-up), default 50.
export const DEFAULT_MAX_USERS = 50;
export function maxUsers() {
  const n = Number.parseInt(process.env.MDSHARE_MAX_USERS ?? '', 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_USERS;
}

// Seats taken: users other than #1 (disabled ones too), counted up to `upTo`.
export async function countSeats(upTo) {
  const r = await request(USERS, `id=neq.${encodeURIComponent(SITE_OWNER_UID)}&select=id&limit=${Math.max(1, Number(upTo) || 1)}`);
  if (!r.ok) throw new Error(`seat count failed: ${r.status}`);
  return (await rowsOf(r)).length;
}

// Sign-up: a new user with this entry hash; label, quotas and disabled come only from here and the
// column defaults. Returns the new user's principal (it may mint the user's first token).
export async function createUser({ label, entryHash }) {
  assertEntryHash(entryHash);
  const r = await request(USERS, 'select=id', jsonInit('POST', { label: typeof label === 'string' ? label : null, entry_hash: entryHash }));
  if (!r.ok) throw new Error(`creating a user failed: ${r.status}`);
  const [row] = await rowsOf(r);
  if (!row || !isUid(row.id) || row.id === SITE_OWNER_UID) throw new Error('createUser: no new user id');
  return principal(row.id, 'signup');
}

// Entry link sign-in: the id of the user whose entry_hash is `hash` (compared in constant time), or
// null for no match, a disabled user or user #1 (the owner signs in with the password). UNSCOPED by
// nature, like the token lookup: the hash is the credential.
export async function findUserByEntry(hash) {
  if (typeof hash !== 'string' || !ENTRY_HASH.test(hash)) return null;
  const r = await request(USERS, `entry_hash=eq.${encodeURIComponent(hash)}&select=id,entry_hash,disabled`).catch(() => null);
  if (!r || !r.ok) return null;
  const rows = await rowsOf(r);
  const u = rows.length === 1 ? rows[0] : null;
  if (!u || !safeHexEqual(String(u.entry_hash), hash) || u.disabled !== false || !isUid(u.id) || u.id === SITE_OWNER_UID) return null;
  return u.id;
}

// A new entry link for `me`: the old hash is overwritten, so the old link stops working at once, and
// every session issued before now is signed out (gateSession). true when it changed. User #1 has none.
export async function rotateEntry(me, hash) {
  assertEntryHash(hash);
  const uid = uidOf(me);
  if (uid === SITE_OWNER_UID) throw new Refused(403, 'The owner signs in with the password; user #1 has no entry link.');
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(); // whole seconds, like the cookie
  const r = await request(USERS, `id=eq.${encodeURIComponent(uid)}&disabled=is.false&select=id`, jsonInit('PATCH', { entry_hash: hash, sessions_valid_after: now }));
  if (!r.ok) throw new Error(`rotating the entry link failed: ${r.status}`);
  return (await rowsOf(r)).length === 1;
}

// The owner's admin rights: user #1's own browser session (not a token).
export function isAdmin(me) {
  return readable(me) && me.via === 'cookie' && me.uid === SITE_OWNER_UID;
}

// The kill switch. Only the owner's session; never user #1 (G2). { user_id, disabled } | null (no such user).
export async function setUserDisabled(me, uid, disabled) {
  if (!isAdmin(me)) throw new Refused(403, 'Owner only');
  if (uid === SITE_OWNER_UID) throw new Refused(400, 'User #1 (the owner) can never be disabled');
  if (!isUid(uid)) throw new Refused(400, 'user_id must be a positive integer');
  const r = await request(USERS, `id=eq.${encodeURIComponent(uid)}&select=id,disabled`, jsonInit('PATCH', { disabled: disabled === true }));
  if (!r.ok) throw new Error(`disabling a user failed: ${r.status}`);
  const [row] = await rowsOf(r);
  return row ? { user_id: row.id, disabled: row.disabled === true } : null;
}

// Per-user counts for the owner (user #1's session, or a user-#1 token api/doc.js allowed): label,
// created_at, disabled, documents this week / last week / total, documents the user opened, last
// active. No content, no titles. { rows } | { dbError: true }.
export async function userStats(me) {
  if (!readable(me) || me.uid !== SITE_OWNER_UID) throw new Refused(403, 'Owner only');
  const r = await request(STATS_RPC, '', jsonInit('POST', {})).catch(() => null);
  if (!r || !r.ok) return { dbError: true };
  return { rows: await rowsOf(r) };
}
