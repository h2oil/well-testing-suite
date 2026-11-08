'use strict';
// server/core/app.js — the request pipeline shared by every deployment adapter (the host's functions, server/dev.js):
//   createApp({config, handlers?, db?, mail?, now?, log?, opsNonces?, keys?, objects?, jobs?, background?})
//     → { handle(req) → Promise<{status, headers, cookies, body}>, idle() → Promise (every after-response task settled) }
// req = {method, url ('/api/v1/…?q'), headers (lower-case names), body: Buffer|null, remoteAddress}.
// After-response work (WP-S1): a handler calls ctx.after(fn) — the queued mail send, for example — and the pipeline runs
// it once the response is built, through o.background(promise) (the host's background facility, e.g. a waitUntil); without
// one the promise runs detached. keys = core/keys.js (built from config.secrets when not given); objects = the blob store
// (core/objects.js); jobs = the daily job runner for ops-daily (its own wts_jobs credential, never the request one).
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
  // ops-daily replay guard: shared through the database when there is one; the in-memory store is test-only and never used
  // in production (there a call without a shared store is refused).
  const opsNonces = o.opsNonces || (o.db ? H.dbNonceStore(o.db) : (config.production ? null : H.memoryNonceStore()));
  const keys = o.keys || require('./keys').createKeys(config);
  const pending = new Set();
  function runAfter(tasks) {
    if (!tasks.length) return;
    const p = (async () => { for (const t of tasks) { try { await t(); } catch (e) { log.warn('after-response task failed: ' + ((e && e.message) || e)); } } })();
    pending.add(p); p.then(() => pending.delete(p));
    if (typeof o.background === 'function') { try { o.background(p); } catch (e) { /* the promise still runs */ } }
  }
  async function idle() { while (pending.size) await Promise.all(Array.from(pending)); }

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

  // the provider callback answers 303 whatever happens, even before its route is matched (a malformed segment)
  const CALLBACK_RE = /^\/auth\/oauth\/[^/]+\/callback$/;

  // Any throw — also from URL splitting or route matching — ends as an envelope with the common headers (or the 303).
  async function handle(req) {
    let isCallback = false;
    try {
      return await pipeline(req, (v) => { isCallback = v; });
    } catch (e) {
      if (isCallback) { log.warn('callback: ' + ((e && e.code) || 'error')); return callbackRedirect(); }
      if (!(e instanceof ApiError)) log.warn('request threw: ' + ((e && e.message) || e));
      return fromError(e);
    }
  }

  async function pipeline(req, markCallback) {
    const { path: full, query } = H.splitUrl(req.url || '/');
    if (full !== C.BASE && full.indexOf(C.BASE + '/') !== 0) return notFound();
    if (!H.proxyOk(req, config) || !H.hostAllowed(req, config)) return notFound();
    const path = full.slice(C.BASE.length) || '/';
    if (/\.[A-Za-z0-9]+$/.test(path)) return notFound();            // no API path has a file extension (§3.2)
    const callbackPath = req.method === 'GET' && CALLBACK_RE.test(path);
    markCallback(callbackPath);
    const m = C.matchRoute(req.method, path);
    if (!m) return callbackPath ? callbackRedirect() : notFound();
    const ep = m.endpoint;
    const isCallback = ep.id === 'oauthCallback';
    markCallback(isCallback);
    try {
      const raw = req.body || null;
      if (raw && raw.length > H.bodyLimit(ep.id)) throw new ApiError('too_large', { limit: H.bodyLimit(ep.id) });
      if (ep.auth === 'report' && !H.cspContentTypeOk(req)) throw new ApiError('origin');
      if (ep.auth === 'hmac' && !(await H.verifyOps(req, full, config, now(), opsNonces))) throw new ApiError('origin');
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
      const afterTasks = [];
      const ctx = {
        req, endpoint: ep, params: m.params, query, body, raw, cookies, config, now, log, ip, ipPrefix: ipPrefix(ip),
        db: o.db || null, mail: o.mail || null, keys, objects: o.objects || null, jobs: o.jobs || null,
        after(task) { afterTasks.push(task); },
        // opts.maxAge (seconds) — required for the session cookie: seconds to abs_expires_at (contract COOKIES.session)
        setCookie(def, value, opts) { setCookies.push(H.serializeCookie(def, value, opts)); },
      };
      const fn = handlers[ep.id];
      if (typeof fn !== 'function') throw new ApiError('not_implemented');
      let r;
      try { r = (await fn(ctx)) || {}; } finally { runAfter(afterTasks.splice(0)); }
      if (isCallback) return callbackRedirect(setCookies);
      return respond(r.status || 200, r.body, { headers: r.headers, cookies: setCookies });
    } catch (e) {
      if (isCallback) { log.warn('callback: ' + ((e && e.code) || 'error')); return callbackRedirect(); }
      if (!(e instanceof ApiError)) log.warn('handler ' + ep.id + ' threw: ' + ((e && e.message) || e));
      return fromError(e);
    }
  }
  return { config, handle, idle, keys };
}

module.exports = { createApp, PAUSE_EXEMPT };
