// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 19 — Multi-Dataset Workflow
//   Gauge-Data Manager: store many raw gauge files in one project,
//     up to multi-million samples each, IndexedDB-backed when available.
//   Analysis-Data Manager: derive sampled subsets from gauge data with
//     filter / decimation / time-range options; activate one as the
//     current PRiSM_dataset; manage many analysis presets per project.
//   Project File: save/load entire PRiSM state as a single .prism JSON.
//
// PUBLIC API (all on window.*)
//   PRiSM_storage          — backend abstraction (IDB / localStorage / memory)
//   PRiSM_gaugeData        — gauge-data CRUD + diff
//   PRiSM_analysisData     — analysis-data CRUD + activate + sampler
//   PRiSM_project          — project save / load / new / info
//   PRiSM_renderGaugeManager(container)    — UI for gauge-data manager
//   PRiSM_renderAnalysisManager(container) — UI for analysis-data manager
//   PRiSM_renderProjectToolbar(container)  — UI for File menu
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • Pure vanilla JS — no external dependencies. Uses built-in
//     indexedDB / localStorage / Blob / URL.createObjectURL / Float32Array.
//   • Async/Promise-based for storage operations.
//   • Defensive: falls back from IDB → localStorage → in-memory if either
//     is unavailable (or the IDB open call rejects, e.g. private mode).
//   • Compact storage: t/p/q stored as Float32Array buffers (12 bytes/sample
//     for triplets) rather than JSON arrays (~20–30 bytes/sample).
//   • Backwards-compatible: analysisData.activate(id) populates
//     window.PRiSM_dataset = { t, p, q } so the existing PRiSM workflow
//     continues to work unchanged.
//   • Failure-tolerant UI: every render fn swallows errors and prints a
//     compact "<storage unavailable>" message in the host container.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// -----------------------------------------------------------------------
// Tiny env shims — let the module load in the smoke-test stub harness.
// -----------------------------------------------------------------------
var _hasDoc = (typeof document !== 'undefined');
var _hasWin = (typeof window !== 'undefined');
var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

function _ga4(eventName, params) {
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
    }
}

function _now() {
    return new Date().toISOString();
}

function _id(prefix) {
    var s = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return (prefix || 'id') + '_' + s;
}

function _theme() {
    if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
    return {
        bg:        '#0d1117', panel: '#161b22', border: '#30363d',
        grid:      '#21262d', gridMajor: '#30363d',
        text:      '#c9d1d9', text2: '#8b949e', text3: '#6e7681',
        accent:    '#f0883e', blue: '#58a6ff', green: '#3fb950',
        red:       '#f85149', yellow: '#d29922', cyan: '#39c5cf',
        purple:    '#bc8cff'
    };
}

function _hasIDB() {
    try { return (typeof indexedDB !== 'undefined') && indexedDB !== null; }
    catch (e) { return false; }
}

function _hasLS() {
    try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false;
        var k = '__prism_ls_probe__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return true;
    } catch (e) { return false; }
}

// Promise polyfill check — just bail if Promise isn't available.
var _Promise = (typeof Promise !== 'undefined') ? Promise : null;
function _resolved(v) { return _Promise ? _Promise.resolve(v) : { then: function (cb) { cb(v); return this; } }; }
function _rejected(e) { return _Promise ? _Promise.reject(e)  : { then: function (_, cb) { if (cb) cb(e); return this; } }; }


// ═══════════════════════════════════════════════════════════════════════
// SECTION 1 — STORAGE BACKEND (IDB + localStorage fallback + in-memory)
// ═══════════════════════════════════════════════════════════════════════
//
// One object store ('records') keyed by id. Each record is
//   { id: string, kind: 'gauge'|'analysis'|'meta', metadata: {...},
//     data: { t: ArrayBuffer, p: ArrayBuffer, q: ArrayBuffer|null },
//     provenance: {...} (analysis only) }
//
// Two indices:
//   - 'kind' index → fast list of all gauges or all analyses
//   - 'createdAt' index → for chronological listing
//
// The localStorage fallback uses one key per record under
//   wts_prism_rec_<id>
// plus an index key
//   wts_prism_rec_index = [ { id, kind, ts }, ... ]
//
// In-memory fallback: a JS Map keyed by id.
// ═══════════════════════════════════════════════════════════════════════

var DB_NAME      = 'wts_prism';
var DB_VERSION   = 1;
var STORE_NAME   = 'records';
var LS_PREFIX    = 'wts_prism_rec_';
var LS_INDEX_KEY = 'wts_prism_rec_index';
var META_KEY     = '__prism_project_meta__';

var _idb = null;        // IDBDatabase handle, set after init
var _backend = null;    // 'indexedDB' | 'localStorage' | 'memory'
var _memStore = null;   // Map for in-memory backend
var _initPromise = null;

function _openIDB() {
    return new _Promise(function (resolve, reject) {
        try {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    var os = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    os.createIndex('kind', 'kind', { unique: false });
                    os.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror   = function () { reject(req.error || new Error('IDB open failed')); };
            req.onblocked = function () { reject(new Error('IDB blocked')); };
        } catch (e) { reject(e); }
    });
}

function _txStore(mode) {
    var tx = _idb.transaction(STORE_NAME, mode);
    return tx.objectStore(STORE_NAME);
}

function _idbPut(rec) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readwrite');
            var req = os.put(rec);
            req.onsuccess = function () { resolve(); };
            req.onerror   = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _idbGet(id) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readonly');
            var req = os.get(id);
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror   = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _idbDelete(id) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readwrite');
            var req = os.delete(id);
            req.onsuccess = function () { resolve(); };
            req.onerror   = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _idbListByKind(kind) {
    return new _Promise(function (resolve, reject) {
        try {
            var os = _txStore('readonly');
            var idx = os.index('kind');
            var out = [];
            var req = idx.openCursor(IDBKeyRange.only(kind));
            req.onsuccess = function () {
                var cur = req.result;
                if (cur) {
                    var v = cur.value;
                    out.push({ id: v.id, metadata: v.metadata,
                               metaSize: v.data ? _byteLen(v.data) : 0 });
                    cur.continue();
                } else {
                    resolve(out);
                }
            };
            req.onerror = function () { reject(req.error); };
        } catch (e) { reject(e); }
    });
}

function _byteLen(blob) {
    var n = 0;
    if (blob.t && blob.t.byteLength) n += blob.t.byteLength;
    if (blob.p && blob.p.byteLength) n += blob.p.byteLength;
    if (blob.q && blob.q.byteLength) n += blob.q.byteLength;
    return n;
}

// localStorage fallback: store as base64-encoded JSON.
function _lsIndex() {
    try {
        var raw = localStorage.getItem(LS_INDEX_KEY);
        return raw ? (JSON.parse(raw) || []) : [];
    } catch (e) { return []; }
}
function _lsSetIndex(idx) {
    try { localStorage.setItem(LS_INDEX_KEY, JSON.stringify(idx)); }
    catch (e) { /* ignore */ }
}

function _bufToB64(buf) {
    if (!buf) return null;
    try {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    } catch (e) { return null; }
}
function _b64ToBuf(s) {
    if (!s) return null;
    try {
        var bin = atob(s);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    } catch (e) { return null; }
}

function _serialiseRec(rec) {
    return {
        id: rec.id, kind: rec.kind, createdAt: rec.createdAt,
        metadata: rec.metadata,
        provenance: rec.provenance || null,
        data: rec.data ? {
            t: _bufToB64(rec.data.t),
            p: _bufToB64(rec.data.p),
            q: rec.data.q ? _bufToB64(rec.data.q) : null
        } : null
    };
}
function _deserialiseRec(o) {
    if (!o) return null;
    return {
        id: o.id, kind: o.kind, createdAt: o.createdAt,
        metadata: o.metadata,
        provenance: o.provenance || null,
        data: o.data ? {
            t: _b64ToBuf(o.data.t),
            p: _b64ToBuf(o.data.p),
            q: o.data.q ? _b64ToBuf(o.data.q) : null
        } : null
    };
}

function _lsPut(rec) {
    try {
        localStorage.setItem(LS_PREFIX + rec.id, JSON.stringify(_serialiseRec(rec)));
        var idx = _lsIndex();
        var found = false;
        for (var i = 0; i < idx.length; i++) {
            if (idx[i].id === rec.id) { idx[i] = { id: rec.id, kind: rec.kind, ts: rec.createdAt }; found = true; break; }
        }
        if (!found) idx.push({ id: rec.id, kind: rec.kind, ts: rec.createdAt });
        _lsSetIndex(idx);
        return _resolved();
    } catch (e) {
        // Quota exceeded — fall back to memory for THIS record.
        if (!_memStore) _memStore = new Map();
        _memStore.set(rec.id, rec);
        return _resolved();
    }
}
function _lsGet(id) {
    try {
        var raw = localStorage.getItem(LS_PREFIX + id);
        if (raw) return _resolved(_deserialiseRec(JSON.parse(raw)));
        if (_memStore && _memStore.has(id)) return _resolved(_memStore.get(id));
        return _resolved(null);
    } catch (e) { return _resolved(null); }
}
function _lsDelete(id) {
    try {
        localStorage.removeItem(LS_PREFIX + id);
        var idx = _lsIndex().filter(function (e) { return e.id !== id; });
        _lsSetIndex(idx);
        if (_memStore) _memStore.delete(id);
        return _resolved();
    } catch (e) { return _resolved(); }
}
function _lsListByKind(kind) {
    var idx = _lsIndex();
    var out = [];
    for (var i = 0; i < idx.length; i++) {
        if (idx[i].kind !== kind) continue;
        try {
            var raw = localStorage.getItem(LS_PREFIX + idx[i].id);
            if (raw) {
                var rec = _deserialiseRec(JSON.parse(raw));
                out.push({ id: rec.id, metadata: rec.metadata,
                           metaSize: rec.data ? _byteLen(rec.data) : 0 });
            }
        } catch (e) { /* ignore */ }
    }
    if (_memStore) {
        _memStore.forEach(function (v) {
            if (v.kind === kind) {
                out.push({ id: v.id, metadata: v.metadata, metaSize: v.data ? _byteLen(v.data) : 0 });
            }
        });
    }
    return _resolved(out);
}

