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
//   PRiSM_declineDiagnostics(ds?, {L}) → {t (days), q, D (1/day), b, bLate}
//   PRiSM_PLOT_REGISTRY += declineD, declineB (D(t) and b(t) diagnostics, rate only)
//   PRiSM_plot_decline_D / PRiSM_plot_decline_b (canvas, data, opts)
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
// SECTION 9b — DECLINE DIAGNOSTICS: D(t) AND b(t)  (ROADMAP N8)
// ─────────────────────────────────────────────────────────────────────────────
// Loss-ratio definitions (Arps 1945; Johnson & Bollens 1927 "loss ratio"):
//   D(t) = −(dq/dt)/q = −d ln q/dt            (nominal decline rate, 1/day)
//   b(t) = d(1/D)/dt                           (derivative of the loss ratio)
// For an Arps hyperbolic q = qi/(1+b·Di·t)^(1/b): D = Di/(1+b·Di·t) and b(t) = b
// exactly; exponential b = 0, harmonic b = 1. Both derivatives use the
// weighted 3-point central difference in t (exact for a quadratic, so exact
// for the linear 1/D of an Arps decline) with the neighbours at least L apart
// in ln t (smoothing window, default 0.2). Noise is amplified twice for b(t):
// read its trend, not single points.
function PRiSM_declineDiagnostics(ds, opts) {
    opts = opts || {};
    if (ds == null) ds = G.PRiSM_dataset;
    var s = _rateSeries(ds, { positiveT: true, tminDays: opts.tminDays, tmaxDays: opts.tmaxDays });
    if (!s || s.t.length < 5) return { ok: false, reason: 'D(t) and b(t) need at least 5 samples with t > 0 and q > 0.' };
    var L = _pos(opts.L) ? opts.L : 0.2;
    return _declineDiag(s.t, s.q, L, opts);
}
// dy/dt with the weighted 3-point central difference in t (exact for a
// quadratic), the neighbours chosen at least L apart in ln t (smoothing
// window as for the Bourdet derivative); one-sided at the ends.
function _tDeriv(t, y, L) {
    var n = t.length, d = new Array(n);
    for (var i = 0; i < n; i++) {
        var i1 = i - 1, i2 = i + 1, li = Math.log(t[i]);
        while (i1 > 0 && li - Math.log(t[i1]) < L) i1--;
        while (i2 < n - 1 && Math.log(t[i2]) - li < L) i2++;
        var v = NaN;
        if (i1 >= 0 && i2 < n && _num(y[i1]) && _num(y[i2]) && _num(y[i])) {
            var h1 = t[i] - t[i1], h2 = t[i2] - t[i];
            v = ((y[i] - y[i1]) / h1) * h2 / (h1 + h2) + ((y[i2] - y[i]) / h2) * h1 / (h1 + h2);
        } else if (i1 < 0 && i2 < n && _num(y[i2]) && _num(y[i])) v = (y[i2] - y[i]) / (t[i2] - t[i]);
        else if (i2 >= n && i1 >= 0 && _num(y[i1]) && _num(y[i])) v = (y[i] - y[i1]) / (t[i] - t[i1]);
        d[i] = v;
    }
    return d;
}
function _declineDiag(tDays, q, L, opts) {
    opts = opts || {};
    var n = tDays.length, lq = [], i;
    for (i = 0; i < n; i++) lq.push(Math.log(q[i]));
    var dlnq = _tDeriv(tDays, lq, L);
    var D = [], invD = [];
    for (i = 0; i < n; i++) {
        var d = -dlnq[i];
        D.push(_num(d) ? d : NaN);
        invD.push(_num(d) && d > 0 ? 1 / d : NaN);
    }
    // 1/D is only differentiated where it is defined on both sides.
    var bArr = _tDeriv(tDays, invD, L);
    for (i = 0; i < n; i++) if (!_num(invD[i])) bArr[i] = NaN;
    var late = [];
    for (i = Math.floor(n / 2); i < n; i++) if (_num(bArr[i])) late.push(bArr[i]);
    var warnings = [];
    var nNeg = D.filter(function (v) { return _num(v) && v <= 0; }).length;
    if (nNeg > 0.2 * n) warnings.push('The rate rises over ' + nNeg + ' of ' + n + ' points: D(t) ≤ 0 there (no decline), so b(t) is undefined.');
    var bMed = _median(late);
    if (_num(bMed) && bMed > 1) warnings.push('Late b(t) ≈ ' + bMed.toFixed(2) + ' > 1: transient (linear or bilinear) flow — an Arps b > 1 forecast needs a terminal decline.');
    return {
        ok: true, n: n, t: tDays.slice(), q: q.slice(), D: D, b: bArr, invD: invD, L: L,
        bLate: bMed, Dlast: D[n - 1], units: { t: 'days', D: '1/day' }, warnings: warnings
    };
}
// Model D(t), b(t) for the current rate fit, on the data's time grid.
function _declineDiagModel(tDays, L) {
    var fit = _currentRateFit();
    if (!fit) return null;
    var lo = tDays[0], hi = tDays[tDays.length - 1];
    if (!(lo > 0) || !(hi > lo)) return null;
    var grid = [];
    for (var i = 0; i <= 80; i++) grid.push(lo * Math.pow(hi / lo, i / 80));
    var qm = PRiSM_declineRate(fit.modelKey, fit.params, grid);
    var ok = qm.every(function (v) { return _pos(v); });
    if (!ok) return null;
    var d = _declineDiag(grid, qm, Math.min(L, 0.1), {});
    d.modelKey = fit.modelKey;
    return d;
}
function _declineDiagPlot(canvas, key, data, opts) {
    var T = _theme();
    var diag = (data && data.diag) || PRiSM_declineDiagnostics(G.PRiSM_dataset, {});
    var isB = key === 'declineB';
    var spec = {
        title: isB ? 'b(t) = d(1/D)/dt — decline exponent diagnostic' : 'D(t) = −d ln q/dt — loss-ratio diagnostic',
        shortTitle: isB ? 'b(t)' : 'D(t)', plotKey: key
    };
    if (!diag || !diag.ok) { spec.message = (diag && diag.reason) || 'No rate data.'; return _drawChart(canvas, spec, opts || {}); }
    var mod = (data && data.model !== undefined) ? data.model : _declineDiagModel(diag.t, diag.L);
    spec.xKind = 'log'; spec.xLabel = 'Time (days)';
    if (isB) {
        spec.yKind = 'lin'; spec.yLabel = 'b(t) (–)';
        var bClip = diag.b.map(function (v) { return _num(v) && v > -2 && v < 4 ? v : NaN; });
        spec.series = [{ x: diag.t, y: bClip, color: T.accent, label: 'b(t) from data' }];
        spec.extraY = [0, 1];
        spec.series.push({ x: [diag.t[0], diag.t[diag.n - 1]], y: [1, 1], color: T.text3, type: 'line', dash: [3, 4], width: 1, label: 'b = 1 (harmonic)', range: false });
        spec.series.push({ x: [diag.t[0], diag.t[diag.n - 1]], y: [0, 0], color: T.text3, type: 'line', dash: [1, 3], width: 1, label: 'b = 0 (exponential)', range: false });
        if (mod && mod.ok) spec.series.push({ x: mod.t, y: mod.b, color: T.purple, type: 'line', dash: [6, 4], width: 1.5, label: 'Model b(t) (' + _modelName(mod.modelKey) + ')', range: false });
        spec.notes = [_num(diag.bLate) ? 'Late-time median b ≈ ' + _fmt(diag.bLate, 3) : 'b(t) undefined (no decline)'];
    } else {
        spec.yKind = 'log'; spec.yLabel = 'D(t), 1/day';
        spec.series = [{ x: diag.t, y: diag.D, color: T.accent, label: 'D(t) from data' }];
        if (mod && mod.ok) spec.series.push({ x: mod.t, y: mod.D, color: T.purple, type: 'line', dash: [6, 4], width: 1.5, label: 'Model D(t) (' + _modelName(mod.modelKey) + ')', range: false });
        spec.notes = ['Straight line of slope −1: harmonic-like decline; flat: exponential.'];
    }
    return _drawChart(canvas, spec, opts || {});
}
function _buildDeclineDiag(key, dsIn) {
    var ds = (dsIn && _isArr(dsIn.t)) ? dsIn : (G.PRiSM_dataset || null);
    var diag = PRiSM_declineDiagnostics(ds, {});
    var data = { diag: diag, plotKey: key };
    if (diag.ok) { data.t = diag.t.slice(); data.q = diag.q.slice(); }
    return { data: data, opts: { timeUnit: 'd', xLabel: 'Time (days)', plotKey: key } };
}
var DECLINE_DIAG_DEFS = {
    declineD: { label: 'D(t) loss-ratio diagnostic', fn: 'PRiSM_plot_decline_D' },
    declineB: { label: 'b(t) decline-exponent diagnostic', fn: 'PRiSM_plot_decline_b' }
};


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
G.PRiSM_declineDiagnostics = PRiSM_declineDiagnostics;
G.PRiSM_plot_decline_D = function (canvas, data, opts) { return _declineDiagPlot(canvas, 'declineD', data, opts); };
G.PRiSM_plot_decline_b = function (canvas, data, opts) { return _declineDiagPlot(canvas, 'declineB', data, opts); };
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
// Decline diagnostics D(t), b(t) — rate data only (N8).
Object.keys(DECLINE_DIAG_DEFS).forEach(function (k) {
    var d = DECLINE_DIAG_DEFS[k];
    G.PRiSM_PLOT_REGISTRY[k] = {
        fn: d.fn, label: d.label, mode: 'decline', title: d.label, needs: ['q'],
        build: (function (key) { return function (ctx) { return _buildDeclineDiag(key, ctx && ctx.ds); }; })(k)
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

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var log = (G.console && G.console.log) ? G.console.log.bind(G.console) : function () {};
    var results = [];
    function check(name, ok, info) { results.push({ name: name, ok: !!ok, info: info }); }
    function rel(a, b) { return Math.abs(a - b) / Math.abs(b); }
    try {
        var I = G.PRiSM_rtaDcaInternals;
        // 1. Arps closed forms
        var eur = I.arpsNp(3650, 1000, 0.01, 0.5);
        check('Arps EUR(3650 d) = 189,610', rel(eur, 189610) < 1e-3, eur);
        var tab = I.arpsTab(1000, 0.01, 0.5, 10);
        check('Arps t_ab(q_ab = 10) = 1800 d', Math.abs(tab - 1800) < 1e-6, tab);
        check('Arps b → 0 matches exponential', rel(I.arpsQ(100, 1000, 0.01, 1e-17), 367.879441) < 1e-6);
        // numeric Simpson cross-check for b = 1.5
        var qi = 1000, Di = 0.01, b = 1.5, T = 5000, N = 20000, h = T / N, s = I.arpsQ(0, qi, Di, b) + I.arpsQ(T, qi, Di, b);
        for (var k = 1; k < N; k++) s += (k % 2 ? 4 : 2) * I.arpsQ(k * h, qi, Di, b);
        check('Arps b = 1.5 cumulative vs Simpson', rel(I.arpsNp(T, qi, Di, b), s * h / 3) < 1e-4);
        // 2. decline results with Dmin continuity
        var dmin = I.nominalFromEffective(0.06);
        var spec = I.declineSpec('arps', { qi: 1000, Di: 0.01, b: 1.2 }, dmin);
        var ts = spec.tSwitch, e = 1e-6 * ts;
        var qL = spec.q(ts * (1 - 1e-12)), qR = spec.q(ts * (1 + 1e-12));
        check('Dmin switch: q continuous', rel(qL, qR) < 1e-9);
        var dL = (spec.q(ts - e) - spec.q(ts - 2 * e)) / e, dR = (spec.q(ts + 2 * e) - spec.q(ts + e)) / e;
        check('Dmin switch: dq/dt continuous', rel(dL, dR) < 1e-3);
        // 3. local fit recovers Arps
        var t = [], q = [];
        for (var j = 0; j <= 60; j++) { t.push(j * 20 * 24); q.push(I.arpsQ(j * 20, 1000, 0.01, 0.5)); }
        var fit = I.fitLocal('arps', { t: t, q: q, p: null }, {});
        check('local fit recovers Arps qi/Di/b', fit.ok && rel(fit.params.qi, 1000) < 1e-4 && rel(fit.params.Di, 0.01) < 1e-4 && rel(fit.params.b, 0.5) < 1e-4, fit.params);
        var res = G.PRiSM_declineResults(fit, { t: t, q: q }, { q_ab: 1, t_end_days: 3650, bootstrap: 0 });
        check('declineResults EUR to 3650 d', res.ok && rel(res.eur, 189610) < 1e-3 && res.limitedBy === 'time', res.eur);
        // 4. RTA: constant-rate linear flow → xf√k
        var B = 1.2, mu = 0.8, h2 = 60, phi = 0.08, ct = 1.5e-5, qc = 200, xk = 1000, tt = [], pp = [], qq = [];
        for (var m = 0; m < 50; m++) {
            var th = 24 * Math.pow(10, m / 49 * Math.log10(300));
            tt.push(th); qq.push(qc);
            pp.push(5000 - (4.064 * qc * B / (h2 * xk)) * Math.sqrt(mu * th / (phi * ct)));
        }
        var rta = G.PRiSM_rtaData({ t: tt, p: pp, q: qq }, { pi: 5000, B: B, mu: mu, h: h2, phi: phi, ct: ct, rw: 0.3, testType: 'drawdown' }, { L: 0.1 });
        var lf = G.PRiSM_rtaLinearFlow(rta, {});
        check('linear flow xf√k = 1000', lf.ok && rel(lf.xf_sqrt_k, 1000) < 0.01, lf.xf_sqrt_k);
        check('tick format 100/120/850', I.fmtTick(100) === '100' && I.fmtTick(120) === '120' && I.fmtTick(850) === '850');
    } catch (err) {
        check('self-test threw', false, err && err.message);
    }
    var fails = results.filter(function (r) { return !r.ok; });
    log('[35-rta-dca self-test] ' + (results.length - fails.length) + '/' + results.length + ' passed');
    fails.forEach(function (f) { log('  FAIL ' + f.name + (f.info !== undefined ? ' → ' + JSON.stringify(f.info) : '')); });
})();
