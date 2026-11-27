#!/usr/bin/env node
// e2e/compare-docs.mjs — run real documents through the old (?classic=1) and new reader.
//
//   node e2e/compare-docs.mjs --dir <folder of .md files> [--out <dir>] [--shots name1,name2]
//
// For each file: same readable text (colons aside, see run.mjs text-equivalence), same tables,
// rows, code blocks, images, list items and links, no JS errors; plus which automatic rules
// fired. Writes report.json (and optional screenshots) to --out. Point it at private documents
// kept OUTSIDE this public repo; nothing from them is committed.
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
const dir = arg('dir');
if (!dir) { console.error('--dir is required'); process.exit(2); }
const out = path.resolve(arg('out', path.join(E2E_DIR, 'proof', 'compare')));
const shots = new Set((arg('shots', '') || '').split(',').filter(Boolean));
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

const sb = await startFakeSupabase({});
const srv = await startServer({ root: path.join(E2E_DIR, '..'), supabaseUrl: sb.url });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  const login = await fetch(`${srv.url}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'e2e-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  await installCdnStubs(context);
  await context.addCookies([{ name: 'mdshare_auth', value: cookie.split('=')[1], url: srv.url }]);
  for (const f of files) {
    try { await compareOne(f); } catch (e) { results.push({ file: f, error: String(e.message || e).split('\n')[0] }); console.log(`ERROR ${f}: ${String(e.message || e).split('\n')[0]}`); }
  }
  async function compareOne(f) {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    if (md.length > 100000) { results.push({ file: f, skipped: 'over 100 KB API limit' }); return; }
    const created = await (await fetch(`${srv.url}/api/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ markdown: md }) })).json();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const grab = (fresh) => page.evaluate((isNew) => {
      const c = document.getElementById('content').cloneNode(true);
      // A diagram is a picture, not text: both readers draw it (the new one with vendored
      // mermaid), so compare the number of diagrams, not the svg's text and inline styles.
      const diagrams = c.querySelectorAll('.mermaid, pre > code.language-mermaid').length;
      c.querySelectorAll('.mermaid, pre:has(> code.language-mermaid)').forEach((m) => m.replaceWith(document.createTextNode('[diagram]')));
      if (isNew) c.querySelectorAll('.doc-meta, .toc-mobile, .anchor, .code-head, .table-tools').forEach((e) => e.remove());
      const links = [...c.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).sort();
      return {
        text: c.textContent.replace(/\s+/g, '').replace(/[：:]/g, ''),
        counts: [diagrams, c.querySelectorAll('table').length, c.querySelectorAll('tr').length, c.querySelectorAll('pre').length, c.querySelectorAll('img').length, c.querySelectorAll('li').length],
        links,
        rules: isNew ? {
          summary: c.querySelectorAll('.md-summary').length, subheads: c.querySelectorAll('h4.md-sub').length, steps: c.querySelectorAll('ol.md-steps').length,
          keys: c.querySelectorAll('ul.md-keys').length, callouts: c.querySelectorAll('.md-callout').length, numCells: c.querySelectorAll('td.num').length,
          tinted: c.querySelectorAll('td.t-ok, td.t-bad, td.t-warn').length, toc: document.querySelectorAll('#toc a').length,
          glossary: c.querySelectorAll('.md-glossary').length, terms: c.querySelectorAll('.md-term').length, recap: c.querySelectorAll('.md-recap').length, reveal: c.querySelectorAll('.md-reveal').length,
        } : null,
      };
    }, fresh);
    await page.goto(`${srv.url}/v/${created.id}?classic=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('content')?.textContent !== 'Loading…', null, { timeout: 8000 });
    const oldV = await grab(false);
    await page.goto(`${srv.url}/v/${created.id}`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const c = document.getElementById('content'); return c && !c.querySelector('noscript') && c.children.length > 0; }, null, { timeout: 8000 });
    await page.waitForTimeout(150);
    const newV = await grab(true);
    let at = 0; while (at < oldV.text.length && oldV.text[at] === newV.text[at]) at++;
    const sameText = oldV.text === newV.text;
    const sameCounts = JSON.stringify(oldV.counts) === JSON.stringify(newV.counts);
    const sameLinks = JSON.stringify(oldV.links) === JSON.stringify(newV.links);
    results.push({ file: f, chars: oldV.text.length, sameText, sameCounts, sameLinks, errors, rules: newV.rules, ...(sameText ? {} : { diffAt: at, old: oldV.text.slice(Math.max(0, at - 20), at + 20), new: newV.text.slice(Math.max(0, at - 20), at + 20) }), ...(sameCounts ? {} : { oldCounts: oldV.counts, newCounts: newV.counts }) });
    const tag = sameText && sameCounts && sameLinks && !errors.length ? 'SAME' : 'DIFF';
    console.log(`${tag} ${f} (${oldV.text.length} chars) rules=${JSON.stringify(newV.rules)}${errors.length ? ' JS ERRORS ' + errors.join(' | ') : ''}${sameText ? '' : `\n   text differs at ${at}: old "${oldV.text.slice(Math.max(0, at - 20), at + 20)}" | new "${newV.text.slice(Math.max(0, at - 20), at + 20)}"`}${sameCounts ? '' : `\n   counts ${JSON.stringify(oldV.counts)} vs ${JSON.stringify(newV.counts)}`}${sameLinks ? '' : '\n   links differ'}`);
    if (shots.has(f)) {
      await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(out, f.replace(/\.md$/, '') + '.new.png') });
      await page.goto(`${srv.url}/v/${created.id}?classic=1`, { waitUntil: 'load' }); await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(out, f.replace(/\.md$/, '') + '.old.png') });
    }
    await page.close();
  }
} finally {
  await browser.close(); await srv.close(); await sb.close();
}
const bad = results.filter((r) => !r.skipped && !(r.sameText && r.sameCounts && r.sameLinks && r.errors && !r.errors.length));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, identical: results.length - bad.length - results.filter((r) => r.skipped).length, results }, null, 2));
console.log(`\n${results.length - bad.length}/${results.length} documents identical in content`);
process.exitCode = bad.length ? 1 : 0;
