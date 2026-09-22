// GET /d/:id — renders SVG diagram, with optional markdown writeup below. Private unless the
// owner is authenticated or the row has is_public: true. Unauthenticated requests to a private id
// get a same-URL login prompt instead of the diagram's title/content.
import { isAuthenticated, checkAuthAndRefresh } from './auth.js';
import { getRow, isVisible, setPrivacyHeaders, privateGateHtml, visibilityControlHtml, visibilityControlScript } from './_lib/access.js';

const DIAGRAM_TEMPLATE = (svg, title, markdown, id, authed = false, isPublic = false) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title.replace(/</g, '&lt;')} — mdshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap" rel="stylesheet">
  ${markdown ? `
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"><\/script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
  ` : ''}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --ink: oklch(16% 0.01 260);
      --ink-2: oklch(38% 0.015 260);
      --ink-3: oklch(56% 0.01 260);
      --paper: oklch(97.5% 0.005 80);
      --paper-2: oklch(94% 0.008 80);
      --border: oklch(86% 0.01 80);
      --border-strong: oklch(78% 0.015 80);
      --accent: oklch(52% 0.18 250);
      --canvas: oklch(12% 0.008 260);
      --canvas-2: oklch(16% 0.008 260);
      --canvas-border: oklch(22% 0.008 260);
    }
    html { -webkit-font-smoothing: antialiased; }
    body { font-family: 'DM Sans', sans-serif; background: var(--canvas); color: var(--ink); }

    /* ── TOP BAR ── */
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 50;
      height: 50px;
      padding: 0 clamp(16px, 3vw, 40px);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: color-mix(in oklch, var(--canvas) 90%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--canvas-border);
    }
    .wordmark {
      font-family: 'Instrument Serif', serif;
      font-size: 1.1rem;
      color: oklch(88% 0.005 260);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .wordmark-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); display: inline-block; }
    .diag-title {
      font-size: 13px;
      color: oklch(56% 0.01 260);
      font-weight: 400;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 280px;
    }
    .badge {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--accent);
      background: oklch(20% 0.05 250);
      border: 1px solid oklch(30% 0.08 250);
      border-radius: 100px;
      padding: 3px 10px;
    }

    /* ── ACTION BAR ── */
    .top-bar-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .btn {
      font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 500;
      color: oklch(72% 0.01 260); background: transparent;
      border: 1px solid var(--canvas-border); border-radius: 6px;
      padding: 5px 11px; cursor: pointer; white-space: nowrap;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .btn:hover:not(:disabled) { background: oklch(22% 0.05 250); border-color: var(--accent); color: oklch(82% 0.14 250); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-success { color: oklch(78% 0.13 145) !important; border-color: oklch(50% 0.13 145) !important; background: oklch(24% 0.05 145) !important; }
    .save-dropdown-wrapper { position: relative; display: inline-block; }
    .save-menu {
      display: none; position: absolute; right: 0; top: calc(100% + 6px);
      background: var(--canvas-2); border: 1px solid var(--canvas-border); border-radius: 8px;
      box-shadow: 0 8px 24px oklch(0% 0 0 / 40%);
      min-width: 180px; z-index: 100; overflow: hidden;
    }
    .save-menu.open { display: block; }
    .save-menu-item {
      display: block; width: 100%; text-align: left;
      background: none; border: none; padding: 9px 14px;
      font-size: 13px; font-family: 'DM Sans', sans-serif; color: oklch(72% 0.01 260);
      cursor: pointer; white-space: nowrap;
    }
    .save-menu-item:hover { background: oklch(22% 0.05 250); color: oklch(82% 0.14 250); }
    @media print {
      .top-bar { display: none !important; }
    }

    /* ── DIAGRAM CANVAS ── */
    .diagram-section {
      padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 40px);
      min-height: 40vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .diagram-title-row {
      width: 100%;
      max-width: 1200px;
      margin-bottom: 20px;
      display: flex;
      align-items: baseline;
      gap: 12px;
    }
    .diagram-title-text {
      font-family: 'Instrument Serif', serif;
      font-size: clamp(1.3rem, 2.5vw, 1.8rem);
      letter-spacing: -0.01em;
      color: oklch(88% 0.005 260);
    }
    .diagram-title-line {
      flex: 1;
      height: 1px;
      background: var(--canvas-border);
    }

    .svg-frame {
      width: 100%;
      max-width: 1200px;
      background: var(--canvas-2);
      border: 1px solid var(--canvas-border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 32px oklch(0% 0 0 / 0.4);
      opacity: 0;
      animation: fadeUp 0.4s 0.05s cubic-bezier(0.16,1,0.3,1) forwards;
    }
    .svg-frame svg {
      width: 100%;
      height: auto;
      display: block;
    }
    /* If SVG has light/white bg, add subtle inner border */
    .svg-frame.light-bg {
      background: oklch(99% 0.003 80);
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ── DIVIDER ── */
    .section-divider {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 0 clamp(16px, 3vw, 40px);
      margin-bottom: 0;
    }
    .section-divider-line { flex: 1; height: 1px; background: var(--border); }
    .section-divider-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-3);
    }

    /* ── NOTES SECTION ── */
    .notes-section {
      background: var(--paper);
      padding: clamp(28px, 5vw, 56px) clamp(20px, 4vw, 48px) 80px;
    }
    .notes-wrap {
      max-width: 780px;
      margin: 0 auto;
      opacity: 0;
      animation: fadeUp 0.4s 0.15s cubic-bezier(0.16,1,0.3,1) forwards;
    }

    /* ── MARKDOWN IN NOTES ── */
    #md-content h1 {
      font-family: 'Instrument Serif', serif;
      font-size: clamp(1.7rem, 3.5vw, 2.3rem);
      line-height: 1.15;
      letter-spacing: -0.02em;
      margin-bottom: 18px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border);
    }
    #md-content h2 {
      font-family: 'Instrument Serif', serif;
      font-size: 1.4rem;
      letter-spacing: -0.01em;
      color: var(--ink);
      margin-top: 40px;
      margin-bottom: 12px;
    }
    #md-content h3 { font-size: 1rem; font-weight: 600; margin-top: 28px; margin-bottom: 10px; }
    #md-content p { font-size: 1rem; line-height: 1.75; color: var(--ink-2); font-weight: 300; margin-bottom: 14px; }
    #md-content strong { color: var(--ink); font-weight: 600; }
    #md-content a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
    #md-content ul, #md-content ol { padding-left: 1.4em; margin-bottom: 14px; }
    #md-content li { font-size: 1rem; line-height: 1.7; color: var(--ink-2); font-weight: 300; margin-bottom: 3px; }
    #md-content li strong { color: var(--ink); }
    #md-content code {
      font-family: 'Menlo', 'Monaco', monospace;
      font-size: 0.85em;
      background: var(--paper-2);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      color: oklch(44% 0.12 250);
    }
    #md-content pre {
      background: oklch(13% 0.01 260);
      border: 1px solid oklch(22% 0.01 260);
      border-radius: 10px;
      padding: 16px 18px;
      overflow-x: auto;
      margin-bottom: 18px;
    }
    #md-content pre code { background: none; border: none; padding: 0; font-size: 13px; color: oklch(80% 0.04 240); }
    .table-wrap { overflow-x: auto; margin-bottom: 22px; border: 1px solid var(--border); border-radius: 10px; }
    .table-wrap table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .table-wrap thead { background: oklch(13% 0.01 260); }
    .table-wrap thead th {
      padding: 9px 13px;
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: oklch(65% 0.04 260);
      border-bottom: 1px solid oklch(24% 0.01 260);
    }
    .table-wrap thead th:first-child { border-radius: 9px 0 0 0; }
    .table-wrap thead th:last-child { border-radius: 0 9px 0 0; }
    .table-wrap tbody tr { border-bottom: 1px solid var(--border); transition: background 0.1s; }
    .table-wrap tbody tr:hover { background: var(--paper-2); }
    .table-wrap tbody tr:last-child { border-bottom: none; }
    .table-wrap td { padding: 10px 13px; color: var(--ink-2); font-weight: 300; vertical-align: top; }
    .table-wrap td strong { color: var(--ink); }
    #md-content hr { border: none; border-top: 1px solid var(--border); margin: 36px 0; }
    #md-content blockquote { border-left: 3px solid var(--accent); padding-left: 16px; color: var(--ink-3); font-style: italic; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="top-bar">
    <a class="wordmark" href="/"><span class="wordmark-dot"></span>mdshare</a>
    <span class="diag-title">${title.replace(/</g, '&lt;')}</span>
    <div class="top-bar-actions">
      ${markdown ? '<button class="btn" id="btn-copy" onclick="copyNotes()">📋 Copy notes</button>' : ''}
      <button class="btn" id="btn-pdf" onclick="window.print()">📄 PDF</button>
      ${authed ? visibilityControlHtml(isPublic) : ''}
      <div class="save-dropdown-wrapper" id="save-wrapper">
        <button class="btn" id="btn-save" onclick="toggleSaveMenu(event)">📌 Save ▾</button>
        <div class="save-menu" id="save-menu">
          <button class="save-menu-item" id="btn-pin" onclick="pinDiagram()">📌 Pin (keep forever)</button>
          <button class="save-menu-item" id="btn-notion" onclick="saveToNotion()">🔗 Save to Notion</button>
        </div>
      </div>
      <span class="badge">diagram${markdown ? ' + notes' : ''}</span>
    </div>
  </div>

  <div class="diagram-section">
    <div class="diagram-title-row">
      <span class="diagram-title-text">${title.replace(/</g, '&lt;')}</span>
      <span class="diagram-title-line"></span>
    </div>
    <div class="svg-frame" id="svg-frame">
      ${svg}
    </div>
  </div>

  ${markdown ? `
  <div class="section-divider">
    <span class="section-divider-line"></span>
    <span class="section-divider-label">Notes</span>
    <span class="section-divider-line"></span>
  </div>
  <div class="notes-section">
    <div class="notes-wrap">
      <div id="md-content">Loading…</div>
    </div>
  </div>
  <script>
    const raw = ${JSON.stringify(markdown)};
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
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
      }
    });
    document.getElementById('md-content').innerHTML = marked.parse(raw);
    hljs.highlightAll();
  <\/script>
  ` : ''}

  <script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js"><\/script>
  <script>
    // Auto-detect light SVG backgrounds and adjust frame
    const frame = document.getElementById('svg-frame');
    if (frame) frame.innerHTML = DOMPurify.sanitize(frame.innerHTML, {USE_PROFILES: {svg: true, svgFilters: true}, FORBID_TAGS: ['script'], FORBID_ATTR: ['onload','onerror','onclick','onmouseover','onfocus','onblur']});
    const svgEl = frame && frame.querySelector('svg');
    if (svgEl) {
      const bg = svgEl.getAttribute('style') || '';
      const firstRect = svgEl.querySelector('rect');
      const fill = firstRect ? firstRect.getAttribute('fill') : '';
      // If light bg detected, switch frame style
      if (fill && (fill.startsWith('#f') || fill.startsWith('#e') || fill === 'white' || fill === '#fff' || fill === '#ffffff')) {
        frame.classList.add('light-bg');
      }
    }
  <\/script>

  <script>
    const diagramId = ${JSON.stringify(id)};
    const diagramMarkdown = ${JSON.stringify(markdown || '')};

    function toggleSaveMenu(e) {
      e.stopPropagation();
      document.getElementById('save-menu').classList.toggle('open');
    }
    document.addEventListener('click', () => {
      const m = document.getElementById('save-menu');
      if (m) m.classList.remove('open');
    });

    async function copyNotes() {
      const btn = document.getElementById('btn-copy');
      if (!btn) return;
      try {
        await navigator.clipboard.writeText(diagramMarkdown);
        btn.textContent = '✓ Copied'; btn.classList.add('btn-success');
        setTimeout(() => { btn.textContent = '📋 Copy notes'; btn.classList.remove('btn-success'); }, 2000);
      } catch(e) {
        btn.textContent = '⚠ Failed';
        setTimeout(() => { btn.textContent = '📋 Copy notes'; }, 2000);
      }
    }

    async function requireAuth() {
      const res = await fetch('/api/auth');
      if (res.ok) return true;
      if (confirm('Sign in required to save. Go to login?')) {
        window.location.href = '/dashboard';
      }
      return false;
    }

    async function pinDiagram() {
      document.getElementById('save-menu').classList.remove('open');
      if (!(await requireAuth())) return;
      const btn = document.getElementById('btn-pin');
      const saveBtn = document.getElementById('btn-save');
      btn.disabled = true; btn.textContent = 'Pinning…';
      try {
        const res = await fetch('/api/pin', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: diagramId, type: 'diagram' }),
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
          body: JSON.stringify({ id: diagramId, type: 'diagram' }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        btn.textContent = '✓ Saved to Notion';
        const wrapper = document.getElementById('save-wrapper');
        const link = document.createElement('a');
        link.href = data.notionUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = '↗ Open in Notion';
        link.style.cssText = 'font-size:12px;color:oklch(82% 0.14 250);text-decoration:underline;text-underline-offset:3px;white-space:nowrap;font-family:DM Sans,sans-serif;margin-left:6px;';
        wrapper.parentNode.insertBefore(link, wrapper.nextSibling);
      } catch(e) { btn.textContent = '⚠ Failed — retry'; btn.disabled = false; }
    }

    ${authed ? visibilityControlScript(id, 'diagram', isPublic) : ''}
  <\/script>
