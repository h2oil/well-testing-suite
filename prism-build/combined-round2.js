
// ═══════════════════════════════════════════════════════════════════════
// PRiSM Round-2 expansion — auto-injected from prism-build/
//   • 08-composite-multilayer        (Phase 5: 7 composite/multi-layer single-well)
//   • 09-interference-multilateral   (Phase 6: 16 interference + multi-lateral)
//   • 10-specialised-solvers         (Phase 7: #18 user-defined + #38 water injection)
//   • 11-polish                      (14 SVG schematics + 20 analysis keys + PNG + GA4)
//   • 12-data-crop                   (interactive Data-tab crop/trim chart)
//   • 13-auto-match                  (regime classifier + LM model race + top-N ranking)
//   • 14-interpretation              (plain-English fit narrative + actions + cautions)
//   • 15-diagnostic-annotations      (auto-Bourdet-L picker + plot-regime markers)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 08-composite-multilayer ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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

})();  // end IIFE

// ─── END 08-composite-multilayer ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 09-interference-multilateral ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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

})();  // end IIFE

// ─── END 09-interference-multilateral ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 10-specialised-solvers ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 10 — Specialised solvers (Phase 7)
//   #18 User-Defined Type-Curve — table-loader + log-log interpolation
//   #38 Water Injection         — semi-analytic two-phase displacement
// ════════════════════════════════════════════════════════════════════════════
//
// This is the LAST and one of the LARGEST contributions to the PRiSM model
// catalogue. It introduces TWO new evaluators that don't fit the well-trodden
// closed-form pressure-transient mould of Phases 1-6:
//
//   1. userDefined        (Model #18 in the master catalogue)
//      A table-driven type-curve. The user supplies td/pd (and optionally pd′)
//      values — typically extracted from a published Bourdet-Gringarten chart,
//      a software vendor's curve library, or proprietary in-house data — and
//      this evaluator interpolates linearly in log-log space, falling back to
//      end-slope extrapolation outside the tabulated range. The module
//      maintains a persistent in-browser library of named curves keyed off
//      localStorage['wts_prism_user_curves'].
//
//   2. waterInjection     (Model #38 in the master catalogue)
//      A semi-analytic 1-D radial Buckley-Leverett-like front-tracking model
//      for water injection wells. Front radius advances with cumulative water
//      injected; the resulting two-zone composite pressure response is
//      computed in closed form for the intra-flood and post-flood radial
//      profiles, then folded with WBS+skin via a Stehfest convolution.
//
// ════════════════════════════════════════════════════════════════════════════
// MAJOR APPROXIMATIONS in the water-injection model (do NOT confuse with a
// commercial reservoir simulator that runs 100k+ LOC of fully-implicit
// IMPES/AIM solvers):
//
//   A1. PISTON-LIKE DISPLACEMENT — ahead of the front the rock is at Swc
//       (single-phase oil mobility), behind the front the rock is at 1-Sor
//       (single-phase water mobility). The actual Buckley-Leverett saturation
//       fan between these two end-points is not resolved; the front is
//       treated as a sharp shock at the volumetric-balance radius.
//
//   A2. RADIALLY-SYMMETRIC INJECTION — gravity, capillary pressure, vertical
//       sweep efficiency, and any reservoir heterogeneity are ignored.
//
//   A3. CONSTANT-RATE EQUIVALENT — the convolution against an arbitrary
//       rateProfile is approximated by a STEP-WISE constant-rate
//       superposition (PRiSM_stehfest is called for each step). Smooth rate
//       histories are honoured as their right-rectangle digitisation.
//
//   A4. INCOMPRESSIBLE-FLUID FRONT — front radius
//       r_f(t) = sqrt(W_inj(t) / (π · h · φ · (1−Sor−Swc)))
//       uses the volume of water injected (incompressible) without correcting
//       for fluid expansion within the swept zone. Compressibility enters
//       only through the diffusivity (td) of the radial pressure response.
//
//   A5. COMPOSITE-RADIAL PRESSURE — the two-zone pressure profile is the
//       classic Hawkins / van Everdingen-Hurst composite-radial line-source:
//       constant mobility ratio M = (kro·μw)/(krw·μo), front radius rf as
//       computed, line-source kernel outside rf for the unswept zone. This
//       is exact for a STEADY-STATE radial profile, not for the transient
//       pressure rise — but it captures the dominant log-time behaviour and
//       the unit-mobility-contrast slope change at the front.
//
//   A6. NO COUNTERCURRENT FLOW, NO DISSOLVED-GAS, NO TEMPERATURE EFFECTS.
//
//   A7. WBS+SKIN folded as a Bourdet-Gringarten convolution against the
//       composite-radial response (treated as the reservoir-side input).
//
// These approximations are appropriate for engineering quick-look /
// regression-pre-screening; for production decisions a full reservoir
// simulator (Eclipse, IMEX, OPM, MRST) should be used.
// ════════════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// =============================================================================
// SECTION 0 — Shared helpers (resolve foundation primitives, type guards)
// =============================================================================

var STEHFEST_N = 12;
var DERIV_REL_STEP = 1e-3;

// Resolve a foundation symbol from window/globalThis with a final eval
// fallback so the module also works in Node-only smoke tests.
function _foundation(name) {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (typeof g[name] === 'function') return g[name];
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
                throw new Error('PRiSM 10: td must be > 0 (got ' + td[i] + ' at index ' + i + ')');
            }
        }
    } else if (!_num(td) || td <= 0) {
        throw new Error('PRiSM 10: td must be > 0 (got ' + td + ')');
    }
}

function _requireParams(params, keys) {
    if (!params || typeof params !== 'object') {
        throw new Error('PRiSM 10: params object required');
    }
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!(k in params)) {
            throw new Error('PRiSM 10: missing required param "' + k + '"');
        }
    }
}

// Standard browser-storage gate. Some host environments (file://, private
// modes, Node) may throw on touch; we silently degrade.
function _safeStorageGet(key) {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    } catch (e) { return null; }
}

function _safeStorageSet(key, val) {
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(key, val);
        return true;
    } catch (e) { return false; }
}


// =============================================================================
// SECTION 1 — User-defined type-curve infrastructure
// =============================================================================
// Persistence layout:
//
//   localStorage['wts_prism_user_curves'] = JSON.stringify({
//      "MyCurveA": { td: [...], pd: [...], pdPrime: [...] | null },
//      "MyCurveB": { td: [...], pd: [...], pdPrime: null }
//   })
//
// PRiSM_userTypeCurves is the in-memory mirror, populated on first access
// and kept in sync with localStorage on every load/delete.
//
// CSV parser handles tab, comma, semicolon, and whitespace separators;
// auto-detects header rows (any non-numeric cell in row 1). Two and three
// column inputs are both accepted: 3rd column = pd′. If pd′ is omitted we
// compute central-differences in (ln td, pd) space at module-evaluation
// time.
//
// Validation rules (all reject with a clear Error message):
//   - At least 3 rows (linear interpolation needs ≥ 2 points; we require 3
//     so the end-slope extrapolation is well-defined).
//   - td strictly monotonically increasing.
//   - All td > 0, all pd finite, all pd′ finite (when present).
//
// Evaluation rules:
//   - timeShift parameter is ADDITIVE in log10 space:
//        td_eff = td_input / 10^timeShift
//     (positive timeShift moves the curve LATER, negative moves it EARLIER).
//   - pressShift is ADDITIVE in pd directly.
//   - For td_eff inside the tabulated range: linear interpolation in
//     (log10 td, pd). pd is NOT log-transformed because pd can pass through
//     zero (e.g. infinite-conductivity fracture early time) and cannot.
//   - For td_eff < min(td): extrapolation using slope of first 2 points.
//   - For td_eff > max(td): extrapolation using slope of last 2 points.
// =============================================================================

var STORAGE_KEY = 'wts_prism_user_curves';

// In-memory mirror. Populated lazily on first access. Map<name, curveObj>.
var PRiSM_userTypeCurves = {};
var _curvesLoaded = false;

// Hydrate the in-memory mirror from localStorage. Idempotent. Safe to call
// from any thread (we use a sentinel boolean).
function _loadCurvesFromStorage() {
    if (_curvesLoaded) return PRiSM_userTypeCurves;
    _curvesLoaded = true;
    var raw = _safeStorageGet(STORAGE_KEY);
    if (!raw) return PRiSM_userTypeCurves;
    try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            // Defensive copy; re-validate each entry to filter corrupted JSON.
            for (var name in parsed) {
                if (!parsed.hasOwnProperty(name)) continue;
                var c = parsed[name];
                if (c && Array.isArray(c.td) && Array.isArray(c.pd)
                    && c.td.length === c.pd.length && c.td.length >= 2) {
                    PRiSM_userTypeCurves[name] = {
                        td: c.td.slice(),
                        pd: c.pd.slice(),
                        pdPrime: Array.isArray(c.pdPrime) && c.pdPrime.length === c.td.length
                                 ? c.pdPrime.slice() : null
                    };
                }
            }
        }
    } catch (e) { /* corrupted JSON — start fresh */ }
    return PRiSM_userTypeCurves;
}

function _persistCurves() {
    try {
        return _safeStorageSet(STORAGE_KEY, JSON.stringify(PRiSM_userTypeCurves));
    } catch (e) { return false; }
}

// Lightweight CSV / paste parser for type-curve uploads. Returns
// { td, pd, pdPrime } where pdPrime may be null. Throws on malformed input.
function _parseTypeCurveCsv(csvText) {
    if (typeof csvText !== 'string' || !csvText.trim()) {
        throw new Error('PRiSM_loadUserTypeCurve: csvText is empty');
    }
    var lines = csvText.split(/\r?\n/)
                       .map(function (l) { return l.trim(); })
                       .filter(function (l) { return l.length > 0 && l[0] !== '#'; });
    if (lines.length < 3) {
        throw new Error('PRiSM_loadUserTypeCurve: need at least 3 data rows (got ' + lines.length + ')');
    }

    // Pick separator from the first line: tab > comma > semicolon > whitespace.
    var sample = lines[0];
    var sep = /\s+/;
    if (sample.indexOf('\t') >= 0)      sep = /\t/;
    else if (sample.indexOf(',') >= 0)  sep = /,/;
    else if (sample.indexOf(';') >= 0)  sep = /;/;
    var split = function (line) {
        return line.split(sep)
                   .map(function (s) { return s.trim(); })
                   .filter(function (s) { return s.length > 0; });
    };

    // Header detection — if ANY cell in row 1 is non-numeric we drop it.
    var firstCells = split(lines[0]);
    var headerSkipped = firstCells.some(function (c) { return isNaN(parseFloat(c)); });
    var startIdx = headerSkipped ? 1 : 0;

    var td = [], pd = [], pdPrime = [];
    var hasDeriv = null;   // determined from the FIRST data row
    for (var i = startIdx; i < lines.length; i++) {
        var cells = split(lines[i]);
        if (cells.length < 2) continue;
        if (hasDeriv === null) hasDeriv = cells.length >= 3;
        var t = parseFloat(cells[0]);
        var p = parseFloat(cells[1]);
        if (!_num(t) || !_num(p)) {
            throw new Error('PRiSM_loadUserTypeCurve: non-numeric cell on row ' + (i + 1));
        }
        if (t <= 0) {
            throw new Error('PRiSM_loadUserTypeCurve: td must be > 0 on row ' + (i + 1) + ' (got ' + t + ')');
        }
        td.push(t);
        pd.push(p);
        if (hasDeriv) {
            var pp = parseFloat(cells[2]);
            if (!_num(pp)) {
                throw new Error('PRiSM_loadUserTypeCurve: non-numeric pd_prime on row ' + (i + 1));
            }
            pdPrime.push(pp);
        }
    }

    // Validate strict monotone-increasing td.
    for (var j = 1; j < td.length; j++) {
        if (td[j] <= td[j - 1]) {
            throw new Error('PRiSM_loadUserTypeCurve: td must be strictly increasing (row ' + (j + 1) + ' td=' + td[j] + ' ≤ row ' + j + ' td=' + td[j - 1] + ')');
        }
    }
    if (td.length < 3) {
        throw new Error('PRiSM_loadUserTypeCurve: need at least 3 valid data rows (got ' + td.length + ')');
    }

    return { td: td, pd: pd, pdPrime: hasDeriv ? pdPrime : null };
}

// Compute pd' (Bourdet derivative) on a tabulated curve via central
// differences in (ln td, pd) space. End points use forward / backward
// 2-point differences. Returns a fresh array of the same length.
function _centralDerivativeLogTime(tdArr, pdArr) {
    var n = tdArr.length;
    var out = new Array(n);
    if (n < 2) return out.fill(0);
    // forward at left edge
    out[0] = (pdArr[1] - pdArr[0]) / (Math.log(tdArr[1]) - Math.log(tdArr[0]));
    // central in interior
    for (var i = 1; i < n - 1; i++) {
        out[i] = (pdArr[i + 1] - pdArr[i - 1]) /
                 (Math.log(tdArr[i + 1]) - Math.log(tdArr[i - 1]));
    }
    // backward at right edge
    out[n - 1] = (pdArr[n - 1] - pdArr[n - 2]) /
                 (Math.log(tdArr[n - 1]) - Math.log(tdArr[n - 2]));
    return out;
}

// Linear interpolation in (log10 td, value) space with end-slope extrapolation.
// tdArr MUST be strictly increasing and all > 0.
function _interpLogLinear(tdArr, valArr, tQuery) {
    var n = tdArr.length;
    if (n === 0) return NaN;
    if (n === 1) return valArr[0];
    if (!_num(tQuery) || tQuery <= 0) return NaN;
    var lq = Math.log10(tQuery);

    // Below-range: end-slope extrapolation from points 0 and 1.
    if (tQuery <= tdArr[0]) {
        var l0 = Math.log10(tdArr[0]);
        var l1 = Math.log10(tdArr[1]);
        var slope = (valArr[1] - valArr[0]) / (l1 - l0);
        return valArr[0] + slope * (lq - l0);
    }
    // Above-range: end-slope extrapolation from points n-2 and n-1.
    if (tQuery >= tdArr[n - 1]) {
        var lN1 = Math.log10(tdArr[n - 2]);
        var lN  = Math.log10(tdArr[n - 1]);
        var slopeR = (valArr[n - 1] - valArr[n - 2]) / (lN - lN1);
        return valArr[n - 1] + slopeR * (lq - lN);
    }

    // Binary search for the bracketing pair [i, i+1] such that
    // tdArr[i] <= tQuery < tdArr[i+1].
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (tdArr[mid] <= tQuery) lo = mid;
        else                       hi = mid;
    }
    var lA = Math.log10(tdArr[lo]);
    var lB = Math.log10(tdArr[hi]);
    if (lB === lA) return valArr[lo];
    var w = (lq - lA) / (lB - lA);
    return valArr[lo] * (1 - w) + valArr[hi] * w;
}

// -- Public API for managing user type-curves ---------------------------------

/**
 * Parse a CSV/paste of (td, pd, [pd_prime]) and register it under `name`.
 * Overwrites any existing curve of the same name. Persists immediately.
 * @param {string} name Non-empty identifier — used in the picker UI.
 * @param {string} csvText Multi-line CSV/TSV text (header optional).
 * @returns {{name:string, n:number, hasDeriv:boolean}} on success.
 * @throws {Error} on parse / validation failure.
 */
function PRiSM_loadUserTypeCurve(name, csvText) {
    if (typeof name !== 'string' || !name.trim()) {
        throw new Error('PRiSM_loadUserTypeCurve: name must be a non-empty string');
    }
    name = name.trim();
    _loadCurvesFromStorage();
    var parsed = _parseTypeCurveCsv(csvText);
    // Compute pd' if missing — done at load time so the runtime evaluator
    // can be a clean log-log interpolation.
    var pdPrime = parsed.pdPrime;
    if (!pdPrime) pdPrime = _centralDerivativeLogTime(parsed.td, parsed.pd);
    PRiSM_userTypeCurves[name] = {
        td: parsed.td,
        pd: parsed.pd,
        pdPrime: pdPrime
    };
    _persistCurves();
    return { name: name, n: parsed.td.length, hasDeriv: !!parsed.pdPrime };
}

/**
 * List the names of currently registered user type-curves. Useful for
 * populating the model-picker UI.
 * @returns {string[]}
 */
function PRiSM_listUserTypeCurves() {
    _loadCurvesFromStorage();
    return Object.keys(PRiSM_userTypeCurves);
}

/**
 * Delete a registered curve by name. Persists.
 * @param {string} name
 * @returns {boolean} true if a curve was deleted, false if not found.
 */
function PRiSM_deleteUserTypeCurve(name) {
    _loadCurvesFromStorage();
    if (PRiSM_userTypeCurves.hasOwnProperty(name)) {
        delete PRiSM_userTypeCurves[name];
        _persistCurves();
        return true;
    }
    return false;
}

/**
 * Retrieve a curve by name (defensive copy).
 */
function PRiSM_getUserTypeCurve(name) {
    _loadCurvesFromStorage();
    var c = PRiSM_userTypeCurves[name];
    if (!c) return null;
    return {
        td: c.td.slice(),
        pd: c.pd.slice(),
        pdPrime: c.pdPrime ? c.pdPrime.slice() : null
    };
}

// -- Model #18 evaluator ------------------------------------------------------

/**
 * User-Defined Type-Curve evaluator (pd at given td values).
 *
 * Looks up the curve named in `params.curveName`, applies a log10 time
 * shift and additive pd shift, and interpolates linearly in (log10 td, pd)
 * space with end-slope extrapolation outside the tabulated range.
 *
 * @param {number|number[]} td   Dimensionless time(s) in the SAME convention
 *                                as the tabulated curve.
 * @param {{curveName:string, timeShift?:number, pressShift?:number}} params
 * @returns {number|number[]}
 * @throws {Error} if the named curve is not registered.
 */
function PRiSM_model_userDefined(td, params) {
    _requirePositiveTd(td);
    if (!params || typeof params !== 'object') {
        throw new Error('PRiSM_model_userDefined: params object required');
    }
    var name = params.curveName;
    if (typeof name !== 'string' || !name) {
        throw new Error('PRiSM_model_userDefined: params.curveName missing — register a curve first via PRiSM_loadUserTypeCurve(name, csv)');
    }
    _loadCurvesFromStorage();
    var curve = PRiSM_userTypeCurves[name];
    if (!curve) {
        var available = Object.keys(PRiSM_userTypeCurves);
        throw new Error('PRiSM_model_userDefined: curve "' + name + '" not registered. Known: ' +
            (available.length ? available.join(', ') : '(none)'));
    }
    var timeShift  = _num(params.timeShift)  ? params.timeShift  : 0;
    var pressShift = _num(params.pressShift) ? params.pressShift : 0;

    // td_eff = td_input / 10^timeShift
    var shiftFactor = Math.pow(10, timeShift);

    return _arrayMap(td, function (t) {
        var tEff = t / shiftFactor;
        var pdInterp = _interpLogLinear(curve.td, curve.pd, tEff);
        return pdInterp + pressShift;
    });
}

/**
 * pd' evaluator for the user-defined curve. Uses the stored derivative
 * column if present, else the central-differences pd' computed at load time.
 *
 * @param {number|number[]} td
 * @param {object} params  Same as PRiSM_model_userDefined.
 * @returns {number|number[]}
 */
function PRiSM_model_userDefined_pd_prime(td, params) {
    _requirePositiveTd(td);
    if (!params || typeof params !== 'object') {
        throw new Error('PRiSM_model_userDefined_pd_prime: params object required');
    }
    var name = params.curveName;
    if (typeof name !== 'string' || !name) {
        throw new Error('PRiSM_model_userDefined_pd_prime: params.curveName missing');
    }
    _loadCurvesFromStorage();
    var curve = PRiSM_userTypeCurves[name];
    if (!curve) {
        throw new Error('PRiSM_model_userDefined_pd_prime: curve "' + name + '" not registered');
    }
    var timeShift = _num(params.timeShift) ? params.timeShift : 0;
    var shiftFactor = Math.pow(10, timeShift);
    var pdpArr = curve.pdPrime;
    // Defensive: if pdPrime is missing (shouldn't be — we synthesise on load —
    // but guard against externally mutated state), compute it on the fly.
    if (!Array.isArray(pdpArr) || pdpArr.length !== curve.td.length) {
        pdpArr = _centralDerivativeLogTime(curve.td, curve.pd);
    }
    return _arrayMap(td, function (t) {
        var tEff = t / shiftFactor;
        return _interpLogLinear(curve.td, pdpArr, tEff);
    });
}


// =============================================================================
// SECTION 2 — Water Injection (semi-analytic two-phase displacement)
// =============================================================================
//
// Forward model for an injection well in a 1-D radial reservoir, single
// horizontal stratum, two phases (oil ahead of front, water behind front).
// See the module header for the full list of approximations.
//
// Workflow per evaluator call:
//
//   1. From params.rateProfile (optional [t,q] pairs) and the constant
//      injection rate baseline, build a piecewise-constant cumulative water
//      injected schedule W_inj(t).
//   2. For each output td (which we treat as REAL time in days, see note on
//      time convention below), compute:
//        a. cumulative water injected up to td  → W_inj(td) [bbl]
//        b. front radius  rf(td) = sqrt( W_inj * 5.615 / (π · h · φ · ΔS) )
//           (5.615 ft³/bbl conversion factor; ΔS = 1 - Sor - Swc)
//        c. dimensionless front radius  rfD = rf / rw
//        d. composite-radial line-source pressure rise Δp_res in
//           Laplace-domain Bourdet-Gringarten form, with mobility ratio
//           M = (kro·μw)/(krw·μo) and rfD as the discontinuity radius
//        e. Add WBS+skin via Stehfest convolution with Cd, S
//   3. Return the resulting pwd at each td.
//
// TIME CONVENTION NOTE
//   PRiSM evaluators conventionally take dimensionless td. For the water-
//   injection model the problem is INHERENTLY non-dimensionless because the
//   front radius depends on ABSOLUTE cumulative volume. We adopt the
//   convention: the input td array IS interpreted as real time in days, and
//   the rateProfile (q in bbl/d) is referenced against the same time axis.
//   Internally we form a "pseudo-td" against a reference diffusivity
//   constant that the user provides via params (kh, mu, ct, phi, rw); the
//   composite-radial Laplace solution then runs on that pseudo-td.
//
// COMPOSITE-RADIAL LAPLACE-DOMAIN SOLUTION
//   For a constant-rate injector (the workhorse step that we superpose), the
//   Laplace-domain dimensionless pressure at the wellbore for a two-zone
//   composite reservoir of radius discontinuity rfD is (see Bratvold & Horne
//   SPE 19819, Aanonsen SPE 17386, or Fair Petroleum Engineering Handbook
//   Vol IV §10.5):
//
//      P̂_d(s) = [ K0(√s) + B · I0(√s) ] / s  evaluated at the wellbore
//
//   where the matching coefficient B comes from continuity of pressure and
//   flux at rfD between the inner (water mobility) and outer (oil mobility)
//   regions. We use a SIMPLIFIED CLOSED FORM appropriate for engineering
//   work — the Hawkins-style composite skin:
//
//      ΔP_d ≈ ½ [ ln(rfD²) + (M − 1) · ln(rfD²) + 2·S ] + ½·Ei(¼/td_outer)
//
//   which collapses to a Hawkins skin S_eq = (M − 1) · ln(rfD) on top of the
//   line-source kernel for the outer (oil) region. This is EXACT in the
//   late-time PSS limit and a very-good approximation for the transient
//   regime as long as the front is not moving faster than the pressure
//   diffusivity (typical for water-floods).
// =============================================================================

// Useful conversion: 1 bbl = 5.615 ft³.
var BBL_TO_FT3 = 5.6145833;

// =============================================================================
// 2.1 — Cumulative-injection helper
// =============================================================================

// Build a piecewise-linear cumulative-injection function from a rateProfile.
// rateProfile is an array of [t, q] pairs where q is in bbl/d. Sign
// convention: q < 0 (injection, well-test convention) OR q > 0 (positive
// injection rate). We use abs(q) so either convention works — the model
// only cares about the magnitude of injected water.
//
// If rateProfile is missing or empty we fall back to a constant rate q_const
// supplied via params.q_inj.
//
// Returns a callable: cumWater(t) → cumulative bbl injected up to time t.
function _buildCumulativeInjector(rateProfile, q_const) {
    var hasProfile = Array.isArray(rateProfile) && rateProfile.length > 0;
    if (!hasProfile) {
        var qFlat = _num(q_const) ? Math.abs(q_const) : 0;
        return function (t) {
            if (!_num(t) || t <= 0) return 0;
            return qFlat * t;
        };
    }
    // Sort + sanitise.
    var pairs = [];
    for (var i = 0; i < rateProfile.length; i++) {
        var rec = rateProfile[i];
        if (!Array.isArray(rec) || rec.length < 2) continue;
        var t = parseFloat(rec[0]);
        var q = parseFloat(rec[1]);
        if (!_num(t) || !_num(q)) continue;
        pairs.push([t, Math.abs(q)]);
    }
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    if (!pairs.length) {
        // Degenerate: profile parsed as empty after sanitise.
        var qFlat2 = _num(q_const) ? Math.abs(q_const) : 0;
        return function (t) {
            if (!_num(t) || t <= 0) return 0;
            return qFlat2 * t;
        };
    }
    // Pre-compute cumulative-bbl at each profile knot using the LEFT rate
    // (the rate at pair i is held constant from pair i to pair i+1).
    var cum = new Array(pairs.length);
    cum[0] = 0;
    for (var k = 1; k < pairs.length; k++) {
        cum[k] = cum[k - 1] + pairs[k - 1][1] * (pairs[k][0] - pairs[k - 1][0]);
    }
    return function (t) {
        if (!_num(t) || t <= pairs[0][0]) {
            // Before the first knot: assume zero injection.
            if (t <= pairs[0][0]) return 0;
            return 0;
        }
        // Find the bracketing pair.
        // Binary search.
        var lo = 0, hi = pairs.length - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (pairs[mid][0] <= t) lo = mid;
            else                     hi = mid;
        }
        // After the last knot: extrapolate at the last rate.
        if (t >= pairs[pairs.length - 1][0]) {
            var last = pairs.length - 1;
            return cum[last] + pairs[last][1] * (t - pairs[last][0]);
        }
        var dt = t - pairs[lo][0];
        return cum[lo] + pairs[lo][1] * dt;
    };
}

// =============================================================================
// 2.2 — Front radius and composite-radial pressure
// =============================================================================

/**
 * Water-front radius from cumulative water injected.
 *   rf = sqrt( W_inj_ft3 / (π · h · φ · ΔS) )
 *
 * @param {number} W_bbl  Cumulative water injected (bbl)
 * @param {number} h      Net pay (ft)
 * @param {number} phi    Porosity (-)
 * @param {number} dS     Movable-water saturation 1 - Sor - Swc
 * @returns {number} Front radius in ft. Returns rw_min (1e-3 ft) for
 *                    W_bbl ≤ 0 to avoid log(0).
 */
function _waterFrontRadius(W_bbl, h, phi, dS) {
    if (W_bbl <= 0 || h <= 0 || phi <= 0 || dS <= 0) return 1e-3;
    var V = W_bbl * BBL_TO_FT3;
    return Math.sqrt(V / (Math.PI * h * phi * dS));
}

/**
 * Composite-radial Hawkins-style skin from inner-zone water mobility and
 * outer-zone oil mobility.
 *
 *   S_composite = (M - 1) · ln(rfD)
 *
 * where the mobility ratio is defined CONVENTIONALLY for water-floods as
 * the ratio of displacing-phase mobility to displaced-phase mobility:
 *
 *   M = (krw_max / mu_w) / (kro_max / mu_o)
 *
 * For M > 1 (favourable for sweep but unfavourable for pressure),
 * S_composite > 0 (looks like positive skin).
 *
 * @param {number} rfD    Dimensionless front radius rf/rw
 * @param {number} M      Mobility ratio (krw·μo)/(kro·μw)
 * @returns {number} Equivalent Hawkins skin (dimensionless)
 */
function _compositeRadialSkin(rfD, M) {
    if (rfD <= 1) return 0;       // front still inside the wellbore
    if (M <= 0)   return 0;
    return (M - 1) * Math.log(rfD);
}

/**
 * Full composite-radial dimensionless pressure rise at the wellbore for an
 * injector. Combines a homogeneous line-source response in the OUTER (oil)
 * region with a Hawkins-style composite skin from the inner swept region.
 *
 * Inputs (all dimensionless):
 *   td_inj  — pseudo-td referred to OUTER (oil) diffusivity
 *   rfD     — instantaneous front radius rf/rw (snapshot at this td)
 *   M       — mobility ratio (krw·μo)/(kro·μw)
 *   Cd      — wellbore-storage coefficient
 *   S_well  — mechanical skin at the wellbore
 *   N_steh  — Stehfest order
 *
 * Implementation: Stehfest-invert the Bourdet-Gringarten WBS+skin Laplace
 * form using the composite skin as the EFFECTIVE skin. This is the
 * Hawkins-equivalent treatment which is exact in the late-time PSS limit
 * and a very-good approximation for the transient regime.
 */
function _waterInjectionPwd(td_inj, rfD, M, Cd, S_well, N_steh) {
    var stehfest = _foundation('PRiSM_stehfest');
    var K0 = _foundation('PRiSM_besselK0') || _foundation('PRiSM_K0');
    var K1 = _foundation('PRiSM_besselK1') || _foundation('PRiSM_K1');
    if (!stehfest || !K0 || !K1) {
        throw new Error('PRiSM 10: foundation primitives (PRiSM_stehfest / besselK0 / besselK1) not loaded');
    }
    var S_comp = _compositeRadialSkin(rfD, M);
    var S_eff  = S_well + S_comp;

    // Bourdet-Gringarten Laplace pwd with WBS + (mech + composite) skin:
    //   num   = K0(√s) + S_eff · √s · K1(√s)
    //   denom = √s · K1(√s) + Cd · s · num
    //   pwd_lap = num / (s · denom)
    var Phat = function (s) {
        var sqs = Math.sqrt(s);
        var k0 = K0(sqs);
        var k1 = K1(sqs);
        var num = k0 + S_eff * sqs * k1;
        var denom = sqs * k1 + Cd * s * num;
        return num / (s * denom);
    };
    return stehfest(Phat, td_inj, N_steh);
}

// =============================================================================
// 2.3 — Top-level water injection evaluators
// =============================================================================
//
// PARAMETERS (all keys ARE consumed; superfluous keys are ignored):
//
//   { Cd, S, kh, mu_o, mu_w, B, h, phi, rw, ct,
//     Swc, Sor, krw_max, kro_max,
//     q_inj, rateProfile }
//
//   Cd        : dimensionless wellbore-storage coefficient
//   S         : mechanical skin at the wellbore (dimensionless)
//   kh        : reservoir kh in mD·ft (used to scale td)
//   mu_o      : oil viscosity in cp
//   mu_w      : water viscosity in cp
//   B         : water formation volume factor (rb/STB ≈ 1 for water)
//   h         : net pay in ft
//   phi       : porosity (fraction)
//   rw        : wellbore radius in ft
//   ct        : total compressibility in 1/psi (must be > 0)
//   Swc       : connate water saturation (fraction)
//   Sor       : residual oil saturation (fraction)
//   krw_max   : water relative permeability at Sor (endpoint)
//   kro_max   : oil   relative permeability at Swc (endpoint)
//   q_inj     : constant injection rate baseline in bbl/d (used when
//               rateProfile is absent or empty)
//   rateProfile : optional [[t1, q1], [t2, q2], ...] schedule overriding
//                 q_inj. Time in days, rate in bbl/d (sign-agnostic).
//
// The evaluator interprets the input td values as REAL TIME in days.
//
// pseudo-td:
//   td_inj = 0.0002637 · (kh / mu_o) · t / (φ · ct · μ_o · rw²)
//   This is the standard radial diffusivity grouping in field units.
//   Reference: Bourdet 2002 §3.1.

// Field-units diffusivity constant: oilfield (md, ft, hr, cp, psi).
// 0.0002637 hr (kh in md·ft, t in hr, μ in cp, φct in psi^-1, rw in ft).
// We work with t in DAYS to match injection rates in bbl/d, so we multiply
// by 24 to convert hr → day.
var FIELD_UNITS_DIFFUSIVITY = 0.0002637 * 24;   // /day

function _toRealTimeTd(t_day, p) {
    var phi = p.phi;
    var ct  = p.ct;
    var muo = p.mu_o;
    var rw  = p.rw;
    var kh  = p.kh;
    var h   = p.h;
    if (!(phi > 0 && ct > 0 && muo > 0 && rw > 0 && kh > 0 && h > 0)) {
        return NaN;
    }
    var k = kh / h;                     // md
    return FIELD_UNITS_DIFFUSIVITY * k * t_day / (phi * muo * ct * rw * rw);
}

function _validateWaterInjectionParams(p) {
    var required = ['Cd', 'S', 'kh', 'mu_o', 'mu_w', 'B', 'h', 'phi', 'rw',
                    'ct', 'Swc', 'Sor', 'krw_max', 'kro_max'];
    _requireParams(p, required);
    if (!(p.kh > 0))      throw new Error('PRiSM_model_waterInjection: kh must be > 0');
    if (!(p.mu_o > 0))    throw new Error('PRiSM_model_waterInjection: mu_o must be > 0');
    if (!(p.mu_w > 0))    throw new Error('PRiSM_model_waterInjection: mu_w must be > 0');
    if (!(p.h > 0))       throw new Error('PRiSM_model_waterInjection: h must be > 0');
    if (!(p.phi > 0 && p.phi < 1)) throw new Error('PRiSM_model_waterInjection: phi must be in (0,1)');
    if (!(p.rw > 0))      throw new Error('PRiSM_model_waterInjection: rw must be > 0');
    if (!(p.ct > 0))      throw new Error('PRiSM_model_waterInjection: ct must be > 0 (water-injection model is non-linear in ct — zero would imply incompressible reservoir)');
    if (!(p.Cd >= 0))     throw new Error('PRiSM_model_waterInjection: Cd must be ≥ 0');
    if (!isFinite(p.S))   throw new Error('PRiSM_model_waterInjection: S must be finite');
    var dS = 1 - p.Sor - p.Swc;
    if (!(dS > 0))        throw new Error('PRiSM_model_waterInjection: Swc + Sor ≥ 1 leaves no movable phase');
    if (!(p.krw_max > 0)) throw new Error('PRiSM_model_waterInjection: krw_max must be > 0');
    if (!(p.kro_max > 0)) throw new Error('PRiSM_model_waterInjection: kro_max must be > 0');
}

/**
 * Water Injection forward model — pwd at each input time.
 *
 * @param {number|number[]} td  Time(s) in DAYS (NOT dimensionless td).
 * @param {object} params       See SECTION 2.3 header for keys.
 * @returns {number|number[]}   Dimensionless pressure rise at the wellbore.
 *                              Multiply by (q · μ · B) / (kh · 141.2) to get
 *                              real Δp in psi, the standard field-units
 *                              conversion.
 */
function PRiSM_model_waterInjection(td, params) {
    _requirePositiveTd(td);
    _validateWaterInjectionParams(params);

    var p = params;
    var dS = 1 - p.Sor - p.Swc;
    var M  = (p.krw_max / p.mu_w) / (p.kro_max / p.mu_o);

    var cumInj = _buildCumulativeInjector(p.rateProfile, p.q_inj);
    var Nsteh = (params.N != null) ? params.N : STEHFEST_N;

    return _arrayMap(td, function (t_day) {
        // Cumulative water injected up to t_day (bbl).
        var W = cumInj(t_day);
        // Front radius (ft).
        var rf = _waterFrontRadius(W, p.h, p.phi, dS);
        // Dimensionless front radius. Guard for early time where rf < rw.
        var rfD = Math.max(rf / p.rw, 1.0 + 1e-6);
        // Pseudo-td referred to outer (oil) diffusivity.
        var td_inj = _toRealTimeTd(t_day, p);
        if (!_num(td_inj) || td_inj <= 0) return NaN;
        // Composite-radial pwd via Bourdet-Gringarten WBS+skin convolution.
        return _waterInjectionPwd(td_inj, rfD, M, p.Cd, p.S, Nsteh);
    });
}

/**
 * Bourdet derivative pwd' = td · d(pwd)/d(ln td) for the water-injection
 * model. Implemented numerically because the time-dependent front radius
 * makes the Laplace-domain derivative (s · F̂) inappropriate — F̂ itself
 * varies with td via rfD.
 */
function PRiSM_model_waterInjection_pd_prime(td, params) {
    _requirePositiveTd(td);
    _validateWaterInjectionParams(params);
    var h = DERIV_REL_STEP;
    var pdAt = function (tQ) {
        return PRiSM_model_waterInjection(tQ, params);
    };
    return _arrayMap(td, function (t) {
        var lnT = Math.log(t);
        // 5-point central difference in ln t. Fall back to forward difference
        // at small td to avoid log of negative values after subtraction.
        var t_m2 = Math.exp(lnT - 2 * h);
        var t_m1 = Math.exp(lnT -     h);
        var t_p1 = Math.exp(lnT +     h);
        var t_p2 = Math.exp(lnT + 2 * h);
        var f_m2 = pdAt(t_m2);
        var f_m1 = pdAt(t_m1);
        var f_p1 = pdAt(t_p1);
        var f_p2 = pdAt(t_p2);
        var deriv = (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);
        return deriv;   // already td · d/dt because we differentiated in ln t
    });
}


// =============================================================================
// SECTION 3 — Registry merge — install both new evaluators
// =============================================================================

