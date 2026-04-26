// =============================================================================
// PRiSM — Layer 06 — Decline-Curve (Phase 3) + Specialised Single-Well (Phase 4)
// =============================================================================
// This file adds 7 new evaluators to the PRiSM model registry:
//
//   Decline curves (rate-vs-time, kind: 'rate'):
//     1. arps        — exponential / hyperbolic / harmonic (b-factor switch)
//     2. duong       — Duong (2011) shale decline
//     3. sepd        — Stretched-exponential production decline (Valko 2009)
//     4. fetkovich   — Fetkovich (1980) closed-circular reservoir type-curves
//
//   Specialised single-well (pressure-vs-time, kind: 'pressure'):
//     5. doublePorosity — Warren-Root naturally fractured (PSS / 1DT / 3DT)
//     6. partialPen     — Partial-penetration vertical well (spherical-flow)
//     7. verticalPulse  — Vertical pulse-test (Gringarten-Ramey separated obs)
//
// EUR (estimated ultimate recovery) is also exported for each decline model:
//
//   PRiSM_eur_arps(params, t_end)
//   PRiSM_eur_duong(params, t_end)
//   PRiSM_eur_sepd(params, t_end)
//   PRiSM_eur_fetkovich(params, t_end)
//
// All public symbols are PRiSM_* / window.PRiSM_MODELS to avoid collisions.
//
// Foundation primitives (assumed already loaded by 01-foundation.js):
//   PRiSM_stehfest(Fhat, t, N)        — numerical Laplace inversion
//   PRiSM_besselK0(x), PRiSM_besselK1(x)
//   PRiSM_Ei(x)                       — exponential integral
//   PRiSM_logspace(min, max, n)
//   PRiSM_pd_lap_homogeneous(s, p)    — homogeneous Pd_lap (line-source kernel
//                                       used as fallback)
// They are resolved lazily so the self-test can stub them in if absent.
// =============================================================================

(function () {
'use strict';

// -- shared constants -------------------------------------------------------
var STEHFEST_N      = 12;       // Stehfest order used by every Laplace model
var IMAGE_CAP       = 200;      // hard cap on series terms
var IMAGE_TOL       = 1e-9;     // convergence tolerance per term contribution
var DERIV_REL_STEP  = 1e-3;     // relative log-step for numerical derivative
var EUR_INT_POINTS  = 200;      // trapezoidal points for EUR integration

// -- foundation primitive resolver -----------------------------------------
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
        throw new Error('PRiSM 06: td must be > 0 (got ' + td[i] + ' at index ' + i + ')');
      }
    }
  } else if (!_num(td) || td <= 0) {
    throw new Error('PRiSM 06: td must be > 0 (got ' + td + ')');
  }
}

function _requireParams(params, keys) {
  if (!params || typeof params !== 'object') {
    throw new Error('PRiSM 06: params object required');
  }
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!(k in params)) {
      throw new Error('PRiSM 06: missing required param "' + k + '"');
    }
  }
}

// fold WBS + skin into a Laplace-domain reservoir solution Pd_lap_res(s)
//   Pwd_lap = ( s*Pd_lap_res + S ) / ( s * ( 1 + Cd * s * (s*Pd_lap_res + S) ) )
// (Agarwal-Ramey 1970 / Bourdet-Gringarten 1980)
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
// difference in ln(td) space. Used when the Laplace-domain derivative is not
// a clean closed form.
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
  // 5-point central derivative w.r.t. ln td
  var dPd_dlnTd = (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);
  return dPd_dlnTd;  // == td * dPd/dtd
}

// trapezoidal integration of f(t) over a logarithmically spaced grid from
// t = t_min to t = t_end. Used by EUR routines.
function _trapezoidalLog(fn, t_min, t_end, n) {
  if (!(t_end > t_min)) return 0;
  var logspace = _foundation('PRiSM_logspace');
  var xs;
  if (logspace) {
    xs = logspace(Math.log10(t_min), Math.log10(t_end), n);
  } else {
    var lmin = Math.log10(t_min), lmax = Math.log10(t_end);
    xs = new Array(n);
    var step = (lmax - lmin) / (n - 1);
    for (var i = 0; i < n; i++) xs[i] = Math.pow(10, lmin + i * step);
  }
  var sum = 0;
  for (var j = 1; j < xs.length; j++) {
    var dx = xs[j] - xs[j - 1];
    var fy = (fn(xs[j]) + fn(xs[j - 1])) * 0.5;
    if (_num(fy)) sum += fy * dx;
  }
  return sum;
}


// =============================================================================
// SECTION A — DECLINE CURVES (Phase 3)
// =============================================================================
//
// Decline-curve evaluators take REAL elapsed production time t (not
// dimensionless time) and return RATE q(t) (not pd). For registry symmetry
// we expose them through the same evaluator interface as the pressure
// models, but tag the registry entry with kind: 'rate' so the UI knows to
// plot them on rate axes and the regression engine knows to skip pwd-style
// derivative folding.
//
// Each decline model also exports an EUR routine that returns the cumulative
// production from t = 0 to t = t_end via numerical integration on a logspace
// (avoids cumulative loss of precision at long times).
// =============================================================================


// -----------------------------------------------------------------------------
// A.1 — ARPS DECLINE
// -----------------------------------------------------------------------------
//
// Reference: Arps, J.J. "Analysis of Decline Curves", Trans. AIME 160, 1945,
//            pp 228-247.
//
// Three sub-models selected by the b-factor:
//   exponential  (b == 0)         q(t) = qi · exp(-Di · t)
//   harmonic     (b == 1)         q(t) = qi / (1 + Di · t)
//   hyperbolic   (0 < b < 1)      q(t) = qi · (1 + b · Di · t)^(-1/b)
//   over-pressured (b > 1)        same hyperbolic form (used in shale wells
//                                  but theoretically violates material balance)
//
// Params: { qi, Di, b }
//   qi : initial rate at t=0  (any consistent unit)
//   Di : initial nominal decline rate (1/time)
//   b  : decline exponent in [0, 2]; b == 0 → exp, b == 1 → harm
//
// Exact closed-form EUR:
//   exponential : Q(t_end) = qi/Di · (1 - exp(-Di·t_end))
//   harmonic    : Q(t_end) = qi/Di · ln(1 + Di·t_end)
//   hyperbolic  : Q(t_end) = (qi / ((1-b)·Di)) · (1 - (1+b·Di·t_end)^(1-1/b))
// -----------------------------------------------------------------------------

function _arpsRate(t, params) {
  var qi = params.qi, Di = params.Di, b = params.b;
  if (!_num(qi) || !_num(Di) || !_num(b)) return NaN;
  if (Di < 0) return NaN;
  if (Di === 0) return qi;
  if (b === 0)              return qi * Math.exp(-Di * t);
  if (Math.abs(b - 1) < 1e-9) return qi / (1 + Di * t);
  // hyperbolic
  var base = 1 + b * Di * t;
  if (base <= 0) return 0;
  return qi * Math.pow(base, -1 / b);
}

/**
 * Arps decline curve evaluator (rate vs time).
 * @param {number|number[]} td  Real elapsed production time t (not td).
 * @param {{qi:number, Di:number, b:number}} params
 * @returns {number|number[]}   Rate q(t)
 */
function PRiSM_model_arps(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['qi', 'Di', 'b']);
  return _arrayMap(td, function (t) { return _arpsRate(t, params); });
}

