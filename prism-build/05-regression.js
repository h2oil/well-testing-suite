// =============================================================================
// PRiSM — Phase 3 Regression & Multi-Rate Machinery
// Layer 05 — Levenberg-Marquardt + Bootstrap + Superposition + Convolution
// -----------------------------------------------------------------------------
// This file is the fifth in the PRiSM build, layered on top of the foundation
// (Stehfest, Bessel, Ei, logspace), the model registry (PRiSM_MODELS, ~13
// type-curve evaluators), and the plot suite. It supplies the numerical
// machinery the UI layer needs to drive Tab 6 (Regress) and any multi-rate
// workflow exposed on Tab 1 (Data) or Tab 2 (Plots).
//
// Public exports (all on window.*):
//
//   PRiSM_lm                   — Levenberg-Marquardt least squares
//   PRiSM_bootstrap            — non-parametric residual bootstrap CIs
//   PRiSM_superposition        — convolve a rate history over a unit-rate model
//   PRiSM_sandface_convolution — Agarwal-equivalent-time multi-rate cleanup
//   PRiSM_runRegression        — glue used by Agent A's Tab 6
//
// Lower-level helpers (also exposed for unit-testing and downstream use):
//
//   PRiSM_invertMatrix         — Gauss-Jordan elimination with partial pivoting
//   PRiSM_solveLinear          — solve A·x = b in-place
//   PRiSM_jacobianForward      — forward-difference Jacobian wrt free params
//
// Implementation notes:
//   - No external numeric libraries. Gauss-Jordan + partial pivoting inline.
//   - Bounds projection by simple clipping at the parameter level (not a
//     proper trust-region affine-scaling step but adequate for type-curve
//     regression where bounds are usually inactive at the optimum).
//   - Frozen parameters are removed from the active subspace entirely so the
//     normal equations stay well-conditioned even when several params are
//     held fixed.
//   - Categorical/string params (e.g. linearBoundary BC: 'noflow'|'constP')
//     are auto-frozen since they cannot enter a finite-difference Jacobian.
//
// Style: vanilla JS, IIFE wrapper, robust to load-order (works without the
// model registry being present).
// =============================================================================