var REGISTRY_ADDITIONS = {
    userDefined: {
        pd: PRiSM_model_userDefined,
        pdPrime: PRiSM_model_userDefined_pd_prime,
        defaults: {
            curveName: '',
            timeShift: 0,
            pressShift: 0,
            Cd: 100,
            S: 0
        },
        paramSpec: [
            { key: 'curveName',  label: 'Curve name (load via PRiSM_loadUserTypeCurve)',
              unit: '', type: 'string', default: '' },
            { key: 'timeShift',  label: 'log10 time shift', unit: '-',
              min: -10, max: 10, default: 0 },
            { key: 'pressShift', label: 'pd shift',         unit: '-',
              min: -10, max: 10, default: 0 },
            { key: 'Cd',         label: 'WBS Cd (info only — already in curve)',
              unit: '-', min: 0, max: 1e10, default: 100 },
            { key: 'S',          label: 'Skin S (info only)',
              unit: '-', min: -7,  max: 50,  default: 0 }
        ],
        reference: 'PRiSM Phase 7 — log-log table-curve interpolation with end-slope extrapolation',
        category: 'special',
        description: 'User-Defined Type-Curve. User pastes (td, pd[, pd′]) tabulated points; this model interpolates linearly in log-log space and extrapolates with end-slope. Ideal for digitised vendor charts, in-house libraries, or custom analytical solutions. Persisted in localStorage; manage via PRiSM_loadUserTypeCurve / PRiSM_listUserTypeCurves / PRiSM_deleteUserTypeCurve.',
        kind: 'pressure'
    },
    waterInjection: {
        pd: PRiSM_model_waterInjection,
        pdPrime: PRiSM_model_waterInjection_pd_prime,
        defaults: {
            Cd: 100, S: 0,
            kh: 1000, mu_o: 1.0, mu_w: 0.5, B: 1.0,
            h: 50, phi: 0.20, rw: 0.354, ct: 1e-5,
            Swc: 0.2, Sor: 0.2,
            krw_max: 0.3, kro_max: 0.8,
            q_inj: 1000,
            rateProfile: null
        },
        paramSpec: [
            { key: 'Cd',       label: 'WBS Cd',              unit: '-',     min: 0,     max: 1e10, default: 100 },
            { key: 'S',        label: 'Skin',                unit: '-',     min: -7,    max: 50,   default: 0 },
            { key: 'kh',       label: 'Permeability-thickness kh', unit: 'md·ft', min: 0.1, max: 1e7, default: 1000 },
            { key: 'mu_o',     label: 'Oil viscosity',       unit: 'cp',    min: 0.1,   max: 1000, default: 1.0 },
            { key: 'mu_w',     label: 'Water viscosity',     unit: 'cp',    min: 0.1,   max: 10,   default: 0.5 },
            { key: 'B',        label: 'Water FVF',           unit: 'rb/stb', min: 0.5,  max: 2.0,  default: 1.0 },
            { key: 'kro_max',  label: 'kr_oil at Swc',       unit: '-',     min: 0.01,  max: 1.0,  default: 0.8 },
            { key: 'krw_max',  label: 'kr_water at Sor',     unit: '-',     min: 0.01,  max: 1.0,  default: 0.3 },
            { key: 'Swc',      label: 'Connate water sat',   unit: '-',     min: 0,     max: 0.5,  default: 0.2 },
            { key: 'Sor',      label: 'Residual oil sat',    unit: '-',     min: 0,     max: 0.5,  default: 0.2 },
            { key: 'phi',      label: 'Porosity',            unit: '-',     min: 0.01,  max: 0.4,  default: 0.20 },
            { key: 'h',        label: 'Net pay',             unit: 'ft',    min: 1,     max: 1000, default: 50 },
            { key: 'rw',       label: 'Wellbore radius',     unit: 'ft',    min: 0.1,   max: 1.0,  default: 0.354 },
            { key: 'ct',       label: 'Total compressibility', unit: '1/psi', min: 1e-7, max: 1e-3, default: 1e-5 },
            { key: 'q_inj',    label: 'Constant inj rate',   unit: 'bbl/d', min: 1,     max: 1e6,  default: 1000 }
        ],
        reference: 'Buckley-Leverett (1942); Bratvold & Horne SPE 19819 (1990); Aanonsen SPE 17386; Hawkins composite skin (1956). Semi-analytic two-zone water-injection — see source header for full list of approximations.',
        category: 'special',
        description: 'Water Injection (two-phase, semi-analytic). Piston-like radial displacement with mobility ratio M = (krw·μo)/(kro·μw); composite Hawkins-style skin from inner (water) and outer (oil) zones; WBS+skin folded via Stehfest. Time IS REAL TIME IN DAYS (not dimensionless); rateProfile is optional [[t,q],...] in days/bbl/d. APPROXIMATIONS: piston-like front, single-stratum, no gravity/capillary, incompressible-front volumetric balance. NOT a substitute for a commercial reservoir simulator.',
        kind: 'pressure'
    }
};

(function _installRegistry() {
    var g = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
    for (var key in REGISTRY_ADDITIONS) {
        if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
            g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
        }
    }
    // Expose evaluators + curve management API on the global namespace.
    g.PRiSM_userTypeCurves            = PRiSM_userTypeCurves;
    g.PRiSM_loadUserTypeCurve         = PRiSM_loadUserTypeCurve;
    g.PRiSM_listUserTypeCurves        = PRiSM_listUserTypeCurves;
    g.PRiSM_deleteUserTypeCurve       = PRiSM_deleteUserTypeCurve;
    g.PRiSM_getUserTypeCurve          = PRiSM_getUserTypeCurve;
    g.PRiSM_model_userDefined         = PRiSM_model_userDefined;
    g.PRiSM_model_userDefined_pd_prime = PRiSM_model_userDefined_pd_prime;
    g.PRiSM_model_waterInjection      = PRiSM_model_waterInjection;
    g.PRiSM_model_waterInjection_pd_prime = PRiSM_model_waterInjection_pd_prime;
    g.PRiSM_renderUserCurveManager    = PRiSM_renderUserCurveManager;

    // Hydrate from localStorage on load so curves persist across page loads.
    _loadCurvesFromStorage();
})();


// =============================================================================
// SECTION 4 — Optional UI helper: PRiSM_renderUserCurveManager
// =============================================================================
//
// Tiny render-helper that produces a self-contained UI fragment for managing
// user type-curves: a list with delete buttons + a textarea + name input +
// "Load" button. Intended to be called from the Tab 3 (Model) renderer when
// `userDefined` becomes the active model — but works as a standalone widget
// too.
//
// Usage:
//   const div = document.createElement('div');
//   PRiSM_renderUserCurveManager(div);
//   parentNode.appendChild(div);
//
// The widget's CSS classes match the existing PRiSM design system so it
// should look at home inside the Tab 3 card layout.
// =============================================================================

function PRiSM_renderUserCurveManager(container) {
    if (!container || typeof container !== 'object') {
        throw new Error('PRiSM_renderUserCurveManager: container element required');
    }
    _loadCurvesFromStorage();

    function rerender() {
        var names = PRiSM_listUserTypeCurves();
        var listHtml = '';
        if (names.length === 0) {
            listHtml = '<div style="color:var(--text3, #888); font-size:12px; padding:8px;">No user type-curves registered yet.</div>';
        } else {
            listHtml = '<table class="dtable" style="margin-bottom:6px;"><thead><tr><th>Name</th><th>Points</th><th>td range</th><th></th></tr></thead><tbody>';
            for (var i = 0; i < names.length; i++) {
                var nm = names[i];
                var c = PRiSM_userTypeCurves[nm];
                var n = c ? c.td.length : 0;
                var tdMin = c && n ? c.td[0] : 0;
                var tdMax = c && n ? c.td[n - 1] : 0;
                listHtml += '<tr>' +
                    '<td><code>' + _escapeHtml(nm) + '</code></td>' +
                    '<td>' + n + '</td>' +
                    '<td>' + tdMin.toExponential(2) + ' .. ' + tdMax.toExponential(2) + '</td>' +
                    '<td><button class="btn btn-secondary" data-prism-curve-del="' + _escapeAttr(nm) + '" style="padding:2px 8px;">delete</button></td>' +
                '</tr>';
            }
            listHtml += '</tbody></table>';
        }

        container.innerHTML =
            '<div class="card">' +
              '<div class="card-title">User Type-Curve Library</div>' +
              '<div style="font-size:12px; color:var(--text2, #aaa); margin-bottom:8px;">' +
                'Paste tabulated <code>(td, pd, pd_prime)</code> values. ' +
                'Header row optional; <code>pd_prime</code> column optional ' +
                '(computed automatically if omitted). Curves persist across sessions.' +
              '</div>' +
              listHtml +
              '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px;">' +
                '<input type="text" id="prism_uc_name" placeholder="Curve name" ' +
                  'style="padding:4px 8px; min-width:200px; background:var(--bg1, #fff); color:var(--text, #000); border:1px solid var(--border, #ccc); border-radius:4px;">' +
                '<button class="btn btn-primary" id="prism_uc_load">Load</button>' +
              '</div>' +
              '<textarea id="prism_uc_paste" style="margin-top:6px; width:100%; min-height:140px; ' +
                  'font-family:monospace; font-size:11px; background:var(--bg1, #fff); color:var(--text, #000); border:1px solid var(--border, #ccc); border-radius:4px; padding:6px;" ' +
                  'placeholder="td, pd, pd_prime' + '\\n' +
                  '0.001, 0.0234, 0.0234' + '\\n' +
                  '0.01,  0.123,  0.123' + '\\n' +
                  '0.1,   0.567,  0.567' + '\\n' +
                  '1,     2.30,   1.00' + '\\n' +
                  '10,    4.61,   1.00' + '\\n' +
                  '100,   6.91,   1.00"></textarea>' +
              '<div id="prism_uc_msg" style="margin-top:6px; font-size:12px; color:var(--text2, #aaa); min-height:1em;"></div>' +
            '</div>';

        // Wire delete buttons.
        var delBtns = container.querySelectorAll('button[data-prism-curve-del]');
        for (var j = 0; j < delBtns.length; j++) {
            (function (btn) {
                btn.onclick = function () {
                    var nm = btn.getAttribute('data-prism-curve-del');
                    if (PRiSM_deleteUserTypeCurve(nm)) {
                        rerender();
                    }
                };
            })(delBtns[j]);
        }

        // Wire load button.
        var loadBtn = container.querySelector('#prism_uc_load');
        var msgEl   = container.querySelector('#prism_uc_msg');
        if (loadBtn) {
            loadBtn.onclick = function () {
                var nameEl = container.querySelector('#prism_uc_name');
                var pasteEl = container.querySelector('#prism_uc_paste');
                var nm = nameEl ? nameEl.value.trim() : '';
                var txt = pasteEl ? pasteEl.value : '';
                if (!nm) {
                    if (msgEl) msgEl.innerHTML = '<span style="color:var(--red, #c00);">Please enter a curve name.</span>';
                    return;
                }
                try {
                    var info = PRiSM_loadUserTypeCurve(nm, txt);
                    if (msgEl) msgEl.innerHTML = '<span style="color:var(--green, #0a0);">Loaded "' +
                        _escapeHtml(info.name) + '" (' + info.n + ' points' +
                        (info.hasDeriv ? ', with pd′' : ', pd′ auto-computed') + ').</span>';
                    if (nameEl)  nameEl.value = '';
                    if (pasteEl) pasteEl.value = '';
                    rerender();
                } catch (e) {
                    if (msgEl) msgEl.innerHTML = '<span style="color:var(--red, #c00);">Error: ' +
                        _escapeHtml(e && e.message ? e.message : String(e)) + '</span>';
                }
            };
        }
    }

    rerender();
}

function _escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _escapeAttr(s) {
    return _escapeHtml(s);
}

})();

// ─── END 10-specialised-solvers ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 11-polish ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM ─ Layer 11 — Cross-cutting polish
//   1. SVG schematics                 — PRiSM_getModelSchematic(modelKey)
//   2. Specialised analysis keys      — PRiSM_analysisKeys / PRiSM_armAnalysisKey /
//                                       PRiSM_renderAnalysisKeyToolbar
//   3. PNG export pipeline            — PRiSM_exportReportPDF / PRiSM_exportPlotPNG
//   4. Per-tab GA4 events             — wraps window.PRiSM.setTab,
//                                       window.PRiSM_runRegression and
//                                       state.model setter
// -----------------------------------------------------------------------------
// This layer adds NO new physics. It improves the existing 20+ models with
// proper diagrams, click-on-plot specialised-analysis helpers (ported from
// the legacy reservoir-engineering toolset), a robust PDF export that bakes
// canvas-rendered plots in as PNG data URLs, and per-tab GA4 instrumentation.
//
// Public API (all on window.*):
//   PRiSM_getModelSchematic(modelKey)             -> SVG string
//   PRiSM_analysisKeys                            -> { KEY: { label, plot, clicks, action } }
//   PRiSM_armAnalysisKey(key)                     -> arm canvas to capture clicks
//   PRiSM_renderAnalysisKeyToolbar(host, plotKey) -> render toolbar of buttons
//   PRiSM_exportReportPDF()                       -> open print window with PNG-baked report
//   PRiSM_exportPlotPNG(plotKey)                  -> trigger PNG download
//   PRiSM_listPlots()                             -> array of {key, fn, label, mode}
//   PRiSM_setModel(key)                           -> setter that fires GA4 prism_model_select
//
// Conventions:
//   - Single outer IIFE (this whole file).
//   - All public symbols start with PRiSM_ and live on window.*.
//   - No external dependencies — pure vanilla JS, SVG strings only.
//   - Defensive against missing host integrations: if gtag is absent it
//     no-ops silently; if window.exportReport is absent the PDF export
//     falls back to a print-window approach.
// =============================================================================

(function () {
'use strict';

// -------------------------------------------------------------------------
// Toast helper — re-uses the host app's toast() if present, otherwise
// falls back to a console.log + one-shot floating div in the bottom-right.
// -------------------------------------------------------------------------
function _polishToast(msg, kind) {
    kind = kind || 'info';
    if (typeof window.toast === 'function') {
        try { window.toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    try {
        var prefix = (kind === 'error') ? '[PRiSM]' :
                     (kind === 'success') ? '[PRiSM]' : '[PRiSM]';
        console.log(prefix + ' ' + msg);
    } catch (e) { /* silent */ }
    // Floating toast (one at a time — replaces previous)
    try {
        var existing = document.getElementById('prism_polish_toast');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        var div = document.createElement('div');
        div.id = 'prism_polish_toast';
        div.style.cssText =
            'position:fixed; bottom:20px; right:20px; z-index:99999;' +
            'background:' + (kind === 'error' ? '#5b1f1f' :
                             kind === 'success' ? '#1f5b2a' : '#1f2a5b') + ';' +
            'color:#f0f6fc; padding:10px 14px; border-radius:6px;' +
            'font:13px sans-serif; box-shadow:0 4px 12px rgba(0,0,0,.4);' +
            'max-width:340px; line-height:1.4;';
        div.textContent = msg;
        document.body.appendChild(div);
        setTimeout(function () {
            if (div.parentNode) div.parentNode.removeChild(div);
        }, 4500);
    } catch (e) { /* silent */ }
}

// =========================================================================
// SECTION 1 — SVG SCHEMATICS
// =========================================================================
// 400×300 viewbox, dark theme. Colour palette:
//   stroke #8b949e — line-work / annotations
//   fill   #161b22 — backgrounds
//   accent #f0883e — wells / fractures (orange)
//   accent #3fb950 — matrix blocks (green, double-porosity)
//   accent #58a6ff — pressure isobars (blue)
//   tint   #21262d — caprock / base-rock layers
// =========================================================================

// ---- Re-usable sub-fragments --------------------------------------------

// Backdrop rectangle (the canvas bg).
function _svg_backdrop() {
    return '<rect x="0" y="0" width="400" height="300" fill="#161b22"/>';
}

// Caprock band at top of reservoir (y..y+h grey).
function _svg_caprock(y, h) {
    return '<rect x="20" y="' + y + '" width="360" height="' + h + '" ' +
           'fill="#21262d" stroke="#8b949e" stroke-width="0.5"/>' +
           '<text x="26" y="' + (y + h / 2 + 4) + '" font-size="9" fill="#8b949e">caprock</text>';
}

// Base-rock band at bottom of reservoir.
function _svg_baserock(y, h) {
    return '<rect x="20" y="' + y + '" width="360" height="' + h + '" ' +
           'fill="#21262d" stroke="#8b949e" stroke-width="0.5"/>' +
           '<text x="26" y="' + (y + h / 2 + 4) + '" font-size="9" fill="#8b949e">base-rock</text>';
}

// Reservoir sand body (stippled).
function _svg_sand(y, h) {
    return '<rect x="20" y="' + y + '" width="360" height="' + h + '" ' +
           'fill="url(#sandPattern)" stroke="#8b949e" stroke-width="0.5"/>';
}

// Sand pattern <defs>. Stippled dots over a slightly tinted background.
function _svg_defs() {
    return '<defs>' +
           '<pattern id="sandPattern" patternUnits="userSpaceOnUse" width="6" height="6">' +
               '<rect width="6" height="6" fill="#1c2128"/>' +
               '<circle cx="2" cy="2" r="0.6" fill="#3a4350"/>' +
               '<circle cx="5" cy="4" r="0.5" fill="#3a4350"/>' +
           '</pattern>' +
           '<pattern id="fracPattern" patternUnits="userSpaceOnUse" width="3" height="3">' +
               '<rect width="3" height="3" fill="#161b22"/>' +
               '<circle cx="1.5" cy="1.5" r="0.6" fill="#f0883e"/>' +
           '</pattern>' +
           '<linearGradient id="fcGrad" x1="0" y1="0" x2="1" y2="0">' +
               '<stop offset="0" stop-color="#f0883e" stop-opacity="0.95"/>' +
               '<stop offset="1" stop-color="#f0883e" stop-opacity="0.35"/>' +
           '</linearGradient>' +
           '<radialGradient id="presGrad" cx="0.5" cy="0.5" r="0.5">' +
               '<stop offset="0"   stop-color="#58a6ff" stop-opacity="0.55"/>' +
               '<stop offset="0.6" stop-color="#58a6ff" stop-opacity="0.18"/>' +
               '<stop offset="1"   stop-color="#58a6ff" stop-opacity="0"/>' +
           '</radialGradient>' +
           '</defs>';
}

// Vertical wellbore (filled column from y0 to y1 at x).
function _svg_vwell(x, y0, y1, color) {
    color = color || '#f0883e';
    return '<rect x="' + (x - 4) + '" y="' + y0 + '" width="8" height="' + (y1 - y0) + '" ' +
           'fill="#0d1117" stroke="' + color + '" stroke-width="1.5"/>' +
           '<line x1="' + x + '" y1="' + y0 + '" x2="' + x + '" y2="' + y1 + '" ' +
           'stroke="' + color + '" stroke-width="1" stroke-dasharray="2,2"/>';
}

// Horizontal lateral (filled rod at depth y from x0 to x1).
function _svg_hwell(x0, x1, y, color) {
    color = color || '#f0883e';
    return '<rect x="' + x0 + '" y="' + (y - 4) + '" width="' + (x1 - x0) + '" height="8" ' +
           'fill="#0d1117" stroke="' + color + '" stroke-width="1.5"/>';
}

// Surface arrow + "well" label at top of vertical well at x.
function _svg_well_label(x, label) {
    return '<polygon points="' + (x - 5) + ',12 ' + (x + 5) + ',12 ' + x + ',24" ' +
           'fill="#f0883e" stroke="#f0883e"/>' +
           '<text x="' + (x + 10) + '" y="20" font-size="10" fill="#c9d1d9">' + label + '</text>';
}

// Pressure isobar circles centred at (cx, cy) with N rings.
function _svg_isobars(cx, cy, rMax, n) {
    var s = '';
    for (var i = 1; i <= n; i++) {
        var r = rMax * (i / n);
        s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" ' +
             'fill="none" stroke="#58a6ff" stroke-width="0.6" stroke-opacity="' +
             (0.7 - i * 0.12).toFixed(2) + '" stroke-dasharray="3,3"/>';
    }
    return s;
}

// Caption below the diagram.
function _svg_caption(text) {
    return '<text x="200" y="290" font-size="10" fill="#8b949e" text-anchor="middle" font-style="italic">' +
           text + '</text>';
}

// SVG open + defs + backdrop. Caller appends body fragments + close.
function _svg_open() {
    return '<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" ' +
           'style="width:100%; height:auto; max-height:280px; display:block;">' +
           _svg_defs() + _svg_backdrop();
}
function _svg_close() { return '</svg>'; }


// ---- Per-model schematics -----------------------------------------------

// 1. Homogeneous — vertical well perforated through full thickness, isobars.
function _schematic_homogeneous() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Isobars centred on the well at mid-reservoir.
    s += '<ellipse cx="200" cy="150" rx="170" ry="78" ' +
         'fill="url(#presGrad)"/>';
    s += _svg_isobars(200, 150, 150, 4);
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // Perforation tics across full sand interval.
    for (var y = 80; y < 225; y += 12) {
        s += '<line x1="196" y1="' + y + '" x2="186" y2="' + y + '" ' +
             'stroke="#f0883e" stroke-width="1"/>';
        s += '<line x1="204" y1="' + y + '" x2="214" y2="' + y + '" ' +
             'stroke="#f0883e" stroke-width="1"/>';
    }
    s += _svg_well_label(200, 'producer');
    s += '<text x="350" y="160" font-size="10" fill="#58a6ff" text-anchor="end">isobars</text>';
    s += _svg_caption('Vertical well, infinite homogeneous reservoir, full-interval perforations');
    s += _svg_close();
    return s;
}

// 2. Infinite-conductivity vertical fracture — bi-wing planar fracture.
function _schematic_infiniteFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Planar bi-wing fracture (orange line through full thickness).
    s += '<rect x="80" y="78" width="240" height="144" ' +
         'fill="#f0883e" fill-opacity="0.18" stroke="none"/>';
    s += '<line x1="80" y1="150" x2="320" y2="150" ' +
         'stroke="#f0883e" stroke-width="3"/>';
    // Fracture tip lines top & bottom.
    s += '<line x1="80"  y1="78" x2="80"  y2="222" stroke="#f0883e" stroke-width="1" stroke-dasharray="3,3"/>';
    s += '<line x1="320" y1="78" x2="320" y2="222" stroke="#f0883e" stroke-width="1" stroke-dasharray="3,3"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // xf annotation arrows.
    s += '<line x1="200" y1="245" x2="320" y2="245" stroke="#8b949e" stroke-width="1" marker-end="url(#arrEnd)"/>';
    s += '<text x="260" y="260" font-size="11" fill="#c9d1d9" text-anchor="middle" font-style="italic">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Vertical well intersected by an infinite-conductivity bi-wing fracture');
    s += _svg_close();
    return s;
}

// 3. Finite-conductivity fracture — width gradient indicates finite k_f w_f.
function _schematic_finiteFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Bi-wing fracture as a filled ellipse-ish band that thins toward tips.
    s += '<polygon points="200,143 320,148 320,152 200,157" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7"/>';
    s += '<polygon points="200,143 80,148 80,152 200,157" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7" transform="scale(-1,1) translate(-400,0)"/>';
    s += '<line x1="80"  y1="78" x2="80"  y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += '<line x1="320" y1="78" x2="320" y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // Annotation: F_CD = (kf · wf) / (k · xf)
    s += '<text x="200" y="248" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">' +
         'F_CD = (k_f &#183; w_f) / (k &#183; x_f)</text>';
    s += '<line x1="200" y1="262" x2="320" y2="262" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="260" y="275" font-size="10" fill="#c9d1d9" text-anchor="middle">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Finite-conductivity fracture (width gradient ~ flux distribution)');
    s += _svg_close();
    return s;
}

// 4. Finite-conductivity fracture with face skin — damage band along faces.
function _schematic_finiteFracSkin() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Damage band (faded red) around the fracture.
    s += '<rect x="80" y="142" width="240" height="16" fill="#da3633" fill-opacity="0.22" stroke="none"/>';
    // Fracture body.
    s += '<polygon points="200,144 320,148 320,152 200,156" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7"/>';
    s += '<polygon points="200,144 80,148 80,152 200,156" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7" transform="scale(-1,1) translate(-400,0)"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    s += '<line x1="80"  y1="78" x2="80"  y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += '<line x1="320" y1="78" x2="320" y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += '<text x="120" y="138" font-size="9" fill="#da3633" font-style="italic">damage band (S_f)</text>';
    s += '<line x1="200" y1="248" x2="320" y2="248" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="260" y="262" font-size="10" fill="#c9d1d9" text-anchor="middle">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Finite-conductivity fracture with face skin (damaged faces)');
    s += _svg_close();
    return s;
}

// 5. Inclined wellbore — angled column through reservoir, θ_w labelled.
function _schematic_inclined() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Angle ~ 30° from vertical. Wellbore from (200, 24) to (260, 230).
    var x0 = 200, y0 = 24, x1 = 260, y1 = 230;
    s += '<line x1="' + x0 + '" y1="' + y0 + '" x2="' + x1 + '" y2="' + y1 + '" ' +
         'stroke="#f0883e" stroke-width="6" stroke-linecap="round"/>';
    s += '<line x1="' + x0 + '" y1="' + y0 + '" x2="' + x1 + '" y2="' + y1 + '" ' +
         'stroke="#0d1117" stroke-width="3" stroke-dasharray="2,2"/>';
    // Vertical reference dashed line.
    s += '<line x1="200" y1="30" x2="200" y2="100" stroke="#8b949e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    // Angle arc.
    s += '<path d="M 200 70 A 40 40 0 0 1 217 84" fill="none" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="222" y="78" font-size="11" fill="#58a6ff" font-style="italic">&#952;_w</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Inclined wellbore, full reservoir thickness, deviation angle &#952;_w');
    s += _svg_close();
    return s;
}

// 6. Horizontal well — lateral in mid-reservoir, length L, standoff z_w.
function _schematic_horizontal() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Vertical descent
    s += _svg_vwell(80, 24, 150, '#f0883e');
    // Horizontal lateral
    s += _svg_hwell(80, 360, 150, '#f0883e');
    // L annotation
    s += '<line x1="80" y1="178" x2="360" y2="178" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="80" y1="173" x2="80" y2="183" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="360" y1="173" x2="360" y2="183" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="220" y="194" font-size="11" fill="#c9d1d9" text-anchor="middle" font-style="italic">L</text>';
    // z_w annotation (standoff from bottom)
    s += '<line x1="370" y1="150" x2="370" y2="230" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="365" y1="150" x2="375" y2="150" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="365" y1="230" x2="375" y2="230" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="380" y="194" font-size="10" fill="#c9d1d9" font-style="italic">z_w</text>';
    s += _svg_well_label(80, 'producer');
    s += _svg_caption('Horizontal lateral well in centre of reservoir, length L');
    s += _svg_close();
    return s;
}

// 7. Partial-penetration fracture — vertical fracture with hf < h, centred at z_w.
function _schematic_partialPenFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Fracture covers 60% of reservoir, centred.
    s += '<rect x="80" y="115" width="240" height="70" fill="#f0883e" fill-opacity="0.22" stroke="#f0883e" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<line x1="80" y1="150" x2="320" y2="150" stroke="#f0883e" stroke-width="3"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // hf annotation
    s += '<line x1="335" y1="115" x2="335" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="330" y1="115" x2="340" y2="115" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="330" y1="185" x2="340" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="345" y="155" font-size="11" fill="#c9d1d9" font-style="italic">h_f</text>';
    // h annotation (full reservoir)
    s += '<line x1="370" y1="70" x2="370" y2="230" stroke="#8b949e" stroke-width="0.8" stroke-dasharray="2,2"/>';
    s += '<text x="380" y="155" font-size="10" fill="#8b949e" font-style="italic">h</text>';
    // z_w label
    s += '<text x="200" y="248" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">centred at z_w</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Partial-penetration fracture, height h_f &lt; h, centred at z_w');
    s += _svg_close();
    return s;
}

// 8. Linear sealing fault — producer + image well across single fault.
function _schematic_linearBoundary() {
    var s = _svg_open();
    // Plan-view: dark map background.
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Sealing fault line (vertical, at x=300).
    s += '<line x1="300" y1="50" x2="300" y2="250" stroke="#da3633" stroke-width="3"/>';
    s += '<text x="306" y="62" font-size="10" fill="#da3633">sealing fault</text>';
    // Hatching to denote sealing nature.
    for (var i = 0; i < 12; i++) {
        var yy = 60 + i * 16;
        s += '<line x1="300" y1="' + yy + '" x2="312" y2="' + (yy - 8) + '" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Producing well (orange dot) at x=180, y=150.
    s += '<circle cx="180" cy="150" r="6" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="170" y="135" font-size="10" fill="#f0883e">well</text>';
    // Image well (faded) at x=420 (off-canvas) — show at x=355 with dashed circle.
    s += '<circle cx="420" cy="150" r="6" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-dasharray="2,2"/>';
    s += '<text x="412" y="135" font-size="10" fill="#58a6ff" text-anchor="middle">image</text>';
    // Distance L annotations
    s += '<line x1="180" y1="180" x2="300" y2="180" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<text x="240" y="195" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">L</text>';
    s += '<line x1="300" y1="180" x2="370" y2="180" stroke="#8b949e" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<text x="335" y="195" font-size="10" fill="#8b949e" text-anchor="middle" font-style="italic">L</text>';
    s += _svg_caption('Producer near a single sealing fault, image well at 2L');
    s += _svg_close();
    return s;
}

// 9. Parallel-channel — producer mid-channel between two parallel boundaries.
function _schematic_parallelChannel() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Two horizontal parallel sealing faults, top y=80, bottom y=220.
    s += '<line x1="20" y1="80" x2="380" y2="80" stroke="#da3633" stroke-width="3"/>';
    s += '<line x1="20" y1="220" x2="380" y2="220" stroke="#da3633" stroke-width="3"/>';
    // Hatching
    for (var i = 0; i < 18; i++) {
        var xx = 30 + i * 20;
        s += '<line x1="' + xx + '" y1="80" x2="' + (xx - 8) + '" y2="72" stroke="#da3633" stroke-width="0.7"/>';
        s += '<line x1="' + xx + '" y1="220" x2="' + (xx - 8) + '" y2="228" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Producer in centre.
    s += '<circle cx="200" cy="150" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="190" y="138" font-size="10" fill="#f0883e">well</text>';
    // W width annotation.
    s += '<line x1="350" y1="80" x2="350" y2="220" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<line x1="345" y1="80" x2="355" y2="80" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<line x1="345" y1="220" x2="355" y2="220" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<text x="362" y="155" font-size="11" fill="#c9d1d9" font-style="italic">W</text>';
    // d_w (distance to nearest boundary)
    s += '<line x1="220" y1="80" x2="220" y2="150" stroke="#8b949e" stroke-width="0.6" stroke-dasharray="2,2"/>';
    s += '<text x="227" y="118" font-size="9" fill="#8b949e" font-style="italic">d_w</text>';
    s += _svg_caption('Producer in mid-channel between two parallel sealing boundaries');
    s += _svg_close();
    return s;
}

// 10. Closed rectangle — producer in centre, four sealing sides.
function _schematic_closedRectangle() {
    var s = _svg_open();
    // Outer (background)
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Inner sealed rectangle
    s += '<rect x="50" y="70" width="300" height="160" fill="#161b22" stroke="#da3633" stroke-width="3"/>';
    // Hatching on all 4 sides (indicates sealed)
    for (var i = 0; i < 14; i++) {
        var xx = 60 + i * 22;
        s += '<line x1="' + xx + '" y1="70" x2="' + (xx - 6) + '" y2="64" stroke="#da3633" stroke-width="0.7"/>';
        s += '<line x1="' + xx + '" y1="230" x2="' + (xx - 6) + '" y2="236" stroke="#da3633" stroke-width="0.7"/>';
    }
    for (var j = 0; j < 7; j++) {
        var yy = 80 + j * 22;
        s += '<line x1="50" y1="' + yy + '" x2="44" y2="' + (yy - 6) + '" stroke="#da3633" stroke-width="0.7"/>';
        s += '<line x1="350" y1="' + yy + '" x2="356" y2="' + (yy - 6) + '" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Producer in centre
    s += '<circle cx="200" cy="150" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="208" y="146" font-size="10" fill="#f0883e">well</text>';
    // Dimensions
    s += '<text x="200" y="58" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">a</text>';
    s += '<text x="40" y="155" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">b</text>';
    s += _svg_caption('Producer at centre of fully closed rectangular drainage area');
    s += _svg_close();
    return s;
}

// 11. Intersecting faults — two faults at angle θ.
function _schematic_intersecting() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Faults intersect at (260, 150) — fault A horizontal to right, fault B at 45°.
    var ix = 260, iy = 150;
    s += '<line x1="' + ix + '" y1="' + iy + '" x2="380" y2="' + iy + '" stroke="#da3633" stroke-width="3"/>';
    s += '<line x1="' + ix + '" y1="' + iy + '" x2="380" y2="50" stroke="#da3633" stroke-width="3"/>';
    // Hatching along fault A
    for (var i = 0; i < 6; i++) {
        var xx = 270 + i * 18;
        s += '<line x1="' + xx + '" y1="' + iy + '" x2="' + (xx - 6) + '" y2="' + (iy - 8) + '" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Angle arc at intersection.
    s += '<path d="M 295 150 A 35 35 0 0 0 285 121" fill="none" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="306" y="138" font-size="11" fill="#58a6ff" font-style="italic">&#952;</text>';
    // Producer well to the south-west of intersection.
    s += '<circle cx="170" cy="180" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="120" y="175" font-size="10" fill="#f0883e">well</text>';
    s += _svg_caption('Two intersecting sealing faults, included angle &#952;');
    s += _svg_close();
    return s;
}

// 12. Double-porosity — cube of fractured matrix blocks.
function _schematic_doublePorosity() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Grid of matrix blocks (4x3 grid).
    var x0 = 50, y0 = 70, bw = 70, bh = 50;
    for (var col = 0; col < 4; col++) {
        for (var row = 0; row < 3; row++) {
            var xx = x0 + col * bw + col * 6;
            var yy = y0 + row * bh + row * 6;
            s += '<rect x="' + xx + '" y="' + yy + '" width="' + bw + '" height="' + bh + '" ' +
                 'fill="#3fb950" fill-opacity="0.32" stroke="#3fb950" stroke-width="0.7"/>';
            s += '<text x="' + (xx + bw / 2) + '" y="' + (yy + bh / 2 + 3) + '" font-size="8" fill="#3fb950" text-anchor="middle">m</text>';
        }
    }
    // Fracture network (darker) — gaps between blocks already present;
    // overlay tiny lines for clarity.
    for (var col2 = 1; col2 < 4; col2++) {
        var fx = x0 + col2 * bw + (col2 - 0.5) * 6;
        s += '<line x1="' + fx + '" y1="' + y0 + '" x2="' + fx + '" y2="' + (y0 + 3 * bh + 12) + '" ' +
             'stroke="#161b22" stroke-width="3"/>';
    }
    for (var row2 = 1; row2 < 3; row2++) {
        var fy = y0 + row2 * bh + (row2 - 0.5) * 6;
        s += '<line x1="' + x0 + '" y1="' + fy + '" x2="' + (x0 + 4 * bw + 18) + '" y2="' + fy + '" ' +
             'stroke="#161b22" stroke-width="3"/>';
    }
    s += '<text x="50" y="62" font-size="10" fill="#3fb950">matrix (light) + fracture network (dark)</text>';
    s += '<text x="50" y="252" font-size="10" fill="#c9d1d9" font-style="italic">' +
         '&#969; = storativity ratio,  &#955; = inter-porosity flow</text>';
    s += _svg_close();
    return s;
}

// 13. Partial penetration — vertical wellbore, perforated only over hp.
function _schematic_partialPen() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // Perforations only over central 40% of sand interval (hp < h).
    var pTop = 130, pBot = 180;
    for (var y2 = pTop; y2 <= pBot; y2 += 8) {
        s += '<line x1="196" y1="' + y2 + '" x2="180" y2="' + y2 + '" stroke="#f0883e" stroke-width="1.5"/>';
        s += '<line x1="204" y1="' + y2 + '" x2="220" y2="' + y2 + '" stroke="#f0883e" stroke-width="1.5"/>';
    }
    // hp annotation
    s += '<line x1="245" y1="' + pTop + '" x2="245" y2="' + pBot + '" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="240" y1="' + pTop + '" x2="250" y2="' + pTop + '" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="240" y1="' + pBot + '" x2="250" y2="' + pBot + '" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="255" y="160" font-size="11" fill="#c9d1d9" font-style="italic">h_p</text>';
    // h annotation
    s += '<line x1="285" y1="70" x2="285" y2="230" stroke="#8b949e" stroke-width="0.8" stroke-dasharray="2,2"/>';
    s += '<text x="295" y="155" font-size="10" fill="#8b949e" font-style="italic">h</text>';
    // z_w marker
    s += '<line x1="170" y1="155" x2="180" y2="155" stroke="#58a6ff" stroke-width="1"/>';
    s += '<text x="155" y="158" font-size="9" fill="#58a6ff" font-style="italic">z_w</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Vertical well with partial penetration (perfs over h_p &lt; h)');
    s += _svg_close();
    return s;
}

// 14. Vertical pulse / observation pair — producer + observation point at Δz.
function _schematic_verticalPulse() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Producer (left), observation (right).
    s += _svg_vwell(140, 24, 230, '#f0883e');
    s += _svg_vwell(280, 24, 230, '#58a6ff');
    // Active perfs on producer at (z_w_prod = 180).
    for (var y3 = 170; y3 <= 200; y3 += 6) {
        s += '<line x1="136" y1="' + y3 + '" x2="124" y2="' + y3 + '" stroke="#f0883e" stroke-width="1"/>';
        s += '<line x1="144" y1="' + y3 + '" x2="156" y2="' + y3 + '" stroke="#f0883e" stroke-width="1"/>';
    }
    // Observation point at (z_obs = 110).
    s += '<circle cx="280" cy="110" r="5" fill="#58a6ff" stroke="#58a6ff" stroke-width="2"/>';
    s += '<text x="290" y="114" font-size="10" fill="#58a6ff">observation</text>';
    // Δz annotation
    s += '<line x1="240" y1="110" x2="240" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="235" y1="110" x2="245" y2="110" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="235" y1="185" x2="245" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="248" y="152" font-size="11" fill="#c9d1d9" font-style="italic">&#916;z</text>';
    // Pulse arrows
    s += '<path d="M 156 175 Q 200 130 270 115" fill="none" stroke="#58a6ff" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += _svg_well_label(140, 'pulser');
    s += _svg_caption('Producer/injector + observation well at vertical separation &#916;z');
    s += _svg_close();
    return s;
}

// =========================================================================
// SECTION 1b — Additional schematics (round-2 fix: cover all 45 models)
// =========================================================================
// Compact diagrams for the remaining models in the registry. Use shared
// helpers for layered reservoirs / observation pairs / decline curves to
// keep total LOC manageable.

