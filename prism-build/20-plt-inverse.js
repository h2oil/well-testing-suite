// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 20 — Synthetic PLT + Inverse Simulation
//   Synthetic PLT: per-layer rate contribution from a multi-layer fit
//   Inverse Sim: reconstruct rate history q(t) from pressure p(t)
//                given a forward-simulation model
// ════════════════════════════════════════════════════════════════════
//
// PUBLIC API (all on window.*)
//   window.PRiSM_syntheticPLT(modelKey, params, t, q_total, opts?)
//                                         → { layers, totalRate, cumulative,
//                                             diagnostics }
//        opts.khTotal  — scale layer kh to the fitted kh (md·ft)
//        opts.tdFactor — td = tdFactor·t for the cross-flow transition
//   window.PRiSM_renderPLTPanel(container, opts?) → void
//   window.PRiSM_inverseSim(modelKey, params, t, p, opts?)
//                                         → { q, converged, iterations,
//                                             rmse, pRef, pRefSource, ... }
//        opts.pRef / pRefSource  reference (initial) pressure; default the
//                                well's pi (C1), else extrapolated to tStart
//        opts.tStart             time the flow started (default 0 when the
//                                data start near 0)
//        opts.injector           Δp = p − pRef (injection) instead of pRef − p
//        opts.k                  permeability override (md)
//   window.PRiSM_inverseSimDataset(ds?, opts?) → same, inputs from C1/C2/C4
//   window.PRiSM_renderInverseSimPanel(container, opts?) → void
//   window.PRiSM_renderPLTInversePanel(container, opts?) → Tab 6 panel
//        "PLT & inverse simulation" (C7)
//   window.PRiSM_unitRateResponse(modelKey, params, tEval, opts?) → number[]
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • No external dependencies — pure vanilla JS, Math.*.
//   • Defensive: degenerate inputs return a clearly-flagged result instead
//     of throwing. Inverse sim returns {converged:false, ...} on failure
//     rather than throwing.
//   • Real units when possible: with the well inputs (C1: μ, B, ct, h, φ, rw)
//     and a fitted permeability (C4: lastFit.phys.k, else phys.kh / h) the
//     unit-rate response is in psi per STB/d (Mscf/d gas) and the recovered
//     q is in rate units. Otherwise it falls back to dimensionless td/pd.
//
// FOUNDATION PRIMITIVES IN SCOPE
//   PRiSM_MODELS[modelKey].pd(td, params)            forward pressure
//   PRiSM_logspace(min, max, n)                      log spaced grid
//   PRiSM_compute_bourdet(t, dp, L)                  Bourdet derivative
//   PRiSM_getWell() (C1) / PRiSM_getAnalysisData() (C2) / PRiSM_getLastFit() (C4)
//   PRiSM_state.lastFit / .model / .params           fallbacks
//   PRiSM_pvt                                        fallback well inputs
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

// ───────────────────────────────────────────────────────────────
// Shared-contract adapters (C1 well, C2 analysis data, C4 fit, C7
// panels). Every cross-module call is guarded with a local fallback.
// ───────────────────────────────────────────────────────────────
function _num(v) { return _isNum(v) ? v : null; }

// C1 well & fluid inputs → { mu, B, ct, h, phi, rw, q, pi, fluid, testType }.
function _wellDims() {
    var w = null;
    if (typeof G.PRiSM_getWell === 'function') {
        try { w = G.PRiSM_getWell(); } catch (e) { w = null; }
    }
    if (w && typeof w === 'object') {
        return {
            mu: _num(w.mu), B: _num(w.B), ct: _num(w.ct), h: _num(w.h), phi: _num(w.phi),
            rw: _num(w.rw), q: _num(w.q), pi: _num(w.pi), fluid: w.fluid || 'oil',
            testType: w.testType || 'auto', source: 'well'
        };
    }
    var pvt = G.PRiSM_pvt || {}, c = pvt._computed || {};
    var fluid = pvt.fluidType || 'oil';
    var B  = _num(fluid === 'gas' ? pvt.Bg : (fluid === 'water' ? pvt.Bw : pvt.Bo));
    var mu = _num(fluid === 'gas' ? pvt.mu_g : (fluid === 'water' ? pvt.mu_w : pvt.mu_o));
    var ct = _num(pvt.ct);
    if (B === null) B = _num(c.B);
    if (mu === null) mu = _num(c.mu);
    if (ct === null) ct = _num(c.ct);
    var prov = pvt.provenance || {};
    var piOk = (prov.p_res === 'user' || prov.p_res === 'sample' || prov.p_res === 'deconvolution');
    return {
        mu: mu, B: B, ct: ct, h: _num(pvt.h), phi: _num(pvt.phi), rw: _num(pvt.rw),
        q: _num(pvt.q), pi: piOk ? _num(pvt.p_res) : null, fluid: fluid,
        testType: pvt.testType || 'auto', source: 'pvt'
    };
}
function _dimsOK(w) {
    return !!(w && w.mu > 0 && w.B > 0 && w.ct > 0 && w.h > 0 && w.phi > 0 && w.rw > 0);
}
function _rateUnit(w) {
    var f = w && w.fluid;
    return f === 'gas' ? 'Mscf/d' : (f === 'water' ? 'BWPD' : 'STB/d');
}

// C4 last fit (normalised copy when the setter/getter exists).
function _getLastFit() {
    var lf = null;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; }
    }
    if (!lf) {
        var st = G.PRiSM_state;
        lf = (st && st.lastFit && typeof st.lastFit === 'object') ? st.lastFit : null;
    }
    return lf;
}

// Fitted model + physical results: { modelKey, params, phys, k, kh, kSource }.
// k comes from lastFit.phys.k, else phys.kh / h (legacy k_md / kh_md_ft last).
function _fitInfo(w) {
    var st = G.PRiSM_state || {};
    var lf = _getLastFit();
    var modelKey = (lf && (lf.modelKey || lf.model)) || st.model || null;
    var params = (lf && lf.params) || st.params || {};
    var phys = (lf && lf.phys && typeof lf.phys === 'object') ? lf.phys : null;
    var h = w ? w.h : null;
    var k = null, kh = null, kSource = null;
    if (phys) {
        if (_num(phys.k) > 0) { k = phys.k; kSource = 'fit'; }
        if (_num(phys.kh) > 0) kh = phys.kh;
        if (k === null && kh !== null && h > 0) { k = kh / h; kSource = 'fit (kh / h)'; }
    }
    if (k === null && lf) {
        if (_num(lf.k_md) > 0) { k = lf.k_md; kSource = 'fit'; }
        else if (_num(lf.kh_md_ft) > 0 && h > 0) { k = lf.kh_md_ft / h; kSource = 'fit (kh / h)'; }
    }
    if (kh === null && k !== null && h > 0) kh = k * h;
    return { modelKey: modelKey, params: params, phys: phys, k: k, kh: kh, kSource: kSource,
             source: lf ? (lf.source || 'fit') : null };
}

