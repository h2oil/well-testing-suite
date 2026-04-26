// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 20 — Synthetic PLT + Inverse Simulation
//   Synthetic PLT: per-layer rate contribution from a multi-layer fit
//   Inverse Sim: reconstruct rate history q(t) from pressure p(t)
//                given a forward-simulation model
// ════════════════════════════════════════════════════════════════════
//
// PUBLIC API (all on window.*)
//   window.PRiSM_syntheticPLT(modelKey, params, t, q_total)
//                                         → { layers, totalRate, cumulative,
//                                             diagnostics }
//   window.PRiSM_renderPLTPanel(container) → void
//   window.PRiSM_inverseSim(modelKey, params, t, p)
//                                         → { q, converged, iterations,
//                                             rmse, diagnostics }
//   window.PRiSM_renderInverseSimPanel(container) → void
//   window.PRiSM_unitRateResponse(modelKey, params, tEval) → number[]
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • No external dependencies — pure vanilla JS, Math.*.
//   • Defensive: degenerate inputs return a clearly-flagged result instead
//     of throwing. Inverse sim returns {converged:false, ...} on failure
//     rather than throwing.
//   • PVT-aware: if window.PRiSM_pvt._computed is filled, the unit-rate
//     response is dimensionalised to real pressure (psi per STB/d) so the
//     recovered q from inverse sim is in real units (STB/d or MSCF/d).
//     Otherwise the result is in dimensionless td/pd.
//
// FOUNDATION PRIMITIVES IN SCOPE
//   PRiSM_MODELS[modelKey].pd(td, params)            forward pressure
//   PRiSM_logspace(min, max, n)                      log spaced grid
//   PRiSM_compute_bourdet(t, dp, L)                  Bourdet derivative
//   PRiSM_lm(modelFn, data, p0, bounds, freeze, opts)  LM solver
//   PRiSM_state.lastFit / .model / .params           live UI state
//   PRiSM_pvt._computed                              PVT block (Layer 16)
//   PRiSM_dataset                                    active dataset {t,p,q}
//
// REFERENCES
//   • Lefkovits, Hazebroek, Allen, Matthews — "A Study of the Behavior of
//     Bounded Reservoirs Composed of Stratified Layers", SPEJ March 1961
//     (per-layer rate fraction = kh_i / Σkh in commingled / no-XF case).
//   • Kuchuk, F.J. — "Pressure-Transient Behavior of Multilayered Composite
//     Reservoirs", SPE 18125 (1991).
//   • von Schroeter, Hollaender, Gringarten — "Deconvolution of Well Test
//     Data as a Nonlinear Total Least Squares Problem", SPE 71574 (2001)
//     (the deconvolution / inverse-rate framework).
//   • Levitan, M.M. — "Practical Application of Pressure/Rate Deconvolution
//     to Analysis of Real Well Tests", SPE 84290 (2003).
//   • Earlougher, R.C. — "Advances in Well Test Analysis", SPE Mono 5
//     (1977) — dimensional conversions: Δp = 141.2·q·μ·B/(k·h)·pd.
//
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// ───────────────────────────────────────────────────────────────
// Tiny env shims so the module can load in node smoke-tests.
// ───────────────────────────────────────────────────────────────
var _hasDoc = (typeof document !== 'undefined');
var _hasWin = (typeof window !== 'undefined');
var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

