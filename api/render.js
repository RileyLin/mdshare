// GET /api/render?id=xxx (/v/:id) — the document reader. GET /api/render?kind=diagram&id=xxx (/d/:id)
// is the diagram page (api/_lib/diagram-page.js), and ?kind=collection (/c, /c/:slug) the owner-only
// collection pages (api/_lib/collection-page.js), merged here to stay under the 12-function cap.
// Private unless the signed-in user owns it or the row has is_public: true. Anyone else (anonymous or
// another user) gets a same-URL sign-in page for a private id, never the title or content, and the
// reader view of a public one: owner controls and private versions/translations need ownership. The page embeds the
// stored Markdown as JSON and /assets/render.js renders + enhances it in the browser; nothing
// stored is rewritten. ?as=reader shows the owner what a reader sees; ?classic=1 is the old page.
// Agents: a request with Authorization: Bearer (or the owner asking for Accept: text/markdown)
// gets the stored Markdown through api/_lib/raw.js, under exactly the /raw/:id rules.
import { isVisible, viewerOwns, isKept, setPrivacyHeaders, privateGateHtml } from './_lib/access.js';
import { readForView } from './_lib/tenant.js';
import { head, header, ownerControls, readerControls, toast, dataBlock, scripts, CSP_PAGE, notFoundPage, unavailablePage, esc } from './_lib/ui.js';
import { classicDocHtml } from './_lib/classic.js';
import { renderDiagram } from './_lib/diagram-page.js';
import { renderCollection } from './_lib/collection-page.js';
import { versionInfo } from './_lib/activity.js';
import { withErrors } from './_lib/events.js';
import { wantsMarkdown, sendRawMarkdown, refusalHint } from './_lib/raw.js';

const CLASSIC_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'self'";

// Version line (owner: "v3 · Previous version · What changed") and the newer-version banner
// (owner, or a reader when the newer version is public). Outside #content, so the rendered document
// and its readable text are unchanged.
function versionHtml({ markdown, owner, version }) {
  const zh = (markdown.match(/[\u3400-\u9fff]/g) || []).length > 30;
  let out = '';
  if (version.newerId) {
    out += `<a class="version-banner" id="version-banner" href="/v/${esc(version.newerId)}">${zh ? '这篇已有新版本' : 'A newer version of this document exists'}${version.newerTitle ? `<b>${esc(version.newerTitle)}</b>` : ''}<span aria-hidden="true">→</span></a>`;
  }
  if (owner && version.parentId) {
    out += `<div class="version-line" id="version-line"><span class="tag">v${Number(version.versionNo) || 2}</span><a href="/v/${esc(version.parentId)}">${zh ? '上一版' : 'Previous version'}</a><button class="linkish" id="btn-diff" type="button">${zh ? '看改了什么' : 'What changed'}</button></div>`;
  }
  return out;
}

// 中文 / English switch (migration 012) when the document has a translation the viewer may open:
// the owner always, a reader only when the translation is public (api/_lib/activity.js versionInfo).
const LANG_LABEL = { zh: '中文', en: 'English' };
function langSwitchHtml({ owner, version }) {
  const t = version.translation;
  if (!t || !LANG_LABEL[t.lang] || !LANG_LABEL[version.lang] || t.lang === version.lang) return '';
  const items = ['zh', 'en'].map((l) => (l === version.lang
    ? `<span class="on" aria-current="true" lang="${l}">${LANG_LABEL[l]}</span>`
    : `<a href="/v/${esc(t.id)}" lang="${l}" hreflang="${l}" id="lang-other"${t.title ? ` title="${esc(t.title)}"` : ''}>${LANG_LABEL[l]}${owner && !t.isPublic ? '<i class="lock" title="Private: readers don\'t see this switch until it is public" aria-label="private">🔒</i>' : ''}</a>`)).join('');
  return `<nav class="lang-switch" id="lang-switch" aria-label="${version.lang === 'zh' ? '语言' : 'Language'}">${items}</nav>`;
}

function docPage({ id, title, markdown, owner, row, version }) {
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
    // Versions (api/_lib/activity.js versionInfo): the owner sees the whole chain; a reader only
    // learns about a newer version when that newer version is itself public.
    parentId: owner ? version.parentId : null, versionNo: owner ? version.versionNo : null,
    newerId: version.newerId, newerTitle: version.newerTitle,
    lang: version.lang || null, translationId: version.translation ? version.translation.id : null,
  };
  // Only reached after isVisible(): the viewer may read /raw/:id, so advertising it leaks nothing.
  return `${head({ title: `${title} — mdshare`, alternate: `/raw/${encodeURIComponent(id)}` })}
<body>
<div class="progress" aria-hidden="true"><i id="progress"></i></div>
${header({ crumbs, right })}
<div class="doc-layout">
  <aside class="toc" id="toc" hidden aria-label="Contents"></aside>
  <article>
    ${langSwitchHtml({ owner, version })}
    ${versionHtml({ id, markdown, owner, version })}
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
${scripts(owner ? ['marked', 'purify', 'hljs', 'render', 'app', 'loop'] : ['marked', 'purify', 'hljs', 'render', 'app'])}
</body></html>`;
}

async function handler(req, res) {
  if (req.query.kind === 'diagram') return renderDiagram(req, res);
  if (req.query.kind === 'collection') return renderCollection(req, res);
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');
  if (wantsMarkdown(req, res)) return sendRawMarkdown(req, res, { contentType: 'text/markdown; charset=utf-8' });

  setPrivacyHeaders(res);
  res.setHeader('Vary', 'Accept, Authorization, Cookie');
  const { row, dbError } = await readForView('mdshare_pastes', id, 'content,expires_at,is_public,pinned,created_at,parent_id,root_id,version_no,lang,translation_of');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (dbError) return res.status(503).send(unavailablePage());
  if (!row) return res.status(404).send(notFoundPage('document'));

  const authed = viewerOwns(row, req, res);
  if (!isVisible(row, req, res)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="mdshare"');
    // A token sent as x-api-key / ?key= adds one sentence to the gate; nothing else changes.
    return res.status(401).send(privateGateHtml({ hint: refusalHint(req) }));
  }

  const markdown = row.content;
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  if (req.query.classic === '1') {
    res.setHeader('Content-Security-Policy', CLASSIC_CSP);
    return res.send(classicDocHtml(markdown, title, id, authed, row.is_public === true));
  }
  res.setHeader('Content-Security-Policy', CSP_PAGE);
  const owner = authed && req.query.as !== 'reader';
  const version = await versionInfo(id, row, { owner });
  return res.status(200).send(docPage({ id, title, markdown, owner, row, version }));
}

export default withErrors('render', handler);
