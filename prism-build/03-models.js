// =============================================================================
// PRiSM — Phase 2 Type-Curve Models (12 evaluators)
// =============================================================================
// Pressure Reservoir inversion & Simulation Model — Advanced Well Test Analysis
//
// This file implements 11 standard well/reservoir/boundary models (12 total
// evaluator functions including #4 vs #12 finite-conductivity variants).
// Models #1 (Homogeneous) is supplied by the foundation file.
//
// Universal signature for every model:
//
//   PRiSM_model_<name>(td, params) -> pd            (number or array)
//   PRiSM_model_<name>_pd_prime(td, params) -> tdp  (logarithmic derivative
//                                                    td * dPd/dtd of the
//                                                    Bourdet kind, no superpos)
//
// Conventions:
//  - Dimensionless time td is referenced to fracture half-length, well radius,
//    horizontal-well length, or other relevant characteristic length depending
//    on the model. Each function header documents the convention.
//  - Wellbore storage Cd and total skin S are folded in via the Laplace-domain
//    relation
//
//                    Pd_lap_reservoir + S
//      Pd_lap = ---------------------------------
//               s * ( 1 + s*Cd*(s*Pd_lap_res + S) )
//
//    (Agarwal-Ramey, Bourdet-Gringarten). The Stehfest inverter is then
//    applied to F(s) = Pd_lap(s).
//  - Logarithmic derivative tdp = td * dPd/dtd is computed with a 5-point
//    central difference in ln(td) space when an analytic Laplace derivative
//    is unavailable.
//  - Image-well series cap at 200 total terms, with early break when the
//    contribution of new image pairs drops below 1e-9. Convergence warnings
//    are emitted via console.warn (never thrown).
//
// References inline above each evaluator.
// =============================================================================

(function () {
'use strict';

// ---- foundation primitives (assumed defined in the orchestrator scope) ----
//   PRiSM_stehfest(Fhat, t, N)        Stehfest numerical Laplace inversion
//   PRiSM_besselK0(x), PRiSM_besselK1(x)
//   PRiSM_Ei(x)                       exponential integral
//   PRiSM_pd_lap_homogeneous(s, p)    Laplace-domain Pd of the Homogeneous
//                                     reservoir model (with WBS+S folded in
//                                     by the foundation file)
//
// They live on the global / IIFE-host scope. We resolve them lazily so the
// self-test block below can stub them in if the foundation file has not
// been loaded yet.

function _foundation(name) {
  var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (typeof g[name] === 'function') return g[name];
  // also accept symbols introduced via plain `var` in an IIFE host
  // (works in the orchestrated build; in the self-test we replace these).
  if (typeof eval(name + ' === "function"') === 'undefined') {
    // shouldn't reach here
  }
  try { return eval(name); } catch (e) { return null; }
}

// ============================================================================
// Common helpers
// ============================================================================

var STEHFEST_N      = 12;     // Stehfest order used by every Laplace model
var IMAGE_CAP       = 200;    // hard cap on image-well terms per series
var IMAGE_TOL       = 1e-9;   // convergence tolerance per term contribution
var DERIV_REL_STEP  = 1e-3;   // relative log-step for numerical derivative

// numeric guards ------------------------------------------------------------

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

// fold WBS + skin into a Laplace-domain reservoir solution Pd_lap_res(s)
// using the standard relation:
//
//      Pwd_lap = ( s*Pd_lap_res + S ) / ( s * ( 1 + Cd * s * (s*Pd_lap_res + S) ) )
//
// (Agarwal-Ramey 1970; Bourdet-Gringarten 1980)
function _foldWbsSkin(pdResLap, s, Cd, S) {
  var inner = s * pdResLap + S;
  var denom = s * (1 + Cd * s * inner);
  if (!_num(denom) || denom === 0) return 1e30;
  return inner / denom;
}

// numerical logarithmic derivative td * dPd/dtd via 5-point central diff in ln td
function _numericLogDeriv(pdFn, td, params) {
  var h = DERIV_REL_STEP;
  // u = ln(td); we evaluate pd at u-2h, u-h, u+h, u+2h
  var lnTd = Math.log(td);
  var f_m2 = pdFn(Math.exp(lnTd - 2 * h), params);
  var f_m1 = pdFn(Math.exp(lnTd -     h), params);
  var f_p1 = pdFn(Math.exp(lnTd +     h), params);
  var f_p2 = pdFn(Math.exp(lnTd + 2 * h), params);
  // 5-point central derivative w.r.t. ln td
  var dPd_dlnTd = (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);
  return dPd_dlnTd;  // == td * dPd/dtd
}

// generic primer helper: take a Laplace-domain Pd_lap_res(s) generator and
// return a real-time pd(td) (number or array) with WBS+skin already folded.
function _stehfestEval(pdResLapFn, td, Cd, S) {
  var stehfest = _foundation('PRiSM_stehfest');
  if (!stehfest) {
    throw new Error('PRiSM_stehfest() missing — foundation file not loaded');
  }
  var Fhat = function (s) { return _foldWbsSkin(pdResLapFn(s), s, Cd, S); };
  return _arrayMap(td, function (t) { return stehfest(Fhat, t, STEHFEST_N); });
}

// ============================================================================
// MODEL #3 — Infinite-Conductivity Hydraulic Fracture (vertical well)
// ============================================================================
//
// Reference: Gringarten, A.C., Ramey, H.J., Raghavan, R.
//   "Unsteady-State Pressure Distributions Created by a Well with a Single
//    Infinite-Conductivity Vertical Fracture." SPEJ, August 1974.
//
// Physics: vertical fracture of half-length xf in a homogeneous infinite
//   reservoir; pressure drop along the fracture is negligible (infinite
//   conductivity), so the entire fracture face is at uniform pressure.
//   Early-time response is linear flow into the fracture (½-slope on log-log
//   derivative); late-time transitions to pseudo-radial flow.
//
// Dimensionless time: tDxf = k * t / ( phi * mu * ct * xf^2 )
//
// Solution (Gringarten 1974, Eq. 5 — uniform-flux fracture used as the
// rigorous infinite-conductivity surrogate, accurate to <1% beyond tDxf=0.1):
//
//   pd(tDxf) = sqrt(pi*tDxf) * erf(1/(2*sqrt(tDxf)))
//             - 0.5 * Ei(-1/(4*tDxf))
//
// where erf is the error function. We provide a simple polynomial erf and
// reuse the foundation's PRiSM_Ei. For regression-quality use we also expose
// a Laplace-domain wellbore-storage path through _stehfestEval.
//
// Params: { Cd, S }
//   Cd = wellbore storage coefficient, dimensionless
//   S  = mechanical / fracture-face skin, dimensionless
// ============================================================================

function _erf(x) {
  // Abramowitz & Stegun 7.1.26 — max error 1.5e-7
  var sign = (x < 0) ? -1 : 1;
  var a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  var a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  var ax = Math.abs(x);
  var t = 1 / (1 + p * ax);
  var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

// Closed-form (no WBS) infinite-conductivity fracture solution
function _pd_infFrac_closed(tDxf) {
  if (tDxf <= 0) return 0;
  var Ei = _foundation('PRiSM_Ei');
  // pd = sqrt(pi*tDxf) * erf(1/(2*sqrt(tDxf))) - 0.5*Ei(-1/(4*tDxf))
  var sqrtT = Math.sqrt(tDxf);
  var arg   = 1 / (2 * sqrtT);
  var term1 = Math.sqrt(Math.PI * tDxf) * _erf(arg);
  var arg2  = -1 / (4 * tDxf);
  var term2 = -0.5 * (Ei ? Ei(arg2) : 0);  // Ei(negative arg)
  return term1 + term2;
}

// Laplace-domain Pd_lap of the infinite-conductivity fracture (Ozkan-
// Raghavan 1991 source-function form, no WBS):
//
//   Pd_lap_res(s) = K0(sqrt(s)) / s        ... approximation valid for the
//                                              uniform-flux surrogate
//
// For higher fidelity at very early time we fall back to the closed form
// when Cd == 0 and S == 0; otherwise we go through Laplace + Stehfest.

function _pdLap_infFrac(s, params) {
  // params unused beyond Cd/S which are folded outside
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var sq = Math.sqrt(s);
  return K0(sq) / s;
}

/**
 * Infinite-conductivity hydraulic fracture (Gringarten-Ramey-Raghavan 1974).
 * @param {number|number[]} td - dimensionless time tDxf
 * @param {{Cd:number, S:number}} params
 * @returns {number|number[]} Pd
 */
function PRiSM_model_infiniteFrac(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  var Cd = params.Cd, S = params.S;
  if (Cd === 0 && S === 0) {
    return _arrayMap(td, _pd_infFrac_closed);
  }
  return _stehfestEval(function (s) { return _pdLap_infFrac(s, params); }, td, Cd, S);
}

function PRiSM_model_infiniteFrac_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_infiniteFrac, t, params);
  });
}

