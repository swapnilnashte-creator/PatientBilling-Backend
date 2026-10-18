// A small in-memory counter for rate limits that need no database: "no more than N hits of this kind in this window".
// Counts are cleared when the server restarts. Where the server runs on the same computer (development), the limit can be skipped.
const hits = new Map();

export const isLoopback = (ip) => /^(::1|127\.|::ffff:127\.)/.test(String(ip || ''));

// Counts this hit and says whether it is over the limit. Returns 0 when it may go ahead, otherwise the seconds to wait.
export function overLimit(key, max, windowMs, now = Date.now()) {
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return Math.ceil((list[0] + windowMs - now) / 1000); }
  list.push(now); hits.set(key, list);
  return 0;
}

setInterval(() => { const now = Date.now(); for (const [k, v] of hits) { const keep = v.filter(t => now - t < 24 * 3600e3); if (keep.length) hits.set(k, keep); else hits.delete(k); } }, 10 * 60 * 1000).unref();
