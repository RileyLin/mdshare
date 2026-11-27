// Reading-loop data: read receipts, paragraph feedback and version links (migration 009).
// Underscore directory: not a Vercel function. api/doc.js is the HTTP surface; api/render.js and
// api/share.js use versionInfo()/canUseParent().
//
// Contract: this module never writes a content table. activityWrite() only accepts
// ACTIVITY_TABLES (checked by scripts/check-invariants.mjs "activity-writes-allowlist" and
// tests/activity.test.mjs); content rows are only read here.
// Multi-user (2026-11-27): every query goes through api/_lib/tenant.js scoped to `me`, the
// request's principal (ownerOf): a user's reads, feedback, versions and translations are their own.
import { hasScope } from './agent-tokens.js';
import { isValidId, ownerOf, rowOwner, readOwned, selectOwned, patchOwned, insertOwned, SITE_OWNER_UID } from './tenant.js';
import { randomBytes } from 'crypto';

export const ACTIVITY_TABLES = ['mdshare_reads', 'mdshare_feedback'];
export const FEEDBACK_KINDS = ['example', 'unclear', 'wrong', 'expand', 'note'];
export const FEEDBACK_STATUSES = ['open', 'resolved', 'dismissed'];

// The only write path in this module. Refuses anything but the activity tables; rows are `me`'s.
export async function activityWrite(table, me, method, query, body) {
  if (!ACTIVITY_TABLES.includes(table)) throw new Error(`activityWrite: ${table} is not an activity table`);
  if (method === 'POST') return insertOwned(table, me, body, { returning: true });
  if (method !== 'PATCH') throw new Error(`activityWrite: unsupported method ${method}`);
  const r = await patchOwned(table, me, query, body);
  if (!r.ok) throw new Error(`Supabase PATCH ${table} failed: ${r.error}`);
  return r.rows;
}

const nowIso = () => new Date().toISOString();
const alive = (r) => !!r && (r.pinned === true || !r.expires_at || new Date(r.expires_at) >= new Date());
const clampInt = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const inList = (ids) => encodeURIComponent(`(${ids.join(',')})`);

// ---------- Auth ----------
// Who may call an activity action. 'owner' = a signed-in user's session cookie (acting on their own
// documents). 'owner|<scope>' = that, or a valid scoped agent token holding <scope> (acting for its
// own user); 'owner|<a>,<b>' = holding either. A present Bearer decides (ownerOf). Never anonymous,
// never a legacy token. 'admin|<scope>' (P3, the owner's stats) is the same, but only for user #1.
export function allowed(auth, req, res, agentAuth) {
  const me = ownerOf(req, res, agentAuth || null);
  if (!me) return false;
  if (auth.startsWith('admin') && me.uid !== SITE_OWNER_UID) return false;
  if (me.via === 'cookie') return true;
  if (auth === 'owner' || auth === 'admin') return false;
  const scopes = (auth.split('|')[1] || '').split(',').filter(Boolean);
  return !!(scopes.length && agentAuth && agentAuth.valid && scopes.some((s) => hasScope(agentAuth, s)));
}

// ---------- Versions ----------
// Every version stores root_id (the first version's id) and version_no at write time
// (migration 010), so reads cost one query per page view and two for the API, however long the
// chain gets. The first version keeps root_id/version_no NULL (its own id, version 1). An earlier
// build walked parent links one query per hop on every page view; the 2026-11-25 adversarial
// review showed a 25-long chain turned one anonymous view into 21 sequential queries.
// tests/reading-loop.test.mjs pins the query counts.
export const MAX_VERSIONS = 100;
const rootOf = (row, id) => (row && row.root_id) || id;
const versionNoOf = (row) => (row && Number.isInteger(row.version_no) && row.version_no > 0 ? row.version_no : 1);
const byVersion = (a, b) => versionNoOf(a) - versionNoOf(b) || String(a.created_at || '').localeCompare(String(b.created_at || ''));