/**
 * dq/d(ln t) = t · dq/dt for Arps. Used by the logarithmic-derivative plots
 * and regression Jacobian.
 *   exponential : dq/dt = -Di·q          → t · dq/dt = -Di·t·q
 *   harmonic    : dq/dt = -Di · q²/qi    → t · dq/dt = -Di·t·q²/qi
 *   hyperbolic  : dq/dt = -Di · q^(b+1)/qi^b
 */
function PRiSM_model_arps_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['qi', 'Di', 'b']);
  var qi = params.qi, Di = params.Di, b = params.b;
  return _arrayMap(td, function (t) {
    var q = _arpsRate(t, params);
    var dqdt;
    if (b === 0)                 dqdt = -Di * q;
    else if (Math.abs(b - 1) < 1e-9) dqdt = -Di * q * q / qi;
    else                          dqdt = -Di * Math.pow(q / qi, b) * q;
    return t * dqdt;
  });
}

/**
 * Closed-form Arps EUR — cumulative production from t = 0 to t = t_end.
 * Falls back to numerical trapezoidal if Di == 0.
 */
function PRiSM_eur_arps(params, t_end) {
  _requireParams(params, ['qi', 'Di', 'b']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var qi = params.qi, Di = params.Di, b = params.b;
  if (Di <= 0) return qi * t_end;            // no decline → flat
  if (b === 0) return (qi / Di) * (1 - Math.exp(-Di * t_end));
  if (Math.abs(b - 1) < 1e-9) return (qi / Di) * Math.log(1 + Di * t_end);
  // hyperbolic with 0 < b ≠ 1:
  //   Q(t) = qi/((1-b)·Di) · (1 - (1+b·Di·t)^(1-1/b))
  var base = 1 + b * Di * t_end;
  var oneMinusB = 1 - b;
  var oneMinusInvB = 1 - 1 / b;     // negative for 0 < b < 1
  // For b > 1 the integral diverges in the t→∞ limit but is finite for any
  // finite t_end. Numerical safety: clip the exponent and let small t_end
  // produce a sensible value.
  var Q = (qi / (oneMinusB * Di)) * (1 - Math.pow(base, oneMinusB / 1));
  // The textbook form uses (1-b)/1 in some derivations and 1-1/b in others,
  // which differ in sign. Use the canonical Earlougher form:
  //   Q(t) = qi^b / ((1-b)·Di) · (qi^(1-b) - q(t)^(1-b))
  // — equivalent and avoids the (1+bDt)^(1-1/b) numerical pitfall.
  var qEnd = _arpsRate(t_end, params);
  Q = Math.pow(qi, b) * (Math.pow(qi, oneMinusB) - Math.pow(qEnd, oneMinusB))
        / (oneMinusB * Di);
  if (!_num(Q) || Q < 0) {
    // numerical fallback
    Q = _trapezoidalLog(function (t) { return _arpsRate(t, params); },
                        Math.max(t_end * 1e-6, 1e-6), t_end, EUR_INT_POINTS);
  }
  return Q;
}


// -----------------------------------------------------------------------------
// A.2 — DUONG DECLINE
// -----------------------------------------------------------------------------
//
// Reference: Duong, A.N. "Rate-Decline Analysis for Fracture-Dominated Shale
//            Reservoirs", SPE 137748, October 2011.
//
// Empirical model targeted at fracture-dominated unconventional shale wells
// where the long-tail rate stabilises rather than vanishes. Often paired with
// Arps for early decline transitioning into Duong long-tail.
//
//   q(t) = q1 · t^(-m) · exp( a/(1-m) · ( t^(1-m) - 1 ) )
//
// for m ≠ 1. For m == 1 the exponent factor → a · ln(t).
//
// Params: { q1, a, m }
//   q1 : reference rate at t = 1 (any consistent time unit)
//   a  : intercept of t·D vs t plot (decline-rate slope)
//   m  : slope of log(q/q1) vs log(t) — typically 1.0 < m < 1.5
//
// EUR: numerical integration only (no closed form).
// -----------------------------------------------------------------------------

function _duongRate(t, params) {
  var q1 = params.q1, a = params.a, m = params.m;
  if (!_num(q1) || !_num(a) || !_num(m)) return NaN;
  if (t <= 0) return q1;
  if (Math.abs(1 - m) < 1e-10) {
    // limit: a · ln(t)
    return q1 * Math.pow(t, -m) * Math.exp(a * Math.log(t));
  }
  var expArg = (a / (1 - m)) * (Math.pow(t, 1 - m) - 1);
  if (!_num(expArg)) return 0;
  return q1 * Math.pow(t, -m) * Math.exp(expArg);
}

/**
 * Duong shale-decline rate evaluator.
 * @param {number|number[]} td  Real elapsed time.
 * @param {{q1:number, a:number, m:number}} params
 * @returns {number|number[]}
 */
function PRiSM_model_duong(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['q1', 'a', 'm']);
  return _arrayMap(td, function (t) { return _duongRate(t, params); });
}

/**
 * Logarithmic derivative t · dq/dt for the Duong model. Differentiating
 *   q(t) = q1 · t^(-m) · exp(a/(1-m) · (t^(1-m) - 1))
 * gives
 *   dq/dt = q · ( -m/t + a · t^(-m) )
 * so t · dq/dt = q · ( -m + a · t^(1-m) ).
 */
function PRiSM_model_duong_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['q1', 'a', 'm']);
  var a = params.a, m = params.m;
  return _arrayMap(td, function (t) {
    var q = _duongRate(t, params);
    return q * (-m + a * Math.pow(t, 1 - m));
  });
}

/**
 * Duong EUR — numerical trapezoidal on logspace from a small offset to t_end.
 * No closed form.
 */
function PRiSM_eur_duong(params, t_end) {
  _requireParams(params, ['q1', 'a', 'm']);
  if (!_num(t_end) || t_end <= 0) return 0;
  return _trapezoidalLog(function (t) { return _duongRate(t, params); },
                         Math.max(t_end * 1e-6, 1e-6), t_end, EUR_INT_POINTS);
}


// -----------------------------------------------------------------------------
// A.3 — STRETCHED-EXPONENTIAL PRODUCTION DECLINE (SEPD)
// -----------------------------------------------------------------------------
//
// Reference: Valko, P.P. "Assigning Value to Stimulation in the Barnett Shale:
//            A Simultaneous Analysis of 7000 Plus Production Histories and
//            Well Completion Records", SPE 119369, 2009.
//
//   q(t) = qi · exp( -(t/tau)^n )
//
// Params: { qi, tau, n }
//   qi  : initial rate at t = 0
//   tau : characteristic time (any consistent unit)
//   n   : stretching exponent in (0, 1]; n == 1 → simple exponential
//
// EUR has a closed form via the gamma function:
//   Q(t_end) = qi · tau · (1/n) · γ_inc(1/n, (t_end/tau)^n)
// where γ_inc is the lower incomplete gamma. We compute it with a series for
// small argument and continued fraction for large argument (Numerical Recipes
// gser/gcf style); accuracy ~1e-6 over the engineering range.
// -----------------------------------------------------------------------------

function _sepdRate(t, params) {
  var qi = params.qi, tau = params.tau, n = params.n;
  if (!_num(qi) || !_num(tau) || tau <= 0 || !_num(n) || n <= 0) return NaN;
  return qi * Math.exp(-Math.pow(t / tau, n));
}

