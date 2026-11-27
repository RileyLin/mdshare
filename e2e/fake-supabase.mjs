// e2e/fake-supabase.mjs
//
// A tiny in-memory HTTP server implementing exactly the PostgREST subset that mdshare's api/*.js
// files actually use (verified by reading every `fetch(`${SUPABASE_URL}/rest/v1/...`)` call in
// api/** and api/_lib/**). No real network, no real Supabase — pure Node http + an in-memory Map
// per table, fresh on every startFakeSupabase() call.
//
// Supported shapes (see E2E-PLAN.md for the full list this was derived from):
//   GET    /rest/v1/<table>?select=...&id=eq.<id>                                (single row)
//   GET    /rest/v1/<table>?select=...&token_hash=eq.<hash>                      (token lookup)
//   GET    /rest/v1/<table>?select=...&or=(expires_at.gt.<iso>,pinned.eq.true)
//            &[or=(col.ilike.*term*,...)]&order=<col.dir[,col.dir]>&limit=N[&offset=N]
//   POST   /rest/v1/<table>                      (insert; Prefer: return=minimal|representation)
//   PATCH  /rest/v1/<table>?id=eq.<id>[&revoked_at=is.null]  (partial update; also doc_id=eq., id=in.())
//   GET    ...&<col>=in.(a,b,c)  &<col>=gte.<iso>                (activity tables, migration 009)
//   DELETE /rest/v1/<table>?id=eq.<id>
//   POST   /rest/v1/rpc/mdshare_search_owned {p_owner, q, lim, skip}   (migrations 011 + 013; same
//            semantics as the SQL; a call without an integer p_owner is a 404 like PostgREST's PGRST202)
//   GET    ...&or=(id.in.(a,b),root_id.in.(a,b),translation_of.eq.x)  &collection=not.is.null  (migration 012)
//
// Anything that doesn't match one of the above shapes gets a 501 naming the unmatched
// method+path+query, so a harness gap is loud (visible in report.json / terminal) instead of a
// silently-wrong response.
import http from 'node:http';

const KNOWN_TABLES = ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify', 'mdshare_agent_tokens', 'mdshare_events', 'mdshare_reads', 'mdshare_feedback'];
// Migration 013: every user table has owner_id. A seeded row defaults to user #1 (what the
// migration's DEFAULT 1 backfilled); an insert from the app must name its owner explicitly
// (api/_lib/tenant.js insertOwned always does), so a code path that forgets is a loud 400 here.
const OWNER_TABLES = KNOWN_TABLES;

// Column defaults mirroring migrations/001-009 *.sql. Only applied to a field the insert body did
// not already set (the app always sets most of these explicitly on create; this only covers what
// a real Postgres DEFAULT would silently fill in).
const TABLE_DEFAULTS = {
  mdshare_pastes: () => ({ owner_id: 1, is_public: false, pinned: false, created_at: new Date().toISOString(), created_by_token: null, title: null, parent_id: null, root_id: null, version_no: null, origin: null, lang: null, translation_of: null, collection: null }),
  mdshare_diagrams: () => ({ owner_id: 1, is_public: false, pinned: false, created_at: new Date().toISOString(), created_by_token: null, markdown: null }),
  mdshare_archify: () => ({ owner_id: 1, is_public: false, pinned: false, created_at: new Date().toISOString(), created_by_token: null, ir: null, markdown: null }),
  mdshare_agent_tokens: () => ({ owner_id: 1, created_at: new Date().toISOString(), revoked_at: null, last_used_at: null, scopes: null, expires_at: null }),
  mdshare_events: () => ({ owner_id: 1, created_at: new Date().toISOString(), detail: null, commit: null }),
  mdshare_reads: () => ({ owner_id: 1, first_opened_at: new Date().toISOString(), last_opened_at: new Date().toISOString(), open_count: 0, max_scroll: 0, active_seconds: 0 }),
  mdshare_feedback: () => ({ owner_id: 1, created_at: new Date().toISOString(), status: 'open', resolved_in: null, resolved_at: null, quote: null, note: null, context: null }),
};

