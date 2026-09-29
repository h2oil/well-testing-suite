// =============================================================================
// PRiSM — Regression engine (layer 05)
// Levenberg-Marquardt + bootstrap + superposition + Agarwal time +
// dimensional (field-unit) pressure fits + rate (decline) fits.
// -----------------------------------------------------------------------------
// Public exports (all on window.*):
//
//   PRiSM_lm                   — Levenberg-Marquardt least squares (signature
//                                unchanged; new opts: logKeys, gtol)
//   PRiSM_bootstrap            — residual bootstrap CIs + P10/P50/P90
//   PRiSM_superposition        — convolve a rate history over a unit-rate model
//   PRiSM_sandface_convolution — multi-rate Agarwal equivalent time + Δp
//   PRiSM_agarwalTime          — Agarwal equivalent time for one flow period
//   PRiSM_fitPhysical          — field-unit pressure fit (k, C, S, pi, shape)
//                                → LastFit-shaped object (contract C4), not stored
//   PRiSM_fitRate              — decline fit on q (t in days) → LastFit-shaped object
//   PRiSM_runRegression        — Tab 6 glue: dispatch by model kind, store via
//                                PRiSM_setLastFit, never writes PRiSM_state.match
//
// Lower-level helpers (exposed for unit tests and other layers):
//   PRiSM_invertMatrix, PRiSM_solveLinear, PRiSM_jacobianForward,
//   PRiSM_tQuantile975
//
// Contracts consumed (all optional — local fallbacks when absent):
//   C1 PRiSM_getWell, C2 PRiSM_getAnalysisData, C3 PRiSM_physicalModel,
//   C4 PRiSM_setLastFit, C7 PRiSM_evalModelCurve / PRiSM_drawActivePlot /
//   PRiSM_setModel, PRiSM_compute_bourdet.
//
// Units: t in HOURS for pressure data (Δt since start of the analysed flow
// period), p in psia, q in STB/d (oil) or Mscf/d (gas). Rate (decline) fits
// run in DAYS: t_days = t_h / 24 unless the dataset says otherwise, and Di is
// reported in 1/day.
//
// Field-unit relations (contract C3):
//   A  = 141.2 q B μ / (k h)            psi per unit pD
//   B  = 0.0002637 k / (φ μ ct Lref²)   tD per hour
//   Cd = 0.8936 C / (φ ct h Lref²)
//   rinv = √(k t / (948 φ μ ct))
// =============================================================================


(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});
var LN10 = Math.LN10;


// =============================================================================
// SECTION 1 — LINEAR ALGEBRA (Gauss-Jordan inversion + linear solver)
// =============================================================================

function _zeros2D(n, m) {
    if (m == null) m = n;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
        var row = new Array(m);
        for (var j = 0; j < m; j++) row[j] = 0;
        out[i] = row;
    }
    return out;
}

function _copy2D(A) {
    var n = A.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = A[i].slice();
    return out;
}

/**
 * Invert an n×n matrix via Gauss-Jordan elimination with partial pivoting.
 * The input is preserved. Throws if A is singular or non-square.
 */
function PRiSM_invertMatrix(A) {
    if (!Array.isArray(A) || !A.length) throw new Error('PRiSM_invertMatrix: empty matrix');
    var n = A.length;
    for (var i = 0; i < n; i++) {
        if (!Array.isArray(A[i]) || A[i].length !== n) {
            throw new Error('PRiSM_invertMatrix: matrix must be square (got ' + n + 'x' + (A[i] ? A[i].length : '?') + ')');
        }
    }
    var M = new Array(n);
    for (var r = 0; r < n; r++) {
        var row = new Array(2 * n);
        for (var c = 0; c < n; c++) row[c] = A[r][c];
        for (var c2 = 0; c2 < n; c2++) row[n + c2] = (r === c2) ? 1 : 0;
        M[r] = row;
    }
    for (var k = 0; k < n; k++) {
        var pivotRow = k;
        var pivotVal = Math.abs(M[k][k]);
        for (var rr = k + 1; rr < n; rr++) {
            var v = Math.abs(M[rr][k]);
            if (v > pivotVal) { pivotVal = v; pivotRow = rr; }
        }
        if (!(pivotVal >= 1e-300)) {
            throw new Error('PRiSM_invertMatrix: matrix is singular (pivot ' + pivotVal + ' at column ' + k + ')');
        }
        if (pivotRow !== k) { var tmp = M[k]; M[k] = M[pivotRow]; M[pivotRow] = tmp; }
        var inv = 1.0 / M[k][k];
        for (var c3 = 0; c3 < 2 * n; c3++) M[k][c3] *= inv;
        for (var ir = 0; ir < n; ir++) {
            if (ir === k) continue;
            var f = M[ir][k];
            if (f === 0) continue;
            for (var c4 = 0; c4 < 2 * n; c4++) M[ir][c4] -= f * M[k][c4];
        }
    }
    var Ainv = _zeros2D(n, n);
    for (var rr2 = 0; rr2 < n; rr2++) {
        for (var cc = 0; cc < n; cc++) Ainv[rr2][cc] = M[rr2][n + cc];
    }
    return Ainv;
}

/** Solve A·x = b (Gauss-Jordan with partial pivoting). */
function PRiSM_solveLinear(A, b) {
    var n = A.length;
    if (b.length !== n) throw new Error('PRiSM_solveLinear: dimension mismatch (A is ' + n + 'x' + n + ', b is ' + b.length + ')');
    var M = new Array(n);
    for (var r = 0; r < n; r++) {
        var row = new Array(n + 1);
        for (var c = 0; c < n; c++) row[c] = A[r][c];
        row[n] = b[r];
        M[r] = row;
    }
    for (var k = 0; k < n; k++) {
        var pivotRow = k;
        var pivotVal = Math.abs(M[k][k]);
        for (var rr = k + 1; rr < n; rr++) {
            var v = Math.abs(M[rr][k]);
            if (v > pivotVal) { pivotVal = v; pivotRow = rr; }
        }
        if (!(pivotVal >= 1e-300)) {
            throw new Error('PRiSM_solveLinear: matrix is singular (pivot ' + pivotVal + ' at column ' + k + ')');
        }
        if (pivotRow !== k) { var tmp = M[k]; M[k] = M[pivotRow]; M[pivotRow] = tmp; }
        var inv = 1.0 / M[k][k];
        for (var c2 = 0; c2 <= n; c2++) M[k][c2] *= inv;
        for (var ir = 0; ir < n; ir++) {
            if (ir === k) continue;
            var f = M[ir][k];
            if (f === 0) continue;
            for (var c3 = 0; c3 <= n; c3++) M[ir][c3] -= f * M[k][c3];
        }
    }
    var x = new Array(n);
    for (var i = 0; i < n; i++) x[i] = M[i][n];
    return x;
}

// Inverse of a symmetric positive semi-definite matrix via diagonal
// (Jacobi) scaling, falling back to a small ridge. Returns null on failure.
function _safeInvert(A) {
    var n = A.length;
    var d = new Array(n);
    for (var i = 0; i < n; i++) d[i] = (A[i][i] > 0) ? 1 / Math.sqrt(A[i][i]) : 1;
    var S = _zeros2D(n, n);
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) S[r][c] = A[r][c] * d[r] * d[c];
    var inv = null;
    try { inv = PRiSM_invertMatrix(S); }
    catch (e) {
        for (var k = 0; k < n; k++) S[k][k] += 1e-10;
        try { inv = PRiSM_invertMatrix(S); } catch (e2) { return null; }
    }
    for (var r2 = 0; r2 < n; r2++) for (var c2 = 0; c2 < n; c2++) inv[r2][c2] *= d[r2] * d[c2];
    return inv;
}


// =============================================================================
// SECTION 2 — JACOBIAN VIA FORWARD DIFFERENCES
// =============================================================================
// Step size (relative): h_j = derivStep · max(|p_j|, floor_j) with
//   floor_j = min(1e-4 · (max − min), 1e-3)   for finite bounds
//   floor_j = 1e-3                             otherwise.
// The old max(|p|, 1) floor was far larger than small-magnitude parameters
// (λ ≈ 1e-6 was stepped by 1e-4). A pure 1e-8·range floor under-runs the
// precision of Stehfest-inverted models when a parameter sits at 0 (S = 0),
// so the floor is capped from both sides. Log-scaled keys are differenced in
// log10 space by PRiSM_lm, where |p| is O(1).
// =============================================================================

function _fdScale(p0, lo, hi) {
    var range = hi - lo;
    var floor = (isFinite(range) && range > 0) ? Math.min(1e-4 * range, 1e-3) : 1e-3;
    return Math.max(Math.abs(p0), floor);
}

/**
 * n × n_free forward-difference Jacobian ∂model_i/∂p_j.
 * @param bounds optional [[lo, hi], ...] aligned with freeKeys (a backward
 *               step is used when a forward step would leave the box).
 */
function PRiSM_jacobianForward(modelFn, t, params, baseline, freeKeys, derivStep, bounds) {
    var n = baseline.length;
    var nf = freeKeys.length;
    var J = _zeros2D(n, nf);
    for (var j = 0; j < nf; j++) {
        var k = freeKeys[j];
        var p0 = params[k];
        var lo = (bounds && bounds[j]) ? bounds[j][0] : -Infinity;
        var hi = (bounds && bounds[j]) ? bounds[j][1] : Infinity;
        var h = derivStep * _fdScale(p0, lo, hi);
        var dir = 1;
        if (isFinite(hi) && (p0 + h) > hi) dir = -1;
        if (dir < 0 && isFinite(lo) && (p0 - h) < lo) {
            h = Math.max(1e-15, Math.min(h, 0.5 * (hi - lo)));
            dir = (Math.abs(hi - p0) >= Math.abs(p0 - lo)) ? 1 : -1;
        }
        var pert = {};
        for (var k2 in params) if (Object.prototype.hasOwnProperty.call(params, k2)) pert[k2] = params[k2];
        pert[k] = p0 + dir * h;
        var fpert = null;
        try { fpert = modelFn(t, pert); } catch (err) { fpert = null; }
        if (!fpert || !_allFinite(fpert)) {
            var ok = false, hh = h;
            for (var s = 0; s < 3; s++) {
                hh *= 0.1;
                pert[k] = p0 + dir * hh;
                try { fpert = modelFn(t, pert); if (fpert && _allFinite(fpert)) { ok = true; h = hh; break; } }
                catch (err2) { /* keep shrinking */ }
            }
            if (!ok) { for (var i = 0; i < n; i++) J[i][j] = 0; continue; }
        }
        var inv_h = 1.0 / (dir * h);
        for (var i2 = 0; i2 < n; i2++) J[i2][j] = (fpert[i2] - baseline[i2]) * inv_h;
    }
    return J;
}

function _allFinite(a) {
    for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) return false;
    return true;
}


// =============================================================================
// SECTION 3 — LEVENBERG-MARQUARDT NON-LINEAR LEAST SQUARES
// =============================================================================
//     (JᵀWJ + λ·diag(JᵀWJ)) · Δ = JᵀW·r
// Accept → λ·lambdaDown; reject → λ·lambdaUp.
//
// Convergence (honest):
//   'tolerance'  every free parameter moved less than `tolerance` (relative,
//                in the internal — log10 for log keys — coordinates);
//   'plateau'    SSR improved by < 1e-12 (relative) on 5 accepted steps;
//   'stationary' no step could be accepted, but the Gauss-Newton predicted
//                reduction (over parameters not pinned at a bound) is below
//                gtol·SSR — i.e. already at a (constrained) minimum;
//   'exact'      SSR ≈ 0.
// 'lambda-max' and 'maxIter' stops return converged:false.
//
// Statistics: σ² = Σ wᵢ rᵢ² / (n − p) (weighted), cov = σ² (JᵀWJ)⁻¹,
// CI = value ± t₀.₉₇₅(n−p)·se. Log keys get CIs in log space (then
// back-transformed), and all CIs are clipped to the bounds.
// identifiable[key] = false when the CI half-width exceeds |value|, when the
// key is correlated |r| > 0.98 with another free key, or when it sits at a bound.
// =============================================================================

var LM_DEFAULTS = {
    maxIter:        100,
    tolerance:      1e-6,
    gtol:           1e-6,
    lambda0:        0.001,
    lambdaUp:       10,
    lambdaDown:     0.1,
    lambdaMax:      1e10,
    lambdaMin:      1e-12,
    derivStep:      1e-4,
    weightingMode:  'uniform',   // 'uniform' | 'inverse_p' | 'inverse_log'
    onIter:         null,
    marquardtScale: 'jjdiag',    // 'jjdiag' | 'identity'
    logKeys:        null         // [key, ...] or {key:true} — fitted in log10
};

// Two-sided 95% Student-t quantiles, ν = 1..30.
var _T975 = [NaN, 12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060,
    2.2622, 2.2281, 2.2010, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009,
    2.0930, 2.0860, 2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484,
    2.0452, 2.0423];

/** Student-t 0.975 quantile for ν degrees of freedom (table ≤ 30, Cornish-Fisher above). */
function PRiSM_tQuantile975(nu) {
    nu = Math.floor(nu);
    if (!(nu >= 1)) return NaN;
    if (nu <= 30) return _T975[nu];
    var z = 1.959963985, z2 = z * z, z3 = z2 * z, z5 = z3 * z2, z7 = z5 * z2, z9 = z7 * z2;
    return z + (z3 + z) / (4 * nu)
             + (5 * z5 + 16 * z3 + 3 * z) / (96 * nu * nu)
             + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * nu * nu * nu)
             + (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * nu * nu * nu * nu);
}

function _buildWeights(p, mode, explicit) {
    var n = p.length;
    var W = new Array(n);
    if (Array.isArray(explicit) && explicit.length === n) {
        for (var i = 0; i < n; i++) W[i] = (explicit[i] > 0) ? explicit[i] : 0;
        return W;
    }
    if (mode === 'inverse_p') {
        for (var i2 = 0; i2 < n; i2++) {
            var ap = Math.abs(p[i2]);
            W[i2] = (ap > 1e-20) ? (1.0 / (ap * ap)) : 1.0;
        }
        return W;
    }
    if (mode === 'inverse_log') {
        for (var i3 = 0; i3 < n; i3++) {
            var lp = Math.log(Math.max(Math.abs(p[i3]), 1e-20));
            W[i3] = 1.0 / Math.max(lp * lp, 1e-6);
        }
        return W;
    }
    for (var i4 = 0; i4 < n; i4++) W[i4] = 1.0;
    return W;
}

function _ssr(yObs, yMod, W) {
    var s = 0;
    for (var i = 0; i < yObs.length; i++) {
        var r = yObs[i] - yMod[i];
        s += W[i] * r * r;
    }
    return s;
}

// Free parameters: numeric, finite, not frozen, not injected ('__*').
function _activeParams(params0, freeze) {
    var keys = [];
    for (var k in params0) {
        if (!Object.prototype.hasOwnProperty.call(params0, k)) continue;
        if (k.indexOf('__') === 0) continue;
        if (freeze && freeze[k] === true) continue;
        var v = params0[k];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        keys.push(k);
    }
    return keys;
}

