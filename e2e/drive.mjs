#!/usr/bin/env node
// e2e/drive.mjs — ad-hoc agent driver CLI.
//
//   node e2e/drive.mjs open <path> [--as owner|anon] [--seed paste:'<markdown>']
//                       [--screenshot <file>] [--snapshot] [--root <path>]
//
// Starts the fake-Supabase + local emulator stack, optionally seeds one row, opens a path as
// either the owner or an anonymous visitor, optionally prints a text snapshot of the page, saves
// a screenshot if requested, then shuts everything down. Meant for an agent (or a human) to
// quickly check its own UI work against this app without re-deriving the whole harness each time.
//
// Examples:
//   node e2e/drive.mjs open / --screenshot /tmp/home.png
//   node e2e/drive.mjs open /v/abc123 --as owner --snapshot
//   node e2e/drive.mjs open /v/NEW --as owner --seed "paste:# Hello\n\nWorld" --screenshot /tmp/p.png
import { ensureNoProxyEnv } from './_proxy-guard.mjs';
await ensureNoProxyEnv();

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startServer } from './server.mjs';
import { installCdnStubs } from './_cdn-stubs.mjs';

const OWNER_PASSWORD = 'e2e-test-password';
const E2E_DIR = path.resolve(new URL('.', import.meta.url).pathname);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

function usage() {
  console.error(`Usage: node e2e/drive.mjs open <path> [--as owner|anon] [--seed <kind>:'<content>']
                      [--screenshot <file>] [--snapshot] [--root <path>]

  <path>              a site path, e.g. /v/abc123, /, /dashboard
  --as owner|anon      which identity to view the page as (default: anon)
  --seed kind:content  seed one row before opening; kind is paste|diagram|archify
                        (paste: content is markdown. diagram: content is raw SVG.
                         archify: content is markdown, wrapped in a minimal archify HTML doc.)
                        If <path> contains the literal id "NEW", it's replaced with the seeded id.
  --screenshot <file>  save a PNG screenshot to this path
  --snapshot           print a text snapshot of the page body to stdout
  --root <path>        app repo root to load api/+public/ from (default: this repo)
`);
}

async function seedOne(serverUrl, kindSpec) {
  const sep = kindSpec.indexOf(':');
  if (sep < 0) throw new Error(`--seed must look like "kind:content", got "${kindSpec}"`);
  const kind = kindSpec.slice(0, sep);
  const content = kindSpec.slice(sep + 1);

  if (kind === 'paste') {
    const r = await fetch(`${serverUrl}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: content }),
    });
    if (!r.ok) throw new Error(`seed paste failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
  if (kind === 'diagram') {
    const r = await fetch(`${serverUrl}/api/diagram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg: content, title: 'drive.mjs seed' }),
    });
    if (!r.ok) throw new Error(`seed diagram failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
  if (kind === 'archify') {
    const html = `<!DOCTYPE html><html><head></head><body><svg xmlns="http://www.w3.org/2000/svg"></svg><div>${content}</div></body></html>`;
    const r = await fetch(`${serverUrl}/api/archify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'architecture', html, markdown: content, title: 'drive.mjs seed' }),
    });
    if (!r.ok) throw new Error(`seed archify failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
  throw new Error(`unknown --seed kind "${kind}" (expected paste|diagram|archify)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const targetPath = args._[1];
  if (command !== 'open' || !targetPath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const appRoot = args.root ? path.resolve(args.root) : path.resolve(path.join(E2E_DIR, '..'));
  const as = args.as === 'owner' ? 'owner' : 'anon';

  const sb = await startFakeSupabase({});
  const srv = await startServer({ root: appRoot, supabaseUrl: sb.url });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--no-sandbox'],
  });

  try {
    let resolvedPath = targetPath;
    if (args.seed) {
      const seeded = await seedOne(srv.url, args.seed);
      resolvedPath = resolvedPath.replace('NEW', seeded.id);
      console.error(`seeded ${args.seed.split(':')[0]} id=${seeded.id}`);
    }

    const context = await browser.newContext();
    await installCdnStubs(context);

    if (as === 'owner') {
      const r = await fetch(`${srv.url}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: OWNER_PASSWORD }),
      });
      if (!r.ok) throw new Error(`owner login failed: ${r.status}`);
      const setCookie = r.headers.get('set-cookie');
      const eq = setCookie.indexOf('=');
      const semi = setCookie.indexOf(';');
      await context.addCookies([{ name: setCookie.slice(0, eq), value: setCookie.slice(eq + 1, semi), url: srv.url }]);
    }

    const page = await context.newPage();
    const url = `${srv.url}${resolvedPath}`;
    console.error(`opening ${url} as ${as}`);
    await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch((err) => {
      console.error(`navigation warning: ${err.message}`);
    });

    if (args.snapshot) {
      const title = await page.title().catch(() => '');
      const bodyText = await page.innerText('body').catch(() => '(no body text)');
      console.log(`--- title ---\n${title}`);
      console.log(`--- body text snapshot ---\n${bodyText}`);
      try {
        const a11y = await page.accessibility.snapshot();
        console.log(`--- accessibility snapshot ---\n${JSON.stringify(a11y, null, 2)}`);
      } catch {
        // Not available on every playwright-core build; text snapshot above already covers it.
      }
    }

    if (args.screenshot) {
      const screenshotPath = path.resolve(String(args.screenshot));
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`screenshot saved: ${screenshotPath}`);
    }

    await context.close();
  } finally {
    await browser.close();
    await srv.close();
    await sb.close();
  }
}

await main();