// C2 analysis data (test type, reference pressure, periods).
function _getAnalysisData(ds) {
    if (typeof G.PRiSM_getAnalysisData !== 'function') return null;
    try {
        var a = G.PRiSM_getAnalysisData(ds);
        return (a && a.ok !== false) ? a : null;
    } catch (e) { return null; }
}

// C7 — tab panel registry (merge; replace an entry with the same id).
function _registerPanel(n, spec) {
    if (typeof G.PRiSM_registerTabPanel === 'function') {
        try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall through */ }
    }
    G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
    var list = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === spec.id) { list[i] = spec; return; }
    }
    list.push(spec);
}

// Dimensionless time per hour for the fitted model: 0.0002637·k/(φμct·Lref²),
// Lref = rw, or xf / Lh when the model is referenced to those (C3 metadata).
function _tdFactor(modelKey, w, fit) {
    if (!_dimsOK(w) || !(fit && fit.k > 0)) return null;
    var Lref = w.rw;
    var spec = _model(modelKey);
    var ref = spec && spec.refLength;
    if (fit.phys && (ref === 'xf' || ref === 'Lh')) {
        var L = _num(fit.phys[ref]);
        if (L > 0) Lref = L;
    }
    return 0.0002637 * fit.k / (w.phi * w.mu * w.ct * Lref * Lref);
}

