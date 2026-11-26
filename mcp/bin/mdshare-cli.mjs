#!/usr/bin/env node
// mdshare-cli — portable, dependency-free CLI for the mdshare agent (bearer-token) API.
// No MCP client required: works from any machine with Node >=18 and plain `fetch`.
//
// Security (AGENT-SEARCH-PLAN.md, 2026-10-08): the bearer token is NEVER accepted as a CLI
// argument/flag — only from the MDSHARE_AGENT_TOKEN environment variable, or from a file via
// MDSHARE_AGENT_TOKEN_FILE (env) / --token-file <path> (flag). A token passed as a bare CLI
// argument would be visible in `ps`, shell history, and process-list snapshots on shared
// machines — that risk is deliberately not offered here, matching the parent instruction
// ("never expose tokens in args/stdout/logs"). The resolved token value is never printed, logged,
// or included in any error message produced by this script; upstream API error bodies are
// passed through as-is (the mdshare API itself never echoes the Authorization header back).
//
// Usage:
//   mdshare-cli status
//   mdshare-cli search "<text>" [--limit N] [--offset N] [--json]   (full text, Chinese too)
//   mdshare-cli search [--q TERM] [--kind paste|diagram|archify|all] [--limit N] [--offset N]  (catalog)
//   mdshare-cli recent [--kind K] [--limit N] [--offset N]      (alias for search with no --q)
//   mdshare-cli read <id | /v/ /raw/ /d/ /a/ link> [--kind paste|diagram|archify]
//   mdshare-cli create <kind> <file> [--ttl SECONDS] [--title TITLE]   (kind: paste|diagram|archify)
//   mdshare-cli publish <id> --kind K --public true|false
//   mdshare-cli create paste <file> --keep --parent ID --origin SESSION [--strict]
//   mdshare-cli feedback [<doc id>] [--status S] | resolve <fb_id>... --in <id> | reads [ids] | versions <id>
//
// Token resolution (first match wins): MDSHARE_AGENT_TOKEN env var, then MDSHARE_AGENT_TOKEN_FILE
// env var, then --token-file <path> flag, then DEFAULT_TOKEN_FILE (~/.mdshare/token, the file
// `login` writes by default) if it exists. No match at any step -> '' (anonymous), same as
// before this default-file fallback existed. Base URL: MDSHARE_BASE_URL env var, default the
// public hosted instance (same default as mcp/src/index.ts).
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';

const BASE_URL = (process.env.MDSHARE_BASE_URL || 'https://mdshare-rileylins-projects.vercel.app').replace(/\/$/, '');
const DEFAULT_TOKEN_FILE = join(homedir(), '.mdshare', 'token');

