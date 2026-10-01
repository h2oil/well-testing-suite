// ════════════════════════════════════════════════════════════════════
// 47-calc-historian.js — Mini WellOS historian (v3.0, Round-9 plug-in)
//
// A small process historian that runs entirely in the browser:
//   • record()  — cheap in-memory buffer, flushed in batches on a short
//                 one-shot debounce (2 s) or at once when 2000 samples wait.
//                 No timer exists while the buffer is empty.
//   • storage   — auto-selected, shown on the page:
//        1. opfs    official SQLite WASM build (@sqlite.org/sqlite-wasm 3.53.4)
//                   in a dedicated Worker on the OPFS "opfs-sahpool" VFS
//                   (sync access handles are Worker-only; no COOP/COEP needed).
//        2. sqljs   sql.js 1.14.2 (SQLite compiled to WASM) in memory, the
//                   whole database file snapshotted to IndexedDB.
//        3. idb     plain IndexedDB object stores with the same API.
//        4. memory  volatile (private windows / tests); never persisted.
//      The engine that first holds data becomes "home"; if it is unavailable
//      later (another tab holds the OPFS files, offline without the library)
//      the samples are spooled to IndexedDB and merged into home next time.
//   • schema    tags(id, name, device, unit, descr, created)
//               samples(tag_id, t, v, q) — clustered PRIMARY KEY (tag_id, t)
//                 (WITHOUT ROWID: the key IS the (tag_id, t) index)
//               rollups(tag_id, t, dt, n, avg, min, max, last, lt, q, nall)
//      t = epoch ms (UTC), v = REAL or NULL, q = 0 good / 1 stale / 2 bad.
//   • retention days / maxRows / downsampleAfterDays; raw samples older than
//     downsampleAfterDays become 60-s rollups. The job runs after a flush (at
//     most every 10 min, or at once when over the row cap) — never on a timer.
//   • libraries load only on first use: web → pinned CDN URL, SHA-384 checked
//     before use (bytes that fail the check are never executed); iOS → the copy
//     bundled next to index.html (ios-app/ios-additions/libs, copied by
//     sync-from-main.js). sw.js precaches the pinned URLs for offline use.
//
// Public API (window.WTS_historian) — contract with the Modbus page:
//   record(samples)  samples = [{tag, device, t, v, q, raw, unit}]  → count accepted
//   query({tags, from, to, maxPoints, agg:'raw'|'avg'|'min'|'max'|'last', bucketMs})
//   listTags() stats() exportCSV(o) exportXLSX(o) exportDb(o) importFile(file, o)
//   purge({before, tags}) setRetention({days, maxRows, downsampleAfterDays})
//   flush() ready() engine() status() switchEngine(name)
// Inputs also accepted as document event 'wts:modbus-samples' (detail = batch).
// Tag metadata from window.WTS_modbus.getTags() when present.
// Fires document event 'wts:historian-updated' after every write.
//
// Aggregation rule (documented on the page): a bucket's avg/min/max/last use
// its GOOD samples; if it has none, its STALE samples (bucket flagged stale);
// with neither the bucket is a gap (bad). Averages are arithmetic means of the
// samples, not time-weighted. Buckets start at multiples of bucketMs since the
// Unix epoch (UTC). LTTB = Steinarsson (2013), "Downsampling Time Series for
// Visual Representation", MSc thesis, University of Iceland, §4.2.
// ════════════════════════════════════════════════════════════════════
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
function hasDoc() { return typeof document !== 'undefined' && !!document && typeof document.getElementById === 'function'; }
function $(id) { return hasDoc() ? document.getElementById(id) : null; }

// ─── §0 constants ────────────────────────────────────────────────────
var QN = ['good', 'stale', 'bad'];
var ROLLUP_MS = 60000, DAY = 86400000, MAXT = 8640000000000000;
var FLUSH_MS = 2000, FLUSH_MAX = 2000, BUFFER_CAP = 200000, CHUNK = 20000;
var RETENTION_EVERY_MS = 600000;
var LS_SETTINGS = 'wts_historian_settings', LS_VIEW = 'wts_historian_view';
var LS_HOME = 'wtshist_home', LS_SPOOL = 'wtshist_spool';      // not wts_* → never copied into project files
var IDB_NAME = 'wts-historian', SNAP_DB = 'wts-historian-sqljs', SNAP_STORE = 'files', SNAP_KEY = 'historian.sqlite';
var OPFS_VFS = 'wts-historian', OPFS_DIR = '.wts-historian', OPFS_FILE = '/historian.sqlite3';
var ENGINES = ['opfs', 'sqljs', 'idb', 'memory'];
// Raw-sample caps per engine (0 = only the user's maxRows applies). sql.js keeps the
// whole file in memory and re-writes it to IndexedDB, IndexedDB costs ~100+ bytes a row.
var ENGINE_CAPS = { opfs: 0, sqljs: 1000000, idb: 2000000, memory: 200000 };
var ENGINE_LABEL = {
    opfs: 'SQLite (OPFS, worker)', sqljs: 'SQLite (sql.js) in IndexedDB',
    idb: 'IndexedDB', memory: 'Memory only (not saved)'
};
var DEFAULTS = { days: 30, maxRows: 5000000, downsampleAfterDays: 7 };

// Pinned libraries. base64 SHA-384 of the exact published files (identical on
// jsDelivr, unpkg and the npm tarballs; checked 2026-09-29). The iOS bundle ships
// the same bytes under the key names; ios-app/scripts/sync-from-main.js re-checks them.
var CDN = 'https://cdn.jsdelivr.net/npm/', UNPKG = 'https://unpkg.com/';
var SQLITE_PKG = '@sqlite.org/sqlite-wasm@3.53.4-build1/dist/', SQLJS_PKG = 'sql.js@1.14.2/dist/';
var HIST_SHA384 = {
    'sqlite3.mjs': 'j+gbV/w2zeGv9WgmsnVPrKK5J4gE96kxDRDMpGJTnRgI68fZrprxhjFdcuoaGIdC',
    'sqlite3.wasm': 'zML1l9maR5lcyboDPcoNcYzQnFUv0o9WvMB8Pn16kfu9F+YX+62NQVuTzV0f3/07',
    'sql-wasm.js': '7Zym2PlgXfg8ap8cqJUwlZrLl+VEwt0NVbzYfhH28IWLnSpAgQOnSCY2+EXo5MtM',
    'sql-wasm.wasm': 'x0YkuPkDHnKTZcB1JO4eb6j5+eU36aka+jBA6tOKTFaTz98b9V7fPT0QgZ9qyQW2'
};
var LIBS = {
    'sqlite3.mjs': { urls: [CDN + SQLITE_PKG + 'index.mjs', UNPKG + SQLITE_PKG + 'index.mjs'], bytes: 642742 },
    'sqlite3.wasm': { urls: [CDN + SQLITE_PKG + 'sqlite3.wasm', UNPKG + SQLITE_PKG + 'sqlite3.wasm'], bytes: 868907 },
    'sql-wasm.js': { urls: [CDN + SQLJS_PKG + 'sql-wasm.js', UNPKG + SQLJS_PKG + 'sql-wasm.js'], bytes: 46535 },
    'sql-wasm.wasm': { urls: [CDN + SQLJS_PKG + 'sql-wasm.wasm', UNPKG + SQLJS_PKG + 'sql-wasm.wasm'], bytes: 658410 }
};

// Test hooks (tests/historian.test.js): fetchBytes(url) → ArrayBuffer, workerMemory → ':memory:' in the worker.
var T = { fetchBytes: null, workerMemory: false, noEstimate: false };

// ─── §1 small utilities ──────────────────────────────────────────────
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function numOr(x, d) { var n = +x; return (x === null || x === undefined || x === '' || !isFinite(n)) ? d : n; }
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function errMsg(e) { return String((e && e.message) || e || 'error'); }
function lsGet(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } }
function lsSet(k, v) { try { if (G.localStorage) G.localStorage.setItem(k, v); } catch (e) { /* quota / private mode */ } }
function lsJSON(k) { try { var s = lsGet(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }
function fmtLocal(t, ms) {
    if (!isNum(t)) return '—';
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' +
        pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + (ms ? '.' + pad3(d.getMilliseconds()) : '');
}
function isoUTC(t) { return new Date(t).toISOString(); }
function fmtVal(v) {
    if (v === null || v === undefined || !isFinite(v)) return '';
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e9 || a < 1e-4)) return v.toExponential(4);
    return String(+v.toPrecision(7));
}
function fmtCount(n) { return isNum(n) ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—'; }
function fmtBytes(n) {
    if (!isNum(n)) return '—';
    var u = ['B', 'kB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 2 : 1) : String(Math.round(n))) + ' ' + u[i];
}
function fmtDur(ms) {
    if (!isNum(ms)) return '—';
    var s = Math.abs(ms) / 1000;
    if (s < 60) return Math.round(s) + ' s';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 172800) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + ' h';
    return (s / 86400).toFixed(1) + ' d';
}
function stamp(t) { var d = new Date(t); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()); }
function uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) if (!s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } return o; }
function repeat(x, n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = x; return a; }
function isDateObj(x) { return Object.prototype.toString.call(x) === '[object Date]'; }

// Quality: 0 good, 1 stale (held / uncertain), 2 bad. A missing value is never "good".
function qCode(q, v) {
    var c = -1;
    if (q === 0 || q === 1 || q === 2) c = q;
    else if (typeof q === 'string') {
        var s = q.trim().toLowerCase();
        if (s === 'good' || s === 'g' || s === 'ok' || s === '0') c = 0;
        else if (s === 'stale' || s === 's' || s === 'uncertain' || s === 'u' || s === 'held' || s === '1') c = 1;
        else if (s === 'bad' || s === 'b' || s === 'error' || s === 'fault' || s === '2') c = 2;
    }
    if (c < 0) c = (v === null) ? 2 : 0;
    if (v === null && c === 0) c = 2;
    return c;
}
function cleanStr(x, max) { if (x === null || x === undefined) return null; var s = String(x).trim(); return s ? s.slice(0, max || 64) : null; }

// One sample from record(): {tag, device, t, v, q, raw, unit} → normalised or null.
function normSample(s, tNow) {
    if (!s || typeof s !== 'object') return null;
    var tag = cleanStr(s.tag != null ? s.tag : s.name, 128);
    if (!tag) return null;
    var t = isDateObj(s.t) ? s.t.getTime() : +s.t;
    if (s.t === null || s.t === undefined || s.t === '' || !isFinite(t)) t = tNow;
    t = Math.round(t);
    if (!(t >= 0 && t <= MAXT)) return null;
    var v = s.v;
    v = (v === null || v === undefined || v === '') ? null : +v;
    if (v !== null && !isFinite(v)) v = null;
    var o = { tag: tag, device: cleanStr(s.device), t: t, v: v, q: qCode(s.q, v), raw: s.raw, unit: cleanStr(s.unit, 32) };
    if (s.desc != null && s.desc !== '') o.desc = cleanStr(s.desc, 200);          // optional description (Mini WellOS form values)
    return o;
}

// ─── §2 pure algorithms ──────────────────────────────────────────────
// Streaming bucket aggregator (reference implementation; the SQL store computes
// the same numbers in SQL). Rows must arrive in ascending t.
function Agg(b) { this.b = b; this.out = []; this.cur = null; }
function _cat() { return { n: 0, sum: 0, min: Infinity, max: -Infinity, last: null, lt: -Infinity }; }
function _fin(c) {
    var x = c.g.n ? c.g : c.s.n ? c.s : null, q = c.g.n ? 0 : c.s.n ? 1 : 2;
    if (!x) return { t: c.k, n: 0, avg: null, min: null, max: null, last: null, lt: null, q: 2, nall: c.nall };
    return { t: c.k, n: x.n, avg: x.sum / x.n, min: x.min, max: x.max, last: x.last, lt: x.lt, q: q, nall: c.nall };
}
Agg.prototype.push = function (t, v, q) {
    var k = t - (t % this.b), c = this.cur;
    if (!c || c.k !== k) {
        if (c) this.out.push(_fin(c));
        c = this.cur = { k: k, nall: 0, g: _cat(), s: _cat() };
    }
    c.nall++;
    if (v === null || v === undefined || !isFinite(v)) return;
    var x = q === 0 ? c.g : q === 1 ? c.s : null;
    if (!x) return;
    x.n++; x.sum += v;
    if (v < x.min) x.min = v;
    if (v > x.max) x.max = v;
    if (t >= x.lt) { x.lt = t; x.last = v; }
};
Agg.prototype.result = function () { if (this.cur) { this.out.push(_fin(this.cur)); this.cur = null; } return this.out; };
function aggArrays(t, v, q, b) { var a = new Agg(b); for (var i = 0; i < t.length; i++) a.push(t[i], v[i], q[i]); return a.result(); }

// Combine bucket partials {t,n,avg,min,max,last,lt,q,nall} into buckets of b ms
// (b = 0 → by exact t). Same rule as Agg: good partials if any, else stale, else a gap.
// Merging partials chosen that way gives the same result as re-aggregating the samples.
function _combine(k, src, q, nall) {
    if (!src.length) return { t: k, n: 0, avg: null, min: null, max: null, last: null, lt: null, q: 2, nall: nall };
    if (src.length === 1) { var o = src[0]; return { t: k, n: o.n, avg: o.avg, min: o.min, max: o.max, last: o.last, lt: o.lt, q: q, nall: nall }; }
    var n = 0, sum = 0, mn = Infinity, mx = -Infinity, last = null, lt = -Infinity;
    for (var i = 0; i < src.length; i++) {
        var p = src[i];
        n += p.n; sum += p.avg * p.n;
        if (p.min < mn) mn = p.min;
        if (p.max > mx) mx = p.max;
        if (p.lt > lt) { lt = p.lt; last = p.last; }
    }
    return { t: k, n: n, avg: sum / n, min: mn, max: mx, last: last, lt: lt, q: q, nall: nall };
}
function mergePartials(list, b) {
    var map = {}, keys = [];
    for (var i = 0; i < list.length; i++) {
        var p = list[i], k = b ? p.t - (p.t % b) : p.t, m = map[k];
        if (!m) { m = map[k] = { g: [], s: [], nall: 0 }; keys.push(k); }
        m.nall += (p.nall || 0);
        if (p.q === 0 && p.n > 0) m.g.push(p); else if (p.q === 1 && p.n > 0) m.s.push(p);
    }
    keys.sort(function (a, c) { return a - c; });
    return keys.map(function (k) {
        var m = map[k];
        return _combine(k, m.g.length ? m.g : m.s, m.g.length ? 0 : m.s.length ? 1 : 2, m.nall);
    });
}

// Largest-Triangle-Three-Buckets over indices [i0, i1): returns kept indices.
// Transcribed from Steinarsson (2013) §4.2 / his reference implementation: first and
// last points kept; the rest split into (threshold−2) equal buckets; in each bucket the
// point forming the largest triangle with the previously kept point and the average
// of the next bucket is kept.
function lttbIdx(x, y, i0, i1, threshold) {
    var len = i1 - i0, out = [], j;
    if (threshold >= len || threshold < 3) { for (j = i0; j < i1; j++) out.push(j); return out; }
    var every = (len - 2) / (threshold - 2), a = i0;
    out.push(i0);
    for (var i = 0; i < threshold - 2; i++) {
        var s = i0 + Math.floor((i + 1) * every) + 1, e = i0 + Math.floor((i + 2) * every) + 1;
        if (e > i1) e = i1;
        var ax2 = 0, ay2 = 0, cnt = e - s;
        for (j = s; j < e; j++) { ax2 += x[j]; ay2 += y[j]; }
        ax2 /= cnt; ay2 /= cnt;
        var r0 = i0 + Math.floor(i * every) + 1, r1 = i0 + Math.floor((i + 1) * every) + 1;
        var ax = x[a], ay = y[a], best = -1, next = r0;
        for (j = r0; j < r1; j++) {
            var area = Math.abs((ax - ax2) * (y[j] - ay) - (ax - x[j]) * (ay2 - ay)) * 0.5;
            if (area > best) { best = area; next = j; }
        }
        out.push(next); a = next;
    }
    out.push(i1 - 1);
    return out;
}
// LTTB that respects gaps: points with no value or bad quality split the series
// into runs; each gap keeps one marker point, each run gets a share of the budget
// proportional to its length (at least its two end points). Returns kept indices
// (ascending) or null when nothing needs dropping.
function decimate(t, v, q, maxPoints) {
    var n = t.length;
    if (!(maxPoints > 0) || n <= maxPoints) return null;
    var ok = function (i) { return v[i] !== null && v[i] !== undefined && isFinite(v[i]) && q[i] !== 2; };
    var runs = [], keep = [], i = 0, total = 0;
    while (i < n) {
        if (ok(i)) { var s = i; while (i < n && ok(i)) i++; runs.push([s, i]); total += i - s; }
        else { keep.push(i); while (i < n && !ok(i)) i++; }
    }
    var budget = Math.max(maxPoints - keep.length, runs.length * 2);
    runs.forEach(function (r) {
        var len = r[1] - r[0], alloc = Math.max(Math.min(len, 2), Math.round(budget * len / Math.max(1, total)));
        var idx = alloc >= len ? null : alloc < 3 ? (len === 1 ? [r[0]] : [r[0], r[1] - 1]) : lttbIdx(t, v, r[0], r[1], alloc);
        if (!idx) { for (var j = r[0]; j < r[1]; j++) keep.push(j); } else keep.push.apply(keep, idx);
    });
    keep.sort(function (a, b) { return a - b; });
    return keep;
}

var BUCKETS = [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 6048e5];
function niceBucket(ms) { for (var i = 0; i < BUCKETS.length; i++) if (BUCKETS[i] >= ms) return BUCKETS[i]; return Math.ceil(ms / 864e5) * 864e5; }
function bucketLabel(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000) + ' s';
    if (ms < 3600000) return (ms / 60000) + ' min';
    if (ms < DAY) return (ms / 3600000) + ' h';
    return (ms / DAY) + ' d';
}
// "Nice" axis ticks (Heckbert, "Nice numbers for graph labels", Graphics Gems, 1990).
function niceNum(x, round) {
    var e = Math.floor(Math.log(x) / Math.LN10), f = x / Math.pow(10, e), nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, e);
}
function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { var d0 = Math.abs(lo) * 0.05 || 1; lo -= d0; hi += d0; }
    var range = niceNum(hi - lo, false), step = niceNum(range / Math.max(1, n - 1), true);
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, ticks = [];
    for (var x = a; x <= b + step * 0.5 && ticks.length < 50; x += step) ticks.push(+x.toPrecision(12));
    return { lo: a, hi: b, step: step, ticks: ticks };
}
var TSTEPS = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 6048e5, 2592e6];
function timeTicks(from, to, maxTicks) {
    var span = to - from, step = TSTEPS[TSTEPS.length - 1];
    for (var i = 0; i < TSTEPS.length; i++) if (span / TSTEPS[i] <= Math.max(2, maxTicks)) { step = TSTEPS[i]; break; }
    var tz = -new Date(from).getTimezoneOffset() * 60000;            // align hour/day ticks to local time
    var off = step >= 36e5 ? tz : 0, out = [];
    for (var t = Math.ceil((from + off) / step) * step - off; t <= to && out.length < 60; t += step) out.push(t);
    return { step: step, ticks: out };
}
function tickLabel(t, step, span) {
    var d = new Date(t);
    if (step >= DAY) return pad2(d.getDate()) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (step < 60000) return hm + ':' + pad2(d.getSeconds());
    if (span > DAY && d.getHours() === 0 && d.getMinutes() === 0) return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
    return hm;
}

// ─── §3 CSV / time parsing ───────────────────────────────────────────
function csvCell(s) { s = (s === null || s === undefined) ? '' : String(s); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function csvLine(row) { return row.map(csvCell).join(',') + '\r\n'; }
function parseDelimited(text) {
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var nl = text.indexOf('\n'), first = nl < 0 ? text : text.slice(0, nl);
    var cnt = function (ch) { return first.split(ch).length - 1; };
    var d = ',', nc = cnt(','), ns = cnt(';'), nt = cnt('\t');
    if (nt > nc && nt >= ns) d = '\t'; else if (ns > nc) d = ';';
    var rows = [], row = [], cell = '', i = 0, n = text.length, inQ = false;
    while (i < n) {
        var c = text[i];
        if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
            cell += c; i++; continue;
        }
        if (c === '"' && cell === '') { inQ = true; i++; continue; }
        if (c === d) { row.push(cell); cell = ''; i++; continue; }
        if (c === '\r' || c === '\n') {
            row.push(cell); cell = '';
            if (!(row.length === 1 && row[0] === '')) rows.push(row);
            row = [];
            i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
            continue;
        }
        cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); if (!(row.length === 1 && row[0] === '')) rows.push(row); }
    return rows;
}
// Time cell → epoch ms. ISO strings with Z/offset → exact; "YYYY-MM-DD HH:MM[:SS[.mmm]]"
// without a zone → local time; numbers: > 1e11 epoch ms, > 1e9 epoch s, else an Excel
// serial day number (read as UTC, the way this page writes times).
function epochFromNumber(n) {
    if (n > 1e11) return Math.round(n);
    if (n > 1e9) return Math.round(n * 1000);
    if (n > 0 && n < 2958466) return Math.round((n - 25569) * DAY);
    return NaN;
}
function parseTime(x) {
    if (x === null || x === undefined || x === '') return NaN;
    if (typeof x === 'number') return epochFromNumber(x);
    if (isDateObj(x)) return x.getTime();
    var s = String(x).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return epochFromNumber(+s);
    if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) && /^\d{4}-\d/.test(s)) return Date.parse(s.replace(' ', 'T'));
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +((m[7] || '0') + '00').slice(0, 3)).getTime();
    var p = Date.parse(s);
    return isFinite(p) ? p : NaN;
}
var LONG_HEAD = ['time_utc', 'epoch_ms', 'tag', 'value', 'quality', 'unit', 'device', 'source', 'n', 'min', 'max'];
// Spreadsheet rows (array of arrays) → {format, tags:{name:{unit,device}}, samples:{tag:{t,v,q}}, rollups:{tag:[…]}, invalid}
// Long layout: columns tag + value (+ time_utc / epoch_ms, quality, unit, device, source, n, min, max).
// Wide layout: a time column then one column per tag, headed "TAG [unit]".
function rowsToImport(aoa) {
    var hi = -1, i, j;
    for (i = 0; i < Math.min(aoa.length, 25); i++) {
        var r = aoa[i] || [], filled = 0, text = false;
        for (j = 0; j < r.length; j++) {
            var c = r[j];
            if (c === null || c === undefined || String(c).trim() === '') continue;
            filled++;
            if (typeof c === 'string' && !isFinite(+c)) text = true;
        }
        if (filled >= 2 && text) { hi = i; break; }
    }
    if (hi < 0) throw new Error('No header row found — expected columns such as time_utc, tag, value.');
    var H = aoa[hi].map(function (c) { return String(c == null ? '' : c).trim(); }), h = H.map(function (x) { return x.toLowerCase(); });
    var col = function (names) { for (var k = 0; k < names.length; k++) { var ix = h.indexOf(names[k]); if (ix >= 0) return ix; } return -1; };
    var cT = col(['time_utc', 'time', 'timestamp', 'datetime', 'date_time', 'date', 'time (utc)', 'local_time', 'bucket_start']);
    var cE = col(['epoch_ms', 'epoch', 't_ms', 'unix_ms', 't']);
    var out = { format: '', tags: {}, samples: {}, rollups: {}, invalid: 0, rows: 0 };
    var timeOf = function (row) { var t = cE >= 0 ? parseTime(row[cE]) : NaN; if (!isFinite(t) && cT >= 0) t = parseTime(row[cT]); return t; };
    var ser = function (tag) { return out.samples[tag] || (out.samples[tag] = { t: [], v: [], q: [] }); };
    var numCell = function (c) { if (c === null || c === undefined || String(c).trim() === '') return null; var x = +c; return isFinite(x) ? x : NaN; };
    if (cE < 0 && cT < 0) throw new Error('No time column found — expected time_utc, epoch_ms or timestamp.');
    var cTag = col(['tag', 'tag_name', 'name', 'tagname']), cV = col(['value', 'v', 'val', 'avg']);
    if (cTag >= 0 && cV >= 0) {
        out.format = 'long';
        var cQ = col(['quality', 'q']), cU = col(['unit', 'units']), cD = col(['device']), cS = col(['source']),
            cN = col(['n', 'count']), cMin = col(['min']), cMax = col(['max']);
        for (i = hi + 1; i < aoa.length; i++) {
            var row = aoa[i] || [];
            if (!row.length || row.every(function (c) { return c === null || c === undefined || String(c).trim() === ''; })) continue;
            out.rows++;
            var tag = cleanStr(row[cTag], 128), t = timeOf(row), v = numCell(row[cV]);
            if (!tag || !isFinite(t) || t < 0 || (typeof v === 'number' && !isFinite(v))) { out.invalid++; continue; }
            var q = qCode(cQ >= 0 ? row[cQ] : undefined, v);
            if (!out.tags[tag]) out.tags[tag] = { unit: cU >= 0 ? cleanStr(row[cU], 32) : null, device: cD >= 0 ? cleanStr(row[cD]) : null };
            var src = cS >= 0 ? String(row[cS] || '').toLowerCase() : '';
            if (/^rollup/.test(src)) {
                var nn = numCell(cN >= 0 ? row[cN] : null), mn = numCell(cMin >= 0 ? row[cMin] : null), mx = numCell(cMax >= 0 ? row[cMax] : null);
                if (v === null || !isNum(nn) || nn < 1) { out.invalid++; continue; }
                (out.rollups[tag] || (out.rollups[tag] = [])).push({ t: Math.round(t), n: Math.round(nn), avg: v, min: isNum(mn) ? mn : v, max: isNum(mx) ? mx : v,
                    last: v, lt: Math.round(t), q: q === 2 ? 2 : q, nall: Math.round(nn), dt: ROLLUP_MS });
                continue;
            }
            var s = ser(tag); s.t.push(Math.round(t)); s.v.push(v); s.q.push(q);
        }
        return out;
    }
    out.format = 'wide';
    var cols = [];
    for (j = 0; j < H.length; j++) {
        if (j === cT || j === cE || !H[j]) continue;
        if (/^(local_time|n|quality)$/i.test(H[j])) continue;
        var m = /^(.*?)\s*\[(.*)\]\s*$/.exec(H[j]), tg = cleanStr(m ? m[1] : H[j], 128);
        if (!tg) continue;
        cols.push({ j: j, tag: tg });
        if (!out.tags[tg]) out.tags[tg] = { unit: m ? cleanStr(m[2], 32) : null, device: null };
    }
    if (!cols.length) throw new Error('No value columns found next to the time column.');
    for (i = hi + 1; i < aoa.length; i++) {
        var rw = aoa[i] || [];
        if (!rw.length) continue;
        out.rows++;
        var tt = timeOf(rw);
        if (!isFinite(tt) || tt < 0) { out.invalid++; continue; }
        for (var k = 0; k < cols.length; k++) {
            var val = numCell(rw[cols[k].j]);
            if (val === null) continue;
            if (!isFinite(val)) { out.invalid++; continue; }
            var sw = ser(cols[k].tag); sw.t.push(Math.round(tt)); sw.v.push(val); sw.q.push(0);
        }
    }
    return out;
}

