// =============================================================================
// Build-up Surveillance — 49-calc-buildup-data.js  (Round 9, WP2)
// helper module: does not add a page to window.WTS_calcRegistry
// -----------------------------------------------------------------------------
// window.WTS_buildup.data — the data layer of the Build-up Surveillance page
// (plan docs/BUILDUP-SURVEILLANCE-PLAN.md §3.6, §4.1–§4.5):
//   import   sniff(text), parseJob(text, opts) / parse(text, opts) (chunked,
//            count-sliced), fromHistorian(o), fromPRiSM(o), parseAllocation()
//   quality  qc(record, opts)                                     (M§A1)
//   events   detect(record, qc, opts), refineClosing(record, ev, qc),
//            classify(events, record, days, opts)          (M§A2–M§A5)
//   days     resolveZone(z), dayBounds(date, day), dayOf(ms, day)   (§4.4)
//   rates    rates(record, events, rows, opts), rateTable(rows, opts),
//            historySteps(rh, origin_ms, upTo_ms)          (M§A6, M§A7)
//   misc     depthShift(depth), recordHash(t, p), scan(record, alloc, opts)
//
// Units: field units throughout. Record / allocation times are epoch ms UTC;
// pressures psia at the gauge; rates STB/d (oil), Mscf/d (gas), bbl/d (water
// injection or the total reservoir basis). Production days are 'YYYY-MM-DD'.
//
// Rules (§3.0): pure functions — no DOM, no storage, no timers, no events and no
// random numbers. Every output number is finite or null; warnings are
// {code, level, text, ev}. Time-zone conversions use Intl with a resolved IANA
// name (never the process time zone). Work is sliced by count, never by clock:
// a parse step reads DEFAULTS.parse.chunkLines lines.
//
// The record hash (WP2 definition, §3.11): hash16 over "n|t0|tN|digest", where
// digest is a 32-bit FNV-1a pass over every sample (the time step in ms and the
// pressure in units of 0.001 psi). It is the convention the WP0 fixture uses.
//
// Detection beyond the §4.3 rise/fall rules (v3.3 integration): an event ends at a
// sharper rise inside it (another closing: END_AT_RISE / END_AT_CLOSING) or at a deep
// slow fall; in daily mode the allocation is read at detection — a rise the day
// volumes explain as a modest day-rate step opens no event (missed.rateSteps), and an
// event no day confirms ends at the first whole day of production ≥ 24 h after its
// closing (END_ALLOC). A precursor of a closing is gated by the ratio of the two
// responses (fhatMethod 'derivRatio'). The inputs are never written (copies).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    // Closure aliases: a global lookup per call is slow inside vm contexts (the test harness); hot loops use these.
    var mAbs = Math.abs, mCeil = Math.ceil, mExp = Math.exp, mFloor = Math.floor, mImul = Math.imul, mLog = Math.log, mLog10 = Math.log10,
        mMax = Math.max, mMin = Math.min, mRound = Math.round, mSqrt = Math.sqrt, mPow = Math.pow, dateUTC = Date.UTC, _isFin = isFinite, INF = 1 / 0;
    var BU = G.WTS_buildup = G.WTS_buildup || {};
    var D = BU.data = BU.data || {};

    var SEC = 1000, MIN = 60000, HOUR = 3600000, DAY = 86400000;
    var LN10 = Math.LN10;

    // Lines per parse step. Measured on the reference machine (WP2 merge note):
    // ~0.67 µs per row for elapsed-hours rows and ~0.96 µs per row for naive ISO
    // rows in an IANA zone, so 10,000 lines cost ≤ 10 ms (≤ 50 ms budget).
    var CHUNK_LINES = 10000;
    // Samples per detection scan unit (§4.8): one unit scans the windows of about 50,000 samples.
    var UNIT_SAMPLES = 50000;

    function deepFreeze(o) {
        if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
        Object.freeze(o);
        Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
        return o;
    }

    D.DEFAULTS = deepFreeze({
        detect: {
            winMin: 5, riseMin: 5, riseSig: 10, persistMin: 30, multiScaleMin: 30, minDur_h: 2, gapN: 5, spike: 'off', partial: true,
            gapCloseMin: 10, gapCloseN: 5, trendMin: 30, trendN: 10, trendDtFactor: 10, trendMax: 200,
            firstSig: 4, firstMin_psi: 0.5, firstRun: 3, shutDayPersist_h: 2,
            stepSig: 6, stepMin_psi: 2, stepMin_h: 2, interventionTs: 2, interventionFrac: 0.25, tableTolMin: 10, tableTolN: 5,
            // a sharper rise inside an event (another closing) ends it: the event has run ≥ splitMin_h, and the new rise is
            // splitRatio× steeper than the steepest 30-min rise of the last hour (§4.3, end of the build-up)
            splitMin_h: 1, splitRatio: 3,
            // allocation evidence at detection (daily mode): days the event covers for ≥ allocShutMin_h hours; a day
            // confirms when half of those hours are missing from its volume. No confirming day and every whole day with at
            // most allocModest of the reference volume missing → a day-rate step, not a shut-in. An event with no
            // confirming day ends at the first whole contradicting day ≥ allocBound_h after its closing; after a
            // confirming day, at the first whole contradicting day (a reopening the pressure did not show).
            allocShutMin_h: 6, allocModest: 0.3, allocBound_h: 24
        },
        classify: { fShut: 0.95, fInterp: 0.9, fPartial: 0.1, t2Div: 1.26, t1Div: 3.16, tdmaxFactor: 3 },
        rates: {
            wcLimit: 0.05, gorFactor: 1.2, closeDayMin_h: 6, hOnMin_h: 0.5, cleanSlack_h: 0.5, flush_h: 12, refDays: 10, refEach: 3, refMin: 2,
            r3Tol: 0.15, r4Tol: 0.15, dqTol: 0.15, ignoreTol: 0.15, ignoreGap_h: 3, hoursFlag_h: 1, allocOnly: 0.85, cleanGap_h: 0.5,
            offsetScan_h: 12, offsetGain: 0.5, offsetDays: 2, condensatePct: 5, waterGE_Mscf: 7.4, prependMin_h: 720, prependFactor: 10
        },
        qc: {
            quietLate_h: 2, quietLateFrac: 0.25, quietAfter_h: 1, excludeN: 3, minSeg: 10, hampelHalf: 5, hampelSig: 6, hampelRun: 2,
            quantFrac: 0.5, rhoCorr: -0.2, tempSettle_F: 1, maxIdx: 200, gapReport_h: 2, gapMin_s: 60
        },
        zones: { gauge: { mode: 'device' }, day: { zone: { mode: 'device' }, startHour: 0 } },
        parse: { chunkLines: CHUNK_LINES, patm: 14.696, t0_ms: dateUTC(2026, 0, 1), sniffBytes: 65536, sampleRows: 20 },
        unitSamples: UNIT_SAMPLES
    });

    // Clamp ranges for the detection settings (§6.2: clamped on read).
    var DETECT_CLAMP = { winMin: [1, 60], riseMin: [0.5, 500], riseSig: [2, 50], persistMin: [5, 240], minDur_h: [0.5, 48], gapN: [2, 50] };

    // ─────────────────────────────────────────────────────────────────────
    // Small numeric helpers
    // ─────────────────────────────────────────────────────────────────────
    function isNum(v) { return typeof v === 'number' && _isFin(v); }
    function num(v, d) { return isNum(v) ? v : d; }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    function fin(v) { return isNum(v) ? v : null; }
    function W(code, level, text, ev) { return { code: code, level: level, text: String(text).slice(0, 298), ev: ev || [] }; }
    function AI() { return G.PRiSM_autoInterp || null; }

    // FNV-1a hash16, identical to PRiSM_autoInterp.hash16 (used only when file 53 is absent, e.g. a stub load).
    function _hash16(s) {
        var a = AI();
        if (a && typeof a.hash16 === 'function') return a.hash16(s);
        s = String(s == null ? '' : s);
        function f(basis) { var h = basis | 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = mImul(h, 16777619); } return h >>> 0; }
        function x8(v) { return ('0000000' + (v >>> 0).toString(16)).slice(-8); }
        return x8(f(0x811c9dc5)) + x8(f(0x050c5d1f));
    }

    // In-place selection (Hoare partition, median-of-three pivot): returns the k-th smallest of a[lo..hi].
    function _select(a, lo, hi, k) {
        while (hi > lo) {
            var mid = (lo + hi) >> 1, x = a[lo], y = a[mid], z = a[hi], pv;
            pv = (x < y) ? ((y < z) ? y : (x < z ? z : x)) : ((x < z) ? x : (y < z ? z : y));
            var i = lo, j = hi;
            while (i <= j) {
                while (a[i] < pv) i++;
                while (a[j] > pv) j--;
                if (i <= j) { var tmp = a[i]; a[i] = a[j]; a[j] = tmp; i++; j--; }
            }
            if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
        }
        return a[k];
    }
    var _scr = new Float64Array(4096);
    function _buf(n) { if (_scr.length < n) _scr = new Float64Array(mMax(n, 2 * _scr.length)); return _scr; }
    // Median of the finite values of src[from..to) (NaN skipped). NaN when there are none.
    function medianRange(src, from, to) {
        var b = _buf(mMax(1, to - from)), n = 0;
        for (var i = from; i < to; i++) { var v = src[i]; if (v === v && v !== INF && v !== -INF) b[n++] = v; }
        return _medianBuf(b, n);
    }
    function _medianBuf(b, n) {
        if (n <= 0) return NaN;
        var k = n >> 1, hi = _select(b, 0, n - 1, k);
        if (n & 1) return hi;
        var lo = -INF;
        for (var i = 0; i < k; i++) if (b[i] > lo) lo = b[i];
        return 0.5 * (lo + hi);
    }
    function median(arr) { return medianRange(arr, 0, arr.length); }
    // k-th order statistic (k = floor(q·n), clipped) of the finite values of arr.
    function quantile(arr, q) {
        var b = _buf(mMax(1, arr.length)), n = 0;
        for (var i = 0; i < arr.length; i++) { var v = arr[i]; if (isNum(v)) b[n++] = v; }
        if (!n) return NaN;
        return _select(b, 0, n - 1, mMin(n - 1, mFloor(q * n)));
    }
    function mad(arr, med) {
        if (!isNum(med)) med = median(arr);
        var b = _buf(mMax(1, arr.length)), n = 0;
        for (var i = 0; i < arr.length; i++) { var v = arr[i]; if (isNum(v)) b[n++] = mAbs(v - med); }
        return _medianBuf(b, n);
    }
    // Theil–Sen line on (x, y), at most maxN points (evenly sub-sampled). Returns {a (at x = 0), b}.
    function theilSen(x, y, maxN) {
        var n = x.length;
        if (!n) return { a: NaN, b: 0 };
        if (n === 1) return { a: y[0], b: 0 };
        var stride = mMax(1, mCeil(n / (maxN || 200))), xs = [], ys = [];
        for (var i = 0; i < n; i += stride) { xs.push(x[i]); ys.push(y[i]); }
        if (xs[xs.length - 1] !== x[n - 1]) { xs.push(x[n - 1]); ys.push(y[n - 1]); }
        var m = xs.length, sl = [];
        for (var p = 0; p < m; p++) for (var q = p + 1; q < m; q++) { var dx = xs[q] - xs[p]; if (dx !== 0) sl.push((ys[q] - ys[p]) / dx); }
        var b = sl.length ? median(sl) : 0;
        var r = new Array(m);
        for (var j = 0; j < m; j++) r[j] = ys[j] - b * xs[j];
        return { a: median(r), b: b };
    }
    function lowerBound(t, v, lo, hi) {     // first index i in [lo, hi) with t[i] >= v
        lo = lo || 0; hi = (hi == null) ? t.length : hi;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (t[mid] < v) lo = mid + 1; else hi = mid; }
        return lo;
    }
    // Linear interpolation of p at time ms (clamped to the ends).
    function pAt(t, p, ms) {
        var n = t.length; if (!n) return NaN;
        if (ms <= t[0]) return p[0];
        if (ms >= t[n - 1]) return p[n - 1];
        var i = lowerBound(t, ms);
        var t0 = t[i - 1], t1 = t[i];
        return t1 === t0 ? p[i] : p[i - 1] + (p[i] - p[i - 1]) * (ms - t0) / (t1 - t0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Dates (proleptic Gregorian, UTC arithmetic only)
    // ─────────────────────────────────────────────────────────────────────
    function pad2(v) { return v < 10 ? '0' + v : '' + v; }
    function civil(ms) {                      // 'YYYY-MM-DD' of a UTC-arithmetic ms value
        var d = new Date(ms);
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    function parseDate(s) {                   // 'YYYY-MM-DD' → {y, m, d} or null
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
        if (!m) return null;
        var y = +m[1], mo = +m[2], d = +m[3], ms = dateUTC(y, mo - 1, d);
        if (civil(ms) !== m[0]) return null;
        return { y: y, m: mo, d: d, ms: ms };
    }
    function addDays(date, n) { var p = parseDate(date); return p ? civil(p.ms + n * DAY) : null; }

    // ─────────────────────────────────────────────────────────────────────
    // Time zones (§4.4): resolved zones only; offsets from Intl with timeZone
    // ─────────────────────────────────────────────────────────────────────
    function deviceZoneName() {
        try {
            var tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
            return (typeof tz === 'string' && tz) ? tz : null;
        } catch (e) { return null; }
    }
    var _dtf = {};
    function _fmt(tz) {
        if (_dtf[tz]) return _dtf[tz];
        _dtf[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric' });
        return _dtf[tz];
    }
    function validTz(tz) { try { _fmt(tz); return true; } catch (e) { delete _dtf[tz]; return false; } }

    // z = {mode:'device'|'utc'|'fixed'|'iana', offset_h, tz} → a resolved zone (never 'device').
    function resolveZone(z) {
        z = z || { mode: 'device' };
        var mode = z.mode;
        if (mode === 'utc') return { mode: 'utc' };
        if (mode === 'fixed') return { mode: 'fixed', offset_h: clamp(num(+z.offset_h, 0), -12, 14) };
        if (mode === 'iana') {
            if (typeof z.tz === 'string' && z.tz && validTz(z.tz)) return { mode: 'iana', tz: z.tz };
            return { mode: 'utc' };
        }
        var dev = deviceZoneName();
        if (dev && validTz(dev)) return { mode: 'iana', tz: dev };
        return { mode: 'utc' };
    }
    function _zoneKey(z) { return !z ? 'utc' : z.mode === 'iana' ? z.tz : z.mode === 'fixed' ? 'fixed' + z.offset_h : 'utc'; }

    // Time-zone caches, one map per IANA zone: UTC 15-min bucket → offset, local 15-min bucket → offset. Each map is
    // dropped once it holds TZ_CACHE_MAX buckets (about 3 years of data), so a long session cannot grow it without bound.
    var _offCache = {};
    var QUARTER = 15 * MIN;                   // every real-world transition falls on a 15-min boundary
    var TZ_CACHE_MAX = 100000;
    function _zoneCache(store, tz) {
        var c = store[tz];
        if (!c || c._n >= TZ_CACHE_MAX) { c = store[tz] = Object.create(null); c._n = 0; }
        return c;
    }
    function _ianaOffsetRaw(tz, ms) {
        var parts = _fmt(tz).formatToParts(new Date(ms)), f = {};
        for (var i = 0; i < parts.length; i++) f[parts[i].type] = parts[i].value;
        var h = +f.hour; if (h === 24) h = 0;
        var local = dateUTC(+f.year, +f.month - 1, +f.day, h, +f.minute, +f.second);
        var whole = ms - (((ms % SEC) + SEC) % SEC);
        return local - whole;
    }
    // Offset (ms, local − UTC) of a resolved zone at the UTC instant ms.
    function offsetAt(zone, ms) {
        if (!zone || zone.mode === 'utc') return 0;
        if (zone.mode === 'fixed') return mRound(num(zone.offset_h, 0) * HOUR);
        if (zone.mode !== 'iana') return 0;
        var c = _zoneCache(_offCache, zone.tz);
        var key = mFloor(ms / QUARTER), v = c[key];
        if (v === undefined) { v = _ianaOffsetRaw(zone.tz, key * QUARTER); c[key] = v; c._n++; }
        return v;
    }
    // Naive local wall-clock ms (UTC arithmetic) → UTC ms. In a DST gap the later offset is used; in an
    // ambiguous hour the first occurrence (localLaterUtc gives the second one).
    function localToUtc(zone, local) {
        if (!zone || zone.mode === 'utc') return local;
        if (zone.mode === 'fixed') return local - mRound(num(zone.offset_h, 0) * HOUR);
        var o1 = offsetAt(zone, local - offsetAt(zone, local));
        var u = local - o1;
        var o2 = offsetAt(zone, u);
        if (o2 !== o1) u = local - o2;
        // ambiguous hour: prefer the earlier instant when it maps to the same wall clock
        var uE = u - HOUR;
        if (uE + offsetAt(zone, uE) === local) u = uE;
        return u;
    }
    // The second UTC instant of a naive local time that the clocks show twice (the interval repeated when they go back),
    // else NaN. The first instant is localToUtc(); the second is later by the size of the shift.
    function localLaterUtc(zone, local) {
        if (!zone || zone.mode !== 'iana') return NaN;
        var uE = localToUtc(zone, local), oE = offsetAt(zone, uE), oL = offsetAt(zone, uE + 3 * HOUR);
        if (!(oL < oE)) return NaN;
        var uL = local - oL;
        return (uL > uE && uL + offsetAt(zone, uL) === local) ? uL : NaN;
    }
    var _l2u = {};
    // Offset of the local 15-min bucket holding a naive time, cached per bucket; NaN for a bucket at or in a transition
    // (a DST gap or a repeated interval), which callers must convert one time at a time.
    function _bucketOffset(zone, local) {
        var c = _zoneCache(_l2u, zone.tz);
        var key = mFloor(local / QUARTER), v = c[key];
        if (v === undefined) {
            var a = key * QUARTER, b = a + QUARTER - 1;
            var oa = a - localToUtc(zone, a), ob = b - localToUtc(zone, b);
            v = (oa === ob && !isNum(localLaterUtc(zone, a)) && !isNum(localLaterUtc(zone, b))) ? oa : NaN;
            c[key] = v; c._n++;
        }
        return v;
    }
    // Cached version for parsing many naive times: one conversion per local 15-min bucket unless a transition is near.
    // Times in a repeated interval give the first occurrence; parseJob picks the occurrence from the row order.
    function localToUtcFast(zone, local) {
        if (!zone || zone.mode !== 'iana') return localToUtc(zone, local);
        var v = _bucketOffset(zone, local);
        return (v === v) ? local - v : localToUtc(zone, local);
    }

    // Production-day bounds: [local date at startHour, next local date at startHour), converted to UTC.
    function dayBounds(date, day) {
        day = day || {};
        var z = day.zone && day.zone.mode !== 'device' ? day.zone : resolveZone(day.zone);
        var sh = clamp(mRound(num(+day.startHour, 0)), 0, 23);
        var p = parseDate(date);
        if (!p) return null;
        var t0 = localToUtc(z, dateUTC(p.y, p.m - 1, p.d, sh));
        var t1 = localToUtc(z, dateUTC(p.y, p.m - 1, p.d + 1, sh));
        return { t0_ms: t0, t1_ms: t1, hours: (t1 - t0) / HOUR };
    }
    // The production-day label containing the UTC instant ms.
    function dayOf(ms, day) {
        day = day || {};
        var z = day.zone && day.zone.mode !== 'device' ? day.zone : resolveZone(day.zone);
        var sh = clamp(mRound(num(+day.startHour, 0)), 0, 23);
        var lab = civil(ms + offsetAt(z, ms) - sh * HOUR);
        var b = dayBounds(lab, { zone: z, startHour: sh });
        if (b && ms < b.t0_ms) lab = addDays(lab, -1);
        else if (b && ms >= b.t1_ms) lab = addDays(lab, 1);
        return lab;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Pressure units and depth
    // ─────────────────────────────────────────────────────────────────────
    var KPA = 0.1450377377, BAR = 14.50377377, MPA = 145.0377377;
    function pUnitKey(u) {
        var s = String(u || 'psia').toLowerCase().replace(/[\s()]/g, '');
        if (s === 'psig' || s === 'psi(g)') return 'psig';
        if (s === 'kpa') return 'kPa';
        if (s === 'kpag' || s === 'kpa(g)') return 'kPag';
        if (s === 'bar' || s === 'bara') return 'bar';
        if (s === 'barg' || s === 'bar(g)') return 'barg';
        if (s === 'mpa' || s === 'mpaa') return 'MPa';
        if (s === 'mpag') return 'MPag';
        return 'psia';
    }
    function toPsia(v, unit, patm) {
        switch (unit) {
            case 'psig': return v + patm;
            case 'kPa': return v * KPA;
            case 'kPag': return v * KPA + patm;
            case 'bar': return v * BAR;
            case 'barg': return v * BAR + patm;
            case 'MPa': return v * MPA;
            case 'MPag': return v * MPA + patm;
            default: return v;
        }
    }
    // psi added to the gauge pressure to reach the datum: grad·(datumTVD − gaugeTVD).
    function depthShift(depth) {
        if (!depth) return 0;
        var g = +depth.grad, a = +depth.gaugeTVD, b = +depth.datumTVD;
        if (!isNum(g) || !isNum(a) || !isNum(b)) return 0;
        return g * (b - a);
    }

    // Record hash (header): hash16 of "n|t0|tN|digest".
    function recordHash(t, p) {
        var n = t ? t.length : 0;
        if (!n) return _hash16('0||');
        var h = 0x811c9dc5;
        for (var i = 0; i < n; i++) {
            h = mImul(h ^ (i ? t[i] - t[i - 1] : 0), 16777619);
            h = mImul(h ^ mRound(p[i] * 1000), 16777619);
        }
        return _hash16(n + '|' + t[0] + '|' + t[n - 1] + '|' + (h >>> 0).toString(16));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Text import: sniff (§4.1)
    // ─────────────────────────────────────────────────────────────────────
    var RE_ISO = /^\d{4}-\d{1,2}-\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2}([.,]\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
    var RE_DMY = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})([ T]+(\d{1,2}):(\d{2})(:(\d{2})([.,]\d+)?)?\s*([AaPp][Mm])?)?$/;
    var RE_NUM = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;
    var RE_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/, RE_TIME_ONLY = /^\d{1,2}:\d{2}(:\d{2}([.,]\d+)?)?$/;

    function _lines(text, maxBytes, maxLines) {
        var s = maxBytes ? String(text).slice(0, maxBytes) : String(text);
        var arr = s.split(/\r\n|\n|\r/);
        if (maxBytes && text.length > maxBytes) arr.pop();     // drop the partial last line
        var out = [];
        for (var i = 0; i < arr.length && out.length < (maxLines || 1e9); i++) {
            var l = arr[i];
            if (!l || !l.trim()) continue;
            var tl = l.trim();
            if (tl[0] === '#' || tl.slice(0, 2) === '//') continue;
            out.push(l);
        }
        return out;
    }
    function _split(line, sep, merge) {
        var f;
        if (sep === ' ') f = line.trim().split(/\s+/);
        else f = line.split(sep);
        for (var i = 0; i < f.length; i++) f[i] = f[i].trim().replace(/^"(.*)"$/, '$1');
        if (merge && f.length >= 2 && RE_DATE_ONLY.test(f[0]) && RE_TIME_ONLY.test(f[1])) f.splice(0, 2, f[0] + ' ' + f[1]);
        return f;
    }
    function _isNumText(s) { return RE_NUM.test(s); }
    function _isTimeText(s) { return RE_ISO.test(s) || RE_DMY.test(s); }

    function sniff(text) {
        var P = D.DEFAULTS.parse;
        var lines = _lines(String(text || ''), P.sniffBytes, 200);
        var out = { sep: ',', headers: [], sample: [], cols: { t: -1, p: -1, T: -1, q: -1 }, timeFormat: 'elapsed_h', pUnitGuess: null, hasRate: false,
                    headerRow: false, mergeDT: false, dayFirst: true, tempUnit: 'F' };
        if (!lines.length) return out;
        var probe = lines.slice(0, 21);
        var seps = ['\t', ';', ','], sep = null;
        for (var s = 0; s < seps.length && !sep; s++) {
            var counts = probe.map(function (l) { return l.split(seps[s]).length - 1; });
            var c0 = counts[counts.length > 1 ? 1 : 0];
            if (c0 >= 1 && counts.filter(function (c) { return c === c0; }).length >= mCeil(0.8 * counts.length)) sep = seps[s];
        }
        if (!sep) sep = ' ';
        out.sep = sep;
        var merge = false;
        if (sep === ' ') {
            var f1 = _split(probe[probe.length > 1 ? 1 : 0], ' ', false);
            merge = f1.length >= 2 && RE_DATE_ONLY.test(f1[0]) && RE_TIME_ONLY.test(f1[1]);
        }
        out.mergeDT = merge;
        var first = _split(lines[0], sep, merge);
        var isHeader = first.some(function (f) { return f !== '' && !_isNumText(f) && !_isTimeText(f); });
        out.headerRow = isHeader;
        var headers = isHeader ? first : first.map(function (_, i) { return 'col' + (i + 1); });
        var data = (isHeader ? lines.slice(1) : lines).slice(0, P.sampleRows).map(function (l) { return _split(l, sep, merge); });
        if (isHeader && merge && data.length && headers.length === data[0].length + 1) headers.splice(0, 2, headers[0] + ' ' + headers[1]);
        out.headers = headers;
        out.sample = data;
        var cols = out.cols, hl = headers.map(function (h) { return String(h).toLowerCase(); });
        function find(re, not) { for (var i = 0; i < hl.length; i++) if (re.test(hl[i]) && !(not && not.test(hl[i])) && [cols.t, cols.p, cols.T, cols.q].indexOf(i) === -1) return i; return -1; }
        if (isHeader) {
            cols.t = find(/time|date|elapsed|^t$|^t[ _(]|stamp|hour|^hrs?$/);
            cols.T = find(/temp|degf|degc|°[fc]|^t[fc]?$/, /time|stamp/);
            cols.p = find(/press|^p$|^p[ _(]|psi|bar|kpa|mpa|bhp|pdg|gauge/, /temp/);
            cols.q = find(/rate|^q$|^q[ _(]|flow|stb|bbl|mscf|bopd|bwpd|m3/);
        }
        var ncol = data.length ? data[0].length : first.length;
        if (cols.t < 0) cols.t = 0;
        if (cols.p < 0) { for (var c = 0; c < ncol; c++) if (c !== cols.t && c !== cols.T && c !== cols.q) { cols.p = c; break; } }
        out.hasRate = cols.q >= 0;
        // time format
        var tv = data.map(function (r) { return r[cols.t]; }).filter(function (v) { return v != null && v !== ''; });
        var th = hl[cols.t] || '';
        if (tv.length && tv.every(function (v) { return RE_ISO.test(v); })) out.timeFormat = 'iso';
        else if (tv.length && tv.every(function (v) { return RE_DMY.test(v); })) {
            var mdy = false, dmy = false;
            tv.forEach(function (v) { var m = RE_DMY.exec(v); if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; });
            out.timeFormat = (mdy && !dmy) ? 'mdy' : 'dmy';
            out.dayFirst = out.timeFormat === 'dmy';
        } else {
            var nums = tv.map(function (v) { return +String(v).replace(',', '.'); }).filter(isNum);
            if (/min/.test(th)) out.timeFormat = 'elapsed_min';
            else if (/(^|[^a-z])(s|sec|secs|second|seconds)([^a-z]|$)/.test(th)) out.timeFormat = 'elapsed_s';
            else if (/serial|excel|day/.test(th) || (nums.length && nums.every(function (v) { return v > 20000 && v < 80000; }) && nums.some(function (v) { return v % 1 !== 0; }))) out.timeFormat = 'serial';
            else out.timeFormat = 'elapsed_h';
        }
        // pressure unit guess
        var ph = hl[cols.p] || '';
        out.pUnitGuess = /psig/.test(ph) ? 'psig' : /psia|psi/.test(ph) ? 'psia' : /kpa/.test(ph) ? 'kPa' : /mpa/.test(ph) ? 'MPa' : /barg/.test(ph) ? 'barg' : /bar/.test(ph) ? 'bar' : null;
        if (cols.T >= 0 && /degc|°c|\(c\)|_c$|\bc\b/.test(hl[cols.T] || '')) out.tempUnit = 'C';
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Time parsing (fast paths)
    // ─────────────────────────────────────────────────────────────────────
    function _dig(s, i, n) { var v = 0; for (var k = 0; k < n; k++) { var c = s.charCodeAt(i + k) - 48; if (c < 0 || c > 9) return NaN; v = v * 10 + c; } return v; }
    // 'YYYY-MM-DD[ T]hh:mm[:ss[.fff]][Z|±hh:mm]' → {ms (UTC arithmetic of the wall clock or the absolute instant), abs}
    var _isoOut = { ms: NaN, abs: false };
    function _parseIso(s) {
        _isoOut.ms = NaN; _isoOut.abs = false;
        var L = s.length;
        if (L >= 16 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45 && s.charCodeAt(13) === 58) {
            var y = _dig(s, 0, 4), mo = _dig(s, 5, 2), d = _dig(s, 8, 2), h = _dig(s, 11, 2), mi = _dig(s, 14, 2), se = 0, frac = 0, i = 16;
            if (i < L && s.charCodeAt(i) === 58) { se = _dig(s, 17, 2); i = 19; if (i < L && (s[i] === '.' || s[i] === ',')) { var j = i + 1, f = 0, sc = 1; while (j < L) { var c = s.charCodeAt(j) - 48; if (c < 0 || c > 9) break; if (sc < 1000) { f = f * 10 + c; sc *= 10; } j++; } frac = f * 1000 / sc; i = j; } }
            if (y === y && mo === mo && d === d && h === h && mi === mi && se === se) {
                var ms = dateUTC(y, mo - 1, d, h, mi, se) + frac;
                while (i < L && s.charCodeAt(i) === 32) i++;
                if (i >= L) { _isoOut.ms = ms; return _isoOut; }
                var ch = s[i];
                if (ch === 'Z' || ch === 'z') { _isoOut.ms = ms; _isoOut.abs = true; return _isoOut; }
                if (ch === '+' || ch === '-') {
                    var oh = _dig(s, i + 1, 2), om = (s[i + 3] === ':') ? _dig(s, i + 4, 2) : _dig(s, i + 3, 2);
                    if (oh === oh && om === om) { _isoOut.ms = ms - (ch === '+' ? 1 : -1) * (oh * HOUR + om * MIN); _isoOut.abs = true; return _isoOut; }
                }
                return _isoOut;
            }
        }
        if (RE_ISO.test(s)) {                           // short forms: single-digit fields, date only
            var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
            if (m) {
                var ms2 = dateUTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) + (m[7] ? +('0.' + m[7]) * 1000 : 0);
                if (m[8]) {
                    _isoOut.abs = true;
                    if (m[8] !== 'Z') { var sg = m[8][0] === '+' ? 1 : -1, hh = +m[8].slice(1, 3), mm = +m[8].slice(-2); ms2 -= sg * (hh * HOUR + mm * MIN); }
                }
                _isoOut.ms = ms2;
            }
        }
        return _isoOut;
    }
    function _parseDMY(s, dayFirst) {
        var m = RE_DMY.exec(s);
        if (!m) return NaN;
        var a = +m[1], b = +m[2], y = +m[3];
        if (m[3].length === 2) y += (y < 70 ? 2000 : 1900);
        var d = dayFirst ? a : b, mo = dayFirst ? b : a;
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
        var h = m[5] ? +m[5] : 0, mi = m[6] ? +m[6] : 0, se = m[8] ? +m[8] : 0, fr = m[9] ? +('0.' + m[9].slice(1)) * 1000 : 0;
        if (m[10]) { var pm = /p/i.test(m[10]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
        return dateUTC(y, mo - 1, d, h, mi, se) + fr;
    }
    function _num(s, decComma) {
        if (decComma && s.indexOf(',') !== -1) s = s.replace(',', '.');
        if (s === '') return NaN;
        return +s;
    }

    // ─────────────────────────────────────────────────────────────────────
    // parseJob / parse (§4.1)
    // ─────────────────────────────────────────────────────────────────────
    function _grow(a) { var b = new Float64Array(mMax(1024, a.length * 2)); b.set(a); return b; }

    function _finishRecord(t, p, T, n, o, warnings) {
        // sort once when not monotonic; duplicate timestamps keep the median
        var mono = true;
        for (var i = 1; i < n; i++) if (t[i] < t[i - 1]) { mono = false; break; }
        var q = o.q;
        if (!mono) {
            var idx = new Array(n);
            for (var k = 0; k < n; k++) idx[k] = k;
            idx.sort(function (a, b) { return (t[a] - t[b]) || (a - b); });
            var t2 = new Float64Array(n), p2 = new Float64Array(n), T2 = T ? new Float64Array(n) : null, q2 = q ? new Float64Array(n) : null;
            for (var s = 0; s < n; s++) { t2[s] = t[idx[s]]; p2[s] = p[idx[s]]; if (T2) T2[s] = T[idx[s]]; if (q2) q2[s] = q[idx[s]]; }
            t = t2; p = p2; T = T2; q = q2;
            warnings.push(W('UNSORTED', 'info', 'Rows were not in time order; they were sorted once.', ['Q2']));
        }
        var dup = 0;
        for (var j = 1; j < n; j++) if (t[j] === t[j - 1]) { dup++; }
        if (dup) {
            var w = 0, r = 0;
            var tt = new Float64Array(n - dup), pp = new Float64Array(n - dup), TT = T ? new Float64Array(n - dup) : null, qq = q ? new Float64Array(n - dup) : null;
            while (r < n) {
                var e = r + 1; while (e < n && t[e] === t[r]) e++;
                tt[w] = t[r]; pp[w] = (e - r > 1) ? medianRange(p, r, e) : p[r];
                if (TT) TT[w] = (e - r > 1) ? medianRange(T, r, e) : T[r];
                if (qq) qq[w] = q[e - 1];
                w++; r = e;
            }
            t = tt; p = pp; T = TT; q = qq; n = w;
            warnings.push(W('DUPLICATE_TIMES', 'info', dup + ' duplicate timestamps were merged (median pressure).', ['Q2']));
        } else {
            t = t.slice(0, n); p = p.slice(0, n); if (T) T = T.slice(0, n); if (q) q = q.slice(0, n);
        }
        return { t: t, p: p, T: T, q: q, n: n };
    }
    function _record(t, p, T, o, warnings) {
        return {
            ok: true, origin_ms: t[0], t: t, p: p, T: T, n: t.length, source: o.source || 'csv', name: String(o.name || ''),
            zone: o.zone && o.zone.mode !== 'device' ? o.zone : resolveZone(o.zone), pUnitIn: o.pUnitIn || 'psia', patm: o.patm,
            elapsed: !!o.elapsed, rollup: !!o.rollup, hash: recordHash(t, p), warnings: warnings
        };
    }
    function _compressRates(t, q, n) {
        if (!q) return null;
        var out = [], last = NaN;
        for (var i = 0; i < n; i++) {
            var v = q[i];
            if (!isNum(v)) continue;
            if (v < 0) v = -v;
            if (v !== last) { out.push({ t_ms: t[i], q: v }); last = v; }
        }
        return out.length ? out : null;
    }

    // opts {cols, timeFormat, t0_ms (elapsed only), zone (resolved), pUnit, patm=14.696, chunkLines=10000, sep, dayFirst,
    //       name, source} → Job<{record, rateTable}> (or a failure object from result()).
    function parseJob(text, opts) {
        opts = opts || {};
        text = String(text == null ? '' : text);
        var P = D.DEFAULTS.parse;
        var sn = sniff(text);
        var sep = opts.sep || sn.sep, merge = opts.sep ? (opts.sep === ' ' && sn.mergeDT) : sn.mergeDT;
        var cols = Object.assign({}, sn.cols, opts.cols || {});
        var tf = (opts.timeFormat && opts.timeFormat !== 'auto') ? opts.timeFormat : sn.timeFormat;
        var dayFirst = (opts.dayFirst != null) ? !!opts.dayFirst : (tf === 'mdy' ? false : tf === 'dmy' ? true : sn.dayFirst);
        var zone = (opts.zone && opts.zone.mode && opts.zone.mode !== 'device') ? opts.zone : resolveZone(opts.zone || { mode: 'utc' });
        var pUnit = pUnitKey(opts.pUnit || sn.pUnitGuess || 'psia');
        var patm = isNum(+opts.patm) && +opts.patm > 0 ? +opts.patm : P.patm;
        var t0 = isNum(+opts.t0_ms) ? +opts.t0_ms : P.t0_ms;
        var chunk = mMax(1, mFloor(num(+opts.chunkLines, CHUNK_LINES)));
        var tempC = sn.tempUnit === 'C' && opts.tempUnit !== 'F';
        var decComma = sep !== ',';
        var ct = cols.t, cp = cols.p, cT = cols.T, cq = cols.q;
        var elapsed = /^elapsed/.test(tf);
        var tMul = tf === 'elapsed_min' ? MIN : tf === 'elapsed_s' ? SEC : HOUR;
        var L = text.length, pos = 0, line0 = true, skipped = 0, nRows = 0;
        var cap = 4096, T = new Float64Array(cap), Pp = new Float64Array(cap), TT = cT >= 0 ? new Float64Array(cap) : null, Q = cq >= 0 ? new Float64Array(cap) : null;   // grown ×2 on demand
        var n = 0, phase = 'parse', res = null, cancelled = false, rec = null, warnings = [], fin2 = null;
        var useSimple = (sep !== ' ' && !merge);
        // Naive local times in the interval the clocks repeat when they go back: the first pass through it is the first
        // occurrence; once the previous row is already at or past a time's first occurrence (the clock went back), the
        // time is its second occurrence.
        var prevUtc = NaN, nRepeat = 0, nSecond = 0;

        function naive(local) {
            if (zone.mode !== 'iana') return localToUtc(zone, local);
            var v = _bucketOffset(zone, local);
            if (v === v) return local - v;
            var uE = localToUtc(zone, local), uL = localLaterUtc(zone, local);
            if (!isNum(uL)) return uE;
            nRepeat++;
            if (uE <= prevUtc && prevUtc < uL) { nSecond++; return uL; }
            return uE;
        }
        function parseTime0(s) {
            if (elapsed) { var v = _num(s, decComma); return isNum(v) ? t0 + v * tMul : NaN; }
            if (tf === 'serial') { var sv = _num(s, decComma); return isNum(sv) ? naive(mRound((sv - 25569) * DAY)) : NaN; }
            if (tf === 'dmy' || tf === 'mdy') { var dm = _parseDMY(s, dayFirst); return dm === dm ? naive(dm) : NaN; }
            var r = _parseIso(s);
            if (r.ms !== r.ms) { var dm2 = _parseDMY(s, dayFirst); return dm2 === dm2 ? naive(dm2) : NaN; }
            return r.abs ? r.ms : naive(r.ms);
        }
        function parseTime(s) {
            var u = parseTime0(s);
            if (u === u) prevUtc = u;
            return u;
        }
        function doChunk() {
            var lines = 0;
            while (pos < L && lines < chunk) {
                var nl = text.indexOf('\n', pos);
                if (nl === -1) nl = L;
                var line = text.slice(pos, nl);
                pos = nl + 1;
                lines++;
                if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
                if (!line) continue;
                var c0 = line.charCodeAt(0);
                if (c0 === 35) continue;                                   // '#'
                if (line0) { line0 = false; if (sn.headerRow) continue; }
                var f = useSimple ? line.split(sep) : _split(line, sep, merge);
                var ts = f[ct], ps = f[cp];
                if (ts === undefined || ps === undefined) { skipped++; continue; }
                if (!useSimple) { /* already trimmed */ } else {
                    if (ts.charCodeAt(0) === 32 || ts.charCodeAt(ts.length - 1) === 32 || ts.charCodeAt(0) === 34) ts = ts.trim().replace(/^"(.*)"$/, '$1');
                    if (ps.charCodeAt(0) === 32 || ps.charCodeAt(ps.length - 1) === 32 || ps.charCodeAt(0) === 34) ps = ps.trim().replace(/^"(.*)"$/, '$1');
                }
                var tm = parseTime(ts), pv = _num(ps, decComma);
                if (!(tm === tm) || !(pv === pv) || !_isFin(pv) || !_isFin(tm)) { skipped++; continue; }
                if (n >= T.length) { T = _grow(T); Pp = _grow(Pp); if (TT) TT = _grow(TT); if (Q) Q = _grow(Q); }
                T[n] = mRound(tm);
                Pp[n] = toPsia(pv, pUnit, patm);
                if (TT) { var tv = _num((f[cT] || '').trim(), decComma); TT[n] = isNum(tv) ? (tempC ? tv * 1.8 + 32 : tv) : NaN; }
                if (Q) { var qv = _num((f[cq] || '').trim(), decComma); Q[n] = qv; }
                n++; nRows++;
            }
        }
        var job = {
            step: function () {
                if (res || cancelled) return { done: true, progress: 1, label: 'Parsed' };
                if (phase === 'parse') {
                    doChunk();
                    if (pos >= L) phase = 'finish';
                    return { done: false, progress: L ? 0.9 * pos / L : 0.9, label: 'Reading rows… ' + nRows };
                }
                if (phase === 'finish') {
                    if (!n) {
                        res = { ok: false, code: 'NO_DATA', errors: ['No rows with a valid time and pressure were found.'], bad: ['text'] };
                        return { done: true, progress: 1, label: 'No data' };
                    }
                    if (skipped) warnings.push(W('ROWS_SKIPPED', 'warn', skipped + ' rows without a valid time or pressure were skipped.', ['Q2']));
                    if (nRepeat) warnings.push(W('DST_REPEATED_HOUR', 'warn', nRepeat + ' local times fell in the hour repeated when the clocks went back (' + zone.tz + '); ' +
                        (nSecond ? nSecond + ' were read as its second occurrence from the row order.' : 'all were read as its first occurrence (the times never went back).') +
                        ' Check any build-up that spans the change.', ['Q2']));
                    fin2 = _finishRecord(T, Pp, TT, n, { q: Q }, warnings);
                    if (fin2.T) { var any = false; for (var k = 0; k < fin2.n; k++) if (isNum(fin2.T[k])) { any = true; break; } if (!any) fin2.T = null; }
                    if (fin2.T) {
                        // leading rows without a temperature take the first valid one (0 °F would read as a fast change, Q7)
                        var firstT = NaN;
                        for (var k1 = 0; k1 < fin2.n; k1++) if (isNum(fin2.T[k1])) { firstT = fin2.T[k1]; break; }
                        for (var k2 = 0; k2 < fin2.n; k2++) if (!isNum(fin2.T[k2])) fin2.T[k2] = k2 ? fin2.T[k2 - 1] : firstT;
                    }
                    phase = 'hash';
                    return { done: false, progress: 0.95, label: 'Sorting' };
                }
                if (phase === 'hash') {
                    rec = _record(fin2.t, fin2.p, fin2.T, { source: opts.source || 'csv', name: opts.name || '', zone: zone, pUnitIn: pUnit, patm: patm, elapsed: elapsed }, warnings);
                    var rt = _compressRates(fin2.t, fin2.q, fin2.n);
                    res = { record: rec, rateTable: rt, sniff: { sep: sep, cols: cols, timeFormat: tf, pUnit: pUnit, dayFirst: dayFirst } };
                    return { done: true, progress: 1, label: 'Parsed ' + fin2.n + ' rows' };
                }
                return { done: true, progress: 1, label: '' };
            },
            result: function () { return res; },
            cancel: function () { cancelled = true; }
        };
        return job;
    }
    function runSync(job) { var g = 0; while (!job.step().done) { if (++g > 1e8) break; } return job.result(); }
    function parse(text, opts) { return runSync(parseJob(text, opts)); }

    // ─────────────────────────────────────────────────────────────────────
    // Other sources
    // ─────────────────────────────────────────────────────────────────────
    function _unitFromText(u) {
        var s = String(u || '').toLowerCase();
        if (/psig/.test(s)) return 'psig';
        if (/kpa/.test(s)) return /g\b|\(g\)|kpag/.test(s) ? 'kPag' : 'kPa';
        if (/mpa/.test(s)) return 'MPa';
        if (/bar/.test(s)) return /barg|\(g\)/.test(s) ? 'barg' : 'bar';
        return 'psia';
    }
    // {tag, from_ms, to_ms, patm} → Promise<GaugeRecord>. Bad-quality samples are dropped; 60-s rollups flag `rollup`.
    function fromHistorian(o) {
        o = o || {};
        var H = G.WTS_historian;
        if (!H || typeof H.query !== 'function') return Promise.reject({ ok: false, code: 'NO_HISTORIAN', errors: ['The historian is not available.'], bad: ['tag'] });
        var patm = isNum(+o.patm) && +o.patm > 0 ? +o.patm : D.DEFAULTS.parse.patm;
        return Promise.resolve(H.query({ tags: [o.tag], from: o.from_ms, to: o.to_ms, agg: 'raw' })).then(function (r) {
            var s = r && r.series && r.series[0];
            if (!s || !s.t || !s.t.length) throw { ok: false, code: 'NO_DATA', errors: ['The historian returned no samples for this tag.'], bad: ['tag'] };
            var unit = _unitFromText(s.unit), t = [], p = [], roll = false;
            for (var i = 0; i < s.t.length; i++) {
                if (s.q && s.q[i] === 2) continue;
                var v = +s.v[i], tm = +s.t[i];
                if (!isNum(v) || !isNum(tm)) continue;
                t.push(mRound(tm)); p.push(toPsia(v, unit, patm));
                if (s.rollup && s.rollup[i]) roll = true;
            }
            if (!t.length) throw { ok: false, code: 'NO_DATA', errors: ['The historian returned no good-quality samples.'], bad: ['tag'] };
            var warnings = [];
            if (roll) warnings.push(W('ROLLUP', 'warn', 'Part of the tag history was returned as 60-second means; early build-up detail is reduced.', ['Q2']));
            var f = _finishRecord(Float64Array.from(t), Float64Array.from(p), null, t.length, {}, warnings);
            return _record(f.t, f.p, null, { source: 'historian', name: String(o.tag || ''), zone: { mode: 'utc' }, pUnitIn: unit, patm: patm, rollup: roll }, warnings);
        });
    }
    // {t0_ms} → {record, rateTable|null} from window.PRiSM_dataset (read only), or a failure.
    function fromPRiSM(o) {
        o = o || {};
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t || !ds.p || !ds.t.length) return { ok: false, code: 'NO_DATA', errors: ['PRiSM has no dataset with pressures.'], bad: ['prism'] };
        var t0 = isNum(+o.t0_ms) ? +o.t0_ms : D.DEFAULTS.parse.t0_ms;
        var n = ds.t.length, t = new Float64Array(n), p = new Float64Array(n), q = ds.q ? new Float64Array(n) : null, k = 0;
        for (var i = 0; i < n; i++) {
            var th = +ds.t[i], pv = +ds.p[i];
            if (!isNum(th) || !isNum(pv)) continue;
            t[k] = mRound(t0 + th * HOUR); p[k] = pv; if (q) q[k] = +ds.q[i];
            k++;
        }
        if (!k) return { ok: false, code: 'NO_DATA', errors: ['PRiSM has no dataset with pressures.'], bad: ['prism'] };
        var warnings = [];
        var f = _finishRecord(t, p, null, k, { q: q }, warnings);
        var rec = _record(f.t, f.p, null, { source: 'prism', name: String(ds.name || 'PRiSM dataset'), zone: { mode: 'utc' }, pUnitIn: 'psia', patm: D.DEFAULTS.parse.patm, elapsed: true }, warnings);
        return { record: rec, rateTable: _compressRates(f.t, f.q, f.n) };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Data quality (§4.2, M§A1)
    // ─────────────────────────────────────────────────────────────────────
    function _shutEvents(events) {
        return (events || []).filter(function (e) {
            return e && isNum(e.tc_ms) && isNum(e.tEnd_ms) && e.kind !== 'substep' && !e.dropped;
        }).slice().sort(function (a, b) { return a.tc_ms - b.tc_ms; });
    }
    // σ2 = 1.4826·MAD(second differences)/√6 over samples i0..i1 (no triplet across a gap).
    // Statistics of more than STAT_MAX values use an evenly strided subset (deterministic; keeps one QC call within a unit).
    var STAT_MAX = 100000;
    function _sigma2(p, gapAfter, i0, i1, out) {
        var m = 0, stride = mMax(1, mCeil((i1 - i0) / STAT_MAX));
        for (var i = i0 + 1; i < i1; i += stride) {
            if (gapAfter[i - 1] || gapAfter[i]) continue;
            out[m++] = p[i + 1] - 2 * p[i] + p[i - 1];
        }
        if (m < 5) return { sigma: NaN, m: m };
        var med = _medianBuf(out, m);
        for (var k = 0; k < m; k++) out[k] = mAbs(out[k] - med);
        return { sigma: 1.4826 * _medianBuf(out, m) / mSqrt(6), m: m };
    }

    // record → QC. opts {events (detected; refines the quiet segments), spike:'off'|'flag'|'filter', gapN, depth}
    // qcJob runs it in three units (sampling and gaps; noise; correlation, spikes and plausibility); qc runs them at once.
    function qcJob(record, opts) {
        opts = opts || {};
        var Q = D.DEFAULTS.qc;
        var t = record && record.t, p = record && record.p, n = t ? t.length : 0;
        var plaus = [];
        var res = {
            ok: false, n: n, dtMed_s: null, dtP05_s: null, dtP95_s: null, sigma_psi: null, sigmaFlow_psi: null, sigmaShut_psi: null,
            segments: [], resolution_psi: null, resolutionLimited: false, rho1: null, noiseCorrelated: false,
            gaps: [], gapCount: 0, gapTotal_h: 0, longestGap_h: 0, spikes: { count: 0, mode: 'off', idx: [] },
            depth: { applied: false, shift_psi: 0 }, temperature: { present: false, fastChanges: [] }, plausibility: plaus,
            ev: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q7', 'Q8']
        };
        var shift = depthShift(opts.depth);
        res.depth = { applied: !!opts.depth && shift !== 0, shift_psi: shift };
        var phase = (n < 3) ? 9 : 0, dts, gapAfter, longest = 0, evs, segs, sig, sigF, sigS;
        if (n < 3) plaus.push(W('TOO_FEW_SAMPLES', 'bad', 'The record has fewer than 3 samples.', ['Q2']));
        function unit1() {
        dts = new Float64Array(n - 1);
        for (var i = 0; i < n - 1; i++) dts[i] = (t[i + 1] - t[i]) / SEC;
        var dstr = mMax(1, mCeil((n - 1) / STAT_MAX)), dsub = dts;
        if (dstr > 1) { dsub = new Float64Array(mCeil((n - 1) / dstr)); for (var ds = 0, dk = 0; ds < n - 1; ds += dstr) dsub[dk++] = dts[ds]; }
        var dtMed = medianRange(dsub, 0, dsub.length);
        res.dtMed_s = dtMed; res.dtP05_s = quantile(dsub, 0.05); res.dtP95_s = quantile(dsub, 0.95);
        var gapN = clamp(num(+opts.gapN, D.DEFAULTS.detect.gapN), 2, 50);
        var gapThr = mMax(gapN * dtMed, dtMed + Q.gapMin_s);
        res.gapThr_s = gapThr;
        gapAfter = new Uint8Array(n); var tot = 0;
        for (var g = 0; g < n - 1; g++) {
            if (dts[g] > gapThr) {
                gapAfter[g] = 1;
                var dur = dts[g] / 3600;
                res.gaps.push({ t0_ms: t[g], t1_ms: t[g + 1], dur_h: dur });
                tot += dur; if (dur > longest) longest = dur;
            }
        }
        res.gapCount = res.gaps.length; res.gapTotal_h = tot; res.longestGap_h = longest;
        // quiet segments
        evs = _shutEvents(opts.events); segs = [];
        if (evs.length) {
            var prevEnd = -INF;
            evs.forEach(function (e) {
                var fs = prevEnd === -INF ? 0 : lowerBound(t, prevEnd + Q.quietAfter_h * HOUR);
                var j0 = isNum(e.j0) ? e.j0 : lowerBound(t, e.tc_ms) - 1;
                var fe = j0 - Q.excludeN;
                if (fe - fs + 1 >= Q.minSeg) segs.push({ i0: fs, i1: fe, kind: 'flow' });
                var late = e.tc_ms + mMax(Q.quietLate_h * HOUR, Q.quietLateFrac * (e.tEnd_ms - e.tc_ms));
                var ss = lowerBound(t, late), se = lowerBound(t, e.tEnd_ms + 1) - 1 - Q.excludeN;
                if (se - ss + 1 >= Q.minSeg) segs.push({ i0: ss, i1: se, kind: 'shut' });
                prevEnd = mMax(prevEnd, e.tEnd_ms);
            });
            var fs2 = lowerBound(t, prevEnd + Q.quietAfter_h * HOUR);
            if (n - fs2 >= Q.minSeg) segs.push({ i0: fs2, i1: n - 1, kind: 'flow' });
        } else segs.push({ i0: 0, i1: n - 1, kind: 'flow' });
        }
        function unit2() {
        var work = new Float64Array(mMin(n, STAT_MAX + 16)), flowS = [], shutS = [], allS = [];
        segs.forEach(function (s) {
            var r = _sigma2(p, gapAfter, s.i0, s.i1, work);
            if (!isNum(r.sigma)) return;
            res.segments.push({ t0_ms: t[s.i0], t1_ms: t[s.i1], kind: s.kind, sigma: r.sigma });
            (s.kind === 'shut' ? shutS : flowS).push(r.sigma); allS.push(r.sigma);
        });
        sig = allS.length ? median(allS) : _sigma2(p, gapAfter, 0, n - 1, work).sigma;
        sigF = flowS.length ? median(flowS) : sig; sigS = shutS.length ? median(shutS) : sig;
        // quantisation: more than half of the first differences are zero → σ ≥ Δq/√12
        var zero = 0, cnt = 0, minNZ = INF;
        for (var k = 0; k < n - 1; k++) {
            if (gapAfter[k]) continue;
            var d1 = mAbs(p[k + 1] - p[k]); cnt++;
            if (d1 < 1e-12) zero++; else if (d1 < minNZ) minNZ = d1;
        }
        var zf = cnt ? zero / cnt : 0;
        if (zf > 0.1 && _isFin(minNZ)) res.resolution_psi = parseFloat(minNZ.toPrecision(6));
        if (zf > Q.quantFrac && _isFin(minNZ)) {
            var qf = res.resolution_psi / mSqrt(12);
            res.resolutionLimited = true;
            sig = mMax(num(sig, 0), qf); sigF = mMax(num(sigF, 0), qf); sigS = mMax(num(sigS, 0), qf);
            plaus.push(W('RESOLUTION_LIMITED', 'warn', 'Pressure resolution ' + res.resolution_psi + ' psi limits the noise estimate.', ['Q1']));
        }
        res.sigma_psi = fin(sig); res.sigmaFlow_psi = fin(sigF); res.sigmaShut_psi = fin(sigS);
        }
        function unit3() {
        // lag-1 autocorrelation of the first differences over the quiet segments (de-meaned per segment)
        var num1 = 0, den1 = 0;
        segs.forEach(function (s) {
            var sum = 0, c = 0;
            for (var a = s.i0; a < s.i1; a++) if (!gapAfter[a]) { sum += p[a + 1] - p[a]; c++; }
            if (c < 3) return;
            var mu = sum / c, prev = NaN;
            for (var b = s.i0; b < s.i1; b++) {
                if (gapAfter[b]) { prev = NaN; continue; }
                var d = p[b + 1] - p[b] - mu;
                den1 += d * d;
                if (prev === prev) num1 += prev * d;
                prev = d;
            }
        });
        res.rho1 = den1 > 0 ? num1 / den1 : null;
        res.noiseCorrelated = res.rho1 !== null && res.rho1 > Q.rhoCorr;
        if (res.noiseCorrelated) plaus.push(W('NOISE_CORRELATED', 'info', 'Gauge noise is correlated; the noise estimate is a lower bound.', ['Q1']));
        // spikes (Hampel k = 5, 6 robust σ, runs ≤ 2, never within 3 samples of an event)
        var mode = opts.spike === 'flag' || opts.spike === 'filter' ? opts.spike : 'off';
        res.spikes.mode = mode;
        if (mode !== 'off' && isNum(sig) && sig > 0) {
            var near = new Uint8Array(n);
            evs.forEach(function (e) {
                [e.tc_ms, e.tEnd_ms].forEach(function (ms) {
                    var c0 = lowerBound(t, ms);
                    for (var x = mMax(0, c0 - Q.excludeN - 1); x <= mMin(n - 1, c0 + Q.excludeN + 1); x++) near[x] = 1;
                });
            });
            var flag = new Uint8Array(n), hw = Q.hampelHalf, wb = new Float64Array(2 * hw + 1);
            for (var s2 = 1; s2 < n - 1; s2++) {
                if (near[s2] || gapAfter[s2 - 1] || gapAfter[s2]) continue;
                if (mAbs(p[s2] - 0.5 * (p[s2 - 1] + p[s2 + 1])) <= 3 * sig) continue;   // cheap pre-screen
                var lo = mMax(0, s2 - hw), hi = mMin(n - 1, s2 + hw), m2 = 0;
                for (var u = lo; u <= hi; u++) wb[m2++] = p[u];
                var md = _medianBuf(wb, m2);
                m2 = 0; for (var u2 = lo; u2 <= hi; u2++) wb[m2++] = mAbs(p[u2] - md);
                var sw = mMax(1.4826 * _medianBuf(wb, m2), sig);
                if (mAbs(p[s2] - md) > Q.hampelSig * sw) flag[s2] = 1;
            }
            var idx = [], run0 = -1;
            for (var r2 = 0; r2 <= n; r2++) {
                if (r2 < n && flag[r2]) { if (run0 < 0) run0 = r2; continue; }
                if (run0 >= 0) { if (r2 - run0 <= Q.hampelRun) for (var z = run0; z < r2; z++) idx.push(z); run0 = -1; }
            }
            res.spikes.count = idx.length;
            res.spikes.idx = idx.slice(0, Q.maxIdx);
            if (idx.length > Q.maxIdx) Object.defineProperty(res.spikes, '_all', { value: idx, enumerable: false });
        }
        // temperature: more than 1 °F change in the first hour of a build-up
        var T = record.T;
        if (T && T.length === n) {
            res.temperature.present = true;
            evs.forEach(function (e) {
                var a = lowerBound(t, e.tc_ms), b = lowerBound(t, e.tc_ms + HOUR), base = T[mMax(0, a - 1)], mx = 0;
                for (var x = a; x < b && x < n; x++) { var dT = T[x] - base; if (mAbs(dT) > mAbs(mx)) mx = dT; }
                if (mAbs(mx) > Q.tempSettle_F) res.temperature.fastChanges.push({ t_ms: e.tc_ms, dT_F: mx });
            });
        }
        // plausibility
        var pmin = INF, pmax = -INF;
        for (var v = 0; v < n; v++) { if (p[v] < pmin) pmin = p[v]; if (p[v] > pmax) pmax = p[v]; }
        if (pmin <= 0) plaus.push(W('PRESSURE_NOT_ABSOLUTE', 'bad', 'Pressures at or below zero: check the pressure unit (psia expected).', ['Q1']));
        if (pmax > 30000) plaus.push(W('PRESSURE_HIGH', 'warn', 'Pressures above 30,000 psia: check the pressure unit.', ['Q1']));
        if (pmax - pmin < 1e-9) plaus.push(W('PRESSURE_CONSTANT', 'bad', 'The pressure is constant over the whole record.', ['Q1']));
        if (n < 50) plaus.push(W('FEW_SAMPLES', 'warn', 'Only ' + n + ' samples in the record.', ['Q2']));
        if (longest > 24) plaus.push(W('LONG_GAP', 'warn', 'The longest gap in the record is ' + longest.toFixed(1) + ' h.', ['Q3']));
        res.ok = isNum(sig);
        }
        var units = [unit1, unit2, unit3], labels = ['Sampling and gaps', 'Gauge noise', 'Noise correlation and plausibility'];
        return {
            step: function () {
                if (phase >= units.length) return { done: true, progress: 1, label: 'Data quality' };
                units[phase]();
                phase++;
                return { done: phase >= units.length, progress: phase / units.length, label: labels[phase - 1] };
            },
            result: function () { return phase >= units.length ? res : null; },
            cancel: function () { phase = 99; }
        };
    }
    function qc(record, opts) { return runSync(qcJob(record, opts)); }
    // A copy of the record with the flagged spikes replaced by the local median (qc spike mode 'filter').
    function applySpikeFilter(record, q) {
        var idx = q && q.spikes && (q.spikes._all || q.spikes.idx);
        if (!idx || !idx.length) return record;
        var p = Float64Array.from(record.p), n = p.length, hw = D.DEFAULTS.qc.hampelHalf, wb = new Float64Array(2 * hw + 1);
        idx.forEach(function (i) {
            var m = 0; for (var u = mMax(0, i - hw); u <= mMin(n - 1, i + hw); u++) if (u !== i) wb[m++] = record.p[u];
            p[i] = _medianBuf(wb, m);
        });
        return Object.assign({}, record, { p: p });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Detection (§4.3, M§A2) and closing time (M§A3)
    // ─────────────────────────────────────────────────────────────────────
    function detectSettings(s) {
        var d = Object.assign({}, D.DEFAULTS.detect);
        if (s) Object.keys(s).forEach(function (k) { if (s[k] !== undefined && s[k] !== null) d[k] = s[k]; });
        Object.keys(DETECT_CLAMP).forEach(function (k) { var r = DETECT_CLAMP[k], v = +d[k]; d[k] = isNum(v) ? clamp(v, r[0], r[1]) : D.DEFAULTS.detect[k]; });
        d.partial = d.partial !== false;
        if (['off', 'flag', 'filter'].indexOf(d.spike) === -1) d.spike = 'off';
        return d;
    }
    // Window medians of sign·p over consecutive windows of w ms (empty windows → NaN).
    function _windows(t, p, n, w, sign) {
        var t0 = t[0], K = mFloor((t[n - 1] - t0) / w) + 1;
        var M = new Float64Array(K), first = new Int32Array(K), last = new Int32Array(K);
        M.fill(NaN); first.fill(-1); last.fill(-1);
        var b = new Float64Array(mMax(16, n)), i = 0;
        while (i < n) {
            var k = mFloor((t[i] - t0) / w), lim = t0 + (k + 1) * w, m = 0, j = i;
            while (j < n && t[j] < lim) { b[m++] = sign * p[j]; j++; }
            M[k] = _medianBuf(b, m); first[k] = i; last[k] = j - 1;
            i = j;
        }
        return { M: M, first: first, last: last, K: K, t0: t0, w: w };
    }
    // Flowing trend: p = a + b·(t − ref_ms) [h], or, soon after a reopening, p = A + B·ln(t − t0) [h] (trend.log; the
    // drawdown is still curved there and a straight line extrapolated to the closing would read a rise too early).
    function trendAt(tr, ms) {
        if (tr.log) return tr.log.A + tr.log.B * mLog(mMax(1e-9, (ms - tr.log.t0) / HOUR));
        return tr.a + tr.b * (ms - tr.ref_ms) / HOUR;
    }
    function _trendX(tr, ms) { return tr.log ? mLog(mMax(1e-9, (ms - tr.log.t0) / HOUR)) : (ms - tr.ref_ms) / HOUR; }
    // Standard error of the trend at ms: σ_res·√(1/n + (x − x̄)²/Σ(x_i − x̄)²) (x in the trend's own abscissa).
    function trendSE(tr, ms) {
        var xb = tr.log ? tr.log.xbar : tr.tbar_h, sxx = tr.log ? tr.log.sxx : tr.sxx_h2, x = _trendX(tr, ms);
        if (!tr.log) x = (ms - tr.ref_ms) / HOUR;
        var se = num(tr.sigmaRes, 0) * mSqrt(1 / mMax(1, tr.n) + (sxx > 0 ? (x - xb) * (x - xb) / sxx : 0));
        return isNum(se) ? se : num(tr.sigmaRes, 0);
    }
    // The trend referenced at ms (a = trend(ms), b = the local slope in psi/h).
    function trendRebase(tr, ms) {
        var out = { a: trendAt(tr, ms), b: tr.log ? tr.log.B / mMax(1e-9, (ms - tr.log.t0) / HOUR) : tr.b, ref_ms: ms, n: tr.n, sigmaRes: tr.sigmaRes };
        if (tr.log) out.log = tr.log;
        else { out.tbar_h = tr.tbar_h - (ms - tr.ref_ms) / HOUR; out.sxx_h2 = tr.sxx_h2; }
        return out;
    }
    // Flowing trend on samples i0..i1 (Theil–Sen, ≤ trendMax samples), referenced at ref_ms; tOpen = the previous reopening.
    function _flowTrend(t, p, i0, i1, ref, S, sigFlow, tOpen) {
        var useLog = isNum(tOpen) && t[i0] > tOpen && (t[i1] - tOpen) < 20 * mMax(t[i1] - t[i0], 1);
        var x = [], y = [];
        for (var i = i0; i <= i1; i++) { x.push(useLog ? mLog((t[i] - tOpen) / HOUR) : (t[i] - ref) / HOUR); y.push(p[i]); }
        var ts = theilSen(x, y, S.trendMax);
        if (!isNum(ts.a)) ts = { a: y.length ? y[y.length - 1] : NaN, b: 0 };
        var res = [], sx = 0;
        for (var k = 0; k < x.length; k++) { res.push(y[k] - ts.a - ts.b * x[k]); sx += x[k]; }
        var xbar = x.length ? sx / x.length : 0, sxx = 0;
        for (var q = 0; q < x.length; q++) sxx += (x[q] - xbar) * (x[q] - xbar);
        var madr = res.length >= 3 ? 1.4826 * mad(res) : 0, sig = mMax(num(sigFlow, 0), num(madr, 0));
        if (useLog) {
            var tr = { a: 0, b: 0, ref_ms: ref, n: x.length, sigmaRes: sig, log: { t0: tOpen, A: ts.a, B: ts.b, xbar: xbar, sxx: sxx } };
            return trendRebase(tr, ref);
        }
        return { a: ts.a, b: ts.b, ref_ms: ref, n: x.length, sigmaRes: sig, tbar_h: xbar, sxx_h2: sxx };
    }

    // M§A3: t_c on a 50-point grid in [t_j0, t_j1) from ln r_j against ln(t_j − t_c) over the first K = 3–5 shut-in
    // samples; the SSR minimum with 0.5 ≤ n ≤ 1.05; pwf0 = trend(t_c); a closing ramp when n > 1.05 lasts > 2·Δt_med.
    function refineClosing(record, ev, q) {
        var t = record.t, p = record.p, n = t.length;
        var sign = ev.kind === 'falloff' ? -1 : 1;
        var j0 = clamp(ev.j0 | 0, 0, n - 1), j1 = clamp(ev.j1 | 0, 0, n - 1);
        if (j1 <= j0) j1 = mMin(n - 1, j0 + 1);
        var tr = ev.trend, tA = t[j0], tB = t[j1];
        var dtMed = (q && isNum(q.dtMed_s) ? q.dtMed_s * SEC : (tB - tA));
        var lastIdx = isNum(ev.tEnd_ms) ? lowerBound(t, ev.tEnd_ms + 1) - 1 : n - 1;
        var K = mMin(5, lastIdx - j1 + 1);
        var rs = [], ts = [];
        for (var j = j1; j < j1 + K; j++) { var r = sign * (p[j] - trendAt(tr, t[j])); if (r > 0) { rs.push(mLog(r)); ts.push(t[j]); } }
        var G50 = 50, step = (tB - tA) / G50, best = -1, bestSSR = INF, ssr = new Float64Array(G50), nn = new Float64Array(G50);
        var ub = -1, ubSSR = INF;
        function fitAt(tc) {
            var m = ts.length, sx = 0, sy = 0, sxx = 0, sxy = 0, xs = new Array(m);
            for (var i = 0; i < m; i++) { var x = mLog((ts[i] - tc) / HOUR); xs[i] = x; sx += x; sy += rs[i]; sxx += x * x; sxy += x * rs[i]; }
            var den = m * sxx - sx * sx;
            if (!(mAbs(den) > 1e-300)) return { n: NaN, ssr: INF };
            var nb = (m * sxy - sx * sy) / den, a = (sy - nb * sx) / m, s2 = 0;
            for (var k = 0; k < m; k++) { var e = rs[k] - a - nb * xs[k]; s2 += e * e; }
            return { n: nb, ssr: s2 };
        }
        if (ts.length >= 3 && step > 0) {
            for (var g = 0; g < G50; g++) {
                var f = fitAt(tA + g * step);
                ssr[g] = f.ssr; nn[g] = f.n;
                if (f.ssr < ubSSR) { ubSSR = f.ssr; ub = g; }
                if (f.n >= 0.5 && f.n <= 1.05 && f.ssr < bestSSR) { bestSSR = f.ssr; best = g; }
            }
        }
        var tc, dtc, ramp = { present: false, dur_s: 0 };
        // Closing ramp: the rise is still accelerating (second differences of the residual above 3·√6·σ) two samples after
        // the first shut-in sample, i.e. n > 1.05 over more than 2·Δt_med. The storage line after the convex part
        // extrapolates to the ramp midpoint, where t_c goes; the ramp lasts twice the time from there to its end.
        var thr2 = 3 * mSqrt(6) * mMax(num(tr.sigmaRes, 0), 1e-6), run0 = -1, run1 = -1;
        var resid = function (i) { return sign * (p[i] - trendAt(tr, t[i])); };
        for (var c = mMax(1, j0 - 2); c <= mMin(lastIdx - 1, j1 + 40); c++) {
            var d2 = resid(c + 1) - 2 * resid(c) + resid(c - 1);
            if (d2 > thr2) { if (run0 < 0) run0 = c; run1 = c; }
            else if (run0 >= 0 || c > j1 + 1) break;
        }
        if (run0 >= 0 && run1 >= j1 + 2 && run1 + 3 <= lastIdx) {
            var sx = 0, sy = 0, sxx = 0, sxy = 0;
            for (var u = run1 + 1; u <= run1 + 3; u++) { var xu = (t[u] - t[run1]) / HOUR, yu = resid(u); sx += xu; sy += yu; sxx += xu * xu; sxy += xu * yu; }
            var den2 = 3 * sxx - sx * sx, slp = den2 > 0 ? (3 * sxy - sx * sy) / den2 : 0, icp = (sy - slp * sx) / 3;
            if (slp > 0) {
                var tmid = t[run1] - icp / slp * HOUR, dur = 2 * (t[run1] - tmid);
                if (dur > 2 * dtMed && tmid > t[mMax(0, run0 - 2)] && tmid < t[run1]) {
                    ramp = { present: true, dur_s: dur / SEC };
                    tc = tmid;
                    dtc = dur / mSqrt(12);
                }
            }
        }
        if (!ramp.present) {
            if (best < 0) {                                   // clamped: no feasible exponent
                tc = 0.5 * (tA + tB);
                dtc = (tB - tA) / mSqrt(12);
            } else {
                tc = tA + best * step;
                var lim = bestSSR * (1 + 1 / mMax(1, ts.length)) + 1e-30, lo = best, hi = best;
                while (lo - 1 >= 0 && ssr[lo - 1] <= lim && nn[lo - 1] >= 0.5 && nn[lo - 1] <= 1.05) lo--;
                while (hi + 1 < G50 && ssr[hi + 1] <= lim && nn[hi + 1] >= 0.5 && nn[hi + 1] <= 1.05) hi++;
                dtc = mMax(step / 2, (hi - lo) * step / 2);
            }
        }
        tc = mRound(tc);
        var pwf0 = trendAt(tr, tc);
        var se = trendSE(tr, tc);
        ev.tc_ms = tc;
        ev.dtc_s = dtc / SEC;
        ev.pwf0 = pwf0;
        ev.pwf0SE = isNum(se) ? se : tr.sigmaRes;
        ev.trend = trendRebase(tr, tc);
        ev.ramp = ramp;
        if (isNum(ev.tEnd_ms)) ev.dtEnd_h = mMax(0, (ev.tEnd_ms - tc) / HOUR);
        return ev;
    }

    function _inRanges(ranges, ms) { for (var i = 0; i < ranges.length; i++) if (ms >= ranges[i][0] && ms < ranges[i][1]) return true; return false; }

    function _newEvent(C, j1, tr, warnings, extra) {
        var ev = {
            id: '', kind: C.sign < 0 ? 'falloff' : 'shutin', status: 'analysable', tc_ms: C.t[j1 - 1], dtc_s: 0, j0: j1 - 1, j1: j1,
            pwf0: null, pwf0SE: null, trend: tr, rise_psi: null, riseScale_min: 0, Ts_psi: C.Ts,
            tEnd_ms: null, dtEnd_h: 0, endReason: 'data_end', ramp: { present: false, dur_s: 0 }, fhat: null, fhatMethod: null,
            qBefore: null, qAfter: null, alloc: { date: dayOf(C.t[j1 - 1], C.day), ratio: null, pass: null, ignoresShutin: false, confirm: 'n/a' },
            manual: false, ev: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'], warnings: warnings || []
        };
        return Object.assign(ev, extra || {});
    }
    // Trend window ending at sample iEnd: ≥ max(30 min, 10·Δt_med) and ≥ 10 samples, never before iMin.
    function _trendWindow(C, iEnd, iMin, ref, tOpen) {
        var t = C.t, p = C.p, S = C.S, warnings = [];
        var L = mMax(S.trendMin * MIN, S.trendDtFactor * C.dtMed), i0 = iEnd;
        while (i0 - 1 >= iMin && ((t[iEnd] - t[i0 - 1]) <= L || (iEnd - i0 + 1) < S.trendN)) i0--;
        var tr;
        if (iEnd < iMin || iEnd < 0) {
            var f0 = clamp(iEnd + 1, 0, C.n - 1);
            tr = { a: p[f0], b: 0, ref_ms: t[f0], n: 1, sigmaRes: num(C.sigFlow, 0), tbar_h: 0, sxx_h2: 0 };
            warnings.push(W('TREND_SHORT', 'warn', 'No flowing samples before the closing: pwf0 comes from the first sample.', ['D3']));
        } else {
            tr = _flowTrend(t, p, i0, iEnd, ref, S, C.sigFlow, tOpen);
            if (tr.n < S.trendN) warnings.push(W('TREND_SHORT', 'warn', 'Only ' + tr.n + ' flowing samples before the closing for the pwf0 trend.', ['D3']));
        }
        return { tr: tr, warnings: warnings };
    }
    // First shut-in sample after iFrom: the first residual above max(4σ, 0.5 psi) that stays above for 3 samples.
    // A trend extrapolated over a curved flowing period can drift above the threshold before the closing; the closing
    // itself makes the residual jump (wellbore storage). So, from the threshold sample, the steepest rise among the next
    // samples is found and the first shut-in sample is moved forward to where the rise is at least 10 % of that steepest one.
    function _firstShut(C, tr, iFrom, iLim) {
        var t = C.t, p = C.p, S = C.S, sign = C.sign, n = C.n;
        var thr = mMax(S.firstSig * tr.sigmaRes, S.firstMin_psi);
        var r = function (i) { return sign * (p[i] - trendAt(tr, t[i])); };
        var j1 = -1;
        for (var i = mMax(iFrom, 1); i <= iLim && i < n; i++) {
            if (r(i) <= thr) continue;
            var ok = true;
            for (var k = 1; k < S.firstRun && i + k < n; k++) if (r(i + k) <= thr) { ok = false; break; }
            if (ok) { j1 = i; break; }
        }
        if (j1 < 1) return j1;
        var hi = mMin(n - 1, iLim + S.firstRun, j1 + 60), dMax = -INF, s0 = j1;
        for (var a = j1; a <= hi; a++) { var d = r(a) - r(a - 1); if (d > dMax) { dMax = d; s0 = a; } }
        if (!(dMax > thr)) return j1;
        while (s0 - 1 >= j1 && r(s0 - 1) - r(s0 - 2) > 0.1 * dMax) s0--;
        return s0;
    }

    // Builds one event from a rise detected at window k (multi-scale j). prevSplit: the previous event did not end at a
    // reopening (it ended at this rise or at an allocation cut), so the flowing trend is a straight line, not a log one.
    function _eventAt(C, k, j, prevEndIdx, prevSplit) {
        var Wd = C.win, tk0 = Wd.t0 + k * Wd.w;
        var tw = _trendWindow(C, Wd.first[k] - 1, prevEndIdx + 1, tk0, prevEndIdx >= 0 && !prevSplit ? C.t[prevEndIdx] : null);
        var kLim = mMin(Wd.K - 1, k + j + C.P + 1), iLim = C.n - 1;
        for (var kk = kLim; kk >= k; kk--) if (Wd.last[kk] >= 0) { iLim = Wd.last[kk]; break; }
        var j1 = _firstShut(C, tw.tr, Wd.first[k], iLim);
        if (j1 < 1) j1 = mMax(1, Wd.first[k + j] >= 0 ? Wd.first[k + j] : Wd.first[k]);
        var ev = _newEvent(C, j1, tw.tr, tw.warnings, { rise_psi: Wd.M[k + j] - Wd.M[k], riseScale_min: j * Wd.w / MIN });
        _findEnd(C, ev, { split: true });
        refineClosing(C.record, ev, C.qc);
        _setStatus(C, ev);
        return ev;
    }
    // A sharper rise starting at window m inside an event (another closing): the multi-scale rise of the detector
    // (M[m+j] − M[m] > T_s for some j ≤ J, persistent for 30 min) from a level within T_s of the event's highest level so
    // far (or after a lower level held for an hour: a reopening the fall rule missed), and splitRatio× steeper than the
    // steepest 30-min rise ending in the last hour. A build-up only slows down (dp/dt falls with Δt), so its own early
    // rise, the recovery after a phase-redistribution hump and noise do not pass; a closing after a day-rate step, an
    // intra-day rate change or a partial cut does. lowRun: windows the level has stayed below runMax − T_s. Returns j (0 = none).
    function _sharperRise(C, m, mFirst, runMax, lowRun) {
        var M = C.win.M, K = C.win.K, Ts = C.Ts, J = C.J, P = C.P;
        if (M[m] < runMax - Ts && lowRun * C.win.w < HOUR) return 0;
        var j = 0, jj, ii, a;
        for (jj = 1; jj <= J && m + jj < K; jj++) { var v = M[m + jj]; if (v === v && v - M[m] > Ts) { j = jj; break; } }
        if (!j) return 0;
        var cnt = 0;
        for (ii = 1; ii <= P && m + j + ii < K; ii++) { var v2 = M[m + j + ii]; if (v2 === v2) { cnt++; if (!(v2 - M[m] > Ts)) return 0; } }
        if (cnt < 2) return 0;
        var Lb = mMax(J, mCeil(HOUR / C.win.w)), rPrev = 0;
        for (a = mMax(mFirst + J, m - Lb); a <= m; a++) { var x = M[a], y = M[a - J]; if (x === x && y === y && (x - y) / J > rPrev) rPrev = (x - y) / J; }
        return (M[m + j] - M[m]) / j > C.S.splitRatio * rPrev ? j : 0;
    }
    function _setStatus(C, ev) {
        var t = C.t, S = C.S;
        var gapClose = (t[ev.j1] - t[ev.j0]) > mMax(S.gapCloseN * C.dtMed, S.gapCloseMin * MIN);
        ev.alloc.date = dayOf(ev.tc_ms, C.day);
        if (gapClose) { ev.status = 'gap_at_closing'; ev.warnings.push(W('GAP_AT_CLOSING', 'warn', 'A data gap at the closing: the build-up is not analysed.', ['D4'])); }
        else if (ev.dtEnd_h < S.minDur_h) ev.status = 'too_short';
        else ev.status = 'analysable';
    }
    // The highest (sign-aware) sample of windows m − 1 … m + 1 ends the build-up at a reopening found at window m.
    function _endAtWindow(C, ev, m, mFirst) {
        var t = C.t, p = C.p, Wd = C.win, sign = C.sign;
        var ka = mMax(mFirst, m - 1), kb = mMin(Wd.K - 1, m + 1);
        var a = Wd.first[ka] >= 0 ? Wd.first[ka] : Wd.first[m], b = Wd.last[kb] >= 0 ? Wd.last[kb] : Wd.last[m];
        if (a < 0 || b < 0) { a = mMax(ev.j1, lowerBound(t, Wd.t0 + m * Wd.w) - 1); b = a; }
        var bi = mMax(a, ev.j1);
        for (var x = bi; x <= b; x++) if (sign * p[x] > sign * p[bi]) bi = x;
        ev.tEnd_ms = t[bi]; ev.endReason = 'reopen'; ev._endIdx = bi;
    }
    // The highest (sign-aware) sample of windows ka … kb ends the build-up (a reopening found by its fall).
    function _endAtRange(C, ev, ka, kb) {
        var t = C.t, p = C.p, Wd = C.win, sign = C.sign;
        var a = -1, b = -1, k;
        for (k = mMax(0, ka); k <= mMin(Wd.K - 1, kb); k++) { if (Wd.first[k] >= 0 && a < 0) a = Wd.first[k]; if (Wd.last[k] >= 0) b = Wd.last[k]; }
        if (a < 0 || b < 0) { a = mMax(ev.j1, lowerBound(t, Wd.t0 + kb * Wd.w) - 1); b = a; }
        var bi = mMax(a, ev.j1);
        for (var x = bi; x <= b; x++) if (sign * p[x] > sign * p[bi]) bi = x;
        ev.tEnd_ms = t[bi]; ev.endReason = 'reopen'; ev._endIdx = bi;
    }
    // End of the build-up: a persistent fall (every window up to +30 min, 2 h on an allocation day with no volume) to a
    // level below the one reached 30 min before; otherwise a gap or the data end. o {thr (fall threshold, default T_s),
    // tMax_ms (manual events: the search stops before the next event's closing; returns false when nothing was found),
    // split (detection: a sharper rise inside the event, _sharperRise, ends it before that rise's flowing-trend window)}.
    function _findEnd(C, ev, o) {
        o = o || {};
        var t = C.t, p = C.p, n = C.n, Wd = C.win, M = Wd.M, S = C.S;
        var thr = isNum(o.thr) && o.thr > 0 ? o.thr : C.Ts, tMax = isNum(o.tMax_ms) ? o.tMax_ms : INF;
        var mFirst = mFloor((t[ev.j1] - Wd.t0) / Wd.w);
        var gs = INF, gIdx = -1;
        for (var g = 0; g < C.gaps.length; g++) if (C.gaps[g].t0_ms >= t[ev.j1]) { gs = C.gaps[g].t0_ms; gIdx = lowerBound(t, gs); break; }
        var P = C.P, P2 = mMax(P, mCeil(S.shutDayPersist_h * HOUR / Wd.w));
        // the split needs room for the next event's flowing trend (max(30 min, 10·Δt_med)) after this event's first hour
        var Lt = mMax(S.trendMin * MIN, S.trendDtFactor * C.dtMed), runMax = -INF, lowRun = 0, lowStart = -1, deepRun = 0;
        var minRun = mMax(2 * C.J, mCeil(mMax(S.splitMin_h * HOUR, Lt + 30 * MIN) / Wd.w));
        for (var k0 = mMax(0, mFirst); k0 <= mFirst + 1 && k0 < Wd.K; k0++) if (M[k0] === M[k0] && M[k0] > runMax) runMax = M[k0];
        var M0 = M[mFirst] === M[mFirst] ? M[mFirst] : runMax;
        for (var m = mFirst + 1; m < Wd.K; m++) {
            if (Wd.t0 + m * Wd.w >= gs || Wd.t0 + m * Wd.w >= tMax) break;
            if (!(M[m] === M[m])) continue;
            if (M[m] > runMax) runMax = M[m];
            if (o.split && m - mFirst >= minRun && _sharperRise(C, m, mFirst, runMax, lowRun)) {
                // END_AT_RISE: the new closing came while the event held its level (the classification gate then takes the
                // event as a precursor of that closing): the event ends before that closing's flowing-trend window.
                // END_AT_CLOSING: the level had fallen first (a slow reopening the fall rule missed), so the event is a
                // shut-in of its own and ends at that fall (the flowing period up to the closing stays flowing).
                if (M[m] < runMax - C.Ts) {
                    _endAtRange(C, ev, mMax(mFirst, lowStart - C.J - 1), lowStart);
                    ev.warnings.push(W('END_AT_CLOSING', 'info', 'The pressure fell, then another closing starts inside this event: the event ends at the fall.', ['D1']));
                } else {
                    var li0 = mMax(ev.j1, lowerBound(t, Wd.t0 + m * Wd.w - Lt) - 1);
                    ev.tEnd_ms = t[li0]; ev._endIdx = li0; ev.endReason = 'reopen'; ev._noOpen = true;
                    ev.warnings.push(W('END_AT_RISE', 'info', 'A sharper pressure rise (another closing) starts inside this event: the event ends before it.', ['D1']));
                }
                ev._split = true;
                return true;
            }
            if (M[m] < runMax - C.Ts) { if (!lowRun) lowStart = m; lowRun++; } else lowRun = 0;
            // a deep fall (more than half of the rise the event had made, and more than 2·T_s) held for 30 min, after the
            // event's first hour, ends the event at the fall even when no single window fell by T_s (a slow reopening, a
            // large storage volume); a phase-redistribution hump is a small part of the rise and comes back
            if (o.split && m - mFirst >= minRun && M[m] < runMax - mMax(2 * C.Ts, 0.5 * (runMax - M0))) deepRun++; else deepRun = 0;
            // (the fall began where the level first left runMax − T_s: the start of the current low run)
            if (o.split && deepRun >= P) { _endAtRange(C, ev, mMax(mFirst, lowStart - C.J - 1), lowStart); return true; }
            var Pm = _inRanges(C.shutDays, Wd.t0 + m * Wd.w) ? P2 : P;
            var ok = true, cnt = 0, lastV = NaN;
            for (var ii = 1; ii <= Pm && m + ii < Wd.K; ii++) {
                if (Wd.t0 + (m + ii) * Wd.w >= gs) break;
                var v = M[m + ii];
                if (v === v) { cnt++; lastV = v; if (!(v - M[m] < -thr)) { ok = false; break; } }
            }
            if (!ok || cnt < 2) continue;
            var ri = mMax(m - P, mFirst);
            while (ri < m && !(M[ri] === M[ri])) ri++;
            if (!(lastV < M[ri])) continue;
            _endAtWindow(C, ev, m, mFirst);
            return true;
        }
        if (_isFin(tMax) && tMax < gs) return false;
        if (_isFin(gs)) {
            var li = mMax(ev.j1, gIdx);
            ev.tEnd_ms = t[li]; ev._endIdx = li;
            var after = medianRange(p, li + 1, mMin(n, li + 6)), before = medianRange(p, mMax(ev.j1, li - 4), li + 1);
            ev.endReason = (C.sign * (after - before) < -C.Ts) ? 'reopen' : 'gap';
            return true;
        }
        ev.tEnd_ms = t[n - 1]; ev._endIdx = n - 1; ev.endReason = 'data_end';
        return true;
    }

    function _ctx(record, q, opts) {
        var S = detectSettings(opts.settings);
        var t = record.t, p = record.p, n = t.length;
        var sign = (opts.fluid === 'water_inj') ? -1 : 1;
        var dtMed = (q && isNum(q.dtMed_s) && q.dtMed_s > 0 ? q.dtMed_s : 60) * SEC;
        var sig = q && isNum(q.sigma_psi) ? q.sigma_psi : 0;
        var w = mMax(S.winMin * MIN, 3 * dtMed);
        var day = opts.day ? { zone: opts.day.zone && opts.day.zone.mode !== 'device' ? opts.day.zone : resolveZone(opts.day.zone), startHour: num(+opts.day.startHour, 0) }
            : { zone: { mode: 'utc' }, startHour: 0 };
        return {
            record: record, qc: q, t: t, p: p, n: n, S: S, sign: sign, dtMed: dtMed, sigma: sig, sigFlow: q && isNum(q.sigmaFlow_psi) ? q.sigmaFlow_psi : sig,
            Ts: mMax(S.riseMin, S.riseSig * sig), J: mMax(1, mCeil(S.multiScaleMin * MIN / w)), P: mMax(2, mCeil(S.persistMin * MIN / w)),
            day: day, gaps: (q && q.gaps) || [], shutDays: (opts.shutDays || []).filter(function (r) { return r && isNum(r[0]) && isNum(r[1]); }),
            allocDays: (opts.allocDays || []).filter(function (d) { return d && isNum(d.t0_ms) && isNum(d.t1_ms) && d.t1_ms > d.t0_ms && isNum(d.V) && d.V >= 0; })
                .slice().sort(function (a, b) { return a.t0_ms - b.t0_ms; }),
            win: null, w: w, rateSteps: []
        };
    }

    // Allocation evidence for a detected event (daily mode, C.allocDays = [{t0_ms, t1_ms, V}] in the main phase).
    // V_ref = the median volume of up to 3 days before the closing day (within 10 days, no other event on them), else of
    // up to 3 days after the event. For every day the event covers for ≥ allocShutMin_h hours: the missing volume in
    // hours, hA = hours·(1 − V/V_ref), less the hours of the other events on that day (kept: the events already accepted
    // and the stronger members of a split chain); fA = hA/hours; confirm = hA ≥ half the shut hours. Returns null
    // without a reference, else {Vref, days:[{t0_ms, whole, fA, confirm}]}.
    function _overlapH(a0, a1, b0, b1) { return mMax(0, mMin(a1, b1) - mMax(a0, b0)) / HOUR; }
    function _allocCheck(C, ev, kept) {
        var days = C.allocDays, S = C.S, tc = ev.tc_ms, te = ev.tEnd_ms;
        if (!days.length || !(te > tc)) return null;
        function busy(d) { for (var i = 0; i < kept.length; i++) if (kept[i].tc_ms < d.t1_ms && kept[i].tEnd_ms > d.t0_ms) return true; return false; }
        function otherH(d) { var h = 0; for (var i = 0; i < kept.length; i++) h += _overlapH(kept[i].tc_ms, kept[i].tEnd_ms, d.t0_ms, d.t1_ms); return h; }
        var i0 = -1, iE = days.length, a, ref = [];
        for (a = 0; a < days.length; a++) if (days[a].t1_ms > tc) { i0 = a; break; }
        if (i0 < 0) return null;
        for (a = i0; a < days.length; a++) if (days[a].t0_ms >= te) { iE = a; break; }
        for (a = i0 - 1; a >= 0 && ref.length < 3; a--) {
            if (days[i0].t0_ms - days[a].t0_ms > 10.5 * DAY) break;
            if (days[a].V > 0 && !busy(days[a])) ref.push(days[a].V);
        }
        if (ref.length < 2) {
            for (a = iE; a < days.length && ref.length < 6; a++) {
                if (days[a].t0_ms - te > 10.5 * DAY) break;
                if (days[a].V > 0) ref.push(days[a].V);
            }
        }
        if (ref.length < 2) return null;
        var Vref = median(ref), out = { Vref: Vref, days: [] };
        if (!(Vref > 0)) return null;
        for (a = i0; a < iE; a++) {
            var d = days[a], sh = (mMin(te, d.t1_ms) - mMax(tc, d.t0_ms)) / HOUR, dh = (d.t1_ms - d.t0_ms) / HOUR;
            if (!(sh >= S.allocShutMin_h)) continue;
            var hA = mMax(0, dh * clamp(1 - d.V / Vref, 0, 1) - otherH(d));
            out.days.push({ t0_ms: d.t0_ms, whole: sh >= dh - 2, fA: hA / dh, confirm: hA >= 0.5 * sh });
        }
        return out;
    }
    // The allocation verdict on a detected event: 'drop' (no confirming day, and every whole day it covers has at most
    // allocModest of the reference volume missing: a day-rate step the allocation explains, not a shut-in), or the time
    // at which it must end (the first whole contradicting day after a confirming day, or ≥ allocBound_h after the closing
    // when no day confirms), or null.
    function _allocVerdict(C, ev, kept) {
        var ac = _allocCheck(C, ev, kept), S = C.S;
        if (!ac || !ac.days.length) return null;
        var conf = false, wholeMax = -1, cut = null;
        ac.days.forEach(function (x) { if (x.confirm) conf = true; if (x.whole) wholeMax = mMax(wholeMax, x.fA); });
        if (!conf && wholeMax >= 0 && wholeMax < S.allocModest) return { drop: true, fA: wholeMax };
        var seen = false;
        ac.days.forEach(function (x) {
            if (cut !== null) return;
            if (x.confirm) { seen = true; return; }
            if (x.whole && (seen || x.t0_ms >= ev.tc_ms + S.allocBound_h * HOUR)) cut = x.t0_ms;
        });
        return cut !== null ? { drop: false, cut_ms: cut, afterConfirm: seen } : null;
    }
    // Ends an event at the start of a production day the allocation contradicts (_allocVerdict cut_ms).
    function _cutEvent(C, ev, vd) {
        var li = mMax(ev.j1, lowerBound(C.t, vd.cut_ms) - 1);
        if (!(li < ev._endIdx)) return;
        ev.tEnd_ms = C.t[li]; ev._endIdx = li; ev.endReason = 'reopen'; ev._noOpen = true;
        ev.dtEnd_h = mMax(0, (ev.tEnd_ms - ev.tc_ms) / HOUR);
        ev.warnings = ev.warnings.filter(function (w) { return w.code !== 'END_AT_RISE' && w.code !== 'END_AT_CLOSING'; });
        var day = dayOf(vd.cut_ms, C.day);
        ev.warnings.push(W('END_ALLOC', 'warn', vd.afterConfirm
            ? 'The allocation shows the well producing again on ' + day + ' and the pressure shows no reopening: the event ends at the start of that day.'
            : 'No allocation day confirms a shut-in and ' + day + ' shows a full day of production: the event ends at the start of that day.', ['D1', 'R3']));
        _setStatus(C, ev);
    }

    // Sub-threshold steps T_p = max(2 psi, 6σ) ≤ Δ < T_s, flat for ≥ 2 h on both sides (possible partial cut or choke change).
    function _substeps(C, events) {
        var S = C.S, Wd = C.win, M = Wd.M, out = [];
        var Tp = mMax(S.stepMin_psi, S.stepSig * C.sigma);
        if (!(Tp < C.Ts)) return out;
        var H2 = mMax(2, mCeil(S.stepMin_h * HOUR / Wd.w)), half = mMax(1, H2 >> 1);
        var busy = new Uint8Array(Wd.K);
        events.forEach(function (e) {
            var a = mFloor((e.tc_ms - Wd.t0) / Wd.w) - H2, b = mFloor((e.tEnd_ms - Wd.t0) / Wd.w) + 3 * H2;
            for (var k = mMax(0, a); k <= mMin(Wd.K - 1, b); k++) busy[k] = 1;
        });
        function step(y) { return medianRange(M, y + 1, y + 1 + H2) - medianRange(M, y - H2 + 1, y + 1); }
        var pre = new Int32Array(Wd.K + 1);
        for (var z = 0; z < Wd.K; z++) pre[z + 1] = pre[z] + busy[z];
        function free(y) { return y - H2 + 1 >= 0 && y + H2 + 1 <= Wd.K && pre[y + H2 + 1] - pre[y - H2 + 1] === 0; }
        // coarse screen every q windows (a step shows at least half its size there), then the local maximum ±q
        var q = mMax(1, half >> 1), k = H2;
        while (k < Wd.K - H2) {
            if (!free(k)) { k += q; continue; }
            var d0 = step(k);
            if (!(mAbs(d0) >= 0.5 * Tp)) { k += q; continue; }
            var bk = k, bd = mAbs(d0);
            for (var y = mMax(H2, k - q); y <= mMin(Wd.K - H2 - 1, k + q); y++) { if (y === k || !free(y)) continue; var dd = mAbs(step(y)); if (dd > bd) { bd = dd; bk = y; } }
            var d = step(bk);
            if (!(mAbs(d) >= Tp && mAbs(d) < C.Ts)) { k += q; continue; }
            var b1 = medianRange(M, bk - H2 + 1, bk - H2 + 1 + half), b2 = medianRange(M, bk + 1 - half, bk + 1);
            var a1 = medianRange(M, bk + 1, bk + 1 + half), a2 = medianRange(M, bk + 1 + H2 - half, bk + 1 + H2);
            if (mAbs(b2 - b1) > 0.25 * mAbs(d) || mAbs(a2 - a1) > 0.25 * mAbs(d)) { k += q; continue; }
            out.push({ t_ms: Wd.t0 + (bk + 1) * Wd.w, dp_psi: C.sign * d, dur_h: S.stepMin_h });
            k = bk + H2;
        }
        return out;
    }

    // Table mode (D15): periods from the time-stamped rates; the rise detector only refines t_c within ±max(10 min, 5·Δt_med).
    // Index of the row before a tabled closing ramp: rows i0 < i that are non-zero, each lower than the row before it,
    // within tol_ms of the zero row i (a choke-back over a few minutes, logged row by row). Returns i − 1 when there is
    // no ramp. M§A3: the ramp is part of the closing (t_c at its midpoint, Δq the rate before it).
    function _tableRampStart(rows, i, tol_ms) {
        var r = i - 1;
        while (r >= 1 && mAbs(rows[r].q) > 0 && mAbs(rows[r].q) < mAbs(rows[r - 1].q) && rows[i].t_ms - rows[r].t_ms <= tol_ms) r--;
        return r;
    }
    function _detectTable(C, rt) {
        var t = C.t, n = C.n, S = C.S, events = [];
        var rows = (rt || []).filter(function (r) { return r && isNum(r.t_ms) && isNum(r.q); }).slice().sort(function (a, b) { return a.t_ms - b.t_ms; });
        var tol = mMax(S.tableTolMin * MIN, S.tableTolN * C.dtMed), prevEndIdx = -1;
        for (var i = 1; i < rows.length; i++) {
            if (!(mAbs(rows[i].q) === 0 && mAbs(rows[i - 1].q) > 0)) continue;
            var Tc = rows[i].t_ms, To = INF;
            for (var k = i + 1; k < rows.length; k++) if (mAbs(rows[k].q) > 0) { To = rows[k].t_ms; break; }
            if (Tc <= t[0] || Tc >= t[n - 1]) continue;
            // a closing ramp in the table (falling non-zero rows within the tolerance before the zero row) is part of the
            // closing: the rate before it is the pre-ramp row (as rateTable reads it)
            var ib = _tableRampStart(rows, i, tol);
            var tw = _trendWindow(C, lowerBound(t, Tc - tol) - 1, prevEndIdx + 1, Tc, prevEndIdx >= 0 ? t[prevEndIdx] : null);
            var j1 = _firstShut(C, tw.tr, lowerBound(t, Tc - tol), lowerBound(t, Tc + tol + C.w));
            if (j1 < 1) j1 = mMax(1, lowerBound(t, Tc));
            if (j1 >= n) continue;
            var endIdx = _isFin(To) ? mMax(j1, lowerBound(t, To) - 1) : n - 1;
            var ev = _newEvent(C, j1, tw.tr, tw.warnings, {
                tEnd_ms: t[endIdx], endReason: _isFin(To) ? 'reopen' : 'data_end', fhat: 1, qBefore: mAbs(rows[ib].q), qAfter: 0
            });
            Object.defineProperty(ev, '_tableClose', { value: Tc, enumerable: false, writable: true });
            refineClosing(C.record, ev, C.qc);
            if (mAbs(ev.tc_ms - Tc) > tol) {
                ev.tc_ms = mRound(Tc); ev.pwf0 = trendAt(tw.tr, Tc);
                ev.trend = trendRebase(tw.tr, ev.tc_ms); ev.pwf0SE = trendSE(tw.tr, ev.tc_ms);
                ev.dtEnd_h = (ev.tEnd_ms - ev.tc_ms) / HOUR;
            }
            ev.rise_psi = C.sign * (C.p[endIdx] - ev.pwf0);
            _setStatus(C, ev);
            ev._endIdx = endIdx;
            events.push(ev);
            prevEndIdx = endIdx;
        }
        return events;
    }

    // record + QC → {events, missed} (M§A2, M§A3, M§A5). opts {settings (detect), fluid, day {zone, startHour},
    // rateTable (table mode), shutDays [[t0_ms, t1_ms]] (allocation days with no volume: the end needs a 2-h fall)}
    // detectJob runs it in units (window medians; the scan, ≤ 20,000 windows or 10 events per unit; sub-threshold steps).
    function detectJob(record, q, opts) {
        opts = opts || {};
        var res = null, phase = 0, C = null, events = [], k = 0, prevEndIdx = -1, prevSplit = false, chain = [];
        var table = !!(opts.rateTable && opts.rateTable.length);
        if (!record || !record.t || record.t.length < 10) res = { events: [], missed: _missed([], [], null, q, 0) };
        // Allocation verdicts on a chain of candidates (each but the last ended at a sharper rise inside it; the last ended
        // at a reopening, a gap or the data end), strongest first (Δp one hour after the closing), so a day's missing volume
        // goes to the strongest event on it. Kept events join the list in time order; the scan resumes after the last
        // one, at its cut, or after its rise when it was dropped.
        function strength(e) {
            var h = mMin(1, mMax(0, num(e.dtEnd_h, 0)));
            var v = C.sign * (pAt(C.t, C.p, e.tc_ms + h * HOUR) - num(e.pwf0, 0));
            return isNum(v) ? v : 0;
        }
        function resolveChain() {
            var Wd = C.win, last = chain[chain.length - 1], acc = [];
            if (C.allocDays.length) {
                chain.slice().sort(function (a, b) { return strength(b.ev) - strength(a.ev) || a.ev.tc_ms - b.ev.tc_ms; }).forEach(function (c) {
                    var vd = _allocVerdict(C, c.ev, events.concat(acc));
                    if (vd && vd.drop) {
                        c.drop = true;
                        C.rateSteps.push({ t_ms: c.ev.tc_ms, dp_psi: C.sign * num(c.ev.rise_psi, 0), dur_h: mMax(0, num(c.ev.dtEnd_h, 0)), fAlloc: vd.fA });
                        return;
                    }
                    if (vd && isNum(vd.cut_ms)) _cutEvent(C, c.ev, vd);
                    acc.push(c.ev);
                });
            }
            chain.forEach(function (c) { if (!c.drop) events.push(c.ev); });
            chain = [];
            if (last.drop) {
                // a closing inside the dropped step's span gets its own candidate; the next trend starts after the last kept event
                k = mMax(last.k + 1, last.k + last.j + C.P + 1);
                var lk = events[events.length - 1];
                prevEndIdx = lk ? lowerBound(C.t, lk.tEnd_ms + 1) - 1 : -1;
                prevSplit = false;
            } else {
                prevEndIdx = last.ev._endIdx; prevSplit = !!last.ev._noOpen;
                k = mMax(last.k + 1, mFloor((last.ev.tEnd_ms - Wd.t0) / Wd.w) + 1);
            }
        }
        function scanUnit() {
            var Wd = C.win, M = Wd.M, perWin = mMax(1, C.n / mMax(1, Wd.K));
            var lim = mMin(Wd.K, k + mMax(1, mCeil(UNIT_SAMPLES / perWin))), nEv = 0;
            while (k < lim && nEv < 10) {
                if (!(M[k] === M[k])) { k++; continue; }
                var j = 0;
                for (var jj = 1; jj <= C.J && k + jj < Wd.K; jj++) { var v = M[k + jj]; if (v === v && v - M[k] > C.Ts) { j = jj; break; } }
                if (!j) { k++; continue; }
                var okp = true, cnt = 0, atEnd = (k + j + C.P >= Wd.K);
                for (var ii = 1; ii <= C.P && k + j + ii < Wd.K; ii++) {
                    var v2 = M[k + j + ii];
                    if (v2 === v2) { cnt++; if (!(v2 - M[k] > C.Ts)) { okp = false; break; } }
                }
                if (!okp || !(cnt >= 2 || (atEnd && cnt >= 1))) { k++; continue; }
                var ev = _eventAt(C, k, j, prevEndIdx, prevSplit);
                nEv++;
                chain.push({ ev: ev, k: k, j: j, drop: false });
                if (ev._split) {
                    // ended at another closing: its verdict waits for that closing (they may share a day)
                    prevEndIdx = ev._endIdx; prevSplit = !!ev._noOpen;
                    k = mMax(k + 1, mFloor((ev.tEnd_ms - Wd.t0) / Wd.w) + 1);
                    continue;
                }
                resolveChain();
            }
            if (k >= Wd.K && chain.length) resolveChain();
            return k >= Wd.K;
        }
        return {
            step: function () {
                if (res) return { done: true, progress: 1, label: 'Shut-ins found: ' + res.events.length };
                if (phase === 0) {
                    C = _ctx(record, q, opts);
                    C.win = _windows(C.t, C.p, C.n, C.w, C.sign);
                    phase = table ? 2 : 1;
                    if (table) events = _detectTable(C, opts.rateTable);
                    return { done: false, progress: 0.3, label: 'Window medians' };
                }
                if (phase === 1) {
                    if (scanUnit()) phase = 2;
                    return { done: false, progress: 0.3 + 0.5 * mMin(1, k / mMax(1, C.win.K)), label: 'Looking for shut-ins (' + events.length + ')' };
                }
                events.forEach(function (e, i) { e.id = 'E' + (i + 1); delete e._endIdx; delete e._split; delete e._noOpen; });
                var sub = table ? [] : _substeps(C, events);
                res = { events: events, missed: _missed(events, sub, null, q, C.Ts, C.rateSteps) };
                return { done: true, progress: 1, label: 'Shut-ins found: ' + events.length };
            },
            result: function () { return res; },
            cancel: function () {
                if (res) return;
                chain.forEach(function (c) { events.push(c.ev); });
                chain = [];
                events.forEach(function (e) { delete e._endIdx; delete e._split; delete e._noOpen; });
                res = { events: events, missed: _missed(events, [], null, q, C ? C.Ts : 0, C ? C.rateSteps : []) };
            }
        };
    }
    function detect(record, q, opts) { return runSync(detectJob(record, q, opts)); }
    // A manual event (override event_add or tc) at a typed closing time: trend, closing refinement and end as detected ones.
    // opts {exact, prevEnd_ms (the previous event's end), nextStart_ms (the next event's last flowing sample, t_j0),
    // subThreshold (missed.subThreshold of the detection)}. The end is bounded: a manual event never runs into the next
    // event (when no reopening is found before it, the event ends before the next event's flowing trend window). A
    // promoted sub-threshold step ends at the next sub-threshold fall, else at the first persistent fall of at least
    // T_p = max(2 psi, 6σ). Returns null when tc_ms is outside the record, leaves no room before the next event, or (not
    // exact) shows no pressure rise within ±max(10 min, 5·Δt_med); opts.out.reason ('outside'|'noRoom'|'noRise') says why.
    function eventAt(record, q, tc_ms, opts) {
        opts = opts || {};
        var out = opts.out && typeof opts.out === 'object' ? opts.out : {};
        if (!record || !record.t || record.t.length < 10 || !isNum(tc_ms)) { out.reason = 'outside'; return null; }
        if (tc_ms < record.t[0] || tc_ms > record.t[record.t.length - 1]) { out.reason = 'outside'; return null; }
        var C = _ctx(record, q, opts);
        C.win = _windows(C.t, C.p, C.n, C.w, C.sign);
        var t = C.t, tol = mMax(10 * MIN, 5 * C.dtMed), S = C.S;
        var nextStart = isNum(opts.nextStart_ms) && opts.nextStart_ms > tc_ms ? opts.nextStart_ms : INF;
        var tMax = nextStart - mMax(S.trendMin * MIN, S.trendDtFactor * C.dtMed);
        if (!(tMax > tc_ms)) { out.reason = 'noRoom'; return null; }
        var prevEndIdx = isNum(opts.prevEnd_ms) ? lowerBound(t, opts.prevEnd_ms + 1) - 1 : -1;
        var tw = _trendWindow(C, lowerBound(t, tc_ms - (opts.exact ? 0 : tol)) - 1, prevEndIdx + 1, tc_ms, isNum(opts.prevEnd_ms) ? opts.prevEnd_ms : null);
        var j1 = opts.exact ? lowerBound(t, tc_ms + 1) : _firstShut(C, tw.tr, lowerBound(t, tc_ms - tol), lowerBound(t, mMin(tc_ms + tol + C.w, tMax)));
        // a typed time with no pressure rise near it (a flowing period) is not a closing; an exact time forces the event
        if (!opts.exact && j1 < 1) { out.reason = 'noRise'; return null; }
        if (j1 < 1) j1 = mMax(1, lowerBound(t, tc_ms + 1));
        if (j1 >= C.n || !(t[j1] < tMax)) { out.reason = 'noRoom'; return null; }
        var ev = _newEvent(C, j1, tw.tr, tw.warnings, { manual: true });
        var sub = Array.isArray(opts.subThreshold) ? opts.subThreshold : [], near = mMax(tol, 2 * C.w), promo = null, found = false;
        sub.forEach(function (s) {
            if (s && isNum(s.t_ms) && C.sign * s.dp_psi > 0 && mAbs(s.t_ms - tc_ms) <= near && (!promo || mAbs(s.t_ms - tc_ms) < mAbs(promo.t_ms - tc_ms))) promo = s;
        });
        if (promo) {
            var reo = null, mFirst = mFloor((t[j1] - C.win.t0) / C.win.w);
            sub.forEach(function (s) { if (s && isNum(s.t_ms) && C.sign * s.dp_psi < 0 && s.t_ms > t[j1] && s.t_ms < tMax && (!reo || s.t_ms < reo.t_ms)) reo = s; });
            if (reo) {
                var mr = mMax(mFirst, mRound((reo.t_ms - C.win.t0) / C.win.w) - 1);
                if (mr < C.win.K) { _endAtWindow(C, ev, mr, mFirst); found = true; }
            }
            if (!found) found = _findEnd(C, ev, { thr: mMax(S.stepMin_psi, S.stepSig * C.sigma), tMax_ms: tMax });
            ev.warnings.push(W('SUBSTEP_PROMOTED', 'info', 'A sub-threshold step promoted to an event; its end is the next sub-threshold fall or the first fall of the step size.', ['D1']));
        } else found = _findEnd(C, ev, { tMax_ms: tMax });
        if (!found) {
            var li = mMax(j1, lowerBound(t, tMax) - 1);
            ev.tEnd_ms = t[li]; ev._endIdx = li; ev.endReason = 'reopen';
            ev.warnings.push(W('END_BOUNDED', 'warn', 'No reopening was found before the next shut-in: the event ends before the next closing.', ['D1']));
        }
        if (opts.exact) {
            ev.tc_ms = mRound(tc_ms); ev.pwf0 = trendAt(tw.tr, tc_ms); ev.dtc_s = 0;
            ev.trend = trendRebase(tw.tr, ev.tc_ms);
            ev.pwf0SE = trendSE(tw.tr, ev.tc_ms);
            ev.dtEnd_h = (ev.tEnd_ms - ev.tc_ms) / HOUR;
        } else refineClosing(record, ev, q);
        ev.rise_psi = C.sign * (C.p[ev._endIdx] - ev.pwf0);
        delete ev._endIdx;
        _setStatus(C, ev);
        return ev;
    }

    // M§A5 missed list. rateSteps (extra key): rises above T_s that the allocation explains as day-rate steps (not events).
    function _missed(events, sub, rh, q, Ts, rateSteps) {
        var gaps = ((q && q.gaps) || []).filter(function (g) { return g.dur_h >= D.DEFAULTS.qc.gapReport_h; }).map(function (g) { return { t0_ms: g.t0_ms, t1_ms: g.t1_ms }; });
        // detectability: p* − pwf is known only after interpretation; run fills it from median(p* − pwf0) of the tests
        return {
            subThreshold: sub || [], allocOnly: (rh && rh.allocOnly) || [], gaps: gaps, rateSteps: (rateSteps || []).slice(0, 200),
            detectability: { ok: true, pStarMinusPwf_psi: null, Ts_psi: Ts || 0 },
            tooShort: (events || []).filter(function (e) { return e.status === 'too_short'; }).map(function (e) { return e.id; }),
            interventions: (events || []).filter(function (e) { return e.status === 'intervention'; }).map(function (e) { return e.id; }),
            ev: ['D1']
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Classification gate (M§A4) and interventions
    // ─────────────────────────────────────────────────────────────────────
    function _dpAt(record, ev, dt_h) {
        var sign = ev.kind === 'falloff' ? -1 : 1;
        return sign * (pAt(record.t, record.p, ev.tc_ms + dt_h * HOUR) - ev.pwf0);
    }
    // Time of the derivative maximum (storage hump) from 10-per-cycle log bins and a Bourdet derivative (L = 0.2 ln).
    function _tDerivMax(record, ev) {
        var t = record.t, p = record.p, sign = ev.kind === 'falloff' ? -1 : 1;
        var a = lowerBound(t, ev.tc_ms + 1), b = lowerBound(t, ev.tEnd_ms + 1);
        var X = [], Y = [], cur = null, bt = [], bp = [];
        function flush() { if (bt.length) { X.push(mLog(median(bt))); Y.push(median(bp)); bt = []; bp = []; } }
        for (var i = a; i < b; i++) {
            var dt = (t[i] - ev.tc_ms) / HOUR; if (!(dt > 0)) continue;
            var bin = mFloor(10 * mLog10(dt));
            if (bin !== cur) { flush(); cur = bin; }
            bt.push(dt); bp.push(sign * (p[i] - ev.pwf0));
        }
        flush();
        var best = -INF, at = X.length ? mExp(X[0]) : 0, L = 0.2;
        for (var k = 1; k < X.length - 1; k++) {
            var jl = k - 1; while (jl > 0 && X[k] - X[jl] < L) jl--;
            var jr = k + 1; while (jr < X.length - 1 && X[jr] - X[k] < L) jr++;
            var d1 = X[k] - X[jl], d2 = X[jr] - X[k];
            if (!(d1 > 0 && d2 > 0)) continue;
            var der = ((Y[k] - Y[jl]) / d1 * d2 + (Y[jr] - Y[k]) / d2 * d1) / (d1 + d2);
            if (der > best) { best = der; at = mExp(X[k]); }
        }
        return at;
    }
    // ln Δt_e(Δt) of an event: superposition over the rate steps before t_c (exact Σ), or Horner with tp since the
    // previous reopening when no rate history is given. Returns null when the rate before closing is unknown.
    function _lnDteFn(ev, steps, tpH) {
        var tc = ev.tc_ms, terms = [], qN = 0, prev = 0;
        if (steps && steps.length) {
            for (var i = 0; i < steps.length && steps[i].t_ms < tc; i++) { var dq = steps[i].q - prev; if (dq !== 0) terms.push({ tau: (tc - steps[i].t_ms) / HOUR, dq: dq }); prev = steps[i].q; }
            qN = prev;
        }
        var fn;
        if (qN > 0 && terms.length) {
            fn = function (dt) { var s = mLog(dt); for (var k = 0; k < terms.length; k++) s -= (terms[k].dq / qN) * mLog((terms[k].tau + dt) / terms[k].tau); return s; };
            fn.c0 = 0; terms.forEach(function (tm) { fn.c0 += (tm.dq / qN) * mLog(tm.tau); });    // ln Δt_e as Δt → ∞
            return fn;
        }
        if (!(tpH > 0)) return null;
        fn = function (dt) { return mLog(tpH * dt / (tpH + dt)); };
        fn.c0 = mLog(tpH);
        return fn;
    }
    // p* estimate from the last 0.5 cycle of a build-up: p = a + m′·ln Δt_e, extrapolated to Δt → ∞ (the intervention
    // check only; the engine's p* comes from its own line).
    // Only a stable last cycle is extrapolated: the slope of the last 0.5 cycle within 30 % of the slope of the 0.5 cycle
    // before it (a build-up still in storage, in a dual-porosity transition or near a boundary gives a slope that is
    // still changing, and its p* would be far too low). Returns null otherwise.
    function _pStarEst(record, ev, fn) {
        if (!fn || !(ev.dtEnd_h >= 1)) return null;
        var t = record.t, p = record.p, sign = ev.kind === 'falloff' ? -1 : 1;
        function line(t0h, t1h) {
            var a = lowerBound(t, ev.tc_ms + t0h * HOUR), b = lowerBound(t, ev.tc_ms + t1h * HOUR + 1);
            if (b - a < 5) return null;
            var stride = mMax(1, mCeil((b - a) / 200)), sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
            for (var i = a; i < b; i += stride) { var x = fn((t[i] - ev.tc_ms) / HOUR), y = sign * p[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; m++; }
            var den = m * sxx - sx * sx;
            if (!(den > 0)) return null;
            var sl = (m * sxy - sx * sy) / den;
            return { sl: sl, ic: (sy - sl * sx) / m };
        }
        var L2 = line(ev.dtEnd_h / 3.16, ev.dtEnd_h), L1 = line(ev.dtEnd_h / 10, ev.dtEnd_h / 3.16);
        if (!L2 || !(L2.sl > 0) || !L1 || !(L1.sl > 0) || mAbs(L2.sl / L1.sl - 1) > 0.3) return null;
        return sign * (L2.ic + L2.sl * fn.c0);
    }
    // The previous build-up flattened: its rise over the last 0.5 cycle is below 0.5·T_s, so its last pressure is close to
    // the level it was heading for (the intervention check may then compare with it).
    function _flattened(record, ev, Ts) {
        if (!(ev.dtEnd_h >= 1)) return false;
        var sign = ev.kind === 'falloff' ? -1 : 1;
        var a = pAt(record.t, record.p, ev.tc_ms + ev.dtEnd_h * HOUR / 3.16), b = pAt(record.t, record.p, ev.tEnd_ms);
        return isNum(a) && isNum(b) && sign * (b - a) < 0.5 * Ts;
    }
    // f̂ from late Δp differences (M§A4 method 1): t2 = min(Δt_end)/1.26, t1 = t2/3.16, valid when t1 ≥ 3× the later
    // derivative maximum (both tests past storage, so skin cancels). The plan's ratio
    //   [Δp_ev(t2) − Δp_ev(t1)]/[Δp_ref(t2) − Δp_ref(t1)]·(q_ref/q_before)
    // assumes the decline left over from the earlier rate history is negligible between t1 and t2. Here that decline is
    // taken from the superposition (exact Σ over the rate steps, or Horner tp when there are none):
    //   f̂ = [ratio·L_ref + H_ev]/ln(t2/t1),  L_ref = ln Δt_e,ref(t2) − ln Δt_e,ref(t1),  H_ev = ln(t2/t1) − [ln Δt_e,ev(t2) − ln Δt_e,ev(t1)]
    // which equals the plan's ratio when the producing times are long, gives 1 for a full shut-in and f for a cut of f·q.
    function _fhatDpDiff(record, ev, ref, qRatio, fnEv, fnRef) {
        var C = D.DEFAULTS.classify;
        if (!fnEv || !fnRef) return null;
        var t2 = mMin(ev.dtEnd_h, ref.dtEnd_h) / C.t2Div, t1 = t2 / C.t1Div;
        if (!(t1 > 0)) return null;
        if (!(t1 >= C.tdmaxFactor * _tDerivMax(record, ev)) || !(t1 >= C.tdmaxFactor * _tDerivMax(record, ref))) return null;
        var a = _dpAt(record, ev, t2) - _dpAt(record, ev, t1), b = _dpAt(record, ref, t2) - _dpAt(record, ref, t1);
        if (!(mAbs(b) > 1e-9)) return null;
        var lr = mLog(t2 / t1), Lref = fnRef(t2) - fnRef(t1), Hev = lr - (fnEv(t2) - fnEv(t1));
        var f = ((a / b) * qRatio * Lref + Hev) / lr;
        return isNum(f) ? f : null;
    }
    // f̂ of a precursor (an event that ended at a sharper rise, END_AT_RISE) from the closing that follows it:
    // r = Δp_ev(Δt)/Δp_next(Δt) at Δt = min(1 h, half of each duration), f̂ = r/(1 + r). Null when it does not apply.
    // The split ends the precursor one flowing-trend window Lt = max(30 min, 10·Δt_med) before the window that holds the
    // sharper rise (_findEnd), and the closing follows that rise within the multi-scale reach, so the closing comes at
    // most max(2 h, Lt + 1.5 h) after the precursor's end (lead_ms = Lt; 2 h at Δt_med ≤ 1 min, 3.2 h at 10 min sampling).
    function _fhatChain(record, ev, nx, lead_ms) {
        if (!ev || !nx || nx.dropped || !_isShutKind(nx) || !isNum(ev.tEnd_ms) || !isNum(nx.tc_ms)) return null;
        if (!(ev.warnings || []).some(function (w) { return w.code === 'END_AT_RISE'; })) return null;
        var gapMax = mMax(2 * HOUR, (isNum(lead_ms) ? lead_ms : 30 * MIN) + 1.5 * HOUR);
        if (!(nx.tc_ms - ev.tEnd_ms <= gapMax) || !(nx.tc_ms > ev.tc_ms)) return null;
        var dts = mMin(1, 0.5 * num(ev.dtEnd_h, 0), 0.5 * num(nx.dtEnd_h, 0));
        if (!(dts > 0)) return null;
        var a1 = _dpAt(record, ev, dts), a2 = _dpAt(record, nx, dts);
        if (!(a1 > 0) || !(a2 > 0)) return null;
        var f = (a1 / a2) / (1 + a1 / a2);
        return isNum(f) ? f : null;
    }
    function _segmentOf(date, workovers) {
        var s = 0; (workovers || []).forEach(function (w) { if (typeof w === 'string' && date && w <= date) s++; }); return s;
    }
    function _isShutKind(e) { return e && (e.kind === 'shutin' || e.kind === 'falloff'); }
    function _dayContaining(days, ms) {
        if (!days) return null;
        for (var i = 0; i < days.length; i++) if (ms >= days[i].t0_ms && ms < days[i].t1_ms) return days[i];
        return null;
    }

    // events + record + preliminary days (rates computed with every event as a full shut-in) → events with kind, status,
    // fhat, fhatMethod and alloc set (M§A4), interventions flagged. opts {rh (preliminary RateHistory), workovers, settings
    // (detect), table (bool), pExt {[eventId]: psia} (optional), Ts, dtMed_s (QC median sampling interval: the precursor gap)}
    function classifyJob(events, record, days, opts) {
        opts = opts || {};
        var C = D.DEFAULTS.classify, S = detectSettings(opts.settings);
        var rh = opts.rh || null, byEv = (rh && rh.byEvent) || {};
        var dayList = days || (rh && rh.days) || null;
        var table = !!opts.table || !!(rh && rh.mode === 'table');
        var hasAlloc = !!(dayList && dayList.length) && !table;
        var prevShuts = [], fnCache = {}, stp = rh && rh.steps;
        // the split rule's flowing-trend window (the precursor ends this long before the sharper rise, _findEnd)
        var leadMs = mMax(S.trendMin * MIN, S.trendDtFactor * (isNum(+opts.dtMed_s) && +opts.dtMed_s > 0 ? +opts.dtMed_s : 60) * SEC);
        function lnFn(e) {
            if (fnCache[e.id] !== undefined) return fnCache[e.id];
            var open = record.t[0] - D.DEFAULTS.rates.prependMin_h * HOUR, k2 = events.indexOf(e);
            for (var z = k2 - 1; z >= 0; z--) if (events[z] && isNum(events[z].tEnd_ms) && !events[z].dropped && events[z].kind !== 'substep') { open = events[z].tEnd_ms; break; }
            fnCache[e.id] = _lnDteFn(e, stp, (e.tc_ms - open) / HOUR);
            return fnCache[e.id];
        }
        // rate before a closing: the closing day's reference rate (clean days), else Δq of the preliminary pass (which spreads
        // a partial cut's volume as if it were a full shut-in)
        function qOfEv(x) { var b0 = byEv[x.id]; return (b0 && isNum(b0.qRef) && b0.qRef > 0) ? b0.qRef : ((b0 && b0.Dq) || x.qBefore); }
        function one(ev, idx) {
            if (!ev || ev.dropped) return;
            if (!_isShutKind(ev)) return;
            var Ts = isNum(ev.Ts_psi) ? ev.Ts_psi : num(opts.Ts, 5);
            ev.warnings = ev.warnings || [];
            var alloc = { date: ev.alloc && ev.alloc.date ? ev.alloc.date : civil(ev.tc_ms), ratio: null, pass: null, ignoresShutin: false,
                          confirm: table ? 'n/a' : (hasAlloc ? 'not_confirmed' : 'no_alloc') };
            var confirmed = false, contra = false, volDay = false;
            if (hasAlloc) {
                var cd = _dayContaining(dayList, ev.tc_ms), r3pass = false, r3fail = false, zeroDay = false;
                if (cd) {
                    alloc.date = cd.date;
                    if (cd.R3) { alloc.ratio = cd.R3.ratio; alloc.pass = cd.R3.pass; }
                    alloc.ignoresShutin = !!cd.ignoresShutin;
                    r3pass = !!(cd.R3 && cd.R3.status === 'pass');
                    r3fail = !!(cd.R3 && cd.R3.status === 'fail');
                    // a closing day with fewer than closeDayMin_h flowing hours has R3 'unavailable' (too little volume
                    // for a rate check), but its volume still shows whether the well was shut for the rest of the day:
                    // the flowing hours it implies at q_ref, hours·V/q_ref, agree with the detected ones within
                    // r3Tol·hours (plus the volume resolution) → the allocation confirms the full shut-in hours (M§A4 method 2)
                    var RD = D.DEFAULTS.rates;
                    if (cd.R3 && cd.R3.status === 'unavailable' && isNum(cd.qRef) && cd.qRef > 0 && isNum(cd.hEff) && cd.hEff < RD.closeDayMin_h && isNum(cd.V)) {
                        var hImp = cd.hours * cd.V / cd.qRef, tolH = RD.r3Tol * cd.hours + 24 * num(cd.vRes, 1) / cd.qRef;
                        alloc.hoursCheck = { implied_h: hImp, detected_h: cd.hEff, tol_h: tolH, pass: mAbs(hImp - cd.hEff) <= tolH };
                        if (alloc.hoursCheck.pass) r3pass = true;
                    }
                }
                // whole days inside the shut-in: no volume confirms it, volume contradicts it. A shut-in still running at
                // the data end counts as shut to the end of that day (as in rates): a day with no volume there confirms it,
                // a volume there does not contradict it (the well may have reopened after the data end).
                // (an event that ends at a day start — a cut, a reopening at midnight — ends on its last sample before it:
                // 10 min of slack)
                var tEndA = ev.tEnd_ms + 10 * MIN;
                if (ev.endReason === 'data_end') { var ld = _dayContaining(dayList, ev.tEnd_ms - 1); if (ld && ld.t1_ms > tEndA) tEndA = ld.t1_ms; }
                dayList.forEach(function (d) {
                    if (d.t0_ms >= ev.tc_ms && d.t1_ms <= tEndA) {
                        if (d.V <= num(d.vRes, 1) + 1e-9) zeroDay = true;
                        else if (d.t1_ms <= ev.tEnd_ms + 10 * MIN) volDay = true;
                    }
                });
                // a whole day with no volume confirms the shut-in even when the closing day's R3 fails (a rate change on
                // the closing day fails R3 without contradicting the shut-in; the R3 failure stays in the rate checks)
                confirmed = (r3pass || zeroDay) && !volDay;
                contra = volDay || (r3fail && !zeroDay);
                alloc.confirm = confirmed ? 'confirmed' : 'not_confirmed';
            }
            ev.alloc = alloc;
            if (table) {
                ev.fhat = 1; ev.fhatMethod = null;
            } else {
                // method 1: dpDiff against the nearest full build-up of the same workover segment
                var seg = _segmentOf(alloc.date, opts.workovers), f1 = null, ref = null;
                for (var r = idx - 1; r >= 0; r--) {
                    var e2 = events[r];
                    if (!_isShutKind(e2) || e2.status !== 'analysable' || e2.dropped) continue;
                    if (_segmentOf(e2.alloc && e2.alloc.date, opts.workovers) !== seg) break;
                    if (e2.fhat != null && e2.fhat < C.fShut && e2.fhatMethod !== 'allocation') continue;
                    ref = e2; break;
                }
                if (ref && ev.dtEnd_h > 0 && ref.dtEnd_h > 0) {
                    var qe = qOfEv(ev), qr = qOfEv(ref);
                    var qRatio = (isNum(qe) && qe > 0 && isNum(qr) && qr > 0) ? qr / qe : 1;
                    f1 = _fhatDpDiff(record, ev, ref, qRatio, lnFn(ev), lnFn(ref));
                }
                // method 3: proxy (flag only), m′_flow from the flowing trend slope × the time since the last reopening
                var fProxy = null;
                if (ev.dtEnd_h >= 4 && ev.trend && isNum(ev.trend.b)) {
                    var sign = ev.kind === 'falloff' ? -1 : 1, tOpen = record.t[0];
                    for (var q2 = idx - 1; q2 >= 0; q2--) if (events[q2] && isNum(events[q2].tEnd_ms) && !events[q2].dropped) { tOpen = events[q2].tEnd_ms; break; }
                    var mp = -sign * ev.trend.b * (ev.tc_ms - tOpen) / HOUR;
                    if (mp > 0) fProxy = (_dpAt(record, ev, 4) - _dpAt(record, ev, 1)) / (mp * mLog(4));
                }
                ev.fhatProxy = isNum(fProxy) ? fProxy : null;
                // a precursor: the event ended at a sharper rise (END_AT_RISE: a closing followed while it was still at its
                // level), so it cut part of the rate and the closing cut the rest. With the same well response,
                // Δp_ev(Δt)/Δp_next(Δt) = f/(1 − f) at the same Δt after each closing (superposition; skin and storage
                // cancel), so f̂ = r/(1 + r) (method 'derivRatio'). The allocation of the day they share cannot separate them.
                var fChain = _fhatChain(record, ev, events[idx + 1], leadMs);
                // (rateEnd_ms, extra key: the cut lasts until that closing, so the rate history carries no full-rate gap
                // over the closing's trend window and the closing's Δq is the rate the cut left)
                if (fChain !== null) { f1 = fChain; confirmed = false; ev.rateEnd_ms = events[idx + 1].tc_ms; }
                if (confirmed) {
                    ev.fhat = 1; ev.fhatMethod = 'allocation';
                    if (f1 !== null) ev.fhatDpDiff = f1;
                    if (f1 !== null && f1 < C.fInterp) ev.warnings.push(W('ALLOC_VS_PRESSURE', 'warn', 'The allocation says shut-in, the pressure says a partial cut (rate fraction ' + f1.toFixed(2) + ').', ['D6']));
                } else if (f1 !== null) {
                    ev.fhat = f1; ev.fhatMethod = fChain !== null ? 'derivRatio' : 'dpDiff';
                    if (f1 >= C.fShut) {
                        // full shut-in by the pressure; an allocation that contradicts it is reported, not followed (the
                        // pressure response is the stronger evidence; a 0.9–0.95 step expects residual volume anyway)
                        if (contra && !alloc.ignoresShutin) ev.warnings.push(W('ALLOC_CONTRADICTS', 'warn', 'The allocation contradicts the shut-in (volume on the closing day or on whole days inside it); the pressure response (rate fraction ' + f1.toFixed(2) + ') is used.', ['D6']));
                    }
                    else if (f1 >= C.fInterp) ev.warnings.push(W('RATE_FRACTION', 'warn', 'Rate step interpreted with ' + f1.toFixed(3) + ' of the rate before closing.', ['D6', 'R1']));
                    else if (f1 >= C.fPartial) {
                        if (S.partial) { ev.kind = 'partial'; ev.status = 'partial'; }
                        else { ev.kind = 'substep'; ev.status = 'not_confirmed'; }
                        ev.warnings.push(W('PARTIAL_CUT', 'info', 'Partial rate cut (rate fraction removed ' + f1.toFixed(2) + '): entered in the rate history, not interpreted.', ['D6']));
                    } else {
                        // the gate measured that the rate barely changed: no rate step enters the history (a q = 0 period
                        // here would put a fictitious shut-in into every later test); listed with the sub-threshold steps
                        ev.gateDp_psi = (ev.kind === 'falloff' ? -1 : 1) * num(ev.rise_psi, 0);    // real psi, as missed.subThreshold
                        ev.kind = 'substep'; ev.status = 'not_confirmed'; ev.gateSubstep = true;
                        ev.warnings.push(W('NOT_CONFIRMED', 'warn', 'The pressure response is too small for a shut-in (rate fraction ' + f1.toFixed(2) + '): no rate change is entered; listed with the sub-threshold steps.', ['D6']));
                    }
                } else if (hasAlloc && volDay) {
                    // the allocation shows production on whole days inside the event and no pressure measure says shut-in:
                    // a rate change the day rates already carry (a choke change, a day-rate step), not a q = 0 period
                    ev.fhat = ev.fhatProxy; ev.fhatMethod = isNum(ev.fhatProxy) ? 'proxy' : null;
                    ev.gateDp_psi = (ev.kind === 'falloff' ? -1 : 1) * num(ev.rise_psi, 0);
                    ev.kind = 'substep'; ev.status = 'not_confirmed'; ev.gateSubstep = true;
                    ev.warnings.push(W('NOT_CONFIRMED', 'warn', 'The allocation shows production on whole days inside this event and no reference build-up confirms a shut-in: no rate change is entered (the day rates stand); listed with the sub-threshold steps.', ['D6', 'R3']));
                } else {
                    ev.fhat = ev.fhatProxy; ev.fhatMethod = isNum(ev.fhatProxy) ? 'proxy' : null;
                    if (ev.status === 'analysable') {
                        ev.status = 'not_confirmed';
                        ev.warnings.push(W('NOT_CONFIRMED', 'warn', contra ? 'The allocation contradicts a shut-in and no reference build-up confirms it.'
                            : 'Neither the allocation nor a reference build-up confirms a full shut-in.', ['D6']));
                    }
                }
            }
            if (_isShutKind(ev) && (ev.status === 'analysable' || ev.status === 'too_short')) {
                // reference: the highest of the last 3 analysable build-ups of the same workover segment (one short or
                // unstable earlier build-up does not make a later, longer one an intervention)
                var segI = _segmentOf(ev.alloc && ev.alloc.date, opts.workovers), refX = null;
                prevShuts.filter(function (x) { return x.seg === segI; }).slice(-3).forEach(function (x) { if (x.ref !== null && (refX === null || x.ref > refX.ref)) refX = x; });
                _intervention(ev, refX, record, Ts, qOfEv(ev));
                if (ev.status === 'analysable') prevShuts.push({ seg: segI, ref: _refPressure(record, ev, lnFn(ev), Ts, opts), pwf0: (ev.kind === 'falloff' ? -1 : 1) * num(ev.pwf0, 0), dq: qOfEv(ev) });
            }
        }
        var list = events || [], i = 0;
        return {
            step: function () {
                var lim = mMin(list.length, i + 10);
                for (; i < lim; i++) one(list[i], i);
                return { done: i >= list.length, progress: list.length ? i / list.length : 1, label: 'Classifying shut-ins' };
            },
            result: function () { return i >= list.length ? list : null; },
            cancel: function () { i = list.length; }
        };
    }
    function classify(events, record, days, opts) { return runSync(classifyJob(events, record, days, opts)); }
    // Intervention: the pressure exceeds the previous p_ext (or the previous build-up's last pressure) by more than 2·T_s,
    // or it rises and then falls by more than T_s inside the event (after the first hour) without recovering.
    // The reference pressure of an analysable build-up for the intervention check (sign-aware): its p_ext when given, else
    // its p* from a stable last cycle, else its highest pressure when it had flattened; null for a build-up still rising
    // (any longer build-up would pass its last pressure).
    function _refPressure(record, prev, fn, Ts, opts) {
        var t = record.t, p = record.p, sign = prev.kind === 'falloff' ? -1 : 1;
        if (opts.pExt && isNum(opts.pExt[prev.id])) return sign * opts.pExt[prev.id];
        var ps = _pStarEst(record, prev, fn);
        if (isNum(ps)) return sign * ps;
        if (!_flattened(record, prev, Ts)) return null;
        var m = _robustMax(record, sign, prev.tc_ms, prev.tEnd_ms);
        return _isFin(m) ? m : null;
    }
    // refX {ref, pwf0} (sign-aware) of the reference build-up, or null. The margin is the larger of interventionTs·T_s and
    // interventionFrac of the reference build-up's own rise (its p* extrapolation carries an error of that order).
    // The highest 10-min median (≥ 3 samples) of sign·p between two times (a spike is not a level); the raw maximum when
    // no window has 3 samples.
    function _robustMax(record, sign, t0, t1) {
        var t = record.t, p = record.p, a = lowerBound(t, t0 + 1), b = lowerBound(t, t1 + 1), best = -INF, raw = -INF, i;
        for (i = a; i < b; i++) if (sign * p[i] > raw) raw = sign * p[i];
        for (var s = t0; s < t1; s += 10 * MIN) {
            var i0 = lowerBound(t, s), i1 = lowerBound(t, mMin(t1, s + 10 * MIN) + 1);
            if (i1 - i0 >= 3) { var v = sign * medianRange(p, i0, i1); if (v > best) best = v; }
        }
        return _isFin(best) ? best : raw;
    }
    // refX {ref, pwf0, dq} (sign-aware) of the reference build-up, or null; dqEv: the rate before this closing. The margin
    // is the larger of interventionTs·T_s and interventionFrac of the reference build-up's own rise (its p*
    // extrapolation carries an error of that order). A reference whose rise per unit rate is less than a third of this
    // event's was not a comparable full shut-in (a rate step, a partial cut): no comparison with it.
    function _intervention(ev, refX, record, Ts, dqEv) {
        var t = record.t, p = record.p, sign = ev.kind === 'falloff' ? -1 : 1;
        var a = lowerBound(t, ev.tc_ms + 1), b = lowerBound(t, ev.tEnd_ms + 1);
        if (b - a < 3) return;
        // the level of the second half of the event (an early phase-redistribution hump is not a higher reservoir pressure)
        var pmax = _robustMax(record, sign, ev.tc_ms + 0.5 * (ev.tEnd_ms - ev.tc_ms), ev.tEnd_ms);
        var DD = D.DEFAULTS.detect, refP = refX ? refX.ref : null;
        var margin = refX ? mMax(DD.interventionTs * Ts, DD.interventionFrac * mMax(0, refX.ref - refX.pwf0)) : INF;
        if (refX) {
            var rN = pmax - sign * num(ev.pwf0, 0), rR = refX.ref - refX.pwf0;
            var nN = (isNum(dqEv) && dqEv > 0) ? rN / dqEv : rN, nR = (isNum(refX.dq) && refX.dq > 0 && isNum(dqEv) && dqEv > 0) ? rR / refX.dq : rR;
            if (!(rR > 0) || nN > 3 * nR) refP = null;
        }
        if (refP !== null && pmax - refP > margin) {
            ev.status = 'intervention';
            ev.warnings.push(W('INTERVENTION', 'warn', 'Pressure ' + (pmax - refP).toFixed(1) + ' psi above the previous extrapolated pressure: suspected intervention, not interpreted. Enter a workover date if one took place.', ['D1']));
            return;
        }
        var w = 30 * MIN, meds = [];
        for (var s = ev.tc_ms + HOUR; s + w <= ev.tEnd_ms; s += w) {
            var i0 = lowerBound(t, s), i1 = lowerBound(t, s + w);
            if (i1 - i0 >= 2) meds.push(sign * medianRange(p, i0, i1));
        }
        if (meds.length >= 3) {
            var mx = -INF, mi = -1;
            meds.forEach(function (v, q) { if (v > mx) { mx = v; mi = q; } });
            var tail = meds.slice(mi + 1), k0 = -1;
            for (var z = 0; z < tail.length; z++) if (tail[z] < mx - Ts) { k0 = z; break; }
            // the pressure rose into the peak by more than T_s inside the window (a renewed rise: the early peak of a
            // phase-redistribution hump is not one), and the fall comes within 6 h of the peak (an intervention ends
            // quickly; a slow roll-over over days is the depletion or interference a build-up can show)
            var rose = meds.slice(0, mi).some(function (v) { return v < mx - Ts; });
            if (rose && k0 >= 0 && k0 < 12 && mx - tail[tail.length - 1] > Ts && tail.slice(k0).every(function (v) { return v < mx - 0.5 * Ts; })) {
                ev.status = 'intervention';
                ev.warnings.push(W('INTERVENTION', 'warn', 'Pressure rose and then fell by ' + (mx - tail[tail.length - 1]).toFixed(1) + ' psi inside the shut-in: suspected intervention, not interpreted.', ['D1']));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Allocation import (§3.6)
    // ─────────────────────────────────────────────────────────────────────
    var G_FACTOR = { Mscf: 1, MMscf: 1000, Sm3: 0.0353147 };
    function _dateText(s, dayFirst) {
        s = String(s || '').trim().replace(/^"(.*)"$/, '$1');
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
        if (m) { var ms = dateUTC(+m[1], +m[2] - 1, +m[3]); var c = civil(ms); return (+m[2] >= 1 && +m[2] <= 12) ? c : null; }
        var d = _parseDMY(s.split(/[ T]/)[0], dayFirst);
        if (d === d) return civil(d);
        var v = +s;
        if (isNum(v) && v > 20000 && v < 80000) return civil(mRound((v - 25569) * DAY));
        return null;
    }
    // Detected rounding unit of a column: the largest power of ten that divides every non-zero value.
    function _resolution(vals) {
        var nz = vals.filter(function (v) { return isNum(v) && v !== 0; });
        if (!nz.length) return null;
        var units = [1000, 100, 10, 1, 0.1, 0.01, 0.001];
        for (var i = 0; i < units.length; i++) {
            var u = units[i], ok = true;
            for (var k = 0; k < nz.length && ok; k++) { var r = nz[k] / u; if (mAbs(r - mRound(r)) > 1e-6 * mMax(1, mAbs(r))) ok = false; }
            if (ok) return u;
        }
        return 0.001;
    }
    // text → {ok, rows:[AllocRow], errors:[{line, text}], gUnit, resolution:{oil, gas, water}}
    function parseAllocation(text, opts) {
        opts = opts || {};
        var gUnit = G_FACTOR[opts.gUnit] ? opts.gUnit : 'Mscf', gf = G_FACTOR[gUnit];
        var errors = [];
        var all = String(text || '').split(/\r\n|\n|\r/);
        var lines = [];
        all.forEach(function (l, i) { if (l && l.trim() && l.trim()[0] !== '#') lines.push({ l: l, n: i + 1 }); });
        if (!lines.length) return { ok: false, rows: [], errors: [{ line: 0, text: 'No allocation rows.' }], gUnit: gUnit, resolution: { oil: null, gas: null, water: null } };
        var sn = sniff(lines.slice(0, 30).map(function (x) { return x.l; }).join('\n'));
        var sep = sn.sep, decComma = sep !== ',';
        var first = _split(lines[0].l, sep, false), hl = first.map(function (h) { return String(h).toLowerCase(); });
        var header = first.some(function (f) { return f !== '' && !_isNumText(f) && !_dateText(f, true); });
        var cols = { date: -1, oil: -1, gas: -1, water: -1, hours: -1 };
        if (header) {
            var used = [];
            var pick = function (re, not) { for (var i = 0; i < hl.length; i++) if (used.indexOf(i) === -1 && re.test(hl[i]) && !(not && not.test(hl[i]))) { used.push(i); return i; } return -1; };
            cols.date = pick(/date|day/);
            cols.hours = pick(/hour|hrs|uptime|online|on.?time|^h$/);
            cols.water = pick(/water|wat|bwpd|^w$/);
            cols.gas = pick(/gas|mscf|scf|sm3|^g$/);
            cols.oil = pick(/oil|bopd|stb|cond|liq|^o$/, /gas/);
        } else { cols = { date: 0, oil: 1, gas: 2, water: 3, hours: 4 }; }
        if (opts.cols) Object.keys(opts.cols).forEach(function (k) { if (isNum(opts.cols[k])) cols[k] = opts.cols[k]; });
        if (cols.date < 0) cols.date = 0;
        var dayFirst = opts.dayFirst != null ? !!opts.dayFirst : true;
        var map = {};
        var vals = { oil: [], gas: [], water: [] };
        (header ? lines.slice(1) : lines).forEach(function (x) {
            var f = _split(x.l, sep, false);
            var date = _dateText(f[cols.date], dayFirst);
            if (!date) { errors.push({ line: x.n, text: 'No valid date: ' + String(f[cols.date] || '').slice(0, 40) }); return; }
            function v(c) { if (c < 0 || f[c] === undefined || f[c] === '') return null; var y = _num(f[c].trim(), decComma); return isNum(y) && y >= 0 ? y : null; }
            var oil = v(cols.oil), gas = v(cols.gas), water = v(cols.water), hours = v(cols.hours);
            if (oil === null && gas === null && water === null) { errors.push({ line: x.n, text: 'No volume on ' + date }); return; }
            if (map[date]) errors.push({ line: x.n, text: 'Duplicate date ' + date + ': the later row is used.' });
            if (oil !== null) vals.oil.push(oil); if (gas !== null) vals.gas.push(gas); if (water !== null) vals.water.push(water);
            map[date] = { date: date, oil: oil, gas: gas === null ? null : gas * gf, water: water, hours: hours === null ? null : mMin(hours, 25) };
        });
        var rows = Object.keys(map).sort().map(function (k) { return map[k]; });
        var rg = _resolution(vals.gas);
        return { ok: rows.length > 0, rows: rows, errors: errors, gUnit: gUnit,
                 resolution: { oil: _resolution(vals.oil), gas: rg === null ? null : rg * gf, water: _resolution(vals.water) } };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Rates (§4.5, M§A6, M§A7)
    // ─────────────────────────────────────────────────────────────────────
    function _intervals(events, fullShut) {
        var ivs = [];
        (events || []).forEach(function (e) {
            if (!e || e.dropped) return;
            if (!(e.kind === 'shutin' || e.kind === 'falloff' || e.kind === 'partial')) return;
            if (!isNum(e.tc_ms) || !isNum(e.tEnd_ms) || !(e.tEnd_ms > e.tc_ms)) return;
            var f = (e.kind === 'partial' && !fullShut) ? clamp(num(e.fhat, 1), 0, 1) : 1;
            // a shut-in interpreted with Δq·f̂ (0.9 ≤ f̂ < 0.95) keeps q = 0 in the steps, but the residual (1 − f̂)·q still
            // carries volume when the day's rate is spread (fv)
            var fv = (!fullShut && e.kind !== 'partial' && e.fhatMethod === 'dpDiff' && isNum(e.fhat) && e.fhat >= 0.9 && e.fhat < 0.95) ? e.fhat : f;
            var half = (e.ramp && e.ramp.present && e.ramp.dur_s > 0) ? mRound(e.ramp.dur_s * SEC / 2) : 0;
            if (half > 0) ivs.push({ t0: e.tc_ms - half, t1: e.tc_ms, f: 0.5, fv: 0.5, ramp: true, id: e.id, ev: e });
            var t1 = (isNum(e.rateEnd_ms) && e.rateEnd_ms > e.tEnd_ms) ? e.rateEnd_ms : e.tEnd_ms;    // a precursor: to the next closing
            ivs.push({ t0: e.tc_ms, t1: t1, f: f, fv: fv, ramp: false, id: e.id, ev: e });
        });
        return ivs.sort(function (a, b) { return a.t0 - b.t0 || (a.ramp ? -1 : 1); });
    }
    // Fraction of the day's rate flowing at ms (1 = full rate, 1 − f in a partial cut, 0 shut).
    function _fracAt(ivs, ms, vol) {
        var fr = 1;
        for (var i = 0; i < ivs.length; i++) { if (ivs[i].t0 > ms) break; if (ms < ivs[i].t1) fr = 1 - (vol ? ivs[i].fv : ivs[i].f); }
        return fr;
    }
    function _pieces(ivs, a, b) {
        var cuts = [a, b];
        ivs.forEach(function (iv) { if (iv.t0 > a && iv.t0 < b) cuts.push(iv.t0); if (iv.t1 > a && iv.t1 < b) cuts.push(iv.t1); });
        cuts.sort(function (x, y) { return x - y; });
        var out = [];
        for (var i = 0; i + 1 < cuts.length; i++) {
            if (cuts[i + 1] <= cuts[i]) continue;
            var mid = 0.5 * (cuts[i] + cuts[i + 1]);
            out.push({ a: cuts[i], b: cuts[i + 1], frac: _fracAt(ivs, mid), fracV: _fracAt(ivs, mid, true) });
        }
        return out;
    }
    function _hours(pieces) {
        var on = 0, eff = 0;
        pieces.forEach(function (pc) { var h = (pc.b - pc.a) / HOUR; if (pc.frac > 0) on += h; eff += pc.fracV * h; });
        return { on: on, eff: eff };
    }
    function _unitFor(fluid, basis) {
        if (fluid === 'water_inj' || basis === 'total') return 'bbl/d';
        if (fluid === 'gas') return 'Mscf/d';
        return 'STB/d';
    }

    // record + events + allocation rows → RateHistory (daily mode). opts {fluid, day {zone, startHour}, history {mode, date,
    // cum}, B, Bw, Rs, Pb, gas {sg, T_F, apiCond, Mo, wcond}, resolution {oil, gas, water}, gaps (QC), depthShift_psi,
    // closeDayMin_h, wcLimit, gorFactor, fullShut (preliminary pass: partial cuts as full shut-ins)}
    // Sets ev.qBefore / ev.qAfter on the events it uses; byEvent carries Δq and the rate checks per event.
    function rates(record, events, rows, opts) {
        opts = opts || {};
        var R = Object.assign({}, D.DEFAULTS.rates);
        ['closeDayMin_h', 'wcLimit', 'gorFactor'].forEach(function (k) { if (isNum(+opts[k]) && opts[k] !== null) R[k] = +opts[k]; });
        var fluid = opts.fluid || 'oil';
        var day = { zone: opts.day && opts.day.zone && opts.day.zone.mode !== 'device' ? opts.day.zone : resolveZone(opts.day && opts.day.zone),
                    startHour: clamp(mRound(num(opts.day && +opts.day.startHour, 0)), 0, 23) };
        var warnings = [], resol = opts.resolution || {};
        var map = {};
        // copies: the rows are input (hashed by run.inputHash) and the volumes below are written into the copies
        (rows || []).forEach(function (r) { if (r && parseDate(r.date)) map[r.date] = Object.assign({}, r); });
        var rs = Object.keys(map).sort().map(function (k) { return map[k]; });
        if (!rs.length) return { ok: false, code: 'NO_ALLOCATION', errors: ['No daily allocation rows.'], bad: ['allocation'] };
        // R_s (scf/STB): §3.6 names the option rsScfStb; Rs is accepted too (WellInput.Rs)
        var rsIn = opts.rsScfStb !== undefined && opts.rsScfStb !== null ? opts.rsScfStb : opts.Rs;
        var Bo = num(+opts.B, 1), Bw = num(+opts.Bw, 1), Rs = isNum(+rsIn) && rsIn !== null && rsIn !== '' ? +rsIn : null, Pb = isNum(+opts.Pb) && opts.Pb !== null ? +opts.Pb : null;
        var gas = opts.gas || {};
        // phase basis (R7), once per analysis
        var wcMax = null, gorMax = null, basis = 'oil', phase = 'oil';
        if (fluid === 'water_inj') { phase = 'water_inj'; basis = 'oil'; }
        else if (fluid === 'gas') {
            var api = isNum(+gas.apiCond) && gas.apiCond !== null ? +gas.apiCond : 50, Mo = isNum(+gas.Mo) && gas.Mo !== null && +gas.Mo > 0 ? +gas.Mo : 6084 / (api - 5.9);
            var go = 141.5 / (131.5 + api), ceMax = 0;
            rs.forEach(function (r) { if (r.gas > 0 && r.oil > 0) ceMax = mMax(ceMax, (133.3 * go * r.oil / Mo) / r.gas); });
            basis = ceMax > R.condensatePct / 100 ? 'gasEq' : 'gas';
            phase = basis;
            var geo = 133.3 * go / Mo;
            rs.forEach(function (r) { r._V = (r.gas || 0) + (basis === 'gasEq' ? geo * (r.oil || 0) + (gas.wcond ? R.waterGE_Mscf * (r.water || 0) : 0) : 0); });
        } else {
            rs.forEach(function (r) {
                var o = r.oil || 0, w = r.water || 0, g = r.gas || 0;
                if (o + w > 0) wcMax = mMax(wcMax === null ? 0 : wcMax, w / (o + w));
                if (o > 0 && r.gas !== null && r.gas !== undefined) gorMax = mMax(gorMax === null ? 0 : gorMax, g * 1000 / o);
            });
            var useTotal = (wcMax !== null && wcMax > R.wcLimit) || (Rs !== null && gorMax !== null && gorMax > R.gorFactor * Rs);
            if (useTotal) { basis = 'total'; phase = 'total_rb'; }
        }
        // mean flowing pressure for Bg (total basis only): median of the record
        var pMed = record && record.p && record.p.length ? median(record.p) : 2000;
        var Tg = (isNum(+gas.T_F) && gas.T_F !== null ? +gas.T_F : 200) + 459.67, Bg = 5.035 * 0.9 * Tg / mMax(14.7, pMed);
        rs.forEach(function (r) {
            if (fluid === 'gas') return;
            if (fluid === 'water_inj') { r._V = r.water || 0; return; }
            if (basis === 'total') r._V = (r.oil || 0) * Bo + (r.water || 0) * Bw + mMax(0, (r.gas || 0) - (r.oil || 0) * (Rs || 0) / 1000) * Bg;
            else r._V = r.oil || 0;
        });
        var vRes = fluid === 'gas' ? num(resol.gas, 1) : fluid === 'water_inj' ? num(resol.water, 1) : basis === 'total' ? mMax(num(resol.oil, 1) * Bo, num(resol.water, 1) * Bw) : num(resol.oil, 1);
        var ivs = _intervals(events, !!opts.fullShut), mainIvs = ivs.filter(function (iv) { return !iv.ramp; });
        // A shut-in still running at the data end is taken as shut until the end of that production day (the well is not
        // seen reopening; an allocation exported at the data end covers the flowing hours before the closing only). Its
        // interval end is not a reopening (no flush day, no reopening-day rule).
        mainIvs.forEach(function (iv) {
            if (!iv.ev || iv.ev.endReason !== 'data_end' || iv.f < 1) return;
            var lb = dayBounds(dayOf(iv.t1 - 1, day), day);
            if (lb && lb.t1_ms > iv.t1) { iv.t1 = lb.t1_ms; iv.noReopen = true; }
        });
        var gaps = (opts.gaps || []).filter(function (g) { return g.dur_h >= R.cleanGap_h; });
        var days = rs.map(function (r) {
            var b = dayBounds(r.date, day), pcs = _pieces(ivs, b.t0_ms, b.t1_ms), h = _hours(pcs);
            var evIds = [], closings = [], reopens = [];
            mainIvs.forEach(function (iv) {
                if (iv.t0 < b.t1_ms && iv.t1 > b.t0_ms && evIds.indexOf(iv.id) === -1) evIds.push(iv.id);
                if (iv.t0 >= b.t0_ms && iv.t0 < b.t1_ms) closings.push(iv);
                if (!iv.noReopen && iv.t1 > b.t0_ms && iv.t1 <= b.t1_ms) reopens.push(iv);
            });
            var flush = mainIvs.some(function (iv) { return !iv.noReopen && iv.t1 >= b.t0_ms - R.flush_h * HOUR && iv.t1 < b.t0_ms; });
            var gap = gaps.some(function (g) { return g.t0_ms < b.t1_ms && g.t1_ms > b.t0_ms; });
            var V = r._V, q = h.eff >= R.hOnMin_h ? 24 * V / h.eff : 0;
            if (V > vRes + 1e-9 && h.eff < R.hOnMin_h) warnings.push(W('VOLUME_ON_SHUT_DAY', 'warn', 'Allocated volume on ' + r.date + ' while the well was shut for the whole day.', ['R2']));
            var cls = h.on < R.hOnMin_h ? 'shut' : evIds.length ? 'event' : gap ? 'gap' : flush ? 'flush' : (h.on >= b.hours - R.cleanSlack_h ? 'clean' : 'event');
            return { row: r, date: r.date, t0_ms: b.t0_ms, t1_ms: b.t1_ms, hours: b.hours, hOn: h.on, hEff: h.eff, V: V, q: q, cls: cls, events: evIds,
                     closings: closings, reopens: reopens, pieces: pcs, qRef: null, qUse: q, sub: null };
        });
        // q_ref: median of the 3 nearest clean days on each side within ±10 days (at least 2). When the two sides differ by
        // more than the R3 tolerance (the rate changed while the well was shut), a closing day takes the side before the
        // shut-in and a reopening day the side after it (at least 2 clean days on that side; qRefSide says which).
        days.forEach(function (d, i) {
            var cb = [], ca = [];
            for (var a = i - 1, na = 0; a >= 0 && na < R.refEach; a--) { if ((d.t0_ms - days[a].t0_ms) / DAY > R.refDays + 0.5) break; if (days[a].cls === 'clean' && days[a].q > 0) { cb.push(days[a].q); na++; } }
            for (var b2 = i + 1, nb = 0; b2 < days.length && nb < R.refEach; b2++) { if ((days[b2].t0_ms - d.t0_ms) / DAY > R.refDays + 0.5) break; if (days[b2].cls === 'clean' && days[b2].q > 0) { ca.push(days[b2].q); nb++; } }
            var c = cb.concat(ca);
            d.qRef = c.length >= R.refMin ? median(c) : null;
            d.qRefSide = 'both';
            if (cb.length && ca.length && mAbs(median(ca) / median(cb) - 1) > R.r3Tol) {
                var side = d.closings.length && !d.reopens.length ? 'before' : d.reopens.length && !d.closings.length ? 'after' : null;
                var pick = side === 'before' ? cb : side === 'after' ? ca : null;
                if (pick && pick.length >= R.refMin) { d.qRef = median(pick); d.qRefSide = side; }
            }
            // preliminary pass (every event as a full shut-in): an event day's spread rate would put a partial cut's volume
            // into the flowing hours, so the rate history used by the classification gate takes the reference rate there
            if (opts.fullShut && d.events.length && d.qRef !== null) d.qUse = d.qRef;
        });
        // R3, R6, ignores-shut-in, short days and substitutions
        days.forEach(function (d, i) {
            d.R3 = null; d.R6 = null; d.ignoresShutin = false; d.shortDay = false;
            var r = d.row;
            if (isNum(r.hours)) d.R6 = { reported: r.hours, detected: d.hOn, flag: mAbs(r.hours - d.hOn) > R.hoursFlag_h };
            if (d.R6 && d.R6.flag) warnings.push(W('HOURS_DIFFER', 'info', 'Reported hours on ' + d.date + ' (' + r.hours.toFixed(1) + ' h) differ from the detected ' + d.hOn.toFixed(1) + ' h; the detected hours are used.', ['R6']));
            if (!d.events.length) return;
            var Vexp = d.qRef !== null ? d.qRef * d.hEff / 24 : null;
            var ratio = (Vexp && Vexp > 0) ? d.V / Vexp : null, tol = R.r3Tol + ((Vexp && Vexp > 0) ? vRes / Vexp : 0);
            if (d.qRef === null || d.hOn < R.closeDayMin_h) d.R3 = { ratio: d.hEff >= R.closeDayMin_h ? ratio : null, tol: tol, pass: null, status: 'unavailable' };
            else d.R3 = { ratio: ratio, tol: tol, pass: mAbs(ratio - 1) <= tol, status: mAbs(ratio - 1) <= tol ? 'pass' : 'fail' };
            if (d.qRef !== null && d.hOn <= d.hours - R.ignoreGap_h && mAbs(d.V / (d.qRef * d.hours / 24) - 1) <= R.ignoreTol) {
                d.ignoresShutin = true; d.qUse = d.qRef;
                warnings.push(W('ALLOC_IGNORES_SHUTIN', 'warn', 'The allocation on ' + d.date + ' ignores the shut-in (a full day of volume); the reference rate is used.', ['R3']));
            }
            if (d.hOn < R.closeDayMin_h && d.hOn > 0 && !d.ignoresShutin) {
                d.shortDay = d.closings.length > 0 || d.reopens.length > 0;
                var prev = i > 0 ? days[i - 1] : null;
                if (prev && prev.hOn >= prev.hours - R.cleanSlack_h && prev.q > 0 && (d.t0_ms - prev.t1_ms) < HOUR) { d.qUse = prev.qUse; d.sub = 'previousDay'; }
                else if (d.qRef !== null) { d.qUse = d.qRef; d.sub = 'qref'; }
                if (d.sub && d.closings.length) warnings.push(W('SHORT_CLOSING_DAY', 'warn', 'Closing day ' + d.date + ' has ' + d.hOn.toFixed(1) + ' flowing hours: the rate before closing comes from ' + (d.sub === 'previousDay' ? 'the previous day.' : 'the reference rate.'), ['R1']));
                if (d.sub && d.reopens.length && !d.closings.length) warnings.push(W('SHORT_REOPEN_DAY', 'info', 'Reopening day ' + d.date + ' has ' + d.hOn.toFixed(1) + ' flowing hours: the reference rate is used after the reopening (volume difference ' + (d.V - d.qUse * d.hEff / 24).toFixed(1) + ').', ['R2']));
            }
            // a closing day the gauge shows flowing (≥ hOnMin_h) but with no allocated volume (a misplaced or missing row):
            // the rate before closing comes from the previous full day, else q_ref (R2), as on a short closing day
            if (d.closings.length && !d.sub && !d.ignoresShutin && d.hEff >= R.hOnMin_h && !(d.V > vRes + 1e-9)) {
                var pv = i > 0 ? days[i - 1] : null;
                if (pv && pv.hOn >= pv.hours - R.cleanSlack_h && pv.q > 0 && (d.t0_ms - pv.t1_ms) < HOUR) { d.qUse = pv.qUse; d.sub = 'previousDay'; d.shortDay = true; }
                else if (d.qRef !== null) { d.qUse = d.qRef; d.sub = 'qref'; d.shortDay = true; }
                if (d.sub) warnings.push(W('NO_VOLUME_FLOWING', 'warn', 'Closing day ' + d.date + ' has ' + d.hOn.toFixed(1) + ' flowing hours in the gauge data but no allocated volume: the rate before closing comes from ' + (d.sub === 'previousDay' ? 'the previous day.' : 'the reference rate.'), ['R1', 'R2']));
            }
            if (d.events.length >= 2) d.equalRateAssumed = true;
        });
        // history start (D13)
        var d0 = days[0].t0_ms, firstFlow = null;
        for (var f = 0; f < days.length; f++) if (days[f].hEff >= R.hOnMin_h && days[f].qUse > 0) { firstFlow = days[f]; break; }
        var qFirst = firstFlow ? firstFlow.qUse : 0, hist = opts.history || {}, start;
        var longest = 0;
        (events || []).forEach(function (e) { if (e && _isShutKind(e) && e.status === 'analysable' && isNum(e.dtEnd_h)) longest = mMax(longest, e.dtEnd_h); });
        if (hist.mode === 'date' && parseDate(hist.date)) {
            var hb = dayBounds(hist.date, day), ph = hb && hb.t0_ms < d0 ? (d0 - hb.t0_ms) / HOUR : 0;
            start = { source: 'date', prepend_h: ph, q: qFirst, flag: false };
        } else if (hist.mode === 'cum' && isNum(+hist.cum) && +hist.cum > 0 && qFirst > 0) {
            start = { source: 'cum', prepend_h: 24 * (+hist.cum) / qFirst, q: qFirst, flag: false };
        } else {
            start = { source: 'default', prepend_h: mMax(R.prependMin_h, R.prependFactor * longest), q: qFirst, flag: true };
            warnings.push(W('HISTORY_ESTIMATED', 'warn', 'Production before the first allocated day is unknown: ' + (start.prepend_h / 24).toFixed(0) + ' days at the first rate are assumed.', ['R5']));
        }
        // steps over one timeline: history, days, gaps between rows (rate carried), after the last day (carried)
        var tS = d0 - mRound(start.prepend_h * HOUR), endT = days[days.length - 1].t1_ms;
        if (record && record.t && record.t.length) endT = mMax(endT, record.t[record.t.length - 1]);
        mainIvs.forEach(function (iv) { endT = mMax(endT, iv.t1); });
        var cutSet = {}, starts = {};
        cutSet[tS] = 1; cutSet[endT] = 1;
        days.forEach(function (d) { cutSet[d.t0_ms] = 1; cutSet[d.t1_ms] = 1; });
        ivs.forEach(function (iv) { cutSet[iv.t0] = 1; cutSet[iv.t1] = 1; if (!iv.ramp) starts[iv.t0] = 1; });
        var cuts = Object.keys(cutSet).map(Number).filter(function (x) { return x >= tS && x <= endT; }).sort(function (a, b) { return a - b; });
        var steps = [], di = 0, carry = qFirst;
        for (var c = 0; c + 1 < cuts.length; c++) {
            var a = cuts[c], b3 = cuts[c + 1], mid = 0.5 * (a + b3);
            while (di < days.length && days[di].t1_ms <= mid) { carry = days[di].qUse; di++; }
            var base = (di < days.length && days[di].t0_ms <= mid) ? days[di].qUse : (a < d0 ? qFirst : carry);
            var rate = _fracAt(ivs, mid) * base;
            if (!(rate >= 0)) rate = 0;
            var last = steps[steps.length - 1];
            if (last && last.q === rate && !starts[a]) continue;
            steps.push({ t_ms: a, q: rate });
        }
        if (!steps.length) steps.push({ t_ms: tS, q: qFirst });
        // per event: Δq (rate of the flowing sub-interval just before t_c, after any partial cut or substitute)
        var byEvent = {};
        function rateBefore(ms) { var q = 0; for (var s = 0; s < steps.length && steps[s].t_ms < ms; s++) q = steps[s].q; return q; }
        mainIvs.forEach(function (iv) {
            var e = iv.ev, half = (e.ramp && e.ramp.present) ? mRound(e.ramp.dur_s * SEC / 2) : 0;
            var Dq = rateBefore(iv.t0 - half);
            var d = _dayContaining(days, iv.t0);
            var src = d ? (d.ignoresShutin ? 'qref' : d.sub && d.shortDay ? d.sub : 'closingDay') : 'closingDay';
            var qRef = d ? d.qRef : null;
            var r3 = d && d.R3 ? d.R3 : null;
            if (Dq > 0 && qRef && mAbs(Dq / qRef - 1) > R.dqTol && iv.f === 1) warnings.push(W('DQ_VS_QREF', 'info', 'Rate before closing for ' + e.id + ' differs from the reference rate by ' + (100 * (Dq / qRef - 1)).toFixed(0) + ' %.', ['R1']));
            byEvent[e.id] = { Dq: Dq, dqSource: src, dqKnown: Dq > 0, qRef: qRef, r3: r3 ? r3.ratio : null, r3Status: r3 ? r3.status : 'unavailable', r3Tol: r3 ? r3.tol : null,
                              ignoresShutin: !!(d && d.ignoresShutin), equalRateAssumed: !!(d && d.equalRateAssumed), shortDay: !!(d && d.shortDay), date: d ? d.date : dayOf(iv.t0, day) };
            e.qBefore = Dq; e.qAfter = iv.f < 1 ? (1 - iv.f) * Dq : 0;
        });
        // mean flowing pressure per day (full-rate samples only)
        var shift = num(+opts.depthShift_psi, 0);
        if (record && record.t && record.t.length) {
            var t = record.t, p = record.p;
            days.forEach(function (d) {
                var s = 0, cN = 0, sp = 0, cp = 0;
                d.pieces.forEach(function (pc) {
                    if (!(pc.frac > 0)) return;
                    for (var i = lowerBound(t, pc.a); i < t.length && t[i] < pc.b; i++) { if (pc.frac === 1) { s += p[i]; cN++; } else { sp += p[i]; cp++; } }
                });
                d.pwfMean_psia = cN ? s / cN : cp ? sp / cp : null;
            });
        } else days.forEach(function (d) { d.pwfMean_psia = null; });
        // allocation days with low volume and no pressure event (missed list)
        var allocOnly = [];
        days.forEach(function (d) {
            if (d.events.length || d.qRef === null) return;
            var ratio = d.V / (d.qRef * d.hours / 24);
            if (ratio < R.allocOnly) allocOnly.push({ date: d.date, ratio: ratio });
        });
        // offset scan (§4.4): −12…+12 h. For each offset the day windows move, the clean days and their reference rates are
        // recomputed, and R3 is evaluated on the closing and reopening days.
        var evDays = days.filter(function (d) { return (d.closings.length || d.reopens.length) && d.qRef !== null; });
        function scanAt(off) {
            var sum = 0, pass = 0, sd = days.map(function (d) {
                var a = d.t0_ms + off * HOUR, b = d.t1_ms + off * HOUR, h = _hours(_pieces(ivs, a, b));
                var evIn = false, cr = false;
                mainIvs.forEach(function (iv) { if (iv.t0 < b && iv.t1 > a) evIn = true; if ((iv.t0 >= a && iv.t0 < b) || (!iv.noReopen && iv.t1 > a && iv.t1 <= b)) cr = true; });
                return { V: d.V, t0: a, h: h, cr: cr, clean: !evIn && h.on >= (b - a) / HOUR - R.cleanSlack_h, q: h.eff >= R.hOnMin_h ? 24 * d.V / h.eff : 0 };
            });
            sd.forEach(function (x, i) {
                if (!x.cr) return;
                var c = [];
                for (var a2 = i - 1, na = 0; a2 >= 0 && na < R.refEach; a2--) { if ((x.t0 - sd[a2].t0) / DAY > R.refDays + 0.5) break; if (sd[a2].clean && sd[a2].q > 0) { c.push(sd[a2].q); na++; } }
                for (var b2 = i + 1, nb = 0; b2 < sd.length && nb < R.refEach; b2++) { if ((sd[b2].t0 - x.t0) / DAY > R.refDays + 0.5) break; if (sd[b2].clean && sd[b2].q > 0) { c.push(sd[b2].q); nb++; } }
                if (c.length < R.refMin) return;
                var Ve = median(c) * x.h.eff / 24;
                if (!(Ve > 0)) { sum += x.V > vRes ? 1 : 0; return; }
                var dev = mAbs(x.V / Ve - 1);
                sum += mMin(2, dev);
                if (dev <= R.r3Tol + vRes / Ve) pass++;
            });
            return { sum: sum, pass: pass };
        }
        var sh = day.startHour, cur = scanAt(0), best = { off: 0, sum: cur.sum, pass: cur.pass };
        if (evDays.length) {
            for (var off = -R.offsetScan_h; off <= R.offsetScan_h; off++) {
                if (!off) continue;
                var sc = scanAt(off);
                if (sc.sum < best.sum - 1e-12 || (mAbs(sc.sum - best.sum) <= 1e-12 && mAbs(off) < mAbs(best.off))) best = { off: off, sum: sc.sum, pass: sc.pass };
            }
        }
        var better = cur.sum > 0 && best.off !== 0 && best.sum < (1 - R.offsetGain) * cur.sum && best.pass >= cur.pass + R.offsetDays;
        if (better) warnings.push(W('DAY_OFFSET', 'warn', 'A production day starting at ' + ((sh + best.off + 24) % 24) + ':00 fits the allocation better than ' + sh + ':00; check the production-day settings.', ['R3']));
        var outDays = days.map(function (d) {
            return { date: d.date, t0_ms: d.t0_ms, t1_ms: d.t1_ms, hours: d.hours, hOn: d.hOn, V: d.V, q: d.q, cls: d.cls, events: d.events.slice(),
                     pwfMean_psia: d.pwfMean_psia, pwfMeanDatum_psia: d.pwfMean_psia === null ? null : d.pwfMean_psia + shift,
                     R3: d.R3, R4: null, R6: d.R6, ignoresShutin: d.ignoresShutin, equalRateAssumed: !!d.equalRateAssumed, shortDay: d.shortDay,
                     hEff: d.hEff, qRef: d.qRef, qRefSide: d.qRefSide, qUse: d.qUse, vRes: vRes };
        });
        var twoPhase = fluid === 'oil' && ((Pb !== null && outDays.some(function (d) { return d.pwfMean_psia !== null && d.pwfMean_psia < Pb; })) || (Rs !== null && gorMax !== null && gorMax > R.gorFactor * Rs));
        if (basis === 'total') warnings.push(W('TOTAL_BASIS', 'info', 'Water cut or GOR above the oil-basis limits: every test uses the total reservoir rate (B = 1, oil viscosity), so k is a total-mobility equivalent (k = total mobility × oil viscosity).', ['R7']));
        return {
            mode: 'daily', unit: _unitFor(fluid, basis), phase: phase, days: outDays, steps: steps, start: start,
            offsetScan: { current_h: sh, best_h: sh + best.off, better: better, improvement: cur.sum > 0 ? 1 - best.sum / cur.sum : 0 },
            // kTotalMobility (extra key): on the total basis k means total mobility × oil viscosity (limitation for trend/review)
            phaseBasis: { used: basis, wcMax: wcMax, gorRatioMax: (Rs && gorMax !== null) ? gorMax / Rs : null, twoPhaseCt: !!twoPhase, kTotalMobility: basis === 'total' },
            ev: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'], warnings: warnings, byEvent: byEvent, allocOnly: allocOnly
        };
    }

    // Time-stamped rate table → RateHistory (table mode, D15). opts {fluid, events (closings move to the refined t_c),
    // dtMed_s (QC median sampling interval: a tabled closing within ±max(10 min, 5·Δt_med) of t_c moves to t_c, as in
    // the table-mode detection; a closing farther away is inserted)}
    function rateTable(rows, opts) {
        opts = opts || {};
        var fluid = opts.fluid || 'oil';
        var tolT = mMax(D.DEFAULTS.detect.tableTolMin * MIN, D.DEFAULTS.detect.tableTolN * (isNum(+opts.dtMed_s) && +opts.dtMed_s > 0 ? +opts.dtMed_s : 60) * SEC);
        var rt = (rows || []).filter(function (r) { return r && isNum(r.t_ms) && isNum(r.q); }).map(function (r) { return { t_ms: mRound(r.t_ms), q: mAbs(r.q) }; })
            .sort(function (a, b) { return a.t_ms - b.t_ms; });
        if (!rt.length) return { ok: false, code: 'NO_RATES', errors: ['No time-stamped rates.'], bad: ['rateTable'] };
        var steps = [];
        rt.forEach(function (r) { var l = steps[steps.length - 1]; if (l && l.t_ms === r.t_ms) { l.q = r.q; return; } if (l && l.q === r.q) return; steps.push({ t_ms: r.t_ms, q: r.q }); });
        var byEvent = {}, warnings = [];
        (opts.events || []).forEach(function (e) {
            if (!e || e.dropped || !_isShutKind(e) || !isNum(e.tc_ms)) return;
            // the tabled closing nearest to t_c moves to t_c; a closing not in the table is inserted
            var best = -1, bd = INF;
            for (var i = 1; i < steps.length; i++) if (steps[i].q === 0 && steps[i - 1].q > 0) { var dd = mAbs(steps[i].t_ms - e.tc_ms); if (dd < bd) { bd = dd; best = i; } }
            var tol = tolT;
            if (best > 0 && bd <= tol) {
                // a closing ramp logged row by row (falling rows within the tolerance before the zero row) is one closing
                // at t_c with the rate before the ramp: M§A3 places t_c at the ramp midpoint and models the ramp as two
                // half-rate steps, so Δq is the pre-ramp rate (not the last, smallest ramp row)
                var r0 = _tableRampStart(steps, best, tol);
                if (r0 < best - 1) { steps.splice(r0 + 1, best - 1 - r0); best = r0 + 1; }
            }
            if (best > 0 && bd <= tol && (best + 1 >= steps.length || steps[best + 1].t_ms > e.tc_ms) && steps[best - 1].t_ms < e.tc_ms) steps[best].t_ms = e.tc_ms;
            else {
                var k = lowerBound(steps.map(function (s) { return s.t_ms; }), e.tc_ms);
                var qPrev = k > 0 ? steps[k - 1].q : 0;
                steps.splice(k, 0, { t_ms: e.tc_ms, q: 0 });
                if (isNum(e.tEnd_ms) && (k + 1 >= steps.length || steps[k + 1].t_ms > e.tEnd_ms)) steps.splice(k + 1, 0, { t_ms: e.tEnd_ms, q: qPrev });
            }
        });
        steps = steps.filter(function (s, i) { return i === 0 || s.t_ms > steps[i - 1].t_ms; });
        (opts.events || []).forEach(function (e) {
            if (!e || e.dropped || !_isShutKind(e) || !isNum(e.tc_ms)) return;
            var q = 0;
            for (var s = 0; s < steps.length && steps[s].t_ms < e.tc_ms; s++) q = steps[s].q;
            byEvent[e.id] = { Dq: q, dqSource: 'table', dqKnown: q > 0, qRef: null, r3: null, r3Status: 'n/a', r3Tol: null, ignoresShutin: false, equalRateAssumed: false, shortDay: false, date: civil(e.tc_ms) };
            e.qBefore = q; e.qAfter = 0;
        });
        return {
            mode: 'table', unit: _unitFor(fluid, 'oil'), phase: fluid === 'water_inj' ? 'water_inj' : fluid === 'gas' ? 'gas' : 'oil', days: [], steps: steps,
            start: { source: 'data', prepend_h: 0, q: steps[0].q, flag: false }, offsetScan: { current_h: 0, best_h: 0, better: false, improvement: 0 },
            phaseBasis: { used: fluid === 'gas' ? 'gas' : 'oil', wcMax: null, gorRatioMax: null, twoPhaseCt: false, kTotalMobility: false },
            ev: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'], warnings: warnings, byEvent: byEvent, allocOnly: []
        };
    }

    // RateHistory → [{t (h, history clock), q}] ending with the q = 0 step at upTo_ms (the steps before upTo_ms, unchanged).
    function historySteps(rh, origin_ms, upTo_ms) {
        var out = [], st = (rh && rh.steps) || [];
        for (var i = 0; i < st.length; i++) {
            if (st[i].t_ms >= upTo_ms) break;
            out.push({ t: (st[i].t_ms - origin_ms) / HOUR, q: st[i].q });
        }
        out.push({ t: (upTo_ms - origin_ms) / HOUR, q: 0 });
        return out;
    }
    // Index of the q = 0 step at ms in rh.steps (−1 when absent).
    function stepIndexAt(rh, ms) {
        var st = (rh && rh.steps) || [];
        for (var i = 0; i < st.length; i++) { if (st[i].t_ms === ms) return st[i].q === 0 ? i : -1; if (st[i].t_ms > ms) break; }
        return -1;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Full data pass (QC → detection → QC with events → classification → rates), sliced into units
    // ─────────────────────────────────────────────────────────────────────
    // opts {settings:{detect}, fluid, zones:{day}, allocation:{rows, resolution}, rateTable, history, well {B, Bw, Rs, Pb, gas},
    //       depth, workovers, adjust(events, record, qc) (overrides; returns the events)}
    // The missed list's sub-threshold steps after the overrides and the classification gate: steps promoted to a manual
    // event (inside its closing … end, ± the matching tolerance) leave the list; events the gate turned into a 'substep'
    // (f̂ < fPartial by late Δp differences) join it. Sorted by time.
    function _subList(events, sub, q) {
        var dtMed = (q && isNum(q.dtMed_s) && q.dtMed_s > 0 ? q.dtMed_s : 60) * SEC, near = mMax(10 * MIN, 5 * dtMed, 2 * mMax(D.DEFAULTS.detect.winMin * MIN, 3 * dtMed));
        var manual = (events || []).filter(function (e) { return e && e.manual && !e.dropped && isNum(e.tc_ms) && isNum(e.tEnd_ms); });
        var out = (sub || []).filter(function (s) {
            return !manual.some(function (e) { return s.t_ms >= e.tc_ms - near && s.t_ms <= e.tEnd_ms + near; });
        });
        (events || []).forEach(function (e) {
            if (e && e.gateSubstep && !e.dropped && isNum(e.tc_ms)) out.push({ t_ms: e.tc_ms, dp_psi: num(e.gateDp_psi, 0), dur_h: isNum(e.dtEnd_h) ? e.dtEnd_h : 0 });
        });
        return out.sort(function (a, b) { return a.t_ms - b.t_ms; });
    }
    function scanJob(record, opts) {
        opts = opts || {};
        var S = detectSettings(opts.settings && opts.settings.detect);
        var day = { zone: opts.zones && opts.zones.day && opts.zones.day.zone, startHour: opts.zones && opts.zones.day ? opts.zones.day.startHour : 0 };
        day.zone = day.zone && day.zone.mode !== 'device' ? day.zone : resolveZone(day.zone);
        var rows = opts.allocation && opts.allocation.rows || null, table = !!(opts.rateTable && opts.rateTable.length);
        var well = opts.well || {};
        var shift = depthShift(opts.depth);
        var st = { phase: 'qc0' }, res = null, q0, rec = record, det, q1, events, rh, cancelled = false;
        function rateOpts(full) {
            return { fluid: well.fluid || 'oil', day: day, history: opts.history, B: well.B, Bw: well.Bw, Rs: well.Rs, Pb: well.Pb, gas: well.gas,
                     resolution: opts.allocation && opts.allocation.resolution, gaps: q1 ? q1.gaps : (q0 && q0.gaps), depthShift_psi: shift, fullShut: full };
        }
        return {
            step: function () {
                if (res || cancelled) return { done: true, progress: 1, label: 'Data scanned' };
                if (st.phase === 'qc0') {
                    if (!st.sub) st.sub = qcJob(record, { spike: S.spike, gapN: S.gapN, depth: opts.depth });
                    var s0 = st.sub.step();
                    if (!s0.done) return { done: false, progress: 0.08 * s0.progress, label: s0.label };
                    q0 = st.sub.result(); st.sub = null;
                    if (S.spike === 'filter') rec = applySpikeFilter(record, q0);
                    st.phase = 'detect';
                    return { done: false, progress: 0.25, label: 'Data quality' };
                }
                if (st.phase === 'detect') {
                    if (!st.sub) {
                        var shutDays = [], allocDays = [];
                        (rows || []).forEach(function (r) {
                            if (!r || !parseDate(r.date)) return;
                            var v = (r.oil || 0) + (r.gas || 0) + (r.water || 0), b = dayBounds(r.date, day);
                            if (!b) return;
                            if (v <= 0) shutDays.push([b.t0_ms, b.t1_ms]);
                            // the main-phase volume (only ratios between days are used at detection)
                            var vm = well.fluid === 'gas' ? r.gas : well.fluid === 'water_inj' ? r.water
                                : (isNum(r.oil) || isNum(r.water)) ? num(r.oil, 0) + num(r.water, 0) : null;
                            if (isNum(vm) && vm >= 0) allocDays.push({ t0_ms: b.t0_ms, t1_ms: b.t1_ms, V: vm });
                        });
                        st.sub = detectJob(rec, q0, { settings: S, fluid: well.fluid, day: day, rateTable: table ? opts.rateTable : null, shutDays: shutDays,
                                                      allocDays: table ? [] : allocDays });
                    }
                    var sd = st.sub.step();
                    if (!sd.done) return { done: false, progress: 0.25 + 0.2 * sd.progress, label: sd.label };
                    det = st.sub.result(); st.sub = null;
                    events = det.events;
                    if (typeof opts.adjust === 'function') events = opts.adjust(events, rec, q0, det.missed) || events;
                    st.phase = 'qc1';
                    return { done: false, progress: 0.5, label: 'Shut-ins found: ' + events.length };
                }
                if (st.phase === 'qc1') {
                    if (!st.sub) st.sub = qcJob(rec, { events: events, spike: S.spike, gapN: S.gapN, depth: opts.depth });
                    var s1 = st.sub.step();
                    if (!s1.done) return { done: false, progress: 0.5 + 0.08 * s1.progress, label: s1.label };
                    q1 = st.sub.result(); st.sub = null;
                    st.phase = 'rates';
                    return { done: false, progress: 0.75, label: 'Noise by segment' };
                }
                var Ts = mMax(S.riseMin, S.riseSig * num(q0.sigma_psi, 0));
                if (st.phase === 'rates') {                  // preliminary rates (every event as a full shut-in)
                    if (table) st.sub = classifyJob(events, rec, null, { table: true, settings: S, workovers: opts.workovers, Ts: Ts, dtMed_s: q0.dtMed_s });
                    else if (rows && rows.length) {
                        var pre = rates(rec, events, rows, rateOpts(true));
                        if (pre && pre.ok === false) { res = pre; return { done: true, progress: 1, label: 'No allocation' }; }
                        st.sub = classifyJob(events, rec, pre.days, { rh: pre, settings: S, workovers: opts.workovers, Ts: Ts, dtMed_s: q0.dtMed_s });
                    } else {
                        res = { ok: false, code: 'NO_RATES', errors: ['Load a daily allocation or a time-stamped rate table.'], bad: ['allocation'] };
                        return { done: true, progress: 1, label: 'No rates' };
                    }
                    st.phase = 'classify';
                    return { done: false, progress: 0.8, label: 'Preliminary rates' };
                }
                if (st.phase === 'classify') {               // the classification gate, 10 events per unit
                    var sc = st.sub.step();
                    if (sc.done) { st.sub = null; st.phase = 'rates2'; }
                    return { done: false, progress: 0.8 + 0.1 * sc.progress, label: sc.done ? 'Shut-ins classified' : sc.label };
                }
                if (st.phase === 'rates2') {                 // final rates with the partial cuts split
                    rh = table ? rateTable(opts.rateTable, { fluid: well.fluid, events: events, dtMed_s: q0 && q0.dtMed_s }) : rates(rec, events, rows, rateOpts(false));
                    if (rh && rh.ok === false) { res = rh; return { done: true, progress: 1, label: 'No rates' }; }
                    res = { ok: true, qc: q1, events: events, missed: _missed(events, _subList(events, det.missed.subThreshold, q0), rh, q1, Ts, det.missed.rateSteps), rates: rh, record: rec, qc0: q0 };
                    return { done: true, progress: 1, label: 'Rates' };
                }
                return { done: true, progress: 1, label: '' };
            },
            result: function () { return res; },
            cancel: function () { cancelled = true; }
        };
    }
    function scan(record, opts) { return runSync(scanJob(record, opts)); }

    // ─────────────────────────────────────────────────────────────────────
    // Public surface (§3.6) and helpers shared with run
    // ─────────────────────────────────────────────────────────────────────
    D.resolveZone = resolveZone;
    D.sniff = sniff;
    D.parseJob = parseJob;
    D.parse = parse;
    D.fromHistorian = fromHistorian;
    D.fromPRiSM = fromPRiSM;
    D.qc = qc;
    D.qcJob = qcJob;
    D.detect = detect;
    D.detectJob = detectJob;
    D.refineClosing = refineClosing;
    D.classify = classify;
    D.classifyJob = classifyJob;
    D.parseAllocation = parseAllocation;
    D.dayBounds = dayBounds;
    D.rates = rates;
    D.rateTable = rateTable;
    D.historySteps = historySteps;
    D.depthShift = depthShift;
    // helpers (not part of the §3.6 table)
    D.dayOf = dayOf;
    D.offsetAt = offsetAt;
    D.localToUtc = localToUtc;
    D.localLaterUtc = localLaterUtc;
    D.tzCacheSize = function (tz) { return { offset: (_offCache[tz] && _offCache[tz]._n) || 0, local: (_l2u[tz] && _l2u[tz]._n) || 0, max: TZ_CACHE_MAX }; };
    D.deviceZoneName = deviceZoneName;
    D.recordHash = recordHash;
    D.eventAt = eventAt;
    D.applySpikeFilter = applySpikeFilter;
    D.detectSettings = detectSettings;
    D.stepIndexAt = stepIndexAt;
    D.scan = scan;
    D.scanJob = scanJob;
    D.missed = _missed;
    D.trendAt = trendAt;
    D.util = { median: median, mad: mad, quantile: quantile, theilSen: theilSen, lowerBound: lowerBound, pAt: pAt, civil: civil, addDays: addDays, runSync: runSync };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var D = G.WTS_buildup && G.WTS_buildup.data;
    if (!D) return;
    var checks = [];
    function chk(name, ok) { checks.push([name, !!ok]); }
    var lon = { zone: { mode: 'iana', tz: 'Europe/London' }, startHour: 0 };
    try {
        chk('BST start 23 h', Math.abs(D.dayBounds('2026-03-29', lon).hours - 23) < 1e-9);
        chk('BST end 25 h', Math.abs(D.dayBounds('2026-10-25', lon).hours - 25) < 1e-9);
        chk('UTC day 24 h', D.dayBounds('2026-05-01', { zone: { mode: 'utc' }, startHour: 6 }).hours === 24);
    } catch (e) { chk('Intl time zones', false); }
    var csv = 'time_hr,pressure_psi,rate_stbd\n0,1000,500\n1,1010,500\n2,1020,0\n';
    var r = D.parse(csv, {});
    chk('parse elapsed hours', r && r.record && r.record.n === 3 && r.record.p[2] === 1020 && r.rateTable && r.rateTable.length === 2);
    chk('psig to psia', D.parse('t,p\n0,100\n1,101\n', { pUnit: 'psig', timeFormat: 'elapsed_h' }).record.p[0] === 114.696);
    chk('median', D.util.median([3, 1, 2, 10]) === 2.5);
    var ts = D.util.theilSen([0, 1, 2, 3, 4], [1, 3, 5, 7, 100]);
    chk('theil-sen robust', Math.abs(ts.b - 2) < 1e-12);
    chk('depth shift', Math.abs(D.depthShift({ gaugeTVD: 9000, datumTVD: 9100, grad: 0.35 }) - 35) < 1e-9);
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-buildup-data self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.WTS_buildup_data_selfTest = checks;
})();
