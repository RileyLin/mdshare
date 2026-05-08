// POST /api/diagram — accepts SVG (+ optional markdown), returns a shareable URL
// GET  /api/diagram?id=xxx — returns raw SVG

import { randomBytes } from 'crypto';
function nanoid(size = 10) {
  return randomBytes(size).toString('base64url').slice(0, size);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseGet(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_diagrams?id=eq.${id}&select=svg,markdown,title,expires_at`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

async function supabaseSet(id, svg, title, markdown, ttlSeconds) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mdshare_diagrams`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ id, svg, title: title || 'Diagram', markdown: markdown || null, expires_at: expiresAt }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} — ${text}`);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = ['https://mdshare-rileylins-projects.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const svg = body?.svg;
    if (!svg || typeof svg !== 'string') {
      return res.status(400).json({ error: 'Missing svg field' });
    }

    // Basic SVG validation
    if (!svg.trim().startsWith('<svg') && !svg.trim().startsWith('<?xml')) {
      return res.status(400).json({ error: 'svg field must be valid SVG markup' });
    }

    const title = body?.title || 'Diagram';
    const markdown = body?.markdown || null; // optional companion writeup
    const ttl = Math.min(parseInt(body?.ttl) || 86400, 604800); // max 7 days
    const id = nanoid();

    await supabaseSet(id, svg, title, markdown, ttl);

    const host = req.headers.host || 'mdshare.vercel.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const url = `${protocol}://${host}/d/${id}`;

    return res.status(200).json({ url, id, expires_in: ttl });
  }

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const row = await supabaseGet(id);
    if (!row) return res.status(404).json({ error: 'Not found or expired' });

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    return res.send(row.svg);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