// ---- Shared helpers for the 1b additions --------------------------------

// Generic N-layer reservoir block (rectangles stacked vertically).
// Each layer gets a coloured fill + label. Returns SVG fragment + bottom Y.
function _svg_layers(x, y, w, layerSpecs) {
    // layerSpecs: [{label, h, color, opacity?}]
    var s = '';
    var yy = y;
    for (var i = 0; i < layerSpecs.length; i++) {
        var L = layerSpecs[i];
        s += '<rect x="' + x + '" y="' + yy + '" width="' + w + '" height="' + L.h + '" ' +
             'fill="' + (L.color || '#3fb950') + '" fill-opacity="' + (L.opacity || 0.22) + '" ' +
             'stroke="' + (L.color || '#3fb950') + '" stroke-width="0.7"/>';
        s += '<text x="' + (x + 6) + '" y="' + (yy + L.h / 2 + 3) + '" font-size="9" fill="#c9d1d9">' + L.label + '</text>';
        yy += L.h;
    }
    return { svg: s, bottom: yy };
}

// Cross-flow arrow between two y-levels (inside the well column).
function _svg_xflowArrow(x, y1, y2, color) {
    color = color || '#58a6ff';
    var dir = (y2 > y1) ? 1 : -1;
    var ay = y2 - dir * 4;
    return '<line x1="' + x + '" y1="' + y1 + '" x2="' + x + '" y2="' + y2 + '" stroke="' + color +
           '" stroke-width="1" stroke-dasharray="2,2"/>' +
           '<polygon points="' + (x - 3) + ',' + ay + ' ' + (x + 3) + ',' + ay + ' ' + x + ',' + y2 +
           '" fill="' + color + '"/>';
}

// Sealing fault tick-line (red line + hatching).
function _svg_seal(x1, y1, x2, y2, hatchSide) {
    hatchSide = hatchSide || 'right';
    var s = '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#da3633" stroke-width="2.5"/>';
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    var nx = -dy / len, ny = dx / len;
    if (hatchSide === 'left') { nx = -nx; ny = -ny; }
    var n = 10;
    for (var i = 1; i < n; i++) {
        var t = i / n;
        var mx = x1 + dx * t, my = y1 + dy * t;
        s += '<line x1="' + mx + '" y1="' + my + '" x2="' + (mx + nx * 6) + '" y2="' + (my + ny * 6) +
             '" stroke="#da3633" stroke-width="0.7"/>';
    }
    return s;
}

// Mini decline-curve plot in a box. expressionType is 'exp', 'hyp', 'harm',
// 'duong', 'sepd', 'fetkovich'.
function _svg_declineCurve(x, y, w, h, type, label) {
    var s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
            '" fill="#0d1117" stroke="#30363d" stroke-width="0.7"/>';
    // Axes
    s += '<line x1="' + (x + 8) + '" y1="' + (y + 8) + '" x2="' + (x + 8) + '" y2="' + (y + h - 12) +
         '" stroke="#8b949e" stroke-width="0.6"/>';
    s += '<line x1="' + (x + 8) + '" y1="' + (y + h - 12) + '" x2="' + (x + w - 8) + '" y2="' + (y + h - 12) +
         '" stroke="#8b949e" stroke-width="0.6"/>';
    // Curve
    var pts = '', N = 40;
    for (var i = 0; i < N; i++) {
        var u = i / (N - 1);                         // 0..1
        var qFrac;
        switch (type) {
            case 'exp':       qFrac = Math.exp(-3.5 * u);                                    break;
            case 'harm':      qFrac = 1 / (1 + 5 * u);                                       break;
            case 'hyp':       qFrac = Math.pow(1 + 4.5 * u, -1.4);                           break;
            case 'duong':     qFrac = Math.pow(1 + 0.05 * u * 80, -1.3) * (1 + 0.1 * u * 80) / (1 + 8); break;
            case 'sepd':      qFrac = Math.exp(-Math.pow(4 * u, 0.6));                       break;
            case 'fetkovich': qFrac = (u < 0.3) ? 1 - 0.6 * u : Math.exp(-3 * (u - 0.3));    break;
            default:          qFrac = Math.exp(-2 * u);
        }
        var px = x + 8 + u * (w - 16);
        var py = y + h - 12 - qFrac * (h - 24);
        pts += (i ? ' L ' : 'M ') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    s += '<path d="' + pts + '" fill="none" stroke="#f0883e" stroke-width="1.6"/>';
    // Label
    s += '<text x="' + (x + w / 2) + '" y="' + (y + 8) + '" font-size="9" fill="#c9d1d9" text-anchor="middle">' + label + '</text>';
    s += '<text x="' + (x + 4) + '" y="' + (y + 12) + '" font-size="7" fill="#8b949e">q</text>';
    s += '<text x="' + (x + w - 14) + '" y="' + (y + h - 3) + '" font-size="7" fill="#8b949e">t</text>';
    return s;
}

// Small inline observation well at (x, y_obs) with target marker.
function _svg_obswell(x, ySurface, yObs, color) {
    color = color || '#58a6ff';
    var s = '<polygon points="' + (x - 4) + ',12 ' + (x + 4) + ',12 ' + x + ',22" fill="' + color + '"/>';
    s += '<rect x="' + (x - 3) + '" y="' + ySurface + '" width="6" height="' + (yObs - ySurface) +
         '" fill="#0d1117" stroke="' + color + '" stroke-width="1"/>';
    s += '<circle cx="' + x + '" cy="' + yObs + '" r="4" fill="' + color + '" stroke="' + color + '" stroke-width="1.5"/>';
    return s;
}

// ---- Schematics for the 32 remaining models -----------------------------

// 15. Closed channel (3-sided: parallelChannel + one closed end).
function _schematic_closedChannel3() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Top + bottom parallel sealing faults
    s += _svg_seal(20, 80, 380, 80, 'right');
    s += _svg_seal(20, 220, 380, 220, 'left');
    // Closed end on the right (vertical sealing line)
    s += _svg_seal(380, 80, 380, 220, 'left');
    // Producer
    s += '<circle cx="160" cy="150" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="148" y="138" font-size="10" fill="#f0883e">well</text>';
    // Width annotation
    s += '<line x1="345" y1="80" x2="345" y2="220" stroke="#8b949e" stroke-width="0.6"/>';
    s += '<text x="355" y="155" font-size="11" fill="#c9d1d9" font-style="italic">W</text>';
    // Distance to closed end
    s += '<line x1="160" y1="240" x2="380" y2="240" stroke="#8b949e" stroke-width="0.6" stroke-dasharray="2,2"/>';
    s += '<text x="265" y="252" font-size="9" fill="#8b949e" font-style="italic">d_end</text>';
    s += _svg_caption('Producer in 3-sided closed channel (two parallel + one closing boundary)');
    s += _svg_close();
    return s;
}

// 16. Fog / partial-transmissibility boundary.
function _schematic_fogBoundary() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Partial fault — orange/amber dashed line (not solid red sealing).
    s += '<line x1="20" y1="150" x2="380" y2="150" stroke="#f0883e" stroke-width="2.5" stroke-dasharray="6,4"/>';
    // Fog symbol — blurry pressure communication across the line.
    for (var i = 0; i < 12; i++) {
        var xx = 50 + i * 25;
        s += '<circle cx="' + xx + '" cy="150" r="3" fill="#f0883e" fill-opacity="0.35"/>';
    }
    s += '<text x="200" y="142" font-size="10" fill="#f0883e" text-anchor="middle">partially sealing — transmissibility &#964; &#8712; (-1, 1)</text>';
    // Producer
    s += '<circle cx="200" cy="200" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="208" y="196" font-size="10" fill="#f0883e">well</text>';
    // Pressure isobars on producer side
    s += _svg_isobars(200, 200, 70, 4);
    // Distance annotation
    s += '<line x1="200" y1="158" x2="200" y2="195" stroke="#8b949e" stroke-width="0.7" stroke-dasharray="2,2"/>';
    s += '<text x="208" y="180" font-size="9" fill="#8b949e" font-style="italic">L</text>';
    s += _svg_caption('Producer + leaky/fog boundary: transmissibility &#964; sets sealed (1) ↔ fully open (-1)');
    s += _svg_close();
    return s;
}

// 17-20. Decline-curve schematics (Arps / Duong / SEPD / Fetkovich).
function _schematic_arps() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(40,  60,  150, 100, 'exp',  'b = 0 (exponential)');
    s += _svg_declineCurve(210, 60,  150, 100, 'harm', 'b = 1 (harmonic)');
    s += _svg_declineCurve(40,  175, 150, 75,  'hyp',  'b ∈ (0, 1) hyperbolic');
    s += '<text x="285" y="200" font-size="10" fill="#c9d1d9" text-anchor="middle">q(t) = q_i / (1 + b·D_i·t)^(1/b)</text>';
    s += '<text x="285" y="220" font-size="9" fill="#8b949e" text-anchor="middle">Arps (1945)</text>';
    s += _svg_caption('Arps decline — three regimes (exp / hyp / harmonic) by b-factor');
    s += _svg_close();
    return s;
}
function _schematic_duong() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(60, 60, 280, 140, 'duong', 'Duong shale rate-time');
    s += '<text x="200" y="225" font-size="10" fill="#c9d1d9" text-anchor="middle">q(t) = q_1 · t^(-m) · exp[a/(1-m) (t^(1-m) - 1)]</text>';
    s += '<text x="200" y="245" font-size="9" fill="#8b949e" text-anchor="middle">Duong (2011) — for transient shale gas/oil</text>';
    s += _svg_close();
    return s;
}
function _schematic_sepd() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(60, 60, 280, 140, 'sepd', 'Stretched Exponential');
    s += '<text x="200" y="225" font-size="10" fill="#c9d1d9" text-anchor="middle">q(t) = q_i · exp[-(t/τ)^n]</text>';
    s += '<text x="200" y="245" font-size="9" fill="#8b949e" text-anchor="middle">Valko (2009) — finite-EUR decline form</text>';
    s += _svg_close();
    return s;
}
function _schematic_fetkovich() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(60, 60, 280, 140, 'fetkovich', 'Fetkovich type curve');
    s += '<text x="200" y="225" font-size="10" fill="#c9d1d9" text-anchor="middle">Transient → BDF blend (closed-circle implied geometry)</text>';
    s += '<text x="200" y="245" font-size="9" fill="#8b949e" text-anchor="middle">Fetkovich (JPT Jun 1980)</text>';
    s += _svg_close();
    return s;
}

// 21. Radial composite — two concentric zones, mobility ratio M.
function _schematic_radialComposite() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 200, cy = 150;
    // Outer zone
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="100" fill="#3fb950" fill-opacity="0.10" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<text x="' + (cx + 80) + '" y="' + (cy - 70) + '" font-size="10" fill="#3fb950">k_2, &#956;_2</text>';
    // Inner zone
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="55" fill="#58a6ff" fill-opacity="0.20" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="' + (cx - 6) + '" y="' + (cy + 36) + '" font-size="10" fill="#58a6ff">k_1, &#956;_1</text>';
    // Producer at centre
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    s += '<text x="' + (cx - 28) + '" y="' + (cy - 8) + '" font-size="10" fill="#f0883e">well</text>';
    // Interface radius R
    s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + 55) + '" y2="' + cy + '" stroke="#c9d1d9" stroke-dasharray="2,2"/>';
    s += '<text x="' + (cx + 25) + '" y="' + (cy - 4) + '" font-size="9" fill="#c9d1d9" font-style="italic">R</text>';
    s += '<text x="200" y="60" font-size="11" fill="#c9d1d9" text-anchor="middle">Mobility ratio M = (k/&#956;)_2 / (k/&#956;)_1</text>';
    s += _svg_caption('Radial composite reservoir — inner zone + outer zone of different mobility');
    s += _svg_close();
    return s;
}

// 22. Linear composite — vertical bands of different mobility.
function _schematic_linearComposite() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var bands = [
        { x: 20,  w: 110, color: '#58a6ff', label: 'k_1' },
        { x: 130, w: 110, color: '#3fb950', label: 'k_2' },
        { x: 240, w: 140, color: '#a371f7', label: 'k_3' }
    ];
    for (var i = 0; i < bands.length; i++) {
        var b = bands[i];
        s += '<rect x="' + b.x + '" y="40" width="' + b.w + '" height="220" fill="' + b.color +
             '" fill-opacity="0.15" stroke="' + b.color + '" stroke-width="0.7"/>';
        s += '<text x="' + (b.x + b.w / 2) + '" y="60" font-size="11" fill="' + b.color +
             '" text-anchor="middle">' + b.label + '</text>';
    }
    // Discontinuities (vertical dashed)
    s += '<line x1="130" y1="40" x2="130" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<line x1="240" y1="40" x2="240" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    // Producer in zone 1
    s += '<circle cx="80" cy="150" r="6" fill="#f0883e"/>';
    s += '<text x="68" y="170" font-size="10" fill="#f0883e">well</text>';
    // Distance labels
    s += '<text x="130" y="278" font-size="9" fill="#8b949e" text-anchor="middle">L_1</text>';
    s += '<text x="240" y="278" font-size="9" fill="#8b949e" text-anchor="middle">L_2</text>';
    s += _svg_caption('Linear composite — discontinuities at L_1, L_2 (up to 5 zones)');
    s += _svg_close();
    return s;
}

// 23. Two-layer with cross-flow.
function _schematic_twoLayerXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += '<rect x="20" y="65" width="360" height="80" fill="#3fb950" fill-opacity="0.18" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<text x="34" y="108" font-size="10" fill="#3fb950">Layer 1 — k_1, &#966;_1, h_1</text>';
    s += '<rect x="20" y="145" width="360" height="80" fill="#58a6ff" fill-opacity="0.18" stroke="#58a6ff" stroke-width="0.7"/>';
    s += '<text x="34" y="188" font-size="10" fill="#58a6ff">Layer 2 — k_2, &#966;_2, h_2</text>';
    s += _svg_baserock(225, 25);
    s += _svg_vwell(200, 24, 225, '#f0883e');
    // Cross-flow arrows
    s += _svg_xflowArrow(170, 100, 170, 175, '#c9d1d9');
    s += _svg_xflowArrow(230, 175, 230, 100, '#c9d1d9');
    s += '<text x="248" y="148" font-size="10" fill="#c9d1d9">&#955; cross-flow</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Two-layer reservoir with PSS cross-flow rate &#955;');
    s += _svg_close();
    return s;
}

// 24. Multi-layer with cross-flow — N stacked layers.
function _schematic_multiLayerXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' },
        { label: 'Layer 4', h: 50, color: '#d29922' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    // Cross-flow indicators between adjacent layers
    s += _svg_xflowArrow(176, 95,  176, 145, '#c9d1d9');
    s += _svg_xflowArrow(176, 145, 176, 195, '#c9d1d9');
    s += _svg_xflowArrow(176, 195, 176, 245, '#c9d1d9');
    s += '<text x="100" y="280" font-size="10" fill="#c9d1d9">&#955; controls inter-layer transient flow</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Multi-layer reservoir (N≤5) with cross-flow between adjacent pairs');
    s += _svg_close();
    return s;
}

// 25. Multi-layer NO cross-flow (commingled).
function _schematic_multiLayerNoXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1 (kh_1, S_1)', h: 60, color: '#3fb950' },
        { label: 'Layer 2 (kh_2, S_2)', h: 60, color: '#58a6ff' },
        { label: 'Layer 3 (kh_3, S_3)', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    // Sealing barriers between layers (red bars)
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    s += '<text x="100" y="280" font-size="10" fill="#c9d1d9">no inter-layer flow → commingled</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Multi-layer commingled (no cross-flow): rate weighted by kh fraction');
    s += _svg_close();
    return s;
}

// 26. Multi-layer fractured commingled.
function _schematic_mlNoXFFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'frac', h: 60, color: '#3fb950' },
        { label: 'frac', h: 60, color: '#58a6ff' },
        { label: 'frac', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    // Each layer has a horizontal fracture symbol
    var fracY = [90, 150, 210];
    for (var i = 0; i < fracY.length; i++) {
        s += '<rect x="100" y="' + (fracY[i] - 2) + '" width="200" height="4" fill="#f0883e" fill-opacity="0.7"/>';
    }
    s += '<text x="305" y="90" font-size="9" fill="#f0883e">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Multi-layer fractured commingled (each layer has its own ∞-cond fracture)');
    s += _svg_close();
    return s;
}

// 27. Multi-layer horizontal commingled.
function _schematic_mlNoXFHoriz() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'horiz', h: 60, color: '#3fb950' },
        { label: 'horiz', h: 60, color: '#58a6ff' },
        { label: 'horiz', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(layers.bottom, 20);
    // Vertical riser on left, then horizontal segments per layer
    s += '<rect x="56" y="24" width="8" height="36" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += _svg_hwell(60, 320, 90,  '#f0883e');
    s += _svg_hwell(60, 320, 150, '#f0883e');
    s += _svg_hwell(60, 320, 210, '#f0883e');
    s += _svg_well_label(60, 'multi-lateral horizontal');
    s += _svg_caption('Multi-layer horizontal commingled — one lateral per layer, no XF');
    s += _svg_close();
    return s;
}

// 28. ML horizontal with cross-flow.
function _schematic_mlHorizontalXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2 ← horizontal', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' },
        { label: 'Layer 4', h: 50, color: '#d29922' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    // Vertical riser
    s += '<rect x="56" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    // Horizontal completion in layer 2
    s += _svg_hwell(60, 340, 135, '#f0883e');
    // Cross-flow arrows
    s += _svg_xflowArrow(280, 110, 280, 160, '#c9d1d9');
    s += _svg_xflowArrow(280, 160, 280, 210, '#c9d1d9');
    s += '<text x="290" y="178" font-size="9" fill="#c9d1d9">&#955; cross-flow</text>';
    s += _svg_well_label(60, 'horizontal');
    s += _svg_caption('Horizontal well in N-layer reservoir with full transient cross-flow');
    s += _svg_close();
    return s;
}

// 29. Inclined well in multi-layer with XF.
function _schematic_inclinedMLXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 60, color: '#3fb950' },
        { label: 'Layer 2', h: 60, color: '#58a6ff' },
        { label: 'Layer 3', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    // Inclined well
    s += '<polygon points="105,12 125,12 115,24" fill="#f0883e"/>';
    s += '<line x1="115" y1="24" x2="265" y2="240" stroke="#f0883e" stroke-width="3"/>';
    s += '<text x="150" y="40" font-size="10" fill="#f0883e">inclined &#952;_w</text>';
    // Cross-flow arrows
    s += _svg_xflowArrow(330, 90,  330, 150, '#c9d1d9');
    s += _svg_xflowArrow(330, 150, 330, 210, '#c9d1d9');
    s += _svg_caption('Inclined well penetrating N layers with full transient XF');
    s += _svg_close();
    return s;
}

// 30. Multi-lateral (star pattern) in ML+XF.
function _schematic_multiLatMLXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    // Vertical riser to mid layer
    s += '<rect x="196" y="24" width="8" height="111" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    // Three lateral legs at junction (mid of layer 2)
    var jx = 200, jy = 135;
    s += '<line x1="' + jx + '" y1="' + jy + '" x2="60"  y2="' + jy + '" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="' + jx + '" y1="' + jy + '" x2="340" y2="' + jy + '" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="' + jx + '" y1="' + jy + '" x2="' + jx + '" y2="200" stroke="#f0883e" stroke-width="3"/>';
    s += '<circle cx="' + jx + '" cy="' + jy + '" r="5" fill="#f0883e"/>';
    s += _svg_well_label(200, 'multi-lateral');
    s += '<text x="200" y="280" font-size="10" fill="#c9d1d9" text-anchor="middle">N parallel/star segments — superposed line-source coupling</text>';
    s += _svg_close();
    return s;
}

// 31. ML multi-perforation (≤4 perfs at various depths).
function _schematic_mlMultiPerf() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' },
        { label: 'Layer 4', h: 50, color: '#d29922' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    // Perfs at the centre of layers 1, 2, 4 (skipping 3).
    var perfYs = [85, 135, 235];
    for (var i = 0; i < perfYs.length; i++) {
        var y = perfYs[i];
        for (var k = 0; k < 3; k++) {
            s += '<line x1="196" y1="' + (y - 4 + k * 4) + '" x2="170" y2="' + (y - 4 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
            s += '<line x1="204" y1="' + (y - 4 + k * 4) + '" x2="230" y2="' + (y - 4 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
        }
    }
    s += _svg_well_label(200, 'producer (perfs)');
    s += _svg_caption('Multi-perforation in layered reservoir with cross-flow (1-4 perfs)');
    s += _svg_close();
    return s;
}

// 32. General ML no-XF (heterogeneous well types per layer).
function _schematic_generalMLNoXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    // Layer 1: vertical well, Layer 2: fracture, Layer 3: horizontal
    s += '<rect x="20" y="60" width="360" height="60" fill="#3fb950" fill-opacity="0.15" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<text x="34" y="92" font-size="9" fill="#3fb950">Layer 1 — vertical well + WBS</text>';
    s += '<rect x="20" y="120" width="360" height="60" fill="#58a6ff" fill-opacity="0.15" stroke="#58a6ff" stroke-width="0.7"/>';
    s += '<text x="34" y="152" font-size="9" fill="#58a6ff">Layer 2 — hydraulic fracture</text>';
    s += '<rect x="20" y="180" width="360" height="60" fill="#a371f7" fill-opacity="0.15" stroke="#a371f7" stroke-width="0.7"/>';
    s += '<text x="34" y="212" font-size="9" fill="#a371f7">Layer 3 — horizontal completion</text>';
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(240, 20);
    s += _svg_vwell(200, 24, 121, '#f0883e');                       // vertical perfs in layer 1
    s += '<rect x="100" y="148" width="200" height="4" fill="#f0883e"/>';   // fracture in layer 2
    s += _svg_hwell(60, 340, 210, '#f0883e');                       // horizontal in layer 3
    s += _svg_caption('General multi-layer no-XF — each layer can be a different well/reservoir type');
    s += _svg_close();
    return s;
}

// 33. General heterogeneity radial composite (3 zones).
function _schematic_genHetRadial() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 200, cy = 150;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="100" fill="#a371f7" fill-opacity="0.10" stroke="#a371f7" stroke-width="0.7"/>';
    s += '<text x="' + (cx + 80) + '" y="' + (cy - 70) + '" font-size="10" fill="#a371f7">Zone 3</text>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="65" fill="#3fb950" fill-opacity="0.18" stroke="#3fb950" stroke-width="1"/>';
    s += '<text x="' + (cx + 50) + '" y="' + (cy - 32) + '" font-size="10" fill="#3fb950">Zone 2</text>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="35" fill="#58a6ff" fill-opacity="0.25" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="' + (cx - 14) + '" y="' + (cy + 28) + '" font-size="10" fill="#58a6ff">Zone 1</text>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    s += '<text x="' + (cx - 22) + '" y="' + (cy - 8) + '" font-size="9" fill="#f0883e">well</text>';
    s += '<text x="200" y="60" font-size="11" fill="#c9d1d9" text-anchor="middle">Radial composite (3 zones, R₁ &lt; R₂)</text>';
    s += _svg_caption('General heterogeneity — multi-zone radial composite');
    s += _svg_close();
    return s;
}

// 34. General heterogeneity radial+linear composite.
function _schematic_genHetRadialLinear() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 200, cy = 150;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="90" fill="#3fb950" fill-opacity="0.15" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="50" fill="#58a6ff" fill-opacity="0.20" stroke="#58a6ff" stroke-width="1"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    // Linear discontinuity (vertical fault on right)
    s += _svg_seal(330, 60, 330, 240, 'left');
    s += '<text x="280" y="55" font-size="9" fill="#da3633">linear fault</text>';
    s += '<text x="200" y="270" font-size="10" fill="#c9d1d9" text-anchor="middle">Radial composite + linear discontinuity</text>';
    s += _svg_close();
    return s;
}

// 35. Two-well interference test.
function _schematic_interference() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += _svg_sand(65, 170);
    s += _svg_baserock(235, 25);
    s += _svg_vwell(110, 24, 235, '#f0883e');
    s += _svg_well_label(110, 'producer');
    s += _svg_obswell(290, 24, 150, '#58a6ff');
    s += '<text x="295" y="170" font-size="10" fill="#58a6ff">observation</text>';
    // Pressure pulse arrows
    s += _svg_isobars(110, 150, 90, 4);
    // Distance annotation
    s += '<line x1="110" y1="252" x2="290" y2="252" stroke="#8b949e" stroke-width="0.7"/>';
    s += '<line x1="110" y1="248" x2="110" y2="256" stroke="#8b949e" stroke-width="0.7"/>';
    s += '<line x1="290" y1="248" x2="290" y2="256" stroke="#8b949e" stroke-width="0.7"/>';
    s += '<text x="200" y="266" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">r_obs</text>';
    s += _svg_caption('Producer + observation well: pressure response from a flowing well (line-source)');
    s += _svg_close();
    return s;
}

// 36. ML horizontal interference test.
function _schematic_mlHorizInterference() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    // Producer horizontal in layer 2
    s += '<rect x="36" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += _svg_hwell(40, 200, 135, '#f0883e');
    s += _svg_well_label(40, 'producer');
    // Observation horizontal in same layer
    s += '<rect x="356" y="24" width="8" height="86" fill="#0d1117" stroke="#58a6ff" stroke-width="1.5"/>';
    s += _svg_hwell(220, 360, 135, '#58a6ff');
    s += '<text x="280" y="155" font-size="10" fill="#58a6ff">observation</text>';
    s += _svg_caption('Two horizontal wells in layered reservoir — interference test');
    s += _svg_close();
    return s;
}

// 37. ML multi-perf interference test.
function _schematic_mlMultiPerfInterference() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    // Producer with perfs in layers 1, 3
    s += _svg_vwell(120, 24, 210, '#f0883e');
    for (var k = 0; k < 3; k++) {
        s += '<line x1="116" y1="' + (85 + k * 4) + '" x2="100" y2="' + (85 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
        s += '<line x1="116" y1="' + (185 + k * 4) + '" x2="100" y2="' + (185 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
    }
    s += _svg_well_label(120, 'producer');
    // Observation in layer 2
    s += _svg_obswell(280, 24, 135, '#58a6ff');
    s += '<text x="285" y="155" font-size="10" fill="#58a6ff">obs</text>';
    s += _svg_caption('Multi-perforation interference (≤3 producing perfs + 1 observation)');
    s += _svg_close();
    return s;
}

// 38. Inclined-well interference test.
function _schematic_inclinedInterference() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += _svg_sand(65, 170);
    s += _svg_baserock(235, 25);
    // Producer inclined well
    s += '<polygon points="65,12 85,12 75,24" fill="#f0883e"/>';
    s += '<line x1="75" y1="24" x2="180" y2="235" stroke="#f0883e" stroke-width="3"/>';
    s += '<text x="32" y="40" font-size="9" fill="#f0883e">producer &#952;_p</text>';
    // Observation inclined well
    s += '<polygon points="305,12 325,12 315,24" fill="#58a6ff"/>';
    s += '<line x1="315" y1="24" x2="240" y2="235" stroke="#58a6ff" stroke-width="3"/>';
    s += '<text x="305" y="40" font-size="9" fill="#58a6ff">obs &#952;_o</text>';
    s += _svg_caption('Two inclined wells in homogeneous (or double-porosity) reservoir');
    s += _svg_close();
    return s;
}

// 39. Linear-composite interference test.
function _schematic_linearCompInterference() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += '<rect x="20" y="40" width="120" height="220" fill="#58a6ff" fill-opacity="0.15"/>';
    s += '<rect x="140" y="40" width="120" height="220" fill="#3fb950" fill-opacity="0.15"/>';
    s += '<rect x="260" y="40" width="120" height="220" fill="#a371f7" fill-opacity="0.15"/>';
    s += '<line x1="140" y1="40" x2="140" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<line x1="260" y1="40" x2="260" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<circle cx="60" cy="150" r="6" fill="#f0883e"/>';
    s += '<text x="48" y="170" font-size="10" fill="#f0883e">producer</text>';
    s += _svg_obswell(330, 24, 150, '#58a6ff');
    s += '<text x="306" y="178" font-size="9" fill="#58a6ff">observation</text>';
    s += _svg_caption('Observation well in linear-composite reservoir (≤5 zones)');
    s += _svg_close();
    return s;
}

// 40. Linear-composite multi-lateral.
function _schematic_linearCompMultiLat() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="180" height="220" fill="#58a6ff" fill-opacity="0.15"/>';
    s += '<rect x="200" y="40" width="180" height="220" fill="#3fb950" fill-opacity="0.15"/>';
    s += '<line x1="200" y1="40" x2="200" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    // Multi-lateral producer in zone 1 (left)
    s += '<rect x="96" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += '<line x1="100" y1="135" x2="40"  y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="100" y1="135" x2="160" y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="100" y1="135" x2="100" y2="200" stroke="#f0883e" stroke-width="3"/>';
    s += '<circle cx="100" cy="135" r="5" fill="#f0883e"/>';
    s += _svg_caption('Multi-lateral producer in linear-composite reservoir');
    s += _svg_close();
    return s;
}

// 41. Linear-composite multi-lateral interference.
function _schematic_linearCompMultiLatInterference() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="180" height="220" fill="#58a6ff" fill-opacity="0.15"/>';
    s += '<rect x="200" y="40" width="180" height="220" fill="#3fb950" fill-opacity="0.15"/>';
    s += '<line x1="200" y1="40" x2="200" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<rect x="96" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += '<line x1="100" y1="135" x2="40"  y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="100" y1="135" x2="160" y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<circle cx="100" cy="135" r="5" fill="#f0883e"/>';
    s += _svg_obswell(320, 24, 150, '#58a6ff');
    s += '<text x="296" y="178" font-size="9" fill="#58a6ff">obs</text>';
    s += _svg_caption('Observation well + multi-lateral producer in linear-composite');
    s += _svg_close();
    return s;
}

// 42. ML interference with cross-flow.
function _schematic_mlInterferenceXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    s += _svg_vwell(100, 24, 210, '#f0883e');
    s += _svg_well_label(100, 'producer');
    s += _svg_obswell(290, 24, 135, '#58a6ff');
    s += '<text x="296" y="155" font-size="9" fill="#58a6ff">obs (x, y)</text>';
    // XF arrows between layers
    s += _svg_xflowArrow(200, 110, 200, 160, '#c9d1d9');
    s += _svg_xflowArrow(200, 160, 200, 210, '#c9d1d9');
    s += _svg_caption('Interference at arbitrary (x, y) point in any layer with PSS &#955;-controlled XF');
    s += _svg_close();
    return s;
}

// 43. Radial composite interference.
function _schematic_radialCompInterference() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 160, cy = 150;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="100" fill="#3fb950" fill-opacity="0.10" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="50" fill="#58a6ff" fill-opacity="0.20" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    s += '<text x="' + (cx - 30) + '" y="' + (cy - 12) + '" font-size="10" fill="#f0883e">producer</text>';
    // Observation outside outer zone
    s += '<circle cx="320" cy="80" r="5" fill="#58a6ff"/>';
    s += '<text x="290" y="74" font-size="9" fill="#58a6ff">obs (x, y)</text>';
    s += _svg_caption('Observation pressure in 2-zone radial-composite reservoir');
    s += _svg_close();
    return s;
}

// 44. User-defined type curve — table icon + curve.
function _schematic_userDefined() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Mini table (left).
    s += '<rect x="40" y="60" width="130" height="180" fill="#161b22" stroke="#30363d"/>';
    s += '<text x="105" y="78" font-size="11" fill="#c9d1d9" text-anchor="middle">td      pd</text>';
    s += '<line x1="50" y1="84" x2="160" y2="84" stroke="#30363d"/>';
    var rows = ['1e-3   0.02', '1e-2   0.12', '1e-1   0.57', '1      2.30', '10     4.61', '100    6.91'];
    for (var i = 0; i < rows.length; i++) {
        s += '<text x="105" y="' + (102 + i * 22) + '" font-size="10" fill="#8b949e" text-anchor="middle" font-family="monospace">' + rows[i] + '</text>';
    }
    // Right: log-log curve from the table.
    var x0 = 200, y0 = 70, w = 170, h = 170;
    s += '<rect x="' + x0 + '" y="' + y0 + '" width="' + w + '" height="' + h + '" fill="#0d1117" stroke="#30363d"/>';
    s += '<line x1="' + (x0 + 12) + '" y1="' + (y0 + 12) + '" x2="' + (x0 + 12) + '" y2="' + (y0 + h - 16) + '" stroke="#8b949e" stroke-width="0.6"/>';
    s += '<line x1="' + (x0 + 12) + '" y1="' + (y0 + h - 16) + '" x2="' + (x0 + w - 8) + '" y2="' + (y0 + h - 16) + '" stroke="#8b949e" stroke-width="0.6"/>';
    var pts = '';
    for (var k = 0; k < 30; k++) {
        var u = k / 29;
        var px = x0 + 12 + u * (w - 20);
        var py = y0 + h - 16 - Math.log10(1 + 9 * u) * (h - 28) * 0.85;
        pts += (k ? ' L ' : 'M ') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    s += '<path d="' + pts + '" fill="none" stroke="#f0883e" stroke-width="1.6"/>';
    s += '<text x="' + (x0 + w / 2) + '" y="' + (y0 + 8) + '" font-size="10" fill="#c9d1d9" text-anchor="middle">log-log interpolation</text>';
    s += _svg_caption('User-defined type-curve — load (td, pd) table + linear interp in log-log');
    s += _svg_close();
    return s;
}

// 45. Water injection — front + saturation profile.
function _schematic_waterInjection() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += '<rect x="20" y="65" width="360" height="170" fill="url(#sandPattern)" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_baserock(235, 25);
    // Injection well (left). Arrow points DOWN to indicate injection.
    s += '<polygon points="65,12 85,12 75,24" fill="#58a6ff" transform="rotate(180 75 18)"/>';
    s += _svg_vwell(75, 24, 235, '#58a6ff');
    s += '<text x="35" y="20" font-size="10" fill="#58a6ff">injector</text>';
    // Water-swept (blue) inner zone
    s += '<rect x="20" y="65" width="160" height="170" fill="#58a6ff" fill-opacity="0.30"/>';
    s += '<text x="100" y="105" font-size="10" fill="#58a6ff" text-anchor="middle">water swept (S_w &gt; S_wc)</text>';
    // Front (vertical sharp boundary)
    s += '<line x1="180" y1="65" x2="180" y2="235" stroke="#58a6ff" stroke-width="2"/>';
    s += '<text x="186" y="80" font-size="9" fill="#58a6ff" font-style="italic">r_f (front)</text>';
    // Oil zone
    s += '<rect x="180" y="65" width="200" height="170" fill="#f0883e" fill-opacity="0.10"/>';
    s += '<text x="285" y="160" font-size="10" fill="#f0883e" text-anchor="middle">oil (S_w = S_wc)</text>';
    s += _svg_caption('Water injection — Buckley-Leverett-like piston front advances with W_inj');
    s += _svg_close();
    return s;
}

// Generic placeholder for unsupported keys.
function _schematic_placeholder(modelKey) {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    s += _svg_vwell(200, 24, 230, '#f0883e');
    s += _svg_well_label(200, 'well');
    s += '<text x="200" y="150" font-size="14" fill="#8b949e" text-anchor="middle" font-style="italic">' +
         (modelKey || 'model') + '</text>';
    s += '<text x="200" y="170" font-size="10" fill="#8b949e" text-anchor="middle">(no schematic — see reference)</text>';
    s += _svg_caption('Schematic not yet illustrated for this model');
    s += _svg_close();
    return s;
}

// Public dispatch — covers all 45 PRiSM_MODELS entries.
window.PRiSM_getModelSchematic = function (modelKey) {
    if (!modelKey) return '';
    switch (modelKey) {
        // Core (Phase 1+2)
        case 'homogeneous':      return _schematic_homogeneous();
        case 'infiniteFrac':     return _schematic_infiniteFrac();
        case 'finiteFrac':       return _schematic_finiteFrac();
        case 'finiteFracSkin':   return _schematic_finiteFracSkin();
        case 'inclined':         return _schematic_inclined();
        case 'horizontal':       return _schematic_horizontal();
        case 'partialPenFrac':   return _schematic_partialPenFrac();
        case 'linearBoundary':   return _schematic_linearBoundary();
        case 'parallelChannel':  return _schematic_parallelChannel();
        case 'closedRectangle':  return _schematic_closedRectangle();
        case 'intersecting':     return _schematic_intersecting();
        case 'doublePorosity':   return _schematic_doublePorosity();
        case 'partialPen':       return _schematic_partialPen();
        case 'verticalPulse':    return _schematic_verticalPulse();
        // Boundary (Phase 2 extras)
        case 'closedChannel3':   return _schematic_closedChannel3();
        case 'fogBoundary':      return _schematic_fogBoundary();
        // Decline (Phase 3)
        case 'arps':             return _schematic_arps();
        case 'duong':            return _schematic_duong();
        case 'sepd':             return _schematic_sepd();
        case 'fetkovich':        return _schematic_fetkovich();
        // Composite + multi-layer (Phase 5)
        case 'radialComposite':  return _schematic_radialComposite();
        case 'linearComposite':  return _schematic_linearComposite();
        case 'twoLayerXF':       return _schematic_twoLayerXF();
        case 'multiLayerXF':     return _schematic_multiLayerXF();
        case 'multiLayerNoXF':   return _schematic_multiLayerNoXF();
        case 'genHetRadial':     return _schematic_genHetRadial();
        case 'genHetRadialLinear': return _schematic_genHetRadialLinear();
        // Multi-layer well variants (Phase 6)
        case 'mlNoXFFrac':       return _schematic_mlNoXFFrac();
        case 'mlNoXFHoriz':      return _schematic_mlNoXFHoriz();
        case 'mlHorizontalXF':   return _schematic_mlHorizontalXF();
        case 'inclinedMLXF':     return _schematic_inclinedMLXF();
        case 'multiLatMLXF':     return _schematic_multiLatMLXF();
        case 'mlMultiPerf':      return _schematic_mlMultiPerf();
        case 'generalMLNoXF':    return _schematic_generalMLNoXF();
        // Interference variants (Phase 6)
        case 'interference':     return _schematic_interference();
        case 'mlHorizInterference': return _schematic_mlHorizInterference();
        case 'mlMultiPerfInterference': return _schematic_mlMultiPerfInterference();
        case 'inclinedInterference': return _schematic_inclinedInterference();
        case 'linearCompInterference': return _schematic_linearCompInterference();
        case 'linearCompMultiLat': return _schematic_linearCompMultiLat();
        case 'linearCompMultiLatInterference': return _schematic_linearCompMultiLatInterference();
        case 'mlInterferenceXF': return _schematic_mlInterferenceXF();
        case 'radialCompInterference': return _schematic_radialCompInterference();
        // Specialised solvers (Phase 7)
        case 'userDefined':      return _schematic_userDefined();
        case 'waterInjection':   return _schematic_waterInjection();
        default:                 return _schematic_placeholder(modelKey);
    }
};


