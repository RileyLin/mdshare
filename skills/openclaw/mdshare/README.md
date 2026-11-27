# mdshare — OpenClaw skill

Lets your OpenClaw agent turn a long reply (or one with a table or diagram) into a private web
page instead of a wall of text in chat, and send you the link.

## ⚠️ Not for the owner's own OpenClaw

This skill is for the mdshare **multi-user beta**: separate people/agents getting their own
mdshare accounts. Don't install it into an agent that already has the mdshare **owner's** own
token (for example, one set up with `MDSHARE_AGENT_TOKEN` / `MDSHARE_AGENT_TOKEN_FILE` for
`mcp/bin/mdshare-cli.mjs`). As a safety net the skill checks for an existing token first and
reuses it instead of signing up again, so even an accidental install can't split that account in
two — but the point of the beta is a separate account, so don't install it there on purpose.

## What it does

- The first time it's used, your agent checks whether it already has an mdshare token
  (`MDSHARE_AGENT_TOKEN`, `MDSHARE_AGENT_TOKEN_FILE`, or its own saved file). If not, it signs
  itself up for a free mdshare account (no invite code needed) and sends you a **private entry
  link** once. That link is your personal sign-in — keep it like a password.
- After that, whenever a reply would be long, or has a table or a diagram, the agent publishes
  it as a page and replies with just the link and a short summary.
- Pages are **private by default** — only you (via the entry link, or the agent via its saved
  token) can open them. The agent only makes a page public when you ask it to.

## Install

### Option A — ClawHub

```bash
openclaw skills install git:RileyLin/mdshare/skills/openclaw/mdshare
```

(or search/browse for `mdshare` on [ClawHub](https://clawhub.ai) once it's published there).

### Option B — copy the folder

Copy this directory into your OpenClaw workspace's skills folder:

```bash
cp -r skills/openclaw/mdshare ~/.openclaw/workspace/skills/mdshare
```

Then start a new chat session (or restart the gateway) so the agent picks up the new skill.
Requires Node.js 20 or newer on the machine running the agent — nothing else.

## What's sent where

- Only the Markdown text being published, plus an optional title, is sent to the mdshare
  server (`https://mdshare-rileylins-projects.vercel.app` by default). Nothing else about your
  conversation leaves the machine through this skill.
- Documents are private by default. A document only becomes public if the agent is explicitly
  asked to make it public — and even then, only that one document is affected.
- The agent's sign-up token is stored locally in a file only it reads
  (`~/.openclaw/mdshare-skill/token.json` by default, mode `600`). It is never shown in chat.

## Uninstall / delete your data

1. **Stop the skill from running:** delete the skill folder
   (`rm -rf ~/.openclaw/workspace/skills/mdshare`, or wherever you installed it) or disable it
   in your OpenClaw config.
2. **Remove the saved token:** delete
   `~/.openclaw/mdshare-skill/token.json` (or the path from
   `MDSHARE_SKILL_TOKEN_FILE` if you customized it). The agent can no longer publish or read
   anything with that token once it's gone.
3. **Delete documents on the server:** open your private entry link (the one the agent sent
   you) in a browser, sign in, and delete pages you no longer want from your mdshare library.
   Un-kept documents also expire on their own (24 hours by default, up to 7 days); only pages
   published with "keep" (which this skill uses by default) stick around until you delete them.
4. Lost your entry link? Ask the agent to run the skill's `link` command again — it issues a
   fresh one and invalidates the old one.

## Configuration (optional)

Environment variables, if you want to point the agent at a different mdshare server or token
location:

| Variable                   | Default                                           |
| --------------------------- | -------------------------------------------------- |
| `MDSHARE_URL`               | `https://mdshare-rileylins-projects.vercel.app`    |
| `MDSHARE_SKILL_TOKEN_FILE`  | `$OPENCLAW_STATE_DIR/mdshare-skill/token.json` (or `~/.openclaw/mdshare-skill/token.json`) |

## Files in this skill

- `SKILL.md` — instructions the agent reads before using this skill.
- `scripts/mdshare.mjs` — the script the agent runs (`signup`, `publish`, `read`, `search`,
  `link`). Zero npm dependencies; uses Node's built-in `fetch`.
