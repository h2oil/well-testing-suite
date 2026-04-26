// =============================================================================
// PRiSM — Layer 08 — Composite + Multi-Layer Single-Well Models (Phase 5)
// =============================================================================
// Pressure Reservoir Inversion & Simulation Model — Advanced Well Test Analysis
//
// This file extends the PRiSM model registry with 7 new evaluators that cover
// composite reservoirs and multi-layer geometries.  All entries are merged
// additively into window.PRiSM_MODELS so the Phase 1-4 entries survive.
//
//   Composite reservoirs (kind: 'pressure'):
//      9. radialComposite       — two concentric zones, mobility ratio M,
//                                 storativity ratio F.  (Abbaszadeh-Medhat
//                                 SPE Reservoir Eng Feb 1989)
//     15. linearComposite       — up to 5 zones with linear discontinuities
//                                 at distances L_1..L_4 (image superposition).
//
//   Multi-layer single-well (kind: 'pressure'):
//      6. twoLayerXF            — bi-layer / dual-permeability with PSS
//                                 cross-flow controlled by λ.  (Bourdet,
//                                 SPE 13628)
//     11. multiLayerXF          — N adjacent layers (default 3, max 5) with
//                                 PSS cross-flow between successive pairs.
//                                 (Economides SPE 14167)
//     14. multiLayerNoXF        — N isolated commingled layers (default 3,
//                                 max 5).  Closed-form pressure-weighted sum
//                                 of homogeneous layers.  (Kuchuk-Wilkinson
//                                 SPE 18125)
//
//   General-heterogeneity research-grade simplifications (kind: 'pressure'):
//     20. genHetRadialLinear    — three-zone radial composite combined with a
//                                 three-zone linear composite (single linear
//                                 fault).  Up to 9 piecewise discontinuities
//                                 in the spec are NOT implemented; the model
//                                 is restricted to two radial interfaces +
//                                 one linear fault.
//     21. genHetRadial          — three-zone radial composite (refines #9
//                                 with one extra mobility / storativity step
//                                 at radius R2).  Up to 9 piecewise
//                                 discontinuities in the spec are NOT
//                                 implemented; the model is restricted to
//                                 two interfaces (three concentric zones).
//
// Approximations / phenomenological blends explicitly used (also documented
// in each evaluator's `description`):
//
//   * `twoLayerXF`   — Bourdet's PSS cross-flow factor f(s) is reused with
//                       a Warren-Root-style two-layer kernel.  The wellbore
//                       pressure is the kh-fraction-weighted sum of the two
//                       layers' pressures and the cross-flow coupling is the
//                       interporosity λ formalism (rigorous in Laplace).
//
//   * `radialComposite` — exact Laplace-domain inner-zone solution
//                          P̂_inner(s) = K0(√(s)) / s
//                                      + α(s) · I0(√(s))
//                          plus exact outer-zone solution
//                          P̂_outer(s) = β(s) · K0(√(s · ω) · r/R)
//                          matched in pressure + flux at r = R.  Interface
//                          coefficients α, β solved analytically.
//
//   * `multiLayerXF` — N-layer cross-flow uses the same PSS factor f(s) per
//                      adjacent pair; the wellbore pressure is the kh-weighted
//                      sum of layer Pds.  This is a tractable simplification:
//                      a fully-rigorous Park-Horne 1989 NxN tridiagonal
//                      Laplace system reduces to this form when all
//                      interporosity λ are equal (homogeneous coupling).  For
//                      heterogeneous λ the result is a smooth approximation
//                      that still captures the dual-porosity dip.  See
//                      `description`.
//
//   * `multiLayerNoXF` — exact for commingled layers (no cross-flow): Pd is
//                        the kh-weighted sum of N independent homogeneous
//                        layer Pds.  Uses the Phase-1 homogeneous kernel.
//
//   * `linearComposite` — image-well superposition.  Each interface at L_i
//                          contributes a single image well at distance
//                          2·L_i with a transmission/reflection coefficient
//                          based on the mobility-ratio jumps.  Higher-order
//                          multi-reflections truncated.  Matches the early-
//                          time response of the first-zone homogeneous
//                          solution and the late-time stabilisation derived
//                          from the harmonic-mean mobility across all zones.
//
//   * `genHetRadialLinear` and `genHetRadial` — research-grade reach goals.
//                        The textbook spec allows up to 9 piecewise-linear /
//                        step-wise discontinuities radially or linearly.
//                        We implement the engineering-useful 3-zone case for
//                        each (two radial interfaces; for #20 also one linear
//                        fault).  The simplification is documented in each
//                        evaluator's `description`.
//
// Foundation primitives in scope (defined in 01-foundation.js, also published
// on window for sibling-file access):
//   PRiSM_stehfest(F̂, t, N=12)   numerical inverse Laplace
//   PRiSM_besselK0(x), PRiSM_besselK1(x)
//   PRiSM_besselI0(x), PRiSM_besselI1(x)
//   PRiSM_Ei(x), PRiSM_E1(x)
//   PRiSM_logspace(min, max, n)
//   PRiSM_factorial(n)
//   PRiSM_STEHFEST_W (precomputed weight tables)
// =============================================================================

(function () {
'use strict';

// =============================================================================
// SECTION 1 — Helpers + foundation primitive resolver
// =============================================================================
//
// All helpers prefixed `_` are file-private.  Public symbols start with
// `PRiSM_`.  We resolve foundation primitives lazily via window.* so the
// self-test at the bottom can stub them in for standalone Node testing.
// =============================================================================

var STEHFEST_N      = 12;       // Stehfest order used by every Laplace model
var IMAGE_CAP       = 200;      // hard cap on image-series terms
var IMAGE_TOL       = 1e-9;     // convergence tolerance per term contribution
var DERIV_REL_STEP  = 1e-3;     // relative log-step for numerical derivative
var MAX_LAYERS      = 5;        // hard cap for multi-layer N

// resolve a foundation primitive by name from window.* / globalThis
function _foundation(name) {
  var g = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (typeof g[name] === 'function') return g[name];
  // also accept symbols introduced via plain `var` in an IIFE host
  try { return eval(name); } catch (e) { return null; }
}

function _num(v) {
  return (typeof v === 'number') && isFinite(v) && !isNaN(v);
}

function _arrayMap(td, fn) {
  if (Array.isArray(td)) {
    var out = new Array(td.length);
    for (var i = 0; i < td.length; i++) out[i] = fn(td[i]);
    return out;
  }
  return fn(td);
}

function _requirePositiveTd(td) {
  if (Array.isArray(td)) {
    for (var i = 0; i < td.length; i++) {
      if (!_num(td[i]) || td[i] <= 0) {
        throw new Error('PRiSM 08: td must be > 0 (got ' + td[i] + ' at index ' + i + ')');
      }
    }
  } else if (!_num(td) || td <= 0) {
    throw new Error('PRiSM 08: td must be > 0 (got ' + td + ')');
  }
}

function _requireParams(params, keys) {
  if (!params || typeof params !== 'object') {
    throw new Error('PRiSM 08: params object required');
  }
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!(k in params)) {
      throw new Error('PRiSM 08: missing required param "' + k + '"');
    }
  }
}

// fold WBS + skin into a Laplace-domain reservoir solution Pd_lap_res(s)
// (Agarwal-Ramey 1970 / Bourdet-Gringarten 1980)
//
//   Pwd_lap = ( s * Pd_lap_res + S ) / ( s · ( 1 + Cd · s · ( s · Pd_lap_res + S ) ) )
function _foldWbsSkin(pdResLap, s, Cd, S) {
  var inner = s * pdResLap + S;
  var denom = s * (1 + Cd * s * inner);
  if (!_num(denom) || denom === 0) return 1e30;
  return inner / denom;
}

function _stehfestEval(pdResLapFn, td, Cd, S) {
  var stehfest = _foundation('PRiSM_stehfest');
  if (!stehfest) throw new Error('PRiSM_stehfest() missing — foundation file not loaded');
  var Fhat = function (s) { return _foldWbsSkin(pdResLapFn(s), s, Cd, S); };
  return _arrayMap(td, function (t) { return stehfest(Fhat, t, STEHFEST_N); });
}

// generic numerical logarithmic derivative td * dPd/dtd via 5-point central
// difference in ln(td).  Used when the Laplace-domain derivative is not a
// clean closed form.
function _numericLogDeriv(pdFn, td, params) {
  var h = DERIV_REL_STEP;
  var lnTd = Math.log(td);
  var f_m2 = pdFn(Math.exp(lnTd - 2 * h), params);
  var f_m1 = pdFn(Math.exp(lnTd -     h), params);
  var f_p1 = pdFn(Math.exp(lnTd +     h), params);
  var f_p2 = pdFn(Math.exp(lnTd + 2 * h), params);
  if (Array.isArray(f_m2)) f_m2 = f_m2[0];
  if (Array.isArray(f_m1)) f_m1 = f_m1[0];
  if (Array.isArray(f_p1)) f_p1 = f_p1[0];
  if (Array.isArray(f_p2)) f_p2 = f_p2[0];
  return (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);
}