// ─── §4 stores ───────────────────────────────────────────────────────
// Every store exposes the same (async on the outside) methods:
//   init() info() getTags() putTags(list) putSamples(ids,ts,vs,qs,mode) getSamples(id,from,to,limit,desc)
//   countSamples(id,from,to) deleteSamples(id,from,to) aggSamples(id,from,to,b) statsAll()
//   putRollups(id,parts) getRollups(id,from,to) countRollups(id,from,to) deleteRollups(id,from,to)
//   totals() clear() vacuum() close() [+ exportBytes() on the SQL stores]
// mode: 'ignore' keeps an existing (tag_id, t) row, 'replace' overwrites it.

// SQL store over a tiny adapter A {all(sql,p) → rows[], run(sql,p) → changes, prep(sql) → {run, all, free},
// exportBytes(), close(), version}. Self-contained (no outer references): its source is
// also shipped into the storage Worker with Function.prototype.toString.
function HistSqlStore(A) {
    var SCHEMA = [
        'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
        'CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, device TEXT, unit TEXT, descr TEXT, created INTEGER)',
        // Clustered primary key (tag_id, t): the table is its own (tag_id, t) index.
        'CREATE TABLE IF NOT EXISTS samples (tag_id INTEGER NOT NULL, t INTEGER NOT NULL, v REAL, q INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tag_id, t)) WITHOUT ROWID',
        'CREATE TABLE IF NOT EXISTS rollups (tag_id INTEGER NOT NULL, t INTEGER NOT NULL, dt INTEGER NOT NULL, n INTEGER NOT NULL, avg REAL, min REAL, max REAL, last REAL, lt INTEGER, q INTEGER NOT NULL, nall INTEGER NOT NULL, PRIMARY KEY (tag_id, t)) WITHOUT ROWID'
    ];
    // Bucket start = t − (t mod b): SQLite's % casts both sides to INTEGER, so the bucket
    // is exact whatever type the driver binds b as. Per bucket: the good and the stale
    // statistics side by side; the last value of each is looked up by its time.
    var AGG = 'SELECT g.k, g.nall, g.ng, g.ag, g.ming, g.maxg, g.ltg, (SELECT v FROM samples WHERE tag_id=?2 AND t=g.ltg), ' +
        'g.ns, g.as1, g.mins, g.maxs, g.lts, (SELECT v FROM samples WHERE tag_id=?2 AND t=g.lts) FROM (' +
        'SELECT t - (t % ?1) AS k, count(*) AS nall, ' +
        'sum(CASE WHEN q=0 AND v IS NOT NULL THEN 1 ELSE 0 END) AS ng, avg(CASE WHEN q=0 THEN v END) AS ag, ' +
        'min(CASE WHEN q=0 THEN v END) AS ming, max(CASE WHEN q=0 THEN v END) AS maxg, max(CASE WHEN q=0 AND v IS NOT NULL THEN t END) AS ltg, ' +
        'sum(CASE WHEN q=1 AND v IS NOT NULL THEN 1 ELSE 0 END) AS ns, avg(CASE WHEN q=1 THEN v END) AS as1, ' +
        'min(CASE WHEN q=1 THEN v END) AS mins, max(CASE WHEN q=1 THEN v END) AS maxs, max(CASE WHEN q=1 AND v IS NOT NULL THEN t END) AS lts ' +
        'FROM samples WHERE tag_id=?2 AND t>=?3 AND t<=?4 GROUP BY k) g ORDER BY g.k';
    function N(x) { return (x === null || x === undefined) ? null : Number(x); }
    function rows(sql, p) { return A.all(sql, p || []); }
    function one(sql, p) { var r = rows(sql, p); return r.length ? r[0] : null; }
    function tx(fn) {
        A.run('BEGIN');
        try { var r = fn(); A.run('COMMIT'); return r; }
        catch (e) { try { A.run('ROLLBACK'); } catch (e2) { /* already rolled back */ } throw e; }
    }
    function part(k, n, avg, mn, mx, last, lt, q, nall) {
        return { t: N(k), n: N(n), avg: N(avg), min: N(mn), max: N(mx), last: N(last), lt: N(lt), q: q, nall: N(nall) };
    }
    function tagRow(r) { return { id: N(r[0]), name: String(r[1]), device: r[2] == null ? null : String(r[2]), unit: r[3] == null ? null : String(r[3]), descr: r[4] == null ? null : String(r[4]), created: N(r[5]) }; }
    function rollRow(r) { return { t: N(r[0]), dt: N(r[1]), n: N(r[2]), avg: N(r[3]), min: N(r[4]), max: N(r[5]), last: N(r[6]), lt: N(r[7]), q: N(r[8]), nall: N(r[9]) }; }
    function putR(id, parts) {                                         // caller holds a transaction
        var st = A.prep('INSERT OR REPLACE INTO rollups (tag_id, t, dt, n, avg, min, max, last, lt, q, nall) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        try {
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i];
                st.run([id, p.t, p.dt || 60000, p.n, p.avg, p.min, p.max, p.last, p.lt, p.q, p.nall == null ? p.n : p.nall]);
            }
        } finally { st.free(); }
    }
    var S = {
        kind: 'sql',
        init: function () {
            var tables = N(one("SELECT count(*) FROM sqlite_master WHERE type='table'")[0]);
            if (!tables) A.run('PRAGMA auto_vacuum=INCREMENTAL');        // only effective before the first table
            SCHEMA.forEach(function (s) { A.run(s); });
            A.run("INSERT OR IGNORE INTO meta(k, v) VALUES ('schema', '1')");
            A.run("INSERT OR IGNORE INTO meta(k, v) VALUES ('created', ?)", [String(Date.now())]);
            return S.info();
        },
        info: function () {
            var pc = N(one('PRAGMA page_count')[0]), ps = N(one('PRAGMA page_size')[0]), fl = N(one('PRAGMA freelist_count')[0]);
            return { version: String(one('SELECT sqlite_version()')[0]), bytes: pc * ps, freeBytes: fl * ps, pageSize: ps };
        },
        getTags: function () { return rows('SELECT id, name, device, unit, descr, created FROM tags ORDER BY id').map(tagRow); },
        putTags: function (list) {
            var st = A.prep('INSERT INTO tags (name, device, unit, descr, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET ' +
                'device = coalesce(excluded.device, tags.device), unit = coalesce(excluded.unit, tags.unit), descr = coalesce(excluded.descr, tags.descr)');
            try {
                tx(function () {
                    for (var i = 0; i < list.length; i++) {
                        var x = list[i];
                        st.run([String(x.name), x.device == null ? null : String(x.device), x.unit == null ? null : String(x.unit),
                            x.descr == null ? null : String(x.descr), x.created == null ? Date.now() : Number(x.created)]);
                    }
                });
            } finally { st.free(); }
            return S.getTags();
        },
        putSamples: function (ids, ts, vs, qs, mode) {
            var ins = A.prep('INSERT OR IGNORE INTO samples (tag_id, t, v, q) VALUES (?, ?, ?, ?)');
            var upd = mode === 'replace' ? A.prep('UPDATE samples SET v = ?, q = ? WHERE tag_id = ? AND t = ?') : null;
            var r = { inserted: 0, updated: 0, skipped: 0, byTag: {} };
            try {
                tx(function () {
                    for (var i = 0; i < ids.length; i++) {
                        var v = (vs[i] === null || vs[i] === undefined) ? null : Number(vs[i]);
                        if (ins.run([ids[i], ts[i], v, qs[i]])) { r.inserted++; r.byTag[ids[i]] = (r.byTag[ids[i]] || 0) + 1; }
                        else if (upd) { upd.run([v, qs[i], ids[i], ts[i]]); r.updated++; }
                        else r.skipped++;
                    }
                });
            } finally { ins.free(); if (upd) upd.free(); }
            return r;
        },
        getSamples: function (id, from, to, limit, desc) {
            var sql = 'SELECT t, v, q FROM samples WHERE tag_id = ? AND t >= ? AND t <= ? ORDER BY t ' + (desc ? 'DESC' : 'ASC') +
                (limit > 0 ? ' LIMIT ' + Math.floor(limit) : '');
            var rs = rows(sql, [id, from, to]), o = { t: new Array(rs.length), v: new Array(rs.length), q: new Array(rs.length) };
            for (var i = 0; i < rs.length; i++) { o.t[i] = N(rs[i][0]); o.v[i] = N(rs[i][1]); o.q[i] = N(rs[i][2]); }
            return o;
        },
        countSamples: function (id, from, to) { return N(one('SELECT count(*) FROM samples WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to])[0]); },
        deleteSamples: function (id, from, to) { return A.run('DELETE FROM samples WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to]); },
        aggSamples: function (id, from, to, b) {
            return rows(AGG, [Math.max(1, Math.round(b)), id, from, to]).map(function (r) {
                var ng = N(r[2]), ns = N(r[8]);
                if (ng > 0) return part(r[0], ng, r[3], r[4], r[5], r[7], r[6], 0, r[1]);
                if (ns > 0) return part(r[0], ns, r[9], r[10], r[11], r[13], r[12], 1, r[1]);
                return part(r[0], 0, null, null, null, null, null, 2, r[1]);
            });
        },
        statsAll: function () {
            var o = {};
            rows('SELECT tag_id, count(*), min(t), max(t) FROM samples GROUP BY tag_id').forEach(function (r) { o[N(r[0])] = { n: N(r[1]), first: N(r[2]), last: N(r[3]), rn: 0, rfirst: null, rlast: null }; });
            rows('SELECT tag_id, count(*), min(t), max(t) FROM rollups GROUP BY tag_id').forEach(function (r) {
                var x = o[N(r[0])] || (o[N(r[0])] = { n: 0, first: null, last: null });
                x.rn = N(r[1]); x.rfirst = N(r[2]); x.rlast = N(r[3]);
            });
            rows('SELECT s.tag_id, s.t, s.v, s.q FROM samples s JOIN (SELECT tag_id, max(t) AS mt FROM samples GROUP BY tag_id) m ON s.tag_id = m.tag_id AND s.t = m.mt')
                .forEach(function (r) { var x = o[N(r[0])]; if (x) { x.lastV = N(r[2]); x.lastQ = N(r[3]); } });
            return o;
        },
        putRollups: function (id, parts) { tx(function () { putR(id, parts); }); return parts.length; },
        // Rollups in, the raw rows they replace out — one transaction, so a snapshot or a crash
        // never sees both (which would count those samples twice) or neither.
        rollupWrite: function (id, parts, cut) {
            return tx(function () { putR(id, parts); return A.run('DELETE FROM samples WHERE tag_id = ? AND t >= 0 AND t <= ?', [id, cut - 1]); });
        },
        getRollups: function (id, from, to) {
            return rows('SELECT t, dt, n, avg, min, max, last, lt, q, nall FROM rollups WHERE tag_id = ? AND t >= ? AND t <= ? ORDER BY t', [id, from, to]).map(rollRow);
        },
        countRollups: function (id, from, to) { return N(one('SELECT count(*) FROM rollups WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to])[0]); },
        deleteRollups: function (id, from, to) { return A.run('DELETE FROM rollups WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to]); },
        totals: function () {
            return { samples: N(one('SELECT count(*) FROM samples')[0]), rollups: N(one('SELECT count(*) FROM rollups')[0]), tags: N(one('SELECT count(*) FROM tags')[0]) };
        },
        clear: function () {
            tx(function () { A.run('DELETE FROM samples'); A.run('DELETE FROM rollups'); A.run('DELETE FROM tags'); });
            S.vacuum();
            return true;
        },
        vacuum: function () { try { A.all('PRAGMA incremental_vacuum', []); } catch (e) { /* not in auto-vacuum mode */ } return true; },
        exportBytes: function () { return A.exportBytes(); },
        close: function () { A.close(); return true; }
    };
    return S;
}

// sql.js adapter (main thread).
function histSqlJsAdapter(db) {
    function bindArgs(p) { return p && p.length ? p : undefined; }
    return {
        all: function (sql, p) {
            var st = db.prepare(sql), out = [];
            try { if (p && p.length) st.bind(p); while (st.step()) out.push(st.get()); } finally { st.free(); }
            return out;
        },
        run: function (sql, p) { db.run(sql, bindArgs(p)); return db.getRowsModified(); },
        prep: function (sql) {
            var st = db.prepare(sql);
            return { run: function (p) { st.run(p); return db.getRowsModified(); }, free: function () { st.free(); } };
        },
        exportBytes: function () { return db.export(); },
        close: function () { db.close(); }
    };
}
// Official SQLite WASM (oo1 API) adapter — runs inside the storage Worker. Self-contained.
function histWasmAdapter(sqlite3, db) {
    function bind(p) { return (p && p.length) ? p : undefined; }
    return {
        all: function (sql, p) { return db.exec({ sql: sql, bind: bind(p), rowMode: 'array', returnValue: 'resultRows' }); },
        run: function (sql, p) { db.exec({ sql: sql, bind: bind(p) }); return db.changes(); },
        prep: function (sql) {
            var st = db.prepare(sql);
            return { run: function (p) { st.bind(p); st.stepReset(); return db.changes(); }, free: function () { st.finalize(); } };
        },
        exportBytes: function () { return sqlite3.capi.sqlite3_js_db_export(db); },
        close: function () { db.close(); }
    };
}

// Wrap a synchronous store so every method returns a Promise.
function asyncStore(sync, kind, extra) {
    var o = { kind: kind };
    Object.keys(sync).forEach(function (k) {
        if (typeof sync[k] !== 'function') return;
        o[k] = function () { try { return Promise.resolve(sync[k].apply(sync, arguments)); } catch (e) { return Promise.reject(e); } };
    });
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
}

// Partial ↔ compact array (IndexedDB / memory values).
function rollToArr(p) { return [p.t, p.dt || ROLLUP_MS, p.n, p.avg, p.min, p.max, p.last, p.lt, p.q, p.nall == null ? p.n : p.nall]; }
function arrToRoll(a) { return { t: a[0], dt: a[1], n: a[2], avg: a[3], min: a[4], max: a[5], last: a[6], lt: a[7], q: a[8], nall: a[9] }; }

// IndexedDB store: object stores meta / tags (keyPath id, unique index name) /
// samples (key [tag_id, t] → [t, v, q]) / rollups (key [tag_id, t] → rollup array).
function idbReq(r) {
    return new Promise(function (res, rej) {
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error || new Error('IndexedDB request failed')); };
    });
}
function idbDone(tx) {
    return new Promise(function (res, rej) {
        tx.oncomplete = function () { res(); };
        tx.onabort = function () { rej(tx.error || new Error('IndexedDB transaction aborted')); };
    });
}
function idbOpen(idb, name, upgrade) {
    return new Promise(function (res, rej) {
        var r;
        try { r = idb.open(name, 1); } catch (e) { rej(e); return; }
        r.onupgradeneeded = function () { try { upgrade(r.result); } catch (e) { rej(e); } };
        r.onsuccess = function () { var d = r.result; d.onversionchange = function () { try { d.close(); } catch (e) {} }; res(d); };
        r.onerror = function () { rej(r.error || new Error('IndexedDB open failed')); };
    });
}
function IdbStore(idb, KR) {
    var db = null;
    function has(d, n) { return d.objectStoreNames && (typeof d.objectStoreNames.contains === 'function' ? d.objectStoreNames.contains(n) : Array.prototype.indexOf.call(d.objectStoreNames, n) >= 0); }
    function rng(id, from, to) { return KR.bound([id, from], [id, to]); }
    function ro(names) { return db.transaction(names, 'readonly'); }
    function rw(names) { return db.transaction(names, 'readwrite'); }
    function readChunks(store, id, from, to, onChunk) {
        var lo = from;
        function step() {
            if (lo > to) return Promise.resolve();
            return idbReq(ro(store).objectStore(store).getAll(rng(id, lo, to), CHUNK)).then(function (arr) {
                if (!arr.length) return;
                onChunk(arr);
                if (arr.length < CHUNK) return;
                lo = arr[arr.length - 1][0] + 1;
                return step();
            });
        }
        return step();
    }
    function countIn(store, id, from, to) { return idbReq(ro(store).objectStore(store).count(rng(id, from, to))); }
    function deleteIn(store, id, from, to) {
        var tx = rw(store), st = tx.objectStore(store), r = rng(id, from, to), n = 0;
        idbReq(st.count(r)).then(function (c) { n = c; });
        st.delete(r);
        return idbDone(tx).then(function () { return n; });
    }
    var S = {
        kind: 'idb',
        init: function () {
            return idbOpen(idb, IDB_NAME, function (d) {
                if (!has(d, 'meta')) d.createObjectStore('meta');
                if (!has(d, 'tags')) d.createObjectStore('tags', { keyPath: 'id' }).createIndex('name', 'name', { unique: true });
                if (!has(d, 'samples')) d.createObjectStore('samples');
                if (!has(d, 'rollups')) d.createObjectStore('rollups');
            }).then(function (d) { db = d; return S.info(); });
        },
        info: function () { return Promise.resolve({ version: 'IndexedDB', bytes: null }); },
        getTags: function () {
            return idbReq(ro('tags').objectStore('tags').getAll()).then(function (a) { return a.slice().sort(function (x, y) { return x.id - y.id; }); });
        },
        putTags: function (list) {
            return S.getTags().then(function (cur) {
                var byName = {}, maxId = 0;
                cur.forEach(function (t) { byName[t.name] = t; if (t.id > maxId) maxId = t.id; });
                var tx = rw('tags'), st = tx.objectStore('tags');
                list.forEach(function (x) {
                    var name = String(x.name), old = byName[name];
                    var rec = old ? { id: old.id, name: name, device: x.device != null ? String(x.device) : old.device, unit: x.unit != null ? String(x.unit) : old.unit,
                        descr: x.descr != null ? String(x.descr) : old.descr, created: old.created }
                        : { id: ++maxId, name: name, device: x.device != null ? String(x.device) : null, unit: x.unit != null ? String(x.unit) : null,
                            descr: x.descr != null ? String(x.descr) : null, created: x.created != null ? +x.created : Date.now() };
                    byName[name] = rec;
                    st.put(rec);
                });
                return idbDone(tx);
            }).then(S.getTags);
        },
        putSamples: function (ids, ts, vs, qs, mode) {
            var r = { inserted: 0, updated: 0, skipped: 0, byTag: {} };
            if (!ids.length) return Promise.resolve(r);
            var tx = rw('samples'), st = tx.objectStore('samples');
            ids.forEach(function (id, i) {
                var key = [id, ts[i]], val = [ts[i], (vs[i] === undefined ? null : vs[i]), qs[i]];
                var q = st.add(val, key);
                q.onsuccess = function () { r.inserted++; r.byTag[id] = (r.byTag[id] || 0) + 1; };
                q.onerror = function (ev) {
                    // Existing (tag, t): keep the transaction alive and skip or overwrite.
                    // Any other error (quota, bad key) is left to abort the transaction.
                    if (!q.error || q.error.name !== 'ConstraintError') return;
                    if (ev && ev.preventDefault) ev.preventDefault();
                    if (ev && ev.stopPropagation) ev.stopPropagation();
                    if (mode === 'replace') st.put(val, key).onsuccess = function () { r.updated++; };
                    else r.skipped++;
                };
            });
            return idbDone(tx).then(function () { return r; });
        },
        getSamples: function (id, from, to, limit, desc) {
            var o = { t: [], v: [], q: [] };
            var push = function (a) { o.t.push(a[0]); o.v.push(a[1]); o.q.push(a[2]); };
            if (!desc && !(limit > 0)) return readChunks('samples', id, from, to, function (arr) { arr.forEach(push); }).then(function () { return o; });
            if (!desc) return idbReq(ro('samples').objectStore('samples').getAll(rng(id, from, to), limit)).then(function (arr) { arr.forEach(push); return o; });
            return new Promise(function (res, rej) {
                var c = ro('samples').objectStore('samples').openCursor(rng(id, from, to), 'prev');
                c.onsuccess = function () {
                    var cur = c.result;
                    if (!cur || (limit > 0 && o.t.length >= limit)) { res(o); return; }
                    push(cur.value); cur.continue();
                };
                c.onerror = function () { rej(c.error); };
            });
        },
        countSamples: function (id, from, to) { return countIn('samples', id, from, to); },
        deleteSamples: function (id, from, to) { return deleteIn('samples', id, from, to); },
        aggSamples: function (id, from, to, b) {
            var a = new Agg(Math.max(1, Math.round(b)));
            return readChunks('samples', id, from, to, function (arr) { for (var i = 0; i < arr.length; i++) a.push(arr[i][0], arr[i][1], arr[i][2]); })
                .then(function () { return a.result(); });
        },
        statsAll: function () {
            return S.getTags().then(function (tags) {
                var o = {};
                return tags.reduce(function (p, tg) {
                    return p.then(function () {
                        var x = o[tg.id] = { n: 0, first: null, last: null, rn: 0, rfirst: null, rlast: null };
                        var tx = ro(['samples', 'rollups']), s = tx.objectStore('samples'), rr = tx.objectStore('rollups'), all = rng(tg.id, 0, MAXT);
                        idbReq(s.count(all)).then(function (n) { x.n = n; });
                        idbReq(s.getAll(all, 1)).then(function (a) { if (a.length) x.first = a[0][0]; });
                        var c = s.openCursor(all, 'prev');
                        c.onsuccess = function () { if (c.result) { x.last = c.result.value[0]; x.lastV = c.result.value[1]; x.lastQ = c.result.value[2]; } };
                        idbReq(rr.count(all)).then(function (n) { x.rn = n; });
                        idbReq(rr.getAll(all, 1)).then(function (a) { if (a.length) x.rfirst = a[0][0]; });
                        var c2 = rr.openCursor(all, 'prev');
                        c2.onsuccess = function () { if (c2.result) x.rlast = c2.result.value[0]; };
                        return idbDone(tx);
                    });
                }, Promise.resolve()).then(function () { return o; });
            });
        },
        putRollups: function (id, parts) {
            if (!parts.length) return Promise.resolve(0);
            var tx = rw('rollups'), st = tx.objectStore('rollups');
            parts.forEach(function (p) { st.put(rollToArr(p), [id, p.t]); });
            return idbDone(tx).then(function () { return parts.length; });
        },
        rollupWrite: function (id, parts, cut) {                       // one transaction: rollups in, raw rows out
            var tx = rw(['samples', 'rollups']), rs = tx.objectStore('rollups'), ss = tx.objectStore('samples'), r = rng(id, 0, cut - 1), n = 0;
            parts.forEach(function (p) { rs.put(rollToArr(p), [id, p.t]); });
            idbReq(ss.count(r)).then(function (c) { n = c; });
            ss.delete(r);
            return idbDone(tx).then(function () { return n; });
        },
        getRollups: function (id, from, to) {
            var out = [];
            return readChunks('rollups', id, from, to, function (arr) { arr.forEach(function (a) { out.push(arrToRoll(a)); }); }).then(function () { return out; });
        },
        countRollups: function (id, from, to) { return countIn('rollups', id, from, to); },
        deleteRollups: function (id, from, to) { return deleteIn('rollups', id, from, to); },
        totals: function () {
            var tx = ro(['samples', 'rollups', 'tags']), o = {};
            idbReq(tx.objectStore('samples').count()).then(function (n) { o.samples = n; });
            idbReq(tx.objectStore('rollups').count()).then(function (n) { o.rollups = n; });
            idbReq(tx.objectStore('tags').count()).then(function (n) { o.tags = n; });
            return idbDone(tx).then(function () { return o; });
        },
        clear: function () {
            var tx = rw(['samples', 'rollups', 'tags']);
            tx.objectStore('samples').clear(); tx.objectStore('rollups').clear(); tx.objectStore('tags').clear();
            return idbDone(tx).then(function () { return true; });
        },
        vacuum: function () { return Promise.resolve(true); },
        close: function () { try { if (db) db.close(); } catch (e) {} db = null; return Promise.resolve(true); }
    };
    return S;
}

// Volatile store (no IndexedDB, or explicitly chosen). Sorted parallel arrays per tag.
function MemStore() {
    var tags = [], S = {}, R = {};
    function lb(a, x) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
    function ub(a, x) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >>> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
    function ser(map, id) { return map[id] || (map[id] = { t: [], x: [] }); }
    function span(map, id, from, to) { var s = map[id]; if (!s) return [0, 0, null]; return [lb(s.t, from), ub(s.t, to), s]; }
    function del(map, id, from, to) { var p = span(map, id, from, to); if (!p[2] || p[1] <= p[0]) return 0; p[2].t.splice(p[0], p[1] - p[0]); p[2].x.splice(p[0], p[1] - p[0]); return p[1] - p[0]; }
    var M = {
        kind: 'memory',
        init: function () { return M.info(); },
        info: function () { return { version: 'memory', bytes: null }; },
        getTags: function () { return tags.map(function (t) { return Object.assign({}, t); }); },
        putTags: function (list) {
            list.forEach(function (x) {
                var name = String(x.name), old = null;
                for (var i = 0; i < tags.length; i++) if (tags[i].name === name) old = tags[i];
                if (old) {
                    if (x.device != null) old.device = String(x.device);
                    if (x.unit != null) old.unit = String(x.unit);
                    if (x.descr != null) old.descr = String(x.descr);
                } else tags.push({ id: tags.length ? tags[tags.length - 1].id + 1 : 1, name: name, device: x.device != null ? String(x.device) : null,
                    unit: x.unit != null ? String(x.unit) : null, descr: x.descr != null ? String(x.descr) : null, created: x.created != null ? +x.created : Date.now() });
            });
            return M.getTags();
        },
        putSamples: function (ids, ts, vs, qs, mode) {
            var r = { inserted: 0, updated: 0, skipped: 0, byTag: {} };
            for (var i = 0; i < ids.length; i++) {
                var s = ser(S, ids[i]), t = ts[i], val = [(vs[i] === undefined ? null : vs[i]), qs[i]], n = s.t.length;
                if (!n || s.t[n - 1] < t) { s.t.push(t); s.x.push(val); }
                else {
                    var k = lb(s.t, t);
                    if (s.t[k] === t) { if (mode === 'replace') { s.x[k] = val; r.updated++; } else r.skipped++; continue; }
                    s.t.splice(k, 0, t); s.x.splice(k, 0, val);
                }
                r.inserted++; r.byTag[ids[i]] = (r.byTag[ids[i]] || 0) + 1;
            }
            return r;
        },
        getSamples: function (id, from, to, limit, desc) {
            var p = span(S, id, from, to), o = { t: [], v: [], q: [] };
            if (!p[2]) return o;
            var a = p[0], b = p[1];
            if (limit > 0 && b - a > limit) { if (desc) a = b - limit; else b = a + limit; }
            for (var i = a; i < b; i++) { o.t.push(p[2].t[i]); o.v.push(p[2].x[i][0]); o.q.push(p[2].x[i][1]); }
            if (desc) { o.t.reverse(); o.v.reverse(); o.q.reverse(); }
            return o;
        },
        countSamples: function (id, from, to) { var p = span(S, id, from, to); return Math.max(0, p[1] - p[0]); },
        deleteSamples: function (id, from, to) { return del(S, id, from, to); },
        aggSamples: function (id, from, to, b) {
            var p = span(S, id, from, to), a = new Agg(Math.max(1, Math.round(b)));
            if (p[2]) for (var i = p[0]; i < p[1]; i++) a.push(p[2].t[i], p[2].x[i][0], p[2].x[i][1]);
            return a.result();
        },
        statsAll: function () {
            var o = {};
            tags.forEach(function (tg) {
                var s = S[tg.id], r = R[tg.id], x = o[tg.id] = { n: 0, first: null, last: null, rn: 0, rfirst: null, rlast: null };
                if (s && s.t.length) { x.n = s.t.length; x.first = s.t[0]; x.last = s.t[s.t.length - 1]; x.lastV = s.x[s.x.length - 1][0]; x.lastQ = s.x[s.x.length - 1][1]; }
                if (r && r.t.length) { x.rn = r.t.length; x.rfirst = r.t[0]; x.rlast = r.t[r.t.length - 1]; }
            });
            return o;
        },
        putRollups: function (id, parts) {
            var s = ser(R, id);
            parts.forEach(function (p) {
                var k = lb(s.t, p.t), a = rollToArr(p);
                if (s.t[k] === p.t) s.x[k] = a; else { s.t.splice(k, 0, p.t); s.x.splice(k, 0, a); }
            });
            return parts.length;
        },
        rollupWrite: function (id, parts, cut) { M.putRollups(id, parts); return del(S, id, 0, cut - 1); },
        getRollups: function (id, from, to) {
            var p = span(R, id, from, to), out = [];
            if (p[2]) for (var i = p[0]; i < p[1]; i++) out.push(arrToRoll(p[2].x[i]));
            return out;
        },
        countRollups: function (id, from, to) { var p = span(R, id, from, to); return Math.max(0, p[1] - p[0]); },
        deleteRollups: function (id, from, to) { return del(R, id, from, to); },
        totals: function () {
            var n = 0, nr = 0, k;
            for (k in S) n += S[k].t.length;
            for (k in R) nr += R[k].t.length;
            return { samples: n, rollups: nr, tags: tags.length };
        },
        clear: function () { tags = []; S = {}; R = {}; return true; },
        vacuum: function () { return true; },
        close: function () { return true; }
    };
    return M;
}

// ─── §5 storage Worker (official SQLite WASM on OPFS) ────────────────
// Runs inside a classic Worker built from a Blob. The verified sqlite3.mjs text is
// evaluated with Function after two exact rewrites (checked, else the load fails):
// every `import.meta.url` → a base URL argument, and the final `export {…}` → return.
// That keeps the SHA-384-checked bytes as the code that runs, and avoids module
// Workers and blob-URL module imports (not reliable in every WebView).
function histWorkerMain(S) {
    var store = null, sqlite3 = null, db = null, meta = null;
    var EXPORT = 'export { sqlite3InitModule as default, sqlite3Worker1Promiser$1 as sqlite3Worker1Promiser };';
    function probe() {
        var nav = S.navigator, FH = S.FileSystemFileHandle;
        var ok = !!(nav && nav.storage && typeof nav.storage.getDirectory === 'function' && FH && FH.prototype &&
            typeof FH.prototype.createSyncAccessHandle === 'function');
        return { opfs: ok };
    }
    function factoryFrom(js, base) {
        if (js.split('import.meta.url').length - 1 !== 4 || js.lastIndexOf(EXPORT) < 0) throw new Error('unexpected sqlite3.mjs layout (version mismatch)');
        var body = js.split('import.meta.url').join('__wtsBase').replace(EXPORT, 'return sqlite3InitModule;');
        return (new Function('__wtsBase', '"use strict";\n' + body))(base);
    }
    function open(m) {
        var quiet = function () {};
        S.sqlite3ApiConfig = { debug: quiet, log: quiet, warn: quiet, error: function () { try { console.error.apply(console, arguments); } catch (e) {} },
            disable: { vfs: { opfs: true, 'opfs-vfs': true, 'opfs-wl': true, kvvfs: true } } };
        var init = factoryFrom(m.js, m.base);
        return init({ wasmBinary: new Uint8Array(m.wasm), locateFile: function (p) { return p; }, print: quiet, printErr: quiet }).then(function (s3) {
            sqlite3 = s3;
            if (m.mode === 'memory') { db = new sqlite3.oo1.DB(':memory:', 'c'); return 'memory'; }
            return sqlite3.installOpfsSAHPoolVfs({ name: m.vfs, directory: m.dir, initialCapacity: 6 }).then(function (pool) {
                db = new pool.OpfsSAHPoolDb(m.file);
                return 'opfs-sahpool';
            });
        }).then(function (vfs) {
            store = HistSqlStore(histWasmAdapter(sqlite3, db));
            var info = store.init();
            meta = { version: sqlite3.version.libVersion, vfs: vfs, info: info };
            return meta;
        });
    }
    S.onmessage = function (ev) {
        var m = (ev && ev.data) || {}, p;
        try {
            if (m.op === 'probe') p = probe();
            else if (m.op === 'open') p = open(m);
            else if (m.op === 'call') {
                if (!store || typeof store[m.method] !== 'function') throw new Error('storage worker: no method ' + m.method);
                p = store[m.method].apply(store, m.args || []);
            } else if (m.op === 'close') { if (db) db.close(); db = null; store = null; p = true; }
            else throw new Error('storage worker: bad op ' + m.op);
        } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function (r) {
            var tr = [];
            if (r && typeof r.byteLength === 'number' && r.buffer && r.byteLength === r.buffer.byteLength) tr.push(r.buffer);   // exported file (a copy)
            S.postMessage({ id: m.id, ok: true, result: r }, tr);
        }, function (e) { S.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) }); });
    };
}
function workerSource() {
    return '"use strict";\n/* H2Oil Well Testing Suite — historian storage worker */\n' +
        'var HistSqlStore = ' + HistSqlStore.toString() + ';\n' +
        'var histWasmAdapter = ' + histWasmAdapter.toString() + ';\n' +
        '(' + histWorkerMain.toString() + ')(self);\n';
}
var STORE_METHODS = ['info', 'getTags', 'putTags', 'putSamples', 'getSamples', 'countSamples', 'deleteSamples', 'aggSamples', 'statsAll',
    'putRollups', 'rollupWrite', 'getRollups', 'countRollups', 'deleteRollups', 'totals', 'clear', 'vacuum', 'exportBytes'];
// Main-thread proxy: one Promise per request, matched by id.
function WorkerStore(w) {
    var seq = 0, pend = {}, dead = null;
    function failAll(e) { dead = e; Object.keys(pend).forEach(function (k) { var p = pend[k]; delete pend[k]; if (p.timer) clearTimeout(p.timer); p.rej(e); }); }
    w.onmessage = function (ev) {
        var m = ev && ev.data, p = m && pend[m.id];
        if (!p) return;
        delete pend[m.id];
        if (p.timer) clearTimeout(p.timer);
        if (m.ok) p.res(m.result); else p.rej(new Error(m.error));
    };
    w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); failAll(new Error('storage worker error: ' + ((e && e.message) || 'unknown'))); };
    function send(msg, transfer, timeoutMs) {
        if (dead) return Promise.reject(dead);
        return new Promise(function (res, rej) {
            msg.id = ++seq;
            var p = pend[msg.id] = { res: res, rej: rej, timer: null };
            if (timeoutMs) p.timer = setTimeout(function () { if (pend[msg.id]) { delete pend[msg.id]; rej(new Error('storage worker did not answer "' + msg.op + '" in ' + (timeoutMs / 1000) + ' s')); } }, timeoutMs);
            try { w.postMessage(msg, transfer || []); } catch (e) { delete pend[msg.id]; if (p.timer) clearTimeout(p.timer); rej(e); }
        });
    }
    var api = { kind: 'opfs', _send: send, isDead: function () { return !!dead; },
        terminate: function () { failAll(new Error('storage worker closed')); try { w.terminate(); } catch (e) {} } };
    STORE_METHODS.forEach(function (name) {
        api[name] = function () { return send({ op: 'call', method: name, args: Array.prototype.slice.call(arguments) }); };
    });
    api.close = function () { return send({ op: 'close' }).then(function () { api.terminate(); return true; }, function () { api.terminate(); return true; }); };
    return api;
}

// ─── §6 library loader (lazy, integrity-checked) ─────────────────────
function noop() {}
function isNativeShell() {
    try {
        if (G.location && G.location.protocol === 'capacitor:') return true;
        var C = G.Capacitor;
        return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
    } catch (e) { return false; }
}
function absUrl(u) { try { return new URL(u, G.location && G.location.href).href; } catch (e) { return u; } }
function asBuf(x) {
    if (x && typeof x.byteLength === 'number' && x.buffer && typeof x.byteOffset === 'number') return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
    return x;
}
function toU8(x) { return (x && x.buffer && typeof x.byteOffset === 'number') ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x); }
function utf8(buf) { return new TextDecoder('utf-8').decode(toU8(buf)); }
function b64(ab) {
    var b = new Uint8Array(ab), s = '', CH = 0x8000;
    for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return G.btoa(s);
}
function fetchBytes(url) {
    if (typeof T.fetchBytes === 'function') return Promise.resolve().then(function () { return T.fetchBytes(url); });
    if (typeof G.fetch !== 'function') return Promise.reject(new Error('fetch is not available'));
    var ac = typeof G.AbortController === 'function' ? new G.AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, 30000);
    var cross = /^https?:/i.test(url) && (!G.location || url.indexOf(G.location.origin + '/') !== 0);
    var init = cross ? { mode: 'cors', credentials: 'omit' } : { credentials: 'same-origin' };
    if (ac) init.signal = ac.signal;
    return G.fetch(url, init).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (b) { clearTimeout(timer); return b; }, function (e) { clearTimeout(timer); throw e; });
}
// Sources in order: a local copy (iOS app bundle, or window.WTS_HIST_LIB_BASE for a self-hosted
// intranet copy), then the pinned CDN URLs. CDN bytes are used only after their SHA-384 matches;
// without WebCrypto (plain http) only the local copy is accepted, unverified — like the 3D loader.
function libSources(name) {
    var src = [], base = G.WTS_HIST_LIB_BASE != null ? String(G.WTS_HIST_LIB_BASE) : (isNativeShell() ? '' : null);
    if (base !== null) src.push({ url: absUrl(base + name), local: true });
    LIBS[name].urls.forEach(function (u) { src.push({ url: u, local: false }); });
    return src;
}
function fetchVerified(name) {
    var want = HIST_SHA384[name], subtle = (G.crypto && G.crypto.subtle && typeof G.crypto.subtle.digest === 'function') ? G.crypto.subtle : null;
    var srcs = libSources(name), tried = [], i = 0;
    function next() {
        if (i >= srcs.length) {
            var e = new Error(name + ' could not be loaded — ' + tried.join('; '));
            e.code = tried.some(function (x) { return /SHA-384/.test(x); }) ? 'integrity' : 'offline';
            return Promise.reject(e);
        }
        var s = srcs[i++];
        if (!s.local && !subtle) { tried.push(s.url + ' (skipped: no WebCrypto to check its SHA-384)'); return next(); }
        return fetchBytes(s.url).then(function (buf) {
            buf = asBuf(buf);
            if (!subtle) return { buf: buf, url: s.url, verified: false, local: true };
            return subtle.digest('SHA-384', buf).then(function (d) {
                if (b64(d) !== want) { tried.push(s.url + ' (SHA-384 mismatch — not used)'); return next(); }
                return { buf: buf, url: s.url, verified: true, local: s.local };
            });
        }, function (e) { tried.push(s.url + ' (' + errMsg(e) + ')'); return next(); });
    }
    return next();
}
var _sqljsP = null;
function loadSqlJs() {
    if (_sqljsP) return _sqljsP;
    _sqljsP = Promise.all([fetchVerified('sql-wasm.js'), fetchVerified('sql-wasm.wasm')]).then(function (r) {
        var init = (new Function(utf8(r[0].buf) + '\n;return initSqlJs;'))();
        return init({ wasmBinary: new Uint8Array(r[1].buf), locateFile: function (p) { return p; } }).then(function (SQL) {
            var d = new SQL.Database(), ver = String(d.exec('SELECT sqlite_version()')[0].values[0][0]);
            d.close();
            E.lib.sqljs = { name: 'sql.js 1.14.2', version: ver, url: r[0].url, verified: !!(r[0].verified && r[1].verified) };
            return SQL;
        });
    });
    _sqljsP.catch(function () { _sqljsP = null; });
    return _sqljsP;
}

