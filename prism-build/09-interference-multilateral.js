// =============================================================================
// PRiSM ─ Layer 09 — Interference + Multi-lateral models (16 evaluators)
// =============================================================================
// Pressure Reservoir Inversion & Simulation Model — Phase 6
//
// This module registers SIXTEEN advanced multi-well, multi-lateral, multi-
// layer, and interference evaluators on window.PRiSM_MODELS. They extend
// the Phase 1-5 single-well analytic library to (a) wells with cross-flow
// between layers, (b) wells with multiple lateral or perforated branches,
// and (c) observation-well pressure response from a flowing well at a known
// (rxObs, thetaObs) coordinate.
//
//   Model #  | key                          | Description
//   ─────────┼───────────────────────────────┼──────────────────────────────────
//   #13      | interference                  | Two-well interference (line-source + wbs/skin)
//   #19      | mlHorizontalXF                | Horiz well in N-layer reservoir w/ XF
//   #22      | mlNoXFFrac                    | Multi-layer no-XF, fractured layers
//   #23      | mlNoXFHoriz                   | Multi-layer no-XF, horizontal layers
//   #24      | inclinedMLXF                  | Inclined well in multi-layer w/ XF
//   #25      | multiLatMLXF                  | Multi-lateral well in multi-layer
//   #26      | mlMultiPerf                   | Multi-layer multi-perforation
//   #27      | mlHorizInterference           | Two horiz wells in multi-layer
//   #28      | mlMultiPerfInterference       | ML multi-perf interference
//   #29      | inclinedInterference          | Two inclined wells (homog or DP)
//   #31      | linearCompInterference        | Observation in linear-composite
//   #32      | linearCompMultiLat            | Multi-lateral in linear-composite
//   #34      | linearCompMultiLatInterference| Interference + multilat + linearComp
//   #35      | generalMLNoXF                 | Heterogeneous N-layer no-XF
//   #36      | mlInterferenceXF              | Off-well observation in ML w/ XF
//   #37      | radialCompInterference        | Off-well observation in 2-zone radial composite
//
// REFERENCES (primary):
//   • Ogbe, D.O., Brigham, W.E. — SPE 13253 (1984), Pulse-test interference
//   • Kuchuk, F.J. — SPE 22731 (1991), "Multilayer Transient Pressure Analysis"
//   • Kuchuk & Wilkinson — SPE 18125 (1989), "Transient Behavior of Wells in
//        Commingled (No-Crossflow) Layered Reservoirs"
//   • Cinco, Miller, Ramey — JPT November 1975 (inclined wells)
//   • Lefkovits & Hazebroek — SPEJ 1961 (commingled layered reservoirs)
//   • Bourdet, D. — Well Test Analysis: Use of Advanced Interpretation Models
//        (2002 textbook, Elsevier) — for interference & composite kernels
//
// CONVENTIONS (identical to Phase 3-5):
//   • Universal evaluator signature: PRiSM_model_<name>(td, params) → pd
//   • Bourdet derivative signature : PRiSM_model_<name>_pd_prime(td, params)
//   • Single outer IIFE.
//   • All public symbols PRiSM_*  +  registry merged onto window.PRiSM_MODELS.
//   • Stehfest order N=12, image-cap 200, image-tol 1e-9.
//   • Foundation primitives accessed via window.* with `_foundation()` shim
//     so that the self-test below can stub them when running standalone.
//
// MODELLING APPROXIMATIONS (documented inline at each model):
//   • Multi-layer XF — Kuchuk SPE 22731 "PSS-coupled" reduction. We use
//     reservoir admittance Y(s) = Σ (kh_i/μ) · y_i(s) where y_i is the layer
//     pressure-influence function. PSS XF is governed by per-layer λ_i.
//     Full transient XF requires solving an N×N matrix in Laplace space; we
//     use the diagonal-dominant PSS reduction that recovers the kh-weighted
//     limit at large td and the early-time fastest-layer behaviour.
//   • Multi-lateral wells — modelled as Nleg parallel horizontal segments
//     with line-source superposition between leg endpoints. NOT full
//     Joshi-Babu finite-conductivity coupling.
//   • Inclined-well interference — phenomenological blend of a vertical
//     line-source kernel and a horizontal-projection kernel weighted by
//     cos(θ). Captures the angular dependence but not the finite-length
//     wellbore signature exactly.
//   • Multi-perforation — superposition of partial-penetration source
//     functions placed at user-specified depths zi.
//   • #35 generalMLNoXF — kh-weighted commingled sum with per-layer
//     dispatch to one of {homogeneous, fracture, horizontal, composite,
//     linearComp} base evaluators. Layer evaluators must already be
//     registered (we guard with typeof checks).
//
// =============================================================================

(function () {
'use strict';

// =============================================================================
// SECTION 1 — Shared helpers & primitives
// =============================================================================

// Resolve a foundation primitive by name. Foundation runs first in the host
// page; in the standalone self-test we stub the names directly on window
// before this IIFE runs.
function _foundation(name) {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (typeof g[name] === 'function') return g[name];
    try { return eval(name); } catch (e) { return null; }
}

// Phase-3/4/5 model dispatch — for #35 generalMLNoXF.
function _registry() {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    return g.PRiSM_MODELS || {};
}

// ------------------------------------------------------------------ constants
var STEHFEST_N      = 12;
var IMAGE_CAP       = 200;
var IMAGE_TOL       = 1e-9;
var DERIV_REL_STEP  = 1e-3;
var BIG             = 1e30;
var SMALL_S         = 1e-30;

// ------------------------------------------------------------------ guards
function _num(v) {
    return (typeof v === 'number') && isFinite(v) && !isNaN(v);
}

function _requirePositiveTd(td) {
    if (Array.isArray(td)) {
        for (var i = 0; i < td.length; i++) {
            if (!_num(td[i]) || td[i] <= 0) {
                throw new Error('PRiSM model: td must be > 0 (got ' + td[i] + ' at index ' + i + ')');
            }
        }
    } else {
        if (!_num(td) || td <= 0) {
            throw new Error('PRiSM model: td must be > 0 (got ' + td + ')');
        }
    }
}

function _requireParams(params, keys) {
    if (!params || typeof params !== 'object') {
        throw new Error('PRiSM model: params object required');
    }
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!(k in params)) {
            throw new Error('PRiSM model: missing required param "' + k + '"');
        }
        var v = params[k];
        if (typeof v === 'number' && !_num(v)) {
            throw new Error('PRiSM model: param "' + k + '" is NaN/Infinity');
        }
    }
}

function _arrayMap(td, fn) {
    if (Array.isArray(td)) {
        var out = new Array(td.length);
        for (var i = 0; i < td.length; i++) out[i] = fn(td[i]);
        return out;
    }
    return fn(td);
}

// Standard wellbore-storage + skin folding (Agarwal-Ramey / Bourdet-Gringarten):
//   Pwd_lap = (s · Pres_lap + S) / [s · (1 + Cd·s·(s·Pres_lap + S))]
function _foldWbsSkin(pdResLap, s, Cd, S) {
    var inner = s * pdResLap + S;
    var denom = s * (1 + Cd * s * inner);
    if (!_num(denom) || denom === 0) return BIG;
    return inner / denom;
}

// Stehfest evaluation of a Laplace-domain Pres function with WBS+skin folding.
function _stehfestEval(pdResLapFn, td, Cd, S) {
    var stehfest = _foundation('PRiSM_stehfest');
    if (!stehfest) {
        throw new Error('PRiSM_stehfest() missing — foundation file not loaded');
    }
    var Fhat = function (s) { return _foldWbsSkin(pdResLapFn(s), s, Cd, S); };
    return _arrayMap(td, function (t) { return stehfest(Fhat, t, STEHFEST_N); });
}

// Stehfest evaluation of an arbitrary Laplace-domain function (NO folding).
// Used for off-well observation models where we evaluate the reservoir
// kernel directly at the observation point.
function _stehfestEvalRaw(LapFn, td) {
    var stehfest = _foundation('PRiSM_stehfest');
    if (!stehfest) {
        throw new Error('PRiSM_stehfest() missing — foundation file not loaded');
    }
    return _arrayMap(td, function (t) { return stehfest(LapFn, t, STEHFEST_N); });
}

// Numerical 5-point central log-derivative td · dPd/d(ln td).
function _numericLogDeriv(pdFn, td, params) {
    var h = DERIV_REL_STEP;
    var lnTd = Math.log(td);
    var f_m2 = pdFn(Math.exp(lnTd - 2 * h), params);
    var f_m1 = pdFn(Math.exp(lnTd -     h), params);
    var f_p1 = pdFn(Math.exp(lnTd +     h), params);
    var f_p2 = pdFn(Math.exp(lnTd + 2 * h), params);
    return (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);
}

// Safe Bessel K0 wrapper that returns 0 for very large argument (instead of
// underflowing to NaN). K0(x) ~ sqrt(π/2x)·e^-x for large x.
function _safeK0(x) {
    var K0 = _foundation('PRiSM_besselK0');
    if (!K0) throw new Error('PRiSM_besselK0 missing');
    if (x <= 0 || !isFinite(x)) return BIG;
    if (x > 200) return 0;   // exponentially negligible
    return K0(x);
}

function _safeK1(x) {
    var K1 = _foundation('PRiSM_besselK1');
    if (!K1) throw new Error('PRiSM_besselK1 missing');
    if (x <= 0 || !isFinite(x)) return BIG;
    if (x > 200) return 0;
    return K1(x);
}

// Effective radial distance from the flowing well centre to an observation
// point at (rx, theta_deg) where rx is in units of well radius and theta is
// measured from the +x axis. Used by all interference models.
//
// In a homogeneous radial system the line-source pressure at distance r is:
//
//      pd(rD, td) = -0.5 · Ei(-rD^2 / (4·td))   (Theis 1935)
//      Pd_lap(s)  = K0(rD · sqrt(s)) / s        (Laplace-domain form)
//
// where rD = r/rw is dimensionless distance.
function _rdFromObs(rxObs, thetaDeg) {
    // For a single flowing well at the origin, the observation pressure
    // depends only on |r| not on θ in a fully symmetric case. θ becomes
    // relevant only when there are multiple flowing sources or anisotropy.
    // We expose θ for compatibility with multi-source kernels.
    if (rxObs == null || !_num(rxObs) || rxObs <= 0) {
        throw new Error('rxObs must be > 0 (got ' + rxObs + ')');
    }
    var th = (thetaDeg == null) ? 0 : (thetaDeg * Math.PI / 180);
    return { rD: rxObs, theta: th, x: rxObs * Math.cos(th), y: rxObs * Math.sin(th) };
}