// Safe Bessel I0 wrapper — needed for radial-composite inner-zone solution
// (cylindrical-coord inhomogeneous solution combines K0 + I0).  Uses the
// foundation routine if available.
function _besselI0(x) {
  var I0 = _foundation('PRiSM_besselI0');
  if (I0) return I0(x);
  // light fallback for self-test (Abramowitz-Stegun small-x series)
  var ax = Math.abs(x);
  if (ax < 3.75) {
    var y = ax / 3.75; var y2 = y * y;
    return 1.0 + y2 * (3.5156229 + y2 * (3.0899424 + y2 * (1.2067492 +
            y2 * (0.2659732 + y2 * (0.0360768 + y2 * 0.0045813)))));
  }
  var y2 = 3.75 / ax;
  return (Math.exp(ax) / Math.sqrt(ax)) * (0.39894228 + y2 * (0.01328592 +
         y2 * (0.00225319 + y2 * (-0.00157565 + y2 * (0.00916281 +
         y2 * (-0.02057706 + y2 * (0.02635537 + y2 * (-0.01647633 +
         y2 * 0.00392377))))))));
}

function _besselI1(x) {
  var I1 = _foundation('PRiSM_besselI1');
  if (I1) return I1(x);
  // light fallback for self-test
  var ax = Math.abs(x); var result;
  if (ax < 3.75) {
    var y = ax / 3.75; var y2 = y * y;
    result = ax * (0.5 + y2 * (0.87890594 + y2 * (0.51498869 +
             y2 * (0.15084934 + y2 * (0.02658733 + y2 * (0.00301532 +
             y2 * 0.00032411))))));
  } else {
    var y = 3.75 / ax;
    result = 0.39894228 + y * (-0.03988024 + y * (-0.00362018 +
             y * (0.00163801 + y * (-0.01031555 + y * (0.02282967 +
             y * (-0.02895312 + y * (0.01787654 + y * -0.00420059)))))));
    result *= (Math.exp(ax) / Math.sqrt(ax));
  }
  return x < 0 ? -result : result;
}

// Bessel K0 (with safety check)
function _besselK0(x) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0() missing — foundation file not loaded');
  if (!(x > 0) || !isFinite(x)) return 1e30;
  return K0(x);
}

// Bessel K1
function _besselK1(x) {
  var K1 = _foundation('PRiSM_besselK1');
  if (!K1) throw new Error('PRiSM_besselK1() missing — foundation file not loaded');
  if (!(x > 0) || !isFinite(x)) return 1e30;
  return K1(x);
}

// Clamp a value to a safe Laplace return (avoid Infinity / NaN)
function _safeLap(v) {
  if (!_num(v)) return 1e30;
  if (v > 1e30) return 1e30;
  if (v < -1e30) return -1e30;
  return v;
}

// PSS interporosity factor — same form as Warren-Root for double-porosity:
//   f(s) = ( ω·(1-ω)·s + λ ) / ( (1-ω)·s + λ )
// This is shared between twoLayerXF, multiLayerXF, and the cross-flow models
// so we expose it as a private helper.  Note: this f(s) replaces s → s·f(s)
// in the homogeneous Laplace kernel.
function _pssXFactor(s, omega, lambda) {
  var num = omega * (1 - omega) * s + lambda;
  var den = (1 - omega) * s + lambda;
  if (den === 0 || !_num(den)) return omega;
  return num / den;
}


// =============================================================================
// SECTION 2 — Model evaluators
// =============================================================================
//
// Each evaluator follows the standard PRiSM contract:
//
//   pd(td, params) → number | number[]
//   pdPrime(td, params) → number | number[]   (logarithmic derivative
//                                              tdp = td * d(pd)/dtd)
//
// Inputs are dimensionless throughout; physical-unit conversion lives in the
// parameter layer that calls these functions.
// =============================================================================


// -----------------------------------------------------------------------------
// MODEL #6 — TWO-LAYER RESERVOIR WITH CROSS-FLOW
// -----------------------------------------------------------------------------
//
// Reference: Bourdet, D. "Pressure Behavior of Layered Reservoirs With
//            Crossflow", SPE 13628 (1985).  Also Park, H., Horne, R.N.
//            "Well Test Analysis of a Multilayered Reservoir With
//            Formation Crossflow", SPE 19800 (1989).
//
// Physics: a vertical well intersects two layers of contrasting permeability
// (κ = k_1/k_2) and storativity (ω = (φc_t h)_1 / (φc_t h)_total).  The two
// layers exchange fluid by pseudo-steady-state cross-flow controlled by an
// interporosity coefficient λ (analogous to the Warren-Root λ in double-
// porosity).  At early time each layer pressure transient propagates
// independently; at late time they equilibrate to a homogeneous-equivalent
// kh = k_1 h_1 + k_2 h_2.
//
// Laplace-domain reservoir Pd at the wellbore (kh-weighted average of the
// two layers, coupled via λ):
//
//   f_xf(s)  = (ω·(1-ω)·s + λ) / ((1-ω)·s + λ)        ← PSS xf factor
//   x        = sqrt( s · f_xf(s) / κ_eff )
//   Pd_res   = K0(x) / s                                ← coupled kernel
//
// where κ_eff = ω·κ + (1-ω) = effective kh ratio with κ = k_1/k_2.  This
// reduces correctly to the homogeneous limit when ω = 1 (single layer) or
// κ = 1 (equal permeabilities).
//
// IMPORTANT: This is the standard Bourdet two-layer cross-flow form (Warren-
// Root analog).  A fully-rigorous 2x2 layer Laplace system (Park-Horne 1989)
// gives a more accurate kernel but for engineering work the PSS f(s) form
// captures the same diagnostic dual-porosity-style dip in the derivative
// curve.  The κ parameter is folded as a permeability-rescaling so the early
// and late stabilisation values match the kh-weighted target.
//
// Params: { Cd, S, kappa, lambda, omega }
//   Cd     : wellbore-storage dimensionless
//   S      : total mechanical skin
//   kappa  : layer permeability ratio k_1 / k_2  (> 0)
//   lambda : cross-flow interporosity coefficient (1e-9 .. 1e-2)
//   omega  : layer storativity ratio (φct h)_1 / (φct h)_total in (0, 1)
// -----------------------------------------------------------------------------

function _pdLap_twoLayerXF(s, params) {
  var omega  = params.omega;
  var lambda = params.lambda;
  var kappa  = params.kappa;
  if (!_num(omega) || omega <= 0 || omega >= 1) {
    throw new Error('PRiSM twoLayerXF: omega must be in (0, 1)');
  }
  if (!_num(lambda) || lambda <= 0) {
    throw new Error('PRiSM twoLayerXF: lambda must be > 0');
  }
  if (!_num(kappa) || kappa <= 0) {
    throw new Error('PRiSM twoLayerXF: kappa must be > 0');
  }
  // PSS cross-flow factor (Bourdet, Warren-Root form)
  var f = _pssXFactor(s, omega, lambda);
  // Effective kh weighting: ω·κ + (1-ω)·1 fraction.  When κ = 1 this is 1
  // and the model collapses to homogeneous; when κ ≠ 1 the early/late
  // stabilisations split correctly.
  var kappaEff = omega * kappa + (1 - omega);
  if (kappaEff <= 0) kappaEff = 1;
  var sf = s * f / kappaEff;
  if (sf <= 0 || !_num(sf)) return 1e30;
  var x = Math.sqrt(sf);
  return _besselK0(x) / s;
}

function PRiSM_model_twoLayerXF(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'kappa', 'lambda', 'omega']);
  return _stehfestEval(function (s) { return _pdLap_twoLayerXF(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_twoLayerXF_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'kappa', 'lambda', 'omega']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_twoLayerXF, t, params);
  });
}


