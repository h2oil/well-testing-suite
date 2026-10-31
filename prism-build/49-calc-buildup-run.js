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
    // hex16 over canon(…, 'inputs') of everything that changes numbers (§4.9): well, completion, depth, the clamped
    // settings that change numbers (detect, interp, trend; report.detail changes none), the resolved zones, history,
    // allocation rows with their volume resolution and gas unit (the resolution widens the R3 tolerance), rate table,
    // record hash, overrides (kind, target, value) and workovers.
    function _hashSettings(s) { var o = settingsOf(s); delete o.report; return o; }
    function _ovList(input) { return (input && Array.isArray(input.overrides) ? input.overrides : []).filter(function (o) { return o && typeof o === 'object'; }); }
    function inputHash(input) {
        input = input || {};
        var st = input.stored || null, al = input.allocation || null;
        var rec = input.record ? input.record.hash : (st && st.record && st.record.hash) || null;
        return hash16(canon({
            well: input.well || null, completion: input.completion || null, depth: input.depth || null, settings: _hashSettings(input.settings),
            zones: resolvedZones(input.zones), history: input.history || null,
            allocationRows: al && al.rows ? al.rows : null, allocationResolution: al && al.rows ? (al.resolution || null) : null,
            allocationGUnit: al && al.rows ? (al.gUnit || null) : null, rateTable: input.rateTable || null,
            recordHash: rec, workovers: (input.workovers || []).slice().sort(),
            overrides: _ovList(input).map(function (o) { return { id: o.id, kind: o.kind, target: o.target === undefined ? null : o.target, value: o.value === undefined ? null : o.value }; })
        }, 'inputs'));
    }
    // Field diff between two AnalysisInputs (canonical imperial values at 6 significant figures, resolved zones), for the
    // page's single 'input' audit entry at the next Analyse (§3.7, §6.4). Arrays and objects are compared whole.
    function inputDiff(prev, next) {
        function flat(input) {
            input = input || {};
            var o = { well: input.well || null, completion: input.completion || null, depth: input.depth || null, settings: settingsOf(input.settings),
                      zones: resolvedZones(input.zones), history: input.history || null, workovers: (input.workovers || []).slice().sort(),
                      allocation: input.allocation && input.allocation.rows ? hash16(canon({ rows: input.allocation.rows, resolution: input.allocation.resolution || null, gUnit: input.allocation.gUnit || null }, 'inputs')) : null,
                      rateTable: input.rateTable ? hash16(canon(input.rateTable, 'inputs')) : null,
                      record: input.record ? input.record.hash : (input.stored && input.stored.record ? input.stored.record.hash : null) };
            var out = {};
            (function walk(x, p) {
                if (x && typeof x === 'object' && !Array.isArray(x)) { Object.keys(x).forEach(function (k) { walk(x[k], p ? p + '.' + k : k); }); return; }
                out[p] = canon(x === undefined ? null : x, 'inputs');
            })(o, '');
            return out;
        }
        var a = flat(prev), b = flat(next), keys = {}, diff = [];
        Object.keys(a).concat(Object.keys(b)).forEach(function (k) { keys[k] = 1; });
        Object.keys(keys).sort().forEach(function (k) {
            if (a[k] !== b[k]) diff.push({ field: k, from: a[k] === undefined ? null : JSON.parse(a[k]), to: b[k] === undefined ? null : JSON.parse(b[k]) });
        });
        return diff;
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

    // Stored pressures at 6 significant figures (§3.1; the frozen BuildupSpecStored fixture checks it). Note for the lead:
    // at ≥ 10,000 psia that is 0.1 psi, coarse for a 1-psi derivative; storing Δp from pwf0 would keep gauge resolution.
    // Record and stored modes use the same rounding.
    function rp(x) { return sf6(x); }
    // BuildupSpec.opts from the clamped settings. band, slope and minCycles (the IARF tolerances, fractions and cycles)
    // are extra keys the engine reads (spec.opts.band / slope / minCycles).
    function _specOpts(st) {
        return { Lcyc: st.interp.Lcyc, binsPerCycle: 20, fitBinsPerCycle: 12, rivals: st.interp.rivals, cheld: st.interp.cheld, tide: st.interp.tide,
                 band: st.interp.band, slope: st.interp.slope, minCycles: st.interp.minCycles };
    }
    // Event + record + RateHistory + AnalysisInput → BuildupSpec (in-memory form, dt at 6 significant figures and p as rp(),
    // so the engine sees exactly what the stored form reproduces). o {id, origin_ms, settings, qc, test} → spec or a
    // failure. Without o.qc (the §3.7 four-argument form) the noise comes from input.stored.qc, else from data.qc(record).
    function specFor(event, record, rh, input, o) {
        o = o || {};
        input = input || {};
        var D = DA(), w = input.well || {}, st = o.settings || settingsOf(input.settings), q = o.qc;
        if (!event || !record || !record.t || !record.p || !rh) return fail('NO_DATA', ['Event, record and rates are needed.'], ['event']);
        if (!q && input.stored && input.stored.qc && input.stored.qc.ok !== undefined) q = input.stored.qc;
        if (!q && D && typeof D.qc === 'function') { try { q = D.qc(record, { events: [event] }); } catch (e) { q = null; } }
        if (!q || typeof q !== 'object') return fail('NO_QC', ['The data quality (gauge noise) is not available.'], ['qc']);
        var t = record.t, p = record.p, n = mMin(t.length, p.length), sign = event.kind === 'falloff' ? -1 : 1;
        var origin = isNum(o.origin_ms) ? o.origin_ms : record.origin_ms;
        var i0 = D.util.lowerBound(t, event.tc_ms + 1), i1 = D.util.lowerBound(t, event.tEnd_ms + 1);
        var dt = [], pp = [], gaps = [], tPrev = null;
        for (var i = i0; i < i1 && i < n; i++) {
            if (!isNum(t[i]) || !isNum(p[i]) || !(t[i] > event.tc_ms)) continue;      // non-finite samples are skipped
            dt.push((t[i] - event.tc_ms) / HOUR); pp.push(p[i]);
            if (tPrev !== null) gaps.push((t[i] - tPrev) / HOUR);
            tPrev = t[i];
        }
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
            dt: bins.dt.map(sf6), p: bins.p.map(rp), n: bins.n,
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
            opts: _specOpts(st)
        };
        if (!(spec.dtSample_h > 0)) spec.dtSample_h = 1 / 60;
        return spec;
    }
    function storedSpec(spec, rh, tc_ms) {
        var s = {};
        Object.keys(spec).forEach(function (k) { if (k !== 'steps') s[k] = clone(spec[k]); });
        s.dt = spec.dt.map(sf6); s.p = spec.p.map(rp); s.n = spec.n ? spec.n.slice() : null;
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
    // Per-test cache key: the spec, the interpretation settings, the calibration version, the engine version and the app
    // version (results of two engine or app versions are never mixed, §4.9).
    function cacheKey(spec, st, calVersion, engine, app) {
        var s = {};
        Object.keys(spec).forEach(function (k) { if (k !== 'stepRef') s[k] = spec[k]; });
        return hash16(canon({ spec: s, interp: st.interp, cal: calVersion || null, engine: engine || null, app: app || null }, 'inputs'));
    }
    function _appVersion(input) {
        var meta = (input && input.meta) || {};
        return String(meta.appVersion || (typeof G.WTS_appVersion === 'function' ? G.WTS_appVersion() : '') || '');
    }

    // ─────────────────────────────────────────────────────────────────────
    // Test list, overrides and the 60-test cap
    // ─────────────────────────────────────────────────────────────────────
    function isShut(e) { return e && (e.kind === 'shutin' || e.kind === 'falloff') && !e.dropped; }
    function _segment(date, workovers) { var s = 0; (workovers || []).forEach(function (w) { if (typeof w === 'string' && w <= date) s++; }); return s; }

    // Applies event_drop, tc and event_add overrides to the detected events (called by data.scanJob after detection, with
    // the detection's missed list). A refused override gets a warning in ovWarn[ov.id] (copied to Analysis.overrides[] and
    // Analysis.warnings): a time outside the record, an event_add within ±max(10 min, 5·Δt_med) of an existing closing or
    // inside an existing shut-in, or no room before the next event. Events changed or created by an override list the
    // override id in overrideIds (extra key; the stored mode uses it to tell applied overrides from unapplied ones).
    function _ovWarn(ovWarn, ov, text) {
        if (!ovWarn || !ov || !ov.id) return;
        (ovWarn[ov.id] = ovWarn[ov.id] || []).push(W('OVERRIDE_NOT_APPLIED', 'warn', 'Override ' + ov.id + ' (' + String(ov.kind).replace(/_/g, ' ') + ') was not applied: ' + text, ['D1']));
    }
    function _ovValueTime(v, key) {
        if (isNum(+v) && v !== null && v !== '' && typeof v !== 'object') return +v;
        if (v && typeof v === 'object') {
            if (key && isNum(+v[key]) && v[key] !== null) return +v[key];
            if (isNum(+v.t_ms) && v.t_ms !== null) return +v.t_ms;
            if (isNum(+v.tc_ms) && v.tc_ms !== null) return +v.tc_ms;
        }
        return NaN;
    }
    function adjustEvents(events, record, q, input, zones, missed, ovWarn) {
        var D = DA(), ovs = _ovList(input), maxId = 0;
        events.forEach(function (e) { var k = parseInt(String(e.id).slice(1), 10); if (k > maxId) maxId = k; });
        var opts = { settings: settingsOf(input.settings).detect, fluid: input.well && input.well.fluid, day: zones.day,
                     subThreshold: missed && Array.isArray(missed.subThreshold) ? missed.subThreshold : [] };
        var t = record.t, t0 = t[0], tN = t[t.length - 1];
        var dtMed = (q && isNum(q.dtMed_s) && q.dtMed_s > 0 ? q.dtMed_s : 60) * 1000, tolDup = mMax(10 * 60000, 5 * dtMed);
        function live() { return events.filter(function (x) { return x && !x.dropped; }).sort(function (a, b) { return a.tc_ms - b.tc_ms; }); }
        function startOf(x) { return isNum(x.j0) && x.j0 >= 0 && x.j0 < t.length ? t[x.j0] : x.tc_ms; }
        function mark(e, ov) { e.overrideIds = (e.overrideIds || []).concat([ov.id]); }
        ovs.forEach(function (ov) {
            if (ov.kind === 'event_drop') {
                var e = events.filter(function (x) { return x.id === ov.target; })[0];
                if (e) { e.dropped = true; e.status = 'excluded'; mark(e, ov); e.warnings.push(W('EVENT_DROPPED', 'info', 'Removed by override ' + ov.id + '.', ['D1'])); }
                else _ovWarn(ovWarn, ov, 'no event ' + String(ov.target || '') + ' was detected.');
            } else if (ov.kind === 'tc') {
                var tc = _ovValueTime(ov.value, 'tc_ms');
                var idx = -1;
                events.forEach(function (x, i) { if (x.id === ov.target) idx = i; });
                if (!/^E\d+$/.test(String(ov.target)) || idx < 0) { _ovWarn(ovWarn, ov, 'no event ' + String(ov.target || '') + ' was detected.'); return; }
                if (!isNum(tc) || tc < t0 || tc > tN) { _ovWarn(ovWarn, ov, 'the closing time is outside the gauge record.'); return; }
                var L = live(), prevE = null, nextE = null;
                L.forEach(function (x) { if (x.id === ov.target) return; if (x.tc_ms < tc && (!prevE || x.tc_ms > prevE.tc_ms)) prevE = x; if (x.tc_ms > tc && (!nextE || x.tc_ms < nextE.tc_ms)) nextE = x; });
                if (prevE && tc <= prevE.tEnd_ms) { _ovWarn(ovWarn, ov, 'the closing time falls inside the shut-in of ' + prevE.id + '.'); return; }
                var ne = D.eventAt(record, q, tc, Object.assign({ exact: true, prevEnd_ms: prevE ? prevE.tEnd_ms : null, nextStart_ms: nextE ? startOf(nextE) : null }, opts));
                if (!ne) { _ovWarn(ovWarn, ov, 'no room before the next shut-in.'); return; }
                ne.id = ov.target; ne.manual = true; ne.overrideIds = (events[idx].overrideIds || []).concat([ov.id]);
                ne.warnings.push(W('TC_OVERRIDE', 'info', 'Closing time set by override ' + ov.id + '.', ['D2']));
                events[idx] = ne;
            } else if (ov.kind === 'event_add') {
                var tAdd = _ovValueTime(ov.value, 't_ms'), v = ov.value;
                if (!isNum(tAdd)) { _ovWarn(ovWarn, ov, 'no closing time was given.'); return; }
                if (tAdd < t0 || tAdd > tN) { _ovWarn(ovWarn, ov, 'the closing time is outside the gauge record.'); return; }
                var L2 = live(), prev = null, next = null, clash = null;
                L2.forEach(function (x) {
                    if (mAbs(x.tc_ms - tAdd) <= tolDup || (tAdd >= x.tc_ms && isNum(x.tEnd_ms) && tAdd <= x.tEnd_ms)) { if (!clash) clash = x; return; }
                    if (x.tc_ms < tAdd && (!prev || x.tc_ms > prev.tc_ms)) prev = x;
                    if (x.tc_ms > tAdd && (!next || x.tc_ms < next.tc_ms)) next = x;
                });
                if (clash) { _ovWarn(ovWarn, ov, mAbs(clash.tc_ms - tAdd) <= tolDup ? 'event ' + clash.id + ' already closes at that time (use a closing-time override).' : 'the time falls inside the shut-in of ' + clash.id + '.'); return; }
                var why = {};
                var ae = D.eventAt(record, q, tAdd, Object.assign({ exact: !!(v && typeof v === 'object' && v.exact), prevEnd_ms: prev ? prev.tEnd_ms : null, nextStart_ms: next ? startOf(next) : null, out: why }, opts));
                if (!ae) { _ovWarn(ovWarn, ov, why.reason === 'noRise' ? 'no pressure rise was found near that time (an exact closing time forces the event).' : 'no room before the next shut-in.'); return; }
                maxId++; ae.id = 'E' + maxId; mark(ae, ov);
                ae.warnings.push(W('EVENT_ADDED', 'info', 'Added by override ' + ov.id + '.', ['D1']));
                events.push(ae);
            }
        });
        events.sort(function (a, b) { return a.tc_ms - b.tc_ms; });
        return events;
    }
    // Stored mode (no raw record): event-level overrides cannot be applied. Those the stored events already reflect
    // (overrideIds) are fine; the others get a warning.
    function _storedOverrideWarnings(input, events, ovWarn) {
        var applied = {};
        (events || []).forEach(function (e) { (e && e.overrideIds || []).forEach(function (id) { applied[id] = 1; }); });
        _ovList(input).forEach(function (ov) {
            if ((ov.kind === 'event_add' || ov.kind === 'event_drop' || ov.kind === 'tc') && !applied[ov.id]) _ovWarn(ovWarn, ov, 'it needs the raw gauge record, which is not loaded.');
        });
    }
    function _overrideState(input, ids) {
        var st = {};
        _ovList(input).forEach(function (ov) {
            if (!ov || !ov.target) return;
            if (ov.kind === 'exclude') st[ov.target] = { s: 'exclude', ov: ov };
            else if (ov.kind === 'include') st[ov.target] = { s: 'include', ov: ov };
        });
        return st;
    }
    // More than 60 tests: keep by selection (the baseline candidates of each segment, the longest per week newest first,
    // the longest per day newest first, then the newest); the others are excluded with the reason 'test cap'. The cap
    // runs before stage 1, when the labels are not known yet, so the first 2·baseN live tests of each segment are kept:
    // the stage-2 baseline (the first baseN tests labelled ≥ medium) then still has candidates when some early tests
    // turn out low. (Approximation: when more than baseN of them are low, the baseline has fewer tests.)
    function _cap(tests, st, workovers) {
        var live = tests.filter(function (t) { return t.status !== 'excluded'; });
        if (live.length <= MAX_TESTS) return;
        var keep = {}, nKeep = 0;
        function add(t) { if (!keep[t.id] && nKeep < MAX_TESTS) { keep[t.id] = 1; nKeep++; } }
        var segs = {};
        live.forEach(function (t) { var s = _segment(t.date, workovers); (segs[s] = segs[s] || []).push(t); });
        Object.keys(segs).forEach(function (s) { segs[s].slice(0, 2 * st.trend.baseN).forEach(add); });
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
        var dtEnd = spec.dt[spec.dt.length - 1], fn = _lnDteFn(spec), v = fn ? Math.exp(fn(dtEnd)) : NaN;
        return isNum(v) ? v : dtEnd;
    }
    function _kHeldEligible(res, spec) {
        var ia = res.iarf || {}, tr = res.triggers || {}, reach = res.reach || {};
        if (ia.grade === 'none' && tr.noneSkipped) return true;
        if (ia.grade === 'fair' && isNum(ia.cycles) && ia.cycles < 0.6 && isNum(reach.fair_h) && _dteEnd(res, spec) < reach.fair_h) return true;
        return false;
    }
    // Final values and S_err of a k-held test (§4.6 items 13, 15, 18). The pass-1 values are scaled, never recomputed from
    // the fluid inputs: at a fixed rate and fluid m ∝ 1/k and r_inv ∝ √k, which holds for every fluid (for gas the engine
    // works in normalised pseudo-pressure with Bg and μg, which spec.well does not carry). prep (optional, the stage-3
    // prepare) gives the gas table for Δp_skin in psi; without it the pass-1 gas Δp_skin is scaled with Δm_skin.
    function _applyKHeld(res, kh, spec, prep) {
        var w = spec.well, k = kh.k, f = res.final;
        var S = kh.fit && kh.fit.phys && isNum(kh.fit.phys.S) ? kh.fit.phys.S : f.S, C = kh.fit && kh.fit.phys && isNum(kh.fit.phys.C) ? kh.fit.phys.C : f.C;
        var pw = prep && prep.well ? prep.well : w;
        var kOld = isNum(f.k) && f.k > 0 ? f.k : k, ratio = kOld / k;
        var m = isNum(f.m) && f.m !== 0 ? f.m * ratio : 162.6 * spec.Dq * pw.B * pw.mu / (k * w.h);
        var mPrime = isNum(f.mPrime) && f.mPrime !== 0 ? f.mPrime * ratio : m / LN10;
        var dtEnd = spec.dt[spec.dt.length - 1], dteEnd = _dteEnd(res, spec), sq = mSqrt(k / kOld);
        var dmSkin = 0.8686 * m * S, oldGas = f.gas;
        f.k = k; f.kh = k * w.h; f.S = S; f.C = C; f.source = 'kHeld'; f.m = m; f.mPrime = mPrime;
        f.rinv_ft = isNum(f.rinv_ft) ? f.rinv_ft * sq : 0.0325 * mSqrt(k * dtEnd / (pw.phi * pw.mu * pw.ct));
        f.rinvE_ft = isNum(f.rinvE_ft) ? f.rinvE_ft * sq : 0.0325 * mSqrt(k * dteEnd / (pw.phi * pw.mu * pw.ct));
        if (oldGas || (w.fluid === 'gas' && spec.gas)) {
            var dps = null, gt = prep && prep.gasTable, ad = prep && prep.adata;
            if (gt && typeof gt.pOfPn === 'function' && ad && isNum(ad.pRef)) {
                try { var pAt = gt.pOfPn(ad.pRef + num(prep.sign, 1) * dmSkin); if (isNum(pAt)) dps = mAbs(pAt - spec.pwf0); } catch (e) { dps = null; }
            }
            if (!isNum(dps)) dps = (oldGas && isNum(oldGas.dpSkin_psi) && isNum(oldGas.dmSkin) && mAbs(oldGas.dmSkin) > 1e-12) ? mAbs(oldGas.dpSkin_psi * dmSkin / oldGas.dmSkin) : mAbs(dmSkin);
            f.gas = { Sprime: S, dmSkin: dmSkin, dpSkin_psi: dps };
            f.dpSkin_psi = dps;
        } else f.dpSkin_psi = dmSkin;
        var sTc = 1.1513 * mAbs(num(spec.dpdt_flow, 0)) * num(spec.dtc_h, 0) / mAbs(m), sPwf = 1.1513 * num(spec.pwf0SE, 0) / mAbs(m);
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
    // ln Δt_e as the engine builds it (§3.1 prepare, D6): ln Δt + Σ w_i [ln(off_i + Δt) − ln off_i], w_i = Δq_i/Δq_n,
    // off_i = t_c − t_i, over the rate steps scaled so that the final drop equals Δq. null when the history is unusable.
    function _lnDteFn(spec) {
        var st = Array.isArray(spec && spec.steps) ? spec.steps.filter(function (s) { return s && isNum(s.t) && isNum(s.q); }).map(function (s) { return { t: s.t, q: mAbs(s.q) }; }) : [];
        var tc = spec ? spec.tc_h : null, n = st.length;
        if (!isNum(tc) || n < 2 || !(spec.Dq > 0)) return null;
        var qPrev = st[n - 2].q;
        if (!(qPrev > 0)) return null;
        var scale = spec.Dq / qPrev, stU = st.map(function (s) { return { t: s.t, q: s.q * scale }; });
        var dqn = stU[n - 1].q - stU[n - 2].q, terms = [];
        if (dqn === 0) return null;
        for (var i = 0; i < n - 1; i++) {
            var dq = stU[i].q - (i > 0 ? stU[i - 1].q : 0);
            if (dq === 0) continue;
            var off = tc - stU[i].t;
            if (!(off > 0)) return null;
            terms.push({ w: dq / dqn, off: off });
        }
        return function (dt) { var v = mLog(dt); for (var j = 0; j < terms.length; j++) v += terms[j].w * (mLog(terms[j].off + dt) - mLog(terms[j].off)); return v; };
    }
    // The stored copy of a BuildupResult drops bins.X and bins.dte (§3.1); they are recomputed from bins.dt and the
    // rehydrated spec's rate steps with the superposition time function, so cached and fresh tests share one time axis.
    function _ensureDte(r, spec) {
        if (!r || !r.bins || !Array.isArray(r.bins.dt)) return;
        var b = r.bins, n = b.dt.length;
        if (Array.isArray(b.dte) && b.dte.length === n && Array.isArray(b.X) && b.X.length === n) return;
        var fn = _lnDteFn(spec);
        if (!fn) return;
        var X = b.dt.map(function (d) { return d > 0 ? fn(d) : NaN; });
        if (!X.every(isNum)) return;
        b.X = X; b.dte = X.map(function (x) { return Math.exp(x); });
    }
    function _trendTest(t, first_ms, shift) {
        var r = t.result, f = r.final, sp = t._spec || t.spec;
        _ensureDte(r, sp);
        var dte = r.bins && Array.isArray(r.bins.dte) && r.bins.dte.length === (r.bins.dp || []).length ? r.bins.dte : null, dp = dte ? r.bins.dp : null;
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
            bins: { dte: dte ? dte.slice() : [], dp: dp ? dp.slice() : [] }       // Δt_e only, never Δt
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

    // Stable test ids (B<n>). A previous analysis (the cache, or the stored tests) keeps its id for the same closing:
    // matched by the event id with the closing within tol, then by the closing time within tol, then by the event id
    // within 6 h (a closing-time override). A previous id is never given to another event, so an override that targets
    // it can never move to a different build-up. A new test takes B<event number> when that id is free (so a fresh
    // analysis gives the same ids whether or not an earlier event is included), else the next free number.
    function _bNum(id) { var m = /^B(\d+)$/.exec(String(id || '')); return m ? parseInt(m[1], 10) : 0; }
    function _assignIds(cand, prev, tol) {
        var out = {}, taken = {}, used = [], maxN = 0, rest = [];
        prev = (prev || []).filter(function (p) { return p && _bNum(p.id) > 0; });
        prev.forEach(function (p) { taken[p.id] = 1; });
        function dtc(e, p) { return isNum(p.tc_ms) && isNum(e.tc_ms) ? mAbs(p.tc_ms - e.tc_ms) : Infinity; }
        function pass(match) {
            cand.forEach(function (e) {
                if (out[e.id]) return;
                var best = -1, bd = Infinity;
                prev.forEach(function (p, i) { if (used[i]) return; var d = match(e, p); if (d !== null && d < bd) { bd = d; best = i; } });
                if (best >= 0) { out[e.id] = prev[best].id; used[best] = true; }
            });
        }
        pass(function (e, p) { var d = dtc(e, p); return p.eventId === e.id && d <= tol ? d : null; });
        pass(function (e, p) { var d = dtc(e, p); return d <= tol ? d : null; });
        pass(function (e, p) { var d = dtc(e, p); return p.eventId === e.id && d <= 6 * HOUR ? d : null; });
        cand.forEach(function (e) {
            if (out[e.id]) return;
            var en = /^E(\d+)$/.exec(String(e.id)), id = en ? 'B' + parseInt(en[1], 10) : null;
            if (id && !taken[id] && _bNum(id) > 0) { out[e.id] = id; taken[id] = 1; } else rest.push(e);
        });
        Object.keys(taken).forEach(function (k) { maxN = mMax(maxN, _bNum(k)); });
        cand.forEach(function (e) { if (out[e.id]) maxN = mMax(maxN, _bNum(out[e.id])); });
        rest.forEach(function (e) { maxN++; out[e.id] = 'B' + maxN; });
        return out;
    }
    // A record with non-finite samples (a store decode, an external generator): those samples are skipped (copy).
    function _cleanRecord(rec) {
        var t = rec.t, p = rec.p;
        if (!t || !p || typeof t.length !== 'number' || typeof p.length !== 'number') return null;
        var n = mMin(t.length, p.length), bad = 0, i;
        for (i = 0; i < n; i++) if (!isNum(t[i]) || !isNum(p[i])) bad++;
        if (!bad && t.length === p.length) return rec;
        var m = n - bad, tt = new Float64Array(m), pp = new Float64Array(m), TT = rec.T && rec.T.length >= n ? new Float64Array(m) : null, k = 0;
        for (i = 0; i < n; i++) if (isNum(t[i]) && isNum(p[i])) { tt[k] = t[i]; pp[k] = p[i]; if (TT) TT[k] = rec.T[i]; k++; }
        var out = Object.assign({}, rec, { t: tt, p: pp, T: TT, n: m, origin_ms: m ? tt[0] : rec.origin_ms });
        out.warnings = (rec.warnings || []).concat([W('SAMPLES_SKIPPED', 'warn', (bad + mAbs(t.length - p.length)) + ' samples without a finite time or pressure were skipped.', ['Q2'])]);
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // The pipeline job
    // ─────────────────────────────────────────────────────────────────────
    // input: AnalysisInput; opts {cache: Analysis|null}
    function job(input, opts) {
        opts = opts || {};
        var X = { phase: 'start', res: null, cancelled: false, sub: null, i: 0, warnings: [], order: [], ovWarn: {}, rec: null };
        var D, st, zones, an, tests, scanRes, cal, calVersion, engineVersion, appVersion, statsStart, kBase = null, cvK = 0, seMedK = 0, candK = [];

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
            engineVersion = a && a.version ? String(a.version) : null;
            appVersion = _appVersion(input);
            statsStart = a && typeof a.stats === 'function' ? clone(a.stats()) : null;
            if (input.record) {
                var rec = _cleanRecord(input.record);
                if (!rec || !(rec.t.length >= 10)) return finish(fail('NO_DATA', ['The gauge record has fewer than 10 samples with a finite time and pressure.'], ['record']));
                if (rec !== input.record) X.warnings.push(rec.warnings[rec.warnings.length - 1]);
                X.rec = rec;
                X.sub = D.scanJob(rec, {
                    settings: st, zones: zones, allocation: input.rateTable && input.rateTable.length ? null : input.allocation, rateTable: input.rateTable,
                    history: input.history, well: input.well, depth: input.depth, workovers: input.workovers,
                    adjust: function (evs, r2, q, missed) { return adjustEvents(evs, r2, q, input, zones, missed, X.ovWarn); }
                });
                X.phase = 'scan';
                return { done: false, progress: 0.01, label: 'Reading the gauge data' };
            }
            var s = input.stored;
            if (!s || !Array.isArray(s.events) || !s.rates || !Array.isArray(s.rates.steps) || !s.rates.steps.length || !s.qc || s.qc.ok === undefined || !Array.isArray(s.tests))
                return finish(fail('NO_DATA', ['The stored analysis is incomplete.'], ['stored']));
            scanRes = { ok: true, qc: clone(s.qc), events: clone(s.events), rates: clone(s.rates), record: null, missed: clone(s.missed) || null };
            _storedOverrideWarnings(input, scanRes.events, X.ovWarn);
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
            var rh = scanRes.rates, events = scanRes.events, rec = scanRes.record || X.rec;
            var ovs = _overrideState(input);
            var shift = D.depthShift(input.depth);
            tests = [];
            var storedById = {}, evById = {};
            events.forEach(function (e) { if (e) evById[e.id] = e; });
            if (!rec) (input.stored.tests || []).forEach(function (x) { if (x && x.spec) storedById[x.eventId] = x; });
            var origin = rec ? rec.origin_ms : null;
            var cand = events.filter(function (e) {
                if (!isShut(e)) return false;
                if (!rec && !storedById[e.id]) return false;
                if (e.status === 'analysable') return true;
                return !!(ovs[e.id] && ovs[e.id].s === 'include');
            });
            // stable test ids: the stored tests (stored mode) or the cache's tests keep their ids
            var prev = [];
            if (!rec) prev = (input.stored.tests || []).filter(Boolean).map(function (x) { return { id: x.id, eventId: x.eventId, tc_ms: evById[x.eventId] ? evById[x.eventId].tc_ms : null }; });
            else if (opts.cache && Array.isArray(opts.cache.tests)) prev = opts.cache.tests.filter(Boolean).map(function (c) { return { id: c.id, eventId: c.eventId, tc_ms: c.tc_ms }; });
            var dtMed = scanRes.qc && isNum(scanRes.qc.dtMed_s) && scanRes.qc.dtMed_s > 0 ? scanRes.qc.dtMed_s * 1000 : 60000;
            X.idOf = _assignIds(cand, prev, mMax(10 * 60000, 5 * dtMed));
            X.cand = cand; X.ci = 0; X.bt = { rh: rh, rec: rec, ovs: ovs, shift: shift, storedById: storedById, origin: origin };
            X.phase = 'specs';
            return { done: false, progress: 0.26, label: cand.length + ' shut-ins to interpret' };
        }
        // One spec per unit (binning, stored form, cache key).
        function specUnit() {
            if (X.ci >= X.cand.length) { X.phase = 'finishTests'; return { done: false, progress: 0.29, label: 'Specs' }; }
            var e = X.cand[X.ci++], rh = X.bt.rh, rec = X.bt.rec, ovs = X.bt.ovs, shift = X.bt.shift, storedById = X.bt.storedById, origin = X.bt.origin;
            (function () {
                var id = X.idOf[e.id], t = {
                    id: id, eventId: e.id, date: e.alloc && e.alloc.date ? e.alloc.date : D.dayOf(e.tc_ms, zones.day), tc_ms: e.tc_ms, dtEnd_h: mMax(e.dtEnd_h, 1e-6),
                    Dq: null, qUnit: rh.unit, pwf0: e.pwf0, pwf0Datum: e.pwf0 + shift, pStarDatum: null, pExtDatum: null,
                    status: 'interpreted', statusReason: e.status !== 'analysable' ? 'Included by override (event status ' + e.status.replace(/_/g, ' ') + ').' : null,
                    spec: null, result: null, used: { baseline: false, trend: false, alert: false }, partialSuspect: false, overrides: []
                };
                _ovList(input).forEach(function (ov) { if (ov.target === id || ov.target === e.id) t.overrides.push(ov.id); });
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
                    if (sto.rateQC) { sto.rateQC.r4 = null; sto.rateQC.r4Status = rh.mode === 'table' ? 'n/a' : 'unavailable'; }
                    sto.overrides = _ovFor(input, t);
                    sto.opts = _specOpts(st);              // the current interpretation settings, as record mode builds them
                    var org = e.tc_ms - sto.tc_h * HOUR;
                    spec = rehydrate(sto, rh, org);
                }
                t.Dq = spec.Dq; t.spec = sto; t._spec = spec; t._event = e;
                t._key = cacheKey(sto.stepRef ? Object.assign({}, sto, { steps: spec.steps }) : sto, st, calVersion, engineVersion, appVersion);
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
                    // a stored copy has no bins.X / bins.dte (§3.1): recomputed in stage 1, one test per unit
                    var b = r.bins || {}, nb = Array.isArray(b.dt) ? b.dt.length : 0;
                    t._needDte = !(Array.isArray(b.dte) && b.dte.length === nb && Array.isArray(b.X) && b.X.length === nb);
                }
            });
            X.phase = 'stage1'; X.i = 0;
            return { done: false, progress: 0.3, label: tests.length + ' build-ups' };
        }
        function stage1() {
            while (X.i < tests.length && (tests[X.i]._capped || (tests[X.i]._cached && !tests[X.i]._needDte))) X.i++;
            if (X.i >= tests.length) { X.phase = 'stage2'; return { done: false, progress: 0.85, label: 'Interpretation done' }; }
            var t = tests[X.i], a = AI(), lab = 'Interpreting ' + t.id + ' (' + (X.i + 1) + '/' + tests.length + ')';
            if (t._cached) {
                _ensureDte(t.result, t._spec); t._needDte = false; X.i++;
                return { done: false, progress: prog(0.3, 0.85, X.i / tests.length), label: 'Stored result ' + t.id };
            }
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
                // one unit: the prepare (≤ 40 ms) and the job construction
                var prep = null;
                try { prep = a.prepare(t._spec); } catch (e) { prep = null; }
                X.order.push('kHeld:' + t.id);
                if (!prep || prep.ok === false) { t._kHeldFailed = true; X.i++; return { done: false, progress: 0.88, label: 'k-held ' + t.id }; }
                var delta = mSqrt(cvK * cvK + Math.pow(num(input.well.allocAccPct, 5) / 100, 2) + seMedK * seMedK);
                try { X.sub = a.kHeldJob(prep, { k: kBase, delta: delta }); t._prep = prep; } catch (e3) { X.sub = null; t._kHeldFailed = true; X.i++; }
                return { done: false, progress: 0.88, label: 'k-held ' + t.id };
            }
            var r;
            try { r = X.sub.step(); } catch (e2) { r = { done: true, error: e2 }; }
            if (!r.done) return { done: false, progress: 0.88, label: 'k-held ' + t.id };
            var kh = r.error ? null : X.sub.result();
            X.sub = null;
            if (kh && kh.ok !== false && isNum(kh.k) && kh.k > 0) _applyKHeld(t.result, kh, t._spec, t._prep);
            else t._kHeldFailed = true;
            t._prep = null;
            X.i++;
            return { done: false, progress: 0.89, label: 'k-held ' + t.id };
        }
        function _kHeldReady(t) { return t && t.status === 'interpreted' && t.result && !t.result.kHeld && !t._kHeldFailed && _kHeldEligible(t.result, t._spec); }
        // Stage 3b (one unit): the pass-2 context — background slope, p_ext list for R4, k stability.
        function stage3b() {
            var rh = scanRes.rates, well = input.well, acc = num(well.allocAccPct, 5) / 100;
            var interp = tests.filter(function (t) { return t.result && t.status !== 'failed'; });
            var estimated = !!(rh.start && rh.start.flag);
            // background slope: Theil–Sen of the pass-1 p_ext (psi/h), or the drift input with < 3 tests or an estimated history
            var px = [], py = [];
            interp.forEach(function (t) { var pe = t.pass1 && t.pass1.final ? t.pass1.final.pExt : null; if (isNum(pe) && t.status === 'interpreted') { px.push(t.tc_ms / HOUR); py.push(pe); } });
            var useTs = px.length >= 3 && !estimated, bg = useTs ? theilSenSlope(px, py) : null;
            if (!isNum(bg)) { bg = -num(well.driftPsiPerDay, 0.01) / 24; useTs = false; }
            var dayBy = {};
            (rh.days || []).forEach(function (d, i) { dayBy[d.date] = i; });
            var pk = interp.filter(function (t) { return t.status === 'interpreted' && t.pass1 && isNum(t.pass1.final.pExt); })
                .map(function (t) { return [t.tc_ms, t.pass1.final.pExt]; }).sort(function (x, y) { return x[0] - y[0]; });
            X.p2 = { interp: interp, estimated: estimated, useTs: useTs, bg: bg, kStable: cvK <= mMax(0.05, acc), acc: acc, dayBy: dayBy, pk: pk };
            X.i = 0;
            X.phase = 'stage3c';
            return { done: false, progress: 0.9, label: 'Pass 2' };
        }
        // Stage 3c: one test per unit — background check (the engine's prepare + triggers), partial-cut suspicion,
        // window-level check, R4 and the final confidence (§4.8: at most one engine call per unit).
        function stage3c() {
            var P2 = X.p2;
            if (X.i >= P2.interp.length) { X.phase = 'stage3d'; return { done: false, progress: 0.93, label: 'Final labels' }; }
            var t = P2.interp[X.i++];
            pass2Test(t, P2);
            return { done: false, progress: prog(0.9, 0.93, X.i / mMax(1, P2.interp.length)), label: 'Pass 2 ' + t.id };
        }
        // Stage 3d (closing unit): the used set is frozen.
        function stage3d() {
            X.order.push('confidence');
            tests.forEach(function (t) { t._used = !!(t.status === 'interpreted' && t.result && t.result.confidence && rank(t.result.confidence.ks) >= 1); });
            X.p2 = null;
            X.phase = 'stage4';
            return { done: false, progress: 0.93, label: 'Final labels' };
        }
        function pass2Test(t, P2) {
            var a = AI(), rh = scanRes.rates, well = input.well, acc = P2.acc, estimated = P2.estimated, useTs = P2.useTs, bg = P2.bg, kStable = P2.kStable;
            var dayBy = P2.dayBy, pk = P2.pk;
            function pRefAt(ms) {
                if (!pk.length) return null;
                if (ms <= pk[0][0]) return pk[0][1];
                for (var i = 1; i < pk.length; i++) if (ms <= pk[i][0]) return pk[i - 1][1] + (pk[i][1] - pk[i - 1][1]) * (ms - pk[i - 1][0]) / (pk[i][0] - pk[i - 1][0]);
                return pk[pk.length - 1][1];
            }
            (function () {
                var res = t.result, ev = res.evidence ? res.evidence : null, sp = t._spec, w = sp.well;
                // background check
                if (a && typeof a.backgroundCheck === 'function') {
                    try {
                        var bc = a.backgroundCheck(res, sp, bg, useTs ? 'pstar' : 'drift');
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
                    // a failed k-held pass stays visible to the labels (KK rules) and the review: converged false
                    ev.kHeld = !!res.kHeld; ev.kHeldConverged = res.kHeld ? !!res.kHeld.converged : (t._kHeldFailed ? false : null);
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
            })();
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
            var rh = scanRes.rates, shift = D.depthShift(input.depth), rec = scanRes.record || X.rec;
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
            var recSum;
            if (rec) recSum = { name: String(rec.name || ''), source: rec.source || 'csv', n: rec.n || rec.t.length, origin_ms: rec.origin_ms, end_ms: rec.t[rec.t.length - 1], hash: rec.hash, reduced: false, rawStored: 'none' };
            else if (input.stored.record && isNum(input.stored.record.origin_ms)) recSum = clone(input.stored.record);
            else {
                // no record summary stored: the history-clock origin from the first stored spec, else the first rate step
                var org = null, endMs = rh.steps[rh.steps.length - 1].t_ms;
                tests.forEach(function (t) { if (org === null && t._event && t.spec && isNum(t.spec.tc_h)) org = t._event.tc_ms - t.spec.tc_h * HOUR; });
                (scanRes.events || []).forEach(function (e) { if (e && isNum(e.tEnd_ms)) endMs = mMax(endMs, e.tEnd_ms); });
                if (!isNum(org)) org = rh.steps[0].t_ms;
                recSum = { name: '', source: 'csv', n: 0, origin_ms: org, end_ms: mMax(org, endMs), hash: '0000000000000000', reduced: false, rawStored: 'none' };
            }
            var a = AI(), s1 = a && typeof a.stats === 'function' ? a.stats() : null, s0 = statsStart || {};
            var stats = { evals: s1 ? mMax(0, num(s1.evals, 0) - num(s0.evals, 0)) : 0, fits: s1 ? mMax(0, num(s1.fits, 0) - num(s0.fits, 0)) : 0,
                          slices: s1 ? mMax(0, num(s1.slices, 0) - num(s0.slices, 0)) : 0, ms: null };
            // overrides that were not applied carry their warnings (extra key) and are listed in the analysis warnings
            var ovOut = _ovList(input).map(function (ov) { var w = X.ovWarn[ov.id]; return w && w.length ? Object.assign({}, ov, { warnings: w.slice() }) : ov; });
            var ovWarns = [];
            ovOut.forEach(function (ov) { if (ov.warnings) ovWarns = ovWarns.concat(ov.warnings); });
            var warns = X.warnings.concat(ovWarns, (rh.warnings || []).filter(function (w2) { return w2.level !== 'info'; }).slice(0, 20));
            var meta = input.meta || {};
            an = {
                ok: true, version: VERSION, appVersion: appVersion,
                runAt: iso(Date.now()), inputHash: inputHash(input), resultHash: resultHash(outTests, X.trend),
                meta: { wellName: String(meta.wellName || ''), engineer: String(meta.engineer || ''), appVersion: String(meta.appVersion || '') },
                well: input.well, completion: input.completion || null, depth: input.depth || null, settings: st, zones: zones,
                record: recSum, qc: scanRes.qc, events: scanRes.events, missed: missed, rates: rh, baseline: X.baseline || null,
                tests: outTests, trend: X.trend, overrides: ovOut, stats: stats, warnings: warns
            };
            Object.defineProperty(an, '_order', { value: X.order.slice(), enumerable: false });
            return finish(an);
        }
        var PH = { start: start, scan: scan, tests: buildTests, specs: specUnit, finishTests: finishTests, stage1: stage1, stage2: stage2, stage3: stage3,
                   stage3b: stage3b, stage3c: stage3c, stage3d: stage3d, stage4: stage4, stage5: stage5 };
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
    R.inputDiff = inputDiff;
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
