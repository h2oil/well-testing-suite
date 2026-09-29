// =============================================================================
// PRiSM — Phase 2 Type-Curve Models (model kernels I)
// =============================================================================
// Pressure Reservoir inversion & Simulation Model — Advanced Well Test Analysis
//
// This file owns the Laplace-domain kernels for the 03 model family plus the
// shared wellbore-storage/skin evaluator used by the rest of the model library:
//
//   homogeneous      #1   vertical well, finite wellbore, WBS + skin
//   infiniteFrac     #3   infinite-conductivity (or uniform-flux) fracture
//   finiteFrac       #4   finite-conductivity fracture (semi-analytic)
//   inclined         #7   slant well (homogeneous + Cinco-Ley pseudo-skin)
//   horizontal       #8   horizontal well (uniform-flux line source in a slab)
//   linearBoundary   #10a single sealing / constant-pressure boundary
//   parallelChannel  #10b two parallel sealing faults
//   closedChannel3   #10c channel closed at one end
//   closedRectangle  #10d closed rectangle, well anywhere inside
//   intersecting     #10e two intersecting sealing faults
//   fogBoundary      #10f leaky fault (constant partial-image approximation)
//   finiteFracSkin   #12  finite-conductivity fracture + fracture-face skin
//   partialPenFrac   #30  partial-height fracture (Green's-function shortcut)
//
// Universal signature for every model:
//
//   PRiSM_model_<name>(td, params) -> pd                (number or array)
//   PRiSM_model_<name>_pd_prime(td, params) -> pd'      (td·dpd/dtd, Bourdet
//                                                         derivative, no
//                                                         superposition)
//
// Units & conventions
//  - Everything here is dimensionless. td is referenced to the model's
//    reference length (registry `refLength`: 'rw', 'xf' or 'Lh').
//    pD = kh·Δp / (141.2 qBμ) in field units, i.e. referenced to the
//    formation kh, for every model.
//  - Wellbore storage Cd and skin S are folded in the Laplace domain:
//
//                    s·p̄ + S
//      p̄_wD = ----------------------------          p̄ = reservoir solution
//              s · ( 1 + Cd·s·(s·p̄ + S) )               (no WBS, no skin)
//
//    (Agarwal-Al-Hussainy-Ramey 1970). This is done in ONE place,
//    PRiSM_evalWbsSkin(), exported for every other model file.
//  - Negative skin. The fold has a pole where s·p̄ + S = 0 when S < 0. For
//    S < 0 we therefore use the effective-wellbore-radius transform
//    (rwa = rw·e^−S): evaluate the S = 0 problem at tDa = td·e^{2S},
//    CDa = Cd·e^{2S}, with rw-normalised distances multiplied by e^{S}.
//    pD is invariant and td·dpD/dtd = tDa·dpD/dtDa. For xf / Lh referenced
//    models the same transform is applied to time and storage only
//    (an effective-length stretch); their shape parameters are unchanged.
//  - rw-referenced models use the finite-wellbore well term
//      p̄_w = K0(√s) / ( s·√s·K1(√s) )
//    and image wells  K0(√s·r) / ( s·√s·K1(√s) ),  evaluated with
//    exponentially scaled Bessel functions so nothing underflows to 0/0 at
//    large s (very early time or strongly negative skin).
//  - The Bourdet derivative is computed in the Laplace domain:
//    td·dpD/dtd = td · L⁻¹[ s·p̄_wD(s) ](td)  (pD(0+) = 0), inverted with the
//    same Stehfest weights, so derivative and pressure are consistent.
//  - Image lattices (channel, 3-sided channel, rectangle) are summed with the
//    Laplace transform of the product of two 1-D theta functions:
//
//      Σ_images K0(√s·r_i) = ∫_0^∞ e^{−st} [Θx(t)·Θy(t) − 1] / (2t) dt
//
//    where Θ(t) = Σ_offsets e^{−d²/(4t)} is evaluated in its image form for
//    small t and in its Fourier (Poisson-summed) form for large t. The
//    integral is done with the trapezoid rule in ln t (double-exponential
//    decay at both ends). This has no image-count cap, honours the well
//    position, and reaches pseudo-steady state exactly (Θ grows as √t).
//
// References inline above each evaluator.
// =============================================================================