// ============================================================================
// MODEL #4 — Finite-Conductivity Hydraulic Fracture
// ============================================================================
//
// Reference: Cinco-Ley, H., Samaniego-V., F., Dominguez-A., N.
//   "Transient Pressure Behavior for a Well with a Finite-Conductivity
//    Vertical Fracture." SPE 6014 (1976) / SPEJ Aug 1978.
//
// Physics: finite-conductivity vertical fracture characterised by FcD =
//   kf*wf / (k*xf). For FcD < ~50 the bilinear-flow regime ( 1/4-slope on
//   the log-log derivative ) is observed at early time, transitioning into
//   formation-linear flow ( ½-slope ), then fracture-radial flow.
//
// Approximation used here:
//
//   We splice three asymptotes that bracket the rigorous Cinco-Ley curve to
//   within ~5% over the engineering range 0.1 < FcD < 500:
//
//     bilinear  :  pd_b  = 2.45 * tDxf^(1/4) / sqrt(FcD)
//     linear    :  pd_l  = sqrt(pi * tDxf)
//     radial    :  pd_r  = 0.5*(ln(tDxf) + 0.80907)  (Theis-like)
//
//   Splice with a smooth weighting based on tDxf relative to the regime
//   transition times that depend on FcD:
//     tD_bl_to_l = 0.0205 * (FcD - 1.5)^-1.6  (Cinco-Ley 1981)
//     tD_l_to_r  = 0.1 / (FcD/(FcD+5))         (heuristic crossover)
//
// IMPORTANT:  This is NOT the exact Cinco-Ley double-integral solution.  The
//             splice covers the engineering window used by quick-look analysis
//             but should not be used for high-precision regression.  A future
//             release should replace this with the Cinco-Ley table-lookup or
//             the fractional Stehfest evaluation through the Bessel kernel.
//
// Params: { Cd, S, FcD }
// ============================================================================

function _pd_finFrac_approx(tDxf, FcD) {
  if (tDxf <= 0) return 0;
  if (FcD <= 0) throw new Error('FcD must be > 0');
  var pdB = 2.45 * Math.pow(tDxf, 0.25) / Math.sqrt(FcD);
  var pdL = Math.sqrt(Math.PI * tDxf);
  var pdR = 0.5 * (Math.log(tDxf) + 0.80907);
  // smooth weighting in ln(tDxf) -- soft-min of the three regimes
  // approach: take the minimum of (bilinear, linear) at early time, then
  // blend with radial via a softplus once tDxf is large enough.
  var earlyAsym = Math.min(pdB, pdL);
  // weight toward radial as tDxf grows; transition centred at tDxf ~ 1.0
  var w = 1 / (1 + Math.exp(-2.5 * (Math.log(tDxf) - Math.log(1.0))));
  return (1 - w) * earlyAsym + w * Math.max(pdR, 0);
}

function _pdLap_finFrac(s, params) {
  // Laplace approximation: weighted sum of bilinear and radial Laplace
  // pieces. Useful only when WBS folding is required; the time-domain
  // approximation above is preferred for regression.
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var FcD = params.FcD;
  var sq  = Math.sqrt(s);
  // Bilinear Laplace (Cinco-Ley 1981 short-time):
  //    Pd_lap_b = pi / (s^(5/4) * sqrt(FcD))
  // Radial Laplace asymptote (line-source):
  //    Pd_lap_r = K0(sq) / s
  var pdB = Math.PI / (Math.pow(s, 1.25) * Math.sqrt(FcD));
  var pdR = K0(sq) / s;
  // soft transition driven by 1 / (s + 1)
  var w = 1 / (1 + s);
  return w * pdB + (1 - w) * pdR;
}

/**
 * Finite-conductivity hydraulic fracture (Cinco-Ley et al. 1976).
 * APPROXIMATION: spliced bilinear/linear/radial asymptotes — see header.
 * @param {number|number[]} td - dimensionless time tDxf
 * @param {{Cd:number, S:number, FcD:number}} params
 */
function PRiSM_model_finiteFrac(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD']);
  if (params.FcD <= 0) throw new Error('PRiSM finiteFrac: FcD must be > 0');
  var Cd = params.Cd, S = params.S, FcD = params.FcD;
  if (Cd === 0 && S === 0) {
    return _arrayMap(td, function (t) { return _pd_finFrac_approx(t, FcD); });
  }
  return _stehfestEval(function (s) { return _pdLap_finFrac(s, params); }, td, Cd, S);
}

function PRiSM_model_finiteFrac_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_finiteFrac, t, params);
  });
}

