// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 33 — PTA core
//   Well & Test resolver, analysis data (Δp, time functions, Bourdet
//   derivative), dimensional physical-model wrapper, lastFit store,
//   type-curve match conversion and PRiSM state persistence.
//
//   Implements the gap-closure shared contracts C1 (resolver half —
//   the store and PRiSM_setWell live in 16-pvt.js), C2, C3, C4, C5 (math)
//   and C8.
// ════════════════════════════════════════════════════════════════════
//
// PUBLIC API
//   window.PRiSM_getWell(ds?)                          C1 resolved well/fluid/test inputs
//   window.PRiSM_rateHistory(ds?)                      rate steps + flow periods
//   window.PRiSM_getAnalysisData(ds?, opts?)           C2 AData
//   window.PRiSM_timeFunction(adata|spec, dt[])        C2 time-function values x(Δt)
//   window.PRiSM_physicalModel(modelKey, well?, adata?, opts?)   C3 PM
//   window.PRiSM_convert                               C3 field-unit conversions
//   window.PRiSM_setLastFit(fit) / PRiSM_getLastFit()  C4
//   window.PRiSM_applyTypeCurveMatch(curve, tcMatch)   C5
//   window.PRiSM_matchToPhysical(tcMatch, modelKey, params, well?)  C5
//   window.PRiSM_saveState() / PRiSM_restoreState(obj?)  C8 ('wts_prism_state')
//   window.PRiSM_datasetHash(ds?)
//
// AData NOTES (beyond the C2 field list)
//   rateHistory  the history used by the analysis: signed (injection < 0),
//                trimmed to the analysed period; use PRiSM_rateHistory(ds)
//                for the full detected history.
//   qFlow        |rate| driving the analysed period (pre-shut-in rate for a
//                buildup); qRef = |q_n − q_{n−1}| (derivative plateau scale).
//   dRef         'pi' (Δp from the initial pressure) | 'start' (Δp from the
//                pressure at the start of the analysed period).
//   pRefPressure pRef in psia (pRef itself is in m(p) units for gas pseudo).
//   timeFnSpec   {kind, tp, terms:[{w, off}]}: sup(Δt) = Σ w ln(off + Δt).
//   period       opts.period / st.activePeriod index into AData.periods.
//
// UNITS — field units throughout: t in hours, p in psia, q in STB/d
//   (oil / water) or Mscf/d (gas), k md, h ft, μ cp, ct 1/psi, C bbl/psi.
//   Gas with pseudo-pressure: Δm(p) in psi²/cp.
//
// FORMULAS — the definitions (sign rule, pRef order, tp, superposition
//   time, Agarwal time, physical-model conversions) are the ones written
//   in contracts C2/C3/C5 of the gap-closure plan. They are implemented
//   below without restating them differently.
//
// CONVENTIONS — single outer IIFE, window.PRiSM_* names, no external
//   dependencies, defensive against missing primitives (Bourdet and
//   superposition have local fallbacks), self-test at the end (stripped
//   by concat-round8.js).
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});

var STATE_KEY = 'wts_prism_state';
var LN_EULER = 0.80907;              // ln(4/γ) − ln 1 term of the radial-flow asymptote

// ═══════════════════════════════════════════════════════════════
// SECTION 1 — SMALL HELPERS
// ═══════════════════════════════════════════════════════════════

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return _num(v) && v > 0; }
function _isArr(a) { return !!a && typeof a !== 'string' && typeof a.length === 'number'; }
function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function _median(a) {
    var b = [];
    for (var i = 0; i < a.length; i++) if (_num(a[i])) b.push(a[i]);
    if (!b.length) return NaN;
    b.sort(function (x, y) { return x - y; });
    var m = b.length >> 1;
    return (b.length % 2) ? b[m] : 0.5 * (b[m - 1] + b[m]);
}
function _clone(o) {
    if (o == null) return o;
    try {
        return JSON.parse(JSON.stringify(o, function (k, v) {
            if (typeof v === 'function') return undefined;
            if (typeof v === 'number' && !isFinite(v)) return null;
            return v;
        }));
    } catch (e) { return null; }
}
function _storage() {
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* denied */ }
    try { if (G.localStorage) return G.localStorage; } catch (e2) { /* denied */ }
    return null;
}
function _dispatch(name, detail) {
    try {
        var CE = G.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
        if (typeof G.dispatchEvent === 'function' && CE) G.dispatchEvent(new CE(name, { detail: detail }));
    } catch (e) { /* no event system (node self-test) */ }
}
function _now() { try { return Date.now(); } catch (e) { return 0; } }
function _logspace(lo, hi, n) {
    var out = new Array(n), step = (hi - lo) / (n - 1);
    for (var i = 0; i < n; i++) out[i] = Math.pow(10, lo + i * step);
    return out;
}

// Dataset hash (FNV-1a over a subsample) — used for lastFit staleness.
function _dsHash(ds) {
    if (!ds || !_isArr(ds.t)) return null;
    var h = 2166136261 >>> 0;
    function mix(str) {
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
    }
    var n = ds.t.length;
    mix('n' + n);
    var step = Math.max(1, Math.floor(n / 64));
    for (var i = 0; i < n; i += step) {
        mix(ds.t[i] + ',' + (ds.p ? ds.p[i] : '') + ',' + (ds.q ? ds.q[i] : '') + ';');
    }
    if (n) mix('L' + ds.t[n - 1] + ',' + (ds.p ? ds.p[n - 1] : '') + ',' + (ds.q ? ds.q[n - 1] : ''));
    return ('00000000' + h.toString(16)).slice(-8);
}
G.PRiSM_datasetHash = function PRiSM_datasetHash(ds) {
    return _dsHash(ds === undefined ? G.PRiSM_dataset : ds);
};

