// Slows down password guessing on the sign-in page. Only FAILED attempts are counted, in three ways:
//   pair    the same device trying the same mobile number   5 in 15 minutes   (stops guessing one account)
//   mobile  any device trying the same mobile number       20 in 15 minutes   (stops a spread-out guess; high so that a stranger cannot easily lock a real user out)
//   ip      the same device trying any mobile numbers      30 in 15 minutes   (stops trying many accounts)
// Counts are kept in memory (cleared when the server restarts, which an attacker cannot trigger). A good sign-in clears the pair and mobile counts.
import { normalizeMobile } from './mobile.js';

const WINDOW_MS = 15 * 60 * 1000;
export const LIMITS = { pair: 5, mobile: 20, ip: 30 };
const failures = new Map(); // key -> timestamps

const fresh = (key, now = Date.now()) => {
  const list = (failures.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list); else failures.delete(key);
  return list;
};
const isLocal = (ip) => /^(::1|127\.|::ffff:127\.)/.test(String(ip || ''));
// during development on the same computer, many wrong tries must not lock the developer out
const ipCounts = (ip) => process.env.NODE_ENV === 'production' || !isLocal(ip);

const keysFor = (ip, mobile) => ({ pair: `pair:${ip}:${mobile}`, mobile: `mobile:${mobile}`, ip: `ip:${ip}` });

// null when the attempt may go ahead, otherwise how many seconds until it may
export function loginBlockedFor(ip, rawMobile, now = Date.now()) {
  const mobile = normalizeMobile(rawMobile) || 'none';
  const k = keysFor(ip, mobile);
  let wait = 0;
  for (const [kind, key] of Object.entries(k)) {
    if (kind === 'ip' && !ipCounts(ip)) continue;
    const list = fresh(key, now);
    if (list.length >= LIMITS[kind]) wait = Math.max(wait, Math.ceil((list[0] + WINDOW_MS - now) / 1000));
  }
  return wait || null;
}

export function recordLoginFailure(ip, rawMobile, now = Date.now()) {
  const mobile = normalizeMobile(rawMobile) || 'none';
  const k = keysFor(ip, mobile);
  for (const [kind, key] of Object.entries(k)) {
    if (kind === 'ip' && !ipCounts(ip)) continue;
    const list = fresh(key, now); list.push(now); failures.set(key, list);
  }
}

export function clearLoginFailures(ip, rawMobile) {
  const mobile = normalizeMobile(rawMobile) || 'none';
  const k = keysFor(ip, mobile);
  failures.delete(k.pair); failures.delete(k.mobile);
}

export const minutesText = (seconds) => { const m = Math.ceil(seconds / 60); return m <= 1 ? 'a minute' : `${m} minutes`; };

// Express middleware for POST /auth/login: refuses early when blocked, and counts the attempt when the sign-in fails.
// The sign-in handler marks a wrong password with res.locals.loginFailed = true.
export function loginGuard(req, res, next) {
  const ip = req.ip;
  const mobile = req.body?.mobile;
  const wait = loginBlockedFor(ip, mobile);
  if (wait) {
    console.warn(`Sign-in blocked for ${wait}s: too many failed attempts from ${ip} for mobile ending ${String(normalizeMobile(mobile) || '').slice(-4)}`);
    res.set('Retry-After', String(wait));
    return res.status(429).json({ message: `Too many failed sign-in attempts. Please try again in ${minutesText(wait)}.` });
  }
  res.on('finish', () => {
    if (res.locals.loginFailed) recordLoginFailure(ip, mobile);
    else if (res.statusCode === 200) clearLoginFailures(ip, mobile);
  });
  next();
}

// housekeeping: forget old entries
setInterval(() => { const now = Date.now(); for (const key of [...failures.keys()]) fresh(key, now); }, 5 * 60 * 1000).unref();