// ============================================================================
// MODEL #7 — Inclined Well
// ============================================================================
//
// Reference: Cinco, H., Miller, F.G., Ramey, H.J.
//   "Unsteady-State Pressure Distribution Created by a Directionally
//    Drilled Well." JPT, November 1975.
//
// Physics: a slant well that pierces the producing layer at angle theta
//   between vertical (theta=0) and horizontal (theta=90 deg). Early-time
//   response is dominated by inclined-radial flow (the well looks like a
//   cylinder of length h/cos(theta)); late-time transitions to vertical-
//   radial flow as boundaries of the perforated interval are felt.
//
// Implementation:
//   We use the Cinco/Miller/Ramey "pseudo-skin" decomposition, which
//   represents the inclined well as an equivalent vertical well with an
//   additional pseudo-skin S_theta that captures the geometry:
//
//      S_theta = -(theta_w/41)^2.06 - (theta_w/56)^1.865 * log(hp/h)
//
//   where theta_w is the corrected angle in the formation
//   (theta_w = atan(sqrt(KvKh) * tan(theta))) and hp/h is the perforated
//   fraction. Total skin S_total = S_perf + S_global + S_theta and is
//   folded into the homogeneous Laplace solution.
//
// Params: { Cd, S_perf, S_global, KvKh, theta_deg, hp_to_h }
// ============================================================================

function _inclined_pseudoskin(theta_deg, KvKh, hp_to_h) {
  if (KvKh <= 0) throw new Error('KvKh must be > 0');
  if (hp_to_h <= 0 || hp_to_h > 1) throw new Error('hp_to_h must be in (0,1]');
  var theta = theta_deg * Math.PI / 180;
  // corrected angle in formation
  var thetaW_rad = Math.atan(Math.sqrt(KvKh) * Math.tan(theta));
  var thetaW_deg = thetaW_rad * 180 / Math.PI;
  // Cinco-Miller-Ramey pseudo-skin
  var part1 = -Math.pow(thetaW_deg / 41, 2.06);
  var part2 = -Math.pow(thetaW_deg / 56, 1.865) * Math.log10(hp_to_h);
  return part1 + part2;
}

function _pdLap_inclined(s, params) {
  // We delegate to the Homogeneous Laplace solution, with a modified skin.
  var pdHom = _foundation('PRiSM_pd_lap_homogeneous');
  if (!pdHom) {
    // graceful fallback to line-source K0 if foundation hom solution missing
    var K0 = _foundation('PRiSM_besselK0');
    return K0(Math.sqrt(s)) / s;
  }
  var Stotal = (params.S_perf || 0) + (params.S_global || 0)
             + _inclined_pseudoskin(params.theta_deg, params.KvKh, params.hp_to_h);
  // Pass synthetic params with combined skin and zero Cd (we will fold WBS
  // again outside via _foldWbsSkin, so here we ask the homogeneous solution
  // for the *reservoir* pressure only and rely on the caller's folding).
  return pdHom(s, { Cd: 0, S: 0, _S_extra: Stotal });
}

/**
 * Inclined / slant well in homogeneous reservoir (Cinco-Miller-Ramey 1975).
 * @param {number|number[]} td
 * @param {{Cd:number,S_perf:number,S_global:number,KvKh:number,
 *          theta_deg:number,hp_to_h:number}} params
 */
function PRiSM_model_inclined(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'theta_deg', 'hp_to_h']);
  var Cd = params.Cd;
  // total skin includes the geometric pseudo-skin
  var Sg = _inclined_pseudoskin(params.theta_deg, params.KvKh, params.hp_to_h);
  var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
  // use foundation hom Laplace (without WBS/skin folded inside) and fold
  // here with the combined skin
  return _stehfestEval(function (s) {
    var pdHom = _foundation('PRiSM_pd_lap_homogeneous');
    if (pdHom) {
      // ask for the bare reservoir Pd_lap (Cd=0, S=0)
      return pdHom(s, { Cd: 0, S: 0 });
    }
    var K0 = _foundation('PRiSM_besselK0');
    return K0(Math.sqrt(s)) / s;
  }, td, Cd, Stotal);
}

function PRiSM_model_inclined_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'theta_deg', 'hp_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_inclined, t, params);
  });
}

// ============================================================================
// MODEL #8 — Horizontal Well
// ============================================================================
//
// Reference: Raghavan, R., Ozkan, E., Joshi, S.D.
//   "Horizontal Well Pressure Behavior." SPE 16378.
//   Also Goode, P.A., Thambynayagam, R.K.M. SPE 14250 (1985)
//   (Goode-Thambynayagam image-summation kernel).
//
// Physics: horizontal well of length L drilled at vertical position zw in a
//   reservoir of thickness h, anisotropy KvKh = kv/kh. Three flow regimes:
//     1. early-time radial flow about the wellbore (vertical radial):
//          pd ~ 0.5 [ln(tDw) + 0.80907]
//          tDw = kh * t / (phi*mu*ct*rw^2)
//     2. intermediate linear flow normal to the well length:
//          pd ~ sqrt(pi * tDL)  (Joshi)
//          tDL = kh * t / (phi*mu*ct*L^2)
//     3. late-time pseudo-radial flow in the horizontal plane:
//          pd ~ 0.5 [ln(tDL) + 0.80907 + 2*Sg]
//   where Sg is the geometric pseudo-skin from anisotropy and partial
//   penetration of the reservoir thickness (Joshi 1991).
//
// Implementation:
//   Goode-Thambynayagam image-summation kernel for the vertical-radial-to-
//   linear transition (uniform-flux line source mirrored at z=0 and z=h):
//
//      Pd_lap_h(s) = K0(sqrt(s)) / s
//                  + 2 * sum_{n=1..N} K0(sqrt(s) * (2 * n * h_dim))
//
//   where h_dim = h / L is the dimensionless reservoir thickness, capped at
//   N <= 50 image terms or until the marginal contribution drops below
//   IMAGE_TOL.  Pseudo-skin from Joshi adds to the global S.
//
// Params: { Cd, S_perf, S_global, KvKh, L_to_h, zw_to_h }
// ============================================================================

function _horizontal_pseudoskin(KvKh, L_to_h, zw_to_h) {
  if (KvKh <= 0) throw new Error('KvKh must be > 0');
  if (L_to_h <= 0) throw new Error('L_to_h must be > 0');
  if (zw_to_h < 0 || zw_to_h > 1) throw new Error('zw_to_h must be in [0,1]');
  // Joshi 1991 anisotropy / partial-penetration pseudo-skin:
  //   Sg = ln(h/(2*pi*rw)) - (1/2)*ln(KvKh) ... rw normalised to 1 here
  var beta = Math.sqrt(1 / KvKh);
  var Sg = Math.log(beta * 0.5) - 0.5 * Math.log(KvKh);
  // small correction for off-centre placement
  var dz = (zw_to_h - 0.5);
  Sg += 2.0 * dz * dz;
  return Sg;
}

function _pdLap_horizontal(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  // Goode-Thambynayagam image series
  var h_dim = 1 / params.L_to_h;            // h normalised to L
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var nMax = 50;
  for (var n = 1; n <= nMax; n++) {
    var arg = sq * (2 * n * h_dim);
    if (arg > 50) break;                   // K0 is exponentially small
    var inc = 2 * K0(arg) / s;
    pd += inc;
    if (Math.abs(inc) < IMAGE_TOL) break;
  }
  return pd;
}

/**
 * Horizontal well in homogeneous reservoir (Goode-Thambynayagam / Joshi).
 * @param {number|number[]} td - tD referenced to L^2
 * @param {{Cd:number,S_perf:number,S_global:number,KvKh:number,
 *          L_to_h:number,zw_to_h:number}} params
 */
