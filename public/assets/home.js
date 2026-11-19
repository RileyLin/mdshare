/* Home page: live preview + "Create link" (POST /api/share). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var md = $('md'), preview = $('preview'), t = null;
  function toast(m, e) { var el = $('toast'); el.textContent = m; el.classList.toggle('err', !!e); el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2600); }
  function draw() { MDShareRender.render(md.value, preview, { motion: false, anchors: false, idPrefix: 'pv-' }); }
  md.addEventListener('input', function () { clearTimeout(t); t = setTimeout(draw, 140); $('result').classList.remove('show'); });
  md.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); share(); }
    else if (e.key === 'Tab') { e.preventDefault(); md.setRangeText('  ', md.selectionStart, md.selectionEnd, 'end'); md.dispatchEvent(new Event('input')); }
  });
  draw();
  var ex = $('api-example'); if (ex) ex.textContent = ex.textContent.replace(/https:\/\/mdshare-rileylins-projects\.vercel\.app/g, location.origin);
  async function share() {
    var text = md.value.trim(), btn = $('share-btn');
    if (!text) { toast('Write something first', true); md.focus(); return; }
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      var r = await fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: md.value }) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      var link = $('link'); link.href = d.url; link.textContent = d.url.replace(/^https?:\/\//, '');
      $('result').classList.add('show');
      $('studio-hint').textContent = d.kept ? 'Private and kept. Publish it from the page when you’re ready.' : 'Private link created. Open it to publish or keep it.';
      toast('Link created');
    } catch (e) { toast('Couldn’t create the link: ' + e.message, true); }
    btn.disabled = false; btn.textContent = 'Create link';
  }
  $('share-btn').addEventListener('click', share);
  $('copy-link').addEventListener('click', function () { navigator.clipboard.writeText($('link').href).then(function () { toast('Copied'); }, function () { toast('Copy failed', true); }); });
})();
