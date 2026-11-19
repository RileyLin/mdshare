// GET /d/:id — renders SVG diagram, with optional markdown writeup below. Private unless the
// owner is authenticated or the row has is_public: true. Unauthenticated requests to a private id
// get a same-URL login prompt instead of the diagram's title/content.
// Rebuilt 2026-11-19 on the shared chrome (api/_lib/ui.js + /assets/app.js). The SVG travels as
// JSON and is sanitised with DOMPurify before it touches the DOM (the old page inlined raw SVG into
// the HTML first, so an embedded <script> could run before sanitising).
import { checkAuthAndRefresh } from './auth.js';
import { getRow, isVisible, isKept, setPrivacyHeaders, privateGateHtml } from './_lib/access.js';
import { head, header, ownerControls, readerControls, toast, dataBlock, scripts, CSP_PAGE, notFoundPage, unavailablePage, esc } from './_lib/ui.js';

function diagramPage({ id, row, owner }) {
  const title = row.title || 'Diagram';
  const crumbs = owner ? `<a href="/dashboard">Library</a><span class="sep">›</span><b id="crumb-title">${esc(title)}</b>` : `<b id="crumb-title">${esc(title)}</b>`;
  const right = owner ? ownerControls({ kind: 'diagram', id, downloadable: false }) : readerControls();
  const data = {
    view: 'diagram', kind: 'diagram', id, title, authed: owner,
    isPublic: row.is_public === true, kept: isKept(row), expiresAt: row.expires_at || null,
    svg: row.svg || '', content: row.markdown || null,
  };
  return `${head({ title: `${title} — mdshare` })}
<body>
${header({ crumbs, right })}
<main class="canvas">
  <div class="canvas-title"><h1>${esc(title)}</h1><span class="tag kind">Diagram</span></div>
  <div class="svg-frame" id="svg-frame" role="img" aria-label="${esc(title)}"></div>
</main>
${row.markdown ? '<section class="notes"><div class="prose" id="content"></div></section>' : ''}
<div class="notes"><footer class="doc-footer"><span>Published with <a href="/">mdshare</a></span><a href="/guide">Formatting guide</a></footer></div>
${toast()}
${dataBlock(data)}
${scripts(['marked', 'purify', 'hljs', 'render', 'app'])}
</body></html>`;
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  setPrivacyHeaders(res);
  const { row, dbError } = await getRow('mdshare_diagrams', id, 'svg,markdown,title,expires_at,is_public,pinned');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (dbError) return res.status(503).send(unavailablePage());
  if (!row) return res.status(404).send(notFoundPage('diagram'));

  const authed = checkAuthAndRefresh(req, res);
  if (!isVisible(row, req, res)) return res.status(401).send(privateGateHtml());

  res.setHeader('Content-Security-Policy', CSP_PAGE);
  return res.status(200).send(diagramPage({ id, row, owner: authed && req.query.as !== 'reader' }));
}
