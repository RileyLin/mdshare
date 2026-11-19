// e2e/_cdn-stubs.mjs
//
// render.js / diagram-render.js / archify-render.js load marked.js, highlight.js, DOMPurify, and
// mermaid from public CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net) plus Google Fonts. This
// sandbox's egress proxy refuses those hosts (confirmed while building this harness — the real
// request just hangs/never resolves), and even if it didn't, a "local-only, no network calls"
// harness should not depend on the real CDNs being reachable at all.
//
// installCdnStubs(context) intercepts those exact requests and fulfills them locally with small
// stand-ins that implement just enough of each library's API surface for the app's own inline
// <script> (the real, unmodified code under test) to actually execute and produce real DOM
// (headings, tables, etc.) — so render assertions are verifying the app's real client-side script
// running, not a bypassed/mocked render path. Font requests are stubbed with empty responses
// (cosmetic only, nothing under test depends on the actual font bytes).
const MARKED_STUB = `(function(){
  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function Renderer(){}
  Renderer.prototype.table = function(header, body) {
    return '<table><thead>' + header + '</thead><tbody>' + body + '</tbody></table>';
  };
  var customRenderer = null;
  var opts = {};
  function parseInline(s) {
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    s = s.replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2">$1</a>');
    return s;
  }
  function cells(line) { return line.trim().replace(/^\\||\\|$/g,'').split('|').map(function(c){return c.trim();}); }
  function parseTableBlock(lines) {
    var headCells = cells(lines[0]);
    var headerHtml = '<tr>' + headCells.map(function(c){return '<th>'+parseInline(escapeHtml(c))+'</th>';}).join('') + '</tr>';
    var bodyRows = lines.slice(2).map(function(l){ return '<tr>' + cells(l).map(function(c){return '<td>'+parseInline(escapeHtml(c))+'</td>';}).join('') + '</tr>'; });
    var renderer = customRenderer || new Renderer();
    return renderer.table(headerHtml, bodyRows.join(''));
  }
  function parse(md) {
    var lines = String(md).split('\\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var h = line.match(/^(#{1,6})\\s+(.+)$/);
      if (h) { var n = h[1].length; out.push('<h'+n+'>'+parseInline(escapeHtml(h[2].trim()))+'</h'+n+'>'); i++; continue; }
      if (line.trim().indexOf('\`\`\`') === 0) {
        var lang = line.trim().slice(3).trim();
        var codeLines = []; i++;
        while (i < lines.length && lines[i].trim().indexOf('\`\`\`') !== 0) { codeLines.push(lines[i]); i++; }
        i++;
        var codeHtml = escapeHtml(codeLines.join('\\n'));
        if (opts.highlight) { try { var r = opts.highlight(codeLines.join('\\n'), lang); if (typeof r === 'string') codeHtml = r; } catch(e){} }
        out.push('<pre><code class="language-'+escapeHtml(lang)+'">'+codeHtml+'</code></pre>');
        continue;
      }
      if (/^\\s*\\|.*\\|\\s*$/.test(line) && i+1 < lines.length && /^\\s*\\|?[\\s:|-]+\\|?\\s*$/.test(lines[i+1])) {
        var tbl = [line, lines[i+1]]; i += 2;
        while (i < lines.length && /^\\s*\\|.*\\|\\s*$/.test(lines[i])) { tbl.push(lines[i]); i++; }
        out.push(parseTableBlock(tbl));
        continue;
      }
      if (line.trim() === '') { i++; continue; }
      out.push('<p>'+parseInline(escapeHtml(line))+'</p>');
      i++;
    }
    return out.join('\\n');
  }
  window.marked = {
    Renderer: Renderer,
    use: function(o) { if (o && o.renderer) customRenderer = o.renderer; },
    setOptions: function(o) { opts = Object.assign(opts, o || {}); },
    parse: parse,
  };
})();`;

const HLJS_STUB = `(function(){
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
  window.hljs = {
    getLanguage: function(lang){ return lang ? {} : null; },
    highlight: function(code, o){ return { value: esc(code) }; },
    highlightAuto: function(code){ return { value: esc(code) }; },
    highlightAll: function(){},
  };
})();`;

const DOMPURIFY_STUB = `(function(){
  // Identity passthrough — this harness is verifying render wiring, not DOMPurify's own XSS
  // defenses, which are out of scope for a local runtime-verification pass.
  window.DOMPurify = { sanitize: function(html){ return html; } };
})();`;

const MERMAID_STUB = `(function(){
  window.mermaid = { initialize: function(){}, run: function(){} };
})();`;

function stubFor(url) {
  if (/marked/i.test(url)) return { body: MARKED_STUB, type: 'application/javascript' };
  if (/highlight\.js.*\.js$/i.test(url)) return { body: HLJS_STUB, type: 'application/javascript' };
  if (/highlight\.js.*\.css$/i.test(url)) return { body: '', type: 'text/css' };
  if (/dompurify/i.test(url)) return { body: DOMPURIFY_STUB, type: 'application/javascript' };
  if (/mermaid/i.test(url)) return { body: MERMAID_STUB, type: 'application/javascript' };
  if (/\.css(\?|$)/i.test(url)) return { body: '', type: 'text/css' };
  return { body: '', type: 'application/javascript' };
}

export async function installCdnStubs(context) {
  await context.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, (route) => {
    const { body, type } = stubFor(route.request().url());
    route.fulfill({ status: 200, contentType: type, body });
  });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => {
    route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
}