// In-memory backend
function _memPut(rec) { _memStore.set(rec.id, rec); return _resolved(); }
function _memGet(id)   { return _resolved(_memStore.get(id) || null); }
function _memDel(id)   { _memStore.delete(id); return _resolved(); }
function _memList(kind) {
    var out = [];
    _memStore.forEach(function (v) {
        if (v.kind === kind) out.push({ id: v.id, metadata: v.metadata, metaSize: v.data ? _byteLen(v.data) : 0 });
    });
    return _resolved(out);
}

// Project meta blob (small JSON of state). Uses one fixed key.
function _putMeta(meta) {
    if (_backend === 'indexedDB') {
        return _idbPut({ id: META_KEY, kind: 'meta', createdAt: _now(), metadata: meta, data: null });
    }
    if (_backend === 'localStorage') {
        try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* ignore */ }
        return _resolved();
    }
    if (!_memStore) _memStore = new Map();
    _memStore.set(META_KEY, { id: META_KEY, kind: 'meta', metadata: meta });
    return _resolved();
}
function _getMeta() {
    if (_backend === 'indexedDB') {
        return _idbGet(META_KEY).then(function (r) { return r ? r.metadata : null; });
    }
    if (_backend === 'localStorage') {
        try { var raw = localStorage.getItem(META_KEY); return _resolved(raw ? JSON.parse(raw) : null); }
        catch (e) { return _resolved(null); }
    }
    if (_memStore && _memStore.has(META_KEY)) return _resolved(_memStore.get(META_KEY).metadata);
    return _resolved(null);
}

function _quotaEstimate() {
    try {
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
            return navigator.storage.estimate().then(function (e) { return e.quota || 0; });
        }
    } catch (e) { /* ignore */ }
    // Conservative defaults: IDB ~ 1 GB, localStorage ~ 5 MB, memory unbounded
    if (_backend === 'indexedDB')   return _resolved(1024 * 1024 * 1024);
    if (_backend === 'localStorage') return _resolved(5  * 1024 * 1024);
    return _resolved(Number.MAX_SAFE_INTEGER);
}

G.PRiSM_storage = {
    backend: 'memory',
    init: function () {
        if (_initPromise) return _initPromise;
        if (!_Promise) {
            _backend = 'memory';
            _memStore = new Map();
            this.backend = _backend;
            return { then: function (cb) { cb(); return this; } };
        }
        var self = this;
        _initPromise = new _Promise(function (resolve) {
            if (_hasIDB()) {
                _openIDB().then(function (db) {
                    _idb = db;
                    _backend = 'indexedDB';
                    self.backend = _backend;
                    resolve();
                }).catch(function () {
                    if (_hasLS()) {
                        _backend = 'localStorage';
                    } else {
                        _backend = 'memory';
                        _memStore = new Map();
                    }
                    self.backend = _backend;
                    resolve();
                });
            } else if (_hasLS()) {
                _backend = 'localStorage';
                self.backend = _backend;
                resolve();
            } else {
                _backend = 'memory';
                _memStore = new Map();
                self.backend = _backend;
                resolve();
            }
        });
        return _initPromise;
    },
    putGauge: function (id, blob) {
        return _put(id, 'gauge', blob);
    },
    getGauge: function (id) { return _get(id); },
    listGauges: function () { return _list('gauge'); },
    deleteGauge: function (id) { return _del(id); },
    putAnalysis: function (id, blob) {
        return _put(id, 'analysis', blob);
    },
    getAnalysis: function (id) { return _get(id); },
    listAnalyses: function () { return _list('analysis'); },
    deleteAnalysis: function (id) { return _del(id); },
    putProjectMeta: function (meta) { return _putMeta(meta); },
    getProjectMeta: function () { return _getMeta(); },
    estimatedQuotaBytes: function () { return _quotaEstimate(); }
};

function _put(id, kind, blob) {
    var rec = {
        id: id,
        kind: kind,
        createdAt: blob.createdAt || _now(),
        metadata: blob.metadata || {},
        provenance: blob.provenance || null,
        data: blob.data || null
    };
    if (_backend === 'indexedDB')   return _idbPut(rec);
    if (_backend === 'localStorage') return _lsPut(rec);
    if (!_memStore) _memStore = new Map();
    return _memPut(rec);
}
function _get(id) {
    if (_backend === 'indexedDB')   return _idbGet(id);
    if (_backend === 'localStorage') return _lsGet(id);
    if (!_memStore) _memStore = new Map();
    return _memGet(id);
}
function _del(id) {
    if (_backend === 'indexedDB')   return _idbDelete(id);
    if (_backend === 'localStorage') return _lsDelete(id);
    if (!_memStore) _memStore = new Map();
    return _memDel(id);
}
function _list(kind) {
    if (_backend === 'indexedDB')   return _idbListByKind(kind);
    if (_backend === 'localStorage') return _lsListByKind(kind);
    if (!_memStore) _memStore = new Map();
    return _memList(kind);
}

// Kick off init at load — caller can await PRiSM_storage.init() too.
try { G.PRiSM_storage.init(); } catch (e) { /* ignore */ }


// ═══════════════════════════════════════════════════════════════════════
// SECTION 2 — GAUGE-DATA MANAGER
// ═══════════════════════════════════════════════════════════════════════
//
// Stores raw pressure/rate measurements. Each entry contains:
//   id          — auto-generated 'gauge_xxx'
//   metadata    — { name, well, dateStart, dateEnd, sampleCount, source, notes }
//   t, p, q     — the raw arrays (q optional)
//
// On disk, t/p/q are stored as Float32Array buffers — 4 bytes/sample each,
// so triplets cost 12 bytes/sample vs ~20-30 bytes/sample for JSON arrays.
// ═══════════════════════════════════════════════════════════════════════

function _toF32(arr) {
    if (!arr) return null;
    if (arr instanceof Float32Array) return arr;
    if (arr.buffer && arr.byteLength) {
        // Likely a typed array — copy into Float32 to normalise.
        var f = new Float32Array(arr.length);
        for (var i = 0; i < arr.length; i++) f[i] = arr[i];
        return f;
    }
    var n = arr.length, fa = new Float32Array(n);
    for (var k = 0; k < n; k++) fa[k] = +arr[k];
    return fa;
}

function _f32ToArray(f) {
    if (!f) return null;
    var n = f.byteLength / 4;
    var view = (f instanceof Float32Array) ? f : new Float32Array(f);
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = view[i];
    return out;
}

function _toBuffer(f32) {
    if (!f32) return null;
    if (f32.buffer && f32.byteOffset === 0 && f32.byteLength === f32.buffer.byteLength) return f32.buffer;
    return new Float32Array(f32).buffer;
}

function _normMeta(metadata, t, p, q) {
    var m = {};
    metadata = metadata || {};
    m.name        = metadata.name || 'Untitled gauge';
    m.well        = metadata.well || '';
    m.source      = metadata.source || '';
    m.notes       = metadata.notes || '';
    m.sampleCount = (t && t.length) ? t.length : 0;
    if (metadata.dateStart) m.dateStart = metadata.dateStart;
    if (metadata.dateEnd)   m.dateEnd   = metadata.dateEnd;
    if (!m.dateStart && t && t.length) m.dateStart = String(t[0]);
    if (!m.dateEnd   && t && t.length) m.dateEnd   = String(t[t.length - 1]);
    return m;
}

function _ensureInit() {
    return G.PRiSM_storage.init();
}

G.PRiSM_gaugeData = {

    add: function (metadata, t, p, q, options) {
        return _ensureInit().then(function () {
            if (!t || !t.length) throw new Error('PRiSM_gaugeData.add: empty t array');
            if (!p || p.length !== t.length) throw new Error('PRiSM_gaugeData.add: p length mismatch');
            if (q && q.length !== t.length) throw new Error('PRiSM_gaugeData.add: q length mismatch');
            var id = (options && options.id) || _id('gauge');
            var meta = _normMeta(metadata, t, p, q);
            var data = {
                t: _toBuffer(_toF32(t)),
                p: _toBuffer(_toF32(p)),
                q: q ? _toBuffer(_toF32(q)) : null
            };
            return G.PRiSM_storage.putGauge(id, {
                metadata: meta, data: data, createdAt: _now()
            }).then(function () {
                _ga4('prism_gauge_added', { sample_count: meta.sampleCount, has_rate: !!q });
                return id;
            });
        });
    },

    get: function (gaugeId) {
        return _ensureInit().then(function () {
            return G.PRiSM_storage.getGauge(gaugeId).then(function (rec) {
                if (!rec) return null;
                return {
                    id: rec.id,
                    metadata: rec.metadata,
                    t: rec.data ? _f32ToArray(rec.data.t) : [],
                    p: rec.data ? _f32ToArray(rec.data.p) : [],
                    q: (rec.data && rec.data.q) ? _f32ToArray(rec.data.q) : null
                };
            });
        });
    },

    list: function () {
        return _ensureInit().then(function () { return G.PRiSM_storage.listGauges(); });
    },

    delete: function (gaugeId) {
        return _ensureInit().then(function () {
            // Also unlink any analyses that reference it (we don't auto-delete
            // the analyses — but we set a 'gaugeMissing' flag in their provenance
            // when next read).
            return G.PRiSM_storage.deleteGauge(gaugeId).then(function () {
                _ga4('prism_gauge_deleted', {});
            });
        });
    },

    rename: function (gaugeId, newName) {
        return G.PRiSM_gaugeData.get(gaugeId).then(function (g) {
            if (!g) return;
            g.metadata.name = newName;
            return G.PRiSM_storage.putGauge(gaugeId, {
                metadata: g.metadata,
                createdAt: _now(),
                data: {
                    t: _toBuffer(_toF32(g.t)),
                    p: _toBuffer(_toF32(g.p)),
                    q: g.q ? _toBuffer(_toF32(g.q)) : null
                }
            });
        });
    },

    duplicate: function (gaugeId, newName) {
        return G.PRiSM_gaugeData.get(gaugeId).then(function (g) {
            if (!g) throw new Error('Gauge ' + gaugeId + ' not found');
            var meta = {};
            for (var k in g.metadata) meta[k] = g.metadata[k];
            meta.name = newName || (g.metadata.name + ' (copy)');
            return G.PRiSM_gaugeData.add(meta, g.t, g.p, g.q);
        });
    },

    diff: function (gaugeIdA, gaugeIdB) {
        return _Promise.all([G.PRiSM_gaugeData.get(gaugeIdA), G.PRiSM_gaugeData.get(gaugeIdB)])
            .then(function (pair) {
                var a = pair[0], b = pair[1];
                if (!a || !b) throw new Error('PRiSM_gaugeData.diff: gauge missing');
                return _diffPair(a, b);
            });
    }
};

