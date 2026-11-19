#!/usr/bin/env node
// e2e/shots.mjs — screenshot gallery of every page in both themes, for design review.
//
//   node e2e/shots.mjs [--out <dir>] [--only <name-substring>]
//
// Same local stack as run.mjs (fake Supabase + emulator, no network). Seeds the fixtures in
// e2e/fixtures, then captures each page. Fails (exit 1) if any page logs a JS error.
import { ensureNoProxyEnv } from './_proxy-guard.mjs';
await ensureNoProxyEnv();

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startServer } from './server.mjs';
import { installCdnStubs } from './_cdn-stubs.mjs';

const E2E_DIR = path.resolve(new URL('.', import.meta.url).pathname);
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i > -1 ? args[i + 1] : d; };
const out = path.resolve(arg('out', path.join(E2E_DIR, 'proof', 'shots')));
const only = arg('only', '');
fs.mkdirSync(out, { recursive: true });
const fx = (n) => fs.readFileSync(path.join(E2E_DIR, 'fixtures', n), 'utf8');

const sb = await startFakeSupabase({});
const srv = await startServer({ root: path.join(E2E_DIR, '..'), supabaseUrl: sb.url });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const login = await fetch(`${srv.url}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'e2e-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (p, body) => (await fetch(srv.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) })).json();
  const zh = await post('/api/share', { markdown: fx('zh-explainer.md'), keep: true });
  const en = await post('/api/share', { markdown: fx('en-report.md') });
  const dir = await post('/api/share', { markdown: fx('directives.md') });
  const dg = await post('/api/diagram', { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 220"><rect width="600" height="220" rx="16" fill="#1f1b16"/><rect x="40" y="70" width="140" height="80" rx="12" fill="#b4532a"/><rect x="230" y="70" width="140" height="80" rx="12" fill="#3d6b9a"/><rect x="420" y="70" width="140" height="80" rx="12" fill="#3f7d4e"/><text x="110" y="116" fill="#fff" font-size="18" text-anchor="middle">Write</text><text x="300" y="116" fill="#fff" font-size="18" text-anchor="middle">Share</text><text x="490" y="116" fill="#fff" font-size="18" text-anchor="middle">Publish</text></svg>', title: 'Publishing flow', markdown: '## Notes\n\nPrivate first, **kept** when published.' });
  const ar = await post('/api/archify', { kind: 'architecture', title: 'Service map', html: '<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f2eee5;padding:40px"><svg width="300" height="80"><rect width="300" height="80" fill="#bb4c23"/></svg><p>Archify document</p></body></html>' });
  await fetch(`${srv.url}/api/pin`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ id: en.id, kind: 'paste', is_public: true }) });

  const shots = [
    { name: 'home', url: '/', anon: true, full: true },
    { name: 'reader-zh-owner', url: `/v/${zh.id}` },
    { name: 'reader-zh-owner-dark', url: `/v/${zh.id}`, dark: true },
    { name: 'reader-zh-scrolled', url: `/v/${zh.id}`, scrollTo: 'h2:nth-of-type(2)' },
    { name: 'reader-en-public-reader', url: `/v/${en.id}`, anon: true },
    { name: 'reader-share-panel', url: `/v/${zh.id}`, click: '#status-pill' },
    { name: 'reader-aa-panel', url: `/v/${zh.id}`, click: '#btn-aa' },
    { name: 'reader-more-menu', url: `/v/${zh.id}`, click: '#btn-more' },
    { name: 'reader-edit', url: `/v/${zh.id}`, click: '#btn-edit' },
    { name: 'directives', url: `/v/${dir.id}`, full: true },
    { name: 'directives-dark', url: `/v/${dir.id}`, full: true, dark: true },
    { name: 'mobile-reader', url: `/v/${zh.id}`, mobile: true, full: true },
    { name: 'mobile-library', url: '/dashboard', mobile: true },
    { name: 'library', url: '/dashboard' },
    { name: 'library-selected', url: '/dashboard', clickAll: '.lib-row .cb input' },
    { name: 'settings', url: '/settings', full: true },
    { name: 'guide', url: '/guide', anon: true, full: true },
    { name: 'guide-top', url: '/guide', anon: true },
    { name: 'mobile-reader-top', url: `/v/${zh.id}`, mobile: true },
    { name: 'mobile-share-panel', url: `/v/${zh.id}`, mobile: true, click: '#status-pill' },
    { name: 'diagram', url: `/d/${dg.id}` },
    { name: 'archify', url: `/a/${ar.id}` },
    { name: 'login-gate', url: `/v/${zh.id}`, anon: true },
    { name: 'not-found', url: '/v/doesnotexist1', anon: true },
    { name: 'classic', url: `/v/${zh.id}?classic=1` },
  ].filter((s) => !only || s.name.includes(only));

  for (const s of shots) {
    const context = await browser.newContext({ viewport: s.mobile ? { width: 390, height: 844 } : { width: 1360, height: 860 }, deviceScaleFactor: 2, colorScheme: s.dark ? 'dark' : 'light', isMobile: !!s.mobile, hasTouch: !!s.mobile });
    await installCdnStubs(context);
    if (!s.anon) await context.addCookies([{ name: 'mdshare_auth', value: cookie.split('=')[1], url: srv.url }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${s.name}: console ${m.text()}`); });
    await page.goto(srv.url + s.url, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    if (s.scrollTo) { await page.evaluate((sel) => { const el = document.querySelector('#content ' + sel) || document.querySelectorAll('#content h2')[1]; if (el) window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 90); }, s.scrollTo); await page.waitForTimeout(900); }
    if (s.click) { await page.click(s.click); await page.waitForTimeout(400); }
    if (s.clickAll) { const els = await page.$$(s.clickAll); for (const e of els.slice(0, 2)) await e.click({ force: true }); await page.waitForTimeout(400); }
    if (s.full) { await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); }); await page.waitForTimeout(700); }
    await page.screenshot({ path: path.join(out, `${s.name}.png`), fullPage: !!s.full });
    await context.close();
    console.log('shot', s.name);
  }
} finally {
  await browser.close(); await srv.close(); await sb.close();
}
if (errors.length) { console.log('JS ERRORS:\n' + errors.join('\n')); process.exitCode = 1; } else console.log('no JS errors');
