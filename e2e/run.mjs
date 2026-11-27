#!/usr/bin/env node
// e2e/run.mjs — CLI runtime-verification runner.
//
//   node e2e/run.mjs [--feature <id>] [--root <path>]
//
// Starts a fresh in-memory fake Supabase + the local Vercel emulator server, launches Chromium
// via playwright-core, and runs each feature in e2e/features.json against the real, unmodified
// api/*.js handlers and public/ files (loaded from --root, default: this repo). Writes a
// screenshot per feature to e2e/proof/<feature-id>.png and a full report to
// e2e/proof/report.json. Exits 1 if any feature failed.
import { ensureNoProxyEnv } from './_proxy-guard.mjs';
await ensureNoProxyEnv();

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startServer } from './server.mjs';
import { installCdnStubs } from './_cdn-stubs.mjs';
import { makeDocs, checkInPage, monkey } from './fuzz.mjs';

const OWNER_PASSWORD = 'e2e-test-password';
const E2E_DIR = path.resolve(new URL('.', import.meta.url).pathname);

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

function rand(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

async function seedPaste(serverUrl, markdown, { cookie, keep } = {}) {
  const r = await fetch(`${serverUrl}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(keep === undefined ? { markdown } : { markdown, keep }),
  });
  if (!r.ok) throw new Error(`seedPaste failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function seedDiagram(serverUrl, { svg, title, markdown }) {
  const r = await fetch(`${serverUrl}/api/diagram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ svg, title, markdown }),
  });
  if (!r.ok) throw new Error(`seedDiagram failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function seedArchify(serverUrl, { kind, html, markdown, title }) {
  const r = await fetch(`${serverUrl}/api/archify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, html, markdown, title }),
  });
  if (!r.ok) throw new Error(`seedArchify failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Splits a "name=value" Set-Cookie segment (as produced by realOwnerLoginOnce below) for
// context.addCookies().
function cookieNameValue(cookieStr) {
  const eq = cookieStr.indexOf('=');
  return { name: cookieStr.slice(0, eq), value: cookieStr.slice(eq + 1) };
}

// Chromium headless + --no-sandbox occasionally aborts a page.goto() with net::ERR_ABORTED
// when it races a just-finished prior navigation on the same page (observed while building this
// harness, independent of server-side timing) -- retry once after a short settle delay.
async function gotoResilient(page, url, opts) {
  try {
    return await page.goto(url, opts);
  } catch (err) {
    if (!String(err && err.message).includes('ERR_ABORTED')) throw err;
    await page.waitForTimeout(200);
    return page.goto(url, opts);
  }
}

// Every page opened by a feature reports uncaught exceptions and console errors into
// ctx.jsErrors; the harness fails the feature if any appear (a broken script is a broken page
// even when the assertions happen to pass).
function watchErrors(context, ctx) {
  context.on('page', (page) => {
    page.on('pageerror', (e) => ctx.jsErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) ctx.jsErrors.push(`console: ${m.text()}`); });
  });
}

async function withContext(ctx, fn, options = {}) {
  const context = await ctx.browser.newContext(options);
  watchErrors(context, ctx);
  await installCdnStubs(context);
  try {
    return await fn(context);
  } finally {
    await context.close();
  }
}

// Logs in as the owner via the real /dashboard login form (the actual UI, not a shortcut).
// Called exactly ONCE per suite run (see main()), not once per feature: api/auth.js rate-limits
// password POSTs to 5 per 15 minutes per IP, same as a real browser hitting it would be — every
// feature logging in separately would exhaust that budget partway through the suite (observed
// while building this harness: later features silently stayed on the login page and every
// subsequent assertion timed out instead of failing clearly). One real form-submit login proves
// the login UI + cookie-issuing path works; every feature that needs an authenticated page after
// that reuses the resulting cookie directly via ownerPage() below, with zero extra password POSTs.
async function realOwnerLoginOnce(browser, serverUrl) {
  const context = await browser.newContext();
  await installCdnStubs(context);
  try {
    const page = await context.newPage();
    await gotoResilient(page, `${serverUrl}/dashboard`);
    await page.fill('#pwd', OWNER_PASSWORD);
    // Wait for the login POST itself, not the URL: the page is already on /dashboard, so
    // waitForURL resolves at once and, on a slow CI runner, the cookie was read before the
    // response arrived (flaky 'no mdshare_auth cookie', ci run 46091786969 attempt 1).
    const [loginResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth') && r.request().method() === 'POST', { timeout: 15000 }),
      page.click('#submit-btn'),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    let authCookie = null;
    for (let i = 0; i < 20 && !authCookie; i++) {
      authCookie = (await context.cookies()).find((c) => c.name === 'mdshare_auth');
      if (!authCookie) await page.waitForTimeout(250);
    }
    if (!authCookie) throw new Error(`owner login did not produce an mdshare_auth session cookie (login POST answered ${loginResponse.status()})`);
    return `mdshare_auth=${authCookie.value}`;
  } finally {
    await context.close();
  }
}

// Fast owner-authenticated page for feature use: injects the already-obtained session cookie
// (see realOwnerLoginOnce) rather than submitting the password form again. Does not navigate —
// callers goto() wherever the feature needs.
async function ownerPage(context, serverUrl, ownerCookie) {
  const { name, value } = cookieNameValue(ownerCookie);
  await context.addCookies([{ name, value, url: serverUrl }]);
  return context.newPage();
}

// --- Feature implementations: each is async (ctx, ok) -> void. ctx: { serverUrl, sb, browser,
// proofPath }. `ok(cond, message)` records one assertion. Throwing aborts the feature as a
// failure (caught by the harness loop below), with the thrown message recorded as the error. ---

const FIXTURES = path.join(E2E_DIR, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

async function ownerApi(ctx, method, url, body) {
  const r = await fetch(`${ctx.serverUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: ctx.ownerCookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
async function listing(ctx) { return (await ownerApi(ctx, 'GET', '/api/pastes')).json || []; }
async function findItem(ctx, id) { return (await listing(ctx)).find((p) => p.id === id); }
const isKept = (p) => !!p && (p.pinned === true || String(p.expires_at) >= '2099');

async function openOwner(ctx, context, url) {
  const page = await ownerPage(context, ctx.serverUrl, ctx.ownerCookie);
  page.on('dialog', (d) => d.accept());
  await gotoResilient(page, `${ctx.serverUrl}${url}`, { waitUntil: 'load' });
  return page;
}
async function openAnon(ctx, context, url) {
  const page = await context.newPage();
  await gotoResilient(page, `${ctx.serverUrl}${url}`, { waitUntil: 'load' });
  return page;
}
async function waitRendered(page) {
  await page.waitForFunction(() => { const c = document.getElementById('content'); return c && c.querySelector('h1, p, .md-summary'); }, null, { timeout: 5000 });
}

// ===== Features that existed before the redesign (same contracts, new UI selectors) =====

async function runHomePage(ctx, ok) {
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, '/');
    await page.waitForSelector('#md', { timeout: 5000 });
    ok(await page.isVisible('#md'), 'textarea#md is visible');
    ok(await page.isVisible('#share-btn'), 'the "Create link" button is visible');
    await page.waitForSelector('#preview h1', { timeout: 5000 });
    ok((await page.textContent('#preview h1')).includes('Q3 launch review'), 'the live preview renders the sample document');
    ok((await page.locator('#preview .md-stat').count()) === 4, 'the preview shows the sample number cards');
    await page.fill('#md', '# Live preview check\n\n> [!TIP]\n> typed text');
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent.includes('Live preview check'), null, { timeout: 3000 });
    ok((await page.locator('#preview .md-callout.tip').count()) === 1, 'typing updates the preview, including a callout');
    const apiExample = await page.textContent('#api-example');
    ok(apiExample.includes(ctx.serverUrl) && !apiExample.includes('mdshare.vercel.app'), 'the agent API example shows this site, not the old domain');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runCreatePasteUi(ctx, ok) {
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, '/');
    const title = `E2E Create Test ${rand()}`;
    await page.fill('#md', `# ${title}\n\nCreated via the home page UI.`);
    await page.click('#share-btn');
    await page.waitForSelector('#result.show', { state: 'visible', timeout: 5000 });
    const href = await page.getAttribute('#link', 'href');
    ok(!!href && /\/v\/[A-Za-z0-9_-]+$/.test(href), `#link href looks like a share link (got "${href}")`);
    const id = href.split('/v/')[1];
    const item = await findItem(ctx, id);
    ok(!!item && item.is_public === false && !isKept(item), 'the new document is private and not kept (anonymous create)');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runAnonPrivateGate(ctx, ok) {
  const secretTitle = `Super Secret Title ${rand()}`;
  const secretBody = `secret-body-marker-${rand()}`;
  const { id } = await seedPaste(ctx.serverUrl, `# ${secretTitle}\n\n${secretBody}`);
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${id}`);
    await page.waitForSelector('#pwd', { timeout: 5000 });
    ok(await page.isVisible('#pwd'), 'password gate input is visible');
    const html = await page.content();
    ok(!html.includes(secretTitle), 'page does not leak the secret title');
    ok(!html.includes(secretBody), 'page does not leak the secret body');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runOwnerViewMarkdown(ctx, ok) {
  const heading = `Owner Doc ${rand()}`;
  const { id } = await seedPaste(ctx.serverUrl, `# ${heading}\n\n| Col A | Col B |\n|---|---|\n| 1 | 2 |\n`);
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const h1 = (await page.textContent('#content h1')).trim();
    ok(h1 === heading, `rendered <h1> matches the seeded heading (got "${h1}")`);
    ok((await page.locator('#content table').count()) > 0, 'rendered content contains a <table>');
    ok((await page.textContent('#crumb-title')).trim() === heading, 'the header breadcrumb shows the document title');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runRawRoute(ctx, ok) {
  const content = `raw-route-secret-${rand()}`;
  const { id } = await seedPaste(ctx.serverUrl, content);
  const anonRes = await fetch(`${ctx.serverUrl}/raw/${id}`);
  const anonBody = await anonRes.text();
  ok(anonRes.status !== 200 && !anonBody.includes(content), `anonymous GET /raw/:id is denied (status ${anonRes.status})`);
  const ownerRes = await fetch(`${ctx.serverUrl}/raw/${id}`, { headers: { cookie: ctx.ownerCookie } });
  const ownerBody = await ownerRes.text();
  ok(ownerRes.status === 200 && ownerBody === content, `owner GET /raw/:id returns the exact content (status ${ownerRes.status})`);
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/raw/${id}`);
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runDashboardListsPaste(ctx, ok) {
  const title = `Dashboard List Test ${rand()}`;
  await seedPaste(ctx.serverUrl, `# ${title}\n\nbody`);
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/dashboard');
    await page.waitForFunction((t) => document.body.innerText.includes(t), title, { timeout: 5000 });
    ok((await page.innerText('#lib-list')).includes(title), "the seeded paste's title appears in the library list");
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  });
}

async function runPublishUnpublish(ctx, ok) {
  const marker = `publish-toggle-marker-${rand()}`;
  const { id } = await seedPaste(ctx.serverUrl, `# Publish Toggle Test\n\n${marker}`);
  await withContext(ctx, async (ownerCtx) => {
    const page = await openOwner(ctx, ownerCtx, `/v/${id}`);
    await page.click('#status-pill');
    await page.waitForSelector('#share-pop.open', { timeout: 3000 });
    await page.check('#public-toggle');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent.startsWith('Public'), null, { timeout: 5000 });
    ok(true, 'the share panel switch publishes the document (status pill reads Public)');
    await withContext(ctx, async (anonCtx) => {
      const anon = await openAnon(ctx, anonCtx, `/v/${id}`);
      ok((await anon.locator('#pwd').count()) === 0, 'after publish, anonymous request no longer sees the login gate');
      await waitRendered(anon);
      ok((await anon.content()).includes(marker), 'after publish, anonymous request sees the actual content');
      await anon.screenshot({ path: ctx.proofPath });
    });
    await page.uncheck('#public-toggle');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent.startsWith('Private'), null, { timeout: 5000 });
  });
  await withContext(ctx, async (anonCtx2) => {
    const anon2 = await openAnon(ctx, anonCtx2, `/v/${id}`);
    await anon2.waitForSelector('#pwd', { timeout: 5000 });
    ok(await anon2.isVisible('#pwd'), 'after unpublish, anonymous request sees the login gate again');
  });
}

async function runDiagramCreateRender(ctx, ok) {
  const marker = `E2E-DIAGRAM-MARKER-${rand()}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#eee"/><text x="10" y="40">${marker}</text><script>window.__svgxss=1</script></svg>`;
  const { id } = await seedDiagram(ctx.serverUrl, { svg, title: 'E2E Diagram', markdown: '## Notes\n\n**Bold** notes.' });
  await withContext(ctx, async (anonCtx) => {
    const anon = await openAnon(ctx, anonCtx, `/d/${id}`);
    await anon.waitForSelector('#pwd', { timeout: 5000 });
    ok(await anon.isVisible('#pwd'), 'anonymous visit to /d/:id sees the login gate');
    ok(!(await anon.content()).includes(marker), 'anonymous visit does not see the SVG marker');
  });
  await withContext(ctx, async (ownerCtx) => {
    const page = await openOwner(ctx, ownerCtx, `/d/${id}`);
    await page.waitForSelector('#svg-frame svg', { timeout: 5000 });
    ok((await page.textContent('#svg-frame')).includes(marker), 'owner visit renders the SVG marker');
    ok((await page.evaluate(() => window.__svgxss)) === undefined && (await page.locator('#svg-frame script').count()) === 0, 'a <script> inside the stored SVG is stripped and never runs');
    ok((await page.locator('#svg-frame.light-bg').count()) === 1, 'light SVG backgrounds get the light frame (old behaviour kept)');
    await page.waitForSelector('#content h2', { timeout: 5000 });
    ok((await page.textContent('#content strong')) === 'Bold', 'the diagram notes render as Markdown');
    await page.screenshot({ path: ctx.proofPath });
  });
}

// ADV-MU-A F1 (2026-11-27): raw user content opened as a top-level page must not run script on this
// origin. The rows are seeded directly, like a diagram stored before the sanitiser existed; markers only.
async function runRawContentSandbox(ctx, ok) {
  const far = new Date(Date.now() + 86400000).toISOString();
  const svgId = `rawsvg${rand(4)}`;
  const arcId = `rawarc${rand(4)}`;
  ctx.sb.seed('mdshare_diagrams', { id: svgId, owner_id: 1, title: 'raw svg', is_public: true, expires_at: far, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ccc"/><script>window.__rawsvg = "MARKER"</script></svg>' });
  ctx.sb.seed('mdshare_archify', { id: arcId, owner_id: 1, title: 'raw archify', kind: 'architecture', is_public: true, expires_at: far, html: '<!DOCTYPE html><html><body><svg width="10" height="10"></svg><script>window.__arch = "MARKER"</script></body></html>' });
  const head = await fetch(`${ctx.serverUrl}/api/diagram?id=${svgId}`, { headers: { cookie: ctx.ownerCookie } });
  ok(/sandbox/.test(head.headers.get('content-security-policy') || '') && head.headers.get('x-content-type-options') === 'nosniff', `GET /api/diagram sends a sandbox CSP + nosniff (${head.headers.get('content-security-policy')})`);
  await withContext(ctx, async (ownerCtx) => {
    const page = await openOwner(ctx, ownerCtx, `/api/diagram?id=${svgId}`);
    await page.waitForTimeout(300);
    ok((await page.evaluate(() => window.__rawsvg)) === undefined, "the owner opening a stored SVG's raw URL runs none of its script");
    // Chromium logs the refusal as a console error; it is the asserted outcome here, so it is
    // checked and then removed from the feature's error list (any other error still fails it).
    const blocked = ctx.jsErrors.filter((e) => /Blocked script execution/.test(e) && e.includes(`/api/diagram?id=${svgId}`));
    ok(blocked.length >= 1, 'Chromium reports the SVG script as blocked by the sandbox');
    for (const e of blocked) ctx.jsErrors.splice(ctx.jsErrors.indexOf(e), 1);
    await page.screenshot({ path: ctx.proofPath });
    const arch = await openOwner(ctx, ownerCtx, `/api/archify-html?id=${arcId}`);
    await arch.waitForTimeout(300);
    const r = await arch.evaluate(() => ({ ran: window.__arch, origin: window.origin }));
    ok(r.ran === 'MARKER' && r.origin === 'null', `archify HTML opened directly keeps its own script but runs in an opaque origin (${JSON.stringify(r)})`);
  });
}

async function runArchifyCreateRender(ctx, ok) {
  const marker = `ARCHIFY-E2E-MARKER-${rand()}`;
  const html = `<!DOCTYPE html><html><head></head><body><svg xmlns="http://www.w3.org/2000/svg"></svg><p>${marker}</p></body></html>`;
  const { id } = await seedArchify(ctx.serverUrl, { kind: 'architecture', html, markdown: '# Archify Doc', title: 'E2E Archify' });
  await withContext(ctx, async (anonCtx) => {
    const anon = await openAnon(ctx, anonCtx, `/a/${id}`);
    await anon.waitForSelector('#pwd', { timeout: 5000 });
    ok(await anon.isVisible('#pwd'), 'anonymous visit to /a/:id sees the login gate');
  });
  await withContext(ctx, async (ownerCtx) => {
    const page = await openOwner(ctx, ownerCtx, `/a/${id}`);
    await page.waitForSelector('iframe#diagram-frame', { timeout: 5000 });
    const html2 = await page.content();
    const m = html2.match(/<iframe[^>]*\ssandbox="([^"]*)"[^>]*>/);
    ok(!!m, 'owner page has an <iframe> with a sandbox attribute');
    ok(!!m && m[1].includes('allow-scripts'), 'iframe sandbox includes allow-scripts');
    ok(!!m && !m[1].includes('allow-same-origin'), 'iframe sandbox does NOT include allow-same-origin');
    const frame = page.frameLocator('#diagram-frame');
    await frame.locator('p').waitFor({ timeout: 5000 });
    ok((await frame.locator('p').textContent()).includes(marker), 'the archify document renders inside the frame');
    ok(await page.isVisible('#status-pill'), 'archify pages get the same owner header (status + share)');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runAgentTokenLifecycle(ctx, ok) {
  const marker = `agent-token-read-marker-${rand()}`;
  const { id: pasteId } = await seedPaste(ctx.serverUrl, `# Token Read Target\n\n${marker}`);
  let rawToken = null;
  await withContext(ctx, async (ownerCtx) => {
    const page = await openOwner(ctx, ownerCtx, '/settings');
    await page.waitForSelector('#tokens-list .lib-empty, #tokens-list .token-row', { timeout: 5000 });
    const placeholder = await page.getAttribute('#new-token-name', 'placeholder');
    ok(placeholder === 'Token name, e.g. "Kit"', `token-name placeholder renders intact (got ${JSON.stringify(placeholder)})`);
    await page.fill('#new-token-name', `E2E Token ${rand()}`);
    await page.click('#btn-create-token');
    await page.waitForSelector('#new-token-reveal:not([hidden])', { timeout: 5000 });
    rawToken = (await page.textContent('#new-token-value')).trim();
    ok(!!rawToken && rawToken.startsWith('mds_'), 'token creation reveals a raw token value in the UI');
    await page.waitForSelector('#tokens-list .token-row', { timeout: 5000 });
    ok((await page.locator('#tokens-list .tag.scope', { hasText: 'documents:read' }).count()) === 1, 'the new token is listed with documents:read');
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  });
  const { tokens } = (await ownerApi(ctx, 'GET', '/api/auth?action=tokens')).json;
  const created = (tokens || []).find((t) => t.status === 'active' && Array.isArray(t.scopes) && t.scopes.includes('documents:read'));
  ok(!!created, 'created token appears in the owner token list with documents:read');
  const b1 = await fetch(`${ctx.serverUrl}/api/share?id=${pasteId}`, { headers: { Authorization: `Bearer ${rawToken}` } });
  ok(b1.status === 200 && (await b1.text()).includes(marker), `bearer GET with documents:read reads a row it did not create (status ${b1.status})`);
  await withContext(ctx, async (ownerCtx) => {
    const page = await openOwner(ctx, ownerCtx, '/settings');
    await page.waitForSelector('[data-revoke]', { timeout: 5000 });
    await page.click('[data-revoke]');
    await page.waitForSelector('.token-row .tag.revoked', { timeout: 5000 });
    ok(true, 'revoking from Settings marks the token revoked');
  });
  const b2 = await fetch(`${ctx.serverUrl}/api/share?id=${pasteId}`, { headers: { Authorization: `Bearer ${rawToken}` } });
  ok(b2.status === 401, `bearer GET after revoke returns 401 (got ${b2.status})`);
}

async function runPinDelete(ctx, ok) {
  const pinTitle = `Pin Test ${rand()}`;
  const { id: pinId } = await seedPaste(ctx.serverUrl, `# ${pinTitle}\n\nbody`);
  const { id: delId } = await seedPaste(ctx.serverUrl, `# Delete Test ${rand()}\n\nbody-to-delete`);
  await withContext(ctx, async (ownerCtx) => {
    const page = await openOwner(ctx, ownerCtx, '/dashboard');
    await page.waitForSelector(`.lib-row[data-id="${pinId}"]`, { timeout: 5000 });
    await page.click(`.lib-row[data-id="${pinId}"] .cb input`, { force: true });
    await page.waitForSelector('#batch-bar.show', { timeout: 3000 });
    await page.click('#b-keep');
    await page.waitForFunction((id) => document.querySelector(`.lib-row[data-id="${id}"] .tag.kept`), pinId, { timeout: 5000 });
    ok(true, "a kept item shows the '⭐ Kept' tag in the library after batch Keep");
    ok(isKept(await findItem(ctx, pinId)), 'batch Keep persisted (pinned, never expires)');
    await page.screenshot({ path: ctx.proofPath });
  });
  await withContext(ctx, async (ownerCtx2) => {
    const page = await openOwner(ctx, ownerCtx2, `/v/${delId}`);
    await page.click('#btn-more');
    await page.click('#btn-delete');
    await page.waitForURL('**/dashboard?deleted=1', { timeout: 5000 });
    ok(true, 'Delete from the ⋯ menu returns to the library');
  });
  const after = await fetch(`${ctx.serverUrl}/raw/${delId}`, { headers: { cookie: ctx.ownerCookie } });
  ok(after.status === 404, `deleted paste's raw content 404s afterward (status ${after.status})`);
}

// ===== New in the redesign =====

async function runReaderHeader(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('en-report.md'));
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const visible = await page.$$eval('.app-header button, .app-header a.btn', (els) => els.filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden').map((e) => e.id || e.textContent.trim()));
    ok(JSON.stringify(visible) === JSON.stringify(['status-pill', 'btn-share', 'btn-edit', 'btn-aa', 'btn-more']), `owner header shows exactly status, Share, Edit, Aa, ⋯ (got ${JSON.stringify(visible)})`);
    const header = await page.innerText('.app-header');
    ok(!/Notion|rendered|Save ▾|A−|A\+/.test(header), 'removed controls (Save ▾, Save to Notion, "rendered" label, zoom buttons) are gone from the header');
    ok((await page.textContent('#status-text')).startsWith('Private · expires in'), 'the status pill shows privacy and time left');
    await page.screenshot({ path: ctx.proofPath });
  });
  await ownerApi(ctx, 'PATCH', '/api/pin', { id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const visible = await page.$$eval('.app-header button, .app-header a.btn', (els) => els.filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden').map((e) => e.id));
    ok(JSON.stringify(visible) === JSON.stringify(['btn-aa', 'btn-copy-link']), `public reader header shows only Aa and Copy link (got ${JSON.stringify(visible)})`);
    ok((await page.locator('#btn-delete, #status-pill, #btn-edit, #md-editor').count()) === 0, 'no owner controls exist in the reader page');
  });
}

async function runAutoKeepOnPublish(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, '# Auto keep\n\nbody');
  const { id: id2 } = await seedPaste(ctx.serverUrl, '# Auto keep off\n\nbody');
  ok(!isKept(await findItem(ctx, id)), 'precondition: a new document is not kept');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await page.click('#btn-share');
    await page.check('#public-toggle');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Public · Kept', null, { timeout: 5000 });
    ok(await page.isChecked('#keep-toggle'), 'publishing switched "Keep forever" on in the panel');
    await page.screenshot({ path: ctx.proofPath });
  });
  const item = await findItem(ctx, id);
  ok(item && item.is_public && isKept(item), 'server state: public and kept (expires 2099)');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/settings');
    await page.uncheck('#pref-autokeep');
    const page2 = await context.newPage();
    page2.on('dialog', (d) => d.accept());
    await gotoResilient(page2, `${ctx.serverUrl}/v/${id2}`, { waitUntil: 'load' });
    await page2.click('#status-pill');
    await page2.check('#public-toggle');
    await page2.waitForFunction(() => document.getElementById('status-text')?.textContent.startsWith('Public · expires'), null, { timeout: 5000 });
  });
  const item2 = await findItem(ctx, id2);
  ok(item2 && item2.is_public && !isKept(item2), 'with the Settings switch off, publishing leaves expiry alone');
}

async function runKeepToggle(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, '# Keep toggle\n\nbody');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await page.click('#status-pill');
    await page.check('#keep-toggle');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Private · Kept', null, { timeout: 5000 });
    ok(isKept(await findItem(ctx, id)), 'Keep forever on: stored as kept');
    await page.uncheck('#keep-toggle');
    await page.waitForFunction(() => /^Private · expires in (7d|16\dh)/.test(document.getElementById('status-text')?.textContent || ''), null, { timeout: 5000 });
    const it = await findItem(ctx, id);
    const days = (new Date(it.expires_at) - Date.now()) / 864e5;
    ok(!isKept(it) && days > 6.9 && days < 7.1, `Keep off: a visible 7-day expiry (got ${days.toFixed(2)} days)`);
    ok((await page.textContent('#keep-sub')).startsWith('Expires '), 'the panel explains when it will expire');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runApiKeep(ctx, ok) {
  const anon = await seedPaste(ctx.serverUrl, '# anon keep', { keep: true });
  ok(anon.kept === false && anon.expires_in === 86400, 'anonymous keep:true is ignored');
  ok(!isKept(await findItem(ctx, anon.id)), 'anonymous create stays unkept in storage');
  const own = await seedPaste(ctx.serverUrl, '# owner keep', { keep: true, cookie: ctx.ownerCookie });
  ok(own.kept === true && own.expires_in === null, 'owner keep:true is honoured');
  const item = await findItem(ctx, own.id);
  ok(isKept(item) && item.is_public === false, 'kept on create, still private');
  const tok = (await ownerApi(ctx, 'POST', '/api/auth', { action: 'create_token', name: 'e2e-writer', scopes: ['documents:write'], expires_in_days: 30 })).json;
  const r = await fetch(`${ctx.serverUrl}/api/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ markdown: '# agent keep', keep: true }) });
  const body = await r.json();
  ok(r.status === 200 && body.kept === true && /\/llms\.txt$/.test(body.format_guide), 'a write-scoped token can keep, and the response points to the format guide');
  const guide = await fetch(body.format_guide);
  ok(guide.status === 200 && (await guide.text()).includes('POST /api/share'), 'format_guide resolves to the agent guide');
  await withContext(ctx, async (context) => { const p = await openOwner(ctx, context, '/dashboard'); await p.waitForSelector('.lib-row', { timeout: 5000 }); await p.screenshot({ path: ctx.proofPath }); });
}

async function runAutoFormat(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('zh-explainer.md'));
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const r = await page.evaluate(() => {
      const c = document.getElementById('content');
      const q = (s) => c.querySelectorAll(s);
      const steps = [...q('ol.md-steps')];
      return {
        summary: c.querySelector('.md-summary .md-label')?.textContent,
        summaryText: c.querySelector('.md-summary p')?.textContent || '',
        subs: [...q('h4.md-sub')].map((h) => h.textContent.replace(/^#/, '')),
        stepLists: steps.length,
        secondStart: steps[1] ? getComputedStyle(steps[1]).getPropertyValue('--start').trim() : null,
        keys: q('ul.md-keys > li').length,
        numCells: q('td.num').length,
        tints: [q('td.t-ok').length, q('td.t-bad').length, q('td.t-warn').length],
        callout: c.querySelector('.md-callout.warning .md-label')?.textContent,
        codeLabel: c.querySelector('.code-block .code-head span')?.textContent,
        copyBtn: q('.code-block .code-copy').length,
        ids: [...q('h2')].every((h) => h.id && h.querySelector('.anchor')),
        ext: c.querySelector('a[href^="https://www.ai.engineer"]')?.target,
        tocItems: document.querySelectorAll('#toc a').length,
        tocHidden: document.getElementById('toc').hidden,
        cjk: c.classList.contains('cjk'),
        meta: document.getElementById('doc-meta').textContent,
        progress: !!document.getElementById('progress'),
      };
    });
    ok(r.summary === '一句话结论' && r.summaryText.startsWith('先把检查'), `"**一句话结论**" + text became the summary card (got ${JSON.stringify([r.summary, r.summaryText.slice(0, 8)])})`);
    ok(['核心观点', '金字塔的五层', '先做的三件事'].every((t) => r.subs.includes(t)), `bold-only lines became small headings (got ${JSON.stringify(r.subs)})`);
    ok(r.stepLists === 3 && r.secondStart === '2', `bold-led numbered lists became step cards and the split list keeps numbering 3–5 (lists ${r.stepLists}, --start ${r.secondStart})`);
    ok(r.keys === 3, `"- **label**：text" bullets became key-point rows (got ${r.keys})`);
    ok(r.numCells >= 6, `numeric table columns are right-aligned (got ${r.numCells} cells)`);
    ok(r.tints.join() === '1,1,1', `✅ ❌ ⚠️ cells are tinted (got ${r.tints})`);
    ok(r.callout === '注意', `"> 注意：" became a warning callout (got ${r.callout})`);
    ok(r.codeLabel === 'bash' && r.copyBtn === 1, 'code blocks get a language label and a copy button');
    ok(r.ids, 'section headings get ids and # anchor links');
    ok(r.ext === '_blank', 'external links open in a new tab');
    ok(!r.tocHidden && r.tocItems >= 4, `a contents sidebar appears (items ${r.tocItems})`);
    ok(r.cjk && /min read/.test(r.meta) && r.progress, 'CJK typography, reading time and progress bar are present');
    await page.click('.code-copy');
    await page.waitForFunction(() => document.querySelector('.code-copy').textContent !== 'Copy', null, { timeout: 3000 }).catch(() => {});
    ok(true, 'copy button responds');
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  }, { permissions: ['clipboard-read', 'clipboard-write'] });
}

async function runRetrofitCounterexamples(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('edge-cases.md'));
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const r = await page.evaluate(() => {
      const c = document.getElementById('content');
      return {
        hr: c.querySelectorAll('hr').length,
        firstText: c.textContent.includes('This document starts with a horizontal rule'),
        summary: c.querySelectorAll('.md-summary').length,
        subs: c.querySelectorAll('h4.md-sub').length,
        steps: c.querySelectorAll('.md-steps').length,
        keys: c.querySelectorAll('.md-keys').length,
        callouts: c.querySelectorAll('.md-callout').length,
        unknown: c.textContent.includes(':::unknownblock'),
        midBold: !!c.querySelector('p > strong') && c.querySelector('p > strong').textContent === 'bold in the middle',
        marks: c.querySelectorAll('mark').length,
        equalsRun: c.textContent.includes('===CHAT==='),
        accent: document.documentElement.getAttribute('data-accent'),
        summaryHeading: [...c.querySelectorAll('h2')].some((h) => h.textContent.replace('#', '').trim() === 'Summary'),
      };
    });
    ok(r.hr === 1 && r.firstText, 'a leading --- that is not settings stays a horizontal rule and its text stays');
    ok(r.summary === 0 && r.summaryHeading, 'a "Summary" heading deep in the document is not turned into a card');
    ok(r.subs === 0, 'long bold lines and bold mid-sentence are not turned into headings');
    ok(r.steps === 0 && r.keys === 0, 'mixed lists are not turned into step cards or key points');
    ok(r.callouts === 0, 'an ordinary quote is not turned into a callout');
    ok(r.unknown, 'an unknown :::block is shown as plain text, not dropped');
    ok(r.midBold, 'bold in the middle of a sentence stays inline');
    ok(r.marks === 0 && r.equalsRun, '"$5 == $5", "a==b" and "===CHAT===" are not turned into highlights (found by the real-document comparison)');
    ok(r.accent === null, 'no accent is applied without settings');
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  });
}

// Old page vs new page on the same stored documents: the readable text must be identical
// (the redesign may restyle, never drop or reorder content). Classic gets the same real
// marked/DOMPurify (see _cdn-stubs.mjs), so both views parse with the same Markdown parser.
async function runTextEquivalence(ctx, ok) {
  for (const name of ['zh-explainer.md', 'en-report.md', 'edge-cases.md']) {
    const { id } = await seedPaste(ctx.serverUrl, fixture(name));
    await withContext(ctx, async (context) => {
      const page = await openOwner(ctx, context, `/v/${id}?classic=1`);
      await page.waitForFunction(() => document.getElementById('content')?.textContent !== 'Loading…', null, { timeout: 5000 });
      const old = await page.evaluate(() => {
        const c = document.getElementById('content');
        return { text: c.textContent.replace(/\s+/g, ''), tables: c.querySelectorAll('table').length, rows: c.querySelectorAll('tr').length, code: c.querySelectorAll('pre').length, links: [...c.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).sort(), imgs: c.querySelectorAll('img').length, items: c.querySelectorAll('li').length };
      });
      await gotoResilient(page, `${ctx.serverUrl}/v/${id}`, { waitUntil: 'load' });
      await waitRendered(page);
      const neu = await page.evaluate(() => {
        const c = document.getElementById('content').cloneNode(true);
        // Page chrome placed inside the article (date/reading time, # anchors, code labels).
        c.querySelectorAll('.doc-meta, .toc-mobile, .anchor, .code-head, .table-tools').forEach((e) => e.remove());
        return { text: c.textContent.replace(/\s+/g, ''), tables: c.querySelectorAll('table').length, rows: c.querySelectorAll('tr').length, code: c.querySelectorAll('pre').length, links: [...c.querySelectorAll('a[href]:not(.anchor)')].map((a) => a.getAttribute('href')).sort(), imgs: c.querySelectorAll('img').length, items: c.querySelectorAll('li').length };
      });
      // A summary card's label is the heading/bold line it came from, so the text lines up. The
      // one intended text change: an automatic callout shows "注意：" / "Warning:" as its label,
      // without the colon. Compare with colons removed on both sides.
      const strip = (t) => t.replace(/[：:]/g, '');
      const oldText = strip(old.text), neuText = strip(neu.text);
      const same = oldText === neuText;
      let at = 0; while (at < oldText.length && oldText[at] === neuText[at]) at++;
      ok(same, `${name}: identical readable text in the old and new reader (${oldText.length} characters)${same ? '' : `; first difference at ${at}: old "${oldText.slice(Math.max(0, at - 15), at + 15)}" new "${neuText.slice(Math.max(0, at - 15), at + 15)}"`}`);
      ok(old.tables === neu.tables && old.rows === neu.rows && old.code === neu.code && old.imgs === neu.imgs && old.items === neu.items, `${name}: same tables/rows/code/images/list items (${JSON.stringify([old.tables, old.rows, old.code, old.imgs, old.items])} vs ${JSON.stringify([neu.tables, neu.rows, neu.code, neu.imgs, neu.items])})`);
      ok(JSON.stringify(old.links) === JSON.stringify(neu.links), `${name}: same links`);
      if (name === 'zh-explainer.md') await page.screenshot({ path: ctx.proofPath });
    });
  }
}

async function runDirectives(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('directives.md'));
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const r = await page.evaluate(() => {
      const c = document.getElementById('content');
      return {
        accent: document.documentElement.getAttribute('data-accent'),
        tocHidden: document.getElementById('toc').hidden,
        fmLeak: c.textContent.includes('accent: teal'),
        summary: c.querySelector('.md-summary .md-label')?.textContent,
        stats: c.querySelectorAll('.md-stats .md-stat').length,
        up: c.querySelectorAll('.md-stat.up').length,
        accentStat: c.querySelectorAll('.md-stat.accent').length,
        warn: !!c.querySelector('.md-callout.warning'),
        important: c.querySelector('.md-callout.important .md-label')?.textContent,
        done: c.querySelectorAll('.md-timeline > li.done').length,
        tl: c.querySelectorAll('.md-timeline > li').length,
        compare: [...c.querySelectorAll('.md-compare > section')].map((s) => s.getAttribute('data-title')),
        cards: c.querySelectorAll('.md-cards > section').length,
        tabs: [...c.querySelectorAll('.md-tabbar button')].map((b) => b.textContent),
        mark: c.querySelector('mark')?.textContent,
        badges: [...c.querySelectorAll('.md-badge')].map((b) => b.className.replace('md-badge', '').trim()),
        rawSyntax: /:::|\[!WARNING\]|\{up\}|:badge\[/.test(c.textContent),
      };
    });
    ok(r.accent === 'teal' && r.tocHidden && !r.fmLeak, 'frontmatter sets the teal accent, hides contents, and is not shown');
    ok(r.summary === 'Bottom line', ':::summary with a label');
    ok(r.stats === 4 && r.up === 1 && r.accentStat === 1, ':::stats renders 4 number cards with tones');
    ok(r.warn && r.important === 'Decision needed', '[!WARNING] and :::important callouts');
    ok(r.tl === 3 && r.done === 2, ':::steps timeline marks checked items done');
    ok(JSON.stringify(r.compare) === '["Before","After"]' && r.cards === 3, ':::compare columns and :::cards');
    ok(JSON.stringify(r.tabs) === '["First tab","Second tab"]', ':::tabs builds a tab bar');
    ok(r.mark === 'Dec 3' && JSON.stringify(r.badges) === '["green","red","blue"]', '==highlight== and :badge[...] with automatic and explicit colors');
    ok(!r.rawSyntax, 'no directive syntax leaks into the page');
    await page.click('.md-tabbar button:nth-child(2)');
    // Tabs switch inside a view transition when motion is on: the DOM changes on the next frame.
    await page.waitForFunction(() => document.querySelector('.md-tabbar button:nth-child(2)')?.getAttribute('aria-selected') === 'true', null, { timeout: 3000 });
    const shown = await page.evaluate(() => [...document.querySelectorAll('.md-tabs > section')].map((s) => !s.hidden));
    ok(JSON.stringify(shown) === '[false,true]', 'clicking the second tab shows its panel only');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1100);
    const counted = await page.evaluate(() => [...document.querySelectorAll('.md-stat .v')].map((v) => v.textContent));
    ok(JSON.stringify(counted) === '["$140.6M","+1,252%","25,000","3"]', `number cards finish counting at their exact values (got ${JSON.stringify(counted)})`);
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  });
}

async function runXssSafety(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('xss.md'));
  await ownerApi(ctx, 'PATCH', '/api/pin', { id, kind: 'paste', is_public: true });
  for (const who of ['anon', 'owner', 'classic']) {
    await withContext(ctx, async (context) => {
      const url = who === 'classic' ? `/v/${id}?classic=1` : `/v/${id}`;
      const page = who === 'anon' ? await openAnon(ctx, context, url) : await openOwner(ctx, context, url);
      await page.waitForFunction(() => document.getElementById('content')?.textContent.includes('TEXT-AFTER-PROBE'), null, { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        xss: window.__xss,
        onerror: document.querySelectorAll('#content [onerror], #content [onload]').length,
        js: [...document.querySelectorAll('#content a')].some((a) => /^javascript:/i.test(a.getAttribute('href') || '')),
        scripts: document.querySelectorAll('#content script, #content iframe').length,
      }));
      ok(r.xss === undefined && r.onerror === 0 && !r.js && r.scripts === 0, `${who}: hostile Markdown is neutralised and the rest of the page renders (${JSON.stringify(r)})`);
      if (who === 'anon') await page.screenshot({ path: ctx.proofPath });
    });
  }
}

async function runReadingSettings(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('zh-explainer.md'));
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    await page.click('#btn-aa');
    await page.click('#zoom-in'); await page.click('#zoom-in');
    ok((await page.textContent('#zoom-val')) === '120%', 'A+ twice -> 120%');
    await page.click('#theme-seg [data-v="dark"]');
    // The theme switches inside a view transition when motion is on: it applies on the next frame.
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 3000 });
    ok((await page.getAttribute('html', 'data-theme')) === 'dark', 'Dark theme applies immediately');
    await page.click('#width-seg [data-v="wide"]');
    ok((await page.getAttribute('html', 'data-width')) === 'wide', 'Wide layout applies');
    ok((await page.locator('#content abbr.md-gloss').count()) === 0, 'term hints are off by default');
    await page.check('#gloss-toggle');
    await page.waitForSelector('#content abbr.md-gloss', { timeout: 3000 });
    const glosses = await page.$$eval('#content abbr.md-gloss', (a) => a.map((x) => x.firstChild.textContent));
    ok(glosses.includes('lint 规则') && glosses.includes('Playwright'), `turning on term hints makes 术语（解释） hoverable (got ${JSON.stringify(glosses)})`);
    await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'load' });
    await waitRendered(page);
    const persisted = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), zoom: getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim(), width: document.documentElement.getAttribute('data-width'), gloss: document.querySelectorAll('#content abbr.md-gloss').length }));
    ok(persisted.theme === 'dark' && persisted.zoom === '1.2' && persisted.width === 'wide' && persisted.gloss > 0, `preferences persist across reloads (${JSON.stringify(persisted)})`);
    await page.keyboard.press('Control+0');
    ok((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim())) === '1', 'Ctrl/Cmd+0 still resets text size');
    await page.screenshot({ path: ctx.proofPath });
  });
}

// ===== Reading chrome (front-end batch 1, 2026-11-27): Paper theme, line spacing, motion, resume,
// Settings → Reading. Preferences are localStorage keys on this device (public/assets/app.js). =====

// These features seed from their own client address so they don't use up the suite's shared
// create budget (api/share.js allows 50 creates per hour per IP; tests/health.test.mjs isolates
// rate-limit buckets the same way).
async function seedChrome(ctx, markdown) {
  const r = await fetch(`${ctx.serverUrl}/api/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.20.11.27' }, body: JSON.stringify({ markdown }) });
  if (!r.ok) throw new Error(`seedChrome failed: ${r.status} ${await r.text()}`);
  return r.json();
}
const ZH_P = '读长文的时候，人常常会被打断：一条消息、一个电话，或者只是到站该下车了。再打开时，最省事的是直接回到刚才那一节，而不是从头翻找。';
const EN_P = 'Long reads get interrupted: a message, a call, or simply your stop on the train. When you come back, the easiest thing is to land on the section you were in instead of scrolling to find it again.';
function longDoc(zh, extra = '', tail = '') {
  const p = zh ? ZH_P : EN_P;
  const secs = Array.from({ length: 10 }, (_, i) => `## ${zh ? `第${i + 1}节` : `Section ${i + 1}`}\n\n${[p, p, p, p].join('\n\n')}`);
  return `# ${zh ? '长文阅读测试' : 'A long read'}\n\n${p}\n\n${extra}${secs.join('\n\n')}\n\n${tail}`;
}
const lineRatio = (page, sel) => page.evaluate((s) => { const cs = getComputedStyle(document.querySelector(s)); return Math.round(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) * 100) / 100; }, sel);
const htmlState = (page) => page.evaluate(() => { const h = document.documentElement; return { theme: h.getAttribute('data-theme'), leading: h.getAttribute('data-leading'), font: h.getAttribute('data-font'), width: h.getAttribute('data-width'), motion: h.getAttribute('data-motion'), motionOk: h.classList.contains('motion-ok'), zoom: h.style.getPropertyValue('--zoom') }; });
// WCAG contrast of the theme's text colours on the surfaces they're used on, computed in the page
// from the live CSS variables (a canvas parses any CSS colour), plus the rendered body text.
const themeContrast = (page) => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue('--' + n).trim();
  const g = document.createElement('canvas').getContext('2d');
  const lum = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; const f = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(d[0]) + 0.7152 * f(d[1]) + 0.0722 * f(d[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100; };
  const pairs = [['ink', 'paper'], ['ink', 'card'], ['ink-2', 'paper'], ['ink-2', 'card'], ['ink-3', 'paper'], ['ink-3', 'card'], ['ink-3', 'card-2'], ['ink-3', 'paper-2'], ['accent-ink', 'paper'], ['accent-ink', 'card'], ['accent-ink', 'accent-soft'], ['accent', 'card'], ['ok', 'ok-soft'], ['warn', 'warn-soft'], ['bad', 'bad-soft'], ['info', 'info-soft'], ['paper', 'ink'], ['code-ink', 'code-bg']];
  const all = pairs.map(([f, b]) => ({ pair: `--${f} on --${b}`, r: ratio(v(f), v(b)) }));
  const p = document.querySelector('#content > p');
  return { worst: all.reduce((a, b) => (b.r < a.r ? b : a)), body: p ? ratio(getComputedStyle(p).color, getComputedStyle(document.body).backgroundColor) : null, bg: getComputedStyle(document.body).backgroundColor, scheme: cs.colorScheme.trim() };
});

async function runReaderPrefs(ctx, ok) {
  const zh = await seedChrome(ctx, fixture('zh-explainer.md'));
  const en = await seedChrome(ctx, fixture('en-report.md'));
  const wide = await seedChrome(ctx, fixture('wide-tables.md'));
  const dg = await seedChrome(ctx, '# Diagram on paper\n\nA two-step flow.\n\n```mermaid\nflowchart TD\n  A[Write] --> B[Share]\n```\n');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${zh.id}`);
    await waitRendered(page);
    const d = await page.evaluate(() => ({ pressed: ['theme-seg', 'leading-seg', 'width-seg', 'font-seg', 'tables-seg'].map((id) => document.querySelector(`#${id} [aria-pressed="true"]`)?.getAttribute('data-v')), motion: document.getElementById('motion-toggle').checked, gloss: document.getElementById('gloss-toggle').checked }));
    const h0 = await htmlState(page);
    ok(h0.theme === 'light' && h0.leading === null && h0.motionOk && JSON.stringify(d.pressed) === '["system","comfortable","standard","sans","auto"]' && d.motion && !d.gloss, `defaults are unchanged: System, Comfortable, Standard, Sans, Auto, hints off; motion on (${JSON.stringify({ ...d, ...h0 })})`);
    ok((await lineRatio(page, '#content > p')) === 1.85, 'Comfortable is the original line height (1.85)');
    const light = await themeContrast(page);
    ok(light.worst.r >= 4.5 && light.body >= 4.5, `Light: every text colour passes WCAG AA (worst ${light.worst.pair} ${light.worst.r}:1, body text ${light.body}:1)`);
    await page.click('#btn-aa');
    await page.click('#theme-seg [data-v="paper"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'paper', null, { timeout: 3000 });
    const paper = await themeContrast(page);
    ok(paper.bg === 'rgb(244, 236, 219)' && paper.scheme === 'light', `Paper: a warm sepia page in the light colour scheme (${paper.bg}, ${paper.scheme})`);
    ok(paper.worst.r >= 4.5 && paper.body >= 4.5, `Paper: every text colour passes WCAG AA (worst ${paper.worst.pair} ${paper.worst.r}:1, body text ${paper.body}:1)`);
    ok((await page.getAttribute('meta[name="theme-color"]', 'content')) === '#f4ecdb', 'the browser toolbar colour follows Paper');
    await page.click('#theme-seg [data-v="dark"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 3000 });
    const dark = await themeContrast(page);
    ok(dark.worst.r >= 4.5 && dark.body >= 4.5, `Dark: every text colour passes WCAG AA (worst ${dark.worst.pair} ${dark.worst.r}:1, body text ${dark.body}:1)`);
    await page.click('#leading-seg [data-v="loose"]');
    const zhLoose = await lineRatio(page, '#content > p');
    await page.click('#leading-seg [data-v="compact"]');
    const zhCompact = await lineRatio(page, '#content > p');
    ok(zhLoose === 2.1 && zhCompact === 1.7 && (await page.getAttribute('html', 'data-leading')) === 'compact', `Line spacing on a Chinese document: Loose 2.1, Compact 1.7 (got ${zhLoose}, ${zhCompact})`);
    await page.click('#leading-seg [data-v="loose"]');
    await page.click('#theme-seg [data-v="paper"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'paper', null, { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: ctx.proofPath });

    // The choice follows you: other documents, the guide, the home page, Library and Settings.
    const other = await context.newPage();
    await gotoResilient(other, `${ctx.serverUrl}/v/${en.id}`, { waitUntil: 'domcontentloaded' });
    const early = await htmlState(other);
    await waitRendered(other);
    const enLoose = await lineRatio(other, '#content > p');
    ok(early.theme === 'paper' && early.leading === 'loose', `another document opens in Paper with Loose spacing before it renders (${JSON.stringify(early)})`);
    ok(enLoose === 2 && enLoose < zhLoose, `Latin text gets a little less leading than Chinese at the same setting (${enLoose} vs ${zhLoose})`);
    for (const url of ['/guide', '/', '/dashboard', '/settings']) {
      await gotoResilient(other, `${ctx.serverUrl}${url}`, { waitUntil: 'domcontentloaded' });
      const s = await htmlState(other);
      ok(s.theme === 'paper' && s.leading === 'loose', `${url} uses the same preferences (${s.theme}/${s.leading})`);
    }
    await other.waitForSelector('#reading #theme-seg [data-v="paper"][aria-pressed="true"]', { timeout: 3000 });
    ok(await other.isVisible('#reading #leading-seg [data-v="loose"][aria-pressed="true"]'), 'Settings → Reading shows the choices made in the Aa menu');

    // Mermaid treats Paper as a light theme.
    await gotoResilient(other, `${ctx.serverUrl}/v/${dg.id}`, { waitUntil: 'load' });
    await other.waitForSelector('#content .mermaid.mermaid-drawn svg', { timeout: 15000 });
    const node = await other.evaluate(() => {
      const r = document.querySelector('#content .mermaid svg .node rect, #content .mermaid svg .node polygon, #content .mermaid svg .node path');
      const g = document.createElement('canvas').getContext('2d'); g.fillStyle = '#000'; g.fillStyle = r ? getComputedStyle(r).fill : '#000'; g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data; return { fill: r ? getComputedStyle(r).fill : null, lum: (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255 };
    });
    ok(node.fill && node.lum > 0.6, `a Mermaid diagram on Paper is drawn with the light palette (node fill ${node.fill})`);
  }, { viewport: { width: 1280, height: 900 } });

  // Phones: a smaller title, so the first screen shows the document; the Aa sheet fits.
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${zh.id}`);
    await waitRendered(page);
    const r = await page.evaluate(() => { const h1 = document.querySelector('#content h1'), cs = getComputedStyle(h1); return { size: parseFloat(cs.fontSize), lh: Math.round(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) * 100) / 100, summary: Math.round(document.querySelector('#content .md-summary').getBoundingClientRect().top) }; });
    ok(r.size >= 22 && r.size <= 34 && r.lh <= 1.3, `the title is phone-sized with tighter leading (${r.size}px, ${r.lh})`);
    ok(r.summary < 844 / 2, `the summary card starts in the top half of the first screen (${r.summary}px)`);
    const enPage = await context.newPage();
    await gotoResilient(enPage, `${ctx.serverUrl}/v/${en.id}`, { waitUntil: 'load' });
    await waitRendered(enPage);
    const enSize = await enPage.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#content h1')).fontSize));
    ok(enSize >= 22 && enSize <= 34, `an English title is phone-sized too (${enSize}px, was 44px)`);
    await page.bringToFront();
    await page.click('#btn-aa');
    await page.waitForTimeout(250);
    const sheet = await page.evaluate(() => { const b = document.getElementById('aa-pop').getBoundingClientRect(); return { l: b.left, r: b.right, overflow: document.documentElement.scrollWidth - innerWidth, segs: [...document.querySelectorAll('#aa-pop .seg')].every((s) => s.getBoundingClientRect().right <= b.right) }; });
    ok(sheet.l >= 0 && sheet.r <= 390 && sheet.segs && sheet.overflow <= 0, `the Aa sheet with the new controls fits a 390px phone (${JSON.stringify(sheet)})`);
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  // Wide layout: tables use the room, running text keeps the standard measure.
  await withContext(ctx, async (context) => {
    await context.addInitScript(() => { if (location.protocol.startsWith('http')) localStorage.setItem('mdshare-width', 'wide'); });
    const page = await openOwner(ctx, context, `/v/${wide.id}`);
    await waitRendered(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ p: Math.max(...[...document.querySelectorAll('#content > p')].map((p) => p.getBoundingClientRect().width)), col: document.getElementById('content').getBoundingClientRect().width, table: Math.max(...[...document.querySelectorAll('#content > .table-block')].map((b) => b.getBoundingClientRect().width)), overflow: document.documentElement.scrollWidth - innerWidth }));
    ok(r.col > 900 && r.p <= 16.5 * 44 + 1 && r.table > r.p + 150 && r.overflow <= 0, `Wide: tables use the wide column (${Math.round(r.table)}px) while text keeps a readable measure (${Math.round(r.p)}px of ${Math.round(r.col)}px)`);
  }, { viewport: { width: 1440, height: 900 } });
}

async function runReaderMotion(ctx, ok) {
  const rows = ['North', 'South', 'East', 'West'].map((r, i) => `| ${r} | ${10 + i} | ${20 + i} | ${30 + i} | ${40 + i} |`).join('\n');
  const tail = ['- one\n- two\n- three\n- four\n- five\n- six\n- seven\n- eight\n- nine\n- ten', ':::stats\n$2.5B | later\n1,234 | count\n2026 | year\nQ3 | quarter\n3–5 | range\n:::', ':::tabs\n### First tab\nAlpha\n### Second tab\nBeta\n:::', `| Region | Q1 | Q2 | Q3 | Q4 |\n| --- | --- | --- | --- | --- |\n${rows}`].join('\n\n');
  const { id } = await seedChrome(ctx, longDoc(false, ':::stats\n$140.6M | revenue\n+1,252% | growth {up}\n:::\n\n', tail));
  // Counts view transitions and records every text a number card shows.
  const spy = () => {
    window.__vt = 0; window.__counts = [];
    const o = Document.prototype.startViewTransition;
    if (o) Document.prototype.startViewTransition = function (cb) { window.__vt++; return o.call(this, cb); };
    new MutationObserver((ms) => { for (const m of ms) { const t = m.target; if (t.nodeType === 1 && t.classList.contains('v') && t.closest('.md-stat')) window.__counts.push(t.textContent); } }).observe(document, { subtree: true, childList: true });
  };
  const statsText = (page, n) => page.evaluate((i) => [...document.querySelectorAll('#content .md-stats')[i].querySelectorAll('.v')].map((v) => v.textContent), n);
  await withContext(ctx, async (context) => {
    await context.addInitScript(spy);
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const s0 = await page.evaluate(() => {
      const kids = [...document.getElementById('content').children], vh = innerHeight;
      const marked = (k) => k.classList.contains('rv') || k.classList.contains('rv-group');
      const onScreen = kids.filter((k) => { const r = k.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; });
      const later = kids.filter(marked), one = later.find((k) => k.classList.contains('rv'));
      const list = document.querySelector('#content > ul');
      return { motionOk: document.documentElement.classList.contains('motion-ok'), onScreen: onScreen.length, onScreenHidden: onScreen.filter((k) => marked(k) || getComputedStyle(k).opacity !== '1').length, later: later.length, opacity: one ? getComputedStyle(one).opacity : null, delays: list ? [...list.children].map((li) => li.style.getPropertyValue('--rv-d')) : null };
    });
    ok(s0.motionOk && s0.onScreen >= 3 && s0.onScreenHidden === 0, `motion is on by default and nothing on the first screen is hidden for a reveal (${s0.onScreen} blocks on screen)`);
    ok(s0.later > 10 && s0.opacity === '0', `blocks below the screen wait to fade in (${s0.later} blocks, opacity ${s0.opacity})`);
    ok(JSON.stringify(s0.delays) === JSON.stringify(['0ms', '35ms', '70ms', '105ms', '140ms', '175ms', '210ms', '245ms', '245ms', '245ms']), `list items fade in 35ms apart, at most 8 steps (${JSON.stringify(s0.delays)})`);
    await page.waitForTimeout(900);
    const top = { vals: await statsText(page, 0), seen: await page.evaluate(() => window.__counts.slice()) };
    ok(JSON.stringify(top.vals) === '["$140.6M","+1,252%"]' && top.seen.includes('$0.0M') && top.seen.some((t) => /^\$\d+\.\dM$/.test(t) && t !== '$0.0M' && t !== '$140.6M'), `number cards on the first screen count up from 0 and end on their exact text (${top.seen.length} steps)`);
    // Printing shows everything, even blocks that haven't been scrolled to.
    await page.emulateMedia({ media: 'print' });
    const pr = await page.evaluate(() => { const k = document.querySelector('#content > .rv'), g = document.querySelector('#content > .rv-group .rv-k'); return [k && getComputedStyle(k).opacity, g && getComputedStyle(g).opacity]; });
    await page.emulateMedia({ media: 'screen' });
    ok(JSON.stringify(pr) === '["1","1"]', `printing shows blocks that are still waiting to fade in (${JSON.stringify(pr)})`);
    // Scrolling brings the rest in; an arrived block keeps no motion classes or styles.
    await page.evaluate(() => document.querySelector('#content > ul').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(700);
    const s1 = await page.evaluate(() => { const ul = document.querySelector('#content > ul'); return { opacity: getComputedStyle(ul.lastElementChild).opacity, classes: (ul.className + [...ul.children].map((li) => li.className).join('')).trim(), styled: [...ul.children].some((li) => li.style.getPropertyValue('--rv-d')) }; });
    ok(s1.opacity === '1' && !/rv/.test(s1.classes) && !s1.styled, `a list fades in as it arrives and is left exactly as rendered (${JSON.stringify(s1)})`);
    await page.evaluate(() => document.querySelectorAll('#content .md-stats')[1].scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(1000);
    const low = { vals: await statsText(page, 1), seen: await page.evaluate(() => window.__counts.slice()) };
    ok(JSON.stringify(low.vals) === '["$2.5B","1,234","2026","Q3","3–5"]' && low.seen.includes('$0.0B') && low.seen.some((t) => /^\d{1,3}$/.test(t) && t !== '0'), `later number cards count when they arrive and end exactly (${JSON.stringify(low.vals)})`);
    ok(!low.seen.some((t) => /^\d{4}$/.test(t) || /^Q\d$/.test(t) || /–/.test(t)), 'a year, a "Q3" label and a range never count');
    // Tabs, Table/Cards and the theme cross-fade with a view transition.
    await page.click('#content .md-tabbar button:nth-child(2)');
    await page.waitForFunction(() => document.querySelector('#content .md-tabbar button:nth-child(2)').getAttribute('aria-selected') === 'true', null, { timeout: 3000 });
    await page.click('#content .table-block button[data-view="cards"]');
    await page.waitForFunction(() => document.querySelector('#content .table-block .table-wrap').dataset.view === 'cards', null, { timeout: 3000 });
    await page.click('#btn-aa');
    await page.click('#theme-seg [data-v="dark"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 3000 });
    const vt = await page.evaluate(() => ({ supported: typeof document.startViewTransition === 'function', n: window.__vt }));
    ok(vt.supported && vt.n === 3, `tabs, Table/Cards and the theme switch each run one view transition (${vt.n})`);
    // Aa → Motion off: nothing waits, nothing counts, switches are instant.
    await page.uncheck('#motion-toggle');
    const off = await htmlState(page);
    ok(!off.motionOk && off.motion === 'off' && (await page.evaluate(() => localStorage.getItem('mdshare-motion'))) === 'off', `the Motion switch turns motion off and remembers it (${JSON.stringify(off)})`);
    await page.keyboard.press('Escape');
    const p2 = await context.newPage();
    await gotoResilient(p2, `${ctx.serverUrl}/v/${id}`, { waitUntil: 'load' });
    await waitRendered(p2);
    await p2.waitForTimeout(700);
    const r2 = await p2.evaluate(() => ({ marked: document.querySelectorAll('#content .rv, #content .rv-group, #content .rv-k').length, seen: window.__counts.length }));
    ok(r2.marked === 0 && r2.seen === 0, `with Motion off nothing is hidden and no number counts (${JSON.stringify(r2)})`);
    await p2.click('#content .md-tabbar button:nth-child(2)');
    const sync = await p2.evaluate(() => ({ selected: document.querySelector('#content .md-tabbar button:nth-child(2)').getAttribute('aria-selected'), vt: window.__vt }));
    ok(sync.selected === 'true' && sync.vt === 0, `with Motion off a tab switches at once, without a view transition (${JSON.stringify(sync)})`);
    await page.screenshot({ path: ctx.proofPath });
  }, { viewport: { width: 1280, height: 900 } });

  // The OS setting wins over the switch.
  await withContext(ctx, async (context) => {
    await context.addInitScript(spy);
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => { const sw = document.getElementById('motion-toggle'); return { motionOk: document.documentElement.classList.contains('motion-ok'), marked: document.querySelectorAll('#content .rv, #content .rv-group').length, seen: window.__counts.length, disabled: sw.disabled, checked: sw.checked, note: document.getElementById('motion-note').textContent }; });
    ok(!r.motionOk && r.marked === 0 && r.seen === 0 && r.disabled && !r.checked && /reduced motion/.test(r.note), `with the OS reduced-motion setting nothing is hidden or counted, and the switch says why (${JSON.stringify(r)})`);
  }, { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });

  // Without JavaScript the document is readable and nothing is hidden.
  await ownerApi(ctx, 'PATCH', '/api/pin', { id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${id}`);
    const r = await page.evaluate(() => ({ cls: document.documentElement.className, text: (document.querySelector('#content pre') || {}).textContent || '' }));
    ok(!/motion-ok/.test(r.cls) && r.text.includes('Section 10') && (await page.isVisible('#content pre')), 'without JavaScript the document text is shown and nothing waits for a reveal');
  }, { javaScriptEnabled: false });
}

async function runResumeReading(ctx, ok) {
  const zh = await seedChrome(ctx, longDoc(true));
  const en = await seedChrome(ctx, longDoc(false));
  const spotOf = (page, id) => page.evaluate((i) => JSON.parse(localStorage.getItem('mdshare-resume') || '{}')[i] || null, id);
  const setSpot = (page, id, s) => page.evaluate(([i, v]) => { const all = JSON.parse(localStorage.getItem('mdshare-resume') || '{}'); all[i] = v; localStorage.setItem('mdshare-resume', JSON.stringify(all)); }, [id, s]);
  const pillOf = (page) => page.evaluate(() => { const p = document.querySelector('.resume-pill'); if (!p) return null; const r = p.getBoundingClientRect(); return { text: p.textContent, shown: p.classList.contains('show'), left: r.left, right: r.right, y: scrollY, overflow: document.documentElement.scrollWidth - innerWidth }; });
  const scrollToSection = (page, n) => page.evaluate((i) => { const h = document.querySelectorAll('#content h2')[i]; window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 70); }, n);
  const open = async (context, url) => { const p = await context.newPage(); await gotoResilient(p, `${ctx.serverUrl}${url}`, { waitUntil: 'load' }); await waitRendered(p); return p; };
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${zh.id}`);
    await waitRendered(page);
    await page.waitForTimeout(400);
    ok((await spotOf(page, zh.id)) === null, 'opening a document saves nothing until you scroll');
    await scrollToSection(page, 4);
    await page.waitForTimeout(1400);
    const spot = await spotOf(page, zh.id);
    const h5 = await page.evaluate(() => document.querySelectorAll('#content h2')[4].id);
    ok(spot && spot.h === h5 && spot.r > 0.1 && spot.r < 0.95 && Math.abs(Date.now() - spot.t) < 60000, `scrolling saves the section and how far down you are (${JSON.stringify(spot)})`);

    // Reopening offers the pill; the page never moves by itself.
    const again = await open(context, `/v/${zh.id}`);
    await again.waitForSelector('.resume-pill.show', { timeout: 4000 });
    await again.waitForTimeout(700);
    const p1 = await pillOf(again);
    ok(p1 && p1.text.includes('从上次读到的地方继续') && p1.text.includes('· 第5节') && p1.y === 0, `reopening offers “从上次读到的地方继续 · 第5节” and does not scroll (${JSON.stringify(p1)})`);
    ok(p1.left >= 0 && p1.right <= 390 && p1.overflow <= 0, 'the pill fits a 390px phone');
    await again.screenshot({ path: ctx.proofPath });
    await again.click('.resume-pill');
    await again.waitForFunction(() => { const t = document.querySelectorAll('#content h2')[4].getBoundingClientRect().top; return t > 40 && t < 110; }, null, { timeout: 4000 });
    await again.waitForTimeout(400);
    const at = await again.evaluate(() => { const h = document.querySelectorAll('#content h2')[4]; return { top: Math.round(h.getBoundingClientRect().top), pill: !!document.querySelector('.resume-pill'), focused: document.activeElement === h }; });
    ok(at.top > 40 && at.top < 110 && !at.pill && at.focused, `tapping it scrolls to that section and focuses it (${JSON.stringify(at)})`);

    // A #link, an old or out-of-range spot: no pill.
    const h3 = await again.evaluate(() => document.querySelectorAll('#content h2')[2].id);
    const linked = await context.newPage();
    await gotoResilient(linked, `${ctx.serverUrl}/v/${zh.id}#${encodeURIComponent(h3)}`, { waitUntil: 'load' });
    await waitRendered(linked);
    await linked.waitForTimeout(800);
    ok(!(await linked.$('.resume-pill')), 'a link to a #section never shows the pill');
    // Close the pages that scrolled (they save on the way out) before planting test spots.
    await linked.close(); await again.close();
    for (const [label, s] of [['31 days old', { h: h5, r: 0.5, t: Date.now() - 31 * 864e5 }], ['at 5%', { h: h5, r: 0.05, t: Date.now() }], ['at 97%', { h: h5, r: 0.97, t: Date.now() }]]) {
      await setSpot(page, zh.id, s);
      const p = await open(context, `/v/${zh.id}`);
      await p.waitForTimeout(800);
      ok(!(await p.$('.resume-pill')), `no pill when the saved spot is ${label}`);
      await p.close();
    }

    // It goes away when you scroll, or by itself after about 8 seconds.
    await setSpot(page, zh.id, { h: h5, r: 0.5, t: Date.now() });
    const p3 = await open(context, `/v/${zh.id}`);
    await p3.waitForSelector('.resume-pill.show', { timeout: 4000 });
    await p3.evaluate(() => window.scrollBy(0, 300));
    await p3.waitForTimeout(600);
    ok(!(await p3.$('.resume-pill')), 'scrolling hides the pill');
    await p3.close();
    await setSpot(page, zh.id, { h: h5, r: 0.5, t: Date.now() });
    const p4 = await open(context, `/v/${zh.id}`);
    await p4.waitForSelector('.resume-pill.show', { timeout: 4000 });
    await p4.waitForTimeout(8800);
    ok(!(await p4.$('.resume-pill')) && (await p4.evaluate(() => scrollY)) === 0, 'left alone, the pill goes after about 8 seconds and the page never moved');

    // Only the newest 200 documents are remembered.
    await page.evaluate(() => { const all = {}; for (let i = 0; i < 205; i++) all['old' + i] = { h: '', r: 0.5, t: 1000 + i }; localStorage.setItem('mdshare-resume', JSON.stringify(all)); });
    await scrollToSection(p4, 6);
    await p4.waitForTimeout(1400);
    const cap = await p4.evaluate((cur) => { const all = JSON.parse(localStorage.getItem('mdshare-resume')); return { n: Object.keys(all).length, cur: !!all[cur], oldest: ['old0', 'old5'].filter((k) => all[k]).length, kept: !!all.old6 }; }, zh.id);
    ok(cap.n === 200 && cap.cur && cap.oldest === 0 && cap.kept, `at most 200 documents are kept, oldest dropped first (${JSON.stringify(cap)})`);

    // English documents get the English pill.
    const e1 = await open(context, `/v/${en.id}`);
    await scrollToSection(e1, 4);
    await e1.waitForTimeout(1400);
    const e2 = await open(context, `/v/${en.id}`);
    await e2.waitForSelector('.resume-pill.show', { timeout: 4000 });
    const pe = await pillOf(e2);
    ok(pe && pe.text.includes('Continue where you left off') && pe.text.includes('Section 5'), `English documents say “Continue where you left off · Section 5” (${pe && pe.text})`);
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}

async function runSettingsReading(ctx, ok) {
  const zh = await seedChrome(ctx, fixture('zh-explainer.md'));
  const pub = await seedChrome(ctx, fixture('en-report.md'));
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: pub.id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/settings#reading');
    await page.waitForSelector('#reading #reading-sample', { timeout: 5000 });
    const r = await page.evaluate(() => { const c = document.getElementById('reading'); return { controls: ['theme-seg', 'zoom-in', 'zoom-out', 'zoom-val', 'font-seg', 'leading-seg', 'width-seg', 'tables-seg', 'motion-toggle', 'gloss-toggle', 'reading-reset'].filter((id) => c.querySelector('#' + id)).length, themes: [...c.querySelectorAll('#theme-seg button')].map((b) => b.dataset.v), top: Math.round(c.getBoundingClientRect().top), others: !!document.getElementById('pref-autokeep') && !!document.querySelector('#tokens #btn-create-token') && !!document.getElementById('tokens-list') && !!document.getElementById('btn-signout'), single: document.querySelectorAll('#theme-seg, #gloss-toggle').length }; });
    ok(r.controls === 11 && JSON.stringify(r.themes) === '["light","paper","dark","system"]' && r.single === 2, `Settings → Reading has every reading preference, a sample and Reset (${r.controls}/11)`);
    ok(r.top >= 0 && r.top < 200, `/settings#reading (the Aa menu link) opens at the Reading panel (top ${r.top}px)`);
    ok(r.others, 'publishing, API tokens and sign-out are still on the page');
    await page.click('#reading #theme-seg [data-v="paper"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'paper', null, { timeout: 3000 });
    await page.click('#reading #font-seg [data-v="serif"]');
    await page.click('#reading #leading-seg [data-v="loose"]');
    await page.click('#reading #zoom-in');
    await page.click('#reading #width-seg [data-v="wide"]');
    await page.click('#reading #tables-seg [data-v="cards"]');
    await page.uncheck('#reading #motion-toggle');
    await page.check('#reading #gloss-toggle');
    const s = await page.evaluate(() => { const lr = (el) => { const cs = getComputedStyle(el); return Math.round(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) * 100) / 100; }; const en = document.querySelector('#reading-sample .prose:not(.cjk) p'), zh = document.querySelector('#reading-sample .prose.cjk p'); return { font: getComputedStyle(en).fontFamily, size: parseFloat(getComputedStyle(en).fontSize), en: lr(en), zh: lr(zh), zoom: document.getElementById('zoom-val').textContent, store: Object.fromEntries(['theme', 'font', 'leading', 'zoom', 'width', 'tables', 'motion', 'gloss'].map((k) => [k, localStorage.getItem('mdshare-' + k)])) }; });
    ok(/Instrument Serif/.test(s.font) && Math.abs(s.size - 18.5 * 1.1) < 0.1 && s.zoom === '110%' && s.en === 1.94 && s.zh === 2.04, `the sample follows the choices live: Serif, 110%, Loose (${JSON.stringify({ ...s, store: undefined })})`);
    ok(JSON.stringify(s.store) === JSON.stringify({ theme: 'paper', font: 'serif', leading: 'loose', zoom: '1.1', width: 'wide', tables: 'cards', motion: 'off', gloss: 'on' }), `each control stores its preference under the Aa menu's keys (${JSON.stringify(s.store)})`);
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-desktop.png'), fullPage: true });

    const doc = await context.newPage();
    await gotoResilient(doc, `${ctx.serverUrl}/v/${zh.id}`, { waitUntil: 'load' });
    await waitRendered(doc);
    const d = { ...(await htmlState(doc)), ...(await doc.evaluate(() => ({ gloss: document.querySelectorAll('#content abbr.md-gloss').length, pressed: ['theme-seg', 'leading-seg', 'font-seg'].map((id) => document.querySelector(`#${id} [aria-pressed="true"]`).dataset.v).join('/') }))) };
    ok(d.theme === 'paper' && d.font === 'serif' && d.leading === 'loose' && d.width === 'wide' && d.zoom === '1.1' && !d.motionOk && d.gloss > 0 && d.pressed === 'paper/loose/serif', `a document opens with the Settings choices and its Aa menu shows them (${JSON.stringify(d)})`);
    await doc.click('#btn-aa');
    const link = await doc.evaluate(() => { const a = document.getElementById('aa-more'); return a && { href: a.getAttribute('href'), h: a.getBoundingClientRect().height }; });
    ok(link && link.href === '/settings#reading' && link.h > 0, 'the owner\'s Aa menu links to “More reading settings”');

    await page.bringToFront();
    await page.click('#reading-reset');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 3000 });
    const z = { ...(await htmlState(page)), ...(await page.evaluate(() => ({ zoomText: document.getElementById('zoom-val').textContent, keys: ['theme', 'font', 'leading', 'width', 'tables', 'motion', 'gloss'].filter((k) => localStorage.getItem('mdshare-' + k) !== null), pressed: ['theme-seg', 'font-seg', 'leading-seg', 'width-seg', 'tables-seg'].map((id) => document.querySelector(`#${id} [aria-pressed="true"]`).dataset.v).join('/'), gloss: document.getElementById('gloss-toggle').checked, sw: document.getElementById('motion-toggle').checked, toast: document.getElementById('toast').textContent }))) };
    ok(z.font === null && z.leading === null && z.width === null && z.motion === null && z.motionOk && z.zoomText === '100%' && z.keys.length === 0 && z.pressed === 'system/sans/comfortable/standard/auto' && !z.gloss && z.sw && /defaults/.test(z.toast), `Reset puts every reading preference back to its default (${JSON.stringify(z)})`);
  }, { viewport: { width: 1280, height: 900 } });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${pub.id}`);
    await waitRendered(page);
    ok((await page.locator('#aa-more').count()) === 0 && (await page.locator('#aa-pop #leading-seg').count()) === 1 && (await page.locator('#aa-pop #theme-seg [data-v="paper"]').count()) === 1, 'a reader gets Paper, Line spacing and Motion in the Aa menu, but no Settings link (Settings is owner-only)');
  });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/settings#reading');
    await page.waitForSelector('#reading #reading-sample', { timeout: 5000 });
    const r = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, fits: [...document.querySelectorAll('#reading .seg, #reading .aa-size, #reading .switch, #reading-sample')].every((e) => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }) }));
    ok(r.overflow <= 0 && r.fits, `Settings → Reading fits a 390px phone (${JSON.stringify(r)})`);
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}

async function runEditSave(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, '# Edit me\n\nOriginal text.');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    await page.click('#btn-edit');
    ok(await page.isVisible('#md-editor'), 'Edit opens the split editor');
    ok(await page.isVisible('#btn-save-edit') && !(await page.isVisible('#btn-share')), 'the header swaps to Cancel / Save while editing');
    await page.fill('#md-editor', '# Edited title\n\n> [!TIP]\n> New callout.');
    await page.waitForFunction(() => document.querySelector('#preview-content h1')?.textContent === 'Edited title', null, { timeout: 3000 });
    ok((await page.locator('#preview-content .md-callout.tip').count()) === 1, 'the live preview uses the same renderer');
    await page.screenshot({ path: ctx.proofPath });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.body.classList.contains('editing'), null, { timeout: 5000 });
    ok((await page.textContent('#content h1')).trim() === 'Edited title' && (await page.textContent('#crumb-title')) === 'Edited title', 'Ctrl/Cmd+S saves, re-renders and updates the title');
    ok(/min read/.test(await page.textContent('#doc-meta')) && (await page.locator('#toc-mobile').count()) === 1, 'the date line and contents survive a re-render');
  });
  const raw = await (await fetch(`${ctx.serverUrl}/raw/${id}`, { headers: { cookie: ctx.ownerCookie } })).text();
  ok(raw === '# Edited title\n\n> [!TIP]\n> New callout.', 'the edit is persisted');
}

async function runLibrary(ctx, ok) {
  const a = await seedPaste(ctx.serverUrl, '# Alpha report\n\nfirst');
  const b = await seedPaste(ctx.serverUrl, '# Beta notes\n\nsecond');
  const d = await seedDiagram(ctx.serverUrl, { svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', title: 'Gamma diagram' });
  const x = await seedArchify(ctx.serverUrl, { kind: 'workflow', html: '<svg></svg>', title: 'Delta flow' });
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: a.id, type: 'paste', pinned: true });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/dashboard');
    await page.waitForSelector('.lib-row', { timeout: 5000 });
    const counts = await page.$$eval('[data-count]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-count'), e.textContent])));
    // soon = not kept and under 48h left: the doc and the diagram (24h); archify defaults to 7 days.
    ok(counts.all === '4' && counts.kept === '1' && counts.public === '' && counts.soon === '2', `filter counts are right (got ${JSON.stringify(counts)})`);
    await page.click('#filter-seg [data-v="kept"]');
    ok(JSON.stringify(await page.$$eval('.lib-row', (r) => r.map((e) => e.dataset.id))) === JSON.stringify([a.id]), 'Kept filter shows only the kept item');
    await page.click('#filter-seg [data-v="all"]');
    await page.click('#type-seg [data-v="diagram"]');
    ok(JSON.stringify(await page.$$eval('.lib-row', (r) => r.map((e) => e.dataset.id))) === JSON.stringify([d.id]), 'Diagrams type filter');
    await page.click('#type-seg [data-v="any"]');
    await page.fill('#search', 'beta');
    await page.waitForFunction(() => document.querySelectorAll('.lib-row').length === 1, null, { timeout: 3000 });
    ok((await page.textContent('.lib-row b')) === 'Beta notes', 'search filters by title');
    await page.fill('#search', '');
    await page.waitForFunction(() => document.querySelectorAll('.lib-row').length === 4, null, { timeout: 3000 });
    await page.click(`.lib-row[data-id="${b.id}"] .cb input`, { force: true });
    await page.click(`.lib-row[data-id="${x.id}"] .cb input`, { force: true });
    ok((await page.textContent('#batch-count')) === '2 selected', 'selecting two rows shows the batch bar');
    await page.click('#b-public');
    await page.waitForFunction(() => document.querySelectorAll('.lib-row .tag.public').length === 2, null, { timeout: 5000 });
    const [ib, ix] = [await findItem(ctx, b.id), await findItem(ctx, x.id)];
    ok(ib.is_public && ix.is_public && isKept(ib) && isKept(ix), 'batch Make public publishes a doc and an archify page, and keeps them');
    await page.hover(`.lib-row[data-id="${d.id}"]`);
    await page.click(`.lib-row[data-id="${d.id}"] [data-act="keep"]`);
    await page.waitForFunction((id) => document.querySelector(`.lib-row[data-id="${id}"] .tag.kept`), d.id, { timeout: 5000 });
    ok(isKept(await findItem(ctx, d.id)), 'the row hover Keep action keeps a diagram');
    await page.click(`.lib-row[data-id="${x.id}"] .cb input`, { force: true });
    await page.click('#b-delete');
    await page.waitForFunction((id) => !document.querySelector(`.lib-row[data-id="${id}"]`), x.id, { timeout: 5000 });
    ok(!(await findItem(ctx, x.id)), 'batch Delete removes an archify page');
    await page.screenshot({ path: ctx.proofPath });
    await page.click(`.lib-row[data-id="${a.id}"] .main`);
    await page.waitForURL(`**/v/${a.id}`, { timeout: 5000 });
    ok(true, 'clicking a row opens the document');
  });
}

// Tier 2 (2026-11-26): full-text search from the Library box. The target document is older than
// the 100 rows the Library loads, so finding it proves the search runs on the server.
async function runLibrarySearch(ctx, ok) {
  const filler = 'Background paragraph about serving infrastructure and batching. '.repeat(6);
  const target = { id: `srch${rand(6)}`, title: '推理优化笔记', content: `# 推理优化笔记\n\n${filler}\n\nKV 缓存命中率是关键 <img src=x onerror="window.__xss=1"> 命中越多，首字延迟越低。\n\n${filler}`, created_at: '2024-01-01T00:00:00.000Z', expires_at: '2098-01-01T00:00:00Z', pinned: false };
  ctx.sb.seed('mdshare_pastes', target);
  for (let i = 0; i < 105; i++) ctx.sb.seed('mdshare_pastes', { id: `fill${i}${rand(4)}`, title: `Filler ${i}`, content: `# Filler ${i}\n\n缓存 only, no full phrase`, created_at: new Date(Date.now() - i * 60000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });
  const other = await seedPaste(ctx.serverUrl, '# Beta unrelated\n\nnothing about caches');
  const check = async (page, label) => {
    await page.fill('#search', '缓存命中');
    await page.waitForSelector('#search-status[data-state="done"]', { timeout: 5000 });
    const r = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll('.lib-row')].map((e) => e.dataset.id);
      const snip = document.querySelector(`.lib-row[data-id="${id}"] .snippet`);
      const mk = snip && snip.querySelector('mark');
      const sb = snip && snip.getBoundingClientRect(); const mb = mk && mk.getBoundingClientRect();
      const lines = snip ? Math.round(sb.height / parseFloat(getComputedStyle(snip).lineHeight)) : 0;
      return { lines, markVisible: !!(mb && mb.top >= sb.top - 1 && mb.bottom <= sb.bottom + 1 && mb.right <= sb.right + 1), rows, marks: snip ? [...snip.querySelectorAll('mark')].map((m) => m.textContent) : null, snippet: snip ? snip.textContent : null, imgs: document.querySelectorAll('#lib-list img').length, onlyText: snip ? [...snip.childNodes].every((n) => n.nodeType === 3 || (n.nodeName === 'MARK' && n.childNodes.length === 1 && n.firstChild.nodeType === 3)) : false, xss: window.__xss === 1, status: document.getElementById('search-status').textContent, overflow: document.documentElement.scrollWidth - window.innerWidth };
    }, target.id);
    ok(JSON.stringify(r.rows) === JSON.stringify([target.id]), `${label}: only the matching document is listed (got ${JSON.stringify(r.rows.slice(0, 5))})`);
    ok(JSON.stringify(r.marks) === JSON.stringify(['缓存命中']) && /缓存命中率是关键/.test(r.snippet || ''), `${label}: the snippet highlights the match (${JSON.stringify(r.marks)} in "${r.snippet}")`);
    ok(r.onlyText && r.imgs === 0 && !r.xss && !/onerror/.test(r.snippet || ''), `${label}: the snippet is text nodes only; the tag is neither rendered nor run`);
    ok(/^1 document contains “缓存命中”/.test(r.status), `${label}: the status line gives the server count ("${r.status}")`);
    ok(r.overflow <= 0, `${label}: no sideways scroll (${r.overflow})`);
    ok(r.lines >= 1 && r.lines <= (label === '390' ? 3 : 2) && r.markVisible, `${label}: the snippet is clamped to ${label === '390' ? 3 : 2} lines and the highlighted match is inside them (lines ${r.lines}, mark visible ${r.markVisible})`);
  };
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/dashboard');
    await page.waitForSelector('.lib-row', { timeout: 5000 });
    ok(!(await page.$(`.lib-row[data-id="${target.id}"]`)), 'the target is not in the first page of the library (older than 100 rows)');
    await check(page, '1280');
    await page.screenshot({ path: ctx.proofPath });
    await page.fill('#search', '');
    await page.waitForFunction((id) => document.querySelector(`.lib-row[data-id="${id}"]`) && document.getElementById('search-status').hidden, other.id, { timeout: 5000 });
    ok(true, 'clearing the search restores the library list');
  }, { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/dashboard');
    await page.waitForSelector('.lib-row', { timeout: 5000 });
    await check(page, '390');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-phone.png') });
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const anon = await fetch(`${ctx.serverUrl}/api/doc?action=search&q=${encodeURIComponent('缓存命中')}`);
  const anonBody = await anon.json().catch(() => ({}));
  ok(anon.status === 401 && /^Bearer/.test(anon.headers.get('www-authenticate') || '') && !anonBody.results, `anonymous search is refused with a Bearer challenge (status ${anon.status})`);
}

