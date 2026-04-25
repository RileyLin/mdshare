// GET /api/render?id=xxx — returns rendered HTML
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
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.6.1/github-markdown-light.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <style>
    body { background: #ffffff; margin: 0; padding: 0; }
    .markdown-body {
      box-sizing: border-box;
      min-width: 200px;
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 24px;
    }
    .top-bar {
      background: #f6f8fa;
      border-bottom: 1px solid #d0d7de;
      padding: 10px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      color: #57606a;
      flex-wrap: wrap;
      gap: 8px;
    }
    .top-bar a { color: #0969da; text-decoration: none; font-weight: 500; }
    .top-bar a:hover { text-decoration: underline; }
    .badge {
      background: #dafbe1; color: #116329;
      border: 1px solid #aceebb; border-radius: 2em;
      padding: 2px 10px; font-size: 12px; font-weight: 500;
    }
    .top-bar-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .btn {
      background: #f6f8fa;
      color: #24292f;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      transition: background 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .btn:hover:not(:disabled) {
      background: #eaeef2;
      border-color: #b7bfc8;
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-success {
      background: #dafbe1;
      color: #116329;
      border-color: #aceebb;
    }
    /* Save dropdown */
    .save-dropdown-wrapper {
      position: relative;
      display: inline-block;
    }
    .save-menu {
      display: none;
      position: absolute;
      right: 0;
      top: calc(100% + 4px);
      background: #ffffff;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      box-shadow: 0 8px 24px rgba(140,149,159,0.2);
      min-width: 170px;
      z-index: 100;
      overflow: hidden;
    }
    .save-menu.open { display: block; }
    .save-menu-item {
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      padding: 8px 14px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #24292f;
      cursor: pointer;
      white-space: nowrap;
    }
    .save-menu-item:hover { background: #f6f8fa; }
    @media (max-width: 600px) { .markdown-body { padding: 20px 16px; } }
  </style>
</head>
<body>
  <div class="top-bar">
    <span>📄 <strong><a href="/">mdshare</a></strong> — rendered markdown</span>
    <div class="top-bar-actions">
      <button class="btn" id="btn-download" onclick="downloadMd()">⬇ Download .md</button>
      <button class="btn" id="btn-copy" onclick="copyMd()">📋 Copy markdown</button>
      <div class="save-dropdown-wrapper" id="save-wrapper">
        <button class="btn" id="btn-save" onclick="toggleSaveMenu(event)">📌 Save ▾</button>
        <div class="save-menu" id="save-menu">
          <button class="save-menu-item" id="btn-pin" onclick="pinPaste()">📌 Pin (keep forever)</button>
          <button class="save-menu-item" id="btn-notion" onclick="saveToNotion()">🔗 Save to Notion</button>
        </div>
      </div>
      <span class="badge">✓ rendered</span>
    </div>
  </div>
  <div class="markdown-body" id="content">Loading...</div>
  <script>
    const raw = ${JSON.stringify(content)};
    const pasteId = ${JSON.stringify(id)};
    const pasteTitle = ${JSON.stringify(title)};

    marked.setOptions({
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      }
    });
    document.getElementById('content').innerHTML = marked.parse(raw);
    hljs.highlightAll();

    // Feature 1: Download .md
    function downloadMd() {
      const filename = (pasteTitle || ('mdshare-' + pasteId))
        .replace(/[^a-z0-9_\\-. ]/gi, '_')
        .trim() + '.md';
      const blob = new Blob([raw], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    // Feature 2: Copy markdown
    async function copyMd() {
      const btn = document.getElementById('btn-copy');
      try {
        await navigator.clipboard.writeText(raw);
        btn.textContent = '✓ Copied!';
        btn.classList.add('btn-success');
        setTimeout(() => {
          btn.textContent = '📋 Copy markdown';
          btn.classList.remove('btn-success');
        }, 2000);
      } catch (e) {
        btn.textContent = '⚠ Failed';
        setTimeout(() => { btn.textContent = '📋 Copy markdown'; }, 2000);
      }
    }

    // Feature 3: Save dropdown
    function toggleSaveMenu(e) {
      e.stopPropagation();
      document.getElementById('save-menu').classList.toggle('open');
    }
    document.addEventListener('click', () => {
      document.getElementById('save-menu').classList.remove('open');
    });

    async function pinPaste() {
      document.getElementById('save-menu').classList.remove('open');
      const btn = document.getElementById('btn-pin');
      const saveBtn = document.getElementById('btn-save');
      btn.disabled = true;
      btn.textContent = 'Pinning...';
      try {
        const res = await fetch('/api/pin', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pasteId }),
        });
        if (!res.ok) throw new Error('Server error');
        btn.textContent = '✓ Pinned!';
        saveBtn.textContent = '✓ Pinned ▾';
        saveBtn.classList.add('btn-success');
        saveBtn.disabled = true;
      } catch (e) {
        btn.textContent = '⚠ Failed — retry';
        btn.disabled = false;
      }
    }

    async function saveToNotion() {
      document.getElementById('save-menu').classList.remove('open');
      const btn = document.getElementById('btn-notion');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/save-to-notion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pasteId }),
        });
        if (!res.ok) throw new Error('Server error');
        const data = await res.json();
        btn.textContent = '✓ Saved to Notion';
        // Add a link next to the save button
        const wrapper = document.getElementById('save-wrapper');
        const link = document.createElement('a');
        link.href = data.notionUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '↗ Open in Notion';
        link.style.cssText = 'font-size:12px;color:#0969da;text-decoration:none;white-space:nowrap;';
        link.onmouseover = () => link.style.textDecoration = 'underline';
        link.onmouseout = () => link.style.textDecoration = 'none';
        wrapper.parentNode.insertBefore(link, wrapper.nextSibling);
      } catch (e) {
        btn.textContent = '⚠ Failed — retry';
        btn.disabled = false;
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
    return res.status(404).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>Not found</h2><p>This share link has expired or doesn't exist.</p>
      <a href="/">← mdshare home</a></body></html>`);
  }

  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  return res.send(HTML_TEMPLATE(markdown, title, id));
}