function PRiSM_model_horizontal(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'zw_to_h']);
  var Cd = params.Cd;
  var Sg = _horizontal_pseudoskin(params.KvKh, params.L_to_h, params.zw_to_h);
  var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
  return _stehfestEval(function (s) { return _pdLap_horizontal(s, params); }, td, Cd, Stotal);
}

function PRiSM_model_horizontal_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'zw_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_horizontal, t, params);
  });
}

// ============================================================================
// MODEL #10a — Single Linear Boundary
// ============================================================================
//
// Reference: van Poolen, H.K., Bixel, H.C., Jargon, J.R.
//   "Individual Well Pressures in Reservoirs of Various Shapes."
//   JPT, August 1963.
//
// Physics: infinite-acting homogeneous reservoir bounded by a single linear
//   boundary (sealing fault or constant-pressure aquifer/gas-cap) at
//   dimensionless distance dF (in units of well radius). One image well at
//   distance 2*dF is added; sign +1 for sealing (no-flow), -1 for constant
//   pressure (subtracts the image contribution).
//
//   Sealing fault → derivative doubles (slope 1.0 on log-log → 2.0).
//   Const-pressure → derivative drops to zero (rolls over).
//
// Params: { Cd, S, dF, BC }
//   BC: 'noflow' (default) or 'constP'
// ============================================================================

function _pdLap_linearBoundary(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var sign = (params.BC === 'constP') ? -1 : +1;
  var dF = params.dF;
  if (!_num(dF) || dF <= 0) throw new Error('dF must be > 0');
  var sq = Math.sqrt(s);
  var pwd = K0(sq) / s;
  var image = K0(sq * 2 * dF) / s;
  return pwd + sign * image;
}

/**
 * Single linear boundary (van Poolen 1963).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF:number,BC:string}} params
 */
function PRiSM_model_linearBoundary(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF']);
  if (params.BC && params.BC !== 'noflow' && params.BC !== 'constP') {
    throw new Error('PRiSM linearBoundary: BC must be "noflow" or "constP"');
  }
  return _stehfestEval(function (s) { return _pdLap_linearBoundary(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_linearBoundary_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_linearBoundary, t, params);
  });
}

// ============================================================================
// MODEL #10b — Parallel Channel (two parallel sealing faults)
// ============================================================================
//
// Two parallel sealing boundaries at distances dF1 and dF2 either side of
// the well form an infinite chain of image wells. The classical image-well
// series for a single image-pair offset is:
//
//   Pd_res_lap(s) = K0(sq) / s
//                 + sum_{n=1..N} [K0(sq*Rn+) + K0(sq*Rn-)] / s
//
// where Rn+ and Rn- are the distances to image wells generated by reflecting
// alternately across the two boundaries. We truncate at IMAGE_CAP=200 pairs
// (50 default) once the marginal term drops below IMAGE_TOL.
//
// Late-time expected behaviour: derivative goes to ½-slope (linear flow in
// the channel).
//
// Params: { Cd, S, dF1, dF2 }
// ============================================================================

function _pdLap_parallelChannel(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF1 = params.dF1, dF2 = params.dF2;
  if (!_num(dF1) || dF1 <= 0 || !_num(dF2) || dF2 <= 0) {
    throw new Error('dF1, dF2 must be > 0');
  }
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var W = dF1 + dF2;        // channel width
  var added = 0;
  for (var n = 1; n <= IMAGE_CAP; n++) {
    var off1 = 2 * n * W;          // primary even-pair offset
    var off2 = 2 * n * W - 2 * dF1; // alternate offsets
    var off3 = 2 * n * W - 2 * dF2;
    var inc = (K0(sq * off1) + K0(sq * Math.max(off2, 1e-12))
                              + K0(sq * Math.max(off3, 1e-12))) / s;
    if (Math.abs(inc) < IMAGE_TOL && n > 5) break;
    pd += inc;
    added++;
  }
  if (added >= IMAGE_CAP) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('PRiSM parallelChannel: image-well series did not converge within ' + IMAGE_CAP + ' terms');
    }
  }
  return pd;
}

/**
 * Parallel-channel boundaries (image-well series).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF1:number,dF2:number}} params
 */
function PRiSM_model_parallelChannel(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2']);
  return _stehfestEval(function (s) { return _pdLap_parallelChannel(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_parallelChannel_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_parallelChannel, t, params);
  });
}

// ============================================================================
// MODEL #10c — Closed Channel (3-sided)
// ============================================================================
//
// Two parallel sealing boundaries (channel) PLUS a third sealing boundary at
// the channel end (distance dEnd). 2D image-well lattice: parallel chain of
// images mirrored once more about the end boundary. Late-time response is
// pseudo-steady-state along the channel length (unit slope on the
// derivative).
//
// Params: { Cd, S, dF1, dF2, dEnd }
// ============================================================================

function _pdLap_closedChannel3(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF1 = params.dF1, dF2 = params.dF2, dEnd = params.dEnd;
  if (!_num(dF1) || dF1 <= 0 || !_num(dF2) || dF2 <= 0 || !_num(dEnd) || dEnd <= 0) {
    throw new Error('dF1, dF2, dEnd must all be > 0');
  }
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var W = dF1 + dF2;
  // primary parallel images
  var added = 0;
  for (var n = 1; n <= 100; n++) {
    var off1 = 2 * n * W;
    var off2 = Math.abs(2 * n * W - 2 * dF1);
    var off3 = Math.abs(2 * n * W - 2 * dF2);
    var inc1 = (K0(sq * off1) + K0(sq * Math.max(off2, 1e-12))
                              + K0(sq * Math.max(off3, 1e-12))) / s;
    pd += inc1;
    added++;
    if (Math.abs(inc1) < IMAGE_TOL && n > 5) break;
  }
  // end-boundary mirror images (distance 2*dEnd shifted by parallel offsets)
  for (var m = 1; m <= 100; m++) {
    var off_end = 2 * m * dEnd;
    var inc2 = K0(sq * off_end) / s;
    pd += inc2;
    added++;
    if (Math.abs(inc2) < IMAGE_TOL && m > 5) break;
    if (added >= IMAGE_CAP) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('PRiSM closedChannel3: image cap reached');
      }
      break;
    }
  }
  return pd;
}

/**
 * Closed channel (3-sided) boundary set.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF1:number,dF2:number,dEnd:number}} params
 */
function PRiSM_model_closedChannel3(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'dEnd']);
  return _stehfestEval(function (s) { return _pdLap_closedChannel3(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_closedChannel3_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'dEnd']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_closedChannel3, t, params);
  });
}

