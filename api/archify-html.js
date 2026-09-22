// GET /api/archify-html?id=xxx — serves the raw self-contained archify interactive HTML.
// This is what the /a/:id page loads inside its sandboxed <iframe> (sandbox="allow-scripts",
// deliberately no allow-same-origin — see api/archify-render.js), so archify's full
// interactivity (hover-to-trace, route probe, pan/zoom, theme toggle) works untouched while it
// never gets access to the mdshare origin's cookies or APIs. Private unless the owner is
// authenticated or the row has is_public: true — this route is fetched directly by the browser
// (as the iframe's src), so it enforces visibility itself rather than relying only on the parent
// page. No login UI here: the parent page (/a/:id) owns the sign-in flow.
import { getRow, isVisible } from './_lib/access.js';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const { row, dbError } = await getRow('mdshare_archify', id, 'html,expires_at,is_public');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Response depends on the auth cookie and is_public — never cache it.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (dbError || !row || !row.html || !isVisible(row, req, res)) {
    return res.status(404).send('<!DOCTYPE html><html><body style="background:#f2eee5;margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;color:#7a7365">Diagram expired, not found, or private.</body></html>');
  }

  // archify HTML is self-contained (inline CSS/JS + Google Fonts). default-src 'none' + explicit
  // allow-list is tighter than the previous default-src 'self': there is no mdshare origin left to
  // implicitly trust from inside this document. frame-ancestors 'self' means only mdshare's own
  // /a/:id wrapper may embed it.
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'none'; frame-ancestors 'self'");
  return res.send(row.html);
}