// ── Bourdet derivative on ln x ──────────────────────────────────────
// Same 3-point formula as PRiSM_compute_bourdet (02). The ln-values are
// passed directly so superposition time can't overflow exp().
function _bourdetOnLn(lx, y, L) {
    L = (_num(L) && L > 0) ? L : 0;
    var n = lx.length, d = new Array(n), i;
    for (i = 0; i < n; i++) d[i] = NaN;
    if (n < 3) return d;
    for (i = 1; i < n - 1; i++) {
        if (!_num(lx[i]) || !_num(y[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && lx[i] - lx[i1] < L) i1--;
            while (i2 < n - 1 && lx[i2] - lx[i] < L) i2++;
        }
        var dl1 = lx[i] - lx[i1], dl2 = lx[i2] - lx[i], dlT = lx[i2] - lx[i1];
        if (!_num(dl1) || !_num(dl2) || !_num(dlT) || dl1 === 0 || dl2 === 0 || dlT === 0) continue;
        if (!_num(y[i1]) || !_num(y[i2])) continue;
        d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
    }
    return d;
}
// Prefer the shared plot-layer implementation when it is available.
function _bourdet(x, lx, y, L) {
    var f = null;
    if (typeof G.PRiSM_compute_bourdet === 'function') f = G.PRiSM_compute_bourdet;
    // eslint-disable-next-line no-undef
    else if (typeof PRiSM_compute_bourdet === 'function') f = PRiSM_compute_bourdet;  // host-IIFE scope (02 is not wrapped)
    var xOk = true;
    for (var i = 0; i < x.length; i++) if (!_pos(x[i])) { xOk = false; break; }
    if (f && xOk) {
        try {
            var r = f(x, y, L);
            if (r && r.length === x.length) return Array.prototype.slice.call(r);
        } catch (e) { /* fall through */ }
    }
    return _bourdetOnLn(lx, y, L);
}

// ── Safe registry evaluation ────────────────────────────────────────
function _safeEval(fn, tdArr, params) {
    var n = tdArr.length, out = new Array(n), i;
    var r = null;
    try { r = fn(tdArr, params); } catch (e) { r = null; }
    if (r && r.length === n) {
        for (i = 0; i < n; i++) out[i] = _num(r[i]) ? r[i] : NaN;
        return out;
    }
    for (i = 0; i < n; i++) {
        try {
            var v = fn([tdArr[i]], params);
            out[i] = (v && _num(v[0])) ? v[0] : NaN;
        } catch (e2) { out[i] = NaN; }
    }
    return out;
}

// ── Superposition: Σ Δq_i · pu(B·(T − t_i)) (per unit A1) ──────────
function _superposeLocal(pdFn, steps, T, params, B) {
    var n = T.length, out = new Array(n), i, j;
    for (j = 0; j < n; j++) out[j] = 0;
    for (i = 0; i < steps.length; i++) {
        var dq = steps[i].q - (i ? steps[i - 1].q : 0);
        if (dq === 0) continue;
        var td = [], idx = [];
        for (j = 0; j < n; j++) {
            var dt = T[j] - steps[i].t;
            if (dt > 0) { td.push(B * dt); idx.push(j); }
        }
        if (!td.length) continue;
        var pu = pdFn(td, params);
        for (j = 0; j < idx.length; j++) out[idx[j]] += dq * pu[j];
    }
    return out;
}
function _superpose(pdFn, steps, T, params, B) {
    if (typeof G.PRiSM_superposition === 'function') {
        try {
            var rh = [];
            for (var i = 0; i < steps.length; i++) rh.push({ t_start: steps[i].t, q: steps[i].q });
            var r = G.PRiSM_superposition(pdFn, rh, T, params, function (dt) { return B * dt; });
            if (r && r.length === T.length) return Array.prototype.slice.call(r);
        } catch (e) { /* fall back */ }
    }
    return _superposeLocal(pdFn, steps, T, params, B);
}


// ═══════════════════════════════════════════════════════════════
// SECTION 2 — RATE HISTORY + FLOW PERIODS
// ═══════════════════════════════════════════════════════════════

function _sameRate(a, b) {
    if (a === b) return true;
    var m = Math.max(Math.abs(a), Math.abs(b));
    return m === 0 || Math.abs(a - b) <= 0.01 * m;
}

// Steps from the Tab 1 multi-rate table, if any row carries a non-zero rate.
function _multiRateSteps() {
    var P = G.PRiSM;
    var mr = P && P.multiRate;
    if (!_isArr(mr) || !mr.length) return null;
    var rows = [];
    for (var i = 0; i < mr.length; i++) {
        var r = mr[i];
        if (!r) continue;
        var t = +r.t, q = +r.q;
        if (_num(t) && _num(q)) rows.push({ t: t, q: q });
    }
    var any = false;
    for (var k = 0; k < rows.length; k++) if (rows[k].q !== 0) { any = true; break; }
    if (!any) return null;
    rows.sort(function (a, b) { return a.t - b.t; });
    var out = [];
    for (var j = 0; j < rows.length; j++) {
        var prevQ = out.length ? out[out.length - 1].q : 0;
        if (_sameRate(rows[j].q, prevQ)) continue;
        out.push(rows[j]);
    }
    return out;
}

// Steps detected from a sampled rate column. A change is placed at the last
// sample of the old rate (so the first sample of the new rate has Δt > 0);
// the first flowing step with no earlier samples starts at min(0, t0).
// Each step's rate is the mean of its samples. Rates within 1 % are merged.
function _stepsFromData(T, Q) {
    var steps = [], cur = 0, lastIdx = -1, sums = [], cnts = [];
    for (var i = 0; i < T.length; i++) {
        var qi = Q[i];
        if (!_num(qi)) continue;
        if (!_sameRate(qi, cur)) {
            var tc = (lastIdx >= 0) ? T[lastIdx] : Math.min(0, T[i]);
            steps.push({ t: tc, q: qi });
            sums.push(0); cnts.push(0);
            cur = qi;
        }
        if (steps.length) { sums[steps.length - 1] += qi; cnts[steps.length - 1]++; }
        lastIdx = i;
    }
    for (var s = 0; s < steps.length; s++) {
        if (cnts[s] > 0) {
            var mean = sums[s] / cnts[s];
            steps[s].q = (Math.abs(mean) < 1e-12) ? 0 : mean;
        }
    }
    // Drop a leading shut-in step (q_-1 = 0 is implicit).
    while (steps.length && steps[0].q === 0) steps.shift();
    return steps;
}

function _periodsFrom(steps, T) {
    var tLast = T.length ? T[T.length - 1] : 0;
    var out = [];
    if (!steps.length) {
        var t0 = T.length ? Math.min(0, T[0]) : 0;
        out.push({ t0: t0, t1: tLast, start: t0, end: tLast, q: null, type: 'unknown', stepIndex: -1, n: T.length, index: 0 });
        return out;
    }
    for (var i = 0; i < steps.length; i++) {
        var a = steps[i].t;
        var b = (i + 1 < steps.length) ? steps[i + 1].t : Math.max(tLast, a);
        var cnt = 0;
        for (var j = 0; j < T.length; j++) if (T[j] > a && T[j] <= b + 1e-12) cnt++;
        var q = steps[i].q;
        out.push({
            t0: a, t1: b, start: a, end: b, q: q,
            type: q === 0 ? 'shut-in' : (q < 0 ? 'injection' : 'flow'),
            stepIndex: i, n: cnt, index: i
        });
    }
    return out;
}

function _cleanSeries(ds) {
    var rows = [];
    var hasQ = !!(ds && _isArr(ds.q));
    var hasP = !!(ds && _isArr(ds.p));
    for (var i = 0; i < ds.t.length; i++) {
        var t = +ds.t[i];
        var p = hasP ? +ds.p[i] : NaN;
        if (!_num(t)) continue;
        if (hasP && !_num(p)) continue;
        rows.push({ t: t, p: p, q: hasQ ? +ds.q[i] : NaN });
    }
    var sorted = true;
    for (var k = 1; k < rows.length; k++) if (rows[k].t < rows[k - 1].t) { sorted = false; break; }
    if (!sorted) rows.sort(function (a, b) { return a.t - b.t; });
    return {
        T: rows.map(function (r) { return r.t; }),
        P: rows.map(function (r) { return r.p; }),
        Q: hasQ ? rows.map(function (r) { return r.q; }) : null
    };
}

// Rate info (unscaled) — steps, periods, default analysed period, flowing rate.
function _rateInfo(ds, periodIdx) {
    var S = _cleanSeries(ds);
    var steps = null, src = 'none';
    var mr = _multiRateSteps();
    if (mr && mr.length) { steps = mr; src = 'multiRate'; }
    else if (S.Q) {
        var any = false;
        for (var i = 0; i < S.Q.length; i++) if (_num(S.Q[i]) && S.Q[i] !== 0) { any = true; break; }
        if (any) { steps = _stepsFromData(S.T, S.Q); src = 'dataset'; }
    }
    if (!steps) steps = [];
    var periods = _periodsFrom(steps, S.T);
    var idx = _num(periodIdx) ? Math.round(periodIdx) : null;
    if (idx == null || idx < 0 || idx >= periods.length || periods[idx].n < 1) {
        idx = -1;
        for (var a = periods.length - 1; a >= 0; a--) {
            if (periods[a].type === 'shut-in' && periods[a].n >= 5) { idx = a; break; }
        }
        if (idx < 0) {
            for (var b = periods.length - 1; b >= 0; b--) if (periods[b].n >= 3) { idx = b; break; }
        }
        if (idx < 0) idx = periods.length - 1;
    }
    var per = periods[idx];
    var n = per.stepIndex;
    var qFlow = null;
    for (var c = n; c >= 0; c--) if (steps[c] && steps[c].q !== 0) { qFlow = Math.abs(steps[c].q); break; }
    return {
        series: S, steps: steps, source: src, periods: periods, periodIndex: idx,
        period: per, stepIndex: n, qFlow: qFlow, variable: steps.length > 20
    };
}

G.PRiSM_rateHistory = function PRiSM_rateHistory(ds) {
    if (ds == null) ds = G.PRiSM_dataset;
    if (!ds || !_isArr(ds.t)) return { ok: false, steps: [], periods: [], source: 'none', variable: false };
    var st = G.PRiSM_state || {};
    var ri = _rateInfo(ds, st.activePeriod);
    return {
        ok: true,
        steps: ri.steps.map(function (s) { return { t: s.t, q: s.q }; }),
        periods: ri.periods.map(function (p) { return _clone(p); }),
        source: ri.source, variable: ri.variable,
        periodIndex: ri.periodIndex, qFlow: ri.qFlow
    };
};


// ═══════════════════════════════════════════════════════════════
// SECTION 3 — C1 RESOLVER: PRiSM_getWell
// ═══════════════════════════════════════════════════════════════
// The store (window.PRiSM_pvt, persisted as wts_prism_pvt) and its writer
// PRiSM_setWell live in 16-pvt.js. This resolver turns the store plus the
// dataset into the values every analysis uses.

var WELL_KEYS = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
var CORR_INPUTS = ['T_res', 'API', 'SG_g', 'p_res', 'salinity_ppm', 'Rs', 'Pb'];

function _effectiveFluid() {
    if (typeof G.PRiSM_pvt_effective === 'function') {
        try { var e = G.PRiSM_pvt_effective(); if (e) return e; } catch (err) { /* fallback */ }
    }
    var s = G.PRiSM_pvt || {};
    var c = s._computed || null;
    if ((!c || !c.timestamp) && typeof G.PRiSM_pvt_compute === 'function') {
        try { c = G.PRiSM_pvt_compute(); } catch (err2) { c = null; }
    }
    c = c || {};
    var fl = s.fluidType || 'oil';
    var fB = fl === 'gas' ? 'Bg' : (fl === 'water' ? 'Bw' : 'Bo');
    var fM = fl === 'gas' ? 'mu_g' : (fl === 'water' ? 'mu_w' : 'mu_o');
    return {
        fluid: fl, fieldB: fB, fieldMu: fM,
        B: _pos(s[fB]) ? s[fB] : c.B, mu: _pos(s[fM]) ? s[fM] : c.mu, ct: _pos(s.ct) ? s.ct : c.ct,
        overB: _pos(s[fB]), overMu: _pos(s[fM]), overCt: _pos(s.ct), computed: c
    };
}

function _wellCore(qData, tInfo) {
    var s = G.PRiSM_pvt || {};
    var prov = s.provenance || {};
    function pv(k) { return prov[k] || 'default'; }
    var eff = _effectiveFluid();
    var corrProv = 'default';
    for (var i = 0; i < CORR_INPUTS.length; i++) if (pv(CORR_INPUTS[i]) !== 'default') { corrProv = 'correlation'; break; }
    var useData = (s.qFromData !== false) && _pos(qData);
    var q = useData ? qData : (_num(s.q) ? s.q : null);
    var piTrusted = _num(s.p_res) && pv('p_res') !== 'default';
    var fl = eff.fluid || 'oil';
    var w = {
        fluid: fl,
        q: q, B: _num(eff.B) ? eff.B : null, mu: _num(eff.mu) ? eff.mu : null, ct: _num(eff.ct) ? eff.ct : null,
        h: _num(s.h) ? s.h : null, phi: _num(s.phi) ? s.phi : null, rw: _num(s.rw) ? s.rw : null,
        pi: piTrusted ? s.p_res : null,
        piStored: _num(s.p_res) ? s.p_res : null,
        T_F: _num(s.T_res) ? s.T_res : null,
        T_R: _num(s.T_res) ? s.T_res + 459.67 : null,
        sg: _num(s.SG_g) ? s.SG_g : null,
        testType: s.testType || 'auto',
        tp: _pos(s.tp) ? s.tp : null,
        tShut: _num(s.tShut) ? s.tShut : null,
        pwf0: _pos(s.pwf0) ? s.pwf0 : null,
        qFromData: s.qFromData !== false,
        qData: _pos(qData) ? qData : null,
        qStore: _num(s.q) ? s.q : null,
        qUnit: fl === 'gas' ? 'Mscf/d' : 'STB/d',
        BUnit: fl === 'gas' ? 'RB/Mscf' : 'RB/STB',
        provenance: {
            q: useData ? 'dataset' : pv('q'),
            B: eff.overB ? pv(eff.fieldB) : corrProv,
            mu: eff.overMu ? pv(eff.fieldMu) : corrProv,
            ct: eff.overCt ? pv('ct') : corrProv,
            h: pv('h'), phi: pv('phi'), rw: pv('rw'), pi: pv('p_res'),
            fluid: pv('fluidType'), testType: pv('testType'),
            tp: pv('tp'), tShut: pv('tShut'), pwf0: pv('pwf0')
        }
    };
    var missing = [];
    for (var k = 0; k < WELL_KEYS.length; k++) {
        var key = WELL_KEYS[k];
        if (!_pos(w[key]) || (key === 'phi' && w.phi >= 1)) missing.push(key);
    }
    if (fl === 'gas' && !_pos(w.T_R)) missing.push('T_R');
    var defaulted = [];
    var dk = WELL_KEYS.concat(['pi']);
    for (var d = 0; d < dk.length; d++) if (w.provenance[dk[d]] === 'default') defaulted.push(dk[d]);
    w.missing = missing;
    w.defaulted = defaulted;
    w.complete = missing.length === 0;
    if (tInfo) w.testTypeResolved = tInfo;
    return w;
}

function _resolveTestTypeFromRates(ri, P) {
    var s = G.PRiSM_pvt || {};
    var set = s.testType || 'auto';
    if (set !== 'auto') return set;
    var n = ri.stepIndex;
    if (n >= 0 && ri.steps[n]) {
        var qn = ri.steps[n].q, qp = n > 0 ? ri.steps[n - 1].q : 0;
        if (qn === 0) return qp < 0 ? 'falloff' : 'buildup';
        return qn < 0 ? 'injection' : 'drawdown';
    }
    if (P && P.length >= 2) return (P[P.length - 1] - P[0]) >= 0 ? 'buildup' : 'drawdown';
    return 'drawdown';
}

// ds: a dataset, or null/undefined for the current one, or false for "no dataset".
G.PRiSM_getWell = function PRiSM_getWell(ds) {
    if (ds == null) ds = G.PRiSM_dataset;
    var qData = null, tt = null;
    if (ds && _isArr(ds.t) && ds.t.length) {
        try {
            var st = G.PRiSM_state || {};
            var ri = _rateInfo(ds, st.activePeriod);
            qData = ri.qFlow;
            tt = _resolveTestTypeFromRates(ri, ri.series.P);
        } catch (e) { qData = null; }
    }
    return _wellCore(qData, tt);
};


// ═══════════════════════════════════════════════════════════════
// SECTION 4 — C2 ANALYSIS DATA: PRiSM_getAnalysisData
// ═══════════════════════════════════════════════════════════════

function _timeFnValues(spec, dt) {
    var n = dt.length, x = new Array(n), lx = new Array(n);
    var kind = (spec && spec.kind) || 'dt';
    for (var i = 0; i < n; i++) {
        var d = dt[i], l;
        if (!(d > 0)) { x[i] = NaN; lx[i] = NaN; continue; }
        if (kind === 'agarwal' && _pos(spec.tp)) {
            l = Math.log(spec.tp * d / (spec.tp + d));
        } else if (kind === 'superposition' && spec.terms && spec.terms.length) {
            l = 0;
            for (var j = 0; j < spec.terms.length; j++) l += spec.terms[j].w * Math.log(spec.terms[j].off + d);
        } else {
            l = Math.log(d);
        }
        lx[i] = l;
        x[i] = Math.exp(l);
    }
    return { x: x, lnx: lx };
}
G.PRiSM_timeFunction = function PRiSM_timeFunction(a, dt) {
    var spec = (a && a.timeFnSpec) ? a.timeFnSpec : (a || { kind: 'dt' });
    return _timeFnValues(spec, _isArr(dt) ? Array.prototype.slice.call(dt) : []).x;
};

function _fail(reason, warnings) {
    return { ok: false, reason: reason, n: 0, t: [], tAbs: [], p: [], dp: [], x: [], deriv: [],
             periods: [], rateHistory: [], warnings: warnings || [] };
}

G.PRiSM_getAnalysisData = function PRiSM_getAnalysisData(ds, opts) {
    if (ds == null) ds = G.PRiSM_dataset;
    opts = opts || {};
    var st = G.PRiSM_state || {};
    var warnings = [];
    if (!ds || !_isArr(ds.t) || !ds.t.length) return _fail('No dataset loaded.');
    if (!_isArr(ds.p)) return _fail('The dataset has no pressure column (rate-only data): use decline / rate-transient analysis.');

    var periodReq = (opts.period != null) ? opts.period : st.activePeriod;
    var ri = _rateInfo(ds, periodReq);
    var T = ri.series.T, P = ri.series.P;
    if (T.length < 3) return _fail('Need at least 3 valid (t, p) points.');
    var tLast = T[T.length - 1];

    var well = _wellCore(ri.qFlow, null);
    var testSetting = well.testType || 'auto';
    var tt = _resolveTestTypeFromRates(ri, P);
    var isShut = (tt === 'buildup' || tt === 'falloff');
    var injLike = (tt === 'injection' || tt === 'falloff');

    // Working copies of the rate steps + analysed period.
    var steps = ri.steps.map(function (s) { return { t: s.t, q: s.q }; });
    var nIdx = ri.stepIndex;
    var per = ri.period;
    var rateSource = ri.source;
    var tStart = per.t0;
    var tEnd = (ri.periodIndex === ri.periods.length - 1) ? Infinity : per.t1;

    var variable = !!ri.variable && !isShut;
    if (variable) {
        // Continuously varying rate: analyse everything from the first step with Δt.
        warnings.push('The rate changes more than 20 times: the derivative uses elapsed time Δt; ' +
                      'rate-transient analysis or deconvolution is the appropriate tool for this data.');
        nIdx = 0;
        tStart = steps.length ? steps[0].t : Math.min(0, T[0]);
        tEnd = Infinity;
    } else if (ri.variable) {
        warnings.push('Long rate history (more than 20 rate changes): superposition uses every step.');
    }

    if (isShut && (nIdx < 0 || !steps[nIdx] || steps[nIdx].q !== 0)) {
        // The rate history does not show the shut-in: build it from tp / tShut.
        var tS = _num(well.tShut) ? well.tShut : (nIdx >= 0 ? per.t0 : Math.min(0, T[0]));
        var qF = (nIdx >= 0 && steps[nIdx] && steps[nIdx].q !== 0) ? Math.abs(steps[nIdx].q)
                 : (_pos(well.qStore) ? well.qStore : null);
        if (_pos(well.tp) && _pos(qF)) {
            steps = [{ t: tS - well.tp, q: qF }, { t: tS, q: 0 }];
            nIdx = 1;
            rateSource = rateSource === 'none' ? 'synthesised' : rateSource + '+synthesised';
        } else {
            steps = [];
            nIdx = -1;
            warnings.push('Producing time tp is unknown: enter tp (or the rate history) in Well & Test. ' +
                          'Until then Δt is used and the late-time derivative is too low.');
        }
        tStart = tS;
        tEnd = Infinity;
    } else if (isShut && nIdx >= 0 && _num(well.tShut)) {
        steps[nIdx].t = well.tShut;
        tStart = well.tShut;
    } else if (isShut && nIdx > 0 && rateSource === 'dataset' && steps[nIdx].q === 0) {
        // The rate column only brackets the shut-in: it is placed at the last
        // flowing sample. Flag a wide gap to the first shut-in sample.
        var tS0 = steps[nIdx].t, tFirst = NaN;
        for (var g0 = 0; g0 < T.length; g0++) if (T[g0] > tS0 + 1e-12) { tFirst = T[g0]; break; }
        var tpS = tS0 - steps[0].t;
        if (_num(tFirst) && tFirst - tS0 > 0.01 && tFirst - tS0 > 0.02 * Math.max(tpS, 0)) {
            warnings.push('Shut-in time is uncertain: the last flowing sample is at ' + (+tS0.toPrecision(4)) +
                          ' h and the first shut-in sample at ' + (+tFirst.toPrecision(4)) + ' h. Δt is measured from ' +
                          (+tS0.toPrecision(4)) + ' h — enter tShut on Well & Test if the well was shut in later.');
        }
    }
    if (isShut && nIdx === 1 && steps[0].q !== 0 && _pos(well.tp)) {
        steps[0].t = tStart - well.tp;           // single-rate history: honour the entered tp
    }
    if (!isShut && nIdx >= 0 && steps[nIdx] && steps[nIdx].q === 0) {
        warnings.push('The analysed period has zero rate but the test type is set to ' + tt + '.');
    }
    // The analysis only needs the steps up to the analysed period.
    if (!variable && nIdx >= 0 && steps.length > nIdx + 1) steps = steps.slice(0, nIdx + 1);

    // Injection entered as positive rates → make the internal history signed.
    if (injLike && steps.length) {
        var allPos = true;
        for (var a = 0; a < steps.length; a++) if (steps[a].q < 0) { allPos = false; break; }
        if (allPos) for (var b = 0; b < steps.length; b++) steps[b].q = -steps[b].q;
    }

    // Flowing rate driving the analysed period, and the rate change (qRef).
    var qFlow = null;
    for (var c = nIdx; c >= 0; c--) if (steps[c] && steps[c].q !== 0) { qFlow = Math.abs(steps[c].q); break; }
    if (!_pos(qFlow)) qFlow = _pos(well.qStore) ? well.qStore : null;
    var sgnQ = injLike ? -1 : 1;
    if (!steps.length && _pos(qFlow) && !isShut) {
        steps = [{ t: tStart, q: sgnQ * qFlow }];
        nIdx = 0;
        rateSource = 'assumed';
    }
    // q entered by hand overrides the data rate (rates scaled together).
    var qScale = 1;
    if (well.qFromData === false && _pos(well.qStore) && _pos(qFlow) && rateSource !== 'assumed' && rateSource !== 'none') {
        qScale = well.qStore / qFlow;
        for (var e = 0; e < steps.length; e++) steps[e].q *= qScale;
        qFlow *= qScale;
    }
    var qRef = qFlow;
    if (nIdx >= 0 && steps[nIdx]) qRef = Math.abs(steps[nIdx].q - (nIdx > 0 ? steps[nIdx - 1].q : 0));

    // tp (Horner-equivalent producing time).
    var tp = null;
    if (isShut) {
        if (_pos(well.tp)) tp = well.tp;
        else if (nIdx >= 1 && steps[nIdx - 1].q !== 0) {
            var Np = 0;
            for (var f = 0; f < nIdx; f++) {
                var tNext = (f + 1 < nIdx) ? steps[f + 1].t : tStart;
                Np += steps[f].q * (tNext - steps[f].t);
            }
            tp = Np / steps[nIdx - 1].q;
            if (!_pos(tp)) tp = null;
        }
    }

    // Samples of the analysed period.
    var idx = [];
    for (var g = 0; g < T.length; g++) {
        if (T[g] > tStart && T[g] <= tEnd + 1e-12) idx.push(g);
    }
    if (idx.length < 3) return _fail('The analysed period has fewer than 3 samples after its start.', warnings);

    // Sign rule (contract C2).
    var sign = (tt === 'buildup' || tt === 'injection') ? 1 : -1;

    // Reference pressure.
    var pRef = null, pRefSource = null, dRef = 'pi';
    function lastAtOrBefore(tc) {
        var j = -1;
        for (var h = 0; h < T.length; h++) { if (T[h] <= tc + 1e-12) j = h; else break; }
        return j;
    }
    function extrapolate() {
        if (idx.length < 3) return null;
        var sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (var m = 0; m < 3; m++) {
            var xx = T[idx[m]] - tStart, yy = P[idx[m]];
            sx += xx; sy += yy; sxx += xx * xx; sxy += xx * yy;
        }
        var den = 3 * sxx - sx * sx;
        if (!(Math.abs(den) > 0)) return null;
        var slope = (3 * sxy - sx * sy) / den;
        var icpt = (sy - slope * sx) / 3;
        if (!(slope * sign > 0)) return null;
        // Δt = 0 must lie before the first sample in the test's direction.
        if (!(sign * (P[idx[0]] - icpt) > 0)) return null;
        var span = Math.abs(P[idx[2]] - P[idx[0]]);
        if (!_num(icpt) || Math.abs(icpt - P[idx[0]]) > 5 * span + 1e-9) return null;
        return icpt;
    }
    if (!isShut) {
        if (_num(well.pi)) { pRef = well.pi; pRefSource = 'pi'; dRef = 'pi'; }
        else {
            var j0 = lastAtOrBefore(tStart);
            var ex;
            if (j0 >= 0) { pRef = P[j0]; pRefSource = 't0-row'; }
            else if ((ex = extrapolate()) != null) { pRef = ex; pRefSource = 'extrapolated'; }
            else { pRef = P[idx[0]]; pRefSource = 'first-sample'; }
            dRef = (nIdx <= 0) ? 'pi' : 'start';
            if (pRefSource === 'extrapolated') {
                warnings.push('Initial pressure pi is not set: Δp is measured from the pressure extrapolated to Δt = 0 (' +
                              pRef.toFixed(1) + ' psia). The skin estimate is biased: enter pi in Well & Test or float pi in regression.');
            } else if (pRefSource === 'first-sample') {
                warnings.push('Initial pressure pi is not set: Δp is measured from the first sample (' +
                              pRef.toFixed(1) + ' psia). The skin estimate is biased (usually too low): enter pi in Well & Test.');
            } else if (dRef === 'start') {
                warnings.push('Initial pressure pi is not set: this later flow period is referenced to the pressure at its start.');
            }
        }
    } else {
        dRef = 'start';
        if (_pos(well.pwf0)) { pRef = well.pwf0; pRefSource = 'pwf0'; }
        else {
            var j1 = lastAtOrBefore(tStart);
            var ex2;
            if (j1 >= 0) { pRef = P[j1]; pRefSource = 'pwf0'; }
            else if ((ex2 = extrapolate()) != null) {
                pRef = ex2; pRefSource = 'extrapolated';
                warnings.push('Flowing pressure at shut-in (pwf at Δt = 0) is not in the data: it was extrapolated (' +
                              pRef.toFixed(1) + ' psia). The skin estimate is biased: enter pwf0 in Well & Test.');
            } else {
                pRef = P[idx[0]]; pRefSource = 'first-sample';
                warnings.push('Flowing pressure at shut-in (pwf at Δt = 0) is unknown: Δp is measured from the first sample. ' +
                              'The skin estimate is biased: enter pwf0 in Well & Test.');
            }
        }
    }
    var pRefPressure = pRef;

    // Gas pseudo-pressure.
    var pseudo = (opts.pseudo != null) ? !!opts.pseudo : (well.fluid === 'gas');
    var Y = P, yRef = pRef, mpSpec = null, dpUnit = 'psi';
    if (pseudo) {
        if (well.fluid === 'gas' && typeof G.PRiSM_mpTable === 'function') {
            var pMax = pRef;
            for (var u = 0; u < P.length; u++) if (P[u] > pMax) pMax = P[u];
            if (_num(well.piStored) && well.piStored > pMax) pMax = well.piStored;
            mpSpec = { T_F: well.T_F, SG_g: well.sg, pmax: 1.2 * pMax };
            try {
                var tbl = G.PRiSM_mpTable(mpSpec);
                Y = P.map(function (pp) { return tbl.mOf(pp); });
                yRef = tbl.mOf(pRef);
                dpUnit = 'psi²/cp';
            } catch (err) { pseudo = false; mpSpec = null; Y = P; yRef = pRef; }
        } else {
            pseudo = false;
        }
    }

    // Δt, Δp (> 0 only), optional window.
    var tmin = _num(opts.tmin) ? opts.tmin : -Infinity;
    var tmax = _num(opts.tmax) ? opts.tmax : Infinity;
    var t = [], tAbs = [], pp2 = [], dp = [];
    var dropped = 0;
    for (var v = 0; v < idx.length; v++) {
        var gi = idx[v];
        var dtv = T[gi] - tStart;
        if (!(dtv > 0) || dtv < tmin || dtv > tmax) continue;
        var dpv = sign * (Y[gi] - yRef);
        if (!(dpv > 0)) { dropped++; continue; }
        t.push(dtv); tAbs.push(T[gi]); pp2.push(P[gi]); dp.push(dpv);
    }
    if (dropped > 0 && dropped > 0.1 * idx.length) {
        warnings.push(dropped + ' of ' + idx.length + ' points have Δp ≤ 0 and were excluded: check the test type and the reference pressure.');
        if (!isShut && testSetting === 'auto' && dropped > 0.5 * idx.length) {
            warnings.push('Pressure rises during a flowing period: if this is an injection test, set the test type to Injection.');
        }
    }
    if (t.length < 3) return _fail('Fewer than 3 points with Δp > 0 in the analysed period.', warnings);

    // Time function.
    var tfReq = opts.timeFn || st.timeFn || 'auto';
    var tf = tfReq;
    if (variable) tf = 'dt';
    else if (tf === 'auto') tf = (isShut || nIdx > 0) ? 'superposition' : 'dt';
    var terms = [];
    if (tf === 'superposition') {
        if (nIdx >= 0 && steps.length) {
            var qn = steps[nIdx].q, qp = nIdx > 0 ? steps[nIdx - 1].q : 0;
            var den2 = qn - qp;
            for (var w = 0; w <= nIdx; w++) {
                var dqw = steps[w].q - (w ? steps[w - 1].q : 0);
                if (dqw === 0 || den2 === 0) continue;
                terms.push({ w: dqw / den2, off: Math.max(0, tStart - steps[w].t) });
            }
        }
        if (!terms.length) {
            tf = 'dt';
            if (tfReq !== 'auto') warnings.push('No rate history: superposition time is unavailable, Δt is used.');
        }
    }
    if (tf === 'agarwal' && !_pos(tp)) {
        tf = 'dt';
        warnings.push('Agarwal equivalent time needs tp: Δt is used.');
    }
    var spec = { kind: tf, tp: tp, terms: terms };
    var tv = _timeFnValues(spec, t);
    var mono = true;
    for (var z = 1; z < tv.lnx.length; z++) if (!(tv.lnx[z] > tv.lnx[z - 1])) { mono = false; break; }
    if (!mono && tf !== 'dt') {
        warnings.push('The ' + tf + ' time function is not monotonic for this period: Δt is used for the derivative.');
        spec = { kind: 'dt', tp: tp, terms: [] };
        tf = 'dt';
        tv = _timeFnValues(spec, t);
    }

    var L = _num(opts.L) ? opts.L : (_num(st.bourdetL) ? st.bourdetL : 0.1);
    var deriv = _bourdet(tv.x, tv.lnx, dp, L);

    return {
        ok: true, reason: null, n: t.length,
        t: t, tAbs: tAbs, p: pp2, dp: dp,
        x: tv.x, lnx: tv.lnx, deriv: deriv, L: L, timeFn: tf, timeFnSpec: spec,
        sign: sign, pRef: yRef, pRefPressure: pRefPressure, pRefSource: pRefSource, dRef: dRef,
        pwf0: isShut ? pRefPressure : null,
        testType: tt, testTypeSetting: testSetting,
        tStart: tStart, tShut: isShut ? tStart : null, tp: tp,
        qRef: _pos(qRef) ? qRef : qFlow, qFlow: qFlow, qScale: qScale,
        rateHistory: steps, rateSource: rateSource, variableRate: !!ri.variable, stepIndex: nIdx,
        periods: ri.periods.map(function (pr) {
            return { t0: pr.t0, t1: pr.t1, start: pr.start, end: pr.end, q: pr.q, type: pr.type, n: pr.n, index: pr.index };
        }),
        periodIndex: ri.periodIndex,
        fluid: well.fluid, pseudo: pseudo, dpUnit: dpUnit, mpSpec: mpSpec,
        hash: _dsHash(ds),
        warnings: warnings
    };
};


// ═══════════════════════════════════════════════════════════════
// SECTION 5 — C3 CONVERSIONS: PRiSM_convert
// ═══════════════════════════════════════════════════════════════
// Every function takes one or more objects that are merged, e.g.
//   PRiSM_convert.A(well, {k: 45})   or   PRiSM_convert.B({k, phi, mu, ct, rw})

function _merge(args) {
    var o = {};
    for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a && typeof a === 'object') for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k) && a[k] != null) o[k] = a[k];
    }
    return o;
}
function _kh(o) { return _num(o.kh) ? o.kh : o.k * o.h; }
function _L(o) { return _num(o.L) ? o.L : (_num(o.Lref) ? o.Lref : o.rw); }