// ───────────────────────────────────────────────────────────────
// Tiny formatting helpers (mirror the look used in 14/15-tabs).
// ───────────────────────────────────────────────────────────────
function _isNum(v) { return (typeof v === 'number') && isFinite(v); }
function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function _fmt(v, dp) {
    if (!_isNum(v)) return '—';
    var d = (dp == null) ? 4 : dp;
    return Number(v).toFixed(d);
}
function _fmtSig(v, sig) {
    if (!_isNum(v)) return '—';
    if (v === 0) return '0';
    sig = sig || 4;
    var a = Math.abs(v);
    if (a >= 1e6 || a < 1e-3) return Number(v).toExponential(sig - 1);
    return Number(v).toPrecision(sig).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// Theme palette — matches PRiSM_THEME if available.
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

// Per-layer colours for the stacked-area chart (cycle if N > LEN).
var _LAYER_COLORS = ['#58a6ff', '#3fb950', '#f0883e', '#bc8cff', '#39c5cf',
                     '#f85149', '#d29922', '#ff7b72', '#a5d6ff', '#7ee787'];

// Locate Bourdet helper (foundation or fallback).
function _bourdet(t, dp, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        return G.PRiSM_compute_bourdet(t, dp, L);
    }
    // Fallback inline (mirrors layer-2 implementation).
    L = L || 0;
    var n = t.length;
    var d = new Array(n);
    for (var k = 0; k < n; k++) d[k] = NaN;
    if (n < 3) return d;
    for (var i = 1; i < n - 1; i++) {
        if (!_isNum(t[i]) || t[i] <= 0 || !_isNum(dp[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
        }
        var t1 = t[i1], t2 = t[i2], ti = t[i];
        if (!_isNum(t1) || !_isNum(t2) || t1 <= 0 || t2 <= 0) continue;
        var dl1 = Math.log(ti) - Math.log(t1);
        var dl2 = Math.log(t2) - Math.log(ti);
        var dlT = Math.log(t2) - Math.log(t1);
        if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
        var a = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT);
        var b = (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
        d[i] = a + b;
    }
    return d;
}

// Resolve the registry entry, returning null on miss.
function _model(modelKey) {
    var reg = G.PRiSM_MODELS;
    if (!reg) return null;
    return reg[modelKey] || null;
}

// Get current PVT computed state (or null).
function _pvtComputed() {
    var pvt = G.PRiSM_pvt;
    if (!pvt || !pvt._computed) return null;
    var c = pvt._computed;
    if (!_isNum(c.ct) || !_isNum(c.mu) || !_isNum(c.B)) return null;
    if (!_isNum(pvt.h) || !_isNum(pvt.rw) || pvt.h <= 0 || pvt.rw <= 0) return null;
    return {
        h:   pvt.h, rw: pvt.rw, phi: pvt.phi,
        ct:  c.ct, mu: c.mu,   B:   c.B,
        q:   pvt.q,
        fluidType: pvt.fluidType
    };
}

// Solve a small dense linear system A·x = b in-place via Gaussian
// elimination with partial pivoting. A is N×N (array of arrays). Returns
// the solution vector or throws if the system is singular.
function _solveLinear(A, b) {
    var n = b.length;
    // Make copies so we don't trash the caller's matrix.
    var M = new Array(n);
    var rhs = new Array(n);
    for (var i = 0; i < n; i++) {
        M[i] = A[i].slice();
        rhs[i] = b[i];
    }
    for (var k = 0; k < n; k++) {
        // Pivot.
        var piv = k, vmax = Math.abs(M[k][k]);
        for (var r = k + 1; r < n; r++) {
            if (Math.abs(M[r][k]) > vmax) { vmax = Math.abs(M[r][k]); piv = r; }
        }
        if (vmax < 1e-30) throw new Error('PRiSM_solveLinear: singular');
        if (piv !== k) {
            var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp;
            var tmpb = rhs[k]; rhs[k] = rhs[piv]; rhs[piv] = tmpb;
        }
        // Eliminate.
        for (var rr = k + 1; rr < n; rr++) {
            var factor = M[rr][k] / M[k][k];
            for (var c = k; c < n; c++) M[rr][c] -= factor * M[k][c];
            rhs[rr] -= factor * rhs[k];
        }
    }
    // Back-substitute.
    var x = new Array(n);
    for (var i2 = n - 1; i2 >= 0; i2--) {
        var s = rhs[i2];
        for (var j = i2 + 1; j < n; j++) s -= M[i2][j] * x[j];
        x[i2] = s / M[i2][i2];
    }
    return x;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 1 — Per-layer admittance helpers
//   No-XF (commingled): rate fraction = kh_i / Σkh, time-invariant.
//   XF (cross-flow):    fractions evolve in time as cross-flow develops.
//                       We use the PSS factor f(s) and a per-layer
//                       admittance proxy that converges to the no-XF
//                       fractions at very late time.
// ════════════════════════════════════════════════════════════════════

// Build the canonical "layer table" from a multiLayerNoXF param block:
//   { N, perms[], khFracs[] }
// Each layer is described by its (kh-fraction, perm-ratio). The kh value
// returned is in arbitrary kh units = (PVT.h × kh-fraction × perm-ratio)
// when PVT is available, else just kh-fraction × perm-ratio (relative).
function _layersFromNoXF(params) {
    var N = (params && params.N) ? Math.max(2, Math.min(5, params.N | 0)) : 3;
    var khFracs = (params && Array.isArray(params.khFracs) && params.khFracs.length === N)
        ? params.khFracs.slice() : null;
    var perms = (params && Array.isArray(params.perms) && params.perms.length === N)
        ? params.perms.slice() : null;
    if (!khFracs) {
        khFracs = []; for (var i = 0; i < N; i++) khFracs.push(1 / N);
    }
    if (!perms) {
        perms = []; for (var j = 0; j < N; j++) perms.push(1);
    }
    // Normalise khFracs.
    var sum = 0;
    for (var k = 0; k < N; k++) {
        if (!_isNum(khFracs[k]) || khFracs[k] <= 0) khFracs[k] = 1 / N;
        sum += khFracs[k];
    }
    if (sum <= 0) sum = 1;
    for (var m = 0; m < N; m++) khFracs[m] = khFracs[m] / sum;
    // kh per layer = perm × thickness × kh-fraction (proxy units).
    var pvt = _pvtComputed();
    var hTot = pvt ? pvt.h : 1.0;
    var khArr = new Array(N);
    for (var n2 = 0; n2 < N; n2++) {
        // Use perm ratio × kh-fraction × total-h as a relative kh number.
        khArr[n2] = perms[n2] * khFracs[n2] * hTot;
    }
    return {
        N: N,
        khFracs: khFracs,
        perms: perms,
        kh: khArr
    };
}

// Build the canonical "layer table" from a multiLayerXF param block:
//   { N, omegas[], kappas[], lambda }
// We approximate per-layer kh weight using kappas[i] × omegas[i]; kappas
// is the per-layer perm ratio and omegas is the per-layer storativity
// fraction (sum to 1). At late time the admittance converges to a
// kh-weighted contribution exactly like the no-XF case.
function _layersFromXF(params) {
    var N = (params && params.N) ? Math.max(2, Math.min(5, params.N | 0)) : 3;
    var omegas = (params && Array.isArray(params.omegas) && params.omegas.length === N)
        ? params.omegas.slice() : null;
    var kappas = (params && Array.isArray(params.kappas) && params.kappas.length === N)
        ? params.kappas.slice() : null;
    if (!omegas) {
        omegas = []; for (var i = 0; i < N; i++) omegas.push(1 / N);
    }
    if (!kappas) {
        kappas = []; for (var j = 0; j < N; j++) kappas.push(1 / N);
    }
    // Normalise (defensive).
    var oSum = 0, kSum = 0;
    for (var k = 0; k < N; k++) {
        if (!_isNum(omegas[k]) || omegas[k] <= 0) omegas[k] = 1 / N;
        if (!_isNum(kappas[k]) || kappas[k] <= 0) kappas[k] = 1 / N;
        oSum += omegas[k]; kSum += kappas[k];
    }
    if (oSum <= 0) oSum = 1;
    if (kSum <= 0) kSum = 1;
    for (var m = 0; m < N; m++) {
        omegas[m] = omegas[m] / oSum;
        kappas[m] = kappas[m] / kSum;
    }
    // Late-time per-layer kh fraction = kappas[i] × omegas[i] / Σ
    // (more precisely the rigorous Park-Horne late-time fractions reduce to
    // the kh fraction = (k_i h_i) / Σ k_j h_j; we approximate kh_i ∝
    // kappas[i]·omegas[i] when storativity tracks thickness fraction).
    var khLate = new Array(N);
    var khSum = 0;
    for (var n2 = 0; n2 < N; n2++) {
        khLate[n2] = kappas[n2] * omegas[n2];
        khSum += khLate[n2];
    }
    if (khSum <= 0) khSum = 1;
    for (var p = 0; p < N; p++) khLate[p] = khLate[p] / khSum;
    var lambda = _isNum(params.lambda) ? params.lambda : 1e-5;
    return {
        N: N,
        omegas: omegas,
        kappas: kappas,
        khLate: khLate,
        lambda: lambda
    };
}

// Time-evolving per-layer rate fraction for the XF model.  Rationale:
//  (a) at very early time (td → 0) every layer behaves as an isolated
//      single-layer well, and the rate share is set by the layer's
//      storativity fraction ω_i (because dimensional storage controls the
//      depth of the early-time dimensionless pressure draw-down)
//  (b) at very late time the fractions converge to kh-weighted (κ·ω)
//  (c) the transition is driven by the cross-flow coefficient λ: the
//      higher λ, the earlier the equilibration. We use a Warren-Root-
//      style transition variable τ(t) = 1 - exp(-λ · td) bounded to (0, 1)
//      and interpolate between early and late fractions.
// This is a faithful engineering approximation that reproduces the
// well-known cross-flow transient signature (early storativity-driven →
// late kh-driven). Fully rigorous per-layer Laplace decomposition (Park-
// Horne 1989 NxN) would replace this interpolation; the chosen form
// honours the two correct asymptotes and the λ-controlled time scale.
function _xfFractionAt(td, layers) {
    var N = layers.N;
    var lambda = layers.lambda;
    var tau = 1 - Math.exp(-Math.max(0, lambda * Math.max(0, td)));
    if (!_isNum(tau)) tau = 0;
    if (tau < 0) tau = 0;
    if (tau > 1) tau = 1;
    var out = new Array(N);
    for (var i = 0; i < N; i++) {
        out[i] = (1 - tau) * layers.omegas[i] + tau * layers.khLate[i];
    }
    return out;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 2 — Synthetic PLT computation
// ════════════════════════════════════════════════════════════════════

/**
 * PRiSM_syntheticPLT(modelKey, params, t, q_total)
 *
 * Reconstruct per-layer rate contribution as a function of time.
 *
 * @param {string}   modelKey   e.g. 'multiLayerNoXF', 'multiLayerXF',
 *                              'homogeneous', 'radialComposite'.
 * @param {object}   params     fitted parameter set
 * @param {number[]} t          time array (hours, monotonically increasing)
 * @param {number[]} q_total    total wellbore rate at each t (same length)
 * @return {object}             { layers, totalRate, cumulative, diagnostics }
 */
G.PRiSM_syntheticPLT = function PRiSM_syntheticPLT(modelKey, params, t, q_total) {
    if (!Array.isArray(t) || !Array.isArray(q_total)) {
        return _degeneratePLT(modelKey, 'invalid t / q_total arrays');
    }
    if (t.length !== q_total.length) {
        return _degeneratePLT(modelKey, 't and q_total must be the same length');
    }
    if (t.length === 0) {
        return _degeneratePLT(modelKey, 'empty t array');
    }
    var spec = _model(modelKey);
    var modelType;
    var nLayers;
    var rates;     // 2D: rates[layer][i]
    var fractionsT; // 2D: fractions[layer][i]
    var labels;
    var khArr;
    var nonMulti = false;

    if (modelKey === 'multiLayerNoXF') {
        modelType = 'multiLayerNoXF';
        var lyrN = _layersFromNoXF(params || {});
        nLayers = lyrN.N;
        khArr = lyrN.kh;
        labels = _layerLabels(nLayers);
        // No-XF: rate fraction = (kh_i / Σkh), time-invariant.
        var khSumN = 0;
        for (var ki = 0; ki < nLayers; ki++) khSumN += khArr[ki];
        if (khSumN <= 0) khSumN = 1;
        var fracN = new Array(nLayers);
        for (var jj = 0; jj < nLayers; jj++) fracN[jj] = khArr[jj] / khSumN;
        // Build constant fractions × time.
        rates = []; fractionsT = [];
        for (var L = 0; L < nLayers; L++) {
            var rL = new Array(t.length);
            var fL = new Array(t.length);
            for (var ii = 0; ii < t.length; ii++) {
                fL[ii] = fracN[L];
                rL[ii] = fracN[L] * (q_total[ii] || 0);
            }
            rates.push(rL);
            fractionsT.push(fL);
        }
    } else if (modelKey === 'multiLayerXF') {
        modelType = 'multiLayerXF';
        var lyrX = _layersFromXF(params || {});
        nLayers = lyrX.N;
        labels = _layerLabels(nLayers);
        // Compute kh = κ·ω (proportional units) per layer for table display.
        khArr = new Array(nLayers);
        for (var kk = 0; kk < nLayers; kk++) {
            khArr[kk] = lyrX.kappas[kk] * lyrX.omegas[kk];
        }
        rates = []; fractionsT = [];
        for (var Lx = 0; Lx < nLayers; Lx++) {
            rates.push(new Array(t.length));
            fractionsT.push(new Array(t.length));
        }
        for (var ix = 0; ix < t.length; ix++) {
            var f = _xfFractionAt(t[ix], lyrX);
            // Renormalise (defensive — interpolation should already sum to 1).
            var fSum = 0;
            for (var fk = 0; fk < nLayers; fk++) fSum += f[fk];
            if (fSum <= 0) fSum = 1;
            for (var fl = 0; fl < nLayers; fl++) {
                fractionsT[fl][ix] = f[fl] / fSum;
                rates[fl][ix] = (f[fl] / fSum) * (q_total[ix] || 0);
            }
        }
    } else if (modelKey === 'twoLayerXF') {
        // Two-layer XF: emulate as N=2 XF with omegas={omega, 1-omega} and
        // kappas={kappa, 1} (relative). lambda from params.
        modelType = 'twoLayerXF';
        var omega = _isNum(params && params.omega) ? params.omega : 0.5;
        var kappaR = _isNum(params && params.kappa) ? params.kappa : 1;
        var lam2 = _isNum(params && params.lambda) ? params.lambda : 1e-5;
        var lyr2 = {
            N: 2,
            omegas: [omega, 1 - omega],
            kappas: [kappaR / (kappaR + 1), 1 / (kappaR + 1)],
            khLate: null,
            lambda: lam2
        };
        // khLate from kappa·omega — need to renormalise.
        var khL = [lyr2.kappas[0] * lyr2.omegas[0], lyr2.kappas[1] * lyr2.omegas[1]];
        var khLs = khL[0] + khL[1];
        if (khLs <= 0) khLs = 1;
        lyr2.khLate = [khL[0] / khLs, khL[1] / khLs];
        nLayers = 2;
        labels = _layerLabels(2);
        khArr = khL;
        rates = []; fractionsT = [];
        for (var L2 = 0; L2 < 2; L2++) {
            rates.push(new Array(t.length));
            fractionsT.push(new Array(t.length));
        }
        for (var i2 = 0; i2 < t.length; i2++) {
            var f2 = _xfFractionAt(t[i2], lyr2);
            var f2S = f2[0] + f2[1];
            if (f2S <= 0) f2S = 1;
            for (var lk = 0; lk < 2; lk++) {
                fractionsT[lk][i2] = f2[lk] / f2S;
                rates[lk][i2] = (f2[lk] / f2S) * (q_total[i2] || 0);
            }
        }
    } else {
        // Single-layer / composite / fracture / etc. — degenerate.
        nonMulti = true;
        modelType = modelKey || 'unknown';
        nLayers = 1;
        labels = ['Single layer (degenerate)'];
        khArr = [1];
        rates = [new Array(t.length)];
        fractionsT = [new Array(t.length)];
        for (var iz = 0; iz < t.length; iz++) {
            fractionsT[0][iz] = 1;
            rates[0][iz] = q_total[iz] || 0;
        }
    }

    // Total rate (sum over layers) and per-layer cumulative.
    var totalRate = new Array(t.length);
    var rateCheck = 0;
    for (var ti = 0; ti < t.length; ti++) {
        var s = 0;
        for (var lr = 0; lr < nLayers; lr++) s += rates[lr][ti];
        totalRate[ti] = s;
        var diff = Math.abs(s - (q_total[ti] || 0));
        if (diff > rateCheck) rateCheck = diff;
    }
    // Per-layer cumulative production (trapezoid integration of rate × dt).
    var cumulative = new Array(nLayers);
    for (var lc = 0; lc < nLayers; lc++) cumulative[lc] = 0;
    if (t.length >= 2) {
        for (var ic = 1; ic < t.length; ic++) {
            var dt = (t[ic] - t[ic - 1]);
            if (!_isNum(dt) || dt <= 0) continue;
            for (var lk2 = 0; lk2 < nLayers; lk2++) {
                cumulative[lk2] += 0.5 * dt * (rates[lk2][ic] + rates[lk2][ic - 1]);
            }
        }
    }

    // Build the layer descriptors. For the table view we want INITIAL and
    // FINAL fractions explicitly, plus EUR (cumulative production over
    // the supplied time span).
    var totalKh = 0;
    for (var tk = 0; tk < nLayers; tk++) totalKh += khArr[tk];
    var layerObjs = [];
    for (var iL = 0; iL < nLayers; iL++) {
        // Mean rate fraction over the dataset (used as the headline number).
        var meanFrac = 0;
        for (var fi = 0; fi < t.length; fi++) meanFrac += fractionsT[iL][fi];
        meanFrac = (t.length > 0) ? meanFrac / t.length : 0;
        var initFrac = (t.length > 0) ? fractionsT[iL][0] : 0;
        var finalFrac = (t.length > 0) ? fractionsT[iL][t.length - 1] : 0;
        layerObjs.push({
            id:           iL,
            label:        labels[iL],
            kh:           khArr[iL],
            rateFraction: meanFrac,
            initialFraction: initFrac,
            finalFraction:   finalFrac,
            rate:         rates[iL],
            cumulative:   cumulative[iL]
        });
    }

    var notes;
    if (nonMulti) {
        notes = 'Synthetic PLT degenerate for non-multi-layer model "'
              + modelType + '" — reported as a single-layer well with '
              + 'rateFraction = 1.0. Fit a multi-layer model first to '
              + 'recover per-layer rate contributions.';
    } else if (modelType === 'multiLayerXF' || modelType === 'twoLayerXF') {
        notes = 'Cross-flow rate fractions evolve in time. Early-time '
              + 'fractions ≈ storativity ω_i; late-time fractions ≈ '
              + 'kh fractions (κ_i·ω_i). Transition controlled by λ.';
    } else {
        notes = 'Commingled (no-XF) rate fractions are time-invariant '
              + '= (kh_i / Σkh).';
    }

    return {
        layers:     layerObjs,
        totalRate:  totalRate,
        cumulative: cumulative,
        diagnostics: {
            modelType:  modelType,
            nLayers:    nLayers,
            totalKh:    totalKh,
            rateCheck:  rateCheck,
            notes:      notes
        }
    };
};

function _layerLabels(N) {
    if (N === 1) return ['Layer 1'];
    if (N === 2) return ['Layer 1 (top)', 'Layer 2 (base)'];
    var out = [];
    for (var i = 0; i < N; i++) {
        if (i === 0) out.push('Layer ' + (i + 1) + ' (top)');
        else if (i === N - 1) out.push('Layer ' + (i + 1) + ' (base)');
        else out.push('Layer ' + (i + 1));
    }
    return out;
}

function _degeneratePLT(modelKey, reason) {
    return {
        layers: [{
            id: 0, label: 'Single layer (degenerate)',
            kh: 1, rateFraction: 1, initialFraction: 1, finalFraction: 1,
            rate: [], cumulative: 0
        }],
        totalRate: [],
        cumulative: [0],
        diagnostics: {
            modelType: modelKey || 'unknown',
            nLayers:   1,
            totalKh:   1,
            rateCheck: 0,
            notes:     'Degenerate: ' + reason
        }
    };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 3 — Convolution matrix builder + unit-rate response
// ════════════════════════════════════════════════════════════════════
//
// Forward simulation in a constant-rate test:
//   Δp(t) = q · g_unit(t)             where g_unit(t) = pwd(td(t)) × kh-conv
// Multi-rate convolution (Duhamel superposition):
//   Δp(t_n) = Σ_{i=1}^{n} (q_i - q_{i-1}) · g_unit(t_n - t_{i-1})
// In matrix form for a strictly piecewise-constant rate q with q_0 := 0:
//   p(t_n) - p_initial = Σ_{i=1}^{n} g_unit(t_n - t_{i-1}) · (q_i - q_{i-1})
// or (after re-arranging into a direct rate decomposition):
//   p(t_n) - p_initial = Σ_{i=1}^{n} A_{n,i} · q_i
//   where A_{n,i} = g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i)
//                                          (with g_unit(0) := 0 by convention)
// A is lower-triangular.

/**
 * PRiSM_unitRateResponse(modelKey, params, tEval) → number[]
 *
 * Compute the dimensional unit-rate pressure response g_unit(t) = pd(td(t))
 * scaled by the dimensional factor 141.2·μ·B/(k·h) (psi per STB/d) when
 * PVT is available, or returns the dimensionless pd(td(t)) when not.
 *
 * @param {string}   modelKey  registry key
 * @param {object}   params    parameter set
 * @param {number[]} tEval     time grid (hours)
 * @return {number[]}          unit-rate response, same length as tEval
 */
G.PRiSM_unitRateResponse = function PRiSM_unitRateResponse(modelKey, params, tEval) {
    if (!Array.isArray(tEval)) throw new Error('PRiSM_unitRateResponse: tEval must be an array');
    var spec = _model(modelKey);
    if (!spec || typeof spec.pd !== 'function') {
        throw new Error('PRiSM_unitRateResponse: unknown model "' + modelKey + '"');
    }
    var pvt = _pvtComputed();
    // Dimensionless: td = 0.000264 · k · t / (φ · μ · ct · rw²)
    // We need k to non-dimensionalise. Try param.k_md → state.lastFit → fallback.
    var k_md = null;
    if (params && _isNum(params.k_md)) k_md = params.k_md;
    var st = G.PRiSM_state;
    if (!_isNum(k_md) && st && st.lastFit && _isNum(st.lastFit.k_md)) k_md = st.lastFit.k_md;
    if (!_isNum(k_md) && st && st.lastFit && _isNum(st.lastFit.kh_md_ft) && pvt) {
        k_md = st.lastFit.kh_md_ft / pvt.h;
    }
    var dimensional = !!pvt && _isNum(k_md) && k_md > 0;
    // td factor (1/hr): td = factor · t   (when t is in hours)
    var tdFactor;
    if (dimensional) {
        tdFactor = 0.000264 * k_md / (pvt.phi * pvt.mu * pvt.ct * pvt.rw * pvt.rw);
    } else {
        // Use t directly as td (caller-supplied dimensionless time grid).
        tdFactor = 1;
    }
    // Build td array, skipping non-positive entries (we'll pad with 0).
    var td = new Array(tEval.length);
    for (var i = 0; i < tEval.length; i++) {
        var tv = tEval[i];
        if (!_isNum(tv) || tv <= 0) {
            td[i] = null;
        } else {
            td[i] = tdFactor * tv;
        }
    }
    // Evaluate pd at every td > 0 in one pass (some models accept arrays).
    var pdArr;
    var validIdx = [];
    var validTd = [];
    for (var j = 0; j < td.length; j++) {
        if (td[j] !== null) {
            validIdx.push(j);
            validTd.push(td[j]);
        }
    }
    if (validTd.length === 0) {
        return new Array(tEval.length).fill(0);
    }
    try {
        pdArr = spec.pd(validTd, params);
        if (!Array.isArray(pdArr)) {
            // If single-value returned, wrap.
            pdArr = [pdArr];
        }
    } catch (e) {
        // Fallback: evaluate point-by-point so a single bad td doesn't kill
        // the whole batch.
        pdArr = new Array(validTd.length);
        for (var p = 0; p < validTd.length; p++) {
            try { pdArr[p] = spec.pd([validTd[p]], params)[0]; }
            catch (e2) { pdArr[p] = NaN; }
        }
    }
    // Reassemble a same-length output, dimensionalising.
    var out = new Array(tEval.length);
    for (var z = 0; z < tEval.length; z++) out[z] = 0;
    var dimFactor = 1;
    if (dimensional) {
        // psi per STB/d at unit rate q=1: 141.2·μ·B / (k·h)
        dimFactor = 141.2 * pvt.mu * pvt.B / (k_md * pvt.h);
    }
    for (var v = 0; v < validIdx.length; v++) {
        var idx = validIdx[v];
        var pdv = pdArr[v];
        if (!_isNum(pdv)) pdv = 0;
        out[idx] = dimFactor * pdv;
    }
    return out;
};

// Build the lower-triangular convolution matrix A[n][i] from the unit-rate
// response g_unit:
//   A[n][i] = g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i)
//   with g_unit(0) := 0.
// Returns { A: Array<Array<number>>, gUnit: number[] } where gUnit is the
// raw unit-rate response evaluated at the difference times.
function _buildConvMatrix(modelKey, params, t) {
    var n = t.length;
    if (n === 0) return { A: [], gUnit: [] };
    // We need g_unit at all unique time-difference values (t_n - t_{i-1}).
    // For an arbitrary irregular grid, the cheapest approach is to compute
    // the full upper-triangular set of (t_n - t_i) values and evaluate
    // g_unit at the union. We just compute A directly: for each row n,
    // we evaluate g_unit at (t_n - t_0), (t_n - t_1), ..., (t_n - t_{n-1}).
    // This is O(n^2) evaluations of the model. For n up to a few hundred
    // this is fine (each pd call is a Stehfest sum of 12 terms).
    var A = new Array(n);
    for (var i = 0; i < n; i++) A[i] = new Array(n).fill(0);
    // Pre-compute g_unit at each unique difference. We collect them per row
    // and do a batched call. Simpler: evaluate row-by-row.
    for (var nRow = 0; nRow < n; nRow++) {
        // Build array of differences t_nRow - t_k for k = 0..nRow.
        var diffs = new Array(nRow + 1);
        var diffIdx = new Array(nRow + 1);  // map back to original "lag" index
        for (var k = 0; k <= nRow; k++) {
            diffs[k] = t[nRow] - t[k];
            diffIdx[k] = k;
        }
        // diffs[nRow] = 0 (last entry). We need g_unit at strictly positive
        // arguments; we set g_unit(0) := 0.
        var gAtDiff;
        try {
            gAtDiff = G.PRiSM_unitRateResponse(modelKey, params, diffs);
        } catch (e) {
            // Bubble up — the inverse-sim caller will trap and report.
            throw e;
        }
        // gAtDiff[k] = g_unit(t_n - t_k). For the matrix A[n][i] (i = 1..n)
        // we want g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i). With i ∈ [1,n]
        // running over the SAMPLES, the "sample index" in our 0-based grid
        // is i' = i - 1 ∈ [0, n-1]. We allow rate updates AT every sample,
        // so q_i defines the rate from t_{i-1} to t_i. The convolution
        // contribution of q_i to row n is:
        //   A[n][i'] = g_unit(t_n - t_{i-1}) - g_unit(t_n - t_i)
        //            = gAtDiff[i-1] - gAtDiff[i]  for i = 1..n
        // (gAtDiff[i] is only defined for i ≤ nRow; for i > nRow the rate
        // hasn't started yet — A[n][i'] = 0 by causality).
        for (var iCol = 0; iCol < n; iCol++) {
            if (iCol > nRow) {
                A[nRow][iCol] = 0;
                continue;
            }
            // i = iCol + 1, i-1 = iCol  (sample indices are 0-based)
            var lagPrev = iCol;        // i - 1
            var lagCurr = iCol + 1;    // i
            var gPrev = (lagPrev <= nRow) ? gAtDiff[lagPrev] : 0;
            var gCurr = (lagCurr <= nRow) ? gAtDiff[lagCurr] : 0;
            // gAtDiff was sized to nRow+1, so lagCurr can equal nRow+1 only
            // when iCol == nRow → lagCurr > nRow.length-1; in that case gCurr = 0.
            if (!_isNum(gPrev)) gPrev = 0;
            if (!_isNum(gCurr)) gCurr = 0;
            A[nRow][iCol] = gPrev - gCurr;
        }
    }
    return { A: A, gUnit: null };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — Inverse simulation
// ════════════════════════════════════════════════════════════════════
//
// Given p(t) and a model + params, recover q(t) by solving the linear
// system A · q = (p_initial - p) where A is the lower-triangular Duhamel
// convolution matrix from SECTION 3.
//
// Algorithm:
//   1. Build A and the RHS = (p[0] - p[i]).
//   2. Solve (Aᵀ A + α I) q = Aᵀ RHS  (Tikhonov-regularised normal eqn).
//      The α regularisation kills the high-frequency oscillation that a
//      naive direct solve develops at the late-time tail.
//   3. Clip negative q values to zero (NNLS-light enforcement; for a
//      production well sustained negative rate is non-physical and almost
//      always a numerical artefact of the late-time tail).
//   4. Forward-simulate p_predicted from the recovered q and report RMSE.

/**
 * PRiSM_inverseSim(modelKey, params, t, p) → result
 *
 * @param {string}   modelKey
 * @param {object}   params
 * @param {number[]} t        time array (hours)
 * @param {number[]} p        pressure array (psi or dimensionless), same length
 * @return {object}           {
 *     q: number[],         recovered rate at each t
 *     converged: boolean,
 *     iterations: number,
 *     rmse: number,
 *     diagnostics: { method, regularisation, notes }
 * }
 */
G.PRiSM_inverseSim = function PRiSM_inverseSim(modelKey, params, t, p) {
    if (!Array.isArray(t) || !Array.isArray(p)) {
        return _inverseFail('t and p must be arrays', t ? t.length : 0);
    }
    if (t.length !== p.length) {
        return _inverseFail('t and p must be the same length', t.length);
    }
    if (t.length < 3) {
        return _inverseFail('need at least 3 samples', t.length);
    }
    var spec = _model(modelKey);
    if (!spec || typeof spec.pd !== 'function') {
        return _inverseFail('unknown model "' + modelKey + '"', t.length);
    }
    // Build convolution matrix.
    var A;
    try {
        var built = _buildConvMatrix(modelKey, params, t);
        A = built.A;
    } catch (e) {
        return _inverseFail('build convolution matrix failed: ' + (e && e.message), t.length);
    }
    var n = t.length;
    // RHS = (p[0] - p[i]); for a producing well (drawdown), p decreases so
    // the RHS is non-negative.
    var rhs = new Array(n);
    for (var i = 0; i < n; i++) rhs[i] = (p[0] - p[i]);

    // Tikhonov α — choose ~1e-8 of the matrix scale. Compute the matrix
    // norm squared (Frobenius²) as a proxy.
    var fro2 = 0;
    for (var ri = 0; ri < n; ri++) {
        for (var rj = 0; rj <= ri; rj++) {
            fro2 += A[ri][rj] * A[ri][rj];
        }
    }
    var alpha = 1e-8 * Math.max(1e-30, fro2);

    // Solve normal equations (AᵀA + αI) q = Aᵀ rhs.
    // We assemble M = AᵀA + αI and v = Aᵀ rhs explicitly.
    var M = new Array(n);
    for (var mi = 0; mi < n; mi++) M[mi] = new Array(n).fill(0);
    var v = new Array(n).fill(0);
    for (var col = 0; col < n; col++) {
        for (var col2 = col; col2 < n; col2++) {
            var dot = 0;
            // A[r][col] is non-zero only for r >= col (lower-tri).
            for (var r = Math.max(col, col2); r < n; r++) {
                dot += A[r][col] * A[r][col2];
            }
            M[col][col2] = dot;
            if (col !== col2) M[col2][col] = dot;
        }
        // v[col] = Σ_r A[r][col] · rhs[r]
        var dotV = 0;
        for (var rr = col; rr < n; rr++) dotV += A[rr][col] * rhs[rr];
        v[col] = dotV;
        // Tikhonov diagonal.
        M[col][col] += alpha;
    }
    var q;
    try {
        q = _solveLinear(M, v);
    } catch (e) {
        return _inverseFail('linear solve failed: ' + (e && e.message), n);
    }
    // Non-negativity clip (NNLS-light). Most physically meaningful for
    // single-rate drawdown; for a buildup the user can disable this by
    // setting params.allowNegative = true (advanced).
    var allowNeg = !!(params && params.allowNegative);
    var clippedCount = 0;
    if (!allowNeg) {
        for (var iC = 0; iC < n; iC++) {
            if (q[iC] < 0) {
                q[iC] = 0;
                clippedCount++;
            }
        }
    }
    // Forward-simulate p_predicted = A · q + p[0] and compute RMSE.
    var pPred = new Array(n);
    for (var rR = 0; rR < n; rR++) {
        var s2 = 0;
        for (var cC = 0; cC <= rR; cC++) s2 += A[rR][cC] * q[cC];
        pPred[rR] = p[0] - s2;
    }
    var sse = 0;
    for (var iR = 0; iR < n; iR++) {
        var d = (p[iR] - pPred[iR]);
        sse += d * d;
    }
    var rmse = Math.sqrt(sse / n);
    var converged = isFinite(rmse);

    var notes = 'Tikhonov-regularised linear deconvolution (α = '
              + _fmtSig(alpha, 3) + '). ';
    if (clippedCount > 0) {
        notes += clippedCount + ' negative q value' +
                 (clippedCount === 1 ? '' : 's') + ' clipped to zero. ';
    }
    var pvt = _pvtComputed();
    if (pvt) {
        notes += 'Recovered q in real units (' +
                 (pvt.fluidType === 'gas' ? 'MSCF/d' :
                  pvt.fluidType === 'water' ? 'BWPD' : 'STB/d') + '). ';
    } else {
        notes += 'PVT not computed — recovered q in dimensionless units. ';
    }

    return {
        q:           q,
        converged:   converged,
        iterations:  1,
        rmse:        rmse,
        pPredicted:  pPred,
        diagnostics: {
            method:         'linear-deconvolution',
            regularisation: 'tikhonov',
            alpha:          alpha,
            clipped:        clippedCount,
            dimensional:    !!pvt,
            notes:          notes
        }
    };
};

function _inverseFail(reason, n) {
    return {
        q:          new Array(Math.max(1, n)).fill(0),
        converged:  false,
        iterations: 0,
        rmse:       NaN,
        pPredicted: [],
        diagnostics: {
            method:         'linear-deconvolution',
            regularisation: 'tikhonov',
            error:          reason,
            notes:          'Inverse simulation failed: ' + reason
        }
    };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 5 — UI: synthetic PLT panel
// ════════════════════════════════════════════════════════════════════
//
// Layout (top-to-bottom):
//   1. Header + status line (model + N layers detected)
//   2. Stacked-area canvas (per-layer rate vs time)
//   3. Per-layer table (label | kh | initial frac | final frac | EUR)
//   4. Action row: Compute | Export CSV
// ════════════════════════════════════════════════════════════════════

var _PLT_CANVAS_ID = 'prism_plt_canvas';
var _PLT_TABLE_ID  = 'prism_plt_table';
var _PLT_MSG_ID    = 'prism_plt_msg';
var _PLT_NOTE_ID   = 'prism_plt_note';
var _pltLastResult = null;

G.PRiSM_renderPLTPanel = function PRiSM_renderPLTPanel(container) {
    if (!_hasDoc || !container) return;
    var T = _theme();
    container.innerHTML =
          '<div class="prism-plt-card" style="background:' + T.panel + '; border:1px solid ' + T.border + '; border-radius:6px; padding:14px;">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px;">'
        +     '<div style="font-weight:600; color:' + T.text + '; font-size:14px;">Synthetic PLT — per-layer rate</div>'
        +     '<div style="display:flex; gap:8px;">'
        +       '<button id="prism_plt_compute" type="button" '
        +         'style="padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; '
        +         'border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Compute</button>'
        +       '<button id="prism_plt_export" type="button" '
        +         'style="padding:6px 14px; background:#21262d; color:' + T.text + '; border:1px solid ' + T.border + '; '
        +         'border-radius:4px; cursor:pointer; font-size:12px;">Export CSV</button>'
        +     '</div>'
        +   '</div>'
        +   '<div id="' + _PLT_MSG_ID + '" style="font-size:12px; color:' + T.text2 + '; margin-bottom:10px;">'
        +     'Click <b>Compute</b> to derive per-layer rate contributions from the active fit.'
        +   '</div>'
        +   '<canvas id="' + _PLT_CANVAS_ID + '" width="800" height="320" '
        +     'style="display:block; background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:6px; max-width:100%;"></canvas>'
        +   '<div id="' + _PLT_TABLE_ID + '" style="margin-top:12px; overflow-x:auto;">'
        +     '<div style="color:' + T.text3 + '; font-size:12px;">No layer data yet.</div>'
        +   '</div>'
        +   '<div id="' + _PLT_NOTE_ID + '" style="margin-top:8px; font-size:11px; color:' + T.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnC = document.getElementById('prism_plt_compute');
    var btnE = document.getElementById('prism_plt_export');
    if (btnC) btnC.onclick = _pltCompute;
    if (btnE) btnE.onclick = _pltExport;
};

function _pltCompute() {
    var T = _theme();
    var msg = document.getElementById(_PLT_MSG_ID);
    var st = G.PRiSM_state || {};
    var ds = G.PRiSM_dataset || null;
    var lf = st.lastFit || null;
    var modelKey = (lf && lf.modelKey) || st.model;
    var params = (lf && lf.params) || st.params || {};
    var multiKeys = { multiLayerNoXF: 1, multiLayerXF: 1, twoLayerXF: 1,
                      mlHorizontalXF: 1, mlHorizontalNoXF: 1,
                      multiLatMLXF: 1, multiLatMLNoXF: 1 };
    if (!modelKey || !multiKeys[modelKey]) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">PLT requires a multi-layer model. Active model: <b>'
            + _esc(modelKey || 'none') + '</b>. Switch to multiLayerXF / multiLayerNoXF / twoLayerXF and re-fit.</span>';
        _pltLastResult = null;
        _drawPLTChart([]);
        _renderPLTTable(null);
        return;
    }
    if (!ds || !Array.isArray(ds.t) || ds.t.length < 2) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">No active dataset — load data on the Data tab first.</span>';
        return;
    }
    // Derive q_total from dataset rate column if present, else assume the
    // user-entered PVT q is the constant well rate.
    var t = ds.t.slice();
    var qTot;
    if (Array.isArray(ds.q) && ds.q.length === t.length) {
        qTot = ds.q.slice();
    } else {
        var pvt = G.PRiSM_pvt;
        var qConst = (pvt && _isNum(pvt.q)) ? pvt.q : 1000;
        qTot = new Array(t.length);
        for (var i = 0; i < t.length; i++) qTot[i] = qConst;
    }
    var result;
    try {
        result = G.PRiSM_syntheticPLT(modelKey, params, t, qTot);
    } catch (e) {
        if (msg) msg.innerHTML = '<span style="color:' + T.red + ';">PLT computation failed: '
            + _esc(e && e.message) + '</span>';
        return;
    }
    _pltLastResult = { result: result, t: t };
    if (msg) {
        msg.innerHTML = '<span style="color:' + T.green + ';">'
            + result.diagnostics.nLayers + ' layer'
            + (result.diagnostics.nLayers === 1 ? '' : 's') + ' over '
            + t.length + ' time samples. Total kh (proxy units): '
            + _fmtSig(result.diagnostics.totalKh, 3)
            + '. Rate-balance residual: ' + _fmtSig(result.diagnostics.rateCheck, 3) + '.</span>';
    }
    _drawPLTChart(result.layers, t);
    _renderPLTTable(result);
    var noteEl = document.getElementById(_PLT_NOTE_ID);
    if (noteEl) noteEl.textContent = result.diagnostics.notes || '';
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_compute', { model: modelKey, n_layers: result.diagnostics.nLayers }); }
        catch (e) { /* swallow */ }
    }
}

// Stacked-area chart of per-layer rate contribution vs time.
function _drawPLTChart(layers, t) {
    if (!_hasDoc) return;
    var canvas = document.getElementById(_PLT_CANVAS_ID);
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Background.
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 24, right: 90, bottom: 38, left: 60 };
    if (!Array.isArray(layers) || !layers.length || !Array.isArray(t) || !t.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No PLT data yet.', w / 2, h / 2);
        return;
    }
    // Plot area.
    var plotX = pad.left;
    var plotY = pad.top;
    var plotW = w - pad.left - pad.right;
    var plotH = h - pad.top - pad.bottom;
    // X scale — log if t spans more than a decade, else linear.
    var tMin = Infinity, tMax = -Infinity;
    for (var i = 0; i < t.length; i++) {
        if (t[i] > 0) {
            if (t[i] < tMin) tMin = t[i];
            if (t[i] > tMax) tMax = t[i];
        }
    }
    if (!isFinite(tMin) || !isFinite(tMax) || tMin >= tMax) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Time grid is degenerate.', w / 2, h / 2);
        return;
    }
    var useLog = (tMax / tMin) > 50;
    function xMap(tv) {
        if (useLog) {
            return plotX + plotW * (Math.log10(Math.max(tv, tMin)) - Math.log10(tMin)) /
                                  (Math.log10(tMax) - Math.log10(tMin));
        }
        return plotX + plotW * (tv - tMin) / (tMax - tMin);
    }
    // Y scale = total rate at every sample.
    var yMax = 0;
    for (var ti = 0; ti < t.length; ti++) {
        var s = 0;
        for (var li = 0; li < layers.length; li++) {
            s += (layers[li].rate[ti] || 0);
        }
        if (s > yMax) yMax = s;
    }
    if (yMax <= 0) yMax = 1;
    function yMap(qv) {
        return plotY + plotH * (1 - qv / yMax);
    }
    // Grid + axes.
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Y-grid + labels (5 lines).
    for (var g = 0; g <= 5; g++) {
        var yp = plotY + plotH * g / 5;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        var qLabel = yMax * (1 - g / 5);
        ctx.fillText(_fmtSig(qLabel, 3), plotX - 6, yp);
    }
    // X-grid + labels.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var nXTicks = 5;
    for (var xt = 0; xt <= nXTicks; xt++) {
        var frac = xt / nXTicks;
        var tv;
        if (useLog) {
            var lo = Math.log10(tMin), hi = Math.log10(tMax);
            tv = Math.pow(10, lo + frac * (hi - lo));
        } else {
            tv = tMin + frac * (tMax - tMin);
        }
        var xp = xMap(tv);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv, 3), xp, plotY + plotH + 4);
    }
    // Axis labels.
    ctx.fillStyle = T.text;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('time (hr)', plotX + plotW / 2, h - 6);
    ctx.save();
    ctx.translate(14, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('rate', 0, 0);
    ctx.restore();
    // Plot stacked areas. Build cumulative arrays bottom-up.
    var cum = new Array(t.length).fill(0);
    for (var lk = 0; lk < layers.length; lk++) {
        var lyr = layers[lk];
        var color = _LAYER_COLORS[lk % _LAYER_COLORS.length];
        // Build polygon: (t, cum[i] + r[i]) along the top, (t, cum[i]) along
        // the bottom (in reverse).
        ctx.beginPath();
        // Top edge (left → right).
        for (var jj = 0; jj < t.length; jj++) {
            var top = cum[jj] + (lyr.rate[jj] || 0);
            var xp2 = xMap(t[jj]);
            var yp2 = yMap(top);
            if (jj === 0) ctx.moveTo(xp2, yp2);
            else ctx.lineTo(xp2, yp2);
        }
        // Bottom edge (right → left).
        for (var kk = t.length - 1; kk >= 0; kk--) {
            ctx.lineTo(xMap(t[kk]), yMap(cum[kk]));
        }
        ctx.closePath();
        ctx.fillStyle = color + '99';     // 60 % opacity
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        // Update cumulative.
        for (var ic = 0; ic < t.length; ic++) cum[ic] += (lyr.rate[ic] || 0);
    }
    // Legend.
    var lx = plotX + plotW + 14;
    var ly = plotY + 4;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (var le = 0; le < layers.length; le++) {
        var c2 = _LAYER_COLORS[le % _LAYER_COLORS.length];
        ctx.fillStyle = c2;
        ctx.fillRect(lx, ly + le * 16 + 2, 10, 10);
        ctx.fillStyle = T.text;
        var lbl = layers[le].label;
        if (lbl.length > 12) lbl = lbl.slice(0, 11) + '…';
        ctx.fillText(lbl, lx + 14, ly + le * 16);
    }
}

function _renderPLTTable(result) {
    if (!_hasDoc) return;
    var host = document.getElementById(_PLT_TABLE_ID);
    if (!host) return;
    if (!result || !result.layers || !result.layers.length) {
        host.innerHTML = '<div style="color:#6e7681; font-size:12px;">No layer data yet.</div>';
        return;
    }
    var T = _theme();
    var pvt = _pvtComputed();
    var rateUnit = pvt ? (pvt.fluidType === 'gas' ? 'MSCF/d' : pvt.fluidType === 'water' ? 'BWPD' : 'STB/d') : '(rel.)';
    var khUnit = pvt ? 'md·ft' : '(rel.)';
    var h = '<table style="width:100%; border-collapse:collapse; font-size:12px; color:' + T.text + ';">';
    h += '<thead><tr style="background:' + T.bg + '; border-bottom:1px solid ' + T.border + ';">'
       + '<th style="text-align:left; padding:6px 8px;">Layer</th>'
       + '<th style="text-align:right; padding:6px 8px;">kh (' + khUnit + ')</th>'
       + '<th style="text-align:right; padding:6px 8px;">Initial frac</th>'
       + '<th style="text-align:right; padding:6px 8px;">Final frac</th>'
       + '<th style="text-align:right; padding:6px 8px;">Mean frac</th>'
       + '<th style="text-align:right; padding:6px 8px;">EUR (cum, ' + rateUnit + '·hr)</th>'
       + '</tr></thead><tbody>';
    for (var i = 0; i < result.layers.length; i++) {
        var L = result.layers[i];
        var swatch = _LAYER_COLORS[i % _LAYER_COLORS.length];
        h += '<tr style="border-bottom:1px solid ' + T.border + ';">'
           + '<td style="padding:6px 8px;"><span style="display:inline-block; width:10px; height:10px; '
           + 'background:' + swatch + '; vertical-align:middle; margin-right:6px;"></span>'
           + _esc(L.label) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.kh, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.initialFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.finalFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.rateFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.cumulative, 4) + '</td>'
           + '</tr>';
    }
    h += '</tbody></table>';
    host.innerHTML = h;
}

