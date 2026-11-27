// Shared page chrome for every server-rendered mdshare page: <head>, header, popovers, the login
// card, and message pages. Visual styles live in /assets/mdshare.css; behaviour in /assets/app.js.
// Underscore directory: not a Vercel function.

export const ASSET_V = '20261127c';

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// JSON for a <script type="application/json"> block: escape <, >, & and the JS line separators
// so stored content can never close the script element or break parsing (a document containing
// "</script>" broke the old inline `const raw = ...` pages).
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function dataBlock(value) {
  return `<script type="application/json" id="mdshare-data">${jsonForScript(value)}</script>`;
}

const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&family=Noto+Serif+SC:wght@600&display=swap';

// Applies saved reader preferences before first paint (no light/dark flash). Keys and values are
// the ones app.js reads and writes (Aa menu, Settings → Reading); public/guide.html and
// public/index.html carry a copy. `motion-ok` on <html> means "animate": the reader's Motion switch
// is on, the OS doesn't ask for reduced motion and IntersectionObserver exists. Without it nothing
// is ever hidden for a reveal.
const PREFS_BOOT = `(function(){try{var d=document.documentElement,s=localStorage,m=function(q){return matchMedia(q).matches;};var t=s.getItem('mdshare-theme');if(t!=='light'&&t!=='dark'&&t!=='paper')t=m('(prefers-color-scheme: dark)')?'dark':'light';d.setAttribute('data-theme',t);var z=parseFloat(s.getItem('mdshare-zoom'));if(z>=0.85&&z<=1.6)d.style.setProperty('--zoom',z);var w=s.getItem('mdshare-width');if(w==='wide')d.setAttribute('data-width','wide');var f=s.getItem('mdshare-font');if(f==='serif')d.setAttribute('data-font','serif');var l=s.getItem('mdshare-leading');if(l==='compact'||l==='loose')d.setAttribute('data-leading',l);if(s.getItem('mdshare-motion')==='off')d.setAttribute('data-motion','off');else if(!m('(prefers-reduced-motion: reduce)')&&'IntersectionObserver' in window)d.classList.add('motion-ok');}catch(e){}})();`;

