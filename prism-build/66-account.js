// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/66-account.js — WTS_account: web accounts (docs/ACCOUNTS-PLAN.md §5, §11). Round-10, auto-discovered.
//
// WP0 FOUNDATION SKELETON. It loads everywhere and does nothing unless the page is the production web host over https (or
// DEV on localhost with window.WTS_ACCOUNT_DEV === 1), outside the iOS native shell and not framed (§5.1 guard). Even then it
// makes no request, adds no DOM, listener or timer at load: the chip, dialog and toolbar arrive with WP-C1 / WP-O behind the
// beta flag (?cloud=1 → wtspref_cloud_beta) and only once the server answers. Implemented now: the guard, configure(),
// call() (the one API client: headers, error envelope → WTS_account.Error, the outage rule's codes), providers(), state(),
// on / off, betaEnabled(). Every other planned name is a stub that rejects with Error code 'not_implemented'.
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  function nativeShell(g) {
    try {
      var c = g.Capacitor;
      if (c && typeof c.isNativePlatform === 'function') return !!c.isNativePlatform();
      return !!(c && c.isNative);
    } catch (e) { return true; }
  }
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^https?:$/.test(L.protocol || '')
    && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = ((L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk') || DEV)
    && !nativeShell(G)
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) { if (!G.WTS_account) G.WTS_account = { eligible: false }; return; }

  var VERSION = '0.1.0-wp0';
  var PROVIDERS = ['google', 'linkedin'];
  var KEYS = { hint: 'wtsacct_hint', beta: 'wtspref_cloud_beta', shared: 'wtspref_shared_browser' };

  function AccountError(code, status, body) {
    this.name = 'AccountError';
    this.code = code; this.status = status || 0;
    this.retryAfter = body && typeof body.retryAfter === 'number' ? body.retryAfter : null;
    this.body = body || null;
    this.message = (body && typeof body.message === 'string') ? body.message : code;
  }
  AccountError.prototype = Object.create(Error.prototype);
  AccountError.prototype.constructor = AccountError;

  var seams = { fetch: null, now: null, base: '/api/v1', idb: null, crypto: null, gzip: null, gunzip: null, locks: null, minDelayMs: 0, appVer: '', deviceId: null };
  function configure(o) {
    o = o || {};
    Object.keys(o).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(seams, k)) seams[k] = o[k]; });
    return api;
  }
  // seam(name) → the configured seam (null when unset); 67 reads 'crypto' through it
  function seam(k) { return Object.prototype.hasOwnProperty.call(seams, k) ? seams[k] : undefined; }
  function doFetch() { var f = seams.fetch || G.fetch; return f.apply(G, arguments); }

  // call(method, path, body, opts) → Promise<{status, json|bytes, headers}>; any non-2xx → WTS_account.Error {code, status,
  // retryAfter}. A network failure is code 'network' (status 0); a reply without an envelope is 'server'. Only the code
  // 'signed_out' may ever sign the page out (§3.2 outage rule) — callers key on code, never on status alone.
  function call(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'X-WTS-Req': '1' };
    if (seams.appVer) headers['X-WTS-App'] = String(seams.appVer);
    if (seams.deviceId) headers['X-WTS-Device'] = String(seams.deviceId);
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (opts.keepalive) init.keepalive = true;
    if (body !== undefined && body !== null && method !== 'GET') {
      if (opts.raw) { headers['Content-Type'] = 'application/octet-stream'; init.body = body; }
      else { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    } else if (method !== 'GET') { headers['Content-Type'] = 'application/json'; init.body = '{}'; }
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    var p;
    try { p = Promise.resolve(doFetch(seams.base + path, init)); } catch (e) { p = Promise.reject(e); }
    return p.then(function (r) {
      var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      if (r.status >= 200 && r.status < 300) {
        if (r.status === 204) return { status: r.status, json: null, headers: r.headers };
        if (opts.bytes || /octet-stream/.test(ct)) return r.arrayBuffer().then(function (b) { return { status: r.status, bytes: b, headers: r.headers }; });
        // a 2xx that is not JSON (e.g. the static host's page fallback while no server is configured) is 'server'
        if (!/^application\/json\b/i.test(String(ct).trim())) throw new AccountError('server', r.status, null);
        return r.json().then(function (j) { return { status: r.status, json: j, headers: r.headers }; },
          function () { throw new AccountError('server', r.status, null); });
      }
      return r.json().then(function (j) {
        if (!j || typeof j.error !== 'string') throw new AccountError('server', r.status, null);
        throw new AccountError(j.error, r.status, j);
      }, function () { throw new AccountError('server', r.status, null); });
    }, function () { throw new AccountError('network', 0, null); });
  }

  // GET /auth/providers when the sign-in dialog or the Sign-in methods card opens (a user action). On a network error both
  // buttons show and start decides (§3.3); a reply that is not the API's ('server': no envelope, not JSON) means no server