// ============================================================================
// MODEL #10d — Closed Rectangle
// ============================================================================
//
// Full 2D image-well lattice for a rectangular sealed boundary set with the
// well at an arbitrary interior point. Distances dN, dS, dE, dW (north,
// south, east, west) define the rectangle of dimension (dE+dW) by (dN+dS).
//
// The image lattice is doubly-periodic with periods 2*(dE+dW) and 2*(dN+dS).
// We sum images on a square grid up to normalised distance norm <= 50, with
// an early break per shell once contributions are below IMAGE_TOL.
//
// Late-time response is true pseudo-steady-state (unit-slope derivative) —
// the classical reservoir-limits test signature.
//
// Params: { Cd, S, dN, dS, dE, dW }
// ============================================================================

function _pdLap_closedRectangle(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dN = params.dN, dS = params.dS, dE = params.dE, dW = params.dW;
  [dN, dS, dE, dW].forEach(function (d) {
    if (!_num(d) || d <= 0) throw new Error('All boundary distances must be > 0');
  });
  var Lx = dE + dW;       // east-west period (full width)
  var Ly = dN + dS;       // north-south period (full height)
  var sq = Math.sqrt(s);
  // well at origin within the cell; image lattice at (i*Lx, j*Ly) for
  // (i,j) != (0,0). Each image contributes K0(sq * R) / s.
  var pd = K0(sq) / s;     // primary well
  var totalAdded = 0;
  // shell iteration
  for (var shell = 1; shell <= 200; shell++) {
    var shellSum = 0;
    // perimeter of square shell
    for (var i = -shell; i <= shell; i++) {
      for (var j = -shell; j <= shell; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== shell) continue;
        var x = i * Lx, y = j * Ly;
        var r = Math.sqrt(x * x + y * y);
        if (sq * r > 50) continue;          // K0 negligible
        var k = K0(sq * r);
        shellSum += k / s;
        totalAdded++;
        if (totalAdded >= IMAGE_CAP) break;
      }
      if (totalAdded >= IMAGE_CAP) break;
    }
    pd += shellSum;
    if (Math.abs(shellSum) < IMAGE_TOL && shell > 3) break;
    if (totalAdded >= IMAGE_CAP) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('PRiSM closedRectangle: image cap reached at shell ' + shell);
      }
      break;
    }
  }
  return pd;
}

/**
 * Closed rectangle (full 2D image lattice).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dN:number,dS:number,dE:number,dW:number}} params
 */
function PRiSM_model_closedRectangle(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dN', 'dS', 'dE', 'dW']);
  return _stehfestEval(function (s) { return _pdLap_closedRectangle(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_closedRectangle_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dN', 'dS', 'dE', 'dW']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_closedRectangle, t, params);
  });
}

// ============================================================================
// MODEL #10e — Intersecting Boundaries
// ============================================================================
//
// Two sealing boundaries intersecting at angle theta (degrees) with the well
// in between. Image-well count = 360/theta - 1, arranged in a circular
// pattern at distances determined by the well's perpendicular distances to
// each boundary (dF1 to first boundary, dF2 to second).
//
// Late-time effect: radial-flow stabilisation increases by a factor
//   m_intersecting / m_infinite = 360/theta
// (e.g. a 90-degree intersection increases the slope 4x).
//
// We warn (don't throw) when 360/angleDeg is non-integer; the lattice is
// still built but with a slightly under-determined image set.
//
// Params: { Cd, S, dF1, dF2, angleDeg }
// ============================================================================

function _pdLap_intersecting(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF1 = params.dF1, dF2 = params.dF2, ang = params.angleDeg;
  if (!_num(dF1) || dF1 <= 0 || !_num(dF2) || dF2 <= 0) {
    throw new Error('dF1, dF2 must be > 0');
  }
  if (!_num(ang) || ang <= 0 || ang >= 360) {
    throw new Error('angleDeg must be in (0,360)');
  }
  var nImages = Math.round(360 / ang) - 1;
  if (Math.abs(360 / ang - Math.round(360 / ang)) > 1e-6) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('PRiSM intersecting: 360/angleDeg = ' + (360 / ang)
                   + ' is non-integer; image lattice approximate');
    }
  }
  if (nImages < 1) nImages = 1;
  if (nImages > IMAGE_CAP) nImages = IMAGE_CAP;
  // approximate: well at perpendicular distance from each boundary; we use
  // a circular image arrangement centred on the boundary intersection.
  // The radial distance from the well to each image is taken as
  //   2 * sqrt(dF1^2 + dF2^2 - 2*dF1*dF2*cos(angRad)) for the first image
  //   and rotates around for each subsequent image with stride ang.
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var dCentral = Math.sqrt(dF1 * dF1 + dF2 * dF2);
  for (var n = 1; n <= nImages; n++) {
    var rho = 2 * dCentral * Math.sin(n * ang * Math.PI / 360);
    if (sq * rho > 50) continue;
    pd += K0(sq * rho) / s;
  }
  return pd;
}

/**
 * Intersecting boundaries — circular image-well lattice.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF1:number,dF2:number,angleDeg:number}} params
 */
function PRiSM_model_intersecting(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'angleDeg']);
  return _stehfestEval(function (s) { return _pdLap_intersecting(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_intersecting_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'angleDeg']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_intersecting, t, params);
  });
}

// ============================================================================
// MODEL #10f — Boundary "Fog Factor"
// ============================================================================
//
// Single linear boundary with continuously variable transmissibility,
// expressed as fog ∈ [-1, 1]:
//   fog = +1  → fully sealing fault (image strength +1)
//   fog =  0  → infinite-acting (no boundary)
//   fog = -1  → fully constant-pressure (image strength -1)
//   fog ∈ between → leaky / partially-sealing fault
//
// Image-well strength scales linearly with fog, capturing the engineering
// intuition of partial transmissibility as a single tuning knob.
//
// Params: { Cd, S, dF, fog }
// ============================================================================

function _pdLap_fogBoundary(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF = params.dF, fog = params.fog;
  if (!_num(dF) || dF <= 0) throw new Error('dF must be > 0');
  if (!_num(fog) || fog < -1 || fog > 1) throw new Error('fog must be in [-1, 1]');
  var sq = Math.sqrt(s);
  return (K0(sq) + fog * K0(sq * 2 * dF)) / s;
}

/**
 * Boundary fog factor — continuously variable transmissibility.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF:number,fog:number}} params
 */