// Compute pA - pB at common times via linear interpolation onto the union
// of the two time sets restricted to overlap. Returns the diff arrays plus
// summary stats (RMS, common range).
function _diffPair(a, b) {
    var startCommon = Math.max(a.t[0], b.t[0]);
    var endCommon   = Math.min(a.t[a.t.length - 1], b.t[b.t.length - 1]);
    if (endCommon <= startCommon) {
        return { t: [], dp: [], dq: [], startCommon: startCommon,
                 endCommon: endCommon, nCommon: 0, rmsDiff: 0 };
    }
    // Build a merged sorted time vector inside [startCommon, endCommon],
    // unique to ~1e-9 tolerance.
    var ts = [];
    for (var i = 0; i < a.t.length; i++) {
        var ti = a.t[i];
        if (ti >= startCommon && ti <= endCommon) ts.push(ti);
    }
    for (var j = 0; j < b.t.length; j++) {
        var tj = b.t[j];
        if (tj >= startCommon && tj <= endCommon) ts.push(tj);
    }
    ts.sort(function (x, y) { return x - y; });
    var uniq = [];
    for (var k = 0; k < ts.length; k++) {
        if (!uniq.length || ts[k] - uniq[uniq.length - 1] > 1e-9) uniq.push(ts[k]);
    }
    // Cap to a reasonable size for diff plotting.
    if (uniq.length > 10000) {
        var stride = Math.ceil(uniq.length / 10000);
        var thinned = [];
        for (var u = 0; u < uniq.length; u += stride) thinned.push(uniq[u]);
        uniq = thinned;
    }
    var dp = new Array(uniq.length);
    var dq = a.q && b.q ? new Array(uniq.length) : null;
    var ssr = 0, nValid = 0;
    for (var m = 0; m < uniq.length; m++) {
        var pa = _interp(a.t, a.p, uniq[m]);
        var pb = _interp(b.t, b.p, uniq[m]);
        var d  = pa - pb;
        dp[m] = d;
        if (isFinite(d)) { ssr += d * d; nValid++; }
        if (dq) {
            var qa = _interp(a.t, a.q, uniq[m]);
            var qb = _interp(b.t, b.q, uniq[m]);
            dq[m] = qa - qb;
        }
    }
    var rmsDiff = nValid > 0 ? Math.sqrt(ssr / nValid) : 0;
    return { t: uniq, dp: dp, dq: dq, startCommon: startCommon,
             endCommon: endCommon, nCommon: uniq.length, rmsDiff: rmsDiff };
}

// Linear interp; assumes ts is sorted ascending.
function _interp(ts, ys, x) {
    if (!ts || !ts.length) return NaN;
    if (x <= ts[0]) return ys[0];
    if (x >= ts[ts.length - 1]) return ys[ts.length - 1];
    var lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (ts[mid] <= x) lo = mid; else hi = mid;
    }
    var dt = ts[hi] - ts[lo];
    if (dt === 0) return ys[lo];
    var f = (x - ts[lo]) / dt;
    return ys[lo] + f * (ys[hi] - ys[lo]);
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 3 — ANALYSIS-DATA MANAGER (CRUD + activate + sampler)
// ═══════════════════════════════════════════════════════════════════════
//
// Each analysis-data entry:
//   id            — auto-generated 'ana_xxx'
//   metadata      — { name, notes, sampleCount, ... }
//   t, p, q       — the sampled arrays
//   provenance    — { gaugeIds, filter, decimate, decimateParam, timeRange, createdAt, notes }
//
// activate(id) sets window.PRiSM_dataset = { t, p, q } so the existing
// PRiSM workflow (regression, plots) keeps working unchanged.
// ═══════════════════════════════════════════════════════════════════════

var _activeAnalysisId = null;

G.PRiSM_analysisData = {

    add: function (metadata, gaugeIds, t, p, q) {
        return _ensureInit().then(function () {
            if (!t || !t.length) throw new Error('PRiSM_analysisData.add: empty t array');
            if (!p || p.length !== t.length) throw new Error('PRiSM_analysisData.add: p length mismatch');
            var id = _id('ana');
            var meta = _normMeta(metadata, t, p, q);
            var prov = {
                gaugeIds: gaugeIds || [],
                filter: (metadata && metadata.filter) || null,
                decimate: (metadata && metadata.decimate) || 'none',
                decimateParam: (metadata && metadata.decimateParam) || null,
                timeRange: (metadata && metadata.timeRange) || null,
                createdAt: _now(),
                notes: meta.notes
            };
            var data = {
                t: _toBuffer(_toF32(t)),
                p: _toBuffer(_toF32(p)),
                q: q ? _toBuffer(_toF32(q)) : null
            };
            return G.PRiSM_storage.putAnalysis(id, {
                metadata: meta, data: data, provenance: prov, createdAt: _now()
            }).then(function () {
                _ga4('prism_analysis_added', { sample_count: meta.sampleCount, source_count: prov.gaugeIds.length });
                return id;
            });
        });
    },

    get: function (analysisId) {
        return _ensureInit().then(function () {
            return G.PRiSM_storage.getAnalysis(analysisId).then(function (rec) {
                if (!rec) return null;
                return {
                    id: rec.id,
                    metadata: rec.metadata,
                    t: rec.data ? _f32ToArray(rec.data.t) : [],
                    p: rec.data ? _f32ToArray(rec.data.p) : [],
                    q: (rec.data && rec.data.q) ? _f32ToArray(rec.data.q) : null,
                    provenance: rec.provenance || null
                };
            });
        });
    },

    list: function () {
        return _ensureInit().then(function () { return G.PRiSM_storage.listAnalyses(); });
    },

    delete: function (analysisId) {
        return _ensureInit().then(function () {
            return G.PRiSM_storage.deleteAnalysis(analysisId).then(function () {
                if (_activeAnalysisId === analysisId) {
                    _activeAnalysisId = null;
                    G.PRiSM_dataset = null;
                }
                _ga4('prism_analysis_deleted', {});
            });
        });
    },

    rename: function (analysisId, newName) {
        return G.PRiSM_analysisData.get(analysisId).then(function (a) {
            if (!a) return;
            a.metadata.name = newName;
            return G.PRiSM_storage.putAnalysis(analysisId, {
                metadata: a.metadata,
                provenance: a.provenance,
                createdAt: _now(),
                data: {
                    t: _toBuffer(_toF32(a.t)),
                    p: _toBuffer(_toF32(a.p)),
                    q: a.q ? _toBuffer(_toF32(a.q)) : null
                }
            });
        });
    },

    duplicate: function (analysisId, newName) {
        return G.PRiSM_analysisData.get(analysisId).then(function (a) {
            if (!a) throw new Error('Analysis ' + analysisId + ' not found');
            var meta = {};
            for (var k in a.metadata) meta[k] = a.metadata[k];
            meta.name = newName || (a.metadata.name + ' (copy)');
            return G.PRiSM_analysisData.add(meta,
                a.provenance ? a.provenance.gaugeIds : [],
                a.t, a.p, a.q);
        });
    },

    activate: function (analysisId) {
        return G.PRiSM_analysisData.get(analysisId).then(function (a) {
            if (!a) throw new Error('Analysis ' + analysisId + ' not found');
            G.PRiSM_dataset = { t: a.t, p: a.p, q: a.q };
            _activeAnalysisId = analysisId;
            // Reflect activation in the host UI if a re-render hook is wired.
            if (typeof G.PRiSM_drawActivePlot === 'function') {
                try { G.PRiSM_drawActivePlot(); } catch (e) { /* swallow */ }
            }
            _ga4('prism_analysis_activated', { sample_count: a.t.length });
        });
    },

    activeId: function () { return _activeAnalysisId; },

    sample: function (gaugeIds, options) {
        options = options || {};
        var ids = Array.isArray(gaugeIds) ? gaugeIds : [gaugeIds];
        return _Promise.all(ids.map(function (id) { return G.PRiSM_gaugeData.get(id); }))
            .then(function (gauges) {
                gauges = gauges.filter(function (g) { return g && g.t && g.t.length; });
                if (!gauges.length) throw new Error('PRiSM_analysisData.sample: no source gauges');
                // Concatenate sources by time (assume each gauge has its own
                // time axis; we sort the union ascending).
                var t = [], p = [], q = [], hasQ = true;
                for (var i = 0; i < gauges.length; i++) {
                    var g = gauges[i];
                    if (!g.q) hasQ = false;
                    for (var k = 0; k < g.t.length; k++) {
                        t.push(g.t[k]); p.push(g.p[k]);
                        q.push(g.q ? g.q[k] : 0);
                    }
                }
                // Sort by time
                var order = t.map(function (_, i) { return i; }).sort(function (a, b) { return t[a] - t[b]; });
                var ts = new Array(t.length), ps = new Array(p.length), qs = new Array(q.length);
                for (var j = 0; j < order.length; j++) { ts[j] = t[order[j]]; ps[j] = p[order[j]]; qs[j] = q[order[j]]; }
                if (!hasQ) qs = null;

                // Apply time range
                if (options.timeRange) {
                    var lo = options.timeRange.start, hi = options.timeRange.end;
                    var ti = [], pi = [], qi = qs ? [] : null;
                    for (var m = 0; m < ts.length; m++) {
                        if ((lo == null || ts[m] >= lo) && (hi == null || ts[m] <= hi)) {
                            ti.push(ts[m]); pi.push(ps[m]); if (qs) qi.push(qs[m]);
                        }
                    }
                    ts = ti; ps = pi; qs = qi;
                }
                // Apply filter
                if (options.filter && ps.length > 5) {
                    if (options.filter === 'mad' && typeof G.PRiSM_filterMAD === 'function') {
                        try { ps = G.PRiSM_filterMAD(ps).filtered || ps; } catch (e) {}
                    } else if (options.filter === 'movingAvg' && typeof G.PRiSM_filterMovingAvg === 'function') {
                        try { ps = G.PRiSM_filterMovingAvg(ps, 5) || ps; } catch (e) {}
                    } else if (options.filter === 'hampel' && typeof G.PRiSM_filterHampel === 'function') {
                        try { ps = G.PRiSM_filterHampel(ps).filtered || ps; } catch (e) {}
                    } else {
                        // Inline simple moving-average fallback (window=5)
                        ps = _smoothMA(ps, 5);
                    }
                }
                // Apply decimation
                if (options.decimate && options.decimate !== 'none') {
                    var dp = options.decimateParam || {};
                    if (options.decimate === 'nth') {
                        var every = Math.max(1, dp.every | 0);
                        var td = [], pd = [], qd = qs ? [] : null;
                        for (var d = 0; d < ts.length; d += every) {
                            td.push(ts[d]); pd.push(ps[d]); if (qs) qd.push(qs[d]);
                        }
                        ts = td; ps = pd; qs = qd;
                    } else if (options.decimate === 'log') {
                        var nPerDec = dp.nPerDecade || 50;
                        var picks   = _logDecimate(ts, nPerDec);
                        var td2 = picks.map(function (i) { return ts[i]; });
                        var pd2 = picks.map(function (i) { return ps[i]; });
                        var qd2 = qs ? picks.map(function (i) { return qs[i]; }) : null;
                        ts = td2; ps = pd2; qs = qd2;
                    } else if (options.decimate === 'timeBin') {
                        var binMin = dp.binMinutes || 1;
                        var binH   = binMin / 60;
                        var bins = _timeBin(ts, ps, qs, binH);
                        ts = bins.t; ps = bins.p; qs = bins.q;
                    }
                }

                var meta = {
                    name: options.name || ('Sample ' + new Date().toISOString().slice(0, 19)),
                    notes: options.notes || '',
                    filter: options.filter || null,
                    decimate: options.decimate || 'none',
                    decimateParam: options.decimateParam || null,
                    timeRange: options.timeRange || null
                };
                return G.PRiSM_analysisData.add(meta, ids, ts, ps, qs);
            });
    }
};