// answers, so both are off.
  function providers() {
    return call('GET', '/auth/providers').then(function (r) {
      var o = {};
      PROVIDERS.forEach(function (p) { var v = r.json && r.json[p]; o[p] = (v === 'on' || v === 'signin') ? v : 'off'; });
      return o;
    }, function (e) {
      if (e && e.code === 'network') return { google: 'on', linkedin: 'on' };
      if (e && e.code === 'server') return { google: 'off', linkedin: 'off' };
      throw e;
    });
  }

  var listeners = { state: [], error: [] };
  function on(evt, fn) { if (listeners[evt] && typeof fn === 'function') listeners[evt].push(fn); return api; }
  function off(evt, fn) { if (listeners[evt]) listeners[evt] = listeners[evt].filter(function (f) { return f !== fn; }); return api; }
  var current = { status: 'signedOut', user: null, publicDevice: false, device: null, needsConsent: false, opts: null };
  function state() { return JSON.parse(JSON.stringify(current)); }

  function lsGet(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (G.localStorage) { if (v == null) G.localStorage.removeItem(k); else G.localStorage.setItem(k, v); } } catch (e) { /* storage blocked */ } }
  // The invite beta (§5.5): ?cloud=1 remembers the flag, ?cloud=0 forgets it; the server enforces who may sign up.
  function betaEnabled() { return lsGet(KEYS.beta) === '1'; }
  (function readBetaFlag() {
    var m = /[?&]cloud=([01])(?:&|$)/.exec(L.search || '');
    if (m) lsSet(KEYS.beta, m[1] === '1' ? '1' : null);
  })();

  function notYet(name) {
    return function () { return Promise.reject(new AccountError('not_implemented', 0, { error: 'not_implemented', message: name + ' is not built yet' })); };
  }
  var api = {
    eligible: true, VERSION: VERSION, PROVIDERS: PROVIDERS.slice(), Error: AccountError, KEYS: KEYS,
    configure: configure, seam: seam, state: state, call: call, providers: providers, on: on, off: off, betaEnabled: betaEnabled,
    refresh: notYet('refresh'), openSignIn: notYet('openSignIn'), signOut: notYet('signOut'), stepUp: notYet('stepUp'),
    changeEmail: notYet('changeEmail'), setRecovery: notYet('setRecovery'), addPasskey: notYet('addPasskey'),
    removePasskey: notYet('removePasskey'), renamePasskey: notYet('renamePasskey'), signInWith: notYet('signInWith'),
    finishProviderSignIn: notYet('finishProviderSignIn'), methods: notYet('methods'), linkProvider: notYet('linkProvider'),
    unlinkMethod: notYet('unlinkMethod'),
  };
  G.WTS_account = api;
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  // pure checks only (stripped by concat): the guard leaves an ineligible stub in a plain node context
  var G = (typeof window !== 'undefined') ? window : globalThis;
  if (G.WTS_account && G.WTS_account.eligible === false && Object.keys(G.WTS_account).length !== 1) throw new Error('66 self-test: ineligible stub');
})();