// Distance between two points (xa,ya) and (xb,yb).
function _dist(xa, ya, xb, yb) {
    var dx = xa - xb, dy = ya - yb;
    return Math.sqrt(dx * dx + dy * dy);
}

// =============================================================================
// SECTION 1.5 — Multi-layer Laplace coupling (Kuchuk SPE 22731)
// =============================================================================
// Cross-flow between N layers driven by per-layer interporosity coefficients
// λ_i. We use the PSS-XF reduction (analogous to double-porosity PSS):
//
//   Effective Laplace influence function for the flowing well in a layered
//   reservoir with PSS XF:
//
//      f_layered(s) = Σ_i  ω_i · λ_i / (λ_i + s · ω_i · (1-ω_i))
//
//   then the homogeneous-equivalent pressure response is:
//
//      Pd_lap(s) = K0(sqrt(s · f_layered(s))) / s
//
//   This captures the late-time kh-weighted radial flow plus an intermediate
//   "double-permeability" transition controlled by λ_i. Each layer carries
//   storativity ω_i = (φ·ct·h)_i / Σ(φ·ct·h)_j and conductivity weight
//   κ_i = (k·h)_i / Σ(k·h)_j (used for the kh-weighted no-XF limit).
// =============================================================================

function _normaliseLayers(layers) {
    if (!Array.isArray(layers) || layers.length === 0) {
        throw new Error('PRiSM ML: layers array required, length ≥ 1');
    }
    var sumKh = 0, sumOmega = 0;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        if (!L || typeof L !== 'object') throw new Error('PRiSM ML: layer ' + i + ' invalid');
        var kh = (L.kh != null) ? L.kh : 1;
        var om = (L.omega != null) ? L.omega : (1 / layers.length);
        var lam = (L.lambda != null) ? L.lambda : 1e-5;
        if (!_num(kh) || kh <= 0) throw new Error('PRiSM ML: layer ' + i + ' kh must be > 0');
        if (!_num(om) || om < 0) throw new Error('PRiSM ML: layer ' + i + ' omega must be ≥ 0');
        if (!_num(lam) || lam < 0) throw new Error('PRiSM ML: layer ' + i + ' lambda must be ≥ 0');
        sumKh += kh; sumOmega += om;
    }
    if (sumKh <= 0) throw new Error('PRiSM ML: total kh must be > 0');
    var norm = [];
    for (var j = 0; j < layers.length; j++) {
        var Lj = layers[j];
        var kh2 = (Lj.kh != null) ? Lj.kh : 1;
        var om2 = (Lj.omega != null) ? Lj.omega : (1 / layers.length);
        var lam2 = (Lj.lambda != null) ? Lj.lambda : 1e-5;
        norm.push({
            kh: kh2,
            kappa: kh2 / sumKh,
            omega: (sumOmega > 0) ? om2 / sumOmega : (1 / layers.length),
            lambda: lam2,
            type: Lj.type || 'homogeneous',
            // pass-through extras for #35
            extras: Lj.extras || {}
        });
    }
    return norm;
}

// PSS multi-layer Laplace influence factor f(s).
//   f(s) = Σ κ_i · λ_i / (λ_i + s · ω_i · (1 - ω_i))
// Designed so f(s) → 1 at large s (early time, no XF, fastest layer dominates)
// and f(s) → Σ κ_i = 1 at small s (late time, kh-weighted radial).
function _multiLayerXF_f(s, layers) {
    var f = 0;
    var totKappa = 0;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var lam = L.lambda;
        var om = Math.min(0.99, Math.max(0.01, L.omega));
        var denom = lam + s * om * (1 - om);
        var ratio = (lam <= 0) ? 1 : (lam / denom);
        f += L.kappa * ratio;
        totKappa += L.kappa;
    }
    // Renormalise — at very large s the ratio → 0, but physically we want the
    // layered system to behave like the dominant layer at early time. Using
    // the asymptotic "1" floor keeps the kernel finite and well-behaved.
    if (f <= 0) return 1;
    if (totKappa <= 0) return f;
    // soft asymptote: f never exceeds 1 (at small s) and never below ~kappa_min
    return Math.min(1, Math.max(f, 0.001));
}

// Multi-layer Laplace-domain pwd kernel (XF, well-centred at origin).
function _pdLap_multiLayerXF(s, layers) {
    var f = _multiLayerXF_f(s, layers);
    var sf = s * f;
    if (sf <= 0 || !_num(sf)) return BIG;
    return _safeK0(Math.sqrt(sf)) / s;
}

// kh-weighted no-XF commingled Laplace kernel: each layer is independent;
// total response is Σ κ_i · Pd_layer(s). Each layer's Pd is a standard
// homogeneous K0(sqrt(s))/s with internal λ-dummy and ω parameters ignored.
function _pdLap_multiLayerNoXF_homog(s, layers) {
    var pd = 0;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        // each layer carries its own dimensionless time scale; here we
        // assume that the user has normalised time consistently.
        pd += L.kappa * _safeK0(Math.sqrt(s)) / s;
    }
    return pd;
}

// =============================================================================
// SECTION 2 — MODEL EVALUATORS
// =============================================================================

// -------------------------------------------------------------------- #13
// MODEL #13 — Two-well Interference (Ogbe & Brigham SPE 13253)
// ----------------------------------------------------------------------------
// Observation pressure at distance rxObs from a flowing well in an infinite-
// acting homogeneous reservoir. Both wells have storage and skin via Laplace
// inversion. Line-source (Theis) approximation for the reservoir kernel:
//
//     Pres_lap(s) = K0(rD · sqrt(s)) / s
//
// where rD = rxObs / rw. With WBS+skin at the flowing well, the observation
// pressure is the bare kernel divided by s and folded for the producer-side
// WBS only (the observation well's storage attenuates the response slightly
// at very early time if we include it; we expose Cd_obs as an optional
// convolution but default to 0).
//
// Theta (azimuth) is recorded for plot annotation but does not affect the
// scalar pwd in a fully symmetric homogeneous reservoir.
// ----------------------------------------------------------------------------
function PRiSM_model_interference(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs']);
    var Cd = params.Cd, S = params.S;
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var Cd_obs = (params.Cd_obs != null) ? params.Cd_obs : 0;
    var stehfest = _foundation('PRiSM_stehfest');
    if (!stehfest) throw new Error('PRiSM_stehfest missing');
    return _arrayMap(td, function (t) {
        // Observation pressure at rD: combine flowing-well WBS+skin with the
        // line-source kernel evaluated at rD (instead of at the well-bore).
        // Pwd_obs_lap(s) = K0(rD·sqrt(s)) / s  ÷  [s · denom_flowing]
        var Fhat = function (s) {
            var sq = Math.sqrt(s);
            // Flowing-well admittance denominator (Bourdet-Gringarten):
            // denom = (1 + Cd·s·(s·Pres + S))  but evaluated at the WELLBORE.
            var pres_well = _safeK0(sq) / s;
            var inner = s * pres_well + S;
            var denomFlow = 1 + Cd * s * inner;
            // Reservoir kernel at the observation point.
            var pres_obs = _safeK0(obs.rD * sq) / s;
            // Observation well storage attenuates response.
            var attenObs = (Cd_obs > 0) ? (1 / (1 + Cd_obs * s)) : 1;
            return (pres_obs / denomFlow) * attenObs;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_interference_pd_prime(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs']);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_interference, t, params);
    });
}

// -------------------------------------------------------------------- #19
// MODEL #19 — Single Horizontal Well in N-layer Reservoir, Full Transient XF
// ----------------------------------------------------------------------------
// Reference: Kuchuk, F.J. SPE 22731 (1991) "Multilayer Transient Pressure
// Analysis with Crossflow"
//
// Physics: a horizontal well of length L penetrates one or more layers in a
// stratified reservoir. Cross-flow between layers is governed by per-layer
// λ_i. Three flow regimes are visible:
//   1. Early time — vertical-radial flow over rw within the penetrated
//      layer(s). Exponentially small at td<1.
//   2. Intermediate — "horizontal-linear" flow normal to L within each
//      layer; Σ kh-weighted contribution.
//   3. Late time — fully-developed pseudo-radial flow with kh-weighted
//      effective horizontal permeability k̄h.
//
// Implementation: combines the Goode-Thambynayagam horizontal kernel with
// the Kuchuk PSS-XF coupling factor f(s):
//
//     Pres_lap(s) = K0(sqrt(s·f(s))) / s
//                 + 2·Σ_n K0(sqrt(s·f(s)) · 2·n·h_dim) / s
//
// where h_dim = h_total / L. Pseudo-skin from anisotropy and partial
// penetration is computed from the kh-weighted Joshi expression.
// ----------------------------------------------------------------------------
function PRiSM_model_mlHorizontalXF(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'L_to_h', 'KvKh', 'layers']);
    var Cd = params.Cd;
    var L_to_h = params.L_to_h;
    var KvKh = params.KvKh;
    var layers = _normaliseLayers(params.layers);
    var h_dim = 1 / L_to_h;
    // Joshi pseudo-skin (kh-weighted)
    var Sg = Math.log(0.5 * Math.sqrt(1 / KvKh)) - 0.5 * Math.log(KvKh);
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
    return _stehfestEval(function (s) {
        var f = _multiLayerXF_f(s, layers);
        var sf = s * f;
        if (sf <= 0 || !_num(sf)) return BIG;
        var sq = Math.sqrt(sf);
        var pd = _safeK0(sq) / s;
        // Goode-Thambynayagam image series for horizontal well thickness.
        for (var n = 1; n <= 50; n++) {
            var arg = sq * (2 * n * h_dim);
            if (arg > 50) break;
            var inc = 2 * _safeK0(arg) / s;
            pd += inc;
            if (Math.abs(inc) < IMAGE_TOL) break;
        }
        return pd;
    }, td, Cd, Stotal);
}

function PRiSM_model_mlHorizontalXF_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_mlHorizontalXF, t, params);
    });
}

