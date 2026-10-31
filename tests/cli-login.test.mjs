// Unit tests for mdshare-cli.mjs's login flow and core helpers (added 2026-10-08, same-evening
// follow-up: "prefer portable CLI login with hidden password prompt -> /api/auth -> issue scoped
// per-machine token -> 0600 file (no tokens in args/output)").
//
// mdshare-cli.mjs is refactored so fail() throws (CliError) instead of calling process.exit(),
// and main()'s real argv-parsing/process.exit only runs when the file is executed directly (see
// the isDirectRun guard at the bottom of that file) — importing it here as a plain ES module and
// calling its exported cmd* functions directly, with global.fetch mocked, exercises the exact
// same code every real invocation runs, without needing a real network call. (A real spawned-
// subprocess-against-a-local-HTTP-server test was tried first; this sandbox's exec egress proxy
// refuses even 127.0.0.1 loopback traffic, so that approach isn't viable here — this approach has
// no such dependency.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MDSHARE_BASE_URL = 'https://example.invalid';
// Isolate DEFAULT_TOKEN_FILE (~/.mdshare/token) resolution from this machine's real $HOME --
// mdshare-cli.mjs computes it once at module-load time via os.homedir(), which respects $HOME,
// so setting this before the dynamic import below means these tests can never read or write a
// developer's actual ~/.mdshare/token.
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'mdshare-cli-home-'));
process.env.HOME = FAKE_HOME;

const { cmdLogin, cmdStatus, parseArgs, resolveToken, DEFAULT_TOKEN_FILE, CliError } = await import('../mcp/bin/mdshare-cli.mjs');

const FAKE_TOKEN = 'mds_fake_test_token_abcdefghijklmnopqrstuvwxyz';
const CORRECT_PASSWORD = 'correct-owner-password';

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

// Mocks the two-request sequence cmdLogin makes: POST /api/auth (password login, returns a
// Set-Cookie) then POST /api/auth {action:'create_token'} (requires that cookie).
function mockLoginServer({ password = CORRECT_PASSWORD, scopesEcho = true } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url: String(url), method: opts.method, headers: opts.headers || {}, body });
    if (body.action === 'create_token') {
      const cookieHeader = (opts.headers && (opts.headers.Cookie || opts.headers.cookie)) || '';
      if (!cookieHeader.includes('mdshare_auth=')) {
        return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
      }
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({
          ok: true, id: 'tok_test123', name: body.name, token: FAKE_TOKEN,
          expires_at: '2099-01-01T00:00:00Z', scopes: scopesEcho ? (body.scopes ?? null) : null,
        }),
      };
    }
    // password login
    if (body.password === password) {
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'set-cookie' ? 'mdshare_auth=realsession; Path=/; HttpOnly' : null) },
        json: async () => ({ ok: true }),
      };
    }
    return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'Wrong password' }) };
  };
  return calls;
}

let tmpDir;
test.before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mdshare-cli-test-')); });
test.after(() => { rmSync(tmpDir, { recursive: true, force: true }); restoreFetch(); });

test('cmdLogin (file mode): writes ONLY the token to a 0600 file, uses MDSHARE_OWNER_PASSWORD, never throws on success', async () => {
  const calls = mockLoginServer();
  const tokenFile = join(tmpDir, 'token-file-mode');
  process.env.MDSHARE_OWNER_PASSWORD = CORRECT_PASSWORD;
  try {
    // Capture stdout since cmdLogin prints a JSON summary on success (no token field).
    const originalWrite = process.stdout.write.bind(process.stdout);
    let stdout = '';
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    try {
      await cmdLogin({ name: 'test-machine', scopes: 'documents:read,documents:write', 'token-file': tokenFile });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.ok(existsSync(tokenFile));
    const content = readFileSync(tokenFile, 'utf8');
    assert.equal(content.trim(), FAKE_TOKEN);
    const mode = statSync(tokenFile).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    assert.ok(!stdout.includes(FAKE_TOKEN), 'the token must never be printed, even in the success summary');
    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.token_file, tokenFile);
    assert.equal('token' in summary, false);

    // Verify the actual request sequence: password login first, then create_token carrying the
    // session cookie from the login response, with the requested scopes passed through verbatim.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.password, CORRECT_PASSWORD);
    assert.equal(calls[1].body.action, 'create_token');
    assert.deepEqual(calls[1].body.scopes, ['documents:read', 'documents:write']);
    const cookieSent = calls[1].headers.Cookie || calls[1].headers.cookie;
    assert.ok(cookieSent.includes('mdshare_auth=realsession'));
  } finally {
    delete process.env.MDSHARE_OWNER_PASSWORD;
    restoreFetch();
  }
});