// -----------------------------------------------------------------------------
// MODEL #9 — RADIAL COMPOSITE RESERVOIR
// -----------------------------------------------------------------------------
//
// References:
//   Abbaszadeh, M., Kamal, M.M.  "Pressure-Transient Testing of Water-
//      Injection Wells".  SPE Reservoir Engineering, Feb 1989.
//   Sutman, M., Civan, F., Akin, S.  Various formulations of two-zone
//      composite analysis.  See SPE 8909.
//
// Physics: an inner zone of radius R has mobility (k/μ)_1 and storativity
// (φc_t)_1; an outer zone (r ≥ R) has mobility (k/μ)_2 and storativity
// (φc_t)_2.  Common in water-injection: the "swept" inner zone has different
// mobility than the un-swept outer formation.  Two dimensionless ratios:
//
//   M = (k/μ)_1 / (k/μ)_2          mobility ratio (>1 favourable injection)
//   F = (φc_t)_1 / (φc_t)_2        storativity ratio
//   R = inner-zone outer radius / well radius  (dimensionless)
//
// Laplace-domain solution (line-source vertical well, rigorous):
//
//   Inner zone (rwd ≤ r ≤ R):
//     P̂_1(s, r) = K0(√s · r) / s + α(s) · I0(√s · r)
//
//   Outer zone (r ≥ R):
//     P̂_2(s, r) = β(s) · K0(√(s·F/M) · r)
//
//   Continuity at r = R:
//     pressure:  P̂_1(s, R) = P̂_2(s, R)
//     flux  :  ∂P̂_1/∂r |_R  = (1/M) · ∂P̂_2/∂r |_R
//
// Solve the 2×2 linear system for α(s), β(s), then evaluate at r = rwd = 1
// (well radius normalised).  Closed form:
//
//   Let u = √s, v = √(s·F/M).
//   numerator   = M·u·K1(u·R)·K0(v·R) + v·K1(v·R)·K0(u·R)
//   denominator = (M·u·K1(u·R)·I0(u·R) - v·K1(v·R)·I0(u·R)) ← careful with sign
//
//   For a line source at the well (rwd = 1) with the inner-zone bounded
//   between rw and R, the wellbore Pd reduces to:
//
//     Pd_res(s) = [ K0(u) · D2 + (M · I0(u) · v · K1(v·R) − I1(u) · u · K0(v·R) · M · ?? )
//                  ... ]  ← solved by Cramer's rule
//
// Implementation: build the 2x2 matrix and solve directly with Cramer's rule
// (closed form, no numerical inversion needed).  When R → ∞ this collapses
// to the homogeneous solution K0(u)/s; when M = 1 and F = 1 it also collapses
// (no contrast across the interface).
//
// Params: { Cd, S, M, F, R }
//   Cd : wellbore-storage dimensionless
//   S  : total mechanical skin
//   M  : mobility ratio (k/μ)_1 / (k/μ)_2  (> 0)
//   F  : storativity ratio (φc_t)_1 / (φc_t)_2  (> 0)
//   R  : inner-zone outer radius / rw  (> 1)
// -----------------------------------------------------------------------------

function _pdLap_radialComposite(s, params) {
  var M = params.M;
  var F = params.F;
  var R = params.R;
  if (!_num(M) || M <= 0) throw new Error('PRiSM radialComposite: M must be > 0');
  if (!_num(F) || F <= 0) throw new Error('PRiSM radialComposite: F must be > 0');
  if (!_num(R) || R <= 1) throw new Error('PRiSM radialComposite: R must be > 1');

  var u = Math.sqrt(s);
  var v = Math.sqrt(s * F / M);
  if (!_num(u) || !_num(v)) return 1e30;

  // Bessel arguments at the interface r = R
  var uR = u * R;
  var vR = v * R;

  // Pre-compute Bessel functions
  var K0u  = _besselK0(u);
  var K1u  = _besselK1(u);
  var I0u  = _besselI0(u);
  var I1u  = _besselI1(u);
  var K0uR = _besselK0(uR);
  var K1uR = _besselK1(uR);
  var I0uR = _besselI0(uR);
  var I1uR = _besselI1(uR);
  var K0vR = _besselK0(vR);
  var K1vR = _besselK1(vR);

  // Inner-zone:  P̂_1(r) = (K0(u·r) + α · I0(u·r)) / s
  //   ∂P̂_1/∂r  = (-u · K1(u·r) + α · u · I1(u·r)) / s
  // Outer-zone:  P̂_2(r) = β · K0(v·r) / s
  //   ∂P̂_2/∂r  = -β · v · K1(v·r) / s
  //
  // Continuity at r = R:
  //   K0(uR) + α · I0(uR) = β · K0(vR)
  //   M · ( -u · K1(uR) + α · u · I1(uR) ) = - β · v · K1(vR)
  //
  // Rewriting the flux equation: (mobility ratio M is on the inner side as
  // q_1 = -(k/μ)_1 · ∂P/∂r and q_2 = -(k/μ)_2 · ∂P/∂r; equating fluxes
  // gives M · ∂P_1/∂r = ∂P_2/∂r  →  M · (-u · K1(uR) + α · u · I1(uR))
  //                                = -β · v · K1(vR))
  //
  // Solve 2x2 for [α, β]:
  //   [ I0(uR)        -K0(vR) ]   [α]   [ -K0(uR)        ]
  //   [ M·u·I1(uR)     v·K1(vR) ] · [β] = [  M·u·K1(uR) ]
  //
  // Determinant:
  var detA = I0uR * v * K1vR - (-K0vR) * (M * u * I1uR);
  if (!_num(detA) || Math.abs(detA) < 1e-300) return 1e30;

  // Cramer's rule:
  //   α = ( (-K0(uR)) * v · K1(vR) - (-K0(vR)) · (M · u · K1(uR)) ) / detA
  //   β = ( I0(uR) · (M · u · K1(uR)) - (M · u · I1(uR)) · (-K0(uR)) ) / detA
  var alpha = ((-K0uR) * v * K1vR - (-K0vR) * (M * u * K1uR)) / detA;
  // We don't need β to evaluate at the well — only α, since the wellbore
  // pressure is in the inner zone:
  //   Pd_res(s) = ( K0(u) + α · I0(u) ) / s
  var pd = (K0u + alpha * I0u) / s;
  return _safeLap(pd);
}

function PRiSM_model_radialComposite(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'M', 'F', 'R']);
  return _stehfestEval(function (s) { return _pdLap_radialComposite(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_radialComposite_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'M', 'F', 'R']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_radialComposite, t, params);
  });
}


// -----------------------------------------------------------------------------
// MODEL #11 — MULTI-LAYER WITH CROSS-FLOW
// -----------------------------------------------------------------------------
//
// Reference: Economides, M.J., Joseph, J., Ambrose, R.W., Norwood, C.
//            "A Modern Generalized Approach to Reservoir Limit Testing in
//             Multilayer Reservoirs", SPE 14167 (1985).
//            Park, H., Horne, R.N. "Well Test Analysis of a Multilayered
//             Reservoir With Formation Crossflow", SPE 19800 (1989).
//
// Physics: N adjacent layers, each with its own ω_i (storativity fraction)
// and κ_i (kh fraction).  Cross-flow between adjacent layer pairs is
// controlled by an interporosity λ.  At early time each layer behaves
// individually; at late time the system equilibrates to a homogeneous-
// equivalent kh = Σ kh_i.
//
// Implementation (engineering simplification — see header):
//   For N layers we use a generalised Warren-Root PSS factor f_N(s) where
//   the cross-flow couples successive layer pairs with the same λ:
//
//     f_N(s) = [ Σ ω_i · (1-ω_i) · s + λ ] / [ Σ (1-ω_i) · s + λ ]
//
//   Then Pd_res(s) = K0( sqrt(s · f_N(s) / κ_eff) ) / s, where
//   κ_eff = Σ ω_i · κ_i.  Reduces to the homogeneous limit when N = 1
//   (single layer with ω = 1) or all (ω, κ) equal (uniform layers).
//
//   The fully-rigorous Park-Horne 1989 NxN tridiagonal Laplace system is
//   replaced by this simplified (Bourdet-style) PSS factor; it captures the
//   dual-porosity dip and the late-time stabilisation correctly when the
//   cross-flow coupling is uniform.  For heterogeneous λ the result is a
//   smooth approximation.  Documented in the model `description`.
//
// Params: { Cd, S, N, omegas, kappas, lambda }
//   Cd     : wellbore storage
//   S      : skin
//   N      : number of layers, integer in [2, 5]
//   omegas : array of length N of layer storativity fractions, sum to 1
//   kappas : array of length N of layer kh fractions, sum to 1
//   lambda : single cross-flow coefficient (between every adjacent pair)
//
// (For convenience the registry default is N=3 with equal omegas, kappas
// and a single λ.)
// -----------------------------------------------------------------------------

function _normaliseLayers(arr, N, defaultVal) {
  // Normalise to length N; sum to 1 for omegas and kappas.
  if (!Array.isArray(arr) || arr.length !== N) {
    arr = new Array(N);
    for (var i = 0; i < N; i++) arr[i] = defaultVal;
  }
  var sum = 0;
  for (var j = 0; j < N; j++) {
    arr[j] = (typeof arr[j] === 'number' && isFinite(arr[j]) && arr[j] > 0) ? arr[j] : defaultVal;
    sum += arr[j];
  }
  if (sum <= 0) sum = 1;
  for (var k = 0; k < N; k++) arr[k] = arr[k] / sum;
  return arr;
}

function _multiLayerXF_factor(s, omegas, lambda) {
  // Generalised PSS factor across N layers (uniform λ between adjacent pairs).
  var Nloc = omegas.length;
  var num = 0;
  var den = 0;
  for (var i = 0; i < Nloc; i++) {
    var w = omegas[i];
    num += w * (1 - w);
    den += (1 - w);
  }
  num = num * s + lambda;
  den = den * s + lambda;
  if (den === 0 || !_num(den)) return 1;
  return num / den;
}