function _pltExport() {
    if (!_pltLastResult || !_pltLastResult.result) {
        var msg = document.getElementById(_PLT_MSG_ID);
        if (msg) {
            var T = _theme();
            msg.innerHTML = '<span style="color:' + T.yellow + ';">Compute first, then export.</span>';
        }
        return;
    }
    var t = _pltLastResult.t;
    var layers = _pltLastResult.result.layers;
    var lines = [];
    var hdr = ['t_hr'];
    for (var k = 0; k < layers.length; k++) hdr.push('q_layer_' + (k + 1) + ' (' + layers[k].label + ')');
    hdr.push('q_total');
    lines.push(hdr.join(','));
    for (var i = 0; i < t.length; i++) {
        var row = [t[i]];
        var sum = 0;
        for (var lk = 0; lk < layers.length; lk++) {
            var rv = layers[lk].rate[i] || 0;
            row.push(rv);
            sum += rv;
        }
        row.push(sum);
        lines.push(row.join(','));
    }
    var csv = lines.join('\n');
    if (typeof Blob === 'function' && _hasDoc) {
        try {
            var blob = new Blob([csv], { type: 'text/csv' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'prism-synthetic-plt.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        } catch (e) {
            // Fallback: dump to a textarea.
            var ta = document.createElement('textarea');
            ta.value = csv;
            ta.style.cssText = 'width:100%; height:200px;';
            var host = document.getElementById(_PLT_TABLE_ID);
            if (host) {
                host.appendChild(ta);
                ta.select();
            }
        }
    }
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_export', { n_rows: t.length, n_layers: layers.length }); }
        catch (e) { /* swallow */ }
    }
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — UI: inverse-simulation panel
// ════════════════════════════════════════════════════════════════════
//
// Layout:
//   1. Header + status line (model + dataset summary)
//   2. "Run inverse simulation" button + "Save as analysis-data" button
//   3. Two stacked canvases (top: input p(t); bottom: recovered q(t))
//   4. Status / RMSE line
// ════════════════════════════════════════════════════════════════════

var _INV_CANVAS_P_ID = 'prism_inv_canvas_p';
var _INV_CANVAS_Q_ID = 'prism_inv_canvas_q';
var _INV_MSG_ID      = 'prism_inv_msg';
var _INV_NOTE_ID     = 'prism_inv_note';
var _invLastResult   = null;

G.PRiSM_renderInverseSimPanel = function PRiSM_renderInverseSimPanel(container) {
    if (!_hasDoc || !container) return;
    var T = _theme();
    container.innerHTML =
          '<div class="prism-inv-card" style="background:' + T.panel + '; border:1px solid ' + T.border + '; border-radius:6px; padding:14px;">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px;">'
        +     '<div style="font-weight:600; color:' + T.text + '; font-size:14px;">Inverse simulation — recover q(t) from p(t)</div>'
        +     '<div style="display:flex; gap:8px;">'
        +       '<button id="prism_inv_run" type="button" '
        +         'style="padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; '
        +         'border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Run inverse simulation</button>'
        +       '<button id="prism_inv_save" type="button" '
        +         'style="padding:6px 14px; background:#21262d; color:' + T.text + '; border:1px solid ' + T.border + '; '
        +         'border-radius:4px; cursor:pointer; font-size:12px;">Save as analysis-data</button>'
        +     '</div>'
        +   '</div>'
        +   '<div id="' + _INV_MSG_ID + '" style="font-size:12px; color:' + T.text2 + '; margin-bottom:10px;">'
        +     'Click <b>Run</b> to deconvolve the rate history from the active dataset using the active model.'
        +   '</div>'
        +   '<div style="display:flex; flex-direction:column; gap:8px;">'
        +     '<canvas id="' + _INV_CANVAS_P_ID + '" width="800" height="180" '
        +       'style="display:block; background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:6px; max-width:100%;"></canvas>'
        +     '<canvas id="' + _INV_CANVAS_Q_ID + '" width="800" height="180" '
        +       'style="display:block; background:' + T.bg + '; border:1px solid ' + T.border + '; border-radius:6px; max-width:100%;"></canvas>'
        +   '</div>'
        +   '<div id="' + _INV_NOTE_ID + '" style="margin-top:8px; font-size:11px; color:' + T.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnR = document.getElementById('prism_inv_run');
    var btnS = document.getElementById('prism_inv_save');
    if (btnR) btnR.onclick = _invRun;
    if (btnS) btnS.onclick = _invSave;
};

function _invRun() {
    var T = _theme();
    var msg = document.getElementById(_INV_MSG_ID);
    var st = G.PRiSM_state || {};
    var ds = G.PRiSM_dataset || null;
    var lf = st.lastFit || null;
    var modelKey = (lf && lf.modelKey) || st.model;
    var params = (lf && lf.params) || st.params || {};
    if (!modelKey || !_model(modelKey)) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">No active model — pick one on the Model tab and re-fit.</span>';
        return;
    }
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || ds.t.length < 4) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">No active dataset (need ≥ 4 (t, p) samples).</span>';
        return;
    }
    var t = ds.t.slice();
    var p = ds.p.slice();
    var result;
    try {
        result = G.PRiSM_inverseSim(modelKey, params, t, p);
    } catch (e) {
        if (msg) msg.innerHTML = '<span style="color:' + T.red + ';">Inverse-sim threw: ' + _esc(e && e.message) + '</span>';
        return;
    }
    _invLastResult = { result: result, t: t, p: p, modelKey: modelKey };
    if (!result.converged) {
        if (msg) msg.innerHTML = '<span style="color:' + T.red + ';">Inverse simulation did NOT converge: '
            + _esc(result.diagnostics.error || 'unknown reason') + '</span>';
    } else {
        if (msg) msg.innerHTML = '<span style="color:' + T.green + ';">Recovered q(t) for '
            + t.length + ' samples. RMSE(p) = ' + _fmtSig(result.rmse, 4) + '.</span>';
    }
    _drawInvCharts(t, p, result);
    var noteEl = document.getElementById(_INV_NOTE_ID);
    if (noteEl) noteEl.textContent = result.diagnostics.notes || '';
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_run', { model: modelKey, n: t.length, rmse: result.rmse }); }
        catch (e) { /* swallow */ }
    }
}

