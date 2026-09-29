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


// =============================================================================
// === SELF-TEST ===
// =============================================================================
// Standalone check (stripped at concat): every evaluator finite at defaults;
// horizontal kernel early-radial / late derivatives; interference late time;
// multi-layer monotone at small λ.
// =============================================================================

(function _selfTest() {
    var report = [], allOk = true;
    function check(name, ok, detail) {
        if (!ok) { allOk = false; report.push('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
    }
    try {
        var tdVec = [1, 10, 100];
        Object.keys(REGISTRY_ADDITIONS).forEach(function (key) {
            var e = REGISTRY_ADDITIONS[key];
            var v = e.pd(tdVec, e.defaults), d = e.pdPrime(tdVec, e.defaults);
            check(key + ' finite', v.every(_num) && d.every(_num), JSON.stringify(v));
        });
        var P = { Cd: 1e-6, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5, zw_to_h: 0.5,
                  layers: [{ kh: 1, omega: 0.5, lambda: 0 }], __h_rw: 100 };
        var late = PRiSM_model_mlNoXFHoriz_pd_prime([1e5], P)[0];
        check('horizontal late derivative 0.5', Math.abs(late - 0.5) < 0.02, late);
        var itf = PRiSM_model_interference_pd_prime([1e9], { Cd: 100, S: 0, rxObs: 1000 })[0];
        check('interference late derivative 0.5', Math.abs(itf - 0.5) < 0.01, itf);
        var ml = PRiSM_model_inclinedMLXF([1, 10, 100, 1e3, 1e4], {
            Cd: 100, S_perf: 0, S_global: 0, KvKh: 1, theta_deg: 45, hp_to_h: 1,
            layers: [{ kh: 60, omega: 0.6, lambda: 1e-6 }, { kh: 40, omega: 0.4, lambda: 1e-6 }] });
        var mono = true;
        for (var i = 1; i < ml.length; i++) if (!(ml[i] >= ml[i - 1])) mono = false;
        check('inclinedMLXF monotone (λ 1e-6)', mono, JSON.stringify(ml));
        check('Cinco-Ley 45°', Math.abs(_cincoLeyLocal(45, 1, 100 / 0.354) + 1.511) < 0.01);
    } catch (e) {
        allOk = false; report.push('THREW ' + (e && e.message ? e.message : e));
    }
    if (typeof console !== 'undefined' && console.log) {
        if (allOk) console.log('PRiSM 09: self-test passed (16 interference / multi-lateral evaluators)');
        else { console.log('PRiSM 09: SELF-TEST FAILED'); report.forEach(function (r) { console.log('  ' + r); }); }
    }
})();

})();  // end IIFE