var CONST = {
    A: 141.2, B: 0.0002637, Cd: 0.8936, rinv: 948, plateau: 70.6, semilog: 162.6,
    CfromT: 0.0002951, gasA: 1422, gasSemilog: 1637, gasPlateau: 711
};

G.PRiSM_convert = {
    CONST: CONST,
    // A = 141.2 qBμ/(kh)  [psi per unit pD]
    A: function () { var o = _merge(arguments); return CONST.A * o.q * o.B * o.mu / _kh(o); },
    // Gas pseudo-pressure: A = 1422 q T_R/(kh)  [psi²/cp per unit pD]
    Agas: function () { var o = _merge(arguments); var TR = _num(o.T_R) ? o.T_R : o.T_F + 459.67; return CONST.gasA * o.q * TR / _kh(o); },
    // B = 0.0002637 k/(φ μ ct L²)  [tD per hour]
    B: function () { var o = _merge(arguments); var L = _L(o); return CONST.B * o.k / (o.phi * o.mu * o.ct * L * L); },
    // Cd = 0.8936 C/(φ ct h L²)
    Cd: function () { var o = _merge(arguments); var L = _L(o); return CONST.Cd * o.C / (o.phi * o.ct * o.h * L * L); },
    // C = Cd φ ct h L²/0.8936  [bbl/psi]
    C: function () { var o = _merge(arguments); var L = _L(o); return o.Cd * o.phi * o.ct * o.h * L * L / CONST.Cd; },
    // kh = 141.2 qBμ/A
    kh: function () { var o = _merge(arguments); return CONST.A * o.q * o.B * o.mu / o.A; },
    // k from a time scale B: k = B φ μ ct L²/0.0002637
    kFromB: function () { var o = _merge(arguments); var L = _L(o); var Bv = _num(o.Bscale) ? o.Bscale : o.Bt; return Bv * o.phi * o.mu * o.ct * L * L / CONST.B; },
    // rinv = √(k t/(948 φ μ ct))  [ft]
    rinv: function () { var o = _merge(arguments); return Math.sqrt(o.k * o.t / (CONST.rinv * o.phi * o.mu * o.ct)); },
    // distance_ft = D·Lref
    distance: function () { var o = _merge(arguments); return o.D * _L(o); },
    // C = 0.0002951 kh/(μ T), T = B/Cd  [bbl/psi]
    CfromT: function () { var o = _merge(arguments); return CONST.CfromT * _kh(o) / (o.mu * o.T); },
    // Derivative plateau 70.6 qBμ/kh  [psi]
    plateau: function () { var o = _merge(arguments); return CONST.plateau * o.q * o.B * o.mu / _kh(o); },
    // Semilog slope m = 162.6 qBμ/kh  [psi/cycle]
    semilogSlope: function () { var o = _merge(arguments); return CONST.semilog * o.q * o.B * o.mu / _kh(o); },
    khFromPlateau: function () { var o = _merge(arguments); return CONST.plateau * o.q * o.B * o.mu / o.dpPrime; },
    khFromSlope: function () { var o = _merge(arguments); return CONST.semilog * o.q * o.B * o.mu / Math.abs(o.m); }
};