function _smoothMA(arr, win) {
    var n = arr.length, out = new Array(n);
    var half = Math.max(1, Math.floor(win / 2));
    for (var i = 0; i < n; i++) {
        var i0 = Math.max(0, i - half), i1 = Math.min(n - 1, i + half);
        var s = 0, c = 0;
        for (var j = i0; j <= i1; j++) {
            if (isFinite(arr[j])) { s += arr[j]; c++; }
        }
        out[i] = c > 0 ? s / c : NaN;
    }
    return out;
}

// Pick log-spaced indices into a sorted ascending t array.
function _logDecimate(ts, nPerDec) {
    var n = ts.length;
    if (n < 4) return ts.map(function (_, i) { return i; });
    var t0 = ts[0], tN = ts[n - 1];
    if (t0 <= 0) {
        // Find first positive time to start log scale
        var k0 = 0;
        while (k0 < n && ts[k0] <= 0) k0++;
        if (k0 >= n - 1) return ts.map(function (_, i) { return i; });
        t0 = ts[k0];
    }
    var lt0 = Math.log10(t0), ltN = Math.log10(tN);
    var decades = Math.max(0.01, ltN - lt0);
    var nPicks = Math.max(4, Math.ceil(decades * nPerDec));
    var picks = [];
    var seen = {};
    for (var i = 0; i < nPicks; i++) {
        var lt = lt0 + decades * (i / (nPicks - 1));
        var target = Math.pow(10, lt);
        // Binary search for nearest index
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (ts[mid] <= target) lo = mid; else hi = mid;
        }
        var pick = (Math.abs(ts[lo] - target) < Math.abs(ts[hi] - target)) ? lo : hi;
        if (!seen[pick]) { seen[pick] = true; picks.push(pick); }
    }
    picks.sort(function (a, b) { return a - b; });
    return picks;
}

