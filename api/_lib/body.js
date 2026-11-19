// Vercel gives req.body as an object for JSON requests but as a string for other content types.
// Invalid JSON is returned unchanged so each route's own validation rejects it.
export function parseJsonBody(body) {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch { return body; }
}
