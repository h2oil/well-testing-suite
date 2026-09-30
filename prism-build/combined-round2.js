
// ═══════════════════════════════════════════════════════════════════════
// PRiSM Round-2 expansion — auto-injected from prism-build/
//   • 08-composite-multilayer        (Phase 5: 7 composite/multi-layer single-well)
//   • 09-interference-multilateral   (Phase 6: 16 interference + multi-lateral)
//   • 10-specialised-solvers         (Phase 7: #18 user-defined + #38 water injection)
//   • 11-polish                      (14 SVG schematics + 24 line tools + PNG + GA4)
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
// This module registers SIXTEEN multi-well, multi-lateral, multi-layer and
// interference evaluators on window.PRiSM_MODELS.
//
//   Model #  | key                           | ref. length | Description
//   ─────────┼───────────────────────────────┼─────────────┼──────────────────
//   #13      | interference                  | rw  | Two-well interference
//   #19      | mlHorizontalXF                | Lh  | Horizontal well, N layers, XF
//   #22      | mlNoXFFrac                    | xf  | Commingled fractured layers
//   #23      | mlNoXFHoriz                   | Lh  | Commingled horizontal layers
//   #24      | inclinedMLXF                  | rw  | Inclined well, N layers, XF
//   #25      | multiLatMLXF                  | Lh  | Multi-lateral well, N layers
//   #26      | mlMultiPerf                   | rw  | Multi-perforation, N layers
//   #27      | mlHorizInterference           | rw  | Horizontal producer → obs well
//   #28      | mlMultiPerfInterference       | rw  | Multi-perf producer → obs
//   #29      | inclinedInterference          | rw  | Two inclined wells
//   #31      | linearCompInterference        | rw  | Obs in linear composite
//   #32      | linearCompMultiLat            | Lh  | Multi-lateral, linear comp.
//   #34      | linearCompMultiLatInterference| rw  | Multi-lateral → obs, lin. comp.
//   #35      | generalMLNoXF                 | rw  | Heterogeneous commingled layers
//   #36      | mlInterferenceXF              | rw  | Obs in N-layer XF reservoir
//   #37      | radialCompInterference        | rw  | Obs in radial composite
//
// REFERENCES (primary):
//   • Ogbe, D.O., Brigham, W.E. — SPE 13253 (1984), interference testing
//   • Kuchuk, F.J. — SPE 22731 (1991), multilayer transient analysis
//   • Kuchuk & Wilkinson — SPE 18125, commingled layered reservoirs
//   • Ozkan, E., Raghavan, R. — SPE Formation Evaluation (1991), source
//        functions for horizontal wells (Laplace domain)
//   • Cinco-Ley, Miller, Ramey — JPT Nov 1975 (slanted wells)
//   • Brons & Marting (1961) partial-penetration pseudo-skin
//   • Lefkovits & Hazebroek — SPEJ 1961 (commingled layered reservoirs)
//
// NUMERICS (WP4b):
//   • Smooth, exponentially scaled Bessel functions and ∫K0 (local), so the
//     Stehfest inversion is accurate to ~1e-8 and never overflows.
//   • Horizontal wells use the Ozkan-Raghavan uniform-flux line source between
//     no-flow planes (window.PRiSM_lap_horizontal when present and consistent,
//     else the local kernel).  The geometry is in the kernel: the old additive
//     "Sg" / "−ln(nLegs)" pseudo-skins are gone.  Multi-laterals superpose the
//     laterals (uniform rate split, averaged wellbore pressure).
//   • Multi-layer cross-flow factor is the smooth Warren-Root form per layer
//     (no hard clamp): f(s) = Σ κ_i·[ω_i(1−ω_i)s + λ_i]/[(1−ω_i)s + λ_i].
//   • WBS + skin fold is valid for negative skin: rw-referenced models use the
//     effective-wellbore-radius transform; horizontal (Lh) models move the
//     wellbore-radius offset of the kernel (rw → rw·e^−s_m).
//   • Interference (observation) models switch to the line-source shape
//     E1(rD²/4tD) for tD/rD² < 0.2, scaled to the Laplace value at the switch
//     (continuous, monotone), and zero-clamp |values| < 1e-10.
//   • Pseudo-skins: Brons-Marting (perforations), Cinco-Ley (inclination),
//     taken from window.PRiSM_pseudoSkin when present.
//
// CONVENTIONS: PRiSM_model_<name>(td, params) → pd;
//   PRiSM_model_<name>_pd_prime(td, params) → td·dpd/dtd.  Single outer IIFE;
//   registry merged onto window.PRiSM_MODELS.  Parameters starting with "__"
//   (e.g. __h_rw = h/rw, default 100) are injected by the physical wrapper.
// =============================================================================

(function () {
'use strict';

// =============================================================================
// SECTION 1 — Shared helpers & primitives
// =============================================================================

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

var BIG             = 1e30;

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

function _posOr(v, d) { return (_num(v) && v > 0) ? v : d; }

// h/rw (injected by the physical wrapper as __h_rw; default 100)
function _hOverRw(params) { return _posOr(params && params.__h_rw, 100); }

// Observation point from (rxObs, thetaObs) in rw units.
function _rdFromObs(rxObs, thetaDeg) {
    if (rxObs == null || !_num(rxObs) || rxObs <= 0) {
        throw new Error('rxObs must be > 0 (got ' + rxObs + ')');
    }
    var th = (thetaDeg == null || !_num(thetaDeg)) ? 0 : (thetaDeg * Math.PI / 180);
    return { rD: rxObs, theta: th, x: rxObs * Math.cos(th), y: rxObs * Math.sin(th) };
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

// ---- Stehfest context --------------------------------------------------------
// The horizontal-well kernel chooses its series representation and truncation
// from the Laplace-variable range of the current inversion ([ln2/t, 12·ln2/t]),
// so every sample of one inversion uses the same representation (a smooth
// error in s; Stehfest amplifies jumps, not smooth errors).
var _ctx = null;
var _stehBase = _steh;
_steh = function (F, t) {
    var prev = _ctx;
    _ctx = { sMin: Math.LN2 / t, sMax: 12 * Math.LN2 / t };
    try { return _stehBase(F, t); } finally { _ctx = prev; }
};
function _uRange(uOf, u) {
    if (!_ctx) return { lo: u, hi: u };
    var a = uOf(_ctx.sMin), b = uOf(_ctx.sMax);
    return { lo: Math.min(a, b, u), hi: Math.max(a, b, u) };
}

// ---- Pseudo-skins (shared export preferred) ---------------------------------
function _pseudoLib() {
    var lib = _win().PRiSM_pseudoSkin;
    return (lib && typeof lib === 'object') ? lib : null;
}
function _bronsMartingLocal(b, hD) {
    if (!_num(b) || !_num(hD) || b <= 0 || b >= 1 || hD <= 0) return 0;
    var G = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;
    return Math.max(0, (1 / b - 1) * (Math.log(hD) - G));
}
function _bronsMarting(b, hD) {
    var lib = _pseudoLib();
    if (lib && typeof lib.bronsMarting === 'function') {
        try { var v = lib.bronsMarting(b, hD); if (_num(v)) return v; } catch (e) { /* local */ }
    }
    return _bronsMartingLocal(b, hD);
}
// Cinco-Ley, Miller & Ramey (1975) slant pseudo-skin, θ in degrees:
//   θ' = atan(√(kv/kh)·tan θ);  S_θ = −(θ'/41)^2.06 − (θ'/56)^1.865·log10(hD/100)
//   hD = (h/rw)·√(kh/kv)
function _cincoLeyLocal(thetaDeg, kvkh, hD) {
    if (!_num(thetaDeg) || thetaDeg <= 0) return 0;
    var th = Math.min(thetaDeg, 89.9) * Math.PI / 180;
    var thp = Math.atan(Math.sqrt(_posOr(kvkh, 1)) * Math.tan(th)) * 180 / Math.PI;
    var hd = _posOr(hD, 100);
    return -Math.pow(thp / 41, 2.06) - Math.pow(thp / 56, 1.865) * (Math.log(hd / 100) / Math.LN10);
}
function _cincoLey(thetaDeg, kvkh, hD) {
    var lib = _pseudoLib();
    if (lib && typeof lib.cincoLey === 'function') {
        try { var v = lib.cincoLey(thetaDeg, kvkh, hD); if (_num(v)) return v; } catch (e) { /* local */ }
    }
    return _cincoLeyLocal(thetaDeg, kvkh, hD);
}

// ---- ∫K0, E1, Gauss-Legendre, line-source integrals ---------------------------
// Ki(z) = ∫_0^z K0(t) dt: exact power series for z ≤ 12, π/2 − tail above.
function _KiSeries(z) {
    var hz = 0.5 * z, lz = Math.log(hz), q = hz * hz;
    var pw = 2 * hz, inv = 1, H = 0, sum = 0;
    for (var k = 0; k < 200; k++) {
        if (k > 0) { pw *= q; inv /= (k * k); H += 1 / k; }
        var m = 2 * k + 1;
        var term = inv * pw / m * (H - _EULER - lz + 1 / m);
        sum += term;
        if (k > 3 && Math.abs(term) < 1e-17 * Math.abs(sum)) break;
    }
    return sum;
}
function _KicAsym(z) {   // ∫_z^∞ K0, z > 12
    var iz = 1 / z;
    return Math.sqrt(Math.PI / (2 * z)) * Math.exp(-z) *
        (1 + iz * (-0.625 + iz * (1.0078125 + iz * (-2.5927734375 + iz * 9.186859130859375))));
}
function _Ki(z)  { if (!(z > 0)) return 0; return z <= 12 ? _KiSeries(z) : Math.PI / 2 - _KicAsym(z); }
function _Kic(z) { if (!(z > 0)) return Math.PI / 2; return z <= 12 ? Math.PI / 2 - _KiSeries(z) : _KicAsym(z); }

// E1(x), x > 0. Uses the foundation PRiSM_E1 (01-foundation.js, A&S 5.1.11 /
// 5.1.22) when it is loaded; the local copy below is the same algorithm and is
// kept only so this file still runs standalone (smoke-test stub, convention 6).
var _e1Impl;
function _E1(x) {
    if (!(x > 0) || !isFinite(x)) return (x === Infinity) ? 0 : NaN;
    if (_e1Impl === undefined) _e1Impl = _foundation('PRiSM_E1') || null;
    if (_e1Impl) return _e1Impl(x);
    return _E1local(x);
}
function _E1local(x) {
    if (x <= 1.0) {
        var sum = 0, term = 1;
        for (var n = 1; n <= 60; n++) {
            term *= -x / n;
            var add = -term / n;
            sum += add;
            if (Math.abs(add) < 1e-16 * Math.abs(sum)) break;
        }
        return -Math.log(x) - _EULER + sum;
    }
    var TINY = 1e-300, b = x + 1.0, c = 1.0 / TINY, d = 1.0 / b, h = d;
    for (var i = 1; i <= 200; i++) {
        var a = -i * i;
        b += 2.0;
        d = 1.0 / (a * d + b); if (d === 0) d = TINY;
        c = b + a / c;          if (c === 0) c = TINY;
        var delta = c * d;
        h *= delta;
        if (Math.abs(delta - 1.0) < 1e-14) break;
    }
    return h * Math.exp(-x);
}

var _GLC = {};
function _GL(n) {
    if (_GLC[n]) return _GLC[n];
    var x = [], w = [];
    for (var i = 1; i <= n; i++) {
        var z = Math.cos(Math.PI * (i - 0.25) / (n + 0.5)), pp = 1;
        for (var it = 0; it < 100; it++) {
            var p1 = 1, p2 = 0;
            for (var j = 1; j <= n; j++) { var p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
            pp = n * (z * p1 - p2) / (z * z - 1);
            var z1 = z; z = z1 - p1 / pp;
            if (Math.abs(z - z1) < 1e-15) break;
        }
        x.push(z); w.push(2 / ((1 - z * z) * pp * pp));
    }
    return (_GLC[n] = { x: x, w: w });
}
function _glInt(f, a, b, n) {
    var g = _GL(n), m = 0.5 * (b + a), r = 0.5 * (b - a), s = 0;
    for (var i = 0; i < g.x.length; i++) s += g.w[i] * f(m + r * g.x[i]);
    return s * r;
}
// ∫ g(√(τ² + y²)) dτ over τ = α − x, α ∈ [−1, 1], with the substitution
// τ = y·sinh w (smooth integrand even when y ≪ 1).  The interval is split at
// τ = 0 when the point projects onto the segment (|x| < 1).  wCap bounds w
// where the integrand has decayed by e^-40 relative to its peak (a smooth
// function of the Laplace variable, so Stehfest sees a smooth error).
function _segInt(gOfW, x, y, n, wCap) {
    var t0 = -1 - x, t1 = 1 - x;
    var cap = (wCap > 0) ? wCap : Infinity;
    function piece(a, b) {                     // 0 ≤ a < b
        if (!(b > a)) return 0;
        var lo = Math.asinh(a / y), hi = Math.min(Math.asinh(b / y), cap);
        if (!(hi > lo)) return 0;
        return _glInt(gOfW, lo, hi, n);
    }
    if (t0 >= 0) return piece(t0, t1);
    if (t1 <= 0) return piece(-t1, -t0);
    return piece(0, -t0) + piece(0, t1);
}
// ∫_{-1}^{1} K0(k·√((x−α)² + y²)) dα, y > 0
function _lineK0(k, x, y) {
    if (!(k > 0)) return 0;
    y = Math.max(y, 1e-9);
    var ky = k * y;
    if (ky > 60) return 0;                     // < e^-60 of the near-well terms
    return _segInt(function (w) {
        var c = Math.cosh(w), z = ky * c;
        return z > 700 ? 0 : _K0e(z) * Math.exp(-z) * y * c;
    }, x, y, 32, Math.acosh(1 + 40 / ky));
}
// ∫_{-1}^{1} exp(−k·R)/R dα, R = √((x−α)² + ρ²)
function _lineExp(k, x, rho) {
    rho = Math.max(rho, 1e-12);
    var kr = k * rho;
    return _segInt(function (w) {
        var z = kr * Math.cosh(w);
        return z > 700 ? 0 : Math.exp(-z);
    }, x, rho, 40, kr > 0 ? Math.acosh(1 + 40 / kr) : Infinity);
}
// K0(y·r)/(y·K1(y)) — finite-wellbore-normalised line source at distance r
// (r in wellbore radii; an observation point cannot lie inside the effective
// wellbore, e.g. rD·e^S < 1 under a large negative skin, so r ≥ 1)
function _kOverWell(y, r) {
    r = Math.max(r, 1);
    var ex = -y * (r - 1);
    if (ex < -745) return 0;
    if (ex > 700) ex = 700;
    return _K0e(y * r) / (y * _K1e(y)) * Math.exp(ex);
}


// =============================================================================
// SECTION 1.5 — Multi-layer cross-flow factor
// =============================================================================
// Layers carry storativity ω_i (fraction of total), conductivity κ_i = kh_i/Σkh
// and a cross-flow coefficient λ_i.  Smooth Warren-Root form per layer:
//
//   f(s) = Σ_i κ_i · [ω_i(1−ω_i)s + λ_i] / [(1−ω_i)s + λ_i]
//
// f → Σ κ_i ω_i at early time (only the fast storage responds) and → 1 at late
// time (kh-weighted radial flow).  One layer with κ = 1 is exactly the
// Warren-Root double-porosity factor.  The previous form had f → 0 at early
// time and relied on a hard clamp (min(1, max(f, 0.001))), which put kinks in
// the transform and Stehfest noise in the derivative.  λ is referenced to the
// model's own dimensionless time (rw² or Lh²) and scales by 1/sc² under the
// negative-skin transform.
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
            extras: Lj.extras || {}
        });
    }
    return norm;
}

function _multiLayerXF_f(s, layers, sc) {
    var inv2 = 1 / ((sc || 1) * (sc || 1));
    var f = 0;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var om = Math.min(0.99, Math.max(0.01, L.omega));
        var lam = L.lambda * inv2;
        var den = (1 - om) * s + lam;
        f += L.kappa * ((den > 0) ? (om * (1 - om) * s + lam) / den : om);
    }
    return f > 0 ? f : 1;
}
function _multiLayerXF_fInf(layers) {
    var f = 0;
    for (var i = 0; i < layers.length; i++) f += layers[i].kappa * Math.min(0.99, Math.max(0.01, layers[i].omega));
    return f > 0 ? f : 1;
}

// Vertical well in the layered XF system (finite wellbore)
function _pdLap_multiLayerXF(s, layers, sc) {
    var sf = s * _multiLayerXF_f(s, layers, sc);
    if (!(sf > 0) || !_num(sf)) return BIG;
    return _wellTerm(Math.sqrt(sf)) / s;
}


// =============================================================================
// SECTION 1.6 — Horizontal-well kernel (Ozkan-Raghavan, Laplace domain)
// =============================================================================
// Uniform-flux line source of half-length Lh along x, at height zw in a slab
// with no-flow top and bottom.  Lengths in Lh units, anisotropy through
// LD = (Lh/h)·√(kv/kh).  With u the Laplace variable of the flow problem
// (u = s, or s·f(s) with cross-flow) the well response is p̄ = H(u)/s:
//
//   H(u) = ½∫₋₁¹K0(√u|xD−α|)dα
//          + Σ_{n≥1} cos(nπzD)cos(nπzwD) ∫₋₁¹K0(√(u+n²π²LD²)|xD−α|)dα
//
// evaluated at the infinite-conductivity equivalent point xD = 0.732 and
// zD = zwD + rw/h (the wellbore wall).  Two exact representations are used:
//   • eigen series (above) with the 1/n and u/n³ asymptotic terms summed in
//     closed form / precomputed, for small-to-moderate u;
//   • the image (Poisson-dual) form for large u (early time):
//       H(u) = 1/(4LD) · Σ_images ∫₋₁¹ exp(−√u·R)/R dα
// They agree to ~1e-10; the choice and the truncation are fixed for a whole
// Stehfest inversion (see _ctx).  Early radial derivative 1/(4LD)
// (= 0.5·(h/L)·√(kh/kv), L = 2Lh), late pseudo-radial derivative 0.5.
// =============================================================================

var _HZ_XD = 0.732;
var _hzCache = {}, _hzCacheN = 0;

function _hzGeom(LD, zw, dz, KvKh) {
    zw = Math.min(0.98, Math.max(0.02, _num(zw) ? zw : 0.5));
    var zD = Math.min(zw + dz, 0.999);
    var key = LD + '|' + zw + '|' + zD + '|' + KvKh;
    var g = _hzCache[key];
    if (g) return g;
    if (_hzCacheN > 400) { _hzCache = {}; _hzCacheN = 0; }
    var d = zD - zw, sg = zD + zw;
    var Cinf = -0.5 * (Math.log(Math.abs(2 * Math.sin(Math.PI * d / 2))) +
                       Math.log(Math.abs(2 * Math.sin(Math.PI * sg / 2))));
    var M = Math.min(200000, Math.max(20000, Math.ceil(50 / Math.max(d, 1e-6)))), S3 = 0;
    for (var n = M; n >= 1; n--) S3 += Math.cos(n * Math.PI * zD) * Math.cos(n * Math.PI * zw) / (n * n * n);
    g = { LD: LD, zw: zw, zD: zD, dz: d, KvKh: KvKh, xD: _HZ_XD, a: 1 + _HZ_XD, b: 1 - _HZ_XD,
          Cinf: Cinf, S3: S3, piLD: Math.PI * LD, ext: undefined };
    _hzCache[key] = g; _hzCacheN++;
    return g;
}

function _hzSelfEigen(u, g, N) {
    var su = Math.sqrt(u);
    var H = (_Ki(su * g.a) + _Ki(su * g.b)) / (2 * su);
    var sum = 0;
    for (var n = 1; n <= N; n++) {
        var cc = Math.cos(n * Math.PI * g.zD) * Math.cos(n * Math.PI * g.zw);
        var nl = n * g.piLD, en = Math.sqrt(u + nl * nl);
        var r = u / (nl * nl);
        // π(1/ε_n − 1/nl) + π·u/(2 nl³) = (π/nl)(1/√(1+r) − 1 + r/2)
        var alg = (r < 1e-3) ? (Math.PI / nl) * r * r * (0.375 - 0.3125 * r)
                             : (Math.PI / nl) * (1 / Math.sqrt(1 + r) - 1 + 0.5 * r);
        sum += cc * (alg - (_Kic(g.a * en) + _Kic(g.b * en)) / en);
    }
    var B = -Math.PI * u / (2 * g.piLD * g.piLD * g.piLD) * g.S3;
    return H + sum + g.Cinf / g.LD + B;
}

function _hzSelfImage(u, g) {
    var su = Math.sqrt(u), tot = 0, LD = g.LD;
    for (var m = 0; m < 6000; m++) {
        var any = false;
        var list = (m === 0) ? [g.zD - g.zw, g.zD + g.zw]
                             : [g.zD - g.zw - 2 * m, g.zD - g.zw + 2 * m, g.zD + g.zw - 2 * m, g.zD + g.zw + 2 * m];
        for (var i = 0; i < list.length; i++) {
            var rho = Math.abs(list[i]) / LD;
            if (su * rho > 45) continue;
            any = true;
            tot += _lineExp(su, g.xD, rho);
        }
        if (!any && m > 0) break;
    }
    return tot / (4 * LD);
}

// Representation: image form when the images are far apart on the diffusion
// scale (always for √u ≥ 20·LD) or when it needs far fewer operations than
// the eigen series (thin-geometry / small-LD cases); fixed per inversion.
function _hzSelfLocal(u, g, rng) {
    var lo = rng ? rng.lo : u, hi = rng ? rng.hi : u;
    var slo = Math.sqrt(lo);
    if (slo >= 20 * g.LD) return _hzSelfImage(u, g);
    var N = Math.ceil(60 * Math.sqrt(Math.max(hi, 1)) / g.piLD) + Math.ceil(40 / (g.b * g.piLD)) + 10;
    var shells = (slo > 0) ? Math.ceil(45 * g.LD / (2 * slo)) + 1 : Infinity;
    if (shells * 40 < N && shells < 5000) return _hzSelfImage(u, g);
    return _hzSelfEigen(u, g, Math.min(N, 20000));
}

// Delegation to window.PRiSM_lap_horizontal(s, params) → p̄ (= H(s)/s) when it
// exists and reproduces the local kernel for this geometry (checked once).
function _hzExtParams(g) {
    var kvkh = _posOr(g.KvKh, 1);
    return { KvKh: kvkh, L_to_h: 2 * g.LD / Math.sqrt(kvkh), zw_to_h: g.zw,
             __h_rw: 1 / Math.max(g.dz, 1e-9), Cd: 0, S: 0, S_perf: 0, S_global: 0 };
}
// Finite-wellbore correction: the line source evaluated at the wellbore wall
// has the near-well term K0(z)/(2LD), z = √u·dz/LD; replacing it by the
// cylinder form K0(z)/(z·K1(z))/(2LD) keeps s·p̄ ~ 1/√s at early time (so
// storage is honoured and Stehfest stays well conditioned) and changes
// nothing once √u·dz/LD ≪ 1.
function _hzWellCorr(u, g) {
    var z = Math.sqrt(u) * g.dz / g.LD;
    if (!(z > 0)) return 0;
    var k0e = _K0e(z);
    return k0e * (1 / (z * _K1e(z)) - Math.exp(-z)) / (2 * g.LD);
}
function _hzSelf(u, g, rng) {
    return _hzSelfLine(u, g, rng) + _hzWellCorr(u, g);
}
function _hzSelfLine(u, g, rng) {
    var ext = _win().PRiSM_lap_horizontal;
    if (typeof ext === 'function' && g.ext !== false) {
        var P = _hzExtParams(g);
        if (g.ext === undefined) {
            g.ext = false;
            try {
                var ok = true, probes = [1e-3, 1, 100];
                for (var i = 0; i < probes.length && ok; i++) {
                    var pu = probes[i];
                    var ve = pu * ext(pu, P), vl = _hzSelfLocal(pu, g, null);
                    ok = _num(ve) && Math.abs(ve - vl) <= 1e-3 * Math.abs(vl);
                }
                g.ext = ok;
            } catch (e) { g.ext = false; }
        }
        if (g.ext) {
            try { var v = u * ext(u, P); if (_num(v) && v > 0) return v; } catch (e2) { /* local */ }
        }
    }
    return _hzSelfLocal(u, g, rng);
}

// Kernel of another lateral (same zw, horizontal offset y > 0, Lh units),
// evaluated at xD = 0.732 of the receiving lateral.  Converges exponentially
// in n (e^{−nπLD·y}); the truncation depends on the geometry only.
function _hzCross(u, g, y) {
    var su = Math.sqrt(u);
    var H = 0.5 * _lineK0(su, g.xD, y);
    var N = Math.min(2000, Math.ceil(40 / (g.piLD * y)) + 2);
    for (var n = 1; n <= N; n++) {
        var c = Math.cos(n * Math.PI * g.zw);
        var nl = n * g.piLD, en = Math.sqrt(u + nl * nl);
        if (en * y > 60) break;                // all further terms vanish
        H += c * c * _lineK0(en, g.xD, y);
    }
    return H;
}
// Vertically-averaged observation response (fully penetrating obs well) at
// (x, y) Lh units from the lateral centre: the n = 0 term.
function _hzObs(u, x, y) {
    return 0.5 * _lineK0(Math.sqrt(u), x, Math.max(Math.abs(y), 1e-6));
}

// Lateral positions (Lh units), centred on y = 0
function _legOffsets(nLegs, spacingLh) {
    var ys = [];
    for (var i = 0; i < nLegs; i++) ys.push((i - (nLegs - 1) / 2) * spacingLh);
    return ys;
}
// Multi-lateral H: uniform rate split, averaged wellbore pressure
//   H_ml = (1/n²)·[n·H_self + Σ_{i≠j} H_cross(|y_i − y_j|)]
function _hzMulti(u, g, ys, rng) {
    var n = ys.length;
    var self = _hzSelf(u, g, rng);
    if (n <= 1) return self;
    var cross = 0, memo = {};
    for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
            var dy = Math.abs(ys[i] - ys[j]), key = dy.toPrecision(12);
            if (!(key in memo)) memo[key] = _hzCross(u, g, dy);   // equal spacings repeat
            cross += 2 * memo[key];
        }
    }
    return (n * self + cross) / (n * n);
}

// Horizontal geometry from params: LD, zw, rw/h offset, anisotropy
function _hzParams(params, L_to_h_override) {
    var KvKh = params.KvKh, L2h = (L_to_h_override != null) ? L_to_h_override : params.L_to_h;
    if (!_num(KvKh) || KvKh <= 0) throw new Error('PRiSM horizontal: KvKh must be > 0');
    if (!_num(L2h) || L2h <= 0) throw new Error('PRiSM horizontal: L_to_h must be > 0');
    return { LD: 0.5 * L2h * Math.sqrt(KvKh), zw: _num(params.zw_to_h) ? params.zw_to_h : 0.5,
             dz0: 1 / _hOverRw(params), KvKh: KvKh };
}

// Negative skin on a horizontal well (Lh-referenced): a mechanical skin s_m
// adds s_m·c to s·p̄ where c = Σ(weights)/(2LD) is the coefficient of −ln(rw)
// in the near-well term.  S < 0 is applied as rw → rw·e^{−s_m}, s_m = S/c
// (capped so the wellbore wall stays well inside the layer and close to the
// lateral compared with its length, dz ≤ 0.1·LD); any remainder uses
// the generic transform in the fold.
function _hzSkin(S, c, dz0, zw, LD) {
    if (!(S < 0) || !(c > 0)) return { dz: dz0, S: S };
    var sm = S / c;
    var dzMax = Math.min(0.45 * Math.min(zw, 1 - zw), 0.1 * LD);
    if (!(dzMax > dz0)) return { dz: dz0, S: S };
    var dz = dz0 * Math.exp(-sm);
    if (dz <= dzMax) return { dz: dz, S: 0 };
    var used = Math.log(dzMax / dz0);            // = −s_m actually applied
    return { dz: dzMax, S: S + used * c };
}


// =============================================================================
// SECTION 1.7 — Observation (interference) fold
// =============================================================================
// Observation pressure with producer storage and skin:
//   p̄_obs = p̄_res(r) / (1 + Cd·s·(s·p̄_well + S))
// p̄_res(r) uses the finite-wellbore normalisation of the producer.  At small
// tD/rD² the Stehfest inversion of the (tiny) line-source response degrades
// (N = 12: −2 % at tD/rD² = 0.05, 1e-4 at 0.2, garbage at 0.02), so for
// tD < 0.2·rD²·f∞ the time-domain shape E1(rD²f∞/4tD) is used, scaled to the
// Laplace value at the switch (continuous and monotone; without storage the
// scale is ½ to 1e-4, i.e. the plain line source ½·E1).  |values| < 1e-10
// are clamped to 0.
function _evalObs(wellLap, obsLap, td, Cd, S, early, deriv) {
    var isArr = Array.isArray(td), arr = isArr ? td : [td];
    var T = _foldTransform(Cd, S);
    var F = function (s) {
        var o = obsLap(s, T.sc);
        if (!(T.Cd > 0)) return o;
        var g = s * wellLap(s, T.sc) + T.S;
        return o / (1 + T.Cd * s * g);
    };
    var Fd = function (s) { return s * F(s); };
    var U_SW = 1.25;                                   // u = rD²f∞/(4tD) at the switch
    var tsw = (early && early.r2 > 0) ? early.r2 * (early.finf || 1) / (4 * U_SW) : 0;
    var swC = null;
    function switchCoef() {
        if (swC === null) {
            var v = _steh(F, tsw * T.tf);
            swC = (_num(v) && v > 0) ? v / _E1(U_SW) : 0;
        }
        return swC;
    }
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
        var t0 = arr[i], v;
        if (t0 < tsw) {
            var u = U_SW * tsw / t0;
            var c = switchCoef();
            v = deriv ? c * Math.exp(-u) : c * _E1(u);
        } else {
            var t = t0 * T.tf;
            v = deriv ? t * _steh(Fd, t) : _steh(F, t);
        }
        if (_num(v) && Math.abs(v) < 1e-10) v = 0;
        out[i] = v;
    }
    return isArr ? out : out[0];
}

// Linear-composite chained attenuation (constant factor, phenomenological).
function _linearCompFactor(s, zones) {
    if (!Array.isArray(zones) || zones.length === 0) return 1;
    var damp = 1;
    for (var i = 1; i < zones.length; i++) {
        var Z = zones[i];
        var M = (Z && Z.M != null) ? Z.M : 1;
        var W = (Z && Z.W != null) ? Z.W : 1;
        if (!(M > 0) || !(W > 0)) continue;
        damp *= (1 + M) / (2 * M);
    }
    return damp;
}


// =============================================================================
// SECTION 2 — MODEL EVALUATORS
// =============================================================================

// -------------------------------------------------------------------- #13
// MODEL #13 — Two-well Interference (Ogbe & Brigham SPE 13253)
// ----------------------------------------------------------------------------
// Observation pressure at rD = rxObs (rw units) from a producer with storage
// and skin in an infinite homogeneous reservoir:
//   p̄_obs = K0(rD√s)/(s·√s·K1(√s)) / (1 + Cd·s·(s·p̄_w + S))
// Theta is a geometric label only (isotropic reservoir).  Cd_obs (optional)
// attenuates the observation response by 1/(1 + Cd_obs·s).
// ----------------------------------------------------------------------------
function _interferenceEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs']);
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var Cd_obs = _posOr(params.Cd_obs, 0);
    return _evalObs(
        function (s) { return _wellTerm(Math.sqrt(s)) / s; },
        function (s, sc) {
            var o = _kOverWell(Math.sqrt(s), obs.rD * sc) / s;
            return (Cd_obs > 0) ? o / (1 + Cd_obs * (sc * sc) * s) : o;
        },
        td, params.Cd, params.S, { r2: obs.rD * obs.rD, finf: 1 }, deriv);
}
function PRiSM_model_interference(td, params) { return _interferenceEval(td, params, false); }
function PRiSM_model_interference_pd_prime(td, params) { return _interferenceEval(td, params, true); }

// -------------------------------------------------------------------- #19
// MODEL #19 — Single Horizontal Well in N-layer Reservoir with cross-flow
// ----------------------------------------------------------------------------
// Ozkan-Raghavan horizontal kernel with the layered cross-flow factor:
//   p̄ = H(s·f(s)) / s        (td, Cd referenced to Lh)
// Total skin S_perf + S_global (S_global frozen by default — collinear).
// ----------------------------------------------------------------------------
function _mlHorizontalXFEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'L_to_h', 'KvKh', 'layers']);
    var hp = _hzParams(params);
    var layers = _normaliseLayers(params.layers);
    var sk = _hzSkin((params.S_perf || 0) + (params.S_global || 0), 1 / (2 * hp.LD), hp.dz0, hp.zw, hp.LD);
    var g = _hzGeom(hp.LD, hp.zw, sk.dz, hp.KvKh);
    return _evalWbsSkin(function (s, sc) {
        var uOf = function (x) { return x * _multiLayerXF_f(x, layers, sc); };
        var u = uOf(s);
        return _hzSelf(u, g, _uRange(uOf, u)) / s;
    }, td, params.Cd, sk.S, deriv, true);
}
function PRiSM_model_mlHorizontalXF(td, params) { return _mlHorizontalXFEval(td, params, false); }
function PRiSM_model_mlHorizontalXF_pd_prime(td, params) { return _mlHorizontalXFEval(td, params, true); }

// -------------------------------------------------------------------- #22
// MODEL #22 — Multi-layer No-XF, Each Layer Fractured (commingled)
// ----------------------------------------------------------------------------
// Reference: Kuchuk & Wilkinson SPE 18125; Gringarten et al (1974).
// Each layer has a uniform-flux vertical fracture (the Gringarten closed form
// √(πtD)·erf(1/(2√tD)) + ½E1(1/(4tD)) at xD = 0), half-length ratio
// xf_ratio = xf_i/xf_ref.  Laplace form of layer i (tD on xf_ref):
//   p̄_i(s) = xfR_i · Ki(√s/xfR_i) / s^{3/2}
//   p̄ = Σ κ_i p̄_i,  folded with Cd and S (proper WBS + skin fold; the old
//   time-domain "damping" put the skin at early time instead of late time).
// ----------------------------------------------------------------------------
function _pdLap_mlNoXFFrac(s, layers) {
    var ss = Math.sqrt(s), pd = 0;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var xfR = (L.extras && _num(L.extras.xf_ratio) && L.extras.xf_ratio > 0) ? L.extras.xf_ratio : 1;
        pd += L.kappa * xfR * _Ki(ss / xfR) / (s * ss);
    }
    return pd;
}
function _mlNoXFFracEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'layers']);
    var layers = _normaliseLayers(params.layers);
    return _evalWbsSkin(function (s) { return _pdLap_mlNoXFFrac(s, layers); },
                        td, params.Cd, params.S, deriv);
}
function PRiSM_model_mlNoXFFrac(td, params) { return _mlNoXFFracEval(td, params, false); }
function PRiSM_model_mlNoXFFrac_pd_prime(td, params) { return _mlNoXFFracEval(td, params, true); }

// -------------------------------------------------------------------- #23
// MODEL #23 — Multi-layer No-XF, Each Layer Horizontal (commingled)
// ----------------------------------------------------------------------------
// kh-weighted sum of Ozkan-Raghavan kernels, per-layer L/h (extras.L_to_h,
// default the global L_to_h), same lateral length (Lh reference).
// ----------------------------------------------------------------------------
function _mlNoXFHorizEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'layers']);
    var layers = _normaliseLayers(params.layers);
    var base = _hzParams(params);
    var geo = [], c = 0;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var l2h = (L.extras && _num(L.extras.L_to_h) && L.extras.L_to_h > 0) ? L.extras.L_to_h : params.L_to_h;
        var hp = _hzParams(params, l2h);
        geo.push({ kappa: L.kappa, hp: hp });
        c += L.kappa / (2 * hp.LD);
    }
    var LDmin = Infinity;
    for (var q = 0; q < geo.length; q++) LDmin = Math.min(LDmin, geo[q].hp.LD);
    var sk = _hzSkin((params.S_perf || 0) + (params.S_global || 0), c, base.dz0, base.zw, LDmin);
    for (var j = 0; j < geo.length; j++) geo[j].g = _hzGeom(geo[j].hp.LD, geo[j].hp.zw, sk.dz, geo[j].hp.KvKh);
    var uOf = function (x) { return x; };
    return _evalWbsSkin(function (s) {
        var rng = _uRange(uOf, s), pd = 0;
        for (var k = 0; k < geo.length; k++) pd += geo[k].kappa * _hzSelf(s, geo[k].g, rng);
        return pd / s;
    }, td, params.Cd, sk.S, deriv, true);
}
function PRiSM_model_mlNoXFHoriz(td, params) { return _mlNoXFHorizEval(td, params, false); }
function PRiSM_model_mlNoXFHoriz_pd_prime(td, params) { return _mlNoXFHorizEval(td, params, true); }

// -------------------------------------------------------------------- #24
// MODEL #24 — Inclined Well in Multi-layer with Cross-Flow
// ----------------------------------------------------------------------------
// Layered XF kernel (vertical-well form) plus the slant pseudo-skin:
//   Sg = S_θ(Cinco-Ley; θ, kv/kh, hD) [+ Brons-Marting(hp/h, hD) if hp < 1]
//   hD = (h/rw)·√(kh/kv).  (The partial-completion term is additive —
//   an approximation of the combined Cinco-Ley tables.)
// ----------------------------------------------------------------------------
function _inclined_pseudoskin(params) {
    var KvKh = params.KvKh, hp = params.hp_to_h;
    if (!_num(KvKh) || KvKh <= 0) throw new Error('KvKh must be > 0');
    if (!_num(hp) || hp <= 0 || hp > 1) throw new Error('hp_to_h must be in (0,1]');
    var hD = _hOverRw(params) * Math.sqrt(1 / KvKh);
    var S = _cincoLey(params.theta_deg, KvKh, hD);
    if (hp < 1) S += _bronsMarting(hp, hD);
    return S;
}
function _inclinedMLXFEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'theta_deg', 'hp_to_h', 'layers']);
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + _inclined_pseudoskin(params);
    var layers = _normaliseLayers(params.layers);
    return _evalWbsSkin(function (s, sc) { return _pdLap_multiLayerXF(s, layers, sc); },
                        td, params.Cd, Stotal, deriv);
}
function PRiSM_model_inclinedMLXF(td, params) { return _inclinedMLXFEval(td, params, false); }
function PRiSM_model_inclinedMLXF_pd_prime(td, params) { return _inclinedMLXFEval(td, params, true); }

// -------------------------------------------------------------------- #25
// MODEL #25 — Multi-lateral Well in Multi-layer (with XF)
// ----------------------------------------------------------------------------
// nLegs parallel laterals (length L = 2Lh each, spacing legSpacing×L) at the
// same depth, sharing the wellbore pressure.  Laterals are superposed with a
// uniform rate split (exact for two symmetric legs) and the wellbore pressure
// is the lateral average:
//   p̄ = (1/n²)[n·H_self(u) + Σ_{i≠j} H_cross(u, |y_i−y_j|)] / s,  u = s·f(s)
// ----------------------------------------------------------------------------
function _multiLatEval(td, params, deriv, useXF, attnZones) {
    var hp = _hzParams(params);
    var nLegs = Math.max(1, Math.round(_posOr(params.nLegs, 1)));
    var spacing = 2 * _posOr(params.legSpacing, 2.0);              // Lh units
    var ys = _legOffsets(nLegs, spacing);
    var layers = useXF ? _normaliseLayers(params.layers) : null;
    var sk = _hzSkin((params.S_perf || 0) + (params.S_global || 0), 1 / (2 * hp.LD * nLegs), hp.dz0, hp.zw, hp.LD);
    var g = _hzGeom(hp.LD, hp.zw, sk.dz, hp.KvKh);
    return _evalWbsSkin(function (s, sc) {
        var uOf = useXF ? function (x) { return x * _multiLayerXF_f(x, layers, sc); } : function (x) { return x; };
        var u = uOf(s);
        var H = _hzMulti(u, g, ys, _uRange(uOf, u));
        if (attnZones) H *= _linearCompFactor(s, attnZones);
        return H / s;
    }, td, params.Cd, sk.S, deriv, true);
}
function PRiSM_model_multiLatMLXF(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'layers']);
    return _multiLatEval(td, params, false, true, null);
}
function PRiSM_model_multiLatMLXF_pd_prime(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'layers']);
    return _multiLatEval(td, params, true, true, null);
}

// -------------------------------------------------------------------- #26
// MODEL #26 — Multi-layer Multi-perforation (1-4 perforated intervals)
// ----------------------------------------------------------------------------
// Layered XF kernel (vertical-well form) with the partial-penetration
// pseudo-skin of the perforated intervals: Brons-Marting with the combined
// open fraction b = Σ hp_i (≤ 1) and hD = (h/rw)·√(kh/kv).  Using the
// combined fraction (rather than averaging per-interval skins, each of which
// assumes that interval carries the whole rate) is the standard approximation
// for several intervals sharing the flow.
// ----------------------------------------------------------------------------
function _perfPseudoSkin(hp_to_h, KvKh, h_rw) {
    if (!_num(hp_to_h) || hp_to_h <= 0 || hp_to_h >= 1) return 0;
    var hD = _posOr(h_rw, 100) * Math.sqrt(1 / _posOr(KvKh, 1));
    return _bronsMarting(hp_to_h, hD);
}
function _multiPerfSkin(params, maxPerfs, label) {
    var perfs = params.perfs;
    if (!Array.isArray(perfs) || perfs.length === 0) {
        throw new Error('PRiSM ' + label + ': perfs array required');
    }
    if (perfs.length > maxPerfs) perfs = perfs.slice(0, maxPerfs);
    var totHp = 0;
    for (var i = 0; i < perfs.length; i++) {
        var hi = perfs[i] && perfs[i].hp_to_h;
        if (!_num(hi) || hi <= 0 || hi > 1) {
            throw new Error('PRiSM ' + label + ': perfs[' + i + '].hp_to_h must be in (0,1]');
        }
        totHp += hi;
    }
    return _perfPseudoSkin(Math.min(1, totHp), params.KvKh, _hOverRw(params));
}
function _mlMultiPerfEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'perfs', 'layers']);
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) + _multiPerfSkin(params, 4, 'mlMultiPerf');
    var layers = _normaliseLayers(params.layers);
    return _evalWbsSkin(function (s, sc) { return _pdLap_multiLayerXF(s, layers, sc); },
                        td, params.Cd, Stotal, deriv);
}
function PRiSM_model_mlMultiPerf(td, params) { return _mlMultiPerfEval(td, params, false); }
function PRiSM_model_mlMultiPerf_pd_prime(td, params) { return _mlMultiPerfEval(td, params, true); }

// -------------------------------------------------------------------- #27
// MODEL #27 — Multi-layer Horizontal-Well Interference
// ----------------------------------------------------------------------------
// Horizontal producer (lateral length L = L_to_h·h) in a layered XF reservoir,
// fully penetrating observation well at rxObs (rw units) and azimuth thetaObs
// measured from the lateral direction.  rw-referenced: with a = Lh/rw,
//   producer   p̄_w   = H(σ)/s,          σ = s·f(s)·a²
//   observation p̄_obs = ½∫₋₁¹K0(√σ·ρ)dα/s  at (x, y) = rxObs(cos θ, sin θ)/a
// Negative skin moves the producer wellbore wall (rw → rw·e^−s_m).
// ----------------------------------------------------------------------------
function _mlHorizInterferenceEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'rxObs', 'layers']);
    var hp = _hzParams(params);
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var layers = _normaliseLayers(params.layers);
    var a = 0.5 * params.L_to_h * _hOverRw(params);            // Lh / rw (× sc under the
    var a2 = a * a;                                              // residual rwa transform)
    var sk = _hzSkin((params.S_perf || 0) + (params.S_global || 0), 1 / (2 * hp.LD), hp.dz0, hp.zw, hp.LD);
    var g = _hzGeom(hp.LD, hp.zw, sk.dz, hp.KvKh);
    function uOfSc(sc) {
        var as2 = a2 * sc * sc;
        return function (x) { return x * _multiLayerXF_f(x, layers, sc) * as2; };
    }
    return _evalObs(
        function (s, sc) {
            var uOf = uOfSc(sc), u = uOf(s);
            return _hzSelf(u, g, _uRange(uOf, u)) / s;
        },
        function (s, sc) {
            var u = uOfSc(sc)(s);
            return _hzObs(u, obs.x / a, obs.y / a) / s;
        },
        td, params.Cd, sk.S, { r2: obs.rD * obs.rD, finf: _multiLayerXF_fInf(layers) }, deriv);
}
function PRiSM_model_mlHorizInterference(td, params) { return _mlHorizInterferenceEval(td, params, false); }
function PRiSM_model_mlHorizInterference_pd_prime(td, params) { return _mlHorizInterferenceEval(td, params, true); }

// -------------------------------------------------------------------- #28
// MODEL #28 — Multi-layer Multi-perforation Interference
// ----------------------------------------------------------------------------
// Producer with ≤ 3 perforated intervals (Brons-Marting skin on the combined
// open fraction) in a layered XF reservoir; observation at rxObs (rw units).
// ----------------------------------------------------------------------------
function _mlMultiPerfInterferenceEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'rxObs', 'perfs', 'layers']);
    var Stotal = (params.S_perf || 0) + (params.S_global || 0) +
                 _multiPerfSkin(params, 3, 'mlMultiPerfInterference');
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var layers = _normaliseLayers(params.layers);
    return _evalObs(
        function (s, sc) { return _pdLap_multiLayerXF(s, layers, sc); },
        function (s, sc) {
            var x = Math.sqrt(s * _multiLayerXF_f(s, layers, sc));
            return _kOverWell(x, obs.rD * sc) / s;
        },
        td, params.Cd, Stotal, { r2: obs.rD * obs.rD, finf: _multiLayerXF_fInf(layers) }, deriv);
}
function PRiSM_model_mlMultiPerfInterference(td, params) { return _mlMultiPerfInterferenceEval(td, params, false); }
function PRiSM_model_mlMultiPerfInterference_pd_prime(td, params) { return _mlMultiPerfInterferenceEval(td, params, true); }

// -------------------------------------------------------------------- #29
// MODEL #29 — Two Inclined Wells (Homogeneous or Double-Porosity)
// ----------------------------------------------------------------------------
// Phenomenological blend of the vertical line-source response at rD and a
// projected response at rD·cos(½(θp+θo)), weighted by w = sin θp·sin θo.
// dpMode 'pss' adds the Warren-Root f(s).
// ----------------------------------------------------------------------------
function _doublePorosity_f_pss(s, omega, lambda) {
    if (!(lambda > 0)) return omega;
    var denom = (1 - omega) * s + lambda;
    if (denom <= 0) return omega;
    return (omega * (1 - omega) * s + lambda) / denom;
}
function _inclinedInterferenceEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'theta_p_deg', 'theta_o_deg']);
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var thp = params.theta_p_deg * Math.PI / 180;
    var tho = params.theta_o_deg * Math.PI / 180;
    var dp = (params.dpMode === 'pss');
    var omega = _num(params.omega) ? Math.min(0.999, Math.max(0.001, params.omega)) : 0.1;
    var lambda = _posOr(params.lambda, 1e-5);
    var w = Math.sin(thp) * Math.sin(tho);
    var rDh = obs.rD * Math.max(0.1, Math.cos(0.5 * (thp + tho)));
    function fOf(s, sc) { return dp ? _doublePorosity_f_pss(s, omega, lambda / (sc * sc)) : 1; }
    return _evalObs(
        function (s, sc) { return _wellTerm(Math.sqrt(s * fOf(s, sc))) / s; },
        function (s, sc) {
            var x = Math.sqrt(s * fOf(s, sc));
            return ((1 - w) * _kOverWell(x, obs.rD * sc) + w * _kOverWell(x, rDh * sc)) / s;
        },
        td, params.Cd, params.S, { r2: rDh * rDh, finf: dp ? omega : 1 }, deriv);
}
function PRiSM_model_inclinedInterference(td, params) { return _inclinedInterferenceEval(td, params, false); }
function PRiSM_model_inclinedInterference_pd_prime(td, params) { return _inclinedInterferenceEval(td, params, true); }

// -------------------------------------------------------------------- #31
// MODEL #31 — Linear-Composite Reservoir Interference
// ----------------------------------------------------------------------------
// Line-source observation response with a chained transmissibility
// attenuation Π_{i≥1} (1+M_i)/(2M_i) over the zones beyond the first
// (phenomenological; zones carry no distances).
// ----------------------------------------------------------------------------
function _linearCompInterferenceEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'zones']);
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var zones = params.zones;
    if (!Array.isArray(zones) || zones.length === 0) {
        throw new Error('PRiSM linearCompInterference: zones array required');
    }
    if (zones.length > 5) zones = zones.slice(0, 5);
    return _evalObs(
        function (s) { return _wellTerm(Math.sqrt(s)) / s; },
        function (s, sc) { return _linearCompFactor(s, zones) * _kOverWell(Math.sqrt(s), obs.rD * sc) / s; },
        td, params.Cd, params.S, { r2: obs.rD * obs.rD, finf: 1 }, deriv);
}
function PRiSM_model_linearCompInterference(td, params) { return _linearCompInterferenceEval(td, params, false); }
function PRiSM_model_linearCompInterference_pd_prime(td, params) { return _linearCompInterferenceEval(td, params, true); }

// -------------------------------------------------------------------- #32
// MODEL #32 — Multi-lateral Producer in Linear-Composite Reservoir
// ----------------------------------------------------------------------------
// Multi-lateral kernel of #25 (no cross-flow) times the chained zone
// attenuation of #31 (Lh-referenced).
// ----------------------------------------------------------------------------
function PRiSM_model_linearCompMultiLat(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'zones']);
    return _multiLatEval(td, params, false, false, params.zones || []);
}
function PRiSM_model_linearCompMultiLat_pd_prime(td, params) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'zones']);
    return _multiLatEval(td, params, true, false, params.zones || []);
}

// -------------------------------------------------------------------- #34
// MODEL #34 — Linear-Composite Multi-lateral Interference
// ----------------------------------------------------------------------------
// Multi-lateral producer (rw-referenced, a = Lh/rw) and a fully penetrating
// observation well at rxObs (rw units, azimuth from the lateral direction,
// measured from the centre of the lateral set), attenuated by the chained
// zone factor:  p̄_obs = attn · (1/n)Σ_j ½∫K0(√σ·ρ_j)dα / s,  σ = s·a².
// ----------------------------------------------------------------------------
function _linearCompMultiLatInterferenceEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'nLegs', 'rxObs', 'zones']);
    var hp = _hzParams(params);
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var zones = params.zones || [];
    var nLegs = Math.max(1, Math.round(_posOr(params.nLegs, 1)));
    var ys = _legOffsets(nLegs, 2 * _posOr(params.legSpacing, 2.0));
    var a = 0.5 * params.L_to_h * _hOverRw(params), a2 = a * a;
    var sk = _hzSkin((params.S_perf || 0) + (params.S_global || 0), 1 / (2 * hp.LD * nLegs), hp.dz0, hp.zw, hp.LD);
    var g = _hzGeom(hp.LD, hp.zw, sk.dz, hp.KvKh);
    function uOfSc(sc) { var as2 = a2 * sc * sc; return function (x) { return x * as2; }; }
    return _evalObs(
        function (s, sc) { var uOf = uOfSc(sc), u = uOf(s); return _hzMulti(u, g, ys, _uRange(uOf, u)) / s; },
        function (s, sc) {
            var u = uOfSc(sc)(s), tot = 0;
            for (var j = 0; j < ys.length; j++) tot += _hzObs(u, obs.x / a, obs.y / a - ys[j]);
            return _linearCompFactor(s, zones) * tot / (ys.length * s);
        },
        td, params.Cd, sk.S, { r2: obs.rD * obs.rD, finf: 1 }, deriv);
}
function PRiSM_model_linearCompMultiLatInterference(td, params) { return _linearCompMultiLatInterferenceEval(td, params, false); }
function PRiSM_model_linearCompMultiLatInterference_pd_prime(td, params) { return _linearCompMultiLatInterferenceEval(td, params, true); }

// -------------------------------------------------------------------- #35
// MODEL #35 — General Multi-layer No-XF (heterogeneous layer types)
// ----------------------------------------------------------------------------
// kh-weighted commingled sum (Lefkovits-Hazebroek limit) of layer kernels in
// rw units, WBS + skin folded once at the well:
//   'homogeneous' — K0(√s)/(s√s K1(√s))
//   'fracture'    — uniform-flux fracture, extras.xf_rw = xf/rw (default 100):
//                   Ki(xf·√s)/(xf·s^{3/2})
//   'horizontal'  — Ozkan-Raghavan kernel, extras.L_to_h (default 5),
//                   extras.KvKh (default 1): H(s·a²)/s, a = Lh/rw
//   'composite'   — homogeneous × (1+M)/(2M) (extras.M)
//   'linearComp'  — homogeneous × chained attenuation (extras.zones)
// Negative skin: effective-wellbore-radius transform (all rw-normalised
// lengths of every layer scale by e^S).
// ----------------------------------------------------------------------------
function _layerPdLap(s, L, params, sc) {
    var ss = Math.sqrt(s);
    var typ = L.type || 'homogeneous';
    var ex = L.extras || {};
    if (typ === 'fracture') {
        var xf = _posOr(ex.xf_rw, 100) * sc;
        return _Ki(xf * ss) / (xf * s * ss);
    }
    if (typ === 'horizontal') {
        var l2h = _posOr(ex.L_to_h, 5), kvkh = _posOr(ex.KvKh, 1);
        var hrw = _hOverRw(params) * sc;
        var LD = 0.5 * l2h * Math.sqrt(kvkh);
        var a = 0.5 * l2h * hrw;
        var g = _hzGeom(LD, _num(ex.zw_to_h) ? ex.zw_to_h : 0.5, 1 / hrw, kvkh);
        var u = s * a * a;
        return _hzSelf(u, g, _uRange(function (x) { return x * a * a; }, u)) / s;
    }
    var base = _wellTerm(ss) / s;
    if (typ === 'composite') {
        var M = _posOr(ex.M, 1);
        return base * (1 + M) / (2 * Math.max(M, 0.001));
    }
    if (typ === 'linearComp') return base * _linearCompFactor(s, ex.zones || []);
    return base;
}
function _generalMLNoXFEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'layers']);
    var layers = _normaliseLayers(params.layers);
    return _evalWbsSkin(function (s, sc) {
        var pd = 0;
        for (var i = 0; i < layers.length; i++) pd += layers[i].kappa * _layerPdLap(s, layers[i], params, sc);
        return pd;
    }, td, params.Cd, params.S, deriv, true);
}
function PRiSM_model_generalMLNoXF(td, params) { return _generalMLNoXFEval(td, params, false); }
function PRiSM_model_generalMLNoXF_pd_prime(td, params) { return _generalMLNoXFEval(td, params, true); }

// -------------------------------------------------------------------- #36
// MODEL #36 — Multi-layer Interference, PSS λ cross-flow
// ----------------------------------------------------------------------------
//   p̄_obs = K0(rD·x)/(s·x·K1(x)),  x = √(s·f(s)) (layer-averaged pressure)
// ----------------------------------------------------------------------------
function _mlInterferenceXFEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'layers']);
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var layers = _normaliseLayers(params.layers);
    return _evalObs(
        function (s, sc) { return _pdLap_multiLayerXF(s, layers, sc); },
        function (s, sc) {
            var x = Math.sqrt(s * _multiLayerXF_f(s, layers, sc));
            return _kOverWell(x, obs.rD * sc) / s;
        },
        td, params.Cd, params.S, { r2: obs.rD * obs.rD, finf: _multiLayerXF_fInf(layers) }, deriv);
}
function PRiSM_model_mlInterferenceXF(td, params) { return _mlInterferenceXFEval(td, params, false); }
function PRiSM_model_mlInterferenceXF_pd_prime(td, params) { return _mlInterferenceXFEval(td, params, true); }

// -------------------------------------------------------------------- #37
// MODEL #37 — Radial-Composite Reservoir Interference
// ----------------------------------------------------------------------------
// Single-front engineering approximation (Bourdet 2002 §6.4.2):
//   obs in inner zone (rD ≤ RD): line source × (1 + (M−1)/(M+1)·K0(2RD√s)/K0(rD√s))
//   obs in outer zone (rD > RD): line source at rD·√W × 2M/(1+M)
// M = (k/μ)_outer/(k/μ)_inner, W = storativity ratio outer/inner.
// ----------------------------------------------------------------------------
function _radialCompInterferenceEval(td, params, deriv) {
    _requirePositiveTd(td);
    _requireParams(params, ['Cd', 'S', 'rxObs', 'RD', 'M']);
    var obs = _rdFromObs(params.rxObs, params.thetaObs);
    var RD = params.RD, M = params.M;
    var W = _posOr(params.W, 1);
    if (!_num(M) || M <= 0) throw new Error('PRiSM radialCompInterference: M must be > 0');
    if (!_num(RD) || RD <= 0) throw new Error('PRiSM radialCompInterference: RD must be > 0');
    var inner = obs.rD <= RD;
    var rEarly = inner ? obs.rD : obs.rD * Math.sqrt(W);
    return _evalObs(
        function (s) { return _wellTerm(Math.sqrt(s)) / s; },
        function (s, sc) {
            var y = Math.sqrt(s);
            if (inner) {
                var r = obs.rD * sc, R2 = 2 * RD * sc;
                var ratio = _K0e(y * R2) / _K0e(y * r) * Math.exp(-y * (R2 - r));
                var A = 1 + (M - 1) / (M + 1) * ratio;
                return _kOverWell(y, r) * Math.max(0.1, Math.min(10, A)) / s;
            }
            return _kOverWell(y, obs.rD * sc * Math.sqrt(W)) * (2 * M / (1 + M)) / s;
        },
        td, params.Cd, params.S, { r2: rEarly * rEarly, finf: 1 }, deriv);
}
function PRiSM_model_radialCompInterference(td, params) { return _radialCompInterferenceEval(td, params, false); }
function PRiSM_model_radialCompInterference_pd_prime(td, params) { return _radialCompInterferenceEval(td, params, true); }


// =============================================================================
// SECTION 3 — Registry merge (additive)
// =============================================================================
// Categories: 'interference', 'multilayer', 'multilateral', 'composite'.
// kind: 'pressure' for all sixteen.  refLength: 'rw' | 'Lh' | 'xf'.
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

var SKIN_FROZEN = ['S_global'];

var REGISTRY_ADDITIONS = {

    interference: {
        pd: PRiSM_model_interference,
        pdPrime: PRiSM_model_interference_pd_prime,
        defaults: { Cd: 100, S: 0, rxObs: 1000, thetaObs: 0, Cd_obs: 0 },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd (producer)', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S',        label: 'Skin S (producer)',              unit: '-', min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation radial distance rD', unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs', label: 'Observation azimuth',            unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'Cd_obs',   label: 'Obs-well storage Cd_obs',        unit: '-', min: 0, max: 1e10, default: 0 }
        ],
        refLength: 'rw',
        defaultFrozen: ['thetaObs', 'Cd_obs'],
        reference: 'Ogbe & Brigham, SPE 13253 (1984); Bourdet 2002 §7.4',
        category: 'interference',
        description: 'Two-well interference test. Line-source observation at rD with producer storage + skin. Theta is a geometric label (isotropic reservoir).',
        kind: 'pressure'
    },

    mlHorizontalXF: {
        pd: PRiSM_model_mlHorizontalXF,
        pdPrime: PRiSM_model_mlHorizontalXF_pd_prime,
        defaults: {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0, zw_to_h: 0.5,
            layers: DEFAULT_LAYERS_2
        },
        paramSpec: [
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',   label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1, scale: 'log' },
            { key: 'L_to_h',   label: 'Lateral length L / h_total', unit: '-', min: 0.1, max: 100, default: 5.0, scale: 'log' },
            { key: 'zw_to_h',  label: 'Lateral height zw/h',  unit: '-', min: 0.05, max: 0.95, default: 0.5 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',    unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        refLength: 'Lh',
        defaultFrozen: ['S_global', 'zw_to_h'],
        reference: 'Ozkan & Raghavan (1991) horizontal-well source functions; Kuchuk SPE 22731 (1991)',
        category: 'multilayer',
        description: 'Horizontal well in an N-layer reservoir with PSS cross-flow: Ozkan-Raghavan uniform-flux line source between no-flow planes evaluated at s·f(s). Time referenced to the lateral half-length.',
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
        refLength: 'xf',
        reference: 'Kuchuk & Wilkinson SPE 18125 (1989); Gringarten, Ramey & Raghavan (1974); Lefkovits-Hazebroek SPEJ 1961',
        category: 'multilayer',
        description: 'Multi-layer commingled (no-XF), each layer with a uniform-flux vertical fracture (half-length ratio xf_ratio). kh-weighted Laplace sum, proper storage + skin fold. Time referenced to the reference half-length.',
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
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',   label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1, scale: 'log' },
            { key: 'L_to_h',   label: 'Default L / h',        unit: '-', min: 0.1, max: 100, default: 5.0, scale: 'log' },
            { key: 'layers',   label: 'Layers (kh, ω, L_to_h)', unit: 'array', default: null }
        ],
        refLength: 'Lh',
        defaultFrozen: SKIN_FROZEN,
        reference: 'Kuchuk & Wilkinson SPE 18125 (1989); Ozkan & Raghavan (1991)',
        category: 'multilayer',
        description: 'Multi-layer commingled (no-XF), each layer with an Ozkan-Raghavan horizontal-well kernel (per-layer L/h). Time referenced to the lateral half-length.',
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
            { key: 'Cd',        label: 'Wellbore storage Cd', unit: '-',   min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',    label: 'Perforation skin',    unit: '-',   min: -7, max: 50, default: 0 },
            { key: 'S_global',  label: 'Global skin',         unit: '-',   min: -7, max: 50, default: 0 },
            { key: 'KvKh',      label: 'Anisotropy Kv/Kh',    unit: '-',   min: 0.001, max: 10, default: 1, scale: 'log' },
            { key: 'theta_deg', label: 'Inclination angle',   unit: 'deg', min: 0, max: 89, default: 45 },
            { key: 'hp_to_h',   label: 'Perforated fraction', unit: '-',   min: 0.01, max: 1, default: 1.0 },
            { key: 'layers',    label: 'Layers (kh, ω, λ)',   unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        refLength: 'rw',
        defaultFrozen: SKIN_FROZEN,
        pseudoSkin: function (params) { return _inclined_pseudoskin(params || {}); },
        reference: 'Cinco-Ley, Miller & Ramey JPT Nov 1975; Kuchuk SPE 22731 (1991); Brons-Marting (1961)',
        category: 'multilayer',
        description: 'Inclined / slant well in a layered reservoir with PSS cross-flow. Geometric skin = Cinco-Ley slant pseudo-skin (+ Brons-Marting when partially completed).',
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
            { key: 'Cd',         label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',     label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global',   label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1, scale: 'log' },
            { key: 'L_to_h',     label: 'Leg length L / h',     unit: '-', min: 0.1, max: 100, default: 5.0, scale: 'log' },
            { key: 'nLegs',      label: 'Number of legs',       unit: '-', min: 1, max: 8, default: 2 },
            { key: 'legSpacing', label: 'Leg spacing (×L)',     unit: '-', min: 0.1, max: 50, default: 2.0, scale: 'log' },
            { key: 'layers',     label: 'Layers (kh, ω, λ)',    unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        refLength: 'Lh',
        defaultFrozen: ['S_global', 'nLegs'],
        reference: 'Ozkan & Raghavan (1991) source functions; Kuchuk SPE 22731 (1991); Larsen & Hegre SPE 28298',
        category: 'multilateral',
        description: 'Multi-lateral well (parallel horizontal legs sharing the wellbore pressure) in a layered reservoir with PSS cross-flow: superposed Ozkan-Raghavan laterals, uniform rate split.',
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
            { key: 'Cd',       label: 'Wellbore storage Cd',    unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',   label: 'Perforation skin',       unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',            unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',       unit: '-', min: 0.001, max: 100, default: 0.1, scale: 'log' },
            { key: 'perfs',    label: 'Perforations (≤4 hp/h, zw/h)', unit: 'array', default: DEFAULT_PERFS_2 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',      unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        refLength: 'rw',
        defaultFrozen: SKIN_FROZEN,
        pseudoSkin: function (params) { return _multiPerfSkin(params || {}, 4, 'mlMultiPerf'); },
        reference: 'Kuchuk SPE 22731 (1991); Brons-Marting (1961) perforation pseudo-skin',
        category: 'multilayer',
        description: 'Layered reservoir with up to 4 perforated intervals (vertical well). Layer cross-flow via PSS f(s); Brons-Marting pseudo-skin on the combined open fraction.',
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
            { key: 'Cd',       label: 'Wellbore storage Cd',  unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',   label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1, scale: 'log' },
            { key: 'L_to_h',   label: 'Lateral length L / h', unit: '-', min: 0.1, max: 100, default: 5.0, scale: 'log' },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs', label: 'Observation azimuth (from lateral)', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',    unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        refLength: 'rw',
        defaultFrozen: ['S_global', 'thetaObs'],
        reference: 'Ozkan & Raghavan (1991) source functions; Kuchuk SPE 22731 (1991)',
        category: 'interference',
        description: 'Horizontal producer in a layered reservoir with PSS cross-flow, pressure at a fully penetrating observation well (vertically averaged Ozkan-Raghavan response).',
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
            { key: 'Cd',       label: 'Wellbore storage Cd',    unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',   label: 'Perforation skin',       unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global', label: 'Global skin',            unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',     label: 'Anisotropy Kv/Kh',       unit: '-', min: 0.001, max: 100, default: 0.1, scale: 'log' },
            { key: 'rxObs',    label: 'Observation distance',   unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs', label: 'Observation azimuth',    unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'perfs',    label: 'Producer perfs (≤3)',    unit: 'array', default: DEFAULT_PERFS_2 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',      unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        refLength: 'rw',
        defaultFrozen: ['S_global', 'thetaObs'],
        pseudoSkin: function (params) { return _multiPerfSkin(params || {}, 3, 'mlMultiPerfInterference'); },
        reference: 'Kuchuk SPE 22731 (1991); Brons-Marting (1961)',
        category: 'interference',
        description: 'Multi-layer multi-perforation interference: ≤3 producing intervals + 1 observation point in a layered reservoir with PSS cross-flow.',
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
            { key: 'Cd',          label: 'Wellbore storage Cd', unit: '-',  min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S',           label: 'Producer skin S',     unit: '-',  min: -7, max: 50, default: 0 },
            { key: 'rxObs',       label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs',    label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'theta_p_deg', label: 'Producer inclination', unit: 'deg', min: 0, max: 89, default: 45 },
            { key: 'theta_o_deg', label: 'Observation incl',     unit: 'deg', min: 0, max: 89, default: 30 },
            { key: 'dpMode',      label: 'Reservoir kind',       unit: '',   options: ['none', 'pss'], default: 'none' },
            { key: 'omega',       label: 'DP storativity ω',     unit: '-',  min: 0.001, max: 0.999, default: 0.1 },
            { key: 'lambda',      label: 'DP coefficient λ',     unit: '-',  min: 1e-9, max: 1e-2, default: 1e-5, scale: 'log' }
        ],
        refLength: 'rw',
        defaultFrozen: ['thetaObs'],
        reference: 'Cinco et al JPT Nov 1975; Kuchuk & Wilkinson SPE 18125 (1989)',
        category: 'interference',
        description: 'Two inclined wells in a homogeneous or PSS double-porosity reservoir. Phenomenological vertical/projected blend weighted by sin(θ_p)·sin(θ_o).',
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
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S',        label: 'Producer skin S',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs', label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'zones',    label: 'Zones (≤5: M, W ratios)', unit: 'array', default: DEFAULT_ZONES_2 }
        ],
        refLength: 'rw',
        defaultFrozen: ['thetaObs'],
        reference: 'Bourdet 2002 §6.4; chained transmissibility approximation',
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
            { key: 'Cd',         label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',     label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global',   label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1, scale: 'log' },
            { key: 'L_to_h',     label: 'Leg length L / h',     unit: '-', min: 0.1, max: 100, default: 5.0, scale: 'log' },
            { key: 'nLegs',      label: 'Number of legs',       unit: '-', min: 1, max: 8, default: 2 },
            { key: 'legSpacing', label: 'Leg spacing (×L)',     unit: '-', min: 0.1, max: 50, default: 2.0, scale: 'log' },
            { key: 'zones',      label: 'Zones (≤5: M, W)',     unit: 'array', default: DEFAULT_ZONES_2 }
        ],
        refLength: 'Lh',
        defaultFrozen: ['S_global', 'nLegs'],
        reference: 'Ozkan & Raghavan (1991) laterals + chained zone attenuation (#31)',
        category: 'composite',
        description: 'Multi-lateral producer in a linear-composite reservoir: superposed Ozkan-Raghavan laterals with chained zone transmissibility attenuation.',
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
            { key: 'Cd',         label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S_perf',     label: 'Perforation skin',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'S_global',   label: 'Global skin',          unit: '-', min: -7, max: 50, default: 0 },
            { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-', min: 0.001, max: 10, default: 0.1, scale: 'log' },
            { key: 'L_to_h',     label: 'Leg length L / h',     unit: '-', min: 0.1, max: 100, default: 5.0, scale: 'log' },
            { key: 'nLegs',      label: 'Number of legs',       unit: '-', min: 1, max: 8, default: 2 },
            { key: 'legSpacing', label: 'Leg spacing (×L)',     unit: '-', min: 0.1, max: 50, default: 2.0, scale: 'log' },
            { key: 'rxObs',      label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs',   label: 'Observation azimuth',  unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'zones',      label: 'Zones (≤5: M, W)',     unit: 'array', default: DEFAULT_ZONES_2 }
        ],
        refLength: 'rw',
        defaultFrozen: ['S_global', 'nLegs', 'thetaObs'],
        reference: 'Ozkan & Raghavan (1991) laterals + chained zone attenuation + fully penetrating observation well',
        category: 'composite',
        description: 'Multi-lateral producer in a linear-composite reservoir, pressure at an off-well (fully penetrating) observation point.',
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
            { key: 'Cd',     label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S',      label: 'Effective skin S',    unit: '-', min: -7, max: 50, default: 0 },
            { key: 'layers', label: 'Heterogeneous layers (per-layer type)', unit: 'array', default: null }
        ],
        refLength: 'rw',
        reference: 'Lefkovits-Hazebroek SPEJ 1961 (commingled limit); Ozkan & Raghavan (1991); Gringarten et al (1974)',
        category: 'multilayer',
        description: 'General multi-layer no-XF: each layer of type homogeneous, fracture (xf/rw), horizontal (L/h), composite or linearComp. kh-weighted commingled sum.',
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
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S',        label: 'Producer skin S',     unit: '-', min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs', label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'layers',   label: 'Layers (kh, ω, λ)',   unit: 'array', default: DEFAULT_LAYERS_2 }
        ],
        refLength: 'rw',
        defaultFrozen: ['thetaObs'],
        reference: 'Kuchuk SPE 22731 (1991)',
        category: 'interference',
        description: 'Interference in a multi-layer reservoir with PSS λ-controlled cross-flow (layer-averaged observation pressure).',
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
            { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-',  min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S',        label: 'Producer skin S',     unit: '-',  min: -7, max: 50, default: 0 },
            { key: 'rxObs',    label: 'Observation distance', unit: 'r_w', min: 1, max: 1e6, default: 1000, scale: 'log' },
            { key: 'thetaObs', label: 'Observation azimuth', unit: 'deg', min: 0, max: 360, default: 0 },
            { key: 'RD',       label: 'Inner-zone radius RD', unit: 'r_w', min: 1, max: 1e6, default: 100, scale: 'log' },
            { key: 'M',        label: 'Mobility ratio M',    unit: '-',  min: 0.01, max: 100, default: 0.5, scale: 'log' },
            { key: 'W',        label: 'Storativity ratio W', unit: '-',  min: 0.01, max: 100, default: 1.0, scale: 'log' }
        ],
        refLength: 'rw',
        defaultFrozen: ['thetaObs'],
        reference: 'Bourdet 2002 §6.4.2 (single-front radial composite)',
        category: 'interference',
        description: 'Interference in a 2-zone radial-composite reservoir. Single-front approximation: (1+M)/(2M)-type attenuation, √W outer-zone delay.',
        kind: 'pressure'
    }

};

/**
 * Horizontal-well kernel H(u) (p̄ = H(u)/s) for {KvKh, L_to_h, zw_to_h, __h_rw},
 * lengths in Lh units.  opts.line → without the finite-wellbore correction;
 * opts.local → never delegate to window.PRiSM_lap_horizontal.
 */
function PRiSM_horizontalKernelH(u, params, opts) {
    var hp = _hzParams(params || {});
    var g = _hzGeom(hp.LD, hp.zw, hp.dz0, hp.KvKh);
    var o = opts || {};
    var H = o.local ? _hzSelfLocal(u, g, null) : _hzSelfLine(u, g, null);
    return o.line ? H : H + _hzWellCorr(u, g);
}

// install — additive, never replace.
(function _installRegistry() {
    var g = _win();
    if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
    for (var key in REGISTRY_ADDITIONS) {
        if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
            g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
        }
    }
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
    g.PRiSM_horizontalKernelH                        = PRiSM_horizontalKernelH;
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
// regression-pre-screening; for production decisions use a full numerical
// reservoir simulation.
//
// TIME INPUT: the water-injection evaluator takes REAL TIME IN DAYS (registry
// timeInput: 'days'); the physical-model wrapper passes days, not tD.  Its
// physical parameters (kh, mu_o, ct, ...) are model inputs, not scale factors.
// Negative total skin (mechanical + composite) is handled with the
// effective-wellbore-radius transform, and the Bessel functions are the
// smooth scaled forms of SECTION 0B (no Stehfest amplification of polynomial
// breakpoints).
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

function _win() {
    return (typeof window !== 'undefined') ? window
         : (typeof globalThis !== 'undefined' ? globalThis : {});
}

// =============================================================================
// SECTION 0B — Numerics (WP4b): smooth scaled Bessel functions, Stehfest,
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
    var S_comp = _compositeRadialSkin(rfD, M);
    var S_eff  = S_well + S_comp;
    // Bourdet-Gringarten Laplace pwd with WBS + (mech + composite) skin,
    // written with the finite-wellbore term K0/(√s·K1):
    //   pwd_lap = (w + S) / ( s·(1 + Cd·s·(w + S)) ),  w = K0(√s)/(√s·K1(√s))
    // For S_eff < 0 the effective-wellbore-radius transform is used
    // (td → td·e^{2S}, Cd → Cd·e^{2S}, S → 0) so the transform has no pole.
    var t = td_inj, C = (Cd > 0) ? Cd : 0, S = S_eff;
    if (S < 0) { var f = Math.exp(2 * S); t *= f; C *= f; S = 0; }
    var Phat = function (s) {
        var g = _wellTerm(Math.sqrt(s)) + S;
        return (C > 0) ? g / (s * (1 + C * s * g)) : g / s;
    };
    var ext = _foundation('PRiSM_stehfest');
    if (ext && N_steh && N_steh !== 12) return ext(Phat, t, N_steh);
    return _steh(Phat, t);
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
            { key: 'Cd',       label: 'WBS Cd',              unit: '-',     min: 0,     max: 1e10, default: 100, scale: 'log' },
            { key: 'S',        label: 'Skin',                unit: '-',     min: -7,    max: 50,   default: 0 },
            { key: 'kh',       label: 'Permeability-thickness kh', unit: 'md·ft', min: 0.1, max: 1e7, default: 1000, scale: 'log' },
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
        description: 'Water Injection (two-phase, semi-analytic). Piston-like radial displacement with mobility ratio M = (krw·μo)/(kro·μw); composite Hawkins-style skin from inner (water) and outer (oil) zones; WBS+skin folded via Stehfest. Time is REAL TIME IN DAYS (timeInput days); rateProfile is optional [[t,q],...] in days/bbl/d. APPROXIMATIONS: piston-like front, single-stratum, no gravity/capillary, incompressible-front volumetric balance. Quick-look only; not a substitute for full reservoir simulation.',
        timeInput: 'days',
        refLength: 'rw',
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
//   1. SVG schematics          — PRiSM_getModelSchematic(modelKey)
//   2. Plot line tools         — click-on-plot straight-line / slope analyses
//                                (PRiSM_analysisKeys, PRiSM_armAnalysisKey,
//                                 PRiSM_runAnalysisKey, PRiSM_renderAnalysisKeyToolbar)
//   3. PNG / PDF export        — PRiSM_exportPlotPNG / PRiSM_exportReportPDF /
//                                PRiSM_renderPlotToCanvas / PRiSM_listPlots
//   4. Usage analytics (GA4)   — PRiSM_tabHooks.any + prism:model-changed /
//                                prism:fit-updated listeners (no wrappers)
// -----------------------------------------------------------------------------
// This layer adds NO new reservoir model. It provides model diagrams, the
// classic straight-line and slope analyses a well-test engineer performs by
// clicking on a diagnostic plot, a PDF/PNG export that bakes the canvas plots
// in as PNG data URLs, and analytics events.
//
// Units: field units throughout. Δt in hours, p in psia, q in STB/d (oil) or
// Mscf/d (gas), k in md, h / rw / distances in ft, ct in 1/psi, μ in cp,
// C in bbl/psi.
//
// Inputs come from the shared Well & Test store (window.PRiSM_getWell, C1)
// and the shared analysis data (window.PRiSM_getAnalysisData, C2). When an
// input is a default (or the store is absent) the result carries an amber
// "default inputs" warning — values are never silently invented.
//
// Results go to PRiSM_state.analysisKeyResults[key] (never PRiSM_state.params).
//
// Conventions:
//   - Single outer IIFE (this whole file). Public symbols on window.PRiSM_*.
//   - No external dependencies — pure vanilla JS, SVG strings only.
//   - No polling installers and no function wrapping: mounting goes through
//     the C7 registries (PRiSM_registerTabPanel / PRiSM_tabPanels,
//     PRiSM_tabHooks) and window CustomEvents.
//   - Every cross-module call is guarded with typeof checks.
// =============================================================================

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window : globalThis;
var _hasDoc = (typeof document !== 'undefined') && !!document &&
              typeof document.createElement === 'function';

function _on(target, type, fn) {
    try {
        if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn);
    } catch (e) { /* stub environments */ }
}

function _emit(type, detail) {
    try {
        if (typeof G.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
        G.dispatchEvent(new CustomEvent(type, { detail: detail }));
    } catch (e) { /* non-fatal */ }
}

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Toast helper — re-uses a host toast() if present, otherwise a one-shot
// floating div (bottom of the viewport, phone-safe width).
function _polishToast(msg, kind) {
    kind = kind || 'info';
    if (typeof G.toast === 'function') {
        try { G.toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    try { console.log('[PRiSM] ' + msg); } catch (e) { /* silent */ }
    if (!_hasDoc || !document.body) return;
    try {
        var existing = document.getElementById('prism_polish_toast');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        var div = document.createElement('div');
        div.id = 'prism_polish_toast';
        div.setAttribute('role', 'status');
        div.style.cssText =
            'position:fixed; bottom:16px; right:16px; z-index:99999;' +
            'background:var(--bg2, #161b22); color:var(--text, #e6edf3);' +
            'border:1px solid ' + (kind === 'error' ? 'var(--red, #f85149)' :
                                   kind === 'success' ? 'var(--green, #3fb950)' :
                                   kind === 'warn' ? 'var(--yellow, #d29922)' : 'var(--border, #30363d)') + ';' +
            'padding:10px 14px; border-radius:6px; font:13px sans-serif;' +
            'box-shadow:0 4px 12px rgba(0,0,0,.4); max-width:min(340px, calc(100vw - 32px));' +
            'line-height:1.4; box-sizing:border-box; overflow-wrap:anywhere;';
        div.textContent = msg;
        document.body.appendChild(div);
        setTimeout(function () {
            if (div.parentNode) div.parentNode.removeChild(div);
        }, 4500);
    } catch (e) { /* silent */ }
}

// C7 panel registration: prefer the shell helper, else merge into the registry.
function _registerTabPanel(n, spec) {
    if (typeof G.PRiSM_registerTabPanel === 'function') {
        try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall back */ }
    }
    G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
    var arr = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].id === spec.id) { arr[i] = spec; return; }
    }
    arr.push(spec);
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
G.PRiSM_getModelSchematic = function (modelKey) {
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
// SECTION 2 — PLOT LINE TOOLS (click-on-plot straight-line & slope analyses)
// =========================================================================
// Each tool: { label, hint, plot, clicks, prompts[], group, action(pts, cx) }
//   plot     plot key (or array of keys) the tool works on
//   pts      [{x, y, xKind, yKind}] in data units of the clicked plot
//            (log-log derivative plot: x = Δt [hr], y = Δp or Δp′ [psi])
//   cx       context: cx.w(key) reads a Well & Test input (and records that
//            it was used), cx.ad() the analysis data, cx.k() the permeability
//            source, cx.teq(t) the equivalent drawdown time.
//   action → { values:{}, text?, note, warnings[] } or { error }
// Results are stored in PRiSM_state.analysisKeyResults[key].
// =========================================================================

var WELL_KEYS  = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
var WELL_LABEL = { q: 'q', B: 'B', mu: 'μ', ct: 'ct', h: 'h', phi: 'φ', rw: 'rw' };
// Last-resort values. Only ever used together with an amber
// "default inputs" warning on the result.
var FALLBACK_WELL = { q: 1000, B: 1.2, mu: 1.0, ct: 1e-5, h: 50, phi: 0.2, rw: 0.354 };

// Quantity catalogue: display label + unit for every value a tool returns.
var QTY = {
    dpPrime:    { label: 'Δp′',                 unit: 'psi' },
    kh:         { label: 'kh',                  unit: 'md·ft' },
    k:          { label: 'k',                   unit: 'md' },
    S:          { label: 'S',                   unit: '' },
    rinv:       { label: 'r_inv',               unit: 'ft' },
    C:          { label: 'C',                   unit: 'bbl/psi' },
    CD:         { label: 'CD',                  unit: '' },
    mLinear:    { label: 'm (linear)',          unit: 'psi/hr^½' },
    xfSqrtK:    { label: 'xf·√k',               unit: 'ft·md^½' },
    xf:         { label: 'xf',                  unit: 'ft' },
    mBilinear:  { label: 'm (bilinear)',        unit: 'psi/hr^¼' },
    kfwf:       { label: 'kf·wf',               unit: 'md·ft' },
    mSpherical: { label: 'm (spherical)',       unit: 'psi·hr^½' },
    ks:         { label: 'k (spherical)',       unit: 'md' },
    ratio:      { label: 'Dip ratio',           unit: '' },
    omega:      { label: 'ω',                   unit: '' },
    lambda:     { label: 'λ',                   unit: '' },
    tMin:       { label: 't at dip',            unit: 'hr' },
    L:          { label: 'Distance',            unit: 'ft' },
    W:          { label: 'Channel width',       unit: 'ft' },
    theta:      { label: 'Wedge angle',         unit: '°' },
    area:       { label: 'Drainage area',       unit: 'acres' },
    poreVolume: { label: 'Pore volume',         unit: 'bbl' },
    re:         { label: 'Equivalent radius',   unit: 'ft' },
    kyKzLw:     { label: '√(ky·kz)·Lw',         unit: 'md·ft' },
    LwSqrtKy:   { label: 'Lw·√ky',              unit: 'ft·md^½' },
    kxKyH:      { label: '√(kx·ky)·h',          unit: 'md·ft' },
    kH:         { label: '√(kx·ky)',            unit: 'md' },
    slope:      { label: 'Slope',               unit: '' },
    m:          { label: 'm',                   unit: 'psi/cycle' },
    pStar:      { label: 'p*',                  unit: 'psia' },
    p1hr:       { label: 'p1hr',                unit: 'psia' },
    tx:         { label: 'Intersection Δt',     unit: 'hr' }
};

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return _num(v) && v > 0; }

function _fmt(v, sig) {
    if (!_num(v)) return '—';
    sig = sig || 4;
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) {
        return v.toExponential(Math.max(0, sig - 2)).replace(/\.?0+e/, 'e').replace('e+', 'e');
    }
    var s = v.toPrecision(sig);
    if (s.indexOf('e') !== -1) s = String(Number(s));
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}

function _rankine(T) {
    if (!_num(T)) return null;
    return T > 400 ? T : T + 459.67;          // °F → °R unless already absolute
}

// ---- Inputs (C1) ----------------------------------------------------------
function _wellInputs() {
    var out = { v: {}, defaulted: [], missing: [], source: 'none', fluid: 'oil',
                T_R: null, testType: null, pi: null, tp: null, pwf0: null };
    var w = null;
    if (typeof G.PRiSM_getWell === 'function') {
        try { w = G.PRiSM_getWell(); } catch (e) { w = null; }
    }
    var i, k;
    if (w && typeof w === 'object') {
        out.source = 'Well & Test';
        var dflt = Array.isArray(w.defaulted) ? w.defaulted : [];
        for (i = 0; i < WELL_KEYS.length; i++) {
            k = WELL_KEYS[i];
            if (_pos(w[k])) {
                out.v[k] = w[k];
                if (dflt.indexOf(k) !== -1) out.defaulted.push(k);
            } else {
                out.v[k] = FALLBACK_WELL[k];
                out.defaulted.push(k);
                out.missing.push(k);
            }
        }
        out.fluid    = w.fluid || 'oil';
        out.T_R      = _num(w.T_R) ? w.T_R : null;
        out.testType = w.testType || null;
        out.pi       = _pos(w.pi) ? w.pi : null;
        out.tp       = _pos(w.tp) ? w.tp : null;
        out.pwf0     = _pos(w.pwf0) ? w.pwf0 : null;
        return out;
    }
    // No Well & Test store: read the PVT store. Its values have no
    // provenance, so every one of them is reported as a default.
    var pvt = G.PRiSM_pvt || null;
    var c = (pvt && pvt._computed) || null;
    if (pvt && (!c || !_pos(c.ct)) && typeof G.PRiSM_pvt_compute === 'function') {
        try { c = G.PRiSM_pvt_compute() || c; } catch (e) { /* keep */ }
    }
    out.source = pvt ? 'stored PVT values (not confirmed)' : 'built-in defaults';
    var raw = {
        q:   pvt && pvt.q,
        B:   (c && c.B)  || (pvt && pvt.Bo),
        mu:  (c && c.mu) || (pvt && pvt.mu_o),
        ct:  (c && c.ct) || (pvt && pvt.ct),
        h:   pvt && pvt.h,
        phi: pvt && pvt.phi,
        rw:  pvt && pvt.rw
    };
    for (i = 0; i < WELL_KEYS.length; i++) {
        k = WELL_KEYS[i];
        out.v[k] = _pos(raw[k]) ? raw[k] : FALLBACK_WELL[k];
        out.defaulted.push(k);
        if (!_pos(raw[k])) out.missing.push(k);
    }
    out.fluid = (pvt && pvt.fluidType) || 'oil';
    out.T_R   = (pvt && _num(pvt.T_res)) ? pvt.T_res : null;
    return out;
}

// ---- Analysis data (C2) ---------------------------------------------------
function _localBourdet(t, y, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        try {
            var r = G.PRiSM_compute_bourdet(t, y, L);
            if (r && r.length === t.length) return r;
        } catch (e) { /* inline fallback */ }
    }
    var n = t.length, d = new Array(n), i;
    for (i = 0; i < n; i++) d[i] = NaN;
    for (i = 1; i < n - 1; i++) {
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
        }
        var dl1 = Math.log(t[i]) - Math.log(t[i1]);
        var dl2 = Math.log(t[i2]) - Math.log(t[i]);
        var dlT = Math.log(t[i2]) - Math.log(t[i1]);
        if (!(dl1 > 0) || !(dl2 > 0) || !(dlT > 0)) continue;
        d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
    }
    return d;
}

function _localAnalysisData(ds, L) {
    if (!ds || !ds.t || !ds.p || ds.t.length < 3) {
        return { ok: false, reason: 'No pressure data', t: [], dp: [], deriv: [] };
    }
    var n = ds.t.length, p0 = ds.p[0];
    var sign = (ds.p[n - 1] - p0) >= 0 ? 1 : -1;     // +1 buildup, -1 drawdown
    var t = [], p = [], dp = [];
    for (var i = 0; i < n; i++) {
        if (!(ds.t[i] > 0) || !_num(ds.p[i])) continue;
        t.push(ds.t[i]); p.push(ds.p[i]); dp.push(sign * (ds.p[i] - p0));
    }
    return {
        ok: t.length >= 3, t: t, tAbs: t.slice(), p: p, dp: dp,
        deriv: _localBourdet(t, dp, L), L: L, sign: sign, pRef: p0,
        pRefSource: 'first-sample', testType: sign > 0 ? 'buildup' : 'drawdown', tp: null,
        warnings: ['Δp is measured from the first sample — skin is biased (set pi on Tab 1).']
    };
}

function _analysisData() {
    var st = G.PRiSM_state || {};
    if (typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var o = {};
            if (_num(st.activePeriod) && st.activePeriod >= 0) o.period = st.activePeriod;
            if (_num(st.bourdetL)) o.L = st.bourdetL;
            if (st.timeFn) o.timeFn = st.timeFn;
            var ad = G.PRiSM_getAnalysisData(G.PRiSM_dataset, o);
            if (ad && ad.ok && ad.t && ad.t.length) return ad;
        } catch (e) { /* fall back */ }
    }
    return _localAnalysisData(G.PRiSM_dataset, _num(st.bourdetL) ? st.bourdetL : 0.15);
}

// Positive (log t, log y) pairs of one AData series — cached on the object.
function _pairs(ad, which) {
    if (!ad || !ad.t) return { x: [], y: [] };
    var cacheKey = '_prismPairs_' + which;
    if (ad[cacheKey]) return ad[cacheKey];
    var src = ad[which] || [], xs = [], ys = [];
    for (var i = 0; i < ad.t.length; i++) {
        if (ad.t[i] > 0 && src[i] > 0 && _num(src[i])) {
            xs.push(Math.log10(ad.t[i]));
            ys.push(Math.log10(src[i]));
        }
    }
    var r = { x: xs, y: ys };
    try { ad[cacheKey] = r; } catch (e) { /* frozen */ }
    return r;
}

function _interpLogLog(pr, t) {
    if (!pr.x.length || !(t > 0)) return NaN;
    var lx = Math.log10(t), n = pr.x.length;
    if (lx < pr.x[0] - 0.05 || lx > pr.x[n - 1] + 0.05) return NaN;
    if (lx <= pr.x[0]) return Math.pow(10, pr.y[0]);
    if (lx >= pr.x[n - 1]) return Math.pow(10, pr.y[n - 1]);
    for (var i = 1; i < n; i++) {
        if (pr.x[i] >= lx) {
            var f = (lx - pr.x[i - 1]) / Math.max(1e-12, pr.x[i] - pr.x[i - 1]);
            return Math.pow(10, pr.y[i - 1] + f * (pr.y[i] - pr.y[i - 1]));
        }
    }
    return NaN;
}

// Which log-log curve (Δp or Δp′) is nearest the clicked point.
function _whichCurve(ad, t, y) {
    if (!ad || !ad.ok || !(y > 0)) return null;
    var a = _interpLogLog(_pairs(ad, 'dp'), t);
    var b = _interpLogLog(_pairs(ad, 'deriv'), t);
    var ly = Math.log10(y);
    var da = _pos(a) ? Math.abs(ly - Math.log10(a)) : Infinity;
    var db = _pos(b) ? Math.abs(ly - Math.log10(b)) : Infinity;
    if (da === Infinity && db === Infinity) return null;
    return da < db ? 'dp' : 'deriv';
}

// Local log-log slope of a series around t (least squares over ±¼ then ±½ cycle).
function _localSlope(ad, t, which) {
    if (!ad || !ad.ok || !(t > 0)) return NaN;
    var pr = _pairs(ad, which || 'deriv'), lt = Math.log10(t), widths = [0.25, 0.5];
    for (var w = 0; w < widths.length; w++) {
        var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
        for (var i = 0; i < pr.x.length; i++) {
            if (Math.abs(pr.x[i] - lt) > widths[w]) continue;
            sx += pr.x[i]; sy += pr.y[i]; sxx += pr.x[i] * pr.x[i]; sxy += pr.x[i] * pr.y[i]; m++;
        }
        var den = m * sxx - sx * sx;
        if (m >= 3 && Math.abs(den) > 1e-12) return (m * sxy - sx * sy) / den;
    }
    return NaN;
}

function _isBuildup(tt) { return tt === 'buildup' || tt === 'falloff'; }

// Permeability from earlier work (newest-first priority list).
function _kFromContext(st) {
    var r = (st && st.analysisKeyResults) || {};
    var order = ['radialPlateau', 'mdhLine', 'hornerLine', 'dualPorosityDip', 'boundaryDoubling'];
    var names = { radialPlateau: 'radial-plateau pick', mdhLine: 'semilog line', hornerLine: 'Horner line',
                  dualPorosityDip: 'plateau pick', boundaryDoubling: 'plateau pick' };
    for (var i = 0; i < order.length; i++) {
        var e = r[order[i]];
        if (e && e.values && _pos(e.values.k)) return { k: e.values.k, source: names[order[i]] };
    }
    var lf = null;
    if (typeof G.PRiSM_getLastFit === 'function') { try { lf = G.PRiSM_getLastFit(); } catch (e2) { lf = null; } }
    if (!lf && st) lf = st.lastFit;
    if (lf && lf.phys && _pos(lf.phys.k) && !lf.stale) return { k: lf.phys.k, source: 'model fit' };
    if (st && st.semilog && _pos(st.semilog.k)) return { k: st.semilog.k, source: 'semilog analysis' };
    if (st && st.phys && _pos(st.phys.k)) return { k: st.phys.k, source: 'model parameters' };
    return null;
}

function _omegaFromContext(st) {
    var r = (st && st.analysisKeyResults) || {};
    var order = ['dualPorosityDip', 'storativityRatio'];
    for (var i = 0; i < order.length; i++) {
        var e = r[order[i]];
        if (e && e.values && _pos(e.values.omega)) return { omega: e.values.omega, source: e.label };
    }
    var lf = st && st.lastFit;
    if (lf && lf.params && _pos(lf.params.omega)) return { omega: lf.params.omega, source: 'model fit' };
    if (st && st.params && _pos(st.params.omega)) return { omega: st.params.omega, source: 'model parameters' };
    return null;
}

// ω from the dip-to-plateau derivative ratio (pseudo-steady interporosity flow):
//   Δp′_min/Δp′_r = 1 + ω^(1/(1−ω)) − ω^(ω/(1−ω))
function _dipRatio(w) { return 1 + Math.pow(w, 1 / (1 - w)) - Math.pow(w, w / (1 - w)); }
function _omegaFromDipRatio(ratio) {
    if (!(ratio > 0) || !(ratio < 1)) return NaN;
    var lo = Math.log(1e-8), hi = Math.log(0.999);
    if (ratio <= _dipRatio(1e-8)) return 1e-8;
    for (var i = 0; i < 200; i++) {
        var mid = 0.5 * (lo + hi);
        if (_dipRatio(Math.exp(mid)) < ratio) lo = mid; else hi = mid;
        if (hi - lo < 1e-12) break;
    }
    return Math.exp(0.5 * (lo + hi));
}

function _regimeForSlope(s) {
    if (!_num(s)) return 'unknown';
    if (Math.abs(s) < 0.1)        return 'radial flow (flat derivative)';
    if (Math.abs(s - 0.25) < 0.08) return 'bilinear flow (¼ slope)';
    if (Math.abs(s - 0.5) < 0.1)  return 'linear flow (½ slope)';
    if (Math.abs(s - 1) < 0.15)   return 'unit slope (storage, or a closed system at late time)';
    if (Math.abs(s + 0.5) < 0.1)  return 'spherical flow (−½ slope)';
    if (s <= -0.6)                return 'pressure support (falling derivative)';
    return 'transition';
}

function _semilogX(pt) {                     // semilog abscissa (log10 of the axis value)
    return (pt.xKind === 'log') ? Math.log10(pt.x) : pt.x;
}

// Optional hand-off to the semilog engine. Its stored result is left as it was.
function _semilogEngine(method, t0, t1, cx) {
    if (typeof G.PRiSM_semilogAnalysis !== 'function') return null;
    var st = cx.st, before = st ? st.semilog : undefined, res = null;
    try {
        var well = null;
        if (typeof G.PRiSM_getWell === 'function') { try { well = G.PRiSM_getWell(); } catch (e0) { well = null; } }
        res = G.PRiSM_semilogAnalysis(cx.ad(), well,
            { method: method, window: { t0: Math.min(t0, t1), t1: Math.max(t0, t1) }, store: false });
    } catch (e) { res = null; }
    if (st) { if (before === undefined) { try { delete st.semilog; } catch (e1) { st.semilog = undefined; } } else st.semilog = before; }
    if (!res || typeof res !== 'object' || res.ok === false) return null;
    if (res.window && res.window.auto === true) return null;      // the clicked window was not used
    var pStar = _num(res.pStar) ? res.pStar : (_num(res.pstar) ? res.pstar : null);
    return { m: res.m, kh: res.kh, k: res.k, p1hr: res.p1hr, S: res.S, pStar: pStar,
             method: res.method, n: res.window && res.window.n };
}

function _sqrtRatio(mu, phi, ct) { return Math.sqrt(mu / (phi * ct)); }

G.PRiSM_analysisKeys = {

    // ── Radial flow & storage ─────────────────────────────────────────────
    radialPlateau: {
        label: 'Pick radial plateau → kh',
        hint: 'Click the flat part of the derivative (radial flow).',
        plot: 'bourdet', clicks: 1, group: 'Radial flow & storage',
        prompts: ['Click the flat part of the derivative (radial flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(y)) return { error: 'Click on the derivative plateau (Δp′ must be positive).' };
            var q = cx.w('q'), B = cx.w('B'), mu = cx.w('mu'), h = cx.w('h'), kh;
            if (cx.pseudo()) {
                var T = cx.rankine();
                if (!T) return { error: 'Gas pseudo-pressure data: set the reservoir temperature on Tab 1.' };
                kh = 711 * q * T / y;                      // Δm′ plateau, psi²/cp
            } else {
                kh = 70.6 * q * B * mu / y;                // Bourdet: Δp′ = 70.6 qBμ/kh
            }
            var k = kh / h, v = { dpPrime: y, kh: kh, k: k };
            var ad = cx.ad(), s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s) > 0.1) {
                warnings.push('The derivative is not flat here (local slope ' + s.toFixed(2) + ') — pick the radial-flow plateau.');
            }
            if (ad && ad.ok && !cx.pseudo()) {
                var dpr = _interpLogLog(_pairs(ad, 'dp'), t);
                var phi = cx.w('phi'), ct = cx.w('ct'), rw = cx.w('rw');
                if (_pos(dpr)) {
                    var te = cx.teq(t);
                    v.S = 0.5 * (dpr / y - Math.log(0.0002637 * k * te / (phi * mu * ct * rw * rw)) - 0.80907);
                    if (ad.pRefSource && ad.pRefSource !== 'pi' && ad.pRefSource !== 'pwf0') {
                        warnings.push('Δp is measured from the ' + String(ad.pRefSource).replace('-', ' ') +
                                      ', not pi — skin is biased. Set pi on Tab 1.');
                    }
                }
                var tEnd = 0;
                for (var i = 0; i < ad.t.length; i++) if (ad.t[i] > tEnd) tEnd = ad.t[i];
                if (tEnd > 0) v.rinv = Math.sqrt(k * tEnd / (948 * phi * mu * ct));
            }
            return {
                values: v, warnings: warnings,
                note: 'Radial plateau Δp′ = ' + _fmt(y) + ' psi → kh = ' + _fmt(kh) + ' md·ft, k = ' + _fmt(k) + ' md' +
                      (_num(v.S) ? ', S = ' + _fmt(v.S, 3) : '')
            };
        }
    },

    unitSlope: {
        label: 'Unit slope → C',
        hint: 'Click a point on the early unit-slope line (wellbore storage).',
        plot: 'bourdet', clicks: 1, group: 'Radial flow & storage',
        prompts: ['Click a point on the early unit-slope (storage) line'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the unit-slope line.' };
            var q = cx.w('q'), B = cx.w('B');
            var C = q * B * t / (24 * y);                   // Δp = qBΔt/(24C)
            var CD = 0.8936 * C / (cx.w('phi') * cx.w('ct') * cx.w('h') * cx.w('rw') * cx.w('rw'));
            var s = _localSlope(cx.ad(), t, 'dp');
            if (_num(s) && Math.abs(s - 1) > 0.15) {
                warnings.push('The data is not on a unit slope here (local slope ' + s.toFixed(2) + ') — storage may be over before the first point.');
            }
            return { values: { C: C, CD: CD }, warnings: warnings,
                     note: 'Unit slope at Δt = ' + _fmt(t, 3) + ' hr, Δp = ' + _fmt(y) + ' psi → C = ' + _fmt(C, 3) + ' bbl/psi (CD = ' + _fmt(CD, 3) + ')' };
        }
    },

    // ── Fractures & linear flow ──────────────────────────────────────────
    halfSlope: {
        label: '½-slope → xf·√k',
        hint: 'Click the ½-slope part of the curves (fracture linear flow).',
        plot: 'bourdet', clicks: 1, group: 'Fractures & linear flow',
        prompts: ['Click the ½-slope part of the derivative (linear flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the ½-slope segment.' };
            var ad = cx.ad(), curve = _whichCurve(ad, t, y) || 'deriv';
            var m = (curve === 'dp' ? y : 2 * y) / Math.sqrt(t);       // Δp = m√t, Δp′ = ½ m√t
            var xfk = 4.064 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * _sqrtRatio(cx.w('mu'), cx.w('phi'), cx.w('ct'));
            var v = { mLinear: m, xfSqrtK: xfk };
            var s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s - 0.5) > 0.1) warnings.push('Local derivative slope is ' + s.toFixed(2) + ', not ½ — check the flow regime.');
            var kk = cx.k();
            if (kk) v.xf = xfk / Math.sqrt(kk.k);
            return { values: v, warnings: warnings,
                     note: '½-slope on ' + (curve === 'dp' ? 'Δp' : 'Δp′') + ' → m = ' + _fmt(m) + ' psi/hr^½, xf·√k = ' + _fmt(xfk) + ' ft·md^½' +
                           (v.xf ? ', xf = ' + _fmt(v.xf) + ' ft' : '') };
        }
    },

    quarterSlope: {
        label: '¼-slope → kf·wf',
        hint: 'Click the ¼-slope part of the curves (bilinear flow). Needs k.',
        plot: 'bourdet', clicks: 1, group: 'Fractures & linear flow', needsK: true,
        prompts: ['Click the ¼-slope part of the derivative (bilinear flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the ¼-slope segment.' };
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var ad = cx.ad(), curve = _whichCurve(ad, t, y) || 'deriv';
            var m = (curve === 'dp' ? y : 4 * y) / Math.pow(t, 0.25);  // Δp = m t^¼, Δp′ = ¼ m t^¼
            var mu = cx.w('mu');
            var kfwf = Math.pow(44.1 * cx.w('q') * cx.w('B') * mu /
                                (cx.w('h') * m * Math.pow(cx.w('phi') * mu * cx.w('ct') * kk.k, 0.25)), 2);
            var s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s - 0.25) > 0.08) warnings.push('Local derivative slope is ' + s.toFixed(2) + ', not ¼ — check the flow regime.');
            return { values: { mBilinear: m, kfwf: kfwf }, warnings: warnings,
                     note: '¼-slope → m = ' + _fmt(m) + ' psi/hr^¼, kf·wf = ' + _fmt(kfwf) + ' md·ft (k = ' + _fmt(kk.k, 3) + ' md from ' + kk.source + ')' };
        }
    },

    sphericalSlope: {
        label: '−½ slope → spherical k',
        hint: 'Click the −½-slope part of the derivative (spherical flow).',
        plot: 'bourdet', clicks: 1, group: 'Fractures & linear flow',
        prompts: ['Click the −½-slope part of the derivative (spherical flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the −½-slope derivative.' };
            var ad = cx.ad();
            if (_whichCurve(ad, t, y) === 'dp') return { error: 'Click on the derivative (Δp′), not on Δp.' };
            var m = 2 * y * Math.sqrt(t);                  // Δp′ = ½·|m|/√t
            var mu = cx.w('mu');
            var ks = Math.pow(2452.9 * cx.w('q') * cx.w('B') * mu * Math.sqrt(cx.w('phi') * mu * cx.w('ct')) / m, 2 / 3);
            var s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s + 0.5) > 0.12) warnings.push('Local derivative slope is ' + s.toFixed(2) + ', not −½ — check the flow regime.');
            return { values: { mSpherical: m, ks: ks }, warnings: warnings,
                     note: '−½ slope → |m| = ' + _fmt(m) + ' psi·hr^½, spherical k = ' + _fmt(ks) + ' md' };
        }
    },

    // ── Dual porosity ────────────────────────────────────────────────────
    dualPorosityDip: {
        label: 'Click the dip → ω, λ',
        hint: 'Click the radial plateau, then the bottom of the derivative dip.',
        plot: 'bourdet', clicks: 2, group: 'Dual porosity',
        prompts: ['Click the radial plateau', 'Click the bottom of the derivative dip'],
        action: function (pts, cx) {
            var yr = pts[0].y, tm = pts[1].x, ym = pts[1].y;
            if (!_pos(yr) || !_pos(ym)) return { error: 'Both points must be on the derivative.' };
            var ratio = ym / yr;
            if (!(ratio < 1)) return { error: 'The dip must lie below the plateau (ratio ' + _fmt(ratio, 3) + ').' };
            var omega = _omegaFromDipRatio(ratio);
            var mu = cx.w('mu'), kh = 70.6 * cx.w('q') * cx.w('B') * mu / yr, k = kh / cx.w('h');
            var rw = cx.w('rw'), te = cx.teq(tm);
            var lambda = omega * Math.log(1 / omega) * cx.w('phi') * mu * cx.w('ct') * rw * rw / (0.0002637 * k * te);
            return { values: { kh: kh, k: k, ratio: ratio, omega: omega, tMin: tm, lambda: lambda }, warnings: [],
                     note: 'Dip ratio ' + _fmt(ratio, 3) + ' → ω = ' + _fmt(omega, 3) + '; dip at ' + _fmt(tm, 3) + ' hr → λ = ' + _fmt(lambda, 3) + ' (k = ' + _fmt(k, 3) + ' md)' };
        }
    },

    storativityRatio: {
        label: 'Dip depth → ω',
        hint: 'Click the radial plateau, then the bottom of the dip.',
        plot: 'bourdet', clicks: 2, group: 'Dual porosity',
        prompts: ['Click the radial plateau', 'Click the bottom of the derivative dip'],
        action: function (pts) {
            var ratio = pts[1].y / pts[0].y;
            if (!(ratio > 0 && ratio < 1)) return { error: 'The dip must lie below the plateau.' };
            var omega = _omegaFromDipRatio(ratio);
            return { values: { ratio: ratio, omega: omega }, warnings: [],
                     note: 'Dip ratio ' + _fmt(ratio, 3) + ' → ω = ' + _fmt(omega, 3) };
        }
    },

    interporosityFlow: {
        label: 'Dip time → λ',
        hint: 'Click the bottom of the dip. Needs ω and k.',
        plot: 'bourdet', clicks: 1, group: 'Dual porosity', needsK: true,
        prompts: ['Click the bottom of the derivative dip'],
        action: function (pts, cx) {
            var tm = pts[0].x;
            var om = _omegaFromContext(cx.st);
            if (!om) return { error: 'Needs ω: use "Dip depth → ω" first.' };
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var rw = cx.w('rw'), te = cx.teq(tm);
            var lambda = om.omega * Math.log(1 / om.omega) * cx.w('phi') * cx.w('mu') * cx.w('ct') * rw * rw / (0.0002637 * kk.k * te);
            return { values: { tMin: tm, omega: om.omega, lambda: lambda }, warnings: [],
                     note: 'Dip at ' + _fmt(tm, 3) + ' hr, ω = ' + _fmt(om.omega, 3) + ', k = ' + _fmt(kk.k, 3) + ' md → λ = ' + _fmt(lambda, 3) };
        }
    },

    // ── Boundaries ────────────────────────────────────────────────────────
    boundaryDoubling: {
        label: 'Boundary doubling → distance',
        hint: 'Click the radial plateau, then a point where the derivative is rising towards double.',
        plot: 'bourdet', clicks: 2, group: 'Boundaries',
        prompts: ['Click the radial plateau', 'Click the rising derivative (between 1× and 2× the plateau)'],
        action: function (pts, cx) {
            var yr = pts[0].y, t = pts[1].x, y = pts[1].y;
            var R = y / yr;
            if (!(R > 1.005 && R < 1.995)) {
                return { error: 'Pick a point where the derivative is between 1× and 2× the plateau (this one is ' + _fmt(R, 3) + '×).' };
            }
            var mu = cx.w('mu'), kh = 70.6 * cx.w('q') * cx.w('B') * mu / yr, k = kh / cx.w('h');
            var te = cx.teq(t);
            // Single sealing fault (image at 2L): R − 1 = exp(−L²φμct/(0.0002637 k t))
            var L = Math.sqrt(0.0002637 * k * te * Math.log(1 / (R - 1)) / (cx.w('phi') * mu * cx.w('ct')));
            return { values: { kh: kh, k: k, ratio: R, L: L }, warnings: [],
                     note: 'Derivative at ' + _fmt(R, 3) + '× the plateau at ' + _fmt(t, 3) + ' hr → distance to a sealing fault ≈ ' + _fmt(L, 3) + ' ft (k = ' + _fmt(k, 3) + ' md)' };
        }
    },

    boundaryOnset: {
        label: 'Boundary onset → distance',
        hint: 'Click where the derivative first leaves the plateau (≈10% above). Needs k.',
        plot: 'bourdet', clicks: 1, group: 'Boundaries', needsK: true,
        prompts: ['Click where the derivative first rises above the plateau'],
        action: function (pts, cx) {
            var t = pts[0].x;
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var te = cx.teq(t);
            var L = Math.sqrt(0.0002637 * kk.k * te * Math.log(10) / (cx.w('phi') * cx.w('mu') * cx.w('ct')));
            return { values: { L: L }, warnings: [],
                     note: 'Boundary felt at ' + _fmt(t, 3) + ' hr → distance ≈ ' + _fmt(L, 3) + ' ft (k = ' + _fmt(kk.k, 3) + ' md from ' + kk.source + ')' };
        }
    },

    boundaryType: {
        label: 'Late slope → boundary type',
        hint: 'Click two points on the late-time derivative.',
        plot: 'bourdet', clicks: 2, group: 'Boundaries',
        prompts: ['Click the first late-time derivative point', 'Click a later derivative point'],
        action: function (pts, cx) {
            var dx = Math.log10(pts[1].x) - Math.log10(pts[0].x);
            if (!(Math.abs(dx) > 1e-6)) return { error: 'The two points need different times.' };
            var s = (Math.log10(pts[1].y) - Math.log10(pts[0].y)) / dx;
            var typ;
            if (s >= 0.8) typ = 'closed system (pseudo-steady state)';
            else if (s >= 0.35) typ = 'parallel boundaries / channel (½ slope)';
            else if (s >= 0.1) typ = 'sealing fault or partial barrier';
            else if (s > -0.1) typ = 'no boundary effect (radial flow)';
            else typ = 'pressure support (constant-pressure boundary or aquifer)';
            var warnings = [];
            var ad = cx.ad();
            if (ad && _isBuildup(ad.testType) && s < -0.1) warnings.push('On a buildup a falling derivative can also mean a closed system.');
            return { values: { slope: s }, text: typ, warnings: warnings,
                     note: 'Late slope ' + s.toFixed(2) + ' → ' + typ };
        }
    },

    channelWidth: {
        label: 'Late ½-slope → channel width',
        hint: 'Click the late ½-slope part of the curves (flow between parallel boundaries). Needs k.',
        plot: 'bourdet', clicks: 1, group: 'Boundaries', needsK: true,
        prompts: ['Click the late ½-slope part of the derivative'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y;
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var ad = cx.ad(), curve = _whichCurve(ad, t, y) || 'deriv';
            var te = cx.teq(t);
            var m = (curve === 'dp' ? y : 2 * y) / Math.sqrt(te);
            var W = 8.128 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * Math.sqrt(cx.w('mu') / (kk.k * cx.w('phi') * cx.w('ct')));
            return { values: { mLinear: m, W: W }, warnings: [],
                     note: 'Late ½-slope → m = ' + _fmt(m) + ' psi/hr^½, channel width ≈ ' + _fmt(W, 3) + ' ft (k = ' + _fmt(kk.k, 3) + ' md)' };
        }
    },

    wedgeAngle: {
        label: 'Second plateau → fault angle',
        hint: 'Click the radial plateau, then the higher late plateau (two intersecting faults).',
        plot: 'bourdet', clicks: 2, group: 'Boundaries',
        prompts: ['Click the radial plateau', 'Click the late (higher) plateau'],
        action: function (pts) {
            var ratio = pts[1].y / pts[0].y;
            if (!(ratio > 1.05)) return { error: 'The late plateau must be above the radial plateau.' };
            var theta = 360 / ratio;
            return { values: { ratio: ratio, theta: theta }, warnings: [],
                     note: 'Late / radial plateau = ' + _fmt(ratio, 3) + ' → angle between the faults ≈ ' + _fmt(theta, 3) + '°' };
        }
    },

    closedDrainageArea: {
        label: 'Late unit slope → drainage area',
        hint: 'Click the late unit-slope derivative of a drawdown (closed system).',
        plot: 'bourdet', clicks: 1, group: 'Boundaries',
        prompts: ['Click the late unit-slope derivative'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            var ad = cx.ad();
            if (_whichCurve(ad, t, y) === 'dp') return { error: 'Click on the derivative (Δp′), not on Δp.' };
            if (ad && _isBuildup(ad.testType)) warnings.push('Pseudo-steady state is a drawdown regime; on a buildup this area is not valid.');
            var phi = cx.w('phi'), h = cx.w('h');
            var Aft2 = 0.23395 * cx.w('q') * cx.w('B') * t / (phi * cx.w('ct') * h * y);  // Δp′ = 0.23395 qB t/(φ ct h A)
            return { values: { area: Aft2 / 43560, poreVolume: phi * h * Aft2 / 5.615, re: Math.sqrt(Aft2 / Math.PI) }, warnings: warnings,
                     note: 'Late unit slope → drainage area ≈ ' + _fmt(Aft2 / 43560, 3) + ' acres (re ≈ ' + _fmt(Math.sqrt(Aft2 / Math.PI), 3) + ' ft)' };
        }
    },

    // ── Horizontal wells ─────────────────────────────────────────────────
    horizontalEarlyRadial: {
        label: 'Early plateau (horizontal) → √(ky·kz)·Lw',
        hint: 'Click the early plateau (vertical-plane radial flow around the lateral).',
        plot: 'bourdet', clicks: 1, group: 'Horizontal wells',
        prompts: ['Click the early derivative plateau'],
        action: function (pts, cx) {
            var y = pts[0].y;
            if (!_pos(y)) return { error: 'Click on the derivative plateau.' };
            var v = 70.6 * cx.w('q') * cx.w('B') * cx.w('mu') / y;
            return { values: { kyKzLw: v }, warnings: [],
                     note: 'Early plateau Δp′ = ' + _fmt(y) + ' psi → √(ky·kz)·Lw = ' + _fmt(v) + ' md·ft' };
        }
    },

    horizontalLinear: {
        label: 'Early ½-slope (horizontal) → Lw·√ky',
        hint: 'Click the intermediate ½-slope part of the curves (linear flow to the lateral).',
        plot: 'bourdet', clicks: 1, group: 'Horizontal wells',
        prompts: ['Click the intermediate ½-slope part of the derivative'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y;
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the ½-slope segment.' };
            var curve = _whichCurve(cx.ad(), t, y) || 'deriv';
            var m = (curve === 'dp' ? y : 2 * y) / Math.sqrt(t);
            var v = 8.128 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * _sqrtRatio(cx.w('mu'), cx.w('phi'), cx.w('ct'));
            return { values: { mLinear: m, LwSqrtKy: v }, warnings: [],
                     note: 'Intermediate ½-slope → m = ' + _fmt(m) + ' psi/hr^½, Lw·√ky = ' + _fmt(v) + ' ft·md^½' };
        }
    },

    horizontalLateRadial: {
        label: 'Late plateau (horizontal) → √(kx·ky)·h',
        hint: 'Click the late plateau (pseudo-radial flow in the horizontal plane).',
        plot: 'bourdet', clicks: 1, group: 'Horizontal wells',
        prompts: ['Click the late derivative plateau'],
        action: function (pts, cx) {
            var y = pts[0].y;
            if (!_pos(y)) return { error: 'Click on the derivative plateau.' };
            var h = cx.w('h'), v = 70.6 * cx.w('q') * cx.w('B') * cx.w('mu') / y;
            return { values: { kxKyH: v, kH: v / h }, warnings: [],
                     note: 'Late plateau Δp′ = ' + _fmt(y) + ' psi → √(kx·ky)·h = ' + _fmt(v) + ' md·ft (' + _fmt(v / h, 3) + ' md)' };
        }
    },

    // ── General ───────────────────────────────────────────────────────────
    slopeCheck: {
        label: 'Measure slope → flow regime',
        hint: 'Click two points on a curve to measure its log-log slope.',
        plot: 'bourdet', clicks: 2, group: 'General',
        prompts: ['Click the first point', 'Click the second point'],
        action: function (pts) {
            var dx = Math.log10(pts[1].x) - Math.log10(pts[0].x);
            if (!(Math.abs(dx) > 1e-6)) return { error: 'The two points need different times.' };
            var s = (Math.log10(pts[1].y) - Math.log10(pts[0].y)) / dx;
            var reg = _regimeForSlope(s);
            return { values: { slope: s }, text: reg, warnings: [], note: 'Slope ' + s.toFixed(3) + ' → ' + reg };
        }
    },

    // ── Straight lines on specialised plots ──────────────────────────────
    mdhLine: {
        label: 'Semilog line → kh, S',
        hint: 'Click two points on the semilog straight line (radial flow).',
        plot: 'mdh', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) { return _semilogLine('mdh', pts, cx); }
    },

    hornerLine: {
        label: 'Horner line → kh, p*, S',
        hint: 'Click two points on the Horner straight line (radial flow).',
        plot: 'horner', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) { return _semilogLine('horner', pts, cx); }
    },

    lineIntersection: {
        label: 'Line intersection → fault distance',
        hint: 'Click where the radial line and the steeper late line cross. Needs k.',
        plot: ['mdh', 'horner'], clicks: 1, group: 'Straight lines', needsK: true,
        prompts: ['Click where the two straight lines intersect'],
        action: function (pts, cx) {
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: fit the semilog line first (or pick the radial plateau).' };
            var tx;
            if (cx.plotKey === 'horner') {
                var tp = cx.tp();
                if (!tp) return { error: 'Needs the producing time tp (set it on Tab 1).' };
                var ratio = pts[0].xKind === 'log' ? pts[0].x : Math.pow(10, pts[0].x);
                if (!(ratio > 1)) return { error: 'Click to the right of Horner ratio 1.' };
                tx = tp / (ratio - 1);
            } else {
                tx = pts[0].xKind === 'log' ? pts[0].x : Math.pow(10, pts[0].x);
            }
            var L = 0.01217 * Math.sqrt(kk.k * tx / (cx.w('phi') * cx.w('mu') * cx.w('ct')));
            return { values: { tx: tx, L: L }, warnings: [],
                     note: 'Lines intersect at Δt = ' + _fmt(tx, 3) + ' hr → distance to a sealing fault ≈ ' + _fmt(L, 3) + ' ft' };
        }
    },

    sqrtLine: {
        label: '√t line → xf·√k',
        hint: 'Click two points on the straight line of the √t plot (linear flow).',
        plot: 'sqrt', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) {
            var m = Math.abs((pts[1].y - pts[0].y) / (pts[1].x - pts[0].x));
            if (!_pos(m)) return { error: 'The two points need different x and y.' };
            var xfk = 4.064 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * _sqrtRatio(cx.w('mu'), cx.w('phi'), cx.w('ct'));
            var v = { mLinear: m, xfSqrtK: xfk }, kk = cx.k();
            if (kk) v.xf = xfk / Math.sqrt(kk.k);
            return { values: v, warnings: [],
                     note: '√t slope m = ' + _fmt(m) + ' psi/hr^½ → xf·√k = ' + _fmt(xfk) + ' ft·md^½' + (v.xf ? ', xf = ' + _fmt(v.xf) + ' ft' : '') };
        }
    },

    quarterLine: {
        label: '⁴√t line → kf·wf',
        hint: 'Click two points on the straight line of the ⁴√t plot (bilinear flow). Needs k.',
        plot: 'quarter', clicks: 2, group: 'Straight lines', needsK: true,
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) {
            var m = Math.abs((pts[1].y - pts[0].y) / (pts[1].x - pts[0].x));
            if (!_pos(m)) return { error: 'The two points need different x and y.' };
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var mu = cx.w('mu');
            var kfwf = Math.pow(44.1 * cx.w('q') * cx.w('B') * mu / (cx.w('h') * m * Math.pow(cx.w('phi') * mu * cx.w('ct') * kk.k, 0.25)), 2);
            return { values: { mBilinear: m, kfwf: kfwf }, warnings: [],
                     note: '⁴√t slope m = ' + _fmt(m) + ' psi/hr^¼ → kf·wf = ' + _fmt(kfwf) + ' md·ft' };
        }
    },

    sphericalLine: {
        label: 'Spherical line → spherical k',
        hint: 'Click two points on the straight line of the spherical (1/√t) plot.',
        plot: 'spherical', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) {
            var m = Math.abs((pts[1].y - pts[0].y) / (pts[1].x - pts[0].x));
            if (!_pos(m)) return { error: 'The two points need different x and y.' };
            var mu = cx.w('mu');
            var ks = Math.pow(2452.9 * cx.w('q') * cx.w('B') * mu * Math.sqrt(cx.w('phi') * mu * cx.w('ct')) / m, 2 / 3);
            return { values: { mSpherical: m, ks: ks }, warnings: [],
                     note: 'Spherical slope |m| = ' + _fmt(m) + ' psi·hr^½ → spherical k = ' + _fmt(ks) + ' md' };
        }
    }
};

// Semilog straight line (MDH: p vs log Δt; Horner: p vs log((tp+Δt)/Δt)).
function _semilogLine(kind, pts, cx) {
    var x0 = _semilogX(pts[0]), x1 = _semilogX(pts[1]);
    if (!(Math.abs(x1 - x0) > 1e-9)) return { error: 'The two points need different times.' };
    var m = (pts[1].y - pts[0].y) / (x1 - x0);         // psi per log cycle (signed)
    if (!(Math.abs(m) > 0)) return { error: 'The line is flat — pick two points on the sloping straight line.' };
    var warnings = [], v = {};
    var q = cx.w('q'), B = cx.w('B'), mu = cx.w('mu'), h = cx.w('h'), kh;
    if (cx.pseudo()) {
        var T = cx.rankine();
        if (!T) return { error: 'Gas pseudo-pressure data: set the reservoir temperature on Tab 1.' };
        kh = 1637 * q * T / Math.abs(m);
    } else {
        kh = 162.6 * q * B * mu / Math.abs(m);
    }
    var k = kh / h;
    v.m = m; v.kh = kh; v.k = k;
    var logTerm = function () {
        var phi = cx.w('phi'), ct = cx.w('ct'), rw = cx.w('rw');
        return Math.log10(k / (phi * mu * ct * rw * rw)) - 3.2275;
    };
    var ad = cx.ad(), tp = cx.tp(), yIsDp = cx.yIsDp();
    var tt = ad && ad.testType ? ad.testType : cx.well.testType;
    var t0, t1;
    if (kind === 'horner') {
        v.pStar = pts[0].y - m * x0;                    // line at log ratio = 0
        if (tp) {
            v.p1hr = v.pStar + m * Math.log10(tp + 1);
            var pwf0 = cx.pwf0();
            if (_num(pwf0)) {
                v.S = 1.1513 * (Math.abs(v.p1hr - pwf0) / Math.abs(m) - logTerm() + Math.log10((tp + 1) / tp));
            } else {
                warnings.push('Set pwf at shut-in (Tab 1) to compute skin.');
            }
            var r0 = pts[0].xKind === 'log' ? pts[0].x : Math.pow(10, pts[0].x);
            var r1 = pts[1].xKind === 'log' ? pts[1].x : Math.pow(10, pts[1].x);
            if (r0 > 1 && r1 > 1) { t0 = tp / (r0 - 1); t1 = tp / (r1 - 1); }
        } else {
            warnings.push('Set the producing time tp (Tab 1) to compute p1hr and skin.');
        }
    } else {
        v.p1hr = pts[0].y - m * x0;                     // line at Δt = 1 hr
        t0 = Math.pow(10, x0); t1 = Math.pow(10, x1);
        if (yIsDp) {
            v.S = 1.1513 * (Math.abs(v.p1hr) / Math.abs(m) - logTerm());
        } else if (_isBuildup(tt)) {
            var pw = cx.pwf0();
            if (_num(pw)) v.S = 1.1513 * (Math.abs(v.p1hr - pw) / Math.abs(m) - logTerm());
            else warnings.push('Set pwf at shut-in (Tab 1) to compute skin.');
        } else {
            var pi = cx.pi();
            if (_num(pi)) v.S = 1.1513 * (Math.abs(pi - v.p1hr) / Math.abs(m) - logTerm());
            else warnings.push('Set the initial pressure pi (Tab 1) to compute skin.');
        }
    }
    // Hand the clicked window to the semilog engine when it is available.
    if (_pos(t0) && _pos(t1)) {
        var eng = _semilogEngine(kind, t0, t1, cx);
        if (eng && _num(eng.S) && (!eng.method || eng.method === kind)) {
            if (_num(eng.m)) v.m = eng.m;
            if (_pos(eng.kh)) v.kh = eng.kh;
            if (_pos(eng.k)) v.k = eng.k;
            if (_num(eng.p1hr)) v.p1hr = eng.p1hr;
            if (kind === 'horner' && _num(eng.pStar)) v.pStar = eng.pStar;
            v.S = eng.S;
            warnings.push('Line fitted through the ' + (eng.n || 'measured') + ' data points between your two clicks.');
        }
    }
    v.m = Math.abs(v.m);
    var note = (kind === 'horner' ? 'Horner' : 'Semilog') + ' line m = ' + _fmt(v.m) + ' psi/cycle → kh = ' + _fmt(v.kh) +
               ' md·ft, k = ' + _fmt(v.k) + ' md' + (_num(v.pStar) ? ', p* = ' + _fmt(v.pStar, 5) + ' psia' : '') +
               (_num(v.S) ? ', S = ' + _fmt(v.S, 3) : '');
    return { values: v, warnings: warnings, note: note };
}

function _keyPlots(key) { return Array.isArray(key.plot) ? key.plot : [key.plot]; }
function _keyOnPlot(key, plotKey) { return _keyPlots(key).indexOf(plotKey) !== -1; }

function _plotLabel(plotKey) {
    var reg = G.PRiSM_PLOT_REGISTRY;
    if (reg && reg[plotKey] && reg[plotKey].label) return reg[plotKey].label;
    for (var i = 0; i < _PLOTS_SNAPSHOT.length; i++) if (_PLOTS_SNAPSHOT[i].key === plotKey) return _PLOTS_SNAPSHOT[i].label;
    return plotKey;
}

function _makeCtx(plotKey, axes) {
    var st = G.PRiSM_state || {};
    var well = _wellInputs();
    var used = {};
    var adCache, kCache;
    var cx = {
        st: st, well: well, plotKey: plotKey, axes: axes || null, used: used, kInfo: null,
        w: function (key) { used[key] = true; return well.v[key]; },
        ad: function () { if (adCache === undefined) adCache = _analysisData(); return adCache; },
        k: function () {
            if (kCache === undefined) { kCache = _kFromContext(st); cx.kInfo = kCache; }
            return kCache;
        },
        pseudo: function () {
            var ad = cx.ad();
            return !!(ad && (ad.pseudo === true || ad.dpUnit === 'psi2/cp'));
        },
        rankine: function () { return _rankine(well.T_R); },
        tp: function () {
            var ad = cx.ad();
            if (ad && _pos(ad.tp)) return ad.tp;
            return well.tp;
        },
        pwf0: function () {
            var ad = cx.ad();
            if (ad && ad.pRefSource === 'pwf0' && _num(ad.pRef)) return ad.pRef;
            if (_num(well.pwf0)) return well.pwf0;
            if (ad && _isBuildup(ad.testType) && _num(ad.pRef)) return ad.pRef;
            return null;
        },
        pi: function () {
            var ad = cx.ad();
            if (ad && ad.pRefSource === 'pi' && _num(ad.pRef)) return ad.pRef;
            return well.pi;
        },
        yIsDp: function () {
            var lab = axes && axes.scaleY && axes.scaleY.label;
            return !!(lab && /Δp|dp|delta/i.test(String(lab)) && !/pws|pwf|pressure,?\s*p\b/i.test(String(lab)));
        },
        // Equivalent drawdown time (Agarwal) on a single-rate buildup.
        teq: function (t) {
            var ad = cx.ad(), tp = cx.tp();
            if (ad && _isBuildup(ad.testType) && _pos(tp)) return tp * t / (tp + t);
            return t;
        }
    };
    return cx;
}

function _defaultKinds(plotKey) {
    if (plotKey === 'bourdet' || plotKey === 'sandface') return { x: 'log', y: 'log' };
    if (plotKey === 'mdh' || plotKey === 'horner') return { x: 'log', y: 'lin' };
    return { x: 'lin', y: 'lin' };
}

function _normPoint(p, kinds) {
    p = p || {};
    return {
        x: _num(p.x) ? p.x : (_num(p.t) ? p.t : p.dataX),
        y: _num(p.y) ? p.y : p.dataY,
        xKind: p.xKind || kinds.x, yKind: p.yKind || kinds.y
    };
}

// Run a tool on data-space points: points = [{x, y}] (or {t, y}).
G.PRiSM_runAnalysisKey = function (keyName, points, opts) {
    opts = opts || {};
    var key = G.PRiSM_analysisKeys[keyName];
    if (!key) return { ok: false, error: 'Unknown tool: ' + keyName };
    if (!Array.isArray(points) || points.length < key.clicks) {
        return { ok: false, error: key.label + ' needs ' + key.clicks + ' point(s).' };
    }
    var plotKey = opts.plotKey || _keyPlots(key)[0];
    var kinds = _defaultKinds(plotKey), pts = [];
    for (var i = 0; i < key.clicks; i++) {
        var np = _normPoint(points[i], kinds);
        if (!_num(np.x) || !_num(np.y)) return { ok: false, error: 'Point ' + (i + 1) + ' is not a number.' };
        pts.push(np);
    }
    var cx = _makeCtx(plotKey, opts.axes);
    var res;
    try { res = key.action(pts, cx); } catch (e) { res = { error: 'Calculation failed: ' + (e && e.message) }; }
    if (!res || res.error) return { ok: false, error: (res && res.error) || 'No result.' };
    var usedKeys = Object.keys(cx.used);
    var defaulted = usedKeys.filter(function (k) { return cx.well.defaulted.indexOf(k) !== -1; });
    var warnings = (res.warnings || []).slice();
    if (defaulted.length) {
        warnings.unshift('Default inputs used (' + defaulted.map(function (k) { return WELL_LABEL[k]; }).join(', ') +
                         ') — confirm them in Well & Test on Tab 1.');
    }
    var inputs = {};
    usedKeys.forEach(function (k) { inputs[k] = cx.well.v[k]; });
    var entry = {
        key: keyName, label: key.label, plotKey: plotKey,
        values: res.values || {}, text: res.text || null, note: res.note || '',
        warnings: warnings, defaultInputs: defaulted, inputs: inputs, inputSource: cx.well.source,
        kSource: cx.kInfo ? cx.kInfo.source : null,
        points: pts.map(function (p) { return { x: p.x, y: p.y }; }),
        timestamp: Date.now()
    };
    // Display map (quantity label with unit → value) for generic report readers.
    var results = {};
    Object.keys(entry.values).forEach(function (vk) {
        var qd = QTY[vk] || { label: vk, unit: '' };
        if (_num(entry.values[vk])) results[qd.label + (qd.unit ? ' (' + qd.unit + ')' : '')] = entry.values[vk];
    });
    entry.results = results;
    var st = G.PRiSM_state;
    if (!st) st = G.PRiSM_state = {};
    if (!st.analysisKeyResults || typeof st.analysisKeyResults !== 'object') st.analysisKeyResults = {};
    st.analysisKeyResults[keyName] = entry;
    _emit('prism:analysis-key', { key: keyName, result: entry });
    if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e2) { /* non-fatal */ } }
    _refreshToolbars();
    return { ok: true, key: keyName, result: entry };
};

// Rows for reports: one row per value of every stored result.
G.PRiSM_analysisKeyReportRows = function () {
    var st = G.PRiSM_state || {}, r = st.analysisKeyResults || {}, rows = [];
    Object.keys(r).sort(function (a, b) { return (r[a].timestamp || 0) - (r[b].timestamp || 0); }).forEach(function (k) {
        var e = r[k];
        if (!e || !e.values) return;
        Object.keys(e.values).forEach(function (vk) {
            var qd = QTY[vk] || { label: vk, unit: '' };
            rows.push({ key: k, tool: e.label, quantity: qd.label, value: e.values[vk], unit: qd.unit,
                        defaulted: !!(e.defaultInputs && e.defaultInputs.length) });
        });
        if (e.text) rows.push({ key: k, tool: e.label, quantity: 'Interpretation', value: e.text, unit: '', defaulted: false });
    });
    return rows;
};

// ---- Axis inversion (C6 _prismAxes) --------------------------------------
function _invAxis(sc, off, len, flip) {
    if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
    var lo = sc.min, hi = sc.max;
    if (sc.kind === 'log') {
        if (!(lo > 0 && hi > 0)) return null;
        var a = Math.log10(lo), b = Math.log10(hi);
        return function (px) { var f = (px - off) / len; if (flip) f = 1 - f; return Math.pow(10, a + f * (b - a)); };
    }
    return function (px) { var f = (px - off) / len; if (flip) f = 1 - f; return lo + f * (hi - lo); };
}

function _axesInverse(ax) {
    if (!ax) return null;
    var plot = ax.plot || null;
    var kx = (ax.scaleX && ax.scaleX.kind) || (ax.xLog ? 'log' : 'lin');
    var ky = (ax.scaleY && ax.scaleY.kind) || (ax.yLog ? 'log' : 'lin');
    if (typeof ax.fromX === 'function' && typeof ax.fromY === 'function') {
        return { fromX: ax.fromX, fromY: ax.fromY, plot: plot, xKind: kx, yKind: ky };
    }
    if (ax.scaleX && ax.scaleY && plot) {
        var fx = _invAxis(ax.scaleX, plot.x, plot.w, false);
        var fy = _invAxis(ax.scaleY, plot.y, plot.h, true);
        if (fx && fy) return { fromX: fx, fromY: fy, plot: plot, xKind: kx, yKind: ky };
    }
    if (_num(ax.x0) && _num(ax.x1) && _num(ax.dx0) && _num(ax.dx1)) {       // older shape
        var p2 = { x: ax.x0, y: ax.y0, w: ax.x1 - ax.x0, h: ax.y1 - ax.y0 };
        var gx = _invAxis({ kind: kx, min: ax.dx0, max: ax.dx1 }, p2.x, p2.w, false);
        var gy = _invAxis({ kind: ky, min: ax.dy0, max: ax.dy1 }, p2.y, p2.h, true);
        if (gx && gy) return { fromX: gx, fromY: gy, plot: p2, xKind: kx, yKind: ky };
    }
    return null;
}

function _fwdAxis(sc, off, len, flip) {
    if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
    if (sc.kind === 'log') {
        if (!(sc.min > 0 && sc.max > 0)) return null;
        var a = Math.log10(sc.min), b = Math.log10(sc.max);
        return function (v) { if (!(v > 0)) return NaN; var f = (Math.log10(v) - a) / (b - a); return flip ? off + len - f * len : off + f * len; };
    }
    return function (v) { var f = (v - sc.min) / (sc.max - sc.min); return flip ? off + len - f * len : off + f * len; };
}

function _axesForward(ax) {
    if (!ax) return null;
    if (typeof ax.toX === 'function' && typeof ax.toY === 'function') return { toX: ax.toX, toY: ax.toY, plot: ax.plot };
    if (ax.scaleX && ax.scaleY && ax.plot) {
        var fx = _fwdAxis(ax.scaleX, ax.plot.x, ax.plot.w, false), fy = _fwdAxis(ax.scaleY, ax.plot.y, ax.plot.h, true);
        if (fx && fy) return { toX: fx, toY: fy, plot: ax.plot };
    }
    return null;
}

function _toDataCoords(canvas, ev) {
    var inv = _axesInverse(canvas && canvas._prismAxes);
    if (!inv) return null;
    var rect = { left: 0, top: 0, width: 0, height: 0 };
    try { if (canvas.getBoundingClientRect) rect = canvas.getBoundingClientRect(); } catch (e) { /* keep */ }
    var px = (ev.clientX || 0) - (rect.left || 0);
    var py = (ev.clientY || 0) - (rect.top || 0);
    var plot = inv.plot || {};
    // Canvas shown at a different CSS size than it was drawn at → rescale.
    if (plot.cssW && rect.width > 0 && Math.abs(rect.width - plot.cssW) > 0.5) px *= plot.cssW / rect.width;
    if (plot.cssH && rect.height > 0 && Math.abs(rect.height - plot.cssH) > 0.5) py *= plot.cssH / rect.height;
    var inside = !(plot.w > 0) ||
        (px >= plot.x - 1 && px <= plot.x + plot.w + 1 && py >= plot.y - 1 && py <= plot.y + plot.h + 1);
    return { px: px, py: py, x: inv.fromX(px), y: inv.fromY(py), xKind: inv.xKind, yKind: inv.yKind, inside: inside };
}

// ---- Arming (Pointer Events) ----------------------------------------------
var _arm = null;   // { key, canvas, listener, pts[], prevCursor, prevTouch }

function _statusEls() {
    if (!_hasDoc || typeof document.querySelectorAll !== 'function') return [];
    try { return Array.prototype.slice.call(document.querySelectorAll('[data-prism-akey-status]')); } catch (e) { return []; }
}

function _status(msg, kind) {
    var color = kind === 'error' ? 'var(--red, #f85149)' : kind === 'warn' ? 'var(--yellow, #d29922)' :
                kind === 'success' ? 'var(--green, #3fb950)' : 'var(--text2, #8b949e)';
    var els = _statusEls();
    for (var i = 0; i < els.length; i++) { els[i].textContent = msg || ''; els[i].style.color = color; }
    if (!els.length && msg && kind && kind !== 'info') _polishToast(msg, kind);
}

function _showHint(text) {
    if (!_hasDoc || !document.body) return;
    var h = document.getElementById('prism_akey_hint');
    if (!h) {
        h = document.createElement('div');
        h.id = 'prism_akey_hint';
        h.setAttribute('role', 'status');
        h.style.cssText =
            'position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:99999;' +
            'background:var(--bg2, #161b22); border:1px solid var(--accent, #f0883e); color:var(--text, #e6edf3);' +
            'padding:8px 12px; border-radius:6px; font:12px sans-serif; text-align:center;' +
            'max-width:calc(100vw - 32px); box-sizing:border-box; box-shadow:0 4px 10px rgba(0,0,0,.4);';
        document.body.appendChild(h);
    }
    h.textContent = text;
}

function _hideHint() {
    if (!_hasDoc) return;
    var h = document.getElementById('prism_akey_hint');
    if (h && h.parentNode) h.parentNode.removeChild(h);
}

function _markArmedButtons() {
    if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
    var nodes = document.querySelectorAll('[data-prism-akey]');
    for (var i = 0; i < nodes.length; i++) {
        var on = !!(_arm && nodes[i].getAttribute('data-prism-akey') === _arm.key);
        nodes[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        nodes[i].style.outline = on ? '2px solid var(--accent, #f0883e)' : '';
    }
}

function _disarm() {
    if (_arm && _arm.canvas) {
        try { _arm.canvas.removeEventListener('pointerdown', _arm.listener); } catch (e) { /* ignore */ }
        try {
            _arm.canvas.style.cursor = _arm.prevCursor || '';
            _arm.canvas.style.touchAction = _arm.prevTouch || '';
        } catch (e2) { /* ignore */ }
    }
    _arm = null;
    _hideHint();
    _markArmedButtons();
}

function _prompt() {
    if (!_arm) return;
    var key = G.PRiSM_analysisKeys[_arm.key];
    var n = _arm.pts.length;
    var text = (key.prompts && key.prompts[n]) || ('Click point ' + (n + 1) + ' of ' + key.clicks);
    var msg = key.label + ': ' + text + (key.clicks > 1 ? ' (' + (n + 1) + '/' + key.clicks + ')' : '') + ' — Esc to cancel';
    _showHint(msg);
    _status(msg, 'info');
}

function _markClick(canvas, px, py) {
    try {
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.save();
        ctx.strokeStyle = '#f0883e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px - 6, py); ctx.lineTo(px + 6, py);
        ctx.moveTo(px, py - 6); ctx.lineTo(px, py + 6);
        ctx.stroke();
        ctx.restore();
    } catch (e) { /* cosmetic */ }
}

function _onPointer(ev) {
    if (!_arm) return;
    if (ev && ev.button != null && ev.button > 0) return;          // secondary buttons
    try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* ignore */ }
    var canvas = _arm.canvas, key = G.PRiSM_analysisKeys[_arm.key];
    var pt = _toDataCoords(canvas, ev);
    if (!pt) { _status('The plot axes are not available — redraw the plot and pick the tool again.', 'error'); _disarm(); return; }
    if (!pt.inside) { _status('Click inside the plot area.', 'warn'); return; }
    _arm.pts.push(pt);
    _markClick(canvas, pt.px, pt.py);
    if (_arm.pts.length < key.clicks) { _prompt(); return; }
    var name = _arm.key, pts = _arm.pts.slice(), axes = canvas._prismAxes;
    var plotKey = (G.PRiSM_state && G.PRiSM_state.activePlot) || (axes && axes.plotKey) || _keyPlots(key)[0];
    _disarm();
    var r = G.PRiSM_runAnalysisKey(name, pts, { plotKey: plotKey, axes: axes });
    if (r.ok) {
        var warn = r.result.warnings && r.result.warnings.length;
        _status(r.result.note + (warn ? ' — ' + r.result.warnings[0] : ''), warn ? 'warn' : 'success');
    } else {
        _status(r.error, 'error');
    }
}

G.PRiSM_armAnalysisKey = function (keyName, opts) {
    opts = opts || {};
    var key = G.PRiSM_analysisKeys[keyName];
    if (!key) { _status('Unknown tool: ' + keyName, 'error'); return false; }
    var st = G.PRiSM_state || {};
    var plotKey = st.activePlot || 'bourdet';
    if (!_keyOnPlot(key, plotKey)) {
        _status('"' + key.label + '" works on the ' + _keyPlots(key).map(_plotLabel).join(' / ') +
                ' plot — switch the plot type first.', 'warn');
        return false;
    }
    var canvas = opts.canvas || (_hasDoc ? document.getElementById('prism_plot_canvas') : null);
    if (!canvas) { _status('Open the diagnostic plot first.', 'error'); return false; }
    if (!_axesInverse(canvas._prismAxes)) {
        _status('The plot has not been drawn yet — draw it, then pick the tool again.', 'error');
        return false;
    }
    _disarm();
    _arm = { key: keyName, canvas: canvas, pts: [], listener: _onPointer,
             prevCursor: canvas.style ? canvas.style.cursor : '', prevTouch: canvas.style ? canvas.style.touchAction : '' };
    try { canvas.style.cursor = 'crosshair'; canvas.style.touchAction = 'none'; } catch (e) { /* ignore */ }
    canvas.addEventListener('pointerdown', _onPointer);
    _markArmedButtons();
    _prompt();
    return true;
};

G.PRiSM_disarmAnalysisKey = function () { var was = !!_arm; _disarm(); if (was) _status('Tool cancelled.', 'info'); };

if (_hasDoc) {
    _on(document, 'keydown', function (ev) {
        if (ev && ev.key === 'Escape' && _arm) { _disarm(); _status('Tool cancelled.', 'info'); }
    });
}

// ---- Toolbar + results -----------------------------------------------------
var _BTN_CSS = 'font-size:12px; padding:6px 10px; margin:0; white-space:normal; text-align:left; ' +
               'max-width:100%; box-sizing:border-box; line-height:1.3;';

function _resultRowHTML(e) {
    var parts = [];
    Object.keys(e.values || {}).forEach(function (vk) {
        var qd = QTY[vk] || { label: vk, unit: '' };
        var val = e.values[vk];
        var sig = (vk === 'pStar' || vk === 'p1hr') ? 5 : 4;
        parts.push('<span style="white-space:nowrap;">' + _esc(qd.label) + ' <b style="color:var(--text, #e6edf3);">' +
                   _esc(_fmt(val, sig)) + '</b>' + (qd.unit ? ' ' + _esc(qd.unit) : '') + '</span>');
    });
    var chip = (e.defaultInputs && e.defaultInputs.length)
        ? ' <span title="' + _esc(e.warnings[0] || '') + '" style="display:inline-block; font-size:10px; padding:1px 6px; border-radius:8px; ' +
          'background:rgba(210,153,34,.18); color:var(--yellow, #d29922); border:1px solid var(--yellow, #d29922);">default inputs</span>'
        : '';
    var warn = '';
    (e.warnings || []).forEach(function (w, i) {
        if (i === 0 && chip) return;     // already shown as the chip tooltip
        warn += '<div style="font-size:11px; color:var(--yellow, #d29922); margin-top:2px;">' + _esc(w) + '</div>';
    });
    return '<div data-prism-akey-row="' + _esc(e.key) + '" style="padding:6px 0; border-top:1px solid var(--border, #30363d); ' +
               'font-size:12px; color:var(--text2, #8b949e); overflow-wrap:anywhere;">' +
             '<div style="display:flex; gap:6px; align-items:flex-start; justify-content:space-between;">' +
               '<div style="min-width:0;"><span style="color:var(--text, #e6edf3); font-weight:600;">' + _esc(e.label) + '</span>' + chip + '</div>' +
               '<button type="button" data-prism-akey-clear="' + _esc(e.key) + '" aria-label="Remove result" ' +
                 'style="background:none; border:none; color:var(--text3, #6e7681); cursor:pointer; font-size:14px; padding:0 4px;">×</button>' +
             '</div>' +
             '<div style="display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:2px;">' + parts.join('') + '</div>' +
             (e.text ? '<div style="margin-top:2px;">' + _esc(e.text) + '</div>' : '') +
             warn +
           '</div>';
}

G.PRiSM_renderAnalysisKeyToolbar = function (container, plotKey) {
    if (!_hasDoc) return;
    var host = (typeof container === 'string') ? document.getElementById(container) : container;
    if (!host) return;
    var st = G.PRiSM_state || {};
    plotKey = plotKey || st.activePlot || 'bourdet';
    host.setAttribute('data-prism-linetools', '1');     // refreshed with the active plot
    var keys = G.PRiSM_analysisKeys, groups = {}, order = [];
    Object.keys(keys).forEach(function (k) {
        if (!_keyOnPlot(keys[k], plotKey)) return;
        var g = keys[k].group || 'Tools';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(k);
    });
    var well = _wellInputs();
    var chip = '';
    if (well.defaulted.length) {
        chip = '<div data-prism-akey-defaults style="margin:6px 0; padding:6px 8px; border-radius:6px; font-size:12px; ' +
               'background:rgba(210,153,34,.12); border:1px solid var(--yellow, #d29922); color:var(--yellow, #d29922);">' +
               '⚠ Default inputs: ' + _esc(well.defaulted.map(function (k) { return WELL_LABEL[k]; }).join(', ')) +
               ' — results that use them are marked. Set them in Well & Test on Tab 1.</div>';
    }
    var btns = '';
    order.forEach(function (g) {
        btns += '<div style="margin-top:6px;"><div style="font-size:11px; color:var(--text3, #6e7681); margin-bottom:4px;">' + _esc(g) + '</div>' +
                '<div style="display:flex; flex-wrap:wrap; gap:6px;">';
        groups[g].forEach(function (k) {
            btns += '<button type="button" class="btn btn-secondary" data-prism-akey="' + _esc(k) + '" title="' + _esc(keys[k].hint || '') + '" ' +
                    'style="' + _BTN_CSS + '">' + _esc(keys[k].label) + '</button>';
        });
        btns += '</div></div>';
    });
    if (!btns) {
        btns = '<div style="font-size:12px; color:var(--text3, #6e7681); margin-top:6px;">No line tools for the ' +
               _esc(_plotLabel(plotKey)) + ' plot. Switch to the log-log derivative, semilog, Horner, √t, ⁴√t or spherical plot.</div>';
    }
    var res = st.analysisKeyResults || {};
    var resKeys = Object.keys(res).filter(function (k) { return res[k] && res[k].values; })
        .sort(function (a, b) { return (res[b].timestamp || 0) - (res[a].timestamp || 0); });
    var rows = resKeys.map(function (k) { return _resultRowHTML(res[k]); }).join('');
    host.innerHTML =
        '<div class="prism-linetools" style="max-width:100%; box-sizing:border-box; color:var(--text, #e6edf3);">' +
          '<div style="font-size:12px; color:var(--text2, #8b949e);">Tools for the <b style="color:var(--text, #e6edf3);">' +
            _esc(_plotLabel(plotKey)) + '</b> plot — pick a tool, then click the plot.</div>' +
          chip + btns +
          '<div data-prism-akey-status role="status" aria-live="polite" style="margin-top:8px; font-size:12px; min-height:16px; ' +
            'color:var(--text2, #8b949e); overflow-wrap:anywhere;"></div>' +
          (rows
            ? '<div style="margin-top:6px;"><div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">' +
                '<span style="font-size:11px; color:var(--text3, #6e7681);">Results</span>' +
                '<button type="button" data-prism-akey-clearall style="background:none; border:1px solid var(--border, #30363d); ' +
                  'color:var(--text2, #8b949e); border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer;">Clear all</button></div>' +
                rows + '</div>'
            : '') +
        '</div>';
    var nodes = host.querySelectorAll('[data-prism-akey]');
    for (var i = 0; i < nodes.length; i++) {
        (function (node) {
            node.onclick = function () { G.PRiSM_armAnalysisKey(node.getAttribute('data-prism-akey')); };
        })(nodes[i]);
    }
    var clears = host.querySelectorAll('[data-prism-akey-clear]');
    for (var j = 0; j < clears.length; j++) {
        (function (node) {
            node.onclick = function () {
                var s = G.PRiSM_state || {};
                if (s.analysisKeyResults) delete s.analysisKeyResults[node.getAttribute('data-prism-akey-clear')];
                if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* ignore */ } }
                _refreshToolbars();
                _redraw();
            };
        })(clears[j]);
    }
    var ca = host.querySelector('[data-prism-akey-clearall]');
    if (ca) ca.onclick = function () {
        var s = G.PRiSM_state || {};
        s.analysisKeyResults = {};
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* ignore */ } }
        _refreshToolbars();
        _redraw();
    };
    _markArmedButtons();
};

function _refreshToolbars() {
    if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
    var hosts;
    try { hosts = document.querySelectorAll('[data-prism-linetools]'); } catch (e) { return; }
    for (var i = 0; i < hosts.length; i++) {
        try { G.PRiSM_renderAnalysisKeyToolbar(hosts[i]); } catch (e2) { /* ignore */ }
    }
}

function _redraw() {
    if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
}

// Tab 2 panel (C7).
_registerTabPanel(2, {
    id: 'linetools',
    title: 'Plot line tools',
    order: 10,
    collapsed: false,
    render: function (host) {
        if (!host) return;
        host.innerHTML = '<div id="prism_linetools"></div>';
        G.PRiSM_renderAnalysisKeyToolbar(host.querySelector('#prism_linetools') || host);
    }
});

_on(G, 'prism:plot-changed', function () {
    var st = G.PRiSM_state || {};
    if (_arm && !_keyOnPlot(G.PRiSM_analysisKeys[_arm.key], st.activePlot || 'bourdet')) _disarm();
    _refreshToolbars();
});
_on(G, 'prism:well-changed', _refreshToolbars);
_on(G, 'prism:dataset-loaded', _refreshToolbars);

// Post-draw hook (C7): redraw the stored picks of the tools used on this plot.
function _linetoolsPostDraw(info) {
    if (!info || !info.canvas || !info.canvas.getContext) return;
    var st = G.PRiSM_state || {}, res = st.analysisKeyResults || {};
    var tr = _axesForward(info.axes || info.canvas._prismAxes);
    if (!tr) return;
    var plotKey = info.plotKey || st.activePlot;
    var list = Object.keys(res).map(function (k) { return res[k]; })
        .filter(function (e) { return e && e.plotKey === plotKey && Array.isArray(e.points); })
        .sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); }).slice(0, 4);
    if (!list.length) return;
    var ctx = info.canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    try {
        var pl = tr.plot;
        if (pl && _num(pl.w)) { ctx.beginPath(); ctx.rect(pl.x, pl.y, pl.w, pl.h); ctx.clip(); }
        list.forEach(function (e) {
            var xy = e.points.map(function (p) { return [tr.toX(p.x), tr.toY(p.y)]; })
                .filter(function (p) { return _num(p[0]) && _num(p[1]); });
            if (!xy.length) return;
            ctx.strokeStyle = 'rgba(240,136,62,0.9)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            if (xy.length >= 2) {
                ctx.beginPath(); ctx.moveTo(xy[0][0], xy[0][1]);
                for (var i = 1; i < xy.length; i++) ctx.lineTo(xy[i][0], xy[i][1]);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            xy.forEach(function (p) {
                ctx.beginPath(); ctx.moveTo(p[0] - 5, p[1]); ctx.lineTo(p[0] + 5, p[1]);
                ctx.moveTo(p[0], p[1] - 5); ctx.lineTo(p[0], p[1] + 5); ctx.stroke();
            });
        });
    } catch (e) { /* cosmetic */ }
    ctx.restore();
}
_linetoolsPostDraw._prismId = 'linetools-picks';

function _registerPostDraw(fn) {
    var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
    for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fn._prismId) { hooks[i] = fn; return; }
    hooks.push(fn);
}
_registerPostDraw(_linetoolsPostDraw);


// =========================================================================
// SECTION 3 — PNG / PDF EXPORT
// =========================================================================
// Plots are rendered off-screen from window.PRiSM_buildPlotData(plotKey)
// (C7) — the same data the screen uses — and the post-draw hooks are run
// on the off-screen canvas so exports match the screen.
// =========================================================================

var _PLOTS_SNAPSHOT = [
    { key: 'cartesian',     fn: 'PRiSM_plot_cartesian',             label: 'Cartesian P vs t',      mode: 'transient' },
    { key: 'horner',        fn: 'PRiSM_plot_horner',                label: 'Horner',                mode: 'transient' },
    { key: 'mdh',           fn: 'PRiSM_plot_mdh',                   label: 'Semilog (MDH)',         mode: 'transient' },
    { key: 'bourdet',       fn: 'PRiSM_plot_bourdet',               label: 'Log-Log Bourdet',       mode: 'transient' },
    { key: 'sqrt',          fn: 'PRiSM_plot_sqrt_time',             label: 'Square-root time',      mode: 'transient' },
    { key: 'quarter',       fn: 'PRiSM_plot_quarter_root_time',     label: 'Quarter-root time',     mode: 'transient' },
    { key: 'spherical',     fn: 'PRiSM_plot_spherical',             label: 'Spherical',             mode: 'transient' },
    { key: 'sandface',      fn: 'PRiSM_plot_sandface_convolution',  label: 'Material-balance time', mode: 'transient' },
    { key: 'superposition', fn: 'PRiSM_plot_buildup_superposition', label: 'Buildup superposition', mode: 'transient' },
    { key: 'rateCart',      fn: 'PRiSM_plot_rate_time_cartesian',   label: 'Rate vs time (cart)',   mode: 'decline' },
    { key: 'rateSemi',      fn: 'PRiSM_plot_rate_time_semilog',     label: 'Rate vs time (semi)',   mode: 'decline' },
    { key: 'rateLog',       fn: 'PRiSM_plot_rate_time_loglog',      label: 'Rate vs time (log)',    mode: 'decline' },
    { key: 'rateCum',       fn: 'PRiSM_plot_rate_cumulative',       label: 'Rate vs cumulative',    mode: 'decline' },
    { key: 'lossRatio',     fn: 'PRiSM_plot_loss_ratio',            label: 'Loss-ratio',            mode: 'decline' },
    { key: 'typeCurve',     fn: 'PRiSM_plot_typecurve_overlay',     label: 'Type-curve overlay',    mode: 'decline' }
];

function _plotEntries() {
    var reg = G.PRiSM_PLOT_REGISTRY, out = [];
    if (reg && typeof reg === 'object') {
        for (var k in reg) {
            if (!Object.prototype.hasOwnProperty.call(reg, k) || !reg[k]) continue;
            out.push({ key: k, fn: reg[k].fn, label: reg[k].label || k, mode: reg[k].mode || 'transient' });
        }
    }
    if (!out.length) out = _PLOTS_SNAPSHOT.slice();
    return out;
}

function _plotFn(entry) {
    if (!entry) return null;
    if (typeof entry.fn === 'function') return entry.fn;
    if (typeof entry.fn === 'string' && typeof G[entry.fn] === 'function') return G[entry.fn];
    return null;
}

G.PRiSM_listPlots = function () {
    return _plotEntries().map(function (e) {
        return { key: e.key, fn: typeof e.fn === 'string' ? e.fn : ((e.fn && e.fn.name) || ''), label: e.label, mode: e.mode };
    });
};

var _DECLINE_PLOTS = { rateCart: 1, rateSemi: 1, rateLog: 1, rateCum: 1, lossRatio: 1, typeCurve: 1 };

// Only used when the dispatcher's PRiSM_buildPlotData is not available.
function _fallbackPlotData(plotKey) {
    var ds = G.PRiSM_dataset;
    if (!ds || !ds.t || !ds.t.length) return null;
    if (_DECLINE_PLOTS[plotKey]) {
        var td = [];
        for (var i = 0; i < ds.t.length; i++) td.push(ds.t[i] / 24);
        return { data: { t: td, q: ds.q || null }, opts: { timeUnit: 'd', xLabel: 'Time (days)' } };
    }
    if (plotKey === 'cartesian') return { data: { t: ds.t, p: ds.p, q: ds.q, periods: ds.periods }, opts: {} };
    var ad = _analysisData();
    if (ad && ad.ok) {
        if (plotKey === 'bourdet' || plotKey === 'sandface') return { data: { t: ad.t, dp: ad.dp, deriv: ad.deriv }, opts: {} };
        var o = {};
        if (_pos(ad.tp)) o.tp = ad.tp;
        return { data: { t: ad.t, p: ad.p, dp: ad.dp, tp: ad.tp }, opts: o };
    }
    return { data: { t: ds.t, p: ds.p, q: ds.q }, opts: {} };
}

// Render a plot off-screen → canvas (or null).
G.PRiSM_renderPlotToCanvas = function (plotKey, w, h) {
    if (!_hasDoc) return null;
    var entries = _plotEntries(), entry = null;
    for (var i = 0; i < entries.length; i++) if (entries[i].key === plotKey) { entry = entries[i]; break; }
    var fn = _plotFn(entry);
    if (!fn) return null;
    var built = null;
    if (typeof G.PRiSM_buildPlotData === 'function') {
        try { built = G.PRiSM_buildPlotData(plotKey); } catch (e) { built = null; }
    }
    if (!built || !built.data) built = _fallbackPlotData(plotKey);
    if (!built || !built.data) return null;
    w = w || 1200; h = h || 800;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    try { c.style.width = w + 'px'; c.style.height = h + 'px'; } catch (e0) { /* ignore */ }
    var o = {}, src = built.opts || {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) o[k] = src[k];
    o.width = w; o.height = h; o.hover = false; o.dragZoom = false;
    if (o.showLegend == null) o.showLegend = true;
    var st = G.PRiSM_state || {};
    if (o.smoothL == null && _num(st.bourdetL)) o.smoothL = st.bourdetL;
    try { fn(c, built.data, o); } catch (e1) {
        try { console.warn('PRiSM export: plot ' + plotKey + ' failed: ' + (e1 && e1.message)); } catch (e2) { /* ignore */ }
    }
    var hooks = G.PRiSM_postDrawHooks;
    if (Array.isArray(hooks)) {
        for (var j = 0; j < hooks.length; j++) {
            try { hooks[j]({ canvas: c, plotKey: plotKey, data: built.data, opts: o, axes: c._prismAxes || null, exporting: true }); }
            catch (e3) { /* a hook must never break an export */ }
        }
    }
    return c;
};

function _plotDataURL(plotKey, w, h) {
    var c = G.PRiSM_renderPlotToCanvas(plotKey, w, h);
    if (!c) return null;
    try { return c.toDataURL('image/png'); } catch (e) { return null; }
}

G.PRiSM_exportPlotPNG = function (plotKey) {
    var st = G.PRiSM_state || {};
    plotKey = plotKey || st.activePlot || 'bourdet';
    var url = _plotDataURL(plotKey, 1200, 800);
    if (!url || !_hasDoc) {
        _polishToast('PNG export failed — the ' + _plotLabel(plotKey) + ' plot is not available.', 'error');
        return false;
    }
    var a = document.createElement('a');
    a.href = url;
    a.download = 'prism_' + plotKey + '.png';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    _polishToast('PNG saved: prism_' + plotKey + '.png', 'success');
    return true;
};

function _galleryHTML() {
    var ds = G.PRiSM_dataset;
    if (!ds || !ds.t || !ds.t.length) return '<p><em>No dataset loaded — plot gallery skipped.</em></p>';
    var mode = (G.PRiSM && G.PRiSM.mode) || 'transient';
    var html = '<h2 style="page-break-before:always;">Plots</h2>', cnt = 0;
    _plotEntries().forEach(function (e) {
        if (mode !== 'combined' && e.mode !== mode && e.mode !== 'both') return;
        var url = _plotDataURL(e.key, 1200, 800);
        if (!url) return;
        cnt++;
        html += '<div style="page-break-inside:avoid; margin-bottom:18px;"><h3 style="margin:6px 0;">' + _esc(e.label) + '</h3>' +
                '<img src="' + url + '" alt="' + _esc(e.label) + '" style="width:100%; max-width:1100px; height:auto; border:1px solid #ccc;"/></div>';
    });
    if (!cnt) html += '<p><em>No plots could be rendered.</em></p>';
    return html;
}

// PDF export: report body (36) + PNG gallery → host PDF pipeline.
// Returns 'host' | 'window' | false.
G.PRiSM_exportReportPDF = function () {
    var body;
    try {
        body = (typeof G.PRiSM_buildReportHTML === 'function')
            ? G.PRiSM_buildReportHTML({ plots: false })   // the gallery below carries the plots
            : '<p>(The report builder is not available — plots only.)</p>';
    } catch (e) {
        _polishToast('Report build failed: ' + (e && e.message), 'error');
        return false;
    }
    var html = String(body || '') + _galleryHTML();
    var st = G.PRiSM_state || {};
    var title = 'PRiSM Well-Test Analysis';
    var sub = st.model ? ('Model: ' + st.model) : '';
    // Lexical host pipeline (this file is concatenated inside the host IIFE).
    if (typeof exportReport === 'function') {
        try { exportReport(title, html, sub); return 'host'; }
        catch (e1) { try { console.warn('Host report export failed, using a print window: ' + e1.message); } catch (e2) { /* ignore */ } }
    }
    if (typeof G.exportReport === 'function') {
        try { G.exportReport(title, html, sub); return 'host'; } catch (e3) { /* fall through */ }
    }
    var w = null;
    try { w = G.open('', 'prism_report', 'width=900,height=1100'); } catch (e4) { w = null; }
    if (!w || !w.document) {
        _polishToast('Pop-up blocked — allow pop-ups to export the report.', 'error');
        return false;
    }
    var full = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<style>body{font-family:Arial,sans-serif;margin:24px;color:#222;}h1,h2,h3{color:#222;}' +
        'table{border-collapse:collapse;margin:8px 0;}th,td{border:1px solid #ddd;padding:4px 8px;font-size:12px;}' +
        'img{max-width:100%;height:auto;}@media print{body{margin:12px;}}</style></head><body>' +
        '<h1>' + title + '</h1>' + html +
        '<script>window.onload=function(){setTimeout(function(){try{window.print();}catch(e){}},400);};<\/script>' +
        '</body></html>';
    try {
        w.document.open(); w.document.write(full); w.document.close();
        _polishToast('Report opened — use the print dialog to save it as PDF.', 'success');
        return 'window';
    } catch (e5) {
        _polishToast('Print-window write failed: ' + (e5 && e5.message), 'error');
        return false;
    }
};


// =========================================================================
// SECTION 4 — USAGE ANALYTICS (GA4)
// =========================================================================
// Tab opens come from the shell's PRiSM_tabHooks.any; model and fit events
// from window CustomEvents. Nothing is wrapped and nothing polls.
// =========================================================================

function _ga4(eventName, params) {
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', eventName, params); } catch (e) { /* GA must never break the app */ }
    }
}

var _TAB_NAMES = ['', 'Data', 'Plots', 'Model', 'Params', 'Match', 'Regress', 'Report'];

function _gaTabHook(n) {
    _ga4('prism_tab_open', { event_category: 'PRiSM', event_label: _TAB_NAMES[n] || ('Tab ' + n), value: n, tab_index: n });
}
_gaTabHook._prismId = 'ga4-tab-open';

(function _registerGA() {
    var hooks = G.PRiSM_tabHooks = (G.PRiSM_tabHooks && typeof G.PRiSM_tabHooks === 'object') ? G.PRiSM_tabHooks : {};
    var any = hooks.any = Array.isArray(hooks.any) ? hooks.any : [];
    for (var i = 0; i < any.length; i++) if (any[i] && any[i]._prismId === _gaTabHook._prismId) return;
    any.push(_gaTabHook);
})();

_on(G, 'prism:model-changed', function (ev) {
    var d = (ev && ev.detail) || {};
    var key = d.modelKey || d.model || (G.PRiSM_state && G.PRiSM_state.model) || 'unknown';
    _ga4('prism_model_select', { event_category: 'PRiSM', event_label: String(key), model_key: String(key) });
});
_on(G, 'prism:fit-updated', function (ev) {
    var d = (ev && ev.detail) || {};
    var src = d.source || (d.fit && d.fit.source) || '';
    var key = d.modelKey || (d.fit && (d.fit.modelKey || d.fit.model)) || (G.PRiSM_state && G.PRiSM_state.model) || 'unknown';
    var name = src === 'regression' ? 'prism_regress_run' : src === 'automatch' ? 'prism_automatch_apply' :
               src === 'match' ? 'prism_typecurve_apply' : src === 'semilog' ? 'prism_semilog_run' : 'prism_fit_update';
    _ga4(name, { event_category: 'PRiSM', event_label: String(key), model_key: String(key), source: String(src) });
});
_on(G, 'prism:analysis-key', function (ev) {
    var d = (ev && ev.detail) || {};
    _ga4('prism_line_tool', { event_category: 'PRiSM', event_label: String(d.key || ''), tool: String(d.key || '') });
});

// Fallback model setter — only when the dispatcher (04) has not provided one.
if (typeof G.PRiSM_setModel !== 'function') {
    G.PRiSM_setModel = function (key) {
        var st = G.PRiSM_state || (G.PRiSM_state = { params: {} });
        st.model = key;
        var entry = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
        if (entry) {
            var defs = entry.defaults || {};
            st.params = {};
            for (var k in defs) if (Object.prototype.hasOwnProperty.call(defs, k)) st.params[k] = defs[k];
            st.modelCurve = null;
        }
        _emit('prism:model-changed', { modelKey: key });
    };
}

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
//   1. Step ① Data loads window.PRiSM_dataset = { t, p, q, ... }
//   2. This module is a Tab 1 panel ("Crop & trim", C7 registry, order 30).
//      The user drags handles (Pointer Events — mouse, pen and touch) or
//      types t_start/t_end/i_start/i_end to define the window.
//   3. A first-3 / last-3 preview block updates live.
//   4. "Confirm crop" makes the slice the active dataset (absolute times
//      kept) through window.PRiSM_commitDataset → 'prism:dataset-loaded'
//      {source:'crop'}, fires 'prism:dataset-cropped' and redraws the plot.
//   5. "Reset" restores the original snapshot the same way.
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
//     so a reset is always exact. The snapshot survives re-renders of the
//     Data tab while the active dataset is still the one this tool set; a
//     newly loaded dataset starts a new snapshot.
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
        owned: null,          // the dataset object this tool last made active
        wired: false
    };

    // Expose state for inspection (read mostly; tests poke it directly).
    G.PRiSM_cropState = cropState;


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — DATASET HELPERS
    // ═══════════════════════════════════════════════════════════════

    var _isArr = function (a) {
        return !!a && (Array.isArray(a) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(a)));
    };
    var _copy = function (a) { return Array.prototype.slice.call(a); };

    // Keys that are derived from the full record and would be wrong for a
    // slice (they are rebuilt by their owners on 'prism:dataset-loaded').
    var DERIVED_KEYS = { periods: 1, dp: 1, deriv: 1, _cache: 1 };

    // Take a snapshot of the active dataset (arrays copied — we never mutate
    // the originals).
    function _snapshotDataset(ds) {
        if (!ds) return null;
        var n = (ds.t || []).length;
        var snap = {
            t: _copy(ds.t || []),
            p: _isArr(ds.p) ? _copy(ds.p) : null,
            q: _isArr(ds.q) ? _copy(ds.q) : null
        };
        if (_isArr(ds.period)) snap.period = _copy(ds.period);
        if (ds.phases) {
            snap.phases = {
                oil:   _isArr(ds.phases.oil)   ? _copy(ds.phases.oil)   : null,
                gas:   _isArr(ds.phases.gas)   ? _copy(ds.phases.gas)   : null,
                water: _isArr(ds.phases.water) ? _copy(ds.phases.water) : null
            };
        }
        // Carry other top-level keys: parallel arrays are copied, other
        // arrays (derived, e.g. detected periods) are dropped, scalars and
        // small objects (name, source, units, …) are kept.
        for (var k in ds) {
            if (!Object.prototype.hasOwnProperty.call(ds, k)) continue;
            if (snap[k] !== undefined || DERIVED_KEYS[k]) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            var v = ds[k];
            if (_isArr(v)) { if (v.length === n) snap[k] = _copy(v); continue; }
            try { snap[k] = v; } catch (e) { /* ignore */ }
        }
        return snap;
    }

    // Slice helper — produces a new object with .slice(i_start, i_end)
    // applied to every parallel array. Indices are inclusive at i_start,
    // exclusive at i_end (matching Array.prototype.slice).
    function _sliceDataset(snap, i_start, i_end) {
        if (!snap) return null;
        var n = snap.t.length;
        var out = { t: snap.t.slice(i_start, i_end) };
        out.p = snap.p ? snap.p.slice(i_start, i_end) : null;
        out.q = snap.q ? snap.q.slice(i_start, i_end) : null;
        if (snap.period) out.period = snap.period.slice(i_start, i_end);
        if (snap.phases) {
            out.phases = {
                oil:   snap.phases.oil   ? snap.phases.oil.slice(i_start, i_end)   : null,
                gas:   snap.phases.gas   ? snap.phases.gas.slice(i_start, i_end)   : null,
                water: snap.phases.water ? snap.phases.water.slice(i_start, i_end) : null
            };
        }
        for (var k in snap) {
            if (!Object.prototype.hasOwnProperty.call(snap, k)) continue;
            if (out[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            var v = snap[k];
            if (_isArr(v)) { if (v.length === n) out[k] = v.slice(i_start, i_end); continue; }
            try { out[k] = v; } catch (e) {}
        }
        return out;
    }

    // Make ds active through the shared commit path (one
    // 'prism:dataset-loaded' {source:'crop'}), then redraw the active plot.
    function _commit(ds) {
        cropState.owned = ds;
        if (typeof G.PRiSM_commitDataset === 'function') {
            G.PRiSM_commitDataset(ds, { source: 'crop' });
        } else {
            G.PRiSM_dataset = ds;
            _dispatch('prism:dataset-loaded', { source: 'crop', dataset: ds });
        }
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
        // Derive sample indices: keep tStart ≤ t ≤ tEnd (small tolerance for
        // values typed from rounded times).
        var eps = 1e-9 * Math.max(1, Math.abs(tMax - tMin));
        cropState.i_start = _findIndex(t, ts - eps);
        var last = _findIndex(t, te + eps);
        if (t[last] > te + eps) last--;
        cropState.i_end   = last + 1; // exclusive
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

        // Canvas fills its container (down to 200 px on a phone) so the page
        // never scrolls sideways.
        var container = cropState.container;
        var maxW = 800;
        var availW = (container && container.clientWidth) ? container.clientWidth : maxW;
        var cssW = Math.max(200, Math.min(maxW, availW));
        var cssH = cssW < 480 ? 220 : 300;
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

    // Pointer → canvas CSS-pixel x (the layout frame). Scales by the drawn
    // width in case CSS max-width shrank the canvas below its set width.
    function _eventToCanvasX(canvas, ev) {
        if (!canvas || !canvas.getBoundingClientRect) return 0;
        var rect = canvas.getBoundingClientRect();
        var clientX = (ev.clientX != null) ? ev.clientX
                      : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0);
        var x = clientX - rect.left;
        var L = cropState.layout;
        if (L && rect.width > 0 && L.cssW > 0 && Math.abs(rect.width - L.cssW) > 0.5) x *= L.cssW / rect.width;
        return x;
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
        if (colorVar === 'green') color = 'color:var(--green, #3fb950);';
        else if (colorVar === 'red') color = 'color:var(--red, #f85149);';
        else color = 'color:var(--text2, #8b949e);';
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

    var INPUT_STYLE = 'width:120px; max-width:100%; padding:4px 6px; background:var(--bg1, #0d1117); color:var(--text, #c9d1d9); ' +
                      'border:1px solid var(--border, #30363d); border-radius:4px; font-family:monospace; font-size:12px;';
    var LABEL_STYLE = 'display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text2, #8b949e);';

    G.PRiSM_renderCropTool = function PRiSM_renderCropTool(container) {
        if (!_hasDoc) return;
        if (!container) return;
        cropState.container = container;

        container.innerHTML =
              '<div class="prism-crop-card">'
            +   '<div style="font-size:12px; color:var(--text2, #8b949e); margin-bottom:10px; line-height:1.5;">'
            +     'Drag across the chart to choose the part of the record to keep, or type the limits. '
            +     '<b style="color:var(--text, #c9d1d9);">Confirm crop</b> makes it the active dataset; '
            +     '<b style="color:var(--text, #c9d1d9);">Reset</b> brings the full record back.'
            +   '</div>'
            +   '<canvas id="prism_crop_canvas" width="800" height="300" aria-label="Crop chart: drag to select the time window" '
            +     'style="display:block; width:100%; max-width:100%; background:var(--bg1, #0d1117); border:1px solid var(--border, #30363d); '
            +     'border-radius:6px; touch-action:none;"></canvas>'
            +   '<div class="prism-crop-controls" style="margin-top:10px; display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;">'
            +     '<label style="' + LABEL_STYLE + '">t start (h)'
            +       '<input type="number" id="prism_crop_tstart" step="0.001" style="' + INPUT_STYLE + '"></label>'
            +     '<label style="' + LABEL_STYLE + '">t end (h)'
            +       '<input type="number" id="prism_crop_tend" step="0.001" style="' + INPUT_STYLE + '"></label>'
            +     '<label style="' + LABEL_STYLE + '">first row'
            +       '<input type="number" id="prism_crop_istart" min="0" step="1" style="' + INPUT_STYLE.replace('120px', '90px') + '"></label>'
            +     '<label style="' + LABEL_STYLE + '">last row (excl.)'
            +       '<input type="number" id="prism_crop_iend" min="0" step="1" style="' + INPUT_STYLE.replace('120px', '90px') + '"></label>'
            +     '<button id="prism_crop_apply" type="button" class="btn btn-primary" style="padding:8px 14px; font-size:12px;">Confirm crop</button>'
            +     '<button id="prism_crop_reset" type="button" class="btn btn-secondary" style="padding:8px 14px; font-size:12px;">Reset</button>'
            +     '<span id="prism_crop_msg" role="status" aria-live="polite" style="font-size:12px; color:var(--text2, #8b949e);"></span>'
            +   '</div>'
            +   '<pre id="prism_crop_preview" '
            +     'style="margin-top:12px; padding:10px; background:var(--bg1, #0d1117); color:var(--text, #c9d1d9); '
            +     'border:1px solid var(--border, #30363d); border-radius:6px; font-size:11px; '
            +     'font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; '
            +     'max-height:240px; overflow:auto; white-space:pre; max-width:100%;">'
            +     'No dataset loaded yet.'
            +   '</pre>'
            + '</div>';

        cropState.canvas = container.querySelector ? container.querySelector('#prism_crop_canvas') : _byId('prism_crop_canvas');
        _wireCanvasEvents(cropState.canvas);
        _wireInputs();

        // Keep the snapshot while the active dataset is still the one this
        // tool set (a re-render of the Data tab must not lose "Reset").
        if (!(cropState.fullDataset && cropState.owned && G.PRiSM_dataset === cropState.owned)) {
            cropState.fullDataset = null;
            cropState.owned = null;
        }
        _ensureSnapshot();
        if (cropState.fullDataset) {
            _normaliseBounds();
            _syncInputs();
            _drawCropChart();
            _renderPreviewBlock();
        }

        // Repaint on window resize so the canvas keeps filling its container.
        if (_hasWin && !cropState._resizeWired && G.addEventListener) {
            G.addEventListener('resize', function () {
                if (cropState.fullDataset && cropState.canvas && cropState.canvas.isConnected !== false) {
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
        _commit(cropped);
        _persistCrop(snap);
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
        _dispatchCropEvent(from, cropped);
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
        var t = snap.t;
        cropState.t_start = t[0];
        cropState.t_end   = t[t.length - 1];
        cropState.i_start = 0;
        cropState.i_end   = t.length;
        _commit(restored);
        _clearPersistedCrop();
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
        _dispatchCropEvent(from, restored);
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
        return restored;
    };

    // ── Persistence across a reload ─────────────────────────────────────
    // The Data-tab text (C8) restores the FULL record after a reload, so the
    // crop window is kept under 'wts_prism_crop' with the hash of the full
    // record it applies to. PRiSM_restorePersistedCrop() re-applies it when the
    // restored record is that same record (called by the dataset restore
    // paths in 01 / 07 right after they commit {source:'restored'}).
    var CROP_KEY = 'wts_prism_crop';
    function _ls() {
        try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* denied */ }
        return null;
    }
    function _hashOf(ds) {
        if (typeof G.PRiSM_datasetHash !== 'function' || !ds) return null;
        try { return G.PRiSM_datasetHash(ds); } catch (e) { return null; }
    }
    function _persistCrop(snap) {
        var ls = _ls(), h = _hashOf(snap);
        if (!ls || !h || !snap || !snap.t) return;
        var n = snap.t.length;
        // A window covering the whole record is no crop.
        if (cropState.i_start <= 0 && cropState.i_end >= n) { _clearPersistedCrop(); return; }
        try {
            ls.setItem(CROP_KEY, JSON.stringify({ v: 1, hash: h, n: n, t_start: cropState.t_start, t_end: cropState.t_end }));
        } catch (e) { /* quota / private mode */ }
    }
    function _clearPersistedCrop() {
        var ls = _ls();
        if (ls) { try { ls.removeItem(CROP_KEY); } catch (e) { /* ignore */ } }
    }
    function _readPersistedCrop() {
        var ls = _ls();
        if (!ls) return null;
        try {
            var o = JSON.parse(ls.getItem(CROP_KEY) || 'null');
            return (o && typeof o === 'object' && typeof o.hash === 'string' && isFinite(o.t_start) && isFinite(o.t_end)) ? o : null;
        } catch (e) { return null; }
    }
    G.PRiSM_restorePersistedCrop = function PRiSM_restorePersistedCrop() {
        var o = _readPersistedCrop(), ds = G.PRiSM_dataset;
        if (!o || !ds || !ds.t || ds.t.length !== o.n) return null;
        if (_hashOf(ds) !== o.hash) return null;
        _forgetSnapshot();
        return G.PRiSM_applyCrop(o.t_start, o.t_end);
    };
    G.PRiSM_persistedCrop = _readPersistedCrop;

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

    function _dispatch(type, detail) {
        if (!_hasWin || typeof G.dispatchEvent !== 'function') return;
        try {
            var ev = null;
            if (typeof CustomEvent === 'function') ev = new CustomEvent(type, { detail: detail });
            else if (_hasDoc && document.createEvent) {
                ev = document.createEvent('CustomEvent');
                ev.initCustomEvent(type, false, false, detail);
            }
            if (ev) G.dispatchEvent(ev);
        } catch (e) { /* ignore */ }
    }

    function _dispatchCropEvent(from, to) {
        _dispatch('prism:dataset-cropped', {
            from: from, to: to, t_start: cropState.t_start, t_end: cropState.t_end,
            i_start: cropState.i_start, i_end: cropState.i_end
        });
    }

    // A dataset loaded from anywhere else starts a new snapshot; our own
    // commits (source 'crop') keep it.
    function _forgetSnapshot() {
        cropState.fullDataset = null;
        cropState.owned = null;
        cropState.t_start = cropState.t_end = null;
        cropState.i_start = cropState.i_end = null;
    }

    function _connected() {
        var c = cropState.container;
        return !!(c && c.isConnected !== false);
    }

    if (_hasWin && G.addEventListener) {
        G.addEventListener('prism:dataset-loaded', function (ev) {
            var d = ev && ev.detail;
            if (d && d.source === 'crop') return;
            _forgetSnapshot();
            if (cropState.container && _connected()) {
                _ensureSnapshot();
                if (cropState.fullDataset) {
                    _normaliseBounds();
                    _syncInputs();
                    _drawCropChart();
                }
                _renderPreviewBlock();
            }
        });
        G.addEventListener('prism:dataset-cleared', function () {
            _forgetSnapshot();
            if (cropState.container && _connected()) _renderPreviewBlock();
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — TAB 1 PANEL (C7 registry)
    // ═══════════════════════════════════════════════════════════════
    // Mounted by PRiSM_renderTab(1) after the Data tab, below the Well &
    // Test card (order 10). No wrapping of other renderers, no timers.

    var CROP_PANEL = {
        id: 'crop',
        title: 'Crop & trim the record',
        order: 30,
        render: function (host) {
            if (!_hasDoc || !host) return;
            host.innerHTML = '';
            var box = document.createElement('div');
            box.id = 'prism_crop_tool_host';
            box.className = 'prism-crop-tool';
            host.appendChild(box);
            G.PRiSM_renderCropTool(box);
        }
    };

    (function _registerPanel() {
        if (!_hasWin) return;
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(1, CROP_PANEL); return; } catch (e) { /* fall through */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var list = G.PRiSM_tabPanels[1] = G.PRiSM_tabPanels[1] || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === CROP_PANEL.id) { list[i] = CROP_PANEL; return; }
        }
        list.push(CROP_PANEL);
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
//   Classifies flow regimes from the (sign-aware) Bourdet derivative,
//   narrows to a candidate model set, races every candidate through a
//   PHYSICAL parameterisation (k, C, S [, pi, shape]) and ranks by AIC on
//   an identical residual vector. Decline (rate) models race separately.
// -----------------------------------------------------------------------------
// PUBLIC API (all on window.PRiSM_*)
//   PRiSM_classifyRegimes(t, p, deriv?, opts?) → { regimes, candidates, summary, flags }
//   PRiSM_autoMatch(opts?)            → Promise<AutoMatchResult>   (yields between fits)
//   PRiSM_autoMatchSync(opts?)        → AutoMatchResult             (same, blocking)
//   PRiSM_applyAutoMatchRow(rowOrKey, result?) → row | null
//   PRiSM_suggestInitialParams(modelKey, t, p, deriv, classification) → params
//   PRiSM_renderAutoMatchPanel(host, result?)
//   PRiSM_modelPlainName(modelKey)    → 'Homogeneous reservoir' …
//
// AutoMatchResult = { ok, kind:'pressure'|'rate', mode, ranked:[row], top:[row ≤ 3],
//   bestKey (first CONVERGED row) , recommendedKey, bestConverged, deltaAIC:[],
//   decline:{ranked, top}|null, failed:[{modelKey, error}], classification,
//   analysis:{n, pRef, pRefSource, testType, timeFn, warnings}, well:{complete, missing},
//   elapsedMs, timestamp, warnings }
// row = C4 LastFit object + { rank, dAIC, akaikeWeight, label, status, modelName }
//   label: 'Best fit' (rank 1 AND converged) | 'Alternative' | 'Starting point — refine'
//   A non-converged row is NEVER labelled 'Best fit'.
//
// PHYSICAL PARAMETERISATION (contract C3). The response is fitted as
//   Δp(t) = A · pD(B·t; Cd, S, shape)   with
//   A  = 141.2 q B μ /(k h)             [psi per unit pD]
//   B  = 0.0002637 k /(φ μ ct Lref²)    [tD per hour]
//   Cd = 0.8936 C /(φ ct h Lref²)
// so A and B are tied through k and cannot absorb skin independently.
// When the well inputs are incomplete the race runs in SCALE mode
// (A, T = B/Cd, Cd·e^2S) and reports kh and C only; S is flagged as not
// identifiable without φ·ct·rw².
//
// Engines: window.PRiSM_fitPhysical / PRiSM_fitRate (05) and
// PRiSM_getAnalysisData / PRiSM_getWell / PRiSM_physicalModel (33) are used
// when present; every one has a local fallback in this file.
//
// CONVENTIONS: single outer IIFE; window.PRiSM_* only; registries read,
// never replaced; no external deps; never writes PRiSM_state.match.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});

// =========================================================================
// SECTION 0 — SMALL UTILITIES
// =========================================================================

function _fmt(n, sig) {
    if (n == null || typeof n !== 'number' || !isFinite(n)) return '—';
    sig = sig || 4;
    var a = Math.abs(n);
    if (a === 0) return '0';
    if (a >= 1e6 || a < 1e-3) return n.toExponential(Math.max(0, sig - 1));
    var s = n.toPrecision(sig);
    if (s.indexOf('.') !== -1 && s.indexOf('e') === -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

function _mean(arr) {
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) { s += arr[i]; n++; }
    return n > 0 ? (s / n) : NaN;
}

function _median(arr) {
    var f = [];
    for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) f.push(arr[i]);
    if (!f.length) return NaN;
    f.sort(function (a, b) { return a - b; });
    var m = f.length >> 1;
    return (f.length & 1) ? f[m] : 0.5 * (f[m - 1] + f[m]);
}

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

function _clone(o) {
    if (o == null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(_clone);
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = _clone(o[k]);
    return out;
}

function _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

function _toArr(a) {
    if (!a) return null;
    if (Array.isArray(a)) return a;
    if (typeof a.length === 'number') return Array.prototype.slice.call(a);
    return null;
}

// Bourdet derivative d(y)/d(ln x) with log-window L (natural-log units).
// The SAME operator is applied to data and model inside the objective so the
// derivative comparison is free of smoothing bias.
function _bourdet(x, y, L) {
    L = (L != null && isFinite(L)) ? Math.max(0, L) : 0.15;
    var n = x.length;
    var d = new Array(n);
    for (var k = 0; k < n; k++) d[k] = NaN;
    if (n < 3) return d;
    var lx = new Array(n);
    for (var j = 0; j < n; j++) lx[j] = (x[j] > 0) ? Math.log(x[j]) : NaN;
    for (var i = 1; i < n - 1; i++) {
        if (!isFinite(lx[i]) || !isFinite(y[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && lx[i] - lx[i1] < L) i1--;
            while (i2 < n - 1 && lx[i2] - lx[i] < L) i2++;
        }
        var dl1 = lx[i] - lx[i1], dl2 = lx[i2] - lx[i], dlT = lx[i2] - lx[i1];
        if (!(dl1 > 0) || !(dl2 > 0) || !(dlT > 0)) continue;
        d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
    }
    return d;
}

function _dispatch(name, detail) {
    try {
        if (typeof G.dispatchEvent === 'function' && typeof G.CustomEvent === 'function') {
            G.dispatchEvent(new G.CustomEvent(name, { detail: detail }));
        }
    } catch (e) { /* silent */ }
}

// Plain-language model names (never product names).
var PLAIN_NAMES = {
    homogeneous:       'Homogeneous reservoir',
    infiniteFrac:      'Fractured well (infinite conductivity)',
    finiteFrac:        'Fractured well (finite conductivity)',
    finiteFracSkin:    'Fractured well with fracture-face skin',
    inclined:          'Inclined (slanted) well',
    horizontal:        'Horizontal well',
    partialPenFrac:    'Partially penetrating fracture',
    linearBoundary:    'Single fault',
    parallelChannel:   'Channel (two parallel faults)',
    closedChannel3:    'Channel closed at one end',
    closedRectangle:   'Closed rectangle',
    intersecting:      'Intersecting faults',
    fogBoundary:       'Leaky fault',
    doublePorosity:    'Dual porosity (naturally fractured)',
    partialPen:        'Partial penetration',
    verticalPulse:     'Vertical pulse test',
    twoLayerXF:        'Two layers with crossflow',
    radialComposite:   'Radial composite',
    multiLayerXF:      'Multi-layer with crossflow',
    multiLayerNoXF:    'Multi-layer without crossflow',
    linearComposite:   'Linear composite',
    arps:              'Arps decline',
    duong:             'Duong decline',
    sepd:              'Stretched-exponential decline',
    fetkovich:         'Fetkovich decline',
    userDefined:       'User-defined type curve'
};

function PRiSM_modelPlainName(key) {
    if (!key) return '';
    if (PLAIN_NAMES[key]) return PLAIN_NAMES[key];
    var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
    if (e && typeof e.label === 'string' && e.label) return e.label;
    if (e && typeof e.name === 'string' && e.name) return e.name;
    var s = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}


// =========================================================================
// SECTION 1 — REGIME CLASSIFIER
// =========================================================================
//
//   1. Window the log-t axis into ≈ 6 segments; regress d(log Δp')/d(log t).
//   2. Tag each by the nearest library slope (±tolerance).
//   3. HUMP RULE (fix for classifier-skin-hump-as-spherical): a negative-
//      slope segment is only tagged spherical (−½) or constant-pressure (−1)
//      when it FOLLOWS a flat/radial segment, or starts more than 1.5 log
//      cycles after the derivative maximum. Otherwise it is the falling limb
//      of the wellbore-storage hump ('storageHump') and routes to the
//      WBS → homogeneous rule. (The Δp reference does not change the
//      derivative, so this is purely a shape rule.)
//   4. Higher-order shapes: derivative doubling (fault), valley (dual φ).
// =========================================================================

var SLOPE_LIBRARY = [
    { slope:  1.00, tag: 'wellboreStorage', tol: 0.20 },
    { slope:  0.50, tag: 'linearFlow',      tol: 0.18 },
    { slope:  0.25, tag: 'bilinearFlow',    tol: 0.12 },
    { slope:  0.00, tag: 'radialFlow',      tol: 0.15 },
    { slope: -0.50, tag: 'sphericalFlow',   tol: 0.18 },
    { slope: -1.00, tag: 'constPressure',   tol: 0.20 }
];
var LATE_PSS_TOL = 0.25;
var HUMP_LOG_CYCLES = 1.5;

var CANDIDATE_RULES = [
    { cond: function (f) { return f.wbs && f.radial && !f.fault && !f.lin && !f.bilin && !f.spheric && !f.dpor; },
      models: ['homogeneous', 'partialPen'] },
    { cond: function (f) { return f.lin && !f.bilin; },
      models: ['infiniteFrac', 'parallelChannel', 'partialPenFrac'] },
    { cond: function (f) { return f.bilin; },
      models: ['finiteFrac', 'finiteFracSkin'] },
    { cond: function (f) { return f.radial && f.spheric; },
      models: ['partialPen', 'verticalPulse'] },
    { cond: function (f) { return f.dpor; },
      models: ['doublePorosity', 'twoLayerXF'] },
    { cond: function (f) { return f.radial && f.fault; },
      models: ['linearBoundary', 'parallelChannel', 'closedChannel3'] },
    { cond: function (f) { return f.pss; },
      models: ['closedRectangle', 'intersecting'] },
    { cond: function (f) { return f.constP; },
      models: ['linearBoundary', 'radialComposite'] },
    { cond: function (f) { return f.radial; },
      models: ['homogeneous'] }
];

var DEFAULT_CANDIDATES = ['homogeneous', 'linearBoundary', 'infiniteFrac', 'doublePorosity',
                          'radialComposite', 'horizontal', 'partialPen'];
var DECLINE_CANDIDATES = ['arps', 'duong', 'sepd', 'fetkovich'];
var MAX_PRESSURE_CANDIDATES = 7;
var MIN_PRESSURE_CANDIDATES = 4;

var PRETTY_TAG = {
    wellboreStorage: 'Wellbore storage (unit slope)',
    storageHump:     'Wellbore-storage hump (damaged/storage)',
    linearFlow:      'Linear flow (½-slope)',
    bilinearFlow:    'Bilinear flow (¼-slope)',
    radialFlow:      'Radial flow',
    sphericalFlow:   'Spherical flow (−½-slope)',
    constPressure:   'Constant-pressure boundary',
    closedBoundary:  'Pseudo-steady state (closed)',
    sealingFault:    'Derivative doubling (sealing fault)',
    doublePorosity:  'Valley (dual porosity)'
};

/**
 * Classify flow regimes.
 * @param {number[]} t      Δt (> 0)
 * @param {number[]} p      pressure or Δp (only used when deriv is absent)
 * @param {number[]=} deriv Bourdet derivative (sign-aware, positive). If
 *                          absent it is computed from sign-aware Δp.
 * @param {object=} opts    { L }
 */
function PRiSM_classifyRegimes(t, p, deriv, opts) {
    opts = opts || {};
    t = _toArr(t); p = _toArr(p); deriv = _toArr(deriv);
    if (!t || !p || t.length !== p.length) {
        return { regimes: [], candidates: DEFAULT_CANDIDATES.slice(), flags: {},
                 summary: 'Invalid input — t and p arrays required.' };
    }
    var n = t.length;
    if (n < 4) {
        return { regimes: [{ tag: 'unknown', tdStart: t[0] || 0, tdEnd: t[n - 1] || 0, slope: NaN, confidence: 0 }],
                 candidates: DEFAULT_CANDIDATES.slice(), flags: {},
                 summary: 'Dataset too short (< 4 samples) — using default candidates.' };
    }

    var d;
    if (deriv && deriv.length === n) {
        d = deriv.map(function (v) { return Math.abs(v); });
    } else {
        // Sign-aware Δp (CLAUDE.md): +1 buildup, −1 drawdown.
        var sign = (p[n - 1] - p[0]) >= 0 ? 1 : -1;
        var dP = new Array(n);
        for (var i = 0; i < n; i++) dP[i] = sign * (p[i] - p[0]);
        d = _bourdet(t, dP, opts.L != null ? opts.L : 0.2);
    }

    var X = [], Y = [], idxMap = [];
    for (var k = 0; k < n; k++) {
        if (!(t[k] > 0)) continue;
        if (!isFinite(d[k]) || d[k] <= 0) continue;
        X.push(Math.log10(t[k])); Y.push(Math.log10(d[k])); idxMap.push(k);
    }
    var nGood = X.length;
    if (nGood < 3) {
        return { regimes: [{ tag: 'unknown', tdStart: t[0], tdEnd: t[n - 1], slope: NaN, confidence: 0 }],
                 candidates: DEFAULT_CANDIDATES.slice(), flags: {},
                 summary: 'Derivative dominated by non-positive values — using default candidates.' };
    }

    // Derivative maximum (for the hump rule).
    var iMax = 0;
    for (var im = 1; im < nGood; im++) if (Y[im] > Y[iMax]) iMax = im;
    var xMax = X[iMax];

    var nSeg = Math.max(3, Math.min(6, Math.floor(nGood / 3)));
    var perSeg = Math.floor(nGood / nSeg);
    var segments = [];
    for (var s = 0; s < nSeg; s++) {
        var i0 = s * perSeg;
        var i1 = (s === nSeg - 1) ? nGood : i0 + perSeg;
        if (i1 - i0 < 2) continue;
        var xs = X.slice(i0, i1), ys = Y.slice(i0, i1);
        var m = _slope(xs, ys);
        var b = _mean(ys) - m * _mean(xs);
        var sse = 0;
        for (var rr = 0; rr < xs.length; rr++) { var e = ys[rr] - (b + m * xs[rr]); sse += e * e; }
        segments.push({ tdStart: t[idxMap[i0]], tdEnd: t[idxMap[i1 - 1]], x0: xs[0],
                        slope: m, rmse: Math.sqrt(sse / xs.length), level: Math.pow(10, _mean(ys)) });
    }

    var regimes = [];
    var lastSegIdx = segments.length - 1;
    var seenFlat = false;
    for (var ss = 0; ss < segments.length; ss++) {
        var seg = segments[ss];
        var best = null, bestErr = Infinity;
        for (var li = 0; li < SLOPE_LIBRARY.length; li++) {
            var err = Math.abs(seg.slope - SLOPE_LIBRARY[li].slope);
            if (err < bestErr) { bestErr = err; best = SLOPE_LIBRARY[li]; }
        }
        if (ss === lastSegIdx && ss > 0 && seenFlat && seg.slope > 0.6 && seg.slope < 1.4) {
            regimes.push({ tag: 'closedBoundary', tdStart: seg.tdStart, tdEnd: seg.tdEnd, slope: seg.slope,
                           confidence: Math.max(0.3, 1 - Math.abs(seg.slope - 1) / LATE_PSS_TOL - seg.rmse),
                           level: seg.level });
            continue;
        }
        var tag = (best && bestErr <= best.tol) ? best.tag : 'unknown';
        var conf = 1 - (bestErr / Math.max(best.tol, 1e-6)) - Math.min(0.4, seg.rmse);
        if (conf < 0) conf = 0; if (conf > 1) conf = 1;

        // Hump rule.
        if (seg.slope < -0.2 && !seenFlat && (seg.x0 - xMax) <= HUMP_LOG_CYCLES) {
            tag = 'storageHump';
            conf = Math.max(conf, 0.6);
        }
        if (tag === 'radialFlow' || Math.abs(seg.slope) < 0.15) seenFlat = true;
        regimes.push({ tag: tag, tdStart: seg.tdStart, tdEnd: seg.tdEnd, slope: seg.slope,
                       confidence: conf, level: seg.level });
    }

    // Derivative doubling between two radial segments → sealing fault.
    var faultDetected = false;
    var baseLen = regimes.length;
    for (var rk = 1; rk < baseLen; rk++) {
        var a = regimes[rk - 1], b2 = regimes[rk];
        if (a.tag === 'radialFlow' && b2.tag === 'radialFlow' && a.level > 0) {
            var ratio = b2.level / a.level;
            if (ratio > 1.4 && ratio < 3.0) {
                regimes.push({ tag: 'sealingFault', tdStart: a.tdEnd, tdEnd: b2.tdStart, slope: 0,
                               confidence: Math.min(0.95, 0.5 + 0.4 * (1 - Math.abs(ratio - 2.0))), level: b2.level });
                faultDetected = true;
                break;
            }
        }
    }
    // Rising segment between two flats with a level step → fault as well.
    if (!faultDetected) {
        for (var rf = 1; rf < baseLen - 1; rf++) {
            var pr = regimes[rf - 1], cu = regimes[rf], nx = regimes[rf + 1];
            if (pr.tag === 'radialFlow' && nx.tag === 'radialFlow' && cu.slope > 0.1 && cu.slope < 0.8 && pr.level > 0) {
                var rt = nx.level / pr.level;
                if (rt > 1.4 && rt < 3.0) {
                    regimes.push({ tag: 'sealingFault', tdStart: cu.tdStart, tdEnd: cu.tdEnd, slope: cu.slope,
                                   confidence: 0.7, level: nx.level });
                    faultDetected = true;
                    break;
                }
            }
        }
    }

    // Valley between two stabilisations → dual porosity.
    var dporDetected = false;
    for (var v = 1; v < baseLen - 1; v++) {
        var pre = regimes[v - 1], cur = regimes[v], nxt = regimes[v + 1];
        if (pre.tag === 'radialFlow' && nxt.tag === 'radialFlow' && cur.level > 0 &&
            cur.level < 0.7 * Math.min(pre.level, nxt.level)) {
            regimes.push({ tag: 'doublePorosity', tdStart: pre.tdEnd, tdEnd: nxt.tdStart, slope: cur.slope,
                           confidence: 0.7, level: cur.level });
            dporDetected = true;
            break;
        }
    }

    var f = { wbs: false, hump: false, lin: false, bilin: false, radial: false, spheric: false,
              constP: false, pss: false, fault: faultDetected, dpor: dporDetected };
    for (var rg = 0; rg < regimes.length; rg++) {
        var r = regimes[rg];
        if (r.confidence < 0.45) continue;
        switch (r.tag) {
            case 'wellboreStorage': f.wbs = true; break;
            case 'storageHump':     f.hump = true; f.wbs = true; break;
            case 'linearFlow':      f.lin = true; break;
            case 'bilinearFlow':    f.bilin = true; break;
            case 'radialFlow':      f.radial = true; break;
            case 'sphericalFlow':   f.spheric = true; break;
            case 'constPressure':   f.constP = true; break;
            case 'closedBoundary':  f.pss = true; break;
        }
    }
    // A hump followed by radial flow counts as WBS + radial even when the
    // unit-slope itself was not sampled (data starting after WBS).
    var candidates = [];
    for (var c = 0; c < CANDIDATE_RULES.length; c++) {
        if (CANDIDATE_RULES[c].cond(f)) { candidates = CANDIDATE_RULES[c].models.slice(); break; }
    }
    if (!candidates.length) candidates = DEFAULT_CANDIDATES.slice();
    if (candidates.indexOf('homogeneous') === -1) candidates.push('homogeneous');

    var registry = G.PRiSM_MODELS || {};
    if (Object.keys(registry).length > 0) {
        candidates = candidates.filter(function (key) { return !!registry[key]; });
    }

    var tagOrder = [], seenT = {};
    for (var rg2 = 0; rg2 < regimes.length; rg2++) {
        var tg = regimes[rg2].tag;
        if (tg === 'unknown' || seenT[tg]) continue;
        seenT[tg] = true; tagOrder.push(tg);
    }
    var summary;
    if (tagOrder.length) {
        summary = tagOrder.map(function (x) { return PRETTY_TAG[x] || x; }).join(' → ');
        summary += '. Candidates: ' + candidates.slice(0, 4).map(PRiSM_modelPlainName).join(', ');
        if (candidates.length > 4) summary += ' (+' + (candidates.length - 4) + ')';
        summary += '.';
    } else {
        summary = 'No clear regime detected — fitting the default candidate set.';
    }
    return { regimes: regimes, candidates: candidates, summary: summary, flags: f,
             derivMax: { t: t[idxMap[iMax]], value: Math.pow(10, Y[iMax]) } };
}


// =========================================================================
// SECTION 2 — SHAPE-PARAMETER STARTS
// =========================================================================
// Dimensionless shape parameters start from the registry defaults, nudged by
// diagnostic features. k, C, S and pi are seeded physically in SECTION 4.

function PRiSM_suggestInitialParams(modelKey, t, p, deriv, classification) {
    var registry = G.PRiSM_MODELS || {};
    var entry = registry[modelKey];
    var defaults = (entry && entry.defaults) ? entry.defaults : {};
    var out = {};
    for (var k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = defaults[k];
    var regimes = (classification && classification.regimes) || [];

    // Dual porosity ω ≈ valley / first-radial level.
    if ('omega' in out) {
        var firstR = NaN, valley = NaN;
        for (var i = 0; i < regimes.length; i++) {
            if (regimes[i].tag === 'radialFlow' && !isFinite(firstR)) firstR = regimes[i].level;
            if (regimes[i].tag === 'doublePorosity') valley = regimes[i].level;
        }
        if (_pos(firstR) && _pos(valley)) out.omega = Math.max(0.005, Math.min(0.5, valley / firstR));
    }
    // Decline starts (rate models).
    var q = (G.PRiSM_dataset && _toArr(G.PRiSM_dataset.q)) || null;
    if (q && t && t.length) {
        var qf = q.filter(function (v) { return _pos(v); });
        if (qf.length) {
            if ('qi' in out) out.qi = qf[0];
            if ('q1' in out) out.q1 = qf[0];
        }
    }
    return out;
}

// Race-time freeze when the registry carries no `defaultFrozen` metadata
// (S_perf / S_global are collinear; geometry fractions are rarely resolved).
var RACE_FREEZE_FALLBACK = {
    partialPen:    ['S_global', 'zw_to_h', 'h_eff'],
    verticalPulse: ['zw_to_h', 'zobs_to_h', 'h_eff'],
    horizontal:    ['S_global', 'zw_to_h'],
    inclined:      ['S_global', 'hp_to_h'],
    fogBoundary:   [],
    doublePorosity:[]
};

var DISTANCE_KEYS = ['L', 'dF', 'dF1', 'dF2', 'dEnd', 'dN', 'dS', 'dE', 'dW', 'R', 'rD', 'reD', 'Ri'];


// =========================================================================
// SECTION 3 — INPUTS: WELL + ANALYSIS DATA (core API or local fallback)
// =========================================================================

var WELL_REQUIRED = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];

function _finishWell(w) {
    w = w || {};
    var missing = [];
    for (var i = 0; i < WELL_REQUIRED.length; i++) if (!_pos(w[WELL_REQUIRED[i]])) missing.push(WELL_REQUIRED[i]);
    if (typeof w.complete !== 'boolean') w.complete = missing.length === 0;
    if (!Array.isArray(w.missing)) w.missing = missing;
    if (!Array.isArray(w.defaulted)) w.defaulted = [];
    if (!w.testType) w.testType = 'auto';
    if (!w.fluid) w.fluid = 'oil';
    return w;
}

function _medianPositive(arr) {
    if (!arr) return NaN;
    var f = [];
    for (var i = 0; i < arr.length; i++) if (_pos(arr[i])) f.push(arr[i]);
    return _median(f);
}

function _localWell(ds) {
    var pvt = G.PRiSM_pvt || {};
    var c = pvt._computed || {};
    var fluid = pvt.fluidType || 'oil';
    var qData = ds ? _medianPositive(_toArr(ds.q)) : NaN;
    var B, mu;
    if (fluid === 'gas')        { B = _pos(pvt.Bg) ? pvt.Bg : c.Bg; mu = _pos(pvt.mu_g) ? pvt.mu_g : c.mu_g; }
    else if (fluid === 'water') { B = pvt.Bw; mu = pvt.mu_w; }
    else                        { B = _pos(pvt.Bo) ? pvt.Bo : c.Bo; mu = _pos(pvt.mu_o) ? pvt.mu_o : c.mu_o; }
    if (!_pos(B)) B = c.B;
    if (!_pos(mu)) mu = c.mu;
    var prov = (pvt.provenance && pvt.provenance.p_res) || null;
    var piOk = prov === 'user' || prov === 'sample' || prov === 'deconvolution';
    return _finishWell({
        fluid: fluid,
        q: _pos(qData) ? qData : pvt.q,
        B: B, mu: mu,
        ct: _pos(pvt.ct) ? pvt.ct : c.ct,
        h: pvt.h, phi: pvt.phi, rw: pvt.rw,
        pi: (piOk && _pos(pvt.p_res)) ? pvt.p_res : null,
        T_R: _num(pvt.T_res) ? pvt.T_res + 459.67 : null,
        testType: pvt.testType || 'auto',
        tp: _pos(pvt.tp) ? pvt.tp : null,
        tShut: _pos(pvt.tShut) ? pvt.tShut : null,
        pwf0: _pos(pvt.pwf0) ? pvt.pwf0 : null,
        _local: true
    });
}

function _resolveWell(ds, opts, useCore) {
    if (opts.well) return _finishWell(_clone(opts.well));
    if (useCore && typeof G.PRiSM_getWell === 'function') {
        try { var w = G.PRiSM_getWell(ds); if (w) return _finishWell(_clone(w)); } catch (e) { /* fall back */ }
    }
    return _localWell(ds);
}

// Local analysis-data builder (subset of contract C2): sign-aware Δp,
// reference pressure with provenance, Δt re-zeroed at shut-in.
function _localAnalysisData(ds, well, opts) {
    var t = _toArr(ds && ds.t), p = _toArr(ds && ds.p), q = _toArr(ds && ds.q);
    if (!t || !p || t.length !== p.length) return { ok: false, reason: 'No pressure data (need t[] and p[]).' };
    var n = t.length;
    var warnings = [];

    // Test type.
    var testType = (well.testType && well.testType !== 'auto') ? well.testType : null;
    var tShut = _pos(well.tShut) ? well.tShut : null;
    var qRef = _pos(well.q) ? well.q : NaN;
    if (q && q.length === n) {
        var firstZeroAfterFlow = -1, sawFlow = false;
        for (var i = 0; i < n; i++) {
            if (_pos(q[i])) sawFlow = true;
            else if (sawFlow && q[i] === 0) { firstZeroAfterFlow = i; break; }
        }
        if (firstZeroAfterFlow > 0) {
            if (!testType) testType = 'buildup';
            if (!tShut) tShut = t[firstZeroAfterFlow - 1] + 0.5 * (t[firstZeroAfterFlow] - t[firstZeroAfterFlow - 1]);
            var qBefore = _medianPositive(q.slice(0, firstZeroAfterFlow));
            if (_pos(qBefore)) qRef = qBefore;
        }
    }
    if (!testType) testType = ((p[n - 1] - p[0]) >= 0) ? 'buildup' : 'drawdown';
    var ddSign = (testType === 'drawdown' || testType === 'falloff') ? -1 : 1;   // Δp = ddSign·(p − pRef)

    var isBU = (testType === 'buildup' || testType === 'falloff');
    var tStart = isBU ? (tShut || 0) : 0;
    var tp = isBU ? (_pos(well.tp) ? well.tp : (tStart > 0 ? tStart : null)) : null;

    // Reference pressure.
    var pRef = NaN, pRefSource = null;
    if (!isBU) {
        if (_pos(well.pi)) { pRef = well.pi; pRefSource = 'pi'; }
        else {
            for (var z = 0; z < n; z++) if (t[z] <= 0 && _num(p[z])) { pRef = p[z]; pRefSource = 't0-row'; break; }
        }
        if (!_num(pRef)) {
            var pts = [];
            for (var e = 0; e < n && pts.length < 3; e++) if (t[e] > 0 && _num(p[e])) pts.push([t[e], p[e]]);
            if (pts.length >= 2) {
                var sl = _slope(pts.map(function (a) { return a[0]; }), pts.map(function (a) { return a[1]; }));
                var p0 = _mean(pts.map(function (a) { return a[1]; })) - sl * _mean(pts.map(function (a) { return a[0]; }));
                if (_num(p0) && ddSign * (pts[0][1] - p0) > 0) { pRef = p0; pRefSource = 'extrapolated'; }
            }
            if (!_num(pRef)) { pRef = p[0]; pRefSource = 'first-sample'; }
            warnings.push('No initial reservoir pressure pi entered — Δp is measured from the ' +
                          (pRefSource === 'extrapolated' ? 'extrapolated first points' : 'first sample') +
                          ', so skin is biased. Enter pi or let the fit float it.');
        }
    } else {
        if (_pos(well.pwf0)) { pRef = well.pwf0; pRefSource = 'pwf0'; }
        else {
            var bestIdx = -1;
            for (var b = 0; b < n; b++) if (t[b] <= tStart + 1e-12) bestIdx = b;
            if (bestIdx >= 0) { pRef = p[bestIdx]; pRefSource = 't0-row'; }
            else { pRef = p[0]; pRefSource = 'first-sample'; }
        }
    }

    var tt = [], tA = [], pp = [], dp = [];
    for (var k = 0; k < n; k++) {
        var dt = t[k] - tStart;
        if (!(dt > 0) || !_num(p[k])) continue;
        var d = ddSign * (p[k] - pRef);
        if (!(d > 0)) continue;
        tt.push(dt); tA.push(t[k]); pp.push(p[k]); dp.push(d);
    }
    if (tt.length < 5) return { ok: false, reason: 'Fewer than 5 points with positive Δp.', warnings: warnings };
    var L = _num(opts.L) ? opts.L : ((G.PRiSM_state && _num(G.PRiSM_state.bourdetL)) ? G.PRiSM_state.bourdetL : 0.15);
    var rateHistory = [{ t: 0, q: _pos(qRef) ? qRef : 1 }];
    if (isBU && _pos(tp)) rateHistory = [{ t: 0, q: _pos(qRef) ? qRef : 1 }, { t: tp, q: 0 }];
    else if (isBU) warnings.push('Buildup without a producing time tp — analysed as a drawdown-equivalent.');
    return {
        ok: true, n: tt.length, t: tt, tAbs: tA, p: pp, dp: dp, x: tt.slice(),
        deriv: _bourdet(tt, dp, L), L: L, timeFn: 'dt',
        sign: ddSign, pRef: pRef, pRefSource: pRefSource, testType: testType,
        tStart: isBU && _pos(tp) ? tp : 0, tShut: tShut, tp: tp, qRef: _pos(qRef) ? qRef : null,
        rateHistory: rateHistory, periods: [], fluid: well.fluid, warnings: warnings, _local: true
    };
}

function _resolveAdata(ds, well, opts, useCore) {
    if (opts.adata && opts.adata.t) return opts.adata;
    if (useCore && typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var a = G.PRiSM_getAnalysisData(ds, { period: opts.period, timeFn: opts.timeFn, L: opts.L });
            if (a) return a;
        } catch (e) { /* fall back */ }
    }
    return _localAnalysisData(ds, well, opts);
}


// =========================================================================
// SECTION 4 — LOCAL PHYSICAL MODEL (contract C3 subset)
// =========================================================================

var NOMINAL_WELL = { q: 1000, B: 1.2, mu: 1.0, ct: 1e-5, h: 50, phi: 0.2, rw: 0.354 };

function _specOf(entry, key) {
    var ps = entry && entry.paramSpec;
    if (Array.isArray(ps)) for (var i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
    return null;
}

function _isLogShape(sp, def) {
    if (!sp) return false;
    if (sp.scale === 'log') return true;
    if (sp.scale === 'lin') return false;
    if (_pos(sp.min) && _num(sp.max) && sp.max / sp.min >= 100) return true;
    if (sp.min === 0 && _pos(def) && _num(sp.max) && sp.max / def >= 100) return true;
    return false;
}

// Superposed dimensionless response for the analysed period.
// A is psi per unit pD at the reference rate qA (single-rate: Δp = A·pD).
function _superposedDp(entry, params, A, qA, Bt, adata, tArr) {
    var hist = adata.rateHistory || [];
    var tStart = _num(adata.tStart) ? adata.tStart : 0;
    var multi = hist.length > 1 && tStart > 0;
    if (!multi) {
        var tdArr = tArr.map(function (x) { return Math.max(1e-12, Bt * x); });
        var pd = entry.pd(tdArr, params);
        return pd.map(function (v) { return A * v; });
    }
    var A1 = A / qA;
    // P(T) = A1 Σ Δq_i pD(B (T − t_i));  Δp(Δt) = sgn [P(tStart+Δt) − P(tStart)]
    var steps = [];
    var prevQ = 0;
    for (var i = 0; i < hist.length; i++) {
        var qi = _num(hist[i].q) ? hist[i].q : 0;
        if (hist[i].t < tStart + 1e-12 || i === 0) steps.push({ t: hist[i].t, dq: qi - prevQ });
        prevQ = qi;
    }
    var lastQBefore = 0, qNow = 0;
    for (var j = 0; j < hist.length; j++) {
        if (hist[j].t < tStart - 1e-12) lastQBefore = hist[j].q;
        if (hist[j].t <= tStart + 1e-12) qNow = hist[j].q;
    }
    var sgn = (qNow - lastQBefore) >= 0 ? 1 : -1;
    var args = [], map = [];
    function _push(T, si, ti) {
        var a = T - steps[si].t;
        if (a > 0) { map.push([si, ti, args.length]); args.push(Math.max(1e-12, Bt * a)); }
    }
    for (var s = 0; s < steps.length; s++) {
        _push(tStart, s, -1);
        for (var k = 0; k < tArr.length; k++) _push(tStart + tArr[k], s, k);
    }
    var pdv = args.length ? entry.pd(args, params) : [];
    var P0 = 0, P = new Array(tArr.length);
    for (var z = 0; z < tArr.length; z++) P[z] = 0;
    for (var m = 0; m < map.length; m++) {
        var contrib = A1 * steps[map[m][0]].dq * pdv[map[m][2]];
        if (map[m][1] < 0) P0 += contrib; else P[map[m][1]] += contrib;
    }
    return P.map(function (v) { return sgn * (v - P0); });
}

function _localPM(modelKey, well, adata, opts) {
    var entry = (G.PRiSM_MODELS || {})[modelKey];
    if (!entry || typeof entry.pd !== 'function') return { ok: false, reason: 'No evaluator for ' + modelKey };
    if (entry.kind === 'rate') return { ok: false, reason: modelKey + ' is a rate model' };
    var defaults = entry.defaults || {};
    var hasCd = _num(defaults.Cd);
    var skinKey = _num(defaults.S) ? 'S' : (_num(defaults.S_perf) ? 'S_perf' : null);
    var refLength = entry.refLength || 'rw';
    var refKey = (refLength === 'xf' || refLength === 'Lh') ? refLength : null;
    var scale = !well.complete || !!opts.forceScale;
    var W = {};
    for (var wk in NOMINAL_WELL) W[wk] = _pos(well[wk]) ? well[wk] : NOMINAL_WELL[wk];
    var qA = W.q;

    var frozen = {};
    var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : (RACE_FREEZE_FALLBACK[modelKey] || []);
    df.forEach(function (k) { frozen[k] = true; });
    if (opts.freeze) for (var fz in opts.freeze) if (opts.freeze[fz]) frozen[fz] = true;

    var keys = [], spec = {}, fixed = {};
    function addKey(k, lo, hi, isLog, unit, def) {
        keys.push(k); spec[k] = { min: lo, max: hi, scale: isLog ? 'log' : 'lin', unit: unit || '', default: def };
    }
    var shapeKeys = [];
    for (var dk in defaults) {
        if (!Object.prototype.hasOwnProperty.call(defaults, dk)) continue;
        var dv = defaults[dk];
        if (dk === 'Cd' || dk === skinKey || dk.indexOf('__') === 0) continue;
        if (typeof dv !== 'number') { fixed[dk] = dv; continue; }
        if (refKey && dk === refKey) continue;
        shapeKeys.push(dk);
    }
    var skinSpec = skinKey ? _specOf(entry, skinKey) : null;
    var sLo = (skinSpec && _num(skinSpec.min)) ? Math.max(skinSpec.min, -7) : -7;
    var sHi = (skinSpec && _num(skinSpec.max)) ? Math.min(skinSpec.max, 50) : 50;

    if (!scale) {
        addKey('k', 1e-4, 1e6, true, 'md');
        if (hasCd) addKey('C', 1e-8, 10, true, 'bbl/psi');
        if (skinKey) addKey('S', sLo, sHi, false, '');
        if (refKey) addKey(refKey, 1, 1e5, true, 'ft', 100);
    } else {
        addKey('A', 1e-3, 1e7, true, 'psi');
        if (hasCd) addKey('T', 1e-6, 1e9, true, '1/hr'); else addKey('Bt', 1e-2, 1e12, true, '1/hr');
        if (hasCd && skinKey) addKey('CDe2S', 1e-6, 1e60, true, '');
        else if (skinKey) { frozen.S = true; }
    }
    shapeKeys.forEach(function (sk) {
        var sp = _specOf(entry, sk) || {};
        var def = defaults[sk];
        var lg = _isLogShape(sp, def);
        var lo = _num(sp.min) ? sp.min : (def > 0 ? def / 1e4 : -1e3);
        var hi = _num(sp.max) ? sp.max : (def > 0 ? def * 1e4 : 1e3);
        if (lg && !(lo > 0)) lo = Math.max(def / 1e4, 1e-12);
        addKey(sk, lo, hi, lg, sp.unit || '', def);
    });
    var floatPi = !scale && !!opts.floatPi && (adata.testType === 'drawdown' || adata.testType === 'injection');
    if (floatPi) {
        var pmax = -Infinity, pmin = Infinity;
        (adata.p || []).forEach(function (v) { if (v > pmax) pmax = v; if (v < pmin) pmin = v; });
        var span = Math.max(1, pmax - pmin);
        if (adata.testType === 'injection') addKey('pi', pmin - 3 * span, pmin - 0.01, false, 'psia');
        else addKey('pi', pmax + 0.01, pmax + 3 * span, false, 'psia');
    }
    var Cd0 = 100;

    function toModelParams(phys) {
        var params = {};
        for (var d0 in defaults) if (Object.prototype.hasOwnProperty.call(defaults, d0)) params[d0] = defaults[d0];
        for (var fx in fixed) params[fx] = fixed[fx];
        shapeKeys.forEach(function (sk) { if (_num(phys[sk])) params[sk] = phys[sk]; });
        var A, Bt, Lref = W.rw;
        if (!scale) {
            if (refKey) Lref = phys[refKey];
            var kh = phys.k * W.h;
            A = 141.2 * qA * W.B * W.mu / kh;
            Bt = 0.0002637 * phys.k / (W.phi * W.mu * W.ct * Lref * Lref);
            if (hasCd) params.Cd = 0.8936 * phys.C / (W.phi * W.ct * W.h * Lref * Lref);
            if (skinKey) params[skinKey] = phys.S;
            if (refKey) { params[refKey] = phys[refKey]; params.__h_rw = W.h / W.rw; }
        } else {
            A = phys.A;
            if (hasCd) {
                params.Cd = Cd0;
                Bt = phys.T * Cd0;
                if (skinKey) params[skinKey] = 0.5 * Math.log(phys.CDe2S / Cd0);
            } else {
                Bt = phys.Bt;
                if (skinKey) params[skinKey] = _num(phys.S) ? phys.S : 0;
            }
        }
        return { params: params, A: A, B: Bt, Lref: Lref };
    }

    function dpFn(tArr, phys) {
        var mp = toModelParams(phys);
        return _superposedDp(entry, mp.params, mp.A, qA, mp.B, adata, tArr);
    }

    function seed(work) {
        // Late derivative level → kh; unit slope → C; late point → S.
        var n = work.t.length, tEnd = work.t[n - 1];
        var late = [];
        for (var i = 0; i < n; i++) if (work.t[i] >= tEnd / 10 && _pos(work.deriv[i])) late.push(i);
        if (late.length < 3) for (var i2 = Math.max(0, n - 6); i2 < n; i2++) if (_pos(work.deriv[i2]) && late.indexOf(i2) < 0) late.push(i2);
        var dLate = _median(late.map(function (ix) { return work.deriv[ix]; }));
        if (!_pos(dLate)) dLate = _median(work.dp) / 5;
        var kh = 70.6 * qA * W.B * W.mu / dLate;
        var k = kh / W.h;
        var Cs = [];
        for (var u = 1; u < n - 1 && u < 12; u++) {
            var s1 = Math.log(work.dp[u + 1] / work.dp[u - 1]) / Math.log(work.t[u + 1] / work.t[u - 1]);
            if (s1 > 0.85 && s1 < 1.15) Cs.push(qA * W.B * work.t[u] / (24 * work.dp[u]));
        }
        var C = Cs.length ? _median(Cs) : 0.7 * qA * W.B * work.t[0] / (24 * work.dp[0]);
        var r = late.length ? late[late.length - 1] : n - 1;
        var dpr = work.dp[r], dr = _pos(work.deriv[r]) ? work.deriv[r] : dLate;
        var S = 0.5 * (dpr / dr - Math.log(0.0002637 * k * work.t[r] / (W.phi * W.mu * W.ct * W.rw * W.rw)) - 0.80907);
        if (!_num(S)) S = 0;
        var phys = {};
        if (!scale) {
            phys.k = k;
            if (hasCd) phys.C = C;
            if (skinKey) phys.S = S;
            if (refKey) phys[refKey] = 100;
        } else {
            var Bt = 0.0002637 * k / (W.phi * W.mu * W.ct * W.rw * W.rw);
            var Cd = 0.8936 * C / (W.phi * W.ct * W.h * W.rw * W.rw);
            phys.A = 141.2 * qA * W.B * W.mu / kh;
            if (hasCd) phys.T = Bt / Cd; else phys.Bt = Bt;
            if (hasCd && skinKey) phys.CDe2S = Cd * Math.exp(2 * Math.max(-3, S));
        }
        var shape = PRiSM_suggestInitialParams(modelKey, work.t, work.dp, work.deriv, opts.classification);
        shapeKeys.forEach(function (sk) { phys[sk] = _num(shape[sk]) ? shape[sk] : defaults[sk]; });
        // Boundary distance seed from a detected fault time.
        var reg = (opts.classification && opts.classification.regimes) || [];
        var tf = NaN;
        reg.forEach(function (rg) { if (rg.tag === 'sealingFault' && !_num(tf)) tf = rg.tdStart; });
        if (_pos(tf) && !scale) {
            var rinvF = Math.sqrt(k * tf / (948 * W.phi * W.mu * W.ct));
            ['dF', 'dF1', 'dF2'].forEach(function (dk2) { if (shapeKeys.indexOf(dk2) >= 0) phys[dk2] = 0.5 * rinvF / W.rw; });
        }
        if (floatPi) phys.pi = _pos(well.pi) ? well.pi : (adata.testType === 'injection' ? adata.pRef - 1 : adata.pRef + 1);
        keys.forEach(function (kk) {
            var sp = spec[kk];
            if (!_num(phys[kk])) phys[kk] = _num(sp.default) ? sp.default : (sp.scale === 'log' ? Math.sqrt(sp.min * sp.max) : 0.5 * (sp.min + sp.max));
            phys[kk] = Math.min(sp.max, Math.max(sp.min, phys[kk]));
        });
        return phys;
    }

    function derived(phys, tEnd) {
        var mp = toModelParams(phys);
        var out = {};
        if (!scale) {
            out.k = phys.k; out.kh = phys.k * W.h;
            if (hasCd) { out.C = phys.C; out.Cd = mp.params.Cd; }
            if (skinKey) out.S = phys.S;
            if (refKey) out[refKey] = phys[refKey];
            if (_pos(tEnd)) out.rinv = Math.sqrt(phys.k * tEnd / (948 * W.phi * W.mu * W.ct));
            out.pi = _num(phys.pi) ? phys.pi : (_pos(well.pi) ? well.pi : null);
        } else {
            var known = _pos(well.q) && _pos(well.B) && _pos(well.mu);
            out.kh = known ? 141.2 * well.q * well.B * well.mu / phys.A : null;
            out.k = (out.kh && _pos(well.h)) ? out.kh / well.h : null;
            out.C = (out.kh && hasCd) ? 0.0002951 * out.kh / (well.mu * phys.T) : null;
            out.Cd = null; out.S = null;
            if (_num(phys.CDe2S)) out.CDe2S = phys.CDe2S;
            out.pi = _pos(well.pi) ? well.pi : null;
        }
        var dist = {};
        DISTANCE_KEYS.forEach(function (dk3) {
            if (shapeKeys.indexOf(dk3) >= 0 && _num(phys[dk3]) && !scale) dist[dk3] = phys[dk3] * mp.Lref;
        });
        if (Object.keys(dist).length) out.distances_ft = dist;
        out.A = mp.A; out.B = mp.B;
        return out;
    }

    return {
        ok: true, mode: scale ? 'scale' : 'physical', kind: 'pressure',
        keys: keys, spec: spec, frozen: frozen, floatPi: floatPi, skinKey: skinKey,
        toModelParams: toModelParams, dp: dpFn, seed: seed, derived: derived, _local: true
    };
}

// Adapter over the core PM (33) so it exposes the same surface.
function _corePM(modelKey, well, adata, opts) {
    if (typeof G.PRiSM_physicalModel !== 'function') return null;
    var pm;
    try { pm = G.PRiSM_physicalModel(modelKey, well, adata, { floatPi: !!opts.floatPi }); }
    catch (e) { return null; }
    if (!pm || !pm.ok || typeof pm.dp !== 'function' || !Array.isArray(pm.keys)) return null;
    var entry = (G.PRiSM_MODELS || {})[modelKey] || {};
    var frozen = {};
    var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : (RACE_FREEZE_FALLBACK[modelKey] || []);
    df.forEach(function (k) { frozen[k] = true; });
    if (opts.freeze) for (var fz in opts.freeze) if (opts.freeze[fz]) frozen[fz] = true;
    var spec = {};
    pm.keys.forEach(function (k) {
        var s = (pm.spec && pm.spec[k]) || {};
        var lg = s.scale === 'log';
        var lo = _num(s.min) ? s.min : (lg ? 1e-6 : -1e3), hi = _num(s.max) ? s.max : (lg ? 1e6 : 1e3);
        if (lg && !(lo > 0)) lo = 1e-12;
        spec[k] = { min: lo, max: hi, scale: lg ? 'log' : 'lin', unit: s.unit || '', default: s.default };
    });
    return {
        ok: true, mode: pm.mode || 'physical', kind: 'pressure', keys: pm.keys.slice(), spec: spec,
        frozen: frozen, floatPi: pm.keys.indexOf('pi') >= 0, skinKey: _num((entry.defaults || {}).S) ? 'S' : 'S_perf',
        toModelParams: function (phys) { return pm.toModelParams(phys); },
        dp: function (t, phys) { return pm.dp(t, phys); },
        seed: function () {
            var s = (typeof pm.seed === 'function') ? (pm.seed() || {}) : {};
            pm.keys.forEach(function (k) {
                var sp = spec[k];
                if (!_num(s[k])) s[k] = _num(sp.default) ? sp.default : (sp.scale === 'log' ? Math.sqrt(sp.min * sp.max) : 0.5 * (sp.min + sp.max));
                s[k] = Math.min(sp.max, Math.max(sp.min, s[k]));
            });
            return s;
        },
        derived: function (phys, tEnd) {
            var d = (typeof pm.derived === 'function') ? (pm.derived(phys) || {}) : {};
            var mp = pm.toModelParams(phys) || {};
            if (!_num(d.A)) d.A = mp.A;
            if (!_num(d.B)) d.B = mp.B;
            return d;
        },
        _core: true
    };
}


// =========================================================================
// SECTION 5 — CANDIDATE FITTER (normalised LM on the physical keys)
// =========================================================================
//
// Every free key is mapped affinely onto u ∈ [1, 2] (log10 for log keys), so
// the forward-difference Jacobian step is well scaled whatever PRiSM_lm's
// step rule. The LM sees data.p = 0 and a model that returns −residuals,
// which lets pi float (the Δp target moves with pi).
//
// Objective 'dp+deriv' (default): [ln Δp_d − ln Δp_m] ∪ [ln Δp'_d − ln Δp'_m],
// each block weighted 0.5 of the total. Δp' is computed with the SAME
// Bourdet operator for data and model. 'dp' uses linear psi residuals.
// AIC = N ln(max(SSR, N·ε²)/N) + 2p on that identical vector (ε = gauge floor).

var LOG_FLOOR = 1e-4;       // log-residual resolution floor for AIC
var RATE_LOG_FLOOR = 1e-6;

function _tr(v, isLog) { return isLog ? Math.log(v) / Math.LN10 : v; }
function _itr(v, isLog) { return isLog ? Math.pow(10, v) : v; }

function _decimate(adata, maxN) {
    var n = adata.t.length;
    if (n <= maxN) return null;
    var lo = Math.log10(adata.t[0]), hi = Math.log10(adata.t[n - 1]);
    var step = (hi - lo) / (maxN - 1);
    var keep = [], last = -1;
    for (var i = 0; i < n; i++) {
        var cell = Math.floor((Math.log10(adata.t[i]) - lo) / Math.max(step, 1e-12));
        if (cell !== last) { keep.push(i); last = cell; }
    }
    if (keep[keep.length - 1] !== n - 1) keep.push(n - 1);
    return keep;
}

function _buildWork(adata, opts) {
    var idx = null;
    var maxN = opts.maxPoints || 240;
    var keep = _decimate(adata, maxN);
    var n = adata.t.length;
    idx = keep || (function () { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; })();
    var pick = function (arr) { return arr ? idx.map(function (i) { return arr[i]; }) : null; };
    var w = {
        t: pick(adata.t), p: pick(adata.p), dp: pick(adata.dp),
        x: pick(adata.x && adata.x.length === n ? adata.x : adata.t),
        L: _num(adata.L) ? adata.L : 0.15, decimated: !!keep
    };
    w.deriv = _bourdet(w.x, w.dp, w.L);
    var tmin = (opts.window && _num(opts.window.tmin)) ? opts.window.tmin : -Infinity;
    var tmax = (opts.window && _num(opts.window.tmax)) ? opts.window.tmax : Infinity;
    w.dpIdx = []; w.dvIdx = [];
    for (var j = 0; j < w.t.length; j++) {
        if (w.t[j] < tmin || w.t[j] > tmax) continue;
        if (_pos(w.dp[j])) w.dpIdx.push(j);
        if (_pos(w.deriv[j])) w.dvIdx.push(j);
    }
    w.window = { tmin: _num(tmin) ? tmin : w.t[0], tmax: _num(tmax) ? tmax : w.t[w.t.length - 1] };
    return w;
}

function _targetDp(work, phys, pm, adata) {
    if (!pm.floatPi || !_num(phys.pi)) return work.dp;
    var inj = adata.testType === 'injection';
    return work.p.map(function (pv) { return inj ? pv - phys.pi : phys.pi - pv; });
}

function _residuals(work, phys, pm, adata, objective) {
    var mp = pm.dp(work.t, phys);
    var dpD = _targetDp(work, phys, pm, adata);
    var out = [];
    var nDp = work.dpIdx.length, nDv = (objective === 'dp') ? 0 : work.dvIdx.length;
    var N = nDp + nDv;
    if (objective === 'dp') {
        for (var a = 0; a < nDp; a++) {
            var ia = work.dpIdx[a];
            var m = mp[ia];
            out.push(_num(m) ? (dpD[ia] - m) : 1e6);
        }
        return { r: out, mp: mp };
    }
    var wDp = Math.sqrt(0.5 * N / Math.max(1, nDp));
    var wDv = Math.sqrt(0.5 * N / Math.max(1, nDv));
    for (var i = 0; i < nDp; i++) {
        var ii = work.dpIdx[i];
        var md = mp[ii], dd = dpD[ii];
        if (!(dd > 0)) { out.push(5 * wDp); continue; }
        out.push(((_pos(md)) ? (Math.log(dd) - Math.log(md)) : 7) * wDp);
    }
    if (nDv) {
        var mder = _bourdet(work.x, mp, work.L);
        for (var j = 0; j < nDv; j++) {
            var jj = work.dvIdx[j];
            var mdv = mder[jj];
            out.push(((_pos(mdv)) ? (Math.log(work.deriv[jj]) - Math.log(mdv)) : 7) * wDv);
        }
    }
    return { r: out, mp: mp };
}

function _ssr(r) { var s = 0; for (var i = 0; i < r.length; i++) s += r[i] * r[i]; return s; }

function _fitWithPM(modelKey, pm, adata, work, opts) {
    var objective = opts.objective || 'dp+deriv';
    var maxIter = opts.maxIter || 40;
    var free = pm.keys.filter(function (k) { return !pm.frozen[k]; });
    var seed0 = pm.seed(work);
    if (typeof G.PRiSM_lm !== 'function') throw new Error('Regression engine (PRiSM_lm) not loaded');

    function enc(phys) {
        var u = {};
        free.forEach(function (k) {
            var s = pm.spec[k], lg = s.scale === 'log';
            var lo = _tr(s.min, lg), hi = _tr(s.max, lg);
            u['u_' + k] = 1 + (_tr(Math.min(s.max, Math.max(s.min, phys[k])), lg) - lo) / (hi - lo);
        });
        return u;
    }
    function dec(u, base) {
        var phys = {};
        for (var b in base) phys[b] = base[b];
        free.forEach(function (k) {
            var s = pm.spec[k], lg = s.scale === 'log';
            var lo = _tr(s.min, lg), hi = _tr(s.max, lg);
            phys[k] = _itr(lo + (u['u_' + k] - 1) * (hi - lo), lg);
        });
        return phys;
    }

    var nRes = _residuals(work, seed0, pm, adata, objective).r.length;
    var tIdx = [], zeros = [];
    for (var z = 0; z < nRes; z++) { tIdx.push(z); zeros.push(0); }
    var bounds = {};
    free.forEach(function (k) { bounds['u_' + k] = [1, 2]; });

    function runFrom(start) {
        var modelFn = function (tArr, up) {
            var phys = dec(up, start);
            var r;
            try { r = _residuals(work, phys, pm, adata, objective).r; }
            catch (e) { r = zeros.map(function () { return 1e3; }); }
            return r.map(function (v) { return _num(v) ? -v : -1e3; });
        };
        var lm = G.PRiSM_lm(modelFn, { t: tIdx, p: zeros }, enc(start), bounds, {},
                            { maxIter: maxIter, tolerance: opts.tolerance || 1e-6, weightingMode: 'uniform' });
        var phys = dec(lm.params, start);
        var ssr = _ssr(_residuals(work, phys, pm, adata, objective).r);
        return { lm: lm, phys: phys, ssr: ssr };
    }

    var best = runFrom(seed0);
    // Extra starts on skin when the first fit is not clean (C3 / WP2 2.2).
    if (free.indexOf('S') >= 0 && (best.lm.iterations >= maxIter || !(best.ssr < 1e-3 * nRes))) {
        [2, -2].forEach(function (dS) {
            var st2 = _clone(seed0);
            st2.S = Math.min(pm.spec.S.max, Math.max(pm.spec.S.min, seed0.S + dS));
            try {
                var alt = runFrom(st2);
                if (alt.ssr < best.ssr) best = alt;
            } catch (e) { /* keep best */ }
        });
    }
    return _assemblePressureRow(modelKey, pm, adata, work, best, free, maxIter, objective, opts);
}

function _tQuantile(dof) { return 1.96 + 2.4 / Math.max(1, dof); }

function _assemblePressureRow(modelKey, pm, adata, work, best, free, maxIter, objective, opts) {
    var lm = best.lm, phys = best.phys;
    var res = _residuals(work, phys, pm, adata, objective);
    var N = res.r.length, p = free.length;
    var ssr = _ssr(res.r);
    var floor = (objective === 'dp') ? 0.01 : LOG_FLOOR;
    var aic = N * Math.log(Math.max(ssr, N * floor * floor) / N) + 2 * p;

    // Linear Δp statistics (psi) inside the window.
    var dpD = _targetDp(work, phys, pm, adata);
    var mean = 0, cnt = 0;
    work.dpIdx.forEach(function (i) { mean += dpD[i]; cnt++; });
    mean /= Math.max(1, cnt);
    var ssT = 0, ssR = 0;
    work.dpIdx.forEach(function (i) {
        var e = dpD[i] - res.mp[i]; ssR += e * e;
        var d = dpD[i] - mean; ssT += d * d;
    });
    var r2 = ssT > 0 ? 1 - ssR / ssT : NaN;
    var rmse = Math.sqrt(ssR / Math.max(1, cnt));

    // CIs: u-space stderr → physical.
    var dof = Math.max(1, N - p), tq = _tQuantile(dof);
    var ci95 = {}, stderr = {}, identifiable = {};
    free.forEach(function (k) {
        var s = pm.spec[k], lg = s.scale === 'log';
        var seU = lm.stderr ? lm.stderr['u_' + k] : NaN;
        var span = _tr(s.max, lg) - _tr(s.min, lg);
        var se = _num(seU) ? seU * span : NaN;
        var v = phys[k];
        if (_num(se)) {
            if (lg) {
                var lv = _tr(v, true);
                ci95[k] = [Math.pow(10, lv - tq * se), Math.pow(10, lv + tq * se)];
                stderr[k] = v * se * Math.LN10;
            } else {
                ci95[k] = [v - tq * se, v + tq * se];
                stderr[k] = se;
            }
        } else { ci95[k] = [NaN, NaN]; stderr[k] = NaN; }
        var uVal = 1 + (_tr(v, lg) - _tr(s.min, lg)) / span;
        var atBound = uVal < 1 + 1e-3 || uVal > 2 - 1e-3;
        var wide;
        if (!_num(se)) wide = true;
        else if (lg) wide = tq * se > 0.5;                                  // > ±half a decade
        else wide = tq * se > Math.max(Math.abs(v), 1);
        identifiable[k] = !(atBound || wide);
    });
    var corr = null;
    if (lm.covariance && Array.isArray(lm.freeKeys)) {
        var cv = lm.covariance, fk = lm.freeKeys.map(function (x) { return String(x).replace(/^u_/, ''); });
        corr = cv.map(function (row, a) {
            return row.map(function (c, b) {
                var den = Math.sqrt(Math.abs(cv[a][a] * cv[b][b]));
                return den > 0 ? c / den : NaN;
            });
        });
        for (var a2 = 0; a2 < fk.length; a2++) for (var b2 = 0; b2 < fk.length; b2++) {
            if (a2 !== b2 && Math.abs(corr[a2][b2]) > 0.98) identifiable[fk[a2]] = false;
        }
        corr = { keys: fk, matrix: corr };
    }

    var mp = pm.toModelParams(phys);
    var params = {};
    for (var pk in mp.params) if (pk.indexOf('__') !== 0) params[pk] = mp.params[pk];
    var tEnd = work.t[work.t.length - 1];
    var physOut = pm.derived(phys, tEnd) || {};
    // Shape parameters stay dimensionless in params; derived CIs.
    if (ci95.C && _num(physOut.C) && _num(physOut.Cd) && physOut.C > 0) {
        var f = physOut.Cd / physOut.C;
        ci95.Cd = [ci95.C[0] * f, ci95.C[1] * f];
        identifiable.Cd = identifiable.C;
    }
    if (ci95.k && _num(physOut.kh) && _num(physOut.k) && physOut.k > 0) {
        var hh = physOut.kh / physOut.k;
        ci95.kh = [ci95.k[0] * hh, ci95.k[1] * hh];
    }
    var warnings = [];
    if (pm.mode === 'scale') {
        warnings.push('Well inputs incomplete — skin is not identifiable without φ·ct·rw²; kh and C are reported from the fit scales.');
    }
    if (adata.pRefSource && adata.pRefSource !== 'pi' && adata.pRefSource !== 'pwf0' && !pm.floatPi &&
        (adata.testType === 'drawdown' || adata.testType === 'injection')) {
        warnings.push('Δp reference is ' + adata.pRefSource + ' (no pi) — skin is biased.');
    }
    var unresolved = Object.keys(identifiable).filter(function (k) { return identifiable[k] === false; });
    if (unresolved.length) warnings.push('Not resolved by the data: ' + unresolved.join(', ') + '.');
    var converged = !!(lm.converged || lm.iterations < maxIter) && isFinite(ssr);

    var row = {
        modelKey: modelKey, model: modelKey, modelName: PRiSM_modelPlainName(modelKey),
        kind: 'pressure', source: 'automatch', mode: pm.mode,
        params: params, phys: physOut,
        fitted: _clone(phys),
        ci95: ci95, stderr: stderr, corr: corr, identifiable: identifiable,
        r2: r2, rmse: rmse, aic: aic, ssr: ssr, nObs: N, nFree: p,
        iterations: lm.iterations, converged: converged,
        objective: objective, window: _clone(work.window),
        scales: { A: mp.A, B: mp.B },
        pRef: _num(phys.pi) && pm.floatPi ? phys.pi : adata.pRef,
        pRefSource: pm.floatPi ? 'floated' : adata.pRefSource,
        timestamp: new Date().toISOString(),
        warnings: warnings,
        engine: pm._core ? 'core-model' : 'local'
    };
    if (typeof G.PRiSM_datasetHash === 'function') {
        try { row.datasetHash = G.PRiSM_datasetHash(G.PRiSM_dataset); } catch (e) { /* ignore */ }
    }
    return row;
}

// Normalise a C4 object returned by the regression engine (05).
function _normaliseEngineRow(modelKey, fit) {
    var row = _clone(fit) || {};
    row.modelKey = row.modelKey || row.model || modelKey;
    row.model = row.modelKey;
    row.modelName = PRiSM_modelPlainName(row.modelKey);
    if (!_num(row.r2) && _num(row.R2)) row.r2 = row.R2;
    if (!_num(row.rmse) && _num(row.RMSE)) row.rmse = row.RMSE;
    if (!_num(row.aic) && _num(row.AIC)) row.aic = row.AIC;
    if (!row.ci95 && row.CI95) row.ci95 = row.CI95;
    row.kind = row.kind || 'pressure';
    row.source = 'automatch';
    row.converged = !!row.converged;
    row.warnings = Array.isArray(row.warnings) ? row.warnings : [];
    row.engine = 'core-fit';
    return row;
}


// =========================================================================
// SECTION 6 — RATE (DECLINE) FITTER
// =========================================================================

function _rateSeries(ds) {
    var t = _toArr(ds && ds.t), q = _toArr(ds && ds.q);
    if (!t || !q || t.length !== q.length) return null;
    var unit = String((ds && ds.timeUnit) || 'h').toLowerCase();
    var toDays = (unit === 'd' || unit === 'day' || unit === 'days') ? 1 : 1 / 24;
    var td = [], qq = [];
    for (var i = 0; i < t.length; i++) {
        if (!(t[i] > 0) || !_pos(q[i])) continue;
        td.push(t[i] * toDays); qq.push(q[i]);
    }
    return td.length >= 4 ? { t: td, q: qq } : null;
}

function _rateVaries(ds) {
    var q = _toArr(ds && ds.q);
    if (!q || q.length < 8) return false;
    var vals = [], nz = 0;
    for (var i = 0; i < q.length; i++) { var v = q[i]; if (_pos(v)) { nz++; vals.push(v); } else vals.push(0); }
    if (nz <= 0.5 * q.length) return false;
    var nq = Math.max(2, Math.floor(vals.length / 4)), early = 0, late = 0;
    for (var e = 0; e < nq; e++) early += vals[e];
    for (var l = vals.length - nq; l < vals.length; l++) late += vals[l];
    early /= nq; late /= nq;
    return early > 0 && late < 0.85 * early;
}

function _fitRateLocal(modelKey, series, opts) {
    var entry = (G.PRiSM_MODELS || {})[modelKey];
    if (!entry || typeof entry.pd !== 'function') throw new Error('No evaluator for ' + modelKey);
    if (typeof G.PRiSM_lm !== 'function') throw new Error('Regression engine (PRiSM_lm) not loaded');
    var defaults = entry.defaults || {};
    var t = series.t, q = series.q, n = t.length;
    var qMax = Math.max.apply(null, q);
    var Di0 = Math.log(q[0] / q[n - 1]) / Math.max(1e-9, t[n - 1] - t[0]);
    if (!(Di0 > 0)) Di0 = 0.01;
    var seed = {}, spec = {}, keys = [], fixed = {};
    for (var k in defaults) {
        if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
        if (typeof defaults[k] !== 'number') { fixed[k] = defaults[k]; continue; }
        var sp = _specOf(entry, k) || {};
        var lo = _num(sp.min) ? sp.min : 0, hi = _num(sp.max) ? sp.max : 1e6, lg = false, s0 = defaults[k];
        if (k === 'qi' || k === 'q1') { lo = qMax / 20; hi = qMax * 20; lg = true; s0 = (k === 'qi') ? q[0] * Math.exp(Di0 * t[0]) : q[0]; }
        else if (k === 'Di') { lo = 1e-6; hi = Math.max(5, Di0 * 100); lg = true; s0 = Di0; }
        else if (k === 'tau') { lo = Math.max(1e-3, _num(sp.min) ? sp.min : 1e-3); hi = Math.max(1e6, hi); lg = true; s0 = 1 / Di0; }
        else if (k === 'reD') { lg = true; lo = Math.max(1, lo); }
        else if (k === 'b') { lo = 0; hi = _num(sp.max) ? sp.max : 2; s0 = 0.5; }
        s0 = Math.min(hi, Math.max(lo, s0));
        keys.push(k); spec[k] = { min: lo, max: hi, scale: lg ? 'log' : 'lin' }; seed[k] = s0;
    }
    var freeze = {};
    if (opts.freeze) for (var f in opts.freeze) if (opts.freeze[f]) freeze[f] = true;
    var free = keys.filter(function (kk) { return !freeze[kk]; });
    function dec(u) {
        var p = {};
        for (var fx in fixed) p[fx] = fixed[fx];
        keys.forEach(function (kk) { p[kk] = seed[kk]; });
        free.forEach(function (kk) {
            var s = spec[kk], lg = s.scale === 'log', lo = _tr(s.min, lg), hi = _tr(s.max, lg);
            p[kk] = _itr(lo + (u['u_' + kk] - 1) * (hi - lo), lg);
        });
        return p;
    }
    var u0 = {}, bounds = {};
    free.forEach(function (kk) {
        var s = spec[kk], lg = s.scale === 'log', lo = _tr(s.min, lg), hi = _tr(s.max, lg);
        u0['u_' + kk] = 1 + (_tr(seed[kk], lg) - lo) / (hi - lo);
        bounds['u_' + kk] = [1, 2];
    });
    function resid(p) {
        var qm;
        try { qm = entry.pd(t, p); } catch (e) { qm = null; }
        return t.map(function (_, i) {
            var m = qm ? qm[i] : NaN;
            return _pos(m) ? Math.log(q[i]) - Math.log(m) : 7;
        });
    }
    var zeros = t.map(function () { return 0; });
    var idx = t.map(function (_, i) { return i; });
    var maxIter = opts.maxIter || 60;
    var lm = G.PRiSM_lm(function (_t, up) { return resid(dec(up)).map(function (v) { return -v; }); },
                        { t: idx, p: zeros }, u0, bounds, {}, { maxIter: maxIter, tolerance: 1e-9, weightingMode: 'uniform' });
    var params = dec(lm.params);
    var r = resid(params), ssr = _ssr(r), N = r.length, p = free.length;
    var aic = N * Math.log(Math.max(ssr, N * RATE_LOG_FLOOR * RATE_LOG_FLOOR) / N) + 2 * p;
    var qm2 = entry.pd(t, params), mq = _mean(q), ssT = 0, ssR = 0;
    q.forEach(function (v, i) { ssT += (v - mq) * (v - mq); ssR += (v - qm2[i]) * (v - qm2[i]); });
    var dof = Math.max(1, N - p), tq = _tQuantile(dof), ci95 = {}, stderr = {}, identifiable = {};
    free.forEach(function (kk) {
        var s = spec[kk], lg = s.scale === 'log', span = _tr(s.max, lg) - _tr(s.min, lg);
        var seU = lm.stderr ? lm.stderr['u_' + kk] : NaN, se = _num(seU) ? seU * span : NaN, v = params[kk];
        if (_num(se)) {
            ci95[kk] = lg ? [Math.pow(10, _tr(v, true) - tq * se), Math.pow(10, _tr(v, true) + tq * se)] : [v - tq * se, v + tq * se];
            stderr[kk] = lg ? v * se * Math.LN10 : se;
            identifiable[kk] = lg ? tq * se < 0.5 : tq * se < Math.max(Math.abs(v), 0.1);
        } else { ci95[kk] = [NaN, NaN]; stderr[kk] = NaN; identifiable[kk] = false; }
    });
    var physOut = {};
    keys.forEach(function (kk) { physOut[kk] = params[kk]; });
    physOut.timeUnit = 'd';
    if (typeof entry.eur === 'function') {
        try { physOut.eurAtEnd = entry.eur(t[t.length - 1], params); } catch (e) { /* optional */ }
    }
    return {
        modelKey: modelKey, model: modelKey, modelName: PRiSM_modelPlainName(modelKey),
        kind: 'rate', source: 'automatch', mode: 'rate',
        params: params, phys: physOut, ci95: ci95, stderr: stderr, identifiable: identifiable,
        r2: ssT > 0 ? 1 - ssR / ssT : NaN, rmse: Math.sqrt(ssR / N), aic: aic, ssr: ssr,
        nObs: N, nFree: p, iterations: lm.iterations,
        converged: !!(lm.converged || lm.iterations < maxIter),
        objective: 'ln q', window: { tmin: t[0] * 24, tmax: t[t.length - 1] * 24 },
        timestamp: new Date().toISOString(), warnings: [], engine: 'local'
    };
}

function _raceRate(ds, candidates, opts, useCore, failed) {
    var series = _rateSeries(ds);
    if (!series) return [];
    var rows = [];
    candidates.forEach(function (key) {
        try {
            var row;
            if (useCore && typeof G.PRiSM_fitRate === 'function' && opts.engine !== 'local') {
                row = _normaliseEngineRow(key, G.PRiSM_fitRate(key, ds, { maxIter: opts.maxIter || 60 }));
                row.kind = 'rate';
            } else {
                row = _fitRateLocal(key, series, opts);
            }
            if (!_num(row.aic)) throw new Error('fit returned no AIC');
            rows.push(row);
        } catch (e) {
            failed.push({ modelKey: key, modelName: PRiSM_modelPlainName(key), error: String(e && e.message || e) });
        }
    });
    return rows;
}


// =========================================================================
// SECTION 7 — ORCHESTRATOR
// =========================================================================

// Parsimony: AIC differences under 2 are not meaningful evidence. When the
// AIC leader carries a parameter the data cannot determine (identifiable[k]
// === false, e.g. a tiny fracture half-length collinear with skin) and a
// converged alternative within ΔAIC < 2 has none, the simpler, fully
// determined model leads. Shared with ▶ Analyse (37) so both rank alike.
function _hasUndetermined(r) {
    var id = r && r.identifiable;
    if (!id) return false;
    for (var k in id) if (Object.prototype.hasOwnProperty.call(id, k) && id[k] === false) return true;
    return false;
}
function PRiSM_rankCandidates(rows, aicOf) {
    aicOf = aicOf || function (r) { return r.aic; };
    rows.sort(function (a, b) {
        var d = aicOf(a) - aicOf(b);
        if (d !== 0 && !isNaN(d)) return d;
        return (b.r2 || -Infinity) - (a.r2 || -Infinity);
    });
    if (rows.length > 1 && _hasUndetermined(rows[0])) {
        for (var j = 1; j < rows.length; j++) {
            if (!(aicOf(rows[j]) - aicOf(rows[0]) < 2)) break;
            if (rows[j].converged !== false && !_hasUndetermined(rows[j])) {
                var pick = rows.splice(j, 1)[0];
                pick.parsimony = true;
                rows.unshift(pick);
                break;
            }
        }
    }
    return rows;
}
window.PRiSM_rankCandidates = PRiSM_rankCandidates;

function _rankRows(rows) {
    PRiSM_rankCandidates(rows);
    var best = rows.length ? Math.min.apply(null, rows.map(function (r) { return r.aic; })) : NaN;
    var wsum = 0;
    rows.forEach(function (r, i) {
        r.rank = i + 1;
        r.dAIC = r.aic - best;
        r.akaikeWeight = Math.exp(-0.5 * r.dAIC);
        wsum += r.akaikeWeight;
    });
    rows.forEach(function (r) {
        r.akaikeWeight = wsum > 0 ? r.akaikeWeight / wsum : NaN;
        if (!r.converged) { r.status = 'refine'; r.label = 'Starting point — refine'; }
        else if (r.rank === 1) { r.status = 'best'; r.label = r.parsimony ? 'Best fit — simplest equivalent model' : 'Best fit'; }
        else { r.status = 'alternative'; r.label = 'Alternative'; }
        // ΔAIC relative to the next-ranked row, used by the interpretation cautions.
    });
    for (var i = 0; i < rows.length; i++) {
        if (i === 0 && rows.length > 1) { rows[i].dAICnext = Math.abs(rows[1].aic - rows[0].aic); rows[i].secondModelKey = rows[1].modelKey; }
    }
    return rows;
}

function _resolveMode(ds, opts) {
    if (opts.mode) return opts.mode;
    var p = _toArr(ds && ds.p);
    var hasP = p && p.some(function (v) { return _num(v); });
    if (!hasP) return 'decline';
    var st = G.PRiSM_state;
    if (st && (st.mode === 'decline' || st.mode === 'combined' || st.mode === 'transient')) return st.mode;
    return 'transient';
}

function _pressureCandidates(opts, classification) {
    var registry = G.PRiSM_MODELS || {};
    var list;
    if (Array.isArray(opts.candidates) && opts.candidates.length) {
        list = opts.candidates.slice();
    } else {
        list = classification.candidates.slice();
        var minN = opts.minCandidates || MIN_PRESSURE_CANDIDATES;
        for (var i = 0; i < DEFAULT_CANDIDATES.length && list.length < minN; i++) {
            if (list.indexOf(DEFAULT_CANDIDATES[i]) === -1) list.push(DEFAULT_CANDIDATES[i]);
        }
    }
    // The infinite-conductivity fracture (cheap) is raced just before the
    // finite-conductivity ones: it is their FcD → ∞ limit and warm-starts
    // their (slow) fits. Added after the padding so it never displaces a
    // default candidate.
    if (!(Array.isArray(opts.candidates) && opts.candidates.length) && list.indexOf('infiniteFrac') === -1) {
        var iff = -1;
        for (var j = 0; j < list.length; j++) if (list[j] === 'finiteFrac' || list[j] === 'finiteFracSkin') { iff = j; break; }
        if (iff >= 0) list.splice(iff, 0, 'infiniteFrac');
    }
    list = list.filter(function (k, i) {
        return registry[k] && registry[k].kind !== 'rate' && list.indexOf(k) === i;
    });
    var cap = Math.max(1, Math.min(MAX_PRESSURE_CANDIDATES, opts.maxCandidates || MAX_PRESSURE_CANDIDATES));
    return list.slice(0, cap);
}

// Prepare everything the race needs; returns a context or an error result.
function _prepare(opts) {
    opts = opts || {};
    var useCore = opts.useCore !== false;
    var ds = opts.dataset || G.PRiSM_dataset;
    var t0 = _now();
    var ctx = { opts: opts, useCore: useCore, ds: ds, t0: t0, failed: [], warnings: [] };
    if (!ds || !_toArr(ds.t) || _toArr(ds.t).length < 4) {
        ctx.error = 'No usable dataset — load data on step ① first (need at least 4 samples).';
        return ctx;
    }
    ctx.mode = _resolveMode(ds, opts);
    ctx.runPressure = ctx.mode !== 'decline';
    ctx.runRate = (ctx.mode === 'decline') || (ctx.mode === 'combined' && _rateVaries(ds));
    if (Array.isArray(opts.candidates) && opts.candidates.length) {
        var reg = G.PRiSM_MODELS || {};
        var anyRate = opts.candidates.some(function (k) { return reg[k] && reg[k].kind === 'rate'; });
        var anyP = opts.candidates.some(function (k) { return reg[k] && reg[k].kind !== 'rate'; });
        if (anyRate && _rateSeries(ds)) ctx.runRate = true;
        if (!anyP) ctx.runPressure = false;
    }
    if (ctx.runPressure) {
        ctx.well = _resolveWell(ds, opts, useCore);
        ctx.adata = _resolveAdata(ds, ctx.well, opts, useCore);
        if (!ctx.adata || !ctx.adata.ok) {
            ctx.runPressure = false;
            ctx.warnings.push('Pressure analysis unavailable: ' + ((ctx.adata && ctx.adata.reason) || 'no analysis data') + '.');
        } else {
            var derivForClass = _toArr(ctx.adata.deriv);
            ctx.classification = PRiSM_classifyRegimes(_toArr(ctx.adata.t), _toArr(ctx.adata.dp), derivForClass);
            ctx.work = _buildWork(ctx.adata, opts);
            ctx.floatPi = (opts.floatPi != null) ? !!opts.floatPi
                : !(ctx.adata.pRefSource === 'pi' || ctx.adata.pRefSource === 'pwf0' ||
                    ctx.adata.testType === 'buildup' || ctx.adata.testType === 'falloff');
            ctx.candidates = _pressureCandidates(opts, ctx.classification);
            (ctx.adata.warnings || []).forEach(function (w) { ctx.warnings.push(w); });
        }
    }
    if (!ctx.classification) ctx.classification = { regimes: [], candidates: [], summary: ctx.runRate ? 'Rate-decline data.' : '' };
    if (ctx.runRate) {
        var rc = DECLINE_CANDIDATES.slice();
        if (Array.isArray(opts.candidates) && opts.candidates.length) {
            var reg2 = G.PRiSM_MODELS || {};
            var picked = opts.candidates.filter(function (k) { return reg2[k] && reg2[k].kind === 'rate'; });
            if (picked.length) rc = picked;
        }
        ctx.rateCandidates = rc.filter(function (k) { return !!(G.PRiSM_MODELS || {})[k]; });
    }
    if (!ctx.runPressure && !ctx.runRate) {
        ctx.error = ctx.warnings.length ? ctx.warnings.join(' ') : 'Nothing to fit for this dataset and mode.';
    }
    return ctx;
}

function _fitPressureCandidate(ctx, key) {
    var opts = ctx.opts;
    var fOpts = { maxIter: opts.maxIter || 40, objective: opts.objective || 'dp+deriv', window: opts.window,
                  floatPi: ctx.floatPi, freeze: opts.freeze, classification: ctx.classification,
                  forceScale: opts.forceScale, maxPoints: opts.maxPoints };
    var entry = (G.PRiSM_MODELS || {})[key] || {};
    if (ctx.useCore && opts.engine !== 'local' && typeof G.PRiSM_fitPhysical === 'function') {
        var frz = {};
        var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : (RACE_FREEZE_FALLBACK[key] || []);
        df.forEach(function (k) { frz[k] = true; });
        if (opts.freeze) for (var f in opts.freeze) if (opts.freeze[f]) frz[f] = true;
        // Finite-conductivity fractures start from the infinite-conductivity
        // result when it was raced (same k, C, S, xf; FcD from a high value).
        var warm = null, inf = ctx.rowsByKey && ctx.rowsByKey.infiniteFrac;
        if ((key === 'finiteFrac' || key === 'finiteFracSkin') && inf && inf.phys && _num(inf.phys.k) && _num(inf.phys.xf)) {
            warm = { k: inf.phys.k, xf: inf.phys.xf, FcD: 100 };
            if (_num(inf.phys.C)) warm.C = inf.phys.C;
            if (_num(inf.phys.S)) warm.S = inf.phys.S;
            if (_num(inf.phys.pi) && ctx.floatPi) warm.pi = inf.phys.pi;
        }
        var fit = G.PRiSM_fitPhysical(key, ctx.adata, ctx.well,
            { maxIter: fOpts.maxIter, objective: fOpts.objective, window: opts.window, freeze: frz,
              floatPi: ctx.floatPi, race: true, start: warm || undefined });
        if (!fit || fit.ok === false) throw new Error((fit && (fit.reason || fit.error)) || 'fit failed');
        var row = _normaliseEngineRow(key, fit);
        if (!_num(row.aic)) throw new Error('fit returned no AIC');
        return row;
    }
    var pm = (ctx.useCore && opts.engine !== 'local') ? _corePM(key, ctx.well, ctx.adata, fOpts) : null;
    if (!pm) pm = _localPM(key, ctx.well, ctx.adata, fOpts);
    if (!pm || !pm.ok) throw new Error((pm && pm.reason) || 'physical model unavailable');
    return _fitWithPM(key, pm, ctx.adata, ctx.work, fOpts);
}

function _finish(ctx, pRows, rRows) {
    var opts = ctx.opts;
    var topN = Math.max(1, Math.min(8, opts.topN || 5));
    _rankRows(pRows); _rankRows(rRows);
    var primaryKind = ctx.runPressure && pRows.length ? 'pressure' : 'rate';
    var primary = primaryKind === 'pressure' ? pRows : rRows;
    var ranked = primary.slice(0, topN);
    var firstConv = null;
    for (var i = 0; i < ranked.length; i++) if (ranked[i].converged) { firstConv = ranked[i]; break; }
    var elapsed = _now() - ctx.t0;
    var result = {
        ok: ranked.length > 0,
        kind: primaryKind, mode: ctx.mode,
        ranked: ranked, top: ranked.slice(0, 3), candidates: ranked.slice(0, 3),
        bestKey: firstConv ? firstConv.modelKey : null,
        recommendedKey: ranked.length ? ranked[0].modelKey : null,
        bestConverged: !!(ranked[0] && ranked[0].converged),
        deltaAIC: ranked.map(function (r) { return r.dAIC; }),
        decline: (primaryKind === 'pressure' && rRows.length) ? { ranked: rRows.slice(0, topN), top: rRows.slice(0, 3) } : null,
        failed: ctx.failed,
        classification: ctx.classification,
        analysis: ctx.adata ? { n: ctx.adata.n || (ctx.adata.t && ctx.adata.t.length), pRef: ctx.adata.pRef,
                                pRefSource: ctx.adata.pRefSource, testType: ctx.adata.testType,
                                timeFn: ctx.adata.timeFn, warnings: (ctx.adata.warnings || []).slice(),
                                floatPi: !!ctx.floatPi, decimated: !!(ctx.work && ctx.work.decimated) } : null,
        well: ctx.well ? { complete: !!ctx.well.complete, missing: (ctx.well.missing || []).slice(),
                           defaulted: (ctx.well.defaulted || []).slice() } : null,
        elapsedMs: Math.round(elapsed),
        timestamp: new Date().toISOString(),
        warnings: ctx.warnings.slice()
    };
    // Stamp the ranking with the data it was computed on (report / rail ignore
    // a ranking whose hash no longer matches the active dataset).
    if (typeof G.PRiSM_datasetHash === 'function') {
        try { result.datasetHash = G.PRiSM_datasetHash(ctx.ds || G.PRiSM_dataset); } catch (e) { /* ignore */ }
    }
    result.activePeriod = (G.PRiSM_state && G.PRiSM_state.activePeriod != null) ? G.PRiSM_state.activePeriod : null;
    if (!result.ok) result.error = ctx.failed.length ? 'No candidate could be fitted.' : 'No candidates to fit.';
    if (ranked.length && !ranked[0].converged) {
        result.warnings.push('The top-ranked model did not converge — treat it as a starting point and refine it in regression.');
    }
    try {
        if (G.PRiSM_state && typeof G.PRiSM_state === 'object') G.PRiSM_state.autoMatch = result;
    } catch (e) { /* silent */ }
    _dispatch('prism:automatch-updated', { bestKey: result.bestKey, kind: result.kind });
    try {
        if (typeof G.gtag === 'function') {
            G.gtag('event', 'prism_auto_match_run', { event_category: 'PRiSM', best_model: result.bestKey || 'none' });
        }
    } catch (e) { /* silent */ }
    if (opts.apply && result.ok) {
        var toApply = firstConv || (opts.applyUnconverged ? ranked[0] : null);
        if (toApply) PRiSM_applyAutoMatchRow(toApply, result, { quiet: true });
    }
    return result;
}

function _errorResult(ctx) {
    return { ok: false, error: ctx.error, kind: null, mode: ctx.mode || null, ranked: [], top: [], candidates: [],
             bestKey: null, recommendedKey: null, bestConverged: false, deltaAIC: [], decline: null,
             failed: ctx.failed || [], classification: ctx.classification || { regimes: [], candidates: [], summary: ctx.error },
             analysis: null, well: null, elapsedMs: 0, timestamp: new Date().toISOString(), warnings: ctx.warnings || [] };
}

function _raceOnePressure(ctx, key, rows) {
    try {
        var row = _fitPressureCandidate(ctx, key);
        if (!_num(row.aic)) throw new Error('fit produced no finite objective');
        rows.push(row);
        ctx.rowsByKey = ctx.rowsByKey || {};
        ctx.rowsByKey[key] = row;
    } catch (e) {
        ctx.failed.push({ modelKey: key, modelName: PRiSM_modelPlainName(key), error: String(e && e.message || e) });
    }
}

/** Blocking race. See header for the result shape. */
function PRiSM_autoMatchSync(opts) {
    var ctx = _prepare(opts || {});
    if (ctx.error) return _errorResult(ctx);
    if (ctx.opts.classifyOnly) {
        var r0 = _errorResult(ctx); r0.ok = true; r0.error = null; r0.classification = ctx.classification;
        r0.candidateKeys = ctx.candidates || [];
        return r0;
    }
    var pRows = [], rRows = [];
    if (ctx.runPressure) {
        ctx.candidates.forEach(function (key, i) {
            if (typeof ctx.opts.onProgress === 'function') { try { ctx.opts.onProgress(i, ctx.candidates.length, key); } catch (e) {} }
            _raceOnePressure(ctx, key, pRows);
        });
    }
    if (ctx.runRate) rRows = _raceRate(ctx.ds, ctx.rateCandidates, ctx.opts, ctx.useCore, ctx.failed);
    return _finish(ctx, pRows, rRows);
}

/** Race with a yield to the UI between candidates. Resolves with the result. */
function PRiSM_autoMatch(opts) {
    opts = opts || {};
    var ctx;
    try { ctx = _prepare(opts); } catch (e) { return Promise.reject(e); }
    if (ctx.error) return Promise.resolve(_errorResult(ctx));
    if (opts.classifyOnly) return Promise.resolve(PRiSM_autoMatchSync(opts));
    var pRows = [], rRows = [];
    var list = ctx.runPressure ? ctx.candidates.slice() : [];
    var i = 0;
    function _yield() { return new Promise(function (r) { setTimeout(r, 0); }); }
    function _loop() {
        if (i >= list.length) return Promise.resolve();
        // opts.shouldCancel() → stop racing; the models fitted so far are ranked.
        if (typeof opts.shouldCancel === 'function') {
            var stopNow = false;
            try { stopNow = !!opts.shouldCancel(); } catch (e) { stopNow = false; }
            if (stopNow) {
                ctx.warnings.push('Model race cancelled after ' + i + ' of ' + list.length + ' candidates.');
                return Promise.resolve();
            }
        }
        return _yield().then(function () {
            var key = list[i];
            if (typeof opts.onProgress === 'function') { try { opts.onProgress(i, list.length, key); } catch (e) {} }
            _raceOnePressure(ctx, key, pRows);
            i++;
            return _loop();
        });
    }
    return _loop().then(function () {
        if (ctx.runRate) return _yield().then(function () { rRows = _raceRate(ctx.ds, ctx.rateCandidates, opts, ctx.useCore, ctx.failed); });
    }).then(function () { return _finish(ctx, pRows, rRows); });
}


// =========================================================================
// SECTION 8 — APPLY A ROW (propagates everywhere; never writes st.match)
// =========================================================================

function _fmtPhysSummary(row) {
    var ph = row.phys || {};
    if (row.kind === 'rate') {
        var bits = [];
        if (_num(ph.qi)) bits.push('qi ' + _fmt(ph.qi, 4));
        if (_num(ph.Di)) bits.push('Di ' + _fmt(ph.Di, 3) + ' 1/d');
        if (_num(ph.b)) bits.push('b ' + _fmt(ph.b, 3));
        return bits.join(', ');
    }
    var s = [];
    if (_num(ph.k)) s.push('k ' + (ph.k >= 100 ? ph.k.toFixed(0) : ph.k.toFixed(1)) + ' md');
    else if (_num(ph.kh)) s.push('kh ' + _fmt(ph.kh, 3) + ' md·ft');
    if (_num(ph.S)) s.push('S ' + ph.S.toFixed(2));
    if (_num(ph.C)) s.push('C ' + ph.C.toExponential(1) + ' bbl/psi');
    return s.join(', ');
}

function _findRow(rowOrKey, result) {
    if (rowOrKey && typeof rowOrKey === 'object') return rowOrKey;
    var res = result || (G.PRiSM_state && G.PRiSM_state.autoMatch);
    if (!res) return null;
    var lists = [res.ranked || []];
    if (res.decline && res.decline.ranked) lists.push(res.decline.ranked);
    for (var l = 0; l < lists.length; l++) for (var i = 0; i < lists[l].length; i++) {
        if (lists[l][i].modelKey === rowOrKey) return lists[l][i];
    }
    return null;
}

function PRiSM_applyAutoMatchRow(rowOrKey, result, applyOpts) {
    applyOpts = applyOpts || {};
    var row = _findRow(rowOrKey, result);
    if (!row) return null;
    var key = row.modelKey;
    if (!G.PRiSM_state) G.PRiSM_state = { model: key, params: {}, paramFreeze: {}, match: { timeShift: 0, pressShift: 0 } };
    var st = G.PRiSM_state;
    if (typeof G.PRiSM_setModel === 'function') {
        try { G.PRiSM_setModel(key); } catch (e) { st.model = key; }
    } else { st.model = key; }
    st.params = _clone(row.params || {});
    st.phys = _clone(row.phys || {});
    var entry = (G.PRiSM_MODELS || {})[key] || {};
    var frz = {};
    var df = Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : [];
    df.forEach(function (k) { frz[k] = true; });
    st.paramFreeze = frz;
    var fit = _clone(row);
    fit.source = 'automatch';
    fit.model = key;
    if (row.kind !== 'rate' && row.scales && _pos(row.scales.A) && _pos(row.scales.B)) {
        st.tcMatch = { logPM: Math.log10(1 / row.scales.A), logTM: Math.log10(row.scales.B), source: 'automatch' };
    }
    if (typeof G.PRiSM_setLastFit === 'function') {
        try { G.PRiSM_setLastFit(fit); } catch (e) { st.lastFit = fit; }
    } else {
        st.lastFit = fit;
        if (typeof G.PRiSM_interpretCurrentFit === 'function') {
            try { st.interp = G.PRiSM_interpretCurrentFit(); } catch (e) { /* silent */ }
        }
        _dispatch('prism:fit-updated', { source: 'automatch', modelKey: key });
    }
    if (typeof G.PRiSM_evalModelCurve === 'function') {
        try { G.PRiSM_evalModelCurve(key, st.params, { phys: st.phys }); } catch (e) { /* silent */ }
    }
    if (typeof G.PRiSM_drawActivePlot === 'function') {
        try { G.PRiSM_drawActivePlot(); } catch (e) { /* silent */ }
    }
    if (typeof G.PRiSM_saveState === 'function') {
        try { G.PRiSM_saveState(); } catch (e) { /* silent */ }
    }
    var msg = 'Applied ' + PRiSM_modelPlainName(key) + ' — ' + _fmtPhysSummary(row);
    st.autoMatchStatus = msg;
    if (typeof document !== 'undefined' && document.getElementById) {
        var el = document.getElementById('prism_am_status');
        if (el) el.textContent = msg;
    }
    if (!applyOpts.quiet && typeof G.toast === 'function') { try { G.toast(msg, 'success'); } catch (e) {} }
    try {
        if (typeof G.gtag === 'function') G.gtag('event', 'prism_auto_match_apply', { event_category: 'PRiSM', model_key: key });
    } catch (e) { /* silent */ }
    return row;
}


// =========================================================================
// SECTION 9 — PANEL UI ("Recommended models")
// =========================================================================
// Top-3 cards: plain model name, status chip, ΔAIC, R², key physical results
// with ±95 % CI, and a "Use this model" button. Styled with the host theme
// variables; flex-wraps to a single column at phone width.

var PANEL_CSS =
    '.prism-am{display:flex;flex-direction:column;gap:10px;color:var(--text);font-size:13px;min-width:0}' +
    '.prism-am-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '.prism-am-diag{font-size:12px;color:var(--text2);overflow-wrap:anywhere}' +
    '.prism-am-cards{display:flex;flex-wrap:wrap;gap:10px}' +
    '.prism-am-card{flex:1 1 220px;min-width:0;max-width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg2)}' +
    '.prism-am-card--best{border-color:var(--green)}' +
    '.prism-am-card--refine{border-color:var(--yellow)}' +
    '.prism-am-name{font-weight:600;font-size:14px;overflow-wrap:anywhere}' +
    '.prism-am-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--border);color:var(--text2);white-space:nowrap}' +
    '.prism-am-chip--best{color:var(--green);border-color:var(--green)}' +
    '.prism-am-chip--refine{color:var(--yellow);border-color:var(--yellow)}' +
    '.prism-am-stats{font-size:12px;color:var(--text2);margin-top:4px}' +
    '.prism-am-res{margin-top:6px;font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:2px 8px}' +
    '.prism-am-res span:nth-child(odd){color:var(--text3)}' +
    '.prism-am-res span:nth-child(even){font-family:Menlo,Consolas,monospace;overflow-wrap:anywhere}' +
    '.prism-am-btn{margin-top:8px;padding:6px 12px;font-size:12px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:var(--bg1);color:var(--text)}' +
    '.prism-am-btn--primary{background:var(--accent);border-color:var(--accent);color:#fff}' +
    '.prism-am-warn{font-size:12px;color:var(--yellow)}' +
    '.prism-am-muted{font-size:11px;color:var(--text3)}' +
    '.prism-am-status{font-size:12px;color:var(--green);min-height:16px}';

function _ensureCss() {
    if (typeof document === 'undefined' || !document.getElementById || !document.createElement) return;
    if (document.getElementById('prism_am_css')) return;
    var s = document.createElement('style');
    s.id = 'prism_am_css';
    s.textContent = PANEL_CSS;
    var head = document.head || document.body;
    if (head && head.appendChild) head.appendChild(s);
}

function _ciText(v, ci, digits) {
    if (!_num(v)) return '—';
    var txt = (typeof digits === 'function') ? digits(v) : _fmt(v, 3);
    if (ci && _num(ci[0]) && _num(ci[1])) {
        var half = 0.5 * (ci[1] - ci[0]);
        if (half > 0) txt += ' ± ' + _fmt(half, 2);
    }
    return txt;
}

function _resultRows(row) {
    var ph = row.phys || {}, ci = row.ci95 || {}, out = [];
    if (row.kind === 'rate') {
        Object.keys(ph).forEach(function (k) {
            if (k === 'timeUnit' || !_num(ph[k])) return;
            out.push([k === 'eurAtEnd' ? 'Cum. to end' : k, _ciText(ph[k], ci[k])]);
        });
        return out;
    }
    if (_num(ph.k)) out.push(['k', _ciText(ph.k, ci.k) + ' md']);
    if (_num(ph.kh)) out.push(['kh', _ciText(ph.kh, ci.kh) + ' md·ft']);
    if (_num(ph.S)) out.push(['S', _ciText(ph.S, ci.S, function (v) { return v.toFixed(2); })]);
    else if (row.mode === 'scale') out.push(['S', 'not identifiable (well inputs incomplete)']);
    if (_num(ph.C)) out.push(['C', _ciText(ph.C, ci.C) + ' bbl/psi']);
    if (_num(ph.xf)) out.push(['xf', _ciText(ph.xf, ci.xf) + ' ft']);
    if (_num(ph.Lh)) out.push(['Lh', _ciText(ph.Lh, ci.Lh) + ' ft']);
    if (ph.distances_ft) Object.keys(ph.distances_ft).forEach(function (k) {
        out.push([k + ' distance', _fmt(ph.distances_ft[k], 3) + ' ft']);
    });
    if (row.pRefSource === 'floated' && _num(row.pRef)) out.push(['pi', _fmt(row.pRef, 5) + ' psia']);
    return out;
}

function _cardHTML(row, idx) {
    var cls = row.status === 'best' ? ' prism-am-card--best' : (row.status === 'refine' ? ' prism-am-card--refine' : '');
    var chip = row.status === 'best' ? ' prism-am-chip--best' : (row.status === 'refine' ? ' prism-am-chip--refine' : '');
    var res = _resultRows(row).map(function (p) { return '<span>' + _esc(p[0]) + '</span><span>' + _esc(p[1]) + '</span>'; }).join('');
    var warn = (row.warnings && row.warnings.length) ? '<div class="prism-am-warn">⚠ ' + _esc(row.warnings[0]) + '</div>' : '';
    return '<div class="prism-am-card' + cls + '" data-prism-am-row="' + idx + '" data-prism-am-key="' + _esc(row.modelKey) + '">' +
        '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">' +
            '<span class="prism-am-name">' + _esc(row.modelName || PRiSM_modelPlainName(row.modelKey)) + '</span>' +
            '<span class="prism-am-chip' + chip + '">' + _esc(row.label) + '</span>' +
        '</div>' +
        '<div class="prism-am-stats">ΔAIC ' + (_num(row.dAIC) ? row.dAIC.toFixed(1) : '—') +
            ' · R² ' + (_num(row.r2) ? row.r2.toFixed(4) : '—') +
            ' · ' + (row.converged ? '✓ converged' : 'not converged') +
            (_num(row.iterations) ? ' (' + row.iterations + ' it)' : '') + '</div>' +
        '<div class="prism-am-res">' + res + '</div>' + warn +
        '<button type="button" class="prism-am-btn' + (row.status === 'best' ? ' prism-am-btn--primary' : '') +
            '" data-prism-am-apply="' + _esc(row.modelKey) + '">' +
            (row.status === 'refine' ? 'Use as starting point' : 'Use this model') + '</button>' +
        '</div>';
}

function PRiSM_renderAutoMatchPanel(container, result) {
    if (!container || typeof container.innerHTML !== 'string') return;
    _ensureCss();
    if (result === undefined) result = G.PRiSM_state && G.PRiSM_state.autoMatch;
    var runBtn = '<button type="button" class="prism-am-btn prism-am-btn--primary" id="prism_am_run">Find best model</button>';
    if (!result) {
        container.innerHTML = '<div class="prism-am"><div class="prism-am-muted">Races the likely models against your data in physical units (k, C, S) and ranks them by AIC.</div>' + runBtn + '<div class="prism-am-status" id="prism_am_status"></div></div>';
        _wirePanel(container, null);
        return;
    }
    var h = ['<div class="prism-am">'];
    h.push('<div class="prism-am-head"><strong>Recommended models</strong>' +
           '<span class="prism-am-muted">' + (result.ranked ? result.ranked.length : 0) + ' fitted · ' +
           (_num(result.elapsedMs) ? result.elapsedMs + ' ms' : '') + '</span></div>');
    if (result.classification && result.classification.summary) {
        h.push('<div class="prism-am-diag"><b>Diagnostic:</b> ' + _esc(result.classification.summary) + '</div>');
    }
    (result.warnings || []).slice(0, 3).forEach(function (w) { h.push('<div class="prism-am-warn">⚠ ' + _esc(w) + '</div>'); });
    if (!result.ok || !result.ranked || !result.ranked.length) {
        h.push('<div class="prism-am-warn">No model could be fitted' + (result.error ? ': ' + _esc(result.error) : '.') + '</div>');
    } else {
        h.push('<div class="prism-am-cards">' + result.top.map(_cardHTML).join('') + '</div>');
    }
    if (result.decline && result.decline.top && result.decline.top.length) {
        h.push('<div><strong>Decline models (rate)</strong></div><div class="prism-am-cards">' +
               result.decline.top.map(function (r, i) { return _cardHTML(r, 100 + i); }).join('') + '</div>');
    }
    if (result.failed && result.failed.length) {
        h.push('<div class="prism-am-muted">Could not fit: ' + result.failed.map(function (f) {
            return _esc(f.modelName || f.modelKey);
        }).join(', ') + '</div>');
    }
    h.push('<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
           runBtn.replace('Find best model', 'Run again') +
           '<button type="button" class="prism-am-btn" id="prism_am_choose">Choose models…</button></div>');
    h.push('<div class="prism-am-status" id="prism_am_status">' + _esc((G.PRiSM_state && G.PRiSM_state.autoMatchStatus) || '') + '</div>');
    h.push('</div>');
    container.innerHTML = h.join('');
    _wirePanel(container, result);
}

function _runAndRender(container, opts) {
    var status = container.querySelector ? container.querySelector('#prism_am_status') : null;
    if (status) status.textContent = 'Fitting candidate models…';
    return PRiSM_autoMatch(opts || {}).then(function (res) {
        PRiSM_renderAutoMatchPanel(container, res);
        return res;
    }, function (err) {
        if (status) status.textContent = 'Auto-match failed: ' + String(err && err.message || err);
    });
}

function _wirePanel(container, result) {
    if (!container.querySelectorAll) return;
    var btns = container.querySelectorAll('button[data-prism-am-apply]');
    for (var i = 0; i < btns.length; i++) {
        btns[i].onclick = function (ev) {
            var key = (ev && ev.currentTarget ? ev.currentTarget : this).getAttribute('data-prism-am-apply');
            PRiSM_applyAutoMatchRow(key, result);
        };
    }
    var run = container.querySelector('#prism_am_run');
    if (run) run.onclick = function () { _runAndRender(container, {}); };
    var choose = container.querySelector('#prism_am_choose');
    if (choose) choose.onclick = function () { _openCandidateChooser(container, result); };
}

function _openCandidateChooser(host, prevResult) {
    if (typeof document === 'undefined' || !document.createElement) return;
    _ensureCss();
    var registry = G.PRiSM_MODELS || {};
    var keys = Object.keys(registry).sort(function (a, b) {
        return PRiSM_modelPlainName(a).localeCompare(PRiSM_modelPlainName(b));
    });
    if (!keys.length) return;
    var pre = {};
    if (prevResult && prevResult.ranked) prevResult.ranked.forEach(function (r) { pre[r.modelKey] = true; });
    var old = document.getElementById('prism_am_chooser');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var ov = document.createElement('div');
    ov.id = 'prism_am_chooser';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
    var rows = keys.map(function (k) {
        var e = registry[k] || {};
        return '<label style="display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12px;border-bottom:1px dashed var(--border);">' +
            '<input type="checkbox" data-prism-am-cand value="' + _esc(k) + '"' + (pre[k] ? ' checked' : '') + '>' +
            '<span style="flex:1;min-width:0;overflow-wrap:anywhere;">' + _esc(PRiSM_modelPlainName(k)) + '</span>' +
            '<span style="color:var(--text3);">' + _esc(e.kind === 'rate' ? 'decline' : (e.category || '')) + '</span></label>';
    }).join('');
    ov.innerHTML = '<div style="background:var(--bg1);border:1px solid var(--border);border-radius:10px;width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;color:var(--text);">' +
        '<div style="padding:12px;border-bottom:1px solid var(--border);font-weight:600;">Choose models to compare</div>' +
        '<div style="padding:8px 12px;overflow-y:auto;flex:1;">' + rows + '</div>' +
        '<div style="padding:12px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;">' +
            '<button type="button" class="prism-am-btn" id="prism_am_chooser_cancel">Cancel</button>' +
            '<button type="button" class="prism-am-btn prism-am-btn--primary" id="prism_am_chooser_run">Compare</button></div></div>';
    document.body.appendChild(ov);
    ov.querySelector('#prism_am_chooser_cancel').onclick = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    ov.querySelector('#prism_am_chooser_run').onclick = function () {
        var picked = [];
        var boxes = ov.querySelectorAll('input[data-prism-am-cand]');
        for (var b = 0; b < boxes.length; b++) if (boxes[b].checked) picked.push(boxes[b].value);
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        if (picked.length) _runAndRender(host, { candidates: picked });
    };
}


// =========================================================================
// SECTION 10 — EXPORTS
// =========================================================================

G.PRiSM_classifyRegimes      = PRiSM_classifyRegimes;
G.PRiSM_autoMatch            = PRiSM_autoMatch;
G.PRiSM_autoMatchSync        = PRiSM_autoMatchSync;
G.PRiSM_applyAutoMatchRow    = PRiSM_applyAutoMatchRow;
G.PRiSM_suggestInitialParams = PRiSM_suggestInitialParams;
G.PRiSM_renderAutoMatchPanel = PRiSM_renderAutoMatchPanel;
G.PRiSM_modelPlainName       = PRiSM_modelPlainName;
// Internal hooks for the acceptance tests (not a public contract).
G.PRiSM__autoMatchInternals  = { localPM: _localPM, localAnalysisData: _localAnalysisData, bourdet: _bourdet };

// A ranking belongs to the data and flow period it was run on: drop it when
// either changes, so the report's model comparison and the Recommended strip
// never show another dataset's ΔAIC.
if (typeof G.addEventListener === 'function' && !G.__PRiSM_amStaleListener) {
    G.__PRiSM_amStaleListener = true;
    ['prism:dataset-loaded', 'prism:dataset-cleared', 'prism:period-changed'].forEach(function (type) {
        G.addEventListener(type, function () {
            try {
                var st = G.PRiSM_state;
                if (st && typeof st === 'object') { st.autoMatch = null; if (st.lastAutoMatch) st.lastAutoMatch = null; }
                if (G.PRiSM_lastAutoMatch) G.PRiSM_lastAutoMatch = null;
            } catch (e) { /* silent */ }
        });
    });
}

})();

// ─── END 13-auto-match ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 14-interpretation ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 14 — Plain-English Interpretation
//   Turns the current fit (C4 lastFit: physical k, C, S + dimensionless
//   shape parameters + CIs) into a narrative with honest precision,
//   qualitative tags, skin-based actions and cautions.
// ────────────────────────────────────────────────────────────────────
//
// Public API (all on window.*):
//   PRiSM_interpretFit(modelKey, params, CI95, fitMeta?) -> Interp
//   PRiSM_interpretCurrentFit()                          -> Interp | null  (pure)
//   PRiSM_refreshInterpretation()                        -> Interp | null  (writes st.interp)
//   PRiSM_renderInterpretationPanel(container, interp?)  -> void
//   PRiSM_buildNarrative(tags, modelKey, ctx)            -> string
//   PRiSM_formatWithCI(value, halfWidth, unit?)          -> '45.0 ± 0.3 md'
//
// Interp = { tags, narrative, headline, actions, confidence, cautions,
//            skin:{S_total, S_pseudo, S_mech, Sf, FE, DR, dpS, J, J_ideal, rwEff},
//            modelKey, source, timestamp }
//
// fitMeta (all optional): { r2, dAIC (margin to runner-up), iterations,
//   secondModelKey, lateRMSE, phys:{k,kh,C,Cd,S,pi,rinv,…}, identifiable:{},
//   well:{q,B,mu,rw,h,…}, pwf, pbar, testType, source, stale, mode }
//
// Skin rules (actions keyed on the MECHANICAL skin S_mech = S_total − pseudo-skins):
//   S_mech 2–5            → consider an acid wash
//   S_mech 5–10           → remedial treatment recommended (moderate)
//   S_mech > 10 or FE < ½ → stimulation strongly indicated
//   S < −4 in a radial model → rw′ > 50·rw, try a fracture model
//   Sf > 0.5              → fracture-face damage
//   "No workover" reassurance only when EVERY skin term is acceptable.
//
// Conventions: single outer IIFE; window.PRiSM_* only; no external deps;
// defensive against missing models / lastFit / DOM; self-test at the end.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});
var _hasDoc = (typeof document !== 'undefined');

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

// Compact in-prose number formatter.
function _prose(n) {
    if (n == null || !isFinite(n)) return '—';
    var v = Number(n), a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10)  return v.toFixed(1);
    if (a >= 1)   return v.toFixed(2);
    return v.toFixed(3);
}

// Honest precision: round the half-width to 1 significant figure (2 when it
// starts with a 1) and the value to the same decimal place.
function _decimalsFor(half) {
    if (!_pos(half)) return null;
    var e = Math.floor(Math.log10(half));
    var lead = half / Math.pow(10, e);
    var sig = lead < 1.95 ? 2 : 1;
    return Math.max(0, -(e - sig + 1));
}

function PRiSM_formatWithCI(v, half, unit) {
    if (!_num(v)) return '—';
    var u = unit ? ' ' + unit : '';
    var a = Math.abs(v);
    if (_pos(half)) {
        if (half >= a && a > 0) return '≈' + _sig(v, 1) + u + ' (poorly constrained)';
        if (a !== 0 && (a < 1e-3 || a >= 1e6)) {
            var relDigits = Math.max(1, Math.min(4, Math.ceil(Math.log10(a / half)) + 1));
            return v.toExponential(relDigits - 1) + ' ± ' + half.toExponential(0) + u;
        }
        var d = _decimalsFor(half);
        if (d > 6) d = 6;
        return v.toFixed(d) + ' ± ' + half.toFixed(d) + u;
    }
    return _sig(v, 3) + u;
}

function _sig(v, n) {
    if (!_num(v)) return '—';
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a < 1e-3 || a >= 1e6) return v.toExponential(Math.max(0, n - 1));
    var d = Math.max(0, n - 1 - Math.floor(Math.log10(a)));
    return v.toFixed(Math.min(6, d));
}

function _half(range) {
    if (!range || !_num(range[0]) || !_num(range[1])) return NaN;
    return 0.5 * Math.abs(range[1] - range[0]);
}


// ════════════════════════════════════════════════════════════════════
// SECTION 1 — PARAM-TO-TAG RULES
// ════════════════════════════════════════════════════════════════════
// Severity ladder: 'good' | 'normal' | 'warning' | 'important'

var SKIN_BUCKETS = [
    [-5,        'highly stimulated',         'good',      'a highly stimulated completion'],
    [-2,        'effectively stimulated',    'good',      'an effectively stimulated completion'],
    [ 0,        'mildly stimulated',         'good',      'a mildly stimulated completion'],
    [ 2,        'no significant skin',       'normal',    'no significant skin'],
    [ 5,        'mildly damaged',            'warning',   'mild damage near the wellbore'],
    [10,        'damaged',                   'warning',   'moderate damage near the wellbore'],
    [Infinity,  'severely damaged',          'important', 'severe damage near the wellbore']
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
var SF_BUCKETS = [
    [0.5,       'clean fracture face',       'normal',  'a clean fracture face'],
    [Infinity,  'fracture-face damage',      'warning', 'fracture-face damage']
];

function _bucketLookup(buckets, v) {
    if (!isFinite(v)) return null;
    for (var i = 0; i < buckets.length; i++) {
        if (v < buckets[i][0]) return { qualitative: buckets[i][1], severity: buckets[i][2], hint: buckets[i][3] };
    }
    return null;
}

function _ruleBoundaryL(v, label, unitFt) {
    if (!isFinite(v)) return null;
    var name = label || 'Boundary';
    var lname = name.toLowerCase();
    // Distances in ft when known (phys.distances_ft), else in the model's own units.
    var near = unitFt ? 150 : 100, mid = unitFt ? 600 : 500, far = unitFt ? 3000 : 2000;
    if (v < near)  return { qualitative: name + ' very close — recheck data quality', severity: 'warning',
                            hint: lname + ' very close to the wellbore — data quality should be re-checked' };
    if (v < mid)   return { qualitative: 'near ' + lname + ' detected', severity: 'important',
                            hint: 'a near ' + lname + ' is detected' };
    if (v < far)   return { qualitative: name + ' detected at moderate distance', severity: 'important',
                            hint: 'a ' + lname + ' is detected at moderate distance' };
    return { qualitative: 'far ' + lname + ' — late-time signal only', severity: 'normal',
             hint: 'a far ' + lname + ' is hinted by the late-time signal' };
}

var BOUNDARY_KEYS = {
    'L': 'Boundary', 'dF': 'Boundary', 'dF1': 'Fault 1', 'dF2': 'Fault 2', 'dEnd': 'End',
    'dN': 'North boundary', 'dS': 'South boundary', 'dE': 'East boundary', 'dW': 'West boundary'
};
var SKIN_KEYS = { S: 1, S_perf: 1, S_global: 1, S_mech: 1, Sf: 1 };

function _ruleForKey(key, value) {
    if (key === 'S' || key === 'S_global' || key === 'S_perf' || key === 'S_mech') return _bucketLookup(SKIN_BUCKETS, value);
    if (key === 'Sf')                              return _bucketLookup(SF_BUCKETS, value);
    if (key === 'Cd')                              return _bucketLookup(CD_BUCKETS, value);
    if (key === 'kh')                              return _bucketLookup(KH_BUCKETS, value);
    if (key === 'omega')                           return _bucketLookup(OMEGA_BUCKETS, value);
    if (key === 'lambda')                          return _bucketLookup(LAMBDA_BUCKETS, value);
    if (key === 'xf')                              return _bucketLookup(XF_BUCKETS, value);
    if (key === 'FcD')                             return _bucketLookup(FCD_BUCKETS, value);
    if (key === 'Lh' || key === 'Llat')            return _bucketLookup(LATERAL_BUCKETS, value);
    if (BOUNDARY_KEYS.hasOwnProperty(key))         return _ruleBoundaryL(value, BOUNDARY_KEYS[key], false);
    return null;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 2 — MODEL HELPERS
// ════════════════════════════════════════════════════════════════════

function _entry(modelKey) { return (G.PRiSM_MODELS && G.PRiSM_MODELS[modelKey]) || null; }

function _plainName(modelKey) {
    if (typeof G.PRiSM_modelPlainName === 'function') {
        try { var n = G.PRiSM_modelPlainName(modelKey); if (n) return n; } catch (e) { /* ignore */ }
    }
    return modelKey || 'model';
}

function _modelCategoryOpening(modelKey) {
    var spec = _entry(modelKey);
    var cat = spec && spec.category;
    if (modelKey === 'homogeneous' || cat === 'homogeneous') return 'a radial-flow (homogeneous reservoir) response';
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
    if (cat === 'well-type')     return 'a ' + _plainName(modelKey).toLowerCase() + ' response';
    return null;
}

// A radial model has no fracture / lateral reference length.
function _isRadialModel(modelKey, params) {
    var e = _entry(modelKey);
    var cat = e && e.category;
    if (cat === 'fracture' || cat === 'multilateral' || cat === 'decline') return false;
    if (e && e.refLength && e.refLength !== 'rw') return false;
    if (params && (_num(params.xf) || _num(params.Lh) || _num(params.FcD))) return false;
    if (modelKey === 'horizontal' || modelKey === 'inclined') return false;
    return true;
}

function _paramMeta(modelKey, key) {
    var spec = _entry(modelKey);
    if (!spec || !spec.paramSpec) return { unit: '', label: key };
    for (var i = 0; i < spec.paramSpec.length; i++) if (spec.paramSpec[i].key === key) return spec.paramSpec[i];
    return { unit: '', label: key };
}

function _makeTag(key, value, range, rule, extra) {
    var t = { param: key, value: value, range: range || [NaN, NaN],
              qualitative: rule.qualitative, severity: rule.severity, hint: rule.hint };
    if (extra) for (var k in extra) t[k] = extra[k];
    return t;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 3 — SKIN ANALYSIS (S_total → S_mech, FE / DR)
// ════════════════════════════════════════════════════════════════════

function _skinAnalysis(modelKey, params, meta) {
    var phys = meta.phys || {};
    var entry = _entry(modelKey) || {};
    var out = { S_total: NaN, S_pseudo: 0, S_mech: NaN, Sf: NaN, FE: NaN, DR: NaN, dpS: NaN,
                J: NaN, J_ideal: NaN, rwEff: NaN, hasPseudo: false, source: null };
    var Sfit;
    // Scale mode (φ, ct or rw missing): params.S is only the curve's skin at the
    // arbitrary reference Cd, not a result. Skin comes from phys.S (null) only.
    if (meta.mode === 'scale') {
        if (_num(phys.S)) Sfit = phys.S;
    } else if (_num(params.S)) Sfit = params.S;
    else if (_num(params.S_perf) || _num(params.S_global)) Sfit = (params.S_perf || 0) + (params.S_global || 0);
    else if (_num(phys.S)) Sfit = phys.S;
    if (!_num(Sfit)) return out;
    if (_num(params.Sf)) out.Sf = params.Sf;
    var well = meta.well || {};
    var g0 = meta.geom || {};
    var geom = { h: _num(g0.h) ? g0.h : well.h, rw: _num(g0.rw) ? g0.rw : well.rw,
                 hp: _num(g0.hp) ? g0.hp : well.hp, kvkh: _num(g0.kvkh) ? g0.kvkh : params.KvKh,
                 theta: _num(g0.theta) ? g0.theta : params.theta_deg, xf: phys.xf };

    // Three cases (plan §4: pseudo-skin models already separate Sg internally):
    //  (a) registry pseudoSkin metadata → fitted skin is mechanical,
    //      S_total = S_fit + pseudoSkin(params);
    //  (b) S_perf / S_global models without metadata → fitted skin is
    //      mechanical; the internal geometric term is not reported;
    //  (c) plain-S models → fitted skin is TOTAL; decompose only when the
    //      user supplied partial-penetration / slant geometry or D·q.
    var separates = params.S_perf != null || params.S_global != null;
    var pseudo = NaN;
    if (typeof entry.pseudoSkin === 'function') {
        try { pseudo = entry.pseudoSkin(params, geom); } catch (e) { pseudo = NaN; }
    }
    var decomposed = false;
    var hasGeom = (_pos(geom.hp) && _pos(geom.h) && geom.hp < geom.h) || (_num(geom.theta) && geom.theta !== 0) ||
                  (_num(meta.D) && _pos(well.q));
    if (!_num(pseudo) && !separates && hasGeom && typeof G.PRiSM_skinDecomposition === 'function') {
        try {
            var dec = G.PRiSM_skinDecomposition({ S_total: Sfit, modelKey: modelKey, params: params, geom: geom,
                                                  D: meta.D, q: well.q });
            if (dec && _num(dec.S_mech)) {
                out.S_total = Sfit;
                out.S_mech = dec.S_mech;
                out.S_pseudo = Sfit - dec.S_mech;
                out.hasPseudo = Math.abs(out.S_pseudo) > 1e-6;
                decomposed = true;
            }
        } catch (e) { /* fall back */ }
    }
    if (!decomposed) {
        out.S_pseudo = _num(pseudo) ? pseudo : 0;
        out.S_mech = Sfit;
        out.S_total = Sfit + out.S_pseudo;
        out.hasPseudo = _num(pseudo) && Math.abs(pseudo) > 1e-6;
    }
    if (_pos(well.rw)) out.rwEff = well.rw * Math.exp(-out.S_total);

    // FE / DR / ΔpS (on the mechanical, i.e. removable, skin).
    var kh = _num(phys.kh) ? phys.kh : (_num(phys.k) && _pos(well.h) ? phys.k * well.h : NaN);
    var pbar = _num(meta.pbar) ? meta.pbar : (_num(phys.pi) ? phys.pi : well.pi);
    var pwf = meta.pwf;
    var args = { S: out.S_mech, kh: kh, k: phys.k, q: well.q, B: well.B, mu: well.mu, rw: well.rw,
                 pbar: pbar, pwf: pwf, testType: meta.testType, CD: phys.Cd };
    var ss = null;
    if (typeof G.PRiSM_skinSummary === 'function' && _pos(kh)) {
        try { ss = G.PRiSM_skinSummary(args); } catch (e) { ss = null; }
    }
    function pick(o, names) {
        if (!o) return NaN;
        for (var i = 0; i < names.length; i++) if (_num(o[names[i]])) return o[names[i]];
        return NaN;
    }
    out.FE = pick(ss, ['FE', 'fe']);
    out.DR = pick(ss, ['DR', 'dr']);
    out.dpS = pick(ss, ['dpS', 'dPs', 'deltaPs', 'dpSkin', 'dps']);
    out.J = pick(ss, ['J']);
    out.J_ideal = pick(ss, ['J_ideal', 'Jideal']);
    if (ss) out.source = 'skinSummary';
    if (!_num(out.FE) && _pos(kh) && _pos(well.q) && _pos(well.B) && _pos(well.mu) && _num(pbar) && _num(pwf)) {
        var dd = Math.abs(pbar - pwf);
        if (dd > 0) {
            out.dpS = 141.2 * well.q * well.B * well.mu * out.S_mech / kh;
            out.FE = (dd - out.dpS) / dd;
            out.DR = out.FE !== 0 ? 1 / out.FE : NaN;
            out.J = well.q / dd;
            out.J_ideal = (dd - out.dpS) > 0 ? well.q / (dd - out.dpS) : NaN;
            out.source = 'local';
        }
    }
    if (!_num(out.DR) && _num(out.FE) && out.FE !== 0) out.DR = 1 / out.FE;
    return out;
}

function _skinActions(skin, modelKey, params) {
    var actions = [];
    var Sm = skin.S_mech;
    if (!_num(Sm)) return actions;
    var feLow = _num(skin.FE) && skin.FE < 0.5;
    var smTxt = Sm.toFixed(1);
    if (Sm > 10 || feLow) {
        actions.push('Stimulation strongly indicated — mechanical skin ' + smTxt +
                     (feLow ? ' and flow efficiency ' + Math.round(100 * skin.FE) + '%' : '') +
                     ' (matrix acid or re-perforation)');
    } else if (Sm >= 5) {
        actions.push('Remedial treatment recommended (moderate damage, mechanical skin ' + smTxt + ')');
    } else if (Sm >= 2) {
        actions.push('Consider an acid wash if production targets are unmet (mild damage, mechanical skin ' + smTxt + ')');
    }
    if (_num(skin.S_total) && skin.S_total < -4 && _isRadialModel(modelKey, params)) {
        var ratio = Math.exp(-skin.S_total);
        actions.push('Effective wellbore radius rw′ ≈ ' + (ratio >= 100 ? ratio.toFixed(0) : ratio.toFixed(1)) +
                     '·rw (> 50·rw) — try a fracture model');
    }
    if (_num(skin.Sf) && skin.Sf > 0.5) {
        actions.push('Fracture-face damage (Sf = ' + skin.Sf.toFixed(2) + ') — consider a fracture clean-up or re-stimulation');
    }
    return actions;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 4 — OTHER ACTIONS
// ════════════════════════════════════════════════════════════════════

var ACTION_TEMPLATES = [
    { match: /very high WBS/i,                action: 'Use a downhole shut-in for the next test' },
    { match: /near .* detected|detected at/i, action: 'Confirm the boundary against seismic / well-spacing geometry; revise rate planning' },
    { match: /very close/i,                   action: 'Re-examine the early-time data — a very close boundary may be a gauge or data artefact' },
    { match: /short fracture/i,               action: 'Evaluate as a re-fracture candidate' },
    { match: /^high WBS/i,                    action: 'Future tests: downhole shut-in or a longer buildup' },
    { match: /low productivity/i,             action: 'Confirm completion efficiency; consider re-perforation or stimulation' },
    { match: /weak fracture signature/i,      action: 'Re-fit as homogeneous and compare AIC' },
    { match: /low FcD/i,                      action: 'Investigate fracture clean-up or proppant pack quality' }
];

function _actionsForTags(tags) {
    var out = [];
    for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        if (SKIN_KEYS[t.param]) continue;        // skin handled by _skinActions
        if (t.severity !== 'warning' && t.severity !== 'important') continue;
        for (var j = 0; j < ACTION_TEMPLATES.length; j++) {
            if (ACTION_TEMPLATES[j].match.test(t.qualitative)) {
                if (out.indexOf(ACTION_TEMPLATES[j].action) < 0) out.push(ACTION_TEMPLATES[j].action);
                break;
            }
        }
    }
    return out;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 5 — CONFIDENCE
// ════════════════════════════════════════════════════════════════════
//   high   : R² ≥ 0.99 AND all CIs < 30 % AND (margin to runner-up > 10 or unknown)
//   medium : R² ≥ 0.95
//   low    : R² < 0.95 OR any CI > 100 % OR margin < 2 OR not converged

function _ciFractionalWidth(value, range) {
    if (!range || !isFinite(range[0]) || !isFinite(range[1])) return Infinity;
    if (!isFinite(value)) return Infinity;
    var halfWidth = 0.5 * (range[1] - range[0]);
    if (Math.abs(value) < 1) return Math.abs(halfWidth);      // skin-like values near zero
    return Math.abs(halfWidth / value);
}

function _confidenceLevel(tags, fitMeta) {
    var r2 = (fitMeta && isFinite(fitMeta.r2)) ? fitMeta.r2 : NaN;
    var dAIC = (fitMeta && isFinite(fitMeta.dAIC)) ? fitMeta.dAIC : NaN;
    var withCI = tags.filter(function (t) { return t.range && isFinite(t.range[0]) && isFinite(t.range[1]); });
    var widths = withCI.map(function (t) { return _ciFractionalWidth(t.value, t.range); });
    var anyVeryWide = widths.some(function (w) { return w > 1.0; });
    var allTight = widths.length > 0 && widths.every(function (w) { return w < 0.30; });
    if (fitMeta && fitMeta.converged === false) return 'low';
    if (isFinite(r2) && r2 < 0.95) return 'low';
    if (anyVeryWide) return 'low';
    if (isFinite(dAIC) && dAIC < 2) return 'low';
    if ((!isFinite(r2) || r2 >= 0.99) && allTight && (!isFinite(dAIC) || dAIC > 10)) return 'high';
    return 'medium';
}

function _confidenceVerb(level) {
    if (level === 'high')   return 'shows';
    if (level === 'medium') return 'is consistent with';
    return 'tentatively suggests';
}

function _confidenceStatement(level) {
    if (level === 'high')   return 'Confidence in this interpretation is high';
    if (level === 'medium') return 'Confidence is moderate — longer flow periods would tighten the ranges';
    return 'Confidence is low — treat this interpretation as preliminary';
}


// ════════════════════════════════════════════════════════════════════
// SECTION 6 — NARRATIVE
// ════════════════════════════════════════════════════════════════════

function _findTag(tags, key) {
    for (var i = 0; i < tags.length; i++) if (tags[i].param === key) return tags[i];
    return null;
}
function _findSkinTag(tags) {
    return _findTag(tags, 'S_mech') || _findTag(tags, 'S') || _findTag(tags, 'S_perf') || _findTag(tags, 'S_global');
}
function _findBoundaryTags(tags) {
    return tags.filter(function (t) { return BOUNDARY_KEYS.hasOwnProperty(t.param); });
}

function _valueWithCI(tag, modelKey) {
    var meta = _paramMeta(modelKey, tag.param);
    var unit = (meta.unit && meta.unit !== '-') ? meta.unit : '';
    if (tag.identifiable === false) return tag.param + ' ≈ ' + _sig(tag.value, 2) + (unit ? ' ' + unit : '') + ' (not resolved)';
    return tag.param + ' = ' + PRiSM_formatWithCI(tag.value, _half(tag.range), unit);
}

function _capitalize(s) { return (s && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

G.PRiSM_buildNarrative = function PRiSM_buildNarrative(tags, modelKey, ctx) {
    ctx = ctx || {};
    if (!tags || !tags.length) {
        if (ctx.phys && _num(ctx.phys.kh)) tags = [];
        else return 'No interpretable parameters were extracted from this fit.';
    }
    var conf = ctx.confidence || 'medium';
    var verb = _confidenceVerb(conf);
    var modelKnown = !!_entry(modelKey);
    var phys = ctx.phys || {};
    var ci = ctx.ci95 || {};
    var ident = ctx.identifiable || {};
    var skin = ctx.skin || {};
    var clauses = [];

    var skinTag = _findSkinTag(tags);
    var openCat = modelKnown ? _modelCategoryOpening(modelKey) : null;
    var skinPart = '';
    if (skinTag) {
        skinPart = skinTag.hint + ' (' + _valueWithCI(skinTag, modelKey) + ')';
    }
    if (openCat) {
        clauses.push('This well ' + verb + ' ' + openCat + (skinPart ? ' with ' + skinPart : '') + '.');
    } else if (skinPart) {
        clauses.push('This well ' + verb + ' ' + skinPart + '.');
    } else {
        clauses.push('Fitted parameters are described below.');
    }
    if (skin.hasPseudo && _num(skin.S_total) && _num(skin.S_mech)) {
        clauses.push('The total skin of ' + skin.S_total.toFixed(2) + ' includes ' + skin.S_pseudo.toFixed(2) +
                     ' of geometric (pseudo-)skin, leaving a mechanical skin of ' + skin.S_mech.toFixed(2) + '.');
    }

    // Permeability / productivity in field units.
    if (_num(phys.k)) {
        var kTxt = ident.k === false ? '≈' + _sig(phys.k, 2) + ' md (not resolved)'
                                     : PRiSM_formatWithCI(phys.k, _half(ci.k), 'md');
        var khTxt = _num(phys.kh) ? ' (kh ' + PRiSM_formatWithCI(phys.kh, _half(ci.kh), 'md·ft') + ')' : '';
        var khTag = _findTag(tags, 'kh');
        clauses.push('Permeability is ' + kTxt + khTxt + (khTag ? ', ' + khTag.hint + ' productivity' : '') + '.');
    } else if (_num(phys.kh)) {
        clauses.push('Flow capacity kh is ' + PRiSM_formatWithCI(phys.kh, _half(ci.kh), 'md·ft') + '.');
    }

    var cdTag = _findTag(tags, 'Cd');
    if (cdTag) {
        var cTxt = _num(phys.C) ? 'C ' + PRiSM_formatWithCI(phys.C, _half(ci.C), 'bbl/psi') + ', ' : '';
        clauses.push('Wellbore storage is ' + cdTag.hint + ' (' + cTxt + 'Cd ≈ ' + _sig(cdTag.value, 2) + ').');
    }

    // Flow efficiency wording.
    if (_num(skin.FE) && skin.FE > 0) {
        var fePct = Math.round(100 * skin.FE);
        var gain = _num(skin.DR) ? Math.round(100 * (skin.DR - 1)) : NaN;
        var txt = 'The well flows at ' + fePct + '% of its undamaged potential (FE ' + fePct + '%';
        if (_num(skin.DR)) txt += ', DR ' + skin.DR.toFixed(2);
        txt += ')';
        if (_num(gain) && gain > 0) {
            txt += '; removing the skin would add ≈' + gain + '% rate';
            if (_num(skin.dpS)) txt += ' (skin pressure drop ≈' + _sig(skin.dpS, 3) + ' psi)';
        } else if (_num(gain) && gain < 0) {
            txt += '; the completion outperforms an undamaged well by ≈' + Math.abs(gain) + '%';
        }
        clauses.push(txt + '.');
    }

    _findBoundaryTags(tags).forEach(function (bt) {
        var dFt = phys.distances_ft && phys.distances_ft[bt.param];
        var hintAct = '';
        if (bt.severity === 'important') hintAct = ' — confirm against geology before extending production at this rate';
        else if (bt.severity === 'warning') hintAct = ' — verify data quality at the early-time end of the test';
        var where = _num(dFt) ? (' about ' + _sig(dFt, 2) + ' ft') : (' at ' + _prose(bt.value) + ' (model units)');
        if (bt.identifiable === false) {
            clauses.push('A ' + (BOUNDARY_KEYS[bt.param] || 'boundary').toLowerCase() + ' is not resolved by the data (beyond the radius investigated).');
        } else {
            clauses.push(_capitalize(bt.hint) + where + ' from the wellbore' + hintAct + '.');
        }
    });

    var xfTag = _findTag(tags, 'xf');
    if (xfTag) clauses.push(_capitalize(xfTag.hint) + ' is observed (xf ' + PRiSM_formatWithCI(xfTag.value, _half(xfTag.range), 'ft') + ').');
    var fcdTag = _findTag(tags, 'FcD');
    if (fcdTag) clauses.push('The data show ' + fcdTag.hint + ' (FcD ≈ ' + _sig(fcdTag.value, 2) + ').');
    var sfTag = _findTag(tags, 'Sf');
    if (sfTag && sfTag.severity !== 'normal') clauses.push('There is ' + sfTag.hint + ' (Sf = ' + sfTag.value.toFixed(2) + ').');

    var omegaTag = _findTag(tags, 'omega'), lambdaTag = _findTag(tags, 'lambda');
    if (omegaTag || lambdaTag) {
        var parts = [];
        if (omegaTag)  parts.push(omegaTag.hint  + ' (ω ≈ ' + _sig(omegaTag.value, 2) + ')');
        if (lambdaTag) parts.push(lambdaTag.hint + ' (λ ≈ ' + _sig(lambdaTag.value, 2) + ')');
        clauses.push('The dual-porosity signature shows ' + parts.join(' and ') + '.');
    }
    var lhTag = _findTag(tags, 'Lh') || _findTag(tags, 'Llat');
    if (lhTag) clauses.push('Completion length is consistent with ' + lhTag.hint + '.');

    if (_num(phys.rinv)) clauses.push('The test investigated about ' + _sig(phys.rinv, 2) + ' ft from the well.');

    clauses.push(_confidenceStatement(conf) + '.');
    if (!modelKnown) clauses.push('Note: model "' + (modelKey || '?') + '" is not in the PRiSM registry — this is a generic interpretation.');
    return clauses.join(' ');
};

function _headline(skin, tags, modelKey, fitMeta) {
    var parts = [];
    var st = _findSkinTag(tags);
    fitMeta = fitMeta || {};
    if (fitMeta.mode === 'scale') {
        parts.push(_plainName(modelKey));
        parts.push('skin not identifiable (enter φ, ct, rw)');
    } else if (st) {
        var q = st.qualitative;
        var label = /damaged/.test(q) ? _capitalize(q) + ' well' : (/stimulated/.test(q) ? _capitalize(q) + ' well' : 'No significant skin');
        parts.push(label + ' (S ' + (_num(skin.S_total) ? skin.S_total.toFixed(1) : _sig(st.value, 2)) + ')');
    } else {
        parts.push(_plainName(modelKey));
    }
    if (_num(skin.FE) && skin.FE > 0) parts.push('FE ' + Math.round(100 * skin.FE) + '%');
    if (fitMeta.mode !== 'scale' && Array.isArray(fitMeta.inputsDefaulted) && fitMeta.inputsDefaulted.length) {
        parts.push('based on default ' + fitMeta.inputsDefaulted.join(', '));
    }
    var b = _findBoundaryTags(tags).filter(function (t) { return t.severity === 'important' && t.identifiable !== false; })[0];
    if (b) parts.push((BOUNDARY_KEYS[b.param] || 'boundary').toLowerCase() + ' detected');
    return parts.join(' · ');
}


// ════════════════════════════════════════════════════════════════════
// SECTION 7 — PUBLIC API: PRiSM_interpretFit
// ════════════════════════════════════════════════════════════════════

G.PRiSM_interpretFit = function PRiSM_interpretFit(modelKey, params, CI95, fitMeta) {
    params = params || {};
    CI95 = CI95 || {};
    fitMeta = fitMeta || {};
    var phys = fitMeta.phys || {};
    var ident = fitMeta.identifiable || {};
    var spec = _entry(modelKey);
    var modelKnown = !!spec;
    var tags = [];

    var keys = [];
    if (spec && spec.paramSpec) spec.paramSpec.forEach(function (s) { keys.push(s.key); });
    for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k) && keys.indexOf(k) < 0) keys.push(k);

    var skinScale = fitMeta.mode === 'scale';
    for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var v = params[key];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        // Scale mode: S is not identifiable and Cd is the arbitrary reference value.
        if (skinScale && (key === 'S' || key === 'S_perf' || key === 'S_global' || key === 'Cd')) continue;
        var rule;
        var dFt = phys.distances_ft && phys.distances_ft[key];
        if (BOUNDARY_KEYS.hasOwnProperty(key) && _num(dFt)) rule = _ruleBoundaryL(dFt, BOUNDARY_KEYS[key], true);
        else rule = _ruleForKey(key, v);
        if (!rule) continue;
        var range = CI95[key] ? CI95[key] : [NaN, NaN];
        tags.push(_makeTag(key, v, range, rule, ident.hasOwnProperty(key) ? { identifiable: ident[key] } : null));
    }
    // kh tag from the physical results.
    if (_num(phys.kh) && !_findTag(tags, 'kh')) {
        var khRule = _ruleForKey('kh', phys.kh);
        if (khRule) tags.push(_makeTag('kh', phys.kh, CI95.kh || [NaN, NaN], khRule));
    }

    var skin = _skinAnalysis(modelKey, params, fitMeta);
    // Mechanical-skin tag when it differs from the fitted skin (pseudo-skin present).
    if (skin.hasPseudo && _num(skin.S_mech)) {
        var smRule = _ruleForKey('S_mech', skin.S_mech);
        if (smRule) tags.unshift(_makeTag('S_mech', skin.S_mech, [NaN, NaN], smRule));
    }
    // Combined skin tag when the model splits skin (S_perf + S_global) or only
    // the physical results carry S.
    if (!_findTag(tags, 'S') && !_findTag(tags, 'S_mech') && _num(skin.S_mech)) {
        var sRule = _ruleForKey('S', skin.S_mech);
        if (sRule) tags.unshift(_makeTag('S', skin.S_mech, CI95.S || [NaN, NaN], sRule));
    }

    var confidence = _confidenceLevel(tags, fitMeta);
    var cautions = _buildCautions(tags, fitMeta, modelKnown, modelKey, skin);
    var narrative = G.PRiSM_buildNarrative(tags, modelKey, {
        confidence: confidence, phys: phys, ci95: CI95, identifiable: ident, skin: skin });

    var actions = _skinActions(skin, modelKey, params).concat(_actionsForTags(tags));
    // Reassurance only when EVERY skin term is acceptable.
    var skinTags = tags.filter(function (t) { return SKIN_KEYS[t.param]; });
    var allSkinOk = skinTags.length > 0 &&
        skinTags.every(function (t) { return t.severity === 'good' || t.severity === 'normal'; }) &&
        _num(skin.S_mech) && skin.S_mech < 2 &&
        !(_num(skin.FE) && skin.FE < 0.5) &&
        !(_num(skin.S_total) && skin.S_total < -4 && _isRadialModel(modelKey, params)) &&
        !(_num(skin.Sf) && skin.Sf > 0.5);
    if (allSkinOk) actions.push('Skin is acceptable; no immediate workover indicated');

    for (var bi = 0; bi < tags.length; bi++) {
        var t = tags[bi];
        if (BOUNDARY_KEYS.hasOwnProperty(t.param)) {
            var w = _ciFractionalWidth(t.value, t.range);
            if (isFinite(w) && w > 0.10) {
                actions.push('Extend the test or re-run the buildup at higher resolution to better constrain ' + t.param +
                             ' (currently ±' + _prose(0.5 * (t.range[1] - t.range[0])) + ')');
                break;
            }
        }
    }

    return {
        tags: tags, narrative: narrative, headline: _headline(skin, tags, modelKey, fitMeta),
        actions: actions, confidence: confidence, cautions: cautions,
        skin: { S_total: skin.S_total, S_pseudo: skin.S_pseudo, S_mech: skin.S_mech, Sf: skin.Sf,
                FE: skin.FE, DR: skin.DR, dpS: skin.dpS, J: skin.J, J_ideal: skin.J_ideal, rwEff: skin.rwEff },
        modelKey: modelKey, modelName: _plainName(modelKey), source: fitMeta.source || null,
        timestamp: new Date().toISOString()
    };
};

function _buildCautions(tags, fitMeta, modelKnown, modelKey, skin) {
    var cautions = [];
    if (!modelKnown) cautions.push('Model "' + (modelKey || '?') + '" is not in the PRiSM registry — interpretation is generic.');
    if (fitMeta.stale) cautions.push('The fit is out of date (data or model changed since it was run) — re-run the fit.');
    if (fitMeta.converged === false) cautions.push('The fit did not converge — values are a starting point, not a result.');
    if (fitMeta.mode === 'scale') cautions.push('Well inputs are incomplete — skin cannot be identified without φ, ct and rw.');
    if (isFinite(fitMeta.iterations)) {
        var iters = Math.round(fitMeta.iterations);
        if (isFinite(fitMeta.dAIC) && fitMeta.secondModelKey) {
            cautions.push('Fit converged in ' + iters + ' iterations; AIC prefers ' + _plainName(modelKey) + ' over ' +
                          _plainName(fitMeta.secondModelKey) + ' by ' + _prose(fitMeta.dAIC) + '.');
        } else {
            cautions.push('Fit finished in ' + iters + ' iterations.');
        }
    }
    if (isFinite(fitMeta.r2) && fitMeta.r2 < 0.99 && fitMeta.r2 >= 0.95) {
        cautions.push('Residual structure remains (R² ' + fitMeta.r2.toFixed(3) + ') — a second mechanism may be present.');
    }
    if (isFinite(fitMeta.lateRMSE) && fitMeta.lateRMSE > 0.02) {
        cautions.push('Late-time data show ~' + _prose(100 * fitMeta.lateRMSE) + '% RMSE — a boundary may lie beyond the fitted model.');
    }
    if (tags.some(function (t) { var w = _ciFractionalWidth(t.value, t.range); return isFinite(w) && w > 1.0; })) {
        cautions.push('At least one parameter has a range wider than its value — interpret with care.');
    }
    var unresolved = tags.filter(function (t) { return t.identifiable === false; }).map(function (t) { return t.param; });
    if (unresolved.length) cautions.push('Not resolved by the data: ' + unresolved.join(', ') + '.');
    if (skin && skin.hasPseudo) cautions.push('Actions are based on the mechanical skin, not the total skin.');
    if (Array.isArray(fitMeta.warnings)) fitMeta.warnings.forEach(function (w) {
        if (typeof w === 'string' && cautions.indexOf(w) < 0 && !/^Not resolved/.test(w)) cautions.push(w);
    });
    return cautions;
}


// ════════════════════════════════════════════════════════════════════
// SECTION 8 — CURRENT FIT (reads the normalised lastFit)
// ════════════════════════════════════════════════════════════════════

function _normaliseFit(lf) {
    if (!lf) return null;
    var f = {};
    for (var k in lf) if (Object.prototype.hasOwnProperty.call(lf, k)) f[k] = lf[k];
    if (!_num(f.r2) && _num(f.R2)) f.r2 = f.R2;
    if (!_num(f.rmse) && _num(f.RMSE)) f.rmse = f.RMSE;
    if (!_num(f.aic) && _num(f.AIC)) f.aic = f.AIC;
    if (!f.ci95 && f.CI95) f.ci95 = f.CI95;
    if (!f.modelKey && f.model) f.modelKey = f.model;
    return f;
}

function _currentWell() {
    if (typeof G.PRiSM_getWell === 'function') {
        try { var w = G.PRiSM_getWell(); if (w) return w; } catch (e) { /* fall back */ }
    }
    var pvt = G.PRiSM_pvt || {}, c = pvt._computed || {};
    var ds = G.PRiSM_dataset;
    var qd = NaN;
    if (ds && ds.q && ds.q.length) {
        var qs = []; for (var i = 0; i < ds.q.length; i++) if (_pos(ds.q[i])) qs.push(ds.q[i]);
        qs.sort(function (a, b) { return a - b; });
        if (qs.length) qd = qs[qs.length >> 1];
    }
    var prov = pvt.provenance && pvt.provenance.p_res;
    return {
        q: _pos(qd) ? qd : pvt.q, B: _pos(pvt.Bo) ? pvt.Bo : c.B, mu: _pos(pvt.mu_o) ? pvt.mu_o : c.mu,
        ct: _pos(pvt.ct) ? pvt.ct : c.ct, h: pvt.h, phi: pvt.phi, rw: pvt.rw,
        pi: (prov === 'user' || prov === 'sample' || prov === 'deconvolution') ? pvt.p_res : null,
        testType: pvt.testType || 'auto', pwf0: pvt.pwf0
    };
}

// Flowing pressure used for FE: last flowing pressure (drawdown) or pwf at shut-in (buildup).
function _pwfFor(testType, well, lf) {
    if (lf && _num(lf.pwf)) return lf.pwf;
    var ds = G.PRiSM_dataset;
    if (testType === 'buildup' || testType === 'falloff') {
        if (_num(well.pwf0)) return well.pwf0;
        if (lf && lf.pRefSource === 'pwf0' && _num(lf.pRef)) return lf.pRef;
        return NaN;
    }
    if (ds && ds.p && ds.p.length) {
        for (var i = ds.p.length - 1; i >= 0; i--) if (_num(ds.p[i])) return ds.p[i];
    }
    return NaN;
}

G.PRiSM_interpretCurrentFit = function PRiSM_interpretCurrentFit() {
    var st = G.PRiSM_state;
    var lf = null;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; }
    }
    if (!lf && st) lf = st.lastFit;
    lf = _normaliseFit(lf);
    var modelKey = (st && st.model) || null;
    var params, ci, fitMeta;
    if (lf && lf.params) {
        if (lf.kind === 'rate') return null;             // decline results are interpreted by 35
        modelKey = lf.modelKey || modelKey;
        params = lf.params;
        ci = lf.ci95 || {};
        var well = _currentWell() || {};
        var testType = (lf.testType) || (well.testType && well.testType !== 'auto' ? well.testType : null) || 'drawdown';
        fitMeta = {
            r2: lf.r2,
            // Margin to the runner-up (the applied auto-match row carries dAICnext).
            dAIC: _num(lf.dAICnext) ? lf.dAICnext : NaN,
            secondModelKey: lf.secondModelKey,
            iterations: lf.iterations, lateRMSE: lf.lateRMSE,
            converged: (lf.converged === false) ? false : undefined,
            phys: lf.phys || (st && st.phys) || {},
            identifiable: lf.identifiable || {},
            well: well, testType: testType,
            pbar: (lf.phys && _num(lf.phys.pi)) ? lf.phys.pi : (_num(lf.pRef) && (lf.pRefSource === 'pi' || lf.pRefSource === 'floated') ? lf.pRef : well.pi),
            pwf: _pwfFor(testType, well, lf),
            source: lf.source, stale: !!lf.stale, mode: lf.mode, warnings: lf.warnings,
            inputsDefaulted: lf.inputsDefaulted,
            geom: (st && (st.skinGeom || (st.semilog && st.semilog.geom))) || null,
            D: (st && st.semilog && _num(st.semilog.D)) ? st.semilog.D : undefined
        };
    } else if (st && st.params) {
        params = st.params; ci = {}; fitMeta = { phys: st.phys || {}, source: 'manual' };
    } else {
        return null;
    }
    return G.PRiSM_interpretFit(modelKey, params, ci, fitMeta);
};

// Recompute and store st.interp (read by the results rail and the report).
G.PRiSM_refreshInterpretation = function PRiSM_refreshInterpretation() {
    var interp = null;
    try { interp = G.PRiSM_interpretCurrentFit(); } catch (e) { interp = null; }
    if (G.PRiSM_state && typeof G.PRiSM_state === 'object') G.PRiSM_state.interp = interp;
    return interp;
};

if (typeof G.addEventListener === 'function' && !G.__prismInterpListeners) {
    G.__prismInterpListeners = true;
    ['prism:fit-updated', 'prism:well-changed'].forEach(function (evName) {
        G.addEventListener(evName, function () { G.PRiSM_refreshInterpretation(); });
    });
}


// ════════════════════════════════════════════════════════════════════
// SECTION 9 — UI RENDER
// ════════════════════════════════════════════════════════════════════

var PANEL_CSS =
    '.prism-interp{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px;color:var(--text);font-size:13px;line-height:1.5;min-width:0;overflow-wrap:anywhere}' +
    '.prism-interp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}' +
    '.prism-interp-title{font-weight:700;font-size:14px}' +
    '.prism-interp-chip{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;border:1px solid var(--border);color:var(--text2)}' +
    '.prism-interp-chip--high{color:var(--green);border-color:var(--green)}' +
    '.prism-interp-chip--medium{color:var(--blue);border-color:var(--blue)}' +
    '.prism-interp-chip--low{color:var(--yellow);border-color:var(--yellow)}' +
    '.prism-interp-headline{font-weight:600;margin-bottom:6px}' +
    '.prism-interp-text{padding:8px 10px;background:var(--bg1);border-left:3px solid var(--accent);border-radius:4px;margin-bottom:10px}' +
    '.prism-interp-h{font-weight:600;font-size:11px;color:var(--text3);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.5px}' +
    '.prism-interp-tags{display:flex;flex-wrap:wrap;gap:6px}' +
    '.prism-interp-tag{display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;border:1px solid var(--border);color:var(--text2);max-width:100%}' +
    '.prism-interp-tag--good{color:var(--green);border-color:var(--green)}' +
    '.prism-interp-tag--warning{color:var(--yellow);border-color:var(--yellow)}' +
    '.prism-interp-tag--important{color:var(--red);border-color:var(--red)}' +
    '.prism-interp ul{margin:0;padding-left:18px}' +
    '.prism-interp-cautions{color:var(--text2);font-size:12px}';

function _ensureCss() {
    if (!_hasDoc || !document.getElementById || !document.createElement) return;
    if (document.getElementById('prism_interp_css')) return;
    var s = document.createElement('style');
    s.id = 'prism_interp_css';
    s.textContent = PANEL_CSS;
    var head = document.head || document.body;
    if (head && head.appendChild) head.appendChild(s);
}

function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

G.PRiSM_renderInterpretationPanel = function PRiSM_renderInterpretationPanel(container, interp) {
    if (!_hasDoc || !container) return;
    _ensureCss();
    if (interp === undefined) {
        var st = G.PRiSM_state;
        interp = (st && st.interp) || G.PRiSM_refreshInterpretation();
    }
    if (!interp) {
        container.innerHTML = '<div class="prism-interp"><em style="color:var(--text3);">No interpretation yet — fit a model first.</em></div>';
        return;
    }
    var conf = interp.confidence || 'medium';
    var h = [];
    h.push('<div class="prism-interp" id="prism_interp_body">');
    h.push('<div class="prism-interp-head"><span class="prism-interp-title">Interpretation</span>' +
           '<span class="prism-interp-chip prism-interp-chip--' + _esc(conf) + '">' + _esc(CONF_LABEL[conf] || conf) + '</span></div>');
    if (interp.headline) h.push('<div class="prism-interp-headline">' + _esc(interp.headline) + '</div>');
    h.push('<div class="prism-interp-text">' + _esc(interp.narrative || '') + '</div>');
    if (interp.tags && interp.tags.length) {
        h.push('<div class="prism-interp-h">Findings</div><div class="prism-interp-tags">');
        interp.tags.forEach(function (t) {
            var sev = t.severity === 'good' || t.severity === 'warning' || t.severity === 'important' ? ' prism-interp-tag--' + t.severity : '';
            h.push('<span class="prism-interp-tag' + sev + '">' + _esc(t.param) + ' ' + _esc(_sig(t.value, 3)) + ' — ' + _esc(t.qualitative) + '</span>');
        });
        h.push('</div>');
    }
    if (interp.actions && interp.actions.length) {
        h.push('<div class="prism-interp-h">Suggested actions</div><ul>');
        interp.actions.forEach(function (a) { h.push('<li>' + _esc(a) + '</li>'); });
        h.push('</ul>');
    }
    if (interp.cautions && interp.cautions.length) {
        h.push('<div class="prism-interp-h">Cautions &amp; fit notes</div><ul class="prism-interp-cautions">');
        interp.cautions.forEach(function (c) { h.push('<li>' + _esc(c) + '</li>'); });
        h.push('</ul>');
    }
    h.push('</div>');
    container.innerHTML = h.join('');
};

// Tab 6 panel (contract C7): shown once a fit exists.
function _hasFit() {
    var st = G.PRiSM_state;
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { var lf = G.PRiSM_getLastFit(); if (lf && lf.params) return true; } catch (e) { /* ignore */ }
    }
    return !!(st && st.lastFit && st.lastFit.params);
}
var INTERP_PANEL = {
    id: 'prism_interp_panel', title: 'Interpretation', order: 30,
    when: _hasFit,
    render: function (hostEl) { G.PRiSM_renderInterpretationPanel(hostEl); }
};
(function _registerPanel() {
    try {
        if (typeof G.PRiSM_registerTabPanel === 'function') { G.PRiSM_registerTabPanel(6, INTERP_PANEL); return; }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var list = G.PRiSM_tabPanels[6] = G.PRiSM_tabPanels[6] || [];
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === INTERP_PANEL.id) return;
        list.push(INTERP_PANEL);
    } catch (e) { /* silent */ }
})();

G.PRiSM_formatWithCI = PRiSM_formatWithCI;


// ════════════════════════════════════════════════════════════════════
// SECTION 10 — SELF-TEST
// ════════════════════════════════════════════════════════════════════

})();

// ─── END 14-interpretation ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 15-diagnostic-annotations ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 15 — Flow-regime markers + derivative smoothing (L)
//   • Auto-pick the Bourdet smoothing L from the gauge noise level
//   • Detect flow-regime transitions and mark them on the log-log plot
//
// PUBLIC API (all on window.*)
//   PRiSM_autoBourdet_L(t, p, q?)            → { L, noiseLevel, noiseEstimate, rationale, alternatives[] }
//   PRiSM_detectAnnotations(t, p, deriv?)    → [{ type, td, label, priority }, ...]  (sorted by td)
//   PRiSM_detectAnnotationsForData(adata)    → same, from C2 analysis data {t, dp, deriv}
//   PRiSM_drawPlotAnnotations(canvas, annotations, plotKey, axes?) → void
//   PRiSM_enableAutoAnnotations(enabled?)    → void  (default true)
//   PRiSM_renderAnnotationToolbar(host)      → void  (Tab 2 panel body)
//
// MOUNTING (C7 — no polling, no function wrapping)
//   • Post-draw hook in window.PRiSM_postDrawHooks draws the markers after
//     every PRiSM_drawActivePlot, from the same data (and L) as the plot.
//   • Tab 2 panel "Flow-regime markers" (PRiSM_registerTabPanel or the
//     PRiSM_tabPanels registry). L is stored in PRiSM_state.bourdetL.
//
// DETECTION
//   • Prefers the regime classifier (PRiSM_classifyRegimes → raw.regimes),
//     falls back to a local log-log slope detector.
//   • Storage-hump guard: a −½ slope is only reported as spherical flow when
//     it starts more than 1.5 log cycles after the derivative maximum, or is
//     preceded by a flat (radial) segment. Otherwise it is the falling limb
//     of the wellbore-storage hump of a damaged well.
//
// Δp is sign-aware (CLAUDE.md): Δp = sign·(p − p0), sign = +1 buildup, −1 drawdown.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined') && !!document && typeof document.createElement === 'function';
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // Theme palette — the plot layer's theme when available, else the dark defaults.
    function _theme() {
        /* global PRiSM_THEME */
        if (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME && typeof PRiSM_THEME === 'object') return PRiSM_THEME;
        if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
        return {
            bg: '#0d1117', panel: '#161b22', border: '#30363d', grid: '#21262d', gridMajor: '#30363d',
            text: '#c9d1d9', text2: '#8b949e', text3: '#6e7681', accent: '#f0883e', blue: '#58a6ff',
            green: '#3fb950', red: '#f85149', yellow: '#d29922', cyan: '#39c5cf', purple: '#bc8cff'
        };
    }

    function _defaultPad() { return { top: 30, right: 80, bottom: 48, left: 64 }; }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    function _num(v) { return typeof v === 'number' && isFinite(v); }

    function _esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _on(target, type, fn) {
        try { if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn); }
        catch (e) { /* stub environments */ }
    }

    function _registerTabPanel(n, spec) {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall back */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var arr = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === spec.id) { arr[i] = spec; return; }
        arr.push(spec);
    }

    function _registerPostDraw(fn) {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fn._prismId) { hooks[i] = fn; return; }
        hooks.push(fn);
    }

    function _redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }

    // Bourdet derivative (3-point, window L in ln t).
    function _bourdet(t, dp, L) {
        if (typeof G.PRiSM_compute_bourdet === 'function') {
            try {
                var r = G.PRiSM_compute_bourdet(t, dp, L);
                if (r && r.length === t.length) return r;
            } catch (e) { /* inline fallback */ }
        }
        L = L || 0;
        var n = t.length, d = new Array(n), k;
        for (k = 0; k < n; k++) d[k] = NaN;
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
            d[i] = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT) + (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
        }
        return d;
    }

    // Analysis data (C2) with a sign-aware local fallback.
    function _analysisData() {
        var st = G.PRiSM_state || {};
        var L = _num(st.bourdetL) ? st.bourdetL : 0.15;
        if (typeof G.PRiSM_getAnalysisData === 'function') {
            try {
                var o = { L: L };
                if (_num(st.activePeriod) && st.activePeriod >= 0) o.period = st.activePeriod;
                if (st.timeFn) o.timeFn = st.timeFn;
                var ad = G.PRiSM_getAnalysisData(G.PRiSM_dataset, o);
                if (ad && ad.ok && ad.t && ad.t.length) return ad;
            } catch (e) { /* fall back */ }
        }
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t || !ds.p || ds.t.length < 5) return { ok: false, t: [], dp: [], deriv: [] };
        var n = ds.t.length, p0 = ds.p[0];
        var sign = (ds.p[n - 1] - p0) >= 0 ? 1 : -1;
        var t = [], p = [], dp = [];
        for (var i = 0; i < n; i++) {
            if (!(ds.t[i] > 0) || !_num(ds.p[i])) continue;
            t.push(ds.t[i]); p.push(ds.p[i]); dp.push(sign * (ds.p[i] - p0));
        }
        return { ok: t.length >= 5, t: t, p: p, dp: dp, deriv: _bourdet(t, dp, L), L: L,
                 pRefSource: 'first-sample', testType: sign > 0 ? 'buildup' : 'drawdown' };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — NOISE-LEVEL ESTIMATOR + L PICKER
    // ═══════════════════════════════════════════════════════════════
    //
    // Gauge noise = RMS(p − 5-point moving average) / mean|p|  (relative).
    // Map noise band → L:
    //   noise < 0.001 → L = 0.10  (clean)
    //   0.001-0.005   → L = 0.18  (typical)
    //   0.005-0.02    → L = 0.30  (noisy)
    //   > 0.02        → L = 0.50  (very noisy)
    // ═══════════════════════════════════════════════════════════════

    function _movingAverage(p, win) {
        var n = p.length, out = new Array(n);
        if (n === 0) return out;
        var half = Math.max(1, Math.floor(win / 2));
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - half), i1 = Math.min(n - 1, i + half), sum = 0, cnt = 0;
            for (var j = i0; j <= i1; j++) if (isFinite(p[j])) { sum += p[j]; cnt++; }
            out[i] = cnt > 0 ? sum / cnt : NaN;
        }
        return out;
    }

    function _meanAbs(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) { s += Math.abs(arr[i]); n++; }
        return n > 0 ? s / n : 0;
    }

    function _rms(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) { s += arr[i] * arr[i]; n++; }
        return n > 0 ? Math.sqrt(s / n) : 0;
    }

    function _estimateNoise(p) {
        if (!p || p.length < 5) return 0;
        var smooth = _movingAverage(p, 5), resid = new Array(p.length);
        for (var i = 0; i < p.length; i++) {
            resid[i] = (isFinite(p[i]) && isFinite(smooth[i])) ? (p[i] - smooth[i]) : NaN;
        }
        var mean = _meanAbs(p);
        return mean === 0 ? 0 : _rms(resid) / mean;
    }

    function _pickL(noise) {
        if (!isFinite(noise) || noise <= 0) return { L: 0.18, level: 'low' };
        if (noise < 0.001) return { L: 0.10, level: 'low' };
        if (noise < 0.005) return { L: 0.18, level: 'low' };
        if (noise < 0.02)  return { L: 0.30, level: 'medium' };
        return { L: 0.50, level: 'high' };
    }

    function _rationale(level, noise, L) {
        var pct = (noise * 100).toFixed(2);
        if (level === 'low' && L <= 0.12) return 'Very clean gauge data (~' + pct + '% RMS of mean pressure) — minimal smoothing L=' + L.toFixed(2) + ' preserves regime transitions.';
        if (level === 'low')    return 'Low noise floor (~' + pct + '% of mean pressure) — small L=' + L.toFixed(2) + ' preserves regime transitions.';
        if (level === 'medium') return 'Moderate noise (~' + pct + '% of mean pressure) — standard smoothing L=' + L.toFixed(2) + ' balances detail and noise rejection.';
        return 'Heavy noise (~' + pct + '% of mean pressure) — large L=' + L.toFixed(2) + ' suppresses gauge jitter; sharp transitions may be smeared.';
    }

    var _ALTERNATIVES = [
        { L: 0.10, description: 'minimal smoothing (preserves all features, may be noisy)' },
        { L: 0.30, description: 'standard smoothing (balanced)' },
        { L: 0.50, description: 'heavy smoothing (clean curve, may hide transitions)' }
    ];

    G.PRiSM_autoBourdet_L = function PRiSM_autoBourdet_L(t, p, q) {
        var fallback = { L: 0.18, noiseLevel: 'low', noiseEstimate: 0,
                         rationale: 'Default smoothing L=0.18 (no pressure data supplied).',
                         alternatives: _ALTERNATIVES.slice() };
        try {
            if (!t || !p || typeof p.length !== 'number' || p.length < 5) return fallback;
            var noise = _estimateNoise(p), pick = _pickL(noise);
            return { L: pick.L, noiseLevel: pick.level, noiseEstimate: noise,
                     rationale: _rationale(pick.level, noise, pick.L), alternatives: _ALTERNATIVES.slice() };
        } catch (e) {
            return fallback;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — REGIME-TRANSITION DETECTOR
    // ═══════════════════════════════════════════════════════════════

    var LABELS = {
        wellboreStorageEnd:   'Storage ends',
        radialFlowStart:      'Radial flow',
        linearFlowStart:      '½-slope (linear flow)',
        bilinearFlowStart:    '¼-slope (bilinear flow)',
        bilinearToLinear:     'Bilinear → linear',
        sphericalFlow:        '−½ slope (spherical flow)',
        storageHump:          'Storage hump',
        boundaryHit:          'Boundary effect',
        closedBoundaryHit:    'Closed boundary',
        constPressureHit:     'Pressure support',
        sealingFault:         'Derivative doubling (fault)',
        doublePorosityValley: 'Dual-porosity dip'
    };

    // Classifier regime tag → marker type.
    var TAG_TYPE = {
        radialFlow: 'radialFlowStart', linearFlow: 'linearFlowStart', bilinearFlow: 'bilinearFlowStart',
        sphericalFlow: 'sphericalFlow', constPressure: 'constPressureHit', closedBoundary: 'closedBoundaryHit',
        sealingFault: 'sealingFault', doublePorosity: 'doublePorosityValley', storageHump: 'storageHump',
        wellboreStorage: 'wellboreStorage'
    };

    function _typePriority(type) {
        if (type === 'wellboreStorageEnd' || type === 'radialFlowStart') return 1;
        if (type === 'boundaryHit' || type === 'closedBoundaryHit' || type === 'constPressureHit' || type === 'sealingFault') return 2;
        return 3;
    }

    function _typeLabel(type) { return LABELS[type] || String(type); }

    // Smoothed log-log slope at each point (least squares over ±halfWin points).
    function _logLogSlopes(t, y, halfWin) {
        var n = t.length, slopes = new Array(n), k;
        for (k = 0; k < n; k++) slopes[k] = NaN;
        halfWin = halfWin || 2;
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - halfWin), i1 = Math.min(n - 1, i + halfWin);
            var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
            for (var j = i0; j <= i1; j++) {
                if (!isFinite(t[j]) || t[j] <= 0 || !isFinite(y[j]) || y[j] <= 0) continue;
                var lx = Math.log10(t[j]), ly = Math.log10(y[j]);
                sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; m++;
            }
            if (m < 3) continue;
            var denom = m * sxx - sx * sx;
            if (Math.abs(denom) < 1e-12) continue;
            slopes[i] = (m * sxy - sx * sy) / denom;
        }
        return slopes;
    }

    function _classifyKick(sBefore, sAfter) {
        if (!isFinite(sBefore) || !isFinite(sAfter)) return null;
        if (sBefore > 0.55 && sAfter < 0.30 && sAfter > -0.30) return { type: 'wellboreStorageEnd' };
        if (sBefore < -0.20 && Math.abs(sAfter) < 0.15)        return { type: 'radialFlowStart' };   // end of a hump or of spherical flow
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.35 && sAfter < 0.65) return { type: 'boundaryHit' };
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.75) return { type: 'closedBoundaryHit' };
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter < -0.30) return { type: 'sphericalFlow' };
        if (sBefore > 0.35 && sBefore < 0.65 && sAfter > -0.20 && sAfter < 0.30) return { type: 'radialFlowStart' };
        if (sBefore > 0.15 && sBefore < 0.40 && sAfter > 0.40 && sAfter < 0.65) return { type: 'bilinearToLinear' };
        return null;
    }

    function _mk(type, td, extra) {
        var a = { type: type, td: td, label: _typeLabel(type), priority: _typePriority(type) };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) a[k] = extra[k];
        return a;
    }

    function _findKicks(t, slopes) {
        var n = t.length, out = [];
        for (var i = 1; i < n - 1; i++) {
            if (!isFinite(slopes[i]) || !isFinite(slopes[i - 1])) continue;
            var sBefore = slopes[Math.max(0, i - 5)], sAfter = slopes[Math.min(n - 1, i + 5)];
            if (!isFinite(sBefore) || !isFinite(sAfter)) continue;
            if (Math.abs(sAfter - sBefore) < 0.3) continue;
            var k = _classifyKick(sBefore, sAfter);
            if (!k) continue;
            out.push(_mk(k.type, t[i], { tdStart: t[i], source: 'local' }));
        }
        return out;
    }

    // Sustained runs with slope < −0.3 (≥ 4 points) → candidate spherical flow.
    function _findSphericalRun(t, slopes) {
        var n = t.length, out = [], runStart = -1, runLen = 0;
        function flush() {
            if (runLen >= 4 && runStart >= 0) {
                var mid = runStart + Math.floor(runLen / 2);
                if (t[mid] > 0) out.push(_mk('sphericalFlow', t[mid], { tdStart: t[runStart], source: 'local' }));
            }
            runStart = -1; runLen = 0;
        }
        for (var i = 0; i < n; i++) {
            if (isFinite(slopes[i]) && slopes[i] < -0.30) { if (runStart < 0) runStart = i; runLen++; }
            else flush();
        }
        flush();
        return out;
    }

    // Storage-hump guard. True when a −½ segment starting at tStart is real
    // spherical flow: it starts > 1.5 log cycles after the derivative maximum,
    // or a flat (radial) run of ≥ 3 points spanning ≥ 0.2 cycle precedes it.
    function _isRealSpherical(t, deriv, slopes, tStart) {
        var iMax = -1, vMax = -Infinity, iStart = -1;
        for (var i = 0; i < t.length; i++) {
            if (!(t[i] > 0) || !(t[i] <= tStart * (1 + 1e-9))) continue;
            iStart = i;
            if (deriv[i] > 0 && deriv[i] > vMax) { vMax = deriv[i]; iMax = i; }
        }
        if (iMax < 0) return false;
        if (Math.log10(tStart) - Math.log10(t[iMax]) > 1.5) return true;
        var run = 0, runT0 = 0;
        for (var j = iMax; j <= iStart; j++) {
            if (isFinite(slopes[j]) && Math.abs(slopes[j]) < 0.1) {
                if (run === 0) runT0 = t[j];
                run++;
                if (run >= 3 && Math.log10(t[j]) - Math.log10(runT0) >= 0.2) return true;
            } else {
                run = 0;
            }
        }
        return false;
    }

    function _humpGuard(t, deriv, anns) {
        var slopes = null;
        return anns.map(function (a) {
            if (!a || a.type !== 'sphericalFlow') return a;
            slopes = slopes || _logLogSlopes(t, deriv, 2);
            var tStart = _num(a.tdStart) ? a.tdStart : a.td;
            if (_isRealSpherical(t, deriv, slopes, tStart)) return a;
            return _mk('storageHump', a.td, { tdStart: tStart, source: a.source });
        });
    }

    // Classifier output → markers. Accepts { regimes:[{tag, tdStart, tdEnd,
    // confidence}] } (segments) and older transition-list shapes.
    function _fromClassifier(raw) {
        if (!raw) return null;
        if (!Array.isArray(raw.regimes)) {
            var arr = Array.isArray(raw) ? raw : (Array.isArray(raw.transitions) ? raw.transitions
                    : (Array.isArray(raw.annotations) ? raw.annotations : null));
            if (!arr) return null;
            var legacy = [];
            for (var i = 0; i < arr.length; i++) {
                var e = arr[i];
                if (!e) continue;
                var td = (e.td != null) ? e.td : (e.t != null) ? e.t : e.time;
                if (!isFinite(td) || td <= 0) continue;
                var type = String(e.type || e.regime || e.name || 'transition');
                legacy.push({ type: type, td: Number(td), tdStart: Number(td),
                              label: String(e.label || e.description || _typeLabel(type)),
                              priority: Number(e.priority != null ? e.priority : _typePriority(type)), source: 'classifier' });
            }
            return legacy;
        }
        function sure(r) { return r.confidence == null || r.confidence >= 0.45; }
        var segs = raw.regimes.filter(function (r) {
            return r && r.tag && r.tag !== 'unknown' && _num(r.tdStart) && r.tdStart > 0 &&
                   (r.confidence == null || r.confidence >= 0.3);
        });
        var shapes = segs.filter(function (r) { return (r.tag === 'sealingFault' || r.tag === 'doublePorosity') && sure(r); });
        var all = segs.filter(function (r) { return r.tag !== 'sealingFault' && r.tag !== 'doublePorosity'; })
                      .sort(function (a, b) { return a.tdStart - b.tdStart; });
        // Keep confident segments, plus weaker ones that run into a confident
        // segment of the same regime (so a regime is marked where it starts).
        var seq = all.filter(function (r, i) {
            if (sure(r)) return true;
            for (var j = i + 1; j < all.length && all[j].tag === r.tag; j++) if (sure(all[j])) return true;
            return false;
        });
        var out = [], prevTag = null;
        for (var k = 0; k < seq.length; k++) {
            var r = seq[k];
            if (r.tag === prevTag) continue;                    // merge consecutive segments
            if (prevTag === null) { prevTag = r.tag; continue; } // no marker at the first data point
            var ty = TAG_TYPE[r.tag] || r.tag;
            if (ty === 'wellboreStorage') { prevTag = r.tag; continue; }
            if (ty === 'radialFlowStart' && (prevTag === 'wellboreStorage' || prevTag === 'storageHump')) {
                out.push(_mk('radialFlowStart', r.tdStart, { tdStart: r.tdStart, source: 'classifier' }));
            } else {
                out.push(_mk(ty, r.tdStart, { tdStart: r.tdStart, tdEnd: r.tdEnd, source: 'classifier' }));
            }
            prevTag = r.tag;
        }
        shapes.forEach(function (r) {
            var tdm = _num(r.tdEnd) && r.tdEnd > 0 ? Math.sqrt(r.tdStart * r.tdEnd) : r.tdStart;
            out.push(_mk(TAG_TYPE[r.tag], tdm, { tdStart: r.tdStart, source: 'classifier' }));
        });
        return out;
    }

    var BOUNDARY_TYPES = { boundaryHit: 1, closedBoundaryHit: 1, constPressureHit: 1, sealingFault: 1 };

    function _dedup(anns) {
        anns.sort(function (a, b) { return a.td - b.td; });
        var out = [];
        for (var i = 0; i < anns.length; i++) {
            var cur = anns[i], skip = false;
            for (var j = 0; j < out.length; j++) {
                var gap = Math.abs(Math.log10(cur.td) - Math.log10(out[j].td));
                if (BOUNDARY_TYPES[cur.type] && BOUNDARY_TYPES[out[j].type] && out[j].type !== cur.type && gap < 0.3) {
                    out[j] = cur;              // keep the later, more specific boundary label
                    skip = true; break;
                }
                if (out[j].type !== cur.type) continue;
                var repeatable = cur.type === 'sphericalFlow' || cur.type === 'storageHump' || cur.type === 'radialFlowStart';
                if (!repeatable || gap < 1.0) { skip = true; break; }
            }
            if (!skip) out.push(cur);
        }
        return out;
    }

    // Core detector on sign-aware Δp and its derivative.
    function _detectCore(t, dp, deriv) {
        var anns = null, source = 'fallback';
        if (typeof G.PRiSM_classifyRegimes === 'function') {
            try {
                anns = _fromClassifier(G.PRiSM_classifyRegimes(t, dp, deriv));
                if (anns && anns.length) source = 'classifyRegimes';
            } catch (e) { anns = null; }
        }
        if (!anns || !anns.length) {
            var slopes = _logLogSlopes(t, deriv, 2);
            anns = _findKicks(t, slopes);
            var spheres = _findSphericalRun(t, slopes);
            for (var s = 0; s < spheres.length; s++) {
                var dup = false;
                for (var m = 0; m < anns.length; m++) {
                    if (anns[m].type !== 'sphericalFlow') continue;
                    var lk = Math.log10(anns[m].td);
                    if (Math.abs(Math.log10(spheres[s].td) - lk) < 0.3 ||
                        Math.abs(Math.log10(spheres[s].tdStart) - lk) < 0.3) { dup = true; break; }
                }
                if (!dup) anns.push(spheres[s]);
            }
            source = 'fallback';
        }
        var out = _dedup(_humpGuard(t, deriv, anns));
        out._source = source;
        return out;
    }

    function _toArr(a) {
        if (!a) return null;
        if (Array.isArray(a)) return a;
        try { return Array.prototype.slice.call(a); } catch (e) { return null; }
    }

    // Legacy signature: (t, p, deriv?) — p is pressure; Δp is sign-aware.
    G.PRiSM_detectAnnotations = function PRiSM_detectAnnotations(t, p, deriv) {
        try {
            t = _toArr(t); p = _toArr(p); deriv = _toArr(deriv);
            if (!t || t.length < 5 || !p || p.length !== t.length) return [];
            var n = t.length, sign = (p[n - 1] - p[0]) >= 0 ? 1 : -1, dp = new Array(n);
            for (var i = 0; i < n; i++) dp[i] = sign * (p[i] - p[0]);
            if (!deriv || deriv.length !== n) {
                deriv = _bourdet(t, dp, G.PRiSM_autoBourdet_L(t, p).L);
            } else {
                deriv = deriv.map(function (v) { return Math.abs(v); });
            }
            return _detectCore(t, dp, deriv);
        } catch (e) {
            try { console.warn('PRiSM_detectAnnotations error:', e && e.message); } catch (_) { /* ignore */ }
            return [];
        }
    };

    // From C2 analysis data {t, dp (≥0), deriv}.
    G.PRiSM_detectAnnotationsForData = function PRiSM_detectAnnotationsForData(ad) {
        try {
            if (!ad || !ad.t || !ad.dp || ad.t.length < 5) return [];
            var t = _toArr(ad.t), dp = _toArr(ad.dp), deriv = _toArr(ad.deriv);
            if (!deriv || deriv.length !== t.length) {
                var st = G.PRiSM_state || {};
                deriv = _bourdet(t, dp, _num(ad.L) ? ad.L : (_num(st.bourdetL) ? st.bourdetL : 0.15));
            }
            return _detectCore(t, dp, deriv);
        } catch (e) {
            return [];
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — MARKER RENDERER
    // ═══════════════════════════════════════════════════════════════
    // Uses the plot's own world→pixel transform (canvas._prismAxes, C6).
    // Markers make sense on plots whose x axis is Δt: log-log derivative and
    // semilog (MDH). Labels are drawn inside the plot box, near its top.
    // ═══════════════════════════════════════════════════════════════

    var ANN_PLOTS = { bourdet: 1, mdh: 1 };

    function _axisFwd(sc, off, len, flip) {
        if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
        if (sc.kind === 'log') {
            if (!(sc.min > 0 && sc.max > 0)) return null;
            var a = Math.log10(sc.min), b = Math.log10(sc.max);
            return function (v) { if (!(v > 0)) return NaN; var f = (Math.log10(v) - a) / (b - a); return flip ? off + len - f * len : off + f * len; };
        }
        return function (v) { var f = (v - sc.min) / (sc.max - sc.min); return flip ? off + len - f * len : off + f * len; };
    }

    function _plotRectFromCanvas(canvas) {
        var cssW = canvas.clientWidth || canvas.width || 600, cssH = canvas.clientHeight || canvas.height || 400;
        if (canvas.style && canvas.style.width) { var w = parseInt(canvas.style.width, 10); if (w > 0) cssW = w; }
        if (canvas.style && canvas.style.height) { var h = parseInt(canvas.style.height, 10); if (h > 0) cssH = h; }
        var pad = _defaultPad();
        return { x: pad.left, y: pad.top, w: Math.max(1, cssW - pad.left - pad.right), h: Math.max(1, cssH - pad.top - pad.bottom) };
    }

    // → { toX, plot, xMin, xMax } or null
    function _xTransform(canvas, axes) {
        var ax = axes || (canvas && canvas._prismAxes) || null;
        if (ax && ax.plot && ax.scaleX) {
            var toX = (typeof ax.toX === 'function') ? ax.toX : _axisFwd(ax.scaleX, ax.plot.x, ax.plot.w, false);
            if (toX) return { toX: toX, plot: ax.plot, xMin: ax.scaleX.min, xMax: ax.scaleX.max, kind: ax.scaleX.kind };
        }
        var os = canvas && canvas._prismOriginalScale;
        if (os && os.x && _num(os.x.min) && _num(os.x.max)) {
            var pr = _plotRectFromCanvas(canvas);
            var fx = _axisFwd({ kind: os.x.kind || 'log', min: os.x.min, max: os.x.max }, pr.x, pr.w, false);
            if (fx) return { toX: fx, plot: pr, xMin: os.x.min, xMax: os.x.max, kind: os.x.kind || 'log' };
        }
        return null;
    }

    function _colorForPriority(priority) {
        var th = _theme();
        if (priority === 1) return th.accent || '#f0883e';
        if (priority === 2) return th.blue || '#58a6ff';
        return th.text2 || '#8b949e';
    }

    G.PRiSM_drawPlotAnnotations = function PRiSM_drawPlotAnnotations(canvas, annotations, plotKey, axes) {
        if (!canvas || !canvas.getContext) return;
        plotKey = plotKey || 'bourdet';
        if (!Array.isArray(annotations) || !annotations.length || !ANN_PLOTS[plotKey]) {
            try { canvas._prismAnnotations = []; } catch (e) { /* ignore */ }
            return;
        }
        if (canvas._prismAnnotationsDrawing) return;          // re-entrancy guard
        canvas._prismAnnotationsDrawing = true;
        try {
            var ctx = canvas.getContext('2d');
            var tr = _xTransform(canvas, axes);
            if (!ctx || !tr) { canvas._prismAnnotations = []; return; }
            var plot = tr.plot, visible = [];
            for (var i = 0; i < annotations.length; i++) {
                var a = annotations[i];
                if (!a || !_num(a.td)) continue;
                if (tr.kind === 'log' && a.td <= 0) continue;
                if (a.td < Math.min(tr.xMin, tr.xMax) || a.td > Math.max(tr.xMin, tr.xMax)) continue;
                var px = tr.toX(a.td);
                if (!_num(px) || px < plot.x - 1 || px > plot.x + plot.w + 1) continue;
                visible.push({ ann: a, px: px });
            }
            canvas._prismAnnotations = visible.slice();
            canvas._prismAnnotationsDrawCount = (canvas._prismAnnotationsDrawCount || 0) + 1;
            ctx.save();
            ctx.font = '11px sans-serif';
            for (var k = 0; k < visible.length; k++) {
                var aa = visible[k].ann, x = visible[k].px, color = _colorForPriority(aa.priority);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(x + 0.5, plot.y);
                ctx.lineTo(x + 0.5, plot.y + plot.h);
                ctx.stroke();
                ctx.setLineDash([]);
                // Rotated label inside the plot box, reading bottom-to-top,
                // ending just below the top edge; alternate sides of the line.
                var text = String(aa.label || aa.type || '');
                var tw = ctx.measureText(text).width || 0;
                var off = (k % 2 === 0) ? -4 : 12;
                ctx.save();
                ctx.translate(x + off, plot.y + 6);
                ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'rgba(13,17,23,0.78)';
                ctx.fillRect(-tw - 2, -7, tw + 4, 13);
                ctx.fillStyle = color;
                ctx.fillText(text, 0, 0);
                ctx.restore();
            }
            ctx.restore();
        } catch (e) {
            try { console.warn('PRiSM_drawPlotAnnotations error:', e && e.message); } catch (_) { /* ignore */ }
        } finally {
            canvas._prismAnnotationsDrawing = false;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — POST-DRAW HOOK (C7)
    // ═══════════════════════════════════════════════════════════════

    if (typeof G.PRiSM_annotationsEnabled === 'undefined') G.PRiSM_annotationsEnabled = true;

    var _cache = { key: null, anns: null };

    function _sig(t, dp, deriv) {
        var n = t.length, mid = Math.floor(n / 2);
        return [n, t[0], t[n - 1], dp[0], dp[n - 1], deriv[mid], deriv[n - 2],
                typeof G.PRiSM_classifyRegimes === 'function' ? 1 : 0].join('|');
    }

    function _annotationsFor(t, dp, deriv) {
        var key = _sig(t, dp, deriv);
        if (_cache.key === key && _cache.anns) return _cache.anns;
        var anns = _detectCore(_toArr(t), _toArr(dp), _toArr(deriv));
        _cache = { key: key, anns: anns };
        return anns;
    }

    function _annotationsPostDraw(info) {
        if (!info || !info.canvas || G.PRiSM_annotationsEnabled === false) return;
        var st = G.PRiSM_state || {};
        var plotKey = info.plotKey || st.activePlot || 'bourdet';
        if (!ANN_PLOTS[plotKey]) return;
        var d = info.data, t, dp, deriv;
        if (d && d.t && d.dp && d.deriv && d.t.length >= 5 && d.dp.length === d.t.length && d.deriv.length === d.t.length) {
            t = d.t; dp = d.dp; deriv = d.deriv;         // exactly what the plot shows (same L)
        } else {
            var ad = _analysisData();
            if (!ad || !ad.ok || !ad.deriv) return;
            t = ad.t; dp = ad.dp; deriv = ad.deriv;
        }
        var anns = _annotationsFor(t, dp, deriv);
        G.PRiSM_drawPlotAnnotations(info.canvas, anns, plotKey, info.axes || info.canvas._prismAxes);
    }
    _annotationsPostDraw._prismId = 'flow-regime-markers';
    _registerPostDraw(_annotationsPostDraw);

    G.PRiSM_enableAutoAnnotations = function PRiSM_enableAutoAnnotations(enabled) {
        G.PRiSM_annotationsEnabled = (typeof enabled === 'undefined') ? true : !!enabled;
        _redraw();
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — TAB 2 PANEL: "Flow-regime markers"
    // ═══════════════════════════════════════════════════════════════

    function _currentL() {
        var st = G.PRiSM_state || {};
        return _num(st.bourdetL) ? st.bourdetL : 0.15;
    }

    function _setL(L) {
        var st = G.PRiSM_state;
        if (!st) return;
        st.bourdetL = Math.max(0, Math.min(0.5, L));
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* ignore */ } }
    }

    function _fmtT(t) {
        if (!_num(t)) return '—';
        if (t >= 100) return t.toFixed(0);
        if (t >= 1) return t.toPrecision(3).replace(/\.?0+$/, '');
        return t.toPrecision(2);
    }

    function _detectedText() {
        var ad = _analysisData();
        if (!ad || !ad.ok) return 'No pressure data to analyse.';
        var anns = _annotationsFor(ad.t, ad.dp, ad.deriv);
        if (!anns.length) return 'No clear flow-regime transition detected.';
        return 'Detected: ' + anns.map(function (a) { return a.label + ' (' + _fmtT(a.td) + ' hr)'; }).join(' · ');
    }

    function _updateInfo(host, info) {
        var line = host.querySelector('#prism_ann_infoline');
        if (line) {
            line.textContent = info ? ('Noise: ' + info.noiseLevel + ' (~' + (info.noiseEstimate * 100).toFixed(2) +
                                       '% RMS) · suggested L = ' + info.L.toFixed(2)) : '';
            if (info) line.title = info.rationale || '';
        }
        var list = host.querySelector('#prism_ann_list');
        if (list) { try { list.textContent = _detectedText(); } catch (e) { list.textContent = ''; } }
    }

    G.PRiSM_renderAnnotationToolbar = function PRiSM_renderAnnotationToolbar(container) {
        var host = (typeof container === 'string') ? (_hasDoc ? document.getElementById(container) : null) : container;
        if (!host) return;
        var enabled = (G.PRiSM_annotationsEnabled !== false);
        var L = _currentL();
        host.innerHTML =
            '<div class="prism-regimes" style="max-width:100%; box-sizing:border-box; font-size:12px; color:var(--text, #e6edf3);">' +
                '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px;">' +
                    '<label style="display:flex; align-items:center; gap:6px; cursor:pointer;">' +
                        '<input type="checkbox" id="prism_ann_show"' + (enabled ? ' checked' : '') + '>' +
                        '<span>Show flow-regime markers</span></label>' +
                    '<label style="display:flex; align-items:center; gap:6px;">' +
                        '<span>Derivative smoothing L</span>' +
                        '<input type="number" id="prism_ann_L" min="0" max="0.5" step="0.01" value="' + L.toFixed(2) + '" ' +
                            'style="width:72px; padding:4px 6px; background:var(--bg1, #0d1117); color:var(--text, #e6edf3); ' +
                            'border:1px solid var(--border, #30363d); border-radius:4px;"></label>' +
                    '<button type="button" class="btn btn-secondary" id="prism_ann_autoL" ' +
                        'style="font-size:12px; padding:5px 10px;">Auto L</button>' +
                '</div>' +
                '<div id="prism_ann_infoline" style="margin-top:6px; font-size:11px; color:var(--text2, #8b949e); min-height:14px;"></div>' +
                '<div id="prism_ann_list" role="status" style="margin-top:4px; font-size:12px; color:var(--text2, #8b949e); overflow-wrap:anywhere;"></div>' +
            '</div>';

        _updateInfo(host, null);
        var showChk = host.querySelector('#prism_ann_show');
        var lIn     = host.querySelector('#prism_ann_L');
        var autoBtn = host.querySelector('#prism_ann_autoL');

        if (showChk) showChk.addEventListener('change', function () {
            G.PRiSM_enableAutoAnnotations(!!showChk.checked);
            _ga4('prism_annotation_toggle', { enabled: !!showChk.checked });
        });
        if (lIn) lIn.addEventListener('change', function () {
            var v = parseFloat(lIn.value);
            if (!isFinite(v)) { lIn.value = _currentL().toFixed(2); return; }
            _setL(v);
            lIn.value = _currentL().toFixed(2);
            _redraw();
            _updateInfo(host, null);
        });
        if (autoBtn) autoBtn.addEventListener('click', function () {
            var ad = _analysisData();
            var info = G.PRiSM_autoBourdet_L(ad && (ad.tAbs || ad.t), ad && ad.p);
            _setL(info.L);
            if (lIn) lIn.value = _currentL().toFixed(2);
            _redraw();
            _updateInfo(host, info);
            _ga4('prism_annotation_toggle', { enabled: G.PRiSM_annotationsEnabled !== false, action: 'autoL' });
        });
    };

    _registerTabPanel(2, {
        id: 'regimes',
        title: 'Flow-regime markers',
        order: 20,
        collapsed: false,
        render: function (host) { G.PRiSM_renderAnnotationToolbar(host); }
    });

    _on(G, 'prism:dataset-loaded', function () { _cache = { key: null, anns: null }; });


    // ═══════════════════════════════════════════════════════════════

})();

// ─── END 15-diagnostic-annotations ─────────────────────────────────────────────

