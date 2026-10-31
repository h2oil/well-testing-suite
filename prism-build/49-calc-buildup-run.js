// =============================================================================
// Build-up Surveillance — 49-calc-buildup-run.js  (Round 9, WP2)
// helper module: does not add a page to window.WTS_calcRegistry
// -----------------------------------------------------------------------------
// window.WTS_buildup.run — the staged analysis pipeline of the Build-up
// Surveillance page (plan docs/BUILDUP-SURVEILLANCE-PLAN.md §3.7, §4.6 item 18,
// §4.8, §4.9) and window.WTS_buildup_compute (the registry contract).
//
//   analyse(input, opts)       → Analysis (synchronous)
//   job(input, opts)           → Job<Analysis> (count-sliced work units)
//   analyseAsync(input, opts)  → Promise<Analysis> through PRiSM_autoInterp.drive
//   specFor(event, record, rh, input, o) → BuildupSpec (in memory; dt/p at 6 sf)
//   inputHash(input)           → hex16 over everything that changes numbers
//
// Stages (D26):
//   0  data: QC, detection, closing times, classification, rates (data.scanJob),
//      or the stored events / rates / per-test specs when input.record is null
//   1  PRiSM_autoInterp.interpretJob per test → pass-1 results and labels
//   2  WTS_buildup.trend.baseline over the pass-1 tests whose k/S label ≥ medium
//   3  pass 2: k-held fits, background check, partial-cut suspicion, R4,
//      window-level check, final confidence → the frozen used set
//   4  WTS_buildup.trend.compute over the frozen used set
//   5  trend model caps (closed circle without depletion), hashes
//
// Every cross-file function is looked up at call time. Pure (§3.0): no DOM, no
// storage, no timers, no events and no random numbers; the only yields are the
// driver's (analyseAsync). A per-test cache key covers the spec, the
// interpretation settings and the calibration version, so a re-analysis re-runs
// only the tests whose key changed, then stages 2–5.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var mAbs = Math.abs, mMax = Math.max, mMin = Math.min, mSqrt = Math.sqrt, mLog = Math.log, mFloor = Math.floor, mCeil = Math.ceil, _isFin = isFinite;
    var BU = G.WTS_buildup = G.WTS_buildup || {};
    var R = BU.run = BU.run || {};
    var HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY, LN10 = Math.LN10;
    var VERSION = '1.0', MAX_TESTS = 60;
    var RANK = { low: 0, medium: 1, high: 2 }, LEVELS = ['low', 'medium', 'high'];

    function DA() { return BU.data || null; }
    function AI() { return G.PRiSM_autoInterp || null; }
    function TR() { return BU.trend || null; }
    function isNum(v) { return typeof v === 'number' && v - v === 0; }
    function num(v, d) { return isNum(v) ? v : d; }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    function fin(v) { return isNum(v) ? v : null; }
    function sf6(x) { return isNum(x) ? parseFloat(x.toPrecision(6)) : x; }
    function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
    function W(code, level, text, ev) { return { code: code, level: level, text: String(text).slice(0, 298), ev: ev || [] }; }
    function fail(code, errors, bad) { return { ok: false, code: code, errors: errors || [], bad: bad || [] }; }
    function median(a) {
        var s = a.filter(isNum).slice().sort(function (x, y) { return x - y; }), n = s.length;
        if (!n) return null;
        return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
    }
    function madOf(a) { var m = median(a); if (m === null) return null; return median(a.map(function (v) { return mAbs(v - m); })); }
    function hash16(s) { var a = AI(); return (a && typeof a.hash16 === 'function') ? a.hash16(s) : '0000000000000000'; }
    function canon(o, mode) { var a = AI(); return (a && typeof a.canon === 'function') ? a.canon(o, mode) : JSON.stringify(o); }
    function rank(l) { return RANK[l] !== undefined ? RANK[l] : -1; }
    function minLevel(a, b) { return rank(a) <= rank(b) ? a : b; }
    function runSync(j) { var g = 0; while (!j.step().done) { if (++g > 1e8) break; } return j.result(); }
    function iso(ms) { return new Date(ms).toISOString(); }

    // ─────────────────────────────────────────────────────────────────────
    // Settings (clamped on read, §6.2) and well inputs
    // ─────────────────────────────────────────────────────────────────────
    var SETTINGS_DEFAULT = {
        detect: { winMin: 5, riseMin: 5, riseSig: 10, persistMin: 30, minDur_h: 2, gapN: 5, spike: 'off', partial: true },
        interp: { Lcyc: 0.1, band: 0.10, slope: 0.03, minCycles: 0.5, rivals: 'auto', cheld: 'auto', kHeld: 'auto', tide: 'auto' },
        trend: { baseN: 3, delta: 2, abs: 5, basevar: false, confirm: 'next', price: null, enabled: 'auto' },
        report: { detail: 'selected' }
    };
    var CLAMP = {
        detect: { winMin: [1, 60], riseMin: [0.5, 500], riseSig: [2, 50], persistMin: [5, 240], minDur_h: [0.5, 48], gapN: [2, 50] },
        interp: { Lcyc: [0.05, 0.3], band: [0.05, 0.25], slope: [0.01, 0.1], minCycles: [0.3, 1] },
        trend: { baseN: [1, 5], delta: [0.5, 10], abs: [0, 50] }
    };
    var ENUMS = {
        'detect.spike': ['off', 'flag', 'filter'], 'interp.rivals': ['auto', 'none', 'all'], 'interp.cheld': ['auto', 'off', 'extended'],
        'interp.kHeld': ['auto', 'off'], 'interp.tide': ['auto', 'off'], 'trend.confirm': ['next', 'immediate'], 'trend.enabled': ['auto', 'on', 'off'],
        'report.detail': ['selected', 'all']
    };
    function settingsOf(s) {
        s = s || {};
        var out = {};
        Object.keys(SETTINGS_DEFAULT).forEach(function (g) {
            out[g] = {};
            Object.keys(SETTINGS_DEFAULT[g]).forEach(function (k) {
                var d = SETTINGS_DEFAULT[g][k], v = s[g] && s[g][k] !== undefined ? s[g][k] : d;
                var c = CLAMP[g] && CLAMP[g][k];
                if (c) v = isNum(+v) && v !== null && v !== '' ? clamp(+v, c[0], c[1]) : d;
                else if (ENUMS[g + '.' + k]) v = ENUMS[g + '.' + k].indexOf(v) >= 0 ? v : d;
                else if (typeof d === 'boolean') v = !!v;
                else if (k === 'price') v = isNum(+v) && v !== null && v !== '' && +v >= 0 ? +v : null;
                out[g][k] = v;
            });
        });
        out.trend.baseN = Math.round(out.trend.baseN);
        return out;
    }
    var WELL_RANGES = { h: [1, 2000], phi: [0.01, 0.5], mu: [0.01, 1000], B: [0.5, 5], ct: [1e-7, 1e-3], rw: [0.1, 2] };
    function checkWell(w) {
        var bad = [], errs = [];
        if (!w || typeof w !== 'object') return fail('BAD_WELL', ['Well inputs are missing.'], ['well']);
        Object.keys(WELL_RANGES).forEach(function (k) {
            var r = WELL_RANGES[k], v = w[k];
            if (!isNum(v) || v < r[0] || v > r[1]) { bad.push(k); errs.push(k + ' must be between ' + r[0] + ' and ' + r[1] + '.'); }
        });
        if (['oil', 'gas', 'water_inj'].indexOf(w.fluid) === -1) { bad.push('fluid'); errs.push('Well type must be oil, gas or water injector.'); }
        if (w.fluid === 'water_inj' && (!isNum(w.Bw) || !isNum(w.muw) || w.Bw <= 0 || w.muw <= 0)) { bad.push('Bw'); errs.push('Water injectors need the water formation volume factor and viscosity.'); }
        return bad.length ? fail('BAD_WELL', errs, bad) : null;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Zones and hashes
    // ─────────────────────────────────────────────────────────────────────
    function resolvedZones(z) {
        var D = DA();
        z = z || {};
        var day = z.day || {};
        var rz = function (x) { return D ? D.resolveZone(x) : (x && x.mode !== 'device' ? x : { mode: 'utc' }); };
        return { gauge: rz(z.gauge), day: { zone: rz(day.zone), startHour: clamp(Math.round(num(+day.startHour, 0)), 0, 23) } };
    }
    // hex16 over canon(…, 'inputs') of everything that changes numbers (§4.9): well, completion, depth, clamped settings,
    // the resolved zones, history, allocation rows, rate table, record hash, overrides (kind, target, value) and workovers.
    function inputHash(input) {
        input = input || {};
        var st = input.stored || null;
        var rec = input.record ? input.record.hash : (st && st.record && st.record.hash) || null;
        return hash16(canon({
            well: input.well || null, completion: input.completion || null, depth: input.depth || null, settings: settingsOf(input.settings),
            zones: resolvedZones(input.zones), history: input.history || null,
            allocationRows: input.allocation && input.allocation.rows ? input.allocation.rows : null, rateTable: input.rateTable || null,
            recordHash: rec, workovers: (input.workovers || []).slice().sort(),
            overrides: (input.overrides || []).map(function (o) { return { id: o.id, kind: o.kind, target: o.target, value: o.value === undefined ? null : o.value }; })
        }, 'inputs'));
    }
    function resultHash(tests, trend) {
        return hash16(canon({
            tests: tests.map(function (t) {
                var r = t.result;
                return { id: t.id, final: r ? r.final : null, sErr: r && r.sErr ? r.sErr.value : null,
                         labels: r && r.confidence ? { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline } : null };
            }),
            alerts: trend ? trend.alerts : null, onset: trend ? trend.onset : null, recent: trend && trend.recent ? trend.recent.slopePer30d : null
        }, 'display'));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Specs (§3.1 BuildupSpec, stored form §3.1)
    // ─────────────────────────────────────────────────────────────────────
    // Log bins (perCycle per log10 cycle), medians; single-sample bins keep the raw value. PRiSM_autoInterp.bin when loaded.
    function _bin(dt, p, perCycle) {
        var a = AI();
        if (a && typeof a.bin === 'function') {
            var r = a.bin(dt, p, { perCycle: perCycle });
            if (r && r.dt && r.dt.length) return { dt: Array.from(r.dt), p: Array.from(r.p), n: r.n ? Array.from(r.n) : null };
        }
        var out = { dt: [], p: [], n: [] }, i = 0, n = dt.length;
        while (i < n) {
            var b = mFloor(perCycle * Math.log10(dt[i]) + 1e-9), j = i, ts = [], ps = [];
            while (j < n && mFloor(perCycle * Math.log10(dt[j]) + 1e-9) === b) { ts.push(dt[j]); ps.push(p[j]); j++; }
            out.dt.push(ts.length === 1 ? ts[0] : median(ts)); out.p.push(ps.length === 1 ? ps[0] : median(ps)); out.n.push(ts.length);
            i = j;
        }
        return out;
    }
    // σ_LF: 1.4826·MAD of the late-build-up bin medians (Δt ≥ max(2 h, Δt_end/4)) about a quadratic in ln Δt.
    function _sigmaLF(dt, p, dtEnd) {
        var lim = mMax(2, dtEnd / 4), xs = [], ys = [];
        for (var i = 0; i < dt.length; i++) if (dt[i] >= lim) { xs.push(mLog(dt[i])); ys.push(p[i]); }
        if (xs.length < 5) return null;
        var n = xs.length, x0 = xs.reduce(function (a, b) { return a + b; }, 0) / n;
        var S = [0, 0, 0, 0, 0], T = [0, 0, 0];
        for (var k = 0; k < n; k++) { var x = xs[k] - x0, y = ys[k]; var xp = 1; for (var e = 0; e < 5; e++) { S[e] += xp; if (e < 3) T[e] += xp * y; xp *= x; } }
        var A = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]], c = _solve3(A, T);
        if (!c) return null;
        var res = [];
        for (var q = 0; q < n; q++) { var xx = xs[q] - x0; res.push(ys[q] - (c[0] + c[1] * xx + c[2] * xx * xx)); }
        var m = madOf(res);
        return m === null ? null : 1.4826 * m;
    }
    function _solve3(A, b) {
        var M = A.map(function (r, i) { return r.concat([b[i]]); });
        for (var c = 0; c < 3; c++) {
            var piv = c; for (var r = c + 1; r < 3; r++) if (mAbs(M[r][c]) > mAbs(M[piv][c])) piv = r;
            if (!(mAbs(M[piv][c]) > 1e-300)) return null;
            var t = M[c]; M[c] = M[piv]; M[piv] = t;
            for (var r2 = 0; r2 < 3; r2++) if (r2 !== c) { var f = M[r2][c] / M[c][c]; for (var k = c; k < 4; k++) M[r2][k] -= f * M[c][k]; }
        }
        return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
    }
    function _wellForSpec(w, rh) {
        var water = w.fluid === 'water_inj', total = rh && rh.phaseBasis && rh.phaseBasis.used === 'total';
        return {
            fluid: w.fluid, h: w.h, phi: w.phi, mu: water ? w.muw : w.mu, B: water ? w.Bw : (total ? 1 : w.B), ct: w.ct, rw: w.rw,
            T_R: w.fluid === 'gas' && w.gas && isNum(w.gas.T_F) ? w.gas.T_F + 459.67 : null, re_ft: isNum(w.re_ft) && w.re_ft > 0 ? w.re_ft : null,
            defaulted: (w.defaulted || []).filter(function (k) { return typeof k === 'string' && k; })
        };
    }
    function _gasForSpec(w) {
        if (w.fluid !== 'gas' || !w.gas) return null;
        var g = w.gas;
        return { sg: num(g.sg, 0.65), T_F: num(g.T_F, 200), co2: num(g.co2, 0), h2s: num(g.h2s, 0), n2: num(g.n2, 0), pseudoTime: !!g.pseudoTime,
                 pdew: isNum(g.pdew) && g.pdew > 0 ? g.pdew : null };
    }
    function _ovFor(input, test) {
        var o = { window: null, model: null, excludeRivals: [] };
        (input.overrides || []).forEach(function (ov) {
            if (!ov || (ov.target !== test.id && ov.target !== test.eventId)) return;
            if (ov.kind === 'window' && ov.value && isNum(+ov.value.dt0_h) && isNum(+ov.value.dt1_h) && +ov.value.dt1_h > +ov.value.dt0_h && +ov.value.dt0_h > 0) o.window = { dt0_h: +ov.value.dt0_h, dt1_h: +ov.value.dt1_h };
            if (ov.kind === 'model' && ['homogeneous', 'linearBoundary', 'composite2', 'closedCircle'].indexOf(ov.value) >= 0) o.model = ov.value;
        });
        return o;
    }

    // Event + record + RateHistory + AnalysisInput → BuildupSpec (in-memory form, dt/p at 6 significant figures so the
    // engine sees exactly what the stored form reproduces). o {id, origin_ms, settings, qc, test} → spec or a failure.
    function specFor(event, record, rh, input, o) {
        o = o || {};
        input = input || {};
        var D = DA(), w = input.well || {}, st = o.settings || settingsOf(input.settings), q = o.qc || {};
        if (!event || !record || !record.t || !rh) return fail('NO_DATA', ['Event, record and rates are needed.'], ['event']);
        var t = record.t, p = record.p, n = t.length, sign = event.kind === 'falloff' ? -1 : 1;
        var origin = isNum(o.origin_ms) ? o.origin_ms : record.origin_ms;
        var i0 = D.util.lowerBound(t, event.tc_ms + 1), i1 = D.util.lowerBound(t, event.tEnd_ms + 1);
        var dt = [], pp = [], gaps = [];
        for (var i = i0; i < i1 && i < n; i++) { dt.push((t[i] - event.tc_ms) / HOUR); pp.push(p[i]); if (i > i0) gaps.push((t[i] - t[i - 1]) / HOUR); }
        if (dt.length < 5) return fail('TOO_FEW_POINTS', ['Fewer than 5 shut-in samples.'], ['event']);
        var bins = _bin(dt, pp, 20);
        var be = (rh.byEvent && rh.byEvent[event.id]) || {};
        var fh = isNum(event.fhat) && event.fhat >= 0.9 && event.fhat < 0.95 && event.fhatMethod === 'dpDiff' ? event.fhat : 1;
        var Dq = num(be.Dq, num(event.qBefore, 0)) * fh;
        if (!(Dq > 0)) return fail('NO_RATE', ['The rate before closing is unknown.'], ['Dq']);
        var steps = D.historySteps(rh, origin, event.tc_ms);
        if (steps.length < 2) return fail('BAD_HISTORY', ['No flowing period before the closing in the rate history.'], ['steps']);
        var table = rh.mode === 'table', hist = rh.start || {};
        var spec = {
            id: o.id || event.id, testType: sign < 0 ? 'falloff' : 'buildup', tc_h: (event.tc_ms - origin) / HOUR, dtc_h: num(event.dtc_s, 0) / 3600,
            pwf0: event.pwf0, pwf0SE: num(event.pwf0SE, 0), dpdt_flow: num(event.trend && event.trend.b, 0),
            dt: bins.dt.map(sf6), p: bins.p.map(sf6), n: bins.n,
            steps: steps, qUnit: rh.unit, Dq: Dq, fRate: fh,
            rateQC: { source: table ? 'table' : 'allocation', r3: table ? null : fin(be.r3), r3Status: table ? 'n/a' : (be.r3Status || 'unavailable'),
                      r4: null, r4Status: table ? 'n/a' : 'unavailable', dqKnown: Dq > 0, dqSource: table ? 'table' : (be.dqSource || 'closingDay'),
                      equalRateAssumed: !!be.equalRateAssumed, ignoresShutin: !!be.ignoresShutin, allocAccPct: num(w.allocAccPct, 5) },
            well: _wellForSpec(w, rh), gas: _gasForSpec(w),
            sigma_psi: num(q.sigmaShut_psi, num(q.sigma_psi, 0)), sigmaFlow_psi: num(q.sigmaFlow_psi, num(q.sigma_psi, 0)),
            sigmaLF_psi: _sigmaLF(bins.dt, bins.p, event.dtEnd_h), dtSample_h: gaps.length ? median(gaps) : 1 / 60,
            driftPsiPerDay: num(w.driftPsiPerDay, 0.01),
            history: { estimated: !!hist.flag, tPrepend_h: num(hist.prepend_h, 0), source: hist.source || 'data' },
            overrides: o.test ? _ovFor(input, o.test) : { window: null, model: null, excludeRivals: [] },
            opts: { Lcyc: st.interp.Lcyc, binsPerCycle: 20, fitBinsPerCycle: 12, rivals: st.interp.rivals, cheld: st.interp.cheld, tide: st.interp.tide }
        };
        if (!(spec.dtSample_h > 0)) spec.dtSample_h = 1 / 60;
        return spec;
    }
    function storedSpec(spec, rh, tc_ms) {
        var s = {};
        Object.keys(spec).forEach(function (k) { if (k !== 'steps') s[k] = clone(spec[k]); });
        s.dt = spec.dt.map(sf6); s.p = spec.p.map(sf6); s.n = spec.n ? spec.n.slice() : null;
        var to = DA().stepIndexAt(rh, tc_ms);
        if (to < 0) return null;
        s.stepRef = { from: 0, to: to };
        return s;
    }
    function rehydrate(stored, rh, origin) {
        var s = clone(stored), ref = s.stepRef || { from: 0, to: 0 };
        delete s.stepRef;
        s.steps = (rh.steps || []).slice(ref.from, ref.to + 1).map(function (x) { return { t: (x.t_ms - origin) / HOUR, q: x.q }; });
        return s;
    }
    function cacheKey(spec, st, calVersion) {
        var s = {};
        Object.keys(spec).forEach(function (k) { if (k !== 'stepRef') s[k] = spec[k]; });
        return hash16(canon({ spec: s, interp: st.interp, cal: calVersion || null }, 'inputs'));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Test list, overrides and the 60-test cap
    // ─────────────────────────────────────────────────────────────────────
    function isShut(e) { return e && (e.kind === 'shutin' || e.kind === 'falloff') && !e.dropped; }
    function _segment(date, workovers) { var s = 0; (workovers || []).forEach(function (w) { if (typeof w === 'string' && w <= date) s++; }); return s; }

    // Applies event_drop, tc and event_add overrides to the detected events (called by data.scanJob after detection).
    function adjustEvents(events, record, q, input, zones) {
        var D = DA(), ovs = input.overrides || [], maxId = 0;
        events.forEach(function (e) { var k = parseInt(String(e.id).slice(1), 10); if (k > maxId) maxId = k; });
        var opts = { settings: settingsOf(input.settings).detect, fluid: input.well && input.well.fluid, day: zones.day };
        ovs.forEach(function (ov) {
            if (!ov) return;
            if (ov.kind === 'event_drop') {
                var e = events.filter(function (x) { return x.id === ov.target; })[0];
                if (e) { e.dropped = true; e.status = 'excluded'; e.warnings.push(W('EVENT_DROPPED', 'info', 'Removed by override ' + ov.id + '.', ['D1'])); }
            } else if (ov.kind === 'tc' && /^E\d+$/.test(String(ov.target)) && isNum(+(ov.value && ov.value.tc_ms !== undefined ? ov.value.tc_ms : ov.value))) {
                var idx = -1;
                events.forEach(function (x, i) { if (x.id === ov.target) idx = i; });
                if (idx < 0) return;
                var tc = +(ov.value && ov.value.tc_ms !== undefined ? ov.value.tc_ms : ov.value);
                var prevEnd = idx > 0 ? events[idx - 1].tEnd_ms : null;
                var ne = D.eventAt(record, q, tc, Object.assign({ exact: true, prevEnd_ms: prevEnd }, opts));
                if (ne) { ne.id = ov.target; ne.manual = true; ne.warnings.push(W('TC_OVERRIDE', 'info', 'Closing time set by override ' + ov.id + '.', ['D2'])); events[idx] = ne; }
            } else if (ov.kind === 'event_add') {
                var v = ov.value, tAdd = isNum(+v) ? +v : (v && isNum(+v.t_ms) ? +v.t_ms : (v && isNum(+v.tc_ms) ? +v.tc_ms : NaN));
                if (!isNum(tAdd)) return;
                var prev = null;
                events.forEach(function (x) { if (x.tc_ms < tAdd && (!prev || x.tc_ms > prev.tc_ms)) prev = x; });
                var ae = D.eventAt(record, q, tAdd, Object.assign({ exact: !!(v && v.exact), prevEnd_ms: prev ? prev.tEnd_ms : null }, opts));
                if (ae) { maxId++; ae.id = 'E' + maxId; ae.warnings.push(W('EVENT_ADDED', 'info', 'Added by override ' + ov.id + '.', ['D1'])); events.push(ae); }
            }
        });
        events.sort(function (a, b) { return a.tc_ms - b.tc_ms; });
        return events;
    }
    function _overrideState(input, ids) {
        var st = {};
        (input.overrides || []).forEach(function (ov) {
            if (!ov || !ov.target) return;
            if (ov.kind === 'exclude') st[ov.target] = { s: 'exclude', ov: ov };
            else if (ov.kind === 'include') st[ov.target] = { s: 'include', ov: ov };
        });
        return st;
    }
    // More than 60 tests: keep by selection (baseline tests of each segment, the longest per week newest first, the longest
    // per day newest first, then the newest); the others are excluded with the reason 'test cap'.
    function _cap(tests, st, workovers) {
        var live = tests.filter(function (t) { return t.status !== 'excluded'; });
        if (live.length <= MAX_TESTS) return;
        var keep = {}, nKeep = 0;
        function add(t) { if (!keep[t.id] && nKeep < MAX_TESTS) { keep[t.id] = 1; nKeep++; } }
        var segs = {};
        live.forEach(function (t) { var s = _segment(t.date, workovers); (segs[s] = segs[s] || []).push(t); });
        Object.keys(segs).forEach(function (s) { segs[s].slice(0, st.trend.baseN).forEach(add); });
        function longestBy(keyFn) {
            var best = {};
            live.forEach(function (t) { var k = keyFn(t); if (!best[k] || t.dtEnd_h > best[k].dtEnd_h) best[k] = t; });
            return Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) { return b.tc_ms - a.tc_ms; });
        }
        longestBy(function (t) { return mFloor((t.tc_ms - 345600000) / WEEK); }).forEach(add);     // weeks start on Monday 00:00 UTC
        longestBy(function (t) { return t.date; }).forEach(add);
        live.slice().sort(function (a, b) { return b.tc_ms - a.tc_ms; }).forEach(add);
        live.forEach(function (t) { if (!keep[t.id]) { t.status = 'excluded'; t.statusReason = 'test cap'; t._capped = true; } });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Pass 2 helpers (stage 3)
    // ─────────────────────────────────────────────────────────────────────
    function theilSenSlope(x, y) {
        var s = [];
        for (var i = 0; i < x.length; i++) for (var j = i + 1; j < x.length; j++) if (x[j] !== x[i]) s.push((y[j] - y[i]) / (x[j] - x[i]));
        return s.length ? median(s) : null;
    }
    function _dteEnd(res, spec) {
        if (res.evidence && isNum(res.evidence.dteEnd_h)) return res.evidence.dteEnd_h;
        if (res.bins && res.bins.dte && res.bins.dte.length) return res.bins.dte[res.bins.dte.length - 1];
        return spec.dt[spec.dt.length - 1];
    }
    function _kHeldEligible(res, spec) {
        var ia = res.iarf || {}, tr = res.triggers || {}, reach = res.reach || {};
        if (ia.grade === 'none' && tr.noneSkipped) return true;
        if (ia.grade === 'fair' && isNum(ia.cycles) && ia.cycles < 0.6 && isNum(reach.fair_h) && _dteEnd(res, spec) < reach.fair_h) return true;
        return false;
    }
    // Final values and S_err of a k-held test (§4.6 items 13, 15, 18).
    function _applyKHeld(res, kh, spec) {
        var w = spec.well, k = kh.k, S = kh.fit && kh.fit.phys ? kh.fit.phys.S : res.final.S, C = kh.fit && kh.fit.phys ? kh.fit.phys.C : res.final.C;
        var m = 162.6 * spec.Dq * w.B * w.mu / (k * w.h);
        var f = res.final, dtEnd = spec.dt[spec.dt.length - 1], dteEnd = _dteEnd(res, spec);
        f.k = k; f.kh = k * w.h; f.S = S; f.C = C; f.source = 'kHeld'; f.m = m; f.mPrime = m / LN10; f.dpSkin_psi = 0.8686 * m * S;
        f.rinv_ft = 0.0325 * mSqrt(k * dtEnd / (w.phi * w.mu * w.ct)); f.rinvE_ft = 0.0325 * mSqrt(k * dteEnd / (w.phi * w.mu * w.ct));
        var sTc = 1.1513 * mAbs(spec.dpdt_flow) * spec.dtc_h / m, sPwf = 1.1513 * spec.pwf0SE / m;
        var floor = res.sErr && isNum(res.sErr.floor) ? res.sErr.floor : 0.2, seS = kh.fit && kh.fit.se && isNum(kh.fit.se.S) ? kh.fit.se.S : 0;
        var a = AI(), se = null;
        if (a && typeof a.sErr === 'function') { try { se = a.sErr({ mode: 'kHeld', seS: seS, sTc: sTc, sPwf: sPwf, sK: kh.S_k, floor: floor }); } catch (e) { se = null; } }
        if (!se || !isNum(se.value)) {
            var terms = [['floor', floor], ['se', seS], ['tc', sTc], ['pwf', sPwf], ['kHeld', num(kh.S_k, 0)]];
            var top = terms.reduce(function (x, y) { return y[1] > x[1] ? y : x; });
            se = { value: top[1], mode: 'kHeld', floor: floor, seS: seS, dLineMatch: null, sWin: null, sTc: sTc, sPwf: sPwf, sK: num(kh.S_k, 0), driver: top[0] };
        }
        var old = res.sErr || {}, sSens = num(old.sSens, 0), SC = old.ext && isNum(old.ext.S_C) ? old.ext.S_C : 0;
        se.ext = { value: mMax(se.value, SC), S_C: SC }; se.sSens = sSens; se.sAbs = mSqrt(se.value * se.value + sSens * sSens); se.ev = ['U1'];
        res.sErr = se;
        res.kHeld = kh;
    }
    function _trendTest(t, first_ms, shift) {
        var r = t.result, f = r.final, sp = t.spec;
        var dte = r.bins && r.bins.dte ? r.bins.dte : null, dp = r.bins && r.bins.dp ? r.bins.dp : null;
        var add = function (v) { return isNum(v) ? v + shift : null; };
        return {
            id: t.id, t_ms: t.tc_ms, tDays: (t.tc_ms - first_ms) / DAY, date: t.date, S: f.S, Serr: r.sErr ? r.sErr.value : null,
            SerrExt: r.sErr && r.sErr.ext ? r.sErr.ext.value : null, SerrMode: r.sErr ? r.sErr.mode : 'line',
            k: f.k, kh: f.kh, C: f.C, m: f.m, mPrime: f.mPrime, pStarDatum: add(f.pStar),
            pStarRangeDatum: f.pStarRange ? { lo: f.pStarRange.lo + shift, hi: f.pStarRange.hi + shift } : null,
            pExtDatum: add(f.pExt), pExtKind: f.pExtKind || 'pStar', piModelDatum: add(f.piModel), pwf0Datum: t.pwf0Datum, Dq: t.Dq, qUnit: t.qUnit,
            rinv_ft: f.rinv_ft, dpSkin_psi: f.dpSkin_psi, conf: { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline },
            chosen: r.chosen ? r.chosen.key : 'homogeneous', fullySeen: r.chosen && r.chosen.fullySeen ? r.chosen.fullySeen.status : 'n/a', kHeld: !!r.kHeld,
            excluded: t.status !== 'interpreted', excludedReason: t.status !== 'interpreted' ? (t.statusReason || 'Excluded.') : null,
            gasSprime: f.gas ? f.gas.Sprime : null, partialSuspect: !!t.partialSuspect, iarfDt0_h: r.iarf && r.iarf.found ? r.iarf.dt0_h : null,
            dtEnd_h: t.dtEnd_h, dteEnd_h: _dteEnd(r, sp), reachFair_h: r.reach ? r.reach.fair_h : null, reachGood_h: r.reach ? r.reach.good_h : null,
            reachFairShut_h: r.reach ? r.reach.fairShut_h : null, reachGoodShut_h: r.reach ? r.reach.goodShut_h : null,
            bins: { dte: dte ? dte.slice() : (r.bins ? r.bins.dt.slice() : []), dp: dp ? dp.slice() : [] }
        };
    }
    // A disabled trend (trend module not loaded): the same shape, nothing computed.
    function _fallbackTrend(tt, st, used, baseIds, qUnit, reason) {
        return {
            ok: false, n: tt.length, nUsed: tt.filter(function (x) { return used[x.id]; }).length, enabled: false, disabledReason: reason,
            baseline: { S: null, sigma: null, tests: baseIds.slice(), unstable: false, provisional: true, segments: [], ev: ['T1'] },
            series: tt.map(function (x) {
                return { id: x.id, tDays: x.tDays, S: x.S, Serr: x.Serr, k: x.k, pExt: x.pExtDatum, pwf0Datum: x.pwf0Datum, Smech: null, SmechErr: null, Sd: null,
                         conf: x.conf, used: { baseline: baseIds.indexOf(x.id) >= 0, trend: !!used[x.id], alert: !!used[x.id] } };
            }),
            excludedLow: { n: 0, ids: [], S: null, ev: ['T16'] },
            alerts: {
                delta: { threshold: st.trend.delta, form: st.trend.basevar ? 'basevar' : 'plain', raisedAt: null, confirmedAt: null, status: 'none', kHeldOnly: false, inputRobust: true, ev: ['T2'] },
                absolute: { threshold: st.trend.abs, basis: 'total', raisedAt: null, confirmedAt: null, status: 'none', kHeldOnly: false, robustness: { lo: null, hi: null, unchanged: true }, ev: ['T3'] }
            },
            onset: { tauDays: null, interval: null, date: null, model: 'constant', cusum: { alarmAt: null, onsetAt: null }, indicative: true, ev: ['T4'] },
            recent: { slopePer30d: null, ci: [null, null], mkZ: null, mkP: null, n: 0, indicative: true, wlsSlopePer30d: null, disagree: false, ev: ['T5'] },
            forecast: { show: false, date: null, earliest: null, latest: null, reason: 'The trend was not computed.', ev: ['T6'] },
            skinDp: tt.map(function (x) { return { id: x.id, dpSkin_psi: x.dpSkin_psi }; }),
            pi: { X: null, re_ft: null, reSource: 'rinv', ratioNow: null, ratioBase: null, ratioLowerBound: true, rateAtStake: null, rateUnit: qUnit || 'STB/d',
                  extraDrawdown_psi: null, cumAtStake: null, cumUnit: (qUnit || 'STB/d').replace('/d', ''), atStakeUpperBound: true, value: null, guard: false, ev: ['T8'] },
            kStability: { cv: null, stable: false, allocAccPct: 5, reading: 'none', ev: ['T9'] },
            pTrend: { quantity: 'pStar', assessable: false, reason: 'The trend was not computed.', slopePer30d: null, scatter: null, depletion: null, label: 'Not assessed.', ev: ['T10'] },
            modelFree: [], bubble: { rows: [], spearman: null, ev: ['T12'] },
            piCheck: { available: false, reason: 'The trend was not computed.', rows: [], consistent: null, rho: null, ev: ['T13'] },
            mech: { available: false, Sgeo: null, SgeoRange: [null, null], basis: 'pressureDrop', ev: ['T14'] },
            rateSkin: { resolved: false, S: null, D: null, seD: null, reason: 'The trend was not computed.', dqEffect: null, ev: ['T15'] },
            crossTest: { windowLevelInconsistent: [], closedWithoutDepletion: [] }, recommendations: [], limitations: []
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // The pipeline job
    // ─────────────────────────────────────────────────────────────────────
    // input: AnalysisInput; opts {cache: Analysis|null}
    function job(input, opts) {
        opts = opts || {};
        var X = { phase: 'start', res: null, cancelled: false, sub: null, i: 0, warnings: [], order: [] };
        var D, st, zones, an, tests, scanRes, cal, calVersion, statsStart, kBase = null, cvK = 0, seMedK = 0, candK = [];

        function finish(r) { X.res = r; X.phase = 'done'; return { done: true, progress: 1, label: r && r.ok === false ? 'Stopped' : 'Analysis complete' }; }
        function prog(a, b, f) { return a + (b - a) * clamp(num(f, 0), 0, 1); }

        function start() {
            if (!input || typeof input !== 'object' || (!input.record && !input.stored)) return finish(fail('NO_DATA', ['No gauge data and no stored analysis.'], ['record']));
            D = DA();
            if (!D) return finish(fail('NO_ENGINE', ['The data module is not loaded.'], []));
            var bw = checkWell(input.well);
            if (bw) return finish(bw);
            st = settingsOf(input.settings);
            zones = resolvedZones(input.zones);
            cal = G.PRiSM_autoInterpCal || null;
            calVersion = cal && cal.version ? cal.version : null;
            var a = AI();
            statsStart = a && typeof a.stats === 'function' ? clone(a.stats()) : null;
            if (input.record) {
                X.sub = D.scanJob(input.record, {
                    settings: st, zones: zones, allocation: input.rateTable && input.rateTable.length ? null : input.allocation, rateTable: input.rateTable,
                    history: input.history, well: input.well, depth: input.depth, workovers: input.workovers,
                    adjust: function (evs, rec, q) { return adjustEvents(evs, rec, q, input, zones); }
                });
                X.phase = 'scan';
                return { done: false, progress: 0.01, label: 'Reading the gauge data' };
            }
            var s = input.stored;
            if (!s.events || !s.rates || !s.qc || !s.tests) return finish(fail('NO_DATA', ['The stored analysis is incomplete.'], ['stored']));
            scanRes = { ok: true, qc: clone(s.qc), events: clone(s.events), rates: clone(s.rates), record: null, missed: clone(s.missed) || null };
            X.phase = 'tests';
            return { done: false, progress: 0.25, label: 'Stored build-ups' };
        }
        function scan() {
            var r = X.sub.step();
            if (!r.done) return { done: false, progress: prog(0.02, 0.25, r.progress), label: r.label };
            scanRes = X.sub.result(); X.sub = null;
            if (!scanRes || scanRes.ok === false) return finish(scanRes || fail('NO_DATA', ['The gauge data could not be analysed.'], ['record']));
            X.phase = 'tests';
            return { done: false, progress: 0.25, label: 'Shut-ins classified' };
        }
        // Test list, overrides, cap, specs and cache lookup (one unit).
        function buildTests() {
            var rh = scanRes.rates, events = scanRes.events, rec = scanRes.record || input.record;
            var ovs = _overrideState(input);
            var shift = D.depthShift(input.depth);
            tests = [];
            var storedById = {};
            if (!rec) (input.stored.tests || []).forEach(function (x) { storedById[x.eventId] = x; });
            var origin = rec ? rec.origin_ms : null;
            var cand = events.filter(function (e) {
                if (!isShut(e)) return false;
                if (!rec && !storedById[e.id]) return false;
                if (e.status === 'analysable') return true;
                return !!(ovs[e.id] && ovs[e.id].s === 'include');
            });
            X.cand = cand; X.ci = 0; X.k = 0; X.bt = { rh: rh, rec: rec, ovs: ovs, shift: shift, storedById: storedById, origin: origin };
            X.phase = 'specs';
            return { done: false, progress: 0.26, label: cand.length + ' shut-ins to interpret' };
        }
        // One spec per unit (binning, stored form, cache key).
        function specUnit() {
            if (X.ci >= X.cand.length) { X.phase = 'finishTests'; return { done: false, progress: 0.29, label: 'Specs' }; }
            var e = X.cand[X.ci++], rh = X.bt.rh, rec = X.bt.rec, ovs = X.bt.ovs, shift = X.bt.shift, storedById = X.bt.storedById, origin = X.bt.origin;
            (function () {
                var id = 'B' + (X.k + 1), t = {
                    id: id, eventId: e.id, date: e.alloc && e.alloc.date ? e.alloc.date : D.dayOf(e.tc_ms, zones.day), tc_ms: e.tc_ms, dtEnd_h: mMax(e.dtEnd_h, 1e-6),
                    Dq: null, qUnit: rh.unit, pwf0: e.pwf0, pwf0Datum: e.pwf0 + shift, pStarDatum: null, pExtDatum: null,
                    status: 'interpreted', statusReason: e.status !== 'analysable' ? 'Included by override (event status ' + e.status.replace(/_/g, ' ') + ').' : null,
                    spec: null, result: null, used: { baseline: false, trend: false, alert: false }, partialSuspect: false, overrides: []
                };
                (input.overrides || []).forEach(function (ov) { if (ov && (ov.target === id || ov.target === e.id)) t.overrides.push(ov.id); });
                var o2 = ovs[id] || ovs[e.id];
                if (o2 && o2.s === 'exclude') { t.status = 'excluded'; t.statusReason = 'Excluded by override ' + o2.ov.id + ': ' + String(o2.ov.reason || '').slice(0, 200); }
                // spec
                var spec, sto;
                if (rec) {
                    spec = specFor(e, rec, rh, input, { id: id, origin_ms: origin, settings: st, qc: scanRes.qc, test: t });
                    if (spec.ok === false) { e.warnings.push(W('NOT_INTERPRETED', 'warn', 'Not interpreted: ' + spec.errors.join(' '), ['D5'])); return; }
                    sto = storedSpec(spec, rh, e.tc_ms);
                    if (!sto) { e.warnings.push(W('NOT_INTERPRETED', 'warn', 'Not interpreted: the closing is not in the rate history.', ['R5'])); return; }
                    spec = rehydrate(sto, rh, origin);
                } else {
                    sto = clone(storedById[e.id].spec);
                    sto.id = id;
                    // the stage-1 spec never carries R4 (filled in stage 3), so the engine and the cache key see what record mode sees
                    sto.rateQC.r4 = null; sto.rateQC.r4Status = rh.mode === 'table' ? 'n/a' : 'unavailable';
                    sto.overrides = _ovFor(input, t);
                    var org = e.tc_ms - sto.tc_h * HOUR;
                    spec = rehydrate(sto, rh, org);
                }
                X.k++;
                t.Dq = spec.Dq; t.spec = sto; t._spec = spec; t._event = e;
                t._key = cacheKey(sto.stepRef ? Object.assign({}, sto, { steps: spec.steps }) : sto, st, calVersion);
                tests.push(t);
            })();
            return { done: false, progress: 0.26 + 0.03 * X.ci / X.cand.length, label: 'Preparing ' + e.id };
        }
        // The 60-test cap and the cache lookup.
        function finishTests() {
            _cap(tests, st, input.workovers);
            // cache
            var cache = {};
            if (opts.cache && opts.cache.tests) opts.cache.tests.forEach(function (c) { if (c && c.inputHash && c.result && c.pass1) cache[c.inputHash] = c; });
            tests.forEach(function (t) {
                t.inputHash = t._key;
                var c = cache[t._key];
                if (c && !t._capped) {
                    var r = clone(c.result);
                    r.id = t.id;
                    r.confidence = clone(c.pass1.confidence); r.final = clone(c.pass1.final); r.sErr = clone(c.pass1.sErr);
                    if (c.pass1.evidence !== undefined) r.evidence = clone(c.pass1.evidence);
                    r.kHeld = null; r.background = null;
                    t.result = r; t._cached = true;
                }
            });
            X.phase = 'stage1'; X.i = 0;
            return { done: false, progress: 0.3, label: tests.length + ' build-ups' };
        }
        function stage1() {
            while (X.i < tests.length && (tests[X.i]._capped || tests[X.i]._cached)) X.i++;
            if (X.i >= tests.length) { X.phase = 'stage2'; return { done: false, progress: 0.85, label: 'Interpretation done' }; }
            var t = tests[X.i], a = AI(), lab = 'Interpreting ' + t.id + ' (' + (X.i + 1) + '/' + tests.length + ')';
            if (!X.sub) {
                if (!a || typeof a.interpretJob !== 'function') { t.status = 'failed'; t.statusReason = 'The interpretation engine is not loaded.'; X.i++; return { done: false, progress: prog(0.3, 0.85, X.i / tests.length), label: lab }; }
                try { X.sub = a.interpretJob(t._spec, { cal: cal, rivals: st.interp.rivals, cheld: st.interp.cheld }); }
                catch (e) { X.sub = null; t.status = 'failed'; t.statusReason = 'Interpretation failed: ' + String(e && e.message || e).slice(0, 200); X.i++; return { done: false, progress: prog(0.3, 0.85, X.i / tests.length), label: lab }; }
                X.order.push('interpret:' + t.id);
            }
            var r;
            try { r = X.sub.step(); } catch (e2) { r = { done: true, error: e2 }; }
            if (!r.done) return { done: false, progress: prog(0.3, 0.85, (X.i + num(r.progress, 0)) / tests.length), label: lab };
            var res = r.error ? null : X.sub.result();
            X.sub = null;
            if (r.error || !res || res.ok === false) {
                t.status = 'failed';
                t.statusReason = r.error ? 'Interpretation failed: ' + String(r.error && r.error.message || r.error).slice(0, 200)
                    : 'Interpretation failed' + (res && (res.reason || res.code) ? ' (' + String(res.reason || res.code).replace(/_/g, ' ').toLowerCase() + ')' : '') + '.';
                t.result = null;
            } else {
                t.result = res;
                if (t.result.id !== t.id) t.result.id = t.id;
            }
            X.i++;
            return { done: false, progress: prog(0.3, 0.85, X.i / tests.length), label: lab };
        }
        function snapshotPass1() {
            tests.forEach(function (t) {
                if (!t.result) return;
                if (t.result.confidence) t.result.confidence.stage = 'pass1';
                t.pass1 = { confidence: clone(t.result.confidence), final: clone(t.result.final), sErr: clone(t.result.sErr) };
                if (t.result.evidence !== undefined) t.pass1.evidence = clone(t.result.evidence);
            });
        }
        // Stage 2: baseline over the pass-1 tests whose k/S label is ≥ medium (first up to baseN per segment).
        function stage2() {
            snapshotPass1();
            X.order.push('baseline');
            var cands = tests.filter(function (t) { return t.status === 'interpreted' && t.result && t.result.confidence && rank(t.result.confidence.ks) >= 1; });
            var first = tests.length ? tests[0].tc_ms : 0, shift = D.depthShift(input.depth);
            var tt = cands.map(function (t) { return _trendTest(t, first, shift); });
            var T = TR(), b = null, ids = null;
            if (T && typeof T.baseline === 'function') {
                try { b = T.baseline(tt, st.trend.baseN, { workovers: input.workovers || [], settings: st, stage: 2 }); } catch (e) { b = null; }
                if (b && Array.isArray(b.tests)) ids = b.tests.filter(function (id) { return tt.some(function (x) { return x.id === id; }); });
            }
            if (!ids || !ids.length) {
                var segs = {};
                ids = [];
                cands.forEach(function (t) { var s = _segment(t.date, input.workovers); segs[s] = (segs[s] || 0) + 1; if (segs[s] <= st.trend.baseN) ids.push(t.id); });
            }
            candK = cands.map(function (t) { return t.result.final.k; }).filter(isNum);
            if (cands.length && ids.length) {
                kBase = median(cands.filter(function (t) { return ids.indexOf(t.id) >= 0; }).map(function (t) { return t.result.final.k; }));
                var mk = median(candK), md = madOf(candK);
                cvK = (mk && md !== null) ? 1.4826 * md / mk : 0;
                seMedK = (mk && md !== null && candK.length) ? 1.2533 * 1.4826 * md / (mSqrt(candK.length) * mk) : 0;
                X.baseline = { k: kBase, cvK: cvK, kh: kBase * input.well.h, tests: ids };
            } else X.baseline = null;
            X.phase = 'stage3'; X.i = 0; X.k3 = null;
            return { done: false, progress: 0.87, label: 'Baseline' };
        }
        // Stage 3a: k-held fits for eligible tests (one prepare unit, then the fit's units).
        function stage3() {
            if (!X.baseline || st.interp.kHeld === 'off') { X.phase = 'stage3b'; return { done: false, progress: 0.9, label: 'Pass 2' }; }
            var a = AI();
            if (!X.sub) while (X.i < tests.length && !_kHeldReady(tests[X.i])) X.i++;
            if (X.i >= tests.length || !a || typeof a.kHeldJob !== 'function' || typeof a.prepare !== 'function') { X.phase = 'stage3b'; return { done: false, progress: 0.9, label: 'Pass 2' }; }
            var t = tests[X.i];
            if (!X.sub) {
                var prep = null;
                try { prep = a.prepare(t._spec); } catch (e) { prep = null; }
                X.order.push('kHeld:' + t.id);
                if (!prep || prep.ok === false) { X.i++; return { done: false, progress: 0.88, label: 'k-held ' + t.id }; }
                var delta = mSqrt(cvK * cvK + Math.pow(num(input.well.allocAccPct, 5) / 100, 2) + seMedK * seMedK);
                try { X.sub = a.kHeldJob(prep, { k: kBase, delta: delta }); } catch (e3) { X.sub = null; X.i++; }
                return { done: false, progress: 0.88, label: 'k-held ' + t.id };
            }
            var r;
            try { r = X.sub.step(); } catch (e2) { r = { done: true, error: e2 }; }
            if (!r.done) return { done: false, progress: 0.88, label: 'k-held ' + t.id };
            var kh = r.error ? null : X.sub.result();
            X.sub = null;
            if (kh && kh.ok !== false && isNum(kh.k)) _applyKHeld(t.result, kh, t._spec);
            else if (t.result.evidence) t.result.evidence.kHeldConverged = false;
            X.i++;
            return { done: false, progress: 0.89, label: 'k-held ' + t.id };
        }
        function _kHeldReady(t) { return t && t.status === 'interpreted' && t.result && !t.result.kHeld && _kHeldEligible(t.result, t._spec); }
        // Stage 3b: background check, partial-cut suspicion, R4, window-level check, final confidence; frozen used set.
        function stage3b() {
            var a = AI(), rh = scanRes.rates, well = input.well, acc = num(well.allocAccPct, 5) / 100;
            var interp = tests.filter(function (t) { return t.result && t.status !== 'failed'; });
            var estimated = !!(rh.start && rh.start.flag);
            // background slope: Theil–Sen of the pass-1 p_ext (psi/h), or the drift input with < 3 tests or an estimated history
            var px = [], py = [];
            interp.forEach(function (t) { var pe = t.pass1 && t.pass1.final ? t.pass1.final.pExt : null; if (isNum(pe) && t.status === 'interpreted') { px.push(t.tc_ms / HOUR); py.push(pe); } });
            var useTs = px.length >= 3 && !estimated, bg = useTs ? theilSenSlope(px, py) : null;
            if (!isNum(bg)) { bg = -num(well.driftPsiPerDay, 0.01) / 24; useTs = false; }
            var kStable = cvK <= mMax(0.05, acc);
            var dayBy = {};
            (rh.days || []).forEach(function (d, i) { dayBy[d.date] = i; });
            var pk = interp.filter(function (t) { return t.status === 'interpreted' && t.pass1 && isNum(t.pass1.final.pExt); })
                .map(function (t) { return [t.tc_ms, t.pass1.final.pExt]; }).sort(function (x, y) { return x[0] - y[0]; });
            function pRefAt(ms) {
                if (!pk.length) return null;
                if (ms <= pk[0][0]) return pk[0][1];
                for (var i = 1; i < pk.length; i++) if (ms <= pk[i][0]) return pk[i - 1][1] + (pk[i][1] - pk[i - 1][1]) * (ms - pk[i - 1][0]) / (pk[i][0] - pk[i - 1][0]);
                return pk[pk.length - 1][1];
            }
            interp.forEach(function (t) {
                var res = t.result, ev = res.evidence ? res.evidence : null, sp = t._spec, w = sp.well;
                // background check
                if (a && typeof a.backgroundCheck === 'function') {
                    try {
                        var bc = a.backgroundCheck(res, sp, bg);
                        if (bc) res.background = { applied: !!bc.applied, slopeSource: useTs ? 'pstar' : 'drift', boundaryDepends: !!bc.boundaryDepends, ev: ['M7'] };
                    } catch (e) { /* keep null */ }
                    X.order.push('background:' + t.id);
                }
                // partial-cut suspicion (free tests with an IARF, k stable elsewhere)
                var ia = res.iarf || {};
                t.partialSuspect = false;
                if (!res.kHeld && ia.found && isNum(ia.level_psi) && X.baseline && kStable && well.fluid !== 'gas') {
                    var mExp = 70.6 * sp.Dq * w.B * w.mu / (X.baseline.k * w.h);
                    if (mExp > 0 && ia.level_psi / mExp < 0.7) t.partialSuspect = true;
                }
                // window-level check
                var wli = false;
                if (!res.kHeld && ia.found && isNum(ia.level_psi) && ia.level_psi > 0 && X.baseline && well.fluid !== 'gas') {
                    var kLev = 70.6 * sp.Dq * w.B * w.mu / (ia.level_psi * w.h), tol = 2 * mMax(cvK, acc, 0.05) * X.baseline.k;
                    wli = mAbs(kLev - X.baseline.k) > tol;
                }
                // R4 constant-PI check on the closing day
                var r4 = null, r4s = rh.mode === 'table' ? 'n/a' : 'unavailable';
                if (rh.mode !== 'table' && !estimated && pk.length >= 2) {
                    var di = dayBy[t.date], d = di !== undefined ? rh.days[di] : null;
                    if (d && isNum(d.pwfMean_psia) && isNum(d.qRef)) {
                        var near = rh.days.filter(function (x) { return x.cls === 'clean' && isNum(x.pwfMean_psia) && mAbs(x.t0_ms - d.t0_ms) <= 10.5 * DAY; });
                        var pwfRef = median(near.map(function (x) { return x.pwfMean_psia; })), pRef = pRefAt(0.5 * (d.t0_ms + d.t1_ms));
                        if (isNum(pwfRef) && isNum(pRef) && mAbs(pRef - pwfRef) > 1e-6) {
                            var qPred = d.qRef * (pRef - d.pwfMean_psia) / (pRef - pwfRef), qs = isNum(d.qUse) ? d.qUse : d.q;
                            if (qPred > 0) { r4 = qs / qPred; r4s = mAbs(r4 - 1) <= 0.15 ? 'pass' : 'fail'; d.R4 = { ratio: r4, pass: r4s === 'pass', status: r4s }; }
                        }
                    }
                }
                t.spec.rateQC.r4 = r4; t.spec.rateQC.r4Status = r4s;
                sp.rateQC.r4 = r4; sp.rateQC.r4Status = r4s;
                // evidence vector for the final labels
                if (ev) {
                    var rq = sp.rateQC;
                    ev.rateSource = rq.source; ev.r3 = rq.r3; ev.r3Status = rq.r3Status; ev.r4 = rq.r4; ev.r4Status = rq.r4Status; ev.dqKnown = rq.dqKnown;
                    ev.fRate = sp.fRate; ev.equalRateAssumed = rq.equalRateAssumed;
                    ev.kHeld = !!res.kHeld; ev.kHeldConverged = res.kHeld ? !!res.kHeld.converged : null;
                    ev.kHeldCorrCS = res.kHeld ? fin(res.kHeld.corrCS) : null; ev.kHeldRmsRatio = res.kHeld ? fin(res.kHeld.rmsRatio) : null;
                    ev.partialSuspect = t.partialSuspect; ev.windowLevelInconsistent = wli;
                    ev.boundaryDepends = res.background ? !!res.background.boundaryDepends : false;
                    if (res.kHeld) { ev.sErr = res.sErr.value; ev.sErrMode = 'kHeld'; }
                }
                t._wli = wli;
                if (a && typeof a.confidence === 'function' && ev) {
                    try { var c = a.confidence(ev, cal); if (c && c.ks) res.confidence = c; } catch (e4) { /* keep pass-1 labels */ }
                }
                if (res.confidence) res.confidence.stage = 'final';
            });
            X.order.push('confidence');
            // frozen used set
            tests.forEach(function (t) { t._used = !!(t.status === 'interpreted' && t.result && t.result.confidence && rank(t.result.confidence.ks) >= 1); });
            X.phase = 'stage4';
            return { done: false, progress: 0.93, label: 'Final labels' };
        }
        // Stage 4: trend over the frozen used set.
        function stage4() {
            X.order.push('trend');
            var withRes = tests.filter(function (t) { return t.result; });
            var first = tests.length ? tests[0].tc_ms : 0, shift = D.depthShift(input.depth);
            var tt = withRes.map(function (t) { return _trendTest(t, first, shift); });
            var used = {};
            tests.forEach(function (t) { if (t._used) used[t.id] = true; });
            var rh = scanRes.rates, T = TR(), trend = null;
            var ctx = { well: input.well, completion: input.completion || null, depth: input.depth || null, settings: st, days: rh.days || [], workovers: input.workovers || [],
                        fluid: input.well.fluid, firstTest_ms: first, mode: rh.mode, phaseBasis: rh.phaseBasis, start: rh.start, historyEstimated: !!(rh.start && rh.start.flag),
                        baseline: X.baseline, used: used, windowLevelInconsistent: tests.filter(function (t) { return t._wli; }).map(function (t) { return t.id; }) };
            if (T && typeof T.compute === 'function') {
                try { trend = T.compute(tt, ctx); } catch (e) { trend = null; X.warnings.push(W('TREND_FAILED', 'bad', 'The trend could not be computed: ' + String(e && e.message || e).slice(0, 200), ['T1'])); }
            }
            if (!trend) trend = _fallbackTrend(tt, st, used, X.baseline ? X.baseline.tests : [], rh.unit, T ? 'The trend could not be computed.' : 'The trend module is not loaded.');
            X.trend = trend;
            var byId = {};
            (trend.series || []).forEach(function (s) { byId[s.id] = s; });
            tests.forEach(function (t) {
                var s = byId[t.id];
                t.used = s && s.used ? { baseline: !!s.used.baseline, trend: !!s.used.trend, alert: !!s.used.alert } : { baseline: false, trend: false, alert: false };
            });
            X.phase = 'stage5';
            return { done: false, progress: 0.97, label: 'Trend and alerts' };
        }
        // Stage 5: trend model caps, assembly, hashes.
        function stage5() {
            X.order.push('caps');
            var cw = X.trend && X.trend.crossTest && X.trend.crossTest.closedWithoutDepletion || [];
            tests.forEach(function (t) {
                if (!t.result || !t.result.confidence || cw.indexOf(t.id) < 0) return;
                var c = t.result.confidence;
                c.model = minLevel(c.model, 'medium');
                c.headline = minLevel(c.ks, c.model);
            });
            var rh = scanRes.rates, shift = D.depthShift(input.depth), rec = scanRes.record || input.record;
            tests.forEach(function (t) {
                var f = t.result ? t.result.final : null;
                t.pStarDatum = f && isNum(f.pStar) ? f.pStar + shift : null;
                t.pExtDatum = f && isNum(f.pExt) ? f.pExt + shift : null;
            });
            var missed = scanRes.missed || D.missed(scanRes.events, [], rh, scanRes.qc, 0);
            var ps = tests.filter(function (t) { return t.result && isNum(t.result.final.pStar); }).map(function (t) { return t.result.final.pStar - t.pwf0; });
            if (ps.length && missed.detectability) {
                var md = median(ps);
                missed.detectability.pStarMinusPwf_psi = md;
                missed.detectability.ok = md >= 2 * num(missed.detectability.Ts_psi, 0);
            }
            var outTests = tests.map(function (t) {
                var o = {};
                ['id', 'eventId', 'date', 'tc_ms', 'dtEnd_h', 'Dq', 'qUnit', 'pwf0', 'pwf0Datum', 'pStarDatum', 'pExtDatum', 'status', 'statusReason', 'spec', 'result', 'used',
                 'partialSuspect', 'overrides', 'inputHash', 'pass1'].forEach(function (k) { if (t[k] !== undefined) o[k] = t[k]; });
                return o;
            });
            var recSum = rec ? { name: String(rec.name || ''), source: rec.source || 'csv', n: rec.n || rec.t.length, origin_ms: rec.origin_ms, end_ms: rec.t[rec.t.length - 1], hash: rec.hash, reduced: false, rawStored: 'none' }
                : (input.stored.record ? clone(input.stored.record) : { name: '', source: 'csv', n: 0, origin_ms: tests.length ? tests[0].tc_ms : 0, end_ms: tests.length ? tests[tests.length - 1].tc_ms : 0, hash: '0000000000000000', reduced: false, rawStored: 'none' });
            var a = AI(), s1 = a && typeof a.stats === 'function' ? a.stats() : null, s0 = statsStart || {};
            var stats = { evals: s1 ? mMax(0, num(s1.evals, 0) - num(s0.evals, 0)) : 0, fits: s1 ? mMax(0, num(s1.fits, 0) - num(s0.fits, 0)) : 0,
                          slices: s1 ? mMax(0, num(s1.slices, 0) - num(s0.slices, 0)) : 0, ms: null };
            var warns = X.warnings.concat((rh.warnings || []).filter(function (w2) { return w2.level !== 'info'; }).slice(0, 20));
            var meta = input.meta || {};
            an = {
                ok: true, version: VERSION, appVersion: String(meta.appVersion || (typeof G.WTS_appVersion === 'function' ? G.WTS_appVersion() : '') || ''),
                runAt: iso(Date.now()), inputHash: inputHash(input), resultHash: resultHash(outTests, X.trend),
                meta: { wellName: String(meta.wellName || ''), engineer: String(meta.engineer || ''), appVersion: String(meta.appVersion || '') },
                well: input.well, completion: input.completion || null, depth: input.depth || null, settings: st, zones: zones,
                record: recSum, qc: scanRes.qc, events: scanRes.events, missed: missed, rates: rh, baseline: X.baseline || null,
                tests: outTests, trend: X.trend, overrides: (input.overrides || []).slice(), stats: stats, warnings: warns
            };
            Object.defineProperty(an, '_order', { value: X.order.slice(), enumerable: false });
            return finish(an);
        }
        var PH = { start: start, scan: scan, tests: buildTests, specs: specUnit, finishTests: finishTests, stage1: stage1, stage2: stage2, stage3: stage3, stage3b: stage3b, stage4: stage4, stage5: stage5 };
        return {
            step: function () {
                if (X.phase === 'done' || X.cancelled) return { done: true, progress: 1, label: X.cancelled ? 'Cancelled' : 'Analysis complete' };
                return PH[X.phase]();
            },
            result: function () { return X.cancelled ? null : X.res; },
            cancel: function () { X.cancelled = true; if (X.sub && typeof X.sub.cancel === 'function') X.sub.cancel(); }
        };
    }

    function analyse(input, opts) { return runSync(job(input, opts)); }
    // opts {cache, shouldCancel, onProgress} → Promise<Analysis> through PRiSM_autoInterp.drive (the only yields).
    function analyseAsync(input, opts) {
        opts = opts || {};
        var a = AI();
        if (!a || typeof a.drive !== 'function') return Promise.reject(fail('NO_ENGINE', ['The interpretation engine is not loaded.'], []));
        var j = job(input, { cache: opts.cache || null });
        return a.drive(j, { shouldCancel: opts.shouldCancel, onProgress: opts.onProgress });
    }

    R.VERSION = VERSION;
    R.MAX_TESTS = MAX_TESTS;
    R.SETTINGS_DEFAULT = SETTINGS_DEFAULT;
    R.settingsOf = settingsOf;
    R.analyse = analyse;
    R.job = job;
    R.analyseAsync = analyseAsync;
    R.specFor = specFor;
    R.storedSpec = storedSpec;
    R.rehydrate = rehydrate;
    R.inputHash = inputHash;
    R.resultHash = resultHash;
    R.adjustEvents = adjustEvents;
    // Registry contract (smoke check): = analyse(input); {ok:false, code:'NO_DATA'} for {} and never throws.
    G.WTS_buildup_compute = function (input) {
        try { return analyse(input); }
        catch (e) { return fail('ERROR', ['The analysis failed: ' + String(e && e.message || e).slice(0, 200)], []); }
    };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var R = G.WTS_buildup && G.WTS_buildup.run;
    if (!R) return;
    var checks = [];
    function chk(name, ok) { checks.push([name, !!ok]); }
    var r = G.WTS_buildup_compute({});
    chk('NO_DATA for {}', r && r.ok === false && r.code === 'NO_DATA');
    chk('NO_DATA for null', G.WTS_buildup_compute(null).code === 'NO_DATA');
    var s = R.settingsOf({ detect: { winMin: 1e12, gapN: -1 }, interp: { rivals: 'x' } });
    chk('settings clamped', s.detect.winMin === 60 && s.detect.gapN === 2 && s.interp.rivals === 'auto');
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-buildup-run self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.WTS_buildup_run_selfTest = checks;
})();