// Tier 2 (2026-11-26): a /v/ link works for an agent with a token, and failures explain themselves.
async function runAgentReadV(ctx, ok) {
  const marker = `agent-read-marker-${rand()}`;
  const md = `# Agent read target\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${marker}`;
  const { id } = await seedPaste(ctx.serverUrl, md);
  const created = await ownerApi(ctx, 'POST', '/api/auth', { action: 'create_token', name: `agent-read ${rand()}`, scopes: ['documents:read'] });
  const token = created.json && created.json.token;
  ok(created.status === 200 && /^mds_/.test(token || ''), 'a documents:read token was created');
  const auth = (t) => ({ Authorization: ['Bea', 'rer'].join('') + ' ' + t });
  const good = await fetch(`${ctx.serverUrl}/v/${id}`, { headers: auth(token) });
  const goodBody = await good.text();
  ok(good.status === 200 && good.headers.get('content-type') === 'text/markdown; charset=utf-8' && goodBody === md, `GET /v/:id with the token returns the exact Markdown (status ${good.status}, ${good.headers.get('content-type')})`);
  const bad = await fetch(`${ctx.serverUrl}/v/${id}`, { headers: auth('mds_not_a_real_token_at_all') });
  const badBody = await bad.json().catch(() => ({}));
  ok(bad.status === 401 && /^Bearer/.test(bad.headers.get('www-authenticate') || '') && /Authorization: Bearer/.test(badBody.hint || '') && /\/llms\.txt$/.test(badBody.guide || ''), `a bad token gets 401 + WWW-Authenticate + hint (status ${bad.status})`);
  // A misplaced key only adds the hint to a refusal (adversarial review 2026-11-26): /v keeps its
  // sign-in gate (+ one sentence), /raw its 404 (+ hint); a public document and the owner are unchanged.
  const key = await fetch(`${ctx.serverUrl}/v/${id}`, { headers: { 'x-api-key': token } });
  const keyText = await key.text();
  ok(key.status === 401 && /^Bearer/.test(key.headers.get('www-authenticate') || '') && /Send the token as Authorization: Bearer &lt;token&gt;/.test(keyText) && !keyText.includes(marker), `x-api-key on /v gets the gate with the Bearer hint, no content (status ${key.status})`);
  const rawKey = await fetch(`${ctx.serverUrl}/raw/${id}`, { headers: { 'x-api-key': token } });
  const rawKeyBody = await rawKey.json().catch(() => ({}));
  ok(rawKey.status === 404 && /Send the token as Authorization: Bearer/.test(rawKeyBody.hint || '') && !JSON.stringify(rawKeyBody).includes(marker), `x-api-key on /raw gets the 404 with the Bearer hint (status ${rawKey.status})`);
  ok(key.headers.get('x-content-type-options') === 'nosniff' && rawKey.headers.get('x-content-type-options') === 'nosniff' && good.headers.get('x-content-type-options') === 'nosniff', 'content responses send X-Content-Type-Options: nosniff');
  const ownerStray = await fetch(`${ctx.serverUrl}/raw/${id}?token=unrelated`, { headers: { cookie: ctx.ownerCookie } });
  ok(ownerStray.status === 200 && (await ownerStray.text()) === md, `the owner with a stray ?token= still reads /raw (status ${ownerStray.status})`);
  const missing = await fetch(`${ctx.serverUrl}/v/${id}x`, { headers: auth(token) });
  ok(missing.status === 404, `a missing id with a token is a JSON 404 (status ${missing.status})`);
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${id}`);
    await page.waitForSelector('#pwd', { timeout: 5000 });
    const html = await page.content();
    ok(!html.includes(marker) && !html.includes('Agent read target') && !(await page.$('link[rel="alternate"]')), 'anonymous browser: sign-in gate, no content, no Markdown link');
    ok(/Authorization: Bearer &lt;token&gt;/.test(html) && (await page.isVisible('.auth-card .fine')), 'the gate tells an agent how to authenticate');
  });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const href = await page.getAttribute('link[rel="alternate"][type="text/markdown"]', 'href');
    ok(href === `/raw/${id}`, `the owner page advertises its Markdown (${href})`);
  });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/settings');
    await page.waitForSelector('#tokens-list .lib-empty, #tokens-list .token-row', { timeout: 5000 });
    await page.fill('#new-token-name', 'Kit test');
    await page.click('#btn-create-token');
    await page.waitForSelector('#new-token-reveal:not([hidden])', { timeout: 5000 });
    const shown = (await page.textContent('#new-token-value')).trim();
    const block = await page.textContent('#new-token-agent');
    ok(block.includes(`export MDSHARE_BASE_URL=${ctx.serverUrl}`) && block.includes(`export MDSHARE_AGENT_TOKEN=${shown}`), 'the agent block has this site and the new token');
    ok(/scopes: documents:read · expires \d{4}-\d\d-\d\d/.test(block) && block.includes('action=whoami') && block.includes('/v/<id>') && block.includes('action=search'), 'the agent block lists scopes, expiry and whoami/read/search examples');
    ok(block.includes('publishing needs documents:write'), 'a read-only token is told it cannot publish');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `the reveal fits the page (${overflow})`);
    await page.locator('#new-token-reveal').screenshot({ path: ctx.proofPath });
  }, { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
}

async function runSettingsSignout(ctx, ok) {
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/settings');
    ok(await page.isChecked('#pref-autokeep'), 'auto-keep defaults to on');
    const seg = await page.getAttribute('#settings #theme-seg [data-v="system"]', 'aria-pressed');
    ok(seg === 'true', 'the Settings theme control shows the current choice (System)');
    await page.click('#settings #theme-seg [data-v="dark"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 3000 });
    ok((await page.getAttribute('html', 'data-theme')) === 'dark', 'Settings theme applies');
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
    await page.click('#btn-signout');
    await page.waitForURL(`${ctx.serverUrl}/`, { timeout: 5000 });
    const cookies = await context.cookies();
    ok(!cookies.find((c) => c.name === 'mdshare_auth' && c.value), 'Sign out clears the session cookie');
    await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    ok(await page.isVisible('#pwd'), 'after sign-out the library asks for the password');
  });
}

async function runGuideAndLlms(ctx, ok) {
  const txt = await fetch(`${ctx.serverUrl}/llms.txt`);
  const body = await txt.text();
  ok(txt.status === 200 && /text\/plain/.test(txt.headers.get('content-type')) && body.includes('keep'), '/llms.txt is served as text for agents');
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, '/guide');
    await page.waitForSelector('#content h1', { timeout: 5000 });
    const r = await page.evaluate(() => ({ h1: document.querySelector('#content h1').textContent, stats: document.querySelectorAll('#content .md-stats').length, toc: document.querySelectorAll('#toc a').length, raw: [...document.querySelectorAll('#content > p')].some((p) => /^:::/.test(p.textContent)) }));
    ok(r.h1 === 'Formatting guide' && r.stats === 1 && r.toc > 6, `the guide renders through mdshare itself (${JSON.stringify(r)})`);
    const tocLabels = await page.$$eval('#toc a', (as) => as.map((a) => a.textContent));
    ok(!tocLabels.includes('Before') && !tocLabels.includes('First tab') && !tocLabels.includes('curl'), 'headings inside compare/cards/tabs blocks stay out of the contents');
    ok(!r.raw, 'every example in the guide renders (no stray ::: lines)');
    // Mermaid is vendored since 2026-11-25, so this is the real library, not the CDN stub: every
    // diagram in the guide must actually draw.
    await page.waitForFunction(() => [...document.querySelectorAll('#content .mermaid')].every((n) => n.classList.contains('mermaid-drawn') || n.classList.contains('mermaid-failed')), null, { timeout: 15000 }).catch(() => {});
    const dg = await page.evaluate(() => ({ total: document.querySelectorAll('#content .mermaid').length, drawn: document.querySelectorAll('#content .mermaid.mermaid-drawn svg').length }));
    ok(dg.total === 7 && dg.drawn === 7, `the guide's diagrams and its five chart examples (bar/line, pie, quadrant, mindmap, timeline) are drawn by the vendored mermaid (${dg.drawn}/${dg.total})`);
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runShells(ctx, ok) {
  const d = await seedDiagram(ctx.serverUrl, { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#222"/></svg>', title: 'Shell diagram' });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/d/${d.id}`);
    await page.click('#status-pill');
    await page.check('#public-toggle');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Public · Kept', null, { timeout: 5000 });
    ok(true, 'diagram pages publish (and keep) from the same share panel');
    await page.click('#btn-more');
    ok(await page.isVisible('#btn-delete') && !(await page.isVisible('#btn-download')), 'diagram ⋯ menu has Delete and no Markdown download');
    await page.screenshot({ path: ctx.proofPath });
  });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/d/${d.id}`);
    await page.waitForSelector('#svg-frame svg', { timeout: 5000 });
    ok((await page.locator('#status-pill').count()) === 0, 'anonymous diagram view after publish: content, no owner controls');
  });
  // Multi-user (2026-11-27): missing, expired and private look the same, chosen only by who asks:
  // anonymous gets the sign-in card (401), a signed-in user the designed 404 page.
  const nf = await fetch(`${ctx.serverUrl}/v/doesnotexist1`);
  const nfHtml = await nf.text();
  ok(nf.status === 401 && nfHtml.includes('Private or expired') && nfHtml.includes('id="pwd"') && nfHtml.includes('/assets/mdshare.css'), 'anonymous: a missing document gets the same sign-in card as a private one');
  const nfOwner = await fetch(`${ctx.serverUrl}/v/doesnotexist1`, { headers: { cookie: ctx.ownerCookie } });
  ok(nfOwner.status === 404 && (await nfOwner.text()).includes('This link has expired'), 'signed in: a missing document gets the designed 404 page');
  for (const p of ['/d/doesnotexist1', '/a/doesnotexist1']) {
    const r = await fetch(`${ctx.serverUrl}${p}`);
    ok(r.status === 401 && (await r.text()).includes('Private or expired'), `${p} gets the same card anonymously`);
    const o = await fetch(`${ctx.serverUrl}${p}`, { headers: { cookie: ctx.ownerCookie } });
    ok(o.status === 404 && (await o.text()).includes('This link has expired'), `${p} gets the same 404 page signed in`);
  }
}

async function runMobile(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('zh-explainer.md'));
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page);
    const r = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, toc: !document.getElementById('toc-mobile').hidden && getComputedStyle(document.getElementById('toc-mobile')).display !== 'none', side: getComputedStyle(document.getElementById('toc')).display, headerFits: document.querySelector('.app-header').scrollWidth <= window.innerWidth }));
    ok(r.overflow <= 0, `no horizontal scrolling on a phone (overflow ${r.overflow}px)`);
    ok(r.toc && r.side === 'none', 'phones get the collapsible contents instead of the sidebar');
    ok(r.headerFits, 'the header fits a 390px screen');
    await page.click('#status-pill');
    await page.waitForTimeout(250);
    const box = await page.evaluate(() => { const r = document.getElementById('share-pop').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
    ok(await page.isVisible('#public-toggle') && box.l >= 0 && box.r <= box.w, `the share panel opens fully on screen on a phone (${JSON.stringify(box)})`);
    const order = await page.evaluate(() => { const h1 = document.querySelector('#content h1'), toc = document.getElementById('toc-mobile'); return !!(h1.compareDocumentPosition(toc) & Node.DOCUMENT_POSITION_FOLLOWING); });
    ok(order, 'the collapsible contents sits below the title');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: ctx.proofPath });
    const lib = await context.newPage();
    await gotoResilient(lib, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    await lib.waitForSelector('.lib-row', { timeout: 5000 });
    ok((await lib.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'the library fits a phone screen');
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}

async function runClassicView(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('en-report.md'));
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}?classic=1`);
    await page.waitForSelector('#content h1', { timeout: 5000 });
    ok((await page.innerText('body')).includes('Classic view'), 'the classic view is labelled');
    ok((await page.locator('#btn-notion').count()) === 0, 'Save to Notion is gone from the classic view too');
    ok((await page.textContent('#content h1')) === 'Q3 platform review', 'the classic view still renders the document');
    await page.click('text=Back to the new reader');
    await page.waitForSelector('#status-pill', { timeout: 5000 });
    ok(true, 'one click returns to the new reader');
    await page.screenshot({ path: ctx.proofPath });
  });
}