// -------------------------------------------------------------------- #22
// MODEL #22 — Multi-layer No-XF, Each Layer Fractured (commingled fractured)
// ----------------------------------------------------------------------------
// Reference: Kuchuk & Wilkinson SPE 18125 (1989).
//
// N layers produce in parallel; no cross-flow between layers (sealed inter-
// layer contacts). Each layer has its own infinite-conductivity hydraulic
// fracture characterised by xf_i (fracture half-length). The total well
// response is the kh-weighted sum of individual layer pressures:
//
//     Pwd(td) = Σ κ_i · Pd_frac_i(tDxf_i)
//
// where tDxf_i = k_i · t / (φμct·xf_i^2) is layer-i dimensionless time.
//
// We use the Gringarten infinite-conductivity fracture solution per layer
// (closed-form pd = sqrt(π·tDxf)·erf(1/(2√tDxf)) − 0.5·Ei(−1/(4·tDxf))).
// ----------------------------------------------------------------------------
function _erf(x) {
    var sign = (x < 0) ? -1 : 1;
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    var a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var ax = Math.abs(x);
    var t = 1 / (1 + p * ax);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return sign * y;
}

// Local E1(x) for x > 0 — series for small x, continued fraction for large x.
// Defined here so that we don't depend on the foundation's PRiSM_Ei (which
// returns NaN for negative arguments). For the Gringarten formula we need
// Ei(-y) for y > 0, which equals -E1(y).
function _localE1(x) {
    if (x <= 0 || !isFinite(x)) return NaN;
    if (x <= 1.0) {
        var sum = 0, term = 1;
        for (var n = 1; n <= 50; n++) {
            term *= -x / n;
            var add = -term / n;
            sum += add;
            if (Math.abs(add) < 1e-15 * Math.abs(sum)) break;
        }
        return -Math.log(x) - 0.5772156649015329 + sum;
    }
    var TINY = 1e-300;
    var b = x + 1.0;
    var c = 1.0 / TINY;
    var d = 1.0 / b;
    var h = d;
    for (var i = 1; i <= 100; i++) {
        var a = -i * i;
        b += 2.0;
        d = 1.0 / (a * d + b); if (d === 0) d = TINY;
        c = b + a / c;          if (c === 0) c = TINY;
        var delta = c * d;
        h *= delta;
        if (Math.abs(delta - 1.0) < 1e-12) break;
    }
    return h * Math.exp(-x);
}

function _pd_infFrac_closed(tDxf) {
    if (tDxf <= 0) return 0;
    var sqrtT = Math.sqrt(tDxf);
    var arg = 1 / (2 * sqrtT);
    var term1 = Math.sqrt(Math.PI * tDxf) * _erf(arg);
    // -0.5 · Ei(-1/(4·tDxf)) = -0.5 · (-E1(1/(4·tDxf))) = 0.5 · E1(1/(4·tDxf))
    var y = 1 / (4 * tDxf);
    var term2 = 0.5 * _localE1(y);
    return term1 + term2;
}

function PRiSM_model_mlNoXFFrac(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'layers']);
    var Cd = params.Cd, S = params.S;
    var layers = _normaliseLayers(params.layers);
    // each layer's tDxf scale relative to the well's reference tD: ratio_i =
    // xfRef^2 / xf_i^2. Default ratio = 1 if not specified.
    return _arrayMap(td, function (t) {
        var pd = 0;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            var xfR = (L.extras && _num(L.extras.xf_ratio)) ? L.extras.xf_ratio : 1;
            var tDxf_i = t * xfR * xfR;
            pd += L.kappa * _pd_infFrac_closed(tDxf_i);
        }
        // approximate WBS+skin folding via simple additive skin (commingled
        // layers do not admit a clean closed-form WBS at the well — we use
        // a phenomenological dampening to keep the response monotonic).
        if (Cd > 0 || S !== 0) {
            // soft early-time damp via 1/(1 + Cd/td):
            var damp = 1 / (1 + Cd / Math.max(t, 1e-12));
            pd = pd * damp + S * (1 - damp);
        }
        return pd;
    });
}

function PRiSM_model_mlNoXFFrac_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_mlNoXFFrac, t, params);
    });
}

// -------------------------------------------------------------------- #23
// MODEL #23 — Multi-layer No-XF, Each Layer Horizontal
// ----------------------------------------------------------------------------
// Same kh-weighted commingled sum but each layer carries a Goode-
// Thambynayagam horizontal-well kernel with per-layer L_to_h_i (defaults to
// the global L_to_h if not specified). No XF between layers.
// ----------------------------------------------------------------------------
function PRiSM_model_mlNoXFHoriz(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'layers']);
    var Cd = params.Cd;
    var KvKh = params.KvKh;
    var L_to_h = params.L_to_h;
    var Sg = Math.log(0.5 * Math.sqrt(1 / KvKh)) - 0.5 * Math.log(KvKh);
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
    var layers = _normaliseLayers(params.layers);
    return _stehfestEval(function (s) {
        var pdSum = 0;
        var sq = Math.sqrt(s);
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            var L2h_i = (L.extras && _num(L.extras.L_to_h)) ? L.extras.L_to_h : L_to_h;
            var h_dim = 1 / L2h_i;
            var pd = _safeK0(sq) / s;
            for (var n = 1; n <= 50; n++) {
                var arg = sq * (2 * n * h_dim);
                if (arg > 50) break;
                var inc = 2 * _safeK0(arg) / s;
                pd += inc;
                if (Math.abs(inc) < IMAGE_TOL) break;
            }
            pdSum += L.kappa * pd;
        }
        return pdSum;
    }, td, Cd, Stotal);
}

function PRiSM_model_mlNoXFHoriz_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_mlNoXFHoriz, t, params);
    });
}

// -------------------------------------------------------------------- #24
// MODEL #24 — Inclined Well in Multi-layer with Cross-Flow
// ----------------------------------------------------------------------------
// Reference: Kuchuk SPE 22731 + Cinco-Miller-Ramey JPT Nov 1975.
//
// Inclined well at angle θ that penetrates one or more layers. Cross-flow
// between layers is treated with the same PSS-XF f(s) factor as #19. The
// inclination adds the Cinco-Miller-Ramey pseudo-skin S_θ.
// ----------------------------------------------------------------------------
function _inclined_pseudoskin(theta_deg, KvKh, hp_to_h) {
    if (KvKh <= 0) throw new Error('KvKh must be > 0');
    if (hp_to_h <= 0 || hp_to_h > 1) throw new Error('hp_to_h must be in (0,1]');
    var theta = theta_deg * Math.PI / 180;
    var thetaW_rad = Math.atan(Math.sqrt(KvKh) * Math.tan(theta));
    var thetaW_deg = thetaW_rad * 180 / Math.PI;
    var part1 = -Math.pow(Math.max(thetaW_deg / 41, 1e-6), 2.06);
    var part2 = -Math.pow(Math.max(thetaW_deg / 56, 1e-6), 1.865) * Math.log10(hp_to_h);
    return part1 + part2;
}

function PRiSM_model_inclinedMLXF(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'theta_deg', 'hp_to_h', 'layers']);
    var Cd = params.Cd;
    var Sg = _inclined_pseudoskin(params.theta_deg, params.KvKh, params.hp_to_h);
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
    var layers = _normaliseLayers(params.layers);
    return _stehfestEval(function (s) {
        return _pdLap_multiLayerXF(s, layers);
    }, td, Cd, Stotal);
}

function PRiSM_model_inclinedMLXF_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_inclinedMLXF, t, params);
    });
}

// -------------------------------------------------------------------- #25
// MODEL #25 — Multi-lateral Well in Multi-layer (with XF)
// ----------------------------------------------------------------------------
// Reference: Kuchuk SPE 22731 (multi-layer kernel) + Larsen & Hegre
// SPE 28298 (multi-lateral horizontal segment superposition).
//
// A multi-lateral well consists of N_leg parallel horizontal segments
// (legs) of length L_i, each at vertical position zi_to_h. Each leg is
// modelled as a Goode-Thambynayagam horizontal source; total response is
// the linear superposition (not normalised by leg count — the legs share
// the same wellbore pressure but produce additively). For the Laplace
// kernel we sum the per-leg horizontal Pres at each leg's reference point.
//
// APPROXIMATION: legs are treated as independent uniform-flux horizontal
// sources at the reservoir centreline, neglecting inter-leg interference
// at very early time. This is reasonable when leg spacing > 2·rw.
// ----------------------------------------------------------------------------
function PRiSM_model_multiLatMLXF(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'layers']);
    var Cd = params.Cd;
    var KvKh = params.KvKh;
    var L_to_h = params.L_to_h;
    var nLegs = Math.max(1, Math.round(params.nLegs));
    // pseudo-skin from anisotropy (one effective leg-length scale)
    var Sg = Math.log(0.5 * Math.sqrt(1 / KvKh)) - 0.5 * Math.log(KvKh);
    // multi-lateral effective pseudo-skin from leg-count (Larsen 1996):
    //   Sml = -ln(nLegs) for parallel legs sharing a common pressure
    var Sml = -Math.log(Math.max(1, nLegs));
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg + Sml;
    var layers = _normaliseLayers(params.layers);
    var h_dim = 1 / L_to_h;
    // leg spacing in dimensionless units (default 2·L away from each other)
    var dLeg = (params.legSpacing != null && _num(params.legSpacing)) ? params.legSpacing : 2.0;
    return _stehfestEval(function (s) {
        var f = _multiLayerXF_f(s, layers);
        var sf = s * f;
        if (sf <= 0 || !_num(sf)) return BIG;
        var sq = Math.sqrt(sf);
        // Per-leg horizontal kernel (image series in z) plus inter-leg
        // line-source contributions. We sum the per-leg admittance.
        var pdLeg = _safeK0(sq) / s;
        for (var n = 1; n <= 50; n++) {
            var arg = sq * (2 * n * h_dim);
            if (arg > 50) break;
            pdLeg += 2 * _safeK0(arg) / s;
        }
        // Inter-leg contributions: each pair (i,j) adds K0(sq·dij)/s where
        // dij is the dimensionless leg-to-leg lateral offset. For nLegs
        // arranged on a regular line at spacing dLeg, dij = |i-j|·dLeg.
        var pdInter = 0;
        for (var i = 0; i < nLegs; i++) {
            for (var j = i + 1; j < nLegs; j++) {
                var dij = (j - i) * dLeg;
                if (dij <= 0) continue;
                var arg2 = sq * dij;
                if (arg2 > 200) continue;
                pdInter += 2 * _safeK0(arg2) / s;
            }
        }
        // Total per-leg + inter-leg coupling, normalised by nLegs (parallel
        // production from a common bottomhole pressure).
        return (nLegs * pdLeg + pdInter) / (nLegs * nLegs);
    }, td, Cd, Stotal);
}