// root_id + version_no for a new version of parentRow (needs id, root_id, version_no).
export function versionFields(parentRow) {
  return { root_id: rootOf(parentRow, parentRow.id), version_no: versionNoOf(parentRow) + 1 };
}

// May this request create a new version of `parentId`? Only a document of the requester's own user:
// the signed-in user, or an agent token of that user that can read the parent (documents:read, or
// it created the parent). Anonymous creates never can: a stranger must not be able to attach a
// "newer version" banner to someone's document (invariant "version-parent-gated"); another user's
// document is the same "not found". Translations use the stricter canLinkTranslation().
export async function canUseParent(parentId, req, res, agentAuth) {
  if (typeof parentId !== 'string' || !isValidId(parentId)) return { ok: false };
  const me = ownerOf(req, res, agentAuth || null);
  const { row, dbError } = await readOwned('mdshare_pastes', me, parentId, 'id,created_by_token,expires_at,pinned,root_id,version_no,lang,translation_of,collection');
  if (dbError) return { ok: false, dbError: true };
  if (!row) return { ok: false };
  if (me.via === 'cookie') return { ok: true, row };
  if (agentAuth && agentAuth.valid && (hasScope(agentAuth, 'documents:read') || row.created_by_token === agentAuth.id)) return { ok: true, row };
  return { ok: false };
}

// Version + translation facts for the reader page, from ONE query however large the family:
// my version family (root_id = R) plus the translation group G (its root's family and every row
// whose translation_of is G). Owner: parent id, version number, newest later version, the
// translation. Reader: the newest later version and the translation only when they are public.
// "Later" means a higher version number in the same family, so a branch (two v2s of one v1)
// points at the newest of them. A DB error degrades to "no version info" rather than breaking the page.
export async function versionInfo(id, row, { owner }) {
  const mine = versionNoOf(row);
  const out = { parentId: row && row.parent_id ? row.parent_id : null, versionNo: owner ? mine : null, newerId: null, newerTitle: null, translation: null, lang: (row && row.lang) || null };
  try {
    const root = rootOf(row, id);
    const group = (row && row.translation_of) || root;
    if (!isValidId(root) || !isValidId(group)) return out;
    const conds = group === root ? `root_id.eq.${root},id.eq.${root},translation_of.eq.${root}` : `root_id.eq.${root},id.eq.${group},root_id.eq.${group},translation_of.eq.${group}`;
    const family = (await selectOwned('mdshare_pastes', rowOwner(row), `or=${encodeURIComponent(`(${conds})`)}&select=id,title,is_public,expires_at,pinned,version_no,created_at,root_id,lang,translation_of&order=created_at.desc&limit=${MAX_VERSIONS * 2}`))
      .filter((r) => alive(r) && r.id !== id);
    const later = family.filter((r) => r.root_id === root && versionNoOf(r) > mine).sort((a, b) => byVersion(b, a));
    const newest = later[0];
    if (newest && (owner || newest.is_public === true)) {
      out.newerId = newest.id;
      out.newerTitle = newest.title || null;
    }
    // The translation: outside my version family, in another language, visible to this viewer.
    const myLang = out.lang;
    const sibling = family
      .filter((r) => r.id !== root && r.root_id !== root && (owner || r.is_public === true))
      .filter((r) => (myLang ? (r.lang || otherLang(myLang)) !== myLang : !!r.lang))
      .sort((a, b) => byVersion(b, a))[0];
    if (sibling) {
      const lang = sibling.lang || otherLang(myLang);
      out.translation = { id: sibling.id, lang, title: sibling.title || null, isPublic: sibling.is_public === true };
      out.lang = myLang || otherLang(lang);
    }
  } catch {
    return { parentId: owner ? out.parentId : null, versionNo: owner ? out.versionNo : null, newerId: null, newerTitle: null, translation: null, lang: (row && row.lang) || null };
  }
  return out;
}

