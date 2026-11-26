#!/usr/bin/env node
// e2e/release-check.mjs — checks a LIVE deployment (production by default).
//
//   node e2e/release-check.mjs --url https://... [--mode release|monitor] [--expect-commit <sha>]
//                              [--seed N] [--out dir]
//
// release: runs right after CI promotes a commit. Waits until /api/health reports that commit,
//          then checks pages, gates, a real private create, renderer fuzzing with a fresh random
//          seed, random clicks, and new server errors since the release. Exit 1 -> CI rolls back.
// monitor: runs every 30 minutes. Same checks without creating anything, plus the error log
//          (MDSHARE_MONITOR_KEY): any server error or more than 5 client errors in the window fails.
// Optional MDSHARE_CANARY_TOKEN (documents:write + documents:publish) adds publish/unpublish of a
// throwaway private document through the API.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { makeDocs, checkInPage, monkey } from './fuzz.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i > -1 ? args[i + 1] : d; };
const BASE = (arg('url', 'https://mdshare-rileylins-projects.vercel.app')).replace(/\/$/, '');
const MODE = arg('mode', 'monitor');
const EXPECT = (arg('expect-commit', '') || '').slice(0, 12);
const SEED = Number(arg('seed', String(Math.floor(Math.random() * 1e9))));
const OUT = path.resolve(arg('out', 'e2e/proof/release'));
const KEY = process.env.MDSHARE_MONITOR_KEY || '';
const CANARY = process.env.MDSHARE_CANARY_TOKEN || '';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p, opts = {}) {
  const r = await fetch(BASE + p, { redirect: 'manual', ...opts });
  return { status: r.status, type: r.headers.get('content-type') || '', headers: r.headers, text: await r.text() };
}
const startedAt = new Date();

// 1. The right commit is live and the database answers.
let health;
const deadline = Date.now() + (MODE === 'release' ? 8 * 60 * 1000 : 0);
for (;;) {
  try { const h = await get('/api/health'); health = { status: h.status, ...JSON.parse(h.text) }; } catch (e) { health = { error: e.message }; }
  if (!EXPECT || (health.commit && EXPECT.startsWith(health.commit.slice(0, 7))) || Date.now() > deadline) break;
  await sleep(10000);
}
check('health: database reachable', health && health.ok === true && health.db === 'ok', JSON.stringify(health));
if (EXPECT) check('health: the released commit is live', health && health.commit && EXPECT.startsWith(health.commit.slice(0, 7)), `expected ${EXPECT}, live ${health && health.commit}`);

// 2. Public pages and assets.
for (const [p, marker, type] of [
  ['/', 'Long answers', 'text/html'], ['/guide', 'Formatting guide', 'text/html'], ['/guide.md', '# Formatting guide', 'markdown'],
  ['/llms.txt', 'guide for AI agents', 'text/plain'], ['/assets/render.js', 'Retrofit contract', 'javascript'], ['/assets/app.js', 'MDShareState', 'javascript'],
  ['/assets/errors.js', 'client_error', 'javascript'], ['/assets/mdshare.css', 'design system', 'css'], ['/vendor/marked-12.0.2.min.js', 'marked v12.0.2', 'javascript'],
  ['/vendor/purify-3.4.18.min.js', 'DOMPurify', 'javascript'],
]) {
  const r = await get(p).catch((e) => ({ status: 0, text: e.message, type: '' }));
  check(`page ${p}`, r.status === 200 && r.text.includes(marker) && r.type.includes(type), `status ${r.status}`);
}

// Rollback rehearsal: shipping public/release-drill.txt containing "fail" makes this check fail on
// purpose, so the automatic rollback can be exercised for real. Absent in normal releases.
{
  const d = await get('/release-drill.txt').catch(() => ({ status: 0, text: '' }));
  check('rollback drill marker absent', !(d.status === 200 && /fail/i.test(d.text)), d.status === 200 ? 'drill marker deployed' : '');
}

// 3. Gates and error pages.
for (const [p, status, marker] of [['/dashboard', 401, 'Welcome back'], ['/settings', 401, 'Welcome back'], ['/v/zzzzzzzzz0', 404, 'This link has expired'], ['/d/zzzzzzzzz0', 404, 'This link has expired'], ['/a/zzzzzzzzz0', 404, 'This link has expired'], ['/c', 401, 'This content is private'], ['/c/zzzzzzzzz0', 401, 'This content is private']]) {
  const r = await get(p);
  check(`gate ${p} -> ${status}`, r.status === status && r.text.includes(marker), `status ${r.status}`);
}

// Agent-facing failures explain themselves (2026-11-26): search needs a credential, and a token
// sent as x-api-key is told to use Authorization: Bearer in the refusal.
{
  const s = await get('/api/doc?action=search&q=' + encodeURIComponent('缓存命中'));
  check('gate search -> 401 Bearer challenge', s.status === 401 && /^Bearer/.test(s.headers.get('www-authenticate') || '') && !s.text.includes('"results"'), `status ${s.status}`);
  // Since 2026-11-26 a misplaced key only adds the hint to a refusal, so ask /raw (its 404 carries it).
  const k = await get('/raw/zzzzzzzzz0', { headers: { 'x-api-key': 'mds_release_check_not_a_token' } });
  check('agent hint: x-api-key on /raw/ gets the Bearer hint', k.status === 404 && /Send the token as Authorization: Bearer/.test(k.text) && k.headers.get('x-content-type-options') === 'nosniff', `status ${k.status}`);
}