function _keySet(x) {
    var out = {};
    if (!x) return out;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) out[x[i]] = true; return out; }
    if (typeof x === 'object') { for (var k in x) if (x[k]) out[k] = true; }
    return out;
}

function _clipInternal(params, freeKeys, ib) {
    for (var j = 0; j < freeKeys.length; j++) {
        var k = freeKeys[j], b = ib[k];
        if (params[k] < b[0]) params[k] = b[0];
        if (params[k] > b[1]) params[k] = b[1];
    }
    return params;
}

/**
 * Levenberg-Marquardt least-squares fit.
 *
 * @param {Function} modelFn  f(t_array, params_obj) → y_array
 * @param {object}   data     { t: number[], p: number[], weights?: number[] }
 * @param {object}   params0  initial guess (strings / '__*' keys pass through)
 * @param {object=}  bounds   { key: [lo, hi], ... }  (external units)
 * @param {object=}  freeze   { key: true|false, ... }
 * @param {object=}  opts     see LM_DEFAULTS
 * @return {object} { params, stderr, ci95, ssr, rmse, r2, aic, iterations,
 *                    converged, stopReason, covariance, corr, identifiable,
 *                    atBound, sigma2, dof, tQuantile, residualHistory,
 *                    nFreeParams, nObs, freeKeys, logKeys }
 */
function PRiSM_lm(modelFn, data, params0, bounds, freeze, opts) {
    if (typeof modelFn !== 'function') throw new Error('PRiSM_lm: modelFn must be a function');
    if (!data || !Array.isArray(data.t) || !Array.isArray(data.p)) {
        throw new Error('PRiSM_lm: data must have t[] and p[] arrays');
    }
    if (data.t.length !== data.p.length) {
        throw new Error('PRiSM_lm: data.t and data.p must have the same length');
    }
    if (data.t.length < 2) throw new Error('PRiSM_lm: need at least 2 data points');

    var O = {};
    for (var k0 in LM_DEFAULTS) if (Object.prototype.hasOwnProperty.call(LM_DEFAULTS, k0)) O[k0] = LM_DEFAULTS[k0];
    if (opts) for (var k1 in opts) if (Object.prototype.hasOwnProperty.call(opts, k1) && opts[k1] !== undefined) O[k1] = opts[k1];

    var logSet = _keySet(O.logKeys);
    var freeKeys = _activeParams(params0, freeze);

    // Internal coordinates: log10 for positive log keys.
    var isLog = {}, ib = {}, extBounds = {};
    for (var fk = 0; fk < freeKeys.length; fk++) {
        var key = freeKeys[fk];
        var b = bounds && bounds[key];
        var lo = (b && isFinite(b[0])) ? b[0] : -Infinity;
        var hi = (b && isFinite(b[1])) ? b[1] : Infinity;
        extBounds[key] = [lo, hi];
        isLog[key] = !!logSet[key] && params0[key] > 0;
        if (isLog[key]) {
            ib[key] = [lo > 0 ? Math.log10(lo) : -Infinity, hi > 0 ? Math.log10(hi) : Infinity];
        } else {
            ib[key] = [lo, hi];
        }
    }
    function toExt(pInt) {
        var o = {};
        for (var kk in pInt) if (Object.prototype.hasOwnProperty.call(pInt, kk)) o[kk] = pInt[kk];
        for (var j = 0; j < freeKeys.length; j++) {
            var kj = freeKeys[j];
            if (isLog[kj]) o[kj] = Math.pow(10, pInt[kj]);
        }
        return o;
    }
    var fInt = function (t, pInt) { return modelFn(t, toExt(pInt)); };

    var params = {};
    for (var kk in params0) if (Object.prototype.hasOwnProperty.call(params0, kk)) params[kk] = params0[kk];
    for (var fk2 = 0; fk2 < freeKeys.length; fk2++) {
        var kf = freeKeys[fk2];
        if (isLog[kf]) params[kf] = Math.log10(params0[kf]);
    }
    _clipInternal(params, freeKeys, ib);

    var W = _buildWeights(data.p, O.weightingMode, data.weights);
    var ctx = { isLog: isLog, ib: ib, extBounds: extBounds, toExt: toExt, stopReason: 'none' };

    var yMod = fInt(data.t, params);
    var ssr = _ssr(data.p, yMod, W);
    if (!freeKeys.length) {
        ctx.stopReason = 'no-free-params';
        return _buildResult(params, freeKeys, null, data, yMod, W, ssr, 0, false, [ssr], ctx);
    }
    if (!isFinite(ssr)) {
        ctx.stopReason = 'non-finite-start';
        return _buildResult(params, freeKeys, null, data, yMod, W, ssr, 0, false, [ssr], ctx);
    }

    var boundArr = freeKeys.map(function (k) { return ib[k]; });
    var history = [ssr];
    var lambda = O.lambda0;
    var iter = 0;
    var converged = false;
    var stagnantSteps = 0;
    var nf = freeKeys.length;
    var n = data.p.length;
    // 'exact' fit: weighted RMS residual ≤ 1e-7 of max(1, |y|) — at the
    // precision of the Laplace-inversion models themselves.
    var exactSsr = 0;
    for (var ex = 0; ex < n; ex++) exactSsr += W[ex] * Math.max(1, data.p[ex] * data.p[ex]);
    exactSsr *= 1e-14;

    // Optional budget: O.deadline (wall clock, ms since epoch) and/or
    // O.shouldStop() (e.g. an evaluation-cost budget). The race fits use it so
    // one slow model cannot block the UI for minutes. Stops with
    // converged:false, stopReason 'budget'.
    var hasDeadline = typeof O.deadline === 'number' && isFinite(O.deadline);
    var overBudget = function () {
        if (hasDeadline && Date.now() > O.deadline) return true;
        if (typeof O.shouldStop === 'function') { try { return !!O.shouldStop(); } catch (e) { return false; } }
        return false;
    };
    while (iter < O.maxIter) {
        iter++;
        if (ssr <= exactSsr) { converged = true; ctx.stopReason = 'exact'; break; }
        if (overBudget()) { ctx.stopReason = 'budget'; break; }

        var J = PRiSM_jacobianForward(fInt, data.t, params, yMod, freeKeys, O.derivStep, boundArr);
        var JtWJ = _zeros2D(nf, nf);
        var JtWr = new Array(nf);
        for (var jj = 0; jj < nf; jj++) JtWr[jj] = 0;
        for (var i = 0; i < n; i++) {
            var ri = data.p[i] - yMod[i];
            var wi = W[i];
            if (wi === 0) continue;
            for (var a = 0; a < nf; a++) {
                var Jia = J[i][a];
                if (Jia === 0) continue;
                JtWr[a] += wi * Jia * ri;
                for (var bb = a; bb < nf; bb++) JtWJ[a][bb] += wi * Jia * J[i][bb];
            }
        }
        for (var a2 = 0; a2 < nf; a2++) for (var b2 = a2 + 1; b2 < nf; b2++) JtWJ[b2][a2] = JtWJ[a2][b2];
        var diagJtWJ = new Array(nf);
        for (var d = 0; d < nf; d++) diagJtWJ[d] = Math.max(JtWJ[d][d], 1e-30);

        var accepted = false, innerTries = 0;
        var newSsr = ssr, newParams = params, newYMod = yMod;
        while (!accepted && innerTries < 40) {
            if (innerTries > 0 && overBudget()) break;
            innerTries++;
            var A = _copy2D(JtWJ);
            for (var dd = 0; dd < nf; dd++) {
                if (O.marquardtScale === 'identity') A[dd][dd] += lambda;
                else A[dd][dd] += lambda * diagJtWJ[dd];
            }
            var deltaTry;
            try { deltaTry = PRiSM_solveLinear(A, JtWr); }
            catch (e) { lambda *= O.lambdaUp; if (lambda > O.lambdaMax) break; continue; }
            var trialParams = {};
            for (var pk in params) if (Object.prototype.hasOwnProperty.call(params, pk)) trialParams[pk] = params[pk];
            for (var jj2 = 0; jj2 < nf; jj2++) trialParams[freeKeys[jj2]] = params[freeKeys[jj2]] + deltaTry[jj2];
            _clipInternal(trialParams, freeKeys, ib);
            var trialY = null;
            try { trialY = fInt(data.t, trialParams); } catch (err) { trialY = null; }
            var trialSsr = trialY ? _ssr(data.p, trialY, W) : NaN;
            if (isFinite(trialSsr) && trialSsr < ssr) {
                accepted = true;
                newSsr = trialSsr; newParams = trialParams; newYMod = trialY;
                lambda = Math.max(lambda * O.lambdaDown, O.lambdaMin);
            } else {
                lambda *= O.lambdaUp;
                if (lambda > O.lambdaMax) break;
            }
        }

        if (!accepted) {
            history.push(ssr);
            if (typeof O.onIter === 'function') { try { O.onIter(iter, toExt(params), ssr, lambda); } catch (_) {} }
            var pred = _gnPredictedDecrease(JtWJ, JtWr, params, freeKeys, ib);
            if (ssr <= exactSsr) {
                converged = true; ctx.stopReason = 'exact';
            } else if (isFinite(pred) && pred <= O.gtol * Math.max(ssr, 1e-300)) {
                converged = true; ctx.stopReason = 'stationary';
            } else {
                ctx.stopReason = overBudget() ? 'budget' : 'lambda-max';
            }
            break;
        }

        var maxRel = 0;
        for (var rk = 0; rk < nf; rk++) {
            var kr = freeKeys[rk];
            var rel = Math.abs(newParams[kr] - params[kr]) / _fdScale(params[kr], ib[kr][0], ib[kr][1]);
            if (rel > maxRel) maxRel = rel;
        }
        if (Math.abs(ssr - newSsr) < 1e-12 * Math.max(Math.abs(ssr), 1e-300)) stagnantSteps++;
        else stagnantSteps = 0;

        params = newParams; yMod = newYMod; ssr = newSsr;
        history.push(ssr);
        if (typeof O.onIter === 'function') { try { O.onIter(iter, toExt(params), ssr, lambda); } catch (_) {} }

        if (maxRel < O.tolerance) { converged = true; ctx.stopReason = 'tolerance'; break; }
        if (stagnantSteps >= 5) { converged = true; ctx.stopReason = 'plateau'; break; }
    }
    if (!converged && ctx.stopReason === 'none') ctx.stopReason = 'maxIter';

    var Jfinal = PRiSM_jacobianForward(fInt, data.t, params, yMod, freeKeys, O.derivStep, boundArr);
    return _buildResult(params, freeKeys, Jfinal, data, yMod, W, ssr, iter, converged, history, ctx);
}

// Gauss-Newton predicted SSR decrease over parameters that are not pinned at
// a bound with the gradient pushing outward. Used to recognise a minimum when
// no damped step can be accepted (round-off floor).
function _gnPredictedDecrease(JtWJ, JtWr, params, freeKeys, ib) {
    var idx = [];
    for (var j = 0; j < freeKeys.length; j++) {
        var k = freeKeys[j], v = params[k], b = ib[k];
        var span = (isFinite(b[1] - b[0]) ? (b[1] - b[0]) : 1) * 1e-9;
        var atLo = isFinite(b[0]) && v <= b[0] + span;
        var atHi = isFinite(b[1]) && v >= b[1] - span;
        if ((atLo && JtWr[j] < 0) || (atHi && JtWr[j] > 0)) continue;
        if (JtWJ[j][j] <= 0) continue;
        idx.push(j);
    }
    if (!idx.length) return 0;
    var m = idx.length;
    var A = _zeros2D(m, m), g = new Array(m);
    for (var a = 0; a < m; a++) {
        g[a] = JtWr[idx[a]];
        for (var c = 0; c < m; c++) A[a][c] = JtWJ[idx[a]][idx[c]];
        A[a][a] *= (1 + 1e-10);
    }
    var inv = _safeInvert(A);
    if (!inv) return Infinity;
    var pred = 0;
    for (var r = 0; r < m; r++) for (var s = 0; s < m; s++) pred += g[r] * inv[r][s] * g[s];
    return pred;
}