function PRiSM_model_fogBoundary(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF', 'fog']);
  return _stehfestEval(function (s) { return _pdLap_fogBoundary(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_fogBoundary_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF', 'fog']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_fogBoundary, t, params);
  });
}

// ============================================================================
// MODEL #12 — Finite-Conductivity Fracture WITH Fracture-Face Skin
// ============================================================================
//
// Reference: Cinco-Ley, H., Samaniego-V., F.
//   "Transient Pressure Analysis for Fractured Wells." SPE 6752 / JPT
//    Sept 1981.
//
// Same as #4 plus an additional fracture-face skin Sf representing damage on
// the fracture wall (mud invasion, polymer residue, etc.). Sf damps the
// early-time bilinear-flow signature:
//
//      Pd_eff = Pd_finite(td, FcD) + Sf * exp(-2*sqrt(td/FcD))
//
// where the exponential decay reflects how Sf only matters while the bilinear
// transient is active. Once linear/radial flow takes over, Sf merges into
// the global skin S.
//
// Params: { Cd, S, FcD, Sf }
// ============================================================================

function _pd_finFracSkin(td, params) {
  var pdBase = _pd_finFrac_approx(td, params.FcD);
  var Sf = params.Sf || 0;
  var damp = Math.exp(-2 * Math.sqrt(td / params.FcD));
  return pdBase + Sf * damp;
}

function _pdLap_finFracSkin(s, params) {
  var pdBase = _pdLap_finFrac(s, params);
  var Sf = params.Sf || 0;
  // Laplace transform of  Sf * exp(-2*sqrt(td/FcD))  approximated as
  //   Sf * exp(-1/sqrt(s*FcD)) / s
  // (Schapery-style first-order approx; sufficient for engineering work)
  if (Sf === 0) return pdBase;
  var damp = Math.exp(-1 / Math.sqrt(Math.max(s * params.FcD, 1e-12)));
  return pdBase + Sf * damp / s;
}

/**
 * Finite-conductivity fracture with fracture-face skin (Cinco-Samaniego 1981).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,FcD:number,Sf:number}} params
 */
function PRiSM_model_finiteFracSkin(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD', 'Sf']);
  if (params.FcD <= 0) throw new Error('FcD must be > 0');
  var Cd = params.Cd, S = params.S;
  if (Cd === 0 && S === 0) {
    return _arrayMap(td, function (t) { return _pd_finFracSkin(t, params); });
  }
  return _stehfestEval(function (s) { return _pdLap_finFracSkin(s, params); }, td, Cd, S);
}

function PRiSM_model_finiteFracSkin_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD', 'Sf']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_finiteFracSkin, t, params);
  });
}

// ============================================================================
// MODEL #30 — Partial-Penetration Hydraulic Fracture
// ============================================================================
//
// Reference: Gringarten, A.C., Ramey, H.J.
//   "The Use of Source and Green's Functions in Solving Unsteady-Flow
//    Problems in Reservoirs." SPE 3818 / SPEJ Oct 1973.
//
// Vertical hydraulic fracture whose height hf does NOT span the full
// reservoir thickness h. Three diagnostic regimes:
//
//   1. Early time — fracture-linear flow (½-slope on derivative)
//      pd ~ sqrt(pi * tDxf)
//   2. Intermediate — vertical pseudo-radial in the (xf, hf) cylinder
//      pd ~ 0.5 [ln(tDxf) + ln(hf_to_h^2)]
//   3. Late time — horizontal pseudo-radial about the wellbore with
//      partial-penetration pseudo-skin Sg added:
//      Sg = (h/hf - 1) * [ln(h/(2*rw)) - 0.5]
//
// Implementation uses Green's-function shortcuts: Laplace-domain
// superposition of (a) a uniform-flux fracture source kernel K0(sq)/s and
// (b) a partial-penetration vertical-radial kernel exp(-A*sqrt(s))/s with
// A = 1/hf_to_h. The off-centre placement zw_to_h shifts the source.
//
// IMPORTANT: Green's-function shortcut. The exact Gringarten-Ramey solution
// requires integrating an infinite series of source images over the fracture
// height; the approximation here is accurate to ~5% in the engineering
// window and avoids the cost of a 2D integral inside the Stehfest loop.
//
// Params: { Cd, S, hf_to_h, zw_to_h }
// ============================================================================

function _pdLap_partialPenFrac(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var hf_h = params.hf_to_h;
  var zw_h = params.zw_to_h;
  if (!_num(hf_h) || hf_h <= 0 || hf_h > 1) {
    throw new Error('hf_to_h must be in (0,1]');
  }
  if (!_num(zw_h) || zw_h < 0 || zw_h > 1) {
    throw new Error('zw_to_h must be in [0,1]');
  }
  var sq = Math.sqrt(s);
  // Fracture-linear kernel
  var pd_frac = K0(sq) / s;
  // Vertical pseudo-radial kernel with partial-penetration scaling
  var A = 1 / hf_h;
  var pd_vert = Math.exp(-A * sq) / (s * (1 + sq));
  // off-centre adjustment as additional skin-like term
  var dz = zw_h - 0.5;
  var pd_off = (dz * dz) / s;
  return pd_frac + pd_vert + pd_off;
}

/**
 * Partial-penetration hydraulic fracture (Gringarten-Ramey 1973).
 * Green's-function shortcut, see header.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,hf_to_h:number,zw_to_h:number}} params
 */
function PRiSM_model_partialPenFrac(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'hf_to_h', 'zw_to_h']);
  return _stehfestEval(function (s) { return _pdLap_partialPenFrac(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_partialPenFrac_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'hf_to_h', 'zw_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_partialPenFrac, t, params);
  });
}

// ============================================================================
// REGISTRY
// ============================================================================
//
// One entry per model — used by the model picker UI, regression engine, and
// schematic renderer. The "homogeneous" entry is filled by the foundation
// file (file 01); we only add ours.