class UnsupportedQueryError extends Error {}

function escapeRegExp(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// PostgREST ilike pattern -> RegExp. '*' is the wildcard (maps to SQL '%'); a backslash escapes
// the character after it literally (matches api/_lib/catalog.js's escapeLikeWildcards, which
// backslash-escapes literal '%'/'_'/'\\' in the search term before this wildcard-wrapping step).
function ilikePatternToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegExp(pattern[i + 1]);
      i++;
      continue;
    }
    if (c === '*') {
      out += '.*';
      continue;
    }
    out += escapeRegExp(c);
  }
  return new RegExp(`^${out}$`, 'is');
}

function coerceEq(fieldVal, rawVal) {
  if (rawVal === 'true') return fieldVal === true;
  if (rawVal === 'false') return fieldVal === false;
  if (rawVal === 'null') return fieldVal === null || fieldVal === undefined;
  if (typeof fieldVal === 'number' && rawVal !== '' && !Number.isNaN(Number(rawVal))) {
    return fieldVal === Number(rawVal);
  }
  return String(fieldVal) === rawVal;
}

// Splits "col.op.value" on the first two dots (value itself may contain dots, e.g. ISO timestamps).
function parseConditionString(cond) {
  const i1 = cond.indexOf('.');
  if (i1 < 0) throw new UnsupportedQueryError(`malformed condition (no operator): ${cond}`);
  const col = cond.slice(0, i1);
  const rest = cond.slice(i1 + 1);
  const i2 = rest.indexOf('.');
  if (i2 < 0) throw new UnsupportedQueryError(`malformed condition (no value): ${cond}`);
  const op = rest.slice(0, i2);
  const val = rest.slice(i2 + 1);
  return { col, op, val };
}

// Range filters: numbers compare as numbers (version_no=gt.2), everything else as timestamps.
// A NULL column never satisfies a range filter, like SQL.
function compareRange(fieldVal, rawVal) {
  if (fieldVal === null || fieldVal === undefined) return NaN;
  if (typeof fieldVal === 'number') return fieldVal - Number(rawVal);
  return new Date(fieldVal).getTime() - new Date(rawVal).getTime();
}

function evalCondition(row, { col, op, val }) {
  switch (op) {
    case 'eq':
      return coerceEq(row[col], val);
    case 'neq':
      return !coerceEq(row[col], val);
    case 'is':
      return val === 'null' ? row[col] === null || row[col] === undefined : coerceEq(row[col], val);
    case 'not': {
      // not.<op>.<value>, e.g. collection=not.is.null
      const inner = parseConditionString(`${col}.${val}`);
      return !evalCondition(row, inner);
    }
    case 'gt':
      return compareRange(row[col], val) > 0;
    case 'gte':
      return compareRange(row[col], val) >= 0;
    case 'lt':
      return compareRange(row[col], val) < 0;
    case 'lte':
      return compareRange(row[col], val) <= 0;
    case 'ilike':
      return row[col] != null && ilikePatternToRegExp(val).test(String(row[col]));
    case 'in': {
      // in.(a,b,c) — values never contain commas or parens here (validated ids only).
      if (!val.startsWith('(') || !val.endsWith(')')) throw new UnsupportedQueryError(`malformed in.() list: ${val}`);
      const list = val.slice(1, -1).split(',').filter(Boolean);
      return list.some((v) => coerceEq(row[col], v));
    }
    default:
      throw new UnsupportedQueryError(`unsupported filter operator "${op}" on column "${col}"`);
  }
}

// Parses one `or=(cond,cond,...)` group into a list of {col,op,val}. Commas inside a nested
// in.(a,b) list belong to that list (migration 012's family queries); values themselves never
// contain commas or parens (validated ids, ISO timestamps, escaped search terms).
function parseOrGroup(group) {
  const trimmed = group.trim();
  const inner = trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(parseConditionString);
}