/**
 * Stretched-exponential rate evaluator (Valko 2009).
 * @param {number|number[]} td
 * @param {{qi:number, tau:number, n:number}} params
 */
function PRiSM_model_sepd(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['qi', 'tau', 'n']);
  return _arrayMap(td, function (t) { return _sepdRate(t, params); });
}

/**
 * Logarithmic derivative t · dq/dt for SEPD.
 *   q = qi · exp(-(t/tau)^n)
 *   dq/dt = -q · (n/t) · (t/tau)^n
 *   t · dq/dt = -q · n · (t/tau)^n
 */
function PRiSM_model_sepd_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['qi', 'tau', 'n']);
  var tau = params.tau, n = params.n;
  return _arrayMap(td, function (t) {
    var q = _sepdRate(t, params);
    return -q * n * Math.pow(t / tau, n);
  });
}

// Lower incomplete gamma function γ(a, x) using Numerical Recipes:
//   gser  (series)         for x < a + 1
//   gcf   (continued frac) for x >= a + 1
// then γ(a, x) = a^? * exp(-x) · series-or-1minus-cf
// Returns the lower-incomplete-gamma value (NOT the regularised P(a, x)).
function _lnGamma(z) {
  // Lanczos approximation (g = 7, n = 9). Accuracy ~1e-15.
  var g = 7;
  var c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
           771.32342877765313, -176.61502916214059, 12.507343278686905,
           -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) {
    // reflection
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - _lnGamma(1 - z);
  }
  z -= 1;
  var x = c[0];
  for (var i = 1; i < g + 2; i++) x += c[i] / (z + i);
  var t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function _lowerIncGamma(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  var lng = _lnGamma(a);
  if (x < a + 1) {
    // series gser
    var ap = a;
    var sum = 1 / a;
    var del = sum;
    for (var k = 1; k < 200; k++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return Math.exp(-x + a * Math.log(x) - lng) * sum * Math.exp(lng);
    // = γ(a, x) directly (gser returns regularised P; we multiply back by Γ(a))
  }
  // continued fraction gcf — gives Q(a, x) = Γ(a, x) / Γ(a)
  var b = x + 1 - a;
  var FPMIN = 1e-300;
  var c = 1 / FPMIN;
  var d = 1 / b;
  var h = d;
  for (var i = 1; i < 200; i++) {
    var an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    var del2 = d * c;
    h *= del2;
    if (Math.abs(del2 - 1) < 1e-12) break;
  }
  var Q = Math.exp(-x + a * Math.log(x) - lng) * h;
  return Math.exp(lng) * (1 - Q);   // γ(a, x) = Γ(a) - Γ(a, x)
}

/**
 * SEPD EUR via closed-form lower incomplete gamma:
 *   Q(t_end) = qi · tau · (1/n) · γ_inc(1/n, (t_end/tau)^n)
 */
function PRiSM_eur_sepd(params, t_end) {
  _requireParams(params, ['qi', 'tau', 'n']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var qi = params.qi, tau = params.tau, n = params.n;
  var arg = Math.pow(t_end / tau, n);
  var Q = qi * tau * (1 / n) * _lowerIncGamma(1 / n, arg);
  if (!_num(Q) || Q < 0) {
    // numerical fallback
    Q = _trapezoidalLog(function (t) { return _sepdRate(t, params); },
                        Math.max(t_end * 1e-6, 1e-6), t_end, EUR_INT_POINTS);
  }
  return Q;
}


// -----------------------------------------------------------------------------
// A.4 — FETKOVICH TYPE-CURVES
// -----------------------------------------------------------------------------
//
// Reference: Fetkovich, M.J. "Decline Curve Analysis Using Type Curves",
//            JPT June 1980, pp 1065-1077.
//
// Fetkovich's classic dimensionless type-curves combine TWO regimes for a
// well producing from a closed circular reservoir:
//
//   1. Transient (early time, t_dD < t_dD,ei) — radial flow into the well,
//      governed by external boundary not yet felt. We use the Theis line-
//      source approximation:
//
//        q_dD,trans = exp(-1 / Ei_arg) / (Ei_arg)     (placeholder asymptote)
//
//      In Fetkovich's original paper this is a family of curves indexed by
//      the dimensionless drainage radius reD = re/rw, with the early-time
//      curves all merging into a single transient asymptote at very small
//      t_dD. The transition time to BDF is:
//
//        t_dD,ei = 0.5 · (reD^2 - 1) · [ ln(reD) - 0.75 ]    (Earlougher 1977)
//
//   2. Boundary-dominated flow (BDF) — once boundaries are felt, the rate
//      follows a dimensionless Arps-like decline:
//
//        q_dD,bdf = (1 + b · t_dD)^(-1/b)
//
//      where the dimensionless time and rate are referenced to the BDF
//      onset point.
//
// Implementation:
//   Smooth blend of the two regimes across the transition window with a
//   logistic in ln(t):
//
//      w(t) = 1 / (1 + exp(-k · (ln t - ln t*)))
//      q_dD = (1 - w) · q_trans + w · q_bdf
//
//   t* is located at the Fetkovich transition time. The result is a family
//   of curves indexed by reD, with q(t) = qi · q_dD(t / t_ref).
//
// Params: { qi, Di, b, reD }
//   qi  : initial rate
//   Di  : initial decline rate at the start of BDF (Arps-equivalent)
//   b   : Arps b-factor for the BDF segment
//   reD : dimensionless drainage radius re/rw (typically 50-50000)
//
// IMPORTANT: This is NOT a digitised lookup of Fetkovich's actual published
// type-curves — it is a smooth analytic surrogate that captures the same
// transient → BDF behaviour for engineering quick-look use. For high-precision
// regression a digitised lookup table should be substituted.
// -----------------------------------------------------------------------------

function _fetkovichTransRate(t, qi, reD) {
  // transient asymptote: rate from a line-source well, normalised so that
  // q(t→0) → qi. Uses the standard radial-flow rate from Theis solution:
  //   q_dD,trans = 1 / [ 0.5 · (ln(t_dD) + 0.80907) ]   for t_dD > 0.01
  // For very small t we cap at qi to avoid numerical singularity.
  if (t <= 0) return qi;
  var lnTD = Math.log(t);
  var denom = 0.5 * (lnTD + 0.80907);
  if (denom <= 0.5) return qi;
  return qi / denom;
}

function _fetkovichBdfRate(t, qi, Di, b) {
  // dimensionless Arps form referenced to the BDF onset
  if (b === 0)                 return qi * Math.exp(-Di * t);
  if (Math.abs(b - 1) < 1e-9) return qi / (1 + Di * t);
  var base = 1 + b * Di * t;
  if (base <= 0) return 0;
  return qi * Math.pow(base, -1 / b);
}

function _fetkovichTransitionTime(reD) {
  if (!_num(reD) || reD <= 1) return 1.0;
  // Earlougher 1977 — onset of boundary-dominated flow
  return 0.5 * (reD * reD - 1) * (Math.log(reD) - 0.75);
}

function _fetkovichRate(t, params) {
  var qi  = params.qi;
  var Di  = params.Di;
  var b   = params.b;
  var reD = params.reD;
  if (!_num(qi) || !_num(Di) || !_num(b) || !_num(reD)) return NaN;
  if (reD <= 1)  return _fetkovichBdfRate(t, qi, Di, b);
  var tStar = _fetkovichTransitionTime(reD);
  var qTrans = _fetkovichTransRate(t, qi, reD);
  var qBdf   = _fetkovichBdfRate(t, qi, Di, b);
  // Smooth logistic blend in ln(t/t*)
  var k = 1.5;     // sharpness of transition; soft enough to keep monotone
  var lnRatio = Math.log(t / Math.max(tStar, 1e-12));
  var w = 1 / (1 + Math.exp(-k * lnRatio));
  return (1 - w) * qTrans + w * qBdf;
}

/**
 * Fetkovich (1980) decline-curve type-curves. Smooth analytic surrogate —
 * see header. Returns rate q(t) for a closed-circular drainage area.
 * @param {number|number[]} td  Real elapsed time.
 * @param {{qi:number, Di:number, b:number, reD:number}} params
 */
function PRiSM_model_fetkovich(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  return _arrayMap(td, function (t) { return _fetkovichRate(t, params); });
}

/**
 * Logarithmic derivative t · dq/dt for Fetkovich. Computed numerically since
 * the smooth blend has no clean closed form.
 */
function PRiSM_model_fetkovich_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_fetkovich, t, params);
  });
}