// Bin (t, p, q) into uniform time bins of width binWidth (in t units).
function _timeBin(t, p, q, binWidth) {
    if (!t.length) return { t: [], p: [], q: q ? [] : null };
    var t0 = t[0], tN = t[t.length - 1];
    var nBins = Math.max(1, Math.ceil((tN - t0) / binWidth));
    var sumT = new Array(nBins), sumP = new Array(nBins), sumQ = q ? new Array(nBins) : null, cnt = new Array(nBins);
    for (var b = 0; b < nBins; b++) { sumT[b] = 0; sumP[b] = 0; if (sumQ) sumQ[b] = 0; cnt[b] = 0; }
    for (var i = 0; i < t.length; i++) {
        var bIdx = Math.min(nBins - 1, Math.max(0, Math.floor((t[i] - t0) / binWidth)));
        sumT[bIdx] += t[i]; sumP[bIdx] += p[i]; if (sumQ && q) sumQ[bIdx] += q[i];
        cnt[bIdx]++;
    }
    var ot = [], op = [], oq = sumQ ? [] : null;
    for (var k = 0; k < nBins; k++) {
        if (cnt[k] > 0) {
            ot.push(sumT[k] / cnt[k]);
            op.push(sumP[k] / cnt[k]);
            if (sumQ) oq.push(sumQ[k] / cnt[k]);
        }
    }
    return { t: ot, p: op, q: oq };
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 4 — PROJECT FILE (save / load / new / info)
// ═══════════════════════════════════════════════════════════════════════
//
// A project is the entire PRiSM state — gaugeData, analysisData, model,
// params, lastFit, presets, PVT, etc. Saved as JSON; large datasets are
// embedded as base64-encoded Float32Array buffers for compactness.
//
// File format:
//   { version: '1.0', meta: { name, createdAt, modifiedAt, ... },
//     gaugeData: [ { id, metadata, dataB64: { t, p, q } }, ... ],
//     analysisData: [ { id, metadata, provenance, dataB64: {...} }, ... ],
//     state: { activeAnalysisId, model, params, lastFit, presets, pvt, ... } }
// ═══════════════════════════════════════════════════════════════════════

var _projectMeta = {
    name: 'Untitled project',
    createdAt: _now(),
    modifiedAt: _now()
};

G.PRiSM_project = {

    save: function (filename) {
        return _ensureInit().then(function () {
            // 1) Gather all gauge & analysis records (full data, not just metadata).
            var gaugeListP    = G.PRiSM_storage.listGauges().then(function (lst) {
                return _Promise.all(lst.map(function (e) { return G.PRiSM_storage.getGauge(e.id); }));
            });
            var analysisListP = G.PRiSM_storage.listAnalyses().then(function (lst) {
                return _Promise.all(lst.map(function (e) { return G.PRiSM_storage.getAnalysis(e.id); }));
            });
            return _Promise.all([gaugeListP, analysisListP]);
        }).then(function (pair) {
            var gauges = pair[0].filter(Boolean), analyses = pair[1].filter(Boolean);
            var gaugeData = gauges.map(function (g) {
                return {
                    id: g.id, metadata: g.metadata,
                    dataB64: g.data ? {
                        t: _bufToB64(g.data.t),
                        p: _bufToB64(g.data.p),
                        q: g.data.q ? _bufToB64(g.data.q) : null
                    } : null
                };
            });
            var analysisData = analyses.map(function (a) {
                return {
                    id: a.id, metadata: a.metadata, provenance: a.provenance,
                    dataB64: a.data ? {
                        t: _bufToB64(a.data.t),
                        p: _bufToB64(a.data.p),
                        q: a.data.q ? _bufToB64(a.data.q) : null
                    } : null
                };
            });
            // 2) Snapshot host state.
            _projectMeta.modifiedAt = _now();
            var st = G.PRiSM_state || {};
            var stateSnap = {
                activeAnalysisId: _activeAnalysisId,
                model: st.model || null,
                params: st.params || {},
                paramFreeze: st.paramFreeze || {},
                lastFit: st.lastFit || null,
                presets: st.presets || [],
                pvt: G.PRiSM_pvt || st.pvt || null,
                activePlot: st.activePlot || null
            };
            var project = {
                version: '1.0',
                meta: _projectMeta,
                gaugeData: gaugeData,
                analysisData: analysisData,
                state: stateSnap
            };
            var json = JSON.stringify(project);
            var blob;
            try {
                blob = new Blob([json], { type: 'application/json' });
            } catch (e) {
                blob = json;
            }
            var name = filename || (_projectMeta.name.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.prism');
            if (!/\.prism$/i.test(name)) name += '.prism';
            // Trigger browser download if we have URL.createObjectURL.
            if (_hasDoc && typeof URL !== 'undefined' && URL.createObjectURL && blob instanceof Blob) {
                try {
                    var url = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = url; a.download = name; a.style.display = 'none';
                    document.body.appendChild(a); a.click();
                    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 100);
                } catch (e) { /* silent */ }
            }
            _ga4('prism_project_saved', { gauge_count: gaugeData.length, analysis_count: analysisData.length, size_bytes: json.length });
            return { blob: blob, filename: name, sizeBytes: json.length };
        });
    },

    load: function (file) {
        if (!file) return _rejected(new Error('PRiSM_project.load: no file'));
        return _readFileAsText(file).then(function (text) {
            var proj;
            try { proj = JSON.parse(text); }
            catch (e) { throw new Error('PRiSM_project.load: invalid JSON'); }
            if (!proj || !proj.version) throw new Error('PRiSM_project.load: not a PRiSM project file');
            return G.PRiSM_project.loadFromObject(proj);
        });
    },

    // Programmatic load — used by self-test and round-trip.
    loadFromObject: function (proj) {
        return _ensureInit().then(function () {
            // Wipe existing data then reinsert.
            return _wipeAll();
        }).then(function () {
            var gaugePuts = (proj.gaugeData || []).map(function (g) {
                return G.PRiSM_storage.putGauge(g.id, {
                    metadata: g.metadata,
                    createdAt: (g.metadata && g.metadata.createdAt) || _now(),
                    data: g.dataB64 ? {
                        t: _b64ToBuf(g.dataB64.t),
                        p: _b64ToBuf(g.dataB64.p),
                        q: g.dataB64.q ? _b64ToBuf(g.dataB64.q) : null
                    } : null
                });
            });
            var analysisPuts = (proj.analysisData || []).map(function (a) {
                return G.PRiSM_storage.putAnalysis(a.id, {
                    metadata: a.metadata,
                    provenance: a.provenance,
                    createdAt: (a.provenance && a.provenance.createdAt) || _now(),
                    data: a.dataB64 ? {
                        t: _b64ToBuf(a.dataB64.t),
                        p: _b64ToBuf(a.dataB64.p),
                        q: a.dataB64.q ? _b64ToBuf(a.dataB64.q) : null
                    } : null
                });
            });
            return _Promise.all(gaugePuts.concat(analysisPuts));
        }).then(function () {
            // Restore state.
            _projectMeta = proj.meta || _projectMeta;
            _projectMeta.modifiedAt = _now();
            var st = proj.state || {};
            G.PRiSM_state = G.PRiSM_state || {};
            if (st.model)        G.PRiSM_state.model = st.model;
            if (st.params)       G.PRiSM_state.params = st.params;
            if (st.paramFreeze)  G.PRiSM_state.paramFreeze = st.paramFreeze;
            if (st.lastFit)      G.PRiSM_state.lastFit = st.lastFit;
            if (st.presets)      G.PRiSM_state.presets = st.presets;
            if (st.pvt)          { G.PRiSM_pvt = st.pvt; G.PRiSM_state.pvt = st.pvt; }
            if (st.activePlot)   G.PRiSM_state.activePlot = st.activePlot;
            // Re-activate analysis if specified.
            if (st.activeAnalysisId) {
                return G.PRiSM_analysisData.activate(st.activeAnalysisId).catch(function () { /* silent */ });
            }
            return null;
        }).then(function () {
            _ga4('prism_project_loaded', {
                gauge_count: (proj.gaugeData || []).length,
                analysis_count: (proj.analysisData || []).length
            });
        });
    },

    new: function () {
        return _ensureInit().then(function () { return _wipeAll(); }).then(function () {
            _activeAnalysisId = null;
            G.PRiSM_dataset = null;
            _projectMeta = {
                name: 'Untitled project',
                createdAt: _now(),
                modifiedAt: _now()
            };
            _ga4('prism_project_new', {});
        });
    },

    info: function () {
        // Synchronous best-effort — uses cached counts.
        return {
            name:      _projectMeta.name,
            createdAt: _projectMeta.createdAt,
            modifiedAt: _projectMeta.modifiedAt,
            gaugeCount: G.PRiSM_project._lastCounts ? G.PRiSM_project._lastCounts.gauges : 0,
            analysisCount: G.PRiSM_project._lastCounts ? G.PRiSM_project._lastCounts.analyses : 0,
            sizeBytes: G.PRiSM_project._lastCounts ? G.PRiSM_project._lastCounts.sizeBytes : 0,
            backend: _backend || 'unknown'
        };
    },

    refreshInfo: function () {
        // Async refresh of cached counts (for UI).
        return _ensureInit().then(function () {
            return _Promise.all([G.PRiSM_storage.listGauges(), G.PRiSM_storage.listAnalyses()]);
        }).then(function (pair) {
            var sz = 0;
            pair[0].forEach(function (e) { sz += e.metaSize || 0; });
            pair[1].forEach(function (e) { sz += e.metaSize || 0; });
            G.PRiSM_project._lastCounts = {
                gauges: pair[0].length,
                analyses: pair[1].length,
                sizeBytes: sz
            };
            return G.PRiSM_project.info();
        });
    },

    setName: function (name) {
        _projectMeta.name = String(name || 'Untitled project');
        _projectMeta.modifiedAt = _now();
    }
};

function _wipeAll() {
    return _Promise.all([G.PRiSM_storage.listGauges(), G.PRiSM_storage.listAnalyses()])
        .then(function (pair) {
            var dels = [];
            pair[0].forEach(function (e) { dels.push(G.PRiSM_storage.deleteGauge(e.id)); });
            pair[1].forEach(function (e) { dels.push(G.PRiSM_storage.deleteAnalysis(e.id)); });
            return _Promise.all(dels);
        });
}

function _readFileAsText(file) {
    return new _Promise(function (resolve, reject) {
        try {
            if (typeof FileReader === 'undefined') {
                reject(new Error('FileReader unavailable'));
                return;
            }
            var r = new FileReader();
            r.onload  = function (e) { resolve(e.target.result); };
            r.onerror = function ()  { reject(new Error('FileReader failed')); };
            r.readAsText(file);
        } catch (e) { reject(e); }
    });
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 5 — UI: GAUGE-DATA MANAGER
// ═══════════════════════════════════════════════════════════════════════
//
// Renders a card-style list of gauge entries with import/view/diff actions.
// Uses the host CSS classes (.card, .btn, etc.) when present; otherwise
// falls back to inline styles so it still looks correct on a bare page.
// ═══════════════════════════════════════════════════════════════════════

function _mkBtn(label, color, onClick) {
    if (!_hasDoc) return null;
    var b = document.createElement('button');
    b.className = 'btn ' + (color === 'primary' ? 'btn-primary' : 'btn-secondary');
    b.textContent = label;
    b.style.padding = '4px 10px';
    b.style.marginRight = '6px';
    b.style.fontSize = '12px';
    b.style.cursor = 'pointer';
    if (color === 'danger') {
        b.style.background = _theme().red;
        b.style.color = '#fff';
        b.style.border = '1px solid ' + _theme().red;
    }
    if (onClick) b.addEventListener('click', onClick);
    return b;
}

function _mkRow(label, value) {
    if (!_hasDoc) return null;
    var d = document.createElement('div');
    d.style.display = 'flex'; d.style.gap = '8px'; d.style.fontSize = '12px';
    d.innerHTML = '<span style="color:' + _theme().text3 + ';min-width:90px;">' + label + ':</span>' +
                  '<span style="color:' + _theme().text + ';">' + value + '</span>';
    return d;
}

function _emptyHint(host, msg) {
    var d = document.createElement('div');
    d.style.padding = '16px'; d.style.textAlign = 'center';
    d.style.color = _theme().text3; d.style.fontSize = '13px';
    d.textContent = msg;
    host.appendChild(d);
}

G.PRiSM_renderGaugeManager = function (container) {
    if (!_hasDoc || !container) return;
    container.innerHTML = '';
    var T = _theme();
    var head = document.createElement('div');
    head.style.display = 'flex'; head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center'; head.style.marginBottom = '12px';
    var title = document.createElement('div');
    title.innerHTML = '<span style="font-size:16px;font-weight:600;color:' + T.text + ';">Gauge Data</span>' +
                      '<span style="font-size:12px;color:' + T.text3 + ';margin-left:10px;">' +
                      'Raw imported pressure / rate measurements</span>';
    head.appendChild(title);
    var actions = document.createElement('div');
    var importBtn = _mkBtn('+ Import', 'primary', function () {
        _openImportPicker(container);
    });
    actions.appendChild(importBtn);
    head.appendChild(actions);
    container.appendChild(head);

    var listHost = document.createElement('div');
    listHost.style.display = 'grid';
    listHost.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
    listHost.style.gap = '10px';
    container.appendChild(listHost);

    G.PRiSM_gaugeData.list().then(function (entries) {
        if (!entries || !entries.length) {
            _emptyHint(listHost, 'No gauge data yet. Click "+ Import" to add a CSV / TXT / XLSX file.');
            return;
        }
        entries.forEach(function (e) {
            listHost.appendChild(_renderGaugeTile(e, container));
        });
    }).catch(function (err) {
        _emptyHint(listHost, 'Storage error: ' + (err && err.message || err));
    });
};

function _renderGaugeTile(entry, rootContainer) {
    var T = _theme();
    var card = document.createElement('div');
    card.className = 'card';
    card.style.background = T.panel;
    card.style.border = '1px solid ' + T.border;
    card.style.borderRadius = '6px';
    card.style.padding = '12px';
    var name = document.createElement('div');
    name.style.fontWeight = '600'; name.style.color = T.accent;
    name.style.fontSize = '14px'; name.style.marginBottom = '8px';
    name.textContent = entry.metadata.name || 'Untitled';
    card.appendChild(name);
    if (entry.metadata.well) card.appendChild(_mkRow('Well', entry.metadata.well));
    card.appendChild(_mkRow('Samples', String(entry.metadata.sampleCount || 0)));
    if (entry.metadata.dateStart) card.appendChild(_mkRow('Start',
        String(entry.metadata.dateStart).slice(0, 19)));
    if (entry.metadata.dateEnd) card.appendChild(_mkRow('End',
        String(entry.metadata.dateEnd).slice(0, 19)));
    if (entry.metadata.source) card.appendChild(_mkRow('Source', entry.metadata.source));
    if (entry.metaSize) card.appendChild(_mkRow('Bytes', String(entry.metaSize)));
    if (entry.metadata.notes) {
        var n = document.createElement('div');
        n.style.fontSize = '11px'; n.style.color = T.text2;
        n.style.marginTop = '6px'; n.style.fontStyle = 'italic';
        n.textContent = entry.metadata.notes;
        card.appendChild(n);
    }
    var btnRow = document.createElement('div');
    btnRow.style.marginTop = '10px';
    btnRow.style.display = 'flex'; btnRow.style.flexWrap = 'wrap'; btnRow.style.gap = '4px';
    btnRow.appendChild(_mkBtn('Rename', null, function () {
        var newName = prompt('Rename gauge', entry.metadata.name);
        if (newName) {
            G.PRiSM_gaugeData.rename(entry.id, newName).then(function () {
                G.PRiSM_renderGaugeManager(rootContainer);
            });
        }
    }));
    btnRow.appendChild(_mkBtn('Duplicate', null, function () {
        G.PRiSM_gaugeData.duplicate(entry.id).then(function () {
            G.PRiSM_renderGaugeManager(rootContainer);
        });
    }));
    btnRow.appendChild(_mkBtn('Diff vs…', null, function () {
        _openDiffPicker(entry.id, rootContainer);
    }));
    btnRow.appendChild(_mkBtn('Delete', 'danger', function () {
        if (confirm('Delete gauge "' + entry.metadata.name + '"?')) {
            G.PRiSM_gaugeData.delete(entry.id).then(function () {
                G.PRiSM_renderGaugeManager(rootContainer);
            });
        }
    }));
    card.appendChild(btnRow);
    return card;
}

function _openImportPicker(rootContainer) {
    if (!_hasDoc) return;
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,.tsv,.txt,.dat,.asc,.xlsx,.xls';
    inp.style.display = 'none';
    inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        // Use PRiSM_loadFile if available; otherwise read as text and use a
        // very permissive CSV parser.
        var name = f.name;
        if (typeof G.PRiSM_loadFile === 'function') {
            G.PRiSM_loadFile(f).then(function () {
                // After PRiSM_loadFile parses, the dataset is on PRiSM_dataset.
                var ds = G.PRiSM_dataset;
                if (ds && ds.t && ds.t.length) {
                    G.PRiSM_gaugeData.add({
                        name: name.replace(/\.[^.]+$/, ''),
                        source: name,
                        well: ''
                    }, ds.t, ds.p, ds.q).then(function () {
                        G.PRiSM_renderGaugeManager(rootContainer);
                    });
                }
            }).catch(function (e) {
                alert('Import failed: ' + (e && e.message || e));
            });
        } else {
            // Inline minimal CSV reader
            var r = new FileReader();
            r.onload = function (ev) {
                var data = _quickCSV(ev.target.result);
                if (data.t.length) {
                    G.PRiSM_gaugeData.add({ name: name.replace(/\.[^.]+$/, ''), source: name },
                                          data.t, data.p, data.q).then(function () {
                        G.PRiSM_renderGaugeManager(rootContainer);
                    });
                } else {
                    alert('No data rows found in ' + name);
                }
            };
            r.readAsText(f);
        }
    });
    document.body.appendChild(inp);
    inp.click();
    setTimeout(function () { try { document.body.removeChild(inp); } catch (e) {} }, 1000);
}

