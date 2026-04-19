#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const MDSHARE_API = "https://mdshare-rileylins-projects.vercel.app/api/share";

const server = new Server(
  {
    name: "mdshare-mcp",
    version: "1.0.0",
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
          "Share markdown as a beautifully rendered web page. Returns a URL you can send in any chat app.",
        inputSchema: {
          type: "object",
          properties: {
            markdown: {
              type: "string",
              description: "The markdown content to render and share",
            },
            ttl: {
              type: "number",
              description:
                "Time-to-live in seconds (optional, default: 86400 = 24h)",
            },
          },
          required: ["markdown"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "share_markdown") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

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
    headers: {
      "Content-Type": "application/json",
    },
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
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("mdshare-mcp fatal error:", err);
  process.exit(1);
});
