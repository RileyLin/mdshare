// GET /api/render?id=xxx — returns rendered HTML (redesigned UI + all actions)
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

const HTML_TEMPLATE = (content, title, id) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title.replace(/</g,'&lt;')} — mdshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
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

    /* Content */
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
    #content code { font-size: 0.875em; background: color-mix(in oklch, var(--accent) 8%, var(--paper)); color: var(--accent); border-radius: 4px; padding: 2px 5px; }
    #content pre { background: oklch(14% 0.01 260); border-radius: 10px; padding: 1.25rem 1.5rem; overflow-x: auto; margin: 0 0 1.25rem; }
    #content pre code { background: none; color: oklch(85% 0.01 260); font-size: 0.875rem; padding: 0; }
    #content blockquote { border-left: 3px solid var(--accent); margin: 0 0 1rem; padding: 0.5rem 1rem; color: var(--ink-2); font-style: italic; }
    #content hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
    .table-wrap { overflow-x: auto; margin: 0 0 1.25rem; }
    #content table { border-collapse: collapse; width: 100%; font-size: 14px; }
    #content th { text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); padding: 8px 12px; border-bottom: 2px solid var(--border); }
    #content td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    #content tr:hover td { background: color-mix(in oklch, var(--accent) 4%, var(--paper)); }
    @media (max-width: 600px) { .doc-title { display: none; } }
  </style>
</head>
<body>
  <div class="top-bar">
    <a class="wordmark" href="/"><span class="wordmark-dot"></span>mdshare</a>
    <span class="doc-title" id="doc-title"></span>
    <div class="top-bar-actions">
      <button class="btn" id="btn-download" onclick="downloadMd()">⬇ Download</button>
      <button class="btn" id="btn-copy" onclick="copyMd()">📋 Copy</button>
      <div class="save-dropdown-wrapper" id="save-wrapper">
        <button class="btn" id="btn-save" onclick="toggleSaveMenu(event)">📌 Save ▾</button>
        <div class="save-menu" id="save-menu">
          <button class="save-menu-item" id="btn-pin" onclick="pinPaste()">📌 Pin (keep forever)</button>
          <button class="save-menu-item" id="btn-notion" onclick="saveToNotion()">🔗 Save to Notion</button>
        </div>
      </div>
      <span class="badge">rendered</span>
    </div>
  </div>
  <div class="content-wrap">
    <div id="content">Loading…</div>
  </div>
  <script>
    const raw = ${JSON.stringify(content)};
    const pasteId = ${JSON.stringify(id)};
    const pasteTitle = ${JSON.stringify(title)};

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
    document.getElementById('content').innerHTML = marked.parse(raw);
    hljs.highlightAll();
    const h1 = document.querySelector('#content h1');
    if (h1) document.getElementById('doc-title').textContent = h1.textContent;

    function downloadMd() {
      const filename = (pasteTitle || ('mdshare-' + pasteId)).replace(/[^a-z0-9_\\-. ]/gi, '_').trim() + '.md';
      const blob = new Blob([raw], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
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

    function toggleSaveMenu(e) {
      e.stopPropagation();
      document.getElementById('save-menu').classList.toggle('open');
    }
    document.addEventListener('click', () => document.getElementById('save-menu').classList.remove('open'));

    async function pinPaste() {
      document.getElementById('save-menu').classList.remove('open');
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

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  return res.send(HTML_TEMPLATE(markdown, title, id));
}
