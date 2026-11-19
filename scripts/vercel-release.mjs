#!/usr/bin/env node
// Production deployment control for the release job. Talks to the Vercel REST API.
//
//   node scripts/vercel-release.mjs ensure-live <sha>   wait for the production deployment of <sha> to be
//                                                        READY; promote it if it isn't serving (after a
//                                                        rollback Vercel stops auto-promoting); wait until
//                                                        /api/health reports <sha>.
//   node scripts/vercel-release.mjs rollback <sha>      point production back at the newest READY production
//                                                        deployment of a different commit, then wait for it.
//
// Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID, SITE_URL. Prints one JSON line on success.
const { VERCEL_TOKEN, VERCEL_PROJECT_ID: PROJECT, VERCEL_TEAM_ID: TEAM, SITE_URL = 'https://mdshare-rileylins-projects.vercel.app' } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function vercel(method, path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`https://api.vercel.com${path}${sep}teamId=${TEAM}`, { method, headers: { Authorization: 'Bear' + 'er ' + VERCEL_TOKEN, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const productionDeployments = async () => (await vercel('GET', `/v6/deployments?projectId=${PROJECT}&target=production&limit=20`)).deployments || [];
const shaOf = (d) => (d.meta && d.meta.githubCommitSha) || '';

async function liveCommit() {
  try { return (await (await fetch(`${SITE_URL}/api/health`, { cache: 'no-store' })).json()).commit || ''; } catch { return ''; }
}
async function waitLive(sha, minutes) {
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    if ((await liveCommit()).length && sha.startsWith((await liveCommit()).slice(0, 7))) return true;
    await sleep(8000);
  }
  return false;
}

async function ensureLive(sha) {
  const until = Date.now() + 10 * 60000;
  let dep;
  while (Date.now() < until) {
    dep = (await productionDeployments()).find((d) => shaOf(d) === sha);
    if (dep && ['READY', 'ERROR', 'CANCELED'].includes(dep.state || dep.readyState)) break;
    await sleep(10000);
  }
  if (!dep) throw new Error(`no production deployment for ${sha} after 10 minutes`);
  if ((dep.state || dep.readyState) !== 'READY') throw new Error(`deployment ${dep.uid} for ${sha} is ${dep.state || dep.readyState}`);
  if (await waitLive(sha, 1.5)) return { live: sha, deployment: dep.uid, promoted: false };
  await vercel('POST', `/v10/projects/${PROJECT}/promote/${dep.uid}`);
  if (!(await waitLive(sha, 4))) throw new Error(`promoted ${dep.uid} but /api/health still reports ${await liveCommit()}`);
  return { live: sha, deployment: dep.uid, promoted: true };
}

async function rollback(badSha) {
  const deps = (await productionDeployments()).filter((d) => (d.state || d.readyState) === 'READY');
  const bad = deps.find((d) => shaOf(d) === badSha);
  const target = deps.find((d) => shaOf(d) && shaOf(d) !== badSha && (!bad || d.created < bad.created));
  if (!target) throw new Error('no earlier READY production deployment to roll back to');
  await vercel('POST', `/v1/projects/${PROJECT}/rollback/${target.uid}?description=${encodeURIComponent(`release check failed for ${badSha.slice(0, 7)}`)}`);
  const ok = await waitLive(shaOf(target), 4);
  if (!ok) throw new Error(`rolled back to ${target.uid} but /api/health reports ${await liveCommit()}`);
  return { rolledBackTo: shaOf(target), deployment: target.uid, from: badSha };
}

const [cmd, sha] = process.argv.slice(2);
if (!VERCEL_TOKEN || !PROJECT || !TEAM || !sha || !['ensure-live', 'rollback'].includes(cmd)) {
  console.error('usage: VERCEL_TOKEN=.. VERCEL_PROJECT_ID=.. VERCEL_TEAM_ID=.. node scripts/vercel-release.mjs ensure-live|rollback <sha>');
  process.exit(2);
}
try {
  console.log(JSON.stringify(await (cmd === 'rollback' ? rollback(sha) : ensureLive(sha))));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
