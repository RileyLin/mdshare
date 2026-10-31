// GET /api/dashboard — returns the dashboard HTML page (auth-gated)
import { isAuthenticated, checkAuthAndRefresh } from './auth.js';

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — mdshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --ink: oklch(16% 0.01 260);
      --ink-2: oklch(38% 0.015 260);
      --ink-3: oklch(56% 0.01 260);
      --paper: oklch(97.5% 0.005 80);
      --paper-2: oklch(94% 0.008 80);
      --border: oklch(86% 0.01 80);
      --accent: oklch(52% 0.18 250);
      --error: oklch(52% 0.2 25);
    }
    html { -webkit-font-smoothing: antialiased; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--paper);
      color: var(--ink);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      width: 100%;
      max-width: 360px;
      background: white;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 40px 36px;
      box-shadow: 0 2px 8px oklch(0% 0 0 / 0.05), 0 12px 40px oklch(0% 0 0 / 0.07);
      opacity: 0;
      animation: fadeUp 0.35s 0.05s cubic-bezier(0.16,1,0.3,1) forwards;
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .wordmark {
      font-family: 'Instrument Serif', serif;
      font-size: 1.3rem;
      color: var(--ink);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 28px;
    }
    .wordmark-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); display: inline-block; }
    .label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--ink-3);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .input {
      width: 100%;
      padding: 10px 14px;
      font-family: 'DM Sans', sans-serif;
      font-size: 15px;
      color: var(--ink);
      background: var(--paper);
      border: 1px solid var(--border);
      border-radius: 9px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 15%, transparent);
    }
    .btn {
      width: 100%;
      margin-top: 16px;
      padding: 11px 20px;
      font-family: 'DM Sans', sans-serif;
      font-size: 14px;
      font-weight: 500;
      color: white;
      background: var(--accent);
      border: none;
      border-radius: 9px;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }
    .btn:hover { opacity: 0.88; }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error-msg {
      margin-top: 12px;
      font-size: 13px;
      color: var(--error);
      text-align: center;
      min-height: 18px;
    }
  </style>
</head>
<body>
  <div class="card">
    <a class="wordmark" href="/"><span class="wordmark-dot"></span>mdshare</a>
    <label class="label" for="pwd">Password</label>
    <input class="input" type="password" id="pwd" placeholder="••••••••" autocomplete="current-password" autofocus>
    <button class="btn" id="submit-btn" onclick="login()">Sign in</button>
    <p class="error-msg" id="err"></p>
  </div>
  <script>
    document.getElementById('pwd').addEventListener('keydown', e => {
      if (e.key === 'Enter') login();
    });
    async function login() {
      const pwd = document.getElementById('pwd').value;
      const btn = document.getElementById('submit-btn');
      const err = document.getElementById('err');
      if (!pwd) return;
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      err.textContent = '';
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd }),
        });
        if (res.ok) {
          window.location.href = '/dashboard';
        } else {
          err.textContent = 'Wrong password';
          btn.disabled = false;
          btn.textContent = 'Sign in';
          document.getElementById('pwd').select();
        }
      } catch (e) {
        err.textContent = 'Network error — try again';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    }
  <\/script>
