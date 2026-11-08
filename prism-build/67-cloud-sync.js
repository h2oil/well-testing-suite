// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/67-cloud-sync.js — WTS_cloudSync: cloud projects and sync (docs/ACCOUNTS-PLAN.md §5.2, §6, §10). Round-10.
//
// WP0 FOUNDATION SKELETON. Same guard as 66 (production https host or DEV localhost, no native shell, not framed); outside
// it WTS_cloudSync is not defined at all. Inside it nothing runs at load: no IndexedDB open, no listener, no timer, no
// request. status() reports 'off'. Implemented now: canonical(v) and sha256Hex(text) — the canonical JSON and hash that
// server/core/canon.js defines (parts are content-addressed by them, D5); the contract test checks both against the shared
// reference vectors. Every other planned name is a stub that rejects with Error code 'not_implemented' (WP-C1, WP-C2).
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
  if (!ELIGIBLE) return;

  var VERSION = '0.1.0-wp0';

  // Canonical JSON (keys sorted by UTF-16 code units, no whitespace, JSON.stringify numbers and strings, undefined members
  // dropped, undefined array items → null, non-finite numbers refused) — identical to server/core/canon.js.
  function canonical(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'number') { if (!isFinite(v)) throw new Error('canon: non-finite number'); return JSON.stringify(v); }
    if (t === 'boolean' || t === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(function (x) { return x === undefined ? 'null' : canonical(x); }).join(',') + ']';
    if (t === 'object') {
      var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
      return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
    }
    throw new Error('canon: unsupported type ' + t);
  }
  function utf8(s) {
    if (typeof G.TextEncoder === 'function') return new G.TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)); var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  // sha256Hex(text | Uint8Array) → Promise<64 lowercase hex>. Crypto: the seam WTS_account.configure({crypto}) when set (an
  // object with .subtle, or a SubtleCrypto-like object with .digest), else window.crypto.subtle.
  function subtle() {
    var A = G.WTS_account; var s = A && typeof A.seam === 'function' ? A.seam('crypto') : null;
    if (s && s.subtle && typeof s.subtle.digest === 'function') return s.subtle;
    if (s && typeof s.digest === 'function') return s;
    return G.crypto && G.crypto.subtle;
  }
  function sha256Hex(data) {
    var c = subtle();
    if (!c) return Promise.reject(new Error('sha256: no crypto.subtle'));
    var bytes = typeof data === 'string' ? utf8(data) : data;
    return Promise.resolve(c.digest('SHA-256', bytes)).then(function (buf) {
      var a = new Uint8Array(buf); var s = '';
      for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return s;
    });
  }

  function notYet(name) {
    return function () {
      var E = G.WTS_account && G.WTS_account.Error;
      var e = E ? new E('not_implemented', 0, { error: 'not_implemented', message: name + ' is not built yet' }) : new Error('not_implemented');
      if (!E) e.code = 'not_implemented';
      return Promise.reject(e);
    };
  }
  function status() {
    return { state: 'off', projectId: null, name: null, baseRev: null, lastSyncAt: null, pending: 0, error: null };
  }
  var names = ['link', 'unlink', 'saveToCloud', 'openFromCloud', 'importFiles', 'syncNow', 'listProjects', 'history', 'restoreRevision',
    'conflicts', 'resolve', 'diff', 'snapshot', 'migrateLocal', 'wipeDevice', 'historianBackup', 'historianRestore', 'exportAll'];
  var api = { VERSION: VERSION, status: status, canonical: canonical, sha256Hex: sha256Hex };
  names.forEach(function (n) { api[n] = notYet(n); });
  G.WTS_cloudSync = api;
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  // pure checks only (stripped by concat)
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var S = G.WTS_cloudSync;
  if (S && S.canonical({ b: 2, a: [1, undefined], c: undefined }) !== '{"a":[1,null],"b":2}') throw new Error('67 self-test: canonical');
})();
