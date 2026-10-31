// =============================================================================
// WTS — 49-calc-buildup-trend.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// Build-up Surveillance — trend and alerts: window.WTS_buildup.trend (WP3).
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §3.8 (interface), §4.7 (M§A22–M§A28),
// §5.1 (used set), §3.0 (rules common to every interface).
//
// PUBLIC API (window.WTS_buildup.trend; pure — no DOM, storage, timers or events)
//   compute(tests, ctx) → Trend            tests = [TrendTest] (built by run from TestEntry; trend never
//                                          reads raw data); ctx = {well, completion, depth, settings,
//                                          days, workovers, fluid, firstTest_ms, mode, phaseBasis, start,
//                                          historyEstimated, baseline}. Optional extra ctx keys:
//                                          windowLevelInconsistent:[id] (stage 3), interventions:[id|date].
//                                          Optional extra TrendTest keys: sSens (= result.sErr.sSens),
//                                          windowLevelInconsistent (bool).
//   baseline(series, n, opts) → baseline   the single baseline implementation (run calls it in stage 2 over
//                                          the pass-1 tests; compute calls it again over the final used set).
//                                          series items: {id, tDays|t_ms, date, S, Serr, k, kh, kHeld,
//                                          excluded, conf:{ks}}; opts = {workovers:['YYYY-MM-DD']} (or the
//                                          array itself). Returns the Trend.baseline object plus n, seg (the
//                                          current segment), from (its start date) and k (median free k of the
//                                          baseline tests), cvK, kh — k, cvK and kh come from the latest segment
//                                          that holds tests (a workover does not change k), the rest from the
//                                          current segment (S, sigma null and tests [] when it holds none).
//   theilSen(t, y)  → {slope, intercept, lo, hi, n, nPairs}   (Sen 95 % CI, Gilbert 1987)
//   mannKendall(y)  → {S, varS, z, p, n, tau}                 (y in time order; ties corrected)
//   hinge(t, y, w)  → {model, shape:'ramp'|'step'|null, tau, interval, a, b, jump, wssr, bic, n, indicative}
//   cusum(z, k, h)  → {alarm, onset, c}                       (one-sided upper CUSUM; indices)
//   pFamily(tests)  → 'closed' | 'infinite'                    (T10 family: closed when the closed circle is
//                                                              chosen on at least half of the used tests;
//                                                              run may call it before stage 4 to pick p_ext)
//   sSensOf(sens)   → S_sens: RSS over inputs of the larger ±ΔS (Appendix A.2, typical ranges)
//   DEFAULTS        frozen thresholds (§4.10)
//
// CROSS-FILE CALLS (looked up at call time, never captured at load):
//   PRiSM_skinCheck.mechanicalSkin / rateSkin / products (54, §3.4). When the PRiSM skin module is absent,
//   compute() still returns a complete Trend: the mechanical and rate-dependent skins are unavailable and
//   the PSS products (T8, T13) are not computed (a limitation says so).
//
// CONVENTIONS
//   Field units (psia, hours, days for trend time, STB/d | Mscf/d | bbl/d, md, ft). tDays = days since the
//   first test. Every output number is finite or null; arrays are plain. Threshold decisions compare
//   values rounded to display precision (D27, DEFAULTS.round): skins to 0.01, slopes to 0.001 in their
//   reported per-30-day units, p-values and ratios to 0.001. compute() never throws: an internal failure
//   returns a complete empty Trend with ok:false, code 'TREND_ERROR'; no tests gives code 'NO_TESTS'.
//   Records whose id is not a non-empty string or a number are skipped.
//   Segments: alerts, onset, recent trend and forecast are evaluated in the CURRENT workover segment, the one
//   the latest workover date opens (segOf(max(latest test date, latest workover date)), i.e. segment
//   wo.length): an entered workover date starts a new baseline and resets the alerts at once. While that
//   segment holds no used test, the baseline S and σ are null (provisional), both alerts are 'none' (low tests
//   have no baseline to compare with), onset, recent trend and forecast are empty, there is no stimulation
//   recommendation, the PI ratio and production-at-stake numbers are skipped (pi.X is kept) and a limitation
//   says alerts restart with the next test. series[].used.alert marks the current-segment tests on the alert
//   basis; used.trend marks every used test (the S(t) of T8/T13 and the plot run through all of them).
//   Alerts: excluded low tests are compared on the same basis as the used tests (the 'possible' status).
//   Onset: the hinge family has two shapes, a ramp (continuous hinge) and a step (a level shift at τ, then a
//   line), both reported as model 'hinge' with onset.shape; the CUSUM (κ 0.5, h 4) is reported alongside as the
//   confirmation (onset.cusum). Gas with D resolved: alerts, onset and trend use S′ − D·(q − q_ref).
//   Without an onset (model 'constant' or 'line'): the recent trend uses every current-segment test
//   (recent.from 'segment', else 'onset') and the cumulative production at stake is summed from the last
//   baseline test (pi.cumFrom 'baselineEnd', else 'onset'; pi.cumFromDays = its tDays), so the page can label
//   it "since the end of the baseline". The extra drawdown (T8) and J_pred (T13) use the well's B·μ (Bw·μw for
//   injectors), as §4.7 writes them. The pressure trend (T10) does not depend on the trend switch: it is not
//   assessable only with an estimated history or fewer than 3 tests, so closedWithoutDepletion (V18) is
//   reported in table mode and with the trend off too.
//   Extra output keys (allowed by §3.13): onset.shape; series[].Salert/SerrAlert/seg (the alert basis and the
//   segment, for the review's re-derivation); baseline.n/seg/from/k/cvK/kh; recent.from; kStability.median/n/
//   falling/followsRate; pi.FE/DR/cumFrom/cumFromDays; rateSkin.n/qRatio/expectedD (the module's central D)/
//   expectedDRange [lo, hi]/consistent; recommendations[].values; piCheck.rows[].nDays; corrected; family;
//   warnings; code/errors/bad on a failure.
// =============================================================================
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var BU = G.WTS_buildup = G.WTS_buildup || {};

  var DAY_MS = 86400000;
  var RANK = { low: 0, medium: 1, high: 2 };
  var Z975 = 1.959964;
  var SENS_COEF = { h: 1.1513, phi: 1.1513, ct: 1.1513, rw: 2.3026, B: -1.1513, q: -1.1513, mu: 0 };
  var SENS_DEFAULT = { h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 };

  var DEFAULTS = Object.freeze({
    baseN: 3, delta: 2, abs: 5, basevar: false, confirm: 'next', price: null, enabled: 'auto',
    baseMinTests: 3,               // fewer → provisional baseline
    minSpacingDays: 1,             // auto: trend off below this median test spacing
    cusumK: 0.5, cusumH: 4,        // CUSUM κ and h (M§A24)
    immediateMargin: 1,            // a high test exceeding the threshold by ≥ 1 confirms at once
    recentMinN: 3, recentSigN: 5,  // recent trend: n ≥ 3, indicative when n ≤ 4
    mkAlpha: 0.10,                 // Mann–Kendall p for forecast / depletion
    disagreeFrac: 0.5,             // Theil–Sen vs WLS slope
    horizonFactor: 2,              // forecast: nothing beyond 2× the post-onset span
    kStableMinPct: 5,              // CV_k ≤ max(5 %, allocation accuracy)
    kRateSpearman: 0.7,            // k follows the allocated rate (Appendix A.3, row 4)
    bubbleMargin: 100, gradTol: 0.2, spearmanMin: 0.7, spearmanN: 4,
    piLo: 0.8, piHi: 1.25,
    qRatioMin: 1.5, maxDays: 60, collinearCorr: 0.8, dSeMin: 2,
    agreeMin: 0.3,                 // model-free ΔS agreement: max(0.3, S_err)
    workoverDrop: 2,               // skin drop between consecutive used tests that suggests an intervention
    weightFloor: 0.05,             // S_err floor for 1/S_err² weights
    // D27 display precision for threshold decisions (slopes in their reported per-30-day units)
    round: Object.freeze({ dBic: 0.1, span: 0.01, slope: 0.001, ratio: 0.001, skin: 0.01 })
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Small helpers
  // ───────────────────────────────────────────────────────────────────────────
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function pos(v) { return fin(v) && v > 0; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function num(a, b) { return a - b; }
  function nn(v) { return fin(v) ? v : null; }
  function median(a) {
    var s = []; for (var i = 0; i < (a ? a.length : 0); i++) if (fin(a[i])) s.push(a[i]);
    if (!s.length) return null;
    s.sort(num);
    var n = s.length;
    return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  }
  function madAbout(a, m) {
    if (!fin(m)) return null;
    var d = []; for (var i = 0; i < a.length; i++) if (fin(a[i])) d.push(Math.abs(a[i] - m));
    return median(d);
  }
  function minOf(a) { var m = null; a.forEach(function (v) { if (fin(v) && (m === null || v < m)) m = v; }); return m; }
  function maxOf(a) { var m = null; a.forEach(function (v) { if (fin(v) && (m === null || v > m)) m = v; }); return m; }
  function hund(x) { return Math.round(x * 100); }                 // skin → integer hundredths (D27, round.skin 0.01)
  function r3(x) { return Math.round(x * 1000) / 1000; }           // ratios, p-values (D27, 0.001)
  // a per-day slope → integer thousandths of its reported per-30-day value (D27); NaN for a non-number
  function s30(b) { return fin(b) ? Math.round(30000 * b) : NaN; }   // round.slope 0.001
  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function dateOf(ms) { return (fin(ms) && Math.abs(ms) < 8.64e15) ? new Date(ms).toISOString().slice(0, 10) : null; }
  function ruleOf(fluid) { return fluid === 'gas' ? 'gas' : fluid === 'water_inj' ? 'inj' : 'oil'; }
  function volUnit(qUnit) { return qUnit === 'Mscf/d' ? 'Mscf' : qUnit === 'bbl/d' ? 'bbl' : 'STB'; }
  function fmtNum(x, dp) { return fin(x) ? x.toFixed(dp) : ''; }
  function evId(test, id) { return test + '·' + id; }

  // erfc (Chebyshev fit, fractional error < 1.2e-7) and the standard normal CDF.
  function erfc(x) {
    var z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  function normCdf(z) { return 0.5 * erfc(-z / Math.SQRT2); }

  // Weighted least squares y = a + b·x (b = 0 when !withSlope). Returns {a, b, wssr, ok}.
  function wls(x, y, w, withSlope) {
    var Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, i, n = y.length;
    for (i = 0; i < n; i++) { Sw += w[i]; Sx += w[i] * x[i]; Sy += w[i] * y[i]; Sxx += w[i] * x[i] * x[i]; Sxy += w[i] * x[i] * y[i]; }
    if (!(Sw > 0)) return { a: null, b: null, wssr: null, ok: false };
    var a, b = 0;
    if (withSlope) {
      var D = Sw * Sxx - Sx * Sx;
      if (!(D > 1e-12 * Math.max(1, Sw * Sxx))) return { a: null, b: null, wssr: null, ok: false };
      b = (Sw * Sxy - Sx * Sy) / D;
      a = (Sy - b * Sx) / Sw;
    } else a = Sy / Sw;
    var s = 0;
    for (i = 0; i < n; i++) { var r = y[i] - a - b * x[i]; s += w[i] * r * r; }
    return { a: a, b: b, wssr: s, ok: true };
  }

  // Pearson correlation; Spearman = Pearson on average ranks.
  function pearson(x, y) {
    var n = x.length; if (n < 2) return null;
    var mx = 0, my = 0, i; for (i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < n; i++) { var dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (!(sxx > 1e-300) || !(syy > 1e-300)) return null;
    return sxy / Math.sqrt(sxx * syy);
  }
  function ranks(a) {
    var idx = a.map(function (v, i) { return i; }).sort(function (i, j) { return a[i] - a[j]; });
    var r = new Array(a.length);
    for (var p = 0; p < idx.length;) {
      var q = p; while (q + 1 < idx.length && a[idx[q + 1]] === a[idx[p]]) q++;
      var avg = (p + q) / 2 + 1;
      for (var k = p; k <= q; k++) r[idx[k]] = avg;
      p = q + 1;
    }
    return r;
  }
  function spearman(x, y, nMin) {
    var X = [], Y = [];
    for (var i = 0; i < Math.min(x.length, y.length); i++) if (fin(x[i]) && fin(y[i])) { X.push(x[i]); Y.push(y[i]); }
    if (X.length < (nMin || 3)) return null;
    return pearson(ranks(X), ranks(Y));
  }

  // Piecewise-linear interpolation through knots [[x, y], …] (x ascending); constant outside.
  function lin(knots, x) {
    if (!knots.length) return null;
    if (x <= knots[0][0]) return knots[0][1];
    for (var i = 1; i < knots.length; i++) {
      if (x <= knots[i][0]) {
        var dx = knots[i][0] - knots[i - 1][0];
        return dx > 0 ? knots[i - 1][1] + (knots[i][1] - knots[i - 1][1]) * (x - knots[i - 1][0]) / dx : knots[i][1];
      }
    }
    return knots[knots.length - 1][1];
  }
  // Linear interpolation of y in log x (x ascending, > 0); null outside the range.
  function logInterp(xs, ys, x) {
    if (!Array.isArray(xs) || !Array.isArray(ys) || !(x > 0)) return null;
    for (var i = 1; i < Math.min(xs.length, ys.length); i++) {
      var a = xs[i - 1], b = xs[i];
      if (!(a > 0) || !(b > 0) || !fin(ys[i - 1]) || !fin(ys[i])) continue;
      if (x >= a && x <= b) return b > a ? ys[i - 1] + (ys[i] - ys[i - 1]) * Math.log(x / a) / Math.log(b / a) : ys[i];
    }
    return null;
  }

  // Replace NaN/±Infinity by null everywhere (§3.0); returns the count replaced.
  function scrub(o, depth) {
    var bad = 0;
    if (depth > 12 || !o || typeof o !== 'object') return 0;
    var keys = Array.isArray(o) ? o.map(function (v, i) { return i; }) : Object.keys(o);
    keys.forEach(function (k) {
      var v = o[k];
      if (typeof v === 'number' && !isFinite(v)) { o[k] = null; bad++; }
      else if (v && typeof v === 'object') bad += scrub(v, (depth || 0) + 1);
    });
    return bad;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Statistics helpers (exposed for tests)
  // ───────────────────────────────────────────────────────────────────────────
  function mkVar(y) {
    var n = y.length, v = n * (n - 1) * (2 * n + 5);
    var s = y.slice().sort(num);
    for (var p = 0; p < n;) {
      var q = p; while (q + 1 < n && s[q + 1] === s[p]) q++;
      var g = q - p + 1; if (g > 1) v -= g * (g - 1) * (2 * g + 5);
      p = q + 1;
    }
    return v / 18;
  }

  function mannKendall(y) {
    var v = []; for (var i = 0; i < (y ? y.length : 0); i++) if (fin(y[i])) v.push(y[i]);
    var n = v.length;
    if (n < 2) return { S: 0, varS: 0, z: null, p: null, n: n, tau: null };
    var S = 0;
    for (i = 0; i < n; i++) for (var j = i + 1; j < n; j++) S += v[j] > v[i] ? 1 : v[j] < v[i] ? -1 : 0;
    var varS = mkVar(v);
    var z = varS > 0 ? (S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0) : 0;
    var p = Math.min(1, Math.max(0, 2 * (1 - normCdf(Math.abs(z)))));
    return { S: S, varS: varS, z: z, p: p, n: n, tau: S / (n * (n - 1) / 2) };
  }

  // 1-based rank r of an ascending array, linearly interpolated, clamped to [1, N].
  function rankAt(s, r) {
    if (r <= 1) return s[0];
    if (r >= s.length) return s[s.length - 1];
    var i = Math.floor(r), f = r - i;
    return s[i - 1] + f * (s[i] - s[i - 1]);
  }

  function theilSen(t, y) {
    var pts = [], i, j;
    for (i = 0; i < Math.min(t ? t.length : 0, y ? y.length : 0); i++) if (fin(t[i]) && fin(y[i])) pts.push([t[i], y[i]]);
    var n = pts.length, sl = [];
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var dt = pts[j][0] - pts[i][0];
      if (dt !== 0) sl.push((pts[j][1] - pts[i][1]) / dt);
    }
    if (!sl.length) return { slope: null, intercept: null, lo: null, hi: null, n: n, nPairs: 0 };
    sl.sort(num);
    var b = median(sl);
    var a = median(pts.map(function (p) { return p[1] - b * p[0]; }));
    // Sen's confidence interval (Gilbert 1987): C = z·√Var(S); the lower and upper limits are the
    // M1-th and (M2 + 1)-th of the N ordered slopes, M1 = (N − C)/2, M2 = (N + C)/2.
    var C = Z975 * Math.sqrt(mkVar(pts.map(function (p) { return p[1]; }))), N = sl.length;
    return { slope: b, intercept: a, lo: rankAt(sl, (N - C) / 2), hi: rankAt(sl, (N + C) / 2 + 1), n: n, nPairs: N };
  }

  // Weighted least squares with a small design matrix (rows X[i] = [1, x1, x2 …]) by the normal equations.
  // Returns {beta, wssr, ok}.
  function wlsN(X, y, w) {
    var n = y.length, p = X.length ? X[0].length : 0, A = [], b = [], i, j, k;
    for (j = 0; j < p; j++) { A.push(new Array(p).fill(0)); b.push(0); }
    for (i = 0; i < n; i++) for (j = 0; j < p; j++) {
      b[j] += w[i] * X[i][j] * y[i];
      for (k = 0; k < p; k++) A[j][k] += w[i] * X[i][j] * X[i][k];
    }
    var scale = 0; for (j = 0; j < p; j++) scale = Math.max(scale, Math.abs(A[j][j]));
    for (j = 0; j < p; j++) {                                  // Gauss–Jordan with partial pivoting
      var piv = j; for (k = j + 1; k < p; k++) if (Math.abs(A[k][j]) > Math.abs(A[piv][j])) piv = k;
      if (!(Math.abs(A[piv][j]) > 1e-12 * Math.max(1, scale))) return { beta: null, wssr: null, ok: false };
      var tA = A[j]; A[j] = A[piv]; A[piv] = tA; var tb = b[j]; b[j] = b[piv]; b[piv] = tb;
      for (k = 0; k < p; k++) if (k !== j) {
        var f = A[k][j] / A[j][j];
        if (f !== 0) { for (var m = j; m < p; m++) A[k][m] -= f * A[j][m]; b[k] -= f * b[j]; }
      }
    }
    var beta = b.map(function (v, q) { return v / A[q][q]; }), s = 0;
    for (i = 0; i < n; i++) { var r = y[i]; for (j = 0; j < p; j++) r -= beta[j] * X[i][j]; s += w[i] * r * r; }
    return { beta: beta, wssr: s, ok: true };
  }

  // Hinge regression over τ on test dates and midpoints with ≥ 2 tests after τ, weights w (1/S_err²):
  //   ramp  y = a + b·max(0, t − τ)                       (the classic continuous hinge, 3 parameters)
  //   step  y = a + c·[t > τ] + b·max(0, t − τ)          (a level shift at τ, then a line; 4 parameters)
  // A continuous hinge alone cannot follow a step change with a plateau after it (it trades the jump for a
  // gentle slope and puts the onset far too early), and step paths are a quarter of the rising skin paths
  // (§5.2). Both shapes are reported as model 'hinge' (shape 'ramp' | 'step'). For a step, τ̂ is placed
  // midway between the two tests that bracket it (nothing in the data locates it more precisely).
  // Hinge (either shape) vs constant vs line by BIC = WSSR + p·ln n, rounded to 0.1 (D27), ties to the simpler
  // model; the profile interval is the contiguous range around τ̂ with ΔWSSR ≤ 1 (16 steps per test interval).
  function hinge(t, y, w) {
    var pts = [], i;
    for (i = 0; i < Math.min(t ? t.length : 0, y ? y.length : 0); i++) {
      var wi = w && fin(w[i]) && w[i] > 0 ? w[i] : (w ? null : 1);
      if (fin(t[i]) && fin(y[i]) && wi !== null) pts.push([t[i], y[i], wi]);
    }
    pts.sort(function (p, q) { return p[0] - q[0]; });
    var n = pts.length;
    // the fits use weights normalised by their maximum (the estimates do not change; the pivot, determinant and tie
    // tests stay meaningful for any S_err); WSSRs are scaled back to the caller's weights for the BIC and the output,
    // and the ΔWSSR ≤ 1 profile limit is 1/wMax in normalised units
    var wMax = 0; pts.forEach(function (p) { if (p[2] > wMax) wMax = p[2]; });
    var T = pts.map(function (p) { return p[0]; }), Y = pts.map(function (p) { return p[1]; }), W = pts.map(function (p) { return p[2] / wMax; });
    var back = function (f) { return f.ok ? { beta: f.beta, wssr: f.wssr * wMax, ok: true } : f; };
    var out = { model: 'constant', shape: null, tau: null, interval: null, a: null, b: 0, jump: null,
                wssr: { constant: null, line: null, hinge: null, step: null }, bic: { constant: null, line: null, hinge: null, step: null },
                n: n, indicative: n < 6 };
    if (!n || !(wMax > 0) || !isFinite(wMax)) return out;
    var lnN = Math.log(n);
    var c = back(wlsN(T.map(function () { return [1]; }), Y, W));
    if (!c.ok || !fin(c.wssr)) return out;
    out.a = c.beta[0]; out.wssr.constant = c.wssr;
    var bic = { constant: c.wssr + lnN, line: null, hinge: null, step: null };
    var line = n >= 3 ? back(wlsN(T.map(function (x) { return [1, x]; }), Y, W)) : null;
    if (line && line.ok) { out.wssr.line = line.wssr; bic.line = line.wssr + 2 * lnN; }
    // fit(shape, τ) → {beta, wssr, ok}: the ramp by the closed-form two-parameter WLS, the step by wlsN
    var fitAt = function (shape, tau) {
      if (shape === 'hinge') {                                   // (normalised WSSR)
        var f = wls(T.map(function (x) { return Math.max(0, x - tau); }), Y, W, true);
        return f.ok ? { beta: [f.a, f.b], wssr: f.wssr, ok: true } : f;
      }
      return wlsN(T.map(function (x) { return [1, x > tau ? 1 : 0, Math.max(0, x - tau)]; }), Y, W);
    };
    var NP = { hinge: 3, step: 4 }, NMIN = { hinge: 4, step: 5 };
    var valid = function (tau) {
      var after = 0, before = 0;
      for (var k = 0; k < n; k++) { if (T[k] > tau) after++; else before++; }
      return after >= 2 && before >= 1;
    };
    var cand = [];
    for (i = 0; i <= n - 3; i++) {
      cand.push({ tau: T[i], mid: false });
      if (T[i + 1] > T[i]) cand.push({ tau: 0.5 * (T[i] + T[i + 1]), mid: true });
    }
    cand.sort(function (p, q) { return p.tau - q.tau; });
    var best = {};
    ['hinge', 'step'].forEach(function (shape) {
      if (n < NMIN[shape]) return;
      var b0 = null;
      cand.forEach(function (cd) {
        if (!valid(cd.tau)) return;
        var f = fitAt(shape, cd.tau);
        if (!f.ok) return;
        var tie = b0 !== null && Math.abs(f.wssr - b0.wssr) <= 1e-9 * Math.max(1, b0.wssr);
        if (b0 === null || (!tie && f.wssr < b0.wssr) || (tie && shape === 'step' && cd.mid && !b0.mid)) b0 = { tau: cd.tau, mid: cd.mid, beta: f.beta, wssr: f.wssr };
      });
      if (b0) { best[shape] = b0; out.wssr[shape] = b0.wssr * wMax; bic[shape] = b0.wssr * wMax + NP[shape] * lnN; }
    });
    var r1 = function (v) { return Math.round(v * 10); };
    var model = 'constant', bb = r1(bic.constant);
    ['line', 'hinge', 'step'].forEach(function (m) { if (bic[m] != null && r1(bic[m]) < bb) { model = m; bb = r1(bic[m]); } });
    out.bic = { constant: bic.constant, line: nn(bic.line), hinge: nn(bic.hinge), step: nn(bic.step) };
    if (model === 'constant') return out;
    if (model === 'line') { out.model = 'line'; out.a = line.beta[0]; out.b = line.beta[1]; return out; }
    var bs = best[model];
    out.model = 'hinge'; out.shape = model === 'step' ? 'step' : 'ramp'; out.tau = bs.tau; out.a = bs.beta[0];
    out.b = model === 'step' ? bs.beta[2] : bs.beta[1]; out.jump = model === 'step' ? bs.beta[1] : 0;
    // profile interval on a refined grid (16 steps per test interval), walked outward from τ̂ while ΔWSSR ≤ 1
    var grid = [];
    for (i = 0; i <= n - 3; i++) for (var s = 0; s < 16; s++) grid.push(T[i] + (T[i + 1] - T[i]) * s / 16);
    grid.push(bs.tau);
    grid = grid.filter(valid).sort(num);
    var lim = bs.wssr + 1 / wMax, k0 = grid.indexOf(bs.tau), lo = k0, hi = k0;
    var okAt = function (k) { var f = fitAt(model, grid[k]); return f.ok && f.wssr <= lim; };
    while (lo - 1 >= 0 && okAt(lo - 1)) lo--;
    while (hi + 1 < grid.length && okAt(hi + 1)) hi++;
    out.interval = [grid[lo], grid[hi]];
    return out;
  }

  // One-sided upper CUSUM: C_j = max(0, C_{j−1} + z_j − κ); alarm at the first C > h; onset = the last
  // index with C = 0 before the alarm (the change happened after it), or null when C never was 0.
  function cusum(z, k, h) {
    k = fin(k) ? k : DEFAULTS.cusumK; h = fin(h) ? h : DEFAULTS.cusumH;
    var c = 0, path = [], alarm = null, onset = null, lastZero = -1;
    for (var i = 0; i < (z ? z.length : 0); i++) {
      if (fin(z[i])) c = Math.max(0, c + z[i] - k);
      path.push(c);
      if (alarm === null) {
        if (c === 0) lastZero = i;
        if (c > h) { alarm = i; onset = lastZero >= 0 ? lastZero : null; }
      }
    }
    return { alarm: alarm, onset: onset, c: path };
  }

  function sSensOf(sens) {
    var s = isObj(sens) ? sens : SENS_DEFAULT, s2 = 0;
    Object.keys(SENS_COEF).forEach(function (key) {
      var r = s[key], c = SENS_COEF[key];
      if (!fin(r) || r <= 0 || c === 0) return;
      var a = Math.abs(c * Math.log10(1 + r)), b = r < 1 ? Math.abs(c * Math.log10(1 - r)) : 0;
      var m = Math.max(a, b); s2 += m * m;
    });
    return Math.sqrt(s2);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Baseline (M§A22) — the single implementation (stage 2 and stage 4)
  // ───────────────────────────────────────────────────────────────────────────
  function sortedWorkovers(w) {
    var a = Array.isArray(w) ? w : (isObj(w) && Array.isArray(w.workovers) ? w.workovers : []);
    var out = []; a.forEach(function (d) { if (validDate(d) && out.indexOf(d) === -1) out.push(d); });
    return out.sort();
  }
  function segOf(date, wo) {
    var s = 0; if (!date) return 0;
    for (var i = 0; i < wo.length; i++) if (wo[i] <= date) s = i + 1;
    return s;
  }
  function itemTime(it) { return fin(it.tDays) ? it.tDays : fin(it.t_ms) ? it.t_ms / DAY_MS : null; }
  function itemDate(it) { return validDate(it.date) ? it.date : dateOf(it.t_ms); }
  function itemLabel(it) { var c = isObj(it.conf) ? it.conf.ks : null; return RANK.hasOwnProperty(c) ? c : 'medium'; }

  function baseline(series, n, opts) {
    n = Math.max(1, Math.floor(fin(n) ? n : DEFAULTS.baseN));
    var wo = sortedWorkovers(opts);
    var items = (Array.isArray(series) ? series : []).map(function (it, i) { return { it: it, i: i }; }).filter(function (x) {
      var it = x.it;
      return isObj(it) && it.excluded !== true && fin(it.S) && fin(itemTime(it)) && itemLabel(it) !== 'low';
    }).sort(function (a, b) { return (itemTime(a.it) - itemTime(b.it)) || (a.i - b.i); }).map(function (x) { return x.it; });
    var bySeg = {};
    items.forEach(function (it) { var s = segOf(itemDate(it), wo); (bySeg[s] = bySeg[s] || []).push(it); });
    var segs = Object.keys(bySeg).map(Number).sort(num).map(function (s) {
      var list = bySeg[s], base = list.slice(0, n);
      var S = base.map(function (it) { return it.S; }), E = base.map(function (it) { return fin(it.Serr) ? it.Serr : 0; });
      var Sb = median(S), m = madAbout(S, Sb);
      var free = base.filter(function (it) { return it.kHeld !== true && pos(it.k); });
      var kArr = free.map(function (it) { return it.k; }), kMed = median(kArr);
      var khArr = free.map(function (it) { return pos(it.kh) ? it.kh : null; }).filter(fin);
      return {
        seg: s, from: s === 0 ? itemDate(list[0]) : wo[s - 1], S: Sb,
        sigma: Math.max(median(E), 1.4826 * m / Math.sqrt(base.length)),
        tests: base.map(function (it) { return String(it.id); }),
        unstable: hund(maxOf(S) - minOf(S)) > hund(2 * maxOf(E)),                 // range > 2·max S_err (D27)
        provisional: base.length < DEFAULTS.baseMinTests || base.some(function (it) { return it.kHeld === true; }),
        k: kMed, cvK: (kMed && kArr.length) ? 1.4826 * madAbout(kArr, kMed) / kMed : null, kh: khArr.length ? median(khArr) : null,
        n: base.length
      };
    });
    // The current segment is the one the latest workover opens: segOf(max(latest test date, latest workover date)),
    // which is wo.length whenever a workover date is entered (0 without one). It may hold no test yet.
    var curSeg = wo.length, cur = null;
    segs.forEach(function (g) { if (g.seg === curSeg) cur = g; });
    var kSrc = cur || (segs.length ? segs[segs.length - 1] : null);        // a workover does not change k
    return {
      S: cur ? cur.S : null, sigma: cur ? cur.sigma : null, tests: cur ? cur.tests.slice() : [],
      unstable: cur ? cur.unstable : false, provisional: cur ? cur.provisional : true,
      segments: segs.map(function (g) {
        return { from: g.from, S: g.S, tests: g.tests.slice(), seg: g.seg, sigma: g.sigma, unstable: g.unstable, provisional: g.provisional };
      }),
      ev: ['T1'],
      k: kSrc ? kSrc.k : null, cvK: kSrc ? kSrc.cvK : null, kh: kSrc ? kSrc.kh : null, n: cur ? cur.n : 0, seg: curSeg,
      from: cur ? cur.from : (curSeg > 0 ? wo[curSeg - 1] : null)
    };
  }

  // T10 family: closed when the closed circle is the chosen model on at least half of the used tests.
  function pFamily(tests) {
    var used = (Array.isArray(tests) ? tests : []).filter(function (t) { return isObj(t) && t.excluded !== true && itemLabel(t) !== 'low'; });
    if (!used.length) return 'infinite';
    var nc = used.filter(function (t) { return t.chosen === 'closedCircle'; }).length;
    return 2 * nc >= used.length ? 'closed' : 'infinite';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRiSM skin module (54) — call-time lookups
  // ───────────────────────────────────────────────────────────────────────────
  function skinFn(name) {
    var sc = G.PRiSM_skinCheck;
    return (sc && typeof sc[name] === 'function') ? function () { return sc[name].apply(sc, arguments); } : null;
  }
  // ev: the evidence id of the item the call feeds (T14 mechanical skin, T15 rate skin, T8 products)
  function safeCall(fn, args, warnings, code, ev) {
    try { return fn.apply(null, args); } catch (e) {
      if (!warnings.some(function (w) { return w.code === code; })) {
        warnings.push({ code: code, level: 'warn', text: 'The skin module failed on a calculation; the items it affects are left out.', ev: [ev || 'T14'] });
      }
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // compute(tests, ctx) → Trend
  // ───────────────────────────────────────────────────────────────────────────
  function trendSettings(settings) {
    var s = isObj(settings) && isObj(settings.trend) ? settings.trend : {};
    return {
      baseN: fin(s.baseN) && s.baseN >= 1 ? Math.floor(s.baseN) : DEFAULTS.baseN,
      delta: fin(s.delta) ? s.delta : DEFAULTS.delta,
      abs: fin(s.abs) ? s.abs : DEFAULTS.abs,
      basevar: s.basevar === true ? true : s.basevar === false ? false : null,
      confirm: s.confirm === 'immediate' ? 'immediate' : 'next',
      price: fin(s.price) ? s.price : null,
      enabled: s.enabled === 'on' || s.enabled === 'off' ? s.enabled : 'auto'
    };
  }
  function calDeltaForm() {
    var cal = G.PRiSM_autoInterpCal;
    return (cal && cal.calibrated === true && cal.thresholds && cal.thresholds.deltaForm === 'basevar') ? 'basevar' : 'plain';
  }

  function goodId(id) { return (typeof id === 'string' && id.length > 0) || fin(id); }
  function prepRecords(tests, ctx, wo) {
    var arr = Array.isArray(tests) ? tests.filter(function (t) { return isObj(t) && goodId(t.id); }) : [];
    var first = fin(ctx.firstTest_ms) ? ctx.firstTest_ms : null;
    if (first === null) arr.forEach(function (t) { if (fin(t.t_ms) && (first === null || t.t_ms - (fin(t.tDays) ? t.tDays * DAY_MS : 0) < first)) first = t.t_ms - (fin(t.tDays) ? t.tDays * DAY_MS : 0); });
    var recs = arr.map(function (t, i) {
      var td = fin(t.tDays) ? t.tDays : (fin(t.t_ms) && first !== null ? (t.t_ms - first) / DAY_MS : null);
      var date = validDate(t.date) ? t.date : dateOf(t.t_ms);
      var ks = itemLabel(t);
      var ok = fin(t.S) && fin(t.Serr) && t.Serr >= 0 && fin(td);
      var excluded = t.excluded === true;
      return {
        i: i, t: t, id: String(t.id), td: td, date: date, S: t.S, E: t.Serr, ks: ks, kHeld: t.kHeld === true, excluded: excluded, ok: ok,
        used: ok && !excluded && RANK[ks] >= 1, low: ok && !excluded && ks === 'low', seg: segOf(date, wo),
        q: pos(t.Dq) ? t.Dq : null, k: pos(t.k) ? t.k : null,
        Sap: fin(t.gasSprime) ? t.gasSprime : t.S          // gas: apparent skin S′ (includes D·q)
      };
    });
    recs.sort(function (a, b) {
      if (fin(a.td) && fin(b.td)) return (a.td - b.td) || (a.i - b.i);
      return fin(a.td) ? -1 : fin(b.td) ? 1 : a.i - b.i;
    });
    return { recs: recs, first_ms: first };
  }

  // Alert run over the used list: raised at the first test with margin > 0 (integer hundredths), confirmed at
  // the next used test that also meets it, or at once (high label and margin ≥ 1, or confirm 'immediate').
  function alertRun(list, marginOf, immediateAll) {
    var raised = null, conf = null, i;
    for (i = 0; i < list.length; i++) { var m = marginOf(list[i]); if (m !== null && m > 0) { raised = i; break; } }
    if (raised !== null) {
      var mr = marginOf(list[raised]);
      if (immediateAll || (list[raised].ks === 'high' && mr >= hund(DEFAULTS.immediateMargin))) conf = raised;
      else for (i = raised + 1; i < list.length; i++) { var mj = marginOf(list[i]); if (mj !== null && mj > 0) { conf = i; break; } }
    }
    return {
      raised: raised, conf: conf, raisedAt: raised !== null ? list[raised].id : null, confirmedAt: conf !== null ? list[conf].id : null,
      kHeldOnly: raised !== null && list[raised].kHeld && (conf === null || list[conf].kHeld)
    };
  }
  function alertStatus(run, lowList, marginOf) {
    if (run.confirmedAt) return 'confirmed';
    if (run.raisedAt) return 'provisional';
    return lowList.some(function (r) { var m = marginOf(r); return m !== null && m > 0; }) ? 'possible' : 'none';
  }

  // Baseline, alerts, onset, recent trend and forecast for one skin basis.
  //   val(r) → {S, E} (delta and onset basis); absVal(r) → {S, E} (absolute basis) or null
  function seriesPass(P) {
    var recs = P.recs, ts = P.ts, val = P.val, absVal = P.absVal;
    var items = recs.map(function (r) {
      var v = r.used ? val(r) : null;
      return { id: r.id, tDays: r.td, date: r.date, S: v ? v.S : null, Serr: v ? v.E : null, k: r.k, kh: r.t.kh, kHeld: r.kHeld,
               excluded: !r.used, conf: { ks: r.ks } };
    });
    var B = baseline(items, ts.baseN, P.wo);
    var cur = recs.filter(function (r) { return r.used && r.seg === B.seg && val(r); });
    var lowCur = recs.filter(function (r) { return r.low && r.seg === B.seg; });
    var form = P.form, Sb = B.S, sigB = B.sigma;
    // the current segment (opened by the latest workover) holds no used test yet: nothing to alert on
    var segEmpty = B.n === 0 && P.wo.length > 0;
    var E = function (r, e) { return form === 'basevar' ? Math.sqrt(e * e + (fin(sigB) ? sigB * sigB : 0)) : e; };
    // excluded low tests are compared on the alert basis too (val works for any record)
    var dMargin = function (r) {
      var v = val(r);
      if (!v || !fin(v.S) || !fin(v.E) || !fin(Sb)) return null;
      return hund(v.S) - hund(E(r, v.E)) - hund(Sb) - hund(ts.delta);
    };
    var res = { B: B, cur: cur, form: form, segEmpty: segEmpty };
    var enabled = P.enabled && fin(Sb) && !segEmpty;
    var aOn = P.enabled && !segEmpty;
    // delta alert (T2)
    var dRun = enabled ? alertRun(cur, dMargin, ts.confirm === 'immediate') : { raisedAt: null, confirmedAt: null, kHeldOnly: false };
    res.delta = {
      threshold: ts.delta, form: form, raisedAt: dRun.raisedAt, confirmedAt: dRun.confirmedAt,
      status: enabled ? alertStatus(dRun, lowCur, dMargin) : 'none', kHeldOnly: !!dRun.kHeldOnly, inputRobust: true, ev: ['T2']
    };
    // absolute alert (T3)
    if (absVal) {
      var aMarginD = function (dS) {
        return function (r) {
          var v = r.low ? P.lowAbsVal(r) : absVal(r);
          if (!v || !fin(v.S) || !fin(v.E)) return null;
          return hund(v.S + dS) - hund(v.E) - hund(ts.abs);
        };
      };
      var aCur = recs.filter(function (r) { return r.used && r.seg === B.seg && absVal(r); });
      var aRun = aOn ? alertRun(aCur, aMarginD(0), ts.confirm === 'immediate') : { raisedAt: null, confirmedAt: null, kHeldOnly: false };
      var status = aOn ? alertStatus(aRun, lowCur, aMarginD(0)) : 'none';
      var refOf = function (run) { return status === 'confirmed' ? run.confirmedAt : run.raisedAt; };
      var lo = aOn ? alertRun(aCur, aMarginD(-P.sSens(aCur)), ts.confirm === 'immediate') : aRun;
      var hi = aOn ? alertRun(aCur, aMarginD(+P.sSens(aCur)), ts.confirm === 'immediate') : aRun;
      var nom = refOf(aRun);
      res.absolute = {
        threshold: ts.abs, basis: P.absBasis, raisedAt: aRun.raisedAt, confirmedAt: aRun.confirmedAt, status: status, kHeldOnly: !!aRun.kHeldOnly,
        robustness: { lo: refOf(lo) || null, hi: refOf(hi) || null, unchanged: (refOf(lo) || null) === (nom || null) && (refOf(hi) || null) === (nom || null) },
        ev: ['T3']
      };
    }
    // onset (T4): hinge regression with weights 1/S_err², CUSUM confirmation
    var tt = cur.map(function (r) { return r.td; }), yy = cur.map(function (r) { return val(r).S; });
    var ww = cur.map(function (r) { var e = Math.max(DEFAULTS.weightFloor, E(r, val(r).E)); return 1 / (e * e); });
    var cz = enabled ? cur.map(function (r) { var e = Math.max(DEFAULTS.weightFloor, E(r, val(r).E)); return (val(r).S - Sb) / e; }) : [];
    var C = cusum(cz, DEFAULTS.cusumK, DEFAULTS.cusumH);
    var H = enabled ? hinge(tt, yy, ww) : { model: 'constant', shape: null, tau: null, interval: null, n: cur.length };
    var tau = H.model === 'hinge' ? H.tau : null;
    res.H = H;
    res.onset = {
      tauDays: tau, interval: tau !== null && H.interval ? [H.interval[0], H.interval[1]] : null,
      date: tau !== null ? dateOf(P.first_ms + tau * DAY_MS) : null, model: H.model || 'constant', shape: H.shape || null,
      cusum: { alarmAt: C.alarm !== null ? cur[C.alarm].id : null, onsetAt: C.onset !== null ? cur[C.onset].id : null },
      indicative: cur.length < 6, ev: ['T4']
    };
    // recent trend (T5): Theil–Sen ×30 with the Sen CI and Mann–Kendall over the tests after τ̂ (every current-segment
    // test when there is no onset: recent.from 'segment')
    var rec = tau !== null ? cur.filter(function (r) { return r.td > tau; }) : cur.slice();
    res.recentSet = rec;
    var recent = { slopePer30d: null, ci: [null, null], mkZ: null, mkP: null, n: rec.length, indicative: true, wlsSlopePer30d: null, disagree: false,
                   from: tau !== null ? 'onset' : 'segment', ev: ['T5'] };
    var TS = null, MK = null;
    if (enabled && rec.length >= DEFAULTS.recentMinN) {
      var rt = rec.map(function (r) { return r.td; }), ry = rec.map(function (r) { return val(r).S; });
      TS = theilSen(rt, ry); MK = mannKendall(ry);
      var rw = rec.map(function (r) { var e = Math.max(DEFAULTS.weightFloor, val(r).E); return 1 / (e * e); });
      var W = wls(rt, ry, rw, true);
      if (TS.slope !== null) {
        recent.slopePer30d = 30 * TS.slope; recent.ci = [30 * TS.lo, 30 * TS.hi];
        recent.mkZ = MK.z; recent.mkP = MK.p; recent.indicative = rec.length < DEFAULTS.recentSigN;
        recent.wlsSlopePer30d = W.ok ? 30 * W.b : null;
        if (W.ok) {
          var a = r3(recent.slopePer30d), b = r3(recent.wlsSlopePer30d), mx = Math.max(Math.abs(a), Math.abs(b));
          recent.disagree = mx > 0 && Math.abs(a - b) > DEFAULTS.disagreeFrac * mx;
        }
      }
    }
    res.recent = recent; res.TS = TS; res.MK = MK;
    // forecast (T6): crossing of the absolute threshold by the Sen line
    res.forecast = forecastOf(P, res, rec, tau, enabled);
    return res;
  }

  function forecastOf(P, res, rec, tau, enabled) {
    var f = { show: false, date: null, earliest: null, latest: null, reason: '', ev: ['T6'] };
    var TS = res.TS, MK = res.MK;
    if (res.segEmpty) { f.reason = 'Not shown: no interpreted test since the workover on ' + P.wo[P.wo.length - 1] + '.'; return f; }
    if (!enabled) { f.reason = 'Not shown: the trend and alerts are off.'; return f; }
    if (!TS || TS.slope === null) { f.reason = 'Not shown: fewer than 3 tests after the onset, so there is no recent slope.'; return f; }
    // slope decisions on the per-30-day values rounded to 0.001 (D27)
    var kLo = s30(TS.lo), kSl = s30(TS.slope), kHi = s30(TS.hi);
    var sig = kLo > 0 || (fin(MK.p) && r3(MK.p) < DEFAULTS.mkAlpha && rec.length >= DEFAULTS.recentSigN);
    if (!(kSl > 0)) { f.reason = 'Not shown: the recent skin trend is not rising.'; return f; }
    if (!sig) { f.reason = 'Not shown: the lower bound of the Sen slope is at or below zero (the rise is not significant).'; return f; }
    var val = P.val, tLast = rec[rec.length - 1].td, tStart = tau !== null ? tau : rec[0].td;
    var span = tLast - tStart;
    var sFit = TS.intercept + TS.slope * tLast;
    // target on the delta basis: S_alert + typical S_err (+ S − S_mech when the absolute basis is mechanical)
    var eTyp, offset = 0;
    if (P.absBasis === 'mechanical') {
      var mv = rec.map(function (r) { return P.absVal(r); }).filter(Boolean);
      eTyp = median(mv.map(function (v) { return v.E; }));
      offset = median(rec.map(function (r) { var v = P.absVal(r); return v ? val(r).S - v.S : null; }));
    } else eTyp = median(rec.map(function (r) { return val(r).E; }));
    if (!fin(eTyp) || !fin(offset)) { f.reason = 'Not shown: no skin uncertainty for the recent tests.'; return f; }
    var target = P.ts.abs + eTyp + offset;
    if (hund(sFit) >= hund(target)) { f.reason = 'Not shown: the fitted skin is already above the absolute threshold.'; return f; }
    var horizon = DEFAULTS.horizonFactor * span;
    var tc = tLast + (target - sFit) / TS.slope;
    var beyond = function (t) { return Math.round((t - tLast) * 100) > Math.round(horizon * 100); };   // days to 0.01
    if (!(span > 0) || beyond(tc)) { f.reason = 'Not shown: the crossing lies beyond twice the span of the recent tests.'; return f; }
    var tEarly = kHi > 0 ? tLast + (target - sFit) / TS.hi : null;
    var tLate = kLo > 0 ? tLast + (target - sFit) / TS.lo : null;
    f.show = true;
    f.date = dateOf(P.first_ms + tc * DAY_MS);
    f.earliest = tEarly !== null ? dateOf(P.first_ms + tEarly * DAY_MS) : null;
    f.latest = tLate !== null && !beyond(tLate) ? dateOf(P.first_ms + tLate * DAY_MS) : null;
    f.reason = 'Sen-slope extrapolation of the recent skin trend to the absolute threshold (S − S_err = ' + fmtNum(P.ts.abs, 1) +
      '); the range comes from the 95 % slope bounds' + (f.latest ? '.' : tLate === null ? '; the late end is open (the lower slope bound is not above zero).' :
      ' and its late end lies beyond the forecast horizon.');
    f.tDays = tc;
    return f;
  }

  function computeTrend(tests, ctx) {
    ctx = isObj(ctx) ? ctx : {};
    var well = isObj(ctx.well) ? ctx.well : {};
    var fluid = ctx.fluid || well.fluid || 'oil', kind = ruleOf(fluid);
    var ts = trendSettings(ctx.settings);
    var wo = sortedWorkovers(ctx.workovers);
    var warnings = [];
    var pr = prepRecords(tests, ctx, wo), recs = pr.recs;
    var first_ms = fin(pr.first_ms) ? pr.first_ms : 0;
    var used = recs.filter(function (r) { return r.used; });
    var lows = recs.filter(function (r) { return r.low; });
    var historyEstimated = ctx.historyEstimated === true || (isObj(ctx.start) && ctx.start.flag === true && ctx.start.source === 'default');
    var h = pos(well.h) ? well.h : null, rw = pos(well.rw) ? well.rw : null;
    var allocAccPct = fin(well.allocAccPct) ? well.allocAccPct : 5;
    var days = Array.isArray(ctx.days) ? ctx.days.filter(isObj) : [];
    var mech0 = skinFn('mechanicalSkin'), rateFn = skinFn('rateSkin'), prodFn = skinFn('products');
    var skinMissing = !mech0 || !rateFn || !prodFn;

    // ── enabled (TR14) ──
    var cand = recs.filter(function (r) { return r.ok && !r.excluded; });
    var gaps = []; for (var i = 1; i < cand.length; i++) gaps.push(cand[i].td - cand[i - 1].td);
    var medGap = median(gaps);
    var enabled = true, disabledReason = null;
    if (ts.enabled === 'off') { enabled = false; disabledReason = 'Trend and alerts are switched off in the settings.'; }
    else if (ts.enabled === 'auto') {
      if (ctx.mode === 'table') { enabled = false; disabledReason = 'Rate-table (test) data: the trend and alerts are off by default; switch them on to use them.'; }
      else if (medGap !== null && medGap < DEFAULTS.minSpacingDays) {
        enabled = false; disabledReason = 'Tests are less than 1 day apart (median spacing ' + fmtNum(medGap * 24, 1) + ' h): the trend and alerts are off by default; switch them on to use them.';
      }
    }
    if (!used.length && enabled) { enabled = false; disabledReason = recs.length ? 'No test is labelled medium or high, so there is no trend.' : 'No interpreted build-up tests.'; }

    // ── delta form ──
    var form = ts.basevar === true ? 'basevar' : ts.basevar === false ? 'plain' : calDeltaForm();
    var sSensFix = sSensOf(well.sens);
    var sSensOfList = function (list) {
      var v = median(list.map(function (r) { return fin(r.t.sSens) ? r.t.sSens : null; }));
      return fin(v) ? v : sSensFix;
    };

    // ── gas only: the current segment and its baseline on the reported skin S′ (rate-skin row selection) ──
    var valRep = function (r) { return { S: kind === 'gas' ? r.Sap : r.S, E: r.E }; };
    var base = { recs: recs, ts: ts, wo: wo, form: form, enabled: enabled, first_ms: first_ms, sSens: sSensOfList };
    var A = { B: { tests: [] }, cur: [] };
    if (kind === 'gas') {
      A.B = baseline(recs.map(function (r) {
        return { id: r.id, tDays: r.td, date: r.date, S: r.Sap, Serr: r.E, k: r.k, kh: r.t.kh, kHeld: r.kHeld, excluded: !r.used, conf: { ks: r.ks } };
      }), ts.baseN, wo);
      A.cur = recs.filter(function (r) { return r.used && r.seg === A.B.seg && fin(r.Sap); });
    }

    // ── T15 rate-dependent skin (gas) ──
    var rate = { resolved: false, S: null, D: null, seD: null, reason: '', dqEffect: null, ev: ['T15'] };
    var qRef = median(A.B.tests.map(function (id) { var r = recs.find(function (x) { return x.id === id; }); return r ? r.q : null; }));
    var latestUsed = used.length ? used[used.length - 1] : null;
    var qNow = latestUsed ? latestUsed.q : null;
    var Dres = null, seDres = null, expectedD = null;
    if (kind !== 'gas') {
      rate.reason = kind === 'inj' ? 'Water injector: rate-dependent skin is not assessed.' : 'Oil well: rate-dependent skin is not assessed.';
    } else {
      // rows: the current segment's used tests when S′ shows no significant time trend (two-sided Mann–Kendall
      // p ≥ 0.10 and a Sen interval that contains 0); otherwise only its baseline tests. rateSkin applies the
      // ≤ 60-day window and the q ratio itself. (A rate-alternating S′ is not a time trend, so it is kept.)
      var segT = A.cur.map(function (r) { return r.td; }), segS = A.cur.map(function (r) { return r.Sap; });
      var segMK = A.cur.length >= 3 ? mannKendall(segS) : null, segTS = A.cur.length >= 3 ? theilSen(segT, segS) : null;
      var segTrend = !!(segMK && ((fin(segMK.p) && r3(segMK.p) < DEFAULTS.mkAlpha) || (segTS && fin(segTS.lo) && fin(segTS.hi) && (s30(segTS.lo) > 0 || s30(segTS.hi) < 0))));
      var stable = segTrend ? A.cur.filter(function (r) { return A.B.tests.indexOf(r.id) !== -1; }) : A.cur.slice();
      var rows = stable.filter(function (r) { return pos(r.q); }).map(function (r) { return { id: r.id, t_days: r.td, q: r.q, S: r.Sap, Serr: r.E }; });
      var cmp = isObj(ctx.completion) ? ctx.completion : null;
      var opts = { qRatioMin: DEFAULTS.qRatioMin, maxDays: DEFAULTS.maxDays, joint: true,
                   expected: { k: isObj(ctx.baseline) && pos(ctx.baseline.k) ? ctx.baseline.k : A.B.k, h: h, hp: cmp && pos(cmp.hp_ft) ? cmp.hp_ft : h, rw: rw,
                               sg: isObj(well.gas) ? well.gas.sg : null, mu_g: well.mu } };
      var rs = rateFn ? safeCall(rateFn, [rows, opts], warnings, 'RATE_SKIN', 'T15') : null;
      var corr = rows.length >= 3 ? pearson(rows.map(function (x) { return x.q; }), rows.map(function (x) { return x.t_days; })) : null;
      var expectedDRange = null;
      if (rs && rs.expectedD != null) {
        // §3.4 returns {D, lo, hi, …}: the central D is the module's estimate (the range is ×1/3 to ×3, so its
        // arithmetic midpoint would be 1.67× too high). A bare number or a [lo, hi] pair is also accepted; a range
        // alone gives its geometric centre (the arithmetic midpoint when a bound is not positive).
        var ed = rs.expectedD;
        var centre = function (lo, hi) { return lo > 0 && hi > 0 ? Math.sqrt(lo * hi) : 0.5 * (lo + hi); };
        if (fin(ed)) expectedD = ed;
        else if (Array.isArray(ed) && fin(ed[0]) && fin(ed[1])) { expectedDRange = [ed[0], ed[1]]; expectedD = centre(ed[0], ed[1]); }
        else if (isObj(ed)) {
          if (fin(ed.lo) && fin(ed.hi)) expectedDRange = [ed.lo, ed.hi];
          expectedD = fin(ed.D) ? ed.D : expectedDRange ? centre(ed.lo, ed.hi) : null;
        }
      }
      if (!rateFn) rate.reason = 'The PRiSM skin module is not loaded: S′ is the apparent skin including D·q.';
      else if (corr !== null && Math.abs(corr) >= DEFAULTS.collinearCorr) {
        rate.reason = 'Rate and time are collinear in these tests (|r| = ' + fmtNum(Math.abs(corr), 2) + '): D cannot be separated from a skin trend; S′ is the apparent skin including D·q.';
      } else if (rs && rs.resolved === true && fin(rs.D) && pos(rs.seD) && Math.abs(rs.D) / rs.seD >= DEFAULTS.dSeMin && (!fin(rs.qRatio) || rs.qRatio >= DEFAULTS.qRatioMin)) {
        rate.resolved = true; rate.S = nn(rs.S); rate.D = rs.D; rate.seD = rs.seD; Dres = rs.D; seDres = rs.seD;
        rate.reason = 'D resolved from ' + rows.length + ' tests in a stable-skin segment (' + (fin(rs.qRatio) ? 'q ratio ' + fmtNum(rs.qRatio, 2) + ', ' : '') +
          'D/se ' + fmtNum(Math.abs(rs.D) / rs.seD, 1) + ').';
      } else {
        var why = rs && typeof rs.reason === 'string' && rs.reason && rs.reason.length < 200 ? rs.reason : '';
        rate.reason = /apparent skin/.test(why) ? why : (why ? why + ' ' : '') + 'S′ is the apparent skin including D·q.';
      }
      var Duse = Dres !== null ? Dres : expectedD;
      rate.dqEffect = fin(Duse) && fin(qNow) && fin(qRef) ? Duse * (qNow - qRef) : null;
      if (rs && isObj(rs)) {
        rate.n = nn(rs.n); rate.qRatio = nn(rs.qRatio); rate.expectedD = nn(expectedD);
        rate.expectedDRange = expectedDRange ? [nn(expectedDRange[0]), nn(expectedDRange[1])] : null;
        rate.consistent = typeof rs.consistent === 'boolean' ? rs.consistent : null;
      }
    }
    // corrected skin on the common reference rate (gas with D resolved): S_c = S′ − D·(q − q_ref)
    var corrected = kind === 'gas' && Dres !== null && fin(qRef);
    var valAl = corrected ? function (r) {
      if (!fin(r.q)) return null;
      var dq = r.q - qRef;
      return { S: r.Sap - Dres * dq, E: Math.sqrt(r.E * r.E + Math.pow(seDres * dq, 2)) };
    } : valRep;

    // ── T14 mechanical skin ──
    var cmpl = isObj(ctx.completion) ? ctx.completion : null;
    var mechMap = {}, mech = { available: false, Sgeo: null, SgeoRange: [null, null], basis: 'pressureDrop', ev: ['T14'] };
    if (cmpl && mech0) {
      recs.forEach(function (r) {
        if (!fin(r.S)) return;
        var m = safeCall(mech0, [{ S_total: kind === 'gas' ? r.Sap : r.S, Serr: fin(r.E) ? r.E : 0, h: h, rw: rw, completion: cmpl,
                                   D: corrected ? Dres : null, q: corrected ? r.q : null }], warnings, 'MECH_SKIN', 'T14');
        if (m && m.available === true && fin(m.S_mech)) {
          mechMap[r.id] = { S: m.S_mech, E: fin(m.S_mech_err) ? m.S_mech_err : r.E, Sd: nn(m.S_d_local) };
          if (!mech.available) {
            mech.available = true; mech.Sgeo = nn(m.S_geo); mech.SgeoRange = [nn(m.S_geo_lo), nn(m.S_geo_hi)];
            if (Array.isArray(m.validity)) mech.validity = m.validity.filter(isObj).map(function (v) { return { code: String(v.code || ''), text: String(v.text || '').slice(0, 290) }; });
          }
        }
      });
    }
    var absBasis = mech.available ? 'mechanical' : 'total';
    var absVal = absBasis === 'mechanical' ? function (r) { return mechMap[r.id] || null; } : valAl;
    // excluded low tests on the same basis as the used tests (the 'possible' status never mixes bases)
    var lowAbsVal = absVal;

    // ── pass B: alerts, onset, recent, forecast on the alert basis ──
    var P = Object.assign({}, base, { val: valAl, absVal: absVal, lowAbsVal: lowAbsVal, absBasis: absBasis });
    var R = seriesPass(P);
    var B = R.B, segEmpty = R.segEmpty;
    var baseIds = {}; B.segments.forEach(function (g) { g.tests.forEach(function (id) { baseIds[id] = true; }); });

    // ── used flags and series ──
    // trend: every used test (the trend plot and the S(t) of T8/T13 run through all segments); alert: the used tests
    // of the current segment that have a value on the alert basis (the tests the alert evaluation actually reads)
    var usedFlags = {};
    recs.forEach(function (r) {
      usedFlags[r.id] = { baseline: !!baseIds[r.id], trend: r.used && enabled, alert: r.used && enabled && !segEmpty && r.seg === B.seg && !!valAl(r) };
    });
    // extra keys for the review's re-derivation (V27): Salert/SerrAlert = the delta-alert basis (equal to S/Serr
    // except for gas with D resolved, where they are S′ − D·(q − q_ref) and its inflated S_err); seg = segment index
    var series = recs.map(function (r) {
      var t = r.t, m = mechMap[r.id], va = r.ok ? valAl(r) : null;
      return { id: r.id, tDays: nn(r.td), S: nn(r.S), Serr: nn(r.E), k: nn(r.k), pExt: nn(t.pExtDatum), pwf0Datum: nn(t.pwf0Datum),
               Smech: m ? m.S : null, SmechErr: m ? m.E : null, Sd: m ? m.Sd : null,
               Salert: va ? nn(va.S) : null, SerrAlert: va ? nn(va.E) : null, seg: r.seg,
               conf: { ks: r.ks, model: isObj(t.conf) && RANK.hasOwnProperty(t.conf.model) ? t.conf.model : r.ks,
                       headline: isObj(t.conf) && RANK.hasOwnProperty(t.conf.headline) ? t.conf.headline : r.ks },
               used: usedFlags[r.id] };
    });

    // ── T16 tests excluded as low ──
    var lowS = lows.map(function (r) { return r.S; });
    var excludedLow = { n: lows.length, ids: lows.map(function (r) { return r.id; }), S: lows.length ? [minOf(lowS), maxOf(lowS)] : null, ev: ['T16'] };

    // ── S(t) for T8 and T13: piecewise linear through the used tests (alert basis), onset knot (τ̂, S_base) ──
    var tau = R.onset.tauDays, Sb = B.S;
    var usedVals = used.map(function (r) { var v = valAl(r); return v ? [r.td, v.S] : null; }).filter(Boolean);
    // (a used test that sits exactly at τ̂ keeps its own value; the knot is inserted only between tests)
    var sKnots;
    var atTau = tau !== null && usedVals.some(function (k) { return Math.abs(k[0] - tau) < 1e-9; });
    if (tau !== null && fin(Sb) && !atTau) {
      sKnots = usedVals.filter(function (k) { return k[0] < tau; }).concat([[tau, Sb]]).concat(usedVals.filter(function (k) { return k[0] > tau; }));
    } else sKnots = usedVals.slice();
    var sAt = function (d) { return lin(sKnots, d); };
    // the cumulative runs from τ̂; without an onset (model 'constant' or 'line') from the last baseline test of the
    // current segment (pi.cumFrom 'baselineEnd'), so the page can say "since the end of the baseline"
    var lastBase = B.tests.length ? recs.find(function (r) { return r.id === B.tests[B.tests.length - 1]; }) : null;
    var tauCum = enabled && !segEmpty ? (tau !== null ? tau : (lastBase ? lastBase.td : null)) : null;
    var cumFrom = tauCum === null ? null : tau !== null ? 'onset' : 'baselineEnd';

    // ── T7 Δp across the skin ──
    var skinDp = recs.filter(function (r) { return fin(r.S); }).map(function (r) {
      var t = r.t, v = fin(t.dpSkin_psi) ? t.dpSkin_psi : (fin(t.m) ? 0.8686 * t.m * r.S : null);
      return { id: r.id, dpSkin_psi: v };
    });

    // ── T8 PI ratio and production at stake (pseudo-steady-state estimates) ──
    var rinvMax = maxOf(used.map(function (r) { return pos(r.t.rinv_ft) ? r.t.rinv_ft : null; }));
    var reSource = pos(well.re_ft) ? 'input' : 'rinv', re = pos(well.re_ft) ? well.re_ft : rinvMax;
    // B and μ from the well inputs (Bw and μw for injectors), as §4.7 writes 141.2·qBμ·ΔS/kh and J_pred
    var B_ = fluid === 'water_inj' ? (pos(well.Bw) ? well.Bw : 1) : (pos(well.B) ? well.B : 1);
    var mu_ = fluid === 'water_inj' ? (pos(well.muw) ? well.muw : 1) : (pos(well.mu) ? well.mu : 1);
    var bmuWell = B_ * mu_;
    var qUnit = latestUsed && latestUsed.t.qUnit ? latestUsed.t.qUnit : (kind === 'gas' ? 'Mscf/d' : kind === 'inj' ? 'bbl/d' : 'STB/d');
    var pi = { X: null, re_ft: nn(re), reSource: reSource, ratioNow: null, ratioBase: null, ratioLowerBound: reSource === 'rinv',
               rateAtStake: null, rateUnit: qUnit, extraDrawdown_psi: null, cumAtStake: null, cumUnit: volUnit(qUnit),
               atStakeUpperBound: reSource === 'rinv', value: null, guard: false, cumFrom: null, cumFromDays: null, ev: ['T8'] };
    // gas with D resolved: the X + S terms use S + D·q at the rate in question
    var effS = function (Sc, q) { return corrected && fin(q) ? Sc + Dres * (q - qRef) : Sc; };
    var latestVal = latestUsed ? valAl(latestUsed) : null;
    var Snow = latestVal ? effS(latestVal.S, qNow) : null, SbaseNow = fin(Sb) ? effS(Sb, qNow) : null;
    var X = null;
    if (prodFn && latestUsed && pos(re) && rw && fin(Snow)) {
      var common = { k: latestUsed.k, h: h, B: B_, mu: mu_, q: qNow, Dq: qNow, rw: rw, re_ft: re, reSource: reSource,
                     pbar: nn(latestUsed.t.pExtDatum), pwf: nn(latestUsed.t.pwf0Datum) };
      var pNow = safeCall(prodFn, [Object.assign({ S: Snow }, common)], warnings, 'PRODUCTS', 'T8');
      var pBase = fin(SbaseNow) && !segEmpty ? safeCall(prodFn, [Object.assign({ S: SbaseNow }, common)], warnings, 'PRODUCTS', 'T8') : null;
      // X is geometric (kept for T13); the PI ratio and at-stake numbers wait for a test in the current segment
      if (pNow && fin(pNow.X)) { X = pNow.X; pi.X = X; }
      if (pNow && fin(pNow.X) && !segEmpty) {
        if (typeof pNow.piRatioLowerBound === 'boolean') pi.ratioLowerBound = pNow.piRatioLowerBound;
        if (typeof pNow.rateAtStakeUpperBound === 'boolean') pi.atStakeUpperBound = pNow.rateAtStakeUpperBound;
        pi.guard = pNow.guard === true || (pBase ? pBase.guard === true : false);
        pi.FE = nn(pNow.FE); pi.DR = nn(pNow.DR);
        if (!pi.guard) {
          pi.ratioNow = nn(pNow.piRatio);
          pi.ratioBase = pBase ? nn(pBase.piRatio) : null;
          if (fin(SbaseNow) && pos(qNow)) {
            pi.rateAtStake = qNow * ((X + Snow) / (X + SbaseNow) - 1);
            if (pos(latestUsed.k) && h) pi.extraDrawdown_psi = 141.2 * qNow * bmuWell * (Snow - SbaseNow) / (latestUsed.k * h);
          }
          // cumulative since τ̂: Σ_days q_d·[(X + S(t_d))/(X + S_base) − 1] over days whose midpoint is at or after τ̂
          // (or the last baseline test when there is no onset; see cumFrom)
          if (tauCum !== null && fin(Sb) && days.length) {
            var cum = 0, nDay = 0, guardHit = false;
            days.forEach(function (d) {
              if (!fin(d.t0_ms) || !fin(d.t1_ms) || !fin(d.q)) return;
              var td = (0.5 * (d.t0_ms + d.t1_ms) - first_ms) / DAY_MS;
              if (td < tauCum) return;
              var sNow = effS(sAt(td), d.q), sB = effS(Sb, d.q);
              if (X + sNow < 1 || X + sB < 1) { guardHit = true; return; }
              cum += d.q * ((X + sNow) / (X + sB) - 1); nDay++;
            });
            if (guardHit) pi.guard = true;
            else { pi.cumAtStake = cum; pi.value = ts.price !== null ? cum * ts.price : null; pi.cumFrom = cumFrom; pi.cumFromDays = nn(tauCum); }
          }
        }
      }
    }

    // ── T9 k stability ──
    var free = used.filter(function (r) { return !r.kHeld && pos(r.k); });
    var kArr = free.map(function (r) { return r.k; }), kMed = median(kArr);
    var cv = kMed ? (kArr.length >= 2 ? 1.4826 * madAbout(kArr, kMed) / kMed : 0) : null;
    var tol = Math.max(DEFAULTS.kStableMinPct, allocAccPct) / 100;
    var kStable = cv !== null ? r3(cv) <= tol : true;
    var sRising = R.delta.status === 'provisional' || R.delta.status === 'confirmed' || (fin(R.recent.ci[0]) && Math.round(R.recent.ci[0] * 1000) > 0);
    var kTS = free.length >= 3 ? theilSen(free.map(function (r) { return r.td; }), kArr) : null;
    var kSpan = free.length >= 2 ? free[free.length - 1].td - free[0].td : 0;
    var kFalling = !!(kTS && kTS.slope !== null && kMed && kSpan > 0 && s30(kTS.slope) < 0 && r3(Math.abs(kTS.slope * kSpan) / kMed) > tol);
    var kRateRho = spearman(free.map(function (r) { return r.k; }), free.map(function (r) { return r.q; }), DEFAULTS.spearmanN);
    var kFollowsRate = kRateRho !== null && kRateRho >= DEFAULTS.kRateSpearman;
    var reading = kStable ? (sRising ? 'nearWell' : 'none') : (sRising ? 'mobility' : (kFollowsRate ? 'allocation' : 'none'));
    var kStability = { cv: nn(cv), stable: kStable, allocAccPct: allocAccPct, reading: reading, ev: ['T9'],
                       median: nn(kMed), n: free.length, falling: kFalling, followsRate: kFollowsRate };

    // ── T10 pressure trend ──
    var family = pFamily(used.map(function (r) { return r.t; }));
    var quantity = family === 'closed' ? 'pbar' : 'pStar';
    var pPts = used.map(function (r) {
      var t = r.t, v = null;
      if (quantity === 'pStar') v = fin(t.pStarDatum) ? t.pStarDatum : (t.pExtKind === 'pStar' && fin(t.pExtDatum) ? t.pExtDatum : null);
      else v = t.pExtKind === 'pbar' && fin(t.pExtDatum) ? t.pExtDatum : null;
      return v !== null ? [r.td, v] : null;
    }).filter(Boolean);
    var drift = fin(well.driftPsiPerDay) ? Math.abs(well.driftPsiPerDay) : 0.01;
    // (independent of the skin trend switch: only an estimated history or fewer than 3 tests make it not assessable)
    var pTrend = { quantity: quantity, assessable: false, reason: null, slopePer30d: null, scatter: null, depletion: null, label: '', ev: ['T10'] };
    if (historyEstimated) {
      pTrend.reason = 'The production start is estimated: the assumed history alone would create a p* trend, so depletion cannot be assessed.';
      pTrend.label = 'Depletion cannot be assessed (estimated history); see the p* range of each test.';
    } else if (pPts.length < 3) {
      pTrend.reason = quantity === 'pbar' ? 'Fewer than 3 tests carry an average-pressure value.' : 'Fewer than 3 tests carry p*.';
      pTrend.label = 'Depletion cannot be assessed (fewer than 3 tests).';
    } else {
      var pt = pPts.map(function (p) { return p[0]; }), py = pPts.map(function (p) { return p[1]; });
      var pTS = theilSen(pt, py), pMK = mannKendall(py);
      var resid = pPts.map(function (p) { return p[1] - (pTS.intercept + pTS.slope * p[0]); });
      var scatter = 1.4826 * madAbout(resid, median(resid));
      var pSpan = pt[pt.length - 1] - pt[0];
      var change = Math.abs(pTS.slope) * pSpan;
      var sig = Math.round(change * 10) > Math.round(2 * scatter * 10) && r3(pMK.p) < DEFAULTS.mkAlpha;
      pTrend.assessable = true;
      pTrend.slopePer30d = 30 * pTS.slope; pTrend.scatter = scatter;
      // slope sign and the drift comparison on the per-30-day values rounded to 0.001 psi (D27)
      var falls = s30(pTS.slope) < 0;
      pTrend.depletion = sig && falls;
      var driftCould = s30(Math.abs(pTS.slope)) <= s30(drift);
      var qn = quantity === 'pbar' ? 'average pressure' : 'p*';
      if (!sig) pTrend.label = 'No significant ' + qn + ' trend (no depletion seen).';
      else if (falls) pTrend.label = driftCould ? 'Depletion or gauge drift (the drift input could explain it).' : 'Depletion: ' + qn + ' falls by ' + fmtNum(Math.abs(30 * pTS.slope), 1) + ' psi per 30 days (gauge drift alone cannot explain it).';
      else pTrend.label = driftCould ? 'Rising ' + qn + ': pressure support or gauge drift (the drift input could explain it).' : 'Rising ' + qn + ': pressure support, injection or interference.';
    }
    var closedWithoutDepletion = pTrend.assessable && pTrend.depletion === false
      ? used.filter(function (r) { return r.t.chosen === 'closedCircle'; }).map(function (r) { return r.id; }) : [];

    // ── T11 model-free ΔS ──
    var modelFree = [];
    var iarfTests = used.filter(function (r) { return pos(r.t.iarfDt0_h) && pos(r.t.dtEnd_h) && r.t.bins && Array.isArray(r.t.bins.dte); });
    if (iarfTests.length >= 2) {
      var minEnd = minOf(iarfTests.map(function (r) { return r.t.dtEnd_h; }));
      var dtRef = maxOf(iarfTests.map(function (r) { return r.t.iarfDt0_h <= minEnd ? r.t.iarfDt0_h : null; }));
      var atRef = function (r) {
        var t = r.t, de = pos(t.dteEnd_h) ? t.dteEnd_h : t.bins.dte[t.bins.dte.length - 1];
        var tp = t.dtEnd_h > de ? t.dtEnd_h * de / (t.dtEnd_h - de) : null;
        var dte = tp ? tp * dtRef / (tp + dtRef) : dtRef;
        return { dte: dte, dp: logInterp(t.bins.dte, t.bins.dp, dte) };
      };
      if (dtRef !== null) {
        var refT = iarfTests[0], b = atRef(refT);
        iarfTests.slice(1).forEach(function (r) {
          var a = atRef(r);
          if (!fin(a.dp) || !fin(b.dp) || !pos(r.q) || !pos(refT.q) || !fin(refT.t.m) || refT.t.m === 0) return;
          var dS = 1.1513 * ((a.dp / r.q - b.dp / refT.q) / (refT.t.m / refT.q) - Math.log10(a.dte / b.dte));
          var fitted = r.S - refT.S;
          modelFree.push({ id: r.id, refId: refT.id, dS: dS, fittedDS: fitted,
                           agrees: hund(Math.abs(dS - fitted)) <= hund(Math.max(DEFAULTS.agreeMin, r.E)) });
        });
      }
    }

    // ── T12 bubble point ──
    var bubble = { rows: [], spearman: null, ev: ['T12'] };
    var Pb = pos(well.Pb) ? well.Pb : null;
    if (kind === 'oil' && Pb !== null) {
      var dep = isObj(ctx.depth) ? ctx.depth : null;
      var dz = dep && fin(dep.datumTVD) && fin(dep.gaugeTVD) ? dep.datumTVD - dep.gaugeTVD : 0;
      var G0 = dep && fin(dep.grad) ? dep.grad : 0;
      var GF = dep && fin(dep.gradFlow) ? dep.gradFlow : G0;
      var tau3 = [];
      used.forEach(function (r) {
        var p0 = r.t.pwf0Datum; if (!fin(p0)) return;
        var a = p0 + (GF * (1 - DEFAULTS.gradTol) - G0) * dz, c = p0 + (GF * (1 + DEFAULTS.gradTol) - G0) * dz;
        var lo = Math.min(a, c), hi = Math.max(a, c), margin = lo - Pb;
        var level = Math.round(margin * 10) >= Math.round(DEFAULTS.bubbleMargin * 10) ? 'ok' : Math.round(margin * 10) >= 0 ? 'minor' : 'major';
        if (pTrend.assessable && fin(r.t.pExtDatum) && r.t.pExtDatum < Pb) level = 'critical';
        else if (historyEstimated && isObj(r.t.pStarRangeDatum) && fin(r.t.pStarRangeDatum.hi) && r.t.pStarRangeDatum.hi < Pb) level = 'major';
        bubble.rows.push({ id: r.id, pwfSand_lo: lo, pwfSand_hi: hi, margin: margin, level: level });
        tau3.push([r.S, Math.max(0, Pb - 0.5 * (lo + hi))]);
      });
      if (tau3.length >= DEFAULTS.spearmanN) bubble.spearman = spearman(tau3.map(function (x) { return x[0]; }), tau3.map(function (x) { return x[1]; }), DEFAULTS.spearmanN);
    }

    // ── T13 PI cross-check ──
    var kBase = isObj(ctx.baseline) && pos(ctx.baseline.k) ? ctx.baseline.k : B.k;
    var piCheck = { available: false, reason: null, rows: [], consistent: null, rho: null, ev: ['T13'] };
    if (kind === 'inj') piCheck.reason = 'Water injector: the PI cross-check is not used.';
    else if (historyEstimated) piCheck.reason = 'The production start is estimated, so p* (and the reference pressure) is not reliable.';
    else if (!days.length) piCheck.reason = 'No daily rates (rate-table mode).';
    else if (X === null) piCheck.reason = skinMissing ? 'The PRiSM skin module is not loaded.' : 'The drainage radius term is not available.';
    else if (!pos(kBase) || !h) piCheck.reason = 'No baseline permeability.';
    else {
      var pKnots = used.filter(function (r) { return fin(r.t.pExtDatum) && fin(r.t.t_ms); }).map(function (r) { return [r.t.t_ms, r.t.pExtDatum]; });
      if (pKnots.length < 1 || used.length < 2) piCheck.reason = 'Fewer than 2 used tests with p_ext.';
      else {
        // one pass over the days: each clean flowing day falls in the interval (t_u−1, t_u) of consecutive used tests
        var allObs = [], allPred = [];
        var tU = used.map(function (r) { return r.t.t_ms; }), byInt = used.map(function () { return []; });
        days.forEach(function (d) {
          if (d.cls !== 'clean' || !fin(d.q) || !(d.q > 0) || !fin(d.t0_ms) || !fin(d.t1_ms)) return;
          var pwf = fin(d.pwfMeanDatum_psia) ? d.pwfMeanDatum_psia : (fin(d.pwfMean_psia) ? d.pwfMean_psia : null);
          if (pwf === null) return;
          var mid = 0.5 * (d.t0_ms + d.t1_ms);
          var lo = 0, hi = tU.length;                       // first index u with tU[u] > mid
          while (lo < hi) { var md = (lo + hi) >> 1; if (tU[md] > mid) hi = md; else lo = md + 1; }
          if (lo < 1 || lo >= tU.length || !(mid > tU[lo - 1])) return;
          var pRef = lin(pKnots, mid); if (!(pRef > pwf)) return;
          var sd = effS(sAt((mid - first_ms) / DAY_MS), d.q);
          if (!(X + sd > 0)) return;
          var jObs = d.q / (pRef - pwf), jPred = kBase * h / (141.2 * bmuWell * (X + sd));
          byInt[lo].push(jObs / jPred); allObs.push(jObs); allPred.push(jPred);
        });
        for (var u = 1; u < used.length; u++) {
          piCheck.rows.push({ from: used[u - 1].id, to: used[u].id, RJ: byInt[u].length ? median(byInt[u]) : null, nDays: byInt[u].length });
        }
        piCheck.available = true;
        var withData = piCheck.rows.filter(function (r) { return fin(r.RJ); });
        piCheck.consistent = withData.length ? withData.every(function (r) { return r3(r.RJ) >= DEFAULTS.piLo && r3(r.RJ) <= DEFAULTS.piHi; }) : null;
        piCheck.rho = allObs.length >= DEFAULTS.spearmanN ? spearman(allObs, allPred, DEFAULTS.spearmanN) : null;
        if (!withData.length) piCheck.reason = 'No clean flowing days between the used tests.';
      }
    }

    // ── cross-test (stage-3 window-level check, reported; closed circle without depletion) ──
    var wli = [];
    (Array.isArray(ctx.windowLevelInconsistent) ? ctx.windowLevelInconsistent : []).forEach(function (id) { if (typeof id === 'string' && wli.indexOf(id) === -1) wli.push(id); });
    recs.forEach(function (r) { if (r.t.windowLevelInconsistent === true && wli.indexOf(r.id) === -1) wli.push(r.id); });
    var crossTest = { windowLevelInconsistent: wli, closedWithoutDepletion: closedWithoutDepletion };

    // ── recommendations (advisory, with evidence) ──
    var recos = [];
    var push = function (code, text, ev, values) { var o = { code: code, text: text.slice(0, 600), ev: ev }; if (values) o.values = values; recos.push(o); };
    if (R.delta.status === 'confirmed' && kStable) {
      push('stimReview', 'Confirmed skin rise with stable k: review the well as a stimulation candidate.', ['T2', 'T9']);
    }
    var defaulted = Array.isArray(well.defaulted) ? well.defaulted.filter(function (k) { return typeof k === 'string'; }) : [];
    var INPUT_NAME = { h: 'h', mu: 'μ', B: 'B', phi: 'φ', ct: 'c_t', rw: 'r_w' };
    var keyInputs = defaulted.filter(function (k, i) { return INPUT_NAME.hasOwnProperty(k) && defaulted.indexOf(k) === i; });
    if (keyInputs.length) {
      push('verifyInputs', 'Verify the defaulted inputs (' + keyInputs.map(function (k) { return INPUT_NAME[k]; }).join(', ') +
           '): h, μ and B scale k, and h, φ, c_t and r_w shift every skin equally (the skin change and the delta alert are not affected).',
           latestUsed ? [evId(latestUsed.id, 'U2')] : ['T9']);
    }
    var bubbleBad = bubble.rows.filter(function (r) { return r.level === 'major' || r.level === 'critical'; });
    if (bubbleBad.length || (bubble.spearman !== null && r3(bubble.spearman) >= DEFAULTS.spearmanMin)) {
      push('bubble', 'Check the flowing pressure against the bubble point: ' + (bubbleBad.length ? bubbleBad.length + ' used test(s) flow below Pb at the sandface' : 'the skin rise follows the pressure drop below Pb') +
           '; free gas near the well can raise the apparent skin.', ['T12']);
    }
    var pb = isObj(ctx.phaseBasis) ? ctx.phaseBasis : null;
    if (pb && (pb.used === 'total' || pb.twoPhaseCt === true || (fin(pb.wcMax) && pb.wcMax > 0.05) || (fin(pb.gorRatioMax) && pb.gorRatioMax > 1.2))) {
      push('wcGor', 'Water cut or GOR changes over the analysis: watch their trend, because a mobility change also moves k and S (rates are on the ' + (pb.used === 'total' ? 'total reservoir' : String(pb.used || 'oil')) + ' basis).', ['R7']);
    }
    if (kind === 'gas' && !rate.resolved) {
      push('nonDarcy', 'Run a multi-rate test (or vary the rate between shut-ins by at least 1.5×) to separate the rate-dependent skin D·q from the mechanical skin.', ['T15']);
    }
    var interp = recs.filter(function (r) { return r.ok && !r.excluded; });
    var shortT = interp.filter(function (r) { return pos(r.t.reachFair_h) && pos(r.t.dteEnd_h) && r.t.reachFair_h > r.t.dteEnd_h; });
    if (interp.length && 2 * shortT.length > interp.length) {
      var X_h = median(interp.map(function (r) { return pos(r.t.reachFairShut_h) ? r.t.reachFairShut_h : null; }));
      var hTxt = X_h !== null ? (X_h >= 10 ? String(Math.ceil(X_h)) : (Math.ceil(X_h * 10) / 10).toFixed(1)) : null;
      push('longerShutins', hTxt !== null
        ? 'Most build-ups end before the expected IARF reach (' + shortT.length + ' of ' + interp.length + '): this well needs a shut-in of at least ' + hTxt + ' h for a fair IARF window.'
        : 'Most build-ups end before the expected IARF reach (' + shortT.length + ' of ' + interp.length + '), and the producing time before each shut-in is too short for a fair IARF window; flow longer before the shut-in.',
        shortT.map(function (r) { return evId(r.id, 'W4'); }), X_h !== null ? { shut_h: X_h } : null);
    }
    if (historyEstimated) push('prodStart', 'Enter the production start date or the cumulative production: p* is then a single value and the pressure trend can be assessed.', ['R5']);
    var interventions = Array.isArray(ctx.interventions) ? ctx.interventions.filter(function (x) { return typeof x === 'string'; }) : [];
    var drops = [];
    for (var j = 1; j < used.length; j++) {
      var p0 = used[j - 1], p1 = used[j];
      if (p1.seg !== p0.seg) continue;
      var drop = p0.S - p1.S;
      if (hund(drop) > hund(Math.max(DEFAULTS.workoverDrop, 2 * Math.sqrt(p0.E * p0.E + p1.E * p1.E)))) drops.push(p1.id);
    }
    if (interventions.length || drops.length) {
      push('workover', 'Enter a workover or stimulation date if the well was treated: ' + (interventions.length ? 'a suspected intervention was detected' : 'the skin drops sharply at ' + drops.join(', ')) +
           '; a date starts a new baseline and a new partial-cut reference.', drops.length ? drops.map(function (id) { return evId(id, 'A2'); }) : ['D1']);
    }

    // ── limitations (fixed list plus case items) ──
    var lim = [];
    var L = function (code, text) { lim.push({ code: code, text: text.slice(0, 600) }); };
    L('models', 'Dual porosity, fractures, channels and multilayer behaviour are not interpreted.');
    L('singlePhase', 'Single-phase fluid properties are assumed' + (pb && pb.twoPhaseCt ? '; free gas is likely, so ct is two-phase and the skin may include a two-phase near-well effect.' : '.'));
    L('inputs', 'The reservoir and fluid inputs are not checked against other data; a uniform input error shifts every skin equally, so the skin change is unaffected but the absolute skin is not.');
    L('allocation', ctx.mode === 'table' ? 'Rates come from the time-stamped rate table and are taken as measured.' : 'Rates come from the daily allocation spread over the detected flowing hours; its accuracy (about ' + fmtNum(allocAccPct, 0) + ' %) limits k and the skin.');
    L('totalSkin', mech.available ? 'The absolute alert uses the mechanical skin (total skin less the geometric pseudo-skins); the delta alert uses the total skin.' : 'Skins are total skins and may include geometric pseudo-skins (partial penetration, deviation); enter the completion to split them.');
    L('pss', 'The PI ratio, the production at stake and the predicted PI are pseudo-steady-state estimates' + (reSource === 'rinv' ? ' with r_e assumed from the radius of investigation (PI ratio a lower bound, production at stake an upper bound).' : '.'));
    L('partialCuts', 'Partial rate cuts are classified and listed, not interpreted.');
    L('storage', 'Changing wellbore storage is not modelled.');
    L('gradient', 'Gradient changes in the wellbore during the build-up are not modelled.');
    L('iarfEarliest', 'The IARF window is the earliest plateau after the storage hump, not the longest; the longest qualifying window is reported.');
    if (historyEstimated) L('pStarEstimated', 'The production start is estimated: p* is reported as a range and is not used for any trend.');
    if (!enabled && disabledReason) L('trendOff', disabledReason);
    if (wo.length) L('segments', 'Each entered workover date starts a new baseline; alerts are evaluated in the latest segment only.');
    if (segEmpty && enabled) L('segmentEmpty', 'No interpreted test since the workover on ' + wo[wo.length - 1] + '; alerts restart with the next test.');
    if (skinMissing) L('skinModule', 'The PRiSM skin module is not loaded: the mechanical skin, the rate-dependent skin and the PSS products are not computed.');
    if (pi.guard) L('negSkin', 'PI ratio and production at stake: not computable (strongly negative skin, X + S below 1).');

    var trend = {
      ok: recs.length > 0, n: recs.length, nUsed: used.length, enabled: enabled, disabledReason: disabledReason,
      baseline: B, series: series, excludedLow: excludedLow,
      alerts: { delta: R.delta, absolute: R.absolute }, onset: R.onset, recent: R.recent, forecast: R.forecast,
      skinDp: skinDp, pi: pi, kStability: kStability, pTrend: pTrend, modelFree: modelFree, bubble: bubble, piCheck: piCheck,
      mech: mech, rateSkin: rate, crossTest: crossTest, recommendations: recos, limitations: lim,
      corrected: corrected, family: family, warnings: warnings
    };
    if (!recs.length) { trend.code = 'NO_TESTS'; trend.errors = ['No interpreted build-up tests.']; trend.bad = ['tests']; }
    if (scrub(trend, 0)) warnings.push({ code: 'NON_FINITE', level: 'warn', text: 'A non-finite number was replaced by an empty value.', ev: ['T1'] });
    return trend;
  }

  // §3.0: engines never throw. An internal failure returns a complete empty Trend with the failure keys.
  function compute(tests, ctx) {
    try { return computeTrend(tests, ctx); } catch (e) {
      var t;
      try { t = computeTrend([], {}); } catch (e2) { t = { ok: false, n: 0, nUsed: 0, enabled: false, warnings: [] }; }
      t.ok = false; t.code = 'TREND_ERROR'; t.errors = ['The trend could not be computed from these tests.']; t.bad = ['tests'];
      t.disabledReason = 'The trend could not be computed from these tests.';
      return t;
    }
  }

  BU.trend = {
    DEFAULTS: DEFAULTS,
    compute: compute,
    baseline: baseline,
    theilSen: theilSen,
    mannKendall: mannKendall,
    hinge: hinge,
    cusum: cusum,
    pFamily: pFamily,
    sSensOf: sSensOf,
    normCdf: normCdf,
    spearman: function (x, y) { return spearman(x || [], y || [], 3); }
  };
})();

// === SELF-TEST ===
(function () {
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var T = G.WTS_buildup && G.WTS_buildup.trend, fails = [];
  function near(a, b, tol, what) { if (!(Math.abs(a - b) <= tol)) fails.push(what + ': ' + a + ' vs ' + b); }
  function ok(c, what) { if (!c) fails.push(what); }
  if (!T) { if (typeof console !== 'undefined') console.error('[buildup-trend self-test] module missing'); return; }
  var ts = T.theilSen([0, 1, 2, 3, 4], [1, 3, 2, 5, 4]);
  near(ts.slope, 0.875, 1e-12, 'Theil–Sen slope');
  var mk = T.mannKendall([1, 3, 2, 5, 4]);
  ok(mk.S === 6 && Math.abs(mk.varS - 50 / 3) < 1e-12, 'Mann–Kendall S and Var(S)');
  near(T.normCdf(1.959964), 0.975, 1e-6, 'normal CDF');
  var c = T.cusum([0, 0.2, -0.1, 3, 3], 0.5, 4);
  ok(c.alarm === 4 && c.onset === 2, 'CUSUM alarm and onset');
  var h = T.hinge([0, 10, 20, 30, 40, 50], [1, 1, 1, 2, 3, 4], [100, 100, 100, 100, 100, 100]);
  ok(h.model === 'hinge' && Math.abs(h.tau - 20) < 1e-9, 'hinge onset');
  near(T.sSensOf({ h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 }), 0.2304, 0.0005, 'S_sens (typical ranges)');
  if (fails.length && typeof console !== 'undefined') console.error('[buildup-trend self-test] FAILED:\n  ' + fails.join('\n  '));
})();
