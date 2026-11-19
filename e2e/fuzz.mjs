// e2e/fuzz.mjs — random Markdown documents for the renderer, plus the in-browser checker.
//
// makeDocs(seed, n) builds n documents from a seeded generator mixing everything the reader
// handles: headings, lists, tables, quotes and callouts, code, the ::: blocks (valid, unknown and
// unclosed), frontmatter (valid and not), highlights and badges, CJK, emoji, runs of = signs and
// hostile HTML. Each document records the marker words it placed in visible text.
//
// checkInPage(docs) runs inside a page that has loaded /assets/render.js and reports every
// document that threw, lost a marker word, produced an unsafe node, ran injected script, or took
// too long. Same seed -> same documents, so any failure is reproducible from its seed.

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const CJK = ['信任', '金字塔', '一句话结论', '静态检查', '运行时验证', '先把检查写进代码库', '注意', '提示', '中文和English混排'];
const EMOJI = ['✅', '❌', '⚠️', '🚀', '⭐', '🟡'];
const LANGS = ['js', 'python', 'bash', 'json', '', 'mermaid', 'no-such-lang'];
const HOSTILE = [
  '<script>window.__fz = "script"</script>',
  '<img src="x" onerror="window.__fz=\'img\'">',
  '<svg onload="window.__fz=\'svg\'"><circle r="2"/></svg>',
  '<iframe src="javascript:window.__fz=\'iframe\'"></iframe>',
  '[link](javascript:window.__fz=\'link\')',
  '<a href="javascript:window.__fz=\'a\'">x</a>',
  '<div style="background:url(javascript:alert(1))">s</div>',
  '</script><script>window.__fz="close"</script>',
  '<details open ontoggle="window.__fz=\'toggle\'"><summary>s</summary>d</details>',
  '<math><mi xlink:href="javascript:window.__fz=1">m</mi></math>',
];

export function makeDocs(seed, n) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const docs = [];
  for (let d = 0; d < n; d++) {
    const words = [];
    let k = 0;
    const W = () => { const w = `zq${seed % 997}x${d}w${k++}`; words.push(w); return w; };
    const text = (len = 3) => Array.from({ length: len }, () => (r() < 0.25 ? pick(CJK) : r() < 0.15 ? pick(EMOJI) : W())).join(' ');
    const blocks = [];
    if (r() < 0.2) blocks.push(r() < 0.6 ? `---\naccent: ${pick(['teal', 'amber', 'indigo', 'neon'])}\ntoc: ${pick(['true', 'false'])}\n---` : `---\n${text(2)}\n---`);
    blocks.push(`# ${text(2)}`);
    const count = 3 + Math.floor(r() * 9);
    for (let b = 0; b < count; b++) {
      const t = r();
      if (t < 0.12) blocks.push(`## ${text(2)}`);
      else if (t < 0.2) blocks.push(`**${r() < 0.25 ? text(1) : pick(['一句话结论', 'TL;DR', 'Key points'])}**\n${text(5)}`);
      else if (t < 0.3) blocks.push(Array.from({ length: 2 + Math.floor(r() * 4) }, (_, i) => `${i + 1}. **${text(1)}**：${text(3)}`).join('\n'));
      else if (t < 0.38) blocks.push(Array.from({ length: 2 + Math.floor(r() * 4) }, () => (r() < 0.5 ? `- **${text(1)}**: ${text(2)}` : `- ${text(3)}`)).join('\n'));
      else if (t < 0.46) {
        const cols = 2 + Math.floor(r() * 3);
        const row = () => '| ' + Array.from({ length: cols }, () => (r() < 0.4 ? String(Math.floor(r() * 99999)) + pick(['', '%', 'ms', ' 万']) : r() < 0.2 ? `${pick(EMOJI)} ${W()}` : W())).join(' | ') + ' |';
        blocks.push([row(), '|' + ' --- |'.repeat(cols), row(), row()].join('\n'));
      } else if (t < 0.53) blocks.push(`> ${pick(['[!NOTE]', '[!WARNING]', '[!TIP]', '注意：', 'Warning:', '', '[!BOGUS]'])} ${text(4)}`);
      else if (t < 0.6) blocks.push('```' + pick(LANGS) + '\n' + text(4) + '\nconst a = 1 < 2 && "</script>";\n```');
      else if (t < 0.7) {
        const name = pick(['summary', 'stats', 'steps', 'compare', 'cards', 'tabs', 'note', 'tip', 'warning', 'important', 'caution', 'unknownthing']);
        const body = name === 'stats' ? `${Math.floor(r() * 1000)} | ${text(2)} {up}\n${W()} | ${text(1)}`
          : ['compare', 'cards', 'tabs'].includes(name) ? `### ${text(1)}\n${text(3)}\n### ${text(1)}\n- ${text(2)}`
          : name === 'steps' ? `- [x] **${text(1)}**: ${text(2)}\n- [ ] ${text(2)}` : text(4);
        blocks.push(`:::${name}${r() < 0.4 ? ' ' + text(1) : ''}\n${body}${r() < 0.85 ? '\n:::' : ''}`);
      } else if (t < 0.76) blocks.push(`${text(2)} ==${text(1)}== ${pick(['===CHAT===', 'a == b', '$5 == $5', '=='])} :badge[${pick(['shipped', 'blocked', 'beta', '进行中'])}]${pick(['', '{blue}', '{nope}'])} ${text(1)}`);
      else if (t < 0.84) blocks.push(pick(HOSTILE) + `\n\n${text(3)}`);
      else if (t < 0.88) blocks.push('---');
      else if (t < 0.92) blocks.push(`- ${text(2)}\n  - ${text(2)}\n    1. **${text(1)}** ${text(1)}`);
      else if (t < 0.95) blocks.push(`${text(2)} ${'长'.repeat(Math.floor(r() * 400))} ${text(1)}`);
      else blocks.push(`${text(3)}\u200b\u202e${text(1)}\u202c`);
    }
    docs.push({ seed, index: d, md: blocks.join('\n\n'), words });
  }
  return docs;
}

