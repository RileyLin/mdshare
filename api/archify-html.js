// GET /api/archify-html?id=xxx — serves the raw self-contained archify interactive HTML.
// This is what the /a/:id page loads inside its diagram-frame <iframe>, so archify's full
// interactivity (hover-to-trace, route probe, pan/zoom, theme toggle) works untouched while the
// surrounding mdshare page (top-bar, Pin, Save-to-Notion, md explainer below) stays ours.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

async function getArchify(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_archify?id=eq.${id}&select=html,expires_at`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const row = await getArchify(id);
  if (!row || !row.html) {
    return res.status(404).send('<!DOCTYPE html><html><body style="background:#f2eee5;margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;color:#7a7365">Diagram expired or not found.</body></html>');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  // archify HTML is self-contained (inline CSS/JS + Google Fonts). Allow its own inline runtime.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'none'");
  return res.send(row.html);
}