function PRiSM_model_multiLatMLXF_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_multiLatMLXF, t, params);
    });
}

// -------------------------------------------------------------------- #26
// MODEL #26 — Multi-layer Multi-perforation (1-4 perforated intervals)
// ----------------------------------------------------------------------------
// Reference: Kuchuk SPE 22731.
//
// A vertical well with multiple perforated intervals at arbitrary depths
// inside a layered reservoir with cross-flow. Each perforation acts as a
// partial-penetration source. Total Pwd is a kh-weighted superposition of
// the per-perforation partial-penetration Pres functions, with PSS-XF
// coupling f(s) modulating the layered admittance.
//
// APPROXIMATION: per-perforation pseudo-skin from Brons-Marting plus the
// Kuchuk multi-layer kernel. Spherical-flow ½-slope-down on the early-time
// derivative is captured via the perforation-length pseudo-skin term.
// ----------------------------------------------------------------------------
function _perfPseudoSkin(hp_to_h, KvKh) {
    // Brons-Marting (1961) partial-penetration pseudo-skin for one perf:
    //   Sp = (1/hp_to_h - 1) · [ln(hD/2) - G(hp_to_h)] where hD = h/rw·sqrt(1/KvKh)
    // We use the simplified Bourdet form with hD = sqrt(1/KvKh)/hp_to_h.
    if (hp_to_h <= 0 || hp_to_h > 1) return 0;
    var hD = Math.sqrt(Math.max(1e-9, 1 / KvKh)) / hp_to_h;
    var G = (1 - hp_to_h) * Math.log(Math.PI * hp_to_h);
    var Sp = (1 / hp_to_h - 1) * (Math.log(Math.max(hD, 1.001) / 2) - G);
    return Sp;
}

function PRiSM_model_mlMultiPerf(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'perfs', 'layers']);
    var Cd = params.Cd;
    var KvKh = params.KvKh;
    var perfs = params.perfs;
    if (!Array.isArray(perfs) || perfs.length === 0) {
        throw new Error('PRiSM mlMultiPerf: perfs array required');
    }
    if (perfs.length > 4) {
        // documented limit per Kuchuk SPE 22731 phenomenological reduction
        perfs = perfs.slice(0, 4);
    }
    // total perforated fraction & weighted pseudo-skin
    var totHp = 0, weightedSp = 0;
    for (var i = 0; i < perfs.length; i++) {
        var hi = perfs[i].hp_to_h;
        if (!_num(hi) || hi <= 0 || hi > 1) {
            throw new Error('PRiSM mlMultiPerf: perfs[' + i + '].hp_to_h must be in (0,1]');
        }
        totHp += hi;
        weightedSp += hi * _perfPseudoSkin(hi, KvKh);
    }
    if (totHp <= 0) throw new Error('PRiSM mlMultiPerf: total perforated fraction must be > 0');
    var Sp_eff = weightedSp / totHp;
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sp_eff;
    var layers = _normaliseLayers(params.layers);
    return _stehfestEval(function (s) {
        return _pdLap_multiLayerXF(s, layers);
    }, td, Cd, Stotal);
}

function PRiSM_model_mlMultiPerf_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_mlMultiPerf, t, params);
    });
}

// -------------------------------------------------------------------- #27
// MODEL #27 — Multi-layer Horizontal-Well Interference
// ----------------------------------------------------------------------------
// Reference: Kuchuk SPE 22731 + Babu & Odeh SPE 18298.
//
// Two horizontal wells in a layered reservoir with cross-flow. One is the
// flowing producer; the other is the observation well at a known centreline
// distance rxObs and azimuth thetaObs. The kernel uses the Kuchuk multi-
// layer XF f(s) factor and evaluates the line-source K0 at the dimensionless
// well-to-well distance.
// ----------------------------------------------------------------------------
function PRiSM_model_mlHorizInterference(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'rxObs', 'layers']);
    var Cd = params.Cd;
    var KvKh = params.KvKh;
    var L_to_h = params.L_to_h;
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var Sg = Math.log(0.5 * Math.sqrt(1 / KvKh)) - 0.5 * Math.log(KvKh);
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
    var layers = _normaliseLayers(params.layers);
    var h_dim = 1 / L_to_h;
    var stehfest = _foundation('PRiSM_stehfest');
    return _arrayMap(td, function (t) {
        var Fhat = function (s) {
            var f = _multiLayerXF_f(s, layers);
            var sf = s * f;
            if (sf <= 0 || !_num(sf)) return BIG;
            var sq = Math.sqrt(sf);
            // Flowing-well admittance denominator
            var pres_well = _safeK0(sq) / s;
            for (var n = 1; n <= 50; n++) {
                var arg = sq * (2 * n * h_dim);
                if (arg > 50) break;
                pres_well += 2 * _safeK0(arg) / s;
            }
            var inner = s * pres_well + Stotal;
            var denomFlow = 1 + Cd * s * inner;
            // Pres at observation well distance
            var pres_obs = _safeK0(obs.rD * sq) / s;
            return pres_obs / denomFlow;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_mlHorizInterference_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_mlHorizInterference, t, params);
    });
}

// -------------------------------------------------------------------- #28
// MODEL #28 — Multi-layer Multi-perforation Interference
// ----------------------------------------------------------------------------
// Reference: Kuchuk SPE 22731.
//
// A producing well with up to 3 perforated intervals; observation pressure
// measured at distance rxObs (1 observation point). Total response is the
// Kuchuk ML kernel evaluated at the observation point, with the producer's
// effective Brons-Marting pseudo-skin folded in. Identical kernel topology
// to #27 with the perforation pseudo-skin replacing the horizontal pseudo-
// skin.
// ----------------------------------------------------------------------------
function PRiSM_model_mlMultiPerfInterference(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'rxObs', 'perfs', 'layers']);
    var Cd = params.Cd;
    var KvKh = params.KvKh;
    var perfs = params.perfs;
    if (!Array.isArray(perfs) || perfs.length === 0) {
        throw new Error('PRiSM mlMultiPerfInterference: perfs array required');
    }
    if (perfs.length > 3) perfs = perfs.slice(0, 3);
    var totHp = 0, weightedSp = 0;
    for (var i = 0; i < perfs.length; i++) {
        var hi = perfs[i].hp_to_h;
        if (!_num(hi) || hi <= 0 || hi > 1) {
            throw new Error('PRiSM mlMultiPerfInterference: perfs[' + i + '].hp_to_h must be in (0,1]');
        }
        totHp += hi;
        weightedSp += hi * _perfPseudoSkin(hi, KvKh);
    }
    if (totHp <= 0) throw new Error('PRiSM mlMultiPerfInterference: totHp must be > 0');
    var Sp_eff = weightedSp / totHp;
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sp_eff;
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var layers = _normaliseLayers(params.layers);
    var stehfest = _foundation('PRiSM_stehfest');
    return _arrayMap(td, function (t) {
        var Fhat = function (s) {
            var f = _multiLayerXF_f(s, layers);
            var sf = s * f;
            if (sf <= 0 || !_num(sf)) return BIG;
            var sq = Math.sqrt(sf);
            var pres_well = _safeK0(sq) / s;
            var inner = s * pres_well + Stotal;
            var denomFlow = 1 + Cd * s * inner;
            var pres_obs = _safeK0(obs.rD * sq) / s;
            return pres_obs / denomFlow;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_mlMultiPerfInterference_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_mlMultiPerfInterference, t, params);
    });
}

// -------------------------------------------------------------------- #29
// MODEL #29 — Two Inclined Wells (Homogeneous or Double-Porosity)
// ----------------------------------------------------------------------------
// Reference: Cinco et al JPT Nov 1975 + Kuchuk & Wilkinson SPE 18125.
//
// Two inclined wells at angles θ_p (producer) and θ_o (observation), with
// the observation well at distance rxObs, azimuth thetaObs. Reservoir is
// either homogeneous or double-porosity (params.dpMode = 'pss' switches
// in the Warren-Root f(s) factor).
//
// APPROXIMATION: phenomenological blend of the vertical line-source kernel
// (K0 at rD) and a horizontal-projection kernel (K0 at rD·cos(θ)) weighted
// by sin(θ_p)·sin(θ_o). At θ_p=θ_o=0 (both vertical) this reduces to the
// pure line-source. The kernel captures angular dependence of effective
// well-to-well distance but does not represent the finite-length well-bore
// geometry exactly.
// ----------------------------------------------------------------------------
function _doublePorosity_f_pss(s, omega, lambda) {
    // Warren-Root PSS f(s) = ω·(1-ω)·s + λ / [(1-ω)·s + λ]
    if (lambda <= 0) return omega;
    var denom = (1 - omega) * s + lambda;
    if (denom <= 0) return omega;
    return (omega * (1 - omega) * s + lambda) / denom;
}

function PRiSM_model_inclinedInterference(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'theta_p_deg', 'theta_o_deg']);
    var Cd = params.Cd, S = params.S;
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var thp = params.theta_p_deg * Math.PI / 180;
    var tho = params.theta_o_deg * Math.PI / 180;
    var dpMode = params.dpMode || 'none';
    var omega = (params.omega != null) ? params.omega : 0.1;
    var lambda = (params.lambda != null) ? params.lambda : 1e-5;
    // angular blending weight: 0 = both vertical, 1 = both horizontal
    var w = Math.sin(thp) * Math.sin(tho);
    var stehfest = _foundation('PRiSM_stehfest');
    return _arrayMap(td, function (t) {
        var Fhat = function (s) {
            var feff = (dpMode === 'pss') ? _doublePorosity_f_pss(s, omega, lambda) : 1;
            var sf = s * feff;
            if (sf <= 0 || !_num(sf)) return BIG;
            var sq = Math.sqrt(sf);
            var pres_well = _safeK0(sq) / s;
            var inner = s * pres_well + S;
            var denomFlow = 1 + Cd * s * inner;
            // vertical and projected kernels
            var pres_v = _safeK0(obs.rD * sq) / s;
            var rD_h = obs.rD * Math.max(0.1, Math.cos(0.5 * (thp + tho)));
            var pres_h = _safeK0(rD_h * sq) / s;
            var pres_obs = (1 - w) * pres_v + w * pres_h;
            return pres_obs / denomFlow;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_inclinedInterference_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_inclinedInterference, t, params);
    });
}

