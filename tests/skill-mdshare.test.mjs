// tests/skill-mdshare.test.mjs
//
// End-to-end-ish test for skills/openclaw/mdshare/scripts/mdshare.mjs against a tiny local fake
// HTTP server implementing the API contract fixed in
// projects/mdshare/multiuser-2026-11-27/PLAN.md ("API contract" section):
//   POST /api/auth?action=signup       -> 201 {user_id, token, entry_url, guide} | 403 beta full
//   POST /api/auth?action=entry-link   -> 200 {entry_url} (rotates the secret)
//   POST /api/share                    -> 200 {url, id, ...}
//   PATCH /api/pin                     -> 200 {ok, is_public}
//   GET  /v/:id                        -> 200 text/markdown | 404
//   GET  /api/doc?action=search&q=     -> 200 {results, total, next_offset} | 429
//
// The server is real node:http (http.createServer().listen(0, '127.0.0.1')) — a genuine local
// HTTP server, not a mock object. This sandbox's exec egress proxy wraps global fetch (undici)
// and refuses even loopback traffic through it (see tests/_fakedb.mjs and
// tests/cli-login.test.mjs for the same note), so global.fetch is pointed at the real server
// through node:http's http.request instead, exactly like tests/_fakedb.mjs's useFakeDb(). The
// skill script only ever calls the ambient `fetch`, so it exercises this real server end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MDSHARE_URL = 'http://fake-mdshare.invalid';
const {
  cmdSignup, cmdLink, cmdPublish, cmdRead, cmdSearch, readSavedToken,
} = await import('../skills/openclaw/mdshare/scripts/mdshare.mjs');

// --- tiny fake mdshare server -------------------------------------------------------------