// ═══════════════════════════════════════════════════════════════
// SECTION 6 — C3 PHYSICAL MODEL WRAPPER: PRiSM_physicalModel
// ═══════════════════════════════════════════════════════════════

var DISTANCE_KEYS = { dF: 1, dF1: 1, dF2: 1, dEnd: 1, dN: 1, dS: 1, dE: 1, dW: 1, L: 1, re: 1, reD: 1 };

function _registryKeys(entry) {
    var keys = [], seen = {};
    var spec = entry.paramSpec || [];
    for (var i = 0; i < spec.length; i++) {
        var k = spec[i] && spec[i].key;
        if (k && !seen[k]) { seen[k] = 1; keys.push(k); }
    }
    var d = entry.defaults || {};
    for (var k2 in d) if (Object.prototype.hasOwnProperty.call(d, k2) && !seen[k2]) { seen[k2] = 1; keys.push(k2); }
    return keys;
}

G.PRiSM_physicalModel = function PRiSM_physicalModel(modelKey, well, adata, opts) {
    opts = opts || {};
    var reg = G.PRiSM_MODELS || {};
    var entry = reg[modelKey];
    if (!entry || typeof entry.pd !== 'function') return { ok: false, reason: 'Unknown model "' + modelKey + '".' };
    if (entry.kind === 'rate' || entry.timeInput === 'days') {
        return { ok: false, reason: 'Model "' + modelKey + '" is a rate (decline) model: fit it to rates, not pressure.' };
    }
    if (!adata) adata = G.PRiSM_getAnalysisData();
    if (!adata || !adata.ok) return { ok: false, reason: (adata && adata.reason) || 'No analysis data.' };
    if (!well) well = G.PRiSM_getWell();

    var regKeys = _registryKeys(entry);
    var hasCd = regKeys.indexOf('Cd') >= 0, hasS = regKeys.indexOf('S') >= 0;
    var refLength = (entry.refLength === 'xf' || entry.refLength === 'Lh') ? entry.refLength : 'rw';
    var specByKey = {};
    (entry.paramSpec || []).forEach(function (s) { if (s && s.key) specByKey[s.key] = s; });
    var defaults = entry.defaults || {};
    // Categorical / structured parameters (options lists, string or array defaults such as
    // BC, interporosityMode, layers) are never regressed: they pass through unchanged (WP0 fix).
    var catKeys = regKeys.filter(function (k) {
        if (k === 'Cd' || k === 'S' || k.indexOf('__') === 0) return false;
        var sp = specByKey[k] || {};
        var dv = (defaults[k] !== undefined) ? defaults[k] : sp.default;
        return !!sp.options || !_num(dv);
    });
    var shapeKeys = regKeys.filter(function (k) { return k !== 'Cd' && k !== 'S' && k.indexOf('__') !== 0 && catKeys.indexOf(k) < 0; });
    var pseudo = !!adata.pseudo;
    var coef = pseudo ? (_pos(well.T_R) ? CONST.gasA * well.T_R : NaN) : CONST.A * well.B * well.mu;
    var physOk = well.complete && _pos(coef);
    var mode = opts.mode || (physOk ? 'physical' : 'scale');
    if (mode === 'physical' && !physOk) mode = 'scale';
    // Lh-referenced models: in physical mode Lh (ft) is floated, so L_to_h is derived from it
    // (L_to_h = 2·Lh/h, plus __Lh_h = Lh/h) instead of being a second, conflicting unknown.
    var lhDerived = mode === 'physical' && refLength === 'Lh' && shapeKeys.indexOf('L_to_h') >= 0;
    if (lhDerived) shapeKeys = shapeKeys.filter(function (k) { return k !== 'L_to_h'; });
    var floatPi = !!opts.floatPi;
    var steps = adata.rateHistory || [];
    var qFlow = _pos(adata.qFlow) ? adata.qFlow : (_pos(well.q) ? well.q : 1);
    var qRef = _pos(adata.qRef) ? adata.qRef : qFlow;
    var sign = adata.sign;
    var tStart = adata.tStart;
    var isShut = adata.testType === 'buildup' || adata.testType === 'falloff';
    var noHistory = steps.length === 0;
    var simple = noHistory || (steps.length === 1 && adata.dRef === 'pi' &&
                 Math.abs(steps[0].t - tStart) <= 1e-9 * Math.max(1, Math.abs(tStart)));
    var sq = steps.length ? (steps[0].q < 0 ? -1 : 1) : (adata.testType === 'injection' ? -1 : 1);
    var tfSpec = adata.timeFnSpec || { kind: 'dt' };
    var dtEquivalent = tfSpec.kind === 'dt' ||
        (tfSpec.kind === 'superposition' && tfSpec.terms && tfSpec.terms.length === 1 &&
         Math.abs(tfSpec.terms[0].off) < 1e-12 && Math.abs(tfSpec.terms[0].w - 1) < 1e-12);
    var Cd0 = _pos(defaults.Cd) ? defaults.Cd : 100;
    var tbl = null;
    if (pseudo && adata.mpSpec && typeof G.PRiSM_mpTable === 'function') {
        try { tbl = G.PRiSM_mpTable(adata.mpSpec); } catch (e) { tbl = null; }
    }
    var warnings = [];
    if (noHistory && isShut) warnings.push('No rate history for this shut-in: the model is evaluated as an equivalent drawdown.');

    // ── keys + spec ─────────────────────────────────────────────
    var keys = [], spec = {};
    function addShape() {
        shapeKeys.forEach(function (k) {
            var s = specByKey[k] || {};
            keys.push(k);
            spec[k] = {
                min: _num(s.min) ? s.min : -Infinity, max: _num(s.max) ? s.max : Infinity,
                unit: s.unit || '-', scale: s.scale === 'log' ? 'log' : 'lin',
                default: _num(defaults[k]) ? defaults[k] : (_num(s.default) ? s.default : null)
            };
        });
    }
    var sSpec = specByKey.S || {};
    if (mode === 'physical') {
        keys.push('k'); spec.k = { min: 1e-4, max: 1e5, unit: 'md', scale: 'log', default: null };
        if (hasCd) { keys.push('C'); spec.C = { min: 1e-7, max: 10, unit: 'bbl/psi', scale: 'log', default: null }; }
        if (hasS) {
            // xf / Lh-referenced models: a negative S goes through the effective-
            // radius transform (t·e^{2S}, Cd·e^{2S}) which, with distances not
            // scaled, is exactly xf → xf·e^{S}. S and xf would then be one
            // ridge, so S is a fracture-face / choke skin here, S ≥ 0.
            var sMin = _num(sSpec.min) ? sSpec.min : -7;
            if (refLength !== 'rw') sMin = Math.max(0, sMin);
            keys.push('S'); spec.S = { min: sMin, max: _num(sSpec.max) ? sSpec.max : 50, unit: '-', scale: 'lin', default: 0 };
        }
        if (refLength !== 'rw') {
            keys.push(refLength);
            spec[refLength] = refLength === 'xf'
                ? { min: 1, max: 1e4, unit: 'ft', scale: 'log', default: 100 }
                : { min: 10, max: 2e4, unit: 'ft', scale: 'log', default: 1000 };
        }
        addShape();
    } else {
        keys.push('A'); spec.A = { min: 1e-4, max: 1e8, unit: adata.dpUnit === 'psi' ? 'psi' : adata.dpUnit, scale: 'log', default: null };
        keys.push('T'); spec.T = { min: 1e-6, max: 1e12, unit: hasCd ? '(tD/CD)/hr' : 'tD/hr', scale: 'log', default: null };
        if (hasCd && hasS) { keys.push('CDe2S'); spec.CDe2S = { min: 1e-3, max: 1e80, unit: '-', scale: 'log', default: null }; }
        else if (hasS) { keys.push('S'); spec.S = { min: _num(sSpec.min) ? sSpec.min : -7, max: _num(sSpec.max) ? sSpec.max : 50, unit: '-', scale: 'lin', default: 0 }; }
        addShape();
        warnings.push('Well inputs are incomplete' + (well.missing && well.missing.length ? ' (missing: ' + well.missing.join(', ') + ')' : '') +
                      ': fitting in scale mode. kh and C are reported only when q, B, μ and h are known; ' +
                      'skin is not identifiable without φ·ct·rw².');
    }
    if (floatPi) {
        var dpMax = 0;
        for (var i = 0; i < adata.dp.length; i++) if (adata.dp[i] > dpMax) dpMax = adata.dp[i];
        var pR = adata.pRefPressure;
        var span = pseudo ? Math.max(500, 0.5 * pR) : Math.max(100, 5 * dpMax);
        keys.push('pi');
        spec.pi = { min: Math.max(14.7, pR - span), max: pR + span, unit: 'psia', scale: 'lin', default: _num(well.pi) ? well.pi : pR };
    }

    function _lref(phys) {
        if (refLength === 'rw') return well.rw;
        return _pos(phys[refLength]) ? phys[refLength] : spec[refLength].default;
    }

    function toModelParams(phys) {
        phys = phys || {};
        var params = {}, A, B, Lref = null;
        shapeKeys.forEach(function (k) {
            params[k] = _num(phys[k]) ? phys[k] : defaults[k];
        });
        var stP = (G.PRiSM_state && G.PRiSM_state.model === modelKey && G.PRiSM_state.params) || {};
        catKeys.forEach(function (k) {
            var has = function (v) { return v !== undefined && v !== null && v !== ''; };
            params[k] = has(phys[k]) ? phys[k] : has(stP[k]) ? stP[k]
                : (defaults[k] !== undefined ? defaults[k] : (specByKey[k] || {}).default);
        });
        if (mode === 'physical') {
            Lref = _lref(phys);
            if (lhDerived && _pos(Lref) && _pos(well.h)) { params.L_to_h = 2 * Lref / well.h; params.__Lh_h = Lref / well.h; }
            var kh = phys.k * well.h;
            A = coef * qFlow / kh;
            B = CONST.B * phys.k / (well.phi * well.mu * well.ct * Lref * Lref);
            if (hasCd) params.Cd = CONST.Cd * phys.C / (well.phi * well.ct * well.h * Lref * Lref);
            if (hasS) params.S = _num(phys.S) ? phys.S : 0;
        } else {
            A = phys.A;
            if (hasCd) { params.Cd = Cd0; B = phys.T * Cd0; } else { B = phys.T; }
            if (hasCd && hasS) params.S = 0.5 * Math.log(phys.CDe2S / Cd0);
            else if (hasS) params.S = _num(phys.S) ? phys.S : 0;
        }
        if (_pos(well.h) && _pos(well.rw)) params.__h_rw = well.h / well.rw;
        return { params: params, A: A, B: B, A1: A / qFlow, Lref: Lref };
    }

    var pdFn = function (td, p) { return _safeEval(entry.pd, td, p); };

    // Raw drawdown function D(T) = Σ Δq_i A1 pd(B (T − t_i)) at absolute times.
    function _Draw(dtArr, mp) {
        var n = dtArr.length, out = new Array(n), i2;
        if (simple) {
            var td = new Array(n);
            for (i2 = 0; i2 < n; i2++) td[i2] = mp.B * dtArr[i2];
            var pdv = pdFn(td, mp.params);
            for (i2 = 0; i2 < n; i2++) out[i2] = sq * mp.A * pdv[i2];
            return { D: out, Dref: 0 };
        }
        var T = new Array(n + 1);
        for (i2 = 0; i2 < n; i2++) T[i2] = tStart + dtArr[i2];
        T[n] = tStart;
        var D = _superpose(pdFn, steps, T, mp.params, mp.B);
        for (i2 = 0; i2 <= n; i2++) D[i2] = mp.A1 * D[i2];
        var Dref = adata.dRef === 'start' ? D[n] : 0;
        return { D: D.slice(0, n), Dref: Dref };
    }

    function _toY(p) { return (pseudo && tbl) ? tbl.mOf(p) : p; }
    function _fromY(y) { return (pseudo && tbl) ? tbl.pOf(y) : y; }

    function dp(t, phys) {
        var arr = Array.prototype.slice.call(t || []);
        var mp = toModelParams(phys);
        var r = _Draw(arr, mp);
        var out = new Array(arr.length), i3;
        if (noHistory) {
            for (i3 = 0; i3 < arr.length; i3++) out[i3] = sq * r.D[i3];   // equivalent drawdown, A·pd
            return out;
        }
        if (floatPi && _num(phys && phys.pi)) {
            var piY = _toY(phys.pi);
            for (i3 = 0; i3 < arr.length; i3++) out[i3] = sign * ((piY - r.D[i3]) - adata.pRef);
            return out;
        }
        for (i3 = 0; i3 < arr.length; i3++) out[i3] = -sign * (r.D[i3] - r.Dref);
        return out;
    }

    function deriv(t, phys) {
        var arr = Array.prototype.slice.call(t || []);
        var n = arr.length, out = new Array(n), i4;
        if ((simple || noHistory) && dtEquivalent && typeof entry.pdPrime === 'function') {
            var mp = toModelParams(phys);
            var td = arr.map(function (d) { return mp.B * d; });
            var pdp = _safeEval(entry.pdPrime, td, mp.params);
            for (i4 = 0; i4 < n; i4++) out[i4] = mp.A * pdp[i4];
            return out;
        }
        var tpos = arr.filter(_pos);
        if (!tpos.length) { for (i4 = 0; i4 < n; i4++) out[i4] = NaN; return out; }
        var lo = Math.log10(Math.min.apply(null, tpos)) - 0.5;
        var hi = Math.log10(Math.max.apply(null, tpos)) + 0.5;
        var npts = Math.max(30, Math.ceil((hi - lo) * 20) + 1);
        var grid = _logspace(lo, hi, npts);
        var phys2 = {};
        for (var k in (phys || {})) if (k !== 'pi') phys2[k] = phys[k];
        var dg = dp(grid, phys2);
        var lxg = _timeFnValues(noHistory ? { kind: 'dt' } : tfSpec, grid).lnx;
        var dd = _bourdetOnLn(lxg, dg, 0);
        var lgrid = grid.map(Math.log);
        for (i4 = 0; i4 < n; i4++) {
            var tt2 = arr[i4];
            if (!_pos(tt2)) { out[i4] = NaN; continue; }
            var lt = Math.log(tt2);
            var jj = Math.floor((lt - lgrid[0]) / (lgrid[1] - lgrid[0]));
            jj = _clamp(jj, 1, npts - 3);
            var f = (lt - lgrid[jj]) / (lgrid[jj + 1] - lgrid[jj]);
            out[i4] = dd[jj] + f * (dd[jj + 1] - dd[jj]);
        }
        return out;
    }

    function p(t, phys) {
        var d = dp(t, phys);
        return d.map(function (v) { return _fromY(adata.pRef + sign * v); });
    }

    function seed() {
        var t = adata.t, y = adata.dp, d = adata.deriv, n = t.length, i5;
        var lateD = [];
        for (i5 = Math.floor(n * 0.7); i5 < n; i5++) if (_pos(d[i5])) lateD.push(d[i5]);
        if (lateD.length < 2) { lateD = []; for (i5 = 0; i5 < n; i5++) if (_pos(d[i5])) lateD.push(d[i5]); }
        var dr = _median(lateD);
        if (!_pos(dr)) dr = _pos(y[n - 1]) ? y[n - 1] / 10 : 1;
        var r = n - 1;
        while (r > 0 && !_pos(d[r])) r--;
        var tr = t[r], dpr = y[r];
        var tEq = (isShut && _pos(adata.tp)) ? adata.tp * tr / (adata.tp + tr) : tr;
        var iu = 0;
        for (i5 = 0; i5 + 1 < Math.min(n, 12); i5++) {
            var sl = Math.log(y[i5 + 1] / y[i5]) / Math.log(t[i5 + 1] / t[i5]);
            if (sl > 0.85 && sl < 1.15) { iu = i5; break; }
        }
        var dpReal = pseudo ? Math.abs(adata.p[iu] - adata.pRefPressure) : y[iu];
        var ph = {};
        if (mode === 'physical') {
            var kh = 0.5 * coef * qRef / dr;
            var k = _clamp(kh / well.h, 1e-4, 1e5);
            ph.k = k;
            if (hasCd) ph.C = _clamp(qFlow * well.B * t[iu] / (24 * dpReal), 1e-7, 10);
            if (refLength !== 'rw') ph[refLength] = spec[refLength].default;
            if (hasS) {
                // The radial pseudo-skin formula only applies to rw-referenced
                // models; a fracture / horizontal well starts at S = 0.
                if (refLength !== 'rw') ph.S = 0;
                else {
                    var S0 = 0.5 * (dpr / dr - Math.log(CONST.B * k * tEq / (well.phi * well.mu * well.ct * well.rw * well.rw)) - LN_EULER);
                    ph.S = _num(S0) ? _clamp(S0, -6, 40) : 0;
                }
            }
        } else {
            var A = 2 * dr * qFlow / qRef;
            ph.A = A;
            if (hasCd) {
                ph.T = _clamp(y[iu] / (A * t[iu]), 1e-6, 1e12);
                if (hasS) ph.CDe2S = _clamp(Math.exp(_clamp(2 * dpr / A - Math.log(ph.T * tEq) - LN_EULER, -6, 180)), 1e-3, 1e78);
            } else {
                ph.T = _clamp(Math.exp(_clamp(2 * dpr / A - LN_EULER, -60, 60)) / tEq, 1e-6, 1e12);
                if (hasS) ph.S = 0;
            }
        }
        shapeKeys.forEach(function (sk) { ph[sk] = _num(defaults[sk]) ? defaults[sk] : (spec[sk] && spec[sk].default); });
        if (floatPi) {
            if (_num(well.pi)) ph.pi = well.pi;
            else if (isShut && !pseudo && _pos(adata.tp)) {
                ph.pi = adata.p[r] + sign * dr * Math.log((adata.tp + tr) / tr);
            } else ph.pi = adata.pRefPressure;
        }
        return ph;
    }

    function derived(phys) {
        phys = phys || {};
        var mp = toModelParams(phys);
        var tEnd = 0;
        for (var i6 = 0; i6 < adata.t.length; i6++) if (adata.t[i6] > tEnd) tEnd = adata.t[i6];
        var out = {
            mode: mode, A: mp.A, B: mp.B,
            logPM: Math.log10(1 / mp.A), logTM: Math.log10(mp.B),
            tEnd: tEnd, pi: floatPi && _num(phys.pi) ? phys.pi : well.pi,
            warnings: []
        };
        if (mode === 'physical') {
            out.k = phys.k;
            out.kh = phys.k * well.h;
            out.C = hasCd ? phys.C : null;
            out.Cd = hasCd ? mp.params.Cd : null;
            out.S = hasS ? mp.params.S : null;
            out.CDe2S = (hasCd && hasS) ? mp.params.Cd * Math.exp(2 * mp.params.S) : null;
            out.refLength_ft = mp.Lref;
            if (refLength !== 'rw') out[refLength] = mp.Lref;
            out.distances_ft = {};
            shapeKeys.forEach(function (sk) {
                var s = specByKey[sk] || {};
                var isDist = DISTANCE_KEYS[sk] || s.unit === 'r_w' || s.unit === 'rw' || s.unit === 'L_ref';
                if (isDist && _num(mp.params[sk])) out.distances_ft[sk] = mp.params[sk] * mp.Lref;
            });
            out.rinv = Math.sqrt(phys.k * tEnd / (CONST.rinv * well.phi * well.mu * well.ct));
        } else {
            var khs = (_pos(coef) && _pos(mp.A)) ? coef * qFlow / mp.A : null;
            out.kh = khs;
            out.k = (_pos(khs) && _pos(well.h)) ? khs / well.h : null;
            out.C = (hasCd && _pos(khs) && _pos(well.mu)) ? CONST.CfromT * khs / (well.mu * phys.T) : null;
            out.Cd = null;
            out.S = null;
            out.CDe2S = (hasCd && hasS) ? phys.CDe2S : null;
            out.distances_ft = {};
            out.rinv = (_pos(out.k) && _pos(well.phi) && _pos(well.mu) && _pos(well.ct))
                ? Math.sqrt(out.k * tEnd / (CONST.rinv * well.phi * well.mu * well.ct)) : null;
            out.warnings.push('Skin is not identifiable without φ·ct·rw² (scale mode).');
        }
        return out;
    }

    function tcMatch(phys) {
        var mp = toModelParams(phys);
        return { logPM: Math.log10(1 / mp.A), logTM: Math.log10(mp.B), source: 'physical' };
    }

    return {
        ok: true, mode: mode, kind: 'pressure', modelKey: modelKey,
        keys: keys, spec: spec,
        defaultFrozen: (entry.defaultFrozen || []).slice(),
        refLength: refLength, hasCd: hasCd, hasS: hasS, shapeKeys: shapeKeys.slice(), fixedKeys: catKeys.slice(),
        floatPi: floatPi, simple: simple, pseudo: pseudo,
        coef: coef, qFlow: qFlow, qRef: qRef,
        identifiable: mode === 'scale' ? { S: false } : {},
        well: well, adata: adata, warnings: warnings,
        toModelParams: toModelParams, dp: dp, deriv: deriv, p: p,
        seed: seed, derived: derived, tcMatch: tcMatch
    };
};


