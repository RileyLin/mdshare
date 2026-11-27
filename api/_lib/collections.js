// Collections and document metadata (migration 012): the collection slug, and the one write path
// for metadata a document carries besides its content (lang, translation_of, collection).
// Underscore directory: not a Vercel function. api/doc.js (action=collection|translation) and
// api/_lib/collection-page.js (/c, /c/:slug) are the callers; api/share.js uses parseCollection.
//
// Contracts (scripts/check-invariants.mjs "collection-owner-only", "translation-gated"):
//  - patchMeta() refuses any field outside META_FIELDS, so this path can never change stored
//    Markdown, visibility, keep or expiry.
//  - A collection page costs a fixed number of queries however many documents, versions and
//    translations it has: TOC 3 (rows, their families, read receipts), index 1. No query in a loop.
//  - Multi-user (2026-11-27): every read and write is `me`'s rows only (api/_lib/tenant.js), so a
//    collection, its counts and its table of contents never include another user's documents.
import { readsFor, translationRoot } from './activity.js';
import { isValidId, ownerOf, readOwned, selectOwned, patchOwned } from './tenant.js';

export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
export const SLUG_HINT = 'collection must be a slug: 1-48 lowercase letters, digits and hyphens, starting and ending with a letter or digit (e.g. "glm-study")';
export const META_FIELDS = ['lang', 'translation_of', 'collection'];
export const TOC_LIMIT = 200;

// null when absent; the slug (trimmed, lowercased) when valid; undefined when invalid (400).
export function parseCollection(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return SLUG_PATTERN.test(s) ? s : undefined;
}

const alive = (r) => !!r && (r.pinned === true || !r.expires_at || new Date(r.expires_at) >= new Date());
const kept = (r) => !!r && (r.pinned === true || (typeof r.expires_at === 'string' && r.expires_at >= '2099'));
const rootOf = (r) => r.root_id || r.id;
const versionNoOf = (r) => (Number.isInteger(r.version_no) && r.version_no > 0 ? r.version_no : 1);
const newestFirst = (a, b) => versionNoOf(b) - versionNoOf(a) || String(b.created_at || '').localeCompare(String(a.created_at || ''));
const uniq = (xs) => [...new Set(xs)];
// Validated ids only ([A-Za-z0-9_-]), so the list needs no further quoting inside in.(...).
const idList = (ids) => uniq(ids).filter(isValidId).map(encodeURIComponent).join(',');
const LANG_ORDER = { zh: 0, en: 1 };
const COLS = 'id,title,created_at,expires_at,pinned,is_public,root_id,version_no,lang,translation_of,collection';

// ---------- Metadata writes ----------
// May this request change the metadata of document `id`? Only a document of the requester's own
// user (readOwned). The signed-in user: any of theirs. A token (the action's auth already required
// documents:write or documents:publish): only documents it created. Anything else is the same 404
// as a missing id.
export async function canEditMeta(id, req, res, agentAuth) {
  if (!isValidId(id)) return { ok: false, status: 400, error: 'Missing or invalid id' };
  const me = ownerOf(req, res, agentAuth || null);
  const { row, dbError } = await readOwned('mdshare_pastes', me, id, 'id,created_by_token,expires_at,pinned,root_id,version_no,lang,translation_of,collection');
  if (dbError) return { ok: false, status: 503, error: 'Temporarily unavailable' };
  if (row && me.via === 'cookie') return { ok: true, row, owner: true };
  if (row && agentAuth && agentAuth.valid && row.created_by_token === agentAuth.id) return { ok: true, row, owner: false };
  return { ok: false, status: 404, error: 'Not found, expired, or not editable with this credential' };
}

// The whole version family of `row` (a collection or a language belongs to the document, not to
// one version), limited to the token's own rows when a token is editing.
export function familyFilter(row, tokenId) {
  const root = encodeURIComponent(rootOf(row));
  return `or=(id.eq.${root},root_id.eq.${root})${tokenId ? `&created_by_token=eq.${encodeURIComponent(tokenId)}` : ''}`;
}

export async function patchMeta(me, filter, patch) {
  const keys = Object.keys(patch || {});
  if (!keys.length || keys.some((k) => !META_FIELDS.includes(k))) throw new Error(`patchMeta: only ${META_FIELDS.join(', ')} may be changed here`);
  const r = await patchOwned('mdshare_pastes', me, `${filter}&select=id`, Object.fromEntries(keys.map((k) => [k, patch[k]])));
  if (!r.ok) return { dbError: true };
  return { ids: r.rows.map((x) => x.id) };
}