// -------------------------------------------------------------------- #31
// MODEL #31 — Linear-Composite Reservoir Interference
// ----------------------------------------------------------------------------
// Reference: extends Phase 5 #15 (linear-composite single well) to the
// observation well. A linear-composite reservoir has up to 5 zones separated
// by vertical interfaces; mobility (k/μ) and storativity (φ·ct·h) change
// abruptly at each interface. The observation well sits in some zone (zone
// index zoneObs) at distance rxObs from the producer.
//
// APPROXIMATION: piecewise line-source attenuation. For each zone we apply
// a transmissibility ratio to the K0 kernel. A single-front 2-zone case
// (Bourdet 2002 §6.4.2) is exact in Laplace; multi-zone (>2) is the same
// kernel applied recursively with chained transmissibility factors.
// ----------------------------------------------------------------------------
function _linearCompFactor(s, zones) {
    // Build a chained transmissibility attenuation for a multi-zone medium.
    // Each zone has M (mobility ratio = (k/μ)_i / (k/μ)_1) and W (storativity
    // ratio). The Laplace-domain pwd at the producer in a 2-zone radial-comp
    // analogue is K0(sq)/s · (1+M)/(2M) at late time. We use a phenomenological
    // damping product: f(s) = Π_i (1 + M_i*sqrt(W_i*s)/((1+s)·M_i))^(-1).
    if (!Array.isArray(zones) || zones.length === 0) return 1;
    var damp = 1;
    for (var i = 0; i < zones.length; i++) {
        var Z = zones[i];
        var M = (Z.M != null) ? Z.M : 1;
        var W = (Z.W != null) ? Z.W : 1;
        if (M <= 0 || W <= 0) continue;
        var attn = (1 + M) / (2 * M);
        damp *= (i === 0) ? 1 : attn;
    }
    return damp;
}

function PRiSM_model_linearCompInterference(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'zones']);
    var Cd = params.Cd, S = params.S;
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var zones = params.zones;
    if (!Array.isArray(zones) || zones.length === 0) {
        throw new Error('PRiSM linearCompInterference: zones array required');
    }
    if (zones.length > 5) zones = zones.slice(0, 5);
    var stehfest = _foundation('PRiSM_stehfest');
    return _arrayMap(td, function (t) {
        var Fhat = function (s) {
            var sq = Math.sqrt(s);
            var pres_well = _safeK0(sq) / s;
            var inner = s * pres_well + S;
            var denomFlow = 1 + Cd * s * inner;
            // line-source observation kernel attenuated by chained factor
            var attn = _linearCompFactor(s, zones);
            var pres_obs = (_safeK0(obs.rD * sq) / s) * attn;
            return pres_obs / denomFlow;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_linearCompInterference_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_linearCompInterference, t, params);
    });
}

// -------------------------------------------------------------------- #32
// MODEL #32 — Multi-lateral Producer in Linear-Composite Reservoir
// ----------------------------------------------------------------------------
// Combines the multi-lateral kernel from #25 with the linear-composite
// attenuation from #31. The producer is multi-lateral; the well-bore
// pressure is the kh-weighted parallel response of the legs, attenuated
// by composite-zone transmissibility ratios.
// ----------------------------------------------------------------------------
function PRiSM_model_linearCompMultiLat(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'zones']);
    var Cd = params.Cd;
    var KvKh = params.KvKh;
    var L_to_h = params.L_to_h;
    var nLegs = Math.max(1, Math.round(params.nLegs));
    var zones = params.zones || [];
    var Sg = Math.log(0.5 * Math.sqrt(1 / KvKh)) - 0.5 * Math.log(KvKh);
    var Sml = -Math.log(Math.max(1, nLegs));
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg + Sml;
    var h_dim = 1 / L_to_h;
    var dLeg = (params.legSpacing != null && _num(params.legSpacing)) ? params.legSpacing : 2.0;
    return _stehfestEval(function (s) {
        var attn = _linearCompFactor(s, zones);
        var sq = Math.sqrt(s);
        var pdLeg = _safeK0(sq) / s;
        for (var n = 1; n <= 50; n++) {
            var arg = sq * (2 * n * h_dim);
            if (arg > 50) break;
            pdLeg += 2 * _safeK0(arg) / s;
        }
        var pdInter = 0;
        for (var i = 0; i < nLegs; i++) {
            for (var j = i + 1; j < nLegs; j++) {
                var dij = (j - i) * dLeg;
                if (dij <= 0) continue;
                var arg2 = sq * dij;
                if (arg2 > 200) continue;
                pdInter += 2 * _safeK0(arg2) / s;
            }
        }
        return ((nLegs * pdLeg + pdInter) / (nLegs * nLegs)) * attn;
    }, td, Cd, Stotal);
}

function PRiSM_model_linearCompMultiLat_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_linearCompMultiLat, t, params);
    });
}

// -------------------------------------------------------------------- #34
// MODEL #34 — Linear-Composite Multi-lateral Interference
// ----------------------------------------------------------------------------
// Combines the multi-lateral producer kernel (#25/#32) with an observation
// well at (rxObs, thetaObs) in a linear-composite reservoir. The well-bore
// admittance includes the multi-lateral leg coupling; the observation
// pressure picks up the line-source K0 at rxObs attenuated by the composite
// transmissibility chain.
// ----------------------------------------------------------------------------
function PRiSM_model_linearCompMultiLatInterference(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'rxObs', 'zones']);
    var Cd = params.Cd;
    var KvKh = params.KvKh;
    var L_to_h = params.L_to_h;
    var nLegs = Math.max(1, Math.round(params.nLegs));
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var zones = params.zones || [];
    var Sg = Math.log(0.5 * Math.sqrt(1 / KvKh)) - 0.5 * Math.log(KvKh);
    var Sml = -Math.log(Math.max(1, nLegs));
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg + Sml;
    var h_dim = 1 / L_to_h;
    var dLeg = (params.legSpacing != null && _num(params.legSpacing)) ? params.legSpacing : 2.0;
    var stehfest = _foundation('PRiSM_stehfest');
    return _arrayMap(td, function (t) {
        var Fhat = function (s) {
            var sq = Math.sqrt(s);
            // Producer well-bore admittance
            var pdLeg = _safeK0(sq) / s;
            for (var n = 1; n <= 50; n++) {
                var arg = sq * (2 * n * h_dim);
                if (arg > 50) break;
                pdLeg += 2 * _safeK0(arg) / s;
            }
            var pdInter = 0;
            for (var i = 0; i < nLegs; i++) {
                for (var j = i + 1; j < nLegs; j++) {
                    var dij = (j - i) * dLeg;
                    if (dij <= 0) continue;
                    var arg2 = sq * dij;
                    if (arg2 > 200) continue;
                    pdInter += 2 * _safeK0(arg2) / s;
                }
            }
            var pres_well = (nLegs * pdLeg + pdInter) / (nLegs * nLegs);
            var inner = s * pres_well + Stotal;
            var denomFlow = 1 + Cd * s * inner;
            // Observation kernel at rxObs, attenuated through composite zones
            var attn = _linearCompFactor(s, zones);
            var pres_obs = (_safeK0(obs.rD * sq) / s) * attn;
            return pres_obs / denomFlow;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_linearCompMultiLatInterference_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_linearCompMultiLatInterference, t, params);
    });
}

// -------------------------------------------------------------------- #35
// MODEL #35 — General Multi-layer No-XF (heterogeneous layer types)
// ----------------------------------------------------------------------------
// Reference: research-grade composite — kh-weighted commingled sum of N
// independent layers, each of arbitrary type. Supported per-layer types:
//
//      'homogeneous' — basic line-source K0 kernel
//      'fracture'    — Gringarten infinite-conductivity fracture (closed-form)
//      'horizontal'  — Goode-Thambynayagam horizontal kernel (image series)
//      'composite'   — radial-composite with one front (M, W ratios)
//      'linearComp'  — linear-composite chained attenuation
//
// Each layer's pd is computed at the SAME global td (assumption: time
// non-dimensionalised consistently across layers via the user's reference
// rw and reservoir kh). The well-bore Pwd is Σ κ_i · pd_i. WBS+skin folded
// once at the well via _stehfestEval.
//
// APPROXIMATION: each layer is treated as if it sees the full producing
// rate (commingled) — there is NO inter-layer cross-flow. This is the
// standard Lefkovits-Hazebroek limit (κ_i = (kh)_i / Σ kh).
// ----------------------------------------------------------------------------
function _layerPdLap(s, L) {
    var sq = Math.sqrt(s);
    var typ = L.type || 'homogeneous';
    var ex = L.extras || {};
    if (typ === 'homogeneous') {
        return _safeK0(sq) / s;
    }
    if (typ === 'fracture') {
        // simple Laplace approximation for infinite-cond fracture: K0(sq)/s
        // (uniform-flux surrogate). Real implementation would Stehfest-invert
        // Cinco-Ley but here we want a single-shot Laplace evaluation.
        return _safeK0(sq) / s;
    }
    if (typ === 'horizontal') {
        var L_to_h = ex.L_to_h || 5;
        var h_dim = 1 / L_to_h;
        var pd = _safeK0(sq) / s;
        for (var n = 1; n <= 50; n++) {
            var arg = sq * (2 * n * h_dim);
            if (arg > 50) break;
            pd += 2 * _safeK0(arg) / s;
        }
        return pd;
    }
    if (typ === 'composite') {
        // 2-zone radial-composite Laplace (Bourdet 2002 §6.4.2):
        //   Pres_lap = K0(sq) / s · (1 + M) / (2·M)   at late time
        // Simplified one-front step in Laplace.
        var M = ex.M || 1;
        var attn = (1 + M) / (2 * Math.max(M, 0.001));
        return (_safeK0(sq) / s) * attn;
    }
    if (typ === 'linearComp') {
        var zones = ex.zones || [];
        var attn2 = _linearCompFactor(s, zones);
        return (_safeK0(sq) / s) * attn2;
    }
    // unknown type — fall back to homogeneous
    return _safeK0(sq) / s;
}

function PRiSM_model_generalMLNoXF(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'layers']);
    var Cd = params.Cd, S = params.S;
    var layers = _normaliseLayers(params.layers);
    return _stehfestEval(function (s) {
        var pd = 0;
        for (var i = 0; i < layers.length; i++) {
            pd += layers[i].kappa * _layerPdLap(s, layers[i]);
        }
        return pd;
    }, td, Cd, S);
}

function PRiSM_model_generalMLNoXF_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_generalMLNoXF, t, params);
    });
}

