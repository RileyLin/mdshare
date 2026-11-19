#!/usr/bin/env node
// Deterministic repo invariants. Each check encodes a mistake that already happened (or a
// security property CLAUDE.md used to ask agents to remember). When review catches a new
// recurring mistake, add a check here instead of another paragraph of prose.
// Usage: node scripts/check-invariants.mjs [--root <dir>]   (exit 1 on any violation)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argRoot = process.argv.indexOf('--root');
const ROOT = argRoot > -1 ? process.argv[argRoot + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => existsSync(join(ROOT, p));
const lines = (p) => read(p).split('\n');
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

function walk(dir, filter) {
  const out = [];
  if (!exists(dir)) return out;
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel, filter));
    else if (filter(rel)) out.push(rel);
  }
  return out;
}

const apiTopLevel = () => readdirSync(join(ROOT, 'api')).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort();
const apiFiles = () => walk('api', (f) => f.endsWith('.js'));

// Content routes: each one returns stored content and must gate it and keep it out of caches.
const CONTENT_ROUTES = ['api/render.js', 'api/diagram-render.js', 'api/archify-render.js', 'api/share.js', 'api/diagram.js', 'api/archify.js'];
const CREATE_ROUTES = ['api/share.js', 'api/diagram.js', 'api/archify.js'];