// ─── §7 engine ───────────────────────────────────────────────────────
var E = {
    store: null, engine: null, home: null, spoolFor: null, reasons: [], notes: [], initP: null, info: null, lib: {},
    chain: Promise.resolve(), buf: [], timer: null, timerMs: -1,
    byName: {}, byId: {}, stat: {}, live: {}, tot: { samples: 0, rollups: 0, tags: 0 },
    lastFlush: 0, lastFlushMs: 0, flushes: 0, written: 0, dropped: 0, rejected: 0, errors: 0, lastError: '',
    lastRetention: 0, lastRetentionResult: null, dirty: false, persistTimer: null, lastPersist: 0
};
function lock(fn) { var p = E.chain.then(fn, fn); E.chain = p.then(noop, noop); return p; }
function perfNow() { try { return G.performance && G.performance.now ? G.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
function isSqlEngine() { return E.engine === 'opfs' || E.engine === 'sqljs'; }
function floorTo(t, b) { return t - (((t % b) + b) % b); }
function firstDef() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]; return null; }

function getSettings() {
    var s = lsJSON(LS_SETTINGS) || {};
    var ci = function (x, d, lo, hi) { x = Math.round(numOr(x, d)); return Math.min(hi, Math.max(lo, x)); };
    return {
        days: ci(s.days, DEFAULTS.days, 0, 36500), maxRows: ci(s.maxRows, DEFAULTS.maxRows, 0, 1e10),
        downsampleAfterDays: ci(s.downsampleAfterDays, DEFAULTS.downsampleAfterDays, 0, 36500),
        engine: ENGINES.indexOf(s.engine) >= 0 ? s.engine : 'auto'
    };
}
function saveSettings(s) { lsSet(LS_SETTINGS, JSON.stringify({ days: s.days, maxRows: s.maxRows, downsampleAfterDays: s.downsampleAfterDays, engine: s.engine })); }
function effCap(engine) {
    var s = getSettings(), c = ENGINE_CAPS[engine || E.engine] || 0, u = s.maxRows || 0;
    if (!c) return u || Infinity;
    return u ? Math.min(c, u) : c;
}
function hasStore(d, n) { return !!d.objectStoreNames && (typeof d.objectStoreNames.contains === 'function' ? d.objectStoreNames.contains(n) : Array.prototype.indexOf.call(d.objectStoreNames, n) >= 0); }

// Engine openers — each resolves to an initialised async store.
function openOpfs() {
    if (typeof G.Worker !== 'function') return Promise.reject(new Error('Web Workers are not available'));
    if (!G.Blob || !G.URL || typeof G.URL.createObjectURL !== 'function') return Promise.reject(new Error('Blob URLs are not available'));
    var w;
    try { w = new G.Worker(G.URL.createObjectURL(new G.Blob([workerSource()], { type: 'text/javascript' }))); }
    catch (e) { return Promise.reject(new Error('the storage worker could not start (' + errMsg(e) + ')')); }
    var ws = WorkerStore(w);
    return ws._send({ op: 'probe' }, null, 10000).then(function (pr) {
        if (!(pr && pr.opfs) && !T.workerMemory) throw new Error('OPFS sync access handles are not available in workers');
        return Promise.all([fetchVerified('sqlite3.mjs'), fetchVerified('sqlite3.wasm')]);
    }).then(function (r) {
        var base = /^https?:|^capacitor:/i.test(r[0].url) ? r[0].url : absUrl('sqlite3.mjs');
        return ws._send({ op: 'open', js: utf8(r[0].buf), wasm: r[1].buf, base: base, mode: T.workerMemory ? 'memory' : 'opfs',
            vfs: OPFS_VFS, dir: OPFS_DIR, file: OPFS_FILE }, [r[1].buf], 60000).then(function (m) {
            E.lib.sqlite = { name: 'SQLite WASM (official build) 3.53.4', version: m.version, vfs: m.vfs, url: r[0].url, verified: !!(r[0].verified && r[1].verified) };
            return ws;
        });
    }).catch(function (e) {
        ws.terminate();
        var m = errMsg(e);
        if (/NoModificationAllowed|locked|Access Handles cannot be created/i.test(m)) m = 'the SQLite files are in use by another tab of this app (' + m + ')';
        throw new Error(m);
    });
}
function openSqlJs() {
    var idb = G.indexedDB;
    if (!idb) return Promise.reject(new Error('IndexedDB is not available (needed to keep the SQLite file)'));
    var SQL, snapDb, release = null;
    return holdLock('wts-historian-sqljs').then(function (rel) {
        if (!rel) throw new Error('the SQLite file is open in another tab of this app');
        release = rel;
        return loadSqlJs();
    }).then(function (S) {
        SQL = S;
        return idbOpen(idb, SNAP_DB, function (d) { if (!hasStore(d, SNAP_STORE)) d.createObjectStore(SNAP_STORE); });
    }).then(function (d) {
        snapDb = d;
        return idbReq(snapDb.transaction(SNAP_STORE, 'readonly').objectStore(SNAP_STORE).get(SNAP_KEY));
    }).then(function (bytes) {
        var db = null;
        if (bytes) {
            try { db = new SQL.Database(toU8(bytes)); db.exec('SELECT count(*) FROM sqlite_master'); }
            catch (e) {
                // Keep the unreadable file aside (never silently discarded) and start a new one.
                try { if (db) db.close(); } catch (e2) {}
                db = null;
                try { var tx0 = snapDb.transaction(SNAP_STORE, 'readwrite'); tx0.objectStore(SNAP_STORE).put(bytes, SNAP_KEY + '.unreadable-' + Date.now()); } catch (e3) {}
                E.notes.push('The saved SQLite file could not be opened (' + errMsg(e) + '); it was kept aside and a new file started.');
            }
        }
        if (!db) db = new SQL.Database();
        var sync = HistSqlStore(histSqlJsAdapter(db));
        sync.init();
        return asyncStore(sync, 'sqljs', {
            persist: function () {
                var b = db.export(), tx = snapDb.transaction(SNAP_STORE, 'readwrite');
                tx.objectStore(SNAP_STORE).put(b, SNAP_KEY);
                return idbDone(tx);
            },
            close: function () { try { db.close(); } catch (e) {} try { snapDb.close(); } catch (e) {} if (release) release(); release = null; return Promise.resolve(true); }
        });
    }).catch(function (e) { if (release) release(); throw e; });
}
function openIdb() {
    if (!G.indexedDB || !G.IDBKeyRange) return Promise.reject(new Error('IndexedDB is not available'));
    var st = IdbStore(G.indexedDB, G.IDBKeyRange);
    return st.init().then(function () { return st; });
}
function openMemory() { var st = asyncStore(MemStore(), 'memory'); return st.init().then(function () { return st; }); }
var OPEN = { opfs: openOpfs, sqljs: openSqlJs, idb: openIdb, memory: openMemory };

function engineOrder() {
    var s = getSettings(), home = lsGet(LS_HOME);
    var first = s.engine !== 'auto' ? s.engine : (ENGINES.indexOf(home) >= 0 ? home : null);
    if (first === 'memory') return ['memory'];
    if (first) return uniq([first, 'idb', 'memory']);      // home unavailable → spool to IndexedDB, merged later
    return ENGINES.slice();
}
function openBest() {
    var order = engineOrder(), i = 0;
    E.reasons = [];
    function next() {
        if (i >= order.length) return Promise.reject(new Error('no storage engine available: ' + E.reasons.join('; ')));
        var name = order[i++];
        return OPEN[name]().then(function (st) { return { name: name, store: st }; },
            function (e) { E.reasons.push(ENGINE_LABEL[name] + ' — ' + errMsg(e)); return next(); });
    }
    return next();
}
function indexTag(t) { E.byName[t.name] = t; E.byId[t.id] = t; }
function reloadMeta() {
    return E.store.getTags().then(function (tags) {
        E.byName = {}; E.byId = {};
        tags.forEach(indexTag);
        return refreshStats();
    }).then(function () { return E.store.info().then(function (i) { E.info = i; }, noop); });
}
function refreshStats() {
    return E.store.statsAll().then(function (s) { E.stat = s || {}; return E.store.totals(); }).then(function (t) { E.tot = t; });
}
function afterOpen(r) {
    E.store = r.store; E.engine = r.name;
    var home = lsGet(LS_HOME);
    if (!home && r.name !== 'memory') { lsSet(LS_HOME, r.name); home = r.name; }
    E.home = home || r.name;
    E.spoolFor = (home && home !== r.name && ENGINES.indexOf(home) >= 0 && r.name !== 'memory') ? home : null;
    if (E.spoolFor) lsSet(LS_SPOOL, '1');
    return reloadMeta().then(function () {
        if (E.spoolFor || r.name === 'idb' || r.name === 'memory' || lsGet(LS_SPOOL) !== '1') return null;
        return drainSpool().catch(function (e) { E.notes.push('Merging the IndexedDB spool failed: ' + errMsg(e)); });
    }).then(function () { publishState(); return E.store; });
}
function ensureStore() {
    if (E.store) return Promise.resolve(E.store);
    if (!E.initP) E.initP = openBest().then(afterOpen).then(function (s) { E.initP = null; return s; }, function (e) { E.initP = null; throw e; });
    return E.initP;
}
// Samples written to IndexedDB while the home engine was unavailable → home. Only what was
// copied is deleted from the spool (per tag, up to the latest copied time), so samples another
// tab is still spooling meanwhile are kept for the next merge.
function drainSpool() {
    if (!G.indexedDB || !G.IDBKeyRange) return Promise.resolve();
    var sp = IdbStore(G.indexedDB, G.IDBKeyRange), left = 0;
    return sp.init().then(function () { return sp.totals(); }).then(function (t) {
        if (!t.samples && !t.rollups) return null;
        return copyStore(sp, E.store, 'ignore').then(function (r) {
            E.notes.push('Merged ' + fmtCount(r.samples) + ' samples recorded while the ' + ENGINE_LABEL[E.engine] + ' store was unavailable.');
            return Object.keys(r.upTo).reduce(function (p, id) {
                return p.then(function () { return sp.deleteSamples(+id, 0, r.upTo[id]); }).then(function () { return sp.deleteRollups(+id, 0, r.upTo[id]); });
            }, Promise.resolve());
        }).then(function () { return sp.totals(); }).then(function (t2) { left = t2.samples + t2.rollups; markDirty(); return reloadMeta(); });
    }).then(function () { lsSet(LS_SPOOL, left ? '1' : '0'); return sp.close(); });
}
// Copy every tag, sample and rollup from one store into another (dup: 'ignore' | 'replace').
function copyStore(src, dst, dup) {
    var res = { samples: 0, rollups: 0, tags: 0, upTo: {} };        // upTo: source tag id → latest time copied
    return src.getTags().then(function (tags) {
        if (!tags.length) return res;
        res.tags = tags.length;
        return dst.putTags(tags.map(function (t) { return { name: t.name, device: t.device, unit: t.unit, descr: t.descr, created: t.created }; })).then(function (dt) {
            var map = {};
            dt.forEach(function (t) { map[t.name] = t.id; });
            return tags.reduce(function (p, tg) {
                return p.then(function () {
                    var did = map[tg.name], lo = 0;
                    function more() {
                        return src.getSamples(tg.id, lo, MAXT, CHUNK).then(function (c) {
                            if (!c.t.length) return null;
                            res.upTo[tg.id] = Math.max(res.upTo[tg.id] || 0, c.t[c.t.length - 1]);
                            return dst.putSamples(repeat(did, c.t.length), c.t, c.v, c.q, dup).then(function (r) {
                                res.samples += r.inserted + r.updated;
                                if (c.t.length < CHUNK) return null;
                                lo = c.t[c.t.length - 1] + 1;
                                return more();
                            });
                        });
                    }
                    return more().then(function () { return src.getRollups(tg.id, 0, MAXT); }).then(function (rs) {
                        if (!rs.length) return null;
                        res.upTo[tg.id] = Math.max(res.upTo[tg.id] || 0, rs[rs.length - 1].t);
                        return dst.putRollups(did, rs).then(function (n) { res.rollups += n; });
                    });
                });
            }, Promise.resolve()).then(function () { return res; });
        });
    });
}

