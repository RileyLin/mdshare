#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Default: public hosted API. Set MDSHARE_API to use your own instance.
const MDSHARE_API = process.env.MDSHARE_API || "https://mdshare-rileylins-projects.vercel.app/api/share";
const MDSHARE_DIAGRAM_API = process.env.MDSHARE_DIAGRAM_API || "https://mdshare-rileylins-projects.vercel.app/api/diagram";

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
      headers: {
        "Content-Type": "application/json",
      },
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