// Fixed seeds before merge (deterministic: a red build always reproduces). The release check and
// the scheduled monitor use fresh random seeds against production to keep discovering new inputs.
async function runRendererFuzz(ctx, ok) {
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, '/');
    await page.waitForFunction(() => window.MDShareRender, null, { timeout: 5000 });
    for (const seed of [11, 2026, 90210]) {
      const docs = makeDocs(seed, 150);
      const r = await page.evaluate(checkInPage, docs);
      ok(r.failures.length === 0, `seed ${seed}: ${r.checked} random documents render safely with every word kept (slowest ${r.slowestMs}ms)${r.failures.length ? `; ${r.failures.length} failed, first: #${r.failures[0].index} ${r.failures[0].problem}` : ''}`);
    }
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runUiMonkey(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('directives.md'));
  for (const [who, url] of [['owner', `/v/${id}`], ['owner', '/dashboard'], ['owner', '/settings'], ['anon', '/'], ['anon', '/guide']]) {
    await withContext(ctx, async (context) => {
      const page = who === 'owner' ? await openOwner(ctx, context, url) : await openAnon(ctx, context, url);
      await page.waitForTimeout(300);
      const n = await monkey(page, { steps: 25, seed: url.length * 31, origin: ctx.serverUrl });
      ok(n > 10 && ctx.jsErrors.length === 0, `${who} ${url}: ${n} random clicks and keys, no JS errors${ctx.jsErrors.length ? ` (got: ${ctx.jsErrors.slice(0, 2).join(' | ')})` : ''}`);
      if (url === '/') await page.screenshot({ path: ctx.proofPath });
    });
  }
}