function _buildResult(params, freeKeys, J, data, yMod, W, ssr, iter, converged, history, ctx) {
    var n = data.p.length;
    var p = freeKeys.length;
    var dof = Math.max(n - p, 1);
    var ext = ctx.toExt(params);

    var ssrU = 0, pMean = 0;
    for (var i = 0; i < n; i++) pMean += data.p[i];
    pMean /= Math.max(n, 1);
    var ssTot = 0;
    for (var i2 = 0; i2 < n; i2++) {
        var dv = data.p[i2] - pMean, rr = data.p[i2] - yMod[i2];
        ssTot += dv * dv; ssrU += rr * rr;
    }
    var rmse = Math.sqrt(ssrU / Math.max(n, 1));
    var r2 = (ssTot > 1e-20) ? (1 - ssrU / ssTot) : NaN;
    var aic = (ssr > 0 && n > 0) ? (n * Math.log(ssr / n) + 2 * p) : (ssr === 0 ? -Infinity : NaN);

    var sigma2 = ssr / dof;
    var tq = PRiSM_tQuantile975(dof);
    var stderr = {}, ci95 = {}, identifiable = {}, atBound = {};
    var covariance = null, corr = null;

    for (var q = 0; q < p; q++) {
        var kq = freeKeys[q], bq = ctx.ib[kq], vq = params[kq];
        var span = isFinite(bq[1] - bq[0]) ? (bq[1] - bq[0]) : Math.max(Math.abs(vq), 1);
        // 1e-3 of the internal span (~0.9 % relative on a 4-decade log range):
        // a fit converging ONTO a bound under a wall-clock budget stops a hair
        // inside it (xf = 1.00002 ft on a 1 ft floor) and must still count as
        // stalled, or ▶ Analyse commits a degenerate model.
        atBound[kq] = (isFinite(bq[0]) && vq <= bq[0] + 1e-3 * span) ||
                      (isFinite(bq[1]) && vq >= bq[1] - 1e-3 * span);
    }

    if (J && p > 0 && J.length === n) {
        var JtWJ = _zeros2D(p, p);
        for (var ii = 0; ii < n; ii++) {
            var wi = W[ii];
            if (!wi) continue;
            for (var aa = 0; aa < p; aa++) {
                var Jia = J[ii][aa];
                if (Jia === 0) continue;
                for (var bb = aa; bb < p; bb++) JtWJ[aa][bb] += wi * Jia * J[ii][bb];
            }
        }
        for (var aa2 = 0; aa2 < p; aa2++) for (var bb2 = aa2 + 1; bb2 < p; bb2++) JtWJ[bb2][aa2] = JtWJ[aa2][bb2];
        var zeroCol = false;
        for (var zc = 0; zc < p; zc++) if (!(JtWJ[zc][zc] > 0)) zeroCol = true;
        var inv = zeroCol ? null : _safeInvert(JtWJ);
        if (inv) {
            var covInt = _zeros2D(p, p);
            for (var u = 0; u < p; u++) for (var v = 0; v < p; v++) covInt[u][v] = sigma2 * inv[u][v];
            corr = _zeros2D(p, p);
            covariance = _zeros2D(p, p);
            var dExt = new Array(p);
            for (var e = 0; e < p; e++) dExt[e] = ctx.isLog[freeKeys[e]] ? ext[freeKeys[e]] * LN10 : 1;
            for (var u2 = 0; u2 < p; u2++) {
                for (var v2 = 0; v2 < p; v2++) {
                    var den = Math.sqrt(Math.abs(covInt[u2][u2] * covInt[v2][v2]));
                    corr[u2][v2] = den > 0 ? covInt[u2][v2] / den : (u2 === v2 ? 1 : 0);
                    covariance[u2][v2] = covInt[u2][v2] * dExt[u2] * dExt[v2];
                }
            }
            for (var f = 0; f < p; f++) {
                var kf = freeKeys[f];
                var seInt = covInt[f][f] > 0 ? Math.sqrt(covInt[f][f]) : NaN;
                var val = ext[kf], lo, hi, se;
                if (ctx.isLog[kf]) {
                    se = val * LN10 * seInt;
                    lo = Math.pow(10, params[kf] - tq * seInt);
                    hi = Math.pow(10, params[kf] + tq * seInt);
                } else {
                    se = seInt;
                    lo = val - tq * seInt;
                    hi = val + tq * seInt;
                }
                var eb = ctx.extBounds[kf];
                if (isFinite(lo) && lo < eb[0]) lo = eb[0];
                if (isFinite(hi) && hi > eb[1]) hi = eb[1];
                stderr[kf] = se;
                ci95[kf] = isFinite(seInt) ? [lo, hi] : [NaN, NaN];
            }
        }
    }
    for (var g = 0; g < p; g++) {
        var kg = freeKeys[g];
        var okId = !atBound[kg];
        var ci = ci95[kg];
        if (!ci || !isFinite(ci[0]) || !isFinite(ci[1])) okId = false;
        else if ((ci[1] - ci[0]) / 2 > Math.abs(ext[kg])) okId = false;
        if (corr) {
            for (var h = 0; h < p; h++) if (h !== g && Math.abs(corr[g][h]) > 0.98) okId = false;
        }
        identifiable[kg] = okId;
    }
    for (var pk in ext) {
        if (!Object.prototype.hasOwnProperty.call(ext, pk)) continue;
        if (!(pk in stderr)) { stderr[pk] = NaN; ci95[pk] = [NaN, NaN]; }
    }
    var logKeys = freeKeys.filter(function (k) { return ctx.isLog[k]; });

    return {
        params:           ext,
        stderr:           stderr,
        ci95:             ci95,
        ssr:              ssr,
        rmse:             rmse,
        r2:               r2,
        aic:              aic,
        iterations:       iter,
        converged:        !!converged,
        stopReason:       ctx.stopReason,
        covariance:       covariance,
        corr:             corr,
        identifiable:     identifiable,
        atBound:          atBound,
        sigma2:           sigma2,
        dof:              dof,
        tQuantile:        tq,
        residualHistory:  history,
        nFreeParams:      p,
        nObs:             n,
        freeKeys:         freeKeys.slice(),
        logKeys:          logKeys
    };
}


// =============================================================================
// SECTION 4 — BOOTSTRAP CONFIDENCE INTERVALS
// =============================================================================
// Residual bootstrap (Efron): resample the fitted residuals, refit, collect.
// Returns percentile CIs plus P10 / P50 / P90 per free parameter (P90 is
// the LOW value in the reserves convention, i.e. the 10th percentile —
// here reported by name: p10 = 10th percentile, p90 = 90th percentile).
// =============================================================================

/**
 * @param {Function} modelFn
 * @param {object}   data          { t, p, weights? }
 * @param {object}   fittedParams  best-fit params from PRiSM_lm
 * @param {object=}  opts          { nBootstrap: 200, ci: 0.95, bounds, freeze,
 *                                   lmOpts, seed, onProgress }
 * @return {object}  { ci, distributions, percentiles:{key:{p10,p50,p90}},
 *                     nBootstrap, failures }
 */
function PRiSM_bootstrap(modelFn, data, fittedParams, opts) {
    opts = opts || {};
    var nBoot = opts.nBootstrap || 200;
    var ciLevel = (opts.ci != null) ? opts.ci : 0.95;
    var lmOpts = opts.lmOpts || { maxIter: 30, tolerance: 1e-5 };
    var bounds = opts.bounds || null;
    var freeze = opts.freeze || null;
    var onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
    var rng = _makeRng(opts.seed);

    var yHat = modelFn(data.t, fittedParams);
    var n = data.p.length;
    var residuals = new Array(n);
    for (var i = 0; i < n; i++) residuals[i] = data.p[i] - yHat[i];

    var distributions = {};
    var freeKeys = _activeParams(fittedParams, freeze);
    for (var k = 0; k < freeKeys.length; k++) distributions[freeKeys[k]] = [];

    var failures = 0;
    for (var b = 0; b < nBoot; b++) {
        var pStar = new Array(n);
        for (var i2 = 0; i2 < n; i2++) {
            var idx = (rng() * n) | 0;
            if (idx >= n) idx = n - 1;
            pStar[i2] = yHat[i2] + residuals[idx];
        }
        var init = {};
        for (var pk in fittedParams) if (Object.prototype.hasOwnProperty.call(fittedParams, pk)) init[pk] = fittedParams[pk];
        var res;
        try { res = PRiSM_lm(modelFn, { t: data.t, p: pStar, weights: data.weights }, init, bounds, freeze, lmOpts); }
        catch (err) { failures++; continue; }
        for (var fk2 = 0; fk2 < freeKeys.length; fk2++) {
            var v = res.params[freeKeys[fk2]];
            if (isFinite(v)) distributions[freeKeys[fk2]].push(v);
        }
        if (onProgress) { try { onProgress(b + 1, nBoot); } catch (_) {} }
    }

    var alpha = (1 - ciLevel) / 2;
    var ci = {}, percentiles = {};
    for (var fk3 = 0; fk3 < freeKeys.length; fk3++) {
        var key2 = freeKeys[fk3];
        var arr = distributions[key2].slice().sort(function (a, b) { return a - b; });
        if (arr.length < 4) {
            ci[key2] = [NaN, NaN];
            percentiles[key2] = { p10: NaN, p50: NaN, p90: NaN };
            continue;
        }
        ci[key2] = [_percentile(arr, alpha), _percentile(arr, 1 - alpha)];
        percentiles[key2] = { p10: _percentile(arr, 0.1), p50: _percentile(arr, 0.5), p90: _percentile(arr, 0.9) };
    }
    return { ci: ci, distributions: distributions, percentiles: percentiles, nBootstrap: nBoot, failures: failures };
}

