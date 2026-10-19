// Checks that the server sees each visitor's own address. The booking limits and the sign-in limits work per address, so this matters:
//   behind a proxy (nginx, Cloudflare, a load balancer) without TRUST_PROXY, every visitor looks like the proxy, so one person's tries block everyone;
//   with TRUST_PROXY=true (trust everything), a visitor can forge the address and escape the limits.
// Set TRUST_PROXY to the NUMBER of proxies in front of the server (1 for nginx alone, 2 for Cloudflare plus nginx).

export function trustProxySetting() {
  const raw = String(process.env.TRUST_PROXY || '').trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // a name such as loopback, or a list of addresses
}

export function startupProxyNotes() {
  const t = trustProxySetting();
  const notes = [];
  if (t === 'true' || t === true) notes.push('TRUST_PROXY=true trusts every address in the chain, so a visitor can forge their address and escape the limits. Use the number of proxies instead (for example TRUST_PROXY=1).');
  if (process.env.NODE_ENV === 'production' && t === false) notes.push('TRUST_PROXY is not set. If a proxy sits in front of this server, all visitors will look like one address and the per-device limits will block everyone together. Open Super Admin > Network check to verify.');
  return notes;
}

// Warns once, in the log, when a request carries proxy headers but the server is not set up to read them (or the reverse).
export function proxyWatch(app) {
  let warnedMissing = false; let warnedNoHeader = false;
  return (req, _res, next) => {
    const t = app.get('trust proxy');
    const forwarded = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'];
    if (!t && forwarded && !warnedMissing) {
      warnedMissing = true;
      console.warn(`[proxy] Requests arrive through a proxy (header: ${String(forwarded).slice(0, 60)}) but TRUST_PROXY is not set, so every visitor looks like ${req.ip}. Set TRUST_PROXY=1 (the number of proxies) and restart.`);
    }
    if (t && !forwarded && !warnedNoHeader && !/^(::1|127\.|::ffff:127\.)/.test(req.ip || '') && req.socket.remoteAddress === req.ip) {
      warnedNoHeader = true;
      console.warn('[proxy] TRUST_PROXY is set but this request has no forwarded-address header. Check that the proxy passes X-Forwarded-For, and that the server cannot be reached directly (otherwise visitors can forge the header).');
    }
    next();
  };
}

// What the Super Admin sees on the Network check page.
const plain = (ip) => String(ip || '').replace(/^::ffff:/, '').trim();

export function networkReport(req, app) {
  const t = app.get('trust proxy');
  const header = (n) => (req.headers[n] ? String(req.headers[n]) : '');
  const socketAddress = req.socket.remoteAddress || '';
  const seen = { forwardedFor: header('x-forwarded-for'), cloudflare: header('cf-connecting-ip'), realIp: header('x-real-ip') };
  const hasProxyHeader = Boolean(seen.forwardedFor || seen.cloudflare || seen.realIp);
  const notes = [...startupProxyNotes()];
  let verdict = 'OK';
  if (hasProxyHeader && !t) { verdict = 'WRONG'; notes.push(`Your request came through a proxy, but TRUST_PROXY is not set. The server sees ${req.ip} (the proxy), not your own address. Every visitor would share this address and its limits.`); }
  else if (!hasProxyHeader && t) { verdict = 'CHECK'; notes.push('TRUST_PROXY is set, but this request has no forwarded-address header. Either there is no proxy in front of the server, or the proxy does not pass X-Forwarded-For.'); }
  else if (hasProxyHeader && t && seen.cloudflare && plain(seen.cloudflare) !== plain(req.ip)) {
    // Cloudflare says who the visitor is; if the server sees something else, it is looking at Cloudflare or Nginx, not the visitor
    verdict = 'WRONG';
    notes.push(`Cloudflare reports your address as ${plain(seen.cloudflare)}, but the server sees ${plain(req.ip)}. The server is looking at a proxy address, not the visitor, so every visitor would share it. Check that Nginx reads the visitor address from Cloudflare and passes it on, and that TRUST_PROXY matches the number of proxies.`);
  } else if (hasProxyHeader && t && seen.cloudflare) notes.push(`Good: the server sees ${plain(req.ip)}, the same address Cloudflare reports for you.`);
  else if (hasProxyHeader && t) notes.push(`Good: the server reads the visitor address from the proxy and sees ${req.ip}. Compare it with your own public address (search "what is my IP") to be sure it matches.`);
  else notes.push(`No proxy detected. The server sees ${req.ip} directly.`);
  if (String(t) === 'true') verdict = verdict === 'OK' ? 'CHECK' : verdict;
  return { verdict, trustProxy: t === false ? 'not set' : String(t), address: req.ip, chain: req.ips, socketAddress, headers: seen, notes };
}
