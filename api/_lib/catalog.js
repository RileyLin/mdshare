// Scoped catalog search/recent across mdshare_pastes / mdshare_diagrams / mdshare_archify, for
// bearer tokens holding the `documents:read` scope (see api/_lib/agent-tokens.js, api/pastes.js).
// Standalone leaf module (same `_lib` convention as access.js/agent-tokens.js: underscore-prefixed
// dir, Vercel never routes it, no import cycle risk) so api/pastes.js can pull in real
// server-side search/pagination without duplicating Supabase REST plumbing.
//
// "Real server-side search" means: the ilike filter, the not-expired-or-pinned filter, and the
// limit/offset all travel in the Supabase REST query string and are evaluated by Postgres itself
// — never "fetch the latest N rows, then Array.filter() in Node" (which is what the existing
// owner-dashboard path in api/pastes.js still does, left untouched by this change; see
// AGENT-SEARCH-PLAN.md for why that path is out of scope here).
//
// Injection defense (see AGENT-SEARCH-PLAN.md "Design notes"): PostgREST parses its own filter
// grammar (`,` separates OR terms, `()` groups, `*` means SQL `%`) AFTER url-decoding the request
// line, so encodeURIComponent alone does not stop a crafted search term from restructuring the
// filter. sanitizeSearchTerm() neutralizes the characters that are structurally significant to
// that grammar in the *value* itself, before any URL-encoding happens. clampPagination() bounds
// limit/offset to small integers before they are ever string-interpolated.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MAX_QUERY_LEN = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MIN_OFFSET = 0;
const MAX_OFFSET = 5000;

// Characters that are structurally significant to PostgREST's filter grammar when they appear
// unquoted in a filter value: `,` (separates conditions inside and/or), `(` `)` (grouping), `*`
// (wildcard marker inside an ilike/like pattern, maps to SQL `%`). Rather than attempt PostgREST's
// documented-but-fiddly double-quote-escaping dance (which this repo cannot exercise against a
// real Supabase instance in CI), these are simply replaced with a space — the search becomes "the
// term with those characters treated as word breaks" instead of "the term able to restructure the
// filter", a safe, testable, intentional tradeoff documented here and in AGENT-SEARCH-PLAN.md.
const STRUCTURAL_CHARS = /[,()*]/g;

// SQL ILIKE wildcard characters. Escaped with a leading backslash (Postgres's default LIKE escape
// character) so a literal search for e.g. "50%" or "foo_bar" doesn't silently become a wildcard
// match against everything.
function escapeLikeWildcards(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Bounds and neutralizes a user-supplied search term before it is ever used to build a Supabase
 * filter string. Returns `null` for an empty/whitespace-only/missing input (callers treat that as
 * "no search term" -> recent/listing mode instead of search mode), otherwise a plain string
 * guaranteed to contain none of PostgREST's structural filter-grammar characters.
 */
export function sanitizeSearchTerm(q) {
  if (typeof q !== 'string') return null;
  let s = q.trim();
  if (!s) return null;
  s = s.slice(0, MAX_QUERY_LEN);
  s = s.replace(STRUCTURAL_CHARS, ' ').trim();
  if (!s) return null;
  return s;
}

/** Coerces/clamps limit+offset to safe, bounded integers before they reach any Supabase URL. */
export function clampPagination({ limit, offset } = {}) {
  let l = Number.parseInt(limit, 10);
  if (!Number.isFinite(l)) l = DEFAULT_LIMIT;
  l = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, l));

  let o = Number.parseInt(offset, 10);
  if (!Number.isFinite(o)) o = 0;
  o = Math.min(MAX_OFFSET, Math.max(MIN_OFFSET, o));

  return { limit: l, offset: o };
}

/**
 * Builds a PostgREST `or=(...)` filter fragment matching an already-sanitized term against one or
 * more columns via case-insensitive substring (`ilike.*term*`). Never call with raw/unsanitized
 * input — callers must run the term through sanitizeSearchTerm() first.
 */
function buildIlikeOr(columns, sanitizedTerm) {
  const escaped = escapeLikeWildcards(sanitizedTerm);
  const pattern = encodeURIComponent(`*${escaped}*`);
  const clauses = columns.map((c) => `${c}.ilike.${pattern}`);
  return `or=(${clauses.join(',')})`;
}