// sql.js keeps the file in memory: save it to IndexedDB 1–8 s after a write, and at once
// when the page is hidden. Every store call is atomic (the rollup swap is one transaction), so a
// snapshot taken between two calls is always consistent; the urgent path skips the queue.
function markDirty() {
    if (E.engine !== 'sqljs' || !E.store || !E.store.persist) return;
    E.dirty = true;
    // A small file (< 100k rows ≈ 2.5 MB) is cheap to re-write: save within 1 s; larger ones every 8 s.
    if (E.persistTimer === null) E.persistTimer = setTimeout(function () { E.persistTimer = null; persistNow(); }, E.tot.samples < 100000 ? 1000 : 8000);
}
function persistNow(urgent) {
    if (E.persistTimer !== null) { clearTimeout(E.persistTimer); E.persistTimer = null; }
    var run = function () {
        if (!E.dirty || !E.store || !E.store.persist) return Promise.resolve(false);
        E.dirty = false;
        return E.store.persist().then(function () { E.lastPersist = Date.now(); return true; },
            function (e) { E.dirty = true; E.lastError = 'Saving the SQLite file failed: ' + errMsg(e); return false; });
    };
    return urgent ? run() : lock(run);
}
// One tab at a time may own the sql.js file (two in-memory copies would overwrite each
// other's snapshot). Web Locks: resolves to a release function, or null when another tab holds it.
function holdLock(name) {
    var L = G.navigator && G.navigator.locks;
    if (!L || typeof L.request !== 'function') return Promise.resolve(noop);   // no Web Locks (older browsers): single-tab use
    return new Promise(function (res) {
        var p;
        try {
            p = L.request(name, { ifAvailable: true }, function (lk) {
                if (!lk) { res(null); return null; }
                return new Promise(function (release) { res(release); });       // held until released (no timer involved)
            });
        } catch (e) { res(noop); return; }
        if (p && typeof p.catch === 'function') p.catch(function () { res(noop); });
    });
}
function emit(detail) {
    if (!hasDoc() || typeof document.dispatchEvent !== 'function' || typeof G.CustomEvent !== 'function') return;
    detail.engine = E.engine;
    try { document.dispatchEvent(new G.CustomEvent('wts:historian-updated', { detail: detail })); } catch (e) { /* listeners' errors stay theirs */ }
}
function publishState() {
    try {
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.historian = { engine: E.engine, label: E.engine ? ENGINE_LABEL[E.engine] : null, samples: E.tot.samples, rollups: E.tot.rollups,
            tags: Object.keys(E.byId).length, buffer: E.buf.length, lastFlush: E.lastFlush || null, lastError: E.lastError || null };
    } catch (e) { /* read-only WTS_state */ }
}

// Modbus tag metadata (the Modbus page owns polling; we only read its configuration).
function modbusTagMap() {
    var M = G.WTS_modbus, out = {}, list;
    if (!M || typeof M.getTags !== 'function') return out;
    try { list = M.getTags(); } catch (e) { return out; }
    if (list && !Array.isArray(list) && typeof list === 'object') list = Object.keys(list).map(function (k) { return Object.assign({ tag: k }, list[k]); });
    (Array.isArray(list) ? list : []).forEach(function (x) {
        if (!x || typeof x !== 'object') return;
        var name = cleanStr(firstDef(x.tag, x.name, x.id), 128);
        if (!name) return;
        var poll = +firstDef(x.pollMs, x.intervalMs, x.pollRateMs, x.rateMs, x.pollIntervalMs);
        out[name] = { device: cleanStr(firstDef(x.device, x.deviceName)), unit: cleanStr(firstDef(x.unit, x.units, x.engUnit), 32),
            desc: cleanStr(firstDef(x.desc, x.description), 200), pollMs: isNum(poll) && poll > 0 ? poll : null,
            enabled: (x.enabled === false || x.log === false || x.logged === false || x.historian === false) ? false : true };
    });
    return out;
}

// ── record / flush ──
function record(samples) {
    if (!samples) return 0;
    var list = Array.isArray(samples) ? samples : (Array.isArray(samples.samples) ? samples.samples : [samples]);
    var tNow = Date.now(), n = 0;
    for (var i = 0; i < list.length; i++) {
        var s = normSample(list[i], tNow);
        if (!s) { E.rejected++; continue; }
        E.buf.push(s); n++;
        var L = E.live[s.tag];
        if (!L || s.t >= L.t) E.live[s.tag] = { t: s.t, v: s.v, q: s.q, raw: s.raw, device: s.device, unit: s.unit };
    }
    if (E.buf.length > BUFFER_CAP) { var d = E.buf.length - BUFFER_CAP; E.buf.splice(0, d); E.dropped += d; }
    if (n) scheduleFlush();
    return n;
}
function scheduleFlush() {
    var ms = E.buf.length >= FLUSH_MAX ? 0 : FLUSH_MS;
    if (E.timer !== null) {
        if (ms === 0 && E.timerMs !== 0) { clearTimeout(E.timer); E.timer = null; } else return;
    }
    E.timerMs = ms;
    E.timer = setTimeout(function () { E.timer = null; flush().catch(noop); }, ms);
}
function flush() {
    if (E.timer !== null) { clearTimeout(E.timer); E.timer = null; }
    return lock(doFlush);
}
function doFlush() {
    if (!E.buf.length) return Promise.resolve({ count: 0, inserted: 0, updated: 0 });
    var batch = E.buf, t0 = perfNow(), want = {}, names;
    E.buf = [];
    return ensureStore().then(function () {
        var mb = modbusTagMap(), list = [];
        batch.forEach(function (s) {
            var w = want[s.tag] || (want[s.tag] = { name: s.tag, device: null, unit: null, descr: null });
            if (s.device) w.device = s.device;
            if (s.unit) w.unit = s.unit;
            if (s.desc) w.descr = s.desc;
        });
        names = Object.keys(want);
        names.forEach(function (name) {
            var w = want[name], cur = E.byName[name], m = mb[name];
            if (m) { if (!w.unit) w.unit = m.unit; if (!w.device) w.device = m.device; if (m.desc) w.descr = m.desc; }
            if (!cur || (w.unit && w.unit !== cur.unit) || (w.device && w.device !== cur.device) || (w.descr && w.descr !== cur.descr)) list.push(w);
        });
        return list.length ? E.store.putTags(list).then(function (all) { all.forEach(indexTag); E.tot.tags = all.length; }) : null;
    }).then(function () {
        batch.sort(function (a, b) { return a.t - b.t; });                    // stable: a later record of the same (tag, t) wins
        var ids = [], ts = [], vs = [], qs = [];
        batch.forEach(function (s) { ids.push(E.byName[s.tag].id); ts.push(s.t); vs.push(s.v); qs.push(s.q); });
        return E.store.putSamples(ids, ts, vs, qs, 'replace');
    }).then(function (r) {
        batch.forEach(function (s) {
            var id = E.byName[s.tag].id, x = E.stat[id] || (E.stat[id] = { n: 0, first: null, last: null, rn: 0, rfirst: null, rlast: null });
            if (x.first === null || s.t < x.first) x.first = s.t;
            if (x.last === null || s.t >= x.last) { x.last = s.t; x.lastV = s.v; x.lastQ = s.q; }
        });
        Object.keys(r.byTag || {}).forEach(function (id) { if (E.stat[id]) E.stat[id].n += r.byTag[id]; });
        E.tot.samples += r.inserted;
        E.written += r.inserted + r.updated; E.flushes++; E.lastFlush = Date.now(); E.lastFlushMs = perfNow() - t0; E.lastError = '';
        if (E.spoolFor) lsSet(LS_SPOOL, '1');
        markDirty();
        var due = Date.now() - E.lastRetention >= RETENTION_EVERY_MS || E.tot.samples > effCap();
        return (due ? runRetention() : Promise.resolve(null)).then(function () {
            publishState();
            emit({ reason: 'flush', count: batch.length, inserted: r.inserted, updated: r.updated, tags: names, from: batch[0].t, to: batch[batch.length - 1].t });
            return { count: batch.length, inserted: r.inserted, updated: r.updated };
        });
    }).catch(function (e) {
        // Keep the samples (bounded) for the next attempt; the next record() schedules it.
        E.buf = batch.concat(E.buf);
        if (E.buf.length > BUFFER_CAP) { var d = E.buf.length - BUFFER_CAP; E.buf.splice(0, d); E.dropped += d; }
        E.errors++; E.lastError = errMsg(e);
        // A crashed storage worker is reopened by the next write (never in a loop: only record() schedules it).
        if (E.store && typeof E.store.isDead === 'function' && E.store.isDead()) { E.store = null; E.initP = null; }
        publishState();
        throw e;
    });
}

// ── retention / downsampling (runs inside the lock) ──
function eachId(fn) {
    var ids = Object.keys(E.byId).map(Number);
    return ids.reduce(function (p, id) { return p.then(function () { return fn(id); }); }, Promise.resolve());
}
// Raw samples of one tag before `cut` (a minute boundary) → 60-s rollups (merged with any
// rollup already stored for the same minute), then the raw rows are removed.
function rollupBefore(id, cut, out) {
    return E.store.countSamples(id, 0, cut - 1).then(function (n) {
        if (!n) return 0;
        return E.store.aggSamples(id, 0, cut - 1, ROLLUP_MS).then(function (parts) {
            if (!parts.length) return parts;
            return E.store.getRollups(id, parts[0].t, parts[parts.length - 1].t).then(function (old) {
                if (old.length) parts = mergePartials(old.concat(parts), ROLLUP_MS);
                parts.forEach(function (p) { p.dt = ROLLUP_MS; });
                return parts;
            });
        }).then(function (parts) { out.rollups += parts.length; return E.store.rollupWrite(id, parts, cut); }).then(function () { return n; });
    });
}
function runRetention() {
    var s = getSettings(), now = Date.now(), out = { deleted: 0, deletedRollups: 0, rolledUp: 0, rollups: 0, capped: 0 };
    E.lastRetention = now;
    var p = Promise.resolve();
    if (s.days > 0) {
        var cut = now - s.days * DAY;
        p = p.then(function () {
            return eachId(function (id) {
                return E.store.deleteSamples(id, 0, cut - 1).then(function (n) { out.deleted += n; return E.store.deleteRollups(id, 0, cut - 1); })
                    .then(function (n) { out.deletedRollups += n; });
            });
        });
    }
    if (s.downsampleAfterDays > 0) {
        var cut2 = floorTo(now - s.downsampleAfterDays * DAY, ROLLUP_MS);
        p = p.then(function () { return eachId(function (id) { return rollupBefore(id, cut2, out).then(function (n) { out.rolledUp += n; }); }); });
    }
    var cap = effCap();
    if (isFinite(cap)) {
        // Row cap: move the cut forward in proportion to the excess (aiming 10 % below the cap)
        // and roll up (or, with downsampling off, delete) the oldest raw samples. ≤ 4 passes.
        var pass = 0;
        var capStep = function () {
            return E.store.totals().then(function (t) {
                if (t.samples <= cap || pass++ >= 4) return null;
                return E.store.statsAll().then(function (st) {
                    var lo = Infinity, hi = -Infinity;
                    Object.keys(st).forEach(function (k) { var x = st[k]; if (x.n > 0) { if (x.first < lo) lo = x.first; if (x.last > hi) hi = x.last; } });
                    if (!isFinite(lo)) return null;
                    var excess = t.samples - Math.floor(cap * 0.9);
                    var T = floorTo(lo + (hi - lo) * Math.min(1, excess / t.samples), ROLLUP_MS);
                    T = Math.max(T, floorTo(lo, ROLLUP_MS) + ROLLUP_MS);
                    return eachId(function (id) {
                        if (s.downsampleAfterDays > 0) return rollupBefore(id, T, out).then(function (n) { out.capped += n; });
                        return E.store.deleteSamples(id, 0, T - 1).then(function (n) { out.capped += n; });
                    }).then(capStep);
                });
            });
        };
        p = p.then(capStep);
    }
    return p.then(function () { return E.store.vacuum(); }).then(refreshStats).then(function () {
        E.lastRetentionResult = out;
        if (out.deleted || out.deletedRollups || out.rolledUp || out.capped) {
            markDirty();
            emit({ reason: 'retention', deleted: out.deleted, deletedRollups: out.deletedRollups, rolledUp: out.rolledUp, capped: out.capped });
        }
        return out;
    });
}

// ── query ──
var AGGS = ['raw', 'avg', 'min', 'max', 'last'];
function resolveTagNames(tags) {
    if (tags === undefined || tags === null) return Object.keys(E.byName).sort();
    var a = Array.isArray(tags) ? tags : [tags];
    return uniq(a.map(function (x) { return x && typeof x === 'object' ? String(firstDef(x.tag, x.name, '')) : String(x == null ? '' : x); }).filter(Boolean));
}
function timeArg(x, d) {
    if (x === undefined || x === null || x === '') return d;
    var n = isDateObj(x) ? x.getTime() : +x;
    return isFinite(n) ? Math.round(n) : d;
}
function seriesFor(tag, from, to, agg, o) {
    var meta = E.byName[tag];
    var base = { tag: tag, unit: meta ? meta.unit : null, device: meta ? meta.device : null, t: [], v: [], q: [] };
    if (!meta) { base.missing = true; return Promise.resolve(base); }
    var id = meta.id;
    if (agg === 'raw') {
        return Promise.all([E.store.getSamples(id, from, to), E.store.getRollups(id, from, to)]).then(function (r) {
            var raw = r[0], roll = r[1], t = raw.t, v = raw.v, q = raw.q, src = null;
            if (roll.length) {                                  // rolled-up minutes appear as their mean, flagged in .rollup
                var mt = [], mv = [], mq = [], ms = [], i = 0, j = 0;
                while (i < t.length || j < roll.length) {
                    if (j >= roll.length || (i < t.length && t[i] <= roll[j].t)) { mt.push(t[i]); mv.push(v[i]); mq.push(q[i]); ms.push(0); i++; }
                    else { var x = roll[j++]; mt.push(x.t); mv.push(x.avg); mq.push(x.q); ms.push(1); }
                }
                t = mt; v = mv; q = mq; src = ms;
            }
            base.count = raw.t.length + roll.length;
            var keep = o.maxPoints > 0 ? decimate(t, v, q, o.maxPoints) : null;
            if (keep) {
                base.t = keep.map(function (k) { return t[k]; }); base.v = keep.map(function (k) { return v[k]; }); base.q = keep.map(function (k) { return q[k]; });
                if (src) base.rollup = keep.map(function (k) { return src[k]; });
                base.decimated = true;
            } else { base.t = t; base.v = v; base.q = q; if (src) base.rollup = src; }
            return base;
        });
    }
    var b = o.bucketMs;
    return Promise.all([E.store.aggSamples(id, from, to, b), E.store.getRollups(id, from, to)]).then(function (r) {
        var parts = r[0], roll = r[1];
        if (roll.length) parts = mergePartials(parts.concat(b >= ROLLUP_MS ? mergePartials(roll, b) : roll), 0);
        var pick = agg === 'min' ? 'min' : agg === 'max' ? 'max' : agg === 'last' ? 'last' : 'avg';
        base.bucketMs = b;
        base.t = parts.map(function (p) { return p.t; });
        base.v = parts.map(function (p) { return p[pick]; });
        base.q = parts.map(function (p) { return p.q; });
        base.n = parts.map(function (p) { return p.n; });
        base.min = parts.map(function (p) { return p.min; });
        base.max = parts.map(function (p) { return p.max; });
        return base;
    });
}
function dataSpan(names) {
    var lo = Infinity, hi = -Infinity;
    names.forEach(function (n) {
        var m = E.byName[n], x = m && E.stat[m.id];
        if (!x) return;
        [x.first, x.rfirst].forEach(function (v) { if (isNum(v) && v < lo) lo = v; });
        [x.last, x.rlast].forEach(function (v) { if (isNum(v) && v > hi) hi = v; });
    });
    return isFinite(lo) ? [lo, hi] : [Date.now() - 3600000, Date.now()];
}
function query(o) {
    o = o || {};
    return flush().catch(noop).then(ensureStore).then(function () {
        var tags = resolveTagNames(o.tags), agg = AGGS.indexOf(o.agg) >= 0 ? o.agg : 'raw';
        var from = Math.max(0, timeArg(o.from, 0)), to = timeArg(o.to, MAXT), b = null, mp = Math.max(0, Math.floor(+o.maxPoints || 0));
        if (agg !== 'raw') {
            if (isNum(+o.bucketMs) && +o.bucketMs >= 1) b = Math.round(+o.bucketMs);
            else {
                var sp = dataSpan(tags), lo = Math.max(from, sp[0]), hi = Math.min(to, sp[1]);
                b = niceBucket(Math.max(1, hi - lo) / Math.max(1, mp || 1000));
            }
        }
        var series = [];
        return tags.reduce(function (p, tag) {
            return p.then(function () { return seriesFor(tag, from, to, agg, { maxPoints: mp, bucketMs: b }).then(function (s) { series.push(s); }); });
        }, Promise.resolve()).then(function () { return { from: from, to: to, agg: agg, bucketMs: b, engine: E.engine, series: series }; });
    });
}
// Trend data for the page: per tag, raw points when they fit (LTTB above 2 px⁻¹),
// else bucket means with the min/max envelope.
function trendData(o) {
    return flush().catch(noop).then(ensureStore).then(function () {
        var span = Math.max(1000, o.to - o.from), margin = span * 0.02, from = Math.max(0, Math.floor(o.from - margin)), to = Math.ceil(o.to + margin);
        var px = Math.max(50, Math.floor(o.px || 600)), out = [];
        return resolveTagNames(o.tags).reduce(function (p, tag) {
            return p.then(function () {
                var m = E.byName[tag];
                if (!m) { out.push({ tag: tag, t: [], v: [], q: [], unit: null, mode: 'raw', count: 0 }); return null; }
                return Promise.all([E.store.countSamples(m.id, from, to), E.store.countRollups(m.id, from, to)]).then(function (c) {
                    var n = c[0] + c[1], mode = o.agg && o.agg !== 'auto' ? o.agg : (n <= 3 * px ? 'raw' : 'avg');
                    var b = mode === 'raw' ? null : niceBucket(span / px);
                    return seriesFor(tag, from, to, mode, { maxPoints: mode === 'raw' ? 2 * px : 0, bucketMs: b }).then(function (s) {
                        s.mode = mode; s.count = n; out.push(s);
                    });
                });
            });
        }, Promise.resolve()).then(function () { return { from: o.from, to: o.to, series: out }; });
    });
}

function tagStatus(m, lastT, lastQ, now) {
    if (m && m.enabled === false) return { code: 'disabled', label: 'Not logged (disabled on the Modbus page)' };
    if (!isNum(lastT)) return { code: 'nodata', label: m ? 'Configured — no data yet' : 'No data' };
    var age = now - lastT, lim = (m && m.pollMs) ? Math.max(3 * m.pollMs, 10000) : 60000;
    if (age > lim) return { code: 'idle', label: 'Idle — last sample ' + fmtDur(age) + ' ago' };
    if (lastQ === 2) return { code: 'bad', label: 'Logging — bad quality' };
    if (lastQ === 1) return { code: 'stale', label: 'Logging — stale value' };
    return { code: 'logging', label: 'Logging' };
}
function listTags() {
    return flush().catch(noop).then(ensureStore).then(function () {
        var mb = modbusTagMap(), now = Date.now();
        var names = uniq(Object.keys(E.byName).concat(Object.keys(mb)).concat(Object.keys(E.live))).sort();
        return names.map(function (name) {
            var t = E.byName[name], x = (t && E.stat[t.id]) || {}, m = mb[name] || null, L = E.live[name];
            var lastT = L ? Math.max(L.t, isNum(x.last) ? x.last : -Infinity) : firstDef(x.last, x.rlast);
            var useLive = L && (!isNum(x.last) || L.t >= x.last);
            var lastQ = useLive ? L.q : firstDef(x.lastQ, null), lastV = useLive ? L.v : firstDef(x.lastV, null);
            var first = [x.first, x.rfirst].filter(isNum);
            return {
                tag: name, id: t ? t.id : null, device: firstDef(t && t.device, m && m.device, L && L.device), unit: firstDef(t && t.unit, m && m.unit, L && L.unit),
                desc: firstDef(t && t.descr, m && m.desc), count: x.n || 0, rollups: x.rn || 0, first: first.length ? Math.min.apply(null, first) : null,
                last: isNum(lastT) ? lastT : null, lastValue: lastV, lastQuality: lastQ === null || lastQ === undefined ? null : QN[lastQ],
                configured: !!m, enabled: m ? m.enabled : null, pollMs: m ? m.pollMs : null, source: /^FORM\.|^SIM\./.test(name) || firstDef(t && t.device, L && L.device) === 'form' ? 'form' : /^DEMO\./.test(name) ? 'demo' : (m ? 'modbus' : 'recorded'),
                status: tagStatus(m, isNum(lastT) ? lastT : null, lastQ, now)
            };
        });
    });
}
function storageEstimate() {
    var st = G.navigator && G.navigator.storage, o = { usage: null, quota: null, persisted: null, canPersist: !!(st && typeof st.persist === 'function') };
    if (!st || T.noEstimate) return Promise.resolve(o);
    var est = typeof st.estimate === 'function' ? st.estimate().catch(noop) : null, per = typeof st.persisted === 'function' ? st.persisted().catch(noop) : null;
    return Promise.all([est, per]).then(function (r) {
        if (r[0]) { o.usage = isNum(r[0].usage) ? r[0].usage : null; o.quota = isNum(r[0].quota) ? r[0].quota : null; }
        if (typeof r[1] === 'boolean') o.persisted = r[1];
        return o;
    });
}
function status() {
    return {
        ready: !!E.store, engine: E.engine, label: E.engine ? ENGINE_LABEL[E.engine] : null, home: E.home, spoolFor: E.spoolFor,
        reasons: E.reasons.slice(), notes: E.notes.slice(), buffer: E.buf.length, dropped: E.dropped, rejected: E.rejected,
        flushes: E.flushes, written: E.written, lastFlush: E.lastFlush || null, lastFlushMs: E.lastFlushMs, lastError: E.lastError || null,
        samples: E.tot.samples, rollups: E.tot.rollups, tags: Object.keys(E.byId).length, lib: JSON.parse(JSON.stringify(E.lib))
    };
}
function stats() {
    return ensureStore().then(function () {
        return E.store.info().then(function (i) { E.info = i; }, noop);
    }).then(storageEstimate).then(function (est) {
        var s = status(), set = getSettings(), lo = Infinity, hi = -Infinity;
        Object.keys(E.stat).forEach(function (k) {
            var x = E.stat[k];
            [x.first, x.rfirst].forEach(function (v) { if (isNum(v) && v < lo) lo = v; });
            [x.last, x.rlast].forEach(function (v) { if (isNum(v) && v > hi) hi = v; });
        });
        s.first = isFinite(lo) ? lo : null; s.last = isFinite(hi) ? hi : null;
        s.version = E.info ? E.info.version : null; s.dbBytes = E.info && isNum(E.info.bytes) ? E.info.bytes : null;
        s.retention = { days: set.days, maxRows: set.maxRows, downsampleAfterDays: set.downsampleAfterDays };
        s.enginePref = set.engine; s.effectiveMaxRows = isFinite(effCap()) ? effCap() : null;
        s.lastRetention = E.lastRetention || null; s.lastRetentionResult = E.lastRetentionResult;
        s.storage = est; s.lastPersist = E.lastPersist || null;
        return s;
    });
}