const READ_WRITE_PATH = { paste: '/api/share', diagram: '/api/diagram', archify: '/api/archify' };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function resolveToken(flags) {
  if (process.env.MDSHARE_AGENT_TOKEN) return process.env.MDSHARE_AGENT_TOKEN;
  const explicitFilePath = process.env.MDSHARE_AGENT_TOKEN_FILE || flags['token-file'];
  if (explicitFilePath && typeof explicitFilePath === 'string') {
    try { return readFileSync(explicitFilePath, 'utf8').trim(); } catch (e) {
      fail(`Could not read token file: ${explicitFilePath} (${e.code || e.message})`);
    }
  }
  // No explicit token source given (no env var, no MDSHARE_AGENT_TOKEN_FILE, no --token-file) --
  // fall back to the default file `login` writes to (DEFAULT_TOKEN_FILE, ~/.mdshare/token by
  // default). Unlike an explicit path above, a missing/unreadable default file is NOT an error:
  // it just means the owner never ran `login` (or ran it with a custom --token-file), so every
  // command keeps working exactly as before this fallback existed -- anonymous, empty token.
  try { return readFileSync(DEFAULT_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function authHeaders(flags) {
  const headers = { 'Content-Type': 'application/json' };
  const token = resolveToken(flags);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function fail(message) {
  // Throws rather than calling process.exit() directly, so every cmd* function below is a plain
  // async function that can be imported and unit-tested (mocked global.fetch, no real network—
  // this sandbox's exec egress proxy blocks even loopback traffic, so a real spawned-subprocess-
  // against-a-local-server test is not viable here; see tests/cli-login.test.mjs). Only the
  // actual CLI entrypoint (main(), guarded below) converts this into a stderr message + exit
  // code 1 — observable behavior for a real invocation is unchanged.
  throw new CliError(String(message));
}

class CliError extends Error {}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// Hidden password prompt for `login`. Never a CLI argument/flag — either read from the
// MDSHARE_OWNER_PASSWORD env var (for scripted/non-interactive setup), or typed interactively
// with echo suppressed via raw-mode stdin (nothing is printed back, not even asterisks — same
// convention as a typical `sudo`-style prompt). Prompt text and the trailing newline both go to
// stderr, never stdout, so stdout stays clean for `--stdout` secret-piping mode even during
// login. If stdin isn't a TTY (piped), reads the first line verbatim — masking a pipe is
// meaningless, but this still keeps the password out of argv/ps.
function readHiddenPassword(promptText) {
  if (process.env.MDSHARE_OWNER_PASSWORD) return Promise.resolve(process.env.MDSHARE_OWNER_PASSWORD);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(promptText);
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.split('\n')[0].trim()));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(input);
      } else if (char === '\u0003') { // Ctrl+C
        stdin.setRawMode(false);
        process.stderr.write('\n');
        process.exit(130);
      } else if (char === '\u007f' || char === '\b') { // backspace
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    stdin.on('data', onData);
  });
}

// `login`: new-machine setup flow (added 2026-10-08, same-evening follow-up). Hidden password
// prompt -> POST /api/auth (owner password login) -> use the resulting session cookie to POST
// /api/auth {action:'create_token', scopes} -> write ONLY the raw token to a 0600 file (default
// ~/.mdshare/token, overridable via --token-file). The owner password is never a CLI
// argument/flag, never logged, never written anywhere; the issued token is never printed to
// stdout/stderr in the default (file) mode. `--stdout` is an explicit opt-in for piping the raw
// token straight into another program (e.g. a protected secrets-store CLI) instead of writing a
// file — in that mode ONLY the token goes to stdout (newline-terminated), every other message
// goes to stderr, so `TOKEN=$(mdshare-cli login --stdout ...)` or a direct pipe both work cleanly
// without the secret ever touching a log line.
async function cmdLogin(flags) {
  const password = await readHiddenPassword('mdshare owner password: ');
  if (!password) fail('No password provided');

  const loginRes = await fetch(`${BASE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const loginData = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) fail(`login failed (${loginRes.status}): ${loginData.error || 'wrong password?'}`);
  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) fail('login succeeded but no session cookie was returned');
  const cookie = setCookie.split(';')[0];

  const name = flags.name || `cli-${hostname()}`;
  const scopes = flags.scopes ? String(flags.scopes).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const createBody = { action: 'create_token', name };
  if (scopes && scopes.length) createBody.scopes = scopes;
  if (flags['never-expires']) createBody.never_expires = true;
  else if (flags.days) createBody.expires_in_days = Number(flags.days);

  const createRes = await fetch(`${BASE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(createBody),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) fail(`token creation failed (${createRes.status}): ${createData.error || 'unknown error'}`);
  const token = createData.token;
  if (!token) fail('server did not return a token');

  if (flags.stdout) {
    process.stderr.write(`Issued token "${createData.name}" (id ${createData.id}, scopes: ${JSON.stringify(createData.scopes ?? [])}, expires ${createData.expires_at}). Token on stdout for piping — nowhere else.\n`);
    process.stdout.write(token + '\n');
    return;
  }

  const tokenFile = flags['token-file'] || DEFAULT_TOKEN_FILE;
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600); // belt-and-suspenders against umask overriding the mode above
  printJson({ ok: true, id: createData.id, name: createData.name, scopes: createData.scopes ?? [], expires_at: createData.expires_at, token_file: tokenFile });
}