// Production start when nothing better is known: test data normally count
// hours from the start of flow, so a first sample near zero means tStart = 0.
function _autoStart(t) {
    var n = t.length;
    if (!n) return 0;
    var t0 = t[0], span = t[n - 1] - t0;
    return (t0 > 0 && span > 0 && t0 <= 0.1 * span) ? 0 : t0;
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
    // kh per layer = perm × kh-fraction (relative units; PRiSM_syntheticPLT
    // scales them to the fitted kh when opts.khTotal is given).
    var hTot = 1.0;
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
 * PRiSM_syntheticPLT(modelKey, params, t, q_total, opts)
 *
 * Reconstruct per-layer rate contribution as a function of time.
 *
 * @param {string}   modelKey   e.g. 'multiLayerNoXF', 'multiLayerXF',
 *                              'homogeneous', 'radialComposite'.
 * @param {object}   params     fitted parameter set
 * @param {number[]} t          time array (hours, monotonically increasing)
 * @param {number[]} q_total    total wellbore rate at each t (same length)
 * @param {object}   [opts]     { khTotal: fitted kh (md·ft) → layer kh in md·ft,
 *                                tdFactor: td per hour for the cross-flow
 *                                transition (default: t is used as td) }
 * @return {object}             { layers, totalRate, cumulative, diagnostics }
 */
G.PRiSM_syntheticPLT = function PRiSM_syntheticPLT(modelKey, params, t, q_total, opts) {
    opts = opts || {};
    var tdF = (_isNum(opts.tdFactor) && opts.tdFactor > 0) ? opts.tdFactor : 1;
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
            var f = _xfFractionAt(tdF * t[ix], lyrX);
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
            var f2 = _xfFractionAt(tdF * t[i2], lyr2);
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
    // Fitted kh → per-layer kh in md·ft (same split, real units).
    var khUnits = 'relative';
    if (_isNum(opts.khTotal) && opts.khTotal > 0 && totalKh > 0) {
        var khScale = opts.khTotal / totalKh;
        for (var tk2 = 0; tk2 < nLayers; tk2++) khArr[tk2] *= khScale;
        totalKh = opts.khTotal;
        khUnits = 'md·ft';
    }
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
            khUnits:    khUnits,
            tdFactor:   tdF,
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
// SECTION 3 — Unit-rate response + convolution matrix
// ════════════════════════════════════════════════════════════════════
//
// Constant-rate response: Δp(t) = q · g(t), g = unit-rate response
//   g(t) = 141.2·μ·B/(k·h) · pd(td),  td = 0.0002637·k·t/(φ·μ·ct·Lref²)
// (psi per STB/d, or per Mscf/d with B in RB/Mscf — liquid-equivalent Δp).
//
// Piecewise-constant rates, one rate per sample interval (backward form):
//   q_k acts on (t_{k−1}, t_k],  t_{−1} = tStart (start of flow)
//   Δp(t_n) = Σ_{k=0..n} q_k · [ g(t_n − t_{k−1}) − g(t_n − t_k) ],  g(0) = 0
// so A is lower-triangular with A[n][n] = g(t_n − t_{n−1}) > 0 and every
// sample carries its own rate. Δp is measured from the reference pressure
// (pi), never from the first sample.

/**
 * PRiSM_unitRateResponse(modelKey, params, tEval, opts) → number[]
 *
 * Dimensional unit-rate pressure response (psi per rate unit) when the well
 * inputs (C1) and a permeability are available — opts.k, else the fit
 * (C4: lastFit.phys.k or phys.kh / h), else legacy params.k_md — otherwise
 * the dimensionless pd(td) with td = t.
 *
 * @param {string}   modelKey  registry key
 * @param {object}   params    dimensionless model parameters
 * @param {number[]} tEval     time grid (hours)
 * @param {object}   [opts]    { k, info: {} (filled with dimensional, k, kSource, tdFactor, A) }
 * @return {number[]}          unit-rate response, same length as tEval
 */
G.PRiSM_unitRateResponse = function PRiSM_unitRateResponse(modelKey, params, tEval, opts) {
    if (!Array.isArray(tEval)) throw new Error('PRiSM_unitRateResponse: tEval must be an array');
    opts = opts || {};
    var spec = _model(modelKey);
    if (!spec || typeof spec.pd !== 'function') {
        throw new Error('PRiSM_unitRateResponse: unknown model "' + modelKey + '"');
    }
    var w = _wellDims();
    var fit = _fitInfo(w);
    var k = null, kSource = null;
    if (_num(opts.k) > 0) { k = opts.k; kSource = 'given'; }
    else if (params && _num(params.k_md) > 0) { k = params.k_md; kSource = 'params'; }
    else if (fit.k > 0) { k = fit.k; kSource = fit.kSource; }
    var fitK = { k: k, phys: fit.phys };
    var tdF = _tdFactor(modelKey, w, fitK);
    var dimensional = tdF !== null;
    var A = dimensional ? 141.2 * w.mu * w.B / (k * w.h) : 1;
    if (!dimensional) tdF = 1;                // caller-supplied dimensionless grid
    var P = {};
    for (var pk in (params || {})) if (Object.prototype.hasOwnProperty.call(params, pk)) P[pk] = params[pk];
    if (dimensional && P.__h_rw == null) P.__h_rw = w.h / w.rw;   // C3 injected geometry

    // Evaluate pd at every td > 0 in one pass (some models accept arrays).
    var validIdx = [], validTd = [];
    for (var j = 0; j < tEval.length; j++) {
        var tv = tEval[j];
        if (_isNum(tv) && tv > 0) { validIdx.push(j); validTd.push(tdF * tv); }
    }
    var out = new Array(tEval.length);
    for (var z = 0; z < tEval.length; z++) out[z] = 0;
    if (opts.info && typeof opts.info === 'object') {
        opts.info.dimensional = dimensional; opts.info.k = k; opts.info.kSource = kSource;
        opts.info.tdFactor = tdF; opts.info.A = A; opts.info.rateUnit = dimensional ? _rateUnit(w) : null;
    }
    if (!validTd.length) return out;
    var pdArr;
    try {
        pdArr = spec.pd(validTd, P);
        if (!Array.isArray(pdArr) && !(pdArr && typeof pdArr.length === 'number')) pdArr = [pdArr];
    } catch (e) {
        // Point-by-point so a single bad td doesn't kill the whole batch.
        pdArr = new Array(validTd.length);
        for (var p = 0; p < validTd.length; p++) {
            try { pdArr[p] = spec.pd([validTd[p]], P)[0]; }
            catch (e2) { pdArr[p] = NaN; }
        }
    }
    // Very small td can make the Laplace inversion fail (NaN): extend the
    // first finite value linearly to zero (storage-dominated start).
    var firstK = -1;
    for (var f0 = 0; f0 < validTd.length; f0++) {
        if (_isNum(pdArr[f0]) && pdArr[f0] > 0) { firstK = f0; break; }
    }
    for (var v = 0; v < validIdx.length; v++) {
        var pdv = pdArr[v];
        if (!_isNum(pdv)) {
            pdv = (firstK >= 0 && validTd[v] < validTd[firstK])
                ? pdArr[firstK] * validTd[v] / validTd[firstK] : 0;
        }
        out[validIdx[v]] = A * pdv;
    }
    return out;
};

// Unit response on a log grid spanning [tauMin, tauMax], interpolated
// log-log (exact for power laws) → gAt(τ), with g(τ ≤ 0) = 0 and a linear
// start below the grid.
function _responseInterp(modelKey, params, tauMin, tauMax, uopts) {
    var lo = Math.log10(Math.max(tauMin * 0.999, 1e-9));
    var hi = Math.log10(Math.max(tauMax * 1.001, tauMin * 1.01));
    var n = Math.max(40, Math.min(400, Math.ceil(30 * (hi - lo)) + 1));
    var grid = new Array(n);
    for (var i = 0; i < n; i++) grid[i] = Math.pow(10, lo + (hi - lo) * i / (n - 1));
    var g = G.PRiSM_unitRateResponse(modelKey, params, grid, uopts);
    var lnT0 = Math.log(grid[0]), dLn = (Math.log(grid[n - 1]) - lnT0) / (n - 1);
    var lnG = g.map(function (v) { return v > 0 ? Math.log(v) : NaN; });
    return function gAt(tau) {
        if (!(tau > 0)) return 0;
        if (tau <= grid[0]) return g[0] * tau / grid[0];
        if (tau >= grid[n - 1]) return g[n - 1];
        var u = (Math.log(tau) - lnT0) / dLn;
        var j = Math.floor(u);
        if (j < 0) j = 0;
        if (j > n - 2) j = n - 2;
        var f = u - j;
        if (_isNum(lnG[j]) && _isNum(lnG[j + 1])) return Math.exp(lnG[j] + f * (lnG[j + 1] - lnG[j]));
        return g[j] + f * (g[j + 1] - g[j]);
    };
}

// Lower-triangular convolution matrix (backward form, see the header).
function _buildConvMatrix(modelKey, params, t, tStart, uopts) {
    var n = t.length;
    if (n === 0) return { A: [] };
    var minD = Infinity, maxD = t[n - 1] - tStart;
    for (var i = 0; i < n; i++) {
        var d = t[i] - (i === 0 ? tStart : t[i - 1]);
        if (d > 0 && d < minD) minD = d;
    }
    if (!(maxD > 0) || !isFinite(minD)) throw new Error('time must increase after the start of flow');
    var gAt = _responseInterp(modelKey, params, minD, maxD, uopts);
    var A = new Array(n);
    for (var r = 0; r < n; r++) {
        var row = new Array(n);
        for (var c = 0; c < n; c++) {
            if (c > r) { row[c] = 0; continue; }
            var tPrev = (c === 0) ? tStart : t[c - 1];
            var gA = gAt(t[r] - tPrev);
            var gB = (c < r) ? gAt(t[r] - t[c]) : 0;
            var a = gA - gB;
            row[c] = _isNum(a) ? a : 0;
        }
        A[r] = row;
    }
    return { A: A };
}

// Straight line through the first samples, evaluated at the start of flow
// (used only when no initial pressure is known — flagged in the result).
function _extrapolateRef(t, p, t0) {
    var m = Math.min(3, t.length);
    if (m < 2) return p.length ? p[p.length - 1] : NaN;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < m; i++) { sx += t[i]; sy += p[i]; sxx += t[i] * t[i]; sxy += t[i] * p[i]; }
    var den = m * sxx - sx * sx;
    if (Math.abs(den) < 1e-30) return sy / m;
    var b = (m * sxy - sx * sy) / den, a = (sy - b * sx) / m;
    return a + b * t0;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — Inverse simulation
// ════════════════════════════════════════════════════════════════════
//
// Given p(t), a model + params and a reference pressure pRef (pi), recover
// q(t) from   A · q = Δp,   Δp = pRef − p   (producer)  or  p − pRef (injector).
//
// Algorithm:
//   1. Build A (SECTION 3) and Δp from pRef.
//   2. Solve (Aᵀ A + α I) q = Aᵀ Δp  (Tikhonov-regularised normal equations);
//      α damps the high-frequency oscillation of a naive solve.
//   3. Clip negative q values to zero (NNLS-light) unless allowNegative.
//   4. Forward-simulate p_predicted = pRef ∓ A·q and report RMSE.

/**
 * PRiSM_inverseSim(modelKey, params, t, p, opts) → result
 *
 * @param {string}   modelKey
 * @param {object}   params     dimensionless model parameters
 * @param {number[]} t          time array (hours)
 * @param {number[]} p          pressure array (psia), same length
 * @param {object}   [opts]     { pRef, pRefSource, tStart, injector, k, allowNegative, alpha }
 * @return {object}  { q, converged, iterations, rmse, pPredicted, pRef, pRefSource,
 *                     tStart, injector, dimensional, k, kSource, rateUnit, warnings,
 *                     diagnostics }
 */
G.PRiSM_inverseSim = function PRiSM_inverseSim(modelKey, params, t, p, opts) {
    opts = opts || {};
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
    var warnings = [];
    var n = t.length;
    var tStart = _isNum(opts.tStart) ? opts.tStart : _autoStart(t);
    if (tStart > t[0]) tStart = t[0];
    var injector = !!opts.injector;

    // Reference pressure: given → well pi (C1) → extrapolated (flagged).
    var pRef = _num(opts.pRef), pRefSource = opts.pRefSource || (pRef !== null ? 'given' : null);
    if (pRef === null) {
        var w = _wellDims();
        if (w.pi !== null) { pRef = w.pi; pRefSource = 'pi'; }
    }
    if (pRef === null) {
        pRef = _extrapolateRef(t, p, tStart);
        pRefSource = 'extrapolated';
    }
    if (pRefSource === 'extrapolated' || pRefSource === 'first-sample') {
        warnings.push('No initial pressure is set: Δp is measured from '
            + (pRefSource === 'first-sample' ? 'the first sample' : 'the early data extrapolated to the start of flow')
            + ', so the rates may be biased. Enter pi on the Well & Test inputs.');
    }
    if (!_isNum(pRef)) return _inverseFail('no usable reference pressure', n);

    var info = {};
    var A;
    try {
        A = _buildConvMatrix(modelKey, params, t, tStart, { k: opts.k, info: info }).A;
    } catch (e) {
        return _inverseFail('build convolution matrix failed: ' + (e && e.message), n);
    }
    var sgn = injector ? -1 : 1;
    var rhs = new Array(n);
    for (var i = 0; i < n; i++) rhs[i] = sgn * (pRef - p[i]);

    // Tikhonov α relative to the matrix scale (Frobenius² / n).
    var fro2 = 0;
    for (var ri = 0; ri < n; ri++) {
        for (var rj = 0; rj <= ri; rj++) fro2 += A[ri][rj] * A[ri][rj];
    }
    var alpha = _isNum(opts.alpha) ? opts.alpha : 1e-8 * Math.max(1e-30, fro2) / n;

    // Normal equations (AᵀA + αI) q = Aᵀ rhs.
    var M = new Array(n);
    for (var mi = 0; mi < n; mi++) M[mi] = new Array(n).fill(0);
    var v = new Array(n).fill(0);
    for (var col = 0; col < n; col++) {
        for (var col2 = col; col2 < n; col2++) {
            var dot = 0;
            for (var r = Math.max(col, col2); r < n; r++) dot += A[r][col] * A[r][col2];
            M[col][col2] = dot;
            if (col !== col2) M[col2][col] = dot;
        }
        var dotV = 0;
        for (var rr = col; rr < n; rr++) dotV += A[rr][col] * rhs[rr];
        v[col] = dotV;
        M[col][col] += alpha;
    }
    var q;
    try {
        q = _solveLinear(M, v);
    } catch (e) {
        return _inverseFail('linear solve failed: ' + (e && e.message), n);
    }
    // Non-negativity clip (rates are magnitudes here; producer or injector).
    var allowNeg = !!(opts.allowNegative || (params && params.allowNegative));
    var clippedCount = 0;
    if (!allowNeg) {
        for (var iC = 0; iC < n; iC++) {
            if (q[iC] < 0) { q[iC] = 0; clippedCount++; }
        }
    }
    var pPred = new Array(n);
    var sse = 0;
    for (var rR = 0; rR < n; rR++) {
        var s2 = 0;
        for (var cC = 0; cC <= rR; cC++) s2 += A[rR][cC] * q[cC];
        pPred[rR] = pRef - sgn * s2;
        var d = p[rR] - pPred[rR];
        sse += d * d;
    }
    var rmse = Math.sqrt(sse / n);
    var converged = isFinite(rmse);

    var notes = 'Tikhonov-regularised linear deconvolution (α = ' + _fmtSig(alpha, 3) + '). '
              + 'Δp measured from ' + (pRefSource === 'pi' ? 'the initial pressure pi' : pRefSource === 'extrapolated'
                  ? 'an extrapolated start pressure' : 'the reference pressure') + ' = ' + _fmtSig(pRef, 6) + ' psia. ';
    if (clippedCount > 0) {
        notes += clippedCount + ' negative q value' + (clippedCount === 1 ? '' : 's') + ' clipped to zero. ';
    }
    if (info.dimensional) {
        notes += 'Rates in ' + info.rateUnit + ' (k = ' + _fmtSig(info.k, 4) + ' md from the ' + info.kSource + '). ';
    } else {
        notes += 'No fitted permeability or incomplete well inputs — rates are dimensionless (td = t). ';
        warnings.push('Rates are dimensionless: fit a model (regression or auto-match) and complete the '
            + 'well inputs to get rates in field units.');
    }

    return {
        q:           q,
        converged:   converged,
        iterations:  1,
        rmse:        rmse,
        pPredicted:  pPred,
        pRef:        pRef,
        pRefSource:  pRefSource,
        tStart:      tStart,
        injector:    injector,
        dimensional: !!info.dimensional,
        k:           info.k,
        kSource:     info.kSource,
        rateUnit:    info.dimensional ? info.rateUnit : 'dimensionless',
        warnings:    warnings,
        diagnostics: {
            method:         'linear-deconvolution',
            regularisation: 'tikhonov',
            alpha:          alpha,
            clipped:        clippedCount,
            dimensional:    !!info.dimensional,
            notes:          notes
        }
    };
};

/**
 * PRiSM_inverseSimDataset(ds?, opts?) — inverse simulation of the working
 * dataset with the fitted model (C4), the well pi (C1) and the test type /
 * flow start (C2). Long records are thinned (log-spaced) to ≤ opts.maxPoints
 * (default 300) to keep the O(n²) matrix small.
 */
G.PRiSM_inverseSimDataset = function PRiSM_inverseSimDataset(ds, opts) {
    opts = opts || {};
    ds = ds || G.PRiSM_dataset;
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p)) return _inverseFail('no dataset with t and p', 0);
    var w = _wellDims();
    var fit = _fitInfo(w);
    var modelKey = opts.modelKey || fit.modelKey;
    var params = opts.params || fit.params || {};
    if (!modelKey || !_model(modelKey)) return _inverseFail('no fitted model', 0);
    var t = [], p = [];
    for (var i = 0; i < ds.t.length; i++) {
        var ti = +ds.t[i], pi = +ds.p[i];
        if (!isFinite(ti) || !isFinite(pi)) continue;
        if (t.length && ti <= t[t.length - 1]) continue;
        t.push(ti); p.push(pi);
    }
    var maxPts = opts.maxPoints || 300;
    if (t.length > maxPts) {
        var keep = [0], lo = Math.log(Math.max(t[0] - _autoStart(t), 1e-9) || 1e-9);
        var hi = Math.log(Math.max(t[t.length - 1] - _autoStart(t), 1e-9));
        var step = (hi - lo) / (maxPts - 1), last = lo;
        for (var k = 1; k < t.length - 1; k++) {
            var l = Math.log(Math.max(t[k] - _autoStart(t), 1e-9));
            if (l - last >= step) { keep.push(k); last = l; }
        }
        keep.push(t.length - 1);
        t = keep.map(function (j) { return t[j]; });
        p = keep.map(function (j) { return p[j]; });
    }
    var ad = _getAnalysisData(ds);
    var testType = (w.testType && w.testType !== 'auto') ? w.testType : (ad && ad.testType) || 'auto';
    var o = {};
    for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
    if (o.injector == null) o.injector = (testType === 'injection' || testType === 'falloff');
    if (o.pRef == null && w.pi === null && ad && _isNum(ad.pRef) &&
        (ad.testType === 'drawdown' || ad.testType === 'injection')) {
        o.pRef = ad.pRef; o.pRefSource = ad.pRefSource || 'analysis data';
    }
    if (o.tStart == null && ad) {
        var per = (ad.periods && ad.periods[0]) || (ad.rateHistory && ad.rateHistory[0]);
        var ts = per ? (_num(per.t0) !== null ? per.t0 : _num(per.t)) : null;
        if (ts !== null && ts <= t[0]) o.tStart = ts;
    }
    var res = G.PRiSM_inverseSim(modelKey, params, t, p, o);
    res.t = t; res.p = p; res.modelKey = modelKey; res.testType = testType;
    return res;
};

