// GET /api/render?id=xxx (/v/:id) — the document reader.
// Private unless the owner is authenticated or the row has is_public: true. Anonymous requests for
// a private id get a same-URL sign-in page, never the title or content. The page embeds the
// stored Markdown as JSON and /assets/render.js renders + enhances it in the browser; nothing
// stored is rewritten. ?as=reader shows the owner what a reader sees; ?classic=1 is the old page.
import { checkAuthAndRefresh } from './auth.js';
import { getRow, isVisible, isKept, setPrivacyHeaders, privateGateHtml } from './_lib/access.js';
import { head, header, ownerControls, readerControls, toast, dataBlock, scripts, CSP_PAGE, notFoundPage, unavailablePage, esc } from './_lib/ui.js';
import { classicDocHtml } from './_lib/classic.js';
import { withErrors } from './_lib/events.js';

const CLASSIC_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'self'";

function docPage({ id, title, markdown, owner, row }) {
  const crumbs = owner
    ? `<a href="/dashboard">Library</a><span class="sep">›</span><b id="crumb-title">${esc(title)}</b>`
    : `<b id="crumb-title">${esc(title)}</b>`;
  const right = owner
    ? `<div class="view-actions">${ownerControls({ kind: 'paste', id, editable: true })}</div>
       <div class="edit-actions"><span class="lbl">Editing · ⌘S to save</span><button class="btn" id="btn-cancel" type="button">Cancel</button><button class="btn primary" id="btn-save-edit" type="button">Save</button></div>`
    : `<div class="view-actions">${readerControls()}</div>`;
  const data = {
    view: 'doc', kind: 'paste', id, title, authed: owner,
    isPublic: row.is_public === true, kept: isKept(row), expiresAt: row.expires_at || null, createdAt: row.created_at || null,
    content: markdown,
  };
  return `${head({ title: `${title} — mdshare` })}
<body>
<div class="progress" aria-hidden="true"><i id="progress"></i></div>
${header({ crumbs, right })}
<div class="doc-layout">
  <aside class="toc" id="toc" hidden aria-label="Contents"></aside>
  <article>
    <details class="toc-mobile" id="toc-mobile" hidden><summary>Contents</summary><nav></nav></details>
    <div class="doc-meta" id="doc-meta"></div>
    <div class="prose" id="content"><noscript><pre style="white-space:pre-wrap">${esc(markdown)}</pre></noscript></div>
    <footer class="doc-footer"><span>Published with <a href="/">mdshare</a></span><a href="/guide">Formatting guide</a></footer>
  </article>
</div>
${owner ? `<div class="editor" id="editor"><div class="editor-pane"><div class="pane-label">Markdown</div><textarea id="md-editor" spellcheck="false" aria-label="Markdown source"></textarea></div><div class="editor-pane"><div class="pane-label">Preview</div><div class="preview"><div class="prose" id="preview-content"></div></div></div></div>` : ''}
<button class="btn icon to-top" id="to-top" type="button" aria-label="Back to top">↑</button>
${toast()}
${dataBlock(data)}
${scripts(['marked', 'purify', 'hljs', 'render', 'app'])}
</body></html>`;
}

async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  setPrivacyHeaders(res);
  const { row, dbError } = await getRow('mdshare_pastes', id, 'content,expires_at,is_public,pinned,created_at');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (dbError) return res.status(503).send(unavailablePage());
  if (!row) return res.status(404).send(notFoundPage('document'));

  const authed = checkAuthAndRefresh(req, res);
  if (!isVisible(row, req, res)) return res.status(401).send(privateGateHtml());

  const markdown = row.content;
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  if (req.query.classic === '1') {
    res.setHeader('Content-Security-Policy', CLASSIC_CSP);
    return res.send(classicDocHtml(markdown, title, id, authed, row.is_public === true));
  }
  res.setHeader('Content-Security-Policy', CSP_PAGE);
  const owner = authed && req.query.as !== 'reader';
  return res.status(200).send(docPage({ id, title, markdown, owner, row }));
}

export default withErrors('render', handler);
