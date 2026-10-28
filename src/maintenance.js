import jwt from 'jsonwebtoken';
import { pool } from './db.js';

// Planned maintenance, set by the platform admin. One row in platform_maintenance (see migration 051).
//   NONE      nothing planned (or it is over)
//   UPCOMING  planned: a notice is shown on the sign-in page and inside the app
//   ACTIVE    in progress: with block_access on, only the platform admin can use the app
const TTL_MS = 5000;
let cache = null;
let warned = false;

export const invalidateMaintenance = () => { cache = null; };

export async function maintenanceRow() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.row;
  let row = null;
  try {
    const q = await pool.query(`SELECT m.starts_at,m.ends_at,m.message,m.block_access,m.updated_at,m.updated_by,s.name AS updated_by_name
                                FROM platform_maintenance m LEFT JOIN platform_superusers s ON s.id=m.updated_by WHERE m.id=1`);
    row = q.rows[0] || null;
  } catch (error) {
    // the table does not exist yet (migration 051 not run): behave as if nothing is planned
    if (!warned) { warned = true; console.warn(`[maintenance] ${error.message}`); }
  }
  cache = { row, at: Date.now() };
  return row;
}

const upper = (t) => t.replace(/\b(am|pm)\b/g, (x) => x.toUpperCase());
const fmt = (d) => upper(new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }));
const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const clock = (d) => upper(new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }));
// "Tue, 21 Oct, 10:00 PM to 11:00 PM" or, over midnight, "Tue, 21 Oct, 10:00 PM to Wed, 22 Oct, 1:00 AM" (India time)
export const periodText = (start, end) => (day(start) === day(end) ? `${fmt(start)} to ${clock(end)}` : `${fmt(start)} to ${fmt(end)}`);

export function describe(row, now = new Date()) {
  const has = row && row.starts_at && row.ends_at;
  let status = 'NONE';
  if (has && now < new Date(row.ends_at)) status = now < new Date(row.starts_at) ? 'UPCOMING' : 'ACTIVE';
  const blocking = status === 'ACTIVE' && row.block_access === true;
  return {
    status,
    blocking,
    startsAt: status === 'NONE' ? null : new Date(row.starts_at).toISOString(),
    endsAt: status === 'NONE' ? null : new Date(row.ends_at).toISOString(),
    message: status === 'NONE' ? '' : row.message || '',
    period: status === 'NONE' ? '' : periodText(row.starts_at, row.ends_at),
    backBy: status === 'NONE' ? '' : fmt(row.ends_at),
    now: now.toISOString(),
  };
}

export async function currentMaintenance() { return describe(await maintenanceRow()); }

export const blockedMessage = (m) => `DhaCare is being updated and will be back by ${m.backBy} (India time).`;

// While maintenance is in progress every request is answered with 503, except: the status page, sign-in (it refuses hospital users itself), and the platform admin.
export async function maintenanceGate(req, res, next) {
  try {
    const m = await currentMaintenance();
    if (!m.blocking) return next();
    if (req.path === '/public-maintenance' || req.path === '/auth/login') return next();
    const [scheme, token] = String(req.headers.authorization || '').split(' ');
    if (scheme === 'Bearer' && token) {
      try { if (jwt.verify(token, process.env.JWT_SECRET).role === 'SUPER_ADMIN') return next(); } catch { /* not a valid token: treated like anyone else */ }
    }
    res.set('Retry-After', String(Math.max(60, Math.ceil((new Date(m.endsAt) - Date.now()) / 1000))));
    return res.status(503).json({ message: blockedMessage(m), maintenance: m });
  } catch { return next(); }
}