function startFakeMdshare() {
  const tokens = new Map(); // token -> { userId }
  const entrySecretByToken = new Map(); // token -> current secret (for the entry_url)
  const docs = new Map(); // id -> { markdown, title, owner, is_public, kept }
  let userSeq = 0;
  let docSeq = 0;

  function origin(req) {
    return `http://${req.headers.host}`;
  }

  function issueUser() {
    userSeq += 1;
    const userId = `u_${userSeq}`;
    const token = `tok_${randomBytes(16).toString('hex')}`;
    tokens.set(token, { userId });
    entrySecretByToken.set(token, randomBytes(8).toString('hex'));
    return { userId, token };
  }

  function entryUrlFor(req, token) {
    return `${origin(req)}/enter#${entrySecretByToken.get(token)}`;
  }

  function bearerToken(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/.exec(header);
    return match ? match[1] : null;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, body, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    try {
      if (req.method === 'POST' && url.pathname === '/api/auth' && url.searchParams.get('action') === 'signup') {
        const body = await readBody(req);
        if (body.label === 'trigger-beta-full') return sendJson(res, 403, { error: 'beta full' });
        const { userId, token } = issueUser();
        return sendJson(res, 201, {
          user_id: userId,
          token,
          entry_url: entryUrlFor(req, token),
          guide: `${origin(req)}/guide`,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth' && url.searchParams.get('action') === 'entry-link') {
        const token = bearerToken(req);
        if (!token || !tokens.has(token)) return sendJson(res, 401, { error: 'Unauthorized' });
        entrySecretByToken.set(token, randomBytes(8).toString('hex')); // rotate: old link stops working
        return sendJson(res, 200, { entry_url: entryUrlFor(req, token) });
      }

      if (req.method === 'POST' && url.pathname === '/api/share') {
        const token = bearerToken(req);
        if (!token || !tokens.has(token)) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readBody(req);
        if (!body.markdown) return sendJson(res, 400, { error: 'markdown required' });
        docSeq += 1;
        const id = `doc_${docSeq}`;
        docs.set(id, {
          markdown: body.markdown,
          title: body.title || 'Untitled',
          owner: token,
          is_public: false,
          kept: !!body.keep,
        });
        return sendJson(res, 200, {
          url: `${origin(req)}/v/${id}`,
          id,
          kept: !!body.keep,
          expires_in: body.keep ? null : 86400,
          format_guide: `${origin(req)}/guide`,
          checks: { ok: true, warnings: [], stats: {} },
        });
      }

      if (req.method === 'PATCH' && url.pathname === '/api/pin') {
        const token = bearerToken(req);
        if (!token || !tokens.has(token)) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readBody(req);
        const doc = docs.get(body.id);
        if (!doc || doc.owner !== token) return sendJson(res, 404, { error: 'not found' });
        doc.is_public = !!body.is_public;
        return sendJson(res, 200, { ok: true, is_public: doc.is_public });
      }

      if (req.method === 'GET' && /^\/v\/[^/]+$/.test(url.pathname)) {
        const token = bearerToken(req);
        const id = url.pathname.slice('/v/'.length);
        const doc = docs.get(id);
        const owns = token && doc && doc.owner === token;
        if (!doc || !(owns || doc.is_public)) {
          return sendJson(res, 404, { error: 'not found', hint: 'private or missing document' });
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(doc.markdown);
      }

      if (req.method === 'GET' && url.pathname === '/api/doc' && url.searchParams.get('action') === 'search') {
        const token = bearerToken(req);
        if (!token || !tokens.has(token)) return sendJson(res, 401, { error: 'Unauthorized' });
        const q = url.searchParams.get('q') || '';
        if (q === 'RATE_LIMIT_TEST') {
          return sendJson(res, 429, { error: 'Too many searches: at most 60 a minute. Retry in 3s.', retry_after: 3 }, { 'Retry-After': '3' });
        }
        const results = [...docs.entries()]
          .filter(([, doc]) => doc.owner === token && (doc.markdown.includes(q) || doc.title.includes(q)))
          .map(([id, doc]) => ({
            id, title: doc.title, snippet: doc.markdown.slice(0, 80), created_at: new Date().toISOString(),
            kept: doc.kept, is_public: doc.is_public, url: `${origin(req)}/v/${id}`,
          }));
        return sendJson(res, 200, { results, total: results.length, next_offset: null });
      }

      return sendJson(res, 404, { error: 'no route', hint: `${req.method} ${url.pathname} is not part of the fake mdshare server` });
    } catch (e) {
      return sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        tokens,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Routes global.fetch to the real fake server above via node:http, bypassing undici/the egress
// proxy — same technique as tests/_fakedb.mjs's useFakeDb().
function mockFetchToServer(baseUrl) {
  const base = new URL(baseUrl);
  const original = global.fetch;
  global.fetch = (input, opts = {}) => new Promise((resolve, reject) => {
    const target = new URL(String(input), baseUrl);
    const method = opts.method || 'GET';
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path: target.pathname + target.search,
      method,
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text || 'null'),
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
  return () => { global.fetch = original; };
}

function captureStdout() {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  return { restore: () => { process.stdout.write = original; }, get: () => out };
}

// --- tests ---------------------------------------------------------------------------------

let server;
let restoreFetch;
let tmpDir;

test.before(async () => {
  server = await startFakeMdshare();
  restoreFetch = mockFetchToServer(server.baseUrl);
});

test.after(async () => {
  restoreFetch();
  await server.close();
});

test.beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mdshare-skill-test-'));
});

test.afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('full flow: signup -> saved token (0600) -> publish -> read -> search -> link, token never on stdout', async () => {
  const tokenFile = join(tmpDir, 'token.json');
  const docPath = join(tmpDir, 'doc.md');
  writeFileSync(docPath, '# Report\n\nSome long content.\n');

  const capture = captureStdout();
  let signupResult;
  let publishResult;
  let readResult;
  let searchResult;
  let linkResult;
  try {
    signupResult = await cmdSignup({}, tokenFile);
    publishResult = await cmdPublish([docPath], { title: 'Report' }, tokenFile);
    readResult = await cmdRead([publishResult.id], {}, tokenFile);
    searchResult = await cmdSearch(['Report'], {}, tokenFile);
    linkResult = await cmdLink({}, tokenFile);
  } finally {
    capture.restore();
  }

  // signup: token saved, never returned from the command, mode 0600.
  assert.equal(signupResult.ok, true);
  assert.ok(signupResult.user_id);
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/enter#/.test(signupResult.entry_url));
  assert.equal('token' in signupResult, false, 'cmdSignup must not return the token');
  const savedToken = readSavedToken(tokenFile);
  assert.ok(savedToken && savedToken.startsWith('tok_'));
  const mode = statSync(tokenFile).mode & 0o777;
  assert.equal(mode, 0o600, `expected token file mode 0600, got ${mode.toString(8)}`);
  const raw = readFileSync(tokenFile, 'utf8');
  assert.equal(JSON.parse(raw).token, savedToken);

  // publish
  assert.ok(publishResult.id);
  assert.ok(publishResult.url.includes(publishResult.id));

  // read back
  assert.match(readResult, /Some long content/);

  // search
  assert.equal(searchResult.results.length, 1);
  assert.equal(searchResult.results[0].id, publishResult.id);

  // link: rotates, still a valid /enter# url, different fragment from signup's
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/enter#/.test(linkResult.entry_url));
  assert.notEqual(linkResult.entry_url, signupResult.entry_url);

  // the raw token must never have been written to stdout at any point in this flow
  assert.equal(capture.get().includes(savedToken), false, 'the saved token leaked to stdout');
});

test('publish --public makes the document public (PATCH /api/pin)', async () => {
  const tokenFile = join(tmpDir, 'token.json');
  const docPath = join(tmpDir, 'doc.md');
  writeFileSync(docPath, '# Public report\n\nContent.\n');
  await cmdSignup({}, tokenFile);
  const result = await cmdPublish([docPath], { title: 'Public report', public: true }, tokenFile);
  assert.equal(result.is_public, true);
});

test('signup: beta full (403) surfaces a clear error and saves nothing', async () => {
  const tokenFile = join(tmpDir, 'token.json');
  await assert.rejects(
    () => cmdSignup({ label: 'trigger-beta-full' }, tokenFile),
    (err) => {
      assert.match(err.message, /beta.*full/i);
      return true;
    },
  );
  assert.equal(readSavedToken(tokenFile), '', 'no token should be saved after a beta-full signup');
});

test('search: 429 rate limit surfaces retry_after in the error message', async () => {
  const tokenFile = join(tmpDir, 'token.json');
  await cmdSignup({}, tokenFile);
  await assert.rejects(
    () => cmdSearch(['RATE_LIMIT_TEST'], {}, tokenFile),
    (err) => {
      assert.match(err.message, /429/);
      assert.match(err.message, /retry in 3s/i);
      return true;
    },
  );
});

test('read/link/publish/search without a saved token fail with a clear "run signup" message', async () => {
  const tokenFile = join(tmpDir, 'missing-token.json');
  for (const call of [
    () => cmdLink({}, tokenFile),
    () => cmdRead(['doc_1'], {}, tokenFile),
    () => cmdSearch(['x'], {}, tokenFile),
    () => cmdPublish([join(tmpDir, 'nope.md')], {}, tokenFile),
  ]) {
    await assert.rejects(call, /no saved mdshare token/);
  }
});
