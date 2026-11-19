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

async function seedPaste(serverUrl, markdown) {
  const r = await fetch(`${serverUrl}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown }),
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

async function withContext(ctx, fn) {
  const context = await ctx.browser.newContext();
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

async function runHomePage(ctx, ok) {
  await withContext(ctx, async (context) => {
    const page = await context.newPage();
    await gotoResilient(page, `${ctx.serverUrl}/`);
    await page.waitForSelector('#md', { timeout: 5000 });
    ok(await page.isVisible('#md'), 'textarea#md is visible');
    const shareBtnCount = await page.locator('button', { hasText: 'Share' }).count();
    ok(shareBtnCount > 0, 'a Share button is present');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runCreatePasteUi(ctx, ok) {
  await withContext(ctx, async (context) => {
    const page = await context.newPage();
    await gotoResilient(page, `${ctx.serverUrl}/`);
    await page.fill('#md', `# E2E Create Test ${rand()}\n\nCreated via the home page UI.`);
    await page.click('button:has-text("Share")');
    await page.waitForSelector('#result', { state: 'visible', timeout: 5000 });
    const href = await page.getAttribute('#link', 'href');
    ok(!!href && /\/v\/[A-Za-z0-9_-]+/.test(href), `#link href looks like a share link (got "${href}")`);
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runAnonPrivateGate(ctx, ok) {
  const secretTitle = `Super Secret Title ${rand()}`;
  const secretBody = `secret-body-marker-${rand()}`;
  const { id } = await seedPaste(ctx.serverUrl, `# ${secretTitle}\n\n${secretBody}`);
  await withContext(ctx, async (context) => {
    const page = await context.newPage();
    await gotoResilient(page, `${ctx.serverUrl}/v/${id}`);
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
  const markdown = `# ${heading}\n\n| Col A | Col B |\n|---|---|\n| 1 | 2 |\n`;
  const { id } = await seedPaste(ctx.serverUrl, markdown);
  await withContext(ctx, async (context) => {
    const page = await ownerPage(context, ctx.serverUrl, ctx.ownerCookie);
    await gotoResilient(page, `${ctx.serverUrl}/v/${id}`, { waitUntil: 'load' });
    await page.waitForSelector('#content h1', { timeout: 5000 });
    const h1 = (await page.textContent('#content h1')).trim();
    ok(h1 === heading, `rendered <h1> matches the seeded heading (got "${h1}")`);
    const tableCount = await page.locator('#content table').count();
    ok(tableCount > 0, 'rendered content contains a <table>');
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runRawRoute(ctx, ok) {
  const content = `raw-route-secret-${rand()}`;
  const { id } = await seedPaste(ctx.serverUrl, content);

  const anonRes = await fetch(`${ctx.serverUrl}/raw/${id}`);
  const anonBody = await anonRes.text();
  ok(anonRes.status !== 200 && !anonBody.includes(content), `anonymous GET /raw/:id is denied (status ${anonRes.status})`);

  const cookie = ctx.ownerCookie;
  const ownerRes = await fetch(`${ctx.serverUrl}/raw/${id}`, { headers: { cookie } });
  const ownerBody = await ownerRes.text();
  ok(ownerRes.status === 200 && ownerBody === content, `owner GET /raw/:id returns the exact content (status ${ownerRes.status})`);

  await withContext(ctx, async (context) => {
    const page = await ownerPage(context, ctx.serverUrl, ctx.ownerCookie);
    await gotoResilient(page, `${ctx.serverUrl}/raw/${id}`);
    await page.screenshot({ path: ctx.proofPath });
  });
}

async function runDashboardListsPaste(ctx, ok) {
  const title = `Dashboard List Test ${rand()}`;
  await seedPaste(ctx.serverUrl, `# ${title}\n\nbody`);
  await withContext(ctx, async (context) => {
    const page = await ownerPage(context, ctx.serverUrl, ctx.ownerCookie);
    await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    await page.waitForFunction((t) => document.body.innerText.includes(t), title, { timeout: 5000 });
    const bodyText = await page.innerText('body');
    ok(bodyText.includes(title), "the seeded paste's title appears in the dashboard list");
    await page.screenshot({ path: ctx.proofPath, fullPage: true });
  });
}

async function runPublishUnpublish(ctx, ok) {
  const marker = `publish-toggle-marker-${rand()}`;
  const { id } = await seedPaste(ctx.serverUrl, `# Publish Toggle Test\n\n${marker}`);

  await withContext(ctx, async (ownerCtx) => {
    const ownerPg = await ownerPage(ownerCtx, ctx.serverUrl, ctx.ownerCookie);
    ownerPg.on('dialog', (d) => d.accept());
    await gotoResilient(ownerPg, `${ctx.serverUrl}/v/${id}`, { waitUntil: 'load' });
    await ownerPg.waitForSelector('#btn-visibility', { timeout: 5000 });

    await ownerPg.click('#btn-visibility'); // "Share publicly"
    await ownerPg.waitForFunction(
      () => document.getElementById('visibility-badge')?.textContent === 'public',
      null,
      { timeout: 5000 }
    );

    await withContext(ctx, async (anonCtx) => {
      const anonPage = await anonCtx.newPage();
      await gotoResilient(anonPage, `${ctx.serverUrl}/v/${id}`);
      const gateVisible = (await anonPage.locator('#pwd').count()) > 0;
      ok(!gateVisible, 'after publish, anonymous request no longer sees the login gate');
      const anonHtml = await anonPage.content();
      ok(anonHtml.includes(marker), 'after publish, anonymous request sees the actual content');
      await anonPage.screenshot({ path: ctx.proofPath });
    });

    await ownerPg.click('#btn-visibility'); // "Stop sharing"
    await ownerPg.waitForFunction(
      () => document.getElementById('visibility-badge')?.textContent === 'private',
      null,
      { timeout: 5000 }
    );
  });

  await withContext(ctx, async (anonCtx2) => {
    const anonPage2 = await anonCtx2.newPage();
    await gotoResilient(anonPage2, `${ctx.serverUrl}/v/${id}`);
    await anonPage2.waitForSelector('#pwd', { timeout: 5000 });
    ok(await anonPage2.isVisible('#pwd'), 'after unpublish, anonymous request sees the login gate again');
  });
}

async function runDiagramCreateRender(ctx, ok) {
  const marker = `E2E-DIAGRAM-MARKER-${rand()}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#eee"/><text x="10" y="40">${marker}</text></svg>`;
  const { id } = await seedDiagram(ctx.serverUrl, { svg, title: 'E2E Diagram' });

  await withContext(ctx, async (anonCtx) => {
    const anonPg = await anonCtx.newPage();
    await gotoResilient(anonPg, `${ctx.serverUrl}/d/${id}`);
    await anonPg.waitForSelector('#pwd', { timeout: 5000 });
    ok(await anonPg.isVisible('#pwd'), 'anonymous visit to /d/:id sees the login gate');
    const anonHtml = await anonPg.content();
    ok(!anonHtml.includes(marker), 'anonymous visit does not see the SVG marker');
  });

  await withContext(ctx, async (ownerCtx) => {
    const ownerPg = await ownerPage(ownerCtx, ctx.serverUrl, ctx.ownerCookie);
    await gotoResilient(ownerPg, `${ctx.serverUrl}/d/${id}`, { waitUntil: 'load' });
    await ownerPg.waitForSelector('#svg-frame svg', { timeout: 5000 });
    const ownerHtml = await ownerPg.content();
    ok(ownerHtml.includes(marker), 'owner visit renders the SVG marker');
    await ownerPg.screenshot({ path: ctx.proofPath });
  });
}

async function runArchifyCreateRender(ctx, ok) {
  const marker = `ARCHIFY-E2E-MARKER-${rand()}`;
  const html = `<!DOCTYPE html><html><head></head><body><svg xmlns="http://www.w3.org/2000/svg"></svg><p>${marker}</p></body></html>`;
  const { id } = await seedArchify(ctx.serverUrl, { kind: 'architecture', html, markdown: '# Archify Doc', title: 'E2E Archify' });

  await withContext(ctx, async (anonCtx) => {
    const anonPg = await anonCtx.newPage();
    await gotoResilient(anonPg, `${ctx.serverUrl}/a/${id}`);
    await anonPg.waitForSelector('#pwd', { timeout: 5000 });
    ok(await anonPg.isVisible('#pwd'), 'anonymous visit to /a/:id sees the login gate');
  });

  await withContext(ctx, async (ownerCtx) => {
    const ownerPg = await ownerPage(ownerCtx, ctx.serverUrl, ctx.ownerCookie);
    await gotoResilient(ownerPg, `${ctx.serverUrl}/a/${id}`, { waitUntil: 'load' });
    await ownerPg.waitForSelector('iframe#diagram-frame', { timeout: 5000 });
    const html2 = await ownerPg.content();
    const sandboxMatch = html2.match(/<iframe[^>]*\ssandbox="([^"]*)"[^>]*>/);
    ok(!!sandboxMatch, 'owner page has an <iframe> with a sandbox attribute');
    ok(!!sandboxMatch && sandboxMatch[1].includes('allow-scripts'), 'iframe sandbox includes allow-scripts');
    ok(!!sandboxMatch && !sandboxMatch[1].includes('allow-same-origin'), 'iframe sandbox does NOT include allow-same-origin');
    await ownerPg.screenshot({ path: ctx.proofPath });
  });
}

async function runAgentTokenLifecycle(ctx, ok) {
  const marker = `agent-token-read-marker-${rand()}`;
  const { id: pasteId } = await seedPaste(ctx.serverUrl, `# Token Read Target\n\n${marker}`);

  let rawToken = null;

  await withContext(ctx, async (ownerCtx) => {
    const page = await ownerPage(ownerCtx, ctx.serverUrl, ctx.ownerCookie);
    await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    await page.click('#tokens-toggle');
    await page.waitForSelector('#tokens-panel', { state: 'visible', timeout: 5000 });
    const placeholder = await page.getAttribute('#new-token-name', 'placeholder');
    ok(placeholder === 'Token name (e.g. "Kit")', `token-name placeholder renders intact (got ${JSON.stringify(placeholder)})`);
    await page.fill('#new-token-name', `E2E Token ${rand()}`);
    // Defaults: documents:read checked, write/publish unchecked, legacy unchecked — exactly the
    // "read-only over the whole library" default this UI documents.
    await page.click('#btn-create-token');
    await page.waitForSelector('#new-token-reveal', { state: 'visible', timeout: 5000 });
    rawToken = (await page.textContent('#new-token-value')).trim();
    ok(!!rawToken && rawToken.startsWith('mds_'), 'token creation reveals a raw token value in the UI');
    await page.screenshot({ path: ctx.proofPath });
  });

  const ownerCookie = ctx.ownerCookie;
  const listRes = await fetch(`${ctx.serverUrl}/api/auth?action=tokens`, { headers: { cookie: ownerCookie } });
  const { tokens } = await listRes.json();
  const created = (tokens || []).find((t) => t.status === 'active' && Array.isArray(t.scopes) && t.scopes.includes('documents:read'));
  ok(!!created, 'created token appears in the owner token list with documents:read');

  const bearerRes1 = await fetch(`${ctx.serverUrl}/api/share?id=${pasteId}`, { headers: { Authorization: `Bearer ${rawToken}` } });
  const bearerBody1 = await bearerRes1.text();
  ok(bearerRes1.status === 200 && bearerBody1.includes(marker), `bearer GET with documents:read reads a row it did not create (status ${bearerRes1.status})`);

  const revokeRes = await fetch(`${ctx.serverUrl}/api/auth`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ action: 'revoke_token', id: created && created.id }),
  });
  ok(revokeRes.status === 200, `revoke succeeds (status ${revokeRes.status})`);

  const bearerRes2 = await fetch(`${ctx.serverUrl}/api/share?id=${pasteId}`, { headers: { Authorization: `Bearer ${rawToken}` } });
  ok(bearerRes2.status === 401, `bearer GET after revoke returns 401 (got ${bearerRes2.status})`);
}

async function runPinDelete(ctx, ok) {
  const pinTitle = `Pin Test ${rand()}`;
  const { id: pinId } = await seedPaste(ctx.serverUrl, `# ${pinTitle}\n\nbody`);
  const { id: delId } = await seedPaste(ctx.serverUrl, `# Delete Test ${rand()}\n\nbody-to-delete`);

  await withContext(ctx, async (ownerCtx) => {
    const page = await ownerPage(ownerCtx, ctx.serverUrl, ctx.ownerCookie);
    await gotoResilient(page, `${ctx.serverUrl}/dashboard`, { waitUntil: 'load' });
    await page.waitForFunction((t) => document.body.innerText.includes(t), pinTitle, { timeout: 5000 });
    await page.click('#select-toggle');
    await page.click(`.paste-item[data-id="${pinId}"]`);
    await page.click('#btn-pin');
    await page.waitForFunction(
      (t) => {
        const item = document.querySelector(`.paste-item[data-id="${t}"]`);
        return !!item && item.textContent.includes('Pinned');
      },
      pinId,
      { timeout: 5000 }
    );
    ok(true, "pinned paste shows a 'Pinned' badge on the dashboard after pinning");
    await page.screenshot({ path: ctx.proofPath });
  });

  await withContext(ctx, async (ownerCtx2) => {
    const page = await ownerPage(ownerCtx2, ctx.serverUrl, ctx.ownerCookie);
    page.on('dialog', (d) => d.accept());
    await gotoResilient(page, `${ctx.serverUrl}/v/${delId}`, { waitUntil: 'load' });
    await page.waitForSelector('#btn-delete', { timeout: 5000 });
    await page.click('#btn-delete');
    await page.waitForURL('**/dashboard?deleted=1', { timeout: 5000 }).catch(() => {});
  });

  const ownerCookie = ctx.ownerCookie;
  const afterDelete = await fetch(`${ctx.serverUrl}/raw/${delId}`, { headers: { cookie: ownerCookie } });
  ok(afterDelete.status === 404, `deleted paste's raw content 404s afterward (status ${afterDelete.status})`);
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
      const ctx = { serverUrl: srv.url, sb, browser, ownerCookie, proofPath: path.join(proofDir, `${feature.id}.png`) };
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