// ---------- Reads ----------
// Every collection of `me` with its number of entries (translation groups) and newest date. One query.
export async function listCollections(me) {
  try {
    const rows = (await selectOwned('mdshare_pastes', me, 'collection=not.is.null&select=collection,id,root_id,translation_of,created_at,expires_at,pinned&order=created_at.desc&limit=5000')).filter(alive);
    const by = new Map();
    for (const r of rows) {
      if (!SLUG_PATTERN.test(String(r.collection))) continue;
      const c = by.get(r.collection) || { slug: r.collection, groups: new Set(), updated_at: null };
      c.groups.add(translationRoot(r));
      if (!c.updated_at || String(r.created_at) > c.updated_at) c.updated_at = r.created_at;
      by.set(r.collection, c);
    }
    return { items: [...by.values()].map((c) => ({ slug: c.slug, count: c.groups.size, updated_at: c.updated_at })).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.slug.localeCompare(b.slug)) };
  } catch {
    return { dbError: true };
  }
}

// The table of contents of one collection: one entry per translation group (a zh/en pair is one
// entry with both links), each language linking its newest live version (superseded versions are
// hidden), in series order (the entry's first document first). Three queries however large.
export async function collectionToc(me, slug) {
  try {
    const listed = (await selectOwned('mdshare_pastes', me, `collection=eq.${encodeURIComponent(slug)}&select=${COLS}&order=created_at.asc&limit=${TOC_LIMIT + 1}`)).filter(alive);
    const truncated = listed.length > TOC_LIMIT;
    const rows = listed.slice(0, TOC_LIMIT);
    if (!rows.length) return { items: [], truncated: false };
    const inCollection = new Set(rows.map((r) => r.id));
    const groups = uniq(rows.map(translationRoot)).filter(isValidId);
    const roots = uniq(rows.map(rootOf).concat(groups)).filter(isValidId);
    const missingRoots = groups.filter((g) => !inCollection.has(g));
    const conds = [missingRoots.length ? `id.in.(${idList(missingRoots)})` : null, `root_id.in.(${idList(roots)})`, `translation_of.in.(${idList(groups)})`].filter(Boolean);
    const family = await selectOwned('mdshare_pastes', me, `or=(${conds.join(',')})&select=${COLS}&limit=2000`);
    const all = new Map();
    for (const r of rows.concat(family)) if (alive(r) && !all.has(r.id)) all.set(r.id, r);

    // group -> version root -> rows
    const tree = new Map(groups.map((g) => [g, new Map()]));
    for (const r of all.values()) {
      const fams = tree.get(translationRoot(r));
      if (!fams) continue;
      const k = rootOf(r);
      if (!fams.has(k)) fams.set(k, []);
      fams.get(k).push(r);
    }
    const entries = [];
    for (const [key, fams] of tree) {
      const links = [];
      let start = null;
      let superseded = 0;
      let primary = null;
      for (const famRows of fams.values()) {
        famRows.sort(newestFirst);
        const newest = famRows[0];
        superseded += famRows.length - 1;
        for (const r of famRows) if (!start || String(r.created_at) < start) start = r.created_at;
        const link = { id: newest.id, lang: newest.lang || null, title: newest.title || null, version: versionNoOf(newest), created_at: newest.created_at || null, is_public: newest.is_public === true, kept: kept(newest), expires_at: newest.expires_at || null, pinned: newest.pinned === true, opened: false, max_scroll: 0, in_collection: famRows.some((r) => inCollection.has(r.id)) };
        links.push(link);
        if (link.in_collection && (!primary || String(famRows[famRows.length - 1].created_at) < String(primary.first))) primary = { link, first: famRows[famRows.length - 1].created_at };
      }
      if (!primary) continue;
      links.sort((a, b) => (LANG_ORDER[a.lang] ?? 2) - (LANG_ORDER[b.lang] ?? 2) || String(a.created_at).localeCompare(String(b.created_at)));
      entries.push({ key, title: primary.link.title, id: primary.link.id, start, updated_at: links.reduce((m, l) => (String(l.created_at) > String(m) ? l.created_at : m), ''), kept: links.some((l) => l.kept), superseded, links });
    }
    const ids = entries.flatMap((e) => e.links.map((l) => l.id));
    const reads = new Map((await readsFor(me, ids)).map((r) => [r.doc_id, r]));
    for (const e of entries) {
      for (const l of e.links) { const r = reads.get(l.id); if (r) { l.opened = true; l.max_scroll = r.max_scroll || 0; } }
      e.opened = e.links.some((l) => l.opened);
      e.max_scroll = Math.max(0, ...e.links.map((l) => l.max_scroll));
    }
    entries.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.key.localeCompare(b.key));
    return { items: entries, truncated };
  } catch {
    return { dbError: true };
  }
}
