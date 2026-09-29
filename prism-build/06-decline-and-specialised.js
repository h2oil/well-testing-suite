// =============================================================================
// PRiSM — Layer 06 — Decline-Curve (Phase 3) + Specialised Single-Well (Phase 4)
// =============================================================================
// This file adds 7 evaluators to the PRiSM model registry:
//
//   Decline curves (rate-vs-time, kind: 'rate', timeInput: 'days'):
//     1. arps        — exponential / hyperbolic / harmonic (b-factor switch),
//                      optional modified-hyperbolic terminal decline Dmin
//     2. duong       — Duong (2011) shale decline
//     3. sepd        — Stretched-exponential production decline (Valko 2009)
//     4. fetkovich   — Fetkovich (1980) type curve: rigorous closed-circle
//                      constant-pwf transient stems + Arps depletion stems
//
//   Specialised single-well (pressure-vs-time, kind: 'pressure'):
//     5. doublePorosity — Warren-Root naturally fractured (PSS / 1DT / 3DT)
//     6. partialPen     — Partial-penetration vertical well
//     7. verticalPulse  — Vertical pulse-test (separated observation point)
//
// Time convention for the decline models: t is REAL production time in DAYS
// (registry `timeInput: 'days'`), rates in STB/d or Mscf/d, Di and Dmin in
// 1/day.  t = 0 is accepted by arps, sepd and fetkovich (t·dq/dt = 0 there).
//
// EUR helpers (cumulative production from t = 0 to t_end, days):
//   PRiSM_eur_arps(params, t_end)       closed form, Dmin-aware
//   PRiSM_eur_duong(params, t_end)      numerical
//   PRiSM_eur_sepd(params, t_end)       closed form (incomplete gamma)
//   PRiSM_eur_fetkovich(params, t_end)  numerical
// Arps / modified-hyperbolic helpers (for the DCA results panel):
//   PRiSM_arps_q, PRiSM_arps_Np, PRiSM_arps_D, PRiSM_arps_tSwitch,
//   PRiSM_arps_timeToRate, PRiSM_arps_eurToRate, PRiSM_arps_De
//   (also grouped on window.PRiSM_DECLINE)
// Fetkovich type curve (for the Blasingame / Fetkovich RTA plots):
//   PRiSM_fetkovich_typecurve(reD, b, tDd[]) → qDd[]
//   PRiSM_fetkovich_qD(tD, reD)             → rigorous constant-pwf qD
//
// Pressure models use the finite-wellbore well term and a WBS + skin fold that
// is valid for negative skin (effective-wellbore-radius transform).  The fold
// delegates to window.PRiSM_evalWbsSkin when that export is present and agrees
// with the local implementation; otherwise the local copy is used.
//
// All public symbols are PRiSM_* / window.PRiSM_MODELS to avoid collisions.
// =============================================================================

