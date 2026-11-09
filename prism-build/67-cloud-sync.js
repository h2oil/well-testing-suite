// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/67-cloud-sync.js — WTS_cloudSync: cloud projects (docs/ACCOUNTS-PLAN.md §5.2, §6, §7, §10). Round-10.
//
// Same guard as 66 (production https host or DEV localhost, no native shell, not framed); outside it WTS_cloudSync is not
// defined at all. Phase 1 (WP-C1): the device store 'wts-sync' (IndexedDB, memory fallback), the ownership record, the
// snapshot (§6.1: payload → per-well parts + a small core, canonical JSON, SHA-256 hash and the normalised vhash), assemble
// (the inverse: an ordinary .h2oilproj v1.0 payload that v3.4 opens), manual Save to cloud (inline core ≤ 48 kB gzip, missing
// blobs uploaded in 4 MB chunks, 422 path, the Phase 1 409 choice), Open from cloud (push first when changed, refused when
// offline and changed, safety snapshot, verified download with the size cap, load with source 'cloud'), list / history /
// restore / rename / duplicate / trash / purge / download, Import files to cloud, the account library (union), the §10
// migration and hand-over (empty / own / unowned / foreign / unknown, stash, pre-account snapshot, size cap), the
// public-computer wipe (expiry check at load, no timer) and the locked outbox (AES-GCM with the per-user server key, never
// stored). Automatic sync, the merge and conflict copies are Phase 2 (WP-C2): syncNow / conflicts / resolve / diff reject.
//
// Nothing runs at load except the public expiry check (it reads the hint; no request). No polling, no setInterval, no
// function wrapping; the change listeners are attached only while signed in and linked (66 calls _attach / _detach; bindTo,
// unlink and init re-check).
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

  var VERSION = '1.0.0';
  var HAS_DOC = typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';
  var FMT = 2;                                     // commit / core format
  var OUTBOX_FMT = 1;
  var CHUNK = 4 * 1024 * 1024;
  var INLINE_MAX = 48 * 1024;
  var LIFT_MAX = 64000;                            // a key or module over 64 kB becomes a sub-part
  var BULK_MODULES = ['prism_gauges', 'buildup_raw', 'buildup_analysis'];
  var WELL_MODULES = ['wts', 'esdhi', 'esdlo', 'hydrate', 'liquidline', 'pipelife', 'clientinfo', 'pvt', 'prism_dataset', 'prism'];
  var JOB_KEYS = { wts_report_templates: 1, wts_base_conditions: 1, wts_base_auto: 1 };
  var DERIVED_KEYS = { wts_report_snapshots: 1, wts_mw_results: 1 };
  var LIBRARY_RE = /^wts_prism_(user_curves|presets|mapping_)/;
  var DEVICE_PREF_RE = /^(wts_unit_system|wts_prism_sample_suppress|wts_prism_migrated)$|^wts_ui_/;
  var JOB_PART = 'job';                            // well/job/<module>: project-level bulk modules (gauges, build-up)

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
  function A() { return G.WTS_account || null; }
  function I() { var a = A(); return a && a._i ? a._i : null; }
  function AErr(code, extra) {
    var E = A() && A().Error;
    var body = extra ? Object.assign({ error: code }, extra) : { error: code };
    if (E) return new E(code, 0, body);
    var e = new Error(code); e.code = code; e.body = body; return e;
  }
  function call(m, p, b, o) { return A().call(m, p, b, o); }
  function now() { var a = A(); var f = a && a.seam && a.seam('now'); return typeof f === 'function' ? f() : Date.now(); }
  function seam(k) { var a = A(); return a && a.seam ? a.seam(k) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function lsGet(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsRemove(k) {
    try { if (typeof G.WTS_lsRemove === 'function') { G.WTS_lsRemove(k); return; } } catch (e) { /* fall back */ }
    try { if (G.localStorage) G.localStorage.removeItem(k); } catch (e) { /* blocked */ }   /* ls-raw: fallback (no H1 host) */
  }
  function lsSet(k, v) {
    try { if (typeof G.WTS_lsSet === 'function') return G.WTS_lsSet(k, v) !== false; } catch (e) { /* fall back */ }
    try { G.localStorage.setItem(k, v); return true; } catch (e) { return false; }   /* ls-raw: fallback (no H1 host) */
  }
  function lsKeys() {
    var out = []; var ls = G.localStorage; if (!ls) return out;
    try { for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k != null) out.push(k); } } catch (e) { /* blocked */ }
    return out;
  }
  function uuid() {
    try { if (G.crypto && typeof G.crypto.randomUUID === 'function') return G.crypto.randomUUID(); } catch (e) { /* fall back */ }
    var b = randomBytes(16); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = hex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function randomBytes(n) {
    var a = new Uint8Array(n);
    try { G.crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); }
    return a;
  }
  function hex(a) { var s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }
  function u8(x) {
    if (x == null) return new Uint8Array(0);
    if (typeof x === 'string') return utf8(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (typeof x.byteLength === 'number') return new Uint8Array(x);
    return new Uint8Array(0);
  }
  function utf8(s) {
    if (typeof G.TextEncoder === 'function') return new G.TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)); var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function fromUtf8(b) {
    b = u8(b);
    if (typeof G.TextDecoder === 'function') return new G.TextDecoder('utf-8').decode(b);
    var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return decodeURIComponent(escape(s));
  }
  function b64(b) {
    b = u8(b); var s = '';
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.prototype.slice.call(b.subarray(i, i + 0x8000)));
    return G.btoa(s);
  }
  function unb64(s) { var bin = G.atob(String(s || '')); var a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function concat(list) {
    var n = 0; list.forEach(function (x) { n += x.length; });
    var out = new Uint8Array(n); var o = 0;
    list.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }

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
  // sha256Hex(text | bytes) → Promise<64 lowercase hex>. Crypto: the seam WTS_account.configure({crypto}) when set (an object
  // with .subtle, or a SubtleCrypto-like object with .digest), else window.crypto.subtle.
  function subtle() {
    var s = seam('crypto');
    if (s && s.subtle && typeof s.subtle.digest === 'function') return s.subtle;
    if (s && typeof s.digest === 'function') return s;
    return G.crypto && G.crypto.subtle;
  }
  function sha256Hex(data) {
    var c = subtle();
    if (!c) return Promise.reject(new Error('sha256: no crypto.subtle'));
    var bytes = typeof data === 'string' ? utf8(data) : u8(data);
    return Promise.resolve(c.digest('SHA-256', bytes)).then(function (buf) { return hex(new Uint8Array(buf)); });
  }
  function gzip(bytes) {
    var f = seam('gzip');
    if (typeof f === 'function') return Promise.resolve(f(u8(bytes))).then(u8);
    if (typeof G.CompressionStream === 'function' && typeof G.Response === 'function') {
      var s = new G.Response(u8(bytes)).body.pipeThrough(new G.CompressionStream('gzip'));
      return new G.Response(s).arrayBuffer().then(u8);
    }
    return Promise.reject(AErr('unsupported', { message: 'This browser cannot compress data for the cloud.' }));
  }
  function gunzip(bytes) {
    var f = seam('gunzip');
    if (typeof f === 'function') return Promise.resolve(f(u8(bytes))).then(u8);
    if (typeof G.DecompressionStream === 'function' && typeof G.Response === 'function') {
      var s = new G.Response(u8(bytes)).body.pipeThrough(new G.DecompressionStream('gzip'));
      return new G.Response(s).arrayBuffer().then(u8);
    }
    return Promise.reject(AErr('unsupported', { message: 'This browser cannot read cloud data.' }));
  }

  // ── device store 'wts-sync' (IndexedDB kv; memory fallback) ───────────────────────────────────────────────────────
  var mem = {}; var dbP = null; var useMem = false;
  function factory() { return seam('idb') || G.indexedDB || null; }
  function db() {
    if (useMem) return Promise.resolve(null);
    if (dbP) return dbP;
    var f = factory();
    if (!f || typeof f.open !== 'function') return Promise.resolve(null);   // no store (yet): memory for this call only
    dbP = new Promise(function (res) {
      var r;
      try { r = f.open('wts-sync', 1); } catch (e) { useMem = true; res(null); return; }
      r.onupgradeneeded = function () { try { var d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); } catch (e) { /* none */ } };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { useMem = true; res(null); };
    });
    return dbP;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (res, rej) {
        var t; try { t = d.transaction('kv', mode); } catch (e) { useMem = true; res(fn(null)); return; }
        var os = t.objectStore('kv'); var out;
        var r = fn(os);
        t.oncomplete = function () { res(r && r.__req ? r.__req.result : out); };
        t.onerror = function () { rej(t.error || new Error('wts-sync write failed')); };
      });
    });
  }
  function kvGet(k) {
    return tx('readonly', function (os) {
      if (!os) return clone(mem[k]);
      var q = os.get(k); return { __req: q };
    }).then(function (v) { return v === undefined ? null : clone(v); });
  }
  function kvPut(k, v) {
    return tx('readwrite', function (os) { if (!os) { mem[k] = clone(v); return null; } os.put(clone(v), k); return null; }).then(function () { return v; });
  }
  function kvDel(k) { return tx('readwrite', function (os) { if (!os) { delete mem[k]; return null; } os['delete'](k); return null; }); }
  function kvClear() { return tx('readwrite', function (os) { if (!os) { mem = {}; return null; } os.clear(); return null; }); }

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  var S = { device: null, binding: null, base: null, busy: false, error: null, lastSyncAt: null, outbox: null, loaded: false,
    applying: false, snapshotting: false, outboxKey: null };
  var readyP = null;
  function init() {
    if (readyP) return readyP;
    if (!factory()) return Promise.resolve(false);    // no store yet (a test seam not configured): nothing is cached; try later
    // the load-time expiry wipe cleared localStorage while the page scripts were still loading; the project modules that keep
    // client data in IndexedDB (PRiSM gauge records, build-up raw data and tests) register only once the page is ready, so
    // New runs again here (init runs from the mount) before the sync store is cleared
    var first = S.pendingWipe ? Promise.resolve().then(function () { wipeLocalSync({ reason: 'expiry' }); })
      .then(function () { return wipeStores({ reason: 'expiry', historian: true }); }).then(function () { S.pendingWipe = false; }) : Promise.resolve();
    readyP = first.then(function () { return Promise.all([kvGet('device'), kvGet('binding'), kvGet('base'), kvGet('outbox')]); }).then(function (r) {
      S.device = r[0]; S.binding = r[1]; S.base = r[2]; S.outbox = r[3];
      if (!S.device) {
        S.device = { deviceId: null, lastUserId: null, workOwner: hasLocalWork() ? 'unowned' : null, workOwnerAt: now() };
        return kvPut('device', S.device);
      }
    }).then(function () {
      if (S.device && S.device.deviceId && A() && !A().seam('deviceId')) A().configure({ deviceId: S.device.deviceId });
      if (S.binding && S.binding.lastSyncAt) S.lastSyncAt = S.binding.lastSyncAt;
      S.loaded = true;
      attach();   // 66 may have asked before the binding was read: listen now if signed in and linked
      return true;
    }, function () { S.loaded = true; return true; });
    return readyP;
  }
  function saveDevice() { return kvPut('device', S.device); }
  function saveBinding() { return S.binding ? kvPut('binding', S.binding) : kvDel('binding'); }
  function signedInUser() { var a = A(); var s = a && a.state(); return s && s.status === 'signedIn' ? s.user : null; }
  function linkedFor(user) { return !!(S.binding && user && S.binding.userId === user.id && S.binding.projectId); }

  function status() {
    var a = A(); var s = a ? a.state() : { status: 'signedOut' };
    var b = S.binding;
    var out = { state: 'off', projectId: b ? b.projectId : null, name: b ? b.name : null, baseRev: b ? b.baseRev : null,
      lastSyncAt: S.lastSyncAt || (b && b.lastSyncAt) || null, pending: S.outbox ? 1 : 0, error: S.error ? S.error.code || String(S.error) : null };
    if (s.status !== 'signedIn') { out.state = b ? 'signedOut' : 'off'; if (s.status === 'unavailable' && b) out.state = s.reason === 'paused' ? 'paused' : 'unavailable'; return out; }
    if (!b || !s.user || b.userId !== s.user.id) { out.projectId = null; out.name = null; out.baseRev = null; out.state = 'off'; return out; }
    if (S.busy) out.state = 'syncing';
    else if (S.error && S.error.code === 'quota') out.state = 'quota';
    else if (S.error && S.error.code === 'paused') out.state = 'paused';
    else if (S.error && S.error.code === 'readonly') out.state = 'readonly';
    else if (S.error && S.error.code === 'network') out.state = 'offline';
    else if (S.error && S.error.code === 'server') out.state = 'unavailable';
    else out.state = b.dirty ? 'dirty' : 'idle';
    return out;
  }
  function changed() {
    var i = I(); if (i) { i.renderChip(); i.renderBar(); }
    var st = status();
    try { if (HAS_DOC && typeof G.CustomEvent === 'function') document.dispatchEvent(new G.CustomEvent('wts:sync-status', { detail: st })); } catch (e) { /* none */ }
  }
  // back online (66's 'online' listener): a network / outage error of the last action no longer stands
  function netBack() { if (S.error && (S.error.code === 'network' || S.error.code === 'server')) { S.error = null; changed(); } }
  function setBusy(v, err) { S.busy = v; if (err !== undefined) S.error = err; changed(); }
  // a change → dirty at once; then ONE snapshot compares with the last saved state, and a rewrite that changed nothing (the
  // same value written again, e.g. an autosave flush) turns the binding clean again (review fix). changeGen guards a real
  // edit that arrives while the check runs.
  var changeGen = 0;
  function markDirty() {
    if (S.applying || S.snapshotting || !S.binding) return;
    changeGen++;
    var u = signedInUser(); if (!u || S.binding.userId !== u.id) return;
    if (S.binding.dirty) return;
    S.binding.dirty = true; saveBinding(); changed();
    if (!S.base || !S.base.vhash) return;
    var gen = changeGen; var b = S.binding; var base = S.base.vhash;
    snapshot({}).then(function (snap) {
      if (gen !== changeGen || S.busy || S.binding !== b || !b.dirty || !S.base || S.base.vhash !== base || snap.vhash !== base) return;
      b.dirty = false; saveBinding(); changed();
    }, function () { /* stays dirty */ });
  }
  var EVENTS = ['wts:autosaved', 'wts:ls-write', 'wts:project-loaded', 'wts:project-new', 'wts:project-changed', 'prism:fit-updated',
    'prism:well-changed', 'prism:model-changed', 'wts:buildup-updated', 'wts:well-changed'];
  var attached = false;
  function onChange(ev) {
    var d = ev && ev.detail;
    if (ev && ev.type === 'wts:project-loaded' && d && (d.source === 'cloud' || d.origin === 'cloud')) return;   // echo guard
    if (ev && ev.type === 'wts:ls-write' && d) {
      var key = String(d.key || '');
      // account / device keys, the account library (synced on its own, not in the snapshot) and derived keys (report
      // snapshots, multi-well results: rebuilt on any click, outside vhash, §6.1 / §7) never dirty the project
      if (/^(wtsacct_|wtspref_)/.test(key) || LIBRARY_RE.test(key) || DEVICE_PREF_RE.test(key) || DERIVED_KEYS[key]) return;
    }
    markDirty();
  }
  // attach() — called by 66 on sign-in and here on bindTo / unlink: the listeners run only while signed in AND linked (§5.5)
  function attach() {
    if (!linkedFor(signedInUser())) { detach(); return; }
    if (attached || !HAS_DOC) return;
    attached = true;
    EVENTS.forEach(function (n) { document.addEventListener(n, onChange); });
  }
  function detach() {
    if (!attached || !HAS_DOC) return;
    attached = false;
    EVENTS.forEach(function (n) { document.removeEventListener(n, onChange); });
  }

  // ── local work ─────────────────────────────────────────────────────────────────────────────────────────────────────
  function P() { return G.WTS_project || null; }
  function isWorkKey(k) {
    if (!/^(wts_|h2oil_)/.test(k) || DEVICE_PREF_RE.test(k) || LIBRARY_RE.test(k) || DERIVED_KEYS[k]) return false;
    if (/consent|analytics|tracking|(^|_)ga(_|$)|subscri|entitle|purchase|^wts_acct_|^wts_sync_/i.test(k)) return false;
    if (k === 'h2oil_client_info') {
      try { var ci = JSON.parse(lsGet(k) || '{}'); return !!(ci && (ci.client || ci.well || ci.field || ci.operator)); } catch (e) { return false; }
    }
    return true;
  }
  // A fresh New / Start empty leaves a few default keys (PRiSM writes its empty state); their values are remembered in the
  // device record (emptyMark) so an emptied browser still counts as empty.
  function hasLocalWork() {
    var mark = (S.device && S.device.emptyMark) || {};
    return lsKeys().some(function (k) { return isWorkKey(k) && !(own(mark, k) && mark[k] === lsGet(k)); });
  }
  function emptyMark() { var m = {}; lsKeys().forEach(function (k) { if (isWorkKey(k)) m[k] = lsGet(k); }); return m; }
  function buildPayload() {
    var p = P(); if (!p || typeof p._buildPayload !== 'function') throw AErr('unavailable', { message: 'project layer missing' });
    var meta;
    try { var ci = JSON.parse(lsGet('h2oil_client_info') || '{}'); meta = {}; ['client', 'well', 'field', 'operator'].forEach(function (k) { if (ci && ci[k]) meta[k] = String(ci[k]); }); } catch (e) { meta = undefined; }
    return p._buildPayload(meta);
  }
  function flushPage() {
    var PA = G.WTS_pageAutosave;
    try { if (PA && typeof PA.flushIfDirty === 'function') PA.flushIfDirty(); else if (PA && typeof PA.flush === 'function') PA.flush(); } catch (e) { /* none */ }
  }
  function metaOf(payload, name) {
    var m = (payload && payload.meta) || {};
    return { name: String(name || m.well || m.client || 'Untitled project').slice(0, 200), client: String(m.client || ''), well: String(m.well || ''),
      field: String(m.field || ''), operator: String(m.operator || '') };
  }

  // ── snapshot (§6.1) ────────────────────────────────────────────────────────────────────────────────────────────────
  function partName(wellId, sub) {
    var s = String(sub).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'x';
    return 'well/' + wellId + '/' + s;
  }
  function isPh(v) { return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.$part === 'string' && typeof v.hash === 'string' && Object.keys(v).length === 2; }
  // splitPayload(payload, opts) — pure: payload → {core, parts:{name: value}, wells, meta, skipped}. Hashes are added by hashSplit.
  function splitPayload(payload, opts) {
    opts = opts || {};
    var mods = clone((payload && payload.modules) || {});
    var skipped = [];
    delete mods.units;                                            // the unit system is a device preference
    if (mods.wts && typeof mods.wts === 'object' && own(mods.wts, 'system')) delete mods.wts.system;
    var storage = (mods.storage && mods.storage.keys) || {};
    if (mods.storage && Array.isArray(mods.storage.skipped)) mods.storage.skipped.forEach(function (x) { skipped.push(x && x.key ? x.key : String(x)); });
    var keys = {};
    Object.keys(storage).forEach(function (k) {
      if (LIBRARY_RE.test(k)) return;                             // library document only (D13)
      if (k === 'wts_modbus_config' && !opts.liveCfg) { skipped.push(k); return; }
      if (DEVICE_PREF_RE.test(k) || /^wts_acct_|^wts_sync_/.test(k)) return;
      keys[k] = storage[k];
    });
    var wm = mods.wells && Array.isArray(mods.wells.wells) && mods.wells.wells.length ? mods.wells : null;
    var meta = (payload && payload.meta) || {};
    var activeId = wm ? String(wm.active || wm.wells[0].id) : 'w1';
    var list = wm ? wm.wells.map(function (w) { return { id: String(w.id), name: String(w.name || w.id), created: w.created || null }; })
      : [{ id: 'w1', name: String(meta.well || 'Well 1'), created: null }];
    var job = {}; var wellKeys = {};
    Object.keys(keys).forEach(function (k) { if (JOB_KEYS[k]) job[k] = keys[k]; else wellKeys[k] = keys[k]; });
    var parts = {};
    function wellPart(id, blob) {
      var w = { v: 1, keys: {}, modules: {} };
      var src = blob || {};
      Object.keys(src.keys || {}).forEach(function (k) {
        var v = src.keys[k];
        if (LIBRARY_RE.test(k) || (k === 'wts_modbus_config' && !opts.liveCfg)) return;
        if (typeof v === 'string' && v.length > LIFT_MAX) { var n = partName(id, k); parts[n] = v; w.keys[k] = { $part: n, hash: '' }; }
        else w.keys[k] = v;
      });
      Object.keys(src.modules || {}).forEach(function (m) {
        var v = src.modules[m];
        if (canonical(v).length > LIFT_MAX) { var n = partName(id, m); parts[n] = v; w.modules[m] = { $part: n, hash: '' }; }
        else w.modules[m] = v;
      });
      if (src.modified) w.modified = src.modified;
      parts['well/' + id] = w;
    }
    var core = { fmt: FMT, format: 'h2oilproj', version: '1.0', generator: payload && payload.generator || 'H2Oil Well Testing Suite',
      savedAt: payload && payload.savedAt || new Date(now()).toISOString(), meta: clone(meta), wells: list, job: job, modules: {}, wellParts: {}, skipped: [] };
    var activeMods = {};
    Object.keys(mods).forEach(function (m) {
      if (m === 'storage' || m === 'wells' || m === 'units') return;
      if (WELL_MODULES.indexOf(m) !== -1) { activeMods[m] = mods[m]; return; }
      if (opts.keepBulk && BULK_MODULES.indexOf(m) !== -1) { core.skipped.push(m); return; }
      if (BULK_MODULES.indexOf(m) !== -1 || canonical(mods[m]).length > LIFT_MAX) { var n = partName(JOB_PART, m); parts[n] = mods[m]; core.modules[m] = { $part: n, hash: '' }; }
      else core.modules[m] = mods[m];
    });
    list.forEach(function (w) {
      if (w.id === activeId) wellPart(w.id, { keys: wellKeys, modules: activeMods });
      else { var e = wm.wells.filter(function (x) { return String(x.id) === w.id; })[0]; wellPart(w.id, e && e.data && typeof e.data === 'object' ? e.data : { keys: {}, modules: {} }); }
      core.wellParts[w.id] = { $part: 'well/' + w.id, hash: '' };
    });
    core.activeAtSave = activeId;
    skipped.forEach(function (k) { if (core.skipped.indexOf(k) === -1) core.skipped.push(k); });
    return { core: core, parts: parts, wells: list, meta: meta, activeId: activeId };
  }
  // the normalised view (§6.1 step 8): no savedAt / generator / modified, no wts_page_*.t, no wts_prism_state.savedAt, no
  // derived keys; placeholders compare by the part's vhash.
  function viewOf(v, vh) {
    if (Array.isArray(v)) return v.map(function (x) { return viewOf(x, vh); });
    if (v && typeof v === 'object') {
      if (isPh(v)) return { $v: vh[v.$part] || v.hash };
      var o = {};
      Object.keys(v).forEach(function (k) {
        if (k === 'savedAt' || k === 'generator' || k === 'modified') return;
        if (k === 'keys' && v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) {
          var ko = {};
          Object.keys(v[k]).forEach(function (kk) {
            if (DERIVED_KEYS[kk]) return;
            var raw = v[k][kk];
            if (typeof raw === 'string' && (/^wts_page_/.test(kk) || kk === 'wts_prism_state')) {
              try { var j = JSON.parse(raw); if (j && typeof j === 'object') { delete j.t; delete j.savedAt; ko[kk] = viewOf(j, vh); return; } } catch (e) { /* raw */ }
            }
            ko[kk] = viewOf(raw, vh);
          });
          o[k] = ko; return;
        }
        if (k === 'job' && v[k] && typeof v[k] === 'object') { o[k] = viewOf(v[k], vh); return; }
        o[k] = viewOf(v[k], vh);
      });
      return o;
    }
    return v;
  }
  // hashSplit(split) → Promise<snap {core, coreText, hash, vhash, parts:[{name, hash, vhash, bytes, text}], byName}>
  function hashSplit(sp) {
    var names = Object.keys(sp.parts);
    var subs = names.filter(function (n) { return n.split('/').length === 3; });
    var tops = names.filter(function (n) { return n.split('/').length === 2; });
    var out = { parts: [], byName: {} }; var vh = {}; var hh = {};
    function fill(v) {
      if (Array.isArray(v)) return v.map(fill);
      if (v && typeof v === 'object') {
        if (typeof v.$part === 'string' && Object.keys(v).length === 2 && own(v, 'hash')) return { $part: v.$part, hash: hh[v.$part] };
        var o = {}; Object.keys(v).forEach(function (k) { o[k] = fill(v[k]); }); return o;
      }
      return v;
    }
    function one(n) {
      var val = fill(sp.parts[n]); sp.parts[n] = val;
      var text = canonical(val);
      return Promise.all([sha256Hex(text), sha256Hex(canonical(viewOf(val, vh)))]).then(function (r) {
        hh[n] = r[0]; vh[n] = r[1];
        var e = { name: n, hash: r[0], vhash: r[1], bytes: utf8(text).length, text: text };
        out.parts.push(e); out.byName[n] = e;
      });
    }
    return subs.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve())
      .then(function () { return tops.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve()); })
      .then(function () {
        var core = fill(sp.core); out.core = core;
        out.coreText = canonical(core);
        return Promise.all([sha256Hex(out.coreText), sha256Hex(canonical(viewOf(core, vh)))]);
      }).then(function (r) {
        out.hash = r[0]; out.vhash = r[1]; out.coreBytes = utf8(out.coreText).length;
        out.parts.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
        out.wells = sp.wells; out.meta = sp.meta; out.activeId = sp.activeId;
        return out;
      });
  }
  // snapshot(opts) → Promise<{core, vhash, parts, …}> of the live working set (§6.1)
  function snapshot(opts) {
    opts = opts || {};
    S.snapshotting = true;
    var pl;
    try { flushPage(); pl = opts.payload || buildPayload(); } catch (e) { S.snapshotting = false; return Promise.reject(e); }
    var a = A(); var st = a && a.state();
    S.snapshotting = false;
    return hashSplit(splitPayload(pl, { liveCfg: !!(st && st.opts && st.opts.liveCfg), keepBulk: !!opts.keepBulk })).then(function (snap) {
      snap.payload = pl;
      return snap;
    });
  }
  // assemble(core, parts) → an ordinary .h2oilproj v1.0 payload (v3.4 opens it). parts: {name: value}. The active well is this
  // device's binding.activeWell when it is in the list, else the well active at save, else the first.
  function assemble(core, parts, opts) {
    opts = opts || {};
    function fillV(v) {
      if (Array.isArray(v)) return v.map(fillV);
      if (v && typeof v === 'object') {
        if (isPh(v)) { if (!own(parts, v.$part)) throw AErr('corrupt', { message: 'missing part ' + v.$part }); return clone(parts[v.$part]); }
        var o = {}; Object.keys(v).forEach(function (k) { o[k] = fillV(v[k]); }); return o;
      }
      return v;
    }
    var list = core.wells || [];
    var ids = list.map(function (w) { return w.id; });
    var act = opts.activeWell && ids.indexOf(opts.activeWell) !== -1 ? opts.activeWell : (ids.indexOf(core.activeAtSave) !== -1 ? core.activeAtSave : ids[0]);
    var modules = {};
    Object.keys(core.modules || {}).forEach(function (m) { modules[m] = fillV(core.modules[m]); });
    var wellOf = function (id) { var ph = core.wellParts[id]; return fillV(ph && isPh(ph) ? ph : { $part: 'well/' + id, hash: '' }); };
    var activePart = wellOf(act) || { keys: {}, modules: {} };
    var keys = {};
    Object.keys(core.job || {}).forEach(function (k) { keys[k] = core.job[k]; });
    Object.keys(activePart.keys || {}).forEach(function (k) { keys[k] = activePart.keys[k]; });
    Object.keys(activePart.modules || {}).forEach(function (m) { modules[m] = activePart.modules[m]; });
    modules.storage = { keys: keys, skipped: [] };
    if (list.length > 1) {
      modules.wells = { v: 1, active: act, wells: list.map(function (w) {
        var d = null;
        if (w.id !== act) { var p = wellOf(w.id); d = { v: 1, savedAt: core.savedAt, keys: p.keys || {}, modules: p.modules || {} }; }
        return { id: w.id, name: w.name, created: w.created || null, modified: null, data: d };
      }) };
    }
    return { format: 'h2oilproj', version: '1.0', generator: core.generator || 'H2Oil Well Testing Suite', savedAt: core.savedAt, meta: clone(core.meta || {}), modules: modules };
  }

  // ── transfer ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function blobFor(snap, hash) {
    if (hash === snap.hash) return snap.coreText;
    for (var i = 0; i < snap.parts.length; i++) if (snap.parts[i].hash === hash) return snap.parts[i].text;
    return null;
  }
  function uploadBlob(text, hash) {
    return gzip(utf8(text)).then(function (gz) {
      return sha256Hex(gz).then(function (zsha) {
        var n = Math.max(1, Math.ceil(gz.length / CHUNK));
        var seq = Promise.resolve();
        for (var i = 0; i < n; i++) (function (i) {
          seq = seq.then(function () {
            var ch = gz.subarray(i * CHUNK, Math.min(gz.length, (i + 1) * CHUNK));
            return sha256Hex(ch).then(function (csha) {
              return call('PUT', '/blobs/' + hash + '/' + i + '?of=' + n, ch, { raw: true, headers: { 'X-WTS-Zsha': zsha, 'X-WTS-Chunk-Sha': csha } });
            });
          });
        })(i);
        return seq.then(function () { return gz.length; });
      });
    });
  }
  function uploadMissing(snap, hashes) {
    var batches = []; for (var i = 0; i < hashes.length; i += 200) batches.push(hashes.slice(i, i + 200));
    var missing = [];
    return batches.reduce(function (p, b) {
      return p.then(function () { return call('POST', '/blobs/has', { hashes: b }).then(function (r) { missing = missing.concat((r.json && r.json.missing) || []); }); });
    }, Promise.resolve()).then(function () { return uploadList(snap, missing); });
  }
  function uploadList(snap, list) {
    return list.reduce(function (p, h) {
      return p.then(function () { var t = blobFor(snap, h); if (t == null) throw AErr('corrupt', { message: 'unknown blob ' + h }); return uploadBlob(t, h); });
    }, Promise.resolve()).then(function () { return list.length; });
  }
  function downloadBlob(hash, bytes) {
    return call('GET', '/blobs/' + hash + '/0', null, { bytes: true }).then(function (r) {
      var of = Number((r.headers && r.headers.get && r.headers.get('x-wts-of')) || 1) || 1;
      var zsha = (r.headers && r.headers.get && r.headers.get('x-wts-zsha')) || null;
      var chunks = [u8(r.bytes)];
      var seq = Promise.resolve();
      for (var i = 1; i < of; i++) (function (i) {
        seq = seq.then(function () { return call('GET', '/blobs/' + hash + '/' + i, null, { bytes: true }).then(function (x) { chunks[i] = u8(x.bytes); }); });
      })(i);
      return seq.then(function () {
        var gz = concat(chunks);
        return (zsha ? sha256Hex(gz) : Promise.resolve(null)).then(function (z) {
          if (zsha && z !== zsha) throw AErr('corrupt', { message: 'compressed copy does not match' });
          return gunzip(gz);
        });
      });
    }).then(function (raw) { return checkText(raw, hash, bytes); });
  }
  function checkText(raw, hash, bytes) {
    if (typeof bytes === 'number' && bytes >= 0 && raw.length > Math.ceil(bytes * 1.01) + 64) throw AErr('corrupt', { message: 'part larger than declared' });
    var text = fromUtf8(raw);
    return sha256Hex(text).then(function (h) {
      if (h !== hash) throw AErr('corrupt', { message: 'part hash does not match' });
      return JSON.parse(text);
    });
  }
  // fetchHead(projectId, rev?) → {head, core, parts:{name: value}}: every SHA-256 verified, the size cap applied, shapes checked
  function fetchRevision(projectId, rev) {
    var path = rev == null ? '/projects/' + projectId + '/head' : '/projects/' + projectId + '/rev/' + rev;
    return call('GET', path).then(function (r) {
      var head = r.json;
      if (!head || !head.coreHash) throw AErr('empty', { message: 'This cloud project has no saved version yet.' });
      var coreP = head.coreInline ? gunzip(unb64(head.coreInline)).then(function (raw) { return checkText(raw, head.coreHash, null); }) : downloadBlob(head.coreHash, null);
      var parts = {};
      return coreP.then(function (core) {
        checkCoreShape(core);
        return (head.parts || []).reduce(function (p, pt) {
          return p.then(function () { return downloadBlob(pt.hash, pt.bytes).then(function (v) { parts[pt.name] = v; }); });
        }, Promise.resolve()).then(function () { return { head: head, core: core, parts: parts }; });
      });
    });
  }
  function checkCoreShape(core) {
    var ok = core && typeof core === 'object' && Array.isArray(core.wells) && core.wellParts && typeof core.wellParts === 'object' &&
      (core.job == null || typeof core.job === 'object') && (core.modules == null || typeof core.modules === 'object');
    if (ok) (core.wells || []).forEach(function (w) { if (!w || typeof w.id !== 'string' || !/^w[0-9]{1,6}$/.test(w.id)) ok = false; });
    if (ok && core.job) Object.keys(core.job).forEach(function (k) { if (typeof core.job[k] !== 'string') ok = false; });
    if (!ok) throw AErr('corrupt', { message: 'unexpected project shape' });
  }

  // ── project summary (user insight; contract ProjectSummary, sent as the commit's summary?) ────────────────────────────
  // projectSummary(snapshotOrPayload, name?) — pure: a small, plain-text summary of the project being saved, which the
  // operator's admin page shows: the well names (the multi-well list and each well's Client & Well Info well name, ≤ 50, each
  // ≤ 80 characters), client, operator, company, field, rig, country and job reference (Client & Well Info, h2oil_client_info;
  // the active well first, then the first other well that has the field; the project meta as the last fallback), the modules
  // used (route keys of the pages with saved data, ≤ 40) and the project name. Every string is plain text (control characters
  // become spaces), trimmed and capped at 120 characters; empty fields are left out. Nothing else of the project is read.
  var SUM_MAX = 120;
  var MODULE_ALIAS = { prism_dataset: 'prism', pvt: 'prism', prism_gauges: 'prism', buildup_raw: 'buildup', buildup_analysis: 'buildup' };
  function sumText(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    var t = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max || SUM_MAX).trim() : null;
  }
  function objOf(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return {};
    try { var o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
  }
  // the Client & Well Info of one well's keys: h2oil_client_info, else the page record's ci_<key> fields
  function clientInfoOf(keys, extra) {
    var ci = {};
    var rec = objOf(keys && keys.wts_page_clientinfo); var fl = objOf(rec.f);
    Object.keys(fl).forEach(function (id) { if (/^ci_[a-z_]+$/.test(id)) ci[id.slice(3)] = fl[id]; });
    var ex = objOf(extra); Object.keys(ex).forEach(function (k) { if (ex[k] != null && ex[k] !== '') ci[k] = ex[k]; });
    var main = objOf(keys && keys.h2oil_client_info); Object.keys(main).forEach(function (k) { if (main[k] != null && main[k] !== '') ci[k] = main[k]; });
    return ci;
  }
  function modulesOf(keys, mods, into) {
    Object.keys(keys || {}).forEach(function (k) {
      var m = /^wts_page_([a-z][a-z0-9_]{0,39})$/.exec(k);
      if (m) into[MODULE_ALIAS[m[1]] || m[1]] = 1;
      else if (/^wts_prism_/.test(k)) into.prism = 1;
      else if (/^wts_buildup_/.test(k)) into.buildup = 1;
      else if (k === 'h2oil_client_info' && ['client', 'well', 'field', 'operator', 'rig', 'country', 'ref'].some(function (x) { return sumText(objOf(keys[k])[x]); })) into.clientinfo = 1;
    });
    Object.keys(mods || {}).forEach(function (m) {
      if (m === 'storage' || m === 'wells' || m === 'units' || mods[m] == null || !/^[a-z][a-z0-9_]{0,39}$/.test(m)) return;
      if (m === 'clientinfo' || m === 'wts') return;               // in-memory mirrors: counted from their keys
      into[MODULE_ALIAS[m] || m] = 1;
    });
  }
  function projectSummary(snap, name) {
    var pl = snap && snap.payload && typeof snap.payload === 'object' ? snap.payload : snap;
    if (!pl || typeof pl !== 'object') return {};
    var mods = objOf(pl.modules);
    var meta = objOf(pl.meta);
    var keys = objOf(mods.storage && mods.storage.keys);
    var wm = mods.wells && Array.isArray(mods.wells.wells) && mods.wells.wells.length ? mods.wells : null;
    var activeId = wm ? String(wm.active || (wm.wells[0] && wm.wells[0].id) || '') : '';
    // the wells: [{name, ci, keys, modules}] with the active well first (its live keys are in storage; the others in their blobs)
    var wells = [];
    var active = { name: null, ci: clientInfoOf(keys, mods.clientinfo), keys: keys, modules: mods };
    if (wm) {
      wm.wells.forEach(function (w) {
        if (!w || typeof w !== 'object') return;
        if (String(w.id) === activeId) { active.name = w.name; wells.unshift(active); return; }
        var d = objOf(w.data);
        var k = objOf(d.keys);
        wells.push({ name: w.name, ci: clientInfoOf(k, d.modules && d.modules.clientinfo), keys: k, modules: objOf(d.modules) });
      });
      if (wells.indexOf(active) === -1) wells.unshift(active);
    } else wells.push(active);
    var out = {};
    var nm = sumText(name) || sumText(meta.name) || sumText(active.ci.well) || sumText(meta.well) || sumText(active.ci.client) || sumText(meta.client);
    if (nm) out.name = nm;
    // well names: unique (case-insensitive), the registry name and the Client & Well Info well name of each well
    var seen = {}; var list = [];
    function addWell(v) { var t = sumText(v, 80); if (!t || seen[t.toLowerCase()] || list.length >= 50) return; seen[t.toLowerCase()] = 1; list.push(t); }
    wells.forEach(function (w) { addWell(w.ci.well); if (wm) addWell(w.name); });
    addWell(meta.well);
    if (list.length) out.wells = list;
    var FIELDS = [['client', 'client'], ['operator', 'operator'], ['company', 'company'], ['field', 'field'], ['rig', 'rig'], ['country', 'country'], ['jobRef', 'ref']];
    FIELDS.forEach(function (fd) {
      // Client & Well Info prefills "Report prepared by → Company" with the app's own default: that is not the user's company
      var val = function (x) { var t = sumText(x); return t && fd[0] === 'company' && /^h2oil engineering$/i.test(t) ? null : t; };
      var v = null;
      for (var i = 0; i < wells.length && !v; i++) v = val(wells[i].ci[fd[1]]);
      if (!v) v = val(meta[fd[1]]);
      if (v) out[fd[0]] = v;
    });
    var used = {};
    wells.forEach(function (w) { modulesOf(w.keys, w.modules, used); });
    Object.keys(mods).forEach(function (m) { if (BULK_MODULES.indexOf(m) !== -1 && mods[m] != null) used[MODULE_ALIAS[m] || m] = 1; });
    var ml = Object.keys(used).filter(function (m) { return /^[a-z][a-z0-9_]{0,39}$/.test(m); }).sort().slice(0, 40);
    if (ml.length) out.modules = ml;
    return out;
  }

  // ── commits ────────────────────────────────────────────────────────────────────────────────────────────────────────
  function commitBody(snap, baseRev, reason, pushId, name, gz) {
    var core = { hash: snap.hash, vhash: snap.vhash, zsha: gz.zsha, bytes: snap.coreBytes };
    if (gz.bytes.length <= INLINE_MAX) core.inline = b64(gz.bytes);
    var meta = metaOf(snap.payload || { meta: snap.meta }, name);
    var body = { pushId: pushId, baseRev: baseRev, reason: reason, core: core,
      parts: snap.parts.map(function (p) { return { name: p.name, hash: p.hash, bytes: p.bytes }; }),
      meta: meta, wells: (snap.wells || []).map(function (w) { return { id: w.id, name: w.name }; }),
      fmt: FMT, appVer: (I() && typeof I().appVer === 'function') ? String(I().appVer() || '') : String((A() && A().seam('appVer')) || '') };
    // user insight: the project summary (well names, client, …) rides with every commit; a summary that cannot be made is left out
    var sum = null; try { sum = projectSummary(snap.payload || { meta: snap.meta }, meta.name); } catch (e) { sum = null; }
    if (sum && Object.keys(sum).length) body.summary = sum;
    return body;
  }
  function encryptOutbox(obj) {
    var c = subtle(); var k = S.outboxKey;
    if (!c || !k) return Promise.resolve(null);
    var iv = randomBytes(12);
    return c.importKey('raw', unb64(k), { name: 'AES-GCM' }, false, ['encrypt']).then(function (key) {
      return c.encrypt({ name: 'AES-GCM', iv: iv }, key, utf8(JSON.stringify(obj)));
    }).then(function (ct) { return { enc: 'A256GCM', iv: b64(iv), ct: b64(new Uint8Array(ct)) }; });
  }
  function decryptOutbox(rec, k) {
    var c = subtle();
    return c.importKey('raw', unb64(k), { name: 'AES-GCM' }, false, ['decrypt']).then(function (key) {
      return c.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct));
    }).then(function (pt) { return JSON.parse(fromUtf8(new Uint8Array(pt))); });
  }
  function isPublic() { var a = A(); var s = a && a.state(); return !!(s && s.publicDevice); }
  function putOutbox(entry) {
    var rec = { fmt: OUTBOX_FMT, pushId: entry.pushId, userId: entry.userId, projectId: entry.projectId, at: now() };
    S.outbox = rec;
    if (isPublic()) {
      // on a public device the waiting entry is never stored in plain text: encrypted with the server outbox key, or not at all
      return encryptOutbox(entry).then(function (enc) { if (enc) { rec.entry = enc; return kvPut('outbox', rec); } return null; });
    }
    rec.entry = { plain: entry };
    return kvPut('outbox', rec);
  }
  function clearOutbox() { S.outbox = null; return kvDel('outbox'); }
  // pushSnap(projectId, snap, baseRev, reason, name) → {rev, savedAt} | {stale, head}
  function pushSnap(projectId, snap, baseRev, reason, name, pushId) {
    var u = signedInUser();
    pushId = pushId || uuid();
    return gzip(utf8(snap.coreText)).then(function (gzb) {
      return sha256Hex(gzb).then(function (zsha) { return { bytes: gzb, zsha: zsha }; });
    }).then(function (gz) {
      var bodyC = commitBody(snap, baseRev, reason, pushId, name, gz);
      var lim = seam('maxProjectBytes') || 64e6;
      var total = snap.parts.reduce(function (n, p) { return n + p.bytes; }, snap.coreBytes);
      if (total > lim * 8) throw AErr('too_large', { limit: lim });
      var hashes = snap.parts.map(function (p) { return p.hash; }).filter(function (h, i, a) { return a.indexOf(h) === i; });
      if (!bodyC.core.inline) hashes.unshift(snap.hash);
      return putOutbox({ pushId: pushId, userId: u ? u.id : null, projectId: projectId, baseRev: baseRev, reason: reason }).then(function () {
        return uploadMissing(snap, hashes);
      }).then(function () {
        var tries = 0;
        function commit() {
          tries++;
          return call('POST', '/projects/' + projectId + '/commit', bodyC).then(function (r) { return clearOutbox().then(function () { return r.json; }); }, function (e) {
            if (e && e.code === 'missing_blobs' && tries < 2) return uploadList(snap, (e.body && e.body.missing) || []).then(commit);
            if (e && e.code === 'stale') return clearOutbox().then(function () { return { stale: true, head: e.body && e.body.head, headRev: e.body && e.body.headRev }; });
            throw e;
          });
        }
        return commit();
      });
    });
  }
  function bindTo(user, projectId, name, rev, snap) {
    S.binding = { userId: user.id, projectId: projectId, baseRev: rev, name: name, boundAt: now(), activeWell: snap ? snap.activeId : null,
      dirty: false, lastSyncAt: now() };
    S.base = snap ? { vhash: snap.vhash, coreHash: snap.hash, parts: snap.parts.reduce(function (o, p) { o[p.name] = p.hash; return o; }, {}) } : null;
    S.lastSyncAt = now();
    S.device.workOwner = user.id; S.device.workOwnerAt = now();
    attach();
    return Promise.all([saveBinding(), S.base ? kvPut('base', S.base) : kvDel('base'), saveDevice()]);
  }
  function requireUser() {
    var u = signedInUser();
    if (!u) return Promise.reject(AErr('signed_out'));
    return init().then(function () { return u; });
  }
  function fail(e) {
    var code = e && e.code;
    S.error = (code === 'quota' || code === 'paused' || code === 'readonly' || code === 'network' || code === 'server') ? e : null;
    S.busy = false; changed();
    var i = I(); if (i) return i.handleError(e);
    return Promise.reject(e);
  }

  // saveToCloud({as, name, reason}) → Promise<{rev, projectId, unchanged?, cancelled?}>
  function saveToCloud(o) {
    o = o || {};
    return requireUser().then(function (u) {
      if (S.busy) return Promise.reject(AErr('busy', { message: 'A cloud save is already running.' }));
      setBusy(true, null);
      return snapshot({ keepBulk: !!o.keepBulk }).then(function (snap) {
        var linked = linkedFor(u) && !o.as;
        var reason = o.reason || 'save';
        var name = o.name || (linked ? S.binding.name : metaOf(snap.payload).name);
        if (linked && S.base && S.base.vhash === snap.vhash && reason === 'save') {
          S.binding.dirty = false; saveBinding(); setBusy(false, null);
          return { rev: S.binding.baseRev, projectId: S.binding.projectId, unchanged: true };
        }
        // a first save whose upload failed after the project was created left an empty project (no revision): the next
        // first save reuses it instead of creating another (review fix; S.device.pendingCreate, cleared once bound)
        var pend = !linked && S.device && S.device.pendingCreate && S.device.pendingCreate.userId === u.id ? S.device.pendingCreate : null;
        var create = linked ? Promise.resolve({ id: S.binding.projectId, rev: S.binding.baseRev })
          : pend ? (pend.name === name ? Promise.resolve() : call('POST', '/projects/' + encodeURIComponent(pend.id) + '/rename', { name: name }).then(function () { pend.name = name; }))
            .then(function () { return { id: pend.id, rev: 0, pending: true }; })
          : call('POST', '/projects', { name: name, meta: (function (m) { delete m.name; return m; })(metaOf(snap.payload, name)) }).then(function (r) {
            if (!S.device) S.device = {};
            S.device.pendingCreate = { userId: u.id, id: r.json.id, name: name };
            return Promise.resolve(saveDevice()).then(function () { return { id: r.json.id, rev: r.json.headRev }; });
          });
        var clearPending = function (id) {
          if (!S.device || !S.device.pendingCreate || S.device.pendingCreate.id !== id) return Promise.resolve();
          delete S.device.pendingCreate; return Promise.resolve(saveDevice());
        };
        return create.then(function (pr) {
          return pushSnap(pr.id, snap, pr.rev, reason, name).then(function (res) {
            if (!res.stale) return clearPending(pr.id).then(function () { return bindTo(u, pr.id, name, res.rev, snap); }).then(function () { setBusy(false, null); libraryPush(); return { rev: res.rev, projectId: pr.id }; });
            setBusy(false, null);
            return staleChoice(u, pr.id, snap, res, name);
          });
        });
      }).then(null, function (e) {
        // §3.2: the linked project was trashed or purged on another device — unlink and offer a new cloud project
        var code = e && e.code;
        if ((code === 'not_found' || code === 'gone') && linkedFor(u) && !o.as) return goneChoice(u, e);
        // the remembered empty project is gone (trashed or purged elsewhere): forget it, so the next save creates a new one
        if ((code === 'not_found' || code === 'gone') && S.device && S.device.pendingCreate && !linkedFor(u)) { delete S.device.pendingCreate; saveDevice(); }
        return fail(e);
      });
    });
  }
  function goneChoice(u, e) {
    var oldName = S.binding ? S.binding.name : null;
    S.busy = false; S.error = null;
    return unlink().then(function () {
      var i = I();
      var ch = i ? i.choose({ title: 'Cloud project not available', text: 'That cloud project is no longer available (it was moved to the trash or deleted on another device). This device is no longer linked to it.',
        buttons: [{ id: 'saveas', label: 'Save as a new cloud project', primary: true }, { id: 'cancel', label: 'Cancel' }] }) : Promise.resolve('cancel');
      return ch.then(function (c) {
        if (c === 'saveas') return saveToCloud({ as: true, name: oldName || undefined });
        return { cancelled: true, unlinked: true, error: e && e.code };
      });
    });
  }
  // Phase 1 409 (§6.6): Overwrite (the replaced revision stays in history) / Save as a new project / Cancel
  function staleChoice(u, projectId, snap, res, name) {
    var i = I();
    var h = res.head || {};
    var when = h.savedAt ? new Date(h.savedAt) : null;
    var text = 'The cloud copy changed' + (h.device ? ' on another device' : '') + (when ? ' at ' + when.toISOString().slice(11, 16) + ' UTC' : '') + '.';
    var ch = i ? i.choose({ title: 'Newer version in the cloud', text: text, buttons: [
      { id: 'overwrite', label: 'Overwrite cloud with this version', primary: true }, { id: 'new', label: 'Save as a new project' }, { id: 'cancel', label: 'Cancel' }] })
      : Promise.resolve('cancel');
    return ch.then(function (c) {
      if (c === 'overwrite') {
        setBusy(true, null);
        return pushSnap(projectId, snap, res.headRev != null ? res.headRev : h.rev, 'overwrite', name).then(function (r2) {
          if (r2.stale) { setBusy(false, null); return staleChoice(u, projectId, snap, r2, name); }
          return bindTo(u, projectId, name, r2.rev, snap).then(function () { setBusy(false, null); return { rev: r2.rev, projectId: projectId, overwritten: true }; });
        });
      }
      if (c === 'new') return saveToCloud({ as: true, name: name + ' (copy)' });
      S.binding && (S.binding.dirty = true); saveBinding(); changed();
      return { cancelled: true };
    });
  }

  // openFromCloud(projectId, {rev}) — push first when this device's linked project changed (offline: refused), safety
  // snapshot, verified download, load with source 'cloud' (H3), re-baseline.
  function openFromCloud(projectId, o) {
    o = o || {};
    return requireUser().then(function (u) {
      var pre = Promise.resolve();
      if (linkedFor(u) && S.binding.dirty && S.binding.projectId === projectId) {
        // §6.8 never discard silently: the same project with unsaved changes → ask (default Cancel); a safety copy is kept
        var ci = I();
        var ask = ci ? ci.choose({ title: 'Open from cloud', text: 'This device has changes that are not saved to the cloud. Discard the changes on this device and load the cloud version? (A safety copy is kept on this device.)',
          buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'discard', label: 'Discard and load the cloud version' }] }) : Promise.resolve('cancel');
        pre = ask.then(function (c) { if (c !== 'discard') throw AErr('cancelled'); });
      } else if (linkedFor(u) && S.binding.dirty) {
        var i = I();
        if (i && !i.isOnline()) return Promise.reject(AErr('offline_dirty'));
        pre = saveToCloud({}).then(function (r) { if (r && r.cancelled) throw AErr('cancelled'); }, function (e) {
          if (e && e.code === 'network') throw AErr('offline_dirty');
          throw e;
        });
      }
      return pre.then(function () {
        setBusy(true, null);
        return fetchRevision(projectId, o.rev);
      }).then(function (got) {
        return safety().then(function () { return got; });
      }).then(function (got) {
        var payload = assemble(got.core, got.parts, { activeWell: S.binding && S.binding.projectId === projectId ? S.binding.activeWell : null });
        return apply(payload).then(function () {
          return call('GET', '/projects').then(function (r) {
            var it = (r.json || []).filter(function (x) { return x.id === projectId; })[0];
            return it ? it.name : null;
          }, function () { return null; });
        }).then(function (nm) {
          return snapshot().then(function (snap) {
            return bindTo(u, projectId, nm || metaOf(payload).name, got.head.rev, snap);
          });
        }).then(function () { libraryPull(); setBusy(false, null); return { rev: got.head.rev, projectId: projectId }; });
      }).then(null, fail);
    });
  }
  function apply(payload) {
    var p = P(); if (!p) return Promise.reject(AErr('unavailable'));
    S.applying = true;
    var res;
    try { res = p.loadFromObject(payload, { source: 'cloud' }); } catch (e) { S.applying = false; return Promise.reject(e); }
    if (res && res.error) { S.applying = false; return Promise.reject(AErr('corrupt', { message: res.error })); }
    return Promise.resolve(res && res.ready).then(function () { S.applying = false; return res; }, function (e) { S.applying = false; throw e; });
  }
  function safety() {
    var pl;
    try { flushPage(); pl = buildPayload(); } catch (e) { return Promise.resolve(); }
    return kvGet('safety').then(function (list) {
      list = Array.isArray(list) ? list : [];
      list.unshift({ at: now(), payload: pl, projectId: S.binding ? S.binding.projectId : null, name: (S.binding && S.binding.name) || metaOf(pl).name || null });
      return kvPut('safety', list.slice(0, 2));
    });
  }
  // restoreSafety(n) — load safety copy n (the current work becomes the newest safety copy). A copy taken from the project this
  // device is still linked to keeps the link and is marked "Not saved to cloud"; any other copy unlinks.
  function restoreSafety(n) {
    return init().then(function () { return kvGet('safety'); }).then(function (list) {
      list = Array.isArray(list) ? list : [];
      var item = list[n]; if (!item || !item.payload) return false;
      var cur = null;
      try { flushPage(); cur = buildPayload(); } catch (e) { cur = null; }
      var rest = list.filter(function (x, k) { return k !== n; });
      if (cur) rest.unshift({ at: now(), payload: cur, projectId: S.binding ? S.binding.projectId : null, name: (S.binding && S.binding.name) || metaOf(cur).name || null });
      return kvPut('safety', rest.slice(0, 2)).then(function () { return apply(item.payload); }).then(function () {
        if (S.binding && item.projectId && item.projectId === S.binding.projectId) { S.binding.dirty = true; return saveBinding().then(function () { changed(); return true; }); }
        return unlink().then(function () { return true; });
      });
    });
  }

  // ── project list and actions ───────────────────────────────────────────────────────────────────────────────────────
  function listProjects(o) {
    o = o || {};
    return requireUser().then(function () { return call('GET', '/projects' + (o.trash ? '?trash=1' : '?trash=0')); }).then(function (r) { return r.json || []; }, fail);
  }
  function history(id) { return requireUser().then(function () { return call('GET', '/projects/' + id + '/revs?limit=50'); }).then(function (r) { return r.json || []; }, fail); }
  function restoreRevision(id, rev) {
    return requireUser().then(function () { return call('POST', '/projects/' + id + '/restore-rev', { rev: rev, pushId: uuid() }); }).then(function (r) {
      if (S.binding && S.binding.projectId === id) { S.binding.dirty = true; saveBinding(); changed(); }
      return r.json;
    }, fail);
  }
  function rename(id, name) {
    return requireUser().then(function () { return call('POST', '/projects/' + id + '/rename', { name: String(name) }); }).then(function () {
      if (S.binding && S.binding.projectId === id) { S.binding.name = String(name); saveBinding(); changed(); }
      return true;
    }, fail);
  }
  function duplicate(id, name) { return requireUser().then(function () { return call('POST', '/projects/' + id + '/duplicate', { name: String(name) }); }).then(function (r) { return r.json; }, fail); }
  function trash(id) {
    return requireUser().then(function () { return call('POST', '/projects/' + id + '/trash', {}); }).then(function () {
      if (S.binding && S.binding.projectId === id) return unlink().then(function () { return true; });
      return true;
    }, fail);
  }
  function restore(id) { return requireUser().then(function () { return call('POST', '/projects/' + id + '/restore', {}); }).then(function () { return true; }, fail); }
  function purge(id) {
    var a = A();
    return requireUser().then(function () {
      return a.withStepUp(function () { return call('POST', '/projects/' + id + '/purge', {}); }, 'Deleting a project for ever needs a fresh confirmation.');
    }).then(function () { return true; }, fail);
  }
  function link(id) { return openFromCloud(id); }
  function unlink() {
    S.binding = null; S.base = null;
    detach();
    return Promise.all([kvDel('binding'), kvDel('base')]).then(function () { changed(); return true; });
  }
  function fileName(name) {
    var s = String(name || 'project').replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 80);
    return (s || 'project') + '.h2oilproj';
  }
  function downloadText(name, text) {
    if (!HAS_DOC) return false;
    var blob = new G.Blob([text], { type: 'application/json' });
    var url = null;
    try { url = G.URL && G.URL.createObjectURL ? G.URL.createObjectURL(blob) : null; } catch (e) { url = null; }
    var a = document.createElement('a');
    a.href = url || ('data:application/json;charset=utf-8,' + encodeURIComponent(text));
    a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    try { document.body.removeChild(a); } catch (e) { /* gone */ }
    return true;
  }
  // projectFile(id, rev?) → {name, text}: the assembled .h2oilproj of a cloud project
  function projectFile(id, rev, name) {
    return fetchRevision(id, rev).then(function (got) {
      var pl = assemble(got.core, got.parts, {});
      return { name: fileName(name || (pl.meta && (pl.meta.well || pl.meta.client)) || 'project'), text: JSON.stringify(pl, null, 2), payload: pl };
    });
  }
  function download(id, name) {
    return requireUser().then(function () { return projectFile(id, null, name); }).then(function (f) { downloadText(f.name, f.text); return f.name; }, fail);
  }

  // importFiles(files) — each .h2oilproj → its own cloud project (reason 'import'); nothing local changes (§6.8)
  function readFile(f) {
    if (f && typeof f.text === 'function') return Promise.resolve(f.text());
    if (f && typeof f._text === 'string') return Promise.resolve(f._text);
    return new Promise(function (res, rej) {
      try { var fr = new G.FileReader(); fr.onload = function () { res(String(fr.result || '')); }; fr.onerror = function () { rej(new Error('read failed')); }; fr.readAsText(f); }
      catch (e) { rej(e); }
    });
  }
  function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    return requireUser().then(function () {
      var results = [];
      return files.reduce(function (p, f) {
        return p.then(function () {
          var nm = String((f && f.name) || 'project').replace(/\.h2oilproj$/i, '').slice(0, 200) || 'project';
          return readFile(f).then(function (text) {
            var pl = JSON.parse(text);
            if (!pl || pl.format !== 'h2oilproj' || !pl.modules) throw AErr('bad_file', { message: 'not a project file' });
            return hashSplit(splitPayload(pl, {})).then(function (snap) {
              snap.payload = pl;
              var meta = metaOf(pl, nm); delete meta.name;
              return call('POST', '/projects', { name: nm, meta: meta }).then(function (r) {
                return pushSnap(r.json.id, snap, 0, 'import', nm).then(function () { results.push({ name: nm, ok: true, id: r.json.id }); });
              });
            });
          }).then(null, function (e) { results.push({ name: nm, ok: false, error: (e && e.code) || 'bad_file' }); });
        });
      }, Promise.resolve()).then(function () { return results; });
    });
  }
  function pickAndImport() {
    if (!HAS_DOC) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.accept = '.h2oilproj,application/json'; inp.style.display = 'none'; inp.id = 'acct_import_input';
      inp.addEventListener('change', function () {
        var fl = inp.files; try { inp.parentNode.removeChild(inp); } catch (e) { /* gone */ }
        if (!fl || !fl.length) { resolve(null); return; }
        importFiles(fl).then(function (res) {
          var i = I();
          if (i) i.choose({ title: 'Import files to cloud', text: res.filter(function (x) { return x.ok; }).length + ' of ' + res.length + ' files imported as cloud projects.',
            list: res.map(function (x) { return x.name + (x.ok ? ' — imported' : ' — not imported (' + x.error + ')'); }), buttons: [{ id: 'ok', label: 'OK', primary: true }] });
          resolve(res);
        }, function (e) { resolve(Promise.reject(e)); });
      });
      document.body.appendChild(inp);
      inp.click();
    });
  }
  // openPicker(): a list of the account's cloud projects in the dialog → openFromCloud
  function openPicker() {
    var i = I();
    return listProjects({}).then(function (list) {
      if (!list.length) return i.choose({ title: 'Open from cloud', text: 'You have no cloud projects yet. Use Save to cloud first.', buttons: [{ id: 'ok', label: 'OK', primary: true }] }).then(function () { return null; });
      var btns = list.slice(0, 20).map(function (p, k) { return { id: 'p' + k, label: p.name + (p.meta && p.meta.client ? ' — ' + p.meta.client : '') + (p.savedAt ? ' (' + String(p.savedAt).slice(0, 10) + ')' : ''), primary: k === 0 }; });
      btns.push({ id: 'cancel', label: 'Cancel' });
      return i.choose({ title: 'Open from cloud', text: 'Choose a project. Your current work is kept in a safety copy on this device.', buttons: btns }).then(function (c) {
        if (!c || c === 'cancel') return null;
        var p = list[Number(c.slice(1))];
        return p ? openFromCloud(p.id) : null;
      });
    });
  }

  // ── account library (D13; Phase 1: union on save / open, local wins) ─────────────────────────────────────────────────
  function localLibrary() { var o = {}; lsKeys().forEach(function (k) { if (LIBRARY_RE.test(k)) { var v = lsGet(k); if (v != null) o[k] = v; } }); return o; }
  function libraryPull() { return librarySync(false); }
  function libraryPush() { return librarySync(true); }
  function librarySync(push) {
    var local = localLibrary();
    return call('GET', '/library').then(function (r) {
      var head = r.json || { rev: 0, hash: null };
      var bodyP = head.rev > 0 ? call('GET', '/library/body', null, { bytes: true }).then(function (x) { return gunzip(u8(x.bytes)).then(function (raw) { return JSON.parse(fromUtf8(raw)); }); }) : Promise.resolve({});
      return bodyP.then(function (remote) {
        remote = remote && typeof remote === 'object' ? remote : {};
        Object.keys(remote).forEach(function (k) { if (LIBRARY_RE.test(k) && !own(local, k) && typeof remote[k] === 'string') lsSet(k, remote[k]); });
        if (!push) return null;
        var union = Object.assign({}, remote, local);
        var text = canonical(union);
        return sha256Hex(text).then(function (h) {
          if (h === head.hash || !Object.keys(union).length) return null;
          return gzip(utf8(text)).then(function (gz) {
            return call('POST', '/library/commit', { pushId: uuid(), baseRev: head.rev, hash: h, body: b64(gz) });
          });
        });
      });
    }).then(null, function () { return null; });   // the library never blocks a project save or open
  }

  // ── §10 migration and hand-over ────────────────────────────────────────────────────────────────────────────────────
  function preview(snap) {
    var pages = 0, prism = false, buildup = 0, wells = (snap.wells || []).length;
    snap.parts.forEach(function (p) {
      try {
        var v = JSON.parse(p.text);
        if (v && v.keys) Object.keys(v.keys).forEach(function (k) { if (/^wts_page_/.test(k)) pages++; if (k === 'wts_prism_state' || k === 'wts_prism') prism = true; });
      } catch (e) { /* sub-part */ }
      if (/\/buildup_analysis$/.test(p.name)) { try { var t = JSON.parse(p.text); buildup = Array.isArray(t) ? t.length : (t && t.tests ? Object.keys(t.tests).length : 1); } catch (e) { buildup = 1; } }
    });
    var bytes = snap.parts.reduce(function (n, p) { return n + p.bytes; }, snap.coreBytes);
    var large = snap.parts.filter(function (p) { return p.bytes > LIFT_MAX; }).map(function (p) { return { name: p.name, bytes: p.bytes }; });
    return { name: metaOf(snap.payload).name, client: (snap.meta && snap.meta.client) || '', wells: wells,
      wellNames: (snap.wells || []).map(function (w) { return w.name; }), pages: pages, prism: prism, buildup: buildup, bytes: bytes, large: large };
  }
  function mb(n) {
    n = Number(n) || 0;
    var t = n >= 1e6 ? String(Math.round(n / 1e5) / 10) + ' MB' : Math.max(1, Math.round(n / 1000)) + ' kB';
    var dc = false; try { dc = !!(G.WTS_a11y && G.WTS_a11y.decimalComma && G.WTS_a11y.decimalComma()); } catch (e) { /* none */ }
    return dc ? t.replace('.', ',') : t;      // 250 MB, 1.5 MB (1,5 MB with the decimal-comma setting)
  }
  function classify(user, migrated) {
    var d = S.device || {};
    if (!hasLocalWork()) return 'empty';
    if (d.workOwner === user.id) return 'own';
    // work this user already put into the account from this device (§10.2 migratedFor) and nobody else claimed since
    if ((!d.workOwner || d.workOwner === 'unowned') && Array.isArray(migrated) && migrated.indexOf(user.id) !== -1 && (!d.lastUserId || d.lastUserId === user.id)) return 'own';
    if (d.workOwner && d.workOwner !== 'unowned') return 'foreign';
    // 'unowned' (or never recorded): a personal device's pre-account work, unless another user signed in here before
    if (d.lastUserId && d.lastUserId !== user.id) return 'unknown';
    return 'unowned';
  }
  function pinPreAccount(payload) {
    return kvGet('preAccount').then(function (p) { if (p) return p; return kvPut('preAccount', { at: now(), payload: payload, pinned: true }); });
  }
  // afterSignIn(user) — called by 66 after every successful sign-in (any method): public outbox key, the locked outbox of this
  // user, then the §10 classification and its questions. Resolves {kind, choice}.
  function afterSignIn(user, info) {
    var i = I();
    return init().then(function () {
      var pub = isPublic();
      var keyP = pub ? call('GET', '/me/outbox-key').then(function (r) { S.outboxKey = r.json && r.json.k; }, function () { S.outboxKey = null; }) : Promise.resolve();
      return keyP.then(function () { return unlockOutbox(user); }).then(function () { return restoreStash(user); }).then(function () {
        if (linkedFor(user)) return { kind: 'linked', choice: null };
        return kvGet('migratedFor').then(function (mf) { return handover(user, classify(user, mf)); });
      }).then(function (res) {
        S.device.lastUserId = user.id;
        return saveDevice().then(function () { changed(); return res; });
      });
    }).then(null, function (e) { if (i) i.message(i.cloudErrText(e), 'err'); return { kind: 'error', error: e && e.code }; });
  }
  function handover(user, kind) {
    var i = I();
    if (!i) return Promise.resolve({ kind: kind, choice: null });
    if (kind === 'empty') {
      return listProjects({}).then(function (list) {
        S.device.workOwner = user.id; S.device.workOwnerAt = now();
        if (!list.length) return { kind: kind, choice: null };
        var latest = list.slice().sort(function (a, b) { return String(b.savedAt || '').localeCompare(String(a.savedAt || '')); })[0];
        return i.choose({ title: 'Open your latest cloud project?', text: 'This browser holds no project. Open "' + latest.name + '", saved ' + String(latest.savedAt || '').slice(0, 10) + '?',
          buttons: [{ id: 'open', label: 'Open it', primary: true }, { id: 'later', label: 'Not now' }] }).then(function (c) {
          if (c === 'open') return openFromCloud(latest.id).then(function () { return { kind: kind, choice: 'open' }; });
          return { kind: kind, choice: 'later' };
        });
      }, function () { return { kind: kind, choice: null }; });
    }
    if (kind === 'own' || kind === 'unowned') return ownFlow(user, kind);
    return foreignFlow(user, kind);
  }
  function ownFlow(user, kind) {
    var i = I();
    return Promise.all([snapshot(), listProjects({})]).then(function (r) {
      var snap = r[0], list = r[1];
      var pv = preview(snap);
      var lim = seam('maxProjectBytes') || 64e6;
      var over = pv.bytes > lim;
      var lines = ['Project: ' + pv.name + (pv.client ? ' (' + pv.client + ')' : ''), 'Wells: ' + pv.wells + ' — ' + pv.wellNames.join(', '),
        'Pages with inputs: ' + pv.pages, 'PRiSM analysis: ' + (pv.prism ? 'yes' : 'no'), 'Build-up tests: ' + pv.buildup, 'Size: ' + mb(pv.bytes)];
      if (over) lines.push('Over the ' + mb(lim) + ' cloud limit. Largest parts: ' + pv.large.slice(0, 4).map(function (x) { return x.name.split('/').pop() + ' ' + mb(x.bytes); }).join(', '));
      var btns = over ? [{ id: 'upload_lite', label: 'Upload without gauges and build-up raw data', primary: true }] : [{ id: 'upload', label: 'Upload as a new cloud project', primary: true }];
      if (list.length) btns.push({ id: 'open', label: 'Open a cloud project instead' });
      btns.push({ id: 'later', label: 'Not now' });
      return i.choose({ title: list.length ? 'Your work on this device' : 'Put the work on this device into your account?',
        text: list.length ? 'Upload the work on this device as a new cloud project, or open one of your cloud projects instead (this work is uploaded first).' : 'Your account is empty. Upload the work on this device as your first cloud project?',
        list: lines, buttons: btns }).then(function (c) {
        if (c === 'upload' || c === 'upload_lite') {
          return pinPreAccount(snap.payload).then(function () { return saveToCloud({ as: true, name: pv.name, reason: 'migrate', keepBulk: c === 'upload_lite' }); })
            .then(function (res) { return markMigrated(user).then(function () { return { kind: kind, choice: c, rev: res && res.rev, preview: pv }; }); });
        }
        if (c === 'open') {
          return pinPreAccount(snap.payload).then(function () {
            return saveToCloud({ as: true, name: pv.name, reason: 'migrate', keepBulk: over }).then(null, function () { return null; });
          }).then(function () { return markMigrated(user); }).then(function () { return openPicker(); }).then(function () { return { kind: kind, choice: 'open', preview: pv }; });
        }
        if (kind === 'unowned') { S.device.workOwner = user.id; S.device.workOwnerAt = now(); }
        return { kind: kind, choice: 'later', preview: pv };
      });
    });
  }
  function markMigrated(user) {
    return kvGet('migratedFor').then(function (l) { l = Array.isArray(l) ? l : []; if (l.indexOf(user.id) === -1) l.push(user.id); return kvPut('migratedFor', l); });
  }
  function foreignFlow(user, kind) {
    var i = I();
    function ask() {
      return i.choose({ title: 'This browser holds work from another account', text: 'This browser holds work from another account. It is never uploaded into your account unless you confirm it below.',
        buttons: [{ id: 'empty', label: 'Start empty (keep it local)', primary: true }, { id: 'signout', label: 'Sign out' }, { id: 'more', label: 'More…' }] });
    }
    return ask().then(function (c) {
      if (c === 'empty' || c === null) return startEmpty(user).then(function () { return { kind: kind, choice: 'empty' }; });
      if (c === 'signout') return A().signOut({ keep: true }).then(function () { return { kind: kind, choice: 'signout' }; });
      return snapshot().then(function (snap) {
        var pv = preview(snap);
        var who = (user && user.emailMasked) || 'your';
        return i.choose({ title: 'Upload another account\'s work?', text: 'Upload \'' + (pv.client ? pv.client + ' — ' : '') + pv.wellNames.join(', ') + '\' into ' + who + '\'s account?',
          buttons: [{ id: 'upload', label: 'Upload into my account', primary: false }, { id: 'cancel', label: 'Cancel', primary: true }] }).then(function (c2) {
          if (c2 !== 'upload') return startEmpty(user).then(function () { return { kind: kind, choice: 'empty' }; });
          return saveToCloud({ as: true, name: pv.name, reason: 'migrate' }).then(function (r) { return { kind: kind, choice: 'upload', rev: r && r.rev }; });
        });
      });
    });
  }
  // Start empty: the working set goes into stash[owner] (restored when that user signs in again), an empty project starts.
  function startEmpty(user) {
    var owner = (S.device && S.device.workOwner && S.device.workOwner !== 'unowned') ? S.device.workOwner : ('unknown:' + (S.device && S.device.lastUserId || 'none'));
    var pl; try { flushPage(); pl = buildPayload(); } catch (e) { pl = null; }
    return kvGet('stash').then(function (st) {
      st = st && typeof st === 'object' ? st : {};
      if (pl) st[owner] = { at: now(), payload: pl };
      return kvPut('stash', st);
    }).then(function () {
      S.applying = true;
      try { var p = P(); if (p && typeof p['new'] === 'function') p['new'](); } catch (e) { /* none */ }
      S.applying = false;
      S.binding = null; S.base = null;
      S.device.workOwner = user.id; S.device.workOwnerAt = now();
      S.device.emptyMark = emptyMark();
      return Promise.all([kvDel('binding'), kvDel('base'), saveDevice()]);
    });
  }
  function restoreStash(user) {
    return kvGet('stash').then(function (st) {
      if (!st || !st[user.id] || hasLocalWork()) return null;
      var pl = st[user.id].payload;
      delete st[user.id];
      return apply(pl).then(function () {
        S.device.workOwner = user.id; S.device.workOwnerAt = now();
        return Promise.all([kvPut('stash', st), saveDevice()]);
      });
    });
  }
  // 66 calls this when the page is signed out (sign-out or a 401): remember the last user (lastUserId), so work found at the
  // next sign-in by another user is classified 'unknown' (§10.1). The edited-after-sign-out mark is not kept in Phase 1:
  // work owned by another user is 'foreign' whether or not it was edited, and the owner's own work is 'own'.
  function noteSignedOut(user) {
    return init().then(function () {
      if (user && user.id) S.device.lastUserId = user.id;
      S.outboxKey = null;
      detach();
      return saveDevice();
    });
  }
  function setDevice(id) {
    return init().then(function () { if (!S.device) S.device = {}; S.device.deviceId = id; return saveDevice(); });
  }

  // ── public computer: the guarded wipe and the locked outbox (§10.8) ─────────────────────────────────────────────────
  function publicSignOutGuard(user) {
    var i = I();
    return init().then(function () {
      var st = status();
      // blocked while a change waits or the local work is not the synced cloud version (unlinked work counts)
      if (!S.outbox && (st.state === 'idle' || !hasLocalWork())) return 'proceed';
      function ask() {
        return i.choose({ title: 'Changes are waiting', text: 'This project has changes that are not in the cloud yet. This shared computer keeps nothing of your work after you sign out.',
          buttons: [{ id: 'upload', label: 'Try to upload now', primary: true }, { id: 'download', label: 'Download .h2oilproj' },
            { id: 'lock', label: 'Keep the waiting changes locked for 7 days' }, { id: 'cancel', label: 'Cancel sign-out' }] });
      }
      function loop(n) {
        return ask().then(function (c) {
          if (c === 'upload') return saveToCloud({}).then(function (r) { return r && !r.cancelled ? 'proceed' : loop(n + 1); }, function () { return n < 2 ? loop(n + 1) : 'cancel'; });
          if (c === 'download') { var p = P(); try { if (p && p.saveDownload) p.saveDownload(); } catch (e) { /* none */ } return 'proceed'; }
          if (c === 'lock') return lockOutbox(user).then(function () { return 'proceed'; }, function () { return loop(n + 1); });
          return 'cancel';
        });
      }
      return loop(0);
    });
  }
  // lockOutbox(user): the waiting work, encrypted with the per-user server outbox key (fetched now if not in memory, never
  // stored), kept for 7 days; only the same user can unlock and push it after signing in again.
  function lockOutbox(user) {
    var keyP = S.outboxKey ? Promise.resolve(S.outboxKey) : call('GET', '/me/outbox-key').then(function (r) { S.outboxKey = r.json && r.json.k; return S.outboxKey; });
    return keyP.then(function (k) {
      if (!k) throw AErr('no_key');
      var pl; flushPage(); pl = buildPayload();
      var b = S.binding;
      return encryptOutbox({ payload: pl, projectId: b ? b.projectId : null, baseRev: b ? b.baseRev : null, name: b ? b.name : metaOf(pl).name }).then(function (enc) {
        return kvPut('lockedOutbox', { fmt: OUTBOX_FMT, userId: user.id, until: now() + 7 * 864e5, iv: enc.iv, ct: enc.ct, enc: enc.enc });
      });
    });
  }
  function unlockOutbox(user) {
    return kvGet('lockedOutbox').then(function (rec) {
      if (!rec) return null;
      if (rec.until < now()) return kvDel('lockedOutbox');
      if (rec.userId !== user.id) return null;
      return call('GET', '/me/outbox-key').then(function (r) { return decryptOutbox(rec, r.json.k); }).then(function (o) {
        return hashSplit(splitPayload(o.payload, {})).then(function (snap) {
          snap.payload = o.payload;
          var push = o.projectId ? pushSnap(o.projectId, snap, o.baseRev || 0, 'save', o.name) : Promise.resolve({ stale: true });
          return push.then(function (res) {
            if (!res.stale) return res;
            var nm = String(o.name || 'Project') + ' (waiting changes)';
            var meta = metaOf(o.payload, nm); delete meta.name;
            return call('POST', '/projects', { name: nm, meta: meta }).then(function (c) { return pushSnap(c.json.id, snap, 0, 'save', nm); });
          });
        });
      }).then(function () { return kvDel('lockedOutbox'); }, function () { return null; });
    });
  }
  // wipeDevice({reason, historian, keepLocked}) — the working set, wts-sync (except a locked outbox), report snapshots, the
  // hint and (ticked) the historian; keeps only non-identifying preferences (wtspref_*, the unit system, wts_ui_*).
  function wipeLocalSync(o) {
    S.applying = true;
    try { var p = P(); if (p && typeof p['new'] === 'function') p['new'](); } catch (e) { /* host */ }
    lsKeys().forEach(function (k) {
      if (k === 'wtsacct_hint') { lsRemove(k); return; }
      if (!/^(wts_|h2oil_)/.test(k)) return;
      if (DEVICE_PREF_RE.test(k)) return;
      if (o.reason === 'signout' && o.keepLocked && LIBRARY_RE.test(k)) return;   // a trusted device keeps its own library
      lsRemove(k);
    });
    S.applying = false;
  }
  function wipeDevice(o) {
    o = o || {};
    wipeLocalSync(o);
    return wipeStores(o);
  }
  function wipeStores(o) {
    var hist = o.historian && G.WTS_historian && typeof G.WTS_historian.purge === 'function' ? Promise.resolve().then(function () { return G.WTS_historian.purge({ all: true }); }).then(null, function () { return null; }) : Promise.resolve();
    var trustedRemove = o.reason === 'signout' && o.keepLocked;
    return Promise.all([kvGet('lockedOutbox'), kvGet('device'), trustedRemove ? kvGet('preAccount') : null, trustedRemove ? kvGet('stash') : null]).then(function (r) {
      var locked = r[0], dev = r[1];
      return kvClear().then(function () {
        var keep = [];
        if (locked) keep.push(kvPut('lockedOutbox', locked));
        if (trustedRemove) { if (dev) keep.push(kvPut('device', dev)); if (r[2]) keep.push(kvPut('preAccount', r[2])); if (r[3]) keep.push(kvPut('stash', r[3])); }
        return Promise.all(keep);
      }).then(function () {
        S.binding = null; S.base = null; S.outbox = null; S.outboxKey = null; S.error = null; S.lastSyncAt = null;
        S.device = trustedRemove && dev ? dev : { deviceId: null, lastUserId: null, workOwner: null, workOwnerAt: now() };
        S.device.emptyMark = emptyMark();
        if (!trustedRemove) { var a = A(); if (a) a.configure({ deviceId: null }); }
        return saveDevice();
      });
    }).then(function () { changed(); return true; });   // the historian purge runs on; it never holds the wipe or init()
  }
  // At load (no timer): a public session past its absolute expiry, or idle for 12 h since the last activity, is wiped before
  // anything is shown (§5.5, §10.8). Reads only the hint.
  function publicExpiryAtLoad() {
    var h; try { h = JSON.parse(lsGet('wtsacct_hint') || 'null'); } catch (e) { h = null; }
    if (!h || !h.public) return false;
    var t = now(); var abs = h.absExpires ? Date.parse(h.absExpires) : NaN;
    var idle = typeof h.lastSeenAt === 'number' ? h.lastSeenAt + 12 * 3600e3 : NaN;
    if ((isFinite(abs) && t > abs) || (isFinite(idle) && t > idle)) { wipeLocalSync({ reason: 'expiry' }); S.pendingWipe = true; return true; }
    return false;
  }

  // ── the project guard (H14) ────────────────────────────────────────────────────────────────────────────────────────
  var guardOff = null;
  function guard(ctx) {
    var u = signedInUser(); var i = I();
    if (!u || !i) return 'proceed';
    var action = ctx && ctx.action;
    if (action === 'new') {
      return i.choose({ title: 'New project', text: 'Start a new cloud project, or a local-only one? The cloud project you are linked to is not changed.',
        buttons: [{ id: 'cloud', label: 'New cloud project', primary: true }, { id: 'local', label: 'Local only' }, { id: 'cancel', label: 'Cancel' }] }).then(function (c) {
        if (c !== 'cloud' && c !== 'local') return 'cancel';
        return { decision: 'proceed', after: followUp(function () { return unlink().then(function () { if (c === 'cloud') return saveToCloud({ as: true, name: 'New project' }); }); }) };
      });
    }
    if (action === 'open' || action === 'open-file') {
      var linked = linkedFor(u);
      var pre = lsGet('wtspref_cloud_open') === '1' ? Promise.resolve('new') : i.choose({ title: 'Open a project file', text: 'How should this file be kept?',
        html: '<label class="acct-tick"><input type="checkbox" id="acct_open_dontask"> Don\'t ask again (always open as a new cloud project)</label>',
        buttons: [{ id: 'new', label: 'Open as a new cloud project', primary: true }, { id: 'local', label: 'Local only' }]
          .concat(linked ? [{ id: 'replace', label: 'Replace the linked project\'s contents' }] : []).concat([{ id: 'cancel', label: 'Cancel' }]), keepOpen: true }).then(function (c) {
        var t = HAS_DOC && document.getElementById('acct_open_dontask');
        if (t && t.checked && c === 'new') lsSetPref('wtspref_cloud_open', '1');
        i.closeDialog(false);
        return c;
      });
      return pre.then(function (c) {
        if (c !== 'new' && c !== 'local' && c !== 'replace') return 'cancel';
        return { decision: 'proceed', after: followUp(function (res) {
          if (c === 'local') return unlink();
          if (c === 'replace') { if (S.binding) { S.binding.dirty = true; } return saveToCloud({}); }
          var f = P() && P().currentFile && P().currentFile();
          var name = (res && res.filename) || (f && f.name) || '';
          return unlink().then(function () { return saveToCloud({ as: true, name: name ? String(name).replace(/\.h2oilproj$/i, '') : undefined }); });
        }) };
      });
    }
    return 'proceed';
  }
  function lsSetPref(k, v) { try { G.localStorage.setItem(k, v); } catch (e) { /* blocked */ } }   /* ls-raw: wtspref_ device preference */
  // the follow-up of a guarded New / Open: 29 calls it with that action's own result, and only when it succeeded (a corrupt
  // or empty file arms nothing that a later, unrelated open could fire)
  function followUp(fn) {
    return function (res) {
      Promise.resolve(res).then(fn).then(null, function (e) { var i = I(); if (i) i.toast(i.cloudErrText(e), 'err'); });
    };
  }
  function mount() {
    init();
    var p = P();
    if (!guardOff && p && typeof p.registerGuard === 'function') guardOff = p.registerGuard(guard);
  }

  // ── export (§8.5): the account JSON plus every project as .h2oilproj ──────────────────────────────────────────────────
  // exportAll({accountOnly}) — accountOnly: the account JSON only (POST /account/export, no project bodies fetched), as used
  // by the account page's activity list.
  function exportAll(o) {
    o = o || {};
    var a = A();
    return requireUser().then(function () {
      return a.withStepUp(function () { return call('POST', '/account/export', {}); }, 'Exporting everything needs a fresh confirmation.');
    }).then(function (r) {
      var acc = r.json;
      var files = [{ name: 'account.json', text: JSON.stringify(acc, null, 2) }];
      if (o.accountOnly) return { account: acc, files: files };
      var used = {};
      return (acc.projects || []).reduce(function (p, pr) {
        return p.then(function () {
          if (!pr.headRev) return null;
          return projectFile(pr.id, null, pr.name).then(function (f) {
            var n = f.name; var k = 2; while (used[n]) n = f.name.replace(/\.h2oilproj$/, '') + ' (' + (k++) + ').h2oilproj';
            used[n] = 1; files.push({ name: 'projects/' + n, text: f.text });
          });
        });
      }, Promise.resolve()).then(function () { return { account: acc, files: files }; });
    });
  }

  function notYet(name) {
    return function () { return Promise.reject(AErr('not_implemented', { message: name + ' is Phase 2 / 3' })); };
  }
  var api = {
    VERSION: VERSION, status: status, canonical: canonical, sha256Hex: sha256Hex,
    link: link, unlink: unlink, saveToCloud: saveToCloud, openFromCloud: openFromCloud, importFiles: importFiles,
    listProjects: listProjects, history: history, restoreRevision: restoreRevision, rename: rename, duplicate: duplicate,
    trash: trash, restore: restore, purge: purge, download: download, projectFile: projectFile, snapshot: snapshot, assemble: assemble,
    projectSummary: projectSummary,
    migrateLocal: function (choice) { var u = signedInUser(); if (!u) return Promise.reject(AErr('signed_out')); return init().then(function () { return kvGet('migratedFor'); }).then(function (mf) { return handover(u, classify(u, mf)); }); },
    wipeDevice: wipeDevice, exportAll: exportAll, openPicker: openPicker, pickAndImport: pickAndImport,
    afterSignIn: afterSignIn, publicSignOutGuard: publicSignOutGuard, lockOutbox: lockOutbox,
    syncNow: notYet('syncNow'), conflicts: function () { return Promise.resolve([]); }, resolve: notYet('resolve'), diff: notYet('diff'),
    historianBackup: notYet('historianBackup'), historianRestore: notYet('historianRestore'),
    // device-local records for the account page (On this device)
    local: {
      preAccount: function () { return kvGet('preAccount'); }, stash: function () { return kvGet('stash'); }, safety: function () { return kvGet('safety'); },
      restorePreAccount: function () { return kvGet('preAccount').then(function (p) { if (!p) return false; return safety().then(function () { return apply(p.payload); }).then(function () { return unlink(); }).then(function () { return true; }); }); },
      discardPreAccount: function () { return kvDel('preAccount'); },
      restoreStash: function (owner) { return kvGet('stash').then(function (st) { if (!st || !st[owner]) return false; var pl = st[owner].payload; delete st[owner]; return safety().then(function () { return apply(pl); }).then(function () { return kvPut('stash', st); }).then(function () { return unlink(); }).then(function () { return true; }); }); },
      restoreSafety: restoreSafety,
      discardSafety: function (n) { return kvGet('safety').then(function (l) { l = Array.isArray(l) ? l : []; l.splice(n, 1); return kvPut('safety', l); }); },
      discardStash: function (owner) { return kvGet('stash').then(function (st) { if (!st) return true; delete st[owner]; return kvPut('stash', st); }); },
    },
    _split: splitPayload, _hashSplit: hashSplit, _classify: classify, _store: { get: kvGet, put: kvPut, del: kvDel },
    _attach: attach, _detach: detach, _mount: mount, _netBack: netBack, _noteSignedOut: noteSignedOut, _setDevice: setDevice, _init: init,
    _hasLocalWork: hasLocalWork, _state: function () { return { binding: clone(S.binding), base: clone(S.base), device: clone(S.device), outbox: clone(S.outbox) }; },
  };
  G.WTS_cloudSync = api;
  publicExpiryAtLoad();
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  // pure checks only (stripped by concat)
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var S = G.WTS_cloudSync;
  if (S && S.canonical({ b: 2, a: [1, undefined], c: undefined }) !== '{"a":[1,null],"b":2}') throw new Error('67 self-test: canonical');
})();