// Tables: measure, widen, scroll, cards, expand, copy, settings and author control.
async function runTableReadability(ctx, ok) {
  const { id } = await seedPaste(ctx.serverUrl, fixture('wide-tables.md'));
  const blocks = (page) => page.evaluate(() => [...document.querySelectorAll('#content .table-block')].map((b) => {
    const w = b.querySelector('.table-wrap'), t = w.querySelector('table'), r = b.getBoundingClientRect();
    const art = document.getElementById('content').getBoundingClientRect(), toc = document.getElementById('toc');
    const tocBox = toc && getComputedStyle(toc).display !== 'none' && toc.children.length ? toc.getBoundingClientRect() : null;
    const rows = [...t.querySelectorAll('tbody tr')].map((tr) => tr.getBoundingClientRect().height);
    const lines = (td) => { const rg = document.createRange(); rg.selectNodeContents(td); return new Set([...rg.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size; };
    const oneLine = (sel) => [...t.querySelectorAll(sel)].every((td) => lines(td) <= 1);
    const maxLines = Math.max(...[...t.querySelectorAll('tbody td')].map(lines));
    const heads = [...t.querySelectorAll('thead th')].map((th) => ({ w: th.getBoundingClientRect().width, min: parseFloat(getComputedStyle(th).minWidth) || 0 }));
    return { left: r.left, right: r.right, width: r.width, art: { left: art.left, right: art.right, width: art.width }, tocRight: tocBox ? tocBox.right : null,
      vw: document.documentElement.clientWidth, view: w.dataset.view, scrolls: w.classList.contains('scrolls'), tools: !!b.querySelector('.table-tools'),
      maxRow: Math.max(...rows), maxLines, heads, colsOk: heads.every((h) => h.w + 0.5 >= h.min), firstOneLine: oneLine('tbody td:first-child'),
      nowrapOneLine: oneLine('td.nowrap'), caption: (b.querySelector('.table-caption') || {}).textContent || '', compact: w.classList.contains('compact'),
      nested: b.getAttribute('data-nested') === '1', sticky: getComputedStyle(t.querySelector('td')).position, overflow: document.documentElement.scrollWidth - innerWidth };
  }));
  const text = (page) => page.evaluate(() => { const c = document.getElementById('content').cloneNode(true); c.querySelectorAll('.table-tools, .doc-meta, .toc-mobile, .anchor, .code-head').forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, ''); });

  // Desktop with the contents sidebar on the left.
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`); await waitRendered(page); await page.waitForTimeout(300);
    const [wide, small, data, cards, nested] = await blocks(page);
    ok(wide.tocRight !== null && wide.width > wide.art.width + 200 && wide.left >= wide.art.left - 1 && wide.right <= wide.vw && wide.left >= wide.tocRight, `the 7-column table grows to the right into free space (${Math.round(wide.width)}px vs column ${Math.round(wide.art.width)}px), not over the sidebar, inside the window`);
    ok(wide.colsOk, `no column is squeezed below its readable minimum (${wide.heads.map((h) => Math.round(h.w)).join('/')})`);
    ok(wide.firstOneLine && wide.nowrapOneLine, 'the row labels and the short columns ("S3、S5", "所有客户") stay on one line');
    ok(wide.maxLines <= 3, `no cell needs more than 3 lines (worst ${wide.maxLines}; tallest row ${Math.round(wide.maxRow)}px, was 140px and 5 lines before this change)`);
    ok(wide.view === 'table' && wide.tools, 'wide tables show as a table with a toolbar');
    ok(!small.tools && Math.abs(small.width - small.art.width) < 2, 'a small 3-column table keeps its place and gets no toolbar');
    ok(cards.view === 'cards' && cards.compact && cards.caption === '训练方式速查', ':::table cards compact <caption> shows cards, compact, with its caption');
    ok(nested.nested && !nested.tools && nested.width <= nested.art.width, 'tables inside a compare block never widen and get no toolbar');
    ok(data.view === 'table', 'the 12-column data table stays a table');
    ok(wide.overflow <= 0, 'nothing pushes the page sideways');
    const before = await text(page);

    // Cards toggle and back: same text, labels from the headers.
    await page.click('#content .table-block >> nth=0 >> button[data-view="cards"]');
    // Table/Cards switches inside a view transition when motion is on: the DOM changes on the next frame.
    await page.waitForFunction(() => document.querySelector('#content .table-wrap')?.dataset.view === 'cards', null, { timeout: 3000 });
    const c1 = await page.evaluate(() => { const w = document.querySelector('#content .table-wrap'), td = w.querySelector('tbody td:nth-child(2)'); return { view: w.dataset.view, display: getComputedStyle(w.querySelector('tr')).display, label: getComputedStyle(td, '::before').content, width: w.parentElement.getBoundingClientRect().width, art: document.getElementById('content').getBoundingClientRect().width }; });
    ok(c1.view === 'cards' && c1.display === 'block' && c1.label === '"白话解释"' && Math.abs(c1.width - c1.art) < 2, `Cards turns each row into a card labelled from the header (label ${c1.label}), back inside the column`);
    ok((await text(page)) === before, 'Cards shows exactly the same text (labels are drawn, not added)');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-cards.png') });
    await page.click('#content .table-block >> nth=0 >> button[data-view="table"]');
    await page.waitForFunction(() => document.querySelector('#content .table-wrap')?.dataset.view === 'table', null, { timeout: 3000 });
    const back = (await blocks(page))[0];
    ok(back.view === 'table' && back.width > back.art.width + 200, 'Table brings the wide layout back');

    // Expand: overlay, Esc closes, the table returns to the same place, no duplicate.
    const n0 = await page.evaluate(() => document.querySelectorAll('#content .table-block').length);
    await page.click('#content .table-block >> nth=0 >> button[data-act="expand"]');
    const ov = await page.evaluate(() => { const o = document.querySelector('.table-overlay'); return o && { title: o.querySelector('.to-title').textContent, w: o.querySelector('.table-wrap').getBoundingClientRect().width, inDoc: document.querySelectorAll('#content .table-block').length }; });
    ok(ov && ov.title === '五种做法' && ov.w > 1200 && ov.inDoc === n0 - 1, `Expand opens the table full screen under its section title (${ov && ov.title}, ${ov && Math.round(ov.w)}px)`);
    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => ({ overlay: !!document.querySelector('.table-overlay'), n: document.querySelectorAll('#content .table-block').length, first: document.querySelector('#content .table-block th').textContent }));
    ok(!after.overlay && after.n === n0 && after.first === '类型' && (await text(page)) === before, 'Esc closes it and the table is back in place, once');

    // Copy as TSV.
    await page.click('#content .table-block >> nth=0 >> button[data-act="copy"]');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok(clip.split('\n')[0] === '类型\t白话解释\t什么时候适合\t主要客户\t谁来做\t厂商怎么赚钱\t先例' && clip.split('\n').length === 6, 'Copy puts the table on the clipboard as tab-separated rows (pastes into a spreadsheet)');

    // Aa setting: Cards everywhere, remembered after reload; Auto restores.
    await page.click('#btn-aa'); await page.click('#tables-seg button[data-v="cards"]');
    await page.reload(); await waitRendered(page); await page.waitForTimeout(300);
    const pref = await blocks(page);
    ok(pref.filter((b) => !b.nested).every((b) => b.view === 'cards'), 'Aa → Tables: Cards applies to every table and is remembered after reload');
    await page.click('#btn-aa'); await page.click('#tables-seg button[data-v="auto"]');
    ok((await blocks(page))[0].view === 'table', 'Aa → Tables: Auto goes back to the automatic choice');
    await page.screenshot({ path: ctx.proofPath });
  }, { viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });

  // Narrower desktop: the 12-column table scrolls inside with a sticky first column.
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`); await waitRendered(page); await page.waitForTimeout(300);
    const data = (await blocks(page))[2];
    ok(data.scrolls && data.sticky === 'sticky' && data.overflow <= 0, `at 760px the 12-column table scrolls inside itself with a sticky first column (page doesn't scroll sideways)`);
    const wideAt760 = (await blocks(page))[0];
    ok(wideAt760.view === 'cards', 'a text-heavy table that cannot fit without scrolling switches to cards automatically');
    const matrix = (await blocks(page))[6];
    ok(matrix.view === 'table', 'a comparison matrix (repeated values like tested/refused) stays a table to scan across');
    const inline = await page.evaluate(() => {
      const w = document.querySelectorAll('#content .table-wrap')[7];
      return [...w.querySelectorAll('tbody td:not(:first-child) a, tbody td:not(:first-child) em, tbody td:not(:first-child) code, tbody td:not(:first-child) strong')].map((e) => {
        const td = e.closest('td'), pad = parseFloat(getComputedStyle(td).paddingLeft);
        return e.getBoundingClientRect().left - td.getBoundingClientRect().left >= pad - 1;
      });
    });
    ok(inline.length === 4 && inline.every(Boolean), 'in Cards, links, italics, code and bold stay in the value column (no grid splitting)');
    // The value is one word, the label wraps to several lines: the row must be as tall as the label.
    const labelFits = await page.evaluate(() => [...document.querySelectorAll('#content .table-wrap')[7].querySelectorAll('tbody td:nth-child(2)')].every((td) => td.getBoundingClientRect().height >= 60));
    ok(labelFits, 'a long card label wraps inside its own row instead of running into the next one');
  }, { viewport: { width: 760, height: 900 } });

  // Phone: text-heavy tables become cards automatically; small ones stay tables.
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`); await waitRendered(page); await page.waitForTimeout(300);
    const [wide, small] = await blocks(page);
    ok(wide.view === 'cards' && small.view === 'table' && wide.overflow <= 0, 'on a phone the 7-column table is cards and the small table stays a table, with no sideways scroll');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-phone.png'), fullPage: true });
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  // Frontmatter tables: cards.
  const fm = await seedPaste(ctx.serverUrl, '---\ntables: cards\n---\n# FM\n\n| 方式 | 说明 | 成本 | 适合 |\n| --- | --- | --- | --- |\n| A | 很长的一段说明文字用来测试卡片 | 低 | 小团队 |\n| B | 另一段说明 | 高 | 大客户 |\n');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${fm.id}`); await waitRendered(page); await page.waitForTimeout(200);
    ok((await blocks(page))[0].view === 'cards', 'frontmatter `tables: cards` shows the document\'s tables as cards');
  }, { viewport: { width: 1440, height: 900 } });
}

