// GET /api/render?id=xxx — returns rendered HTML
const { kv } = require('@vercel/kv');

const HTML_TEMPLATE = (content, title) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — mdshare</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.6.1/github-markdown-light.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <style>
    body {
      background: #ffffff;
      margin: 0;
      padding: 0;
    }
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
    }
    .top-bar a {
      color: #0969da;
      text-decoration: none;
      font-weight: 500;
    }
    .top-bar a:hover { text-decoration: underline; }
    .badge {
      background: #dafbe1;
      color: #116329;
      border: 1px solid #aceebb;
      border-radius: 2em;
      padding: 2px 10px;
      font-size: 12px;
      font-weight: 500;
    }
    @media (max-width: 600px) {
      .markdown-body { padding: 20px 16px; }
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <span>📄 <strong>mdshare</strong> — rendered markdown</span>
    <span class="badge">✓ rendered</span>
  </div>
  <div class="markdown-body" id="content">Loading...</div>
  <script>
    const raw = ${JSON.stringify(content)};
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
  </script>
</body>
</html>`;

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const markdown = await kv.get(`md:${id}`);
  if (!markdown) {
    return res.status(404).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>Not found</h2><p>This share link has expired or doesn't exist.</p>
      <a href="/">← mdshare home</a></body></html>`);
  }

  // Extract title from first H1
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  return res.send(HTML_TEMPLATE(markdown, title));
}
