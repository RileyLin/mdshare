// GET /d/:id — renders SVG diagram, with optional markdown writeup below

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getDiagram(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_diagrams?id=eq.${id}&select=svg,markdown,title,expires_at`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

const DIAGRAM_TEMPLATE = (svg, title, markdown) => `<!DOCTYPE html>
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
    <span class="badge">diagram${markdown ? ' + notes' : ''}</span>
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
</body>
</html>`;

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const row = await getDiagram(id);
  if (!row) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found — mdshare</title></head>
    <body style="font-family:'DM Sans',sans-serif;background:oklch(12% 0.008 260);display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;color:oklch(56% 0.01 260)">
      <p style="font-size:2rem">✦</p>
      <h2 style="font-family:Georgia,serif;color:oklch(88% 0.005 260)">Link expired</h2>
      <p style="font-size:14px">This diagram link has expired or doesn't exist.</p>
      <a href="/" style="font-size:14px;color:oklch(52% 0.18 250)">← back to mdshare</a>
    </body></html>`);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'self'");
  return res.send(DIAGRAM_TEMPLATE(row.svg, row.title || 'Diagram', row.markdown));
}