function _percentile(sorted, q) {
    var n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    var pos = q * (n - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

// mulberry32 PRNG; Math.random when no seed.
function _makeRng(seed) {
    if (seed == null) return Math.random;
    var s = (seed | 0) || 1;
    return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
    };
}


// =============================================================================
// SECTION 5 — MULTI-RATE SUPERPOSITION
// =============================================================================
//   p(t) = Σ_{i: t_i < t} (q_i − q_{i-1}) · p_unit(t − t_i),  q_{-1} = 0
// =============================================================================

/**
 * @param {Function} modelFn      f(td_array, params) → pd_array
 * @param {object[]} rateHistory  [{ t_start (or t), q }, ...]
 * @param {number[]} evalTimes    real-time points to evaluate
 * @param {object}   params       model parameters
 * @param {Function=} tdNormaliser f(t_real, params) → td (default identity)
 */
function PRiSM_superposition(modelFn, rateHistory, evalTimes, params, tdNormaliser) {
    if (!Array.isArray(rateHistory) || !rateHistory.length) {
        throw new Error('PRiSM_superposition: rateHistory must be a non-empty array');
    }
    if (!Array.isArray(evalTimes) || !evalTimes.length) {
        throw new Error('PRiSM_superposition: evalTimes must be a non-empty array');
    }
    var ndt = (typeof tdNormaliser === 'function') ? tdNormaliser : function (t) { return t; };
    var rh = _normSteps(rateHistory);
    var dq = new Array(rh.length);
    for (var i = 0; i < rh.length; i++) dq[i] = rh[i].q - ((i === 0) ? 0 : rh[i - 1].q);
    var n = evalTimes.length;
    var out = new Array(n);
    for (var k = 0; k < n; k++) out[k] = 0;
    for (var i2 = 0; i2 < rh.length; i2++) {
        if (dq[i2] === 0) continue;
        var tStart = rh[i2].t;
        var tdActive = [], tdIdx = [];
        for (var j = 0; j < n; j++) {
            var dt = evalTimes[j] - tStart;
            if (dt <= 0) continue;
            tdActive.push(ndt(dt, params));
            tdIdx.push(j);
        }
        if (!tdActive.length) continue;
        var pUnit;
        try { pUnit = modelFn(tdActive, params); }
        catch (err) {
            pUnit = new Array(tdActive.length);
            for (var s = 0; s < tdActive.length; s++) {
                try { pUnit[s] = modelFn([tdActive[s]], params)[0]; } catch (e2) { pUnit[s] = 0; }
            }
        }
        for (var c = 0; c < tdIdx.length; c++) out[tdIdx[c]] += dq[i2] * pUnit[c];
    }
    return out;
}

// Normalise a rate history to sorted [{t, q}] (accepts t_start or t).
function _normSteps(rh) {
    var out = [];
    if (!Array.isArray(rh)) return out;
    for (var i = 0; i < rh.length; i++) {
        var r = rh[i] || {};
        var t = (r.t_start != null) ? +r.t_start : (r.t != null ? +r.t : (r.t0 != null ? +r.t0 : NaN));
        var q = +r.q;
        if (isFinite(t) && isFinite(q)) out.push({ t: t, q: q, t_start: t });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
}


// =============================================================================
// SECTION 6 — RATE STEPS, SUPERPOSITION TIME, AGARWAL EQUIVALENT TIME
// =============================================================================
// Rate-step convention for sampled data: the rate on row i applies over
// (t[i−1], t[i]]; a change of rate between rows i−1 and i therefore starts at
// t[i−1]. Rates within 1 % (relative) are merged into one step.
//
// For the analysed period n (0-based step index, start ts_n, rate change
// Δq_n = q_n − q_{n−1}):
//   superposition  sup(Δt) = Σ_{i=0..n} (Δq_i/Δq_n) · ln(ts_n − ts_i + Δt)
//   Agarwal        ln Δte  = sup(Δt) − Σ_{i<n} (Δq_i/Δq_n) · ln(ts_n − ts_i)
// For a shut-in (q_n = 0) the Agarwal expression equals the textbook
//   ln Δte = Σ_{i<n} (Δq_i/q_{n−1}) · ln[(ts_n − ts_i)·Δt / (ts_n − ts_i + Δt)]
// and for a single rate Δte = tp·Δt/(tp + Δt).
// =============================================================================

function _sameRate(a, b) {
    var m = Math.max(Math.abs(a), Math.abs(b));
    return m === 0 || Math.abs(a - b) <= 0.01 * m;
}

function _rateStepsFromSamples(t, q) {
    var steps = [];
    if (!Array.isArray(t) || !Array.isArray(q)) return steps;
    var cur = null, lastT = null;
    for (var i = 0; i < t.length; i++) {
        var ti = +t[i], qi = +q[i];
        if (!isFinite(ti) || !isFinite(qi)) continue;
        if (cur === null) {
            cur = { t: Math.min(0, ti), q: qi };
            steps.push(cur);
        } else if (!_sameRate(qi, cur.q)) {
            cur = { t: (lastT != null ? lastT : ti), q: qi };
            steps.push(cur);
        }
        lastT = ti;
    }
    return steps;
}

function _supTime(dt, steps, n) {
    var dqn = steps[n].q - (n > 0 ? steps[n - 1].q : 0);
    if (dqn === 0 || n === 0) return Math.log(dt);
    var tsn = steps[n].t, s = 0;
    for (var i = 0; i <= n; i++) {
        var dqi = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
        if (dqi === 0) continue;
        s += (dqi / dqn) * Math.log(tsn - steps[i].t + dt);
    }
    return s;
}

function _agarwalConst(steps, n) {
    var dqn = steps[n].q - (n > 0 ? steps[n - 1].q : 0);
    if (dqn === 0 || n === 0) return 0;
    var tsn = steps[n].t, c = 0;
    for (var i = 0; i < n; i++) {
        var dqi = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
        if (dqi === 0) continue;
        c += (dqi / dqn) * Math.log(tsn - steps[i].t);
    }
    return c;
}

/**
 * Agarwal equivalent time for Δt values in flow period n.
 * @param {number|number[]} dt           elapsed time since the start of period n (hr)
 * @param {object[]}        rateHistory  [{t|t_start, q}]
 * @param {number=}         n            period index (default: last step)
 */
function PRiSM_agarwalTime(dt, rateHistory, n) {
    var steps = _normSteps(rateHistory);
    var scalar = !Array.isArray(dt);
    var arr = scalar ? [dt] : dt;
    if (!steps.length) return scalar ? arr[0] : arr.slice();
    if (n == null || !(n >= 0) || n >= steps.length) n = steps.length - 1;
    var c = _agarwalConst(steps, n);
    var out = arr.map(function (x) {
        if (!(x > 0)) return NaN;
        return Math.exp(_supTime(x, steps, n) - c);
    });
    return scalar ? out[0] : out;
}

// Producing time tp = Np / q_{n−1} for period n.
function _producingTime(steps, n) {
    if (!(n > 0)) return null;
    var qn1 = steps[n - 1].q;
    if (!qn1) return null;
    var np = 0;
    for (var i = 0; i < n; i++) np += steps[i].q * (steps[i + 1].t - steps[i].t);
    return np / qn1;
}

function _interpAt(x, y, xt) {
    var n = x.length;
    if (xt <= x[0]) return y[0];
    if (xt >= x[n - 1]) return y[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (x[mid] > xt) hi = mid; else lo = mid;
    }
    var f = (xt - x[lo]) / (x[hi] - x[lo]);
    return y[lo] + f * (y[hi] - y[lo]);
}

/**
 * Multi-rate Agarwal equivalent time + Δp for plotting a later flow period on
 * a single-rate diagnostic axis.
 *
 * @param {object}  data        { t, p, q?, rateHistory?, pRef? }
 * @param {number=} refRateIdx  period (rate step) to analyse; default = last
 * @return {object} { teq[], dp_eff[], dt[], tShut, tp, pRef, rateHistory, method }
 *                  teq / dp_eff are NaN for samples before the period start.
 */
function PRiSM_sandface_convolution(data, refRateIdx) {
    if (!data || !Array.isArray(data.t) || !Array.isArray(data.p)) {
        throw new Error('PRiSM_sandface_convolution: data must have t[] and p[] arrays');
    }
    if (data.t.length !== data.p.length) {
        throw new Error('PRiSM_sandface_convolution: t and p must be the same length');
    }
    var steps = _normSteps(data.rateHistory);
    if (!steps.length && typeof G.PRiSM_getAnalysisData === 'function' && Array.isArray(data.q)) {
        try {
            var ad = G.PRiSM_getAnalysisData({ t: data.t, p: data.p, q: data.q }, { timeFn: 'agarwal' });
            if (ad && ad.ok && Array.isArray(ad.rateHistory)) steps = _normSteps(ad.rateHistory);
        } catch (e) { steps = []; }
    }
    if (!steps.length) {
        if (!Array.isArray(data.q) || data.q.length !== data.t.length) {
            throw new Error('PRiSM_sandface_convolution: need q[] or rateHistory');
        }
        steps = _rateStepsFromSamples(data.t, data.q);
    }
    var n = (refRateIdx == null) ? steps.length - 1 : Math.max(0, Math.min(steps.length - 1, refRateIdx | 0));
    var tShut = steps[n].t;
    var pRef = isFinite(data.pRef) ? +data.pRef : _interpAt(data.t, data.p, tShut);
    var c = _agarwalConst(steps, n);
    var tEnd = (n + 1 < steps.length) ? steps[n + 1].t : Infinity;
    var N = data.t.length;
    var teq = new Array(N), dpEff = new Array(N), dts = new Array(N);
    for (var j = 0; j < N; j++) {
        var dt = data.t[j] - tShut;
        if (!(dt > 0) || data.t[j] > tEnd) { teq[j] = NaN; dpEff[j] = NaN; dts[j] = NaN; continue; }
        dts[j] = dt;
        teq[j] = Math.exp(_supTime(dt, steps, n) - c);
        dpEff[j] = Math.abs(data.p[j] - pRef);
    }
    return {
        teq: teq, dp_eff: dpEff, dt: dts,
        tShut: tShut, tp: _producingTime(steps, n), pRef: pRef,
        rateHistory: steps.map(function (s) { return { t: s.t, q: s.q }; }),
        method: (n === 0) ? 'drawdown' : 'agarwal'
    };
}


// =============================================================================
// SECTION 7 — LOCAL FALLBACKS FOR CONTRACTS C1 / C2 / C3
// =============================================================================
// Used only when the core layer (PRiSM_getWell / PRiSM_getAnalysisData /
// PRiSM_physicalModel) is not loaded. They follow the same contract shapes.
// =============================================================================

function _num(x) { return typeof x === 'number' && isFinite(x); }
function _pos(x) { return _num(x) && x > 0; }
function _pick() {
    for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (v !== null && v !== undefined && v !== '' && isFinite(+v)) return +v;
    }
    return null;
}
function _median(a) {
    var s = a.filter(function (v) { return isFinite(v); }).sort(function (x, y) { return x - y; });
    if (!s.length) return NaN;
    var m = s.length >> 1;
    return (s.length % 2) ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
function _registry() { return (G.PRiSM_MODELS && typeof G.PRiSM_MODELS === 'object') ? G.PRiSM_MODELS : {}; }
function _state() { return G.PRiSM_state || null; }
function _copy(o) {
    var out = {};
    if (!o) return out;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
}

// 3-point Bourdet derivative d y / d ln x with smoothing window L (ln units).
function _bourdet(x, y, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        try { var r = G.PRiSM_compute_bourdet(x, y, L); if (r && r.length === x.length) return Array.prototype.slice.call(r); }
        catch (e) { /* local fallback */ }
    }
    L = L || 0;
    var n = x.length, d = new Array(n);
    for (var z = 0; z < n; z++) d[z] = NaN;
    if (n < 3) return d;
    for (var i = 1; i < n - 1; i++) {
        if (!(x[i] > 0) || !isFinite(y[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(x[i]) - Math.log(x[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(x[i2]) - Math.log(x[i]) < L) i2++;
        }
        if (!(x[i1] > 0) || !(x[i2] > 0)) continue;
        var dl1 = Math.log(x[i]) - Math.log(x[i1]);
        var dl2 = Math.log(x[i2]) - Math.log(x[i]);
        var dlT = Math.log(x[i2]) - Math.log(x[i1]);
        if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
        d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
    }
    return d;
}

// C1 fallback — well & fluid inputs from PRiSM_pvt.
function _localWell(ds) {
    var pv = G.PRiSM_pvt || {};
    var c = pv._computed || {};
    var fluid = pv.fluidType || 'oil';
    var B, mu;
    if (fluid === 'gas') { B = _pick(pv.B, pv.Bg, c.Bg, c.B); mu = _pick(pv.mu, pv.mu_g, c.mu_g, c.mu); }
    else if (fluid === 'water') { B = _pick(pv.B, pv.Bw, c.B); mu = _pick(pv.mu, pv.mu_w, c.mu); }
    else { B = _pick(pv.B, pv.Bo, c.Bo, c.B); mu = _pick(pv.mu, pv.mu_o, c.mu_o, c.mu); }
    var prov = pv.provenance || {};
    var piSrc = prov.p_res || prov.pi;
    var pi = _pick(pv.pi);
    if (pi == null && (piSrc === 'user' || piSrc === 'sample' || piSrc === 'deconvolution')) pi = _pick(pv.p_res);
    var qData = null;
    if (ds && Array.isArray(ds.q)) {
        for (var i = ds.q.length - 1; i >= 0; i--) { if (_pos(+ds.q[i])) { qData = +ds.q[i]; break; } }
    }
    var w = {
        fluid: fluid, q: _pick(qData, pv.q), B: B, mu: mu, ct: _pick(pv.ct, c.ct),
        h: _pick(pv.h), phi: _pick(pv.phi), rw: _pick(pv.rw), pi: pi,
        T_R: _pick(pv.T_res) != null ? _pick(pv.T_res) + 459.67 : null, sg: _pick(pv.SG_g),
        testType: pv.testType || 'auto', tp: _pick(pv.tp), tShut: _pick(pv.tShut), pwf0: _pick(pv.pwf0)
    };
    _completeWell(w);
    return w;
}

function _completeWell(w) {
    var req = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
    var missing = [];
    for (var i = 0; i < req.length; i++) if (!_pos(w[req[i]])) missing.push(req[i]);
    if (!Array.isArray(w.missing)) w.missing = missing;
    if (typeof w.complete !== 'boolean') w.complete = missing.length === 0;
    if (!Array.isArray(w.defaulted)) w.defaulted = [];
    return w;
}

function _getWell(ds) {
    if (typeof G.PRiSM_getWell === 'function') {
        try { var w = G.PRiSM_getWell(ds); if (w) return _completeWell(_copy(w)); } catch (e) { /* fallback */ }
    }
    return _localWell(ds);
}

// C2 fallback — Δp / time function / derivative for one flow period.
function _localAnalysisData(ds, well, opts) {
    opts = opts || {};
    well = well || {};
    var out = { ok: false, reason: '', warnings: [] };
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p)) { out.reason = 'no pressure data'; return out; }
    var rows = [];
    for (var i = 0; i < ds.t.length; i++) {
        var ti = +ds.t[i], pi_ = +ds.p[i];
        var qi = (Array.isArray(ds.q) && ds.q[i] != null && ds.q[i] !== '') ? +ds.q[i] : NaN;
        if (isFinite(ti) && isFinite(pi_)) rows.push({ t: ti, p: pi_, q: qi });
    }
    rows.sort(function (a, b) { return a.t - b.t; });
    if (rows.length < 3) { out.reason = 'fewer than 3 pressure points'; return out; }
    var T = rows.map(function (r) { return r.t; });
    var P = rows.map(function (r) { return r.p; });
    var Q = rows.map(function (r) { return r.q; });
    var hasQ = Q.some(function (v) { return isFinite(v) && v !== 0; });

    var steps = _normSteps(opts.rateHistory);
    if (!steps.length && hasQ) steps = _rateStepsFromSamples(T, Q);
    var testType = opts.testType || well.testType || 'auto';
    var shutType = (testType === 'buildup' || testType === 'falloff');
    if (!steps.length || (steps.length === 1 && shutType && _pos(well.tp) && !(steps[0].q === 0))) {
        var qw = _pos(well.q) ? well.q : 1;
        if (shutType && _pos(well.tp)) {
            var tsh = _num(well.tShut) ? well.tShut : Math.min(0, T[0]);
            steps = [{ t: tsh - well.tp, q: qw }, { t: tsh, q: 0 }];
        } else {
            steps = [{ t: Math.min(0, T[0]), q: qw }];
        }
    }
    var n = (opts.period != null && steps[+opts.period]) ? +opts.period : steps.length - 1;
    while (n > 0 && !(T[T.length - 1] > steps[n].t)) n--;
    var tStart = steps[n].t;
    var tEnd = (n + 1 < steps.length) ? steps[n + 1].t : Infinity;
    var qN = steps[n].q, qPrev = n > 0 ? steps[n - 1].q : 0;
    var dq = qN - qPrev;
    var isShut = n > 0 && _sameRate(qN, 0);

    var sigma, tt = testType;
    if (tt === 'drawdown' || tt === 'falloff') sigma = 1;
    else if (tt === 'buildup' || tt === 'injection') sigma = -1;
    else if (hasQ || n > 0) { sigma = dq >= 0 ? 1 : -1; tt = isShut ? 'buildup' : 'drawdown'; }
    else {
        var trend = (P[P.length - 1] - P[0]) >= 0 ? 1 : -1;   // CLAUDE.md sign rule
        sigma = -trend;
        tt = trend > 0 ? 'buildup' : 'drawdown';
    }

    var pRef, src;
    if (n === 0 && !shutType) {
        var piIn = _pick(opts.pi, well.pi);
        if (piIn != null) { pRef = piIn; src = 'pi'; }
        else {
            var row0 = null;
            for (var r0 = 0; r0 < rows.length && rows[r0].t <= tStart; r0++) row0 = rows[r0];
            if (row0) { pRef = row0.p; src = 't0-row'; }
            else {
                var ex = [];
                for (var r1 = 0; r1 < rows.length && ex.length < 3; r1++) if (rows[r1].t > tStart) ex.push(rows[r1]);
                if (ex.length >= 2) {
                    var mt = 0, mp = 0;
                    ex.forEach(function (r) { mt += r.t; mp += r.p; });
                    mt /= ex.length; mp /= ex.length;
                    var sxy = 0, sxx = 0;
                    ex.forEach(function (r) { sxy += (r.t - mt) * (r.p - mp); sxx += (r.t - mt) * (r.t - mt); });
                    var slope = sxx > 0 ? sxy / sxx : 0;
                    pRef = mp + slope * (tStart - mt); src = 'extrapolated';
                    out.warnings.push('Reference pressure extrapolated to t = 0 (no initial pressure entered) — skin is biased; enter pi.');
                } else {
                    pRef = rows[0].p; src = 'first-sample';
                    out.warnings.push('Reference pressure taken from the first sample (no initial pressure entered) — skin is biased; enter pi.');
                }
            }
        }
    } else {
        var pw = (isShut || shutType) ? _pick(opts.pwf0, well.pwf0) : null;
        if (pw != null) pRef = pw; else pRef = _interpAt(T, P, tStart);
        src = 'pwf0';
    }

    var t = [], tAbs = [], p = [], dp = [];
    var tmin = _num(opts.tmin) ? opts.tmin : -Infinity, tmax = _num(opts.tmax) ? opts.tmax : Infinity;
    for (var k = 0; k < rows.length; k++) {
        var dt = rows[k].t - tStart;
        if (!(dt > 0) || rows[k].t > tEnd || dt < tmin || dt > tmax) continue;
        t.push(dt); tAbs.push(rows[k].t); p.push(rows[k].p);
        dp.push(sigma * (pRef - rows[k].p));
    }
    if (t.length < 3) { out.reason = 'fewer than 3 points in the analysed period'; return out; }
    var timeFn = opts.timeFn || 'auto';
    if (timeFn === 'auto') timeFn = (n === 0) ? 'dt' : 'superposition';
    var x;
    if (timeFn === 'agarwal') x = PRiSM_agarwalTime(t, steps, n);
    else if (timeFn === 'superposition') x = t.map(function (v) { return Math.exp(_supTime(v, steps, n)); });
    else { x = t.slice(); timeFn = 'dt'; }
    var st = _state() || {};
    var L = _num(opts.L) ? opts.L : (_num(st.bourdetL) ? st.bourdetL : 0.1);
    var deriv = _bourdet(x, dp, L);
    if (steps.length > 20) out.warnings.push('Continuously varying rate (> 20 steps) — rate-transient analysis or deconvolution applies.');

    return {
        ok: true, reason: '', n: t.length,
        t: t, tAbs: tAbs, p: p, dp: dp, x: x, deriv: deriv, L: L, timeFn: timeFn,
        sign: -sigma, pRef: pRef, pRefSource: src, testType: tt,
        tStart: tStart, tShut: isShut ? tStart : null, tp: _producingTime(steps, n),
        qRef: Math.abs(n === 0 ? qN : dq) || null,
        rateHistory: steps.map(function (s) { return { t: s.t, q: s.q }; }),
        periods: steps.map(function (s, j) {
            var t1 = (j + 1 < steps.length) ? steps[j + 1].t : T[T.length - 1];
            return { t0: s.t, t1: t1, start: s.t, end: t1, q: s.q };
        }),
        fluid: well.fluid || 'oil', warnings: out.warnings, period: n
    };
}

function _getAnalysisData(ds, well, opts) {
    if (typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var a = G.PRiSM_getAnalysisData(ds, opts || {});
            if (a) return a;
        } catch (e) { /* fallback */ }
    }
    return _localAnalysisData(ds, well, opts);
}

// Model evaluation helpers — always array in, array out; NaN on failure.
function _evalArr(fn, td, params) {
    if (!td.length) return [];
    var r;
    try { r = fn(td, params); } catch (e) { r = null; }
    if (Array.isArray(r) && r.length === td.length) return r;
    if (r && typeof r.length === 'number' && r.length === td.length) return Array.prototype.slice.call(r);
    var out = new Array(td.length);
    for (var i = 0; i < td.length; i++) {
        try { var v = fn(td[i], params); out[i] = Array.isArray(v) ? v[0] : +v; }
        catch (e2) { out[i] = NaN; }
    }
    return out;
}

function _evalPdPrime(entry, td, params) {
    if (typeof entry.pdPrime === 'function') {
        var r = _evalArr(entry.pdPrime, td, params);
        if (_allFinite(r)) return r;
    }
    var h = 0.01, up = td.map(function (v) { return v * Math.exp(h); }), dn = td.map(function (v) { return v * Math.exp(-h); });
    var a = _evalArr(entry.pd, up, params), b = _evalArr(entry.pd, dn, params);
    return a.map(function (v, i) { return (v - b[i]) / (2 * h); });
}

var _LOG_SHAPE_KEYS = { lambda: 1, Cd: 1, CD: 1, FcD: 1, reD: 1, xfD: 1, L_to_h: 1, R: 1, M: 1, D: 1 };

function _shapeScale(sp) {
    if (sp && sp.scale) return sp.scale;
    if (sp && _LOG_SHAPE_KEYS[sp.key]) return (sp.min != null && sp.min < 0) ? 'lin' : 'log';
    if (sp && _pos(sp.min) && _num(sp.max) && sp.max / sp.min >= 1e3) return 'log';
    return 'lin';
}

// C3 fallback — dimensional wrapper around a dimensionless registry model.
function _localPhysicalModel(modelKey, well, adata, opts) {
    opts = opts || {};
    var entry = _registry()[modelKey];
    if (!entry || typeof entry.pd !== 'function') return { ok: false, reason: 'unknown model "' + modelKey + '"' };
    if (entry.kind === 'rate') return { ok: false, reason: 'rate model — use PRiSM_fitRate' };
    if (!adata || !adata.ok) return { ok: false, reason: 'no analysis data' };
    var w = well || {};
    var specArr = Array.isArray(entry.paramSpec) ? entry.paramSpec : [];
    var specBy = {};
    specArr.forEach(function (s) { if (s && s.key) specBy[s.key] = s; });
    var base = _copy(entry.defaults);
    specArr.forEach(function (s) { if (s && s.key && !(s.key in base) && s['default'] !== undefined) base[s.key] = s['default']; });
    var p0 = opts.params0 || {};
    for (var pk in p0) if (Object.prototype.hasOwnProperty.call(p0, pk) && (pk in base)) base[pk] = p0[pk];
    var numKeys = Object.keys(base).filter(function (k) { return k.indexOf('__') !== 0 && _num(base[k]); });
    var hasCd = numKeys.indexOf('Cd') >= 0, hasS = numKeys.indexOf('S') >= 0;
    var refLength = entry.refLength || 'rw';
    var refKey = (refLength === 'xf' || refLength === 'Lh') ? refLength : null;
    var shapeKeys = numKeys.filter(function (k) { return k !== 'Cd' && k !== 'S' && k !== refKey; });
    var complete = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'].every(function (k) { return _pos(w[k]); });
    var mode = opts.mode || (complete ? 'physical' : 'scale');
    if (mode === 'physical' && !complete) mode = 'scale';

    var steps = _normSteps(adata.rateHistory);
    var nPer = 0;
    if (steps.length) {
        var best = Infinity;
        for (var s = 0; s < steps.length; s++) {
            var dd = Math.abs(steps[s].t - (_num(adata.tStart) ? adata.tStart : steps[0].t));
            if (dd < best) { best = dd; nPer = s; }
        }
    }
    var single = !steps.length || nPer === 0;
    var qRef = _pos(adata.qRef) ? adata.qRef : (_pos(w.q) ? w.q : null);
    if (!single) {
        var dqn = steps[nPer].q - steps[nPer - 1].q;
        if (!_pos(qRef)) qRef = Math.abs(dqn) || 1;
    }
    if (mode === 'scale' && !_pos(qRef)) qRef = 1;
    var sgnPer = single ? 1 : ((steps[nPer].q - steps[nPer - 1].q) >= 0 ? 1 : -1);
    var tData = adata.t || [];
    var tEndData = tData.length ? tData[tData.length - 1] : 1;
    var Cd0 = _pos(base.Cd) ? base.Cd : 100;
    var sigmaData = _dataSign(adata);

    var keys = [], spec = {};
    if (mode === 'physical') {
        keys.push('k'); spec.k = { min: 1e-5, max: 1e6, unit: 'md', scale: 'log', 'default': 10 };
        if (hasCd) { keys.push('C'); spec.C = { min: 1e-8, max: 10, unit: 'bbl/psi', scale: 'log', 'default': 1e-2 }; }
        if (hasS) { keys.push('S'); spec.S = { min: _pick(specBy.S && specBy.S.min, -7), max: _pick(specBy.S && specBy.S.max, 50), unit: '-', scale: 'lin', 'default': 0 }; }
        if (refKey) { keys.push(refKey); spec[refKey] = { min: 1, max: 1e5, unit: 'ft', scale: 'log', 'default': 100 }; }
    } else {
        keys.push('A'); spec.A = { min: 1e-8, max: 1e9, unit: 'psi', scale: 'log', 'default': 100 };
        keys.push('T'); spec.T = { min: 1e-10, max: 1e14, unit: '1/hr', scale: 'log', 'default': 100 };
        if (hasCd && hasS) { keys.push('CDe2S'); spec.CDe2S = { min: 1e-6, max: 1e80, unit: '-', scale: 'log', 'default': 1e3 }; }
        else if (hasS) { keys.push('S'); spec.S = { min: -7, max: 50, unit: '-', scale: 'lin', 'default': 0 }; }
    }
    shapeKeys.forEach(function (k) {
        var sp = specBy[k] || { key: k };
        keys.push(k);
        spec[k] = { min: _pick(sp.min, -Infinity), max: _pick(sp.max, Infinity), unit: sp.unit || '-', scale: _shapeScale(sp), 'default': base[k] };
        if (spec[k].scale === 'log' && !(spec[k].min > 0)) spec[k].min = Math.max(1e-30, _pos(base[k]) ? base[k] * 1e-6 : 1e-30);
    });
    if (opts.floatPi) {
        keys.push('pi');
        var pmax = -Infinity, pmin = Infinity;
        (adata.p || []).forEach(function (v) { if (v > pmax) pmax = v; if (v < pmin) pmin = v; });
        var pr = _num(adata.pRef) ? adata.pRef : pmax;
        spec.pi = (sigmaData > 0)
            ? { min: pmax + 0.01, max: pr + 10000, unit: 'psia', scale: 'lin', 'default': pr }
            : { min: pr - 10000, max: pmin - 0.01, unit: 'psia', scale: 'lin', 'default': pr };
    }

    function toModelParams(phys) {
        var params = _copy(base);
        shapeKeys.forEach(function (k) { if (_num(phys[k])) params[k] = phys[k]; });
        var A, Bt;
        if (mode === 'physical') {
            var Lref = refKey ? phys[refKey] : w.rw;
            A = 141.2 * qRef * w.B * w.mu / (phys.k * w.h);
            Bt = 0.0002637 * phys.k / (w.phi * w.mu * w.ct * Lref * Lref);
            if (hasCd) params.Cd = 0.8936 * phys.C / (w.phi * w.ct * w.h * Lref * Lref);
            if (hasS) params.S = phys.S;
            params.__h_rw = w.h / w.rw;
        } else {
            A = phys.A;
            Bt = phys.T * (hasCd ? Cd0 : 1);
            if (hasCd) params.Cd = Cd0;
            if (hasCd && hasS) params.S = 0.5 * Math.log(phys.CDe2S / Cd0);
            else if (hasS) params.S = phys.S;
            if (_pos(w.h) && _pos(w.rw)) params.__h_rw = w.h / w.rw;
        }
        return { params: params, A: A, B: Bt };
    }

    function dp(t, phys) {
        var mp = toModelParams(phys);
        if (single) {
            var pd = _evalArr(entry.pd, t.map(function (v) { return mp.B * v; }), mp.params);
            return pd.map(function (v) { return mp.A * v; });
        }
        var unit = mp.A / qRef, tS = steps[nPer].t;
        var tds = [], map = [];
        for (var i = 0; i <= nPer; i++) {
            var dqi = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
            if (dqi === 0) continue;
            if (i < nPer) { tds.push(mp.B * (tS - steps[i].t)); map.push([i, -1, dqi]); }
            for (var j = 0; j < t.length; j++) { tds.push(mp.B * (tS + t[j] - steps[i].t)); map.push([i, j, dqi]); }
        }
        var pdv = _evalArr(entry.pd, tds, mp.params);
        var D = new Array(t.length), D0 = 0;
        for (var z = 0; z < t.length; z++) D[z] = 0;
        for (var m = 0; m < map.length; m++) {
            var c = map[m][2] * unit * pdv[m];
            if (map[m][1] < 0) D0 += c; else D[map[m][1]] += c;
        }
        return D.map(function (v) { return sgnPer * (v - D0); });
    }

    function timeFnValues(t) {
        var tf = adata.timeFn || 'dt';
        if (single || tf === 'dt') return t.slice();
        if (tf === 'agarwal') return PRiSM_agarwalTime(t, steps, nPer);
        return t.map(function (v) { return Math.exp(_supTime(v, steps, nPer)); });
    }

    function deriv(t, phys) {
        var mp = toModelParams(phys);
        if (single) {
            var pp = _evalPdPrime(entry, t.map(function (v) { return mp.B * v; }), mp.params);
            return pp.map(function (v) { return mp.A * v; });
        }
        var tmin = Infinity, tmax = -Infinity;
        t.forEach(function (v) { if (v < tmin) tmin = v; if (v > tmax) tmax = v; });
        var l0 = Math.log10(tmin / 2), l1 = Math.log10(tmax * 2);
        var ng = Math.max(20, Math.ceil((l1 - l0) * 24));
        var grid = [];
        for (var g = 0; g <= ng; g++) grid.push(Math.pow(10, l0 + (l1 - l0) * g / ng));
        var dpg = dp(grid, phys), xg = timeFnValues(grid);
        var lx = xg.map(function (v) { return Math.log(v); });
        var dg = new Array(grid.length);
        for (var i = 0; i < grid.length; i++) {
            var a = Math.max(0, i - 1), b = Math.min(grid.length - 1, i + 1);
            dg[i] = (dpg[b] - dpg[a]) / (lx[b] - lx[a]);
        }
        var lg = grid.map(function (v) { return Math.log(v); });
        return t.map(function (v) { return _interpAt(lg, dg, Math.log(v)); });
    }

    function p(t, phys) {
        var d = dp(t, phys);
        var pr = (opts.floatPi && _num(phys.pi)) ? phys.pi : adata.pRef;
        return d.map(function (v) { return pr - sigmaData * v; });
    }

    function seed() {
        var t = adata.t || [], d = adata.deriv || [], y = adata.dp || [];
        var late = [];
        for (var i = Math.floor(t.length * 0.6); i < t.length; i++) if (_pos(d[i])) late.push(d[i]);
        if (!late.length) for (var i2 = 0; i2 < t.length; i2++) if (_pos(d[i2])) late.push(d[i2]);
        var dLate = late.length ? _median(late) : NaN;
        var i0 = -1, ir = -1;
        for (var a = 0; a < t.length; a++) if (_pos(y[a])) { i0 = a; break; }
        for (var b = t.length - 1; b >= 0; b--) if (_pos(y[b]) && _pos(d[b])) { ir = b; break; }
        var tr = ir >= 0 ? t[ir] : tEndData;
        if (!single && ir >= 0) {
            var te = PRiSM_agarwalTime(tr, steps, nPer);
            if (_pos(te)) tr = te;
        }
        var ph = {};
        shapeKeys.forEach(function (k) { ph[k] = base[k]; });
        if (mode === 'physical') {
            var kh = _pos(dLate) ? 70.6 * qRef * w.B * w.mu / dLate : 100 * w.h;
            ph.k = _clampSpec(kh / w.h, spec.k);
            if (hasCd) {
                var Cs = (i0 >= 0) ? qRef * w.B * t[i0] / (24 * y[i0]) : 1e-2;
                ph.C = _clampSpec(_pos(Cs) ? Cs : 1e-2, spec.C);
            }
            if (refKey) ph[refKey] = _clampSpec(_pos(p0[refKey]) ? p0[refKey] : 100, spec[refKey]);
            if (hasS) {
                var Lr = refKey ? ph[refKey] : w.rw;
                var S0 = (ir >= 0 && _pos(dLate))
                    ? 0.5 * (y[ir] / d[ir] - Math.log(0.0002637 * ph.k * tr / (w.phi * w.mu * w.ct * Lr * Lr)) - 0.80907)
                    : 0;
                ph.S = _clampSpec(isFinite(S0) ? Math.max(-5, Math.min(20, S0)) : 0, spec.S);
            }
        } else {
            var A0 = _pos(dLate) ? 2 * dLate : (ir >= 0 ? y[ir] / 10 : 100);
            ph.A = _clampSpec(A0, spec.A);
            var T0 = (i0 >= 0) ? y[i0] / (A0 * t[i0]) : 100;
            ph.T = _clampSpec(_pos(T0) ? T0 : 100, spec.T);
            if (hasCd && hasS) {
                var lnC = (ir >= 0) ? 2 * y[ir] / A0 - Math.log(ph.T * tr) - 0.80907 : Math.log(1e3);
                ph.CDe2S = _clampSpec(Math.exp(Math.max(-5, Math.min(120, lnC))), spec.CDe2S);
            } else if (hasS) ph.S = 0;
        }
        if (opts.floatPi) ph.pi = _clampSpec(_num(w.pi) ? w.pi : adata.pRef, spec.pi);
        return ph;
    }

    function derived(phys) {
        var mp = toModelParams(phys);
        var out = { A: mp.A, B: mp.B };
        var piOut = _num(phys.pi) ? phys.pi : ((adata.pRefSource === 'pi') ? adata.pRef : (_num(w.pi) ? w.pi : null));
        if (mode === 'physical') {
            var Lref = refKey ? phys[refKey] : w.rw;
            out.k = phys.k; out.kh = phys.k * w.h;
            if (hasCd) { out.C = phys.C; out.Cd = mp.params.Cd; }
            if (hasS) out.S = phys.S;
            if (refKey) out[refKey] = phys[refKey];
            out.refLength_ft = Lref;
            out.rinv = Math.sqrt(phys.k * tEndData / (948 * w.phi * w.mu * w.ct));
        } else {
            out.T = phys.T;
            if (hasCd && hasS) { out.CDe2S = phys.CDe2S; out.Cd = Cd0; }
            if (_pos(w.B) && _pos(w.mu) && _pos(qRef) && qRef !== 1) {
                out.kh = 141.2 * qRef * w.B * w.mu / mp.A;
                if (_pos(w.h)) out.k = out.kh / w.h;
                if (hasCd) out.C = 0.0002951 * out.kh / (w.mu * phys.T);
            }
            out.S = null;
        }
        out.pi = piOut;
        out.distances_ft = {};
        return out;
    }

    return {
        ok: true, mode: mode, kind: 'pressure', keys: keys, spec: spec,
        toModelParams: toModelParams, dp: dp, deriv: deriv, p: p, seed: seed, derived: derived,
        _local: true
    };
}

function _clampSpec(v, sp) {
    if (!sp || !isFinite(v)) return v;
    if (_num(sp.min) && v < sp.min) v = sp.min;
    if (_num(sp.max) && v > sp.max) v = sp.max;
    return v;
}

// +1 when Δp = pRef − p (drawdown / falloff), −1 when Δp = p − pRef.
// Contract C2: p = pRef + sign·Δp, so this is −adata.sign.
function _dataSign(adata) {
    if (!adata) return 1;
    if (adata.sign === 1 || adata.sign === -1) return -adata.sign;
    if (Array.isArray(adata.p) && Array.isArray(adata.dp) && _num(adata.pRef)) {
        for (var i = 0; i < adata.p.length; i++) {
            var a = adata.pRef - adata.p[i];
            if (Math.abs(a) > 1e-9 && isFinite(adata.dp[i])) return (Math.abs(adata.dp[i] - a) <= Math.abs(adata.dp[i] + a)) ? 1 : -1;
        }
    }
    var tt = adata.testType;
    return (tt === 'buildup' || tt === 'injection') ? -1 : 1;
}

function _getPM(modelKey, well, adata, opts) {
    if (typeof G.PRiSM_physicalModel === 'function') {
        try {
            var pm = G.PRiSM_physicalModel(modelKey, well, adata, opts);
            if (pm && pm.ok && Array.isArray(pm.keys) && typeof pm.dp === 'function') return pm;
        } catch (e) { /* fallback */ }
    }
    return _localPhysicalModel(modelKey, well, adata, opts);
}

function _datasetHash(ds) {
    if (typeof G.PRiSM_datasetHash === 'function') { try { return G.PRiSM_datasetHash(ds); } catch (e) { /* none */ } }
    return null;
}


// =============================================================================
// SECTION 8 — PRiSM_fitPhysical — field-unit pressure regression
// =============================================================================
// Objective 'dp+deriv' (default): residuals
//   [ln Δp_d − ln Δp_m] ∪ [ln Δp'_d − ln Δp'_m], each weighted 0.5,
// over points with positive values inside opts.window. Objective 'dp':
// linear Δp residuals in psi. When pi floats, the data Δp is re-referenced
// every iteration: Δp_d(pi) = Δp + σ·(pi − pRef).
//
// Model derivative: derivMode 'consistent' (default) applies the SAME Bourdet
// operator (adata.x, adata.L) to the model Δp at the data times, so the data
// and model derivatives carry identical differencing error; 'analytic' uses
// the physical model's own derivative (PM.deriv).
// =============================================================================

var _PHYS_ALIASES = { Cd: 'C', CD: 'C', xfD: 'xf' };

// Approximate cost (ms) of one 70-point pressure evaluation, for the slow
// Laplace-space models (the rest are ≈ 3 ms). Used only for fit budgets;
// a registry entry may override with evalCostMs.
var _EVAL_COST_MS = {
    multiLatMLXF: 900, linearCompMultiLat: 900, mlNoXFHoriz: 750, mlHorizontalXF: 360, horizontal: 340,
    linearCompMultiLatInterference: 150, generalMLNoXF: 140, finiteFrac: 110, finiteFracSkin: 110,
    mlHorizInterference: 65, closedRectangle: 60, closedChannel3: 35, parallelChannel: 35,
    genHetRadialLinear: 20, genHetRadial: 17, radialComposite: 10
};

/**
 * @param {string} modelKey
 * @param {object=} adata  C2 analysis data (default: PRiSM_getAnalysisData())
 * @param {object=} well   C1 well (default: PRiSM_getWell())
 * @param {object=} opts   { objective:'dp+deriv'|'dp', window:{tmin,tmax},
 *                           floatPi, freeze:{key:true} (physical or registry
 *                           names), start:{phys}, params0:{dimensionless},
 *                           maxIter, tolerance, derivMode, mode:'physical'|'scale',
 *                           singleStart, bootstrap:n, seed }
 * @return LastFit-shaped object (contract C4) with ok:true, or {ok:false, reason}.
 */
function PRiSM_fitPhysical(modelKey, adata, well, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var fail = function (reason) {
        return { ok: false, reason: reason, modelKey: modelKey, model: modelKey, kind: 'pressure',
                 source: 'regression', converged: false, warnings: [reason] };
    };
    var entry = _registry()[modelKey];
    if (!entry) return fail('Unknown model "' + modelKey + '".');
    if (entry.kind === 'rate') return fail('"' + modelKey + '" is a rate model — use the decline fit.');
    var ds = opts.dataset || G.PRiSM_dataset;
    well = well || _getWell(ds);
    if (!adata) {
        var st0 = _state() || {};
        adata = _getAnalysisData(ds, well, {
            period: st0.activePeriod, timeFn: st0.timeFn || 'auto', L: st0.bourdetL
        });
    }
    if (!adata || !adata.ok) return fail('No analysable pressure data' + (adata && adata.reason ? ': ' + adata.reason : '.'));

    var shutIn = adata.testType === 'buildup' || adata.testType === 'falloff' || adata.pRefSource === 'pwf0';
    var floatPi = (opts.floatPi != null) ? !!opts.floatPi
                : (!shutIn && ['pi', 'pwf0'].indexOf(adata.pRefSource) < 0);
    if (shutIn) floatPi = false;

    var pm = _getPM(modelKey, well, adata, { floatPi: floatPi, mode: opts.mode, params0: opts.params0 });
    if (!pm || !pm.ok) return fail('Physical model unavailable: ' + (pm && pm.reason || 'unknown reason'));
    var keys = pm.keys.filter(function (k) { return String(k).indexOf('__') !== 0; });
    if (keys.indexOf('pi') < 0) floatPi = false;

    var objective = (opts.objective === 'dp') ? 'dp' : 'dp+deriv';
    var derivMode = opts.derivMode || 'consistent';
    var win = opts.window || {};
    var tmin = _num(win.tmin) ? win.tmin : -Infinity, tmax = _num(win.tmax) ? win.tmax : Infinity;
    var T = adata.t, DP = adata.dp, DD = adata.deriv || [];
    var X = (Array.isArray(adata.x) && adata.x.length === T.length) ? adata.x : T;
    var Lb = _num(adata.L) ? adata.L : 0.1;
    var sigma = _dataSign(adata);
    var pRef = adata.pRef;

    var idxDp = [], idxD = [];
    for (var i = 0; i < T.length; i++) {
        if (!(T[i] >= tmin && T[i] <= tmax)) continue;
        if (isFinite(DP[i]) && ((floatPi && pm._local) || DP[i] > 0)) idxDp.push(i);
        if (objective === 'dp+deriv' && _pos(DD[i])) idxD.push(i);
    }
    if (idxDp.length + idxD.length < keys.length + 2) return fail('Too few points in the fit window.');

    var tAll = T.slice();
    var nRes = idxDp.length + idxD.length;
    var PEN = 30;

    function modelDpAll(phys) { return pm.dp(tAll, phys); }
    function modelDeriv(phys, dpAll) {
        if (derivMode === 'consistent') return _bourdet(X, dpAll, Lb);
        var tD = idxD.map(function (i) { return T[i]; });
        var dv = pm.deriv(tD, phys), full = new Array(T.length);
        for (var z = 0; z < idxD.length; z++) full[idxD[z]] = dv[z];
        return full;
    }
    // Floating pi: the local wrapper re-references the DATA (Δp_d + σ·(pi − pRef));
    // the core-layer wrapper (C3) already returns the model Δp relative to adata.pRef.
    var shiftData = floatPi && !!pm._local;
    function shiftOf(phys) { return (shiftData && _num(phys.pi)) ? sigma * (phys.pi - pRef) : 0; }

    // Residual-mode model for PRiSM_lm: returns −r so that 0 − model = r.
    var resFn = function (_t, phys) {
        var dpm = modelDpAll(phys);
        var sh = shiftOf(phys);
        var out = new Array(nRes), c = 0;
        for (var a = 0; a < idxDp.length; a++) {
            var j = idxDp[a], yd = DP[j] + sh, ym = dpm[j];
            if (objective === 'dp') out[c++] = -((yd) - ym);
            else out[c++] = (yd > 0 && ym > 0) ? -(Math.log(yd) - Math.log(ym)) : PEN;
        }
        if (idxD.length) {
            var dm = modelDeriv(phys, dpm);
            for (var b = 0; b < idxD.length; b++) {
                var jd = idxD[b], dmv = dm[jd];
                out[c++] = (dmv > 0) ? -(Math.log(DD[jd]) - Math.log(dmv)) : PEN;
            }
        }
        return out;
    };
    var data = { t: new Array(nRes), p: new Array(nRes), weights: new Array(nRes) };
    for (var r = 0; r < nRes; r++) { data.t[r] = r; data.p[r] = 0; data.weights[r] = (objective === 'dp') ? 1 : 0.5; }

    // Freeze: user (physical or registry names), registry defaultFrozen.
    var freeze = {};
    var addFreeze = function (k) {
        var kk = (keys.indexOf(k) >= 0) ? k : _PHYS_ALIASES[k];
        if (kk && keys.indexOf(kk) >= 0) freeze[kk] = true;
    };
    (Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : []).forEach(addFreeze);
    var uf = opts.freeze || {};
    if (Array.isArray(uf)) uf.forEach(addFreeze);
    else for (var fk in uf) if (uf[fk]) addFreeze(fk);
    if (opts.unfreeze) (Array.isArray(opts.unfreeze) ? opts.unfreeze : Object.keys(opts.unfreeze)).forEach(function (k) { delete freeze[k]; });

    var bounds = {}, logKeys = [];
    keys.forEach(function (k) {
        var sp = (pm.spec && pm.spec[k]) || {};
        bounds[k] = [_num(sp.min) ? sp.min : -Infinity, _num(sp.max) ? sp.max : Infinity];
        if (sp.scale === 'log') logKeys.push(k);
    });

    // Starts: PM seed (+ user shape params / explicit start), then S0 ± 2.
    var seed0 = {};
    try { seed0 = pm.seed() || {}; } catch (e) { seed0 = {}; }
    var p0 = opts.params0 || {};
    keys.forEach(function (k) {
        if (k === 'k' || k === 'C' || k === 'S' || k === 'pi' || k === 'A' || k === 'T' || k === 'CDe2S') return;
        if (_num(p0[k])) seed0[k] = p0[k];
    });
    if (opts.start) for (var sk in opts.start) if (_num(opts.start[sk]) && keys.indexOf(sk) >= 0) seed0[sk] = opts.start[sk];
    keys.forEach(function (k) {
        if (!_num(seed0[k])) {
            var sp = (pm.spec && pm.spec[k]) || {};
            seed0[k] = _num(sp['default']) ? sp['default'] : 1;
        }
        seed0[k] = _clampSpec(seed0[k], { min: bounds[k][0], max: bounds[k][1] });
        if (logKeys.indexOf(k) >= 0 && !(seed0[k] > 0)) seed0[k] = bounds[k][0] > 0 ? bounds[k][0] : 1e-6;
    });
    var starts = [seed0];
    // Race fits (auto-match) use one start and a wall-clock budget so a slow
    // model (finite-conductivity fracture: ~0.1 s per evaluation) cannot block
    // the UI for minutes. opts.timeBudgetMs applies to any caller.
    var singleStart = !!opts.singleStart;
    if (!singleStart && keys.indexOf('S') >= 0 && !freeze.S) {
        [2, -2].forEach(function (dS) {
            var s2 = _copy(seed0);
            s2.S = _clampSpec(seed0.S + dS, { min: bounds.S[0], max: bounds.S[1] });
            // Skip a start that the bounds collapse onto an existing one.
            for (var q0 = 0; q0 < starts.length; q0++) if (Math.abs(starts[q0].S - s2.S) < 1e-9) return;
            starts.push(s2);
        });
    }
    // Budget = wall clock (browsers) and an estimated evaluation cost (the same
    // cap wherever Date.now() does not advance, e.g. a virtual test clock).
    var budgetMs = _num(opts.timeBudgetMs) ? opts.timeBudgetMs : (opts.race ? 4000 : null);
    var lmOpts = {
        maxIter: _num(opts.maxIter) ? opts.maxIter : 60,
        tolerance: _num(opts.tolerance) ? opts.tolerance : 1e-6,
        logKeys: logKeys
    };
    var nEval = 0;
    if (_pos(budgetMs)) {
        lmOpts.deadline = t0 + budgetMs;
        var nSteps = (adata.rateHistory && adata.rateHistory.length) || 1;
        var costMs = (_pos(entry.evalCostMs) ? entry.evalCostMs : (_EVAL_COST_MS[modelKey] || 3)) *
                     Math.max(1, T.length / 70) * (pm.simple ? 1 : Math.max(1, nSteps));
        lmOpts.shouldStop = function () { return nEval * costMs > budgetMs; };
        var resFn0 = resFn;
        resFn = function (a, b) { nEval++; return resFn0(a, b); };
    }
    var best = null, nStartsOk = 0;
    for (var si = 0; si < starts.length; si++) {
        if (si > 0 && ((lmOpts.deadline && Date.now() > lmOpts.deadline) || (lmOpts.shouldStop && lmOpts.shouldStop()))) break;
        var res;
        try { res = PRiSM_lm(resFn, data, starts[si], bounds, freeze, lmOpts); }
        catch (e) { continue; }
        if (!res || !isFinite(res.ssr)) continue;
        nStartsOk++;
        if (_betterRun(res, best)) best = res;
    }
    if (!best) return fail('Regression failed at every start.');

    var phys = _copy(best.params);
    var dpm = modelDpAll(phys);
    var sh = shiftOf(phys);
    var ssr = 0, mean = 0, cnt = 0;
    idxDp.forEach(function (j) { mean += DP[j] + sh; cnt++; });
    mean /= Math.max(cnt, 1);
    var ssTot = 0;
    idxDp.forEach(function (j) { var e = DP[j] + sh - dpm[j], dv = DP[j] + sh - mean; ssr += e * e; ssTot += dv * dv; });
    var r2 = ssTot > 0 ? 1 - ssr / ssTot : NaN;
    var rmse = Math.sqrt(ssr / Math.max(cnt, 1));

    var derived = {};
    try { derived = pm.derived(phys) || {}; } catch (e) { derived = {}; }
    var physOut = _copy(derived);
    keys.forEach(function (k) { if (_num(phys[k])) physOut[k] = phys[k]; });
    if (floatPi && _num(phys.pi)) physOut.pi = phys.pi;
    var mp = pm.toModelParams(phys);
    var params = {};
    for (var pk in mp.params) if (Object.prototype.hasOwnProperty.call(mp.params, pk) && pk.indexOf('__') !== 0) params[pk] = mp.params[pk];

    var ci95 = _copy(best.ci95), stderr = _copy(best.stderr), identifiable = _copy(best.identifiable);
    keys.forEach(function (k) { if (freeze[k]) { identifiable[k] = false; } });
    if (_pos(physOut.C) && _pos(physOut.Cd) && ci95.C && isFinite(ci95.C[0])) {
        var f = physOut.Cd / physOut.C;
        ci95.Cd = [ci95.C[0] * f, ci95.C[1] * f]; stderr.Cd = stderr.C * f; identifiable.Cd = identifiable.C;
    }
    if (_pos(physOut.kh) && _pos(physOut.k) && ci95.k && isFinite(ci95.k[0])) {
        var fh = physOut.kh / physOut.k;
        ci95.kh = [ci95.k[0] * fh, ci95.k[1] * fh]; stderr.kh = stderr.k * fh; identifiable.kh = identifiable.k;
    }

    var warnings = (adata.warnings || []).slice();
    if (!best.converged) warnings.push('Regression did not converge (' + best.stopReason + ', ' + best.iterations + ' iterations).');
    keys.forEach(function (k) {
        if (freeze[k]) return;
        if (best.atBound && best.atBound[k]) warnings.push('Parameter ' + k + ' is at its bound (' + _fmtNum(phys[k]) + ').');
        else if (identifiable[k] === false) warnings.push('Parameter ' + k + ' is poorly determined by the data (wide interval or strongly correlated).');
    });
    if (pm.mode === 'scale') {
        warnings.push('Well inputs incomplete (' + ((well && well.missing) || []).join(', ') + ') — fitted in scale mode; skin is not identifiable without φ·ct·rw².');
        identifiable.S = false;
    }
    // Inputs still at their store defaults (never entered or accepted): k and S
    // are only as good as those guesses, so S is not reported as identifiable.
    var inputsDefaulted = [];
    if (pm.mode !== 'scale' && well && Array.isArray(well.defaulted)) {
        inputsDefaulted = well.defaulted.filter(function (k) { return ['h', 'B', 'mu', 'phi', 'ct', 'rw'].indexOf(k) >= 0; });
        if (inputsDefaulted.length) {
            warnings.push('Well inputs ' + inputsDefaulted.join(', ') + ' are defaults, not entered values — k and S depend on them; enter or accept them on Well & Test.');
            if (keys.indexOf('S') >= 0) identifiable.S = false;
        }
    }
    // Fracture / horizontal models: S and the reference length trade off along a
    // ridge; flag the length when the two are strongly correlated.
    var refKey = (pm.refLength === 'xf' || pm.refLength === 'Lh') ? pm.refLength : null;
    if (refKey && best.corr && best.freeKeys) {
        var iS = best.freeKeys.indexOf('S'), iL = best.freeKeys.indexOf(refKey);
        if (iS >= 0 && iL >= 0 && Math.abs(best.corr[iS][iL]) > 0.95) {
            identifiable[refKey] = false;
            warnings.push(refKey + ' and S are strongly correlated (r = ' + best.corr[iS][iL].toFixed(3) + ') — ' + refKey + ' is not identifiable from these data.');
        }
    }
    if (isFinite(r2) && r2 < 0.9) warnings.push('Poor match (R² = ' + r2.toFixed(3) + ').');
    // A fit stuck at a bound or with a poor match is not a converged result,
    // whatever the LM stop criterion said ('stationary' / 'plateau' at a bound).
    // Natural bounds (no storage: C at its minimum; fracture-face skin at 0;
    // boundary / shape parameters) do not count.
    var stalledAtBound = [];
    keys.forEach(function (k) {
        if (freeze[k] || !(best.atBound && best.atBound[k])) return;
        if (shapeKeyOf(k)) return;
        // best.atBound already says "within tolerance of a bound"; here we only
        // need which side (same tolerance as atBound, so natural lower bounds
        // stay exempt when the fit stops a hair inside them).
        var lo = bounds[k][0], hi = bounds[k][1];
        var atLo = !isFinite(hi) || Math.abs(phys[k] - lo) <= Math.abs(hi - phys[k]);
        if ((k === 'C' || k === 'CDe2S') && atLo) return;
        if (k === 'S' && atLo && refKey) return;
        stalledAtBound.push(k);
    });
    function shapeKeyOf(k) { return ['k', 'C', 'S', 'pi', 'A', 'T', 'CDe2S'].indexOf(k) < 0 && k !== refKey; }
    var convergedOut = !!best.converged && !(isFinite(r2) && r2 < 0.9) && !stalledAtBound.length;
    var stopOut = best.stopReason;
    if (best.converged && !convergedOut) stopOut = stalledAtBound.length ? 'stalled-at-bound' : 'poor-match';

    var corrOut = null;
    if (best.corr) corrOut = best.corr.map(function (row) { return row.slice(); });

    var fit = {
        ok: true,
        modelKey: modelKey, model: modelKey, kind: 'pressure', source: 'regression',
        mode: pm.mode || 'physical',
        params: params, phys: physOut, fitKeys: keys.slice(), frozen: Object.keys(freeze),
        ci95: ci95, stderr: stderr, corr: corrOut, corrKeys: best.freeKeys.slice(), identifiable: identifiable,
        r2: r2, rmse: rmse, aic: best.aic, dAIC: 0,
        iterations: best.iterations, converged: convergedOut, stopReason: stopOut,
        settled: _lmSettled(best), atBoundKeys: _boundKeys(best, keys, freeze),
        stalledAtBound: stalledAtBound, inputsDefaulted: inputsDefaulted,
        objective: objective, objectiveValue: best.ssr, derivMode: derivMode,
        nPoints: { dp: idxDp.length, deriv: idxD.length }, starts: nStartsOk,
        window: { tmin: isFinite(tmin) ? tmin : T[0], tmax: isFinite(tmax) ? tmax : T[T.length - 1] },
        scales: { A: mp.A, B: mp.B },
        floatPi: floatPi,
        pRef: floatPi && _num(phys.pi) ? phys.pi : pRef,
        pRefSource: floatPi ? 'fitted' : adata.pRefSource,
        testType: adata.testType, timeFn: adata.timeFn,
        datasetHash: _datasetHash(ds),
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        warnings: warnings
    };

    if (opts.bootstrap) {
        try {
            var nb = (opts.bootstrap === true) ? 200 : Math.max(10, opts.bootstrap | 0);
            var bs = PRiSM_bootstrap(resFn, data, phys, {
                nBootstrap: nb, bounds: bounds, freeze: freeze, seed: (opts.seed != null ? opts.seed : 12345),
                lmOpts: { maxIter: 25, tolerance: 1e-5, logKeys: logKeys }
            });
            fit.bootstrap = { n: nb, failures: bs.failures, ci: bs.ci, percentiles: bs.percentiles };
        } catch (e) { fit.warnings.push('Bootstrap failed: ' + e.message); }
    }
    return fit;
}

// Lower SSR wins (equal parameter count → same ordering as AIC), but a converged
// run within 0.1 % of the best SSR is preferred to an unconverged one.
function _betterRun(res, best) {
    if (!best) return true;
    var tol = 1e-3 * Math.max(best.ssr, res.ssr) + 1e-300;
    if (res.converged && !best.converged && res.ssr <= best.ssr + tol) return true;
    if (!res.converged && best.converged && res.ssr >= best.ssr - tol) return false;
    return res.ssr < best.ssr;
}

// Did an LM run settle? A converged run did. An unconverged one (maxIter,
// lambda-max, time budget) counts as settled only when its last iteration
// changed the objective by less than 1 % — i.e. it stopped on a plateau of the
// objective, not in mid-descent (a 3-iteration run from a garbage start can
// pass R² ≥ 0.9 while still moving by orders of magnitude per step).
var SETTLED_REL_DROP = 0.01;
function _lmSettled(res) {
    if (!res) return false;
    if (res.converged) return true;
    var h = res.residualHistory;
    if (!Array.isArray(h) || h.length < 2) return false;
    var prev = h[h.length - 2], last = h[h.length - 1];
    if (!isFinite(prev) || !isFinite(last)) return false;
    return (prev - last) <= SETTLED_REL_DROP * Math.max(Math.abs(prev), 1e-300);
}

// Free parameters sitting (within LM tolerance) at any bound, natural ones included.
function _boundKeys(res, keys, freeze) {
    return keys.filter(function (k) { return !freeze[k] && !!(res && res.atBound && res.atBound[k]); });
}

function _fmtNum(v) { return _num(v) ? (Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3 ? v.toExponential(3) : +v.toPrecision(4)) : String(v); }


// =============================================================================
// SECTION 9 — PRiSM_fitRate — decline-curve regression on q
// =============================================================================
// t_days = t × (days per dataset time unit); hours by default. Keeps t ≥ 0 and
// q > 0 (t > 0 for models that are singular at 0, e.g. Duong). Residuals are
// ln q_d − ln q_m. Rates keep the dataset units; Di is in 1/day.
// =============================================================================

function _daysPerUnit(unit) {
    var u = String(unit || 'h').toLowerCase();
    if (u === 'd' || u === 'day' || u === 'days') return 1;
    if (u === 'mo' || u === 'month' || u === 'months') return 30.4375;
    if (u === 'y' || u === 'yr' || u === 'year' || u === 'years') return 365.25;
    if (u === 'min' || u === 'mins' || u === 'minute' || u === 'minutes') return 1 / 1440;
    if (u === 's' || u === 'sec' || u === 'seconds') return 1 / 86400;
    return 1 / 24;
}

var _RATE_POSITIVE_T = { duong: true };
var _RATE_LOG_KEYS = { qi: 1, q1: 1, Di: 1, tau: 1, reD: 1 };

function _seedRate(modelKey, entry, t, q, base) {
    var s = _copy(base);
    var n = t.length, q0 = q[0];
    var m = Math.max(2, Math.floor(n * 0.2));
    var lnq0 = Math.log(q[0]), lnqm = Math.log(q[Math.min(m, n - 1)]);
    var dtm = t[Math.min(m, n - 1)] - t[0];
    var Dexp = (dtm > 0) ? Math.max((lnq0 - lnqm) / dtm, 1e-6) : 0.01;
    var qi0 = q0 * Math.exp(Dexp * Math.max(t[0], 0));
    if ('qi' in s) s.qi = qi0;
    if ('Di' in s) s.Di = Dexp;
    if ('tau' in s) {
        var tau = t[n - 1];
        for (var i = 0; i < n; i++) if (q[i] < qi0 / Math.E) { tau = Math.max(t[i], 1e-3); break; }
        s.tau = tau;
    }
    if ('q1' in s) {
        var lt = t.map(function (v) { return Math.log(Math.max(v, 1e-9)); });
        s.q1 = (t[0] <= 1 && t[n - 1] >= 1) ? Math.exp(_interpAt(lt, q.map(Math.log), 0)) : q0;
    }
    return s;
}

/**
 * @param {string} modelKey  a kind:'rate' registry model
 * @param {object=} ds       { t, q, timeUnit? } (default PRiSM_dataset)
 * @param {object=} opts     { timeUnit, window:{tmin,tmax} (days), params (start),
 *                             freeze, maxIter, tolerance, bootstrap, seed }
 */
function PRiSM_fitRate(modelKey, ds, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var fail = function (reason) {
        return { ok: false, reason: reason, modelKey: modelKey, model: modelKey, kind: 'rate',
                 source: 'regression', converged: false, warnings: [reason] };
    };
    var entry = _registry()[modelKey];
    if (!entry || typeof entry.pd !== 'function') return fail('Unknown model "' + modelKey + '".');
    if (entry.kind !== 'rate') return fail('"' + modelKey + '" is not a rate model.');
    ds = ds || G.PRiSM_dataset;
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.q)) return fail('No rate data (need t and q columns).');
    var f = _daysPerUnit(opts.timeUnit || ds.timeUnit);
    var positiveT = !!(_RATE_POSITIVE_T[modelKey] || entry.requiresPositiveT);
    var win = opts.window || {};
    var tmin = _num(win.tmin) ? win.tmin : -Infinity, tmax = _num(win.tmax) ? win.tmax : Infinity;
    var rows = [];
    var dropped = 0;
    for (var i = 0; i < ds.t.length; i++) {
        var td = +ds.t[i] * f, qv = +ds.q[i];
        if (!isFinite(td) || !isFinite(qv)) { dropped++; continue; }
        if (td < 0 || (positiveT && td <= 0) || !(qv > 0)) { dropped++; continue; }
        if (td < tmin || td > tmax) continue;
        rows.push({ t: td, q: qv });
    }
    rows.sort(function (a, b) { return a.t - b.t; });
    if (rows.length < 3) return fail('Fewer than 3 usable rate points (need t ≥ 0 and q > 0).');
    var T = rows.map(function (r) { return r.t; }), Q = rows.map(function (r) { return r.q; });
    var lnQ = Q.map(Math.log);

    var st = _state() || {};
    var base = _copy(entry.defaults);
    (entry.paramSpec || []).forEach(function (s) { if (s && s.key && !(s.key in base) && s['default'] !== undefined) base[s.key] = s['default']; });
    var start = opts.params ? _copy(opts.params) : null;
    if (start) for (var bk in base) if (!(bk in start)) start[bk] = base[bk];

    var bounds = {}, logKeys = [];
    (entry.paramSpec || []).forEach(function (s) {
        if (!s || !s.key || typeof base[s.key] !== 'number') return;
        bounds[s.key] = [_num(s.min) ? s.min : -Infinity, _num(s.max) ? s.max : Infinity];
        if (s.scale === 'log' || _RATE_LOG_KEYS[s.key]) logKeys.push(s.key);
    });
    var freeze = {};
    var uf = opts.freeze || (st.model === modelKey ? st.paramFreeze : null) || {};
    for (var fk in uf) if (uf[fk]) freeze[fk] = true;

    // Some evaluators reject t = 0; evaluate those at a vanishing t instead.
    var tEval = T.slice(), needEps = false;
    try { entry.pd([0], _copy(base)); } catch (e) { needEps = true; }
    if (needEps) tEval = T.map(function (v) { return v > 0 ? v : 1e-9; });
    var modelFn = function (_t, params) {
        var qm = _evalArr(entry.pd, tEval, params);
        return qm.map(function (v) { return v > 0 ? Math.log(v) : -700; });
    };
    var data = { t: T.map(function (_, i) { return i; }), p: lnQ };

    var starts = [];
    if (start) starts.push(start);
    else {
        var s0 = _seedRate(modelKey, entry, T, Q, base);
        starts.push(s0);
        if ('b' in s0 && !freeze.b) {
            [0.1, 1.0].forEach(function (bv) { var s1 = _copy(s0); s1.b = bv; starts.push(s1); });
        }
        if ('n' in s0 && !freeze.n) { var s2 = _copy(s0); s2.n = 0.3; starts.push(s2); }
    }
    starts.forEach(function (s) {
        for (var k in bounds) s[k] = _clampSpec(s[k], { min: bounds[k][0], max: bounds[k][1] });
        logKeys.forEach(function (k) { if (!(s[k] > 0)) s[k] = (bounds[k] && bounds[k][0] > 0) ? bounds[k][0] : 1e-6; });
    });
    var lmOpts = {
        maxIter: _num(opts.maxIter) ? opts.maxIter : 200,
        tolerance: _num(opts.tolerance) ? opts.tolerance : 1e-10,
        logKeys: logKeys
    };
    var best = null;
    starts.forEach(function (s) {
        var r;
        try { r = PRiSM_lm(modelFn, data, s, bounds, freeze, lmOpts); } catch (e) { return; }
        if (!r || !isFinite(r.ssr)) return;
        if (_betterRun(r, best)) best = r;
    });
    if (!best) return fail('Rate regression failed at every start.');

    var qm = _evalArr(entry.pd, tEval, best.params);
    var mean = 0; Q.forEach(function (v) { mean += v; }); mean /= Q.length;
    var ssr = 0, ssTot = 0;
    Q.forEach(function (v, i) { var e = v - qm[i]; ssr += e * e; ssTot += (v - mean) * (v - mean); });
    var r2 = ssTot > 0 ? 1 - ssr / ssTot : NaN;
    var rmse = Math.sqrt(ssr / Q.length);

    var params = _copy(best.params);
    var phys = _copy(params);
    if (_num(params.Di)) phys.Di_yr = 365 * params.Di;
    var warnings = [];
    if (dropped) warnings.push(dropped + ' point(s) excluded (t < 0' + (positiveT ? ' or t = 0' : '') + ', q ≤ 0 or non-numeric).');
    if (!best.converged) warnings.push('Rate regression did not converge (' + best.stopReason + ').');
    Object.keys(bounds).forEach(function (k) {
        if (freeze[k]) return;
        if (best.atBound && best.atBound[k]) warnings.push('Parameter ' + k + ' is at its bound (' + _fmtNum(params[k]) + ').');
    });
    if (_num(params.b) && params.b > 1) warnings.push('b > 1: EUR is unbounded without a terminal decline (Dmin).');

    var fit = {
        ok: true,
        modelKey: modelKey, model: modelKey, kind: 'rate', source: 'regression', mode: 'rate',
        params: params, phys: phys, fitKeys: best.freeKeys.slice(), frozen: Object.keys(freeze),
        ci95: best.ci95, stderr: best.stderr, corr: best.corr, corrKeys: best.freeKeys.slice(),
        identifiable: best.identifiable,
        r2: r2, rmse: rmse, aic: best.aic, dAIC: 0,
        iterations: best.iterations, converged: best.converged, stopReason: best.stopReason,
        settled: _lmSettled(best), atBoundKeys: _boundKeys(best, Object.keys(bounds), freeze),
        objective: 'lnq', objectiveValue: best.ssr,
        nPoints: { q: Q.length },
        window: { tmin: T[0], tmax: T[T.length - 1] }, timeUnit: 'd',
        scales: null, pRef: null, pRefSource: null,
        datasetHash: _datasetHash(ds),
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        warnings: warnings
    };
    if (opts.bootstrap) {
        try {
            var nb = (opts.bootstrap === true) ? 200 : Math.max(10, opts.bootstrap | 0);
            var bs = PRiSM_bootstrap(modelFn, data, best.params, {
                nBootstrap: nb, bounds: bounds, freeze: freeze, seed: (opts.seed != null ? opts.seed : 12345),
                lmOpts: { maxIter: 60, tolerance: 1e-8, logKeys: logKeys }
            });
            fit.bootstrap = { n: nb, failures: bs.failures, ci: bs.ci, percentiles: bs.percentiles };
        } catch (e) { fit.warnings.push('Bootstrap failed: ' + e.message); }
    }
    return fit;
}