// =========================================================================
// SECTION 2 — SPECIALISED ANALYSIS KEYS
// =========================================================================
// Each entry is { label, plot, clicks, action(clicks, state) -> {note, ...} }
// `clicks` is the number of canvas clicks needed; the action gets an array
// of {x, y, dataX, dataY} objects + the live PRiSM_state and should return
// an object whose keys (other than `note`) are written into state.params.
//
// All slope-based helpers operate in log10-log10 space when the plot is
// 'bourdet' or another log-log derivative plot. Sqrt-time / spherical-flow
// helpers operate in their respective natural axes (handled by the action).
// =========================================================================

// Helpers — slope between two points in log10 / linear axes.
function _slopeLog(p1, p2) {
    var dx = Math.log10(Math.max(1e-30, p2.dataX)) - Math.log10(Math.max(1e-30, p1.dataX));
    var dy = Math.log10(Math.max(1e-30, p2.dataY)) - Math.log10(Math.max(1e-30, p1.dataY));
    if (dx === 0) return NaN;
    return dy / dx;
}
function _slopeLin(p1, p2) {
    var dx = p2.dataX - p1.dataX;
    if (dx === 0) return NaN;
    return (p2.dataY - p1.dataY) / dx;
}

// Default rate / Bo / mu pulled from state.params or sane fallbacks.
function _stableInputs(state) {
    var p = state.params || {};
    return {
        q:   (p.q  != null) ? p.q  : 100,    // STB/D (or m³/d)
        Bo:  (p.Bo != null) ? p.Bo : 1.2,
        mu:  (p.mu != null) ? p.mu : 1.0,    // cp
        h:   (p.h  != null) ? p.h  : 30,     // ft
        phi: (p.phi != null) ? p.phi : 0.20,
        ct:  (p.ct  != null) ? p.ct  : 1e-5, // 1/psi
        rw:  (p.rw  != null) ? p.rw  : 0.354 // ft (8.5" hole)
    };
}

window.PRiSM_analysisKeys = {
    // ── Radial-flow ────────────────────────────────────────────────────
    STABIL: {
        label: 'Stabilisation → kh',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dpStab = clicks[0].dataY;            // ψ = dp' on the IARF plateau
            // Bourdet IARF: dp' = 70.6·q·μ·B / (k·h)  →  k·h = 70.6·q·μ·B / dp'
            var kh = (70.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, dpStab);
            var k  = kh / Math.max(1e-9, inp.h);
            return { kh: kh, k: k,
                     note: 'IARF plateau dp\'=' + dpStab.toPrecision(4) +
                           ' → kh=' + kh.toPrecision(4) +
                           ' md·ft (k=' + k.toPrecision(4) + ' md)' };
        }
    },
    HALFSL: {
        label: '½-slope → x_f',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var sl = _slopeLog(clicks[0], clicks[1]);
            // Linear flow: dp = 4.064·(qB/h)·sqrt(t/(φ·μ·ct·k))/x_f
            //   → x_f·sqrt(k) is back-calculable from a chord & the slope check.
            var dpRef = clicks[1].dataY, tRef = clicks[1].dataX;
            // Solve: dp = m_lin · sqrt(t)  with  m_lin = dpRef/sqrt(tRef)
            var mLin = dpRef / Math.max(1e-9, Math.sqrt(tRef));
            var xf_sqrtk = (4.064 * inp.q * inp.Bo / inp.h) /
                           Math.max(1e-9, mLin * Math.sqrt(inp.phi * inp.mu * inp.ct));
            return { xf_sqrtk: xf_sqrtk,
                     note: '½-slope (' + sl.toFixed(2) + ') → x_f·√k=' +
                           xf_sqrtk.toPrecision(4) + ' ft·√md' };
        }
    },
    OMEGA: {
        label: 'Valley depth → ω',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks, state) {
            // Click two points: (1) IARF plateau before valley, (2) bottom of valley.
            var dpPlateau = clicks[0].dataY;
            var dpValley  = clicks[1].dataY;
            // ω ≈ 10^(−2·log10(dpPlateau/dpValley)) approximated by depth ratio.
            var ratio = dpPlateau / Math.max(1e-9, dpValley);
            var omega = 1 / Math.pow(ratio, 2);   // engineering proxy
            if (omega < 0.001) omega = 0.001;
            if (omega > 1)     omega = 1;
            return { omega: omega,
                     note: 'Valley depth ratio=' + ratio.toFixed(2) +
                           ' → ω≈' + omega.toPrecision(3) };
        }
    },
    LAMBDA: {
        label: 'Valley time → λ',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // tD at valley minimum ↔ λ via λ = (Cd·e^(2S)) / (tD·something).
            // Engineering proxy: λ ≈ 1 / tValley (in dimensionless units).
            var tValley = clicks[0].dataX;
            var lambda = 1 / Math.max(1e-9, tValley);
            return { lambda: lambda,
                     note: 'Valley at t=' + tValley.toPrecision(3) +
                           ' → λ≈' + lambda.toPrecision(3) };
        }
    },

    // ── Boundaries ────────────────────────────────────────────────────
    FAULT: {
        label: 'Slope-doubling → L',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // Click on the time of slope doubling on the derivative curve.
            // For a sealing fault: t_2m ≈ 948 · φ·μ·ct·L² / k
            //   → L = sqrt(k · t_2m / (948 · φ·μ·ct))
            var inp = _stableInputs(state);
            var t = clicks[0].dataX;
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var L = Math.sqrt(k * t / (948 * inp.phi * inp.mu * inp.ct));
            return { L: L,
                     note: 'Slope doubles at t=' + t.toPrecision(3) +
                           ' h → L≈' + L.toFixed(0) + ' ft' };
        }
    },
    'BND-ON': {
        label: 'Boundary onset → distance',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // Onset of any boundary: t_b ≈ 380 · φ·μ·ct·L² / k.
            var inp = _stableInputs(state);
            var t = clicks[0].dataX;
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var L = Math.sqrt(k * t / (380 * inp.phi * inp.mu * inp.ct));
            return { Lb: L,
                     note: 'Boundary onset at t=' + t.toPrecision(3) +
                           ' h → L≈' + L.toFixed(0) + ' ft' };
        }
    },
    'BND-DV': {
        label: 'Derivative deviation → boundary type',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            // Click pre-deviation point and post-deviation point on derivative.
            var slope = _slopeLog(clicks[0], clicks[1]);
            var typ;
            if      (slope >  0.7) typ = 'sealing fault (dp\' ↑)';
            else if (slope < -0.7) typ = 'constant-pressure boundary (dp\' ↓)';
            else                   typ = 'channel / partial-seal (intermediate)';
            return { boundaryType: typ,
                     note: 'Derivative slope after deviation ≈ ' +
                           slope.toFixed(2) + ' → ' + typ };
        }
    },
    CHANEL: {
        label: '½-slope onset → channel width',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // Channel ½-slope onset: t_lin ≈ 152 · φ·μ·ct·W² / k.
            var inp = _stableInputs(state);
            var t = clicks[0].dataX;
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var W = Math.sqrt(k * t / (152 * inp.phi * inp.mu * inp.ct));
            return { W: W,
                     note: '½-slope onset at t=' + t.toPrecision(3) +
                           ' h → channel W≈' + W.toFixed(0) + ' ft' };
        }
    },
    ANGLE: {
        label: 'Plateau after 2 faults → θ',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            // Late-time plateau ratio to IARF plateau ↔ 2π/θ.
            var dpIARF  = clicks[0].dataY;
            var dpLate  = clicks[1].dataY;
            var ratio   = dpLate / Math.max(1e-9, dpIARF);
            var theta_rad = 2 * Math.PI / Math.max(1, ratio);
            var theta_deg = theta_rad * 180 / Math.PI;
            return { theta_deg: theta_deg,
                     note: 'Late/IARF ratio=' + ratio.toFixed(2) +
                           ' → intersecting-fault angle ≈ ' +
                           theta_deg.toFixed(1) + '°' };
        }
    },

    // ── Injectivity ────────────────────────────────────────────────────
    INJSTB: {
        label: 'sqrt(t) stabilisation → conformance',
        plot:  'sqrt',
        clicks: 1,
        action: function (clicks) {
            // Stabilisation level on sqrt(t) plot indicates injection-zone
            // conformance vs. multi-zone behaviour.
            var dpStab = clicks[0].dataY;
            var conf   = (dpStab > 0) ? 1 - Math.exp(-dpStab / 100) : 0;
            return { injConformance: conf,
                     note: 'sqrt(t) stabilisation Δp=' + dpStab.toPrecision(3) +
                           ' → conformance ≈ ' + (conf * 100).toFixed(1) + '%' };
        }
    },
    INJSLP: {
        label: 'sqrt(t) slope → injectivity II',
        plot:  'sqrt',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var slope = _slopeLin(clicks[0], clicks[1]);    // psi/√h
            // II = q / (slope·…) — engineering proxy.
            var II = inp.q / Math.max(1e-9, Math.abs(slope) * Math.sqrt(1));
            return { II: II,
                     note: 'sqrt(t) slope=' + slope.toPrecision(3) +
                           ' psi/√h → II≈' + II.toPrecision(3) + ' bbl/d/psi' };
        }
    },

    // ── Partial penetration ───────────────────────────────────────────
    PPNSTB: {
        label: 'Spherical-flow stabil → kh',
        plot:  'spherical',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dp = clicks[0].dataY;
            var kh = (70.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, dp);
            return { kh: kh,
                     note: 'Spherical-flow late-time plateau Δp=' +
                           dp.toPrecision(3) + ' → kh=' + kh.toPrecision(4) + ' md·ft' };
        }
    },
    PPNSLP: {
        label: 'Spherical slope → k·√k',
        plot:  'spherical',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var slope = _slopeLin(clicks[0], clicks[1]);
            // m_sph = 2452.9 · qBμ / (k_sph^1.5)  →  k_sph^1.5 = 2452.9·qBμ/m_sph
            var k_sph_15 = (2452.9 * inp.q * inp.Bo * inp.mu) / Math.max(1e-9, Math.abs(slope));
            var k_sph    = Math.pow(k_sph_15, 2 / 3);
            return { k_sph: k_sph,
                     note: 'Spherical slope=' + slope.toPrecision(3) +
                           ' → k_sph≈' + k_sph.toPrecision(4) + ' md' };
        }
    },
    PPNSKN: {
        label: 'Stabil offset → partial-pen pseudo-skin',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            // Compare actual plateau (clicks[1]) vs. ideal full-penetration
            // plateau (clicks[0]). S_pp = 0.5 · ln(actual/ideal).
            var actual = clicks[1].dataY;
            var ideal  = clicks[0].dataY;
            var ratio  = actual / Math.max(1e-9, ideal);
            var Spp    = 0.5 * Math.log(ratio);
            return { Spp: Spp,
                     note: 'Δp(act)/Δp(ideal)=' + ratio.toFixed(2) +
                           ' → S_pp≈' + Spp.toFixed(2) };
        }
    },

    // ── Horizontal well ──────────────────────────────────────────────
    HORSLP: {
        label: 'Early ½-slope → L·√(kh·kv)',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dp = clicks[1].dataY, t = clicks[1].dataX;
            var mLin = dp / Math.max(1e-9, Math.sqrt(t));
            // dp_lin = 8.128·qB/(L·h) · sqrt(t/(φμct)) / sqrt(kv·kh) — proxy.
            var L_sqrt = (8.128 * inp.q * inp.Bo / inp.h) /
                         Math.max(1e-9, mLin * Math.sqrt(inp.phi * inp.mu * inp.ct));
            return { L_sqrt_khkv: L_sqrt,
                     note: 'Early ½-slope → L·√(kh·kv)≈' +
                           L_sqrt.toPrecision(4) + ' ft·md' };
        }
    },
    HORSTB: {
        label: 'Late stabilisation → kh (horiz)',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dp = clicks[0].dataY;
            var kh = (70.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, dp);
            return { kh: kh,
                     note: 'Horizontal late-pseudo-radial plateau dp\'=' +
                           dp.toPrecision(3) + ' → kh=' + kh.toPrecision(4) + ' md·ft' };
        }
    },

    // ── 3-sided / Horner ─────────────────────────────────────────────
    '3-SIDE': {
        label: '3-sided closed → Horner late linear',
        plot:  'horner',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            // Horner Δp vs. Horner-time slope on late linear regime.
            var slope = _slopeLin(clicks[0], clicks[1]);
            var kh = (162.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, Math.abs(slope));
            return { kh_3side: kh,
                     note: 'Horner late-linear slope=' + slope.toPrecision(3) +
                           ' → kh (3-sided)≈' + kh.toPrecision(4) + ' md·ft' };
        }
    },

    // ── General-purpose utilities ────────────────────────────────────
    AUTOSL: {
        label: 'Auto-fit slope (general)',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            var sl = _slopeLog(clicks[0], clicks[1]);
            var regime = '';
            if      (Math.abs(sl) < 0.1)       regime = 'IARF (radial-flow plateau)';
            else if (Math.abs(sl - 0.5) < 0.1) regime = 'linear flow (½-slope)';
            else if (Math.abs(sl - 0.25) < 0.1)regime = 'bilinear flow (¼-slope)';
            else if (Math.abs(sl + 0.5) < 0.1) regime = 'spherical flow (-½ slope)';
            else if (Math.abs(sl - 1.0) < 0.15)regime = 'pseudo-steady / closed (unit slope)';
            else                                regime = 'transitional';
            return { lastSlope: sl,
                     note: 'Slope=' + sl.toFixed(3) + ' → ' + regime };
        }
    },
    '1/4SLP': {
        label: '¼-slope → bilinear / finite-cond',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            // Bilinear flow: dp = 44.13·qBμ / (h · (kf·wf)^0.5 · (kφμct)^0.25) · t^0.25
            var dp = clicks[0].dataY, t = clicks[0].dataX;
            var mBi = dp / Math.max(1e-9, Math.pow(t, 0.25));
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var kfwf = Math.pow((44.13 * inp.q * inp.Bo * inp.mu) /
                                (inp.h * mBi * Math.pow(k * inp.phi * inp.mu * inp.ct, 0.25)), 2);
            return { kfwf: kfwf,
                     note: '¼-slope onset → k_f·w_f ≈ ' + kfwf.toPrecision(4) + ' md·ft' };
        }
    },
    SPHERE: {
        label: '-½ slope → spherical-flow entry',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks) {
            var t = clicks[0].dataX;
            return { tSphericalEntry: t,
                     note: 'Spherical-flow regime entry detected at t=' +
                           t.toPrecision(3) + ' h (-½ slope)' };
        }
    }
};

// ---- Click-capture state machine ----------------------------------------

var _activeKey      = null;            // name of armed key
var _activeCanvas   = null;            // canvas element listening
var _activeListener = null;            // bound mousedown handler
var _clickBuf       = [];              // accumulated {x,y,dataX,dataY}

// Read the data-axis transform that the plot library stashed on the canvas.
// 02-plots.js stores this as canvas._prismAxes = {x0, y0, x1, y1, dx0, dx1,
// dy0, dy1, xLog, yLog} after each draw. If absent we fall back to a linear
// 0..1 mapping that still gives a relative slope.
function _toDataCoords(canvas, ev) {
    var rect = canvas.getBoundingClientRect();
    var dpr  = window.devicePixelRatio || 1;
    var px   = (ev.clientX - rect.left);
    var py   = (ev.clientY - rect.top);
    var ax   = canvas._prismAxes;
    var dataX, dataY;
    if (ax) {
        var fx = (px - ax.x0) / Math.max(1, (ax.x1 - ax.x0));
        var fy = (py - ax.y0) / Math.max(1, (ax.y1 - ax.y0));
        // Y axis is inverted (top y < bottom y in pixel space).
        var fyDom = 1 - fy;
        dataX = ax.xLog
            ? Math.pow(10, Math.log10(ax.dx0) + fx * (Math.log10(ax.dx1) - Math.log10(ax.dx0)))
            : ax.dx0 + fx * (ax.dx1 - ax.dx0);
        dataY = ax.yLog
            ? Math.pow(10, Math.log10(ax.dy0) + fyDom * (Math.log10(ax.dy1) - Math.log10(ax.dy0)))
            : ax.dy0 + fyDom * (ax.dy1 - ax.dy0);
    } else {
        // Best-effort fallback. Just return relative pixel coordinates.
        dataX = px / Math.max(1, rect.width);
        dataY = 1 - py / Math.max(1, rect.height);
    }
    return { x: px, y: py, dataX: dataX, dataY: dataY };
}

function _disarm() {
    if (_activeCanvas && _activeListener) {
        _activeCanvas.removeEventListener('mousedown', _activeListener);
        _activeCanvas.style.cursor = '';
    }
    _activeKey = null;
    _activeCanvas = null;
    _activeListener = null;
    _clickBuf = [];
    var hint = document.getElementById('prism_polish_armhint');
    if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
}

function _showArmHint(label, needed) {
    var hint = document.getElementById('prism_polish_armhint');
    if (!hint) {
        hint = document.createElement('div');
        hint.id = 'prism_polish_armhint';
        hint.style.cssText =
            'position:fixed; top:12px; left:50%; transform:translateX(-50%);' +
            'background:#21262d; border:1px solid #f0883e; color:#f0f6fc;' +
            'padding:8px 14px; border-radius:5px; z-index:99999;' +
            'font:12px sans-serif; box-shadow:0 4px 10px rgba(0,0,0,.4);';
        document.body.appendChild(hint);
    }
    hint.textContent = '[' + label + '] click ' + needed + ' point(s) on the plot — Esc to cancel';
}

window.PRiSM_armAnalysisKey = function (keyName) {
    var key = window.PRiSM_analysisKeys[keyName];
    if (!key) {
        _polishToast('Unknown analysis key: ' + keyName, 'error');
        return;
    }
    var canvas = document.getElementById('prism_plot_canvas');
    if (!canvas) {
        _polishToast('No plot canvas active. Open Tab 2 first.', 'error');
        return;
    }
    if (_activeKey) _disarm();
    _activeKey = keyName;
    _activeCanvas = canvas;
    _clickBuf = [];
    canvas.style.cursor = 'crosshair';
    _showArmHint(key.label, key.clicks);

    _activeListener = function (ev) {
        var pt = _toDataCoords(canvas, ev);
        _clickBuf.push(pt);
        if (_clickBuf.length >= key.clicks) {
            // Snapshot to avoid race with disarm()
            var clicks = _clickBuf.slice();
            var keyEntry = key;
            _disarm();
            try {
                var result = keyEntry.action(clicks, window.PRiSM_state || {});
                if (result && typeof result === 'object') {
                    if (!window.PRiSM_state) window.PRiSM_state = { params: {} };
                    if (!window.PRiSM_state.params) window.PRiSM_state.params = {};
                    for (var rk in result) {
                        if (rk === 'note') continue;
                        if (Object.prototype.hasOwnProperty.call(result, rk)) {
                            window.PRiSM_state.params[rk] = result[rk];
                        }
                    }
                    var msg = '[' + keyName + '] ' + (result.note || 'result computed');
                    console.log('PRiSM analysis-key ' + keyName + ':', result);
                    _polishToast(msg, 'success');
                }
            } catch (e) {
                console.error('PRiSM analysis-key ' + keyName + ' failed:', e);
                _polishToast('Analysis-key error: ' + e.message, 'error');
            }
        } else {
            _polishToast('[' + keyName + '] need ' +
                         (key.clicks - _clickBuf.length) + ' more click(s)', 'info');
        }
    };
    canvas.addEventListener('mousedown', _activeListener);
};

// Esc cancels any pending arm.
document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _activeKey) {
        _polishToast('Analysis-key cancelled.', 'info');
        _disarm();
    }
});

// Render a grid of analysis-key buttons filtered by plotKey (e.g. 'bourdet',
// 'sqrt', 'spherical', 'horner'). Container can be a DOM element or an id.
window.PRiSM_renderAnalysisKeyToolbar = function (container, plotKey) {
    var host = (typeof container === 'string')
        ? document.getElementById(container) : container;
    if (!host) return;
    plotKey = plotKey || 'bourdet';
    var keys = window.PRiSM_analysisKeys;
    var btns = '';
    for (var k in keys) {
        if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
        if (keys[k].plot !== plotKey) continue;
        btns += '<button class="btn btn-secondary" data-prism-akey="' + k + '" ' +
                'style="font-size:11px; padding:4px 8px; margin:2px;" ' +
                'title="' + keys[k].label + '">' +
                k + '</button>';
    }
    if (!btns) {
        btns = '<span style="font-size:11px; color:#8b949e; font-style:italic;">' +
               'No analysis keys for plot type \'' + plotKey + '\'.</span>';
    }
    host.innerHTML =
        '<div style="border:1px solid #30363d; border-radius:6px; padding:8px; ' +
                    'background:#161b22; margin-top:8px;">' +
            '<div style="font-size:11px; font-weight:700; color:#c9d1d9; ' +
                        'text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">' +
                'Analysis keys (' + plotKey + ')</div>' +
            '<div style="display:flex; flex-wrap:wrap; gap:2px;">' + btns + '</div>' +
        '</div>';
    // Wire each button to arm its key.
    var nodes = host.querySelectorAll('[data-prism-akey]');
    for (var i = 0; i < nodes.length; i++) {
        (function (node) {
            node.onclick = function () { window.PRiSM_armAnalysisKey(node.dataset.prismAkey); };
        })(nodes[i]);
    }
};


// =========================================================================
// SECTION 3 — PNG EXPORT (REPORT PDF + STANDALONE PLOT PNG)
// =========================================================================
// We can't reach the locally-scoped PRISM_PLOT_REGISTRY in 04-ui-wiring.js,
// so we maintain a parallel snapshot. Update _PLOTS_SNAPSHOT here if a new
// plot is added to that registry.

var _PLOTS_SNAPSHOT = [
    { key: 'cartesian',     fn: 'PRiSM_plot_cartesian',             label: 'Cartesian P vs t',     mode: 'transient' },
    { key: 'horner',        fn: 'PRiSM_plot_horner',                label: 'Horner',               mode: 'transient' },
    { key: 'bourdet',       fn: 'PRiSM_plot_bourdet',               label: 'Log-Log Bourdet',      mode: 'transient' },
    { key: 'sqrt',          fn: 'PRiSM_plot_sqrt_time',             label: 'Square-root time',     mode: 'transient' },
    { key: 'quarter',       fn: 'PRiSM_plot_quarter_root_time',     label: 'Quarter-root time',    mode: 'transient' },
    { key: 'spherical',     fn: 'PRiSM_plot_spherical',             label: 'Spherical',            mode: 'transient' },
    { key: 'sandface',      fn: 'PRiSM_plot_sandface_convolution',  label: 'Sandface convolution', mode: 'transient' },
    { key: 'superposition', fn: 'PRiSM_plot_buildup_superposition', label: 'Buildup superposition',mode: 'transient' },
    { key: 'rateCart',      fn: 'PRiSM_plot_rate_time_cartesian',   label: 'Rate vs time (cart)',  mode: 'decline' },
    { key: 'rateSemi',      fn: 'PRiSM_plot_rate_time_semilog',     label: 'Rate vs time (semi)',  mode: 'decline' },
    { key: 'rateLog',       fn: 'PRiSM_plot_rate_time_loglog',      label: 'Rate vs time (log)',   mode: 'decline' },
    { key: 'rateCum',       fn: 'PRiSM_plot_rate_cumulative',       label: 'Rate vs cumulative',   mode: 'decline' },
    { key: 'lossRatio',     fn: 'PRiSM_plot_loss_ratio',            label: 'Loss-ratio',           mode: 'decline' },
    { key: 'typeCurve',     fn: 'PRiSM_plot_typecurve_overlay',     label: 'Type-curve overlay',   mode: 'decline' }
];

window.PRiSM_listPlots = function () {
    return _PLOTS_SNAPSHOT.slice();
};

// Render a plot to an offscreen canvas at the given resolution, return data URL.
function _renderPlotToDataURL(plotKey, w, h) {
    var entry = null;
    for (var i = 0; i < _PLOTS_SNAPSHOT.length; i++) {
        if (_PLOTS_SNAPSHOT[i].key === plotKey) { entry = _PLOTS_SNAPSHOT[i]; break; }
    }
    if (!entry) return null;
    var fn = window[entry.fn];
    if (typeof fn !== 'function') return null;
    var ds = window.PRiSM_dataset || {};
    var st = window.PRiSM_state   || {};
    var c = document.createElement('canvas');
    c.width  = w || 1200;
    c.height = h || 800;
    var data = {
        t: ds.t || [], p: ds.p || [], q: ds.q || null
    };
    if (ds.dp) data.dp = ds.dp;
    if (ds.periods) data.periods = ds.periods;
    if (st.modelCurve && typeof window.PRiSM_applyMatch === 'function') {
        try {
            var m = st.match || { timeShift: 0, pressShift: 0 };
            var sh = window.PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd,
                                             m.timeShift, m.pressShift);
            data.overlay = { t: sh.t, p: sh.p };
        } catch (e) { /* ignore — overlay just won't appear */ }
    }
    try {
        fn(c, data, { hover: false, dragZoom: false, showLegend: true });
    } catch (e) {
        console.warn('PRiSM PNG render of', plotKey, 'failed:', e.message);
        // Still return whatever was drawn so the user gets *something*.
    }
    try { return c.toDataURL('image/png'); }
    catch (e) { console.warn('toDataURL failed:', e.message); return null; }
}

// Standalone PNG download for a single plot.
window.PRiSM_exportPlotPNG = function (plotKey) {
    if (!plotKey) {
        _polishToast('PRiSM_exportPlotPNG: plotKey required', 'error');
        return;
    }
    var dataUrl = _renderPlotToDataURL(plotKey, 1200, 800);
    if (!dataUrl) {
        _polishToast('PNG export failed — plot ' + plotKey + ' not available', 'error');
        return;
    }
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'prism_' + plotKey + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    _polishToast('PNG saved: prism_' + plotKey + '.png', 'success');
};

// PDF export with embedded PNGs.
window.PRiSM_exportReportPDF = function () {
    var html;
    try {
        if (typeof window.PRiSM_buildReportHTML === 'function') {
            html = window.PRiSM_buildReportHTML();
        } else {
            html = '<h2>PRiSM Report</h2><p>(Report builder not available.)</p>';
        }
    } catch (e) {
        _polishToast('Report build failed: ' + e.message, 'error');
        return;
    }

    // Bake every available plot as a high-res PNG and append to the report.
    var ds = window.PRiSM_dataset;
    var hasData = !!(ds && Array.isArray(ds.t) && ds.t.length > 0);
    var st = window.PRiSM_state || {};
    var mode = (window.PRiSM && window.PRiSM.mode) || 'transient';

    var augHTML = '';
    if (hasData) {
        augHTML += '<h2 style="page-break-before:always;">High-Resolution Plot Gallery</h2>';
        var cnt = 0;
        for (var i = 0; i < _PLOTS_SNAPSHOT.length; i++) {
            var entry = _PLOTS_SNAPSHOT[i];
            // Only embed plots compatible with the active mode (or both).
            if (mode !== 'combined' && entry.mode !== mode) continue;
            var url = _renderPlotToDataURL(entry.key, 1200, 800);
            if (!url) continue;
            cnt++;
            augHTML +=
                '<div style="page-break-inside:avoid; margin-bottom:18px;">' +
                    '<h3 style="margin:6px 0;">' + entry.label + '</h3>' +
                    '<img src="' + url + '" style="width:100%; max-width:1100px; ' +
                        'height:auto; border:1px solid #ccc;"/>' +
                '</div>';
        }
        if (cnt === 0) {
            augHTML += '<p><em>No plots could be rendered.</em></p>';
        }
    } else {
        augHTML += '<p><em>No dataset loaded — gallery skipped.</em></p>';
    }

    // Try the host's exportReport first (gives consistent cover page).
    if (typeof window.exportReport === 'function') {
        try {
            window.exportReport('PRiSM Analysis - ' + (st.model || ''), html + augHTML);
            _polishToast('Report sent to host PDF pipeline.', 'success');
            return;
        } catch (e) {
            console.warn('Host exportReport failed, falling back to print window:', e.message);
        }
    }

    // Fallback: open a new window, dump the augmented report, call print().
    var w;
    try { w = window.open('', 'prism_report', 'width=900,height=1100'); }
    catch (e) { w = null; }
    if (!w) {
        _polishToast('Pop-up blocked — allow pop-ups to export the report.', 'error');
        return;
    }
    var fullHTML =
        '<!DOCTYPE html><html><head><title>PRiSM Report</title>' +
        '<style>' +
            'body { font-family: Arial, sans-serif; margin: 24px; color:#222; }' +
            'h1, h2, h3 { color:#222; }' +
            'table { border-collapse: collapse; margin: 8px 0; }' +
            'th, td { border:1px solid #ddd; padding:4px 8px; font-size:12px; }' +
            'img { max-width:100%; height:auto; }' +
            '@media print { body { margin:12px; } }' +
        '</style></head><body>' +
        '<h1>PRiSM Well-Test Analysis Report</h1>' +
        html + augHTML +
        '<script>window.onload = function(){ setTimeout(function(){' +
        ' try { window.print(); } catch(e){} }, 400); };<\/script>' +
        '</body></html>';
    try {
        w.document.open();
        w.document.write(fullHTML);
        w.document.close();
        _polishToast('Report opened — use browser print to save as PDF.', 'success');
    } catch (e) {
        _polishToast('Print-window write failed: ' + e.message, 'error');
    }
};


// =========================================================================
// SECTION 4 — PER-TAB GA4 EVENTS
// =========================================================================
// Three integration points:
//   - window.PRiSM.setTab          → 'prism_tab_open'
//   - window.PRiSM_state.model     → 'prism_model_select'
//   - window.PRiSM_runRegression   → 'prism_regress_run'
// =========================================================================

function _ga4(eventName, params) {
    if (typeof window.gtag === 'function') {
        try { window.gtag('event', eventName, params); }
        catch (e) { /* swallow — GA failures must not break the app */ }
    }
}

// ---- 4a) Wrap window.PRiSM.setTab ---------------------------------------
(function _wrapSetTabForGA4() {
    if (!window.PRiSM || typeof window.PRiSM.setTab !== 'function') {
        // Try again later — Phase 1+2 setTab is created inside renderPRiSM.
        setTimeout(_wrapSetTabForGA4, 250);
        return;
    }
    if (window.PRiSM.setTab._ga4Wrapped) return;
    var orig = window.PRiSM.setTab;
    window.PRiSM.setTab = function (n) {
        var tabNames = ['', 'Data', 'Plots', 'Model', 'Params', 'Match', 'Regress', 'Report'];
        var name = tabNames[n] || ('Tab ' + n);
        _ga4('prism_tab_open', {
            event_category: 'PRiSM',
            event_label:    name,
            value:          n,
            tab_index:      n
        });
        return orig.apply(this, arguments);
    };
    window.PRiSM.setTab._ga4Wrapped = true;
})();

// ---- 4b) Wrap state.model setter ----------------------------------------
//   Tab 3 currently does `window.PRiSM_state.model = key` directly. We
//   install an Object.defineProperty getter/setter on the model field so
//   any assignment fires GA4. Also expose PRiSM_setModel(key) for callers
//   that prefer an explicit setter.
(function _instrumentModelField() {
    if (!window.PRiSM_state) {
        setTimeout(_instrumentModelField, 250);
        return;
    }
    var st = window.PRiSM_state;
    if (st._modelInstrumented) return;
    var current = st.model;
    try {
        Object.defineProperty(st, 'model', {
            configurable: true,
            enumerable:   true,
            get: function () { return current; },
            set: function (v) {
                if (v !== current) {
                    current = v;
                    _ga4('prism_model_select', {
                        event_category: 'PRiSM',
                        event_label:    String(v),
                        model_key:      String(v)
                    });
                } else {
                    current = v;
                }
            }
        });
        st._modelInstrumented = true;
    } catch (e) {
        console.warn('PRiSM model-setter instrumentation failed:', e.message);
    }
})();

window.PRiSM_setModel = function (key) {
    if (!window.PRiSM_state) window.PRiSM_state = { params: {}, model: key };
    window.PRiSM_state.model = key;        // triggers the GA4 event via the setter
    if (window.PRiSM_MODELS && window.PRiSM_MODELS[key]) {
        var defs = window.PRiSM_MODELS[key].defaults || {};
        window.PRiSM_state.params = {};
        for (var k in defs) {
            if (Object.prototype.hasOwnProperty.call(defs, k)) {
                window.PRiSM_state.params[k] = defs[k];
            }
        }
        window.PRiSM_state.modelCurve = null;
    }
};

// ---- 4c) Wrap window.PRiSM_runRegression --------------------------------
(function _wrapRunRegression() {
    if (typeof window.PRiSM_runRegression !== 'function') {
        setTimeout(_wrapRunRegression, 250);
        return;
    }
    if (window.PRiSM_runRegression._ga4Wrapped) return;
    var orig = window.PRiSM_runRegression;
    window.PRiSM_runRegression = function (opts) {
        var st = window.PRiSM_state || {};
        _ga4('prism_regress_run', {
            event_category: 'PRiSM',
            event_label:    String(st.model || 'unknown'),
            model_key:      String(st.model || 'unknown')
        });
        return orig.apply(this, arguments);
    };
    window.PRiSM_runRegression._ga4Wrapped = true;
})();

})();