function _inverseFail(reason, n) {
    return {
        q:          new Array(Math.max(1, n)).fill(0),
        converged:  false,
        iterations: 0,
        rmse:       NaN,
        pPredicted: [],
        warnings:   [],
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
// Host theme (CSS variables), usable at 375 px. All elements are looked
// up inside the container (the panel can be mounted in the Tab 6 panel
// area and in a tools drawer at the same time).
//   1. Status line (model + layers)
//   2. Stacked-area canvas (per-layer rate vs time)
//   3. Per-layer table (label | kh | initial / final / mean fraction | cum.)
//   4. Actions: Compute | Export CSV
// ════════════════════════════════════════════════════════════════════

var TV = {
    bg: 'var(--bg1,#0d1117)', panel: 'var(--bg2,#161b22)', border: 'var(--border,#30363d)',
    text: 'var(--text,#e6edf3)', text2: 'var(--text2,#8b949e)', text3: 'var(--text3,#6e7681)',
    accent: 'var(--accent,#f0883e)', green: 'var(--green,#3fb950)', red: 'var(--red,#f85149)',
    yellow: 'var(--yellow,#d29922)', blue: 'var(--blue,#58a6ff)'
};

function _q(container, id) {
    return (container && container.querySelector) ? container.querySelector('#' + id) : null;
}
function _btnHTML(id, label, primary) {
    return '<button id="' + id + '" type="button" class="btn ' + (primary ? 'btn-primary' : 'btn-secondary') + '" '
        + 'style="padding:6px 12px; min-height:32px; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;'
        + ' border:1px solid ' + (primary ? TV.accent : TV.border) + '; background:' + (primary ? TV.accent : TV.panel)
        + '; color:' + (primary ? '#0d1117' : TV.text) + ';">' + _esc(label) + '</button>';
}
function _say(container, id, html) {
    var el = _q(container, id);
    if (el) el.innerHTML = html;
}

var _PLT_MULTI = { multiLayerNoXF: 1, multiLayerXF: 1, twoLayerXF: 1 };
var _pltLastResult = null;

G.PRiSM_renderPLTPanel = function PRiSM_renderPLTPanel(container, opts) {
    if (!_hasDoc || !container) return;
    opts = opts || {};
    container.innerHTML =
          '<div class="prism-plt-card" style="max-width:100%; box-sizing:border-box; color:' + TV.text + '; font-size:12px;'
        +   (opts.embedded ? '' : ' background:' + TV.panel + '; border:1px solid ' + TV.border + '; border-radius:6px; padding:12px;') + '">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">'
        +     '<div style="font-weight:600; font-size:13px;">Layer contributions (synthetic PLT)</div>'
        +     '<div style="display:flex; gap:8px; flex-wrap:wrap;">'
        +       _btnHTML('prism_plt_compute', 'Compute', true)
        +       _btnHTML('prism_plt_export', 'Export CSV', false)
        +     '</div>'
        +   '</div>'
        +   '<div id="prism_plt_msg" style="color:' + TV.text2 + '; margin-bottom:8px;">'
        +     'Splits the well rate between layers using the fitted multi-layer model.'
        +   '</div>'
        +   '<canvas id="prism_plt_canvas" width="800" height="320" '
        +     'style="display:block; width:100%; max-width:100%; height:auto; background:' + TV.bg + '; border:1px solid ' + TV.border + '; border-radius:6px;"></canvas>'
        +   '<div id="prism_plt_table" style="margin-top:10px; overflow-x:auto; max-width:100%;">'
        +     '<div style="color:' + TV.text3 + ';">No layer data yet.</div>'
        +   '</div>'
        +   '<div id="prism_plt_note" style="margin-top:6px; font-size:11px; color:' + TV.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnC = _q(container, 'prism_plt_compute');
    var btnE = _q(container, 'prism_plt_export');
    if (btnC) btnC.onclick = function () { _pltCompute(container); };
    if (btnE) btnE.onclick = function () { _pltExport(container); };
    if (_pltLastResult) _pltPaint(container, _pltLastResult);
    else _drawPLTChart(_q(container, 'prism_plt_canvas'), [], []);
};

function _pltPaint(container, last) {
    _drawPLTChart(_q(container, 'prism_plt_canvas'), last.result.layers, last.t);
    _renderPLTTable(_q(container, 'prism_plt_table'), last);
    var noteEl = _q(container, 'prism_plt_note');
    if (noteEl) noteEl.textContent = last.result.diagnostics.notes || '';
}

function _pltCompute(container) {
    var w = _wellDims();
    var fit = _fitInfo(w);
    var ds = G.PRiSM_dataset || null;
    if (!fit.modelKey || !_PLT_MULTI[fit.modelKey]) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.yellow + ';">Layer contributions need a fitted multi-layer model '
            + '(two-layer or multi-layer, with or without cross-flow). Current model: <b>' + _esc(fit.modelKey || 'none') + '</b>.</span>');
        _pltLastResult = null;
        _drawPLTChart(_q(container, 'prism_plt_canvas'), [], []);
        _renderPLTTable(_q(container, 'prism_plt_table'), null);
        return;
    }
    if (!ds || !Array.isArray(ds.t) || ds.t.length < 2) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.yellow + ';">No working data — load data on the Data step first.</span>');
        return;
    }
    var t = ds.t.slice();
    var qTot, qNote = '';
    if (Array.isArray(ds.q) && ds.q.length === t.length) {
        qTot = ds.q.map(function (v) { return _isNum(+v) ? +v : 0; });
    } else {
        var qc = (w.q > 0) ? w.q : 1;
        if (!(w.q > 0)) qNote = ' No rate is known — fractions only (unit total rate).';
        qTot = t.map(function () { return qc; });
    }
    var o = {};
    if (fit.kh > 0) o.khTotal = fit.kh;
    var tdF = _tdFactor(fit.modelKey, w, fit);
    if (tdF) o.tdFactor = tdF;
    var result;
    try {
        result = G.PRiSM_syntheticPLT(fit.modelKey, fit.params, t, qTot, o);
    } catch (e) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.red + ';">Layer split failed: ' + _esc(e && e.message) + '</span>');
        return;
    }
    _pltLastResult = { result: result, t: t, rateUnit: _rateUnit(w), modelKey: fit.modelKey };
    var d = result.diagnostics;
    _say(container, 'prism_plt_msg', '<span style="color:' + TV.green + ';">' + d.nLayers + ' layer' + (d.nLayers === 1 ? '' : 's')
        + ' over ' + t.length + ' samples. Total kh ' + _fmtSig(d.totalKh, 4) + ' ' + (d.khUnits === 'md·ft' ? 'md·ft (from the fit)' : '(relative — no fitted kh yet)')
        + '.' + _esc(qNote) + '</span>');
    _pltPaint(container, _pltLastResult);
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_compute', { model: String(fit.modelKey || '') }); }
        catch (e) { /* swallow */ }
    }
}