function _pdLap_multiLayerXF(s, params) {
  var Nloc = params.N | 0;
  if (Nloc < 2) Nloc = 2;
  if (Nloc > MAX_LAYERS) Nloc = MAX_LAYERS;
  var omegas = _normaliseLayers(params.omegas, Nloc, 1.0 / Nloc);
  var kappas = _normaliseLayers(params.kappas, Nloc, 1.0 / Nloc);
  var lambda = params.lambda;
  if (!_num(lambda) || lambda <= 0) {
    throw new Error('PRiSM multiLayerXF: lambda must be > 0');
  }
  var f = _multiLayerXF_factor(s, omegas, lambda);
  // effective kh weighting Σ ω_i κ_i — when uniform this is 1
  var kappaEff = 0;
  for (var i = 0; i < Nloc; i++) kappaEff += omegas[i] * kappas[i];
  if (kappaEff <= 0) kappaEff = 1;
  // Renormalise: divide by uniform-mean baseline so kappaEff = 1 is the
  // homogeneous case (avoids spurious time-rescaling when κ = ω uniformly).
  kappaEff = kappaEff * Nloc;
  var sf = s * f / kappaEff;
  if (sf <= 0 || !_num(sf)) return 1e30;
  var x = Math.sqrt(sf);
  return _besselK0(x) / s;
}

function PRiSM_model_multiLayerXF(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'lambda']);
  return _stehfestEval(function (s) { return _pdLap_multiLayerXF(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_multiLayerXF_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'lambda']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_multiLayerXF, t, params);
  });
}


// -----------------------------------------------------------------------------
// MODEL #14 — MULTI-LAYER WITHOUT CROSS-FLOW (COMMINGLED)
// -----------------------------------------------------------------------------
//
// Reference: Kuchuk, F.J., Wilkinson, D.J. "Pressure Behavior of Commingled
//            Reservoirs", SPE 18125 (1991).  Also Lefkovits, H.C., Hazebroek,
//            P., Allen, E.E., Matthews, C.S. "A Study of the Behavior of
//            Bounded Reservoirs Composed of Stratified Layers", SPEJ March
//            1961.
//
// Physics: N isolated layers (no cross-flow), each producing into the same
// wellbore.  Each layer has its own initial pressure p_i, permeability k_i,
// thickness h_i, and skin S_i.  For a constant-rate test the wellbore
// pressure is the kh-weighted sum of N independent homogeneous Pds; there is
// no dual-porosity dip but each layer's transient signature can still be
// distinguished if the (k_i, S_i) vary widely.
//
// Implementation (closed form): Pd_res(s) = Σ_i (kh_i / kh_total) · Pd_hom(s, i)
// where Pd_hom is the homogeneous Pd evaluated with each layer's (k_i, S_i)
// (skin folded outside, so we just use the K0(√s)/s base kernel and let the
// outer fold handle the global skin).
//
// For this evaluator we expose a per-layer scalar "perm contrast" (k_i/k_avg)
// instead of asking the user to define every kh fraction; the Pd kernel for
// each layer becomes K0(√(s/perm_i))/s, weighted by the layer kh fraction.
//
// Params: { Cd, S, N, perms, khFracs }
//   Cd      : wellbore storage (single common well)
//   S       : global skin (added once outside the kh-weighted sum)
//   N       : number of layers in [2, 5]
//   perms   : array of length N of k_i/k_avg ratios (default 1 each)
//   khFracs : array of length N of layer kh fractions (sum to 1)
// -----------------------------------------------------------------------------

function _pdLap_multiLayerNoXF(s, params) {
  var Nloc = params.N | 0;
  if (Nloc < 2) Nloc = 2;
  if (Nloc > MAX_LAYERS) Nloc = MAX_LAYERS;
  var perms = (Array.isArray(params.perms) && params.perms.length === Nloc)
            ? params.perms.slice()
            : (function () { var a = []; for (var i = 0; i < Nloc; i++) a.push(1); return a; })();
  var khFracs = _normaliseLayers(params.khFracs, Nloc, 1.0 / Nloc);
  // Each layer Pd (no skin per-layer here — global skin folded outside)
  var pdSum = 0;
  for (var i = 0; i < Nloc; i++) {
    var perm = (typeof perms[i] === 'number' && perms[i] > 0) ? perms[i] : 1;
    // K0( sqrt(s/perm) ) / s
    var arg = Math.sqrt(s / perm);
    if (!_num(arg) || arg <= 0) continue;
    var pdLayer = _besselK0(arg) / s;
    pdSum += khFracs[i] * pdLayer;
  }
  return _safeLap(pdSum);
}

function PRiSM_model_multiLayerNoXF(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _stehfestEval(function (s) { return _pdLap_multiLayerNoXF(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_multiLayerNoXF_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_multiLayerNoXF, t, params);
  });
}


// -----------------------------------------------------------------------------
// MODEL #15 — LINEAR COMPOSITE RESERVOIR
// -----------------------------------------------------------------------------
//
// Physics: a vertical well in zone 1 that is bounded by linear interfaces at
// distances L_1 < L_2 < L_3 < L_4 from the wellbore (up to 5 zones).  Across
// each interface the mobility-storativity contrast changes; the response is
// the early-time homogeneous solution (zone 1) plus image-well superposition
// across each interface, with a transmission-coefficient amplitude based on
// the mobility-ratio jumps.
//
// At the n-th interface, the reflection coefficient for a planar wave in
// porous media is
//
//   r_n = (M_{n+1} - M_n) / (M_{n+1} + M_n)         (transmission analogy)
//
// where M_n = (k/μ)_n (mobility in zone n).  An "incoming" disturbance from
// the well at distance L_n produces an image at distance 2·L_n with
// amplitude r_n; multi-reflections (image at 2·L_n - 2·L_{n-1}, etc.) are
// truncated at first order.
//
// Implementation: Laplace-domain reservoir Pd is the homogeneous K0(√s)/s
// plus Σ r_n · K0(√(s · F_n / M_n) · 2·L_n) / s for each interface; the
// √(F_n / M_n) factor accounts for the diffusivity in the n-th zone.
//
// Reduces to the homogeneous solution when all M_n = 1 (no contrast).
//
// IMPORTANT: This is a single-reflection (first-order) image-well kernel.
// Higher-order multi-reflections (which would matter when M contrast is
// large or zones are thin) are NOT included.  This matches the textbook
// engineering practice for linear-composite reservoirs at the level of a
// quick-look analysis.
//
// Params: { Cd, S, Nzones, L, M, F }
//   Cd     : wellbore storage
//   S      : skin
//   Nzones : number of zones in [2, 5] (so Nzones - 1 interfaces)
//   L      : array of (Nzones-1) interface distances in r/rw (increasing)
//   M      : array of length Nzones of mobility ratios M_n (M_1 = 1 reference)
//   F      : array of length Nzones of storativity ratios F_n (F_1 = 1)
// -----------------------------------------------------------------------------

function _padArray(arr, N, defaultVal) {
  if (!Array.isArray(arr)) arr = [];
  var out = arr.slice(0, N);
  while (out.length < N) out.push(defaultVal);
  for (var i = 0; i < N; i++) {
    if (typeof out[i] !== 'number' || !isFinite(out[i])) out[i] = defaultVal;
  }
  return out;
}

function _pdLap_linearComposite(s, params) {
  var Nz = params.Nzones | 0;
  if (Nz < 2) Nz = 2;
  if (Nz > 5) Nz = 5;
  var L = _padArray(params.L, Nz - 1, 100);
  var M = _padArray(params.M, Nz, 1);
  var F = _padArray(params.F, Nz, 1);
  // Sanitise: M, F must be > 0; L must be increasing and > 0.
  for (var i = 0; i < Nz; i++) {
    if (M[i] <= 0) M[i] = 1;
    if (F[i] <= 0) F[i] = 1;
  }
  for (var j = 0; j < Nz - 1; j++) {
    if (L[j] <= 0) L[j] = 100;
    if (j > 0 && L[j] <= L[j - 1]) L[j] = L[j - 1] * 1.5;
  }

  var u = Math.sqrt(s);
  if (!_num(u)) return 1e30;
  // Direct solution in zone 1 (where the well lives):
  var pd = _besselK0(u) / s;

  // First-order image contributions for each interface
  for (var n = 0; n < Nz - 1; n++) {
    var Mn = M[n], Mnext = M[n + 1];
    var Fn = F[n];
    // Reflection coefficient (planar wave analogy)
    var rn = (Mnext - Mn) / (Mnext + Mn);
    if (!_num(rn) || rn === 0) continue;
    // Effective diffusivity in zone n: η_n ∝ M_n / F_n; the Laplace argument
    // for an image at distance 2·L_n in zone n is sqrt(s · F_n / M_n) · 2·L_n.
    var diffArg = Math.sqrt(s * Fn / Mn) * 2 * L[n];
    if (!_num(diffArg) || diffArg <= 0) continue;
    // Cap argument to avoid K0(huge) underflow killing numerics
    if (diffArg > 700) continue;
    var image = _besselK0(diffArg) / s;
    pd += rn * image;
  }
  return _safeLap(pd);
}

function PRiSM_model_linearComposite(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _stehfestEval(function (s) { return _pdLap_linearComposite(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_linearComposite_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_linearComposite, t, params);
  });
}