// ═══════════════════════════════════════════════════════════════
// SECTION 7 — C4 LASTFIT STORE
// ═══════════════════════════════════════════════════════════════

var FIT_ALIASES = {
    R2: 'r2', RMSE: 'rmse', AIC: 'aic', CI95: 'ci95', model: 'modelKey',
    deltaAIC: 'dAIC', DAIC: 'dAIC', iters: 'iterations', SSR: 'ssr'
};

function _normaliseFit(fit) {
    var f = {}, k;
    for (k in fit) {
        if (!Object.prototype.hasOwnProperty.call(fit, k)) continue;
        if (FIT_ALIASES[k]) continue;
        f[k] = fit[k];
    }
    for (k in fit) {
        if (!Object.prototype.hasOwnProperty.call(fit, k)) continue;
        var nk = FIT_ALIASES[k];
        if (nk && f[nk] === undefined) f[nk] = fit[k];
    }
    return f;
}

G.PRiSM_setLastFit = function PRiSM_setLastFit(fit) {
    if (!fit || typeof fit !== 'object') return null;
    var st = G.PRiSM_state = G.PRiSM_state || {};
    var f = _normaliseFit(fit);
    if (!f.modelKey) f.modelKey = st.model || null;
    if (!f.kind) f.kind = 'pressure';
    if (!f.source) f.source = 'regression';
    if (!_isArr(f.warnings)) f.warnings = [];
    if (f.timestamp == null) f.timestamp = _now();
    if (!f.datasetHash) f.datasetHash = _dsHash(G.PRiSM_dataset);
    // Legacy mirrors so existing readers (Tab 6 results, interpretation) keep working.
    f.model = f.modelKey;
    f.R2 = f.r2; f.RMSE = f.rmse; f.AIC = f.aic; f.CI95 = f.ci95;
    st.lastFit = f;
    if (typeof G.PRiSM_interpretCurrentFit === 'function') {
        try { st.interp = G.PRiSM_interpretCurrentFit(); } catch (e) { /* interpretation is optional */ }
    }
    try { G.PRiSM_saveState(); } catch (e2) { /* storage optional */ }
    _dispatch('prism:fit-updated', { source: f.source, modelKey: f.modelKey });
    return f;
};