// Stacked-area chart of per-layer rate contribution vs time.
function _drawPLTChart(canvas, layers, t) {
    if (!_hasDoc || !canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 24, right: 110, bottom: 38, left: 60 };
    if (!Array.isArray(layers) || !layers.length || !Array.isArray(t) || !t.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No layer data yet.', w / 2, h / 2);
        return;
    }
    var plotX = pad.left, plotY = pad.top;
    var plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
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
    var yMax = 0;
    for (var ti = 0; ti < t.length; ti++) {
        var s = 0;
        for (var li = 0; li < layers.length; li++) s += (layers[li].rate[ti] || 0);
        if (s > yMax) yMax = s;
    }
    if (yMax <= 0) yMax = 1;
    function yMap(qv) { return plotY + plotH * (1 - qv / yMax); }
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var g = 0; g <= 5; g++) {
        var yp = plotY + plotH * g / 5;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        ctx.fillText(_fmtSig(yMax * (1 - g / 5), 3), plotX - 6, yp);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var xt = 0; xt <= 5; xt++) {
        var frac = xt / 5;
        var tv = useLog ? Math.pow(10, Math.log10(tMin) + frac * (Math.log10(tMax) - Math.log10(tMin)))
                        : tMin + frac * (tMax - tMin);
        var xp = xMap(tv);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv, 3), xp, plotY + plotH + 4);
    }
    ctx.fillStyle = T.text;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('time (h)', plotX + plotW / 2, h - 6);
    ctx.save();
    ctx.translate(14, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('rate', 0, 0);
    ctx.restore();
    var cum = new Array(t.length).fill(0);
    for (var lk = 0; lk < layers.length; lk++) {
        var lyr = layers[lk];
        var color = _LAYER_COLORS[lk % _LAYER_COLORS.length];
        ctx.beginPath();
        for (var jj = 0; jj < t.length; jj++) {
            var top = cum[jj] + (lyr.rate[jj] || 0);
            if (jj === 0) ctx.moveTo(xMap(t[jj]), yMap(top));
            else ctx.lineTo(xMap(t[jj]), yMap(top));
        }
        for (var kk = t.length - 1; kk >= 0; kk--) ctx.lineTo(xMap(t[kk]), yMap(cum[kk]));
        ctx.closePath();
        ctx.fillStyle = color + '99';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        for (var ic = 0; ic < t.length; ic++) cum[ic] += (lyr.rate[ic] || 0);
    }
    var lx = plotX + plotW + 14, ly = plotY + 4;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (var le = 0; le < layers.length; le++) {
        ctx.fillStyle = _LAYER_COLORS[le % _LAYER_COLORS.length];
        ctx.fillRect(lx, ly + le * 16 + 2, 10, 10);
        ctx.fillStyle = T.text;
        var lbl = layers[le].label;
        if (lbl.length > 14) lbl = lbl.slice(0, 13) + '…';
        ctx.fillText(lbl, lx + 14, ly + le * 16);
    }
}

