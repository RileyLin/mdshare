---
name: mdshare
description: "Turn a long chat reply (or one with a table/diagram) into a private mdshare web page and reply with the link instead of a wall of text."
homepage: https://mdshare-rileylins-projects.vercel.app
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "requires": { "bins": ["node"] },
        "install":
          [
            {
              "id": "node",
              "kind": "download",
              "label": "No install needed — the script ships with this skill and only needs Node 20+.",
            },
          ],
      },
  }
---

# mdshare

mdshare turns Markdown into a clean, readable web page: you send Markdown, you get a URL.
Use this skill to avoid dumping a huge reply into chat — publish it and send the link instead.
All commands below run `{baseDir}/scripts/mdshare.mjs`, a dependency-free Node script (Node 20+,
uses global `fetch`). It talks to `MDSHARE_URL` (default
`https://mdshare-rileylins-projects.vercel.app`).

## Privacy — read this before using the skill

- **What is sent, and to whom:** only the Markdown text you publish and an optional title go to
  the mdshare server named above. Nothing else about this conversation, the user, or the host
  machine is sent.
- **Private by default.** Every document you publish is visible only to its owner (you, via your
  saved token) until it is explicitly made public.
- **Making a page public:** only when you pass `--public` to `publish`, or the user explicitly
  asks you to make a specific document public. Once public, anyone with the link can read that
  one page; it still never appears in anyone else's search or library.
- **The token never appears in chat.** It is saved to a local file (see below) and is never
  printed, logged, or pasted into a reply, under any circumstance.

## First run: sign up

If no token is saved yet (check with `node {baseDir}/scripts/mdshare.mjs search x` — a
"no saved mdshare token" error means you need to sign up), run:

```bash
node {baseDir}/scripts/mdshare.mjs signup
```

This calls `POST /api/auth?action=signup` (no invite code needed), and saves the returned agent
token to a local config file — by default `<OpenClaw state dir>/mdshare-skill/token.json`
(`$OPENCLAW_STATE_DIR/mdshare-skill/token.json`, falling back to `~/.openclaw/mdshare-skill/token.json`),
created with directory mode `700` and file mode `600`. The command's JSON output has an
`entry_url` field — that is the user's **private** sign-in link (`/enter#<secret>`), good for
opening their mdshare account from a browser (e.g. to delete documents or see what you've
published). It does **not** contain the agent token.

Send the user the `entry_url` **once**, right after signup, with one short line explaining what
it is — for example:

> Here's your private mdshare link (keep it to yourself, like a password): `<entry_url>`

Do not resend it unprompted after that. Do not print the `token` field (there isn't one in the
command's output — only `entry_url`, `user_id`, and `token_file`).

If signup fails with "beta full", tell the user the beta is full and to try again later; do not
retry in a loop.

## When to publish instead of replying in chat

Publish a page (instead of, or alongside a short chat reply) when the content:

- is longer than about **1,500 characters**, or
- contains a **Markdown table**, or
- contains a **diagram or ```mermaid** fenced block, or
- has **several `##` sections** (a structured, multi-part answer).

To publish:

```bash
node {baseDir}/scripts/mdshare.mjs publish <file-or-"-"> [--title "Title"] [--public]
```

- Pass a file path, or `-` to read the Markdown from stdin.
- `--title` sets the document title (optional — mdshare infers one from the first `#` heading
  otherwise).
- `--public` additionally makes the page public (`PATCH /api/pin`). Only use this when the user
  asked for a public/shareable link; otherwise leave it private.

The command prints JSON including a `url` field. **Reply in chat with ONLY the link plus a
2-line summary of what's in it** — do not also paste the full long text you just published.

## Re-sending the private entry link

If the user asks for their sign-in link again (lost it, new device, etc.), run:

```bash
node {baseDir}/scripts/mdshare.mjs link
```

This calls `POST /api/auth?action=entry-link`, which **rotates** the secret — the old link stops
working — and returns a fresh `entry_url`. Send that one link to the user; nothing else in the
response needs to be shown.

## Reading back and searching documents

```bash
node {baseDir}/scripts/mdshare.mjs read <id>            # raw Markdown of a document you own
node {baseDir}/scripts/mdshare.mjs search <text...>     # full-text search over your own documents
```

Use these to look up something you (this agent) published earlier before re-publishing an update,
or to answer "what did you send me about X" without re-reading the whole conversation history.

## Errors

- **401** — the saved token is missing or invalid. Run `signup` again (this issues a new token;
  it does not reuse an old one).
- **403 "beta full"** — no signup seats are left. Tell the user and stop; don't retry in a loop.
- **429** — rate limited; the error message includes how many seconds to wait. Wait that long
  before retrying the same command.

## Uninstalling

See `{baseDir}/README.md` ("Uninstall / delete your data").