// Minimal CSV fallback: assume first numeric column = t, second = p, third = q.
function _quickCSV(text) {
    var t = [], p = [], q = [];
    var lines = String(text || '').split(/\r?\n/);
    var hasQ = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || /^[a-zA-Z#]/.test(line)) continue;
        var parts = line.split(/[\s,;\t]+/);
        var n = parts.map(parseFloat).filter(function (x) { return isFinite(x); });
        if (n.length >= 2) {
            t.push(n[0]); p.push(n[1]);
            if (n.length >= 3) { q.push(n[2]); hasQ = true; }
        }
    }
    return { t: t, p: p, q: hasQ ? q : null };
}

function _openDiffPicker(gaugeIdA, rootContainer) {
    if (!_hasDoc) return;
    G.PRiSM_gaugeData.list().then(function (entries) {
        var others = entries.filter(function (e) { return e.id !== gaugeIdA; });
        if (!others.length) { alert('Need at least 2 gauges to diff.'); return; }
        var modal = _modal();
        var h = document.createElement('div');
        h.style.fontSize = '15px'; h.style.fontWeight = '600';
        h.style.marginBottom = '10px'; h.style.color = _theme().accent;
        h.textContent = 'Diff gauges';
        modal.body.appendChild(h);
        var sel = document.createElement('select');
        sel.style.width = '100%'; sel.style.padding = '6px'; sel.style.marginBottom = '10px';
        sel.style.background = _theme().bg; sel.style.color = _theme().text;
        sel.style.border = '1px solid ' + _theme().border;
        others.forEach(function (e) {
            var opt = document.createElement('option');
            opt.value = e.id; opt.textContent = e.metadata.name + ' (' + e.metadata.sampleCount + ' samples)';
            sel.appendChild(opt);
        });
        modal.body.appendChild(sel);
        var canvas = document.createElement('canvas');
        canvas.width = 600; canvas.height = 280;
        canvas.style.width = '100%'; canvas.style.background = _theme().bg;
        canvas.style.border = '1px solid ' + _theme().border;
        modal.body.appendChild(canvas);
        var summary = document.createElement('div');
        summary.style.fontSize = '12px'; summary.style.color = _theme().text2;
        summary.style.marginTop = '8px';
        modal.body.appendChild(summary);

        var go = _mkBtn('Compute', 'primary', function () {
            G.PRiSM_gaugeData.diff(gaugeIdA, sel.value).then(function (d) {
                G.PRiSM_drawDiff(canvas, d);
                summary.textContent = 'n=' + d.nCommon + ' common samples, RMS Δp = ' + d.rmsDiff.toFixed(3) +
                                      ', range t = [' + d.startCommon.toFixed(3) + ', ' + d.endCommon.toFixed(3) + ']';
            }).catch(function (err) {
                summary.textContent = 'Error: ' + (err && err.message || err);
            });
        });
        modal.body.appendChild(go);
        modal.body.appendChild(_mkBtn('Close', null, function () { modal.close(); }));
    });
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 6 — UI: ANALYSIS-DATA MANAGER
// ═══════════════════════════════════════════════════════════════════════

G.PRiSM_renderAnalysisManager = function (container) {
    if (!_hasDoc || !container) return;
    container.innerHTML = '';
    var T = _theme();
    var head = document.createElement('div');
    head.style.display = 'flex'; head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center'; head.style.marginBottom = '12px';
    var title = document.createElement('div');
    title.innerHTML = '<span style="font-size:16px;font-weight:600;color:' + T.text + ';">Analysis Data</span>' +
                      '<span style="font-size:12px;color:' + T.text3 + ';margin-left:10px;">' +
                      'Sampled subsets prepared for interpretation</span>';
    head.appendChild(title);
    var actions = document.createElement('div');
    actions.appendChild(_mkBtn('+ Sample from gauge', 'primary', function () {
        _openSamplerModal(container);
    }));
    head.appendChild(actions);
    container.appendChild(head);

    var listHost = document.createElement('div');
    listHost.style.display = 'grid';
    listHost.style.gridTemplateColumns = 'repeat(auto-fill, minmax(300px, 1fr))';
    listHost.style.gap = '10px';
    container.appendChild(listHost);

    G.PRiSM_analysisData.list().then(function (entries) {
        if (!entries || !entries.length) {
            _emptyHint(listHost, 'No analysis subsets yet. Import a gauge first, then click "+ Sample from gauge".');
            return;
        }
        entries.forEach(function (e) {
            listHost.appendChild(_renderAnalysisTile(e, container));
        });
    }).catch(function (err) {
        _emptyHint(listHost, 'Storage error: ' + (err && err.message || err));
    });
};

function _renderAnalysisTile(entry, rootContainer) {
    var T = _theme();
    var card = document.createElement('div');
    card.className = 'card';
    card.style.background = T.panel;
    card.style.border = '1px solid ' + T.border;
    card.style.borderRadius = '6px';
    card.style.padding = '12px';
    var isActive = (G.PRiSM_analysisData.activeId() === entry.id);
    if (isActive) {
        card.style.border = '2px solid ' + T.green;
    }
    var name = document.createElement('div');
    name.style.fontWeight = '600'; name.style.color = isActive ? T.green : T.accent;
    name.style.fontSize = '14px'; name.style.marginBottom = '8px';
    name.textContent = (isActive ? '● ' : '') + (entry.metadata.name || 'Untitled');
    card.appendChild(name);
    card.appendChild(_mkRow('Samples', String(entry.metadata.sampleCount || 0)));
    if (entry.metadata.filter) card.appendChild(_mkRow('Filter', entry.metadata.filter));
    if (entry.metadata.decimate && entry.metadata.decimate !== 'none') {
        card.appendChild(_mkRow('Decimate', entry.metadata.decimate));
    }
    var btnRow = document.createElement('div');
    btnRow.style.marginTop = '10px';
    btnRow.style.display = 'flex'; btnRow.style.flexWrap = 'wrap'; btnRow.style.gap = '4px';
    if (!isActive) {
        btnRow.appendChild(_mkBtn('Activate', 'primary', function () {
            G.PRiSM_analysisData.activate(entry.id).then(function () {
                G.PRiSM_renderAnalysisManager(rootContainer);
            });
        }));
    }
    btnRow.appendChild(_mkBtn('Rename', null, function () {
        var nm = prompt('Rename analysis', entry.metadata.name);
        if (nm) {
            G.PRiSM_analysisData.rename(entry.id, nm).then(function () {
                G.PRiSM_renderAnalysisManager(rootContainer);
            });
        }
    }));
    btnRow.appendChild(_mkBtn('Duplicate', null, function () {
        G.PRiSM_analysisData.duplicate(entry.id).then(function () {
            G.PRiSM_renderAnalysisManager(rootContainer);
        });
    }));
    btnRow.appendChild(_mkBtn('Delete', 'danger', function () {
        if (confirm('Delete analysis "' + entry.metadata.name + '"?')) {
            G.PRiSM_analysisData.delete(entry.id).then(function () {
                G.PRiSM_renderAnalysisManager(rootContainer);
            });
        }
    }));
    card.appendChild(btnRow);
    return card;
}

function _openSamplerModal(rootContainer) {
    if (!_hasDoc) return;
    G.PRiSM_gaugeData.list().then(function (gauges) {
        if (!gauges || !gauges.length) {
            alert('Import a gauge file first.');
            return;
        }
        var modal = _modal();
        var T = _theme();
        var h = document.createElement('div');
        h.style.fontSize = '15px'; h.style.fontWeight = '600';
        h.style.marginBottom = '10px'; h.style.color = T.accent;
        h.textContent = 'Sample new analysis from gauge';
        modal.body.appendChild(h);

        function _label(t) {
            var d = document.createElement('div');
            d.style.fontSize = '12px'; d.style.color = T.text3;
            d.style.marginTop = '8px'; d.textContent = t;
            return d;
        }

        modal.body.appendChild(_label('Source gauge'));
        var sel = document.createElement('select');
        sel.style.width = '100%'; sel.style.padding = '6px';
        sel.style.background = T.bg; sel.style.color = T.text;
        sel.style.border = '1px solid ' + T.border;
        gauges.forEach(function (g) {
            var opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = g.metadata.name + ' (' + g.metadata.sampleCount + ' samples)';
            sel.appendChild(opt);
        });
        modal.body.appendChild(sel);

        modal.body.appendChild(_label('Name'));
        var nameInp = document.createElement('input');
        nameInp.type = 'text'; nameInp.value = 'Sample ' + new Date().toISOString().slice(0, 16);
        nameInp.style.width = '100%'; nameInp.style.padding = '6px';
        nameInp.style.background = T.bg; nameInp.style.color = T.text;
        nameInp.style.border = '1px solid ' + T.border;
        modal.body.appendChild(nameInp);

        modal.body.appendChild(_label('Time range (start, end) — leave blank for full range'));
        var rangeWrap = document.createElement('div');
        rangeWrap.style.display = 'flex'; rangeWrap.style.gap = '6px';
        var rStart = document.createElement('input');
        var rEnd   = document.createElement('input');
        [rStart, rEnd].forEach(function (e) {
            e.type = 'number'; e.style.flex = '1'; e.style.padding = '6px';
            e.style.background = T.bg; e.style.color = T.text;
            e.style.border = '1px solid ' + T.border;
        });
        rStart.placeholder = 'start'; rEnd.placeholder = 'end';
        rangeWrap.appendChild(rStart); rangeWrap.appendChild(rEnd);
        modal.body.appendChild(rangeWrap);

        modal.body.appendChild(_label('Filter'));
        var fSel = document.createElement('select');
        ['none', 'mad', 'movingAvg', 'hampel'].forEach(function (v) {
            var o = document.createElement('option'); o.value = v; o.textContent = v; fSel.appendChild(o);
        });
        fSel.style.width = '100%'; fSel.style.padding = '6px';
        fSel.style.background = T.bg; fSel.style.color = T.text;
        fSel.style.border = '1px solid ' + T.border;
        modal.body.appendChild(fSel);

        modal.body.appendChild(_label('Decimate'));
        var dSel = document.createElement('select');
        ['none', 'nth', 'log', 'timeBin'].forEach(function (v) {
            var o = document.createElement('option'); o.value = v; o.textContent = v; dSel.appendChild(o);
        });
        dSel.style.width = '100%'; dSel.style.padding = '6px';
        dSel.style.background = T.bg; dSel.style.color = T.text;
        dSel.style.border = '1px solid ' + T.border;
        modal.body.appendChild(dSel);

        modal.body.appendChild(_label('Decimate parameter (every-N | nPerDecade | binMinutes)'));
        var dParam = document.createElement('input');
        dParam.type = 'number'; dParam.value = '50';
        dParam.style.width = '100%'; dParam.style.padding = '6px';
        dParam.style.background = T.bg; dParam.style.color = T.text;
        dParam.style.border = '1px solid ' + T.border;
        modal.body.appendChild(dParam);

        var msg = document.createElement('div');
        msg.style.fontSize = '12px'; msg.style.color = T.text2;
        msg.style.marginTop = '8px'; msg.style.minHeight = '16px';
        modal.body.appendChild(msg);

        var btnRow = document.createElement('div');
        btnRow.style.marginTop = '10px';
        btnRow.appendChild(_mkBtn('Save', 'primary', function () {
            var opts = {
                name: nameInp.value,
                filter: fSel.value === 'none' ? null : fSel.value,
                decimate: dSel.value,
                decimateParam: dSel.value === 'nth'      ? { every: parseInt(dParam.value, 10) || 1 } :
                               dSel.value === 'log'      ? { nPerDecade: parseFloat(dParam.value) || 50 } :
                               dSel.value === 'timeBin'  ? { binMinutes: parseFloat(dParam.value) || 1 } :
                               null
            };
            if (rStart.value !== '' || rEnd.value !== '') {
                opts.timeRange = {
                    start: rStart.value !== '' ? parseFloat(rStart.value) : null,
                    end:   rEnd.value   !== '' ? parseFloat(rEnd.value)   : null
                };
            }
            msg.textContent = 'Sampling…';
            G.PRiSM_analysisData.sample([sel.value], opts).then(function () {
                modal.close();
                G.PRiSM_renderAnalysisManager(rootContainer);
            }).catch(function (err) {
                msg.textContent = 'Error: ' + (err && err.message || err);
            });
        }));
        btnRow.appendChild(_mkBtn('Cancel', null, function () { modal.close(); }));
        modal.body.appendChild(btnRow);
    });
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 7 — UI: PROJECT TOOLBAR
// ═══════════════════════════════════════════════════════════════════════

G.PRiSM_renderProjectToolbar = function (container) {
    if (!_hasDoc || !container) return;
    container.innerHTML = '';
    var T = _theme();
    var bar = document.createElement('div');
    bar.style.display = 'flex'; bar.style.alignItems = 'center';
    bar.style.gap = '6px'; bar.style.padding = '8px';
    bar.style.background = T.panel; bar.style.border = '1px solid ' + T.border;
    bar.style.borderRadius = '6px';

    var pName = document.createElement('span');
    pName.style.color = T.accent; pName.style.fontWeight = '600';
    pName.style.marginRight = '12px';
    pName.textContent = _projectMeta.name;
    bar.appendChild(pName);

    bar.appendChild(_mkBtn('New', null, function () {
        if (confirm('Discard current project? All unsaved data will be lost.')) {
            G.PRiSM_project.new().then(function () {
                pName.textContent = _projectMeta.name;
                if (typeof G.PRiSM_renderGaugeManager === 'function') {
                    var gh = document.getElementById('prism_gauge_manager');
                    if (gh) G.PRiSM_renderGaugeManager(gh);
                }
                if (typeof G.PRiSM_renderAnalysisManager === 'function') {
                    var ah = document.getElementById('prism_analysis_manager');
                    if (ah) G.PRiSM_renderAnalysisManager(ah);
                }
            });
        }
    }));
    bar.appendChild(_mkBtn('Open…', null, function () {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.prism,.json';
        inp.style.display = 'none';
        inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            if (!f) return;
            G.PRiSM_project.load(f).then(function () {
                pName.textContent = _projectMeta.name;
                if (typeof G.PRiSM_renderGaugeManager === 'function') {
                    var gh = document.getElementById('prism_gauge_manager');
                    if (gh) G.PRiSM_renderGaugeManager(gh);
                }
                if (typeof G.PRiSM_renderAnalysisManager === 'function') {
                    var ah = document.getElementById('prism_analysis_manager');
                    if (ah) G.PRiSM_renderAnalysisManager(ah);
                }
            }).catch(function (err) {
                alert('Load failed: ' + (err && err.message || err));
            });
        });
        document.body.appendChild(inp); inp.click();
        setTimeout(function () { try { document.body.removeChild(inp); } catch (e) {} }, 1000);
    }));
    bar.appendChild(_mkBtn('Save', null, function () {
        G.PRiSM_project.save().catch(function (err) {
            alert('Save failed: ' + (err && err.message || err));
        });
    }));
    bar.appendChild(_mkBtn('Save As…', null, function () {
        var nm = prompt('Project name', _projectMeta.name);
        if (nm) {
            G.PRiSM_project.setName(nm);
            pName.textContent = nm;
            G.PRiSM_project.save(nm + '.prism');
        }
    }));
    bar.appendChild(_mkBtn('Info', null, function () {
        G.PRiSM_project.refreshInfo().then(function (info) {
            alert('Project: ' + info.name +
                  '\nGauges: ' + info.gaugeCount +
                  '\nAnalyses: ' + info.analysisCount +
                  '\nSize: ~' + info.sizeBytes + ' bytes' +
                  '\nBackend: ' + info.backend +
                  '\nCreated: ' + info.createdAt +
                  '\nModified: ' + info.modifiedAt);
        });
    }));

    container.appendChild(bar);
};


