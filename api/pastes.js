// GET /api/pastes — list all pastes for dashboard
// Returns: id, title, content preview (200 chars), created_at, pinned, expires_at
// Sorted: pinned first, then by created_at desc. Limit 100.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const dbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_pastes?select=id,title,content,created_at,pinned,expires_at&order=pinned.desc,created_at.desc&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
    }
  );

  if (!dbRes.ok) {
    const err = await dbRes.text();
    return res.status(500).json({ error: `Supabase error: ${err}` });
  }

  const rows = await dbRes.json();
  const now = new Date();

  const pastes = rows.map(row => {
    const content = row.content || '';
    // Extract title: use stored title if available, else first H1 from content
    let title = row.title;
    if (!title) {
      const m = content.match(/^#\s+(.+)$/m);
      title = m ? m[1].trim() : 'Untitled';
    }
    // Strip markdown syntax for preview
    const preview = content
      .replace(/^#+\s+.+$/gm, '') // remove headings
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/^\s*[-*>]\s*/gm, '')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 200);

    const expired = new Date(row.expires_at) < now && !row.pinned;

    return {
      id: row.id,
      title: title || 'Untitled',
      preview,
      created_at: row.created_at,
      pinned: row.pinned || false,
      expires_at: row.expires_at,
      expired,
    };
  }).filter(p => !p.expired); // hide expired non-pinned pastes

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(pastes);
}