(function () {
'use strict';

// -- shared constants -------------------------------------------------------
var DERIV_REL_STEP  = 1e-3;     // relative log-step for numerical derivative
var EUR_INT_POINTS  = 240;      // log-spaced points for numerical EUR
var ARPS_B_EXP      = 1e-6;     // b below this → exponential branch

// -- foundation primitive resolver -----------------------------------------
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

// Decline models accept t ≥ 0 (t = 0 is the start of production).
function _requireNonNegT(t) {
  if (Array.isArray(t)) {
    for (var i = 0; i < t.length; i++) {
      if (!_num(t[i]) || t[i] < 0) {
        throw new Error('PRiSM 06: t must be ≥ 0 days (got ' + t[i] + ' at index ' + i + ')');
      }
    }
  } else if (!_num(t) || t < 0) {
    throw new Error('PRiSM 06: t must be ≥ 0 days (got ' + t + ')');
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

// EUR functions are PRiSM_eur_x(params, t_end).  Some callers pass
// (t_end, params); accept both orders.
function _eurArgs(a, b) {
  if (typeof a === 'number' && b && typeof b === 'object') return { p: b, t: a };
  return { p: a, t: b };
}

// generic numerical logarithmic derivative td * dPd/dtd via 5-point central
// difference in ln(td) space.
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
  return (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);  // == td * dPd/dtd
}

// trapezoidal integration of fn(t) over a log-spaced grid [t_min, t_end].
function _trapezoidalLog(fn, t_min, t_end, n) {
  if (!(t_end > t_min)) return 0;
  var lmin = Math.log(t_min), lmax = Math.log(t_end);
  var step = (lmax - lmin) / (n - 1);
  var sum = 0, tPrev = t_min, fPrev = fn(t_min);
  for (var j = 1; j < n; j++) {
    var t = Math.exp(lmin + j * step);
    var f = fn(t);
    var fy = (f + fPrev) * 0.5;
    if (_num(fy)) sum += fy * (t - tPrev);
    tPrev = t; fPrev = f;
  }
  return sum;
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

// ---- Pseudo-skin library (shared export preferred) --------------------------
function _pseudoLib() {
  var lib = _win().PRiSM_pseudoSkin;
  return (lib && typeof lib === 'object') ? lib : null;
}
// Brons-Marting (1961) partial-penetration pseudo-skin
//   Sp = (1/b − 1)·[ln hD − G(b)],  G = 2.948 − 7.363b + 11.45b² − 4.675b³
//   b = hp/h, hD = (h/rw)·√(kh/kv)
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
// h/rw injected by the physical-model wrapper as __h_rw (default 100).
function _hOverRw(params, geom) {
  if (geom && _num(geom.h) && _num(geom.rw) && geom.rw > 0) return geom.h / geom.rw;
  if (geom && _num(geom.h_rw) && geom.h_rw > 0) return geom.h_rw;
  if (params && _num(params.__h_rw) && params.__h_rw > 0) return params.__h_rw;
  return 100;
}


// =============================================================================
// SECTION A — DECLINE CURVES (Phase 3)
// =============================================================================
//
// Decline-curve evaluators take REAL elapsed production time t in DAYS and
// return RATE q(t).  They are exposed through the same evaluator interface as
// the pressure models, tagged kind: 'rate' + timeInput: 'days'.
// =============================================================================


// -----------------------------------------------------------------------------
// A.1 — ARPS DECLINE (+ optional modified-hyperbolic terminal decline)
// -----------------------------------------------------------------------------
//
// Reference: Arps, J.J. "Analysis of Decline Curves", Trans. AIME 160, 1945,
//            pp 228-247.  Modified hyperbolic: Robertson (1988).
//
//   q(t) = qi · exp(−ln(1 + b·Di·t)/b)          (b ≥ 1e-6; b = 1 harmonic)
//   q(t) = qi · exp(−Di·t)                        (b < 1e-6, exponential)
//
// Optional Dmin (1/day): the nominal decline D(t) = Di/(1 + b·Di·t) falls to
// Dmin at t_sw = (Di/Dmin − 1)/(b·Di); afterwards q = q_sw·exp(−Dmin(t−t_sw)).
// q and dq/dt are continuous at t_sw (C¹).
//
// Params: { qi, Di, b [, Dmin] }  — qi rate, Di & Dmin 1/day, b in [0, 2]
//
// Cumulative (closed form, numerically stable via log1p/expm1):
//   exponential : Np = (qi/Di)·(1 − e^{−Di·t})
//   harmonic    : Np = (qi/Di)·ln(1 + Di·t)
//   hyperbolic  : Np = qi/((1−b)·Di) · (1 − (1 + b·Di·t)^{1−1/b})
// -----------------------------------------------------------------------------

function _arpsP(params) {
  var qi = +params.qi, Di = +params.Di, b = +params.b;
  var Dmin = (params.Dmin != null) ? +params.Dmin : 0;
  var P = { qi: qi, Di: Di, b: b, Dmin: Dmin, exp: !(b >= ARPS_B_EXP),
            tsw: Infinity, qsw: 0, Npsw: 0, ok: true };
  if (!_num(qi) || !_num(Di) || !_num(b) || Di < 0 || b < 0) { P.ok = false; return P; }
  if (!P.exp && _num(Dmin) && Dmin > 0 && Dmin < Di) {
    P.tsw = (Di / Dmin - 1) / (b * Di);
    P.qsw = _arpsHypQ(P.tsw, P);
    P.Npsw = _arpsHypNp(P.tsw, P);
  }
  return P;
}
function _arpsHypQ(t, P) {
  if (P.Di === 0) return P.qi;
  if (P.exp) return P.qi * Math.exp(-P.Di * t);
  return P.qi * Math.exp(-Math.log1p(P.b * P.Di * t) / P.b);
}
function _arpsHypNp(t, P) {
  if (!(t > 0)) return 0;
  if (P.Di === 0) return P.qi * t;
  if (P.exp) return (P.qi / P.Di) * -Math.expm1(-P.Di * t);
  var L = Math.log1p(P.b * P.Di * t);
  var omb = 1 - P.b;
  if (omb === 0) return P.qi * L / P.Di;
  // qi/((1−b)Di) · (1 − exp(−((1−b)/b)·L))
  return P.qi / (omb * P.Di) * -Math.expm1(-(omb / P.b) * L);
}
function _arpsQ(t, P) {
  if (!P.ok) return NaN;
  if (t <= P.tsw) return _arpsHypQ(t, P);
  return P.qsw * Math.exp(-P.Dmin * (t - P.tsw));
}
function _arpsNp(t, P) {
  if (!P.ok) return NaN;
  if (t <= P.tsw) return _arpsHypNp(t, P);
  return P.Npsw + (P.qsw / P.Dmin) * -Math.expm1(-P.Dmin * (t - P.tsw));
}
// nominal (instantaneous) decline D(t) = −(dq/dt)/q, 1/day
function _arpsD(t, P) {
  if (!P.ok) return NaN;
  if (P.exp) return P.Di;
  if (t > P.tsw) return P.Dmin;
  return P.Di / (1 + P.b * P.Di * t);
}
// time (days) at which q falls to qTarget
function _arpsTimeToRate(qTarget, P) {
  if (!P.ok || !(qTarget > 0)) return NaN;
  if (qTarget >= P.qi) return 0;
  if (!(P.Di > 0)) return Infinity;
  if (P.exp) return Math.log(P.qi / qTarget) / P.Di;
  if (qTarget >= P.qsw) {
    return Math.expm1(P.b * Math.log(P.qi / qTarget)) / (P.b * P.Di);
  }
  return P.tsw + Math.log(P.qsw / qTarget) / P.Dmin;
}

function _arpsRate(t, params) { return _arpsQ(t, _arpsP(params)); }

/**
 * Arps decline curve evaluator (rate vs time).
 * @param {number|number[]} td  Production time t in DAYS (t ≥ 0).
 * @param {{qi:number, Di:number, b:number, Dmin?:number}} params  Di, Dmin in 1/day
 * @returns {number|number[]}   Rate q(t)
 */
function PRiSM_model_arps(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b']);
  var P = _arpsP(params);
  return _arrayMap(td, function (t) { return _arpsQ(t, P); });
}

/**
 * t · dq/dt for Arps (≤ 0).  t · dq/dt = −t·D(t)·q(t); 0 at t = 0.
 */
function PRiSM_model_arps_pd_prime(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b']);
  var P = _arpsP(params);
  return _arrayMap(td, function (t) {
    if (t === 0) return 0;
    return -t * _arpsD(t, P) * _arpsQ(t, P);
  });
}

/**
 * Closed-form Arps cumulative production from t = 0 to t_end (days),
 * Dmin-aware.  Accepts (params, t_end) or (t_end, params).
 */
function PRiSM_eur_arps(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['qi', 'Di', 'b']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var P = _arpsP(params);
  var Q = _arpsNp(t_end, P);
  if (!_num(Q) || Q < 0) {
    Q = _trapezoidalLog(function (t) { return _arpsQ(t, P); },
                        Math.max(t_end * 1e-8, 1e-8), t_end, EUR_INT_POINTS);
  }
  return Q;
}

// Public helpers (days / 1/day) for the DCA results panel.
function PRiSM_arps_q(t, params)            { return _arpsQ(t, _arpsP(params)); }
function PRiSM_arps_Np(t, params)           { return (t > 0) ? _arpsNp(t, _arpsP(params)) : 0; }
function PRiSM_arps_D(t, params)            { return _arpsD(t, _arpsP(params)); }
function PRiSM_arps_tSwitch(params)         { return _arpsP(params).tsw; }
function PRiSM_arps_timeToRate(q, params)   { return _arpsTimeToRate(q, _arpsP(params)); }
/** EUR to an economic-limit rate qAb (Dmin-aware; Infinity if never reached). */
function PRiSM_arps_eurToRate(qAb, params) {
  var P = _arpsP(params);
  var t = _arpsTimeToRate(qAb, P);
  if (!_num(t)) return (t === Infinity) ? Infinity : NaN;
  return _arpsNp(t, P);
}
/** Effective decline over a period (default 365 d): 1 − q(T)/qi for the
 *  initial segment, i.e. hyperbolic 1 − (1 + b·Di·T)^(−1/b), exp 1 − e^(−Di·T). */
function PRiSM_arps_De(params, periodDays) {
  var T = _num(periodDays) && periodDays > 0 ? periodDays : 365;
  var P = _arpsP(params);
  if (!P.ok || !(P.qi > 0)) return NaN;
  return 1 - _arpsHypQ(T, P) / P.qi;
}


// -----------------------------------------------------------------------------
// A.2 — DUONG DECLINE
// -----------------------------------------------------------------------------
//
// Reference: Duong, A.N. "Rate-Decline Analysis for Fracture-Dominated Shale
//            Reservoirs", SPE 137748, October 2011.
//
//   q(t) = q1 · t^(-m) · exp( a/(1-m) · ( t^(1-m) - 1 ) )     (t in days)
//
// For m == 1 the exponent factor → a · ln(t).
//
// Params: { q1, a, m }
//   q1 : rate at t = 1 day
//   a  : intercept of the t·D vs t plot (1/day^(1−m))
//   m  : slope of log(q/q1) vs log(t) — typically 1.0 < m < 1.5
//
// q → ∞ as t → 0, so Duong requires t > 0.  EUR is numerical.
// -----------------------------------------------------------------------------

function _duongRate(t, params) {
  var q1 = params.q1, a = params.a, m = params.m;
  if (!_num(q1) || !_num(a) || !_num(m)) return NaN;
  if (t <= 0) return q1;
  if (Math.abs(1 - m) < 1e-10) {
    return q1 * Math.pow(t, -m) * Math.exp(a * Math.log(t));
  }
  var expArg = (a / (1 - m)) * (Math.pow(t, 1 - m) - 1);
  if (!_num(expArg)) return 0;
  return q1 * Math.pow(t, -m) * Math.exp(expArg);
}

/**
 * Duong shale-decline rate evaluator.
 * @param {number|number[]} td  Production time in days (> 0).
 * @param {{q1:number, a:number, m:number}} params
 */
function PRiSM_model_duong(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['q1', 'a', 'm']);
  return _arrayMap(td, function (t) { return _duongRate(t, params); });
}

/**
 * t · dq/dt for Duong:  t · dq/dt = q · ( -m + a · t^(1-m) ).
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

/** Duong EUR — numerical trapezoid on a log grid (days). */
function PRiSM_eur_duong(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['q1', 'a', 'm']);
  if (!_num(t_end) || t_end <= 0) return 0;
  return _trapezoidalLog(function (t) { return _duongRate(t, params); },
                         Math.max(t_end * 1e-6, 1e-6), t_end, EUR_INT_POINTS);
}


// -----------------------------------------------------------------------------
// A.3 — STRETCHED-EXPONENTIAL PRODUCTION DECLINE (SEPD)
// -----------------------------------------------------------------------------
//
// Reference: Valko, P.P. SPE 119369, 2009.
//
//   q(t) = qi · exp( -(t/tau)^n )            (t, tau in days; q(0) = qi)
//
// EUR has a closed form via the lower incomplete gamma function:
//   Q(t_end) = qi · tau · (1/n) · γ_inc(1/n, (t_end/tau)^n)
// -----------------------------------------------------------------------------

function _sepdRate(t, params) {
  var qi = params.qi, tau = params.tau, n = params.n;
  if (!_num(qi) || !_num(tau) || tau <= 0 || !_num(n) || n <= 0) return NaN;
  if (t <= 0) return qi;
  return qi * Math.exp(-Math.pow(t / tau, n));
}

/**
 * Stretched-exponential rate evaluator (Valko 2009).  t ≥ 0 days.
 */
function PRiSM_model_sepd(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'tau', 'n']);
  return _arrayMap(td, function (t) { return _sepdRate(t, params); });
}