function _invSave() {
    var T = _theme();
    var msg = document.getElementById(_INV_MSG_ID);
    if (!_invLastResult || !_invLastResult.result || !_invLastResult.result.converged) {
        if (msg) msg.innerHTML = '<span style="color:' + T.yellow + ';">Run inverse simulation first.</span>';
        return;
    }
    var t = _invLastResult.t;
    var q = _invLastResult.result.q;
    var p = _invLastResult.p;
    // Save as a new analysis-data entry. Different host integrations expose
    // analysis-data differently — try the documented options in order.
    var saved = false;
    var modelKey = _invLastResult.modelKey;
    if (G.PRiSM_analysisData && typeof G.PRiSM_analysisData.add === 'function') {
        try {
            G.PRiSM_analysisData.add({
                kind:    'rate-recovered',
                modelKey: modelKey,
                t:       t.slice(),
                q:       q.slice(),
                p:       p.slice(),
                rmse:    _invLastResult.result.rmse,
                source:  'PRiSM_inverseSim',
                created: new Date().toISOString()
            });
            saved = true;
        } catch (e) { /* fall through to next strategy */ }
    }
    if (!saved && Array.isArray(G.PRiSM_analysisData)) {
        try {
            G.PRiSM_analysisData.push({
                kind:    'rate-recovered',
                modelKey: modelKey,
                t:       t.slice(),
                q:       q.slice(),
                rmse:    _invLastResult.result.rmse,
                created: new Date().toISOString()
            });
            saved = true;
        } catch (e) { /* fall through */ }
    }
    if (!saved) {
        // Fallback: stash on the dataset.
        if (G.PRiSM_dataset) {
            G.PRiSM_dataset.q_recovered = q.slice();
            G.PRiSM_dataset.q_recovered_meta = {
                modelKey: modelKey,
                rmse: _invLastResult.result.rmse,
                created: new Date().toISOString()
            };
            saved = true;
        }
    }
    if (msg) {
        if (saved) {
            msg.innerHTML = '<span style="color:' + T.green + ';">Recovered q saved as analysis-data ('
                + t.length + ' points).</span>';
        } else {
            msg.innerHTML = '<span style="color:' + T.yellow + ';">Could not locate an analysis-data sink. Recovered q is still available on _invLastResult for export.</span>';
        }
    }
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_save', { model: modelKey, n: t.length, saved: saved }); }
        catch (e) { /* swallow */ }
    }
}

