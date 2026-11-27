// /c (every collection) and /c/:slug (one collection's table of contents): pages for the signed-in
// user's own collections, dispatched from api/render.js (kind=collection) to stay under the
// 12-function cap. Anyone not signed in (anonymous, any Bearer token) gets the same 401 sign-in card
// before any database call; a signed-in user sees only their own collections (another user's slug
// is the same 404 as a missing one), so the response never says whether a collection exists.
// Agents list collections through GET /api/doc?action=collection (documents:read).
// Invariant "collection-owner-only" (scripts/check-invariants.mjs) pins the gate order.
import { checkAuthAndRefresh } from './session.js';
import { setPrivacyHeaders, privateGateHtml } from './access.js';
import { sessionOwner } from './tenant.js';
import { head, header, libraryNav, toast, scripts, CSP_PAGE, notFoundPage, unavailablePage, esc } from './ui.js';
import { parseCollection, collectionToc, listCollections } from './collections.js';

const GATE_HINT = 'Collections are owner-only pages. Agents: GET /api/doc?action=collection with a documents:read token.';
const LANG_LABEL = { zh: '中文', en: 'English' };
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function shell({ title, body }) {
  return `${head({ title: `${title} — mdshare` })}
<body data-view="collection">
${header({ nav: libraryNav('collections'), right: '<a class="btn primary" href="/#new" id="btn-new">New</a>' })}
${body}
${toast()}
${scripts(['app'])}
</body></html>`;
}

function readTag(e) {
  if (!e.opened) return '<span class="tag unread" data-read="0">Unread</span>';
  return `<span class="tag read" data-read="1">Read${e.max_scroll ? ` · ${Math.min(100, e.max_scroll)}%` : ''}</span>`;
}

function entryHtml(e, i) {
  const main = e.links.find((l) => l.id === e.id) || e.links[0];
  const langs = e.links.filter((l) => LANG_LABEL[l.lang]);
  const langLinks = langs.length > 1 || (langs.length === 1 && e.links.length === 1)
    ? `<span class="coll-langs">${langs.map((l) => `<a href="/v/${esc(l.id)}" lang="${l.lang}" hreflang="${l.lang}" data-lang="${l.lang}"${l.opened ? ' class="seen"' : ''}>${LANG_LABEL[l.lang]}</a>`).join('')}</span>`
    : '';
  const version = main.version > 1 ? `<span class="tag" title="${esc(plural(e.superseded, 'earlier version'))} hidden">v${main.version}</span>` : '';
  return `<li class="coll-row" data-key="${esc(e.key)}" data-id="${esc(e.id)}">
  <span class="coll-n" aria-hidden="true">${i + 1}</span>
  <span class="coll-main"><a class="coll-title" href="/v/${esc(main.id)}">${esc(e.title || 'Untitled')}</a>${langLinks}</span>
  <span class="coll-meta">${version}${e.kept ? '<span class="tag kept">⭐ Kept</span>' : ''}${readTag(e)}<time datetime="${esc(e.updated_at || '')}">${esc(day(e.updated_at))}</time></span>
</li>`;
}

function tocPage(slug, toc) {
  const read = toc.items.filter((e) => e.opened).length;
  const updated = toc.items.reduce((m, e) => (String(e.updated_at) > m ? String(e.updated_at) : m), '');
  const body = `<main class="page" id="collection" data-slug="${esc(slug)}">
  <div class="page-head"><div><p class="coll-eyebrow"><a href="/c">Collections</a></p><h1 id="coll-title">${esc(slug)}</h1><p id="coll-summary">${plural(toc.items.length, 'document')} · ${read} read${updated ? ` · updated ${esc(day(updated))}` : ''}</p></div>
  <a class="btn" href="/dashboard?collection=${encodeURIComponent(slug)}" id="coll-library">Open in Library</a></div>
  <ol class="coll-toc" id="coll-toc">${toc.items.map(entryHtml).join('')}</ol>
  ${toc.truncated ? '<p class="coll-note">Showing the first 200 documents of this collection.</p>' : ''}
</main>`;
  return shell({ title: `${slug} · Collection`, body });
}

function indexPage(items) {
  const list = items.length
    ? `<ul class="coll-index" id="coll-index">${items.map((c) => `<li><a href="/c/${encodeURIComponent(c.slug)}" data-slug="${esc(c.slug)}"><b>${esc(c.slug)}</b><span>${plural(c.count, 'document')}${c.updated_at ? ` · updated ${esc(day(c.updated_at))}` : ''}</span></a></li>`).join('')}</ul>`
    : '<div class="lib-empty" id="coll-index"><b>No collections yet</b>Publish with <code class="inline">"collection": "&lt;slug&gt;"</code>, or run <code class="inline">mdshare-cli collection &lt;id&gt; &lt;slug&gt;</code>.</div>';
  const body = `<main class="page" id="collections">
  <div class="page-head"><div><h1>Collections</h1><p id="coll-summary">${plural(items.length, 'collection')}. Each one lists the newest version of every document, with its translation.</p></div></div>
  ${list}
</main>`;
  return shell({ title: 'Collections', body });
}

export async function renderCollection(req, res) {
  setPrivacyHeaders(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Vary', 'Authorization, Cookie');
  if (!checkAuthAndRefresh(req, res)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="mdshare"');
    return res.status(401).send(privateGateHtml({ hint: GATE_HINT }));
  }
  res.setHeader('Content-Security-Policy', CSP_PAGE);
  const me = sessionOwner(req, res);
  const raw = req.query.slug;
  if (raw === undefined || raw === '') {
    const all = await listCollections(me);
    if (all.dbError) return res.status(503).send(unavailablePage());
    return res.status(200).send(indexPage(all.items));
  }
  const slug = parseCollection(raw);
  if (!slug) return res.status(404).send(notFoundPage('collection'));
  const toc = await collectionToc(me, slug);
  if (toc.dbError) return res.status(503).send(unavailablePage());
  if (!toc.items.length) return res.status(404).send(notFoundPage('collection'));
  return res.status(200).send(tocPage(slug, toc));
}