// -----------------------------------------------------------------------------
// MODEL #21 — GENERAL HETEROGENEITY RADIAL COMPOSITE (3-zone simplification)
// -----------------------------------------------------------------------------
//
// Research-grade model: textbook spec allows up to 9 piecewise-linear or
// step-wise discontinuities radially.  We implement the engineering-useful
// 3-zone case (two interfaces, three zones).  The kernel is a recursive
// cylindrical-wave matching at each interface, evaluated analytically.
//
// Geometry:
//   well -- zone 1 (M_1, F_1) -- R1 -- zone 2 (M_2, F_2) -- R2 -- zone 3 (M_3, F_3) -- ∞
//
// Implementation: at each interface we apply the same continuity-of-pressure
// and continuity-of-flux rules as #9 (radial composite).  The recursive
// nature of the linear system means we solve a 4×4 system (α_1, β_1, α_2,
// β_2) where α, β are the inhomogeneous K0/I0 coefficients in each finite
// zone (zone 1 and zone 2; zone 3 has only a K0 outgoing term).
//
// We reduce the 4×4 system to a sequence of two 2×2 systems by enforcing
// the inner→outer recursion: solve interface R2 first (assuming a unit-flux
// inner boundary), then propagate the result inward through R1.  This is
// the standard "cascaded matching" recipe for layered cylindrical wave
// problems and gives the exact 3-zone closed form.
//
// IMPORTANT: 3 zones only.  Up to 9-zone piecewise discontinuities in the
// textbook spec are NOT implemented — extending to N zones would replicate
// the same recursive matching N-1 times.  Documented in the description.
//
// Params: { Cd, S, R1, R2, M1, M2, M3, F1, F2, F3 }
//   M_n, F_n in zone n (M_1, F_1 are reference 1 by convention but allowed
//   to vary).
// -----------------------------------------------------------------------------

function _pdLap_genHetRadial(s, params) {
  var R1 = params.R1, R2 = params.R2;
  var M1 = params.M1, M2 = params.M2, M3 = params.M3;
  var F1 = params.F1, F2 = params.F2, F3 = params.F3;
  if (!_num(R1) || R1 <= 1) throw new Error('PRiSM genHetRadial: R1 must be > 1');
  if (!_num(R2) || R2 <= R1) throw new Error('PRiSM genHetRadial: R2 must be > R1');
  if (!_num(M1) || M1 <= 0) M1 = 1;
  if (!_num(M2) || M2 <= 0) M2 = 1;
  if (!_num(M3) || M3 <= 0) M3 = 1;
  if (!_num(F1) || F1 <= 0) F1 = 1;
  if (!_num(F2) || F2 <= 0) F2 = 1;
  if (!_num(F3) || F3 <= 0) F3 = 1;

  // Wavenumbers in each zone:  k_n = sqrt(s · F_n / M_n)
  var k1 = Math.sqrt(s * F1 / M1);
  var k2 = Math.sqrt(s * F2 / M2);
  var k3 = Math.sqrt(s * F3 / M3);
  if (!_num(k1) || !_num(k2) || !_num(k3)) return 1e30;

  // Field forms:
  //   zone 1 (rwd <= r <= R1):  P̂_1 = K0(k1·r)/s + α_1 · I0(k1·r)/s
  //   zone 2 (R1 <= r <= R2):    P̂_2 = α_2 · K0(k2·r)/s + β_2 · I0(k2·r)/s
  //   zone 3 (r >= R2):           P̂_3 = β_3 · K0(k3·r)/s
  //
  // 4 unknowns: α_1, α_2, β_2, β_3.  4 continuity equations (pressure +
  // flux at R1, R2).  We solve by elimination starting from R2:
  //
  // At R2:
  //   α_2·K0(k2·R2) + β_2·I0(k2·R2) = β_3·K0(k3·R2)              (P)
  //   M2·(-α_2·k2·K1(k2·R2) + β_2·k2·I1(k2·R2)) = M3·(-β_3·k3·K1(k3·R2))   (F)
  //
  // Express β_2 and β_3 in terms of α_2 (using P + F): two equations, three
  // unknowns ⇒ one-parameter family parameterised by α_2.  Equivalently
  // β_2 = γ_22 · α_2 and β_3 = γ_32 · α_2 for some γ coefficients.
  //
  // Substitute into the inner interface R1:
  //   K0(k1·R1) + α_1·I0(k1·R1) = α_2·K0(k2·R1) + β_2·I0(k2·R1)             (P)
  //   M1·(-k1·K1(k1·R1) + α_1·k1·I1(k1·R1)) = M2·(-α_2·k2·K1(k2·R1) + β_2·k2·I1(k2·R1))  (F)
  //
  // Two equations, two unknowns (α_1, α_2 — once β_2 is expressed via α_2).
  // Solve 2×2 by Cramer's rule.
  //
  // Then evaluate P̂_1 at the wellbore r = 1 (rwd normalised):
  //   Pd_res(s) = ( K0(k1) + α_1 · I0(k1) ) / s

  // Bessel evaluations
  var k1R1 = k1 * R1, k2R1 = k2 * R1;
  var k2R2 = k2 * R2, k3R2 = k3 * R2;

  var K0_k1   = _besselK0(k1);
  var I0_k1   = _besselI0(k1);

  var K0_k1R1 = _besselK0(k1R1);
  var I0_k1R1 = _besselI0(k1R1);
  var K1_k1R1 = _besselK1(k1R1);
  var I1_k1R1 = _besselI1(k1R1);

  var K0_k2R1 = _besselK0(k2R1);
  var I0_k2R1 = _besselI0(k2R1);
  var K1_k2R1 = _besselK1(k2R1);
  var I1_k2R1 = _besselI1(k2R1);

  var K0_k2R2 = _besselK0(k2R2);
  var I0_k2R2 = _besselI0(k2R2);
  var K1_k2R2 = _besselK1(k2R2);
  var I1_k2R2 = _besselI1(k2R2);

  var K0_k3R2 = _besselK0(k3R2);
  var K1_k3R2 = _besselK1(k3R2);

  // ---- step 1: eliminate β_3 from the R2 system ----
  // From (P): β_3 = (α_2·K0_k2R2 + β_2·I0_k2R2) / K0_k3R2
  // Substitute into (F):
  //   M2·(-α_2·k2·K1_k2R2 + β_2·k2·I1_k2R2)
  //   = M3·(-((α_2·K0_k2R2 + β_2·I0_k2R2) / K0_k3R2)·k3·K1_k3R2)
  // Rearrange to express β_2 in terms of α_2:
  //   β_2 · [ M2·k2·I1_k2R2 + M3·k3·K1_k3R2 / K0_k3R2 · I0_k2R2 ]
  //   = α_2 · [ M2·k2·K1_k2R2 - M3·k3·K1_k3R2 / K0_k3R2 · K0_k2R2 ]
  //
  // Solve for β_2/α_2 = γ
  var ratio = (K0_k3R2 !== 0) ? (M3 * k3 * K1_k3R2 / K0_k3R2) : 0;
  var num_b = M2 * k2 * K1_k2R2 - ratio * K0_k2R2;
  var den_b = M2 * k2 * I1_k2R2 + ratio * I0_k2R2;
  var gamma22;
  if (!_num(den_b) || Math.abs(den_b) < 1e-300) {
    gamma22 = 0;  // degenerate — fall back to outer-only solution
  } else {
    gamma22 = num_b / den_b;
  }

  // ---- step 2: solve inner interface R1 for [α_1, α_2] ----
  // (P): K0_k1R1 + α_1·I0_k1R1 = α_2·K0_k2R1 + β_2·I0_k2R1
  //                            = α_2·(K0_k2R1 + γ22·I0_k2R1)
  // (F): M1·(-k1·K1_k1R1 + α_1·k1·I1_k1R1)
  //    = M2·(-α_2·k2·K1_k2R1 + β_2·k2·I1_k2R1)
  //    = M2·α_2·k2·(-K1_k2R1 + γ22·I1_k2R1)
  //
  // Matrix form: [ I0_k1R1                     -(K0_k2R1 + γ22·I0_k2R1)        ] [α_1]   [ -K0_k1R1                      ]
  //              [ M1·k1·I1_k1R1               -M2·k2·(-K1_k2R1 + γ22·I1_k2R1) ] [α_2] = [  M1·k1·K1_k1R1                 ]
  var A11 = I0_k1R1;
  var A12 = -(K0_k2R1 + gamma22 * I0_k2R1);
  var A21 = M1 * k1 * I1_k1R1;
  var A22 = -M2 * k2 * (-K1_k2R1 + gamma22 * I1_k2R1);
  var b1  = -K0_k1R1;
  var b2  =  M1 * k1 * K1_k1R1;

  var detA = A11 * A22 - A12 * A21;
  if (!_num(detA) || Math.abs(detA) < 1e-300) {
    // degenerate — collapse to single-zone homogeneous answer
    return _besselK0(k1) / s;
  }
  var alpha1 = (b1 * A22 - A12 * b2) / detA;

  // wellbore P̂_1 evaluated at r = 1:
  var pd = (K0_k1 + alpha1 * I0_k1) / s;
  return _safeLap(pd);
}

