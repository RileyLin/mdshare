# mdshare

**Turn any markdown into a shareable link — instantly.**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRileyLin%2Fmdshare)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## The Problem

You write a great response in Claude, ChatGPT, or your terminal — full of headers, code blocks, and bullet lists — and then you paste it into Slack or iMessage and it looks like garbage. Raw markdown everywhere.

**mdshare fixes this.** POST your markdown, get a clean rendered URL back. Share that URL anywhere.

---

## Quick Start

```bash
curl -X POST https://mdshare-rileylins-projects.vercel.app/api/share \
  -H "Content-Type: application/json" \
  -d '{"markdown": "# Hello\n\nThis is **rendered** markdown with `code` and everything."}'
```

**Response:**
```json
{
  "url": "https://mdshare-rileylins-projects.vercel.app/v/abc123",
  "id": "abc123",
  "expires_in": 86400
}
```

Open the URL in any browser and you get a beautiful GitHub-styled page. Share it in Slack, iMessage, email — it just works.

---

## MCP Server (for Claude Desktop & AI Assistants)

The `mdshare-mcp` package lets Claude (and any MCP-compatible AI) share markdown directly from a conversation.

### Install

```bash
npm install -g mdshare-mcp
```

### Configure Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mdshare": {
      "command": "mdshare-mcp"
    }
  }
}
```

Config file locations:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Restart Claude Desktop. You'll see `share_markdown` available in the tools panel.

### What Claude can do with it

> "Share this analysis as a link I can send to my team"

Claude will call `share_markdown` with the content and return a URL you can paste anywhere.

---

## API Reference

### `POST /api/share`

Share a markdown document and get a short-lived URL.

**Request body:**
```json
{
  "markdown": "string (required)",
  "ttl": 86400
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `markdown` | string | ✅ | Markdown content to render |
| `ttl` | number | ❌ | TTL in seconds. Default: `86400` (24h) |

**Response:**
```json
{
  "url": "https://mdshare-rileylins-projects.vercel.app/v/:id",
  "id": "string",
  "expires_in": 86400
}
```

### `GET /v/:id`

View a shared document. Returns a rendered HTML page with GitHub-flavored markdown styling, syntax highlighting, and proper typography.

### `GET /raw/:id`

Get the raw markdown source for a shared document.

---

## Self-Host

mdshare is a zero-dependency Next.js app. Deploy your own instance in 60 seconds:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRileyLin%2Fmdshare)

**Environment variables (optional):**

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_TTL` | `86400` | Default document TTL in seconds |
| `MAX_TTL` | `604800` | Maximum allowed TTL (7 days) |

After deploying, update the `MDSHARE_API` in your MCP server config to point at your own instance:

```json
{
  "mcpServers": {
    "mdshare": {
      "command": "mdshare-mcp",
      "env": {
        "MDSHARE_API": "https://your-instance.vercel.app/api/share"
      }
    }
  }
}
```

---

## Tech Stack

- **Frontend:** Next.js 14 (App Router)
- **Rendering:** [marked](https://marked.js.org/) + GitHub CSS
- **Syntax highlighting:** [highlight.js](https://highlightjs.org/)
- **Storage:** Supabase (Postgres)
- **Hosting:** Vercel
- **MCP:** [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)

---

## Development

```bash
git clone https://github.com/RileyLin/mdshare.git
cd mdshare/app
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Project Structure

```
app/
├── api/          # Vercel serverless functions
│   └── share/    # POST /api/share endpoint
├── public/       # Static assets
├── mcp/          # MCP server (mdshare-mcp npm package)
│   └── src/
│       └── index.ts
└── vercel.json
```

---

## License

MIT © [Riley Lin](https://github.com/RileyLin)
