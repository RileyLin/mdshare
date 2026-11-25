#!/usr/bin/env node
// e2e/preview.mjs — let an agent see a document the way the reader will, before (or after)
// publishing it. Renders a local Markdown file through the real reader page (local stack + fake
// Supabase, same code as production) at a phone and a desktop width and prints a JSON report:
//
//   node e2e/preview.mjs <file.md> [--out <dir>] [--widths 390,1280] [--no-network]
//
//   { ok, checks: <publish checks>, widths: [{ width, jsErrors, overflowPx, mermaid: {total,
//     drawn, failed, checked}, tables: [{cols, view}], unknownBlocks, screenshot }] }
//
// ok is false when the publish checks warn, a script errors, the page scrolls sideways, or a
// mermaid diagram fails to draw. Mermaid is fetched once with curl and cached outside the repo;
// with --no-network (or no copy) diagrams are reported as checked:false, never as passing.
import { ensureNoProxyEnv } from './_proxy-guard.mjs';
const OUTER_PROXY = process.env.__MDSHARE_PREVIEW_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
if (OUTER_PROXY && !process.env.__MDSHARE_PREVIEW_PROXY) process.env.__MDSHARE_PREVIEW_PROXY = OUTER_PROXY;
await ensureNoProxyEnv();

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startServer } from './server.mjs';
import { lintMarkdown } from '../api/_lib/lint.js';

const OWNER_PASSWORD = 'e2e-test-password';
const E2E_DIR = path.resolve(new URL('.', import.meta.url).pathname);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2); const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true;
    } else out._.push(argv[i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node e2e/preview.mjs <file.md> [--out <dir>] [--widths 390,1280] [--no-network]');
  process.exit(2);
}
const markdown = fs.readFileSync(file, 'utf8');
const outDir = path.resolve(String(args.out || path.join(process.env.TMPDIR || '/tmp', 'mdshare-preview')));
fs.mkdirSync(outDir, { recursive: true });
const widths = String(args.widths || '390,1280').split(',').map((w) => parseInt(w, 10)).filter((w) => w >= 280 && w <= 3840);
const network = !args['no-network'];
const proxy = process.env.__MDSHARE_PREVIEW_PROXY;

// Mermaid comes from jsdelivr in production. Cache one copy outside the repo (fetched with curl,
// which this machine's proxy handles better than headless Chromium) and serve it to the page.
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
const mermaidCache = path.join(process.env.HOME || '/tmp', '.cache', 'mdshare-preview', 'mermaid-11.min.js');
if (network && !fs.existsSync(mermaidCache)) {
  fs.mkdirSync(path.dirname(mermaidCache), { recursive: true });
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('curl', ['-sfL', '-m', '60', ...(proxy ? ['-x', proxy] : []), '-o', mermaidCache, MERMAID_URL], { stdio: 'ignore' });
  if (r.status !== 0) fs.rmSync(mermaidCache, { force: true });
}
const mermaidJs = network && fs.existsSync(mermaidCache) ? fs.readFileSync(mermaidCache) : null;

const sb = await startFakeSupabase({});
const srv = await startServer({ root: path.resolve(path.join(E2E_DIR, '..')), supabaseUrl: sb.url });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
const report = { file: path.resolve(file), ok: true, checks: lintMarkdown(markdown), widths: [] };

try {
  const login = await fetch(`${srv.url}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
  const sc = login.headers.get('set-cookie') || '';
  const cookie = { name: sc.slice(0, sc.indexOf('=')), value: sc.slice(sc.indexOf('=') + 1, sc.indexOf(';')), url: srv.url };
  const created = await (await fetch(`${srv.url}/api/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }) })).json();

  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, isMobile: width < 600, hasTouch: width < 600, reducedMotion: 'reduce', ignoreHTTPSErrors: true });
    await context.route(/^https:\/\//, (r) => {
      const u = r.request().url();
      if (mermaidJs && /cdn\.jsdelivr\.net\/npm\/mermaid@11\//.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: mermaidJs });
      if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) return r.fulfill({ status: 200, body: '' });
      return r.abort();
    });
    await context.addCookies([cookie]);
    const jsErrors = [];
    const page = await context.newPage();
    page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) jsErrors.push(`console: ${m.text()}`); });
    await page.goto(`${srv.url}/v/${created.id}?as=reader`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => { const c = document.getElementById('content'); return c && c.children.length > 0; }, null, { timeout: 8000 }).catch(() => {});
    const hasMermaid = await page.evaluate(() => document.querySelectorAll('#content .mermaid').length);
    if (hasMermaid) {
      await page.waitForFunction(() => Array.prototype.every.call(document.querySelectorAll('#content .mermaid'), (n) => n.querySelector('svg') || n.classList.contains('mermaid-failed')), null, { timeout: 12000 }).catch(() => {});
    }
    await page.waitForTimeout(250);
    const facts = await page.evaluate(() => {
      const ms = Array.prototype.slice.call(document.querySelectorAll('#content .mermaid'));
      const isError = (n) => n.classList.contains('mermaid-failed') || !!n.querySelector('svg[aria-roledescription="error"]') || /Syntax error in text/.test(n.textContent || '');
      return {
        overflowPx: document.documentElement.scrollWidth - innerWidth,
        // mermaid draws a "Syntax error in text" bomb svg for a diagram it can't parse; count it as failed.
        mermaid: { total: ms.length, drawn: ms.filter((n) => n.querySelector('svg') && !isError(n)).length, failed: ms.filter(isError).length },
        tables: Array.prototype.map.call(document.querySelectorAll('#content [data-cols]'), (b) => ({ cols: Number(b.getAttribute('data-cols')), view: b.getAttribute('data-view') || 'table' })),
        unknownBlocks: document.querySelectorAll('#content .md-unknown').length,
        text: (document.getElementById('content') || {}).textContent ? document.getElementById('content').textContent.length : 0,
      };
    });
    facts.mermaid.checked = facts.mermaid.total === 0 || facts.mermaid.drawn + facts.mermaid.failed === facts.mermaid.total;
    const shot = path.join(outDir, `${path.basename(file).replace(/\.[^.]+$/, '')}-${width}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const w = { width, jsErrors, ...facts, screenshot: shot };
    if (jsErrors.length || facts.overflowPx > 0 || facts.mermaid.failed > 0 || facts.text === 0) report.ok = false;
    report.widths.push(w);
    await context.close();
  }
  if (!report.checks.ok) report.ok = false;
} finally {
  await browser.close();
  await srv.close();
  await sb.close();
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
