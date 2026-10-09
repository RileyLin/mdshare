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
// env var, then --token-file <path> flag. Base URL: MDSHARE_BASE_URL env var, default the public
// hosted instance (same default as mcp/src/index.ts).
import { readFileSync } from 'node:fs';

const BASE_URL = (process.env.MDSHARE_BASE_URL || 'https://mdshare-rileylins-projects.vercel.app').replace(/\/$/, '');

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
  const filePath = process.env.MDSHARE_AGENT_TOKEN_FILE || flags['token-file'];
  if (filePath && typeof filePath === 'string') {
    try { return readFileSync(filePath, 'utf8').trim(); } catch (e) {
      fail(`Could not read token file: ${filePath} (${e.code || e.message})`);
    }
  }
  return '';
}

function authHeaders(flags) {
  const headers = { 'Content-Type': 'application/json' };
  const token = resolveToken(flags);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function fail(message) {
  process.stderr.write(String(message) + '\n');
  process.exit(1);
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
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

main().catch((err) => fail(err && err.message ? err.message : String(err)));