function _renderPLTTable(host, last) {
    if (!_hasDoc || !host) return;
    if (!last || !last.result || !last.result.layers || !last.result.layers.length) {
        host.innerHTML = '<div style="color:' + TV.text3 + ';">No layer data yet.</div>';
        return;
    }
    var result = last.result;
    var khUnit = result.diagnostics.khUnits === 'md·ft' ? 'md·ft' : 'relative';
    var volUnit = last.rateUnit === 'Mscf/d' ? 'Mscf' : (last.rateUnit === 'BWPD' ? 'bbl water' : 'STB');
    var h = '<table style="width:100%; border-collapse:collapse; font-size:12px; color:' + TV.text + ';">';
    h += '<thead><tr style="background:' + TV.bg + '; border-bottom:1px solid ' + TV.border + ';">'
       + '<th style="text-align:left; padding:6px 8px;">Layer</th>'
       + '<th style="text-align:right; padding:6px 8px;">kh (' + khUnit + ')</th>'
       + '<th style="text-align:right; padding:6px 8px;">Initial</th>'
       + '<th style="text-align:right; padding:6px 8px;">Final</th>'
       + '<th style="text-align:right; padding:6px 8px;">Mean</th>'
       + '<th style="text-align:right; padding:6px 8px;">Cum. (' + volUnit + ')</th>'
       + '</tr></thead><tbody>';
    for (var i = 0; i < result.layers.length; i++) {
        var L = result.layers[i];
        var swatch = _LAYER_COLORS[i % _LAYER_COLORS.length];
        h += '<tr style="border-bottom:1px solid ' + TV.border + ';">'
           + '<td style="padding:6px 8px; white-space:nowrap;"><span style="display:inline-block; width:10px; height:10px; '
           + 'background:' + swatch + '; vertical-align:middle; margin-right:6px;"></span>' + _esc(L.label) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.kh, 4) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.initialFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.finalFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmt(L.rateFraction, 3) + '</td>'
           + '<td style="text-align:right; padding:6px 8px; font-family:monospace;">' + _fmtSig(L.cumulative / 24, 4) + '</td>'
           + '</tr>';
    }
    h += '</tbody></table>';
    host.innerHTML = h;
}

function _pltExport(container) {
    if (!_pltLastResult || !_pltLastResult.result) {
        _say(container, 'prism_plt_msg', '<span style="color:' + TV.yellow + ';">Compute first, then export.</span>');
        return;
    }
    var t = _pltLastResult.t;
    var layers = _pltLastResult.result.layers;
    var lines = [];
    var hdr = ['t_hr'];
    for (var k = 0; k < layers.length; k++) hdr.push('q_layer_' + (k + 1));
    hdr.push('q_total');
    lines.push(hdr.join(','));
    for (var i = 0; i < t.length; i++) {
        var row = [t[i]], sum = 0;
        for (var lk = 0; lk < layers.length; lk++) {
            var rv = layers[lk].rate[i] || 0;
            row.push(rv);
            sum += rv;
        }
        row.push(sum);
        lines.push(row.join(','));
    }
    _download('prism-layer-rates.csv', lines.join('\n'), 'text/csv');
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_plt_export', {}); }
        catch (e) { /* swallow */ }
    }
}