// =============================================================================
// SECTION 10 — PRiSM_runRegression — Tab 6 glue
// =============================================================================
// Dispatch by entry.kind (missing kind = pressure). Pressure fits use the
// well store (scale mode + warning when incomplete). The fit is always handed
// to PRiSM_setLastFit (honest status: converged / r2 / warnings), but
// st.params / st.phys / st.tcMatch are only adopted when R² ≥ 0.9 and nothing
// is stalled at a bound; an unconverged fit must also have settled (last step
// < 1 % SSR change) with no free parameter at any bound. PRiSM_state.match is
// never written.
// =============================================================================

function _storeLastFit(fit) {
    if (typeof G.PRiSM_setLastFit === 'function') {
        try { G.PRiSM_setLastFit(fit); return; } catch (e) { /* fallback below */ }
    }
    var st = _state();
    if (st) st.lastFit = fit;
    try {
        if (typeof G.dispatchEvent === 'function' && typeof G.CustomEvent === 'function') {
            G.dispatchEvent(new G.CustomEvent('prism:fit-updated', { detail: { source: fit.source, modelKey: fit.modelKey } }));
        }
    } catch (e2) { /* no event system */ }
}

/**
 * @param {object=} opts { modelKey, dataset, well, adata, window, floatPi,
 *                         objective, freeze, start, params, maxIter, tolerance,
 *                         bootstrap, mode, derivMode, timeUnit }
 * @return the stored LastFit object plus { adopted:bool } (never throws for
 *         data/model problems — returns { ok:false, converged:false, reason }).
 */