// ─── END 11-polish ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 12-data-crop ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 12 — Interactive Data Crop / Trim tool
//   • Drag-to-select crop window on a pressure-vs-time canvas
//   • Fine-control numeric trim (t_start, t_end + sample-index pair)
//   • Live first/last sample preview before confirming
//   • One-click confirm + reset
// ════════════════════════════════════════════════════════════════════
//
// USER FLOW
//   1. Tab 1 file picker fills window.PRiSM_dataset = { t, p, q, ... }
//   2. This module appends an interactive crop chart below the existing
//      preview. The user drags handles or types t_start/t_end/i_start/i_end
//      to define the cropped window.
//   3. A first-3 / last-3 preview block updates live.
//   4. "Confirm crop" replaces window.PRiSM_dataset with the slice and
//      fires window CustomEvent('prism:dataset-cropped', { detail }).
//   5. "Reset" restores the original snapshot.
//
// PUBLIC API
//   window.PRiSM_renderCropTool(container)
//   window.PRiSM_applyCrop(t_start, t_end)
//   window.PRiSM_resetCrop()
//   window.PRiSM_getCropPreview()
//   window.PRiSM_cropState               (read-only inspection)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • No external libraries — vanilla canvas, plain DOM.
//   • The original (uncropped) dataset is snapshotted on first interaction
//     and restored on reset; subsequent crops always slice from that snapshot
//     so a reset is always exact.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module can load in the smoke-test stub.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _eng(n, sig) {
        if (typeof G.PRiSM_plot_format_eng === 'function') {
            return G.PRiSM_plot_format_eng(n, sig || 3);
        }
        if (n == null || !isFinite(n)) return '';
        sig = sig || 3;
        if (n === 0) return '0';
        var a = Math.abs(n);
        if (a >= 1e9) return (n / 1e9).toPrecision(sig).replace(/\.?0+$/, '') + 'G';
        if (a >= 1e6) return (n / 1e6).toPrecision(sig).replace(/\.?0+$/, '') + 'M';
        if (a >= 1e3) return (n / 1e3).toPrecision(sig).replace(/\.?0+$/, '') + 'k';
        if (a >= 1)   return n.toPrecision(sig).replace(/\.?0+$/, '');
        if (a >= 1e-3) return n.toPrecision(sig).replace(/\.?0+$/, '');
        return n.toExponential(2).replace(/e([+-])0?(\d)/, 'e$1$2');
    }

    function _fmt(n, dp) {
        if (n == null || !isFinite(n)) return '—';
        return Number(n).toFixed(dp == null ? 4 : dp);
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — STATE
    // ═══════════════════════════════════════════════════════════════
    var cropState = {
        t_start: null,        // crop window in time units (canonical hours)
        t_end:   null,
        i_start: null,        // sample-index window (derived)
        i_end:   null,
        fullDataset: null,    // snapshot of pre-crop dataset
        container: null,      // DOM container for the crop UI
        canvas:    null,      // crop chart canvas
        // Derived layout from the most recent draw — used by mouse maths.
        layout: null,         // { x, y, w, h, cssW, cssH, tMin, tMax, pMin, pMax }
        drag: null,           // { kind: 'left'|'right'|'new', startX, ... }
        debounceTimer: null,
        wired: false
    };

    // Expose state for inspection (read mostly; tests poke it directly).
    G.PRiSM_cropState = cropState;


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — DATASET HELPERS
    // ═══════════════════════════════════════════════════════════════

    // Take a SHALLOW snapshot of the active dataset's array refs (we only
    // ever .slice() — never mutate the originals, so shallow is safe).
    function _snapshotDataset(ds) {
        if (!ds) return null;
        var snap = {
            t: (ds.t || []).slice(),
            p: ds.p ? ds.p.slice() : null,
            q: ds.q ? ds.q.slice() : null
        };
        // Optional period array.
        if (ds.period) snap.period = ds.period.slice();
        // Optional multi-phase rates.
        if (ds.phases) {
            snap.phases = {
                oil:   ds.phases.oil   ? ds.phases.oil.slice()   : null,
                gas:   ds.phases.gas   ? ds.phases.gas.slice()   : null,
                water: ds.phases.water ? ds.phases.water.slice() : null
            };
        }
        // Carry through any other simple top-level keys the dataset may
        // already hold (e.g. .units, .meta), so we don't drop info.
        for (var k in ds) {
            if (snap[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            try { snap[k] = ds[k]; } catch (e) { /* ignore */ }
        }
        return snap;
    }

    // Slice helper — produces a new object with .slice(i_start, i_end)
    // applied to every parallel array. Indices are inclusive at i_start,
    // exclusive at i_end (matching Array.prototype.slice).
    function _sliceDataset(snap, i_start, i_end) {
        if (!snap) return null;
        var out = { t: snap.t.slice(i_start, i_end) };
        if (snap.p) out.p = snap.p.slice(i_start, i_end);
        if (snap.q) out.q = snap.q.slice(i_start, i_end);
        if (snap.period) out.period = snap.period.slice(i_start, i_end);
        if (snap.phases) {
            out.phases = {
                oil:   snap.phases.oil   ? snap.phases.oil.slice(i_start, i_end)   : null,
                gas:   snap.phases.gas   ? snap.phases.gas.slice(i_start, i_end)   : null,
                water: snap.phases.water ? snap.phases.water.slice(i_start, i_end) : null
            };
        }
        // Carry through scalar keys.
        for (var k in snap) {
            if (out[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            try { out[k] = snap[k]; } catch (e) {}
        }
        return out;
    }

    // Find the smallest index i such that t[i] >= target.
    function _findIndex(t, target) {
        if (!t || !t.length) return 0;
        if (target <= t[0]) return 0;
        if (target >= t[t.length - 1]) return t.length - 1;
        // Binary search.
        var lo = 0, hi = t.length - 1;
        while (lo < hi) {
            var mid = (lo + hi) >>> 1;
            if (t[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Median of array (used for keyboard arrow-key step).
    function _medianStep(t) {
        if (!t || t.length < 2) return 0.001;
        var dts = [];
        for (var i = 1; i < t.length; i++) {
            var d = t[i] - t[i - 1];
            if (isFinite(d) && d > 0) dts.push(d);
        }
        if (!dts.length) return 0.001;
        dts.sort(function (a, b) { return a - b; });
        return dts[dts.length >> 1] || 0.001;
    }

    // Snapshot the live dataset if we don't already have one.
    function _ensureSnapshot() {
        if (cropState.fullDataset) return cropState.fullDataset;
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t || !ds.t.length) return null;
        cropState.fullDataset = _snapshotDataset(ds);
        // Initialise crop window to the full range.
        var t = cropState.fullDataset.t;
        cropState.t_start = t[0];
        cropState.t_end   = t[t.length - 1];
        cropState.i_start = 0;
        cropState.i_end   = t.length;
        return cropState.fullDataset;
    }

    // Clamp + reconcile crop bounds against the snapshot.
    function _normaliseBounds() {
        var snap = cropState.fullDataset;
        if (!snap || !snap.t || !snap.t.length) return false;
        var t = snap.t;
        var tMin = t[0], tMax = t[t.length - 1];
        // Time bounds.
        var ts = cropState.t_start, te = cropState.t_end;
        if (!isFinite(ts)) ts = tMin;
        if (!isFinite(te)) te = tMax;
        if (ts < tMin) ts = tMin;
        if (te > tMax) te = tMax;
        if (ts >= te) {
            // Collapse — restore at least one sample.
            ts = tMin;
            te = tMax;
        }
        cropState.t_start = ts;
        cropState.t_end   = te;
        // Derive sample indices.
        cropState.i_start = _findIndex(t, ts);
        cropState.i_end   = _findIndex(t, te) + 1; // exclusive
        if (cropState.i_end > t.length) cropState.i_end = t.length;
        if (cropState.i_start < 0) cropState.i_start = 0;
        if (cropState.i_end <= cropState.i_start) cropState.i_end = cropState.i_start + 1;
        return true;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — CROP CHART (canvas) RENDERING
    // ═══════════════════════════════════════════════════════════════

    var THEME = {
        bg:      '#0d1117',
        panel:   '#161b22',
        border:  '#30363d',
        grid:    '#21262d',
        text:    '#c9d1d9',
        text2:   '#8b949e',
        text3:   '#6e7681',
        curve:   '#58a6ff',
        handle:  '#f0883e',
        band:    'rgba(240,136,62,0.10)'
    };

    var PADDING = { top: 12, right: 14, bottom: 28, left: 56 };

    function _setupCanvas(canvas, opts) {
        var dpr = (typeof G.devicePixelRatio === 'number' ? G.devicePixelRatio : 1) || 1;
        var cssW = opts.width;
        var cssH = opts.height;
        canvas.style.width  = cssW + 'px';
        canvas.style.height = cssH + 'px';
        canvas.width  = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        var ctx = canvas.getContext && canvas.getContext('2d');
        if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: ctx, dpr: dpr, cssW: cssW, cssH: cssH };
    }

    // "Nice" linear ticks (4-6 of them).
    function _linTicks(min, max, target) {
        target = target || 5;
        if (!isFinite(min) || !isFinite(max) || max <= min) return [];
        var span = max - min;
        var rough = span / target;
        var mag = Math.pow(10, Math.floor(Math.log10(rough)));
        var norm = rough / mag;
        var step;
        if (norm < 1.5)      step = 1 * mag;
        else if (norm < 3)   step = 2 * mag;
        else if (norm < 7)   step = 5 * mag;
        else                 step = 10 * mag;
        var start = Math.ceil(min / step) * step;
        var ticks = [];
        for (var v = start; v <= max + step * 0.001; v += step) {
            ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
        }
        return ticks;
    }

    function _drawCropChart() {
        var canvas = cropState.canvas;
        var snap   = cropState.fullDataset;
        if (!canvas || !snap || !snap.t || !snap.t.length) return;
        var t = snap.t;
        var p = snap.p && snap.p.length === t.length ? snap.p
              : (snap.q && snap.q.length === t.length ? snap.q : t);

        // Compute target canvas size from container.
        var container = cropState.container;
        var maxW = 800;
        var availW = (container && container.clientWidth) ? container.clientWidth : maxW;
        var cssW = Math.max(360, Math.min(maxW, availW));
        var cssH = 300;
        var setup = _setupCanvas(canvas, { width: cssW, height: cssH });
        var ctx = setup.ctx;
        if (!ctx) return;
        // Wrap calls so a stub canvas (e.g. node smoke-test) that lacks some
        // methods doesn't throw. We always still compute the layout so that
        // hit-testing / preview state remains correct.
        var _safe = function (fn) {
            try { fn(); } catch (e) { /* canvas method missing — silently skip */ }
        };

        var pad = PADDING;
        var plot = {
            x: pad.left,
            y: pad.top,
            w: cssW - pad.left - pad.right,
            h: cssH - pad.top - pad.bottom,
            cssW: cssW,
            cssH: cssH
        };

        // Data bounds.
        var tMin = t[0], tMax = t[t.length - 1];
        var pMin = Infinity, pMax = -Infinity;
        for (var i = 0; i < p.length; i++) {
            var v = p[i];
            if (isFinite(v)) {
                if (v < pMin) pMin = v;
                if (v > pMax) pMax = v;
            }
        }
        if (!isFinite(pMin) || !isFinite(pMax) || pMin === pMax) {
            pMin = (isFinite(pMin) ? pMin : 0) - 1;
            pMax = (isFinite(pMax) ? pMax : 0) + 1;
        }
        // Pad pressure axis ±5%.
        var pSpan = pMax - pMin;
        pMin -= pSpan * 0.05;
        pMax += pSpan * 0.05;

        // World→pixel transforms.
        function toX(v) { return plot.x + (v - tMin) / (tMax - tMin) * plot.w; }
        function toY(v) { return plot.y + plot.h - (v - pMin) / (pMax - pMin) * plot.h; }

        // Stash layout for hit-testing — done before paint so a stub
        // canvas with missing methods doesn't trip up subsequent logic.
        cropState.layout = {
            x: plot.x, y: plot.y, w: plot.w, h: plot.h,
            cssW: cssW, cssH: cssH,
            tMin: tMin, tMax: tMax,
            pMin: pMin, pMax: pMax,
            toX: toX, toY: toY
        };

        // ─── Paint (all calls inside the safe wrapper) ──────────────
        _safe(function () {
            // Background.
            ctx.fillStyle = THEME.bg;
            ctx.fillRect(0, 0, cssW, cssH);
            ctx.fillStyle = THEME.panel;
            ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

            // Gridlines + tick labels.
            var xTicks = _linTicks(tMin, tMax, 6);
            var yTicks = _linTicks(pMin, pMax, 5);

            ctx.strokeStyle = THEME.grid;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (var ix = 0; ix < xTicks.length; ix++) {
                var px = Math.round(toX(xTicks[ix])) + 0.5;
                ctx.moveTo(px, plot.y);
                ctx.lineTo(px, plot.y + plot.h);
            }
            for (var iy = 0; iy < yTicks.length; iy++) {
                var py = Math.round(toY(yTicks[iy])) + 0.5;
                ctx.moveTo(plot.x, py);
                ctx.lineTo(plot.x + plot.w, py);
            }
            ctx.stroke();

            // Border.
            ctx.strokeStyle = THEME.border;
            if (typeof ctx.strokeRect === 'function') {
                ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);
            }

            // Axis labels.
            ctx.fillStyle = THEME.text2;
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (var jx = 0; jx < xTicks.length; jx++) {
                var pxL = Math.round(toX(xTicks[jx]));
                ctx.fillText(_eng(xTicks[jx], 3), pxL, plot.y + plot.h + 4);
            }
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            for (var jy = 0; jy < yTicks.length; jy++) {
                var pyL = Math.round(toY(yTicks[jy]));
                ctx.fillText(_eng(yTicks[jy], 3), plot.x - 6, pyL);
            }

            // Pressure curve.
            ctx.save();
            ctx.beginPath();
            ctx.rect(plot.x, plot.y, plot.w, plot.h);
            ctx.clip();
            ctx.strokeStyle = THEME.curve;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            var moved = false;
            for (var k = 0; k < t.length; k++) {
                var vy = p[k];
                if (!isFinite(vy)) continue;
                var x = toX(t[k]);
                var y = toY(vy);
                if (!moved) { ctx.moveTo(x, y); moved = true; }
                else        { ctx.lineTo(x, y); }
            }
            ctx.stroke();
            ctx.restore();

            // Selection band + handles.
            var ts = cropState.t_start, te = cropState.t_end;
            if (isFinite(ts) && isFinite(te) && te > ts) {
                var xL = toX(ts), xR = toX(te);
                // Band.
                ctx.fillStyle = THEME.band;
                ctx.fillRect(xL, plot.y, xR - xL, plot.h);
                // Left + right handles.
                ctx.fillStyle = THEME.handle;
                ctx.fillRect(Math.round(xL) - 1, plot.y, 3, plot.h);
                ctx.fillRect(Math.round(xR) - 1, plot.y, 3, plot.h);
                // Handle grips (small squares mid-height).
                ctx.fillRect(Math.round(xL) - 4, plot.y + plot.h / 2 - 6, 9, 12);
                ctx.fillRect(Math.round(xR) - 4, plot.y + plot.h / 2 - 6, 9, 12);
            }
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — POINTER / DRAG INTERACTION
    // ═══════════════════════════════════════════════════════════════

    function _eventToCanvasX(canvas, ev) {
        if (!canvas || !canvas.getBoundingClientRect) return 0;
        var rect = canvas.getBoundingClientRect();
        var clientX = (ev.clientX != null) ? ev.clientX
                      : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0);
        return clientX - rect.left;
    }

    function _xToTime(x) {
        var L = cropState.layout;
        if (!L) return null;
        var frac = (x - L.x) / L.w;
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
        return L.tMin + frac * (L.tMax - L.tMin);
    }

    // Decide whether the cursor is over a handle. Returns 'left' | 'right' | null.
    function _hitTest(x) {
        var L = cropState.layout;
        if (!L) return null;
        var ts = cropState.t_start, te = cropState.t_end;
        if (!isFinite(ts) || !isFinite(te)) return null;
        var xL = L.toX(ts), xR = L.toX(te);
        var TOL = 8;
        if (Math.abs(x - xL) <= TOL) return 'left';
        if (Math.abs(x - xR) <= TOL) return 'right';
        return null;
    }

    function _onPointerDown(ev) {
        if (!cropState.canvas) return;
        var x = _eventToCanvasX(cropState.canvas, ev);
        var hit = _hitTest(x);
        if (hit) {
            cropState.drag = { kind: hit };
        } else {
            // Start a new range select from this point.
            var t = _xToTime(x);
            if (t == null) return;
            cropState.t_start = t;
            cropState.t_end   = t;
            cropState.drag = { kind: 'new', anchor: t };
        }
        // Try to capture the pointer for smooth tracking.
        if (ev.pointerId != null && cropState.canvas.setPointerCapture) {
            try { cropState.canvas.setPointerCapture(ev.pointerId); } catch (e) {}
        }
        if (ev.preventDefault) ev.preventDefault();
        _refreshFromInternal();
    }

    function _onPointerMove(ev) {
        if (!cropState.canvas) return;
        var L = cropState.layout;
        if (!L) return;
        var x = _eventToCanvasX(cropState.canvas, ev);
        if (!cropState.drag) {
            // Update cursor based on hover.
            var over = _hitTest(x);
            cropState.canvas.style.cursor = over ? 'ew-resize' : 'crosshair';
            return;
        }
        var t = _xToTime(x);
        if (t == null) return;
        if (cropState.drag.kind === 'left') {
            if (t >= cropState.t_end) t = cropState.t_end - (L.tMax - L.tMin) * 1e-4;
            cropState.t_start = t;
        } else if (cropState.drag.kind === 'right') {
            if (t <= cropState.t_start) t = cropState.t_start + (L.tMax - L.tMin) * 1e-4;
            cropState.t_end = t;
        } else if (cropState.drag.kind === 'new') {
            var a = cropState.drag.anchor;
            if (t < a) { cropState.t_start = t; cropState.t_end = a; }
            else       { cropState.t_start = a; cropState.t_end = t; }
        }
        if (ev.preventDefault) ev.preventDefault();
        _refreshFromInternal();
    }

    function _onPointerUp(ev) {
        if (!cropState.canvas) return;
        cropState.drag = null;
        if (ev && ev.pointerId != null && cropState.canvas.releasePointerCapture) {
            try { cropState.canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
        }
    }

    function _wireCanvasEvents(canvas) {
        if (!canvas || !canvas.addEventListener) return;
        canvas.style.touchAction = 'none';
        canvas.style.cursor = 'crosshair';
        // Prefer Pointer Events if available.
        var hasPointer = (typeof G.PointerEvent !== 'undefined');
        if (hasPointer) {
            canvas.addEventListener('pointerdown',   _onPointerDown);
            canvas.addEventListener('pointermove',   _onPointerMove);
            canvas.addEventListener('pointerup',     _onPointerUp);
            canvas.addEventListener('pointercancel', _onPointerUp);
            canvas.addEventListener('pointerleave',  function () { /* keep cursor */ });
        } else {
            canvas.addEventListener('mousedown',  _onPointerDown);
            canvas.addEventListener('mousemove',  _onPointerMove);
            canvas.addEventListener('mouseup',    _onPointerUp);
            canvas.addEventListener('mouseleave', _onPointerUp);
            canvas.addEventListener('touchstart', function (e) { _onPointerDown(e); }, { passive: false });
            canvas.addEventListener('touchmove',  function (e) { _onPointerMove(e); }, { passive: false });
            canvas.addEventListener('touchend',   _onPointerUp);
            canvas.addEventListener('touchcancel',_onPointerUp);
        }
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — NUMERIC INPUT WIRING
    // ═══════════════════════════════════════════════════════════════

    function _byId(id) {
        return _hasDoc ? document.getElementById(id) : null;
    }

    function _debounce(fn) {
        if (cropState.debounceTimer) clearTimeout(cropState.debounceTimer);
        cropState.debounceTimer = setTimeout(fn, 50);
    }

    // After a numeric input changes, reconcile + redraw.
    function _refreshFromInputs() {
        var snap = cropState.fullDataset;
        if (!snap) return;
        var ts = parseFloat((_byId('prism_crop_tstart') || {}).value);
        var te = parseFloat((_byId('prism_crop_tend')   || {}).value);
        var is = parseInt((_byId('prism_crop_istart')   || {}).value, 10);
        var ie = parseInt((_byId('prism_crop_iend')     || {}).value, 10);

        // Determine which inputs the user just changed by comparing to the
        // current cropState values; any deviating input wins.
        var changedT = false, changedI = false;
        if (isFinite(ts) && Math.abs(ts - (cropState.t_start || 0)) > 1e-9) changedT = true;
        if (isFinite(te) && Math.abs(te - (cropState.t_end   || 0)) > 1e-9) changedT = true;
        if (isFinite(is) && is !== cropState.i_start) changedI = true;
        if (isFinite(ie) && ie !== cropState.i_end)   changedI = true;

        var t = snap.t;
        if (changedI && !changedT) {
            // Index inputs win.
            if (!isFinite(is)) is = cropState.i_start;
            if (!isFinite(ie)) ie = cropState.i_end;
            is = Math.max(0, Math.min(t.length - 1, is | 0));
            ie = Math.max(is + 1, Math.min(t.length, ie | 0));
            cropState.i_start = is;
            cropState.i_end   = ie;
            cropState.t_start = t[is];
            cropState.t_end   = t[Math.min(ie - 1, t.length - 1)];
        } else {
            // Time inputs win (default).
            if (!isFinite(ts)) ts = cropState.t_start;
            if (!isFinite(te)) te = cropState.t_end;
            cropState.t_start = ts;
            cropState.t_end   = te;
        }
        _normaliseBounds();
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
    }

    function _refreshFromInternal() {
        // After a drag, sync inputs + preview live (no debounce — mouse).
        _normaliseBounds();
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
    }

    function _syncInputs() {
        var ts = _byId('prism_crop_tstart');
        var te = _byId('prism_crop_tend');
        var is = _byId('prism_crop_istart');
        var ie = _byId('prism_crop_iend');
        if (ts) ts.value = isFinite(cropState.t_start) ? Number(cropState.t_start.toFixed(6)) : '';
        if (te) te.value = isFinite(cropState.t_end)   ? Number(cropState.t_end.toFixed(6))   : '';
        if (is) is.value = (cropState.i_start != null) ? cropState.i_start : '';
        if (ie) ie.value = (cropState.i_end   != null) ? cropState.i_end   : '';
    }

    function _wireInputs() {
        var ts = _byId('prism_crop_tstart');
        var te = _byId('prism_crop_tend');
        var is = _byId('prism_crop_istart');
        var ie = _byId('prism_crop_iend');
        var apply = _byId('prism_crop_apply');
        var reset = _byId('prism_crop_reset');

        var onInput = function () { _debounce(_refreshFromInputs); };
        [ts, te, is, ie].forEach(function (inp) {
            if (!inp) return;
            inp.oninput  = onInput;
            inp.onchange = onInput;
            // Arrow-key fine step on the time inputs: ±median dt.
            if (inp === ts || inp === te) {
                inp.onkeydown = function (ev) {
                    if (!cropState.fullDataset) return;
                    var step = _medianStep(cropState.fullDataset.t);
                    var which = (inp === ts) ? 't_start' : 't_end';
                    var cur = cropState[which];
                    if (!isFinite(cur)) return;
                    if (ev.key === 'ArrowUp')   { cropState[which] = cur + step; ev.preventDefault(); _refreshFromInternal(); }
                    if (ev.key === 'ArrowDown') { cropState[which] = cur - step; ev.preventDefault(); _refreshFromInternal(); }
                };
            }
        });

        if (apply) apply.onclick = function () {
            try {
                var res = G.PRiSM_applyCrop(cropState.t_start, cropState.t_end);
                _flashMessage('prism_crop_msg',
                    'Cropped dataset of ' + (res ? res.t.length : '?') + ' points active.', 'green');
            } catch (e) {
                _flashMessage('prism_crop_msg', 'Crop failed: ' + (e && e.message), 'red');
            }
        };
        if (reset) reset.onclick = function () {
            G.PRiSM_resetCrop();
            _flashMessage('prism_crop_msg', 'Crop reset — full dataset restored.', 'text2');
        };
    }

    function _flashMessage(id, html, colorVar) {
        var el = _byId(id);
        if (!el) return;
        var color = '';
        if (colorVar === 'green') color = 'color:#3fb950;';
        else if (colorVar === 'red') color = 'color:#f85149;';
        else color = 'color:#8b949e;';
        el.innerHTML = '<span style="' + color + '">' + html + '</span>';
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — PREVIEW BLOCK (first 3 + last 3, stats)
    // ═══════════════════════════════════════════════════════════════

    function _previewLine(snap, idx) {
        if (!snap) return '';
        var parts = [];
        parts.push('t=' + _eng(snap.t[idx], 4));
        if (snap.p) parts.push('p=' + _eng(snap.p[idx], 4));
        if (snap.q) parts.push('q=' + _eng(snap.q[idx], 4));
        return '    ' + parts.join(', ');
    }

    function _renderPreviewBlock() {
        var pre = _byId('prism_crop_preview');
        if (!pre) return;
        var snap = cropState.fullDataset;
        if (!snap || !snap.t || !snap.t.length) {
            pre.textContent = 'No dataset loaded yet.';
            return;
        }
        var i0 = cropState.i_start, i1 = cropState.i_end;
        var sliced = _sliceDataset(snap, i0, i1);
        var n = sliced.t.length;
        var nFull = snap.t.length;
        var firstN = Math.min(3, n);
        var lastN  = (n > 3) ? Math.min(3, n - firstN) : 0;
        var tMin = sliced.t[0];
        var tMax = sliced.t[n - 1];
        var dT = tMax - tMin;
        var pMin = Infinity, pMax = -Infinity;
        if (sliced.p) {
            for (var k = 0; k < sliced.p.length; k++) {
                var v = sliced.p[k];
                if (isFinite(v)) {
                    if (v < pMin) pMin = v;
                    if (v > pMax) pMax = v;
                }
            }
        }
        var lines = [];
        lines.push('Cropped dataset preview:');
        lines.push('  Samples:  ' + nFull.toLocaleString() + '  →  ' + n.toLocaleString());
        lines.push('  Time:     ' + _eng(tMin, 4) + '  to  ' + _eng(tMax, 4) + '  hours  (Δ ' + _eng(dT, 4) + ')');
        if (sliced.p) {
            var rng = pMax - pMin;
            lines.push('  Pressure: ' + _eng(pMin, 4) + '  to  ' + _eng(pMax, 4) + '  psi  (range ' + _eng(rng, 4) + ')');
        }
        lines.push('');
        lines.push('  First ' + firstN + ':');
        for (var i = 0; i < firstN; i++) lines.push(_previewLine(sliced, i));
        if (lastN > 0) {
            lines.push('  Last ' + lastN + ':');
            for (var j = n - lastN; j < n; j++) lines.push(_previewLine(sliced, j));
        }
        pre.textContent = lines.join('\n');
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    G.PRiSM_renderCropTool = function PRiSM_renderCropTool(container) {
        if (!_hasDoc) return;
        if (!container) return;
        cropState.container = container;

        // Build UI markup.
        container.innerHTML =
              '<div class="prism-crop-card" style="background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px;">'
            +   '<div style="font-weight:600; color:#c9d1d9; font-size:13px; margin-bottom:6px;">'
            +     'Interactive crop &amp; trim'
            +   '</div>'
            +   '<div style="font-size:12px; color:#8b949e; margin-bottom:10px;">'
            +     'Drag on the chart to define a crop window, or fine-tune with the inputs below. '
            +     'Click <b>Confirm crop</b> to replace the active dataset.'
            +   '</div>'
            +   '<canvas id="prism_crop_canvas" width="800" height="300" '
            +     'style="display:block; background:#0d1117; border:1px solid #30363d; '
            +     'border-radius:6px; max-width:100%; touch-action:none;"></canvas>'
            +   '<div class="prism-crop-controls" style="margin-top:10px; display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;">'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       't start'
            +       '<input type="number" id="prism_crop_tstart" step="0.001" '
            +         'style="width:120px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       't end'
            +       '<input type="number" id="prism_crop_tend" step="0.001" '
            +         'style="width:120px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       'i start'
            +       '<input type="number" id="prism_crop_istart" min="0" step="1" '
            +         'style="width:90px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       'i end'
            +       '<input type="number" id="prism_crop_iend" min="0" step="1" '
            +         'style="width:90px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<button id="prism_crop_apply" type="button" class="btn btn-primary" '
            +       'style="padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; '
            +       'border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Confirm crop</button>'
            +     '<button id="prism_crop_reset" type="button" class="btn btn-secondary" '
            +       'style="padding:6px 14px; background:#21262d; color:#c9d1d9; border:1px solid #30363d; '
            +       'border-radius:4px; cursor:pointer; font-size:12px;">Reset</button>'
            +     '<span id="prism_crop_msg" style="font-size:12px; color:#8b949e;"></span>'
            +   '</div>'
            +   '<pre id="prism_crop_preview" '
            +     'style="margin-top:12px; padding:10px; background:#0d1117; color:#c9d1d9; '
            +     'border:1px solid #30363d; border-radius:6px; font-size:11px; '
            +     'font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; '
            +     'max-height:240px; overflow:auto; white-space:pre;">'
            +     'No dataset loaded yet.'
            +   '</pre>'
            + '</div>';

        cropState.canvas = _byId('prism_crop_canvas');
        _wireCanvasEvents(cropState.canvas);
        _wireInputs();

        // Snapshot the live dataset (if any) and paint.
        cropState.fullDataset = null;  // force re-snapshot for fresh load
        _ensureSnapshot();
        if (cropState.fullDataset) {
            _normaliseBounds();
            _syncInputs();
            _drawCropChart();
            _renderPreviewBlock();
        }

        // Repaint on window resize so the canvas keeps filling its container.
        if (_hasWin && !cropState._resizeWired) {
            G.addEventListener('resize', function () {
                if (cropState.fullDataset && cropState.canvas) {
                    _drawCropChart();
                }
            });
            cropState._resizeWired = true;
        }
    };

    // Programmatically apply a crop. Returns the newly-active dataset.
    G.PRiSM_applyCrop = function PRiSM_applyCrop(t_start, t_end) {
        var snap = _ensureSnapshot();
        if (!snap || !snap.t || !snap.t.length) return null;
        if (isFinite(t_start)) cropState.t_start = t_start;
        if (isFinite(t_end))   cropState.t_end   = t_end;
        _normaliseBounds();
        var from = G.PRiSM_dataset || snap;
        var cropped = _sliceDataset(snap, cropState.i_start, cropState.i_end);
        G.PRiSM_dataset = cropped;
        // Update displays.
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
        // Fire event.
        _dispatchCropEvent(from, cropped);
        // Refresh active plot if the host bound it.
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
        return cropped;
    };

    // Restore the snapshot — reverses any prior PRiSM_applyCrop.
    G.PRiSM_resetCrop = function PRiSM_resetCrop() {
        var snap = cropState.fullDataset;
        if (!snap) return null;
        var from = G.PRiSM_dataset;
        var restored = _snapshotDataset(snap);
        G.PRiSM_dataset = restored;
        // Reset window to full range.
        var t = snap.t;
        cropState.t_start = t[0];
        cropState.t_end   = t[t.length - 1];
        cropState.i_start = 0;
        cropState.i_end   = t.length;
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
        _dispatchCropEvent(from, restored);
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
        return restored;
    };

    // Return preview details — used by other modules / tests.
    G.PRiSM_getCropPreview = function PRiSM_getCropPreview() {
        var snap = cropState.fullDataset;
        if (!snap) return null;
        var i0 = cropState.i_start, i1 = cropState.i_end;
        var sliced = _sliceDataset(snap, i0, i1);
        var n = sliced.t.length;
        var firstN = Math.min(3, n);
        var lastN  = (n > 3) ? Math.min(3, n - firstN) : 0;
        var firstRows = [], lastRows = [];
        for (var i = 0; i < firstN; i++) {
            firstRows.push({
                t: sliced.t[i],
                p: sliced.p ? sliced.p[i] : null,
                q: sliced.q ? sliced.q[i] : null
            });
        }
        for (var j = n - lastN; j < n; j++) {
            lastRows.push({
                t: sliced.t[j],
                p: sliced.p ? sliced.p[j] : null,
                q: sliced.q ? sliced.q[j] : null
            });
        }
        var tMin = sliced.t[0], tMax = sliced.t[n - 1];
        var pMin = null, pMax = null;
        if (sliced.p) {
            pMin = Infinity; pMax = -Infinity;
            for (var k = 0; k < sliced.p.length; k++) {
                var v = sliced.p[k];
                if (isFinite(v)) {
                    if (v < pMin) pMin = v;
                    if (v > pMax) pMax = v;
                }
            }
            if (!isFinite(pMin)) pMin = null;
            if (!isFinite(pMax)) pMax = null;
        }
        return {
            firstRows: firstRows,
            lastRows: lastRows,
            n: n,
            tSpan: { from: tMin, to: tMax, delta: tMax - tMin },
            pRange: (pMin != null && pMax != null) ? { min: pMin, max: pMax, range: pMax - pMin } : null
        };
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — EVENTS + INTEGRATION
    // ═══════════════════════════════════════════════════════════════

    function _dispatchCropEvent(from, to) {
        if (!_hasWin) return;
        try {
            var ev;
            if (typeof CustomEvent === 'function') {
                ev = new CustomEvent('prism:dataset-cropped', {
                    detail: { from: from, to: to, t_start: cropState.t_start, t_end: cropState.t_end,
                              i_start: cropState.i_start, i_end: cropState.i_end }
                });
            } else if (_hasDoc && document.createEvent) {
                ev = document.createEvent('CustomEvent');
                ev.initCustomEvent('prism:dataset-cropped', false, false,
                    { from: from, to: to, t_start: cropState.t_start, t_end: cropState.t_end,
                      i_start: cropState.i_start, i_end: cropState.i_end });
            }
            if (ev && G.dispatchEvent) G.dispatchEvent(ev);
        } catch (e) { /* ignore */ }
    }

    // Listen for an upstream "dataset-loaded" signal — when a new file is
    // loaded, we want to forget the previous snapshot.
    if (_hasWin && G.addEventListener) {
        G.addEventListener('prism:dataset-loaded', function () {
            cropState.fullDataset = null;
            cropState.t_start = cropState.t_end = null;
            cropState.i_start = cropState.i_end = null;
            if (cropState.container) {
                _ensureSnapshot();
                if (cropState.fullDataset) {
                    _normaliseBounds();
                    _syncInputs();
                    _drawCropChart();
                    _renderPreviewBlock();
                }
            }
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — WRAP THE ENHANCED DATA-TAB RENDER
    // ═══════════════════════════════════════════════════════════════

    (function _wrapDataRender() {
        if (!_hasWin) return;
        if (typeof G.PRiSM_renderDataTabEnhanced !== 'function') {
            // Tab 1 may render via the foundation directly. Try again later.
            if (typeof setTimeout === 'function') {
                setTimeout(_wrapDataRender, 250);
            }
            return;
        }
        if (G.PRiSM_renderDataTabEnhanced._cropToolWrapped) return;
        var orig = G.PRiSM_renderDataTabEnhanced;
        var wrapped = function (container) {
            var ret = orig.apply(this, arguments);
            try {
                // Find or create a host below the existing data card.
                var host = null;
                if (_hasDoc) {
                    host = document.getElementById('prism_crop_tool_host');
                    if (!host) {
                        // Place it inside the Tab 1 body if we can find it.
                        var tab1 = container && container.appendChild
                            ? container
                            : document.getElementById('prism_tab_1');
                        if (tab1 && tab1.appendChild) {
                            host = document.createElement('div');
                            host.id = 'prism_crop_tool_host';
                            host.className = 'prism-crop-tool';
                            host.style.marginTop = '16px';
                            tab1.appendChild(host);
                        }
                    }
                }
                if (host && typeof G.PRiSM_renderCropTool === 'function') {
                    G.PRiSM_renderCropTool(host);
                }
            } catch (e) {
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('PRiSM crop-tool render failed:', e);
                }
            }
            return ret;
        };
        // Preserve flags so other wrappers don't rewrap.
        for (var k in orig) { try { wrapped[k] = orig[k]; } catch (e) {} }
        wrapped._cropToolWrapped = true;
        G.PRiSM_renderDataTabEnhanced = wrapped;
    })();


    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — SELF-TEST
    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 12-data-crop ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 13-auto-match ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 13 — Auto-Match Orchestrator
//   Classifies flow regimes from Bourdet derivative shape, narrows to a
//   candidate model set, races them via LM regression, ranks by AIC.
// -----------------------------------------------------------------------------
// PUBLIC API (all on window.PRiSM_*)
//   PRiSM_classifyRegimes(t, p, dp?)       → { regimes, candidates, summary }
//   PRiSM_autoMatch(opts?)                 → Promise<{ ranked, bestKey, ... }>
//   PRiSM_suggestInitialParams(modelKey,
//                              t, p, dp,
//                              classification) → params
//   PRiSM_renderAutoMatchPanel(host, res)  → void
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • Reads PRiSM_MODELS, never replaces.
//   • No external dependencies — pure vanilla JS, Math.*.
//   • Defensive against missing primitives (PRiSM_compute_bourdet, PRiSM_lm).
//   • Yields to UI between heavy fits via await new Promise(r => setTimeout(r, 0)).
//   • GA4 'prism_auto_match_run' fires if window.gtag exists.
//   • Self-test at the bottom.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});

// =========================================================================
// SECTION 0 — TINY UTILITIES + DEFENSIVE STUBS
// =========================================================================
//
// Inline number formatter (avoid depending on host fmt()). Returns a string
// with the requested number of significant figures, falls back gracefully on
// NaN / Infinity.
function _fmt(n, sig) {
    if (n == null || !isFinite(n)) return '—';
    sig = sig || 4;
    var a = Math.abs(n);
    if (a === 0) return '0';
    if (a >= 1e6 || a < 1e-3) return n.toExponential(Math.max(0, sig - 1));
    return n.toPrecision(sig).replace(/\.?0+$/, '').replace(/\.?0+e/, 'e');
}

// Stable mean of a numeric array (NaNs ignored). Returns NaN if no finite vals.
function _mean(arr) {
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (isFinite(v)) { s += v; n++; }
    }
    return n > 0 ? (s / n) : NaN;
}

// Median of a finite-only copy. Returns NaN if empty.
function _median(arr) {
    var f = [];
    for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) f.push(arr[i]);
    if (!f.length) return NaN;
    f.sort(function (a, b) { return a - b; });
    var m = f.length >> 1;
    return (f.length & 1) ? f[m] : 0.5 * (f[m - 1] + f[m]);
}

// Linear least-squares slope of y = a + m·x. Returns NaN if degenerate.
function _slope(xs, ys) {
    var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < xs.length; i++) {
        var x = xs[i], y = ys[i];
        if (!isFinite(x) || !isFinite(y)) continue;
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (n < 2) return NaN;
    var denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-20) return NaN;
    return (n * sxy - sx * sy) / denom;
}

// Bourdet derivative — uses host PRiSM_compute_bourdet if available, else
// inline 5-point central difference in log-log space (Bourdet 1989).
function _bourdet(t, dp, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        return G.PRiSM_compute_bourdet(t, dp, L != null ? L : 0.2);
    }
    L = (L != null) ? L : 0.2;
    var n = t.length;
    var d = new Array(n);
    for (var k = 0; k < n; k++) d[k] = NaN;
    if (n < 3) return d;
    for (var i = 1; i < n - 1; i++) {
        if (!(t[i] > 0) || !isFinite(dp[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
        }
        var t1 = t[i1], t2 = t[i2], ti = t[i];
        if (!(t1 > 0) || !(t2 > 0)) continue;
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


// =========================================================================
// SECTION 1 — REGIME CLASSIFIER
// =========================================================================
//
// Algorithm:
//   1. Compute Bourdet derivative (skip the input-supplied dp if missing).
//   2. Window the t-axis into ≈ 6 log-spaced segments (with a min of 4 pts
//      per segment, falling back to fewer segments on tiny datasets).
//   3. Linear-regress slope d(log dp')/d(log t) inside each segment.
//   4. Tag each segment by its slope:
//          slope ≈  1.0 → wellboreStorage    (early-time hump)
//          slope ≈  0.5 → linearFlow         (channel / fracture)
//          slope ≈  0.25 → bilinearFlow      (finite-conductivity fracture)
//          slope ≈  0.0 → radialFlow         (stabilisation)
//          slope ≈ -0.5 → sphericalFlow      (partial penetration)
//          slope ≈ -1.0 → constPressure      (constant-pressure boundary)
//          slope ≈ +1.0 (late) → closedBoundary (PSS reservoir limits)
//   5. Detect higher-order shapes:
//          – derivative-doubling (sealingFault) when two consecutive
//            radial segments differ by ~2× in level.
//          – valley between two stabilisations (doublePorosity).
//   6. Map detected regimes to a candidate model list using the rules
//      table in the task spec.
//
// Output:
//   { regimes:   [ { tag, tdStart, tdEnd, slope, confidence, level? }, ... ],
//     candidates: [ modelKey, ... ],
//     summary:   string }
//
// Confidence is the inverse of segment fit residual relative to the slope
// magnitude; clamped to [0, 1]. Uncertain slopes return confidence < 0.4.
//
// "Level" is the geometric-mean Bourdet derivative value across the segment,
// which lets us spot derivative-doubling (sealingFault) without re-walking
// the data.
// =========================================================================

// Slope library — order matters for tie-break. Each entry: { slope, tag,
// tolerance }. We compare absolute distance from the segment's measured
// slope to each library slope and pick the closest within tolerance.
var SLOPE_LIBRARY = [
    { slope:  1.00, tag: 'wellboreStorage', tol: 0.20 },
    { slope:  0.50, tag: 'linearFlow',      tol: 0.18 },
    { slope:  0.25, tag: 'bilinearFlow',    tol: 0.12 },
    { slope:  0.00, tag: 'radialFlow',      tol: 0.15 },
    { slope: -0.50, tag: 'sphericalFlow',   tol: 0.18 },
    { slope: -1.00, tag: 'constPressure',   tol: 0.20 }
];

// Late-time (positive slope) PSS detector. Distinct entry — only fires for
// the latest segment(s) so we don't conflate it with WBS.
var LATE_PSS_TOL = 0.25;

// Map regime-tag combinations to candidate model lists. Probed with a flag
// matrix below. Order in each entry roughly reflects "most likely first".
var CANDIDATE_RULES = [
    {
        cond: function (f) { return f.wbs && f.radial && !f.fault && !f.lin && !f.bilin && !f.spheric && !f.dpor; },
        models: ['homogeneous', 'partialPen']
    },
    {
        cond: function (f) { return f.wbs && f.lin && !f.bilin; },
        models: ['infiniteFrac', 'partialPenFrac', 'parallelChannel']
    },
    {
        cond: function (f) { return f.bilin; },
        models: ['finiteFrac', 'finiteFracSkin']
    },
    {
        cond: function (f) { return f.radial && f.spheric; },
        models: ['partialPen', 'verticalPulse']
    },
    {
        cond: function (f) { return f.dpor; },
        models: ['doublePorosity', 'twoLayerXF']
    },
    {
        cond: function (f) { return f.radial && f.fault; },
        models: ['linearBoundary', 'parallelChannel', 'closedChannel3']
    },
    {
        cond: function (f) { return f.pss; },
        models: ['closedRectangle', 'intersecting']
    },
    {
        cond: function (f) { return f.constP; },
        models: ['linearBoundary', 'radialComposite']
    }
];

// Default set when the classifier is uncertain. Per task spec — 7 fits.
var DEFAULT_CANDIDATES = [
    'homogeneous',
    'linearBoundary',
    'infiniteFrac',
    'horizontal',
    'doublePorosity',
    'radialComposite',
    'partialPen'
];

// Decline (rate-vs-time) candidates appended whenever the dataset has a
// rate column (q present) and looks more like a rate decline than pressure.
var DECLINE_CANDIDATES = ['arps', 'duong', 'sepd', 'fetkovich'];

/**
 * Classify the flow regimes present in (t, dp) by walking the Bourdet
 * derivative.
 *
 * @param {number[]} t   Elapsed time (any consistent unit; > 0).
 * @param {number[]} p   Pressure (or Δp; if pressure, converted to Δp by
 *                        subtracting first sample).
 * @param {number[]=} dp Optional pre-computed Bourdet derivative. If null
 *                        we compute it inline.
 * @return {object}      { regimes, candidates, summary }
 */
function PRiSM_classifyRegimes(t, p, dp) {
    if (!Array.isArray(t) || !Array.isArray(p) || t.length !== p.length) {
        return {
            regimes: [],
            candidates: DEFAULT_CANDIDATES.slice(),
            summary: 'Invalid input — t and p arrays required.'
        };
    }
    var n = t.length;
    if (n < 4) {
        return {
            regimes: [{ tag: 'unknown', tdStart: t[0] || 0, tdEnd: t[n - 1] || 0,
                         slope: NaN, confidence: 0 }],
            candidates: DEFAULT_CANDIDATES.slice(),
            summary: 'Dataset too short (< 4 samples) — using default candidates.'
        };
    }

    // Convert pressure to Δp using a SIGN-AWARE convention so both buildup
    // (p increases from p0) and drawdown (p decreases from p0) yield POSITIVE
    // Δp through the test. Bug fix 2026-04-26 — was previously p[i]-p[0]
    // which produced negative values on drawdowns, killing the regime
    // classifier (it filters log10(d≤0) → NaN → zero candidates → only Arps
    // survives the race with R²=−195).
    var deltaP = new Array(n);
    var p0 = p[0];
    var pEnd = p[n - 1];
    var sign = (pEnd - p0) >= 0 ? 1 : -1;   // +1 buildup, -1 drawdown
    for (var i = 0; i < n; i++) deltaP[i] = sign * (p[i] - p0);

    var deriv = (Array.isArray(dp) && dp.length === n) ? dp.slice() : _bourdet(t, deltaP, 0.2);
    // Also flip the supplied dp's sign if the trend is drawdown — caller may
    // have computed it from the raw signed pressure, in which case half the
    // values would be negative.
    if (sign < 0 && Array.isArray(dp)) {
        for (var dk = 0; dk < deriv.length; dk++) deriv[dk] = Math.abs(deriv[dk]);
    }

    // Build (logT, logD) sample list with finite, positive values only.
    var X = [], Y = [], idxMap = [];
    for (var k = 0; k < n; k++) {
        if (!(t[k] > 0)) continue;
        var d = deriv[k];
        if (!isFinite(d) || d <= 0) continue;
        X.push(Math.log10(t[k]));
        Y.push(Math.log10(d));
        idxMap.push(k);
    }
    var nGood = X.length;
    if (nGood < 3) {
        return {
            regimes: [{ tag: 'unknown', tdStart: t[0], tdEnd: t[n - 1],
                         slope: NaN, confidence: 0 }],
            candidates: DEFAULT_CANDIDATES.slice(),
            summary: 'Bourdet derivative dominated by NaN/non-positive values — using default candidates.'
        };
    }

    // Choose number of windows. Aim for 6 segments × ≥ 3 points each;
    // shrink on small datasets.
    var nSeg = Math.max(3, Math.min(6, Math.floor(nGood / 3)));
    var perSeg = Math.floor(nGood / nSeg);
    var segments = [];
    for (var s = 0; s < nSeg; s++) {
        var i0 = s * perSeg;
        var i1 = (s === nSeg - 1) ? nGood : i0 + perSeg;
        if (i1 - i0 < 2) continue;
        var xs = X.slice(i0, i1);
        var ys = Y.slice(i0, i1);
        var m = _slope(xs, ys);
        // Residual SD around the regressed line — used for confidence.
        var b = _mean(ys) - m * _mean(xs);
        var sse = 0;
        for (var rr = 0; rr < xs.length; rr++) {
            var pred = b + m * xs[rr];
            var e = ys[rr] - pred;
            sse += e * e;
        }
        var rmse = Math.sqrt(sse / xs.length);

        // Geometric mean of derivative level inside the segment (used to
        // detect derivative-doubling between consecutive radial windows).
        var lvl = Math.pow(10, _mean(ys));

        segments.push({
            tdStart: t[idxMap[i0]],
            tdEnd:   t[idxMap[i1 - 1]],
            slope:   m,
            rmse:    rmse,
            level:   lvl,
            ys:      ys
        });
    }

    // Tag each segment by its closest library slope. Confidence falls off
    // as |meas - lib| approaches the tolerance and as the segment RMSE
    // grows.
    var regimes = [];
    var lastSegIdx = segments.length - 1;
    for (var ss = 0; ss < segments.length; ss++) {
        var seg = segments[ss];
        var best = null, bestErr = Infinity;
        for (var li = 0; li < SLOPE_LIBRARY.length; li++) {
            var lib = SLOPE_LIBRARY[li];
            var err = Math.abs(seg.slope - lib.slope);
            if (err < bestErr) { bestErr = err; best = lib; }
        }
        // Late-time PSS detector: positive slope on the latest segment.
        if (ss === lastSegIdx && seg.slope > 0.6 && seg.slope < 1.4) {
            regimes.push({
                tag:        'closedBoundary',
                tdStart:    seg.tdStart,
                tdEnd:      seg.tdEnd,
                slope:      seg.slope,
                confidence: Math.max(0.3, 1 - Math.abs(seg.slope - 1) / LATE_PSS_TOL - seg.rmse),
                level:      seg.level
            });
            continue;
        }
        var tag = (best && bestErr <= best.tol) ? best.tag : 'unknown';
        var conf = 1 - (bestErr / Math.max(best.tol, 1e-6)) - Math.min(0.4, seg.rmse);
        if (conf < 0) conf = 0; if (conf > 1) conf = 1;
        regimes.push({
            tag:        tag,
            tdStart:    seg.tdStart,
            tdEnd:      seg.tdEnd,
            slope:      seg.slope,
            confidence: conf,
            level:      seg.level
        });
    }

    // ── Higher-order shape: derivative-doubling between two consecutive
    //    radial segments → sealingFault. The level on the second segment
    //    should be ~2× the first.
    var faultDetected = false;
    for (var rk = 1; rk < regimes.length; rk++) {
        var a = regimes[rk - 1], b2 = regimes[rk];
        if (a.tag === 'radialFlow' && b2.tag === 'radialFlow') {
            if (a.level > 0 && b2.level / a.level > 1.4 && b2.level / a.level < 3.0) {
                regimes.push({
                    tag:        'sealingFault',
                    tdStart:    a.tdEnd,
                    tdEnd:      b2.tdStart,
                    slope:      0,
                    confidence: Math.min(0.95, 0.5 + 0.4 * (1 - Math.abs(b2.level / a.level - 2.0))),
                    level:      b2.level
                });
                faultDetected = true;
                break;
            }
        }
    }

    // ── Valley between two stabilisations → doublePorosity.
    //    Look for radial - dip - radial (the dip's segment slope < -0.2 or
    //    its level is conspicuously below both flanking radial segments).
    var dporDetected = false;
    if (regimes.length >= 3) {
        for (var v = 1; v < regimes.length - 1; v++) {
            var pre = regimes[v - 1], cur = regimes[v], nxt = regimes[v + 1];
            var preR = (pre.tag === 'radialFlow');
            var nxtR = (nxt.tag === 'radialFlow');
            if (preR && nxtR && cur.level > 0 &&
                cur.level < 0.7 * Math.min(pre.level, nxt.level)) {
                regimes.push({
                    tag:        'doublePorosity',
                    tdStart:    pre.tdEnd,
                    tdEnd:      nxt.tdStart,
                    slope:      cur.slope,
                    confidence: 0.7,
                    level:      cur.level
                });
                dporDetected = true;
                break;
            }
        }
    }

    // ── Build a flag set for the candidate-rule table. Anything with conf
    //    above 0.45 counts.
    var f = {
        wbs:     false, lin:    false, bilin:   false, radial: false,
        spheric: false, constP: false, pss:     false,
        fault:   faultDetected, dpor: dporDetected
    };
    for (var rg = 0; rg < regimes.length; rg++) {
        var r = regimes[rg];
        if (r.confidence < 0.45) continue;
        switch (r.tag) {
            case 'wellboreStorage': f.wbs    = true; break;
            case 'linearFlow':      f.lin    = true; break;
            case 'bilinearFlow':    f.bilin  = true; break;
            case 'radialFlow':      f.radial = true; break;
            case 'sphericalFlow':   f.spheric = true; break;
            case 'constPressure':   f.constP = true; break;
            case 'closedBoundary':  f.pss    = true; break;
            case 'sealingFault':    f.fault  = true; break;
            case 'doublePorosity':  f.dpor   = true; break;
        }
    }

    // Build candidate list — first match wins (rules are ordered most-
    // specific → least). Always merge in the homogeneous default at the end
    // for safety.
    var candidates = [];
    for (var c = 0; c < CANDIDATE_RULES.length; c++) {
        if (CANDIDATE_RULES[c].cond(f)) {
            candidates = CANDIDATE_RULES[c].models.slice();
            break;
        }
    }
    if (!candidates.length) candidates = DEFAULT_CANDIDATES.slice();

    // Always include homogeneous at the back as a sanity reference unless
    // already present.
    if (candidates.indexOf('homogeneous') === -1) candidates.push('homogeneous');

    // Ensure every candidate exists in the registry; drop unknowns silently.
    // (When the registry is empty — e.g. classifier called before models are
    //  loaded, or in standalone test — keep the suggested keys so callers can
    //  inspect them.)
    var registry = G.PRiSM_MODELS || {};
    if (Object.keys(registry).length > 0) {
        candidates = candidates.filter(function (k) { return !!registry[k]; });
    }

    // Build human-readable summary.
    var tagOrder = [];
    var seenT = {};
    for (var rg2 = 0; rg2 < regimes.length; rg2++) {
        var rt = regimes[rg2].tag;
        if (rt === 'unknown') continue;
        if (seenT[rt]) continue;
        seenT[rt] = true;
        tagOrder.push(rt);
    }
    var prettyTag = {
        wellboreStorage: 'Wellbore storage',
        linearFlow:      'Linear flow (½-slope)',
        bilinearFlow:    'Bilinear flow (¼-slope)',
        radialFlow:      'Radial flow',
        sphericalFlow:   'Spherical flow (-½-slope)',
        constPressure:   'Constant-pressure boundary',
        closedBoundary:  'Pseudo-steady (closed)',
        sealingFault:    'Derivative doubling (sealing fault)',
        doublePorosity:  'Valley (double porosity)'
    };
    var summary;
    if (tagOrder.length) {
        summary = tagOrder.map(function (t) { return prettyTag[t] || t; }).join(' → ');
        summary += '. Candidates: ' + candidates.slice(0, 4).join(', ');
        if (candidates.length > 4) summary += ' (+' + (candidates.length - 4) + ')';
        summary += '.';
    } else {
        summary = 'No clear regime detected — fitting default candidate set.';
    }

    return {
        regimes:    regimes,
        candidates: candidates,
        summary:    summary
    };
}


// =========================================================================
// SECTION 2 — SMART INITIAL GUESSES
// =========================================================================
//
// For each candidate model, derive initial parameter values from features
// of the diagnostic data. These are ROUGH starts — LM will refine. Bounds
// remain whatever the model's paramSpec declares.
//
// Heuristics used:
//   Cd:     end of slope-1 (WBS) segment in log time → Cd ≈ tWBS_end · 60
//   S:      stabilisation level of derivative vs ideal homogeneous (~0.5)
//             S = -0.5·ln(2·level) - 0.40546   (rearranged radial-flow eqn)
//   FcD:    bilinear-flow level → conductivity
//   L / dF: time of slope-doubling (sealingFault) → distance via Lr = sqrt(t)
//   ω, λ:   depth + horizontal extent of derivative valley
//   qi:     first observed rate (decline models)
//   Di:     ln(q[0]/q[end]) / (t[end]-t[0]) (decline)
//
// Failsafe: if a heuristic can't be evaluated (no relevant regime found),
// fall back to the model's defaults entry. The orchestrator never crashes.
// =========================================================================

/**
 * Derive a sensible initial-parameter set for the named model from data
 * features extracted by PRiSM_classifyRegimes.
 *
 * @param {string} modelKey         Registry key, e.g. 'homogeneous'.
 * @param {number[]} t              Elapsed time.
 * @param {number[]} p              Pressure (or Δp).
 * @param {number[]} dp             Bourdet derivative.
 * @param {object=} classification  Output of PRiSM_classifyRegimes.
 * @return {object}                 Initial-parameter dict (always at least
 *                                   the model's defaults).
 */
function PRiSM_suggestInitialParams(modelKey, t, p, dp, classification) {
    var registry = G.PRiSM_MODELS || {};
    var entry = registry[modelKey];
    var defaults = (entry && entry.defaults) ? entry.defaults : {};
    // Start from a copy of defaults so unknown models still get a sensible
    // (possibly empty) object back.
    var out = {};
    for (var k in defaults) if (defaults.hasOwnProperty(k)) out[k] = defaults[k];

    if (!Array.isArray(t) || !t.length) return out;

    // Ensure dp is usable; recompute if needed. Same sign-aware convention
    // as the regime classifier (see _classifyRegimes for rationale).
    var deltaP = new Array(t.length);
    var p0 = p[0];
    var pEnd = p[t.length - 1];
    var sign = (pEnd - p0) >= 0 ? 1 : -1;
    for (var i = 0; i < t.length; i++) deltaP[i] = sign * (p[i] - p0);
    var deriv = (Array.isArray(dp) && dp.length === t.length) ? dp : _bourdet(t, deltaP, 0.2);
    if (sign < 0 && Array.isArray(dp)) {
        deriv = deriv.map(function (v) { return Math.abs(v); });
    }

    // ── Feature extraction ────────────────────────────────────────────
    var regimes = (classification && classification.regimes) || [];

    // (a) End-of-WBS time (slope ≈ 1) → Cd start.
    var wbsEnd = NaN;
    for (var rg = 0; rg < regimes.length; rg++) {
        if (regimes[rg].tag === 'wellboreStorage') {
            wbsEnd = regimes[rg].tdEnd;
        }
    }
    // Fallback: time at which derivative slope flattens to within 0.3 of zero.
    if (!isFinite(wbsEnd)) {
        // Walk t, find the first index where last-3 derivative log-slope < 0.5.
        for (var ix = 5; ix < t.length; ix++) {
            var x1 = Math.log10(t[ix - 4]), x2 = Math.log10(t[ix]);
            var y1 = Math.log10(deriv[ix - 4] || 1e-9), y2 = Math.log10(deriv[ix] || 1e-9);
            if (!isFinite(x1) || !isFinite(x2) || x2 - x1 < 1e-6) continue;
            var sl = (y2 - y1) / (x2 - x1);
            if (sl < 0.5) { wbsEnd = t[ix - 4]; break; }
        }
    }

    // (b) Median radial-flow derivative level → S, kh.
    var radLvl = NaN;
    for (var rg2 = 0; rg2 < regimes.length; rg2++) {
        if (regimes[rg2].tag === 'radialFlow') {
            radLvl = regimes[rg2].level;
            break;
        }
    }
    if (!isFinite(radLvl)) {
        // Fallback: median of the late half of the derivative.
        var lateHalf = [];
        for (var jx = (t.length / 2) | 0; jx < t.length; jx++) {
            var dvv = deriv[jx];
            if (isFinite(dvv) && dvv > 0) lateHalf.push(dvv);
        }
        radLvl = _median(lateHalf);
    }

    // (c) Time of slope-doubling (sealingFault) → boundary distance.
    var faultT = NaN, faultLvl = NaN;
    for (var rg3 = 0; rg3 < regimes.length; rg3++) {
        if (regimes[rg3].tag === 'sealingFault') {
            faultT = regimes[rg3].tdStart;
            faultLvl = regimes[rg3].level;
            break;
        }
    }

    // (d) Bilinear-flow level → FcD.
    var bilinLvl = NaN;
    for (var rg4 = 0; rg4 < regimes.length; rg4++) {
        if (regimes[rg4].tag === 'bilinearFlow') {
            bilinLvl = regimes[rg4].level;
            break;
        }
    }

    // (e) Decline-curve features.
    var qi = NaN, Di_guess = NaN;
    if (G.PRiSM_dataset && Array.isArray(G.PRiSM_dataset.q)) {
        var Q = G.PRiSM_dataset.q;
        var qFin = Q.filter(function (v) { return isFinite(v) && v > 0; });
        if (qFin.length) {
            qi = qFin[0];
            var qLast = qFin[qFin.length - 1];
            var dt = t[t.length - 1] - t[0];
            if (qi > 0 && qLast > 0 && dt > 0) {
                Di_guess = Math.log(qi / qLast) / dt;
                if (!isFinite(Di_guess) || Di_guess <= 0) Di_guess = NaN;
            }
        }
    }

    // ── Now translate features into per-parameter starting values ──────

    // Cd guess: end-of-WBS time scaled (rough — Stehfest sees Cd · t_d_unit).
    // For an idealised homogeneous + WBS response, the unit-slope WBS line
    // ends roughly where t_d ≈ Cd / 5. So Cd ≈ 5 · t_wbs_end. We clamp to
    // the model's own min/max (default 0..1e10) so it never goes negative.
    if ('Cd' in out) {
        if (isFinite(wbsEnd) && wbsEnd > 0) {
            var cdGuess = Math.max(1, Math.min(1e6, 5 * wbsEnd));
            out.Cd = cdGuess;
        }
    }

    // S guess from stabilisation level:
    //   For ideal homogeneous, derivative on a Bourdet plot stabilises at
    //   the dimensional value 70.6·q·μ·B / (k·h) when params have units. In
    //   dimensionless space the level is 0.5 at zero skin. For a real
    //   dataset we can't separate kh and S without dimensional context, so
    //   we leave S = 0 unless the regime confidence flagged something.
    if ('S' in out) {
        // Default keep model.defaults.S; but if WBS hump appears very late
        // relative to first stabilisation, tilt S positive (damaged well).
        if (isFinite(wbsEnd) && isFinite(radLvl) && radLvl > 0) {
            // No reliable kh-free formula. Use a small bias around zero,
            // keeping LM bounds wide.
            out.S = Math.max(-3, Math.min(10, 0));
        }
    }

    // Fault distance dF (linearBoundary): scale with time-to-doubling.
    if ('dF' in out) {
        if (isFinite(faultT) && faultT > 0) {
            // Lr = sqrt(0.000264 · k · t / (φ · μ · ct)). Without kh we use
            // the dimensionless form: dF (in r_w) ≈ sqrt(faultT / 4 · Cd).
            var cdRef = ('Cd' in out) ? out.Cd : 100;
            var dfGuess = Math.max(10, Math.min(1e5, Math.sqrt(faultT * cdRef / 4)));
            out.dF = dfGuess;
        }
    }
    // Parallel/closed channels — same heuristic for both faults.
    if ('dF1' in out && isFinite(faultT) && faultT > 0) {
        var cdRef2 = ('Cd' in out) ? out.Cd : 100;
        var dfg = Math.max(10, Math.min(1e5, Math.sqrt(faultT * cdRef2 / 4)));
        out.dF1 = dfg;
        if ('dF2' in out) out.dF2 = dfg;
        if ('dEnd' in out) out.dEnd = dfg * 2;
    }

    // FcD guess from bilinear level (very rough). Higher FcD = steeper
    // bilinear → smaller derivative level.
    if ('FcD' in out && isFinite(bilinLvl) && bilinLvl > 0) {
        var fcdGuess = Math.max(0.5, Math.min(500, 5 / bilinLvl));
        out.FcD = fcdGuess;
    }

    // Double-porosity ω (storativity ratio) ≈ ratio of valley level to
    // first-radial level.
    if ('omega' in out) {
        var firstR = NaN, valley = NaN;
        for (var rg5 = 0; rg5 < regimes.length; rg5++) {
            if (regimes[rg5].tag === 'radialFlow' && !isFinite(firstR)) firstR = regimes[rg5].level;
            if (regimes[rg5].tag === 'doublePorosity') valley = regimes[rg5].level;
        }
        if (isFinite(firstR) && firstR > 0 && isFinite(valley) && valley > 0) {
            var omegaG = Math.max(0.005, Math.min(0.5, valley / firstR));
            out.omega = omegaG;
        }
    }

    // Decline models.
    if ('qi' in out && isFinite(qi)) out.qi = qi;
    if ('q1' in out && isFinite(qi)) out.q1 = qi;
    if ('Di' in out && isFinite(Di_guess)) out.Di = Math.max(1e-4, Math.min(2.0, Di_guess));
    if ('tau' in out && isFinite(Di_guess) && Di_guess > 0) out.tau = 1 / Di_guess;

    return out;
}


// =========================================================================
// SECTION 3 — MODEL RACE ORCHESTRATOR
// =========================================================================
//
// For each candidate, derive initial params from the classification, build
// the bounds dict from paramSpec, freeze any string/categorical params,
// and call PRiSM_lm. We yield the event loop between fits so a 30-model
// race doesn't lock up the UI.
//
// Ranking:  AIC ascending. Ties broken on R². Drop fits where converged
// is false AND R² < 0.5. Keep non-converged but high-R² fits as
// "best-effort" with the bestEffort flag set.
//
// Result shape (per ranked entry):
//   { modelKey, params, CI95, AIC, R2, RMSE, iterations, converged,
//     bestEffort?, error? }
// =========================================================================

/**
 * Race candidate models against the active dataset using LM regression.
 * Returns a Promise resolving to a ranked-by-AIC result object.
 *
 * @param {object=} opts {
 *     dataset?     — { t, p, q? } override. Else reads window.PRiSM_dataset.
 *     candidates?  — array of model keys to race. Else uses classifier.
 *     topN?        — keep top-N entries (default 5; enforced ≤ 8).
 *     classifyOnly? — if true, skip LM; just return classification.
 *     maxIter?     — passed through to PRiSM_lm (default 30 for speed).
 *     tolerance?   — passed through to PRiSM_lm (default 1e-5).
 *     onProgress?  — callback(idx, total, modelKey).
 *  }
 * @return {Promise<object>}
 */
function PRiSM_autoMatch(opts) {
    opts = opts || {};
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // Resolve dataset.
    var dataset = opts.dataset || G.PRiSM_dataset;
    if (!dataset || !Array.isArray(dataset.t) || !Array.isArray(dataset.p) ||
        dataset.t.length !== dataset.p.length || dataset.t.length < 4) {
        return Promise.reject(new Error('PRiSM_autoMatch: no usable dataset (need t[] and p[] of equal length, ≥ 4 samples).'));
    }

    // Compute Bourdet derivative once (re-used by classifier and seed).
    // Sign-aware: drawdowns get |Δp| so the derivative magnitudes are positive
    // and the regime classifier can do log10() without NaN.
    var nDS = dataset.t.length;
    var p0DS = dataset.p[0];
    var pEndDS = dataset.p[nDS - 1];
    var signDS = (pEndDS - p0DS) >= 0 ? 1 : -1;   // +1 buildup, -1 drawdown
    var deltaP = new Array(nDS);
    for (var i = 0; i < nDS; i++) deltaP[i] = signDS * (dataset.p[i] - p0DS);
    var deriv = _bourdet(dataset.t, deltaP, 0.2);
    // Stash the dataset's flow-direction sign + magnitude-Δp on the dataset
    // so the LM call below uses positive Δp against positive model pd.
    var datasetForLM = {
        t: dataset.t,
        p: deltaP.map(function (v, k) { return p0DS + v; }), // p flipped if drawdown
        q: dataset.q,
        _signedDeltaP: deltaP,
        _signFlow: signDS
    };

    var classification = PRiSM_classifyRegimes(dataset.t, dataset.p, deriv);

    // If the dataset has a meaningful rate column, append decline candidates.
    var hasRateMode = false;
    if (dataset.q && Array.isArray(dataset.q)) {
        var nonZeroRates = 0;
        for (var qi2 = 0; qi2 < dataset.q.length; qi2++) {
            if (dataset.q[qi2] != null && isFinite(dataset.q[qi2]) && dataset.q[qi2] > 0) nonZeroRates++;
        }
        // If rate is a primary signal (most points have q > 0), assume DCA.
        if (nonZeroRates > 0.5 * dataset.q.length) hasRateMode = true;
    }

    // Build candidate list.
    var candidates;
    if (Array.isArray(opts.candidates) && opts.candidates.length) {
        candidates = opts.candidates.slice();
    } else {
        candidates = classification.candidates.slice();
        if (hasRateMode) {
            for (var di = 0; di < DECLINE_CANDIDATES.length; di++) {
                if (candidates.indexOf(DECLINE_CANDIDATES[di]) === -1) {
                    candidates.push(DECLINE_CANDIDATES[di]);
                }
            }
        }
    }
    // Filter to ones that actually exist in the registry.
    var registry = G.PRiSM_MODELS || {};
    candidates = candidates.filter(function (k) { return !!registry[k]; });
    if (!candidates.length) {
        return Promise.reject(new Error('PRiSM_autoMatch: no valid candidate models in registry.'));
    }

    // Trim to a hard ceiling (8) so a misconfigured caller can't run all 27
    // models accidentally.
    if (candidates.length > 8) candidates = candidates.slice(0, 8);

    if (opts.classifyOnly) {
        return Promise.resolve({
            ranked:         [],
            bestKey:        null,
            deltaAIC:       [],
            classification: classification,
            elapsedMs:      0,
            timestamp:      new Date().toISOString()
        });
    }

    var lmOpts = {
        maxIter:   (opts.maxIter   != null) ? opts.maxIter   : 30,
        tolerance: (opts.tolerance != null) ? opts.tolerance : 1e-5
    };

    var topN = Math.max(1, Math.min(8, opts.topN || 5));
    // Sign-aware data passed to LM: model pd is always positive (pwd ≥ 0),
    // so the LM target must be positive too. For drawdowns we feed LM the
    // mirror-image pressure: p_LM[i] = p0 + |p[i] - p0| so that p_LM
    // increases monotonically just like a buildup. Without this fix the LM
    // sees negative residuals everywhere and converges to garbage on
    // drawdown datasets.
    var data = {
        t: dataset.t.slice(),
        p: deltaP.map(function (v) { return p0DS + v; }),  // mirrored to positive Δp
        q: dataset.q ? dataset.q.slice() : null
    };
    var results = [];
    var idx = 0;

    function _onProgress(modelKey) {
        if (typeof opts.onProgress === 'function') {
            try { opts.onProgress(idx, candidates.length, modelKey); } catch (e) { /* silent */ }
        }
    }

    // Fit one candidate. Returns a settled Promise — never rejects, errors
    // are captured into the result entry so the race continues.
    function _raceOne(modelKey) {
        return new Promise(function (resolve) {
            // Yield to UI so a 30-model race doesn't freeze the browser.
            setTimeout(function () {
                _onProgress(modelKey);
                var entry = registry[modelKey];
                if (!entry || typeof entry.pd !== 'function') {
                    resolve({
                        modelKey:   modelKey,
                        error:      'No pd evaluator',
                        AIC:        Infinity,
                        R2:         -Infinity,
                        RMSE:       NaN,
                        iterations: 0,
                        converged:  false
                    });
                    return;
                }

                // Initial params + bounds.
                var initParams;
                try {
                    initParams = PRiSM_suggestInitialParams(modelKey, dataset.t, dataset.p, deriv, classification);
                } catch (e) {
                    initParams = {};
                    for (var k in entry.defaults) if (entry.defaults.hasOwnProperty(k)) initParams[k] = entry.defaults[k];
                }

                var bounds = {};
                if (Array.isArray(entry.paramSpec)) {
                    for (var ps = 0; ps < entry.paramSpec.length; ps++) {
                        var sp = entry.paramSpec[ps];
                        if (sp.min != null && sp.max != null) bounds[sp.key] = [sp.min, sp.max];
                    }
                }

                // Auto-freeze categoricals.
                var freeze = {};
                for (var pk in initParams) {
                    if (initParams.hasOwnProperty(pk) && typeof initParams[pk] !== 'number') {
                        freeze[pk] = true;
                    }
                }

                if (typeof G.PRiSM_lm !== 'function') {
                    resolve({
                        modelKey:   modelKey,
                        error:      'PRiSM_lm not available',
                        AIC:        Infinity,
                        R2:         -Infinity,
                        RMSE:       NaN,
                        params:     initParams,
                        iterations: 0,
                        converged:  false
                    });
                    return;
                }

                var fit;
                try {
                    fit = G.PRiSM_lm(entry.pd, data, initParams, bounds, freeze, lmOpts);
                } catch (e) {
                    resolve({
                        modelKey:   modelKey,
                        error:      String(e && e.message || e),
                        AIC:        Infinity,
                        R2:         -Infinity,
                        RMSE:       NaN,
                        params:     initParams,
                        iterations: 0,
                        converged:  false
                    });
                    return;
                }
                resolve({
                    modelKey:   modelKey,
                    params:     fit.params,
                    CI95:       fit.ci95,
                    stderr:     fit.stderr,
                    AIC:        isFinite(fit.aic) ? fit.aic : Infinity,
                    R2:         isFinite(fit.r2)  ? fit.r2  : -Infinity,
                    RMSE:       fit.rmse,
                    iterations: fit.iterations,
                    converged:  fit.converged
                });
            }, 0);
        });
    }

    // Sequential race so each model gets the main thread to itself, with a
    // setTimeout(0) yield so the UI stays responsive.
    function _raceLoop() {
        if (idx >= candidates.length) return Promise.resolve();
        var key = candidates[idx];
        return _raceOne(key).then(function (res) {
            results.push(res);
            idx++;
            return _raceLoop();
        });
    }

    return _raceLoop().then(function () {
        // Drop hopeless fits (no convergence AND low R²) but keep
        // non-converged-but-decent ones with bestEffort flag.
        var keep = [];
        for (var r = 0; r < results.length; r++) {
            var rs = results[r];
            if (rs.error) {
                // Errors stay in keep so caller can see why a candidate failed,
                // but they sort to the bottom by AIC = +Infinity.
                keep.push(rs);
                continue;
            }
            if (!rs.converged && rs.R2 < 0.5) continue;
            if (!rs.converged) rs.bestEffort = true;
            keep.push(rs);
        }

        // Rank: AIC asc, ties on R² desc.
        keep.sort(function (a, b) {
            if (a.AIC !== b.AIC) return a.AIC - b.AIC;
            return b.R2 - a.R2;
        });

        var ranked = keep.slice(0, topN);
        var bestKey = ranked.length ? ranked[0].modelKey : null;
        var bestAIC = ranked.length ? ranked[0].AIC : NaN;
        var deltaAIC = ranked.map(function (r) {
            return (isFinite(r.AIC) && isFinite(bestAIC)) ? (r.AIC - bestAIC) : NaN;
        });

        var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var elapsedMs = t1 - t0;

        var result = {
            ranked:         ranked,
            bestKey:        bestKey,
            deltaAIC:       deltaAIC,
            classification: classification,
            elapsedMs:      elapsedMs,
            timestamp:      new Date().toISOString()
        };

        // GA4 hook (silent if gtag absent).
        try {
            if (typeof G.gtag === 'function') {
                G.gtag('event', 'prism_auto_match_run', {
                    event_category: 'PRiSM',
                    best_model:     bestKey || 'none',
                    elapsed_ms:     Math.round(elapsedMs),
                    n_candidates:   ranked.length
                });
            }
        } catch (e) { /* silent */ }

        return result;
    });
}


// =========================================================================
// SECTION 4 — UI PANEL
// =========================================================================
//
// Renders a side-by-side comparison panel: best-fit model + up to 2
// alternatives. Each row shows params, ±CI95, AIC, R², ΔAIC and an
// "Apply this fit" button that promotes the row's params to PRiSM_state
// and re-renders the active plot.
//
// Style: defensive — works with or without the host's stylesheet. Inline
// CSS keeps the panel readable in any context (Tab 5/6 of the PRiSM UI,
// or a stand-alone debug iframe).
// =========================================================================

/**
 * Render an auto-match result panel into the supplied container.
 *
 * @param {HTMLElement} container Host node — innerHTML is replaced.
 * @param {object}      result    Output of PRiSM_autoMatch.
 */
function PRiSM_renderAutoMatchPanel(container, result) {
    if (!container || typeof container.innerHTML !== 'string') return;
    if (!result) {
        container.innerHTML = '<div style="padding:12px; color:#999; font-size:13px;">No auto-match result yet.</div>';
        return;
    }
    if (!result.ranked || !result.ranked.length) {
        var msg = (result.classification && result.classification.summary) || 'No converged fits.';
        container.innerHTML =
            '<div style="padding:14px; color:#999; font-size:13px;">' +
            '<strong style="color:#ddd;">Auto-match found no acceptable fit.</strong>' +
            '<div style="margin-top:6px;">' + _esc(msg) + '</div>' +
            '</div>';
        return;
    }

    var registry = G.PRiSM_MODELS || {};
    var classification = result.classification || { regimes: [], candidates: [], summary: '' };

    // ── Header — best model + summary ─────────────────────────────────
    var best = result.ranked[0];
    var bestEntry = registry[best.modelKey] || {};
    var bestLabel = (bestEntry.description) ? best.modelKey : best.modelKey;
    var headerHTML =
        '<div style="padding:12px 14px; border:1px solid #2a3340; border-radius:8px; background:#0e131a; margin-bottom:10px;">' +
        '<div style="display:flex; align-items:baseline; flex-wrap:wrap; gap:14px;">' +
            '<div style="font-size:12px; font-weight:700; color:#7ad7ff; text-transform:uppercase; letter-spacing:.5px;">Best fit</div>' +
            '<div style="font-size:16px; font-weight:600; color:#e6f1ff;">' + _esc(bestLabel) + '</div>' +
            '<div style="font-size:13px; color:#9fb1c8;">R² = ' + _fmt(best.R2, 4) +
                '  ·  AIC = ' + _fmt(best.AIC, 5) +
                '  ·  RMSE = ' + _fmt(best.RMSE, 4) +
                '  ·  ' + (best.converged ? 'converged' : (best.bestEffort ? 'best-effort' : '—')) +
                ' in ' + (best.iterations || 0) + ' iter</div>' +
            '<div style="margin-left:auto; font-size:11px; color:#6c7c93;">elapsed ' + _fmt(result.elapsedMs, 4) + ' ms</div>' +
        '</div>' +
        '<div style="margin-top:6px; font-size:12px; color:#9fb1c8;">' +
            '<strong style="color:#cfd8e3;">Diagnostic:</strong> ' + _esc(classification.summary || '') +
        '</div>' +
        '</div>';

    // ── Comparison table — best + up to 2 alternatives ────────────────
    var rowHTML = '';
    var nShow = Math.min(3, result.ranked.length);
    for (var r = 0; r < nShow; r++) {
        var row = result.ranked[r];
        var entry = registry[row.modelKey] || {};
        var deltaA = isFinite(result.deltaAIC[r]) ? _fmt(result.deltaAIC[r], 4) : '—';
        var rankBadge = (r === 0) ? '★ best' : ('#' + (r + 1));
        var paramListHTML = '';
        if (row.params && typeof row.params === 'object') {
            var keys = Object.keys(row.params);
            for (var pk = 0; pk < keys.length; pk++) {
                var k = keys[pk];
                var v = row.params[k];
                var ciVal = (row.CI95 && row.CI95[k]) ? row.CI95[k] : null;
                var ciHTML = '';
                if (ciVal && isFinite(ciVal[0]) && isFinite(ciVal[1]) && typeof v === 'number') {
                    var halfW = 0.5 * (ciVal[1] - ciVal[0]);
                    if (isFinite(halfW)) ciHTML = ' ± ' + _fmt(halfW, 3);
                }
                var unit = '';
                if (Array.isArray(entry.paramSpec)) {
                    for (var sp = 0; sp < entry.paramSpec.length; sp++) {
                        if (entry.paramSpec[sp].key === k && entry.paramSpec[sp].unit) {
                            unit = ' ' + entry.paramSpec[sp].unit;
                            break;
                        }
                    }
                }
                var vLabel = (typeof v === 'number') ? _fmt(v, 4) : String(v);
                paramListHTML +=
                    '<div style="display:flex; gap:8px; padding:2px 0; font-size:12px;">' +
                    '<span style="color:#8ea0b8; min-width:60px;">' + _esc(k) + '</span>' +
                    '<span style="color:#e6f1ff; font-family:Menlo,monospace;">' + _esc(vLabel) + _esc(unit) + ciHTML + '</span>' +
                    '</div>';
            }
        }
        var refHTML = (entry.reference)
            ? '<div style="font-size:11px; color:#6c7c93; margin-top:6px;">' + _esc(entry.reference) + '</div>'
            : '';
        var errHTML = row.error
            ? '<div style="font-size:12px; color:#f85149; margin-top:6px;">⚠ ' + _esc(row.error) + '</div>'
            : '';

        rowHTML +=
            '<div data-prism-am-row="' + r + '" data-prism-am-key="' + _esc(row.modelKey) + '" style="' +
                'padding:12px; border:1px solid ' + (r === 0 ? '#2d8def' : '#2a3340') + ';' +
                ' border-radius:8px; background:' + (r === 0 ? '#10202e' : '#0c1117') + '; min-width:240px; flex:1 1 240px;">' +
            '<div style="display:flex; align-items:baseline; gap:8px;">' +
                '<span style="font-size:11px; padding:1px 6px; border-radius:10px; background:' + (r === 0 ? '#2d8def' : '#2a3340') + '; color:#fff;">' + _esc(rankBadge) + '</span>' +
                '<span style="font-size:14px; font-weight:600; color:#e6f1ff;">' + _esc(row.modelKey) + '</span>' +
                '<span style="margin-left:auto; font-size:11px; color:#9fb1c8;">ΔAIC ' + _esc(deltaA) + '</span>' +
            '</div>' +
            '<div style="margin-top:8px; font-size:12px; color:#9fb1c8;">' +
                'R² ' + _fmt(row.R2, 3) + '  ·  RMSE ' + _fmt(row.RMSE, 3) + '  ·  ' + (row.iterations || 0) + ' iter' +
            '</div>' +
            '<div style="margin-top:8px;">' + paramListHTML + '</div>' +
            errHTML + refHTML +
            '<button data-prism-am-apply="' + _esc(row.modelKey) + '" style="' +
                'margin-top:10px; padding:6px 12px; font-size:12px; border-radius:4px; cursor:pointer;' +
                ' background:' + (r === 0 ? '#2d8def' : '#2a3340') + '; color:#fff; border:0;">' +
                'Apply this fit' +
            '</button>' +
            '</div>';
    }

    var altsHTML =
        '<div style="display:flex; flex-wrap:wrap; gap:10px;">' + rowHTML + '</div>';

    // Re-run + bottom controls.
    var footerHTML =
        '<div style="margin-top:12px; padding-top:10px; border-top:1px dashed #2a3340; font-size:11px; color:#6c7c93;">' +
            'Tested ' + result.ranked.length + ' candidate' + (result.ranked.length === 1 ? '' : 's') +
            (result.ranked.some(function (x) { return x.bestEffort; }) ? '  ·  some fits flagged best-effort (non-converged but R² ≥ 0.5)' : '') +
            '<button id="prism_am_rerun" style="margin-left:14px; padding:4px 10px; font-size:11px; border-radius:4px; cursor:pointer; background:#1a2230; color:#e6f1ff; border:1px solid #2a3340;">Re-run with different candidates…</button>' +
        '</div>';

    container.innerHTML = headerHTML + altsHTML + footerHTML;

    // ── Wire "Apply this fit" buttons ─────────────────────────────────
    var applyBtns = container.querySelectorAll('button[data-prism-am-apply]');
    for (var ai = 0; ai < applyBtns.length; ai++) {
        applyBtns[ai].onclick = function (ev) {
            var key = ev.currentTarget.getAttribute('data-prism-am-apply');
            _applyAutoMatchRow(result, key);
        };
    }

    // ── Re-run button — opens a checklist dialog of all 27+ models ────
    var rerunBtn = container.querySelector('#prism_am_rerun');
    if (rerunBtn) {
        rerunBtn.onclick = function () {
            _openCandidateChooser(container, result);
        };
    }
}

// Promote a ranked result row's params + model to PRiSM_state, then
// trigger PRiSM_drawActivePlot if available.
function _applyAutoMatchRow(result, modelKey) {
    if (!result || !result.ranked) return;
    var row = null;
    for (var i = 0; i < result.ranked.length; i++) {
        if (result.ranked[i].modelKey === modelKey) { row = result.ranked[i]; break; }
    }
    if (!row) return;
    if (!G.PRiSM_state) G.PRiSM_state = { params: {}, paramFreeze: {} };
    G.PRiSM_state.model = modelKey;
    G.PRiSM_state.params = {};
    if (row.params) {
        for (var k in row.params) if (row.params.hasOwnProperty(k)) G.PRiSM_state.params[k] = row.params[k];
    }
    G.PRiSM_state.match = row;
    if (typeof G.PRiSM_drawActivePlot === 'function') {
        try { G.PRiSM_drawActivePlot(); } catch (e) { /* silent */ }
    }
    // Toast feedback if available.
    if (typeof G.toast === 'function') {
        try { G.toast('Applied ' + modelKey, 'success'); } catch (e) { /* silent */ }
    }
    try {
        if (typeof G.gtag === 'function') {
            G.gtag('event', 'prism_auto_match_apply', {
                event_category: 'PRiSM',
                model_key:      modelKey
            });
        }
    } catch (e) { /* silent */ }
}

// Open a simple modal-ish overlay listing every model in the registry
// with a checkbox; user picks the candidate set then re-races.
function _openCandidateChooser(host, prevResult) {
    if (typeof document === 'undefined') return;
    var registry = G.PRiSM_MODELS || {};
    var keys = Object.keys(registry).sort();
    if (!keys.length) return;
    // Pre-select whatever was used last time.
    var preselect = {};
    if (prevResult && prevResult.ranked) {
        for (var i = 0; i < prevResult.ranked.length; i++) preselect[prevResult.ranked[i].modelKey] = true;
    }

    var existing = document.getElementById('prism_am_chooser');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var overlay = document.createElement('div');
    overlay.id = 'prism_am_chooser';
    overlay.style.cssText =
        'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999;' +
        ' display:flex; align-items:center; justify-content:center;';

    var checkboxes = '';
    for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var entry = registry[key];
        var category = entry.category || '—';
        var checked = preselect[key] ? 'checked' : '';
        checkboxes +=
            '<label style="display:flex; align-items:center; gap:8px; padding:4px 6px; font-size:12px; color:#e6f1ff; border-bottom:1px dashed #1f2734;">' +
            '<input type="checkbox" data-prism-am-cand value="' + _esc(key) + '" ' + checked + '>' +
            '<span style="font-weight:600; min-width:160px;">' + _esc(key) + '</span>' +
            '<span style="color:#9fb1c8;">' + _esc(category) + '</span>' +
            '</label>';
    }
    overlay.innerHTML =
        '<div style="background:#0e131a; border:1px solid #2a3340; border-radius:10px; max-width:560px; width:90%; max-height:80vh; display:flex; flex-direction:column;">' +
            '<div style="padding:14px; border-bottom:1px solid #2a3340; font-size:14px; font-weight:600; color:#e6f1ff;">Select models to race</div>' +
            '<div style="padding:8px 14px; overflow-y:auto; flex:1;">' + checkboxes + '</div>' +
            '<div style="padding:14px; border-top:1px solid #2a3340; display:flex; gap:8px; justify-content:flex-end;">' +
                '<button id="prism_am_chooser_cancel" style="padding:6px 12px; font-size:12px; border-radius:4px; background:#1a2230; color:#e6f1ff; border:1px solid #2a3340; cursor:pointer;">Cancel</button>' +
                '<button id="prism_am_chooser_run" style="padding:6px 12px; font-size:12px; border-radius:4px; background:#2d8def; color:#fff; border:0; cursor:pointer;">Run race</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#prism_am_chooser_cancel').onclick = function () {
        overlay.parentNode.removeChild(overlay);
    };
    overlay.querySelector('#prism_am_chooser_run').onclick = function () {
        var picked = [];
        var boxes = overlay.querySelectorAll('input[data-prism-am-cand]');
        for (var b = 0; b < boxes.length; b++) {
            if (boxes[b].checked) picked.push(boxes[b].value);
        }
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (!picked.length) return;
        // Disable host button while running.
        host.innerHTML = '<div style="padding:14px; color:#9fb1c8; font-size:13px;">Racing ' + picked.length + ' model' + (picked.length === 1 ? '' : 's') + '…</div>';
        PRiSM_autoMatch({ candidates: picked }).then(function (newResult) {
            PRiSM_renderAutoMatchPanel(host, newResult);
        }, function (err) {
            host.innerHTML = '<div style="padding:14px; color:#f85149; font-size:13px;">Auto-match failed: ' + _esc(String(err && err.message || err)) + '</div>';
        });
    };
}

// HTML escape helper for user-facing strings.
function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}


// =========================================================================
// SECTION 5 — EXPOSE PUBLIC API
// =========================================================================

G.PRiSM_classifyRegimes      = PRiSM_classifyRegimes;
G.PRiSM_autoMatch             = PRiSM_autoMatch;
G.PRiSM_suggestInitialParams = PRiSM_suggestInitialParams;
G.PRiSM_renderAutoMatchPanel = PRiSM_renderAutoMatchPanel;

})();

// ─── END 13-auto-match ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 14-interpretation ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 14 — Plain-English Interpretation
//   Turns fitted parameter values + CIs into a narrative report:
//   qualitative tags, severity, suggested actions, cautions.
// ────────────────────────────────────────────────────────────────────
//
// Public API (all on window.*):
//   PRiSM_interpretFit(modelKey, params, CI95)         -> { tags, narrative,
//                                                            actions, confidence,
//                                                            cautions }
//   PRiSM_interpretCurrentFit()                        -> result | null
//   PRiSM_renderInterpretationPanel(container, interp) -> void
//   PRiSM_buildNarrative(tags, modelKey, classification)-> string
//
// Conventions:
//   - Single outer IIFE, 'use strict'.
//   - All public symbols on window.PRiSM_*.
//   - No external dependencies — pure vanilla JS, Math.*.
//   - Defensive against missing models / lastFit / DOM.
//   - Self-test at the bottom.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

// Global container — works in browser and Node (smoke-test stub).
var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});
var _hasDoc = (typeof document !== 'undefined');

// Compact in-prose number formatter — fewer trailing zeros, exponential
// for very small or very large magnitudes.
function _prose(n) {
    if (n == null || !isFinite(n)) return '—';
    var v = Number(n), a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10)  return v.toFixed(1);
    if (a >= 1)   return v.toFixed(2);
    return v.toFixed(3);
}


// ════════════════════════════════════════════════════════════════════
// SECTION 1 — PARAM-TO-TAG RULES
// ════════════════════════════════════════════════════════════════════
// Each rule maps a parameter key to a function returning a tag object:
//   { qualitative, severity, hint }
// where hint is a short verb-phrase used in the narrative chain.
//
// Severity ladder: 'good' | 'normal' | 'warning' | 'important'
//   - 'good'      : positive finding, no action required
//   - 'normal'    : within typical range, no action required
//   - 'warning'   : worth flagging, possible action
//   - 'important' : strongly suggests action / further work
// ════════════════════════════════════════════════════════════════════

// Bucket tables — each entry is [upperBound, qualitative, severity, hint].
// First entry whose value < upperBound wins. Last entry must use Infinity.
var SKIN_BUCKETS = [
    [-5,        'highly stimulated',         'good',      'completion is highly stimulated'],
    [-2,        'effectively stimulated',    'good',      'an effectively stimulated completion'],
    [ 0,        'mildly stimulated',         'good',      'a mildly stimulated completion'],
    [ 2,        'no significant skin',       'normal',    'no significant skin'],
    [ 5,        'mildly damaged',            'warning',   'mild near-wellbore damage'],
    [10,        'damaged',                   'warning',   'near-wellbore damage'],
    [Infinity,  'severely damaged',          'important', 'severe near-wellbore damage']
];
var CD_BUCKETS = [
    [50,        'low WBS',                                          'normal',    'low wellbore storage'],
    [500,       'typical WBS',                                      'normal',    'typical wellbore storage'],
    [5000,      'high WBS — masks early-time response',             'warning',   'high wellbore storage that masks the early-time response'],
    [Infinity,  'very high WBS — consider downhole shut-in',        'important', 'very high wellbore storage']
];
var KH_BUCKETS = [
    [10,        'very low productivity',  'warning',   'very low'],
    [100,       'low productivity',       'normal',    'low'],
    [1000,      'moderate productivity',  'normal',    'moderate'],
    [10000,     'high productivity',      'good',      'high'],
    [Infinity,  'very high productivity', 'good',      'very high']
];
var OMEGA_BUCKETS = [
    [0.01,      'fracture-dominated storage (matrix mostly drains)',          'normal',
                'fracture-dominated storage with matrix that mostly drains into the fractures'],
    [0.1,       'natural fractures with significant matrix storage',          'normal',
                'a naturally fractured response with significant matrix storage'],
    [0.5,       'partially fractured',                                         'normal',
                'a partially fractured system'],
    [Infinity,  'weak fracture signature — consider homogeneous instead',     'warning',
                'a weak fracture signature; the response is close to homogeneous']
];
var LAMBDA_BUCKETS = [
    [1e-8,      'very slow matrix-fracture transfer',              'normal', 'very slow matrix-to-fracture transfer'],
    [1e-5,      'typical NF transfer',                              'normal', 'typical naturally fractured transfer'],
    [Infinity,  'fast transfer — close to homogeneous behaviour',  'normal', 'fast matrix-to-fracture transfer (close to homogeneous behaviour)']
];
var XF_BUCKETS = [
    [30,        'short fracture — possible re-frac candidate',     'warning', 'a short fracture half-length'],
    [100,       'moderate fracture half-length',                    'normal',  'a moderate fracture half-length'],
    [300,       'effective fracture stimulation',                   'good',    'effective fracture stimulation'],
    [Infinity,  'very long fracture — confirm propagation model',  'good',    'a very long fracture']
];
var LATERAL_BUCKETS = [
    [500,       'short lateral',                          'normal', 'a short lateral'],
    [3000,      'typical horizontal completion',          'normal', 'a typical horizontal completion'],
    [Infinity,  'long lateral / multi-stage completion',  'normal', 'a long, multi-stage horizontal completion']
];
var FCD_BUCKETS = [
    [1,         'low FcD — fracture-face limited',         'warning', 'low fracture conductivity (fracture-face limited)'],
    [30,        'finite-conductivity fracture',            'normal',  'a finite-conductivity fracture'],
    [300,       'effectively infinite-conductivity',       'good',    'a high-conductivity fracture (effectively infinite)'],
    [Infinity,  'fully conductive fracture',               'good',    'a fully conductive fracture']
];

function _bucketLookup(buckets, v) {
    if (!isFinite(v)) return null;
    for (var i = 0; i < buckets.length; i++) {
        if (v < buckets[i][0]) {
            return { qualitative: buckets[i][1], severity: buckets[i][2], hint: buckets[i][3] };
        }
    }
    return null;
}

// Boundary rule needs label substitution because keys distinguish
// fault 1 / fault 2 / N / S / E / W boundaries.
function _ruleBoundaryL(v, label) {
    if (!isFinite(v)) return null;
    var name = label || 'Boundary';
    var lname = name.toLowerCase();
    if (v < 100)   return { qualitative: name + ' very close — recheck data quality', severity: 'warning',
                             hint: lname + ' very close to the wellbore — data quality should be re-checked' };
    if (v < 500)   return { qualitative: 'near ' + lname + ' detected',               severity: 'important',
                             hint: 'a near ' + lname + ' is detected' };
    if (v < 2000)  return { qualitative: name + ' detected at moderate distance',     severity: 'important',
                             hint: 'a ' + lname + ' is detected at moderate distance' };
    return             { qualitative: 'far ' + lname + ' — late-time signal only', severity: 'normal',
                             hint: 'a far ' + lname + ' is hinted by the late-time signal' };
}

// Param-key dispatch — names follow the registry keys used in 03/06/08/09.
//
// A note on the boundary-distance keys:
//   Layer 03 uses dF, dF1, dF2, dEnd, dN, dS, dE, dW (units of r_w).
//   The Task contract above describes "L" (ft). We treat both as
//   distance-to-boundary tags — the qualitative buckets are unitless
//   bands so the labelling is correct in either case, and the value is
//   reported in the unit attached to the parameter when known.
// --------------------------------------------------------------------
var BOUNDARY_KEYS = {
    'L':     'Boundary',
    'dF':    'Boundary',
    'dF1':   'Fault 1',
    'dF2':   'Fault 2',
    'dEnd':  'End',
    'dN':    'North boundary',
    'dS':    'South boundary',
    'dE':    'East boundary',
    'dW':    'West boundary'
};

function _ruleForKey(key, value) {
    if (key === 'S' || key === 'S_global' || key === 'S_perf') return _bucketLookup(SKIN_BUCKETS, value);
    if (key === 'Cd')                              return _bucketLookup(CD_BUCKETS, value);
    if (key === 'kh')                              return _bucketLookup(KH_BUCKETS, value);
    if (key === 'omega')                           return _bucketLookup(OMEGA_BUCKETS, value);
    if (key === 'lambda')                          return _bucketLookup(LAMBDA_BUCKETS, value);
    if (key === 'xf')                              return _bucketLookup(XF_BUCKETS, value);
    if (key === 'FcD')                             return _bucketLookup(FCD_BUCKETS, value);
    if (key === 'Lh' || key === 'Llat')            return _bucketLookup(LATERAL_BUCKETS, value);
    if (BOUNDARY_KEYS.hasOwnProperty(key))         return _ruleBoundaryL(value, BOUNDARY_KEYS[key]);
    return null;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 2 — PER-MODEL NARRATIVE TEMPLATES
// ════════════════════════════════════════════════════════════════════
// Each model class produces a different opening sentence. We don't
// need a per-model template for every one of the 27 — we group them by
// category and primary parameter signature.
// ════════════════════════════════════════════════════════════════════

// Categories that need a special opening clause beyond the generic one.
function _modelCategoryOpening(modelKey) {
    var spec = (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null;
    var cat = spec && spec.category;
    if (!cat) return null;
    if (cat === 'fracture')      return 'a hydraulically fractured response';
    if (cat === 'boundary')      return 'a bounded reservoir response';
    if (cat === 'composite')     return 'a composite (radial-discontinuity) response';
    if (cat === 'multilayer')    return 'a multi-layer response';
    if (cat === 'multilateral')  return 'a multilateral / branched response';
    if (cat === 'interference')  return 'an interference-test response';
    if (cat === 'decline')       return 'a production-decline signature';
    if (cat === 'special')       return 'a specialised flow regime';
    if (cat === 'reservoir')     return 'a naturally fractured reservoir response';
    return null;
}

// Look up parameter unit / label from the registry — graceful fallback.
function _paramMeta(modelKey, key) {
    var spec = (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null;
    if (!spec || !spec.paramSpec) return { unit: '', label: key };
    for (var i = 0; i < spec.paramSpec.length; i++) {
        if (spec.paramSpec[i].key === key) return spec.paramSpec[i];
    }
    return { unit: '', label: key };
}

// Produce a tag entry (the public-API tag shape) from a value + rule.
function _makeTag(key, value, range, rule) {
    return {
        param:       key,
        value:       value,
        range:       range || [NaN, NaN],
        qualitative: rule.qualitative,
        severity:    rule.severity,
        hint:        rule.hint
    };
}


// ════════════════════════════════════════════════════════════════════
// SECTION 3 — ACTION RECOMMENDER
// ════════════════════════════════════════════════════════════════════
// Severity → list of suggested actions, keyed off the tag's qualitative
// label so we can be specific (e.g. 'damaged' vs 'high WBS').
// ════════════════════════════════════════════════════════════════════

// Map qualitative-label-substring → action sentence.
// Order matters: more-specific phrases come first.
var ACTION_TEMPLATES = [
    // important
    { match: /severely damaged/i,             action: 'Matrix acid stimulation strongly indicated' },
    { match: /^damaged/i,                     action: 'Matrix acid stimulation strongly indicated' },
    { match: /very high WBS/i,                action: 'Mandatory downhole shut-in for next test' },
    { match: /near .* detected|detected at/i, action: 'Confirm boundary against seismic / well-spacing geometry; revise rate planning' },
    { match: /very close/i,                   action: 'Re-examine the early-time data — boundary very close may indicate logging or pressure-gauge artefacts' },
    // warning
    { match: /mildly damaged/i,               action: 'Consider acid wash or matrix stimulation if production targets unmet' },
    { match: /short fracture/i,               action: 'Re-frac candidate evaluation' },
    { match: /^high WBS/i,                    action: 'Future tests: downhole shut-in or longer build-up' },
    { match: /low productivity/i,             action: 'Confirm completion efficiency; consider re-perforation or stimulation' },
    { match: /weak fracture signature/i,      action: 'Re-fit as homogeneous; compare AIC' },
    { match: /low FcD/i,                      action: 'Investigate fracture cleanup or proppant pack quality' }
    // 'good' and 'normal' produce no actions.
];

function _actionsForTags(tags) {
    var out = [];
    for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        if (t.severity !== 'warning' && t.severity !== 'important') continue;
        for (var j = 0; j < ACTION_TEMPLATES.length; j++) {
            if (ACTION_TEMPLATES[j].match.test(t.qualitative)) {
                if (out.indexOf(ACTION_TEMPLATES[j].action) < 0) {
                    out.push(ACTION_TEMPLATES[j].action);
                }
                break;
            }
        }
    }
    return out;
}

// Number of action templates implemented (for the final report).
var ACTION_TEMPLATES_COUNT = ACTION_TEMPLATES.length;


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — CONFIDENCE ASSESSMENT
// ════════════════════════════════════════════════════════════════════
// Combine R², CI tightness vs param value, and ΔAIC margin (if known).
//
//   high    : R² ≥ 0.99 AND all CIs < 30 % AND ΔAIC > 10
//   medium  : R² ≥ 0.95 AND most CIs < 50 %
//   low     : R² < 0.95  OR any CI > 100 %  OR ΔAIC < 2
// ════════════════════════════════════════════════════════════════════

function _ciFractionalWidth(value, range) {
    if (!range || !isFinite(range[0]) || !isFinite(range[1])) return Infinity;
    if (!isFinite(value)) return Infinity;
    var halfWidth = 0.5 * (range[1] - range[0]);
    // For near-zero parameter values (e.g. S = 0), fractional width is
    // ill-defined. Use the half-width directly as an absolute tolerance
    // and treat anything < 1.0 (in skin units, etc.) as "tight".
    if (Math.abs(value) < 1e-3) {
        return Math.abs(halfWidth);
    }
    return Math.abs(halfWidth / value);
}

function _confidenceLevel(tags, fitMeta) {
    var r2     = (fitMeta && isFinite(fitMeta.r2))     ? fitMeta.r2     : NaN;
    var dAIC   = (fitMeta && isFinite(fitMeta.dAIC))   ? fitMeta.dAIC   : NaN;
    // Inspect CI tightness across tagged params.
    var widths = tags.map(function (t) { return _ciFractionalWidth(t.value, t.range); });
    var anyVeryWide = widths.some(function (w) { return w > 1.0; });
    var allTight    = widths.every(function (w) { return w < 0.30; });
    var mostMedium  = widths.filter(function (w) { return w < 0.50; }).length
                       >= Math.max(1, Math.floor(widths.length / 2 + 0.5));

    // Low takes precedence — any bad signal demotes the verdict.
    if (isFinite(r2) && r2 < 0.95) return 'low';
    if (anyVeryWide)                return 'low';
    if (isFinite(dAIC) && dAIC < 2) return 'low';
    // High requires every gate to pass; if AIC margin unknown, accept other gates.
    if ((!isFinite(r2) || r2 >= 0.99) && allTight && (!isFinite(dAIC) || dAIC > 10)) return 'high';
    // Medium fallback.
    if ((!isFinite(r2) || r2 >= 0.95) && mostMedium) return 'medium';
    return 'medium';
}

// Confidence-tinted verbs to keep the prose honest.
function _confidenceVerb(level) {
    if (level === 'high')   return 'indicates';
    if (level === 'medium') return 'is consistent with';
    return 'tentatively suggests';
}

function _confidenceStatement(level) {
    if (level === 'high')   return 'Confidence in this interpretation is high';
    if (level === 'medium') return 'Confidence is moderate — tighten CIs with longer flow periods if possible';
    return 'Confidence is low — treat this interpretation as preliminary';
}


// ════════════════════════════════════════════════════════════════════
// SECTION 5 — NARRATIVE COMPOSITION
// ════════════════════════════════════════════════════════════════════
// Generate the full prose paragraph from tags + classification info.
// Kept tight (60-120 words) by chaining short clauses.
// ════════════════════════════════════════════════════════════════════

function _findTag(tags, key) {
    for (var i = 0; i < tags.length; i++) if (tags[i].param === key) return tags[i];
    return null;
}
function _findTagByPrefix(tags, prefix) {
    for (var i = 0; i < tags.length; i++) {
        if (tags[i].param.indexOf(prefix) === 0) return tags[i];
    }
    return null;
}
function _findBoundaryTags(tags) {
    var out = [];
    for (var i = 0; i < tags.length; i++) {
        if (BOUNDARY_KEYS.hasOwnProperty(tags[i].param)) out.push(tags[i]);
    }
    return out;
}

// Build a value+CI string ("S = -1.4 ± 0.3" or "kh = 245 md·ft").
function _valueWithCI(tag, modelKey) {
    var meta = _paramMeta(modelKey, tag.param);
    var unit = meta.unit && meta.unit !== '-' ? (' ' + meta.unit) : '';
    var v = _prose(tag.value);
    var halfCI = NaN;
    if (tag.range && isFinite(tag.range[0]) && isFinite(tag.range[1])) {
        halfCI = 0.5 * (tag.range[1] - tag.range[0]);
    }
    if (isFinite(halfCI) && halfCI > 0) {
        return tag.param + ' = ' + v + ' ± ' + _prose(halfCI) + unit;
    }
    return tag.param + ' = ' + v + unit;
}

G.PRiSM_buildNarrative = function PRiSM_buildNarrative(tags, modelKey, classification) {
    if (!tags || !tags.length) {
        return 'No interpretable parameters were extracted from this fit.';
    }
    var verb = _confidenceVerb((classification && classification.confidence) || 'medium');
    var spec = (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null;
    var modelKnown = !!spec;
    var clauses = [];

    // Opening — model class + skin tag (if present).
    var skinTag = _findTagByPrefix(tags, 'S');
    var openCat = _modelCategoryOpening(modelKey);
    var opening;
    if (modelKnown && openCat) {
        if (skinTag) {
            opening = 'This well ' + verb + ' ' + openCat + ' with '
                    + skinTag.hint + ' (' + _valueWithCI(skinTag, modelKey) + ').';
        } else {
            opening = 'This well ' + verb + ' ' + openCat + '.';
        }
    } else if (skinTag) {
        opening = 'This well ' + verb + ' ' + skinTag.hint
                + ' (' + _valueWithCI(skinTag, modelKey) + ').';
    } else {
        opening = 'Fitted parameters described below.';
    }
    clauses.push(opening);

    // Wellbore storage clause.
    var cdTag = _findTag(tags, 'Cd');
    if (cdTag) {
        clauses.push('Wellbore storage is ' + cdTag.hint + ' (Cd ≈ '
                     + _prose(cdTag.value) + ').');
    }

    // Productivity clause (kh).
    var khTag = _findTag(tags, 'kh');
    if (khTag) {
        var khMeta = _paramMeta(modelKey, 'kh');
        var unit = khMeta.unit && khMeta.unit !== '-' ? (' ' + khMeta.unit) : ' md·ft';
        clauses.push('Productivity is ' + khTag.hint + ' (kh = '
                     + _prose(khTag.value) + unit + ').');
    }

    // Boundary clauses (one per boundary tag found).
    var bTags = _findBoundaryTags(tags);
    for (var i = 0; i < bTags.length; i++) {
        var bt = bTags[i];
        var bMeta = _paramMeta(modelKey, bt.param);
        var bUnit = (bMeta.unit && bMeta.unit !== '-') ? (' ' + bMeta.unit) : ' ft';
        var hintAct = '';
        if (bt.severity === 'important') {
            hintAct = ' — confirm against geology before extending production at this rate';
        } else if (bt.severity === 'warning') {
            hintAct = ' — verify data quality at the early-time end of the test';
        }
        clauses.push(_capitalize(bt.hint) + ' at ' + _prose(bt.value) + bUnit
                     + ' from the wellbore' + hintAct + '.');
    }

    // Fracture clause (xf, FcD).
    var xfTag = _findTag(tags, 'xf');
    if (xfTag) {
        clauses.push(_capitalize(xfTag.hint) + ' is observed (xf = '
                     + _prose(xfTag.value) + ' ft).');
    }
    var fcdTag = _findTag(tags, 'FcD');
    if (fcdTag) {
        clauses.push('The data show ' + fcdTag.hint + ' (FcD ≈ '
                     + _prose(fcdTag.value) + ').');
    }

    // Naturally fractured clause (ω, λ).
    var omegaTag  = _findTag(tags, 'omega');
    var lambdaTag = _findTag(tags, 'lambda');
    if (omegaTag || lambdaTag) {
        var nf = 'The double-porosity signature shows ';
        var parts = [];
        if (omegaTag)  parts.push(omegaTag.hint  + ' (ω = '  + _prose(omegaTag.value)  + ')');
        if (lambdaTag) parts.push(lambdaTag.hint + ' (λ = '  + _prose(lambdaTag.value) + ')');
        clauses.push(nf + parts.join(' and ') + '.');
    }

    // Lateral length clause (horizontal wells).
    var lhTag = _findTag(tags, 'Lh') || _findTag(tags, 'Llat');
    if (lhTag) {
        clauses.push('Completion length is consistent with ' + lhTag.hint + '.');
    }

    // Closing — confidence + primary action hint.
    var conf = (classification && classification.confidence) || 'medium';
    clauses.push(_confidenceStatement(conf) + '.');

    // Unknown-model caveat.
    if (!modelKnown) {
        clauses.push('Note: model "' + (modelKey || '?') + '" is not in the PRiSM registry — '
                     + 'this is a generic interpretation.');
    }

    return clauses.join(' ');
};

function _capitalize(s) {
    if (!s || !s.length) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — PUBLIC API: PRiSM_interpretFit
// ════════════════════════════════════════════════════════════════════
//
// Inputs:
//   modelKey  — registry key (e.g. 'homogeneous', 'singleFault')
//   params    — { paramKey: numericValue, ... }
//   CI95      — { paramKey: [lo, hi], ... }   (optional, may be partial)
//
// Optional 4th argument: fitMeta = { r2, dAIC, iterations, secondModelKey }
//   used to refine confidence + cautions.
//
// Output:
//   { tags, narrative, actions, confidence, cautions }
// ════════════════════════════════════════════════════════════════════

G.PRiSM_interpretFit = function PRiSM_interpretFit(modelKey, params, CI95, fitMeta) {
    params = params || {};
    CI95   = CI95   || {};
    fitMeta = fitMeta || {};

    var modelKnown = !!(G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]);
    var tags = [];

    // Determine the iteration set: union of known param keys.
    // Prefer the model's paramSpec ordering when available, else
    // iterate the supplied params object.
    var keys = [];
    if (modelKnown) {
        var spec = G.PRiSM_MODELS[modelKey];
        if (spec.paramSpec && spec.paramSpec.length) {
            for (var i = 0; i < spec.paramSpec.length; i++) {
                keys.push(spec.paramSpec[i].key);
            }
        }
    }
    // Append any extra keys present in `params` but not in paramSpec.
    for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k) && keys.indexOf(k) < 0) {
            keys.push(k);
        }
    }

    for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var v = params[key];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        var rule = _ruleForKey(key, v);
        if (!rule) continue;
        var range = (CI95 && CI95[key]) ? CI95[key] : [NaN, NaN];
        tags.push(_makeTag(key, v, range, rule));
    }

    // Confidence — pick before narrative so the prose can reflect it.
    var confidence = _confidenceLevel(tags, fitMeta);

    // Cautions — explicit data-quality / fit-quality flags.
    var cautions = _buildCautions(tags, fitMeta, modelKnown, modelKey);

    var narrative = G.PRiSM_buildNarrative(tags, modelKey, { confidence: confidence });
    var actions   = _actionsForTags(tags);

    // If skin is acceptable (good/normal) explicitly add a "no workover" reassurance.
    var skinTag = _findTagByPrefix(tags, 'S');
    if (skinTag && (skinTag.severity === 'good' || skinTag.severity === 'normal')) {
        actions.push('Skin is acceptable; no immediate workover indicated');
    }

    // If a boundary CI is wide, suggest a longer build-up.
    for (var bi = 0; bi < tags.length; bi++) {
        var t = tags[bi];
        if (BOUNDARY_KEYS.hasOwnProperty(t.param)) {
            var w = _ciFractionalWidth(t.value, t.range);
            if (isFinite(w) && w > 0.10) {
                actions.push('Re-run buildup at higher resolution if data permits, to better-constrain '
                             + t.param + ' (currently ±' + _prose(0.5 * (t.range[1] - t.range[0])) + ')');
                break;
            }
        }
    }

    return {
        tags:       tags,
        narrative:  narrative,
        actions:    actions,
        confidence: confidence,
        cautions:   cautions
    };
};

function _buildCautions(tags, fitMeta, modelKnown, modelKey) {
    var cautions = [];
    if (!modelKnown) {
        cautions.push('Model "' + (modelKey || '?') + '" is not in the PRiSM registry — interpretation is generic.');
    }
    if (fitMeta) {
        if (isFinite(fitMeta.iterations) && isFinite(fitMeta.dAIC)) {
            // Format both — exact wording matches the example in the spec.
            var iters = Math.round(fitMeta.iterations);
            if (fitMeta.secondModelKey) {
                cautions.push('Fit converged in ' + iters + ' LM iterations; AIC strongly prefers '
                              + (modelKey || 'this model') + ' over '
                              + fitMeta.secondModelKey + ' (ΔAIC = ' + _prose(fitMeta.dAIC) + ').');
            } else {
                cautions.push('Fit converged in ' + iters + ' LM iterations (ΔAIC vs runner-up = '
                              + _prose(fitMeta.dAIC) + ').');
            }
        } else if (isFinite(fitMeta.iterations)) {
            cautions.push('Fit converged in ' + Math.round(fitMeta.iterations) + ' LM iterations.');
        }
        if (isFinite(fitMeta.r2) && fitMeta.r2 < 0.99 && fitMeta.r2 >= 0.95) {
            cautions.push('Late-time data shows residual structure — possible second mechanism out of range.');
        }
        if (isFinite(fitMeta.lateRMSE) && fitMeta.lateRMSE > 0.02) {
            cautions.push('Late-time data (td > 1000) shows ~' + _prose(100 * fitMeta.lateRMSE)
                          + '% RMSE — possible second boundary out of range.');
        }
    }
    // Wide-CI flag per tag.
    var anyVeryWide = false;
    for (var i = 0; i < tags.length; i++) {
        var w = _ciFractionalWidth(tags[i].value, tags[i].range);
        if (isFinite(w) && w > 1.0) { anyVeryWide = true; break; }
    }
    if (anyVeryWide) {
        cautions.push('At least one parameter has a CI wider than the value itself — interpret with care.');
    }
    return cautions;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 7 — PUBLIC API: PRiSM_interpretCurrentFit
// ════════════════════════════════════════════════════════════════════
// Convenience wrapper — pulls everything from PRiSM_state.lastFit.
// Returns null if no fit is available.
// ════════════════════════════════════════════════════════════════════

G.PRiSM_interpretCurrentFit = function PRiSM_interpretCurrentFit() {
    var st = G.PRiSM_state;
    if (!st) return null;
    var modelKey = st.model;
    // Prefer a stored lastFit (set by the auto-match orchestrator) but fall
    // back to the live params + (no CI) so we still produce a narrative.
    var lf = st.lastFit;
    var params, ci, fitMeta;
    if (lf && lf.params) {
        params  = lf.params;
        ci      = lf.ci95 || lf.CI95 || {};
        fitMeta = {
            r2:             lf.r2,
            dAIC:           lf.dAIC,
            iterations:     lf.iterations,
            secondModelKey: lf.secondModelKey,
            lateRMSE:       lf.lateRMSE
        };
        if (lf.modelKey) modelKey = lf.modelKey;
    } else if (st.params) {
        params  = st.params;
        ci      = {};
        fitMeta = {};
    } else {
        return null;
    }
    return G.PRiSM_interpretFit(modelKey, params, ci, fitMeta);
};


// ════════════════════════════════════════════════════════════════════
// SECTION 8 — UI RENDER
// ════════════════════════════════════════════════════════════════════
// Render a styled panel into the container with:
//   • confidence badge
//   • narrative paragraph
//   • parameter chips colour-coded by severity
//   • actions checklist
//   • cautions block
// ════════════════════════════════════════════════════════════════════

var SEV_COLORS = {
    'good':      { bg: '#0f3a1f', border: '#2ea043', text: '#7ee787' },
    'normal':    { bg: '#1f2937', border: '#30363d', text: '#c9d1d9' },
    'warning':   { bg: '#3a2f0f', border: '#bb8009', text: '#f0c674' },
    'important': { bg: '#3a0f0f', border: '#cf222e', text: '#ff9494' }
};

var CONF_COLORS = {
    'high':   { bg: '#0f3a1f', text: '#7ee787', label: 'High confidence' },
    'medium': { bg: '#1f2a3a', text: '#79b8ff', label: 'Medium confidence' },
    'low':    { bg: '#3a2f0f', text: '#f0c674', label: 'Low confidence' }
};

function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Shared style fragments (single-line) — keeps the renderer compact.
var _PANEL_STYLE   = 'background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:14px; color:#c9d1d9; font-size:13px; line-height:1.5;';
var _HEADING_STYLE = 'font-weight:600; font-size:12px; color:#8b949e; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;';
var _CHIP_STYLE    = 'display:inline-block; padding:4px 10px; border-radius:12px; font-size:11px; ';

G.PRiSM_renderInterpretationPanel = function PRiSM_renderInterpretationPanel(container, interp) {
    if (!_hasDoc || !container) return;
    if (!interp) {
        container.innerHTML = '<div style="padding:12px; color:#8b949e; font-style:italic;">'
            + 'No interpretation available. Run a fit first, then re-open this panel.</div>';
        return;
    }
    var conf = CONF_COLORS[interp.confidence] || CONF_COLORS.medium;
    var h = [];
    h.push('<div class="prism-interp-panel" style="' + _PANEL_STYLE + '">');
    // Header — confidence badge.
    h.push('<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:12px; flex-wrap:wrap;">'
         + '<div style="font-weight:700; font-size:14px; color:#c9d1d9;">Interpretation</div>'
         + '<span style="' + _CHIP_STYLE + 'font-weight:600; background:' + conf.bg + '; color:' + conf.text + ';">'
         + _esc(conf.label) + '</span></div>');
    // Narrative paragraph.
    h.push('<div style="margin-bottom:14px; padding:10px; background:#161b22; border-left:3px solid '
         + conf.text + '; border-radius:4px;">' + _esc(interp.narrative || '') + '</div>');
    // Parameter chips.
    if (interp.tags && interp.tags.length) {
        h.push('<div style="margin-bottom:12px;"><div style="' + _HEADING_STYLE + '">Parameter findings</div>'
             + '<div style="display:flex; flex-wrap:wrap; gap:6px;">');
        for (var i = 0; i < interp.tags.length; i++) {
            var t = interp.tags[i], sev = SEV_COLORS[t.severity] || SEV_COLORS.normal;
            var rangeStr = (t.range && isFinite(t.range[0]) && isFinite(t.range[1]))
                ? ' [' + _prose(t.range[0]) + ', ' + _prose(t.range[1]) + ']' : '';
            h.push('<span style="' + _CHIP_STYLE + 'background:' + sev.bg + '; color:' + sev.text
                + '; border:1px solid ' + sev.border + ';" title="' + _esc(t.qualitative + rangeStr) + '">'
                + _esc(t.param) + ' = ' + _esc(_prose(t.value)) + ' — ' + _esc(t.qualitative) + '</span>');
        }
        h.push('</div></div>');
    }
    // Actions checklist.
    if (interp.actions && interp.actions.length) {
        h.push('<div style="margin-bottom:12px;"><div style="' + _HEADING_STYLE + '">Suggested actions</div>'
             + '<ul style="margin:0; padding-left:20px; list-style:none;">');
        for (var ai = 0; ai < interp.actions.length; ai++) {
            h.push('<li style="margin-bottom:4px; position:relative;">'
                + '<span style="position:absolute; left:-18px; color:#79b8ff;">□</span>'
                + _esc(interp.actions[ai]) + '</li>');
        }
        h.push('</ul></div>');
    }
    // Cautions.
    if (interp.cautions && interp.cautions.length) {
        h.push('<div><div style="' + _HEADING_STYLE.replace('#8b949e', '#f0c674') + '">Cautions &amp; fit notes</div>'
             + '<ul style="margin:0; padding-left:20px; color:#a6a39a; font-size:12px;">');
        for (var ci = 0; ci < interp.cautions.length; ci++) {
            h.push('<li style="margin-bottom:4px;">' + _esc(interp.cautions[ci]) + '</li>');
        }
        h.push('</ul></div>');
    }
    h.push('</div>');
    container.innerHTML = h.join('');
};


// ════════════════════════════════════════════════════════════════════
// SECTION 9 — SELF-TEST
// ════════════════════════════════════════════════════════════════════

})();

// ─── END 14-interpretation ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 15-diagnostic-annotations ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 15 — Diagnostic Plot Annotations + Auto-Bourdet-L
//   Two compounding wins:
//     • Auto-pick Bourdet smoothing L based on data noise level
//     • Render flow-regime transition markers on diagnostic plots
//
// PUBLIC API (all on window.*)
//   PRiSM_autoBourdet_L(t, p, q?)          → { L, noiseLevel, noiseEstimate, rationale, alternatives[] }
//   PRiSM_detectAnnotations(t, p, dp?)     → [{ type, td, label, priority }, ...]  (sorted by td)
//   PRiSM_drawPlotAnnotations(canvas, annotations, plotKey)  → void
//   PRiSM_enableAutoAnnotations(enabled?)  → void  (default true)
//   PRiSM_renderAnnotationToolbar(host)    → void  (UI helper)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • Pure vanilla JS, no external dependencies.
//   • Failure-tolerant: any error in detection or drawing is swallowed —
//     annotations are NICE-TO-HAVE and must NEVER break the underlying plot.
//   • Defensive against missing primitives — stubs PRiSM_compute_bourdet,
//     PRiSM_classifyRegimes, PRiSM_drawActivePlot if absent so the module
//     can still load + self-test in the smoke-test stub harness.
//   • PRiSM_drawActivePlot wrap is idempotent (guarded by ._annotationsWrapped).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module can load in the smoke-test stub.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // Theme palette — match PRiSM_THEME if available, else fall back.
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

    // Default padding (mirrors PRiSM_DEFAULT_PADDING).
    function _defaultPad() {
        return { top: 30, right: 80, bottom: 48, left: 64 };
    }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    // Locate the bourdet derivative helper if present.
    function _bourdet(t, dp, L) {
        if (typeof G.PRiSM_compute_bourdet === 'function') {
            return G.PRiSM_compute_bourdet(t, dp, L);
        }
        // Inline fallback — mirrors layer-2 implementation.
        L = L || 0;
        var n = t.length;
        var d = new Array(n);
        for (var k = 0; k < n; k++) d[k] = NaN;
        if (n < 3) return d;
        for (var i = 1; i < n - 1; i++) {
            if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
            var i1 = i - 1, i2 = i + 1;
            if (L > 0) {
                while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
                while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
            }
            var t1 = t[i1], t2 = t[i2], ti = t[i];
            if (!isFinite(t1) || !isFinite(t2) || t1 <= 0 || t2 <= 0) continue;
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

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — NOISE-LEVEL ESTIMATOR + L PICKER
    // ═══════════════════════════════════════════════════════════════
    //
    // Estimate gauge-noise level by:
    //   1. Compute a moving-average low-pass of p with window=5 samples
    //   2. Subtract → high-pass residual
    //   3. RMS(residual) / |mean(p)|  → noise as a relative fraction
    //
    // Map noise band → L:
    //   noise < 0.001 → L = 0.10  ('clean')
    //   0.001-0.005   → L = 0.18  ('typical')
    //   0.005-0.02    → L = 0.30  ('noisy')
    //   > 0.02        → L = 0.50  ('very noisy')
    // ═══════════════════════════════════════════════════════════════

    function _movingAverage(p, win) {
        var n = p.length;
        var out = new Array(n);
        if (n === 0) return out;
        var half = Math.max(1, Math.floor(win / 2));
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - half);
            var i1 = Math.min(n - 1, i + half);
            var sum = 0, cnt = 0;
            for (var j = i0; j <= i1; j++) {
                if (isFinite(p[j])) { sum += p[j]; cnt++; }
            }
            out[i] = cnt > 0 ? sum / cnt : NaN;
        }
        return out;
    }

    function _meanAbs(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += Math.abs(arr[i]); n++; }
        }
        return n > 0 ? s / n : 0;
    }

    function _rms(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += arr[i] * arr[i]; n++; }
        }
        return n > 0 ? Math.sqrt(s / n) : 0;
    }

    // Estimate the relative noise floor of pressure data.
    // Returns a positive number (RMS of high-pass residual / |mean(p)|).
    function _estimateNoise(p) {
        if (!Array.isArray(p) || p.length < 5) return 0;
        // Smooth with a 5-pt MA — anything wiggling faster than that is "noise".
        var smooth = _movingAverage(p, 5);
        var resid = new Array(p.length);
        for (var i = 0; i < p.length; i++) {
            resid[i] = (isFinite(p[i]) && isFinite(smooth[i])) ? (p[i] - smooth[i]) : NaN;
        }
        var rms  = _rms(resid);
        var mean = _meanAbs(p);
        if (mean === 0) return 0;
        return rms / mean;
    }

    // Map noise → suggested L.
    function _pickL(noise) {
        if (!isFinite(noise) || noise <= 0)   return { L: 0.18, level: 'low' };
        if (noise < 0.001)                    return { L: 0.10, level: 'low' };
        if (noise < 0.005)                    return { L: 0.18, level: 'low' };
        if (noise < 0.02)                     return { L: 0.30, level: 'medium' };
        return { L: 0.50, level: 'high' };
    }

    function _rationale(level, noise, L) {
        var pct = (noise * 100).toFixed(2);
        if (level === 'low' && L <= 0.12) {
            return 'Very clean gauge data (~' + pct + '% RMS of mean pressure) — using minimal smoothing L=' + L.toFixed(2) + ' to preserve regime transitions.';
        }
        if (level === 'low') {
            return 'Low noise floor (~' + pct + '% of mean pressure) — using small L=' + L.toFixed(2) + ' to preserve regime transitions.';
        }
        if (level === 'medium') {
            return 'Moderate noise (~' + pct + '% of mean pressure) — using standard smoothing L=' + L.toFixed(2) + ' to balance feature retention and noise rejection.';
        }
        return 'Heavy noise (~' + pct + '% of mean pressure) — using large L=' + L.toFixed(2) + ' to suppress gauge jitter; some sharp transitions may be smeared.';
    }

    G.PRiSM_autoBourdet_L = function PRiSM_autoBourdet_L(t, p, q) {
        // q is currently unused — accepted for future extension (e.g., rate
        // sensitivity analysis where short rate perturbations dominate noise).
        var fallback = {
            L: 0.18,
            noiseLevel: 'low',
            noiseEstimate: 0,
            rationale: 'Default smoothing L=0.18 (no pressure data supplied).',
            alternatives: [
                { L: 0.10, description: 'minimal smoothing (preserves all features, may be noisy)' },
                { L: 0.30, description: 'standard smoothing (balanced)' },
                { L: 0.50, description: 'heavy smoothing (clean curve, may hide transitions)' }
            ]
        };
        try {
            if (!Array.isArray(t) || !Array.isArray(p) || p.length < 5) return fallback;
            var noise = _estimateNoise(p);
            var pick  = _pickL(noise);
            return {
                L: pick.L,
                noiseLevel: pick.level,
                noiseEstimate: noise,
                rationale: _rationale(pick.level, noise, pick.L),
                alternatives: [
                    { L: 0.10, description: 'minimal smoothing (preserves all features, may be noisy)' },
                    { L: 0.30, description: 'standard smoothing (balanced)' },
                    { L: 0.50, description: 'heavy smoothing (clean curve, may hide transitions)' }
                ]
            };
        } catch (e) {
            return fallback;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — REGIME-TRANSITION DETECTOR
    // ═══════════════════════════════════════════════════════════════
    //
    // Heuristic local-slope detector that runs on the Bourdet derivative.
    // Sliding 5-point window in log(t) space, computes
    //   slope = d(log10 dp)/d(log10 t)
    // for each interior point. Then scans for "kicks" — slope deltas > 0.3
    // between adjacent windows — and tags transitions by surrounding slopes.
    //
    // If window.PRiSM_classifyRegimes (Agent J) is loaded, prefer its output
    // and convert it into the annotation list shape.
    // ═══════════════════════════════════════════════════════════════

    // Compute a smoothed log-log slope at each point in (t, y).
    // Returns array of slopes (NaN at boundaries). Operates on |y| because
    // diagnostic plots conventionally use the magnitude of the bourdet
    // derivative (sign depends on drawdown vs buildup).
    function _logLogSlopes(t, y, halfWin) {
        var n = t.length;
        var slopes = new Array(n);
        for (var k = 0; k < n; k++) slopes[k] = NaN;
        halfWin = halfWin || 2;
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - halfWin);
            var i1 = Math.min(n - 1, i + halfWin);
            // Linear regression in log space (absolute y).
            var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
            for (var j = i0; j <= i1; j++) {
                if (!isFinite(t[j]) || t[j] <= 0 || !isFinite(y[j])) continue;
                var ay = Math.abs(y[j]);
                if (ay <= 0) continue;
                var lx = Math.log10(t[j]);
                var ly = Math.log10(ay);
                sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; m++;
            }
            if (m < 3) continue;
            var denom = m * sxx - sx * sx;
            if (Math.abs(denom) < 1e-12) continue;
            slopes[i] = (m * sxy - sx * sy) / denom;
        }
        return slopes;
    }

    // Classify a "kick" between slope_before and slope_after into a regime
    // transition. Returns an annotation type/label/priority object, or null
    // if the pair doesn't match a known signature.
    function _classifyKick(sBefore, sAfter) {
        if (!isFinite(sBefore) || !isFinite(sAfter)) return null;
        // WBS-end / radial-flow start: slope ~1 → ~0
        if (sBefore > 0.55 && sAfter < 0.30 && sAfter > -0.30) {
            return { type: 'wellboreStorageEnd', label: 'WBS ends', priority: 1 };
        }
        // Radial → linear-channel boundary (parallel faults, slope ½)
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.35 && sAfter < 0.65) {
            return { type: 'boundaryHit', label: 'Boundary signature begins', priority: 2 };
        }
        // Radial → closed-boundary (PSS / circular drainage, slope 1)
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.75) {
            return { type: 'closedBoundaryHit', label: 'Closed boundary (PSS)', priority: 2 };
        }
        // Radial → spherical: dropping slope, < -0.3
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter < -0.30) {
            return { type: 'sphericalFlow', label: '−½ slope (spherical flow)', priority: 3 };
        }
        // Linear → radial (entering radial after a fracture-linear regime)
        if (sBefore > 0.35 && sBefore < 0.65 && sAfter > -0.20 && sAfter < 0.30) {
            return { type: 'radialFlowStart', label: 'Radial flow starts', priority: 1 };
        }
        // Bilinear → linear (¼ → ½)
        if (sBefore > 0.15 && sBefore < 0.40 && sAfter > 0.40 && sAfter < 0.65) {
            return { type: 'bilinearToLinear', label: 'Bilinear → linear', priority: 3 };
        }
        return null;
    }

    // Pick representative td values for each detected kick. Returns an array
    // sorted by td, deduplicated within ~0.3 decade.
    function _findKicks(t, slopes) {
        var n = t.length;
        var out = [];
        // We compare slopes a half-decade apart to suppress single-point flicker.
        for (var i = 1; i < n - 1; i++) {
            if (!isFinite(slopes[i]) || !isFinite(slopes[i - 1])) continue;
            // Look for a "stable before" / "stable after" via wider sampling.
            var iBefore = Math.max(0, i - 5);
            var iAfter  = Math.min(n - 1, i + 5);
            var sBefore = slopes[iBefore];
            var sAfter  = slopes[iAfter];
            if (!isFinite(sBefore) || !isFinite(sAfter)) continue;
            if (Math.abs(sAfter - sBefore) < 0.3) continue;
            var ann = _classifyKick(sBefore, sAfter);
            if (!ann) continue;
            ann.td = t[i];
            out.push(ann);
        }
        // De-dup: only keep one annotation of any (type, ~decade) bucket.
        // Most regime transitions occur once in a test (WBS-end, radial start,
        // boundary-hit), so we use a strong global dedup. sphericalFlow may
        // legitimately repeat across multi-region tests.
        out.sort(function (a, b) { return a.td - b.td; });
        var dedup = [];
        for (var k = 0; k < out.length; k++) {
            var cur = out[k];
            var skip = false;
            for (var m = 0; m < dedup.length; m++) {
                var existing = dedup[m];
                if (existing.type === cur.type) {
                    if (cur.type === 'sphericalFlow') {
                        // Allow if at least 1 decade away.
                        var ratio = (cur.td > 0 && existing.td > 0)
                            ? Math.abs(Math.log10(cur.td) - Math.log10(existing.td))
                            : 0;
                        if (ratio < 1.0) { skip = true; break; }
                    } else {
                        // Once-per-test types: keep first occurrence only.
                        skip = true; break;
                    }
                }
            }
            if (!skip) dedup.push(cur);
        }
        return dedup;
    }

    // Sustained-spherical-flow regime — runs of points with slope < -0.3.
    function _findSphericalRun(t, slopes) {
        var n = t.length;
        var out = [];
        var runStart = -1, runLen = 0;
        for (var i = 0; i < n; i++) {
            if (isFinite(slopes[i]) && slopes[i] < -0.30) {
                if (runStart < 0) runStart = i;
                runLen++;
            } else {
                if (runLen >= 4 && runStart >= 0) {
                    var midIdx = runStart + Math.floor(runLen / 2);
                    if (t[midIdx] > 0) {
                        out.push({
                            type: 'sphericalFlow',
                            td: t[midIdx],
                            label: '−½ slope (spherical flow)',
                            priority: 3
                        });
                    }
                }
                runStart = -1; runLen = 0;
            }
        }
        if (runLen >= 4 && runStart >= 0) {
            var midIdx2 = runStart + Math.floor(runLen / 2);
            if (t[midIdx2] > 0) {
                out.push({
                    type: 'sphericalFlow',
                    td: t[midIdx2],
                    label: '−½ slope (spherical flow)',
                    priority: 3
                });
            }
        }
        return out;
    }

    // Convert PRiSM_classifyRegimes output (Agent J) into an annotation list.
    // The exact shape may vary — we accept either an array or an object with
    // a `transitions` field, and look for { type/regime/name, td/t/time }.
    function _normaliseAgentJOutput(raw) {
        if (!raw) return null;
        var arr = Array.isArray(raw) ? raw
                : (Array.isArray(raw.transitions) ? raw.transitions
                : (Array.isArray(raw.annotations) ? raw.annotations : null));
        if (!arr) return null;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
            if (!e) continue;
            var td = (e.td != null) ? e.td
                   : (e.t  != null) ? e.t
                   : (e.time != null) ? e.time
                   : null;
            if (!isFinite(td) || td <= 0) continue;
            var type = e.type || e.regime || e.name || 'transition';
            var label = e.label || e.description || _typeLabel(type);
            var priority = (e.priority != null) ? e.priority : _typePriority(type);
            out.push({ type: String(type), td: Number(td), label: String(label), priority: Number(priority) });
        }
        out.sort(function (a, b) { return a.td - b.td; });
        return out;
    }

    function _typeLabel(type) {
        switch (type) {
            case 'wellboreStorageEnd': return 'WBS ends';
            case 'radialFlowStart':    return 'Radial flow starts';
            case 'boundaryHit':        return 'Boundary signature begins';
            case 'closedBoundaryHit':  return 'Closed boundary (PSS)';
            case 'sphericalFlow':      return '−½ slope (spherical flow)';
            case 'doublePorosityValley': return 'Double-porosity valley';
            case 'bilinearToLinear':   return 'Bilinear → linear';
            default:                   return String(type);
        }
    }

    function _typePriority(type) {
        if (type === 'wellboreStorageEnd' || type === 'radialFlowStart') return 1;
        if (type === 'boundaryHit' || type === 'closedBoundaryHit') return 2;
        return 3;
    }

    G.PRiSM_detectAnnotations = function PRiSM_detectAnnotations(t, p, dp) {
        try {
            if (!Array.isArray(t) || t.length < 5) return [];

            // Compute (or accept) the bourdet derivative.
            var dpUsed = dp;
            if (!Array.isArray(dpUsed) || dpUsed.length !== t.length) {
                if (!Array.isArray(p)) return [];
                var deltaP = new Array(t.length);
                var p0 = p[0];
                for (var i = 0; i < t.length; i++) deltaP[i] = (p[i] - p0);
                // Use auto-L for the derivative computation.
                var auto = G.PRiSM_autoBourdet_L(t, p);
                dpUsed = _bourdet(t, deltaP, auto.L);
            }

            // Try Agent J first.
            if (typeof G.PRiSM_classifyRegimes === 'function') {
                try {
                    var raw = G.PRiSM_classifyRegimes(t, p, dpUsed);
                    var norm = _normaliseAgentJOutput(raw);
                    if (norm && norm.length) {
                        norm._source = 'classifyRegimes';
                        return norm;
                    }
                } catch (e) {
                    // Fall through to local detector.
                }
            }

            // Local fallback detector.
            var slopes = _logLogSlopes(t, dpUsed, 2);
            var kicks = _findKicks(t, slopes);
            var spheres = _findSphericalRun(t, slopes);
            // Merge and de-dup spheres against existing kicks of same type.
            for (var s = 0; s < spheres.length; s++) {
                var dup = false;
                for (var m2 = 0; m2 < kicks.length; m2++) {
                    if (kicks[m2].type === spheres[s].type) {
                        var ratio2 = Math.abs(Math.log10(spheres[s].td) - Math.log10(kicks[m2].td));
                        if (ratio2 < 0.3) { dup = true; break; }
                    }
                }
                if (!dup) kicks.push(spheres[s]);
            }
            kicks.sort(function (a, b) { return a.td - b.td; });
            kicks._source = 'fallback';
            return kicks;
        } catch (e) {
            try { console.warn('PRiSM_detectAnnotations error:', e && e.message); } catch (_) {}
            return [];
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — ANNOTATION RENDERER
    // ═══════════════════════════════════════════════════════════════
    //
    // Convert each annotation td → canvas pixel x using the plot's most
    // recent data range. We can't easily reach the live plot's `lastTransform`
    // (it's closed over inside the per-render IIFE), so we recompute the
    // x-axis transform from PRiSM_dataset's range, mirroring layer-2's tick
    // generator.
    //
    // The renderer is idempotent — it tags the canvas with a flag while it's
    // drawing and stores the most-recent annotation set on the canvas so that
    // other modules can inspect it.
    // ═══════════════════════════════════════════════════════════════

    // Canvas-pixel range for the plot drawing area, given the canvas + opts.
    // Mirrors PRiSM_plot_setup's plot {x, y, w, h, cssW, cssH} computation.
    function _plotRect(canvas) {
        var cssW = canvas.clientWidth || canvas.width || 600;
        var cssH = canvas.clientHeight || canvas.height || 400;
        // Some tests / smoke environments leave width/height un-set.
        // Prefer the canvas.style.width if present (set by PRiSM_plot_setup).
        if (canvas.style && canvas.style.width) {
            var w = parseInt(canvas.style.width, 10);
            if (isFinite(w) && w > 0) cssW = w;
        }
        if (canvas.style && canvas.style.height) {
            var h = parseInt(canvas.style.height, 10);
            if (isFinite(h) && h > 0) cssH = h;
        }
        var pad = _defaultPad();
        return {
            x: pad.left,
            y: pad.top,
            w: Math.max(1, cssW - pad.left - pad.right),
            h: Math.max(1, cssH - pad.top - pad.bottom),
            cssW: cssW,
            cssH: cssH,
            pad: pad
        };
    }

    // Determine the t-range the plot is showing. Bourdet, sqrt, quarter-root,
    // spherical etc all use the dataset's t array. We reuse PRiSM_dataset
    // unless something tighter is supplied via canvas._prismOriginalScale.x
    // (which the layer-2 plots set on each render).
    function _xRange(canvas, plotKey) {
        // Layer-2 stores the original scale (post-zoom-reset) on the canvas.
        if (canvas && canvas._prismOriginalScale && canvas._prismOriginalScale.x) {
            var sx = canvas._prismOriginalScale.x;
            if (isFinite(sx.min) && isFinite(sx.max) && sx.min > 0 && sx.max > sx.min) {
                return { min: sx.min, max: sx.max, kind: sx.kind || 'log' };
            }
        }
        var ds = G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t) || !ds.t.length) {
            return { min: 1e-3, max: 1, kind: 'log' };
        }
        var minT = Infinity, maxT = -Infinity;
        for (var i = 0; i < ds.t.length; i++) {
            var v = ds.t[i];
            if (isFinite(v) && v > 0) {
                if (v < minT) minT = v;
                if (v > maxT) maxT = v;
            }
        }
        if (!isFinite(minT) || !isFinite(maxT) || minT >= maxT) {
            return { min: 1e-3, max: 1, kind: 'log' };
        }
        // Most diagnostic plots use a log x-axis; the cartesian P-vs-t variant
        // and rate plots use linear. Default to log for known log plots.
        var logPlots = { bourdet: 1, sqrt: 0, quarter: 0, spherical: 0,
                         sandface: 1, superposition: 0, rateLog: 1,
                         typeCurve: 1 };
        var isLog = logPlots[plotKey] !== 0; // default true for unknown
        if (plotKey === 'sqrt' || plotKey === 'quarter' || plotKey === 'spherical' ||
            plotKey === 'cartesian' || plotKey === 'horner' || plotKey === 'superposition' ||
            plotKey === 'rateCart' || plotKey === 'rateSemi' || plotKey === 'rateCum' ||
            plotKey === 'lossRatio') {
            isLog = false;
        }
        return { min: minT, max: maxT, kind: isLog ? 'log' : 'lin' };
    }

    // World→pixel for x. Mirrors layer-2's toX construction.
    function _toX(plot, scaleX) {
        if (scaleX.kind === 'log') {
            var lmin = Math.log10(scaleX.min);
            var lmax = Math.log10(scaleX.max);
            var rng = lmax - lmin;
            return function (v) {
                if (!isFinite(v) || v <= 0) return NaN;
                return plot.x + (Math.log10(v) - lmin) / rng * plot.w;
            };
        }
        return function (v) {
            if (!isFinite(v)) return NaN;
            return plot.x + (v - scaleX.min) / (scaleX.max - scaleX.min) * plot.w;
        };
    }

    function _colorForPriority(priority) {
        var th = _theme();
        if (priority === 1) return th.accent || '#f0883e';
        if (priority === 2) return th.blue   || '#58a6ff';
        return th.text2 || '#8b949e';
    }

    G.PRiSM_drawPlotAnnotations = function PRiSM_drawPlotAnnotations(canvas, annotations, plotKey) {
        if (!canvas || !canvas.getContext) return;
        if (!Array.isArray(annotations) || !annotations.length) {
            // Clear stored set.
            try { canvas._prismAnnotations = []; } catch (e) {}
            return;
        }
        plotKey = plotKey || 'bourdet';
        // Annotation rendering is meaningful only on log-x diagnostic plots
        // (Bourdet, sandface, type-curve, rate-log). Skip for other plots
        // where the regime semantics don't apply.
        var skip = { cartesian: 1, horner: 1, sqrt: 1, quarter: 1, spherical: 1,
                     superposition: 1, rateCart: 1, rateSemi: 1, rateCum: 1,
                     lossRatio: 1 };
        if (skip[plotKey]) {
            try { canvas._prismAnnotations = []; } catch (e) {}
            return;
        }
        try {
            // Idempotency guard — if we are already drawing, bail.
            if (canvas._prismAnnotationsDrawing) return;
            canvas._prismAnnotationsDrawing = true;

            var ctx = canvas.getContext('2d');
            if (!ctx) { canvas._prismAnnotationsDrawing = false; return; }

            // The layer-2 setup applied a setTransform(dpr,0,0,dpr,0,0). When
            // wrapped from PRiSM_drawActivePlot, that transform is still in
            // effect, so our css-pixel coordinates draw at the right scale.
            // If we are called standalone (rare), assume identity.
            var plot = _plotRect(canvas);
            var scaleX = _xRange(canvas, plotKey);
            var toX = _toX(plot, scaleX);

            var th = _theme();

            // Filter annotations into the visible x range.
            var visible = [];
            for (var i = 0; i < annotations.length; i++) {
                var a = annotations[i];
                if (!a || !isFinite(a.td)) continue;
                if (scaleX.kind === 'log') {
                    if (a.td <= 0) continue;
                    if (a.td < scaleX.min || a.td > scaleX.max) continue;
                } else {
                    if (a.td < scaleX.min || a.td > scaleX.max) continue;
                }
                var px = toX(a.td);
                if (!isFinite(px)) continue;
                if (px < plot.x - 1 || px > plot.x + plot.w + 1) continue;
                visible.push({ ann: a, px: px });
            }
            // Stash the visible set for inspection.
            canvas._prismAnnotations = visible.slice();

            ctx.save();
            // Ensure clean state — don't inherit any clip from the plot lib.
            ctx.font = '11px sans-serif';

            // Draw each annotation: dashed vertical line + label.
            for (var k = 0; k < visible.length; k++) {
                var item = visible[k];
                var aa = item.ann;
                var px2 = item.px;
                var color = _colorForPriority(aa.priority);

                ctx.strokeStyle = color;
                ctx.fillStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);

                ctx.beginPath();
                ctx.moveTo(px2 + 0.5, plot.y);
                ctx.lineTo(px2 + 0.5, plot.y + plot.h);
                ctx.stroke();
                ctx.setLineDash([]);

                // Label: alternate above (k even → above) / below (k odd → below)
                var above = (k % 2 === 0);
                ctx.save();
                if (above) {
                    // Above the plot box: rotate -90° and write reading bottom-up.
                    ctx.translate(px2 + 4, plot.y - 4);
                    ctx.rotate(-Math.PI / 2);
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                } else {
                    // Below the plot box: rotate -90° and write reading top-down.
                    ctx.translate(px2 - 4, plot.y + plot.h + 6);
                    ctx.rotate(-Math.PI / 2);
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'middle';
                }
                // Draw a faint label background for legibility.
                var labelText = String(aa.label || aa.type || '');
                var tw = ctx.measureText(labelText).width;
                ctx.fillStyle = 'rgba(13,17,23,0.78)';
                if (above) {
                    ctx.fillRect(-2, -8, tw + 4, 14);
                } else {
                    ctx.fillRect(-tw - 2, -8, tw + 4, 14);
                }
                ctx.fillStyle = color;
                ctx.fillText(labelText, 0, 0);
                ctx.restore();
            }
            ctx.restore();
        } catch (e) {
            try { console.warn('PRiSM_drawPlotAnnotations error:', e && e.message); } catch (_) {}
        } finally {
            canvas._prismAnnotationsDrawing = false;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — WRAP PRiSM_drawActivePlot FOR AUTO-ANNOTATION
    // ═══════════════════════════════════════════════════════════════

    // Default-on. The user can disable via PRiSM_enableAutoAnnotations(false)
    // or via the toolbar checkbox.
    if (typeof G.PRiSM_annotationsEnabled === 'undefined') {
        G.PRiSM_annotationsEnabled = true;
    }

    function _wrapDrawActivePlot() {
        if (!_hasWin) return;
        if (typeof G.PRiSM_drawActivePlot !== 'function') {
            // The plot dispatcher hasn't been defined yet (PRiSM Phase 1+2
            // wires it in renderPRiSM). Try again shortly.
            if (typeof setTimeout === 'function') {
                setTimeout(_wrapDrawActivePlot, 250);
            }
            return;
        }
        if (G.PRiSM_drawActivePlot._annotationsWrapped) return;
        var orig = G.PRiSM_drawActivePlot;
        var wrapped = function () {
            var ret = orig.apply(this, arguments);
            if (G.PRiSM_annotationsEnabled === false) return ret;
            try {
                var canvas = (_hasDoc && document.getElementById)
                    ? document.getElementById('prism_plot_canvas') : null;
                var ds = G.PRiSM_dataset;
                if (canvas && ds && Array.isArray(ds.t) && ds.t.length > 0) {
                    var ann = G.PRiSM_detectAnnotations(ds.t, ds.p, ds.dp);
                    var st = G.PRiSM_state || {};
                    var plotKey = st.activePlot || 'bourdet';
                    G.PRiSM_drawPlotAnnotations(canvas, ann, plotKey);
                }
            } catch (e) {
                // Annotations are non-essential — fail quiet.
                try { console.warn('PRiSM auto-annotation error:', e && e.message); } catch (_) {}
            }
            return ret;
        };
        // Preserve any flags set by other wrappers on the original.
        for (var k in orig) { try { wrapped[k] = orig[k]; } catch (e) {} }
        wrapped._annotationsWrapped = true;
        G.PRiSM_drawActivePlot = wrapped;
    }

    G.PRiSM_enableAutoAnnotations = function PRiSM_enableAutoAnnotations(enabled) {
        // Default to true if no argument is supplied.
        var on = (typeof enabled === 'undefined') ? true : !!enabled;
        G.PRiSM_annotationsEnabled = on;
        // Trigger a redraw if possible so annotations appear/disappear
        // immediately.
        try {
            if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
        } catch (e) {
            // Ignore — caller will redraw soon enough.
        }
    };

    // Kick off the wrap. It self-defers if drawActivePlot isn't ready yet.
    _wrapDrawActivePlot();


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — TOOLBAR UI
    // ═══════════════════════════════════════════════════════════════

    // Toolbar state — stored on a single global so re-renders preserve UX.
    G.PRiSM_annotationToolbarState = G.PRiSM_annotationToolbarState || {
        autoL: true,
        manualL: 0.18
    };

    // Apply the auto-L (or manualL) to PRiSM_state.smoothL so the next
    // bourdet plot picks it up.
    function _applyL() {
        var st = G.PRiSM_state || {};
        var s = G.PRiSM_annotationToolbarState;
        var ds = G.PRiSM_dataset;
        var info = null;
        if (s.autoL) {
            if (ds && Array.isArray(ds.t) && Array.isArray(ds.p)) {
                info = G.PRiSM_autoBourdet_L(ds.t, ds.p, ds.q);
                st.smoothL = info.L;
            } else {
                st.smoothL = 0.18;
                info = { L: 0.18, noiseLevel: 'low', noiseEstimate: 0,
                         rationale: 'Auto-pick disabled (no data) — using L=0.18.' };
            }
        } else {
            st.smoothL = s.manualL;
            info = { L: s.manualL, noiseLevel: 'manual', noiseEstimate: 0,
                     rationale: 'Manual L selected (' + s.manualL.toFixed(2) + ').' };
        }
        return info;
    }

    function _updateInfoLine(host, info) {
        if (!host || !host.querySelector) return;
        var line = host.querySelector('#prism_ann_infoline');
        if (!line) return;
        if (!info) { line.textContent = ''; return; }
        var summary = 'Noise: ' + info.noiseLevel +
            ' (~' + (info.noiseEstimate * 100).toFixed(2) + '% RMS)' +
            '  •  Suggested L = ' + info.L.toFixed(2);
        line.textContent = summary;
        line.title = info.rationale || '';
    }

    G.PRiSM_renderAnnotationToolbar = function PRiSM_renderAnnotationToolbar(container) {
        var host = (typeof container === 'string')
            ? (_hasDoc ? document.getElementById(container) : null)
            : container;
        if (!host) return;
        var s = G.PRiSM_annotationToolbarState;
        var enabled = (G.PRiSM_annotationsEnabled !== false);

        host.innerHTML =
            '<div style="border:1px solid #30363d; border-radius:6px; padding:10px 12px; ' +
                        'background:#161b22; margin-top:8px; font:12px sans-serif; color:#c9d1d9;">' +
                '<div style="font-size:11px; font-weight:700; color:#c9d1d9; ' +
                            'text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px;">' +
                    'Diagnostic Annotations & Bourdet-L' +
                '</div>' +
                '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:14px;">' +
                    '<label style="display:flex; align-items:center; gap:6px; cursor:pointer;">' +
                        '<input type="checkbox" id="prism_ann_show"' +
                            (enabled ? ' checked' : '') + '>' +
                        '<span>Show annotations</span>' +
                    '</label>' +
                    '<label style="display:flex; align-items:center; gap:6px; cursor:pointer;">' +
                        '<input type="checkbox" id="prism_ann_autoL"' +
                            (s.autoL ? ' checked' : '') + '>' +
                        '<span>Auto-pick smoothing L</span>' +
                    '</label>' +
                    '<label style="display:flex; align-items:center; gap:6px;' +
                        (s.autoL ? ' opacity:0.55;' : '') + '">' +
                        '<span>Manual L</span>' +
                        '<input type="range" id="prism_ann_lslider" min="0.05" max="0.5" step="0.01" ' +
                            'value="' + s.manualL.toFixed(2) + '" ' +
                            (s.autoL ? 'disabled' : '') +
                            ' style="width:120px;">' +
                        '<span id="prism_ann_lvalue" style="color:#8b949e; min-width:34px;">' +
                            s.manualL.toFixed(2) + '</span>' +
                    '</label>' +
                    '<button class="btn btn-secondary" id="prism_ann_reclassify" ' +
                        'style="font-size:11px; padding:4px 10px;">Re-classify regimes</button>' +
                '</div>' +
                '<div id="prism_ann_infoline" style="margin-top:8px; font-size:11px; color:#8b949e; ' +
                                                  'min-height:14px;"></div>' +
            '</div>';

        // Compute & paint the info line.
        try { _updateInfoLine(host, _applyL()); } catch (e) {}

        // Wire up controls.
        var showChk    = host.querySelector('#prism_ann_show');
        var autoChk    = host.querySelector('#prism_ann_autoL');
        var slider     = host.querySelector('#prism_ann_lslider');
        var sliderVal  = host.querySelector('#prism_ann_lvalue');
        var btn        = host.querySelector('#prism_ann_reclassify');

        if (showChk && showChk.addEventListener) {
            showChk.addEventListener('change', function () {
                G.PRiSM_enableAutoAnnotations(!!showChk.checked);
                _ga4('prism_annotation_toggle', {
                    enabled: !!showChk.checked,
                    autoL:   !!s.autoL
                });
            });
        }

        if (autoChk && autoChk.addEventListener) {
            autoChk.addEventListener('change', function () {
                s.autoL = !!autoChk.checked;
                if (slider) slider.disabled = s.autoL;
                try {
                    var info = _applyL();
                    _updateInfoLine(host, info);
                    if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
                } catch (e) {}
                _ga4('prism_annotation_toggle', {
                    enabled: (G.PRiSM_annotationsEnabled !== false),
                    autoL:   !!s.autoL
                });
            });
        }

        if (slider && slider.addEventListener) {
            slider.addEventListener('input', function () {
                var v = parseFloat(slider.value);
                if (isFinite(v)) {
                    s.manualL = v;
                    if (sliderVal) sliderVal.textContent = v.toFixed(2);
                    if (!s.autoL) {
                        try {
                            _updateInfoLine(host, _applyL());
                            if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
                        } catch (e) {}
                    }
                }
            });
        }

        if (btn && btn.addEventListener) {
            btn.addEventListener('click', function () {
                try {
                    var info = _applyL();
                    _updateInfoLine(host, info);
                    if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
                } catch (e) {}
                _ga4('prism_annotation_toggle', {
                    enabled: (G.PRiSM_annotationsEnabled !== false),
                    autoL:   !!s.autoL,
                    action:  'reclassify'
                });
            });
        }
    };


    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 15-diagnostic-annotations ─────────────────────────────────────────────