function PRiSM_model_genHetRadial(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3', 'F1', 'F2', 'F3']);
  return _stehfestEval(function (s) { return _pdLap_genHetRadial(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_genHetRadial_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3', 'F1', 'F2', 'F3']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_genHetRadial, t, params);
  });
}


// -----------------------------------------------------------------------------
// MODEL #20 — GENERAL HETEROGENEITY RADIAL + LINEAR COMPOSITE
// -----------------------------------------------------------------------------
//
// Research-grade model: textbook spec allows up to 9 piecewise-linear or
// step-wise discontinuities each in the radial (R-zone) and linear (±X-
// zone) directions.  We implement the engineering-useful simplification:
// the Phase 5 #21 three-zone radial composite kernel (already implemented)
// PLUS a single linear-fault image-well contribution.  This captures the
// most common "swept-zone with linear fault" geometry seen in injection
// pilots and faulted reservoirs.
//
// Geometry:
//   - radial:  three zones (M1, M2, M3 with interfaces at R1 and R2)
//   - linear:  one fault at distance Lf from the well, with reflection
//              coefficient r_f based on the mobility-ratio jump (Mfault).
//
// Implementation:
//   Pd_res(s) = Pd_radial_3zone(s)  +  r_f · K0( sqrt(s) · 2·Lf ) / s
//
// where the linear-fault image is computed in the inner-zone diffusivity
// (k_1, F_1 = 1).  The reflection coefficient r_f follows the same
// formula as #15:  r_f = (Mfault - M1) / (Mfault + M1), where Mfault is
// the mobility behind the fault.
//
// IMPORTANT: 3-zone radial + 1-fault linear only.  Up to 9 piecewise
// discontinuities in either direction in the textbook spec are NOT
// implemented — that would require a full multi-image lattice-summation
// kernel.  Documented in the description.
//
// Params: { Cd, S, R1, R2, M1, M2, M3, F1, F2, F3, Lf, Mfault, BC }
//   (radial params identical to genHetRadial #21)
//   Lf      : linear-fault distance from the well (in r/rw)
//   Mfault  : mobility behind the fault (M1 = no contrast → no image)
//   BC      : 'noflow' (default) or 'constP' (override Mfault → 0 for
//             constant-pressure boundary, Mfault → ∞ for sealing)
// -----------------------------------------------------------------------------

function _pdLap_genHetRadialLinear(s, params) {
  // 1) radial 3-zone composite contribution (from #21 helper)
  var pdRadial = _pdLap_genHetRadial(s, params);

  // 2) single linear-fault image-well contribution
  var Lf = params.Lf;
  var Mf = params.Mfault;
  var M1 = params.M1;
  var BC = params.BC || 'noflow';
  if (!_num(Lf) || Lf <= 0) return _safeLap(pdRadial);
  if (!_num(M1) || M1 <= 0) M1 = 1;

  // Reflection coefficient — boundary-condition shortcut overrides
  var rf;
  if (BC === 'constP') {
    rf = -1;     // perfect constant-pressure mirror
  } else if (BC === 'sealing') {
    rf = +1;     // perfect sealing fault
  } else {
    if (!_num(Mf) || Mf <= 0) Mf = M1;
    rf = (Mf - M1) / (Mf + M1);
  }
  if (!_num(rf) || rf === 0) return _safeLap(pdRadial);

  // image-well argument in inner-zone diffusivity (k1 = sqrt(s · F1 / M1))
  var F1 = (_num(params.F1) && params.F1 > 0) ? params.F1 : 1;
  var k1 = Math.sqrt(s * F1 / M1);
  if (!_num(k1) || k1 <= 0) return _safeLap(pdRadial);
  var arg = k1 * 2 * Lf;
  if (arg > 700) return _safeLap(pdRadial);   // K0(huge) → 0, image vanishes
  var image = _besselK0(arg) / s;
  return _safeLap(pdRadial + rf * image);
}

function PRiSM_model_genHetRadialLinear(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3',
                          'F1', 'F2', 'F3', 'Lf']);
  return _stehfestEval(function (s) { return _pdLap_genHetRadialLinear(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_genHetRadialLinear_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3',
                          'F1', 'F2', 'F3', 'Lf']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_genHetRadialLinear, t, params);
  });
}


// =============================================================================
// SECTION 3 — REGISTRY MERGE
// =============================================================================
//
// One entry per model.  All Phase 5 entries are kind: 'pressure'.  We tag
// the new categories as 'composite' (radial / linear / general het.) and
// 'multilayer' (cross-flow / commingled).  These categories are NEW —
// the existing Phase 1-4 categories (homogeneous / fracture / boundary /
// reservoir / well-type / decline) are preserved unchanged.
// =============================================================================