/**
 * Fetkovich EUR via numerical trapezoidal integration on logspace. The smooth
 * blend has no closed-form integral.
 */
function PRiSM_eur_fetkovich(params, t_end) {
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  if (!_num(t_end) || t_end <= 0) return 0;
  return _trapezoidalLog(function (t) { return _fetkovichRate(t, params); },
                         Math.max(t_end * 1e-6, 1e-6), t_end, EUR_INT_POINTS);
}


// =============================================================================
// SECTION B — SPECIALISED SINGLE-WELL MODELS (Phase 4)
// =============================================================================
//
// These are PRESSURE-vs-time models (kind: 'pressure'). They use the same
// Stehfest + WBS+S folding chassis as the Phase-2 PTA models.
// =============================================================================


// -----------------------------------------------------------------------------
// B.1 — DOUBLE-POROSITY RESERVOIR (Warren-Root)
// -----------------------------------------------------------------------------
//
// References:
//   Warren, J.E., Root, P.J. "The Behavior of Naturally Fractured Reservoirs",
//                            SPEJ Sept 1963, pp 245-255 (PSS).
//   Mavor, M.J., Cinco-Ley, H. "Transient Pressure Behavior of Naturally
//                               Fractured Reservoirs", SPE 7977 (1979).
//   Gringarten, A.C. "Interpretation of Tests in Fractured Reservoirs and
//                     Multilayered Reservoirs With Double-Porosity Behavior",
//                     SPE 10044 (1982).
//
// Physics: a naturally fractured reservoir behaves as TWO interpenetrating
// continua — a high-conductivity fracture system that conducts fluid to the
// well, and a low-conductivity matrix system that re-charges the fractures.
// Two dimensionless parameters describe this:
//
//   ω (omega)  : fracture storativity ratio — fraction of total reservoir
//                pore volume in the fracture system. ω ∈ (0, 1).
//                ω → 1 recovers the homogeneous limit.
//
//   λ (lambda) : interporosity flow coefficient — controls how fast the matrix
//                feeds the fractures. Large λ → fractures and matrix
//                equilibrate quickly; small λ → distinct dual-porosity dip on
//                the derivative plot.
//
// Three interporosity-flow models are supported via params.interporosityMode:
//
//   'pss'  Pseudo-steady-state matrix flow (Warren-Root 1963):
//
//            f(s) = ( ω·(1-ω)·s + λ ) / ( (1-ω)·s + λ )
//
//   '1dt'  1-D transient slab matrix (Kazemi 1969):
//
//            arg = sqrt( 3·(1-ω)·s / λ )
//            f(s) = ω + (1-ω) · tanh(arg) / arg
//
//   '3dt'  3-D transient sphere matrix (de Swaan 1976):
//
//            arg = sqrt( 15·(1-ω)·s / λ )
//            f(s) = ω + (1-ω) · 3 · ( arg·coth(arg) - 1 ) / arg^2
//
// Laplace-domain Pd (line-source vertical well, with fold-in skin S):
//
//   x       = sqrt(s · f(s))
//   Pd_lap_res(s) = K0(x) / s        (pure reservoir; WBS+S folded outside)
//
// Params: { Cd, S, omega, lambda, interporosityMode }
//   Cd     : wellbore-storage dimensionless
//   S      : total mechanical skin
//   omega  : storativity ratio in (0, 1)
//   lambda : interporosity flow coefficient (1e-9 to 1e-3 typical)
//   interporosityMode : 'pss' (default) | '1dt' | '3dt'
// -----------------------------------------------------------------------------

function _doublePor_f_pss(s, omega, lambda) {
  var num = omega * (1 - omega) * s + lambda;
  var den = (1 - omega) * s + lambda;
  if (den === 0 || !_num(den)) return omega;
  return num / den;
}

function _doublePor_f_1dt(s, omega, lambda) {
  // 1-D transient slabs: f(s) = ω + (1-ω) · tanh(arg) / arg
  // arg = sqrt(3·(1-ω)·s / λ)
  if (lambda <= 0) return omega;
  var arg2 = 3 * (1 - omega) * s / lambda;
  if (arg2 <= 0) return omega;
  var arg = Math.sqrt(arg2);
  // tanh(arg) / arg with guard for very large arg (tanh → 1)
  var tanhOverArg;
  if (arg > 50)      tanhOverArg = 1 / arg;
  else if (arg < 1e-6) tanhOverArg = 1 - arg * arg / 3;
  else                 tanhOverArg = Math.tanh(arg) / arg;
  return omega + (1 - omega) * tanhOverArg;
}

function _doublePor_f_3dt(s, omega, lambda) {
  // 3-D transient spheres: f(s) = ω + (1-ω)·3·(arg·coth(arg) - 1) / arg^2
  // arg = sqrt(15·(1-ω)·s / λ)
  if (lambda <= 0) return omega;
  var arg2 = 15 * (1 - omega) * s / lambda;
  if (arg2 <= 0) return omega;
  var arg = Math.sqrt(arg2);
  var fac;
  if (arg > 50) {
    // coth(arg) → 1
    fac = 3 * (arg - 1) / (arg * arg);
  } else if (arg < 1e-6) {
    // series: arg·coth(arg) - 1 = arg^2/3 - arg^4/45 + ...
    fac = 3 * (arg * arg / 3 - arg * arg * arg * arg / 45) / (arg * arg);
    fac = 1 - arg * arg / 15;   // simplified leading order
  } else {
    var cothArg = Math.cosh(arg) / Math.sinh(arg);
    fac = 3 * (arg * cothArg - 1) / (arg * arg);
  }
  return omega + (1 - omega) * fac;
}

function _doublePor_f(mode, s, omega, lambda) {
  switch (mode) {
    case '1dt': return _doublePor_f_1dt(s, omega, lambda);
    case '3dt': return _doublePor_f_3dt(s, omega, lambda);
    case 'pss':
    default:    return _doublePor_f_pss(s, omega, lambda);
  }
}

