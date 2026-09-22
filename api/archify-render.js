// GET /a/:id — renders a stored archify diagram in mdshare chrome. Private unless the owner is
// authenticated or the row has is_public: true. Unauthenticated requests to a private id get a
// same-URL login prompt instead of the diagram's title/content.
//
// SECURITY: the stored archify HTML is reachable content (anyone can POST /api/archify with
// arbitrary `html`). It is never inlined into this top-level document. It is only ever loaded
// inside an <iframe sandbox="allow-scripts" ...> pointing at /api/archify-html — deliberately
// WITHOUT "allow-same-origin". Combining allow-scripts + allow-same-origin would hand the framed
// content the real mdshare origin (cookies, same-origin fetch to /api/*); omitting
// allow-same-origin keeps it in an opaque, unique origin that can still run its own client-side
// interactivity (pan/zoom/hover/theme-toggle — all local DOM work) but cannot read mdshare cookies
// or call mdshare APIs with the owner's session. Do not change this back to inlining HTML.
import { isAuthenticated, checkAuthAndRefresh } from './auth.js';
import { getRow, isVisible, setPrivacyHeaders, privateGateHtml, visibilityControlHtml, visibilityControlScript } from './_lib/access.js';

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

function wrapperPage({ id, title, kind, authed, isPublic }) {
  const safeTitle = String(title || 'Diagram').replace(/</g, '&lt;');
  const safeKind = String(kind || '').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} — mdshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --accent: #bb4c23; }
    body { font-family: 'DM Sans', system-ui, sans-serif; background: #f2eee5; color: #242018; min-height: 100vh; display: flex; flex-direction: column; }
    #mdshare-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      height: 46px; padding: 0 20px; flex-shrink: 0;
      background: rgba(251,248,241,0.94); backdrop-filter: blur(12px);
      border-bottom: 1px solid #c4b9a6;
    }
    .wordmark { display: flex; align-items: center; gap: 7px; text-decoration: none; color: #242018; font-family: 'Instrument Serif', Georgia, serif; font-size: 1.15rem; flex-shrink: 0; }
    .wordmark-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); display: inline-block; }
    .diag-title { flex: 1; font-size: 13px; color: #6f6658; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
    .top-bar-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
    .kind-badge { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); border: 1px solid #d8ad68; border-radius: 100px; padding: 2px 9px; }
    .badge { font-size: 11px; font-weight: 500; letter-spacing: 0.03em; color: #6f6658; background: transparent; border: 1px solid #c4b9a6; border-radius: 2em; padding: 2px 10px; }
    .btn { font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 500; color: #6f6658; background: transparent; border: 1px solid #c4b9a6; border-radius: 6px; padding: 4px 10px; cursor: pointer; text-decoration: none; white-space: nowrap; }
    .btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #diagram-frame { flex: 1; width: 100%; border: 0; display: block; background: #f2eee5; }
  </style>
</head>
<body>
  <div id="mdshare-bar">
    <a class="wordmark" href="https://mdshare-rileylins-projects.vercel.app"><span class="wordmark-dot"></span>mdshare</a>
    <span class="diag-title">${safeTitle}</span>
    <div class="top-bar-actions">
      <span class="kind-badge">${safeKind}</span>
      <a class="btn" href="/api/archify?id=${id}">Raw IR</a>
      ${authed ? visibilityControlHtml(isPublic) : ''}
    </div>
  </div>
  <iframe id="diagram-frame" src="/api/archify-html?id=${id}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" title="${safeTitle}"></iframe>
  <script>
    ${authed ? visibilityControlScript(id, 'archify', isPublic) : ''}
  <\/script>
</body>
</html>`;
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  setPrivacyHeaders(res);
  const { row, dbError } = await getRow('mdshare_archify', id, 'html,ir,kind,title,expires_at,is_public');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (dbError) {
    return res.status(503).send('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:3rem;background:#f2eee5;color:#242018">Temporarily unavailable — try again shortly.</body></html>');
  }

  if (!row) {
    return res.status(404).send('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:3rem;background:#f2eee5;color:#242018"><h1>Not found or expired</h1></body></html>');
  }

  if (!isVisible(row, req, res)) {
    return res.status(401).send(privateGateHtml());
  }

  const authed = checkAuthAndRefresh(req, res);

  if (!row.html) {
    return res.status(200).send(MISSING_HTML_PAGE(row.title, id, row.kind));
  }

  return res.status(200).send(wrapperPage({ id, title: row.title, kind: row.kind, authed, isPublic: row.is_public === true }));
}