// The whole family for the API, oldest first: one query for the row, one for the family. Both are
// `me`'s rows only: another user's id is the same null as a missing one.
export async function versionChain(me, id) {
  const self = await selectOwned('mdshare_pastes', me, `id=eq.${encodeURIComponent(id)}&select=id,root_id`);
  if (!self[0]) return null;
  const root = rootOf(self[0], id);
  if (!isValidId(root)) return null;
  const family = await selectOwned('mdshare_pastes', me, `or=${encodeURIComponent(`(id.eq.${root},root_id.eq.${root})`)}&select=id,title,created_at,parent_id,expires_at,pinned,version_no&limit=${MAX_VERSIONS}`);
  return family.sort(byVersion).map((r) => ({ id: r.id, title: r.title || null, created_at: r.created_at || null, version: versionNoOf(r), parent: r.parent_id || null, expired: !alive(r) }));
}

// ---------- Translations (migration 012) ----------
// A translation group is named by its root: the version root of the original document. Linking to
// any member stores that root, so one query finds the whole group (see versionInfo).
export const LANGS = ['zh', 'en'];
export const translationRoot = (row) => (row && row.translation_of) || rootOf(row, row && row.id);
export function translationFields(targetRow) {
  return { translation_of: translationRoot(targetRow) };
}

// May this request link a document as the translation of `targetId`? A link puts a 中文/English
// switch on every page of the group, so: only within the requester's own user (readOwned); the
// signed-in user, any pair of theirs; a token, only when it created both
// the target and the group the link joins (translationRoot(target), which is what gets stored),
// never because it can read the target (documents:read) or the target is public (ADV-B finding 2,
// 2026-11-26). The other side, the document being linked, is the token's own: a new create, or
// canEditMeta() in the translation action. A refusal is { ok: false }, the same as a missing id.
// Invariant "translation-gated".
export async function canLinkTranslation(targetId, req, res, agentAuth) {
  if (typeof targetId !== 'string' || !isValidId(targetId)) return { ok: false };
  const me = ownerOf(req, res, agentAuth || null);
  const { row, dbError } = await readOwned('mdshare_pastes', me, targetId, 'id,created_by_token,expires_at,pinned,root_id,version_no,lang,translation_of,collection');
  if (dbError) return { ok: false, dbError: true };
  if (!row) return { ok: false };
  if (me.via === 'cookie') return { ok: true, row };
  const mine = (r) => !!(r && agentAuth && agentAuth.valid && r.created_by_token && r.created_by_token === agentAuth.id);
  if (!mine(row)) return { ok: false };
  const group = translationRoot(row);
  if (group === row.id) return { ok: true, row };
  const g = await readOwned('mdshare_pastes', me, group, 'id,created_by_token,expires_at,pinned');
  if (g.dbError) return { ok: false, dbError: true };
  return mine(g.row) ? { ok: true, row } : { ok: false };
}
// 'zh' | 'en' | null for absent; undefined for anything else (the caller answers 400).
export function parseLang(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return LANGS.includes(s) ? s : undefined;
}
// The reader's own heuristic (api/render.js): more than 30 CJK characters is a Chinese document.
export const detectLang = (markdown) => ((String(markdown || '').match(/[\u3400-\u9fff]/g) || []).length > 30 ? 'zh' : 'en');
const otherLang = (l) => (l === 'zh' ? 'en' : l === 'en' ? 'zh' : null);

// ---------- Read receipts (the document's owner only; called by api/doc.js after the auth check) ----------
export async function recordRead(me, id, { scroll, seconds, open }) {
  const rows = await selectOwned('mdshare_reads', me, `doc_id=eq.${encodeURIComponent(id)}&select=doc_id,open_count,max_scroll,active_seconds`);
  const s = clampInt(scroll, 0, 100);
  const sec = clampInt(seconds, 0, 900);
  const t = nowIso();
  if (!rows[0]) {
    await activityWrite('mdshare_reads', me, 'POST', '', { doc_id: id, first_opened_at: t, last_opened_at: t, open_count: 1, max_scroll: s, active_seconds: sec });
    return;
  }
  const r = rows[0];
  await activityWrite('mdshare_reads', me, 'PATCH', `doc_id=eq.${encodeURIComponent(id)}`, {
    last_opened_at: t,
    open_count: (r.open_count || 0) + (open ? 1 : 0),
    max_scroll: Math.max(r.max_scroll || 0, s),
    active_seconds: Math.min(2147483647, (r.active_seconds || 0) + sec),
  });
}