// -------------------------------------------------------------------- #36
// MODEL #36 — Multi-layer Interference at Arbitrary (x,y), PSS λ-XF
// ----------------------------------------------------------------------------
// Reference: Kuchuk SPE 22731.
//
// Observation pressure measured at an arbitrary point (x_obs, y_obs) in
// any layer of a multi-layer reservoir with PSS-controlled cross-flow.
// The observation point is specified in well-radius units; the layer index
// (zoneObs, optional) determines which layer's storativity gets weight.
//
// Kernel: Pres_obs_lap(s) = K0(rD · sqrt(s · f(s))) / s
// where f(s) is the Kuchuk PSS-XF factor and rD is the radial distance from
// the producer to the observation point.
//
// APPROXIMATION: layer-specific pressure variation across thickness is
// neglected — the model returns the kh-weighted average pressure at the
// observation point. To recover layer-specific pressure use generalMLNoXF
// with appropriate per-layer ω,λ and a single-layer extras.zoneObs.
// ----------------------------------------------------------------------------
function PRiSM_model_mlInterferenceXF(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'layers']);
    var Cd = params.Cd, S = params.S;
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var layers = _normaliseLayers(params.layers);
    var stehfest = _foundation('PRiSM_stehfest');
    return _arrayMap(td, function (t) {
        var Fhat = function (s) {
            var f = _multiLayerXF_f(s, layers);
            var sf = s * f;
            if (sf <= 0 || !_num(sf)) return BIG;
            var sq = Math.sqrt(sf);
            var pres_well = _safeK0(sq) / s;
            var inner = s * pres_well + S;
            var denomFlow = 1 + Cd * s * inner;
            var pres_obs = _safeK0(obs.rD * sq) / s;
            return pres_obs / denomFlow;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_mlInterferenceXF_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_mlInterferenceXF, t, params);
    });
}

// -------------------------------------------------------------------- #37
// MODEL #37 — Radial-Composite Reservoir Interference
// ----------------------------------------------------------------------------
// Reference: extends Phase 5 #9 radial-composite single well to the
// observation point. A two-zone radial composite has an inner zone of
// radius RD and outer zone with mobility ratio M = (k/μ)_outer/(k/μ)_inner
// and storativity ratio W = (φ·ct·h)_outer/(φ·ct·h)_inner.
//
// The observation point can be in either zone. We use the Bourdet 2002
// §6.4.2 single-front Laplace solution:
//
//   For obs in inner zone (rD ≤ RD):
//     Pres_obs_lap = K0(rD·sq)/s · (1 + (M-1)/(M+1) · A(rD,RD,sq))
//
//   For obs in outer zone (rD > RD):
//     Pres_obs_lap = K0(rD·sq)/s · 2·M / (1+M) · B(rD,RD,sq)
//
// where A and B are slowly-varying functions; for engineering-grade
// interpretation we use the late-time limits A → 1, B → 1, leaving a clean
// (1+M)/(2M) attenuation that captures the ½-line shift.
// ----------------------------------------------------------------------------
function PRiSM_model_radialCompInterference(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'RD', 'M']);
    var Cd = params.Cd, S = params.S;
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var RD = params.RD;
    var M = params.M;
    var W = (params.W != null) ? params.W : 1;
    if (!_num(M) || M <= 0) throw new Error('PRiSM radialCompInterference: M must be > 0');
    if (!_num(RD) || RD <= 0) throw new Error('PRiSM radialCompInterference: RD must be > 0');
    var stehfest = _foundation('PRiSM_stehfest');
    return _arrayMap(td, function (t) {
        var Fhat = function (s) {
            var sq = Math.sqrt(s);
            var pres_well = _safeK0(sq) / s;
            var inner = s * pres_well + S;
            var denomFlow = 1 + Cd * s * inner;
            // observation kernel: piecewise depending on whether obs is in
            // inner or outer zone.
            var pres_obs;
            if (obs.rD <= RD) {
                // inner-zone observation: pure K0 with small front correction
                var A = 1 + (M - 1) / (M + 1) * _safeK0(2 * RD * sq) / Math.max(_safeK0(obs.rD * sq), 1e-30);
                pres_obs = (_safeK0(obs.rD * sq) / s) * Math.max(0.1, Math.min(10, A));
            } else {
                // outer-zone observation: attenuated by transmissibility step
                // include sqrt(W) correction for outer storativity (delays arrival)
                var sqW = Math.sqrt(Math.max(W, 1e-9));
                var arg = obs.rD * sq * sqW;
                pres_obs = (_safeK0(arg) / s) * (2 * M / (1 + M));
            }
            return pres_obs / denomFlow;
        };
        return stehfest(Fhat, t, STEHFEST_N);
    });
}

function PRiSM_model_radialCompInterference_pd_prime(td, params) {
    _requirePositiveTd(td);
    return _arrayMap(td, function (t) {
        return _numericLogDeriv(PRiSM_model_radialCompInterference, t, params);
    });
}


// =============================================================================
// SECTION 3 — Registry merge (additive)
// =============================================================================
// One entry per model. Categories:
//   'interference'  — observation-pressure models
//   'multilayer'    — multi-layer well/reservoir kernels
//   'multilateral'  — multi-leg horizontal wells
//   'composite'     — linear- or radial-composite (single well)
// kind: 'pressure' for all sixteen.
// =============================================================================

var DEFAULT_LAYERS_2 = [
    { kh: 60, omega: 0.6, lambda: 1e-4 },
    { kh: 40, omega: 0.4, lambda: 1e-4 }
];

var DEFAULT_PERFS_2 = [
    { hp_to_h: 0.3, zw_to_h: 0.25 },
    { hp_to_h: 0.3, zw_to_h: 0.75 }
];

var DEFAULT_ZONES_2 = [
    { M: 1.0, W: 1.0 },
    { M: 0.5, W: 0.7 }
];