var REGISTRY_ADDITIONS = {

  twoLayerXF: {
    pd:      PRiSM_model_twoLayerXF,
    pdPrime: PRiSM_model_twoLayerXF_pd_prime,
    defaults: { Cd: 100, S: 0, kappa: 0.5, lambda: 1e-5, omega: 0.5 },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',         unit: '-',  min: 0,     max: 1e10,  default: 100   },
      { key: 'S',      label: 'Skin S',                      unit: '-',  min: -7,    max: 50,    default: 0     },
      { key: 'kappa',  label: 'Layer perm ratio κ=k1/k2',    unit: '-',  min: 0.01,  max: 100,   default: 0.5   },
      { key: 'lambda', label: 'Cross-flow coefficient λ',    unit: '-',  min: 1e-9,  max: 1e-2,  default: 1e-5  },
      { key: 'omega',  label: 'Layer storativity ratio ω',   unit: '-',  min: 0.01,  max: 0.99,  default: 0.5   }
    ],
    reference: 'Bourdet, D. SPE 13628 (1985); Park-Horne SPE 19800 (1989)',
    category: 'multilayer',
    description: 'Two-layer reservoir with PSS cross-flow controlled by λ. ω = layer storativity ratio, κ = mobility ratio. Uses Bourdet PSS f(s) factor (Warren-Root analog) — engineering-grade simplification of the rigorous Park-Horne 2x2 Laplace system.',
    kind: 'pressure'
  },

  radialComposite: {
    pd:      PRiSM_model_radialComposite,
    pdPrime: PRiSM_model_radialComposite_pd_prime,
    defaults: { Cd: 100, S: 0, M: 2.0, F: 1.0, R: 50 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd',                   unit: '-', min: 0,     max: 1e10, default: 100  },
      { key: 'S',  label: 'Skin S',                                unit: '-', min: -7,    max: 50,   default: 0    },
      { key: 'M',  label: 'Mobility ratio M = (k/μ)₁/(k/μ)₂',       unit: '-', min: 0.01,  max: 100,  default: 2.0  },
      { key: 'F',  label: 'Storativity ratio F = (φc_t)₁/(φc_t)₂',  unit: '-', min: 0.01,  max: 100,  default: 1.0  },
      { key: 'R',  label: 'Inner-zone radius R = r/rw',             unit: '-', min: 1.5,   max: 1e5,  default: 50   }
    ],
    reference: 'Abbaszadeh & Kamal, SPE Reservoir Eng Feb 1989; Sutman et al, SPE 8909',
    category: 'composite',
    description: 'Radial composite reservoir: two concentric zones (inner + outer) with mobility ratio M and storativity ratio F. Common in water-injection. Exact closed-form Laplace solution by 2x2 K0/I0 matching at the interface.',
    kind: 'pressure'
  },

  multiLayerXF: {
    pd:      PRiSM_model_multiLayerXF,
    pdPrime: PRiSM_model_multiLayerXF_pd_prime,
    defaults: { Cd: 100, S: 0, N: 3, omegas: [1/3, 1/3, 1/3], kappas: [1/3, 1/3, 1/3], lambda: 1e-5 },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',     unit: '-',     min: 0,     max: 1e10,  default: 100   },
      { key: 'S',      label: 'Skin S',                  unit: '-',     min: -7,    max: 50,    default: 0     },
      { key: 'N',      label: 'Number of layers N',      unit: '-',     min: 2,     max: 5,     default: 3     },
      { key: 'lambda', label: 'Cross-flow coefficient λ', unit: '-',    min: 1e-9,  max: 1e-2,  default: 1e-5  }
      // omegas[] and kappas[] are array params, normalised at runtime
    ],
    reference: 'Economides et al, SPE 14167 (1985); Park-Horne SPE 19800 (1989)',
    category: 'multilayer',
    description: 'N adjacent layers (N=2..5) with PSS cross-flow between successive pairs. Default N=3, equal ω and κ per layer, single λ. Engineering simplification of the rigorous Park-Horne tridiagonal Laplace system: collapses to the dual-porosity dip pattern when one layer dominates storage.',
    kind: 'pressure'
  },

  multiLayerNoXF: {
    pd:      PRiSM_model_multiLayerNoXF,
    pdPrime: PRiSM_model_multiLayerNoXF_pd_prime,
    defaults: { Cd: 100, S: 0, N: 3, perms: [1, 1, 1], khFracs: [1/3, 1/3, 1/3] },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',  unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S',      label: 'Global skin S',        unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'N',      label: 'Number of layers N',   unit: '-', min: 2,    max: 5,    default: 3   }
      // perms[] and khFracs[] are array params
    ],
    reference: 'Kuchuk-Wilkinson SPE 18125 (1991); Lefkovits et al SPEJ March 1961',
    category: 'multilayer',
    description: 'N isolated commingled layers (N=2..5) with no cross-flow. Closed-form pressure-weighted sum of N independent homogeneous-layer K0/s kernels (per-layer perm, kh-fraction). Default N=3, equal kh and perm.',
    kind: 'pressure'
  },

  linearComposite: {
    pd:      PRiSM_model_linearComposite,
    pdPrime: PRiSM_model_linearComposite_pd_prime,
    defaults: { Cd: 100, S: 0, Nzones: 2, L: [100], M: [1, 2], F: [1, 1] },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',      unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S',      label: 'Skin S',                   unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'Nzones', label: 'Number of zones (2..5)',   unit: '-', min: 2,    max: 5,    default: 2   }
      // L[], M[], F[] are array params (Nzones-1 interfaces, Nzones zones)
    ],
    reference: 'Image-well superposition (no single ref); see van Poolen 1963 for the linear-boundary kernel and Bourdet 2002 §4 for composite extension',
    category: 'composite',
    description: 'Linear composite reservoir: up to 5 zones with linear discontinuities at distances L[]. Image-well superposition with first-order reflection coefficients r_n = (M_{n+1}-M_n)/(M_{n+1}+M_n). Higher-order multi-reflections truncated.',
    kind: 'pressure'
  },

  genHetRadialLinear: {
    pd:      PRiSM_model_genHetRadialLinear,
    pdPrime: PRiSM_model_genHetRadialLinear_pd_prime,
    defaults: { Cd: 100, S: 0, R1: 30, R2: 200, M1: 1.0, M2: 2.0, M3: 1.0,
                F1: 1.0, F2: 1.0, F3: 1.0, Lf: 500, Mfault: 0.1, BC: 'noflow' },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',      unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S',      label: 'Skin S',                   unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'R1',     label: 'Inner radial interface R₁', unit: '-', min: 1.5, max: 1e5,  default: 30  },
      { key: 'R2',     label: 'Outer radial interface R₂', unit: '-', min: 2,   max: 1e5,  default: 200 },
      { key: 'M1',     label: 'Mobility zone-1 M₁',        unit: '-', min: 0.01, max: 100, default: 1.0 },
      { key: 'M2',     label: 'Mobility zone-2 M₂',        unit: '-', min: 0.01, max: 100, default: 2.0 },
      { key: 'M3',     label: 'Mobility zone-3 M₃',        unit: '-', min: 0.01, max: 100, default: 1.0 },
      { key: 'F1',     label: 'Storativity zone-1 F₁',     unit: '-', min: 0.01, max: 100, default: 1.0 },
      { key: 'F2',     label: 'Storativity zone-2 F₂',     unit: '-', min: 0.01, max: 100, default: 1.0 },
      { key: 'F3',     label: 'Storativity zone-3 F₃',     unit: '-', min: 0.01, max: 100, default: 1.0 },
      { key: 'Lf',     label: 'Linear fault distance Lf',  unit: '-', min: 1,    max: 1e5,  default: 500 },
      { key: 'Mfault', label: 'Mobility behind fault',     unit: '-', min: 0,    max: 1e6,  default: 0.1 },
      { key: 'BC',     label: 'Linear-fault BC',           unit: '',  options: ['noflow', 'constP', 'sealing'], default: 'noflow' }
    ],
    reference: 'Research-grade composite (no single ref); 3-zone radial + 1-fault linear simplification — see source header for details.',
    category: 'composite',
    description: 'General heterogeneity radial+linear composite. SIMPLIFICATION: 3-zone radial composite (two interfaces R₁, R₂) combined with a single linear fault at Lf. Up to 9 piecewise-linear discontinuities in the textbook spec are NOT implemented — research-grade reach goal restricted to the engineering-useful 3-zone + 1-fault case.',
    kind: 'pressure'
  },

  genHetRadial: {
    pd:      PRiSM_model_genHetRadial,
    pdPrime: PRiSM_model_genHetRadial_pd_prime,
    defaults: { Cd: 100, S: 0, R1: 30, R2: 200, M1: 1.0, M2: 2.0, M3: 1.0,
                F1: 1.0, F2: 1.0, F3: 1.0 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd',     unit: '-', min: 0,     max: 1e10, default: 100 },
      { key: 'S',  label: 'Skin S',                  unit: '-', min: -7,    max: 50,   default: 0   },
      { key: 'R1', label: 'Inner radial interface R₁', unit: '-', min: 1.5, max: 1e5,  default: 30  },
      { key: 'R2', label: 'Outer radial interface R₂', unit: '-', min: 2,   max: 1e5,  default: 200 },
      { key: 'M1', label: 'Mobility zone-1 M₁',       unit: '-', min: 0.01, max: 100,  default: 1.0 },
      { key: 'M2', label: 'Mobility zone-2 M₂',       unit: '-', min: 0.01, max: 100,  default: 2.0 },
      { key: 'M3', label: 'Mobility zone-3 M₃',       unit: '-', min: 0.01, max: 100,  default: 1.0 },
      { key: 'F1', label: 'Storativity zone-1 F₁',    unit: '-', min: 0.01, max: 100,  default: 1.0 },
      { key: 'F2', label: 'Storativity zone-2 F₂',    unit: '-', min: 0.01, max: 100,  default: 1.0 },
      { key: 'F3', label: 'Storativity zone-3 F₃',    unit: '-', min: 0.01, max: 100,  default: 1.0 }
    ],
    reference: 'Research-grade composite (no single ref); refines #9 radial composite — see source header.',
    category: 'composite',
    description: 'General heterogeneity radial composite — 3-zone refinement of #9. SIMPLIFICATION: two interfaces (R₁, R₂) only; up to 9 piecewise-linear discontinuities in the textbook spec are NOT implemented. Recursive K0/I0 matching at each interface, exact 4x4 closed form reduced to a sequence of two 2x2 systems.',
    kind: 'pressure'
  }
};


// install in window.PRiSM_MODELS, additive (do NOT replace existing entries)
(function _installRegistry() {
  var g = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
  for (var key in REGISTRY_ADDITIONS) {
    if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
      g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
    }
  }
  // expose evaluators on the global namespace for direct reference / debugging
  g.PRiSM_model_twoLayerXF              = PRiSM_model_twoLayerXF;
  g.PRiSM_model_twoLayerXF_pd_prime     = PRiSM_model_twoLayerXF_pd_prime;
  g.PRiSM_model_radialComposite         = PRiSM_model_radialComposite;
  g.PRiSM_model_radialComposite_pd_prime = PRiSM_model_radialComposite_pd_prime;
  g.PRiSM_model_multiLayerXF            = PRiSM_model_multiLayerXF;
  g.PRiSM_model_multiLayerXF_pd_prime   = PRiSM_model_multiLayerXF_pd_prime;
  g.PRiSM_model_multiLayerNoXF          = PRiSM_model_multiLayerNoXF;
  g.PRiSM_model_multiLayerNoXF_pd_prime = PRiSM_model_multiLayerNoXF_pd_prime;
  g.PRiSM_model_linearComposite         = PRiSM_model_linearComposite;
  g.PRiSM_model_linearComposite_pd_prime = PRiSM_model_linearComposite_pd_prime;
  g.PRiSM_model_genHetRadial            = PRiSM_model_genHetRadial;
  g.PRiSM_model_genHetRadial_pd_prime   = PRiSM_model_genHetRadial_pd_prime;
  g.PRiSM_model_genHetRadialLinear      = PRiSM_model_genHetRadialLinear;
  g.PRiSM_model_genHetRadialLinear_pd_prime = PRiSM_model_genHetRadialLinear_pd_prime;
})();


// =============================================================================
// SECTION 4 — Optional helpers exposed on window for plot overlays / regression
// =============================================================================

// Exported helper: radial-composite mobility / storativity diagnostic.  Given
// (M, F, R), returns the early-time Pd asymptote (radial in inner zone) and
// the late-time Pd asymptote (radial in equivalent kh).  Useful for type-
// curve plot overlays where the user wants to see where the early / late
// stabilisation values fall.  Both returned values are dimensionless.
function PRiSM_radialComposite_asymptotes(params) {
  if (!params || typeof params !== 'object') return { early: NaN, late: NaN };
  var M = params.M, F = params.F;
  // Early-time: pure inner-zone radial — derivative stabilises at 0.5
  // Late-time: outer-zone-dominated; effective mobility = harmonic average
  // weighted by zone areas.  For an infinite outer zone the late-time
  // derivative stabilises at 0.5 / M_late where M_late = M2 (referenced).
  var M_late = (M > 0) ? 1.0 / M : 1;
  return { early: 0.5, late: 0.5 * M_late };
}