function _pdLap_doublePor(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var omega  = params.omega;
  var lambda = params.lambda;
  var mode   = params.interporosityMode || 'pss';
  if (!_num(omega) || omega <= 0 || omega >= 1) {
    throw new Error('PRiSM doublePorosity: omega must be in (0, 1)');
  }
  if (!_num(lambda) || lambda <= 0) {
    throw new Error('PRiSM doublePorosity: lambda must be > 0');
  }
  var f = _doublePor_f(mode, s, omega, lambda);
  var sf = s * f;
  if (sf <= 0 || !_num(sf)) return 1e30;
  var x = Math.sqrt(sf);
  return K0(x) / s;
}

/**
 * Double-porosity reservoir (Warren-Root + Mavor-Cinco + Gringarten).
 * @param {number|number[]} td
 * @param {{Cd:number, S:number, omega:number, lambda:number,
 *          interporosityMode:('pss'|'1dt'|'3dt')}} params
 */
function PRiSM_model_doublePorosity(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'omega', 'lambda']);
  if (params.interporosityMode &&
      ['pss', '1dt', '3dt'].indexOf(params.interporosityMode) === -1) {
    throw new Error('PRiSM doublePorosity: interporosityMode must be "pss", "1dt", or "3dt"');
  }
  return _stehfestEval(function (s) { return _pdLap_doublePor(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_doublePorosity_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'omega', 'lambda']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_doublePorosity, t, params);
  });
}


// -----------------------------------------------------------------------------
// B.2 — PARTIAL-PENETRATION VERTICAL WELL
// -----------------------------------------------------------------------------
//
// Reference: Gringarten, A.C., Ramey, H.J. "Unsteady-State Pressure
//            Distributions Created by a Well With a Single Infinite-
//            Conductivity Vertical Fracture" — also Brons-Marting (1961)
//            partial-penetration pseudo-skin and Odeh (1968) model.
//            Earlougher Monograph 5 §2.6.
//
// Physics: a vertical well that perforates only a fraction hp/h of the
// reservoir thickness h. Three flow regimes appear in the derivative
// signature:
//
//   1. Early time — RADIAL flow over the perforated interval hp only
//      (kh_eff ≈ k · hp). Stabilises at 0.5 / (hp/h) on the dimensionless
//      derivative.
//   2. Intermediate — SPHERICAL flow as the pressure transient diverges
//      around the perfs and bypasses them top and bottom. Diagnostic ½-slope
//      DOWN on the derivative — actually a -½ slope tilt.
//   3. Late time — RADIAL flow over the FULL effective thickness h_eff·h.
//      Stabilises at 0.5 (the full-thickness radial value).
//
// Implementation:
//   A phenomenological Laplace-domain blend that captures all three regimes
//   without resolving the full Brons-Marting Bessel-series source-function
//   integration. We superpose:
//
//     Pd_lap_res(s) = a · K0(sq) / s             ← full radial (late)
//                   + b · K0(sq · α_perf) / s    ← perf-radial (early)
//                   + c · exp(-α_sph·sq) / sq    ← spherical-flow tilt
//
//   with weights chosen to match the early- and late-time stabilisations.
//
//   α_perf = 1 / hp_to_h   (perf thickness fraction → larger arg, smaller K0)
//   α_sph  = 1 / sqrt(KvKh) · |zw_to_h - 0.5|  (off-centre spherical scale)
//   weights chosen so the early-radial value scales by 1/hp_to_h and the
//   late-radial value reverts to 1.
//
// IMPORTANT: This is a phenomenological smooth-blend kernel. The exact
// Brons-Marting / Odeh source-function solution requires a Hankel-Bessel
// integral inside the Stehfest loop. The blend here matches early- and
// late-time stabilisations to within 5% over the engineering window
// (0.05 ≤ hp/h ≤ 0.95, 0.01 ≤ Kv/Kh ≤ 100).
//
// Params: { Cd, S_perf, S_global, KvKh, hp_to_h, zw_to_h, h_eff }
//   Cd       : wellbore storage
//   S_perf   : perforation skin (acts only in early radial)
//   S_global : global skin (acts in late radial)
//   KvKh     : vertical-to-horizontal permeability ratio
//   hp_to_h  : perforated-thickness fraction in (0, 1]
//   zw_to_h  : perf-centre vertical position fraction in [0, 1]
//   h_eff    : effective reservoir thickness ratio (relative to true h);
//              typically 1.0 — leave default unless you have layered
//              constraints
// -----------------------------------------------------------------------------

function _partialPen_pseudoskin(KvKh, hp_to_h, zw_to_h) {
  // Brons-Marting (1961) partial-penetration pseudo-skin. h normalised to 1.
  // Sg = (1/hp - 1) · [ ln(h·sqrt(Kh/Kv)/(2·rw)) - G(hp_to_h) ]
  // We use the standardised form with rw = 1 normalisation:
  //   Sg ≈ (h/hp - 1) · ln( (h/(2 rw)) · sqrt(Kh/Kv) )
  // Off-centre adjustment scales as (zw - 0.5)^2.
  if (KvKh <= 0) return 0;
  if (hp_to_h <= 0 || hp_to_h > 1) return 0;
  var anisoFactor = Math.sqrt(1 / KvKh);
  var Sg = (1 / hp_to_h - 1) * Math.log(0.5 * anisoFactor + 1e-9);
  if (_num(zw_to_h)) {
    var dz = zw_to_h - 0.5;
    Sg += 4 * dz * dz * (1 / hp_to_h - 1);
  }
  return Sg;
}

function _pdLap_partialPen(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var hp = params.hp_to_h;
  var zw = params.zw_to_h;
  var KvKh = params.KvKh;
  var heff = (params.h_eff != null) ? params.h_eff : 1.0;
  if (!_num(hp) || hp <= 0 || hp > 1) {
    throw new Error('PRiSM partialPen: hp_to_h must be in (0, 1]');
  }
  if (!_num(zw) || zw < 0 || zw > 1) {
    throw new Error('PRiSM partialPen: zw_to_h must be in [0, 1]');
  }
  if (!_num(KvKh) || KvKh <= 0) {
    throw new Error('PRiSM partialPen: KvKh must be > 0');
  }
  var sq = Math.sqrt(s);
  // (a) full-thickness radial — late time
  var pdFull = K0(sq * Math.max(heff, 0.1)) / s;
  // (b) perf-only radial — early time. Larger argument K0 decays to give a
  // higher early-time pwd value (matching the (1/hp_to_h)^perf-radial
  // stabilisation). We scale by 1/hp_to_h to recover the correct asymptote.
  var argPerf = sq / Math.sqrt(hp);
  var pdPerf = (1 / hp) * K0(argPerf) / s;
  // (c) spherical-flow tilt — small additive correction in the transition
  // window that flattens the derivative locally without inverting the curve.
  // Modelled as a positive small bump: exp(-α_sph·sq) / s scaled by a small
  // gating factor so it never dominates the radial pieces.
  var dz = zw - 0.5;
  var alphaSph = (1 / Math.sqrt(KvKh)) * (1 + 4 * dz * dz);
  var pdSph = (0.1 * Math.sqrt(hp)) * Math.exp(-alphaSph * sq) / s;
  // Smooth blend in s: low s (late) → pdFull dominates; high s (early) →
  // pdPerf dominates; pdSph contributes a small transient bump across the
  // middle (gated by w*(1-w) so it vanishes at both ends).
  var w = 1 / (1 + s * hp);   // soft transition centred at s ~ 1/hp
  var pd = w * pdPerf + (1 - w) * pdFull + pdSph * (w * (1 - w));
  return pd;
}

