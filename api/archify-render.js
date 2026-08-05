// GET /a/:id — renders a stored archify diagram in mdshare chrome.
// Serves the self-contained archify HTML with:
//   - a thin mdshare top-bar injected (Instrument Serif wordmark + title + open-raw)
//   - editorial (warm-paper) preset forced as default to match mdshare's house look
// If no HTML was stored (IR-only), shows a graceful notice with a link to the raw IR.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

async function getArchify(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_archify?id=eq.${id}&select=html,ir,kind,title,expires_at`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

// Force archify's editorial (warm-paper) preset as the default view, matching mdshare's palette.
// Archify reads data-preset / data-theme off <html>; we rewrite the opening tag if present.
function applyWarmPaperDefault(html) {
  // Nudge the initial preset to editorial + light unless the artifact already pins one.
  return html.replace(
    /<html\b([^>]*)>/i,
    (m, attrs) => {
      let a = attrs;
      if (!/data-preset=/.test(a)) a += ' data-preset="editorial"';
      else a = a.replace(/data-preset="[^"]*"/, 'data-preset="editorial"');
      if (!/data-theme=/.test(a)) a += ' data-theme="light"';
      return `<html${a}>`;
    }
  );
}

// Inject a slim mdshare bar at the top of <body>, styled to sit above archify's own toolbar.
function injectMdshareBar(html, title, id, kind) {
  const safeTitle = String(title || 'Diagram').replace(/</g, '&lt;');
  const bar = `
  <div id="mdshare-bar" style="position:sticky;top:0;z-index:9999;display:flex;align-items:center;justify-content:space-between;gap:12px;height:46px;padding:0 20px;background:rgba(251,248,241,0.94);backdrop-filter:blur(12px);border-bottom:1px solid #c4b9a6;font-family:'DM Sans',system-ui,sans-serif;">
    <a href="https://mdshare-rileylins-projects.vercel.app" style="display:flex;align-items:center;gap:7px;text-decoration:none;color:#242018;font-family:'Instrument Serif',Georgia,serif;font-size:1.15rem;">
      <span style="width:6px;height:6px;border-radius:50%;background:#bb4c23;display:inline-block;"></span>mdshare
    </a>
    <span style="flex:1;font-size:13px;color:#6f6658;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;">${safeTitle}</span>
    <span style="display:flex;gap:8px;align-items:center;">
      <span style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#bb4c23;border:1px solid #d8ad68;border-radius:100px;padding:2px 9px;">${kind}</span>
      <a href="/api/archify?id=${id}" style="font-size:12px;color:#6f6658;text-decoration:none;border:1px solid #c4b9a6;border-radius:6px;padding:4px 10px;">Raw IR</a>
    </span>
  </div>`;
  // archify pads body; keep its layout but drop the mdshare bar in first.
  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/(<body\b[^>]*>)/i, `$1\n${bar}\n`);
  }
  return bar + html;
}

const MISSING_HTML_PAGE = (title, id, kind) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${String(title).replace(/</g, '&lt;')} — mdshare</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:#f2eee5;color:#242018;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:2rem;text-align:center}h1{font-family:'Instrument Serif',serif;font-size:2rem}a{color:#bb4c23}</style>
</head><body>
<h1>${String(title).replace(/</g, '&lt;')}</h1>
<p style="color:#6f6658">This ${kind} diagram was stored as IR only (no rendered HTML).</p>
<p><a href="/api/archify?id=${id}">View the raw JSON IR →</a></p>
</body></html>`;

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const row = await getArchify(id);
  if (!row) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:3rem;background:#f2eee5;color:#242018"><h1>Not found or expired</h1></body></html>');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!row.html) {
    return res.status(200).send(MISSING_HTML_PAGE(row.title, id, row.kind));
  }

  let html = applyWarmPaperDefault(row.html);
  html = injectMdshareBar(html, row.title, id, row.kind);
  return res.status(200).send(html);
}
