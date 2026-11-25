// Publish checks (api/_lib/lint.js): every rule fires on a document that has the problem and stays
// quiet on look-alikes that are fine (must-not-fire). The block list must match the renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintMarkdown, DIRECTIVES, tableCells } from '../api/_lib/lint.js';

const rules = (md) => lintMarkdown(md).warnings.map((w) => w.rule);
const warnRules = (md) => lintMarkdown(md).warnings.filter((w) => w.severity === 'warn').map((w) => w.rule);

test('directive list matches public/assets/render.js', () => {
  const src = readFileSync(new URL('../public/assets/render.js', import.meta.url), 'utf8');
  const m = /var DIRECTIVES = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'render.js still declares DIRECTIVES');
  assert.deepEqual(m[1].match(/'[^']+'/g).map((s) => s.slice(1, -1)), DIRECTIVES);
});

const FIRES = {
  'unclosed-fence': '# T\n\n```js\nconst a = 1;\n\nmore text',
  'unclosed-block': '# T\n\n:::steps\n### One\ntext\n',
  'unknown-block': '# T\n\n:::sidebar\nx\n:::\n',
  'table-columns': '# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n',
  'mermaid-empty': '# T\n\n```mermaid\n\n```\n',
  'mermaid-type': '# T\n\n```mermaid\nA --> B\n```\n',
  redacted: '# T\n\ncurl -H "Authorization: Bearer ' + '*'.repeat(3) + '" https://x\n',
  'stripped-html': '# T\n\n<iframe src="https://x"></iframe>\n',
  'local-link': '# T\n\nSee [the file](/home/node/report.md).\n',
  'media-line': '# T\n\nMEDIA:/tmp/a.png\n',
  'no-title': 'Just text, no heading.\n',
  'wide-table': '# T\n\n| a | b | c | d | e | f | g | h | i |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |\n',
  empty: '   \n',
};

for (const [rule, md] of Object.entries(FIRES)) {
  test(`fires: ${rule}`, () => assert.ok(rules(md).includes(rule), `${rule} not in ${JSON.stringify(rules(md))}`));
}

test('separator with the wrong column count is a warning', () => {
  assert.ok(warnRules('# T\n\n| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |\n').includes('table-columns'));
});

test('short rows are only info (marked pads them), long rows are a warning (cells are dropped)', () => {
  const short = lintMarkdown('# T\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n').warnings.find((w) => w.rule === 'table-columns');
  assert.equal(short.severity, 'info');
  const long = lintMarkdown('# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n').warnings.find((w) => w.rule === 'table-columns');
  assert.equal(long.severity, 'warn');
  assert.equal(long.line, 5);
});

const QUIET = [
  ['pipes inside code spans and escaped pipes', '# T\n\n| cmd | note |\n| --- | --- |\n| `a | b` | x \\| y |\n'],
  ['a table inside a code block', '# T\n\n```\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n```\n'],
  ['tilde fences and longer fences', '# T\n\n~~~py\nprint(1)\n~~~\n\n````md\n```js\nx\n```\n````\n'],
  ['*** as a horizontal rule and bold-italic', '# T\n\n***\n\n***really*** important\n'],
  ['closed known directives', '# T\n\n:::steps\n### One\nx\n:::\n\n:::note Heads up\ny\n:::\n'],
  ['a valid mermaid diagram with init', '# T\n\n```mermaid\n%%{init: {"theme":"dark"}}%%\nflowchart LR\nA-->B\n```\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```\n'],
  ['html mentioned in inline code', '# T\n\nUse `<script>` tags carefully and `onclick="x"` is bad.\n'],
  ['links to real sites and localhost in code', '# T\n\n[site](https://example.com) and `http://localhost:3000`\n\n```\ncurl http://127.0.0.1:8080\n```\n'],
  ['frontmatter before the title', '---\ntables: cards\n---\n# T\n\ntext\n'],
  ['CJK table', '# 标题\n\n| 方式 | 说明 |\n| --- | --- |\n| 甲 | 很长的一段说明 |\n'],
];
for (const [name, md] of QUIET) {
  test(`quiet: ${name}`, () => {
    const r = lintMarkdown(md);
    assert.equal(r.ok, true, JSON.stringify(r.warnings));
    assert.deepEqual(r.warnings.filter((w) => w.rule !== 'wide-table'), [], JSON.stringify(r.warnings));
  });
}

test('stats: reading time and counts', () => {
  const md = '# 标题\n\n' + '中'.repeat(800) + '\n\n' + 'word '.repeat(220) + '\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx\n```\n';
  const s = lintMarkdown(md).stats;
  assert.equal(s.minutes, 3);
  assert.equal(s.tables, 1);
  assert.equal(s.maxColumns, 2);
  assert.equal(s.codeBlocks, 1);
  assert.equal(s.headings, 1);
});

test('tableCells splits on real pipes only', () => {
  assert.equal(tableCells('| a | `b|c` | d \\| e |').length, 3);
  assert.equal(tableCells('a | b').length, 2);
});

test('warnings are capped and never throw on odd input', () => {
  assert.ok(lintMarkdown('MEDIA:x\n'.repeat(200)).warnings.length <= 50);
  for (const v of [undefined, null, 42, '', '\n\n|', '```', ':::']) assert.doesNotThrow(() => lintMarkdown(v));
});

test('single-hyphen delimiter rows are tables too (marked renders them), so bad rows still warn', () => {
  const r = lintMarkdown('# T\n\n| a | b |\n| - | - |\n| 1 | 2 | 3 |\n');
  assert.equal(r.stats.tables, 1);
  assert.ok(r.warnings.some((w) => w.rule === 'table-columns' && w.severity === 'warn' && w.line === 5), JSON.stringify(r.warnings));
  const bare = lintMarkdown('# T\n\na | b\n- | -\n1 | 2\n');
  assert.equal(bare.stats.tables, 1);
  assert.equal(bare.ok, true, JSON.stringify(bare.warnings));
});

test('must not fire: a rule or a bullet under a line with a pipe is not a table', () => {
  const r = lintMarkdown('# T\n\nuse a | b here\n---\n\nx | y\n- item\n');
  assert.equal(r.stats.tables, 0, JSON.stringify(r));
  assert.ok(!r.warnings.some((w) => w.rule === 'table-columns'));
});
