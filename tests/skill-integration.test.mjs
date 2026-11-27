// Integration: the real OpenClaw skill script (skills/openclaw/mdshare/scripts/mdshare.mjs) run as a
// child process against the real api/*.js handlers behind the local e2e server (e2e/server.mjs) and
// the in-memory Supabase: signup -> publish (+ --public) -> read -> search -> link, then the
// account-splitting guard. tests/skill-mdshare.test.mjs covers the script against a fake API; this
// one proves the script and the server agree on the contract (PLAN.md "API contract").
//
// The child gets a clean environment: no proxy variables (this sandbox's egress proxy refuses
// loopback through Node's fetch; see e2e/_proxy-guard.mjs) and no MDSHARE_AGENT_TOKEN* (the guard
// would reuse an owner token instead of signing up). The server's own database calls go through
// tests/_fakedb.mjs's node:http fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFakeDb } from './_fakedb.mjs';
import { unwrapUntrusted } from '../skills/openclaw/mdshare/scripts/mdshare.mjs';

process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'skills', 'openclaw', 'mdshare', 'scripts', 'mdshare.mjs');

const db = await useFakeDb();
const { startServer } = await import('../e2e/server.mjs');
const srv = await startServer({ root: ROOT, supabaseUrl: db.sb.url });
const home = mkdtempSync(join(tmpdir(), 'mdshare-skill-it-'));
const tokenFile = join(home, 'state', 'mdshare-skill', 'token.json');
test.after(async () => { await srv.close(); await db.close(); rmSync(home, { recursive: true, force: true }); });

function skill(args, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: home, OPENCLAW_STATE_DIR: join(home, 'state'), MDSHARE_URL: srv.url, MDSHARE_SKILL_TOKEN_FILE: tokenFile, ...extraEnv };
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env, cwd: home, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
  });
}
const json = (r) => { assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr}`); return JSON.parse(r.stdout); };
// read/search output is wrapped as UNTRUSTED-CONTENT (ADV-MU-B 5); this is the data inside.
const inner = (r) => { assert.equal(r.code, 0, `exit ${r.code}\n${r.stderr}`); const t = unwrapUntrusted(r.stdout); assert.notEqual(t, null, `not wrapped:\n${r.stdout}`); return t; };

test('the skill script against the local server: signup, publish, publish --public, read, search, link', async () => {
  db.sb.reset();
  const signed = json(await skill(['signup', '--label', 'integration agent']));
  assert.equal(signed.ok, true);
  assert.equal(signed.skipped, false);
  assert.equal(signed.user_id, 2);
  assert.match(signed.entry_url, new RegExp(`^${srv.url.replace(/[.]/g, '\\.')}/enter#[A-Za-z0-9_-]{43}$`));
  assert.equal(signed.guide, `${srv.url}/llms.txt`);
  const saved = JSON.parse(readFileSync(tokenFile, 'utf8'));
  assert.match(saved.token, /^mds_/);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600, 'the token file is private');
  assert.ok(!JSON.stringify(signed).includes(saved.token), 'the token is never printed');
  assert.equal(db.sb.tables.mdshare_users.find((u) => u.id === 2).label, 'integration agent');

  const doc = join(home, 'reply.md');
  writeFileSync(doc, '# Integration reply\n\nThe zebra-quartz answer, long enough to publish.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  const pub = json(await skill(['publish', doc]));
  assert.match(pub.url, new RegExp(`^${srv.url.replace(/[.]/g, '\\.')}/v/${pub.id}$`));
  const row = db.sb.tables.mdshare_pastes.find((r) => r.id === pub.id);
  assert.deepEqual([row.owner_id, row.is_public, row.pinned], [2, false, true], "C's, private, kept");
  const open = json(await skill(['publish', doc, '--public']));
  assert.equal(open.is_public, true);
  assert.equal(db.sb.tables.mdshare_pastes.find((r) => r.id === open.id).is_public, true, '--public works with the sign-up token (documents:publish on its own document)');

  const read = await skill(['read', pub.id]);
  assert.match(read.stdout, /^<<<UNTRUSTED-CONTENT nonce=[0-9a-f]{16} source=mdshare:read:/);
  assert.match(inner(read), /^# Integration reply/);
  const found = JSON.parse(inner(await skill(['search', 'zebra-quartz'])));
  assert.deepEqual(found.results.map((r) => r.id).sort(), [pub.id, open.id].sort());
  assert.equal(found.total, 2);

  // link: a fresh entry link; the one from sign-up stops working.
  const linked = json(await skill(['link']));
  assert.notEqual(linked.entry_url, signed.entry_url);
  const enter = (url) => fetch(`${srv.url}/api/auth?action=enter`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: url.split('#')[1] }) });
  assert.equal((await enter(signed.entry_url)).status, 401, 'the old link fails');
  assert.equal((await enter(linked.entry_url)).status, 200, 'the new link signs in');

  // The owner's documents never show up for the skill's user.
  db.sb.seed('mdshare_pastes', { id: 'ownerZebra', owner_id: 1, title: 'owner zebra-quartz', content: 'owner zebra-quartz', expires_at: '2999-01-01T00:00:00Z' });
  assert.equal(JSON.parse(inner(await skill(['search', 'zebra-quartz']))).total, 2);
  const notMine = await skill(['read', 'ownerZebra']);
  assert.notEqual(notMine.code, 0);
  assert.doesNotMatch(notMine.stdout, /owner zebra-quartz/);
});

test('the skill never signs up twice: an existing token is reused (G6), and a disabled account is reported, not re-created', async () => {
  const again = json(await skill(['signup']));
  assert.deepEqual([again.skipped, again.source], [true, 'token_file']);
  assert.equal(db.sb.tables.mdshare_users.length, 2, 'still user #1 + one sign-up');
  const ownerTokenEnv = json(await skill(['signup'], { MDSHARE_AGENT_TOKEN: 'mds_owner_token_from_env_xxxxxxxxxxxxxxxxxxxxxx', MDSHARE_SKILL_TOKEN_FILE: join(home, 'none.json') }));
  assert.deepEqual([ownerTokenEnv.skipped, ownerTokenEnv.source], [true, 'MDSHARE_AGENT_TOKEN']);
  db.sb.tables.mdshare_users.find((u) => u.id === 2).disabled = true;
  const off = await skill(['search', 'zebra-quartz']);
  assert.notEqual(off.code, 0);
  assert.match(off.stderr, /unauthorized \(401\).*do not sign up again/);
  assert.equal(db.sb.tables.mdshare_users.length, 2);
});
