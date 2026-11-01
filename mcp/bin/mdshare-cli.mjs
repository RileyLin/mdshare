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
//   mdshare-cli search [--q TERM] [--kind paste|diagram|archify|all] [--limit N] [--offset N]
//   mdshare-cli recent [--kind K] [--limit N] [--offset N]      (alias for search with no --q)
//   mdshare-cli read <id> --kind paste|diagram|archify
//   mdshare-cli create <kind> <file> [--ttl SECONDS] [--title TITLE]   (kind: paste|diagram|archify)
//   mdshare-cli publish <id> --kind K --public true|false
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

async function cmdSearch(flags) {
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

async function cmdRead(positional, flags) {
  const [id] = positional;
  const kind = flags.kind;
  if (!id || !kind) fail('usage: mdshare-cli read <id> --kind paste|diagram|archify');
  const path = READ_WRITE_PATH[kind];
  if (!path) fail(`unknown kind: ${kind}`);
  const res = await fetch(`${BASE_URL}${path}?id=${encodeURIComponent(id)}`, { headers: authHeaders(flags) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    fail(`read failed (${res.status}): ${data.error || 'unknown error'}`);
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

  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: authHeaders(flags), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`create failed (${res.status}): ${data.error || 'unknown error'}`);
  printJson(data);
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
    case 'search': return cmdSearch(flags);
    case 'recent': return cmdSearch({ ...flags, q: undefined });
    case 'read': return cmdRead(positional, flags);
    case 'create': return cmdCreate(positional, flags);
    case 'publish': return cmdPublish(positional, flags);
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
        '  search [--q TERM] [--kind paste|diagram|archify|all] [--limit N] [--offset N]',
        '  recent [--kind K] [--limit N] [--offset N]',
        '  read <id> --kind paste|diagram|archify',
        '  create paste|diagram <file> [--ttl SECONDS] [--title TITLE]',
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
  cmdLogin, cmdStatus, cmdSearch, cmdRead, cmdCreate, cmdPublish, main,
  DEFAULT_TOKEN_FILE, CliError,
};