async function cmdStatus(flags) {
  const res = await fetch(`${BASE_URL}/api/auth?action=whoami`, { headers: authHeaders(flags) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`status failed (${res.status}): ${data.error || 'unknown error'}`);
  printJson(data);
}

// Full-text search (GET /api/doc?action=search, documents:read): `search "<text>"`. Prints one
// line per hit (id, title, link, snippet) or the raw JSON with --json. The older flag form
// (`search --q TERM --kind K`) is the catalog listing below and keeps working unchanged.
async function cmdFullTextSearch(text, flags) {
  const params = new URLSearchParams({ action: 'search', q: text });
  if (flags.limit) params.set('limit', String(flags.limit));
  if (flags.offset) params.set('offset', String(flags.offset));
  const res = await fetch(`${BASE_URL}/api/doc?${params.toString()}`, { headers: authHeaders(flags) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`search failed (${res.status}): ${data.error || 'unknown error'}${data.hint ? ` — ${data.hint}` : ''}`);
  if (flags.json) return printJson(data);
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) { process.stdout.write(`no documents contain "${text}"\n`); return; }
  const lines = results.map((r) => `${r.id}  ${r.title}${r.kept ? '  ⭐' : ''}${r.is_public ? '  (public)' : ''}\n    ${BASE_URL}/v/${r.id}\n    ${r.snippet || ''}`);
  process.stdout.write(`${lines.join('\n')}\n${data.total} match${data.total === 1 ? '' : 'es'}${data.next_offset != null ? ` · more: --offset ${data.next_offset}` : ''}\n`);
}

async function cmdSearch(flagsOrPositional, maybeFlags) {
  // search "<text>" -> full text; search --q/--kind (flags only) -> catalog, as before.
  if (Array.isArray(flagsOrPositional)) {
    const flags = maybeFlags || {};
    if (flagsOrPositional.length) return cmdFullTextSearch(flagsOrPositional.join(' '), flags);
    return cmdSearch(flags);
  }
  const flags = flagsOrPositional || {};
  const params = new URLSearchParams();
  if (flags.q) params.set('q', flags.q);
  if (flags.kind) params.set('kind', flags.kind);
  if (flags.limit) params.set('limit', flags.limit);
  if (flags.offset) params.set('offset', flags.offset);
  const res = await fetch(`${BASE_URL}/api/pastes?${params.toString()}`, { headers: authHeaders(flags) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`search failed (${res.status}): ${data.error || 'unknown error'} — requires a bearer token with the documents:read scope`);
  printJson(data);
}

// `read` takes an id or a full link (/v/<id>, /raw/<id>, /d/<id>, /a/<id>). A link on another host
// is refused: the token is only ever sent to MDSHARE_BASE_URL, never to a host named in an argument.
const LINK_KIND = { v: 'paste', raw: 'paste', d: 'diagram', a: 'archify' };
function parseReadTarget(arg, flags) {
  const s = String(arg || '').trim();
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { fail(`not a valid link: ${s}`); }
    const base = new URL(BASE_URL);
    if (u.host !== base.host || u.protocol !== base.protocol) fail(`that link is on ${u.origin}, but this CLI talks to ${base.origin}; set MDSHARE_BASE_URL=${u.origin} to read it (the token is only sent to MDSHARE_BASE_URL)`);
    const m = u.pathname.match(/^\/(v|raw|d|a)\/([A-Za-z0-9_-]{1,64})\/?$/);
    if (!m) fail(`not a document link (expected /v/<id>, /raw/<id>, /d/<id> or /a/<id>): ${s}`);
    if (flags.kind && flags.kind !== LINK_KIND[m[1]]) fail(`--kind ${flags.kind} does not match a /${m[1]}/ link`);
    return { id: m[2], kind: LINK_KIND[m[1]] };
  }
  const m = s.match(/^\/?(v|raw|d|a)\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (m) return { id: m[2], kind: flags.kind || LINK_KIND[m[1]] };
  return { id: s, kind: flags.kind || 'paste' };
}

async function cmdRead(positional, flags) {
  if (!positional[0]) fail('usage: mdshare-cli read <id or link> [--kind paste|diagram|archify]');
  const { id, kind } = parseReadTarget(positional[0], flags);
  if (!id) fail('usage: mdshare-cli read <id or link> [--kind paste|diagram|archify]');
  const path = READ_WRITE_PATH[kind];
  if (!path) fail(`unknown kind: ${kind}`);
  const res = await fetch(`${BASE_URL}${path}?id=${encodeURIComponent(id)}`, { headers: authHeaders(flags) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    fail(`read failed (${res.status}): ${data.error || 'unknown error'}${data.hint ? ` — ${data.hint}` : ''}`);
  }
  const text = await res.text();
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

async function cmdCreate(positional, flags) {
  const [kind, file] = positional;
  const path = READ_WRITE_PATH[kind];
  if (!path || !file) fail('usage: mdshare-cli create paste|diagram|archify <file> [--ttl SECONDS] [--title TITLE]');
  let content;
  try { content = readFileSync(file, 'utf8'); } catch (e) { fail(`could not read file: ${file} (${e.code || e.message})`); }

  const body = {};
  if (kind === 'paste') body.markdown = content;
  if (kind === 'diagram') { body.svg = content; if (flags.title) body.title = flags.title; }
  if (kind === 'archify') fail('create for kind=archify requires html+kind+ir fields not expressible as a single file via this CLI; use the MCP tools or POST /api/archify directly');
  if (flags.ttl) body.ttl = Number(flags.ttl);
  if (flags.keep) body.keep = true;
  if (kind === 'paste' && typeof flags.parent === 'string') body.parent = flags.parent;
  if (kind === 'paste' && typeof flags.origin === 'string') body.origin = flags.origin;

  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: authHeaders(flags), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`create failed (${res.status}): ${data.error || 'unknown error'}`);
  printJson(data);
  // Publish checks (paste only): a one-line summary on stderr so a script sees problems even when
  // it only parses stdout. --strict makes a "warn" a non-zero exit (the document still exists).
  if (data.checks && Array.isArray(data.checks.warnings)) {
    const warns = data.checks.warnings.filter((w) => w.severity === 'warn');
    process.stderr.write(warns.length ? `checks: ${warns.length} problem(s): ${warns.map((w) => `line ${w.line} ${w.rule}`).join('; ')}\n` : 'checks: ok\n');
    if (warns.length && flags.strict) fail('publish checks found problems (see "checks" above); fix and create again with --parent ' + data.id);
  }
  if (data.keep_ignored) process.stderr.write(`keep: ${data.keep_ignored}\n`);
}

// Reading loop (2026-11-25): GET/POST /api/doc. Needs activity:read / activity:write /
// documents:read scopes on the token (see `login --scopes`).
async function docApi(flags, method, query, body) {
  const res = await fetch(`${BASE_URL}/api/doc?${new URLSearchParams(query).toString()}`, {
    method, headers: authHeaders(flags), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) fail(`${query.action} failed (${res.status}): ${data.error || 'unknown error'}`);
  return data;
}
async function cmdFeedback(positional, flags) {
  const q = { action: 'feedback' };
  if (positional[0]) q.id = positional[0];
  if (typeof flags.status === 'string') q.status = flags.status;
  else if (!positional[0]) q.status = 'open';
  printJson(await docApi(flags, 'GET', q));
}
async function cmdResolve(positional, flags) {
  if (!positional.length) fail('usage: mdshare-cli resolve <fb_id> [<fb_id> ...] [--in <new doc id>] [--status resolved|dismissed|open]');
  printJson(await docApi(flags, 'POST', { action: 'resolve' }, { ids: positional, status: typeof flags.status === 'string' ? flags.status : 'resolved', resolved_in: typeof flags.in === 'string' ? flags.in : null }));
}
async function cmdReads(positional, flags) {
  const q = positional.length ? { action: 'reads', ids: positional.join(',') } : { action: 'reads', unread: '1', days: String(flags.days || 7) };
  printJson(await docApi(flags, 'GET', q));
}
async function cmdVersions(positional, flags) {
  if (!positional[0]) fail('usage: mdshare-cli versions <id>');
  printJson(await docApi(flags, 'GET', { action: 'versions', id: positional[0] }));
}

async function cmdPublish(positional, flags) {
  const [id] = positional;
  const kind = flags.kind;
  const isPublicRaw = flags.public;
  if (!id || !kind || isPublicRaw === undefined) {
    fail('usage: mdshare-cli publish <id> --kind paste|diagram|archify --public true|false');
  }
  const is_public = String(isPublicRaw) === 'true';
  const res = await fetch(`${BASE_URL}/api/pin`, {
    method: 'PATCH',
    headers: authHeaders(flags),
    body: JSON.stringify({ id, kind, is_public }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`publish failed (${res.status}): ${data.error || 'unknown error'} — requires documents:publish on a document this token itself created`);
  printJson(data);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'login': return cmdLogin(flags);
    case 'status': return cmdStatus(flags);
    case 'search': return cmdSearch(positional, flags);
    case 'recent': return cmdSearch({ ...flags, q: undefined });
    case 'read': return cmdRead(positional, flags);
    case 'create': return cmdCreate(positional, flags);
    case 'publish': return cmdPublish(positional, flags);
    case 'feedback': return cmdFeedback(positional, flags);
    case 'resolve': return cmdResolve(positional, flags);
    case 'reads': return cmdReads(positional, flags);
    case 'versions': return cmdVersions(positional, flags);
    default:
      process.stderr.write([
        'mdshare-cli — portable CLI for the mdshare agent API',
        '',
        'Commands:',
        '  login [--name NAME] [--scopes documents:read,documents:write,...] [--days N]',
        '        [--token-file PATH] [--stdout] [--never-expires]',
        '      New-machine setup: hidden password prompt -> owner login -> issues a scoped',
        '      token -> writes it to a 0600 file (default ~/.mdshare/token). --stdout prints',
        '      ONLY the token to stdout (for piping into e.g. a secrets-store CLI) instead of',
        '      writing a file. Never pass the password as an argument — type it when prompted,',
        '      or set MDSHARE_OWNER_PASSWORD for non-interactive use.',
        '  status',
        '  search "<text>" [--limit N] [--offset N] [--json]   full text over titles + bodies (中文 too)',
        '  search [--q TERM] [--kind paste|diagram|archify|all] [--limit N] [--offset N]   catalog',
        '  recent [--kind K] [--limit N] [--offset N]',
        '  read <id | https://<site>/v/<id> link> [--kind paste|diagram|archify]',
        '  create paste|diagram <file> [--ttl SECONDS] [--title TITLE] [--keep]',
        '        [--parent ID] [--origin SESSION] [--strict]   (prints publish checks to stderr)',
        '  feedback [<doc id>] [--status open|resolved|dismissed]   (default: all open feedback)',
        '  resolve <fb_id>... [--in <new doc id>] [--status resolved|dismissed|open]',
        '  reads [<doc id>...] [--days N]   (no ids: documents the owner has not opened yet)',
        '  versions <id>',
        '  publish <id> --kind K --public true|false',
        '',
        'Token: set MDSHARE_AGENT_TOKEN or MDSHARE_AGENT_TOKEN_FILE (env), or --token-file <path>.',
        'Never pass a token as a bare CLI argument.',
      ].join('\n') + '\n');
      process.exit(command ? 1 : 0);
  }
}

// Only actually run as a CLI (parse real process.argv, call process.exit on error/usage) when
// this file is the process entrypoint. Importing it as a module (tests/cli-login.test.mjs) must
// never trigger argv parsing or process.exit — it only wants the exported functions below with
// global.fetch mocked.
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
    process.exit(1);
  });
}

export {
  parseArgs, resolveToken, authHeaders, readHiddenPassword,
  cmdLogin, cmdStatus, cmdSearch, cmdFullTextSearch, cmdRead, parseReadTarget, cmdCreate, cmdPublish, cmdFeedback, cmdResolve, cmdReads, cmdVersions, main,
  DEFAULT_TOKEN_FILE, CliError,
};