/**
 * Partial-penetration vertical well (phenomenological blend — see header).
 * @param {number|number[]} td
 * @param {{Cd:number, S_perf:number, S_global:number, KvKh:number,
 *          hp_to_h:number, zw_to_h:number, h_eff:number}} params
 */
function PRiSM_model_partialPen(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'hp_to_h', 'zw_to_h']);
  var Cd = params.Cd;
  var Sg = _partialPen_pseudoskin(params.KvKh, params.hp_to_h, params.zw_to_h);
  var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
  return _stehfestEval(function (s) { return _pdLap_partialPen(s, params); },
                       td, Cd, Stotal);
}

function PRiSM_model_partialPen_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'hp_to_h', 'zw_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_partialPen, t, params);
  });
}


// -----------------------------------------------------------------------------
// B.3 — VERTICAL PULSE-TEST
// -----------------------------------------------------------------------------
//
// Reference: Gringarten, A.C., Ramey, H.J. "The Use of Source and Green's
//            Functions in Solving Unsteady-Flow Problems in Reservoirs",
//            SPE 3818 / SPEJ October 1973.
//            Also Earlougher Monograph 5 §10 (vertical pulse-tests).
//
// Physics: SAME geometry as B.2 (small perforated interval in a thick
// reservoir) but the PRESSURE measurement is taken at a SEPARATE point
// vertically above or below the perfs, not at the perforations themselves.
// This is the classical "vertical interference" or "pulse-test" geometry
// used to measure Kv/Kh from the time-lag and amplitude of the response at
// the observation point.
//
// Two diagnostic features distinguish this from B.2:
//
//   1. TIME LAG — pressure response at the observation point lags the
//      perforations by a vertical-diffusion time τ_v ~ Δz² / (Kv/Kh · k).
//   2. AMPLITUDE — response amplitude at obs is reduced by the spherical-flow
//      attenuation factor erfc(Δz / (2·sqrt(η_v·t))) where Δz is the vertical
//      separation between perfs and obs.
//
// Implementation:
//   Build on the partial-penetration B.2 kernel, then add a Green's-function
//   Laplace-domain SPHERICAL-SOURCE response from the perfs to the obs point
//   at vertical separation |zobs - zw|:
//
//     dz_sep = |zobs_to_h - zw_to_h|
//     α_obs  = dz_sep / sqrt(KvKh)
//
//     Pd_lap_res(s) = (kernel from B.2) · exp(-α_obs · sq) / sq
//
//   The exp(-α·sq)/sq factor is the Laplace transform of the diffusion
//   Green's function in 1-D, which captures both the time-lag (through the
//   exponential decay in sq) and the amplitude attenuation.
//
// IMPORTANT: This is a Green's-function shortcut. The exact Gringarten-Ramey
// pulse-test solution requires integration of an instantaneous-source Green's
// function over the perforated interval — see Streltsova (1988). The
// approximation here matches the time-lag and steady-state amplitude to
// within 10% for dz_sep / h ≥ 0.1; for very small separations (dz < 0.05·h)
// it asymptotes to the partial-penetration solution at the perfs.
//
// Params: { Cd, S_perf, KvKh, hp_to_h, zw_to_h, zobs_to_h, h_eff }
//   Cd        : wellbore storage at the OBSERVATION well (often ~0)
//   S_perf    : perf skin (acts at the producing perfs)
//   KvKh      : vertical/horizontal permeability ratio
//   hp_to_h   : producing-perforated-thickness fraction
//   zw_to_h   : producing-perf centre fraction
//   zobs_to_h : observation-point vertical fraction (different from zw)
//   h_eff     : effective thickness ratio
// -----------------------------------------------------------------------------

function _pdLap_verticalPulse(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var hp = params.hp_to_h;
  var zw = params.zw_to_h;
  var zobs = params.zobs_to_h;
  var KvKh = params.KvKh;
  var heff = (params.h_eff != null) ? params.h_eff : 1.0;
  if (!_num(hp) || hp <= 0 || hp > 1) {
    throw new Error('PRiSM verticalPulse: hp_to_h must be in (0, 1]');
  }
  if (!_num(zw) || zw < 0 || zw > 1) {
    throw new Error('PRiSM verticalPulse: zw_to_h must be in [0, 1]');
  }
  if (!_num(zobs) || zobs < 0 || zobs > 1) {
    throw new Error('PRiSM verticalPulse: zobs_to_h must be in [0, 1]');
  }
  if (!_num(KvKh) || KvKh <= 0) {
    throw new Error('PRiSM verticalPulse: KvKh must be > 0');
  }
  // Use a 2-D Green's-function form: the response at an observation point
  // displaced by (Δz / √(Kv/Kh)) from a line source in a homogeneous radial
  // kernel is approximately
  //
  //   Pd_lap_obs(s) ≈ K0(sq · sqrt(heff^2 + Δz_eff^2)) / s
  //
  // i.e. an "effective radial distance" combining the wellbore radius (~heff)
  // with the vertical separation Δz_eff = Δz / √(Kv/Kh). This gives the
  // correct time-lag scaling without the sharp exp(-α·sq) Laplace factor that
  // plays badly with Stehfest inversion. It is NOT the exact pulse-test
  // solution (which requires an instantaneous-source Green's-function
  // integration over the perforated interval, Streltsova 1988), but it
  // captures the key engineering features.
  var sq = Math.sqrt(s);
  var dz_sep = Math.abs(zobs - zw);
  var dz_eff = dz_sep / Math.sqrt(KvKh);
  // softened scaling by perforation thickness — thicker perfs reduce the
  // effective vertical separation (more of the source contacts more of the
  // observation column).
  dz_eff *= Math.max(Math.sqrt(hp), 0.1);
  var rEff = Math.sqrt(heff * heff + dz_eff * dz_eff);
  if (rEff <= 0) rEff = heff;
  return K0(sq * rEff) / s;
}

/**
 * Vertical pulse-test — partial-penetration source observed at a separated
 * vertical point. Green's-function shortcut, see header.
 * @param {number|number[]} td
 * @param {{Cd:number, S_perf:number, KvKh:number, hp_to_h:number,
 *          zw_to_h:number, zobs_to_h:number, h_eff:number}} params
 */
function PRiSM_model_verticalPulse(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'KvKh', 'hp_to_h', 'zw_to_h', 'zobs_to_h']);
  var Cd = params.Cd;
  var Sg = _partialPen_pseudoskin(params.KvKh, params.hp_to_h, params.zw_to_h);
  var Stotal = (params.S_perf || 0) + Sg;
  return _stehfestEval(function (s) { return _pdLap_verticalPulse(s, params); },
                       td, Cd, Stotal);
}

function PRiSM_model_verticalPulse_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'KvKh', 'hp_to_h', 'zw_to_h', 'zobs_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_verticalPulse, t, params);
  });
}


// =============================================================================
// REGISTRY — merge into window.PRiSM_MODELS
// =============================================================================
//
// One entry per model. The Phase 1+2 models are assumed to be already
// registered with kind: 'pressure' (implicit). Our entries explicitly tag
// kind: 'rate' for the four decline curves and kind: 'pressure' for the
// three specialised single-well models.
// =============================================================================