function PRiSM_runRegression(opts) {
    opts = opts || {};
    var st = _state() || {};
    var modelKey = opts.modelKey || st.model;
    var fail = function (reason) {
        return { ok: false, reason: reason, error: reason, modelKey: modelKey, model: modelKey,
                 converged: false, adopted: false, warnings: [reason], params: st.params, stderr: {}, ci95: {} };
    };
    if (!modelKey) return fail('No model selected.');
    var entry = _registry()[modelKey];
    if (!entry) return fail('Unknown model "' + modelKey + '".');
    var ds = opts.dataset || G.PRiSM_dataset;
    var kind = entry.kind || 'pressure';
    var sameModel = (st.model === modelKey);
    var fit;

    if (kind === 'rate') {
        var startR = opts.params || (sameModel ? _pickNumeric(st.params) : null);
        fit = PRiSM_fitRate(modelKey, ds, {
            timeUnit: opts.timeUnit, window: opts.window, params: opts.start || startR,
            freeze: opts.freeze || (sameModel ? st.paramFreeze : null),
            maxIter: opts.maxIter, tolerance: opts.tolerance, bootstrap: opts.bootstrap, seed: opts.seed
        });
    } else {
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p)) return fail('No pressure data loaded.');
        var well = opts.well || _getWell(ds);
        var adata = opts.adata || _getAnalysisData(ds, well, {
            period: (opts.period != null ? opts.period : st.activePeriod),
            timeFn: opts.timeFn || st.timeFn || 'auto', L: st.bourdetL
        });
        fit = PRiSM_fitPhysical(modelKey, adata, well, {
            dataset: ds, objective: opts.objective, window: opts.window, floatPi: opts.floatPi,
            freeze: opts.freeze || (sameModel ? st.paramFreeze : null),
            start: opts.start, params0: opts.params || (sameModel ? st.params : null),
            maxIter: opts.maxIter, tolerance: opts.tolerance, derivMode: opts.derivMode,
            mode: opts.mode || (well && well.complete === false ? 'scale' : undefined),
            bootstrap: opts.bootstrap, seed: opts.seed, timeBudgetMs: opts.timeBudgetMs
        });
    }
    if (!fit || !fit.ok) {
        var f = fail((fit && fit.reason) || 'Regression failed.');
        return f;
    }

    // Adopt only a sane fit: R² ≥ 0.9 and no headline parameter stuck at a bound
    // (the LM 'stationary' / 'plateau' stops can report converged at a bound
    // with a strongly negative R²). Without an R², fall back to convergence.
    // An UNconverged fit (maxIter / lambda-max / time budget) is adopted only
    // when the objective had settled (last step changed SSR < 1 %) and no free
    // parameter is pinned at any bound — natural bounds included, since only a
    // converged (stationarity-checked) fit may rest on one. Otherwise an early
    // stop from a garbage start that happens to cross R² 0.9 mid-descent (e.g.
    // C slammed to its 1e-8 floor after 3 iterations) would replace st.params.
    var stalled = !!(fit.stalledAtBound && fit.stalledAtBound.length);
    var unsettled = !fit.converged && fit.settled === false;
    var boundUnconv = (!fit.converged && Array.isArray(fit.atBoundKeys)) ? fit.atBoundKeys : [];
    var adopt = isFinite(fit.r2) ? (fit.r2 >= 0.9 && !stalled && !unsettled && !boundUnconv.length)
                                 : (!!fit.converged && !stalled);
    fit.adopted = adopt;
    if (!adopt) {
        // Name the actual reason(s): the stall, the low R², or non-convergence.
        var why = [];
        if (stalled) why.push('parameter at a bound: ' + fit.stalledAtBound.join(', '));
        else if (boundUnconv.length) why.push('not converged with parameter at a bound: ' + boundUnconv.join(', '));
        if (isFinite(fit.r2) && fit.r2 < 0.9) why.push('R² ' + fit.r2.toFixed(3) + ' < 0.9');
        if (unsettled) why.push('not converged (' + (fit.stopReason || 'stopped') + ') and still improving');
        if (!isFinite(fit.r2) && !fit.converged) why.push('not converged');
        if (!why.length) why.push('not converged');
        fit.converged = false;
        if (!Array.isArray(fit.warnings)) fit.warnings = [];
        fit.warnings.push('Fit not adopted (' + why.join('; ') + ') — previous parameters and result kept.');
        // The rejected result is returned to the caller (Tab 6 shows it) but is
        // not stored as lastFit: the rail, step ④ and the report keep the
        // previous, adopted result that matches st.params.
        return fit;
    }
    // Adopt first, then store: prism:fit-updated listeners (undo snapshots, rail,
    // C8 save) must see the adopted params / phys / tcMatch (WP0 fix).
    if (adopt && G.PRiSM_state) {
        var S = G.PRiSM_state;
        if (S.model !== modelKey) {
            if (typeof G.PRiSM_setModel === 'function') { try { G.PRiSM_setModel(modelKey); } catch (e) { S.model = modelKey; } }
            else S.model = modelKey;
        }
        S.params = _copy(fit.params);
        if (fit.kind === 'pressure') {
            S.phys = _copy(fit.phys);
            if (_pos(fit.scales && fit.scales.A) && _pos(fit.scales.B)) {
                S.tcMatch = { logPM: Math.log10(1 / fit.scales.A), logTM: Math.log10(fit.scales.B), source: 'regression' };
            }
        } else {
            S.phys = _copy(fit.phys);
        }
    }
    _storeLastFit(fit);
    if (adopt && G.PRiSM_state) {
        if (typeof G.PRiSM_evalModelCurve === 'function') {
            try { G.PRiSM_evalModelCurve(modelKey, G.PRiSM_state.params, { phys: G.PRiSM_state.phys }); } catch (e) { fit.warnings.push('Model curve refresh failed: ' + e.message); }
        }
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* plot layer reports its own errors */ }
        }
    }
    return fit;
}

