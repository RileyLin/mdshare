#!/usr/bin/env node
// mdshare skill helper — zero dependencies, Node >=20 global fetch.
//
// Talks to the mdshare multi-user API (see ../SKILL.md and the repo's public/llms.txt).
// The agent token this script signs up for is saved to a local, mode-600 file and is NEVER
// printed to stdout/stderr, logged, or accepted as a CLI argument — only read back from that
// file (or MDSHARE_SKILL_TOKEN env, for advanced/non-file setups).
//
// Commands:
//   mdshare.mjs signup [--label TEXT]
//   mdshare.mjs publish <file|-> [--title TEXT] [--public]
//   mdshare.mjs read <id>
//   mdshare.mjs search <text...> [--limit N] [--offset N]
//   mdshare.mjs link
//
// Env:
//   MDSHARE_URL                base URL, default https://mdshare-rileylins-projects.vercel.app
//   MDSHARE_SKILL_TOKEN_FILE   token file path, default <state dir>/mdshare-skill/token.json
//   MDSHARE_SKILL_TOKEN        use this token directly instead of reading the file (optional)
//   OPENCLAW_STATE_DIR         base for the default state dir (default ~/.openclaw)
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const BASE_URL = (process.env.MDSHARE_URL || 'https://mdshare-rileylins-projects.vercel.app').replace(/\/$/, '');

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw');
export const DEFAULT_TOKEN_FILE = join(STATE_DIR, 'mdshare-skill', 'token.json');
export const TOKEN_FILE = process.env.MDSHARE_SKILL_TOKEN_FILE || DEFAULT_TOKEN_FILE;

export class CliError extends Error {}

function fail(message) {
  // Thrown, not process.exit()'d, so every cmd* below stays a plain async function the test
  // file can call directly with a mocked global.fetch. Only the real CLI entrypoint (main(),
  // guarded at the bottom) turns this into a stderr message + exit code 1.
  throw new CliError(String(message));
}

// Reads the saved token. Returns '' (anonymous) when nothing is saved yet — callers that need
// a token call requireToken() instead, which fails with a clear "run signup" message.
export function readSavedToken(tokenFile = TOKEN_FILE) {
  if (process.env.MDSHARE_SKILL_TOKEN) return process.env.MDSHARE_SKILL_TOKEN;
  try {
    const raw = readFileSync(tokenFile, 'utf8');
    const data = JSON.parse(raw);
    return typeof data.token === 'string' ? data.token : '';
  } catch {
    return '';
  }
}

export function saveToken({ token, user_id, created_at }, tokenFile = TOKEN_FILE) {
  const dir = dirname(tokenFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = { token, user_id, created_at: created_at || new Date().toISOString() };
  writeFileSync(tokenFile, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600); // belt-and-suspenders against umask overriding the mode above
  return tokenFile;
}

function requireToken(tokenFile = TOKEN_FILE) {
  const token = readSavedToken(tokenFile);
  if (!token) fail('no saved mdshare token — run "signup" first');
  return token;
}

function authHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// One fetch helper for every JSON endpoint, with the shared 401/403/429 error mapping. `read`
// and `search`/`publish`/`link`/`signup` all go through this except the raw-Markdown GET in
// cmdRead, which needs the response body as text, not JSON.
async function requestJson(path, { method = 'GET', token, body, query, baseUrl = BASE_URL } = {}) {
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: authHeaders(token),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`could not reach ${baseUrl} (${e && e.message ? e.message : e})`);
  }
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) fail(describeError(res, data));
  return data;
}