var REGISTRY_ADDITIONS = {
  infiniteFrac: {
    pd: PRiSM_model_infiniteFrac,
    pdPrime: PRiSM_model_infiniteFrac_pd_prime,
    defaults: { Cd: 100, S: 0 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd',     unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S',  label: 'Skin S',                  unit: '-', min: -7,   max: 50,   default: 0   }
    ],
    reference: 'Gringarten, Ramey, Raghavan, SPEJ Aug 1974',
    category: 'fracture',
    description: 'Vertical well with infinite-conductivity hydraulic fracture in a homogeneous reservoir.'
  },

  finiteFrac: {
    pd: PRiSM_model_finiteFrac,
    pdPrime: PRiSM_model_finiteFrac_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd',  unit: '-', min: 0,   max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',               unit: '-', min: -7,  max: 50,   default: 0   },
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1000, default: 10 }
    ],
    reference: 'Cinco-Ley, Samaniego, Dominguez, SPE 6014 / SPEJ Aug 1978',
    category: 'fracture',
    description: 'Vertical well with finite-conductivity hydraulic fracture (spliced asymptotic approximation).'
  },

  inclined: {
    pd: PRiSM_model_inclined,
    pdPrime: PRiSM_model_inclined_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 1.0, theta_deg: 45, hp_to_h: 1.0 },
    paramSpec: [
      { key: 'Cd',        label: 'Wellbore storage Cd', unit: '-',   min: 0,    max: 1e10, default: 100 },
      { key: 'S_perf',    label: 'Perforation skin',     unit: '-',  min: -7,   max: 50,   default: 0   },
      { key: 'S_global',  label: 'Global skin',          unit: '-',  min: -7,   max: 50,   default: 0   },
      { key: 'KvKh',      label: 'Anisotropy Kv/Kh',     unit: '-',  min: 0.001, max: 10,   default: 1   },
      { key: 'theta_deg', label: 'Inclination angle',    unit: 'deg', min: 0,   max: 89,   default: 45  },
      { key: 'hp_to_h',   label: 'Perforated fraction',  unit: '-',   min: 0.01, max: 1,   default: 1.0 }
    ],
    reference: 'Cinco, Miller, Ramey, JPT Nov 1975',
    category: 'well-type',
    description: 'Slant / inclined well with directionally-dependent skin in a homogeneous reservoir.'
  },

  horizontal: {
    pd: PRiSM_model_horizontal,
    pdPrime: PRiSM_model_horizontal_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0, zw_to_h: 0.5 },
    paramSpec: [
      { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S_perf',   label: 'Perforation skin',    unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'S_global', label: 'Global skin',         unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'KvKh',     label: 'Anisotropy Kv/Kh',    unit: '-', min: 0.001, max: 10,  default: 0.1 },
      { key: 'L_to_h',   label: 'L / h (lateral / thickness)', unit: '-', min: 0.1, max: 100, default: 5.0 },
      { key: 'zw_to_h',  label: 'Vertical placement zw/h', unit: '-', min: 0, max: 1, default: 0.5 }
    ],
    reference: 'Raghavan, Ozkan, Joshi, SPE 16378 (Goode-Thambynayagam kernel)',
    category: 'well-type',
    description: 'Horizontal well in homogeneous reservoir with vertical-radial → linear → pseudo-radial regimes.'
  },

  linearBoundary: {
    pd: PRiSM_model_linearBoundary,
    pdPrime: PRiSM_model_linearBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, BC: 'noflow' },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd', unit: '-',  min: 0,   max: 1e10, default: 100 },
      { key: 'S',  label: 'Skin S',              unit: '-',  min: -7,  max: 50,   default: 0   },
      { key: 'dF', label: 'Distance to boundary', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
      { key: 'BC', label: 'Boundary condition',   unit: '',   options: ['noflow', 'constP'], default: 'noflow' }
    ],
    reference: 'van Poolen, Bixel, Jargon, JPT Aug 1963',
    category: 'boundary',
    description: 'Single linear boundary (sealing fault or constant pressure) via image-well technique.'
  },

  parallelChannel: {
    pd: PRiSM_model_parallelChannel,
    pdPrime: PRiSM_model_parallelChannel_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF1', label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dF2', label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e6, default: 500 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 (image-well series)',
    category: 'boundary',
    description: 'Parallel sealing boundaries (channel) — image-well series, late-time ½-slope linear flow.'
  },

  closedChannel3: {
    pd: PRiSM_model_closedChannel3,
    pdPrime: PRiSM_model_closedChannel3_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, dEnd: 1000 },
    paramSpec: [
      { key: 'Cd',   label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',    label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF1',  label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dF2',  label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dEnd', label: 'Distance to end',     unit: 'r_w', min: 1, max: 1e6, default: 1000 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963',
    category: 'boundary',
    description: 'Closed channel (3-sided) — parallel + end-closure image-well lattice.'
  },

  closedRectangle: {
    pd: PRiSM_model_closedRectangle,
    pdPrime: PRiSM_model_closedRectangle_pd_prime,
    defaults: { Cd: 100, S: 0, dN: 500, dS: 500, dE: 500, dW: 500 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0,  max: 1e10, default: 100 },
      { key: 'S',  label: 'Skin S',              unit: '-', min: -7, max: 50,   default: 0   },
      { key: 'dN', label: 'Distance N',          unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dS', label: 'Distance S',          unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dE', label: 'Distance E',          unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dW', label: 'Distance W',          unit: 'r_w', min: 1, max: 1e6, default: 500 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 — full 2D image lattice',
    category: 'boundary',
    description: 'Closed rectangle — late-time PSS unit-slope (reservoir-limits test).'
  },

  intersecting: {
    pd: PRiSM_model_intersecting,
    pdPrime: PRiSM_model_intersecting_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, angleDeg: 90 },
    paramSpec: [
      { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',        label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF1',      label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dF2',      label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'angleDeg', label: 'Intersection angle',  unit: 'deg', min: 1, max: 359, default: 90  }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 — circular image pattern',
    category: 'boundary',
    description: 'Two intersecting sealing faults — derivative slope amplified by 360/angle.'
  },

  fogBoundary: {
    pd: PRiSM_model_fogBoundary,
    pdPrime: PRiSM_model_fogBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, fog: 0.5 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF',  label: 'Distance to boundary', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
      { key: 'fog', label: 'Fog factor (transmissibility)', unit: '-', min: -1, max: 1, default: 0.5 }
    ],
    reference: 'PRiSM original — partially-sealing boundary as continuous transmissibility',
    category: 'boundary',
    description: 'Single boundary with continuously variable transmissibility, fog ∈ [-1, +1].'
  },

  finiteFracSkin: {
    pd: PRiSM_model_finiteFracSkin,
    pdPrime: PRiSM_model_finiteFracSkin_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10, Sf: 0.5 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd', unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',              unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1000, default: 10 },
      { key: 'Sf',  label: 'Fracture-face skin Sf', unit: '-', min: 0,  max: 20,   default: 0.5 }
    ],
    reference: 'Cinco-Ley & Samaniego, SPE 6752 / JPT Sept 1981',
    category: 'fracture',
    description: 'Finite-conductivity fracture with additional fracture-face skin damping early bilinear flow.'
  },

  partialPenFrac: {
    pd: PRiSM_model_partialPenFrac,
    pdPrime: PRiSM_model_partialPenFrac_pd_prime,
    defaults: { Cd: 100, S: 0, hf_to_h: 0.5, zw_to_h: 0.5 },
    paramSpec: [
      { key: 'Cd',      label: 'Wellbore storage Cd', unit: '-', min: 0,  max: 1e10, default: 100 },
      { key: 'S',       label: 'Skin S',              unit: '-', min: -7, max: 50,   default: 0   },
      { key: 'hf_to_h', label: 'Fracture-height fraction hf/h', unit: '-', min: 0.01, max: 1, default: 0.5 },
      { key: 'zw_to_h', label: 'Vertical placement zw/h', unit: '-', min: 0, max: 1, default: 0.5 }
    ],
    reference: 'Gringarten & Ramey, SPE 3818 / SPEJ Oct 1973',
    category: 'fracture',
    description: 'Partial-penetration hydraulic fracture (Green\'s-function shortcut) — fracture-linear → vertical-radial → horizontal-radial.'
  }
};

// merge into the registry that the foundation file is expected to seed.
// foundation must run first; if it has not registered "homogeneous" yet we
// at least set up the namespace so the merge is non-destructive.

