/* Reports uncaught browser errors to /api/health (production error log). Loaded first on every
 * page. At most 5 reports per page view; never sends document content, cookies or query strings. */
(function () {
  'use strict';
  var sent = 0, seen = {};
  function report(message, source, line, col, stack) {
    if (sent >= 5 || !message) return;
    var key = message + '|' + source + '|' + line;
    if (seen[key]) return;
    seen[key] = true; sent++;
    var body = JSON.stringify({ type: 'client_error', message: String(message).slice(0, 300), source: source || '', line: line || 0, col: col || 0, page: location.pathname, stack: stack ? String(stack).slice(0, 1500) : '' });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon('/api/health', new Blob([body], { type: 'application/json' }));
      else fetch('/api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
    } catch (e) { /* reporting must never throw */ }
  }
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) return; // resource load failures are not code errors
    report(e.message, e.filename, e.lineno, e.colno, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report('Unhandled rejection: ' + (r && r.message ? r.message : String(r)), '', 0, 0, r && r.stack);
  });
})();
