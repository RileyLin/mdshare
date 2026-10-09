#!/usr/bin/env node
import { readFileSync } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Default: public hosted API. Set MDSHARE_API to use your own instance.
const MDSHARE_API = process.env.MDSHARE_API || "https://mdshare-rileylins-projects.vercel.app/api/share";
const MDSHARE_DIAGRAM_API = process.env.MDSHARE_DIAGRAM_API || "https://mdshare-rileylins-projects.vercel.app/api/diagram";
const MDSHARE_ARCHIFY_API = process.env.MDSHARE_ARCHIFY_API || "https://mdshare-rileylins-projects.vercel.app/api/archify";
const MDSHARE_PASTES_API = process.env.MDSHARE_PASTES_API || "https://mdshare-rileylins-projects.vercel.app/api/pastes";
const MDSHARE_PIN_API = process.env.MDSHARE_PIN_API || "https://mdshare-rileylins-projects.vercel.app/api/pin";
const MDSHARE_AUTH_API = process.env.MDSHARE_AUTH_API || "https://mdshare-rileylins-projects.vercel.app/api/auth";

// READ_API maps a content kind to its raw-read/create endpoint.
const READ_API: Record<string, string> = { paste: MDSHARE_API, diagram: MDSHARE_DIAGRAM_API, archify: MDSHARE_ARCHIFY_API };

