// GET /api/dashboard (/dashboard) — the owner's Library; ?view=settings (/settings) — Settings.
// Both are owner-only; without the owner cookie the same URL shows the sign-in card (401), which
// reloads in place after login. Data comes from /api/pastes, /api/pin, /api/auth (see
// /assets/library.js); this handler only renders the shell.
import { checkAuthAndRefresh } from './auth.js';
import { head, header, libraryNav, toast, scripts, loginPage, CSP_PAGE } from './_lib/ui.js';
import { withErrors } from './_lib/events.js';

function shell({ current, body, title }) {
  const right = '<a class="btn primary" href="/#new" id="btn-new">New</a>';
  return `${head({ title: `${title} — mdshare` })}
<body data-view="${current}">
${header({ nav: libraryNav(current), right })}
${body}
${toast()}
${scripts(['app', 'library'])}
</body></html>`;
}

const LIBRARY = `<main class="page" id="library">
  <div class="page-head"><div><h1>Library</h1><p id="lib-summary">Everything you and your agents have published.</p></div></div>
  <div class="lib-tools">
    <div class="search"><input class="input" id="search" type="search" placeholder="Search titles and full text (中文 too)" autocomplete="off" aria-label="Search"></div>
    <div class="seg" id="filter-seg" role="group" aria-label="Filter">
      <button type="button" data-v="all" aria-pressed="true">All<span class="n" data-count="all"></span></button>
      <button type="button" data-v="kept" aria-pressed="false">⭐ Kept<span class="n" data-count="kept"></span></button>
      <button type="button" data-v="public" aria-pressed="false">Public<span class="n" data-count="public"></span></button>
      <button type="button" data-v="soon" aria-pressed="false">Expiring soon<span class="n" data-count="soon"></span></button>
    </div>
    <div class="seg" id="type-seg" role="group" aria-label="Type">
      <button type="button" data-v="any" aria-pressed="true">All types</button>
      <button type="button" data-v="paste" aria-pressed="false">Docs</button>
      <button type="button" data-v="diagram" aria-pressed="false">Diagrams</button>
      <button type="button" data-v="archify" aria-pressed="false">Archify</button>
    </div>
  </div>
  <p class="lib-search-status" id="search-status" role="status" aria-live="polite" hidden></p>
  <div class="lib-list" id="lib-list" aria-busy="true">${'<div class="skel"></div>'.repeat(6)}</div>
</main>
<div class="batch-bar" id="batch-bar" role="toolbar" aria-label="Selected items">
  <span class="count" id="batch-count">0 selected</span>
  <button class="btn sm" type="button" id="b-keep">⭐ Keep</button>
  <button class="btn sm" type="button" id="b-unkeep">Unkeep</button>
  <button class="btn sm" type="button" id="b-public">Make public</button>
  <button class="btn sm" type="button" id="b-private">Make private</button>
  <button class="btn sm danger" type="button" id="b-delete">Delete</button>
  <button class="btn sm" type="button" id="b-clear" aria-label="Clear selection">✕</button>
</div>`;

