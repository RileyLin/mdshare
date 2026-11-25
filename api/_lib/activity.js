// Reading-loop data: read receipts, paragraph feedback and version links (migration 009).
// Underscore directory: not a Vercel function. api/doc.js is the HTTP surface; api/render.js and
// api/share.js use versionInfo()/canUseParent().
//
// Contract: this module never writes a content table. activityWrite() only accepts
// ACTIVITY_TABLES (checked by scripts/check-invariants.mjs "activity-writes-allowlist" and
// tests/activity.test.mjs); content rows are only read here.
import { isValidId, getRow } from './access.js';
import { hasScope } from './agent-tokens.js';
import { checkAuthAndRefresh } from '../auth.js';
import { randomBytes } from 'crypto';

export const ACTIVITY_TABLES = ['mdshare_reads', 'mdshare_feedback'];
export const FEEDBACK_KINDS = ['example', 'unclear', 'wrong', 'expand', 'note'];
export const FEEDBACK_STATUSES = ['open', 'resolved', 'dismissed'];
const MAX_CHAIN = 20;

function sbHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { Authorization: 'Bearer ' + key, apikey: key, ...(extra || {}) };
}

// GET any table (content tables are read-only from here). Returns rows or throws on DB error.
export async function sbSelect(table, query) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase select ${table} failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// The only write path in this module. Refuses anything but the activity tables.
export async function activityWrite(table, method, query, body) {
  if (!ACTIVITY_TABLES.includes(table)) throw new Error(`activityWrite: ${table} is not an activity table`);
  if (method !== 'POST' && method !== 'PATCH') throw new Error(`activityWrite: unsupported method ${method}`);
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method,
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${table} failed: ${res.status}`);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

const nowIso = () => new Date().toISOString();
const alive = (r) => !!r && (r.pinned === true || !r.expires_at || new Date(r.expires_at) >= new Date());
const clampInt = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const inList = (ids) => encodeURIComponent(`(${ids.join(',')})`);

// ---------- Auth ----------
// Who may call an activity action. 'owner' = the owner session cookie only. 'owner|<scope>' =
// the owner, or a valid scoped agent token holding <scope>. Never anonymous, never a legacy token.
export function allowed(auth, req, res, agentAuth) {
  if (checkAuthAndRefresh(req, res)) return true;
  if (auth === 'owner') return false;
  const scope = auth.split('|')[1];
  return !!(scope && agentAuth && agentAuth.valid && hasScope(agentAuth, scope));
}

// ---------- Versions ----------
// May this request create a new version of `parentId`? Only the owner, or an agent token that can
// read the parent (documents:read, or it created the parent). Anonymous creates never can: a
// stranger must not be able to attach a "newer version" banner to someone's document.
export async function canUseParent(parentId, req, res, agentAuth) {
  if (typeof parentId !== 'string' || !isValidId(parentId)) return { ok: false };
  const { row, dbError } = await getRow('mdshare_pastes', parentId, 'id,created_by_token,expires_at,pinned');
  if (dbError) return { ok: false, dbError: true };
  if (!row) return { ok: false };
  if (checkAuthAndRefresh(req, res)) return { ok: true, row };
  if (agentAuth && agentAuth.valid && (hasScope(agentAuth, 'documents:read') || row.created_by_token === agentAuth.id)) return { ok: true, row };
  return { ok: false };
}

// Version facts for the reader page. Owner: parent id, version number, newest descendant. Reader:
// only the newest descendant, and only when it is public. A DB error degrades to "no version
// info" rather than breaking the page.
export async function versionInfo(id, row, { owner }) {
  const out = { parentId: row && row.parent_id ? row.parent_id : null, versionNo: null, newerId: null, newerTitle: null };
  try {
    if (owner && out.parentId) {
      let n = 1;
      let cur = out.parentId;
      while (cur && n < MAX_CHAIN && isValidId(cur)) {
        const rows = await sbSelect('mdshare_pastes', `id=eq.${encodeURIComponent(cur)}&select=id,parent_id`);
        n++;
        cur = rows[0] ? rows[0].parent_id : null;
      }
      out.versionNo = n;
    } else if (owner) {
      out.versionNo = 1;
    }
    let cur = id;
    let newest = null;
    for (let k = 0; k < MAX_CHAIN; k++) {
      const kids = (await sbSelect('mdshare_pastes', `parent_id=eq.${encodeURIComponent(cur)}&select=id,title,is_public,expires_at,pinned&order=created_at.desc&limit=5`)).filter(alive);
      if (!kids.length) break;
      newest = kids[0];
      cur = newest.id;
    }
    if (newest && (owner || newest.is_public === true)) {
      out.newerId = newest.id;
      out.newerTitle = newest.title || null;
    }
  } catch {
    return { parentId: owner ? out.parentId : null, versionNo: owner ? out.versionNo : null, newerId: null, newerTitle: null };
  }
  return out;
}

// Chain for the API: oldest → newest, at most MAX_CHAIN each way.
export async function versionChain(id) {
  const up = [];
  let cur = id;
  for (let k = 0; k < MAX_CHAIN && cur && isValidId(cur); k++) {
    const rows = await sbSelect('mdshare_pastes', `id=eq.${encodeURIComponent(cur)}&select=id,title,created_at,parent_id,expires_at,pinned`);
    if (!rows[0]) break;
    up.unshift(rows[0]);
    cur = rows[0].parent_id;
  }
  if (!up.length) return null;
  const down = [];
  cur = id;
  for (let k = 0; k < MAX_CHAIN; k++) {
    const kids = (await sbSelect('mdshare_pastes', `parent_id=eq.${encodeURIComponent(cur)}&select=id,title,created_at,parent_id,expires_at,pinned&order=created_at.desc&limit=5`)).filter(alive);
    if (!kids.length) break;
    down.push(kids[0]);
    cur = kids[0].id;
  }
  const shape = (r, i) => ({ id: r.id, title: r.title || null, created_at: r.created_at || null, version: i + 1, expired: !alive(r) });
  return [...up, ...down].map(shape);
}

// ---------- Read receipts (owner only; called by api/doc.js after the auth check) ----------
export async function recordRead(id, { scroll, seconds, open }) {
  const rows = await sbSelect('mdshare_reads', `doc_id=eq.${encodeURIComponent(id)}&select=doc_id,open_count,max_scroll,active_seconds`);
  const s = clampInt(scroll, 0, 100);
  const sec = clampInt(seconds, 0, 900);
  const t = nowIso();
  if (!rows[0]) {
    await activityWrite('mdshare_reads', 'POST', '', { doc_id: id, first_opened_at: t, last_opened_at: t, open_count: 1, max_scroll: s, active_seconds: sec });
    return;
  }
  const r = rows[0];
  await activityWrite('mdshare_reads', 'PATCH', `doc_id=eq.${encodeURIComponent(id)}`, {
    last_opened_at: t,
    open_count: (r.open_count || 0) + (open ? 1 : 0),
    max_scroll: Math.max(r.max_scroll || 0, s),
    active_seconds: Math.min(2147483647, (r.active_seconds || 0) + sec),
  });
}

// Reads for a set of ids, or the unread documents created in the last `days` days.
export async function listReads({ ids, unread, days }) {
  if (unread) {
    const since = new Date(Date.now() - clampInt(days || 7, 1, 30) * 86400000).toISOString();
    const docs = await sbSelect('mdshare_pastes', `created_at=gte.${encodeURIComponent(since)}&select=id,title,created_at,origin,expires_at,pinned&order=created_at.desc&limit=200`);
    const live = docs.filter(alive);
    if (!live.length) return [];
    const reads = await sbSelect('mdshare_reads', `doc_id=in.${inList(live.map((d) => d.id))}&select=doc_id`);
    const seen = new Set(reads.map((r) => r.doc_id));
    return live.filter((d) => !seen.has(d.id)).map((d) => ({ id: d.id, title: d.title, created_at: d.created_at, origin: d.origin || null, opened: false }));
  }
  const list = (ids || []).filter(isValidId).slice(0, 100);
  if (!list.length) return [];
  const [docs, reads] = await Promise.all([
    sbSelect('mdshare_pastes', `id=in.${inList(list)}&select=id,title,created_at`),
    sbSelect('mdshare_reads', `doc_id=in.${inList(list)}&select=doc_id,first_opened_at,last_opened_at,open_count,max_scroll,active_seconds`),
  ]);
  const byId = new Map(reads.map((r) => [r.doc_id, r]));
  return docs.map((d) => {
    const r = byId.get(d.id);
    return r
      ? { id: d.id, title: d.title, created_at: d.created_at, opened: true, first_opened_at: r.first_opened_at, last_opened_at: r.last_opened_at, open_count: r.open_count, max_scroll: r.max_scroll, active_seconds: r.active_seconds }
      : { id: d.id, title: d.title, created_at: d.created_at, opened: false };
  });
}

// ---------- Feedback ----------
export function validateFeedback(body) {
  const b = body || {};
  if (!isValidId(b.id)) return { error: 'Missing or invalid id' };
  if (!FEEDBACK_KINDS.includes(b.kind)) return { error: `kind must be one of ${FEEDBACK_KINDS.join(', ')}` };
  const quote = clip(b.quote, 1000);
  const note = clip(b.note, 2000);
  if (!(quote && quote.trim()) && !(note && note.trim())) return { error: 'Select some text or write a note' };
  if (b.kind === 'note' && !(note && note.trim())) return { error: 'A note needs text' };
  const c = b.context && typeof b.context === 'object' ? b.context : {};
  const context = { heading: clip(c.heading, 200), before: clip(c.before, 200), after: clip(c.after, 200) };
  return { value: { doc_id: b.id, kind: b.kind, quote: quote || null, note: note || null, context } };
}

export async function createFeedback(value) {
  const id = `fb_${randomBytes(9).toString('base64url').slice(0, 12)}`;
  const rows = await activityWrite('mdshare_feedback', 'POST', '', {
    id, doc_id: value.doc_id, kind: value.kind, quote: value.quote, note: value.note, context: value.context, status: 'open', created_at: nowIso(),
  });
  return rows[0] || { id };
}

export async function listFeedback({ docId, status }) {
  const parts = ['select=id,doc_id,kind,quote,note,context,status,resolved_in,created_at,resolved_at', 'order=created_at.desc', 'limit=100'];
  if (docId) parts.unshift(`doc_id=eq.${encodeURIComponent(docId)}`);
  if (status) parts.unshift(`status=eq.${encodeURIComponent(status)}`);
  const items = await sbSelect('mdshare_feedback', parts.join('&'));
  const ids = [...new Set(items.map((f) => f.doc_id))].filter(isValidId);
  const docs = ids.length ? await sbSelect('mdshare_pastes', `id=in.${inList(ids)}&select=id,title,origin`) : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return items.map((f) => ({ ...f, doc_title: byId.get(f.doc_id)?.title || null, origin: byId.get(f.doc_id)?.origin || null }));
}

export async function resolveFeedback({ ids, status, resolvedIn }) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string' && /^fb_[A-Za-z0-9_-]{6,20}$/.test(x)).slice(0, 50);
  if (!list.length) return { error: 'Missing feedback id(s)' };
  if (!['resolved', 'dismissed', 'open'].includes(status)) return { error: 'status must be resolved, dismissed or open' };
  if (resolvedIn != null && !isValidId(resolvedIn)) return { error: 'Invalid resolved_in id' };
  const rows = await activityWrite('mdshare_feedback', 'PATCH', `id=in.${inList(list)}`, {
    status, resolved_in: status === 'open' ? null : (resolvedIn || null), resolved_at: status === 'open' ? null : nowIso(),
  });
  return { updated: rows.map((r) => r.id) };
}
