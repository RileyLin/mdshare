// Server-side SVG sanitiser for stored diagrams (ADV-MU-A F1, 2026-11-27). No dependency:
// DOMPurify needs a DOM, which serverless functions don't have. Underscore directory: not a
// Vercel function.
//
// The input is tokenised and re-serialised from scratch, so the output is canonical markup the
// browser can only parse one way: allowlisted element names, plain attribute names, double-quoted
// and escaped values, escaped text. Comments, doctypes (entity definitions) and processing
// instructions (xml-stylesheet can load XSLT) are dropped. Dropped with everything inside them:
// script, foreignObject (HTML inside SVG), iframe/object/embed and any element outside the
// allowlist that is known to carry active content. Other unknown elements are unwrapped (their
// allowed children stay). Attributes: on* handlers are dropped; URL attributes keep only #fragment,
// relative, http(s), mailto and raster data:image URLs (no javascript:, no data:text/html); <use>
// may reference only a #fragment; animate/set that target href or a handler are dropped.
// This is defence in depth: GET /api/diagram also sends USER_CONTENT_CSP (sandbox, no script),
// and /d/:id inserts the SVG only after DOMPurify.

const ALLOWED = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata', 'switch', 'view',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'a', 'image', 'style', 'marker', 'pattern', 'clippath', 'mask',
  'lineargradient', 'radialgradient', 'stop', 'filter',
  'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
  'fediffuselighting', 'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca',
  'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge', 'femergenode',
  'femorphology', 'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile',
  'feturbulence', 'animate', 'animatetransform', 'animatemotion', 'mpath',
]);
// Removed together with their content.
const DROP_SUBTREE = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'handler', 'listener', 'set', 'html', 'body', 'head', 'meta', 'link', 'base', 'form', 'input', 'button', 'textarea', 'select', 'frame', 'frameset', 'applet', 'audio', 'video', 'canvas', 'template', 'noscript', 'math']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'from', 'to', 'values', 'by']);
const SAFE_NS = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/XML/1998/namespace']);
const ATTR_NAME = /^[A-Za-z_][\w.:-]*$/;
const TAG_NAME = /^[A-Za-z_][\w.:-]*$/;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (s) => s.replace(/&(?!(#x[0-9a-f]+|#\d+|[a-z]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const localName = (name) => name.slice(name.lastIndexOf(':') + 1).toLowerCase();

// Characters a URL parser skips or a reader can't see: C0 controls and space, DEL and C1, soft
// hyphen, zero-width and bidi marks, line/paragraph separators, BOM.
const INVISIBLE = (n) => n <= 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0xad || (n >= 0x200b && n <= 0x200f) || n === 0x2028 || n === 0x2029 || n === 0xfeff;

// Is this URL value safe in an SVG attribute? Control characters and whitespace are ignored by URL
// parsers inside a scheme ("java\tscript:"), so they are removed before looking at the scheme.
export function safeSvgUrl(value, { fragmentOnly = false } = {}) {
  const v = [...decode(value)].filter((c) => !INVISIBLE(c.codePointAt(0))).join('').toLowerCase();
  if (v === '' || v.startsWith('#')) return true;
  if (fragmentOnly) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v);
  if (!scheme) return !v.includes(':') || /^[^:]*[/?#]/.test(v); // relative (a colon only after / ? #)
  if (['http', 'https', 'mailto'].includes(scheme[1])) return true;
  return /^data:image\/(png|jpe?g|gif|webp)[;,]/.test(v);
}

const BAD_CSS = /javascript:|vbscript:|expression\s*\(|-moz-binding|behavior\s*:|@import|url\s*\(\s*['"]?\s*(?!#|data:image\/(png|jpe?g|gif|webp)[;,])[^)'"\s]/i;

function cleanAttrs(tag, raw) {
  const out = [];
  let dropElement = false;
  for (const m of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
    const name = m[1];
    if (!ATTR_NAME.test(name)) continue;
    let value = m[2] === undefined ? '' : m[2];
    if (value[0] === '"' || value[0] === "'") value = value.slice(1, -1);
    const lname = name.toLowerCase();
    const local = localName(name);
    if (local.startsWith('on')) continue;
    if (lname === 'xmlns' || lname.startsWith('xmlns:')) {
      if (!SAFE_NS.has(decode(value).trim())) continue;
    } else if (local === 'attributename') {
      const target = localName(decode(value).trim());
      if (target.includes('href') || target.startsWith('on') || target === 'style') dropElement = true;
    } else if (URL_ATTRS.has(local)) {
      const isAnim = tag.startsWith('animate');
      if (isAnim && ['from', 'to', 'values', 'by'].includes(local)) {
        if (/script:|data:/i.test(decode(value).replace(/\s/g, ''))) dropElement = true;
      } else if (!safeSvgUrl(value, { fragmentOnly: tag === 'use' || tag === 'mpath' })) continue;
    } else if (local === 'style') {
      if (BAD_CSS.test(decode(value))) continue;
    }
    out.push(` ${name}="${escAttr(decode(value))}"`);
  }
  return { attrs: out.join(''), dropElement };
}

// One tag starting at src[i] === '<': { end, closing, name, rawAttrs } or null when it isn't a tag.
// Linear: quoted values are skipped with indexOf; `budget.left` bounds the total scan work, so
// input built to make every '<' scan to the end can't make this quadratic.
function scanTag(src, i, budget) {
  let j = i + 1;
  const closing = src[j] === '/';
  if (closing) j += 1;
  const nameStart = j;
  while (j < src.length && j - nameStart < 100 && /[\w.:-]/.test(src[j])) j += 1;
  const name = src.slice(nameStart, j);
  budget.left -= j - i;
  if (!TAG_NAME.test(name) || (j < src.length && !/[\s/>]/.test(src[j]))) return null;
  const attrStart = j;
  while (j < src.length) {
    const c = src[j];
    if (c === '>') {
      budget.left -= j - i;
      return { end: j + 1, closing, name, rawAttrs: src.slice(attrStart, j) };
    }
    if (c === '"' || c === "'") {
      const q = src.indexOf(c, j + 1);
      if (q < 0) break;
      j = q + 1;
    } else j += 1;
  }
  budget.left -= src.length - i;
  return null;
}

export class SvgRejected extends Error {}
const MAX_DEPTH = 256;

// Returns sanitised SVG markup. Throws SvgRejected for input that is too costly to parse.
export function sanitizeSvg(input) {
  const src = String(input ?? '');
  const budget = { left: 20 * src.length + 100000 };
  let out = '';
  const stack = []; // open, emitted elements: { tag (lowercased local name), name (as written) }
  let skip = 0; // > 0 while inside a dropped subtree
  const text = (s) => {
    if (skip || !s) return;
    const t = escText(s);
    out += stack.length && stack[stack.length - 1].tag === 'style' ? t.replace(BAD_STYLE_TEXT, '/* removed */') : t;
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (budget.left < 0) throw new SvgRejected('svg is too complex to check');
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    text(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      // CDATA is literal text: escape every '&' too.
      text(src.slice(i + 9, end < 0 ? n : end).replace(/&/g, '&amp;'));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<!', i)) { // DOCTYPE, maybe with an internal subset [ ... ] (entity definitions)
      const bracket = src.indexOf('[', i);
      const close = src.indexOf('>', i);
      let end = close;
      if (bracket >= 0 && close >= 0 && bracket < close) {
        const sub = src.indexOf(']', bracket);
        end = sub < 0 ? -1 : src.indexOf('>', sub);
      }
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src.startsWith('<?', i)) { // processing instructions, including <?xml-stylesheet?>
      const end = src.indexOf('?>', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    const t = scanTag(src, i, budget);
    if (!t) {
      if (!skip) out += '&lt;';
      i += 1;
      continue;
    }
    i = t.end;
    const tag = localName(t.name);
    const selfClosing = !t.closing && /\/\s*$/.test(t.rawAttrs);
    if (skip) {
      if (t.closing) skip -= 1;
      else if (!selfClosing) skip += 1;
      continue;
    }
    if (t.closing) {
      let at = stack.length - 1;
      while (at >= 0 && stack[at].tag !== tag) at -= 1;
      if (at < 0) continue;
      while (stack.length > at) out += `</${stack.pop().name}>`;
      continue;
    }
    if (DROP_SUBTREE.has(tag)) { if (!selfClosing) skip = 1; continue; }
    if (!ALLOWED.has(tag)) continue; // unwrapped: its children are still processed
    const { attrs, dropElement } = cleanAttrs(tag, selfClosing ? t.rawAttrs.replace(/\/\s*$/, '') : t.rawAttrs);
    if (dropElement) { if (!selfClosing) skip = 1; continue; }
    if (selfClosing) { out += `<${t.name}${attrs}/>`; continue; }
    out += `<${t.name}${attrs}>`;
    stack.push({ tag, name: t.name });
    if (stack.length > MAX_DEPTH) throw new SvgRejected(`svg nests deeper than ${MAX_DEPTH} elements`);
  }
  while (stack.length) out += `</${stack.pop().name}>`;
  return out;
}
// Inside <style> text: the same CSS that BAD_CSS refuses in a style attribute.
const BAD_STYLE_TEXT = /javascript:|vbscript:|expression\s*\(|-moz-binding|behavior\s*:|@import/gi;
