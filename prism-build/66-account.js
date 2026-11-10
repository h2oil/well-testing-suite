// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/66-account.js — WTS_account: web accounts (docs/ACCOUNTS-PLAN.md §3.2, §4, §5, §10, §11). Round-10, auto-discovered.
//
// It loads everywhere and does nothing unless the page is the production web host over https (or DEV on localhost with
// window.WTS_ACCOUNT_DEV === 1), outside the iOS native shell and not framed (§5.1 guard). On such a host accounts are ON by
// default (from release 4.2; v4.0 showed them only with the invite-beta flag ?cloud=1): the kill switch ?cloud=0 stores the device opt-out
// wtspref_cloud_off = '1' (nothing is mounted, registered or requested, as before v4.0) and ?cloud=1 clears it again.
// GET /me runs only when the device hint says a session exists. A signed-out first visit opens the sign-in dialog itself in
// its welcome form (first-open, §11.2): that dialog asks GET /auth/providers for its Google / LinkedIn buttons, so since
// release 4.2 a signed-out first visitor sends that one request when the dialog opens (after the cookie banner and the Terms
// notice; it carries no cookie and no personal data, and none is sent with ?cloud=0); "Use as
// guest", Esc, × or a click on the backdrop store the guest choice (device pref, offered again after 30 days).
//
// WP-C1 (this file): the guard, configure() seams, the one API client call() (headers, error envelope → WTS_account.Error,
// the §3.2 outage rule: only code 'signed_out' signs the page out), the session state machine and the device hint, the
// sign-in dialog (e-mail code first, "Didn't get the code?", consent for a new account, public-computer tick), step-up in
// place (code to the primary or the recovery address), sign-out / sign out everywhere, the header chip and its menu, the
// project-toolbar cloud button (H5), Ctrl+S while linked, the bottom status bar #wts_sync_bar, and the one reload after a
// sign-in on a page where the analytics tag ran (H17, D20).
//
// WP-O MOUNT POINTS (provider sign-in, the block near the end of this file): the e-mail step draws an empty
// <div id="acct_provider_buttons" data-owner="WP-O"> and calls WTS_account.hooks.renderProviders(el, providers, ctx)
// (GET /auth/providers runs only then — on a signed-out first visit that is when the first-open dialog opens); a public sign-out awaits hooks.onPublicSignOut({authMethod}) (the blocking provider
// sign-out step); the provider finish completes a sign-in through completeSignIn, so the hand-over, consent and analytics
// steps are shared. A load with #acct-oauth and a fresh hint.oauth entry opens the finish dialog (WTS_account.oauthReturn);
// without the hint entry it is ignored. The account page's Sign-in methods card is mounted by 68 the same way
// (WTS_accountPage.hooks.renderMethods → WTS_account.oauthUI.renderMethods).
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
  // welcome: the device preference of the first-open sign-in dialog, {choice: 'guest'|'signup'|'signin', at} — a wtspref_ key,
  // so it is never synced and never in project files (29 PREF / 67 skip wtspref_*)
  // beta: the v4.0 invite-beta flag (no longer read; kept so an old value is recognised); off: the device opt-out (?cloud=0)
  var KEYS = { hint: 'wtsacct_hint', beta: 'wtspref_cloud_beta', off: 'wtspref_cloud_off', cloudOpen: 'wtspref_cloud_open', shared: 'wtspref_shared_browser',
    welcome: 'wtspref_acct_welcome' };
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
    appVer: '', deviceId: null, reload: null, assign: null, online: null, maxProjectBytes: 64 * 1000 * 1000,
    // welcome: false switches the first-open sign-in dialog off. The mount can run before a configure() call, so a page (the
    // client tests' harness) can also switch it off before load with window.WTS_ACCOUNT_WELCOME = 0
    welcome: G.WTS_ACCOUNT_WELCOME !== 0 };
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

  // GET /auth/providers when the sign-in dialog or the Sign-in methods card opens (since 4.2 also when the first-open dialog
  // opens on a signed-out first visit). On a network error, or a reply that is not the API's ('server': no envelope, not
  // JSON), no server answers, so both are off: the welcome form and the chip's sign-in form show the e-mail code only (a
  // provider button could not start anyway — start is a call to the same API; review fix 4.2, it used to show both).
  function providers() {
    return call('GET', '/auth/providers').then(function (r) {
      var o = {};
      PROVIDERS.forEach(function (p) { var v = r.json && r.json[p]; o[p] = (v === 'on' || v === 'signin') ? v : 'off'; });
      return o;
    }, function (e) {
      if (e && (e.code === 'network' || e.code === 'server')) return { google: 'off', linkedin: 'off' };
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
    var os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Computer';
    // a neutral label (no browser product names, §3.3 lets the server derive the family for its mails)
    var phone = /Mobi|Android|iPhone|iPad/.test(ua);
    try { if (!phone && G.matchMedia && G.matchMedia('(pointer: coarse)').matches) phone = true; } catch (e) { /* none */ }
    return (os + (phone ? ' phone browser' : ' desktop browser')).replace(/[^A-Za-z0-9 _.()-]/g, '').slice(0, 40);
  }
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
  function sync() { return G.WTS_cloudSync || null; }

  // ── device hint (§5.3): non-secret, paints the chip, drives the analytics guard and the public expiry wipe ─────────────
  function readHint() {
    try { var o = JSON.parse(lsGet(KEYS.hint) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
  }
  function writeHint(h) { lsSet(KEYS.hint, h ? JSON.stringify(h) : null); }
  // enabled() / betaEnabled() (the v4.0 name, still read by 68 / 69 and the host's privacy page): accounts are on for this
  // eligible page unless the device opted out with ?cloud=0
  function betaEnabled() { return lsGet(KEYS.off) !== '1'; }
  (function readCloudSwitch() {
    var m = /[?&]cloud=([01])(?:&|$)/.exec(L.search || '');
    if (m) lsSet(KEYS.off, m[1] === '0' ? '1' : null);
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
    if (current.status === 'signedIn') { attachSignedIn(); closeWelcome(false); } else detachSignedIn();
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
    dlg.welcome = false; dlg.welcomeChoice = null;    // signing in: the first-open form stores no guest choice on close
    setStep('busy', { text: 'Signing in…' });
    return refresh().then(function () {
      if (current.status !== 'signedIn') { closeDialog(); return state(); }
      // the reload below needs the page's pending autosave written first: write it BEFORE the hand-over, so the upload
      // includes it and no rewrite after the binding marks a just-saved project dirty (review fix)
      var reloads = G.__wtsGaLoaded === true;
      if (reloads) { try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.flush) G.WTS_pageAutosave.flush(); } catch (e) { /* none */ } }
      var p = (S && typeof S.afterSignIn === 'function') ? S.afterSignIn(current.user, { firstSignIn: !!(body && body.firstSignIn), method: o.method || 'code' }) : Promise.resolve(null);
      return Promise.resolve(p).then(null, function () { return null; }).then(function () {
        if (reloads) {
          setStep('busy', { text: 'Finishing sign-in…' });
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
    choice: null, onKey: null, signup: false, profile: null };
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
    if (isProfileErr(e)) return profileErrText(e);
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
      // the host's .fg-item / .acct-btns display rules must not override the hidden attribute on account rows (review fix)
      '#acct_root [hidden],.acct-dlg [hidden],.acct-ov[hidden]{display:none!important}',
      '.acct-faq{margin-top:12px;font-size:13px}.acct-faq ul{padding-left:18px;margin:6px 0}.acct-faq li{margin:4px 0}',
      '.acct-x{background:none;border:0;color:var(--text2,#ccc);font-size:20px;cursor:pointer;min-width:36px;min-height:36px}',
      '.acct-list{list-style:none;padding:0;margin:8px 0;max-height:46vh;overflow:auto}.acct-list li{padding:6px 0;border-bottom:1px solid var(--border,#333)}',
      '.acct-sync-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10040;background:var(--bg3,#222);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:8px;padding:8px 10px 8px 14px;display:block;font-size:13px;max-width:calc(100vw - 32px);box-shadow:0 6px 24px rgba(0,0,0,.4);box-sizing:border-box}',
      '.acct-sync-bar .acct-bar-in{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      // class selectors only (no id, no inline position): the iOS safe-area rules of ios-styles.css (scoped to the app's root class) must be able to win
      '.acct-toast{position:fixed;right:16px;top:16px;z-index:10055;background:var(--bg3,#222);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:8px;padding:8px 12px;font-size:13px;max-width:calc(100vw - 32px);box-sizing:border-box}',
      // the account page drawn in its own overlay (no host route): under the choice dialogs, wider than a dialog
      '.acct-ov.acct-page-ov{z-index:10058}.acct-dlg.acct-page-dlg{max-width:980px}',
      // §11.3: at phone width the account tables become stacked rows with full-width buttons
      '@media (max-width:600px){#acct_root table.dtable,#acct_root table.dtable tbody,#acct_root table.dtable tr,#acct_root table.dtable td{display:block;width:100%;box-sizing:border-box}',
      '#acct_root table.dtable thead{display:none}#acct_root table.dtable tr{border-bottom:1px solid var(--border,#444);padding:8px 0}',
      '#acct_root table.dtable td{border:0;padding:3px 0}#acct_root table.dtable td[data-label]:before{content:attr(data-label);display:block;font-size:12px;color:var(--text2,#bbb)}',
      '#acct_root .btn{display:block;width:100%;min-height:44px;font-size:16px;margin:4px 0}#acct_root .acct-btns input{width:100%;font-size:16px}}',
      '@media (max-width:600px){.acct-chip .acct-txt{display:none}.acct-chip{min-width:44px;min-height:44px;justify-content:center;padding:4px}',
      '.acct-ov{padding:0;align-items:stretch}.acct-dlg{max-width:none;min-height:100%;border-radius:0;padding:16px}',
      '.acct-btns .btn{flex:1 1 100%;min-height:44px;font-size:16px}.acct-menu button,.acct-cloud-menu button{min-height:44px;font-size:16px}',
      '.acct-menu,.acct-cloud-menu{position:fixed;left:16px;right:16px;top:auto;min-width:0}',
      '.acct-sync-bar{left:16px;right:16px;transform:none;max-width:none}}',
      // the chip at the bottom-left: the last row of the sidebar footer, full width; the footer sticks to the sidebar's bottom
      // edge so the chip stays on screen when the nav scrolls (also in the phone drawer)
      '#sidebar .sidebar-footer{position:sticky;bottom:0;z-index:2;background:var(--bg0,#0d1117)}',
      '#sbAccountLine{margin-top:8px}#sbAccountLine:empty{display:none}',
      '.acct-host-sb,.acct-host-sb .acct-wrap{display:block;width:100%}',
      '.acct-host-sb .acct-chip{display:flex;width:100%;box-sizing:border-box;border-radius:8px;min-height:36px;padding:6px 10px;font-size:13px;text-align:left;justify-content:flex-start}',
      '.acct-host-sb .acct-chip .acct-txt{display:inline;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.acct-host-sb .acct-chip--out{border-color:var(--accent,#f0883e);color:var(--accent,#f0883e);font-weight:600}',
      '.acct-host-sb .acct-chip--out:hover{background:rgba(240,136,62,.10)}',
      '.acct-caret{font-size:10px;color:var(--text3,#999)}',
      '.acct-menu.acct-menu--up{position:fixed;top:auto;right:auto;overflow-y:auto;box-sizing:border-box}',
      '@media (max-width:768px){.acct-host-sb .acct-chip{min-height:44px;font-size:15px}}',
      '.acct-link{background:none;border:0;padding:0;color:var(--blue,#58a6ff);text-decoration:underline;cursor:pointer;font:inherit}',
      // the optional profile (sign-up step, provider consent step, Account page): two columns, one at phone width
      '.acct-pf-set{border:1px solid var(--border,#444);border-radius:8px;padding:6px 12px 12px;margin:12px 0}.acct-pf-set legend{font-size:13px;font-weight:600;padding:0 4px;color:var(--text,#eee)}',
      '.acct-pf-set .acct-note{margin:2px 0 4px}',
      '.acct-pf{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.acct-pf .acct-pf-fullName{grid-column:1 / -1}',
      '.acct-pf label{display:block;margin:10px 0 4px;font-size:13px;color:var(--text2,#ccc)}.acct-opt{color:var(--text3,#999);font-weight:400;font-size:12px}',
      '.acct-pf input,.acct-pf select{width:100%;box-sizing:border-box;font-size:16px;min-height:40px;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#555);background:var(--bg,#111);color:var(--text,#eee)}',
      '#acct_root .acct-pf{max-width:640px}',
      '@media (max-width:600px){.acct-pf{grid-template-columns:1fr}}',
      // ── the modal dialogs (sign-in incl. its first-open welcome form, code, profile / consent, step-up, choices, the provider
      // finish): one centred card, symmetric 12 px grid, 44 px controls. The overlay is a flex box whose child has margin:auto,
      // so a card taller than the screen scrolls from its top (never clipped). Theme tokens of the app (dark).
      '.acct-ov.acct-ov--modal{display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;background:rgba(1,4,9,.66);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);animation:acctFade .16s ease-out}',
      '.acct-dlg.acct-modal{position:relative;margin:auto;width:min(420px,calc(100vw - 32px));max-width:420px;min-height:0;padding:28px 28px 24px;border-radius:16px;border:1px solid var(--border-light,#3d444d);background:var(--bg2,#161b22);color:var(--text,#e6edf3);box-shadow:0 24px 64px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35);font-size:14px;line-height:1.5;animation:acctPop .18s ease-out}',
      '@keyframes acctFade{from{opacity:0}}@keyframes acctPop{from{opacity:0;transform:translateY(8px) scale(.98)}}',
      '@media (prefers-reduced-motion:reduce){.acct-ov.acct-ov--modal,.acct-dlg.acct-modal{animation:none}}',
      '.acct-dlg.acct-modal:focus{outline:none}',
      '.acct-modal .acct-x{position:absolute;top:12px;right:12px;width:36px;height:36px;min-width:36px;min-height:36px;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;color:var(--text2,#8b949e)}',
      '.acct-modal .acct-x:hover{background:var(--bg4,#21262d);color:var(--text,#e6edf3)}',
      '.acct-modal button:focus-visible,.acct-modal a:focus-visible,.acct-modal input:focus-visible,.acct-modal select:focus-visible,.acct-modal summary:focus-visible{outline:2px solid var(--focus,#58a6ff);outline-offset:2px}',
      '.acct-hd{text-align:center;margin:0 0 20px;padding:0 24px}',
      '.acct-mark{display:flex;justify-content:center;margin:0 0 12px}.acct-mark:empty{display:none}.acct-mark img{display:block;height:44px;width:auto}',
      '.acct-modal .acct-title{display:block;margin:0;font-size:20px;font-weight:700;line-height:1.3;color:var(--text,#e6edf3);text-wrap:balance}',
      '.acct-sub{margin:8px 0 0;font-size:14px;line-height:1.5;color:var(--text2,#8b949e);text-wrap:balance}',
      '.acct-modal a{color:var(--blue,#58a6ff)}',
      '.acct-modal .acct-body{display:flex;flex-direction:column;gap:12px}.acct-modal .acct-body>*{margin:0}',
      '.acct-modal p{margin:0}.acct-modal b{color:var(--text,#e6edf3)}',
      '.acct-field{display:flex;flex-direction:column;gap:6px}',
      '.acct-modal label{margin:0;font-size:13px;font-weight:600;color:var(--text2,#8b949e)}',
      '.acct-modal input[type=email],.acct-modal input[type=text],.acct-modal input[type=tel],.acct-modal select{width:100%;height:44px;min-height:44px;margin:0;padding:0 14px;box-sizing:border-box;border-radius:10px;border:1px solid var(--border-light,#3d444d);background:var(--bg1,#0d1117);color:var(--text,#e6edf3);font-size:16px}',
      '.acct-modal input[type=email]:focus,.acct-modal input[type=text]:focus,.acct-modal input[type=tel]:focus,.acct-modal select:focus{border-color:var(--focus,#58a6ff);box-shadow:0 0 0 3px rgba(88,166,255,.22);outline:none}',
      '.acct-modal input.acct-code-in{text-align:center;font-size:20px;letter-spacing:6px;font-variant-numeric:tabular-nums}',
      '.acct-modal .acct-btns{display:flex;flex-direction:column;gap:12px;margin:0}',
      '.acct-modal .btn{display:flex;width:100%;min-height:44px;margin:0;padding:10px 16px;box-sizing:border-box;justify-content:center;align-items:center;text-align:center;border-radius:10px;font-size:15px;font-weight:600}',
      '.acct-modal .btn:disabled{opacity:.6;cursor:default}',
      '.acct-modal .acct-or{margin:0;gap:12px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text3,#848d97)}',
      '.acct-modal .acct-providers,.acct-prov{display:flex;flex-direction:column;gap:12px}',
      '.acct-prov-btn{display:grid;grid-template-columns:24px 1fr 24px;align-items:center;column-gap:12px;width:100%;min-height:44px;margin:0;padding:0 14px;box-sizing:border-box;border:1px solid #8e918f;border-radius:10px;background:#131314;color:#e3e3e3;font-family:inherit;font-size:15px;font-weight:500;line-height:1.2;cursor:pointer;transition:background .15s,border-color .15s}',
      '.acct-prov-btn:hover{background:#202124;border-color:#b0b3b1}.acct-prov-btn:disabled{opacity:.55;cursor:default}',
      '.acct-prov-btn:focus-visible{outline:2px solid var(--focus,#58a6ff);outline-offset:2px}',
      '.acct-prov-mark{justify-self:center;align-items:center;justify-content:center}.acct-prov-label{text-align:center}',
      '.acct-prov-note{font-size:13px;color:var(--text2,#8b949e);text-align:center}.acct-modal .acct-prov-note{margin:0!important}',
      '.acct-prov-status{text-align:center;color:var(--text2,#8b949e)}.acct-modal .acct-prov-status{margin:0!important}',
      '.acct-modal .acct-tick{display:flex;gap:10px;align-items:flex-start;margin:0;font-size:13px;font-weight:400;line-height:1.45;color:var(--text2,#8b949e);cursor:pointer}',
      '.acct-modal .acct-tick input{flex:0 0 auto;width:16px;height:16px;margin:2px 0 0;accent-color:var(--accent,#f0883e)}',
      '.acct-modal .acct-tick--c{justify-content:center;align-items:center}.acct-modal .acct-tick--c input{margin:0}',
      '.acct-foot{text-align:center;font-size:13px;color:var(--text2,#8b949e)}',
      '.acct-modal .acct-note{margin:0;font-size:12px;line-height:1.5;color:var(--text3,#848d97)}.acct-modal .acct-note.acct-c{text-align:center}',
      '.acct-modal .acct-msg{margin:12px 0 0;min-height:0;text-align:center}.acct-modal .acct-msg:empty{display:none}',
      '.acct-modal .acct-faq{margin:0;font-size:13px;color:var(--text2,#8b949e)}.acct-modal .acct-faq summary{cursor:pointer;text-align:center;color:var(--blue,#58a6ff)}',
      '.acct-modal .acct-faq .btn{min-height:36px;font-size:13px;margin-top:6px}',
      '.acct-modal .acct-pf-set{margin:0;padding:8px 14px 14px;border-radius:10px}',
      '.acct-modal .acct-pf label{margin:10px 0 6px}',
      '.acct-modal .acct-pf input,.acct-modal .acct-pf select{height:44px}',
      '.acct-modal .acct-list{margin:0}',
      // the account page's phone sheet rule (.acct-ov / .acct-dlg above) does not apply to the modal cards
      '@media (max-width:600px){.acct-ov.acct-ov--modal{padding:16px;align-items:center}.acct-dlg.acct-modal{width:calc(100vw - 32px);max-width:420px;min-height:0;border-radius:14px;padding:24px 20px 20px}',
      '.acct-hd{padding:0 24px}.acct-modal .acct-title{font-size:19px}.acct-modal .btn{font-size:16px}.acct-modal .acct-pf{grid-template-columns:1fr}',
      // narrow phones (320 px): the provider labels keep one line, centred like the wider layout
      '.acct-prov-btn{column-gap:8px;padding:0 10px;font-size:14px}.acct-prov-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}',
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
      ov.className = 'acct-ov acct-ov--modal rp-skip';
      ov.setAttribute('data-rp-nosnap', '1');
      // a centred card: × top-right, a centred header (the app mark, the title, a one-line subtitle), the step body, the message
      ov.innerHTML = '<div class="acct-dlg acct-modal" id="acct_dlg" role="dialog" aria-modal="true" aria-labelledby="acct_dlg_t" tabindex="-1">' +
        '<button type="button" class="acct-x" id="acct_dlg_x" aria-label="Close">&#215;</button>' +
        '<div class="acct-hd"><div class="acct-mark" id="acct_dlg_mark"></div><h3 class="acct-title"><span id="acct_dlg_t">Sign in</span></h3>' +
        '<p class="acct-sub" id="acct_dlg_sub" hidden></p></div>' +
        '<div id="acct_dlg_body" class="acct-body"></div><div id="acct_msg" class="acct-msg" role="status" aria-live="polite"></div></div>';
      document.body.appendChild(ov);
      appMark($('acct_dlg_mark'));
      $('acct_dlg_x').addEventListener('click', function () { closeDialog(true); });
      // a click on the backdrop closes the sign-in entry step only (never a code, consent or choice step in progress)
      ov.addEventListener('click', function (ev) {
        if (ev && ev.target === ov && dlg.open && (dlg.step === 'email' || dlg.step === 'revert')) closeDialog(true);
      });
      // modal: Esc closes; Tab / Shift+Tab stay inside the card
      dlg.onKey = function (ev) {
        if (!ev || !dlg.open) return;
        if (ev.key === 'Escape') { if (ev.preventDefault) ev.preventDefault(); closeDialog(true); return; }
        if (ev.key === 'Tab') trapTab(ev, $('acct_dlg'));
      };
      document.addEventListener('keydown', dlg.onKey);
      try { dlg.opener = document.activeElement; } catch (e) { dlg.opener = null; }
    }
    dlg.open = true; dlg.mode = mode || dlg.mode || 'signin';
    if (opts && opts.title) $('acct_dlg_t').textContent = opts.title;
    return ov;
  }
  // trapTab(ev, box): keeps Tab / Shift+Tab inside box (the enabled, visible buttons, inputs, selects, links and summaries)
  function trapTab(ev, box) {
    if (!box || !box.querySelectorAll) return;
    var f = Array.prototype.filter.call(box.querySelectorAll('button, input, select, a[href], summary'), function (n) {
      if (n.disabled) return false;
      for (var e = n; e && e !== box; e = e.parentNode) {
        if (e.hidden) return false;
        // a control inside a closed <details> is not rendered (only that details' own <summary> is)
        if (e.tagName === 'DETAILS' && !e.open && n.parentNode !== e) return false;
      }
      return true;
    });
    if (!f.length) return;
    var i = f.indexOf(document.activeElement);
    var next = ev.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
    if (ev.preventDefault) ev.preventDefault();
    try { f[next].focus(); } catch (e) { /* none */ }
  }
  // appMark(el): the app's own logo (the sidebar's image, copied by property — no new asset, nothing loaded)
  function appMark(el) {
    if (!el || !HAS_DOC) return;
    try {
      var src = document.querySelector && document.querySelector('.sidebar-brand img');
      var u = src && (src.getAttribute('src') || '');
      if (!/^data:image\/(png|svg\+xml|webp|jpeg);base64,/.test(u)) return;
      var im = document.createElement('img');
      im.alt = ''; im.setAttribute('aria-hidden', 'true'); im.src = u;
      el.appendChild(im);
    } catch (e) { /* no mark */ }
  }
  function setSub(t) { var e = $('acct_dlg_sub'); if (!e) return; e.textContent = t || ''; e.hidden = !t; }
  // closeDialog(cancelled): removes the overlay, returns focus, settles a pending choose() with null. The first-open (welcome)
  // form closed without a sign-in stores the visitor's choice (guest unless they started a sign-in), so it is not offered again
  // for 30 days.
  function closeDialog(cancelled) {
    if (dlg.welcome) {
      dlg.welcome = false;
      if (current.status !== 'signedIn') lsSet(KEYS.welcome, JSON.stringify({ choice: dlg.welcomeChoice || 'guest', at: now() }));
    }
    dlg.welcomeChoice = null;
    var ov = $('acct_dlg_ov');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    if (dlg.onKey && HAS_DOC) document.removeEventListener('keydown', dlg.onKey);
    dlg.onKey = null;
    var wasOpen = dlg.open;
    dlg.open = false; dlg.step = null; dlg.signup = false; dlg.profile = null; dlg.existing = false;
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
    setSub('');
    if (name === 'email') return drawEmail(b, data);
    if (name === 'code') return drawCode(b, data);
    if (name === 'consent') return drawConsent(b, data);
    if (name === 'stepup') return drawStepUp(b, data);
    if (name === 'busy') { b.innerHTML = '<p>' + esc(data.text || 'Working…') + '</p>'; return; }
    if (name === 'revert') return drawRevert(b, data);
  }
  // #account-revert (the link in the "your e-mail address was changed" notice, §4.3): the old address and the 7-day revert key
  // (26 letters and digits; the notice's link #account-revert=<key> fills it in)
  function drawRevert(b, data) {
    setTitle('Undo an e-mail change');
    b.innerHTML = '<p>Your account\'s e-mail address was changed. If that was not you, enter your previous address and the code from the notice. ' +
      'This signs out every session and removes sign-in methods added since the change.</p>' +
      '<div class="acct-field"><label for="acct_rev_email">Previous e-mail address</label><input type="email" id="acct_rev_email" maxlength="254" autocomplete="username"></div>' +
      '<div class="acct-field"><label for="acct_rev_code">Revert key from the notice</label><input type="text" id="acct_rev_code" maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_rev_go">Undo the change</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_rev_cancel">Cancel</button></div>';
    $('acct_rev_cancel').addEventListener('click', function () { closeDialog(true); });
    $('acct_rev_go').addEventListener('click', function () {
      var em = String($('acct_rev_email').value || '').trim(); var code = String($('acct_rev_code').value || '').replace(/[\s-]/g, '').toUpperCase();
      if (!EMAIL_RE.test(em) || !/^[A-Z2-7]{26}$/.test(code)) { message('Enter the previous address and the 26-character revert key from the notice.', 'err'); return; }
      revertEmail(em, code).then(function (r) {
        message('Done: your previous address is back and ' + r.sessions + ' session' + (r.sessions === 1 ? ' was' : 's were') + ' signed out.', 'ok');
      }, function (e) { message(errText(e), 'err'); });
    });
    if (data && data.key) $('acct_rev_code').value = data.key;
    focusFirst('acct_rev_email');
  }
  function revertEmail(email, code) {
    return call('POST', '/auth/email/revert', { email: email, code: code }).then(function (r) {
      lsSet(KEYS.hint, JSON.stringify({ signedIn: true, initial: String(email)[0].toUpperCase(), public: false, lastSeenAt: now(), v: 3 }));
      return refresh().then(function () { return r.json; });
    });
  }
  // The sign-in entry step — also the first-open (welcome) form. Top to bottom: Google / LinkedIn (only those the server's
  // GET /auth/providers says are on), "or", the e-mail field and Send code, "Use as guest", the create-account / sign-in
  // switch and the public-computer tick. The provider area keeps its height while the answer is pending (no layout shift).
  // The sign-in / sign-up subtitles name only the providers whose buttons are drawn (GET /auth/providers): e-mail-only wording
  // until the answer arrives and when no provider is on or the server cannot be reached (review fix 4.2).
  var SUB = {
    welcome: 'Save your projects to your account in the cloud and open them on any device, with a history of earlier saves.',
    signin: function (names) {
      return names && names.length ? 'Use ' + names.join(', ') + ' or a one-time code sent to your e-mail — no password needed.'
        : 'Use a one-time code sent to your e-mail — no password needed.';
    },
    signup: function (names) {
      return names && names.length ? 'It is free. Use ' + names.join(', ') + ' or your e-mail address — no password needed.'
        : 'It is free. Use your e-mail address — no password needed.';
    },
  };
  var PROV_NAME = { google: 'Google', linkedin: 'LinkedIn' };
  function subFor(names) { return dlg.signup ? SUB.signup(names) : dlg.welcome ? SUB.welcome : SUB.signin(names); }
  function drawEmail(b, data) {
    setTitle(dlg.signup ? 'Create your free account' : dlg.welcome ? 'Sign in to keep your work safe' : 'Sign in to Well Testing Suite');
    setSub(subFor([]));
    b.innerHTML =
      '<div id="acct_provider_buttons" class="acct-providers" data-owner="WP-O"></div>' +
      '<div class="acct-or" id="acct_or">or</div>' +
      (data.note ? '<p class="acct-note acct-c">' + esc(data.note) + '</p>' : '') +
      '<div class="acct-field"><label for="acct_email">E-mail address</label>' +
      '<input type="email" id="acct_email" inputmode="email" autocomplete="username webauthn" maxlength="254" spellcheck="false" placeholder="name@company.example" value="' + esc(dlg.email) + '"></div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_send">' + (dlg.signup ? 'Send my code' : 'Send code') + '</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_guest">Use as guest</button></div>' +
      '<p class="acct-foot" id="acct_guest_note">We e-mail you an 8-digit code. As a guest, your work stays in this browser only.</p>' +
      '<p class="acct-foot">' + (dlg.signup ? 'Already have an account? <button type="button" class="acct-link" id="acct_mode">Sign in</button>'
        : 'New here? <button type="button" class="acct-link" id="acct_mode">Create a free account</button>') + '</p>' +
      '<label class="acct-tick acct-tick--c" title="On a public computer you are signed out after 12 hours and this browser keeps nothing of your work.">' +
      '<input type="checkbox" id="acct_public"' + (dlg.publicDevice ? ' checked' : '') + '> This is a public or shared computer</label>' +
      '<p class="acct-note acct-c" id="acct_public_note"' + (dlg.publicDevice ? '' : ' hidden') + '>On a public computer you are signed out after 12 hours and this browser keeps nothing of your work.</p>';
    $('acct_send').addEventListener('click', sendCode);
    $('acct_email').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') sendCode(); });
    $('acct_guest').addEventListener('click', function () { if (dlg.welcome) dlg.welcomeChoice = 'guest'; else rememberGuest(); closeDialog(true); });
    $('acct_mode').addEventListener('click', function () {
      dlg.signup = !dlg.signup;
      var inp = $('acct_email'); if (inp) dlg.email = String(inp.value || '');
      setStep('email'); focusFirst('acct_email');
    });
    $('acct_public').addEventListener('change', function () {
      dlg.publicDevice = !!$('acct_public').checked;
      var n = $('acct_public_note'); if (n) n.hidden = !dlg.publicDevice;
      drawProviders();
    });
    // a provider button pressed from the first-open form: the visitor chose to sign in (the page then leaves for the provider)
    $('acct_provider_buttons').addEventListener('click', function () { if (dlg.welcome) noteWelcomeChoice(dlg.signup ? 'signup' : 'signin'); });
    drawProviders();
    // the first-open form does not put the cursor in the field (no on-screen keyboard popping up on a phone): the card takes
    // the focus; the chip's dialog focuses the field as before
    // preventScroll: on a short screen the card is taller than the overlay; focusing it must not scroll the card's top (and the ×)
    // off the screen — the overlay starts at its top, with the 16 px gutter that margin:auto gives
    if (dlg.welcome && !data.focusField) {
      var d = $('acct_dlg');
      try { if (d && d.focus) d.focus({ preventScroll: true }); } catch (e) { /* none */ }
      var o = $('acct_dlg_ov'); if (o) { try { o.scrollTop = 0; } catch (e) { /* none */ } }
    }
    else focusFirst('acct_email');
  }
  // "Use as guest" outside the first-open form: the same device pref (not offered again for 30 days)
  function rememberGuest() { if (current.status !== 'signedIn') lsSet(KEYS.welcome, JSON.stringify({ choice: 'guest', at: now() })); }
  function noteWelcomeChoice(c) {
    dlg.welcomeChoice = c;
    lsSet(KEYS.welcome, JSON.stringify({ choice: c, at: now() }));
  }
  // WP-O mount: provider buttons are drawn by hooks.renderProviders after GET /auth/providers (only when WP-O is present).
  // While the answer is pending the area keeps the height of the buttons, so nothing below moves when they appear; with no
  // provider on, the area and the "or" divider collapse.
  var PROV_ROW = 44, GAP = 12;
  function drawProviders() {
    var el = $('acct_provider_buttons');
    var or = $('acct_or');
    if (!el || typeof hooks.renderProviders !== 'function') { if (or) or.className = 'acct-or acct-or--none'; if (el) el.hidden = true; return; }
    var pubNow = dlg.publicDevice;
    el.style.minHeight = (PROVIDERS.length * PROV_ROW + (PROVIDERS.length - 1) * GAP) + 'px';
    el.setAttribute('aria-busy', 'true');
    providers().then(function (prov) {
      var el2 = $('acct_provider_buttons');
      if (!el2 || dlg.step !== 'email') return;
      el2.innerHTML = '';
      var drawn = null;
      try { drawn = hooks.renderProviders(el2, prov, { publicDevice: pubNow, sharedBrowser: lsGet(KEYS.shared) === '1', compact: true, signup: !!dlg.signup }); } catch (e) { /* WP-O */ }
      return Promise.resolve(drawn).then(null, function () { return null; }).then(function () {
        var el3 = $('acct_provider_buttons'); if (!el3) return;
        var any = !!(el3.querySelector && el3.querySelector('.acct-prov-btn'));
        var names = [];
        if (any && el3.querySelectorAll) {
          PROVIDERS.forEach(function (p) { if (el3.querySelector('.acct-prov-btn[data-provider="' + p + '"]')) names.push(PROV_NAME[p] || p); });
        }
        if (dlg.step === 'email') setSub(subFor(names));
        el3.style.minHeight = ''; el3.removeAttribute('aria-busy');
        el3.hidden = !any;
        var or2 = $('acct_or'); if (or2) or2.className = 'acct-or' + (any ? '' : ' acct-or--none');
      });
    }, function () {
      var el3 = $('acct_provider_buttons'); if (el3) { el3.style.minHeight = ''; el3.removeAttribute('aria-busy'); el3.hidden = true; }
      var or2 = $('acct_or'); if (or2) or2.className = 'acct-or acct-or--none';
    });
  }
  function sendCode() {
    var inp = $('acct_email');
    var email = String(inp ? inp.value : dlg.email).trim();
    if (!EMAIL_RE.test(email) || email.length > 254) { message('Please enter one e-mail address.', 'err'); return Promise.resolve(false); }
    dlg.email = email;
    if (dlg.welcome) noteWelcomeChoice(dlg.signup ? 'signup' : 'signin');
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
    setSub('We sent an 8-digit code to ' + dlg.email + '.');
    b.innerHTML =
      '<p class="acct-note acct-c">It expires in 15 minutes. Only enter it here, at welltest.h2oil.co.uk.</p>' +
      '<div class="acct-field"><label for="acct_code">Code</label>' +
      '<input type="text" id="acct_code" class="acct-code-in" inputmode="numeric" autocomplete="one-time-code" maxlength="11" spellcheck="false" placeholder="12345678"></div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_verify">Sign in</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_resend">Send again</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_back">Use another address</button></div>' +
      codeFaq(false);
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
    if (consent && !dlg.existing && dlg.profile && !profileEmpty(dlg.profile)) req.profile = cleanProfile(dlg.profile);
    var btn = $('acct_verify') || $('acct_create'); if (btn) btn.disabled = true;
    return call('POST', '/auth/code/verify', req).then(function (r) {
      dlg.code = null;
      return completeSignIn(r.json, { method: 'code' }).then(function () { return true; });
    }, function (e) {
      if (btn) btn.disabled = false;
      if (e && e.code === 'consent_required') { setStep('consent', { terms: e.body && e.body.terms, privacy: e.body && e.body.privacy, countryHint: e.body && e.body.countryHint, existing: !!(e.body && e.body.existing) }); return false; }
      message(errText(e), 'err');
      return false;
    });
  }
  function drawConsent(b, data) {
    dlg.consent = { terms: String(data.terms || ''), privacy: String(data.privacy || '') };
    dlg.existing = !!data.existing;
    if (dlg.existing) {
      // an existing account whose accepted versions are older (review fix): asked to accept the current ones, no new-account
      // wording and no profile fields
      setTitle('Updated Terms and Privacy notice');
      b.innerHTML =
        '<p id="acct_reconsent_note">The Terms of Use or the Privacy notice changed since you last accepted them. Please read the current versions to keep signing in to <b>' + esc(dlg.email) + '</b>.</p>' +
        '<label class="acct-tick"><input type="checkbox" id="acct_consent_ok"><span>I accept the <a href="terms.html" target="_blank" rel="noopener" id="acct_terms_link">Terms of Use</a> (version ' + esc(dlg.consent.terms) + ') and have read the <a href="privacy.html" target="_blank" rel="noopener" id="acct_privacy_link">Privacy notice</a> (version ' + esc(dlg.consent.privacy) + ').</span></label>' +
        '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_create">Accept and continue</button>' +
        '<button type="button" class="btn btn-secondary" id="acct_consent_cancel">Cancel</button></div>';
      $('acct_create').addEventListener('click', function () {
        if (!$('acct_consent_ok').checked) { message('Please tick the box to accept the current Terms of Use and Privacy notice.', 'err'); return; }
        dlg.profile = null;
        verifyCode(dlg.consent);
      });
      $('acct_consent_cancel').addEventListener('click', function () { closeDialog(true); });
      return;
    }
    setTitle('Create your account');
    b.innerHTML =
      '<p>You are creating a new account for <b>' + esc(dlg.email) + '</b>. Already have an account with another address? Cancel and sign in with it.</p>' +
      '<fieldset class="acct-pf-set"><legend>About you <span class="acct-opt">(optional)</span></legend><p class="acct-note" id="acct_pf_note">' + esc(PROFILE_NOTE) + '</p>' +
      profileFormHtml('acct_su', dlg.profile, { countryHint: data.countryHint }) + '</fieldset>' +
      '<label class="acct-tick"><input type="checkbox" id="acct_consent_ok"><span>I am 18 or over. I accept the <a href="terms.html" target="_blank" rel="noopener" id="acct_terms_link">Terms of Use</a> (version ' + esc(dlg.consent.terms) + ') and have read the <a href="privacy.html" target="_blank" rel="noopener" id="acct_privacy_link">Privacy notice</a> (version ' + esc(dlg.consent.privacy) + ').</span></label>' +
      '<p class="acct-note">Your account and projects are stored encrypted in the United States (larger project files in the EU). You can export everything or delete your account at any time.</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_create">Create account</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_consent_cancel">Cancel</button></div>';
    $('acct_create').addEventListener('click', function () {
      if (!$('acct_consent_ok').checked) { message('Please tick the box to confirm you are 18 or over and accept the Terms of Use and the Privacy notice.', 'err'); return; }
      dlg.profile = readProfile('acct_su');
      // the optional profile is checked here, by the server's rules, so it can never block the account (review fix)
      var pp = profileProblem(dlg.profile);
      if (pp) { message(pp.text, 'err'); var pe = $('acct_su_pf_' + pp.field); try { if (pe && pe.focus) pe.focus(); } catch (e) { /* focus */ } return; }
      verifyCode(dlg.consent);
    });
    $('acct_consent_cancel').addEventListener('click', function () { closeDialog(true); });
  }

  // ── the optional profile (user insight; server: PUT /account/profile, GET /me profile, sign-up profile?) ──────────────
  // Five self-declared fields, every one optional: full name, company (their employer), job title, country (ISO 3166-1
  // alpha-2, from a list) and phone. Shown on the new-account step of both sign-in dialogs and on the Account page ("Your
  // profile"). Strings are trimmed and capped; an empty field is null; nothing is sent when every field is empty. The fields
  // live in the dialogs / the account route, outside #pgBody's autosave, so nothing typed is stored on the device.
  var PROFILE_FIELDS = [
    { k: 'fullName', label: 'Full name', max: 80, ac: 'name' },
    { k: 'company', label: 'Company', max: 120, ac: 'organization' },
    { k: 'jobTitle', label: 'Job title', max: 80, ac: 'organization-title' },
    { k: 'country', label: 'Country', max: 2 },
    { k: 'phone', label: 'Phone', max: 40, ac: 'tel' },
  ];
  // ISO 3166-1 alpha-2 (officially assigned codes)
  var COUNTRY_CODES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE ' +
    'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP ' +
    'KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF ' +
    'NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN ' +
    'SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ' +
    'ZM ZW').split(' ');
  var regionNames = null;
  try { if (G.Intl && typeof G.Intl.DisplayNames === 'function') regionNames = new G.Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { regionNames = null; }
  function countryCode(c) { c = String(c == null ? '' : c).trim().toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : null; }
  function countryName(code) {
    var c = countryCode(code); if (!c) return '';
    var n = null; try { n = regionNames ? regionNames.of(c) : null; } catch (e) { n = null; }
    return n && n !== c ? String(n) : c;
  }
  var countryList = null;
  function countries() {
    if (!countryList) countryList = COUNTRY_CODES.map(function (c) { return { code: c, name: countryName(c) }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return countryList;
  }
  // cleanProfile(p) → {fullName, company, jobTitle, country, phone} with every key present (null when empty), or null for a
  // non-object. Control characters become spaces; text is trimmed and capped; a country that is not a two-letter code is null.
  function cleanProfile(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    var out = {};
    PROFILE_FIELDS.forEach(function (f) {
      var v = p[f.k];
      if (f.k === 'country') { out.country = countryCode(v); return; }
      out[f.k] = profileText(v, f.max) || null;
    });
    return out;
  }
  // the server's text rule (core/contract.js textUpTo): NFKC first, then the control characters it refuses (C0, DEL, C1,
  // U+2028 / U+2029) become spaces, trimmed, the cap counted on the normalised text and cut on a code-point boundary (review fix)
  var PF_CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
  function profileText(v, max) {
    var t = v == null ? '' : String(v);
    for (var guard = 0; guard < 8; guard++) {
      try { t = t.normalize('NFKC'); } catch (e) { /* no normalize */ }
      t = t.replace(PF_CTRL, ' ').replace(/\s+/g, ' ').trim();
      if (t.length <= max) return t;
      t = t.slice(0, max);
      if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1);
    }
    return t.length <= max ? t : '';
  }
  // profileProblem(p) → null, or {field, text} for the first field the server would refuse (today only the phone can be:
  // digits, spaces and + ( ) . / -, at least 3 digits — core/contract.js phoneText)
  var PHONE_RULE = 'Phone: use digits, spaces and + ( ) . / - only, with at least 3 digits (or leave it empty).';
  function profileProblem(p) {
    var c = cleanProfile(p);
    if (!c) return null;
    if (c.phone != null && (!/^[0-9+() .\/-]+$/.test(c.phone) || (c.phone.match(/[0-9]/g) || []).length < 3)) return { field: 'phone', text: PHONE_RULE };
    return null;
  }
  // the message for a refused profile (a bad_request whose field is profile / profile.<key>)
  function profileErrText(e) {
    var f = String((e && e.body && e.body.field) || '');
    if (/phone/.test(f)) return PHONE_RULE;
    return 'Please check the optional profile fields (name up to 80 characters, company up to 120, job title up to 80; ' + PHONE_RULE.charAt(0).toLowerCase() + PHONE_RULE.slice(1, -1) + '), or leave them empty.';
  }
  function isProfileErr(e) { return !!(e && e.code === 'bad_request' && /^profile(\.|$)/.test(String((e.body && e.body.field) || ''))); }
  function profileEmpty(p) { var c = cleanProfile(p); return !c || PROFILE_FIELDS.every(function (f) { return c[f.k] == null; }); }
  // profileFormHtml(prefix, profile, {countryHint, compact}) — the five fields; ids <prefix>_pf_<key>; every value escaped
  function profileFormHtml(prefix, profile, o) {
    o = o || {};
    var p = cleanProfile(profile) || {};
    var sel = p.country || countryCode(o.countryHint) || '';
    return '<div class="acct-pf" id="' + prefix + '_pf">' + PROFILE_FIELDS.map(function (f) {
      var id = prefix + '_pf_' + f.k;
      var lab = '<label for="' + id + '">' + esc(f.label) + ' <span class="acct-opt">(optional)</span></label>';
      if (f.k === 'country') {
        return '<div class="acct-pf-f acct-pf-country">' + lab + '<select id="' + id + '" autocomplete="country"><option value="">Choose…</option>' +
          countries().map(function (c) { return '<option value="' + c.code + '"' + (c.code === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') +
          '</select></div>';
      }
      return '<div class="acct-pf-f acct-pf-' + f.k + '">' + lab + '<input type="' + (f.k === 'phone' ? 'tel' : 'text') + '" id="' + id + '" maxlength="' + f.max + '"' +
        (f.ac ? ' autocomplete="' + f.ac + '"' : '') + ' spellcheck="false" data-acct-skip="1" value="' + esc(p[f.k] || '') + '"></div>';
    }).join('') + '</div>';
  }
  // readProfile(prefix, root?) → the cleaned profile of the fields on screen (root: a container to search in, for the
  // provider dialog's nodes), or null when the fields are not there
  function readProfile(prefix, root) {
    var get = function (id) { try { return root && root.querySelector ? root.querySelector('#' + id) : $(id); } catch (e) { return null; } };
    if (!get(prefix + '_pf_fullName')) return null;
    var raw = {};
    PROFILE_FIELDS.forEach(function (f) { var e = get(prefix + '_pf_' + f.k); raw[f.k] = e ? e.value : null; });
    return cleanProfile(raw);
  }
  // the server always sends the profile object (every field null when none was given): an all-empty profile reads as null
  function profile() { var p = current.me && current.me.profile ? cleanProfile(current.me.profile) : null; return p && !profileEmpty(p) ? p : null; }
  // saveProfile(p) → Promise<profile>: PUT /account/profile; the answer replaces the profile of the state
  function saveProfile(p) {
    var body = cleanProfile(p);
    if (!body) return Promise.reject(new AccountError('bad_request', 0, { error: 'bad_request', field: 'profile' }));
    var pp = profileProblem(body);
    if (pp) return Promise.reject(new AccountError('bad_request', 0, { error: 'bad_request', field: 'profile.' + pp.field }));
    return call('PUT', '/account/profile', body).then(function (r) {
      var np = cleanProfile(r.json && r.json.profile) || body;
      if (current.me) current.me.profile = np;
      fire('state', state());
      return np;
    }, handleError);
  }
  var PROFILE_NOTE = 'All optional. It helps us support you and understand who uses the app; you can change or clear it on the Account page at any time.';

  // openSignIn(opts) → Promise<state|null>: resolves with the state once signed in, null when the dialog is closed.
  function openSignIn(opts) {
    opts = opts || {};
    if (!HAS_DOC) return Promise.resolve(null);
    if (current.status === 'signedIn' && !opts.force) return Promise.resolve(state());
    return new Promise(function (resolve) {
      if (dlg.resolve) { var old = dlg.resolve; dlg.resolve = null; old(null); }
      openDialog('signin');
      dlg.resolve = resolve;
      // opts.welcome: the first-open form (one dialog, never a second modal over it); any other open is the ordinary form
      dlg.welcome = !!opts.welcome; dlg.welcomeChoice = null;
      dlg.signup = !!opts.signup;
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
      '<div class="acct-field"><label for="acct_code">Code</label><input type="text" id="acct_code" class="acct-code-in" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="12345678"></div>' +
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
    var method = current.authMethod || (current.me && current.me.session && current.me.session.authMethod) || null;   // captured now: setState below clears it before WP-O's hook runs
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
            if (typeof hooks.onPublicSignOut === 'function') { try { return Promise.resolve(hooks.onPublicSignOut({ authMethod: method })).then(state); } catch (e) { /* WP-O */ } }
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

  // changeEmail() with no address (the Sign-in methods card, the provider dialog): never a request with an empty address — the
  // account page's "Change e-mail address" field gets the focus instead (sweep finding: it used to answer 400 silently)
  function focusChangeEmail() {
    var go = function () { var e = $('acct_new_email'); if (!e) return; try { if (e.scrollIntoView) e.scrollIntoView({ block: 'center' }); e.focus(); } catch (x) { /* focus */ } };
    if (!$('acct_new_email') && G.WTS_accountPage && typeof G.WTS_accountPage.open === 'function') { try { G.WTS_accountPage.open(); } catch (x) { /* none */ } }
    go();
  }
  function changeEmail(newEmail) {
    if (newEmail == null || String(newEmail).trim() === '') { focusChangeEmail(); return Promise.resolve(false); }
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
  // The chip lives at the bottom-left of the screen: the host's #wts_account_host (H8) is moved into the sidebar footer's
  // #sbAccountLine (H9) at the mount, full sidebar width (the footer is made sticky, so the chip stays on screen when the nav
  // scrolls; at phone width it is the bottom row of the slide-out drawer). A host without #sbAccountLine keeps the chip in the
  // header (.page-actions) as before.
  function ensureHost() {
    if (!HAS_DOC) return null;
    var host = $('wts_account_host');
    if (!host) {
      var pa = document.querySelector ? document.querySelector('.page-actions') : null;
      if (!pa) return null;
      host = document.createElement('div'); host.id = 'wts_account_host'; host.setAttribute('data-acct-created', '1');
      pa.insertBefore(host, pa.firstChild);
    }
    var line = $('sbAccountLine');
    if (line && host.parentNode !== line) { line.appendChild(host); }
    if (line && host.parentNode === line && host.className !== 'acct-host-sb') host.className = 'acct-host-sb';
    return host;
  }
  function inSidebar() { var h = $('wts_account_host'); return !!(h && h.className === 'acct-host-sb'); }
  function renderChip() {
    if (!mounted || !HAS_DOC) return;
    var host = ensureHost(); if (!host) return;
    var closeMenu = $('acct_menu'); if (closeMenu && closeMenu.parentNode) closeMenu.parentNode.removeChild(closeMenu);
    if (current.status === 'signedOut' || current.status === 'signingIn') {
      host.innerHTML = '<span class="acct-wrap"><button type="button" class="acct-chip acct-chip--out" id="acct_chip" aria-label="Sign in" title="Sign in or create a free account to keep your projects in the cloud">' +
        '<span aria-hidden="true">&#9729;</span><span class="acct-txt">Sign in / Sign up</span></button></span>';
      $('acct_chip').addEventListener('click', function () { openSignIn(); });
      return;
    }
    var info = chipInfo();
    var h = readHint() || {};
    var initial = esc((current.user && current.user.emailMasked ? current.user.emailMasked[0] : h.initial || '?').toUpperCase());
    host.innerHTML = '<span class="acct-wrap"><button type="button" class="acct-chip" id="acct_chip" aria-haspopup="menu" aria-expanded="false" title="' + esc(info.title) + '">' +
      '<span class="acct-init" aria-hidden="true">' + initial + '</span><span class="acct-dot acct-dot--' + info.cls + '" aria-hidden="true"></span>' +
      '<span class="acct-txt" id="acct_chip_txt" aria-live="polite">' + esc(info.text) + '</span>' +
      (inSidebar() ? '<span class="acct-caret" aria-hidden="true">&#9652;</span>' : '') + '</button></span>';
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
      { id: 'acct_m_admin', label: 'Admin dashboard', run: openAdminPage, when: isAdmin() },
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
    if (inSidebar()) placeMenuUp(m, $('acct_chip'));
    $('acct_chip').setAttribute('aria-expanded', 'true');
    m.addEventListener('keydown', function (ev) {
      if (ev && ev.key === 'Escape') { closeMenu(); var c = $('acct_chip'); try { if (c && c.focus) c.focus(); } catch (e) { /* none */ } }
    });
    items.forEach(function (it) {
      $(it.id).addEventListener('click', function () {
        closeMenu();
        it.run();
      });
    });
    var f = $(items[0].id); try { if (f && f.focus) f.focus(); } catch (e) { /* none */ }
  }
  function closeMenu() {
    var mm = $('acct_menu'); if (mm && mm.parentNode) mm.parentNode.removeChild(mm);
    var c = $('acct_chip'); if (c) c.setAttribute('aria-expanded', 'false');
  }
  // The menu of the sidebar chip opens UPWARD from the bottom-left. It is position:fixed (the sidebar is a scroll container and
  // would clip an absolute menu), left-aligned with the chip, at least 240 px wide but never wider than the window, and its
  // height is capped by the room above the chip (it scrolls inside).
  function placeMenuUp(m, chip) {
    m.className = 'acct-menu acct-menu--up rp-skip';
    var r = null;
    try { r = chip && chip.getBoundingClientRect ? chip.getBoundingClientRect() : null; } catch (e) { r = null; }
    var vw = Number(G.innerWidth) || 0, vh = Number(G.innerHeight) || 0;
    if (!r || !vw || !vh || !(r.width > 0)) { m.style.bottom = '64px'; m.style.left = '16px'; return; }
    var w = Math.min(Math.max(r.width, 240), vw - 16);
    var left = Math.max(8, Math.min(r.left, vw - w - 8));
    m.style.left = Math.round(left) + 'px';
    m.style.width = Math.round(w) + 'px';
    m.style.bottom = Math.round(Math.max(8, vh - r.top + 6)) + 'px';
    m.style.maxHeight = Math.round(Math.max(120, r.top - 14)) + 'px';
  }
  function isAdmin() { return current.status === 'signedIn' && !!(current.me && current.me.admin === true); }
  function openAdminPage() {
    var P = G.WTS_accountAdmin;
    if (P && typeof P.open === 'function') return P.open();
    return null;
  }
  // passkeys are named only when the account has any (Phase 1 has none: they answer 501)
  function recentMethodsText() {
    var me = current.me || {};
    return (me.passkeys && me.passkeys.length ? 'passkeys and ' : '') + 'Google / LinkedIn links';
  }
  function signOutEverywhereAsk() {
    return choose({ title: 'Sign out everywhere', text: 'Sign out of every browser and device that uses your account? This one is signed out too.',
      html: '<label class="acct-tick"><input type="checkbox" id="acct_recent_methods"> Also remove ' + recentMethodsText() + ' added in the last 14 days</label>',
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
    if (e.code === 'upgrade') return 'Reload to update the app. Your work is saved on this device.';
    if (e.code === 'bad_request') return 'Please check what you entered and try again. Your work is saved on this device.';
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
    } else if ((current.status === 'unavailable' || current.status === 'signedIn') && current.reason === 'outage') {
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

  // ── first-open sign-in (signed-out visitors) ───────────────────────────────────────────────────────────────────────
  // On a first signed-out visit the sign-in dialog itself opens in its welcome form (title "Sign in to keep your work safe",
  // the value line, Google / LinkedIn, the e-mail code and "Use as guest"): one dialog, never a second modal. Shown once per
  // visit at most, only while accounts are mounted, signed out with no session hint, after the analytics consent banner and the
  // Terms notice are dealt with (never stacked over them; re-checked on their own events, no timer), never on the account /
  // admin / privacy / terms / help / release-notes routes, never over another account dialog, and to a visitor who already
  // chose at most once every 30 days. "Use as guest", Esc, × or the backdrop store the guest choice (wtspref_acct_welcome).
  var WELCOME_EVERY = 30 * 24 * 3600 * 1000;
  var WELCOME_SKIP_ROUTES = { account: 1, admin: 1, privacy: 1, terms: 1, help: 1, releasenotes: 1, gaevents: 1 };
  var welcome = { shown: false, wired: false };
  function welcomePref() {
    try { var o = JSON.parse(lsGet(KEYS.welcome) || 'null'); return o && typeof o === 'object' && typeof o.at === 'number' ? o : null; } catch (e) { return null; }
  }
  function currentRoute() {
    try { var P = G.WTS_pageAutosave; if (P && typeof P.page === 'function') return String(P.page() || ''); } catch (e) { /* host */ }
    return '';
  }
  function visibleBlocker(id) { var e = $(id); return !!(e && !e.hidden); }
  function welcomeOpen() { return !!(dlg.open && dlg.welcome && $('acct_dlg_ov')); }
  // welcomeDue() → null when the first-open dialog may open now, else the reason it waits / is skipped
  function welcomeDue() {
    if (!mounted || !HAS_DOC) return 'unmounted';
    if (seams.welcome === false) return 'off';
    if (welcome.shown || welcomeOpen()) return 'shown';
    var h = readHint();
    if (current.status !== 'signedOut' || (h && h.signedIn)) return 'signed-in';
    var p = welcomePref();
    if (p && now() - p.at < WELCOME_EVERY) return 'answered';
    if (dlg.open || $('acct_oauth_dlg')) return 'dialog';
    if (/^#(acct-oauth|account-revert)/.test(String(L.hash || ''))) return 'hash';
    if (WELCOME_SKIP_ROUTES[currentRoute()]) return 'route';
    if (visibleBlocker('wtsConsent')) return 'consent';
    if (visibleBlocker('wtsTermsNote')) return 'terms';
    return null;
  }
  function maybeWelcome() { if (welcomeDue() === null) openWelcome(); return welcomeOpen(); }
  // the follow-ups that re-check: the consent choice (or Esc on the banner), OK on the Terms notice, a page change (one-off
  // listeners on the host's own elements and events; no timer)
  function wireWelcome() {
    if (welcome.wired || !HAS_DOC) return;
    welcome.wired = true;
    if (typeof G.addEventListener === 'function') G.addEventListener('wts:consent-changed', maybeWelcome);
    var cb = $('wtsConsent'); if (cb) cb.addEventListener('keydown', function (ev) { if (ev && ev.key === 'Escape') maybeWelcome(); });
    var ok = $('wtsTermsNoteOk'); if (ok) ok.addEventListener('click', maybeWelcome);
    document.addEventListener('h2oil:pagechange', maybeWelcome);
  }
  // openWelcome() → the overlay: the sign-in dialog in its first-open form
  function openWelcome() {
    if (!HAS_DOC || !document.body || welcomeOpen()) return null;
    if (current.status === 'signedIn') return null;
    welcome.shown = true;
    openSignIn({ welcome: true });
    return $('acct_dlg_ov');
  }
  // closeWelcome(): closes the first-open form while it is still on its entry step (a sign-in under way is left alone)
  function closeWelcome() {
    if (welcomeOpen() && (dlg.step === 'email' || dlg.step == null)) closeDialog(true);
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
    // the browser's own connection events (one-off listeners, no polling): back online → clear a network error and re-read
    // /me once, so the chip and bar never stay at "Cloud unavailable"; offline → re-render (review fix)
    if (typeof G.addEventListener === 'function') {
      G.addEventListener('online', onOnline);
      G.addEventListener('offline', function () { renderChip(); renderBar(); });
    }
    if (h && h.signedIn) refresh().then(null, function () { /* outage handled */ });
    else { current.status = 'signedOut'; wireWelcome(); maybeWelcome(); }
    // a provider return with a fresh hint entry was finished at load by the provider block (WTS_account.oauthReturn, which
    // strips the fragment); a #acct-oauth still here had no hint entry: it is ignored (no request) and removed
    if (String(L.hash || '') === '#acct-oauth') {
      try { if (G.history && G.history.replaceState) G.history.replaceState(null, '', String(L.pathname || '') + String(L.search || '')); } catch (e) { /* none */ }
    }
  }
  function onOnline() {
    var S = sync(); if (S && typeof S._netBack === 'function') S._netBack();
    var h = readHint();
    if (current.status === 'signedIn' || current.status === 'unavailable' || (h && h.signedIn)) {
      refresh().then(function () { renderChip(); renderBar(); }, function () { renderChip(); renderBar(); });
    } else { renderChip(); renderBar(); }
  }
  function openRevert(key) { openDialog('revert', { title: 'Undo an e-mail change' }); setStep('revert', { key: key || '' }); }
  // '#account-revert' or '#account-revert=<key>' (the notice's link) → {key} | null
  function revertHash(h) {
    var m = /^#account-revert(?:=([A-Za-z2-7]{26}))?$/.exec(String(h || ''));
    return m ? { key: (m[1] || '').toUpperCase() } : null;
  }
  function boot() {
    if (!HAS_DOC) return;
    // #account-revert (the notice's link): a user action, no request until submitted; not on a device that opted out (?cloud=0)
    var rh = revertHash(L.hash);
    if (rh && betaEnabled()) {
      // the key leaves the address bar and the history entry at once (it stays only in the dialog's field)
      if (rh.key) { try { if (G.history && G.history.replaceState) G.history.replaceState(null, '', String(L.pathname || '') + String(L.search || '') + '#account-revert'); } catch (e) { /* none */ } }
      var go = function () { ensureCss(); openRevert(rh.key); };
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
    configure: configure, seam: seam, state: state, call: call, providers: providers, on: on, off: off, betaEnabled: betaEnabled, enabled: betaEnabled,
    refresh: refresh, openSignIn: openSignIn, signOut: signOut, stepUp: stepUp, withStepUp: withStepUp,
    changeEmail: changeEmail, confirmEmail: confirmEmail, setRecovery: setRecovery, confirmRecovery: confirmRecovery, removeRecovery: removeRecovery,
    cancelDeletion: cancelDeletion, revertEmail: revertEmail, openRevert: openRevert, mount: mount, isAdmin: isAdmin,
    profile: profile, saveProfile: saveProfile, cleanProfile: cleanProfile, countryName: countryName, countries: countries,
    welcome: { due: welcomeDue, maybe: maybeWelcome, open: openWelcome, close: closeWelcome, pref: welcomePref, EVERY: WELCOME_EVERY },
    addPasskey: notYet('addPasskey'), removePasskey: notYet('removePasskey'), renamePasskey: notYet('renamePasskey'),
    // signInWith, finishProviderSignIn, methods, linkProvider, unlinkMethod, providerSignOutNeeded, oauthReturn, oauthUI:
    // the provider block below (WP-O)
    // shared internals for 67 / 68 and WP-O (not a public contract)
    _i: { completeSignIn: completeSignIn, choose: choose, setStep: setStep, message: message, openDialog: openDialog, closeDialog: closeDialog,
      readHint: readHint, writeHint: writeHint, recentMethodsText: recentMethodsText, handleError: handleError, errText: errText, cloudErrText: cloudErrText, esc: esc, toast: toast,
      signedOutLocal: signedOutLocal, renderChip: renderChip, renderBar: renderBar, cloudAction: cloudAction, isOnline: isOnline, now: now,
      deviceLabel: deviceLabel, isOutage: isOutage, ensureCss: ensureCss, appVer: appVer, dialogOpen: function () { return dlg.open; },
      profileFormHtml: profileFormHtml, readProfile: readProfile, profileEmpty: profileEmpty, PROFILE_FIELDS: PROFILE_FIELDS, PROFILE_NOTE: PROFILE_NOTE,
      profileProblem: profileProblem, profileErrText: profileErrText, isProfileErr: isProfileErr },
  };
  G.WTS_account = api;

  // ── WP-O: provider sign-in — Google and LinkedIn (docs/ACCOUNTS-PLAN.md §4.10–4.15, §5.2, §5.5, §11.2, §11.3) ─────────────
  // One contiguous block (WP-C1 owns the rest of this file). It defines signInWith, finishProviderSignIn, methods,
  // linkProvider and unlinkMethod, fills WP-C1's mount points (hooks.renderProviders under the e-mail step,
  // hooks.onPublicSignOut after a public sign-out, the account page's hooks.renderMethods through 68), completes a sign-in
  // through WP-C1's completeSignIn (device id, hint, /me, hand-over and migration, the analytics reload) and adds:
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
    // the size is inline (the same for both providers wherever the buttons are drawn); the look — a neutral dark button with the
    // provider's own mark in a fixed icon column, the label centred — is the .acct-prov-btn rule of ensureCss (WP-C1)
    var BTN_STYLE = 'width:100%;min-height:44px;box-sizing:border-box';

    // label(p, signup): "Sign in with Google" — "Sign up with …" on the dialog's create-account path (the providers' own wording)
    function label(p, signup) { return (signup ? 'Sign up with ' : 'Sign in with ') + NAME[p]; }
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
    function offline() { return !isOnline(); }
    // a reauth answer runs the public WTS_account.stepUp (the code step-up of WP-C1; tests may replace it), then repeats once
    function stepUpThen(fn, reason) {
      return Promise.resolve().then(fn).then(null, function (e) {
        if (!e || e.code !== 'reauth') throw e;
        return Promise.resolve(api.stepUp({ reason: reason })).then(function (ok) {
          if (ok === false || ok === null) throw new AccountError('cancelled', 0, null);
          return fn();
        });
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
    api.linkProvider = function (p) { return stepUpThen(function () { return startProvider(p, 'link', {}); }, 'Adding a sign-in method needs a fresh confirmation.'); };

    var TERMINAL = ['oauth_state', 'oauth_failed', 'locked', 'not_invited', 'signup_closed', 'identity_in_use', 'provider_linked', 'provider_off', 'paused'];
    // POST finish (first call with {}; later {email} | {code} | {consent}) → the server's answer; done signs the page in
    api.finishProviderSignIn = function (body) {
      return call('POST', '/auth/oauth/finish', body || {}).then(function (r) {
        var j = r.json || {};
        if (j.next === 'done' && j.linked) { dropOauth(); return j; }
        if (j.next !== 'done') return j;
        // the session cookie is set: WP-C1's completion (its own dialog may ask the hand-over question, so this one closes
        // first; the providerEmailDiffers note reopens it afterwards)
        closeDialog();
        return completeSignIn(j, { method: j.method }).then(function () { return j; }, function () { return j; });
      }, function (e) {
        if (e && TERMINAL.indexOf(e.code) !== -1) dropOauth();
        throw e;
      });
    };
    api.methods = function () { return call('GET', '/auth/methods').then(function (r) { return r.json; }); };
    api.unlinkMethod = function (id) {
      return stepUpThen(function () { return call('POST', '/auth/methods/unlink', { id: id }); }, 'Removing a sign-in method needs a fresh confirmation.').then(function (r) { return r.json; });
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
        // only with ACCOUNTS_SIGNUP=invite on the server (sign-up is open on the live site since release 4.2)
        not_invited: 'New accounts are by invitation only right now. Sign in with the address you were invited with, or use the e-mail code.',
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
    function providerButton(p, purpose, onPress, signup) {
      var b = el('button', { type: 'button', 'class': 'acct-prov-btn', 'data-provider': p, 'data-purpose': purpose, 'aria-label': label(p, signup), style: BTN_STYLE });
      try { ensureCss(); } catch (e) { /* none */ }
      var mark = el('span', { 'class': 'acct-prov-mark', 'aria-hidden': 'true', style: 'display:inline-flex;width:20px;height:20px' });
      mark.innerHTML = ASSETS[p];                          // a constant asset, never data
      b.appendChild(mark);
      b.appendChild(el('span', { 'class': 'acct-prov-label', text: label(p, signup) }));
      b.onclick = onPress;
      return b;
    }
    function statusLine(host, msg) {
      var s = host.querySelector('.acct-prov-status');
      if (!s) { s = el('div', { 'class': 'acct-prov-status', role: 'status', 'aria-live': 'polite', style: 'margin:4px 0 8px 0;font-size:14px' }); host.appendChild(s); }
      s.textContent = msg || '';
      return s;
    }

    // The two provider buttons for the sign-in dialog (WP-C1's e-mail step mounts it through hooks.renderProviders). Asks
    // GET /auth/providers first (a user action); 'off' hides a button, 'signin' labels it "existing accounts only".
    // o.publicDevice: the dialog's tick. → Promise<{google, linkedin}> (the states drawn)
    function renderButtons(host, o) {
      o = o || {};
      if (!host || !doc()) return Promise.resolve(null);
      host.textContent = '';
      var fresh = !!o.publicDevice || sharedBrowser();
      return (o.states ? Promise.resolve(o.states) : api.providers()).then(function (st) {
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
          }, !!o.signup));
          if (st[p] === 'signin') wrap.appendChild(el('div', { 'class': 'acct-prov-note', text: 'existing accounts only', style: 'margin:-4px 0 8px 0;font-size:13px' }));
        });
        var any = !!wrap.querySelector('.acct-prov-btn');
        if (fresh && any) {
          wrap.appendChild(el('div', { 'class': 'acct-prov-note acct-prov-public', style: 'font-size:13px;margin:0 0 8px 0',
            text: 'You will also be signed in to Google / LinkedIn in this browser — sign out of it too when you finish.' }));
        }
        // o.compact (the sign-in dialog, whose e-mail field follows right below): no "use the e-mail code" line
        if (any && !o.compact) {
          var drawnNames = PROVIDERS.filter(function (p) { return !!wrap.querySelector('.acct-prov-btn[data-provider="' + p + '"]'); })
            .map(function (p) { return NAME[p]; });
          wrap.appendChild(el('div', { 'class': 'acct-prov-note', style: 'font-size:13px', text: "Can't use " + drawnNames.join(' or ') + '? Use the e-mail code.' }));
        }
        if (offline()) Array.prototype.forEach.call(wrap.querySelectorAll('.acct-prov-btn'), function (b) { b.disabled = true; b.setAttribute('title', 'needs a connection'); });
        host.appendChild(wrap);
        return st;
      });
    }

    // ── the finish dialog (the return from the provider) ──
    // This div keeps the focus rules of §11.2 itself: focus moves into it, Tab stays inside it, and closing returns focus to
    // the control that was focused before it opened. A done sign-in closes it before WP-C1's completion, whose own dialog asks
    // the hand-over question.
    var dlg = null; var dlgOpener = null; var dlgEscape = true;
    function focusables() {
      return dlg ? Array.prototype.filter.call(dlg.querySelectorAll('button, input, select'), function (n) { return !n.disabled; }) : [];
    }
    function dlgKey(ev) {
      if (!ev) return;
      if (ev.key === 'Escape' && dlgEscape) { closeDialog(); return; }
      if (ev.key !== 'Tab') return;
      var f = focusables(); if (!f.length) return;
      var i = f.indexOf(doc().activeElement);
      var n = ev.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === -1 || i === f.length - 1 ? 0 : i + 1);
      if (ev.preventDefault) ev.preventDefault();
      try { f[n].focus(); } catch (e) { /* focus */ }
    }
    function dialog() {
      var d = doc();
      if (!d || !d.body) return null;
      if (dlg && dlg.isConnected) return dlg;
      dlgOpener = d.activeElement && d.activeElement !== d.body ? d.activeElement : null;
      dlgEscape = true;
      // the same look as the sign-in dialog (#acct_dlg): its overlay and box classes and theme tokens (review fix)
      try { ensureCss(); } catch (e) { /* none */ }
      dlg = el('div', { id: 'acct_oauth_dlg', 'class': 'acct-ov acct-ov--modal acct-oauth-dlg rp-skip', 'data-rp-nosnap': '1', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'acct_oauth_title' });
      var box = el('div', { 'class': 'acct-dlg acct-modal acct-oauth-box' });
      box.appendChild(el('div', { 'class': 'acct-hd' }, [el('h2', { id: 'acct_oauth_title', 'class': 'acct-title', text: 'Sign in' })]));
      box.appendChild(el('div', { id: 'acct_oauth_body', 'class': 'acct-body' }));
      dlg.appendChild(box);
      dlg.onkeydown = dlgKey;
      d.body.appendChild(dlg);
      return dlg;
    }
    function closeDialog() {
      if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
      dlg = null;
      var o = dlgOpener; dlgOpener = null;
      try { if (o && o.isConnected !== false && typeof o.focus === 'function') o.focus(); } catch (e) { /* focus return */ }
    }
    function dbody() { var d = dialog(); return d ? d.querySelector('#acct_oauth_body') : null; }
    // the heading names the step (never "Sign in" on the blocking public sign-out step)
    function title(t) { var d = dialog(); var h = d && d.querySelector('#acct_oauth_title'); if (h) h.textContent = t; }
    function para(cls, txt, extra) { return el('p', Object.assign({ 'class': cls, text: txt }, extra || {})); }
    // full-width stacked 44 px buttons in the modal card (.acct-modal .btn); on the account page's methods card the same size
    function btn(id, txt, primary, fn) {
      return el('button', { type: 'button', id: id, 'class': primary ? 'btn btn-primary' : 'btn btn-secondary', onclick: fn,
        style: 'min-height:44px;font-size:16px', text: txt });
    }
    function show(nodes) {
      var b = dbody(); if (!b) return;
      b.textContent = ''; nodes.forEach(function (n) { if (n) b.appendChild(n); });
      var f = b.querySelector('input') || b.querySelector('.btn-primary') || b.querySelector('button');   // focus moves into the step
      try { if (f && typeof f.focus === 'function') f.focus(); } catch (e) { /* focus */ }
    }
    function showError(msg) {
      show([el('p', { 'class': 'acct-oauth-error', role: 'alert', text: msg }),
        el('p', { style: 'font-size:13px', text: 'Use the e-mail code instead: a one-time code sent to your e-mail address.' }),
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
        showError(api._i.isProfileErr(e) ? api._i.profileErrText(e) : text(e && e.code, p, e && e.body && e.body.reason));
        return { error: e && e.code };
      });
    }
    function step(p, j, oa) {
      var N = NAME[p] || '';
      if (j.next === 'done') {
        if (j.linked) {
          restoreRoute(oa);                                  // back to the page the link started from (the account page)
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
        title('Confirm your e-mail address');
        var inp = el('input', { id: 'acct_oauth_email', type: 'email', inputmode: 'email', autocomplete: 'email', style: 'width:100%;box-sizing:border-box;font-size:16px;min-height:44px' });
        inp.value = j.emailPrefill || '';
        show([para('acct-oauth-msg', (j.reason === 'missing' ? N + ' did not share an e-mail address. ' : '') + 'Confirm the e-mail address for this account — we will send a code to it.'),
          el('label', { 'for': 'acct_oauth_email', text: 'E-mail address' }), inp,
          btn('acct_oauth_send', 'Send code', true, function () { drive(p, { email: String(inp.value || '').trim() }, oa); })]);
        return j;
      }
      if (j.next === 'code') {
        title(j.reason === 'link_confirm' ? 'Confirm adding ' + N : j.reason === 'cancel_deletion' ? 'Cancel the account deletion' : 'Confirm your e-mail address');
        var ci = el('input', { id: 'acct_oauth_code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '9', style: 'width:100%;box-sizing:border-box;font-size:16px;min-height:44px;letter-spacing:2px' });
        show([para('acct-oauth-msg', codeText(j.reason, j.emailMasked, p), { 'data-reason': j.reason || 'verify', 'data-masked': j.emailMasked || '' }),
          el('label', { 'for': 'acct_oauth_code', text: 'Code' }), ci,
          btn('acct_oauth_verify', 'Continue', true, function () {
            var reason = j.reason;
            drive(p, { code: String(ci.value || '').replace(/\s/g, '') }, oa).then(function (r) {
              if (reason === 'cancel_deletion' && r && r.next === 'done') offerCancelDeletion();
            });
          }),
          btn('acct_oauth_close', 'Close', false, function () { dropOauth(); closeDialog(); }),
          // no resend in this step (open item): the way to a new code is a new start with the provider
          el('p', { 'class': 'acct-oauth-help', style: 'font-size:13px', text: "Didn't get the code? It can take a minute — check your spam or junk folder. A code works for 15 minutes and 5 tries. For a new code, close this and choose " + (N || 'the provider') + ' again.' })]);
        return j;
      }
      if (j.next === 'consent') {
        // the versions come from the server; without them nothing is sent (never made-up versions)
        if (typeof j.terms !== 'string' || !j.terms || typeof j.privacy !== 'string' || !j.privacy) { showError(text('server', p)); return j; }
        var c = { terms: j.terms, privacy: j.privacy };
        if (j.existingAccount) {
          // an existing account on older Terms / Privacy versions (review fix): accept the current ones to finish signing in
          title('Updated Terms and Privacy notice');
          var rtick = el('input', { type: 'checkbox', id: 'acct_oauth_consent_ok' });
          var rerr = el('p', { 'class': 'acct-oauth-error', role: 'alert', style: 'margin:8px 0 0 0' });
          show([para('acct-oauth-reconsent', 'The Terms of Use or the Privacy notice changed since you last accepted them. Please read the current versions to keep signing in with ' + N + '.'),
            el('label', { 'class': 'acct-tick', 'for': 'acct_oauth_consent_ok' }, [rtick, el('span', {}, [el('span', { text: ' I accept the ' }),
              el('a', { href: 'terms.html', target: '_blank', rel: 'noopener', id: 'acct_oauth_terms_link', text: 'Terms of Use' }),
              el('span', { text: ' (version ' + j.terms + ') and have read the ' }),
              el('a', { href: 'privacy.html', target: '_blank', rel: 'noopener', id: 'acct_oauth_privacy_link', text: 'Privacy notice' }),
              el('span', { text: ' (version ' + j.privacy + ').' })])]),
            rerr,
            btn('acct_oauth_create', 'Accept and continue', true, function () {
              if (!rtick.checked) { rerr.textContent = 'Please tick the box to accept the current Terms of Use and Privacy notice.'; return; }
              drive(p, { consent: c }, oa);
            }),
            btn('acct_oauth_cancel', 'Cancel', false, function () { dropOauth(); closeDialog(); })]);
          return j;
        }
        title('Create your account');
        // the same explicit tick as the e-mail path, naming the versions (review fix): Create is refused until it is ticked
        var tick = el('input', { type: 'checkbox', id: 'acct_oauth_consent_ok' });
        var cerr = el('p', { 'class': 'acct-oauth-error', role: 'alert', style: 'margin:8px 0 0 0' });
        // the optional profile (user insight): the shared markup (every value escaped), read back on Create
        var pfs = el('fieldset', { 'class': 'acct-pf-set' });
        pfs.innerHTML = '<legend>About you <span class="acct-opt">(optional)</span></legend><p class="acct-note">' + esc(api._i.PROFILE_NOTE) + '</p>' +
          api._i.profileFormHtml('acct_oauth_su', null, { countryHint: j.countryHint });
        show([para('acct-oauth-consent', 'You are creating a new account for ' + j.newAccountEmailMasked + '. Already have an account with another address? Sign in with it, then add ' + N + ' under Account → Sign-in methods.'),
          pfs,
          el('label', { 'class': 'acct-tick', 'for': 'acct_oauth_consent_ok' }, [tick, el('span', {}, [el('span', { text: ' I am 18 or over. I accept the ' }),
            el('a', { href: 'terms.html', target: '_blank', rel: 'noopener', id: 'acct_oauth_terms_link', text: 'Terms of Use' }),
            el('span', { text: ' (version ' + j.terms + ') and have read the ' }),
            el('a', { href: 'privacy.html', target: '_blank', rel: 'noopener', id: 'acct_oauth_privacy_link', text: 'Privacy notice' }),
            el('span', { text: ' (version ' + j.privacy + ').' })])]),
          cerr,
          btn('acct_oauth_create', 'Create account', true, function () {
            if (!tick.checked) { cerr.textContent = 'Please tick the box to confirm you are 18 or over and accept the Terms of Use and the Privacy notice.'; return; }
            var pf = api._i.readProfile('acct_oauth_su', pfs);
            // the optional profile is checked by the server's rules first, so it can never block the account (review fix)
            var pp = api._i.profileProblem(pf);
            if (pp) { cerr.textContent = pp.text; return; }
            drive(p, pf && !api._i.profileEmpty(pf) ? { consent: c, profile: pf } : { consent: c }, oa);
          }),
          btn('acct_oauth_cancel', 'Cancel', false, function () { dropOauth(); closeDialog(); })]);
        return j;
      }
      showError(text('server', p));
      return j;
    }
    function offerCancelDeletion() {
      title('Cancel the account deletion');
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
        title('Sign out of ' + N);
        show([el('p', { 'class': 'acct-oauth-signout', text: 'Now sign out of ' + N + ' in this browser: open ' + N + ', choose your account picture or name, then Sign out. This computer is shared, so the next person must not find you signed in there.' }),
          btn('acct_oauth_signedout', 'I have signed out', true, function () { closeDialog(); resolve(true); })]);
        dlgEscape = false;                                   // Escape does not close it; Tab still stays inside
      });
    }

    // The Sign-in methods card of the account page (68 delegates here): e-mail (always), recovery, Google, LinkedIn, passkeys.
    function fmtDate(s) { try { return s ? new Date(s).toISOString().slice(0, 10) : '—'; } catch (e) { return '—'; } }
    function renderMethods(host) {
      if (!host || !doc()) return Promise.resolve(null);
      host.textContent = '';
      // filled into the account page's own "Sign-in methods" card (68): no second card, title or note (review fix)
      var card = el('div', { 'class': 'acct-methods', id: 'acct_methods' });
      host.appendChild(card);
      var list = el('div', { 'class': 'acct-methods-list' });
      card.appendChild(list);
      var msg = el('div', { 'class': 'acct-methods-msg', role: 'status', 'aria-live': 'polite', style: 'font-size:14px;margin-top:6px' });
      return Promise.all([api.methods(), api.providers().catch(function () { return { google: 'off', linkedin: 'off' }; })]).then(function (r) {
        var m = r[0] || {}; var st = r[1] || {};
        function row(title, detail, actions, p) {
          var d = el('div', { 'class': 'acct-method-row', 'data-method': p || title, style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border,#3a3a3a)' });
          d.appendChild(el('div', { style: 'flex:1 1 220px' }, [el('div', { 'class': 'acct-method-title', text: title, style: 'font-weight:600' }), el('div', { 'class': 'acct-method-detail', text: detail, style: 'font-size:14px' })]));
          var a = el('div', { 'class': 'acct-method-actions', style: 'flex:1 1 200px' });
          (actions || []).forEach(function (x) { if (x) a.appendChild(x); });
          d.appendChild(a);
          list.appendChild(d);
          return a;
        }
        row('E-mail code', ((m.email && m.email.masked) || '') + ' — always on', [typeof api.changeEmail === 'function' ? btn('acct_m_email', 'Change e-mail', false, function () { msg.textContent = 'Type the new address under "Change e-mail address" in Profile and security, then send the code.'; api.changeEmail().catch(function () {}); }) : null], 'email');
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
    // WP-C1 mount points
    hooks.renderProviders = function (host, states, ctx) { return renderButtons(host, { publicDevice: !!(ctx && ctx.publicDevice), states: states, compact: !!(ctx && ctx.compact), signup: !!(ctx && ctx.signup) }); };
    hooks.onPublicSignOut = function (info) {
      var p = info && info.authMethod;
      return PROVIDERS.indexOf(p) !== -1 ? providerSignOutStep(p) : null;
    };
    // the provider return is handled at load (the fragment is stripped here, so the later mount does not see it again)
    if (L.hash === '#acct-oauth') api.oauthReturn();
  }
  boot();
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  // pure checks only (stripped by concat): the guard leaves an ineligible stub in a plain node context
  var G = (typeof window !== 'undefined') ? window : globalThis;
  if (G.WTS_account && G.WTS_account.eligible === false && Object.keys(G.WTS_account).length !== 1) throw new Error('66 self-test: ineligible stub');
})();