(function () {
'use strict';


// =============================================================================
// SECTION 1 — LINEAR ALGEBRA (Gauss-Jordan inversion + linear solver)
// =============================================================================
// Hand-rolled because we do not pull in a matrix lib. Regression problems
// here are tiny (n_params is typically 2–8) so O(n^3) is fine.
// =============================================================================


// Allocate an n×n zero matrix as an Array of Arrays. Used everywhere below.
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

// Deep-copy a 2D matrix.
function _copy2D(A) {
    var n = A.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = A[i].slice();
    return out;
}


/**
 * Invert an n×n matrix in place via Gauss-Jordan elimination with partial
 * pivoting. Returns the inverse as a new matrix; the input is preserved.
 *
 * @param  {number[][]} A  Square matrix.
 * @return {number[][]}    A^{-1} as a freshly-allocated matrix.
 * @throws if A is singular or non-square.
 */
function PRiSM_invertMatrix(A) {
    if (!Array.isArray(A) || !A.length) throw new Error('PRiSM_invertMatrix: empty matrix');
    var n = A.length;
    for (var i = 0; i < n; i++) {
        if (!Array.isArray(A[i]) || A[i].length !== n) {
            throw new Error('PRiSM_invertMatrix: matrix must be square (got ' + n + 'x' + (A[i] ? A[i].length : '?') + ')');
        }
    }

    // Build the augmented matrix [A | I]. Work on a copy so the input is
    // untouched.
    var M = new Array(n);
    for (var r = 0; r < n; r++) {
        var row = new Array(2 * n);
        for (var c = 0; c < n; c++) row[c] = A[r][c];
        for (var c2 = 0; c2 < n; c2++) row[n + c2] = (r === c2) ? 1 : 0;
        M[r] = row;
    }

    // Forward elimination with partial pivoting.
    for (var k = 0; k < n; k++) {
        // Find the row with the largest |M[r][k]| in column k from row k down.
        var pivotRow = k;
        var pivotVal = Math.abs(M[k][k]);
        for (var rr = k + 1; rr < n; rr++) {
            var v = Math.abs(M[rr][k]);
            if (v > pivotVal) { pivotVal = v; pivotRow = rr; }
        }
        if (pivotVal < 1e-14) {
            throw new Error('PRiSM_invertMatrix: matrix is singular (pivot ' + pivotVal + ' at column ' + k + ')');
        }
        if (pivotRow !== k) {
            var tmp = M[k]; M[k] = M[pivotRow]; M[pivotRow] = tmp;
        }

        // Scale the pivot row so M[k][k] = 1.
        var inv = 1.0 / M[k][k];
        for (var c3 = 0; c3 < 2 * n; c3++) M[k][c3] *= inv;

        // Zero out column k in every other row.
        for (var ir = 0; ir < n; ir++) {
            if (ir === k) continue;
            var f = M[ir][k];
            if (f === 0) continue;
            for (var c4 = 0; c4 < 2 * n; c4++) M[ir][c4] -= f * M[k][c4];
        }
    }

    // The right half of M is now A^{-1}.
    var Ainv = _zeros2D(n, n);
    for (var rr2 = 0; rr2 < n; rr2++) {
        for (var cc = 0; cc < n; cc++) Ainv[rr2][cc] = M[rr2][n + cc];
    }
    return Ainv;
}


/**
 * Solve A·x = b for x. Uses the same Gauss-Jordan kernel as PRiSM_invertMatrix
 * but only needs one extra column on the augmented matrix, so it's a touch
 * cheaper than building the full inverse.
 *
 * @param  {number[][]} A  Square n×n matrix.
 * @param  {number[]}   b  Length-n RHS vector.
 * @return {number[]}      Length-n solution x.
 */
function PRiSM_solveLinear(A, b) {
    var n = A.length;
    if (b.length !== n) throw new Error('PRiSM_solveLinear: dimension mismatch (A is ' + n + 'x' + n + ', b is ' + b.length + ')');

    // Augmented [A | b].
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
        if (pivotVal < 1e-14) {
            throw new Error('PRiSM_solveLinear: matrix is singular (pivot ' + pivotVal + ' at column ' + k + ')');
        }
        if (pivotRow !== k) {
            var tmp = M[k]; M[k] = M[pivotRow]; M[pivotRow] = tmp;
        }
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


// Inverse-with-fallback: try Gauss-Jordan, else add a tiny ridge to the
// diagonal and retry. Used to compute the parameter covariance matrix from
// JᵀJ — at the optimum that matrix can be near-singular if a parameter is
// poorly identified by the data.
function _safeInvert(A) {
    try {
        return PRiSM_invertMatrix(A);
    } catch (e) {
        var n = A.length;
        var ridge = 1e-10;
        // Trace-based scaling so the ridge is meaningful for matrices with
        // very small or very large diagonals.
        var trace = 0;
        for (var i = 0; i < n; i++) trace += Math.abs(A[i][i]);
        ridge = Math.max(ridge, 1e-10 * (trace / n));
        var Aplus = _copy2D(A);
        for (var i2 = 0; i2 < n; i2++) Aplus[i2][i2] += ridge;
        try {
            return PRiSM_invertMatrix(Aplus);
        } catch (e2) {
            return null; // give up; caller flags stderr / CI as NaN
        }
    }
}


// =============================================================================
// SECTION 2 — JACOBIAN VIA FORWARD DIFFERENCES
// =============================================================================
// Most PRiSM models are Stehfest-inverted Laplace-domain expressions; analytic
// derivatives are not available. Forward difference is cheap (n_free + 1 model
// evaluations per Jacobian) and adequate for LM, since the algorithm only
// needs J accurate to a few digits to converge.
//
// Step size: h_j = derivStep · max(|p_j|, 1.0) so we don't underflow when a
// parameter happens to be near zero (e.g. skin S = 0).
// =============================================================================


/**
 * Build the J matrix (n × n_free) of partial derivatives ∂model_i / ∂p_j with
 * one model call per free parameter via forward differences.
 *
 * @param {Function}     modelFn    function(td_array, params_obj) → pd_array
 * @param {number[]}     t          length-n input times (already passed straight
 *                                  to modelFn — the caller decides whether
 *                                  these are td or real time)
 * @param {object}       params     full parameter object (numeric + string)
 * @param {number[]}     baseline   modelFn(t, params) — passed in to avoid
 *                                  recomputing it
 * @param {string[]}     freeKeys   names of the parameters being optimised
 * @param {number}       derivStep  relative finite-difference step
 * @param {number[]=}    bounds     optional [[lo, hi], ...] aligned with freeKeys
 *                                  — only used to swap to a backward step if
 *                                  forward would push the param out of range
 * @return {number[][]}             n × n_free Jacobian
 */
function PRiSM_jacobianForward(modelFn, t, params, baseline, freeKeys, derivStep, bounds) {
    var n = t.length;
    var nf = freeKeys.length;
    var J = _zeros2D(n, nf);

    for (var j = 0; j < nf; j++) {
        var k = freeKeys[j];
        var p0 = params[k];
        var h = derivStep * Math.max(Math.abs(p0), 1.0);

        // Decide direction: forward unless that would exceed an upper bound.
        var dir = 1;
        if (bounds && bounds[j]) {
            var lo = bounds[j][0], hi = bounds[j][1];
            if (isFinite(hi) && (p0 + h) > hi) dir = -1;
            if (isFinite(lo) && dir < 0 && (p0 - h) < lo) {
                // both directions pinned by bounds — last resort, shrink step
                h = Math.min(h, Math.max(1e-12, 0.5 * (hi - lo)));
                dir = (Math.abs(hi - p0) >= Math.abs(p0 - lo)) ? 1 : -1;
            }
        }

        // Build the perturbed param object. Shallow-copy and overwrite one key.
        var pertParams = {};
        for (var k2 in params) {
            if (params.hasOwnProperty(k2)) pertParams[k2] = params[k2];
        }
        pertParams[k] = p0 + dir * h;

        var fpert;
        try {
            fpert = modelFn(t, pertParams);
        } catch (err) {
            // If the model rejects the perturbed value, retry with smaller h.
            // After 3 shrinks, give up and zero out this column (effectively
            // freezing the parameter for this iteration only).
            var ok = false;
            var hh = h;
            for (var s = 0; s < 3; s++) {
                hh *= 0.1;
                pertParams[k] = p0 + dir * hh;
                try { fpert = modelFn(t, pertParams); ok = true; h = hh; break; }
                catch (err2) { /* keep shrinking */ }
            }
            if (!ok) {
                for (var i = 0; i < n; i++) J[i][j] = 0;
                continue;
            }
        }

        var inv_h = 1.0 / (dir * h);
        for (var i2 = 0; i2 < n; i2++) {
            J[i2][j] = (fpert[i2] - baseline[i2]) * inv_h;
        }
    }
    return J;
}


// =============================================================================
// SECTION 3 — LEVENBERG-MARQUARDT NON-LINEAR LEAST SQUARES
// =============================================================================
// Standard Marquardt-modified Gauss-Newton:
//
//     (JᵀWJ + λ·diag(JᵀWJ)) · Δ = JᵀW·r        ← Marquardt's variant
//
// where r = y_obs − y_model, W is the weight matrix (diagonal here), and λ
// is adapted: divide on accept, multiply on reject. The diag(JᵀWJ) flavour
// (instead of plain λ·I) is what most modern LM implementations use because
// it scales each parameter direction independently — important for problems
// like ours where Cd ~ 100 and S ~ 0 live on very different scales.
//
// Convergence: stop when the relative change in every active parameter falls
// below `tolerance`, or when SSR fails to improve by more than 1e-12 across
// 5 consecutive accepted steps, or after maxIter iterations.
// =============================================================================


// Default options used when the caller omits a field on the opts object.
var LM_DEFAULTS = {
    maxIter:        100,
    tolerance:      1e-6,
    lambda0:        0.001,
    lambdaUp:       10,
    lambdaDown:     0.1,
    lambdaMax:      1e10,
    lambdaMin:      1e-12,
    derivStep:      1e-4,
    weightingMode:  'uniform',   // 'uniform' | 'inverse_p' | 'inverse_log'
    logResiduals:   true,
    onIter:         null,
    marquardtScale: 'jjdiag'     // 'jjdiag' (default, scale-invariant) or 'identity'
};


// Build the diagonal weight vector W from the data and the chosen mode.
//   uniform     → W_i = 1
//   inverse_p   → W_i = 1 / p_i^2  (relative residuals; standard for log-log)
//   inverse_log → W_i = 1 / max(ln(p_i)^2, 1e-6)  (rare; log-derivative weighting)
function _buildWeights(p, mode, explicit) {
    var n = p.length;
    var W = new Array(n);
    if (Array.isArray(explicit) && explicit.length === n) {
        for (var i = 0; i < n; i++) W[i] = (explicit[i] > 0) ? explicit[i] : 0;
        return W;
    }
    if (mode === 'inverse_p') {
        for (var i2 = 0; i2 < n; i2++) {
            var pi = Math.abs(p[i2]);
            W[i2] = (pi > 1e-20) ? (1.0 / (pi * pi)) : 1.0;
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
    // uniform
    for (var i4 = 0; i4 < n; i4++) W[i4] = 1.0;
    return W;
}


// SSR = Σ W_i · (y_obs_i − y_model_i)^2 — the objective LM minimises.
function _ssr(yObs, yMod, W) {
    var s = 0;
    for (var i = 0; i < yObs.length; i++) {
        var r = yObs[i] - yMod[i];
        s += W[i] * r * r;
    }
    return s;
}


// Determine which parameters are floating: numeric, finite, not frozen, and
// (in case of categorical) not a string.
function _activeParams(params0, freeze) {
    var keys = [];
    for (var k in params0) {
        if (!params0.hasOwnProperty(k)) continue;
        if (freeze && freeze[k] === true) continue;
        var v = params0[k];
        if (typeof v !== 'number' || !isFinite(v)) continue; // skip strings / NaN
        keys.push(k);
    }
    return keys;
}


// Project a candidate parameter vector back into the bound box.
function _clipToBounds(params, freeKeys, bounds) {
    if (!bounds) return params;
    for (var j = 0; j < freeKeys.length; j++) {
        var k = freeKeys[j];
        var b = bounds[k];
        if (!b) continue;
        var lo = b[0], hi = b[1];
        if (isFinite(lo) && params[k] < lo) params[k] = lo;
        if (isFinite(hi) && params[k] > hi) params[k] = hi;
    }
    return params;
}


/**
 * Levenberg-Marquardt least-squares fit.
 *
 * Returns a richly-decorated result object (see header comment in the file
 * docstring) including parameter standard errors, 95% confidence intervals,
 * AIC, R², RMSE, and the SSR-per-iteration history.
 *
 * @param {Function} modelFn  f(t_array, params_obj) → pd_array
 * @param {object}   data     { t: number[], p: number[], weights?: number[] }
 * @param {object}   params0  initial guess
 * @param {object=}  bounds   { key: [lo, hi], ... }
 * @param {object=}  freeze   { key: true|false, ... }
 * @param {object=}  opts     see LM_DEFAULTS
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

    // Merge opts with defaults.
    var O = {};
    for (var k0 in LM_DEFAULTS) if (LM_DEFAULTS.hasOwnProperty(k0)) O[k0] = LM_DEFAULTS[k0];
    if (opts) for (var k1 in opts) if (opts.hasOwnProperty(k1)) O[k1] = opts[k1];

    // Identify the active (free, numeric) parameter set.
    var freeKeys = _activeParams(params0, freeze);
    if (!freeKeys.length) {
        // Nothing to fit. Return a zero-iteration result so callers can still
        // get goodness-of-fit numbers for an "as-supplied" parameter set.
        var yMod0 = modelFn(data.t, params0);
        var W0 = _buildWeights(data.p, O.weightingMode, data.weights);
        var ssr0 = _ssr(data.p, yMod0, W0);
        return _buildResult(params0, freeKeys, [], data, yMod0, W0, ssr0,
                            null, 0, false, [ssr0]);
    }

    // Make a working copy of the params we'll mutate. Strings + frozen keys
    // are carried through untouched.
    var params = {};
    for (var kk in params0) if (params0.hasOwnProperty(kk)) params[kk] = params0[kk];
    _clipToBounds(params, freeKeys, bounds);

    // Pre-compute the weight vector.
    var W = _buildWeights(data.p, O.weightingMode, data.weights);

    // Per-free-key bound array, aligned with freeKeys, for use in the Jacobian
    // direction picker.
    var boundArr = freeKeys.map(function (k) {
        if (!bounds || !bounds[k]) return [-Infinity, Infinity];
        return bounds[k];
    });

    // Initial model + SSR.
    var yMod = modelFn(data.t, params);
    var ssr = _ssr(data.p, yMod, W);
    var history = [ssr];

    var lambda = O.lambda0;
    var iter = 0;
    var converged = false;
    var stagnantSteps = 0;

    while (iter < O.maxIter) {
        iter++;

        // --- 1. Build Jacobian ----------------------------------------------
        var J = PRiSM_jacobianForward(modelFn, data.t, params, yMod, freeKeys,
                                       O.derivStep, boundArr);

        // --- 2. Form JᵀWJ and JᵀW·r ------------------------------------------
        var nf = freeKeys.length;
        var n  = data.t.length;
        var JtWJ = _zeros2D(nf, nf);
        var JtWr = new Array(nf);
        for (var jj = 0; jj < nf; jj++) JtWr[jj] = 0;

        for (var i = 0; i < n; i++) {
            var ri = data.p[i] - yMod[i];
            var wi = W[i];
            for (var a = 0; a < nf; a++) {
                var Jia = J[i][a];
                if (Jia === 0) continue;
                JtWr[a] += wi * Jia * ri;
                for (var b = a; b < nf; b++) {
                    JtWJ[a][b] += wi * Jia * J[i][b];
                }
            }
        }
        // Symmetrise.
        for (var a2 = 0; a2 < nf; a2++) {
            for (var b2 = a2 + 1; b2 < nf; b2++) JtWJ[b2][a2] = JtWJ[a2][b2];
        }

        // Snapshot diag(JᵀWJ) for the Marquardt damping. Floor at 1e-30 to
        // avoid divide-by-zero if a column is identically zero (frozen-by-
        // bounds parameter).
        var diagJtWJ = new Array(nf);
        for (var d = 0; d < nf; d++) {
            diagJtWJ[d] = Math.max(JtWJ[d][d], 1e-30);
        }

        // --- 3. Inner loop: try a damped step, adjust lambda on reject -----
        var accepted = false;
        var innerTries = 0;
        var newSsr = ssr;
        var newParams = params;
        var newYMod = yMod;
        var dParams = null;

        while (!accepted && innerTries < 30) {
            innerTries++;

            // Build (JᵀWJ + λ·D) where D is the chosen Marquardt scaling.
            var A = _copy2D(JtWJ);
            for (var dd = 0; dd < nf; dd++) {
                if (O.marquardtScale === 'identity') A[dd][dd] += lambda;
                else A[dd][dd] += lambda * diagJtWJ[dd];
            }

            // Solve for the parameter update.
            var deltaTry;
            try {
                deltaTry = PRiSM_solveLinear(A, JtWr);
            } catch (e) {
                // Singular — bump lambda and try again.
                lambda *= O.lambdaUp;
                if (lambda > O.lambdaMax) break;
                continue;
            }

            // Apply the step, project onto bounds.
            var trialParams = {};
            for (var pk in params) if (params.hasOwnProperty(pk)) trialParams[pk] = params[pk];
            for (var jj2 = 0; jj2 < nf; jj2++) {
                trialParams[freeKeys[jj2]] = params[freeKeys[jj2]] + deltaTry[jj2];
            }
            _clipToBounds(trialParams, freeKeys, bounds);

            // Evaluate SSR at the trial.
            var trialY;
            try { trialY = modelFn(data.t, trialParams); }
            catch (err) {
                lambda *= O.lambdaUp;
                if (lambda > O.lambdaMax) break;
                continue;
            }
            var trialSsr = _ssr(data.p, trialY, W);

            if (isFinite(trialSsr) && trialSsr < ssr) {
                // Accept: shrink lambda toward Newton.
                accepted = true;
                newSsr   = trialSsr;
                newParams = trialParams;
                newYMod  = trialY;
                dParams  = deltaTry;
                lambda   = Math.max(lambda * O.lambdaDown, O.lambdaMin);
            } else {
                // Reject: grow lambda toward steepest descent.
                lambda *= O.lambdaUp;
                if (lambda > O.lambdaMax) break;
            }
        }

        // --- 4. Bookkeeping & convergence checks ---------------------------
        if (!accepted) {
            // Lambda blew up — terminate and return what we've got.
            history.push(ssr);
            if (typeof O.onIter === 'function') {
                try { O.onIter(iter, params, ssr, lambda); } catch (_) {}
            }
            break;
        }

        // Compute relative-change vector for convergence test.
        var maxRel = 0;
        for (var rk = 0; rk < nf; rk++) {
            var pOld = params[freeKeys[rk]];
            var pNew = newParams[freeKeys[rk]];
            var denom = Math.max(Math.abs(pOld), 1e-12);
            var rel = Math.abs(pNew - pOld) / denom;
            if (rel > maxRel) maxRel = rel;
        }

        // Plateau detection.
        if (Math.abs(ssr - newSsr) < 1e-12 * Math.max(Math.abs(ssr), 1e-12)) {
            stagnantSteps++;
        } else {
            stagnantSteps = 0;
        }

        // Adopt the new state.
        params = newParams;
        yMod   = newYMod;
        ssr    = newSsr;
        history.push(ssr);

        if (typeof O.onIter === 'function') {
            try { O.onIter(iter, params, ssr, lambda); } catch (_) {}
        }

        if (maxRel < O.tolerance) {
            converged = true;
            break;
        }
        if (stagnantSteps >= 5) {
            converged = true; // SSR plateaued; effectively converged
            break;
        }
    }

    // --- 5. Build the final result with covariance / CIs --------------------
    // Recompute Jacobian at the optimum to get a clean covariance estimate.
    var Jfinal = PRiSM_jacobianForward(modelFn, data.t, params, yMod, freeKeys,
                                        O.derivStep, boundArr);
    return _buildResult(params, freeKeys, Jfinal, data, yMod, W, ssr,
                        null, iter, converged, history);
}


// Goodness-of-fit + covariance / stderr / CI assembler. Pulled out so the
// "no free params" path can short-circuit straight to it.
function _buildResult(params, freeKeys, J, data, yMod, W, ssr,
                       _unused, iter, converged, history) {
    var n = data.t.length;
    var p = freeKeys.length;
    var dof = Math.max(n - p, 1);
    var rmse = Math.sqrt(ssr / Math.max(n, 1));

    // R² — use unweighted variance for an interpretable number.
    var pMean = 0;
    for (var i = 0; i < n; i++) pMean += data.p[i];
    pMean /= Math.max(n, 1);
    var ssTot = 0, ssRes = 0;
    for (var i2 = 0; i2 < n; i2++) {
        var d  = data.p[i2] - pMean;
        var rr = data.p[i2] - yMod[i2];
        ssTot += d * d;
        ssRes += rr * rr;
    }
    var r2 = (ssTot > 1e-20) ? (1 - ssRes / ssTot) : 0;

    // AIC = n · ln(SSR/n) + 2p   (small-sample AICc available too — caller
    // can recompute if needed). Falls back to NaN if SSR is non-positive.
    var aic;
    if (ssr > 0 && n > 0) {
        aic = n * Math.log(ssr / n) + 2 * p;
    } else {
        aic = NaN;
    }

    // Covariance: σ² · (JᵀWJ)^{-1}. σ² estimated from unweighted residuals
    // when weights are uniform; otherwise from the weighted SSR / dof — both
    // are common conventions.
    var stderr = {};
    var ci95 = {};
    var covariance = null;
    if (J && p > 0 && Array.isArray(J) && J.length === n) {
        var JtWJ = _zeros2D(p, p);
        for (var ii = 0; ii < n; ii++) {
            var wi = W[ii];
            for (var aa = 0; aa < p; aa++) {
                var Jia = J[ii][aa];
                if (Jia === 0) continue;
                for (var bb = aa; bb < p; bb++) {
                    JtWJ[aa][bb] += wi * Jia * J[ii][bb];
                }
            }
        }
        for (var aa2 = 0; aa2 < p; aa2++) {
            for (var bb2 = aa2 + 1; bb2 < p; bb2++) JtWJ[bb2][aa2] = JtWJ[aa2][bb2];
        }
        var inv = _safeInvert(JtWJ);
        if (inv) {
            // σ² estimate: use unweighted residuals when weighting is uniform,
            // weighted otherwise. (The textbook formula is residual² / dof.)
            var resSqUnweighted = 0;
            for (var rr2 = 0; rr2 < n; rr2++) {
                var dd2 = data.p[rr2] - yMod[rr2];
                resSqUnweighted += dd2 * dd2;
            }
            var sigma2 = resSqUnweighted / dof;
            covariance = _zeros2D(p, p);
            for (var u = 0; u < p; u++) {
                for (var v = 0; v < p; v++) covariance[u][v] = sigma2 * inv[u][v];
            }
            for (var fk = 0; fk < p; fk++) {
                var var_k = covariance[fk][fk];
                var se = (var_k > 0) ? Math.sqrt(var_k) : NaN;
                stderr[freeKeys[fk]] = se;
                if (isFinite(se)) {
                    ci95[freeKeys[fk]] = [params[freeKeys[fk]] - 1.96 * se,
                                          params[freeKeys[fk]] + 1.96 * se];
                } else {
                    ci95[freeKeys[fk]] = [NaN, NaN];
                }
            }
        }
    }
    // Frozen / non-numeric params get NaN entries so the result shape is
    // consistent across calls.
    for (var pk in params) {
        if (!params.hasOwnProperty(pk)) continue;
        if (!(pk in stderr)) {
            stderr[pk] = NaN;
            ci95[pk] = [NaN, NaN];
        }
    }

    return {
        params:           params,
        stderr:           stderr,
        ci95:             ci95,
        ssr:              ssr,
        rmse:             rmse,
        r2:               r2,
        aic:              aic,
        iterations:       iter,
        converged:        converged,
        covariance:       covariance,
        residualHistory:  history,
        nFreeParams:      p,
        nObs:             n,
        freeKeys:         freeKeys.slice()
    };
}


// =============================================================================
// SECTION 4 — BOOTSTRAP CONFIDENCE INTERVALS
// =============================================================================
// Non-parametric residual bootstrap. Useful when the Jacobian-based CIs are
// unreliable — e.g. heavy non-linearity, small N, or pinned bounds.
//
// Algorithm (Efron-style residual bootstrap):
//   1. Compute residuals r_i = p_i − model(t_i, p̂).
//   2. For b = 1..nBootstrap:
//        a. Resample residuals with replacement: r*_i.
//        b. Synthetic data: y*_i = model(t_i, p̂) + r*_i.
//        c. Refit, collect parameter estimates p̂*_b.
//   3. CI = (α/2, 1−α/2) percentiles of {p̂*_b}.
// =============================================================================


/**
 * Non-parametric bootstrap confidence intervals for an LM-fitted model.
 *
 * @param {Function} modelFn       f(t_array, params_obj) → pd_array
 * @param {object}   data          { t, p, weights? }
 * @param {object}   fittedParams  best-fit params from PRiSM_lm
 * @param {object=}  opts          { nBootstrap: 200, ci: 0.95, bounds, freeze,
 *                                   lmOpts, seed, onProgress }
 * @return {object}  { ci: { key: [lo, hi] }, distributions: { key: number[] } }
 */
function PRiSM_bootstrap(modelFn, data, fittedParams, opts) {
    opts = opts || {};
    var nBoot = opts.nBootstrap || 200;
    var ciLevel = (opts.ci != null) ? opts.ci : 0.95;
    var lmOpts = opts.lmOpts || { maxIter: 30, tolerance: 1e-5 };
    var bounds = opts.bounds || null;
    var freeze = opts.freeze || null;
    var onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;

    // Seeded PRNG so bootstrap is reproducible when a seed is supplied.
    var rng = _makeRng(opts.seed);

    // Step 1 — residuals at the fitted optimum.
    var yHat = modelFn(data.t, fittedParams);
    var n = data.t.length;
    var residuals = new Array(n);
    for (var i = 0; i < n; i++) residuals[i] = data.p[i] - yHat[i];

    // Step 2 — collect param distributions across bootstrap replicates.
    var distributions = {};
    var freeKeys = _activeParams(fittedParams, freeze);
    for (var k = 0; k < freeKeys.length; k++) distributions[freeKeys[k]] = [];

    var failures = 0;
    for (var b = 0; b < nBoot; b++) {
        // Resample residuals with replacement.
        var pStar = new Array(n);
        for (var i2 = 0; i2 < n; i2++) {
            var idx = (rng() * n) | 0;
            if (idx >= n) idx = n - 1;
            pStar[i2] = yHat[i2] + residuals[idx];
        }

        var dataStar = { t: data.t, p: pStar, weights: data.weights };
        var initParams = {};
        for (var pk in fittedParams) {
            if (fittedParams.hasOwnProperty(pk)) initParams[pk] = fittedParams[pk];
        }

        var res;
        try {
            res = PRiSM_lm(modelFn, dataStar, initParams, bounds, freeze, lmOpts);
        } catch (err) {
            failures++;
            continue;
        }
        for (var fk2 = 0; fk2 < freeKeys.length; fk2++) {
            var key = freeKeys[fk2];
            distributions[key].push(res.params[key]);
        }
        if (onProgress) {
            try { onProgress(b + 1, nBoot); } catch (_) {}
        }
    }

    // Step 3 — percentile CIs.
    var alpha = (1 - ciLevel) / 2;
    var ci = {};
    for (var fk3 = 0; fk3 < freeKeys.length; fk3++) {
        var key2 = freeKeys[fk3];
        var arr = distributions[key2].slice().sort(function (a, b) { return a - b; });
        if (arr.length < 4) {
            ci[key2] = [NaN, NaN];
            continue;
        }
        ci[key2] = [_percentile(arr, alpha), _percentile(arr, 1 - alpha)];
    }
    return { ci: ci, distributions: distributions, nBootstrap: nBoot, failures: failures };
}


// Linear-interpolated percentile of a sorted array. q ∈ [0, 1].
function _percentile(sorted, q) {
    var n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    var pos = q * (n - 1);
    var lo  = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}


// Tiny mulberry32 PRNG. Returns a function () → uniform [0, 1). If seed is
// undefined we fall back to Math.random.
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
// For a unit-rate model response p_unit(t), the variable-rate response is
//
//   p(t) = Σ_{i: t_i < t} (q_i − q_{i-1}) · p_unit(t − t_i)
//
// This is the classical superposition-in-time used for build-ups, falloffs
// after multi-rate drawdown, injection-then-falloff sequences, etc. The user
// supplies a tdNormaliser that converts real time into the model's
// dimensionless time td (the model knows nothing about real units).
// =============================================================================


/**
 * Variable-rate pressure response built from a single-rate model.
 *
 * @param {Function} modelFn      f(td_array, params) → pd_array
 * @param {object[]} rateHistory  [{ t_start: 0, q: 1000 }, { t_start: 100, q: 0 }, ...]
 *                                Sorted by t_start ascending. Implicit q(0−) = 0
 *                                so the first step contributes Δq = q_1 − 0.
 * @param {number[]} evalTimes    real-time points to evaluate
 * @param {object}   params       model parameters
 * @param {Function=} tdNormaliser  optional f(t_real, params) → td. Defaults to
 *                                  identity (treat real time as td).
 * @return {number[]}             pressures at evalTimes
 */
function PRiSM_superposition(modelFn, rateHistory, evalTimes, params, tdNormaliser) {
    if (!Array.isArray(rateHistory) || !rateHistory.length) {
        throw new Error('PRiSM_superposition: rateHistory must be a non-empty array');
    }
    if (!Array.isArray(evalTimes) || !evalTimes.length) {
        throw new Error('PRiSM_superposition: evalTimes must be a non-empty array');
    }
    var ndt = (typeof tdNormaliser === 'function') ? tdNormaliser : function (t) { return t; };

    // Sort & sanitize the rate history.
    var rh = rateHistory.slice().sort(function (a, b) { return a.t_start - b.t_start; });

    // Pre-compute Δq_i = q_i − q_{i-1} (q_{-1} = 0 by convention).
    var dq = new Array(rh.length);
    for (var i = 0; i < rh.length; i++) {
        var qPrev = (i === 0) ? 0 : rh[i - 1].q;
        dq[i] = rh[i].q - qPrev;
    }

    // For each evalTime t, accumulate Σ_{i: t_i < t} Δq_i · p_unit(td(t − t_i)).
    // We collect (i, j, td_ij) triples and batch them through modelFn so we
    // pay the Stehfest cost once per unique td value.
    //
    // Build flat lists, dispatch in one model call for efficiency.
    var n = evalTimes.length;
    var out = new Array(n);
    for (var k = 0; k < n; k++) out[k] = 0;

    // Walk every (eval-time, rate-step) combination. For each one with a
    // positive elapsed time, add a contribution.
    for (var i2 = 0; i2 < rh.length; i2++) {
        if (dq[i2] === 0) continue;
        var tStart = rh[i2].t_start;

        // Build the elapsed-time / td array for the active eval times.
        var tdActive = [];
        var tdActiveIdx = [];
        for (var j = 0; j < n; j++) {
            var dt = evalTimes[j] - tStart;
            if (dt <= 0) continue;
            tdActive.push(ndt(dt, params));
            tdActiveIdx.push(j);
        }
        if (!tdActive.length) continue;

        // Evaluate the unit-rate model on this batch.
        var pUnit;
        try {
            pUnit = modelFn(tdActive, params);
        } catch (err) {
            // If the batch call fails, fall back to scalar calls so a single
            // bad td doesn't kill the entire response.
            pUnit = new Array(tdActive.length);
            for (var s = 0; s < tdActive.length; s++) {
                try { pUnit[s] = modelFn([tdActive[s]], params)[0]; }
                catch (e2) { pUnit[s] = 0; }
            }
        }

        // Accumulate.
        for (var c = 0; c < tdActiveIdx.length; c++) {
            out[tdActiveIdx[c]] += dq[i2] * pUnit[c];
        }
    }

    return out;
}


// =============================================================================
// SECTION 6 — SANDFACE-RATE CONVOLUTION (Agarwal equivalent time)
// =============================================================================
// When a build-up follows a multi-rate drawdown, plotting Δp vs Δt on a
// diagnostic plot smears late-time radial flow because the early-rate history
// is being ignored. Agarwal (1980) defined an equivalent time
//
//   tEq = (Σ Δq_i · ln(t − t_i)) / Δq_total      [for buildup]
//
// that, when used in place of Δt, makes the build-up data fall on the same
// radial-flow line as a constant-rate drawdown. We extend the construction
// to general multi-rate sequences by anchoring on the rate-step index
// `refRateIdx` (default = last step).
//
// Returned vectors are length-equal to the input data, with NaN values for
// any data point that falls before the reference rate's start time.
// =============================================================================


/**
 * Equivalent-time + effective-Δp pair for plotting multi-rate data on a
 * single-rate diagnostic axis.
 *
 * @param {object} data        { t, p, q }
 * @param {number=} refRateIdx index of the rate to normalise against. Default:
 *                              the last contiguous rate plateau.
 * @return {object} { teq: number[], dp_eff: number[] }
 */
function PRiSM_sandface_convolution(data, refRateIdx) {
    if (!data || !Array.isArray(data.t) || !Array.isArray(data.p) || !Array.isArray(data.q)) {
        throw new Error('PRiSM_sandface_convolution: data must have t[], p[], q[] arrays');
    }
    if (data.t.length !== data.p.length || data.t.length !== data.q.length) {
        throw new Error('PRiSM_sandface_convolution: t, p, q must be the same length');
    }

    // Compress the rate trace into rate steps:
    //   [{ t_start, q_step }, ...]
    var rh = [];
    var qPrev = null;
    for (var i = 0; i < data.t.length; i++) {
        if (qPrev === null || data.q[i] !== qPrev) {
            rh.push({ t_start: data.t[i], q: data.q[i] });
            qPrev = data.q[i];
        }
    }
    if (!rh.length) {
        return { teq: data.t.slice(), dp_eff: data.p.map(function (p) { return p - data.p[0]; }) };
    }

    // Reference step: explicit index, or last step if not supplied.
    if (refRateIdx == null) refRateIdx = rh.length - 1;
    if (refRateIdx < 0) refRateIdx = 0;
    if (refRateIdx >= rh.length) refRateIdx = rh.length - 1;
    var refStep = rh[refRateIdx];

    // For Agarwal-style buildup, the reference is a shut-in (q_ref = 0). The
    // formula generalises to any reference rate by using the rate change at
    // the reference step as the denominator.
    var qRefBefore = (refRateIdx === 0) ? 0 : rh[refRateIdx - 1].q;
    var dqRef = refStep.q - qRefBefore;
    if (Math.abs(dqRef) < 1e-20) {
        // No rate change at the reference step — superposition collapses to
        // identity. Return Δt and p − p_ref instead.
        var pAtRef = _interpAt(data.t, data.p, refStep.t_start);
        var teqArr = new Array(data.t.length);
        var dpArr = new Array(data.t.length);
        for (var ix = 0; ix < data.t.length; ix++) {
            teqArr[ix] = (data.t[ix] >= refStep.t_start) ? (data.t[ix] - refStep.t_start) : NaN;
            dpArr[ix]  = (data.t[ix] >= refStep.t_start) ? (pAtRef - data.p[ix]) : NaN;
        }
        return { teq: teqArr, dp_eff: dpArr };
    }

    // Pre-compute Δq_i for every step.
    var dq = new Array(rh.length);
    for (var i2 = 0; i2 < rh.length; i2++) {
        var qBefore = (i2 === 0) ? 0 : rh[i2 - 1].q;
        dq[i2] = rh[i2].q - qBefore;
    }

    // p_ref: pressure at the start of the reference step. Used as the baseline
    // for the effective Δp.
    var pRef = _interpAt(data.t, data.p, refStep.t_start);

    // Generalised equivalent-time:
    //
    //   tEq(t) = exp( (Σ_{i ≤ k} Δq_i · ln(t − t_i)) / dqRef )
    //
    // where k = refRateIdx and (t − t_i) > 0 for the active terms.
    var n = data.t.length;
    var teq = new Array(n);
    var dpEff = new Array(n);

    for (var jj = 0; jj < n; jj++) {
        var tj = data.t[jj];
        if (tj < refStep.t_start) {
            teq[jj] = NaN;
            dpEff[jj] = NaN;
            continue;
        }
        var lnSum = 0;
        var anyTerm = false;
        for (var ii = 0; ii <= refRateIdx; ii++) {
            var dt = tj - rh[ii].t_start;
            if (dt <= 0) continue;
            lnSum += dq[ii] * Math.log(dt);
            anyTerm = true;
        }
        if (!anyTerm) {
            teq[jj] = NaN;
            dpEff[jj] = NaN;
            continue;
        }
        teq[jj] = Math.exp(lnSum / dqRef);

        // Effective Δp normalised to the reference rate change so the data
        // sits on the unit-rate diagnostic curve.
        // Sign convention: positive Δp = pressure dropped from p_ref.
        dpEff[jj] = (pRef - data.p[jj]) * (Math.abs(dqRef) > 0 ? 1.0 / Math.abs(dqRef) * Math.abs(dqRef) : 1);
        // (Multiplier collapses to 1; this keeps the formula symbolically
        // explicit so it's clear that the rate normalisation lives here. If a
        // user wants a different normalisation they can post-multiply.)
    }
    return { teq: teq, dp_eff: dpEff };
}


// Linear-interpolated value of y at x_target inside (x, y). Edges clamp to
// the nearest endpoint. Used to read pressure at a rate-step boundary.
function _interpAt(x, y, xt) {
    var n = x.length;
    if (xt <= x[0]) return y[0];
    if (xt >= x[n - 1]) return y[n - 1];
    // Binary search for the bracketing index.
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (x[mid] > xt) hi = mid; else lo = mid;
    }
    var t = (xt - x[lo]) / (x[hi] - x[lo]);
    return y[lo] + t * (y[hi] - y[lo]);
}


// =============================================================================
// SECTION 7 — PUBLIC GLUE API
// =============================================================================
// PRiSM_runRegression — bridges PRiSM_state (set by Agent A's UI) to the
// numerical engines. The UI passes in an opts override that can include
// any of the LM_DEFAULTS knobs. This function:
//   1. Pulls the active model from PRiSM_state.model (e.g. "homogeneous").
//   2. Looks it up in PRiSM_MODELS to get the pd evaluator + paramSpec.
//   3. Builds the bounds object from paramSpec.
//   4. Invokes PRiSM_lm and writes the result back to PRiSM_state.match.
// =============================================================================


/**
 * High-level glue: read the active model + dataset from window.PRiSM_state,
 * run LM, write the result back, and return it.
 *
 * @param {object=} opts LM options + optional overrides:
 *                        { modelKey, params, paramFreeze, bounds, dataset,
 *                          weightingMode, maxIter, tolerance, ... }
 */
function PRiSM_runRegression(opts) {
    opts = opts || {};
    var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    var state = g.PRiSM_state || {};

    // Resolve model.
    var modelKey = opts.modelKey || state.model;
    if (!modelKey) throw new Error('PRiSM_runRegression: no model selected (set PRiSM_state.model or pass opts.modelKey)');
    var registry = g.PRiSM_MODELS;
    if (!registry || !registry[modelKey]) {
        throw new Error('PRiSM_runRegression: unknown model "' + modelKey + '"');
    }
    var modelEntry = registry[modelKey];
    var modelFn = modelEntry.pd;
    if (typeof modelFn !== 'function') {
        throw new Error('PRiSM_runRegression: model "' + modelKey + '" has no pd evaluator');
    }

    // Resolve dataset.
    var dataset = opts.dataset || g.PRiSM_dataset;
    if (!dataset || !Array.isArray(dataset.t) || !Array.isArray(dataset.p)) {
        throw new Error('PRiSM_runRegression: no dataset available (set window.PRiSM_dataset)');
    }

    // Resolve initial params + freeze.
    var initParams = opts.params || state.params || modelEntry.defaults || {};
    var freeze = opts.paramFreeze || state.paramFreeze || {};

    // Auto-freeze any string/categorical params (e.g. BC: 'noflow') so the
    // Jacobian doesn't try to perturb them.
    var freezeMerged = {};
    for (var fk in freeze) if (freeze.hasOwnProperty(fk)) freezeMerged[fk] = freeze[fk];
    for (var pk in initParams) {
        if (initParams.hasOwnProperty(pk) && typeof initParams[pk] !== 'number') {
            freezeMerged[pk] = true;
        }
    }

    // Build the bounds object from paramSpec unless the caller passed an
    // explicit override. paramSpec uses { min, max } per entry.
    var bounds = opts.bounds;
    if (!bounds && Array.isArray(modelEntry.paramSpec)) {
        bounds = {};
        for (var ps = 0; ps < modelEntry.paramSpec.length; ps++) {
            var sp = modelEntry.paramSpec[ps];
            if (sp.min != null && sp.max != null) {
                bounds[sp.key] = [sp.min, sp.max];
            }
        }
    }

    // Strip any opts keys that aren't LM options before forwarding.
    var lmOpts = {};
    var lmKeys = ['maxIter','tolerance','lambda0','lambdaUp','lambdaDown',
                   'lambdaMax','lambdaMin','derivStep','weightingMode',
                   'logResiduals','onIter','marquardtScale'];
    for (var lk = 0; lk < lmKeys.length; lk++) {
        if (opts[lmKeys[lk]] !== undefined) lmOpts[lmKeys[lk]] = opts[lmKeys[lk]];
    }

    var data = { t: dataset.t, p: dataset.p, weights: opts.weights };
    var result = PRiSM_lm(modelFn, data, initParams, bounds, freezeMerged, lmOpts);

    // Persist result back onto state for the Tab 6 UI.
    if (g.PRiSM_state) {
        g.PRiSM_state.match = result;
        // Also adopt the fitted params as the new "current" set so subsequent
        // forward simulations on Tab 5 use them.
        g.PRiSM_state.params = result.params;
    }
    return result;
}


// =============================================================================
// SECTION 8 — EXPOSE TO GLOBAL
// =============================================================================
// Done before the self-test so the test can use the public names.
// =============================================================================


(function _expose() {
    var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    g.PRiSM_lm                    = PRiSM_lm;
    g.PRiSM_bootstrap             = PRiSM_bootstrap;
    g.PRiSM_superposition         = PRiSM_superposition;
    g.PRiSM_sandface_convolution  = PRiSM_sandface_convolution;
    g.PRiSM_runRegression         = PRiSM_runRegression;
    g.PRiSM_invertMatrix          = PRiSM_invertMatrix;
    g.PRiSM_solveLinear           = PRiSM_solveLinear;
    g.PRiSM_jacobianForward       = PRiSM_jacobianForward;
})();


// =============================================================================
// === SELF-TEST ===
// =============================================================================
// Runs at load time. Stubs the foundation primitives + the homogeneous model
// if they aren't already present, so this file can be executed in isolation
// (e.g. from Node) without the rest of the build.
// =============================================================================


(function _selfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
    var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // ---- Mocks if foundation absent --------------------------------------
    var hasFoundation = (typeof g.PRiSM_stehfest === 'function');
    var hasModel = (g.PRiSM_MODELS && g.PRiSM_MODELS.homogeneous && typeof g.PRiSM_MODELS.homogeneous.pd === 'function');

    var modelHomogeneous;

    if (hasModel) {
        modelHomogeneous = g.PRiSM_MODELS.homogeneous.pd;
    } else if (hasFoundation && typeof g.PRiSM_model_homogeneous === 'function') {
        modelHomogeneous = g.PRiSM_model_homogeneous;
    } else {
        // Cheap stand-in: pwd ≈ 0.5·(ln(td) + 0.80907 + 2S) for radial flow,
        // with a soft WBS smear for small td. Dimensionally similar to the
        // real evaluator but ~100× faster, perfect for the self-test.
        modelHomogeneous = function (td, params) {
            var Cd = (params && params.Cd) || 100;
            var S  = (params && params.S)  || 0;
            var arr = Array.isArray(td) ? td : [td];
            var out = new Array(arr.length);
            for (var i = 0; i < arr.length; i++) {
                var t = arr[i];
                if (t <= 0) { out[i] = 0; continue; }
                // Asymptotic radial flow + WBS hump approximation.
                var radial = 0.5 * (Math.log(t) + 0.80907) + S;
                var wbsT  = t / Cd;
                var wbs    = wbsT / (1 + wbsT); // sigmoid 0..1
                var wbsP   = wbsT;              // unit-slope early WBS
                out[i] = wbs * radial + (1 - wbs) * wbsP;
            }
            return Array.isArray(td) ? out : out[0];
        };
    }

    var results = [];

    // ---- Test 1: matrix invert round-trip --------------------------------
    try {
        var A = [[4, 7, 2], [3, 6, 1], [2, 5, 9]];
        var Ainv = PRiSM_invertMatrix(A);
        var I = _zeros2D(3, 3);
        for (var i = 0; i < 3; i++) {
            for (var j = 0; j < 3; j++) {
                var s = 0;
                for (var k = 0; k < 3; k++) s += A[i][k] * Ainv[k][j];
                I[i][j] = s;
            }
        }
        var maxOff = 0, maxDiag = 0;
        for (var i2 = 0; i2 < 3; i2++) {
            for (var j2 = 0; j2 < 3; j2++) {
                if (i2 === j2) maxDiag = Math.max(maxDiag, Math.abs(I[i2][j2] - 1));
                else maxOff = Math.max(maxOff, Math.abs(I[i2][j2]));
            }
        }
        results.push({ name: 'invertMatrix round-trip', ok: maxOff < 1e-9 && maxDiag < 1e-9, val: { maxOff: maxOff, maxDiag: maxDiag } });
    } catch (e) {
        results.push({ name: 'invertMatrix round-trip', ok: false, val: e.message });
    }

    // ---- Test 2: solveLinear vs invert -----------------------------------
    try {
        var Asl = [[2, 1], [5, 7]];
        var bsl = [11, 13];
        var x = PRiSM_solveLinear(Asl, bsl); // expect roughly [7.111, -3.222]
        var ok2 = Math.abs(2 * x[0] + x[1] - 11) < 1e-9 && Math.abs(5 * x[0] + 7 * x[1] - 13) < 1e-9;
        results.push({ name: 'solveLinear 2x2', ok: ok2, val: x });
    } catch (e) {
        results.push({ name: 'solveLinear 2x2', ok: false, val: e.message });
    }

    // ---- Test 3: LM on synthetic homogeneous data ------------------------
    try {
        var trueParams = { Cd: 100, S: 2 };
        var tdGrid = [];
        for (var lt = -2; lt <= 4; lt += 0.25) tdGrid.push(Math.pow(10, lt));
        var pClean = modelHomogeneous(tdGrid, trueParams);

        // Add 1% noise (deterministic-seeded so the test is reproducible).
        var rng = _makeRng(42);
        var pNoisy = pClean.map(function (v) {
            return v * (1 + 0.01 * (2 * rng() - 1));
        });

        var bounds = { Cd: [0.1, 1e6], S: [-7, 50] };
        var t0 = Date.now();
        var fit = PRiSM_lm(modelHomogeneous,
                            { t: tdGrid, p: pNoisy },
                            { Cd: 10, S: 0 },             // bad initial guess
                            bounds,
                            null,
                            { maxIter: 60, tolerance: 1e-7, weightingMode: 'uniform' });
        var dt = Date.now() - t0;

        var errCd = Math.abs(fit.params.Cd - trueParams.Cd) / trueParams.Cd;
        var errS  = Math.abs(fit.params.S  - trueParams.S)  / Math.max(Math.abs(trueParams.S), 0.5);
        var pass3 = (errCd < 0.05) && (errS < 0.05) && fit.r2 > 0.99;
        results.push({
            name:  'LM recovers Cd=100, S=2 within 5% from bad initial guess',
            ok:    pass3,
            val:   {
                Cd: fit.params.Cd, S: fit.params.S,
                errCd_pct: (errCd * 100).toFixed(2),
                errS_pct:  (errS  * 100).toFixed(2),
                ssr:       fit.ssr,
                rmse:      fit.rmse,
                r2:        fit.r2,
                aic:       fit.aic,
                iters:     fit.iterations,
                converged: fit.converged,
                stderr:    fit.stderr,
                ci95:      fit.ci95,
                ms:        dt
            }
        });
    } catch (e) {
        results.push({ name: 'LM recovers Cd=100, S=2', ok: false, val: e.message + '\n' + (e.stack || '') });
    }

    // ---- Test 4: superposition drawdown + buildup ------------------------
    try {
        var rateHist = [{ t_start: 0, q: 1 }, { t_start: 10, q: 0 }];
        var evalT = [];
        for (var k = 0; k < 60; k++) evalT.push(0.1 + k * 1.5);
        var pSup = PRiSM_superposition(modelHomogeneous, rateHist, evalT, { Cd: 100, S: 0 });

        // Find peak pressure (should be near t = 10, just before shut-in) and
        // confirm that pressure recovers (decreases) after shut-in.
        var peakIdx = 0, peakVal = -Infinity;
        for (var k2 = 0; k2 < pSup.length; k2++) {
            if (evalT[k2] <= 10 && pSup[k2] > peakVal) { peakVal = pSup[k2]; peakIdx = k2; }
        }
        var lastVal = pSup[pSup.length - 1];
        var risesDuringDrawdown = pSup[1] > pSup[0];
        var fallsDuringBuildup  = lastVal < peakVal;
        var pass4 = risesDuringDrawdown && fallsDuringBuildup && isFinite(lastVal);
        results.push({
            name: 'superposition rises during drawdown, recovers during shut-in',
            ok:   pass4,
            val:  { early: pSup[0], peak: peakVal, late: lastVal, peakIdx: peakIdx }
        });
    } catch (e) {
        results.push({ name: 'superposition drawdown+buildup', ok: false, val: e.message });
    }

    // ---- Test 5: sandface convolution sanity ------------------------------
    try {
        var dat = {
            t: [0.1, 0.5, 1, 2, 5, 8, 9.5, 10, 11, 13, 15, 20],
            p: [10,  20,  30, 38, 50, 55, 58,  58, 53, 47, 43, 38],
            q: [ 1,   1,   1,  1,  1,  1,  1,   0,  0,  0,  0,  0]
        };
        var conv = PRiSM_sandface_convolution(dat);
        // Expect equivalent times only defined for t ≥ 10 (shut-in start),
        // and dp_eff = pRef - p > 0 once pressure recovers below pRef.
        var nValid = 0;
        for (var v = 0; v < conv.teq.length; v++) {
            if (isFinite(conv.teq[v])) nValid++;
        }
        var pass5 = (nValid >= 4) && isFinite(conv.dp_eff[conv.dp_eff.length - 1]);
        results.push({ name: 'sandface convolution produces valid teq/dp', ok: pass5, val: { nValid: nValid, lastTeq: conv.teq[conv.teq.length - 1], lastDp: conv.dp_eff[conv.dp_eff.length - 1] } });
    } catch (e) {
        results.push({ name: 'sandface convolution', ok: false, val: e.message });
    }

    // ---- Tally + emit -----------------------------------------------------
    var fails = results.filter(function (r) { return !r.ok; });
    if (fails.length) {
        err('✗ regression self-test FAILED (' + fails.length + ' of ' + results.length + ')', fails);
        try { log('full results:', results); } catch (_) {}
    } else {
        log('✓ regression self-test passed (' + results.length + ' checks).', results);
    }
})();


})();