// Read receipts for a set of document ids (the collection page's read status). One query.
export async function readsFor(me, ids) {
  const list = [...new Set(ids || [])].filter(isValidId);
  if (!list.length) return [];
  return selectOwned('mdshare_reads', me, `doc_id=in.(${list.map(encodeURIComponent).join(',')})&select=doc_id,max_scroll,open_count,last_opened_at`);
}

// Reads for a set of ids, or the unread documents created in the last `days` days.
export async function listReads(me, { ids, unread, days }) {
  if (unread) {
    const since = new Date(Date.now() - clampInt(days || 7, 1, 30) * 86400000).toISOString();
    const docs = await selectOwned('mdshare_pastes', me, `created_at=gte.${encodeURIComponent(since)}&select=id,title,created_at,origin,expires_at,pinned&order=created_at.desc&limit=200`);
    const live = docs.filter(alive);
    if (!live.length) return [];
    const reads = await selectOwned('mdshare_reads', me, `doc_id=in.${inList(live.map((d) => d.id))}&select=doc_id`);
    const seen = new Set(reads.map((r) => r.doc_id));
    return live.filter((d) => !seen.has(d.id)).map((d) => ({ id: d.id, title: d.title, created_at: d.created_at, origin: d.origin || null, opened: false }));
  }
  const list = (ids || []).filter(isValidId).slice(0, 100);
  if (!list.length) return [];
  const [docs, reads] = await Promise.all([
    selectOwned('mdshare_pastes', me, `id=in.${inList(list)}&select=id,title,created_at`),
    selectOwned('mdshare_reads', me, `doc_id=in.${inList(list)}&select=doc_id,first_opened_at,last_opened_at,open_count,max_scroll,active_seconds`),
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

export async function createFeedback(me, value) {
  const id = `fb_${randomBytes(9).toString('base64url').slice(0, 12)}`;
  const rows = await activityWrite('mdshare_feedback', me, 'POST', '', {
    id, doc_id: value.doc_id, kind: value.kind, quote: value.quote, note: value.note, context: value.context, status: 'open', created_at: nowIso(),
  });
  return rows[0] || { id };
}

export async function listFeedback(me, { docId, status }) {
  const parts = ['select=id,doc_id,kind,quote,note,context,status,resolved_in,created_at,resolved_at', 'order=created_at.desc', 'limit=100'];
  if (docId) parts.unshift(`doc_id=eq.${encodeURIComponent(docId)}`);
  if (status) parts.unshift(`status=eq.${encodeURIComponent(status)}`);
  const items = await selectOwned('mdshare_feedback', me, parts.join('&'));
  const ids = [...new Set(items.map((f) => f.doc_id))].filter(isValidId);
  const docs = ids.length ? await selectOwned('mdshare_pastes', me, `id=in.${inList(ids)}&select=id,title,origin`) : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return items.map((f) => ({ ...f, doc_title: byId.get(f.doc_id)?.title || null, origin: byId.get(f.doc_id)?.origin || null }));
}

export async function resolveFeedback(me, { ids, status, resolvedIn }) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string' && /^fb_[A-Za-z0-9_-]{6,20}$/.test(x)).slice(0, 50);
  if (!list.length) return { error: 'Missing feedback id(s)' };
  if (!['resolved', 'dismissed', 'open'].includes(status)) return { error: 'status must be resolved, dismissed or open' };
  if (resolvedIn != null && !isValidId(resolvedIn)) return { error: 'Invalid resolved_in id' };
  const rows = await activityWrite('mdshare_feedback', me, 'PATCH', `id=in.${inList(list)}`, {
    status, resolved_in: status === 'open' ? null : (resolvedIn || null), resolved_at: status === 'open' ? null : nowIso(),
  });
  return { updated: rows.map((r) => r.id) };
}