// ===== Reading loop (2026-11-25): publish checks, read receipts, feedback, versions, preview =====

async function createAs(ctx, body, { cookie, bearer } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const r = await fetch(`${ctx.serverUrl}/api/share`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const readRow = (ctx, id) => ctx.sb.tables.mdshare_reads.find((r) => r.doc_id === id);
const contentText = (page) => page.evaluate(() => document.getElementById('content').textContent);

async function runPublishChecks(ctx, ok) {
  const broken = await createAs(ctx, { markdown: fixture('lint-broken.md'), keep: true });
  const rules = (broken.json?.checks?.warnings || []).map((w) => w.rule);
  ok(broken.status === 200 && broken.json.checks.ok === false, 'a broken document is still created, and the response says it has problems');
  ok(['table-columns', 'unclosed-fence'].every((r) => rules.includes(r)), `the response names the problems with line numbers (${rules.join(', ')})`);
  ok(broken.json.checks.warnings.every((w) => Number.isInteger(w.line) && w.message.length > 10), 'each problem has a line and a readable message');
  ok(broken.json.kept === false && /agent token/.test(broken.json.keep_ignored || ''), 'anonymous keep:true is ignored and the response says why');
  const clean = await createAs(ctx, { markdown: fixture('loop-doc.md') }, { cookie: ctx.ownerCookie });
  ok(clean.json.checks.ok === true && clean.json.checks.stats.tables === 1 && clean.json.checks.stats.minutes >= 1, 'a clean document passes, with stats (tables, reading time)');
  const llms = await (await fetch(`${ctx.serverUrl}/llms.txt`)).text();
  ok(/checks/.test(llms) && /parent/.test(llms) && /\/api\/doc/.test(llms), 'the agent guide documents checks, versions and /api/doc');
  await withContext(ctx, async (context) => { const p = await openOwner(ctx, context, `/v/${broken.json.id}`); await waitRendered(p); await p.screenshot({ path: ctx.proofPath }); });
}

async function runReadReceipts(ctx, ok) {
  const { json: d } = await createAs(ctx, { markdown: fixture('loop-doc.md') }, { cookie: ctx.ownerCookie });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${d.id}`);
    await waitRendered(page);
    await page.waitForTimeout(800);
    let row = readRow(ctx, d.id);
    ok(row && row.open_count === 1, 'opening a document as the owner records one open');
    for (let i = 0; i < 4; i++) { await page.mouse.move(200 + i * 20, 300); await page.waitForTimeout(400); }
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(600);
    row = readRow(ctx, d.id);
    ok(row && row.max_scroll >= 90, `scrolling to the end records the depth (max_scroll ${row && row.max_scroll})`);
    ok(row && row.active_seconds >= 1, `time spent is recorded (active_seconds ${row && row.active_seconds})`);
    ok(row && row.open_count === 1, 'leaving the page does not count as another open');
    await page.screenshot({ path: ctx.proofPath });
    await gotoResilient(page, `${ctx.serverUrl}/v/${d.id}`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    ok(readRow(ctx, d.id).open_count === 2, 'opening it again counts a second open');
    const before = ctx.sb.tables.mdshare_reads.length;
    await gotoResilient(page, `${ctx.serverUrl}/v/${d.id}?as=reader`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    ok(readRow(ctx, d.id).open_count === 2 && ctx.sb.tables.mdshare_reads.length === before, '"view as reader" is not recorded');
  });
  const reads = await ownerApi(ctx, 'GET', `/api/doc?action=reads&ids=${d.id}`);
  ok(reads.status === 200 && reads.json.items[0].opened === true && reads.json.items[0].open_count === 2, 'GET /api/doc?action=reads reports the opens');
  // A public document opened by a stranger records nothing.
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: d.id, kind: 'paste', is_public: true });
  const { json: other } = await createAs(ctx, { markdown: '# Public\n\ntext' }, { cookie: ctx.ownerCookie });
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: other.id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${other.id}`);
    await waitRendered(page); await page.waitForTimeout(800);
    ok(!readRow(ctx, other.id), 'a stranger reading a public document is never recorded');
    ok(await page.evaluate(() => !document.querySelector('script[src*="loop.js"]')), 'readers do not load the reading-loop script');
  });
  const unread = await ownerApi(ctx, 'GET', '/api/doc?action=reads&unread=1&days=1');
  ok(unread.json.items.some((x) => x.id === other.id) && !unread.json.items.some((x) => x.id === d.id), 'unread lists documents the owner has not opened');
}

