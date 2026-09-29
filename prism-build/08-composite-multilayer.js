// =============================================================================
// PRiSM — Layer 08 — Composite + Multi-Layer Single-Well Models (Phase 5)
// =============================================================================
// Pressure Reservoir Inversion & Simulation Model — Advanced Well Test Analysis
//
// This file extends the PRiSM model registry with 7 evaluators that cover
// composite reservoirs and multi-layer geometries.  All entries are merged
// additively into window.PRiSM_MODELS so the Phase 1-4 entries survive.
//
//   Composite reservoirs (kind: 'pressure'):
//      9. radialComposite       — two concentric zones, mobility ratio M,
//                                 storativity ratio F.  (Abbaszadeh-Kamal
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
//     14. multiLayerNoXF        — N isolated commingled layers (default 3,
//                                 max 5).  kh-weighted sum of layer kernels.
//
//   General-heterogeneity simplifications (kind: 'pressure'):
//     20. genHetRadialLinear    — three-zone radial composite + one linear
//                                 fault (image well).
//     21. genHetRadial          — three-zone radial composite.
//
// Numerics (WP4b):
//   * Every kernel uses the finite-wellbore well term K0(√s)/(s·√s·K1(√s))
//     (or its zone-matched equivalent), so early time is storage-dominated
//     and there is no line-source early-time artefact.
//   * The composite solutions are solved as a radial impedance cascade with
//     exponentially scaled Bessel functions (I·e^-x, K·e^x).  The previous
//     Cramer solve overflowed (I0(uR) > 1e308 for R ≥ 1000) and produced
//     spikes; the cascade is exact and overflow-free for any number of zones.
//   * WBS + skin fold is valid for negative skin (effective-wellbore-radius
//     transform: rw-normalised radii scale by e^S, λ by e^-2S).
//   * Diffusivity convention (radialComposite, linearComposite): M = λ1/λ2
//     (mobility inner/outer), F = (φct)1/(φct)2, so the outer-zone
//     diffusivity is η2/η1 = F/M and the outer Laplace argument is √(s·M/F).
//     (Earlier versions used √(s·F/M), i.e. inverted the stated definition.)
//
// Foundation primitives: only PRiSM_stehfest is used when present (same
// N = 12 weights); all Bessel functions are local (see SECTION 0).
// =============================================================================

