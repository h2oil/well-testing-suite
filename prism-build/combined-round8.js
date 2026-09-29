
// ═══════════════════════════════════════════════════════════════════════
// PRiSM Round-8 (gap closure) — auto-injected from prism-build/
//   • 33-pta-core          (Well & Test store, analysis data, physical model, lastFit, persistence)
//   • 34-semilog-skin      (MDH / Horner / superposition semilog + skin)
//   • 35-rta-dca           (decline results + rate-transient analysis)
//   • 36-report            (Tab 7 report + CSV export)
//   • 37-prism-workflow    (workflow shell content: flow periods, rail, tools)
//   • 39-prism-fieldtools  (gauge register, sequence of events, ct builder)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 33-pta-core ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
                    'bourdetL', 'timeFn', 'lastFit', 'semilog', 'analysisKeyResults', 'fieldTools'];

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
    // Gauge register, sequence of events, ct builder (39-prism-fieldtools.js).
    if (snap.fieldTools && typeof snap.fieldTools === 'object') st.fieldTools = snap.fieldTools;
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

})();

// ─── END 33-pta-core ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 34-semilog-skin ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM — 34-semilog-skin.js  (Round 8)
// Straight-line (semilog) analysis and skin deliverables
// =============================================================================
//
// What this file provides
//   window.PRiSM_semilogAnalysis(adata?, well?, opts?) → result (also st.semilog)
//       MDH (drawdown / injection), Horner (single-rate build-up / fall-off),
//       superposition (multi-rate) and Agarwal equivalent-time straight lines.
//       Auto IARF window from the derivative, m, kh, k, p1hr, p*, S, log-log
//       cross-check, unit-slope C / CD, IARF-start check, rinv.
//   window.PRiSM_skinSummary(o)        → ΔpS, FE, DR, J, J_ideal, rw′, CD·e^2S
//   window.PRiSM_skinDecomposition(o)  → S_pp, S_θ, S_f, D·q, S_mech
//   window.PRiSM_rateDependentSkin(rows) → least-squares S′ = S + D·q
//   window.PRiSM_renderSemilogPanel(hostEl)  (Tab 2 panel, C7)
//   window.PRiSM_semilogPlotLine(plotKey)    → C6 line object for mdh / horner
//   window.PRiSM_semilog_plot_mdh(canvas, data, opts)  (delegates to
//       window.PRiSM_plot_mdh when the plot layer provides it)
//   window.PRiSM_semilog = { helpers used by tests and other layers }
//
// Contracts used (all optional — local fallbacks keep this file standalone):
//   C1 PRiSM_getWell, C2 PRiSM_getAnalysisData, C6 canvas._prismAxes,
//   C7 PRiSM_registerTabPanel / PRiSM_tabPanels / PRiSM_postDrawHooks /
//   PRiSM_PLOT_REGISTRY, pseudo-skin library PRiSM_pseudoSkin.
//
// Units: field units. Δt in hours, p in psia, q in STB/d (oil / water) or
// Mscf/d (gas), B in RB/STB (or RB/Mscf), μ in cp, ct in 1/psi, h, rw in ft.
//
// Equations (field units)
//   Superposition time for analysed period n (steps i = 1..n start at T_i,
//   rate q_i, q_0 = 0):
//     X(Δt) = Σ_i (q_i − q_{i−1})/(q_n − q_{n−1}) · log10(T_n − T_i + Δt)
//   n = 1 gives MDH (X = log10 Δt); single-rate build-up gives
//   X = −log10((tp+Δt)/Δt) (Horner).
//   Line on the window: Δp = a + s·X.   |m| = |s| psi/cycle.
//   kh = 162.6·|Δq_n|·B·μ/|m|    (gas Δm(p): kh = 1637·|Δq_n|·T/|m|)
//   K  = a/s + W,  W = Σ_{i<n} (Δq_i/Δq_n)·log10(T_n − T_i)   (Δp from the
//        pressure at the start of the period)
//   K  = a·Δq_n/(s·q_n)                                         (Δp from pi)
//   S  = 1.1513·[K − log10(k/(φ μ ct rw²)) + 3.2275]
//   For MDH this is S = 1.1513[(pi − p1hr)/|m| − log10(k/(φμct rw²)) + 3.2275];
//   for Horner S = 1.1513[(p1hr − pwf0)/|m| − log10(k/(φμct rw²)) + 3.2275
//   + log10((tp+1)/tp)].
//   Log-log check: kh = 70.6·q·B·μ/Δp′_r,
//   S_ll = 0.5·[Δp/Δp′_r − ln(0.0002637·k·t/(φμct rw²)) − 0.80907].
//   Unit slope: C = q·B·Δt/(24·Δp), CD = 0.8936·C/(φ·ct·h·rw²).
//   IARF start ≈ (200000 + 12000·S)·C·μ/kh  hours.
//   rinv = √(k·t/(948·φ·μ·ct)).
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var HAS_DOC = (typeof document !== 'undefined') && document && typeof document.createElement === 'function';

    var LN10 = Math.LN10;

    // Default-sample metadata (C1). WP8 defines window.PRiSM_DEFAULT_SAMPLE_META;
    // this copy is used only when that is absent.
    var SAMPLE_META_FALLBACK = {
        pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5,
        h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil'
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — SMALL NUMERIC HELPERS
    // ═══════════════════════════════════════════════════════════════

    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function pos(v) { return isNum(v) && v > 0; }
    function firstNum() {
        for (var i = 0; i < arguments.length; i++) {
            var v = arguments[i];
            if (typeof v === 'string' && v.trim() !== '') v = parseFloat(v);
            if (isNum(v)) return v;
        }
        return null;
    }
    function median(arr) {
        var a = [];
        for (var i = 0; i < arr.length; i++) if (isNum(arr[i])) a.push(arr[i]);
        if (!a.length) return NaN;
        a.sort(function (x, y) { return x - y; });
        var m = a.length >> 1;
        return (a.length % 2) ? a[m] : 0.5 * (a[m - 1] + a[m]);
    }
    function toArr(v) {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        try { return Array.prototype.slice.call(v); } catch (e) { return []; }
    }

    // Ordinary least squares y = a + b·x (centred for numerical stability).
    function linfit(xs, ys) {
        var n = 0, mx = 0, my = 0, i;
        for (i = 0; i < xs.length; i++) {
            if (!isNum(xs[i]) || !isNum(ys[i])) continue;
            n++; mx += xs[i]; my += ys[i];
        }
        if (n < 2) return { ok: false, n: n };
        mx /= n; my /= n;
        var sxx = 0, sxy = 0, syy = 0;
        for (i = 0; i < xs.length; i++) {
            if (!isNum(xs[i]) || !isNum(ys[i])) continue;
            var dx = xs[i] - mx, dy = ys[i] - my;
            sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
        }
        if (!(sxx > 0)) return { ok: false, n: n };
        var b = sxy / sxx, a = my - b * mx;
        var sse = 0;
        for (i = 0; i < xs.length; i++) {
            if (!isNum(xs[i]) || !isNum(ys[i])) continue;
            var r = ys[i] - (a + b * xs[i]);
            sse += r * r;
        }
        var r2 = syy > 0 ? 1 - sse / syy : 1;
        var seB = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : NaN;
        return { ok: true, a: a, b: b, r2: r2, n: n, sse: sse, seSlope: seB };
    }

    // Bourdet derivative d(y)/d(ln x) with smoothing window L (natural-log
    // units); one-sided differences at the ends so the last point is usable.
    function bourdet(x, y, L) {
        var n = x.length, d = new Array(n), i;
        L = isNum(L) && L > 0 ? L : 0;
        var lx = new Array(n);
        for (i = 0; i < n; i++) lx[i] = x[i] > 0 ? Math.log(x[i]) : NaN;
        for (i = 0; i < n; i++) {
            d[i] = NaN;
            if (!isNum(lx[i]) || !isNum(y[i])) continue;
            // Nearest neighbours at least L (and strictly > 0) away in ln x.
            var i1 = i - 1, i2 = i + 1;
            while (i1 >= 0 && !(isNum(lx[i1]) && lx[i] - lx[i1] > 0 && lx[i] - lx[i1] >= L)) i1--;
            while (i2 < n && !(isNum(lx[i2]) && lx[i2] - lx[i] > 0 && lx[i2] - lx[i] >= L)) i2++;
            var hasL = i1 >= 0 && isNum(y[i1]), hasR = i2 < n && isNum(y[i2]);
            if (hasL && hasR) {
                var dl1 = lx[i] - lx[i1], dl2 = lx[i2] - lx[i], dlT = dl1 + dl2;
                d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
            } else if (hasL) {
                d[i] = (y[i] - y[i1]) / (lx[i] - lx[i1]);
            } else if (hasR) {
                d[i] = (y[i2] - y[i]) / (lx[i2] - lx[i]);
            }
        }
        return d;
    }

    // Local log-log slope of v against x: LS of ln v vs ln x over the points
    // within ±hw (ln units) of each point. NaN where fewer than 3 points.
    function localLogSlope(x, v, hw) {
        var n = x.length, out = new Array(n), lx = [], lv = [], i, j;
        for (i = 0; i < n; i++) {
            lx.push(x[i] > 0 ? Math.log(x[i]) : NaN);
            lv.push(v[i] > 0 ? Math.log(v[i]) : NaN);
        }
        for (i = 0; i < n; i++) {
            out[i] = NaN;
            if (!isNum(lx[i]) || !isNum(lv[i])) continue;
            var xs = [], ys = [];
            for (j = i; j >= 0 && (!isNum(lx[j]) || lx[i] - lx[j] <= hw); j--) {
                if (isNum(lx[j]) && isNum(lv[j])) { xs.push(lx[j]); ys.push(lv[j]); }
            }
            for (j = i + 1; j < n && (!isNum(lx[j]) || lx[j] - lx[i] <= hw); j++) {
                if (isNum(lx[j]) && isNum(lv[j])) { xs.push(lx[j]); ys.push(lv[j]); }
            }
            if (xs.length < 3) continue;
            var f = linfit(xs, ys);
            if (f.ok) out[i] = f.b;
        }
        return out;
    }

    function dsHash(ds) {
        if (!ds || !ds.t || !ds.p) return '';
        var t = toArr(ds.t), p = toArr(ds.p), n = t.length, s = 0;
        for (var i = 0; i < n; i++) if (isNum(p[i])) s += p[i] * ((i % 7) + 1);
        return n + ':' + t[0] + ':' + t[n - 1] + ':' + p[0] + ':' + p[n - 1] + ':' + s.toFixed(3);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — WELL + ANALYSIS DATA (C1 / C2 with local fallbacks)
    // ═══════════════════════════════════════════════════════════════

    function _isDefaultSample(ds) {
        var csv = G.PRiSM_DEFAULT_SAMPLE_CSV;
        if (!ds || !ds.t || !ds.p || typeof csv !== 'string') return false;
        var lines = csv.trim().split(/\r?\n/), rows = [];
        for (var i = 1; i < lines.length; i++) {
            var c = lines[i].split(',');
            var tt = parseFloat(c[0]), pp = parseFloat(c[1]);
            if (isNum(tt) && isNum(pp)) rows.push([tt, pp]);
        }
        var t = toArr(ds.t), p = toArr(ds.p);
        if (t.length !== rows.length) return false;
        for (var k = 0; k < rows.length; k++) {
            if (Math.abs(t[k] - rows[k][0]) > 1e-9 || Math.abs(p[k] - rows[k][1]) > 1e-6) return false;
        }
        return true;
    }

    function _lastNonZero(q) {
        q = toArr(q);
        for (var i = q.length - 1; i >= 0; i--) if (isNum(q[i]) && q[i] !== 0) return q[i];
        return null;
    }

    // Local well reader used only when window.PRiSM_getWell (C1, WP1) is absent.
    function localWell(ds) {
        var pvt = G.PRiSM_pvt || {};
        var c = pvt._computed || {};
        if ((c.B == null || c.mu == null || c.ct == null) && typeof G.PRiSM_pvt_compute === 'function') {
            try { var cc = G.PRiSM_pvt_compute(); if (cc && typeof cc === 'object') c = cc; } catch (e) { /* ignore */ }
        }
        var fluid = pvt.fluidType || 'oil';
        var w = {
            fluid: fluid,
            q: firstNum(_lastNonZero(ds && ds.q), pvt.q),
            B: fluid === 'gas' ? firstNum(pvt.Bg, c.Bg, c.B) : (fluid === 'water' ? firstNum(pvt.Bw, 1) : firstNum(pvt.Bo, c.Bo, c.B)),
            mu: fluid === 'gas' ? firstNum(pvt.mu_g, c.mu_g, c.mu) : (fluid === 'water' ? firstNum(pvt.mu_w, c.mu) : firstNum(pvt.mu_o, c.mu_o, c.mu)),
            ct: firstNum(pvt.ct, c.ct),
            h: firstNum(pvt.h), phi: firstNum(pvt.phi), rw: firstNum(pvt.rw),
            pi: null,
            T_R: isNum(pvt.T_res) ? pvt.T_res + 459.67 : null,
            testType: pvt.testType || 'auto',
            tp: firstNum(pvt.tp), tShut: firstNum(pvt.tShut), pwf0: firstNum(pvt.pwf0),
            defaulted: [], missing: [], source: 'local'
        };
        var prov = pvt.provenance && pvt.provenance.p_res;
        if (prov === 'user' || prov === 'sample' || prov === 'deconvolution') w.pi = firstNum(pvt.p_res);
        if (_isDefaultSample(ds)) {
            var M = G.PRiSM_DEFAULT_SAMPLE_META || SAMPLE_META_FALLBACK;
            w.pi = M.pi; w.testType = M.testType || 'drawdown'; w.q = M.q; w.B = M.Bo; w.mu = M.mu_o;
            w.ct = M.ct; w.h = M.h; w.phi = M.phi; w.rw = M.rw; w.fluid = M.fluidType || 'oil';
            w.source = 'sample';
        }
        ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'].forEach(function (k) { if (!pos(w[k])) w.missing.push(k); });
        w.complete = w.missing.length === 0;
        return w;
    }

    function getWell(ds) {
        if (typeof G.PRiSM_getWell === 'function') {
            try {
                var w = G.PRiSM_getWell(ds);
                if (w && typeof w === 'object') return w;
            } catch (e) { /* fall through */ }
        }
        return localWell(ds);
    }

    // Rate steps from a q column: [{t0, q}] merging changes < 1 % relative.
    function _stepsFromRates(t, q) {
        var steps = [];
        for (var i = 0; i < t.length; i++) {
            if (!isNum(q[i]) || !isNum(t[i])) continue;
            var last = steps[steps.length - 1];
            if (last) {
                var ref = Math.max(Math.abs(last.q), Math.abs(q[i]));
                if (ref === 0 || Math.abs(q[i] - last.q) <= 0.01 * ref) continue;
            }
            steps.push({ t0: steps.length ? t[i] : Math.min(0, t[i]), q: q[i], idx: i });
        }
        return steps;
    }

    function _interp(t, p, tx) {
        for (var i = 1; i < t.length; i++) {
            if (t[i] >= tx) {
                var f = (tx - t[i - 1]) / ((t[i] - t[i - 1]) || 1);
                return p[i - 1] + f * (p[i] - p[i - 1]);
            }
        }
        return p[p.length - 1];
    }

    // Local analysis-data builder used only when PRiSM_getAnalysisData (C2) is
    // absent. Handles single drawdown / injection, and a single build-up or
    // fall-off following one or more flow steps in the q column.
    function localAnalysisData(ds, well, opts) {
        opts = opts || {};
        well = well || {};
        var out = { ok: false, reason: '', warnings: [], source: 'local' };
        if (!ds || !ds.t || !ds.p) { out.reason = 'No data loaded'; return out; }
        var T = toArr(ds.t), P = toArr(ds.p), Q = toArr(ds.q);
        var t = [], p = [], q = [];
        for (var i = 0; i < T.length; i++) {
            if (isNum(T[i]) && isNum(P[i])) { t.push(T[i]); p.push(P[i]); q.push(isNum(Q[i]) ? Q[i] : NaN); }
        }
        if (t.length < 3) { out.reason = 'Need at least 3 data points'; return out; }
        var hasQ = q.some(isNum);
        var steps = hasQ ? _stepsFromRates(t, q) : [];
        var testType = (well.testType && well.testType !== 'auto') ? well.testType : null;
        var tShut = isNum(well.tShut) ? well.tShut : null;
        var shutIdx = -1;
        // Detect a shut-in: first zero-rate sample after a flowing sample.
        if (hasQ) {
            for (var k = 1; k < q.length; k++) {
                if (q[k] === 0 && isNum(q[k - 1]) && q[k - 1] !== 0) { shutIdx = k; break; }
            }
        }
        if (!testType) {
            if (shutIdx > 0) testType = (q[shutIdx - 1] < 0) ? 'falloff' : 'buildup';
            else if (hasQ && q.every(function (v) { return !isNum(v) || v <= 0; }) && q.some(function (v) { return v < 0; })) testType = 'injection';
            else testType = (p[p.length - 1] - p[0]) >= 0 ? 'buildup' : 'drawdown';   // CLAUDE.md sign rule
        }
        var isShut = (testType === 'buildup' || testType === 'falloff');
        out.testType = testType;
        out.fluid = well.fluid || 'oil';

        if (!isShut) {
            var pRef = null, src = null;
            if (isNum(well.pi)) { pRef = well.pi; src = 'pi'; }
            else {
                for (var r = 0; r < t.length; r++) if (t[r] <= 0) { pRef = p[r]; src = 't0-row'; }
                if (pRef == null) { pRef = p[0]; src = 'first-sample'; }
            }
            var sgn = (testType === 'injection') ? 1 : -1;       // Δp = sgn·(p − pRef)
            out.t = []; out.tAbs = []; out.p = []; out.dp = [];
            for (var a = 0; a < t.length; a++) {
                if (!(t[a] > 0)) continue;
                out.t.push(t[a]); out.tAbs.push(t[a]); out.p.push(p[a]); out.dp.push(sgn * (p[a] - pRef));
            }
            out.pRef = pRef; out.pRefSource = src; out.sign = sgn;
            out.tStart = 0; out.tShut = null; out.tp = null;
            out.qRef = firstNum(_lastNonZero(q), well.q);
            var flowSteps = steps.filter(function (s) { return s.q !== 0; });
            out.rateHistory = flowSteps.map(function (s) { return { t: s.t0, q: s.q }; });
            if (flowSteps.length > 1) {
                out.tStart = flowSteps[flowSteps.length - 1].t0;
                out.qRef = flowSteps[flowSteps.length - 1].q;
            }
            if (src === 'first-sample') out.warnings.push('Initial pressure pi not set: Δp is measured from the first sample, so skin is biased.');
        } else {
            var ts = tShut;
            if (ts == null && shutIdx > 0) ts = t[shutIdx - 1];
            var pw = isNum(well.pwf0) ? well.pwf0 : null, pwSrc = 'pwf0';
            if (ts == null) {
                // No rate information: treat t as Δt measured from shut-in.
                ts = 0;
                if (pw == null) {
                    var z = -1;
                    for (var zz = 0; zz < t.length; zz++) if (t[zz] <= 0) z = zz;
                    if (z >= 0) { pw = p[z]; pwSrc = 't0-row'; }
                    else { pw = p[0]; pwSrc = 'first-sample'; out.warnings.push('Shut-in pressure pwf(Δt=0) not set: the first sample is used, so skin is biased.'); }
                }
            } else if (pw == null) { pw = _interp(t, p, ts); pwSrc = 'interp-tShut'; }
            var sg2 = (testType === 'buildup') ? 1 : -1;
            out.t = []; out.tAbs = []; out.p = []; out.dp = [];
            for (var b = 0; b < t.length; b++) {
                var dtb = t[b] - ts;
                if (!(dtb > 0)) continue;
                out.t.push(dtb); out.tAbs.push(t[b]); out.p.push(p[b]); out.dp.push(sg2 * (p[b] - pw));
            }
            out.pRef = pw; out.pRefSource = pwSrc; out.sign = sg2;
            out.tShut = ts; out.tStart = ts;
            // Rate history before shut-in (steps with t0 < tShut).
            var prior = steps.filter(function (s) { return s.t0 < ts - 1e-12; });
            var qLast = prior.length ? prior[prior.length - 1].q : null;
            out.qRef = firstNum(qLast, well.q);
            var tp = isNum(well.tp) ? well.tp : null;
            if (tp == null && prior.length && isNum(qLast) && qLast !== 0) {
                // tp = Np / q_last  (Horner-equivalent producing time)
                var Np = 0;
                for (var s = 0; s < prior.length; s++) {
                    var tEnd = (s + 1 < prior.length) ? prior[s + 1].t0 : ts;
                    Np += prior[s].q * (tEnd - prior[s].t0);
                }
                tp = Np / qLast;
            }
            out.tp = tp;
            out.rateHistory = prior.map(function (s) { return { t: s.t0, q: s.q }; }).concat([{ t: ts, q: 0 }]);
        }
        out.n = out.t.length;
        out.ok = out.n >= 3;
        if (!out.ok) out.reason = 'Fewer than 3 points after the analysis start';
        out.timeFn = 'dt';
        out.L = isNum(opts.L) ? opts.L : 0.1;
        return out;
    }

    function getAnalysisData(ds, well, opts) {
        opts = opts || {};
        if (typeof G.PRiSM_getAnalysisData === 'function' && !opts.forceLocal) {
            try {
                var st = G.PRiSM_state || {};
                var o = { period: st.activePeriod, timeFn: 'auto' };
                if (isNum(opts.tmin)) o.tmin = opts.tmin;
                if (isNum(opts.tmax)) o.tmax = opts.tmax;
                var a = G.PRiSM_getAnalysisData(ds, o);
                if (a && a.ok) return a;
                if (a && !a.ok) return a;
            } catch (e) { /* fall through */ }
        }
        return localAnalysisData(ds, well, opts);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — RATE STEPS FOR THE ANALYSED PERIOD
    // ═══════════════════════════════════════════════════════════════
    // Returns { steps:[{T, q}], n } in PRODUCTION sign convention where the
    // last step is the analysed period (T = its start, absolute hours).

    function _steps(adata, method, testType) {
        var qRef = firstNum(adata.qRef);
        var tp = firstNum(adata.tp);
        var isShut = (testType === 'buildup' || testType === 'falloff');
        var inj = (testType === 'injection' || testType === 'falloff');
        var qSign = inj ? -1 : 1;              // injection rates → negative production
        var qAbs = isNum(qRef) ? Math.abs(qRef) : null;
        if (method === 'mdh') {
            return [{ T: 0, q: qSign * (qAbs || 1) }];
        }
        if (method === 'horner' || method === 'agarwal') {
            if (!isNum(tp) || tp <= 0) return null;
            return [{ T: 0, q: qSign * (qAbs || 1) }, { T: tp, q: 0 }];
        }
        // superposition — build from periods / rateHistory
        var raw = [];
        var per = toArr(adata.periods);
        // periods carry explicit start times (t0, hours); start/end may be
        // row indices, so they are not used as times.
        if (per.length && per.every(function (x) { return x && isNum(x.t0) && isNum(x.q); })) {
            per.forEach(function (x) { raw.push({ T: x.t0, q: x.q }); });
        } else {
            toArr(adata.rateHistory).forEach(function (x) {
                if (x && isNum(x.t) && isNum(x.q)) raw.push({ T: x.t, q: x.q });
            });
        }
        raw.sort(function (a, b) { return a.T - b.T; });
        var tStart = firstNum(adata.tStart, adata.tShut, 0);
        var steps = [];
        for (var i = 0; i < raw.length; i++) {
            if (raw[i].T > tStart + 1e-9) break;
            var last = steps[steps.length - 1];
            if (last && Math.abs(last.q - raw[i].q) <= 0.01 * Math.max(Math.abs(last.q), Math.abs(raw[i].q))) continue;
            steps.push({ T: raw[i].T, q: raw[i].q });
        }
        // Leading zero-rate steps carry no information (q_0 = 0 already).
        while (steps.length && steps[0].q === 0) steps.shift();
        if (!steps.length) return null;
        if (Math.abs(steps[steps.length - 1].T - tStart) > 1e-6) {
            // The analysed period did not appear as its own step: add it.
            var qn = isShut ? 0 : (isNum(qRef) ? qRef : steps[steps.length - 1].q);
            steps.push({ T: tStart, q: qn });
        }
        // Injection sign: if all flowing rates are positive but the test is an
        // injection / fall-off, flip them to the production convention.
        if (inj && steps.every(function (s) { return s.q >= 0; })) {
            steps = steps.map(function (s) { return { T: s.T, q: -s.q }; });
        }
        return steps;
    }

    // Superposition X for Δt (hours) and W constant (see header).
    function supX(steps, dt) {
        var n = steps.length, Tn = steps[n - 1].T;
        var dqn = steps[n - 1].q - (n > 1 ? steps[n - 2].q : 0);
        if (dqn === 0) return NaN;
        var x = 0;
        for (var i = 0; i < n; i++) {
            var dq = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
            var arg = Tn - steps[i].T + dt;
            if (!(arg > 0)) return NaN;
            x += dq / dqn * Math.log10(arg);
        }
        return x;
    }
    function supW(steps) {
        var n = steps.length, Tn = steps[n - 1].T;
        var dqn = steps[n - 1].q - (n > 1 ? steps[n - 2].q : 0);
        var w = 0;
        for (var i = 0; i < n - 1; i++) {
            var dq = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
            w += dq / dqn * Math.log10(Tn - steps[i].T);
        }
        return w;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — IARF WINDOW
    // ═══════════════════════════════════════════════════════════════
    // Longest contiguous run (in log cycles of x) where |d ln Δp′/d ln x| < 0.1
    // and every Δp′ is within ±10 % of the run median; ≥ 5 points and
    // ≥ 0.5 log cycle. Returns {found, i0, i1} (indices into the arrays).

    function findIARFWindow(x, deriv, o) {
        o = o || {};
        var slopeTol = isNum(o.slopeTol) ? o.slopeTol : 0.1;
        var bandTol = isNum(o.bandTol) ? o.bandTol : 0.10;
        var minPts = o.minPts || 5, minCycles = isNum(o.minCycles) ? o.minCycles : 0.5;
        var n = x.length;
        var sl = localLogSlope(x, deriv, isNum(o.halfWindow) ? o.halfWindow : 0.35);
        var okp = new Array(n);
        for (var i = 0; i < n; i++) okp[i] = x[i] > 0 && deriv[i] > 0 && isNum(sl[i]) && Math.abs(sl[i]) < slopeTol;
        var best = null;
        var a = 0;
        while (a < n) {
            if (!okp[a]) { a++; continue; }
            var b = a;
            while (b + 1 < n && okp[b + 1]) b++;
            // Two-pointer band search within [a, b].
            var sorted = [], l = a;
            for (var r = a; r <= b; r++) {
                _sortedInsert(sorted, deriv[r]);
                while (sorted.length) {
                    var med = _sortedMedian(sorted);
                    if (sorted[0] >= (1 - bandTol) * med && sorted[sorted.length - 1] <= (1 + bandTol) * med) break;
                    _sortedRemove(sorted, deriv[l]); l++;
                }
                var cnt = r - l + 1;
                var cyc = Math.log10(x[r] / x[l]);
                if (cnt >= minPts && cyc >= minCycles - 1e-12) {
                    if (!best || cyc > best.cycles + 1e-12) best = { i0: l, i1: r, cycles: cyc, n: cnt };
                }
            }
            a = b + 1;
        }
        if (!best) return { found: false };
        best.found = true;
        // Refinement. The tail of the storage / skin hump decays slowly (≈ 1/t)
        // and stays inside the ±10 % band for a log cycle or more, which biases
        // m high and S low. The plateau is the median of the later half of the
        // run (in log time). The start moves past the last point in the early
        // half that still sits on the hump side of the plateau by more than
        // max(0.5 %, 1.5 × the plateau scatter). The end drops trailing points
        // more than 3 % off the plateau (end effects, boundary onset). The
        // window always keeps ≥ minPts points and ≥ minCycles log cycles.
        if (o.refine !== false) {
            var lxa = Math.log(x[best.i0]), lxb = Math.log(x[best.i1]), lmid = 0.5 * (lxa + lxb);
            var late = [], early = [], k2, midIdx = best.i0;
            for (k2 = best.i0; k2 <= best.i1; k2++) {
                if (Math.log(x[k2]) >= lmid) late.push(deriv[k2]); else { early.push(deriv[k2]); midIdx = k2; }
            }
            var plateau = median(late.length >= 3 ? late : deriv.slice(best.i0, best.i1 + 1));
            var dev = late.map(function (v) { return v / plateau - 1; });
            var mdev = median(dev);
            var noise = 1.4826 * median(dev.map(function (v) { return Math.abs(v - mdev); }));
            var tolS = Math.min(0.03, Math.max(isNum(o.startTol) ? o.startTol : 0.005, 1.5 * (isNum(noise) ? noise : 0)));
            var eMed = median(early.slice(0, Math.max(1, Math.ceil(early.length / 2))));
            var eSign = isNum(eMed) ? (eMed >= plateau ? 1 : -1) : 1;
            var i0 = best.i0, i1 = best.i1;
            var canKeep = function (n0, n1) { return n1 - n0 + 1 >= minPts && Math.log10(x[n1] / x[n0]) >= minCycles - 1e-12; };
            var newStart = i0;
            for (k2 = best.i0; k2 <= midIdx; k2++) if (eSign * (deriv[k2] / plateau - 1) > tolS) newStart = k2 + 1;
            while (newStart > i0 && !canKeep(newStart, i1)) newStart--;
            i0 = newStart;
            while (Math.abs(deriv[i1] / plateau - 1) > 0.03 && canKeep(i0, i1 - 1)) i1--;
            best.trimmed = (i0 !== best.i0 || i1 !== best.i1);
            best.run = { i0: best.i0, i1: best.i1 };
            best.i0 = i0; best.i1 = i1; best.n = i1 - i0 + 1;
            best.cycles = Math.log10(x[i1] / x[i0]);
            best.plateau = plateau; best.startTol = tolS;
        }
        return best;
    }
    function _sortedInsert(arr, v) {
        var lo = 0, hi = arr.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
        arr.splice(lo, 0, v);
    }
    function _sortedRemove(arr, v) {
        var lo = 0, hi = arr.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
        if (lo < arr.length && arr[lo] === v) arr.splice(lo, 1);
    }
    function _sortedMedian(arr) {
        var m = arr.length >> 1;
        return (arr.length % 2) ? arr[m] : 0.5 * (arr[m - 1] + arr[m]);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — SKIN SUMMARY / DECOMPOSITION / RATE-DEPENDENT SKIN
    // ═══════════════════════════════════════════════════════════════

    function skinSummary(o) {
        o = o || {};
        var r = { ok: false, warnings: [] };
        var S = firstNum(o.S), kh = firstNum(o.kh), m = firstNum(o.m);
        var q = firstNum(o.q), B = firstNum(o.B), mu = firstNum(o.mu);
        if (!isNum(S)) { r.warnings.push('Skin not available'); return r; }
        q = isNum(q) ? Math.abs(q) : q;
        var dpS = NaN;
        if (pos(kh) && pos(q) && pos(B) && pos(mu)) dpS = 141.2 * q * B * mu * S / kh;
        else if (pos(Math.abs(m || 0))) dpS = 0.8686 * Math.abs(m) * S;
        r.dpS = dpS;
        if (isNum(o.rw) && o.rw > 0) r.rwEff = o.rw * Math.exp(-S);
        if (pos(o.CD)) r.CDe2S = o.CD * Math.exp(2 * S);
        var pbar = firstNum(o.pbar), pwf = firstNum(o.pwf);
        if (isNum(pbar) && isNum(pwf)) {
            var dd = Math.abs(pbar - pwf);
            if (dd > 0) {
                r.drawdown = dd;
                if (isNum(dpS)) {
                    r.FE = (dd - dpS) / dd;
                    r.DR = r.FE !== 0 ? 1 / r.FE : NaN;
                }
                if (pos(q)) {
                    r.J = q / dd;
                    if (isNum(dpS) && dd - dpS > 0) r.J_ideal = q / (dd - dpS);
                }
            }
        } else r.warnings.push('Average / initial pressure or flowing pressure unknown: FE, DR and J not computed');
        r.ok = isNum(dpS);
        return r;
    }

    // Local pseudo-skin fallbacks (used when window.PRiSM_pseudoSkin is absent).
    function _bronsMarting(b, hD) {
        if (!(b > 0) || b > 1 || !(hD > 0)) return 0;
        if (b >= 1) return 0;
        var Gb = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;
        return (1 / b - 1) * (Math.log(hD) - Gb);
    }
    function _cincoLey(thetaDeg, kvkh, hD) {
        if (!isNum(thetaDeg) || thetaDeg === 0) return 0;
        var an = isNum(kvkh) && kvkh > 0 ? Math.sqrt(kvkh) : 1;
        var thp = Math.atan(an * Math.tan(thetaDeg * Math.PI / 180)) * 180 / Math.PI;
        var hd = hD > 0 ? hD : 100;
        return -Math.pow(thp / 41, 2.06) - Math.pow(thp / 56, 1.865) * Math.log10(hd / 100);
    }
    function _fracSkin(xf, rw) {
        if (!(xf > 0) || !(rw > 0)) return 0;
        return -Math.log(xf / (2 * rw));     // infinite-conductivity: rw′ = xf/2
    }

    function skinDecomposition(o) {
        o = o || {};
        var params = o.params || {};
        var geom = o.geom || {};
        var lib = G.PRiSM_pseudoSkin || {};
        var S_total = firstNum(o.S_total);
        var h = firstNum(geom.h), rw = firstNum(geom.rw);
        var kvkh = firstNum(geom.kvkh, params.KvKh, params.kvkh, 1);
        var b = null;
        if (pos(geom.hp) && pos(h)) b = geom.hp / h;
        if (b == null) b = firstNum(geom.b, params.hp_to_h, params.b);
        var theta = firstNum(geom.theta, params.theta_deg, params.theta);
        var xf = firstNum(geom.xf, params.xf);
        var hD = (pos(h) && pos(rw)) ? (h / rw) * Math.sqrt(1 / (kvkh > 0 ? kvkh : 1)) : firstNum(params.__h_rw ? params.__h_rw / Math.sqrt(kvkh || 1) : null, 100);
        var r = { S_total: S_total, S_pp: 0, S_theta: 0, S_f: 0, Dq: 0, S_model: 0, warnings: [], used: [] };
        if (isNum(b) && b > 0 && b < 1) {
            var spp = NaN;
            if (typeof lib.bronsMarting === 'function') { try { spp = lib.bronsMarting(b, hD); } catch (e) { spp = NaN; } }
            if (!isNum(spp)) spp = _bronsMarting(b, hD);
            r.S_pp = spp; r.used.push('partial penetration (Brons-Marting)');
        }
        if (isNum(theta) && theta !== 0) {
            var sth = NaN;
            if (typeof lib.cincoLey === 'function') { try { sth = lib.cincoLey(theta, kvkh, hD); } catch (e) { sth = NaN; } }
            if (!isNum(sth)) sth = _cincoLey(theta, kvkh, hD);
            r.S_theta = sth; r.used.push('well deviation (Cinco-Ley)');
        }
        if (pos(xf) && pos(rw)) {
            var sf = NaN;
            if (typeof lib.fracture === 'function') { try { sf = lib.fracture(xf, rw, 'infinite'); } catch (e) { sf = NaN; } }
            if (!isNum(sf)) sf = _fracSkin(xf, rw);
            r.S_f = sf; r.used.push('hydraulic fracture (rw′ = xf/2)');
        }
        // A model-level pseudo-skin when no geometric inputs applied.
        if (!r.used.length && o.modelKey && G.PRiSM_MODELS && G.PRiSM_MODELS[o.modelKey] &&
            typeof G.PRiSM_MODELS[o.modelKey].pseudoSkin === 'function') {
            try {
                var sm = G.PRiSM_MODELS[o.modelKey].pseudoSkin(params, geom);
                if (isNum(sm)) { r.S_model = sm; r.used.push('model pseudo-skin'); }
            } catch (e) { /* ignore */ }
        }
        var D = firstNum(o.D), q = firstNum(o.q);
        if (isNum(D) && isNum(q)) r.Dq = D * Math.abs(q);
        r.S_pseudo = r.S_pp + r.S_theta + r.S_f + r.S_model;
        r.S_mech = isNum(S_total) ? S_total - r.S_pseudo - r.Dq : NaN;
        r.ok = isNum(r.S_mech);
        if (!isNum(S_total)) r.warnings.push('Total skin not available');
        return r;
    }

    // Least-squares S′ = S + D·q over [{q, S′}] rows.
    function rateDependentSkin(rows) {
        var xs = [], ys = [];
        toArr(rows).forEach(function (r) {
            if (!r) return;
            var q = firstNum(r.q), s = firstNum(r.S, r.Sp, r["S'"], r['S′'], r.Sprime, r.skin);
            if (isNum(q) && isNum(s)) { xs.push(Math.abs(q)); ys.push(s); }
        });
        if (xs.length < 2) return { ok: false, n: xs.length, reason: 'Need at least two flow periods with a skin value' };
        var f = linfit(xs, ys);
        if (!f.ok) return { ok: false, n: xs.length, reason: 'All rates are equal: D cannot be separated from S' };
        return { ok: true, S: f.a, D: f.b, r2: f.r2, n: f.n, units: 'D in 1/(STB/d) or 1/(Mscf/d)' };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — STRAIGHT-LINE ANALYSIS
    // ═══════════════════════════════════════════════════════════════

    var METHOD_LABEL = {
        mdh: 'MDH (Δp vs log Δt)',
        horner: 'Horner (p vs log (tp+Δt)/Δt)',
        superposition: 'Superposition time',
        agarwal: 'Agarwal equivalent time'
    };

    function semilogAnalysis(adata, well, opts) {
        opts = opts || {};
        var ds = G.PRiSM_dataset;
        if (!well) well = getWell(ds);
        if (!adata) adata = getAnalysisData(ds, well, opts);
        var res = { ok: false, source: 'semilog', warnings: [], timestamp: Date.now() };
        if (!adata || !adata.ok) { res.reason = (adata && adata.reason) || 'No analysis data'; return res; }
        (adata.warnings || []).forEach(function (w) { if (res.warnings.indexOf(w) === -1) res.warnings.push(w); });

        var testType = adata.testType || (well && well.testType) || 'drawdown';
        if (testType === 'auto') testType = 'drawdown';
        var isShut = (testType === 'buildup' || testType === 'falloff');
        var fluid = adata.fluid || well.fluid || 'oil';
        var pseudo = !!(adata.pseudo || opts.pseudo || adata.dpUnits === 'psi2/cp');

        // ── Data (Δt > 0, finite Δp) ─────────────────────────────
        var T = toArr(adata.t), PP = toArr(adata.p), DP = toArr(adata.dp);
        var t = [], p = [], y = [];
        for (var i = 0; i < T.length; i++) {
            if (!(T[i] > 0) || !isNum(DP[i])) continue;
            if (isNum(opts.tmin) && T[i] < opts.tmin) continue;
            if (isNum(opts.tmax) && T[i] > opts.tmax) continue;
            t.push(T[i]); y.push(DP[i]); p.push(isNum(PP[i]) ? PP[i] : NaN);
        }
        if (t.length < 3) { res.reason = 'Fewer than 3 points with Δt > 0'; return res; }
        // Pressure-space reference. With pseudo-pressure, C2 carries pRef in
        // Δm units and the pressure in pRefPressure; pressure-space results
        // (p1hr, p*, FE, J) are then not produced.
        var pRef = pseudo ? NaN : firstNum(adata.pRefPressure, adata.pRef);
        // p = pRef + dir·Δp  (dir from the data, robust to sign conventions)
        var dirAcc = 0;
        for (var d0 = 0; d0 < t.length; d0++) if (isNum(p[d0]) && isNum(pRef)) dirAcc += (p[d0] - pRef) * y[d0];
        var dir = dirAcc > 0 ? 1 : (dirAcc < 0 ? -1 : (isShut || testType === 'injection' ? 1 : -1));
        if (testType === 'falloff' && dirAcc === 0) dir = -1;

        // ── Method ────────────────────────────────────────────────
        var tp = firstNum(adata.tp, well.tp);
        if (isNum(tp) && tp <= 0) tp = null;
        var adTp = { qRef: firstNum(adata.qRef, well.q), tp: tp, periods: adata.periods, rateHistory: adata.rateHistory,
            tStart: adata.tStart, tShut: adata.tShut };
        var supSteps = _steps(adTp, 'superposition', testType);
        var nFlow = supSteps ? supSteps.filter(function (s) { return s.q !== 0; }).length : 0;
        var multi = !!(supSteps && (isShut ? nFlow > 1 : supSteps.length > 1));
        var method = opts.method && opts.method !== 'auto' ? opts.method : null;
        if (!method) {
            if (!isShut) method = multi ? 'superposition' : 'mdh';
            else if (multi) method = 'superposition';
            else if (isNum(tp)) method = 'horner';
            else method = 'mdh';
        }
        var steps = (method === 'superposition') ? supSteps : _steps(adTp, method, testType);
        if (!steps) {
            if (method === 'horner' || method === 'agarwal') res.warnings.push('Producing time tp unknown: MDH on Δt used instead (valid only for Δt much shorter than tp).');
            else if (method === 'superposition') res.warnings.push('Rate history unavailable: MDH on Δt used instead.');
            method = 'mdh';
            steps = _steps(adTp, 'mdh', testType);
        }
        if (isShut && method === 'mdh' && !opts.method) {
            res.warnings.push('Build-up analysed with MDH on Δt: set tp for a Horner analysis.');
        }
        var nS = steps.length;
        var qn = steps[nS - 1].q, dqn = qn - (nS > 1 ? steps[nS - 2].q : 0);
        var qAnal = Math.abs(dqn);
        var qProvided = isNum(firstNum(adata.qRef, well.q));
        // Δp measured from pi (C2 dRef 'pi', or pRefSource 'pi') or from the
        // pressure at the start of the analysed period.
        var fromPi = adata.dRef ? adata.dRef === 'pi' : adata.pRefSource === 'pi';
        var refMode = (fromPi && nS >= 2 && qn !== 0) ? 'pi' : 'start';
        var W = refMode === 'start' ? supW(steps) : 0;

        // ── Time function + derivative ───────────────────────────
        var X = new Array(t.length), xw = new Array(t.length);
        for (var j = 0; j < t.length; j++) { X[j] = supX(steps, t[j]); xw[j] = Math.pow(10, X[j]); }
        // Derivative smoothing for window picking and the plateau check (ln units).
        var L = isNum(opts.L) ? opts.L : 0.3;
        var deriv = bourdet(xw, y, L);

        // ── Window ────────────────────────────────────────────────
        var i0 = -1, i1 = -1, winAuto = true, winFound = false;
        var mw = opts.window;
        if (mw && (isNum(firstNum(mw.t0)) || isNum(firstNum(mw.t1)))) {
            var w0 = firstNum(mw.t0, -Infinity), w1 = firstNum(mw.t1, Infinity);
            for (var k = 0; k < t.length; k++) {
                if (t[k] >= w0 && t[k] <= w1) { if (i0 < 0) i0 = k; i1 = k; }
            }
            winAuto = false; winFound = true;
            if (i0 < 0 || i1 - i0 + 1 < 2) {
                res.warnings.push('Manual window contains fewer than 2 points: automatic window used.');
                i0 = -1; winAuto = true;
            }
        }
        if (i0 < 0) {
            var fw = findIARFWindow(xw, deriv, opts.windowOpts);
            if (fw.found) { i0 = fw.i0; i1 = fw.i1; winFound = true; }
            else {
                var tEnd = t[t.length - 1];
                i1 = t.length - 1; i0 = i1;
                while (i0 > 0 && t[i0 - 1] >= tEnd / 10) i0--;
                if (i1 - i0 + 1 < 3) i0 = Math.max(0, i1 - 2);
                winFound = false;
                res.warnings.push('No clear radial-flow (IARF) plateau in the derivative: the last log cycle was used, so results are indicative only.');
            }
        }

        // ── Straight line ─────────────────────────────────────────
        var xsW = X.slice(i0, i1 + 1), ysW = y.slice(i0, i1 + 1);
        var f = linfit(xsW, ysW);
        if (!f.ok) { res.reason = 'Straight-line fit failed (window has no spread in time)'; return res; }
        var a = f.a, s = f.b, mAbs = Math.abs(s);
        if (!(mAbs > 0)) { res.reason = 'Zero semilog slope'; return res; }
        if (s < 0) res.warnings.push('Δp decreases with time in the chosen window: check the test type and the window.');

        // ── kh, k ─────────────────────────────────────────────────
        var B = firstNum(well.B), mu = firstNum(well.mu), h = firstNum(well.h), phi = firstNum(well.phi);
        var ct = firstNum(well.ct), rw = firstNum(well.rw);
        var TR = firstNum(well.T_R, isNum(well.T_res) ? well.T_res + 459.67 : null);
        var kh = NaN, khLL = NaN;
        var qU = qProvided ? qAnal : NaN;
        var missing = [];
        if (!qProvided) missing.push('q');
        if (fluid === 'gas' && pseudo) {
            if (pos(TR) && pos(qU)) kh = 1637 * qU * TR / mAbs; else if (!pos(TR)) missing.push('T');
            if (!pos(mu)) missing.push('mu');
        } else {
            if (!pos(B)) missing.push('B');
            if (!pos(mu)) missing.push('mu');
            if (pos(qU) && pos(B) && pos(mu)) kh = 162.6 * qU * B * mu / mAbs;
        }
        if (!pos(h)) missing.push('h');
        var k = (isNum(kh) && pos(h)) ? kh / h : NaN;
        var diffusGroup = (pos(phi) && pos(mu) && pos(ct) && pos(rw)) ? phi * mu * ct * rw * rw : NaN;
        ['phi', 'ct', 'rw'].forEach(function (key) { if (!pos(well[key])) missing.push(key); });

        // ── Skin, p1hr, p* ────────────────────────────────────────
        var K = refMode === 'pi' ? a * dqn / (s * qn) : a / s + W;
        var S = (isNum(k) && isNum(diffusGroup)) ? 1.1513 * (K - Math.log10(k / diffusGroup) + 3.2275) : NaN;
        var X1 = supX(steps, 1);
        var Y1 = a + s * X1;
        var p1hr = isNum(pRef) ? pRef + dir * Y1 : NaN;
        var pStar = (qn === 0 && isNum(pRef)) ? pRef + dir * a : NaN;

        // ── Log-log cross-check ──────────────────────────────────
        var dW = deriv.slice(i0, i1 + 1);
        var dpr = median(dW);
        var cross = { dpPrime_r: dpr };
        if (dpr > 0) {
            if (fluid === 'gas' && pseudo) { if (pos(TR) && pos(qU)) khLL = 711 * qU * TR / dpr; }
            else if (pos(qU) && pos(B) && pos(mu)) khLL = 70.6 * qU * B * mu / dpr;
            cross.kh_ll = khLL;
            cross.k_ll = (isNum(khLL) && pos(h)) ? khLL / h : NaN;
            if (isNum(cross.k_ll) && isNum(diffusGroup)) {
                var sll = [], sLL = s >= 0 ? LN10 * dpr : -LN10 * dpr;
                for (var c = i0; c <= i1; c++) {
                    var Kc = refMode === 'pi' ? (y[c] - sLL * X[c]) * dqn / (sLL * qn) : y[c] / sLL - X[c] + W;
                    sll.push(1.1513 * (Kc - Math.log10(cross.k_ll / diffusGroup) + 3.2275));
                }
                cross.S_ll = median(sll);
            }
            if (isNum(kh) && isNum(khLL)) cross.khDiffPct = Math.abs(kh - khLL) / khLL * 100;
            if (isNum(S) && isNum(cross.S_ll)) cross.dS = Math.abs(S - cross.S_ll);
            cross.pass = (isNum(cross.khDiffPct) ? cross.khDiffPct <= 5 : true) && (isNum(cross.dS) ? cross.dS <= 0.3 : true) &&
                (isNum(cross.khDiffPct) || isNum(cross.dS));
            if (cross.pass === false) {
                res.warnings.push('Straight-line and derivative-plateau results disagree (kh ' +
                    (isNum(cross.khDiffPct) ? cross.khDiffPct.toFixed(1) + ' %' : '—') + ', ΔS ' +
                    (isNum(cross.dS) ? cross.dS.toFixed(2) : '—') + '): the window may not be in radial flow.');
            }
        }

        // ── Unit slope (wellbore storage) ────────────────────────
        var us = { found: false };
        var lsl = localLogSlope(t, y, 0.2);
        var run = [];
        for (var u = 0; u < t.length; u++) {
            if (isNum(lsl[u]) && Math.abs(lsl[u] - 1) <= 0.1) run.push(u);
            else if (run.length) break;
            else if (u >= 2) break;         // storage must be at the start of the period
        }
        if (run.length >= 3 && pos(qU) && pos(B)) {
            var cs = run.map(function (ix) { return qU * B * t[ix] / (24 * y[ix]); });
            us = { found: true, n: run.length, t0: t[run[0]], t1: t[run[run.length - 1]], C: median(cs) };
            if (pos(phi) && pos(ct) && pos(h) && pos(rw)) us.CD = 0.8936 * us.C / (phi * ct * h * rw * rw);
        } else {
            res.warnings.push('No unit-slope (wellbore storage) points at early time: data starts after storage, so C is not determined from the data.');
        }
        var tIARF = NaN;
        if (us.found && isNum(S) && isNum(kh) && pos(mu)) {
            tIARF = (200000 + 12000 * S) * us.C * mu / kh;
            if (isNum(tIARF) && t[i0] < 0.5 * tIARF) res.warnings.push('The straight-line window starts before the end of storage effects (≈ ' + tIARF.toPrecision(3) + ' h).');
        }

        // ── rinv at the end of the period ────────────────────────
        var tEndA = t[t.length - 1];
        var rinv = (isNum(k) && pos(phi) && pos(mu) && pos(ct)) ? Math.sqrt(k * tEndA / (948 * phi * mu * ct)) : NaN;

        // ── Skin deliverables ─────────────────────────────────────
        var pbar = null, pwf = null;
        if (isShut) { pbar = isNum(pStar) ? pStar : null; pwf = pRef; }
        else {
            pbar = pRef;
            var lastP = null;
            for (var lp = p.length - 1; lp >= 0; lp--) if (isNum(p[lp])) { lastP = p[lp]; break; }
            pwf = isNum(lastP) ? lastP : (isNum(pRef) ? pRef + dir * y[y.length - 1] : null);
        }
        var summary = (fluid === 'gas' && pseudo)
            ? skinSummary({ S: S, m: mAbs, rw: rw, CD: us.CD })
            : skinSummary({ S: S, kh: kh, m: mAbs, q: qU, B: B, mu: mu, rw: rw, pbar: pbar, pwf: pwf, CD: us.CD, testType: testType });
        if (fluid === 'gas' && pseudo) res.warnings.push('Gas pseudo-pressure analysis: ΔpS is in Δm(p) units; FE and J are not computed.');

        // ── Bias warnings (pRef) ─────────────────────────────────
        var src = adata.pRefSource;
        if (!isShut && (src === 'first-sample' || src === 'extrapolated')) {
            var msg = src === 'first-sample'
                ? 'Initial pressure pi not set: Δp is measured from the first sample, so skin is biased. Enter pi in Well & Test.'
                : 'Initial pressure pi extrapolated from the first points: skin may be biased. Enter pi in Well & Test.';
            if (!res.warnings.some(function (w) { return /biased/.test(w); })) res.warnings.push(msg);
        }
        if (isShut && src === 'first-sample' && !res.warnings.some(function (w) { return /biased/.test(w); })) {
            res.warnings.push('Shut-in pressure pwf(Δt=0) not known: the first sample is used, so skin is biased.');
        }
        if (missing.length) {
            var uniq = missing.filter(function (v, ix) { return missing.indexOf(v) === ix; });
            res.warnings.push('Missing inputs: ' + uniq.join(', ') + ' — enter them in Well & Test.');
            res.missing = uniq;
        }

        // ── Line objects in display coordinates ──────────────────
        var line;
        if (method === 'horner') {
            // p = b + m·log10((tp+Δt)/Δt), log10 ratio = −X
            line = { kind: 'horner', m: -dir * s, b: pRef + dir * a, x0: (tp + t[i0]) / t[i0], x1: (tp + t[i1]) / t[i1] };
        } else if (method === 'agarwal') {
            var ltp = Math.log10(tp);
            line = { kind: 'agarwal', m: dir * s, b: pRef + dir * (a - s * ltp), t0: tp * t[i0] / (tp + t[i0]), t1: tp * t[i1] / (tp + t[i1]) };
        } else if (method === 'superposition') {
            line = { kind: 'superposition', m: dir * s, b: pRef + dir * a, x0: X[i0], x1: X[i1] };
        } else {
            line = { kind: 'mdh', m: dir * s, b: pRef + dir * a, t0: t[i0], t1: t[i1] };
        }

        res.ok = true;
        res.method = method;
        res.methodLabel = METHOD_LABEL[method];
        res.testType = testType;
        res.fluid = fluid;
        res.pseudo = pseudo;
        res.n = t.length;
        res.window = { t0: t[i0], t1: t[i1], i0: i0, i1: i1, n: i1 - i0 + 1, auto: winAuto, found: winFound,
            cycles: Math.log10(xw[i1] / xw[i0]) };
        res.m = mAbs;
        res.slope = line.m;
        res.intercept = line.b;
        res.line = line;
        res.r2 = f.r2;
        res.kh = kh; res.k = k;
        res.p1hr = p1hr; res.pStar = pStar; res.S = S;
        res.dpS = summary.dpS; res.FE = summary.FE; res.DR = summary.DR; res.J = summary.J; res.J_ideal = summary.J_ideal;
        res.rwEff = summary.rwEff; res.CDe2S = summary.CDe2S;
        res.rinv = rinv; res.tEnd = tEndA;
        res.C = us.found ? us.C : NaN; res.CD = us.found && isNum(us.CD) ? us.CD : NaN;
        res.unitSlope = us; res.tIARF = tIARF;
        res.crossCheck = cross;
        res.pRef = pRef; res.yRef = firstNum(adata.pRef); res.pRefSource = src || null; res.pbar = pbar; res.pwf = pwf;
        if (pseudo) { res.dm1hr = Y1; res.dmStar = (qn === 0) ? a : NaN; }
        res.tp = tp; res.qRef = qU; res.dq = dqn; res.steps = steps; res.refMode = refMode;
        res.inputs = { q: qU, B: B, mu: mu, h: h, phi: phi, ct: ct, rw: rw, T_R: TR };
        res.datasetHash = dsHash(G.PRiSM_dataset);
        res.opts = { method: opts.method || 'auto', window: winAuto ? null : { t0: res.window.t0, t1: res.window.t1 } };
        res.plot = { t: t, y: y, X: X, deriv: deriv };
        return res;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — STATE, EVENTS, SEED
    // ═══════════════════════════════════════════════════════════════

    var _busy = false;

    function _state() {
        if (!G.PRiSM_state) G.PRiSM_state = {};
        return G.PRiSM_state;
    }
    function _fire(name, detail) {
        if (typeof G.dispatchEvent !== 'function' || typeof G.CustomEvent !== 'function') return;
        try { G.dispatchEvent(new G.CustomEvent(name, { detail: detail })); } catch (e) { /* ignore */ }
    }
    function _sig(r) {
        if (!r || !r.ok) return 'x';
        return [r.method, r.m, r.k, r.S, r.window && r.window.t0, r.window && r.window.t1].map(function (v) {
            return isNum(v) ? v.toPrecision(6) : String(v);
        }).join('|');
    }

    // Run the analysis on the current dataset and store it in st.semilog.
    // Dispatches prism:fit-updated {source:'semilog'} when the result changed
    // (or always when opts.notify === true). Never touches st.lastFit.
    function runAndStore(opts) {
        opts = opts || {};
        if (_busy) return _state().semilog || null;
        _busy = true;
        try {
            var st = _state();
            var prev = st.semilog;
            var o = {};
            for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
            var r = semilogAnalysis(o.adata || null, o.well || null, o);
            if (prev && prev.pinned && r.ok) r.pinned = true;
            // Keep the plotting arrays off the persisted object (they are big).
            if (r.plot) Object.defineProperty(r, 'plot', { value: r.plot, enumerable: false, writable: true, configurable: true });
            st.semilog = r;
            if (opts.notify === true || _sig(prev) !== _sig(r)) {
                _fire('prism:fit-updated', { source: 'semilog', semilog: r });
            }
            return r;
        } finally { _busy = false; }
    }

    function useAsSeed(r) {
        r = r || _state().semilog;
        if (!r || !r.ok) return false;
        var st = _state();
        st.phys = st.phys || {};
        if (isNum(r.k)) st.phys.k = r.k;
        if (isNum(r.kh)) st.phys.kh = r.kh;
        if (isNum(r.S)) st.phys.S = r.S;
        if (isNum(r.C)) st.phys.C = r.C;
        if (isNum(r.pStar)) st.phys.pStarSemilog = r.pStar;
        st.params = st.params || {};
        if (isNum(r.S) && Object.prototype.hasOwnProperty.call(st.params, 'S')) st.params.S = r.S;
        if (isNum(r.CD) && Object.prototype.hasOwnProperty.call(st.params, 'Cd')) st.params.Cd = r.CD;
        _fire('prism:model-changed', { source: 'semilog-seed', model: st.model, phys: st.phys });
        return true;
    }

    // Line object in C6 format for the plot layer (and our post-draw hook).
    //   mdh:    {m, b, t0, t1}  → p = b + m·log10(Δt)
    //   horner: {m, b, x0, x1, tp, pStar} → p = b + m·log10(R), R = (tp+Δt)/Δt
    //           (x0 / x1 are Horner-ratio values, not logs)
    function plotLine(plotKey) {
        var r = _state().semilog;
        if (!r || !r.ok || !r.line || !isNum(r.line.b) || !isNum(r.line.m)) return null;
        var L = r.line;
        if (plotKey === 'mdh' && L.kind === 'mdh') return { m: L.m, b: L.b, t0: L.t0, t1: L.t1 };
        if (plotKey === 'horner' && L.kind === 'horner') return { m: L.m, b: L.b, x0: L.x0, x1: L.x1, tp: r.tp, pStar: r.pStar };
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — POST-DRAW HOOK + MDH PLOT REGISTRATION
    // ═══════════════════════════════════════════════════════════════

    function _postDraw(info) {
        try {
            info = info || {};
            var canvas = info.canvas;
            var axes = info.axes || (canvas && canvas._prismAxes);
            var plotKey = info.plotKey || (axes && axes.plotKey);
            if (plotKey !== 'mdh' && plotKey !== 'horner') return;
            if (!canvas || !axes || typeof axes.toX !== 'function' || typeof axes.toY !== 'function') return;
            var line = plotLine(plotKey);
            if (!line) return;
            var ctx = canvas.getContext && canvas.getContext('2d');
            if (!ctx) return;
            var pl = axes.plot || { x: 0, y: 0, w: canvas.width, h: canvas.height };
            var sx = axes.scaleX || {};
            var xa = isNum(sx.min) ? sx.min : null, xb = isNum(sx.max) ? sx.max : null;
            var w0 = plotKey === 'mdh' ? line.t0 : line.x0, w1 = plotKey === 'mdh' ? line.t1 : line.x1;
            if (xa == null || xb == null) { xa = Math.min(w0, w1); xb = Math.max(w0, w1); }
            var lo = Math.max(1e-12, Math.min(xa, xb)), hi = Math.max(xa, xb);
            function py(xv) { return line.b + line.m * Math.log10(xv); }
            ctx.save();
            ctx.beginPath(); ctx.rect(pl.x, pl.y, pl.w, pl.h); ctx.clip();
            var drawLine = !(info.data && info.data.line);
            if (drawLine) {
                ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.2;
                if (ctx.setLineDash) ctx.setLineDash([6, 4]);
                ctx.beginPath(); ctx.moveTo(axes.toX(lo), axes.toY(py(lo))); ctx.lineTo(axes.toX(hi), axes.toY(py(hi))); ctx.stroke();
                if (ctx.setLineDash) ctx.setLineDash([]);
                ctx.lineWidth = 2.2;
                ctx.beginPath(); ctx.moveTo(axes.toX(w0), axes.toY(py(w0))); ctx.lineTo(axes.toX(w1), axes.toY(py(w1))); ctx.stroke();
            }
            // Window markers
            ctx.strokeStyle = 'rgba(210,153,34,0.8)'; ctx.lineWidth = 1;
            if (ctx.setLineDash) ctx.setLineDash([3, 3]);
            [w0, w1].forEach(function (xv) {
                var px = axes.toX(xv);
                if (!isNum(px)) return;
                ctx.beginPath(); ctx.moveTo(px + 0.5, pl.y); ctx.lineTo(px + 0.5, pl.y + pl.h); ctx.stroke();
            });
            if (ctx.setLineDash) ctx.setLineDash([]);
            var r = _state().semilog;
            ctx.fillStyle = '#58a6ff'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
            var label = 'm = ' + _fmt(r.m, 4) + ' psi/cycle' + (isNum(r.k) ? '  k = ' + _fmt(r.k, 3) + ' md' : '') +
                (isNum(r.S) ? '  S = ' + _fmt(r.S, 3) : '');
            ctx.fillText(label, pl.x + 8, pl.y + pl.h - 8);
            ctx.restore();
        } catch (e) { /* never break a plot */ }
    }
    _postDraw._prismId = 'semilog-line';

    // Fallback MDH renderer: delegates to the plot layer when it provides
    // window.PRiSM_plot_mdh, otherwise draws a minimal p vs log Δt plot using
    // the shared plot helpers when they are in scope.
    function plotMdhFallback(canvas, data, opts) {
        opts = opts || {};
        if (typeof G.PRiSM_plot_mdh === 'function') return G.PRiSM_plot_mdh(canvas, data, opts);
        /* global PRiSM_plot_setup, PRiSM_plot_axes, PRiSM_plot_dots, PRiSM_plot_line, PRiSM_plot_empty, PRiSM_plot_range, PRiSM_plot_zip, PRiSM_THEME */
        if (typeof PRiSM_plot_setup !== 'function' || typeof PRiSM_plot_axes !== 'function') return;
        var setup = PRiSM_plot_setup(canvas, opts);
        var ctx = setup.ctx, plot = setup.plot;
        var tt = [], pp = [];
        var src = (data && data.t && data.p) ? data : null;
        if (src) {
            var T = toArr(src.t), P = toArr(src.p);
            for (var j = 0; j < T.length; j++) if (T[j] > 0 && isNum(P[j])) { tt.push(T[j]); pp.push(P[j]); }
        }
        if (!tt.length) { if (typeof PRiSM_plot_empty === 'function') PRiSM_plot_empty(ctx, plot, 'No data for the MDH plot'); return; }
        var xr = PRiSM_plot_range(tt, true), yr = PRiSM_plot_range(pp, false);
        var scaleX = { kind: 'log', min: xr.min, max: xr.max, label: 'Δt (hr)' };
        var scaleY = { kind: 'lin', min: yr.min, max: yr.max, label: 'Pressure (psia)' };
        var tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Semilog MDH' });
        var pts = PRiSM_plot_zip(tt, pp);
        var col = (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME.accent) || '#f0883e';
        if (typeof PRiSM_plot_dots === 'function') PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, col, 2.5);
        if (data && data.line && isNum(data.line.m) && isNum(data.line.b)) {
            var l = data.line;
            ctx.save(); ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(tr.toX(xr.min), tr.toY(l.b + l.m * Math.log10(xr.min)));
            ctx.lineTo(tr.toX(xr.max), tr.toY(l.b + l.m * Math.log10(xr.max))); ctx.stroke(); ctx.restore();
        }
        if (!canvas._prismAxes || canvas._prismAxes.plotKey !== 'mdh') {
            canvas._prismAxes = { scaleX: scaleX, scaleY: scaleY, toX: tr.toX, toY: tr.toY, plot: plot, plotKey: 'mdh' };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — UI PANEL (Tab 2, C7)
    // ═══════════════════════════════════════════════════════════════

    function _fmt(v, sig) {
        if (!isNum(v)) return '—';
        var a = Math.abs(v);
        if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential((sig || 4) - 1);
        if (a >= 1000) return v.toFixed(1);
        return Number(v.toPrecision(sig || 4)).toString();
    }
    function _esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    function _byId(id) { return HAS_DOC ? document.getElementById(id) : null; }

    var PANEL_CSS =
        '.prism-sl-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:8px}' +
        '.prism-sl-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text2);min-width:0;flex:1 1 110px;max-width:220px}' +
        '.prism-sl-field input,.prism-sl-field select{width:100%;box-sizing:border-box;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:5px 6px;font-size:12px}' +
        '.prism-sl-btns{display:flex;flex-wrap:wrap;gap:6px}' +
        '.prism-sl-tablewrap{overflow-x:auto;max-width:100%}' +
        '.prism-sl-table{width:100%;border-collapse:collapse;font-size:12px}' +
        '.prism-sl-table td{padding:4px 6px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top}' +
        '.prism-sl-table td.prism-sl-l{color:var(--text2)}' +
        '.prism-sl-table td.prism-sl-v{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}' +
        '.prism-sl-warn{font-size:12px;color:var(--yellow);background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:6px 8px;margin:6px 0}' +
        '.prism-sl-badge{display:inline-block;font-size:11px;padding:2px 7px;border-radius:10px;margin:2px 4px 2px 0;border:1px solid var(--border)}' +
        '.prism-sl-ok{color:var(--green)}.prism-sl-bad{color:var(--red)}' +
        '.prism-sl-note{font-size:11px;color:var(--text3);margin:4px 0}' +
        '.prism-sl-sub{margin-top:10px;border-top:1px solid var(--border);padding-top:8px}' +
        '.prism-sl-sub summary{cursor:pointer;color:var(--text);font-size:13px;margin-bottom:6px}' +
        '.prism-sl-dtable input{width:100%;box-sizing:border-box;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px;font-size:12px}';

    function _ensureCss() {
        if (!HAS_DOC || _byId('prism_sl_css')) return;
        var s = document.createElement('style');
        s.id = 'prism_sl_css';
        s.textContent = PANEL_CSS;
        (document.head || document.body || document.documentElement).appendChild(s);
    }

    function _resultsHTML(r) {
        if (!r) return '<div class="prism-sl-note">Press “Analyse straight line” to compute.</div>';
        if (!r.ok) return '<div class="prism-sl-warn">' + _esc(r.reason || 'Analysis not possible') + '</div>';
        var rows = [
            ['Method', _esc(r.methodLabel || r.method)],
            ['Window Δt (h)', _fmt(r.window.t0, 3) + ' – ' + _fmt(r.window.t1, 4) + ' (' + r.window.n + ' pts' + (r.window.auto ? ', auto' : ', manual') + ')'],
            ['Semilog slope m (psi/cycle)', _fmt(r.m, 4)],
            ['kh (md·ft)', _fmt(r.kh, 4)],
            ['Permeability k (md)', _fmt(r.k, 4)],
            ['p at 1 h on the line, p1hr (psia)', _fmt(r.p1hr, 5)],
            ['Skin S', _fmt(r.S, 3)]
        ];
        if (isNum(r.pStar)) rows.push(['Extrapolated pressure p* (psia)', _fmt(r.pStar, 5)]);
        rows.push(['Skin pressure drop ΔpS (psi)', _fmt(r.dpS, 4)]);
        rows.push(['Flow efficiency FE', _fmt(r.FE, 3)]);
        rows.push(['Damage ratio DR', _fmt(r.DR, 3)]);
        rows.push(['Productivity index J (per psi)', _fmt(r.J, 3)]);
        rows.push(['Undamaged J_ideal (per psi)', _fmt(r.J_ideal, 3)]);
        rows.push(['Effective wellbore radius rw′ (ft)', _fmt(r.rwEff, 3)]);
        rows.push(['Radius of investigation at ' + _fmt(r.tEnd, 3) + ' h (ft)', _fmt(r.rinv, 4)]);
        rows.push(['Storage C from unit slope (bbl/psi)', r.unitSlope && r.unitSlope.found ? _fmt(r.C, 3) : 'not seen']);
        rows.push(['Dimensionless storage CD', r.unitSlope && r.unitSlope.found ? _fmt(r.CD, 3) : '—']);
        rows.push(['Line fit R²', _fmt(r.r2, 5)]);
        var html = '<div class="prism-sl-tablewrap"><table class="prism-sl-table" id="prism_sl_table">';
        rows.forEach(function (row) {
            html += '<tr><td class="prism-sl-l">' + row[0] + '</td><td class="prism-sl-v">' + row[1] + '</td></tr>';
        });
        html += '</table></div>';
        var c = r.crossCheck || {};
        if (isNum(c.dpPrime_r)) {
            var okCls = c.pass ? 'prism-sl-ok' : 'prism-sl-bad';
            html += '<div id="prism_sl_cross" style="margin-top:6px">' +
                '<span class="prism-sl-badge ' + okCls + '">' + (c.pass ? '✓' : '✗') + ' Derivative-plateau check</span>' +
                '<span class="prism-sl-badge">plateau Δp′ ' + _fmt(c.dpPrime_r, 4) + ' psi</span>' +
                '<span class="prism-sl-badge">k ' + _fmt(c.k_ll, 4) + ' md (' + (isNum(c.khDiffPct) ? c.khDiffPct.toFixed(1) + ' %' : '—') + ')</span>' +
                '<span class="prism-sl-badge">S ' + _fmt(c.S_ll, 3) + ' (ΔS ' + (isNum(c.dS) ? c.dS.toFixed(2) : '—') + ')</span></div>';
        }
        return html;
    }

    function _warnHTML(r) {
        if (!r || !r.warnings || !r.warnings.length) return '';
        return r.warnings.map(function (w) { return '<div class="prism-sl-warn">⚠ ' + _esc(w) + '</div>'; }).join('');
    }

    function _decompDefaults() {
        var st = _state();
        var params = st.params || {};
        var w = null;
        try { w = getWell(G.PRiSM_dataset); } catch (e) { w = {}; }
        w = w || {};
        var h = firstNum(w.h);
        var b = firstNum(params.hp_to_h);
        return {
            h: h, rw: firstNum(w.rw),
            hp: (isNum(b) && isNum(h)) ? b * h : null,
            kvkh: firstNum(params.KvKh, 1),
            theta: firstNum(params.theta_deg),
            xf: firstNum(params.xf)
        };
    }

    function _panelHTML() {
        var st = _state();
        var r = st.semilog;
        var o = (r && r.opts) || {};
        var mw = o.window || {};
        var d = _decompDefaults();
        function opt(v, label) { return '<option value="' + v + '"' + ((o.method || 'auto') === v ? ' selected' : '') + '>' + label + '</option>'; }
        function num(id, label, val, ph) {
            return '<label class="prism-sl-field">' + label + '<input id="' + id + '" type="number" step="any" inputmode="decimal" value="' +
                (isNum(val) ? val : '') + '" placeholder="' + (ph || '') + '"></label>';
        }
        var html = '<div id="prism_sl_root" class="prism-sl">' +
            '<div class="prism-sl-note">Fits a straight line to the radial-flow part of the data and derives permeability, skin and the skin-related results. The window is picked automatically from the flat part of the derivative; you can override it.</div>' +
            '<div class="prism-sl-row">' +
            '<label class="prism-sl-field">Method<select id="prism_sl_method">' +
            opt('auto', 'Automatic (from test type)') + opt('mdh', 'MDH — Δp vs log Δt') + opt('horner', 'Horner — build-up') +
            opt('superposition', 'Superposition — multi-rate') + opt('agarwal', 'Agarwal equivalent time') +
            '</select></label>' +
            num('prism_sl_t0', 'Window start Δt (h)', mw.t0, r && r.ok ? String(_fmt(r.window.t0, 3)) : 'auto') +
            num('prism_sl_t1', 'Window end Δt (h)', mw.t1, r && r.ok ? String(_fmt(r.window.t1, 4)) : 'auto') +
            '</div>' +
            '<div class="prism-sl-btns" style="margin-bottom:8px">' +
            '<button type="button" class="btn btn-primary" id="prism_sl_run">Analyse straight line</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_auto">Auto window</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_plot">Show on semilog plot</button>' +
            '</div>' +
            '<div id="prism_sl_warn">' + _warnHTML(r) + '</div>' +
            '<div id="prism_sl_results">' + _resultsHTML(r) + '</div>' +
            '<div class="prism-sl-btns" style="margin-top:8px">' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_seed">Use as regression start values</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_report">Store in report</button>' +
            '</div>' +
            '<div id="prism_sl_msg" class="prism-sl-note"></div>' +
            // ── Skin decomposition sub-card ──
            '<details class="prism-sl-sub" id="prism_sl_decomp"><summary>Skin decomposition (mechanical vs geometric vs rate-dependent)</summary>' +
            '<div class="prism-sl-row">' +
            num('prism_sl_h', 'Net pay h (ft)', d.h) + num('prism_sl_hp', 'Perforated interval hp (ft)', d.hp, 'full') +
            num('prism_sl_rw', 'Wellbore radius rw (ft)', d.rw) + num('prism_sl_kvkh', 'kv/kh', d.kvkh) +
            num('prism_sl_theta', 'Well deviation θ (deg)', d.theta, '0') + num('prism_sl_xf', 'Fracture half-length xf (ft)', d.xf, 'none') +
            num('prism_sl_D', 'Non-Darcy D (1/rate)', null, '0') + num('prism_sl_q', 'Rate q for D·q', r && r.ok ? r.qRef : null) +
            '</div>' +
            '<div class="prism-sl-btns"><button type="button" class="btn btn-secondary" id="prism_sl_decomp_run">Split the skin</button></div>' +
            '<div id="prism_sl_decomp_out"></div>' +
            '<div class="prism-sl-sub"><div style="font-size:12px;color:var(--text);margin-bottom:4px">Rate-dependent skin from several flow periods (S′ = S + D·q)</div>' +
            '<div class="prism-sl-tablewrap"><table class="prism-sl-table prism-sl-dtable" id="prism_sl_dtable"><tr><td class="prism-sl-l">Rate q</td><td class="prism-sl-l">Apparent skin S′</td></tr>' +
            [0, 1, 2].map(function (i) {
                return '<tr><td><input id="prism_sl_dq_' + i + '" type="number" step="any" inputmode="decimal"></td><td><input id="prism_sl_ds_' + i + '" type="number" step="any" inputmode="decimal"></td></tr>';
            }).join('') + '</table></div>' +
            '<div class="prism-sl-btns" style="margin-top:6px"><button type="button" class="btn btn-secondary" id="prism_sl_drow">Add period</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_dfit">Fit S and D</button></div>' +
            '<div id="prism_sl_dout"></div></div>' +
            '</details>' +
            '</div>';
        return html;
    }

    function _readNum(id) {
        var el = _byId(id);
        if (!el || el.value === '' || el.value == null) return null;
        var v = parseFloat(el.value);
        return isNum(v) ? v : null;
    }

    function _currentOpts() {
        var o = {};
        var m = _byId('prism_sl_method');
        if (m && m.value && m.value !== 'auto') o.method = m.value;
        var t0 = _readNum('prism_sl_t0'), t1 = _readNum('prism_sl_t1');
        if (isNum(t0) || isNum(t1)) o.window = { t0: t0, t1: t1 };
        return o;
    }

    function _refreshPanel() {
        var r = _state().semilog;
        var w = _byId('prism_sl_warn'); if (w) w.innerHTML = _warnHTML(r);
        var res = _byId('prism_sl_results'); if (res) res.innerHTML = _resultsHTML(r);
        var t0 = _byId('prism_sl_t0'), t1 = _byId('prism_sl_t1');
        if (r && r.ok) {
            if (t0) t0.placeholder = String(_fmt(r.window.t0, 3));
            if (t1) t1.placeholder = String(_fmt(r.window.t1, 4));
        }
        var q = _byId('prism_sl_q');
        if (q && q.value === '' && r && r.ok && isNum(r.qRef)) q.value = r.qRef;
    }

    function _redrawPlot() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }

    function _msg(text) { var m = _byId('prism_sl_msg'); if (m) m.textContent = text; }

    function _wirePanel() {
        var run = _byId('prism_sl_run');
        if (run) run.onclick = function () {
            runAndStore(Object.assign(_currentOpts(), { notify: true }));
            _refreshPanel(); _redrawPlot();
        };
        var auto = _byId('prism_sl_auto');
        if (auto) auto.onclick = function () {
            var a = _byId('prism_sl_t0'), b = _byId('prism_sl_t1');
            if (a) a.value = ''; if (b) b.value = '';
            var o = _currentOpts(); delete o.window;
            runAndStore(Object.assign(o, { notify: true }));
            _refreshPanel(); _redrawPlot();
        };
        var meth = _byId('prism_sl_method');
        if (meth) meth.onchange = function () {
            runAndStore(Object.assign(_currentOpts(), { notify: true }));
            _refreshPanel(); _redrawPlot();
        };
        ['prism_sl_t0', 'prism_sl_t1'].forEach(function (id) {
            var el = _byId(id);
            if (el) el.onchange = function () {
                runAndStore(Object.assign(_currentOpts(), { notify: true }));
                _refreshPanel(); _redrawPlot();
            };
        });
        var plotBtn = _byId('prism_sl_plot');
        if (plotBtn) plotBtn.onclick = function () {
            var r = _state().semilog;
            var key = (r && r.ok && r.method === 'horner') ? 'horner' : 'mdh';
            var st = _state();
            st.activePlot = key;
            var sel = _byId('prism_plot_select') || _byId('prism_plot_picker');
            if (sel) { try { sel.value = key; } catch (e) { /* ignore */ } }
            _fire('prism:plot-changed', { plot: key, source: 'semilog' });
            _redrawPlot();
            _msg('Semilog plot selected (' + (key === 'horner' ? 'Horner' : 'MDH') + ').');
        };
        var seed = _byId('prism_sl_seed');
        if (seed) seed.onclick = function () {
            var r = _state().semilog;
            if (useAsSeed(r)) _msg('Start values set: k = ' + _fmt(r.k, 4) + ' md, S = ' + _fmt(r.S, 3) + (isNum(r.C) ? ', C = ' + _fmt(r.C, 3) + ' bbl/psi' : '') + '.');
            else _msg('Run the straight-line analysis first.');
        };
        var rep = _byId('prism_sl_report');
        if (rep) rep.onclick = function () {
            var r = _state().semilog;
            if (!r || !r.ok) { _msg('Run the straight-line analysis first.'); return; }
            r.pinned = true;
            _fire('prism:fit-updated', { source: 'semilog', semilog: r, pinned: true });
            _msg('Straight-line results will be included in the report.');
        };
        var dr = _byId('prism_sl_decomp_run');
        if (dr) dr.onclick = function () {
            var r = _state().semilog || {};
            var st = _state();
            var out = skinDecomposition({
                S_total: r.S, modelKey: st.model, params: st.params || {},
                geom: { h: _readNum('prism_sl_h'), hp: _readNum('prism_sl_hp'), rw: _readNum('prism_sl_rw'),
                    kvkh: _readNum('prism_sl_kvkh'), theta: _readNum('prism_sl_theta'), xf: _readNum('prism_sl_xf') },
                D: _readNum('prism_sl_D'), q: _readNum('prism_sl_q')
            });
            if (r && r.ok) r.decomposition = out;
            var el = _byId('prism_sl_decomp_out');
            if (!el) return;
            if (!isNum(out.S_total)) { el.innerHTML = '<div class="prism-sl-warn">Run the straight-line analysis first (total skin needed).</div>'; return; }
            var rows = [['Total skin S', out.S_total], ['Partial penetration S_pp', out.S_pp], ['Well deviation S_θ', out.S_theta],
                ['Fracture S_f', out.S_f]];
            if (out.S_model) rows.push(['Model pseudo-skin', out.S_model]);
            rows.push(['Rate-dependent D·q', out.Dq], ['Mechanical skin S_mech', out.S_mech]);
            el.innerHTML = '<div class="prism-sl-tablewrap"><table class="prism-sl-table" id="prism_sl_decomp_table">' +
                rows.map(function (rw) { return '<tr><td class="prism-sl-l">' + rw[0] + '</td><td class="prism-sl-v">' + _fmt(rw[1], 3) + '</td></tr>'; }).join('') +
                '</table></div><div class="prism-sl-note">' +
                (out.S_mech > 0.5 ? 'Mechanical damage remains after removing geometric terms: stimulation may help.' :
                    'Little mechanical damage: the measured skin is mostly geometric or rate-dependent.') + '</div>';
        };
        var addRow = _byId('prism_sl_drow');
        if (addRow) addRow.onclick = function () {
            var tb = _byId('prism_sl_dtable');
            if (!tb) return;
            var nRows = 0;
            while (_byId('prism_sl_dq_' + nRows)) nRows++;
            var tr = document.createElement('tr');
            tr.innerHTML = '<td><input id="prism_sl_dq_' + nRows + '" type="number" step="any" inputmode="decimal"></td><td><input id="prism_sl_ds_' + nRows + '" type="number" step="any" inputmode="decimal"></td>';
            (tb.tBodies && tb.tBodies[0] ? tb.tBodies[0] : tb).appendChild(tr);
        };
        var dfit = _byId('prism_sl_dfit');
        if (dfit) dfit.onclick = function () {
            var rows = [];
            for (var i = 0; _byId('prism_sl_dq_' + i); i++) rows.push({ q: _readNum('prism_sl_dq_' + i), S: _readNum('prism_sl_ds_' + i) });
            var fr = rateDependentSkin(rows);
            var el = _byId('prism_sl_dout');
            if (!el) return;
            if (!fr.ok) { el.innerHTML = '<div class="prism-sl-warn">' + _esc(fr.reason) + '</div>'; return; }
            var st = _state();
            if (st.semilog && st.semilog.ok) st.semilog.rateDependent = fr;
            el.innerHTML = '<div class="prism-sl-tablewrap"><table class="prism-sl-table" id="prism_sl_dres">' +
                '<tr><td class="prism-sl-l">Rate-independent skin S</td><td class="prism-sl-v">' + _fmt(fr.S, 4) + '</td></tr>' +
                '<tr><td class="prism-sl-l">Non-Darcy coefficient D (per unit rate)</td><td class="prism-sl-v">' + _fmt(fr.D, 4) + '</td></tr>' +
                '<tr><td class="prism-sl-l">Fit R² (' + fr.n + ' periods)</td><td class="prism-sl-v">' + _fmt(fr.r2, 4) + '</td></tr></table></div>';
            var dIn = _byId('prism_sl_D');
            if (dIn) dIn.value = fr.D;
        };
    }

    function renderSemilogPanel(hostEl) {
        if (!HAS_DOC) return;
        var host = hostEl || _byId('prism_semilog_host');
        if (!host) return;
        _ensureCss();
        var st = _state();
        var ds = G.PRiSM_dataset;
        var hash = dsHash(ds);
        if (ds && ds.t && ds.t.length && (!st.semilog || st.semilog.datasetHash !== hash)) {
            var prevOpts = (st.semilog && st.semilog.datasetHash === hash && st.semilog.opts) || {};
            var o = {};
            if (prevOpts.method && prevOpts.method !== 'auto') o.method = prevOpts.method;
            runAndStore(o);
        } else if (st.semilog && st.semilog.ok && !st.semilog.plot && ds && ds.t && ds.t.length) {
            // Restored from storage without plotting arrays: recompute quietly.
            var ro = {};
            var so = st.semilog.opts || {};
            if (so.method && so.method !== 'auto') ro.method = so.method;
            if (so.window) ro.window = so.window;
            runAndStore(ro);
        }
        host.innerHTML = _panelHTML();
        _wirePanel();
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — REGISTRATION (C7) + EVENT LISTENERS
    // ═══════════════════════════════════════════════════════════════

    var PANEL_SPEC = {
        id: 'semilog',
        title: 'Straight-line analysis & skin',
        order: 5,
        when: function () { return !(G.PRiSM && G.PRiSM.mode === 'decline'); },
        render: function (el) { renderSemilogPanel(el); },
        collapsed: false
    };

    function _registerPanel() {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(2, PANEL_SPEC); return; } catch (e) { /* fall through */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var arr = G.PRiSM_tabPanels[2] = G.PRiSM_tabPanels[2] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === PANEL_SPEC.id) { arr[i] = PANEL_SPEC; return; }
        arr.push(PANEL_SPEC);
    }

    function _registerHooks() {
        var hooks = G.PRiSM_postDrawHooks = G.PRiSM_postDrawHooks || [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === _postDraw._prismId) { hooks[i] = _postDraw; return; }
        hooks.push(_postDraw);
    }

    function _registerPlot() {
        var reg = G.PRiSM_PLOT_REGISTRY = G.PRiSM_PLOT_REGISTRY || {};
        if (!reg.mdh) {
            reg.mdh = { fn: 'PRiSM_semilog_plot_mdh', label: 'Semilog MDH (p vs log Δt)', mode: 'transient' };
        }
    }

    function _installListeners() {
        if (typeof G.addEventListener !== 'function' || G.__prismSemilogListeners) return;
        G.__prismSemilogListeners = true;
        function recompute() {
            var ds = G.PRiSM_dataset;
            if (!ds || !ds.t || !ds.t.length) return;
            var st = _state();
            var o = {};
            var so = (st.semilog && st.semilog.opts) || {};
            if (so.method && so.method !== 'auto') o.method = so.method;
            runAndStore(o);
            if (_byId('prism_sl_root')) _refreshPanel();
        }
        G.addEventListener('prism:dataset-loaded', recompute);
        G.addEventListener('prism:well-changed', recompute);
    }

    // ── Public API ──────────────────────────────────────────────────
    G.PRiSM_semilogAnalysis = function (adata, well, opts) {
        // Called with no data arguments → analyse the current dataset and store.
        if (!adata && !well) return runAndStore(opts || {});
        var r = semilogAnalysis(adata, well, opts);
        if (opts && opts.store) {
            var st = _state(); var prev = st.semilog; st.semilog = r;
            if (_sig(prev) !== _sig(r)) _fire('prism:fit-updated', { source: 'semilog', semilog: r });
        }
        return r;
    };
    G.PRiSM_skinSummary = skinSummary;
    G.PRiSM_skinDecomposition = skinDecomposition;
    G.PRiSM_rateDependentSkin = rateDependentSkin;
    G.PRiSM_renderSemilogPanel = renderSemilogPanel;
    G.PRiSM_semilogPlotLine = plotLine;
    G.PRiSM_semilog_plot_mdh = plotMdhFallback;
    G.PRiSM_semilog = {
        version: 1,
        analyse: semilogAnalysis,
        run: runAndStore,
        useAsSeed: useAsSeed,
        localWell: localWell,
        localAnalysisData: localAnalysisData,
        getWell: getWell,
        getAnalysisData: getAnalysisData,
        bourdet: bourdet,
        localLogSlope: localLogSlope,
        findIARFWindow: findIARFWindow,
        supX: supX,
        linfit: linfit,
        postDrawHook: _postDraw,
        panelSpec: PANEL_SPEC,
        bronsMarting: _bronsMarting,
        cincoLey: _cincoLey
    };

    _registerPanel();
    _registerHooks();
    _registerPlot();
    _installListeners();
})();

// ─── END 34-semilog-skin ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 35-rta-dca ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM — Layer 35 — Decline results (EUR · forecast · P10/P50/P90) + RTA
// =============================================================================
// Work package WP12 of the PRiSM gap-closure plan (round 8).
//
// UNITS: field units. Rate q in STB/d (oil, water) or Mscf/d (gas), pressure
// in psia. EVERYTHING IN THIS LAYER USES DAYS for time: the dataset stores
// hours (canonical) and t_day = t_hr / 24. Di is a nominal decline in 1/day.
//
// ── DECLINE (DCA) RESULTS ─ rate models are fitted to q, never to pressure ──
//   PRiSM_declineResults(fit, ds, {q_ab, t_end_days, Dmin | DminEffYr, bootstrap})
//     qi, Di (1/d), Di_yr = 365·Di, b, effective annual decline
//       De = 1 − (1 + b·Di_yr)^(−1/b)          (exponential: 1 − e^(−Di_yr))
//     t_ab  = ((qi/q_ab)^b − 1)/(b·Di)          (exponential: ln(qi/q_ab)/Di)
//     EUR   = qi^b/((1−b)·Di)·(qi^(1−b) − q_ab^(1−b))
//             exponential (qi − q_ab)/Di, harmonic (qi/Di)·ln(qi/q_ab)
//     Modified hyperbolic when a terminal decline Dmin is set:
//       D(t) = max(Di/(1 + b·Di·t), Dmin); switch at t_sw = (Di/Dmin − 1)/(b·Di),
//       exponential at Dmin afterwards (q and dq/dt are continuous at t_sw).
//     EUR is taken to the earlier of the abandonment rate q_ab and the time
//     limit t_end (days from first production). Np_hist is the trapezoid
//     cumulative of the history; Remaining = EUR − Np_hist. A monthly
//     forecast table (+ CSV) runs from the end of history to the limit.
//     P10/P50/P90 come from a residual bootstrap on ln q (n = 200 by default,
//     shared PRiSM_bootstrap when available, local fallback). P90 is the LOW
//     case (10th percentile of EUR), P10 the high case.
//   Duong, SEPD, Fetkovich and any other registry model with kind:'rate' use
//   the same machinery with a numerically integrated cumulative.
//
// ── RATE-TRANSIENT ANALYSIS (RTA) ─ needs flowing pressure AND rate ──
//   PRiSM_rtaData(ds, well):
//     Δp = pi − pwf (production) or pwf − pi (injection); gas: Δm(p) when the
//     m(p) table is available. Np (trapezoid), tc = Np/q (days),
//     RNP = Δp/q, RNP′ = dRNP/d ln tc (Bourdet, smoothing L in ln units),
//     RNPi = (1/tc)∫₀^tc RNP dτ, RNPi′ = dRNPi/d ln tc = RNP − RNPi,
//     q/Δp, (q/Δp)i = (1/tc)∫ q/Δp dτ, (q/Δp)id = (q/Δp)i − q/Δp,
//     Np/(ct·Δp) for the flowing material balance.
//   PRiSM_rtaFMB: least squares of q/Δp vs Np/(ct·Δp) on boundary-dominated
//     points → x-intercept X = Vp/B (STB), N = X·(1 − Sw),
//     A = 5.615·X·B/(h·φ) ft², re = √(A/π), b_pss = 1/y-intercept,
//     kh = 141.2·B·μ/b_pss·[ln(re/rwa) − ¾], rwa = rw·e^(−S).
//   PRiSM_rtaLinearFlow: RNP vs √t (t in days) → slope m′,
//     xf√k = 4.064·√24·B/(h·m′)·√(μ/(φ·ct)) ≈ 19.91·B/(h·m′)·√(μ/(φ·ct)),
//     × π/2 when the well produced at constant pwf.
//   PRiSM_rtaAG: qD = 141.2·B·μ/(kh)·(q/Δp) vs tDA = 0.0002637·k·t_hr/(φ·μ·ct·A).
//
// ── UI ──
//   PRiSM_renderDeclineResultsPanel(host)  → Tab 6 panel (C7), also used by the report
//   PRiSM_renderRTAPanel(host)             → Tab 2 panel (C7)
//   PRiSM_PLOT_REGISTRY += rnp, blasingame, ag, fmb, sqrtRnp  (mode 'decline')
//   PRiSM_plot_rta_rnp / _blasingame / _ag / _fmb / _sqrt (canvas, data, opts)
//
// Cross-WP calls are all guarded (PRiSM_getWell, PRiSM_getLastFit,
// PRiSM_setLastFit, PRiSM_fitRate, PRiSM_bootstrap, PRiSM_registerTabPanel,
// PRiSM_setModel, PRiSM_drawActivePlot, PRiSM_mpTable) with local fallbacks.
// No timers, no polling, no function wrapping.
// =============================================================================

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — CONSTANTS + SMALL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
var YEAR_D = 365;                        // Di_yr = 365·Di (plan convention)
var MONTH_D = YEAR_D / 12;               // forecast step, days
var LF_CONST = 4.064 * Math.sqrt(24);    // 19.91 — linear flow with t in days
var TAB_WARN_YEARS = 50;
var MAX_FORECAST_ROWS = 600;             // 50 years of months
var NUM_T_MIN = 1e-6, NUM_T_MAX = 1e6, NUM_PER_DEC = 100;   // numeric cumulative table (days)
var DEFAULT_BOOT = 200;
var DEFAULT_SEED = 20260929;
var AUTO_BOOT_MAX_POINTS = 400;          // panel runs the bootstrap automatically below this
var RATE_MODEL_NAMES = {
    arps: 'Arps', duong: 'Duong', sepd: 'Stretched exponential (SEPD)', fetkovich: 'Fetkovich'
};
var FIT_KEYS = {
    arps: ['qi', 'Di', 'b'], duong: ['q1', 'a', 'm'], sepd: ['qi', 'tau', 'n'], fetkovich: ['qi', 'Di', 'b']
};
var LOG_KEYS = { qi: 1, q1: 1, Di: 1, tau: 1, reD: 1 };
var FALLBACK_BOUNDS = {
    qi: [1e-9, 1e12], q1: [1e-9, 1e12], Di: [1e-9, 50], b: [0, 2], a: [0, 10], m: [0.3, 3],
    tau: [1e-3, 1e8], n: [0.05, 1], reD: [5, 1e5]
};
// Student-t 97.5 % quantiles, df = 1..30.
var T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
            2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
            2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return _num(v) && v > 0; }
function _isArr(a) { return !!a && typeof a === 'object' && typeof a.length === 'number'; }
function _has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
function _firstNum(list) {
    for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (v === null || v === undefined || v === '') continue;
        var n = +v;
        if (isFinite(n)) return n;
    }
    return null;
}
function _clone(o) {
    if (!o || typeof o !== 'object') return o;
    var r = {};
    for (var k in o) if (_has(o, k)) r[k] = o[k];
    return r;
}
function _tq(df) {
    if (!(df >= 1)) return NaN;
    if (df <= 30) return T975[Math.floor(df) - 1];
    return 1.959964 + 2.5 / df;
}
function _sortNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }
function _pct(sorted, q) {
    var n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    var pos = q * (n - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    if (!isFinite(sorted[hi]) || !isFinite(sorted[lo])) return (pos - lo < 0.5) ? sorted[lo] : sorted[hi];
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}
function _median(a) { return _pct(_sortNum(a.filter(_num)), 0.5); }
function _mean(a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (_num(a[i])) { s += a[i]; n++; } return n ? s / n : NaN; }
function _cv(a) {
    var m = _mean(a);
    if (!_num(m) || m === 0) return NaN;
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (_num(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) / Math.abs(m) : 0;
}
function _rng(seed) {
    var s = (seed | 0) || 1;
    return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function _hashSeries(t, q) {
    var h = 2166136261;
    for (var i = 0; i < t.length; i++) {
        h = Math.imul(h ^ Math.round(t[i] * 1e4), 16777619);
        h = Math.imul(h ^ Math.round(q[i] * 1e4), 16777619);
    }
    return (h >>> 0).toString(16) + ':' + t.length;
}
function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _commas(n) {
    var s = String(Math.round(Math.abs(n)));
    s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '−' : '') + s;
}
function _trim0(s) {
    if (s.indexOf('e') !== -1) return s;
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}
// Display formatting: thousands separators for large values, significant
// figures below 1,000, scientific below 1e-3.
function _fmt(v, sig) {
    if (v === Infinity) return '∞';
    if (!_num(v)) return '—';
    sig = sig || 4;
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e4) return _commas(v);
    if (a >= 1000) return _commas(v);
    if (a < 1e-3) return v.toExponential(Math.max(sig - 2, 1)).replace('e-', 'e−');
    return _trim0(v.toPrecision(sig)).replace(/^-/, '−');
}
function _st() { return G.PRiSM_state || null; }
function _mode() { return (G.PRiSM && G.PRiSM.mode) || 'transient'; }
function _doc() { return G.document || null; }
function _dispatch(name, detail) {
    try {
        var CE = G.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
        if (CE && typeof G.dispatchEvent === 'function') G.dispatchEvent(new CE(name, { detail: detail }));
    } catch (e) { /* ignore */ }
}
function _lsGet(key) {
    try { var raw = G.localStorage && G.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
}
function _lsSet(key, val) {
    try { if (G.localStorage) G.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota / privacy */ }
}
function _models() { return G.PRiSM_MODELS || {}; }
function _isRateModel(key) {
    if (!key) return false;
    if (_has(FIT_KEYS, key)) return true;
    var e = _models()[key];
    return !!(e && e.kind === 'rate');
}
function _modelName(key) {
    if (RATE_MODEL_NAMES[key]) return RATE_MODEL_NAMES[key];
    var e = _models()[key];
    return (e && (e.label || e.name)) || String(key);
}

// Linear least squares y = a + b·x.
function _linreg(x, y) {
    var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (var i = 0; i < x.length; i++) {
        if (!_num(x[i]) || !_num(y[i])) continue;
        n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; syy += y[i] * y[i];
    }
    if (n < 2) return null;
    var den = n * sxx - sx * sx;
    if (!(Math.abs(den) > 0)) return null;
    var slope = (n * sxy - sx * sy) / den;
    var intercept = (sy - slope * sx) / n;
    var ssTot = syy - sy * sy / n, ssRes = 0;
    for (var j = 0; j < x.length; j++) {
        if (!_num(x[j]) || !_num(y[j])) continue;
        var r = y[j] - (intercept + slope * x[j]);
        ssRes += r * r;
    }
    return { slope: slope, intercept: intercept, n: n, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}

// Small dense linear solve (Gauss-Jordan, partial pivoting). Returns null if singular.
function _solve(A, b) {
    var n = b.length, M = [], i, j, k;
    for (i = 0; i < n; i++) { M.push(A[i].slice()); M[i].push(b[i]); }
    for (k = 0; k < n; k++) {
        var piv = k, best = Math.abs(M[k][k]);
        for (i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > best) { best = Math.abs(M[i][k]); piv = i; }
        if (!(best > 1e-300)) return null;
        if (piv !== k) { var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp; }
        var d = M[k][k];
        for (j = k; j <= n; j++) M[k][j] /= d;
        for (i = 0; i < n; i++) {
            if (i === k) continue;
            var f = M[i][k];
            if (f === 0) continue;
            for (j = k; j <= n; j++) M[i][j] -= f * M[k][j];
        }
    }
    var x = new Array(n);
    for (i = 0; i < n; i++) x[i] = M[i][n];
    return x;
}
function _invert(A) {
    var n = A.length, inv = [];
    for (var c = 0; c < n; c++) {
        var e = new Array(n);
        for (var r = 0; r < n; r++) e[r] = (r === c) ? 1 : 0;
        var col = _solve(A, e);
        if (!col) return null;
        inv.push(col);
    }
    var out = [];
    for (var i = 0; i < n; i++) { out.push(new Array(n)); for (var j = 0; j < n; j++) out[i][j] = inv[j][i]; }
    return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — DATASET ACCESS (time → days), WELL INPUTS, CURRENT FIT
// ─────────────────────────────────────────────────────────────────────────────
function _timeToDays(ds, opts) {
    var u = (opts && opts.timeUnit) || (ds && ds.timeUnit) || 'h';
    u = String(u).toLowerCase();
    if (u === 'd' || u === 'day' || u === 'days') return 1;
    if (u === 'min' || u === 'mins' || u === 'minute' || u === 'minutes') return 1 / 1440;
    if (u === 's' || u === 'sec' || u === 'secs' || u === 'seconds') return 1 / 86400;
    if (u === 'mo' || u === 'month' || u === 'months') return MONTH_D;
    if (u === 'y' || u === 'yr' || u === 'year' || u === 'years') return YEAR_D;
    return 1 / 24;       // hours (canonical)
}

// Rate series in days. tAll/qAll: every row with finite t and q (sorted);
// t/q: flowing rows (q > 0, t ≥ 0, optionally t > 0) inside the window.
function _rateSeries(ds, opts) {
    opts = opts || {};
    if (!ds || !_isArr(ds.t) || !_isArr(ds.q)) return null;
    var f = _timeToDays(ds, opts);
    var rows = [];
    for (var i = 0; i < ds.t.length; i++) {
        var t = +ds.t[i] * f, q = +ds.q[i];
        if (!isFinite(t) || !isFinite(q)) continue;
        rows.push([t, q, i]);
    }
    rows.sort(function (a, b) { return a[0] - b[0] || a[2] - b[2]; });
    var out = { tAll: [], qAll: [], t: [], q: [], idx: [], factor: f };
    var lo = _num(opts.tminDays) ? opts.tminDays : -Infinity;
    var hi = _num(opts.tmaxDays) ? opts.tmaxDays : Infinity;
    for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        out.tAll.push(r[0]); out.qAll.push(r[1]);
        if (!(r[1] > 0) || r[0] < 0) continue;
        if (opts.positiveT && !(r[0] > 0)) continue;
        if (r[0] < lo || r[0] > hi) continue;
        out.t.push(r[0]); out.q.push(r[1]); out.idx.push(r[2]);
    }
    return out;
}

// Cumulative production of the history (days): an initial rectangle q0·t0
// (production assumed to start at t = 0) plus trapezoids between samples.
function _history(ds) {
    var s = _rateSeries(ds, {});
    if (!s || !s.tAll.length) return null;
    var Np = Math.max(0, s.qAll[0]) * Math.max(0, s.tAll[0]);
    var qMax = 0, qLast = NaN;
    for (var i = 0; i < s.tAll.length; i++) {
        var qi = Math.max(0, s.qAll[i]);
        if (i > 0) Np += 0.5 * (qi + Math.max(0, s.qAll[i - 1])) * (s.tAll[i] - s.tAll[i - 1]);
        if (qi > qMax) qMax = qi;
        if (qi > 0) qLast = qi;
    }
    return {
        Np: Np, tFirst: s.tAll[0], tLast: s.tAll[s.tAll.length - 1], qLast: qLast, qMax: qMax,
        n: s.t.length, hash: _hashSeries(s.tAll, s.qAll)
    };
}

function _fluidOf(well) {
    var f = (well && (well.fluid || well.fluidType)) ||
            (G.PRiSM_pvt && G.PRiSM_pvt.fluidType) || 'oil';
    return String(f).toLowerCase();
}
function _rateUnits(fluid) {
    if (fluid === 'gas') return { rate: 'Mscf/d', vol: 'Mscf' };
    return { rate: 'STB/d', vol: 'STB' };
}

// C1 well inputs with a PRiSM_pvt fallback when WP1's getWell is absent.
function _resolveWell(wellIn, ds) {
    var w = {};
    if (typeof G.PRiSM_getWell === 'function') {
        try {
            var gw = G.PRiSM_getWell(ds);
            if (gw && typeof gw === 'object') { for (var k in gw) if (_has(gw, k)) w[k] = gw[k]; w._source = 'getWell'; }
        } catch (e) { /* fall through */ }
    }
    if (!w._source) {
        var pvt = G.PRiSM_pvt || {}, c = pvt._computed || {};
        var fl = String(pvt.fluidType || 'oil').toLowerCase();
        w.fluid = fl;
        w.B = _firstNum(fl === 'gas' ? [pvt.Bg, c.Bg, c.B] : fl === 'water' ? [pvt.Bw, c.B] : [pvt.Bo, c.Bo, c.B]);
        w.mu = _firstNum(fl === 'gas' ? [pvt.mu_g, c.mu_g, c.mu] : fl === 'water' ? [pvt.mu_w, c.mu] : [pvt.mu_o, c.mu_o, c.mu]);
        w.ct = _firstNum([pvt.ct, c.ct]);
        w.h = _firstNum([pvt.h]); w.phi = _firstNum([pvt.phi]); w.rw = _firstNum([pvt.rw]);
        w.q = _firstNum([pvt.q]);
        w.T_R = _firstNum([pvt.T_res]); w.sg = _firstNum([pvt.SG_g]);
        var prov = pvt.provenance && pvt.provenance.p_res;
        w.pi = (prov === 'user' || prov === 'sample' || prov === 'deconvolution') ? _firstNum([pvt.p_res]) : null;
        w.testType = pvt.testType || 'auto';
        w._source = 'pvt';
    }
    if (wellIn && typeof wellIn === 'object') {
        for (var k2 in wellIn) if (_has(wellIn, k2) && wellIn[k2] !== null && wellIn[k2] !== undefined) w[k2] = wellIn[k2];
    }
    if (!w.fluid && w.fluidType) w.fluid = w.fluidType;
    w.fluid = String(w.fluid || 'oil').toLowerCase();
    if (!_num(w.B)) w.B = _firstNum([w.Bo, w.Bg, w.Bw]);
    if (!_num(w.mu)) w.mu = _firstNum([w.mu_o, w.mu_g, w.mu_w]);
    if (!_num(w.pi) && wellIn && _num(wellIn.p_res)) w.pi = wellIn.p_res;
    return w;
}

// Normalise a fit object (aliases from C4 / WP2).
function _normFit(f) {
    if (!f || typeof f !== 'object' || !f.params) return null;
    var o = _clone(f);
    o.modelKey = f.modelKey || f.model;
    o.model = o.modelKey;
    if (!_num(o.r2) && _num(f.R2)) o.r2 = f.R2;
    if (!_num(o.rmse) && _num(f.RMSE)) o.rmse = f.RMSE;
    if (!_num(o.aic) && _num(f.AIC)) o.aic = f.AIC;
    if (!o.ci95 && f.CI95) o.ci95 = f.CI95;
    o.params = _clone(f.params);
    return o;
}
function _currentRateFit() {
    var f = null;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { f = G.PRiSM_getLastFit(); } catch (e) { f = null; }
    }
    if (!f) { var st = _st(); if (st && st.lastFit) f = st.lastFit; }
    f = _normFit(f);
    if (!f) return null;
    if (f.kind === 'rate' || _isRateModel(f.modelKey)) {
        if (f.kind !== 'pressure') return f;
    }
    return null;
}
function _fitWindowDays(fit) {
    if (!fit) return {};
    if (fit.windowDays && (_num(fit.windowDays.tmin) || _num(fit.windowDays.tmax))) {
        return { tminDays: fit.windowDays.tmin, tmaxDays: fit.windowDays.tmax };
    }
    var w = fit.window;
    if (w && (_num(w.tmin) || _num(w.tmax))) {
        // Rate fits (PRiSM_fitRate) report the window in days (fit.timeUnit 'd');
        // pressure-style C4 windows are in hours unless flagged otherwise.
        var unit = String(w.unit || fit.windowUnit || fit.timeUnit || (fit.kind === 'rate' ? 'd' : 'h')).toLowerCase();
        var f = (unit === 'd' || unit === 'day' || unit === 'days') ? 1 : 1 / 24;
        var pad = 1e-9;
        return { tminDays: _num(w.tmin) ? w.tmin * f - pad : undefined, tmaxDays: _num(w.tmax) ? w.tmax * f + pad : undefined };
    }
    return {};
}
function _frozenObj(fit) {
    var fz = fit && (fit.frozen || fit.freeze || fit.paramFreeze);
    var o = {};
    if (_isArr(fz)) { for (var i = 0; i < fz.length; i++) o[fz[i]] = true; }
    else if (fz && typeof fz === 'object') { for (var k in fz) if (_has(fz, k) && fz[k] === true) o[k] = true; }
    return o;
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — DECLINE RATE MODELS (closed-form Arps, numeric for the others)
// ─────────────────────────────────────────────────────────────────────────────
function _arpsQ(t, qi, Di, b) {
    if (!(t > 0) || !(Di > 0)) return qi;
    if (!(b > 1e-10)) return qi * Math.exp(-Di * t);
    return qi * Math.exp(-Math.log1p(b * Di * t) / b);
}
function _arpsLnRatio(t, Di, b) {             // ln(q/qi) ≤ 0
    if (!(t > 0) || !(Di > 0)) return 0;
    if (!(b > 1e-10)) return -Di * t;
    return -Math.log1p(b * Di * t) / b;
}
// Cumulative from qi down to q = qi·e^L:  qi/((1−b)Di)·(1 − (q/qi)^(1−b))
// (b → 1: (qi/Di)·ln(qi/q); b = 0: (qi − q)/Di). expm1 keeps it exact near b = 0 and 1.
function _arpsCumFromLn(qi, Di, b, L) {
    if (!(Di > 0)) return NaN;
    var omb = 1 - b;
    if (Math.abs(omb) < 1e-9) return -qi * L / Di;
    return qi * (-Math.expm1(omb * L)) / (omb * Di);
}
function _arpsNp(t, qi, Di, b) {
    if (!(t > 0)) return 0;
    if (!(Di > 0)) return qi * t;
    return _arpsCumFromLn(qi, Di, b, _arpsLnRatio(t, Di, b));
}
function _arpsTab(qi, Di, b, qab) {
    if (!(qab > 0)) return Infinity;
    if (qab >= qi) return 0;
    if (!(Di > 0)) return Infinity;
    var L = Math.log(qi / qab);
    if (!(b > 1e-10)) return L / Di;
    return Math.expm1(b * L) / (b * Di);
}
function _effAnnual(Di, b) {
    if (!_num(Di)) return null;
    var Dy = Di * YEAR_D;
    if (!(b > 1e-10)) return 1 - Math.exp(-Dy);
    return 1 - Math.pow(1 + b * Dy, -1 / b);
}
function _nominalFromEffective(De) {             // exponential: De = 1 − e^(−D·365)
    if (!(De > 0) || !(De < 1)) return null;
    return -Math.log(1 - De) / YEAR_D;
}

// Arps (optionally modified hyperbolic with terminal decline Dmin).
function _arpsSpec(p, Dmin) {
    var qi = +p.qi, Di = +p.Di, b = Math.max(0, +p.b || 0);
    if (!_pos(qi) || !_num(Di) || Di < 0) return null;
    var dm = _pos(Dmin) ? Dmin : null;
    var tsw = Infinity, qsw = NaN, Csw = NaN;
    if (dm) {
        if (Di <= dm) { tsw = 0; qsw = qi; Csw = 0; }
        else if (b > 1e-10) {
            tsw = (Di / dm - 1) / (b * Di);
            qsw = _arpsQ(tsw, qi, Di, b);
            Csw = _arpsNp(tsw, qi, Di, b);
        }
    }
    return {
        model: 'arps', closedForm: true, qi: qi, Di: Di, b: b, Dmin: dm, tSwitch: tsw, qSwitch: qsw, qPeak: qi,
        q: function (t) {
            if (!(t > 0)) return qi;
            if (t <= tsw) return _arpsQ(t, qi, Di, b);
            return qsw * Math.exp(-dm * (t - tsw));
        },
        cum: function (t) {
            if (!(t > 0)) return 0;
            if (t <= tsw) return _arpsNp(t, qi, Di, b);
            return Csw + qsw * (-Math.expm1(-dm * (t - tsw))) / dm;
        },
        tAt: function (qab) {
            if (!(qab > 0)) return Infinity;
            if (qab >= qi) return 0;
            if (tsw < Infinity && qab < qsw) return tsw + Math.log(qsw / qab) / dm;
            return _arpsTab(qi, Di, b, qab);
        },
        D: function (t) {
            if (t > tsw) return dm;
            return Di / (1 + b * Di * Math.max(0, t));
        }
    };
}

function _duongQ(t, q1, a, m) {
    if (!(t > 0)) return 0;
    var e = (Math.abs(1 - m) < 1e-10) ? a * Math.log(t) : (a / (1 - m)) * (Math.pow(t, 1 - m) - 1);
    var v = q1 * Math.pow(t, -m) * Math.exp(e);
    return _num(v) ? v : 0;
}
function _sepdQ(t, qi, tau, n) {
    if (!(t > 0)) return qi;
    var v = qi * Math.exp(-Math.pow(t / tau, n));
    return _num(v) ? v : 0;
}

// Rate evaluator (vectorised, days) for any decline model; null if unusable.
function _qVecFor(key, p) {
    if (!p) return null;
    var mapScalar = function (fn) {
        return function (T) { var out = new Array(T.length); for (var i = 0; i < T.length; i++) out[i] = fn(T[i]); return out; };
    };
    if (key === 'arps') {
        if (!_pos(+p.qi) || !_num(+p.Di)) return null;
        var qi = +p.qi, Di = +p.Di, b = Math.max(0, +p.b || 0);
        return mapScalar(function (t) { return _arpsQ(t, qi, Di, b); });
    }
    if (key === 'duong') {
        var q1 = +p.q1, a = +p.a, m = +p.m;
        if (!_pos(q1) || !_num(a) || !_num(m)) return null;
        return mapScalar(function (t) { return _duongQ(t, q1, a, m); });
    }
    if (key === 'sepd') {
        var qs = +p.qi, tau = +p.tau, n = +p.n;
        if (!_pos(qs) || !_pos(tau) || !_pos(n)) return null;
        return mapScalar(function (t) { return _sepdQ(t, qs, tau, n); });
    }
    var e = _models()[key];
    var bdf = (key === 'fetkovich' && _pos(+p.qi) && _num(+p.Di))
        ? mapScalar(function (t) { return _arpsQ(t, +p.qi, +p.Di, Math.max(0, +p.b || 0)); }) : null;
    if (e && typeof e.pd === 'function' && (e.kind === 'rate' || key === 'fetkovich')) {
        return function (T) {
            var arr = [], i;
            for (i = 0; i < T.length; i++) arr.push(T[i] > 0 ? T[i] : 1e-9);
            var out = null;
            try { out = e.pd(arr, p); } catch (err) { out = null; }
            if (!_isArr(out) || out.length !== arr.length) {
                if (bdf) return bdf(T);
                out = new Array(arr.length);
                for (i = 0; i < arr.length; i++) {
                    var v = NaN;
                    try { var r = e.pd([arr[i]], p); v = _isArr(r) ? +r[0] : +r; } catch (err2) { v = NaN; }
                    out[i] = v;
                }
            }
            var res = new Array(out.length);
            for (i = 0; i < out.length; i++) res[i] = (_num(+out[i]) && +out[i] > 0) ? +out[i] : 0;
            return res;
        };
    }
    return bdf;
}

// Numeric decline spec: cumulative from a log-spaced trapezoid table
// (100 points per decade, 1e-6 … 1e6 days), optional terminal decline.
function _tableSpec(key, qVec, Dmin) {
    var N = Math.round(Math.log10(NUM_T_MAX / NUM_T_MIN) * NUM_PER_DEC);
    var u0 = Math.log(NUM_T_MIN), du = Math.log(NUM_T_MAX / NUM_T_MIN) / N;
    var T = new Array(N + 1), i;
    for (i = 0; i <= N; i++) T[i] = Math.exp(u0 + i * du);
    var Q = qVec(T);
    for (i = 0; i <= N; i++) if (!_num(Q[i]) || Q[i] < 0) Q[i] = 0;
    var F = new Array(N + 1), C = new Array(N + 1);
    for (i = 0; i <= N; i++) F[i] = Q[i] * T[i];
    C[0] = Q[0] * T[0];
    for (i = 1; i <= N; i++) C[i] = C[i - 1] + 0.5 * (F[i] + F[i - 1]) * du;
    var iPk = 0;
    for (i = 1; i <= N; i++) if (Q[i] > Q[iPk]) iPk = i;

    function qn(t) {
        if (!(t > 0)) return Q[0];
        var v = qVec([t])[0];
        return (_num(v) && v > 0) ? v : 0;
    }
    function cn(t) {
        if (!(t > 0)) return 0;
        if (t <= T[0]) return qn(t) * t;
        var u = Math.log(t);
        if (t >= T[N]) {
            var steps = 50, h = (u - Math.log(T[N])) / steps, acc = C[N], fPrev = F[N];
            for (var s = 1; s <= steps && h > 0; s++) {
                var tt = Math.exp(Math.log(T[N]) + s * h), fc = qn(tt) * tt;
                acc += 0.5 * (fPrev + fc) * h; fPrev = fc;
            }
            return acc;
        }
        var k = Math.min(N - 1, Math.max(0, Math.floor((u - u0) / du)));
        return C[k] + 0.5 * (F[k] + qn(t) * t) * (u - (u0 + k * du));
    }
    function bisectLog(a, b, fn) {       // fn(a) > 0 ≥ fn(b)
        var la = Math.log(a), lb = Math.log(b);
        for (var it = 0; it < 80; it++) {
            var lm = 0.5 * (la + lb);
            if (fn(Math.exp(lm)) > 0) la = lm; else lb = lm;
        }
        return Math.exp(0.5 * (la + lb));
    }
    function tNum(qab) {
        if (!(qab > 0)) return Infinity;
        if (Q[iPk] <= qab) return 0;
        for (var j = iPk + 1; j <= N; j++) {
            if (Q[j] <= qab) return bisectLog(T[j - 1], T[j], function (t) { return qn(t) - qab; });
        }
        return Infinity;
    }
    var dm = _pos(Dmin) ? Dmin : null, tsw = Infinity, qsw = NaN, Csw = NaN;
    function Dnum(t) {
        var e = 1e-3, a = qn(t * Math.exp(-e)), b = qn(t * Math.exp(e));
        if (!(a > 0 && b > 0)) return 0;
        return -(Math.log(b) - Math.log(a)) / (t * (Math.exp(e) - Math.exp(-e)));
    }
    if (dm) {
        for (var j2 = Math.max(iPk, 1); j2 < N; j2++) {
            if (!(Q[j2 + 1] > 0 && Q[j2 - 1] > 0)) continue;
            var Dj = -(Math.log(Q[j2 + 1]) - Math.log(Q[j2 - 1])) / (T[j2 + 1] - T[j2 - 1]);
            if (Dj <= dm) {
                tsw = (j2 === Math.max(iPk, 1)) ? T[j2]
                    : bisectLog(T[j2 - 1], T[j2], function (t) { return Dnum(t) - dm; });
                break;
            }
        }
        if (tsw < Infinity) { qsw = qn(tsw); Csw = cn(tsw); }
    }
    return {
        model: key, closedForm: false, Dmin: dm, tSwitch: tsw, qSwitch: qsw, qPeak: Q[iPk], tPeak: T[iPk],
        q: function (t) { if (t <= tsw) return qn(t); return qsw * Math.exp(-dm * (t - tsw)); },
        cum: function (t) {
            if (!(t > 0)) return 0;
            if (t <= tsw) return cn(t);
            return Csw + qsw * (-Math.expm1(-dm * (t - tsw))) / dm;
        },
        tAt: function (qab) {
            if (!(qab > 0)) return Infinity;
            if (tsw < Infinity && qab < qsw) return tsw + Math.log(qsw / qab) / dm;
            return tNum(qab);
        },
        D: function (t) { if (t > tsw) return dm; return Dnum(t); }
    };
}

function _declineSpec(key, params, Dmin) {
    if (!params || !_isRateModel(key)) return null;
    if (key === 'arps') return _arpsSpec(params, Dmin);
    var qv = _qVecFor(key, params);
    if (!qv) return null;
    var s = _tableSpec(key, qv, Dmin);
    s.qi = _pos(+params.qi) ? +params.qi : null;
    return s;
}

function _resolveDmin(opts) {
    if (!opts) return null;
    if (_pos(opts.Dmin)) return +opts.Dmin;
    var eff = _num(opts.DminEffYr) ? +opts.DminEffYr : null;
    if (eff !== null && eff >= 1) eff = eff / 100;               // percent given
    return eff ? _nominalFromEffective(eff) : null;
}

/**
 * Decline rate q(t) in days for a rate model (optionally with a terminal
 * decline). Scalar in → scalar out, array in → array out.
 */
function PRiSM_declineRate(modelKey, params, tDays, opts) {
    var spec = _declineSpec(modelKey, params, _resolveDmin(opts || {}));
    if (!spec) return _isArr(tDays) ? tDays.map(function () { return NaN; }) : NaN;
    if (_isArr(tDays)) { var out = []; for (var i = 0; i < tDays.length; i++) out.push(spec.q(+tDays[i])); return out; }
    return spec.q(+tDays);
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — RATE FIT (shared PRiSM_fitRate, local LM on ln q as fallback)
// ─────────────────────────────────────────────────────────────────────────────
function _fitKeysFor(key, params, freeze) {
    var keys = FIT_KEYS[key];
    if (!keys) {
        var e = _models()[key];
        keys = [];
        (e && e.paramSpec || []).forEach(function (s) { if (s && s.key && typeof (params || {})[s.key] !== 'string') keys.push(s.key); });
    }
    return keys.filter(function (k) { return !(freeze && freeze[k] === true); });
}
function _paramPlan(key, fitKeys) {
    var e = _models()[key], spec = {};
    (e && e.paramSpec || []).forEach(function (s) { if (s && s.key) spec[s.key] = s; });
    return fitKeys.map(function (k) {
        var s = spec[k] || {}, fb = FALLBACK_BOUNDS[k] || [-1e9, 1e9];
        var isLog = !!LOG_KEYS[k] || s.scale === 'log';
        var lo = _num(s.min) ? s.min : fb[0], hi = _num(s.max) ? s.max : fb[1];
        if (isLog) {
            lo = Math.log(Math.max(lo, fb[0] > 0 ? fb[0] : 1e-12));
            hi = Math.log(Math.max(hi, Math.exp(lo) * 10));
        }
        return { key: k, log: isLog, lo: lo, hi: hi };
    });
}
function _toParams(plan, theta, base) {
    var p = _clone(base || {});
    for (var j = 0; j < plan.length; j++) p[plan[j].key] = plan[j].log ? Math.exp(theta[j]) : theta[j];
    return p;
}
function _fromParams(plan, p) {
    return plan.map(function (pl) {
        var v = +p[pl.key];
        var th = pl.log ? Math.log(v) : v;
        if (!_num(th)) th = pl.log ? 0.5 * (pl.lo + pl.hi) : Math.max(pl.lo, Math.min(pl.hi, 0));
        return Math.max(pl.lo, Math.min(pl.hi, th));
    });
}

// Levenberg-Marquardt on residuals r(θ) = y − f(θ). Bounds by clipping.
function _lm(resid, theta0, lo, hi, maxIter) {
    var p = theta0.length;
    var clip = function (th) { for (var j = 0; j < p; j++) th[j] = Math.max(lo[j], Math.min(hi[j], th[j])); return th; };
    var ss = function (r) { if (!r) return NaN; var s = 0; for (var i = 0; i < r.length; i++) s += r[i] * r[i]; return s; };
    var th = clip(theta0.slice()), r = resid(th), ssr = ss(r);
    if (!_num(ssr)) return null;
    var n = r.length;
    function jac(th0, r0) {
        var J = [];
        for (var i = 0; i < n; i++) J.push(new Array(p));
        for (var j = 0; j < p; j++) {
            var h = 1e-6 * Math.max(1, Math.abs(th0[j]));
            if (th0[j] + h > hi[j]) h = -h;
            var t2 = th0.slice(); t2[j] += h;
            var r2 = resid(t2);
            for (var i2 = 0; i2 < n; i2++) J[i2][j] = r2 ? -(r2[i2] - r0[i2]) / h : 0;
        }
        return J;
    }
    var lam = 1e-3, iter = 0, converged = false, J = null;
    for (iter = 1; iter <= maxIter; iter++) {
        J = jac(th, r);
        var A = [], g = new Array(p), a, b2, i;
        for (a = 0; a < p; a++) { A.push(new Array(p)); g[a] = 0; for (b2 = 0; b2 < p; b2++) A[a][b2] = 0; }
        for (i = 0; i < n; i++) {
            for (a = 0; a < p; a++) {
                var Ja = J[i][a];
                if (!Ja) continue;
                g[a] += Ja * r[i];
                for (b2 = 0; b2 < p; b2++) A[a][b2] += Ja * J[i][b2];
            }
        }
        var improved = false;
        for (var tries = 0; tries < 25; tries++) {
            var M = [];
            for (a = 0; a < p; a++) { M.push(A[a].slice()); M[a][a] += lam * Math.max(A[a][a], 1e-12); }
            var d = _solve(M, g);
            if (!d) { lam *= 10; continue; }
            var tn = th.slice();
            for (a = 0; a < p; a++) tn[a] += d[a];
            clip(tn);
            var rn = resid(tn), sn = ss(rn);
            if (_num(sn) && sn < ssr) {
                var rel = (ssr - sn) / Math.max(ssr, 1e-300), step = 0;
                for (a = 0; a < p; a++) step = Math.max(step, Math.abs(tn[a] - th[a]) / (1 + Math.abs(th[a])));
                th = tn; r = rn; ssr = sn; lam = Math.max(lam / 10, 1e-12); improved = true;
                if (rel < 1e-13 || step < 1e-11) converged = true;
                break;
            }
            lam *= 10;
            if (lam > 1e14) break;
        }
        if (!improved) { converged = true; break; }
        if (converged) break;
    }
    J = jac(th, r);
    return { theta: th, r: r, ssr: ssr, iterations: Math.min(iter, maxIter), converged: converged && iter <= maxIter, J: J };
}

function _seedsFor(key, ser, base) {
    var t = ser.t, q = ser.q, n = t.length;
    var nh = Math.min(n, Math.max(3, Math.round(n / 5)));
    var lt = [], lq = [];
    for (var i = 0; i < nh; i++) { lt.push(t[i]); lq.push(Math.log(q[i])); }
    var reg = _linreg(lt, lq);
    var qMax = Math.max.apply(null, q);
    var qi0 = reg ? Math.exp(reg.intercept) : q[0];
    if (!_pos(qi0) || qi0 > 10 * qMax || qi0 < qMax / 10) qi0 = q[0];
    var span = Math.max(t[n - 1] - t[0], 1e-6);
    var dSec = Math.log(q[0] / q[n - 1]) / span;
    var dHead = reg ? -reg.slope : NaN;
    var D0 = Math.max(_pos(dHead) ? dHead : 0, _pos(dSec) ? dSec : 0, 1e-5);
    var seeds = [];
    if (key === 'arps' || key === 'fetkovich') {
        [0.05, 0.5, 1.0, 1.5].forEach(function (b) {
            var s = _clone(base); s.qi = qi0; s.Di = D0 * (1 + b); s.b = b; seeds.push(s);
        });
    } else if (key === 'duong') {
        // q at t = 1 day by log-log interpolation (or extrapolation from the first point)
        var q1 = q[0] * Math.pow(Math.max(t[0], 1e-6), 1.1);
        for (var k = 1; k < n; k++) {
            if (t[k - 1] <= 1 && t[k] >= 1 && t[k - 1] > 0) {
                var f = Math.log(1 / t[k - 1]) / Math.log(t[k] / t[k - 1]);
                q1 = Math.exp(Math.log(q[k - 1]) + f * Math.log(q[k] / q[k - 1]));
                break;
            }
        }
        [1.1, 1.3].forEach(function (m) { [0.3, 1.0, 2.0].forEach(function (a) {
            var s = _clone(base); s.q1 = q1; s.a = a; s.m = m; seeds.push(s);
        }); });
    } else if (key === 'sepd') {
        var target = qi0 / Math.E, tau0 = span;
        for (var k2 = 1; k2 < n; k2++) if (q[k2] <= target) { tau0 = t[k2]; break; }
        [0.3, 0.6, 0.95].forEach(function (nn) {
            var s = _clone(base); s.qi = qi0; s.tau = Math.max(tau0, 1e-3); s.n = nn; seeds.push(s);
        });
    } else {
        var s0 = _clone(base);
        if (_has(s0, 'qi')) s0.qi = qi0;
        if (_has(s0, 'Di')) s0.Di = D0;
        seeds.push(s0);
    }
    return seeds;
}

function _fitDeclineLocal(key, ds, opts) {
    opts = opts || {};
    if (!_isRateModel(key)) return { ok: false, reason: 'Model "' + key + '" is not a decline (rate) model.' };
    var needPosT = !(key === 'arps' || key === 'sepd');
    var sopts = { positiveT: needPosT, tminDays: opts.tminDays, tmaxDays: opts.tmaxDays, timeUnit: opts.timeUnit };
    var ser = _rateSeries(ds, sopts);
    if (!ser || ser.t.length < 3) return { ok: false, reason: 'Need at least 3 points with q > 0 to fit a decline model.' };
    var entry = _models()[key];
    var base = _clone((entry && entry.defaults) || {});
    if (opts.params) for (var pk in opts.params) if (_has(opts.params, pk)) base[pk] = opts.params[pk];
    var freeze = _clone(opts.freeze || {});
    if (key === 'fetkovich') freeze.reD = freeze.reD !== false;
    var fitKeys = _fitKeysFor(key, base, freeze);
    if (!fitKeys.length) return { ok: false, reason: 'No free parameters.' };
    var plan = _paramPlan(key, fitKeys);
    var lo = plan.map(function (pl) { return pl.lo; }), hi = plan.map(function (pl) { return pl.hi; });
    var lnq = ser.q.map(Math.log);
    function resid(theta, target) {
        var y = target || lnq;
        var qv = _qVecFor(key, _toParams(plan, theta, base));
        if (!qv) return null;
        var qm = qv(ser.t), r = new Array(y.length);
        for (var i = 0; i < y.length; i++) {
            if (!(qm[i] > 0)) return null;
            r[i] = y[i] - Math.log(qm[i]);
        }
        return r;
    }
    var seeds = _seedsFor(key, ser, base), best = null;
    seeds.forEach(function (sd) {
        var r = _lm(function (th) { return resid(th); }, _fromParams(plan, sd), lo, hi, 200);
        if (r && (!best || r.ssr < best.ssr)) best = r;
    });
    if (!best) return { ok: false, reason: 'The decline fit failed from every starting point.' };

    var params = _toParams(plan, best.theta, base);
    var n = ser.t.length, p = plan.length;
    var qhat = _qVecFor(key, params)(ser.t);
    var qMean = _mean(ser.q), ssTot = 0, ssRes = 0;
    for (var i = 0; i < n; i++) { ssTot += (ser.q[i] - qMean) * (ser.q[i] - qMean); ssRes += (ser.q[i] - qhat[i]) * (ser.q[i] - qhat[i]); }
    var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
    var rmse = Math.sqrt(ssRes / n);
    var aic = best.ssr > 0 ? n * Math.log(best.ssr / n) + 2 * p : -Infinity;

    // Covariance in θ space → CIs in natural units (asymmetric for log keys).
    var ci95 = {}, stderr = {}, corr = null, identifiable = {};
    var JtJ = [];
    for (var a = 0; a < p; a++) { JtJ.push(new Array(p)); for (var b = 0; b < p; b++) { var s = 0; for (var k = 0; k < n; k++) s += best.J[k][a] * best.J[k][b]; JtJ[a][b] = s; } }
    var inv = _invert(JtJ), tq = _tq(Math.max(n - p, 1)), sigma2 = best.ssr / Math.max(n - p, 1);
    if (inv) {
        corr = [];
        for (var a2 = 0; a2 < p; a2++) {
            corr.push(new Array(p));
            for (var b3 = 0; b3 < p; b3++) {
                var den = Math.sqrt(Math.abs(inv[a2][a2] * inv[b3][b3]));
                corr[a2][b3] = den > 0 ? inv[a2][b3] / den : NaN;
            }
        }
    }
    plan.forEach(function (pl, j) {
        var val = params[pl.key];
        var se = inv ? Math.sqrt(Math.max(sigma2 * inv[j][j], 0)) : NaN;
        var lo2, hi2;
        if (pl.log) { lo2 = Math.exp(best.theta[j] - tq * se); hi2 = Math.exp(best.theta[j] + tq * se); stderr[pl.key] = val * se; }
        else { lo2 = Math.max(pl.lo, best.theta[j] - tq * se); hi2 = Math.min(pl.hi, best.theta[j] + tq * se); stderr[pl.key] = se; }
        ci95[pl.key] = [lo2, hi2];
        var atBound = Math.abs(best.theta[j] - pl.lo) <= 1e-9 * (1 + Math.abs(pl.lo)) ||
                      Math.abs(best.theta[j] - pl.hi) <= 1e-9 * (1 + Math.abs(pl.hi));
        var highCorr = false;
        if (corr) for (var c = 0; c < p; c++) if (c !== j && Math.abs(corr[j][c]) > 0.98) highCorr = true;
        identifiable[pl.key] = _num(se) && (0.5 * (hi2 - lo2)) <= Math.abs(val) && !highCorr && !atBound;
    });
    var warnings = [];
    if (!best.converged) warnings.push('The decline fit did not fully converge — treat it as a starting point.');
    if (r2 < 0.9) warnings.push('Poor decline fit (R² = ' + _fmt(r2, 3) + ').');
    Object.keys(identifiable).forEach(function (k2) { if (!identifiable[k2]) warnings.push('Parameter ' + k2 + ' is poorly determined by the data.'); });
    return {
        ok: true, modelKey: key, model: key, kind: 'rate', source: 'regression', impl: 'local',
        params: params, ci95: ci95, stderr: stderr, corr: corr, identifiable: identifiable,
        freeKeys: plan.map(function (pl) { return pl.key; }), frozen: freeze,
        r2: r2, rmse: rmse, aic: aic, ssr: best.ssr, objective: 'ln q', iterations: best.iterations,
        converged: best.converged, n: n, timeUnit: 'd',
        windowDays: { tmin: ser.t[0], tmax: ser.t[n - 1] },
        datasetHash: _hashSeries(ser.t, ser.q), timestamp: Date.now(), warnings: warnings
    };
}

/**
 * Fit a decline model to the rate data (never pressure). Uses the shared
 * PRiSM_fitRate (WP2) when present, else the local LM on ln q. Returns a
 * LastFit-shaped object ({ok:false, reason} on failure). Does NOT store it.
 */
function PRiSM_fitDecline(modelKey, ds, opts) {
    opts = opts || {};
    if (ds === undefined || ds === null) ds = G.PRiSM_dataset || null;
    if (!opts.local && typeof G.PRiSM_fitRate === 'function') {
        try {
            var f = _normFit(G.PRiSM_fitRate(modelKey, ds, opts));
            var keys = FIT_KEYS[modelKey] || [];
            if (f && keys.every(function (k) { return _num(+f.params[k]); })) {
                f.ok = f.ok !== false; f.kind = 'rate'; f.impl = f.impl || 'shared';
                return f;
            }
        } catch (e) {
            if (G.console) G.console.warn('PRiSM 35: shared rate fit failed, using the local fit:', e && e.message);
        }
    }
    return _fitDeclineLocal(modelKey, ds, opts);
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — BOOTSTRAP (P10/P50/P90)
// ─────────────────────────────────────────────────────────────────────────────
var _bootCache = [];
function _bootCacheGet(k) { for (var i = 0; i < _bootCache.length; i++) if (_bootCache[i].k === k) return _bootCache[i].v; return null; }
function _bootCachePut(k, v) { _bootCache.unshift({ k: k, v: v }); if (_bootCache.length > 12) _bootCache.length = 12; }

function _bootstrapDecline(key, fit, ds, o) {
    var needPosT = !(key === 'arps' || key === 'sepd');
    var w = _fitWindowDays(fit);
    var ser = _rateSeries(ds, { positiveT: needPosT, tminDays: w.tminDays, tmaxDays: w.tmaxDays });
    if (!ser || ser.t.length < 5) return { ok: false, reason: 'Too few rate points for a bootstrap (need 5).' };
    var base = _clone(fit.params);
    var freeze = _frozenObj(fit);
    if (key === 'fetkovich' && freeze.reD === undefined) freeze.reD = true;
    var plan = _paramPlan(key, _fitKeysFor(key, base, freeze));
    if (!plan.length) return { ok: false, reason: 'No free parameters.' };
    var theta0 = _fromParams(plan, base);
    var lo = plan.map(function (pl) { return pl.lo; }), hi = plan.map(function (pl) { return pl.hi; });
    var qv0 = _qVecFor(key, base);
    if (!qv0) return { ok: false, reason: 'Model parameters incomplete.' };
    var qhat = qv0(ser.t), lnq = ser.q.map(Math.log), lnHat = [], res = [];
    for (var i = 0; i < ser.t.length; i++) {
        if (!(qhat[i] > 0)) return { ok: false, reason: 'Model rate is not positive over the data.' };
        lnHat.push(Math.log(qhat[i])); res.push(lnq[i] - lnHat[i]);
    }
    var n = o.n, reps = [], impl = 'local';
    if (o.impl !== 'local' && typeof G.PRiSM_bootstrap === 'function') {
        try {
            var names = plan.map(function (pl) { return (pl.log ? 'ln_' : '') + pl.key; });
            var P0 = {}, bounds = {};
            names.forEach(function (nm, j) { P0[nm] = theta0[j]; bounds[nm] = [lo[j], hi[j]]; });
            var fn = function (tArr, P) {
                var th = names.map(function (nm) { return P[nm]; });
                var qv = _qVecFor(key, _toParams(plan, th, base));
                var qq = qv ? qv(tArr) : [];
                var out = new Array(tArr.length);
                for (var k = 0; k < tArr.length; k++) out[k] = qq[k] > 0 ? Math.log(qq[k]) : -700;
                return out;
            };
            var bs = G.PRiSM_bootstrap(fn, { t: ser.t, p: lnq }, P0,
                { nBootstrap: n, seed: o.seed, bounds: bounds, lmOpts: { maxIter: 40, tolerance: 1e-7 } });
            if (bs && bs.distributions) {
                var m = Infinity;
                names.forEach(function (nm) { var d = bs.distributions[nm]; m = Math.min(m, _isArr(d) ? d.length : 0); });
                for (var r = 0; r < m; r++) {
                    var th = names.map(function (nm) { return +bs.distributions[nm][r]; });
                    if (th.every(_num)) reps.push(_toParams(plan, th, base));
                }
            }
            if (reps.length >= 0.6 * n) impl = 'shared'; else reps = [];
        } catch (e) { reps = []; }
    }
    if (!reps.length) {
        var rng = _rng(o.seed), N = ser.t.length;
        for (var b = 0; b < n; b++) {
            var y = new Array(N);
            for (var k2 = 0; k2 < N; k2++) { var j2 = Math.floor(rng() * N); if (j2 >= N) j2 = N - 1; y[k2] = lnHat[k2] + res[j2]; }
            var fitb = _lm(function (theta) {
                var qv = _qVecFor(key, _toParams(plan, theta, base));
                if (!qv) return null;
                var qm = qv(ser.t), rr = new Array(N);
                for (var k3 = 0; k3 < N; k3++) { if (!(qm[k3] > 0)) return null; rr[k3] = y[k3] - Math.log(qm[k3]); }
                return rr;
            }, theta0, lo, hi, 40);
            if (fitb && fitb.theta.every(_num)) reps.push(_toParams(plan, fitb.theta, base));
        }
    }
    var eurs = [], rems = [], tabs = [], perParam = {};
    plan.forEach(function (pl) { perParam[pl.key] = []; });
    reps.forEach(function (pr) {
        var spec = _declineSpec(key, pr, o.Dmin);
        if (!spec) return;
        var tAb = spec.tAt(o.q_ab);
        var tLim = (o.t_end != null && !(tAb <= o.t_end)) ? o.t_end : tAb;
        if (!(tLim < Infinity)) tLim = o.tCap;
        var eur = spec.cum(tLim);
        if (!_num(eur)) return;
        eurs.push(eur); rems.push(eur - o.Np_hist); tabs.push(tAb);
        plan.forEach(function (pl) { perParam[pl.key].push(pr[pl.key]); });
    });
    if (eurs.length < Math.max(10, 0.3 * n)) return { ok: false, reason: 'Too few successful bootstrap refits (' + eurs.length + ').' };
    var band = function (arr) { var s = _sortNum(arr); return { P90: _pct(s, 0.10), P50: _pct(s, 0.50), P10: _pct(s, 0.90) }; };
    var params = {};
    Object.keys(perParam).forEach(function (k) { var s = _sortNum(perParam[k]); params[k] = { p10: _pct(s, 0.1), p50: _pct(s, 0.5), p90: _pct(s, 0.9) }; });
    return {
        ok: true, n: eurs.length, nRequested: n, impl: impl, seed: o.seed,
        method: 'residual bootstrap on ln q',
        eur: band(eurs), remaining: band(rems), tAb: band(tabs), params: params
    };
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — DECLINE RESULTS (EUR, t_ab, forecast, cross-check)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * EUR / forecast / uncertainty for a rate fit.
 * @param fit  LastFit-shaped rate fit (default: current lastFit if kind 'rate')
 * @param ds   dataset {t (hours), q} (default PRiSM_dataset)
 * @param opts {q_ab, t_end_days | horizonYears, Dmin (nominal 1/d) | DminEffYr (fraction or %),
 *              bootstrap (n, default 200; 0/false = off), seed, bootstrapImpl 'auto'|'local'}
 */
function PRiSM_declineResults(fit, ds, opts) {
    opts = _withSavedDcaOptions(opts || {});
    fit = fit ? _normFit(fit) : _currentRateFit();
    if (!fit) {
        return { ok: false, reason: 'No decline fit yet — fit a rate model (Arps, Duong, SEPD or Fetkovich) to the rate data first.' };
    }
    var key = fit.modelKey, params = fit.params || {};
    if (ds === undefined || ds === null) ds = G.PRiSM_dataset || null;
    var Dmin = _resolveDmin(opts);
    var spec = _declineSpec(key, params, Dmin);
    if (!spec) {
        return { ok: false, modelKey: key, reason: 'Model "' + key + '" is not a decline (rate) model, or its parameters are incomplete.' };
    }
    var warnings = [];
    var units = _rateUnits(_resolveWell(null, ds).fluid);
    var hist = _history(ds);
    var Np_hist = hist ? hist.Np : 0, tLast = hist ? hist.tLast : 0;
    var qRef = _pos(+params.qi) ? +params.qi : (hist && hist.qMax > 0 ? hist.qMax : spec.qPeak);
    var qabDefaulted = !_pos(opts.q_ab);
    var q_ab = qabDefaulted ? 0.01 * qRef : +opts.q_ab;
    var t_end = _pos(opts.t_end_days) ? +opts.t_end_days
              : (_pos(opts.horizonYears) ? +opts.horizonYears * YEAR_D : null);
    var tCap = Math.max(tLast, 0) + TAB_WARN_YEARS * YEAR_D;

    var tAb = spec.tAt(q_ab);
    var tLim, limitedBy;
    if (t_end !== null && !(tAb <= t_end)) { tLim = t_end; limitedBy = 'time'; }
    else { tLim = tAb; limitedBy = 'rate'; }
    if (!(tLim < Infinity)) {
        tLim = tCap; limitedBy = 'cap';
        warnings.push('The rate never falls to q_ab — EUR is shown to ' + TAB_WARN_YEARS + ' years after the end of history.');
    }
    var eur = spec.cum(tLim);
    var eurQab = (tAb < Infinity) ? spec.cum(tAb) : Infinity;
    var remaining = eur - Np_hist;

    var b = _num(+params.b) ? Math.max(0, +params.b) : null;
    var Di = _num(+params.Di) ? +params.Di : null;
    var De = (Di !== null) ? _effAnnual(Di, b || 0) : null;
    if ((key === 'arps' || key === 'fetkovich') && b !== null && b > 1 && !Dmin) {
        warnings.push('b = ' + _fmt(b, 3) + ' > 1 without a terminal decline: EUR is very sensitive to the abandonment rate. Consider setting a terminal decline (Dmin).');
    }
    if (tAb < Infinity && tAb > TAB_WARN_YEARS * YEAR_D) {
        warnings.push('The abandonment rate is reached only after ' + _fmt(tAb / YEAR_D, 3) + ' years (> ' + TAB_WARN_YEARS + ' yr) — check q_ab or add a terminal decline.');
    }
    if (q_ab >= qRef) warnings.push('q_ab is at or above the initial rate — the EUR is zero.');
    if (t_end !== null && t_end < tLast) warnings.push('The time limit ends before the end of the production history.');
    if (hist && remaining < 0) warnings.push('The model cumulative to the limit is below the production to date (remaining < 0) — the well is past its limit or the fit under-predicts the history.');
    if (fit.converged === false) warnings.push('The decline fit did not converge — results are indicative only.');
    if (_num(fit.r2) && fit.r2 < 0.9) warnings.push('Weak decline fit (R² = ' + _fmt(fit.r2, 3) + ').');

    // Monthly forecast from the end of history to the limit.
    var forecast = [], truncated = false;
    if (tLast < tLim) {
        var t0 = tLast, cumT = Np_hist, c0 = spec.cum(t0);
        for (var mth = 1; t0 < tLim - 1e-9; mth++) {
            if (forecast.length >= MAX_FORECAST_ROWS) { truncated = true; break; }
            var t1 = Math.min(t0 + MONTH_D, tLim), c1 = spec.cum(t1), vol = c1 - c0;
            cumT += vol;
            forecast.push({ month: mth, t0: t0, t1: t1, q_start: spec.q(t0), q_end: spec.q(t1),
                            q_avg: vol / (t1 - t0), volume: vol, cum: cumT });
            t0 = t1; c0 = c1;
        }
    } else if (hist) {
        warnings.push('The limit is already reached at the end of the history — no forecast.');
    }
    if (truncated) warnings.push('Forecast table truncated at ' + MAX_FORECAST_ROWS + ' months.');

    // Cross-check against the model library's own EUR (PRiSM_eur_*).
    var crossCheck = null, entry = _models()[key];
    var eurFn = (entry && typeof entry.eur === 'function') ? entry.eur
              : (typeof G['PRiSM_eur_' + key] === 'function' ? G['PRiSM_eur_' + key] : null);
    if (eurFn) {
        var tcc = Math.min(tLim, spec.tSwitch);
        if (tcc > 0 && tcc < Infinity) {
            var reg = NaN;
            try { reg = +eurFn(params, tcc); } catch (e) { reg = NaN; }
            var mine = spec.cum(tcc);
            if (_num(reg) && _num(mine) && mine > 0) {
                var rel = Math.abs(reg - mine) / mine, tol = key === 'arps' ? 1e-3 : 0.05;
                crossCheck = { tDays: tcc, library: reg, layer: mine, relDiff: rel, ok: rel <= tol };
                if (!crossCheck.ok) warnings.push('EUR cross-check against the model library differs by ' + _fmt(rel * 100, 3) + ' %.');
            }
        }
    }

    // P10/P50/P90. Default: run automatically only when it is cheap (closed-form
    // model, ≤ AUTO_BOOT_MAX_POINTS rate points); otherwise on explicit request.
    var nPts = hist ? hist.n : 0;
    var cheap = nPts > 0 && nPts <= AUTO_BOOT_MAX_POINTS && (key === 'arps' || key === 'duong' || key === 'sepd');
    var nb = (opts.bootstrap === false || opts.bootstrap === 0) ? 0
           : (_num(opts.bootstrap) ? Math.max(0, Math.round(opts.bootstrap))
           : (opts.bootstrap === true || cheap ? DEFAULT_BOOT : 0));
    var seed = _num(opts.seed) ? opts.seed : DEFAULT_SEED;
    var pk = [key, JSON.stringify(params), hist ? hist.hash : '-', q_ab, Dmin, t_end, seed,
              JSON.stringify(_fitWindowDays(fit))].join('|');
    var percentiles = (opts.useCachedBootstrap === false) ? null : _bootCacheGet(pk);
    if (!percentiles && nb > 0 && ds) {
        percentiles = _bootstrapDecline(key, fit, ds, {
            n: nb, seed: seed, impl: opts.bootstrapImpl, Dmin: Dmin, q_ab: q_ab, t_end: t_end,
            tCap: tCap, Np_hist: Np_hist
        });
        _bootCachePut(pk, percentiles);
    }

    // Overlay curve (days) for decline plots: log + linear spaced to the limit.
    var overlay = { t: [], q: [] };
    var tHi = Math.min(tLim, tCap), tLo = Math.max(tHi * 1e-4, 1e-4), pts = [0], g;
    for (g = 0; g <= 100; g++) pts.push(Math.exp(Math.log(tLo) + g / 100 * Math.log(tHi / tLo)));
    for (g = 1; g <= 60; g++) pts.push(tHi * g / 60);
    pts = _sortNum(pts);
    for (g = 0; g < pts.length; g++) {
        if (g && pts[g] - pts[g - 1] < 1e-12) continue;
        overlay.t.push(pts[g]); overlay.q.push(spec.q(pts[g]));
    }

    return {
        ok: true, modelKey: key, modelName: _modelName(key), params: _clone(params), units: units,
        qi: _pos(+params.qi) ? +params.qi : null, Di: Di, Di_yr: Di !== null ? Di * YEAR_D : null,
        De: De, b: b,
        Dmin: Dmin, DminEffYr: Dmin ? 1 - Math.exp(-Dmin * YEAR_D) : null,
        tSwitch_days: spec.tSwitch < Infinity ? spec.tSwitch : null,
        qSwitch: spec.tSwitch < Infinity ? spec.qSwitch : null,
        q_ab: q_ab, q_abDefaulted: qabDefaulted, t_end_days: t_end,
        t_ab_days: tAb, t_ab_years: tAb / YEAR_D, t_limit_days: tLim, limitedBy: limitedBy,
        eur: eur, eur_qab: eurQab, Np_hist: Np_hist, t_last_days: tLast,
        q_last_obs: hist ? hist.qLast : null, q_last_model: spec.q(tLast),
        remaining: remaining, forecast: forecast, forecastTruncated: truncated,
        percentiles: percentiles || null, crossCheck: crossCheck, overlay: overlay,
        fit: { r2: fit.r2, rmse: fit.rmse, converged: fit.converged, source: fit.source, impl: fit.impl, ci95: fit.ci95 || null },
        options: { q_ab: q_ab, t_end_days: t_end, Dmin: Dmin, bootstrap: nb },
        warnings: warnings,
        // aliases for report / rail consumers
        EUR: eur, t_ab: tAb,
        bands: (percentiles && percentiles.ok) ? { P90: percentiles.eur.P90, P50: percentiles.eur.P50, P10: percentiles.eur.P10 } : null
    };
}

// When a caller gives no economic limits (q_ab, time limit, terminal decline),
// use the ones the user set in the decline panel so every consumer (panel,
// rail, report) shows the same EUR. opts.useSavedOptions:false disables this.
function _withSavedDcaOptions(opts) {
    var own = _pos(opts.q_ab) || _pos(opts.t_end_days) || _pos(opts.horizonYears) || _pos(opts.Dmin) || _num(opts.DminEffYr);
    if (own || opts.useSavedOptions === false) return opts;
    var saved = _resultsOpts(_dcaOpts());
    var out = {};
    for (var k in saved) if (_has(saved, k) && saved[k] !== undefined) out[k] = saved[k];
    for (var k2 in opts) if (_has(opts, k2) && opts[k2] !== undefined) out[k2] = opts[k2];
    return out;
}

/** Monthly forecast table as CSV text. */
function PRiSM_declineForecastCSV(res) {
    if (!res || !res.ok) return '';
    var u = res.units || { rate: 'STB/d', vol: 'STB' };
    var ru = u.rate.replace('/', '_per_');
    var lines = [['month', 't_start_d', 't_end_d', 'q_start_' + ru, 'q_end_' + ru, 'q_avg_' + ru,
                  'volume_' + u.vol, 'cum_' + u.vol].join(',')];
    var f6 = function (v) { return _num(v) ? String(+v.toPrecision(8)) : ''; };
    res.forecast.forEach(function (r) {
        lines.push([r.month, f6(r.t0), f6(r.t1), f6(r.q_start), f6(r.q_end), f6(r.q_avg), f6(r.volume), f6(r.cum)].join(','));
    });
    return lines.join('\n') + '\n';
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — RATE-TRANSIENT DATA (RNP, NPI, normalised rate, FMB abscissa)
// ─────────────────────────────────────────────────────────────────────────────
// Bourdet-style derivative dy/dx with x = ln(time), points at least L apart.
function _logDeriv(x, y, L) {
    var n = x.length, d = new Array(n);
    function at(i, gap) {
        var i1 = i - 1, i2 = i + 1;
        while (i1 >= 0 && x[i] - x[i1] < gap) i1--;
        while (i2 < n && x[i2] - x[i] < gap) i2++;
        // Near the ends use the last available point (shorter window) rather than
        // switching to a one-sided difference, which would kink the derivative.
        if (i1 < 0) i1 = (i > 0 && x[i] > x[0]) ? 0 : -1;
        if (i2 >= n) i2 = (i < n - 1 && x[n - 1] > x[i]) ? n - 1 : n;
        if (i1 < 0 && i2 >= n) return NaN;
        if (i1 < 0) return (y[i2] - y[i]) / (x[i2] - x[i]);
        if (i2 >= n) return (y[i] - y[i1]) / (x[i] - x[i1]);
        var dl1 = x[i] - x[i1], dl2 = x[i2] - x[i];
        return ((y[i] - y[i1]) / dl1) * dl2 / (dl1 + dl2) + ((y[i2] - y[i]) / dl2) * dl1 / (dl1 + dl2);
    }
    for (var i = 0; i < n; i++) {
        var v = at(i, Math.max(L, 1e-12));
        if (!_num(v)) v = at(i, 1e-12);
        d[i] = v;
    }
    return d;
}
// Local log-log slope d ln y / d ln x (x given as ln values), points ≥ gap apart.
function _llSlope(x, y, gap) {
    var n = x.length, s = new Array(n);
    for (var i = 0; i < n; i++) {
        var i1 = i, i2 = i;
        while (i1 > 0 && x[i] - x[i1] < gap) i1--;
        while (i2 < n - 1 && x[i2] - x[i] < gap) i2++;
        if (i1 === i2 || !(y[i1] > 0) || !(y[i2] > 0) || x[i2] === x[i1]) { s[i] = NaN; continue; }
        s[i] = (Math.log(y[i2]) - Math.log(y[i1])) / (x[i2] - x[i1]);
    }
    return s;
}
// Contiguous blocks of true (tolerating single-point gaps).
function _blocks(mask) {
    var out = [], start = -1, gap = 0;
    for (var i = 0; i < mask.length; i++) {
        if (mask[i]) { if (start < 0) start = i; gap = 0; }
        else if (start >= 0) {
            gap++;
            if (gap > 1 || i === mask.length - 1) { out.push([start, i - gap]); start = -1; gap = 0; }
        }
    }
    if (start >= 0) out.push([start, mask.length - 1 - gap]);
    return out.filter(function (b) { return b[1] >= b[0]; });
}

var _mpCache = null;
function _mpFunction(w, pMax) {
    function asFn(tb) {
        if (typeof tb === 'function') return tb;
        if (tb && typeof tb.m === 'function') return function (p) { return tb.m(p); };
        if (tb && typeof tb.interp === 'function') return function (p) { return tb.interp(p); };
        if (tb && _isArr(tb.p) && _isArr(tb.m) && tb.p.length > 1) return _interpFn(tb.p, tb.m);
        return null;
    }
    if (typeof G.PRiSM_mpTable === 'function') {
        try { var f = asFn(G.PRiSM_mpTable(w)); if (f) return f; } catch (e) { /* fall through */ }
    }
    var corr = G.PRiSM_pvt_correlations;
    if (!corr || typeof corr.m_p !== 'function') return null;
    var pvt = G.PRiSM_pvt || {};
    var TF = _num(pvt.T_res) ? pvt.T_res : (_num(w.T_R) ? (w.T_R > 460 ? w.T_R - 459.67 : w.T_R) : null);
    var SG = _firstNum([w.sg, pvt.SG_g]);
    if (!_num(TF) || !_num(SG)) return null;
    var top = Math.max(1.2 * pMax, 500);
    var ck = TF + '|' + SG + '|' + Math.round(top);
    if (_mpCache && _mpCache.key === ck) return _mpCache.fn;
    var P = [], M = [];
    for (var i = 0; i < 200; i++) {
        var p = 14.7 + (top - 14.7) * i / 199, m = corr.m_p(p, TF, SG);
        if (!_num(m)) return null;
        P.push(p); M.push(m);
    }
    var fn = _interpFn(P, M);
    _mpCache = { key: ck, fn: fn };
    return fn;
}
function _interpFn(X, Y) {
    return function (x) {
        var n = X.length;
        if (x <= X[0]) return Y[0] * (x / X[0]) * (x / X[0]);        // m(p) ~ p² near 0
        if (x >= X[n - 1]) return Y[n - 1] + (Y[n - 1] - Y[n - 2]) / (X[n - 1] - X[n - 2]) * (x - X[n - 1]);
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (X[mid] <= x) lo = mid; else hi = mid; }
        return Y[lo] + (Y[hi] - Y[lo]) * (x - X[lo]) / (X[hi] - X[lo]);
    };
}

/**
 * Rate-transient series from a dataset with BOTH flowing pressure and rate.
 * @param ds    {t (hours), p, q} (default PRiSM_dataset)
 * @param well  optional overrides for C1 well inputs {pi, B, mu, ct, h, phi, rw, fluid, testType}
 * @param opts  {pi, L (ln units, default st.bourdetL or 0.1), pseudo:false, timeUnit}
 */
function PRiSM_rtaData(ds, well, opts) {
    opts = opts || {};
    if (ds === undefined || ds === null) ds = G.PRiSM_dataset || null;
    if (!ds || !_isArr(ds.t) || !ds.t.length) return { ok: false, reason: 'No dataset loaded.' };
    if (!_isArr(ds.q)) {
        return { ok: false, needsRate: true, reason: 'Rate-transient analysis needs the flow rate (q) as well as the flowing pressure.' };
    }
    if (!_isArr(ds.p)) {
        return { ok: false, needsPressure: true, reason: 'Rate-transient analysis needs flowing pressure as well as rate — load a file with a pressure column.' };
    }
    var w = _resolveWell(well, ds);
    var fac = _timeToDays(ds, opts), warnings = [];
    var rowsQ = [];
    for (var i = 0; i < ds.t.length; i++) {
        var t = +ds.t[i] * fac, q = +ds.q[i];
        if (!isFinite(t) || !isFinite(q) || t < 0) continue;
        var p = (ds.p[i] === null || ds.p[i] === undefined || ds.p[i] === '') ? NaN : +ds.p[i];
        rowsQ.push({ t: t, q: q, p: p, i: i });
    }
    rowsQ.sort(function (a, b) { return a.t - b.t || a.i - b.i; });
    var withP = rowsQ.filter(function (r) { return _num(r.p); });
    if (withP.length < 3) return { ok: false, needsPressure: true, reason: 'Too few rows with time, pressure and rate.' };

    // Production vs injection (sign-aware Δp).
    var tt = String(w.testType || 'auto').toLowerCase();
    var qMed = _median(rowsQ.map(function (r) { return r.q; }));
    var inj = (tt === 'injection' || tt === 'falloff') || qMed < 0;
    var pi = _num(opts.pi) ? +opts.pi : (_num(w.pi) ? +w.pi : null);
    var piSource = _num(opts.pi) ? 'input' : (_num(w.pi) ? 'well' : null);
    var pMed = _median(withP.map(function (r) { return r.p; }));
    if (pi === null) {
        var early = withP.filter(function (r) { return Math.abs(r.q) > 0; }).slice(0, 3);
        var reg = early.length >= 2 ? _linreg(early.map(function (r) { return r.t; }), early.map(function (r) { return r.p; })) : null;
        pi = reg ? reg.intercept : withP[0].p;
        piSource = 'extrapolated';
        if (!(tt === 'drawdown' || tt === 'buildup' || inj)) {
            var s = (withP[withP.length - 1].p - withP[0].p) >= 0 ? 1 : -1;   // CLAUDE.md sign rule
            inj = s > 0;
        }
        warnings.push('Initial pressure pi is not set — estimated by extrapolating the first flowing pressures to t = 0. RNP levels and the material-balance / linear-flow intercepts are biased; set pi in Well & Test on the Data step.');
    } else if (!(tt === 'drawdown' || tt === 'buildup' || tt === 'injection' || tt === 'falloff') && qMed >= 0 && pMed > pi) {
        inj = true;
        warnings.push('Flowing pressures are above pi — treated as injection (Δp = pwf − pi).');
    }

    // Gas: pseudo-pressure when available.
    var pseudo = false, mFn = null;
    if (w.fluid === 'gas' && opts.pseudo !== false) {
        var pMax = Math.max(pi, Math.max.apply(null, withP.map(function (r) { return r.p; })));
        mFn = _mpFunction(w, pMax);
        if (mFn) {
            pseudo = true;
            warnings.push('Gas: pseudo-pressure Δm(p) is used; material-balance pseudo-time is not applied yet (tc uses real time), so boundary-dominated results are approximate.');
        } else {
            warnings.push('Gas: m(p) is unavailable (needs gas gravity and temperature) — plain Δp in psi is used.');
        }
    }
    var mPi = pseudo ? mFn(pi) : null;

    // Cumulative (every row with a rate, shut-ins included) and flowing points.
    var qa = rowsQ.map(function (r) { return inj ? Math.abs(r.q) : Math.max(0, r.q); });
    var NpAll = new Array(rowsQ.length);
    NpAll[0] = qa[0] * rowsQ[0].t;
    for (var k = 1; k < rowsQ.length; k++) NpAll[k] = NpAll[k - 1] + 0.5 * (qa[k] + qa[k - 1]) * (rowsQ[k].t - rowsQ[k - 1].t);
    var qMaxA = Math.max.apply(null, qa), qTol = 1e-6 * qMaxA;
    var pts = [], nShut = 0, nNeg = 0;
    for (var k2 = 0; k2 < rowsQ.length; k2++) {
        var r = rowsQ[k2];
        if (!_num(r.p)) continue;
        if (!(qa[k2] > qTol) || !(r.t > 0)) { nShut++; continue; }
        var dp = pseudo ? (inj ? mFn(r.p) - mPi : mPi - mFn(r.p)) : (inj ? r.p - pi : pi - r.p);
        if (!(dp > 0)) { nNeg++; continue; }
        var tc = NpAll[k2] / qa[k2];
        if (!(tc > 0)) continue;
        pts.push({ t: r.t, tc: tc, q: qa[k2], p: r.p, dp: dp, Np: NpAll[k2], i: r.i });
    }
    if (nShut) warnings.push(nShut + ' point(s) with no flow were skipped (they still count in the cumulative).');
    if (nNeg) warnings.push(nNeg + ' point(s) with Δp ≤ 0 were skipped — check pi and the test type.');
    if (pts.length < 3) {
        return { ok: false, reason: 'Fewer than 3 flowing points with a positive pressure drop — check pi and the test type.', warnings: warnings, pi: pi, piSource: piSource };
    }
    pts.sort(function (a, b) { return a.tc - b.tc || a.t - b.t; });

    var n = pts.length;
    var st = _st();
    var L = _num(opts.L) ? opts.L : (st && _num(st.bourdetL) ? st.bourdetL : 0.1);
    var tc_ = [], lnTc = [], rnp = [], qdp = [];
    pts.forEach(function (o) { tc_.push(o.tc); lnTc.push(Math.log(o.tc)); rnp.push(o.dp / o.q); qdp.push(o.q / o.dp); });
    var rnpd = _logDeriv(lnTc, rnp, L);
    var I1 = rnp[0] * tc_[0], I2 = qdp[0] * tc_[0], rnpi = [], qdpi = [], rnpid = [], qdpid = [];
    for (var j = 0; j < n; j++) {
        if (j > 0) {
            var dtc = tc_[j] - tc_[j - 1];
            I1 += 0.5 * (rnp[j] + rnp[j - 1]) * dtc;
            I2 += 0.5 * (qdp[j] + qdp[j - 1]) * dtc;
        }
        rnpi.push(I1 / tc_[j]); qdpi.push(I2 / tc_[j]);
        rnpid.push(rnp[j] - rnpi[j]);                 // d(RNPi)/d ln tc
        qdpid.push(qdpi[j] - qdp[j]);                 // −d((q/Δp)i)/d ln tc
    }
    var ct = _num(w.ct) ? +w.ct : null;
    var fmbX = pts.map(function (o) { return (ct && !pseudo) ? o.Np / (ct * o.dp) : NaN; });
    var units = _rateUnits(w.fluid);
    var missing = ['B', 'mu', 'ct', 'h', 'phi', 'rw'].filter(function (k3) { return !_pos(+w[k3]); });
    var qs = pts.map(function (o) { return o.q; }), dps = pts.map(function (o) { return o.dp; });
    return {
        ok: true, n: n, fluid: w.fluid, pseudo: pseudo, injection: inj,
        pi: pi, piSource: piSource, L: L, well: w, missing: missing, units: units,
        dpUnit: pseudo ? 'psi²/cp' : 'psi',
        rnpUnit: (pseudo ? 'psi²/cp' : 'psi') + '/(' + units.rate + ')',
        tDays: pts.map(function (o) { return o.t; }), tc: tc_, q: qs, p: pts.map(function (o) { return o.p; }),
        dp: dps, Np: pts.map(function (o) { return o.Np; }), idx: pts.map(function (o) { return o.i; }),
        rnp: rnp, rnpd: rnpd, rnpi: rnpi, rnpid: rnpid, qdp: qdp, qdpi: qdpi, qdpid: qdpid,
        fmbX: fmbX, sqrtT: pts.map(function (o) { return Math.sqrt(o.t); }),
        NpTotal: NpAll[NpAll.length - 1], cvQ: _cv(qs), cvDp: _cv(dps),
        warnings: warnings
    };
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — RTA ANALYSES (FMB, linear flow, Agarwal–Gardner)
// ─────────────────────────────────────────────────────────────────────────────
function _selectByRange(v, lo, hi) {
    var sel = [];
    for (var i = 0; i < v.length; i++) if (v[i] >= lo && v[i] <= hi) sel.push(i);
    return sel;
}

/**
 * Flowing material balance on boundary-dominated points.
 * opts: {Sw (0), S (0), tcMin, tcMax (days), bdfSlopeMin (0.85), ct}
 */
function PRiSM_rtaFMB(rta, opts) {
    opts = opts || {};
    if (!rta || !rta.ok) return { ok: false, reason: (rta && rta.reason) || 'No rate-transient data.' };
    if (rta.pseudo) return { ok: false, reason: 'Gas flowing material balance needs material-balance pseudo-time, which is not available yet — oil and water only.' };
    var w = rta.well, ct = _pos(opts.ct) ? +opts.ct : (_pos(+w.ct) ? +w.ct : null);
    if (!ct) return { ok: false, reason: 'Total compressibility ct is missing — set it in Well & Test on the Data step.' };
    var n = rta.n, x = [], y = [], warnings = [];
    for (var i = 0; i < n; i++) { x.push(rta.Np[i] / (ct * rta.dp[i])); y.push(rta.qdp[i]); }
    var sel = null, method;
    if (_num(opts.tcMin) || _num(opts.tcMax)) {
        sel = _selectByRange(rta.tc, _num(opts.tcMin) ? opts.tcMin : 0, _num(opts.tcMax) ? opts.tcMax : Infinity);
        method = 'manual tc window';
    } else {
        var lnTc = rta.tc.map(Math.log), sl = _llSlope(lnTc, rta.rnpd, 0.2);
        var smin = _num(opts.bdfSlopeMin) ? opts.bdfSlopeMin : 0.85;
        var blocks = _blocks(sl.map(function (s) { return s >= smin; }));
        var minLen = Math.max(5, Math.ceil(0.08 * n));
        for (var b = blocks.length - 1; b >= 0; b--) {
            if (blocks[b][1] - blocks[b][0] + 1 >= minLen) {
                // The last few derivative points carry the usual end effect; a
                // boundary-dominated block that reaches them keeps them.
                var end = (blocks[b][1] >= n - 4) ? n - 1 : blocks[b][1];
                sel = []; for (var k = blocks[b][0]; k <= end; k++) sel.push(k);
                method = 'auto: unit-slope RNP′ (boundary-dominated flow)';
                break;
            }
        }
        if (!sel) {
            sel = []; for (var k2 = Math.floor(0.7 * n); k2 < n; k2++) sel.push(k2);
            method = 'auto: last 30 % of points';
            warnings.push('Boundary-dominated flow is not clearly identified (no unit-slope RNP′) — the last 30 % of points were used.');
        }
    }
    if (sel.length < 3) return { ok: false, reason: 'Fewer than 3 points in the material-balance window.' };
    var reg = _linreg(sel.map(function (k3) { return x[k3]; }), sel.map(function (k3) { return y[k3]; }));
    if (!reg || !(reg.slope < 0) || !(reg.intercept > 0)) {
        return { ok: false, idx: sel, method: method, x: x, reason: 'No boundary-dominated decline on the selected points (q/Δp must fall as Np/(ct·Δp) grows).' };
    }
    var X = -reg.intercept / reg.slope, bpss = 1 / reg.intercept;
    var Sw = _num(opts.Sw) ? Math.min(Math.max(+opts.Sw, 0), 0.99) : 0;
    var S = _num(opts.S) ? +opts.S : 0;
    var B = +w.B, mu = +w.mu, h = +w.h, phi = +w.phi, rw = +w.rw;
    var out = {
        ok: true, n: sel.length, idx: sel, method: method, slope: reg.slope, intercept: reg.intercept, r2: reg.r2,
        x: x, X: X, N: X * (1 - Sw), Sw: Sw, S: S, ct: ct, b_pss: bpss,
        Vp_rb: null, A_ft2: null, A_acres: null, re_ft: null, kh: null, k: null, warnings: warnings, missing: []
    };
    if (_pos(B)) out.Vp_rb = X * B; else out.missing.push('B');
    if (_pos(B) && _pos(h) && _pos(phi)) {
        out.A_ft2 = 5.615 * X * B / (h * phi);
        out.A_acres = out.A_ft2 / 43560;
        out.re_ft = Math.sqrt(out.A_ft2 / Math.PI);
    } else { if (!_pos(h)) out.missing.push('h'); if (!_pos(phi)) out.missing.push('phi'); }
    if (out.re_ft && _pos(mu) && _pos(rw)) {
        var rwa = rw * Math.exp(-S), lnTerm = Math.log(out.re_ft / rwa) - 0.75;
        if (lnTerm > 0) {
            out.kh = 141.2 * B * mu / bpss * lnTerm;
            out.k = out.kh / h;
        }
    } else { if (!_pos(mu)) out.missing.push('mu'); if (!_pos(rw)) out.missing.push('rw'); }
    if (out.missing.length) warnings.push('Missing well inputs (' + out.missing.join(', ') + ') — area and permeability cannot be computed.');
    if (!_num(opts.S)) warnings.push('kh assumes zero skin (enter S to refine).');
    return out;
}

/**
 * Linear-flow (√t) analysis: RNP = b′ + m′·√t (t in days).
 * opts: {tMin, tMax (days), condition 'auto'|'rate'|'pwf', k (md)}
 */
function PRiSM_rtaLinearFlow(rta, opts) {
    opts = opts || {};
    if (!rta || !rta.ok) return { ok: false, reason: (rta && rta.reason) || 'No rate-transient data.' };
    var n = rta.n, warnings = [], sel = null, method;
    if (_num(opts.tMin) || _num(opts.tMax)) {
        sel = _selectByRange(rta.tDays, _num(opts.tMin) ? opts.tMin : 0, _num(opts.tMax) ? opts.tMax : Infinity);
        method = 'manual time window';
    } else {
        var lnTc = rta.tc.map(Math.log), sl = _llSlope(lnTc, rta.rnpd, 0.2);
        var blocks = _blocks(sl.map(function (s) { return s >= 0.35 && s <= 0.65; }));
        var best = null;
        blocks.forEach(function (b) { if (b[1] - b[0] + 1 >= 5 && (!best || b[1] - b[0] > best[1] - best[0])) best = b; });
        if (best) {
            sel = []; for (var k = best[0]; k <= best[1]; k++) sel.push(k);
            method = 'auto: half-slope RNP′ (linear flow)';
        } else {
            sel = []; for (var k2 = 0; k2 < n; k2++) sel.push(k2);
            method = 'all points';
            warnings.push('No half-slope (linear-flow) region found in RNP′ — all points were used; the result is only meaningful if the √t plot is straight.');
        }
    }
    if (sel.length < 3) return { ok: false, reason: 'Fewer than 3 points in the linear-flow window.' };
    var reg = _linreg(sel.map(function (i) { return rta.sqrtT[i]; }), sel.map(function (i) { return rta.rnp[i]; }));
    if (!reg || !(reg.slope > 0)) return { ok: false, idx: sel, method: method, reason: 'RNP does not increase with √t on the selected points.' };
    if (method === 'all points' && !(reg.r2 >= 0.98)) {
        return { ok: false, idx: [], method: method, r2: reg.r2,
                 reason: 'No linear-flow (half-slope) region in the data and RNP is not straight against √t (R² ' + _fmt(reg.r2, 3) + ') — linear-flow analysis does not apply.' };
    }
    var cvQ = _cv(sel.map(function (i) { return rta.q[i]; })), cvDp = _cv(sel.map(function (i) { return rta.dp[i]; }));
    var cond = (opts.condition === 'rate' || opts.condition === 'pwf') ? opts.condition
             : ((_num(cvQ) && _num(cvDp) && cvDp < cvQ) ? 'pwf' : 'rate');
    var factor = cond === 'pwf' ? Math.PI / 2 : 1;
    var w = rta.well, B = +w.B, h = +w.h, mu = +w.mu, phi = +w.phi, ct = +w.ct;
    var out = {
        ok: true, n: sel.length, idx: sel, method: method, slope: reg.slope, intercept: reg.intercept, r2: reg.r2,
        condition: cond, conditionAuto: !(opts.condition === 'rate' || opts.condition === 'pwf'), factor: factor,
        xf_sqrt_k: null, k: null, kSource: null, xf: null, warnings: warnings, missing: []
    };
    ['B', 'h', 'mu', 'phi', 'ct'].forEach(function (k3) { if (!_pos(+w[k3])) out.missing.push(k3); });
    if (rta.pseudo) {
        warnings.push('Gas: the √t constant for pseudo-pressure is not applied yet — slope only.');
    } else if (!out.missing.length) {
        out.xf_sqrt_k = factor * LF_CONST * B / (h * reg.slope) * Math.sqrt(mu / (phi * ct));
    } else {
        warnings.push('Missing well inputs (' + out.missing.join(', ') + ') — xf·√k cannot be computed.');
    }
    var k = _pos(opts.k) ? +opts.k : null, kSrc = k ? 'input' : null;
    if (!k) {
        var lf = null;
        if (typeof G.PRiSM_getLastFit === 'function') { try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; } }
        if (!lf && _st()) lf = _st().lastFit;
        if (lf && lf.phys && _pos(+lf.phys.k) && lf.kind !== 'rate') { k = +lf.phys.k; kSrc = 'pressure fit'; }
    }
    if (k && out.xf_sqrt_k) { out.k = k; out.kSource = kSrc; out.xf = out.xf_sqrt_k / Math.sqrt(k); }
    return out;
}

/**
 * Agarwal–Gardner dimensionless rate vs area time. Needs kh, k and drainage
 * area — taken from opts or from the flowing material balance.
 */
function PRiSM_rtaAG(rta, opts) {
    opts = opts || {};
    if (!rta || !rta.ok) return { ok: false, reason: (rta && rta.reason) || 'No rate-transient data.' };
    var fmb = opts.fmb || null;
    if (!fmb && !(_pos(opts.kh) && _pos(opts.k) && _pos(opts.A_ft2))) fmb = PRiSM_rtaFMB(rta, opts);
    var kh = _pos(opts.kh) ? +opts.kh : (fmb && fmb.ok ? fmb.kh : null);
    var k = _pos(opts.k) ? +opts.k : (fmb && fmb.ok ? fmb.k : null);
    var A = _pos(opts.A_ft2) ? +opts.A_ft2 : (fmb && fmb.ok ? fmb.A_ft2 : null);
    var w = rta.well, B = +w.B, mu = +w.mu, phi = +w.phi, ct = +w.ct;
    if (!_pos(kh) || !_pos(k) || !_pos(A) || !_pos(B) || !_pos(mu) || !_pos(phi) || !_pos(ct)) {
        return { ok: false, reason: 'The dimensionless plot needs k·h and the drainage area — available once the flowing material balance finds a boundary-dominated trend (and B, μ, φ, ct are set).' };
    }
    if (rta.pseudo) return { ok: false, reason: 'Gas dimensionless rate needs pseudo-time — not available yet.' };
    var cq = 141.2 * B * mu / kh, ctA = 0.0002637 * k * 24 / (phi * mu * ct * A);
    var bD = (fmb && fmb.ok && _pos(fmb.b_pss)) ? kh * fmb.b_pss / (141.2 * B * mu) : null;
    return {
        ok: true, kh: kh, k: k, A_ft2: A, bD: bD,
        tDA: rta.tc.map(function (t) { return ctA * t; }),
        qD: rta.qdp.map(function (v) { return cq * v; }),
        qDi: rta.qdpi.map(function (v) { return cq * v; }),
        qDid: rta.qdpid.map(function (v) { return cq * v; })
    };
}

/** Convenience bundle for report / rail consumers. */
function PRiSM_rtaSummary(ds, well, opts) {
    opts = opts || {};
    var rta = PRiSM_rtaData(ds, well, opts);
    if (!rta.ok) return { ok: false, reason: rta.reason, rta: rta };
    var fmb = PRiSM_rtaFMB(rta, opts);
    return { ok: true, rta: rta, fmb: fmb, linear: PRiSM_rtaLinearFlow(rta, opts), ag: PRiSM_rtaAG(rta, { fmb: fmb }) };
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — CANVAS CHARTS (self-contained, dark theme, C6 _prismAxes)
// ─────────────────────────────────────────────────────────────────────────────
var THEME_FALLBACK = {
    bg: '#0d1117', panel: '#161b22', border: '#30363d', grid: '#21262d', gridMajor: '#30363d',
    text: '#c9d1d9', text2: '#8b949e', text3: '#6e7681', accent: '#f0883e', blue: '#58a6ff',
    green: '#3fb950', red: '#f85149', yellow: '#d29922', cyan: '#39c5cf', purple: '#bc8cff'
};
function _theme() {
    try { if (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME && PRiSM_THEME.bg) return PRiSM_THEME; } catch (e) { /* not in scope */ }
    return THEME_FALLBACK;
}
function _fmtTick(v) {
    if (v === 0) return '0';
    if (!_num(v)) return '';
    var a = Math.abs(v);
    if (a >= 1e12 || a < 1e-3) {
        var e = Math.round(Math.log10(a));
        if (Math.abs(a / Math.pow(10, e) - 1) < 1e-9) return (v < 0 ? '-' : '') + '1e' + e;
        return v.toExponential(1).replace('e+', 'e');
    }
    if (a >= 1e9) return _trim0((v / 1e9).toPrecision(3)) + 'G';
    if (a >= 1e6) return _trim0((v / 1e6).toPrecision(3)) + 'M';
    if (a >= 1e3) return _trim0((v / 1e3).toPrecision(3)) + 'k';
    return _trim0(v.toPrecision(3));
}
function _logTicks(min, max) {
    var major = [], minor = [];
    var k0 = Math.floor(Math.log10(min)), k1 = Math.ceil(Math.log10(max));
    var stepDec = (k1 - k0) > 8 ? 2 : 1;
    for (var k = k0; k <= k1; k++) {
        var base = Math.pow(10, k);
        if (base >= min * (1 - 1e-9) && base <= max * (1 + 1e-9) && (k - k0) % stepDec === 0) major.push(base);
        if (k1 - k0 <= 6) for (var m = 2; m <= 9; m++) { var v = m * base; if (v > min && v < max) minor.push(v); }
    }
    return { major: major, minor: minor };
}
function _linTicks(min, max, target) {
    var span = max - min;
    if (!(span > 0)) return [min];
    var rough = span / target, mag = Math.pow(10, Math.floor(Math.log10(rough))), nrm = rough / mag;
    var step = (nrm < 1.5 ? 1 : nrm < 3 ? 2 : nrm < 7 ? 5 : 10) * mag;
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
}
function _range(vals, log, incZero) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < vals.length; i++) {
        var v = vals[i];
        if (!_num(v) || (log && !(v > 0))) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (incZero && !log) { min = Math.min(min, 0); max = Math.max(max, 0); }
    if (!(min <= max)) return null;
    if (log) {
        var lo = Math.pow(10, Math.floor(Math.log10(min) + 1e-9)), hi = Math.pow(10, Math.ceil(Math.log10(max) - 1e-9));
        if (!(hi > lo)) hi = lo * 10;
        return { min: lo, max: hi };
    }
    if (min === max) { var d = Math.abs(min) * 0.1 || 1; return { min: min - d, max: max + d }; }
    var pad = (max - min) * 0.05;
    return { min: (incZero && min === 0) ? 0 : min - pad, max: max + pad };
}
function _wrapText(ctx, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], cur = '';
    var meas = function (s) { try { var m = ctx.measureText(s); if (m && _num(m.width) && m.width > 0) return m.width; } catch (e) { /* ignore */ } return s.length * 6.5; };
    words.forEach(function (wd) {
        var tryS = cur ? cur + ' ' + wd : wd;
        if (meas(tryS) > maxW && cur) { lines.push(cur); cur = wd; } else cur = tryS;
    });
    if (cur) lines.push(cur);
    return lines;
}

// spec: {title, shortTitle, xLabel, yLabel, xKind, yKind, xZero, yZero, series:[{x,y,color,type,r,dash,width,label}],
//        message, notes:[...], plotKey}
function _drawChart(canvas, spec, opts) {
    opts = opts || {};
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    var T = _theme(), dpr = G.devicePixelRatio || 1;
    var cssW = opts.width || canvas.clientWidth || (canvas.width ? canvas.width / dpr : 0) || 600;
    var cssH = opts.height || canvas.clientHeight || Math.round(Math.min(cssW * 0.62, 420));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var narrow = cssW < 480;
    var pad = { top: 26, right: narrow ? 12 : 20, bottom: 42, left: narrow ? 50 : 62 };
    var plot = { x: pad.left, y: pad.top, w: Math.max(cssW - pad.left - pad.right, 40), h: Math.max(cssH - pad.top - pad.bottom, 40) };
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, cssW, cssH);
    var title = (narrow && spec.shortTitle) ? spec.shortTitle : spec.title;
    if (title) {
        ctx.fillStyle = T.text; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(title, 8, 7);
    }
    ctx.fillStyle = T.panel; ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
    ctx.strokeStyle = T.border; ctx.lineWidth = 1; ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);
    if (spec.message) {
        ctx.fillStyle = T.text2; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var lines = _wrapText(ctx, spec.message, plot.w - 24);
        lines.forEach(function (ln, i) { ctx.fillText(ln, plot.x + plot.w / 2, plot.y + plot.h / 2 + (i - (lines.length - 1) / 2) * 17); });
        try { canvas._prismAxes = null; } catch (e) { /* ignore */ }
        return { message: spec.message };
    }
    var xs = [], ys = [];
    (spec.series || []).forEach(function (s) { if (s.range === false) return; xs = xs.concat(s.x || []); ys = ys.concat(s.y || []); });
    if (spec.extraX) xs = xs.concat(spec.extraX);
    if (spec.extraY) ys = ys.concat(spec.extraY);
    var xLog = spec.xKind === 'log', yLog = spec.yKind === 'log';
    var xr = _range(xs, xLog, spec.xZero), yr = _range(ys, yLog, spec.yZero);
    if (!xr || !yr) return _drawChart(canvas, { title: spec.title, shortTitle: spec.shortTitle, message: spec.emptyMessage || 'No positive data to plot.' }, opts);
    var lx0 = xLog ? Math.log10(xr.min) : xr.min, lx1 = xLog ? Math.log10(xr.max) : xr.max;
    var ly0 = yLog ? Math.log10(yr.min) : yr.min, ly1 = yLog ? Math.log10(yr.max) : yr.max;
    var toX = function (v) { return plot.x + ((xLog ? Math.log10(v) : v) - lx0) / (lx1 - lx0) * plot.w; };
    var toY = function (v) { return plot.y + plot.h - ((yLog ? Math.log10(v) : v) - ly0) / (ly1 - ly0) * plot.h; };
    var fromX = function (px) { var u = lx0 + (px - plot.x) / plot.w * (lx1 - lx0); return xLog ? Math.pow(10, u) : u; };
    var fromY = function (py) { var u = ly0 + (plot.y + plot.h - py) / plot.h * (ly1 - ly0); return yLog ? Math.pow(10, u) : u; };

    // grid + ticks
    var xt = xLog ? _logTicks(xr.min, xr.max) : { major: _linTicks(xr.min, xr.max, narrow ? 4 : 6), minor: [] };
    var yt = yLog ? _logTicks(yr.min, yr.max) : { major: _linTicks(yr.min, yr.max, narrow ? 4 : 6), minor: [] };
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.grid;
    ctx.beginPath();
    xt.minor.forEach(function (v) { var px = Math.round(toX(v)) + 0.5; ctx.moveTo(px, plot.y); ctx.lineTo(px, plot.y + plot.h); });
    yt.minor.forEach(function (v) { var py = Math.round(toY(v)) + 0.5; ctx.moveTo(plot.x, py); ctx.lineTo(plot.x + plot.w, py); });
    ctx.stroke();
    ctx.strokeStyle = T.gridMajor;
    ctx.fillStyle = T.text2; ctx.font = '11px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    xt.major.forEach(function (v) {
        var px = Math.round(toX(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(px, plot.y); ctx.lineTo(px, plot.y + plot.h); ctx.stroke();
        ctx.fillText(_fmtTick(v), px, plot.y + plot.h + 5);
    });
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    yt.major.forEach(function (v) {
        var py = Math.round(toY(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(plot.x, py); ctx.lineTo(plot.x + plot.w, py); ctx.stroke();
        ctx.fillText(_fmtTick(v), plot.x - 5, py);
    });
    ctx.fillStyle = T.text; ctx.font = '12px sans-serif';
    if (spec.xLabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(spec.xLabel, plot.x + plot.w / 2, cssH - 4); }
    if (spec.yLabel) {
        ctx.save(); ctx.translate(12, plot.y + plot.h / 2); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(spec.yLabel, 0, 0); ctx.restore();
    }

    // series (clipped)
    ctx.save();
    ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
    var okPt = function (x, y) { return _num(x) && _num(y) && (!xLog || x > 0) && (!yLog || y > 0); };
    (spec.series || []).forEach(function (s) {
        var col = s.color || T.accent, xsA = s.x || [], ysA = s.y || [];
        if (s.type === 'line') {
            ctx.strokeStyle = col; ctx.lineWidth = s.width || 2;
            if (s.dash && ctx.setLineDash) ctx.setLineDash(s.dash);
            ctx.beginPath();
            var started = false;
            for (var i = 0; i < xsA.length; i++) {
                if (!okPt(xsA[i], ysA[i])) { started = false; continue; }
                var px = toX(xsA[i]), py = toY(ysA[i]);
                if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
            }
            ctx.stroke();
            if (s.dash && ctx.setLineDash) ctx.setLineDash([]);
        } else {
            var r = s.r || 2.6;
            ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
            for (var j = 0; j < xsA.length; j++) {
                if (!okPt(xsA[j], ysA[j])) continue;
                ctx.beginPath(); ctx.arc(toX(xsA[j]), toY(ysA[j]), r, 0, Math.PI * 2);
                if (s.type === 'hollow') ctx.stroke(); else ctx.fill();
            }
        }
    });
    ctx.restore();

    // legend (series with no drawable point are left out)
    var items = (spec.series || []).filter(function (s) {
        if (!s.label) return false;
        var xsA = s.x || [], ysA = s.y || [];
        for (var i = 0; i < xsA.length; i++) if (okPt(xsA[i], ysA[i])) return true;
        return false;
    });
    // notes are wrapped to the plot width (at most 3 lines)
    var noteLines = [];
    if (spec.notes && spec.notes.length) {
        ctx.font = '11px sans-serif';
        spec.notes.forEach(function (nt) { noteLines = noteLines.concat(_wrapText(ctx, nt, plot.w - 16)); });
        noteLines = noteLines.slice(0, 3);
    }
    if (items.length) {
        ctx.save();
        ctx.font = '11px sans-serif';
        var lw = 0;
        items.forEach(function (s) {
            var wdt = 0;
            try { wdt = ctx.measureText(s.label).width; } catch (e) { wdt = 0; }
            if (!_num(wdt) || wdt <= 0) wdt = s.label.length * 6;
            lw = Math.max(lw, wdt);
        });
        var bw = Math.min(lw + 34, plot.w - 8), bh = items.length * 15 + 8;
        // Put the legend in the corner that hides the fewest data points.
        var corners = [
            [plot.x + plot.w - bw - 4, plot.y + 4], [plot.x + 4, plot.y + 4],
            [plot.x + plot.w - bw - 4, plot.y + plot.h - bh - 4], [plot.x + 4, plot.y + plot.h - bh - 4]
        ];
        var cost = corners.map(function (c, ci) {
            var cnt = (ci >= 2 && noteLines.length) ? 1e6 * (ci === 3 ? 2 : 1) : 0;
            (spec.series || []).forEach(function (s) {
                var xsA = s.x || [], ysA = s.y || [];
                for (var i = 0; i < xsA.length; i++) {
                    if (!okPt(xsA[i], ysA[i])) continue;
                    var px = toX(xsA[i]), py = toY(ysA[i]);
                    if (px >= c[0] - 3 && px <= c[0] + bw + 3 && py >= c[1] - 3 && py <= c[1] + bh + 3) cnt++;
                }
            });
            return cnt;
        });
        var best = 0;
        for (var ci2 = 1; ci2 < 4; ci2++) if (cost[ci2] < cost[best]) best = ci2;
        var bx = corners[best][0], by = corners[best][1];
        ctx.fillStyle = 'rgba(13,17,23,0.82)'; ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = T.border; ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
        items.forEach(function (s, i) {
            var ly = by + 11 + i * 15;
            ctx.strokeStyle = s.color || T.accent; ctx.fillStyle = s.color || T.accent; ctx.lineWidth = 2;
            if (s.type === 'line') {
                if (s.dash && ctx.setLineDash) ctx.setLineDash(s.dash);
                ctx.beginPath(); ctx.moveTo(bx + 6, ly); ctx.lineTo(bx + 22, ly); ctx.stroke();
                if (s.dash && ctx.setLineDash) ctx.setLineDash([]);
            } else {
                ctx.beginPath(); ctx.arc(bx + 14, ly, 3, 0, Math.PI * 2);
                if (s.type === 'hollow') ctx.stroke(); else ctx.fill();
            }
            ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(s.label, bx + 28, ly);
        });
        ctx.restore();
    }
    // notes (bottom-left inside the plot)
    if (noteLines.length) {
        ctx.fillStyle = T.text2; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        noteLines.forEach(function (nt, i) { ctx.fillText(nt, plot.x + 6, plot.y + plot.h - 6 - (noteLines.length - 1 - i) * 14); });
    }
    var axes = {
        scaleX: { min: xr.min, max: xr.max, kind: xLog ? 'log' : 'lin', label: spec.xLabel },
        scaleY: { min: yr.min, max: yr.max, kind: yLog ? 'log' : 'lin', label: spec.yLabel },
        toX: toX, toY: toY, fromX: fromX, fromY: fromY,
        plot: { x: plot.x, y: plot.y, w: plot.w, h: plot.h }, plotKey: spec.plotKey || null
    };
    try { canvas._prismAxes = axes; } catch (e) { /* detached */ }
    return axes;
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — RTA PLOTS + PLOT REGISTRY (C6 / C7)
// ─────────────────────────────────────────────────────────────────────────────
var PLOT_DEFS = {
    rnp:        { label: 'RNP & integral (RTA, log-log)',        title: 'Rate-normalised pressure and integral (NPI)', short: 'RNP / NPI',           fn: 'PRiSM_plot_rta_rnp' },
    blasingame: { label: 'Normalised rate & integrals (RTA)',    title: 'Blasingame: q/Δp, integral and integral-derivative', short: 'q/Δp & integrals', fn: 'PRiSM_plot_rta_blasingame' },
    ag:         { label: 'Dimensionless rate vs area time (RTA)', title: 'Agarwal–Gardner: qD vs tDA', short: 'qD vs tDA',                  fn: 'PRiSM_plot_rta_ag' },
    fmb:        { label: 'Flowing material balance (RTA)',       title: 'Flowing material balance', short: 'Flowing mat. balance',            fn: 'PRiSM_plot_rta_fmb' },
    sqrtRnp:    { label: 'RNP vs √t — linear flow (RTA)',        title: 'Linear flow: RNP vs √t', short: 'RNP vs √t',                         fn: 'PRiSM_plot_rta_sqrt' }
};
var RTA_PLOT_ORDER = ['rnp', 'blasingame', 'fmb', 'sqrtRnp', 'ag'];

function _rtaOpts() {
    var st = _st();
    var o = (st && st.rtaOpts) || _lsGet('wts_prism_rta') || {};
    return {
        plot: PLOT_DEFS[o.plot] ? o.plot : 'rnp',
        Sw: _num(o.Sw) ? o.Sw : 0,
        S: _num(o.S) ? o.S : null,
        condition: (o.condition === 'rate' || o.condition === 'pwf') ? o.condition : 'auto'
    };
}
function _saveRtaOpts(o) {
    var st = _st();
    if (st) st.rtaOpts = _clone(o);
    _lsSet('wts_prism_rta', o);
}

function _analysesFor(rta, extra) {
    extra = extra || {};
    var o = _rtaOpts();
    var fmb = extra.fmb || PRiSM_rtaFMB(rta, { Sw: o.Sw, S: _num(o.S) ? o.S : undefined });
    var lin = extra.lin || PRiSM_rtaLinearFlow(rta, { condition: o.condition });
    return { fmb: fmb, lin: lin };
}

function _drawRtaPlot(canvas, key, rta, extra, opts) {
    var T = _theme(), def = PLOT_DEFS[key] || PLOT_DEFS.rnp;
    var base = { title: def.title, shortTitle: def.short, plotKey: key };
    if (!rta || !rta.ok) {
        base.message = (rta && rta.reason) || 'Rate-transient analysis needs flowing pressure and rate data.';
        return _drawChart(canvas, base, opts);
    }
    var an = _analysesFor(rta, extra), fmb = an.fmb, lin = an.lin;
    var tcLabel = 'Material-balance time tc = Np/q (days)';
    var spec = base, i;
    var pick = function (arr, idx) { return idx.map(function (k) { return arr[k]; }); };
    if (key === 'rnp') {
        spec.xKind = 'log'; spec.yKind = 'log'; spec.xLabel = tcLabel; spec.yLabel = 'RNP, ' + rta.rnpUnit;
        spec.series = [
            { x: rta.tc, y: rta.rnp, color: T.accent, label: 'RNP = Δp/q' },
            { x: rta.tc, y: rta.rnpd, color: T.green, label: 'RNP′ (derivative)' },
            { x: rta.tc, y: rta.rnpid, color: T.purple, type: 'hollow', label: 'RNPi′ (integral-derivative)' }
        ];
        if (fmb.ok && _pos(fmb.ct) && _pos(fmb.X)) {
            var gx = [], gy = [];
            for (i = 0; i <= 60; i++) { var tcv = rta.tc[0] * Math.pow(rta.tc[rta.n - 1] / rta.tc[0], i / 60); gx.push(tcv); gy.push(fmb.b_pss + tcv / (fmb.ct * fmb.X)); }
            spec.series.push({ x: gx, y: gy, color: T.blue, type: 'line', dash: [6, 4], width: 1.5, label: 'Boundary-dominated line (FMB)', range: false });
        }
    } else if (key === 'blasingame') {
        spec.xKind = 'log'; spec.yKind = 'log'; spec.xLabel = tcLabel;
        spec.yLabel = 'q/Δp, ' + rta.units.rate + '/' + rta.dpUnit;
        spec.series = [
            { x: rta.tc, y: rta.qdp, color: T.accent, label: 'q/Δp' },
            { x: rta.tc, y: rta.qdpi, color: T.blue, label: '(q/Δp)i integral' },
            { x: rta.tc, y: rta.qdpid, color: T.green, type: 'hollow', label: '(q/Δp)id integral-derivative' }
        ];
        if (fmb.ok && _pos(fmb.ct) && _pos(fmb.X)) {
            var bx = [], by = [], byi = [], cX = fmb.ct * fmb.X;
            for (i = 0; i <= 60; i++) {
                var tv = rta.tc[0] * Math.pow(rta.tc[rta.n - 1] / rta.tc[0], i / 60);
                bx.push(tv); by.push(1 / (fmb.b_pss + tv / cX)); byi.push((cX / tv) * Math.log1p(tv / (fmb.b_pss * cX)));
            }
            spec.series.push({ x: bx, y: by, color: T.purple, type: 'line', dash: [6, 4], width: 1.5, label: 'Boundary-dominated stem (FMB)', range: false });
            spec.series.push({ x: bx, y: byi, color: T.purple, type: 'line', dash: [2, 3], width: 1.2, range: false });
        }
    } else if (key === 'ag') {
        var ag = PRiSM_rtaAG(rta, { fmb: fmb });
        if (!ag.ok) { spec.message = ag.reason; return _drawChart(canvas, spec, opts); }
        spec.xKind = 'log'; spec.yKind = 'log'; spec.xLabel = 'tDA (dimensionless area time)'; spec.yLabel = 'qD';
        spec.series = [
            { x: ag.tDA, y: ag.qD, color: T.accent, label: 'qD' },
            { x: ag.tDA, y: ag.qDi, color: T.blue, label: 'qDi integral' },
            { x: ag.tDA, y: ag.qDid, color: T.green, type: 'hollow', label: 'qDid integral-derivative' }
        ];
        if (_pos(ag.bD)) {
            var ax = [], ay = [];
            for (i = 0; i <= 60; i++) { var td = ag.tDA[0] * Math.pow(ag.tDA[ag.tDA.length - 1] / ag.tDA[0], i / 60); ax.push(td); ay.push(1 / (2 * Math.PI * td + ag.bD)); }
            spec.series.push({ x: ax, y: ay, color: T.purple, type: 'line', dash: [6, 4], width: 1.5, label: 'Boundary-dominated line', range: false });
        }
        spec.notes = ['k·h ' + _fmt(ag.kh, 3) + ' md·ft · A ' + _fmt(ag.A_ft2 / 43560, 3) + ' acres (from FMB)'];
    } else if (key === 'fmb') {
        if (!fmb.ok && !_isArr(fmb.x)) { spec.message = fmb.reason; return _drawChart(canvas, spec, opts); }
        var xAll = fmb.x || [], idx = fmb.idx || [];
        spec.xKind = 'lin'; spec.yKind = 'lin'; spec.xZero = true; spec.yZero = true;
        spec.xLabel = 'Np/(ct·Δp), ' + rta.units.vol;
        spec.yLabel = 'q/Δp, ' + rta.units.rate + '/psi';
        spec.series = [
            { x: xAll, y: rta.qdp, color: T.text3, r: 2.2, label: 'All points' },
            { x: pick(xAll, idx), y: pick(rta.qdp, idx), color: T.accent, r: 3.2, label: 'Boundary-dominated' }
        ];
        if (fmb.ok) {
            spec.series.push({ x: [0, fmb.X], y: [fmb.intercept, 0], color: T.blue, type: 'line', dash: [6, 4], width: 1.5, label: 'Fit', range: false });
            spec.extraX = [fmb.X]; spec.extraY = [fmb.intercept];
            spec.notes = ['N ≈ ' + _fmt(fmb.N, 4) + ' ' + rta.units.vol + (fmb.k ? ' · k ≈ ' + _fmt(fmb.k, 3) + ' md' : '')];
        } else {
            spec.notes = [fmb.reason];
        }
    } else if (key === 'sqrtRnp') {
        spec.xKind = 'lin'; spec.yKind = 'lin'; spec.xZero = true; spec.yZero = true;
        spec.xLabel = '√t (t in days)'; spec.yLabel = 'RNP, ' + rta.rnpUnit;
        var lidx = (lin && lin.idx) || [];
        spec.series = [
            { x: rta.sqrtT, y: rta.rnp, color: T.text3, r: 2.2, label: 'All points' },
            { x: pick(rta.sqrtT, lidx), y: pick(rta.rnp, lidx), color: T.accent, r: 3.2, label: 'Linear-flow points' }
        ];
        if (lin.ok) {
            var xm = rta.sqrtT[rta.n - 1];
            spec.series.push({ x: [0, xm], y: [lin.intercept, lin.intercept + lin.slope * xm], color: T.blue, type: 'line', dash: [6, 4], width: 1.5, label: 'Fit', range: false });
            spec.notes = ['m′ = ' + _fmt(lin.slope, 4) + (lin.xf_sqrt_k ? ' · xf√k ≈ ' + _fmt(lin.xf_sqrt_k, 4) + ' ft·md½' : '')];
        } else {
            spec.notes = [lin.reason];
        }
    }
    return _drawChart(canvas, spec, opts);
}

// Plot data for the registry: always built from the canonical dataset (hours).
function _rtaFromPlotData(data, opts) {
    if (data && data.rta && typeof data.rta.ok === 'boolean') return data.rta;
    var ds = G.PRiSM_dataset;
    if (ds && _isArr(ds.t) && ds.t.length) return PRiSM_rtaData(ds, null, {});
    if (data && _isArr(data.t)) {
        var unit = (opts && opts.timeUnit) || data.timeUnit || 'd';
        return PRiSM_rtaData({ t: data.t, p: data.p, q: data.q, timeUnit: unit }, null, {});
    }
    return { ok: false, reason: 'No dataset loaded.' };
}
function _plotEntry(key) {
    return function (canvas, data, opts) {
        var rta = _rtaFromPlotData(data, opts || {});
        return _drawRtaPlot(canvas, key, rta, (data && data.rtaExtra) || null, opts || {});
    };
}
function _buildPlot(key, dsIn) {
    var ds = (dsIn && _isArr(dsIn.t)) ? dsIn : (G.PRiSM_dataset || null);
    var rta = PRiSM_rtaData(ds, null, {});
    var data = { rta: rta, plotKey: key };
    if (rta.ok) { data.t = rta.tc.slice(); data.q = rta.q.slice(); data.p = rta.p.slice(); }
    return { data: data, opts: { timeUnit: 'd', xLabel: 'Material-balance time (days)', plotKey: key, title: PLOT_DEFS[key].title } };
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — PANELS (Tab 6 decline results, Tab 2 rate-transient analysis)
// ─────────────────────────────────────────────────────────────────────────────
var CSS_ID = 'prism-rta-dca-css';
var CSS = [
    '.prism-dca,.prism-rta{font-size:13px;color:var(--text);max-width:100%;min-width:0}',
    '.prism-dca *,.prism-rta *{box-sizing:border-box}',
    '.prism-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:flex-end;margin:8px 0}',
    '.prism-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text2);flex:1 1 140px;min-width:0;max-width:240px}',
    '.prism-field input,.prism-field select{width:100%;min-width:0;padding:6px 8px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px}',
    '.prism-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)}',
    '.prism-kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(135px,100%),1fr));gap:8px;margin:8px 0}',
    '.prism-kv{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;min-width:0}',
    '.prism-kv--key{border-color:var(--accent)}',
    '.prism-k{font-size:11px;color:var(--text3)}',
    '.prism-v{font-size:14px;font-weight:600;color:var(--text);overflow-wrap:anywhere}',
    '.prism-sub{font-size:11px;color:var(--text2);overflow-wrap:anywhere}',
    '.prism-note{margin:6px 0;padding:6px 8px;border-left:3px solid var(--yellow);background:var(--bg2);color:var(--text2);font-size:12px;border-radius:4px;overflow-wrap:anywhere}',
    '.prism-note--err{border-left-color:var(--red)}',
    '.prism-muted{color:var(--text3);font-size:12px;overflow-wrap:anywhere}',
    '.prism-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}',
    '.prism-btn{padding:7px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:12px;cursor:pointer;min-height:34px}',
    '.prism-btn--primary{background:var(--accent);border-color:var(--accent);color:#fff}',
    '.prism-seg{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}',
    '.prism-seg .prism-btn[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}',
    '.prism-table-wrap{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto}',
    '.prism-table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap}',
    '.prism-table th,.prism-table td{padding:4px 8px;border-bottom:1px solid var(--border);text-align:right}',
    '.prism-table th{color:var(--text2);font-weight:600;position:sticky;top:0;background:var(--bg2)}',
    '.prism-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:10px;margin-top:10px}',
    '.prism-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px;min-width:0}',
    '.prism-card h4{margin:0 0 6px;font-size:13px;color:var(--text)}',
    '.prism-canvas{width:100%;height:300px;display:block;border-radius:6px;background:var(--bg1);touch-action:pan-y}',
    '.prism-dca details summary{cursor:pointer;color:var(--text2);font-size:12px;margin:6px 0}',
    '@media (max-width:480px){.prism-canvas{height:240px}.prism-field{flex-basis:100%;max-width:none}}'
].join('\n');

function _injectCss() {
    var doc = _doc();
    if (!doc || !doc.head || typeof doc.getElementById !== 'function' || doc.getElementById(CSS_ID)) return;
    try { var s = doc.createElement('style'); s.id = CSS_ID; s.textContent = CSS; doc.head.appendChild(s); } catch (e) { /* ignore */ }
}
function _resolveHost(h) {
    if (!h) return null;
    if (typeof h === 'string') { var d = _doc(); return d ? d.getElementById(h) : null; }
    return h;
}
function _attached(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    var d = _doc();
    return !!(d && d.body && typeof d.body.contains === 'function' && d.body.contains(el));
}
function _q(host, id) {
    if (host && typeof host.querySelector === 'function') { try { var e = host.querySelector('#' + id); if (e) return e; } catch (x) { /* ignore */ } }
    var d = _doc();
    return d ? d.getElementById(id) : null;
}
function _kv(label, value, sub, key) {
    return '<div class="prism-kv' + (key ? ' prism-kv--key' : '') + '"><div class="prism-k">' + _esc(label) + '</div>' +
           '<div class="prism-v">' + value + '</div>' + (sub ? '<div class="prism-sub">' + sub + '</div>' : '') + '</div>';
}
function _notes(list, err) {
    return (list || []).map(function (w) { return '<div class="prism-note' + (err ? ' prism-note--err' : '') + '">' + _esc(w) + '</div>'; }).join('');
}
function _download(filename, text, mime) {
    var doc = _doc();
    if (!doc || !doc.body) return false;
    try {
        var url;
        if (typeof G.Blob === 'function' && G.URL && typeof G.URL.createObjectURL === 'function') {
            url = G.URL.createObjectURL(new G.Blob([text], { type: mime || 'text/csv' }));
        } else {
            url = 'data:' + (mime || 'text/csv') + ';charset=utf-8,' + encodeURIComponent(text);
        }
        var a = doc.createElement('a');
        a.setAttribute('href', url);
        a.setAttribute('download', filename);
        a.style.display = 'none';
        doc.body.appendChild(a);
        a.click();
        doc.body.removeChild(a);
        return true;
    } catch (e) { return false; }
}

var _mounted = { dca: null, rta: null };
var _rendering = { dca: false, rta: false };

// ── decline results panel ──
function _dcaOpts() {
    var st = _st();
    var o = (st && st.dcaOpts) || _lsGet('wts_prism_dca') || {};
    return {
        qab: _pos(o.qab) ? o.qab : null,
        dminOn: !!o.dminOn,
        dminPct: _pos(o.dminPct) ? o.dminPct : 6,
        tEndYears: _pos(o.tEndYears) ? o.tEndYears : null
    };
}
function _saveDcaOpts(o) {
    var st = _st();
    if (st) st.dcaOpts = _clone(o);
    _lsSet('wts_prism_dca', o);
}
function _resultsOpts(o, extra) {
    var r = {};
    if (_pos(o.qab)) r.q_ab = o.qab;
    if (_pos(o.tEndYears)) r.horizonYears = o.tEndYears;
    if (o.dminOn && _pos(o.dminPct)) r.DminEffYr = o.dminPct / 100;
    if (extra) for (var k in extra) if (_has(extra, k) && extra[k] !== undefined) r[k] = extra[k];
    return r;
}
function _rateModelKeys() {
    var keys = ['arps', 'duong', 'sepd', 'fetkovich'], m = _models();
    Object.keys(m).forEach(function (k) { if (m[k] && m[k].kind === 'rate' && keys.indexOf(k) === -1) keys.push(k); });
    return keys;
}
function _hasRate(ds) {
    if (!ds || !_isArr(ds.q) || !_isArr(ds.t)) return false;
    var n = 0;
    for (var i = 0; i < ds.q.length; i++) if (+ds.q[i] > 0) n++;
    return n >= 3;
}

function _commitRateFit(fit) {
    var st = _st();
    if (st && typeof G.PRiSM_setModel === 'function' && st.model !== fit.modelKey) {
        try { G.PRiSM_setModel(fit.modelKey); } catch (e) { /* ignore */ }
    }
    if (st && (fit.converged || fit.r2 >= 0.9)) st.params = _clone(fit.params);
    if (typeof G.PRiSM_setLastFit === 'function') {
        try { G.PRiSM_setLastFit(fit); } catch (e2) { if (st) st.lastFit = fit; _dispatch('prism:fit-updated', { fit: fit, source: 'decline' }); }
    } else {
        if (st) st.lastFit = fit;
        _dispatch('prism:fit-updated', { fit: fit, source: 'decline' });
    }
    if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e3) { /* ignore */ } }
}

/** Static HTML block of decline results (report / read-only use). */
function PRiSM_declineResultsHTML(res) {
    if (!res || !res.ok) return '<div class="prism-muted">' + _esc((res && res.reason) || 'No decline results.') + '</div>';
    var u = res.units, bs = res.percentiles && res.percentiles.ok ? res.percentiles : null;
    var h = '<div class="prism-kv-grid">';
    h += _kv('Model', _esc(res.modelName), res.fit && _num(res.fit.r2) ? 'R² ' + _fmt(res.fit.r2, 4) : '');
    if (res.qi !== null) h += _kv('Initial rate qi', _fmt(res.qi, 4), _esc(u.rate));
    if (res.Di !== null) h += _kv('Initial decline Di', _fmt(res.Di, 4) + ' /d', _fmt(res.Di_yr, 4) + ' /yr nominal');
    if (res.De !== null) h += _kv('Effective annual decline', _fmt(res.De * 100, 3) + ' %', 'first year');
    if (res.b !== null) h += _kv('Decline exponent b', _fmt(res.b, 3), res.b < 1e-6 ? 'exponential' : (Math.abs(res.b - 1) < 1e-6 ? 'harmonic' : 'hyperbolic'));
    if (res.Dmin) h += _kv('Terminal decline', _fmt(res.DminEffYr * 100, 3) + ' %/yr', res.tSwitch_days !== null ? 'switch at ' + _fmt(res.tSwitch_days / YEAR_D, 3) + ' yr' : 'no switch in range');
    h += _kv('Abandonment rate q_ab', _fmt(res.q_ab, 4), _esc(u.rate) + (res.q_abDefaulted ? ' (1 % of qi)' : ''));
    h += _kv('Time to q_ab', _fmt(res.t_ab_years, 4) + ' yr', _fmt(res.t_ab_days, 5) + ' days');
    h += _kv('Cumulative to date', _fmt(res.Np_hist, 5), _esc(u.vol));
    h += _kv('EUR', _fmt(res.eur, 5), _esc(u.vol) + ' · limited by ' + (res.limitedBy === 'time' ? 'time' : res.limitedBy === 'cap' ? '50-yr cap' : 'rate'), true);
    h += _kv('Remaining', _fmt(res.remaining, 5), _esc(u.vol), true);
    if (bs) {
        h += _kv('EUR P90 / P50 / P10', _fmt(bs.eur.P90, 4) + ' / ' + _fmt(bs.eur.P50, 4) + ' / ' + _fmt(bs.eur.P10, 4),
                 _esc(u.vol) + ' · ' + bs.n + ' resamples (P90 = low case)', true);
    }
    h += '</div>';
    h += _notes(res.warnings);
    return h;
}

function _forecastTableHTML(res) {
    var u = res.units, rows = res.forecast;
    if (!rows.length) return '<div class="prism-muted">No forecast (limit already reached).</div>';
    var h = '<div class="prism-table-wrap"><table class="prism-table"><thead><tr>' +
        '<th>Month</th><th>End (yr)</th><th>Rate (' + _esc(u.rate) + ')</th><th>Volume (' + _esc(u.vol) + ')</th><th>Cumulative (' + _esc(u.vol) + ')</th>' +
        '</tr></thead><tbody>';
    rows.forEach(function (r) {
        h += '<tr><td>' + r.month + '</td><td>' + _fmt(r.t1 / YEAR_D, 4) + '</td><td>' + _fmt(r.q_end, 4) +
             '</td><td>' + _fmt(r.volume, 5) + '</td><td>' + _fmt(r.cum, 6) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
}

function _renderDcaOut(host, fit, res) {
    var out = _q(host, 'prism_dca_out');
    if (!out) return;
    if (!res.ok) { out.innerHTML = _notes([res.reason], true); return; }
    var bs = res.percentiles;
    var h = PRiSM_declineResultsHTML(res);
    if (bs && !bs.ok) h += '<div class="prism-muted">P10/P50/P90 unavailable: ' + _esc(bs.reason) + '</div>';
    h += '<div class="prism-actions">';
    if (!bs || !bs.ok) h += '<button type="button" class="prism-btn btn" id="prism_dca_boot">Estimate P10/P50/P90 (' + DEFAULT_BOOT + ' resamples)</button>';
    h += '<button type="button" class="prism-btn btn" id="prism_dca_csv"' + (res.forecast.length ? '' : ' disabled') + '>Download forecast CSV</button>';
    h += '</div>';
    h += '<details><summary>Monthly forecast — ' + res.forecast.length + ' month' + (res.forecast.length === 1 ? '' : 's') +
         ' from the end of history</summary>' + _forecastTableHTML(res) + '</details>';
    out.innerHTML = h;
    var bBtn = _q(host, 'prism_dca_boot');
    if (bBtn) bBtn.onclick = function () {
        var o = _dcaOpts();
        var r2 = PRiSM_declineResults(fit, G.PRiSM_dataset, _resultsOpts(o, { bootstrap: DEFAULT_BOOT }));
        _renderDcaOut(host, fit, r2);
    };
    var cBtn = _q(host, 'prism_dca_csv');
    if (cBtn) cBtn.onclick = function () {
        _download('prism-decline-forecast-' + res.modelKey + '.csv', PRiSM_declineForecastCSV(res), 'text/csv');
    };
}

/**
 * Tab 6 panel: EUR, forecast and uncertainty for the current rate fit.
 * popts.readOnly → static results only (report embedding).
 */
function PRiSM_renderDeclineResultsPanel(hostEl, popts) {
    popts = popts || {};
    var host = _resolveHost(hostEl);
    if (!host) return null;
    _injectCss();
    var fit = popts.fit ? _normFit(popts.fit) : _currentRateFit();
    var ds = G.PRiSM_dataset || null;
    if (popts.readOnly) {
        var r0 = fit ? PRiSM_declineResults(fit, ds, _resultsOpts(_dcaOpts(), { bootstrap: 0 })) : { ok: false, reason: 'No decline fit.' };
        host.innerHTML = '<div class="prism-dca">' + PRiSM_declineResultsHTML(r0) + '</div>';
        return r0;
    }
    _mounted.dca = host;
    if (_rendering.dca) return null;
    _rendering.dca = true;
    try {
        var o = _dcaOpts(), units = _rateUnits(_fluidOf(null));
        if (!fit) {
            var st = _st(), cur = st && _isRateModel(st.model) ? st.model : 'arps';
            var opts = _rateModelKeys().map(function (k) {
                return '<option value="' + _esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + _esc(_modelName(k)) + '</option>';
            }).join('');
            host.innerHTML = '<div class="prism-dca" id="prism_dca_results">' +
                '<div class="prism-muted">No decline fit yet. Fit a rate model to the production data to see the EUR, the forecast and the P10/P50/P90 range.</div>' +
                (_hasRate(ds)
                    ? '<div class="prism-row"><label class="prism-field">Decline model<select id="prism_dca_model">' + opts + '</select></label>' +
                      '<button type="button" class="prism-btn prism-btn--primary btn btn-primary" id="prism_dca_fit">Fit decline to rate data</button></div>' +
                      '<div id="prism_dca_fitmsg"></div>'
                    : '<div class="prism-note">The loaded data has no rate column with positive values.</div>') +
                '</div>';
            var fb = _q(host, 'prism_dca_fit');
            if (fb) fb.onclick = function () {
                var sel = _q(host, 'prism_dca_model'), key = sel ? sel.value : 'arps';
                var f = PRiSM_fitDecline(key, G.PRiSM_dataset, {});
                if (!f || f.ok === false) {
                    var m = _q(host, 'prism_dca_fitmsg');
                    if (m) m.innerHTML = _notes([(f && f.reason) || 'The decline fit failed.'], true);
                    return;
                }
                _commitRateFit(f);
                _rendering.dca = false;
                PRiSM_renderDeclineResultsPanel(host, { fit: f });
            };
            return null;
        }
        var ciTxt = '';
        if (fit.ci95 && fit.ci95.b && _num(fit.ci95.b[0])) ciTxt = ' · b 95 % CI ' + _fmt(fit.ci95.b[0], 3) + '–' + _fmt(fit.ci95.b[1], 3);
        host.innerHTML = '<div class="prism-dca" id="prism_dca_results">' +
            '<div class="prism-muted">' + _esc(_modelName(fit.modelKey)) + ' fitted to rate (time in days)' +
            (fit.source ? ' · ' + _esc(fit.source) : '') + ciTxt + '</div>' +
            '<div class="prism-row">' +
            '<label class="prism-field">Abandonment rate q_ab (' + _esc(units.rate) + ')' +
            '<input type="number" inputmode="decimal" step="any" min="0" id="prism_dca_qab" placeholder="1 % of qi" value="' + (o.qab || '') + '"></label>' +
            '<label class="prism-field">Time limit (years from start, optional)' +
            '<input type="number" inputmode="decimal" step="any" min="0" id="prism_dca_tend" placeholder="none" value="' + (o.tEndYears || '') + '"></label>' +
            '<label class="prism-field"><span class="prism-check"><input type="checkbox" id="prism_dca_dmin_on"' + (o.dminOn ? ' checked' : '') +
            '> Terminal decline (%/yr, effective)</span>' +
            '<input type="number" inputmode="decimal" step="any" min="0" max="99" id="prism_dca_dmin" value="' + o.dminPct + '"' + (o.dminOn ? '' : ' disabled') + '></label>' +
            '</div><div id="prism_dca_out"></div></div>';
        // P10/P50/P90 run automatically when cheap (see PRiSM_declineResults), else on the button.
        var res = PRiSM_declineResults(fit, ds, _resultsOpts(o));
        _renderDcaOut(host, fit, res);
        var onChange = function () {
            var qab = parseFloat((_q(host, 'prism_dca_qab') || {}).value);
            var te = parseFloat((_q(host, 'prism_dca_tend') || {}).value);
            var on = !!(_q(host, 'prism_dca_dmin_on') || {}).checked;
            var dm = parseFloat((_q(host, 'prism_dca_dmin') || {}).value);
            var dEl = _q(host, 'prism_dca_dmin');
            if (dEl) dEl.disabled = !on;
            var no = { qab: _pos(qab) ? qab : null, tEndYears: _pos(te) ? te : null, dminOn: on, dminPct: _pos(dm) && dm < 100 ? dm : 6 };
            _saveDcaOpts(no);
            var r = PRiSM_declineResults(fit, G.PRiSM_dataset, _resultsOpts(no));
            _renderDcaOut(host, fit, r);
            _dispatch('prism:decline-results', { results: r });
        };
        ['prism_dca_qab', 'prism_dca_tend', 'prism_dca_dmin_on', 'prism_dca_dmin'].forEach(function (id) {
            var el = _q(host, id);
            if (el) el.onchange = onChange;
        });
        return res;
    } finally {
        _rendering.dca = false;
    }
}

// ── rate-transient analysis panel ──
function _fmbCardHTML(fmb, o, rta) {
    var h = '<div class="prism-card"><h4>Flowing material balance</h4>' +
        '<div class="prism-row"><label class="prism-field">Water saturation Sw<input type="number" inputmode="decimal" step="any" min="0" max="0.99" id="prism_rta_sw" value="' + o.Sw + '"></label>' +
        '<label class="prism-field">Skin S (for k·h)<input type="number" inputmode="decimal" step="any" id="prism_rta_skin" placeholder="0" value="' + (_num(o.S) ? o.S : '') + '"></label></div>';
    if (!fmb.ok) return h + _notes([fmb.reason]) + '</div>';
    var u = rta.units;
    h += '<div class="prism-kv-grid">' +
        _kv('Oil in place N', _fmt(fmb.N, 5), _esc(u.vol), true) +
        _kv('Pore volume', _fmt(fmb.Vp_rb, 5), 'RB') +
        _kv('Drainage area', _fmt(fmb.A_acres, 4), 'acres · re ' + _fmt(fmb.re_ft, 4) + ' ft') +
        _kv('k·h', _fmt(fmb.kh, 4), 'md·ft · k ' + _fmt(fmb.k, 4) + ' md') +
        _kv('b_pss', _fmt(fmb.b_pss, 4), 'psi/(' + _esc(u.rate) + ')') +
        _kv('Points used', String(fmb.n), 'R² ' + _fmt(fmb.r2, 4)) +
        '</div><div class="prism-muted">' + _esc(fmb.method) + '</div>' + _notes(fmb.warnings);
    return h + '</div>';
}
function _linCardHTML(lin, o) {
    var h = '<div class="prism-card"><h4>Linear flow (√t)</h4>' +
        '<div class="prism-row"><label class="prism-field">Flow condition<select id="prism_rta_cond">' +
        ['auto', 'rate', 'pwf'].map(function (c) {
            return '<option value="' + c + '"' + (o.condition === c ? ' selected' : '') + '>' +
                (c === 'auto' ? 'Auto-detect' : c === 'rate' ? 'Constant rate' : 'Constant pwf (×π/2)') + '</option>';
        }).join('') + '</select></label></div>';
    if (!lin.ok) return h + _notes([lin.reason]) + '</div>';
    h += '<div class="prism-kv-grid">' +
        _kv('Slope m′', _fmt(lin.slope, 4), 'RNP per √day') +
        _kv('xf·√k', lin.xf_sqrt_k ? _fmt(lin.xf_sqrt_k, 4) : '—', 'ft·md½ · ' + (lin.condition === 'pwf' ? 'constant pwf' : 'constant rate'), true) +
        (lin.xf ? _kv('Fracture half-length xf', _fmt(lin.xf, 4), 'ft (k ' + _fmt(lin.k, 3) + ' md, ' + _esc(lin.kSource) + ')') : '') +
        _kv('Points used', String(lin.n), 'R² ' + _fmt(lin.r2, 4)) +
        '</div><div class="prism-muted">' + _esc(lin.method) + '</div>' + _notes(lin.warnings);
    return h + '</div>';
}

/** Tab 2 panel: rate-transient plots (own canvas) + FMB and linear-flow results. */
function PRiSM_renderRTAPanel(hostEl) {
    var host = _resolveHost(hostEl);
    if (!host) return null;
    _injectCss();
    _mounted.rta = host;
    if (_rendering.rta) return null;
    _rendering.rta = true;
    try {
        var ds = G.PRiSM_dataset || null, o = _rtaOpts();
        var rta = PRiSM_rtaData(ds, null, {});
        if (!rta.ok) {
            host.innerHTML = '<div class="prism-rta" id="prism_rta_panel">' + _notes([rta.reason]) + _notes(rta.warnings || []) + '</div>';
            return { rta: rta };
        }
        var an = _analysesFor(rta, null);
        var u = rta.units;
        var piTxt = _fmt(rta.pi, 5) + ' ' + (rta.pseudo ? 'psia (Δm used)' : 'psia') +
            (rta.piSource === 'extrapolated' ? ' (estimated)' : '');
        var mainBtn = (_mode() !== 'transient') ? '<button type="button" class="prism-btn btn" id="prism_rta_main">Show on the main plot</button>' : '';
        host.innerHTML = '<div class="prism-rta" id="prism_rta_panel">' +
            '<div class="prism-muted">' + rta.n + ' flowing points · tc ' + _fmt(rta.tc[0], 3) + '–' + _fmt(rta.tc[rta.n - 1], 4) +
            ' days · cumulative ' + _fmt(rta.NpTotal, 5) + ' ' + _esc(u.vol) + ' · pi ' + _esc(piTxt) + '</div>' +
            _notes(rta.warnings) +
            (rta.missing.length ? _notes(['Well inputs missing for the analyses: ' + rta.missing.join(', ') + ' (Data step → Well & Test).']) : '') +
            '<div class="prism-seg" role="group" aria-label="Rate-transient plot">' +
            RTA_PLOT_ORDER.map(function (k) {
                return '<button type="button" class="prism-btn" data-rta-plot="' + k + '" aria-pressed="' + (k === o.plot ? 'true' : 'false') + '">' + _esc(PLOT_DEFS[k].short) + '</button>';
            }).join('') + '</div>' +
            '<canvas id="prism_rta_canvas" class="prism-canvas" role="img" aria-label="Rate-transient plot"></canvas>' +
            '<div class="prism-actions">' + mainBtn + '</div>' +
            '<div class="prism-cards"><div id="prism_rta_fmb">' + _fmbCardHTML(an.fmb, o, rta) + '</div>' +
            '<div id="prism_rta_lin">' + _linCardHTML(an.lin, o) + '</div></div>' +
            '</div>';
        var canvas = _q(host, 'prism_rta_canvas');
        var state = { fmb: an.fmb, lin: an.lin };
        var draw = function () { if (canvas) _drawRtaPlot(canvas, _rtaOpts().plot, rta, state, {}); };
        draw();
        var segs = host.querySelectorAll ? host.querySelectorAll('[data-rta-plot]') : [];
        Array.prototype.forEach.call(segs, function (b) {
            b.onclick = function () {
                var no = _rtaOpts(); no.plot = b.getAttribute('data-rta-plot'); _saveRtaOpts(no);
                Array.prototype.forEach.call(segs, function (b2) { b2.setAttribute('aria-pressed', b2 === b ? 'true' : 'false'); });
                draw();
            };
        });
        var wireFmb = function () {
            var sw = _q(host, 'prism_rta_sw'), sk = _q(host, 'prism_rta_skin');
            var onF = function () {
                var no = _rtaOpts();
                var v1 = parseFloat(sw && sw.value), v2 = parseFloat(sk && sk.value);
                no.Sw = _num(v1) ? Math.min(Math.max(v1, 0), 0.99) : 0;
                no.S = _num(v2) ? v2 : null;
                _saveRtaOpts(no);
                state.fmb = PRiSM_rtaFMB(rta, { Sw: no.Sw, S: _num(no.S) ? no.S : undefined });
                var box = _q(host, 'prism_rta_fmb');
                if (box) box.innerHTML = _fmbCardHTML(state.fmb, no, rta);
                wireFmb();
                draw();
            };
            if (sw) sw.onchange = onF;
            if (sk) sk.onchange = onF;
        };
        var wireLin = function () {
            var sel = _q(host, 'prism_rta_cond');
            if (sel) sel.onchange = function () {
                var no = _rtaOpts(); no.condition = sel.value; _saveRtaOpts(no);
                state.lin = PRiSM_rtaLinearFlow(rta, { condition: no.condition });
                var box = _q(host, 'prism_rta_lin');
                if (box) box.innerHTML = _linCardHTML(state.lin, no);
                wireLin();
                draw();
            };
        };
        wireFmb(); wireLin();
        var mb = _q(host, 'prism_rta_main');
        if (mb) mb.onclick = function () {
            var st = _st();
            if (st) st.activePlot = _rtaOpts().plot;
            _dispatch('prism:plot-changed', { plotKey: _rtaOpts().plot });
            if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
        };
        return { rta: rta, fmb: state.fmb, lin: state.lin };
    } finally {
        _rendering.rta = false;
    }
}

function _refresh(which) {
    var host = _mounted[which];
    if (!host) return;
    if (!_attached(host)) { _mounted[which] = null; return; }
    try {
        if (which === 'dca') PRiSM_renderDeclineResultsPanel(host);
        else PRiSM_renderRTAPanel(host);
    } catch (e) { if (G.console) G.console.warn('PRiSM 35: panel refresh failed:', e && e.message); }
}

function _qVaries(ds) {
    if (!ds || !_isArr(ds.q)) return false;
    var qs = [];
    for (var i = 0; i < ds.q.length; i++) if (+ds.q[i] > 0) qs.push(+ds.q[i]);
    return qs.length >= 5 && _cv(qs) > 0.05;
}
function _whenDca() {
    if (_currentRateFit()) return true;
    var st = _st();
    return _mode() === 'decline' || !!(st && _isRateModel(st.model));
}
function _whenRta() {
    var ds = G.PRiSM_dataset;
    if (!ds || !_isArr(ds.p) || !_hasRate(ds)) return false;
    return _mode() !== 'transient' || _qVaries(ds);
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — EXPORTS + REGISTRATION (C7 panels, plot registry, events)
// ─────────────────────────────────────────────────────────────────────────────
G.PRiSM_declineRate = PRiSM_declineRate;
G.PRiSM_fitDecline = PRiSM_fitDecline;
G.PRiSM_declineResults = PRiSM_declineResults;
G.PRiSM_declineForecastCSV = PRiSM_declineForecastCSV;
G.PRiSM_declineResultsHTML = PRiSM_declineResultsHTML;
G.PRiSM_renderDeclineResultsPanel = PRiSM_renderDeclineResultsPanel;
G.PRiSM_rtaData = PRiSM_rtaData;
G.PRiSM_rtaFMB = PRiSM_rtaFMB;
G.PRiSM_rtaLinearFlow = PRiSM_rtaLinearFlow;
G.PRiSM_rtaAG = PRiSM_rtaAG;
G.PRiSM_rtaSummary = PRiSM_rtaSummary;
G.PRiSM_renderRTAPanel = PRiSM_renderRTAPanel;
G.PRiSM_plot_rta_rnp = _plotEntry('rnp');
G.PRiSM_plot_rta_blasingame = _plotEntry('blasingame');
G.PRiSM_plot_rta_ag = _plotEntry('ag');
G.PRiSM_plot_rta_fmb = _plotEntry('fmb');
G.PRiSM_plot_rta_sqrt = _plotEntry('sqrtRnp');
G.PRiSM_drawRtaPlot = function (canvas, key, ds, well) {
    return _drawRtaPlot(canvas, key, PRiSM_rtaData(ds, well, {}), null, {});
};
// internals for tests / other layers (read-only use)
G.PRiSM_rtaDcaInternals = {
    arpsQ: _arpsQ, arpsNp: _arpsNp, arpsTab: _arpsTab, effAnnual: _effAnnual,
    nominalFromEffective: _nominalFromEffective, declineSpec: _declineSpec,
    fitLocal: _fitDeclineLocal, logDeriv: _logDeriv, fmtTick: _fmtTick, LF_CONST: LF_CONST
};

// Plot registry (merge, never replace).
G.PRiSM_PLOT_REGISTRY = G.PRiSM_PLOT_REGISTRY || {};
Object.keys(PLOT_DEFS).forEach(function (k) {
    var d = PLOT_DEFS[k];
    G.PRiSM_PLOT_REGISTRY[k] = {
        fn: d.fn, label: d.label, mode: 'decline', title: d.title, needs: ['p', 'q'],
        build: (function (key) { return function (ctx) { return _buildPlot(key, ctx && ctx.ds); }; })(k)
    };
});

// C7 panels.
function _registerPanel(n, spec) {
    try {
        if (typeof G.PRiSM_registerTabPanel === 'function') { G.PRiSM_registerTabPanel(n, spec); return; }
    } catch (e) { /* fall back to the raw registry */ }
    G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
    var list = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === spec.id) { list[i] = spec; return; }
    list.push(spec);
}
_registerPanel(6, {
    id: 'dcaResults', title: 'Decline results: EUR & forecast', order: 40,
    when: _whenDca, render: function (el) { PRiSM_renderDeclineResultsPanel(el); }
});
_registerPanel(2, {
    id: 'rta', title: 'Rate-transient analysis', order: 60,
    when: _whenRta, render: function (el) { PRiSM_renderRTAPanel(el); }
});

// Refresh mounted panels on the C7 events (one listener each, no polling).
if (typeof G.addEventListener === 'function' && !G.__prismWp12Listeners) {
    G.__prismWp12Listeners = true;
    G.addEventListener('prism:fit-updated', function () { _refresh('dca'); });
    G.addEventListener('prism:dataset-loaded', function () { _refresh('dca'); _refresh('rta'); });
    G.addEventListener('prism:well-changed', function () { _refresh('rta'); _refresh('dca'); });
}

})();

// ─── END 35-rta-dca ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 36-report ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM — Layer 36 — Report (step ⑤ / Tab 7), PDF and CSV export
//
// PURPOSE
//   One report model feeds every output: the Report tab, the PDF (host
//   report styling), the CSV, the header job report and the quick report.
//   Results are shown in field units with ±95 % CI and a source chip
//   (regression / auto-match / type-curve match / straight line / input).
//
// REPORT CONTENT (in order)
//   Header      client / well / field (h2oil_client_info), test type, period
//   Key results k, kh, C, CD, S, pi, xf / Lh, boundary distances, rinv,
//               ΔpS, FE, DR, J, J_ideal, rw′  (value ± CI, unit, source)
//   Fit quality model, R², RMSE, AIC, iterations, converged, identifiability,
//               log PM / log TM (the old "time / pressure match" rows are gone)
//   Model parameters (dimensionless registry values ± CI)
//   Interpretation narrative, actions, cautions
//   Plots       log-log (Δp, Δp′ + model), semilog (MDH / Horner + line),
//               history (p, q + model); rate–time plots for decline fits
//   Model comparison (ΔAIC, from st.autoMatch.ranked / st.fits)
//   Pinned results (rail "Pin to report": PRiSM_getReportPins / st.reportPins)
//   Straight-line results (semilog analysis + plot-key results) with the
//               cross-check against the model fit (Δk %, ΔS)
//   Skin        summary + decomposition
//   Flow regimes, data summary (n, Δt range, reference pressure + source)
//   Decline block (qi, Di, b, EUR, P10/P50/P90) when the fit is a rate fit
//   Appendix    every input with its provenance; defaults flagged
//
// PUBLIC API (window.*)
//   PRiSM_renderReportTab(hostEl?)   render into hostEl or #prism_tab_7
//   PRiSM_buildReportHTML(opts?)     HTML fragment for the host report
//                                    pipeline (rp-* classes, plots as PNG)
//   PRiSM_buildReportCSV(opts?)      {filename, header, rows, text, kind}
//   PRiSM_exportCSV(opts?)           build + download; returns the same
//   PRiSM_reportData(opts?)          structured report model
//   PRiSM_reportResults()            compact key results (rail, quick report)
//   PRiSM_exportReport(opts?)        PDF via the host exportReport path
//   PRiSM_hostExportReport(title, html, subtitle)
//                                    bridge to the host exportReport (the
//                                    host function is not on window)
//   Analyst comments typed on the tab persist in localStorage
//   'wts_prism_report_notes' (so project files carry them and New clears them).
//   Result labels carry data-wts-help="prism_help_*" for the help tooltips.
//   The tab re-renders (debounced, one-shot) on prism:fit-updated,
//   well-changed, dataset-loaded, model-changed, automatch-updated,
//   report-pinned and window resize, only while it is on screen.
//
// CONTRACTS USED (all optional — every call is guarded, with local fallbacks)
//   C1 PRiSM_getWell           C2 PRiSM_getAnalysisData   C3 PRiSM_physicalModel
//   C4 PRiSM_getLastFit        C5 st.tcMatch              C6 PRiSM_buildPlotData
//   C7 PRiSM_PLOT_REGISTRY / PRiSM_postDrawHooks / prism:* events
//   WP5 PRiSM_skinSummary, PRiSM_skinDecomposition, st.semilog
//   WP3 PRiSM_interpretCurrentFit / st.interp   13 PRiSM_classifyRegimes
//   WP12 PRiSM_declineResults
//
// CONVENTIONS
//   Single outer IIFE; field units (t hours, p psia, q STB/d or Mscf/d;
//   decline time in days); sign-aware Δp (CLAUDE.md); no external deps;
//   no polling; dark theme via host CSS variables; works at 375 px.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
var _hasDoc = (typeof document !== 'undefined' && document && typeof document.createElement === 'function');

function _warn() { try { if (typeof console !== 'undefined' && console.warn) console.warn.apply(console, arguments); } catch (e) {} }

// ───────────────────────────────────────────────────────────────────
// SECTION 1 — SMALL HELPERS
// ───────────────────────────────────────────────────────────────────
function _isNum(v) { return typeof v === 'number' && isFinite(v); }
function _num() {
    for (var i = 0; i < arguments.length; i++) if (_isNum(arguments[i])) return arguments[i];
    return NaN;
}
function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _arr(a) {
    if (a == null) return null;
    if (typeof a === 'number') return [a];
    if (typeof a.length !== 'number') return null;
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = a[i];
    return out;
}
function _own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
function _copy(o) { var r = {}; if (o) for (var k in o) if (_own(o, k)) r[k] = o[k]; return r; }

// First non-null value under any of the alias names (searches a few
// nested containers too, so producers can use their own layout).
function _pick(obj, names) {
    if (!obj || typeof obj !== 'object') return undefined;
    var boxes = [obj, obj.skin, obj.skinSummary, obj.summary, obj.results, obj.result];
    for (var b = 0; b < boxes.length; b++) {
        var o = boxes[b];
        if (!o || typeof o !== 'object') continue;
        for (var i = 0; i < names.length; i++) if (o[names[i]] != null) return o[names[i]];
    }
    return undefined;
}
function _pickNum(obj, names) {
    if (!obj || typeof obj !== 'object') return NaN;
    var boxes = [obj, obj.skin, obj.skinSummary, obj.summary, obj.results, obj.result];
    for (var b = 0; b < boxes.length; b++) {
        var o = boxes[b];
        if (!o || typeof o !== 'object') continue;
        for (var i = 0; i < names.length; i++) if (_isNum(o[names[i]])) return o[names[i]];
    }
    return NaN;
}

// Significant-figure formatting without thousands separators
// (45.001 → "45.0", 261.9 → "262", 0.7641 → "0.764", 1548.3 → "1548").
function _fmt(v, sig) {
    if (!_isNum(v)) return '—';
    sig = sig || 3;
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e5 || a < 1e-3) {
        return v.toExponential(Math.max(0, sig - 1)).replace('e+', 'e').replace(/e(-?)0*(\d)/, 'e$1$2');
    }
    var mag = Math.floor(Math.log(a) / Math.LN10 + 1e-12);
    return v.toFixed(Math.max(0, Math.min(8, sig - 1 - mag)));
}
function _fixed(v, d) { return _isNum(v) ? v.toFixed(d) : '—'; }
function _decimalsOf(str) { var i = String(str).indexOf('.'); return (i < 0 || /e/.test(str)) ? -1 : String(str).length - i - 1; }
// ± half-width, shown with the value's decimals when that keeps 1+ sig fig.
function _fmtPM(v, str, lo, hi) {
    if (!_isNum(lo) || !_isNum(hi) || !_isNum(v)) return '';
    var pm = Math.abs(hi - lo) / 2;
    if (!(pm > 0)) return '';
    var d = _decimalsOf(str);
    if (d >= 0 && pm >= Math.pow(10, -d)) return pm.toFixed(d);
    return _fmt(pm, 2);
}
function _today() {
    try { var d = new Date(); return d.toISOString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 5); }
    catch (e) { return ''; }
}
function _slug(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}
function _humanize(key) {
    var s = String(key || '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}
function _ls() {
    try { return (typeof localStorage !== 'undefined' && localStorage) || G.localStorage || null; }
    catch (e) { return null; }
}

// ───────────────────────────────────────────────────────────────────
// SECTION 2 — LABELS
// ───────────────────────────────────────────────────────────────────
var MODEL_LABELS = {
    homogeneous: 'Homogeneous reservoir',
    infiniteFrac: 'Infinite-conductivity fracture', finiteFrac: 'Finite-conductivity fracture',
    finiteFracSkin: 'Fracture with fracture-face skin', partialPenFrac: 'Partially penetrating fracture',
    inclined: 'Slanted well', horizontal: 'Horizontal well', partialPen: 'Partially penetrating well',
    verticalPulse: 'Vertical pulse test', linearBoundary: 'Single straight boundary',
    parallelChannel: 'Channel (two parallel boundaries)', closedChannel3: 'Channel closed at one end',
    closedRectangle: 'Closed rectangle', intersecting: 'Two intersecting boundaries',
    fogBoundary: 'Leaky boundary', doublePorosity: 'Dual porosity',
    twoLayerXF: 'Two layers with crossflow', radialComposite: 'Radial composite',
    multiLayerXF: 'Layered with crossflow', multiLayerNoXF: 'Layered without crossflow',
    linearComposite: 'Linear composite', interference: 'Interference (observation well)',
    userDefined: 'User-defined type curve', waterInjection: 'Water injection',
    arps: 'Arps decline', duong: 'Duong decline', sepd: 'Stretched-exponential decline',
    fetkovich: 'Fetkovich decline'
};
function _modelLabel(key) {
    if (!key) return '';
    var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
    return (e && (e.label || e.name)) || MODEL_LABELS[key] || _humanize(key);
}
var SOURCE_LABELS = {
    regression: 'Regression', automatch: 'Auto-match', match: 'Type-curve match',
    semilog: 'Straight line', input: 'Input', derived: 'Derived', project: 'Project file',
    preview: 'Model preview'
};
function _sourceLabel(s) { return SOURCE_LABELS[s] || (s ? _humanize(s) : ''); }
var TEST_LABELS = {
    drawdown: 'Drawdown', buildup: 'Buildup', injection: 'Injection', falloff: 'Falloff',
    interference: 'Interference', rate: 'Rate only (decline)', auto: 'Auto-detect'
};
function _testLabel(t) { return TEST_LABELS[t] || (t ? _humanize(t) : ''); }
var PREF_LABELS = {
    'pi': 'initial pressure (input)', 'pwf0': 'flowing pressure at shut-in',
    't0-row': 't = 0 row in the data', 'extrapolated': 'extrapolated to t = 0 (check)',
    'first-sample': 'first data point (skin will be biased)', 'fit': 'fitted initial pressure'
};
var REGIME_LABELS = {
    wellboreStorage: 'Wellbore storage (unit slope)', linearFlow: 'Linear flow (half slope)',
    bilinearFlow: 'Bilinear flow (quarter slope)', radialFlow: 'Radial flow (flat derivative)',
    sphericalFlow: 'Spherical flow (negative half slope)', constPressure: 'Constant-pressure boundary',
    closedBoundary: 'Closed boundary', sealingFault: 'Sealing fault (derivative steps up)',
    doublePorosity: 'Dual-porosity dip', unknown: 'Not classified'
};
var FLUID_UNITS = {
    oil:   { q: 'STB/d',  B: 'RB/STB',  J: 'STB/d/psi',  vol: 'STB' },
    water: { q: 'bbl/d',  B: 'RB/STB',  J: 'bbl/d/psi',  vol: 'bbl' },
    gas:   { q: 'Mscf/d', B: 'RB/Mscf', J: 'Mscf/d/psi', vol: 'Mscf' }
};
function _units(fluid) { return FLUID_UNITS[fluid] || FLUID_UNITS.oil; }

// ───────────────────────────────────────────────────────────────────
// SECTION 3 — STATE ACCESS (contracts first, local fallbacks second)
// ───────────────────────────────────────────────────────────────────
function _state() { return G.PRiSM_state || {}; }

function _normFit(f, st) {
    if (!f || typeof f !== 'object') return null;
    var o = _copy(f);
    o.modelKey = f.modelKey || f.model || (st && st.model) || null;
    o.r2 = _num(f.r2, f.R2);
    o.rmse = _num(f.rmse, f.RMSE);
    o.aic = _num(f.aic, f.AIC);
    o.dAIC = _num(f.dAIC, f.deltaAIC);
    o.dAICnext = _num(f.dAICnext, f.dAIC_next);
    o.ci95 = f.ci95 || f.CI95 || {};
    var e = o.modelKey && G.PRiSM_MODELS ? G.PRiSM_MODELS[o.modelKey] : null;
    o.kind = f.kind || (e && e.kind === 'rate' ? 'rate' : 'pressure');
    o.params = f.params || {};
    return o;
}
function _getFit() {
    var st = _state();
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { var f = G.PRiSM_getLastFit(); if (f) return _normFit(f, st); } catch (e) { _warn('[report] getLastFit failed', e); }
    }
    return st.lastFit ? _normFit(st.lastFit, st) : null;
}

function _clientInfo() {
    var ci = {};
    try { var ls = _ls(); ci = JSON.parse((ls && ls.getItem('h2oil_client_info')) || '{}') || {}; } catch (e) { ci = {}; }
    var p = G.WTS_state && G.WTS_state.clientInfo;
    if (p) for (var k in p) if (_own(p, k) && ci[k] == null) ci[k] = p[k];
    return {
        client: ci.client || ci.clientName || ci.operator || '',
        well: ci.well || ci.wellName || '',
        field: ci.field || ci.fieldName || '',
        operator: ci.operator || '',
        ref: ci.ref || ci.jobId || '',
        engineer: ci.engineer || ''
    };
}

// C1 well store. Returns the C1 shape plus provenance per C1 key.
var WELL_PVT_KEY = { pi: 'p_res', T_R: 'T_res', T_F: 'T_res', sg: 'SG_g', fluid: 'fluidType' };
function _getWell(ds) {
    var pvt = G.PRiSM_pvt || {};
    var prov = pvt.provenance || {};
    var w = null;
    if (typeof G.PRiSM_getWell === 'function') {
        try { w = G.PRiSM_getWell(ds); } catch (e) { _warn('[report] getWell failed', e); w = null; }
    }
    if (!w || typeof w !== 'object') {
        var c = pvt._computed || {};
        var fluid = pvt.fluidType || 'oil';
        var B = fluid === 'gas' ? _num(pvt.Bg, c.Bg) : fluid === 'water' ? _num(pvt.Bw, c.B) : _num(pvt.Bo, c.Bo, c.B);
        var mu = fluid === 'gas' ? _num(pvt.mu_g, c.mu_g, c.mu) : fluid === 'water' ? _num(pvt.mu_w, c.mu) : _num(pvt.mu_o, c.mu_o, c.mu);
        var piProv = prov.p_res || prov.pi;
        var qData = NaN;
        if (ds && ds.q && ds.q.length) {
            for (var i = ds.q.length - 1; i >= 0; i--) if (_isNum(ds.q[i]) && ds.q[i] > 0) { qData = ds.q[i]; break; }
        }
        w = {
            fluid: fluid, q: _num(qData, pvt.q), B: B, mu: mu, ct: _num(pvt.ct, c.ct),
            h: _num(pvt.h), phi: _num(pvt.phi), rw: _num(pvt.rw),
            pi: (piProv === 'user' || piProv === 'sample' || piProv === 'deconvolution') ? _num(pvt.p_res) : NaN,
            T_F: _num(pvt.T_res), T_R: _num(pvt.T_res) + 459.67, sg: _num(pvt.SG_g),
            testType: pvt.testType || 'auto', tp: _num(pvt.tp), tShut: _num(pvt.tShut), pwf0: _num(pvt.pwf0)
        };
        var need = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
        w.missing = need.filter(function (k) { return !_isNum(w[k]); });
        w.defaulted = need.concat(['pi']).filter(function (k) {
            var pk = WELL_PVT_KEY[k] || k;
            var pv = prov[k] || prov[pk];
            if (k === 'B') pv = prov.B || prov.Bo || prov.Bg || prov.Bw;
            if (k === 'mu') pv = prov.mu || prov.mu_o || prov.mu_g || prov.mu_w;
            return !pv || pv === 'default';
        });
        w.complete = w.missing.length === 0;
        w._local = true;
    }
    if (!w.provenance || typeof w.provenance !== 'object') w.provenance = prov;
    return w;
}
function _provOf(well, key) {
    var prov = (well && well.provenance) || {};
    var store = (G.PRiSM_pvt && G.PRiSM_pvt.provenance) || {};
    var pk = WELL_PVT_KEY[key] || key;
    var pv = prov[key] || prov[pk] || store[key] || store[pk];
    if (key === 'B' && !pv) pv = store.Bo || store.Bg || store.Bw;
    if (key === 'mu' && !pv) pv = store.mu_o || store.mu_g || store.mu_w;
    if (!pv && well && Array.isArray(well.defaulted) && well.defaulted.indexOf(key) >= 0) pv = 'default';
    return pv || 'default';
}

// Local Bourdet derivative d(y)/d ln t with smoothing window L (ln units).
function _bourdet(t, y, L) {
    var n = t.length, d = new Array(n);
    if (n < 3) { for (var z = 0; z < n; z++) d[z] = NaN; return d; }
    var lt = t.map(function (v) { return Math.log(v); });
    L = _isNum(L) ? Math.max(0, L) : 0.1;
    for (var i = 0; i < n; i++) {
        var j = i - 1, k = i + 1;
        while (j > 0 && lt[i] - lt[j] < L) j--;
        while (k < n - 1 && lt[k] - lt[i] < L) k++;
        if (i === 0) d[i] = (y[k] - y[i]) / (lt[k] - lt[i]);
        else if (i === n - 1) d[i] = (y[i] - y[j]) / (lt[i] - lt[j]);
        else {
            var dl = lt[i] - lt[j], dr = lt[k] - lt[i];
            var m1 = (y[i] - y[j]) / dl, m2 = (y[k] - y[i]) / dr;
            d[i] = (m1 * dr + m2 * dl) / (dl + dr);
        }
    }
    return d;
}
function _bourdetFn() {
    if (typeof G.PRiSM_compute_bourdet === 'function') return G.PRiSM_compute_bourdet;
    if (typeof PRiSM_compute_bourdet === 'function') return PRiSM_compute_bourdet;   // host-scope (02)
    return _bourdet;
}

// C2 analysis data, with a sign-aware local fallback (CLAUDE.md rule).
function _getAData(ds, st, fit, well) {
    if (!ds || !ds.t || !ds.p || !ds.t.length) return null;
    var warnings = [];
    if (typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var o = {};
            if (st.activePeriod != null) o.period = st.activePeriod;
            if (st.timeFn) o.timeFn = st.timeFn;
            if (_isNum(st.bourdetL)) o.L = st.bourdetL;
            var a = G.PRiSM_getAnalysisData(ds, o);
            if (a && a.ok) return a;
            if (a && a.reason) warnings.push(String(a.reason));
        } catch (e) { warnings.push('Analysis data failed: ' + (e && e.message)); }
    }
    var t = [], tAbs = [], p = [], idx = [];
    for (var i = 0; i < ds.t.length; i++) {
        var ti = ds.t[i], pi = ds.p[i];
        if (!_isNum(ti) || !_isNum(pi)) continue;
        tAbs.push(ti); p.push(pi); idx.push(i);
    }
    if (p.length < 3) return null;
    var tt = (well && well.testType) || 'auto';
    if (tt === 'auto' || !TEST_LABELS[tt]) {
        tt = null;
        if (ds.q && ds.q.length) {
            var last = ds.q[ds.q.length - 1], seenFlow = false;
            for (var qi = 0; qi < ds.q.length; qi++) if (_isNum(ds.q[qi]) && Math.abs(ds.q[qi]) > 0) { seenFlow = true; break; }
            if (seenFlow && _isNum(last) && last === 0) tt = 'buildup';
        }
        if (!tt) tt = (p[p.length - 1] - p[0]) >= 0 ? 'buildup' : 'drawdown';   // CLAUDE.md sign rule
    }
    var rising = (tt === 'buildup' || tt === 'injection');
    var tStart = 0;
    if (rising && tt === 'buildup' && well && _isNum(well.tShut)) tStart = well.tShut;
    var pRef = NaN, src = null;
    if (fit && _isNum(fit.pRef)) { pRef = fit.pRef; src = fit.pRefSource || 'fit'; }
    else if ((tt === 'drawdown' || tt === 'injection') && well && _isNum(well.pi)) { pRef = well.pi; src = 'pi'; }
    else if ((tt === 'buildup' || tt === 'falloff') && well && _isNum(well.pwf0)) { pRef = well.pwf0; src = 'pwf0'; }
    for (var j = 0; j < tAbs.length; j++) {
        var dt = tAbs[j] - tStart;
        if (dt > 0) { t.push(dt); } else { t.push(NaN); if (!_isNum(pRef) && Math.abs(dt) < 1e-12) { pRef = p[j]; src = 't0-row'; } }
    }
    if (!_isNum(pRef)) {
        for (var f0 = 0; f0 < t.length; f0++) if (_isNum(t[f0])) { pRef = p[f0]; break; }
        src = 'first-sample';
        warnings.push('Reference pressure taken from the first data point — skin will be biased. Enter the initial pressure on step ①.');
    }
    var T = [], TA = [], P = [], DP = [], IX = [];
    for (var m = 0; m < t.length; m++) {
        if (!_isNum(t[m])) continue;
        T.push(t[m]); TA.push(tAbs[m]); P.push(p[m]); IX.push(idx[m]);
        DP.push(rising ? p[m] - pRef : pRef - p[m]);
    }
    var L = _isNum(st.bourdetL) ? st.bourdetL : 0.1;
    var deriv = null;
    try { deriv = _arr(_bourdetFn()(T, DP, L)); } catch (e) { deriv = _bourdet(T, DP, L); }
    return {
        ok: true, local: true, reason: null, n: T.length, t: T, tAbs: TA, p: P, dp: DP, deriv: deriv,
        idx: IX, x: T, L: L, timeFn: 'dt', sign: rising ? 1 : -1, pRef: pRef, pRefSource: src,
        testType: tt, tStart: tStart, tShut: well ? _num(well.tShut) : NaN, tp: well ? _num(well.tp) : NaN,
        qRef: well ? _num(well.q) : NaN, rateHistory: [], periods: [], fluid: well ? well.fluid : 'oil',
        warnings: warnings
    };
}

// Rate at each analysis point (by source index, else nearest absolute time).
function _qAt(ds, adata) {
    var out = [];
    if (!ds || !ds.q || !adata) return out;
    var n = adata.t.length;
    for (var i = 0; i < n; i++) {
        var q = NaN;
        if (adata.idx && _isNum(adata.idx[i])) q = ds.q[adata.idx[i]];
        else if (adata.tAbs) {
            var ta = adata.tAbs[i], best = -1, bd = Infinity;
            for (var j = 0; j < ds.t.length; j++) { var d = Math.abs(ds.t[j] - ta); if (d < bd) { bd = d; best = j; } }
            if (best >= 0) q = ds.q[best];
        }
        out.push(_isNum(q) ? q : NaN);
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 4 — MODEL EVALUATION (physical model → scales → preview)
// ───────────────────────────────────────────────────────────────────
function _entry(key) { return key && G.PRiSM_MODELS ? G.PRiSM_MODELS[key] : null; }

function _callPd(fn, td, params) {
    var r = fn(td, params);
    if (typeof r === 'number') return [r];
    return _arr(r);
}
function _refLength(entry, phys, well) {
    var ref = entry && entry.refLength;
    if (ref === 'xf' && phys && _isNum(phys.xf)) return phys.xf;
    if (ref === 'Lh' && phys && _isNum(phys.Lh)) return phys.Lh;
    return well ? well.rw : NaN;
}
// A = 141.2 qBμ/(kh), B = 0.0002637 k/(φ μ ct Lref²)  (C3 conversions)
function _scalesFor(fit, well) {
    var A = fit.scales ? _num(fit.scales.A) : NaN, B = fit.scales ? _num(fit.scales.B) : NaN;
    if (_isNum(A) && _isNum(B)) return { A: A, B: B };
    var ph = fit.phys || {}, w = well || {};
    var k = _num(ph.k), kh = _num(ph.kh, k * w.h);
    var Lref = _refLength(_entry(fit.modelKey), ph, w);
    A = 141.2 * w.q * w.B * w.mu / kh;
    B = 0.0002637 * k / (w.phi * w.mu * w.ct * Lref * Lref);
    return (_isNum(A) && _isNum(B) && A > 0 && B > 0) ? { A: A, B: B } : null;
}
function _dimParams(fit, well, entry) {
    var p = _copy(fit.params);
    var ph = fit.phys || {};
    if (!_isNum(p.Cd) && _isNum(ph.Cd)) p.Cd = ph.Cd;
    if (!_isNum(p.Cd) && _isNum(ph.C) && well) {
        var Lr = _refLength(entry, ph, well);
        var cd = 0.8936 * ph.C / (well.phi * well.ct * well.h * Lr * Lr);
        if (_isNum(cd)) p.Cd = cd;
    }
    if (!_isNum(p.S) && _isNum(ph.S) && entry && entry.paramSpec &&
        entry.paramSpec.some(function (s) { return s.key === 'S'; })) p.S = ph.S;
    if (!_isNum(p.__h_rw) && well && _isNum(well.h) && _isNum(well.rw)) p.__h_rw = well.h / well.rw;
    return p;
}
function _pRefDir(adata) {
    if (!adata || !adata.p || !adata.dp || !adata.p.length) return 1;
    // +1 when Δp = pRef − p (drawdown / falloff), −1 when Δp = p − pRef.
    var e1 = Math.abs(adata.dp[0] - (adata.pRef - adata.p[0]));
    var e2 = Math.abs(adata.dp[0] - (adata.p[0] - adata.pRef));
    return e1 <= e2 ? 1 : -1;
}

function _evalPressure(c, t) {
    var fit = c.fit, entry = _entry(fit.modelKey), res = null;
    if (typeof G.PRiSM_physicalModel === 'function' && fit.phys && c.adata) {
        try {
            var floatPi = !!(fit.floatPi || (fit.ci95 && fit.ci95.pi));
            var pm = G.PRiSM_physicalModel(fit.modelKey, c.well, c.adata, { floatPi: floatPi });
            if (pm && pm.ok !== false && typeof pm.dp === 'function') {
                var phys = _copy(fit.params);
                var fp = fit.phys; for (var k in fp) if (_own(fp, k)) phys[k] = fp[k];
                var dp = _arr(pm.dp(t, phys));
                if (dp && dp.length === t.length) {
                    res = {
                        t: t, dp: dp,
                        deriv: typeof pm.deriv === 'function' ? _arr(pm.deriv(t, phys)) : null,
                        p: typeof pm.p === 'function' ? _arr(pm.p(t, phys)) : null,
                        source: 'physical'
                    };
                }
            }
        } catch (e) { _warn('[report] physical model failed', e); res = null; }
    }
    if (!res && entry && typeof entry.pd === 'function') {
        var sc = _scalesFor(fit, c.well);
        if (sc) {
            try {
                var params = _dimParams(fit, c.well, entry);
                var td = t.map(function (x) { return sc.B * x; });
                var pd = _callPd(entry.pd, td, params);
                var pdp = null;
                if (typeof entry.pdPrime === 'function') { try { pdp = _callPd(entry.pdPrime, td, params); } catch (e2) { pdp = null; } }
                if (!pdp) {
                    var h = 0.02;
                    var up = _callPd(entry.pd, td.map(function (x) { return x * Math.exp(h); }), params);
                    var dn = _callPd(entry.pd, td.map(function (x) { return x * Math.exp(-h); }), params);
                    pdp = up.map(function (v, i) { return (v - dn[i]) / (2 * h); });
                }
                res = {
                    t: t, dp: pd.map(function (v) { return sc.A * v; }),
                    deriv: pdp.map(function (v) { return sc.A * v; }), p: null, source: 'scales'
                };
            } catch (e3) { _warn('[report] model evaluation failed', e3); res = null; }
        }
    }
    if (res && !res.p && c.adata && _isNum(c.adata.pRef)) {
        var dir = _pRefDir(c.adata), pr = _num(fit.pRef, c.adata.pRef);
        res.p = res.dp.map(function (v) { return pr - dir * v; });
    }
    return res;
}
function _evalRate(c, tDays) {
    var fit = c.fit, entry = _entry(fit.modelKey);
    if (!entry || typeof entry.pd !== 'function') return null;
    var hours = entry.timeInput === 'hours';
    try {
        var q = _callPd(entry.pd, tDays.map(function (d) { return hours ? d * 24 : d; }), fit.params);
        return { t: tDays, q: q, source: 'rate' };
    } catch (e) { _warn('[report] rate model failed', e); return null; }
}
// Model preview curve from the UI layer (st.modelCurveData, C6/7.4) when
// there is no fit: interpolated in log-log.
function _previewAt(st, t) {
    var mc = st.modelCurveData;
    if (!mc || !mc.t || !mc.dp || mc.t.length < 2) return null;
    function at(arr, x) {
        if (!arr) return NaN;
        var n = mc.t.length;
        if (x <= mc.t[0] || x >= mc.t[n - 1]) return NaN;
        for (var i = 1; i < n; i++) if (mc.t[i] >= x) {
            var a = Math.log(mc.t[i - 1]), b = Math.log(mc.t[i]), f = (Math.log(x) - a) / (b - a);
            return arr[i - 1] + f * (arr[i] - arr[i - 1]);
        }
        return NaN;
    }
    return { t: t, dp: t.map(function (x) { return at(mc.dp, x); }), deriv: t.map(function (x) { return at(mc.deriv, x); }), p: mc.p ? t.map(function (x) { return at(mc.p, x); }) : null, source: 'preview' };
}
function _modelAt(c, t) {
    if (!t || !t.length) return null;
    if (c.fit && c.kind !== 'rate') return _evalPressure(c, t);
    if (!c.fit) return _previewAt(c.st, t);
    return null;
}
function _logspace(a, b, n) {
    var out = [], la = Math.log(a), lb = Math.log(b);
    for (var i = 0; i < n; i++) out.push(Math.exp(la + (lb - la) * i / (n - 1)));
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 5 — DERIVED RESULTS (skin, rinv, comparison, regimes, decline)
// ───────────────────────────────────────────────────────────────────
var SL = {
    m: ['m', 'slope', 'mAbs'], b: ['b', 'intercept'], kh: ['kh'], k: ['k'],
    p1hr: ['p1hr', 'p1h', 'p1'], pStar: ['pStar', 'pstar', 'p_star'], S: ['S', 'skin', 'S_semilog'],
    C: ['C'], CD: ['CD', 'Cd'], rinv: ['rinv', 'r_inv', 'rInv'],
    dpS: ['dpS', 'dPs', 'dp_skin', 'dpSkin', 'deltaPs', 'dPskin'], FE: ['FE', 'fe', 'flowEfficiency'],
    DR: ['DR', 'dr', 'damageRatio'], J: ['J', 'PI'], J_ideal: ['J_ideal', 'Jideal', 'J_id'],
    rwa: ['rwa', 'rw_eff', 'rwPrime', 'rw_prime', 'rwEff', 'rw_apparent'], CDe2S: ['CDe2S', 'CDe2s', 'Cde2S']
};

function _skinFromInputs(inp) {
    // ΔpS = 141.2 qBμS/kh ; FE = (p̄ − pwf − ΔpS)/(p̄ − pwf) ; DR = 1/FE ;
    // J = q/(p̄ − pwf) ; J_ideal = q/(p̄ − pwf − ΔpS) ; rw′ = rw e^−S
    var r = {};
    if (inp.fluid !== 'gas') r.dpS = 141.2 * inp.q * inp.B * inp.mu * inp.S / inp.kh;
    var dd = inp.pbar - inp.pwf;
    if (_isNum(r.dpS) && _isNum(dd) && dd !== 0) {
        r.FE = (dd - r.dpS) / dd;
        r.DR = r.FE !== 0 ? 1 / r.FE : NaN;
        r.J = inp.q / dd;
        r.J_ideal = (dd - r.dpS) !== 0 ? inp.q / (dd - r.dpS) : NaN;
    }
    r.rwa = inp.rw * Math.exp(-inp.S);
    if (_isNum(inp.CD)) r.CDe2S = inp.CD * Math.exp(2 * inp.S);
    return r;
}

function _skinBlock(c, res) {
    var S = res.S, kh = res.kh, k = res.k, w = c.well || {};
    var sl = c.semilog;
    if (!_isNum(S)) return null;
    var a = c.adata, tt = (a && a.testType) || w.testType;
    var buildup = tt === 'buildup' || tt === 'falloff';
    var pbar = NaN, pwf = NaN;
    if (buildup) {
        pbar = _num(sl ? _pickNum(sl, SL.pStar) : NaN, res.pi);
        pwf = _num(w.pwf0, a && a.pRefSource === 'pwf0' ? a.pRef : NaN, a ? a.pRef : NaN);
    } else {
        pbar = _num(res.pi, a && a.pRefSource === 'pi' ? a.pRef : NaN, w.pi);
        if (a && a.p && a.p.length) pwf = a.p[a.p.length - 1];
    }
    var inp = {
        S: S, kh: kh, k: k, m: sl ? _pickNum(sl, SL.m) : NaN, q: w.q, B: w.B, mu: w.mu, rw: w.rw,
        pbar: pbar, pwf: pwf, testType: tt, CD: res.Cd, fluid: w.fluid
    };
    var out = null;
    if (typeof G.PRiSM_skinSummary === 'function') {
        try {
            var r = G.PRiSM_skinSummary(inp);
            if (r && typeof r === 'object') {
                out = {};
                for (var key in SL) if (_own(SL, key)) {
                    var v = _pickNum(r, SL[key]);
                    if (_isNum(v)) out[key] = v;
                }
            }
        } catch (e) { _warn('[report] skinSummary failed', e); out = null; }
    }
    var loc = _skinFromInputs(inp);
    if (!out) out = loc;
    else for (var lk in loc) if (_own(loc, lk) && !_isNum(out[lk])) out[lk] = loc[lk];
    out.S = S; out.pbar = pbar; out.pwf = pwf; out.pbarLabel = buildup ? 'p*' : 'pi';
    return out;
}

function _decomp(c, res) {
    if (typeof G.PRiSM_skinDecomposition !== 'function' || !c.fit) return null;
    try {
        var w = c.well || {}, p = c.fit.params || {};
        var r = G.PRiSM_skinDecomposition({
            S_total: res.S, modelKey: c.fit.modelKey, params: p,
            geom: { h: w.h, hp: _num(p.hp, _isNum(p.hp_to_h) ? p.hp_to_h * w.h : NaN), rw: w.rw,
                    kvkh: _num(p.KvKh, p.kvkh), theta: _num(p.theta_deg, p.theta), xf: _num(c.fit.phys && c.fit.phys.xf) },
            D: _num(c.st.rateSkin && c.st.rateSkin.D), q: w.q
        });
        return (r && typeof r === 'object') ? r : null;
    } catch (e) { _warn('[report] skinDecomposition failed', e); return null; }
}

function _rinv(k, t, well) {
    var w = well || {};
    var r = Math.sqrt(k * t / (948 * w.phi * w.mu * w.ct));
    return _isNum(r) ? r : NaN;
}

function _comparison(c) {
    var st = c.st, rows = [], seen = {};
    var am = st.autoMatch || st.lastAutoMatch || G.PRiSM_lastAutoMatch || null;
    // Only rankings / saved fits of the active dataset (a stamped hash that
    // differs from the current data is another well's result).
    var curHash = null;
    if (typeof G.PRiSM_datasetHash === 'function') { try { curHash = G.PRiSM_datasetHash(); } catch (e) { curHash = null; } }
    function fresh(o) { return !(curHash && o && o.datasetHash && o.datasetHash !== curHash); }
    if (am && !Array.isArray(am) && !fresh(am)) am = null;
    var ranked = Array.isArray(am) ? am : (am && Array.isArray(am.ranked) ? am.ranked : []);
    function add(r, origin) {
        if (!r || !fresh(r)) return;
        var key = r.modelKey || r.model || r.key;
        if (!key || seen[key + '|' + origin]) return;
        seen[key + '|' + origin] = true;
        rows.push({
            key: key, label: r.modelName || _modelLabel(key), aic: _num(r.aic, r.AIC), r2: _num(r.r2, r.R2),
            rmse: _num(r.rmse, r.RMSE), converged: r.converged, bestEffort: !!r.bestEffort, origin: origin,
            k: r.phys ? _num(r.phys.k) : NaN, S: r.phys ? _num(r.phys.S, r.phys.S_total) : NaN
        });
    }
    ranked.forEach(function (r) { add(r, 'race'); });
    if (Array.isArray(st.fits)) st.fits.forEach(function (f) { add(f && (f.fit || f), 'saved'); });
    var best = Infinity;
    rows.forEach(function (r) { if (_isNum(r.aic) && r.aic < best) best = r.aic; });
    rows.forEach(function (r) { r.dAIC = (_isNum(r.aic) && _isNum(best)) ? r.aic - best : NaN; });
    rows.sort(function (a, b) {
        if (_isNum(a.dAIC) && _isNum(b.dAIC)) return a.dAIC - b.dAIC;
        return _isNum(a.dAIC) ? -1 : _isNum(b.dAIC) ? 1 : 0;
    });
    var cur = c.fit && c.fit.modelKey;
    rows.forEach(function (r) { r.current = r.key === cur; });
    return rows;
}

// Comparison table (shared by the tab and the PDF). chip(label) marks the reported model.
function _comparisonTable(m, reportedMark) {
    var withKS = m.comparison.some(function (r) { return _isNum(r.k); });
    var head = ['Model', 'ΔAIC', 'R²', 'RMSE'].concat(withKS ? ['k (md)', 'S'] : []).concat(['Converged']);
    var rows = m.comparison.map(function (r) {
        var row = [_esc(r.label) + (r.current ? reportedMark : ''), _fixed(r.dAIC, 1), _isNum(r.r2) ? r.r2.toFixed(4) : '—', _fmt(r.rmse, 3)];
        if (withKS) row.push(_fmt(r.k, 3), _fixed(r.S, 2));
        row.push(r.converged === true ? 'yes' : r.converged === false ? (r.bestEffort ? 'starting point' : 'no') : '—');
        return row;
    });
    return { head: head, rows: rows };
}

// Results pinned from the rail (WP13 PRiSM_getReportPins / st.reportPins).
function _pins(c) {
    var pins = null;
    if (typeof G.PRiSM_getReportPins === 'function') { try { pins = G.PRiSM_getReportPins(); } catch (e) { pins = null; } }
    if (!Array.isArray(pins)) pins = Array.isArray(c.st.reportPins) ? c.st.reportPins : [];
    return pins.filter(function (p) { return p && typeof p === 'object'; }).map(function (p) {
        var ph = p.phys || {}, sl = p.semilog || {};
        var per = typeof p.period === 'string' ? p.period : (p.period && (p.period.label || p.period.name)) || '';
        return {
            label: p.modelName || (p.modelKey ? _modelLabel(p.modelKey) : 'Straight line'), source: p.source || '',
            k: _num(ph.k, _pickNum(sl, SL.k)), S: _num(ph.S, _pickNum(sl, SL.S)), C: _num(ph.C, _pickNum(sl, SL.C)),
            r2: _num(p.r2), when: p.timestamp ? String(p.timestamp).replace('T', ' ').slice(0, 16) : '',
            period: per, headline: p.headline || ''
        };
    });
}
function _pinsTable(m) {
    return {
        head: ['Model', 'Source', 'k (md)', 'S', 'C (bbl/psi)', 'R²', 'Pinned'],
        rows: m.pins.map(function (p) {
            return [_esc(p.label) + (p.period ? ' <span style="opacity:.7">(' + _esc(p.period) + ')</span>' : ''), _esc(_sourceLabel(p.source)),
                    _fmt(p.k, 3), _fixed(p.S, 2), _fmt(p.C, 3), _isNum(p.r2) ? p.r2.toFixed(4) : '—', _esc(p.when)];
        })
    };
}

function _regimes(c) {
    var a = c.adata;
    if (!a || typeof G.PRiSM_classifyRegimes !== 'function' || a.t.length < 4) return null;
    try {
        var r = G.PRiSM_classifyRegimes(_arr(a.t), _arr(a.p), a.deriv ? _arr(a.deriv) : undefined);
        if (!r || !Array.isArray(r.regimes)) return null;
        var list = [];
        r.regimes.forEach(function (g) {
            if (!g) return;
            var prev = list[list.length - 1];
            if (prev && prev.tag === g.tag) { prev.t1 = _num(g.tdEnd, prev.t1); return; }   // merge neighbours
            list.push({ tag: g.tag, label: g.label || REGIME_LABELS[g.tag] || _humanize(g.tag), t0: g.tdStart, t1: g.tdEnd,
                        slope: g.slope, confidence: g.confidence });
        });
        return { summary: r.summary || '', list: list };
    } catch (e) { _warn('[report] classifyRegimes failed', e); return null; }
}

// Only a real pressure fit is interpreted (a rate fit is reported by the
// decline block; default parameters are not a result).
function _interp(c) {
    if (!c.fit || c.kind === 'rate') return null;
    var st = c.st, it = st.interp || null;
    if (!it && typeof G.PRiSM_interpretCurrentFit === 'function') {
        try { it = G.PRiSM_interpretCurrentFit(); } catch (e) { it = null; }
    }
    if (!it) return null;
    return {
        narrative: it.narrative || '', actions: Array.isArray(it.actions) ? it.actions : [],
        cautions: Array.isArray(it.cautions) ? it.cautions : [], confidence: it.confidence || ''
    };
}

function _trapzDays(ds) {
    if (!ds || !ds.t || !ds.q) return NaN;
    var s = 0, n = 0;
    for (var i = 1; i < ds.t.length; i++) {
        var a = ds.q[i - 1], b = ds.q[i], dt = (ds.t[i] - ds.t[i - 1]) / 24;
        if (_isNum(a) && _isNum(b) && _isNum(dt) && dt > 0) { s += 0.5 * (a + b) * dt; n++; }
    }
    return n ? s : NaN;
}
function _decline(c) {
    if (c.kind !== 'rate' || !c.fit) return null;
    var p = c.fit.params || {}, r = null, warn = [];
    if (typeof G.PRiSM_declineResults === 'function') {
        try { r = G.PRiSM_declineResults(c.fit, c.ds, {}); } catch (e) { warn.push('Decline results failed: ' + (e && e.message)); }
    }
    var out = {
        qi: _num(_pickNum(r, ['qi']), p.qi, p.q1), Di: _num(_pickNum(r, ['Di']), p.Di),
        Di_yr: _pickNum(r, ['Di_yr', 'DiYr']), De: _pickNum(r, ['De', 'De_yr']), b: _num(_pickNum(r, ['b']), p.b),
        q_ab: _pickNum(r, ['q_ab', 'qab']), t_ab: _pickNum(r, ['t_ab', 'tab']),
        EUR: _pickNum(r, ['EUR', 'eur']), Np_hist: _num(_pickNum(r, ['Np_hist', 'Np']), _trapzDays(c.ds)),
        remaining: _pickNum(r, ['remaining', 'Remaining']),
        P10: _pickNum(r && (r.bands || r.pBands || r.percentiles) || r, ['P10', 'p10']),
        P50: _pickNum(r && (r.bands || r.pBands || r.percentiles) || r, ['P50', 'p50']),
        P90: _pickNum(r && (r.bands || r.pBands || r.percentiles) || r, ['P90', 'p90']),
        warnings: warn.concat(r && Array.isArray(r.warnings) ? r.warnings : []), eurLabel: 'EUR'
    };
    if (!_isNum(out.Di_yr) && _isNum(out.Di)) out.Di_yr = 365 * out.Di;
    if (!_isNum(out.EUR)) {
        var e = _entry(c.fit.modelKey);
        if (e && typeof e.eur === 'function') {
            try { out.EUR = e.eur(p, 30 * 365); out.eurLabel = 'Cumulative to 30 years'; } catch (e2) {}
        }
    }
    if (!_isNum(out.remaining) && _isNum(out.EUR) && _isNum(out.Np_hist)) out.remaining = out.EUR - out.Np_hist;
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 6 — REPORT MODEL
// ───────────────────────────────────────────────────────────────────
function _ctx() {
    var st = _state();
    var ds = G.PRiSM_dataset || null;
    var fit = _getFit();
    var modelKey = (fit && fit.modelKey) || st.model || null;
    var entry = _entry(modelKey);
    var kind = fit ? fit.kind : (entry && entry.kind === 'rate' ? 'rate' : 'pressure');
    if (!fit && ds && (!ds.p || !ds.p.length) && ds.q) kind = 'rate';
    var well = _getWell(ds);
    var c = { st: st, ds: ds, fit: fit, modelKey: modelKey, entry: entry, kind: kind, well: well,
              mode: (G.PRiSM && G.PRiSM.mode) || 'transient', semilog: null };
    c.adata = kind === 'rate' ? null : _getAData(ds, st, fit, well);
    // The straight-line result is reported only for the data it was made on.
    var sl = st.semilog;
    if (kind !== 'rate' && sl && typeof sl === 'object' && sl.ok !== false) {
        var same = true;
        if (sl.datasetHash && typeof G.PRiSM_datasetHash === 'function') {
            try { same = sl.datasetHash === G.PRiSM_datasetHash(ds); } catch (e) { same = true; }
        }
        if (same) c.semilog = sl;
    }
    return c;
}

// Physical results: lastFit.phys first, then C3 conversions from scales.
function _physResults(c) {
    var fit = c.fit, w = c.well || {}, res = {}, ci = {};
    if (fit && fit.kind !== 'rate') {
        var ph = fit.phys || {}, p = fit.params || {};
        res.k = _num(ph.k); res.kh = _num(ph.kh, res.k * w.h);
        if (!_isNum(res.k) && _isNum(res.kh)) res.k = res.kh / w.h;
        if (!_isNum(res.k) && fit.scales && _isNum(fit.scales.A)) {
            res.kh = 141.2 * w.q * w.B * w.mu / fit.scales.A;
            res.k = res.kh / w.h;
        }
        // Scale mode: params.Cd is the arbitrary reference Cd, not a result.
        res.C = _num(ph.C); res.Cd = fit.mode === 'scale' ? _num(ph.Cd) : _num(ph.Cd, p.Cd);
        var Lr = _refLength(c.entry, ph, w);
        if (!_isNum(res.C) && _isNum(res.Cd)) res.C = res.Cd * w.phi * w.ct * w.h * Lr * Lr / 0.8936;
        if (!_isNum(res.Cd) && _isNum(res.C)) res.Cd = 0.8936 * res.C / (w.phi * w.ct * w.h * Lr * Lr);
        // Scale mode (φ, ct or rw missing): params.S is the curve's skin at an
        // arbitrary reference Cd, not a result — skin comes from phys only.
        var scaleMode = fit.mode === 'scale';
        res.scaleMode = scaleMode;
        res.S = scaleMode ? _num(ph.S, ph.S_total) : _num(ph.S, ph.S_total, p.S);
        res.pi = _num(ph.pi);
        res.xf = _num(ph.xf); res.Lh = _num(ph.Lh);
        res.distances = ph.distances_ft || ph.distances || null;
        var f = fit.ci95 || {};
        ['k', 'C', 'Cd', 'S', 'pi', 'xf', 'Lh'].forEach(function (k) {
            if (Array.isArray(f[k]) && f[k].length === 2) ci[k] = [f[k][0], f[k][1]];
        });
        if (!ci.Cd && ci.C && _isNum(res.C) && _isNum(res.Cd)) ci.Cd = [ci.C[0] * res.Cd / res.C, ci.C[1] * res.Cd / res.C];
        if (ci.k && _isNum(w.h)) ci.kh = [ci.k[0] * w.h, ci.k[1] * w.h];
        else if (Array.isArray(f.kh)) ci.kh = [f.kh[0], f.kh[1]];
        res.source = fit.source || 'regression';
        // extra skin components of wells with separate skins
        res.skins = {};
        ['S_perf', 'S_global', 'Sf', 'Sg', 'S_total'].forEach(function (k) {
            var v = (scaleMode && k !== 'Sf') ? _num(ph[k]) : _num(ph[k], p[k]);
            if (_isNum(v)) { res.skins[k] = v; if (Array.isArray(f[k])) ci[k] = f[k]; }
        });
        if (!_isNum(res.S) && _isNum(res.skins.S_total)) res.S = res.skins.S_total;
    } else if (!fit && c.semilog && c.semilog.ok !== false) {
        var sl = c.semilog;
        res.k = _pickNum(sl, SL.k); res.kh = _num(_pickNum(sl, SL.kh), res.k * w.h);
        res.S = _pickNum(sl, SL.S); res.C = _pickNum(sl, SL.C); res.Cd = _pickNum(sl, SL.CD);
        res.pi = NaN; res.source = 'semilog';
    }
    if (!_isNum(res.pi) && c.kind !== 'rate') { res.piInput = _num(w.pi); }
    // rinv at the end of the analysed data
    var tEnd = c.adata && c.adata.t && c.adata.t.length ? c.adata.t[c.adata.t.length - 1] : NaN;
    res.rinv = _num(fit && fit.phys ? _num(fit.phys.rinv) : NaN, _rinv(res.k, tEnd, w));
    res.tEnd = tEnd;
    res.ci = ci;
    return res;
}

// Type-curve position of the reported result: the fit's own (PM = 1/A,
// TM = B), the manual match when that is the result, else the manual match.
function _tcMatch(c) {
    var f = c.fit, tc = c.st.tcMatch;
    var tcOk = !!(tc && _isNum(tc.logPM) && _isNum(tc.logTM));
    if (f && f.kind !== 'rate') {
        var ph = f.phys || {};
        if (_isNum(ph.logPM) && _isNum(ph.logTM)) return { logPM: ph.logPM, logTM: ph.logTM, source: f.source || 'fit' };
        if (f.source === 'match' && tcOk) return { logPM: tc.logPM, logTM: tc.logTM, source: 'match' };
        var sc = _scalesFor(f, c.well);
        if (sc) return { logPM: -Math.log(sc.A) / Math.LN10, logTM: Math.log(sc.B) / Math.LN10, source: f.source || 'fit' };
    }
    return tcOk ? { logPM: tc.logPM, logTM: tc.logTM, source: tc.source || 'match' } : null;
}

function reportData() {
    var c = _ctx();
    var st = c.st, ds = c.ds, fit = c.fit, w = c.well || {}, a = c.adata;
    var ci = _clientInfo();
    var hasData = !!(ds && ds.t && ds.t.length);
    var testType = (a && a.testType) || (c.kind === 'rate' ? 'rate' : w.testType) || '';
    var periodLabel = '';
    if (a && a.t && a.t.length) {
        var per = null;
        if (st.activePeriod != null && Array.isArray(a.periods)) per = a.periods[st.activePeriod] || null;
        periodLabel = (per ? 'Period ' + (Number(st.activePeriod) + 1) + ': ' : '') +
            'Δt ' + _fmt(a.t[0], 3) + '–' + _fmt(a.t[a.t.length - 1], 4) + ' h';
    } else if (hasData) {
        periodLabel = 't ' + _fmt(ds.t[0], 3) + '–' + _fmt(ds.t[ds.t.length - 1], 4) + ' h';
    }
    var model = {
        ok: true, generatedAt: _today(), kind: c.kind, hasData: hasData, mode: c.mode,
        header: {
            client: ci.client, well: ci.well, field: ci.field, operator: ci.operator, ref: ci.ref, engineer: ci.engineer,
            testType: testType, testLabel: _testLabel(testType), periodLabel: periodLabel,
            nPoints: hasData ? ds.t.length : 0, datasetName: (ds && (ds.name || ds.fileName)) || ''
        },
        model: c.modelKey ? {
            key: c.modelKey, label: _modelLabel(c.modelKey),
            category: c.entry && c.entry.category || '', description: c.entry && c.entry.description || '',
            reference: c.entry && c.entry.reference || ''
        } : null,
        fit: fit, stale: !!(fit && fit.stale), units: _units(w.fluid),
        warnings: [], well: w
    };
    if (fit && Array.isArray(fit.warnings)) model.warnings = model.warnings.concat(fit.warnings);
    if (a && Array.isArray(a.warnings)) model.warnings = model.warnings.concat(a.warnings);
    model.warnings = model.warnings.filter(function (x, i, arr) { return x && arr.indexOf(x) === i; }).map(String);

    // Results
    var res = _physResults(c);
    model.res = res;
    model.skin = (c.kind !== 'rate') ? _skinBlock(c, res) : null;
    model.decomp = (c.kind !== 'rate' && _isNum(res.S)) ? _decomp(c, res) : null;
    model.stats = fit ? {
        source: fit.source || 'regression', r2: fit.r2, rmse: fit.rmse, aic: fit.aic, dAIC: (_isNum(fit.dAICnext) && fit.dAICnext > 0) ? fit.dAICnext : ((_isNum(fit.dAIC) && fit.dAIC > 0) ? fit.dAIC : NaN), secondModelKey: fit.secondModelKey || '',
        iterations: _num(fit.iterations), converged: fit.converged, objective: fit.objective || '',
        window: fit.window || null, identifiable: fit.identifiable || null, elapsedMs: _num(fit.elapsedMs)
    } : null;
    model.tc = (c.kind !== 'rate') ? _tcMatch(c) : null;
    model.params = _paramRows(c);
    model.interp = _interp(c);
    model.comparison = _comparison(c);
    model.pins = _pins(c);
    model.regimes = _regimes(c);
    model.semilog = _semilogBlock(c, res);
    model.keys = _keyResults(st.analysisKeyResults);
    model.decline = _decline(c);
    model.data = a ? {
        n: a.n || a.t.length, t0: a.t[0], t1: a.t[a.t.length - 1], pRef: a.pRef, pRefSource: a.pRefSource,
        pRefLabel: PREF_LABELS[a.pRefSource] || a.pRefSource || '', testType: a.testType, tp: _num(a.tp),
        timeFn: a.timeFn || '', L: _num(a.L), fluid: a.fluid || w.fluid, local: !!a.local
    } : null;
    model.inputs = _inputRows(c);
    model.results = _resultRows(model, c);
    model.notes = _notes();
    model.ctx = c;
    return model;
}

function _paramRows(c) {
    var fit = c.fit, st = c.st, rows = [];
    var params = (fit && fit.params) || st.params || {};
    var ci = (fit && fit.ci95) || {};
    var spec = (c.entry && c.entry.paramSpec) || [];
    var seen = {};
    function push(key, label, unit) {
        var v = params[key];
        seen[key] = true;
        if (v == null) return;
        var num = _isNum(v);
        rows.push({
            key: key, label: label || key, unit: unit && unit !== '-' ? unit : '',
            value: num ? v : (Array.isArray(v) ? '(' + v.length + ' items)' : String(v)),
            lo: Array.isArray(ci[key]) ? ci[key][0] : NaN, hi: Array.isArray(ci[key]) ? ci[key][1] : NaN,
            frozen: !!(st.paramFreeze && st.paramFreeze[key]),
            identifiable: fit && fit.identifiable ? fit.identifiable[key] : undefined
        });
    }
    spec.forEach(function (s) { push(s.key, s.label, s.unit); });
    for (var k in params) if (_own(params, k) && !seen[k] && k.indexOf('__') !== 0) push(k, k, '');
    return rows;
}

function _semilogBlock(c, res) {
    var sl = c.semilog;
    if (!sl || typeof sl !== 'object' || sl.ok === false) return null;
    var o = {
        method: _pick(sl, ['method', 'kind']) || '', methodLabel: sl.methodLabel || '', m: _pickNum(sl, SL.m), b: _pickNum(sl, SL.b),
        kh: _pickNum(sl, SL.kh), k: _pickNum(sl, SL.k), p1hr: _pickNum(sl, SL.p1hr), pStar: _pickNum(sl, SL.pStar),
        S: _pickNum(sl, SL.S), C: _pickNum(sl, SL.C), CD: _pickNum(sl, SL.CD), rinv: _pickNum(sl, SL.rinv),
        window: _pick(sl, ['window', 'win']) || null, warnings: Array.isArray(sl.warnings) ? sl.warnings : []
    };
    if (!_isNum(o.k) && _isNum(o.kh) && c.well && _isNum(c.well.h)) o.k = o.kh / c.well.h;
    if (c.fit && c.fit.kind !== 'rate' && _isNum(res.k) && _isNum(o.k)) {
        o.dk_pct = 100 * (o.k - res.k) / res.k;
        o.dS = _isNum(res.S) && _isNum(o.S) ? o.S - res.S : NaN;
        o.agree = Math.abs(o.dk_pct) <= 5 && (!_isNum(o.dS) || Math.abs(o.dS) <= 0.3);
    }
    return o;
}

// analysisKeyResults (plot keys, WP10) → flat rows {label, value, unit}
function _keyResults(akr) {
    var rows = [];
    if (!akr || typeof akr !== 'object') return rows;
    var list = Array.isArray(akr) ? akr : Object.keys(akr).map(function (k) {
        var v = akr[k];
        return (v && typeof v === 'object') ? Object.assign({ key: k }, v) : { key: k, value: v };
    });
    list.forEach(function (r) {
        if (!r) return;
        var name = r.label || r.name || r.key || '';
        if (_isNum(r.value)) { rows.push({ label: name, value: r.value, unit: r.unit || '' }); return; }
        var box = r.results || r.result || r.values || null;
        if (box && typeof box === 'object') {
            for (var k in box) if (_own(box, k) && _isNum(box[k])) rows.push({ label: name + ' — ' + k, value: box[k], unit: '' });
        }
    });
    return rows.slice(0, 40);
}

var INPUT_DEFS = [
    ['testType', 'Test type', ''], ['pi', 'Initial reservoir pressure pi', 'psia'],
    ['q', 'Rate q', 'q'], ['B', 'Formation volume factor B', 'B'], ['mu', 'Viscosity μ', 'cp'],
    ['ct', 'Total compressibility ct', '1/psi'], ['h', 'Net pay h', 'ft'], ['phi', 'Porosity φ', 'fraction'],
    ['rw', 'Wellbore radius rw', 'ft'], ['T_F', 'Reservoir temperature', '°F'], ['fluid', 'Fluid', ''],
    ['tp', 'Producing time before shut-in tp', 'h'], ['tShut', 'Shut-in time', 'h'], ['pwf0', 'Flowing pressure at shut-in', 'psia']
];
function _inputRows(c) {
    var w = c.well || {}, u = _units(w.fluid), rows = [];
    INPUT_DEFS.forEach(function (d) {
        var key = d[0], v = w[key];
        if (v == null || (typeof v === 'number' && !isFinite(v))) {
            if (key === 'tp' || key === 'tShut' || key === 'pwf0' || key === 'T_F') return;   // optional
        }
        var unit = d[2] === 'q' ? u.q : d[2] === 'B' ? u.B : d[2];
        var pv = w.provenance || {};
        var prov = key === 'fluid' ? (pv.fluidType || pv.fluid || '') : key === 'testType' ? (pv.testType || '') : _provOf(w, key);
        var missing = (w.missing || []).indexOf(key) >= 0 || (key === 'pi' && !_isNum(v));
        rows.push({
            key: key, label: d[1], unit: unit,
            value: typeof v === 'number' ? v : (key === 'testType' ? _testLabel(v) : (v == null ? '' : String(v))),
            provenance: prov, isDefault: prov === 'default' && key !== 'fluid' && key !== 'testType', missing: missing
        });
    });
    return rows;
}

function _resultRows(m, c) {
    var r = m.res, u = m.units, rows = [], src = r.source || '';
    function add(key, label, v, unit, sig, lo, hi, source, note) {
        if (!_isNum(v)) return;
        rows.push({ key: key, label: label, value: v, unit: unit, sig: sig || 3, lo: lo, hi: hi,
                    source: source || src, note: note || '' });
    }
    var ci = r.ci || {};
    var idf = (m.fit && m.fit.identifiable) || {};
    function note(k) { return idf[k] === false ? 'not resolved by the data' : ''; }
    if (c.kind === 'rate') return rows;
    add('k', 'Permeability k', r.k, 'md', 3, ci.k && ci.k[0], ci.k && ci.k[1], src, note('k'));
    add('kh', 'Permeability-thickness kh', r.kh, 'md·ft', 4, ci.kh && ci.kh[0], ci.kh && ci.kh[1], src);
    add('C', 'Wellbore storage C', r.C, 'bbl/psi', 3, ci.C && ci.C[0], ci.C && ci.C[1], src, note('C'));
    add('Cd', 'Dimensionless storage CD', r.Cd, '', 3, ci.Cd && ci.Cd[0], ci.Cd && ci.Cd[1], src);
    add('S', 'Skin S', r.S, '', 3, ci.S && ci.S[0], ci.S && ci.S[1], src, note('S'));
    if (!_isNum(r.S) && r.scaleMode) {
        rows.push({ key: 'S', label: 'Skin S', value: NaN, text: 'not identifiable (enter φ, ct, rw)', unit: '', sig: 3,
                    lo: NaN, hi: NaN, source: src, note: '' });
    }
    for (var sk in r.skins || {}) if (_own(r.skins, sk) && sk !== 'S_total') {
        add(sk, 'Skin component ' + sk, r.skins[sk], '', 3, ci[sk] && ci[sk][0], ci[sk] && ci[sk][1], src, note(sk));
    }
    if (_isNum(r.pi)) add('pi', 'Initial pressure pi', r.pi, 'psia', 5, ci.pi && ci.pi[0], ci.pi && ci.pi[1], src, 'fitted');
    else if (_isNum(r.piInput)) add('pi', 'Initial pressure pi', r.piInput, 'psia', 5, NaN, NaN, 'input');
    add('xf', 'Fracture half-length xf', r.xf, 'ft', 3, ci.xf && ci.xf[0], ci.xf && ci.xf[1], src, note('xf'));
    add('Lh', 'Horizontal length Lh', r.Lh, 'ft', 3, ci.Lh && ci.Lh[0], ci.Lh && ci.Lh[1], src, note('Lh'));
    var d = r.distances;
    if (d && typeof d === 'object') {
        var labels = {};
        ((c.entry && c.entry.paramSpec) || []).forEach(function (s) { labels[s.key] = s.label; });
        if (Array.isArray(d)) d.forEach(function (v, i) { add('dist' + i, 'Distance to boundary ' + (i + 1), v, 'ft', 3); });
        else for (var dk in d) if (_own(d, dk)) add('dist_' + dk, 'Distance to boundary (' + (labels[dk] || dk) + ')', d[dk], 'ft', 3);
    }
    add('rinv', 'Radius of investigation (end of data)', r.rinv, 'ft', 4, NaN, NaN, 'derived');
    var s = m.skin;
    if (s) {
        add('dpS', 'Pressure drop due to skin ΔpS', s.dpS, 'psi', 3, NaN, NaN, 'derived');
        add('FE', 'Flow efficiency FE', s.FE, '', 3, NaN, NaN, 'derived');
        add('DR', 'Damage ratio DR', s.DR, '', 3, NaN, NaN, 'derived');
        add('J', 'Productivity index J', s.J, u.J, 3, NaN, NaN, 'derived');
        add('J_ideal', 'Productivity index without skin', s.J_ideal, u.J, 3, NaN, NaN, 'derived');
        add('rwa', 'Effective wellbore radius rw′', s.rwa, 'ft', 3, NaN, NaN, 'derived');
    }
    return rows;
}

function _notes() {
    try { var ls = _ls(); return (ls && ls.getItem('wts_prism_report_notes')) || ''; } catch (e) { return ''; }
}

// Compact results for the rail / quick report / job report summary.
function reportResults() {
    var m = reportData(), r = m.res || {}, s = m.skin || {}, f = m.fit;
    return {
        ok: !!(f || (m.semilog && _isNum(m.semilog.k))),
        modelKey: m.model ? m.model.key : null, modelLabel: m.model ? m.model.label : '',
        kind: m.kind, source: r.source || (f && f.source) || '', sourceLabel: _sourceLabel(r.source || (f && f.source)),
        stale: m.stale, converged: f ? f.converged : undefined, iterations: f ? _num(f.iterations) : NaN,
        r2: f ? f.r2 : NaN, rmse: f ? f.rmse : NaN, rmseUnit: m.kind === 'rate' ? m.units.q : 'psi', aic: f ? f.aic : NaN,
        k: r.k, kh: r.kh, C: r.C, Cd: r.Cd, S: r.S, pi: _num(r.pi, r.piInput), xf: r.xf, Lh: r.Lh, rinv: r.rinv,
        dpS: s.dpS, FE: s.FE, DR: s.DR, J: s.J, J_ideal: s.J_ideal, rwa: s.rwa, ci: r.ci || {},
        narrative: m.interp ? m.interp.narrative : '', semilog: m.semilog, decline: m.decline,
        testType: m.header.testType, units: m.units
    };
}

// ───────────────────────────────────────────────────────────────────
// SECTION 7 — CSV
// ───────────────────────────────────────────────────────────────────
var CSV_PRESSURE = ['t_hr', 'p_psia', 'q', 'dp_psi', 'dp_deriv_psi', 'model_dp_psi', 'model_dp_deriv_psi', 'residual_psi'];
var CSV_RATE = ['t_day', 'q', 'model_q', 'residual_q'];
function _csvNum(v) { return _isNum(v) ? String(+v.toPrecision(10)) : ''; }

function buildReportCSV() {
    var c = _ctx(), ds = c.ds;
    if (!ds || !ds.t || !ds.t.length) throw new Error('No dataset loaded — load data on step ① first.');
    var rows = [], header, kind;
    var mk = c.modelKey || 'data';
    if (c.kind === 'rate') {
        kind = 'rate'; header = CSV_RATE.slice();
        var td = [], qd = [];
        for (var i = 0; i < ds.t.length; i++) {
            if (!_isNum(ds.t[i]) || !(ds.t[i] > 0) || !ds.q || !_isNum(ds.q[i])) continue;
            td.push(ds.t[i] / 24); qd.push(ds.q[i]);
        }
        var mq = c.fit ? _evalRate(c, td) : null;
        for (var j = 0; j < td.length; j++) {
            var m = mq && mq.q ? mq.q[j] : NaN;
            rows.push([td[j], qd[j], m, _isNum(m) ? qd[j] - m : NaN]);
        }
    } else {
        kind = 'pressure'; header = CSV_PRESSURE.slice();
        var a = c.adata;
        if (!a) throw new Error('No pressure data to export.');
        var q = _qAt(ds, a);
        var model = _modelAt(c, a.t);
        var shift = 0;
        // A fit that floated pi measures Δp from its own pi (drawdown/injection).
        if (c.fit && _isNum(c.fit.pRef) && _isNum(a.pRef) && Math.abs(c.fit.pRef - a.pRef) > 1e-9 &&
            (a.testType === 'drawdown' || a.testType === 'injection')) {
            shift = _pRefDir(a) * (c.fit.pRef - a.pRef);
        }
        for (var k = 0; k < a.t.length; k++) {
            var dp = a.dp[k] + shift;
            var md = model && model.dp ? model.dp[k] : NaN;
            var mdd = model && model.deriv ? model.deriv[k] : NaN;
            rows.push([a.t[k], a.p[k], q[k], dp, a.deriv ? a.deriv[k] : NaN, md, mdd, _isNum(md) ? dp - md : NaN]);
        }
    }
    var lines = [header.join(',')];
    rows.forEach(function (r) { lines.push(r.map(_csvNum).join(',')); });
    var ci = _clientInfo();
    var d = new Date();
    var stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    var filename = 'prism_' + (ci.well ? _slug(ci.well) + '_' : '') + _slug(mk) + '_' + stamp + '.csv';
    return { filename: filename, header: header, rows: rows, text: lines.join('\n'), kind: kind };
}

function _download(filename, text, mime) {
    if (!_hasDoc) return false;
    try {
        var blob = new Blob([text], { type: mime || 'text/csv' });
        var url = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob)
            : 'data:' + (mime || 'text/csv') + ';charset=utf-8,' + encodeURIComponent(text);
        var a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        try { document.body.removeChild(a); } catch (e) {}
        if (/^blob:/.test(url) && URL.revokeObjectURL) setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
        return true;
    } catch (e) { _warn('[report] download failed', e); return false; }
}

function exportCSV() {
    var r = buildReportCSV();
    r.downloaded = _download(r.filename, r.text, 'text/csv');
    return r;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 8 — PLOTS (C6 payloads via PRiSM_buildPlotData, else local)
// ───────────────────────────────────────────────────────────────────
var DEFAULT_PLOT_FN = {
    bourdet: 'PRiSM_plot_bourdet', cartesian: 'PRiSM_plot_cartesian', horner: 'PRiSM_plot_horner',
    mdh: 'PRiSM_plot_mdh', superposition: 'PRiSM_plot_buildup_superposition',
    rateSemi: 'PRiSM_plot_rate_time_semilog', rateCum: 'PRiSM_plot_rate_cumulative'
};
function _plotFn(key) {
    var reg = G.PRiSM_PLOT_REGISTRY, e = reg && reg[key], fn = e ? e.fn : DEFAULT_PLOT_FN[key];
    if (typeof fn === 'function') return fn;
    if (typeof fn === 'string' && typeof G[fn] === 'function') return G[fn];
    if (DEFAULT_PLOT_FN[key] && typeof G[DEFAULT_PLOT_FN[key]] === 'function') return G[DEFAULT_PLOT_FN[key]];
    return null;
}
function _semilogKey(c) {
    var sl = c.semilog, mth = sl ? String(_pick(sl, ['method', 'kind']) || '').toLowerCase() : '';
    if (/horner/.test(mth)) return 'horner';
    if (/super/.test(mth)) return 'superposition';
    if (/mdh|agarwal/.test(mth)) return 'mdh';
    var tt = c.adata && c.adata.testType;
    return (tt === 'buildup' || tt === 'falloff') ? 'horner' : 'mdh';
}
function _plotSpecs(c) {
    var withModel = c.fit ? ' with the model' : '', withLine = c.semilog ? ' with the straight line' : '';
    if (c.kind === 'rate') {
        return [
            { id: 'rate', key: 'rateSemi', title: 'Rate vs time' + (c.fit ? ' with the decline model' : '') },
            { id: 'cum', key: 'rateCum', title: 'Rate vs cumulative production' }
        ];
    }
    var sk = _semilogKey(c);
    return [
        { id: 'loglog', key: 'bourdet', title: 'Log-log diagnostic: Δp and derivative' + withModel },
        { id: 'semilog', key: sk, title: (sk === 'horner' ? 'Horner plot' : sk === 'superposition' ? 'Superposition plot' : 'Semilog (MDH) plot') + withLine },
        { id: 'history', key: 'cartesian', title: 'Pressure and rate history' + withModel }
    ];
}
function _semilogLine(c) {
    var sl = c.semilog;
    if (!sl) return null;
    var m = _pickNum(sl, SL.m), b = _pickNum(sl, SL.b), p1 = _pickNum(sl, SL.p1hr);
    if (sl.line && _isNum(sl.line.m) && _isNum(sl.line.b)) return sl.line;
    if (!_isNum(m)) return null;
    var w = _pick(sl, ['window', 'win']) || {};
    var falling = c.adata && (c.adata.testType === 'drawdown' || c.adata.testType === 'falloff');
    var sm = (falling && m > 0) ? -m : m;
    if (!_isNum(b) && _isNum(p1)) b = p1;
    return _isNum(b) ? { m: sm, b: b, t0: w.t0, t1: w.t1 } : null;
}
function _localPlotData(c, spec) {
    var a = c.adata, ds = c.ds, st = c.st, data = null, opts = {};
    if (spec.key === 'bourdet' && a) {
        data = { t: a.t.slice(), dp: a.dp.slice(), deriv: a.deriv ? a.deriv.slice() : null, x: a.x || null };
        opts.smoothL = _isNum(st.bourdetL) ? st.bourdetL : 0.1;
    } else if ((spec.key === 'mdh' || spec.key === 'horner' || spec.key === 'superposition') && a) {
        data = { t: a.t.slice(), p: a.p.slice(), dp: a.dp.slice(), tp: _num(a.tp, c.well && c.well.tp) };
        var line = _semilogLine(c);
        if (line) data.line = line;
    } else if (spec.key === 'cartesian' && ds && ds.p) {
        data = { t: ds.t.slice(), p: ds.p.slice(), q: ds.q ? ds.q.slice() : null, periods: a && a.periods ? a.periods : [] };
    } else if ((spec.key === 'rateSemi' || spec.key === 'rateCum') && ds && ds.q) {
        var t = [], q = [];
        for (var i = 0; i < ds.t.length; i++) if (_isNum(ds.t[i]) && ds.t[i] > 0 && _isNum(ds.q[i])) { t.push(ds.t[i] / 24); q.push(ds.q[i]); }
        data = { t: t, q: q };
        opts.xLabel = 'Time (days)'; opts.timeUnit = 'd';
    }
    return data ? { data: data, opts: opts } : null;
}
function _withOverlay(c, spec, payload) {
    var d = payload.data;
    if (!d || d.overlay || !c.fit) return payload;
    try {
        if (spec.key === 'bourdet' && c.adata && c.adata.t.length) {
            var a = c.adata, t0 = Math.min.apply(null, a.t), t1 = Math.max.apply(null, a.t);
            var tm = _logspace(t0, t1, 120), mm = _modelAt(c, tm);
            if (mm && mm.dp) d.overlay = { t: tm, dp: mm.dp, deriv: mm.deriv || null };
        } else if (spec.key === 'cartesian' && c.adata && c.adata.t.length) {
            var ad = c.adata, m2 = _modelAt(c, ad.t);
            if (m2 && m2.p) d.overlay = { t: ad.tAbs ? ad.tAbs.slice() : ad.t.map(function (x) { return x + (ad.tStart || 0); }), p: m2.p };
        } else if ((spec.key === 'rateSemi' || spec.key === 'rateCum') && d.t && d.t.length && c.kind === 'rate') {
            var mr = _evalRate(c, d.t.slice());
            if (mr && mr.q) d.overlay = { t: d.t.slice(), q: mr.q };
        }
    } catch (e) { _warn('[report] overlay failed', e); }
    return payload;
}
function _plotPayload(c, spec) {
    var payload = null;
    if (typeof G.PRiSM_buildPlotData === 'function') {
        try {
            var r = G.PRiSM_buildPlotData(spec.key);
            if (r && r.data) payload = { data: r.data, opts: _copy(r.opts) };
        } catch (e) { payload = null; }
    }
    if (!payload) payload = _localPlotData(c, spec);
    if (!payload) return null;
    if ((spec.key === 'mdh' || spec.key === 'horner' || spec.key === 'superposition') && !payload.data.line) {
        var line = _semilogLine(c);
        if (line) payload.data.line = line;
    }
    return _withOverlay(c, spec, payload);
}
function _drawPlot(canvas, c, spec, size) {
    var fn = _plotFn(spec.key);
    if (!fn) return false;
    var payload = _plotPayload(c, spec);
    if (!payload) return false;
    var opts = _copy(payload.opts);
    opts.width = size.width; opts.height = size.height;
    opts.hover = !!size.hover; opts.dragZoom = false; opts.showLegend = true;
    try { fn(canvas, payload.data, opts); } catch (e) { _warn('[report] plot ' + spec.key + ' failed', e); return false; }
    var hooks = G.PRiSM_postDrawHooks;
    if (Array.isArray(hooks)) hooks.forEach(function (h) {
        try { if (typeof h === 'function') h({ canvas: canvas, plotKey: spec.key, data: payload.data, opts: opts, axes: canvas._prismAxes || null, report: true }); }
        catch (e) {}
    });
    return true;
}
function _plotImages(c) {
    var out = [];
    if (!_hasDoc) return out;
    _plotSpecs(c).forEach(function (spec) {
        if (!_plotFn(spec.key)) return;
        try {
            var cv = document.createElement('canvas');
            cv.width = 900; cv.height = 480;
            if (!_drawPlot(cv, c, spec, { width: 900, height: 480, hover: false })) return;
            var url = cv.toDataURL('image/png');
            if (url) out.push({ title: spec.title, src: url, key: spec.key });
        } catch (e) { _warn('[report] plot image failed', e); }
    });
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 9 — PDF / job-report HTML (host rp-* report classes)
// ───────────────────────────────────────────────────────────────────
function _valueStr(row) {
    if (row.text) return { str: row.text, pm: '', full: row.text };
    var str = row.key === 'S' || /^S_|^Sf|^Sg/.test(row.key) ? _fixed(row.value, 2)
        : row.key === 'pi' ? _fixed(row.value, 1) : _fmt(row.value, row.sig);
    var pm = _fmtPM(row.value, str, row.lo, row.hi);
    return { str: str, pm: pm, full: str + (pm ? ' ± ' + pm : '') };
}
function _rpKV(pairs) {
    return '<div class="rp-kv">' + pairs.filter(function (p) { return p && p[1] !== '' && p[1] != null; }).map(function (p) {
        return '<div class="rp-kvr"><span>' + _esc(p[0]) + '</span><b>' + _esc(p[1]) + '</b></div>';
    }).join('') + '</div>';
}
function _rpTable(head, rows) {
    return '<div class="rp-tblwrap"><table class="rp-tbl"><thead><tr>' +
        head.map(function (h) { return '<th>' + _esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (cell, i) {
            return '<td' + (i === 0 ? ' class="b"' : '') + '>' + cell + '</td>'; }).join('') + '</tr>'; }).join('') +
        '</tbody></table></div>';
}
function _statsPairs(m) {
    var s = m.stats, u = m.kind === 'rate' ? m.units.q : 'psi', out = [];
    if (m.model) out.push(['Model', m.model.label + ' (' + m.model.key + ')']);
    if (s) {
        out.push(['Result from', _sourceLabel(s.source)]);
        out.push(['R²', _isNum(s.r2) ? s.r2.toFixed(s.r2 >= 0.99999 ? 6 : 5) : '—']);
        out.push(['RMSE', _isNum(s.rmse) ? _fmt(s.rmse, 3) + ' ' + u : '—']);
        out.push(['AIC', _isNum(s.aic) ? s.aic.toFixed(1) : '—']);
        if (_isNum(s.dAIC)) out.push(['ΔAIC to the next model' + (s.secondModelKey ? ' (' + _modelLabel(s.secondModelKey) + ')' : ''), s.dAIC.toFixed(1)]);
        out.push(['Iterations', _isNum(s.iterations) ? String(Math.round(s.iterations)) : '—']);
        out.push(['Converged', s.converged === true ? 'yes' : s.converged === false ? 'no' : '—']);
        if (s.window && (_isNum(s.window.tmin) || _isNum(s.window.tmax))) {
            out.push(['Fit window', _fmt(s.window.tmin, 3) + '–' + _fmt(s.window.tmax, 4) + ' h']);
        }
    }
    if (m.tc) {
        out.push(['Pressure match (log PM)', m.tc.logPM.toFixed(3)]);
        out.push(['Time match (log TM)', m.tc.logTM.toFixed(3)]);
    }
    return out;
}
function _unresolved(m) {
    var idf = m.stats && m.stats.identifiable, bad = [];
    if (idf) for (var k in idf) if (_own(idf, k) && idf[k] === false) bad.push(k);
    return bad;
}

function buildReportHTML(opts) {
    opts = opts || {};
    var m = opts.model || reportData();
    var h = '', u = m.units;
    var hd = m.header;
    // Test & well summary
    h += '<section class="rp-sec"><h2>Well test</h2>' + _rpKV([
        ['Client', hd.client], ['Well', hd.well], ['Field', hd.field],
        ['Test type', hd.testLabel], ['Analysed period', hd.periodLabel],
        ['Data points', hd.nPoints ? String(hd.nPoints) : ''], ['Model', m.model ? m.model.label : ''],
        ['Report date', m.generatedAt]
    ]) + '</section>';
    if (!m.hasData) {
        h += '<div class="rp-note n-amber"><b>No data.</b>Load pressure or rate data in PRiSM before issuing a report.</div>';
        return h;
    }
    if (m.stale) h += '<div class="rp-note n-amber"><b>Check:</b>The fit was made on different data or a different model. Re-run the fit before relying on these numbers.</div>';
    if (!m.fit) h += '<div class="rp-note n-blue"><b>No model fit yet.</b>Results below come from the straight-line analysis and inputs only.</div>';

    // Key results
    if (m.results.length) {
        h += '<section class="rp-sec rp-out"><h2>Key results (field units)</h2>' + _rpTable(
            ['Quantity', 'Value ± 95 % CI', 'Unit', 'Source'],
            m.results.map(function (r) {
                var v = _valueStr(r);
                return [_esc(r.label), '<b>' + _esc(v.full) + '</b>', _esc(r.unit || '–'),
                        _esc(_sourceLabel(r.source)) + (r.note ? ' <span class="s-amber">(' + _esc(r.note) + ')</span>' : '')];
            })) + '</section>';
    }
    // Decline block
    if (m.decline) h += _declineHTML(m.decline, u, true);
    // Fit quality
    if (m.stats || m.tc) {
        h += '<section class="rp-sec"><h2>Fit quality</h2>' + _rpKV(_statsPairs(m));
        var bad = _unresolved(m);
        if (bad.length) h += '<div class="rp-note n-amber"><b>Not resolved by the data:</b>' + _esc(bad.join(', ')) + '</div>';
        h += '</section>';
    }
    // Interpretation
    if (m.interp && (m.interp.narrative || m.interp.actions.length)) {
        h += '<section class="rp-sec"><h2>Interpretation</h2>';
        if (m.interp.narrative) h += '<div class="rp-note n-blue">' + _esc(m.interp.narrative) + '</div>';
        if (m.interp.actions.length) h += '<ul>' + m.interp.actions.map(function (a) { return '<li>' + _esc(a) + '</li>'; }).join('') + '</ul>';
        m.interp.cautions.forEach(function (x) { h += '<div class="rp-note n-amber">' + _esc(x) + '</div>'; });
        h += '</section>';
    }
    if (m.notes) h += '<section class="rp-sec"><h2>Analyst comments</h2><p>' + _esc(m.notes).replace(/\n/g, '<br>') + '</p></section>';
    m.warnings.forEach(function (x) { h += '<div class="rp-note n-amber">' + _esc(x) + '</div>'; });
    // Plots
    if (opts.plots !== false) {
        var imgs = _plotImages(m.ctx);
        if (imgs.length) {
            h += '<section class="rp-sec"><h2>Plots</h2>' + imgs.map(function (im) {
                return '<div class="rp-fig"><img src="' + _esc(im.src) + '" alt="' + _esc(im.title) + '"><div class="rp-modsub">' + _esc(im.title) + '</div></div>';
            }).join('') + '</section>';
        }
    }
    // Model comparison
    if (m.comparison.length) {
        var ct = _comparisonTable(m, ' (reported)');
        h += '<section class="rp-sec"><h2>Model comparison</h2>' + _rpTable(ct.head, ct.rows) +
            '<p class="rp-modsub">ΔAIC below 2: the data cannot separate the models; above 10: strong preference.</p></section>';
    }
    if (m.pins.length) {
        var pt = _pinsTable(m);
        h += '<section class="rp-sec"><h2>Pinned results</h2>' + _rpTable(pt.head, pt.rows) + '</section>';
    }
    // Straight-line results
    if (m.semilog || m.keys.length) h += _straightLineHTML(m, true);
    // Skin
    if (m.skin || m.decomp) h += _skinHTML(m, true);
    // Flow regimes
    if (m.regimes && m.regimes.list.length) {
        h += '<section class="rp-sec"><h2>Flow regimes seen in the derivative</h2>' + _rpTable(['Regime', 'From (h)', 'To (h)'],
            m.regimes.list.map(function (g) { return [_esc(g.label), _fmt(g.t0, 3), _fmt(g.t1, 3)]; })) + '</section>';
    }
    // Data summary
    if (m.data) {
        h += '<section class="rp-sec"><h2>Data used</h2>' + _rpKV([
            ['Points analysed', String(m.data.n)], ['Δt range', _fmt(m.data.t0, 3) + '–' + _fmt(m.data.t1, 4) + ' h'],
            ['Reference pressure', _fixed(m.data.pRef, 1) + ' psia'], ['Reference source', m.data.pRefLabel],
            ['Test type', _testLabel(m.data.testType)], ['tp', _isNum(m.data.tp) ? _fmt(m.data.tp, 4) + ' h' : ''],
            ['Time function', m.data.timeFn], ['Derivative smoothing L', _isNum(m.data.L) ? String(m.data.L) : '']
        ]) + '</section>';
    }
    // Model parameters
    if (m.params.length) {
        h += '<section class="rp-sec"><h2>Model parameters (dimensionless)</h2>' + _rpTable(['Parameter', 'Value ± 95 % CI', 'Unit', 'Held fixed'],
            m.params.map(function (p) {
                var s = typeof p.value === 'number' ? _fmt(p.value, 4) : p.value;
                var pm = typeof p.value === 'number' ? _fmtPM(p.value, s, p.lo, p.hi) : '';
                return [_esc(p.label), _esc(s + (pm ? ' ± ' + pm : '')), _esc(p.unit || '–'), p.frozen ? 'yes' : ''];
            })) + '</section>';
    }
    // Appendix — inputs
    if (m.inputs.length) {
        h += '<section class="rp-sec rp-in"><h2>Appendix — inputs and where they came from</h2>' + _rpTable(['Input', 'Value', 'Unit', 'Source'],
            m.inputs.map(function (r) {
                var v = typeof r.value === 'number' ? _fmt(r.value, 4) : (r.value || '—');
                var src = r.missing ? '<span class="s-red">missing</span>' : r.isDefault ? '<span class="s-amber">default — not confirmed</span>' : _esc(_provLabel(r.provenance));
                return [_esc(r.label), _esc(v), _esc(r.unit || '–'), src];
            })) + '</section>';
    }
    if (m.model && (m.model.description || m.model.reference)) {
        h += '<section class="rp-sec"><h2>Model reference</h2><p>' + _esc(m.model.description) + '</p>' +
            (m.model.reference ? '<p class="rp-modsub">' + _esc(m.model.reference) + '</p>' : '') + '</section>';
    }
    return h;
}
var PROV_LABELS = { user: 'entered', sample: 'demo data', dataset: 'from the data file', deconvolution: 'from deconvolution', project: 'project file', computed: 'computed from correlations', correlation: 'computed from correlations' };
function _provLabel(p) { return PROV_LABELS[p] || (p ? _humanize(p) : ''); }

// Volumes: rounded, with thousands separators and the fluid's volume unit.
function _vol(v, u, bare) {
    if (!_isNum(v)) return '';
    var s = Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return bare ? s : s + ' ' + ((u && u.vol) || 'STB');
}
function _declineHTML(d, u, pdf) {
    var pairs = [
        ['Initial rate qi', _fmt(d.qi, 4) + ' ' + u.q], ['Initial decline Di', _fmt(d.Di, 3) + ' 1/d'],
        ['Annual nominal decline', _isNum(d.Di_yr) ? _fmt(d.Di_yr, 3) + ' 1/yr' : ''],
        ['Effective annual decline', _isNum(d.De) ? _fmt(100 * d.De, 3) + ' %' : ''], ['b-factor', _fmt(d.b, 3)],
        ['Abandonment rate', _isNum(d.q_ab) ? _fmt(d.q_ab, 3) + ' ' + u.q : ''],
        ['Time to abandonment', _isNum(d.t_ab) ? _fmt(d.t_ab / 365, 3) + ' yr' : ''],
        ['Produced to date', _vol(d.Np_hist, u)], [d.eurLabel, _vol(d.EUR, u)], ['Remaining', _vol(d.remaining, u)],
        ['Low / mid / high (P90 / P50 / P10)', _isNum(d.P50) ? _vol(d.P90, u, true) + ' / ' + _vol(d.P50, u, true) + ' / ' + _vol(d.P10, u) : '']
    ];
    if (pdf) {
        return '<section class="rp-sec rp-out"><h2>Decline results</h2>' + _rpKV(pairs) +
            d.warnings.map(function (x) { return '<div class="rp-note n-amber">' + _esc(x) + '</div>'; }).join('') + '</section>';
    }
    return _card('Decline results', _kvHTML(pairs) + d.warnings.map(_warnHTML).join(''));
}
function _straightLineHTML(m, pdf) {
    var s = m.semilog, pairs = [], rows = m.keys;
    if (s) {
        pairs = [
            ['Method', s.methodLabel || (s.method ? (String(s.method).toUpperCase() === 'MDH' ? 'MDH (drawdown semilog)' : _humanize(s.method)) : '')],
            ['Straight-line window', s.window && _isNum(s.window.t0) ? _fmt(s.window.t0, 3) + '–' + _fmt(s.window.t1, 4) + ' h' : ''],
            ['Slope m', _isNum(s.m) ? _fmt(Math.abs(s.m), 4) + ' psi/cycle' : ''], ['kh', _isNum(s.kh) ? _fmt(s.kh, 4) + ' md·ft' : ''],
            ['k', _isNum(s.k) ? _fmt(s.k, 3) + ' md' : ''], ['p at 1 h', _isNum(s.p1hr) ? _fixed(s.p1hr, 1) + ' psia' : ''],
            ['Extrapolated pressure p*', _isNum(s.pStar) ? _fixed(s.pStar, 1) + ' psia' : ''], ['Skin S', _fixed(s.S, 2)],
            ['Storage C (unit slope)', _isNum(s.C) ? _fmt(s.C, 3) + ' bbl/psi' : '']
        ];
        if (_isNum(s.dk_pct)) {
            pairs.push(['Difference from model fit', 'k ' + (s.dk_pct >= 0 ? '+' : '') + s.dk_pct.toFixed(1) + ' %' +
                (_isNum(s.dS) ? ', S ' + (s.dS >= 0 ? '+' : '') + s.dS.toFixed(2) : '')]);
        }
    }
    var keyRows = rows.map(function (r) { return [_esc(r.label), _esc(_fmt(r.value, 4)), _esc(r.unit || '')]; });
    if (pdf) {
        var h = '<section class="rp-sec"><h2>Straight-line results</h2>' + (pairs.length ? _rpKV(pairs) : '');
        if (s && _isNum(s.dk_pct)) h += '<div class="rp-note ' + (s.agree ? 'n-green' : 'n-amber') + '">' +
            (s.agree ? 'Straight-line and model results agree.' : 'Straight-line and model results differ — check the straight-line window and the model.') + '</div>';
        if (s) s.warnings.forEach(function (x) { h += '<div class="rp-note n-amber">' + _esc(x) + '</div>'; });
        if (keyRows.length) h += _rpTable(['Plot pick', 'Value', 'Unit'], keyRows);
        return h + '</section>';
    }
    var body = pairs.length ? _kvHTML(pairs) : '';
    if (s && _isNum(s.dk_pct)) body += s.agree ? _okHTML('Straight-line and model results agree.') : _warnHTML('Straight-line and model results differ — check the straight-line window and the model.');
    if (s) body += s.warnings.map(_warnHTML).join('');
    if (keyRows.length) body += _tableHTML(['Plot pick', 'Value', 'Unit'], keyRows);
    return _card('Straight-line results', body);
}
function _skinHTML(m, pdf) {
    var s = m.skin || {}, pairs = [];
    if (m.skin) {
        pairs = [
            ['Skin S', _fixed(s.S, 2)], ['Pressure drop due to skin ΔpS', _isNum(s.dpS) ? _fmt(s.dpS, 3) + ' psi' : ''],
            ['Flow efficiency FE', _fmt(s.FE, 3)], ['Damage ratio DR', _fmt(s.DR, 3)],
            ['Productivity index J', _isNum(s.J) ? _fmt(s.J, 3) + ' ' + m.units.J : ''],
            ['J without skin', _isNum(s.J_ideal) ? _fmt(s.J_ideal, 3) + ' ' + m.units.J : ''],
            ['Effective wellbore radius rw′', _isNum(s.rwa) ? _fmt(s.rwa, 3) + ' ft' : ''],
            ['Reference pressures', _isNum(s.pbar) && _isNum(s.pwf) ? s.pbarLabel + ' ' + _fixed(s.pbar, 1) + ', pwf ' + _fixed(s.pwf, 1) + ' psia' : '']
        ];
    }
    var d = m.decomp, dpairs = [];
    if (d) {
        var names = [['Partial-penetration skin', ['S_pp', 'Spp']], ['Slant skin', ['S_theta', 'S_θ', 'Stheta']],
                     ['Fracture skin', ['S_f', 'Sf']], ['Rate-dependent skin D·q', ['Dq', 'D_q', 'DQ']]];
        var anyPseudo = false;
        names.forEach(function (n) {
            var v = _pickNum(d, n[1]);
            if (_isNum(v) && Math.abs(v) > 1e-9) { anyPseudo = true; dpairs.push([n[0], _fmt(v, 3)]); }
        });
        var mech = _pickNum(d, ['S_mech', 'Smech', 'mechanical']);
        if (anyPseudo && _isNum(mech)) dpairs.unshift(['Mechanical (damage) skin', _fmt(mech, 3)]);
        if (!anyPseudo) dpairs = [];
    }
    if (pdf) {
        return '<section class="rp-sec"><h2>Skin</h2>' + (pairs.length ? _rpKV(pairs) : '') +
            (dpairs.length ? '<h3>Skin breakdown</h3>' + _rpKV(dpairs) : '') + '</section>';
    }
    return _card('Skin', (pairs.length ? _kvHTML(pairs) : '') + (dpairs.length ? '<div class="prism-rpt-sub">Skin breakdown</div>' + _kvHTML(dpairs) : ''));
}

// ───────────────────────────────────────────────────────────────────
// SECTION 10 — REPORT TAB (dark theme, 375 px safe)
// ───────────────────────────────────────────────────────────────────
var CSS_ID = 'prism-report-css';
function _injectStyles() {
    if (!_hasDoc || document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent =
        '.prism-rpt{display:flex;flex-direction:column;gap:12px;min-width:0;max-width:100%;}' +
        '.prism-rpt-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;min-width:0;}' +
        '.prism-rpt-h{font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px;}' +
        '.prism-rpt-sub{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin:10px 0 6px;}' +
        '.prism-rpt-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;}' +
        '.prism-rpt-tile{background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:6px 9px;min-width:0;}' +
        '.prism-rpt-tile span{display:block;font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;}' +
        '.prism-rpt-tile b{display:block;font-size:13px;color:var(--text);overflow-wrap:anywhere;}' +
        '.prism-rpt-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));column-gap:18px;}' +
        '.prism-rpt-kvr{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;min-width:0;}' +
        '.prism-rpt-kvr span{color:var(--text2);} .prism-rpt-kvr b{color:var(--text);text-align:right;overflow-wrap:anywhere;}' +
        '.prism-rpt-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;}' +
        '.prism-rpt-tbl{width:100%;border-collapse:collapse;font-size:12px;}' +
        '.prism-rpt-tbl th{text-align:left;font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;padding:5px 6px;border-bottom:1px solid var(--border);white-space:nowrap;}' +
        '.prism-rpt-tbl td{padding:5px 6px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top;}' +
        '.prism-rpt-tbl td.v{font-weight:700;white-space:nowrap;}' +
        '.prism-chip{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10.5px;border:1px solid var(--border);color:var(--text2);white-space:nowrap;}' +
        '.prism-chip--fit{border-color:var(--blue);color:var(--blue);} .prism-chip--line{border-color:var(--green);color:var(--green);}' +
        '.prism-chip--def{border-color:var(--yellow);color:var(--yellow);} .prism-chip--bad{border-color:var(--red);color:var(--red);}' +
        '.prism-rpt-note{font-size:12px;padding:7px 10px;border-radius:6px;border-left:3px solid var(--border);background:var(--bg1);color:var(--text2);margin-top:6px;}' +
        '.prism-rpt-note--warn{border-left-color:var(--yellow);} .prism-rpt-note--ok{border-left-color:var(--green);} .prism-rpt-note--info{border-left-color:var(--blue);}' +
        '.prism-rpt-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;}' +
        '.prism-rpt-plots{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:10px;}' +
        '.prism-rpt-plot{min-width:0;} .prism-rpt-plot canvas{display:block;width:100%;height:280px;border-radius:6px;}' +
        '.prism-rpt-plot div{font-size:11px;color:var(--text3);margin-top:4px;}' +
        '.prism-rpt-narr{font-size:13px;line-height:1.5;color:var(--text);padding:8px 10px;background:var(--bg1);border-left:3px solid var(--blue);border-radius:4px;}' +
        '.prism-rpt textarea{width:100%;max-width:100%;min-height:70px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font:inherit;font-size:12px;box-sizing:border-box;}' +
        '@media (max-width:600px){.prism-rpt-card{padding:10px;}.prism-rpt-tbl{font-size:11px;}.prism-rpt-actions .btn{flex:1 1 auto;}}';
    try { (document.head || document.body).appendChild(s); } catch (e) {}
}
function _card(title, body, id) {
    return '<div class="prism-rpt-card"' + (id ? ' id="' + id + '"' : '') + '><div class="prism-rpt-h">' + _esc(title) + '</div>' + body + '</div>';
}
function _kvHTML(pairs) {
    return '<div class="prism-rpt-kv">' + pairs.filter(function (p) { return p && p[1] !== '' && p[1] != null; }).map(function (p) {
        return '<div class="prism-rpt-kvr"><span>' + _esc(p[0]) + '</span><b>' + _esc(p[1]) + '</b></div>';
    }).join('') + '</div>';
}
function _tableHTML(head, rows) {
    return '<div class="prism-rpt-scroll" style="overflow-x:auto;max-width:100%;"><table class="prism-rpt-tbl"><thead><tr>' +
        head.map(function (x) { return '<th>' + _esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (cell, i) { return '<td' + (i === 1 ? ' class="v"' : '') + '>' + cell + '</td>'; }).join('') + '</tr>'; }).join('') +
        '</tbody></table></div>';
}
function _warnHTML(t) { return '<div class="prism-rpt-note prism-rpt-note--warn">' + _esc(t) + '</div>'; }
function _okHTML(t) { return '<div class="prism-rpt-note prism-rpt-note--ok">' + _esc(t) + '</div>'; }
function _infoHTML(t) { return '<div class="prism-rpt-note prism-rpt-note--info">' + _esc(t) + '</div>'; }
function _chip(source) {
    var cls = source === 'semilog' ? 'prism-chip--line' : (source === 'input' || source === 'derived') ? '' : 'prism-chip--fit';
    return '<span class="prism-chip ' + cls + '">' + _esc(_sourceLabel(source)) + '</span>';
}

var RESULT_HELP = {
    k: 'prism_help_k', kh: 'prism_help_kh', C: 'prism_help_C', Cd: 'prism_help_Cd', S: 'prism_help_S', pi: 'prism_help_pi',
    xf: 'prism_help_xf', Lh: 'prism_help_Lh', rinv: 'prism_help_rinv', dpS: 'prism_help_dpS', FE: 'prism_help_FE',
    DR: 'prism_help_DR', J: 'prism_help_J', J_ideal: 'prism_help_Jideal', rwa: 'prism_help_rwa'
};
function _tabHTML(m) {
    var hd = m.header, h = '<div class="prism-rpt" id="prism_report_root">';
    var tiles = [['Client', hd.client], ['Well', hd.well], ['Field', hd.field], ['Test', hd.testLabel],
                 ['Period', hd.periodLabel], ['Data', hd.nPoints ? hd.nPoints + ' points' : ''],
                 ['Model', m.model ? m.model.label : '']];
    var head = '<div class="prism-rpt-tiles">' + tiles.filter(function (t) { return t[1]; }).map(function (t) {
        return '<div class="prism-rpt-tile"><span>' + _esc(t[0]) + '</span><b>' + _esc(t[1]) + '</b></div>';
    }).join('') + '</div>';
    if (!hd.client && !hd.well) head += '<div class="prism-rpt-note">Client and well names come from the Client &amp; Well Info page.</div>';
    var btns = '<div class="prism-rpt-actions">' +
        '<button type="button" class="btn btn-primary" id="prism_report_pdf">Export PDF</button>' +
        '<button type="button" class="btn btn-secondary" id="prism_report_csv">Export CSV</button>' +
        (typeof G.PRiSM_exportReportPDF === 'function' ? '<button type="button" class="btn btn-secondary" id="prism_report_pdf_hires">PDF with all plots</button>' : '') +
        (typeof G.PRiSM_exportXMLDownload === 'function' ? '<button type="button" class="btn btn-secondary" id="prism_report_xml">Export XML</button>' : '') +
        '</div><div id="prism_report_msg" style="margin-top:6px;font-size:12px;color:var(--text2);min-height:16px;"></div>';
    h += _card('Report', head + btns);
    if (!m.hasData) {
        h += _card('Nothing to report yet', '<div class="prism-rpt-note">Load pressure or rate data on step ① (Data) to build a report.</div>' +
            '<div class="prism-rpt-actions"><button type="button" class="btn btn-secondary" id="prism_report_goto_data">Go to Data</button></div>');
        return h + '</div>';
    }
    if (m.stale) h += _warnHTML('This fit was made on different data or a different model. Re-run the fit before issuing the report.');
    if (!m.fit) {
        h += _card('No model fit yet', '<div class="prism-rpt-note">Run a fit on step ④ (Model &amp; fit) to add field-unit results with confidence intervals.</div>' +
            '<div class="prism-rpt-actions"><button type="button" class="btn btn-secondary" id="prism_report_goto_fit">Go to Model &amp; fit</button></div>');
    }
    // Key results
    if (m.results.length) {
        h += _card('Key results', _tableHTML(['Quantity', 'Value ± 95 % CI', 'Unit', 'Source'], m.results.map(function (r) {
            var v = _valueStr(r);
            var help = RESULT_HELP[r.key] || '';
            return [help ? '<span data-wts-help="' + help + '">' + _esc(r.label) + '</span>' : _esc(r.label), _esc(v.full), _esc(r.unit || '–'),
                    _chip(r.source) + (r.note ? ' <span class="prism-chip prism-chip--def">' + _esc(r.note) + '</span>' : '')];
        })), 'prism_report_results');
    }
    if (m.decline) h += _declineHTML(m.decline, m.units, false);
    // Interpretation
    if (m.interp && (m.interp.narrative || m.interp.actions.length)) {
        var ib = m.interp.narrative ? '<div class="prism-rpt-narr" id="prism_report_narrative">' + _esc(m.interp.narrative) + '</div>' : '';
        if (m.interp.actions.length) ib += '<ul style="margin:8px 0 0 18px;font-size:12px;color:var(--text2);">' + m.interp.actions.map(function (a) { return '<li>' + _esc(a) + '</li>'; }).join('') + '</ul>';
        ib += m.interp.cautions.map(_warnHTML).join('');
        h += _card('Interpretation', ib);
    }
    m.warnings.forEach(function (x) { h += _warnHTML(x); });
    // Fit quality
    if (m.stats || m.tc) {
        var fq = _kvHTML(_statsPairs(m));
        var bad = _unresolved(m);
        if (bad.length) fq += _warnHTML('Not resolved by the data: ' + bad.join(', '));
        h += _card('Fit quality', fq, 'prism_report_fit');
    }
    // Plots
    var specs = _plotSpecs(m.ctx).filter(function (s) { return !!_plotFn(s.key); });
    if (specs.length) {
        h += _card('Plots', '<div class="prism-rpt-plots" id="prism_report_plots">' + specs.map(function (s) {
            return '<div class="prism-rpt-plot"><canvas id="prism_report_plot_' + s.id + '" data-plot-key="' + _esc(s.key) + '" style="width:100%;height:280px;display:block;"></canvas><div>' + _esc(s.title) + '</div></div>';
        }).join('') + '</div>');
    }
    // Model comparison
    if (m.comparison.length) {
        var ct = _comparisonTable(m, ' <span class="prism-chip prism-chip--fit">reported</span>');
        h += _card('Model comparison', _tableHTML(ct.head, ct.rows) +
            '<div class="prism-rpt-note">ΔAIC below 2: the data cannot separate the models. Above 10: strong preference.</div>', 'prism_report_compare');
    } else if (m.fit) {
        h += _card('Model comparison', '<div class="prism-rpt-note">Run the model race on step ④ to compare models by AIC.</div>');
    }
    if (m.pins.length) {
        var pt = _pinsTable(m);
        h += _card('Pinned results', _tableHTML(pt.head, pt.rows), 'prism_report_pins');
    }
    if (m.semilog || m.keys.length) h += _straightLineHTML(m, false);
    if (m.skin || m.decomp) h += _skinHTML(m, false);
    if (m.regimes && m.regimes.list.length) {
        h += _card('Flow regimes', _tableHTML(['Regime', 'From (h)', 'To (h)'], m.regimes.list.map(function (g) {
            return [_esc(g.label), _fmt(g.t0, 3), _fmt(g.t1, 3)];
        })));
    }
    if (m.data) {
        var dw = m.data.pRefSource === 'first-sample' ? _warnHTML('The reference pressure is the first data point, so skin is biased. Enter the initial pressure on step ①.') : '';
        h += _card('Data used', _kvHTML([
            ['Points analysed', String(m.data.n)], ['Δt range', _fmt(m.data.t0, 3) + '–' + _fmt(m.data.t1, 4) + ' h'],
            ['Reference pressure', _fixed(m.data.pRef, 1) + ' psia'], ['Reference source', m.data.pRefLabel],
            ['Test type', _testLabel(m.data.testType)], ['tp', _isNum(m.data.tp) ? _fmt(m.data.tp, 4) + ' h' : ''],
            ['Time function', m.data.timeFn]
        ]) + dw);
    }
    if (m.params.length) {
        h += _card(m.fit ? 'Model parameters' : 'Model parameters (not fitted yet)', _tableHTML(['Parameter', 'Value ± 95 % CI', 'Unit', 'Fixed'], m.params.map(function (p) {
            var s = typeof p.value === 'number' ? _fmt(p.value, 4) : p.value;
            var pm = typeof p.value === 'number' ? _fmtPM(p.value, s, p.lo, p.hi) : '';
            return [_esc(p.label), _esc(s + (pm ? ' ± ' + pm : '')), _esc(p.unit || '–'),
                    (p.frozen ? 'yes' : '') + (p.identifiable === false ? ' <span class="prism-chip prism-chip--def">not resolved</span>' : '')];
        })));
    }
    if (m.inputs.length) {
        h += _card('Inputs and where they came from', _tableHTML(['Input', 'Value', 'Unit', 'Source'], m.inputs.map(function (r) {
            var v = typeof r.value === 'number' ? _fmt(r.value, 4) : (r.value || '—');
            var src = r.missing ? '<span class="prism-chip prism-chip--bad">missing</span>'
                : r.isDefault ? '<span class="prism-chip prism-chip--def">default — not confirmed</span>'
                : '<span class="prism-chip">' + _esc(_provLabel(r.provenance) || '—') + '</span>';
            return [_esc(r.label), _esc(v), _esc(r.unit || '–'), src];
        })) + '<div class="prism-rpt-actions"><button type="button" class="btn btn-secondary" id="prism_report_goto_inputs">Edit inputs</button></div>', 'prism_report_inputs');
    }
    h += _card('Analyst comments', '<textarea id="prism_report_notes" placeholder="Comments to print with the report">' + _esc(m.notes) + '</textarea>');
    return h + '</div>';
}

function _goto(step, tab) {
    try {
        if (typeof G.PRiSM_gotoStep === 'function') { G.PRiSM_gotoStep(step); return; }
        if (G.PRiSM && typeof G.PRiSM.setTab === 'function') G.PRiSM.setTab(tab);
    } catch (e) { _warn('[report] navigation failed', e); }
}
function _msg(host, html) { var el = host.querySelector('#prism_report_msg'); if (el) el.innerHTML = html; }

function _wireTab(host, m) {
    function on(id, fn) { var el = host.querySelector('#' + id); if (el) el.onclick = fn; }
    on('prism_report_pdf', function () {
        try {
            var r = exportReportPDF();
            _msg(host, r && r.method === 'none' ? '<span style="color:var(--yellow);">Report built, but no print window could be opened.</span>'
                : '<span style="color:var(--green);">Report sent to the print dialog — choose "Save as PDF".</span>');
        } catch (e) { _msg(host, '<span style="color:var(--red);">Export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_csv', function () {
        try { var r = exportCSV(); _msg(host, '<span style="color:var(--green);">CSV ready: ' + _esc(r.filename) + ' (' + r.rows.length + ' rows).</span>'); }
        catch (e) { _msg(host, '<span style="color:var(--red);">CSV export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_pdf_hires', function () {
        try { G.PRiSM_exportReportPDF(); } catch (e) { _msg(host, '<span style="color:var(--red);">Export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_xml', function () {
        try { G.PRiSM_exportXMLDownload(); _msg(host, '<span style="color:var(--green);">XML download started.</span>'); }
        catch (e) { _msg(host, '<span style="color:var(--red);">XML export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_goto_data', function () { _goto(1, 1); });
    on('prism_report_goto_inputs', function () { _goto(1, 1); });
    on('prism_report_goto_fit', function () { _goto(4, 6); });
    var notes = host.querySelector('#prism_report_notes');
    if (notes) notes.oninput = function () {
        try { var ls = _ls(); if (ls) ls.setItem('wts_prism_report_notes', String(notes.value || '')); } catch (e) {}
    };
}

function _plotWidth(el) {
    var cw = el && el.clientWidth ? el.clientWidth : 0;
    var vw = _isNum(G.innerWidth) && G.innerWidth > 0 ? G.innerWidth - 32 : 900;
    var w = Math.min(cw > 0 ? cw : Infinity, vw, 900);
    return Math.max(240, Math.floor(_isNum(w) ? w : 600));
}
function _drawTabPlots(host, m) {
    var c = m.ctx;
    _plotSpecs(c).forEach(function (spec) {
        var cv = host.querySelector('#prism_report_plot_' + spec.id);
        if (!cv) return;
        _drawPlot(cv, c, spec, { width: _plotWidth(cv.parentNode), height: 280, hover: true });
    });
}

function renderReportTab(hostEl) {
    if (!_hasDoc) return null;
    var host = (hostEl && hostEl.nodeType === 1) ? hostEl : document.getElementById('prism_tab_7');
    if (!host) return null;
    _injectStyles();
    _wireEvents();
    var m;
    try { m = reportData(); }
    catch (e) {
        host.innerHTML = '<div class="prism-rpt-card"><div class="prism-rpt-h">Report</div><div class="prism-rpt-note prism-rpt-note--warn">The report could not be built: ' + _esc(e && e.message) + '</div></div>';
        return null;
    }
    host.innerHTML = _tabHTML(m);
    _wireTab(host, m);
    try { _drawTabPlots(host, m); } catch (e) { _warn('[report] plots failed', e); }
    try { if (G.WTS_helpTooltips && typeof G.WTS_helpTooltips.refresh === 'function') G.WTS_helpTooltips.refresh(); } catch (e) {}
    return m;
}

// Re-render when the analysis changes while the report is on screen.
function _visible(el) {
    if (!el) return false;
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
        if (n.style && n.style.display === 'none') return false;
        if (n.hasAttribute && n.hasAttribute('hidden')) return false;
    }
    try {
        var root = document.documentElement;
        if (root && typeof root.contains === 'function') return root.contains(el);
    } catch (e) {}
    return true;
}
var _refreshTimer = null, _wired = false;
function _scheduleRefresh() {
    if (!_hasDoc) return;
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function () {
        _refreshTimer = null;
        var root = document.getElementById('prism_report_root');
        var host = root && root.parentNode;
        if (host && _visible(host)) renderReportTab(host);
    }, 30);
}
function _wireEvents() {
    if (_wired || typeof G.addEventListener !== 'function') return;
    _wired = true;
    ['prism:fit-updated', 'prism:well-changed', 'prism:dataset-loaded', 'prism:model-changed',
     'prism:automatch-updated', 'prism:report-pinned'].forEach(function (ev) {
        G.addEventListener(ev, _scheduleRefresh);
    });
    G.addEventListener('resize', _scheduleRefresh);
}

// ───────────────────────────────────────────────────────────────────
// SECTION 11 — PDF ROUTING (host report pipeline)
// ───────────────────────────────────────────────────────────────────
function _standaloneDoc(title, html, subtitle) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + _esc(title) + '</title>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
        'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2328;max-width:860px;margin:0 auto;padding:24px;font-size:13px;}' +
        '.rp-sec{border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;margin:0 0 12px;break-inside:avoid;}' +
        '.rp-sec h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#bc4c00;margin:0 0 8px;}' +
        '.rp-kv{display:grid;grid-template-columns:1fr 1fr;column-gap:24px;}.rp-kvr{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid #f0f2f4;}' +
        '.rp-tbl{width:100%;border-collapse:collapse;font-size:11.5px;}.rp-tbl th,.rp-tbl td{text-align:left;padding:5px 8px;border-bottom:1px solid #eef0f2;}' +
        '.rp-note{margin:6px 0;padding:7px 10px;border-left:4px solid #8c959f;background:#f6f8fa;}.n-amber{border-left-color:#9a6700;}.n-blue{border-left-color:#0969da;}.n-green{border-left-color:#1a7f37;}' +
        '.s-amber{color:#9a6700;}.s-red{color:#cf222e;}.rp-fig img{max-width:100%;height:auto;}' +
        '</style></head><body><h1>' + _esc(title) + '</h1>' + (subtitle ? '<p>' + _esc(subtitle) + '</p>' : '') + html + '</body></html>';
}
function hostExportReport(title, html, subtitle) {
    if (typeof exportReport === 'function') { exportReport(title, html, subtitle); return { method: 'host' }; }   // host scope
    if (typeof G.exportReport === 'function') { G.exportReport(title, html, subtitle); return { method: 'host' }; }
    if (typeof G.__reportOverride === 'function') { G.__reportOverride(title, html, subtitle); return { method: 'override' }; }
    var doc = (typeof G.buildReportHTML === 'function') ? G.buildReportHTML(title, html, subtitle) : _standaloneDoc(title, html, subtitle);
    var w = null;
    try { w = typeof G.open === 'function' ? G.open('', '_blank', 'width=960,height=800') : null; } catch (e) { w = null; }
    if (w && w.document) {
        w.document.open(); w.document.write(doc); w.document.close();
        try { if (typeof w.setTimeout === 'function') w.setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400); } catch (e) {}
        return { method: 'window', html: doc };
    }
    return { method: 'none', html: doc };
}
function exportReportPDF(opts) {
    opts = opts || {};
    var m = reportData();
    var html = buildReportHTML({ model: m, plots: opts.plots });
    var title = 'Well Test Analysis' + (m.model ? ' — ' + m.model.label : '');
    var sub = [m.header.well, m.header.testLabel, m.header.periodLabel].filter(Boolean).join(' · ');
    try { if (typeof G.gtag === 'function') G.gtag('event', 'prism_report_pdf', { event_category: 'PRiSM', model: m.model ? m.model.key : 'none' }); } catch (e) {}
    return hostExportReport(title, html, sub);
}

// ───────────────────────────────────────────────────────────────────
// SECTION 12 — PUBLISH
// ───────────────────────────────────────────────────────────────────
G.PRiSM_renderReportTab = renderReportTab;
G.PRiSM_buildReportHTML = buildReportHTML;
G.PRiSM_buildReportCSV = buildReportCSV;
G.PRiSM_exportCSV = exportCSV;
G.PRiSM_reportData = reportData;
G.PRiSM_reportResults = reportResults;
G.PRiSM_exportReport = exportReportPDF;
G.PRiSM_hostExportReport = hostExportReport;
G.PRiSM_report_internal = { fmt: _fmt, skinFromInputs: _skinFromInputs, bourdet: _bourdet, normFit: _normFit };

// ───────────────────────────────────────────────────────────────────

})();

// ─── END 36-report ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 37-prism-workflow ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM — 37-prism-workflow.js  (WP13, Round 8)
// -----------------------------------------------------------------------------
// Content layer for the five-step workflow shell (contract C9). The shell
// itself (#prism_header, #prism_steps, #prism_workspace, #prism_rail and the
// step bar) is rendered by 01-foundation.js; this file fills it:
//
//   window.PRiSM_renderRail(railEl)     results rail (desktop column or
//                                       bottom sheet when railEl has the
//                                       class 'prism-rail--sheet')
//   window.PRiSM_railInfo()             the numbers the rail shows (tests,
//                                       report, quick summary)
//   window.PRiSM_analyse(opts)          one-click pipeline → Promise<result>
//   window.PRiSM_stepViews[2](hostEl)   step ② "Flow periods" view
//   window.PRiSM_renderFlowPeriods      (same function)
//   window.PRiSM_openTools(toolId?)     Tools drawer (every advanced panel)
//   window.PRiSM_closeTools()
//   window.PRiSM_listTools()            [{id,title,group,fn,available}]
//   window.PRiSM_undo() / PRiSM_redo()  state snapshots (cap 50)
//   window.PRiSM_canUndo() / PRiSM_canRedo() / PRiSM_recordSnapshot(reason)
//   window.PRiSM_getReportPins()        results pinned from the rail
//
// Cross-module calls are all typeof-guarded (CLAUDE.md convention 6). When a
// shared engine is missing the pipeline degrades: Δp comes from a local
// sign-aware builder, the fit from a local physical-unit Levenberg-Marquardt
// fit of the active (or homogeneous) model, and the interpretation headline
// from a short local rule set.
//
// Units: t in hours, p in psia, q in STB/d (oil) or Mscf/d (gas).
// Field-unit constants: 141.2, 70.6, 0.0002637, 0.8936, 948.
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var D = G.document || null;

    // =========================================================================
    // SECTION 1 — SMALL HELPERS
    // =========================================================================

    var LN10 = Math.log(10);

    function $(id) { return D && D.getElementById ? D.getElementById(id) : null; }
    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function isArr(a) {
        return !!a && (Array.isArray(a) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(a)));
    }
    function toArr(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(a[i]); return o; }
    function esc(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function clone(v) {
        if (v == null) return v;
        try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
    }
    function pick(obj, keys) {
        if (!obj) return undefined;
        for (var i = 0; i < keys.length; i++) {
            var v = obj[keys[i]];
            if (v != null && v !== '') return v;
        }
        return undefined;
    }
    function pickNum(obj, keys) {
        if (!obj) return undefined;
        for (var i = 0; i < keys.length; i++) if (isNum(obj[keys[i]])) return obj[keys[i]];
        return undefined;
    }
    function now() {
        try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (e) {}
        return Date.now();
    }
    function thousands(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

    // Engineering display: 3 significant figures, thousands separators for
    // ≥ 1000, exponent for very large / very small values.
    function fmt(v, sig) {
        if (!isNum(v)) return '—';
        sig = sig || 3;
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e7 || a < 1e-3) {
            return v.toExponential(sig - 1).replace(/\.?0+e/, 'e').replace('e+', 'e');
        }
        if (a >= 1000) return (v < 0 ? '-' : '') + thousands(String(Math.round(a)));
        if (v === Math.round(v)) return String(v);
        return v.toPrecision(sig);
    }
    function fmtFixed(v, d) { return isNum(v) ? v.toFixed(d) : '—'; }
    function fmtSigned(v, d) { return isNum(v) ? ((v > 0 ? '+' : '') + v.toFixed(d)) : '—'; }

    function st() {
        if (!G.PRiSM_state) {
            G.PRiSM_state = { model: 'homogeneous', params: {}, paramFreeze: {}, match: { timeShift: 0, pressShift: 0 } };
        }
        return G.PRiSM_state;
    }

    function dispatch(type, detail) {
        if (typeof G.dispatchEvent !== 'function') return;
        try {
            var ev;
            if (typeof G.CustomEvent === 'function') ev = new G.CustomEvent(type, { detail: detail || {} });
            else if (D && D.createEvent) { ev = D.createEvent('CustomEvent'); ev.initCustomEvent(type, false, false, detail || {}); }
            if (ev) G.dispatchEvent(ev);
        } catch (e) { /* a listener threw — never break the caller */ }
    }

    function modelName(key) {
        if (!key) return '—';
        var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
        var n = e && (e.name || e.label || e.title);
        if (n) return String(n);
        var s = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function cssVar(name, fallback) {
        try {
            if (D && D.documentElement && typeof G.getComputedStyle === 'function') {
                var v = G.getComputedStyle(D.documentElement).getPropertyValue(name);
                if (v && String(v).trim()) return String(v).trim();
            }
        } catch (e) {}
        return fallback;
    }

    function yieldTick() {
        return new Promise(function (resolve) {
            if (typeof G.setTimeout === 'function') G.setTimeout(resolve, 0); else resolve();
        });
    }

    function saveState() {
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) {} }
    }

    function redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) {} }
    }

    // =========================================================================
    // SECTION 2 — STYLES (scoped 'prism-' classes, host dark-theme variables)
    // =========================================================================

    var STYLE_ID = 'prism_wf_style';
    var CSS = [
        '.prism-wf, .prism-wf *, .prism-rail-body, .prism-rail-body *, .prism-drawer, .prism-drawer *, .prism-progress, .prism-progress * { box-sizing: border-box; }',
        '.prism-rail-body { display:flex; flex-direction:column; gap:10px; font-size:12.5px; color:var(--text); min-width:0; }',
        '.prism-rail-sec { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; min-width:0; }',
        '.prism-rail-h { display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:11px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:var(--text2); margin-bottom:6px; }',
        '.prism-rail-kv { display:grid; grid-template-columns:minmax(0,auto) minmax(0,1fr); gap:3px 10px; align-items:baseline; }',
        '.prism-rail-k { color:var(--text2); white-space:nowrap; }',
        '.prism-rail-v { color:var(--text); font-weight:600; text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }',
        '.prism-rail-v small { color:var(--text3); font-weight:400; }',
        '.prism-rail-line { color:var(--text2); line-height:1.45; overflow-wrap:anywhere; }',
        '.prism-rail-line b { color:var(--text); }',
        '.prism-rail-headline { color:var(--text); line-height:1.45; font-style:italic; }',
        '.prism-chip { display:inline-block; font-size:10px; font-weight:600; letter-spacing:.2px; text-transform:none; padding:1px 7px; border-radius:10px; border:1px solid var(--border); color:var(--text2); white-space:nowrap; }',
        '.prism-chip--regression { color:var(--green); border-color:var(--green); }',
        '.prism-chip--automatch { color:var(--blue); border-color:var(--blue); }',
        '.prism-chip--match { color:var(--accent); border-color:var(--accent); }',
        '.prism-chip--semilog { color:var(--yellow); border-color:var(--yellow); }',
        '.prism-chip--ok { color:var(--green); border-color:var(--green); }',
        '.prism-chip--warn { color:var(--yellow); border-color:var(--yellow); }',
        '.prism-chip--bad { color:var(--red); border-color:var(--red); }',
        '.prism-rail-warn { border-left:3px solid var(--yellow); background:var(--bg3, var(--bg2)); padding:7px 9px; border-radius:4px; color:var(--text); line-height:1.4; display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; }',
        '.prism-rail-warn--bad { border-left-color:var(--red); }',
        '.prism-rail-warn--info { border-left-color:var(--blue); }',
        '.prism-rail-warn span { flex:1 1 160px; min-width:0; }',
        '.prism-rail-actions { display:flex; flex-wrap:wrap; gap:8px; }',
        '.prism-btn { appearance:none; background:var(--bg3, var(--bg2)); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:7px 11px; font:inherit; font-size:12px; line-height:1.2; cursor:pointer; min-height:34px; touch-action:manipulation; }',
        '.prism-btn:hover { border-color:var(--accent); }',
        '.prism-btn:disabled { opacity:.5; cursor:default; }',
        '.prism-btn--primary { background:var(--accent); border-color:var(--accent); color:#111; font-weight:700; }',
        '.prism-btn--small { min-height:28px; padding:4px 9px; font-size:11px; }',
        '.prism-btn--link { background:none; border:none; color:var(--blue); padding:0; min-height:0; text-decoration:underline; }',
        '.prism-rail-sheetbar { width:100%; display:flex; align-items:center; gap:8px; min-height:44px; padding:8px 12px; background:var(--bg2); border:1px solid var(--border); border-radius:10px 10px 0 0; color:var(--text); font:inherit; font-size:13px; font-weight:600; text-align:left; cursor:pointer; touch-action:manipulation; }',
        '.prism-rail-sheetbar .prism-rail-sum { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.prism-rail-sheetbar .prism-rail-grip { width:36px; height:4px; border-radius:2px; background:var(--border); flex:0 0 auto; }',
        '.prism-rail--sheet .prism-rail-body { padding:10px 2px 4px; max-height:70vh; overflow-y:auto; -webkit-overflow-scrolling:touch; }',
        '.prism-wf { display:flex; flex-direction:column; gap:12px; min-width:0; }',
        '.prism-wf-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap:12px; }',
        '.prism-wf-card { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:12px; min-width:0; }',
        '.prism-wf-title { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:var(--text2); margin-bottom:8px; }',
        '.prism-wf-hint { font-size:11.5px; color:var(--text3); margin-top:6px; line-height:1.4; }',
        '.prism-wf canvas { display:block; width:100%; max-width:100%; touch-action:manipulation; background:var(--bg1); border-radius:6px; }',
        '.prism-fp-tablewrap { overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }',
        '.prism-fp-table { width:100%; border-collapse:collapse; font-size:12px; }',
        '.prism-fp-table th, .prism-fp-table td { padding:6px 6px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }',
        '.prism-fp-table th { color:var(--text2); font-weight:600; font-size:11px; }',
        '.prism-fp-table tbody tr { cursor:pointer; }',
        '.prism-fp-table tbody tr.is-active { background:rgba(240,136,62,.14); }',
        '.prism-fp-table td.num { text-align:right; font-variant-numeric:tabular-nums; }',
        '.prism-fp-inputs { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; }',
        '.prism-fp-inputs label { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:var(--text2); }',
        '.prism-fp-inputs input { width:100%; min-width:0; background:var(--bg1); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:7px 8px; font:inherit; font-size:13px; }',
        '.prism-drawer-backdrop { position:fixed; top:0; right:0; bottom:0; left:0; background:rgba(0,0,0,.55); z-index:900; }',
        '.prism-drawer { position:fixed; top:0; right:0; bottom:0; width:min(600px, 100vw); max-width:100vw; background:var(--bg1); border-left:1px solid var(--border); z-index:901; display:flex; flex-direction:column; color:var(--text); }',
        '.prism-drawer-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border); }',
        '.prism-drawer-head h3 { margin:0; font-size:14px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.prism-drawer-body { flex:1; overflow:auto; padding:12px; -webkit-overflow-scrolling:touch; min-width:0; }',
        '.prism-drawer-search { width:100%; background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px 10px; font:inherit; font-size:13px; margin-bottom:10px; }',
        '.prism-tool-group { font-size:11px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:var(--text3); margin:12px 0 6px; }',
        '.prism-tool-item { display:block; width:100%; text-align:left; background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:10px 12px; margin-bottom:6px; font:inherit; font-size:13px; cursor:pointer; min-height:44px; }',
        '.prism-tool-item:hover { border-color:var(--accent); }',
        '.prism-tool-item small { display:block; color:var(--text3); font-size:11px; margin-top:2px; }',
        '@media (max-width: 767px) { .prism-drawer { top:auto; left:0; width:100vw; height:88vh; border-left:0; border-top:1px solid var(--border); border-radius:12px 12px 0 0; } }',
        '.prism-progress { position:fixed; right:16px; bottom:16px; width:min(320px, calc(100vw - 32px)); background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; z-index:950; color:var(--text); font-size:12.5px; box-shadow:0 6px 24px rgba(0,0,0,.45); }',
        '.prism-progress.is-done { animation: prism-progress-out .3s ease 4s forwards; }',
        '@keyframes prism-progress-out { to { opacity:0; visibility:hidden; } }',
        '.prism-progress-head { display:flex; align-items:center; gap:8px; font-weight:700; margin-bottom:6px; }',
        '.prism-progress-head span { flex:1; }',
        '.prism-progress-row { display:flex; gap:8px; align-items:baseline; padding:2px 0; color:var(--text2); }',
        '.prism-progress-row b { width:16px; flex:0 0 16px; text-align:center; font-weight:700; }',
        '.prism-progress-row.is-run { color:var(--text); }',
        '.prism-progress-row.is-ok b { color:var(--green); }',
        '.prism-progress-row.is-warn b { color:var(--yellow); }',
        '.prism-progress-row.is-fail b { color:var(--red); }',
        '.prism-progress-row em { font-style:normal; color:var(--text3); margin-left:auto; text-align:right; overflow-wrap:anywhere; }',
        '.prism-progress-note { margin-top:6px; padding:6px 8px; border:1px dashed var(--border); border-radius:6px; color:var(--text2); overflow-wrap:anywhere; }',
        '.prism-toast { margin-top:6px; font-size:11.5px; color:var(--green); }'
    ].join('\n');

    function ensureStyle() {
        if (!D || !D.createElement) return;
        if ($(STYLE_ID)) return;
        try {
            var s = D.createElement('style');
            s.id = STYLE_ID;
            s.textContent = CSS;
            var parent = D.head || D.body || D.documentElement;
            if (parent) parent.appendChild(s);
        } catch (e) {}
    }

    // =========================================================================
    // SECTION 3 — CONTRACT ADAPTERS (C1 well, C2 analysis data, C4 lastFit)
    // =========================================================================

    var WELL_KEYS = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];

    function isDefaultSample(ds) {
        if (!ds || !isArr(ds.t) || !isArr(ds.p)) return false;
        if (ds.source === 'sample' || ds._sample === true || ds.isSample === true) return true;
        return ds.t.length === 55 && Math.abs(ds.p[0] - 3861.4) < 1e-6 && Math.abs(ds.t[54] - 120) < 1e-6;
    }

    // Maps a getWell() key to the PRiSM_pvt field that stores it.
    function pvtKey(k, fluid) {
        fluid = fluid || 'oil';
        if (k === 'pi') return 'p_res';
        if (k === 'B') return fluid === 'gas' ? 'Bg' : (fluid === 'water' ? 'Bw' : 'Bo');
        if (k === 'mu') return fluid === 'gas' ? 'mu_g' : (fluid === 'water' ? 'mu_w' : 'mu_o');
        if (k === 'T_R') return 'T_res';
        if (k === 'sg') return 'SG_g';
        return k;
    }

    function datasetRate(ds) {
        if (!ds || !isArr(ds.q)) return null;
        for (var i = ds.q.length - 1; i >= 0; i--) {
            if (isNum(ds.q[i]) && ds.q[i] !== 0) return Math.abs(ds.q[i]);
        }
        return null;
    }

    // Local C1 fallback: reads PRiSM_pvt (+ the default-sample metadata when
    // the loaded data is the bundled demo).
    function localWell(ds) {
        var pvt = G.PRiSM_pvt || {};
        var prov = pvt.provenance || {};
        var fluid = pvt.fluidType || 'oil';
        var comp = pvt._computed || {};
        if (comp.B == null && comp.Bo == null && typeof G.PRiSM_pvt_compute === 'function' && G.PRiSM_pvt) {
            try { comp = G.PRiSM_pvt_compute() || pvt._computed || {}; } catch (e) { comp = {}; }
        }
        var w = {
            fluid: fluid,
            q: pvt.q, B: undefined, mu: undefined, ct: pvt.ct, h: pvt.h, phi: pvt.phi, rw: pvt.rw,
            pi: null, T_R: pvt.T_res, sg: pvt.SG_g,
            testType: pvt.testType || 'auto', tp: pvt.tp, tShut: pvt.tShut, pwf0: pvt.pwf0,
            provenance: {}, complete: false, missing: [], defaulted: [], _local: true
        };
        var Bk = pvtKey('B', fluid), Mk = pvtKey('mu', fluid);
        w.B = isNum(pvt[Bk]) ? pvt[Bk] : pickNum(comp, fluid === 'gas' ? ['Bg', 'B'] : ['Bo', 'B']);
        w.mu = isNum(pvt[Mk]) ? pvt[Mk] : pickNum(comp, fluid === 'gas' ? ['mu_g', 'mu'] : ['mu_o', 'mu']);
        if (!isNum(w.ct)) w.ct = pickNum(comp, ['ct']);
        var provOf = function (k) { return prov[pvtKey(k, fluid)] || prov[k] || 'default'; };
        ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw', 'pi'].forEach(function (k) { w.provenance[k] = provOf(k); });
        var pp = provOf('pi');
        if (isNum(pvt.p_res) && (pp === 'user' || pp === 'sample' || pp === 'deconvolution')) w.pi = pvt.p_res;
        var meta = G.PRiSM_DEFAULT_SAMPLE_META;
        if (meta && isDefaultSample(ds)) {
            var mv = {
                q: meta.q, B: pick(meta, ['Bo', 'B']), mu: pick(meta, ['mu_o', 'mu']), ct: meta.ct,
                h: meta.h, phi: meta.phi, rw: meta.rw, pi: meta.pi
            };
            Object.keys(mv).forEach(function (k) {
                if (isNum(mv[k]) && w.provenance[k] !== 'user') { w[k] = mv[k]; w.provenance[k] = 'sample'; }
            });
            if (meta.testType && w.testType === 'auto') w.testType = meta.testType;
        }
        var qd = datasetRate(ds);
        if (qd != null && w.provenance.q !== 'user') { w.q = qd; w.provenance.q = 'dataset'; }
        WELL_KEYS.forEach(function (k) {
            if (!(isNum(w[k]) && w[k] > 0)) w.missing.push(k);
            else if (w.provenance[k] === 'default') w.defaulted.push(k);
        });
        w.complete = w.missing.length === 0;
        return w;
    }

    function getWell(ds) {
        ds = ds || G.PRiSM_dataset;
        if (typeof G.PRiSM_getWell === 'function') {
            try { var w = G.PRiSM_getWell(ds); if (w) return w; } catch (e) { /* fall through */ }
        }
        return localWell(ds);
    }

    // Writes well inputs: C1 setter when present, else PRiSM_pvt directly.
    function setWell(patch, source) {
        if (typeof G.PRiSM_setWell === 'function') {
            try { G.PRiSM_setWell(patch, { source: source || 'user' }); return true; } catch (e) { /* fall through */ }
        }
        var pvt = G.PRiSM_pvt;
        if (!pvt) pvt = G.PRiSM_pvt = {};
        pvt.provenance = pvt.provenance || {};
        Object.keys(patch).forEach(function (k) {
            pvt[k] = patch[k];
            pvt.provenance[k] = source || 'user';
        });
        if (typeof G.PRiSM_pvt_compute === 'function') { try { G.PRiSM_pvt_compute(); } catch (e) {} }
        persistPvt();
        dispatch('prism:well-changed', { source: source || 'user', keys: Object.keys(patch) });
        return true;
    }

    function persistPvt() {
        try {
            var s = G.PRiSM_pvt;
            if (!s || !G.localStorage) return;
            var o = {};
            for (var k in s) if (k !== '_computed' && Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
            G.localStorage.setItem('wts_prism_pvt', JSON.stringify(o));
        } catch (e) {}
    }

    // ── Flow periods ─────────────────────────────────────────────────────────
    function periodType(q, prevQ) {
        if (q == null || !isNum(q)) return 'Pressure only';
        if (q === 0) return (isNum(prevQ) && prevQ < 0) ? 'Falloff' : (isNum(prevQ) && prevQ > 0 ? 'Buildup' : 'Shut-in');
        if (q < 0) return 'Injection';
        return (isNum(prevQ) && prevQ > 0) ? 'Flow (rate change)' : 'Drawdown';
    }

    function normPeriod(p, i, arr) {
        var t0 = isNum(p.t0) ? p.t0 : p.start;
        var t1 = isNum(p.t1) ? p.t1 : p.end;
        var prevQ = i > 0 ? arr[i - 1].q : undefined;
        return {
            index: i, t0: t0, t1: t1, start: t0, end: t1, q: p.q,
            // Display label from the rates; the core's machine type ('flow', 'shutin') is kept as kind.
            type: periodType(p.q, prevQ), kind: p.type ? String(p.type) : null, n: p.n
        };
    }

    function localPeriods(ds) {
        if (!ds || !isArr(ds.t) || !ds.t.length) return [];
        var t = ds.t, n = t.length, q = isArr(ds.q) ? ds.q : null;
        if (!q) return [{ index: 0, t0: Math.min(0, t[0]), t1: t[n - 1], start: Math.min(0, t[0]), end: t[n - 1], q: null, type: 'Pressure only', n: n }];
        var segs = [], cur = null;
        for (var i = 0; i < n; i++) {
            var qi = isNum(q[i]) ? q[i] : 0;
            var same = cur && ((cur.q === 0 && qi === 0) ||
                (cur.q !== 0 && Math.abs(qi - cur.q) <= 0.01 * Math.abs(cur.q)));
            if (!cur || !same) {
                if (cur) segs.push(cur);
                cur = { i0: i, i1: i, q: qi };
            } else cur.i1 = i;
        }
        if (cur) segs.push(cur);
        if (segs.length > 20) {   // continuously varying rate: one period (RTA/deconvolution territory)
            return [{ index: 0, t0: Math.min(0, t[0]), t1: t[n - 1], start: Math.min(0, t[0]), end: t[n - 1], q: datasetRate(ds), type: 'Variable rate', n: n, variable: true }];
        }
        return segs.map(function (s, k) {
            var t0 = k === 0 ? Math.min(0, t[s.i0]) : t[segs[k - 1].i1];
            var prevQ = k > 0 ? segs[k - 1].q : undefined;
            return { index: k, t0: t0, t1: t[s.i1], start: t0, end: t[s.i1], q: s.q, type: periodType(s.q, prevQ), n: s.i1 - s.i0 + 1 };
        });
    }

    function getPeriods(ds) {
        ds = ds || G.PRiSM_dataset;
        if (!ds) return [];
        // The PTA core's period list is the one whose indices drive
        // PRiSM_getAnalysisData({period}) / st.activePeriod — prefer it (WP0 fix).
        if (typeof G.PRiSM_rateHistory === 'function') {
            try {
                var rh = G.PRiSM_rateHistory(ds);
                if (rh && rh.ok && !rh.variable && rh.periods && rh.periods.length) return toArr(rh.periods).map(normPeriod);
            } catch (e0) {}
        }
        if (typeof G.PRiSM_detectPeriods === 'function' && isArr(ds.t) && isArr(ds.q)) {
            try {
                var p = G.PRiSM_detectPeriods(ds.t, ds.q);
                if (p && p.length) return toArr(p).map(normPeriod);
            } catch (e) {}
        }
        return localPeriods(ds);
    }

    function activePeriod() {
        var ap = st().activePeriod;
        return (ap === 0 || (isNum(ap) && ap >= 0)) ? ap : null;
    }

    function periodOpts() {
        var ap = activePeriod();
        return ap == null ? {} : { period: ap };
    }

    // ── Bourdet derivative (local fallback; the shared one is preferred) ──
    function bourdet(t, dp, L) {
        var sharedFn = (typeof G.PRiSM_compute_bourdet === 'function') ? G.PRiSM_compute_bourdet : null;
        if (sharedFn) {
            try { var r = sharedFn(t, dp, L); if (r && r.length === t.length) return toArr(r); } catch (e) {}
        }
        var n = t.length, x = t.map(function (v) { return Math.log(v); }), d = new Array(n);
        for (var i = 0; i < n; i++) {
            var j = i - 1, k = i + 1;
            while (j > 0 && x[i] - x[j] < L) j--;
            while (k < n - 1 && x[k] - x[i] < L) k++;
            if (j >= 0 && k < n && x[i] > x[j] && x[k] > x[i]) {
                var dl = x[i] - x[j], dr = x[k] - x[i];
                d[i] = ((dp[i] - dp[j]) / dl * dr + (dp[k] - dp[i]) / dr * dl) / (dl + dr);
            } else if (k < n && x[k] > x[i]) d[i] = (dp[k] - dp[i]) / (x[k] - x[i]);
            else if (j >= 0 && x[i] > x[j]) d[i] = (dp[i] - dp[j]) / (x[i] - x[j]);
            else d[i] = NaN;
        }
        return d;
    }

    // Local C2 fallback: sign-aware Δp from pi / pwf0 / t0 row / first sample.
    function localAnalysisData(ds, opts) {
        opts = opts || {};
        if (!ds || !isArr(ds.t) || !isArr(ds.p) || ds.t.length < 3) {
            return { ok: false, reason: 'No pressure data loaded — load data on step ① first.' };
        }
        var well = getWell(ds);
        var periods = localPeriods(ds);
        var pidx = (opts.period != null && periods[opts.period]) ? opts.period : null;
        var per = pidx != null ? periods[pidx] : null;
        var prev = (pidx != null && pidx > 0) ? periods[pidx - 1] : null;
        var tStart = per ? per.t0 : 0, tEnd = per ? per.t1 : Infinity;
        if (!per && periods.length > 1) {
            // Whole record with several periods: analyse from the first sample.
            tStart = Math.min(0, ds.t[0]);
        }
        var rows = [];
        for (var i = 0; i < ds.t.length; i++) {
            if (ds.t[i] > tStart && ds.t[i] <= tEnd && isNum(ds.p[i])) rows.push(i);
        }
        if (rows.length < 3) return { ok: false, reason: 'Fewer than 3 samples in the selected period.' };
        var warnings = [];
        var testType = (well.testType && well.testType !== 'auto') ? well.testType : null;
        if (!testType) {
            if (per && per.q === 0 && prev && prev.q > 0) testType = 'buildup';
            else if (per && per.q === 0 && prev && prev.q < 0) testType = 'falloff';
            else if (per && isNum(per.q) && per.q < 0) testType = 'injection';
            else testType = (ds.p[rows[rows.length - 1]] - ds.p[rows[0]]) >= 0 ? 'buildup' : 'drawdown';
        }
        var sign = (testType === 'buildup' || testType === 'injection') ? 1 : -1;
        var pRef = null, pRefSource = null, t0row = -1;
        for (var r0 = 0; r0 < ds.t.length; r0++) if (ds.t[r0] <= tStart && isNum(ds.p[r0])) t0row = r0;
        if (testType === 'drawdown' || testType === 'injection') {
            if (isNum(well.pi)) { pRef = well.pi; pRefSource = 'pi'; }
        } else if (isNum(well.pwf0)) { pRef = well.pwf0; pRefSource = 'pwf0'; }
        if (pRef == null && t0row >= 0) { pRef = ds.p[t0row]; pRefSource = 't0-row'; }
        if (pRef == null) {
            pRef = ds.p[rows[0]]; pRefSource = 'first-sample';
            warnings.push('Δp is measured from the first sample, so skin is biased — enter the initial pressure pi on step ①.');
        }
        var t = [], tAbs = [], p = [], dp = [];
        rows.forEach(function (ri) {
            var dt = ds.t[ri] - tStart, d = sign * (ds.p[ri] - pRef);
            if (dt > 0 && d > 0) { t.push(dt); tAbs.push(ds.t[ri]); p.push(ds.p[ri]); dp.push(d); }
        });
        if (t.length < 3) return { ok: false, reason: 'No positive Δp — check the test type and pi on step ①.' };
        var qRef = per && isNum(per.q) && per.q !== 0 ? Math.abs(per.q) : (prev && isNum(prev.q) ? Math.abs(prev.q) : (isNum(well.q) ? well.q : null));
        var tp = null;
        if (testType === 'buildup' || testType === 'falloff') {
            var Np = 0;
            for (var k = 0; k < (pidx || 0); k++) if (isNum(periods[k].q)) Np += periods[k].q * (periods[k].t1 - periods[k].t0);
            tp = (prev && prev.q) ? Np / prev.q : null;
            if (isNum(well.tp)) tp = well.tp;
            warnings.push('Δt time function without superposition (shared analysis-data builder not loaded).');
        }
        return {
            ok: true, reason: '', n: t.length, t: t, tAbs: tAbs, p: p, dp: dp, x: t.slice(),
            deriv: bourdet(t, dp, 0.1), L: 0.1, timeFn: 'dt', sign: sign,
            pRef: pRef, pRefSource: pRefSource, testType: testType, tStart: tStart,
            tShut: (testType === 'buildup' || testType === 'falloff') ? tStart : null, tp: tp,
            qRef: qRef, rateHistory: periods.map(function (pp) { return { t: pp.t0, q: pp.q }; }),
            periods: periods, fluid: well.fluid, warnings: warnings, _local: true
        };
    }

    function getAnalysisData(opts) {
        opts = opts || periodOpts();
        if (typeof G.PRiSM_getAnalysisData === 'function') {
            try {
                var a = G.PRiSM_getAnalysisData(G.PRiSM_dataset, opts);
                if (a) return a;
            } catch (e) { return { ok: false, reason: 'Analysis data: ' + (e && e.message) }; }
        }
        return localAnalysisData(G.PRiSM_dataset, opts);
    }

    function normaliseFit(lf) {
        if (!lf) return null;
        var o = {};
        for (var k in lf) if (Object.prototype.hasOwnProperty.call(lf, k)) o[k] = lf[k];
        if (o.r2 == null && o.R2 != null) o.r2 = o.R2;
        if (o.rmse == null && o.RMSE != null) o.rmse = o.RMSE;
        if (o.aic == null && o.AIC != null) o.aic = o.AIC;
        if (o.ci95 == null && o.CI95 != null) o.ci95 = o.CI95;
        if (o.modelKey == null && o.model != null) o.modelKey = o.model;
        return o;
    }

    function getLastFit() {
        if (typeof G.PRiSM_getLastFit === 'function') {
            try { var f = G.PRiSM_getLastFit(); return f ? normaliseFit(f) : null; } catch (e) {}
        }
        var s = st(), lf = normaliseFit(s.lastFit);
        if (lf && lf.stale == null) lf.stale = !!(lf.modelKey && s.model && lf.modelKey !== s.model);
        return lf;
    }

    // =========================================================================
    // SECTION 4 — LOCAL PHYSICAL-UNIT FIT (fallback when the shared regression
    // engine is not loaded). Levenberg-Marquardt on ln Δp.
    // =========================================================================

    function solveLinear(A, b) {
        var n = b.length, M = A.map(function (row, i) { return row.slice().concat([b[i]]); });
        for (var c = 0; c < n; c++) {
            var piv = c;
            for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            if (Math.abs(M[piv][c]) < 1e-300) return null;
            var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
            for (var r2 = c + 1; r2 < n; r2++) {
                var f = M[r2][c] / M[c][c];
                for (var cc = c; cc <= n; cc++) M[r2][cc] -= f * M[c][cc];
            }
        }
        var x = new Array(n);
        for (var i = n - 1; i >= 0; i--) {
            var s = M[i][n];
            for (var j = i + 1; j < n; j++) s -= M[i][j] * x[j];
            x[i] = s / M[i][i];
        }
        return x;
    }

    function invert(A) {
        var n = A.length, out = [];
        for (var i = 0; i < n; i++) out.push(new Array(n));
        for (var c = 0; c < n; c++) {
            var e = []; for (var r = 0; r < n; r++) e.push(r === c ? 1 : 0);
            var col = solveLinear(A, e);
            if (!col) return null;
            for (var r3 = 0; r3 < n; r3++) out[r3][c] = col[r3];
        }
        return out;
    }

    // resFn(x) → residual array. lo/hi: per-parameter bounds.
    function lm(resFn, x0, lo, hi, maxIter) {
        var np = x0.length, x = x0.slice();
        function clamp(v) { for (var i = 0; i < np; i++) v[i] = Math.min(hi[i], Math.max(lo[i], v[i])); return v; }
        function ssrOf(r) { var s = 0; for (var i = 0; i < r.length; i++) s += r[i] * r[i]; return s; }
        clamp(x);
        var r = resFn(x), ssr = ssrOf(r), lambda = 1e-3, iter = 0, converged = false, J = null;
        function jac(xc, rc) {
            var Jm = [];
            for (var i = 0; i < rc.length; i++) Jm.push(new Array(np));
            for (var j = 0; j < np; j++) {
                var h = 1e-6 * Math.max(1, Math.abs(xc[j]));
                var xp = xc.slice(); xp[j] += h;
                if (xp[j] > hi[j]) { xp[j] = xc[j] - h; h = -h; }
                var rp = resFn(xp);
                for (var i2 = 0; i2 < rc.length; i2++) Jm[i2][j] = (rp[i2] - rc[i2]) / h;
            }
            return Jm;
        }
        while (iter < (maxIter || 60)) {
            iter++;
            J = jac(x, r);
            var A = [], g = [];
            for (var a = 0; a < np; a++) {
                A.push(new Array(np)); g.push(0);
                for (var b = 0; b < np; b++) {
                    var s = 0;
                    for (var i = 0; i < r.length; i++) s += J[i][a] * J[i][b];
                    A[a][b] = s;
                }
                for (var i3 = 0; i3 < r.length; i3++) g[a] += J[i3][a] * r[i3];
            }
            var accepted = false, xn = null, rn = null, ssrn = ssr;
            for (var tries = 0; tries < 12; tries++) {
                var M = A.map(function (row, ia) {
                    return row.map(function (v, ib) { return ia === ib ? v + lambda * Math.max(v, 1e-12) : v; });
                });
                var step = solveLinear(M, g.map(function (v) { return -v; }));
                if (!step) { lambda *= 10; continue; }
                xn = clamp(x.map(function (v, k) { return v + step[k]; }));
                rn = resFn(xn); ssrn = ssrOf(rn);
                if (isFinite(ssrn) && ssrn < ssr) { accepted = true; break; }
                lambda *= 10;
            }
            if (!accepted) { converged = true; break; }   // no downhill step left: at the minimum
            var rel = (ssr - ssrn) / Math.max(ssr, 1e-300);
            var dxMax = 0;
            for (var q = 0; q < np; q++) dxMax = Math.max(dxMax, Math.abs(xn[q] - x[q]));
            x = xn; r = rn; ssr = ssrn;
            lambda = Math.max(lambda / 10, 1e-12);
            if (rel < 1e-10 || dxMax < 1e-9) { converged = true; break; }
        }
        J = jac(x, r);
        var JtJ = [];
        for (var a2 = 0; a2 < np; a2++) {
            JtJ.push(new Array(np));
            for (var b2 = 0; b2 < np; b2++) {
                var s2 = 0;
                for (var i4 = 0; i4 < r.length; i4++) s2 += J[i4][a2] * J[i4][b2];
                JtJ[a2][b2] = s2;
            }
        }
        var inv = invert(JtJ), dof = Math.max(1, r.length - np), sigma2 = ssr / dof, se = [];
        for (var k2 = 0; k2 < np; k2++) se.push(inv && inv[k2][k2] > 0 ? Math.sqrt(inv[k2][k2] * sigma2) : NaN);
        return { x: x, r: r, ssr: ssr, iterations: iter, converged: converged, se: se };
    }

    function median(a) {
        var b = a.filter(isNum).sort(function (x, y) { return x - y; });
        if (!b.length) return NaN;
        var m = Math.floor(b.length / 2);
        return b.length % 2 ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }

    // Seeds k, C, S from the data (C3 seed formulas).
    function seedPhys(ad, w) {
        var n = ad.t.length, qBmu = ad.qRef * w.B * w.mu;
        var late = [];
        for (var i = Math.floor(0.7 * n); i < n; i++) if (ad.deriv[i] > 0) late.push(ad.deriv[i]);
        var dpr = median(late);
        var k = isNum(dpr) && dpr > 0 ? 70.6 * qBmu / (dpr * w.h) : 10;
        var C = ad.qRef * w.B * ad.t[0] / (24 * ad.dp[0]);
        var tr = ad.t[n - 1], dpR = ad.dp[n - 1];
        var S = isNum(dpr) && dpr > 0
            ? 0.5 * (dpR / dpr - Math.log(0.0002637 * k * tr / (w.phi * w.mu * w.ct * w.rw * w.rw)) - 0.80907) : 0;
        if (!isNum(k) || k <= 0) k = 10;
        if (!isNum(C) || C <= 0) C = 1e-3;
        if (!isNum(S)) S = 0;
        return { k: k, C: C, S: Math.max(-4, Math.min(40, S)) };
    }

    function r2Linear(obs, mod) {
        var n = obs.length, mean = 0, ssT = 0, ssR = 0;
        for (var i = 0; i < n; i++) mean += obs[i];
        mean /= n;
        for (var j = 0; j < n; j++) { ssT += (obs[j] - mean) * (obs[j] - mean); ssR += (obs[j] - mod[j]) * (obs[j] - mod[j]); }
        return { r2: ssT > 0 ? 1 - ssR / ssT : NaN, rmse: Math.sqrt(ssR / n) };
    }

    // Returns a C4-shaped fit object (not stored) or {error}.
    function localFit(ad, w, modelKey) {
        var reg = G.PRiSM_MODELS || {};
        var key = modelKey;
        var entry = reg[key];
        if (!entry || typeof entry.pd !== 'function' || !entry.defaults ||
            !('Cd' in entry.defaults) || !('S' in entry.defaults) || entry.kind === 'rate') {
            key = 'homogeneous'; entry = reg.homogeneous;
        }
        if (!entry || typeof entry.pd !== 'function') return { error: 'No model evaluator loaded.' };
        if (!ad || !ad.ok) return { error: (ad && ad.reason) || 'No analysable data.' };
        if (!w.complete) return { error: 'Well inputs incomplete (missing: ' + (w.missing || []).join(', ') + ').' };
        var q = isNum(ad.qRef) && ad.qRef > 0 ? ad.qRef : w.q;
        var adq = { t: ad.t, dp: ad.dp, deriv: ad.deriv, qRef: q };
        var h = w.h, phi = w.phi, mu = w.mu, ct = w.ct, rw = w.rw, Bf = w.B;
        var base = {};
        Object.keys(entry.defaults).forEach(function (k) { base[k] = entry.defaults[k]; });
        var tArr = ad.t, lnObs = ad.dp.map(Math.log);
        function scales(k, C) {
            return {
                A: 141.2 * q * Bf * mu / (k * h),
                B: 0.0002637 * k / (phi * mu * ct * rw * rw),
                Cd: 0.8936 * C / (phi * ct * h * rw * rw)
            };
        }
        function model(x) {
            var k = Math.pow(10, x[0]), C = Math.pow(10, x[1]), sc = scales(k, C);
            var prm = {}; for (var kk in base) prm[kk] = base[kk];
            prm.Cd = sc.Cd; prm.S = x[2];
            var td = [];
            for (var i = 0; i < tArr.length; i++) td.push(sc.B * tArr[i]);
            var pd;
            try { pd = entry.pd(td, prm); } catch (e) { pd = null; }
            var out = new Array(tArr.length);
            for (var j = 0; j < tArr.length; j++) out[j] = pd ? sc.A * pd[j] : NaN;
            return out;
        }
        function res(x) {
            var m = model(x), r = new Array(m.length);
            for (var i = 0; i < m.length; i++) r[i] = (m[i] > 0 && isFinite(m[i])) ? Math.log(m[i]) - lnObs[i] : 10;
            return r;
        }
        var s0 = seedPhys(adq, { B: Bf, mu: mu, h: h, phi: phi, ct: ct, rw: rw });
        var lo = [-3, -7, -5], hi = [5, 1, 50];
        var best = null;
        [s0.S, s0.S + 2, s0.S - 1.5].forEach(function (S0, idx) {
            if (best && best.ssr < 1e-6 * ad.t.length) return;
            if (idx > 0 && best && best.converged && best.ssr / ad.t.length < 1e-4) return;
            var f = lm(res, [Math.log10(s0.k), Math.log10(s0.C), S0], lo, hi, 80);
            if (!best || f.ssr < best.ssr) best = f;
        });
        var x = best.x, k = Math.pow(10, x[0]), C = Math.pow(10, x[1]), S = x[2], sc = scales(k, C);
        var mod = model(x), gof = r2Linear(ad.dp, mod);
        var n = ad.t.length, aic = n * Math.log(best.ssr / n) + 2 * 3;
        var z = 1.96;
        var ci = {
            k: [Math.pow(10, x[0] - z * best.se[0]), Math.pow(10, x[0] + z * best.se[0])],
            C: [Math.pow(10, x[1] - z * best.se[1]), Math.pow(10, x[1] + z * best.se[1])],
            S: [S - z * best.se[2], S + z * best.se[2]]
        };
        var tEnd = ad.t[n - 1];
        var params = {}; for (var kk2 in base) params[kk2] = base[kk2];
        params.Cd = sc.Cd; params.S = S;
        return {
            modelKey: key, kind: 'pressure', source: 'regression',
            params: params,
            phys: {
                k: k, kh: k * h, C: C, Cd: sc.Cd, S: S, pi: ad.pRef,
                rinv: Math.sqrt(k * tEnd / (948 * phi * mu * ct))
            },
            ci95: ci,
            stderr: { k: k * LN10 * best.se[0], C: C * LN10 * best.se[1], S: best.se[2] },
            identifiable: { k: true, C: true, S: isNum(best.se[2]) && z * best.se[2] < Math.max(1, Math.abs(S)) },
            r2: gof.r2, rmse: gof.rmse, aic: aic, iterations: best.iterations, converged: best.converged,
            objective: best.ssr, window: { tmin: ad.t[0], tmax: tEnd },
            scales: { A: sc.A, B: sc.B }, pRef: ad.pRef, pRefSource: ad.pRefSource,
            timestamp: new Date().toISOString(),
            warnings: ['Fitted by the built-in fallback (shared regression engine not loaded).']
        };
    }

    // =========================================================================
    // SECTION 5 — RESULTS RAIL
    // =========================================================================

    var _sheetExpanded = false;
    var _lastCandidates = [];
    var _lastCandidatesHash = null;   // dataset the race ranking belongs to
    var _toast = '';

    var SOURCE_LABEL = {
        regression: 'regression', automatch: 'auto-match', 'auto-match': 'auto-match',
        match: 'match', semilog: 'straight-line', 'straight-line': 'straight-line'
    };
    function sourceChip(src) {
        var s = String(src || '').toLowerCase();
        var cls = s === 'auto-match' ? 'automatch' : (s === 'straight-line' ? 'semilog' : s);
        var label = SOURCE_LABEL[s] || (src ? String(src) : 'model');
        return '<span class="prism-chip prism-chip--' + esc(cls) + '">' + esc(label) + '</span>';
    }

    var WELL_LABEL = { q: 'q', B: 'B', mu: 'μ', ct: 'c_t', h: 'h', phi: 'φ', rw: 'r_w', pi: 'p_i' };

    function interpHeadline(interp) {
        if (!interp) return '';
        var h = pick(interp, ['headline', 'summary', 'title']);
        if (h) return String(h);
        var n = interp.narrative;
        if (!n) return '';
        n = String(n).replace(/\s+/g, ' ').trim();
        var m = n.match(/^(.+?[.!?])(\s|$)/);
        return m ? m[1] : n;
    }

    function localHeadline(fit) {
        if (fit && fit.kind === 'rate' && fit.params) {
            var rp = fit.params;
            return modelName(fit.modelKey) + ' decline' + (isNum(rp.qi) ? ': q_i ' + fmt(rp.qi) : '') +
                (isNum(rp.Di) ? ', D_i ' + fmt(rp.Di) + '/d' : '') + (isNum(rp.b) ? ', b ' + fmt(rp.b, 2) : '') + '.';
        }
        if (!fit || !fit.phys) return '';
        var S = fit.phys.S, k = fit.phys.k, txt;
        if (!isNum(S)) txt = 'Well response';
        else if (S < -3) txt = 'Strongly stimulated well';
        else if (S < 0) txt = 'Stimulated well';
        else if (S < 2) txt = 'Near-undamaged well';
        else if (S < 5) txt = 'Mildly damaged well';
        else if (S < 10) txt = 'Moderately damaged well';
        else txt = 'Severely damaged well';
        return txt + (isNum(S) ? ' (S = ' + S.toFixed(1) + ')' : '') + ' — ' + modelName(fit.modelKey).toLowerCase() +
            (isNum(k) ? ', k ≈ ' + fmt(k) + ' md.' : '.');
    }

    function describePeriod(ad) {
        var ap = activePeriod();
        var periods = getPeriods();
        var lbl;
        if (ap != null && periods[ap]) lbl = '#' + (ap + 1) + ' ' + periods[ap].type;
        else lbl = periods.length > 1 ? 'All data (' + periods.length + ' periods)' : 'Single period';
        if (ad && ad.ok && ad.t && ad.t.length) {
            lbl += ' · Δt ' + fmt(ad.t[0], 2) + '–' + fmt(ad.t[ad.t.length - 1], 3) + ' h';
        }
        return lbl;
    }

    // Collects everything the rail shows. Exported as PRiSM_railInfo().
    function railInfo() {
        var s = st();
        var ds = G.PRiSM_dataset;
        var hasData = !!(ds && isArr(ds.t) && ds.t.length);
        var info = {
            dataset: null, period: null, testType: null, fit: null, semilog: null,
            model: null, headline: '', warnings: [], summary: ''
        };
        var well = getWell(ds);
        info.fluid = well.fluid || 'oil';
        var ad = hasData ? getAnalysisData() : null;
        if (hasData) {
            info.dataset = {
                name: ds.name || ds.label || ds.fileName || ds.filename || (isDefaultSample(ds) ? 'Demo data' : 'Loaded data'),
                n: ds.t.length
            };
            info.period = describePeriod(ad);
        }
        info.testType = (ad && ad.ok && ad.testType) || (well.testType && well.testType !== 'auto' ? well.testType : null);
        var lf = getLastFit();
        if (lf) {
            var phys = lf.phys || {};
            info.fit = {
                source: lf.source || 'regression', modelKey: lf.modelKey, phys: phys, kind: lf.kind || 'pressure',
                params: lf.params || null, eur: rateEUR(lf),
                ci95: lf.ci95 || {}, r2: lf.r2, rmse: lf.rmse, aic: lf.aic, dAIC: lf.dAIC,
                converged: lf.converged, stale: !!lf.stale, pRefSource: lf.pRefSource
            };
            info.model = {
                key: lf.modelKey, name: modelName(lf.modelKey), r2: lf.r2, converged: lf.converged,
                dAIC: isNum(lf.dAIC) ? lf.dAIC : null, nextDAIC: null, nextName: null
            };
            if (_lastCandidates.length > 1 && _lastCandidates[0].modelKey === lf.modelKey &&
                (!_lastCandidatesHash || !lf.datasetHash || _lastCandidatesHash === lf.datasetHash)) {
                info.model.nextDAIC = _lastCandidates[1].dAIC;
                info.model.nextName = modelName(_lastCandidates[1].modelKey);
            }
        }
        var sl = s.semilog;
        if (sl && typeof sl === 'object') {
            var sk = sl.skin || sl.skinSummary || sl.deliverables || {};
            info.semilog = {
                method: pick(sl, ['method', 'kind']),
                m: pickNum(sl, ['m', 'slope']),
                kh: pickNum(sl, ['kh']),
                k: pickNum(sl, ['k']),
                S: pickNum(sl, ['S', 'skin']),
                dpS: pickNum(sl, ['dpS', 'dPs', 'deltaPS', 'deltaPs', 'dpSkin']) != null
                    ? pickNum(sl, ['dpS', 'dPs', 'deltaPS', 'deltaPs', 'dpSkin']) : pickNum(sk, ['dpS', 'dPs', 'deltaPS', 'deltaPs', 'dpSkin']),
                FE: pickNum(sl, ['FE']) != null ? pickNum(sl, ['FE']) : pickNum(sk, ['FE']),
                DR: pickNum(sl, ['DR']) != null ? pickNum(sl, ['DR']) : pickNum(sk, ['DR']),
                J: pickNum(sl, ['J', 'PI']) != null ? pickNum(sl, ['J', 'PI']) : pickNum(sk, ['J']),
                pStar: pickNum(sl, ['pStar', 'pstar', 'p_star', 'pStarPsia'])
            };
            if (info.semilog.k == null && info.semilog.kh == null && info.semilog.S == null) info.semilog = null;
        }
        // Only a real fit gets a headline: st.interp can hold a 'manual' reading of the
        // untouched default parameters (S 0), which must not read as a result (WP0 fix).
        info.headline = lf ? (interpHeadline(s.interp) || localHeadline(lf)) : '';

        // ── Warnings ──
        var W = info.warnings;
        if (hasData && well.defaulted && well.defaulted.length) {
            W.push({
                id: 'defaulted', level: 'warn', action: 'accept',
                text: 'Defaulted inputs: ' + well.defaulted.map(function (k) { return WELL_LABEL[k] || k; }).join(', ') + '.'
            });
        }
        if (hasData && well.missing && well.missing.length) {
            W.push({
                id: 'missing', level: 'bad', action: 'data',
                text: 'Missing inputs: ' + well.missing.map(function (k) { return WELL_LABEL[k] || k; }).join(', ') + ' — results stay in scale mode.'
            });
        }
        var prs = (ad && ad.ok && ad.pRefSource) || (lf && lf.pRefSource);
        if (prs === 'first-sample') {
            W.push({ id: 'pref', level: 'bad', action: 'data', text: 'Δp is measured from the first sample, so skin is biased. Enter the initial pressure pi.' });
        } else if (prs === 'extrapolated') {
            W.push({ id: 'pref', level: 'warn', action: 'data', text: 'Reference pressure extrapolated to t = 0 — skin may be biased. Enter pi to confirm.' });
        }
        if (lf && lf.stale) {
            W.push({ id: 'stale', level: 'warn', action: 'analyse', text: 'Fit is out of date (data, period or model changed).' });
        }
        if (lf && lf.converged === false) {
            W.push({ id: 'noconv', level: 'warn', text: 'Fit did not converge — treat it as a starting point and refine.' });
        }
        if (ad && ad.ok && isArr(ad.warnings)) {
            toArr(ad.warnings).slice(0, 3).forEach(function (m, i) {
                if (prs && /biased|first sample/i.test(m)) return;
                W.push({ id: 'ad' + i, level: 'info', text: String(m) });
            });
        }
        if (ad && !ad.ok && hasData) W.push({ id: 'adfail', level: 'bad', text: ad.reason || 'Data cannot be analysed yet.' });

        // ── Sheet summary: "kh · S · model · ⚠n" ──
        var kh = info.fit && isNum(info.fit.phys.kh) ? info.fit.phys.kh : (info.semilog ? info.semilog.kh : null);
        var S = info.fit && isNum(info.fit.phys.S) ? info.fit.phys.S : (info.semilog ? info.semilog.S : null);
        var parts = [];
        parts.push('kh ' + (isNum(kh) ? fmt(kh) : '—'));
        parts.push('S ' + (isNum(S) ? S.toFixed(2) : '—'));
        parts.push(info.model ? info.model.name : (hasData ? 'No fit yet' : 'No data'));
        if (W.length) parts.push('⚠' + W.length);
        info.summary = parts.join(' · ');
        return info;
    }

    function rateEUR(lf) {
        if (!lf || lf.kind !== 'rate') return null;
        if (typeof G.PRiSM_declineResults === 'function') {
            try {
                var r = G.PRiSM_declineResults(lf, G.PRiSM_dataset, {});
                var e = r && pickNum(r, ['EUR', 'eur']);
                if (isNum(e)) return e;
            } catch (e2) {}
        }
        return null;
    }

    function kvRow(k, v, extra) {
        return '<div class="prism-rail-k">' + k + '</div><div class="prism-rail-v">' + v + (extra ? ' <small>' + extra + '</small>' : '') + '</div>';
    }

    function ciHalf(ci) { return (ci && isNum(ci[0]) && isNum(ci[1])) ? Math.abs(ci[1] - ci[0]) / 2 : null; }

    function railBodyHTML(info) {
        var h = [];
        // Dataset / period / test type
        h.push('<div class="prism-rail-sec" id="prism_rail_data">');
        h.push('<div class="prism-rail-h"><span>Data</span>' +
            (info.testType ? '<span class="prism-chip">' + esc(info.testType) + '</span>' : '') + '</div>');
        if (info.dataset) {
            h.push('<div class="prism-rail-kv">' +
                kvRow('Dataset', esc(info.dataset.name), esc(fmt(info.dataset.n)) + ' pts') +
                kvRow('Period', esc(info.period || '—')) + '</div>');
        } else {
            h.push('<div class="prism-rail-line">No data loaded. Load a file or try the demo data on step ①.</div>');
        }
        h.push('</div>');

        // Physical results from the active fit
        var f = info.fit;
        h.push('<div class="prism-rail-sec" id="prism_rail_results">');
        h.push('<div class="prism-rail-h"><span>Results</span>' + (f ? sourceChip(f.source) : '') + '</div>');
        if (f) {
            var p = f.phys || {}, ci = f.ci95 || {}, rows = [];
            var kHalf = ciHalf(ci.k), sHalf = ciHalf(ci.S), cHalf = ciHalf(ci.C);
            if (isNum(p.k)) rows.push(kvRow('k', fmt(p.k) + ' md', isNum(kHalf) ? '±' + fmt(100 * kHalf / p.k, 2) + '%' : ''));
            if (isNum(p.kh)) rows.push(kvRow('kh', fmt(p.kh) + ' md·ft'));
            if (isNum(p.S)) rows.push(kvRow('Skin S', fmtSigned(p.S, 2) + (isNum(sHalf) ? ' ± ' + fmtFixed(sHalf, 2) : '')));
            if (isNum(p.C)) rows.push(kvRow('C', fmt(p.C) + ' bbl/psi', (isNum(p.Cd) ? 'C_D ' + fmt(p.Cd) : '') + (isNum(cHalf) ? ' ±' + fmt(100 * cHalf / p.C, 2) + '%' : '')));
            else if (isNum(p.Cd)) rows.push(kvRow('C_D', fmt(p.Cd)));
            if (isNum(p.xf)) rows.push(kvRow('x_f', fmt(p.xf) + ' ft'));
            if (isNum(p.Lh)) rows.push(kvRow('L_h', fmt(p.Lh) + ' ft'));
            if (p.distances_ft && typeof p.distances_ft === 'object') {
                Object.keys(p.distances_ft).forEach(function (dk) {
                    if (isNum(p.distances_ft[dk])) rows.push(kvRow(esc(dk), fmt(p.distances_ft[dk]) + ' ft'));
                });
            }
            if (isNum(p.rinv)) rows.push(kvRow('r_inv', fmt(p.rinv) + ' ft'));
            if (isNum(p.pi)) rows.push(kvRow('p_i', fmt(p.pi, 5) + ' psia'));
            if (f.kind === 'rate' && f.params) {
                var rp = f.params;
                if (isNum(rp.qi)) rows.push(kvRow('q_i', fmt(rp.qi) + (info.fluid === 'gas' ? ' Mscf/d' : ' STB/d')));
                if (isNum(rp.Di)) rows.push(kvRow('D_i', fmt(rp.Di) + ' 1/d'));
                if (isNum(rp.b)) rows.push(kvRow('b', fmtFixed(rp.b, 2)));
                if (isNum(f.eur)) rows.push(kvRow('EUR', fmt(f.eur)));
            }
            h.push(rows.length ? '<div class="prism-rail-kv">' + rows.join('') + '</div>'
                : '<div class="prism-rail-line">The fit has no field-unit results (well inputs incomplete).</div>');
        } else {
            h.push('<div class="prism-rail-line">No fit yet. Press <b>▶ Analyse</b> for a one-click interpretation.</div>');
        }
        h.push('</div>');

        // Straight-line (semilog) results
        var sl = info.semilog;
        if (sl) {
            var srows = [];
            if (isNum(sl.m)) srows.push(kvRow('m', fmt(Math.abs(sl.m)) + ' psi/cycle'));
            if (isNum(sl.k)) srows.push(kvRow('k', fmt(sl.k) + ' md'));
            else if (isNum(sl.kh)) srows.push(kvRow('kh', fmt(sl.kh) + ' md·ft'));
            if (isNum(sl.S)) srows.push(kvRow('Skin S', fmtSigned(sl.S, 2)));
            if (isNum(sl.dpS)) srows.push(kvRow('Δp_skin', fmt(sl.dpS) + ' psi'));
            if (isNum(sl.FE)) srows.push(kvRow('FE', fmtFixed(sl.FE, 2), isNum(sl.DR) ? 'DR ' + fmtFixed(sl.DR, 2) : ''));
            else if (isNum(sl.DR)) srows.push(kvRow('DR', fmtFixed(sl.DR, 2)));
            if (isNum(sl.J)) srows.push(kvRow('J', fmt(sl.J) + (info.fluid === 'gas' ? ' Mscf/d/psi' : ' STB/d/psi')));
            if (isNum(sl.pStar)) srows.push(kvRow('p*', fmt(sl.pStar, 5) + ' psia'));
            h.push('<div class="prism-rail-sec" id="prism_rail_semilog"><div class="prism-rail-h"><span>Straight line' +
                (sl.method ? ' · ' + esc(String(sl.method).toUpperCase()) : '') + '</span>' + sourceChip('semilog') + '</div>' +
                '<div class="prism-rail-kv">' + srows.join('') + '</div></div>');
        }

        // Model
        var m = info.model;
        if (m) {
            var badge = m.converged === true ? '<span class="prism-chip prism-chip--ok">✓ converged</span>'
                : (m.converged === false ? '<span class="prism-chip prism-chip--warn">starting point</span>' : '');
            var mrows = [kvRow('Model', esc(m.name))];
            if (isNum(m.r2)) mrows.push(kvRow('R²', m.r2 >= 0.9999 ? m.r2.toFixed(5) : m.r2.toFixed(4)));
            if (isNum(m.nextDAIC) && m.nextName) mrows.push(kvRow('ΔAIC', fmt(m.nextDAIC, 3), 'vs ' + esc(m.nextName)));
            else if (isNum(m.dAIC) && m.dAIC !== 0) mrows.push(kvRow('ΔAIC', fmt(m.dAIC, 3)));
            h.push('<div class="prism-rail-sec" id="prism_rail_model"><div class="prism-rail-h"><span>Model</span>' + badge + '</div>' +
                '<div class="prism-rail-kv">' + mrows.join('') + '</div>' +
                (info.headline ? '<div class="prism-rail-headline" id="prism_rail_headline" style="margin-top:8px;">“' + esc(info.headline) + '”</div>' : '') +
                '</div>');
        } else if (info.headline) {
            h.push('<div class="prism-rail-sec"><div class="prism-rail-headline" id="prism_rail_headline">“' + esc(info.headline) + '”</div></div>');
        }

        // Warnings
        if (info.warnings.length) {
            h.push('<div class="prism-rail-sec" id="prism_rail_warnings"><div class="prism-rail-h"><span>Checks</span><span class="prism-chip prism-chip--warn">⚠ ' + info.warnings.length + '</span></div>');
            h.push('<div style="display:flex; flex-direction:column; gap:6px;">');
            info.warnings.forEach(function (w) {
                var cls = w.level === 'bad' ? ' prism-rail-warn--bad' : (w.level === 'info' ? ' prism-rail-warn--info' : '');
                var btn = '';
                if (w.action === 'accept') btn = '<button type="button" class="prism-btn prism-btn--small" id="prism_rail_accept">Accept</button>';
                else if (w.action === 'analyse') btn = '<button type="button" class="prism-btn prism-btn--small" data-rail-act="analyse">Re-run</button>';
                else if (w.action === 'data') btn = '<button type="button" class="prism-btn prism-btn--small" data-rail-act="data">Edit inputs</button>';
                h.push('<div class="prism-rail-warn' + cls + '" data-warn="' + esc(w.id) + '"><span>⚠ ' + esc(w.text) + '</span>' + btn + '</div>');
            });
            h.push('</div></div>');
        }

        // Actions
        var canStart = !!(f && f.phys) || !!(sl && (isNum(sl.k) || isNum(sl.S)));
        h.push('<div class="prism-rail-actions">' +
            '<button type="button" class="prism-btn" id="prism_rail_use_start"' + (canStart ? '' : ' disabled') + '>Use as start values</button>' +
            '<button type="button" class="prism-btn" id="prism_rail_pin"' + (f || sl ? '' : ' disabled') + '>Pin to report</button>' +
            (!f || f.stale ? '<button type="button" class="prism-btn prism-btn--primary" data-rail-act="analyse">▶ Analyse</button>' : '') +
            '</div>');
        if (_toast) h.push('<div class="prism-toast" id="prism_rail_toast">' + esc(_toast) + '</div>');
        return h.join('');
    }

    function PRiSM_renderRail(railEl) {
        railEl = railEl || $('prism_rail');
        if (!railEl) return null;
        ensureStyle();
        var info;
        try { info = railInfo(); } catch (e) {
            railEl.innerHTML = '<div class="prism-rail-body"><div class="prism-rail-warn prism-rail-warn--bad"><span>Results unavailable: ' + esc(e && e.message) + '</span></div></div>';
            return null;
        }
        var sheet = !!(railEl.classList && railEl.classList.contains('prism-rail--sheet'));
        var body = railBodyHTML(info);
        if (sheet) {
            railEl.innerHTML =
                '<button type="button" class="prism-rail-sheetbar" id="prism_rail_sheetbar" aria-expanded="' + (_sheetExpanded ? 'true' : 'false') + '" aria-controls="prism_rail_body">' +
                '<span class="prism-rail-grip" aria-hidden="true"></span>' +
                '<span class="prism-rail-sum" id="prism_rail_summary">' + esc(info.summary) + '</span>' +
                '<span aria-hidden="true">' + (_sheetExpanded ? '▾' : '▴') + '</span></button>' +
                '<div class="prism-rail-body" id="prism_rail_body" style="display:' + (_sheetExpanded ? 'flex' : 'none') + ';">' + body + '</div>';
            var bar = railEl.querySelector ? railEl.querySelector('#prism_rail_sheetbar') : $('prism_rail_sheetbar');
            if (bar) bar.onclick = function () { _sheetExpanded = !_sheetExpanded; PRiSM_renderRail(railEl); };
            if (_sheetExpanded) fitSheet(railEl);
        } else {
            railEl.innerHTML = '<div class="prism-rail-body" id="prism_rail_body">' + body + '</div>';
        }
        wireRail(railEl);
        return info;
    }

    // Nearest scrolling ancestor (the host page body), else null.
    function scrollHost(el) {
        var n = el && el.parentNode, gcs = typeof G.getComputedStyle === 'function' ? G.getComputedStyle : null;
        for (var i = 0; n && i < 40 && n.nodeType === 1; i++, n = n.parentNode) {
            var oy = '';
            try { oy = gcs ? gcs(n).overflowY : (n.style && n.style.overflowY); } catch (e) { oy = ''; }
            if ((oy === 'auto' || oy === 'scroll') && n.clientHeight > 0) return n;
        }
        return null;
    }

    // The expanded bottom sheet must fit inside the visible scroll area, so its
    // summary bar and ▾ toggle never slide under the host page header.
    function fitSheet(railEl) {
        try {
            var body = q1(railEl, '#prism_rail_body');
            if (!body || !body.style) return;
            var wrap = $('prism_railwrap') || railEl;
            var host = scrollHost(wrap);
            var vh = isNum(G.innerHeight) && G.innerHeight > 0 ? G.innerHeight : 0;
            var avail = 0;
            if (host && host.getBoundingClientRect) {
                // Visible content box of the scroll host (its padding is not usable by
                // a sticky child).
                var r = host.getBoundingClientRect(), padT = 0, padB = 0;
                try {
                    var hcs = G.getComputedStyle(host);
                    padT = parseFloat(hcs.paddingTop) || 0; padB = parseFloat(hcs.paddingBottom) || 0;
                } catch (e) { /* no computed style */ }
                avail = Math.min(r.bottom - padB, vh || r.bottom) - Math.max(r.top + padT, 0);
            }
            if (!(avail > 0)) avail = vh;
            if (!(avail > 0)) return;
            // Everything in the sheet that is not the scrolling body: bar, paddings, borders.
            var extra = 68;
            if (wrap.getBoundingClientRect && body.getBoundingClientRect) {
                var wr = wrap.getBoundingClientRect(), bd = body.getBoundingClientRect();
                if (wr && bd && wr.height > bd.height && bd.height > 0) extra = wr.height - bd.height;
            }
            body.style.maxHeight = Math.max(120, Math.round(Math.min(avail - extra - 8, (vh || avail) * 0.7))) + 'px';
        } catch (e) { /* keep the CSS max-height */ }
    }

    function collapseSheet() {
        if (!_sheetExpanded) return false;
        _sheetExpanded = false;
        var r = $('prism_rail');
        if (r) { try { PRiSM_renderRail(r); } catch (e) {} }
        return true;
    }

    function q1(root, sel) {
        try { return root.querySelector(sel); } catch (e) { return null; }
    }

    function wireRail(railEl) {
        var acc = q1(railEl, '#prism_rail_accept');
        if (acc) acc.onclick = function () { acceptDefaults(); _toast = 'Defaults accepted as your inputs.'; PRiSM_renderRail(railEl); };
        var use = q1(railEl, '#prism_rail_use_start');
        if (use) use.onclick = function () { useAsStartValues(); PRiSM_renderRail(railEl); };
        var pin = q1(railEl, '#prism_rail_pin');
        if (pin) pin.onclick = function () { pinToReport(); PRiSM_renderRail(railEl); };
        var acts = railEl.querySelectorAll ? railEl.querySelectorAll('[data-rail-act]') : [];
        for (var i = 0; i < acts.length; i++) {
            (function (b) {
                b.onclick = function () {
                    var a = b.getAttribute('data-rail-act');
                    if (a === 'analyse') PRiSM_analyse();
                    else if (a === 'data') gotoStep(1);
                };
            })(acts[i]);
        }
    }

    function acceptDefaults() {
        var w = getWell();
        var keys = (w.defaulted || []).slice();
        if (!keys.length) return false;
        var patch = {}, pvt = G.PRiSM_pvt || {};
        keys.forEach(function (k) {
            var pk = pvtKey(k, w.fluid);
            var v = isNum(w[k]) ? w[k] : pvt[pk];
            if (isNum(v)) patch[pk] = v;
        });
        if (!Object.keys(patch).length) return false;
        setWell(patch, 'user');
        return true;
    }

    function useAsStartValues() {
        var s = st(), lf = getLastFit(), info = railInfo(), phys = null;
        if (lf && lf.phys) {
            phys = clone(lf.phys);
            if (lf.params && (!lf.modelKey || lf.modelKey === s.model)) s.params = clone(lf.params);
        } else if (info.semilog) {
            phys = {};
            if (isNum(info.semilog.k)) phys.k = info.semilog.k;
            if (isNum(info.semilog.S)) phys.S = info.semilog.S;
        }
        if (!phys) return false;
        var cur = s.phys || {};
        Object.keys(phys).forEach(function (k) { cur[k] = phys[k]; });
        s.phys = cur;
        saveState();
        recordSnapshot('start-values');
        _toast = 'Start values set for the next fit' + (isNum(cur.k) ? ' (k ' + fmt(cur.k) + ' md' + (isNum(cur.S) ? ', S ' + cur.S.toFixed(2) : '') + ')' : '') + '.';
        dispatch('prism:start-values', { phys: clone(cur) });
        return true;
    }

    function pinToReport() {
        var s = st(), info = railInfo(), lf = getLastFit();
        if (!info.fit && !info.semilog) return null;
        var pin = {
            id: 'pin_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e4),
            timestamp: new Date().toISOString(),
            dataset: info.dataset, period: info.period, testType: info.testType,
            modelKey: lf ? lf.modelKey : null, modelName: lf ? modelName(lf.modelKey) : null,
            source: lf ? lf.source : 'semilog',
            phys: lf ? clone(lf.phys) : null, ci95: lf ? clone(lf.ci95) : null,
            r2: lf ? lf.r2 : null, aic: lf ? lf.aic : null, converged: lf ? lf.converged : null,
            semilog: clone(info.semilog), headline: info.headline
        };
        s.reportPins = isArr(s.reportPins) ? s.reportPins : [];
        s.reportPins.push(pin);
        if (s.reportPins.length > 20) s.reportPins.shift();
        saveState();
        _toast = 'Pinned to the report (' + s.reportPins.length + ' pinned).';
        dispatch('prism:report-pinned', { pin: clone(pin) });
        return pin;
    }

    function renderRailIfMounted() {
        var r = $('prism_rail');
        if (r) { try { PRiSM_renderRail(r); } catch (e) {} }
    }

    // =========================================================================
    // SECTION 6 — ONE-CLICK ANALYSE PIPELINE
    // =========================================================================

    var _analyseRun = null;
    var _analyseCancel = false;

    // Hide the Analyse progress panel (auto-close after a run, on a new fit /
    // dataset / project, or the ✕ button). Never while a run is in progress.
    function hideProgress(force) {
        if (_analyseRun && !force) return;
        var box = $('prism_analyse_progress');
        if (box) box.style.display = 'none';
    }

    // Narrow screens: keep the panel clear of the rail bottom sheet's bar.
    function placeProgress(box) {
        try {
            var wrap = $('prism_railwrap'), rail = $('prism_rail');
            var vh = isNum(G.innerHeight) && G.innerHeight > 0 ? G.innerHeight : 0;
            box.style.bottom = '';
            if (!vh || !wrap || !rail || !rail.classList || !rail.classList.contains('prism-rail--sheet') || !wrap.getBoundingClientRect) return;
            var r = wrap.getBoundingClientRect();
            if (r && r.height > 0 && r.top < vh) box.style.bottom = Math.max(16, Math.round(vh - r.top + 8)) + 'px';
        } catch (e) { /* keep the CSS position */ }
    }

    var PROGRESS_STEPS = [
        ['data', 'Read data & inputs'],
        ['semilog', 'Straight-line analysis'],
        ['race', 'Model race (top 3)'],
        ['refine', 'Refine best model'],
        ['interp', 'Interpretation']
    ];

    function progressUI() {
        var host = D && D.body;
        if (!host || !D.createElement) {
            return { step: function () {}, done: function () {} };
        }
        ensureStyle();
        var box = $('prism_analyse_progress');
        if (!box) {
            box = D.createElement('div');
            box.id = 'prism_analyse_progress';
            box.className = 'prism-progress';
            box.setAttribute('role', 'status');
            box.setAttribute('aria-live', 'polite');
            host.appendChild(box);
        }
        box.style.display = '';
        if (box.classList) box.classList.remove('is-done');
        placeProgress(box);
        box.innerHTML = '<div class="prism-progress-head"><span id="prism_analyse_title">Analysing…</span>' +
            '<button type="button" class="prism-btn prism-btn--small" id="prism_analyse_cancel">Cancel</button>' +
            '<button type="button" class="prism-btn prism-btn--small" id="prism_analyse_close" aria-label="Close">✕</button></div>' +
            PROGRESS_STEPS.map(function (s) {
                return '<div class="prism-progress-row" id="prism_analyse_step_' + s[0] + '"><b>○</b><span>' + esc(s[1]) + '</span><em></em></div>';
            }).join('') +
            '<div class="prism-progress-note" id="prism_analyse_note" style="display:none"></div>';
        var close = $('prism_analyse_close');
        if (close) close.onclick = function () { hideProgress(true); };
        var cancel = $('prism_analyse_cancel');
        if (cancel) cancel.onclick = function () {
            _analyseCancel = true;
            cancel.disabled = true;
            cancel.textContent = 'Cancelling…';
        };
        var ICON = { run: '…', ok: '✓', skip: '–', warn: '⚠', fail: '✕' };
        return {
            step: function (key, status, note) {
                var row = $('prism_analyse_step_' + key);
                if (!row) return;
                row.className = 'prism-progress-row is-' + status;
                var b = row.querySelector ? row.querySelector('b') : null;
                var em = row.querySelector ? row.querySelector('em') : null;
                if (b) b.textContent = ICON[status] || '○';
                if (em) em.textContent = note || '';
            },
            done: function (res) {
                var cb = $('prism_analyse_cancel');
                if (cb) cb.style.display = 'none';
                var t = $('prism_analyse_title');
                if (!t) return;
                // A successful run fades out after a few seconds (CSS animation, no
                // timer left behind); a stopped run stays until ✕ (or a new fit /
                // dataset) so the reason can be read.
                var pb = $('prism_analyse_progress');
                if (res.ok && pb && pb.classList) pb.classList.add('is-done');
                if (res.ok) {
                    var p = res.fit && res.fit.phys || {};
                    t.textContent = 'Done in ' + (res.elapsedMs / 1000).toFixed(1) + ' s' +
                        (isNum(p.k) ? ' — k ' + fmt(p.k) + ' md' : '') + (isNum(p.S) ? ', S ' + p.S.toFixed(2) : '');
                } else {
                    t.textContent = 'Analysis stopped: ' + (res.error || 'see steps');
                }
                var note = $('prism_analyse_note');
                if (note) {
                    note.textContent = res.previewText ? 'Best candidate (preview only, not committed): ' + res.previewText : '';
                    note.style.display = res.previewText ? '' : 'none';
                }
            }
        };
    }

    function setAnalyseBusy(busy) {
        var b = $('prism_analyse_btn');
        if (!b) return;
        b.disabled = !!busy;
        if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    }

    function sharedEngine() { return typeof G.PRiSM_fitPhysical === 'function'; }

    function validFitRow(r) {
        return !!(r && r.phys && isNum(r.phys.k) && r.phys.k > 0 && !r.error);
    }

    function aicOf(f) { var a = f && (f.aic != null ? f.aic : f.AIC); return isNum(a) ? a : Infinity; }

    // C3 consistency: the pressure scale A must equal 141.2·q·B·μ/kh for the
    // reported kh (oil / water; gas pseudo-pressure fits are not checked).
    function physConsistent(fit, well, ad) {
        var p = fit && fit.phys || {}, sc = fit && fit.scales || {};
        if (!isNum(p.k) || p.k <= 0) return false;
        if (!well || !well.complete || well.fluid === 'gas' || (ad && ad.fluid === 'gas')) return true;
        if (!isNum(sc.A) || !(sc.A > 0) || !isNum(p.kh) || !(p.kh > 0)) return true;
        var q = ad && isNum(ad.qRef) && ad.qRef > 0 ? ad.qRef : well.q;
        var aExp = 141.2 * q * well.B * well.mu / p.kh;
        return Math.abs(sc.A / aExp - 1) < 0.05;
    }

    function rmseOf(f) { var r = f && (f.rmse != null ? f.rmse : f.RMSE); return isNum(r) ? r : Infinity; }
    function r2Of(f) { var r = f && (f.r2 != null ? f.r2 : f.R2); return isNum(r) ? r : null; }

    // Adoption rule shared with PRiSM_runRegression (05): a fit is committed only
    // when R² ≥ 0.9 and no parameter is stalled at a bound (without an R²,
    // convergence decides); an unconverged fit must also have settled and have
    // no free parameter at any bound. Returns the reason a fit is rejected, or null.
    function fitRejectReason(f) {
        if (!f) return 'no fit';
        var why = [];
        var stalled = isArr(f.stalledAtBound) ? toArr(f.stalledAtBound) : [];
        var unconv = f.converged === false;
        var boundUnconv = (unconv && isArr(f.atBoundKeys)) ? toArr(f.atBoundKeys) : [];
        if (stalled.length) why.push('parameter at a bound: ' + stalled.join(', '));
        else if (boundUnconv.length) why.push('not converged with parameter at a bound: ' + boundUnconv.join(', '));
        if (unconv && f.settled === false) why.push('not converged (' + (f.stopReason || 'stopped') + ') and still improving');
        var r2 = r2Of(f);
        if (r2 != null && r2 < 0.9) why.push('R² ' + r2.toFixed(3) + ' < 0.9');
        if (r2 == null && f.converged === false) why.push('not converged');
        if (!why.length && f.adopted === false) why.push('rejected by the regression');
        return why.length ? why.join('; ') : null;
    }

    // Default frozen-parameter map for a model (what PRiSM_setModel would set).
    function defaultFreeze(key) {
        var e = (G.PRiSM_MODELS || {})[key], frz = {};
        if (e && isArr(e.defaultFrozen)) toArr(e.defaultFrozen).forEach(function (k) { frz[k] = true; });
        return frz;
    }

    // Refine result when nothing passes the adoption rule: nothing is committed;
    // the best rejected candidate (highest R²) is returned as a preview only.
    function noAcceptable(list) {
        var best = null;
        list.forEach(function (c) {
            if (!c || !c.fit) return;
            if (!best || (r2Of(c.fit) != null ? r2Of(c.fit) : -Infinity) > (r2Of(best.fit) != null ? r2Of(best.fit) : -Infinity)) best = c;
        });
        return { fit: null, rejected: true, preview: best ? best.fit : null,
                 reason: best ? (best.reason || fitRejectReason(best.fit)) : 'no fit' };
    }

    // Refine the chosen model. Resolves {fit, committed, note}.
    //   mode 'shared'   — shared regression engine only
    //   mode 'fallback' — built-in physical fit only
    //   default         — shared when loaded; the race row and the built-in fit
    //                     back it up when the refined result is inconsistent.
    var REFINE_BUDGET_MS = 15000;   // wall-clock cap per refine fit (slow fracture models)
    // Nothing is written to PRiSM_state here unless a fit passes the adoption
    // rule (fitRejectReason): a rejected fit resolves {fit:null, rejected:true,
    // preview, reason} and the previous model / params / lastFit stay as they were.
    function refine(key, ad, well, row, mode) {
        var s = st();
        function local() {
            var f = localFit(ad, well, key);
            if (f && !f.error) return { fit: f, committed: false };
            throw new Error(f && f.error ? f.error : 'Fit failed.');
        }
        function checked(c) {
            var why = fitRejectReason(c.fit);
            if (!why) return c;
            c.reason = why;
            return noAcceptable([c]);
        }
        if (mode === 'fallback' || !sharedEngine()) {
            if (mode === 'shared') return Promise.reject(new Error('Shared regression engine not loaded.'));
            return Promise.resolve().then(function () { return checked(local()); });
        }
        var rejected = [];
        return Promise.resolve().then(function () {
            if (typeof G.PRiSM_runRegression === 'function') {
                // Start from the race row without touching the state: runRegression
                // adopts (setModel + params + lastFit) only a fit that passes its rule.
                var ropts = { modelKey: key, start: row && row.phys, timeBudgetMs: REFINE_BUDGET_MS };
                if (row && row.params) ropts.params = clone(row.params);
                if (s.model !== key) ropts.freeze = defaultFreeze(key);
                var before = s.lastFit;
                return Promise.resolve(G.PRiSM_runRegression(ropts))
                    .then(function (r) {
                        var lf = getLastFit();
                        if (s.lastFit !== before && validFitRow(lf) && lf.modelKey === key) return { fit: lf, committed: true };
                        if (r && r.adopted === false) {
                            // Rejected by runRegression: not a result (and no point re-running
                            // the same fit through fitPhysical below).
                            if (validFitRow(r)) rejected.push({ fit: normaliseFit(r), reason: fitRejectReason(r) });
                            return { skip: true };
                        }
                        if (validFitRow(r)) return { fit: normaliseFit(r), committed: false };
                        return null;
                    }, function () { return null; });
            }
            return null;
        }).then(function (out) {
            if (out && out.skip) out = null;
            else if (!out) {
                try {
                    var f = G.PRiSM_fitPhysical(key, ad, well, { start: row && row.phys, timeBudgetMs: REFINE_BUDGET_MS });
                    if (validFitRow(f)) out = { fit: normaliseFit(f), committed: false };
                } catch (e) {}
            }
            var cands = [];
            if (out) cands.push(out);
            if (validFitRow(row)) cands.push({ fit: normaliseFit(row), committed: false, note: 'model-race result kept', race: true });
            // Parameters the refined regression (same model, started from the race
            // row) drove onto a bound: the race row is an intermediate point on the
            // way there (the short race may stop just short of the bound), so the
            // stall applies to it too.
            var refinedStall = [];
            rejected.forEach(function (c) {
                if (c.fit && isArr(c.fit.stalledAtBound)) toArr(c.fit.stalledAtBound).forEach(function (k) {
                    if (refinedStall.indexOf(k) < 0) refinedStall.push(k);
                });
            });
            // Adoption rule first (same as PRiSM_runRegression), then C3 consistency.
            cands = cands.filter(function (c) {
                var why = c.committed ? null : fitRejectReason(c.fit);
                if (!why && c.race && refinedStall.length) why = 'parameter at a bound in the refined fit: ' + refinedStall.join(', ');
                if (why) { c.reason = why; rejected.push(c); return false; }
                return true;
            });
            var ok = cands.filter(function (c) { return physConsistent(c.fit, well, ad); });
            if (!ok.length) {
                if (mode === 'shared') {
                    if (cands.length) return cands[0];
                    if (rejected.length) return noAcceptable(rejected);
                    throw new Error('The shared regression returned no usable fit.');
                }
                // Every candidate failed the adoption rule: report it, do not swap
                // in a different (built-in homogeneous) model behind the user's back.
                if (!cands.length && rejected.length) return noAcceptable(rejected);
                // A fit runRegression already adopted (and stored) stays the result
                // when the built-in fallback cannot do better.
                var adoptedC = cands.filter(function (c) { return c.committed; })[0] || null;
                var l;
                try { l = local(); } catch (e) {
                    if (adoptedC) return adoptedC;
                    if (rejected.length) return noAcceptable(rejected);
                    throw e;
                }
                var lwhy = fitRejectReason(l.fit);
                if (lwhy) {
                    if (adoptedC) return adoptedC;
                    l.reason = lwhy; rejected.push(l); return noAcceptable(rejected);
                }
                l.note = cands.length ? 'built-in fit used: the shared result was inconsistent (A ≠ 141.2qBμ/kh)'
                                  : 'built-in fit used: the shared regression returned no fit';
                return l;
            }
            var best = ok[0];
            for (var i = 1; i < ok.length; i++) if (rmseOf(best.fit) > 1.05 * rmseOf(ok[i].fit)) best = ok[i];
            if (best !== cands[0] && cands.length && !best.note) best.note = 'refined fit rejected';
            if (best !== cands[0] && cands[0] && !physConsistent(cands[0].fit, well, ad)) {
                best.note = (best.note || '') + ' (refined result inconsistent: A ≠ 141.2qBμ/kh)';
            }
            if (!best.committed && rejected.length && rejected[0].fit && rejected[0].fit !== best.fit) {
                best.note = (best.note ? best.note + ' ' : '') + '(refined fit not adopted: ' + rejected[0].reason + ')';
            }
            return best;
        });
    }

    function commitFit(fit) {
        var s = st();
        fit.source = fit.source || 'regression';
        if (fit.modelKey && s.model !== fit.modelKey) s.model = fit.modelKey;   // no setModel: keep the fitted params
        if (fit.params) s.params = clone(fit.params);
        if (fit.phys) s.phys = clone(fit.phys);
        if (fit.scales && isNum(fit.scales.A) && fit.scales.A > 0 && isNum(fit.scales.B) && fit.scales.B > 0) {
            s.tcMatch = { logPM: Math.log10(1 / fit.scales.A), logTM: Math.log10(fit.scales.B), source: fit.source };
        }
        if (typeof G.PRiSM_setLastFit === 'function') {
            try { G.PRiSM_setLastFit(fit); } catch (e) { s.lastFit = fit; dispatch('prism:fit-updated', { source: fit.source }); }
        } else {
            var lf = clone(fit);
            lf.R2 = lf.r2; lf.RMSE = lf.rmse; lf.AIC = lf.aic; lf.CI95 = lf.ci95;   // legacy readers
            s.lastFit = lf;
            dispatch('prism:fit-updated', { source: fit.source, modelKey: fit.modelKey });
        }
        if (typeof G.PRiSM_evalModelCurve === 'function') {
            try { G.PRiSM_evalModelCurve(s.model, s.params); } catch (e) {}
        }
        saveState();
        redraw();
    }

    function isRateOnly(ds) {
        if (!ds || !isArr(ds.q)) return false;
        if (!isArr(ds.p)) return true;
        for (var i = 0; i < ds.p.length; i++) if (isNum(ds.p[i])) return false;
        return true;
    }

    // Races the rate models through the shared rate fitter (q as target).
    function declineRace(ds) {
        var reg = G.PRiSM_MODELS || {}, rows = [];
        Object.keys(reg).forEach(function (k) {
            if (!reg[k] || reg[k].kind !== 'rate') return;
            try {
                var f = normaliseFit(G.PRiSM_fitRate(k, ds, {}));
                if (f && f.params && (isNum(f.r2) || isNum(f.aic))) {
                    f.modelKey = f.modelKey || k;
                    f.kind = 'rate';
                    f.source = f.source || 'regression';
                    rows.push(f);
                }
            } catch (e) { /* model not fittable to these rates */ }
        });
        rows.sort(function (a, b) { return aicOf(a) - aicOf(b); });
        var a0 = rows.length ? aicOf(rows[0]) : 0;
        return rows.slice(0, 3).map(function (row) {
            return { modelKey: row.modelKey, dAIC: isFinite(aicOf(row)) ? aicOf(row) - a0 : null, r2: row.r2, row: row };
        });
    }

    function PRiSM_analyse(opts) {
        if (_analyseRun) return _analyseRun;
        opts = opts || {};
        var t0 = now();
        var s = st();
        _analyseCancel = false;
        var ui = progressUI();
        var res = { ok: false, fit: null, semilog: null, candidates: [], engine: (opts.engine !== 'fallback' && sharedEngine()) ? 'shared' : 'fallback', warnings: [], elapsedMs: 0, error: null };
        var ad = null, well = null, rateOnly = false;
        setAnalyseBusy(true);
        recordSnapshot('pre-analyse');   // capture silent edits, then one undo step for the whole run
        _batch++;
        function stop(msg) { var e = new Error(msg); e._stop = true; return e; }

        _analyseRun = yieldTick().then(function () {
            ui.step('data', 'run');
            var ds = G.PRiSM_dataset;
            if (!ds || !isArr(ds.t) || !ds.t.length) throw stop('No data loaded — load a file or the demo data on step ①.');
            well = getWell(ds);
            if (isRateOnly(ds)) {
                if (typeof G.PRiSM_fitRate !== 'function') throw stop('Rate-only data: the decline fitting engine is not loaded.');
                rateOnly = true;
                ui.step('data', 'ok', fmt(ds.t.length) + ' pts · rate only (decline)');
                return yieldTick();
            }
            ad = getAnalysisData(opts.period != null ? { period: opts.period } : periodOpts());
            if (!ad || !ad.ok) throw stop((ad && ad.reason) || 'Data cannot be analysed.');
            ui.step('data', well.complete ? 'ok' : 'warn', fmt(ad.n) + ' pts · ' + (ad.testType || 'test') +
                (well.complete ? '' : ' · missing ' + (well.missing || []).join(', ')));
            return yieldTick();
        }).then(function () {
            if (rateOnly) { ui.step('semilog', 'skip', 'rate-only data'); return null; }
            if (typeof G.PRiSM_semilogAnalysis === 'function') {
                ui.step('semilog', 'run');
                try {
                    var sl = G.PRiSM_semilogAnalysis(ad, well, {});
                    if (sl && typeof sl === 'object' && s.semilog !== sl && sl.ok !== false) s.semilog = sl;
                    res.semilog = s.semilog || null;
                    var slk = res.semilog && pickNum(res.semilog, ['k']), sls = res.semilog && pickNum(res.semilog, ['S']);
                    ui.step('semilog', res.semilog ? 'ok' : 'warn', res.semilog ? ((isNum(slk) ? 'k ' + fmt(slk) + ' md' : '') + (isNum(sls) ? ' · S ' + sls.toFixed(2) : '')) : 'no straight line');
                } catch (e) {
                    ui.step('semilog', 'warn', e && e.message);
                    res.warnings.push('Straight-line analysis: ' + (e && e.message));
                }
            } else ui.step('semilog', 'skip', 'not available');
            return yieldTick();
        }).then(function () {
            if (rateOnly) {
                ui.step('race', 'run');
                res.candidates = declineRace(G.PRiSM_dataset);
                ui.step('race', res.candidates.length ? 'ok' : 'fail', res.candidates.length ? 'best: ' + modelName(res.candidates[0].modelKey).toLowerCase() : 'no decline model fitted');
                if (!res.candidates.length) throw stop('No decline model could be fitted to the rates.');
                return null;
            }
            if (opts.race === false || opts.engine === 'fallback' || !(sharedEngine() && typeof G.PRiSM_autoMatch === 'function')) {
                ui.step('race', 'skip', 'using ' + modelName(opts.modelKey || s.model || 'homogeneous').toLowerCase());
                return null;
            }
            ui.step('race', 'run');
            return Promise.resolve().then(function () {
                return G.PRiSM_autoMatch({ topN: 3, maxIter: 40, adata: ad, well: well, silent: true,
                    onProgress: function (i, n, key) {
                        ui.step('race', 'run', (i + 1) + '/' + n + ' · ' + modelName(key).toLowerCase());
                    },
                    shouldCancel: function () { return _analyseCancel; } });
            }).then(function (r) {
                var rows = r ? (isArr(r) ? r : (r.ranked || r.rows || r.results || [])) : [];
                rows = toArr(rows).filter(validFitRow);
                // Same ranking as the model library (13): AIC, then parsimony
                // when the leader has an undeterminable parameter.
                if (typeof G.PRiSM_rankCandidates === 'function') G.PRiSM_rankCandidates(rows, aicOf);
                else rows.sort(function (a, b) { return aicOf(a) - aicOf(b); });
                var aics = rows.map(aicOf).filter(isNum);
                var a0 = aics.length ? Math.min.apply(null, aics) : 0;
                if (rows.length && rows[0].parsimony) {
                    res.warnings.push(modelName(rows[0].modelKey || rows[0].model) + ' chosen: statistically equivalent to ' +
                        modelName(rows[1].modelKey || rows[1].model).toLowerCase() + ' (ΔAIC < 2) with every parameter determined by the data.');
                }
                res.candidates = rows.slice(0, 3).map(function (row) {
                    return { modelKey: row.modelKey || row.model, dAIC: isNum(aicOf(row)) ? aicOf(row) - a0 : null, r2: row.r2 != null ? row.r2 : row.R2, row: row };
                });
                ui.step('race', rows.length ? 'ok' : 'warn', rows.length ? 'best: ' + modelName(res.candidates[0].modelKey).toLowerCase() : 'no candidate converged');
            }, function (e) {
                ui.step('race', 'warn', e && e.message);
                res.warnings.push('Model race: ' + (e && e.message));
            });
        }).then(function () {
            if (_analyseCancel) throw stop('Cancelled.');
            ui.step('refine', 'run');
            // Race candidates in AIC order. A row that already fails the adoption
            // rule (R² < 0.9 or a parameter stalled at a bound) is skipped in favour
            // of the next one; when every row fails, the top one is still refined
            // (the regression from its start may pass). Nothing is committed unless
            // a fit passes the same rule as PRiSM_runRegression.
            var cs = res.candidates.slice();
            var order = cs.filter(function (c) { return !fitRejectReason(normaliseFit(c.row)); });
            if (!order.length) order = cs.slice(0, 1);
            if (!order.length) {
                if (rateOnly) throw stop('No decline model could be fitted to the rates.');
                return refine(opts.modelKey || s.model || 'homogeneous', ad, well, null, opts.engine);
            }
            var tried = [];
            function attempt(i) {
                if (i >= order.length) return noAcceptable(tried);
                if (_analyseCancel) throw stop('Cancelled.');
                var c = order[i];
                if (i > 0) ui.step('refine', 'run', 'trying ' + modelName(c.modelKey).toLowerCase());
                var pr;
                if (rateOnly) {
                    var rf = normaliseFit(c.row), rwhy = fitRejectReason(rf);
                    if (rwhy) pr = Promise.resolve(noAcceptable([{ fit: rf, reason: rwhy }]));
                    else pr = Promise.resolve({ fit: rf, committed: false });
                } else pr = refine(c.modelKey, ad, well, c.row, opts.engine);
                return pr.then(function (out) {
                    if (out && out.fit) { out.cand = c; return out; }
                    if (out && out.rejected) {
                        if (out.preview) tried.push({ fit: out.preview, reason: out.reason });
                        if (i + 1 < order.length) res.warnings.push(modelName(c.modelKey) + ' not adopted (' + (out.reason || 'no fit') + ').');
                    }
                    return attempt(i + 1);
                });
            }
            return attempt(0);
        }).then(function (out) {
            if (out && out.rejected) {
                // No acceptable fit: keep the previous model, params, lastFit and
                // interpretation; show the best candidate as an uncommitted preview.
                var pv = out.preview, pp = (pv && pv.phys) || {};
                res.preview = pv || null;
                res.rejectReason = out.reason || null;
                res.previewText = pv ? modelName(pv.modelKey) +
                    (r2Of(pv) != null ? ' · R² ' + r2Of(pv).toFixed(3) : '') +
                    (isNum(pp.k) ? ' · k ' + fmt(pp.k) + ' md' : '') + (isNum(pp.S) ? ' · S ' + pp.S.toFixed(2) : '') +
                    (out.reason ? ' — ' + out.reason : '') : '';
                ui.step('refine', 'warn', 'no acceptable fit' + (out.reason ? ' — ' + out.reason : ''));
                ui.step('interp', 'skip', 'previous result kept');
                res.warnings.push('No acceptable fit' + (out.reason ? ' (' + out.reason + ')' : '') +
                    (pv ? '; best candidate ' + modelName(pv.modelKey) + ' shown as a preview only' : '') +
                    ' — previous parameters and result kept.');
                throw stop('No acceptable fit' + (out.reason ? ' (' + out.reason + ')' : '') + ' — previous result kept.');
            }
            if (!out || !out.fit) throw stop('The fit failed.');
            var fit = out.fit;
            // Higher-ranked race rows that failed the adoption rule were skipped.
            if (out.cand && res.candidates.indexOf(out.cand) > 0) {
                res.candidates.slice(0, res.candidates.indexOf(out.cand)).forEach(function (c) {
                    var why = fitRejectReason(normaliseFit(c.row));
                    if (why) res.warnings.push(modelName(c.modelKey) + ' skipped (' + why + ').');
                });
            }
            if (out.note) {
                res.warnings.push(out.note);
                fit.warnings = (isArr(fit.warnings) ? toArr(fit.warnings) : []).concat([out.note]);
            }
            if (res.candidates.length) {
                fit.dAIC = out.cand && isNum(out.cand.dAIC) ? out.cand.dAIC : 0;
                _lastCandidates = res.candidates.map(function (c) { return { modelKey: c.modelKey, dAIC: c.dAIC }; });
                _lastCandidatesHash = null;
                if (typeof G.PRiSM_datasetHash === 'function') { try { _lastCandidatesHash = G.PRiSM_datasetHash(); } catch (e) {} }
            } else { _lastCandidates = []; _lastCandidatesHash = null; }
            if (!out.committed) commitFit(fit);
            res.fit = getLastFit() || fit;
            var p = res.fit.phys || {}, rp = res.fit.params || {};
            ui.step('refine', res.fit.converged === false ? 'warn' : 'ok',
                (isNum(p.k) ? 'k ' + fmt(p.k) + ' md' : '') + (isNum(p.S) ? ' · S ' + p.S.toFixed(2) : '') +
                (rateOnly && isNum(rp.qi) ? 'q_i ' + fmt(rp.qi) : '') +
                (isNum(res.fit.r2) ? ' · R² ' + res.fit.r2.toFixed(4) : ''));
            return yieldTick();
        }).then(function () {
            ui.step('interp', 'run');
            var it = null;
            if (typeof G.PRiSM_interpretCurrentFit === 'function') {
                try { it = G.PRiSM_interpretCurrentFit(); } catch (e) { it = null; }
            }
            if (it) s.interp = it;
            else if (!s.interp || s.interp._local) s.interp = { headline: localHeadline(res.fit), narrative: localHeadline(res.fit), _local: true };
            ui.step('interp', 'ok', interpHeadline(s.interp).slice(0, 60));
            res.ok = true;
        }).catch(function (e) {
            res.error = (e && e.message) || String(e);
            PROGRESS_STEPS.forEach(function (st2) {
                var row = $('prism_analyse_step_' + st2[0]);
                if (row && /is-run/.test(row.className)) ui.step(st2[0], 'fail', res.error);
            });
        }).then(function () {
            res.elapsedMs = now() - t0;
            _analyseRun = null;
            _batch = Math.max(0, _batch - 1);
            recordSnapshot('analyse');
            setAnalyseBusy(false);
            ui.done(res);
            if (res.ok && opts.goto !== false) gotoStep(4);
            renderRailIfMounted();
            dispatch('prism:analyse-done', { ok: res.ok, error: res.error, modelKey: res.fit && res.fit.modelKey });
            return res;
        });
        return _analyseRun;
    }

    function gotoStep(n) {
        if (typeof G.PRiSM_gotoStep === 'function') { try { G.PRiSM_gotoStep(n); return true; } catch (e) {} }
        var tabFor = { 1: 1, 2: 1, 3: 2, 4: 6, 5: 7 };
        if (G.PRiSM && typeof G.PRiSM.setTab === 'function' && $('prism_tabs')) {
            try { G.PRiSM.setTab(tabFor[n] || 1); return true; } catch (e) {}
        }
        return false;
    }

    // =========================================================================
    // SECTION 7 — STEP ② FLOW PERIODS VIEW
    // =========================================================================

    var PERIOD_FILL = ['rgba(88,166,255,0.10)', 'rgba(63,185,80,0.10)', 'rgba(188,140,255,0.10)', 'rgba(210,153,34,0.10)'];

    function canvasWidth(host) {
        var w = (host && host.clientWidth) || 600;
        var vw = isNum(G.innerWidth) && G.innerWidth > 0 ? G.innerWidth - 32 : w;
        return Math.max(200, Math.min(w, vw, 1100));
    }

    function prepCanvas(canvas, w, h) {
        var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
        if (!ctx) return null;
        var dpr = G.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = '100%';
        canvas.style.maxWidth = w + 'px';
        canvas.style.height = h + 'px';
        if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    }

    function niceTicks(min, max, count) {
        var span = max - min;
        if (!(span > 0)) return [min];
        var step = Math.pow(10, Math.floor(Math.log10(span / count)));
        var err = span / count / step;
        if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
        var out = [];
        for (var v = Math.ceil(min / step) * step; v <= max + 1e-9 * span; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
        return out;
    }

    function tickLabel(v) {
        var a = Math.abs(v);
        if (a >= 1e4 || (a > 0 && a < 1e-2)) return v.toExponential(0).replace('e+', 'e');
        return String(+v.toPrecision(4));
    }

    // History plot: p (left axis) + q step (right axis) + period bands.
    // data follows the C6 cartesian contract: {t, p, q, periods:[{t0,t1,start,end,q}]}
    function drawHistory(canvas, data, sel, w, h) {
        var ds = data, periods = data.periods || [];
        var ctx = prepCanvas(canvas, w, h);
        if (!ctx) return null;
        var C = {
            bg: cssVar('--bg1', '#0d1117'), grid: cssVar('--border', '#30363d'), text: cssVar('--text2', '#8b949e'),
            p: cssVar('--accent', '#f0883e'), q: cssVar('--blue', '#58a6ff'), sel: 'rgba(240,136,62,0.22)'
        };
        var pad = { l: 52, r: 46, t: 12, b: 28 };
        var plot = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
        ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
        var t = ds.t, p = ds.p, q = isArr(ds.q) ? ds.q : null;
        var tmin = Infinity, tmax = -Infinity, pmin = Infinity, pmax = -Infinity, qmin = 0, qmax = -Infinity;
        for (var i = 0; i < t.length; i++) {
            if (!isNum(t[i])) continue;
            tmin = Math.min(tmin, t[i]); tmax = Math.max(tmax, t[i]);
            if (p && isNum(p[i])) { pmin = Math.min(pmin, p[i]); pmax = Math.max(pmax, p[i]); }
            if (q && isNum(q[i])) { qmin = Math.min(qmin, q[i]); qmax = Math.max(qmax, q[i]); }
        }
        periods.forEach(function (pr) { if (isNum(pr.t0)) tmin = Math.min(tmin, pr.t0); });
        if (!(tmax > tmin)) { tmax = tmin + 1; }
        if (!(pmax > pmin)) { pmax = (isNum(pmax) ? pmax : 1) + 1; pmin = pmax - 2; }
        var pp = 0.06 * (pmax - pmin); pmin -= pp; pmax += pp;
        if (!(qmax > qmin)) qmax = qmin + 1;
        var toX = function (v) { return plot.x + (v - tmin) / (tmax - tmin) * plot.w; };
        var fromX = function (px) { return tmin + (px - plot.x) / plot.w * (tmax - tmin); };
        var toY = function (v) { return plot.y + plot.h - (v - pmin) / (pmax - pmin) * plot.h; };
        var toYq = function (v) { return plot.y + plot.h - (v - qmin) / (qmax - qmin) * plot.h * 0.9; };
        // Period bands
        periods.forEach(function (pr, k) {
            var x0 = toX(pr.t0), x1 = toX(pr.t1);
            ctx.fillStyle = (sel === k) ? C.sel : PERIOD_FILL[k % PERIOD_FILL.length];
            ctx.fillRect(x0, plot.y, Math.max(1, x1 - x0), plot.h);
            if (x1 - x0 > 18) {
                ctx.fillStyle = C.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
                ctx.fillText('#' + (k + 1), x0 + 3, plot.y + 11);
            }
        });
        // Grid + ticks
        ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.font = '10px sans-serif'; ctx.fillStyle = C.text;
        ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
        ctx.textAlign = 'center';
        niceTicks(tmin, tmax, Math.max(3, Math.floor(plot.w / 80))).forEach(function (v) {
            var x = toX(v);
            ctx.beginPath(); ctx.moveTo(x, plot.y + plot.h); ctx.lineTo(x, plot.y + plot.h + 4); ctx.stroke();
            ctx.fillText(tickLabel(v), x, plot.y + plot.h + 15);
        });
        ctx.fillText('t (hr)', plot.x + plot.w / 2, h - 2);
        ctx.textAlign = 'right';
        niceTicks(pmin, pmax, 4).forEach(function (v) {
            var y = toY(v);
            ctx.beginPath(); ctx.moveTo(plot.x - 4, y); ctx.lineTo(plot.x, y); ctx.stroke();
            ctx.fillText(tickLabel(v), plot.x - 6, y + 3);
        });
        if (q && qmax > qmin) {
            ctx.textAlign = 'left'; ctx.fillStyle = C.q;
            niceTicks(qmin, qmax, 3).forEach(function (v) { ctx.fillText(tickLabel(v), plot.x + plot.w + 5, toYq(v) + 3); });
        }
        // Rate step line
        if (q) {
            ctx.save && ctx.save();
            ctx.strokeStyle = C.q; ctx.lineWidth = 1.5; ctx.beginPath();
            var started = false, lastY = null;
            for (var j = 0; j < t.length; j++) {
                if (!isNum(t[j]) || !isNum(q[j])) continue;
                var x = toX(t[j]), y = toYq(q[j]);
                if (!started) { ctx.moveTo(toX(Math.min(tmin, t[j])), y); started = true; }
                else if (lastY !== y) ctx.lineTo(x, lastY);
                ctx.lineTo(x, y); lastY = y;
            }
            ctx.stroke();
            ctx.restore && ctx.restore();
        }
        // Pressure line
        ctx.strokeStyle = C.p; ctx.lineWidth = 2; ctx.beginPath();
        var first = true;
        for (var k2 = 0; k2 < t.length; k2++) {
            if (!isNum(t[k2]) || !p || !isNum(p[k2])) continue;
            if (first) { ctx.moveTo(toX(t[k2]), toY(p[k2])); first = false; } else ctx.lineTo(toX(t[k2]), toY(p[k2]));
        }
        ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillStyle = C.p; ctx.fillText('p (psia)', plot.x + 4, plot.y + plot.h - 6);
        if (q) { ctx.fillStyle = C.q; ctx.textAlign = 'right'; ctx.fillText('q', plot.x + plot.w - 4, plot.y + plot.h - 6); }
        return { toX: toX, fromX: fromX, plot: plot, tmin: tmin, tmax: tmax };
    }

    // Log-log Δp / Δp′ thumbnail of the extracted period.
    function drawLogLog(canvas, ad, w, h) {
        var ctx = prepCanvas(canvas, w, h);
        if (!ctx) return;
        var C = {
            bg: cssVar('--bg1', '#0d1117'), grid: cssVar('--border', '#30363d'), text: cssVar('--text2', '#8b949e'),
            dp: cssVar('--accent', '#f0883e'), d: cssVar('--blue', '#58a6ff')
        };
        ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
        var pad = { l: 40, r: 10, t: 10, b: 24 };
        var plot = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
        ctx.font = '10px sans-serif';
        if (!ad || !ad.ok || !ad.t || !ad.t.length) {
            ctx.fillStyle = C.text; ctx.textAlign = 'center';
            ctx.fillText((ad && ad.reason) || 'No positive Δp in this period', w / 2, h / 2);
            return;
        }
        var t = ad.t, dp = ad.dp, dv = ad.deriv || [];
        var xs = [], ys = [];
        for (var i = 0; i < t.length; i++) {
            if (t[i] > 0) xs.push(t[i]);
            if (dp[i] > 0) ys.push(dp[i]);
            if (dv[i] > 0) ys.push(dv[i]);
        }
        if (!xs.length || !ys.length) return;
        var lx0 = Math.floor(Math.log10(Math.min.apply(null, xs))), lx1 = Math.ceil(Math.log10(Math.max.apply(null, xs)));
        var ly0 = Math.floor(Math.log10(Math.min.apply(null, ys))), ly1 = Math.ceil(Math.log10(Math.max.apply(null, ys)));
        if (lx1 === lx0) lx1++;
        if (ly1 === ly0) ly1++;
        var toX = function (v) { return plot.x + (Math.log10(v) - lx0) / (lx1 - lx0) * plot.w; };
        var toY = function (v) { return plot.y + plot.h - (Math.log10(v) - ly0) / (ly1 - ly0) * plot.h; };
        ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.text;
        ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
        ctx.textAlign = 'center';
        for (var a = lx0; a <= lx1; a++) {
            var x = toX(Math.pow(10, a));
            ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
            ctx.fillText(tickLabel(Math.pow(10, a)), x, plot.y + plot.h + 13);
        }
        ctx.textAlign = 'right';
        for (var b = ly0; b <= ly1; b++) {
            var y = toY(Math.pow(10, b));
            ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
            ctx.fillText(tickLabel(Math.pow(10, b)), plot.x - 4, y + 3);
        }
        function dots(arr, color) {
            ctx.fillStyle = color;
            for (var k = 0; k < t.length; k++) {
                if (!(t[k] > 0 && arr[k] > 0)) continue;
                ctx.beginPath();
                ctx.arc(toX(t[k]), toY(arr[k]), 2.2, 0, 2 * Math.PI);
                ctx.fill();
            }
        }
        dots(dp, C.dp);
        dots(dv, C.d);
        ctx.textAlign = 'left'; ctx.fillStyle = C.dp; ctx.fillText('Δp', plot.x + 4, plot.y + 11);
        ctx.fillStyle = C.d; ctx.fillText('Δp′', plot.x + 24, plot.y + 11);
        ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.fillText('Δt (hr)', plot.x + plot.w / 2, h - 2);
    }

    function selectPeriod(idx, host) {
        var s = st();
        var next = (idx == null || idx < 0) ? null : idx;
        if (s.activePeriod === next) return;
        s.activePeriod = next;
        saveState();
        dispatch('prism:period-changed', { period: next });
        redraw();
        if (host) PRiSM_renderFlowPeriods(host);
    }

    function wellFieldValue(w, key) {
        var pvt = G.PRiSM_pvt || {};
        var v = isNum(pvt[key]) ? pvt[key] : null;
        if (v == null && w && w.provenance && w.provenance[key] === 'user' && isNum(w[key])) v = w[key];
        return v;
    }

    function PRiSM_renderFlowPeriods(host) {
        host = host || $('prism_step2');   // never default to the whole workspace
        if (!host) return null;
        ensureStyle();
        var s = st();
        var ds = G.PRiSM_dataset;
        if (!ds || !isArr(ds.t) || !ds.t.length) {
            host.innerHTML = '<div class="prism-wf" id="prism_fp_root"><div class="prism-wf-card">' +
                '<div class="prism-wf-title">Flow periods</div>' +
                '<div class="prism-rail-line">No data loaded yet. Load a file or the demo data first.</div>' +
                '<div style="margin-top:10px;"><button type="button" class="prism-btn prism-btn--primary" id="prism_fp_goto_data">Go to step ① Data</button></div>' +
                '</div></div>';
            var gb = $('prism_fp_goto_data');
            if (gb) gb.onclick = function () { gotoStep(1); };
            return null;
        }
        var periods = getPeriods(ds);
        var sel = activePeriod();
        if (sel != null && !periods[sel]) sel = null;
        var well = getWell(ds);
        var ad = getAnalysisData(sel == null ? {} : { period: sel });
        s.periodFlags = (s.periodFlags && typeof s.periodFlags === 'object') ? s.periodFlags : {};
        var autoTShut = ad && ad.ok && isNum(ad.tShut) ? ad.tShut : null;
        var autoTp = ad && ad.ok && isNum(ad.tp) ? ad.tp : null;
        var tShutV = wellFieldValue(well, 'tShut'), tpV = wellFieldValue(well, 'tp');

        var rowsHtml = periods.map(function (pr, k) {
            var flags = s.periodFlags[k] || {};
            return '<tr data-period="' + k + '" class="' + (sel === k ? 'is-active' : '') + '">' +
                '<td><input type="radio" name="prism_fp_sel" id="prism_fp_sel_' + k + '" aria-label="Analyse period ' + (k + 1) + '"' + (sel === k ? ' checked' : '') + '></td>' +
                '<td>#' + (k + 1) + '</td>' +
                '<td>' + esc(pr.type) + '</td>' +
                '<td class="num">' + esc(fmt(pr.t0, 4)) + '</td>' +
                '<td class="num">' + esc(fmt(pr.t1, 4)) + '</td>' +
                '<td class="num">' + (isNum(pr.q) ? esc(fmt(pr.q, 4)) : '—') + '</td>' +
                '<td><input type="checkbox" id="prism_fp_ovl_' + k + '" aria-label="Overlay period ' + (k + 1) + '"' + (flags.overlay ? ' checked' : '') + '></td>' +
                '</tr>';
        }).join('');

        var adLine = ad && ad.ok
            ? fmt(ad.n) + ' points · Δt ' + fmt(ad.t[0], 2) + '–' + fmt(ad.t[ad.t.length - 1], 3) + ' h · ' +
              esc(ad.testType || '') + ' · p_ref ' + fmt(ad.pRef, 5) + ' psia (' + esc(ad.pRefSource || '?') + ')'
            : esc((ad && ad.reason) || 'Nothing to analyse in this period.');

        host.innerHTML =
            '<div class="prism-wf" id="prism_fp_root">' +
              '<div class="prism-wf-card">' +
                '<div class="prism-wf-title">Rate &amp; pressure history</div>' +
                '<canvas id="prism_fp_history" role="img" aria-label="Pressure and rate history with flow-period bands"></canvas>' +
                '<div class="prism-wf-hint">Tap a period band or a table row to choose the period to analyse.</div>' +
              '</div>' +
              '<div class="prism-wf-grid">' +
                '<div class="prism-wf-card">' +
                  '<div class="prism-wf-title">Flow periods (' + periods.length + ')</div>' +
                  '<div class="prism-fp-tablewrap"><table class="prism-fp-table" id="prism_fp_table">' +
                    '<thead><tr><th>Analyse</th><th>#</th><th>Type</th><th>Start (h)</th><th>End (h)</th><th>Rate</th><th>Overlay</th></tr></thead>' +
                    '<tbody>' + rowsHtml + '</tbody></table></div>' +
                  '<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:8px;">' +
                    '<button type="button" class="prism-btn prism-btn--small" id="prism_fp_all"' + (sel == null ? ' disabled' : '') + '>Use all data</button>' +
                    '<button type="button" class="prism-btn prism-btn--small" id="prism_fp_crop">Crop data…</button>' +
                  '</div>' +
                '</div>' +
                '<div class="prism-wf-card">' +
                  '<div class="prism-wf-title">Shut-in &amp; producing time</div>' +
                  '<div class="prism-fp-inputs">' +
                    '<label for="prism_fp_tshut">Shut-in time (h)<input type="number" inputmode="decimal" step="any" id="prism_fp_tshut" value="' + (isNum(tShutV) ? tShutV : '') + '" placeholder="' + (isNum(autoTShut) ? 'auto: ' + fmt(autoTShut, 4) : 'auto') + '"></label>' +
                    '<label for="prism_fp_tp">Producing time t_p (h)<input type="number" inputmode="decimal" step="any" id="prism_fp_tp" value="' + (isNum(tpV) ? tpV : '') + '" placeholder="' + (isNum(autoTp) ? 'auto: ' + fmt(autoTp, 4) : 'auto') + '"></label>' +
                  '</div>' +
                  '<div class="prism-wf-hint">Leave blank to use the values derived from the rate history.</div>' +
                  '<div class="prism-wf-title" style="margin-top:12px;">Log-log preview</div>' +
                  '<canvas id="prism_fp_preview" role="img" aria-label="Log-log preview of the selected period"></canvas>' +
                  '<div class="prism-wf-hint" id="prism_fp_preview_info">' + adLine + '</div>' +
                '</div>' +
              '</div>' +
            '</div>';

        // Plots
        var hc = $('prism_fp_history');
        var W = canvasWidth(host);
        var tr = null;
        if (hc) {
            var c6 = { t: ds.t, p: ds.p, q: isArr(ds.q) ? ds.q : null, periods: periods };
            try { tr = drawHistory(hc, c6, sel, W, 220); } catch (e) { tr = null; }
            if (tr) hc._prismAxes = { toX: tr.toX, fromX: tr.fromX, plot: tr.plot, scaleX: { min: tr.tmin, max: tr.tmax, kind: 'lin' }, plotKey: 'history' };
            hc.addEventListener('click', function (ev) {
                if (!tr || !ev || !isNum(ev.clientX)) return;
                var rect = hc.getBoundingClientRect ? hc.getBoundingClientRect() : { left: 0, width: W };
                var scale = rect.width > 0 ? (W / rect.width) : 1;
                var tt = tr.fromX((ev.clientX - rect.left) * scale);
                for (var k = 0; k < periods.length; k++) {
                    if (tt >= periods[k].t0 && tt <= periods[k].t1) { selectPeriod(k, host); return; }
                }
            });
        }
        var pc = $('prism_fp_preview');
        if (pc) { try { drawLogLog(pc, ad, Math.min(W, 520), 180); } catch (e) {} }

        // Table
        var tbody = q1(host, '#prism_fp_table tbody');
        var trs = tbody && tbody.querySelectorAll ? tbody.querySelectorAll('tr[data-period]') : [];
        for (var i = 0; i < trs.length; i++) {
            (function (row) {
                var k = parseInt(row.getAttribute('data-period'), 10);
                row.onclick = function () { selectPeriod(k, host); };
                var ov = $('prism_fp_ovl_' + k);
                if (ov) {
                    ov.onclick = function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); };
                    ov.onchange = function () {
                        var f = s.periodFlags[k] || {};
                        f.overlay = !!ov.checked;
                        s.periodFlags[k] = f;
                        saveState();
                        dispatch('prism:period-flags-changed', { period: k, flags: clone(f) });
                    };
                }
                var rb = $('prism_fp_sel_' + k);
                if (rb) rb.onchange = function () { if (rb.checked) selectPeriod(k, host); };
            })(trs[i]);
        }
        var all = $('prism_fp_all');
        if (all) all.onclick = function () { selectPeriod(null, host); };
        var crop = $('prism_fp_crop');
        if (crop) crop.onclick = function () { PRiSM_openTools('crop'); };

        function bindTime(id, key) {
            var inp = $(id);
            if (!inp) return;
            inp.onchange = function () {
                var raw = String(inp.value == null ? '' : inp.value).trim();
                var v = raw === '' ? null : parseFloat(raw);
                if (v != null && !(isNum(v) && v >= 0)) return;
                var patch = {}; patch[key] = v;
                setWell(patch, 'user');
                PRiSM_renderFlowPeriods(host);
            };
        }
        bindTime('prism_fp_tshut', 'tShut');
        bindTime('prism_fp_tp', 'tp');
        return { periods: periods, selected: sel, analysis: ad };
    }

    // =========================================================================
    // SECTION 8 — TOOLS DRAWER (every advanced panel reachable)
    // =========================================================================

    var TOOL_CATALOGUE = [
        { id: 'pvt',         fn: 'PRiSM_renderPVTPanel',            group: 'Data',     title: 'Well & fluid properties',          sub: 'PVT correlations and dimensional inputs' },
        { id: 'cleanup',     fn: 'PRiSM_renderCleanupPanel',        group: 'Data',     title: 'Data cleanup',                     sub: 'Filters, outliers and resampling' },
        { id: 'crop',        fn: 'PRiSM_renderCropTool',            group: 'Data',     title: 'Crop data',                        sub: 'Trim the record interactively' },
        { id: 'tide',        fn: 'PRiSM_renderTidePanel',           group: 'Data',     title: 'Tide correction',                  sub: 'Remove tidal signal from offshore gauges' },
        { id: 'gauges',      fn: 'PRiSM_renderGaugeManager',        group: 'Data',     title: 'Gauges',                           sub: 'Manage gauge channels' },
        { id: 'datasets',    fn: 'PRiSM_renderAnalysisManager',     group: 'Data',     title: 'Analysis datasets',                sub: 'Switch between saved analysis sets' },
        { id: 'project',     fn: 'PRiSM_renderProjectToolbar',      group: 'Data',     title: 'Project files',                    sub: 'Open or save a .prism project' },
        { id: 'semilog',     fn: 'PRiSM_renderSemilogPanel',        group: 'Diagnose', title: 'Semilog & skin analysis',          sub: 'Straight-line k, skin, p*, FE' },
        { id: 'annotations', fn: 'PRiSM_renderAnnotationToolbar',   group: 'Diagnose', title: 'Flow-regime markers',              sub: 'Auto-detected regimes and smoothing' },
        { id: 'keys',        fn: 'PRiSM_renderAnalysisKeyToolbar',  group: 'Diagnose', title: 'Pick on plot',                     sub: 'Click the plot to estimate kh, xf, distances', args: function () { return [st().activePlot || 'bourdet']; } },
        { id: 'deconv',      fn: 'PRiSM_renderDeconvolutionPanel',  group: 'Diagnose', title: 'Combine periods (deconvolution)',  sub: 'Constant-rate response from multi-rate data' },
        { id: 'overlays',    fn: 'PRiSM_renderOverlayManager',      group: 'Plot',     title: 'Plot overlays',                    sub: 'Compare datasets and periods on one plot' },
        { id: 'diff',        fn: 'PRiSM_renderDiffPicker',          group: 'Plot',     title: 'Difference plot',                  sub: 'Subtract two datasets' },
        { id: 'clipboard',   fn: 'PRiSM_renderClipboardToolbar',    group: 'Plot',     title: 'Copy & export',                    sub: 'Clipboard, CSV and XML export' },
        { id: 'automatch',   fn: 'PRiSM_renderAutoMatchPanel',      group: 'Model',    title: 'Model race',                       sub: 'Rank candidate models by AIC' },
        { id: 'usercurves',  fn: 'PRiSM_renderUserCurveManager',    group: 'Model',    title: 'User-defined type curves',         sub: 'Import your own pD / pD′ curves' },
        { id: 'interp',      fn: 'PRiSM_renderInterpretationPanel', group: 'Model',    title: 'Interpretation',                   sub: 'Plain-language narrative of the fit', args: function () { return [st().interp || undefined]; } },
        { id: 'plt',         fn: 'PRiSM_renderPLTPanel',            group: 'Model',    title: 'Layer contributions',              sub: 'Synthetic production log by layer' },
        { id: 'inverse',     fn: 'PRiSM_renderInverseSimPanel',     group: 'Model',    title: 'Rate from pressure',               sub: 'Invert the rate history from gauge pressure' },
        { id: 'decline',     fn: 'PRiSM_renderDeclineResultsPanel', group: 'Model',    title: 'Decline results & EUR',            sub: 'Forecast, EUR and P10/P50/P90' }
    ];
    // Words that identify a C7 tab panel as one of the catalogue tools (no duplicates in the drawer).
    var PANEL_SYNONYMS = [
        ['deconv', 'deconv'], ['semilog', 'semilog'], ['straight-line', 'semilog'], ['straight line', 'semilog'],
        ['tide', 'tide'], ['interpret', 'interp'], ['crop', 'crop'], ['gauge', 'gauges'], ['overlay', 'overlays'],
        ['auto-match', 'automatch'], ['automatch', 'automatch'], ['model race', 'automatch'], ['plt', 'plt'],
        ['inverse', 'inverse'], ['decline', 'decline'], ['annotation', 'annotations'], ['regime', 'annotations'],
        ['analysis key', 'keys'], ['pick on plot', 'keys'], ['clipboard', 'clipboard'], ['cleanup', 'cleanup'],
        ['user curve', 'usercurves'], ['user-defined', 'usercurves'], ['pvt', 'pvt']
    ];
    var EXCLUDE_DISCOVERY = /^PRiSM_render(Rail|FlowPeriods|DataTabEnhanced|Tab[A-Za-z]*|[A-Za-z]*Tab)$/;

    function humanise(fn) {
        var s = String(fn).replace(/^PRiSM_render/, '').replace(/(Panel|Manager|Toolbar|Tool|Picker)$/, function (m) { return ' ' + m; });
        s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function listTools() {
        var out = [], seen = {};
        TOOL_CATALOGUE.forEach(function (t) {
            seen[t.fn] = true;
            out.push({ id: t.id, title: t.title, sub: t.sub, group: t.group, fn: t.fn, args: t.args, available: typeof G[t.fn] === 'function' });
        });
        // Discover any other exported panel renderer so nothing is orphaned.
        var keys = [];
        try { for (var k in G) keys.push(k); } catch (e) {}
        try { Object.getOwnPropertyNames(G).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); }); } catch (e) {}
        keys.sort().forEach(function (k) {
            if (seen[k]) return;
            if (!/^PRiSM_render[A-Za-z0-9_]*(Panel|Manager|Toolbar|Tool|Picker)$/.test(k)) return;
            if (EXCLUDE_DISCOVERY.test(k)) return;
            var f;
            try { f = G[k]; } catch (e) { f = null; }
            if (typeof f !== 'function') return;
            seen[k] = true;
            out.push({ id: 'fn:' + k, title: humanise(k), sub: '', group: 'More', fn: k, available: true });
        });
        // C7 panels registered on the step tabs.
        var reg = G.PRiSM_tabPanels;
        if (reg && typeof reg === 'object') {
            var titles = {};
            out.forEach(function (t) { titles[String(t.title).toLowerCase()] = true; });
            Object.keys(reg).forEach(function (n) {
                var arr = reg[n];
                if (!isArr(arr)) return;
                toArr(arr).forEach(function (spec) {
                    if (!spec || typeof spec.render !== 'function') return;
                    var title = String(spec.title || spec.id || 'Panel');
                    var hay = (String(spec.id || '') + ' ' + title).toLowerCase();
                    var dup = titles[title.toLowerCase()] || out.some(function (t) { return typeof G[t.fn] === 'function' && G[t.fn] === spec.render; }) ||
                        PANEL_SYNONYMS.some(function (sy) {
                            if (hay.indexOf(sy[0]) === -1) return false;
                            return out.some(function (t) { return t.id === sy[1] && t.available; });
                        });
                    if (dup) return;
                    titles[title.toLowerCase()] = true;
                    out.push({ id: 'tab' + n + ':' + (spec.id || title), title: title, sub: 'Also shown on tab ' + n, group: 'Step panels', render: spec.render, available: true });
                });
            });
        }
        return out;
    }

    function closeTools() {
        var d = $('prism_tools_drawer'), b = $('prism_tools_backdrop');
        if (d && d.parentNode) d.parentNode.removeChild(d);
        if (b && b.parentNode) b.parentNode.removeChild(b);
        var btn = $('prism_tools_btn');
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
        dispatch('prism:tools-closed', {});
    }

    function openToolIn(item, host, titleEl) {
        host.innerHTML = '';
        if (titleEl) titleEl.textContent = item.title;
        var inner = D.createElement('div');
        inner.id = 'prism_tools_panel';
        inner.className = 'prism-tools-panel';
        host.appendChild(inner);
        try {
            if (item.render) item.render(inner);
            else {
                var f = G[item.fn];
                if (typeof f !== 'function') throw new Error('This tool is not loaded in this build.');
                var args = [inner].concat(item.args ? item.args() : []);
                f.apply(G, args);
            }
            if (!inner.innerHTML || !String(inner.innerHTML).trim()) {
                inner.innerHTML = '<div class="prism-rail-line">Nothing to show yet — load data first.</div>';
            }
        } catch (e) {
            inner.innerHTML = '<div class="prism-rail-warn prism-rail-warn--bad"><span>' + esc(item.title) + ' could not open: ' + esc(e && e.message) + '</span></div>';
        }
        dispatch('prism:tool-opened', { id: item.id });
    }

    function PRiSM_openTools(toolId) {
        if (!D || !D.createElement || !D.body) return null;
        ensureStyle();
        closeTools();
        var tools = listTools().filter(function (t) { return t.available; });
        var back = D.createElement('div');
        back.id = 'prism_tools_backdrop';
        back.className = 'prism-drawer-backdrop';
        back.onclick = closeTools;
        var dr = D.createElement('div');
        dr.id = 'prism_tools_drawer';
        dr.className = 'prism-drawer';
        dr.setAttribute('role', 'dialog');
        dr.setAttribute('aria-modal', 'true');
        dr.setAttribute('aria-labelledby', 'prism_tools_title');
        var groups = [], byGroup = {};
        tools.forEach(function (t) {
            if (!byGroup[t.group]) { byGroup[t.group] = []; groups.push(t.group); }
            byGroup[t.group].push(t);
        });
        var list = groups.map(function (g) {
            return '<div class="prism-tool-group">' + esc(g) + '</div>' + byGroup[g].map(function (t) {
                return '<button type="button" class="prism-tool-item" data-tool="' + esc(t.id) + '">' + esc(t.title) +
                    (t.sub ? '<small>' + esc(t.sub) + '</small>' : '') + '</button>';
            }).join('');
        }).join('');
        dr.innerHTML =
            '<div class="prism-drawer-head">' +
              '<button type="button" class="prism-btn prism-btn--small" id="prism_tools_back" style="display:none;" aria-label="Back to the tool list">‹ Tools</button>' +
              '<h3 id="prism_tools_title">Tools</h3>' +
              '<button type="button" class="prism-btn prism-btn--small" id="prism_tools_close" aria-label="Close tools">✕</button>' +
            '</div>' +
            '<div class="prism-drawer-body">' +
              '<div id="prism_tools_listwrap">' +
                '<input type="search" class="prism-drawer-search" id="prism_tools_search" placeholder="Find a tool…" aria-label="Find a tool">' +
                '<div id="prism_tools_list">' + (list || '<div class="prism-rail-line">No advanced tools are loaded.</div>') + '</div>' +
              '</div>' +
              '<div id="prism_tools_host" style="display:none;"></div>' +
            '</div>';
        D.body.appendChild(back);
        D.body.appendChild(dr);
        var btn = $('prism_tools_btn');
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'true');

        var host = $('prism_tools_host'), listWrap = $('prism_tools_listwrap');
        var titleEl = $('prism_tools_title'), backBtn = $('prism_tools_back');
        function showList() {
            host.innerHTML = '';
            host.style.display = 'none';
            listWrap.style.display = '';
            backBtn.style.display = 'none';
            titleEl.textContent = 'Tools';
        }
        function showTool(id) {
            var item = null;
            for (var i = 0; i < tools.length; i++) if (tools[i].id === id) item = tools[i];
            if (!item) return false;
            listWrap.style.display = 'none';
            host.style.display = '';
            backBtn.style.display = '';
            openToolIn(item, host, titleEl);
            return true;
        }
        $('prism_tools_close').onclick = closeTools;
        backBtn.onclick = showList;
        var items = dr.querySelectorAll('[data-tool]');
        for (var i = 0; i < items.length; i++) {
            (function (b) { b.onclick = function () { showTool(b.getAttribute('data-tool')); }; })(items[i]);
        }
        var search = $('prism_tools_search');
        if (search) {
            search.oninput = function () {
                var qv = String(search.value || '').toLowerCase().trim();
                for (var j = 0; j < items.length; j++) {
                    var txt = String(items[j].textContent || '').toLowerCase();
                    items[j].style.display = (!qv || txt.indexOf(qv) !== -1) ? '' : 'none';
                }
            };
        }
        dr.onkeydown = function (ev) { if (ev && ev.key === 'Escape') closeTools(); };
        if (toolId) showTool(toolId);
        dispatch('prism:tools-opened', { tool: toolId || null });
        return dr;
    }

    // =========================================================================
    // SECTION 9 — UNDO / REDO (state snapshots, cap 50)
    // =========================================================================

    var UNDO_CAP = 50;
    var _undo = [], _redo = [], _cur = null, _restoring = false, _batch = 0;

    function snapObject() {
        var s = st(), pvt = G.PRiSM_pvt, well = null;
        if (pvt && typeof pvt === 'object') {
            well = {};
            for (var k in pvt) if (k !== '_computed' && Object.prototype.hasOwnProperty.call(pvt, k)) well[k] = pvt[k];
        }
        return {
            model: s.model == null ? null : s.model,
            params: s.params || {},
            paramFreeze: s.paramFreeze || {},
            phys: s.phys || null,
            lastFit: s.lastFit || null,
            tcMatch: s.tcMatch || null,
            activePeriod: activePeriod(),
            well: well,
            // Multi-rate table (rate history): seeded from the events log (39).
            multiRate: (G.PRiSM && Array.isArray(G.PRiSM.multiRate)) ? G.PRiSM.multiRate : []
        };
    }
    function snapString() {
        try { return JSON.stringify(snapObject()); } catch (e) { return null; }
    }

    function syncUndoButtons() {
        var u = $('prism_undo'), r = $('prism_redo');
        if (u) { u.disabled = !_undo.length; u.title = _undo.length ? 'Undo (' + _undo.length + ')' : 'Nothing to undo'; }
        if (r) { r.disabled = !_redo.length; r.title = _redo.length ? 'Redo (' + _redo.length + ')' : 'Nothing to redo'; }
    }

    function recordSnapshot(reason) {
        if (_restoring || _batch > 0) return false;
        var s = snapString();
        if (s == null || s === _cur) return false;
        if (_cur != null) {
            _undo.push(_cur);
            if (_undo.length > UNDO_CAP) _undo.shift();
        }
        _redo.length = 0;
        _cur = s;
        syncUndoButtons();
        return true;
    }

    function restoreSnapshot(str) {
        var o;
        try { o = JSON.parse(str); } catch (e) { return false; }
        var s = st();
        _restoring = true;
        try {
            if (o.model != null && s.model !== o.model) s.model = o.model;   // plain assignment keeps the snapshot params
            s.params = o.params || {};
            s.paramFreeze = o.paramFreeze || {};
            s.phys = o.phys || null;
            s.lastFit = o.lastFit || null;
            s.tcMatch = o.tcMatch || null;
            s.activePeriod = o.activePeriod == null ? null : o.activePeriod;
            s.modelCurve = null;
            if (isArr(o.multiRate)) {
                if (!G.PRiSM || typeof G.PRiSM !== 'object') G.PRiSM = { mode: 'transient', tab: 1, multiRate: [] };
                G.PRiSM.multiRate = clone(o.multiRate) || [];
                try { if (G.localStorage) G.localStorage.setItem('wts_prism_mrate', JSON.stringify(G.PRiSM.multiRate)); } catch (e) {}
                try { if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows(); } catch (e) {}   // eslint-disable-line no-undef
            }
            if (o.well && typeof o.well === 'object') {
                var pvt = G.PRiSM_pvt || (G.PRiSM_pvt = {});
                Object.keys(pvt).forEach(function (k) { if (k !== '_computed' && !(k in o.well)) delete pvt[k]; });
                Object.keys(o.well).forEach(function (k) { pvt[k] = o.well[k]; });
                if (typeof G.PRiSM_pvt_compute === 'function') { try { G.PRiSM_pvt_compute(); } catch (e) {} }
                persistPvt();
            }
            if (s.lastFit && typeof G.PRiSM_interpretCurrentFit === 'function') {
                try { s.interp = G.PRiSM_interpretCurrentFit() || null; } catch (e) {}
            } else if (!s.lastFit) s.interp = null;
            if (typeof G.PRiSM_evalModelCurve === 'function') { try { G.PRiSM_evalModelCurve(s.model, s.params); } catch (e) {} }
            saveState();
            dispatch('prism:model-changed', { source: 'undo', modelKey: s.model });
            dispatch('prism:well-changed', { source: 'undo' });
            dispatch('prism:period-changed', { source: 'undo', period: s.activePeriod });
            dispatch('prism:fit-updated', { source: 'undo' });
        } finally {
            _restoring = false;
        }
        redraw();
        // Re-render the visible tab so its inputs show the restored values.
        try {
            var tab = G.PRiSM && G.PRiSM.tab;
            var rt = (typeof PRiSM_renderTab === 'function') ? PRiSM_renderTab : G.PRiSM_renderTab;   // eslint-disable-line no-undef
            if (tab && typeof rt === 'function' && $('prism_tab_' + tab)) rt(tab);
        } catch (e) {}
        renderRailIfMounted();
        syncUndoButtons();
        return true;
    }

    function PRiSM_undo() {
        if (!_undo.length) return false;
        var prev = _undo.pop();
        if (_cur != null) _redo.push(_cur);
        _cur = prev;
        return restoreSnapshot(prev);
    }

    function PRiSM_redo() {
        if (!_redo.length) return false;
        var nxt = _redo.pop();
        if (_cur != null) { _undo.push(_cur); if (_undo.length > UNDO_CAP) _undo.shift(); }
        _cur = nxt;
        return restoreSnapshot(nxt);
    }

    function isEditable(el) {
        if (!el) return false;
        var tag = String(el.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
    }

    function installListeners() {
        if (typeof G.addEventListener !== 'function' || G.__PRiSM_wfListeners) return;
        G.__PRiSM_wfListeners = true;
        ['prism:fit-updated', 'prism:model-changed', 'prism:well-changed', 'prism:period-changed'].forEach(function (type) {
            G.addEventListener(type, function (ev) {
                var src = ev && ev.detail && ev.detail.source;
                if (src === 'undo') return;
                recordSnapshot(type);
            });
        });
        // A new fit (type-curve Apply, regression), dataset or project makes the
        // Analyse panel's summary stale: close it (no-op while a run is going).
        ['prism:fit-updated', 'prism:dataset-loaded', 'prism:dataset-cleared'].forEach(function (type) {
            G.addEventListener(type, function () { hideProgress(); });
        });
        // The race ranking (rail ΔAIC line) belongs to the data it was run on.
        ['prism:dataset-loaded', 'prism:dataset-cleared', 'prism:period-changed'].forEach(function (type) {
            G.addEventListener(type, function () { _lastCandidates = []; _lastCandidatesHash = null; });
        });
        if (D && typeof D.addEventListener === 'function') {
            // Bottom sheet: Escape or a tap outside it collapses the expanded sheet.
            D.addEventListener('keydown', function (ev) {
                if (ev && (ev.key === 'Escape' || ev.key === 'Esc') && _sheetExpanded) {
                    var r = $('prism_rail');
                    if (r && r.classList && r.classList.contains('prism-rail--sheet') && collapseSheet() && ev.preventDefault) ev.preventDefault();
                }
            });
            D.addEventListener('click', function (ev) {
                if (!_sheetExpanded) return;
                var wrap = $('prism_railwrap') || $('prism_rail');
                var r = $('prism_rail');
                if (!wrap || !r || !r.classList || !r.classList.contains('prism-rail--sheet')) return;
                var t = ev && ev.target;
                if (t && typeof wrap.contains === 'function' && !wrap.contains(t) && (!D.body || D.body.contains(t))) collapseSheet();
            }, true);
            if (typeof G.addEventListener === 'function') {
                G.addEventListener('resize', function () {
                    var r = $('prism_rail');
                    if (_sheetExpanded && r && r.classList && r.classList.contains('prism-rail--sheet')) fitSheet(r);
                });
            }
            D.addEventListener('keydown', function (ev) {
                if (!ev || !(ev.ctrlKey || ev.metaKey) || isEditable(ev.target)) return;
                if (!$('prism_steps') && !$('prism_tabs')) return;   // only while PRiSM is on screen
                var k = String(ev.key || '').toLowerCase();
                var did = false;
                if (k === 'z' && !ev.shiftKey) did = PRiSM_undo();
                else if (k === 'y' || (k === 'z' && ev.shiftKey)) did = PRiSM_redo();
                if (did && ev.preventDefault) ev.preventDefault();
            });
        }
    }

    // =========================================================================
    // SECTION 10 — EXPORTS
    // =========================================================================

    G.PRiSM_renderRail = PRiSM_renderRail;
    G.PRiSM_railInfo = railInfo;
    G.PRiSM_analyse = PRiSM_analyse;
    G.PRiSM_renderFlowPeriods = PRiSM_renderFlowPeriods;
    G.PRiSM_stepViews = G.PRiSM_stepViews || {};
    G.PRiSM_stepViews[2] = PRiSM_renderFlowPeriods;
    G.PRiSM_openTools = PRiSM_openTools;
    G.PRiSM_closeTools = closeTools;
    G.PRiSM_listTools = listTools;
    G.PRiSM_undo = PRiSM_undo;
    G.PRiSM_redo = PRiSM_redo;
    G.PRiSM_canUndo = function () { return _undo.length > 0; };
    G.PRiSM_canRedo = function () { return _redo.length > 0; };
    G.PRiSM_recordSnapshot = recordSnapshot;
    G.PRiSM_getReportPins = function () { return clone(isArr(st().reportPins) ? st().reportPins : []); };
    // Internal helpers, exposed for tests and for other layers' fallbacks.
    G.PRiSM_workflow = {
        getWell: getWell, getAnalysisData: getAnalysisData, getPeriods: getPeriods,
        localFit: localFit, lm: lm, fmt: fmt, snapshot: snapObject,
        undoDepth: function () { return { undo: _undo.length, redo: _redo.length }; },
        _resetHistory: function () { _undo.length = 0; _redo.length = 0; _cur = snapString(); syncUndoButtons(); }
    };

    installListeners();
    _cur = snapString();   // baseline for the first undo step

})();

// ─── END 37-prism-workflow ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 39-prism-fieldtools ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM — 39-prism-fieldtools.js  (Round 8)
// -----------------------------------------------------------------------------
// Field-data tools for the analysis workflow (ROADMAP §2.1 R12, R13, R15):
//
//   R12 Gauge register — serial, type, range, resolution, accuracy,
//       calibration date and depth per gauge. The primary gauge's resolution
//       is checked against the expected semilog slope (current fit, semilog
//       analysis or physical model) and against the data: derivative points
//       whose differentiation window changes by less than one resolution
//       step are flagged on the log-log diagnostic plot (post-draw hook).
//   R13 Sequence-of-events log — tool open/close, choke and rate changes,
//       sampling, gauge runs, notes, with times on the dataset clock (hours)
//       or wall-clock times converted with the log's clock zero. Events are
//       drawn as markers on the history, log-log and MDH plots, and can seed
//       the multi-rate table (the C2 rate history / flow periods), undoable
//       through the workflow undo stack. Host pages and the simulator append
//       events with window.PRiSM_addEvent(evt).
//   R15 Total-compressibility builder — ct = So·co + Sw·cw + Sg·cg + cf with
//       co / cw / cg from the 16-pvt correlation library and cf from a rock
//       correlation; writes ct through PRiSM_setWell({ct}, {source:
//       'correlation'}) and reports which inputs were defaults.
//
// PUBLIC API (window.*)
//   PRiSM_listGauges() / PRiSM_setGauge(g) / PRiSM_removeGauge(id)
//   PRiSM_setPrimaryGauge(id) / PRiSM_primaryGauge()
//   PRiSM_gaugeResolutionCheck(opts?)        → check result (see below)
//   PRiSM_gaugeSamplingLimit(m, dtSample, resolution) → Δt (h)
//   PRiSM_addEvent(evt) / PRiSM_listEvents() / PRiSM_removeEvent(id)
//   PRiSM_clearEvents() / PRiSM_setEventClock(time)
//   PRiSM_eventsToRateSchedule(events?)      → {ok, rows:[{t,q}], warnings}
//   PRiSM_seedPeriodsFromEvents(opts?)       → writes PRiSM.multiRate (undoable)
//   PRiSM_rockCompressibility(phi, method)   → cf (1/psi)
//   PRiSM_ctBuild(input?) / PRiSM_ctApply(result?)
//   PRiSM_renderGaugeRegister(host) / PRiSM_renderEventsLog(host)
//   PRiSM_renderCtBuilder(host) / PRiSM_renderGaugeCheckPanel(host)
//
// STATE — PRiSM_state.fieldTools {gauges[], primaryGauge, events[], clockZero,
//   ctBuild}; saved by PRiSM_saveState (C8) and carried in project files by
//   the 'prism' module. Events fired: prism:gauges-changed,
//   prism:events-changed, prism:period-changed {source:'events'} (seeding).
//
// UNITS — field units: t hours, p psia, resolution / accuracy / range psi,
//   depth ft, q STB/d (oil, water) or Mscf/d (gas), compressibility 1/psi.
//
// CONVENTIONS — single outer IIFE, window.PRiSM_* names, no timers, no
//   polling, no function wrapping; every cross-module call is typeof-guarded.
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var D = G.document || null;
    var LN10 = Math.log(10);

    // =========================================================================
    // SECTION 1 — HELPERS
    // =========================================================================

    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function isPos(v) { return isNum(v) && v > 0; }
    function isArr(a) { return !!a && typeof a !== 'string' && typeof a.length === 'number'; }
    function num(v) {
        if (v === null || v === undefined || v === '') return null;
        var x = (typeof v === 'number') ? v : parseFloat(v);
        return isNum(x) ? x : null;
    }
    function str(v, max) {
        if (v == null) return '';
        var s = String(v).replace(/[\u0000-\u001f]+/g, ' ').trim();
        return s.length > (max || 200) ? s.slice(0, max || 200) : s;
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function clone(v) {
        if (v == null) return v;
        try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
    }
    function median(a) {
        var b = [];
        for (var i = 0; i < a.length; i++) if (isNum(a[i])) b.push(a[i]);
        if (!b.length) return NaN;
        b.sort(function (x, y) { return x - y; });
        var m = b.length >> 1;
        return (b.length % 2) ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }
    function fmt(v, sig) {
        if (!isNum(v)) return '—';
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e6 || a < 1e-3) return v.toExponential((sig || 3) - 1);
        return String(+v.toPrecision(sig || 4));
    }
    function $(id) { try { return D && D.getElementById ? D.getElementById(id) : null; } catch (e) { return null; } }
    function now() { try { return Date.now(); } catch (e) { return 0; } }

    function dispatch(type, detail) {
        if (typeof G.dispatchEvent !== 'function') return;
        try {
            var CE = G.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
            if (CE) G.dispatchEvent(new CE(type, { detail: detail || {} }));
        } catch (e) { /* a listener threw — never break the caller */ }
    }
    function on(type, fn) {
        try { if (typeof G.addEventListener === 'function') G.addEventListener(type, fn); } catch (e) { /* stub */ }
    }

    function st() {
        if (!G.PRiSM_state || typeof G.PRiSM_state !== 'object') G.PRiSM_state = {};
        return G.PRiSM_state;
    }
    // Field-tools store inside the analysis state (C8: saved by PRiSM_saveState).
    function ft() {
        var s = st();
        var f = s.fieldTools;
        if (!f || typeof f !== 'object') f = s.fieldTools = {};
        if (!Array.isArray(f.gauges)) f.gauges = [];
        if (!Array.isArray(f.events)) f.events = [];
        if (f.primaryGauge === undefined) f.primaryGauge = null;
        if (f.clockZero === undefined) f.clockZero = null;
        return f;
    }
    function save() {
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* storage optional */ } }
    }
    function redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }
    function newId(prefix, list) {
        var n = list.length + 1, id;
        do { id = prefix + n; n++; } while (list.some(function (x) { return x && x.id === id; }));
        return id;
    }

    // Wall-clock parser: ms epoch, Date, or an ISO-like string. A string with no
    // zone is read as UTC so the log's clock zero and event times always use
    // the same convention (only differences matter).
    function parseClock(v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number') return isNum(v) ? v : null;
        if (v instanceof Date) { var d = v.getTime(); return isNum(d) ? d : null; }
        var s = String(v).trim();
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
        else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = s + 'T00:00:00Z';
        var ms = Date.parse(s);
        return isNum(ms) ? ms : null;
    }
    function clockText(ms) {
        if (!isNum(ms)) return '';
        try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); } catch (e) { return ''; }
    }
    function validDate(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        var ms = Date.parse(s + 'T00:00:00Z');
        return isNum(ms) && new Date(ms).toISOString().slice(0, 10) === s;
    }

    // Analysis data (C2) for the analysed period.
    function analysisData(opts) {
        opts = opts || {};
        if (typeof G.PRiSM_getAnalysisData !== 'function') return { ok: false, reason: 'Analysis data layer not loaded.' };
        var s = st();
        var o = {};
        if (isNum(opts.L)) o.L = opts.L; else if (isNum(s.bourdetL)) o.L = s.bourdetL;
        if (opts.period != null) o.period = opts.period;
        else if (isNum(s.activePeriod) && s.activePeriod >= 0) o.period = s.activePeriod;
        if (opts.timeFn) o.timeFn = opts.timeFn; else if (s.timeFn) o.timeFn = s.timeFn;
        try { return G.PRiSM_getAnalysisData(G.PRiSM_dataset, o) || { ok: false, reason: 'No analysis data.' }; }
        catch (e) { return { ok: false, reason: 'Analysis data: ' + (e && e.message) }; }
    }

    // =========================================================================
    // SECTION 2 — R12 GAUGE REGISTER
    // =========================================================================

    var GAUGE_TYPES = { quartz: 'Quartz', sapphire: 'Sapphire', strain: 'Strain gauge', piezo: 'Piezo-resistive', other: 'Other' };

    // Normalises a gauge record. Returns {gauge, errors[]}.
    function normGauge(g, prev) {
        var errors = [];
        g = g || {};
        var out = prev ? clone(prev) : {};
        function setNum(key, min, label, strictPos) {
            if (!Object.prototype.hasOwnProperty.call(g, key)) return;
            var v = num(g[key]);
            if (g[key] === null || g[key] === '') { out[key] = null; return; }
            if (v == null || v < min || (strictPos && v <= 0)) { errors.push(label + ' must be ' + (strictPos ? '> ' : '≥ ') + min + '.'); return; }
            out[key] = v;
        }
        if (Object.prototype.hasOwnProperty.call(g, 'serial')) out.serial = str(g.serial, 60);
        if (Object.prototype.hasOwnProperty.call(g, 'type')) out.type = GAUGE_TYPES[g.type] ? g.type : 'other';
        setNum('range', 0, 'Range (psi)', true);
        setNum('resolution', 0, 'Resolution (psi)', true);
        setNum('accuracy', 0, 'Accuracy (psi)', false);
        setNum('depth', 0, 'Depth (ft)', false);
        if (Object.prototype.hasOwnProperty.call(g, 'calDate')) {
            var cd = str(g.calDate, 10);
            if (cd === '') out.calDate = null;
            else if (validDate(cd)) out.calDate = cd;
            else errors.push('Calibration date must be YYYY-MM-DD.');
        }
        if (Object.prototype.hasOwnProperty.call(g, 'note')) out.note = str(g.note, 200);
        if (!out.type) out.type = 'quartz';
        ['serial', 'note'].forEach(function (k) { if (out[k] == null) out[k] = ''; });
        ['range', 'resolution', 'accuracy', 'depth', 'calDate'].forEach(function (k) { if (out[k] === undefined) out[k] = null; });
        return { gauge: out, errors: errors };
    }

    function listGauges() { return clone(ft().gauges) || []; }

    function setGauge(g) {
        var f = ft();
        if (!g || typeof g !== 'object') return { ok: false, errors: ['No gauge given.'] };
        var idx = -1;
        if (g.id != null) for (var i = 0; i < f.gauges.length; i++) if (f.gauges[i].id === String(g.id)) { idx = i; break; }
        var r = normGauge(g, idx >= 0 ? f.gauges[idx] : null);
        if (r.errors.length) return { ok: false, errors: r.errors };
        var rec = r.gauge;
        rec.id = idx >= 0 ? f.gauges[idx].id : (g.id != null && str(g.id, 40) ? str(g.id, 40) : newId('g', f.gauges));
        if (idx >= 0) f.gauges[idx] = rec; else f.gauges.push(rec);
        if (g.primary === true || !f.primaryGauge || !f.gauges.some(function (x) { return x.id === f.primaryGauge; })) f.primaryGauge = rec.id;
        save();
        dispatch('prism:gauges-changed', { id: rec.id, action: idx >= 0 ? 'update' : 'add' });
        return { ok: true, gauge: clone(rec), errors: [] };
    }

    function removeGauge(id) {
        var f = ft(), n = f.gauges.length;
        f.gauges = f.gauges.filter(function (x) { return x.id !== String(id); });
        if (f.gauges.length === n) return false;
        if (f.primaryGauge === String(id)) f.primaryGauge = f.gauges.length ? f.gauges[0].id : null;
        save();
        dispatch('prism:gauges-changed', { id: String(id), action: 'remove' });
        return true;
    }

    function setPrimaryGauge(id) {
        var f = ft();
        if (!f.gauges.some(function (x) { return x.id === String(id); })) return false;
        f.primaryGauge = String(id);
        save();
        dispatch('prism:gauges-changed', { id: String(id), action: 'primary' });
        return true;
    }

    function primaryGauge() {
        var f = ft();
        for (var i = 0; i < f.gauges.length; i++) if (f.gauges[i].id === f.primaryGauge) return clone(f.gauges[i]);
        return f.gauges.length ? clone(f.gauges[0]) : null;
    }

    // Radial flow: p = a + (m/ln10)·ln Δt, so successive readings Δs hours
    // apart differ by (m/ln10)·Δs/Δt. They fall below one resolution step r for
    //   Δt > m·Δs / (ln10 · r)
    // (semilog straight line: Matthews & Russell 1967, Earlougher 1977 eq. 2.4).
    function samplingLimit(m, dtSample, resolution) {
        if (!isPos(m) || !isPos(dtSample) || !isPos(resolution)) return NaN;
        return m * dtSample / (LN10 * resolution);
    }

    // Expected semilog slope m (psi/log cycle) for the analysed period:
    //   m = 162.6 q B μ / (k h)            (Earlougher 1977, eq. 2.5; field units)
    // from the current fit (C4) → the semilog analysis → the physical-model
    // parameters in PRiSM_state.phys.
    function expectedSlope(ad) {
        var w = null;
        if (typeof G.PRiSM_getWell === 'function') { try { w = G.PRiSM_getWell(); } catch (e) { w = null; } }
        w = w || {};
        var pseudo = !!(ad && ad.pseudo);
        var q = (ad && isPos(ad.qRef)) ? ad.qRef : (isPos(w.q) ? w.q : null);
        function fromKh(kh, src) {
            if (pseudo || !isPos(kh) || !isPos(q) || !isPos(w.B) || !isPos(w.mu)) return null;
            return { m: 162.6 * q * w.B * w.mu / kh, source: src, kh: kh, q: q, B: w.B, mu: w.mu };
        }
        var fit = null;
        if (typeof G.PRiSM_getLastFit === 'function') { try { fit = G.PRiSM_getLastFit(); } catch (e) { fit = null; } }
        if (fit && !fit.stale && fit.phys) {
            var kh = isPos(fit.phys.kh) ? fit.phys.kh : (isPos(fit.phys.k) && isPos(w.h) ? fit.phys.k * w.h : null);
            var r = fromKh(kh, 'fit');
            if (r) return r;
        }
        var sl = st().semilog;
        if (sl && sl.ok !== false && isPos(sl.m) && !pseudo) return { m: sl.m, source: 'semilog', kh: sl.kh || null };
        var ph = st().phys;
        if (ph && isPos(ph.k) && isPos(w.h)) {
            var r2 = fromKh(ph.k * w.h, 'model');
            if (r2) return r2;
        }
        return { m: null, source: pseudo ? 'gas-pseudo' : 'none' };
    }

    // Bourdet differentiation window of point i on ln x with smoothing L
    // (Bourdet, Ayoub & Pirard 1989): the nearest points at least L away in
    // ln x on each side (the immediate neighbours when L = 0).
    function bourdetWindow(lx, i, L) {
        var n = lx.length, i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && lx[i] - lx[i1] < L) i1--;
            while (i2 < n - 1 && lx[i2] - lx[i] < L) i2++;
        }
        return [i1, i2];
    }

    // opts: {gauge, resolution, L, period, adata, refDate}
    function gaugeResolutionCheck(opts) {
        opts = opts || {};
        var g = opts.gauge || primaryGauge();
        var res = isPos(opts.resolution) ? opts.resolution : (g && isPos(g.resolution) ? g.resolution : null);
        var out = { ok: false, gauge: g ? clone(g) : null, resolution: res, warnings: [], checks: [] };
        if (!isPos(res)) {
            out.reason = g ? 'The primary gauge has no resolution: enter it in the gauge register.' : 'No gauge in the register: add the gauge used for the analysis.';
            return out;
        }
        var ad = opts.adata || analysisData(opts);
        if (!ad || !ad.ok) { out.reason = (ad && ad.reason) || 'No analysis data.'; return out; }
        var n = ad.t.length;
        var lx = (ad.lnx && ad.lnx.length === n) ? ad.lnx : ad.x.map(function (v) { return Math.log(v); });
        var L = isNum(ad.L) ? ad.L : 0.1;
        var P = (ad.p && ad.p.length === n) ? ad.p : ad.dp;     // absolute psia (dp only as a fallback)
        var points = [], nBelow = 0;
        for (var i = 1; i < n - 1; i++) {
            var w = bourdetWindow(lx, i, L);
            var dpWin = Math.abs(P[w[1]] - P[w[0]]);
            if (!isNum(dpWin)) continue;
            var below = dpWin < res;
            if (below) nBelow++;
            points.push({ i: i, t: ad.t[i], deriv: ad.deriv ? ad.deriv[i] : NaN, dpWin: dpWin, relErr: dpWin > 0 ? res / dpWin : Infinity, below: below });
        }
        // Late-time run: the trailing contiguous block of below-resolution points.
        var flagged = [];
        for (var k = points.length - 1; k >= 0 && points[k].below; k--) flagged.unshift(points[k].i);
        out.ok = true;
        out.L = L;
        out.n = n;
        out.points = points;
        out.nBelow = nBelow;
        out.flagged = flagged;
        out.tFlagStart = flagged.length ? ad.t[flagged[0]] : null;
        out.tStart = ad.tStart;
        out.testType = ad.testType;
        // Expected-slope check.
        var ms = expectedSlope(ad);
        out.m = ms.m;
        out.mSource = ms.source;
        var span = L > 0 ? 2 * L : median(points.map(function (p) {
            var ww = bourdetWindow(lx, p.i, 0); return lx[ww[1]] - lx[ww[0]];
        }));
        out.windowLn = span;
        if (isPos(ms.m)) {
            // Radial flow: pressure change across the derivative window = m·Δln x / ln10.
            out.windowChange = ms.m * span / LN10;
            out.ratio = out.windowChange / res;
            // Conservative engineering threshold (open decision): the resolution
            // step is ≤ 10 % of the window change → derivative error ≤ ~10 %.
            out.verdict = out.ratio >= 10 ? 'ok' : (out.ratio >= 1 ? 'marginal' : 'unresolved');
            var dts = [];
            for (var j = Math.max(1, n - 10); j < n; j++) dts.push(ad.t[j] - ad.t[j - 1]);
            out.dtSample = median(dts);
            out.tLimit = samplingLimit(ms.m, out.dtSample, res);
            if (isNum(out.tLimit) && out.tLimit < ad.t[n - 1]) {
                out.warnings.push('After Δt ≈ ' + fmt(out.tLimit, 3) + ' h successive readings (every ' + fmt(out.dtSample * 3600, 3) +
                                  ' s) change by less than the gauge resolution in radial flow.');
            }
        } else {
            out.verdict = null;
            out.warnings.push(ms.source === 'gas-pseudo'
                ? 'Gas pseudo-pressure analysis: the expected slope is not in psi, so only the data check is made.'
                : 'No fit, semilog line or model permeability yet: only the data check is made.');
        }
        if (flagged.length) {
            out.warnings.push(flagged.length + ' late-time derivative point' + (flagged.length > 1 ? 's' : '') + ' (Δt ≥ ' + fmt(out.tFlagStart, 3) +
                              ' h) change by less than the ' + fmt(res, 3) + ' psi gauge resolution across the derivative window: treat their derivative as noise.');
        }
        // Range and calibration checks.
        var pMax = -Infinity, ds = G.PRiSM_dataset;
        if (ds && isArr(ds.p)) for (var q = 0; q < ds.p.length; q++) if (isNum(+ds.p[q]) && +ds.p[q] > pMax) pMax = +ds.p[q];
        if (g && isPos(g.range) && isNum(pMax)) {
            out.pMax = pMax;
            out.checks.push({ key: 'range', ok: pMax <= g.range, text: 'Maximum pressure ' + fmt(pMax, 5) + ' psia vs gauge range ' + fmt(g.range, 5) + ' psi' });
        }
        if (g && g.calDate) {
            var ref = parseClock(opts.refDate) || (isNum(ft().clockZero) ? ft().clockZero : now());
            var age = (ref - parseClock(g.calDate)) / 86400000;
            out.calAgeDays = age;
            // Conservative choice (open decision): calibration older than 12 months is flagged.
            out.checks.push({ key: 'calibration', ok: age <= 365 && age >= 0, text: 'Calibrated ' + g.calDate + ' (' + Math.round(age) + ' days before the test)' });
        }
        return out;
    }

    // =========================================================================
    // SECTION 3 — R13 SEQUENCE-OF-EVENTS LOG
    // =========================================================================

    var EVENT_TYPES = {
        open: 'Open / flow start', close: 'Close / shut-in', choke: 'Choke or rate change', rate: 'Rate measurement',
        sampling: 'Sampling', 'gauge-in': 'Gauge run in', 'gauge-out': 'Gauge pulled', note: 'Note'
    };
    var EVENT_ALIASES = {
        'tool-open': 'open', 'well-open': 'open', flow: 'open', 'flow-start': 'open', start: 'open',
        'tool-close': 'close', 'well-close': 'close', 'shut-in': 'close', shutin: 'close', shut: 'close',
        'choke-change': 'choke', 'rate-change': 'choke', 'gauge-run': 'gauge-in', 'gauge-pull': 'gauge-out',
        sample: 'sampling', comment: 'note'
    };
    var EVENT_COLORS = { open: '#3fb950', close: '#f85149', choke: '#f0883e', rate: '#d29922', sampling: '#58a6ff', 'gauge-in': '#a371f7', 'gauge-out': '#a371f7', note: '#8b949e' };
    var EVENT_CAP = 2000;

    function eventType(v) {
        var k = String(v == null ? '' : v).toLowerCase().trim().replace(/[\s_]+/g, '-');
        if (EVENT_TYPES[k]) return k;
        return EVENT_ALIASES[k] || null;
    }
    function sortEvents(list) {
        list.forEach(function (e, i) { e._o = i; });
        list.sort(function (a, b) {
            var ta = isNum(a.t) ? a.t : Infinity, tb = isNum(b.t) ? b.t : Infinity;
            return (ta - tb) || (a._o - b._o);
        });
        list.forEach(function (e) { delete e._o; });
    }

    // evt: {type, t (h) | time (ms / ISO / Date), q?, choke?, label?, note?, gaugeId?, source?, id?}
    function addEvent(evt) {
        if (!evt || typeof evt !== 'object') return null;
        var type = eventType(evt.type);
        if (!type) return null;
        var f = ft();
        var time = parseClock(evt.time);
        var t = num(evt.t);
        if (t == null && time != null && isNum(f.clockZero)) t = (time - f.clockZero) / 3600000;
        var e = {
            type: type,
            t: t,
            time: time,
            q: num(evt.q),
            choke: num(evt.choke),
            label: str(evt.label, 80),
            note: str(evt.note, 200),
            gaugeId: evt.gaugeId != null ? str(evt.gaugeId, 40) : null,
            source: str(evt.source || 'user', 40) || 'user'
        };
        var idx = -1;
        if (evt.id != null) for (var i = 0; i < f.events.length; i++) if (f.events[i].id === String(evt.id)) { idx = i; break; }
        if (idx < 0 && f.events.length >= EVENT_CAP) return null;
        e.id = idx >= 0 ? f.events[idx].id : (evt.id != null && str(evt.id, 40) ? str(evt.id, 40) : newId('e', f.events));
        if (idx >= 0) f.events[idx] = e; else f.events.push(e);
        sortEvents(f.events);
        save();
        dispatch('prism:events-changed', { id: e.id, action: idx >= 0 ? 'update' : 'add', source: e.source });
        redraw();
        return clone(e);
    }

    function listEvents() { return clone(ft().events) || []; }

    function removeEvent(id) {
        var f = ft(), n = f.events.length;
        f.events = f.events.filter(function (x) { return x.id !== String(id); });
        if (f.events.length === n) return false;
        save();
        dispatch('prism:events-changed', { id: String(id), action: 'remove' });
        redraw();
        return true;
    }

    function clearEvents() {
        var f = ft();
        if (!f.events.length) return false;
        f.events = [];
        save();
        dispatch('prism:events-changed', { action: 'clear' });
        redraw();
        return true;
    }

    // Sets the wall-clock time of t = 0 on the dataset clock and places every
    // event that has a wall-clock time.
    function setEventClock(time) {
        var f = ft();
        var ms = parseClock(time);
        if (time != null && time !== '' && ms == null) return false;
        f.clockZero = ms;
        if (ms != null) f.events.forEach(function (e) { if (isNum(e.time)) e.t = (e.time - ms) / 3600000; });
        sortEvents(f.events);
        save();
        dispatch('prism:events-changed', { action: 'clock' });
        redraw();
        return true;
    }

    // Rate schedule from the events: open → the event's rate (or the first rate
    // measured before the next close), choke / rate → the new rate, close → 0.
    // Consecutive equal rates are merged. Rows are the multi-rate table's
    // {t (h), q} step starts (C2 rate history).
    function eventsToRateSchedule(events) {
        var list = isArr(events) ? Array.prototype.slice.call(events).map(function (e) {
            return { type: eventType(e.type), t: num(e.t), q: num(e.q) };
        }) : listEvents();
        var warnings = [];
        var placed = list.filter(function (e) { return e.type && isNum(e.t); });
        var unplaced = list.length - placed.length;
        if (unplaced > 0) warnings.push(unplaced + ' event' + (unplaced > 1 ? 's have' : ' has') + ' no time on the dataset clock and ' + (unplaced > 1 ? 'were' : 'was') + ' ignored: set the clock zero or enter t.');
        placed.sort(function (a, b) { return a.t - b.t; });
        var rows = [], open = false, qCur = 0, used = 0;
        function push(t, q) {
            if (rows.length && Math.abs(rows[rows.length - 1].t - t) < 1e-9) rows.pop();
            if (rows.length ? rows[rows.length - 1].q === q : q === 0) { qCur = q; return; }
            rows.push({ t: t, q: q });
            qCur = q;
        }
        for (var i = 0; i < placed.length; i++) {
            var e = placed[i];
            if (e.type === 'open') {
                var q = e.q;
                if (q == null) {
                    for (var j = i + 1; j < placed.length; j++) {
                        if (placed[j].type === 'close' || placed[j].type === 'open') break;
                        if ((placed[j].type === 'rate' || placed[j].type === 'choke') && placed[j].q != null) { q = placed[j].q; break; }
                    }
                }
                open = true;
                if (q == null) { warnings.push('Open at t = ' + fmt(e.t, 4) + ' h has no rate and no later rate before the next close: add a rate to seed this period.'); continue; }
                push(e.t, q); used++;
            } else if (e.type === 'choke' || e.type === 'rate') {
                if (e.q == null) continue;
                if (!open) {
                    if (e.q === 0) continue;
                    warnings.push('A rate at t = ' + fmt(e.t, 4) + ' h comes before any open event: it is taken as the flow start.');
                    open = true;
                }
                push(e.t, e.q); used++;
            } else if (e.type === 'close') {
                if (!open && qCur === 0) continue;
                open = false;
                push(e.t, 0); used++;
            }
        }
        var any = rows.some(function (r) { return r.q !== 0; });
        return { ok: any, rows: rows, warnings: warnings, used: used, reason: any ? null : 'The events give no flowing rate: add open / rate events with rates.' };
    }

    function persistMultiRate(rows) {
        try {
            var ls = G.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
            if (ls) ls.setItem('wts_prism_mrate', JSON.stringify(rows || []));
        } catch (e) { /* quota / private mode */ }
    }

    // Writes the schedule into the multi-rate table (PRiSM.multiRate), which
    // PRiSM_rateHistory / PRiSM_getAnalysisData use as the rate history. The
    // change goes on the workflow undo stack (PRiSM_undo restores the table).
    function seedPeriodsFromEvents(opts) {
        opts = opts || {};
        var r = eventsToRateSchedule(opts.events);
        if (!r.ok) return { ok: false, reason: r.reason, rows: r.rows, warnings: r.warnings };
        if (typeof G.PRiSM_recordSnapshot === 'function') { try { G.PRiSM_recordSnapshot('before-seed-events'); } catch (e) { /* optional */ } }
        if (!G.PRiSM || typeof G.PRiSM !== 'object') G.PRiSM = { mode: 'transient', tab: 1, multiRate: [] };
        G.PRiSM.multiRate = r.rows.map(function (x) { return { t: x.t, q: x.q }; });
        persistMultiRate(G.PRiSM.multiRate);
        try { if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows(); } catch (e) { /* host-scope editor absent */ }   // eslint-disable-line no-undef
        var s = st();
        s.activePeriod = null;                      // period indices changed: re-select automatically
        ft().lastSeed = { at: now(), rows: r.rows.length };
        save();
        dispatch('prism:period-changed', { source: 'events', period: null });
        redraw();
        var undoable = (typeof G.PRiSM_canUndo === 'function') ? !!G.PRiSM_canUndo() : false;
        return { ok: true, rows: clone(r.rows), warnings: r.warnings, undoable: undoable };
    }

    // =========================================================================
    // SECTION 4 — R15 TOTAL-COMPRESSIBILITY BUILDER
    // =========================================================================
    //
    // ct = So·co + Sw·cw + Sg·cg + cf      (Earlougher 1977 eq. 2.25;
    //                                       Ramey 1964)
    // Rock (pore-volume) compressibility cf, φ as a fraction, 1/psi:
    //   Hall (1953), consolidated rock:  cf = 1.782e-6 / φ^0.438
    //   Newman (1973), consolidated sandstone: cf = 97.32e-6 / (1 + 55.8721 φ)^1.42859
    //   Newman (1973), limestone:              cf = 0.853531 / (1 + 2.47664e6 φ)^0.92990
    //   (Hall, Trans. AIME 198, 1953, p. 309; Newman, JPT Feb 1973, pp. 129-134;
    //    coefficients as tabulated in Ahmed, Reservoir Engineering Handbook, ch. 4.)
    // co: Vasquez-Beggs (1980), above Pb; cw: Osif (1988) with the
    // Dodson-Standing dissolved-gas factor; cg: real-gas 1/p − (1/Z)dZ/dp with
    // DAK Z — all from the 16-pvt correlation library.

    var CF_METHODS = {
        hall: 'Hall (1953)',
        'newman-sandstone': 'Newman (1973) consolidated sandstone',
        'newman-limestone': 'Newman (1973) limestone',
        user: 'Entered value'
    };

    function rockCompressibility(phi, method) {
        if (!(isNum(phi) && phi > 0 && phi < 1)) return NaN;
        method = method || 'hall';
        if (method === 'newman-sandstone') return 97.32e-6 / Math.pow(1 + 55.8721 * phi, 1.42859);
        if (method === 'newman-limestone') return 0.853531 / Math.pow(1 + 2.47664e6 * phi, 0.92990);
        if (method === 'hall') return 1.782e-6 / Math.pow(phi, 0.438);
        return NaN;
    }

    function corr() { return G.PRiSM_pvt_correlations || {}; }

    // input (all optional): fluid, So, Sw, Sg, co, cw, cg, cf, cfMethod, phi, p, T, API, SG_g, Rs, Rsw
    function ctBuild(input) {
        input = input || {};
        var s = G.PRiSM_pvt || {};
        var prov = s.provenance || {};
        var comp = s._computed || {};
        if ((!comp || !comp.timestamp) && typeof G.PRiSM_pvt_compute === 'function') { try { comp = G.PRiSM_pvt_compute() || {}; } catch (e) { comp = {}; } }
        var C = corr();
        var warnings = [], defaulted = [], sources = {};
        var fluid = (input.fluid === 'oil' || input.fluid === 'gas' || input.fluid === 'water') ? input.fluid : (s.fluidType || 'oil');
        function isDefault(key) { var p = prov[key]; return !p || p === 'default'; }
        // Store value with provenance; `need` marks it as used.
        function fromStore(inKey, storeKey) {
            var v = num(input[inKey]);
            if (v != null) { sources[inKey] = 'input'; return v; }
            v = num(s[storeKey]);
            if (v == null) return null;
            sources[inKey] = isDefault(storeKey) ? 'default' : (prov[storeKey] || 'user');
            if (sources[inKey] === 'default' && defaulted.indexOf(inKey) < 0) defaulted.push(inKey);
            return v;
        }
        var p = fromStore('p', 'p_res');
        var T = fromStore('T', 'T_res');

        // Saturations.
        var Sw = num(input.Sw), So = num(input.So), Sg = num(input.Sg);
        if (fluid === 'water') {
            if (Sw == null) { Sw = 1; sources.Sw = 'fluid'; } else sources.Sw = 'input';
            if (So == null) So = 0; if (Sg == null) Sg = 0;
        } else {
            if (Sw == null) Sw = fromStore('Sw', 'Sw'); else sources.Sw = 'input';
            if (Sw == null) return { ok: false, reason: 'Water saturation Sw is required.' };
            if (fluid === 'gas') {
                if (So == null) So = 0;
                if (Sg == null) { Sg = 1 - Sw - So; sources.Sg = 'balance'; } else sources.Sg = 'input';
            } else {
                if (Sg == null) {
                    Sg = 0; sources.Sg = 'assumed';
                    if (isNum(comp.Pb) && isNum(p) && p < comp.Pb) warnings.push('Reservoir pressure is below the bubble point (' + fmt(comp.Pb, 4) + ' psia): enter the free-gas saturation Sg; 0 is assumed.');
                } else sources.Sg = 'input';
                if (So == null) { So = 1 - Sw - Sg; sources.So = 'balance'; } else sources.So = 'input';
            }
        }
        var sum = So + Sw + Sg;
        if (!(So >= 0 && Sw >= 0 && Sg >= 0 && So <= 1 && Sw <= 1 && Sg <= 1) || Math.abs(sum - 1) > 0.005) {
            return { ok: false, reason: 'Saturations must lie in [0, 1] and add up to 1 (So + Sw + Sg = ' + fmt(sum, 4) + ').' };
        }

        // Phase compressibilities.
        var co = null, cw = null, cg = null;
        if (So > 0) {
            co = num(input.co);
            if (co != null) sources.co = 'input';
            else if (num(s.co) != null && !isDefault('co')) { co = s.co; sources.co = prov.co; }
            else if (typeof C.co_vasquezBeggs === 'function') {
                var API = fromStore('API', 'API'), SG = fromStore('SG_g', 'SG_g');
                var Rs = num(input.Rs);
                if (Rs == null) Rs = (num(s.Rs) != null) ? fromStore('Rs', 'Rs') : (isNum(comp.Rs) ? comp.Rs : null);
                if (Rs != null && sources.Rs == null) sources.Rs = 'correlation';
                co = C.co_vasquezBeggs(API, SG, Rs, p, T);
                sources.co = 'correlation';
                if (isNum(comp.Pb) && isNum(p) && p < comp.Pb) warnings.push('Vasquez-Beggs co applies above the bubble point only.');
            }
            if (!isPos(co)) return { ok: false, reason: 'Oil compressibility co could not be found: enter it.' };
        }
        if (Sw > 0) {
            cw = num(input.cw);
            if (cw != null) sources.cw = 'input';
            else if (num(s.cw) != null && !isDefault('cw')) { cw = s.cw; sources.cw = prov.cw; }
            else if (typeof C.cw_dodson === 'function') {
                var Rsw = num(input.Rsw); if (Rsw == null) Rsw = fromStore('Rsw', 'Rsw');
                cw = C.cw_dodson(p, T, Rsw);
                sources.cw = 'correlation';
            }
            if (!isPos(cw)) return { ok: false, reason: 'Water compressibility cw could not be found: enter it.' };
        }
        if (Sg > 0) {
            cg = num(input.cg);
            if (cg != null) sources.cg = 'input';
            else if (num(s.cg) != null && !isDefault('cg')) { cg = s.cg; sources.cg = prov.cg; }
            else if (typeof C.cg_realGas === 'function' && typeof C.Z_dranchukAbouKassem === 'function') {
                var SGg = fromStore('SG_g', 'SG_g');
                var Tpc = C.Tpc_sutton(SGg), Ppc = C.Ppc_sutton(SGg);
                var Z = (fluid === 'gas' && isNum(comp.z)) ? comp.z : C.Z_dranchukAbouKassem((T + 459.67) / Tpc, p / Ppc);
                cg = C.cg_realGas(p, T, Z, SGg);
                sources.cg = 'correlation';
            }
            if (!isPos(cg)) return { ok: false, reason: 'Gas compressibility cg could not be found: enter it.' };
        }

        // Rock compressibility.
        var method = CF_METHODS[input.cfMethod] ? input.cfMethod : (num(input.cf) != null ? 'user' : 'hall');
        var cf = null, phi = null;
        if (method === 'user') {
            cf = num(input.cf);
            if (cf == null) { cf = fromStore('cf', 'cf'); }
            else sources.cf = 'input';
        } else {
            phi = fromStore('phi', 'phi');
            cf = rockCompressibility(phi, method);
            sources.cf = 'correlation';
            if (isNum(phi) && (phi < 0.02 || phi > 0.35)) warnings.push('Porosity ' + fmt(phi, 3) + ' is outside the range of the rock-compressibility data (≈ 0.02-0.35).');
        }
        if (!(isNum(cf) && cf >= 0)) return { ok: false, reason: 'Rock compressibility cf could not be found: enter φ or cf.' };

        var terms = {
            oil: So > 0 ? So * co : 0,
            water: Sw > 0 ? Sw * cw : 0,
            gas: Sg > 0 ? Sg * cg : 0,
            rock: cf
        };
        var ct = terms.oil + terms.water + terms.gas + terms.rock;
        // Only the base inputs that fed a used term count as "defaulted".
        var used = { p: 1, T: 1 };
        if (So > 0 && sources.co === 'correlation') { used.API = 1; used.SG_g = 1; used.Rs = 1; }
        if (Sw > 0 && sources.cw === 'correlation') used.Rsw = 1;
        if (Sg > 0 && sources.cg === 'correlation') used.SG_g = 1;
        if (fluid !== 'water' && sources.Sw !== 'input') used.Sw = 1;
        if (method !== 'user') used.phi = 1; else used.cf = 1;
        if (!(So > 0 && sources.co === 'correlation') && !(Sw > 0 && sources.cw === 'correlation') && !(Sg > 0 && sources.cg === 'correlation')) { delete used.p; delete used.T; }
        defaulted = defaulted.filter(function (k) { return used[k]; });
        return {
            ok: true, ct: ct, fluid: fluid, terms: terms,
            inputs: { So: So, Sw: Sw, Sg: Sg, co: co, cw: cw, cg: cg, cf: cf, phi: phi, p: p, T: T },
            sources: sources, cfMethod: method, cfMethodLabel: CF_METHODS[method],
            defaulted: defaulted, isDefaulted: defaulted.length > 0, warnings: warnings
        };
    }

    // Writes ct to the well store (C1) with provenance 'correlation'.
    function ctApply(result) {
        var r = result || ctBuild(ft().ctInput || {});
        if (!r || !r.ok || !isPos(r.ct)) return { ok: false, reason: (r && r.reason) || 'No ct result.' };
        if (typeof G.PRiSM_setWell !== 'function') return { ok: false, reason: 'Well store (PRiSM_setWell) not loaded.' };
        ft().ctBuild = { ct: r.ct, at: now(), defaulted: (r.defaulted || []).slice(), cfMethod: r.cfMethod, terms: clone(r.terms), inputs: clone(r.inputs) };
        save();
        G.PRiSM_setWell({ ct: r.ct }, { source: 'correlation', origin: 'ct-builder' });
        return { ok: true, ct: r.ct, defaulted: (r.defaulted || []).slice(), isDefaulted: !!r.isDefaulted };
    }

    // =========================================================================
    // SECTION 5 — POST-DRAW HOOK: event markers + resolution flags (C6/C7)
    // =========================================================================

    var _chkCache = { key: null, res: null };
    function checkForPlot(data) {
        var g = primaryGauge();
        if (!g || !isPos(g.resolution)) return null;
        var t = data && data.t, dp = data && data.dp;
        var n = t ? t.length : 0;
        var key = [n, n ? t[0] : 0, n ? t[n - 1] : 0, dp && n ? dp[0] : 0, dp && n ? dp[n - 1] : 0,
                   g.id, g.resolution, st().bourdetL, st().activePeriod, G.PRiSM_datasetHash ? G.PRiSM_datasetHash() : ''].join('|');
        if (_chkCache.key === key) return _chkCache.res;
        var r = null;
        try { r = gaugeResolutionCheck({ gauge: g }); } catch (e) { r = null; }
        _chkCache = { key: key, res: r };
        return r;
    }

    function tStartFor(plotKey) {
        if (plotKey === 'cartesian') return 0;
        var ad = analysisData();
        return (ad && ad.ok && isNum(ad.tStart)) ? ad.tStart : null;
    }

    var EVENT_PLOTS = { cartesian: 1, bourdet: 1, mdh: 1 };

    function fieldToolsPostDraw(info) {
        if (!info || !info.canvas || typeof info.canvas.getContext !== 'function') return;
        var ax = info.axes || info.canvas._prismAxes;
        if (!ax || typeof ax.toX !== 'function' || !ax.plot) return;
        var plotKey = info.plotKey || st().activePlot;
        var ctx;
        try { ctx = info.canvas.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) return;
        var plot = ax.plot;
        var sx = ax.scaleX || {};
        var xMin = isNum(sx.min) ? Math.min(sx.min, sx.max) : -Infinity, xMax = isNum(sx.max) ? Math.max(sx.min, sx.max) : Infinity;
        ctx.save();
        try {
            // Event markers.
            var evs = ft().events.filter(function (e) { return isNum(e.t); });
            if (EVENT_PLOTS[plotKey] && evs.length) {
                var t0 = tStartFor(plotKey);
                if (t0 != null) {
                    ctx.font = '10px sans-serif';
                    ctx.textBaseline = 'top';
                    evs.forEach(function (e, k) {
                        var x = e.t - t0;
                        if (sx.kind === 'log' && !(x > 0)) return;
                        if (x < xMin || x > xMax) return;
                        var px = ax.toX(x);
                        if (!isNum(px) || px < plot.x - 1 || px > plot.x + plot.w + 1) return;
                        var col = EVENT_COLORS[e.type] || '#8b949e';
                        ctx.strokeStyle = col;
                        ctx.lineWidth = 1;
                        if (ctx.setLineDash) ctx.setLineDash([2, 3]);
                        ctx.beginPath(); ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h); ctx.stroke();
                        if (ctx.setLineDash) ctx.setLineDash([]);
                        ctx.fillStyle = col;
                        var lbl = e.label || EVENT_TYPES[e.type] || e.type;
                        ctx.fillText(String(lbl).slice(0, 18), px + 3, plot.y + 3 + (k % 3) * 11);
                    });
                }
            }
            // Resolution flags on the log-log diagnostic plot.
            if (plotKey === 'bourdet' && typeof ax.toY === 'function') {
                var r = checkForPlot(info.data);
                if (r && r.ok && r.nBelow > 0) {
                    var late = {};
                    r.flagged.forEach(function (i) { late[i] = 1; });
                    r.points.forEach(function (pt) {
                        if (!pt.below || !(pt.t > 0)) return;
                        var px = ax.toX(pt.t);
                        var py = (isPos(pt.deriv)) ? ax.toY(pt.deriv) : plot.y + plot.h - 5;
                        if (!isNum(px) || !isNum(py) || px < plot.x || px > plot.x + plot.w) return;
                        py = Math.max(plot.y + 4, Math.min(plot.y + plot.h - 4, py));
                        ctx.strokeStyle = late[pt.i] ? '#f85149' : 'rgba(248,81,73,0.45)';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath(); ctx.arc(px, py, 5, 0, 2 * Math.PI); ctx.stroke();
                    });
                    ctx.fillStyle = '#f85149';
                    ctx.font = '11px sans-serif';
                    ctx.textBaseline = 'top';
                    ctx.fillText('⚠ ' + r.nBelow + ' derivative point' + (r.nBelow > 1 ? 's' : '') + ' below gauge resolution (' + fmt(r.resolution, 3) + ' psi)',
                                 plot.x + 6, plot.y + plot.h - 18);
                }
            }
        } catch (e) { /* drawing is best-effort */ }
        ctx.restore();
    }
    fieldToolsPostDraw._prismId = 'fieldtools-markers';

    (function registerHook() {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fieldToolsPostDraw._prismId) { hooks[i] = fieldToolsPostDraw; return; }
        hooks.push(fieldToolsPostDraw);
    })();

    // =========================================================================
    // SECTION 6 — PANELS (C7)
    // =========================================================================

    var STYLE_ID = 'prism_ft_style';
    var CSS = [
        '.prism-ft { display:flex; flex-direction:column; gap:10px; font-size:12.5px; color:var(--text); min-width:0; }',
        '.prism-ft-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; }',
        '.prism-ft-grid label { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text2); }',
        '.prism-ft input, .prism-ft select { width:100%; min-width:0; background:var(--bg1); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 7px; font:inherit; font-size:12.5px; }',
        '.prism-ft-tw { overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }',
        '.prism-ft table { width:100%; border-collapse:collapse; font-size:12px; }',
        '.prism-ft th, .prism-ft td { padding:5px 6px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }',
        '.prism-ft th { color:var(--text2); font-weight:600; font-size:11px; }',
        '.prism-ft td.num { text-align:right; font-variant-numeric:tabular-nums; }',
        '.prism-ft-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }',
        '.prism-ft-btn { appearance:none; background:var(--bg3, var(--bg2)); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 10px; font:inherit; font-size:12px; cursor:pointer; min-height:32px; }',
        '.prism-ft-btn:hover { border-color:var(--accent); }',
        '.prism-ft-btn--primary { background:var(--accent); border-color:var(--accent); color:#111; font-weight:700; }',
        '.prism-ft-msg { line-height:1.45; padding:6px 9px; border-radius:4px; border-left:3px solid var(--blue); background:var(--bg2); }',
        '.prism-ft-msg--ok { border-left-color:var(--green); }',
        '.prism-ft-msg--warn { border-left-color:var(--yellow); }',
        '.prism-ft-msg--bad { border-left-color:var(--red); }',
        '.prism-ft-hint { font-size:11px; color:var(--text3); line-height:1.4; }'
    ].join('\n');
    function ensureStyle() {
        if (!D || !D.createElement || $(STYLE_ID)) return;
        try {
            var s = D.createElement('style');
            s.id = STYLE_ID;
            s.textContent = CSS;
            var parent = D.head || D.body || D.documentElement;
            if (parent) parent.appendChild(s);
        } catch (e) { /* ignore */ }
    }
    function val(id) { var e = $(id); return e ? e.value : ''; }
    function msg(kind, text) { return '<div class="prism-ft-msg prism-ft-msg--' + kind + '">' + text + '</div>'; }
    function field(id, label, value, type, extra) {
        return '<label>' + esc(label) + '<input id="' + id + '" type="' + (type || 'number') + '" step="any" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + '></label>';
    }
    function rerender(rootId, fn) {
        var root = $(rootId);
        if (root && root.parentNode) { try { fn(root.parentNode); } catch (e) { /* ignore */ } }
    }

    // ── Gauge register (Tab 1) ───────────────────────────────────────────────
    function renderGaugeRegister(host) {
        if (!host) return;
        ensureStyle();
        var f = ft();
        var h = '<div class="prism-ft" id="prism_ft_gauges_root">';
        if (f.gauges.length) {
            h += '<div class="prism-ft-tw"><table><thead><tr><th>Primary</th><th>Serial</th><th>Type</th><th>Range (psi)</th><th>Resolution (psi)</th><th>Accuracy (psi)</th><th>Calibrated</th><th>Depth (ft)</th><th></th></tr></thead><tbody>';
            f.gauges.forEach(function (g) {
                var prim = g.id === (primaryGauge() || {}).id;
                h += '<tr><td><input type="radio" name="prism_ft_primary" data-ft-primary="' + esc(g.id) + '"' + (prim ? ' checked' : '') + ' aria-label="Primary gauge ' + esc(g.serial || g.id) + '"></td>' +
                     '<td>' + esc(g.serial || '—') + '</td><td>' + esc(GAUGE_TYPES[g.type] || g.type) + '</td>' +
                     '<td class="num">' + fmt(g.range, 5) + '</td><td class="num">' + fmt(g.resolution, 3) + '</td><td class="num">' + fmt(g.accuracy, 3) + '</td>' +
                     '<td>' + esc(g.calDate || '—') + '</td><td class="num">' + fmt(g.depth, 5) + '</td>' +
                     '<td><button type="button" class="prism-ft-btn" data-ft-rmgauge="' + esc(g.id) + '" aria-label="Remove gauge ' + esc(g.serial || g.id) + '">×</button></td></tr>';
            });
            h += '</tbody></table></div>';
        } else {
            h += '<div class="prism-ft-hint">No gauges yet. Add the gauge whose data you analyse; its resolution is checked against the expected semilog slope and the late-time data.</div>';
        }
        var types = Object.keys(GAUGE_TYPES).map(function (k) { return '<option value="' + k + '">' + GAUGE_TYPES[k] + '</option>'; }).join('');
        h += '<div class="prism-ft-grid">' +
             field('prism_ft_g_serial', 'Serial', '', 'text') +
             '<label>Type<select id="prism_ft_g_type">' + types + '</select></label>' +
             field('prism_ft_g_range', 'Range (psi)', '') +
             field('prism_ft_g_res', 'Resolution (psi)', '') +
             field('prism_ft_g_acc', 'Accuracy (psi)', '') +
             field('prism_ft_g_cal', 'Calibration date (YYYY-MM-DD)', '', 'text') +
             field('prism_ft_g_depth', 'Depth (ft MD)', '') +
             '</div><div class="prism-ft-row"><button type="button" class="prism-ft-btn prism-ft-btn--primary" id="prism_ft_g_add">Add gauge</button>' +
             '<span id="prism_ft_g_msg" class="prism-ft-hint"></span></div>';
        var chk = gaugeResolutionCheck();
        h += '<div id="prism_ft_g_check">' + checkSummaryHTML(chk) + '</div>';
        h += '</div>';
        host.innerHTML = h;
        var root = $('prism_ft_gauges_root');
        if (!root || typeof root.addEventListener !== 'function') return;
        root.addEventListener('click', function (ev) {
            var t = ev && ev.target;
            if (!t || !t.getAttribute) return;
            var rm = t.getAttribute('data-ft-rmgauge');
            if (rm) { removeGauge(rm); return; }
            var pr = t.getAttribute('data-ft-primary');
            if (pr) { setPrimaryGauge(pr); return; }
            if (t.id === 'prism_ft_g_add') {
                var r = setGauge({
                    serial: val('prism_ft_g_serial'), type: val('prism_ft_g_type') || 'quartz',
                    range: val('prism_ft_g_range'), resolution: val('prism_ft_g_res'), accuracy: val('prism_ft_g_acc'),
                    calDate: val('prism_ft_g_cal'), depth: val('prism_ft_g_depth')
                });
                if (!r.ok) { var m = $('prism_ft_g_msg'); if (m) m.textContent = r.errors.join(' '); }
            }
        });
    }

    function checkSummaryHTML(chk) {
        if (!chk) return '';
        if (!chk.ok) return msg('warn', esc(chk.reason || 'Resolution check unavailable.'));
        var h = '';
        var g = chk.gauge || {};
        if (isPos(chk.m)) {
            var kind = chk.verdict === 'ok' ? 'ok' : (chk.verdict === 'marginal' ? 'warn' : 'bad');
            var mark = chk.verdict === 'ok' ? '✓' : (chk.verdict === 'marginal' ? '⚠' : '✗');
            h += msg(kind, mark + ' Expected semilog slope m = ' + fmt(chk.m, 4) + ' psi/cycle (' + esc(chk.mSource) + '): the derivative window (' +
                     fmt(chk.windowLn, 3) + ' in ln t) spans ' + fmt(chk.windowChange, 3) + ' psi = ' + fmt(chk.ratio, 3) + ' × the ' +
                     fmt(chk.resolution, 3) + ' psi resolution' + (g.serial ? ' of gauge ' + esc(g.serial) : '') + '.');
        }
        if (chk.flagged.length) h += msg('bad', '✗ ' + esc(chk.warnings.filter(function (w) { return /late-time/.test(w); })[0] || ''));
        else h += msg('ok', '✓ No late-time derivative point changes by less than the gauge resolution (' + chk.nBelow + ' of ' + chk.points.length + ' points below overall).');
        chk.warnings.forEach(function (w) { if (!/late-time/.test(w)) h += msg('warn', '⚠ ' + esc(w)); });
        chk.checks.forEach(function (c) { h += msg(c.ok ? 'ok' : 'warn', (c.ok ? '✓ ' : '⚠ ') + esc(c.text)); });
        h += '<div class="prism-ft-hint">Flag rule: a derivative point is below resolution when the pressure change across its Bourdet window is smaller than one resolution step. ' +
             'The ✓ threshold (window change ≥ 10 × resolution, derivative error ≲ 10 %) is an engineering choice.</div>';
        return h;
    }

    // ── Resolution check (Tab 2, Diagnose) ───────────────────────────────────
    function renderGaugeCheckPanel(host) {
        if (!host) return;
        ensureStyle();
        host.innerHTML = '<div class="prism-ft" id="prism_ft_gcheck_root">' + checkSummaryHTML(gaugeResolutionCheck()) + '</div>';
    }

    // ── Sequence of events (Tab 1) ───────────────────────────────────────────
    function renderEventsLog(host) {
        if (!host) return;
        ensureStyle();
        var f = ft();
        var h = '<div class="prism-ft" id="prism_ft_events_root">';
        h += '<div class="prism-ft-grid">' + field('prism_ft_clock', 'Clock at t = 0 (UTC, YYYY-MM-DD HH:MM)', clockText(f.clockZero), 'text') +
             '<label>&nbsp;<button type="button" class="prism-ft-btn" id="prism_ft_clock_set">Set clock</button></label></div>';
        if (f.events.length) {
            h += '<div class="prism-ft-tw"><table><thead><tr><th>t (h)</th><th>Clock</th><th>Event</th><th>Rate</th><th>Choke (/64 in)</th><th>Note</th><th>Source</th><th></th></tr></thead><tbody>';
            f.events.forEach(function (e) {
                h += '<tr><td class="num">' + (isNum(e.t) ? fmt(e.t, 5) : '—') + '</td><td>' + esc(clockText(e.time)) + '</td>' +
                     '<td>' + esc(e.label || EVENT_TYPES[e.type] || e.type) + '</td><td class="num">' + fmt(e.q, 5) + '</td><td class="num">' + fmt(e.choke, 3) + '</td>' +
                     '<td>' + esc(e.note) + '</td><td>' + esc(e.source) + '</td>' +
                     '<td><button type="button" class="prism-ft-btn" data-ft-rmevent="' + esc(e.id) + '" aria-label="Remove event">×</button></td></tr>';
            });
            h += '</tbody></table></div>';
        } else {
            h += '<div class="prism-ft-hint">No events yet. Log tool open / close, choke and rate changes, sampling and gauge runs; the history and diagnostic plots show them as markers.</div>';
        }
        var types = Object.keys(EVENT_TYPES).map(function (k) { return '<option value="' + k + '">' + EVENT_TYPES[k] + '</option>'; }).join('');
        h += '<div class="prism-ft-grid">' +
             '<label>Event<select id="prism_ft_e_type">' + types + '</select></label>' +
             field('prism_ft_e_t', 't (h, dataset clock)', '') +
             field('prism_ft_e_time', 'or clock (UTC)', '', 'text') +
             field('prism_ft_e_q', 'Rate (STB/d or Mscf/d)', '') +
             field('prism_ft_e_choke', 'Choke (/64 in)', '') +
             field('prism_ft_e_note', 'Note', '', 'text') +
             '</div><div class="prism-ft-row">' +
             '<button type="button" class="prism-ft-btn" id="prism_ft_e_add">Add event</button>' +
             '<button type="button" class="prism-ft-btn prism-ft-btn--primary" id="prism_ft_seed">Seed flow periods from events</button>' +
             '<button type="button" class="prism-ft-btn" id="prism_ft_undo"' + ((typeof G.PRiSM_canUndo === 'function' && G.PRiSM_canUndo()) ? '' : ' disabled') + '>Undo</button>' +
             '<button type="button" class="prism-ft-btn" id="prism_ft_e_clear">Clear events</button></div>' +
             '<div id="prism_ft_e_msg"></div>' +
             '<div class="prism-ft-hint">Seeding writes the rate schedule (open → rate, choke / rate change → new rate, close → 0) to the multi-rate table that drives the flow periods; Undo restores the previous table.</div>';
        h += '</div>';
        host.innerHTML = h;
        var root = $('prism_ft_events_root');
        if (!root || typeof root.addEventListener !== 'function') return;
        root.addEventListener('click', function (ev) {
            var t = ev && ev.target;
            if (!t || !t.getAttribute) return;
            var rm = t.getAttribute('data-ft-rmevent');
            if (rm) { removeEvent(rm); return; }
            var box = $('prism_ft_e_msg');
            if (t.id === 'prism_ft_clock_set') {
                if (!setEventClock(val('prism_ft_clock')) && box) box.innerHTML = msg('bad', '✗ Clock not recognised: use YYYY-MM-DD HH:MM.');
            } else if (t.id === 'prism_ft_e_add') {
                var r = addEvent({ type: val('prism_ft_e_type'), t: val('prism_ft_e_t'), time: val('prism_ft_e_time') || null,
                                   q: val('prism_ft_e_q'), choke: val('prism_ft_e_choke'), note: val('prism_ft_e_note'), source: 'user' });
                if (!r && box) box.innerHTML = msg('bad', '✗ Event not added.');
                else if (r && !isNum(r.t) && box) box.innerHTML = msg('warn', '⚠ Event has no time on the dataset clock: set the clock at t = 0.');
            } else if (t.id === 'prism_ft_seed') {
                var s = seedPeriodsFromEvents();
                var html = s.ok ? msg('ok', '✓ ' + s.rows.length + ' rate step' + (s.rows.length > 1 ? 's' : '') + ' written to the rate history' + (s.undoable ? ' (Undo restores the previous table).' : '.'))
                                : msg('bad', '✗ ' + esc(s.reason));
                (s.warnings || []).forEach(function (w) { html += msg('warn', '⚠ ' + esc(w)); });
                var b2 = $('prism_ft_e_msg');
                if (b2) b2.innerHTML = html;
                var u = $('prism_ft_undo'); if (u) u.disabled = !(typeof G.PRiSM_canUndo === 'function' && G.PRiSM_canUndo());
            } else if (t.id === 'prism_ft_undo') {
                if (typeof G.PRiSM_undo === 'function') G.PRiSM_undo();
            } else if (t.id === 'prism_ft_e_clear') {
                clearEvents();
            }
        });
    }

    // ── ct builder (Tab 1) ───────────────────────────────────────────────────
    function ctInputFromForm() {
        var o = {};
        ['So', 'Sw', 'Sg', 'co', 'cw', 'cg', 'cf', 'phi'].forEach(function (k) {
            var v = num(val('prism_ft_ct_' + k));
            if (v != null) o[k] = v;
        });
        o.cfMethod = val('prism_ft_ct_method') || 'hall';
        if (o.cfMethod !== 'user') delete o.cf;
        return o;
    }
    function ctResultHTML(r) {
        if (!r) return '';
        if (!r.ok) return msg('bad', '✗ ' + esc(r.reason));
        var rows = [
            ['So · co', r.inputs.So, r.inputs.co, r.terms.oil, r.sources.co],
            ['Sw · cw', r.inputs.Sw, r.inputs.cw, r.terms.water, r.sources.cw],
            ['Sg · cg', r.inputs.Sg, r.inputs.cg, r.terms.gas, r.sources.cg],
            ['cf', null, r.inputs.cf, r.terms.rock, r.cfMethodLabel]
        ];
        var h = '<div class="prism-ft-tw"><table><thead><tr><th>Term</th><th>Saturation</th><th>c (1/psi)</th><th>Contribution (1/psi)</th><th>Source</th></tr></thead><tbody>';
        rows.forEach(function (x) {
            h += '<tr><td>' + x[0] + '</td><td class="num">' + fmt(x[1], 3) + '</td><td class="num">' + fmt(x[2], 4) + '</td><td class="num">' + fmt(x[3], 4) + '</td><td>' + esc(x[4] || '—') + '</td></tr>';
        });
        h += '</tbody></table></div>';
        h += msg(r.isDefaulted ? 'warn' : 'ok', (r.isDefaulted ? '⚠ ' : '✓ ') + 'ct = ' + fmt(r.ct, 4) + ' 1/psi' +
                 (r.isDefaulted ? ' — uses default inputs: ' + esc(r.defaulted.join(', ')) + '. Enter measured values before relying on it.' : ''));
        r.warnings.forEach(function (w) { h += msg('warn', '⚠ ' + esc(w)); });
        return h;
    }
    function renderCtBuilder(host) {
        if (!host) return;
        ensureStyle();
        var f = ft();
        var inp = f.ctInput || {};
        var methods = Object.keys(CF_METHODS).map(function (k) {
            return '<option value="' + k + '"' + ((inp.cfMethod || 'hall') === k ? ' selected' : '') + '>' + CF_METHODS[k] + '</option>';
        }).join('');
        var h = '<div class="prism-ft" id="prism_ft_ct_root">' +
            '<div class="prism-ft-hint">ct = So·co + Sw·cw + Sg·cg + cf. Blank fields come from Well &amp; Test and the PVT correlations (Vasquez-Beggs co, Osif / Dodson-Standing cw, real-gas cg).</div>' +
            '<div class="prism-ft-grid">' +
            field('prism_ft_ct_So', 'So', inp.So) + field('prism_ft_ct_Sw', 'Sw', inp.Sw) + field('prism_ft_ct_Sg', 'Sg', inp.Sg) +
            field('prism_ft_ct_co', 'co (1/psi)', inp.co) + field('prism_ft_ct_cw', 'cw (1/psi)', inp.cw) + field('prism_ft_ct_cg', 'cg (1/psi)', inp.cg) +
            '<label>Rock compressibility<select id="prism_ft_ct_method">' + methods + '</select></label>' +
            field('prism_ft_ct_phi', 'φ (fraction)', inp.phi) + field('prism_ft_ct_cf', 'cf (1/psi, entered)', inp.cf) +
            '</div><div class="prism-ft-row"><button type="button" class="prism-ft-btn" id="prism_ft_ct_calc">Calculate</button>' +
            '<button type="button" class="prism-ft-btn prism-ft-btn--primary" id="prism_ft_ct_apply">Write ct to Well &amp; Test</button></div>' +
            '<div id="prism_ft_ct_res">' + ctResultHTML(ctBuild(inp)) + '</div>' +
            (f.ctBuild && isPos(f.ctBuild.ct) ? '<div class="prism-ft-hint">Last written: ct = ' + fmt(f.ctBuild.ct, 4) + ' 1/psi (' + esc(CF_METHODS[f.ctBuild.cfMethod] || '') + ').</div>' : '') +
            '</div>';
        host.innerHTML = h;
        var root = $('prism_ft_ct_root');
        if (!root || typeof root.addEventListener !== 'function') return;
        root.addEventListener('click', function (ev) {
            var t = ev && ev.target;
            if (!t) return;
            if (t.id !== 'prism_ft_ct_calc' && t.id !== 'prism_ft_ct_apply') return;
            var input = ctInputFromForm();
            ft().ctInput = input;
            save();
            var r = ctBuild(input);
            var box = $('prism_ft_ct_res');
            if (box) box.innerHTML = ctResultHTML(r);
            if (t.id === 'prism_ft_ct_apply' && r.ok) {
                ctApply(r);
                var b2 = $('prism_ft_ct_res');
                if (b2) b2.innerHTML = ctResultHTML(r) + msg('ok', '✓ ct written to Well &amp; Test (provenance: correlation).');
            }
        });
    }

    function registerPanels() {
        var specs = [
            [1, { id: 'prism_ct_builder', title: 'Total compressibility (ct) builder', order: 12, collapsed: true, render: renderCtBuilder }],
            [1, { id: 'prism_gauge_register', title: 'Gauge register', order: 30, render: renderGaugeRegister }],
            [1, { id: 'prism_events_log', title: 'Sequence of events', order: 35, render: renderEventsLog }],
            [2, { id: 'prism_gauge_resolution', title: 'Gauge resolution check', order: 40, when: function () { return ft().gauges.length > 0; }, render: renderGaugeCheckPanel }]
        ];
        specs.forEach(function (x) {
            if (typeof G.PRiSM_registerTabPanel === 'function') {
                try { if (G.PRiSM_registerTabPanel(x[0], x[1])) return; } catch (e) { /* fall back */ }
            }
            G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
            var arr = G.PRiSM_tabPanels[x[0]] = G.PRiSM_tabPanels[x[0]] || [];
            for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === x[1].id) { arr[i] = x[1]; return; }
            arr.push(x[1]);
        });
    }
    registerPanels();

    // Refresh mounted panels on the shared events (no polling).
    if (!G.__PRiSM_fieldToolsListeners) {
        G.__PRiSM_fieldToolsListeners = true;
        on('prism:gauges-changed', function () {
            _chkCache.key = null;
            rerender('prism_ft_gauges_root', renderGaugeRegister);
            rerender('prism_ft_gcheck_root', renderGaugeCheckPanel);
            redraw();
        });
        on('prism:events-changed', function () { rerender('prism_ft_events_root', renderEventsLog); });
        ['prism:fit-updated', 'prism:dataset-loaded', 'prism:period-changed', 'prism:well-changed'].forEach(function (type) {
            on(type, function () {
                _chkCache.key = null;
                rerender('prism_ft_gcheck_root', renderGaugeCheckPanel);
                var c = $('prism_ft_g_check');
                if (c) { try { c.innerHTML = checkSummaryHTML(gaugeResolutionCheck()); } catch (e) { /* ignore */ } }
            });
        });
        on('prism:period-changed', function (ev) {
            var src = ev && ev.detail && ev.detail.source;
            if (src === 'undo' || src === 'events') {
                var u = $('prism_ft_undo');
                if (u) u.disabled = !(typeof G.PRiSM_canUndo === 'function' && G.PRiSM_canUndo());
            }
        });
    }

    // =========================================================================
    // SECTION 7 — EXPORTS
    // =========================================================================

    G.PRiSM_listGauges = listGauges;
    G.PRiSM_setGauge = setGauge;
    G.PRiSM_removeGauge = removeGauge;
    G.PRiSM_setPrimaryGauge = setPrimaryGauge;
    G.PRiSM_primaryGauge = primaryGauge;
    G.PRiSM_gaugeResolutionCheck = gaugeResolutionCheck;
    G.PRiSM_gaugeSamplingLimit = samplingLimit;
    G.PRiSM_addEvent = addEvent;
    G.PRiSM_listEvents = listEvents;
    G.PRiSM_removeEvent = removeEvent;
    G.PRiSM_clearEvents = clearEvents;
    G.PRiSM_setEventClock = setEventClock;
    G.PRiSM_eventsToRateSchedule = eventsToRateSchedule;
    G.PRiSM_seedPeriodsFromEvents = seedPeriodsFromEvents;
    G.PRiSM_rockCompressibility = rockCompressibility;
    G.PRiSM_ctBuild = ctBuild;
    G.PRiSM_ctApply = ctApply;
    G.PRiSM_renderGaugeRegister = renderGaugeRegister;
    G.PRiSM_renderEventsLog = renderEventsLog;
    G.PRiSM_renderCtBuilder = renderCtBuilder;
    G.PRiSM_renderGaugeCheckPanel = renderGaugeCheckPanel;
    G.PRiSM_EVENT_TYPES = EVENT_TYPES;

})();

// ─── END 39-prism-fieldtools ─────────────────────────────────────────────