// ── retention settings / purge / engine switch ──
function setRetention(o) {
    o = o || {};
    var s = getSettings(), errs = [];
    var chk = function (k, lo, hi, label) {
        if (o[k] === undefined || o[k] === null || o[k] === '') return;
        var n = +o[k];
        if (!isFinite(n) || n < lo || n > hi || Math.round(n) !== n) errs.push(label + ' must be a whole number from ' + lo + ' to ' + fmtCount(hi));
        else s[k] = n;
    };
    chk('days', 0, 36500, 'Retention (days)');
    chk('downsampleAfterDays', 0, 36500, 'Downsample after (days)');
    chk('maxRows', 0, 1e10, 'Max raw rows');
    if (s.maxRows > 0 && s.maxRows < 1000) errs.push('Max raw rows must be 0 (no limit) or at least 1,000');
    if (errs.length) return Promise.reject(new Error(errs.join('; ')));
    saveSettings(s);
    return lock(function () { return ensureStore().then(runRetention); }).then(function (res) {
        publishState();
        return { days: s.days, maxRows: s.maxRows, downsampleAfterDays: s.downsampleAfterDays, effectiveMaxRows: isFinite(effCap()) ? effCap() : null, result: res };
    });
}
function purge(o) {
    o = o || {};
    var before = o.before === undefined || o.before === null || o.before === '' ? null : timeArg(o.before, null);
    if (before === null && !o.tags && o.all !== true) return Promise.reject(new Error('purge() needs {before}, {tags} or {all: true}'));
    return flush().catch(noop).then(function () {
        return lock(function () {
            return ensureStore().then(function () {
                var out = { samples: 0, rollups: 0 };
                if (o.all === true && before === null && !o.tags) {
                    out.samples = E.tot.samples; out.rollups = E.tot.rollups;
                    return E.store.clear().then(function () { return reloadMeta(); }).then(function () { return out; });
                }
                var names = o.tags ? resolveTagNames(o.tags) : Object.keys(E.byName), to = before === null ? MAXT : before - 1;
                return names.reduce(function (p, n) {
                    var m = E.byName[n];
                    if (!m) return p;
                    return p.then(function () { return E.store.deleteSamples(m.id, 0, to); }).then(function (k) { out.samples += k; return E.store.deleteRollups(m.id, 0, to); })
                        .then(function (k) { out.rollups += k; });
                }, Promise.resolve()).then(function () { return E.store.vacuum(); }).then(refreshStats).then(function () { return out; });
            }).then(function (out) {
                markDirty(); publishState();
                emit({ reason: 'purge', samples: out.samples, rollups: out.rollups });
                return out;
            });
        });
    });
}
function switchEngine(name, opts) {
    if (name !== 'auto' && ENGINES.indexOf(name) < 0) return Promise.reject(new Error('Unknown storage engine "' + name + '"'));
    opts = opts || {};
    return flush().catch(noop).then(function () {
        return lock(function () {
            return ensureStore().then(function () {
                var s = getSettings();
                if (name === 'auto' || name === E.engine) {
                    s.engine = name; saveSettings(s);
                    if (name !== 'auto') { lsSet(LS_HOME, name); E.home = name; E.spoolFor = null; }
                    return { engine: E.engine, from: E.engine, moved: 0, rollups: 0 };
                }
                var old = E.store, oldName = E.engine, dst, res;
                return OPEN[name]().then(function (st) { dst = st; return copyStore(old, dst, 'ignore'); }).then(function (r) {
                    res = r;
                    if (oldName === 'sqljs') { E.dirty = false; if (E.persistTimer !== null) { clearTimeout(E.persistTimer); E.persistTimer = null; } }
                    var clearOld = opts.clearOld === false ? Promise.resolve() : old.clear().then(function () { return old.persist ? old.persist() : null; }).catch(noop);
                    return clearOld.then(function () { return old.close ? old.close() : null; }).catch(noop);
                }).then(function () {
                    E.store = dst; E.engine = name; E.home = name; E.spoolFor = null;
                    lsSet(LS_HOME, name); s.engine = name; saveSettings(s);
                    return reloadMeta();
                }).then(function () {
                    markDirty(); publishState();
                    emit({ reason: 'engine', from: oldName, samples: res.samples });
                    return { engine: name, from: oldName, moved: res.samples, rollups: res.rollups };
                });
            });
        });
    });
}

// ── export ──
function fileStamp(ext, pre) { return (pre || 'historian') + '-' + stamp(Date.now()) + '.' + ext; }
function download(parts, filename, type) {
    if (!hasDoc() || !G.Blob || !G.URL || typeof G.URL.createObjectURL !== 'function') return false;
    var a = document.createElement('a');
    a.href = G.URL.createObjectURL(new G.Blob(parts, { type: type }));
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () { try { G.URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {} }, 1500);
    return true;
}
function rawWithRollups(id, from, to, withRoll) {
    var lo = from, o = { t: [], v: [], q: [], roll: [] };
    function more() {
        return E.store.getSamples(id, lo, to, CHUNK).then(function (c) {
            for (var i = 0; i < c.t.length; i++) { o.t.push(c.t[i]); o.v.push(c.v[i]); o.q.push(c.q[i]); }
            if (c.t.length < CHUNK) return null;
            lo = c.t[c.t.length - 1] + 1;
            return more();
        });
    }
    return more().then(function () { return withRoll ? E.store.getRollups(id, from, to) : []; }).then(function (r) { o.roll = r; return o; });
}
// → {head, rows, layout, agg, bucketMs, tags, from, to}; empty cells are null.
function exportRows(o) {
    o = o || {};
    return flush().catch(noop).then(ensureStore).then(function () {
        var tags = resolveTagNames(o.tags).filter(function (n) { return !!E.byName[n]; });
        var from = Math.max(0, timeArg(o.from, 0)), to = timeArg(o.to, MAXT), agg = AGGS.indexOf(o.agg) >= 0 ? o.agg : 'raw';
        var layout = o.layout === 'wide' ? 'wide' : 'long', withRoll = o.rollups !== false, b = null;
        if (agg !== 'raw') {
            if (isNum(+o.bucketMs) && +o.bucketMs >= 1) b = Math.round(+o.bucketMs);
            else { var sp = dataSpan(tags); b = niceBucket(Math.max(1, Math.min(to, sp[1]) - Math.max(from, sp[0])) / 1000); }
        }
        var X = { head: null, rows: [], layout: layout, agg: agg, bucketMs: b, tags: tags, from: from, to: to };
        var per = {};
        return tags.reduce(function (p, name) {
            return p.then(function () {
                var m = E.byName[name];
                if (agg === 'raw') return rawWithRollups(m.id, from, to, withRoll).then(function (r) { per[name] = r; });
                return seriesFor(name, from, to, agg, { bucketMs: b }).then(function (s) { per[name] = s; });
            });
        }, Promise.resolve()).then(function () {
            if (layout === 'long') {
                X.head = LONG_HEAD.slice();
                var srcLabel = agg === 'raw' ? 'raw' : agg + ' ' + bucketLabel(b);
                tags.forEach(function (name) {
                    var m = E.byName[name], s = per[name], unit = m.unit || null, dev = m.device || null, i = 0, j = 0;
                    var roll = agg === 'raw' ? s.roll : [];
                    while (i < s.t.length || j < roll.length) {
                        if (j >= roll.length || (i < s.t.length && s.t[i] <= roll[j].t)) {
                            var v = s.v[i];
                            X.rows.push([isoUTC(s.t[i]), s.t[i], name, v === null || v === undefined ? null : v, QN[s.q[i]] || 'bad', unit, dev, srcLabel,
                                agg === 'raw' ? null : s.n[i], agg === 'raw' ? null : s.min[i], agg === 'raw' ? null : s.max[i]]);
                            i++;
                        } else {
                            var r = roll[j++];
                            X.rows.push([isoUTC(r.t), r.t, name, r.avg, QN[r.q] || 'bad', unit, dev, 'rollup ' + bucketLabel(r.dt || ROLLUP_MS), r.n, r.min, r.max]);
                        }
                    }
                });
                return X;
            }
            // Wide: one row per distinct time, one column per tag (value only; bad → empty).
            X.head = ['time_utc', 'epoch_ms'].concat(tags.map(function (n) { var u = E.byName[n].unit; return u ? n + ' [' + u + ']' : n; }));
            var cols = tags.map(function (name) {
                var s = per[name], mp = {};
                if (agg === 'raw') { s.roll.forEach(function (r) { if (r.q !== 2) mp[r.t] = r.avg; }); }
                for (var i = 0; i < s.t.length; i++) if (s.q[i] !== 2 && s.v[i] !== null && s.v[i] !== undefined) mp[s.t[i]] = s.v[i];
                return mp;
            });
            var times = {};
            tags.forEach(function (name) { var s = per[name]; s.t.forEach(function (t) { times[t] = 1; }); if (agg === 'raw') s.roll.forEach(function (r) { times[r.t] = 1; }); });
            Object.keys(times).map(Number).sort(function (a, c) { return a - c; }).forEach(function (t) {
                var row = [isoUTC(t), t], any = false;
                cols.forEach(function (mp) { var v = Object.prototype.hasOwnProperty.call(mp, t) ? mp[t] : null; if (v !== null) any = true; row.push(v); });
                if (any) X.rows.push(row);
            });
            return X;
        });
    });
}
function exportCSV(o) {
    o = o || {};
    return exportRows(o).then(function (X) {
        if (o.skipEmpty && !X.rows.length) return { filename: null, rows: 0, empty: true };       // page export: no empty file
        var parts = [csvLine(X.head)];
        for (var i = 0; i < X.rows.length; i += 5000) {
            var chunk = '';
            for (var j = i; j < Math.min(X.rows.length, i + 5000); j++) chunk += csvLine(X.rows[j]);
            parts.push(chunk);
        }
        var text = parts.join(''), filename = o.filename || fileStamp('csv');
        if (o.download !== false) download([text], filename, 'text/csv;charset=utf-8');
        return { filename: filename, rows: X.rows.length, layout: X.layout, agg: X.agg, bucketMs: X.bucketMs, text: text };
    });
}
function loadXLSX() {
    if (G.XLSX && G.XLSX.utils && typeof G.XLSX.write === 'function') return Promise.resolve(G.XLSX);
    if (typeof G.PRiSM_loadXLSX === 'function') return G.PRiSM_loadXLSX();          // the app's lazy SheetJS loader (07-data-enhancements.js)
    return Promise.reject(new Error('Excel support (SheetJS) is not available'));
}
function tagSheet(names) {
    var rows = [['tag', 'device', 'unit', 'description', 'samples', 'downsampled_rows', 'first_utc', 'last_utc']];
    names.forEach(function (n) {
        var m = E.byName[n], x = (m && E.stat[m.id]) || {}, f = [x.first, x.rfirst].filter(isNum), l = [x.last, x.rlast].filter(isNum);
        rows.push([n, m && m.device || null, m && m.unit || null, m && m.descr || null, x.n || 0, x.rn || 0,
            f.length ? isoUTC(Math.min.apply(null, f)) : null, l.length ? isoUTC(Math.max.apply(null, l)) : null]);
    });
    return rows;
}
function exportXLSX(o) {
    o = o || {};
    var X;
    return exportRows(o).then(function (x) {
        X = x;
        if (o.skipEmpty && !X.rows.length) return null;
        if (X.rows.length > 1048575) throw new Error('Too many rows for one Excel sheet (' + fmtCount(X.rows.length) + ' > 1,048,575) — narrow the range, aggregate, or export CSV.');
        return loadXLSX();
    }).then(function (XL) {
        if (!XL) return { filename: null, rows: 0, empty: true };
        var wb = XL.utils.book_new(), sheet = X.layout === 'wide' ? 'Data' : 'Samples';
        XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([X.head].concat(X.rows)), sheet);
        XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(tagSheet(X.tags)), 'Tags');
        XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([
            ['H2Oil Well Testing Suite — historian export'], ['exported_utc', isoUTC(Date.now())], ['engine', ENGINE_LABEL[E.engine]],
            ['from_utc', X.from > 0 ? isoUTC(X.from) : 'start'], ['to_utc', X.to < MAXT ? isoUTC(X.to) : 'end'],
            ['aggregation', X.agg === 'raw' ? 'raw samples (+ 60-s rollups of older data)' : X.agg + ' per ' + bucketLabel(X.bucketMs)],
            ['layout', X.layout], ['rows', X.rows.length],
            ['note', 'Times are UTC (ISO 8601); epoch_ms = milliseconds since 1970-01-01 UTC. Quality: good / stale / bad.']
        ]), 'Info');
        var bytes = XL.write(wb, { bookType: 'xlsx', type: 'array' }), filename = o.filename || fileStamp('xlsx');
        if (o.download !== false) download([bytes], filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return { filename: filename, rows: X.rows.length, layout: X.layout, sheets: [sheet, 'Tags', 'Info'], bytes: bytes };
    });
}
function jsonBackup() {
    var out = { format: 'wts-historian', version: 1, exported: isoUTC(Date.now()), engine: E.engine, tags: [], samples: {}, rollups: {}, settings: getSettings() };
    var tags = Object.keys(E.byId).map(function (k) { return E.byId[k]; }).sort(function (a, b) { return a.id - b.id; });
    return tags.reduce(function (p, t) {
        return p.then(function () {
            out.tags.push({ name: t.name, device: t.device, unit: t.unit, descr: t.descr, created: t.created });
            return rawWithRollups(t.id, 0, MAXT, true).then(function (r) {
                if (r.t.length) out.samples[t.name] = { t: r.t, v: r.v, q: r.q };
                if (r.roll.length) out.rollups[t.name] = r.roll.map(rollToArr);
            });
        });
    }, Promise.resolve()).then(function () { return out; });
}
function sqliteFromStore(src) {
    return loadSqlJs().then(function (SQL) {
        var db = new SQL.Database(), tmp = asyncStore(HistSqlStore(histSqlJsAdapter(db)), 'sqljs');
        return tmp.init().then(function () { return copyStore(src, tmp, 'ignore'); })
            .then(function () { var b = db.export(); db.close(); return b; }, function (e) { try { db.close(); } catch (e2) {} throw e; });
    });
}
function exportDb(o) {
    o = o || {};
    return flush().catch(noop).then(ensureStore).then(function () {
        var fmt = o.format === 'json' ? 'json' : o.format === 'sqlite' ? 'sqlite' : (isSqlEngine() ? 'sqlite' : 'json');
        var filename = o.filename || fileStamp(fmt === 'json' ? 'json' : 'sqlite', 'historian-backup');
        if (fmt === 'json') {
            return jsonBackup().then(function (obj) {
                var text = JSON.stringify(obj);
                if (o.download !== false) download([text], filename, 'application/json');
                return { format: 'json', filename: filename, text: text, size: text.length, tags: obj.tags.length };
            });
        }
        return (isSqlEngine() ? E.store.exportBytes() : sqliteFromStore(E.store)).then(function (bytes) {
            bytes = toU8(bytes);
            if (o.download !== false) download([bytes], filename, 'application/vnd.sqlite3');
            return { format: 'sqlite', filename: filename, bytes: bytes, size: bytes.byteLength };
        });
    });
}