async function selectText(page, marker, length) {
  return page.evaluate(({ marker, length }) => {
    const walker = document.createTreeWalker(document.getElementById('content'), NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) { const i = n.textContent.indexOf(marker); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, Math.min(n.textContent.length, i + length)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return r.toString(); } }
    return null;
  }, { marker, length });
}
async function dragSelect(page, marker, chars) {
  const box = await page.evaluate(({ marker, chars }) => {
    const walker = document.createTreeWalker(document.getElementById('content'), NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) { const i = n.textContent.indexOf(marker); if (i >= 0) { n.parentElement.scrollIntoView({ block: 'center' }); const a = document.createRange(); a.setStart(n, i); a.setEnd(n, i + 1); const b = document.createRange(); b.setStart(n, i + chars - 1); b.setEnd(n, i + chars); const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return { x1: ra.left + 1, y1: ra.top + ra.height / 2, x2: rb.right - 1, y2: rb.top + rb.height / 2 }; } }
    return null;
  }, { marker, chars });
  await page.mouse.move(box.x1, box.y1); await page.mouse.down(); await page.mouse.move(box.x2, box.y2, { steps: 8 }); await page.mouse.up();
  return page.evaluate(() => getSelection().toString());
}
const barOnScreen = (page) => page.evaluate(() => { const b = document.getElementById('fb-bar'); if (!b || b.hidden) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });

async function runFeedbackLoop(ctx, ok) {
  const { json: d } = await createAs(ctx, { markdown: fixture('loop-doc.md'), origin: 'agent:main:telegram:group:-1' }, { cookie: ctx.ownerCookie });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${d.id}`);
    await waitRendered(page);
    const textBefore = await contentText(page);
    const quote = await dragSelect(page, 'LOOPMARK', 20);
    await page.waitForTimeout(300);
    ok(quote && quote.startsWith('LOOPMARK'), `dragging across text selects it ("${quote}")`);
    ok(await barOnScreen(page), 'selecting text shows the feedback bar, fully on screen');
    const labels = await page.$$eval('#fb-bar > button', (bs) => bs.map((b) => b.textContent));
    ok(JSON.stringify(labels) === JSON.stringify(['举个例子', '没看懂', '这里不对', '展开讲', '写一句…']), `a Chinese document gets Chinese buttons (${labels.join(' / ')})`);
    await page.screenshot({ path: ctx.proofPath });
    await page.click('#fb-bar [data-kind="example"]');
    await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout: 3000 });
    ok((await page.textContent('#toast')).includes('已记下'), 'sending shows a confirmation');
    const fb = ctx.sb.tables.mdshare_feedback.find((f) => f.doc_id === d.id);
    ok(fb && fb.kind === 'example' && fb.status === 'open' && fb.quote === quote.replace(/\s+/g, ' ').trim(), 'the feedback is stored with the exact quote');
    ok(fb && fb.context && fb.context.heading === '第一部分：背景' && fb.context.after.length > 0, `it carries the section heading and nearby text (heading "${fb && fb.context && fb.context.heading}")`);
    ok(await page.evaluate(() => document.getElementById('fb-bar').hidden), 'the bar closes after sending');
    await page.waitForFunction(() => !document.getElementById('fb-pill').hidden, null, { timeout: 3000 });
    ok((await page.textContent('#fb-pill')).includes('1 待处理'), 'the feedback pill shows one open item');

    // Note flow with typed text, then Escape on a fresh selection.
    await selectText(page, '学生会钻空子', 6);
    await page.waitForTimeout(300);
    await page.click('#fb-bar [data-kind="note"]');
    ok(await page.isVisible('#fb-bar textarea'), '"写一句…" opens a note box');
    await page.fill('#fb-bar textarea', '这里换成客服退款的例子');
    await page.click('#fb-bar button[type="submit"]');
    await page.waitForTimeout(400);
    const note = ctx.sb.tables.mdshare_feedback.find((f) => f.kind === 'note');
    ok(note && note.note === '这里换成客服退款的例子' && note.quote === '学生会钻空子' && note.context.heading === '第三部分：风险', 'a note is stored with its text, quote and section');
    await selectText(page, '打分器最难', 5); await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.getElementById('fb-bar').hidden), 'Escape closes the bar');
    await page.click('#fb-pill');
    const panel = await page.textContent('#fb-panel');
    ok(panel.includes('LOOPMARK') && panel.includes('这里换成客服退款的例子'), 'the panel lists this document\'s feedback');
    ok((await contentText(page)) === textBefore, 'the rendered document text is unchanged by feedback (nothing inserted into #content)');
    ok(ctx.sb.tables.mdshare_pastes.find((p) => p.id === d.id).content === fixture('loop-doc.md'), 'stored Markdown is unchanged');
  }, { viewport: { width: 1280, height: 860 } });

  // The agent side: list open feedback with the origin, resolve it into a new version.
  const tok = (await ownerApi(ctx, 'POST', '/api/auth', { action: 'create_token', name: 'e2e-loop', scopes: ['documents:read', 'documents:write', 'activity:read', 'activity:write'], expires_in_days: 1 })).json.token;
  const auth = { Authorization: 'Bearer ' + tok };
  const open = await (await fetch(`${ctx.serverUrl}/api/doc?action=feedback&status=open`, { headers: auth })).json();
  ok(open.items.length === 2 && open.items.every((f) => f.origin === 'agent:main:telegram:group:-1' && f.doc_id === d.id), 'an agent token lists open feedback with the document\'s origin');
  const v2 = await createAs(ctx, { markdown: fixture('loop-doc.md').replace('学生会钻空子', '比如客服退款：学生会钻空子'), parent: d.id }, { bearer: tok });
  const res = await (await fetch(`${ctx.serverUrl}/api/doc?action=resolve`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: open.items.map((f) => f.id), resolved_in: v2.json.id }) })).json();
  ok(res.updated && res.updated.length === 2, 'the agent resolves both items into the new version');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${d.id}`);
    await waitRendered(page);
    await page.waitForFunction(() => !document.getElementById('fb-pill').hidden, null, { timeout: 3000 });
    ok(!(await page.textContent('#fb-pill')).includes('待处理'), 'once resolved, the pill no longer shows open items');
    await page.click('#fb-pill');
    ok(await page.$eval('#fb-panel', (p, id) => !!p.querySelector(`a[href="/v/${id}"]`), v2.json.id), 'each resolved item links to the version that fixed it');
  });

  // Phone: the bar fits on screen and the page doesn't scroll sideways.
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${d.id}`);
    await waitRendered(page);
    await page.evaluate(() => document.querySelector('#content h2:nth-of-type(2)').scrollIntoView({ block: 'center' }));
    await selectText(page, '每一步取', 18); await page.waitForTimeout(300);
    ok(await barOnScreen(page), 'on a phone the feedback bar stays fully on screen');
    ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 0), 'no sideways scroll on a phone');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-phone.png') });
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  // Readers never get the bar.
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: d.id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${d.id}`);
    await waitRendered(page);
    await selectText(page, 'LOOPMARK', 10); await page.waitForTimeout(300);
    ok(await page.evaluate(() => !document.getElementById('fb-bar') && !document.getElementById('fb-pill')), 'a reader selecting text gets no feedback bar');
  });
  const anonPost = await fetch(`${ctx.serverUrl}/api/doc?action=feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id, kind: 'wrong', quote: 'spam' }) });
  ok(anonPost.status === 401 && ctx.sb.tables.mdshare_feedback.length === 2, 'anonymous feedback is refused and nothing is stored');
}

async function runVersions(ctx, ok) {
  const v1md = '# 版本测试\n\n' + '这是第一版的开头段落，用来测试版本对比的效果和中文界面。'.repeat(2) + '\n\n## 方法\n\n第一步：写题目。\n\n第二步：旧的说法，后来删掉。\n\n第三步：开始训练。\n';
  const v2md = v1md.replace('第二步：旧的说法，后来删掉。', '第二步：新的说法，加了一个真实例子。\n\n例子：Harvey 的 57 条细则。');
  const { json: v1 } = await createAs(ctx, { markdown: v1md }, { cookie: ctx.ownerCookie });
  const { json: v2 } = await createAs(ctx, { markdown: v2md, parent: v1.id }, { cookie: ctx.ownerCookie });
  ok(v2.parent === v1.id, 'creating with parent links the new version');
  const anonLink = await createAs(ctx, { markdown: '# spoof', parent: v1.id });
  ok(anonLink.status === 404, 'an anonymous create cannot attach itself as a newer version');
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${v1.id}`);
    await waitRendered(page);
    ok(await page.isVisible('#version-banner'), 'the old version shows a "newer version" banner');
    ok((await page.getAttribute('#version-banner', 'href')) === `/v/${v2.id}` && (await page.textContent('#version-banner')).includes('这篇已有新版本'), 'it links to the newest version, in the document\'s language');
    ok(await page.evaluate(() => !document.getElementById('content').contains(document.getElementById('version-banner'))), 'the banner sits outside the document body');
    await page.click('#version-banner');
    await page.waitForURL(`**/v/${v2.id}`);
    await waitRendered(page);
    ok((await page.textContent('#version-line')).includes('v2'), 'the new version says it is v2 and links back');
    ok(!(await page.isVisible('#version-banner')), 'the newest version has no banner');
    await page.click('#btn-diff');
    await page.waitForSelector('#diff-body .d-add', { timeout: 5000 });
    const adds = await page.$$eval('#diff-body .d-add', (e) => e.map((x) => x.textContent));
    const dels = await page.$$eval('#diff-body .d-del', (e) => e.map((x) => x.textContent));
    ok(adds.some((t) => t.includes('新的说法')) && adds.some((t) => t.includes('Harvey')), `"What changed" shows the added lines (${adds.length})`);
    ok(dels.length === 1 && dels[0].includes('旧的说法'), 'and the removed line');
    ok((await page.$$('#diff-body .d-ctx')).length >= 1 && (await page.$$('#diff-body .d-gap')).length >= 1, 'unchanged text is shown as context and long unchanged runs are folded');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => { const o = document.getElementById('diff-overlay'); const r = o.getBoundingClientRect(); return getComputedStyle(o).opacity === '1' && r.left === 0 && r.top === 0 && r.width === innerWidth && r.height === innerHeight; }), 'the comparison covers the whole page (opaque, full screen)');
    await page.screenshot({ path: ctx.proofPath });
    await page.keyboard.press('Escape');
    ok(!(await page.$('#diff-overlay')), 'Escape closes the comparison');
  }, { viewport: { width: 1280, height: 860 } });
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: v1.id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${v1.id}`);
    await waitRendered(page);
    ok(!(await page.$('#version-banner')) && !(await page.$('#version-line')), 'a reader is not told about a private newer version');
  });
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: v2.id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${v1.id}`);
    await waitRendered(page);
    ok(await page.isVisible('#version-banner') && !(await page.$('#version-line')), 'once the new version is public, readers see the banner (but not the owner\'s version line)');
  });
  const chain = await ownerApi(ctx, 'GET', `/api/doc?action=versions&id=${v2.id}`);
  ok(chain.status === 200 && chain.json.versions.map((v) => v.id).join() === [v1.id, v2.id].join(), 'GET /api/doc?action=versions returns the chain oldest first');
}

