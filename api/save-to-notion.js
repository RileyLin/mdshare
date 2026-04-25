// POST /api/save-to-notion — saves a paste as a Notion page
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PARENT_ID = '34d51bc3-98a8-80f2-a0fb-cc808020ed96';

async function getMarkdown(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_pastes?id=eq.${encodeURIComponent(id)}&select=content,expires_at`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return row.content;
}

// Simple markdown → Notion blocks converter
function markdownToNotionBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block (```)
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim() || 'plain text';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        object: 'block',
        type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: codeLines.join('\n').slice(0, 2000) } }],
          language: lang.toLowerCase(),
        },
      });
      continue;
    }

    // Heading 1
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: [{ type: 'text', text: { content: h1[1].trim().slice(0, 2000) } }] },
      });
      i++;
      continue;
    }

    // Heading 2
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: h2[1].trim().slice(0, 2000) } }] },
      });
      i++;
      continue;
    }

    // Heading 3
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: h3[1].trim().slice(0, 2000) } }] },
      });
      i++;
      continue;
    }

    // Bullet list item
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: bullet[1].trim().slice(0, 2000) } }] },
      });
      i++;
      continue;
    }

    // Empty line → skip (don't add blank paragraphs)
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (everything else)
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: line.trim().slice(0, 2000) } }] },
    });
    i++;
  }

  // Notion allows max 100 blocks per request
  return blocks.slice(0, 100);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }

  const { id } = body || {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing id' });
  }

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  }

  const markdown = await getMarkdown(id);
  if (!markdown) {
    return res.status(404).json({ error: 'Paste not found or expired' });
  }

  // Extract title from first H1
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : `mdshare-${id}`;

  const blocks = markdownToNotionBlocks(markdown);

  const notionRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { page_id: NOTION_PARENT_ID },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: title.slice(0, 2000) } }],
        },
      },
      children: blocks,
    }),
  });

  if (!notionRes.ok) {
    const errBody = await notionRes.text();
    return res.status(500).json({ error: `Notion API error: ${errBody}` });
  }

  const notionData = await notionRes.json();
  const notionUrl = notionData.url || `https://notion.so/${notionData.id?.replace(/-/g, '')}`;

  return res.status(200).json({ ok: true, notionUrl });
}