// `alternate`: the raw Markdown URL, only for a page the viewer is allowed to read (api/render.js).
export function head({ title, description = '', alternate = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
${alternate ? `<link rel="alternate" type="text/markdown" href="${esc(alternate)}">` : ''}
<meta name="theme-color" content="#f8f5ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17140f" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231f1b16'/%3E%3Ccircle cx='16' cy='16' r='5' fill='%23e08a5a'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/assets/mdshare.css?v=${ASSET_V}">
<script>${PREFS_BOOT}</script>
<script src="/assets/errors.js?v=${ASSET_V}"></script>
</head>`;
}

export function scripts(list) {
  const map = {
    marked: '/vendor/marked-12.0.2.min.js',
    purify: '/vendor/purify-3.4.18.min.js',
    hljs: '/vendor/highlight-11.9.0.min.js',
    render: `/assets/render.js?v=${ASSET_V}`,
    app: `/assets/app.js?v=${ASSET_V}`,
    library: `/assets/library.js?v=${ASSET_V}`,
    loop: `/assets/loop.js?v=${ASSET_V}`,
  };
  return list.map((k) => `<script src="${map[k]}"></script>`).join('\n');
}

export const CSP_PAGE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'";

export function wordmark() {
  return '<a class="wordmark" href="/" aria-label="mdshare home"><i></i>mdshare</a>';
}

export function header({ crumbs = '', right = '', nav = '' }) {
  return `<header class="app-header">${wordmark()}${nav}${crumbs ? `<nav class="crumb" aria-label="Breadcrumb">${crumbs}</nav>` : ''}<span class="hdr-spacer"></span><div class="hdr-actions">${right}</div></header>`;
}

export function libraryNav(current) {
  const item = (href, label, key) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="hdr-nav hide-sm" aria-label="Main">${item('/dashboard', 'Library', 'library')}${item('/c', 'Collections', 'collections')}${item('/settings', 'Settings', 'settings')}</nav>`;
}

// "Aa" reading settings — used by every reading surface (owner and reader). Settings → Reading
// (public/assets/library.js) builds the same controls with the same ids; app.js binds whichever
// set is on the page. `settingsLink`: owner pages only (Settings is owner-only).
export function aaControl({ settingsLink = false } = {}) {
  return `<div class="pop-anchor"><button class="btn icon" id="btn-aa" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="aa-pop" title="Reading settings">Aa</button>
<div class="popover wide" id="aa-pop" role="dialog" aria-label="Reading settings">
  <div class="aa-group"><div class="aa-label">Text size</div><div class="aa-row"><div class="aa-size"><button type="button" id="zoom-out" aria-label="Smaller text">A−</button><output id="zoom-val">100%</output><button type="button" id="zoom-in" aria-label="Larger text">A+</button></div><button class="btn sm ghost" type="button" id="zoom-reset">Reset</button></div></div>
  <div class="aa-group"><div class="aa-label">Theme</div><div class="seg" id="theme-seg"><button type="button" data-v="light">Light</button><button type="button" data-v="paper">Paper</button><button type="button" data-v="dark">Dark</button><button type="button" data-v="system">System</button></div></div>
  <div class="aa-group"><div class="aa-label">Line spacing</div><div class="seg" id="leading-seg"><button type="button" data-v="compact">Compact</button><button type="button" data-v="comfortable">Comfortable</button><button type="button" data-v="loose">Loose</button></div></div>
  <div class="aa-group"><div class="aa-label">Layout</div><div class="aa-row"><div class="seg" id="width-seg"><button type="button" data-v="standard">Standard</button><button type="button" data-v="wide">Wide</button></div><div class="seg" id="font-seg"><button type="button" data-v="sans">Sans</button><button type="button" data-v="serif">Serif</button></div></div></div>
  <div class="aa-group"><div class="aa-label">Tables</div><div class="seg" id="tables-seg"><button type="button" data-v="auto">Auto</button><button type="button" data-v="table">Table</button><button type="button" data-v="cards">Cards</button></div></div>
  <div class="aa-group"><div class="aa-row"><label class="lbl" for="motion-toggle">Motion<small id="motion-note">Gentle fade-ins and count-ups</small></label><label class="switch"><input type="checkbox" id="motion-toggle" checked><span></span></label></div></div>
  <div class="aa-group"><div class="aa-row"><label class="lbl" for="gloss-toggle">Term hints<small>Show 术语（解释） as hover hints</small></label><label class="switch"><input type="checkbox" id="gloss-toggle"><span></span></label></div></div>
  ${settingsLink ? '<a class="aa-more" id="aa-more" href="/settings#reading">More reading settings<span aria-hidden="true">→</span></a>' : ''}
</div></div>`;
}

const KIND_RAW = { paste: (id) => `/raw/${id}`, diagram: (id) => `/api/diagram?id=${id}`, archify: (id) => `/api/archify?id=${id}` };

// Owner controls for a document/diagram/archify page: status pill + Share panel, Edit, Aa, ⋯.
export function ownerControls({ kind, id, editable = false, downloadable = true }) {
  const raw = KIND_RAW[kind](encodeURIComponent(id));
  return `<div class="pop-anchor"><button class="pill private" id="status-pill" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="share-pop"><span class="dot"></span><span id="status-text">Private</span><span class="caret">▾</span></button>
<div class="popover wide" id="share-pop" role="dialog" aria-label="Sharing">
  <p class="pop-title">Share</p><p class="pop-sub" id="share-sub">Only you can see this.</p>
  <div class="pop-row"><span class="lbl">Public link<small>Anyone with the link can view, no sign-in.</small></span><label class="switch"><input type="checkbox" id="public-toggle"><span></span></label></div>
  <div class="pop-row"><span class="lbl">⭐ Keep forever<small id="keep-sub">Turned on automatically when you publish.</small></span><label class="switch"><input type="checkbox" id="keep-toggle"><span></span></label></div>
  <div class="linkbox" id="linkbox"><input id="share-url" readonly aria-label="Link"><button class="btn primary sm" type="button" id="btn-copy-link">Copy link</button></div>
</div></div>
<button class="btn primary hide-sm" id="btn-share" type="button">Share</button>
${editable ? '<button class="btn" id="btn-edit" type="button">Edit</button>' : ''}
${aaControl({ settingsLink: true })}
<div class="pop-anchor"><button class="btn icon" id="btn-more" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="more-pop" title="More">⋯</button>
<div class="popover" id="more-pop" role="menu">
  ${downloadable ? '<button class="menu-item" role="menuitem" type="button" id="btn-download"><span class="ic">↓</span>Download .md</button>' : ''}
  <button class="menu-item" role="menuitem" type="button" id="btn-pdf"><span class="ic">⎙</span>Export PDF</button>
  ${downloadable ? '<button class="menu-item" role="menuitem" type="button" id="btn-copy"><span class="ic">⧉</span>Copy Markdown</button>' : ''}
  <a class="menu-item" role="menuitem" href="${raw}" target="_blank" rel="noopener"><span class="ic">{ }</span>View raw</a>
  ${kind === 'paste' ? `<a class="menu-item" role="menuitem" href="?as=reader"><span class="ic">◐</span>Preview as reader</a><a class="menu-item" role="menuitem" href="?classic=1"><span class="ic">↺</span>Classic view</a>` : ''}
  <div class="menu-sep"></div>
  <button class="menu-item danger" role="menuitem" type="button" id="btn-delete"><span class="ic">✕</span>Delete…</button>
</div></div>`;
}

export function readerControls() {
  return `${aaControl()}<button class="btn" id="btn-copy-link" type="button">Copy link</button>`;
}

export function toast() {
  return '<div class="toast" id="toast" role="status" aria-live="polite"></div>';
}

export function messagePage({ title, heading, body, glyph = '✦', cta = '<a class="btn" href="/">Go to mdshare</a>' }) {
  return `${head({ title: `${title} — mdshare` })}
<body>${header({})}
<main class="center-page"><div class="msg"><div class="glyph" aria-hidden="true">${glyph}</div><h1>${esc(heading)}</h1><p>${esc(body)}</p>${cta}</div></main>
</body></html>`;
}

export function notFoundPage(what = 'link') {
  return messagePage({ title: 'Not found', heading: 'This link has expired', body: `This ${what} doesn't exist or has expired. Documents that aren't kept expire automatically.`, glyph: '⌛' });
}

export function unavailablePage() {
  return messagePage({ title: 'Unavailable', heading: 'Temporarily unavailable', body: 'Something went wrong loading this page. Try again in a moment.', glyph: '↻', cta: '<button class="btn" onclick="location.reload()">Try again</button>' });
}

// Owner sign-in card. After a successful login it reloads the SAME url (never a redirect target
// taken from the request), so the gate can't be turned into an open redirect.
export function loginPage({ title = 'Sign in', heading = 'Sign in', sub = 'Sign in as the owner to continue.', fine = '' }) {
  return `${head({ title: `${title} — mdshare` })}
<body>${header({})}
<main class="center-page"><form class="auth-card" id="login-form" onsubmit="return false">
  <div class="lock" aria-hidden="true">🔒</div>
  <h1>${esc(heading)}</h1><p>${esc(sub)}</p>
  <label for="pwd">Password</label>
  <input class="input" type="password" id="pwd" placeholder="••••••••" autocomplete="current-password" autofocus>
  <button class="btn primary" id="submit-btn" type="submit">Sign in</button>
  <p class="error-msg" id="err" role="alert"></p>
  ${fine ? `<p class="fine">${fine}</p>` : ''}
</form></main>
<script>
  document.getElementById('login-form').addEventListener('submit', login);
  async function login() {
    var pwd = document.getElementById('pwd').value;
    var btn = document.getElementById('submit-btn');
    var err = document.getElementById('err');
    if (!pwd) return;
    btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
    try {
      var res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
      if (res.ok) { window.location.reload(); return; }
      err.textContent = res.status === 429 ? 'Too many attempts. Try again later.' : 'Wrong password';
      var card = document.getElementById('login-form'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      document.getElementById('pwd').select();
    } catch (e) {
      err.textContent = 'Network error, try again';
    }
    btn.disabled = false; btn.textContent = 'Sign in';
  }
</script>
</body></html>`;
}

export function privateGatePage({ hint } = {}) {
  return loginPage({
    title: 'Private',
    heading: 'This content is private',
    sub: 'Sign in as the owner to view it. If it is ever shared publicly, this link will work for anyone without signing in.',
    // Same text for every private document: tells an agent how to authenticate, says nothing about the document.
    fine: `Agent or script? Send <code>Authorization: Bearer &lt;token&gt;</code>. See <a href="/llms.txt">/llms.txt</a>.${hint ? ` <span id="agent-hint">${esc(hint)}</span>` : ''}`,
  });
}