test('cmdLogin (--stdout mode): ONLY the raw token (plus trailing newline) goes to stdout; status goes to stderr', async () => {
  mockLoginServer();
  process.env.MDSHARE_OWNER_PASSWORD = CORRECT_PASSWORD;
  try {
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stdout = '', stderr = '';
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    process.stderr.write = (chunk) => { stderr += chunk; return true; };
    try {
      await cmdLogin({ name: 'test-machine-2', stdout: true });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    assert.equal(stdout, FAKE_TOKEN + '\n', 'stdout must be exactly the token, nothing else, for safe piping');
    assert.ok(stderr.includes('tok_test123'), 'human-readable status must go to stderr, not stdout');
    assert.ok(!stderr.includes(FAKE_TOKEN), 'the status line on stderr must not also leak the raw token');
  } finally {
    delete process.env.MDSHARE_OWNER_PASSWORD;
    restoreFetch();
  }
});

test('cmdLogin: wrong password fails closed (throws CliError), no file written, token never created', async () => {
  const calls = mockLoginServer();
  const tokenFile = join(tmpDir, 'token-should-not-exist');
  process.env.MDSHARE_OWNER_PASSWORD = 'definitely-wrong';
  try {
    await assert.rejects(
      () => cmdLogin({ 'token-file': tokenFile }),
      (err) => err instanceof CliError && /login failed/i.test(err.message)
    );
    assert.ok(!existsSync(tokenFile));
    assert.equal(calls.length, 1, 'create_token must never be requested when the login step itself failed');
  } finally {
    delete process.env.MDSHARE_OWNER_PASSWORD;
    restoreFetch();
  }
});

test('cmdLogin: there is no --password flag read anywhere — only MDSHARE_OWNER_PASSWORD or the interactive prompt supply the password', async () => {
  process.env.MDSHARE_OWNER_PASSWORD = 'the-real-env-password';
  const calls = mockLoginServer({ password: 'the-real-env-password' });
  const tokenFile = join(tmpDir, 'token-password-flag-ignored');
  try {
    // Passing an arbitrary "password" flag must have zero effect on what cmdLogin actually sends
    // as the login body — proving no code path reads flags.password; it must still send
    // MDSHARE_OWNER_PASSWORD's value and succeed.
    await cmdLogin({ password: 'totally-different-value-from-a-flag', 'token-file': tokenFile });
    assert.equal(calls[0].body.password, 'the-real-env-password', 'cmdLogin must only ever send MDSHARE_OWNER_PASSWORD (or the prompt), never a --password flag value');
  } finally {
    delete process.env.MDSHARE_OWNER_PASSWORD;
    restoreFetch();
  }
});

test('cmdStatus: throws CliError (never process.exit) on a non-ok response, surfacing the API error message', async () => {
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Token missing documents:read scope' }) });
  try {
    await assert.rejects(
      () => cmdStatus({}),
      (err) => err instanceof CliError && err.message.includes('403') && err.message.includes('documents:read')
    );
  } finally { restoreFetch(); }
});

test('parseArgs: never produces a token/password-shaped positional confusion for --flag value pairs', () => {
  const { positional, flags } = parseArgs(['read', 'abc123', '--kind', 'paste']);
  assert.deepEqual(positional, ['read', 'abc123']);
  assert.equal(flags.kind, 'paste');
});

test('resolveToken: never reads a --password or --token flag; only MDSHARE_AGENT_TOKEN / MDSHARE_AGENT_TOKEN_FILE / --token-file / default file', () => {
  delete process.env.MDSHARE_AGENT_TOKEN;
  delete process.env.MDSHARE_AGENT_TOKEN_FILE;
  assert.equal(resolveToken({ token: 'should-be-ignored-no-such-flag-is-read' }), '', 'a bare --token flag (which this CLI does not define) must never be picked up as the token; with no default file present yet this is also the no-token-configured case');
  process.env.MDSHARE_AGENT_TOKEN = 'env-token-value';
  assert.equal(resolveToken({}), 'env-token-value');
  delete process.env.MDSHARE_AGENT_TOKEN;
});

test('resolveToken: falls back to DEFAULT_TOKEN_FILE (~/.mdshare/token) when nothing explicit is configured', () => {
  delete process.env.MDSHARE_AGENT_TOKEN;
  delete process.env.MDSHARE_AGENT_TOKEN_FILE;
  // Nothing written yet at the (fake, isolated) default path -> still anonymous, not an error.
  assert.equal(resolveToken({}), '', 'missing default file must resolve to anonymous, never throw');

  // Simulates what `mdshare-cli login` (no --token-file) writes: 0600 file at DEFAULT_TOKEN_FILE.
  mkdirSync(join(DEFAULT_TOKEN_FILE, '..'), { recursive: true });
  writeFileSync(DEFAULT_TOKEN_FILE, 'mds_default_file_token_value\n', { mode: 0o600 });
  assert.equal(resolveToken({}), 'mds_default_file_token_value', 'a post-login default file must now be picked up with zero flags/env vars');

  rmSync(DEFAULT_TOKEN_FILE, { force: true });
});

test('resolveToken: precedence is env var > explicit file (env or flag) > default file > anonymous', () => {
  delete process.env.MDSHARE_AGENT_TOKEN;
  delete process.env.MDSHARE_AGENT_TOKEN_FILE;
  mkdirSync(join(DEFAULT_TOKEN_FILE, '..'), { recursive: true });
  writeFileSync(DEFAULT_TOKEN_FILE, 'default-file-token', { mode: 0o600 });

  // Default file wins when nothing explicit is set.
  assert.equal(resolveToken({}), 'default-file-token');

  // An explicit --token-file wins over the default file.
  const explicitPath = join(FAKE_HOME, 'explicit-flag-token');
  writeFileSync(explicitPath, 'explicit-flag-token-value');
  assert.equal(resolveToken({ 'token-file': explicitPath }), 'explicit-flag-token-value');

  // MDSHARE_AGENT_TOKEN_FILE wins over --token-file (and the default file).
  const explicitEnvPath = join(FAKE_HOME, 'explicit-env-token');
  writeFileSync(explicitEnvPath, 'explicit-env-token-value');
  process.env.MDSHARE_AGENT_TOKEN_FILE = explicitEnvPath;
  assert.equal(resolveToken({ 'token-file': explicitPath }), 'explicit-env-token-value');

  // MDSHARE_AGENT_TOKEN wins over everything, including the two explicit-file env/flag options.
  process.env.MDSHARE_AGENT_TOKEN = 'top-priority-env-token';
  assert.equal(resolveToken({ 'token-file': explicitPath }), 'top-priority-env-token');

  delete process.env.MDSHARE_AGENT_TOKEN;
  delete process.env.MDSHARE_AGENT_TOKEN_FILE;
  rmSync(DEFAULT_TOKEN_FILE, { force: true });
});

test('resolveToken: an explicit but unreadable --token-file is still a hard error, never silently falls through to the default file', () => {
  delete process.env.MDSHARE_AGENT_TOKEN;
  delete process.env.MDSHARE_AGENT_TOKEN_FILE;
  mkdirSync(join(DEFAULT_TOKEN_FILE, '..'), { recursive: true });
  writeFileSync(DEFAULT_TOKEN_FILE, 'default-file-token-should-not-be-reached');
  const missingPath = join(FAKE_HOME, 'does-not-exist-token-file');
  assert.throws(() => resolveToken({ 'token-file': missingPath }), CliError);
  rmSync(DEFAULT_TOKEN_FILE, { force: true });
});