/**
 * t · dq/dt for SEPD:  t · dq/dt = -q · n · (t/tau)^n  (0 at t = 0).
 */
function PRiSM_model_sepd_pd_prime(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'tau', 'n']);
  var tau = params.tau, n = params.n;
  return _arrayMap(td, function (t) {
    if (t === 0) return 0;
    var q = _sepdRate(t, params);
    return -q * n * Math.pow(t / tau, n);
  });
}

// Lanczos ln Γ (g = 7, n = 9), accuracy ~1e-15.
function _lnGamma(z) {
  var g = 7;
  var c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
           771.32342877765313, -176.61502916214059, 12.507343278686905,
           -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - _lnGamma(1 - z);
  }
  z -= 1;
  var x = c[0];
  for (var i = 1; i < g + 2; i++) x += c[i] / (z + i);
  var t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Lower incomplete gamma γ(a, x) (Numerical Recipes gser / gcf).
function _lowerIncGamma(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  var lng = _lnGamma(a);
  if (x < a + 1) {
    var ap = a, sum = 1 / a, del = sum;
    for (var k = 1; k < 500; k++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return Math.exp(-x + a * Math.log(x)) * sum;
  }
  var b = x + 1 - a;
  var FPMIN = 1e-300;
  var c = 1 / FPMIN, d = 1 / b, h = d;
  for (var i = 1; i < 500; i++) {
    var an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    var del2 = d * c;
    h *= del2;
    if (Math.abs(del2 - 1) < 1e-14) break;
  }
  var Q = Math.exp(-x + a * Math.log(x) - lng) * h;
  return Math.exp(lng) * (1 - Q);
}

/** SEPD EUR (closed form): Q = qi·tau·(1/n)·γ(1/n, (t_end/tau)^n). */
function PRiSM_eur_sepd(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['qi', 'tau', 'n']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var qi = params.qi, tau = params.tau, n = params.n;
  var arg = Math.pow(t_end / tau, n);
  var Q = qi * tau * (1 / n) * _lowerIncGamma(1 / n, arg);
  if (!_num(Q) || Q < 0) {
    Q = _trapezoidalLog(function (t) { return _sepdRate(t, params); },
                        Math.max(t_end * 1e-8, 1e-8), t_end, EUR_INT_POINTS);
  }
  return Q;
}


// -----------------------------------------------------------------------------
// A.4 — FETKOVICH TYPE CURVE
// -----------------------------------------------------------------------------
//
// References: Fetkovich, M.J. "Decline Curve Analysis Using Type Curves",
//             JPT June 1980, pp 1065-1077.  van Everdingen & Hurst (1949).
//
// Transient stems (rigorous): constant-pwf production from a well (finite
// wellbore, apparent radius rwa) centred in a closed circular reservoir,
// reD = re/rwa.  With the closed-circle constant-rate solution
//   p̄wD(s) = [I1(reD√s)K0(√s) + K1(reD√s)I0(√s)]
//            / ( s^{3/2}·[I1(reD√s)K1(√s) − K1(reD√s)I1(√s)] )
// the constant-pwf rate is q̄D(s) = 1/(s²·p̄wD(s)), inverted with Stehfest.
// Everything is evaluated with exponentially scaled Bessel functions because
// I1(reD√s) overflows for reD ≥ 1000.
//
// Fetkovich variables (using apparent radius, so skin is included):
//   qDd = qD·(ln reD − ½),   tDd = tD / (½·(reD² − 1)·(ln reD − ½))
// Depletion stems (Arps):    qDd = (1 + b·tDd)^(−1/b)   (b = 0 → exp(−tDd))
// The type curve is the rigorous transient solution for tDd ≤ 0.1, the Arps
// stem for tDd ≥ 0.3, and a C¹ smooth-step blend (in ln tDd) in between,
// which is how the published unified type curve joins the two families.
//
// Model (real time, days):   q(t) = qi · qDd(tDd = Di·t; reD, b)
// Params: { qi, Di, b, reD }  qi, Di (1/day) and b are the Arps parameters of
// the depletion stem; reD = re/rwa.  The constant-pwf transient rate is
// unbounded as t → 0, so t = 0 exactly returns qi (the Arps intercept, the
// usual start-of-production convention) and t·dq/dt = 0 there; for t > 0 the
// transient solution is evaluated with tD ≥ 0.01.
// -----------------------------------------------------------------------------

var FETK_BLEND_T0 = 0.1, FETK_BLEND_T1 = 0.3, FETK_TD_MIN = 1e-2;

function _fetkQDbar(s, reD) {
  var y = Math.sqrt(s);
  var r = 0;
  if (reD > 1) {
    var x = reD * y;
    var ex = 2 * y * (reD - 1);
    r = (ex < 700) ? (_K1e(x) / _I1e(x)) * Math.exp(-ex) : 0;
  }
  var num = _K1e(y) - r * _I1e(y);
  var den = y * (_K0e(y) + r * _I0e(y));
  return num / den;
}

/** Rigorous constant-pwf dimensionless rate qD(tD) for a closed circle. */
function PRiSM_fetkovich_qD(tD, reD) {
  var R = (_num(reD) && reD > 1.0001) ? reD : 1e12;
  return _arrayMap(tD, function (t) {
    var tt = (_num(t) && t > FETK_TD_MIN) ? t : FETK_TD_MIN;
    return _steh(function (s) { return _fetkQDbar(s, R); }, tt);
  });
}

function _fetkArpsStem(tDd, b) {
  if (!(b >= ARPS_B_EXP)) return Math.exp(-tDd);
  return Math.exp(-Math.log1p(b * tDd) / b);
}

function _fetkQDd(tDd, reD, b) {
  var R = Math.max(2, reD);
  var lnr = Math.log(R) - 0.5;
  if (!(tDd > 0)) tDd = 0;
  var stem = _fetkArpsStem(tDd, b);
  if (tDd >= FETK_BLEND_T1) return stem;
  var tDfac = 0.5 * (R * R - 1) * lnr;
  var tD = Math.max(tDd * tDfac, FETK_TD_MIN);
  var qT = _steh(function (s) { return _fetkQDbar(s, R); }, tD) * lnr;
  if (tDd <= FETK_BLEND_T0) return qT;
  var x = Math.log(tDd / FETK_BLEND_T0) / Math.log(FETK_BLEND_T1 / FETK_BLEND_T0);
  var w = x * x * (3 - 2 * x);
  return (1 - w) * qT + w * stem;
}

/**
 * Fetkovich unified type curve qDd(tDd) for re/rwa = reD and Arps stem b.
 * @param {number} reD  re/rwa (≥ 2)
 * @param {number} b    depletion-stem exponent (0 → exponential)
 * @param {number|number[]} tDd
 * @returns {number|number[]} qDd
 */
function PRiSM_fetkovich_typecurve(reD, b, tDd) {
  var R = _num(reD) ? reD : 1000, B = _num(b) ? b : 0;
  return _arrayMap(tDd, function (t) { return _fetkQDd(t, R, B); });
}

function _fetkovichRate(t, params) {
  var qi = params.qi, Di = params.Di, b = params.b, reD = params.reD;
  if (!_num(qi) || !_num(Di) || !_num(b) || !_num(reD) || Di < 0) return NaN;
  if (t === 0) return qi;   // start of production: the Arps intercept (see header)
  return qi * _fetkQDd(Di * t, reD, b);
}

/**
 * Fetkovich (1980) type-curve model.  Returns rate q(t) (t in days, ≥ 0).
 * @param {{qi:number, Di:number, b:number, reD:number}} params
 */
function PRiSM_model_fetkovich(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  return _arrayMap(td, function (t) { return _fetkovichRate(t, params); });
}

/** t · dq/dt for Fetkovich (numerical in ln t; 0 at t = 0). */
function PRiSM_model_fetkovich_pd_prime(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  return _arrayMap(td, function (t) {
    if (t === 0) return 0;
    return _numericLogDeriv(function (tt) { return _fetkovichRate(tt, params); }, t, params);
  });
}

/** Fetkovich EUR — numerical integration on a log grid (days). */
function PRiSM_eur_fetkovich(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var t0 = t_end * 1e-8;
  var head = _fetkovichRate(t0, params) * t0;
  return head + _trapezoidalLog(function (t) { return _fetkovichRate(t, params); },
                                t0, t_end, EUR_INT_POINTS);
}


// =============================================================================
// SECTION B — SPECIALISED SINGLE-WELL MODELS (Phase 4)
// =============================================================================
//
// PRESSURE-vs-time models (kind: 'pressure', refLength 'rw').  They use the
// finite-wellbore well term and the negative-skin-safe WBS + skin fold above.
// pdPrime is computed from the Laplace identity (no numerical differencing).
// =============================================================================


// -----------------------------------------------------------------------------
// B.1 — DOUBLE-POROSITY RESERVOIR (Warren-Root)
// -----------------------------------------------------------------------------
//
// References:
//   Warren, J.E., Root, P.J. SPEJ Sept 1963, pp 245-255 (PSS).
//   Mavor, M.J., Cinco-Ley, H. SPE 7977 (1979).
//   Gringarten, A.C. SPE 10044 (1982).
//
//   ω (omega)  : fracture storativity ratio in (0, 1)
//   λ (lambda) : interporosity flow coefficient (∝ rw²)
//
//   'pss'  f(s) = ( ω·(1-ω)·s + λ ) / ( (1-ω)·s + λ )
//   '1dt'  f(s) = ω + (1-ω) · tanh(arg) / arg,        arg = √(3(1-ω)s/λ)
//   '3dt'  f(s) = ω + (1-ω) · 3·(arg·coth(arg) − 1)/arg², arg = √(15(1-ω)s/λ)
//
//   p̄(s) = K0(√(s·f)) / ( s·√(s·f)·K1(√(s·f)) )     (finite wellbore)
//
// Params: { Cd, S, omega, lambda, interporosityMode }
// -----------------------------------------------------------------------------

function _doublePor_f_pss(s, omega, lambda) {
  var num = omega * (1 - omega) * s + lambda;
  var den = (1 - omega) * s + lambda;
  if (den === 0 || !_num(den)) return omega;
  return num / den;
}

function _doublePor_f_1dt(s, omega, lambda) {
  if (lambda <= 0) return omega;
  var arg2 = 3 * (1 - omega) * s / lambda;
  if (arg2 <= 0) return omega;
  var arg = Math.sqrt(arg2);
  var tanhOverArg;
  if (arg > 20)        tanhOverArg = 1 / arg;
  else if (arg < 1e-4) tanhOverArg = 1 - arg * arg / 3;
  else                 tanhOverArg = Math.tanh(arg) / arg;
  return omega + (1 - omega) * tanhOverArg;
}

function _doublePor_f_3dt(s, omega, lambda) {
  if (lambda <= 0) return omega;
  var arg2 = 15 * (1 - omega) * s / lambda;
  if (arg2 <= 0) return omega;
  var arg = Math.sqrt(arg2);
  var fac;
  if (arg > 20) {
    fac = 3 * (arg - 1) / (arg * arg);                 // coth → 1
  } else if (arg < 1e-3) {
    fac = 1 - arg * arg / 15;                          // series
  } else {
    fac = 3 * (arg / Math.tanh(arg) - 1) / (arg * arg);
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

function _checkDoublePor(params) {
  if (!_num(params.omega) || params.omega <= 0 || params.omega >= 1) {
    throw new Error('PRiSM doublePorosity: omega must be in (0, 1)');
  }
  if (!_num(params.lambda) || params.lambda <= 0) {
    throw new Error('PRiSM doublePorosity: lambda must be > 0');
  }
  if (params.interporosityMode &&
      ['pss', '1dt', '3dt'].indexOf(params.interporosityMode) === -1) {
    throw new Error('PRiSM doublePorosity: interporosityMode must be "pss", "1dt", or "3dt"');
  }
}

// sc = e^S under the negative-skin transform: λ ∝ rw² → λ/sc².
function _pdLap_doublePor(s, params, sc) {
  var lam = params.lambda / ((sc || 1) * (sc || 1));
  var f = _doublePor_f(params.interporosityMode || 'pss', s, params.omega, lam);
  var sf = s * f;
  if (!(sf > 0) || !_num(sf)) return 1e30;
  return _wellTerm(Math.sqrt(sf)) / s;
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
  _checkDoublePor(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_doublePor(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_doublePorosity_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'omega', 'lambda']);
  _checkDoublePor(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_doublePor(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// B.2 — PARTIAL-PENETRATION VERTICAL WELL
// -----------------------------------------------------------------------------
//
// References: Brons, F., Marting, V.E. (1961) partial-penetration pseudo-skin;
//             Gringarten-Ramey (1974); Earlougher Monograph 5 §2.6.
//
// Three regimes: early radial flow over hp (derivative 0.5/(hp/h)),
// spherical transition, late radial over h (derivative 0.5).
//
// Kernel (phenomenological Laplace blend, unchanged in shape; the well terms
// use the finite-wellbore form so early time is storage-dominated):
//
//   p̄(s) = w·p̄_perf + (1−w)·p̄_full + w(1−w)·p̄_sph,  w = s·hp/(1 + s·hp)
//   p̄_full = K0(√s·heff)/(s·√s·K1(√s)),  p̄_perf = (1/hp)·K0(y)/(s·y·K1(y)),
//   y = √(s/hp),  p̄_sph = 0.1·√hp·exp(−α_sph·√s)/s
//
// Geometric pseudo-skin (late-time offset vs a fully penetrating well):
//   Sg = Brons-Marting(b = hp/h, hD = (h/rw)·√(kh/kv))
// h/rw comes from the injected __h_rw (default 100).  The total skin in the
// fold is S_perf + S_global + Sg; S_global is frozen by default because it is
// collinear with S_perf.
//
// Params: { Cd, S_perf, S_global, KvKh, hp_to_h, zw_to_h, h_eff }
// -----------------------------------------------------------------------------

function _partialPen_pseudoskin(params, geom) {
  var KvKh = params.KvKh, hp = params.hp_to_h;
  if (!_num(KvKh) || KvKh <= 0 || !_num(hp) || hp <= 0 || hp >= 1) return 0;
  var hD = _hOverRw(params, geom) * Math.sqrt(1 / KvKh);
  return _bronsMarting(hp, hD);
}

function _checkPartialPen(params, label) {
  var hp = params.hp_to_h, zw = params.zw_to_h, KvKh = params.KvKh;
  if (!_num(hp) || hp <= 0 || hp > 1) {
    throw new Error('PRiSM ' + label + ': hp_to_h must be in (0, 1]');
  }
  if (!_num(zw) || zw < 0 || zw > 1) {
    throw new Error('PRiSM ' + label + ': zw_to_h must be in [0, 1]');
  }
  if (!_num(KvKh) || KvKh <= 0) {
    throw new Error('PRiSM ' + label + ': KvKh must be > 0');
  }
}

// K0(y·r)/(y·K1(y)) — well-normalised line source at distance r (≥ 0.05)
function _kOverWell(y, r) {
  r = Math.max(r, 0.05);
  var ex = -y * (r - 1);
  if (ex > 700) ex = 700;
  return _K0e(y * r) / (y * _K1e(y)) * Math.exp(ex);
}

function _pdLap_partialPen(s, params) {
  var hp = params.hp_to_h;
  var zw = params.zw_to_h;
  var KvKh = params.KvKh;
  var heff = (params.h_eff != null && _num(params.h_eff)) ? params.h_eff : 1.0;
  var y = Math.sqrt(s);
  var pdFull = _kOverWell(y, Math.max(heff, 0.1)) / s;
  var pdPerf = (1 / hp) * _wellTerm(y / Math.sqrt(hp)) / s;
  var dz = zw - 0.5;
  var alphaSph = (1 / Math.sqrt(KvKh)) * (1 + 4 * dz * dz);
  var pdSph = (0.1 * Math.sqrt(hp)) * Math.exp(-alphaSph * y) / s;
  var w = (s * hp) / (1 + s * hp);
  return w * pdPerf + (1 - w) * pdFull + pdSph * (w * (1 - w));
}

function _partialPenStotal(params) {
  return (params.S_perf || 0) + (params.S_global || 0) + _partialPen_pseudoskin(params);
}

/**
 * Partial-penetration vertical well.
 * @param {number|number[]} td
 * @param {{Cd:number, S_perf:number, S_global:number, KvKh:number,
 *          hp_to_h:number, zw_to_h:number, h_eff:number, __h_rw?:number}} params
 */
function PRiSM_model_partialPen(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'hp_to_h', 'zw_to_h']);
  _checkPartialPen(params, 'partialPen');
  return _evalWbsSkin(function (s) { return _pdLap_partialPen(s, params); },
                      td, params.Cd, _partialPenStotal(params), false);
}

function PRiSM_model_partialPen_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'hp_to_h', 'zw_to_h']);
  _checkPartialPen(params, 'partialPen');
  return _evalWbsSkin(function (s) { return _pdLap_partialPen(s, params); },
                      td, params.Cd, _partialPenStotal(params), true);
}


// -----------------------------------------------------------------------------
// B.3 — VERTICAL PULSE-TEST
// -----------------------------------------------------------------------------
//
// Reference: Gringarten, A.C., Ramey, H.J. SPE 3818 / SPEJ Oct 1973;
//            Earlougher Monograph 5 §10; Streltsova (1988).
//
// Same geometry as B.2, pressure measured at a separate vertical point.
// Green's-function shortcut: the observation response is a line-source
// kernel at an effective distance combining the wellbore scale and the
// anisotropy-scaled vertical separation:
//
//   rEff = √(heff² + dz_eff²),  dz_eff = |zobs − zw|/√(Kv/Kh)·max(√hp, 0.1)
//   p̄(s) = K0(√s·rEff) / ( s·√s·K1(√s) )
//
// Total skin S_perf + Sg, Sg = Brons-Marting(hp/h, (h/rw)·√(kh/kv)).
//
// Params: { Cd, S_perf, KvKh, hp_to_h, zw_to_h, zobs_to_h, h_eff }
// -----------------------------------------------------------------------------

function _pdLap_verticalPulse(s, params) {
  var hp = params.hp_to_h;
  var zw = params.zw_to_h;
  var zobs = params.zobs_to_h;
  var KvKh = params.KvKh;
  var heff = (params.h_eff != null && _num(params.h_eff)) ? params.h_eff : 1.0;
  var y = Math.sqrt(s);
  var dz_eff = Math.abs(zobs - zw) / Math.sqrt(KvKh);
  dz_eff *= Math.max(Math.sqrt(hp), 0.1);
  var rEff = Math.sqrt(heff * heff + dz_eff * dz_eff);
  if (!(rEff > 0)) rEff = heff;
  return _kOverWell(y, rEff) / s;
}

function _checkVerticalPulse(params) {
  _checkPartialPen(params, 'verticalPulse');
  var zobs = params.zobs_to_h;
  if (!_num(zobs) || zobs < 0 || zobs > 1) {
    throw new Error('PRiSM verticalPulse: zobs_to_h must be in [0, 1]');
  }
}

function _verticalPulseStotal(params) {
  return (params.S_perf || 0) + _partialPen_pseudoskin(params);
}

/**
 * Vertical pulse-test — partial-penetration source observed at a separated
 * vertical point.  Green's-function shortcut, see header.
 */
function PRiSM_model_verticalPulse(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'KvKh', 'hp_to_h', 'zw_to_h', 'zobs_to_h']);
  _checkVerticalPulse(params);
  return _evalWbsSkin(function (s) { return _pdLap_verticalPulse(s, params); },
                      td, params.Cd, _verticalPulseStotal(params), false);
}