// ── import / restore ──
function readInput(input) {
    if (input === null || input === undefined) return Promise.reject(new Error('No file'));
    if (typeof input === 'string') return Promise.resolve(input);
    if (input && typeof input === 'object' && 'data' in input && !(typeof input.arrayBuffer === 'function')) return readInput(input.data);
    if (typeof input.byteLength === 'number') return Promise.resolve(asBuf(input));
    if (typeof input.arrayBuffer === 'function') return input.arrayBuffer();
    if (typeof G.FileReader === 'function') {
        return new Promise(function (res, rej) {
            var fr = new G.FileReader();
            fr.onload = function () { res(fr.result); };
            fr.onerror = function () { rej(fr.error || new Error('The file could not be read')); };
            fr.readAsArrayBuffer(input);
        });
    }
    return Promise.reject(new Error('Unsupported input'));
}
function detectKind(name, data) {
    var head = '';
    if (typeof data === 'string') head = data.slice(0, 16);
    else { var u = new Uint8Array(data, 0, Math.min(16, data.byteLength)); for (var i = 0; i < u.length; i++) head += String.fromCharCode(u[i]); }
    if (head.indexOf('SQLite format 3') === 0) return 'sqlite';
    if (head.indexOf('PK\u0003\u0004') === 0) return 'xlsx';
    if (/\.(sqlite3?|db)$/i.test(name)) return 'sqlite';
    if (/\.xlsx?$/i.test(name)) return 'xlsx';
    if (/^\s*\{/.test(head) || /\.json$/i.test(name)) return 'json';
    return 'csv';
}
function readSqliteBackup(bytes) {
    return loadSqlJs().then(function (SQL) {
        var db;
        try { db = new SQL.Database(toU8(bytes)); } catch (e) { throw new Error('Not a readable SQLite file (' + errMsg(e) + ')'); }
        try {
            var names = {};
            (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0] || { values: [] }).values.forEach(function (r) { names[r[0]] = 1; });
            if (!names.tags || !names.samples) throw new Error('This SQLite file is not a historian backup (no tags / samples tables).');
            var st = HistSqlStore(histSqlJsAdapter(db)), d = { format: 'sqlite', tags: {}, samples: {}, rollups: {}, invalid: 0, rows: 0 };
            st.getTags().forEach(function (t) {
                d.tags[t.name] = { unit: t.unit, device: t.device, descr: t.descr };
                var s = st.getSamples(t.id, 0, MAXT);
                if (s.t.length) { d.samples[t.name] = s; d.rows += s.t.length; }
                if (names.rollups) { var r = st.getRollups(t.id, 0, MAXT); if (r.length) { d.rollups[t.name] = r; d.rows += r.length; } }
            });
            return d;
        } finally { db.close(); }
    });
}
function readJsonBackup(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { throw new Error('Not valid JSON (' + errMsg(e) + ')'); }
    if (!o || o.format !== 'wts-historian') throw new Error('Not a historian JSON backup (format is not "wts-historian").');
    var d = { format: 'json', tags: {}, samples: {}, rollups: {}, invalid: 0, rows: 0 };
    (Array.isArray(o.tags) ? o.tags : []).forEach(function (t) { var n = cleanStr(t && t.name, 128); if (n) d.tags[n] = { unit: cleanStr(t.unit, 32), device: cleanStr(t.device), descr: cleanStr(t.descr, 200) }; });
    Object.keys(o.samples || {}).forEach(function (name) {
        var s = o.samples[name], n = cleanStr(name, 128);
        if (!n || !s || !Array.isArray(s.t)) return;
        var out = { t: [], v: [], q: [] };
        for (var i = 0; i < s.t.length; i++) {
            d.rows++;
            var t = +s.t[i], v = s.v && s.v[i] !== undefined ? s.v[i] : null;
            v = v === null ? null : +v;
            if (!isFinite(t) || t < 0 || (v !== null && !isFinite(v))) { d.invalid++; continue; }
            out.t.push(Math.round(t)); out.v.push(v); out.q.push(qCode(s.q ? s.q[i] : undefined, v));
        }
        d.samples[n] = out;
        if (!d.tags[n]) d.tags[n] = { unit: null, device: null };
    });
    Object.keys(o.rollups || {}).forEach(function (name) {
        var n = cleanStr(name, 128), a = o.rollups[name];
        if (!n || !Array.isArray(a)) return;
        d.rollups[n] = a.filter(function (r) { d.rows++; var ok = Array.isArray(r) && isNum(+r[0]) && isNum(+r[2]); if (!ok) d.invalid++; return ok; }).map(arrToRoll);
        if (!d.tags[n]) d.tags[n] = { unit: null, device: null };
    });
    return d;
}
function readXlsx(buf) {
    return loadXLSX().then(function (XL) {
        var wb = XL.read(new Uint8Array(buf), { type: 'array' }), sn = wb.SheetNames || [];
        var name = sn.indexOf('Samples') >= 0 ? 'Samples' : sn.indexOf('Data') >= 0 ? 'Data' : sn[0];
        if (!name) throw new Error('The workbook has no sheets');
        var d = rowsToImport(XL.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }));
        if (wb.Sheets.Tags) {
            var ta = XL.utils.sheet_to_json(wb.Sheets.Tags, { header: 1, raw: true, defval: '' }), h = (ta[0] || []).map(function (x) { return String(x).toLowerCase(); });
            var ci = function (k) { return h.indexOf(k); };
            ta.slice(1).forEach(function (r) {
                var n = cleanStr(r[ci('tag')], 128);
                if (!n) return;
                var cur = d.tags[n] || (d.tags[n] = { unit: null, device: null });
                if (ci('unit') >= 0 && cleanStr(r[ci('unit')], 32)) cur.unit = cleanStr(r[ci('unit')], 32);
                if (ci('device') >= 0 && cleanStr(r[ci('device')])) cur.device = cleanStr(r[ci('device')]);
                if (ci('description') >= 0 && cleanStr(r[ci('description')], 200)) cur.descr = cleanStr(r[ci('description')], 200);
            });
        }
        d.format = 'xlsx (' + d.format + ')';
        return d;
    });
}
function importData(d, o) {
    var dup = o.dup === 'overwrite' ? 'replace' : 'ignore', mode = o.mode === 'replace' ? 'replace' : 'merge';
    var names = uniq(Object.keys(d.tags).concat(Object.keys(d.samples)).concat(Object.keys(d.rollups)));
    var res = { format: d.format, mode: mode, duplicates: dup === 'replace' ? 'overwrite' : 'skip', rows: d.rows || 0, invalid: d.invalid || 0,
        tags: names.length, tagsCreated: 0, inserted: 0, updated: 0, skipped: 0, rollups: 0, rollupsSkipped: 0, from: null, to: null, olderThanRetention: 0 };
    var set = getSettings(), cutRet = set.days > 0 ? Date.now() - set.days * DAY : -Infinity;
    return ensureStore().then(function () {
        return mode === 'replace' ? E.store.clear().then(reloadMeta) : null;
    }).then(function () {
        res.tagsCreated = names.filter(function (n) { return !E.byName[n]; }).length;
        if (!names.length) return null;
        return E.store.putTags(names.map(function (n) { var t = d.tags[n] || {}; return { name: n, device: t.device || null, unit: t.unit || null, descr: t.descr || null }; }))
            .then(function (all) { all.forEach(indexTag); });
    }).then(function () {
        return names.reduce(function (p, n) {
            return p.then(function () {
                var id = E.byName[n].id, S = d.samples[n], R = d.rollups[n] || [];
                var span = function (t) { if (res.from === null || t < res.from) res.from = t; if (res.to === null || t > res.to) res.to = t; if (t < cutRet) res.olderThanRetention++; };
                var chunkAt = function (off) {
                    if (!S || off >= S.t.length) return Promise.resolve();
                    var end = Math.min(S.t.length, off + CHUNK), t = S.t.slice(off, end);
                    t.forEach(span);
                    return E.store.putSamples(repeat(id, t.length), t, S.v.slice(off, end), S.q.slice(off, end), dup).then(function (r) {
                        res.inserted += r.inserted; res.updated += r.updated; res.skipped += r.skipped;
                        return chunkAt(end);
                    });
                };
                return chunkAt(0).then(function () {
                    if (!R.length) return null;
                    var lo = Infinity, hi = -Infinity;
                    R.forEach(function (r) { if (r.t < lo) lo = r.t; if (r.t > hi) hi = r.t; span(r.t); });
                    return (dup === 'ignore' ? E.store.getRollups(id, lo, hi) : Promise.resolve([])).then(function (old) {
                        var have = {};
                        old.forEach(function (r) { have[r.t] = 1; });
                        var put = R.filter(function (r) { return !have[r.t]; });
                        res.rollupsSkipped += R.length - put.length;
                        return E.store.putRollups(id, put).then(function (k) { res.rollups += k; });
                    });
                });
            });
        }, Promise.resolve());
    }).then(refreshStats).then(function () {
        markDirty(); publishState();
        emit({ reason: 'import', inserted: res.inserted, updated: res.updated, rollups: res.rollups, tags: names });
        return res;
    });
}
function importFile(input, o) {
    o = o || {};
    var name = String(o.name || (input && input.name) || 'import.csv');
    return readInput(input).then(function (data) {
        var kind = o.kind || detectKind(name, data);
        if (kind === 'sqlite') return readSqliteBackup(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        if (kind === 'xlsx') return readXlsx(data);
        var text = typeof data === 'string' ? data : utf8(data);
        if (kind === 'json') return readJsonBackup(text);
        var d = rowsToImport(parseDelimited(text));
        d.format = 'csv (' + d.format + ')';
        return d;
    }).then(function (d) {
        return flush().catch(noop).then(function () { return lock(function () { return importData(d, o); }); });
    }).then(function (res) { res.file = name; return res; });
}

// ─── §8 demo data and form logging (work without Modbus) ─────────────
var DEMO = [
    { tag: 'DEMO.WHP', unit: 'psig', base: 2850, amp: 60, per: 1800e3 },
    { tag: 'DEMO.WHT', unit: 'degF', base: 176, amp: 3, per: 3600e3 },
    { tag: 'DEMO.QG', unit: 'MMscf/d', base: 9.6, amp: 0.5, per: 2400e3 },
    { tag: 'DEMO.PSEP', unit: 'psig', base: 150, amp: 4, per: 600e3 }
];
function lcg(seed) { var s = (seed >>> 0) || 1; return function () { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; }; }
// Synthetic samples: a slow sine per tag plus ±10 % noise; every 97th sample stale, every 331st bad.
function demoBatch(t, rnd, k) {
    return DEMO.map(function (d, i) {
        var v = d.base + d.amp * Math.sin(2 * Math.PI * (t % d.per) / d.per + i) + d.amp * 0.1 * (rnd() * 2 - 1), q = 'good';
        if ((k + i * 7) % 331 === 0) { v = null; q = 'bad'; } else if ((k + i * 5) % 97 === 0) q = 'stale';
        return { tag: d.tag, device: 'demo', unit: d.unit, t: t, v: v === null ? null : +v.toFixed(4), q: q };
    });
}
function demoHistory(hours, stepMs) {
    hours = hours || 24; stepMs = stepMs || 10000;
    var now = Date.now(), rnd = lcg(12345), k = 0, all = [];
    for (var t = floorTo(now - hours * 3600000, stepMs); t <= now; t += stepMs) all.push.apply(all, demoBatch(t, rnd, k++));
    record(all);
    return flush().then(function () { return all.length; });
}
var DEMOLIVE = { timer: null, until: 0, rnd: null, k: 0 };
function demoStart() {
    if (DEMOLIVE.timer !== null) return true;
    DEMOLIVE.rnd = lcg(Date.now() & 0xffff); DEMOLIVE.until = Date.now() + 3600000;      // stops by itself after 1 h
    DEMOLIVE.timer = setInterval(function () {
        var t = Date.now();
        if (t > DEMOLIVE.until) { demoStop(); return; }
        record(demoBatch(t - (t % 1000), DEMOLIVE.rnd, DEMOLIVE.k++));
    }, 1000);
    updateButtons();
    return true;
}
function demoStop() { if (DEMOLIVE.timer !== null) { clearInterval(DEMOLIVE.timer); DEMOLIVE.timer = null; } updateButtons(); return false; }

// "Log form data": the Well Test form's solved flow path (event 'wts:calc', WTS_lastCalc — imperial,
// as calcWTS publishes it) and, while the live simulator runs, its rate/cumulative summary
// (WTS_state.sim) every 5 s. Session only: it is never restarted automatically after a reload.
var FORM = { on: false, timer: null };
function formSamples(d, t) {
    if (!d || typeof d !== 'object') return [];
    var I = d.inputs || {}, C = d.choke || {}, H = d.heater || {}, out = [];
    var add = function (tag, v, unit) { if (v !== null && v !== undefined && v !== '' && isFinite(+v)) out.push({ tag: tag, device: 'form', unit: unit, t: t, v: +v, q: 'good' }); };
    add('FORM.WHP', I.Pwh, 'psig'); add('FORM.WHT', I.Twh, 'degF'); add('FORM.QG', I.Qg, 'MMscf/d');
    add('FORM.QO', I.Qo, 'bbl/d'); add('FORM.QW', I.Qw, 'bbl/d'); add('FORM.CHOKE', I.bean, '1/64 in'); add('FORM.PSEP', I.Psep, 'psig');
    if (isNum(C.Pin) && isNum(C.Pout)) add('FORM.CHOKE_DP', C.Pin - C.Pout, 'psi');
    add('FORM.HTR_OUT', H.Tout, 'degF');
    return out;
}
function simSamples(t) {
    var s = G.WTS_state && G.WTS_state.sim, out = [];
    if (!s || !s.running) return out;
    var R = s.rates || {}, C = s.cum || {};
    var add = function (tag, v, unit) { if (v !== null && v !== undefined && isFinite(+v)) out.push({ tag: tag, device: 'simulator', unit: unit, t: t, v: +v, q: 'good' }); };
    add('SIM.QG', R.gas_mmscfd, 'MMscf/d'); add('SIM.QO', R.oil_stbd, 'STB/d'); add('SIM.QW', R.water_bpd, 'bbl/d');
    add('SIM.GOR', R.gor, 'scf/STB'); add('SIM.BSW', R.bsw_pct, '%'); add('SIM.CUM_OIL', C.oil_stb, 'STB'); add('SIM.CUM_GAS', C.gas_mmscf, 'MMscf');
    return out;
}
function setFormLogging(on) {
    on = !!on;
    if (FORM.on === on) return on;
    FORM.on = on;
    if (on) {
        if (G.WTS_lastCalc) record(formSamples(G.WTS_lastCalc, Date.now()));
        FORM.timer = setInterval(function () { var s = simSamples(Date.now()); if (s.length) record(s); }, 5000);
    } else if (FORM.timer !== null) { clearInterval(FORM.timer); FORM.timer = null; }
    var cb = pageEl('[data-h="logform"]');
    if (cb) cb.checked = on;
    return on;
}

// ─── §9 page ─────────────────────────────────────────────────────────
// Categorical series colours (dark surface; checked with a CVD / contrast validator against
// #0d1117: adjacent-pair CVD ΔE ≥ 8.4, all ≥ 3:1). Assigned to tags by selection slot, never cycled.
var COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
var INK = { bg: '#0d1117', text: '#e6edf3', text2: '#8b949e', muted: '#8b949e', grid: '#21262d', axis: '#30363d', bad: '#f85149', stale: '#fab219', good: '#0ca30c' };
var PRESETS = [['5m', 300000, '5 min'], ['1h', 3600000, '1 h'], ['8h', 28800000, '8 h'], ['24h', 86400000, '24 h'], ['7d', 604800000, '7 d']];
var MAX_TREND_TAGS = COLORS.length;
var V = {
    preset: '1h', lastPreset: '1h', from: 0, to: 0, live: true, tags: null, slots: {}, agg: 'auto', layout: 'stacked',
    data: null, seq: 0, fetchTimer: null, liveTimer: null, raf: null, cursorX: null, ptr: {}, drag: null, pinch: null, geo: null,
    tagList: [], tbl: { page: 0, size: 100, desc: true, mode: 'raw', bucket: 0, qf: 'all', rows: null, series: null, bucketMs: null, seq: 0, timer: null }
};
function presetMs(p) { for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i][0] === p) return PRESETS[i][1]; return 3600000; }
function pageMounted() { return !!$('hist_root'); }
function pageEl(sel) { var r = $('hist_root'); return r && typeof r.querySelector === 'function' ? r.querySelector(sel) : null; }
function loadView() {
    var s = lsJSON(LS_VIEW) || {};
    if (PRESETS.some(function (p) { return p[0] === s.preset; })) { V.preset = s.preset; V.lastPreset = s.preset; }
    V.live = s.live !== false;
    if (!V.live && isNum(s.from) && isNum(s.to) && s.to > s.from) { V.from = s.from; V.to = s.to; V.preset = 'custom'; }
    if (Array.isArray(s.tags)) V.tags = s.tags.filter(function (x) { return typeof x === 'string'; }).slice(0, MAX_TREND_TAGS);
    if (s.slots && typeof s.slots === 'object') V.slots = s.slots;
    if (['auto', 'raw', 'avg', 'min', 'max', 'last'].indexOf(s.agg) >= 0) V.agg = s.agg;
    if (s.layout === 'overlay' || s.layout === 'stacked') V.layout = s.layout;
    var t = s.tbl || {};
    if (AGGS.indexOf(t.mode) >= 0) V.tbl.mode = t.mode;
    if ([50, 100, 500].indexOf(t.size) >= 0) V.tbl.size = t.size;
    if (['all', 'good', 'issues'].indexOf(t.qf) >= 0) V.tbl.qf = t.qf;
    if (isNum(t.bucket)) V.tbl.bucket = t.bucket;
    V.tbl.desc = t.desc !== false;
}
function saveView() {
    lsSet(LS_VIEW, JSON.stringify({ preset: V.preset === 'custom' || V.preset === 'zoom' ? V.lastPreset : V.preset, live: V.live,
        from: V.live ? null : V.from, to: V.live ? null : V.to, tags: V.tags, slots: V.slots, agg: V.agg, layout: V.layout,
        tbl: { mode: V.tbl.mode, size: V.tbl.size, qf: V.tbl.qf, bucket: V.tbl.bucket, desc: V.tbl.desc } }));
}
function colorOf(tag) { var k = V.slots[tag]; return COLORS[isNum(k) ? k : 0]; }
function assignSlot(tag) {
    if (isNum(V.slots[tag])) return;
    var used = {};
    (V.tags || []).forEach(function (t) { if (t !== tag && isNum(V.slots[t])) used[V.slots[t]] = 1; });
    for (var i = 0; i < COLORS.length; i++) if (!used[i]) { V.slots[tag] = i; return; }
}
function hexA(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

var CSS = [
    '.hist .hist-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 0}',
    '.hist .btn-sm{padding:7px 12px;font-size:12px;min-height:34px}',
    '.hist .hist-seg{display:inline-flex;flex-wrap:wrap;gap:2px;background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:2px}',
    '.hist .hist-seg button{background:transparent;border:0;color:var(--text2);font-size:12px;font-weight:600;padding:7px 10px;border-radius:6px;cursor:pointer;min-height:32px}',
    '.hist .hist-seg button.on{background:var(--accent);color:#fff}',
    '.hist .hist-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}',
    '.hist .hist-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer;background:var(--bg1);color:var(--text2);min-height:30px}',
    '.hist .hist-chip.on{color:var(--text);border-color:var(--border-light);background:var(--bg4)}',
    '.hist .hist-sw{display:inline-block;width:10px;height:10px;border-radius:3px;flex:0 0 10px;vertical-align:-1px}',
    '.hist .chart-wrap{position:relative;padding:6px}',
    '.hist canvas.hist-cv{height:340px;touch-action:pan-y;cursor:crosshair;border-radius:6px;outline:none}',
    '.hist canvas.hist-cv:focus-visible{box-shadow:0 0 0 2px var(--accent)}',
    '.hist .hist-cursor{position:absolute;top:10px;left:0;pointer-events:none;background:rgba(13,17,23,.95);border:1px solid var(--border);border-radius:8px;padding:6px 9px;font-size:11.5px;color:var(--text);max-width:260px;z-index:2;font-variant-numeric:tabular-nums}',
    '.hist .hist-cursor div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.hist .hist-legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--text2);margin-top:8px}',
    '.hist .hist-legend b{color:var(--text);font-weight:600}',
    '.hist .hist-tblwrap{overflow-x:auto;max-width:100%;margin-top:8px}',
    '.hist .hist-tblwrap .dtable td,.hist .hist-tblwrap .dtable th{white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.hist .hist-sort{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0;text-transform:inherit;letter-spacing:inherit}',
    '.hist .hist-badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:rgba(88,166,255,.12);color:var(--blue);margin-right:6px}',
    '.hist .hist-status{font-size:12.5px;color:var(--text2);line-height:1.7}',
    '.hist .hist-banner{margin-top:10px;padding:8px 12px;border-radius:8px;font-size:12.5px;border-left:3px solid var(--yellow);background:rgba(210,153,34,.08);color:var(--text)}',
    '.hist .hist-muted{color:var(--text3);font-size:12px;margin-top:6px}',
    '.hist .hist-chk{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text);cursor:pointer;min-height:34px}',
    '.hist .hist-msg{margin-top:10px;font-size:12.5px}',
    '.hist .q-good{color:#0ca30c}.hist .q-stale{color:#fab219}.hist .q-bad{color:#f85149}.hist .q-idle{color:var(--text3)}',
    '.hist .hist-notes{margin-top:16px;font-size:12px;color:var(--text2);line-height:1.55;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 14px}',
    '.hist .hist-custom label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)}',
    '.hist .fg-item{min-width:0;overflow:hidden}.hist .fg-item input,.hist .fg-item select,.hist .hist-custom input{min-width:0;max-width:100%}',
    '.hist input[type=file]{width:100%;overflow:hidden}',
    '@media (max-width:600px){.hist canvas.hist-cv{height:260px}.hist .fg{grid-template-columns:1fr}.hist .hist-seg button{padding:7px 8px}}'
].join('\n');
function ensureCss() {
    if (!hasDoc() || $('hist_css') || typeof document.createElement !== 'function') return;
    var st = document.createElement('style');
    st.id = 'hist_css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
}
function seg(name, items, cur) {
    return '<div class="hist-seg" role="group" aria-label="' + esc(name) + '" data-seg="' + esc(name) + '">' + items.map(function (it) {
        var on = it[0] === cur;
        return '<button type="button" data-v="' + esc(it[0]) + '"' + (on ? ' class="on"' : '') + ' aria-pressed="' + on + '">' + esc(it[it.length - 1]) + '</button>';
    }).join('') + '</div>';
}
function opts(list, cur) { return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }
var AGG_OPTS = [['avg', 'Average per bucket'], ['min', 'Minimum per bucket'], ['max', 'Maximum per bucket'], ['last', 'Last value per bucket']];
function pageHtml() {
    var ranges = PRESETS.map(function (p) { return [p[0], p[2]]; }).concat([['custom', 'Custom']]);
    return '<div id="hist_root" class="hist">' +
        '<div class="card"><div class="card-title">Historian status</div>' +
        '<div id="hist_status" class="hist-status">Opening the historian store…</div>' +
        '<div id="hist_banner" class="hist-banner" style="display:none"></div>' +
        '<div class="hist-row rp-skip">' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_modbus_btn" style="display:none">Modbus configuration &#8594;</button>' +
        '<label class="hist-chk"><input type="checkbox" data-h="logform"' + (FORM.on ? ' checked' : '') + '> Log form data (Well Test form + live simulator)</label>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_demo_btn">' + (DEMOLIVE.timer !== null ? '&#9632; Stop demo data' : '&#9654; Start demo data') + '</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_demohist_btn">Add 24 h of demo history</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_refresh_btn">Refresh</button></div>' +
        '<div class="hist-muted rp-skip">Tags and polling rates are set on the Modbus page; this page records, trends, tabulates and exports what it receives.</div></div>' +

        '<div class="card"><div class="card-title">Trend</div>' +
        '<div class="hist-row rp-skip">' + seg('Time range', ranges, V.preset) +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_live_btn" aria-pressed="' + V.live + '">' + (V.live ? '&#9679; Live' : '&#9675; Live off') + '</button></div>' +
        '<div class="hist-row hist-custom rp-skip" id="hist_custom" style="display:' + (V.preset === 'custom' ? 'flex' : 'none') + '">' +
        '<label>From <input type="datetime-local" step="1" data-h="from"></label><label>To <input type="datetime-local" step="1" data-h="to"></label>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_custom_apply">Apply range</button></div>' +
        '<div class="fg" style="margin-top:12px">' +
        '<div class="fg-item"><label>Values</label><select data-h="agg">' + opts([['auto', 'Auto (raw or bucket means)'], ['raw', 'Raw samples (LTTB)']].concat(AGG_OPTS), V.agg) + '</select></div>' +
        '<div class="fg-item"><label>Layout</label><select data-h="layout">' + opts([['stacked', 'One lane per unit'], ['overlay', 'Overlay, one axis per unit']], V.layout) + '</select></div></div>' +
        '<div class="hist-chips rp-skip" id="hist_tagpick" role="group" aria-label="Tags on the trend"></div>' +
        '<div class="chart-wrap"><canvas id="hist_cv" class="hist-cv" tabindex="0" role="img" aria-label="Historian trend"></canvas>' +
        '<div id="hist_cursor" class="hist-cursor" style="display:none"></div></div>' +
        '<div id="hist_legend" class="hist-legend"></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_reset_btn">Reset zoom</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_png_btn">Export PNG</button><span class="hist-muted" id="hist_trend_info"></span></div>' +
        '<div class="hist-muted rp-skip">Drag to pan, mouse wheel or pinch to zoom, double-click to reset. Keyboard on the chart: &#8592; &#8594; pan, + &#8722; zoom, 0 reset.</div></div>' +

        '<div class="card"><div class="card-title">Data table</div>' +
        '<div class="fg">' +
        '<div class="fg-item"><label>Table rows</label><select data-h="tmode">' + opts([['raw', 'Raw samples, time-aligned']].concat(AGG_OPTS), V.tbl.mode) + '</select></div>' +
        '<div class="fg-item"><label>Bucket</label><select data-h="tbucket">' + opts([[0, 'Auto'], [1000, '1 s'], [10000, '10 s'], [60000, '1 min'], [300000, '5 min'], [900000, '15 min'], [3600000, '1 h'], [86400000, '1 day']], V.tbl.bucket) + '</select></div>' +
        '<div class="fg-item"><label>Quality filter</label><select data-h="tq">' + opts([['all', 'All values'], ['good', 'Good values only'], ['issues', 'Rows with stale or bad values']], V.tbl.qf) + '</select></div>' +
        '<div class="fg-item"><label>Rows per page</label><select data-h="tps">' + opts([[50, '50'], [100, '100'], [500, '500']], V.tbl.size) + '</select></div></div>' +
        '<div class="hist-muted">Time range and tags: as on the trend above. &#9676; = stale value, &#10007; = bad / no value, &#8224; = 1-minute mean of downsampled data.</div>' +
        '<div class="hist-tblwrap" id="hist_table_wrap"></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_prev_btn">&#8249; Prev</button>' +
        '<span id="hist_pageinfo" class="hist-muted" style="margin:0"></span>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_next_btn">Next &#8250;</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_copy_btn">Copy (tab-separated)</button></div>' +
        '<div id="hist_tbl_msg" class="hist-msg rp-skip"></div></div>' +

        '<div class="card"><div class="card-title">Export and restore</div>' +
        '<div class="fg">' +
        '<div class="fg-item"><label>Export format</label><select data-h="xfmt">' + opts([['csv', 'CSV, one row per sample'], ['csvwide', 'CSV, one column per tag'],
            ['xlsx', 'Excel workbook (.xlsx)'], ['sqlite', 'Database backup (.sqlite)'], ['json', 'Database backup (.json)']], 'csv') + '</select></div>' +
        '<div class="fg-item"><label>Export range</label><select data-h="xrange">' + opts([['view', 'Trend time range'], ['all', 'All data']], 'view') + '</select></div>' +
        '<div class="fg-item"><label>Export tags</label><select data-h="xtags">' + opts([['sel', 'Tags on the trend'], ['all', 'All tags']], 'sel') + '</select></div>' +
        '<div class="fg-item"><label>Export values</label><select data-h="xagg">' + opts([['raw', 'Raw samples']].concat(AGG_OPTS), 'raw') + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-primary btn-sm" id="hist_export_btn">Export</button>' +
        '<span class="hist-muted" style="margin:0">Raw exports include the 1-min rollups of downsampled history (source “rollup”); database backups hold every tag and all data.</span></div>' +
        '<div class="fg rp-skip" style="margin-top:14px">' +
        '<div class="fg-item"><label>Restore from a file</label><input type="file" data-h="file" accept=".csv,.txt,.tsv,.xlsx,.xls,.sqlite,.sqlite3,.db,.json"></div>' +
        '<div class="fg-item"><label>Restore mode</label><select data-h="imode">' + opts([['merge', 'Merge into the current data'], ['replace', 'Replace all current data']], 'merge') + '</select></div>' +
        '<div class="fg-item"><label>Same tag and time already stored</label><select data-h="idup">' + opts([['skip', 'Keep the stored value'], ['overwrite', 'Overwrite with the file value']], 'skip') + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-primary btn-sm" id="hist_import_btn">Restore</button>' +
        '<span class="hist-muted" style="margin:0">Accepts this page’s CSV / Excel exports and .sqlite / .json backups.</span></div>' +
        '<div id="hist_io_res" class="hist-msg"></div></div>' +

        '<div class="card"><div class="card-title">Storage and retention</div>' +
        '<div class="fg">' +
        '<div class="fg-item"><label>Keep data for (days, 0 = forever)</label><input type="number" min="0" step="1" data-h="days"></div>' +
        '<div class="fg-item"><label>Downsample raw data older than (days, 0 = never)</label><input type="number" min="0" step="1" data-h="dsdays"></div>' +
        '<div class="fg-item"><label>Max raw rows (0 = no limit)</label><input type="number" min="0" step="1000" data-h="maxrows"></div>' +
        '<div class="fg-item"><label>Storage engine</label><select data-h="engine">' + opts([['auto', 'Automatic (best available)'], ['opfs', ENGINE_LABEL.opfs], ['sqljs', ENGINE_LABEL.sqljs],
            ['idb', ENGINE_LABEL.idb], ['memory', ENGINE_LABEL.memory]], getSettings().engine) + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_ret_btn">Apply retention</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_engine_btn">Switch engine (moves the data)</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_persist_btn">Request persistent storage</button></div>' +
        '<div id="hist_set_msg" class="hist-msg"></div>' +
        '<div class="fg rp-skip" style="margin-top:14px">' +
        '<div class="fg-item"><label>Purge data older than</label><input type="datetime-local" step="1" data-h="pbefore"></div>' +
        '<div class="fg-item"><label>Purge which tags</label><select data-h="ptags">' + opts([['sel', 'Tags on the trend'], ['all', 'All tags']], 'sel') + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_purge_btn">Purge</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_clear_btn">Delete all historian data</button></div></div>' +

        '<div id="hist_res">' +
        '<div class="rbox"><div class="rbox-title">Historian summary</div><div id="hist_summary"></div></div>' +
        '<div class="rbox"><div class="rbox-title">Tag logging status</div><div class="hist-tblwrap" id="hist_tags_wrap"></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_modbus_btn2" style="display:none">Configure tags and polling on the Modbus page &#8594;</button></div></div></div>' +

        '<div class="hist-notes"><b>Notes</b> Times are stored in UTC and shown in local time. Bucket average, minimum, maximum and last use the good samples; ' +
        'a bucket with only stale samples uses those and is marked stale; with neither it is a gap. Averages are sample means, not time-weighted. ' +
        'Raw samples older than the downsample age become 1-minute rollups; data older than the retention age is deleted (checked after a write, at most every 10 min). ' +
        'Browsers may clear site data when storage is short: request persistent storage and export backups.</div>' +
        '</div>';
}
function setMsg(id, ok, text) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = text ? '<div style="color:var(' + (ok === true ? '--green' : ok === false ? '--red' : '--yellow') + ')">' +
        (ok === true ? '&#10003; ' : ok === false ? '&#10007; ' : '&#9888; ') + esc(text) + '</div>' : '';
}
function updateButtons() {
    var b = $('hist_demo_btn');
    if (b) b.innerHTML = DEMOLIVE.timer !== null ? '&#9632; Stop demo data' : '&#9654; Start demo data';
    var lv = $('hist_live_btn');
    if (lv) { lv.innerHTML = V.live ? '&#9679; Live' : '&#9675; Live off'; lv.setAttribute('aria-pressed', String(V.live)); }
    var r = pageEl('[data-seg="Time range"]');
    if (r) Array.prototype.forEach.call(r.querySelectorAll('button'), function (x) {
        var on = x.getAttribute('data-v') === V.preset;
        x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on));
    });
    var c = $('hist_custom');
    if (c) c.style.display = V.preset === 'custom' ? 'flex' : 'none';
    var hasModbus = !!(G.WTS_calcRegistry && G.WTS_calcRegistry.modbus) || !!(hasDoc() && document.querySelector && document.querySelector('.nav-btn[data-p="modbus"]'));
    ['hist_modbus_btn', 'hist_modbus_btn2'].forEach(function (id) { var e = $(id); if (e) e.style.display = hasModbus ? '' : 'none'; });
}
function goModbus() {
    var b = hasDoc() && document.querySelector ? document.querySelector('.nav-btn[data-p="modbus"]') : null;
    if (b) b.click();
}