(function () {
'use strict';

var _G = (typeof window !== 'undefined') ? window
       : (typeof globalThis !== 'undefined' ? globalThis : {});

// ---- foundation primitives ------------------------------------------------
// The foundation file (01) declares its primitives as plain functions / consts
// in the host IIFE scope (not on window). Resolve by name: window first, then
// the lexical scope via a guarded direct eval (identifier names only).
// Nothing in this file REQUIRES the foundation: the Stehfest weights and the
// Bessel functions below are self-contained, so the file also runs standalone.
var _fcache = {};
function _foundation(name) {
  if (_fcache[name]) return _fcache[name];
  var f = null;
  if (_G[name] != null && (typeof _G[name] === 'function' || typeof _G[name] === 'object')) {
    f = _G[name];
  } else if (/^[A-Za-z_$][\w$]*$/.test(name)) {
    try { f = eval(name); } catch (e) { f = null; }
  }
  if (f != null) _fcache[name] = f;
  return f;
}

// ============================================================================
// SECTION 1 — Numerics: Stehfest, scaled Bessel K, ∫K0
// ============================================================================

var STEHFEST_N = 12;
var EULER      = 0.5772156649015329;
var HALF_PI    = Math.PI / 2;

var _W12 = null;
function _stehfestWeights() {
  if (_W12) return _W12;
  var tbl = _foundation('PRiSM_STEHFEST_W');
  if (tbl && tbl[STEHFEST_N] && tbl[STEHFEST_N].length === STEHFEST_N) {
    _W12 = tbl[STEHFEST_N];
    return _W12;
  }
  // Local copy of the same Stehfest (1970) weights (only used standalone).
  var N = STEHFEST_N, N2 = N / 2, fact = [1];
  for (var i = 1; i <= 2 * N; i++) fact[i] = fact[i - 1] * i;
  var W = new Array(N);
  for (var n = 1; n <= N; n++) {
    var sum = 0;
    for (var k = Math.floor((n + 1) / 2); k <= Math.min(n, N2); k++) {
      sum += Math.pow(k, N2) * fact[2 * k] /
             (fact[N2 - k] * fact[k] * fact[k - 1] * fact[n - k] * fact[2 * k - n]);
    }
    W[n - 1] = (((n + N2) % 2 === 0) ? 1 : -1) * sum;
  }
  _W12 = W;
  return W;
}

// f(t) ≈ (ln2/t) Σ V_i F(i ln2 / t)
function _invert(F, t) {
  var W = _stehfestWeights();
  var a = Math.LN2 / t, acc = 0;
  for (var i = 1; i <= STEHFEST_N; i++) acc += W[i - 1] * F(i * a);
  return a * acc;
}

// Modified Bessel functions to ~1e-15 relative. The Laplace kernels are
// inverted with Stehfest, which amplifies any non-smooth error in F(s) by
// ~1e5, so the 1e-7 polynomial approximations are not good enough here.
//  x ≤ 2 : ascending series (A&S 9.6.10-13)
//  x > 2 : trapezoid rule on K_ν(x)·e^x = ∫_0^∞ e^{−x(cosh u − 1)} cosh(νu) du
//          (analytic in |Im u| < π/2 → error ~ e^{−π²/h}; h = 0.2 → 1e-21).
var BESSEL_H = 0.2;
function _KsmallPair(x) {            // [K0(x), K1(x)] by series, 0 < x ≤ 2
  var y = x * x / 4, lx = Math.log(x / 2);
  var t0 = 1, t1 = 1;                // (y^k/(k!)^2), (y^k/(k!(k+1)!))
  var I0 = 0, I1s = 0, s0 = 0, s1 = 0, psi = -EULER, psi1 = 1 - EULER;
  for (var k = 0; k < 60; k++) {
    if (k > 0) {
      t0 *= y / (k * k); t1 *= y / (k * (k + 1));
      psi += 1 / k; psi1 += 1 / (k + 1);
    }
    I0 += t0; I1s += t1;
    s0 += psi * t0; s1 += (psi + psi1) * t1;
    if (t0 < 1e-18 * I0 && k > 2) break;
  }
  var I1 = (x / 2) * I1s;
  return [-lx * I0 + s0, 1 / x + lx * I1 - (x / 4) * s1];
}
function _KePair(x) {                // [K0e(x), K1e(x)] for x > 2
  var h = BESSEL_H, s0 = 0.5, s1 = 0.5;
  for (var k = 1; k < 400; k++) {
    var u = k * h, ch = Math.cosh(u), e = Math.exp(-x * (ch - 1));
    s0 += e; s1 += e * ch;
    if (e * ch < 1e-18 * s1) break;
  }
  return [s0 * h, s1 * h];
}
function _K0e(x) {
  if (x <= 2) return _KsmallPair(x)[0] * Math.exp(x);
  return _KePair(x)[0];
}
function _K1e(x) {
  if (x <= 2) return _KsmallPair(x)[1] * Math.exp(x);
  return _KePair(x)[1];
}
function _K0(x) {
  if (!(x > 0)) return Infinity;
  if (x <= 2) return _KsmallPair(x)[0];
  if (x > 740) return 0;
  return _KePair(x)[0] * Math.exp(-x);
}

// ∫_0^z K0(t) dt: exact term-by-term integral of the K0 ascending series for
// z ≤ 2; beyond, π/2 − T(z) with T(z) = ∫_z^∞ K0 = ∫_0^∞ e^{−z cosh u}/cosh u du
// (trapezoid, same exponential accuracy as above).
function _tailK0(z) {                 // ∫_z^∞ K0(t) dt
  if (!(z > 0)) return HALF_PI;
  if (z <= 2) return HALF_PI - _intK0(z);
  if (z > 740) return 0;
  var h = BESSEL_H, s = 0.5;
  for (var k = 1; k < 400; k++) {
    var ch = Math.cosh(k * h), e = Math.exp(-z * (ch - 1)) / ch;
    s += e;
    if (e < 1e-18 * s) break;
  }
  return s * h * Math.exp(-z);
}
function _intK0(z) {
  if (!(z > 0)) return 0;
  if (z > 2) return HALF_PI - _tailK0(z);
  var w = z / 2, lnw = Math.log(w), w2 = w * w;
  var pw = w, ak = 1, Hk = 0, sum = 0;
  for (var k = 0; k < 400; k++) {
    if (k > 0) { ak /= (k * k); Hk += 1 / k; pw *= w2; }
    var inv = 1 / (2 * k + 1);
    var term = ak * 2 * pw * inv * (Hk - EULER - lnw + inv);
    sum += term;
    if (k > w && Math.abs(term) <= 1e-17 * Math.abs(sum)) break;
  }
  return sum;
}

// ---- Laplace building blocks (reservoir p̄, no WBS / skin) ---------------
// finite-wellbore well term  K0(√s) / (s √s K1(√s))
function _wellTerm(s) {
  var q = Math.sqrt(s);
  return _K0e(q) / (s * q * _K1e(q));
}
// image well at distance r (rw units)  K0(√s r) / (s √s K1(√s))
function _imageTerm(s, r) {
  var q = Math.sqrt(s);
  if (!(r > 0)) return 0;
  var num;
  if (r >= 1) {
    var e = q * (r - 1);
    if (e > 740) return 0;
    num = _K0e(q * r) * Math.exp(-e);
  } else {
    num = _K0(q * r) * Math.exp(Math.min(q, 700));
  }
  return num / (s * q * _K1e(q));
}
// convert a raw image sum B = Σ K0(√s r_i) into the finite-wellbore form
function _latticeTerm(s, B) {
  if (!(B > 0)) return 0;
  var q = Math.sqrt(s);
  var lg = Math.log(B) + q;
  if (lg > 700) lg = 700;
  return Math.exp(lg) / (s * q * _K1e(q));
}

// ---- Theta-function lattice sums ------------------------------------------
// axis spec:
//   null                               no boundary on this axis (Θ = 1)
//   {finite:[d1, d2, ...]}             finite set of non-zero image offsets
//   {L, w}                             two walls a distance L apart, well at w
//                                      from the first: offsets {2iL} ∪ {2w+2iL}
function _axisRmin(ax) {
  if (!ax) return Infinity;
  if (ax.finite) {
    var m = Infinity;
    for (var i = 0; i < ax.finite.length; i++) m = Math.min(m, Math.abs(ax.finite[i]));
    return m;
  }
  return Math.min(2 * ax.L, 2 * ax.w, 2 * (ax.L - ax.w));
}
function _thetaM1(ax, t) {           // Θ(t) − 1  (the zero offset excluded)
  if (!ax) return 0;
  var sum = 0, i, e;
  if (ax.finite) {
    for (i = 0; i < ax.finite.length; i++) {
      e = ax.finite[i] * ax.finite[i] / (4 * t);
      if (e < 745) sum += Math.exp(-e);
    }
    return sum;
  }
  var L = ax.L, w = ax.w;
  if (t < L * L) {
    // image form: Σ_{i≠0} e^{-i²L²/t} + Σ_i e^{-(w+iL)²/t}
    for (i = 1; i < 1000; i++) {
      e = i * i * L * L / t;
      if (e > 745) break;
      sum += 2 * Math.exp(-e);
    }
    for (i = 0; i < 1000; i++) {
      e = (w + i * L) * (w + i * L) / t;
      if (e > 745) break;
      sum += Math.exp(-e);
    }
    for (i = -1; i > -1000; i--) {
      e = (w + i * L) * (w + i * L) / t;
      if (e > 745) break;
      sum += Math.exp(-e);
    }
    return sum;
  }
  // Fourier (Poisson) form: Θ = (√(πt)/L)[2 + 2Σ e^{-m²π²t/L²}(1 + cos(2mπw/L))]
  var a = Math.PI * Math.PI * t / (L * L), f = 2;
  for (var m = 1; m < 50; m++) {
    e = m * m * a;
    if (e > 745) break;
    f += 2 * Math.exp(-e) * (1 + Math.cos(2 * m * Math.PI * w / L));
  }
  return Math.sqrt(Math.PI * t) / L * f - 1;
}
// Σ_images K0(√s r) over the product lattice of two axes
var LATTICE_H = 0.1;          // trapezoid step in ln t
function _latticeK0Sum(s, ax, ay) {
  var rmin = Math.min(_axisRmin(ax), _axisRmin(ay));
  if (!isFinite(rmin) || !(rmin > 0)) return 0;
  var q = Math.sqrt(s);
  if (q * rmin > 80) return 0;                 // < e^-80 relative: negligible
  var vlo = Math.log(rmin * rmin / 200);
  var vhi = Math.log(50 / s);
  if (vhi <= vlo) return 0;
  var n = Math.ceil((vhi - vlo) / LATTICE_H);
  var h = (vhi - vlo) / n, sum = 0;
  for (var k = 0; k <= n; k++) {
    var t = Math.exp(vlo + k * h);
    var gx = _thetaM1(ax, t), gy = _thetaM1(ay, t);
    var g = gx * gy + gx + gy;
    if (g === 0) continue;
    var val = 0.5 * Math.exp(-s * t) * g;
    sum += (k === 0 || k === n) ? 0.5 * val : val;
  }
  return sum * h;
}

// ============================================================================
// SECTION 2 — Shared WBS + skin evaluator  (window.PRiSM_evalWbsSkin)
// ============================================================================
//
//   PRiSM_evalWbsSkin(lapRes, td, Cd, S, opts) → pd (or pd' when
//                                                opts.derivative) for td
//                                                number | array
//     lapRes(s, dScale) → reservoir p̄(s) (no WBS, no skin). dScale is the
//                          factor to apply to rw-normalised distances
//                          (1, or e^{S} under the S < 0 transform).
//     opts.scaleDistances  (default true) pass dScale = e^S when S < 0;
//                          false → dScale is always 1 (xf / Lh models).
//     opts.derivative      return td·dpd/dtd instead of pd.
//
// Pure-storage fast path: when tDa < min(1e-3·CDa, 1e-12·CDa²) the response is
// pd = td/Cd to better than ~1e-6 relative (the first correction is
// O(√tDa/CDa)), and so is the derivative.

function _fold(u, s, C, S) {
  var inner = u + S;
  return inner / (s * (1 + C * s * inner));
}

function _evalOne(lapRes, t, Cd, S, scaleDist, deriv) {
  if (!(t > 0)) return 0;
  var C = (Cd > 0) ? Cd : 0, SS = S || 0, tt = t, dScale = 1;
  if (SS < 0) {
    var e2 = Math.exp(2 * SS);
    tt = t * e2; C = C * e2;
    dScale = scaleDist ? Math.exp(SS) : 1;
    SS = 0;
  }
  if (C > 0 && tt < Math.min(1e-3 * C, 1e-12 * C * C)) return tt / C;
  var F = function (s) {
    var pbar = lapRes(s, dScale);
    return _fold(s * pbar, s, C, SS);
  };
  var v;
  if (deriv) v = tt * _invert(function (s) { return s * F(s); }, tt);
  else v = _invert(F, tt);
  return v;
}

function PRiSM_evalWbsSkin(lapRes, td, Cd, S, opts) {
  if (typeof lapRes !== 'function') throw new Error('PRiSM_evalWbsSkin: lapRes must be a function');
  opts = opts || {};
  var scaleDist = opts.scaleDistances !== false;
  var deriv = !!opts.derivative;
  if (!isFinite(Cd)) throw new Error('PRiSM_evalWbsSkin: Cd must be finite');
  if (!isFinite(S)) throw new Error('PRiSM_evalWbsSkin: S must be finite');
  if (Array.isArray(td)) {
    var out = new Array(td.length);
    for (var i = 0; i < td.length; i++) out[i] = _evalOne(lapRes, +td[i], Cd, S, scaleDist, deriv);
    return out;
  }
  return _evalOne(lapRes, +td, Cd, S, scaleDist, deriv);
}

// ============================================================================
// SECTION 3 — Parameter helpers
// ============================================================================

function _num(v) { return (typeof v === 'number') && isFinite(v); }

function _checkTd(td) {
  if (Array.isArray(td)) {
    for (var i = 0; i < td.length; i++) {
      if (typeof td[i] !== 'number' || isNaN(td[i])) {
        throw new Error('PRiSM model: td must be numeric (got ' + td[i] + ' at index ' + i + ')');
      }
    }
  } else if (typeof td !== 'number' || isNaN(td)) {
    throw new Error('PRiSM model: td must be numeric (got ' + td + ')');
  }
}

// Merge params over the model defaults; reject NaN / Infinity values.
function _prep(params, defaults) {
  if (params != null && typeof params !== 'object') {
    throw new Error('PRiSM model: params object required');
  }
  var p = {}, k;
  for (k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) p[k] = defaults[k];
  if (params) {
    for (k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v == null) continue;
      if (typeof v === 'number' && !isFinite(v)) {
        throw new Error('PRiSM model: param "' + k + '" is NaN/Infinity');
      }
      p[k] = v;
    }
  }
  if (!_num(p.Cd) || p.Cd < 0) throw new Error('PRiSM model: Cd must be ≥ 0 (got ' + p.Cd + ')');
  return p;
}

function _positive(name, v) {
  if (!_num(v) || v <= 0) throw new Error('PRiSM model: ' + name + ' must be > 0 (got ' + v + ')');
  return v;
}

// h/rw injected by the physical-model wrapper as '__h_rw' (default 100)
function _hRw(p) {
  var v = p.__h_rw;
  return (_num(v) && v > 1) ? v : 100;
}

// ============================================================================
// SECTION 4 — Pseudo-skin library  (window.PRiSM_pseudoSkin)
// ============================================================================

// Brons & Marting (1961) partial-penetration pseudo-skin
//   Sp = (1/b − 1)·[ln hD − G(b)],  G(b) = 2.948 − 7.363b + 11.45b² − 4.675b³
//   b = hp/h (open fraction), hD = (h/rw)·√(kh/kv).
// Call as bronsMarting(b, hD) or bronsMarting(b, h, rw, kvkh).
function _bronsMarting(b, hD, rw, kvkh) {
  if (arguments.length >= 3) {
    var kk = (_num(kvkh) && kvkh > 0) ? kvkh : 1;
    hD = (hD / rw) * Math.sqrt(1 / kk);
  }
  if (!_num(b) || b <= 0) return NaN;
  if (b >= 1) return 0;
  if (!_num(hD) || hD <= 0) return NaN;
  var G = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;
  return (1 / b - 1) * (Math.log(hD) - G);
}

// Cinco-Ley, Ramey & Miller (1975) slant-well pseudo-skin
//   S_θ = −(θ'/41)^2.06 − (θ'/56)^1.865 · log10(hD/100)
//   θ' = atan(√(kv/kh)·tanθ) [deg],  hD = (h/rw)·√(kh/kv).
// Call as cincoLey(thetaDeg, kvkh, h_over_rw) or cincoLey(thetaDeg, kvkh, h, rw).
function _cincoLey(thetaDeg, kvkh, hRw, rw) {
  var kk = (_num(kvkh) && kvkh > 0) ? kvkh : 1;
  var ratio = (arguments.length >= 4 && _num(rw) && rw > 0) ? hRw / rw : hRw;
  if (!_num(ratio) || ratio <= 0) ratio = 100;
  if (!_num(thetaDeg)) return NaN;
  var th = Math.abs(thetaDeg);
  if (th === 0) return 0;
  if (th >= 90) th = 89.999;
  var thP = Math.atan(Math.sqrt(kk) * Math.tan(th * Math.PI / 180)) * 180 / Math.PI;
  var hD = ratio * Math.sqrt(1 / kk);
  return -Math.pow(thP / 41, 2.06) - Math.pow(thP / 56, 1.865) * (Math.log(hD / 100) / Math.LN10);
}

// Equivalent (pseudo-radial) skin of a vertical fracture referenced to rw.
//   'infinite'    infinite conductivity:  rw' = xf/2        → S = ln(2rw/xf)
//   'uniformFlux' uniform flux:           rw' = xf/e        → S = ln(e·rw/xf)
//   'finite'      finite conductivity FcD (4th argument), unified-fracture-
//                 design correlation (Economides et al. 2002):
//                 S + ln(xf/rw) = (1.65 − 0.328u + 0.116u²)/(1 + 0.180u + 0.064u² + 0.005u³),
//                 u = ln FcD  (→ ln 2 as FcD → ∞)
function _fractureSkin(xf, rw, type, FcD) {
  if (!_num(xf) || xf <= 0 || !_num(rw) || rw <= 0) return NaN;
  var t = type || 'infinite';
  if (t === 'uniformFlux' || t === 'uniform') return 1 + Math.log(rw / xf);
  if (t === 'finite') {
    if (!_num(FcD) || FcD <= 0) return NaN;
    var u = Math.log(FcD);
    var f = (1.65 - 0.328 * u + 0.116 * u * u) /
            (1 + 0.180 * u + 0.064 * u * u + 0.005 * u * u * u);
    return f - Math.log(xf / rw);
  }
  return Math.log(2 * rw / xf);
}

// Joshi-type equivalent skin of a horizontal well of total length L, for
// REPORTING ONLY (the horizontal kernel models the geometry exactly).
// Joshi (1988) productivity with the Economides anisotropy correction, in the
// limit of a large drainage radius, equated to a vertical well:
//   S_eq = ln(4·rw/L) + (βh/L)·ln( βh / ((β+1)·rw) ),   β = √(kh/kv)
function _horizontalEquivalent(L, h, rw, kvkh) {
  if (!_num(L) || L <= 0 || !_num(h) || h <= 0 || !_num(rw) || rw <= 0) return NaN;
  var kk = (_num(kvkh) && kvkh > 0) ? kvkh : 1;
  var beta = Math.sqrt(1 / kk);
  return Math.log(4 * rw / L) + (beta * h / L) * Math.log(beta * h / ((beta + 1) * rw));
}

// ============================================================================
// SECTION 5 — MODEL #1 — Homogeneous (vertical well, WBS + skin)
// ============================================================================
// Reference: Agarwal, Al-Hussainy & Ramey, SPEJ Sept 1970; Mavor & Cinco-Ley
//   SPE 7977. Same closed form as the foundation PRiSM_model_homogeneous for
//   S ≥ 0; negative skin goes through the effective-radius transform so the
//   Laplace fold never meets its pole.
// Params: { Cd, S }        refLength: rw
// ============================================================================

var HOM_DEFAULTS = { Cd: 100, S: 0 };
function _lapHom(s) { return _wellTerm(s); }

function PRiSM_model_homogeneous_rwa(td, params) {
  _checkTd(td);
  var p = _prep(params, HOM_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, p.S);
}
function PRiSM_model_homogeneous_rwa_pd_prime(td, params) {
  _checkTd(td);
  var p = _prep(params, HOM_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, p.S, { derivative: true });
}

// ============================================================================
// SECTION 6 — MODEL #3 — Infinite-conductivity fracture
// ============================================================================
// Reference: Gringarten, Ramey & Raghavan, SPEJ Aug 1974.
//   Uniform-flux fracture observed at xD = 0.732 (reproduces the
//   infinite-conductivity solution), Laplace form:
//     p̄ = [ ∫_0^{√s(1+0.732)} K0 + ∫_0^{√s(1−0.732)} K0 ] / (2 s √s)
//   params.uniformFlux truthy → observed at xD = 0:  p̄ = ∫_0^{√s} K0 / (s √s).
//   Early time: pD = √(π tD) (half slope); late: ½(ln tD + 2.2).
//   Always evaluated in Laplace (Cd = 0 is continuous with Cd → 0).
// Params: { Cd, S }        refLength: xf     (tD = 0.0002637 k t /(φ μ ct xf²))
// ============================================================================

var XD_INF = 0.732;
function _lapInfFrac(s, uniformFlux) {
  var q = Math.sqrt(s);
  if (uniformFlux) return _intK0(q) / (s * q);
  return (_intK0(q * (1 + XD_INF)) + _intK0(q * (1 - XD_INF))) / (2 * s * q);
}

var INFFRAC_DEFAULTS = { Cd: 100, S: 0 };
function PRiSM_model_infiniteFrac(td, params) {
  _checkTd(td);
  var p = _prep(params, INFFRAC_DEFAULTS);
  var uf = !!p.uniformFlux;
  return PRiSM_evalWbsSkin(function (s) { return _lapInfFrac(s, uf); }, td, p.Cd, p.S,
                           { scaleDistances: false });
}
function PRiSM_model_infiniteFrac_pd_prime(td, params) {
  _checkTd(td);
  var p = _prep(params, INFFRAC_DEFAULTS);
  var uf = !!p.uniformFlux;
  return PRiSM_evalWbsSkin(function (s) { return _lapInfFrac(s, uf); }, td, p.Cd, p.S,
                           { scaleDistances: false, derivative: true });
}

// ============================================================================
// SECTION 7 — MODELS #4 / #12 — Finite-conductivity fracture (+ face skin)
// ============================================================================
// Reference: Cinco-Ley, Samaniego & Dominguez, SPEJ Aug 1978 (semi-analytic
//   solution); Cinco-Ley & Samaniego, JPT Sept 1981 (fracture-face skin).
//   Laplace-domain form: the fracture half-length is split into NSEG
//   uniform-flux segments. Reservoir response at segment midpoint x_i
//     p̄_r(x_i) = ½ Σ_j q̄_j ∫_seg_j [K0(√s|x_i−α|) + K0(√s(x_i+α))] dα
//   Fracture (1-D linear flow, conductivity FcD):
//     p̄_w = p̄_r(x_i) + Sf·q̄_i + (π/FcD)[x_i/s − ∫_0^{x_i}∫_0^{x'} q̄]
//   with Σ q̄_j Δx_j = 1/s. Solved as an (NSEG+1)² linear system per s.
//   Sf here is the Cinco-Ley fracture-face skin (π/2)(bs/xf)(k/ks − 1).
//   Early: bilinear pD = 2.45 tD^¼/√FcD; FcD → ∞ approaches infiniteFrac;
//   late: ½(ln tD + 0.809) + pseudo-skin.
// Params: { Cd, S, FcD [, Sf] }      refLength: xf
// ============================================================================

var NSEG = 20;
// Uniform mesh: edges e_j = j/N, midpoints x_i = (i+½)/N. Every kernel
// argument |x_i − e_j| and x_i + e_j is an odd multiple of 1/(2N), so the
// ∫K0 values are tabulated once per s (4N+2 evaluations instead of 2N(N+1)).
// The integration weights c_ij of the fracture-flow term do not depend on s.
var _FRAC_C = (function () {
  var N = NSEG, d = 1 / N, C = [];
  for (var i = 0; i < N; i++) {
    var xi = (i + 0.5) * d, row = [];
    for (var j = 0; j < N; j++) {
      var a = j * d, b = (j + 1) * d;
      if (b <= xi)     row.push(d * (xi - b) + 0.5 * d * d);
      else if (a < xi) row.push(0.5 * (xi - a) * (xi - a));
      else             row.push(0);
    }
    C.push(row);
  }
  return C;
})();

function _solveLinear(A, b) {        // Gaussian elimination, partial pivoting
  var n = b.length, i, j, k;
  for (k = 0; k < n; k++) {
    var piv = k, mx = Math.abs(A[k][k]);
    for (i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > mx) { mx = Math.abs(A[i][k]); piv = i; }
    if (!(mx > 0)) return null;
    if (piv !== k) { var tr = A[k]; A[k] = A[piv]; A[piv] = tr; var tb = b[k]; b[k] = b[piv]; b[piv] = tb; }
    for (i = k + 1; i < n; i++) {
      var f = A[i][k] / A[k][k];
      if (f === 0) continue;
      for (j = k; j < n; j++) A[i][j] -= f * A[k][j];
      b[i] -= f * b[k];
    }
  }
  var x = new Array(n);
  for (i = n - 1; i >= 0; i--) {
    var sum = b[i];
    for (j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
    x[i] = sum / A[i][i];
  }
  return x;
}

function _lapFinFrac(s, FcD, Sf) {
  var q = Math.sqrt(s), N = NSEG, d = 1 / N, i, j;
  var K = new Array(4 * N + 3);                 // K[m] = ∫_0^{q·m/(2N)} K0
  for (var m = 0; m < K.length; m++) K[m] = _intK0(q * m * 0.5 * d);
  var A = new Array(N + 1), b = new Array(N + 1);
  var cpf = Math.PI / FcD;
  for (i = 0; i < N; i++) {
    var row = new Array(N + 1), ci = _FRAC_C[i];
    for (j = 0; j < N; j++) {
      // segment j = [j/N, (j+1)/N], observation x_i = (2i+1)/(2N)
      var g;
      if (j > i)      g = K[2 * (j - i) + 1] - K[2 * (j - i) - 1];
      else if (j < i) g = K[2 * (i - j) + 1] - K[2 * (i - j) - 1];
      else            g = 2 * K[1];
      g += K[2 * i + 2 * j + 3] - K[2 * i + 2 * j + 1];   // mirror wing
      g /= q;
      row[j] = 0.5 * g - cpf * ci[j] + ((i === j) ? Sf : 0);
    }
    row[N] = -1;                    // −P
    A[i] = row;
    b[i] = -cpf * (i + 0.5) * d;    // RHS (unknowns scaled by s: Q = s·q̄, P = s·p̄w)
  }
  var last = new Array(N + 1);
  for (j = 0; j < N; j++) last[j] = d;
  last[N] = 0;
  A[N] = last; b[N] = 1;
  var x = _solveLinear(A, b);
  if (!x) return NaN;
  return x[N] / s;
}

var FINFRAC_DEFAULTS = { Cd: 100, S: 0, FcD: 10 };
var FINFRACSKIN_DEFAULTS = { Cd: 100, S: 0, FcD: 10, Sf: 0.5 };

function _finFracEval(td, params, defaults, deriv, withSf) {
  _checkTd(td);
  var p = _prep(params, defaults);
  var FcD = _positive('FcD', p.FcD);
  var Sf = withSf ? (_num(p.Sf) ? Math.max(0, p.Sf) : 0) : 0;
  return PRiSM_evalWbsSkin(function (s) { return _lapFinFrac(s, FcD, Sf); }, td, p.Cd, p.S,
                           { scaleDistances: false, derivative: deriv });
}
function PRiSM_model_finiteFrac(td, params)          { return _finFracEval(td, params, FINFRAC_DEFAULTS, false, false); }
function PRiSM_model_finiteFrac_pd_prime(td, params) { return _finFracEval(td, params, FINFRAC_DEFAULTS, true, false); }
function PRiSM_model_finiteFracSkin(td, params)          { return _finFracEval(td, params, FINFRACSKIN_DEFAULTS, false, true); }
function PRiSM_model_finiteFracSkin_pd_prime(td, params) { return _finFracEval(td, params, FINFRACSKIN_DEFAULTS, true, true); }

// ============================================================================
// SECTION 8 — MODEL #7 — Inclined (slant) well
// ============================================================================
// Reference: Cinco, Miller & Ramey, JPT Nov 1975 (pseudo-skin correlation).
//   Evaluated as the homogeneous model with S = S_perf + S_global + S_θ
//   (+ Brons-Marting partial penetration when hp_to_h < 1, additive
//   engineering approximation). S_θ < 0 for any θ > 0, so this model relies
//   on the negative-skin transform. θ, Kv/Kh and hp/h enter only through the
//   constant S_θ and are therefore collinear with S_perf: they are frozen by
//   default (registry defaultFrozen).
//   hD = __h_rw·√(kh/kv); __h_rw = h/rw is injected by the physical wrapper
//   (default 100 → the log10 term vanishes).
// Params: { Cd, S_perf, S_global, KvKh, theta_deg, hp_to_h }   refLength: rw
// ============================================================================

var INCL_DEFAULTS = { Cd: 100, S_perf: 0, S_global: 0, KvKh: 1.0, theta_deg: 45, hp_to_h: 1.0 };

function _inclinedPseudoSkin(p) {
  var kk = (_num(p.KvKh) && p.KvKh > 0) ? p.KvKh : 1;
  var hRw = _hRw(p);
  var St = _cincoLey(_num(p.theta_deg) ? p.theta_deg : 0, kk, hRw);
  var b = _num(p.hp_to_h) ? p.hp_to_h : 1;
  var Sp = (b > 0 && b < 1) ? _bronsMarting(b, hRw * Math.sqrt(1 / kk)) : 0;
  return St + (isFinite(Sp) ? Sp : 0);
}
function _inclinedTotalS(p) {
  return (p.S_perf || 0) + (p.S_global || 0) + _inclinedPseudoSkin(p);
}
function PRiSM_model_inclined(td, params) {
  _checkTd(td);
  var p = _prep(params, INCL_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, _inclinedTotalS(p));
}
function PRiSM_model_inclined_pd_prime(td, params) {
  _checkTd(td);
  var p = _prep(params, INCL_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, _inclinedTotalS(p), { derivative: true });
}

// ============================================================================
// SECTION 9 — MODEL #8 — Horizontal well
// ============================================================================
// Reference: Ozkan & Raghavan, SPEFE Sept 1991 (uniform-flux line source
//   between two no-flow planes), evaluated at xD = 0.732, zD = zwD + rwD:
//
//   p̄ = (1/s){ ½∫_{-1}^{1}K0(√s|xD−α|)dα
//              + Σ_{n≥1} cos(nπzD)cos(nπzwD)∫_{-1}^{1}K0(β_n|xD−α|)dα }
//   β_n = √(s + n²π²LD²),  LD = (Lh/h)·√(kv/kh),  Lh = half-length = L/2.
//
//   Evaluation: ∫K0 over the well length = π/β_n minus two exponentially
//   small end corrections; the π/β_n part of the series is summed exactly,
//   by Poisson summation into vertical image wells when √s/(πLD) ≥ 0.05
//   (early time) and by a Kummer-accelerated Fourier sum otherwise.
//   No additive geometric skin: the geometry is in the kernel. S_perf and
//   S_global (collinear; S_global frozen by default) add to pD directly.
//   Early radial: pD' = ½·(h/L)·√(kh/kv) (L = total length); late
//   pseudo-radial: pD' = ½.
// Params: { Cd, S_perf, S_global, KvKh, L_to_h, zw_to_h }  (L_to_h = total
//   length / h; __h_rw = h/rw injected, default 100; optional __Lh_h = Lh/h
//   injected by a wrapper that floats Lh overrides L_to_h)  refLength: Lh
// ============================================================================

var HORIZ_DEFAULTS = { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0, zw_to_h: 0.5 };

// Σ_{n≥1} cos(nθ)/√(s + n²ω²)
function _cosSeries(s, theta, omega) {
  var c = Math.sqrt(s) / omega;
  var sum = 0, k, arg;
  if (c >= 0.05) {
    // Poisson: Σ_{n∈Z} e^{inθ}/√(s+n²ω²) = (2/ω) Σ_k K0(c|θ + 2πk|)
    for (k = 0; k < 100000; k++) {
      arg = c * Math.abs(theta + 2 * Math.PI * k);
      if (arg > 50) break;
      sum += _K0(arg);
    }
    for (k = -1; k > -100000; k--) {
      arg = c * Math.abs(theta + 2 * Math.PI * k);
      if (arg > 50) break;
      sum += _K0(arg);
    }
    return sum / omega - 0.5 / Math.sqrt(s);
  }
  // Kummer: (1/ω)Σcos(nθ)/n = −(1/ω) ln|2 sin(θ/2)|, remainder ~ s/(2n³ω³)
  var base = -Math.log(Math.abs(2 * Math.sin(theta / 2))) / omega;
  var nMax = Math.min(20000, Math.ceil(Math.pow(s / (2e-13 * omega * omega * omega), 1 / 3)) + 2);
  for (var n = 1; n <= nMax; n++) {
    var no = n * omega;
    sum += Math.cos(n * theta) * (1 / Math.sqrt(s + no * no) - 1 / no);
  }
  return base + sum;
}

function _horizGeom(p) {
  var KvKh = _positive('KvKh', p.KvKh);
  // '__Lh_h' (= Lh/h, injected by a physical wrapper that floats Lh in ft)
  // takes precedence over the L_to_h shape parameter so the two cannot disagree.
  var Lh_h = (_num(p.__Lh_h) && p.__Lh_h > 0) ? p.__Lh_h : 0.5 * _positive('L_to_h', p.L_to_h);
  var zw = _num(p.zw_to_h) ? p.zw_to_h : 0.5;
  if (zw < 0 || zw > 1) throw new Error('PRiSM horizontal: zw_to_h must be in [0,1]');
  var rwD = 1 / _hRw(p);
  var zD = zw + rwD;
  if (zD > 1) zD = zw - rwD;
  return { LD: Lh_h * Math.sqrt(KvKh), zw: zw, zD: zD };
}

function PRiSM_lap_horizontal(s, params) {
  var g = (params && params.__geom) ? params.__geom : _horizGeom(_prep(params, HORIZ_DEFAULTS));
  var x = XD_INF, q = Math.sqrt(s);
  var omega = Math.PI * g.LD;
  // n = 0 term
  var tot = 0.5 * (_intK0(q * (1 + x)) + _intK0(q * (1 - x))) / q;
  // end corrections of the n ≥ 1 terms: I_n − π/β_n = −[T(β(1+x)) + T(β(1−x))]/β
  for (var n = 1; n < 100000; n++) {
    var beta = Math.sqrt(s + n * n * omega * omega);
    if (beta * (1 - x) > 40) break;
    var cn = Math.cos(n * Math.PI * g.zD) * Math.cos(n * Math.PI * g.zw);
    tot -= cn * (_tailK0(beta * (1 + x)) + _tailK0(beta * (1 - x))) / beta;
  }
  // π Σ c_n/β_n,  c_n = ½[cos(nπ(zD−zw)) + cos(nπ(zD+zw))]
  var ta = _cosSeries(s, Math.PI * Math.abs(g.zD - g.zw), omega);
  var tb = _cosSeries(s, Math.PI * (g.zD + g.zw), omega);
  tot += Math.PI * 0.5 * (ta + tb);
  return tot / s;
}

function _horizEval(td, params, deriv) {
  _checkTd(td);
  var p = _prep(params, HORIZ_DEFAULTS);
  var geom = _horizGeom(p);
  var pp = { __geom: geom };
  var S = (p.S_perf || 0) + (p.S_global || 0);
  return PRiSM_evalWbsSkin(function (s) { return PRiSM_lap_horizontal(s, pp); }, td, p.Cd, S,
                           { scaleDistances: false, derivative: deriv });
}
function PRiSM_model_horizontal(td, params)          { return _horizEval(td, params, false); }
function PRiSM_model_horizontal_pd_prime(td, params) { return _horizEval(td, params, true); }

// ============================================================================
// SECTION 10 — Boundary models (rw-referenced, image wells)
// ============================================================================
// Reference: van Poolen, Bixel & Jargon, JPT Aug 1963 (image wells);
//   Earlougher, SPE Monograph 5 (1977) ch. 2. All distances are in rw.
//
// #10a linearBoundary  one image at 2dF (+1 sealing, −1 constant pressure).
// #10b parallelChannel walls at dF1 / dF2 (width W = dF1 + dF2); image
//      shells 2K0(2nW) + K0(2nW−2dF1) + K0(2nW−2dF2) — summed exactly via the
//      theta lattice. Late: pD' = √(π tD)/W.
// #10c closedChannel3  channel + end wall at dEnd: the whole channel image
//      set is reflected once in the end wall. Late: pD' = 2√(π tD)/W.
// #10d closedRectangle well at (dW, dS) in a (dW+dE)×(dS+dN) rectangle; four-
//      image lattice (±xw + 2iLx, ±yw + 2jLy). Late PSS: pD' = 2π tD/A.
// #10e intersecting    circular image pattern (unchanged geometry).
// #10f fogBoundary     leaky fault — constant partial-image approximation:
//      one image of strength fog ∈ [−1, 1] (+1 sealing, 0 none, −1 constant
//      pressure). An engineering approximation, not the rigorous
//      semi-permeable-fault solution.
// ============================================================================

var LB_DEFAULTS  = { Cd: 100, S: 0, dF: 1000, BC: 'noflow' };
var PC_DEFAULTS  = { Cd: 100, S: 0, dF1: 500, dF2: 500 };
var CC3_DEFAULTS = { Cd: 100, S: 0, dF1: 500, dF2: 500, dEnd: 1000 };
var CR_DEFAULTS  = { Cd: 100, S: 0, dN: 500, dS: 500, dE: 500, dW: 500 };
var INT_DEFAULTS = { Cd: 100, S: 0, dF1: 500, dF2: 500, angleDeg: 90 };
var FOG_DEFAULTS = { Cd: 100, S: 0, dF: 1000, fog: 0.5 };

function _lapLinearBoundary(p) {
  var dF = _positive('dF', p.dF);
  if (p.BC && p.BC !== 'noflow' && p.BC !== 'constP') {
    throw new Error('PRiSM linearBoundary: BC must be "noflow" or "constP"');
  }
  var sign = (p.BC === 'constP') ? -1 : 1;
  return function (s, d) { return _wellTerm(s) + sign * _imageTerm(s, 2 * dF * d); };
}
function _lapFog(p) {
  var dF = _positive('dF', p.dF), fog = p.fog;
  if (!_num(fog) || fog < -1 || fog > 1) throw new Error('PRiSM fogBoundary: fog must be in [-1, 1]');
  return function (s, d) { return _wellTerm(s) + fog * _imageTerm(s, 2 * dF * d); };
}
function _lapParallelChannel(p) {
  var dF1 = _positive('dF1', p.dF1), dF2 = _positive('dF2', p.dF2);
  return function (s, d) {
    var ay = { L: (dF1 + dF2) * d, w: dF1 * d };
    return _wellTerm(s) + _latticeTerm(s, _latticeK0Sum(s, null, ay));
  };
}
function _lapClosedChannel3(p) {
  var dF1 = _positive('dF1', p.dF1), dF2 = _positive('dF2', p.dF2), dEnd = _positive('dEnd', p.dEnd);
  return function (s, d) {
    var ay = { L: (dF1 + dF2) * d, w: dF1 * d };
    var ax = { finite: [2 * dEnd * d] };
    return _wellTerm(s) + _latticeTerm(s, _latticeK0Sum(s, ax, ay));
  };
}
function _lapClosedRectangle(p) {
  var dN = _positive('dN', p.dN), dS = _positive('dS', p.dS);
  var dE = _positive('dE', p.dE), dW = _positive('dW', p.dW);
  return function (s, d) {
    var ax = { L: (dE + dW) * d, w: dW * d };
    var ay = { L: (dN + dS) * d, w: dS * d };
    return _wellTerm(s) + _latticeTerm(s, _latticeK0Sum(s, ax, ay));
  };
}
var _warnedAngle = {};
function _lapIntersecting(p) {
  var dF1 = _positive('dF1', p.dF1), dF2 = _positive('dF2', p.dF2), ang = p.angleDeg;
  if (!_num(ang) || ang <= 0 || ang >= 360) throw new Error('PRiSM intersecting: angleDeg must be in (0,360)');
  var ratio = 360 / ang, nImages = Math.max(1, Math.min(719, Math.round(ratio) - 1));
  if (Math.abs(ratio - Math.round(ratio)) > 1e-6 && !_warnedAngle[ang]) {
    _warnedAngle[ang] = true;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('PRiSM intersecting: 360/angleDeg = ' + ratio + ' is non-integer; image lattice approximate');
    }
  }
  var dCentral = Math.sqrt(dF1 * dF1 + dF2 * dF2);
  var rho = [];
  for (var n = 1; n <= nImages; n++) rho.push(2 * dCentral * Math.sin(n * ang * Math.PI / 360));
  return function (s, d) {
    var v = _wellTerm(s);
    for (var i = 0; i < rho.length; i++) v += _imageTerm(s, Math.abs(rho[i]) * d);
    return v;
  };
}

function _makeRwModel(defaults, lapFactory) {
  function run(td, params, deriv) {
    _checkTd(td);
    var p = _prep(params, defaults);
    var lap = lapFactory(p);
    return PRiSM_evalWbsSkin(lap, td, p.Cd, _num(p.S) ? p.S : 0, { derivative: deriv });
  }
  return {
    pd: function (td, params) { return run(td, params, false); },
    pdPrime: function (td, params) { return run(td, params, true); }
  };
}
var _LB  = _makeRwModel(LB_DEFAULTS,  _lapLinearBoundary);
var _PC  = _makeRwModel(PC_DEFAULTS,  _lapParallelChannel);
var _CC3 = _makeRwModel(CC3_DEFAULTS, _lapClosedChannel3);
var _CR  = _makeRwModel(CR_DEFAULTS,  _lapClosedRectangle);
var _INT = _makeRwModel(INT_DEFAULTS, _lapIntersecting);
var _FOG = _makeRwModel(FOG_DEFAULTS, _lapFog);

function PRiSM_model_linearBoundary(td, params)            { return _LB.pd(td, params); }
function PRiSM_model_linearBoundary_pd_prime(td, params)   { return _LB.pdPrime(td, params); }
function PRiSM_model_parallelChannel(td, params)           { return _PC.pd(td, params); }
function PRiSM_model_parallelChannel_pd_prime(td, params)  { return _PC.pdPrime(td, params); }
function PRiSM_model_closedChannel3(td, params)            { return _CC3.pd(td, params); }
function PRiSM_model_closedChannel3_pd_prime(td, params)   { return _CC3.pdPrime(td, params); }
function PRiSM_model_closedRectangle(td, params)           { return _CR.pd(td, params); }
function PRiSM_model_closedRectangle_pd_prime(td, params)  { return _CR.pdPrime(td, params); }
function PRiSM_model_intersecting(td, params)              { return _INT.pd(td, params); }
function PRiSM_model_intersecting_pd_prime(td, params)     { return _INT.pdPrime(td, params); }
function PRiSM_model_fogBoundary(td, params)               { return _FOG.pd(td, params); }
function PRiSM_model_fogBoundary_pd_prime(td, params)      { return _FOG.pdPrime(td, params); }

// ============================================================================
// SECTION 11 — MODEL #30 — Partial-penetration hydraulic fracture
// ============================================================================
// Reference: Gringarten & Ramey, SPEJ Oct 1973 (source functions).
//   Green's-function shortcut (engineering approximation, ~5%): uniform-flux
//   fracture kernel (early fracture-linear flow) + a partial-height vertical
//   kernel exp(−√s/(hf/h))/(s(1+√s)) + an off-centre constant (zw/h − ½)².
// Params: { Cd, S, hf_to_h, zw_to_h }      refLength: xf
// ============================================================================

var PPF_DEFAULTS = { Cd: 100, S: 0, hf_to_h: 0.5, zw_to_h: 0.5 };
function _lapPartialPenFrac(p) {
  var hf = p.hf_to_h, zw = p.zw_to_h;
  if (!_num(hf) || hf <= 0 || hf > 1) throw new Error('PRiSM partialPenFrac: hf_to_h must be in (0,1]');
  if (!_num(zw) || zw < 0 || zw > 1) throw new Error('PRiSM partialPenFrac: zw_to_h must be in [0,1]');
  var A = 1 / hf, dz = zw - 0.5;
  return function (s) {
    var q = Math.sqrt(s);
    return _lapInfFrac(s, true) + Math.exp(-A * q) / (s * (1 + q)) + dz * dz / s;
  };
}
function _ppfEval(td, params, deriv) {
  _checkTd(td);
  var p = _prep(params, PPF_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapPartialPenFrac(p), td, p.Cd, _num(p.S) ? p.S : 0,
                           { scaleDistances: false, derivative: deriv });
}
function PRiSM_model_partialPenFrac(td, params)          { return _ppfEval(td, params, false); }
function PRiSM_model_partialPenFrac_pd_prime(td, params) { return _ppfEval(td, params, true); }

// ============================================================================
// SECTION 12 — REGISTRY
// ============================================================================
// Metadata consumed by the physical-model wrapper (C3) and the regression:
//   refLength      'rw' | 'xf' | 'Lh'  — length that td and Cd refer to
//   defaultFrozen  parameters frozen unless the user frees them
//   paramSpec[i].scale 'log' — regress in log space
//   timeInput      'td'  — the evaluator takes dimensionless time
//   pseudoSkin(params, geom) / equivalentSkin(params, geom) → number | NaN
//     geom = {h, rw, xf, Lh, kvkh} in ft (optional; params.__h_rw used if set)

function _geomHRw(params, geom) {
  if (geom && _num(geom.h) && _num(geom.rw) && geom.rw > 0) return geom.h / geom.rw;
  return _hRw(params || {});
}

var CD_SPEC = { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' };
function _cd(def) { var o = {}; for (var k in CD_SPEC) o[k] = CD_SPEC[k]; if (def != null) o.default = def; return o; }
function _sSpec() { return { key: 'S', label: 'Skin S', unit: '-', min: -7, max: 50, default: 0 }; }

var REGISTRY_ADDITIONS = {
  homogeneous: {
    pd: PRiSM_model_homogeneous_rwa,
    pdPrime: PRiSM_model_homogeneous_rwa_pd_prime,
    defaults: { Cd: 100, S: 0 },
    paramSpec: [ _cd(100), _sSpec() ],
    reference: 'Agarwal, Al-Hussainy & Ramey, SPEJ Sept 1970; Bourdet 2002 §3.2',
    category: 'homogeneous',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Vertical well in an infinite-acting homogeneous reservoir, with wellbore storage and constant skin (damaged or stimulated).'
  },

  infiniteFrac: {
    pd: PRiSM_model_infiniteFrac,
    pdPrime: PRiSM_model_infiniteFrac_pd_prime,
    defaults: { Cd: 100, S: 0 },
    paramSpec: [ _cd(100), _sSpec() ],
    reference: 'Gringarten, Ramey & Raghavan, SPEJ Aug 1974',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      if (!geom || !_num(geom.xf) || !_num(geom.rw)) return NaN;
      return _fractureSkin(geom.xf, geom.rw, (params && params.uniformFlux) ? 'uniformFlux' : 'infinite');
    },
    description: 'Vertical well with an infinite-conductivity hydraulic fracture in a homogeneous reservoir (half-slope linear flow, then pseudo-radial).'
  },

  finiteFrac: {
    pd: PRiSM_model_finiteFrac,
    pdPrime: PRiSM_model_finiteFrac_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1e4, default: 10, scale: 'log' }
    ],
    reference: 'Cinco-Ley, Samaniego & Dominguez, SPEJ Aug 1978 (semi-analytic, 20 segments)',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      if (!geom || !_num(geom.xf) || !_num(geom.rw)) return NaN;
      return _fractureSkin(geom.xf, geom.rw, 'finite', (params && params.FcD) || 10);
    },
    description: 'Vertical well with a finite-conductivity hydraulic fracture (bilinear, linear, then pseudo-radial flow).'
  },

  inclined: {
    pd: PRiSM_model_inclined,
    pdPrime: PRiSM_model_inclined_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 1.0, theta_deg: 45, hp_to_h: 1.0 },
    paramSpec: [
      _cd(100),
      { key: 'S_perf',    label: 'Mechanical skin',      unit: '-',   min: -7,    max: 50,  default: 0 },
      { key: 'S_global',  label: 'Global skin',          unit: '-',   min: -7,    max: 50,  default: 0 },
      { key: 'KvKh',      label: 'Anisotropy Kv/Kh',     unit: '-',   min: 0.001, max: 10,  default: 1, scale: 'log' },
      { key: 'theta_deg', label: 'Inclination angle',    unit: 'deg', min: 0,     max: 75,  default: 45 },
      { key: 'hp_to_h',   label: 'Open fraction hp/h',   unit: '-',   min: 0.01,  max: 1,   default: 1.0 }
    ],
    reference: 'Cinco, Miller & Ramey, JPT Nov 1975 (slant-well pseudo-skin); Brons & Marting 1961',
    category: 'well-type',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: ['S_global', 'theta_deg', 'KvKh', 'hp_to_h'],
    timeInput: 'td',
    pseudoSkin: function (params, geom) {
      var p = _prep(params, INCL_DEFAULTS);
      p.__h_rw = _geomHRw(params, geom);
      return _inclinedPseudoSkin(p);
    },
    description: 'Slant well in a homogeneous reservoir: vertical-well response with the Cinco-Ley inclination pseudo-skin (always negative).'
  },

  horizontal: {
    pd: PRiSM_model_horizontal,
    pdPrime: PRiSM_model_horizontal_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0, zw_to_h: 0.5 },
    paramSpec: [
      _cd(100),
      { key: 'S_perf',   label: 'Mechanical skin',          unit: '-', min: -7,    max: 50,  default: 0 },
      { key: 'S_global', label: 'Global skin',              unit: '-', min: -7,    max: 50,  default: 0 },
      { key: 'KvKh',     label: 'Anisotropy Kv/Kh',         unit: '-', min: 0.001, max: 10,  default: 0.1, scale: 'log' },
      { key: 'L_to_h',   label: 'Well length / thickness L/h', unit: '-', min: 0.1, max: 200, default: 5.0, scale: 'log' },
      { key: 'zw_to_h',  label: 'Vertical position zw/h',   unit: '-', min: 0,     max: 1,   default: 0.5 }
    ],
    reference: 'Ozkan & Raghavan, SPEFE Sept 1991 (uniform-flux line source in a slab)',
    category: 'well-type',
    kind: 'pressure',
    refLength: 'Lh',
    refLengthNote: 'Lh = half-length = 0.5·L_to_h·h; td and Cd are referenced to Lh. A wrapper that floats Lh should inject __Lh_h = Lh/h (overrides L_to_h) and freeze L_to_h.',
    defaultFrozen: ['S_global'],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      var p = _prep(params, HORIZ_DEFAULTS);
      var hRw = _geomHRw(params, geom);
      return _horizontalEquivalent(p.L_to_h, 1, 1 / hRw, p.KvKh);
    },
    description: 'Horizontal well: early radial flow in the vertical plane, intermediate linear flow, late pseudo-radial flow.'
  },

  linearBoundary: {
    pd: PRiSM_model_linearBoundary,
    pdPrime: PRiSM_model_linearBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, BC: 'noflow' },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF', label: 'Distance to boundary', unit: 'r_w', min: 1, max: 1e7, default: 1000, scale: 'log' },
      { key: 'BC', label: 'Boundary condition',   unit: '',    options: ['noflow', 'constP'], default: 'noflow' }
    ],
    reference: 'van Poolen, Bixel & Jargon, JPT Aug 1963',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Single linear boundary (sealing fault or constant pressure) via an image well.'
  },

  parallelChannel: {
    pd: PRiSM_model_parallelChannel,
    pdPrime: PRiSM_model_parallelChannel_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF1', label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dF2', label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 (complete image lattice)',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Two parallel sealing faults (channel): late-time half-slope linear flow.'
  },

  closedChannel3: {
    pd: PRiSM_model_closedChannel3,
    pdPrime: PRiSM_model_closedChannel3_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, dEnd: 1000 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF1',  label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e7, default: 500,  scale: 'log' },
      { key: 'dF2',  label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e7, default: 500,  scale: 'log' },
      { key: 'dEnd', label: 'Distance to end wall', unit: 'r_w', min: 1, max: 1e7, default: 1000, scale: 'log' }
    ],
    reference: 'van Poolen et al., JPT Aug 1963',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Channel closed at one end (three sealing faults): linear flow doubles its derivative once the end wall is felt.'
  },

  closedRectangle: {
    pd: PRiSM_model_closedRectangle,
    pdPrime: PRiSM_model_closedRectangle_pd_prime,
    defaults: { Cd: 100, S: 0, dN: 500, dS: 500, dE: 500, dW: 500 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dN', label: 'Distance north', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dS', label: 'Distance south', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dE', label: 'Distance east',  unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dW', label: 'Distance west',  unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' }
    ],
    reference: 'van Poolen et al., JPT Aug 1963; Earlougher, SPE Monograph 5 — full image lattice',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Closed rectangle with the well anywhere inside: late-time pseudo-steady state (unit slope).'
  },

  intersecting: {
    pd: PRiSM_model_intersecting,
    pdPrime: PRiSM_model_intersecting_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, angleDeg: 90 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF1',      label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dF2',      label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'angleDeg', label: 'Intersection angle',  unit: 'deg', min: 1, max: 359, default: 90 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 — circular image pattern',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Two intersecting sealing faults: derivative rises by 360/angle.'
  },

  fogBoundary: {
    pd: PRiSM_model_fogBoundary,
    pdPrime: PRiSM_model_fogBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, fog: 0.5 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF',  label: 'Distance to fault', unit: 'r_w', min: 1, max: 1e7, default: 1000, scale: 'log' },
      { key: 'fog', label: 'Image strength (1 sealing, 0 open, −1 constant pressure)', unit: '-', min: -1, max: 1, default: 0.5 }
    ],
    reference: 'Constant partial-image approximation of a leaky fault (image of strength fog)',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    label: 'Leaky fault — constant partial-image approximation',
    description: 'Leaky fault — constant partial-image approximation: one image well of strength fog ∈ [−1, 1]. Approximate; not the rigorous semi-permeable-fault solution.'
  },

  finiteFracSkin: {
    pd: PRiSM_model_finiteFracSkin,
    pdPrime: PRiSM_model_finiteFracSkin_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10, Sf: 0.5 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1e4, default: 10, scale: 'log' },
      { key: 'Sf',  label: 'Fracture-face skin Sf',     unit: '-', min: 0,   max: 20,  default: 0.5 }
    ],
    reference: 'Cinco-Ley & Samaniego, JPT Sept 1981',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      if (!geom || !_num(geom.xf) || !_num(geom.rw)) return NaN;
      var p = params || {};
      return _fractureSkin(geom.xf, geom.rw, 'finite', p.FcD || 10) + (_num(p.Sf) ? p.Sf : 0);
    },
    description: 'Finite-conductivity fracture with fracture-face damage (Sf) that masks early bilinear flow.'
  },

  partialPenFrac: {
    pd: PRiSM_model_partialPenFrac,
    pdPrime: PRiSM_model_partialPenFrac_pd_prime,
    defaults: { Cd: 100, S: 0, hf_to_h: 0.5, zw_to_h: 0.5 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'hf_to_h', label: 'Fracture-height fraction hf/h', unit: '-', min: 0.01, max: 1, default: 0.5 },
      { key: 'zw_to_h', label: 'Vertical position zw/h',         unit: '-', min: 0,    max: 1, default: 0.5 }
    ],
    reference: 'Gringarten & Ramey, SPEJ Oct 1973 (Green\'s-function shortcut)',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Partial-height hydraulic fracture (approximate Green\'s-function shortcut): fracture-linear, vertical-radial, then horizontal-radial flow.'
  }
};

