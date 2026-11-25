// Publish checks: a fast, deterministic read of the Markdown an agent just sent, returned with the
// create response so the agent learns about a broken page before the reader does. It never
// changes what is stored (stored Markdown is never rewritten) and never blocks a create.
// Severity "warn" = the page will look broken or lose content; "info" = worth knowing.
// tests/lint.test.mjs has a firing and a must-not-fire case for every rule; the directive list is
// checked against public/assets/render.js so the two can't drift.

export const DIRECTIVES = ['summary', 'stats', 'steps', 'compare', 'cards', 'tabs', 'note', 'tip', 'warning', 'important', 'caution', 'table'];

const MERMAID_TYPES = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey(-beta)?|xychart(-beta)?|block(-beta)?|packet(-beta)?|kanban|architecture(-beta)?|radar(-beta)?|treemap(-beta)?|C4(Context|Container|Component|Dynamic|Deployment)|zenuml|%%)/;
const REDACTED = /__OPENCLAW_REDACTED__|\[REDACTED\]|Bearer \*\*\*|<redacted>/i;
const STRIPPED_HTML = /<\s*(script|iframe|style|object|embed|form|input|button|link|meta)\b|\son[a-z]+\s*=\s*["']/i;
const LOCAL_LINK = /\]\(\s*<?(file:|https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\/home\/|\/tmp\/|\/Users\/|[A-Za-z]:\\)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Cells in one Markdown table row: split on pipes that are not escaped and not inside `code`.
export function tableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const looksLikeRow = (line) => line.includes('|') && line.trim() !== '';

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, '');
}

export function lintMarkdown(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  const lines = text.split('\n');
  const warnings = [];
  const add = (rule, severity, line, message) => {
    if (warnings.length < 50) warnings.push({ rule, severity, line, message });
  };
  const stats = { chars: text.length, cjk: 0, words: 0, minutes: 1, headings: 0, tables: 0, maxColumns: 0, codeBlocks: 0, mermaid: 0, links: 0 };

  // Frontmatter (--- ... ---) at the very top is not body text.
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) start = end + 1;
  }

  let fence = null; // { marker, line, lang, body: [] }
  let directive = null; // { name, line }
  let hasH1 = false;
  const prose = [];

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    const f = FENCE.exec(raw);
    if (fence) {
      if (f && f[1][0] === fence.marker[0] && f[1].length >= fence.marker.length && f[2].trim() === '') {
        if (fence.lang === 'mermaid') {
          stats.mermaid++;
          const first = fence.body.find((l) => l.trim() !== '');
          if (!first) add('mermaid-empty', 'warn', fence.line, 'This mermaid block is empty; the reader will show a blank diagram.');
          else if (!MERMAID_TYPES.test(first.trim())) add('mermaid-type', 'warn', fence.line, `This mermaid block starts with "${first.trim().slice(0, 40)}", which is not a diagram type (flowchart, sequenceDiagram, …); it will fail to draw.`);
        }
        fence = null;
      } else {
        fence.body.push(raw);
      }
      continue;
    }
    if (f) {
      stats.codeBlocks++;
      fence = { marker: f[1], line: n, lang: f[2].trim().split(/\s+/)[0].toLowerCase(), body: [] };
      continue;
    }

    const dm = /^:::([a-z]+)\b/.exec(raw);
    if (dm) {
      if (DIRECTIVES.includes(dm[1])) {
        if (directive) add('unclosed-block', 'warn', directive.line, `:::${directive.name} (line ${directive.line}) is not closed before :::${dm[1]} opens; add a line with just ::: after it.`);
        directive = { name: dm[1], line: n };
      } else {
        add('unknown-block', 'info', n, `:::${dm[1]} is not a block mdshare knows (${DIRECTIVES.join(', ')}); it will show as plain text.`);
      }
      continue;
    }
    if (/^:::\s*$/.test(raw)) { directive = null; continue; }

    if (/^#\s+\S/.test(raw)) hasH1 = true;
    if (/^#{1,6}\s+\S/.test(raw)) stats.headings++;
    if (/^MEDIA:/.test(raw)) add('media-line', 'warn', n, 'A "MEDIA:" line is a chat directive, not Markdown; it will show as text.');

    const code = stripInlineCode(raw);
    if (REDACTED.test(raw)) add('redacted', 'warn', n, 'This line contains a redaction placeholder (a masked token after "Bearer", __OPENCLAW_REDACTED__ or [REDACTED]); a real value was probably lost when the text was copied.');
    if (STRIPPED_HTML.test(code)) add('stripped-html', 'warn', n, 'Raw HTML here (script/iframe/style/form/event handler) is removed by the sanitizer; use Markdown instead.');
    if (LOCAL_LINK.test(code)) add('local-link', 'warn', n, 'This link points at a local file or localhost; readers can\'t open it.');
    stats.links += (code.match(/\]\(/g) || []).length;

    // Table: header row, separator row, body rows until a blank / non-row line.
    if (looksLikeRow(raw) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const cols = tableCells(raw).length;
      const sepCols = tableCells(lines[i + 1]).length;
      stats.tables++;
      stats.maxColumns = Math.max(stats.maxColumns, cols);
      if (sepCols !== cols) add('table-columns', 'warn', n + 1, `Table header has ${cols} columns but the separator row has ${sepCols}; the table won't render as a table.`);
      if (cols > 8) add('wide-table', 'info', n, `Table has ${cols} columns; readers on a phone will see cards or a scrolling table.`);
      let j = i + 2;
      for (; j < lines.length && looksLikeRow(lines[j]) && !FENCE.test(lines[j]); j++) {
        const rc = tableCells(lines[j]).length;
        if (rc > cols) add('table-columns', 'warn', j + 1, `This table row has ${rc} cells but the header has ${cols}; the extra cells are dropped (an unescaped | inside a cell? write \\|).`);
        else if (rc < cols) add('table-columns', 'info', j + 1, `This table row has ${rc} cells; the header has ${cols}, so the rest are blank.`);
        prose.push(lines[j]);
      }
      prose.push(raw);
      i = j - 1;
      continue;
    }
    prose.push(raw);
  }

  if (fence) add('unclosed-fence', 'warn', fence.line, `The code block opened on line ${fence.line} is never closed; everything after it shows as code.`);
  if (directive) add('unclosed-block', 'warn', directive.line, `:::${directive.name} (line ${directive.line}) is never closed; add a line with just ::: after it.`);
  if (!hasH1 && text.trim()) add('no-title', 'info', 1, 'No "# Title" line, so the page and the library show "Untitled".');
  if (!text.trim()) add('empty', 'warn', 1, 'The document is empty.');

  const body = prose.join('\n');
  stats.cjk = (body.match(/[\u3400-\u9fff]/g) || []).length;
  stats.words = (body.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  stats.minutes = Math.max(1, Math.round(stats.cjk / 400 + stats.words / 220));

  return { ok: !warnings.some((w) => w.severity === 'warn'), warnings, stats };
}
