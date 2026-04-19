// POST /api/share — accepts markdown, returns a shareable URL
// GET  /api/share?id=xxx — returns raw markdown

const { kv } = require('@vercel/kv');

function nanoid(size = 7) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < size; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const markdown = body?.markdown || body?.content || body?.md;
    if (!markdown || typeof markdown !== 'string') {
      return res.status(400).json({ error: 'Missing markdown field' });
    }

    const ttl = Math.min(parseInt(body?.ttl) || 86400, 604800); // max 7 days
    const id = nanoid();

    await kv.set(`md:${id}`, markdown, { ex: ttl });

    const host = req.headers.host || 'mdshare.vercel.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const url = `${protocol}://${host}/v/${id}`;

    return res.status(200).json({ url, id, expires_in: ttl });
  }

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const markdown = await kv.get(`md:${id}`);
    if (!markdown) return res.status(404).json({ error: 'Not found or expired' });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(markdown);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