(function _installRegistry() {
  var g = _G;
  if (!g.PRiSM_MODELS || typeof g.PRiSM_MODELS !== 'object') g.PRiSM_MODELS = {};
  for (var key in REGISTRY_ADDITIONS) {
    if (Object.prototype.hasOwnProperty.call(REGISTRY_ADDITIONS, key)) {
      g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
    }
  }
  // shared kernels / evaluator for every other model file
  g.PRiSM_evalWbsSkin        = PRiSM_evalWbsSkin;
  g.PRiSM_pd_lap_homogeneous = function (s) { return _wellTerm(s); };
  g.PRiSM_lap_wellTerm       = _wellTerm;
  g.PRiSM_lap_imageTerm      = _imageTerm;
  g.PRiSM_lap_infiniteFrac   = function (s, params) { return _lapInfFrac(s, !!(params && params.uniformFlux)); };
  g.PRiSM_lap_horizontal     = PRiSM_lap_horizontal;
  g.PRiSM_intK0              = _intK0;
  var ps = (g.PRiSM_pseudoSkin && typeof g.PRiSM_pseudoSkin === 'object') ? g.PRiSM_pseudoSkin : {};
  ps.bronsMarting         = _bronsMarting;
  ps.cincoLey             = _cincoLey;
  ps.fracture             = _fractureSkin;
  ps.horizontalEquivalent = _horizontalEquivalent;
  g.PRiSM_pseudoSkin = ps;
  // evaluator functions on the global so other modules can reference them
  g.PRiSM_model_homogeneous_rwa          = PRiSM_model_homogeneous_rwa;
  g.PRiSM_model_homogeneous_rwa_pd_prime = PRiSM_model_homogeneous_rwa_pd_prime;
  g.PRiSM_model_infiniteFrac             = PRiSM_model_infiniteFrac;
  g.PRiSM_model_infiniteFrac_pd_prime    = PRiSM_model_infiniteFrac_pd_prime;
  g.PRiSM_model_finiteFrac               = PRiSM_model_finiteFrac;
  g.PRiSM_model_finiteFrac_pd_prime      = PRiSM_model_finiteFrac_pd_prime;
  g.PRiSM_model_inclined                 = PRiSM_model_inclined;
  g.PRiSM_model_inclined_pd_prime        = PRiSM_model_inclined_pd_prime;
  g.PRiSM_model_horizontal               = PRiSM_model_horizontal;
  g.PRiSM_model_horizontal_pd_prime      = PRiSM_model_horizontal_pd_prime;
  g.PRiSM_model_linearBoundary           = PRiSM_model_linearBoundary;
  g.PRiSM_model_linearBoundary_pd_prime  = PRiSM_model_linearBoundary_pd_prime;
  g.PRiSM_model_parallelChannel          = PRiSM_model_parallelChannel;
  g.PRiSM_model_parallelChannel_pd_prime = PRiSM_model_parallelChannel_pd_prime;
  g.PRiSM_model_closedChannel3           = PRiSM_model_closedChannel3;
  g.PRiSM_model_closedChannel3_pd_prime  = PRiSM_model_closedChannel3_pd_prime;
  g.PRiSM_model_closedRectangle          = PRiSM_model_closedRectangle;
  g.PRiSM_model_closedRectangle_pd_prime = PRiSM_model_closedRectangle_pd_prime;
  g.PRiSM_model_intersecting             = PRiSM_model_intersecting;
  g.PRiSM_model_intersecting_pd_prime    = PRiSM_model_intersecting_pd_prime;
  g.PRiSM_model_fogBoundary              = PRiSM_model_fogBoundary;
  g.PRiSM_model_fogBoundary_pd_prime     = PRiSM_model_fogBoundary_pd_prime;
  g.PRiSM_model_finiteFracSkin           = PRiSM_model_finiteFracSkin;
  g.PRiSM_model_finiteFracSkin_pd_prime  = PRiSM_model_finiteFracSkin_pd_prime;
  g.PRiSM_model_partialPenFrac           = PRiSM_model_partialPenFrac;
  g.PRiSM_model_partialPenFrac_pd_prime  = PRiSM_model_partialPenFrac_pd_prime;
})();