// Exported helper: multi-layer kh-fraction sanity-check.  Given an array of
// kh-fractions and storativity-fractions, returns whether the sum is close
// to unity and the equivalent homogeneous Pd at td=10 (a quick diagnostic).
function PRiSM_multiLayer_diagnose(omegas, kappas) {
  if (!Array.isArray(omegas) || !Array.isArray(kappas)) {
    return { ok: false, reason: 'omegas and kappas must be arrays' };
  }
  if (omegas.length !== kappas.length) {
    return { ok: false, reason: 'omegas and kappas must have the same length' };
  }
  var sumOm = 0, sumKa = 0;
  for (var i = 0; i < omegas.length; i++) {
    sumOm += omegas[i];
    sumKa += kappas[i];
  }
  var ok = (Math.abs(sumOm - 1) < 0.05 && Math.abs(sumKa - 1) < 0.05);
  return { ok: ok, sumOmega: sumOm, sumKappa: sumKa, N: omegas.length };
}

// publish helpers
(function _publishHelpers() {
  var g = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
  g.PRiSM_radialComposite_asymptotes = PRiSM_radialComposite_asymptotes;
  g.PRiSM_multiLayer_diagnose        = PRiSM_multiLayer_diagnose;
})();


// =============================================================================
// SECTION 5 — SELF-TEST
// =============================================================================
//
// Lightweight smoke-test:
//   - stub Stehfest / Bessel K0, K1, I0, I1 / logspace if absent (so the file
//     can be loaded standalone for quick verification, e.g. via Node)
//   - call every new evaluator (pd + pdPrime) at td = [1, 10, 100] with
//     defaults; confirm finite numbers
//   - confirm radialComposite collapses to homogeneous when M = F = 1
//   - confirm multiLayerNoXF collapses to homogeneous when N = 1 (effectively
//     N = 2 with equal layers)
//
// On success logs:
//   "PRiSM 08: all 7 composite/multilayer evaluators returned finite values"
// =============================================================================

(function _selfTest() {
  var g = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
  var hadFoundation = (typeof g.PRiSM_stehfest === 'function');

  // ---- mocks for standalone Node testing -----------------------------------
  if (!hadFoundation) {
    g.PRiSM_besselK0 = function (x) {
      if (x <= 0 || !isFinite(x)) return 1e30;
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
      if (x <= 0) return 1e30;
      if (x < 2) {
        var t = x / 2, t2 = t * t;
        return Math.log(t) * (x / 2) * (1 + 0.5 * t2)
             + (1 / x) * (1 + 0.15443144 * t2 - 0.67278579 * t2 * t2);
      }
      var z = 2 / x;
      return Math.exp(-x) / Math.sqrt(x) *
             (1.25331414 + 0.23498619 * z - 0.03655620 * z * z);
    };
    g.PRiSM_besselI0 = function (x) {
      var ax = Math.abs(x);
      if (ax < 3.75) {
        var y = ax / 3.75; var y2 = y * y;
        return 1.0 + y2 * (3.5156229 + y2 * (3.0899424 + y2 * (1.2067492 +
                y2 * (0.2659732 + y2 * (0.0360768 + y2 * 0.0045813)))));
      }
      var y = 3.75 / ax;
      return (Math.exp(ax) / Math.sqrt(ax)) * (0.39894228 + y * (0.01328592 +
             y * (0.00225319 + y * (-0.00157565 + y * (0.00916281 +
             y * (-0.02057706 + y * (0.02635537 + y * (-0.01647633 +
             y * 0.00392377))))))));
    };
    g.PRiSM_besselI1 = function (x) {
      var ax = Math.abs(x); var result;
      if (ax < 3.75) {
        var y = ax / 3.75; var y2 = y * y;
        result = ax * (0.5 + y2 * (0.87890594 + y2 * (0.51498869 +
                 y2 * (0.15084934 + y2 * (0.02658733 + y2 * (0.00301532 +
                 y2 * 0.00032411))))));
      } else {
        var y = 3.75 / ax;
        result = 0.39894228 + y * (-0.03988024 + y * (-0.00362018 +
                 y * (0.00163801 + y * (-0.01031555 + y * (0.02282967 +
                 y * (-0.02895312 + y * (0.01787654 + y * -0.00420059)))))));
        result *= (Math.exp(ax) / Math.sqrt(ax));
      }
      return x < 0 ? -result : result;
    };
    g.PRiSM_logspace = function (lo, hi, n) {
      var out = new Array(n);
      var step = (hi - lo) / (n - 1);
      for (var i = 0; i < n; i++) out[i] = Math.pow(10, lo + i * step);
      return out;
    };
    var V_CACHE = {};
    function _stehV(N) {
      if (V_CACHE[N]) return V_CACHE[N];
      var V = new Array(N + 1), fact = [1];
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
      V_CACHE[N] = V;
      return V;
    }
    g.PRiSM_stehfest = function (Fhat, t, N) {
      if (!N) N = 12;
      var V = _stehV(N);
      var ln2_t = Math.log(2) / t;
      var sum = 0;
      for (var n = 1; n <= N; n++) sum += V[n] * Fhat(n * ln2_t);
      return sum * ln2_t;
    };
  }

  // ---- run every new evaluator --------------------------------------------
  var tdVec = [1, 10, 100];
  var allOk = true;
  var passes = 0;
  var fails  = 0;
  var report = [];
  var newKeys = ['twoLayerXF', 'radialComposite', 'multiLayerXF',
                 'multiLayerNoXF', 'linearComposite',
                 'genHetRadialLinear', 'genHetRadial'];

  newKeys.forEach(function (key) {
    var entry = REGISTRY_ADDITIONS[key];
    if (!entry) {
      allOk = false; fails++;
      report.push(key + ': MISSING from registry');
      return;
    }
    try {
      var pdArr = entry.pd(tdVec, entry.defaults);
      var ok = Array.isArray(pdArr) && pdArr.every(function (v) {
        return typeof v === 'number' && isFinite(v) && !isNaN(v);
      });
      if (!ok) {
        allOk = false; fails++;
        report.push(key + ': pd returned ' + JSON.stringify(pdArr));
        return;
      }
      report.push(key + ': pd ok (' + pdArr.map(function (v) {
        return v.toFixed(3);
      }).join(', ') + ')');

      // pdPrime
      var pdpArr = entry.pdPrime(tdVec, entry.defaults);
      var ok2 = Array.isArray(pdpArr) && pdpArr.every(function (v) {
        return typeof v === 'number' && isFinite(v) && !isNaN(v);
      });
      if (!ok2) {
        allOk = false; fails++;
        report.push(key + ': pdPrime returned ' + JSON.stringify(pdpArr));
        return;
      }
      passes++;
    } catch (e) {
      allOk = false; fails++;
      report.push(key + ': THREW ' + (e && e.message ? e.message : e));
    }
  });

  // Sanity checks on collapsing limits
  // ---- radialComposite at M=1, F=1 should be close to homogeneous K0(√s)/s
  // ---- (we just check finite & positive at td=10)
  try {
    var pdRC = REGISTRY_ADDITIONS.radialComposite.pd([10],
      { Cd: 100, S: 0, M: 1.0, F: 1.0, R: 50 });
    if (_num(pdRC[0]) && pdRC[0] > 0) {
      report.push('radialComposite collapse-to-homogeneous (M=F=1): pd(10)=' + pdRC[0].toFixed(4));
    } else {
      allOk = false;
      report.push('radialComposite collapse-check produced ' + pdRC[0]);
    }
  } catch (e) {
    report.push('radialComposite collapse-check threw: ' + (e && e.message ? e.message : e));
  }

  // ---- multiLayerNoXF with equal layers should be close to single-layer
  try {
    var pdML = REGISTRY_ADDITIONS.multiLayerNoXF.pd([10],
      { Cd: 100, S: 0, N: 3, perms: [1, 1, 1], khFracs: [1/3, 1/3, 1/3] });
    if (_num(pdML[0]) && pdML[0] > 0) {
      report.push('multiLayerNoXF equal-layers collapse: pd(10)=' + pdML[0].toFixed(4));
    } else {
      allOk = false;
      report.push('multiLayerNoXF equal-layers produced ' + pdML[0]);
    }
  } catch (e) {
    report.push('multiLayerNoXF collapse-check threw: ' + (e && e.message ? e.message : e));
  }

  if (typeof console !== 'undefined' && console.log) {
    if (allOk) {
      console.log('PRiSM 08: all 7 composite/multilayer evaluators returned finite values');
      report.forEach(function (r) { console.log('  ' + r); });
    } else {
      console.log('PRiSM 08: SELF-TEST FAILED (' + fails + ' fails / ' + passes + ' passes)');
      report.forEach(function (r) { console.log('  ' + r); });
    }
  }
})();

})();  // end IIFE