// Runs in the browser (page.evaluate). Must be self-contained.
export function checkInPage(docs) {
  /* global MDShareRender */
  const failures = [];
  const box = document.createElement('div');
  box.className = 'prose';
  document.body.appendChild(box);
  let slowest = 0;
  for (const doc of docs) {
    window.__fz = undefined;
    const t0 = performance.now();
    try {
      MDShareRender.render(doc.md, box, { motion: false, gloss: false });
    } catch (e) {
      failures.push({ index: doc.index, seed: doc.seed, problem: `threw: ${e.message}` });
      continue;
    }
    const ms = performance.now() - t0;
    slowest = Math.max(slowest, ms);
    const text = box.textContent;
    const missing = doc.words.filter((w) => !text.includes(w));
    if (missing.length) failures.push({ index: doc.index, seed: doc.seed, problem: `lost ${missing.length} word(s), e.g. ${missing.slice(0, 3).join(', ')}` });
    const unsafe = box.querySelectorAll('script, iframe, object, embed, [onerror], [onload], [onclick], [ontoggle], [onmouseover]');
    if (unsafe.length) failures.push({ index: doc.index, seed: doc.seed, problem: `unsafe node: ${unsafe[0].outerHTML.slice(0, 80)}` });
    const js = [...box.querySelectorAll('[href], [src], [xlink\\:href]')].find((el) => /^\s*javascript:/i.test(el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('xlink:href') || ''));
    if (js) failures.push({ index: doc.index, seed: doc.seed, problem: `javascript: URL kept on <${js.tagName.toLowerCase()}>` });
    if (window.__fz !== undefined) failures.push({ index: doc.index, seed: doc.seed, problem: `injected script ran (${window.__fz})` });
    if (ms > 400) failures.push({ index: doc.index, seed: doc.seed, problem: `slow render ${Math.round(ms)}ms` });
  }
  box.remove();
  return { checked: docs.length, failures, slowestMs: Math.round(slowest) };
}

// Random clicks and keys on whatever is interactive, staying on this origin. Returns how many
// actions ran; the caller watches pageerror for failures.
export async function monkey(page, { steps = 60, seed = 1, origin }) {
  const r = rng(seed);
  let done = 0;
  for (let i = 0; i < steps; i++) {
    let count;
    try {
      await page.waitForLoadState('load', { timeout: 3000 });
      // Tag what a person could actually click right now: visible, enabled, on this site, not destructive.
      count = await page.evaluate((origin) => {
        document.querySelectorAll('[data-monkey]').forEach((e) => e.removeAttribute('data-monkey'));
        const all = [...document.querySelectorAll('button, a[href], input[type=checkbox], summary')].filter((e) => {
          const s = getComputedStyle(e), b = e.getBoundingClientRect();
          if (e.disabled || s.visibility === 'hidden' || s.display === 'none' || b.width === 0 || b.height === 0) return false;
          if (/delete|signout|logout|b-delete/i.test(e.id || '')) return false;
          const href = e.getAttribute('href');
          if (href && /^(https?:)?\/\//.test(href) && !href.startsWith(origin)) return false;
          if (href && (/^\/(raw|api)\//.test(href) || /\.(txt|md)$/.test(href))) return false;
          return true;
        });
        all.forEach((e, n) => e.setAttribute('data-monkey', String(n)));
        return all.length;
      }, origin);
    } catch (e) { if (process.env.MONKEY_DEBUG) console.log('scan failed:', e.message.split('\n')[0]); continue; }
    if (!count) {
      // A click may have just started a navigation; give the new page a moment, then go back if it's still empty.
      await page.waitForTimeout(400);
      if (process.env.MONKEY_DEBUG) console.log('nothing clickable yet at', page.url());
      if (i > steps - 2) break;
      continue;
    }
    try {
      if (r() < 0.15) await page.keyboard.press(['Escape', 'Tab', 'Control+=', 'Control+-', 'Control+0'][Math.floor(r() * 5)]);
      else await page.click(`[data-monkey="${Math.floor(r() * count)}"]`, { timeout: 1000, noWaitAfter: true });
      done++;
      await page.waitForTimeout(60);
    } catch (e) { if (process.env.MONKEY_DEBUG) console.log('click failed:', e.message.split('\n')[0]); }
    if (!page.url().startsWith(origin)) await page.goBack().catch(() => {});
  }
  return done;
}
