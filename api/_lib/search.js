// Full-text search over documents (migration 011). api/doc.js `search` action is the HTTP surface.
// Underscore directory: not a Vercel function.
//
// Contract (scripts/check-invariants.mjs "search-no-filter-injection"): the search text reaches
// Postgres only as a JSON body to /rest/v1/rpc/mdshare_search, never inside a PostgREST filter
// string, where "," "(" ")" "*" would restructure the filter. One database call per search,
// however many rows match (tests/search.test.mjs pins it). Results carry a short plain-text
// snippet built here from a window of the body; the full content never leaves this module.

export const SEARCH_MAX_QUERY = 200;
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_MAX_OFFSET = 1000;
const SNIPPET_RADIUS = 80;

const int = (v, dflt, lo, hi) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// q: 1-200 characters after trimming; limit 1-50 (default 20); offset 0-1000.
export function validateSearch(query) {
  const raw = query && typeof query.q === 'string' ? query.q : '';
  const q = raw.trim();
  if (!q) return { error: 'Pass q=<text to search for> (1-200 characters)' };
  if ([...q].length > SEARCH_MAX_QUERY) return { error: `q is too long (max ${SEARCH_MAX_QUERY} characters)` };
  // Postgres text can't hold NUL or a lone surrogate; refuse them here instead of a 503 from the database.
  if (/\u0000/.test(q) || !q.isWellFormed()) return { error: 'q contains characters that cannot be searched' };
  return { value: { q, limit: int(query.limit, 20, 1, SEARCH_MAX_LIMIT), offset: int(query.offset ?? query.cursor, 0, 0, SEARCH_MAX_OFFSET) } };
}

// Markdown/HTML -> readable plain text. Tags are removed (and any "<" that could start one), so
// the snippet is HTML-free even when the window cut a tag in half.
export function plainText(s) {
  return String(s || '')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<\/?[A-Za-z][^>]*(>|$)/g, ' ')
    .replace(/<(?=[A-Za-z/!?])/g, '')
    .replace(/^-{3,}\s*$/gm, ' ')
    .replace(/```[\w-]*|~~~[\w-]*/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/:::\s*[\w-]*/g, ' ')
    .replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, ' ')
    .replace(/:badge\[([^\]]*)\](\{\w+\})?/g, '$1')
    .replace(/(\*\*|__|==|~~|`)/g, '')
    .replace(/\*+(?=\S)|(?<=\S)\*+/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/(\s*·\s*){2,}/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ±80 characters of plain text around the first match of q in the excerpt window.
export function snippetFor(excerpt, q) {
  const text = plainText(excerpt);
  const chars = [...text];
  const lower = text.toLowerCase();
  const at = lower.length === text.length ? lower.indexOf(String(q).toLowerCase()) : -1;
  if (at < 0) return chars.slice(0, SNIPPET_RADIUS * 2).join('') + (chars.length > SNIPPET_RADIUS * 2 ? '…' : '');
  const start = [...text.slice(0, at)].length;
  const len = [...String(q)].length;
  let from = Math.max(0, start - SNIPPET_RADIUS);
  let to = Math.min(chars.length, start + len + SNIPPET_RADIUS);
  // Don't cut a Latin word in half at either edge (CJK has no spaces; leave it as is).
  const word = (c) => /[A-Za-z0-9]/.test(c || '');
  for (let k = 0; k < 20 && from > 0 && from < start && word(chars[from - 1]) && word(chars[from]); k++) from++;
  for (let k = 0; k < 20 && to < chars.length && to > start + len && word(chars[to - 1]) && word(chars[to]); k++) to--;
  return (from > 0 ? '…' : '') + chars.slice(from, to).join('').trim() + (to < chars.length ? '…' : '');
}

const kept = (r) => r.pinned === true || (typeof r.expires_at === 'string' && r.expires_at >= '2099');

// One POST to the mdshare_search function. Returns {results, total, limit, offset, next_offset}
// or {dbError: true}.
export async function searchDocs({ q, limit, offset }) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  let rows;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/mdshare_search`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, lim: limit, skip: offset }),
    });
    if (!res.ok) return { dbError: true };
    rows = await res.json();
  } catch {
    return { dbError: true };
  }
  if (!Array.isArray(rows)) return { dbError: true };
  const total = rows.length ? Number(rows[0].total) || rows.length : 0;
  const results = rows.map((r) => ({
    id: r.id,
    title: r.title || 'Untitled',
    snippet: snippetFor(r.excerpt, q),
    created_at: r.created_at || null,
    kept: kept(r),
    is_public: r.is_public === true,
    expires_at: r.expires_at || null,
    kind: 'paste',
    url: `/v/${encodeURIComponent(r.id)}`,
  }));
  const next = offset + results.length;
  return { q, results, total, limit, offset, next_offset: results.length === limit && next < total && next <= SEARCH_MAX_OFFSET ? next : null };
}