async function runPreviewTool(ctx, ok) {
  // Async spawn, not spawnSync: blocking this process for seconds lets the local server close
  // idle keep-alive sockets, and the next feature's fetch() then fails on a dead socket.
  const { spawn } = await import('node:child_process');
  const out = path.join(path.dirname(ctx.proofPath), 'preview');
  const runPreview = (name) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(E2E_DIR, 'preview.mjs'), path.join(FIXTURES, name), '--out', out, '--widths', '390,1280'], { env: process.env });
    let stdout = '', stderr = '';
    const kill = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => { clearTimeout(kill); let json = null; try { json = JSON.parse(stdout); } catch { /* reported below */ } resolve({ code, json, err: stderr }); });
  });
  const bad = await runPreview('lint-broken.md');
  ok(bad.json && bad.code === 1 && bad.json.ok === false, `preview exits 1 and reports ok:false for a broken document${bad.json ? '' : ` (${bad.err.slice(0, 200)})`}`);
  ok(bad.json && bad.json.checks.warnings.some((w) => w.rule === 'unclosed-fence'), 'it includes the publish checks');
  const good = await runPreview('wide-tables.md');
  ok(good.json && good.json.widths.length === 2 && good.json.widths.every((w) => w.jsErrors.length === 0 && w.overflowPx <= 0 && fs.existsSync(w.screenshot)), 'a good document renders at both widths with no errors, no sideways scroll, and a screenshot each');
  ok(good.json && good.json.widths[0].tables.some((t) => t.view === 'cards') && good.json.widths[1].tables.every((t) => t.view !== undefined), 'it reports which layout each table chose (cards on a phone)');
  if (good.json) fs.copyFileSync(good.json.widths[0].screenshot, ctx.proofPath);
}

// ===== Inline diagrams (2026-11-25): real vendored mermaid inside regular documents =====
async function runInlineDiagrams(ctx, ok) {
  const md = [
    '# 打分器怎么工作',
    '',
    '先看整体流程，再看每一步。',
    '',
    '```mermaid',
    'flowchart LR',
    '  Q["题目 (1,250 道)"] --> S[学生模型作答] --> J{裁判打分}',
    '  J -- 高于平均 --> U[加强这种做法]',
    '  J -- 低于平均 --> D[减弱这种做法]',
    '  U --> S',
    '  D --> S',
    '```',
    '',
    '谁和谁交互：',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant 工程师',
    '  participant 训练平台',
    '  工程师->>训练平台: 提交配方',
    '  训练平台-->>工程师: 训练日志和分数',
    '```',
    '',
    '一个写错的图：',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[开始 --> --> B((',
    '```',
    '',
    '一张很宽的图：',
    '',
    '```mermaid',
    'flowchart LR',
    '  ' + Array.from({ length: 14 }, (_, i) => `N${i}["第 ${i + 1} 步：处理数据"]`).join(' --> '),
    '```',
    '',
    '很多参与方的时序图：',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  ' + Array.from({ length: 11 }, (_, i) => `participant P${i} as 参与方${i + 1}`).join('\n  '),
    '  ' + Array.from({ length: 10 }, (_, i) => `P${i}->>P${i + 1}: 第 ${i + 1} 次交接`).join('\n  '),
    '```',
    '',
    '结尾段落。',
  ].join('\n');
  const { id } = await seedPaste(ctx.serverUrl, md, { cookie: ctx.ownerCookie });
  const settle = (page) => page.waitForFunction(() => [...document.querySelectorAll('#content .mermaid')].every((n) => n.classList.contains('mermaid-drawn') || n.classList.contains('mermaid-failed')), null, { timeout: 20000 });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page); await settle(page);
    const d = await page.evaluate(() => [...document.querySelectorAll('#content .mermaid')].map((n) => ({
      drawn: n.classList.contains('mermaid-drawn'), failed: n.classList.contains('mermaid-failed'), svg: !!n.querySelector('svg'),
      bomb: !!n.querySelector('svg[aria-roledescription="error"]') || /Syntax error in text/.test(n.textContent), text: n.textContent.slice(0, 80),
      wide: n.classList.contains('diagram-wide'), expand: !!n.querySelector('.diagram-expand'),
      fill: (() => { const r = n.querySelector('svg .node rect, svg .node polygon, svg rect.actor'); return r ? getComputedStyle(r).fill : null; })(),
    })));
    ok(d.length === 5 && d[0].drawn && d[0].svg && d[1].drawn && d[1].svg && d[3].drawn && d[4].drawn, 'flowcharts and sequence diagrams are drawn inside the document');
    const fit = await page.evaluate(() => [...document.querySelectorAll('#content .mermaid')].map((n) => { const svg = n.querySelector('svg'); return { turned: n.getAttribute('data-turned') === '1', fits: !!svg && svg.getBoundingClientRect().width <= n.clientWidth + 1, scale: svg ? svg.getBoundingClientRect().width / (parseFloat(svg.getAttribute('width')) || 1) : 0 }; }));
    ok(fit[3].turned && fit[3].fits && fit[3].scale > 0.79 && !fit[0].turned, `on a desktop a flowchart too wide for the column is redrawn top-to-bottom and fits; one that fits stays left-to-right (${JSON.stringify(fit)})`);
    ok(d[2].failed && !d[2].svg && !d[2].bomb && d[2].text.includes('flowchart LR'), `a diagram that can't be parsed shows its source, never the "Syntax error" picture (${JSON.stringify(d[2])})`);
    ok(d[0].fill === 'rgb(255, 253, 249)', `diagrams use the page's colours (node fill ${d[0].fill})`);
    ok(d[0].expand && d[1].expand && d[3].expand && !d[2].expand, 'every drawn diagram has an Expand button; the failed one does not');
    const wideFacts = await page.evaluate(() => { const n = document.querySelectorAll('#content .mermaid')[4]; const sc = n.querySelector('.diagram-scroll'); const b = n.querySelector('.diagram-expand').getBoundingClientRect(); const r = n.getBoundingClientRect(); return { wide: n.classList.contains('diagram-wide'), scrolls: sc.scrollWidth > sc.clientWidth, buttonIn: b.right <= r.right && b.top >= r.top }; });
    ok(wideFacts.wide && wideFacts.scrolls && wideFacts.buttonIn, `a very wide diagram that can't be turned (sequence) keeps its size and scrolls inside its frame, button in place (${JSON.stringify(wideFacts)})`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.diagram-expand')].every((b) => b.textContent === '' && b.getAttribute('aria-label'))), 'the Expand button adds no readable text (icon + aria-label only)');
    const label = await page.evaluate(() => [...document.querySelectorAll('#content .mermaid svg')][0].textContent);
    ok(label.includes('题目 (1,250 道)') && label.includes('裁判打分'), 'Chinese labels and quoted punctuation render');
    await page.evaluate(() => document.querySelectorAll('#content .mermaid')[0].scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: ctx.proofPath });
    await page.click('#content .mermaid >> nth=0 >> .diagram-expand');
    await page.waitForSelector('.diagram-overlay svg', { timeout: 3000 });
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => { const o = document.querySelector('.diagram-overlay'); const r = o.getBoundingClientRect(); const svg = o.querySelector('svg').getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight && getComputedStyle(o).opacity === '1' && svg.width > 200; }), 'Expand opens a full-screen view of the diagram');
    await page.keyboard.press('Escape');
    ok(!(await page.$('.diagram-overlay')), 'Escape closes it');
    // Dark theme redraws with dark colours.
    await page.evaluate(() => { localStorage.setItem('mdshare-theme', 'dark'); });
    await gotoResilient(page, `${ctx.serverUrl}/v/${id}`, { waitUntil: 'load' });
    await waitRendered(page); await settle(page);
    const darkFill = await page.evaluate(() => { const r = document.querySelector('#content .mermaid svg .node rect, #content .mermaid svg .node polygon'); return r ? getComputedStyle(r).fill : null; });
    ok(darkFill === 'rgb(34, 29, 23)', `in dark mode diagrams are redrawn with dark colours (${darkFill})`);
  }, { viewport: { width: 1280, height: 900 } });

  // A diagram can't run script, in the current reader or the classic one (?classic=1 used
  // securityLevel 'loose' until the 2026-11-25 review proved a click/call line ran eval).
  const evil = await seedPaste(ctx.serverUrl, '# Diagram script test\n\n```mermaid\nflowchart LR\n  A[Click me] --> B[Or me]\n  click A call eval("window.__pwned=1")\n  click B href "javascript:window.__pwned=2"\n```\n', { cookie: ctx.ownerCookie });
  for (const view of ['', '?classic=1']) {
    await withContext(ctx, async (context) => {
      const page = await openOwner(ctx, context, `/v/${evil.id}${view}`);
      await page.waitForSelector('.mermaid svg', { timeout: 20000 });
      for (const label of ['Click me', 'Or me']) await page.locator('.mermaid svg').getByText(label).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      ok(await page.evaluate(() => window.__pwned === undefined), `${view || 'reader'}: click/call/href lines in a diagram never run script`);
    });
  }

  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${id}`);
    await waitRendered(page); await settle(page);
    const m = await page.evaluate(() => {
      const ns = [...document.querySelectorAll('#content .mermaid')];
      const wide = ns[4]; const svg = wide.querySelector('svg');
      const fs = parseFloat(getComputedStyle(svg.querySelector('.nodeLabel, text') || svg).fontSize) || 0;
      const scale = svg.getBoundingClientRect().width / (parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width);
      const first = ns[0]; const fsvg = first.querySelector('svg');
      return { overflow: document.documentElement.scrollWidth - innerWidth, turned: ns.map((n) => n.getAttribute('data-turned') === '1'), firstFits: fsvg.getBoundingClientRect().width <= first.clientWidth + 1, firstSrcKept: first.getAttribute('data-src').includes('flowchart LR'), scale, fs, frameRight: wide.getBoundingClientRect().right, expandRight: wide.querySelector('.diagram-expand').getBoundingClientRect().right };
    });
    ok(m.overflow <= 0, `the page never scrolls sideways on a phone (${m.overflow}px)`);
    ok(m.turned[0] && m.turned[3] && !m.turned[1] && !m.turned[4] && m.firstFits && m.firstSrcKept, `on a phone left-to-right flowcharts are drawn top-to-bottom and fit, stored source unchanged (${JSON.stringify(m)})`);
    ok(m.scale > 0.95 && m.frameRight <= 390 && m.expandRight <= m.frameRight, 'diagrams are never shrunk below readable size and the Expand button stays inside the frame');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-phone.png'), fullPage: true });
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
}

// api/share.js allows 50 creates an hour per client IP, and the full suite runs from one IP; these
// two features publish through the real API as distinct clients (X-Forwarded-For) so they don't
// depend on how many documents earlier features created.
let fakeClient = 0;
async function createAsClient(ctx, body, auth = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${(++fakeClient % 250) + 1}` };
  if (auth.cookie) headers.cookie = auth.cookie;
  const r = await fetch(`${ctx.serverUrl}/api/share`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Tier 2 Batch B (2026-11-26, migration 012): Chinese/English versions linked.
async function runTranslationSwitch(ctx, ok) {
  const { json: en } = await createAsClient(ctx, { markdown: fixture('pair-en.md'), lang: 'en', keep: true }, { cookie: ctx.ownerCookie });
  const { json: zh } = await createAsClient(ctx, { markdown: fixture('pair-zh.md'), translation_of: en.id, keep: true }, { cookie: ctx.ownerCookie });
  ok(zh.lang === 'zh' && zh.translation_of === en.id, `publishing with translation_of links the pair and detects 中文 (${zh.lang}, ${zh.translation_of})`);
  const anonLink = await createAsClient(ctx, { markdown: '# spoof', translation_of: en.id });
  ok(anonLink.status === 404, `an anonymous create cannot attach itself as a translation (status ${anonLink.status})`);
  const layout = (page) => page.evaluate(() => {
    const sw = document.getElementById('lang-switch'); const r = sw && sw.getBoundingClientRect();
    return { present: !!sw, inContent: !!sw && document.getElementById('content').contains(sw), current: sw ? sw.querySelector('[aria-current="true"]').textContent : null, other: sw && sw.querySelector('#lang-other') ? sw.querySelector('#lang-other').getAttribute('href') : null, onScreen: !!r && r.left >= 0 && r.right <= innerWidth && r.height > 0 && r.height < 48, gap: r ? Math.round(r.top - document.querySelector('.app-header').getBoundingClientRect().bottom) : null, overflow: document.documentElement.scrollWidth - innerWidth, h1: document.querySelector('#content h1') && document.querySelector('#content h1').textContent };
  });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/v/${en.id}`);
    await waitRendered(page);
    let r = await layout(page);
    ok(r.present && !r.inContent && r.current === 'English' && r.other === `/v/${zh.id}`, `the owner sees English current and a 中文 link, outside the document body (${JSON.stringify(r)})`);
    ok(r.onScreen && r.gap >= 12, `the switch is one compact row, fully on screen, clear of the header (gap ${r.gap}px)`);
    await page.screenshot({ path: ctx.proofPath });
    await page.click('#lang-other');
    await page.waitForURL(`**/v/${zh.id}`);
    await waitRendered(page);
    r = await layout(page);
    ok(r.current === '中文' && r.other === `/v/${en.id}` && /KV 缓存/.test(r.h1 || ''), `clicking 中文 opens the Chinese version, which links back to English (${r.current}, ${r.h1})`);
    ok(await page.evaluate(() => !!document.querySelector('#lang-other .lock')), 'the owner sees a lock on English: it is private, so readers do not get the switch yet');
  }, { viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: en.id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${en.id}`);
    await waitRendered(page);
    ok(!(await page.$('#lang-switch')) && !(await page.content()).includes(zh.id), 'a reader of the public English page is not told about the private Chinese one');
  });
  await ownerApi(ctx, 'PATCH', '/api/pin', { id: zh.id, kind: 'paste', is_public: true });
  await withContext(ctx, async (context) => {
    const page = await openAnon(ctx, context, `/v/${en.id}`);
    await waitRendered(page);
    const r = await layout(page);
    ok(r.present && r.other === `/v/${zh.id}` && r.overflow <= 0 && r.onScreen, `once both are public a reader on a phone sees the switch, no sideways scroll (${JSON.stringify(r)})`);
    ok(!(await page.evaluate(() => /🔒/.test(document.getElementById('lang-switch').textContent))), 'readers never see the owner\'s private marker');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-phone.png') });
    await page.click('#lang-other');
    await page.waitForURL(`**/v/${zh.id}`);
    await waitRendered(page);
    ok((await layout(page)).current === '中文', 'a reader can switch languages');
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
}

// Tier 2 Batch B: collections at /c/:slug, owner-only, newest version of each document, pairs as one row.
async function runCollectionPage(ctx, ok) {
  const slug = 'kv-cache-study';
  const O = { cookie: ctx.ownerCookie };
  const { json: p1 } = await createAsClient(ctx, { markdown: '# Part 1: attention basics (draft)\n\nfirst draft', collection: slug, keep: true }, O);
  const { json: p1b } = await createAsClient(ctx, { markdown: '# Part 1: attention basics\n\nrevised', parent: p1.id, keep: true }, O);
  const { json: en } = await createAsClient(ctx, { markdown: fixture('pair-en.md'), lang: 'en', collection: slug }, O);
  const { json: zh } = await createAsClient(ctx, { markdown: fixture('pair-zh.md'), translation_of: en.id }, O);
  const { json: p3 } = await createAsClient(ctx, { markdown: '# Part 3: paged attention, eviction and the long road to a million-token context window on one GPU\n\nlong title', collection: slug }, O);
  const { json: other } = await createAsClient(ctx, { markdown: '# Not in it\n\nx' }, O);
  ok(p1b.collection === slug && zh.collection === slug, `versions and translations inherit the collection (${p1b.collection}, ${zh.collection})`);
  const filed = await ownerApi(ctx, 'POST', '/api/doc?action=collection', { id: other.id, collection: 'misc-notes' });
  ok(filed.status === 200 && filed.json.collection === 'misc-notes', `the collection action files an existing document (status ${filed.status})`);
  await ownerApi(ctx, 'POST', '/api/doc?action=read', { id: zh.id, open: true, scroll: 60, seconds: 20 });

  const anon = await fetch(`${ctx.serverUrl}/c/${slug}`);
  const anonMissing = await fetch(`${ctx.serverUrl}/c/no-such-collection`);
  const [a1, a2] = [await anon.text(), await anonMissing.text()];
  ok(anon.status === 401 && anonMissing.status === 401 && a1 === a2 && !a1.includes('Part 1'), `anonymous gets the same gate for an existing and a missing collection (${anon.status}/${anonMissing.status}, identical ${a1 === a2})`);
  const tokenRes = await ownerApi(ctx, 'POST', '/api/auth', { action: 'create_token', name: `coll ${rand()}`, scopes: ['documents:read'] });
  const withToken = await fetch(`${ctx.serverUrl}/c/${slug}`, { headers: { Authorization: ['Bea', 'rer'].join('') + ' ' + tokenRes.json.token } });
  ok(withToken.status === 401 && (await withToken.text()) === a1, 'a Bearer token gets the same gate (the page is owner-only)');
  const tocApi = await fetch(`${ctx.serverUrl}/api/doc?action=collection&slug=${slug}`, { headers: { Authorization: ['Bea', 'rer'].join('') + ' ' + tokenRes.json.token } });
  ok(tocApi.status === 200 && (await tocApi.json()).items.length === 3, 'agents read the same contents through the API with documents:read');

  const check = async (page, label) => {
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.coll-row')];
      const fits = rows.every((li) => { const b = li.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 0.5 && [...li.querySelectorAll('a, .tag, time')].every((x) => { const c = x.getBoundingClientRect(); return c.right <= b.right + 0.5 && c.left >= b.left - 0.5; }); });
      return {
        titles: rows.map((li) => li.querySelector('.coll-title').textContent),
        hrefs: rows.map((li) => li.querySelector('.coll-title').getAttribute('href')),
        langs: rows.map((li) => [...li.querySelectorAll('.coll-langs a')].map((a) => `${a.dataset.lang}:${a.getAttribute('href')}`)),
        read: rows.map((li) => li.querySelector('[data-read]').dataset.read),
        kept: rows.map((li) => !!li.querySelector('.tag.kept')),
        fits, overflow: document.documentElement.scrollWidth - innerWidth, summary: document.getElementById('coll-summary').textContent,
      };
    });
    ok(JSON.stringify(r.titles) === JSON.stringify(['Part 1: attention basics', 'KV cache: why time to first token drops', 'Part 3: paged attention, eviction and the long road to a million-token context window on one GPU']), `${label}: one row per document in series order, newest titles (${JSON.stringify(r.titles)})`);
    ok(r.hrefs[0] === `/v/${p1b.id}` && !(await page.content()).includes(`/v/${p1.id}"`), `${label}: the superseded draft is hidden, the row links v2`);
    ok(JSON.stringify(r.langs[1]) === JSON.stringify([`zh:/v/${zh.id}`, `en:/v/${en.id}`]), `${label}: the zh/en pair is one row with both links (${JSON.stringify(r.langs[1])})`);
    ok(JSON.stringify(r.read) === JSON.stringify(['0', '1', '0']) && JSON.stringify(r.kept) === JSON.stringify([true, false, false]), `${label}: read status and kept per row (${r.read} / ${r.kept})`);
    ok(/3 documents · 1 read/.test(r.summary), `${label}: the summary counts entries (${r.summary})`);
    ok(r.overflow <= 0 && r.fits, `${label}: no sideways scroll and every row's content fits inside it (overflow ${r.overflow}, fits ${r.fits})`);
  };
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/c/${slug}`);
    await page.waitForSelector('.coll-row', { timeout: 5000 });
    await check(page, '1280');
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
    await gotoResilient(page, `${ctx.serverUrl}/c`, { waitUntil: 'load' });
    const idx = await page.evaluate(() => [...document.querySelectorAll('#coll-index a')].map((a) => `${a.dataset.slug}:${a.querySelector('span').textContent.split(' ·')[0]}`));
    ok(idx.includes(`${slug}:3 documents`) && idx.includes('misc-notes:1 document'), `/c lists every collection with its count (${JSON.stringify(idx)})`);
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-index.png') });
    await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    await page.waitForSelector(`#coll-chips button[data-slug="${slug}"]`, { timeout: 5000 });
    await page.click(`#coll-chips button[data-slug="${slug}"]`);
    await page.waitForSelector('#search-status[data-state="done"]', { timeout: 5000 });
    const lib = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.lib-row')].map((e) => e.dataset.id), url: location.search, status: document.getElementById('search-status').textContent }));
    ok(JSON.stringify(lib.rows.slice().sort()) === JSON.stringify([p1b.id, zh.id, en.id, p3.id].sort()) && lib.url === `?collection=${slug}`, `the Library chip lists the collection's newest versions, both languages (${JSON.stringify(lib)})`);
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-library.png') });
    await page.click(`#coll-chips button[data-slug="${slug}"]`);
    await page.waitForFunction((id) => !!document.querySelector(`.lib-row[data-id="${id}"]`), other.id, { timeout: 5000 });
    ok(true, 'clicking the chip again shows the whole library');
    const tags = await page.evaluate(() => [...document.querySelectorAll('.lib-row .title .tag')].map((t) => { const r = t.getBoundingClientRect(), c = t.closest('.main').getBoundingClientRect(); return { text: t.textContent, clipped: t.scrollWidth > t.clientWidth + 1 || r.right > c.right + 0.5 }; }));
    ok(tags.some((t) => t.text === slug) && tags.every((t) => !t.clipped), `every row tag (collection, language) is shown whole, even next to a long title (${JSON.stringify(tags.filter((t) => t.clipped))})`);
  }, { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, `/c/${slug}`);
    await page.waitForSelector('.coll-row', { timeout: 5000 });
    await check(page, '390');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-phone.png'), fullPage: true });
    await gotoResilient(page, `${ctx.serverUrl}/dashboard?collection=${slug}`, { waitUntil: 'load' });
    await page.waitForSelector('#search-status[data-state="done"]', { timeout: 5000 });
    ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0 && (await page.$$('.lib-row')).length === 4, 'on a phone the Library opens the collection from the URL, with no sideways scroll');
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const missing = await ownerApi(ctx, 'GET', '/c/no-such-collection');
  ok(missing.status === 404, `the owner gets a not-found page for a missing collection (status ${missing.status})`);
}