function buildFilterFn(searchParams) {
  const andFns = [];
  for (const key of new Set(searchParams.keys())) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(key)) continue;
    const value = searchParams.get(key);
    const cond = parseConditionString(`${key}.${value}`);
    andFns.push((row) => evalCondition(row, cond));
  }
  for (const group of searchParams.getAll('or')) {
    const conds = parseOrGroup(group);
    andFns.push((row) => conds.some((c) => evalCondition(row, c)));
  }
  return (row) => andFns.every((fn) => fn(row));
}

function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const fields = orderParam.split(',').map((f) => {
    const [col, dir] = f.split('.');
    return { col, dir: dir || 'asc' };
  });
  const toSortVal = (v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === undefined) return -Infinity;
    const asDate = Date.parse(v);
    if (!Number.isNaN(asDate) && typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v)) return asDate;
    if (typeof v === 'number') return v;
    return v;
  };
  return [...rows].sort((a, b) => {
    for (const { col, dir } of fields) {
      const av = toSortVal(a[col]);
      const bv = toSortVal(b[col]);
      let cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (dir === 'desc') cmp = -cmp;
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function project(row, selectParam) {
  if (!selectParam || selectParam === '*') return { ...row };
  const cols = selectParam.split(',');
  const out = {};
  for (const c of cols) out[c] = row[c] !== undefined ? row[c] : null;
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parsePrefer(req) {
  const header = req.headers['prefer'] || '';
  const parts = header.split(',').map((s) => s.trim());
  const ret = parts.find((p) => p.startsWith('return='));
  return { return: ret ? ret.slice('return='.length) : null };
}

export async function startFakeSupabase({ port = 0 } = {}) {
  /** @type {Record<string, any[]>} */
  const tables = Object.fromEntries(KNOWN_TABLES.map((t) => [t, []]));

  function handleGet(table, searchParams, res) {
    const filterFn = buildFilterFn(searchParams);
    let rows = tables[table].filter(filterFn);
    rows = applyOrder(rows, searchParams.get('order'));
    const offset = searchParams.get('offset');
    const limit = searchParams.get('limit');
    if (offset) rows = rows.slice(Number(offset));
    if (limit) rows = rows.slice(0, Number(limit));
    const projected = rows.map((r) => project(r, searchParams.get('select')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(projected));
  }

  async function handlePost(table, req, res) {
    const bodyText = await readBody(req);
    let body;
    try {
      body = JSON.parse(bodyText || '{}');
    } catch {
      throw new UnsupportedQueryError(`POST body was not valid JSON: ${bodyText.slice(0, 200)}`);
    }
    if (OWNER_TABLES.includes(table) && !Object.prototype.hasOwnProperty.call(body, 'owner_id')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `fake-supabase: insert into ${table} without owner_id (the app must always set it, migration 013)` }));
      return;
    }
    const defaults = TABLE_DEFAULTS[table] ? TABLE_DEFAULTS[table]() : {};
    const row = { ...defaults, ...body };
    tables[table].push(row);
    const prefer = parsePrefer(req);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    if (prefer.return === 'representation') {
      res.end(JSON.stringify([row]));
    } else {
      res.end('');
    }
  }

  async function handlePatch(table, searchParams, req, res) {
    const bodyText = await readBody(req);
    let patch;
    try {
      patch = JSON.parse(bodyText || '{}');
    } catch {
      throw new UnsupportedQueryError(`PATCH body was not valid JSON: ${bodyText.slice(0, 200)}`);
    }
    const filterFn = buildFilterFn(searchParams);
    const matched = [];
    for (const row of tables[table]) {
      if (filterFn(row)) {
        Object.assign(row, patch);
        matched.push(row);
      }
    }
    const prefer = parsePrefer(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (prefer.return === 'representation') {
      res.end(JSON.stringify(matched));
    } else {
      res.end(matched.length ? JSON.stringify(matched) : '[]');
    }
  }

  function handleDelete(table, searchParams, res) {
    const filterFn = buildFilterFn(searchParams);
    const kept = [];
    const removed = [];
    for (const row of tables[table]) {
      if (filterFn(row)) removed.push(row);
      else kept.push(row);
    }
    tables[table] = kept;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(removed));
  }

  // Mirrors migrations/013 mdshare_search_owned (011's body + `owner_id = p_owner`): only p_owner's
  // rows; literal, case-insensitive substring of the trimmed q in
  // title or content (LIKE wildcards escaped there, so a plain includes() here); expired unkept
  // rows excluded; title matches first, then newest, then id; lim 1-50, skip 0-1000; an excerpt
  // window around the first match; total = all matching rows.
  async function handleRpc(name, req, res) {
    if (name !== 'mdshare_search_owned') throw new UnsupportedQueryError(`unknown rpc: ${name} (the app searches only through mdshare_search_owned with p_owner)`);
    let args;
    try { args = JSON.parse((await readBody(req)) || '{}'); } catch { throw new UnsupportedQueryError('rpc body was not valid JSON'); }
    if (!Number.isSafeInteger(args.p_owner)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.mdshare_search_owned without p_owner' }));
      return;
    }
    const q = String(args.q ?? '').trim();
    const lq = q.toLowerCase();
    const clamp = (v, d, lo, hi) => { const n = Number.isInteger(v) ? v : d; return Math.min(hi, Math.max(lo, n)); };
    const lim = clamp(args.lim, 20, 1, 50);
    const skip = clamp(args.skip, 0, 0, 1000);
    const now = Date.now();
    const hits = !q || [...q].length > 200 ? [] : tables.mdshare_pastes
      .filter((r) => r.owner_id === args.p_owner)
      .filter((r) => r.pinned === true || !r.expires_at || new Date(r.expires_at).getTime() > now)
      .map((r) => ({ r, tm: r.title != null && String(r.title).toLowerCase().includes(lq), pos: String(r.content || '').toLowerCase().indexOf(lq) }))
      .filter((h) => h.tm || h.pos >= 0)
      .sort((a, b) => (b.tm - a.tm) || (new Date(b.r.created_at) - new Date(a.r.created_at)) || String(a.r.id).localeCompare(String(b.r.id)));
    const page = hits.slice(skip, skip + lim).map(({ r, tm, pos }) => {
      const from = Math.max(0, pos - 240);
      return { id: r.id, title: r.title ?? null, created_at: r.created_at, expires_at: r.expires_at ?? null, pinned: r.pinned === true, is_public: r.is_public === true, title_match: tm, excerpt: String(r.content || '').slice(from, from + 480 + q.length), total: hits.length };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(page));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fake-supabase.local');
      const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-zA-Z_]+)\/?$/);
      if (rpc && req.method === 'POST') return await handleRpc(rpc[1], req, res);
      const m = url.pathname.match(/^\/rest\/v1\/([a-zA-Z_]+)\/?$/);
      if (!m) {
        throw new UnsupportedQueryError(`unrecognized path: ${url.pathname}`);
      }
      const table = m[1];
      if (!KNOWN_TABLES.includes(table)) {
        throw new UnsupportedQueryError(`unknown table: ${table}`);
      }
      if (req.method === 'GET') {
        handleGet(table, url.searchParams, res);
      } else if (req.method === 'POST') {
        await handlePost(table, req, res);
      } else if (req.method === 'PATCH') {
        await handlePatch(table, url.searchParams, req, res);
      } else if (req.method === 'DELETE') {
        handleDelete(table, url.searchParams, res);
      } else {
        throw new UnsupportedQueryError(`unsupported method: ${req.method}`);
      }
    } catch (err) {
      if (err instanceof UnsupportedQueryError) {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'fake-supabase: unsupported PostgREST query',
          method: req.method,
          url: req.url,
          reason: err.message,
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String((err && err.stack) || err) }));
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    tables,
    reset() {
      for (const t of KNOWN_TABLES) tables[t] = [];
    },
    seed(table, row) {
      const defaults = TABLE_DEFAULTS[table] ? TABLE_DEFAULTS[table]() : {};
      const full = { ...defaults, ...row };
      tables[table].push(full);
      return full;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
