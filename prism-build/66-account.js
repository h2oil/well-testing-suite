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

  // ── WP-O: provider sign-in — Google and LinkedIn (docs/ACCOUNTS-PLAN.md §4.10–4.15, §5.2, §5.5, §11.2, §11.3) ─────────────
  // One contiguous block (merge note: WP-C1 owns the rest of this file). It replaces the stubs signInWith,
  // finishProviderSignIn, methods, linkProvider and unlinkMethod and adds:
  //   WTS_account.oauthReturn()            on a load with #acct-oauth AND a fresh hint.oauth: strip the fragment, open the
  //                                        finish dialog and drive the steps (no request without the hint entry)
  //   WTS_account.providerSignOutNeeded()  'google' | 'linkedin' | null — a public session that came from a provider
  //   WTS_account.oauthUI = {renderButtons(el, {publicDevice}), renderMethods(el), openFinish(), providerSignOutStep(p),
  //                          label(p), ASSETS, text(code, provider, reason), FRESH_OK}
  // The page loads nothing from a provider: the buttons carry inline marks (ASSETS — one fixed variant each, to be checked
  // against the providers' current official assets in WP-HC; this is the only place to swap them); start → location.assign.
  // Every server string is shown with textContent. No timer, no polling; handlers are element properties.
  installProviders();
  function installProviders() {
    var NAME = { google: 'Google', linkedin: 'LinkedIn' };
    // Fresh-login support per provider (§4.11): LinkedIn has no pinned forced-login parameter yet (WP0), so its button is
    // hidden on a public / shared-browser attempt (start would answer oauth_failed reauth_stale).
    var FRESH_OK = { google: true, linkedin: false };
    var HINT_OAUTH_MAX_MS = 30 * 60 * 1000;
    var ASSETS = {
      google: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">' +
        '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
        '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
        '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
        '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
      linkedin: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
        '<path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>',
    };
    var BTN_STYLE = 'display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;min-height:44px;' +
      'padding:8px 12px;margin:0 0 8px 0;border:1px solid #747775;border-radius:4px;background:#ffffff;color:#1f1f1f;font-size:16px;' +
      'font-weight:500;line-height:1.2;cursor:pointer';

    function label(p) { return 'Sign in with ' + NAME[p]; }
    function nowMs() { return seams.now ? seams.now() : Date.now(); }
    function readHint() { try { var h = JSON.parse(lsGet(KEYS.hint) || 'null'); return h && typeof h === 'object' ? h : {}; } catch (e) { return {}; } }
    function writeHint(h) { h.v = 3; lsSet(KEYS.hint, JSON.stringify(h)); }
    function dropOauth() { var h = readHint(); if (h.oauth) { delete h.oauth; writeHint(h); } }
    function freshOauth(h) {
      var o = h && h.oauth;
      return !!(o && PROVIDERS.indexOf(o.provider) !== -1 && typeof o.at === 'number' && nowMs() - o.at >= 0 && nowMs() - o.at < HINT_OAUTH_MAX_MS);
    }
    function sharedBrowser() { return lsGet(KEYS.shared) === '1'; }
    function currentRoute() {
      try { var r = G.WTS_pageAutosave && G.WTS_pageAutosave.page && G.WTS_pageAutosave.page(); return typeof r === 'string' ? r : 'home'; } catch (e) { return 'home'; }
    }
    // a route key the app knows (plug-in registry or a sidebar button); anything else → home (no open redirect)
    function knownRoute(r) {
      if (typeof r !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(r)) return false;
      if (G.WTS_calcRegistry && Object.prototype.hasOwnProperty.call(G.WTS_calcRegistry, r)) return true;
      try { var d = G.document; return !!(d && d.querySelector && d.querySelector('.nav-btn[data-p="' + r + '"]')); } catch (e) { return false; }
    }
    function emit(evt, v) { (listeners[evt] || []).slice().forEach(function (f) { try { f(v); } catch (e) { /* a listener's own error */ } }); }
    function offline() { try { return !!(G.navigator && G.navigator.onLine === false); } catch (e) { return false; } }
    function stepUpThen(fn) {
      return fn().catch(function (e) {
        if (!e || e.code !== 'reauth' || typeof api.stepUp !== 'function') throw e;
        return api.stepUp().then(function () { return fn(); });
      });
    }

    // start → location.assign (never a form, never a popup: §4.10 items 1–2)
    function startProvider(p, purpose, o) {
      o = o || {};
      if (PROVIDERS.indexOf(p) === -1) return Promise.reject(new AccountError('bad_request', 0, { error: 'bad_request', message: 'provider' }));
      if (offline()) return Promise.reject(new AccountError('network', 0, null));
      try { if (G.WTS_pageAutosave && typeof G.WTS_pageAutosave.flush === 'function') G.WTS_pageAutosave.flush(); } catch (e) { /* page autosave */ }
      var body = { purpose: purpose, publicDevice: !!o.publicDevice };
      if (sharedBrowser()) body.sharedBrowser = true;
      if (o.deviceLabel) body.deviceLabel = String(o.deviceLabel);
      var h = readHint();
      h.oauth = { provider: p, route: currentRoute(), at: nowMs(), purpose: purpose };
      writeHint(h);
      return call('POST', '/auth/oauth/' + p + '/start', body).then(function (r) {
        var url = r.json && r.json.url;
        if (typeof url !== 'string' || !(/^https:\/\//.test(url) || (DEV && /^http:\/\//.test(url)))) throw new AccountError('server', r.status, null);
        G.location.assign(url);
        return { url: url };
      }, function (e) { dropOauth(); throw e; });
    }
    api.signInWith = function (p, o) { return startProvider(p, 'signin', o); };
    api.linkProvider = function (p) { return stepUpThen(function () { return startProvider(p, 'link', {}); }); };

    function signedIn(res) {
      var h = readHint();
      var oa = h.oauth || {};
      delete h.oauth;
      h.signedIn = true;
      h.public = !!(res.session && res.session.publicDevice);
      h.absExpires = res.session && res.session.absExpires ? Date.parse(res.session.absExpires) : null;
      h.lastSeenAt = nowMs();
      h.initial = res.user && res.user.emailMasked ? String(res.user.emailMasked).charAt(0).toUpperCase() : '';
      writeHint(h);
      if (h.public) lsSet(KEYS.shared, '1');              // kept by the wipe; every later provider attempt is fresh-login (T30)
      current.status = 'signedIn';
      current.user = res.user || null;
      current.publicDevice = h.public;
      current.device = res.device || null;
      current.authMethod = res.method || null;
      emit('state', JSON.parse(JSON.stringify(current)));
      return oa;
    }
    var TERMINAL = ['oauth_state', 'oauth_failed', 'locked', 'not_invited', 'signup_closed', 'identity_in_use', 'provider_linked', 'provider_off', 'paused'];
    // POST finish (first call with {}; later {email} | {code} | {consent}) → the server's answer; done signs the page in
    api.finishProviderSignIn = function (body) {
      return call('POST', '/auth/oauth/finish', body || {}).then(function (r) {
        var j = r.json || {};
        if (j.next === 'done' && !j.linked) signedIn(j);
        if (j.next === 'done' && j.linked) dropOauth();
        return j;
      }, function (e) {
        if (e && TERMINAL.indexOf(e.code) !== -1) dropOauth();
        throw e;
      });
    };
    api.methods = function () { return call('GET', '/auth/methods').then(function (r) { return r.json; }); };
    api.unlinkMethod = function (id) {
      return stepUpThen(function () { return call('POST', '/auth/methods/unlink', { id: id }); }).then(function (r) { return r.json; });
    };
    api.providerSignOutNeeded = function () {
      return current.publicDevice && PROVIDERS.indexOf(current.authMethod) !== -1 ? current.authMethod : null;
    };

    // ── plain-words messages (§11.2) ──
    function text(code, p, reason) {
      var N = NAME[p] || 'The provider';
      if (code === 'oauth_failed') {
        if (reason === 'cancelled') return 'Sign-in with ' + N + ' was cancelled.';
        if (reason === 'expired') return 'That took too long — try again.';
        if (reason === 'reauth_stale') return 'Please sign in to ' + N + ' again on this shared computer.';
        return N + ' sign-in did not complete. Try again, or use the e-mail code.';
      }
      var T = {
        oauth_state: 'Sign-in was interrupted — try again.',
        provider_off: N + ' sign-in is not available right now — use the e-mail code.',
        not_invited: 'The beta is invite-only. Sign in with the address you were invited with, or use the e-mail code.',
        signup_closed: 'New accounts are not open right now. Existing accounts can still sign in.',
        locked: 'This account is locked. Please contact software@h2oil.co.uk.',
        identity_in_use: 'This ' + N + ' account is linked to another Well Testing Suite account.',
        provider_linked: 'This account already has a ' + N + ' sign-in. Remove it under Account → Sign-in methods first.',
        invalid_or_expired: 'That code is wrong or has expired.',
        consent_required: 'The Terms of Use or Privacy notice changed. Please read them and accept again.',
        reauth: 'Please confirm it is you with an e-mail code first.',
        paused: 'Cloud sign-in is paused right now — your work is saved on this device.',
        network: 'Sign-in needs a connection. Your work keeps saving on this device.',
      };
      return T[code] || 'Cloud unavailable — your work is saved on this device.';
    }
    function codeText(reason, masked, p) {
      var N = NAME[p] || 'the provider';
      if (reason === 'link_existing') return 'An account already uses ' + masked + '. Enter the code we sent to it to add ' + N + '.';
      if (reason === 'link_confirm') return 'Enter the code we sent to ' + masked + ' to add ' + N + ' as a way to sign in.';
      if (reason === 'cancel_deletion') return 'This account is being deleted. Enter the code we sent to its address to cancel the deletion.';
      return 'We sent a code to ' + masked + '. Enter it to confirm this address.';
    }

    // ── DOM helpers (textContent for every server string) ──
    function doc() { return G.document || null; }
    function el(tag, attrs, kids) {
      var n = doc().createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'text') n.textContent = attrs[k];
        else if (k === 'onclick') n.onclick = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
      (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
      return n;
    }
    function providerButton(p, purpose, onPress) {
      var b = el('button', { type: 'button', 'class': 'acct-prov-btn', 'data-provider': p, 'data-purpose': purpose, 'aria-label': label(p), style: BTN_STYLE });
      var mark = el('span', { 'class': 'acct-prov-mark', 'aria-hidden': 'true', style: 'display:inline-flex;width:20px;height:20px' });
      mark.innerHTML = ASSETS[p];                          // a constant asset, never data
      b.appendChild(mark);
      b.appendChild(el('span', { 'class': 'acct-prov-label', text: label(p) }));
      b.onclick = onPress;
      return b;
    }
    function statusLine(host, msg) {
      var s = host.querySelector('.acct-prov-status');
      if (!s) { s = el('div', { 'class': 'acct-prov-status', role: 'status', 'aria-live': 'polite', style: 'margin:4px 0 8px 0;font-size:14px' }); host.appendChild(s); }
      s.textContent = msg || '';
      return s;
    }

    // The two provider buttons for the sign-in dialog (WP-C1 calls this under its e-mail step and "or" divider). Asks
    // GET /auth/providers first (a user action); 'off' hides a button, 'signin' labels it "existing accounts only".
    // o.publicDevice: the dialog's tick. → Promise<{google, linkedin}> (the states drawn)
    function renderButtons(host, o) {
      o = o || {};
      if (!host || !doc()) return Promise.resolve(null);
      host.textContent = '';
      var fresh = !!o.publicDevice || sharedBrowser();
      return api.providers().then(function (st) {
        host.textContent = '';
        var wrap = el('div', { 'class': 'acct-prov', 'data-fresh': fresh ? '1' : '0' });
        PROVIDERS.forEach(function (p) {
          if (st[p] !== 'on' && st[p] !== 'signin') return;
          if (fresh && !FRESH_OK[p]) return;                 // no forced login for this provider: hidden while the tick is set
          wrap.appendChild(providerButton(p, 'signin', function () {
            statusLine(wrap, 'Taking you to ' + NAME[p] + '…');
            api.signInWith(p, { publicDevice: !!o.publicDevice }).catch(function (e) {
              statusLine(wrap, text(e && e.code, p, e && e.body && e.body.reason));
            });
          }));
          if (st[p] === 'signin') wrap.appendChild(el('div', { 'class': 'acct-prov-note', text: 'existing accounts only', style: 'margin:-4px 0 8px 0;font-size:13px' }));
        });
        var any = !!wrap.querySelector('.acct-prov-btn');
        if (fresh && any) {
          wrap.appendChild(el('div', { 'class': 'acct-prov-note acct-prov-public', style: 'font-size:13px;margin:0 0 8px 0',
            text: 'You will also be signed in to Google / LinkedIn in this browser — sign out of it too when you finish.' }));
        }
        if (any) wrap.appendChild(el('div', { 'class': 'acct-prov-note', style: 'font-size:13px', text: "Can't use Google or LinkedIn? Use the e-mail code." }));
        if (offline()) Array.prototype.forEach.call(wrap.querySelectorAll('.acct-prov-btn'), function (b) { b.disabled = true; b.setAttribute('title', 'needs a connection'); });
        host.appendChild(wrap);
        return st;
      });
    }

    // ── the finish dialog (the return from the provider) ──
    var dlg = null;
    function dialog() {
      var d = doc();
      if (!d || !d.body) return null;
      if (dlg && dlg.isConnected) return dlg;
      dlg = el('div', { id: 'acct_oauth_dlg', 'class': 'acct-oauth-dlg rp-skip', 'data-rp-nosnap': '1', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'acct_oauth_title', style: 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,0.45);display:block;overflow:auto;padding:16px' });
      var box = el('div', { 'class': 'acct-oauth-box', style: 'max-width:420px;margin:8vh auto 0 auto;background:#ffffff;color:#1f1f1f;border-radius:8px;padding:20px 16px;box-sizing:border-box' });
      box.appendChild(el('h2', { id: 'acct_oauth_title', text: 'Sign in', style: 'font-size:18px;margin:0 0 12px 0' }));
      box.appendChild(el('div', { id: 'acct_oauth_body' }));
      dlg.appendChild(box);
      dlg.onkeydown = function (ev) { if (ev && ev.key === 'Escape') closeDialog(); };
      d.body.appendChild(dlg);
      return dlg;
    }
    function closeDialog() { if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg); dlg = null; }
    function dbody() { var d = dialog(); return d ? d.querySelector('#acct_oauth_body') : null; }
    function btn(id, txt, primary, fn) {
      return el('button', { type: 'button', id: id, 'class': primary ? 'btn btn-primary' : 'btn btn-secondary', onclick: fn,
        style: 'min-height:44px;font-size:16px;margin:8px 8px 0 0', text: txt });
    }
    function show(nodes) { var b = dbody(); if (!b) return; b.textContent = ''; nodes.forEach(function (n) { if (n) b.appendChild(n); }); }
    function showError(msg) {
      show([el('p', { 'class': 'acct-oauth-error', role: 'alert', text: msg }),
        el('p', { style: 'font-size:13px', text: "Can't use Google or LinkedIn? Use the e-mail code." }),
        btn('acct_oauth_close', 'Close', true, function () { closeDialog(); })]);
    }
    function restoreRoute(oa) {
      var r = oa && oa.route;
      try { if (typeof G.WTS_nav === 'function') G.WTS_nav(knownRoute(r) ? r : 'home'); } catch (e) { /* navigation */ }
    }
    function drive(p, body0, oa) {
      var keep = body0 && body0.code !== undefined ? dbody() && dbody().querySelector('.acct-oauth-msg') : null;
      show([el('p', { 'class': 'acct-oauth-busy', role: 'status', 'aria-live': 'polite', text: 'Finishing sign-in…' })]);
      return api.finishProviderSignIn(body0).then(function (j) { return step(p, j, oa); }, function (e) {
        if (e && e.code === 'invalid_or_expired' && keep) {
          // a wrong code: stay on the code step (5 tries per code)
          step(p, { next: 'code', reason: keep.getAttribute('data-reason'), emailMasked: keep.getAttribute('data-masked') }, oa);
          var m = dbody().querySelector('.acct-oauth-msg');
          dbody().insertBefore(el('p', { 'class': 'acct-oauth-error', role: 'alert', text: text('invalid_or_expired', p) }), m);
          return { error: e.code };
        }
        showError(text(e && e.code, p, e && e.body && e.body.reason));
        return { error: e && e.code };
      });
    }
    function step(p, j, oa) {
      var N = NAME[p] || '';
      if (j.next === 'done') {
        if (j.linked) {
          show([el('p', { 'class': 'acct-oauth-linked', text: N + ' was added as a way to sign in.' }), btn('acct_oauth_close', 'Close', true, function () { closeDialog(); })]);
          return j;
        }
        restoreRoute(oa);
        if (j.providerEmailDiffers) {
          show([el('p', { 'class': 'acct-oauth-differs', text: 'Your ' + N + ' e-mail address is different from your account e-mail (' + ((j.user && j.user.emailMasked) || '') + '). Your account e-mail does not change by itself.' }),
            btn('acct_oauth_change', 'Change account e-mail', false, function () { closeDialog(); if (typeof api.changeEmail === 'function') api.changeEmail().catch(function () {}); }),
            btn('acct_oauth_keep', 'Keep my account e-mail', true, function () { closeDialog(); })]);
          return j;
        }
        closeDialog();
        return j;
      }
      if (j.next === 'email') {
        var inp = el('input', { id: 'acct_oauth_email', type: 'email', inputmode: 'email', autocomplete: 'email', 'aria-label': 'E-mail address', style: 'width:100%;box-sizing:border-box;font-size:16px;min-height:44px' });
        inp.value = j.emailPrefill || '';
        show([el('p', { 'class': 'acct-oauth-msg', text: (j.reason === 'missing' ? N + ' did not share an e-mail address. ' : '') + 'Confirm the e-mail address for this account — we will send a code to it.' }), inp,
          btn('acct_oauth_send', 'Send code', true, function () { drive(p, { email: String(inp.value || '').trim() }, oa); })]);
        return j;
      }
      if (j.next === 'code') {
        var ci = el('input', { id: 'acct_oauth_code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '9', 'aria-label': 'Code', style: 'width:100%;box-sizing:border-box;font-size:16px;min-height:44px;letter-spacing:2px' });
        show([el('p', { 'class': 'acct-oauth-msg', 'data-reason': j.reason || 'verify', 'data-masked': j.emailMasked || '', text: codeText(j.reason, j.emailMasked, p) }), ci,
          btn('acct_oauth_verify', 'Continue', true, function () {
            var reason = j.reason;
            drive(p, { code: String(ci.value || '').replace(/\s/g, '') }, oa).then(function (r) {
              if (reason === 'cancel_deletion' && r && r.next === 'done') offerCancelDeletion();
            });
          })]);
        return j;
      }
      if (j.next === 'consent') {
        var c = { terms: j.terms || '1', privacy: j.privacy || '1' };
        show([el('p', { 'class': 'acct-oauth-consent', text: 'You are creating a new account for ' + j.newAccountEmailMasked + '. Already have an account with another address? Sign in with it, then add ' + N + ' under Account → Sign-in methods.' }),
          el('p', { style: 'font-size:13px', text: 'Creating an account means you accept the Terms of Use and the Privacy notice.' }),
          btn('acct_oauth_create', 'Create account', true, function () { drive(p, { consent: c }, oa); }),
          btn('acct_oauth_cancel', 'Cancel', false, function () { dropOauth(); closeDialog(); })]);
        return j;
      }
      showError(text('server', p));
      return j;
    }
    function offerCancelDeletion() {
      show([el('p', { 'class': 'acct-oauth-undelete-msg', text: 'This account is being deleted. You can cancel the deletion now.' }),
        btn('acct_oauth_undelete', 'Cancel deletion', true, function () {
          call('POST', '/account/delete/cancel', {}).then(function () { closeDialog(); }, function (e) { showError(text(e && e.code)); });
        }),
        btn('acct_oauth_close', 'Close', false, function () { closeDialog(); })]);
    }
    function openFinish() { var oa = readHint().oauth || {}; dialog(); return drive(oa.provider, {}, oa); }
    api.oauthReturn = function () {
      if (L.hash !== '#acct-oauth') return null;
      if (!freshOauth(readHint())) return null;            // the fragment alone is ignored: no request
      try { if (G.history && G.history.replaceState) G.history.replaceState(null, '', (L.pathname || '/') + (L.search || '')); } catch (e) { /* history */ }
      return openFinish();
    };

    // The blocking step after a public sign-out of a provider session (§11.2): resolves on [I have signed out]; Escape does
    // not close it.
    function providerSignOutStep(p) {
      return new Promise(function (resolve) {
        if (!doc() || !doc().body) { resolve(false); return; }
        dialog();
        var N = NAME[p] || 'the provider';
        show([el('p', { 'class': 'acct-oauth-signout', text: 'Now sign out of ' + N + ' in this browser: open ' + N + ', choose your account picture or name, then Sign out. This computer is shared, so the next person must not find you signed in there.' }),
          btn('acct_oauth_signedout', 'I have signed out', true, function () { closeDialog(); resolve(true); })]);
        if (dlg) dlg.onkeydown = null;
      });
    }

    // The Sign-in methods card of the account page (68 delegates here): e-mail (always), recovery, Google, LinkedIn, passkeys.
    function fmtDate(s) { try { return s ? new Date(s).toISOString().slice(0, 10) : '—'; } catch (e) { return '—'; } }
    function renderMethods(host) {
      if (!host || !doc()) return Promise.resolve(null);
      host.textContent = '';
      var card = el('div', { 'class': 'card acct-methods', id: 'acct_methods' }, [el('div', { 'class': 'card-title', text: 'Sign-in methods' })]);
      host.appendChild(card);
      var list = el('div', { 'class': 'acct-methods-list' });
      card.appendChild(list);
      var msg = el('div', { 'class': 'acct-methods-msg', role: 'status', 'aria-live': 'polite', style: 'font-size:14px;margin-top:6px' });
      return Promise.all([api.methods(), api.providers().catch(function () { return { google: 'off', linkedin: 'off' }; })]).then(function (r) {
        var m = r[0] || {}; var st = r[1] || {};
        function row(title, detail, actions, p) {
          var d = el('div', { 'class': 'acct-method-row', 'data-method': p || title, style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e0e0e0' });
          d.appendChild(el('div', { style: 'flex:1 1 220px' }, [el('div', { 'class': 'acct-method-title', text: title, style: 'font-weight:600' }), el('div', { 'class': 'acct-method-detail', text: detail, style: 'font-size:14px' })]));
          var a = el('div', { 'class': 'acct-method-actions', style: 'flex:1 1 200px' });
          (actions || []).forEach(function (x) { if (x) a.appendChild(x); });
          d.appendChild(a);
          list.appendChild(d);
          return a;
        }
        row('E-mail code', ((m.email && m.email.masked) || '') + ' — always on', [typeof api.changeEmail === 'function' ? btn('acct_m_email', 'Change e-mail', false, function () { api.changeEmail().catch(function () {}); }) : null], 'email');
        row('Recovery address', m.recovery ? m.recovery.masked : 'Not set', [], 'recovery');
        PROVIDERS.forEach(function (p) {
          var i = (m.identities || []).filter(function (x) { return x.provider === p; })[0];
          if (i) {
            var a = row(NAME[p], (i.emailMasked || 'no e-mail shared') + ' · linked ' + fmtDate(i.linkedAt) + ' · last used ' + (i.lastUsedAt ? fmtDate(i.lastUsedAt) : 'never'), [
              btn('acct_m_unlink_' + p, 'Unlink', false, function () {
                msg.textContent = '';
                api.unlinkMethod(i.id).then(function (res) {
                  var n = res.sessionsRevoked;
                  return renderMethods(host).then(function () {
                    var c = host.querySelector('.acct-methods-msg');
                    if (c) c.textContent = NAME[p] + ' was removed. ' + n + ' session' + (n === 1 ? '' : 's') + ' it opened ' + (n === 1 ? 'was' : 'were') + ' signed out.';
                  });
                }, function (e) { msg.textContent = text(e && e.code, p); });
              })], p);
            a.appendChild(el('div', { style: 'font-size:13px', text: 'Unlinking signs out every session it opened.' }));
          } else if (st[p] === 'on') {
            row(NAME[p], 'Not linked', [providerButton(p, 'link', function () {
              msg.textContent = 'Taking you to ' + NAME[p] + '…';
              api.linkProvider(p).catch(function (e) { msg.textContent = text(e && e.code, p, e && e.body && e.body.reason); });
            })], p);
          }
        });
        (m.passkeys || []).forEach(function (k) { row('Passkey', k.name + ' · added ' + fmtDate(k.created), [], 'passkey'); });
        card.appendChild(el('p', { 'class': 'acct-methods-note', style: 'font-size:13px', text: 'Your e-mail address always works as a way in, even if you lose your Google or LinkedIn account.' }));
        card.appendChild(msg);
        return m;
      }, function (e) {
        card.appendChild(el('p', { 'class': 'acct-methods-error', text: text(e && e.code) }));
        return null;
      });
    }

    api.oauthUI = { renderButtons: renderButtons, renderMethods: renderMethods, openFinish: openFinish, providerSignOutStep: providerSignOutStep,
      label: label, ASSETS: ASSETS, text: text, FRESH_OK: FRESH_OK };
    if (L.hash === '#acct-oauth') api.oauthReturn();
  }
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  // pure checks only (stripped by concat): the guard leaves an ineligible stub in a plain node context
  var G = (typeof window !== 'undefined') ? window : globalThis;
  if (G.WTS_account && G.WTS_account.eligible === false && Object.keys(G.WTS_account).length !== 1) throw new Error('66 self-test: ineligible stub');
})();