function _download(name, text, type) {
    if (!_hasDoc || typeof Blob !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
    try {
        var url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 5000);
        return true;
    } catch (e) { return false; }
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — UI: inverse-simulation panel
// ════════════════════════════════════════════════════════════════════
//
//   1. Inputs line (fitted model, k and its source, reference pressure)
//   2. "Run" + "Save as analysis set"
//   3. Two stacked canvases (top: p(t) observed vs predicted; bottom: q(t))
//   4. Notes / warnings
// ════════════════════════════════════════════════════════════════════

var _invLastResult = null;

function _invInputsLine() {
    var w = _wellDims();
    var fit = _fitInfo(w);
    var parts = [];
    parts.push('Model: <b>' + _esc(fit.modelKey || 'none') + '</b>');
    parts.push(fit.k > 0 ? 'k = <b>' + _fmtSig(fit.k, 4) + ' md</b> (' + _esc(fit.kSource) + ')'
                         : '<span style="color:' + TV.yellow + ';">no fitted k — dimensionless rates</span>');
    parts.push(w.pi !== null ? 'Δp from p<sub>i</sub> = ' + _fmtSig(w.pi, 6) + ' psia'
                             : '<span style="color:' + TV.yellow + ';">p<sub>i</sub> not set — extrapolated</span>');
    if (!_dimsOK(w)) parts.push('<span style="color:' + TV.yellow + ';">well inputs incomplete</span>');
    return parts.join(' · ');
}

G.PRiSM_renderInverseSimPanel = function PRiSM_renderInverseSimPanel(container, opts) {
    if (!_hasDoc || !container) return;
    opts = opts || {};
    container.innerHTML =
          '<div class="prism-inv-card" style="max-width:100%; box-sizing:border-box; color:' + TV.text + '; font-size:12px;'
        +   (opts.embedded ? '' : ' background:' + TV.panel + '; border:1px solid ' + TV.border + '; border-radius:6px; padding:12px;') + '">'
        +   '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">'
        +     '<div style="font-weight:600; font-size:13px;">Rate from pressure (inverse simulation)</div>'
        +     '<div style="display:flex; gap:8px; flex-wrap:wrap;">'
        +       _btnHTML('prism_inv_run', 'Run', true)
        +       _btnHTML('prism_inv_save', 'Save as analysis set', false)
        +     '</div>'
        +   '</div>'
        +   '<div class="prism-inv-inputs" style="color:' + TV.text2 + '; margin-bottom:4px; line-height:1.5;">' + _invInputsLine() + '</div>'
        +   '<div id="prism_inv_msg" style="color:' + TV.text2 + '; margin-bottom:8px; min-height:14px;">'
        +     'Recovers the rate history implied by the pressures and the fitted model.'
        +   '</div>'
        +   '<div style="display:flex; flex-direction:column; gap:8px;">'
        +     '<canvas id="prism_inv_canvas_p" width="800" height="180" '
        +       'style="display:block; width:100%; max-width:100%; height:auto; background:' + TV.bg + '; border:1px solid ' + TV.border + '; border-radius:6px;"></canvas>'
        +     '<canvas id="prism_inv_canvas_q" width="800" height="180" '
        +       'style="display:block; width:100%; max-width:100%; height:auto; background:' + TV.bg + '; border:1px solid ' + TV.border + '; border-radius:6px;"></canvas>'
        +   '</div>'
        +   '<div id="prism_inv_note" style="margin-top:6px; font-size:11px; color:' + TV.text3 + '; line-height:1.5;"></div>'
        + '</div>';
    var btnR = _q(container, 'prism_inv_run');
    var btnS = _q(container, 'prism_inv_save');
    if (btnR) btnR.onclick = function () { _invRun(container); };
    if (btnS) btnS.onclick = function () { _invSave(container); };
    if (_invLastResult) _invPaint(container, _invLastResult);
};

function _median(a) {
    var v = a.filter(_isNum).slice().sort(function (x, y) { return x - y; });
    return v.length ? v[v.length >> 1] : NaN;
}

function _invPaint(container, last) {
    var r = last.result;
    var cp = _q(container, 'prism_inv_canvas_p'), cq = _q(container, 'prism_inv_canvas_q');
    if (cp) _drawInvSeries(cp, last.t, last.p, r.pPredicted, 'pressure', 'p (psia)');
    if (cq) _drawInvSeries(cq, last.t, r.q, null, 'rate', 'q (' + (r.rateUnit || 'rate') + ')');
    var noteEl = _q(container, 'prism_inv_note');
    if (noteEl) {
        noteEl.textContent = (r.diagnostics && r.diagnostics.notes) || '';
        (r.warnings || []).forEach(function (wtxt) {
            var d = document.createElement('div');
            d.style.color = 'var(--yellow,#d29922)';
            d.textContent = '⚠ ' + wtxt;
            noteEl.appendChild(d);
        });
    }
}

function _invRun(container) {
    var ds = G.PRiSM_dataset || null;
    var inputs = container.querySelector ? container.querySelector('.prism-inv-inputs') : null;
    if (inputs) inputs.innerHTML = _invInputsLine();
    var fit = _fitInfo(_wellDims());
    if (!fit.modelKey || !_model(fit.modelKey)) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">No model yet — choose and fit a model first.</span>');
        return;
    }
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || ds.t.length < 4) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">No working data (need at least 4 time / pressure samples).</span>');
        return;
    }
    var result;
    try {
        result = G.PRiSM_inverseSimDataset(ds);
    } catch (e) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.red + ';">Inverse simulation failed: ' + _esc(e && e.message) + '</span>');
        return;
    }
    if (!result.converged) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.red + ';">Inverse simulation failed: '
            + _esc((result.diagnostics && result.diagnostics.error) || 'unknown reason') + '</span>');
        return;
    }
    _invLastResult = { result: result, t: result.t, p: result.p, modelKey: result.modelKey };
    _say(container, 'prism_inv_msg', '<span style="color:' + TV.green + ';">Recovered rates for ' + result.t.length
        + ' samples · median q = ' + _fmtSig(_median(result.q), 4) + ' ' + _esc(result.rateUnit)
        + ' · RMSE(p) = ' + _fmtSig(result.rmse, 3) + ' psi.</span>');
    _invPaint(container, _invLastResult);
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_run', { model: String(result.modelKey || '') }); }
        catch (e) { /* swallow */ }
    }
}

function _invSave(container) {
    var last = _invLastResult;
    if (!last || !last.result || !last.result.converged) {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">Run the inverse simulation first.</span>');
        return;
    }
    var AD = G.PRiSM_analysisData;
    if (AD && typeof AD.add === 'function') {
        var r = last.result;
        AD.add({
            name: 'Recovered rate (' + last.modelKey + ')',
            source: 'inverse simulation',
            notes: 'Rates recovered from pressure with the ' + last.modelKey + ' model; RMSE ' + _fmtSig(r.rmse, 3)
                 + ' psi; rates in ' + r.rateUnit + '.'
        }, [], last.t.slice(), last.p.slice(), r.q.slice()).then(function () {
            _say(container, 'prism_inv_msg', '<span style="color:' + TV.green + ';">Saved as an analysis set ('
                + last.t.length + ' points) — see "Gauges &amp; analysis datasets" on the Data step.</span>');
        }).catch(function (e) {
            _say(container, 'prism_inv_msg', '<span style="color:' + TV.red + ';">Could not save: ' + _esc(e && e.message) + '</span>');
        });
    } else {
        _say(container, 'prism_inv_msg', '<span style="color:' + TV.yellow + ';">Analysis-set storage is not available in this build.</span>');
    }
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', 'prism_inverse_sim_save', { model: String(last.modelKey || '') }); }
        catch (e) { /* swallow */ }
    }
}