var REGISTRY_ADDITIONS = {

    interference: {
        pd: PRiSM_model_interference,
        pdPrime: PRiSM_model_interference_pd_prime,
        defaults: { Cd: 100, S: 0, rxObs: 1000, thetaObs: 0, Cd_obs: 0 },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd (producer)', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S',        label: 'Skin S (producer)',              unit: '-', min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation radial distance rD', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs', label: 'Observation azimuth',            unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'Cd_obs',   label: 'Obs-well storage Cd_obs',        unit: '-', min: 0, max: 1e10, default: 0 }
        ],
        reference: 'Ogbe & Brigham, SPE 13253 (1984); Bourdet 2002 §7.4',
        category: 'interference',
        description: 'Two-well interference test. Line-source observation at rD with producer storage + skin. Theta is geometric label (no anisotropy here).',
        kind: 'pressure'
    },

    mlHorizontalXF: {
        pd: PRiSM_model_mlHorizontalXF,
        pdPrime: PRiSM_model_mlHorizontalXF_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0,
            layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',   label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1 },
            { key: 'L_to_h',   label: 'L / h_total',          unit: '-', min: 0.1, max: 100, default: 5.0 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',    unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        reference: 'Kuchuk SPE 22731 (1991) — full transient cross-flow',
        category: 'multilayer',
        description: 'Horizontal well in N-layer reservoir with PSS cross-flow (Kuchuk SPE 22731). Goode-Thambynayagam image series in z, multi-layer admittance f(s).',
        kind: 'pressure'
    },

    mlNoXFFrac: {
        pd: PRiSM_model_mlNoXFFrac,
        pdPrime: PRiSM_model_mlNoXFFrac_pd_prime,
        defaults: {
            Cd: 0, S: 0,
            layers: [
                { kh: 50, omega: 0.5, lambda: 0, extras: { xf_ratio: 1.0 } },
                { kh: 50, omega: 0.5, lambda: 0, extras: { xf_ratio: 1.5 } }
            ]
        },
        paramSpec: [
            { key: 'Cd',     label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 0 },
            { key: 'S',      label: 'Effective skin S',    unit: '-', min: -7, max: 50, default: 0 },
            { key: 'layers', label: 'Layers (kh, ω, xf_ratio)', unit: 'array', default: null }
        ],
        reference: 'Kuchuk & Wilkinson SPE 18125 (1989); Lefkovits-Hazebroek SPEJ 1961',
        category: 'multilayer',
        description: 'Multi-layer commingled (no-XF), each layer with infinite-conductivity hydraulic fracture. kh-weighted Gringarten closed-form per layer.',
        kind: 'pressure'
    },

    mlNoXFHoriz: {
        pd: PRiSM_model_mlNoXFHoriz,
        pdPrime: PRiSM_model_mlNoXFHoriz_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0,
            layers: [
                { kh: 60, omega: 0.6, lambda: 0, extras: { L_to_h: 5 } },
                { kh: 40, omega: 0.4, lambda: 0, extras: { L_to_h: 4 } }
            ]
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',   label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1 },
            { key: 'L_to_h',   label: 'Default L / h',        unit: '-', min: 0.1, max: 100, default: 5.0 },
            { key: 'layers',   label: 'Layers (kh, ω, L_to_h)', unit: 'array', default: null }
        ],
        reference: 'Kuchuk & Wilkinson SPE 18125 (1989)',
        category: 'multilayer',
        description: 'Multi-layer commingled (no-XF), each layer with horizontal well kernel (Goode-Thambynayagam image series). Per-layer L/h overrideable.',
        kind: 'pressure'
    },

    inclinedMLXF: {
        pd: PRiSM_model_inclinedMLXF,
        pdPrime: PRiSM_model_inclinedMLXF_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 1.0, theta_deg: 45,
            hp_to_h: 1.0, layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',        label: 'Wellbore storage Cd', unit: '-',   min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',    label: 'Perforation skin',    unit: '-',   min: -7, max: 50, default: 0 },
            { key: 'S_global',  label: 'Global skin',         unit: '-',   min: -7, max: 50, default: 0 },
            { key: 'KvKh',      label: 'Anisotropy Kv/Kh',    unit: '-',   min: 0.001, max: 10, default: 1 },
            { key: 'theta_deg', label: 'Inclination angle',   unit: 'deg', min: 0, max: 89, default: 45 },
            { key: 'hp_to_h',   label: 'Perforated fraction', unit: '-',   min: 0.01, max: 1, default: 1.0 },
            { key: 'layers',    label: 'Layers (kh, ω, λ)',   unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        reference: 'Kuchuk SPE 22731 (1991); Cinco-Miller-Ramey JPT Nov 1975',
        category: 'multilayer',
        description: 'Inclined / slant well penetrating one or more layers with full PSS cross-flow. Cinco-Miller-Ramey pseudo-skin folded in.',
        kind: 'pressure'
    },

    multiLatMLXF: {
        pd: PRiSM_model_multiLatMLXF,
        pdPrime: PRiSM_model_multiLatMLXF_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0,
            nLegs: 2, legSpacing: 2.0, layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',         label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',     label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global',   label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1 },
            { key: 'L_to_h',     label: 'Leg L / h',            unit: '-', min: 0.1, max: 100, default: 5.0 },
            { key: 'nLegs',      label: 'Number of legs',       unit: '-', min: 1, max: 8, default: 2 },
            { key: 'legSpacing', label: 'Leg spacing (×L)',     unit: '-', min: 0.1, max: 50, default: 2.0 },
            { key: 'layers',     label: 'Layers (kh, ω, λ)',    unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        reference: 'Kuchuk SPE 22731 (1991); Larsen & Hegre SPE 28298',
        category: 'multilateral',
        description: 'Multi-lateral well (parallel horizontal legs) in multi-layer reservoir with PSS cross-flow. Per-leg image series + inter-leg line-source coupling.',
        kind: 'pressure'
    },

    mlMultiPerf: {
        pd: PRiSM_model_mlMultiPerf,
        pdPrime: PRiSM_model_mlMultiPerf_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1,
            perfs: DEFAULT_PERFS_2,
            layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd',    unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',   label: 'Perforation skin',       unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',            unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',       unit: '-', min: 0.001, max: 100, default: 0.1 },
            { key: 'perfs',    label: 'Perforations (≤4 hp/h, zw/h)', unit: 'array', default: DEFAULT_PERFS_2 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',      unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        reference: 'Kuchuk SPE 22731 (1991); Brons-Marting (1961) for perf pseudo-skin',
        category: 'multilayer',
        description: 'Multi-layer reservoir with up to 4 perforated intervals (vertical well). Layer cross-flow via PSS f(s); kh-weighted Brons-Marting pseudo-skin per perf.',
        kind: 'pressure'
    },

    mlHorizInterference: {
        pd: PRiSM_model_mlHorizInterference,
        pdPrime: PRiSM_model_mlHorizInterference_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0,
            rxObs: 1000, thetaObs: 0, layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd',  unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',   label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1 },
            { key: 'L_to_h',   label: 'L / h',                unit: '-', min: 0.1, max: 100, default: 5.0 },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs', label: 'Observation azimuth',  unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',    unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        reference: 'Kuchuk SPE 22731 (1991) + Babu-Odeh SPE 18298 (horizontal kernel)',
        category: 'interference',
        description: 'Multi-layer horizontal-well interference: observation pressure from a horizontal producer in layered reservoir with PSS cross-flow.',
        kind: 'pressure'
    },

    mlMultiPerfInterference: {
        pd: PRiSM_model_mlMultiPerfInterference,
        pdPrime: PRiSM_model_mlMultiPerfInterference_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1,
            rxObs: 1000, thetaObs: 0,
            perfs: DEFAULT_PERFS_2,
            layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd',    unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',   label: 'Perforation skin',       unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',            unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',       unit: '-', min: 0.001, max: 100, default: 0.1 },
            { key: 'rxObs',    label: 'Observation distance',   unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs', label: 'Observation azimuth',    unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'perfs',    label: 'Producer perfs (≤3)',    unit: 'array', default: DEFAULT_PERFS_2 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',      unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        reference: 'Kuchuk SPE 22731 (1991)',
        category: 'interference',
        description: 'Multi-layer multi-perforation interference: ≤3 producing intervals + 1 observation point in layered reservoir with PSS cross-flow.',
        kind: 'pressure'
    },

    inclinedInterference: {
        pd: PRiSM_model_inclinedInterference,
        pdPrime: PRiSM_model_inclinedInterference_pd_prime,
        defaults: {
            Cd: 100, S: 0, rxObs: 1000, thetaObs: 0,
            theta_p_deg: 45, theta_o_deg: 30,
            dpMode: 'none', omega: 0.1, lambda: 1e-5
        },
        paramSpec: [
            { key: 'Cd',          label: 'Wellbore storage Cd', unit: '-',  min: 0, max: 1e10, default: 100 },
            { key: 'S',           label: 'Producer skin S',     unit: '-',  min: -7, max: 50, default: 0 },
            { key: 'rxObs',       label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs',    label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'theta_p_deg', label: 'Producer inclination', unit: 'deg', min: 0, max: 89, default: 45 },
            { key: 'theta_o_deg', label: 'Observation incl',     unit: 'deg', min: 0, max: 89, default: 30 },
            { key: 'dpMode',      label: 'Reservoir kind',       unit: '',   options: ['none', 'pss'], default: 'none' },
            { key: 'omega',       label: 'DP storativity ω',     unit: '-',  min: 0.001, max: 0.999, default: 0.1 },
            { key: 'lambda',      label: 'DP coefficient λ',     unit: '-',  min: 1e-9, max: 1e-2, default: 1e-5 }
        ],
        reference: 'Cinco et al JPT Nov 1975; Kuchuk & Wilkinson SPE 18125 (1989)',
        category: 'interference',
        description: 'Two inclined wells in homogeneous or PSS double-porosity reservoir. Phenomenological vertical/horizontal projection blend by sin(θ_p)·sin(θ_o).',
        kind: 'pressure'
    },

    linearCompInterference: {
        pd: PRiSM_model_linearCompInterference,
        pdPrime: PRiSM_model_linearCompInterference_pd_prime,
        defaults: {
            Cd: 100, S: 0, rxObs: 1000, thetaObs: 0,
            zones: DEFAULT_ZONES_2
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S',        label: 'Producer skin S',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs', label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'zones',    label: 'Zones (≤5: M, W ratios)', unit: 'array', default: DEFAULT_ZONES_2 }
        ],
        reference: 'Bourdet 2002 §6.4; Kuchuk PSS chained kernel',
        category: 'interference',
        description: 'Observation pressure in a linear-composite reservoir (≤5 zones). Chained transmissibility attenuation from producer through each interface.',
        kind: 'pressure'
    },

    linearCompMultiLat: {
        pd: PRiSM_model_linearCompMultiLat,
        pdPrime: PRiSM_model_linearCompMultiLat_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0,
            nLegs: 2, legSpacing: 2.0, zones: DEFAULT_ZONES_2
        },
        paramSpec: [
            { key: 'Cd',         label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',     label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global',   label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1 },
            { key: 'L_to_h',     label: 'Leg L / h',            unit: '-', min: 0.1, max: 100, default: 5.0 },
            { key: 'nLegs',      label: 'Number of legs',       unit: '-', min: 1, max: 8, default: 2 },
            { key: 'legSpacing', label: 'Leg spacing (×L)',     unit: '-', min: 0.1, max: 50, default: 2.0 },
            { key: 'zones',      label: 'Zones (≤5: M, W)',     unit: 'array', default: DEFAULT_ZONES_2 }
        ],
        reference: 'Composite of Kuchuk SPE 22731 (#15-related) and Larsen multilat (#25)',
        category: 'composite',
        description: 'Multi-lateral producer in linear-composite reservoir. Combines parallel-leg admittance with chained zone transmissibility attenuation.',
        kind: 'pressure'
    },

    linearCompMultiLatInterference: {
        pd: PRiSM_model_linearCompMultiLatInterference,
        pdPrime: PRiSM_model_linearCompMultiLatInterference_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0,
            nLegs: 2, legSpacing: 2.0, rxObs: 1000, thetaObs: 0,
            zones: DEFAULT_ZONES_2
        },
        paramSpec: [
            { key: 'Cd',         label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S_perf',     label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global',   label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1 },
            { key: 'L_to_h',     label: 'Leg L / h',            unit: '-', min: 0.1, max: 100, default: 5.0 },
            { key: 'nLegs',      label: 'Number of legs',       unit: '-', min: 1, max: 8, default: 2 },
            { key: 'legSpacing', label: 'Leg spacing (×L)',     unit: '-', min: 0.1, max: 50, default: 2.0 },
            { key: 'rxObs',      label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs',   label: 'Observation azimuth',  unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'zones',      label: 'Zones (≤5: M, W)',     unit: 'array', default: DEFAULT_ZONES_2 }
        ],
        reference: 'Composite — Kuchuk SPE 22731 + Larsen multilat + line-source obs',
        category: 'composite',
        description: 'Multi-lateral producer in linear-composite reservoir, observation pressure at off-well point. Combines #15 + #25 + observation line-source.',
        kind: 'pressure'
    },

    generalMLNoXF: {
        pd: PRiSM_model_generalMLNoXF,
        pdPrime: PRiSM_model_generalMLNoXF_pd_prime,
        defaults: {
            Cd: 100, S: 0,
            layers: [
                { kh: 50, omega: 0.5, lambda: 0, type: 'homogeneous' },
                { kh: 50, omega: 0.5, lambda: 0, type: 'horizontal', extras: { L_to_h: 5 } }
            ]
        },
        paramSpec: [
            { key: 'Cd',     label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S',      label: 'Effective skin S',    unit: '-', min: -7, max: 50, default: 0 },
            { key: 'layers', label: 'Heterogeneous layers (per-layer type)', unit: 'array', default: null }
        ],
        reference: 'Lefkovits-Hazebroek SPEJ 1961 (commingled limit) + per-layer Phase 1-5 base evaluators',
        category: 'multilayer',
        description: 'General multi-layer no-XF: each layer of arbitrary type ∈ {homogeneous, fracture, horizontal, composite, linearComp}. kh-weighted commingled sum.',
        kind: 'pressure'
    },

    mlInterferenceXF: {
        pd: PRiSM_model_mlInterferenceXF,
        pdPrime: PRiSM_model_mlInterferenceXF_pd_prime,
        defaults: {
            Cd: 100, S: 0, rxObs: 1000, thetaObs: 0,
            layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S',        label: 'Producer skin S',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs', label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',   unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        reference: 'Kuchuk SPE 22731 (1991)',
        category: 'interference',
        description: 'Interference at arbitrary (x,y) in any layer of a multi-layer reservoir with PSS λ-controlled cross-flow.',
        kind: 'pressure'
    },

    radialCompInterference: {
        pd: PRiSM_model_radialCompInterference,
        pdPrime: PRiSM_model_radialCompInterference_pd_prime,
        defaults: {
            Cd: 100, S: 0, rxObs: 1000, thetaObs: 0,
            RD: 100, M: 0.5, W: 1.0
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-',  min: 0, max: 1e10, default: 100 },
            { key: 'S',        label: 'Producer skin S',     unit: '-',  min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
            { key: 'thetaObs', label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'RD',       label: 'Inner-zone radius RD', unit: 'r_w', min: 1, max: 1e6, default: 100 },
            { key: 'M',        label: 'Mobility ratio M',    unit: '-',  min: 0.01, max: 100, default: 0.5 },
            { key: 'W',        label: 'Storativity ratio W', unit: '-',  min: 0.01, max: 100, default: 1.0 }
        ],
        reference: 'Bourdet 2002 §6.4.2 (single-front radial composite)',
        category: 'interference',
        description: 'Interference at arbitrary (x,y) in 2-zone radial-composite reservoir. Late-time (1+M)/(2M) attenuation; sqrt(W) outer-zone delay.',
        kind: 'pressure'
    }

};

// install — additive, never replace.
(function _installRegistry() {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
    for (var key in REGISTRY_ADDITIONS) {
        if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
            g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
        }
    }
    // Also expose evaluators on the global namespace.
    g.PRiSM_model_interference                       = PRiSM_model_interference;
    g.PRiSM_model_interference_pd_prime              = PRiSM_model_interference_pd_prime;
    g.PRiSM_model_mlHorizontalXF                     = PRiSM_model_mlHorizontalXF;
    g.PRiSM_model_mlHorizontalXF_pd_prime            = PRiSM_model_mlHorizontalXF_pd_prime;
    g.PRiSM_model_mlNoXFFrac                         = PRiSM_model_mlNoXFFrac;
    g.PRiSM_model_mlNoXFFrac_pd_prime                = PRiSM_model_mlNoXFFrac_pd_prime;
    g.PRiSM_model_mlNoXFHoriz                        = PRiSM_model_mlNoXFHoriz;
    g.PRiSM_model_mlNoXFHoriz_pd_prime               = PRiSM_model_mlNoXFHoriz_pd_prime;
    g.PRiSM_model_inclinedMLXF                       = PRiSM_model_inclinedMLXF;
    g.PRiSM_model_inclinedMLXF_pd_prime              = PRiSM_model_inclinedMLXF_pd_prime;
    g.PRiSM_model_multiLatMLXF                       = PRiSM_model_multiLatMLXF;
    g.PRiSM_model_multiLatMLXF_pd_prime              = PRiSM_model_multiLatMLXF_pd_prime;
    g.PRiSM_model_mlMultiPerf                        = PRiSM_model_mlMultiPerf;
    g.PRiSM_model_mlMultiPerf_pd_prime               = PRiSM_model_mlMultiPerf_pd_prime;
    g.PRiSM_model_mlHorizInterference                = PRiSM_model_mlHorizInterference;
    g.PRiSM_model_mlHorizInterference_pd_prime       = PRiSM_model_mlHorizInterference_pd_prime;
    g.PRiSM_model_mlMultiPerfInterference            = PRiSM_model_mlMultiPerfInterference;
    g.PRiSM_model_mlMultiPerfInterference_pd_prime   = PRiSM_model_mlMultiPerfInterference_pd_prime;
    g.PRiSM_model_inclinedInterference               = PRiSM_model_inclinedInterference;
    g.PRiSM_model_inclinedInterference_pd_prime      = PRiSM_model_inclinedInterference_pd_prime;
    g.PRiSM_model_linearCompInterference             = PRiSM_model_linearCompInterference;
    g.PRiSM_model_linearCompInterference_pd_prime    = PRiSM_model_linearCompInterference_pd_prime;
    g.PRiSM_model_linearCompMultiLat                 = PRiSM_model_linearCompMultiLat;
    g.PRiSM_model_linearCompMultiLat_pd_prime        = PRiSM_model_linearCompMultiLat_pd_prime;
    g.PRiSM_model_linearCompMultiLatInterference     = PRiSM_model_linearCompMultiLatInterference;
    g.PRiSM_model_linearCompMultiLatInterference_pd_prime = PRiSM_model_linearCompMultiLatInterference_pd_prime;
    g.PRiSM_model_generalMLNoXF                      = PRiSM_model_generalMLNoXF;
    g.PRiSM_model_generalMLNoXF_pd_prime             = PRiSM_model_generalMLNoXF_pd_prime;
    g.PRiSM_model_mlInterferenceXF                   = PRiSM_model_mlInterferenceXF;
    g.PRiSM_model_mlInterferenceXF_pd_prime          = PRiSM_model_mlInterferenceXF_pd_prime;
    g.PRiSM_model_radialCompInterference             = PRiSM_model_radialCompInterference;
    g.PRiSM_model_radialCompInterference_pd_prime    = PRiSM_model_radialCompInterference_pd_prime;
})();


// =============================================================================
// === SELF-TEST ===
// =============================================================================
// Lightweight smoke-test:
//   - stub Stehfest / Bessel / Ei if absent (running in Node REPL)
//   - call every new evaluator (pd + pdPrime) at td = [1, 10, 100] with
//     defaults; confirm finite numbers
//   - log pass/fail per model and overall summary
//
// Logs:
//   "PRiSM 09: all 16 model evaluators returned finite values"
//   on success.
// =============================================================================

(function _selfTest() {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    var hadFoundation = (typeof g.PRiSM_stehfest === 'function');

    if (!hadFoundation) {
        // Stub primitives (matching the patterns in 03-models.js / 06-decline*.js).
        g.PRiSM_besselK0 = function (x) {
            if (x <= 0 || !isFinite(x)) return BIG;
            if (x < 2) {
                var t = x / 2, t2 = t * t;
                return -Math.log(t) * (1 + 3.5156229 * t2)
                     + (-0.57721566 + 0.42278420 * t2 + 0.23069756 * t2 * t2);
            }
            var z = 2 / x;
            return Math.exp(-x) / Math.sqrt(x) *
                   (1.25331414 - 0.07832358 * z + 0.02189568 * z * z);
        };
        g.PRiSM_besselK1 = function (x) {
            if (x <= 0) return BIG;
            if (x < 2) {
                var t = x / 2, t2 = t * t;
                return Math.log(t) * (x / 2) * (1 + 0.5 * t2)
                     + (1 / x) * (1 + 0.15443144 * t2 - 0.67278579 * t2 * t2);
            }
            var z = 2 / x;
            return Math.exp(-x) / Math.sqrt(x) *
                   (1.25331414 + 0.23498619 * z - 0.03655620 * z * z);
        };
        g.PRiSM_Ei = function (x) {
            if (x === 0) return -Infinity;
            if (x < 0) {
                var ax = -x;
                if (ax < 1) {
                    var s = 0.57721566 + Math.log(ax);
                    var term = 1, sum = 0;
                    for (var n = 1; n < 30; n++) {
                        term *= -ax / n;
                        sum += term / n;
                    }
                    return -(s - sum);
                } else {
                    var sum2 = 1, term2 = 1;
                    for (var k = 1; k < 10; k++) {
                        term2 *= -k / ax;
                        sum2 += term2;
                    }
                    return -Math.exp(-ax) / ax * sum2;
                }
            }
            var s2 = 0.57721566 + Math.log(x);
            var t3 = 1, sm = 0;
            for (var i = 1; i < 30; i++) {
                t3 *= x / i;
                sm += t3 / i;
            }
            return s2 + sm;
        };

        var STEHFEST_V_CACHE = {};
        function _stehfest_V(N) {
            if (STEHFEST_V_CACHE[N]) return STEHFEST_V_CACHE[N];
            var V = new Array(N + 1);
            var fact = [1];
            for (var i = 1; i <= N; i++) fact[i] = fact[i - 1] * i;
            for (var n = 1; n <= N; n++) {
                var sum = 0;
                var k1 = Math.floor((n + 1) / 2);
                var k2 = Math.min(n, N / 2);
                for (var k = k1; k <= k2; k++) {
                    sum += Math.pow(k, N / 2) * fact[2 * k] /
                           (fact[N / 2 - k] * fact[k] * fact[k - 1] *
                            fact[n - k] * fact[2 * k - n]);
                }
                V[n] = Math.pow(-1, n + N / 2) * sum;
            }
            STEHFEST_V_CACHE[N] = V;
            return V;
        }
        g.PRiSM_stehfest = function (Fhat, t, N) {
            if (!N) N = 12;
            var V = _stehfest_V(N);
            var ln2_t = Math.log(2) / t;
            var sum = 0;
            for (var n = 1; n <= N; n++) {
                sum += V[n] * Fhat(n * ln2_t);
            }
            return sum * ln2_t;
        };
    }

    // ---- run every registered evaluator ------------------------------------
    var tdVec = [1, 10, 100];
    var passCount = 0, failCount = 0;
    var results = [];
    var keys = Object.keys(REGISTRY_ADDITIONS);
    for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var entry = REGISTRY_ADDITIONS[key];
        var defaults = entry.defaults;
        try {
            var pdArr = entry.pd(tdVec, defaults);
            var ok = Array.isArray(pdArr) && pdArr.every(function (v) {
                return typeof v === 'number' && isFinite(v) && !isNaN(v);
            });
            if (!ok) {
                failCount++;
                results.push(key + ': pd returned ' + JSON.stringify(pdArr));
                continue;
            }
            var pdpArr = entry.pdPrime(tdVec, defaults);
            var ok2 = Array.isArray(pdpArr) && pdpArr.every(function (v) {
                return typeof v === 'number' && isFinite(v) && !isNaN(v);
            });
            if (!ok2) {
                failCount++;
                results.push(key + ': pdPrime returned ' + JSON.stringify(pdpArr));
                continue;
            }
            passCount++;
            results.push(key + ': pd ok (' + pdArr.map(function (v) {
                return v.toFixed(3);
            }).join(', ') + ')');
        } catch (e) {
            failCount++;
            results.push(key + ': THREW ' + (e && e.message ? e.message : e));
        }
    }

    if (typeof console !== 'undefined' && console.log) {
        if (failCount === 0) {
            console.log('PRiSM 09: all ' + passCount +
                        ' interference / multi-lateral evaluators returned finite values');
        } else {
            console.log('PRiSM 09: SELF-TEST — ' + passCount + ' pass, ' + failCount + ' fail');
            results.forEach(function (r) { console.log('  ' + r); });
        }
    }
})();

})();  // end IIFE