// ============================================================================
// === SELF-TEST ===
// ============================================================================
// Registry scan + key textbook asymptotes. Stripped at concat.

(function _selfTest() {
  var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
  var fails = [];
  function check(name, ok, detail) { if (!ok) fails.push(name + (detail ? ' — ' + detail : '')); }
  function near(name, v, e, tol) { check(name, Math.abs(v - e) <= tol, 'got ' + v + ', expected ' + e + ' ± ' + tol); }
  var td = [];
  for (var i = -2; i <= 7; i += 0.5) td.push(Math.pow(10, i));
  var keys = Object.keys(REGISTRY_ADDITIONS);
  keys.forEach(function (key) {
    var m = REGISTRY_ADDITIONS[key];
    [-3, 0, 2.5].forEach(function (S) {
      var p = {}, k;
      for (k in m.defaults) p[k] = m.defaults[k];
      if ('S' in p) p.S = S; else p.S_perf = S;
      try {
        var pd = m.pd(td, p), dp = m.pdPrime(td, p);
        for (var j = 0; j < td.length; j++) {
          if (!isFinite(pd[j]) || pd[j] < 0 || !isFinite(dp[j])) { check(key + ' S=' + S, false, 'bad value at td=' + td[j]); break; }
          if (j > 0 && pd[j] < pd[j - 1] * (1 - 1e-9)) { check(key + ' S=' + S, false, 'not monotone at td=' + td[j]); break; }
        }
      } catch (e) { check(key + ' S=' + S, false, 'threw ' + (e && e.message)); }
    });
  });
  var hom = REGISTRY_ADDITIONS.homogeneous;
  near('homogeneous S=-3 late', hom.pd(1e6, { Cd: 100, S: -3 }), 0.5 * (Math.log(1e6) + 0.80907) - 3, 0.01);
  near('inclined S_theta 45', _cincoLey(45, 1, 100 / 0.354), -1.511, 0.01);
  near('Brons-Marting b=0.2', _bronsMarting(0.2, 35, 0.354, 1), 10.79, 0.02);
  near('infiniteFrac late', PRiSM_model_infiniteFrac(1e5, { Cd: 0, S: 0 }), 0.5 * (Math.log(1e5) + 2.20), 0.03);
  near('parallelChannel pd\'(1e8)', PRiSM_model_parallelChannel_pd_prime(1e8, {}), 17.73, 0.36);
  if (fails.length) {
    log('PRiSM 03-models: SELF-TEST FAILED');
    fails.forEach(function (f) { log('  ' + f); });
  } else {
    log('PRiSM 03-models: all ' + keys.length + ' registry models finite, >= 0 and monotone; asymptotes OK');
  }
})();

})();  // end IIFE