// 4. A real private create (release only): stays private, raw is denied, content never leaks.
if (MODE === 'release') {
  const marker = `release-check-${Date.now().toString(36)}`;
  const c = await fetch(`${BASE}/api/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: `# Release check\n\n${marker}`, ttl: 3600, keep: true }) });
  const body = await c.json().catch(() => ({}));
  check('create: anonymous POST works, keep ignored', c.status === 200 && body.id && body.kept === false && /llms\.txt$/.test(body.format_guide || ''), `status ${c.status}`);
  if (body.id) {
    const v = await get(`/v/${body.id}`);
    check('create: new document is private (sign-in card, no content)', v.status === 401 && !v.text.includes(marker) && v.headers.get('cache-control') === 'private, no-store', `status ${v.status}`);
    const raw = await get(`/raw/${body.id}`);
    check('create: raw route denies anonymous reads', raw.status === 404 && !raw.text.includes(marker), `status ${raw.status}`);
  }
}

// 5. Optional canary token: publish and unpublish through the API.
if (CANARY) {
  const auth = { Authorization: 'Bear' + 'er ' + CANARY, 'Content-Type': 'application/json' };
  const marker = `canary-${Date.now().toString(36)}`;
  const c = await (await fetch(`${BASE}/api/share`, { method: 'POST', headers: auth, body: JSON.stringify({ markdown: `# Canary\n\n${marker}`, ttl: 3600 }) })).json().catch(() => ({}));
  const pub = await fetch(`${BASE}/api/pin`, { method: 'PATCH', headers: auth, body: JSON.stringify({ id: c.id, kind: 'paste', is_public: true }) });
  const seen = await get(`/v/${c.id}`);
  check('canary: token can publish; anyone can then read it', pub.ok && seen.status === 200 && seen.text.includes(marker), `publish ${pub.status}, view ${seen.status}`);
  const unpub = await fetch(`${BASE}/api/pin`, { method: 'PATCH', headers: auth, body: JSON.stringify({ id: c.id, kind: 'paste', is_public: false }) });
  const gone = await get(`/v/${c.id}`);
  check('canary: unpublishing gates it again', unpub.ok && gone.status === 401 && !gone.text.includes(marker), `unpublish ${unpub.status}, view ${gone.status}`);
}

// 6. Real browser: no JS errors, renderer fuzzing with a fresh seed, random clicks.
const proxy = process.env.RELEASE_CHECK_PROXY ? { server: process.env.RELEASE_CHECK_PROXY } : undefined;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'], proxy });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: !!proxy, viewport: { width: 1360, height: 860 } });
  const jsErrors = [];
  context.on('page', (p) => {
    p.on('pageerror', (e) => jsErrors.push(`${p.url()}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|status of 40[14]/.test(m.text())) jsErrors.push(`${p.url()}: ${m.text()}`); });
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 45000 });
  const stats = await page.locator('#preview .md-stat').count();
  check('browser: home renders its live preview', stats === 4, `${stats} number cards`);
  const fz = await page.evaluate(checkInPage, makeDocs(SEED, 200));
  check(`browser: fuzz ${fz.checked} random documents on the live renderer (seed ${SEED})`, fz.failures.length === 0, fz.failures.length ? `${fz.failures.length} failed; first #${fz.failures[0].index}: ${fz.failures[0].problem}` : `slowest ${fz.slowestMs}ms`);
  const clicks1 = await monkey(page, { steps: 20, seed: SEED, origin: BASE });
  await page.goto(`${BASE}/guide`, { waitUntil: 'networkidle', timeout: 45000 });
  const guideOk = await page.locator('#content .md-stats').count();
  const clicks2 = await monkey(page, { steps: 20, seed: SEED + 1, origin: BASE });
  check('browser: guide renders every block', guideOk === 1, `${guideOk} stats blocks`);
  check('browser: no JS errors across pages and random clicks', jsErrors.length === 0, jsErrors.length ? jsErrors.slice(0, 3).join(' | ') : `${clicks1 + clicks2} random actions`);
  await page.screenshot({ path: path.join(OUT, 'guide.png') });
} finally {
  await browser.close();
}

// 7. The error log.
if (KEY) {
  const minutes = MODE === 'release' ? Math.max(5, Math.ceil((Date.now() - startedAt) / 60000) + 2) : 35;
  const r = await get(`/api/health?events=1&since=${minutes}`, { headers: { 'x-monitor-key': KEY } });
  let ev = {}; try { ev = JSON.parse(r.text); } catch { /* reported below */ }
  const server = (ev.counts && ev.counts.server_error) || 0, client = (ev.counts && ev.counts.client_error) || 0;
  check(`errors: no server errors in the last ${minutes} min`, r.status === 200 && server === 0, r.status !== 200 ? `status ${r.status}` : `${server} server errors${ev.top && ev.top.length ? `; top: ${ev.top[0].m}` : ''}`);
  check(`errors: at most 5 browser errors in the last ${minutes} min`, r.status === 200 && client <= 5, `${client} client errors`);
} else {
  check('errors: monitor key present', MODE !== 'monitor', 'MDSHARE_MONITOR_KEY not set; error log not checked');
}

const failed = results.filter((r) => !r.pass);
const report = { url: BASE, mode: MODE, seed: SEED, expectCommit: EXPECT || null, liveCommit: health && health.commit, at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const md = `### ${MODE === 'release' ? 'Release check' : 'Production monitor'}: ${failed.length ? `${failed.length} failed` : 'all passed'}\n\nLive commit \`${report.liveCommit}\`, fuzz seed ${SEED}\n\n${results.map((r) => `- ${r.pass ? '✅' : '❌'} ${r.name}${r.detail && !r.pass ? ` — ${r.detail}` : ''}`).join('\n')}\n`;
fs.writeFileSync(path.join(OUT, 'summary.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(`\n${report.passed}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