function _drawInvCharts(t, p, result) {
    if (!_hasDoc) return;
    var canvasP = document.getElementById(_INV_CANVAS_P_ID);
    var canvasQ = document.getElementById(_INV_CANVAS_Q_ID);
    if (canvasP) _drawInvSeries(canvasP, t, p, result.pPredicted, 'pressure', 'p (psi or dimensionless)');
    if (canvasQ) _drawInvSeries(canvasQ, t, result.q, null, 'rate', 'q (rate units)');
}

// Draw a single (t, y) series — optionally with a model overlay.
function _drawInvSeries(canvas, t, y, overlay, kind, ylabel) {
    var ctx = canvas.getContext('2d');
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 22, right: 60, bottom: 32, left: 60 };
    var plotX = pad.left, plotY = pad.top;
    var plotW = w - pad.left - pad.right;
    var plotH = h - pad.top - pad.bottom;
    if (!t.length || !y.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('No data', w / 2, h / 2);
        return;
    }
    var tMin = Infinity, tMax = -Infinity;
    var yMin = Infinity, yMax = -Infinity;
    for (var i = 0; i < t.length; i++) {
        var tv = t[i], yv = y[i];
        if (_isNum(tv)) {
            if (tv < tMin) tMin = tv;
            if (tv > tMax) tMax = tv;
        }
        if (_isNum(yv)) {
            if (yv < yMin) yMin = yv;
            if (yv > yMax) yMax = yv;
        }
    }
    if (overlay && overlay.length) {
        for (var j = 0; j < overlay.length; j++) {
            var ov = overlay[j];
            if (_isNum(ov)) {
                if (ov < yMin) yMin = ov;
                if (ov > yMax) yMax = ov;
            }
        }
    }
    if (!isFinite(tMin) || tMin >= tMax) { tMin = 0; tMax = 1; }
    if (!isFinite(yMin) || yMin >= yMax) { yMin = -1; yMax = 1; }
    var span = yMax - yMin;
    yMin -= 0.05 * span; yMax += 0.05 * span;
    function xMap(tv) { return plotX + plotW * (tv - tMin) / (tMax - tMin); }
    function yMap(yv) { return plotY + plotH * (1 - (yv - yMin) / (yMax - yMin)); }
    // Grid + axes.
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    // Y axis.
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
        var yp = plotY + plotH * g / 4;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        var yLabel = yMax - g * (yMax - yMin) / 4;
        ctx.fillText(_fmtSig(yLabel, 3), plotX - 6, yp);
    }
    // X axis.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var x = 0; x <= 5; x++) {
        var frac = x / 5;
        var tv2 = tMin + frac * (tMax - tMin);
        var xp = xMap(tv2);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv2, 3), xp, plotY + plotH + 4);
    }
    // Axis labels.
    ctx.fillStyle = T.text;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('time (hr)', plotX + plotW / 2, h - 4);
    ctx.save();
    ctx.translate(14, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(ylabel, 0, 0);
    ctx.restore();
    // Data series.
    var color = (kind === 'pressure') ? T.blue : T.accent;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var started = false;
    for (var k = 0; k < t.length; k++) {
        if (!_isNum(t[k]) || !_isNum(y[k])) continue;
        var xp2 = xMap(t[k]);
        var yp2 = yMap(y[k]);
        if (!started) { ctx.moveTo(xp2, yp2); started = true; }
        else ctx.lineTo(xp2, yp2);
    }
    ctx.stroke();
    // Markers.
    ctx.fillStyle = color;
    for (var m = 0; m < t.length; m++) {
        if (!_isNum(t[m]) || !_isNum(y[m])) continue;
        var xpm = xMap(t[m]), ypm = yMap(y[m]);
        ctx.beginPath();
        ctx.arc(xpm, ypm, 1.6, 0, 2 * Math.PI);
        ctx.fill();
    }
    // Overlay (predicted) — dashed.
    if (overlay && overlay.length) {
        ctx.strokeStyle = T.green;
        ctx.lineWidth = 1.2;
        if (ctx.setLineDash) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        var started2 = false;
        for (var ov2 = 0; ov2 < overlay.length; ov2++) {
            if (!_isNum(t[ov2]) || !_isNum(overlay[ov2])) continue;
            var xpv = xMap(t[ov2]);
            var ypv = yMap(overlay[ov2]);
            if (!started2) { ctx.moveTo(xpv, ypv); started2 = true; }
            else ctx.lineTo(xpv, ypv);
        }
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
        // Legend.
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = color;
        ctx.fillRect(plotX + plotW - 90, plotY + 6, 10, 4);
        ctx.fillStyle = T.text;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('observed', plotX + plotW - 76, plotY + 8);
        ctx.fillStyle = T.green;
        ctx.fillRect(plotX + plotW - 90, plotY + 18, 10, 4);
        ctx.fillStyle = T.text;
        ctx.fillText('predicted', plotX + plotW - 76, plotY + 20);
    }
}