// ── status / summary / tag table ──
function refreshStatus() {
    return stats().then(function (s) {
        if (!pageMounted()) return s;
        var lib = s.engine === 'opfs' ? s.lib.sqlite : s.engine === 'sqljs' ? s.lib.sqljs : null, st = $('hist_status');
        if (st) {
            st.innerHTML = '<span class="hist-badge">' + esc(s.label) + '</span> ' +
                (lib ? esc(lib.name) + (lib.vfs ? ' · VFS ' + esc(lib.vfs) : '') + ' · ' + (lib.verified ? 'SHA-384 verified' : 'bundled copy (not hash-checked)') + ' · ' : '') +
                fmtCount(s.samples) + ' samples · ' + s.tags + ' tags' + (s.buffer ? ' · ' + fmtCount(s.buffer) + ' waiting to be written' : '');
        }
        var warn = [];
        if (s.spoolFor) warn.push('&#9888; The ' + esc(ENGINE_LABEL[s.spoolFor]) + ' store is not available in this session (' + esc(s.reasons[0] || 'unavailable') +
            '). New samples go to IndexedDB and are merged into it automatically next time it opens.');
        else if (s.reasons.length && s.engine !== 'opfs' && s.enginePref === 'auto') warn.push('&#9888; Using ' + esc(s.label) + ' — ' + esc(s.reasons.join('; ')) + '.');
        if (s.engine === 'memory') warn.push('&#9888; Memory only: the data is lost when the page closes. Export a backup to keep it.');
        s.notes.forEach(function (n) { warn.push('&#9432; ' + esc(n)); });
        if (s.lastError) warn.push('&#10007; Last write failed: ' + esc(s.lastError));
        var bn = $('hist_banner');
        if (bn) { bn.innerHTML = warn.join('<br>'); bn.style.display = warn.length ? '' : 'none'; }
        var R = s.retention, rr = function (l, v) { return '<div class="rrow"><span class="rl">' + esc(l) + '</span><span class="rv">' + esc(v) + '</span></div>'; };
        var use = s.storage || {};
        var sm = $('hist_summary');
        if (sm) sm.innerHTML =
            rr('Storage engine', s.label + (s.home && s.home !== s.engine ? ' (home: ' + ENGINE_LABEL[s.home] + ')' : '')) +
            rr('Library', lib ? lib.name + ' — ' + (lib.verified ? 'SHA-384 verified' : 'bundled copy') : (s.engine === 'idb' ? 'none (IndexedDB)' : s.engine === 'memory' ? 'none' : '—')) +
            rr('Raw samples', fmtCount(s.samples)) + rr('Downsampled 1-min rows', fmtCount(s.rollups)) + rr('Tags', fmtCount(s.tags)) +
            rr('First sample', s.first ? fmtLocal(s.first) : '—') + rr('Last sample', s.last ? fmtLocal(s.last) : '—') +
            rr('Database file size', s.dbBytes !== null ? fmtBytes(s.dbBytes) : '—') +
            rr('Site storage used / quota', use.usage !== null && use.usage !== undefined ? fmtBytes(use.usage) + ' / ' + fmtBytes(use.quota) : 'not reported by this browser') +
            rr('Persistent storage', use.persisted === true ? 'granted' : use.persisted === false ? 'not granted (the browser may evict)' : 'not reported') +
            rr('Retention', (R.days ? R.days + ' days' : 'forever') + '; raw kept ' + (R.downsampleAfterDays ? R.downsampleAfterDays + ' days, then 1-min rollups' : 'until deleted') +
                '; raw row cap ' + (s.effectiveMaxRows ? fmtCount(s.effectiveMaxRows) : 'none')) +
            rr('Last write', s.lastFlush ? fmtLocal(s.lastFlush) + ' (' + fmtCount(s.written) + ' samples written this session)' : '—');
        var setIf = function (sel, v) { var el = pageEl(sel); if (el && (!hasDoc() || document.activeElement !== el)) el.value = String(v); };
        setIf('[data-h="days"]', R.days); setIf('[data-h="dsdays"]', R.downsampleAfterDays); setIf('[data-h="maxrows"]', R.maxRows); setIf('[data-h="engine"]', s.enginePref);
        updateButtons();
        return s;
    });
}
function refreshTags() {
    return listTags().then(function (list) {
        V.tagList = list;
        var recorded = list.filter(function (x) { return x.count > 0 || x.rollups > 0 || x.last !== null; }).map(function (x) { return x.tag; });
        if (V.tags === null) {
            var pref = recorded.filter(function (n) { return !/^DEMO\./.test(n); });
            V.tags = (pref.length ? pref : recorded).slice(0, 4);
        }
        V.tags = V.tags.filter(function (n) { return recorded.indexOf(n) >= 0 || list.some(function (x) { return x.tag === n; }); }).slice(0, MAX_TREND_TAGS);
        V.tags.forEach(assignSlot);
        if (!pageMounted()) return list;
        var pick = $('hist_tagpick');
        if (pick) {
            pick.innerHTML = recorded.length ? recorded.map(function (n) {
                var on = V.tags.indexOf(n) >= 0, x = list.filter(function (y) { return y.tag === n; })[0] || {};
                return '<button type="button" class="hist-chip' + (on ? ' on' : '') + '" data-tag="' + esc(n) + '" aria-pressed="' + on + '">' +
                    '<span class="hist-sw" style="background:' + (on ? colorOf(n) : 'transparent') + ';border:1px solid ' + (on ? colorOf(n) : 'var(--border-light)') + '"></span>' +
                    esc(n) + (x.unit ? ' <span style="color:var(--text3)">' + esc(x.unit) + '</span>' : '') + '</button>';
            }).join('') : '<span class="hist-muted" style="margin:0">No data recorded yet — start Modbus polling, tick “Log form data”, or add demo data.</span>';
        }
        renderTagTable(list);
        saveView();
        return list;
    });
}
function renderTagTable(list) {
    var w = $('hist_tags_wrap');
    if (!w) return;
    if (!list.length) { w.innerHTML = '<div class="hist-muted">No tags yet.</div>'; return; }
    var sym = { logging: ['&#9679;', 'q-good'], stale: ['&#9888;', 'q-stale'], bad: ['&#10007;', 'q-bad'], idle: ['&#9675;', 'q-idle'], nodata: ['&#9675;', 'q-idle'], disabled: ['&#8856;', 'q-idle'] };
    w.innerHTML = '<table class="dtable" id="hist_tags_table"><thead><tr><th>Tag</th><th>Device</th><th>Unit</th><th>Samples</th><th>Last sample</th><th>Last value</th><th>Quality</th><th>Status</th></tr></thead><tbody>' +
        list.map(function (x) {
            var s = sym[x.status.code] || sym.idle;
            return '<tr><td>' + esc(x.tag) + '</td><td>' + esc(x.device || '') + '</td><td>' + esc(x.unit || '') + '</td><td>' + fmtCount(x.count + x.rollups) + '</td>' +
                '<td>' + esc(x.last !== null ? fmtLocal(x.last) : '—') + '</td><td>' + esc(fmtVal(x.lastValue)) + '</td>' +
                '<td class="' + (x.lastQuality === 'good' ? 'q-good' : x.lastQuality === 'stale' ? 'q-stale' : x.lastQuality === 'bad' ? 'q-bad' : '') + '">' + esc(x.lastQuality || '—') + '</td>' +
                '<td class="' + s[1] + '">' + s[0] + ' ' + esc(x.status.label) + '</td></tr>';
        }).join('') + '</tbody></table>';
}
function refreshAll() {
    if (!pageMounted()) return Promise.resolve();
    return ensureStore().then(function () { return refreshStatus(); }).then(function () { return refreshTags(); }).then(function () {
        if (V.live) { var span = (V.to - V.from) || presetMs(V.preset); V.to = Date.now(); V.from = V.to - span; }
        scheduleTrend(0); scheduleTable(0);
    }).catch(function (e) { var bn = $('hist_banner'); if (bn) { bn.innerHTML = '&#10007; ' + esc(errMsg(e)); bn.style.display = ''; } });
}

// ── trend ──
function scheduleTrend(ms) {
    if (V.fetchTimer !== null) clearTimeout(V.fetchTimer);
    V.fetchTimer = setTimeout(function () { V.fetchTimer = null; fetchTrend(); }, ms || 0);
}
function plotPx() { var g = V.geo; return g ? Math.max(100, Math.round(g.plot.w)) : 600; }
function fetchTrend() {
    if (!pageMounted()) return Promise.resolve();
    var seq = ++V.seq, tags = (V.tags || []).slice();
    if (!tags.length) { V.data = { from: V.from, to: V.to, series: [] }; drawTrend(); return Promise.resolve(); }
    return trendData({ tags: tags, from: V.from, to: V.to, px: plotPx(), agg: V.agg }).then(function (d) {
        if (seq !== V.seq || !pageMounted()) return;
        V.data = d;
        var info = $('hist_trend_info');
        if (info) {
            var modes = uniq(d.series.map(function (s) { return s.mode === 'raw' ? (s.decimated ? 'raw, LTTB-decimated' : 'raw') : s.mode + ' per ' + bucketLabel(s.bucketMs); }));
            info.textContent = fmtLocal(V.from) + ' → ' + fmtLocal(V.to) + ' · ' + modes.join(', ');
        }
        drawTrend();
    }).catch(function (e) { var info = $('hist_trend_info'); if (info) info.textContent = '✗ ' + errMsg(e); });
}
function requestDraw() {
    if (V.raf !== null) return;
    if (typeof G.requestAnimationFrame === 'function') V.raf = G.requestAnimationFrame(function () { V.raf = null; drawTrend(); });
    else drawTrend();
}
function cvSize(cv) {
    var dpr = Math.max(1, Math.min(3, G.devicePixelRatio || 1));
    // The canvas is width:100% of .chart-wrap's content box (6-px padding each side).
    var pw = cv.parentNode && cv.parentNode.clientWidth ? cv.parentNode.clientWidth - 12 : 0;
    var w = Math.max(220, Math.round(pw > 0 ? pw : (cv.clientWidth || 600)));
    var narrow = w < 560, h = narrow ? 260 : 340;
    if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
    if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
    return { w: w, h: h, dpr: dpr, narrow: narrow };
}
function trendSeries() {
    var d = V.data;
    if (!d) return [];
    return d.series.filter(function (s) { return (V.tags || []).indexOf(s.tag) >= 0; });
}
function geometry(series, sz) {
    var units = [];
    series.forEach(function (s) { var u = s.unit || '(no unit)'; if (units.indexOf(u) < 0) units.push(u); });
    if (!units.length) units.push('');
    var AW = sz.narrow ? 44 : 56, top = 20, bottom = 24, gap = 16, lanes = [], plot;
    if (V.layout === 'overlay') {
        var nL = Math.ceil(units.length / 2), nR = Math.floor(units.length / 2), x0 = 6 + nL * AW, x1 = sz.w - 8 - nR * AW;
        plot = { x: x0, y: top, w: Math.max(40, x1 - x0), h: sz.h - top - bottom };
        units.forEach(function (u, i) {
            var left = i % 2 === 0, k = Math.floor(i / 2);
            lanes.push({ unit: u, y0: plot.y, y1: plot.y + plot.h, side: left ? 'L' : 'R', axisX: left ? x0 - k * AW : x1 + k * AW });
        });
    } else {
        var xs = 6 + AW;
        plot = { x: xs, y: top, w: Math.max(40, sz.w - xs - 12), h: sz.h - top - bottom };
        var n = units.length, lh = (plot.h - gap * (n - 1)) / n;
        units.forEach(function (u, i) { var y0 = plot.y + i * (lh + gap); lanes.push({ unit: u, y0: y0, y1: y0 + lh, side: 'L', axisX: xs }); });
    }
    return { plot: plot, lanes: lanes, sz: sz };
}
function laneOf(g, s) { var u = s.unit || '(no unit)'; for (var i = 0; i < g.lanes.length; i++) if (g.lanes[i].unit === u) return g.lanes[i]; return g.lanes[0]; }
function laneScale(g, lane, series, from, to) {
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) {
        if (laneOf(g, s) !== lane) return;
        for (var i = 0; i < s.t.length; i++) {
            if (s.t[i] < from || s.t[i] > to) continue;
            [s.v[i], s.min ? s.min[i] : null, s.max ? s.max[i] : null].forEach(function (x) { if (x !== null && x !== undefined && isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } });
        }
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    var tk = niceTicks(lo, hi, Math.max(2, Math.min(6, Math.floor((lane.y1 - lane.y0) / 26))));
    lane.lo = tk.lo; lane.hi = tk.hi; lane.ticks = tk.ticks; lane.step = tk.step;
    lane.toY = function (v) { return lane.y1 - (v - lane.lo) / ((lane.hi - lane.lo) || 1) * (lane.y1 - lane.y0); };
}
function fmtTick(v, step) {
    var d = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log(step) / Math.LN10));
    var a = Math.abs(v);
    if (a >= 1e6 || (a > 0 && a < 1e-4)) return v.toExponential(1);
    return v.toFixed(d);
}
function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
function drawSeries(ctx, g, s, col, from, to) {
    var lane = laneOf(g, s), n = s.t.length;
    if (!lane || !n) return;
    var P = g.plot, span = to - from;
    var X = function (i) { return P.x + (s.t[i] - from) / span * P.w; }, Y = function (v) { return lane.toY(v); };
    var ok = function (i) { var v = s.v[i]; return v !== null && v !== undefined && isFinite(v) && s.q[i] !== 2; };
    var dts = [], stride = Math.max(1, Math.floor(n / 400));
    for (var i0 = stride; i0 < n; i0 += stride) dts.push(s.t[i0] - s.t[i0 - stride]);
    var gapT = s.bucketMs ? s.bucketMs * 1.5 + 1 : Math.max(median(dts) / stride * 5, 1);
    if (s.decimated) gapT = Math.max(gapT, span / 40);
    // min–max envelope of bucket statistics
    if (s.min && s.max && (V.agg === 'auto' || V.agg === 'avg')) {
        ctx.fillStyle = hexA(col, 0.16);
        var a = 0;
        while (a < n) {
            if (!ok(a) || s.min[a] === null) { a++; continue; }
            var b = a;
            while (b + 1 < n && ok(b + 1) && s.min[b + 1] !== null && s.t[b + 1] - s.t[b] <= gapT) b++;
            ctx.beginPath();
            for (var k = a; k <= b; k++) { if (k === a) ctx.moveTo(X(k), Y(s.max[k])); else ctx.lineTo(X(k), Y(s.max[k])); }
            for (k = b; k >= a; k--) ctx.lineTo(X(k), Y(s.min[k]));
            ctx.closePath(); ctx.fill();
            a = b + 1;
        }
    }
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ['solid', 'dashed'].forEach(function (want) {
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash(want === 'dashed' ? [4, 4] : []);
        ctx.beginPath();
        var pen = false;
        for (var i = 1; i < n; i++) {
            var seg = ok(i - 1) && ok(i) && (s.t[i] - s.t[i - 1]) <= gapT;
            var st = seg && (s.q[i - 1] === 1 || s.q[i] === 1) ? 'dashed' : 'solid';
            if (seg && st === want) { if (!pen) { ctx.moveTo(X(i - 1), Y(s.v[i - 1])); pen = true; } ctx.lineTo(X(i), Y(s.v[i])); }
            else pen = false;
        }
        ctx.stroke();
    });
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    // points: every point when sparse, else only isolated ones; bad / no-value ticks on the lane floor
    var sparse = n < P.w / 10;
    ctx.fillStyle = col;
    for (var j = 0; j < n; j++) {
        if (!ok(j)) { continue; }
        var iso = !((j > 0 && ok(j - 1) && s.t[j] - s.t[j - 1] <= gapT) || (j < n - 1 && ok(j + 1) && s.t[j + 1] - s.t[j] <= gapT));
        if (sparse || iso) { ctx.beginPath(); ctx.arc(X(j), Y(s.v[j]), 3, 0, 2 * Math.PI); ctx.fill(); }
    }
    ctx.fillStyle = INK.bad;
    for (var m = 0; m < n; m++) if (!ok(m) && s.t[m] >= from && s.t[m] <= to) ctx.fillRect(X(m) - 1, lane.y1 - 5, 2, 5);
}
function nearest(ts, t) {
    if (!ts.length) return -1;
    var lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (ts[m] < t) lo = m; else hi = m; }
    return Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
}
function drawTrend() {
    var cv = $('hist_cv');
    if (!cv || typeof cv.getContext !== 'function') return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    var sz = cvSize(cv), series = trendSeries(), from = V.from, to = V.to > V.from ? V.to : V.from + 1;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);
    ctx.fillStyle = INK.bg; ctx.fillRect(0, 0, sz.w, sz.h);
    var g = geometry(series, sz), P = g.plot;
    V.geo = g;
    g.fromX = function (x) { return from + (x - P.x) / P.w * (to - from); };
    g.toX = function (t) { return P.x + (t - from) / (to - from) * P.w; };
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.lineWidth = 1;
    // time grid and labels
    var tt = timeTicks(from, to, Math.max(2, Math.floor(P.w / 90)));
    ctx.strokeStyle = INK.grid; ctx.fillStyle = INK.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    tt.ticks.forEach(function (t) {
        var x = Math.round(g.toX(t)) + 0.5;
        ctx.beginPath(); g.lanes.forEach(function (l) { ctx.moveTo(x, l.y0); ctx.lineTo(x, l.y1); }); ctx.stroke();
        ctx.fillText(tickLabel(t, tt.step, to - from), x, P.y + P.h + 6);
    });
    // lanes: value grid, axis, unit
    g.lanes.forEach(function (lane, li) {
        laneScale(g, lane, series, from, to);
        ctx.textBaseline = 'middle'; ctx.textAlign = lane.side === 'L' ? 'right' : 'left';
        lane.ticks.forEach(function (v) {
            var y = Math.round(lane.toY(v)) + 0.5;
            if (y < lane.y0 - 1 || y > lane.y1 + 1) return;
            if (V.layout !== 'overlay' || li === 0) { ctx.strokeStyle = INK.grid; ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); }
            ctx.fillStyle = INK.muted;
            ctx.fillText(fmtTick(v, lane.step), lane.side === 'L' ? lane.axisX - 6 : lane.axisX + 6, y);
        });
        ctx.strokeStyle = INK.axis; ctx.beginPath(); ctx.moveTo(Math.round(lane.axisX) + 0.5, lane.y0); ctx.lineTo(Math.round(lane.axisX) + 0.5, lane.y1); ctx.stroke();
        ctx.fillStyle = INK.text2; ctx.textBaseline = 'bottom';
        ctx.textAlign = V.layout === 'overlay' ? (lane.side === 'L' ? 'right' : 'left') : 'left';
        ctx.fillText(lane.unit, V.layout === 'overlay' ? (lane.side === 'L' ? lane.axisX - 4 : lane.axisX + 4) : P.x + 4, lane.y0 - 3);
    });
    ctx.strokeStyle = INK.axis; ctx.beginPath(); ctx.moveTo(P.x, P.y + P.h + 0.5); ctx.lineTo(P.x + P.w, P.y + P.h + 0.5); ctx.stroke();
    if (typeof ctx.save === 'function') ctx.save();
    ctx.beginPath(); ctx.rect(P.x, P.y - 3, P.w, P.h + 6); if (typeof ctx.clip === 'function') ctx.clip();
    series.forEach(function (s) { drawSeries(ctx, g, s, colorOf(s.tag), from, to); });
    if (typeof ctx.restore === 'function') ctx.restore();
    var empty = !series.length || series.every(function (s) { return !s.t.some(function (t) { return t >= from && t <= to; }); });
    if (empty) {
        ctx.fillStyle = INK.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((V.tags || []).length ? 'No data in this time range' : 'Select tags to trend', P.x + P.w / 2, P.y + P.h / 2);
    }
    drawCursor(ctx, g, series);
    renderLegend(series);
    try { cv.setAttribute('aria-label', 'Historian trend of ' + series.map(function (s) { return s.tag; }).join(', ') + ' from ' + fmtLocal(from) + ' to ' + fmtLocal(to)); } catch (e) {}
}
function drawCursor(ctx, g, series) {
    var box = $('hist_cursor'), P = g.plot;
    if (V.cursorX === null || V.cursorX < P.x || V.cursorX > P.x + P.w || !series.length) { if (box) box.style.display = 'none'; return; }
    var t = g.fromX(V.cursorX), x = Math.round(V.cursorX) + 0.5, rows = [];
    ctx.strokeStyle = INK.text2;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    series.forEach(function (s) {
        var k = nearest(s.t, t);
        if (k < 0) return;
        var v = s.v[k], lane = laneOf(g, s), col = colorOf(s.tag);
        if (v !== null && v !== undefined && isFinite(v) && s.q[k] !== 2) {
            ctx.fillStyle = INK.bg; ctx.beginPath(); ctx.arc(g.toX(s.t[k]), lane.toY(v), 5, 0, 2 * Math.PI); ctx.fill();
            ctx.fillStyle = col; ctx.beginPath(); ctx.arc(g.toX(s.t[k]), lane.toY(v), 3.5, 0, 2 * Math.PI); ctx.fill();
        }
        rows.push({ tag: s.tag, unit: s.unit, v: v, q: s.q[k], t: s.t[k], col: col, roll: s.rollup ? s.rollup[k] : 0, mode: s.mode, b: s.bucketMs });
    });
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text2)">' + esc(fmtLocal(t)) + '</div>' + rows.map(function (r) {
        var val = (r.v === null || r.v === undefined || r.q === 2) ? '<span class="q-bad">&#10007; bad / no value</span>' : '<b>' + esc(fmtVal(r.v)) + '</b> ' + esc(r.unit || '');
        return '<div><span class="hist-sw" style="background:' + r.col + '"></span> ' + esc(r.tag) + ': ' + val +
            (r.q === 1 ? ' <span class="q-stale">&#9676; stale</span>' : '') + (r.roll ? ' <span style="color:var(--text3)">(1-min mean)</span>' : '') +
            (r.mode && r.mode !== 'raw' ? ' <span style="color:var(--text3)">(' + esc(r.mode) + ' ' + esc(bucketLabel(r.b)) + ')</span>' : '') + '</div>';
    }).join('');
    box.style.display = 'block';
    var w = g.sz.w, left = V.cursorX + 20;                     // box is placed in .chart-wrap (canvas at 6 px)
    if (left > w - 200) left = Math.max(4, V.cursorX - 208);
    box.style.left = Math.round(left) + 'px';
}
function renderLegend(series) {
    var el = $('hist_legend');
    if (!el) return;
    var parts = series.map(function (s) {
        var last = null;
        for (var i = s.t.length - 1; i >= 0; i--) if (s.t[i] <= V.to && s.v[i] !== null && s.q[i] !== 2) { last = s.v[i]; break; }
        return '<span><span class="hist-sw" style="background:' + colorOf(s.tag) + '"></span> <b>' + esc(s.tag) + '</b>' + (s.unit ? ' (' + esc(s.unit) + ')' : '') +
            (last !== null ? ' — ' + esc(fmtVal(last)) : '') + '</span>';
    });
    if (series.length) parts.push('<span style="color:var(--text3)">dashed = stale · red ticks = bad / no value' + (series.some(function (s) { return !!s.min; }) ? ' · band = min–max per bucket' : '') + '</span>');
    el.innerHTML = parts.join('');
}
function setView(from, to, live, keepPreset) {
    var span = Math.min(400 * DAY, Math.max(1000, to - from));
    if (to - from !== span) { var c = (from + to) / 2; from = c - span / 2; to = c + span / 2; }
    if (from < 0) { to -= from; from = 0; }
    V.from = Math.round(from); V.to = Math.round(to); V.live = !!live;
    if (!keepPreset) V.preset = live ? V.preset : 'zoom';
    updateButtons(); requestDraw(); scheduleTrend(150); scheduleTable(300); saveView();
}
function onRange(p) {
    if (p === 'custom') {
        V.preset = 'custom'; V.live = false;
        var f = pageEl('[data-h="from"]'), t = pageEl('[data-h="to"]');
        var loc = function (ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };
        if (f && !f.value) f.value = loc(V.from);
        if (t && !t.value) t.value = loc(V.to);
        updateButtons(); saveView();
        return;
    }
    V.preset = p; V.lastPreset = p;
    var now = Date.now();
    setView(now - presetMs(p), now, true, true);
}
function applyCustom() {
    var f = pageEl('[data-h="from"]'), t = pageEl('[data-h="to"]');
    var a = parseTime(f && f.value), b = parseTime(t && t.value);
    if (!isFinite(a) || !isFinite(b) || b <= a) { setMsg('hist_tbl_msg', false, 'Enter a custom range with “To” after “From”.'); return; }
    V.preset = 'custom';
    setView(a, b, false, true);
}
function zoomAt(x, f) {
    var g = V.geo;
    if (!g) return;
    var span = V.to - V.from, ns = Math.min(400 * DAY, Math.max(1000, span * f));
    if (V.live) { setView(V.to - ns, V.to, true, true); return; }            // live: keep the right edge on "now"
    var t = g.fromX(Math.min(g.plot.x + g.plot.w, Math.max(g.plot.x, x)));
    var from = t - (t - V.from) * ns / span;
    setView(from, from + ns, false);
}
function resetZoom() { onRange(V.lastPreset || '1h'); }
function localX(e, cv) {
    var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0 };
    return (isNum(e.clientX) ? e.clientX : 0) - (r.left || 0);
}
function wireCanvas(cv) {
    if (!cv || typeof cv.addEventListener !== 'function') return;
    var end = function (e) {
        delete V.ptr[e.pointerId];
        if (Object.keys(V.ptr).length < 2) V.pinch = null;
        if (!Object.keys(V.ptr).length) V.drag = null;
    };
    cv.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        V.ptr[e.pointerId] = { x: localX(e, cv) };
        try { cv.setPointerCapture(e.pointerId); } catch (x) {}
        var ids = Object.keys(V.ptr);
        if (ids.length === 1) V.drag = { x0: V.ptr[ids[0]].x, from: V.from, to: V.to, moved: false };
        else if (ids.length === 2) {
            var a = V.ptr[ids[0]].x, b = V.ptr[ids[1]].x;
            V.drag = null;
            V.pinch = { d0: Math.max(10, Math.abs(a - b)), mid0: (a + b) / 2, from: V.from, to: V.to };
        }
    });
    cv.addEventListener('pointermove', function (e) {
        var x = localX(e, cv);
        if (V.ptr[e.pointerId]) V.ptr[e.pointerId].x = x;
        var ids = Object.keys(V.ptr), g = V.geo;
        if (V.pinch && ids.length >= 2 && g) {
            var a = V.ptr[ids[0]].x, b = V.ptr[ids[1]].x, span0 = V.pinch.to - V.pinch.from;
            var ns = Math.min(400 * DAY, Math.max(1000, span0 * V.pinch.d0 / Math.max(10, Math.abs(a - b))));
            var tc = V.pinch.from + (V.pinch.mid0 - g.plot.x) / g.plot.w * span0, mid = (a + b) / 2;
            var from = tc - (mid - g.plot.x) / g.plot.w * ns;
            setView(from, from + ns, false);
            return;
        }
        if (V.drag && g) {
            var dx = x - V.drag.x0;
            if (Math.abs(dx) > 3) V.drag.moved = true;
            if (V.drag.moved) {
                var dt = -dx / g.plot.w * (V.drag.to - V.drag.from);
                setView(V.drag.from + dt, V.drag.to + dt, false);
            }
            return;
        }
        V.cursorX = x; requestDraw();
    });
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', function () { if (!V.drag && !V.pinch) { V.cursorX = null; requestDraw(); } });
    cv.addEventListener('wheel', function (e) {
        if (e.preventDefault) e.preventDefault();
        var dy = isNum(e.deltaY) ? e.deltaY : 0;
        if (e.deltaMode === 1) dy *= 16;
        zoomAt(localX(e, cv), Math.exp(Math.max(-300, Math.min(300, dy)) * 0.0015));
    }, { passive: false });
    cv.addEventListener('dblclick', resetZoom);
    cv.addEventListener('keydown', function (e) {
        var k = e.key, span = V.to - V.from, g = V.geo;
        if (k === 'ArrowLeft' || k === 'ArrowRight') { var d = (k === 'ArrowLeft' ? -0.1 : 0.1) * span; setView(V.from + d, V.to + d, false); }
        else if (k === '+' || k === '=') zoomAt(g ? g.plot.x + g.plot.w / 2 : 0, 0.8);
        else if (k === '-' || k === '_') zoomAt(g ? g.plot.x + g.plot.w / 2 : 0, 1.25);
        else if (k === '0' || k === 'Home') resetZoom();
        else return;
        if (e.preventDefault) e.preventDefault();
    });
}
function exportPNG() {
    var cv = $('hist_cv');
    if (!cv || !hasDoc()) return false;
    var sz = cvSize(cv), out = document.createElement('canvas'), dpr = sz.dpr, H = sz.h + 44;
    out.width = Math.round(sz.w * dpr); out.height = Math.round(H * dpr);
    var ctx = out.getContext && out.getContext('2d');
    if (!ctx) return false;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = INK.bg; ctx.fillRect(0, 0, sz.w, H);
    ctx.fillStyle = INK.text; ctx.font = '600 13px -apple-system, "Segoe UI", Roboto, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Historian trend — ' + fmtLocal(V.from) + ' to ' + fmtLocal(V.to), 8, 6);
    ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
    var x = 8;
    trendSeries().forEach(function (s) {
        ctx.fillStyle = colorOf(s.tag); ctx.fillRect(x, 26, 10, 10);
        ctx.fillStyle = INK.text2;
        var label = s.tag + (s.unit ? ' (' + s.unit + ')' : '');
        ctx.fillText(label, x + 14, 25);
        x += 24 + (ctx.measureText ? ctx.measureText(label).width : label.length * 6);
    });
    ctx.drawImage(cv, 0, 44, sz.w, sz.h);
    var url = out.toDataURL('image/png'), a = document.createElement('a');
    a.href = url; a.download = fileStamp('png', 'historian-trend'); a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a); a.click();
    if (a.parentNode) a.parentNode.removeChild(a);
    return true;
}
function toggleTag(tag) {
    var i = V.tags.indexOf(tag);
    if (i >= 0) { V.tags.splice(i, 1); delete V.slots[tag]; }
    else {
        if (V.tags.length >= MAX_TREND_TAGS) { setMsg('hist_tbl_msg', null, 'Up to ' + MAX_TREND_TAGS + ' tags on the trend — use the table or an export for more.'); return; }
        V.tags.push(tag); assignSlot(tag);
    }
    saveView();
    refreshTags().then(function () { requestDraw(); scheduleTrend(0); scheduleTable(0); });
}