function _pickNumeric(o) {
    if (!o) return null;
    var out = {}, any = false;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) { out[k] = o[k]; if (_num(o[k])) any = true; }
    return any ? out : null;
}


// =============================================================================
// SECTION 11 — EXPOSE TO GLOBAL
// =============================================================================

(function _expose() {
    G.PRiSM_lm                    = PRiSM_lm;
    G.PRiSM_bootstrap             = PRiSM_bootstrap;
    G.PRiSM_superposition         = PRiSM_superposition;
    G.PRiSM_sandface_convolution  = PRiSM_sandface_convolution;
    G.PRiSM_agarwalTime           = PRiSM_agarwalTime;
    G.PRiSM_fitPhysical           = PRiSM_fitPhysical;
    G.PRiSM_fitRate               = PRiSM_fitRate;
    G.PRiSM_runRegression         = PRiSM_runRegression;
    G.PRiSM_invertMatrix          = PRiSM_invertMatrix;
    G.PRiSM_solveLinear           = PRiSM_solveLinear;
    G.PRiSM_jacobianForward       = PRiSM_jacobianForward;
    G.PRiSM_tQuantile975          = PRiSM_tQuantile975;
    // Local contract fallbacks, exposed for tests and for layers that need
    // the same behaviour without the core layer loaded.
    G.PRiSM_regressionInternals = {
        well:          _localWell,
        analysisData:  _localAnalysisData,
        physicalModel: _localPhysicalModel,
        bourdet:       _bourdet,
        rateSteps:     _rateStepsFromSamples,
        superpositionTime: function (dt, rateHistory, n) {
            var steps = _normSteps(rateHistory);
            if (n == null) n = steps.length - 1;
            return Math.exp(_supTime(dt, steps, n));
        }
    };
})();


