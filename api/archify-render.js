// GET /a/:id — renders a stored archify diagram in mdshare chrome. Private unless the signed-in
// user owns it or the row has is_public: true; owner controls only for its owner. Unauthenticated requests to a private id get a
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
import { isVisible, viewerOwns, isKept, setPrivacyHeaders, notVisibleHtml } from './_lib/access.js';
import { readForView } from './_lib/tenant.js';
import { head, header, ownerControls, readerControls, toast, dataBlock, scripts, CSP_PAGE, unavailablePage, messagePage, esc } from './_lib/ui.js';
import { withErrors } from './_lib/events.js';

function chrome({ id, row, owner }) {
  const title = row.title || 'Diagram';
  const kind = row.kind || 'diagram';
  const crumbs = owner ? `<a href="/dashboard">Library</a><span class="sep">›</span><b id="crumb-title">${esc(title)}</b>` : `<b id="crumb-title">${esc(title)}</b>`;
  const right = `<span class="tag kind hide-sm">${esc(kind)}</span>` + (owner ? ownerControls({ kind: 'archify', id, downloadable: false }) : readerControls());
  const data = { view: 'archify', kind: 'archify', id, title, authed: owner, isPublic: row.is_public === true, kept: isKept(row), expiresAt: row.expires_at || null };
  return { title, crumbs, right, data };
}

function wrapperPage({ id, row, owner }) {
  const c = chrome({ id, row, owner });
  return `${head({ title: `${c.title} — mdshare` })}
<body class="frame-shell">
${header({ crumbs: c.crumbs, right: c.right })}
<iframe id="diagram-frame" src="/api/archify-html?id=${encodeURIComponent(id)}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" title="${esc(c.title)}"></iframe>
${toast()}
${dataBlock(c.data)}
${scripts(['app'])}
</body></html>`;
}

function missingHtmlPage({ id, row }) {
  return messagePage({
    title: row.title || 'Diagram',
    heading: row.title || 'Diagram',
    body: `This ${row.kind || 'archify'} diagram was stored as IR only, with no rendered page.`,
    glyph: '◈',
    cta: `<a class="btn" href="/api/archify?id=${encodeURIComponent(id)}">View the raw JSON IR</a>`,
  });
}

async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  setPrivacyHeaders(res);
  const { row, dbError } = await readForView('mdshare_archify', id, 'html,ir,kind,title,expires_at,is_public,pinned');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (dbError) return res.status(503).send(unavailablePage());

  // Missing, expired and someone else's private diagram: one answer (access.js notVisibleHtml).
  if (!isVisible(row, req, res)) {
    const [status, html] = notVisibleHtml(req, res, { what: 'diagram' });
    return res.status(status).send(html);
  }

  const authed = viewerOwns(row, req, res);
  res.setHeader('Content-Security-Policy', CSP_PAGE);

  if (!row.html) {
    return res.status(200).send(missingHtmlPage({ id, row }));
  }

  return res.status(200).send(wrapperPage({ id, row, owner: authed && req.query.as !== 'reader' }));
}

export default withErrors('archify-render', handler);