// ── table ──
function scheduleTable(ms) {
    if (V.tbl.timer !== null) clearTimeout(V.tbl.timer);
    V.tbl.timer = setTimeout(function () { V.tbl.timer = null; buildTable(); }, ms || 0);
}
var TABLE_MAX = 200000;
function buildTable() {
    var wrap = $('hist_table_wrap');
    if (!wrap) return Promise.resolve();
    var seq = ++V.tbl.seq, tags = (V.tags || []).slice(), mode = V.tbl.mode;
    if (!tags.length) { wrap.innerHTML = '<div class="hist-muted">Select tags on the trend to list their values.</div>'; var pi0 = $('hist_pageinfo'); if (pi0) pi0.textContent = ''; return Promise.resolve(); }
    var o = { tags: tags, from: V.from, to: V.to, agg: mode };
    if (mode !== 'raw') o.bucketMs = V.tbl.bucket > 0 ? V.tbl.bucket : niceBucket(Math.max(1, V.to - V.from) / 500);
    return query(o).then(function (res) {
        if (seq !== V.tbl.seq || !$('hist_table_wrap')) return;
        var total = 0;
        res.series.forEach(function (s) { total += s.t.length; });
        if (total > TABLE_MAX) {
            V.tbl.rows = []; V.tbl.series = res.series;
            $('hist_table_wrap').innerHTML = '<div style="color:var(--yellow)">&#9888; ' + fmtCount(total) + ' samples in this range — choose a bucketed table, a shorter range, or export the data.</div>';
            return;
        }
        var map = {}, times = [];
        res.series.forEach(function (s, k) {
            for (var i = 0; i < s.t.length; i++) {
                var t = s.t[i], r = map[t];
                if (!r) { r = map[t] = { t: t, c: new Array(tags.length) }; times.push(t); }
                r.c[k] = { v: s.v[i], q: s.q[i], roll: s.rollup ? s.rollup[i] : 0 };
            }
        });
        var rows = times.map(function (t) { return map[t]; });
        if (V.tbl.qf === 'good') {
            rows.forEach(function (r) { for (var k = 0; k < r.c.length; k++) { var c = r.c[k]; if (c && (c.q !== 0 || c.v === null)) r.c[k] = undefined; } });
            rows = rows.filter(function (r) { return r.c.some(Boolean); });
        } else if (V.tbl.qf === 'issues') rows = rows.filter(function (r) { return r.c.some(function (c) { return c && (c.q !== 0 || c.v === null); }); });
        rows.sort(function (a, b) { return V.tbl.desc ? b.t - a.t : a.t - b.t; });
        V.tbl.rows = rows; V.tbl.series = res.series; V.tbl.bucketMs = res.bucketMs;
        V.tbl.page = Math.max(0, Math.min(V.tbl.page, Math.ceil(rows.length / V.tbl.size) - 1));
        renderTablePage();
    }).catch(function (e) { var w = $('hist_table_wrap'); if (w) w.innerHTML = '<div style="color:var(--red)">&#10007; ' + esc(errMsg(e)) + '</div>'; });
}
function cellHtml(c) {
    if (!c) return '<td></td>';
    if (c.v === null || c.v === undefined || c.q === 2) return '<td class="q-bad" title="bad / no value">&#10007;</td>';
    return '<td' + (c.q === 1 ? ' class="q-stale" title="stale value"' : '') + '>' + esc(fmtVal(c.v)) + (c.q === 1 ? ' &#9676;' : '') + (c.roll ? ' &#8224;' : '') + '</td>';
}
function renderTablePage() {
    var wrap = $('hist_table_wrap');
    if (!wrap) return;
    var rows = V.tbl.rows || [], series = V.tbl.series || [], a = V.tbl.page * V.tbl.size, b = Math.min(rows.length, a + V.tbl.size);
    var h = '<table class="dtable" id="hist_table"><thead><tr><th><button type="button" class="hist-sort" id="hist_sort_btn" aria-label="Sort by time">Time ' +
        (V.tbl.desc ? '&#8595;' : '&#8593;') + '</button></th>' + series.map(function (s) { return '<th>' + esc(s.tag) + (s.unit ? ' (' + esc(s.unit) + ')' : '') + '</th>'; }).join('') + '</tr></thead><tbody>';
    for (var i = a; i < b; i++) {
        var r = rows[i], cells = '';
        for (var k = 0; k < series.length; k++) cells += cellHtml(r.c[k]);
        h += '<tr><td>' + esc(fmtLocal(r.t, V.tbl.mode === 'raw')) + '</td>' + cells + '</tr>';
    }
    if (!rows.length) h += '<tr><td colspan="' + (series.length + 1) + '">No rows in this time range.</td></tr>';
    wrap.innerHTML = h + '</tbody></table>';
    var pi = $('hist_pageinfo');
    if (pi) pi.textContent = rows.length ? 'Rows ' + fmtCount(a + 1) + '–' + fmtCount(b) + ' of ' + fmtCount(rows.length) +
        (V.tbl.mode !== 'raw' ? ' · ' + V.tbl.mode + ' per ' + bucketLabel(V.tbl.bucketMs) : '') : '';
}
function tableTSV(limit) {
    var rows = V.tbl.rows || [], series = V.tbl.series || [], n = Math.min(rows.length, limit || 50000);
    var lines = [['time_local'].concat(series.map(function (s) { return s.tag + (s.unit ? ' [' + s.unit + ']' : ''); })).join('\t')];
    for (var i = 0; i < n; i++) {
        var r = rows[i];
        lines.push([fmtLocal(r.t, true)].concat(series.map(function (s, k) { var c = r.c[k]; return c && c.v !== null && c.q !== 2 ? String(c.v) : ''; })).join('\t'));
    }
    return { text: lines.join('\n') + '\n', rows: n, total: rows.length };
}
function copyTable() {
    var x = tableTSV(50000), nav = G.navigator;
    var done = function (ok) { setMsg('hist_tbl_msg', ok, ok ? 'Copied ' + fmtCount(x.rows) + ' rows' + (x.total > x.rows ? ' (of ' + fmtCount(x.total) + ')' : '') + ' to the clipboard.' : 'The clipboard is not available here.'); };
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') return nav.clipboard.writeText(x.text).then(function () { done(true); }, function () { done(false); });
    done(false);
    return Promise.resolve();
}

// ── export / restore / settings actions ──
function val(sel) { var e = pageEl(sel); return e ? e.value : ''; }
function doExport() {
    var fmt = val('[data-h="xfmt"]') || 'csv', range = val('[data-h="xrange"]'), tagsSel = val('[data-h="xtags"]'), agg = val('[data-h="xagg"]') || 'raw';
    var o = { tags: tagsSel === 'all' ? undefined : (V.tags || []).slice(), agg: agg, skipEmpty: true };
    if (range !== 'all') { o.from = V.from; o.to = V.to; }
    if (o.tags && !o.tags.length) { setMsg('hist_io_res', false, 'No tags selected on the trend — choose “All tags” or select tags.'); return Promise.resolve(); }
    setMsg('hist_io_res', null, 'Exporting…');
    var p = fmt === 'csv' ? exportCSV(o) : fmt === 'csvwide' ? exportCSV(Object.assign(o, { layout: 'wide' })) : fmt === 'xlsx' ? exportXLSX(o)
        : exportDb({ format: fmt === 'json' ? 'json' : 'sqlite' });
    return p.then(function (r) {
        if (r && r.empty) { setMsg('hist_io_res', false, 'No samples to export' + (range !== 'all' ? ' in the time window shown' : '') + (o.tags ? ' for the selected tags' : '') + ' — nothing was downloaded.'); return; }
        setMsg('hist_io_res', true, 'Exported ' + (r.rows !== undefined ? fmtCount(r.rows) + ' rows' : fmtBytes(r.size)) + ' to ' + r.filename + '.');
    }, function (e) { setMsg('hist_io_res', false, errMsg(e)); });
}
function doImport() {
    var inp = pageEl('[data-h="file"]'), f = inp && inp.files && inp.files[0];
    if (!f) { setMsg('hist_io_res', false, 'Choose a file to restore first.'); return Promise.resolve(); }
    var mode = val('[data-h="imode"]') === 'replace' ? 'replace' : 'merge', dup = val('[data-h="idup"]') === 'overwrite' ? 'overwrite' : 'skip';
    if (mode === 'replace' && typeof G.confirm === 'function' && !G.confirm('Replace ALL historian data with the contents of ' + f.name + '? Export a backup first if you may need the current data.')) return Promise.resolve();
    setMsg('hist_io_res', null, 'Restoring ' + f.name + '…');
    return importFile(f, { mode: mode, dup: dup }).then(function (r) {
        var t = 'Restored ' + r.file + ' (' + r.format + '): ' + fmtCount(r.inserted) + ' new samples' + (r.updated ? ', ' + fmtCount(r.updated) + ' overwritten' : '') +
            (r.skipped ? ', ' + fmtCount(r.skipped) + ' already stored (kept)' : '') + (r.rollups ? ', ' + fmtCount(r.rollups) + ' 1-min rollups' : '') +
            '; ' + r.tags + ' tags (' + r.tagsCreated + ' new)' + (r.invalid ? '; ' + fmtCount(r.invalid) + ' rows skipped as invalid' : '') +
            (r.from !== null ? '; ' + fmtLocal(r.from) + ' to ' + fmtLocal(r.to) : '') + '.';
        setMsg('hist_io_res', true, t);
        if (r.olderThanRetention) {
            var el = $('hist_io_res');
            if (el) el.innerHTML += '<div style="color:var(--yellow)">&#9888; ' + fmtCount(r.olderThanRetention) + ' restored samples are older than the retention period and will be deleted at the next retention run — raise “Keep data for” first to keep them.</div>';
        }
        if (inp) try { inp.value = ''; } catch (e) {}
        return refreshAll();
    }, function (e) { setMsg('hist_io_res', false, errMsg(e)); });
}
function applyRetention() {
    var o = { days: val('[data-h="days"]'), downsampleAfterDays: val('[data-h="dsdays"]'), maxRows: val('[data-h="maxrows"]') };
    return setRetention(o).then(function (r) {
        var x = r.result || {};
        setMsg('hist_set_msg', true, 'Retention saved. This run: ' + fmtCount(x.deleted + x.deletedRollups) + ' old rows deleted, ' + fmtCount(x.rolledUp + x.capped) + ' raw samples downsampled or capped.');
        return refreshAll();
    }, function (e) { setMsg('hist_set_msg', false, errMsg(e)); });
}
function doSwitchEngine() {
    var to = val('[data-h="engine"]') || 'auto';
    if (to !== 'auto' && to !== E.engine && typeof G.confirm === 'function' && !G.confirm('Move all historian data from ' + ENGINE_LABEL[E.engine] + ' to ' + ENGINE_LABEL[to] + '?')) return Promise.resolve();
    setMsg('hist_set_msg', null, 'Switching the storage engine…');
    return switchEngine(to).then(function (r) {
        setMsg('hist_set_msg', true, to === 'auto' ? 'Engine choice set to automatic (current: ' + ENGINE_LABEL[r.engine] + ').' :
            'Now using ' + ENGINE_LABEL[r.engine] + (r.moved ? '; moved ' + fmtCount(r.moved) + ' samples and ' + fmtCount(r.rollups) + ' rollups.' : '.'));
        return refreshAll();
    }, function (e) { setMsg('hist_set_msg', false, 'Could not switch: ' + errMsg(e)); });
}
function requestPersist() {
    var st = G.navigator && G.navigator.storage;
    if (!st || typeof st.persist !== 'function') { setMsg('hist_set_msg', false, 'This browser does not offer persistent storage.'); return Promise.resolve(false); }
    return st.persist().then(function (ok) {
        setMsg('hist_set_msg', ok, ok ? 'Persistent storage granted — the browser will not clear this data under storage pressure.' : 'The browser declined persistent storage (it may grant it later, e.g. after the site is installed or bookmarked).');
        refreshStatus();
        return ok;
    }, function (e) { setMsg('hist_set_msg', false, errMsg(e)); return false; });
}
function doPurge(all) {
    var before = all ? null : parseTime(val('[data-h="pbefore"]')), which = val('[data-h="ptags"]');
    if (!all && !isFinite(before)) { setMsg('hist_set_msg', false, 'Enter the “Purge data older than” date first.'); return Promise.resolve(); }
    var tags = all || which === 'all' ? undefined : (V.tags || []).slice();
    if (!all && tags && !tags.length) { setMsg('hist_set_msg', false, 'No tags selected on the trend.'); return Promise.resolve(); }
    var q = all ? 'Delete ALL historian data (every tag, sample and rollup)? This cannot be undone.' :
        'Delete ' + (tags ? tags.length + ' selected tag(s)' : 'all tags') + ' data older than ' + fmtLocal(before) + '?';
    if (typeof G.confirm === 'function' && !G.confirm(q)) return Promise.resolve();
    return purge(all ? { all: true } : { before: before, tags: tags }).then(function (r) {
        setMsg('hist_set_msg', true, 'Deleted ' + fmtCount(r.samples) + ' samples and ' + fmtCount(r.rollups) + ' rollups.');
        return refreshAll();
    }, function (e) { setMsg('hist_set_msg', false, errMsg(e)); });
}
function wire(root) {
    root.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!b || !root.contains(b)) return;
        var sg = b.parentNode && b.parentNode.getAttribute ? b.parentNode.getAttribute('data-seg') : null;
        if (sg) { onRange(b.getAttribute('data-v')); return; }
        if (b.hasAttribute('data-tag')) { toggleTag(b.getAttribute('data-tag')); return; }
        switch (b.id) {
            case 'hist_modbus_btn': case 'hist_modbus_btn2': goModbus(); break;
            case 'hist_demo_btn': if (DEMOLIVE.timer !== null) demoStop(); else { demoStart(); if (V.tags && !V.tags.length) V.tags = null; } break;
            case 'hist_demohist_btn': b.disabled = true; demoHistory(24, 10000).then(function (n) { b.disabled = false; if (V.tags && !V.tags.length) V.tags = null; setMsg('hist_set_msg', true, 'Added ' + fmtCount(n) + ' demo samples (24 h at 10 s, tags DEMO.*).'); return refreshAll(); }, function (er) { b.disabled = false; setMsg('hist_set_msg', false, errMsg(er)); }); break;
            case 'hist_refresh_btn': G.calcHistorian(); break;
            case 'hist_live_btn': if (V.live) { V.live = false; updateButtons(); saveView(); } else { var sp = V.to - V.from; var n = Date.now(); setView(n - sp, n, true, true); } break;
            case 'hist_custom_apply': applyCustom(); break;
            case 'hist_reset_btn': resetZoom(); break;
            case 'hist_png_btn': exportPNG(); break;
            case 'hist_prev_btn': if (V.tbl.page > 0) { V.tbl.page--; renderTablePage(); } break;
            case 'hist_next_btn': if ((V.tbl.page + 1) * V.tbl.size < (V.tbl.rows || []).length) { V.tbl.page++; renderTablePage(); } break;
            case 'hist_sort_btn': V.tbl.desc = !V.tbl.desc; (V.tbl.rows || []).reverse(); V.tbl.page = 0; renderTablePage(); saveView(); break;
            case 'hist_copy_btn': copyTable(); break;
            case 'hist_export_btn': doExport(); break;
            case 'hist_import_btn': doImport(); break;
            case 'hist_ret_btn': applyRetention(); break;
            case 'hist_engine_btn': doSwitchEngine(); break;
            case 'hist_persist_btn': requestPersist(); break;
            case 'hist_purge_btn': doPurge(false); break;
            case 'hist_clear_btn': doPurge(true); break;
            default: break;
        }
    });
    root.addEventListener('change', function (e) {
        var el = e.target, h = el && el.getAttribute ? el.getAttribute('data-h') : null;
        if (!h) return;
        if (h === 'logform') setFormLogging(!!el.checked);
        else if (h === 'agg') { V.agg = el.value; saveView(); scheduleTrend(0); }
        else if (h === 'layout') { V.layout = el.value === 'overlay' ? 'overlay' : 'stacked'; saveView(); requestDraw(); }
        else if (h === 'tmode') { V.tbl.mode = AGGS.indexOf(el.value) >= 0 ? el.value : 'raw'; V.tbl.page = 0; saveView(); scheduleTable(0); }
        else if (h === 'tbucket') { V.tbl.bucket = Math.max(0, +el.value || 0); V.tbl.page = 0; saveView(); scheduleTable(0); }
        else if (h === 'tq') { V.tbl.qf = el.value; V.tbl.page = 0; saveView(); scheduleTable(0); }
        else if (h === 'tps') { V.tbl.size = [50, 100, 500].indexOf(+el.value) >= 0 ? +el.value : 100; V.tbl.page = 0; saveView(); renderTablePage(); }
    });
    wireCanvas($('hist_cv'));
}
function render(body) {
    ensureCss();
    loadView();
    body.innerHTML = pageHtml();
    var root = $('hist_root');
    if (root) wire(root);
    if (V.live || !(V.to > V.from)) { var now = Date.now(); V.to = now; V.from = now - presetMs(V.preset === 'custom' || V.preset === 'zoom' ? V.lastPreset : V.preset); }
    updateButtons();
    drawTrend();
    G.calcHistorian();
}
G.calcHistorian = function () { return refreshAll(); };

// ─── §10 events, API, registry ───────────────────────────────────────
function onHide() {
    if (E.dirty) persistNow(true);                                     // what is written already, at once
    if (E.buf.length) flush().then(function () { return E.dirty ? persistNow(true) : null; }).catch(noop);   // then the last buffered samples
}
function onUpdated() {
    if (!pageMounted() || V.liveTimer !== null) return;
    V.liveTimer = setTimeout(function () {                   // at most one refresh a second, only while data arrives
        V.liveTimer = null;
        if (!pageMounted()) return;
        if (V.live) { var span = V.to - V.from; V.to = Date.now(); V.from = V.to - span; }
        fetchTrend(); refreshTags(); refreshStatus().catch(noop);
        scheduleTable(0);
    }, 1000);
}
if (hasDoc() && typeof document.addEventListener === 'function') {
    document.addEventListener('wts:modbus-samples', function (e) { var d = e && e.detail; if (d) record(d); });
    document.addEventListener('wts:calc', function (e) { if (FORM.on) record(formSamples(e && e.detail, Date.now())); });
    document.addEventListener('wts:historian-updated', onUpdated);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') onHide(); });
    document.addEventListener('app-backgrounded', onHide);
}
if (typeof G.addEventListener === 'function') {
    G.addEventListener('pagehide', onHide);
    G.addEventListener('resize', function () { if (pageMounted()) requestDraw(); });
}

var API = {
    version: '1.0.0',
    record: record,
    flush: function () { return flush(); },
    ready: function () { return ensureStore().then(status); },
    query: query, listTags: listTags, stats: stats, status: status,
    exportCSV: exportCSV, exportXLSX: exportXLSX, exportDb: exportDb, importFile: importFile,
    purge: purge, setRetention: setRetention,
    getRetention: function () { var s = getSettings(); return { days: s.days, maxRows: s.maxRows, downsampleAfterDays: s.downsampleAfterDays }; },
    engine: function () { return { engine: E.engine, label: E.engine ? ENGINE_LABEL[E.engine] : null, home: E.home, spoolFor: E.spoolFor, preference: getSettings().engine, reasons: E.reasons.slice() }; },
    switchEngine: switchEngine,
    persist: function () { return persistNow(); },
    demo: { start: demoStart, stop: demoStop, history: demoHistory, running: function () { return DEMOLIVE.timer !== null; } },
    logForm: setFormLogging,
    util: { aggregate: aggArrays, mergePartials: mergePartials, lttb: lttbIdx, decimate: decimate, niceBucket: niceBucket, parseDelimited: parseDelimited,
        rowsToImport: rowsToImport, parseTime: parseTime, csvLine: csvLine, qCode: qCode, normSample: normSample, formSamples: formSamples, demoBatch: demoBatch, lcg: lcg },
    LIBS: LIBS, SHA384: HIST_SHA384, ENGINES: ENGINES.slice(), ENGINE_LABEL: ENGINE_LABEL, ROLLUP_MS: ROLLUP_MS,
    _test: T,
    _internal: { E: E, V: V, workerSource: workerSource, HistSqlStore: HistSqlStore, histSqlJsAdapter: histSqlJsAdapter, histWasmAdapter: histWasmAdapter,
        histWorkerMain: histWorkerMain, IdbStore: IdbStore, MemStore: MemStore, WorkerStore: WorkerStore, asyncStore: asyncStore, copyStore: copyStore,
        fetchVerified: fetchVerified, loadSqlJs: loadSqlJs, trendData: trendData, drawTrend: drawTrend, buildTable: buildTable, fetchTrend: fetchTrend,
        refreshAll: refreshAll, runRetention: function () { return lock(runRetention); }, tableTSV: tableTSV, exportPNG: exportPNG, setView: setView, zoomAt: zoomAt }
};
var prevApi = G.WTS_historian;
G.WTS_historian = API;
if (prevApi && Array.isArray(prevApi._queue) && prevApi._queue.length) record(prevApi._queue);   // samples an early caller queued before this file loaded
publishState();

G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.historian = {
    key: 'historian', title: 'Historian', navTitle: 'Historian',
    sub: 'Record, trend, tabulate and export tag data — SQLite in the browser',
    group: 'Mini WellOS', icon: '&#128200;', badge: 'WellOS', bc: 'dc-b-blue',
    desc: 'Trends and tables of Modbus, form and simulator data with retention, CSV / Excel export and database backup / restore.',
    render: render
};
})();

// === SELF-TEST ===
(function () {
    if (typeof window === 'undefined' || !window.WTS_historian) return;
    var U = window.WTS_historian.util;
    // Buckets of 60 s: [0, 60 s) has good 1, 3 and a stale 5 → mean of the good ones = 2.
    var p = U.aggregate([1000, 2000, 3000, 61000], [1, 3, 5, 7], [0, 0, 1, 0], 60000);
    if (p.length !== 2 || p[0].avg !== 2 || p[0].q !== 0 || p[1].last !== 7) throw new Error('historian self-test: aggregate');
    var k = U.lttb([0, 1, 2, 3, 4], [0, 5, 0, 0, 0], 0, 5, 3);
    if (k.join() !== '0,1,4') throw new Error('historian self-test: lttb');
})();
