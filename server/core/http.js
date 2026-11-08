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
// The original host from the host's trusted forwarding header (WTS_HOST_HEADER) or, without one, the Host header.
function originalHost(req, cfg) {
  const raw = cfg.hostHeader ? header(req, cfg.hostHeader) : header(req, 'host');
  return String(raw || '').split(',')[0].trim().toLowerCase();
}
function hostAllowed(req, cfg) {
  const h = originalHost(req, cfg);
  if (h === cfg.prodHost) return true;
  if (cfg.production) return false;
  return /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(h);
}
// Client address: only the trusted header named by WTS_CLIENT_IP_HEADER (never X-Forwarded-For), else the socket.
function clientIp(req, cfg) {
  if (cfg.ipHeader) return String(header(req, cfg.ipHeader) || '').split(',')[0].trim() || null;
  return req.remoteAddress || null;
}
// The rewrite from the static site adds X-WTS-Proxy-Sig; without the shared secret configured only non-production accepts.
function proxyOk(req, cfg) {
  const want = cfg.secrets && cfg.secrets.proxySig;
  if (!want) return !cfg.production;
  return safeEqual(header(req, 'x-wts-proxy-sig'), want);
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
function opsSignature(key, method, path, ts, nonce) {
  return crypto.createHmac('sha256', key).update(method + '\n' + path + '\n' + ts + '\n' + nonce).digest('hex');
}
function verifyOps(req, path, cfg, nowMs, seen) {
  const key = cfg.secrets && cfg.secrets.opsHmac;
  if (!key) return false;
  const ts = Number(header(req, 'x-wts-ts')); const nonce = String(header(req, 'x-wts-nonce') || '');
  if (!isFinite(ts) || Math.abs(nowMs - ts * 1000) > 5 * 60 * 1000 || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
  if (!safeEqual(header(req, 'x-wts-sig'), opsSignature(key, req.method, path, String(ts), nonce))) return false;
  if (seen) {
    for (const [n, at] of seen) if (nowMs - at > 10 * 60 * 1000) seen.delete(n);
    if (seen.has(nonce)) return false;
    seen.set(nonce, nowMs);
  }
  return true;
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
// def = one of contract.COOKIES; value null clears it (Max-Age=0).
function serializeCookie(def, value) {
  const parts = [def.name + '=' + (value == null ? '' : value), 'Path=' + def.path];
  if (def.secure) parts.push('Secure');
  if (def.httpOnly) parts.push('HttpOnly');
  parts.push('SameSite=' + def.sameSite);
  if (value == null) parts.push('Max-Age=0');
  else if (def.maxAge) parts.push('Max-Age=' + def.maxAge);
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
  COMMON_HEADERS, BODY_LIMITS, bodyLimit, header, safeEqual, originalHost, hostAllowed, clientIp, proxyOk, writeHeadersOk,
  cspContentTypeOk, opsSignature, verifyOps, parseCookies, serializeCookie, splitUrl,
};