function describeError(res, data) {
  if (res.status === 429) {
    const retryAfter = data.retry_after ?? res.headers.get('retry-after');
    return `rate limited (429)${retryAfter ? ` — retry in ${retryAfter}s` : ''}: ${data.error || 'too many requests'}`;
  }
  if (res.status === 403 && /beta full/i.test(data.error || '')) {
    return 'mdshare beta is full (403): no signup seats left right now — try again later';
  }
  if (res.status === 401) {
    return `unauthorized (401): ${data.error || 'the saved token is missing or invalid'} — run "signup" again`;
  }
  return `request failed (${res.status}): ${data.error || 'unknown error'}`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- commands ---

export async function cmdSignup(flags = {}, tokenFile = TOKEN_FILE) {
  const body = {};
  if (flags.label) body.label = String(flags.label);
  const data = await requestJson('/api/auth?action=signup', { method: 'POST', body });
  if (!data.token || !data.entry_url) fail('signup response is missing token or entry_url');
  saveToken({ token: data.token, user_id: data.user_id }, tokenFile);
  // Deliberately omit `token` from the returned object: this is what the caller may print.
  return { ok: true, user_id: data.user_id, entry_url: data.entry_url, guide: data.guide, token_file: tokenFile };
}

export async function cmdLink(flags = {}, tokenFile = TOKEN_FILE) {
  const token = requireToken(tokenFile);
  const data = await requestJson('/api/auth?action=entry-link', { method: 'POST', token });
  if (!data.entry_url) fail('entry-link response is missing entry_url');
  return { ok: true, entry_url: data.entry_url };
}

export async function cmdPublish(positional = [], flags = {}, tokenFile = TOKEN_FILE) {
  const [source] = positional;
  if (!source) fail('usage: mdshare.mjs publish <file|-> [--title TEXT] [--public]');
  const token = requireToken(tokenFile);
  let markdown;
  if (source === '-') {
    markdown = await readStdin();
  } else {
    try { markdown = readFileSync(source, 'utf8'); } catch (e) {
      fail(`could not read file: ${source} (${e && e.code ? e.code : e.message})`);
    }
  }
  const body = { markdown, keep: true };
  if (flags.title) body.title = String(flags.title);
  const data = await requestJson('/api/share', { method: 'POST', token, body });
  if (flags.public && data.id) {
    await requestJson('/api/pin', {
      method: 'PATCH',
      token,
      body: { id: data.id, kind: 'paste', is_public: true, keep: true },
    });
    data.is_public = true;
  }
  return data;
}

export async function cmdRead(positional = [], flags = {}, tokenFile = TOKEN_FILE) {
  const [id] = positional;
  if (!id) fail('usage: mdshare.mjs read <id>');
  const token = requireToken(tokenFile);
  let res;
  try {
    res = await fetch(`${BASE_URL}/v/${encodeURIComponent(id)}`, { headers: authHeaders(token) });
  } catch (e) {
    fail(`could not reach ${BASE_URL} (${e && e.message ? e.message : e})`);
  }
  const text = await res.text();
  if (!res.ok) {
    let data = {};
    try { data = JSON.parse(text); } catch { /* not JSON; keep data = {} */ }
    fail(describeError(res, data));
  }
  return text;
}

export async function cmdSearch(positional = [], flags = {}, tokenFile = TOKEN_FILE) {
  const q = positional.join(' ').trim();
  if (!q) fail('usage: mdshare.mjs search <text...>');
  const token = requireToken(tokenFile);
  return requestJson('/api/doc', {
    token,
    query: { action: 'search', q, limit: flags.limit, offset: flags.offset },
  });
}

// --- CLI plumbing ---

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function usage() {
  return [
    'mdshare.mjs — publish and read mdshare documents for the OpenClaw mdshare skill',
    '',
    'Commands:',
    '  signup [--label TEXT]            sign up once; saves a private token and prints the entry_url',
    '  publish <file|-> [--title TEXT] [--public]   publish Markdown; - reads stdin',
    '  read <id>                        print the raw Markdown for a document',
    '  search <text...> [--limit N] [--offset N]    full-text search',
    '  link                             re-send a fresh private entry link',
    '',
    `Base URL: ${BASE_URL} (override with MDSHARE_URL).`,
    `Token file: ${TOKEN_FILE} (override with MDSHARE_SKILL_TOKEN_FILE). The token is never printed.`,
  ].join('\n');
}

export async function main() {
  const [, , command, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case 'signup': return printJson(await cmdSignup(flags));
    case 'link': return printJson(await cmdLink(flags));
    case 'publish': return printJson(await cmdPublish(positional, flags));
    case 'search': return printJson(await cmdSearch(positional, flags));
    case 'read': {
      const text = await cmdRead(positional, flags);
      return process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    }
    default:
      process.stderr.write(`${usage()}\n`);
      process.exit(command ? 1 : 0);
  }
}

// Only run as a CLI (parse real process.argv, call process.exit on error) when this file is the
// process entrypoint. Importing it as a module (tests/skill-mdshare.test.mjs) must never trigger
// argv parsing or process.exit — it only wants the exported cmd* functions with a mocked
// global.fetch and an isolated token file path.
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