// Per-kind table + the columns searched for a text match, mirroring what's actually meaningful
// per content type (archify rows store rendered HTML/IR, not free text worth substring-matching —
// title + kind cover what a human would actually search for there).
const KIND_CONFIG = {
  paste: { table: 'mdshare_pastes', searchColumns: ['title', 'content'], select: 'id,title,created_at,expires_at,pinned,is_public,created_by_token' },
  diagram: { table: 'mdshare_diagrams', searchColumns: ['title', 'markdown'], select: 'id,title,created_at,expires_at,pinned,is_public,created_by_token' },
  archify: { table: 'mdshare_archify', searchColumns: ['title', 'kind'], select: 'id,title,kind,created_at,expires_at,pinned,is_public,created_by_token' },
};

const ALL_KINDS = Object.keys(KIND_CONFIG);

async function fetchKind(kind, { sanitizedTerm, limit, offset, nowIso }) {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) return [];
  const parts = [`select=${cfg.select}`];
  // Real server-side "not expired, or pinned" filter — `nowIso` is computed by this module in
  // app code (never user input), so it is always a safe literal even though it's interpolated.
  parts.push(`or=(expires_at.gt.${encodeURIComponent(nowIso)},pinned.eq.true)`);
  if (sanitizedTerm) parts.push(buildIlikeOr(cfg.searchColumns, sanitizedTerm));
  parts.push('order=created_at.desc');
  parts.push(`limit=${limit}`);
  parts.push(`offset=${offset}`);
  const url = `${SUPABASE_URL}/rest/v1/${cfg.table}?${parts.join('&')}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ kind, ...r }));
}

/**
 * Orchestrates a bounded, real server-side search/recent query across the requested content
 * kind(s). `q` undefined/empty -> recent/listing mode (no ilike filter, just the expiry filter +
 * ordering + pagination, still all server-side). `kind` one of 'paste'|'diagram'|'archify'|'all'
 * (default 'all').
 *
 * Known limitation (documented, not a bug): when kind is 'all', each of the 3 tables is
 * independently limited/offset at the Postgres level, then merged and re-sorted/truncated in this
 * function to the requested `limit` — pagination across the merged, heterogeneous result set is
 * best-effort (a given `offset` does not correspond to one single global row ordinal the way it
 * would for a single table). Requesting a specific `kind` gets exact, real pagination (the
 * limit/offset sent to Supabase for that one table *is* the final page). See
 * AGENT-SEARCH-PLAN.md / AGENT-SEARCH-RESULT.md for the full writeup.
 */
export async function searchCatalog({ q, kind, limit, offset } = {}) {
  const sanitizedTerm = sanitizeSearchTerm(q);
  const { limit: boundedLimit, offset: boundedOffset } = clampPagination({ limit, offset });
  const kinds = ALL_KINDS.includes(kind) ? [kind] : ALL_KINDS;
  const nowIso = new Date().toISOString();

  // Per-table fetch already asks Postgres for at most boundedLimit+boundedOffset worth of rows
  // (via its own limit/offset) — when multiple kinds are requested we over-fetch slightly (up to
  // boundedLimit rows per kind, offset 0..boundedOffset+boundedLimit range) purely so the merge
  // step below has enough rows per kind to produce a correctly-sorted top-N; still a small, fixed
  // bound per table, never an unbounded "fetch everything" scan.
  const perKindLimit = kinds.length > 1 ? boundedOffset + boundedLimit : boundedLimit;
  const perKindOffset = kinds.length > 1 ? 0 : boundedOffset;

  const results = await Promise.all(
    kinds.map((k) => fetchKind(k, { sanitizedTerm, limit: perKindLimit, offset: perKindOffset, nowIso }))
  );

  const merged = results.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const page = kinds.length > 1 ? merged.slice(boundedOffset, boundedOffset + boundedLimit) : merged;
  const has_more = kinds.length > 1
    ? merged.length > boundedOffset + boundedLimit
    : page.length === boundedLimit; // single-kind: can't know total without a count query; a full page implies there may be more.

  return { items: page, limit: boundedLimit, offset: boundedOffset, has_more };
}