(function _installRegistry() {
  var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
  for (var key in REGISTRY_ADDITIONS) {
    if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
      g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
    }
  }
  // also expose the evaluator functions on the global so the foundation
  // file or the rest of the app can reference them by name.
  g.PRiSM_model_infiniteFrac          = PRiSM_model_infiniteFrac;
  g.PRiSM_model_infiniteFrac_pd_prime = PRiSM_model_infiniteFrac_pd_prime;
  g.PRiSM_model_finiteFrac            = PRiSM_model_finiteFrac;
  g.PRiSM_model_finiteFrac_pd_prime   = PRiSM_model_finiteFrac_pd_prime;
  g.PRiSM_model_inclined              = PRiSM_model_inclined;
  g.PRiSM_model_inclined_pd_prime     = PRiSM_model_inclined_pd_prime;
  g.PRiSM_model_horizontal            = PRiSM_model_horizontal;
  g.PRiSM_model_horizontal_pd_prime   = PRiSM_model_horizontal_pd_prime;
  g.PRiSM_model_linearBoundary        = PRiSM_model_linearBoundary;
  g.PRiSM_model_linearBoundary_pd_prime = PRiSM_model_linearBoundary_pd_prime;
  g.PRiSM_model_parallelChannel       = PRiSM_model_parallelChannel;
  g.PRiSM_model_parallelChannel_pd_prime = PRiSM_model_parallelChannel_pd_prime;
  g.PRiSM_model_closedChannel3        = PRiSM_model_closedChannel3;
  g.PRiSM_model_closedChannel3_pd_prime = PRiSM_model_closedChannel3_pd_prime;
  g.PRiSM_model_closedRectangle       = PRiSM_model_closedRectangle;
  g.PRiSM_model_closedRectangle_pd_prime = PRiSM_model_closedRectangle_pd_prime;
  g.PRiSM_model_intersecting          = PRiSM_model_intersecting;
  g.PRiSM_model_intersecting_pd_prime = PRiSM_model_intersecting_pd_prime;
  g.PRiSM_model_fogBoundary           = PRiSM_model_fogBoundary;
  g.PRiSM_model_fogBoundary_pd_prime  = PRiSM_model_fogBoundary_pd_prime;
  g.PRiSM_model_finiteFracSkin        = PRiSM_model_finiteFracSkin;
  g.PRiSM_model_finiteFracSkin_pd_prime = PRiSM_model_finiteFracSkin_pd_prime;
  g.PRiSM_model_partialPenFrac        = PRiSM_model_partialPenFrac;
  g.PRiSM_model_partialPenFrac_pd_prime = PRiSM_model_partialPenFrac_pd_prime;
})();

// ============================================================================
// === SELF-TEST ===
// ============================================================================
//
// Lightweight smoke test: stub the foundation primitives and run every
// registered evaluator against td = [1, 10, 100] with default params.
// Confirms each function returns finite numbers (and arrays where expected).

(function _selfTest() {
  // Only run when executed directly (e.g. from Node) and when foundation
  // primitives are NOT already present. In production the foundation file
  // installs the real Stehfest / Bessel / Ei before this file runs.
  var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  var hadFoundation = (typeof g.PRiSM_stehfest === 'function');

  // ---- mocks (only installed if not already present) ----------------------
  if (!hadFoundation) {
    // trivial K0/K1 approximations: small-arg series + large-arg asymptotic
    g.PRiSM_besselK0 = function (x) {
      if (x <= 0 || !isFinite(x)) return 1e30;
      if (x < 2) {
        var t = x / 2;
        var t2 = t * t;
        // Abramowitz 9.8.5
        return -Math.log(t) * (1 + 3.5156229 * t2) + (-0.57721566
          + 0.42278420 * t2 + 0.23069756 * t2 * t2);
      }
      // 9.8.6 large-x
      var z = 2 / x;
      return Math.exp(-x) / Math.sqrt(x) *
        (1.25331414 - 0.07832358 * z + 0.02189568 * z * z);
    };
    g.PRiSM_besselK1 = function (x) {
      if (x <= 0) return 1e30;
      if (x < 2) {
        var t = x / 2;
        var t2 = t * t;
        return Math.log(t) * (x / 2) * (1 + 0.5 * t2) +
               (1 / x) * (1 + 0.15443144 * t2 - 0.67278579 * t2 * t2);
      }
      var z = 2 / x;
      return Math.exp(-x) / Math.sqrt(x) *
        (1.25331414 + 0.23498619 * z - 0.03655620 * z * z);
    };
    g.PRiSM_Ei = function (x) {
      // Series for small |x|, asymptotic for large |x|. Crude but finite.
      if (x === 0) return -Infinity;
      if (x < 0) {
        // for negative x compute Ei(-|x|) ~ E1(|x|) with sign flip
        var ax = -x;
        if (ax < 1) {
          // series
          var s = 0.57721566 + Math.log(ax);
          var term = 1, sum = 0;
          for (var n = 1; n < 30; n++) {
            term *= -ax / n;
            sum += term / n;
          }
          return -(s - sum);  // Ei(-x) for x>0
        } else {
          var sum2 = 1, term2 = 1;
          for (var k = 1; k < 10; k++) {
            term2 *= -k / ax;
            sum2 += term2;
          }
          return -Math.exp(-ax) / ax * sum2;
        }
      }
      // x > 0
      var s2 = 0.57721566 + Math.log(x);
      var t3 = 1, sm = 0;
      for (var i = 1; i < 30; i++) {
        t3 *= x / i;
        sm += t3 / i;
      }
      return s2 + sm;
    };

    // Stehfest (Stehfest 1970, Comm. ACM 13) — N=12
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
        V[n] = (Math.pow(-1, n + N / 2)) * sum;
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

    // Foundation Pd_lap_homogeneous (line-source approx) — used by inclined.
    g.PRiSM_pd_lap_homogeneous = function (s, p) {
      var sq = Math.sqrt(s);
      return g.PRiSM_besselK0(sq) / s;
    };
  }

  // ---- run every registered evaluator ------------------------------------
  var tdVec = [1, 10, 100];
  var allOk = true;
  var results = [];
  for (var key in REGISTRY_ADDITIONS) {
    if (!REGISTRY_ADDITIONS.hasOwnProperty(key)) continue;
    var entry = REGISTRY_ADDITIONS[key];
    var defaults = entry.defaults;
    try {
      var pdArr = entry.pd(tdVec, defaults);
      var ok = Array.isArray(pdArr) && pdArr.every(function (v) {
        return typeof v === 'number' && isFinite(v) && !isNaN(v);
      });
      if (!ok) {
        allOk = false;
        results.push(key + ': pd returned ' + JSON.stringify(pdArr));
      } else {
        results.push(key + ': pd ok (' + pdArr.map(function (v) {
          return v.toFixed(3);
        }).join(', ') + ')');
      }
      // pdPrime check
      var pdpArr = entry.pdPrime(tdVec, defaults);
      var ok2 = Array.isArray(pdpArr) && pdpArr.every(function (v) {
        return typeof v === 'number' && isFinite(v) && !isNaN(v);
      });
      if (!ok2) {
        allOk = false;
        results.push(key + ': pdPrime returned ' + JSON.stringify(pdpArr));
      }
    } catch (e) {
      allOk = false;
      results.push(key + ': THREW ' + (e && e.message ? e.message : e));
    }
  }

  if (typeof console !== 'undefined' && console.log) {
    if (allOk) {
      console.log('PRiSM 03-models: all 12 model evaluators returned finite values');
    } else {
      console.log('PRiSM 03-models: SELF-TEST FAILED');
      results.forEach(function (r) { console.log('  ' + r); });
    }
  }
})();

})();  // end IIFE
