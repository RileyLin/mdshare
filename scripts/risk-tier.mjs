#!/usr/bin/env node
// Labels a change's risk: "owner" (sensitive) or "auto" (normal). CI records it on the PR and
// in the run summary. It no longer blocks anything: everything ships on green, and a change
// waits for Riley only when he asks for it (see the gate step in .github/workflows/ci.yml).
// Agents use a sensitive label as the cue for an adversarial review before pushing.
//
//   node scripts/risk-tier.mjs <base-ref> <head-ref>      -> prints {"tier", "reasons", "files"}
//
// "owner" when the change touches anything that decides who can see what, the checks
// themselves, routes, dependencies or the database, or when it removes or rewrites lines in the
// tests (the easiest way for an agent to make a red build green). Everything else is "auto".
// This file is itself in the sensitive list, so loosening it needs approval too.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

export const SENSITIVE = [
  [/^\.github\//, 'CI / release pipeline'],
  [/^\.githooks\//, 'local git hooks'],
  [/^scripts\//, 'repo checks and release scripts'],
  [/^eslint\.config\.js$/, 'lint rules'],
  [/^package(-lock)?\.json$/, 'dependencies or npm scripts'],
  [/^migrations\//, 'database schema'],
  [/^vercel\.json$/, 'routes'],
  [/^api\/auth\.js$/, 'login, sessions, tokens'],
  [/^api\/_lib\/(access|agent-tokens|content|events)\.js$/, 'visibility, tokens, keep or error logging'],
  [/^api\/pin\.js$/, 'public/private and keep'],
  [/^api\/health\.js$/, 'monitoring endpoint'],
  [/^api\/archify-(html|render)\.js$/, 'archify sandbox'],
];
const TEST_PATH = /^(tests\/|e2e\/(?!proof\/))/;

// git already prints normalised paths; normalise anyway so "./api/auth.js" can't slip past.
const norm = (p) => posix.normalize(String(p)).replace(/^(\.\/)+/, '');

export function classify(files) {
  const reasons = [];
  for (const raw of files) {
    const f = { ...raw, path: norm(raw.path) };
    const hit = SENSITIVE.find(([re]) => re.test(f.path));
    if (hit) reasons.push(`${f.path}: ${hit[1]}`);
    else if (TEST_PATH.test(f.path) && f.deleted > 0) reasons.push(`${f.path}: removes or rewrites ${f.deleted} line(s) of tests`);
    else if (/^api\//.test(f.path) && f.status === 'A') reasons.push(`${f.path}: new server file (new endpoint or shared server logic)`);
    else if (/^(api|tests|e2e)\//.test(f.path) && f.status === 'D') reasons.push(`${f.path}: deletes a server or test file`);
  }
  return { tier: reasons.length ? 'owner' : 'auto', reasons };
}

// --no-renames: a rename shows up as a delete of the old path plus an add of the new one, so a
// sensitive file moved somewhere innocuous is still caught by its old path.
export function changedFiles(base, head) {
  const range = `${base}...${head}`;
  const status = Object.fromEntries(execFileSync('git', ['diff', '--name-status', '--no-renames', range], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => { const [s, p] = l.split('\t'); return [p, s[0]]; }));
  return execFileSync('git', ['diff', '--numstat', '--no-renames', range], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => {
    const [a, d, p] = l.split('\t');
    return { path: p, added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d), status: status[p] || 'M' };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2);
  const files = changedFiles(base, head);
  const result = { ...classify(files), files: files.map((f) => f.path) };
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tier=${result.tier}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Risk tier: ${result.tier === 'owner' ? 'needs owner approval' : 'ships automatically'}\n\n${result.reasons.map((r) => `- ${r}`).join('\n') || '- no sensitive paths, no test lines removed'}\n`);
  }
}