G.PRiSM_getLastFit = function PRiSM_getLastFit() {
    var st = G.PRiSM_state;
    if (!st || !st.lastFit || typeof st.lastFit !== 'object') return null;
    var c = _normaliseFit(_clone(st.lastFit) || {});
    c.model = c.modelKey;
    var h = _dsHash(G.PRiSM_dataset);
    c.stale = !!((c.datasetHash && h && c.datasetHash !== h) ||
                 (st.model && c.modelKey && st.model !== c.modelKey));
    if (st.semilog) c.semilog = _clone(st.semilog);
    return c;
};


// ═══════════════════════════════════════════════════════════════
// SECTION 8 — C5 TYPE-CURVE MATCH MATH
// ═══════════════════════════════════════════════════════════════

G.PRiSM_applyTypeCurveMatch = function PRiSM_applyTypeCurveMatch(curve, tc) {
    tc = tc || (G.PRiSM_state && G.PRiSM_state.tcMatch) || {};
    var PMv = Math.pow(10, +tc.logPM), TMv = Math.pow(10, +tc.logTM);
    var out = { t: [], dp: [], deriv: [] };
    if (!curve || !_pos(PMv) || !_pos(TMv)) return out;
    var td = curve.td || curve.t || [];
    var pd = curve.pd || [];
    var pdp = curve.pdPrime || null;
    for (var i = 0; i < td.length; i++) {
        out.t.push(td[i] / TMv);
        out.dp.push(_num(pd[i]) ? pd[i] / PMv : NaN);
        out.deriv.push(pdp && _num(pdp[i]) ? pdp[i] / PMv : NaN);
    }
    return out;
};