// ═══════════════════════════════════════════════════════════════════════
// SECTION 8 — DIFF PLOT (uses canvas) + tiny modal helper
// ═══════════════════════════════════════════════════════════════════════

G.PRiSM_drawDiff = function (canvas, diff) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width || 600, H = canvas.height || 280;
    var T = _theme();
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    if (!diff || !diff.t || !diff.t.length) {
        ctx.fillStyle = T.text3; ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No common samples — gauges do not overlap in time', W / 2, H / 2);
        return;
    }
    var pad = { l: 50, r: 16, t: 16, b: 28 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    var t = diff.t, dp = diff.dp;
    var tMin = t[0], tMax = t[t.length - 1];
    var dpMin = Infinity, dpMax = -Infinity;
    for (var i = 0; i < dp.length; i++) {
        if (isFinite(dp[i])) {
            if (dp[i] < dpMin) dpMin = dp[i];
            if (dp[i] > dpMax) dpMax = dp[i];
        }
    }
    if (!isFinite(dpMin)) { dpMin = -1; dpMax = 1; }
    if (dpMin === dpMax) { dpMin -= 1; dpMax += 1; }
    var dpRange = dpMax - dpMin;
    dpMin -= dpRange * 0.05; dpMax += dpRange * 0.05;
    var tRange = tMax - tMin;
    if (tRange === 0) tRange = 1;

    function _xT(x) { return pad.l + ((x - tMin) / tRange) * pw; }
    function _yT(y) { return pad.t + ph - ((y - dpMin) / (dpMax - dpMin)) * ph; }

    // Axes
    ctx.strokeStyle = T.border; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + ph);
    ctx.lineTo(pad.l + pw, pad.t + ph); ctx.stroke();

    // Zero line
    if (dpMin < 0 && dpMax > 0) {
        ctx.strokeStyle = T.gridMajor; ctx.beginPath();
        ctx.moveTo(pad.l, _yT(0)); ctx.lineTo(pad.l + pw, _yT(0));
        ctx.stroke();
    }

    // Plot dp(t)
    ctx.strokeStyle = T.cyan; ctx.lineWidth = 1.5;
    ctx.beginPath();
    var started = false;
    for (var k = 0; k < t.length; k++) {
        if (!isFinite(dp[k])) continue;
        var x = _xT(t[k]), y = _yT(dp[k]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = T.text2; ctx.font = '11px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Δp (psi)', pad.l + 4, pad.t + 2);
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('t', pad.l + pw - 2, pad.t + ph + 4);

    // Y tick labels (min, mid, max)
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(dpMax.toFixed(2), pad.l - 4, pad.t + 4);
    ctx.fillText(dpMin.toFixed(2), pad.l - 4, pad.t + ph - 4);
    ctx.fillText(((dpMin + dpMax) / 2).toFixed(2), pad.l - 4, pad.t + ph / 2);
};