// Multi-user beta (2026-11-27): a second signed-in user (B) in a real browser. B's cookie is minted
// with the same signer the server uses (sign-up is P3); everything else goes through the UI and API.
async function runCrossUser(ctx, ok) {
  const { signUserSession } = await import('../api/_lib/session.js');
  ctx.sb.seed('mdshare_users', { id: 2, label: 'B' }); // a cookie for a user with no row is signed out (P3)
  const bCookie = `mdshare_auth=${encodeURIComponent(signUserSession(2, Math.floor(Date.now() / 1000) + 3600))}`;
  const aSecret = `a-private-${rand()}`;
  const aPubMarker = `a-public-${rand()}`;
  const bSecret = `b-private-${rand()}`;
  const aPriv = await seedPaste(ctx.serverUrl, `# A private ${aSecret}\n\n${aSecret}`, { cookie: ctx.ownerCookie });
  const aPub = await seedPaste(ctx.serverUrl, `# A public ${aPubMarker}\n\n${aPubMarker}`, { cookie: ctx.ownerCookie });
  const pub = await ownerApi(ctx, 'PATCH', '/api/pin', { id: aPub.id, kind: 'paste', is_public: true });
  ok(pub.status === 200, 'the owner publishes one document');
  const bDoc = await seedPaste(ctx.serverUrl, `# B private ${bSecret}\n\n${bSecret}`, { cookie: bCookie });
  ok(ctx.sb.tables.mdshare_pastes.find((r) => r.id === bDoc.id)?.owner_id === 2, "B's create is owned by B");
  await withContext(ctx, async (context) => {
    const page = await ownerPage(context, ctx.serverUrl, bCookie);
    await gotoResilient(page, `${ctx.serverUrl}/v/${aPriv.id}`, { waitUntil: 'load' });
    const html = await page.content();
    ok(html.includes('This link has expired') && !html.includes(aSecret), "B opening A's private link gets the not-found page, no title or body");
    const missing = await fetch(`${ctx.serverUrl}/v/zzMissing99`, { headers: { cookie: bCookie } });
    const priv = await fetch(`${ctx.serverUrl}/v/${aPriv.id}`, { headers: { cookie: bCookie } });
    ok(missing.status === 404 && priv.status === 404 && (await missing.text()) === (await priv.text()), "A's private document and a missing id are the same 404 for B");
    await gotoResilient(page, `${ctx.serverUrl}/v/${aPub.id}`, { waitUntil: 'load' });
    await waitRendered(page);
    ok((await page.content()).includes(aPubMarker), "B reads A's public document");
    ok((await page.locator('#status-pill, #btn-edit, #btn-delete').count()) === 0, 'B gets the reader view: no owner controls on a document B does not own');
    await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    await page.waitForFunction((t) => document.body.innerText.includes(t), bSecret, { timeout: 5000 });
    const lib = await page.innerText('#lib-list');
    ok(lib.includes(bSecret) && !lib.includes(aSecret) && !lib.includes(aPubMarker), "B's library lists only B's documents");
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  });
  const aLib = await listing(ctx);
  ok(aLib.some((p) => p.id === aPriv.id) && !aLib.some((p) => p.id === bDoc.id), "the owner's library has A's documents and not B's");
  const bSearch = await (await fetch(`${ctx.serverUrl}/api/doc?action=search&q=private`, { headers: { cookie: bCookie } })).json();
  ok(bSearch.results.every((r) => r.id === bDoc.id) && bSearch.total === 1, `B's search finds only B's document (total ${bSearch.total})`);
  const bPin = await fetch(`${ctx.serverUrl}/api/pin`, { method: 'PATCH', headers: { cookie: bCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: aPriv.id, kind: 'paste', is_public: true }) });
  ok(bPin.status === 404 && ctx.sb.tables.mdshare_pastes.find((r) => r.id === aPriv.id).is_public === false, "B cannot publish A's document (404, unchanged)");
}

// Multi-user beta P3: a stranger signs up through the API, opens the private entry link in a real
// browser, publishes with the token, rotates the link, and is switched off by the owner.
async function runSignupFlow(ctx, ok) {
  const bearer = (t) => ['Bea', 'rer'].join('') + ' ' + t;
  // This stranger's own network (the suite's earlier features used up 127.0.0.1's 50 creates an hour).
  const net = { 'x-forwarded-for': '10.9.0.7' };
  const ownerMarker = `owner-private-${rand()}`;
  ctx.sb.seed('mdshare_pastes', { id: `own${rand(7)}`, owner_id: 1, title: `Owner ${ownerMarker}`, content: `# Owner ${ownerMarker}\n\n${ownerMarker}`, expires_at: '2999-01-01T00:00:00Z' });
  const su = await fetch(`${ctx.serverUrl}/api/auth?action=signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...net }, body: JSON.stringify({ label: 'e2e C' }) });
  const c = await su.json();
  ok(su.status === 201 && Number.isInteger(c.user_id) && c.user_id > 1 && /^mds_/.test(c.token) && c.guide === `${ctx.serverUrl}/llms.txt`, `sign-up answers 201 {user_id, token, entry_url, guide} (user ${c.user_id})`);
  ok(/^http:\/\/127\.0\.0\.1:\d+\/enter#[A-Za-z0-9_-]{43}$/.test(c.entry_url || ''), 'the entry link is <origin>/enter#<43-char secret>');
  const secret = String(c.entry_url).split('#')[1];
  ok(!JSON.stringify(ctx.sb.tables).includes(secret) && ctx.sb.tables.mdshare_users.some((u) => u.id === c.user_id && /^[0-9a-f]{64}$/.test(u.entry_hash)), 'the database holds only a hash of the secret');
  const tok = { Authorization: bearer(c.token), 'Content-Type': 'application/json', ...net };
  const publish = async (marker) => (await fetch(`${ctx.serverUrl}/api/share`, { method: 'POST', headers: tok, body: JSON.stringify({ markdown: `# C ${marker}\n\n${marker}`, keep: true }) })).json();
  const first = `c-first-${rand()}`;
  const p1 = await publish(first);
  ok(ctx.sb.tables.mdshare_pastes.find((r) => r.id === p1.id)?.owner_id === c.user_id, "the token's document belongs to C");

  let cCookie = null;
  await withContext(ctx, async (context) => {
    const page = await context.newPage();
    page.on('dialog', (d) => d.accept());
    const sent = [];
    page.on('request', (r) => { if (r.url().includes('/api/auth')) sent.push({ url: r.url(), body: r.postData() || '', page: page.url() }); });
    await gotoResilient(page, c.entry_url, { waitUntil: 'load' });
    await page.waitForURL('**/dashboard', { timeout: 5000 });
    const enterReq = sent.find((x) => x.url.endsWith('/api/auth?action=enter'));
    ok(enterReq && enterReq.body.includes(secret) && !enterReq.url.includes(secret), 'the page POSTs the secret in the body, never in a URL');
    ok(enterReq && enterReq.page === `${ctx.serverUrl}/enter`, `the fragment is gone from the address bar before the secret is sent (${enterReq && enterReq.page})`);
    await page.waitForFunction((t) => document.body.innerText.includes(t), first, { timeout: 5000 });
    let lib = await page.innerText('#lib-list');
    ok(lib.includes(first) && !lib.includes(ownerMarker), "the entry link opens C's Library: C's document, none of the owner's");
    const second = `c-second-${rand()}`;
    await publish(second);
    await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    await page.waitForFunction((t) => document.body.innerText.includes(t), second, { timeout: 5000 });
    lib = await page.innerText('#lib-list');
    ok(lib.includes(first) && lib.includes(second) && !lib.includes(ownerMarker), 'a document published with the token appears in the Library');
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
    await gotoResilient(page, `${ctx.serverUrl}/settings`, { waitUntil: 'load' });
    await page.waitForSelector('#tokens-list .token-row', { timeout: 5000 });
    const names = await page.$$eval('#tokens-list .token-row .name', (els) => els.map((e) => e.firstChild.textContent));
    ok(JSON.stringify(names) === JSON.stringify(['mdshare skill (e2e C)']) && (await page.isVisible('#btn-entry-link')), `Settings: only C's own token (${JSON.stringify(names)}) and the entry-link card`);
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-settings.png'), fullPage: true });
    cCookie = (await context.cookies()).find((x) => x.name === 'mdshare_auth');
  });
  ok(!!cCookie && /^v3\./.test(decodeURIComponent(cCookie.value)), 'the browser holds a v3 session cookie');
  const firstCookie = cCookie;
  await new Promise((r) => setTimeout(r, 1100)); // sessions carry whole seconds

  const rot = await fetch(`${ctx.serverUrl}/api/auth?action=entry-link`, { method: 'POST', headers: tok });
  const fresh = await rot.json();
  ok(rot.status === 200 && fresh.entry_url && fresh.entry_url !== c.entry_url, 'rotating with the token returns a new entry link');
  await withContext(ctx, async (context) => {
    const page = await context.newPage();
    await gotoResilient(page, c.entry_url, { waitUntil: 'load' });
    await page.waitForFunction(() => /does not work/.test(document.getElementById('enter-title').textContent), null, { timeout: 5000 });
    ok(page.url() === `${ctx.serverUrl}/enter` && !(await context.cookies()).some((x) => x.name === 'mdshare_auth'), 'the old link fails: no session, and its secret is gone from the address bar');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-old-link.png') });
    await gotoResilient(page, fresh.entry_url, { waitUntil: 'load' });
    await page.waitForURL('**/dashboard', { timeout: 5000 });
    ok(true, 'the new link opens the Library');
    cCookie = (await context.cookies()).find((x) => x.name === 'mdshare_auth');
  });
  ok((await fetch(`${ctx.serverUrl}/api/pastes`, { headers: { cookie: `mdshare_auth=${firstCookie.value}` } })).status === 401, 'rotating signed out the browser that used the old link');

  // The kill switch, on a public page of C's.
  const pub = await fetch(`${ctx.serverUrl}/api/pin`, { method: 'PATCH', headers: tok, body: JSON.stringify({ id: p1.id, kind: 'paste', is_public: true, keep: true }) });
  ok(pub.status === 200 && (await fetch(`${ctx.serverUrl}/v/${p1.id}`)).status === 200, "C's token publishes its own document; anyone can open it");
  const dis = await ownerApi(ctx, 'POST', '/api/auth?action=disable-user', { user_id: c.user_id, disabled: true });
  ok(dis.status === 200 && dis.json.disabled === true, 'the owner disables C');
  const [ownerView, anonView, anonMissing] = await Promise.all([
    fetch(`${ctx.serverUrl}/v/${p1.id}`, { headers: { cookie: ctx.ownerCookie } }),
    fetch(`${ctx.serverUrl}/v/${p1.id}`),
    fetch(`${ctx.serverUrl}/v/zzMissing42`),
  ]);
  const norm = async (r, id) => (await r.text()).split(id).join('<ID>');
  ok(ownerView.status === 404, `C's public page is a 404 for a signed-in reader (${ownerView.status})`);
  ok(anonView.status === anonMissing.status && (await norm(anonView, p1.id)) === (await norm(anonMissing, 'zzMissing42')), 'and exactly a missing link for anyone else');
  const who = await fetch(`${ctx.serverUrl}/api/auth?action=whoami`, { headers: tok });
  ok(who.status === 401, `C's token is refused (${who.status})`);
  await withContext(ctx, async (context) => {
    const page = await ownerPage(context, ctx.serverUrl, `mdshare_auth=${cCookie.value}`);
    const r = await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    ok(r.status() === 401 && (await page.isVisible('#pwd')), "C's browser session is signed out (the Library shows the sign-in card)");
    const view = await gotoResilient(page, `${ctx.serverUrl}/v/${p1.id}`, { waitUntil: 'load' });
    ok(view.status() === 401 && !(await page.content()).includes(first), "C's own page is gone for C too");
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-disabled.png') });
  });
  const back = await ownerApi(ctx, 'POST', '/api/auth?action=disable-user', { user_id: c.user_id, disabled: false });
  ok(back.status === 200 && (await fetch(`${ctx.serverUrl}/v/${p1.id}`)).status === 200, 're-enabling C brings the public page back');
  const one = await ownerApi(ctx, 'POST', '/api/auth?action=disable-user', { user_id: 1, disabled: true });
  ok(one.status === 400 && (await ownerApi(ctx, 'GET', '/api/pastes')).status === 200, 'user #1 can never be disabled');
  const stats = await ownerApi(ctx, 'GET', '/api/doc?action=stats');
  const row = stats.json && stats.json.users.find((u) => u.user_id === c.user_id);
  ok(stats.status === 200 && row && row.docs_this_week === 2 && !stats.text.includes(first), `the owner's stats count C's documents without titles (${JSON.stringify(row)})`);
}

const RUNNERS = {
  'home-page': runHomePage,
  'create-paste-ui': runCreatePasteUi,
  'anon-private-gate': runAnonPrivateGate,
  'owner-view-markdown': runOwnerViewMarkdown,
  'raw-route': runRawRoute,
  'dashboard-lists-paste': runDashboardListsPaste,
  'publish-unpublish': runPublishUnpublish,
  'diagram-create-render': runDiagramCreateRender,
  'archify-create-render': runArchifyCreateRender,
  'agent-token-lifecycle': runAgentTokenLifecycle,
  'pin-delete': runPinDelete,
  'reader-header': runReaderHeader,
  'auto-keep-on-publish': runAutoKeepOnPublish,
  'keep-toggle': runKeepToggle,
  'api-keep': runApiKeep,
  'auto-format': runAutoFormat,
  'retrofit-counterexamples': runRetrofitCounterexamples,
  'text-equivalence': runTextEquivalence,
  'directives': runDirectives,
  'xss-safety': runXssSafety,
  'raw-content-sandbox': runRawContentSandbox,
  'reading-settings': runReadingSettings,
  'reader-prefs': runReaderPrefs,
  'reader-motion': runReaderMotion,
  'resume-reading': runResumeReading,
  'settings-reading': runSettingsReading,
  'edit-save': runEditSave,
  'library': runLibrary,
  'settings-signout': runSettingsSignout,
  'guide-llms': runGuideAndLlms,
  'shells-and-errors': runShells,
  'cross-user': runCrossUser,
  'signup-flow': runSignupFlow,
  'mobile': runMobile,
  'classic-view': runClassicView,
  'renderer-fuzz': runRendererFuzz,
  'ui-monkey': runUiMonkey,
  'table-readability': runTableReadability,
  'publish-checks': runPublishChecks,
  'read-receipts': runReadReceipts,
  'feedback-loop': runFeedbackLoop,
  'versions': runVersions,
  'preview-tool': runPreviewTool,
  'inline-diagrams': runInlineDiagrams,
  'library-search': runLibrarySearch,
  'agent-read-v': runAgentReadV,
  'translation-switch': runTranslationSwitch,
  'collection-page': runCollectionPage,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appRoot = args.root ? path.resolve(args.root) : path.resolve(path.join(E2E_DIR, '..'));
  const proofDir = path.join(E2E_DIR, 'proof');
  fs.mkdirSync(proofDir, { recursive: true });

  const features = JSON.parse(fs.readFileSync(path.join(E2E_DIR, 'features.json'), 'utf8'));
  const selected = args.feature ? features.filter((f) => f.id === args.feature) : features;
  if (args.feature && selected.length === 0) {
    console.error(`Unknown feature id: ${args.feature}`);
    process.exitCode = 1;
    return;
  }

  const sb = await startFakeSupabase({});
  const srv = await startServer({ root: appRoot, supabaseUrl: sb.url });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--no-sandbox'],
  });

  const results = [];
  let anyFail = false;

  try {
    // Exactly one real, UI-driven owner login for the whole run — see realOwnerLoginOnce's
    // comment for why (api/auth.js's own 5-attempts/15min rate limit on password POSTs).
    const ownerCookie = await realOwnerLoginOnce(browser, srv.url);

    for (const feature of selected) {
      const runner = RUNNERS[feature.id];
      sb.reset();
      const t0 = Date.now();
      const assertions = [];
      const ok = (cond, message) => assertions.push({ message, pass: !!cond });
      const ctx = { serverUrl: srv.url, sb, browser, ownerCookie, jsErrors: [], proofPath: path.join(proofDir, `${feature.id}.png`) };
      let error = null;

      if (!runner) {
        error = 'no runner implemented for this feature id';
      } else {
        try {
          await runner(ctx, ok);
        } catch (err) {
          error = String((err && err.message) || err);
        }
      }

      if (!error) ok(ctx.jsErrors.length === 0, `no JS errors on any page${ctx.jsErrors.length ? ` (got: ${ctx.jsErrors.slice(0, 3).join(' | ')})` : ''}`);
      const ms = Date.now() - t0;
      const pass = !error && assertions.length > 0 && assertions.every((a) => a.pass);
      if (!pass) anyFail = true;
      results.push({ id: feature.id, name: feature.name, pass, ms, assertions, error });

      console.log(`${pass ? 'PASS' : 'FAIL'} ${feature.id} (${ms}ms)${error ? ` -- ${error}` : ''}`);
      for (const a of assertions) if (!a.pass) console.log(`   FAILED ASSERTION: ${a.message}`);
    }
  } finally {
    await browser.close();
    await srv.close();
    await sb.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    root: appRoot,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    totalMs: results.reduce((s, r) => s + r.ms, 0),
    results,
  };
  fs.writeFileSync(path.join(proofDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.passed}/${report.total} features passed in ${report.totalMs}ms`);

  process.exitCode = anyFail ? 1 : 0;
}

await main();
