// e2e/server.mjs
//
// A minimal local emulator of the pieces of Vercel's runtime this app actually depends on:
// vercel.json rewrites (including destination query params), static files from public/, and
// api/<name>.js default-export(req,res) handlers with the subset of the Vercel req/res surface
// those handlers actually touch (see CLAUDE.md / api/*.js reading done for this harness).
//
// Exports startServer({ port, root, supabaseUrl }) for use by run.mjs / drive.mjs. Also runnable
// directly: `node e2e/server.mjs --root <path> [--port N] --supabase-url <url>` for manual
// debugging against an already-running fake Supabase.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureNoProxyEnv } from './_proxy-guard.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function loadRewrites(root) {
  const vercelJsonPath = path.join(root, 'vercel.json');
  const cfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
  return Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
}

// "/v/:id" -> { regex: /^\/v\/([^/]+)$/, paramNames: ['id'] }
function compileSource(source) {
  const paramNames = [];
  const regexStr = source.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
    paramNames.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

// Returns the substituted destination string (e.g. "/api/render?id=abc123") for the first
// matching rewrite, or null if none match. Vercel tries rewrites in file order and stops at the
// first match — same here.
function matchRewrite(rewrites, pathname) {
  for (const rw of rewrites) {
    const { regex, paramNames } = compileSource(rw.source);
    const match = pathname.match(regex);
    if (!match) continue;
    const params = {};
    paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
    const destination = rw.destination.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
      const name = m.slice(1);
      return params[name] !== undefined ? encodeURIComponent(params[name]) : m;
    });
    return destination;
  }
  return null;
}

function parseDestination(destination) {
  const u = new URL(destination, 'http://internal.local');
  return { pathname: u.pathname, searchParams: u.searchParams };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(root, pathname, res) {
  const publicDir = path.join(root, 'public');
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

export async function startServer({ port = 0, root, supabaseUrl } = {}) {
  if (!root) throw new Error('startServer requires { root }');
  if (!supabaseUrl) throw new Error('startServer requires { supabaseUrl }');
  root = path.resolve(root);

  // Handler modules read these from process.env at import time (e.g. api/auth.js throws at
  // import time with no HMAC key) — must be set before the first dynamic import() below.
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'e2e-fake-service-key';
  process.env.MDSHARE_PASSWORD = 'e2e-test-password';
  process.env.MDSHARE_HMAC_SECRET = process.env.MDSHARE_HMAC_SECRET || 'e2e-test-hmac-secret-not-a-real-secret';

  const rewrites = loadRewrites(root);
  const handlerCache = new Map();

  async function loadHandler(apiName) {
    if (handlerCache.has(apiName)) return handlerCache.get(apiName);
    const filePath = path.join(root, 'api', `${apiName}.js`);
    const mod = await import(pathToFileURL(filePath).href);
    handlerCache.set(apiName, mod);
    return mod;
  }

  async function dispatchApi(apiName, rawReq, rawRes, destQuery, realQuery) {
    let mod;
    try {
      mod = await loadHandler(apiName);
    } catch (err) {
      rawRes.writeHead(404, { 'Content-Type': 'application/json' });
      rawRes.end(JSON.stringify({ error: `No such api handler: ${apiName}`, detail: String((err && err.message) || err) }));
      return;
    }

    const bodyBuf = await readRawBody(rawReq);
    const text = bodyBuf.toString('utf8');
    const contentType = rawReq.headers['content-type'] || '';
    let body;
    if (text.length === 0) {
      body = undefined;
    } else if (contentType.includes('application/json')) {
      try { body = JSON.parse(text); } catch { body = text; }
    } else {
      // Vercel's non-JSON default: raw text. Every handler in this app that reads req.body already
      // defensively does `if (typeof body === 'string') try { body = JSON.parse(body) } catch {}`,
      // so passing the raw text through (rather than guessing) matches the real platform contract.
      body = text;
    }

    const query = {};
    for (const [k, v] of realQuery.entries()) query[k] = v;
    for (const [k, v] of destQuery.entries()) query[k] = v; // rewrite-injected params (e.g. :id) win

    const vreq = {
      method: rawReq.method,
      url: rawReq.url,
      headers: rawReq.headers, // Node already lowercases header names, matching Vercel's req.headers
      query,
      body,
      cookies: {},
      socket: rawReq.socket,
    };

    let statusCode = 200;
    const headers = {};
    let finished = false;

    function finalize(payload) {
      if (finished) return;
      finished = true;
      rawRes.writeHead(statusCode, headers);
      rawRes.end(payload);
    }

    const vres = {
      get statusCode() { return statusCode; },
      set statusCode(v) { statusCode = v; },
      status(code) { statusCode = code; return vres; },
      setHeader(name, value) { headers[name] = value; },
      getHeader(name) {
        const match = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
        return match ? headers[match] : undefined;
      },
      json(payload) {
        if (!vres.getHeader('Content-Type')) headers['Content-Type'] = 'application/json; charset=utf-8';
        finalize(JSON.stringify(payload));
        return vres;
      },
      send(payload) {
        if (payload === undefined) { finalize(''); return vres; }
        if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
          if (!vres.getHeader('Content-Type')) headers['Content-Type'] = 'application/json; charset=utf-8';
          finalize(JSON.stringify(payload));
        } else {
          finalize(payload);
        }
        return vres;
      },
      end(payload) { finalize(payload === undefined ? '' : payload); return vres; },
      redirect(urlOrCode, maybeUrl) {
        let code = 307;
        let location = urlOrCode;
        if (typeof urlOrCode === 'number') { code = urlOrCode; location = maybeUrl; }
        statusCode = code;
        headers['Location'] = location;
        finalize('');
        return vres;
      },
    };

    try {
      await mod.default(vreq, vres);
    } catch (err) {
      if (!finished) {
        rawRes.writeHead(500, { 'Content-Type': 'application/json' });
        rawRes.end(JSON.stringify({ error: `handler "${apiName}" threw`, detail: String((err && err.stack) || err) }));
      }
    }
  }

  const server = http.createServer(async (rawReq, rawRes) => {
    try {
      const url = new URL(rawReq.url, 'http://internal.local');
      let pathname = url.pathname;
      let destQuery = new URLSearchParams();

      const destination = matchRewrite(rewrites, pathname);
      if (destination) {
        const parsed = parseDestination(destination);
        pathname = parsed.pathname;
        destQuery = parsed.searchParams;
      }

      if (pathname.startsWith('/api/')) {
        const apiName = pathname.slice('/api/'.length).replace(/\/+$/, '');
        await dispatchApi(apiName, rawReq, rawRes, destQuery, url.searchParams);
        return;
      }

      serveStatic(root, pathname, rawRes);
    } catch (err) {
      rawRes.writeHead(500, { 'Content-Type': 'application/json' });
      rawRes.end(JSON.stringify({ error: String((err && err.stack) || err) }));
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
    root,
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- Optional direct CLI run, for manual debugging against an already-running fake Supabase ---
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    }
  }
  return out;
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  await ensureNoProxyEnv();
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? path.resolve(args.root) : path.resolve(new URL('..', import.meta.url).pathname);
  const port = args.port ? Number(args.port) : 0;
  const supabaseUrl = args['supabase-url'];
  if (!supabaseUrl) {
    console.error('Usage: node e2e/server.mjs --supabase-url <url> [--root <path>] [--port <n>]');
    process.exit(1);
  }
  const { url } = await startServer({ port, root, supabaseUrl });
  console.log(`e2e server listening at ${url} (root=${root})`);
}