// ════════════════════════════════════════════════════════════════════
// SELF-TEST
// ════════════════════════════════════════════════════════════════════
//
//  1. Synthetic PLT on a 3-layer no-XF model with kh=[1000, 500, 500]:
//     rate fractions should be [0.5, 0.25, 0.25] constant in time.
//  2. Synthetic PLT on multiLayerXF: cross-flow rate fractions evolve in
//     time (verify they are not constant).
//  3. Inverse simulation: forward-simulate p(t) from a known constant-rate
//     input on the homogeneous model, then inverse-simulate q from p.
//     Recovered q within 5 % of input over the body of the dataset.
//  4. Inverse simulation enforces non-negativity (clipped to ≥ 0).
//  5. PRiSM_unitRateResponse returns finite numbers and degrades gracefully
//     when PVT is absent (returns dimensionless pd).
//
// Run via: node prism-build/20-plt-inverse.js  (after the foundation +
// composite-multilayer files are loaded into a stub harness — or as part
// of the main concat-built script in a real browser session).
// ════════════════════════════════════════════════════════════════════

(function _selfTest() {
    var __PRISM_SELFTEST_LOG = [];
    function _log(s) {
        __PRISM_SELFTEST_LOG.push(s);
        if (typeof console !== 'undefined' && console.log) console.log(s);
    }
    var pass = 0, fail = 0;
    function _check(label, ok, detail) {
        if (ok) { pass++; _log('  ✓ ' + label + (detail ? ' — ' + detail : '')); }
        else    { fail++; _log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
    }
    _log('PRiSM 20 self-test — PLT + inverse simulation');

    // Test 0: API surface.
    _check('PRiSM_syntheticPLT defined',     typeof G.PRiSM_syntheticPLT === 'function');
    _check('PRiSM_renderPLTPanel defined',   typeof G.PRiSM_renderPLTPanel === 'function');
    _check('PRiSM_inverseSim defined',       typeof G.PRiSM_inverseSim === 'function');
    _check('PRiSM_renderInverseSimPanel defined', typeof G.PRiSM_renderInverseSimPanel === 'function');
    _check('PRiSM_unitRateResponse defined', typeof G.PRiSM_unitRateResponse === 'function');

    // Test 1: 3-layer no-XF rate fractions [0.5, 0.25, 0.25].
    if (G.PRiSM_MODELS && G.PRiSM_MODELS.multiLayerNoXF) {
        try {
            // Use khFracs that imply [0.5, 0.25, 0.25] for kh contribution.
            // perms = [1, 1, 1]; khFracs normalised.
            var p3 = { Cd: 100, S: 0, N: 3,
                       perms: [1, 1, 1],
                       khFracs: [0.5, 0.25, 0.25] };
            var t3 = [0.1, 1, 10, 100];
            var q3 = [1000, 1000, 1000, 1000];
            var r3 = G.PRiSM_syntheticPLT('multiLayerNoXF', p3, t3, q3);
            _check('Test 1: 3-layer no-XF — 3 layers', r3.layers.length === 3,
                'got ' + r3.layers.length);
            _check('Test 1: layer 1 fraction ≈ 0.5',
                Math.abs(r3.layers[0].rateFraction - 0.5) < 0.02,
                'got ' + r3.layers[0].rateFraction.toFixed(4));
            _check('Test 1: layer 2 fraction ≈ 0.25',
                Math.abs(r3.layers[1].rateFraction - 0.25) < 0.02,
                'got ' + r3.layers[1].rateFraction.toFixed(4));
            _check('Test 1: layer 3 fraction ≈ 0.25',
                Math.abs(r3.layers[2].rateFraction - 0.25) < 0.02,
                'got ' + r3.layers[2].rateFraction.toFixed(4));
            // Total rate should equal q_total at each t.
            var maxDiff = 0;
            for (var i = 0; i < t3.length; i++) {
                var diff = Math.abs(r3.totalRate[i] - q3[i]);
                if (diff > maxDiff) maxDiff = diff;
            }
            _check('Test 1: total rate matches q_total at every t',
                maxDiff < 1e-6, 'maxDiff = ' + maxDiff.toExponential(2));
            // Constant in time check — initial == final.
            var constOK = true;
            for (var li = 0; li < 3; li++) {
                if (Math.abs(r3.layers[li].initialFraction - r3.layers[li].finalFraction) > 1e-6) {
                    constOK = false; break;
                }
            }
            _check('Test 1: rate fractions constant in time',
                constOK);
        } catch (e) {
            _check('Test 1: synthetic PLT no-XF executed without error', false,
                e && e.message);
        }
    } else {
        _check('Test 1: skipped — multiLayerNoXF not in registry', true,
            '(model registry missing — run after layer 08 loads)');
    }

    // Test 2: multiLayerXF — fractions evolve in time.
    if (G.PRiSM_MODELS && G.PRiSM_MODELS.multiLayerXF) {
        try {
            // Strongly contrasting layers so the cross-flow signature is
            // unambiguous: ω heavy on top, κ heavy on bottom.
            var pXF = { Cd: 100, S: 0, N: 3, lambda: 1e-3,
                        omegas: [0.7, 0.2, 0.1],
                        kappas: [0.1, 0.2, 0.7] };
            var tXF = [0.001, 0.1, 10, 1000, 100000];
            var qXF = [1000, 1000, 1000, 1000, 1000];
            var rXF = G.PRiSM_syntheticPLT('multiLayerXF', pXF, tXF, qXF);
            _check('Test 2: XF — 3 layers', rXF.layers.length === 3);
            // Verify fractions are NOT constant — initial vs final differ.
            var anyEvolves = false;
            for (var le = 0; le < 3; le++) {
                if (Math.abs(rXF.layers[le].initialFraction - rXF.layers[le].finalFraction) > 0.05) {
                    anyEvolves = true; break;
                }
            }
            _check('Test 2: cross-flow fractions evolve with time',
                anyEvolves,
                'L1 init→final: ' + rXF.layers[0].initialFraction.toFixed(3)
                    + '→' + rXF.layers[0].finalFraction.toFixed(3));
            // Total rate balance.
            var maxXFDiff = 0;
            for (var ix2 = 0; ix2 < tXF.length; ix2++) {
                var dx = Math.abs(rXF.totalRate[ix2] - qXF[ix2]);
                if (dx > maxXFDiff) maxXFDiff = dx;
            }
            _check('Test 2: XF total rate matches q_total',
                maxXFDiff < 1e-6, 'maxDiff = ' + maxXFDiff.toExponential(2));
        } catch (e) {
            _check('Test 2: multiLayerXF executed without error', false,
                e && e.message);
        }
    } else {
        _check('Test 2: skipped — multiLayerXF not in registry', true,
            '(model registry missing — run after layer 08 loads)');
    }

    // Test 3 + 4: Inverse simulation — round-trip on the homogeneous model.
    if (G.PRiSM_MODELS && G.PRiSM_MODELS.homogeneous &&
        typeof G.PRiSM_unitRateResponse === 'function' &&
        typeof G.PRiSM_inverseSim === 'function') {
        try {
            // Synthesise constant-rate drawdown pressures via the same
            // unit-rate response we use in the inverse path.
            // We work in DIMENSIONLESS units (no PVT) so the response is
            // pwd(td) directly.
            var paramsH = { Cd: 100, S: 0 };
            // 30 logarithmically spaced points.
            var tArr = G.PRiSM_logspace(-2, 3, 30);
            var qInput = 50.0;          // arbitrary constant rate
            var gUnit = G.PRiSM_unitRateResponse('homogeneous', paramsH, tArr);
            // Build p(t) = p_init - q_input · (g_unit cumulatively folded).
            // For a constant rate q_input held since t=0, the response is
            // p_init - q_input · g_unit(t)  (since the rate-impulse Σ
            // collapses to a single q_input · g_unit(t) term).
            var pInit = 5000;
            var pSeries = new Array(tArr.length);
            for (var ip = 0; ip < tArr.length; ip++) {
                pSeries[ip] = pInit - qInput * gUnit[ip];
            }
            var inv = G.PRiSM_inverseSim('homogeneous', paramsH, tArr, pSeries);
            _check('Test 3: inverse sim converged', inv.converged);
            _check('Test 3: inverse sim produced same-length q',
                inv.q.length === tArr.length,
                'q.length=' + inv.q.length + ' vs t.length=' + tArr.length);
            // Compute mean recovered q over the BODY of the dataset
            // (skip first 2 and last 2 to avoid edge effects).
            var totalQ = 0, count = 0;
            for (var jq = 2; jq < tArr.length - 2; jq++) {
                if (_isNum(inv.q[jq])) {
                    totalQ += inv.q[jq];
                    count++;
                }
            }
            var meanQ = count > 0 ? totalQ / count : 0;
            var pctErr = Math.abs(meanQ - qInput) / qInput;
            _check('Test 3: recovered q mean within 5 % of input',
                pctErr < 0.05,
                'mean q=' + meanQ.toFixed(2) + ' vs input ' + qInput
                    + ' (err=' + (pctErr * 100).toFixed(2) + '%)');
            // Test 4: non-negativity.
            var anyNeg = false;
            for (var iN = 0; iN < inv.q.length; iN++) {
                if (inv.q[iN] < 0) { anyNeg = true; break; }
            }
            _check('Test 4: inverse sim enforces non-negativity (no q < 0)',
                !anyNeg);
        } catch (e) {
            _check('Test 3+4: inverse-sim round-trip executed without error', false,
                e && e.message);
        }
    } else {
        _check('Test 3+4: skipped — required primitives missing', true,
            '(homogeneous model + logspace must be loaded first)');
    }

    // Test 5: PRiSM_unitRateResponse defensive behaviour.
    if (typeof G.PRiSM_unitRateResponse === 'function' &&
        G.PRiSM_MODELS && G.PRiSM_MODELS.homogeneous) {
        try {
            var resp = G.PRiSM_unitRateResponse('homogeneous',
                { Cd: 100, S: 0 }, [0.1, 1, 10]);
            var allFinite = true;
            for (var i5 = 0; i5 < resp.length; i5++) {
                if (!_isNum(resp[i5])) { allFinite = false; break; }
            }
            _check('Test 5: unit-rate response returns finite numbers',
                allFinite, 'sample: ' + resp.map(function (v) {
                    return v == null ? '?' : v.toFixed(4);
                }).join(', '));
        } catch (e) {
            _check('Test 5: unit-rate response executed', false, e && e.message);
        }
    }

    // Test 6: degenerate path on non-multi-layer model.
    if (G.PRiSM_MODELS && G.PRiSM_MODELS.homogeneous) {
        try {
            var rD = G.PRiSM_syntheticPLT('homogeneous', { Cd: 100, S: 0 },
                [0.1, 1, 10], [500, 500, 500]);
            _check('Test 6: homogeneous returns single-layer degenerate',
                rD.layers.length === 1 && Math.abs(rD.layers[0].rateFraction - 1.0) < 1e-9,
                'fraction=' + rD.layers[0].rateFraction);
            _check('Test 6: degenerate diagnostic notes mention single-layer',
                /degenerate|single-layer/i.test(rD.diagnostics.notes || ''));
        } catch (e) {
            _check('Test 6: degenerate homogeneous PLT executed', false,
                e && e.message);
        }
    }

    _log('PRiSM 20 self-test — ' + pass + ' pass, ' + fail + ' fail');
    if (typeof G !== 'undefined') {
        G.__PRiSM_20_selftest = { pass: pass, fail: fail, log: __PRISM_SELFTEST_LOG };
    }
})();

})();
