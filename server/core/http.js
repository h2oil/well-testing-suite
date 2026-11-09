'use strict';
// server/core/http.js — the common rules of docs/ACCOUNTS-PLAN.md §3.2 for every endpoint: response headers, Origin and
// custom-header checks, the trusted host and client-address headers, the proxy signature, body limits, cookies, and the
// ops-daily HMAC. Pure functions over a plain request {method, url, headers (lower-case names), body: Buffer|null,
// remoteAddress}; used by core/app.js (server) and by the fake server (prism-build/tests/_acct-fake-server.js).

const crypto = require('crypto');

const COMMON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
});
// Body caps per endpoint id (bytes; 413 before parsing). Default 64 kB.
const BODY_LIMITS = {
  projectCommit: 512 * 1024, libraryCommit: 2900 * 1000, blobPut: 4 * 1024 * 1024 + 1024, cspReport: 16 * 1000,
  default: 64 * 1024,
};
function bodyLimit(id) { return BODY_LIMITS[id] || BODY_LIMITS.default; }

function header(req, name) {
  const v = req.headers ? req.headers[name.toLowerCase()] : undefined;
  return Array.isArray(v) ? v[0] : v;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a)); const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}
// The original host from the host's trusted forwarding header (WTS_HOST_HEADER) or, without one, the Host header. Same-site
// mode (core/config.js WTS_SITE_MODE=same) always reads the Host header itself: no forwarding header is trusted there.
function originalHost(req, cfg) {
  const raw = cfg.hostHeader && !cfg.sameSite ? header(req, cfg.hostHeader) : header(req, 'host');
  return String(raw || '').split(',')[0].trim().toLowerCase();
}
function hostAllowed(req, cfg) {
  const h = originalHost(req, cfg);
  if (cfg.sameSite) return !!cfg.prodHost && h === cfg.prodHost;      // exactly the production host, in every WTS_ENV
  if (h === cfg.prodHost) return true;
  if (cfg.production) return false;
  return /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(h);
}
// Client address: only the trusted header named by WTS_CLIENT_IP_HEADER (never X-Forwarded-For), else the socket. When the
// header holds a list, the LAST value is used: it is the one the host's own edge appended, while earlier values may have been
// sent by the client itself (RUNBOOK §3N step 12.5 checks a forged header once on the live site).
function clientIp(req, cfg) {
  if (cfg.ipHeader) return String(header(req, cfg.ipHeader) || '').split(',').map((v) => v.trim()).filter(Boolean).pop() || null;
  return req.remoteAddress || null;
}
// Client location from the hosting platform's geolocation headers (x-nf-geo: base64 JSON {city, country:{code}, …}; x-country:
// the ISO 3166-1 alpha-2 code). Read ONLY in same-site mode, where the platform's edge sets them (or with the tests' explicit
// WTS_GEO_HEADERS flag, core/config.js); in every other mode → {country:null, city:null}. Every value is untrusted input:
// country must be exactly /^[A-Z]{2}$/ (x-nf-geo first, then x-country), city ≤ 80 characters of letters, spaces and . - '
// only (anything else → null; a city only from the record that also gave the country). The address is never kept for this.
const GEO_CITY_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,79}$/u;
function geoCountry(v) { return typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : null; }
function geoCity(v) {
  if (typeof v !== 'string' || v.length > 400) return null;
  const s = v.normalize('NFC').trim();
  return s.length <= 80 && GEO_CITY_RE.test(s) ? s : null;
}
function clientGeo(req, cfg) {
  const none = { country: null, city: null };
  if (!cfg || !(cfg.sameSite || cfg.geoHeaders)) return none;
  let geo = null;
  const raw = String(header(req, 'x-nf-geo') || '').trim();
  if (raw && raw.length <= 4096 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    try {
      const j = JSON.parse(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) geo = j;
    } catch (e) { geo = null; }
  }
  const fromGeo = geo && geo.country && typeof geo.country === 'object' ? geoCountry(geo.country.code) : null;
  const country = fromGeo || geoCountry(header(req, 'x-country'));
  if (!country) return none;
  return { country, city: fromGeo ? geoCity(geo.city) : null };
}
// The rewrite from the static site adds X-WTS-Proxy-Sig; without the shared secret configured only non-production accepts.
// WTS_PROXY_SIG may hold two comma-separated values during a rotation (§13.3); each is compared in constant time.
// Same-site mode has no proxy: the request reaches the function straight from the platform's edge, so there is no signature to
// check (hostAllowed then demands the exact production Host).
function proxyOk(req, cfg) {
  if (cfg.sameSite) return true;
  const want = (cfg.secrets && cfg.secrets.proxySigs) || [];
  if (!want.length) return !cfg.production;
  const got = header(req, 'x-wts-proxy-sig');
  let ok = false;
  want.forEach((w) => { if (safeEqual(got, w)) ok = true; });       // no early exit: every value is compared
  return ok;
}
// Origin / X-WTS-Req / Content-Type for a non-GET endpoint (exceptions: csp-report, ops-daily; the callback is a GET).
function writeHeadersOk(req, ep, cfg) {
  if (req.method === 'GET' || ep.auth === 'report' || ep.auth === 'hmac') return true;
  const origin = header(req, 'origin');
  if (!origin || cfg.allowedOrigins.indexOf(origin) === -1) return false;
  if (header(req, 'x-wts-req') !== '1') return false;
  const ct = String(header(req, 'content-type') || '').toLowerCase().split(';')[0].trim();
  return ep.body === 'octet' ? ct === 'application/octet-stream' : ct === 'application/json';
}
function cspContentTypeOk(req) {
  const ct = String(header(req, 'content-type') || '').toLowerCase().split(';')[0].trim();
  return ct === 'application/csp-report' || ct === 'application/reports+json';
}
// ops-daily: HMAC-SHA256(key, method \n path \n ts \n nonce) in X-WTS-Sig (hex); ±5 min; a nonce is accepted once in 10 min.
// The nonce store is shared by every function instance: dbNonceStore(db) (definer wts.ops_nonce_claim, table ops_nonces).
// memoryNonceStore() is TEST-ONLY (one process); createApp uses it only outside production.
function opsSignature(key, method, path, ts, nonce) {
  return crypto.createHmac('sha256', key).update(method + '\n' + path + '\n' + ts + '\n' + nonce).digest('hex');
}
function memoryNonceStore() {
  const seen = new Map();
  return {
    async claim(nonce, nowMs) {
      for (const [n, at] of seen) if (nowMs - at > 10 * 60 * 1000) seen.delete(n);
      if (seen.has(nonce)) return false;
      seen.set(nonce, nowMs);
      return true;
    },
  };
}
function dbNonceStore(db) {
  return { async claim(nonce) { const r = await db.anon((tx) => tx`select wts.ops_nonce_claim(${nonce}) as ok`); return !!(r[0] && r[0].ok); } };
}
// → Promise<boolean>; without a nonce store the call is refused (never accepted unguarded)
async function verifyOps(req, path, cfg, nowMs, nonces) {
  const key = cfg.secrets && cfg.secrets.opsHmac;
  if (!key) return false;
  const ts = Number(header(req, 'x-wts-ts')); const nonce = String(header(req, 'x-wts-nonce') || '');
  if (!isFinite(ts) || Math.abs(nowMs - ts * 1000) > 5 * 60 * 1000 || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
  if (!safeEqual(header(req, 'x-wts-sig'), opsSignature(key, req.method, path, String(ts), nonce))) return false;
  if (!nonces || typeof nonces.claim !== 'function') return false;
  return !!(await nonces.claim(nonce, nowMs));
}

function parseCookies(raw) {
  const out = {};
  String(raw || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  });
  return out;
}
// def = one of contract.COOKIES; value null clears it (Max-Age=0). opts.maxAge (seconds, integer ≥ 1) overrides the
// definition's lifetime — the session cookie has none in its definition and MUST be given one: seconds to abs_expires_at,
// for public and trusted devices alike (contract COOKIES.session note); a cookie without Max-Age dies with the browser.
function serializeCookie(def, value, opts) {
  opts = opts || {};
  const parts = [def.name + '=' + (value == null ? '' : value), 'Path=' + def.path];
  if (def.secure) parts.push('Secure');
  if (def.httpOnly) parts.push('HttpOnly');
  parts.push('SameSite=' + def.sameSite);
  if (value == null) parts.push('Max-Age=0');
  else {
    const ma = opts.maxAge != null ? Math.floor(Number(opts.maxAge)) : def.maxAge;
    if (opts.maxAge != null && !(ma >= 1)) throw new Error('serializeCookie: maxAge must be a positive number of seconds');
    if (!ma && def.maxAgeRequired) throw new Error('serializeCookie: ' + def.name + ' needs {maxAge} (seconds to abs_expires_at)');
    if (ma) parts.push('Max-Age=' + ma);
  }
  return parts.join('; ');
}
function splitUrl(url) {
  const i = url.indexOf('?');
  const path = i === -1 ? url : url.slice(0, i);
  const query = {};
  if (i !== -1) new URLSearchParams(url.slice(i + 1)).forEach((v, k) => { if (!(k in query)) query[k] = v; });
  return { path, query };
}

module.exports = {
  COMMON_HEADERS, BODY_LIMITS, bodyLimit, header, safeEqual, originalHost, hostAllowed, clientIp, clientGeo, proxyOk, writeHeadersOk,
  cspContentTypeOk, opsSignature, verifyOps, memoryNonceStore, dbNonceStore, parseCookies, serializeCookie, splitUrl,
};
