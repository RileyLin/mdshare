#!/usr/bin/env node
// Decides whether a change may ship on green checks alone ("auto") or needs the owner's
// approval first ("owner"). CI runs it on every agent/* push; the promote job then uses the
// GitHub environment of the same name (owner-approval requires Riley to click Approve).
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

export function classify(files) {
  const reasons = [];
  for (const f of files) {
    const hit = SENSITIVE.find(([re]) => re.test(f.path));
    if (hit) reasons.push(`${f.path}: ${hit[1]}`);
    else if (TEST_PATH.test(f.path) && f.deleted > 0) reasons.push(`${f.path}: removes or rewrites ${f.deleted} line(s) of tests`);
  }
  return { tier: reasons.length ? 'owner' : 'auto', reasons };
}

export function changedFiles(base, head) {
  const out = execFileSync('git', ['diff', '--numstat', '--no-renames', `${base}...${head}`], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((l) => {
    const [a, d, p] = l.split('\t');
    return { path: p, added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) };
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