const SETTINGS = `<main class="page" id="settings">
  <div class="page-head"><div><h1>Settings</h1><p>Publishing defaults, reading preferences and API access.</p></div></div>
  <div class="settings">
    <section class="set-card">
      <h2>Publishing</h2>
      <p>New documents are private. Documents that aren't kept expire automatically (24 hours by default, up to 7 days).</p>
      <div class="set-row"><span class="lbl">Keep documents when I publish them<small>Making something public also marks it ⭐ Kept, so a shared link never expires by surprise.</small></span><label class="switch"><input type="checkbox" id="pref-autokeep"><span></span></label></div>
    </section>
    <section class="set-card">
      <h2>Reading</h2>
      <p>Applies on this device to every document you open.</p>
      <div class="set-row"><span class="lbl">Theme</span><div class="seg" id="theme-seg"><button type="button" data-v="light">Light</button><button type="button" data-v="dark">Dark</button><button type="button" data-v="system">System</button></div></div>
      <div class="set-row"><span class="lbl">Term hints<small>Show 术语（解释） as a dotted term with a hover hint instead of inline text.</small></span><label class="switch"><input type="checkbox" id="gloss-toggle"><span></span></label></div>
    </section>
    <section class="set-card" id="tokens">
      <h2>API tokens <span class="tag" id="tokens-count">0</span></h2>
      <p>Bearer tokens let agents and scripts publish and read through the API. New tokens are read-only over your whole library unless you add scopes.</p>
      <div class="token-form">
        <div class="row">
          <input class="input" id="new-token-name" type="text" placeholder="Token name, e.g. &quot;Kit&quot;" maxlength="100" style="flex:1;min-width:180px">
          <select class="select" id="new-token-days" aria-label="Expiry">
            <option value="30" selected>Expires in 30 days</option><option value="90">Expires in 90 days</option><option value="180">Expires in 180 days</option><option value="365">Expires in 365 days</option><option value="never">Never expires</option>
          </select>
          <button class="btn primary" type="button" id="btn-create-token">Create token</button>
        </div>
        <div class="scopes" id="scope-row">
          <label class="check"><input type="checkbox" id="scope-read" checked> <span><code class="inline">documents:read</code> read the library</span></label>
          <label class="check"><input type="checkbox" id="scope-write"> <span><code class="inline">documents:write</code> publish</span></label>
          <label class="check"><input type="checkbox" id="scope-publish"> <span><code class="inline">documents:publish</code> share its own docs</span></label>
          <label class="check" title="Read receipts and reader feedback (api/doc.js)."><input type="checkbox" id="scope-activity-read"> <span><code class="inline">activity:read</code> see reads + feedback</span></label>
          <label class="check" title="Mark feedback resolved after revising."><input type="checkbox" id="scope-activity-write"> <span><code class="inline">activity:write</code> resolve feedback</span></label>
        </div>
        <details><summary>Advanced</summary>
          <div class="scopes" style="margin-top:10px">
            <label class="check" style="color:var(--bad)" title="Lets this token change public/private on ANY document, not just ones it created."><input type="checkbox" id="scope-publish-any"> <span><code class="inline">documents:publish:any</code> share any document</span></label>
            <label class="check" title="Omits the scopes field entirely: the old pre-scopes contract (create + read back only its own rows)."><input type="checkbox" id="scope-legacy"> <span>Legacy token (no scopes field)</span></label>
          </div>
        </details>
      </div>
      <div class="token-reveal" id="new-token-reveal" hidden><div class="h">Copy this now. It won't be shown again.</div><div class="row"><code id="new-token-value"></code><button class="btn sm" type="button" id="btn-copy-token">Copy</button></div>
        <div class="agent-block"><div class="agent-head"><span>For an agent: paste this block (whoami, read, search, publish)</span><button class="btn sm" type="button" id="btn-copy-agent">Copy block</button></div><pre id="new-token-agent"></pre></div></div>
      <div class="token-list" id="tokens-list"><div class="lib-empty">Loading…</div></div>
      <p class="usage">Use it as <code>Authorization: Bearer &lt;token&gt;</code> against <code id="api-base-example">/api/…</code>. Agents: see <a href="/llms.txt">/llms.txt</a>.</p>
    </section>
    <section class="set-card">
      <h2>Session</h2>
      <div class="set-row"><span class="lbl">Signed in as the owner<small>Signing out only affects this browser.</small></span><button class="btn" type="button" id="btn-signout">Sign out</button></div>
    </section>
  </div>
</main>`;

async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!checkAuthAndRefresh(req, res)) {
    return res.status(401).send(loginPage({ title: 'Sign in', heading: 'Welcome back', sub: 'Sign in to open your library.' }));
  }
  res.setHeader('Content-Security-Policy', CSP_PAGE);
  const settings = req.query && req.query.view === 'settings';
  return res.status(200).send(settings
    ? shell({ current: 'settings', title: 'Settings', body: SETTINGS })
    : shell({ current: 'library', title: 'Library', body: LIBRARY }));
}

export default withErrors('dashboard', handler);