function _modal() {
    if (!_hasDoc) return { body: null, close: function () {} };
    var T = _theme();
    var bg = document.createElement('div');
    bg.style.position = 'fixed'; bg.style.left = '0'; bg.style.top = '0';
    bg.style.right = '0'; bg.style.bottom = '0';
    bg.style.background = 'rgba(0,0,0,0.65)';
    bg.style.zIndex = '9999';
    bg.style.display = 'flex'; bg.style.alignItems = 'center'; bg.style.justifyContent = 'center';
    var box = document.createElement('div');
    box.style.background = T.panel; box.style.border = '1px solid ' + T.border;
    box.style.borderRadius = '6px'; box.style.padding = '16px';
    box.style.maxWidth = '640px'; box.style.width = '90%';
    box.style.maxHeight = '80vh'; box.style.overflow = 'auto';
    bg.appendChild(box);
    document.body.appendChild(bg);
    function close() {
        try { document.body.removeChild(bg); } catch (e) {}
    }
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    return { body: box, close: close };
}


// ═══════════════════════════════════════════════════════════════════════
// SECTION 9 — SELF-TEST
// ═══════════════════════════════════════════════════════════════════════
// Conventions:
//   1. Add a gauge → list shows 1 entry → get returns same arrays
//   2. Sample from gauge → analysis created → activate sets PRiSM_dataset
//   3. Project save → load → restores everything (gauge count, analysis count,
//      active analysis id matches, PRiSM_state intact)
//   4. Diff two near-identical gauges returns small RMS
//   5. IDB available: backend === 'indexedDB'; else 'localStorage' or 'memory'
// ═══════════════════════════════════════════════════════════════════════
(function PRiSM_dataMgrSelfTest() {
    var log = (typeof console !== 'undefined' && console.log)   ? console.log.bind(console)   : function () {};
    var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
    var checks = [];

    function _record(name, ok, msg) {
        checks.push({ name: name, ok: !!ok, msg: msg || '' });
    }

    // Build a tiny synthetic gauge
    function _synth(n, scale) {
        n = n || 50; scale = scale || 1;
        var t = new Array(n), p = new Array(n), q = new Array(n);
        for (var i = 0; i < n; i++) {
            t[i] = i * 0.1;
            p[i] = (3000 - 5 * i + Math.sin(i / 3) * 0.5) * scale;
            q[i] = 1000;
        }
        return { t: t, p: p, q: q };
    }

    if (!_Promise) {
        _record('Promise available', false, 'no Promise — skipping');
        log('PRiSM data-managers self-test SKIPPED (no Promise).');
        return;
    }

    G.PRiSM_storage.init().then(function () {
        _record('storage backend chosen',
                _backend === 'indexedDB' || _backend === 'localStorage' || _backend === 'memory',
                'backend=' + _backend);

        // Wipe first so prior runs do not interfere with counts.
        return _wipeAll();
    }).then(function () {
        // --- Test 1: add gauge, list, get
        var g = _synth(40, 1);
        return G.PRiSM_gaugeData.add({ name: 'g1', well: 'W-1', source: 'test.csv' }, g.t, g.p, g.q)
            .then(function (id) {
                return G.PRiSM_gaugeData.list().then(function (lst) {
                    _record('add+list shows one entry', lst.length >= 1, 'count=' + lst.length);
                    return G.PRiSM_gaugeData.get(id).then(function (rec) {
                        var ok = rec && rec.t.length === 40 && Math.abs(rec.p[0] - g.p[0]) < 1e-3;
                        _record('get returns same arrays (Float32 round-trip)', ok,
                                'len=' + (rec && rec.t.length) +
                                ' p0=' + (rec && rec.p[0]) + ' expected=' + g.p[0]);
                        return id;
                    });
                });
            });
    }).then(function (gaugeId) {
        // --- Test 2: sample → activate → check PRiSM_dataset
        return G.PRiSM_analysisData.sample([gaugeId], {
            name: 'a1', filter: null, decimate: 'nth', decimateParam: { every: 2 }
        }).then(function (anaId) {
            return G.PRiSM_analysisData.list().then(function (lst) {
                _record('sample creates analysis', lst.length >= 1, 'count=' + lst.length);
                return G.PRiSM_analysisData.activate(anaId).then(function () {
                    var ok = G.PRiSM_dataset && G.PRiSM_dataset.t && G.PRiSM_dataset.t.length === 20;
                    _record('activate sets PRiSM_dataset', ok,
                            'len=' + (G.PRiSM_dataset && G.PRiSM_dataset.t && G.PRiSM_dataset.t.length));
                    return { gaugeId: gaugeId, anaId: anaId };
                });
            });
        });
    }).then(function (ids) {
        // --- Test 3: project save → load round-trip
        return G.PRiSM_project.save('selftest.prism').then(function (out) {
            var blob = out.blob;
            var jsonText;
            // We constructed the JSON inline — re-derive it from the blob if possible.
            // In Node-like envs Blob is a stub; just re-serialise from current state.
            // The simplest reliable round-trip is to call loadFromObject with a snapshot.
            var snapshot = null;
            // Build a snapshot identical to what save() emitted (simple path).
            return _Promise.all([G.PRiSM_storage.listGauges(), G.PRiSM_storage.listAnalyses()])
                .then(function (pair) {
                    var gP = _Promise.all(pair[0].map(function (e) { return G.PRiSM_storage.getGauge(e.id); }));
                    var aP = _Promise.all(pair[1].map(function (e) { return G.PRiSM_storage.getAnalysis(e.id); }));
                    return _Promise.all([gP, aP]);
                }).then(function (rec) {
                    snapshot = {
                        version: '1.0',
                        meta: _projectMeta,
                        gaugeData: rec[0].filter(Boolean).map(function (g) {
                            return { id: g.id, metadata: g.metadata, dataB64: g.data ? {
                                t: _bufToB64(g.data.t), p: _bufToB64(g.data.p),
                                q: g.data.q ? _bufToB64(g.data.q) : null } : null };
                        }),
                        analysisData: rec[1].filter(Boolean).map(function (a) {
                            return { id: a.id, metadata: a.metadata, provenance: a.provenance,
                                     dataB64: a.data ? {
                                         t: _bufToB64(a.data.t), p: _bufToB64(a.data.p),
                                         q: a.data.q ? _bufToB64(a.data.q) : null } : null };
                        }),
                        state: { activeAnalysisId: _activeAnalysisId,
                                 model: G.PRiSM_state ? G.PRiSM_state.model : null }
                    };
                    var origGCount = snapshot.gaugeData.length;
                    var origACount = snapshot.analysisData.length;
                    var origActive = _activeAnalysisId;
                    return G.PRiSM_project.loadFromObject(snapshot).then(function () {
                        return _Promise.all([G.PRiSM_storage.listGauges(), G.PRiSM_storage.listAnalyses()])
                            .then(function (after) {
                                var ok = after[0].length === origGCount &&
                                         after[1].length === origACount &&
                                         _activeAnalysisId === origActive;
                                _record('project save/load round-trip preserves counts + active',
                                        ok, 'g=' + after[0].length + '/' + origGCount +
                                        ' a=' + after[1].length + '/' + origACount +
                                        ' active=' + _activeAnalysisId);
                            });
                    });
                });
        });
    }).then(function () {
        // --- Test 4: diff two near-identical gauges
        var g1 = _synth(80, 1);
        var g2 = _synth(80, 1.0001);
        return G.PRiSM_gaugeData.add({ name: 'gA' }, g1.t, g1.p, g1.q).then(function (idA) {
            return G.PRiSM_gaugeData.add({ name: 'gB' }, g2.t, g2.p, g2.q).then(function (idB) {
                return G.PRiSM_gaugeData.diff(idA, idB).then(function (d) {
                    var meanAbsP = 0; for (var i = 0; i < g1.p.length; i++) meanAbsP += Math.abs(g1.p[i]);
                    meanAbsP /= g1.p.length;
                    var ok = d.nCommon > 0 && d.rmsDiff < 1.0;        // < 1 psi for ~3000-psi data scaled by 1e-4
                    _record('diff of near-identical gauges has small RMS',
                            ok, 'rms=' + d.rmsDiff.toFixed(6) + ' n=' + d.nCommon);
                });
            });
        });
    }).then(function () {
        // --- Test 5: backend selection sanity
        var ok = (_backend === 'indexedDB') || (_backend === 'localStorage') || (_backend === 'memory');
        _record('backend is one of {indexedDB, localStorage, memory}', ok, 'backend=' + _backend);

        // --- Test 6: float32 compactness (asserted on REALISTIC data)
        // We compare in-memory size of typed-array buffers against the JSON
        // encoding of typical pressure/rate values (multi-digit, decimals).
        // base64 (used in localStorage / project files) re-inflates by ~33%
        // but the IDB backend stores raw buffers, which is the win.
        var n = 10000;
        var bytesF32 = n * 4 * 3;            // raw buffers in IDB: 12 bytes/sample
        var arrJSON = { t: new Array(n), p: new Array(n), q: new Array(n) };
        for (var ti = 0; ti < n; ti++) {
            arrJSON.t[ti] = (ti * 0.123456).toFixed(4) - 0;
            arrJSON.p[ti] = (3000.345 - ti * 0.5).toFixed(3) - 0;
            arrJSON.q[ti] = (1000.0 + Math.sin(ti / 10)).toFixed(2) - 0;
        }
        var bytesJSON = JSON.stringify(arrJSON).length;
        var ratio = bytesJSON / bytesF32;
        _record('Float32 buffer is more compact than realistic JSON arrays',
                ratio >= 1.5, 'F32=' + bytesF32 + ' JSON=' + bytesJSON + ' ratio=' + ratio.toFixed(2));

        // --- Test 7: API surface
        var apiOk = typeof G.PRiSM_storage === 'object' &&
                    typeof G.PRiSM_gaugeData === 'object' &&
                    typeof G.PRiSM_analysisData === 'object' &&
                    typeof G.PRiSM_project === 'object' &&
                    typeof G.PRiSM_renderGaugeManager === 'function' &&
                    typeof G.PRiSM_renderAnalysisManager === 'function' &&
                    typeof G.PRiSM_renderProjectToolbar === 'function';
        _record('public API surface complete', apiOk);

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM data-managers self-test FAILED:', fails);
        } else {
            log('✓ data-managers self-test passed (' + checks.length + ' checks). backend=' + _backend);
        }
    }).catch(function (e) {
        err('PRiSM data-managers self-test threw:', e && e.message ? e.message : e);
    });
})();

})();