G.PRiSM_matchToPhysical = function PRiSM_matchToPhysical(tc, modelKey, params, well, opts) {
    opts = opts || {};
    tc = tc || (G.PRiSM_state && G.PRiSM_state.tcMatch) || {};
    params = params || {};
    well = well || G.PRiSM_getWell();
    var PMv = Math.pow(10, +tc.logPM), TMv = Math.pow(10, +tc.logTM);
    var warnings = [];
    if (!_pos(PMv) || !_pos(TMv)) return { ok: false, reason: 'Type-curve match (logPM, logTM) is not set.', warnings: warnings };
    var pseudo = (opts.pseudo != null) ? !!opts.pseudo : (well.fluid === 'gas');
    var coef = pseudo ? (_pos(well.T_R) ? CONST.gasA * well.T_R : NaN) : CONST.A * well.B * well.mu;
    var miss = [];
    if (!_pos(well.q)) miss.push('q');
    if (!pseudo && !_pos(well.B)) miss.push('B');
    if (!_pos(well.mu)) miss.push('mu');
    if (!_pos(well.h)) miss.push('h');
    if (pseudo && !_pos(well.T_R)) miss.push('T_R');
    if (miss.length) return { ok: false, reason: 'Missing well inputs: ' + miss.join(', '), missing: miss, warnings: warnings };

    var entry = (G.PRiSM_MODELS || {})[modelKey] || {};
    var refLength = (entry.refLength === 'xf' || entry.refLength === 'Lh') ? entry.refLength : 'rw';
    var regKeys = entry.pd ? _registryKeys(entry) : Object.keys(params);
    var kh = coef * well.q * PMv;
    var k = kh / well.h;
    var out = { ok: true, modelKey: modelKey, PM: PMv, TM: TMv, kh: kh, k: k, params: {}, warnings: warnings };
    for (var key in params) if (Object.prototype.hasOwnProperty.call(params, key)) out.params[key] = params[key];
    var hasCd = _num(params.Cd), hasS = _num(params.S);
    out.C = hasCd ? CONST.CfromT * kh * params.Cd / (well.mu * TMv) : null;
    var diffOk = _pos(well.phi) && _pos(well.ct) && _pos(well.mu);
    if (refLength !== 'rw') {
        out[refLength] = diffOk ? Math.sqrt(CONST.B * k / (well.phi * well.mu * well.ct * TMv)) : null;
        out.B_phys = TMv;
        out.Cd = hasCd ? params.Cd : null;
        out.S = hasS ? params.S : null;
        out.consistent = true;
    } else if (diffOk && _pos(well.rw)) {
        var Bp = CONST.B * k / (well.phi * well.mu * well.ct * well.rw * well.rw);
        var ratio = TMv / Bp;
        out.B_phys = Bp;
        out.Cd = hasCd ? params.Cd * Bp / TMv : null;
        out.S = hasS ? params.S + 0.5 * Math.log(ratio) : null;
        if (hasCd) out.params.Cd = out.Cd;
        if (hasS) out.params.S = out.S;
        var pureWbsSkin = regKeys.every(function (rk) { return rk === 'Cd' || rk === 'S' || rk.indexOf('__') === 0; });
        out.consistent = pureWbsSkin || Math.abs(Math.log(ratio)) < 0.01;
        if (!out.consistent) {
            warnings.push('The time match differs from the one implied by k, φ, μ, ct and rw by a factor ' + ratio.toFixed(3) +
                          ': Cd and S were corrected, but the other dimensionless parameters of this model assume the match time scale.');
        }
    } else {
        out.B_phys = null;
        out.Cd = hasCd ? params.Cd : null;
        out.S = hasS ? params.S : null;
        out.consistent = false;
        warnings.push('φ, ct or rw is missing: Cd and S are reported on the match time scale (not corrected).');
    }
    out.phys = { k: out.k, kh: out.kh, C: out.C, Cd: out.Cd, S: out.S };
    if (refLength !== 'rw') out.phys[refLength] = out[refLength];
    return out;
};


