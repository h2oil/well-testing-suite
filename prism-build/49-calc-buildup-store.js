// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 — Build-up Surveillance: STORE (window.WTS_buildup.store)
// helper module: does not add a page to window.WTS_calcRegistry
//
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §3.11, §3.12, §6.8 (WP6).
//
//   • IndexedDB database 'wts_buildup' with two stores, both keyed by well id:
//       raw    → store.encode(GaugeRecord)            (delta-encoded int32, base64)
//       tests  → {[testId]: {spec, result}}           (overflow of wts_buildup_state)
//     with an in-memory mirror that is always written first. Without IndexedDB
//     (smoke stub, harness, private mode, a failed open) the mirror is the store
//     (engine 'memory').
//   • localStorage 'wts_buildup_state' (≤ 300 kB, written through WTS_lsSet) and
//     'wts_buildup_audit' (append-only, chain-hashed, ≤ 500 entries / 200 kB; the
//     oldest entries fold into one summary record that keeps their chain hash).
//   • Project-file modules 'buildup_raw' and 'buildup_analysis' (WTS_project):
//     read() is synchronous from the mirror (a cold mirror lists the well under
//     `omitted`), write() fills the mirror synchronously, then IndexedDB. On a
//     project Open, entries whose well ids are not in the file are dropped (an old
//     project without the modules drops them all).
//
// PUBLIC API — window.WTS_buildup.store
//   init() → Promise<{engine:'idb'|'memory'}>
//   putRaw(wellId, recordOrEncoded) → Promise   getRaw(wellId) → Promise<GaugeRecord|null> (null unless the samples
//     re-hash to the record's hash, data.recordHash; rec.hashVerified)
//   putTests(wellId, {[id]:{spec,result}}) → Promise   getTests(wellId) → Promise<object|null>
//   encode(record) → {origin_ms, tScale_ms, pScale, TScale, n, tB64, pB64, TB64|null, meta}
//   encodeJob(record) → Job (units of ENCODE_UNIT samples; run through PRiSM_autoInterp.drive)
//   decode(obj) → GaugeRecord (Float64Array t/p/T) | null (n not a sample count, or a stream shorter than n);
//     header fields come from meta by name and type only
//   loadState() → object|null     saveState(state, {wellId}) → {ok, bytes, overflow, overflowWrite?: Promise<{ok, engine}>}
//   stripResult(result) → copy without the recomputable arrays (curves, bins.X, bins.dte)
//   audit.list() / audit.append(entry) → entry|null / audit.summary() / audit.verify() / audit.chainHash()
//   audit.status() → {state: missing|ok|broken|unreadable, brokenAt, lost, lastRunSeq}; an unreadable log is kept
//     under wts_buildup_audit_corrupt_<ms> before a new chain (with lost:{at, key, chars}) is started
//   Project-file import (write) keeps only safe well ids, encoded records of the encoder's shape within RAW_CAP in
//   total, and plain-object analyses.
//   wellId(id?) → id || WTS_wells.active() || 'default'
//   STATE_KEY, AUDIT_KEY, STATE_CAP, AUDIT_CAP, AUDIT_MAX, RAW_CAP, ENCODE_UNIT
//   _mirror() (tests), _reset() (tests: forget the opened database and the mirror)
//
// Rules: no timers, no polling, no function wrapping. Hashes use
// PRiSM_autoInterp.canon / hash16 (looked up at call time).
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var B = G.WTS_buildup = G.WTS_buildup || {};
    var S = B.store = B.store || {};

    var DB_NAME = 'wts_buildup', DB_VER = 1;
    var STATE_KEY = 'wts_buildup_state', AUDIT_KEY = 'wts_buildup_audit';
    var STATE_CAP = 300 * 1024, AUDIT_CAP = 200 * 1024, AUDIT_MAX = 500, AUDIT_KEEP = 400;
    var RAW_CAP = 16 * 1024 * 1024;
    var ENCODE_UNIT = 50000;
    var P_SCALE = 0.001, T_SCALE = 0.01;

    function _P() { return G.Promise; }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
    function _ls() { try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; } }
    function _AI() { return G.PRiSM_autoInterp || null; }
    function _canon(o, mode) {
        var A = _AI();
        if (A && typeof A.canon === 'function') return A.canon(o, mode);
        return JSON.stringify(o);
    }
    function _hash(s) {
        var A = _AI();
        if (A && typeof A.hash16 === 'function') return A.hash16(s);
        // FNV-1a fallback (same construction as hash16; only used when 53 is missing)
        var h1 = 0x811c9dc5, h2 = 0x050c5d1f, str = String(s == null ? '' : s);
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 16777619) >>> 0;
        }
        return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
    }
    function wellId(id) {
        if (id != null && id !== '') return String(id);
        try { var W = G.WTS_wells; var a = W && typeof W.active === 'function' ? W.active() : null; if (a) return String(a); } catch (e) { /* default */ }
        return 'default';
    }

    // ── base64 (own implementation: no btoa/atob needed, streams with a carry) ──
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64I = (function () { var t = new Int16Array(128); for (var i = 0; i < 128; i++) t[i] = -1; for (var j = 0; j < 64; j++) t[B64.charCodeAt(j)] = j; return t; })();
    // bytes (Uint8Array) [a, b) + carry (≤ 2 bytes) → {text, carry}
    function _b64Chunk(bytes, carry, last) {
        var buf;
        if (carry && carry.length) { buf = new Uint8Array(carry.length + bytes.length); buf.set(carry, 0); buf.set(bytes, carry.length); }
        else buf = bytes;
        var n = buf.length, full = last ? n : n - (n % 3), out = [], i, part = '';
        for (i = 0; i + 2 < full; i += 3) {
            var v = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
            part += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
            if (part.length >= 8192) { out.push(part); part = ''; }
        }
        if (last && i < n) {
            var r = n - i, w = (buf[i] << 16) | (r > 1 ? buf[i + 1] << 8 : 0);
            part += B64[(w >> 18) & 63] + B64[(w >> 12) & 63] + (r > 1 ? B64[(w >> 6) & 63] : '=') + '=';
            i = n;
        }
        out.push(part);
        return { text: out.join(''), carry: last ? null : buf.slice(full) };
    }
    function _b64Decode(s) {
        s = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
        var n = Math.floor(s.length * 3 / 4), out = new Uint8Array(n), o = 0, acc = 0, bits = 0;
        for (var i = 0; i < s.length; i++) {
            var v = B64I[s.charCodeAt(i)];
            if (v < 0) continue;
            acc = (acc << 6) | v; bits += 6;
            if (bits >= 8) { bits -= 8; if (o < n) out[o++] = (acc >> bits) & 255; }
        }
        return o === n ? out : out.slice(0, o);
    }
    function _int32Bytes(a) { return new Uint8Array(a.buffer, a.byteOffset, a.byteLength); }
    function _bytesInt32(u8) {
        var n = Math.floor(u8.length / 4), out = new Int32Array(n), dv = new DataView(u8.buffer, u8.byteOffset, n * 4);
        for (var i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, true);
        return out;
    }
    var LE = (function () { var a = new Uint16Array([1]); return new Uint8Array(a.buffer)[0] === 1; })();

    // ── encode / decode (delta int32) ──
    function _arr(x) { return (x && typeof x.length === 'number') ? x : []; }
    function _tScale(t, n) {
        var o = n ? +t[0] : 0, whole = true, maxD = 0;
        for (var i = 0; i < n; i++) {
            if (whole && (+t[i] - o) % 1000 !== 0) whole = false;
            if (i) { var d = Math.abs(+t[i] - +t[i - 1]); if (d > maxD) maxD = d; }
        }
        var sc = whole ? 1000 : 1;
        while (maxD / sc >= 2147483647) sc *= 10;
        return sc;
    }
    function _meta(rec) {
        var m = {};
        ['ok', 'source', 'name', 'zone', 'pUnitIn', 'patm', 'elapsed', 'rollup', 'hash', 'warnings'].forEach(function (k) { if (_own(rec, k)) m[k] = rec[k]; });
        return m;
    }
    function _encState(rec) {
        var t = _arr(rec && rec.t), p = _arr(rec && rec.p), T = rec && rec.T && rec.T.length ? rec.T : null;
        var n = Math.min(t.length, p.length);
        return { rec: rec, t: t, p: p, T: T, n: n, i: 0, origin: n ? +t[0] : (rec && _fin(rec.origin_ms) ? rec.origin_ms : 0),
            sc: _tScale(t, n), lt: null, lp: 0, lT: 0, bt: [], bp: [], bT: [], ct: null, cp: null, cT: null };
    }
    function _encStep(st, upto) {
        var a = st.i, b = Math.min(st.n, upto), len = b - a, i;
        if (len <= 0 && st.i < st.n) return;
        var dt = new Int32Array(len), dp = new Int32Array(len), dT = st.T ? new Int32Array(len) : null;
        for (i = a; i < b; i++) {
            var tv = Math.round((+st.t[i] - st.origin) / st.sc), pv = Math.round(+st.p[i] / P_SCALE);
            dt[i - a] = st.lt == null ? tv : tv - st.lt; st.lt = tv;
            dp[i - a] = pv - st.lp; st.lp = pv;
            if (dT) { var Tv = _fin(+st.T[i]) ? Math.round(+st.T[i] / T_SCALE) : st.lT; dT[i - a] = Tv - st.lT; st.lT = Tv; }
        }
        var last = b >= st.n;
        var r1 = _b64Chunk(LE ? _int32Bytes(dt) : _beBytes(dt), st.ct, last); st.bt.push(r1.text); st.ct = r1.carry;
        var r2 = _b64Chunk(LE ? _int32Bytes(dp) : _beBytes(dp), st.cp, last); st.bp.push(r2.text); st.cp = r2.carry;
        if (dT) { var r3 = _b64Chunk(LE ? _int32Bytes(dT) : _beBytes(dT), st.cT, last); st.bT.push(r3.text); st.cT = r3.carry; }
        st.i = b;
    }
    function _beBytes(a) { var u = new Uint8Array(a.length * 4), dv = new DataView(u.buffer); for (var i = 0; i < a.length; i++) dv.setInt32(i * 4, a[i], true); return u; }
    function _encDone(st) {
        if (st.n === 0) { st.bt = ['']; st.bp = ['']; if (st.T) st.bT = ['']; }
        return { v: 1, origin_ms: st.origin, tScale_ms: st.sc, pScale: P_SCALE, TScale: T_SCALE, n: st.n,
            tB64: st.bt.join(''), pB64: st.bp.join(''), TB64: st.T ? st.bT.join('') : null, meta: _meta(st.rec || {}) };
    }
    function encode(record) {
        var st = _encState(record || {});
        if (st.n === 0) return _encDone(st);
        _encStep(st, st.n);
        return _encDone(st);
    }
    function encodeJob(record) {
        var st = _encState(record || {}), done = st.n === 0, out = done ? _encDone(st) : null, cancelled = false;
        return {
            step: function () {
                if (!done && !cancelled) {
                    _encStep(st, st.i + ENCODE_UNIT);
                    if (st.i >= st.n) { done = true; out = _encDone(st); }
                }
                return { done: done || cancelled, progress: st.n ? st.i / st.n : 1, label: 'Storing raw gauge data' };
            },
            result: function () { return out; },
            cancel: function () { cancelled = true; },
            units: Math.max(1, Math.ceil(st.n / ENCODE_UNIT))
        };
    }
    // n of an encoded record: a non-negative integer up to MAX_N samples (a crafted or damaged entry is refused).
    var MAX_N = 2e7;
    function _validN(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n && n <= MAX_N; }
    // Base64 length of n int32 values as the encoder writes it (padded): 4·ceil(4n/3).
    function _b64LenFor(n) { return 4 * Math.ceil(4 * n / 3); }
    function _b64Consistent(e) {
        if (!_isEncoded(e) || !_validN(e.n)) return false;
        var L = _b64LenFor(e.n);
        if (e.tB64.length !== L || e.pB64.length !== L) return false;
        return e.TB64 == null || (typeof e.TB64 === 'string' && e.TB64.length === L);
    }
    // GaugeRecord header fields copied from meta, by name and type only (never the prototype or unknown keys).
    var META_TYPES = { ok: 'boolean', source: 'string', name: 'string', pUnitIn: 'string', patm: 'number', elapsed: 'boolean', rollup: 'boolean', hash: 'string' };
    function _metaCopy(m, rec) {
        if (!m || typeof m !== 'object') return;
        Object.keys(META_TYPES).forEach(function (k) {
            if (!_own(m, k) || typeof m[k] !== META_TYPES[k] || (META_TYPES[k] === 'number' && !isFinite(m[k]))) return;
            rec[k] = META_TYPES[k] === 'string' ? String(m[k]).slice(0, 400) : m[k];
        });
        var z = _own(m, 'zone') ? m.zone : null;
        if (z && typeof z === 'object' && typeof z.mode === 'string') {
            var zc = { mode: String(z.mode).slice(0, 16) };
            if (typeof z.tz === 'string') zc.tz = String(z.tz).slice(0, 64);
            if (_fin(z.offset_h)) zc.offset_h = z.offset_h;
            rec.zone = zc;
        }
        if (_own(m, 'warnings') && Array.isArray(m.warnings)) {
            rec.warnings = m.warnings.slice(0, 200).filter(function (w) { return w && typeof w === 'object' && !Array.isArray(w); }).map(function (w) {
                return { code: String(w.code == null ? '' : w.code).slice(0, 60), level: w.level === 'bad' || w.level === 'warn' ? w.level : 'info',
                    text: String(w.text == null ? '' : w.text).slice(0, 298), ev: Array.isArray(w.ev) ? w.ev.filter(function (x) { return typeof x === 'string'; }).slice(0, 12) : [] };
            });
        }
    }
    function decode(obj) {
        if (!obj || typeof obj !== 'object' || !_validN(obj.n)) return null;
        var dt = _bytesInt32(_b64Decode(obj.tB64)), dp = _bytesInt32(_b64Decode(obj.pB64));
        if (dt.length < obj.n || dp.length < obj.n) return null;    // a truncated stream is not a record
        var n = obj.n, t = new Float64Array(n), p = new Float64Array(n), T = null;
        var sc = _fin(obj.tScale_ms) ? obj.tScale_ms : 1, ps = _fin(obj.pScale) ? obj.pScale : P_SCALE, o = _fin(obj.origin_ms) ? obj.origin_ms : 0;
        var at = 0, ap = 0, i;
        for (i = 0; i < n && i < dt.length; i++) { at += dt[i]; t[i] = o + at * sc; }
        for (i = 0; i < n && i < dp.length; i++) { ap += dp[i]; p[i] = Math.round(ap) * ps; p[i] = Number(p[i].toFixed(6)); }
        if (obj.TB64) {
            var dT = _bytesInt32(_b64Decode(obj.TB64)), aT = 0, Ts = _fin(obj.TScale) ? obj.TScale : T_SCALE;
            T = new Float64Array(n);
            for (i = 0; i < n && i < dT.length; i++) { aT += dT[i]; T[i] = Number((aT * Ts).toFixed(6)); }
        }
        var rec = { ok: true, origin_ms: n ? t[0] : o, t: t, p: p, T: T, n: n };
        _metaCopy(obj.meta, rec);
        rec.ok = true;
        if (!rec.warnings) rec.warnings = [];
        return rec;
    }
    // A decoded record is used only when its samples re-hash to the hash it carries (WTS_buildup.data.recordHash:
    // the parser rounds every time to whole ms and the store keeps p to 0.001 psi, so a stored record re-hashes
    // exactly). rec.hashVerified tells the page the check ran; a mismatch (a truncated or edited entry) → null.
    function _verifyRec(rec) {
        if (!rec) return null;
        var D = B.data;
        if (!D || typeof D.recordHash !== 'function') { rec.hashVerified = false; return rec; }
        var h = null;
        try { h = D.recordHash(rec.t, rec.p); } catch (e) { h = null; }
        if (!h || h !== rec.hash) return null;
        rec.hashVerified = true;
        return rec;
    }
    function _encodedChars(e) { return e ? (String(e.tB64 || '').length + String(e.pB64 || '').length + String(e.TB64 || '').length + 512) : 0; }

    // ── IndexedDB with a memory mirror ──
    // Mirror maps have no prototype, so a well id such as '__proto__' from a project file is an ordinary key.
    function _map() { return Object.create(null); }
    var _mem = { raw: _map(), tests: _map() };
    var _db = null, _dbP = null, _engine = null;
    function _idb() { try { return G.indexedDB || null; } catch (e) { return null; } }
    function _openDb() {
        var P = _P();
        if (_db) return P.resolve(_db);
        if (_dbP) return _dbP;
        var I = _idb();
        if (!I || typeof I.open !== 'function') { _engine = 'memory'; return P.resolve(null); }
        _dbP = new P(function (res) {
            var req;
            try { req = I.open(DB_NAME, DB_VER); } catch (e) { _engine = 'memory'; res(null); return; }
            req.onupgradeneeded = function () {
                try {
                    var db = req.result;
                    if (!db.objectStoreNames || typeof db.objectStoreNames.contains !== 'function' || !db.objectStoreNames.contains('raw')) db.createObjectStore('raw');
                    if (!db.objectStoreNames || typeof db.objectStoreNames.contains !== 'function' || !db.objectStoreNames.contains('tests')) db.createObjectStore('tests');
                } catch (e) { /* the success/error handler decides */ }
            };
            req.onsuccess = function () { _db = req.result; _engine = 'idb'; res(_db); };
            req.onerror = function () { _engine = 'memory'; res(null); };
            req.onblocked = function () { _engine = 'memory'; res(null); };
        });
        return _dbP;
    }
    function _tx(store, mode, fn) {
        var P = _P();
        return _openDb().then(function (db) {
            if (!db) return null;
            return new P(function (res) {
                var t, r;
                try { t = db.transaction(store, mode); r = fn(t.objectStore(store)); } catch (e) { res(null); return; }
                if (mode === 'readonly' && r) { r.onsuccess = function () { res(r.result === undefined ? null : r.result); }; r.onerror = function () { res(null); }; return; }
                t.oncomplete = function () { res(true); };
                t.onerror = function () { res(null); };
                t.onabort = function () { res(null); };
            });
        }, function () { return null; });
    }
    // Mirror warm-up: every record already in IndexedDB is copied into the memory mirror (entries written
    // since are kept), so a project File → Save in a fresh session embeds every well instead of listing it
    // under `omitted`. Runs once per opened database; a project Open / New / reset in between (generation
    // change) discards the read.
    var _gen = 0, _warmP = null;
    function _readAll(db, store) {
        var P = _P();
        return new P(function (res) {
            var out = _map();
            try {
                var t = db.transaction(store, 'readonly'), s = t.objectStore(store);
                if (typeof s.getAllKeys !== 'function') { res(out); return; }
                var r = s.getAllKeys();
                r.onsuccess = function () {
                    (r.result || []).forEach(function (k) {
                        var g = s.get(k);
                        g.onsuccess = function () { if (g.result != null) out[String(k)] = g.result; };
                    });
                };
                t.oncomplete = function () { res(out); }; t.onerror = function () { res(out); }; t.onabort = function () { res(out); };
            } catch (e) { res(out); }
        });
    }
    function _warm(db) {
        var P = _P();
        if (!db) return P.resolve(0);
        if (_warmP) return _warmP;
        var g0 = _gen;
        _warmP = P.all([_readAll(db, 'raw'), _readAll(db, 'tests')]).then(function (r) {
            if (g0 !== _gen) { _warmP = null; return 0; }    // superseded: a later init() reads again
            var n = 0;
            for (var id in r[0]) if (_own(r[0], id) && !_own(_mem.raw, id) && _isEncoded(r[0][id])) { _mem.raw[id] = r[0][id]; n++; }
            for (var id2 in r[1]) if (_own(r[1], id2) && !_own(_mem.tests, id2) && r[1][id2] && typeof r[1][id2] === 'object') { _mem.tests[id2] = r[1][id2]; n++; }
            return n;
        }, function () { return 0; });
        return _warmP;
    }
    function init() { return _openDb().then(function (db) { return _warm(db); }).then(function () { return { engine: _engine || 'memory' }; }); }
    function _isEncoded(x) { return !!x && typeof x === 'object' && typeof x.tB64 === 'string' && typeof x.pB64 === 'string'; }
    // Resolves {ok, engine}: ok is true only when IndexedDB holds the record (the mirror always does, for this session).
    function putRaw(id, rec) {
        id = wellId(id);
        var enc = _isEncoded(rec) ? rec : encode(rec || {});
        _mem.raw[id] = enc;
        return _tx('raw', 'readwrite', function (s) { return s.put(enc, id); }).then(function (v) { return { ok: v === true, engine: _engine || 'memory' }; });
    }
    function getRawEncoded(id) {
        id = wellId(id);
        if (_own(_mem.raw, id)) return _P().resolve(_mem.raw[id]);
        return _tx('raw', 'readonly', function (s) { return s.get(id); }).then(function (v) {
            if (v && _isEncoded(v)) { _mem.raw[id] = v; return v; }
            return null;
        });
    }
    function getRaw(id) { return getRawEncoded(id).then(function (e) { return e ? _verifyRec(decode(e)) : null; }); }
    function putTests(id, obj) {
        id = wellId(id);
        var v = (obj && typeof obj === 'object') ? obj : {};
        _mem.tests[id] = v;
        return _tx('tests', 'readwrite', function (s) { return s.put(v, id); }).then(function (r) { return { ok: r === true, engine: _engine || 'memory' }; });
    }
    function getTests(id) {
        id = wellId(id);
        if (_own(_mem.tests, id)) return _P().resolve(_mem.tests[id]);
        return _tx('tests', 'readonly', function (s) { return s.get(id); }).then(function (v) {
            if (v && typeof v === 'object') { _mem.tests[id] = v; return v; }
            return null;
        });
    }
    function _drop(store, id) {
        _gen++;
        delete _mem[store][id];
        return _tx(store, 'readwrite', function (s) { return s.delete(id); });
    }
    function _clear(store) {
        _gen++;
        _mem[store] = _map();
        return _tx(store, 'readwrite', function (s) { return s.clear(); });
    }

    // ── wts_buildup_state ──
    function stripResult(r) {
        if (!r || typeof r !== 'object') return r;
        var c = {}, k;
        for (k in r) if (_own(r, k) && k !== 'curves') c[k] = r[k];
        if (r.bins && typeof r.bins === 'object') {
            var b = {};
            for (k in r.bins) if (_own(r.bins, k) && k !== 'X' && k !== 'dte') b[k] = r.bins[k];
            c.bins = b;
        }
        return c;
    }
    function _sumResult(r) {
        if (!r || typeof r !== 'object') return r;
        return { ok: r.ok, id: r.id, version: r.version, inputHash: r.inputHash, testType: r.testType, reason: r.reason || null,
            final: r.final || null, sErr: r.sErr ? { value: r.sErr.value, mode: r.sErr.mode } : null,
            confidence: r.confidence ? { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline, stage: r.confidence.stage } : null,
            chosen: r.chosen ? { key: r.chosen.key, label: r.chosen.label } : null,
            iarf: r.iarf ? { found: r.iarf.found, grade: r.iarf.grade, cycles: r.iarf.cycles, dt0_h: r.iarf.dt0_h, dt1_h: r.iarf.dt1_h } : null,
            evidence: r.evidence || null, summary: true };
    }
    function _json(o) { try { return JSON.stringify(o); } catch (e) { return null; } }
    function _bytes(s) {
        var n = 0;
        for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3; }
        return n;
    }
    function _write(key, txt) {
        if (typeof G.WTS_lsSet === 'function') { try { return G.WTS_lsSet(key, txt) !== false; } catch (e) { return false; } }
        var ls = _ls();
        if (!ls) return false;
        try { ls.setItem(key, txt); return true; } catch (e) { return false; }
    }
    function _shallow(o) { var c = {}; for (var k in o) if (_own(o, k)) c[k] = o[k]; return c; }
    // Arrays whose length grows with the record (thousands of gaps on a 15-min flowing / 1-min shut-in record)
    // are capped in the stored copy; the counts and totals the review quotes (gapCount, gapTotal_h, longestGap_h,
    // spikes.count, missed list lengths) are kept, and the full lists come back with the next detection run.
    var GAP_FIRST = 10, GAP_LONGEST = 20, SPIKE_IDX = 50, FAST_T = 40, WARN_MAX = 40, EV_WARN_MAX = 8, MISSED_MAX = 500;
    function _capList(a, n) { return Array.isArray(a) && a.length > n ? a.slice(0, n) : a; }
    function _capGaps(gaps) {
        if (!Array.isArray(gaps) || gaps.length <= GAP_FIRST + GAP_LONGEST) return gaps;
        var idx = gaps.map(function (g, i) { return i; });
        var keep = {}, i;
        for (i = 0; i < GAP_FIRST; i++) keep[i] = 1;
        idx.slice(GAP_FIRST).sort(function (x, y) { return ((gaps[y] && gaps[y].dur_h) || 0) - ((gaps[x] && gaps[x].dur_h) || 0) || x - y; })
            .slice(0, GAP_LONGEST).forEach(function (j) { keep[j] = 1; });
        return idx.filter(function (j) { return keep[j]; }).map(function (j) { return gaps[j]; });
    }
    function _compactAnalysis(a) {
        var ac = _shallow(a), k;
        if (a.qc && typeof a.qc === 'object') {
            var q = ac.qc = _shallow(a.qc);
            if (Array.isArray(a.qc.gaps) && a.qc.gaps.length > GAP_FIRST + GAP_LONGEST) {
                q.gaps = _capGaps(a.qc.gaps);
                q.gapsStored = { kept: q.gaps.length, total: a.qc.gaps.length, rule: 'first ' + GAP_FIRST + ' and longest ' + GAP_LONGEST };
                if (!_fin(q.gapCount)) q.gapCount = a.qc.gaps.length;
            }
            if (a.qc.spikes && Array.isArray(a.qc.spikes.idx) && a.qc.spikes.idx.length > SPIKE_IDX) { q.spikes = _shallow(a.qc.spikes); q.spikes.idx = a.qc.spikes.idx.slice(0, SPIKE_IDX); }
            if (a.qc.temperature && Array.isArray(a.qc.temperature.fastChanges) && a.qc.temperature.fastChanges.length > FAST_T) {
                q.temperature = _shallow(a.qc.temperature);
                q.temperature.fastChanges = a.qc.temperature.fastChanges.slice().sort(function (x, y) { return Math.abs((y && y.dT_F) || 0) - Math.abs((x && x.dT_F) || 0); })
                    .slice(0, FAST_T).sort(function (x, y) { return ((x && x.t_ms) || 0) - ((y && y.t_ms) || 0); });
            }
            q.plausibility = _capList(a.qc.plausibility, WARN_MAX);
        }
        if (Array.isArray(a.events)) ac.events = a.events.map(function (e) {
            if (!e || !Array.isArray(e.warnings) || e.warnings.length <= EV_WARN_MAX) return e;
            var ec = _shallow(e); ec.warnings = e.warnings.slice(0, EV_WARN_MAX); return ec;
        });
        if (a.missed && typeof a.missed === 'object') {
            var m = ac.missed = _shallow(a.missed);
            ['subThreshold', 'allocOnly', 'gaps'].forEach(function (key) { m[key] = _capList(a.missed[key], MISSED_MAX); });
        }
        ac.warnings = _capList(a.warnings, WARN_MAX);
        if (a.rates && typeof a.rates === 'object' && Array.isArray(a.rates.warnings) && a.rates.warnings.length > WARN_MAX) { ac.rates = _shallow(a.rates); ac.rates.warnings = a.rates.warnings.slice(0, WARN_MAX); }
        if (a.trend && typeof a.trend === 'object' && Array.isArray(a.trend.warnings) && a.trend.warnings.length > WARN_MAX) { ac.trend = _shallow(a.trend); ac.trend.warnings = a.trend.warnings.slice(0, WARN_MAX); }
        for (k in ac) if (_own(ac, k) && ac[k] === undefined) delete ac[k];
        return ac;
    }
    function _copyState(st) {
        var c = _shallow(st);
        var a = st.analysis;
        if (a && typeof a === 'object' && Array.isArray(a.tests)) {
            var ac = _compactAnalysis(a);
            ac.tests = a.tests.map(function (t) {
                if (!t || typeof t !== 'object') return t;
                var tc = _shallow(t);
                tc.result = stripResult(t.result);
                return tc;
            });
            c.analysis = ac;
        }
        return c;
    }
    function saveState(state, opts) {
        opts = opts || {};
        if (!state || typeof state !== 'object') return { ok: false, bytes: 0, overflow: false };
        var id = wellId(opts.wellId);
        var c = _copyState(state);
        c.v = 1;
        delete c.overflow;
        var txt = _json(c);
        if (txt == null) return { ok: false, bytes: 0, overflow: false };
        var bytes = _bytes(txt), overflow = false, overflowWrite = null;
        if (bytes > STATE_CAP && c.analysis && Array.isArray(c.analysis.tests)) {
            // Overflow: per-test arrays and results go to the IndexedDB 'tests' store.
            var parked = {}, ids = [];
            c.analysis.tests = c.analysis.tests.map(function (t) {
                if (!t || typeof t !== 'object') return t;
                var spec = t.spec || {}, sc = {}, k;
                parked[t.id] = { spec: { dt: spec.dt || null, p: spec.p || null, n: spec.n == null ? null : spec.n }, result: t.result || null };
                ids.push(t.id);
                for (k in spec) if (_own(spec, k) && k !== 'dt' && k !== 'p' && k !== 'n') sc[k] = spec[k];
                var tc = {};
                for (k in t) if (_own(t, k)) tc[k] = t[k];
                tc.spec = sc;
                tc.result = _sumResult(t.result);
                return tc;
            });
            c.overflow = { wellId: id, tests: ids };
            // The parked detail is in the mirror at once; overflowWrite resolves {ok, engine} once IndexedDB holds it
            // (ok:false without IndexedDB or on a failed write: the detail is then lost at the next reload).
            overflowWrite = putTests(id, parked);
            txt = _json(c);
            bytes = _bytes(txt);
            overflow = true;
            if (bytes > STATE_CAP && Array.isArray(c.qa) && c.qa.length) { c.qa = c.qa.slice(-5); txt = _json(c); bytes = _bytes(txt); }
        }
        var ok = bytes <= STATE_CAP && _write(STATE_KEY, txt);
        var res = { ok: ok, bytes: bytes, overflow: overflow };
        if (overflowWrite) res.overflowWrite = overflowWrite;
        return res;
    }
    function loadState() {
        var ls = _ls();
        if (!ls) return null;
        var raw = null;
        try { raw = ls.getItem(STATE_KEY); } catch (e) { raw = null; }
        if (!raw) return null;
        var o = null;
        try { o = JSON.parse(raw); } catch (e) { o = null; }
        return (o && typeof o === 'object' && o.v === 1) ? o : null;
    }
    // Overflowed tests back into a loaded state (Promise; resolves to the state).
    function rehydrate(state) {
        var P = _P();
        if (!state || !state.overflow || !state.analysis || !Array.isArray(state.analysis.tests)) return P.resolve(state);
        return getTests(state.overflow.wellId).then(function (parked) {
            if (!parked) { state.overflowMissing = true; return state; }
            state.analysis.tests.forEach(function (t) {
                var q = t && parked[t.id];
                if (!q) return;
                t.spec = t.spec || {};
                if (q.spec) { t.spec.dt = q.spec.dt; t.spec.p = q.spec.p; t.spec.n = q.spec.n; }
                if (q.result) t.result = q.result;
            });
            delete state.overflow;
            return state;
        });
    }

    // ── wts_buildup_audit (append-only chain) ──
    // {log, state, raw}: state 'missing' (no log yet), 'ok', or 'unreadable' (text present but not a v1 log: it is
    // never overwritten in place — auditAppend first keeps it under AUDIT_KEY + '_corrupt_<ms>').
    function _auditLoad() {
        var ls = _ls(), raw = null, o = null;
        try { raw = ls ? ls.getItem(AUDIT_KEY) : null; } catch (e) { raw = null; }
        if (raw == null || raw === '') return { log: { v: 1, entries: [], summary: null }, state: 'missing', raw: null };
        try { o = JSON.parse(raw); } catch (e) { o = null; }
        if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.entries)) return { log: { v: 1, entries: [], summary: null }, state: 'unreadable', raw: String(raw) };
        if (!_own(o, 'summary')) o.summary = null;
        if (_own(o, 'lost') && !(o.lost && typeof o.lost === 'object')) delete o.lost;
        return { log: o, state: 'ok', raw: null };
    }
    function _auditRead() { return _auditLoad().log; }
    // The chain uses the review's recipe (WTS_buildup.review.audit.entryHash and GENESIS): hash16(prevHash +
    // canon(entry without hash)) with every numeric leaf serialised exactly first, so canon sorts the keys but rounds
    // nothing and an edit at any digit breaks the chain. The first entry links to GENESIS.
    var GENESIS = '0000000000000000';
    function _exactLeaves(v) {
        if (typeof v === 'number') return 'n:' + String(v);
        if (Array.isArray(v)) return v.map(_exactLeaves);
        if (v !== null && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = _exactLeaves(v[k]); }); return o; }
        return v;
    }
    function _entryHash(prev, e) {
        var c = {}, k;
        for (k in e) if (_own(e, k) && k !== 'hash') c[k] = e[k];
        return _hash(String(prev || '') + _canon(_exactLeaves(c), 'inputs'));
    }
    function chainHash() {
        var a = _auditRead();
        if (a.entries.length) return a.entries[a.entries.length - 1].hash || GENESIS;
        return (a.summary && a.summary.chainHash) || GENESIS;
    }
    function _fold(a, keep) {
        var nFold = a.entries.length - (keep == null ? AUDIT_KEEP : keep);
        if (nFold <= 0) return a;
        var folded = a.entries.slice(0, nFold), s = a.summary || { from: null, to: null, n: 0, counts: {}, chainHash: '' };
        var counts = {}, k;
        for (k in (s.counts || {})) if (_own(s.counts, k)) counts[k] = s.counts[k];
        folded.forEach(function (e) { counts[e.kind] = (counts[e.kind] || 0) + 1; });
        a.summary = { from: s.from || folded[0].at, to: folded[folded.length - 1].at, n: (s.n || 0) + folded.length,
            fromSeq: s.fromSeq || folded[0].seq, toSeq: folded[folded.length - 1].seq, counts: counts, chainHash: folded[folded.length - 1].hash };
        a.entries = a.entries.slice(nFold);
        return a;
    }
    // Returns the stored entry, or null when it could not be stored (device storage full, or an unreadable log
    // whose text could not be kept aside): the caller then changes nothing.
    function auditAppend(entry) {
        var L = _auditLoad(), a = L.log;
        if (L.state === 'unreadable') {
            // Keep the unreadable text as it is, then start a new chain that records the loss for good (S10 shows it).
            var key = AUDIT_KEY + '_corrupt_' + Date.now();
            if (!_write(key, L.raw)) return null;
            a = { v: 1, entries: [], summary: null, lost: { at: new Date().toISOString(), key: key, chars: L.raw.length } };
        }
        var last = a.entries.length ? a.entries[a.entries.length - 1] : null;
        var prev = last ? last.hash : ((a.summary && a.summary.chainHash) || GENESIS);
        var seq = last ? (last.seq + 1) : ((a.summary && a.summary.toSeq) ? a.summary.toSeq + 1 : 1);
        var e = {
            seq: seq, at: (entry && entry.at) || new Date().toISOString(), who: String((entry && entry.who) || ''),
            kind: String((entry && entry.kind) || 'note'), target: (entry && entry.target != null) ? entry.target : null,
            value: (entry && entry.value !== undefined) ? entry.value : null, reason: String((entry && entry.reason) || ''),
            appVersion: String((entry && entry.appVersion) || ''), inputsHash: (entry && entry.inputsHash) || null,
            resultsHash: (entry && entry.resultsHash) || null, prevHash: prev
        };
        e.hash = _entryHash(prev, e);
        a.entries.push(e);
        if (a.entries.length > AUDIT_MAX) _fold(a);
        var txt = _json(a);
        while (txt && _bytes(txt) > AUDIT_CAP && a.entries.length > 20) {
            _fold(a, Math.max(20, Math.floor(a.entries.length * 0.75)));
            txt = _json(a);
        }
        var ok = txt != null && _write(AUDIT_KEY, txt);
        return ok ? e : null;
    }
    function _verifyLog(a) {
        var prev = (a.summary && a.summary.chainHash) || GENESIS;
        for (var i = 0; i < a.entries.length; i++) {
            var e = a.entries[i];
            if (!e || typeof e !== 'object' || e.prevHash !== prev || _entryHash(prev, e) !== e.hash) return { ok: false, at: e && _fin(e.seq) ? e.seq : i + 1, n: a.entries.length };
            prev = e.hash;
        }
        return { ok: true, n: a.entries.length, folded: a.summary ? a.summary.n : 0, chainHash: prev };
    }
    function auditVerify() {
        var L = _auditLoad();
        if (L.state === 'unreadable') return { ok: false, at: null, n: 0, unreadable: true };
        return _verifyLog(L.log);
    }
    // {state: 'missing'|'ok'|'broken'|'unreadable', brokenAt, lost, lastRunSeq}: brokenAt is the first entry that does
    // not verify; lost is the record of an earlier unreadable log ({at, key, chars}); lastRunSeq the latest 'run' entry.
    function auditStatus() {
        var L = _auditLoad();
        if (L.state === 'unreadable') return { state: 'unreadable', brokenAt: null, lost: null, lastRunSeq: null };
        var v = _verifyLog(L.log), lastRun = null;
        L.log.entries.forEach(function (e) { if (e && e.kind === 'run' && _fin(e.seq)) lastRun = e.seq; });
        return { state: !v.ok ? 'broken' : (L.state === 'missing' ? 'missing' : 'ok'), brokenAt: v.ok ? null : v.at, lost: L.log.lost || null, lastRunSeq: lastRun };
    }

    // ── project-file modules (buildup_raw, buildup_analysis) ──
    var _loaded = { raw: null, tests: null };
    // Wells whose stored analysis needs this store: every analysis for 'raw', overflowed analyses for 'tests'
    // (the state text holds "overflow":{"wellId"…, escaped once more inside a parked well's blob).
    var OVERFLOW_RE = /overflow\\?"\s*:\s*\{\s*\\?"wellId/;
    function _wellsWithAnalysis(store) {
        var out = [], ls = _ls();
        if (!ls) return out;
        var act = wellId(), need = function (txt) { return !!txt && (store !== 'tests' || OVERFLOW_RE.test(txt)); };
        try { if (need(ls.getItem(STATE_KEY))) out.push(act); } catch (e) { /* none */ }
        try {
            var W = G.WTS_wells, list = W && typeof W.list === 'function' ? W.list() : [];
            (list || []).forEach(function (w) {
                if (!w || w.active || out.indexOf(w.id) !== -1) return;
                var b = null;
                try { b = ls.getItem('wts_well_' + w.id); } catch (e) { b = null; }
                if (b && b.indexOf(STATE_KEY) !== -1 && need(b)) out.push(String(w.id));
            });
        } catch (e) { /* single well */ }
        return out;
    }
    function _modRead(store) {
        var wells = {}, omitted = [], total = 0, any = false;
        var keys = Object.keys(_mem[store]).sort();
        var act = wellId();
        keys.sort(function (a, b) { return (a === act ? -1 : 0) - (b === act ? -1 : 0); });
        keys.forEach(function (id) {
            var v = _mem[store][id];
            if (v == null) return;
            var sz = store === 'raw' ? _encodedChars(v) : ((_json(v) || '').length);
            if (store === 'raw' && total + sz > RAW_CAP) { omitted.push(id); return; }
            total += sz; wells[id] = v; any = true;
        });
        _wellsWithAnalysis(store).forEach(function (id) { if (!_own(wells, id) && omitted.indexOf(id) === -1) omitted.push(id); });
        if (!any && !omitted.length) return null;
        return { wells: wells, omitted: omitted };
    }
    // Well ids accepted from a project file: the app's ids ('w1', 'default', …), never a prototype key.
    var SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/, BAD_ID = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
    function _safeId(id) { return typeof id === 'string' && SAFE_ID.test(id) && !_own(BAD_ID, id); }
    function _modWrite(store, state) {
        if (state === null) { _loaded[store] = []; _clear(store); return; }
        if (!state || typeof state !== 'object' || !state.wells || typeof state.wells !== 'object') return;
        var ids = [], total = 0;
        Object.keys(state.wells).forEach(function (id) {
            if (!_safeId(id)) return;
            var v = state.wells[id];
            if (store === 'raw') {
                // the shape the encoder writes (n a sample count, base64 lengths of 4·n bytes) and RAW_CAP in total, as on Save
                if (!_b64Consistent(v)) return;
                var sz = _encodedChars(v);
                if (total + sz > RAW_CAP) return;
                total += sz;
            } else if (!v || typeof v !== 'object' || Array.isArray(v)) return;
            _mem[store][id] = v; ids.push(id);
        });
        _loaded[store] = ids;
        ids.forEach(function (wid) { var v = _mem[store][wid]; _tx(store, 'readwrite', function (s) { return s.put(v, wid); }); });
    }
    function _prune(store, keepIds) {
        Object.keys(_mem[store]).forEach(function (id) { if (keepIds.indexOf(id) === -1) delete _mem[store][id]; });
        return _openDb().then(function (db) {
            if (!db) return;
            return new (_P())(function (res) {
                try {
                    var t = db.transaction(store, 'readwrite'), s = t.objectStore(store);
                    if (typeof s.getAllKeys === 'function') {
                        var r = s.getAllKeys();
                        r.onsuccess = function () { (r.result || []).forEach(function (k) { if (keepIds.indexOf(String(k)) === -1) s.delete(k); }); };
                    } else if (typeof s.openCursor === 'function') {
                        var c = s.openCursor();
                        c.onsuccess = function () {
                            var cur = c.result;
                            if (!cur) return;
                            if (keepIds.indexOf(String(cur.key)) === -1) s.delete(cur.key);
                            cur['continue']();
                        };
                    } else if (!keepIds.length) s.clear();
                    t.oncomplete = function () { res(); }; t.onerror = function () { res(); }; t.onabort = function () { res(); };
                } catch (e) { res(); }
            });
        });
    }
    function _onProjectLoaded(e) {
        var d = (e && e.detail) || {};
        if (d.source === 'well') { _loaded.raw = null; _loaded.tests = null; return; }   // a well switch is not a project Open
        var keepRaw = _loaded.raw || [], keepTests = _loaded.tests || [];
        _loaded.raw = null; _loaded.tests = null;
        _prune('raw', keepRaw);
        _prune('tests', keepTests);
    }
    var _modsRegistered = false;
    function registerModules() {
        var P = G.WTS_project;
        if (_modsRegistered || !P || typeof P.registerModule !== 'function') return _modsRegistered;
        P.registerModule('buildup_raw', { read: function () { return _modRead('raw'); }, write: function (s) { _modWrite('raw', s); } });
        P.registerModule('buildup_analysis', { read: function () { return _modRead('tests'); }, write: function (s) { _modWrite('tests', s); } });
        _modsRegistered = true;
        return true;
    }
    registerModules();
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('wts:project-loaded', _onProjectLoaded);
    }
    // Warm the mirrors at load when this device holds a build-up analysis (an IndexedDB open request; no timers),
    // so File → Save before the page is opened still embeds the raw records and the parked build-ups.
    try { if (_idb() && _wellsWithAnalysis('raw').length) init(); } catch (e) { /* the page warms them on open */ }

    // ── public ──
    S.STATE_KEY = STATE_KEY; S.AUDIT_KEY = AUDIT_KEY; S.STATE_CAP = STATE_CAP; S.AUDIT_CAP = AUDIT_CAP; S.AUDIT_MAX = AUDIT_MAX;
    S.RAW_CAP = RAW_CAP; S.ENCODE_UNIT = ENCODE_UNIT;
    S.init = init; S.wellId = wellId;
    S.putRaw = putRaw; S.getRaw = getRaw; S.getRawEncoded = getRawEncoded; S.putTests = putTests; S.getTests = getTests;
    S.dropRaw = function (id) { return _drop('raw', wellId(id)); };
    S.dropTests = function (id) { return _drop('tests', wellId(id)); };
    S.hasRaw = function (id) { return _own(_mem.raw, wellId(id)); };
    S.rawHash = function (id) {
        var k = wellId(id), e = _own(_mem.raw, k) ? _mem.raw[k] : null;
        return (e && e.meta && _own(e.meta, 'hash') && typeof e.meta.hash === 'string') ? e.meta.hash || null : null;
    };
    S.encode = encode; S.encodeJob = encodeJob; S.decode = decode;
    S.loadState = loadState; S.saveState = saveState; S.rehydrate = rehydrate; S.stripResult = stripResult;
    S.registerModules = registerModules;
    S.audit = {
        list: function () { return _auditRead().entries.slice(); },
        append: auditAppend,
        summary: function () { return _auditRead().summary; },
        verify: auditVerify,
        status: auditStatus,
        chainHash: chainHash
    };
    S.engine = function () { return _engine || 'memory'; };
    S._mirror = function () { return _mem; };
    S._reset = function () { _db = null; _dbP = null; _engine = null; _mem = { raw: _map(), tests: _map() }; _loaded = { raw: null, tests: null }; };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var S = G.WTS_buildup && G.WTS_buildup.store, fails = [];
    if (!S) return;
    var t = [], p = [];
    for (var i = 0; i < 1000; i++) { t.push(1772323200000 + i * 60000); p.push(2500 + Math.sin(i / 50) * 12.3456); }
    var e = S.encode({ t: t, p: p, T: null, n: 1000, hash: 'abc', name: 'x' }), d = S.decode(e);
    if (!d || d.n !== 1000 || d.t[999] !== t[999] || Math.abs(d.p[500] - p[500]) > 0.0006) fails.push('encode/decode round trip');
    if (fails.length && typeof console !== 'undefined') console.error('[buildup-store self-test] FAILED: ' + fails.join('; '));
})();