</body>
</html>`;

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  setPrivacyHeaders(res);
  const { row, dbError } = await getRow('mdshare_diagrams', id, 'svg,markdown,title,expires_at,is_public');

  if (dbError) {
    return res.status(503).send('<!DOCTYPE html><html><body style="font-family:sans-serif;background:oklch(12% 0.008 260);color:oklch(88% 0.005 260);display:flex;align-items:center;justify-content:center;height:100vh">Temporarily unavailable — try again shortly.</body></html>');
  }

  if (!row) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found — mdshare</title></head>
    <body style="font-family:'DM Sans',sans-serif;background:oklch(12% 0.008 260);display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;color:oklch(56% 0.01 260)">
      <p style="font-size:2rem">✦</p>
      <h2 style="font-family:Georgia,serif;color:oklch(88% 0.005 260)">Link expired</h2>
      <p style="font-size:14px">This diagram link has expired or doesn't exist.</p>
      <a href="/" style="font-size:14px;color:oklch(52% 0.18 250)">← back to mdshare</a>
    </body></html>`);
  }

  if (!isVisible(row, req, res)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(privateGateHtml());
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'self'");
  const authed = checkAuthAndRefresh(req, res);
  return res.send(DIAGRAM_TEMPLATE(row.svg, row.title || 'Diagram', row.markdown, id, authed, row.is_public === true));
}