function PRiSM_model_verticalPulse_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'KvKh', 'hp_to_h', 'zw_to_h', 'zobs_to_h']);
  _checkVerticalPulse(params);
  return _evalWbsSkin(function (s) { return _pdLap_verticalPulse(s, params); },
                      td, params.Cd, _verticalPulseStotal(params), true);
}


// =============================================================================
// REGISTRY — merge into window.PRiSM_MODELS
// =============================================================================
//
// Metadata used by the physical-model wrapper (all optional):
//   refLength     'rw' — dimensionless time/distances referenced to rw
//   timeInput     'days' for the decline models (t in days, Di in 1/day)
//   defaultFrozen keys frozen by default (S_global is collinear with S_perf)
//   paramSpec[i].scale 'log' for positive, multi-decade parameters
//   pseudoSkin(params, geom) → geometric skin folded into the total skin
// =============================================================================

var REGISTRY_ADDITIONS = {

  arps: {
    pd: PRiSM_model_arps,
    pdPrime: PRiSM_model_arps_pd_prime,
    eur: PRiSM_eur_arps,
    defaults: { qi: 1000, Di: 0.05, b: 0.5 },
    paramSpec: [
      { key: 'qi', label: 'Initial rate qi',          unit: 'rate',  min: 0,    max: 1e9, default: 1000, scale: 'log' },
      { key: 'Di', label: 'Initial decline Di',       unit: '1/day', min: 0,    max: 5,   default: 0.05, scale: 'log' },
      { key: 'b',  label: 'Decline exponent b',       unit: '-',     min: 0,    max: 2,   default: 0.5  }
    ],
    optionalParams: [
      { key: 'Dmin', label: 'Terminal decline Dmin (modified hyperbolic; 0 = off)', unit: '1/day', min: 0, max: 1, default: 0 }
    ],
    timeInput: 'days',
    reference: 'Arps, J.J., Trans. AIME 160 (1945) 228-247; modified hyperbolic: Robertson (1988)',
    category: 'decline',
    description: 'Arps decline (exponential / hyperbolic / harmonic via b-factor): q(t) = qi · (1 + b·Di·t)^(-1/b), t in days. Optional Dmin switches to exponential terminal decline.',
    kind: 'rate'
  },

  duong: {
    pd: PRiSM_model_duong,
    pdPrime: PRiSM_model_duong_pd_prime,
    eur: PRiSM_eur_duong,
    defaults: { q1: 1000, a: 1.0, m: 1.2 },
    paramSpec: [
      { key: 'q1', label: 'Rate at t = 1 day q1',   unit: 'rate', min: 0,   max: 1e9, default: 1000, scale: 'log' },
      { key: 'a',  label: 'Intercept a',             unit: '-',    min: 0,   max: 10,  default: 1.0  },
      { key: 'm',  label: 'Slope m',                 unit: '-',    min: 0.5, max: 2,   default: 1.2  }
    ],
    timeInput: 'days',
    reference: 'Duong, A.N., SPE 137748 (Oct 2011)',
    category: 'decline',
    description: 'Duong shale decline: q(t) = q1·t^(-m)·exp(a/(1-m)·(t^(1-m)-1)), t in days. Fracture-dominated unconventionals.',
    kind: 'rate'
  },

  sepd: {
    pd: PRiSM_model_sepd,
    pdPrime: PRiSM_model_sepd_pd_prime,
    eur: PRiSM_eur_sepd,
    defaults: { qi: 1000, tau: 100, n: 0.5 },
    paramSpec: [
      { key: 'qi',  label: 'Initial rate qi',         unit: 'rate', min: 0,    max: 1e9, default: 1000, scale: 'log' },
      { key: 'tau', label: 'Characteristic time τ',   unit: 'day',  min: 0.1,  max: 1e6, default: 100,  scale: 'log' },
      { key: 'n',   label: 'Stretching exponent n',   unit: '-',    min: 0.05, max: 1,   default: 0.5  }
    ],
    timeInput: 'days',
    reference: 'Valko, P.P., SPE 119369 (2009)',
    category: 'decline',
    description: 'Stretched-exponential production decline (SEPD): q(t) = qi · exp(-(t/τ)^n), t in days. Shale wells.',
    kind: 'rate'
  },

  fetkovich: {
    pd: PRiSM_model_fetkovich,
    pdPrime: PRiSM_model_fetkovich_pd_prime,
    eur: PRiSM_eur_fetkovich,
    defaults: { qi: 1000, Di: 0.02, b: 0.5, reD: 1000 },
    paramSpec: [
      { key: 'qi',  label: 'Arps qi (depletion stem)',        unit: 'rate',  min: 0,   max: 1e9, default: 1000, scale: 'log' },
      { key: 'Di',  label: 'Arps Di (depletion stem)',        unit: '1/day', min: 0,   max: 5,   default: 0.02, scale: 'log' },
      { key: 'b',   label: 'Arps b (depletion stem)',         unit: '-',     min: 0,   max: 2,   default: 0.5  },
      { key: 'reD', label: 'Drainage ratio re/rwa (apparent wellbore radius, includes skin)', unit: '-', min: 5, max: 1e5, default: 1000, scale: 'log' }
    ],
    timeInput: 'days',
    reference: 'Fetkovich, M.J., JPT June 1980 pp 1065-1077; van Everdingen & Hurst (1949)',
    category: 'decline',
    description: 'Fetkovich type curve: rigorous closed-circle constant-pwf transient stems (re/rwa) joined to Arps depletion stems (qi, Di, b) at tDd 0.1–0.3. q(t) = qi·qDd(Di·t), t in days.',
    kind: 'rate'
  },

  doublePorosity: {
    pd: PRiSM_model_doublePorosity,
    pdPrime: PRiSM_model_doublePorosity_pd_prime,
    defaults: { Cd: 100, S: 0, omega: 0.1, lambda: 1e-5, interporosityMode: 'pss' },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',  unit: '-', min: 0,     max: 1e10,  default: 100, scale: 'log' },
      { key: 'S',      label: 'Skin S',               unit: '-', min: -7,    max: 50,    default: 0     },
      { key: 'omega',  label: 'Storativity ratio ω',  unit: '-', min: 0.001, max: 0.999, default: 0.1   },
      { key: 'lambda', label: 'Interporosity coef λ', unit: '-', min: 1e-9,  max: 1e-2,  default: 1e-5, scale: 'log' },
      { key: 'interporosityMode', label: 'Interporosity flow', unit: '',
        options: ['pss', '1dt', '3dt'], default: 'pss' }
    ],
    refLength: 'rw',
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
      { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-',  min: 0,     max: 1e10, default: 100, scale: 'log' },
      { key: 'S_perf',   label: 'Perforation skin',    unit: '-',  min: -7,    max: 50,   default: 0   },
      { key: 'S_global', label: 'Global skin',         unit: '-',  min: -7,    max: 50,   default: 0   },
      { key: 'KvKh',     label: 'Anisotropy Kv/Kh',    unit: '-',  min: 0.001, max: 100,  default: 0.1, scale: 'log' },
      { key: 'hp_to_h',  label: 'Perforated fraction hp/h', unit: '-', min: 0.05, max: 1, default: 0.3 },
      { key: 'zw_to_h',  label: 'Perf centre zw/h',    unit: '-',  min: 0,     max: 1,    default: 0.5 },
      { key: 'h_eff',    label: 'Effective thickness h_eff/h', unit: '-', min: 0.1, max: 5, default: 1.0 }
    ],
    refLength: 'rw',
    defaultFrozen: ['S_global'],
    pseudoSkin: function (params, geom) { return _partialPen_pseudoskin(params || {}, geom); },
    reference: 'Brons-Marting (1961) pseudo-skin; Gringarten-Ramey SPEJ Aug 1974; Earlougher Monograph 5 §2.6',
    category: 'well-type',
    description: 'Partial-penetration vertical well: perforated interval hp in thickness h. Early radial over hp, spherical transition, late radial over h. Geometric skin = Brons-Marting(hp/h, (h/rw)√(kh/kv)).',
    kind: 'pressure'
  },

  verticalPulse: {
    pd: PRiSM_model_verticalPulse,
    pdPrime: PRiSM_model_verticalPulse_pd_prime,
    defaults: { Cd: 10, S_perf: 0, KvKh: 0.1, hp_to_h: 0.3, zw_to_h: 0.5, zobs_to_h: 0.8, h_eff: 1.0 },
    paramSpec: [
      { key: 'Cd',         label: 'Obs-well storage Cd',  unit: '-',  min: 0,     max: 1e10, default: 10, scale: 'log' },
      { key: 'S_perf',     label: 'Perforation skin',     unit: '-',  min: -7,    max: 50,   default: 0   },
      { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-',  min: 0.001, max: 100,  default: 0.1, scale: 'log' },
      { key: 'hp_to_h',    label: 'Perforated fraction hp/h', unit: '-', min: 0.05, max: 1, default: 0.3 },
      { key: 'zw_to_h',    label: 'Perf centre zw/h',     unit: '-',  min: 0,     max: 1,    default: 0.5 },
      { key: 'zobs_to_h',  label: 'Obs point zobs/h',     unit: '-',  min: 0,     max: 1,    default: 0.8 },
      { key: 'h_eff',      label: 'Effective thickness h_eff/h', unit: '-', min: 0.1, max: 5, default: 1.0 }
    ],
    refLength: 'rw',
    pseudoSkin: function (params, geom) { return _partialPen_pseudoskin(params || {}, geom); },
    reference: 'Gringarten-Ramey SPE 3818 / SPEJ Oct 1973 (Green\'s functions); Streltsova (1988); Brons-Marting (1961)',
    category: 'well-type',
    description: 'Vertical pulse-test: partial-penetration source observed at a separate vertical point. Time-lag + amplitude attenuation give Kv/Kh. Green\'s-function shortcut.',
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
  g.PRiSM_fetkovich_typecurve         = PRiSM_fetkovich_typecurve;
  g.PRiSM_fetkovich_qD                = PRiSM_fetkovich_qD;
  g.PRiSM_arps_q                      = PRiSM_arps_q;
  g.PRiSM_arps_Np                     = PRiSM_arps_Np;
  g.PRiSM_arps_D                      = PRiSM_arps_D;
  g.PRiSM_arps_tSwitch                = PRiSM_arps_tSwitch;
  g.PRiSM_arps_timeToRate             = PRiSM_arps_timeToRate;
  g.PRiSM_arps_eurToRate              = PRiSM_arps_eurToRate;
  g.PRiSM_arps_De                     = PRiSM_arps_De;
  g.PRiSM_DECLINE = g.PRiSM_DECLINE || {};
  g.PRiSM_DECLINE.arpsQ          = PRiSM_arps_q;
  g.PRiSM_DECLINE.arpsNp         = PRiSM_arps_Np;
  g.PRiSM_DECLINE.arpsD          = PRiSM_arps_D;
  g.PRiSM_DECLINE.arpsTSwitch    = PRiSM_arps_tSwitch;
  g.PRiSM_DECLINE.arpsTimeToRate = PRiSM_arps_timeToRate;
  g.PRiSM_DECLINE.arpsEurToRate  = PRiSM_arps_eurToRate;
  g.PRiSM_DECLINE.arpsDe         = PRiSM_arps_De;
  g.PRiSM_DECLINE.eurArps        = PRiSM_eur_arps;
  g.PRiSM_DECLINE.eurDuong       = PRiSM_eur_duong;
  g.PRiSM_DECLINE.eurSepd        = PRiSM_eur_sepd;
  g.PRiSM_DECLINE.eurFetkovich   = PRiSM_eur_fetkovich;
  g.PRiSM_DECLINE.fetkovichTypeCurve = PRiSM_fetkovich_typecurve;
  g.PRiSM_DECLINE.fetkovichQD    = PRiSM_fetkovich_qD;
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
// Standalone check (stripped at concat):
//   - every evaluator returns finite values at defaults
//   - Arps small-b branch, t = 0, closed-form EUR, Dmin continuity
//   - Fetkovich b = 0 stem, Di/b sensitivity
//   - double-porosity negative skin monotone
//   - Brons-Marting reference values
// =============================================================================

(function _selfTest() {
  var report = [], allOk = true;
  function check(name, ok, detail) {
    if (!ok) { allOk = false; report.push('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
  }
  try {
    Object.keys(REGISTRY_ADDITIONS).forEach(function (key) {
      var e = REGISTRY_ADDITIONS[key];
      var t = (e.kind === 'rate' && key !== 'duong') ? [0, 1, 10, 100] : [1, 10, 100];
      var v = e.pd(t, e.defaults), d = e.pdPrime(t, e.defaults);
      check(key + ' finite', v.every(_num) && d.every(_num), JSON.stringify(v));
    });
    var A = { qi: 1000, Di: 0.01, b: 1e-17 };
    check('arps small b', Math.abs(PRiSM_model_arps([100], A)[0] - 367.879441) < 1e-3);
    check('arps t=0', PRiSM_model_arps([0], { qi: 1000, Di: 0.01, b: 0.5 })[0] === 1000);
    check('arps EUR', Math.abs(PRiSM_eur_arps({ qi: 1000, Di: 0.01, b: 0.5 }, 3650) - 189610.39) < 1);
    var M = { qi: 1000, Di: 0.01, b: 0.8, Dmin: 0.0005 }, ts = PRiSM_arps_tSwitch(M);
    check('arps Dmin C0', Math.abs(PRiSM_arps_q(ts * (1 - 1e-9), M) - PRiSM_arps_q(ts * (1 + 1e-9), M)) < 1e-6);
    check('fetkovich b=0 stem', Math.abs(PRiSM_fetkovich_typecurve(1000, 0, [1])[0] - Math.exp(-1)) < 1e-12);
    var f1 = PRiSM_model_fetkovich([100], { qi: 1000, Di: 0.02, b: 0.5, reD: 1000 })[0];
    var f2 = PRiSM_model_fetkovich([100], { qi: 1000, Di: 0.04, b: 0.5, reD: 1000 })[0];
    check('fetkovich Di sensitivity', Math.abs(f1 - f2) > 1, f1 + ' vs ' + f2);
    var dp = PRiSM_model_doublePorosity([1, 10, 100, 1e3, 1e4, 1e5],
      { Cd: 100, S: -3, omega: 0.1, lambda: 1e-5, interporosityMode: 'pss' });
    var mono = true;
    for (var i = 1; i < dp.length; i++) if (!(dp[i] >= dp[i - 1]) || !(dp[i] > 0)) mono = false;
    check('doublePorosity S=-3 monotone', mono, JSON.stringify(dp));
    check('Brons-Marting 0.2', Math.abs(_bronsMartingLocal(0.2, 98.87) - 10.79) < 0.02);
    check('Brons-Marting 0.5', Math.abs(_bronsMartingLocal(0.5, 98.87) - 3.05) < 0.02);
  } catch (e) {
    allOk = false; report.push('THREW ' + (e && e.message ? e.message : e));
  }
  if (typeof console !== 'undefined' && console.log) {
    if (allOk) console.log('PRiSM 06: self-test passed (7 evaluators + decline helpers)');
    else { console.log('PRiSM 06: SELF-TEST FAILED'); report.forEach(function (r) { console.log('  ' + r); }); }
  }
})();

})();  // end IIFE