// ═══════════════════════════════════════════════════════════════
// SECTION 9 — C8 PERSISTENCE: wts_prism_state
// ═══════════════════════════════════════════════════════════════

var STATE_FIELDS = ['model', 'params', 'paramFreeze', 'phys', 'tcMatch', 'activePlot', 'activePeriod',
                    'bourdetL', 'timeFn', 'lastFit', 'semilog', 'analysisKeyResults'];

G.PRiSM_saveState = function PRiSM_saveState() {
    var st = G.PRiSM_state;
    if (!st) return null;
    var snap = { v: 1, savedAt: _now() };
    for (var i = 0; i < STATE_FIELDS.length; i++) {
        var k = STATE_FIELDS[i];
        if (st[k] !== undefined) snap[k] = _clone(st[k]);
    }
    var P = G.PRiSM;
    if (P) {
        if (P.mode != null) snap.mode = P.mode;
        if (P.tab != null) snap.tab = P.tab;
    }
    var ls = _storage();
    if (ls) {
        try { ls.setItem(STATE_KEY, JSON.stringify(snap)); } catch (e) { /* quota / private mode */ }
    }
    return snap;
};

G.PRiSM_restoreState = function PRiSM_restoreState(obj) {
    var snap = obj;
    if (!snap) {
        var ls = _storage();
        if (!ls) return null;
        try {
            var raw = ls.getItem(STATE_KEY);
            if (!raw) return null;
            snap = JSON.parse(raw);
        } catch (e) { return null; }
    }
    if (!snap || typeof snap !== 'object') return null;
    var st = G.PRiSM_state = G.PRiSM_state || {};
    var reg = G.PRiSM_MODELS || null;
    if (typeof snap.model === 'string' && (!reg || reg[snap.model])) st.model = snap.model;
    if (snap.params && typeof snap.params === 'object') st.params = snap.params;
    if (snap.paramFreeze && typeof snap.paramFreeze === 'object') st.paramFreeze = snap.paramFreeze;
    if (snap.phys && typeof snap.phys === 'object') st.phys = snap.phys;
    if (snap.tcMatch && _num(snap.tcMatch.logPM) && _num(snap.tcMatch.logTM)) st.tcMatch = snap.tcMatch;
    if (typeof snap.activePlot === 'string') st.activePlot = snap.activePlot;
    if (snap.activePeriod === null || _num(snap.activePeriod)) st.activePeriod = snap.activePeriod;
    if (_num(snap.bourdetL)) st.bourdetL = snap.bourdetL;
    if (typeof snap.timeFn === 'string') st.timeFn = snap.timeFn;
    if (snap.lastFit && typeof snap.lastFit === 'object') st.lastFit = snap.lastFit;
    if (snap.semilog && typeof snap.semilog === 'object') st.semilog = snap.semilog;
    if (snap.analysisKeyResults && typeof snap.analysisKeyResults === 'object') st.analysisKeyResults = snap.analysisKeyResults;
    // Legacy field stays neutral: fits never live in st.match.
    st.match = { timeShift: 0, pressShift: 0 };
    if (snap.mode != null || snap.tab != null) {
        if (!G.PRiSM) G.PRiSM = { mode: 'transient', tab: 1, multiRate: [] };
        if (typeof snap.mode === 'string') G.PRiSM.mode = snap.mode;
        if (_num(snap.tab)) G.PRiSM.tab = snap.tab;
    }
    return snap;
};

// Debounced save on the shared events (one-shot timer; no polling).
var _saveTimer = null;
function _scheduleSave() {
    if (typeof setTimeout !== 'function') return;
    if (_saveTimer) { try { clearTimeout(_saveTimer); } catch (e) { /* ignore */ } }
    _saveTimer = setTimeout(function () {
        _saveTimer = null;
        try { G.PRiSM_saveState(); } catch (e) { /* ignore */ }
    }, 300);
}
if (typeof G.addEventListener === 'function' && !G.__PRiSM_ptaCoreListeners) {
    G.__PRiSM_ptaCoreListeners = true;
    ['prism:fit-updated', 'prism:model-changed', 'prism:plot-changed', 'prism:well-changed',
     'prism:tab-open', 'prism:step-changed', 'prism:dataset-loaded'].forEach(function (ev) {
        try { G.addEventListener(ev, _scheduleSave); } catch (e) { /* ignore */ }
    });
}

// Restore on load (04 has already created PRiSM_state).
try { if (G.PRiSM_state || _storage()) G.PRiSM_restoreState(); } catch (e) { /* ignore */ }


// ═══════════════════════════════════════════════════════════════
// SECTION 10 — SELF-TEST
// ═══════════════════════════════════════════════════════════════
// === SELF-TEST ===
(function PRiSM_ptaCoreSelfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
    var checks = [];
    function check(name, ok, info) { checks.push({ name: name, ok: !!ok, info: info }); }
    function near(a, b, tol) { return _num(a) && Math.abs(a - b) <= tol; }

    var saved = { pvt: G.PRiSM_pvt, ds: G.PRiSM_dataset, st: G.PRiSM_state, P: G.PRiSM, reg: G.PRiSM_MODELS };
    try {
        // Conversions (ground-truth constants).
        var W = { q: 850, B: 1.25, mu: 1.1, h: 35, phi: 0.18, ct: 1.2e-5, rw: 0.354 };
        var C = G.PRiSM_convert;
        check('A = 104.78', near(C.A(W, { k: 45 }), 104.78, 0.05), C.A(W, { k: 45 }));
        check('B = 39854', near(C.B(W, { k: 45 }), 39854, 20), C.B(W, { k: 45 }));
        check('Cd(8.48e-4) = 79.98', near(C.Cd(W, { C: 8.48e-4 }), 79.98, 0.1), C.Cd(W, { C: 8.48e-4 }));
        check('rinv(45 md, 120 h) = 1548', near(C.rinv(W, { k: 45, t: 120 }), 1548, 2), C.rinv(W, { k: 45, t: 120 }));

        // Superposition time reduces to Horner for a single-rate buildup.
        var sx = _timeFnValues({ kind: 'superposition', terms: [{ w: -1, off: 24 }, { w: 1, off: 0 }] }, [2]).lnx[0];
        check('sup = ln(Δt/(tp+Δt))', near(sx, Math.log(2 / 26), 1e-12), sx);
        var ag = _timeFnValues({ kind: 'agarwal', tp: 100 }, [0.24, 100]).x;
        check('Agarwal Δte', near(ag[0], 0.2394, 1e-4) && near(ag[1], 50, 1e-9), ag);

        // Match conversion.
        var well = { q: 850, B: 1.25, mu: 1.1, h: 35, phi: 0.18, ct: 1.2e-5, rw: 0.354, fluid: 'oil' };
        G.PRiSM_MODELS = { _st: { pd: function (td) { return td.map(function () { return 1; }); }, paramSpec: [{ key: 'Cd' }, { key: 'S' }] } };
        var m1 = G.PRiSM_matchToPhysical({ logPM: Math.log10(1 / 104.78), logTM: Math.log10(39854) }, '_st', { Cd: 80, S: 2.5 }, well);
        check('matchToPhysical k/C/S', near(m1.k, 45, 0.1) && near(m1.C / 8.48e-4, 1, 0.01) && near(m1.S, 2.5, 0.01), [m1.k, m1.C, m1.S]);
        var m2 = G.PRiSM_matchToPhysical({ logPM: Math.log10(1 / 104.78), logTM: Math.log10(39854) + 1 }, '_st',
                                         { Cd: 800, S: 2.5 - 0.5 * Math.LN10 }, well);
        check('matchToPhysical degeneracy', near(m2.k, 45, 0.1) && near(m2.C / 8.48e-4, 1, 0.01) && near(m2.S, 2.5, 0.01) && near(m2.Cd, 80, 0.2), [m2.Cd, m2.S]);

        // Analysis data on a synthetic line-source drawdown (no registry needed).
        var t = [], p = [], q = [];
        for (var i = 0; i < 40; i++) {
            var tt = Math.pow(10, -1 + i * 3 / 39);
            t.push(tt); p.push(4200 - 104.78 * 0.5 * (Math.log(39854 * tt) + LN_EULER + 5)); q.push(850);
        }
        G.PRiSM_state = { model: '_st' };
        G.PRiSM = { multiRate: [] };
        G.PRiSM_pvt = { fluidType: 'oil', p_res: 4200, provenance: { p_res: 'sample' }, testType: 'auto',
                        q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, T_res: 180, _computed: { timestamp: 1 } };
        var ad = G.PRiSM_getAnalysisData({ t: t, p: p, q: q });
        check('adata ok / pRef pi / drawdown', ad.ok && ad.pRefSource === 'pi' && ad.testType === 'drawdown' && ad.n === 40, ad.reason);
        var dmed = _median(ad.deriv.slice(10));
        check('radial derivative = 52.39', near(dmed, 52.39, 0.05), dmed);
        G.PRiSM_pvt.provenance = {};
        var ad2 = G.PRiSM_getAnalysisData({ t: t, p: p, q: q });
        check('no pi → estimated pRef + skin warning',
              (ad2.pRefSource === 'extrapolated' || ad2.pRefSource === 'first-sample') &&
              ad2.warnings.join(' ').indexOf('skin') >= 0, ad2.pRefSource);

        // lastFit aliases.
        var f = G.PRiSM_setLastFit({ R2: 0.9, RMSE: 1, AIC: 3, modelKey: 'x' });
        var g = G.PRiSM_getLastFit();
        check('lastFit aliases', f && g && g.r2 === 0.9 && g.rmse === 1 && g.aic === 3 && g.model === 'x', g);
    } catch (e) {
        check('self-test threw', false, e && e.message);
    } finally {
        G.PRiSM_pvt = saved.pvt; G.PRiSM_dataset = saved.ds; G.PRiSM_state = saved.st;
        G.PRiSM = saved.P; G.PRiSM_MODELS = saved.reg;
    }
    var fails = checks.filter(function (c) { return !c.ok; });
    if (fails.length) err('PRiSM PTA-core self-test FAILED:', fails);
    else log('✓ PRiSM PTA-core self-test passed (' + checks.length + ' checks).');
    G.PRiSM_ptaCoreSelfTestResults = checks;
})();

})();
