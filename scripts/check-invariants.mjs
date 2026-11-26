#!/usr/bin/env node
// Deterministic repo invariants. Each check encodes a mistake that already happened (or a
// security property CLAUDE.md used to ask agents to remember). When review catches a new
// recurring mistake, add a check here instead of another paragraph of prose.
// Usage: node scripts/check-invariants.mjs [--root <dir>]   (exit 1 on any violation)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argRoot = process.argv.indexOf('--root');
const ROOT = argRoot > -1 ? process.argv[argRoot + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => existsSync(join(ROOT, p));
const lines = (p) => read(p).split('\n');
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

function walk(dir, filter) {
  const out = [];
  if (!exists(dir)) return out;
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel, filter));
    else if (filter(rel)) out.push(rel);
  }
  return out;
}

const apiTopLevel = () => readdirSync(join(ROOT, 'api')).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort();
const apiFiles = () => walk('api', (f) => f.endsWith('.js'));

// Content routes: each one returns stored content and must gate it and keep it out of caches.
// api/_lib/diagram-page.js is the /d/:id page, dispatched from api/render.js (kind=diagram) since 2026-11-25.
// api/share.js GET (/raw/:id) serves through api/_lib/raw.js since 2026-11-26 ("markdown-route-gating").
const CONTENT_ROUTES = ['api/render.js', 'api/_lib/diagram-page.js', 'api/archify-render.js', 'api/_lib/raw.js', 'api/diagram.js', 'api/archify.js'];
const CREATE_ROUTES = ['api/share.js', 'api/diagram.js', 'api/archify.js'];

