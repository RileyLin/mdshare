#!/usr/bin/env node
// Production alerts as GitHub issues (GitHub emails the repo owner). One open issue per alert key;
// repeats become comments, recovery closes it.
//
//   node scripts/alert.mjs open <key> <title> <body-file>
//   node scripts/alert.mjs resolve <key> <message>
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo). Label: prod-alert:<key>.
import fs from 'node:fs';
const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
const [cmd, key, a, b] = process.argv.slice(2);
const label = `prod-alert:${key}`;
async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, { method, headers: { Authorization: 'Bear' + 'er ' + GITHUB_TOKEN, Accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok && r.status !== 422) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? {} : r.json();
}
const openIssues = async () => (await gh('GET', `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=10`)).filter((i) => !i.pull_request);
if (cmd === 'open') {
  const body = fs.existsSync(b) ? fs.readFileSync(b, 'utf8') : String(b || '');
  await gh('POST', '/labels', { name: label, color: 'b4532a' });
  const existing = await openIssues();
  if (existing.length) { await gh('POST', `/issues/${existing[0].number}/comments`, { body: `Still failing:\n\n${body}` }); console.log(`commented on #${existing[0].number}`); }
  else { const i = await gh('POST', '/issues', { title: a, body, labels: [label] }); console.log(`opened #${i.number}`); }
} else if (cmd === 'resolve') {
  for (const i of await openIssues()) { await gh('POST', `/issues/${i.number}/comments`, { body: a || 'Recovered.' }); await gh('PATCH', `/issues/${i.number}`, { state: 'closed' }); console.log(`closed #${i.number}`); }
} else { console.error('usage: alert.mjs open <key> <title> <body-file> | resolve <key> <message>'); process.exit(2); }
