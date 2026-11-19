// e2e/_proxy-guard.mjs
//
// This harness only ever talks to 127.0.0.1 (the fake Supabase + the local Vercel-emulator
// server) and must never reach the real network. This sandbox's egress proxy
// (HTTP_PROXY/HTTPS_PROXY + NODE_USE_ENV_PROXY=1 — the same mechanism CLAUDE.md's
// mdshare-cli.mjs section already documents biting a local-loopback test) intercepts every
// outbound request Node's global fetch() makes, including 127.0.0.1 loopback, and closes the
// socket for an unlisted host. That breaks every api/*.js handler's own fetch() call to
// SUPABASE_URL (our fake Supabase) the instant it runs.
//
// Confirmed while building this harness: Node/undici decides once, at process startup, whether
// to install the env-proxy-aware dispatcher — `delete process.env.HTTP_PROXY` etc *after* the
// process has already started has no effect on fetch(). The only fix is for those variables to
// already be absent when the `node` process itself launches. So: if they're present, re-exec this
// same entrypoint as a child process with a cleaned env and relay its exit code. The child is a
// brand-new node process that never saw the proxy vars, so its fetch() works normally.
import { spawn } from 'node:child_process';

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY'];
const MARKER = '__MDSHARE_E2E_NOPROXY__';

export async function ensureNoProxyEnv() {
  if (process.env[MARKER] === '1') return; // already the clean re-exec child
  const hasProxyEnv = PROXY_ENV_KEYS.some((k) => process.env[k] !== undefined);
  if (!hasProxyEnv) return; // nothing to work around in this environment

  const env = { ...process.env, [MARKER]: '1' };
  for (const k of PROXY_ENV_KEYS) delete env[k];

  const child = spawn(process.execPath, process.argv.slice(1), {
    env,
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  const code = await new Promise((resolve) => {
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
    child.on('error', () => resolve(1));
  });
  process.exit(code);
}