// Optional per-agent bearer token (owner-issued from the mdshare dashboard's "API Tokens"
// panel). Never hardcode a token here — set MDSHARE_AGENT_TOKEN in the MCP client's env config
// (e.g. via a protected secrets store reference), one distinct token per agent/deployment so
// usage and revocation stay attributable per agent. Unset -> identical unauthenticated behavior
// as before (anonymous, always-private creation, no read-back capability).
//
// MDSHARE_AGENT_TOKEN_FILE (added 2026-10-08, AGENT-SEARCH-PLAN.md) is an alternative for
// machine setups that keep the token in a file with restrictive permissions instead of directly
// in the process environment (e.g. a secrets-mount path). Read once, trimmed, cached in memory
// for the life of the process — never logged, never echoed back in any tool response or error.
// Neither this file's tools nor the portable CLI (mcp/bin/mdshare-cli.mjs) ever accept a token as
// a tool argument/CLI flag: a secret must come only from the environment or a file path, never
// from text a model/user could cause to appear in a visible tool call or shell history.
let cachedTokenFromFile: string | null = null;
function resolveAgentToken(): string {
  if (process.env.MDSHARE_AGENT_TOKEN) return process.env.MDSHARE_AGENT_TOKEN;
  if (cachedTokenFromFile !== null) return cachedTokenFromFile;
  const filePath = process.env.MDSHARE_AGENT_TOKEN_FILE;
  if (filePath) {
    try {
      cachedTokenFromFile = readFileSync(filePath, "utf8").trim();
      return cachedTokenFromFile;
    } catch {
      cachedTokenFromFile = "";
      return "";
    }
  }
  cachedTokenFromFile = "";
  return "";
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = resolveAgentToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

const server = new Server(
  {
    name: "mdshare",
    version: "1.0.1",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "share_markdown",
        description:
          "Share markdown as a beautifully rendered web page. Returns a URL you can send to anyone. Use this whenever you want to share structured content (tables, code, lists, diagrams) in a readable format. Supports Mermaid diagrams: use ```mermaid fenced code blocks for flowcharts, sequence diagrams, ER diagrams, etc. They render as interactive SVGs automatically.",
        inputSchema: {
          type: "object",
          properties: {
            markdown: {
              type: "string",
              description: "The markdown content to render and share. Supports full GFM (tables, code blocks, task lists) plus Mermaid diagram blocks (```mermaid).",
            },
            ttl: {
              type: "number",
              description:
                "Time-to-live in seconds (default: 86400 = 24h, max: 604800 = 7 days)",
            },
          },
          required: ["markdown"],
        },
      },
      {
        name: "share_diagram",
        description:
          "Share a standalone SVG diagram as a rendered page. Use this for fully custom visuals that Mermaid can't express (hand-crafted SVGs, generated charts, etc). For most diagrams, prefer share_markdown with ```mermaid blocks instead — it's simpler.",
        inputSchema: {
          type: "object",
          properties: {
            svg: {
              type: "string",
              description: "Valid SVG markup (must start with <svg or <?xml)",
            },
            title: {
              type: "string",
              description: "Diagram title (default: 'Diagram')",
            },
            markdown: {
              type: "string",
              description: "Optional markdown notes rendered below the diagram",
            },
            ttl: {
              type: "number",
              description:
                "Time-to-live in seconds (default: 86400 = 24h, max: 604800 = 7 days)",
            },
          },
          required: ["svg"],
        },
      },
      {
        name: "auth_status",
        description:
          "Check this agent's own mdshare bearer-token identity: id, name, whether it's a legacy token (create + own-row-read only) or a scoped one, and which scopes it holds (documents:read / documents:write / documents:publish). Reads the token only from MDSHARE_AGENT_TOKEN / MDSHARE_AGENT_TOKEN_FILE — never a tool argument. Fails if no token is configured or it's invalid/expired/revoked.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "search_documents",
        description:
          "Search or list (recent) the owner's mdshare document library across pastes/diagrams/archify diagrams — titles and, where available, body text — with real server-side search and bounded pagination. Requires a bearer token with the documents:read scope; omit `q` for a recent/listing view instead of a search.",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string", description: "Search term (optional — omit for recent/listing mode)" },
            kind: { type: "string", enum: ["paste", "diagram", "archify", "all"], description: "Restrict to one content kind, or 'all' (default)" },
            limit: { type: "number", description: "Max results per page (default 20, max 50)" },
            offset: { type: "number", description: "Pagination offset (default 0, max 5000)" },
          },
        },
      },
      {
        name: "read_document",
        description:
          "Read a document's raw content back by id and kind. Readable without any scope if this token itself created it; readable regardless of creator if this token holds the documents:read scope; public documents are always readable.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Document id, from its share URL (/v/:id, /d/:id, /a/:id)" },
            kind: { type: "string", enum: ["paste", "diagram", "archify"], description: "Content kind" },
          },
          required: ["id", "kind"],
        },
      },
      {
        name: "publish_document",
        description:
          "Toggle a document's public/private visibility. Requires the documents:publish scope, and only works on a document this exact token itself created — it can never change visibility on the owner's or another token's content, even with this scope.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Document id" },
            kind: { type: "string", enum: ["paste", "diagram", "archify"], description: "Content kind" },
            is_public: { type: "boolean", description: "true to make it publicly viewable, false to make it private again" },
          },
          required: ["id", "kind", "is_public"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;

  if (toolName === "share_markdown") {
    const args = request.params.arguments as { markdown: string; ttl?: number };

    if (!args.markdown || typeof args.markdown !== "string") {
      throw new Error("markdown argument is required and must be a string");
    }

    const body: { markdown: string; ttl?: number } = {
      markdown: args.markdown,
    };
    if (args.ttl !== undefined) {
      body.ttl = args.ttl;
    }

    const response = await fetch(MDSHARE_API, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `mdshare API error: ${response.status} ${response.statusText} — ${errorText}`
      );
    }

    const data = (await response.json()) as { url: string; id: string; expires_in: number };

    if (!data.url) {
      throw new Error("mdshare API returned no URL");
    }

    return {
      content: [
        {
          type: "text",
          text: data.url,
        },
      ],
    };
  }

  if (toolName === "share_diagram") {
    const args = request.params.arguments as { svg: string; title?: string; markdown?: string; ttl?: number };

    if (!args.svg || typeof args.svg !== "string") {
      throw new Error("svg argument is required and must be a string");
    }

    const body: { svg: string; title?: string; markdown?: string; ttl?: number } = {
      svg: args.svg,
    };
    if (args.title) body.title = args.title;
    if (args.markdown) body.markdown = args.markdown;
    if (args.ttl !== undefined) body.ttl = args.ttl;

    const response = await fetch(MDSHARE_DIAGRAM_API, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `mdshare diagram API error: ${response.status} ${response.statusText} — ${errorText}`
      );
    }

    const data = (await response.json()) as { url: string; id: string; expires_in: number };

    if (!data.url) {
      throw new Error("mdshare diagram API returned no URL");
    }

    return {
      content: [
        {
          type: "text",
          text: data.url,
        },
      ],
    };
  }

  if (toolName === "auth_status") {
    const token = resolveAgentToken();
    if (!token) throw new Error("No MDSHARE_AGENT_TOKEN / MDSHARE_AGENT_TOKEN_FILE configured for this agent");
    const response = await fetch(`${MDSHARE_AUTH_API}?action=whoami`, { headers: authHeaders() });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`mdshare auth_status error: ${response.status} — ${errorText}`);
    }
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (toolName === "search_documents") {
    const args = request.params.arguments as { q?: string; kind?: string; limit?: number; offset?: number };
    const params = new URLSearchParams();
    if (args.q) params.set("q", args.q);
    if (args.kind) params.set("kind", args.kind);
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    if (args.offset !== undefined) params.set("offset", String(args.offset));
    const response = await fetch(`${MDSHARE_PASTES_API}?${params.toString()}`, { headers: authHeaders() });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`mdshare search_documents error: ${response.status} — ${errorText}. Requires a bearer token with the documents:read scope.`);
    }
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (toolName === "read_document") {
    const args = request.params.arguments as { id: string; kind: string };
    if (!args.id || !args.kind) throw new Error("id and kind are required");
    const api = READ_API[args.kind];
    if (!api) throw new Error(`Unknown kind: ${args.kind}`);
    const response = await fetch(`${api}?id=${encodeURIComponent(args.id)}`, { headers: authHeaders() });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`mdshare read_document error: ${response.status} — ${errorText}`);
    }
    const text = await response.text();
    return { content: [{ type: "text", text }] };
  }

  if (toolName === "publish_document") {
    const args = request.params.arguments as { id: string; kind: string; is_public: boolean };
    if (!args.id || !args.kind || typeof args.is_public !== "boolean") {
      throw new Error("id, kind, and is_public are required");
    }
    const response = await fetch(MDSHARE_PIN_API, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ id: args.id, kind: args.kind, is_public: args.is_public }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`mdshare publish_document error: ${response.status} — ${errorText}. Requires documents:publish on a document this token itself created.`);
    }
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${toolName}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("mdshare fatal error:", err);
  process.exit(1);
});
