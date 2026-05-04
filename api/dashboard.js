// GET /api/dashboard — returns the dashboard HTML page
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

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

  <script>
    let allPastes = [];

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
      const icon = paste.pinned ? '📌' : '✦';
      const iconClass = paste.pinned ? 'paste-icon pinned-icon' : 'paste-icon';
      const pin = paste.pinned ? '<span class="pin-badge">Pinned</span>' : '';
      const preview = paste.preview ? \`<div class="paste-preview">\${escapeHtml(paste.preview)}</div>\` : '';
      return \`<a class="paste-item" href="/v/\${paste.id}">
        <div class="\${iconClass}">\${icon}</div>
        <div class="paste-body">
          <div class="paste-title-row">
            <span class="paste-title">\${escapeHtml(paste.title)}</span>
            \${pin}
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
      // Show all filtered (no pinned/recent split when searching)
      const container = document.getElementById('paste-sections');
      if (filtered.length === 0) {
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
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
}