const checks = [
  {
    id: 'function-cap',
    why: 'Vercel Hobby fails the whole production build at 13 functions (happened 2026-09; fixed by merging visibility into pin.js, 0068952).',
    run() {
      const fns = apiTopLevel();
      return fns.length > 12
        ? [`api/ has ${fns.length} top-level functions (max 12): ${fns.join(', ')}. Merge the new endpoint into an existing handler (dispatch on a request field) or move helpers under api/_lib/.`]
        : [];
    },
  },
  {
    id: 'rewrites',
    why: 'vercel.json rewrites must point at real functions and each pretty path must be declared once.',
    run() {
      const v = JSON.parse(read('vercel.json'));
      const errs = [];
      const seen = new Set();
      for (const r of v.rewrites || []) {
        if (seen.has(r.source)) errs.push(`vercel.json: duplicate rewrite source "${r.source}" — delete the extra entry.`);
        seen.add(r.source);
        const m = /^\/api\/([^?/]+)/.exec(r.destination);
        if (m && !exists(`api/${m[1]}.js`)) errs.push(`vercel.json: "${r.source}" -> ${r.destination} but api/${m[1]}.js does not exist.`);
      }
      return errs;
    },
  },
  {
    id: 'migrations-additive',
    why: 'Migrations are applied by hand and may be rerun; a backfill UPDATE silently reset owner choices on rerun (fixed in 2cf0397).',
    run() {
      const errs = [];
      const bad = /\b(UPDATE\s+\w+|DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|TYPE|FUNCTION))\b/i;
      for (const f of walk('migrations', (p) => p.endsWith('.sql'))) {
        lines(f).forEach((l, i) => {
          const code = l.replace(/--.*$/, '');
          if (bad.test(code) && !/--\s*invariant-allow:\s*\S/.test(l)) {
            errs.push(`${f}:${i + 1}: destructive statement in a migration: "${l.trim()}". Make it additive (ADD COLUMN ... DEFAULT already backfills once) or mark the line "-- invariant-allow: <reason>" after the owner agrees.`);
          }
        });
      }
      return errs;
    },
  },
  {
    id: 'private-by-default',
    why: 'Creation routes must always insert is_public: false and never read visibility from the request body; only the auth-gated pin.js toggle may flip it.',
    run() {
      const errs = [];
      for (const f of CREATE_ROUTES) {
        const src = read(f);
        if (!/is_public:\s*false/.test(src)) errs.push(`${f}: create payload must set is_public: false explicitly.`);
        lines(f).forEach((l, i) => {
          if (isCommentLine(l)) return;
          if (/\bbody\??\.is_public\b|\bis_public\s*:\s*(?!false\b)[^\s,}]/.test(l) || /\.\.\.\s*(req\.)?body\b/.test(l)) {
            errs.push(`${f}:${i + 1}: visibility must not come from the request ("${l.trim()}"). Build an explicit field list with is_public: false; publishing goes through PATCH /api/pin.`);
          }
        });
      }
      return errs;
    },
  },
  {
    id: 'content-route-gating',
    why: 'Every content route checks isVisible() (fail closed) and sets private, no-store headers so a cache never leaks private content or stale visibility.',
    run() {
      const errs = [];
      for (const f of CONTENT_ROUTES) {
        const src = read(f);
        if (!/\bisVisible\(/.test(src)) errs.push(`${f}: content route must call isVisible(row, req) before returning content.`);
        if (!/\bsetPrivacyHeaders\(res\)/.test(src)) errs.push(`${f}: content route must call setPrivacyHeaders(res) (private, no-store; noindex; no-referrer).`);
      }
      const html = read('api/archify-html.js');
      if (!/Cache-Control['"],\s*['"]private, no-store/.test(html)) errs.push('api/archify-html.js: must send Cache-Control: private, no-store.');
      if (!/\bisVisible\(/.test(html)) errs.push('api/archify-html.js: must call isVisible(row, req) before serving stored HTML.');
      return errs;
    },
  },
  {
    id: 'postgrest-id-encoding',
    why: 'Row ids are interpolated into PostgREST filter strings; unencoded input enables filter injection.',
    run() {
      const errs = [];
      for (const f of apiFiles()) {
        lines(f).forEach((l, i) => {
          if (/=(eq|neq|ilike|like)\.\$\{(?!encodeURIComponent\()/.test(l)) {
            errs.push(`${f}:${i + 1}: wrap interpolated filter values in encodeURIComponent() after isValidId(): "${l.trim()}"`);
          }
        });
      }
      return errs;
    },
  },
  {
    id: 'archify-sandbox',
    why: 'Stored archify HTML is attacker-controlled; allow-scripts + allow-same-origin would give it the real origin\'s cookies and APIs.',
    run() {
      const errs = [];
      for (const f of apiFiles()) {
        for (const m of read(f).matchAll(/sandbox="([^"]*)"/g)) {
          if (/allow-same-origin/.test(m[1])) errs.push(`${f}: iframe sandbox="${m[1]}" must not include allow-same-origin.`);
        }
      }
      if (!/sandbox="allow-scripts"/.test(read('api/archify-render.js'))) errs.push('api/archify-render.js: archify iframe must use sandbox="allow-scripts".');
      return errs;
    },
  },
  {
    id: 'timers-unref',
    why: 'Module-level setInterval handles kept the test process alive; tests needed --test-force-exit until 2026-11-19.',
    run() {
      const errs = [];
      for (const f of apiFiles()) {
        const src = read(f);
        const timers = (src.match(/\bsetInterval\(/g) || []).length;
        const unrefs = (src.match(/\.unref\??\.?\(\)/g) || []).length;
        if (timers > unrefs) errs.push(`${f}: ${timers} setInterval() but ${unrefs} .unref() — keep the handle and call handle.unref?.() so serverless/test processes can exit.`);
      }
      return errs;
    },
  },
  {
    id: 'no-secrets',
    why: 'The GitHub repo is public.',
    run() {
      const errs = [];
      const patterns = [
        /ghp_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /vcp_[A-Za-z0-9]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/,
        /AKIA[0-9A-Z]{16}/, /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      ];
      let files;
      try { files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean); }
      catch { files = walk('.', () => true); }
      for (const f of files) {
        if (f === 'package-lock.json' || f.endsWith('.png') || !existsSync(join(ROOT, f))) continue;
        const src = readFileSync(join(ROOT, f), 'utf8');
        for (const p of patterns) if (p.test(src)) errs.push(`${f}: looks like a credential (${p.source.slice(0, 16)}…). Remove it and rotate the key.`);
      }
      return errs;
    },
  },
  {
    id: 'root-markdown',
    why: 'Stale agent plan/result docs get copied as "established patterns" (Lauren Tan, "stop agents from writing unsolicited Markdown").',
    run() {
      const allowed = new Set(['README.md', 'CLAUDE.md']);
      const extra = readdirSync(ROOT).filter((f) => f.endsWith('.md') && !allowed.has(f));
      return extra.length ? [`root has unexpected Markdown: ${extra.join(', ')}. Put finished plans/results in docs/history/ or outside the repo.`] : [];
    },
  },
  {
    id: 'claude-md-size',
    why: 'Prose is the least reliable layer; rules that can be checks belong in this file or eslint.config.js.',
    run() {
      const src = read('CLAUDE.md');
      const n = src.split('\n').length;
      return n > 90 || src.length > 7000
        ? [`CLAUDE.md is ${n} lines / ${src.length} chars (max 90 / 7000). Move history to docs/history/ and turn enforceable rules into checks.`]
        : [];
    },
  },
];

let failed = 0;
for (const c of checks) {
  let errs;
  try { errs = c.run(); } catch (e) { errs = [`check crashed: ${e.message}`]; }
  if (errs.length) {
    failed += errs.length;
    console.log(`✗ ${c.id} — ${c.why}`);
    for (const e of errs) console.log(`    ${e}`);
  } else {
    console.log(`✓ ${c.id}`);
  }
}
console.log(failed ? `\n${failed} invariant violation(s) in ${relative(process.cwd(), ROOT) || '.'}` : `\nall ${checks.length} invariants hold`);
process.exit(failed ? 1 : 0);
