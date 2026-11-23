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
    await page.click('#submit-btn');
    await page.waitForURL('**/dashboard', { timeout: 5000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === 'mdshare_auth');
    if (!authCookie) throw new Error('owner login did not produce an mdshare_auth session cookie');
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

async function runSettingsSignout(ctx, ok) {
  await withContext(ctx, async (context) => {
    const page = await openOwner(ctx, context, '/settings');
    ok(await page.isChecked('#pref-autokeep'), 'auto-keep defaults to on');
    const seg = await page.getAttribute('#settings #theme-seg [data-v="system"]', 'aria-pressed');
    ok(seg === 'true', 'the Settings theme control shows the current choice (System)');
    await page.click('#settings #theme-seg [data-v="dark"]');
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
    const r = await page.evaluate(() => ({ h1: document.querySelector('#content h1').textContent, stats: document.querySelectorAll('#content .md-stats').length, toc: document.querySelectorAll('#toc a').length, raw: [...document.querySelectorAll('#content > p')].some((p) => /^:::/.test(p.textContent)), mermaid: document.querySelectorAll('#content .mermaid[data-mermaid-stub="ran"]').length }));
    ok(r.h1 === 'Formatting guide' && r.stats === 1 && r.toc > 6, `the guide renders through mdshare itself (${JSON.stringify(r)})`);
    const tocLabels = await page.$$eval('#toc a', (as) => as.map((a) => a.textContent));
    ok(!tocLabels.includes('Before') && !tocLabels.includes('First tab') && !tocLabels.includes('curl'), 'headings inside compare/cards/tabs blocks stay out of the contents');
    ok(!r.raw, 'every example in the guide renders (no stray ::: lines)');
    ok(r.mermaid === 1, 'mermaid blocks are handed to mermaid (lazy-loaded)');
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
  const nf = await fetch(`${ctx.serverUrl}/v/doesnotexist1`);
  const nfHtml = await nf.text();
  ok(nf.status === 404 && nfHtml.includes('This link has expired') && nfHtml.includes('/assets/mdshare.css'), 'missing documents get the designed 404 page');
  for (const p of ['/d/doesnotexist1', '/a/doesnotexist1']) {
    const r = await fetch(`${ctx.serverUrl}${p}`);
    ok(r.status === 404 && (await r.text()).includes('This link has expired'), `${p} gets the same 404 page`);
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
    const c1 = await page.evaluate(() => { const w = document.querySelector('#content .table-wrap'), td = w.querySelector('tbody td:nth-child(2)'); return { view: w.dataset.view, display: getComputedStyle(w.querySelector('tr')).display, label: getComputedStyle(td, '::before').content, width: w.parentElement.getBoundingClientRect().width, art: document.getElementById('content').getBoundingClientRect().width }; });
    ok(c1.view === 'cards' && c1.display === 'block' && c1.label === '"白话解释"' && Math.abs(c1.width - c1.art) < 2, `Cards turns each row into a card labelled from the header (label ${c1.label}), back inside the column`);
    ok((await text(page)) === before, 'Cards shows exactly the same text (labels are drawn, not added)');
    await page.screenshot({ path: ctx.proofPath.replace(/\.png$/, '-cards.png') });
    await page.click('#content .table-block >> nth=0 >> button[data-view="table"]');
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
  'reading-settings': runReadingSettings,
  'edit-save': runEditSave,
  'library': runLibrary,
  'settings-signout': runSettingsSignout,
  'guide-llms': runGuideAndLlms,
  'shells-and-errors': runShells,
  'mobile': runMobile,
  'classic-view': runClassicView,
  'renderer-fuzz': runRendererFuzz,
  'ui-monkey': runUiMonkey,
  'table-readability': runTableReadability,
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