(function () {
'use strict';

// =============================================================================
// SECTION 1 — Helpers + foundation primitive resolver
// =============================================================================

var MAX_LAYERS      = 5;        // hard cap for multi-layer N

function _foundation(name) {
  var g = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (typeof g[name] === 'function') return g[name];
  try { return eval(name); } catch (e) { return null; }
}

function _win() {
  return (typeof window !== 'undefined') ? window
       : (typeof globalThis !== 'undefined' ? globalThis : {});
}

function _num(v) {
  return (typeof v === 'number') && isFinite(v) && !isNaN(v);
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

// Clamp a value to a safe Laplace return (avoid Infinity / NaN)
function _safeLap(v) {
  if (!_num(v)) return 1e30;
  if (v > 1e30) return 1e30;
  if (v < -1e30) return -1e30;
  return v;
}

// PSS interporosity factor (Warren-Root form):
//   f(s) = ( ω·(1-ω)·s + λ ) / ( (1-ω)·s + λ )
function _pssXFactor(s, omega, lambda) {
  var num = omega * (1 - omega) * s + lambda;
  var den = (1 - omega) * s + lambda;
  if (den === 0 || !_num(den)) return omega;
  return num / den;
}

// =============================================================================
// SECTION 0 — Numerics (WP4b): smooth scaled Bessel functions, Stehfest,
//             wellbore-storage + skin fold
// =============================================================================
//
// Why local Bessel functions: the Abramowitz-Stegun polynomial fits switch
// formula at x = 2 (K) and x = 3.75 (I) with ~1e-7 jumps.  Stehfest (N = 12,
// weights up to 8e6) amplifies such jumps into percent-level pwd errors when
// the 12 sample points straddle a breakpoint (3.7 % measured at Cd = 0.01).
// The forms below (power series / continued fraction / Hankel series, each
// used only where it is accurate to machine precision) agree to ~1e-14 across
// their switch points and are exponentially scaled, so they never over- or
// underflow.
// =============================================================================

var _EULER = 0.5772156649015329;

// K_nu(x)·e^x for nu ∈ {0,1}, x > 0 (all branches accurate to ~1e-15):
//   x < 2       : power series (K0: −(ln(x/2)+γ)·I0 + Σ q^k/(k!)²·H_k; K1 likewise)
//   2 ≤ x ≤ 30  : Steed / Temme continued fraction CF2 (Numerical Recipes bessik)
//   x > 30      : Hankel asymptotic series, optimally truncated (error < e^-60)
function _Kse(nu, x) {
  if (!(x > 0)) return Infinity;
  if (x === Infinity) return 0;
  if (x > 30) {
    var mu = 4 * nu * nu, a = 1, s = 1, prev = Infinity;
    for (var j = 1; j < 80; j++) {
      a *= (mu - (2 * j - 1) * (2 * j - 1)) / (j * 8 * x);
      var at = Math.abs(a);
      if (at > prev) break;
      s += a; prev = at;
      if (at < 1e-17) break;
    }
    return s * Math.sqrt(Math.PI / (2 * x));
  }
  if (x < 2) {
    var q = 0.25 * x * x, lx = Math.log(0.5 * x);
    if (!nu) {
      // K0 = −(ln(x/2)+γ)·I0 + Σ_{k≥1} q^k/(k!)²·H_k
      var t = 1, I0 = 1, S = 0, H = 0;
      for (var k = 1; k < 60; k++) { t *= q / (k * k); H += 1 / k; I0 += t; S += t * H; if (t < 1e-18) break; }
      return (-(lx + _EULER) * I0 + S) * Math.exp(x);
    }
    // K1 = 1/x + ln(x/2)·I1 − (x/4)·Σ_{k≥0} (ψ(k+1)+ψ(k+2))·q^k/(k!(k+1)!)
    var tk = 1, I1s = 1, S1 = (-_EULER) + (1 - _EULER), Hk = 0;
    for (var k2 = 1; k2 < 60; k2++) {
      tk *= q / (k2 * (k2 + 1));
      Hk += 1 / k2;
      I1s += tk;
      S1 += tk * ((-_EULER + Hk) + (-_EULER + Hk + 1 / (k2 + 1)));
      if (tk < 1e-18) break;
    }
    var I1 = 0.5 * x * I1s;
    return (1 / x + lx * I1 - 0.25 * x * S1) * Math.exp(x);
  }
  // 2 ≤ x ≤ 30: Steed's continued fraction CF2 (Temme), nu = 0 → K0e, K1e
  var b = 2 * (1 + x), d = 1 / b, h = d, delh = d, q1 = 0, q2 = 1, a1 = 0.25;
  var qq = a1, c = a1, aa = -a1, ss = 1 + qq * delh;
  for (var i = 2; i < 1000; i++) {
    aa -= 2 * (i - 1);
    c = -aa * c / i;
    var qnew = (q1 - b * q2) / aa;
    q1 = q2; q2 = qnew;
    qq += c * qnew;
    b += 2;
    d = 1 / (b + aa * d);
    delh = (b * d - 1) * delh;
    h += delh;
    var dels = qq * delh;
    ss += dels;
    if (Math.abs(dels / ss) < 1e-17) break;
  }
  h = a1 * h;
  var k0e = Math.sqrt(Math.PI / (2 * x)) / ss;
  return nu ? k0e * (x + 0.5 - h) / x : k0e;
}
function _K0e(x) { return _Kse(0, x); }
function _K1e(x) { return _Kse(1, x); }

// I_nu(x)·e^-x for nu ∈ {0,1}: power series for x ≤ 15, Hankel series above.
function _Ise(nu, x) {
  x = Math.abs(x);
  if (x <= 15) {
    var q = 0.25 * x * x, term = nu ? 0.5 * x : 1, sum = term;
    for (var k = 1; k < 200; k++) {
      term *= q / (k * (k + nu));
      sum += term;
      if (term < 1e-17 * sum) break;
    }
    return sum * Math.exp(-x);
  }
  var mu = 4 * nu * nu, a = 1, s = 1, prev = Infinity;
  for (var j = 1; j < 60; j++) {
    a *= -(mu - (2 * j - 1) * (2 * j - 1)) / (j * 8 * x);
    var at = Math.abs(a);
    if (at > prev) break;
    s += a; prev = at;
    if (at < 1e-17) break;
  }
  return s / Math.sqrt(2 * Math.PI * x);
}
function _I0e(x) { return _Ise(0, x); }
function _I1e(x) { return _Ise(1, x); }

// Finite-wellbore well term K0(x) / (x·K1(x)) — scale factors cancel.
function _wellTerm(x) { return _K0e(x) / (x * _K1e(x)); }

// ---- Stehfest (N = 12) ----------------------------------------------------
var _SW12 = (function () {
  var N = 12, f = [1], w = [];
  for (var i = 1; i <= N; i++) f[i] = f[i - 1] * i;
  for (var n = 1; n <= N; n++) {
    var s = 0;
    for (var k = Math.floor((n + 1) / 2); k <= Math.min(n, N / 2); k++) {
      s += Math.pow(k, N / 2) * f[2 * k] /
           (f[N / 2 - k] * f[k] * f[k - 1] * f[n - k] * f[2 * k - n]);
    }
    w.push(((n + N / 2) % 2 === 0 ? 1 : -1) * s);
  }
  return w;
})();
var _stehImpl;   // foundation PRiSM_stehfest (same weights), resolved lazily
function _steh(F, t) {
  if (_stehImpl === undefined) _stehImpl = _foundation('PRiSM_stehfest') || null;
  if (_stehImpl) return _stehImpl(F, t, 12);
  var a = Math.LN2 / t, s = 0;
  for (var i = 1; i <= 12; i++) s += _SW12[i - 1] * F(i * a);
  return a * s;
}

// ---- Wellbore storage + skin fold ------------------------------------------
//   p̄wD(s) = (s·p̄ + S) / ( s·(1 + Cd·s·(s·p̄ + S)) )     (Agarwal-Ramey 1970)
// p̄(s) is the unit-rate reservoir response at the well, built with the
// FINITE-wellbore well term, so pwd → td/Cd at early time.
//
// Negative skin: for S < 0 the fold has a real positive pole wherever
// s·p̄ + S = −1/(Cd·s); Stehfest then returns garbage.  We use the effective-
// wellbore-radius transform (rwa = rw·e^−S): evaluate with S = 0 at
// tDa = td·e^{2S}, CDa = Cd·e^{2S}; the kernel receives sc = e^{S} and scales
// its rw-normalised distances by sc and rw²-normalised coefficients (λ) by
// 1/sc².  Late time is exactly 0.5(ln td + 0.80907) + S.
function _foldTransform(Cd, S) {
  Cd = _num(Cd) && Cd > 0 ? Cd : 0;
  S = _num(S) ? S : 0;
  if (S < 0) {
    var sc = Math.exp(S);
    return { sc: sc, tf: sc * sc, Cd: Cd * sc * sc, S: 0 };
  }
  return { sc: 1, tf: 1, Cd: Cd, S: S };
}
function _foldF(lap, Cd, S) {
  return function (s) {
    var g = s * lap(s) + S;
    if (!(Cd > 0)) return g / s;
    return g / (s * (1 + Cd * s * g));
  };
}
// Optional delegation to the shared export (WP4a, 03-models.js).  It is
// called only in the unambiguous S ≥ 0 form (after our own transform) and its
// first value is cross-checked against the local inversion.
function _extFold(lap, tArr, Cd, S, F) {
  var ext = _win().PRiSM_evalWbsSkin;
  if (typeof ext !== 'function' || !tArr.length) return null;
  try {
    var r = ext(lap, tArr.slice(), Cd, S, {});
    if (!r || r.length !== tArr.length) return null;
    for (var i = 0; i < r.length; i++) if (!_num(r[i])) return null;
    var chk = _steh(F, tArr[0]);
    if (!(Math.abs(r[0] - chk) <= 2e-3 * Math.max(Math.abs(chk), 1e-12))) return null;
    var out = new Array(r.length);
    for (var j = 0; j < r.length; j++) out[j] = r[j];
    return out;
  } catch (e) { return null; }
}
// lapFn(s, sc) → p̄(s).  Returns pwd (deriv false) or td·dpwd/dtd (deriv true,
// from the Laplace identity L[t·f'] = t·L^-1[s·F(s)] since pwd(0) = 0).
// localOnly: never delegate (kernels that depend on the inversion context).
function _evalWbsSkin(lapFn, td, Cd, S, deriv, localOnly) {
  var isArr = Array.isArray(td), arr = isArr ? td : [td];
  var T = _foldTransform(Cd, S);
  var lap = function (s) { return lapFn(s, T.sc); };
  var F = _foldF(lap, T.Cd, T.S);
  var tArr = new Array(arr.length);
  for (var i = 0; i < arr.length; i++) tArr[i] = arr[i] * T.tf;
  var out = null;
  if (!deriv && !localOnly) out = _extFold(lap, tArr, T.Cd, T.S, F);
  if (!out) {
    out = new Array(arr.length);
    var Fd = deriv ? function (s) { return s * F(s); } : null;
    for (var k = 0; k < arr.length; k++) {
      out[k] = deriv ? tArr[k] * _steh(Fd, tArr[k]) : _steh(F, tArr[k]);
    }
  }
  for (var m = 0; m < out.length; m++) {          // round-off below 1e-10 → 0
    if (out[m] < 0 && out[m] > -1e-10) out[m] = 0;
  }
  return isArr ? out : out[0];
}

// ---- Radial impedance cascade (composite reservoirs) ------------------------
// zones: inner → outer, [{m, f, R}], m = mobility and f = storativity relative
// to the pD / tD reference, R = OUTER radius of the zone in rw units (last
// zone: Infinity).  In zone j, P = A·K0(k r) + B·I0(k r), k = √(s·f/m).
// Z(r) = P / (−m·∂P/∂r) is continuous across every interface (pressure and
// flux continuity), so we propagate Z from the outermost zone inwards and
// return p̄w = Z(1)/s for a unit sandface flux (finite wellbore at r = 1).
// All Bessel functions are exponentially scaled; the only exponentials left
// are e^{−2k(R−r_in)} ≤ 1.
function _radialCascadeLap(s, zones) {
  var n = zones.length;
  var last = zones[n - 1];
  var kL = Math.sqrt(s * last.f / last.m);
  var rIn = (n >= 2) ? zones[n - 2].R : 1;
  var Z = _K0e(kL * rIn) / (last.m * kL * _K1e(kL * rIn));
  for (var j = n - 2; j >= 0; j--) {
    var zj = zones[j];
    var kj = Math.sqrt(s * zj.f / zj.m);
    var R = zj.R, rin = (j >= 1) ? zones[j - 1].R : 1;
    var mk = zj.m * kj, kR = kj * R, kr = kj * rin;
    var bt = (Z * mk * _K1e(kR) - _K0e(kR)) / (_I0e(kR) + Z * mk * _I1e(kR));
    var E = Math.exp(-2 * kj * (R - rin));
    Z = (_K0e(kr) + bt * _I0e(kr) * E) / (mk * (_K1e(kr) - bt * _I1e(kr) * E));
  }
  return _safeLap(Z / s);
}

// radius in rw units after the negative-skin scale, kept outside the wellbore
function _scaledR(R, sc) {
  var r = R * (sc || 1);
  return r > 1.000001 ? r : 1.000001;
}


// =============================================================================
// SECTION 2 — Model evaluators
// =============================================================================
//
//   pd(td, params)      → number | number[]
//   pdPrime(td, params) → number | number[]  (td · d(pd)/dtd, Laplace form)
// =============================================================================


// -----------------------------------------------------------------------------
// MODEL #6 — TWO-LAYER RESERVOIR WITH CROSS-FLOW
// -----------------------------------------------------------------------------
//
// Reference: Bourdet, D. SPE 13628 (1985); Park-Horne SPE 19800 (1989).
//
//   f_xf(s)  = (ω·(1-ω)·s + λ) / ((1-ω)·s + λ)        ← PSS xf factor
//   x        = sqrt( s · f_xf(s) / κ_eff ),  κ_eff = ω·κ + (1-ω)
//   Pd_res   = K0(x) / ( s·x·K1(x) )                    ← finite wellbore
//
// Params: { Cd, S, kappa, lambda, omega }
// -----------------------------------------------------------------------------

function _checkTwoLayer(params) {
  if (!_num(params.omega) || params.omega <= 0 || params.omega >= 1) {
    throw new Error('PRiSM twoLayerXF: omega must be in (0, 1)');
  }
  if (!_num(params.lambda) || params.lambda <= 0) {
    throw new Error('PRiSM twoLayerXF: lambda must be > 0');
  }
  if (!_num(params.kappa) || params.kappa <= 0) {
    throw new Error('PRiSM twoLayerXF: kappa must be > 0');
  }
}

function _pdLap_twoLayerXF(s, params, sc) {
  var omega = params.omega;
  var lambda = params.lambda / ((sc || 1) * (sc || 1));
  var f = _pssXFactor(s, omega, lambda);
  var kappaEff = omega * params.kappa + (1 - omega);
  if (kappaEff <= 0) kappaEff = 1;
  var sf = s * f / kappaEff;
  if (!(sf > 0) || !_num(sf)) return 1e30;
  return _wellTerm(Math.sqrt(sf)) / s;
}

function PRiSM_model_twoLayerXF(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'kappa', 'lambda', 'omega']);
  _checkTwoLayer(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_twoLayerXF(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_twoLayerXF_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'kappa', 'lambda', 'omega']);
  _checkTwoLayer(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_twoLayerXF(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// MODEL #9 — RADIAL COMPOSITE RESERVOIR
// -----------------------------------------------------------------------------
//
// References: Abbaszadeh & Kamal, SPE Reservoir Eng Feb 1989;
//             Satman, Eggenschwiler, Ramey, SPE 8909.
//
// Inner zone (1 ≤ r ≤ R): mobility λ1, storativity (φct)1 (the reference).
// Outer zone (r ≥ R):     λ2 = λ1/M, (φct)2 = (φct)1/F, diffusivity ratio
//                          η2/η1 = F/M.
//   M = λ1/λ2, F = (φct)1/(φct)2, R = interface radius / rw
//
// Solved exactly with the impedance cascade (finite wellbore at r = 1).
// Early derivative 0.5 (inner zone), late derivative 0.5·M (outer zone).
// Collapses to the homogeneous solution when M = F = 1 or R → ∞.
//
// Params: { Cd, S, M, F, R }
// -----------------------------------------------------------------------------

function _checkRadialComposite(params) {
  if (!_num(params.M) || params.M <= 0) throw new Error('PRiSM radialComposite: M must be > 0');
  if (!_num(params.F) || params.F <= 0) throw new Error('PRiSM radialComposite: F must be > 0');
  if (!_num(params.R) || params.R <= 1) throw new Error('PRiSM radialComposite: R must be > 1');
}

function _pdLap_radialComposite(s, params, sc) {
  return _radialCascadeLap(s, [
    { m: 1, f: 1, R: _scaledR(params.R, sc) },
    { m: 1 / params.M, f: 1 / params.F, R: Infinity }
  ]);
}

function PRiSM_model_radialComposite(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'M', 'F', 'R']);
  _checkRadialComposite(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_radialComposite(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_radialComposite_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'M', 'F', 'R']);
  _checkRadialComposite(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_radialComposite(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// MODEL #11 — MULTI-LAYER WITH CROSS-FLOW
// -----------------------------------------------------------------------------
//
// Reference: Economides et al, SPE 14167 (1985); Park-Horne SPE 19800 (1989).
//
// Engineering simplification: generalised Warren-Root PSS factor across N
// layers with a single λ,
//     f_N(s) = [ Σ ω_i·(1-ω_i) · s + λ ] / [ Σ (1-ω_i) · s + λ ]
// (smooth, f → 1 at late time) and Pd_res = K0(x)/(s·x·K1(x)),
// x = √(s·f_N/κ_eff), κ_eff = N·Σ ω_i κ_i.
//
// Params: { Cd, S, N, omegas, kappas, lambda }
// -----------------------------------------------------------------------------

function _normaliseLayers(arr, N, defaultVal) {
  var out = new Array(N);
  var src = (Array.isArray(arr) && arr.length === N) ? arr : null;
  var sum = 0;
  for (var j = 0; j < N; j++) {
    var v = src ? src[j] : defaultVal;
    out[j] = (typeof v === 'number' && isFinite(v) && v > 0) ? v : defaultVal;
    sum += out[j];
  }
  if (sum <= 0) sum = 1;
  for (var k = 0; k < N; k++) out[k] = out[k] / sum;
  return out;
}

function _multiLayerXF_factor(s, omegas, lambda) {
  var Nloc = omegas.length;
  var num = 0, den = 0;
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

function _pdLap_multiLayerXF(s, params, sc) {
  var Nloc = params.N | 0;
  if (Nloc < 2) Nloc = 2;
  if (Nloc > MAX_LAYERS) Nloc = MAX_LAYERS;
  var omegas = _normaliseLayers(params.omegas, Nloc, 1.0 / Nloc);
  var kappas = _normaliseLayers(params.kappas, Nloc, 1.0 / Nloc);
  var lambda = params.lambda / ((sc || 1) * (sc || 1));
  var f = _multiLayerXF_factor(s, omegas, lambda);
  var kappaEff = 0;
  for (var i = 0; i < Nloc; i++) kappaEff += omegas[i] * kappas[i];
  if (kappaEff <= 0) kappaEff = 1 / Nloc;
  kappaEff = kappaEff * Nloc;
  var sf = s * f / kappaEff;
  if (!(sf > 0) || !_num(sf)) return 1e30;
  return _wellTerm(Math.sqrt(sf)) / s;
}

function _checkMultiLayerXF(params) {
  if (!_num(params.lambda) || params.lambda <= 0) {
    throw new Error('PRiSM multiLayerXF: lambda must be > 0');
  }
}

function PRiSM_model_multiLayerXF(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'lambda']);
  _checkMultiLayerXF(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_multiLayerXF(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_multiLayerXF_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'lambda']);
  _checkMultiLayerXF(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_multiLayerXF(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// MODEL #14 — MULTI-LAYER WITHOUT CROSS-FLOW (COMMINGLED)
// -----------------------------------------------------------------------------
//
// Reference: Kuchuk-Wilkinson SPE 18125 (1991); Lefkovits et al SPEJ 1961.
//
//   Pd_res(s) = Σ_i κ_i · K0(x_i)/(s·x_i·K1(x_i)),  x_i = √(s/perm_i)
//
// Params: { Cd, S, N, perms, khFracs }
// -----------------------------------------------------------------------------

function _pdLap_multiLayerNoXF(s, params) {
  var Nloc = params.N | 0;
  if (Nloc < 2) Nloc = 2;
  if (Nloc > MAX_LAYERS) Nloc = MAX_LAYERS;
  var perms = (Array.isArray(params.perms) && params.perms.length === Nloc) ? params.perms : null;
  var khFracs = _normaliseLayers(params.khFracs, Nloc, 1.0 / Nloc);
  var pdSum = 0;
  for (var i = 0; i < Nloc; i++) {
    var perm = (perms && typeof perms[i] === 'number' && perms[i] > 0) ? perms[i] : 1;
    var arg = Math.sqrt(s / perm);
    if (!_num(arg) || arg <= 0) continue;
    pdSum += khFracs[i] * _wellTerm(arg) / s;
  }
  return _safeLap(pdSum);
}

function PRiSM_model_multiLayerNoXF(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _evalWbsSkin(function (s) { return _pdLap_multiLayerNoXF(s, params); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_multiLayerNoXF_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _evalWbsSkin(function (s) { return _pdLap_multiLayerNoXF(s, params); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// MODEL #15 — LINEAR COMPOSITE RESERVOIR
// -----------------------------------------------------------------------------
//
// A vertical well in zone 1, linear interfaces at distances L_1 < ... < L_4
// (rw units).  First-order image superposition: each interface n contributes
// an image at distance 2·L_n with reflection coefficient
//
//   r_n = (M_{n+1} − M_n) / (M_{n+1} + M_n)
//
// where M_n = λ1/λn is the mobility ratio of zone 1 to zone n (M_1 = 1), the
// same convention as radialComposite: a less mobile zone behind the interface
// (M_{n+1} > M_n) gives r > 0 (sealing-like, r → +1), a more mobile one r < 0
// (constant-pressure-like, r → −1).  The image is evaluated with the zone-n
// diffusivity: argument √(s·M_n/F_n)·2L_n (η_n/η_1 = F_n/M_n).
// Higher-order multi-reflections are truncated.
//
//   Pd_res = K0(√s)/(s√s K1(√s)) + Σ r_n K0(√(s M_n/F_n)·2L_n)/(s√s K1(√s))
//
// Params: { Cd, S, Nzones, L, M, F }
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

function _pdLap_linearComposite(s, params, sc) {
  var Nz = params.Nzones | 0;
  if (Nz < 2) Nz = 2;
  if (Nz > 5) Nz = 5;
  var L = _padArray(params.L, Nz - 1, 100);
  var M = _padArray(params.M, Nz, 1);
  var F = _padArray(params.F, Nz, 1);
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
  var K1eu = _K1e(u);
  var pd = _K0e(u) / (u * K1eu);
  for (var n = 0; n < Nz - 1; n++) {
    var rn = (M[n + 1] - M[n]) / (M[n + 1] + M[n]);
    if (!_num(rn) || rn === 0) continue;
    var arg = Math.sqrt(s * M[n] / F[n]) * 2 * L[n] * (sc || 1);
    if (!(arg > 0)) continue;
    var ex = -(arg - u);
    if (ex < -700) continue;
    pd += rn * _K0e(arg) / (u * K1eu) * Math.exp(ex);
  }
  return _safeLap(pd / s);
}

function PRiSM_model_linearComposite(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _evalWbsSkin(function (s, sc) { return _pdLap_linearComposite(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_linearComposite_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _evalWbsSkin(function (s, sc) { return _pdLap_linearComposite(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// MODEL #21 — GENERAL HETEROGENEITY RADIAL COMPOSITE (3-zone)
// -----------------------------------------------------------------------------
//
// well -- zone 1 (M1, F1) -- R1 -- zone 2 (M2, F2) -- R2 -- zone 3 (M3, F3) -- ∞
//
// M_n, F_n are the mobility and storativity of zone n relative to the pD / tD
// reference (so k_n = √(s·F_n/M_n)).  Solved exactly with the impedance
// cascade; extending to more zones only adds entries to the zone list.
// Up to 9 piecewise discontinuities (textbook spec) are NOT exposed.
//
// Params: { Cd, S, R1, R2, M1, M2, M3, F1, F2, F3 }
// -----------------------------------------------------------------------------

function _posOr1(v) { return (_num(v) && v > 0) ? v : 1; }

function _checkGenHet(params) {
  if (!_num(params.R1) || params.R1 <= 1) throw new Error('PRiSM genHetRadial: R1 must be > 1');
  if (!_num(params.R2) || params.R2 <= params.R1) throw new Error('PRiSM genHetRadial: R2 must be > R1');
}

function _genHetZones(params, sc) {
  var R1 = _scaledR(params.R1, sc), R2 = _scaledR(params.R2, sc);
  if (R2 <= R1) R2 = R1 * 1.000001;
  return [
    { m: _posOr1(params.M1), f: _posOr1(params.F1), R: R1 },
    { m: _posOr1(params.M2), f: _posOr1(params.F2), R: R2 },
    { m: _posOr1(params.M3), f: _posOr1(params.F3), R: Infinity }
  ];
}

function _pdLap_genHetRadial(s, params, sc) {
  return _radialCascadeLap(s, _genHetZones(params, sc));
}

function PRiSM_model_genHetRadial(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3', 'F1', 'F2', 'F3']);
  _checkGenHet(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_genHetRadial(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_genHetRadial_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3', 'F1', 'F2', 'F3']);
  _checkGenHet(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_genHetRadial(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// MODEL #20 — GENERAL HETEROGENEITY RADIAL + LINEAR COMPOSITE
// -----------------------------------------------------------------------------
//
// Three-zone radial composite (#21) plus one linear fault at Lf (rw units)
// represented by an image well in the zone-1 diffusivity:
//
//   Pd_res(s) = Pd_radial_3zone(s) + r_f · K0(k1·2Lf)/(s·M1·k1·K1(k1))
//
// r_f = (M1 − Mfault)/(M1 + Mfault) with Mfault the relative mobility behind
// the fault (Mfault → 0 sealing, r_f → +1; Mfault → ∞ constant pressure,
// r_f → −1).  BC 'sealing' forces r_f = +1, 'constP' forces r_f = −1.
//
// Params: { Cd, S, R1, R2, M1, M2, M3, F1, F2, F3, Lf, Mfault, BC }
// -----------------------------------------------------------------------------

function _pdLap_genHetRadialLinear(s, params, sc) {
  var pdRadial = _pdLap_genHetRadial(s, params, sc);
  var Lf = params.Lf;
  var BC = params.BC || 'noflow';
  if (!_num(Lf) || Lf <= 0) return pdRadial;
  var M1 = _posOr1(params.M1), F1 = _posOr1(params.F1);
  var rf;
  if (BC === 'constP') rf = -1;
  else if (BC === 'sealing') rf = +1;
  else {
    var Mf = (_num(params.Mfault) && params.Mfault >= 0) ? params.Mfault : M1;
    rf = (M1 - Mf) / (M1 + Mf);
  }
  if (!_num(rf) || rf === 0) return pdRadial;
  var k1 = Math.sqrt(s * F1 / M1);
  if (!(k1 > 0)) return pdRadial;
  var d = 2 * Lf * (sc || 1);
  var ex = -k1 * (d - 1);
  if (ex < -700) return pdRadial;
  var image = _K0e(k1 * d) / (M1 * k1 * _K1e(k1)) * Math.exp(ex) / s;
  return _safeLap(pdRadial + rf * image);
}

function PRiSM_model_genHetRadialLinear(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3',
                          'F1', 'F2', 'F3', 'Lf']);
  _checkGenHet(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_genHetRadialLinear(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_genHetRadialLinear_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'R1', 'R2', 'M1', 'M2', 'M3',
                          'F1', 'F2', 'F3', 'Lf']);
  _checkGenHet(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_genHetRadialLinear(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// =============================================================================
// SECTION 3 — REGISTRY MERGE
// =============================================================================
//
// All Phase 5 entries are kind: 'pressure', refLength 'rw'.  Categories:
// 'composite' (radial / linear / general het.) and 'multilayer'.
// =============================================================================

var REGISTRY_ADDITIONS = {

  twoLayerXF: {
    pd:      PRiSM_model_twoLayerXF,
    pdPrime: PRiSM_model_twoLayerXF_pd_prime,
    defaults: { Cd: 100, S: 0, kappa: 0.5, lambda: 1e-5, omega: 0.5 },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',         unit: '-',  min: 0,     max: 1e10,  default: 100, scale: 'log' },
      { key: 'S',      label: 'Skin S',                      unit: '-',  min: -7,    max: 50,    default: 0     },
      { key: 'kappa',  label: 'Layer perm ratio κ=k1/k2',    unit: '-',  min: 0.01,  max: 100,   default: 0.5, scale: 'log' },
      { key: 'lambda', label: 'Cross-flow coefficient λ',    unit: '-',  min: 1e-9,  max: 1e-2,  default: 1e-5, scale: 'log' },
      { key: 'omega',  label: 'Layer storativity ratio ω',   unit: '-',  min: 0.01,  max: 0.99,  default: 0.5   }
    ],
    refLength: 'rw',
    reference: 'Bourdet, D. SPE 13628 (1985); Park-Horne SPE 19800 (1989)',
    category: 'multilayer',
    description: 'Two-layer reservoir with PSS cross-flow controlled by λ. ω = layer storativity ratio, κ = permeability ratio. Uses the PSS f(s) factor (Warren-Root analogue) — engineering simplification of the rigorous 2x2 Laplace system.',
    kind: 'pressure'
  },

  radialComposite: {
    pd:      PRiSM_model_radialComposite,
    pdPrime: PRiSM_model_radialComposite_pd_prime,
    defaults: { Cd: 100, S: 0, M: 2.0, F: 1.0, R: 50 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd',                   unit: '-', min: 0,     max: 1e10, default: 100, scale: 'log' },
      { key: 'S',  label: 'Skin S',                                unit: '-', min: -7,    max: 50,   default: 0    },
      { key: 'M',  label: 'Mobility ratio M = (k/μ)₁/(k/μ)₂',       unit: '-', min: 0.01,  max: 100,  default: 2.0, scale: 'log' },
      { key: 'F',  label: 'Storativity ratio F = (φc_t)₁/(φc_t)₂',  unit: '-', min: 0.01,  max: 100,  default: 1.0, scale: 'log' },
      { key: 'R',  label: 'Inner-zone radius R = r/rw',             unit: '-', min: 1.5,   max: 1e5,  default: 50,  scale: 'log' }
    ],
    refLength: 'rw',
    reference: 'Abbaszadeh & Kamal, SPE Reservoir Eng Feb 1989; Satman et al, SPE 8909',
    category: 'composite',
    description: 'Radial composite reservoir: two concentric zones with mobility ratio M and storativity ratio F (outer diffusivity η2/η1 = F/M). Late derivative 0.5·M. Exact Laplace solution (scaled-Bessel impedance cascade).',
    kind: 'pressure'
  },

  multiLayerXF: {
    pd:      PRiSM_model_multiLayerXF,
    pdPrime: PRiSM_model_multiLayerXF_pd_prime,
    defaults: { Cd: 100, S: 0, N: 3, omegas: [1/3, 1/3, 1/3], kappas: [1/3, 1/3, 1/3], lambda: 1e-5 },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',     unit: '-',     min: 0,     max: 1e10,  default: 100, scale: 'log' },
      { key: 'S',      label: 'Skin S',                  unit: '-',     min: -7,    max: 50,    default: 0     },
      { key: 'N',      label: 'Number of layers N',      unit: '-',     min: 2,     max: 5,     default: 3     },
      { key: 'lambda', label: 'Cross-flow coefficient λ', unit: '-',    min: 1e-9,  max: 1e-2,  default: 1e-5, scale: 'log' }
      // omegas[] and kappas[] are array params, normalised at runtime
    ],
    refLength: 'rw',
    defaultFrozen: ['N'],
    reference: 'Economides et al, SPE 14167 (1985); Park-Horne SPE 19800 (1989)',
    category: 'multilayer',
    description: 'N adjacent layers (N=2..5) with PSS cross-flow between successive pairs. Default N=3, equal ω and κ per layer, single λ. Engineering simplification of the rigorous tridiagonal Laplace system.',
    kind: 'pressure'
  },

  multiLayerNoXF: {
    pd:      PRiSM_model_multiLayerNoXF,
    pdPrime: PRiSM_model_multiLayerNoXF_pd_prime,
    defaults: { Cd: 100, S: 0, N: 3, perms: [1, 1, 1], khFracs: [1/3, 1/3, 1/3] },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',  unit: '-', min: 0,    max: 1e10, default: 100, scale: 'log' },
      { key: 'S',      label: 'Global skin S',        unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'N',      label: 'Number of layers N',   unit: '-', min: 2,    max: 5,    default: 3   }
      // perms[] and khFracs[] are array params
    ],
    refLength: 'rw',
    defaultFrozen: ['N'],
    reference: 'Kuchuk-Wilkinson SPE 18125 (1991); Lefkovits et al SPEJ March 1961',
    category: 'multilayer',
    description: 'N isolated commingled layers (N=2..5) with no cross-flow: kh-weighted sum of N finite-wellbore layer kernels (per-layer perm, kh-fraction). Default N=3, equal kh and perm.',
    kind: 'pressure'
  },

  linearComposite: {
    pd:      PRiSM_model_linearComposite,
    pdPrime: PRiSM_model_linearComposite_pd_prime,
    defaults: { Cd: 100, S: 0, Nzones: 2, L: [100], M: [1, 2], F: [1, 1] },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',      unit: '-', min: 0,    max: 1e10, default: 100, scale: 'log' },
      { key: 'S',      label: 'Skin S',                   unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'Nzones', label: 'Number of zones (2..5)',   unit: '-', min: 2,    max: 5,    default: 2   }
      // L[] (rw units), M[] (λ1/λn), F[] ((φct)1/(φct)n) are array params
    ],
    refLength: 'rw',
    defaultFrozen: ['Nzones'],
    reference: 'Image-well superposition; van Poolen (1963) linear-boundary kernel; Bourdet (2002) §4 composite extension',
    category: 'composite',
    description: 'Linear composite reservoir: up to 5 zones with linear discontinuities at distances L[]. First-order images with r_n = (M_{n+1}-M_n)/(M_{n+1}+M_n), M_n = λ1/λn. Higher-order multi-reflections truncated.',
    kind: 'pressure'
  },

  genHetRadialLinear: {
    pd:      PRiSM_model_genHetRadialLinear,
    pdPrime: PRiSM_model_genHetRadialLinear_pd_prime,
    defaults: { Cd: 100, S: 0, R1: 30, R2: 200, M1: 1.0, M2: 2.0, M3: 1.0,
                F1: 1.0, F2: 1.0, F3: 1.0, Lf: 500, Mfault: 0.1, BC: 'noflow' },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',      unit: '-', min: 0,    max: 1e10, default: 100, scale: 'log' },
      { key: 'S',      label: 'Skin S',                   unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'R1',     label: 'Inner radial interface R₁', unit: '-', min: 1.5, max: 1e5,  default: 30,  scale: 'log' },
      { key: 'R2',     label: 'Outer radial interface R₂', unit: '-', min: 2,   max: 1e5,  default: 200, scale: 'log' },
      { key: 'M1',     label: 'Mobility zone-1 M₁',        unit: '-', min: 0.01, max: 100, default: 1.0, scale: 'log' },
      { key: 'M2',     label: 'Mobility zone-2 M₂',        unit: '-', min: 0.01, max: 100, default: 2.0, scale: 'log' },
      { key: 'M3',     label: 'Mobility zone-3 M₃',        unit: '-', min: 0.01, max: 100, default: 1.0, scale: 'log' },
      { key: 'F1',     label: 'Storativity zone-1 F₁',     unit: '-', min: 0.01, max: 100, default: 1.0, scale: 'log' },
      { key: 'F2',     label: 'Storativity zone-2 F₂',     unit: '-', min: 0.01, max: 100, default: 1.0, scale: 'log' },
      { key: 'F3',     label: 'Storativity zone-3 F₃',     unit: '-', min: 0.01, max: 100, default: 1.0, scale: 'log' },
      { key: 'Lf',     label: 'Linear fault distance Lf',  unit: '-', min: 1,    max: 1e5,  default: 500, scale: 'log' },
      { key: 'Mfault', label: 'Mobility behind fault',     unit: '-', min: 0,    max: 1e6,  default: 0.1 },
      { key: 'BC',     label: 'Linear-fault BC',           unit: '',  options: ['noflow', 'constP', 'sealing'], default: 'noflow' }
    ],
    refLength: 'rw',
    defaultFrozen: ['M1', 'F1'],
    reference: 'Composite simplification: 3-zone radial composite + 1-fault linear image — see source header.',
    category: 'composite',
    description: 'General heterogeneity radial+linear composite: 3-zone radial composite (interfaces R₁, R₂; exact impedance cascade) plus a single linear fault at Lf (image well, reflection (M₁−M_f)/(M₁+M_f)).',
    kind: 'pressure'
  },

  genHetRadial: {
    pd:      PRiSM_model_genHetRadial,
    pdPrime: PRiSM_model_genHetRadial_pd_prime,
    defaults: { Cd: 100, S: 0, R1: 30, R2: 200, M1: 1.0, M2: 2.0, M3: 1.0,
                F1: 1.0, F2: 1.0, F3: 1.0 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd',     unit: '-', min: 0,     max: 1e10, default: 100, scale: 'log' },
      { key: 'S',  label: 'Skin S',                  unit: '-', min: -7,    max: 50,   default: 0   },
      { key: 'R1', label: 'Inner radial interface R₁', unit: '-', min: 1.5, max: 1e5,  default: 30,  scale: 'log' },
      { key: 'R2', label: 'Outer radial interface R₂', unit: '-', min: 2,   max: 1e5,  default: 200, scale: 'log' },
      { key: 'M1', label: 'Mobility zone-1 M₁',       unit: '-', min: 0.01, max: 100,  default: 1.0, scale: 'log' },
      { key: 'M2', label: 'Mobility zone-2 M₂',       unit: '-', min: 0.01, max: 100,  default: 2.0, scale: 'log' },
      { key: 'M3', label: 'Mobility zone-3 M₃',       unit: '-', min: 0.01, max: 100,  default: 1.0, scale: 'log' },
      { key: 'F1', label: 'Storativity zone-1 F₁',    unit: '-', min: 0.01, max: 100,  default: 1.0, scale: 'log' },
      { key: 'F2', label: 'Storativity zone-2 F₂',    unit: '-', min: 0.01, max: 100,  default: 1.0, scale: 'log' },
      { key: 'F3', label: 'Storativity zone-3 F₃',    unit: '-', min: 0.01, max: 100,  default: 1.0, scale: 'log' }
    ],
    refLength: 'rw',
    defaultFrozen: ['M1', 'F1'],
    reference: 'Composite simplification refining #9 radial composite — see source header.',
    category: 'composite',
    description: 'General heterogeneity radial composite — 3-zone refinement of #9 (interfaces R₁, R₂). Exact Laplace solution via a scaled-Bessel impedance cascade; zone mobilities/storativities relative to the reference.',
    kind: 'pressure'
  }
};


// install in window.PRiSM_MODELS, additive (never replace the registry object)
(function _installRegistry() {
  var g = _win();
  if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
  for (var key in REGISTRY_ADDITIONS) {
    if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
      g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
    }
  }
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
// SECTION 4 — Optional helpers exposed on window for plot overlays
// =============================================================================

// Radial-composite derivative stabilisations (dimensionless): early 0.5
// (inner zone), late 0.5·M (outer zone, pD normalised by the inner mobility).
function PRiSM_radialComposite_asymptotes(params) {
  if (!params || typeof params !== 'object') return { early: NaN, late: NaN };
  var M = params.M;
  return { early: 0.5, late: (_num(M) && M > 0) ? 0.5 * M : 0.5 };
}

// Multi-layer kh-fraction sanity-check.
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

(function _publishHelpers() {
  var g = _win();
  g.PRiSM_radialComposite_asymptotes = PRiSM_radialComposite_asymptotes;
  g.PRiSM_multiLayer_diagnose        = PRiSM_multiLayer_diagnose;
})();


// =============================================================================
// SECTION 5 — SELF-TEST
// =============================================================================
//
// Standalone check (stripped at concat): every evaluator finite at defaults;
// radialComposite = homogeneous for M = F = 1 and before the front for
// R = 1000; negative skin monotone; late radialComposite derivative 0.5·M.
// =============================================================================

(function _selfTest() {
  var report = [], allOk = true;
  function check(name, ok, detail) {
    if (!ok) { allOk = false; report.push('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
  }
  function hom(t, Cd, S) {
    return _evalWbsSkin(function (s) { return _wellTerm(Math.sqrt(s)) / s; }, [t], Cd, S, false)[0];
  }
  try {
    var tdVec = [1, 10, 100, 1e4];
    Object.keys(REGISTRY_ADDITIONS).forEach(function (key) {
      var e = REGISTRY_ADDITIONS[key];
      var v = e.pd(tdVec, e.defaults), d = e.pdPrime(tdVec, e.defaults);
      check(key + ' finite', v.every(_num) && d.every(_num), JSON.stringify(v));
    });
    var rc1 = PRiSM_model_radialComposite([10, 1e3], { Cd: 100, S: 0, M: 1, F: 1, R: 50 });
    check('radialComposite M=F=1', Math.abs(rc1[1] - hom(1e3, 100, 0)) < 1e-8, rc1[1]);
    var rcR = PRiSM_model_radialComposite([1e4], { Cd: 100, S: 0, M: 2, F: 1, R: 1000 })[0];
    check('radialComposite before front', Math.abs(rcR / hom(1e4, 100, 0) - 1) < 0.01, rcR);
    var late = PRiSM_model_radialComposite_pd_prime([1e9], { Cd: 100, S: 0, M: 2, F: 1, R: 50 })[0];
    check('radialComposite late 0.5M', Math.abs(late - 1.0) < 0.01, late);
    var neg = PRiSM_model_twoLayerXF([1, 10, 100, 1e3, 1e4, 1e5],
      { Cd: 100, S: -3, kappa: 0.5, lambda: 1e-5, omega: 0.5 });
    var mono = true;
    for (var i = 1; i < neg.length; i++) if (!(neg[i] >= neg[i - 1]) || !(neg[i] > 0)) mono = false;
    check('twoLayerXF S=-3 monotone', mono, JSON.stringify(neg));
  } catch (e) {
    allOk = false; report.push('THREW ' + (e && e.message ? e.message : e));
  }
  if (typeof console !== 'undefined' && console.log) {
    if (allOk) console.log('PRiSM 08: self-test passed (7 composite/multilayer evaluators)');
    else { console.log('PRiSM 08: SELF-TEST FAILED'); report.forEach(function (r) { console.log('  ' + r); }); }
  }
})();

})();  // end IIFE
