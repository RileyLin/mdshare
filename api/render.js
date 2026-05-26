// GET /api/render?id=xxx — returns rendered HTML (redesigned UI + all actions + inline edit)
import { isAuthenticated } from './auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getMarkdown(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_pastes?id=eq.${id}&select=content,expires_at`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return row.content;
}

const HTML_TEMPLATE = (content, title, id, authed = false) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title.replace(/</g,'&lt;')} — mdshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
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
      --editor-bg: oklch(14% 0.01 260);
      --code-bg: oklch(18% 0.012 260);
      --code-border: oklch(28% 0.012 260);
      --code-ink: oklch(94% 0.01 240);
      --inline-code-bg: color-mix(in oklch, var(--accent) 8%, var(--paper));
      --inline-code-ink: var(--accent);
    }
    :root[data-theme="dark"] {
      --paper: oklch(15% 0.008 260);
      --ink: oklch(94% 0.008 80);
      --ink-2: oklch(78% 0.012 260);
      --ink-3: oklch(62% 0.012 260);
      --border: oklch(28% 0.012 260);
      --accent: oklch(72% 0.16 250);
      --accent-bg: oklch(26% 0.06 250);
      --success: oklch(78% 0.13 145);
      --success-bg: oklch(26% 0.05 145);
      --editor-bg: oklch(11% 0.008 260);
      --code-bg: oklch(11% 0.008 260);
      --code-border: oklch(24% 0.012 260);
      --code-ink: oklch(94% 0.01 240);
      --inline-code-bg: color-mix(in oklch, var(--accent) 14%, var(--paper));
      --inline-code-ink: oklch(82% 0.14 250);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { font-family: 'DM Sans', sans-serif; background: var(--paper); color: var(--ink); min-height: 100vh; }

    /* Top bar */
    .top-bar {
      position: sticky; top: 0; z-index: 50;
      height: 52px;
      padding: 0 clamp(16px, 3vw, 40px);
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
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
    .doc-title {
      font-size: 13px; color: var(--ink-3); font-weight: 400;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1; min-width: 0;
    }
    .top-bar-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .badge {
      font-size: 11px; font-weight: 500; letter-spacing: 0.03em;
      color: var(--success); background: var(--success-bg);
      border: 1px solid color-mix(in oklch, var(--success) 30%, transparent);
      border-radius: 2em; padding: 2px 10px;
    }
    .btn {
      font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 500;
      color: var(--ink-2); background: transparent;
      border: 1px solid var(--border); border-radius: 6px;
      padding: 5px 11px; cursor: pointer; white-space: nowrap;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .btn:hover:not(:disabled) { background: color-mix(in oklch, var(--accent) 8%, var(--paper)); border-color: var(--accent); color: var(--accent); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-success { color: var(--success) !important; border-color: var(--success) !important; background: var(--success-bg) !important; }
    .btn-primary {
      color: var(--paper) !important; background: var(--accent) !important;
      border-color: var(--accent) !important;
    }
    .btn-primary:hover:not(:disabled) { background: color-mix(in oklch, var(--accent) 85%, var(--ink)) !important; border-color: color-mix(in oklch, var(--accent) 85%, var(--ink)) !important; }

    /* Save dropdown */
    .save-dropdown-wrapper { position: relative; display: inline-block; }
    .save-menu {
      display: none; position: absolute; right: 0; top: calc(100% + 6px);
      background: var(--paper); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 24px oklch(0% 0 0 / 10%);
      min-width: 180px; z-index: 100; overflow: hidden;
    }
    .save-menu.open { display: block; }
    .save-menu-item {
      display: block; width: 100%; text-align: left;
      background: none; border: none; padding: 9px 14px;
      font-size: 13px; font-family: 'DM Sans', sans-serif; color: var(--ink-2);
      cursor: pointer; white-space: nowrap;
    }
    .save-menu-item:hover { background: color-mix(in oklch, var(--accent) 8%, var(--paper)); color: var(--accent); }

    /* Content — read mode */
    .content-wrap { max-width: 860px; margin: 0 auto; padding: clamp(24px, 4vw, 56px) clamp(16px, 3vw, 40px); }
    #content { font-size: 15.5px; line-height: 1.75; color: var(--ink); }
    #content h1 { font-family: 'Instrument Serif', serif; font-size: 2rem; font-weight: 400; color: var(--ink); margin: 0 0 1.25rem; line-height: 1.25; }
    #content h2 { font-family: 'Instrument Serif', serif; font-size: 1.45rem; font-weight: 400; color: var(--ink); margin: 2.25rem 0 0.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
    #content h3 { font-size: 1.05rem; font-weight: 600; color: var(--ink); margin: 1.75rem 0 0.5rem; }
    #content p { margin: 0 0 1rem; }
    #content ul, #content ol { margin: 0 0 1rem 1.5rem; }
    #content li { margin-bottom: 0.35rem; }
    #content a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
    #content a:hover { color: color-mix(in oklch, var(--accent) 80%, var(--ink)); }
    #content code { font-size: 0.875em; background: var(--inline-code-bg); color: var(--inline-code-ink); border-radius: 4px; padding: 2px 5px; }
    #content pre { background: var(--code-bg); border: 1px solid var(--code-border); border-radius: 10px; padding: 1.25rem 1.5rem; overflow-x: auto; margin: 0 0 1.25rem; }
    #content pre code, #content pre code.hljs { background: none; color: var(--code-ink); font-size: 0.875rem; padding: 0; line-height: 1.55; }
    /* brighten hljs github-dark tokens for better contrast on dark bg */
    #content pre .hljs-keyword, #content pre .hljs-built_in, #content pre .hljs-type { color: oklch(80% 0.16 295); }
    #content pre .hljs-string, #content pre .hljs-attr { color: oklch(82% 0.14 145); }
    #content pre .hljs-number, #content pre .hljs-literal { color: oklch(80% 0.16 50); }
    #content pre .hljs-title, #content pre .hljs-section, #content pre .hljs-name { color: oklch(82% 0.14 220); }
    #content pre .hljs-comment, #content pre .hljs-meta { color: oklch(62% 0.02 260); }
    #content blockquote { border-left: 3px solid var(--accent); margin: 0 0 1rem; padding: 0.5rem 1rem; color: var(--ink-2); font-style: italic; }
    #content hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
    .table-wrap { overflow-x: auto; margin: 0 0 1.25rem; }
    #content table { border-collapse: collapse; width: 100%; font-size: 14px; }
    #content th { text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); padding: 8px 12px; border-bottom: 2px solid var(--border); }
    #content td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    #content tr:hover td { background: color-mix(in oklch, var(--accent) 4%, var(--paper)); }

    /* Editor split-pane */
    #editor-pane {
      display: none;
      height: calc(100vh - 52px);
      overflow: hidden;
    }
    #editor-pane.active { display: flex; }
    .editor-panel {
      flex: 1; display: flex; flex-direction: column;
      overflow: hidden;
    }
    .editor-panel + .editor-panel {
      border-left: 1px solid var(--border);
    }
    .panel-label {
      padding: 8px 16px; font-size: 11px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--ink-3); background: color-mix(in oklch, var(--border) 40%, var(--paper));
      border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    #md-editor {
      flex: 1; width: 100%; resize: none; border: none; outline: none;
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
      font-size: 13.5px; line-height: 1.7;
      background: var(--editor-bg); color: oklch(85% 0.01 260);
      padding: 20px 24px;
      overflow-y: auto;
      tab-size: 2;
    }
    #md-editor::selection { background: color-mix(in oklch, var(--accent) 30%, transparent); }
    .preview-panel { overflow-y: auto; }
    #preview-content {
      padding: clamp(16px, 2vw, 32px) clamp(16px, 3vw, 32px);
      font-size: 15px; line-height: 1.75; color: var(--ink);
    }
    #preview-content h1 { font-family: 'Instrument Serif', serif; font-size: 1.75rem; font-weight: 400; margin: 0 0 1rem; line-height: 1.25; }
    #preview-content h2 { font-family: 'Instrument Serif', serif; font-size: 1.3rem; font-weight: 400; margin: 2rem 0 0.6rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35rem; }
    #preview-content h3 { font-size: 1rem; font-weight: 600; margin: 1.5rem 0 0.4rem; }
    #preview-content p { margin: 0 0 0.85rem; }
    #preview-content ul, #preview-content ol { margin: 0 0 0.85rem 1.4rem; }
    #preview-content li { margin-bottom: 0.3rem; }
    #preview-content a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
    #preview-content code { font-size: 0.85em; background: var(--inline-code-bg); color: var(--inline-code-ink); border-radius: 4px; padding: 2px 5px; }
    #preview-content pre { background: var(--code-bg); border: 1px solid var(--code-border); border-radius: 8px; padding: 1rem 1.25rem; overflow-x: auto; margin: 0 0 1rem; }
    #preview-content pre code, #preview-content pre code.hljs { background: none; color: var(--code-ink); font-size: 0.85rem; padding: 0; line-height: 1.55; }
    #preview-content pre .hljs-keyword, #preview-content pre .hljs-built_in, #preview-content pre .hljs-type { color: oklch(80% 0.16 295); }
    #preview-content pre .hljs-string, #preview-content pre .hljs-attr { color: oklch(82% 0.14 145); }
    #preview-content pre .hljs-number, #preview-content pre .hljs-literal { color: oklch(80% 0.16 50); }
    #preview-content pre .hljs-title, #preview-content pre .hljs-section, #preview-content pre .hljs-name { color: oklch(82% 0.14 220); }
    #preview-content pre .hljs-comment, #preview-content pre .hljs-meta { color: oklch(62% 0.02 260); }
    #preview-content blockquote { border-left: 3px solid var(--accent); margin: 0 0 0.85rem; padding: 0.4rem 0.9rem; color: var(--ink-2); font-style: italic; }
    #preview-content table { border-collapse: collapse; width: 100%; font-size: 13.5px; margin: 0 0 1rem; }
    #preview-content th { text-align: left; font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); padding: 7px 10px; border-bottom: 2px solid var(--border); }
    #preview-content td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }

    /* Edit-mode top bar adjustments */
    .edit-actions { display: none; align-items: center; gap: 6px; }
    body.editing .edit-actions { display: flex; }
    body.editing .view-actions { display: none; }
    body.editing .content-wrap { display: none; }
    body.editing #editor-pane { display: flex; }

    /* Text zoom controls */
    .zoom { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; background: var(--paper-2, color-mix(in oklch, var(--border) 40%, var(--paper))); border: 1px solid var(--border); border-radius: 100px; padding: 2px; flex-shrink: 0; }
    .zoom button { font-family: inherit; font-size: 12px; font-weight: 600; color: var(--ink-2); background: transparent; border: none; border-radius: 100px; padding: 3px 9px; cursor: pointer; line-height: 1; transition: background 0.15s, color 0.15s; }
    .zoom button:hover { background: var(--paper); color: var(--ink); }
    .zoom button.small { font-size: 10px; }
    .zoom button.big { font-size: 14px; }
    /* Theme toggle */
    .theme-toggle { display: inline-flex; align-items: center; justify-content: center; margin-left: 4px; width: 30px; height: 28px; background: transparent; border: 1px solid var(--border); border-radius: 100px; cursor: pointer; font-size: 14px; line-height: 1; color: var(--ink-2); transition: background 0.15s, color 0.15s, border-color 0.15s; flex-shrink: 0; padding: 0; }
    .theme-toggle:hover { background: var(--paper); color: var(--ink); border-color: color-mix(in oklch, var(--ink-3) 40%, var(--border)); }
    /* Scale content with zoom variable (applied to #content and #preview-content) */
    #content { font-size: calc(15.5px * var(--zoom, 1)); }
    #preview-content { font-size: calc(15px * var(--zoom, 1)); }

    /* Mermaid diagram styling */
    .mermaid { margin: 1.5rem 0; text-align: center; }
    .mermaid svg { max-width: 100%; height: auto; }

    @media (max-width: 600px) {
      .doc-title { display: none; }
      #editor-pane { flex-direction: column; }
      .editor-panel + .editor-panel { border-left: none; border-top: 1px solid var(--border); }
    }

    /* Print / PDF styles */
    @media print {
      body { background: white !important; color: #1a1a1a !important; }
      .top-bar, #editor-pane, .zoom, .theme-toggle { display: none !important; }
      .content-wrap { max-width: 100%; padding: 0; margin: 0; }
      #content { font-size: 13px; line-height: 1.7; }
      #content h1 { font-size: 1.6rem; margin-bottom: 0.5rem; }
      #content h2 { font-size: 1.2rem; border-bottom: 1px solid #ddd; }
      #content pre { background: #f5f5f5 !important; border: 1px solid #ddd !important; }
      #content pre code, #content pre code.hljs { color: #333 !important; }
      #content blockquote { border-left-color: #999; }
      #content table { font-size: 12px; }
      #content th, #content td { border: 1px solid #ccc; padding: 6px 8px; }
      a { color: #1a1a1a !important; text-decoration: none !important; }
      @page { margin: 1.5cm 2cm; }
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <a class="wordmark" href="/"><span class="wordmark-dot"></span>mdshare</a>
    <span class="doc-title" id="doc-title"></span>

    <!-- View mode actions -->
    <div class="top-bar-actions view-actions">
      ${authed ? '<button class="btn" id="btn-edit" onclick="enterEdit()">✎ Edit</button>' : ''}
      <button class="btn" id="btn-download" onclick="downloadMd()">⬇ .md</button>
      <button class="btn" id="btn-pdf" onclick="downloadPdf()">📄 PDF</button>
      <button class="btn" id="btn-copy" onclick="copyMd()">📋 Copy</button>
      <div class="save-dropdown-wrapper" id="save-wrapper">
        <button class="btn" id="btn-save" onclick="toggleSaveMenu(event)">📌 Save ▾</button>
        <div class="save-menu" id="save-menu">
          <button class="save-menu-item" id="btn-pin" onclick="pinPaste()">📌 Pin (keep forever)</button>
          <button class="save-menu-item" id="btn-notion" onclick="saveToNotion()">🔗 Save to Notion</button>
        </div>
      </div>
      <span class="badge">rendered</span>
      <div class="zoom" role="group" aria-label="Text size">
        <button class="small" id="zoom-out" title="Smaller text (Ctrl/Cmd -)" aria-label="Smaller text">A−</button>
        <button id="zoom-reset" title="Reset text size (Ctrl/Cmd 0)" aria-label="Reset text size">A</button>
        <button class="big" id="zoom-in" title="Larger text (Ctrl/Cmd +)" aria-label="Larger text">A+</button>
      </div>
      <button class="theme-toggle" id="theme-toggle" title="Toggle light/dark" aria-label="Toggle light/dark theme">☾</button>
    </div>

    <!-- Edit mode actions -->
    ${authed ? `<div class="top-bar-actions edit-actions">
      <span style="font-size:12px;color:var(--ink-3)">editing</span>
      <button class="btn" id="btn-cancel" onclick="cancelEdit()">Cancel</button>
      <button class="btn btn-primary" id="btn-save-edit" onclick="saveEdit()">Save</button>
    </div>` : ''}
  </div>

  <!-- Read view -->
  <div class="content-wrap">
    <div id="content">Loading…</div>
  </div>

  <!-- Editor split-pane -->
  <div id="editor-pane">
    <div class="editor-panel">
      <div class="panel-label">Markdown</div>
      <textarea id="md-editor" spellcheck="false" oninput="updatePreview()"></textarea>
    </div>
    <div class="editor-panel preview-panel">
      <div class="panel-label">Preview</div>
      <div id="preview-content"></div>
    </div>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <script>
    const raw = ${JSON.stringify(content)};
    const pasteId = ${JSON.stringify(id)};
    const pasteTitle = ${JSON.stringify(title)};

    // Configure marked
    marked.use({
      renderer: (() => {
        const r = new marked.Renderer();
        r.table = function(header, body) {
          return '<div class="table-wrap"><table><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>';
        };
        return r;
      })()
    });
    marked.setOptions({
      highlight: function(code, lang) {
        if (lang === 'mermaid') return code;
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
      }
    });

    // Render initial content
    document.getElementById('content').innerHTML = DOMPurify.sanitize(marked.parse(raw));
    hljs.highlightAll();
    const h1 = document.querySelector('#content h1');
    if (h1) document.getElementById('doc-title').textContent = h1.textContent;

    // --- Mermaid diagram rendering ---
    mermaid.initialize({
      startOnLoad: false,
      theme: (localStorage.getItem('mdshare-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default')) === 'dark' ? 'dark' : 'default',
      themeVariables: { primaryColor: '#3b82f6', fontFamily: 'DM Sans, sans-serif' },
      securityLevel: 'loose'
    });
    function renderMermaidBlocks(container) {
      container.querySelectorAll('pre code.language-mermaid').forEach((el, i) => {
        const pre = el.parentElement;
        const div = document.createElement('div');
        div.className = 'mermaid';
        div.textContent = el.textContent;
        pre.replaceWith(div);
      });
      mermaid.run({ nodes: container.querySelectorAll('.mermaid') });
    }
    renderMermaidBlocks(document.getElementById('content'));

    // --- Theme toggle (light/dark, persisted per browser, with OS default) ---
    (function() {
      const root = document.documentElement;
      const btn = document.getElementById('theme-toggle');
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const getTheme = () => localStorage.getItem('mdshare-theme') || (prefersDark ? 'dark' : 'light');
      const apply = (t) => {
        root.setAttribute('data-theme', t);
        localStorage.setItem('mdshare-theme', t);
        if (btn) btn.textContent = t === 'dark' ? '☀' : '☾';
      };
      apply(getTheme());
      if (btn) btn.addEventListener('click', () => apply(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
    })();

    // --- Text zoom (persisted per browser) ---
    (function() {
      const MIN = 0.85, MAX = 1.6, STEP = 0.1, DEFAULT = 1;
      const root = document.documentElement;
      const clamp = (v) => Math.min(MAX, Math.max(MIN, Math.round(v * 100) / 100));
      const get = () => {
        const v = parseFloat(localStorage.getItem('mdshare-zoom'));
        return isNaN(v) ? DEFAULT : clamp(v);
      };
      const apply = (v) => { root.style.setProperty('--zoom', v); localStorage.setItem('mdshare-zoom', v); };
      apply(get());
      const zi = document.getElementById('zoom-in');
      const zo = document.getElementById('zoom-out');
      const zr = document.getElementById('zoom-reset');
      if (zi) zi.addEventListener('click', () => apply(clamp(get() + STEP)));
      if (zo) zo.addEventListener('click', () => apply(clamp(get() - STEP)));
      if (zr) zr.addEventListener('click', () => apply(DEFAULT));
      document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === '=' || e.key === '+') { e.preventDefault(); apply(clamp(get() + STEP)); }
        else if (e.key === '-') { e.preventDefault(); apply(clamp(get() - STEP)); }
        else if (e.key === '0') { e.preventDefault(); apply(DEFAULT); }
      });
    })();

    // --- Download / Copy ---
    function downloadMd() {
      const filename = (pasteTitle || ('mdshare-' + pasteId)).replace(/[^a-z0-9_\\-. ]/gi, '_').trim() + '.md';
      const blob = new Blob([raw], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    function downloadPdf() {
      document.title = (pasteTitle || 'mdshare') + '.pdf';
      window.print();
      setTimeout(() => { document.title = (pasteTitle || 'Untitled') + ' — mdshare'; }, 1000);
    }

    async function copyMd() {
      const btn = document.getElementById('btn-copy');
      try {
        await navigator.clipboard.writeText(raw);
        btn.textContent = '✓ Copied'; btn.classList.add('btn-success');
        setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('btn-success'); }, 2000);
      } catch(e) {
        btn.textContent = '⚠ Failed';
        setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
      }
    }

    // --- Save dropdown ---
    function toggleSaveMenu(e) {
      e.stopPropagation();
      document.getElementById('save-menu').classList.toggle('open');
    }
    document.addEventListener('click', () => document.getElementById('save-menu').classList.remove('open'));

    async function requireAuth() {
      const res = await fetch('/api/auth');
      if (res.ok) return true;
      if (confirm('Sign in required to save. Go to login?')) {
        window.location.href = '/dashboard';
      }
      return false;
    }

    async function pinPaste() {
      document.getElementById('save-menu').classList.remove('open');
      if (!(await requireAuth())) return;
      const btn = document.getElementById('btn-pin');
      const saveBtn = document.getElementById('btn-save');
      btn.disabled = true; btn.textContent = 'Pinning…';
      try {
        const res = await fetch('/api/pin', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pasteId }),
        });
        if (!res.ok) throw new Error();
        btn.textContent = '✓ Pinned';
        saveBtn.textContent = '✓ Pinned ▾'; saveBtn.classList.add('btn-success'); saveBtn.disabled = true;
      } catch(e) { btn.textContent = '⚠ Failed — retry'; btn.disabled = false; }
    }

    async function saveToNotion() {
      document.getElementById('save-menu').classList.remove('open');
      if (!(await requireAuth())) return;
      const btn = document.getElementById('btn-notion');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const res = await fetch('/api/save-to-notion', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pasteId }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        btn.textContent = '✓ Saved to Notion';
        const wrapper = document.getElementById('save-wrapper');
        const link = document.createElement('a');
        link.href = data.notionUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = '↗ Open in Notion';
        link.style.cssText = 'font-size:12px;color:var(--accent);text-decoration:underline;text-underline-offset:3px;white-space:nowrap;font-family:DM Sans,sans-serif;';
        wrapper.parentNode.insertBefore(link, wrapper.nextSibling);
      } catch(e) { btn.textContent = '⚠ Failed — retry'; btn.disabled = false; }
    }

    // --- Inline editor ---
    let editingContent = raw;

    function renderPreview(md) {
      const html = marked.parse(md);
      document.getElementById('preview-content').innerHTML = html;
      hljs.highlightAll();
      renderMermaidBlocks(document.getElementById('preview-content'));
    }

    function enterEdit() {
      const ta = document.getElementById('md-editor');
      ta.value = editingContent;
      renderPreview(editingContent);
      document.body.classList.add('editing');
      ta.focus();
    }

    function cancelEdit() {
      document.body.classList.remove('editing');
    }

    let previewTimer = null;
    function updatePreview() {
      editingContent = document.getElementById('md-editor').value;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => renderPreview(editingContent), 150);
    }

    async function saveEdit() {
      const btn = document.getElementById('btn-save-edit');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const res = await fetch('/api/share', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pasteId, content: editingContent }),
        });
        if (!res.ok) throw new Error(await res.text());

        // Update read view with new content
        document.getElementById('content').innerHTML = marked.parse(editingContent);
        hljs.highlightAll();
        const newH1 = document.querySelector('#content h1');
        if (newH1) document.getElementById('doc-title').textContent = newH1.textContent;

        btn.textContent = '✓ Saved'; btn.classList.add('btn-success');
        setTimeout(() => {
          document.body.classList.remove('editing');
          btn.disabled = false; btn.textContent = 'Save'; btn.classList.remove('btn-success');
        }, 800);
      } catch(e) {
        btn.textContent = '⚠ Failed'; btn.disabled = false;
        setTimeout(() => { btn.textContent = 'Save'; }, 2000);
      }
    }
  </script>
</body>
</html>`;

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const markdown = await getMarkdown(id);
  if (!markdown) {
    return res.status(404).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not found — mdshare</title></head>
      <body style="font-family:'DM Sans',sans-serif;background:oklch(97.5% 0.005 80);display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;color:oklch(38% 0.015 260)">
      <p style="font-size:2rem">✦</p>
      <h2 style="font-family:'Instrument Serif',serif;color:oklch(16% 0.01 260)">Link expired</h2>
      <p style="font-size:14px">This share link has expired or doesn't exist.</p>
      <a href="/" style="font-size:14px;color:oklch(52% 0.18 250)">← back to mdshare</a>
      </body></html>`);
  }

  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
  const authed = isAuthenticated(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'self'");
  return res.send(HTML_TEMPLATE(markdown, title, id, authed));
}