// =============================================================================
// === SELF-TEST ===
// =============================================================================
// Standalone (Node) run: stubs a cheap homogeneous-like model when the
// registry is absent. Stripped at concat.
// =============================================================================

(function _selfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
    var results = [];
    function check(name, fn) {
        try { var v = fn(); results.push({ name: name, ok: !!(v && v.ok), val: v }); }
        catch (e) { results.push({ name: name, ok: false, val: e.message }); }
    }
    var stub = function (td, params) {
        var Cd = params.Cd, S = params.S;
        return td.map(function (t) {
            var x = t / Cd, w = x / (1 + x);
            return w * (0.5 * (Math.log(t) + 0.80907) + S) + (1 - w) * x;
        });
    };

    check('invertMatrix round-trip', function () {
        var A = [[4, 7, 2], [3, 6, 1], [2, 5, 9]], Ai = PRiSM_invertMatrix(A), e = 0;
        for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) {
            var s = 0; for (var k = 0; k < 3; k++) s += A[i][k] * Ai[k][j];
            e = Math.max(e, Math.abs(s - (i === j ? 1 : 0)));
        }
        return { ok: e < 1e-9, e: e };
    });
    check('solveLinear 2x2', function () {
        var x = PRiSM_solveLinear([[2, 1], [5, 7]], [11, 13]);
        return { ok: Math.abs(2 * x[0] + x[1] - 11) < 1e-9 && Math.abs(5 * x[0] + 7 * x[1] - 13) < 1e-9 };
    });
    check('t quantile', function () {
        return { ok: Math.abs(PRiSM_tQuantile975(10) - 2.2281) < 1e-4 && Math.abs(PRiSM_tQuantile975(60) - 2.0003) < 2e-3 };
    });
    check('LM recovers Cd, S (log Cd) from a bad start', function () {
        var td = []; for (var l = -2; l <= 4; l += 0.25) td.push(Math.pow(10, l));
        var y = stub(td, { Cd: 100, S: 2 });
        var fit = PRiSM_lm(stub, { t: td, p: y }, { Cd: 10, S: 0 }, { Cd: [0, 1e10], S: [-7, 50] }, null,
                           { maxIter: 80, tolerance: 1e-9, logKeys: ['Cd'] });
        return { ok: Math.abs(fit.params.Cd - 100) < 0.01 && Math.abs(fit.params.S - 2) < 1e-4 && fit.converged, fit: fit.params, why: fit.stopReason };
    });
    check('superposition buildup recovers', function () {
        var ev = []; for (var k = 0; k < 60; k++) ev.push(0.1 + k * 1.5);
        var ps = PRiSM_superposition(stub, [{ t_start: 0, q: 1 }, { t_start: 10, q: 0 }], ev, { Cd: 100, S: 0 });
        var peak = -Infinity; for (var j = 0; j < ev.length; j++) if (ev[j] <= 10) peak = Math.max(peak, ps[j]);
        return { ok: ps[1] > ps[0] && ps[ps.length - 1] < peak };
    });
    check('Agarwal time single rate', function () {
        var te = PRiSM_agarwalTime([0.24, 100], [{ t: 0, q: 850 }, { t: 100, q: 0 }]);
        return { ok: Math.abs(te[0] - 0.239425) < 1e-4 && Math.abs(te[1] - 50) < 1e-9, te: te };
    });
    check('sandface convolution from samples', function () {
        var c = PRiSM_sandface_convolution({ t: [1, 5, 10, 10.5, 12, 20], p: [9, 7, 6, 8, 8.5, 9], q: [1, 1, 1, 0, 0, 0] });
        return { ok: c.tShut === 10 && isFinite(c.teq[5]) && !isFinite(c.teq[1]) && Math.abs(c.tp - 10) < 1e-12 };
    });

    var fails = results.filter(function (r) { return !r.ok; });
    if (fails.length) err('✗ regression self-test FAILED (' + fails.length + ' of ' + results.length + ')', fails);
    else log('✓ regression self-test passed (' + results.length + ' checks).');
})();


})();