// Draw a single (t, y) series — optionally with a model overlay.
function _drawInvSeries(canvas, t, y, overlay, kind, ylabel) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var T = _theme();
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
    var pad = { top: 22, right: 20, bottom: 32, left: 64 };
    var plotX = pad.left, plotY = pad.top;
    var plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
    if (!t || !y || !t.length || !y.length) {
        ctx.fillStyle = T.text3;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('No data', w / 2, h / 2);
        return;
    }
    var tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (var i = 0; i < t.length; i++) {
        if (_isNum(t[i])) { if (t[i] < tMin) tMin = t[i]; if (t[i] > tMax) tMax = t[i]; }
        if (_isNum(y[i])) { if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i]; }
    }
    if (overlay && overlay.length) {
        for (var j = 0; j < overlay.length; j++) {
            if (_isNum(overlay[j])) { if (overlay[j] < yMin) yMin = overlay[j]; if (overlay[j] > yMax) yMax = overlay[j]; }
        }
    }
    if (!isFinite(tMin) || tMin >= tMax) { tMin = 0; tMax = 1; }
    if (!isFinite(yMin) || yMin >= yMax) { yMin = (isFinite(yMin) ? yMin : 0) - 1; yMax = (isFinite(yMax) ? yMax : 0) + 1; }
    var span = yMax - yMin;
    yMin -= 0.05 * span; yMax += 0.05 * span;
    function xMap(tv) { return plotX + plotW * (tv - tMin) / (tMax - tMin); }
    function yMap(yv) { return plotY + plotH * (1 - (yv - yMin) / (yMax - yMin)); }
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
        var yp = plotY + plotH * g / 4;
        ctx.beginPath(); ctx.moveTo(plotX, yp); ctx.lineTo(plotX + plotW, yp); ctx.stroke();
        ctx.fillText(_fmtSig(yMax - g * (yMax - yMin) / 4, 4), plotX - 6, yp);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var x = 0; x <= 5; x++) {
        var tv2 = tMin + (x / 5) * (tMax - tMin);
        var xp = xMap(tv2);
        ctx.beginPath(); ctx.moveTo(xp, plotY); ctx.lineTo(xp, plotY + plotH); ctx.stroke();
        ctx.fillText(_fmtSig(tv2, 3), xp, plotY + plotH + 4);
    }
    ctx.fillStyle = T.text;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('time (h)', plotX + plotW / 2, h - 4);
    ctx.save();
    ctx.translate(12, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(ylabel, 0, 0);
    ctx.restore();
    var color = (kind === 'pressure') ? T.blue : T.accent;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var started = false;
    for (var k = 0; k < t.length; k++) {
        if (!_isNum(t[k]) || !_isNum(y[k])) continue;
        if (!started) { ctx.moveTo(xMap(t[k]), yMap(y[k])); started = true; }
        else ctx.lineTo(xMap(t[k]), yMap(y[k]));
    }
    ctx.stroke();
    ctx.fillStyle = color;
    for (var m = 0; m < t.length; m++) {
        if (!_isNum(t[m]) || !_isNum(y[m])) continue;
        ctx.beginPath();
        ctx.arc(xMap(t[m]), yMap(y[m]), 1.6, 0, 2 * Math.PI);
        ctx.fill();
    }
    if (overlay && overlay.length) {
        ctx.strokeStyle = T.green;
        ctx.lineWidth = 1.2;
        if (ctx.setLineDash) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        var started2 = false;
        for (var ov = 0; ov < overlay.length; ov++) {
            if (!_isNum(t[ov]) || !_isNum(overlay[ov])) continue;
            if (!started2) { ctx.moveTo(xMap(t[ov]), yMap(overlay[ov])); started2 = true; }
            else ctx.lineTo(xMap(t[ov]), yMap(overlay[ov]));
        }
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
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
// SECTION 6B — Tab 6 panel "PLT & inverse simulation" (C7)
// ════════════════════════════════════════════════════════════════════

G.PRiSM_renderPLTInversePanel = function PRiSM_renderPLTInversePanel(container, opts) {
    if (!_hasDoc || !container) return;
    opts = opts || {};
    container.innerHTML =
          '<div class="prism-pltinv" style="max-width:100%; box-sizing:border-box; color:' + TV.text + '; font-size:12px;'
        +   (opts.embedded ? '' : ' background:' + TV.panel + '; border:1px solid ' + TV.border + '; border-radius:6px; padding:12px;') + '">'
        +   (opts.embedded ? '' : '<div style="font-weight:700; font-size:14px; margin-bottom:6px;">PLT &amp; inverse simulation</div>')
        +   '<div style="color:' + TV.text2 + '; margin-bottom:10px; line-height:1.5;">Uses the current fit: the rate split between '
        +     'layers of a multi-layer model, and the rate history implied by the pressures. Results are in field units when the '
        +     'well inputs are complete and the fit gives a permeability.</div>'
        +   '<div class="prism-plt-host"></div>'
        +   '<div class="prism-inv-host" style="margin-top:16px; padding-top:12px; border-top:1px solid ' + TV.border + ';"></div>'
        + '</div>';
    G.PRiSM_renderPLTPanel(container.querySelector('.prism-plt-host'), { embedded: true });
    G.PRiSM_renderInverseSimPanel(container.querySelector('.prism-inv-host'), { embedded: true });
};

_registerPanel(6, {
    id: 'prism_plt_inverse',
    title: 'PLT & inverse simulation',
    order: 80,
    collapsed: true,
    tool: true,
    description: 'Layer rate split from a multi-layer fit; rate history recovered from pressure',
    render: function (hostEl) { G.PRiSM_renderPLTInversePanel(hostEl, { embedded: true }); }
});


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
            var tArr = [];
            for (var il = 0; il < 30; il++) tArr.push(Math.pow(10, -2 + 5 * il / 29));
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
            // Reference = the known initial pressure (never the first sample).
            var inv = G.PRiSM_inverseSim('homogeneous', paramsH, tArr, pSeries, { pRef: pInit, tStart: 0 });
            _check('Test 3: reference pressure is the given pi', inv.pRef === pInit && inv.pRefSource === 'given');
            _check('Test 3: inverse sim converged', inv.converged);
            _check('Test 3: inverse sim produced same-length q',
                inv.q.length === tArr.length,
                'q.length=' + inv.q.length + ' vs t.length=' + tArr.length);
            // Mean recovered q over every sample (the backward-rate form has
            // no unconstrained end points).
            var totalQ = 0, count = 0;
            for (var jq = 0; jq < tArr.length; jq++) {
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