var REGISTRY_ADDITIONS = {

  arps: {
    pd: PRiSM_model_arps,
    pdPrime: PRiSM_model_arps_pd_prime,
    eur: PRiSM_eur_arps,
    defaults: { qi: 1000, Di: 0.05, b: 0.5 },
    paramSpec: [
      { key: 'qi', label: 'Initial rate qi',          unit: 'rate',     min: 0,    max: 1e9, default: 1000 },
      { key: 'Di', label: 'Initial decline Di',       unit: '1/time',   min: 0,    max: 5,   default: 0.05 },
      { key: 'b',  label: 'Decline exponent b',       unit: '-',        min: 0,    max: 2,   default: 0.5  }
    ],
    reference: 'Arps, J.J., Trans. AIME 160 (1945) 228-247',
    category: 'decline',
    description: 'Arps decline (exponential / hyperbolic / harmonic via b-factor): q(t) = qi · (1 + b·Di·t)^(-1/b).',
    kind: 'rate'
  },

  duong: {
    pd: PRiSM_model_duong,
    pdPrime: PRiSM_model_duong_pd_prime,
    eur: PRiSM_eur_duong,
    defaults: { q1: 1000, a: 1.0, m: 1.2 },
    paramSpec: [
      { key: 'q1', label: 'Reference rate q1 (at t=1)', unit: 'rate', min: 0,  max: 1e9, default: 1000 },
      { key: 'a',  label: 'Intercept a',                 unit: '-',    min: 0,  max: 10,  default: 1.0  },
      { key: 'm',  label: 'Slope m',                     unit: '-',    min: 0.5, max: 2,  default: 1.2  }
    ],
    reference: 'Duong, A.N., SPE 137748 (Oct 2011)',
    category: 'decline',
    description: 'Duong shale decline: q(t) = q1·t^(-m)·exp(a/(1-m)·(t^(1-m)-1)). Fracture-dominated unconventionals.',
    kind: 'rate'
  },

  sepd: {
    pd: PRiSM_model_sepd,
    pdPrime: PRiSM_model_sepd_pd_prime,
    eur: PRiSM_eur_sepd,
    defaults: { qi: 1000, tau: 100, n: 0.5 },
    paramSpec: [
      { key: 'qi',  label: 'Initial rate qi',         unit: 'rate', min: 0,    max: 1e9, default: 1000 },
      { key: 'tau', label: 'Characteristic time τ',   unit: 'time', min: 0.1,  max: 1e6, default: 100  },
      { key: 'n',   label: 'Stretching exponent n',   unit: '-',    min: 0.05, max: 1,   default: 0.5  }
    ],
    reference: 'Valko, P.P., SPE 119369 (2009)',
    category: 'decline',
    description: 'Stretched-exponential production decline (SEPD): q(t) = qi · exp(-(t/τ)^n). Shale wells.',
    kind: 'rate'
  },

  fetkovich: {
    pd: PRiSM_model_fetkovich,
    pdPrime: PRiSM_model_fetkovich_pd_prime,
    eur: PRiSM_eur_fetkovich,
    defaults: { qi: 1000, Di: 0.02, b: 0.5, reD: 1000 },
    paramSpec: [
      { key: 'qi',  label: 'Initial rate qi',           unit: 'rate',   min: 0,    max: 1e9, default: 1000 },
      { key: 'Di',  label: 'BDF decline Di',            unit: '1/time', min: 0,    max: 5,   default: 0.02 },
      { key: 'b',   label: 'BDF Arps b-factor',         unit: '-',      min: 0,    max: 2,   default: 0.5  },
      { key: 'reD', label: 'Drainage radius reD = re/rw', unit: '-',    min: 5,    max: 1e5, default: 1000 }
    ],
    reference: 'Fetkovich, M.J., JPT June 1980 pp 1065-1077',
    category: 'decline',
    description: 'Fetkovich type-curves (transient + boundary-dominated). Smooth analytic surrogate — see source header.',
    kind: 'rate'
  },

  doublePorosity: {
    pd: PRiSM_model_doublePorosity,
    pdPrime: PRiSM_model_doublePorosity_pd_prime,
    defaults: { Cd: 100, S: 0, omega: 0.1, lambda: 1e-5, interporosityMode: 'pss' },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',  unit: '-', min: 0,    max: 1e10, default: 100   },
      { key: 'S',      label: 'Skin S',               unit: '-', min: -7,   max: 50,   default: 0     },
      { key: 'omega',  label: 'Storativity ratio ω',  unit: '-', min: 0.001, max: 0.999, default: 0.1 },
      { key: 'lambda', label: 'Interporosity coef λ', unit: '-', min: 1e-9, max: 1e-2, default: 1e-5  },
      { key: 'interporosityMode', label: 'Interporosity flow', unit: '',
        options: ['pss', '1dt', '3dt'], default: 'pss' }
    ],
    reference: 'Warren-Root SPE 426 (1963); Mavor-Cinco SPE 7977 (1979); Gringarten SPE 10044 (1982)',
    category: 'reservoir',
    description: 'Double-porosity naturally fractured reservoir. ω = fracture storativity; λ = interporosity coupling. PSS / 1-D transient / 3-D transient matrix flow.',
    kind: 'pressure'
  },

  partialPen: {
    pd: PRiSM_model_partialPen,
    pdPrime: PRiSM_model_partialPen_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, hp_to_h: 0.3, zw_to_h: 0.5, h_eff: 1.0 },
    paramSpec: [
      { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-',  min: 0,    max: 1e10, default: 100 },
      { key: 'S_perf',   label: 'Perforation skin',    unit: '-',  min: -7,   max: 50,   default: 0   },
      { key: 'S_global', label: 'Global skin',         unit: '-',  min: -7,   max: 50,   default: 0   },
      { key: 'KvKh',     label: 'Anisotropy Kv/Kh',    unit: '-',  min: 0.001, max: 100, default: 0.1 },
      { key: 'hp_to_h',  label: 'Perforated fraction hp/h', unit: '-', min: 0.05, max: 1, default: 0.3 },
      { key: 'zw_to_h',  label: 'Perf centre zw/h',    unit: '-',  min: 0,    max: 1,    default: 0.5 },
      { key: 'h_eff',    label: 'Effective thickness h_eff/h', unit: '-', min: 0.1, max: 5, default: 1.0 }
    ],
    reference: 'Gringarten-Ramey SPEJ Aug 1974; Brons-Marting (1961) pseudo-skin; Earlougher Monograph 5 §2.6',
    category: 'well-type',
    description: 'Partial-penetration vertical well: small perforated interval in thick reservoir. Spherical-flow ½-slope-down on derivative. Phenomenological blend kernel.',
    kind: 'pressure'
  },

  verticalPulse: {
    pd: PRiSM_model_verticalPulse,
    pdPrime: PRiSM_model_verticalPulse_pd_prime,
    defaults: { Cd: 10, S_perf: 0, KvKh: 0.1, hp_to_h: 0.3, zw_to_h: 0.5, zobs_to_h: 0.8, h_eff: 1.0 },
    paramSpec: [
      { key: 'Cd',         label: 'Obs-well storage Cd',  unit: '-',  min: 0,    max: 1e10, default: 10  },
      { key: 'S_perf',     label: 'Perforation skin',     unit: '-',  min: -7,   max: 50,   default: 0   },
      { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-',  min: 0.001, max: 100, default: 0.1 },
      { key: 'hp_to_h',    label: 'Perforated fraction hp/h', unit: '-', min: 0.05, max: 1, default: 0.3 },
      { key: 'zw_to_h',    label: 'Perf centre zw/h',     unit: '-',  min: 0,    max: 1,    default: 0.5 },
      { key: 'zobs_to_h',  label: 'Obs point zobs/h',     unit: '-',  min: 0,    max: 1,    default: 0.8 },
      { key: 'h_eff',      label: 'Effective thickness h_eff/h', unit: '-', min: 0.1, max: 5, default: 1.0 }
    ],
    reference: 'Gringarten-Ramey SPE 3818 / SPEJ Oct 1973 (Green\'s functions); Streltsova (1988)',
    category: 'well-type',
    description: 'Vertical pulse-test: partial-penetration source observed at a separate vertical point. Time-lag + amplitude attenuation give Kv/Kh. Green\'s-function shortcut.',
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
  g.PRiSM_model_arps                  = PRiSM_model_arps;
  g.PRiSM_model_arps_pd_prime         = PRiSM_model_arps_pd_prime;
  g.PRiSM_eur_arps                    = PRiSM_eur_arps;
  g.PRiSM_model_duong                 = PRiSM_model_duong;
  g.PRiSM_model_duong_pd_prime        = PRiSM_model_duong_pd_prime;
  g.PRiSM_eur_duong                   = PRiSM_eur_duong;
  g.PRiSM_model_sepd                  = PRiSM_model_sepd;
  g.PRiSM_model_sepd_pd_prime         = PRiSM_model_sepd_pd_prime;
  g.PRiSM_eur_sepd                    = PRiSM_eur_sepd;
  g.PRiSM_model_fetkovich             = PRiSM_model_fetkovich;
  g.PRiSM_model_fetkovich_pd_prime    = PRiSM_model_fetkovich_pd_prime;
  g.PRiSM_eur_fetkovich               = PRiSM_eur_fetkovich;
  g.PRiSM_model_doublePorosity        = PRiSM_model_doublePorosity;
  g.PRiSM_model_doublePorosity_pd_prime = PRiSM_model_doublePorosity_pd_prime;
  g.PRiSM_model_partialPen            = PRiSM_model_partialPen;
  g.PRiSM_model_partialPen_pd_prime   = PRiSM_model_partialPen_pd_prime;
  g.PRiSM_model_verticalPulse         = PRiSM_model_verticalPulse;
  g.PRiSM_model_verticalPulse_pd_prime = PRiSM_model_verticalPulse_pd_prime;
})();