const checks = [
  {
    id: 'function-cap',
    why: 'Vercel Hobby fails the whole production build at 13 functions (happened 2026-09; fixed by merging visibility into pin.js, 0068952).',
    run() {
      const fns = apiTopLevel();
      return fns.length > 12
        ? [`api/ has ${fns.length} top-level functions (max 12): ${fns.join(', ')}. Merge the new endpoint into an existing handler (dispatch on a request field) or move helpers under api/_lib/.`]
        : [];
    },
  },
  {
    id: 'rewrites',
    why: 'vercel.json rewrites must point at real functions and each pretty path must be declared once.',
    run() {
      const v = JSON.parse(read('vercel.json'));
      const errs = [];
      const seen = new Set();
      for (const r of v.rewrites || []) {
        if (seen.has(r.source)) errs.push(`vercel.json: duplicate rewrite source "${r.source}" — delete the extra entry.`);
        seen.add(r.source);
        const m = /^\/api\/([^?/]+)/.exec(r.destination);
        if (m && !exists(`api/${m[1]}.js`)) errs.push(`vercel.json: "${r.source}" -> ${r.destination} but api/${m[1]}.js does not exist.`);
      }
      return errs;
    },
  },
  {
    id: 'migrations-additive',
    why: 'Migrations are applied by hand and may be rerun; a backfill UPDATE silently reset owner choices on rerun (fixed in 2cf0397).',
    run() {
      const errs = [];
      // CREATE OR REPLACE: a rerun of an old migration would silently overwrite a newer function or
      // view body (2026-11-26); create only if absent (DO block + pg_proc check), like 011.
      const bad = /\b(UPDATE\s+\w+|DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|TYPE|FUNCTION)|CREATE\s+OR\s+REPLACE)\b/i;
      for (const f of walk('migrations', (p) => p.endsWith('.sql'))) {
        lines(f).forEach((l, i) => {
          const code = l.replace(/--.*$/, '');
          if (bad.test(code) && !/--\s*invariant-allow:\s*\S/.test(l)) {
            errs.push(`${f}:${i + 1}: destructive statement in a migration: "${l.trim()}". Make it additive (ADD COLUMN ... DEFAULT already backfills once; CREATE FUNCTION inside IF NOT EXISTS (SELECT 1 FROM pg_proc ...)) or mark the line "-- invariant-allow: <reason>" after the owner agrees.`);
          }
        });
      }
      return errs;
    },
  },
  {
    id: 'private-by-default',
    why: 'Creation routes must always insert is_public: false and never read visibility from the request body; only the auth-gated pin.js toggle may flip it.',
    run() {
      const errs = [];
      for (const f of CREATE_ROUTES) {
        const src = read(f);
        if (!/is_public:\s*false/.test(src)) errs.push(`${f}: create payload must set is_public: false explicitly.`);
        lines(f).forEach((l, i) => {
          if (isCommentLine(l)) return;
          if (/\bbody\??\.is_public\b|\bis_public\s*:\s*(?!false\b)[^\s,}]/.test(l) || /\.\.\.\s*(req\.)?body\b/.test(l)) {
            errs.push(`${f}:${i + 1}: visibility must not come from the request ("${l.trim()}"). Build an explicit field list with is_public: false; publishing goes through PATCH /api/pin.`);
          }
        });
      }
      return errs;
    },
  },
  {
    id: 'content-route-gating',
    why: 'Every content route checks isVisible() (fail closed) and sets private, no-store headers so a cache never leaks private content or stale visibility.',
    run() {
      const errs = [];
      for (const f of CONTENT_ROUTES) {
        const src = read(f);
        if (!/\bisVisible\(/.test(src)) errs.push(`${f}: content route must call isVisible(row, req) before returning content.`);
        if (!/\bsetPrivacyHeaders\(res\)/.test(src)) errs.push(`${f}: content route must call setPrivacyHeaders(res) (private, no-store; noindex; no-referrer).`);
      }
      const html = read('api/archify-html.js');
      if (!/Cache-Control['"],\s*['"]private, no-store/.test(html)) errs.push('api/archify-html.js: must send Cache-Control: private, no-store.');
      if (!/\bisVisible\(/.test(html)) errs.push('api/archify-html.js: must call isVisible(row, req) before serving stored HTML.');
      return errs;
    },
  },
  {
    id: 'postgrest-id-encoding',
    why: 'Row ids are interpolated into PostgREST filter strings; unencoded input enables filter injection.',
    run() {
      const errs = [];
      for (const f of apiFiles()) {
        lines(f).forEach((l, i) => {
          if (/=(eq|neq|ilike|like)\.\$\{(?!encodeURIComponent\()/.test(l)) {
            errs.push(`${f}:${i + 1}: wrap interpolated filter values in encodeURIComponent() after isValidId(): "${l.trim()}"`);
          }
        });
      }
      return errs;
    },
  },
  {
    id: 'archify-sandbox',
    why: 'Stored archify HTML is attacker-controlled; allow-scripts + allow-same-origin would give it the real origin\'s cookies and APIs.',
    run() {
      const errs = [];
      for (const f of apiFiles()) {
        for (const m of read(f).matchAll(/sandbox="([^"]*)"/g)) {
          if (/allow-same-origin/.test(m[1])) errs.push(`${f}: iframe sandbox="${m[1]}" must not include allow-same-origin.`);
        }
      }
      if (!/sandbox="allow-scripts"/.test(read('api/archify-render.js'))) errs.push('api/archify-render.js: archify iframe must use sandbox="allow-scripts".');
      return errs;
    },
  },
  {
    id: 'timers-unref',
    why: 'Module-level setInterval handles kept the test process alive; tests needed --test-force-exit until 2026-11-19.',
    run() {
      const errs = [];
      for (const f of apiFiles()) {
        const src = read(f);
        const timers = (src.match(/\bsetInterval\(/g) || []).length;
        const unrefs = (src.match(/\.unref\??\.?\(\)/g) || []).length;
        if (timers > unrefs) errs.push(`${f}: ${timers} setInterval() but ${unrefs} .unref() — keep the handle and call handle.unref?.() so serverless/test processes can exit.`);
      }
      return errs;
    },
  },
  {
    id: 'activity-actions-auth',
    why: 'api/doc.js exposes reading-loop actions; an action added without an explicit auth rule would be reachable by anyone (2026-11-25).',
    run() {
      if (!exists('api/doc.js')) return [];
      const src = read('api/doc.js');
      const m = /const ACTIONS = \{\n([\s\S]*?)\n\};/.exec(src);
      if (!m) return ['api/doc.js: keep the actions in one `const ACTIONS = { ... };` table so each one declares its auth.'];
      const scopes = (/ALLOWED_SCOPES = \[([^\]]*)\]/.exec(read('api/_lib/agent-tokens.js')) || [null, ''])[1].match(/'[^']+'/g)?.map((x) => x.slice(1, -1)) || [];
      const errs = [];
      const entries = m[1].split(/\n(?= {2}[a-z]+: \{)/);
      for (const e of entries) {
        const name = (/^\s*([a-z]+): \{/.exec(e) || [])[1];
        if (!name) continue;
        const auth = /\bauth:\s*('[^']*'|\{[^}]*\})/.exec(e);
        if (!auth) { errs.push(`api/doc.js: action "${name}" has no auth. Add auth: 'owner' or 'owner|<scope>' (or one per method).`); continue; }
        for (const rule of auth[1].match(/'[^']*'/g) || []) {
          const r = rule.slice(1, -1);
          if (['POST', 'GET'].includes(r)) continue;
          const [who, scope] = r.split('|');
          if (who !== 'owner' || (scope !== undefined && !scopes.includes(scope))) errs.push(`api/doc.js: action "${name}" auth '${r}' must be 'owner' or 'owner|<one of ${scopes.join(', ')}>'.`);
        }
      }
      if (!entries.some((e) => /^\s*[a-z]+: \{/.test(e))) errs.push('api/doc.js: ACTIONS table is empty or unparseable.');
      // Every action has a run(); an entry the splitter can't see (computed or quoted key) would
      // dodge the auth check above, so the counts must agree.
      const named = entries.filter((e) => /^\s*[a-z]+: \{/.test(e)).length;
      const runs = (m[1].match(/\basync run\(/g) || []).length;
      if (runs !== named) errs.push(`api/doc.js: ACTIONS has ${runs} run() bodies but ${named} plain \`name: {\` entries. Write each action as a plain lowercase key at two-space indent so its auth is checked.`);
      return errs;
    },
  },
  {
    id: 'activity-writes-allowlist',
    why: 'Feedback and read receipts must never change stored content or visibility: only api/_lib/activity.js writes, and only to the activity tables (2026-11-25).',
    run() {
      const errs = [];
      if (exists('api/doc.js')) {
        lines('api/doc.js').forEach((l, i) => {
          if (isCommentLine(l)) return;
          if (/\bfetch\(|method:\s*['"](POST|PATCH|PUT|DELETE)/.test(l)) errs.push(`api/doc.js:${i + 1}: write through api/_lib/activity.js (activityWrite), never fetch() directly: "${l.trim()}"`);
        });
      }
      if (exists('api/_lib/activity.js')) {
        const src = read('api/_lib/activity.js');
        const list = (/ACTIVITY_TABLES = \[([^\]]*)\]/.exec(src) || [null, ''])[1];
        if (!list || /mdshare_(pastes|diagrams|archify|agent_tokens|events)/.test(list)) errs.push(`api/_lib/activity.js: ACTIVITY_TABLES must list only activity tables (got [${list}]).`);
        if (!/export async function activityWrite\(table[^)]*\) \{\n\s*if \(!ACTIVITY_TABLES\.includes\(table\)\) throw/.test(src)) errs.push('api/_lib/activity.js: activityWrite() must start by throwing for any table not in ACTIVITY_TABLES.');
        const writes = src.split('\n').filter((l) => /^\s*method\s*[,:]/.test(l) && !isCommentLine(l)).length;
        if (writes > 1) errs.push('api/_lib/activity.js: only activityWrite() may send a non-GET request.');
      }
      for (const f of apiFiles()) {
        if (f === 'api/_lib/activity.js') continue;
        lines(f).forEach((l, i) => {
          if (!isCommentLine(l) && /rest\/v1\/mdshare_(reads|feedback)/.test(l)) errs.push(`${f}:${i + 1}: activity tables are only touched by api/_lib/activity.js.`);
        });
      }
      return errs;
    },
  },
  {
    id: 'version-parent-gated',
    why: 'A version link puts a "newer version" banner on another document; only the owner or a token that can read the parent may create one, never based on is_public (2026-11-25).',
    run() {
      const errs = [];
      const share = read('api/share.js');
      if (/parent_id:/.test(share) && !/await canUseParent\(/.test(share)) errs.push('api/share.js: stores parent_id without calling canUseParent() first.');
      if (exists('api/_lib/activity.js')) {
        const body = (/export async function canUseParent\([\s\S]*?\n\}/.exec(read('api/_lib/activity.js')) || [''])[0];
        if (!body) errs.push('api/_lib/activity.js: canUseParent() is missing.');
        else if (/is_public/.test(body)) errs.push('api/_lib/activity.js: canUseParent() must not grant access because a parent is public.');
      }
      return errs;
    },
  },
  {
    id: 'loop-owner-only',
    why: 'The feedback/read-receipt script records the owner\'s reading; it must load only on owner pages (2026-11-25).',
    run() {
      const errs = [];
      for (const f of apiFiles()) {
        lines(f).forEach((l, i) => {
          if (isCommentLine(l) || !/'loop'/.test(l)) return;
          if (!(f === 'api/render.js' && /scripts\(owner \? \[[^\]]*'loop'[^\]]*\] : \[(?![^\]]*'loop')/.test(l))) errs.push(`${f}:${i + 1}: load the 'loop' script only as scripts(owner ? [..., 'loop'] : [...]) in api/render.js.`);
        });
        // The asset path itself may appear only in the scripts() map in api/_lib/ui.js.
        lines(f).forEach((l, i) => {
          if (!isCommentLine(l) && /\bloop\.js\b/.test(l) && f !== 'api/_lib/ui.js') errs.push(`${f}:${i + 1}: don't reference loop.js directly; add 'loop' through scripts(owner ? [...] : [...]) in api/render.js.`);
        });
      }
      return errs;
    },
  },
  {
    id: 'version-reads-constant',
    why: 'Version lookups once walked parent links one query per hop on every page view (adversarial review 2026-11-25); root_id/version_no make them one query.',
    run() {
      if (!exists('api/_lib/activity.js')) return [];
      const src = read('api/_lib/activity.js');
      const m = /\/\/ -{10} Versions -{10}([\s\S]*?)\/\/ -{10} /.exec(src);
      if (!m) return ['api/_lib/activity.js: keep the version helpers in the "// ---------- Versions ----------" section.'];
      const errs = [];
      m[1].split('\n').forEach((l, i) => {
        if (!isCommentLine(l) && /\b(for|while)\s*\(|\.(forEach|map|reduce)\([^)]*\bawait\b|\bawait\b[^;]*\b(for|while)\b/.test(l)) {
          errs.push(`api/_lib/activity.js (Versions section, line ${i + 1}): no loops in version lookups ("${l.trim()}"). Query by root_id/version_no instead of walking parent links.`);
        }
      });
      const selects = (m[1].match(/\bawait sbSelect\(/g) || []).length;
      if (selects > 3) errs.push(`api/_lib/activity.js: the Versions section makes ${selects} sbSelect calls (max 3: page view 1, API 2).`);
      if (!/root_id: links\.rootId/.test(read('api/share.js'))) errs.push('api/share.js: a new version must store root_id and version_no (versionFields(parentRow)).');
      return errs;
    },
  },
  {
    id: 'search-no-filter-injection',
    why: 'PostgREST parses "," "(" ")" "*" inside filter values, so search text spliced into or=(...ilike...) can rewrite the filter; search goes through the mdshare_search rpc with a JSON body (2026-11-26).',
    run() {
      if (!exists('api/_lib/search.js')) return ['api/_lib/search.js is missing: full-text search must live there (rpc mdshare_search, migration 011).'];
      const errs = [];
      const src = read('api/_lib/search.js');
      if (!/rest\/v1\/rpc\/mdshare_search`/.test(src)) errs.push('api/_lib/search.js: call `${SUPABASE_URL}/rest/v1/rpc/mdshare_search` (migration 011).');
      if (!/body: JSON\.stringify\(\{ q,/.test(src)) errs.push('api/_lib/search.js: send the search text in the JSON body: body: JSON.stringify({ q, lim, skip }).');
      if ((src.match(/\bfetch\(/g) || []).length !== 1) errs.push('api/_lib/search.js: exactly one fetch() per search (one database call, however many rows match).');
      const filterish = /rest\/v1\/mdshare_|[?&]or=|\bor=\(|\.(i?like|fts|plfts|phfts|wfts|match|imatch)\.|=(i?like|fts|plfts|phfts|wfts|match|imatch)\./;
      for (const f of ['api/_lib/search.js', 'api/doc.js']) {
        lines(f).forEach((l, i) => {
          if (!isCommentLine(l) && filterish.test(l)) errs.push(`${f}:${i + 1}: no PostgREST filter strings on the search path ("${l.trim()}"). Pass the text to searchDocs(), which sends it as an rpc JSON body.`);
        });
      }
      const doc = read('api/doc.js');
      const action = (/\n {2}search: \{([\s\S]*?)\n {2}\},/.exec(doc) || [])[1];
      if (!action) errs.push('api/doc.js: the search action must be a plain `search: { ... }` ACTIONS entry.');
      else {
        if (!/auth: 'owner\|documents:read'/.test(action)) errs.push("api/doc.js: search must be auth: 'owner|documents:read'.");
        if (!/validateSearch\(query\)/.test(action) || !/searchDocs\(v\.value\)/.test(action)) errs.push('api/doc.js: search must pass the query only through validateSearch(query) -> searchDocs(v.value).');
        if (/query\.q\b/.test(action)) errs.push('api/doc.js: the search action must not read query.q itself; validateSearch() trims and bounds it.');
      }
      return errs;
    },
  },
  {
    id: 'markdown-route-gating',
    why: '/v/:id serves Markdown to Bearer requests; it must use the exact /raw/:id rules, so both go through sendRawMarkdown() in api/_lib/raw.js, which checks isVisible() (2026-11-26).',
    run() {
      if (!exists('api/_lib/raw.js')) return ['api/_lib/raw.js is missing: /raw/:id and /v/:id Markdown share sendRawMarkdown() there.'];
      const errs = [];
      const raw = read('api/_lib/raw.js');
      const body = (/export async function sendRawMarkdown\([\s\S]*?\n\}/.exec(raw) || [''])[0];
      if (!body) errs.push('api/_lib/raw.js: sendRawMarkdown() is missing.');
      else {
        const pos = (re) => { const m = re.exec(body); return m ? m.index : -1; };
        const vis = pos(/isVisible\(row, req, res, \{ agentOwns \}\)/);
        const send = pos(/\.send\(row\.content\)/);
        if (vis < 0) errs.push('api/_lib/raw.js: sendRawMarkdown() must check isVisible(row, req, res, { agentOwns }).');
        if (send < 0 || send < vis) errs.push('api/_lib/raw.js: sendRawMarkdown() may send row.content only after the isVisible() check.');
        if (!/setPrivacyHeaders\(res\)/.test(body)) errs.push('api/_lib/raw.js: sendRawMarkdown() must call setPrivacyHeaders(res).');
        if (!/agentAuth\.present && !agentAuth\.valid\) return authHint\(/.test(body)) errs.push('api/_lib/raw.js: an invalid Bearer must be a 401 (authHint), never a fallback to the owner/public check.');
        if (/is_public === true\) return|row\.is_public\s*\)/.test(body)) errs.push('api/_lib/raw.js: decide visibility only with isVisible().');
      }
      const render = read('api/render.js');
      if (!/if \(wantsMarkdown\(req, res\)\) return sendRawMarkdown\(req, res, \{ contentType: 'text\/markdown; charset=utf-8' \}\);/.test(render)) errs.push("api/render.js: answer agent requests with `if (wantsMarkdown(req, res)) return sendRawMarkdown(req, res, { contentType: 'text/markdown; charset=utf-8' });`.");
      lines('api/render.js').forEach((l, i) => {
        if (!isCommentLine(l) && /text\/markdown|text\/plain|\.send\(row\.content\)|\.send\(markdown\)/.test(l) && !/sendRawMarkdown\(/.test(l)) errs.push(`api/render.js:${i + 1}: Markdown leaves this route only through sendRawMarkdown() ("${l.trim()}").`);
      });
      if (!/if \(req\.method === 'GET'\) return sendRawMarkdown\(req, res\);/.test(read('api/share.js'))) errs.push("api/share.js: GET (/raw/:id) must be `if (req.method === 'GET') return sendRawMarkdown(req, res);`.");
      return errs;
    },
  },
  {
    id: 'agent-auth-hints',
    why: 'Agents failed silently on bare 401s and on tokens sent as x-api-key (diagnosis 2026-11-15); every agent-facing 401 says how to authenticate. A misplaced key once 401ed the owner and public links (adversarial review 2026-11-26): it may only change the hint on a request that is refused anyway.',
    run() {
      const errs = [];
      const raw = exists('api/_lib/raw.js') ? read('api/_lib/raw.js') : '';
      if (!/export function authHint\([^)]*\) \{\n\s*res\.setHeader\('WWW-Authenticate', `Bearer/.test(raw)) errs.push("api/_lib/raw.js: authHint() must start by setting WWW-Authenticate: Bearer.");
      for (const f of ['api/doc.js', 'api/_lib/raw.js', 'api/share.js']) {
        lines(f).forEach((l, i) => {
          if (!isCommentLine(l) && /status\(401\)/.test(l) && !/Unauthorized/.test(l)) errs.push(`${f}:${i + 1}: send agent-facing 401s through authHint() (WWW-Authenticate + hint + guide): "${l.trim()}"`);
        });
      }
      // apiKeyMisuse() is read only by refusalHint(), and refusalHint() only after the request was refused.
      const helper = (/export function refusalHint\(req, fallback\) \{\n([\s\S]*?)\n\}/.exec(raw) || [])[1];
      if (!helper || !/apiKeyMisuse\(req\) \? HINTS\.misplaced : fallback/.test(helper)) errs.push('api/_lib/raw.js: keep `export function refusalHint(req, fallback) { return apiKeyMisuse(req) ? HINTS.misplaced : fallback; }`.');
      for (const f of apiFiles()) {
        lines(f).forEach((l, i) => {
          if (isCommentLine(l) || /export function apiKeyMisuse\(/.test(l) || (f === 'api/_lib/raw.js' && /apiKeyMisuse\(req\) \? HINTS\.misplaced : fallback/.test(l))) return;
          if (/apiKeyMisuse\(/.test(l)) errs.push(`${f}:${i + 1}: don't decide anything on apiKeyMisuse(); on a refusal path use refusalHint(req, <hint>) so the owner, a valid Bearer and public documents are never refused for a stray ?token= ("${l.trim()}").`);
        });
      }
      const wants = (/export function wantsMarkdown\([\s\S]*?\n\}/.exec(raw) || [''])[0];
      if (/refusalHint\(|HINTS\.misplaced/.test(wants)) errs.push('api/_lib/raw.js: wantsMarkdown() must not look at misplaced keys; a stray ?token= must keep the HTML page.');
      const after = (file, src, gate, label) => {
        const g = src.search(gate);
        const uses = [...src.matchAll(/refusalHint\(/g)].map((m) => m.index);
        if (g < 0) errs.push(`${file}: expected ${label}.`);
        else if (uses.some((u) => u < g)) errs.push(`${file}: call refusalHint() only after ${label}, on the refusal path.`);
      };
      const send = (/export async function sendRawMarkdown\([\s\S]*?\n\}/.exec(raw) || [''])[0];
      if (/HINTS\.misplaced/.test(send)) errs.push('api/_lib/raw.js: sendRawMarkdown() gives the misplaced-key hint only through refusalHint().');
      after('api/_lib/raw.js sendRawMarkdown()', send, /if \(!row \|\| !isVisible\(row, req, res, \{ agentOwns \}\)\) \{/, 'the isVisible() check');
      const doc = read('api/doc.js');
      const handler = (/async function handler\([\s\S]*?\n\}/.exec(doc) || [''])[0];
      if (/HINTS\.misplaced/.test(doc)) errs.push('api/doc.js: give the misplaced-key hint only through refusalHint().');
      after('api/doc.js handler()', handler, /if \(!allowed\(auth, req, res, agentAuth\)\) \{/, 'the allowed() check');
      if (!/hint: refusalHint\(req, HINTS\.missing\)/.test(handler)) errs.push('api/doc.js: the refused-request authHint() uses hint: refusalHint(req, HINTS.missing).');
      after('api/render.js', read('api/render.js'), /if \(!isVisible\(row, req, res\)\) \{/, 'the isVisible() check');
      return errs;
    },
  },
  {
    id: 'guide-link-origin',
    why: 'The guide link in agent hints echoed the request Host header (adversarial review 2026-11-26); hint links use the canonical origin (api/_lib/content.js guideUrl/siteOrigin).',
    run() {
      const errs = [];
      const content = read('api/_lib/content.js');
      const origin = (/export function siteOrigin\(req\) \{\n([\s\S]*?)\n\}/.exec(content) || [])[1];
      if (!origin || !/LOOPBACK_HOST\.test\(host\) \? `http:\/\/\$\{host\}` : SITE_ORIGIN/.test(origin)) errs.push('api/_lib/content.js: siteOrigin() returns SITE_ORIGIN unless the Host is a loopback dev server (LOOPBACK_HOST.test(host)).');
      if (!/export const guideUrl = \(req\) => `\$\{siteOrigin\(req\)\}\$\{FORMAT_GUIDE_PATH\}`;/.test(content)) errs.push('api/_lib/content.js: guideUrl(req) must be `${siteOrigin(req)}${FORMAT_GUIDE_PATH}`.');
      lines('api/_lib/raw.js').forEach((l, i) => {
        if (!isCommentLine(l) && /baseUrl\(|headers\.host|headers\[['"]host/.test(l)) errs.push(`api/_lib/raw.js:${i + 1}: hint bodies link with guideUrl(req), never baseUrl()/the Host header ("${l.trim()}").`);
      });
      for (const f of apiFiles()) {
        lines(f).forEach((l, i) => {
          if (!isCommentLine(l) && /\bguide: /.test(l) && /baseUrl\(|headers\.host|headers\[['"]host|\$\{base\}/.test(l)) errs.push(`${f}:${i + 1}: build the guide link with guideUrl(req) (canonical origin), not the request Host ("${l.trim()}").`);
        });
      }
      return errs;
    },
  },
  {
    id: 'mermaid-vendored',
    why: 'Diagrams must draw with one pinned library in production, e2e and the preview tool, and never with a script-capable security level: with securityLevel "loose" a click/call line in a diagram ran script on the owner\'s session (adversarial review 2026-11-25).',
    run() {
      if (!exists('public/assets/render.js')) return [];
      const errs = [];
      const m = /MERMAID_SRC = '\/vendor\/(mermaid-\d+\.\d+\.\d+\.min\.js)'/.exec(read('public/assets/render.js'));
      if (!m) errs.push("public/assets/render.js: load mermaid from a pinned vendored file: var MERMAID_SRC = '/vendor/mermaid-<x.y.z>.min.js'.");
      const files = [...walk('api', (p) => /\.(js|mjs|html)$/.test(p)), ...walk('public', (p) => /\.(js|html)$/.test(p) && !p.startsWith('public/vendor/'))];
      for (const f of files) {
        lines(f).forEach((l, i) => {
          if (/https?:\/\/[^'"\s)]*mermaid/i.test(l)) errs.push(`${f}:${i + 1}: mermaid must come from public/vendor, not a remote URL.`);
          for (const v of l.matchAll(/\/vendor\/(mermaid-[\w.-]+\.js)/g)) if (!exists(`public/vendor/${v[1]}`)) errs.push(`${f}:${i + 1}: /vendor/${v[1]} does not exist in public/vendor/.`);
          const lvl = /securityLevel\s*:\s*['"]?(\w+)/.exec(l);
          if (lvl && lvl[1] !== 'strict') errs.push(`${f}:${i + 1}: mermaid securityLevel must be 'strict' (got '${lvl[1]}'); anything else lets a document run script.`);
        });
      }
      return errs;
    },
  },
  {
    id: 'publish-checks',
    why: 'Agents rely on the create response telling them about a broken page before the reader sees it (2026-11-25).',
    run() {
      return /checks: lintMarkdown\(markdown\)/.test(read('api/share.js')) ? [] : ['api/share.js: the POST response must include `checks: lintMarkdown(markdown)`.'];
    },
  },
  {
    id: 'no-secrets',
    why: 'The GitHub repo is public.',
    run() {
      const errs = [];
      const patterns = [
        /ghp_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /vcp_[A-Za-z0-9]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/,
        /AKIA[0-9A-Z]{16}/, /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      ];
      let files;
      try { files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean); }
      catch { files = walk('.', () => true); }
      for (const f of files) {
        if (f === 'package-lock.json' || f.endsWith('.png') || !existsSync(join(ROOT, f))) continue;
        const src = readFileSync(join(ROOT, f), 'utf8');
        for (const p of patterns) if (p.test(src)) errs.push(`${f}: looks like a credential (${p.source.slice(0, 16)}…). Remove it and rotate the key.`);
      }
      return errs;
    },
  },
  {
    id: 'error-reporting',
    why: 'An uncaught exception in a function used to vanish into Vercel logs that nobody reads; every handler must record it (api/_lib/events.js) so the monitor can alert.',
    run() {
      return apiTopLevel().filter((f) => !/export default withErrors\('[\w-]+', handler\);/.test(read(`api/${f}`)))
        .map((f) => `api/${f}: export the handler as \`export default withErrors('<route>', handler);\` (import from ./_lib/events.js).`);
    },
  },
  {
    id: 'no-redacted-placeholders',
    why: 'Tool output redaction once wrote a literal "***" in place of a credential expression; the code looked fine and failed only against the real database (2026-11-19).',
    run() {
      const errs = [];
      for (const f of walk('api', (p) => p.endsWith('.js')).concat(walk('public/assets', (p) => p.endsWith('.js')))) {
        if (read(f).includes('***')) errs.push(`${f}: contains a literal "***" (a redacted value). Rebuild the expression from source, never from tool output.`);
      }
      return errs;
    },
  },
  {
    id: 'root-markdown',
    why: 'Stale agent plan/result docs get copied as "established patterns" (Lauren Tan, "stop agents from writing unsolicited Markdown").',
    run() {
      const allowed = new Set(['README.md', 'CLAUDE.md']);
      const extra = readdirSync(ROOT).filter((f) => f.endsWith('.md') && !allowed.has(f));
      return extra.length ? [`root has unexpected Markdown: ${extra.join(', ')}. Put finished plans/results in docs/history/ or outside the repo.`] : [];
    },
  },
  {
    id: 'claude-md-size',
    why: 'Prose is the least reliable layer; rules that can be checks belong in this file or eslint.config.js.',
    run() {
      const src = read('CLAUDE.md');
      const n = src.split('\n').length;
      return n > 90 || src.length > 7000
        ? [`CLAUDE.md is ${n} lines / ${src.length} chars (max 90 / 7000). Move history to docs/history/ and turn enforceable rules into checks.`]
        : [];
    },
  },
];

let failed = 0;
for (const c of checks) {
  let errs;
  try { errs = c.run(); } catch (e) { errs = [`check crashed: ${e.message}`]; }
  if (errs.length) {
    failed += errs.length;
    console.log(`✗ ${c.id} — ${c.why}`);
    for (const e of errs) console.log(`    ${e}`);
  } else {
    console.log(`✓ ${c.id}`);
  }
}
console.log(failed ? `\n${failed} invariant violation(s) in ${relative(process.cwd(), ROOT) || '.'}` : `\nall ${checks.length} invariants hold`);
process.exit(failed ? 1 : 0);
