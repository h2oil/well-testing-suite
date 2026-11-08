'use strict';
// server/core/app.js — the request pipeline shared by every deployment adapter (the host's functions, server/dev.js):
//   createApp({config, handlers?, db?, mail?, now?, log?}) → { handle(req) → Promise<{status, headers, cookies, body}> }
// req = {method, url ('/api/v1/…?q'), headers (lower-case names), body: Buffer|null, remoteAddress}.
//
// Order (docs/ACCOUNTS-PLAN.md §3.2): base path → proxy signature and original host (else 404) → route (else 404) → body cap
// (413 before parsing) → Origin / X-WTS-Req / Content-Type for writes (403 origin; csp-report, ops-daily and the callback have
// their own rules) → JSON parse and the contract request shape (400 bad_request) → ACCOUNTS_OFF (503 paused) → handler.
// Every response carries the common headers; JSON bodies are application/json; the callback is always a 303.

const C = require('./contract');
const H = require('./http');
const { ApiError, envelope, toResponse } = require('./errors');
const { requireShape, ipPrefix } = require('./validate');

const PAUSE_EXEMPT = new Set(['health', 'providers', 'cspReport', 'opsDaily', 'oauthCallback', 'signOut']);

function createApp(o) {
  o = o || {};
  const config = o.config;
  if (!config) throw new Error('createApp: config required');
  const handlers = o.handlers || require('../functions').handlers;
  const now = o.now || (() => Date.now());
  const log = o.log || { info() {}, warn() {} };
  const opsSeen = new Map();

  function respond(status, body, extra) {
    extra = extra || {};
    const headers = Object.assign({}, H.COMMON_HEADERS, extra.headers || {});
    let out = null;
    if (Buffer.isBuffer(body)) { headers['Content-Type'] = 'application/octet-stream'; out = body; }
    else if (body !== undefined && body !== null) { headers['Content-Type'] = 'application/json'; out = JSON.stringify(body); }
    return { status, headers, cookies: extra.cookies || [], body: out };
  }
  function fromError(e) { const r = toResponse(e); return respond(r.status, r.body); }
  const notFound = () => { const r = envelope('not_found'); return respond(r.status, r.body); };
  function callbackRedirect(cookies) {
    return respond(303, null, { headers: { Location: config.appUrl + '#acct-oauth', 'Referrer-Policy': 'no-referrer' }, cookies: cookies || [] });
  }

  async function handle(req) {
    const { path: full, query } = H.splitUrl(req.url || '/');
    if (full !== C.BASE && full.indexOf(C.BASE + '/') !== 0) return notFound();
    if (!H.proxyOk(req, config) || !H.hostAllowed(req, config)) return notFound();
    const path = full.slice(C.BASE.length) || '/';
    if (/\.[A-Za-z0-9]+$/.test(path)) return notFound();            // no API path has a file extension (§3.2)
    const m = C.matchRoute(req.method, path);
    if (!m) return notFound();
    const ep = m.endpoint;
    const isCallback = ep.id === 'oauthCallback';
    try {
      const raw = req.body || null;
      if (raw && raw.length > H.bodyLimit(ep.id)) throw new ApiError('too_large', { limit: H.bodyLimit(ep.id) });
      if (ep.auth === 'report' && !H.cspContentTypeOk(req)) throw new ApiError('origin');
      if (ep.auth === 'hmac' && !H.verifyOps(req, full, config, now(), opsSeen)) throw new ApiError('origin');
      if (!H.writeHeadersOk(req, ep, config)) throw new ApiError('origin');
      if (m.params.provider !== undefined && C.PROVIDERS.indexOf(m.params.provider) === -1) {
        if (isCallback) return callbackRedirect();
        throw new ApiError('not_found');
      }
      let body = null;
      if (ep.body === 'json' && req.method !== 'GET') {
        try { body = raw && raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { throw new ApiError('bad_request'); }
        if (ep.req) requireShape(ep.req, body);
      }
      if (config.accountsOff && !PAUSE_EXEMPT.has(ep.id)) throw new ApiError('paused');
      const ip = H.clientIp(req, config);
      const cookies = H.parseCookies(H.header(req, 'cookie'));
      const setCookies = [];
      const ctx = {
        req, endpoint: ep, params: m.params, query, body, raw, cookies, config, now, log, ip, ipPrefix: ipPrefix(ip),
        db: o.db || null, mail: o.mail || null,
        setCookie(def, value) { setCookies.push(H.serializeCookie(def, value)); },
      };
      const fn = handlers[ep.id];
      if (typeof fn !== 'function') throw new ApiError('not_implemented');
      const r = (await fn(ctx)) || {};
      if (isCallback) return callbackRedirect(setCookies);
      return respond(r.status || 200, r.body, { headers: r.headers, cookies: setCookies });
    } catch (e) {
      if (isCallback) { log.warn('callback: ' + ((e && e.code) || 'error')); return callbackRedirect(); }
      if (!(e instanceof ApiError)) log.warn('handler ' + ep.id + ' threw: ' + ((e && e.message) || e));
      return fromError(e);
    }
  }
  return { config, handle };
}

module.exports = { createApp, PAUSE_EXEMPT };