</body>
</html>`;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  if (!checkAuthAndRefresh(req, res)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(LOGIN_HTML);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — mdshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap" rel="stylesheet">
  <style>
    :root {
      --paper: oklch(97.5% 0.005 80);
      --ink: oklch(16% 0.01 260);
      --ink-2: oklch(38% 0.015 260);
      --ink-3: oklch(52% 0.012 260);
      --border: oklch(88% 0.008 80);
      --accent: oklch(52% 0.18 250);
      --accent-bg: oklch(95% 0.04 250);
      --success: oklch(52% 0.15 145);
      --success-bg: oklch(95% 0.04 145);
      --card-hover: oklch(96% 0.007 80);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { font-family: 'DM Sans', sans-serif; background: var(--paper); color: var(--ink); min-height: 100vh; }

    /* Top bar */
    .top-bar {
      position: sticky; top: 0; z-index: 50;
      height: 52px;
      padding: 0 clamp(16px, 3vw, 40px);
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      background: color-mix(in oklch, var(--paper) 88%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .wordmark {
      font-family: 'Instrument Serif', serif; font-size: 1.1rem;
      color: var(--ink); text-decoration: none;
      display: flex; align-items: center; gap: 7px; flex-shrink: 0;
    }
    .wordmark-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); display: inline-block; }
    .page-title { font-size: 13px; font-weight: 500; color: var(--ink-3); }

    /* Search */
    .search-wrap { flex: 1; max-width: 360px; position: relative; }
    .search-input {
      width: 100%; padding: 6px 12px 6px 32px;
      font-family: 'DM Sans', sans-serif; font-size: 13px; color: var(--ink);
      background: var(--paper); border: 1px solid var(--border); border-radius: 8px;
      outline: none; transition: border-color 0.15s, box-shadow 0.15s;
    }
    .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 15%, transparent); }
    .search-icon {
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      color: var(--ink-3); font-size: 13px; pointer-events: none;
    }

    /* Main layout */
    .main { max-width: 1024px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 40px); }

    /* Section headers */
    .section-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 11px; font-weight: 600; letter-spacing: 0.07em;
      text-transform: uppercase; color: var(--ink-3);
    }
    .section-count {
      font-size: 11px; color: var(--ink-3);
      background: color-mix(in oklch, var(--border) 60%, var(--paper));
      border-radius: 2em; padding: 1px 8px;
    }
    .section + .section { margin-top: 40px; }

    /* Paste list */
    .paste-list { display: flex; flex-direction: column; gap: 2px; }
    .paste-item {
      display: flex; align-items: flex-start; gap: 16px;
      padding: 14px 16px; border-radius: 10px;
      text-decoration: none; color: inherit;
      transition: background 0.12s;
      border: 1px solid transparent;
    }
    .paste-item:hover {
      background: var(--card-hover);
      border-color: var(--border);
    }
    .paste-icon {
      width: 32px; height: 32px; border-radius: 7px;
      background: color-mix(in oklch, var(--accent) 10%, var(--paper));
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0; margin-top: 1px;
    }
    .paste-icon.pinned-icon {
      background: color-mix(in oklch, var(--success) 10%, var(--paper));
    }
    .paste-body { flex: 1; min-width: 0; }
    .paste-title-row {
      display: flex; align-items: baseline; gap: 8px;
      margin-bottom: 4px; flex-wrap: wrap;
    }
    .paste-title {
      font-size: 14.5px; font-weight: 500; color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1; min-width: 0;
    }
    .pin-badge {
      font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--success); background: var(--success-bg);
      border: 1px solid color-mix(in oklch, var(--success) 25%, transparent);
      border-radius: 2em; padding: 2px 8px; flex-shrink: 0;
    }
    .paste-preview {
      font-size: 13px; color: var(--ink-3); line-height: 1.5;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .paste-meta {
      font-size: 11.5px; color: var(--ink-3);
      margin-top: 5px; display: flex; align-items: center; gap: 8px;
    }
    .paste-date { }
    .paste-arrow {
      margin-left: auto; font-size: 14px; color: var(--ink-3);
      opacity: 0; transition: opacity 0.12s;
      align-self: center; flex-shrink: 0;
    }
    .paste-item:hover .paste-arrow { opacity: 1; }

    /* Empty state */
    .empty-state {
      text-align: center; padding: 60px 24px; color: var(--ink-3);
    }
    .empty-state p { font-size: 14px; margin-top: 8px; }

    /* Loading skeleton */
    .skeleton {
      background: linear-gradient(90deg,
        color-mix(in oklch, var(--border) 80%, var(--paper)) 25%,
        color-mix(in oklch, var(--border) 40%, var(--paper)) 50%,
        color-mix(in oklch, var(--border) 80%, var(--paper)) 75%
      );
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 6px;
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .skeleton-item { display: flex; gap: 14px; padding: 14px 16px; }
    .skeleton-icon { width: 32px; height: 32px; border-radius: 7px; flex-shrink: 0; }
    .skeleton-body { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 2px; }
    .skeleton-title { height: 14px; width: 55%; }
    .skeleton-preview { height: 12px; width: 80%; }
    .skeleton-meta { height: 11px; width: 30%; }

    /* No-results */
    .no-results { padding: 32px 16px; text-align: center; color: var(--ink-3); font-size: 14px; }

    /* ===== Select mode + batch bar ===== */
    .select-btn {
      flex-shrink: 0; font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 500;
      color: var(--ink-2); background: var(--paper); border: 1px solid var(--border);
      border-radius: 8px; padding: 6px 12px; cursor: pointer; transition: background 0.12s, border-color 0.12s;
    }
    .select-btn:hover { background: var(--card-hover); }
    .select-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }

    body.selecting .paste-item { cursor: pointer; }
    .paste-check {
      width: 18px; height: 18px; flex-shrink: 0; margin-top: 8px;
      border: 1.5px solid var(--border); border-radius: 5px;
      display: none; align-items: center; justify-content: center;
      background: white; transition: background 0.12s, border-color 0.12s;
      font-size: 12px; color: white;
    }
    body.selecting .paste-check { display: flex; }
    .paste-item.checked .paste-check { background: var(--accent); border-color: var(--accent); }
    .paste-item.checked { background: var(--accent-bg); border-color: color-mix(in oklch, var(--accent) 30%, transparent); }
    body.selecting .paste-arrow { display: none; }

    .batch-bar {
      position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 120%);
      z-index: 60; display: flex; align-items: center; gap: 12px;
      background: var(--ink); color: white; border-radius: 14px;
      padding: 10px 12px 10px 18px;
      box-shadow: 0 8px 30px oklch(0% 0 0 / 0.25);
      transition: transform 0.28s cubic-bezier(0.16,1,0.3,1);
      max-width: calc(100vw - 32px);
    }
    .batch-bar.show { transform: translate(-50%, 0); }
    .batch-count { font-size: 13.5px; font-weight: 500; white-space: nowrap; }
    .batch-actions { display: flex; gap: 8px; }
    .batch-btn {
      font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 500;
      border: none; border-radius: 8px; padding: 7px 14px; cursor: pointer;
      transition: opacity 0.12s, transform 0.1s; white-space: nowrap;
    }
    .batch-btn:active { transform: scale(0.97); }
    .batch-btn.pin { background: var(--success); color: white; }
    .batch-btn.unpin { background: color-mix(in oklch, white 18%, var(--ink)); color: white; }
    .batch-btn.selall { background: transparent; color: oklch(80% 0.01 260); border: 1px solid color-mix(in oklch, white 25%, transparent); }
    .batch-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .batch-btn.busy { opacity: 0.6; cursor: wait; }

    .toast {
      position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%) translateY(10px);
      z-index: 70; background: var(--success); color: white;
      font-size: 13px; font-weight: 500; padding: 8px 16px; border-radius: 10px;
      opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none;
      box-shadow: 0 4px 16px oklch(0% 0 0 / 0.2);
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast.err { background: var(--error, oklch(52% 0.2 25)); }

    @media (max-width: 600px) {
      .page-title { display: none; }
      .search-wrap { max-width: none; }
      .paste-preview { display: none; }
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <a class="wordmark" href="/"><span class="wordmark-dot"></span>mdshare</a>
    <span class="page-title">Dashboard</span>
    <div class="search-wrap">
      <span class="search-icon">⌕</span>
      <input class="search-input" type="search" id="search" placeholder="Search pastes…" oninput="filterPastes(this.value)" autocomplete="off">
    </div>
    <button class="select-btn" id="select-toggle" onclick="toggleSelectMode()">Select</button>
    <button class="select-btn" id="tokens-toggle" onclick="toggleTokensPanel()">🔑 API Tokens</button>
  </div>

  <div class="main" id="tokens-panel" style="display:none">
    <div class="section">
      <div class="section-header">
        <span class="section-title">API Tokens</span>
        <span class="section-count" id="tokens-count">0</span>
      </div>
      <p style="font-size:12.5px;color:var(--ink-3);margin:-8px 0 16px;line-height:1.5">Bearer tokens for agents/scripts to call the API directly. A new token defaults to <b>read-only over your whole library</b> (<b>documents:read</b> — can read any document, including private ones, via the raw routes and the catalog/search endpoint; it cannot create, change, or delete anything). Opt in deliberately per-token to grant more: <b>documents:write</b> (create new content), <b>documents:publish</b> (toggle public/private, own-created rows only), <b>documents:publish:any</b> (toggle public/private on ANY row — broad, use with caution). No token can ever mint/revoke another token, enumerate other tokens, or delete anything.</p>
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
        <input class="search-input" id="new-token-name" type="text" placeholder="Token name (e.g. \"Kit\")" style="max-width:220px;padding:8px 12px">
        <select class="search-input" id="new-token-days" style="max-width:160px;padding:8px 12px;cursor:pointer">
          <option value="30" selected>Expires in 30 days</option>
          <option value="90">Expires in 90 days</option>
          <option value="180">Expires in 180 days</option>
          <option value="365">Expires in 365 days</option>
        </select>
        <button class="select-btn active" id="btn-create-token" onclick="createToken()" style="cursor:pointer">+ New token</button>
      </div>
      <div style="display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--ink-2)" id="scope-row">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="scope-read" checked> documents:read <span style="color:var(--ink-3)">(read the whole library — default)</span></label>
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="scope-write"> documents:write <span style="color:var(--ink-3)">(create)</span></label>
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="scope-publish"> documents:publish <span style="color:var(--ink-3)">(own docs only)</span></label>
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;color:oklch(52% 0.2 25)" title="Lets this token change public/private on ANY document in the library, not just ones it created. Only grant this if you specifically need that."><input type="checkbox" id="scope-publish-any"> ⚠️ documents:publish:any <span style="color:var(--ink-3)">(ANY doc, use with caution)</span></label>
      </div>
      <div style="margin-bottom:18px">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-size:12.5px;color:var(--ink-3)" title="Omits the scopes field entirely instead of sending an explicit array. Only for the old pre-scopes contract: create + read-back-only-its-own-rows, no catalog, no publish. Disables the checkboxes above while checked."><input type="checkbox" id="scope-legacy" onchange="onLegacyToggle()"> Legacy token instead (create + own-row read only, no scopes array sent)</label>
      </div>
      <div id="new-token-reveal" style="display:none;margin-bottom:8px;padding:14px 16px;border:1px solid var(--success);background:var(--success-bg);border-radius:10px">
        <div style="font-size:12px;font-weight:600;color:var(--success);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Copy this now — it will not be shown again</div>
        <div style="display:flex;gap:8px;align-items:center">
          <code id="new-token-value" style="flex:1;font-size:12.5px;background:white;border:1px solid var(--border);border-radius:6px;padding:8px 10px;overflow-x:auto;white-space:nowrap"></code>
          <button class="select-btn" onclick="copyNewToken()">Copy</button>
        </div>
      </div>
      <p style="font-size:11.5px;color:var(--ink-3);margin:0 0 20px;line-height:1.5">Use it as: <code style="background:var(--card-hover);border-radius:4px;padding:1px 5px">Authorization: Bearer &lt;token&gt;</code> against <code id="api-base-example" style="background:var(--card-hover);border-radius:4px;padding:1px 5px"></code> — <code>&lt;token&gt;</code> is always a placeholder here, never the real value; this UI never logs or displays a token after its one-time reveal above.</p>
      <div id="tokens-list" class="paste-list"></div>
    </div>
  </div>

  <div class="main" id="main">
    <!-- Skeleton loading -->
    <div id="loading">
      ${[0,1,2,3,4].map(() => `
      <div class="skeleton-item">
        <div class="skeleton skeleton-icon"></div>
        <div class="skeleton-body">
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-preview"></div>
          <div class="skeleton skeleton-meta"></div>
        </div>
      </div>`).join('')}
    </div>
    <div id="paste-sections" style="display:none"></div>
  </div>

  <div class="batch-bar" id="batch-bar">
    <span class="batch-count" id="batch-count">0 selected</span>
    <div class="batch-actions">
      <button class="batch-btn selall" id="btn-selall" onclick="selectAllVisible()">Select all</button>
      <button class="batch-btn pin" id="btn-pin" onclick="batchPin(true)">📌 Pin</button>
      <button class="batch-btn unpin" id="btn-unpin" onclick="batchPin(false)">Unpin</button>
    </div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    let allPastes = [];
    let selectMode = false;
    const selected = new Map(); // id -> {id, type}
    let currentlyShown = []; // ids currently rendered (respects search filter)

    function formatDate(iso) {
      const d = new Date(iso);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    }

    function buildPasteCard(paste) {
      const isDiagram = paste.kind === 'diagram';
      const isArchify = paste.kind === 'archify';
      const icon = isDiagram || isArchify ? '◈' : (paste.pinned ? '📌' : '✦');
      const iconClass = paste.pinned ? 'paste-icon pinned-icon' : 'paste-icon';
      const pin = paste.pinned ? '<span class="pin-badge">Pinned</span>' : '';
      const kindLabel = isArchify ? (paste.archifyKind ? paste.archifyKind.charAt(0).toUpperCase() + paste.archifyKind.slice(1) : 'Archify') : 'Diagram';
      const kindBadge = (isDiagram || isArchify) ? \`<span class="pin-badge" style="background:oklch(52% 0.18 250);color:#fff">\${kindLabel}</span>\` : '';
      const publicBadge = paste.is_public ? '<span class="pin-badge" style="background:oklch(52% 0.15 145);color:#fff">Public</span>' : '';
      const preview = paste.preview ? \`<div class="paste-preview">\${escapeHtml(paste.preview)}</div>\` : '';
      const href = isArchify ? \`/a/\${paste.id}\` : (isDiagram ? \`/d/\${paste.id}\` : \`/v/\${paste.id}\`);
      const type = isArchify ? 'archify' : (isDiagram ? 'diagram' : 'paste');
      const isChecked = selected.has(paste.id);
      return \`<a class="paste-item\${isChecked ? ' checked' : ''}" href="\${href}" data-id="\${paste.id}" data-type="\${type}" onclick="return onCardClick(event, this)">
        <div class="paste-check">✓</div>
        <div class="\${iconClass}">\${icon}</div>
        <div class="paste-body">
          <div class="paste-title-row">
            <span class="paste-title">\${escapeHtml(paste.title)}</span>
            \${pin}\${kindBadge}\${publicBadge}
          </div>
          \${preview}
          <div class="paste-meta">
            <span class="paste-date">\${formatDate(paste.created_at)}</span>
          </div>
        </div>
        <span class="paste-arrow">→</span>
      </a>\`;
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderSections(pastes) {
      const container = document.getElementById('paste-sections');
      currentlyShown = pastes.map(p => p.id);
      if (pastes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p style="font-size:1.5rem">✦</p><p>No pastes yet. Share some markdown to get started.</p></div>';
        return;
      }

      const pinned = pastes.filter(p => p.pinned);
      const recent = pastes.filter(p => !p.pinned);
      let html = '';

      if (pinned.length) {
        html += \`<div class="section">
          <div class="section-header">
            <span class="section-title">Pinned</span>
            <span class="section-count">\${pinned.length}</span>
          </div>
          <div class="paste-list">\${pinned.map(buildPasteCard).join('')}</div>
        </div>\`;
      }

      if (recent.length) {
        html += \`<div class="section">
          <div class="section-header">
            <span class="section-title">Recent</span>
            <span class="section-count">\${recent.length}</span>
          </div>
          <div class="paste-list">\${recent.map(buildPasteCard).join('')}</div>
        </div>\`;
      }

      container.innerHTML = html;
    }

    function filterPastes(query) {
      const q = query.toLowerCase().trim();
      if (!q) {
        renderSections(allPastes);
        return;
      }
      const filtered = allPastes.filter(p =>
        p.title.toLowerCase().includes(q) ||
        (p.preview || '').toLowerCase().includes(q)
      );
      currentlyShown = filtered.map(p => p.id);
      // Show all filtered (no pinned/recent split when searching)
      const container = document.getElementById('paste-sections');
      if (filtered.length === 0) {
        currentlyShown = [];
        container.innerHTML = '<div class="no-results">No results for "' + escapeHtml(query) + '"</div>';
        return;
      }
      container.innerHTML = \`<div class="section">
        <div class="section-header">
          <span class="section-title">Results</span>
          <span class="section-count">\${filtered.length}</span>
        </div>
        <div class="paste-list">\${filtered.map(buildPasteCard).join('')}</div>
      </div>\`;
    }

    // ===== Select mode + batch actions =====
    function toggleSelectMode() {
      selectMode = !selectMode;
      document.body.classList.toggle('selecting', selectMode);
      document.getElementById('select-toggle').classList.toggle('active', selectMode);
      document.getElementById('select-toggle').textContent = selectMode ? 'Done' : 'Select';
      if (!selectMode) clearSelection();
      updateBatchBar();
    }

    function onCardClick(ev, el) {
      if (!selectMode) return true; // normal navigation
      ev.preventDefault();
      const id = el.dataset.id;
      const type = el.dataset.type;
      if (selected.has(id)) { selected.delete(id); el.classList.remove('checked'); }
      else { selected.set(id, { id, type }); el.classList.add('checked'); }
      updateBatchBar();
      return false;
    }

    function clearSelection() {
      selected.clear();
      document.querySelectorAll('.paste-item.checked').forEach(el => el.classList.remove('checked'));
    }

    function selectAllVisible() {
      const items = document.querySelectorAll('#paste-sections .paste-item');
      const allSelected = currentlyShown.length > 0 && currentlyShown.every(id => selected.has(id));
      items.forEach(el => {
        const id = el.dataset.id, type = el.dataset.type;
        if (allSelected) { selected.delete(id); el.classList.remove('checked'); }
        else { selected.set(id, { id, type }); el.classList.add('checked'); }
      });
      updateBatchBar();
    }

    function updateBatchBar() {
      const bar = document.getElementById('batch-bar');
      const count = selected.size;
      document.getElementById('batch-count').textContent = count + ' selected';
      const allSelected = currentlyShown.length > 0 && currentlyShown.every(id => selected.has(id));
      document.getElementById('btn-selall').textContent = allSelected ? 'Deselect all' : 'Select all';
      document.getElementById('btn-pin').disabled = count === 0;
      document.getElementById('btn-unpin').disabled = count === 0;
      bar.classList.toggle('show', selectMode);
    }

    function showToast(msg, isErr) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.toggle('err', !!isErr);
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2400);
    }

    async function batchPin(pinned) {
      if (selected.size === 0) return;
      const items = Array.from(selected.values());
      const pinBtn = document.getElementById('btn-pin');
      const unpinBtn = document.getElementById('btn-unpin');
      pinBtn.classList.add('busy'); unpinBtn.classList.add('busy');
      pinBtn.disabled = true; unpinBtn.disabled = true;
      try {
        const res = await fetch('/api/pin', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, pinned }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 207) throw new Error(data.error || 'Request failed');
        // Update local state
        items.forEach(it => {
          const p = allPastes.find(x => x.id === it.id);
          if (p) p.pinned = pinned;
        });
        const n = data.count != null ? data.count : (data.succeeded != null ? data.succeeded : items.length);
        showToast((pinned ? '📌 Pinned ' : 'Unpinned ') + n + ' item' + (n === 1 ? '' : 's'));
        clearSelection();
        // re-sort (pinned first) and re-render, preserving any active search
        allPastes.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return new Date(b.created_at) - new Date(a.created_at);
        });
        const q = document.getElementById('search').value;
        if (q.trim()) filterPastes(q); else renderSections(allPastes);
        updateBatchBar();
      } catch (e) {
        showToast('Failed: ' + e.message, true);
      } finally {
        pinBtn.classList.remove('busy'); unpinBtn.classList.remove('busy');
        updateBatchBar();
      }
    }

    async function load() {
      try {
        const res = await fetch('/api/pastes');
        if (!res.ok) throw new Error(await res.text());
        allPastes = await res.json();
        document.getElementById('loading').style.display = 'none';
        document.getElementById('paste-sections').style.display = '';
        renderSections(allPastes);
      } catch(e) {
        document.getElementById('loading').innerHTML = '<div class="empty-state"><p style="color:oklch(52% 0.18 25)">Failed to load pastes: ' + escapeHtml(e.message) + '</p></div>';
      }
    }

    load();

    // ===== API Tokens panel =====
    let tokensLoaded = false;
    let lastCreatedToken = '';
    // Help-text example origin: computed from window.location, never from a token value. This is
    // just where this app's own API lives, shown so a usage example has a real base URL instead
    // of an abstract placeholder -- the <token> part next to it stays a literal placeholder.
    const apiBaseExampleEl = document.getElementById('api-base-example');
    if (apiBaseExampleEl) apiBaseExampleEl.textContent = window.location.origin + '/api/...';

    function toggleTokensPanel() {
      const panel = document.getElementById('tokens-panel');
      const main = document.getElementById('main');
      const btn = document.getElementById('tokens-toggle');
      const showing = panel.style.display === 'none';
      panel.style.display = showing ? '' : 'none';
      main.style.display = showing ? 'none' : '';
      btn.classList.toggle('active', showing);
      if (showing && !tokensLoaded) loadTokens();
    }

    async function loadTokens() {
      const list = document.getElementById('tokens-list');
      list.innerHTML = '<div class="empty-state"><p>Loading\u2026</p></div>';
      try {
        const res = await fetch('/api/auth?action=tokens');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        tokensLoaded = true;
        renderTokens(data.tokens || []);
      } catch (e) {
        list.innerHTML = '<div class="empty-state"><p style="color:oklch(52% 0.18 25)">Failed to load tokens: ' + escapeHtml(e.message) + '</p></div>';
      }
    }

    function statusBadge(status) {
      const colors = {
        active: 'background:oklch(95% 0.04 145);color:oklch(52% 0.15 145);border-color:color-mix(in oklch, oklch(52% 0.15 145) 25%, transparent)',
        revoked: 'background:oklch(95% 0.05 25);color:oklch(52% 0.2 25);border-color:color-mix(in oklch, oklch(52% 0.2 25) 25%, transparent)',
        expired: 'background:transparent;color:var(--ink-3);border-color:var(--border)',
      };
      return '<span class="pin-badge" style="' + (colors[status] || colors.expired) + '">' + status + '</span>';
    }

    function scopeBadges(scopes) {
      if (!Array.isArray(scopes)) {
        return '<span class="pin-badge" style="background:transparent;color:var(--ink-3);border-color:var(--border)">legacy (create + own-read)</span>';
      }
      if (!scopes.length) {
        return '<span class="pin-badge" style="background:transparent;color:var(--ink-3);border-color:var(--border)">no scopes (own-read only)</span>';
      }
      return scopes.map(s => '<span class="pin-badge" style="background:oklch(96% 0.03 250);color:oklch(45% 0.15 250);border-color:color-mix(in oklch, oklch(45% 0.15 250) 25%, transparent)">' + escapeHtml(s) + '</span>').join(' ');
    }

    function renderTokens(tokens) {
      document.getElementById('tokens-count').textContent = tokens.length;
      const list = document.getElementById('tokens-list');
      if (!tokens.length) {
        list.innerHTML = '<div class="empty-state"><p>No API tokens yet. Create one above for an agent or script to call the API directly.</p></div>';
        return;
      }
      list.innerHTML = tokens.map(t => {
        const canRevoke = t.status === 'active';
        return '<div class="paste-item" style="cursor:default">' +
          '<div class="paste-icon">\ud83d\udd11</div>' +
          '<div class="paste-body">' +
            '<div class="paste-title-row">' +
              '<span class="paste-title">' + escapeHtml(t.name) + '</span>' +
              statusBadge(t.status) +
            '</div>' +
            '<div class="paste-meta">' +
              '<span>created ' + formatDate(t.created_at) + '</span>' +
              '<span>\u00b7 expires ' + new Date(t.expires_at).toLocaleDateString() + '</span>' +
              (t.last_used_at ? '<span>\u00b7 last used ' + formatDate(t.last_used_at) + '</span>' : '<span>\u00b7 never used</span>') +
            '</div>' +
            '<div class="paste-meta" style="margin-top:4px">' + scopeBadges(t.scopes) + '</div>' +
          '</div>' +
          (canRevoke ? '<button class="btn" style="flex-shrink:0" onclick="revokeToken(' + JSON.stringify(t.id) + ', this)">Revoke</button>' : '') +
        '</div>';
      }).join('');
    }

    async function createToken() {
      const nameInput = document.getElementById('new-token-name');
      const daysSelect = document.getElementById('new-token-days');
      const btn = document.getElementById('btn-create-token');
      const name = nameInput.value.trim();
      if (!name) { showToast('Name required', true); return; }
      btn.disabled = true;
      try {
        // Explicit-scopes-always contract: unless the separate "Legacy token" toggle is checked,
        // this ALWAYS sends a real scopes array in the request body (empty [] if every box is
        // unchecked) so a new token's capability is never decided by an accidental omission.
        // The server (api/auth.js / api/_lib/agent-tokens.js) only produces a legacy
        // (scopes === null, create + own-row-read, no catalog, no publish) token when the field
        // is omitted entirely; that path is reached here only via the explicit #scope-legacy box.
        const legacy = document.getElementById('scope-legacy')?.checked;
        const checked = [
          ['documents:read', 'scope-read'],
          ['documents:write', 'scope-write'],
          ['documents:publish', 'scope-publish'],
          ['documents:publish:any', 'scope-publish-any'],
        ].filter(([, id]) => document.getElementById(id)?.checked).map(([scope]) => scope);

        const payload = { action: 'create_token', name, expires_in_days: Number(daysSelect.value) };
        if (!legacy) payload.scopes = checked;

        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        lastCreatedToken = data.token;
        document.getElementById('new-token-value').textContent = data.token;
        document.getElementById('new-token-reveal').style.display = '';
        nameInput.value = '';
        // Reset to the deliberate defaults (read-only, not legacy) rather than leaving the form
        // in whatever state the previous creation left it.
        document.getElementById('scope-legacy').checked = false;
        document.getElementById('scope-read').checked = true;
        document.getElementById('scope-write').checked = false;
        document.getElementById('scope-publish').checked = false;
        document.getElementById('scope-publish-any').checked = false;
        onLegacyToggle();
        showToast('Token created \u2014 copy it now');
        loadTokens();
      } catch (e) {
        showToast('Failed: ' + e.message, true);
      } finally {
        btn.disabled = false;
      }
    }

    // Legacy toggle disables (and visually dims) the scope checkboxes while checked, since
    // checking it means "send no scopes field at all" and the checkbox states would otherwise be
    // misleading. Never changes which field createToken() sends on its own -- it reads this
    // checkbox fresh at submit time.
    function onLegacyToggle() {
      const legacy = document.getElementById('scope-legacy')?.checked;
      ['scope-read', 'scope-write', 'scope-publish', 'scope-publish-any'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !!legacy;
      });
      const row = document.getElementById('scope-row');
      if (row) row.style.opacity = legacy ? '0.45' : '1';
    }

    async function copyNewToken() {
      if (!lastCreatedToken) return;
      try {
        await navigator.clipboard.writeText(lastCreatedToken);
        showToast('Copied to clipboard');
      } catch (e) {
        showToast('Copy failed \u2014 select and copy manually', true);
      }
    }

    async function revokeToken(id, btnEl) {
      if (!window.confirm('Revoke this token? Any agent using it will immediately get 401s.')) return;
      if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Revoking\u2026'; }
      try {
        const res = await fetch('/api/auth', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'revoke_token', id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        showToast('Token revoked');
        loadTokens();
      } catch (e) {
        showToast('Failed: ' + e.message, true);
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Revoke'; }
      }
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
}