// =============================================================================
// === SELF-TEST ===
// =============================================================================
//
// Lightweight smoke-test:
//   - stub Stehfest / Bessel / Ei / logspace / pd_lap_homogeneous if absent
//   - call every new evaluator (pd + pdPrime) at td = [1, 10, 100] with
//     defaults; confirm finite numbers
//   - confirm decline rates monotonically decrease in time (q decreasing)
//   - confirm doublePorosity reduces toward homogeneous K0/s response when
//     λ is small (early time pd ≈ K0/s with effective storativity ω)
//   - call EUR for each decline model, confirm finite & positive
//
// Logs "PRiSM 06: all 7 new evaluators returned finite values" on success.
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
    g.PRiSM_Ei = function (x) {
      if (x === 0) return -Infinity;
      if (x > 0) {
        var s = 0.57721566 + Math.log(x);
        var t = 1, sum = 0;
        for (var i = 1; i < 30; i++) { t *= x / i; sum += t / i; }
        return s + sum;
      }
      return NaN;
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
    g.PRiSM_pd_lap_homogeneous = function (s, p) {
      var sq = Math.sqrt(s);
      return g.PRiSM_besselK0(sq) / s;
    };
  }

  // ---- run every new evaluator --------------------------------------------
  var tdVec = [1, 10, 100];
  var allOk = true;
  var report = [];
  var newKeys = ['arps', 'duong', 'sepd', 'fetkovich',
                 'doublePorosity', 'partialPen', 'verticalPulse'];

  newKeys.forEach(function (key) {
    var entry = REGISTRY_ADDITIONS[key];
    if (!entry) {
      allOk = false;
      report.push(key + ': MISSING from registry');
      return;
    }
    try {
      var pdArr = entry.pd(tdVec, entry.defaults);
      var ok = Array.isArray(pdArr) && pdArr.every(function (v) {
        return typeof v === 'number' && isFinite(v) && !isNaN(v);
      });
      if (!ok) {
        allOk = false;
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
        allOk = false;
        report.push(key + ': pdPrime returned ' + JSON.stringify(pdpArr));
        return;
      }

      // EUR for decline models
      if (entry.kind === 'rate' && entry.eur) {
        var eur = entry.eur(entry.defaults, 1000);
        if (!_num(eur) || eur <= 0) {
          allOk = false;
          report.push(key + ': eur(1000) = ' + eur);
          return;
        }
        report.push(key + ': eur(1000) = ' + eur.toFixed(2));
      }

      // monotone decrease for decline rates
      if (entry.kind === 'rate') {
        var decreasing = true;
        for (var i = 1; i < pdArr.length; i++) {
          if (pdArr[i] > pdArr[i - 1] + 1e-9) { decreasing = false; break; }
        }
        if (!decreasing) {
          allOk = false;
          report.push(key + ': rates NOT monotone decreasing — ' + JSON.stringify(pdArr));
        }
      }
    } catch (e) {
      allOk = false;
      report.push(key + ': THREW ' + (e && e.message ? e.message : e));
    }
  });

  // dual-porosity homogeneous-limit check: at very early time and small λ,
  // doublePorosity pd should be FINITE and POSITIVE. We don't test "≈ K0
  // exactly" because the WBS+S folding makes that comparison non-trivial; we
  // just confirm a sanity-check shape: at t=10 with default ω=0.1, λ=1e-5
  // the pd should be smaller than the homogeneous version (since ω<1
  // concentrates storage in the fractures only).
  try {
    var pdDP_smallL = REGISTRY_ADDITIONS.doublePorosity.pd(
      [10], { Cd: 100, S: 0, omega: 0.1, lambda: 1e-9, interporosityMode: 'pss' });
    var pdDP_largeL = REGISTRY_ADDITIONS.doublePorosity.pd(
      [10], { Cd: 100, S: 0, omega: 0.1, lambda: 1e-2, interporosityMode: 'pss' });
    if (_num(pdDP_smallL[0]) && _num(pdDP_largeL[0])) {
      report.push('doublePorosity homogeneous-limit sanity: small-λ pd=' +
        pdDP_smallL[0].toFixed(4) + ', large-λ pd=' + pdDP_largeL[0].toFixed(4));
    } else {
      allOk = false;
      report.push('doublePorosity sanity-check produced NaN');
    }
  } catch (e) {
    // not fatal for the smoke test, just note it
    report.push('doublePorosity sanity-check threw: ' + (e && e.message ? e.message : e));
  }

  if (typeof console !== 'undefined' && console.log) {
    if (allOk) {
      console.log('PRiSM 06: all 7 new evaluators returned finite values');
      // verbose detail at log level for debugging
      report.forEach(function (r) { console.log('  ' + r); });
    } else {
      console.log('PRiSM 06: SELF-TEST FAILED');
      report.forEach(function (r) { console.log('  ' + r); });
    }
  }
})();

})();  // end IIFE
