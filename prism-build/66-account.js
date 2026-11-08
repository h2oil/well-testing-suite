// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/66-account.js — WTS_account: web accounts (docs/ACCOUNTS-PLAN.md §3.2, §4, §5, §10, §11). Round-10, auto-discovered.
//
// It loads everywhere and does nothing unless the page is the production web host over https (or DEV on localhost with
// window.WTS_ACCOUNT_DEV === 1), outside the iOS native shell and not framed (§5.1 guard). Even then nothing is mounted,
// registered or requested unless the invite-beta flag is set (?cloud=1 → wtspref_cloud_beta, §5.5), and a signed-out first
// visit makes no request at all: GET /me runs only when the device hint says a session exists. So while no server answers,
// the live site behaves exactly as v3.4.
//
// WP-C1 (this file): the guard, configure() seams, the one API client call() (headers, error envelope → WTS_account.Error,
// the §3.2 outage rule: only code 'signed_out' signs the page out), the session state machine and the device hint, the
// sign-in dialog (e-mail code first, "Didn't get the code?", consent for a new account, public-computer tick), step-up in
// place (code to the primary or the recovery address), sign-out / sign out everywhere, the header chip and its menu, the
// project-toolbar cloud button (H5), Ctrl+S while linked, the bottom status bar #wts_sync_bar, and the one reload after a
// sign-in on a page where the analytics tag ran (H17, D20).
//
// WP-O MOUNT POINTS (provider sign-in is built there, not here): the e-mail step draws an empty
// <div id="acct_provider_buttons" data-owner="WP-O"> and calls WTS_account.hooks.renderProviders(el, providers, ctx) when WP-O
// has set it (GET /auth/providers runs only then). signInWith / finishProviderSignIn / methods / linkProvider / unlinkMethod
// stay stubs that reject 'not_implemented' until WP-O replaces them; WP-O completes a sign-in through WTS_account._i
// (completeSignIn, choose, setStep, message) so the hand-over, consent and analytics steps are shared. A load with
// #acct-oauth and a fresh hint.oauth entry calls finishProviderSignIn() (WP-O); without the hint entry it is ignored.
// The account page's Sign-in methods card is mounted by 68 the same way (WTS_accountPage.hooks.renderMethods).
//
// No polling, no setInterval, no function wrapping; the only timer is the one-shot mount (setTimeout 0).
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

  var VERSION = '1.0.0';
  var PROVIDERS = ['google', 'linkedin'];
  var KEYS = { hint: 'wtsacct_hint', beta: 'wtspref_cloud_beta', cloudOpen: 'wtspref_cloud_open', shared: 'wtspref_shared_browser' };
  var SUPPORT = 'software@h2oil.co.uk';
  var HAS_DOC = typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';

  // ── errors and seams ───────────────────────────────────────────────────────────────────────────────────────────────
  function AccountError(code, status, body) {
    this.name = 'AccountError';
    this.code = code; this.status = status || 0;
    this.retryAfter = body && typeof body.retryAfter === 'number' ? body.retryAfter : null;
    this.body = body || null;
    this.message = (body && typeof body.message === 'string') ? body.message : code;
  }
  AccountError.prototype = Object.create(Error.prototype);
  AccountError.prototype.constructor = AccountError;

  // fetch, now, base, idb, crypto, gzip, gunzip, locks, minDelayMs: §5.2 test seams; appVer, deviceId: request headers;
  // reload / assign: page navigation (the analytics reload, WP-O's redirect); online: () → bool (navigator.onLine).
  var seams = { fetch: null, now: null, base: '/api/v1', idb: null, crypto: null, gzip: null, gunzip: null, locks: null, minDelayMs: 0,
    appVer: '', deviceId: null, reload: null, assign: null, online: null, maxProjectBytes: 64 * 1000 * 1000 };
  function configure(o) {
    o = o || {};
    Object.keys(o).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(seams, k)) seams[k] = o[k]; });
    // a store seam set after the mount: let 67 open it now (the load-time public expiry wipe finishes there)
    if (o.idb && mounted && G.WTS_cloudSync && typeof G.WTS_cloudSync._init === 'function') G.WTS_cloudSync._init();
    return api;
  }
  function seam(k) { return Object.prototype.hasOwnProperty.call(seams, k) ? seams[k] : undefined; }
  function now() { return typeof seams.now === 'function' ? seams.now() : Date.now(); }
  function doFetch() { var f = seams.fetch || G.fetch; return f.apply(G, arguments); }
  function appVer() {
    if (seams.appVer) return String(seams.appVer);
    try { var rn = G.RELEASE_NOTES; if (rn && rn[0] && rn[0].ver) return String(rn[0].ver); } catch (e) { /* none */ }
    var el = HAS_DOC && document.getElementById('appVersionLabel');
    var m = el && /(\d+\.\d+(?:\.\d+)?)/.exec(el.textContent || '');
    return m ? m[1] : '';
  }
  function isOnline() {
    if (typeof seams.online === 'function') return !!seams.online();
    try { return !(G.navigator && G.navigator.onLine === false); } catch (e) { return true; }
  }

  // call(method, path, body, opts) → Promise<{status, json|bytes, headers}>; any non-2xx → WTS_account.Error {code, status,
  // retryAfter}. A network failure is code 'network' (status 0); a reply without an envelope is 'server'. Only the code
  // 'signed_out' may ever sign the page out (§3.2 outage rule) — callers key on code, never on status alone.
  function call(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'X-WTS-Req': '1' };
    var av = appVer(); if (av) headers['X-WTS-App'] = av;
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
  // the outage family: no answer from our API (network, a 5xx without an envelope, or a non-API reply)
  function isOutage(e) { return !!e && (e.code === 'network' || e.code === 'server'); }

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

  // ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return HAS_DOC ? document.getElementById(id) : null; }
  function lsGet(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (G.localStorage) { if (v == null) G.localStorage.removeItem(k); else G.localStorage.setItem(k, v); } } catch (e) { /* storage blocked */ } }
  function hhmm(ms) {
    if (!ms) return '';
    var d = new Date(ms); var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function emit(name, detail) {
    try { if (HAS_DOC && typeof G.CustomEvent === 'function') document.dispatchEvent(new G.CustomEvent(name, { detail: detail })); } catch (e) { /* none */ }
  }
  function deviceLabel() {
    var ua = ''; try { ua = String((G.navigator && G.navigator.userAgent) || ''); } catch (e) { /* none */ }
    var os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Computer';
    var br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return (os + ' ' + br).replace(/[^A-Za-z0-9 _.()-]/g, '').slice(0, 40);
  }
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
  function sync() { return G.WTS_cloudSync || null; }

  // ── device hint (§5.3): non-secret, paints the chip, drives the analytics guard and the public expiry wipe ─────────────
  function readHint() {
    try { var o = JSON.parse(lsGet(KEYS.hint) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
  }
  function writeHint(h) { lsSet(KEYS.hint, h ? JSON.stringify(h) : null); }
  function betaEnabled() { return lsGet(KEYS.beta) === '1'; }
  (function readBetaFlag() {
    var m = /[?&]cloud=([01])(?:&|$)/.exec(L.search || '');
    if (m) lsSet(KEYS.beta, m[1] === '1' ? '1' : null);
  })();

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  var listeners = { state: [], error: [] };
  function on(evt, fn) { if (listeners[evt] && typeof fn === 'function') listeners[evt].push(fn); return api; }
  function off(evt, fn) { if (listeners[evt]) listeners[evt] = listeners[evt].filter(function (f) { return f !== fn; }); return api; }
  function fire(evt, v) { (listeners[evt] || []).slice().forEach(function (f) { try { f(v); } catch (e) { /* listener */ } }); }
  var current = { status: 'signedOut', user: null, publicDevice: false, device: null, needsConsent: false, opts: null,
    authMethod: null, me: null, reason: null, lastOkAt: null };
  function state() { return JSON.parse(JSON.stringify(current)); }
  function setState(patch) {
    var before = current.status;
    Object.keys(patch).forEach(function (k) { current[k] = patch[k]; });
    if (current.status === 'signedIn') attachSignedIn(); else detachSignedIn();
    fire('state', state());
    if (before !== current.status || patch.reason !== undefined) emit('wts:account-changed', { status: current.status, reason: current.reason });
    renderChip(); renderBar();
    refreshToolbar();
  }
  function applyMe(me) {
    var u = me.user || {};
    current.lastOkAt = now();
    var h = readHint() || {};
    writeHint({ signedIn: true, initial: (String(u.emailMasked || '?')[0] || '?').toUpperCase(), public: !!(me.session && me.session.publicDevice),
      absExpires: me.session ? me.session.absExpires : null, lastSeenAt: now(), oauth: undefined, v: 3, deleting: u.status === 'deleting' || undefined,
      sync: h.sync });
    setState({ status: 'signedIn', user: u, publicDevice: !!(me.session && me.session.publicDevice), opts: me.opts || null,
      authMethod: me.session ? me.session.authMethod : null, me: me, reason: null, needsConsent: false });
  }
  var refreshing = null;
  // refresh(): GET /me. A 401 signed_out re-reads once (the 30 s step-up rotation race, §4.7) before it signs the page out;
  // an outage keeps the hint and shows "Cloud unavailable" (§3.2); 'paused' shows the paused text.
  function refresh() {
    if (refreshing) return refreshing;
    var tries = 0;
    function once() {
      tries++;
      return call('GET', '/me').then(function (r) { applyMe(r.json); return state(); }, function (e) {
        if (e && e.code === 'signed_out') {
          if (tries < 2) return once();
          return signedOutLocal('expired').then(state);
        }
        if (e && e.code === 'locked') { setState({ status: 'unavailable', reason: 'locked' }); fire('error', e); return state(); }
        if (e && (e.code === 'paused' || isOutage(e) || e.status >= 500 || e.code === 'rate' || e.code === 'upgrade')) {
          setState({ status: 'unavailable', reason: e.code === 'paused' ? 'paused' : e.code === 'upgrade' ? 'upgrade' : 'outage' });
          fire('error', e); return state();
        }
        fire('error', e); throw e;
      });
    }
    refreshing = once().then(function (s) { refreshing = null; return s; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  // The page is signed out (a 401 signed_out on any call, or a sign-out). The outbox, base and binding are kept (§6.9); a
  // public device runs the expiry wipe (§10.8).
  function signedOutLocal(reason) {
    var h = readHint();
    var wasPublic = !!(h && h.public) || current.publicDevice;
    var S = sync();
    var p = Promise.resolve();
    if (S && typeof S._noteSignedOut === 'function') p = p.then(function () { return S._noteSignedOut(current.user); });
    if (wasPublic && S && typeof S.wipeDevice === 'function') p = p.then(function () { return S.wipeDevice({ reason: 'expiry', historian: true }); });
    return p.then(null, function () { /* the wipe reports its own errors */ }).then(function () {
      writeHint(null);
      setState({ status: 'signedOut', user: null, publicDevice: false, device: null, opts: null, authMethod: null, me: null, reason: reason || null });
    });
  }
  // Every caller of the API funnels errors through here: only 'signed_out' changes the state (outage rule).
  function handleError(e) {
    if (e && e.code === 'signed_out' && current.status === 'signedIn') {
      return refresh().then(function () { throw e; }, function () { throw e; });
    }
    if (e && isOutage(e) && current.status === 'signedIn') { current.reason = 'outage'; renderChip(); renderBar(); }
    return Promise.reject(e);
  }

  // ── sign-in completion (shared with WP-O's finish) ─────────────────────────────────────────────────────────────────
  // body = a SignInResult (code/verify, finish 'done'). Sets the device id, the hint, the shared-browser flag, reads /me,
  // runs the hand-over (§10) and, when the analytics tag ran in this page, flushes and reloads once (§11.2 step 6).
  function completeSignIn(body, o) {
    o = o || {};
    if (body && body.device && body.device.id) seams.deviceId = body.device.id;
    var S = sync();
    if (S && typeof S._setDevice === 'function' && body && body.device) S._setDevice(body.device.id);
    if (body && body.session && body.session.publicDevice) lsSet(KEYS.shared, '1');
    writeHint({ signedIn: true, initial: (String((body && body.user && body.user.emailMasked) || '?')[0] || '?').toUpperCase(),
      public: !!(body && body.session && body.session.publicDevice), absExpires: body && body.session ? body.session.absExpires : null,
      lastSeenAt: now(), v: 3 });
    setStep('busy', { text: 'Signing in…' });
    return refresh().then(function () {
      if (current.status !== 'signedIn') { closeDialog(); return state(); }
      var p = (S && typeof S.afterSignIn === 'function') ? S.afterSignIn(current.user, { firstSignIn: !!(body && body.firstSignIn), method: o.method || 'code' }) : Promise.resolve(null);
      return Promise.resolve(p).then(null, function () { return null; }).then(function () {
        if (G.__wtsGaLoaded === true) {
          setStep('busy', { text: 'Finishing sign-in…' });
          try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.flush) G.WTS_pageAutosave.flush(); } catch (e) { /* none */ }
          var rl = seams.reload || function () { try { L.reload(); } catch (e) { /* none */ } };
          rl();
          return state();
        }
        closeDialog();
        return state();
      });
    });
  }

  // ── dialog (§11.2) ─────────────────────────────────────────────────────────────────────────────────────────────────
  var dlg = { open: false, mode: null, step: null, email: '', publicDevice: false, consent: null, opener: null, resolve: null,
    choice: null, onKey: null };
  var hooks = { renderProviders: null, onPublicSignOut: null };
  var MSG = {
    network: 'Sign-in needs a connection. Your work keeps saving on this device.',
    server: 'Cloud unavailable — your work is saved on this device. Try again later.',
    paused: 'Cloud sign-in is paused right now. Your work keeps saving on this device.',
    invalid_or_expired: 'That code is wrong or has expired. Check it, or send a new code.',
    locked: 'This account is locked. Contact ' + SUPPORT + '.',
    upgrade: 'Please reload the page to update the app before signing in.',
    bad_request: 'Please check the address and try again.',
    consent_required: 'The Terms of Use or the Privacy notice changed. Please accept the current versions.',
    reauth: 'Please confirm it is you with a code.',
  };
  function errText(e) {
    if (!e) return 'Something went wrong. Try again.';
    if (e.code === 'rate') return 'Too many attempts. Try again in ' + Math.max(1, Math.round(e.retryAfter || 30)) + ' s.';
    if (MSG[e.code]) return MSG[e.code];
    if (e.status >= 500) return MSG.server;
    return 'Something went wrong (' + esc(e.code) + '). Try again.';
  }
  function message(text, kind) {
    var m = $('acct_msg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'acct-msg' + (kind ? ' acct-msg--' + kind : '');
  }
  function ensureCss() {
    if (!HAS_DOC || $('acct_css')) return;
    var st = document.createElement('style'); st.id = 'acct_css';
    st.textContent = [
      '.acct-chip{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 10px;border-radius:16px;border:1px solid var(--border,#555);background:var(--bg3,#222);color:var(--text,#eee);font-size:13px;cursor:pointer}',
      '.acct-chip:focus-visible{outline:2px solid var(--accent,#4da3ff);outline-offset:2px}',
      '.acct-init{display:inline-flex;width:22px;height:22px;border-radius:50%;align-items:center;justify-content:center;background:var(--accent,#2f6fb0);color:#fff;font-weight:700;font-size:12px}',
      '.acct-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#888}',
      '.acct-dot--ok{background:#2fa84f}.acct-dot--warn{background:#e0a020}.acct-dot--bad{background:#d9483b}.acct-dot--off{background:#888}',
      '.acct-dot--hollow{background:transparent;border:2px solid #888;box-sizing:border-box}',
      '.acct-dot--spin{background:#4da3ff;animation:acctPulse 1s ease-in-out infinite}@keyframes acctPulse{50%{opacity:.35}}',
      '.acct-wrap{position:relative;display:inline-block}',
      '.acct-menu,.acct-cloud-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:10050;min-width:240px;background:var(--bg2,#1b1b1b);border:1px solid var(--border,#555);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);padding:6px;display:flex;flex-direction:column;gap:2px}',
      '.acct-menu button,.acct-cloud-menu button{text-align:left;background:none;border:0;color:var(--text,#eee);padding:8px 10px;border-radius:6px;font-size:14px;cursor:pointer;min-height:36px}',
      '.acct-menu button:hover,.acct-cloud-menu button:hover,.acct-menu button:focus-visible,.acct-cloud-menu button:focus-visible{background:var(--bg3,#2a2a2a)}',
      '.acct-menu-who{padding:6px 10px;color:var(--text2,#bbb);font-size:12px;border-bottom:1px solid var(--border,#444);margin-bottom:4px}',
      '.acct-ov{position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;overflow:auto}',
      '.acct-dlg{background:var(--bg2,#1b1b1b);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:10px;width:100%;max-width:440px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.5);box-sizing:border-box}',
      '.acct-dlg h3{margin:0 0 10px;font-size:18px;display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.acct-dlg label{display:block;margin:10px 0 4px;font-size:13px;color:var(--text2,#ccc)}',
      '.acct-dlg input[type=email],.acct-dlg input[type=text]{width:100%;box-sizing:border-box;font-size:16px;padding:9px 10px;border-radius:6px;border:1px solid var(--border,#555);background:var(--bg,#111);color:var(--text,#eee)}',
      '.acct-dlg .acct-tick{display:flex;gap:8px;align-items:flex-start;font-size:13px}',
      '.acct-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.acct-btns .btn{min-height:40px}',
      '.acct-or{display:flex;align-items:center;gap:8px;margin:14px 0 8px;color:var(--text3,#999);font-size:12px}.acct-or:before,.acct-or:after{content:"";flex:1;border-top:1px solid var(--border,#444)}',
      '.acct-providers:empty{display:none}.acct-providers{display:flex;flex-direction:column;gap:8px}',
      '.acct-or.acct-or--none{display:none}',
      '.acct-msg{min-height:1.2em;margin-top:10px;font-size:13px}.acct-msg--err{color:#ff8a80}.acct-msg--ok{color:#8bd48b}',
      '.acct-note{font-size:12px;color:var(--text3,#aaa);margin-top:8px}',
      '.acct-faq{margin-top:12px;font-size:13px}.acct-faq ul{padding-left:18px;margin:6px 0}.acct-faq li{margin:4px 0}',
      '.acct-x{background:none;border:0;color:var(--text2,#ccc);font-size:20px;cursor:pointer;min-width:36px;min-height:36px}',
      '.acct-list{list-style:none;padding:0;margin:8px 0;max-height:46vh;overflow:auto}.acct-list li{padding:6px 0;border-bottom:1px solid var(--border,#333)}',
      '#wts_sync_bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10040;background:var(--bg3,#222);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:8px;padding:8px 10px 8px 14px;display:block;font-size:13px;max-width:calc(100vw - 32px);box-shadow:0 6px 24px rgba(0,0,0,.4);box-sizing:border-box}',
      '#wts_sync_bar .acct-bar-in{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '@media (max-width:600px){.acct-chip .acct-txt{display:none}.acct-chip{min-width:44px;min-height:44px;justify-content:center;padding:4px}',
      '.acct-ov{padding:0;align-items:stretch}.acct-dlg{max-width:none;min-height:100%;border-radius:0;padding:16px}',
      '.acct-btns .btn{flex:1 1 100%;min-height:44px;font-size:16px}.acct-menu button,.acct-cloud-menu button{min-height:44px;font-size:16px}',
      '.acct-menu,.acct-cloud-menu{position:fixed;left:16px;right:16px;top:auto;min-width:0}',
      '#wts_sync_bar{left:16px;right:16px;transform:none;max-width:none}}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function openDialog(mode, opts) {
    if (!HAS_DOC) return null;
    ensureCss();
    var ov = $('acct_dlg_ov');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'acct_dlg_ov';
      ov.className = 'acct-ov rp-skip';
      ov.setAttribute('data-rp-nosnap', '1');
      ov.innerHTML = '<div class="acct-dlg" id="acct_dlg" role="dialog" aria-modal="true" aria-labelledby="acct_dlg_t">' +
        '<h3><span id="acct_dlg_t">Sign in</span><button type="button" class="acct-x" id="acct_dlg_x" aria-label="Close">&#215;</button></h3>' +
        '<div id="acct_dlg_body"></div><div id="acct_msg" class="acct-msg" role="status" aria-live="polite"></div></div>';
      document.body.appendChild(ov);
      $('acct_dlg_x').addEventListener('click', function () { closeDialog(true); });
      dlg.onKey = function (ev) { if (ev && ev.key === 'Escape' && dlg.open) { ev.preventDefault && ev.preventDefault(); closeDialog(true); } };
      document.addEventListener('keydown', dlg.onKey);
      try { dlg.opener = document.activeElement; } catch (e) { dlg.opener = null; }
    }
    dlg.open = true; dlg.mode = mode || dlg.mode || 'signin';
    if (opts && opts.title) $('acct_dlg_t').textContent = opts.title;
    return ov;
  }
  // closeDialog(cancelled): removes the overlay, returns focus, settles a pending choose() with null.
  function closeDialog(cancelled) {
    var ov = $('acct_dlg_ov');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    if (dlg.onKey && HAS_DOC) document.removeEventListener('keydown', dlg.onKey);
    dlg.onKey = null;
    var wasOpen = dlg.open;
    dlg.open = false; dlg.step = null;
    var ch = dlg.choice; dlg.choice = null;
    if (ch) ch(null);
    var r = dlg.resolve; dlg.resolve = null;
    if (r && wasOpen) r(cancelled ? null : state());
    try { if (dlg.opener && dlg.opener.focus) dlg.opener.focus(); } catch (e) { /* gone */ }
    dlg.opener = null;
  }
  function body() { return $('acct_dlg_body'); }
  function setTitle(t) { var e = $('acct_dlg_t'); if (e) e.textContent = t; }
  function focusFirst(id) { var e = $(id); try { if (e && e.focus) e.focus(); } catch (x) { /* none */ } }

  // setStep(name, data) — the one place a step is drawn. Steps: email, code, consent, stepup, busy, choice (choose()).
  function setStep(name, data) {
    if (!dlg.open && name !== 'busy') openDialog(dlg.mode);
    if (!dlg.open) return;
    data = data || {};
    dlg.step = name;
    var b = body(); if (!b) return;
    message('');
    if (name === 'email') return drawEmail(b, data);
    if (name === 'code') return drawCode(b, data);
    if (name === 'consent') return drawConsent(b, data);
    if (name === 'stepup') return drawStepUp(b, data);
    if (name === 'busy') { b.innerHTML = '<p>' + esc(data.text || 'Working…') + '</p>'; return; }
    if (name === 'revert') return drawRevert(b, data);
  }
  // #account-revert (the link in the "your e-mail address was changed" notice, §4.3): the old address and the 7-day revert code
  function drawRevert(b) {
    setTitle('Undo an e-mail change');
    b.innerHTML = '<p>Your account\'s e-mail address was changed. If that was not you, enter your previous address and the code from the notice. ' +
      'This signs out every session and removes sign-in methods added since the change.</p>' +
      '<label for="acct_rev_email">Previous e-mail address</label><input type="email" id="acct_rev_email" maxlength="254" autocomplete="username">' +
      '<label for="acct_rev_code">Code from the notice</label><input type="text" id="acct_rev_code" inputmode="numeric" maxlength="11" autocomplete="one-time-code">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_rev_go">Undo the change</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_rev_cancel">Cancel</button></div>';
    $('acct_rev_cancel').addEventListener('click', function () { closeDialog(true); });
    $('acct_rev_go').addEventListener('click', function () {
      var em = String($('acct_rev_email').value || '').trim(); var code = String($('acct_rev_code').value || '').replace(/\s/g, '');
      if (!EMAIL_RE.test(em) || !/^\d{8}$/.test(code)) { message('Enter the previous address and the 8-digit code.', 'err'); return; }
      revertEmail(em, code).then(function (r) {
        message('Done: your previous address is back and ' + r.sessions + ' session' + (r.sessions === 1 ? ' was' : 's were') + ' signed out.', 'ok');
      }, function (e) { message(errText(e), 'err'); });
    });
    focusFirst('acct_rev_email');
  }
  function revertEmail(email, code) {
    return call('POST', '/auth/email/revert', { email: email, code: code }).then(function (r) {
      lsSet(KEYS.hint, JSON.stringify({ signedIn: true, initial: String(email)[0].toUpperCase(), public: false, lastSeenAt: now(), v: 3 }));
      return refresh().then(function () { return r.json; });
    });
  }
  function drawEmail(b, data) {
    setTitle('Sign in to Well Testing Suite');
    b.innerHTML =
      '<p>Use your e-mail address: we send you an 8-digit code. There is no password. Without signing in, your work stays on this device only.</p>' +
      (data.note ? '<p class="acct-note">' + esc(data.note) + '</p>' : '') +
      '<label for="acct_email">E-mail address</label>' +
      '<input type="email" id="acct_email" inputmode="email" autocomplete="username webauthn" maxlength="254" spellcheck="false" value="' + esc(dlg.email) + '">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_send">Send code</button></div>' +
      '<div class="acct-or acct-or--none" id="acct_or">or</div>' +
      '<div id="acct_provider_buttons" class="acct-providers" data-owner="WP-O"></div>' +
      '<label class="acct-tick"><input type="checkbox" id="acct_public"' + (dlg.publicDevice ? ' checked' : '') + '> This is a public or shared computer</label>' +
      '<p class="acct-note">On a public computer you are signed out after 12 hours and this browser keeps nothing of your work.</p>';
    $('acct_send').addEventListener('click', sendCode);
    $('acct_email').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') sendCode(); });
    $('acct_public').addEventListener('change', function () { dlg.publicDevice = !!$('acct_public').checked; drawProviders(); });
    drawProviders();
    focusFirst('acct_email');
  }
  // WP-O mount: provider buttons are drawn by hooks.renderProviders after GET /auth/providers (only when WP-O is present).
  function drawProviders() {
    var el = $('acct_provider_buttons');
    if (!el || typeof hooks.renderProviders !== 'function') return;
    var pubNow = dlg.publicDevice;
    providers().then(function (prov) {
      var el2 = $('acct_provider_buttons');
      if (!el2 || dlg.step !== 'email') return;
      el2.innerHTML = '';
      try { hooks.renderProviders(el2, prov, { publicDevice: pubNow, sharedBrowser: lsGet(KEYS.shared) === '1' }); } catch (e) { /* WP-O */ }
      var or = $('acct_or'); if (or) or.className = 'acct-or' + (el2.firstChild ? '' : ' acct-or--none');
    }, function () { /* the code path is unchanged */ });
  }
  function sendCode() {
    var inp = $('acct_email');
    var email = String(inp ? inp.value : dlg.email).trim();
    if (!EMAIL_RE.test(email) || email.length > 254) { message('Please enter one e-mail address.', 'err'); return Promise.resolve(false); }
    dlg.email = email;
    var pub = $('acct_public'); if (pub) dlg.publicDevice = !!pub.checked;
    var btn = $('acct_send'); if (btn) btn.disabled = true;
    message('Sending…');
    return call('POST', '/auth/code/start', { email: email, purpose: 'signin' }).then(function () {
      setStep('code', { email: email });
      return true;
    }, function (e) {
      if (btn) btn.disabled = false;
      message(errText(e), 'err');
      return false;
    });
  }
  function codeFaq(stepup) {
    return '<details class="acct-faq" id="acct_faq"><summary>Didn\'t get the code?</summary><ul>' +
      '<li>Look in your spam or quarantine folder; some company mail filters hold new senders for a few minutes.</li>' +
      '<li>Ask your IT team to allow mail from no-reply@h2oil.co.uk.</li>' +
      '<li>Codes last 15 minutes. After "Send again" the previous code still works, so use whichever arrives first.</li>' +
      (stepup ? '<li><button type="button" class="btn btn-secondary" id="acct_stepup_recovery">Send the code to my recovery address</button></li>'
        : '<li>If you added a recovery address to your account, you can type it instead: the code goes there. <button type="button" class="btn btn-secondary" id="acct_use_recovery">Send the code to my recovery address</button></li>') +
      '<li>Still nothing? Write to ' + SUPPORT + '.</li></ul></details>';
  }
  function drawCode(b, data) {
    setTitle('Enter your code');
    b.innerHTML =
      '<p>We sent an 8-digit code to <b>' + esc(dlg.email) + '</b>. It expires in 15 minutes. Only enter it here, at welltest.h2oil.co.uk.</p>' +
      '<label for="acct_code">Code</label>' +
      '<input type="text" id="acct_code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" spellcheck="false">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_verify">Sign in</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_resend">Send again</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_back">Use another address</button></div>' + codeFaq(false);
    $('acct_verify').addEventListener('click', function () { verifyCode(); });
    $('acct_code').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') verifyCode(); });
    $('acct_resend').addEventListener('click', function () {
      $('acct_resend').disabled = true;
      call('POST', '/auth/code/start', { email: dlg.email, purpose: 'signin' }).then(function () {
        message('A new code is on its way. The previous one still works.', 'ok');
        var r = $('acct_resend'); if (r) r.disabled = false;   // enabled again from the server's reply (no countdown timer)
      }, function (e) { var r = $('acct_resend'); if (r) r.disabled = false; message(errText(e), 'err'); });
    });
    $('acct_back').addEventListener('click', function () { setStep('email'); });
    $('acct_use_recovery').addEventListener('click', function () { dlg.email = ''; setStep('email', { note: 'Type your recovery address. The code is sent there and signs you in to the same account.' }); });
    focusFirst('acct_code');
  }
  function verifyCode(consent) {
    var inp = $('acct_code');
    var code = inp ? String(inp.value || '').replace(/\s/g, '') : (dlg.code || '');
    if (!/^\d{8}$/.test(code)) { message('The code has 8 digits.', 'err'); return Promise.resolve(false); }
    dlg.code = code;
    var req = { email: dlg.email, code: code, publicDevice: !!dlg.publicDevice, deviceLabel: deviceLabel() };
    if (consent) req.consent = consent;
    var btn = $('acct_verify') || $('acct_create'); if (btn) btn.disabled = true;
    return call('POST', '/auth/code/verify', req).then(function (r) {
      dlg.code = null;
      return completeSignIn(r.json, { method: 'code' }).then(function () { return true; });
    }, function (e) {
      if (btn) btn.disabled = false;
      if (e && e.code === 'consent_required') { setStep('consent', { terms: e.body && e.body.terms, privacy: e.body && e.body.privacy }); return false; }
      message(errText(e), 'err');
      return false;
    });
  }
  function drawConsent(b, data) {
    setTitle('Create your account');
    dlg.consent = { terms: String(data.terms || ''), privacy: String(data.privacy || '') };
    b.innerHTML =
      '<p>You are creating a new account for <b>' + esc(dlg.email) + '</b>. Already have an account with another address? Cancel and sign in with it.</p>' +
      '<label class="acct-tick"><input type="checkbox" id="acct_consent_ok"> I accept the Terms of Use (version ' + esc(dlg.consent.terms) + ') and have read the Privacy notice (version ' + esc(dlg.consent.privacy) + ').</label>' +
      '<p class="acct-note">Your projects are stored encrypted in the UK / EU. You can export everything or delete your account at any time.</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_create">Create account</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_consent_cancel">Cancel</button></div>';
    $('acct_create').addEventListener('click', function () {
      if (!$('acct_consent_ok').checked) { message('Please tick the box to accept the Terms of Use and the Privacy notice.', 'err'); return; }
      verifyCode(dlg.consent);
    });
    $('acct_consent_cancel').addEventListener('click', function () { closeDialog(true); });
  }

  // openSignIn(opts) → Promise<state|null>: resolves with the state once signed in, null when the dialog is closed.
  function openSignIn(opts) {
    opts = opts || {};
    if (!HAS_DOC) return Promise.resolve(null);
    if (current.status === 'signedIn' && !opts.force) return Promise.resolve(state());
    return new Promise(function (resolve) {
      if (dlg.resolve) { var old = dlg.resolve; dlg.resolve = null; old(null); }
      openDialog('signin');
      dlg.resolve = resolve;
      if (opts.email) dlg.email = String(opts.email);
      if (!isOnline()) { setStep('email'); message(MSG.network, 'err'); return; }
      setStep('email');
    });
  }

  // ── step-up (§4.7) ─────────────────────────────────────────────────────────────────────────────────────────────────
  // stepUp() → Promise<boolean>: a code to the primary (or the recovery) address, entered in place; resolves true once
  // code/verify (bound to this session) succeeds — the server sets stepup_at and rotates the session.
  var stepping = null;
  function stepUp(opts) {
    if (stepping) return stepping;
    if (current.status !== 'signedIn') return Promise.reject(new AccountError('signed_out', 401, null));
    stepping = new Promise(function (resolve) {
      openDialog('stepup', { title: 'Confirm it is you' });
      dlg.choice = function (v) { resolve(!!v); };
      setStep('stepup', opts || {});
    }).then(function (v) { stepping = null; return v; }, function () { stepping = null; return false; });
    return stepping;
  }
  function drawStepUp(b, data) {
    setTitle('Confirm it is you');
    b.innerHTML =
      '<p>' + esc(data.reason || 'This action needs a fresh confirmation.') + ' We sent an 8-digit code to your account address' +
      (current.user && current.user.emailMasked ? ' <b>' + esc(current.user.emailMasked) + '</b>' : '') + '.</p>' +
      '<label for="acct_code">Code</label><input type="text" id="acct_code" inputmode="numeric" autocomplete="one-time-code" maxlength="11">' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_verify">Confirm</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_resend">Send again</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_stepup_cancel">Cancel</button></div>' + codeFaq(true);
    var to = data.to === 'recovery' ? 'recovery' : 'primary';
    function send(t) {
      return call('POST', '/auth/code/start', { purpose: 'stepup', to: t }).then(function () {
        message(t === 'recovery' ? 'A code is on its way to your recovery address.' : 'A code is on its way.', 'ok');
      }, function (e) { message(errText(e), 'err'); });
    }
    send(to);
    $('acct_resend').addEventListener('click', function () { send(to); });
    $('acct_stepup_recovery').addEventListener('click', function () { to = 'recovery'; send('recovery'); });
    $('acct_stepup_cancel').addEventListener('click', function () { closeDialog(true); });
    function confirm() {
      var code = String($('acct_code').value || '').replace(/\s/g, '');
      if (!/^\d{8}$/.test(code)) { message('The code has 8 digits.', 'err'); return; }
      $('acct_verify').disabled = true;
      call('POST', '/auth/code/verify', { code: code, publicDevice: !!current.publicDevice }).then(function () {
        var ch = dlg.choice; dlg.choice = null;
        closeDialog(false);
        if (ch) ch(true);
      }, function (e) {
        var v = $('acct_verify'); if (v) v.disabled = false;
        message(errText(e), 'err');
      });
    }
    $('acct_verify').addEventListener('click', confirm);
    $('acct_code').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') confirm(); });
    focusFirst('acct_code');
  }
  // withStepUp(fn): runs fn(); on 403 reauth runs the step-up in place and repeats fn() once.
  function withStepUp(fn, reason) {
    return Promise.resolve().then(fn).then(null, function (e) {
      if (!e || e.code !== 'reauth') return handleError(e);
      return stepUp({ reason: reason }).then(function (ok) {
        if (!ok) throw new AccountError('cancelled', 0, null);
        return fn();
      });
    });
  }

  // ── choose(): a generic choice step in the dialog (hand-over, conflict, wipe guard, open-file) ──────────────────────────
  // choose({title, text, html, list:[text], buttons:[{id, label, primary}]}) → Promise<id|null> (null = closed)
  function choose(o) {
    o = o || {};
    if (!HAS_DOC) return Promise.resolve(null);
    return new Promise(function (resolve) {
      openDialog(dlg.mode || 'choice');
      if (dlg.choice) { var prev = dlg.choice; dlg.choice = null; prev(null); }
      dlg.step = 'choice';
      setTitle(o.title || 'Cloud projects');
      var b = body();
      var html = (o.text ? '<p>' + esc(o.text) + '</p>' : '') + (o.html || '') +
        (o.list && o.list.length ? '<ul class="acct-list" id="acct_choice_list">' + o.list.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="acct-btns">' + (o.buttons || []).map(function (bt) {
          return '<button type="button" class="btn ' + (bt.primary ? 'btn-primary' : 'btn-secondary') + '" id="acct_ch_' + esc(bt.id) + '" data-choice="' + esc(bt.id) + '">' + esc(bt.label) + '</button>';
        }).join('') + '</div>';
      b.innerHTML = html;
      message(o.message || '');
      dlg.choice = resolve;
      (o.buttons || []).forEach(function (bt) {
        var el = $('acct_ch_' + bt.id);
        if (el) el.addEventListener('click', function () {
          var ch = dlg.choice; dlg.choice = null;
          if (!o.keepOpen) closeDialog(false);
          if (ch) ch(bt.id);
        });
      });
      var first = (o.buttons || []).filter(function (x) { return x.primary; })[0] || (o.buttons || [])[0];
      if (first) focusFirst('acct_ch_' + first.id);
    });
  }

  // ── sign-out (§10.8) ───────────────────────────────────────────────────────────────────────────────────────────────
  // signOut({everywhere, clearLocal, keep}) — trusted device: "Keep a copy of the open project in this browser?" (default
  // Keep); public device: the guarded wipe in 67 (blocked while changes wait). everywhere: step-up, POST signout-all.
  function signOut(o) {
    o = o || {};
    if (current.status !== 'signedIn' && !(current.status === 'unavailable' && readHint())) return signedOutLocal('signout').then(state);
    var S = sync();
    var pub = !!current.publicDevice || !!(readHint() || {}).public;
    var user = current.user;
    var guard = Promise.resolve('proceed');
    if (pub && S && typeof S.publicSignOutGuard === 'function') guard = S.publicSignOutGuard(user);
    return guard.then(function (g) {
      if (g === 'cancel') return state();
      var server = o.everywhere
        ? withStepUp(function () { return call('POST', '/auth/signout-all', o.alsoRecentMethodsDays ? { alsoRecentMethodsDays: o.alsoRecentMethodsDays } : {}); }, 'Signing out everywhere needs a fresh confirmation.')
        : call('POST', '/auth/signout', {});
      return server.then(null, function (e) {
        if (e && e.code === 'cancelled') throw e;
        return null;   // signed out locally whatever the server answers (an outage must not keep a shared PC signed in)
      }).then(function () {
        if (pub) {
          var p = S && S.wipeDevice ? S.wipeDevice({ reason: 'signout', historian: o.historian !== false }) : Promise.resolve();
          return p.then(function () {
            writeHint(null);
            setState({ status: 'signedOut', user: null, publicDevice: false, me: null, opts: null, authMethod: null, reason: 'signout' });
            if (typeof hooks.onPublicSignOut === 'function') { try { return Promise.resolve(hooks.onPublicSignOut({ authMethod: current.authMethod })).then(state); } catch (e) { /* WP-O */ } }
            return state();
          });
        }
        var keepQ = (o.keep !== undefined || o.clearLocal !== undefined) ? Promise.resolve(o.clearLocal ? 'remove' : (o.keep === false ? 'remove' : 'keep'))
          : choose({ title: 'Sign out', text: 'Keep a copy of the open project in this browser?', buttons: [{ id: 'keep', label: 'Keep', primary: true }, { id: 'remove', label: 'Remove it from this browser' }] });
        return keepQ.then(function (k) {
          var p = Promise.resolve();
          if (S && typeof S._noteSignedOut === 'function') p = p.then(function () { return S._noteSignedOut(user); });
          if (k === 'remove' && S && S.wipeDevice) p = p.then(function () { return S.wipeDevice({ reason: 'signout', historian: false, keepLocked: true }); });
          return p.then(function () {
            writeHint(null);
            setState({ status: 'signedOut', user: null, publicDevice: false, me: null, opts: null, authMethod: null, reason: 'signout' });
            return state();
          });
        });
      });
    }).then(null, function (e) { if (e && e.code === 'cancelled') return state(); throw e; });
  }

  function changeEmail(newEmail) {
    return withStepUp(function () { return call('POST', '/auth/email/change', { newEmail: String(newEmail || '') }); }, 'Changing your e-mail address needs a fresh confirmation.')
      .then(function () { return true; });
  }
  function confirmEmail(code) {
    return call('POST', '/auth/email/confirm', { code: String(code || '') }).then(function (r) { return refresh().then(function () { return r.json; }); }, handleError);
  }
  function setRecovery(email) {
    return withStepUp(function () { return call('POST', '/auth/recovery/set', { email: String(email || '') }); }, 'Adding a recovery address needs a fresh confirmation.').then(function () { return true; });
  }
  function confirmRecovery(code) {
    return withStepUp(function () { return call('POST', '/auth/recovery/set', { code: String(code || '') }); }).then(function () { return refresh(); });
  }
  function removeRecovery() {
    return withStepUp(function () { return call('POST', '/auth/recovery/remove', {}); }, 'Removing the recovery address needs a fresh confirmation.').then(function () { return refresh(); });
  }

  // ── header chip (§11.1) ────────────────────────────────────────────────────────────────────────────────────────────
  var mounted = false;
  function chipInfo() {
    var S = sync();
    var st = S && typeof S.status === 'function' ? S.status() : { state: 'off' };
    if (current.status === 'unavailable') {
      if (current.reason === 'paused') return { cls: 'off', text: 'Cloud sync paused', title: 'Cloud sync paused — your work is saved on this device' };
      if (current.reason === 'upgrade') return { cls: 'off', text: 'Reload to update', title: 'Reload the page to keep using the cloud' };
      if (current.reason === 'locked') return { cls: 'bad', text: 'Account locked', title: 'Contact ' + SUPPORT };
      return { cls: 'off', text: 'Cloud unavailable — saved on this device', title: lastSyncTitle(st) };
    }
    if (current.reason === 'outage' || st.state === 'unavailable') return { cls: 'off', text: 'Cloud unavailable — saved on this device', title: lastSyncTitle(st) };
    if (!isOnline() || st.state === 'offline') return { cls: 'off', text: 'Offline — saved on this device', title: lastSyncTitle(st) };
    switch (st.state) {
      case 'syncing': return { cls: 'spin', text: '⟳ Syncing', title: 'Saving to the cloud' };
      case 'idle': return { cls: 'ok', text: '● Synced ' + hhmm(st.lastSyncAt), title: 'Saved to the cloud' + (st.name ? ' as ' + st.name : '') };
      case 'dirty': return { cls: 'warn', text: '○ Not saved to cloud', title: 'Changed since the last cloud save' };
      case 'conflict': return { cls: 'bad', text: '⚠ Newer version in the cloud', title: 'The cloud copy changed on another device' };
      case 'quota': return { cls: 'bad', text: '⚠ Storage full', title: 'Your cloud storage is full; nothing is lost on this device' };
      case 'paused': return { cls: 'off', text: 'Cloud sync paused', title: 'Your work is saved on this device' };
      case 'readonly': return { cls: 'off', text: 'Cloud read-only', title: 'Cloud saves are paused; opening still works' };
      default: return { cls: 'hollow', text: 'Not in cloud', title: 'This device\'s project isn\'t in the cloud' };
    }
  }
  function lastSyncTitle(st) { return 'Your work is saved on this device' + (st && st.lastSyncAt ? '. Last cloud save ' + hhmm(st.lastSyncAt) : ''); }
  function ensureHost() {
    if (!HAS_DOC) return null;
    var host = $('wts_account_host');
    if (host) return host;
    var pa = document.querySelector ? document.querySelector('.page-actions') : null;
    if (!pa) return null;
    host = document.createElement('div'); host.id = 'wts_account_host'; host.setAttribute('data-acct-created', '1');
    pa.insertBefore(host, pa.firstChild);
    return host;
  }
  function renderChip() {
    if (!mounted || !HAS_DOC) return;
    var host = ensureHost(); if (!host) return;
    var closeMenu = $('acct_menu'); if (closeMenu && closeMenu.parentNode) closeMenu.parentNode.removeChild(closeMenu);
    if (current.status === 'signedOut' || current.status === 'signingIn') {
      host.innerHTML = '<span class="acct-wrap"><button type="button" class="acct-chip" id="acct_chip" aria-label="Sign in" title="Sign in to save projects in the cloud">' +
        '<span aria-hidden="true">&#9729;</span><span class="acct-txt">Sign in</span></button></span>';
      $('acct_chip').addEventListener('click', function () { openSignIn(); });
      return;
    }
    var info = chipInfo();
    var h = readHint() || {};
    var initial = esc((current.user && current.user.emailMasked ? current.user.emailMasked[0] : h.initial || '?').toUpperCase());
    host.innerHTML = '<span class="acct-wrap"><button type="button" class="acct-chip" id="acct_chip" aria-haspopup="menu" aria-expanded="false" title="' + esc(info.title) + '">' +
      '<span class="acct-init" aria-hidden="true">' + initial + '</span><span class="acct-dot acct-dot--' + info.cls + '" aria-hidden="true"></span>' +
      '<span class="acct-txt" id="acct_chip_txt" aria-live="polite">' + esc(info.text) + '</span></button></span>';
    var chip = $('acct_chip');
    chip.setAttribute('aria-label', 'Account: ' + info.text);
    chip.addEventListener('click', toggleMenu);
  }
  function toggleMenu() {
    var m = $('acct_menu');
    if (m) { m.parentNode.removeChild(m); $('acct_chip').setAttribute('aria-expanded', 'false'); return; }
    var wrap = $('acct_chip').parentNode;
    var via = current.authMethod === 'google' ? ' via Google' : current.authMethod === 'linkedin' ? ' via LinkedIn' : '';
    var S = sync();
    var items = [
      { id: 'acct_m_save', label: 'Save to cloud', run: function () { cloudAction('save'); }, when: current.status === 'signedIn' },
      { id: 'acct_m_open', label: 'Open from cloud…', run: function () { cloudAction('open'); }, when: current.status === 'signedIn' },
      { id: 'acct_m_page', label: 'Account & projects', run: openAccountPage, when: true },
      { id: 'acct_m_retry', label: 'Try again', run: function () { refresh(); }, when: current.status === 'unavailable' },
      { id: 'acct_m_signout', label: 'Sign out', run: function () { signOut(); }, when: true },
      { id: 'acct_m_everywhere', label: 'Sign out everywhere…', run: function () { signOutEverywhereAsk(); }, when: current.status === 'signedIn' },
    ].filter(function (x) { return x.when; });
    m = document.createElement('div');
    m.id = 'acct_menu'; m.className = 'acct-menu rp-skip'; m.setAttribute('role', 'menu'); m.setAttribute('data-rp-nosnap', '1');
    m.innerHTML = '<div class="acct-menu-who" id="acct_menu_who">' + esc((current.user && current.user.emailMasked) || 'Signed in') + esc(via) +
      (S && S.status && S.status().name ? '<br>Project: ' + esc(S.status().name) : '') + '</div>' +
      items.map(function (it) { return '<button type="button" role="menuitem" id="' + it.id + '">' + esc(it.label) + '</button>'; }).join('');
    wrap.appendChild(m);
    $('acct_chip').setAttribute('aria-expanded', 'true');
    items.forEach(function (it) {
      $(it.id).addEventListener('click', function () {
        var mm = $('acct_menu'); if (mm && mm.parentNode) mm.parentNode.removeChild(mm);
        var c = $('acct_chip'); if (c) c.setAttribute('aria-expanded', 'false');
        it.run();
      });
    });
    var f = $(items[0].id); try { if (f && f.focus) f.focus(); } catch (e) { /* none */ }
  }
  function signOutEverywhereAsk() {
    return choose({ title: 'Sign out everywhere', text: 'Sign out of every browser and device that uses your account? This one is signed out too.',
      html: '<label class="acct-tick"><input type="checkbox" id="acct_recent_methods"> Also remove passkeys and Google / LinkedIn links added in the last 14 days</label>',
      buttons: [{ id: 'all', label: 'Sign out everywhere', primary: true }, { id: 'cancel', label: 'Cancel' }], keepOpen: true })
      .then(function (c) {
        var tick = $('acct_recent_methods'); var recent = !!(tick && tick.checked);
        closeDialog(false);
        if (c !== 'all') return state();
        return signOut({ everywhere: true, alsoRecentMethodsDays: recent ? 14 : 0, keep: true });
      });
  }
  function openAccountPage() {
    var P = G.WTS_accountPage;
    if (P && typeof P.open === 'function') return P.open();
    if (typeof G.WTS_nav === 'function' && G.WTS_calcRegistry && G.WTS_calcRegistry.account) return G.WTS_nav('account');
    return null;
  }

  // ── cloud actions: the chip menu, the project toolbar button (H5) and Ctrl+S ────────────────────────────────────────
  function toast(text, kind) {
    if (!HAS_DOC) return;
    var t = $('acct_toast');
    if (!t) {
      ensureCss();
      t = document.createElement('div'); t.id = 'acct_toast'; t.className = 'acct-toast rp-skip'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
      t.setAttribute('data-rp-nosnap', '1');
      t.style.cssText = 'position:fixed;right:16px;top:16px;z-index:10055;background:var(--bg3,#222);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:8px;padding:8px 12px;font-size:13px;max-width:calc(100vw - 32px);box-sizing:border-box';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.setAttribute('data-kind', kind || '');
  }
  function cloudAction(what, arg) {
    var S = sync();
    if (!S) return Promise.resolve(null);
    if (current.status !== 'signedIn') return openSignIn();
    var p;
    if (what === 'save') p = S.saveToCloud({});
    else if (what === 'saveas') p = S.saveToCloud({ as: true });
    else if (what === 'open') p = S.openPicker ? S.openPicker() : Promise.resolve(null);
    else if (what === 'import') p = S.pickAndImport ? S.pickAndImport() : Promise.resolve(null);
    else p = Promise.resolve(null);
    return p.then(function (r) {
      if (r && r.rev != null && !r.cancelled) toast(r.unchanged ? 'Already saved to the cloud.' : 'Saved to the cloud (version ' + r.rev + ').', 'ok');
      renderChip();
      return r;
    }, function (e) {
      renderChip();
      if (e && e.code === 'cancelled') return null;
      toast(cloudErrText(e), 'err');
      return null;
    });
  }
  function cloudErrText(e) {
    if (!e) return 'Cloud save failed. Your work is saved on this device.';
    if (isOutage(e)) return 'Cloud unavailable — your work is saved on this device.';
    if (e.code === 'quota') return 'Your cloud storage is full. Nothing is lost on this device.';
    if (e.code === 'too_large') return 'This project is too large for the cloud. Nothing is lost on this device.';
    if (e.code === 'readonly') return 'Cloud saves are paused right now (read-only). Your work is saved on this device.';
    if (e.code === 'paused') return 'Cloud sync is paused. Your work is saved on this device.';
    if (e.code === 'rate') return 'Too many cloud saves. Try again in ' + Math.max(1, Math.round(e.retryAfter || 30)) + ' s.';
    if (e.code === 'offline_dirty') return 'You are offline: save this project to a file first, or wait for the connection.';
    if (e.code === 'signed_out') return 'Signed out — sign in to keep using the cloud. Nothing is lost on this device.';
    if (e.code === 'not_found' || e.code === 'gone') return 'That cloud project is no longer available.';
    return 'Cloud action failed (' + String(e.code || 'error') + '). Your work is saved on this device.';
  }
  function openCloudMenu(ev) {
    if (!HAS_DOC) return;
    var old = $('acct_cloud_menu'); if (old) { old.parentNode.removeChild(old); return; }
    ensureCss();
    var anchor = (ev && ev.currentTarget) || (document.querySelector && document.querySelector('[data-item="acct_tb_cloud"]')) || null;
    var m = document.createElement('div');
    m.id = 'acct_cloud_menu'; m.className = 'acct-cloud-menu rp-skip'; m.setAttribute('role', 'menu'); m.setAttribute('data-rp-nosnap', '1');
    var items = [['acct_c_save', 'Save to cloud', 'save'], ['acct_c_saveas', 'Save to cloud as…', 'saveas'], ['acct_c_open', 'Open from cloud…', 'open'], ['acct_c_import', 'Import files to cloud…', 'import']];
    m.innerHTML = items.map(function (it) { return '<button type="button" role="menuitem" id="' + it[0] + '">' + esc(it[1]) + '</button>'; }).join('');
    var parent = anchor && anchor.parentNode ? anchor.parentNode : document.body;
    if (parent.style && !parent.style.position) parent.style.position = 'relative';
    parent.appendChild(m);
    items.forEach(function (it) {
      $(it[0]).addEventListener('click', function () { var mm = $('acct_cloud_menu'); if (mm) mm.parentNode.removeChild(mm); cloudAction(it[2]); });
    });
  }
  var toolbarRegistered = false;
  function registerToolbar() {
    var P = G.WTS_project;
    if (toolbarRegistered || !P || typeof P.registerToolbarItems !== 'function') return false;
    P.registerToolbarItems([{ id: 'acct_tb_cloud', label: '☁ ▾', title: 'Cloud projects: save, open, import', run: openCloudMenu,
      when: function () { return current.status === 'signedIn'; } }]);
    toolbarRegistered = true;
    return true;
  }
  function refreshToolbar() {
    var P = G.WTS_project;
    if (toolbarRegistered && P && typeof P.refreshToolbarItems === 'function') { try { P.refreshToolbarItems(); } catch (e) { /* host */ } }
  }
  // Ctrl+S / Cmd+S saves to the cloud while signed in and linked (§11.1, D14); attached only while signed in.
  function onKeyS(ev) {
    if (!ev || !(ev.ctrlKey || ev.metaKey) || ev.altKey || String(ev.key || '').toLowerCase() !== 's') return;
    var S = sync();
    if (current.status !== 'signedIn' || !S || !S.status().projectId) return;
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    cloudAction('save');
  }
  var attached = false;
  function attachSignedIn() {
    if (attached || !HAS_DOC) return;
    attached = true;
    document.addEventListener('keydown', onKeyS, true);
    var S = sync(); if (S && typeof S._attach === 'function') S._attach();
  }
  function detachSignedIn() {
    if (!attached || !HAS_DOC) return;
    attached = false;
    document.removeEventListener('keydown', onKeyS, true);
    var S = sync(); if (S && typeof S._detach === 'function') S._detach();
  }

  // ── status bar (§11.4) ─────────────────────────────────────────────────────────────────────────────────────────────
  var barDismissed = {};
  function renderBar() {
    if (!mounted || !HAS_DOC) return;
    var S = sync();
    var st = S && S.status ? S.status() : { pending: 0 };
    var kind = null, text = '', btns = [];
    if (current.status === 'signedOut' && current.reason === 'expired') {
      kind = 'signedout';
      text = 'Signed out — sign in to keep syncing.' + (st.pending ? ' ' + st.pending + ' change' + (st.pending === 1 ? '' : 's') + ' waiting.' : '');
      btns = [['acct_bar_signin', 'Sign in', function () { openSignIn(); }]];
    } else if (current.status === 'unavailable' && current.reason === 'paused') {
      kind = 'paused'; text = 'Cloud sync paused — your work is saved on this device.';
    } else if (current.status === 'unavailable' && current.reason === 'outage') {
      kind = 'unavailable'; text = 'Cloud unavailable — your work is saved on this device.' + (st.lastSyncAt ? ' Last cloud save ' + hhmm(st.lastSyncAt) + '.' : '');
      btns = [['acct_bar_retry', 'Try again', function () { refresh(); }]];
    } else if (current.status === 'signedIn' && current.user && current.user.status === 'deleting') {
      kind = 'deleting'; text = 'Your account is being deleted' + (current.user.deleteAt ? ' on ' + String(current.user.deleteAt).slice(0, 10) : '') + '.';
      btns = [['acct_bar_cancel_del', 'Cancel deletion', function () { cancelDeletion(); }]];
    } else if (current.status === 'signedIn' && st.state === 'quota') {
      kind = 'quota'; text = 'Your cloud storage is full. Nothing is lost on this device.';
    }
    var bar = $('wts_sync_bar');
    if (!kind || barDismissed[kind]) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
    ensureCss();
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'wts_sync_bar'; bar.setAttribute('role', 'status');
      bar.className = 'acct-sync-bar rp-skip'; bar.setAttribute('data-rp-nosnap', '1');
      document.body.appendChild(bar);
    }
    bar.setAttribute('data-kind', kind);
    bar.innerHTML = '<div class="acct-bar-in"><span id="wts_sync_bar_text">' + esc(text) + '</span>' +
      btns.map(function (b) { return '<button type="button" class="btn btn-primary" id="' + b[0] + '" style="padding:5px 12px">' + esc(b[1]) + '</button>'; }).join('') +
      '<button type="button" class="btn btn-secondary" id="acct_bar_x" aria-label="Dismiss" style="padding:5px 9px">&#215;</button></div>';
    btns.forEach(function (b) { $(b[0]).addEventListener('click', b[2]); });
    $('acct_bar_x').addEventListener('click', function () { barDismissed[kind] = true; renderBar(); });
  }
  function cancelDeletion() {
    return call('POST', '/account/delete/cancel', {}).then(function () { return refresh(); }, handleError);
  }

  // ── mount (§5.5) ───────────────────────────────────────────────────────────────────────────────────────────────────
  function mount() {
    if (mounted || !HAS_DOC) return;
    if (!betaEnabled()) return;
    mounted = true;
    ensureCss();
    ensureHost();
    var h = readHint();
    if (h && h.signedIn) current.status = 'signedIn';   // paint from the hint; /me decides
    renderChip();
    registerToolbar();
    var S = sync(); if (S && typeof S._mount === 'function') S._mount();
    if (h && h.signedIn) refresh().then(null, function () { /* outage handled */ });
    else current.status = 'signedOut';
    // a provider return (#acct-oauth) with a fresh hint entry → WP-O's finish; without the hint entry it is ignored
    if (String(L.hash || '') === '#acct-oauth') {
      try { if (G.history && G.history.replaceState) G.history.replaceState(null, '', String(L.pathname || '') + String(L.search || '')); } catch (e) { /* none */ }
      if (h && h.oauth && typeof h.oauth.at === 'number' && now() - h.oauth.at < 10 * 60 * 1000) {
        openDialog('signin'); setStep('busy', { text: 'Finishing sign-in…' });
        Promise.resolve().then(function () { return api.finishProviderSignIn(); }).then(null, function (e) { message(errText(e), 'err'); });
      }
    }
  }
  function openRevert() { openDialog('revert', { title: 'Undo an e-mail change' }); setStep('revert'); }
  function boot() {
    if (!HAS_DOC) return;
    if (String(L.hash || '') === '#account-revert') {   // a user action (the notice's link); no request until submitted
      var go = function () { ensureCss(); openRevert(); };
      if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', go, { once: true });
      else if (typeof G.setTimeout === 'function') G.setTimeout(go, 0);
    }
    if (!betaEnabled()) return;
    if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', mount, { once: true });
    else if (typeof G.setTimeout === 'function') G.setTimeout(mount, 0);
  }

  function notYet(name) {
    return function () { return Promise.reject(new AccountError('not_implemented', 0, { error: 'not_implemented', message: name + ' is built in WP-O / Phase 3' })); };
  }
  var api = {
    eligible: true, VERSION: VERSION, PROVIDERS: PROVIDERS.slice(), Error: AccountError, KEYS: KEYS, hooks: hooks,
    configure: configure, seam: seam, state: state, call: call, providers: providers, on: on, off: off, betaEnabled: betaEnabled,
    refresh: refresh, openSignIn: openSignIn, signOut: signOut, stepUp: stepUp, withStepUp: withStepUp,
    changeEmail: changeEmail, confirmEmail: confirmEmail, setRecovery: setRecovery, confirmRecovery: confirmRecovery, removeRecovery: removeRecovery,
    cancelDeletion: cancelDeletion, revertEmail: revertEmail, openRevert: openRevert, mount: mount,
    addPasskey: notYet('addPasskey'), removePasskey: notYet('removePasskey'), renamePasskey: notYet('renamePasskey'),
    // WP-O replaces these five (provider sign-in and the Sign-in methods card)
    signInWith: notYet('signInWith'), finishProviderSignIn: notYet('finishProviderSignIn'), methods: notYet('methods'),
    linkProvider: notYet('linkProvider'), unlinkMethod: notYet('unlinkMethod'),
    // shared internals for 67 / 68 and WP-O (not a public contract)
    _i: { completeSignIn: completeSignIn, choose: choose, setStep: setStep, message: message, openDialog: openDialog, closeDialog: closeDialog,
      readHint: readHint, writeHint: writeHint, handleError: handleError, errText: errText, cloudErrText: cloudErrText, esc: esc, toast: toast,
      signedOutLocal: signedOutLocal, renderChip: renderChip, renderBar: renderBar, cloudAction: cloudAction, isOnline: isOnline, now: now,
      deviceLabel: deviceLabel, isOutage: isOutage, ensureCss: ensureCss, dialogOpen: function () { return dlg.open; } },
  };
  G.WTS_account = api;
  boot();
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  // pure checks only (stripped by concat): the guard leaves an ineligible stub in a plain node context
  var G = (typeof window !== 'undefined') ? window : globalThis;
  if (G.WTS_account && G.WTS_account.eligible === false && Object.keys(G.WTS_account).length !== 1) throw new Error('66 self-test: ineligible stub');
})();
