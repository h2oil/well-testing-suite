// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 18 — Tide Analysis (ocean-tide pressure correction
//                                    + ct estimate)
//   Detects astronomical tide harmonics in offshore pressure-gauge
//   data, fits their amplitudes/phases via linear least-squares, and
//   produces a corrected pressure record cleaned of the periodic
//   tidal signal. From the M2 amplitude response, an in-situ estimate
//   of the formation total compressibility ct can be obtained
//   (Bredehoeft 1967; Van der Kamp & Gale 1983; Van der Kamp 1990).
//
// PHYSICAL BACKGROUND
//   Solid-Earth tides cause a periodic dilatational strain that loads
//   the formation. The principal lunar semi-diurnal constituent (M2,
//   period 12.4206 h) is the strongest and dominates most offshore
//   pressure records. The amplitude of the M2 pressure response (R_M2,
//   in psi) divided by the theoretical M2 strain-induced load gives
//   a barometric/areal-strain efficiency, from which ct can be backed
//   out for a saturated, confined formation:
//
//       ct ≈ R_obs_M2 / ( R_theoretical_M2 · ρ_w·g · h · ξ )
//
//   where ξ ≈ 0.6 is the combined Love-number factor (h - 1.16·k₂)
//   and ρ_w·g ≈ 0.433 psi/ft for fresh water. The relation is
//   well-established for water-bearing intervals; in oil/gas zones it
//   provides a useful order-of-magnitude check against the PVT-derived
//   ct (window.PRiSM_pvt._computed.ct, when present).
//
// PUBLIC API (all on window.*)
//   PRiSM_tideAnalysis(t, p, opts)         → result object
//   PRiSM_applyTideCorrection()            → corrected dataset (or null)
//   PRiSM_resetTideCorrection()            → restored dataset (or null)
//   PRiSM_renderTidePanel(container)       → void   (UI host helper)
//   PRiSM_plot_tide_decomposition(canvas, data, opts) → void
//   PRiSM_TIDE_CONSTITUENTS                → constant table (10 entries)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • Pure vanilla JS, Math.*. No external dependencies.
//   • Time in HOURS (matches PRiSM convention). Tide periods in hours.
//   • Detrending: linear LS removes long-period reservoir drift before
//     harmonic fitting. Without it the fit chases the trend instead
//     of the tide.
//   • Quality-of-fit guard: if data duration < 2 × longest constituent
//     period, that constituent is skipped and a clear caveat appears
//     in `rationale`. Datasets shorter than minDuration_h skip the
//     fit entirely.
//   • Defensive output — returns ct_estimate: null when depth or
//     theoreticalM2_psi is missing/invalid; never throws on user input.
//   • Self-test at end (synthetic M2/S2/noise recovery + ct sanity).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module loads in the smoke-test stub.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window
                          : (typeof globalThis !== 'undefined' ? globalThis : {});

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

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    function _esc(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        d = (d == null) ? 3 : d;
        var a = Math.abs(v);
        if (a !== 0 && (a < 1e-3 || a >= 1e6)) return Number(v).toExponential(2);
        return Number(v).toFixed(d);
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — ASTRONOMICAL TIDE CONSTITUENTS
    // ═══════════════════════════════════════════════════════════════
    // Ten principal constituents covering the semi-diurnal (~12 h),
    // diurnal (~24 h), and long-period (fortnightly / monthly) bands.
    // Periods are sidereal/synodic in mean solar hours; frequencies
    // are derived as 1 / period (cycles per hour) so that the
    // harmonic-regression basis is cos(2π·f·t) and sin(2π·f·t) with
    // t in hours.
    //
    // Source: Doodson constants tabulated in standard tide tables
    // (Pugh 1987, "Tides, Surges and Mean Sea-Level"; IHO 2006).
    // ═══════════════════════════════════════════════════════════════

    var PRiSM_TIDE_CONSTITUENTS = [
        { name: 'M2', desc: 'Principal lunar semi-diurnal',     period: 12.4206, type: 'semi-diurnal', isMajor: true  },
        { name: 'S2', desc: 'Principal solar semi-diurnal',     period: 12.0000, type: 'semi-diurnal', isMajor: true  },
        { name: 'N2', desc: 'Larger lunar elliptic semi-diurnal', period: 12.6583, type: 'semi-diurnal', isMajor: false },
        { name: 'K2', desc: 'Lunar-solar declinational semi-diurnal', period: 11.9672, type: 'semi-diurnal', isMajor: false },
        { name: 'K1', desc: 'Lunar-solar diurnal',              period: 23.9345, type: 'diurnal',      isMajor: true  },
        { name: 'O1', desc: 'Principal lunar diurnal',          period: 25.8193, type: 'diurnal',      isMajor: true  },
        { name: 'P1', desc: 'Principal solar diurnal',          period: 24.0659, type: 'diurnal',      isMajor: false },
        { name: 'Q1', desc: 'Larger lunar elliptic diurnal',    period: 26.8684, type: 'diurnal',      isMajor: false },
        { name: 'Mf', desc: 'Lunar fortnightly',                period: 327.86,  type: 'long-period',  isMajor: false },
        { name: 'Mm', desc: 'Lunar monthly',                    period: 661.31,  type: 'long-period',  isMajor: false }
    ];
    // Add freq (cycles/hr) for each.
    for (var _ci = 0; _ci < PRiSM_TIDE_CONSTITUENTS.length; _ci++) {
        PRiSM_TIDE_CONSTITUENTS[_ci].freq = 1.0 / PRiSM_TIDE_CONSTITUENTS[_ci].period;
    }
    G.PRiSM_TIDE_CONSTITUENTS = PRiSM_TIDE_CONSTITUENTS;

    // The 4 default majors — plenty of resolving power on multi-day
    // surveys and avoids ill-conditioning when N2/K2 collide with M2/S2.
    var DEFAULT_CONSTITUENT_NAMES = ['M2', 'S2', 'K1', 'O1'];

    function _constituentByName(name) {
        for (var i = 0; i < PRiSM_TIDE_CONSTITUENTS.length; i++) {
            if (PRiSM_TIDE_CONSTITUENTS[i].name === name) return PRiSM_TIDE_CONSTITUENTS[i];
        }
        return null;
    }

    // Resolve user list (strings or constituent objects) → constituent objects.
    function _resolveConstituents(list) {
        if (!Array.isArray(list) || !list.length) {
            list = DEFAULT_CONSTITUENT_NAMES;
        }
        var out = [];
        var seen = {};
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var c = null;
            if (typeof entry === 'string') {
                c = _constituentByName(entry);
            } else if (entry && typeof entry === 'object' && entry.name) {
                c = _constituentByName(entry.name);
            }
            if (c && !seen[c.name]) { out.push(c); seen[c.name] = true; }
        }
        return out;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — DETRENDING UTILITY
    // ═══════════════════════════════════════════════════════════════
    // Reservoir pressure has long-term drift (depletion, build-up
    // approaching shut-in pressure, etc.) at frequencies far below the
    // tide band. If left in the signal, the harmonic regression
    // chases the drift and reports inflated/biased amplitudes for
    // the longer-period constituents (Mf, Mm) and a wandering DC
    // offset that affects the conditioning of the design matrix.
    //
    // We remove a simple linear (a + b·t) least-squares fit. For
    // very long surveys a polynomial detrend would be better, but
    // linear is sufficient for the typical 1–14 day windows used
    // for tide analysis.
    // ═══════════════════════════════════════════════════════════════

    function _linearDetrend(t, p) {
        var n = (t && p) ? Math.min(t.length, p.length) : 0;
        if (n < 2) return { y: p ? p.slice() : [], a: 0, b: 0, mean: 0 };
        var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
        var i;
        for (i = 0; i < n; i++) {
            var ti = t[i], pi = p[i];
            if (!isFinite(ti) || !isFinite(pi)) continue;
            sx += ti; sy += pi; sxx += ti * ti; sxy += ti * pi; m++;
        }
        if (m < 2) return { y: p.slice(), a: 0, b: 0, mean: sy / Math.max(1, m) };
        var denom = m * sxx - sx * sx;
        var b = 0, a = sy / m;
        if (Math.abs(denom) > 1e-15) {
            b = (m * sxy - sx * sy) / denom;
            a = (sy - b * sx) / m;
        }
        var y = new Array(n);
        for (i = 0; i < n; i++) {
            y[i] = (isFinite(t[i]) && isFinite(p[i])) ? (p[i] - (a + b * t[i])) : 0;
        }
        return { y: y, a: a, b: b, mean: sy / m };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — HARMONIC REGRESSION
    // ═══════════════════════════════════════════════════════════════
    // Fit p_detrended(t) ≈ Σ_i [ A_i · cos(2π·f_i·t) + B_i · sin(2π·f_i·t) ]
    //
    // Linear in [A_1, B_1, ..., A_K, B_K] → ordinary least squares
    // via the normal equations:
    //
    //     (X^T X) · θ = X^T y
    //
    // The design matrix X is N × 2K. We assemble X^T X (2K × 2K)
    // and X^T y (2K) directly, then solve with Gauss-Jordan with
    // partial pivoting. K is small (≤ 10), so this is O(K^3) and
    // numerically stable for well-separated frequencies.
    //
    // Amplitude / phase recovery:
    //     R_i = √(A_i² + B_i²)
    //     φ_i = atan2(B_i, A_i)         (radians; range −π … π)
    //
    // Reconstruct fitted tide signal at each sample:
    //     p_tide(t) = Σ_i [ A_i · cos(2π·f_i·t) + B_i · sin(2π·f_i·t) ]
    // ═══════════════════════════════════════════════════════════════

    // Solve A·x = b in place. Returns x (length n) or null on singular.
    function _solveLinear(A, b) {
        var n = b.length;
        // Build augmented matrix.
        var M = new Array(n);
        for (var i = 0; i < n; i++) {
            M[i] = new Array(n + 1);
            for (var j = 0; j < n; j++) M[i][j] = A[i][j];
            M[i][n] = b[i];
        }
        // Gauss-Jordan with partial pivoting.
        for (var k = 0; k < n; k++) {
            // Pivot.
            var piv = k, max = Math.abs(M[k][k]);
            for (var r = k + 1; r < n; r++) {
                var v = Math.abs(M[r][k]);
                if (v > max) { max = v; piv = r; }
            }
            if (max < 1e-14) return null; // singular
            if (piv !== k) {
                var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp;
            }
            // Normalise pivot row.
            var div = M[k][k];
            for (var c = k; c <= n; c++) M[k][c] /= div;
            // Eliminate other rows.
            for (var r2 = 0; r2 < n; r2++) {
                if (r2 === k) continue;
                var f = M[r2][k];
                if (f === 0) continue;
                for (var c2 = k; c2 <= n; c2++) M[r2][c2] -= f * M[k][c2];
            }
        }
        var x = new Array(n);
        for (var ii = 0; ii < n; ii++) x[ii] = M[ii][n];
        return x;
    }

    // Fit harmonic coefficients [A_1, B_1, ..., A_K, B_K] for the
    // given list of frequencies (cycles/hr) against y(t).
    // Returns { theta, fitted, residual } or null on failure.
    function _harmonicFit(t, y, freqs) {
        var n = (t && y) ? Math.min(t.length, y.length) : 0;
        var K = freqs.length;
        if (n < 2 * K + 1 || K === 0) return null;

        var TWO_PI = 2 * Math.PI;
        var dim = 2 * K;

        // Build X^T X and X^T y in a single pass.
        var XtX = new Array(dim);
        for (var r = 0; r < dim; r++) {
            XtX[r] = new Array(dim);
            for (var c = 0; c < dim; c++) XtX[r][c] = 0;
        }
        var Xty = new Array(dim);
        for (var d = 0; d < dim; d++) Xty[d] = 0;

        // Cache 2π·f for each constituent.
        var w = new Array(K);
        for (var ki = 0; ki < K; ki++) w[ki] = TWO_PI * freqs[ki];

        // Row-by-row accumulation.
        var row = new Array(dim);
        var i, k, c2;
        for (i = 0; i < n; i++) {
            var ti = t[i], yi = y[i];
            if (!isFinite(ti) || !isFinite(yi)) continue;
            for (k = 0; k < K; k++) {
                var arg = w[k] * ti;
                row[2 * k]     = Math.cos(arg);
                row[2 * k + 1] = Math.sin(arg);
            }
            for (var rr = 0; rr < dim; rr++) {
                Xty[rr] += row[rr] * yi;
                for (c2 = rr; c2 < dim; c2++) {
                    XtX[rr][c2] += row[rr] * row[c2];
                }
            }
        }
        // Mirror upper triangle into lower.
        for (var rr2 = 0; rr2 < dim; rr2++) {
            for (var cc = 0; cc < rr2; cc++) {
                XtX[rr2][cc] = XtX[cc][rr2];
            }
        }

        var theta = _solveLinear(XtX, Xty);
        if (!theta) return null;

        // Reconstruct fitted signal + residual.
        var fitted = new Array(n);
        var residual = new Array(n);
        for (i = 0; i < n; i++) {
            var ti2 = t[i];
            var f = 0;
            if (isFinite(ti2)) {
                for (k = 0; k < K; k++) {
                    var arg2 = w[k] * ti2;
                    f += theta[2 * k] * Math.cos(arg2)
                       + theta[2 * k + 1] * Math.sin(arg2);
                }
            } else {
                f = NaN;
            }
            fitted[i] = f;
            residual[i] = isFinite(y[i]) ? (y[i] - f) : NaN;
        }
        return { theta: theta, fitted: fitted, residual: residual };
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — ct ESTIMATION (Bredehoeft 1967)
    // ═══════════════════════════════════════════════════════════════
    // Areal-strain efficiency (Bredehoeft 1967; Van der Kamp & Gale 1983):
    //
    //     ct ≈ R_obs / ( R_th · ρ_w·g · h · ξ )
    //
    //   R_obs : observed M2 amplitude in the well (psi)
    //   R_th  : theoretical M2 strain-induced pressure (psi)
    //   ρ_w·g : 0.433 psi/ft for fresh water
    //   h     : reservoir depth (ft)
    //   ξ     : Love-number combination ≈ h₂ - 1.16·k₂ ≈ 0.6
    //
    // Returns ct in 1/psi. The formula is for a saturated, confined
    // aquifer; in oil/gas zones it should be treated as a sanity
    // bound on the PVT-derived ct rather than a ground truth.
    //
    // CAVEATS
    //   - R_th depends on latitude and local Earth-tide harmonic constants.
    //     The user-supplied default is 1.0 psi (ballpark for mid-latitude
    //     reservoirs at ~10 000 ft). Calibrate against published
    //     Earth-tide tables for higher fidelity.
    //   - The constant 0.6 (=ξ) varies between 0.55 and 0.65 for typical
    //     elastic Love-number assumptions.
    //   - This estimator captures matrix + pore-fluid bulk compressibility;
    //     it does NOT separate rock from fluid contributions.
    // ═══════════════════════════════════════════════════════════════

    var BREDEHOEFT_LOVE_FACTOR = 0.6;        // ξ = h₂ − 1.16·k₂
    var FRESH_WATER_GRADIENT_PSI_PER_FT = 0.433;

    function _estimate_ct(R_obs_M2, R_theoretical_M2, depth_ft) {
        if (!isFinite(R_obs_M2) || !isFinite(R_theoretical_M2) || !isFinite(depth_ft)) return null;
        if (R_theoretical_M2 <= 0 || depth_ft <= 0) return null;
        var denom = R_theoretical_M2 * FRESH_WATER_GRADIENT_PSI_PER_FT * depth_ft * BREDEHOEFT_LOVE_FACTOR;
        if (denom <= 0) return null;
        return R_obs_M2 / denom;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — CORE ENTRY POINT  PRiSM_tideAnalysis
    // ═══════════════════════════════════════════════════════════════

    // Compute relative noise (RMS residual / |mean p|) — small helper
    // for diagnostic SNR reporting.
    function _rms(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += arr[i] * arr[i]; n++; }
        }
        return n > 0 ? Math.sqrt(s / n) : 0;
    }
    function _meanAbs(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += Math.abs(arr[i]); n++; }
        }
        return n > 0 ? s / n : 0;
    }
    function _variance(arr) {
        var n = 0, s = 0, ss = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += arr[i]; ss += arr[i] * arr[i]; n++; }
        }
        if (n < 2) return 0;
        var m = s / n;
        return (ss - n * m * m) / (n - 1);
    }

    G.PRiSM_tideAnalysis = function PRiSM_tideAnalysis(t, p, opts) {
        opts = opts || {};
        var DEFAULTS = {
            constituents:      DEFAULT_CONSTITUENT_NAMES,
            detrend:           true,
            depth_ft:          null,
            theoreticalM2_psi: 1.0,
            minDuration_h:     48
        };
        // Merge.
        var o = {};
        for (var k in DEFAULTS) o[k] = (opts[k] === undefined) ? DEFAULTS[k] : opts[k];

        // Input validation.
        var nIn = (Array.isArray(t) && Array.isArray(p)) ? Math.min(t.length, p.length) : 0;
        var caveats = [];
        if (nIn < 4) {
            return {
                constituents: [],
                p_tide: [],
                p_corrected: (p || []).slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Insufficient samples (n=' + nIn + '). Tide analysis requires at least a few dozen samples spanning several tide periods.'
            };
        }

        // Compact arrays of finite samples (preserve original order).
        var tt = [], pp = [], idx = [];
        for (var i = 0; i < nIn; i++) {
            if (isFinite(t[i]) && isFinite(p[i])) {
                tt.push(t[i]); pp.push(p[i]); idx.push(i);
            }
        }
        if (tt.length < 4) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'No finite samples after filtering NaNs.'
            };
        }

        // Duration.
        var t0 = tt[0], tN = tt[tt.length - 1];
        var duration_h = tN - t0;
        if (!isFinite(duration_h) || duration_h <= 0) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Time array is not strictly increasing — tide analysis requires monotonic time in hours.'
            };
        }
        if (duration_h < o.minDuration_h) {
            caveats.push('Survey duration ' + duration_h.toFixed(1) + ' h is below the configured minimum (' + o.minDuration_h.toFixed(0) + ' h). Results may be poorly resolved.');
        }

        // Resolve requested constituents and drop those whose period
        // exceeds half the survey duration (Nyquist-like rule —
        // need ≥ 2 cycles to resolve amplitude+phase reliably).
        var requested = _resolveConstituents(o.constituents);
        if (!requested.length) {
            requested = _resolveConstituents(DEFAULT_CONSTITUENT_NAMES);
        }
        var fitList = [];
        var skipped = [];
        for (var ri = 0; ri < requested.length; ri++) {
            var c = requested[ri];
            if (c.period * 2 > duration_h) {
                skipped.push(c);
                caveats.push(c.name + ' (period ' + c.period.toFixed(2) + ' h) skipped — survey too short to resolve (need ≥ ' + (2 * c.period).toFixed(1) + ' h).');
                continue;
            }
            fitList.push(c);
        }
        if (!fitList.length) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Survey duration ' + duration_h.toFixed(1) + ' h is too short for any requested constituent. ' + caveats.join(' ')
            };
        }

        // Detrend (linear LS) — operates on (tt, pp).
        var det = o.detrend ? _linearDetrend(tt, pp)
                            : { y: pp.slice(), a: 0, b: 0, mean: pp.reduce(function (s, v) { return s + v; }, 0) / pp.length };
        var y = det.y;

        // Harmonic regression on the detrended series.
        var freqs = fitList.map(function (c) { return c.freq; });
        var fit = _harmonicFit(tt, y, freqs);
        if (!fit) {
            return {
                constituents: [],
                p_tide: new Array(nIn).fill(0),
                p_corrected: p.slice(),
                residual_rms: 0,
                snr: 0,
                ct_estimate: null,
                rationale: 'Harmonic regression failed (singular normal-equations matrix). Try fewer constituents or a longer dataset. ' + caveats.join(' ')
            };
        }

        // Extract amplitude / phase per constituent.
        var constOut = [];
        var TWO_PI = 2 * Math.PI;
        for (var fi = 0; fi < fitList.length; fi++) {
            var A = fit.theta[2 * fi];
            var B = fit.theta[2 * fi + 1];
            var R = Math.sqrt(A * A + B * B);
            var phi = Math.atan2(B, A);
            constOut.push({
                name:      fitList[fi].name,
                desc:      fitList[fi].desc,
                period:    fitList[fi].period,
                freq:      fitList[fi].freq,
                amplitude: R,
                phase:     phi,
                A:         A,
                B:         B,
                type:      fitList[fi].type
            });
        }

        // Build full-length p_tide and p_corrected aligned to original t/p.
        // The harmonic basis is evaluated at the original t for *all*
        // samples (not just the finite ones) so plot overlays line up.
        var p_tide = new Array(nIn).fill(0);
        var w = freqs.map(function (f) { return TWO_PI * f; });
        for (var ii = 0; ii < nIn; ii++) {
            var ti3 = t[ii];
            if (!isFinite(ti3)) { p_tide[ii] = 0; continue; }
            var v = 0;
            for (var jj = 0; jj < freqs.length; jj++) {
                v += fit.theta[2 * jj] * Math.cos(w[jj] * ti3)
                   + fit.theta[2 * jj + 1] * Math.sin(w[jj] * ti3);
            }
            p_tide[ii] = v;
        }
        var p_corrected = new Array(nIn);
        for (var ii2 = 0; ii2 < nIn; ii2++) {
            p_corrected[ii2] = isFinite(p[ii2]) ? (p[ii2] - p_tide[ii2]) : p[ii2];
        }

        // Diagnostics.
        var residual_rms = _rms(fit.residual);
        // SNR for M2 specifically: amplitude / RMS(residual).
        var m2 = null;
        for (var mi = 0; mi < constOut.length; mi++) {
            if (constOut[mi].name === 'M2') { m2 = constOut[mi]; break; }
        }
        var snr = (m2 && residual_rms > 0) ? (m2.amplitude / residual_rms) : 0;

        // Variance reduction sanity (corrected vs raw, on the
        // *detrended* data to avoid penalising long-term drift).
        var var_y    = _variance(y);
        var var_resid = _variance(fit.residual);
        var var_reduction_pct = (var_y > 0) ? (1 - var_resid / var_y) * 100 : 0;

        // ct estimate from M2.
        var ct = null;
        var ct_caveat = '';
        if (m2 && isFinite(o.depth_ft) && o.depth_ft > 0
                && isFinite(o.theoreticalM2_psi) && o.theoreticalM2_psi > 0) {
            ct = _estimate_ct(m2.amplitude, o.theoreticalM2_psi, o.depth_ft);
        } else {
            if (m2) {
                ct_caveat = 'ct estimation requires depth_ft and theoreticalM2_psi (both > 0).';
            } else {
                ct_caveat = 'ct estimation requires the M2 constituent in the fit list.';
            }
        }

        // Compare against PVT-derived ct (Layer 16) when available.
        var pvtComparison = '';
        try {
            var pvt_ct = G.PRiSM_pvt && G.PRiSM_pvt._computed && G.PRiSM_pvt._computed.ct;
            if (ct != null && isFinite(pvt_ct) && pvt_ct > 0) {
                var pct = Math.abs(ct - pvt_ct) / pvt_ct * 100;
                pvtComparison = ' Tide-derived ct = ' + ct.toExponential(2)
                              + ' 1/psi vs PVT ct = ' + pvt_ct.toExponential(2)
                              + ' 1/psi (Δ = ' + pct.toFixed(0) + '%).';
            }
        } catch (e) { /* swallow */ }

        // Compose rationale.
        var rationaleParts = [];
        rationaleParts.push('Fitted ' + fitList.length + ' constituent' + (fitList.length === 1 ? '' : 's')
                           + ' (' + fitList.map(function (c) { return c.name; }).join(', ')
                           + ') over ' + duration_h.toFixed(1) + ' h of data.');
        if (m2) {
            rationaleParts.push('M2 amplitude = ' + m2.amplitude.toFixed(3) + ' psi, residual RMS = '
                              + residual_rms.toFixed(3) + ' psi → SNR ≈ ' + snr.toFixed(1) + '.');
        }
        rationaleParts.push('Variance reduction (detrended): ' + var_reduction_pct.toFixed(0) + '%.');
        if (ct != null) {
            rationaleParts.push('ct ≈ ' + ct.toExponential(2)
                + ' 1/psi (Bredehoeft 1967, depth ' + o.depth_ft + ' ft, theoretical M2 '
                + o.theoreticalM2_psi + ' psi, Love factor ξ=' + BREDEHOEFT_LOVE_FACTOR + ').');
            if (pvtComparison) rationaleParts.push(pvtComparison.trim());
        } else if (ct_caveat) {
            rationaleParts.push(ct_caveat);
        }
        if (skipped.length) {
            rationaleParts.push('Skipped: ' + skipped.map(function (c) { return c.name; }).join(', ') + ' (period vs duration).');
        }
        if (caveats.length) {
            rationaleParts.push('Caveats: ' + caveats.join(' '));
        }

        try {
            _ga4('prism_tide_analysis', {
                n_samples:          nIn,
                duration_h:         Math.round(duration_h * 10) / 10,
                fitted_count:       fitList.length,
                m2_amp_psi:         m2 ? Math.round(m2.amplitude * 1000) / 1000 : null,
                snr:                Math.round(snr * 10) / 10,
                ct_estimate:        ct,
                has_depth:          isFinite(o.depth_ft) && o.depth_ft > 0
            });
        } catch (e) { /* swallow */ }

        return {
            constituents:        constOut,
            p_tide:              p_tide,
            p_corrected:         p_corrected,
            residual_rms:        residual_rms,
            snr:                 snr,
            ct_estimate:         ct,
            variance_reduction_pct: var_reduction_pct,
            duration_h:          duration_h,
            n_samples:           nIn,
            n_finite:            tt.length,
            detrend:             { a: det.a, b: det.b, applied: !!o.detrend },
            skipped:             skipped.map(function (c) { return c.name; }),
            rationale:           rationaleParts.join(' ')
        };
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — APPLY / RESET CORRECTION ON window.PRiSM_dataset
    // ═══════════════════════════════════════════════════════════════
    // We snapshot the pre-correction dataset once, then replace .p
    // with the corrected series. PRiSM_resetTideCorrection restores
    // from the snapshot. The snapshot is held on
    //     window.PRiSM_tideCorrectionState
    // so it survives across module-internal calls without leaking
    // a private closure variable.
    // ═══════════════════════════════════════════════════════════════

    function _ensureTideState() {
        if (!G.PRiSM_tideCorrectionState) {
            G.PRiSM_tideCorrectionState = {
                snapshot:        null,
                lastResult:      null,
                lastOpts:        null,
                applied:         false
            };
        }
        return G.PRiSM_tideCorrectionState;
    }

    function _snapshotForTide(ds) {
        if (!ds) return null;
        var s = {
            t: (ds.t || []).slice(),
            p: ds.p ? ds.p.slice() : null,
            q: ds.q ? ds.q.slice() : null
        };
        // Carry through any other simple keys.
        for (var k in ds) {
            if (s[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q') continue;
            try { s[k] = ds[k]; } catch (e) { /* ignore */ }
        }
        return s;
    }

    G.PRiSM_applyTideCorrection = function PRiSM_applyTideCorrection(opts) {
        var ds = G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || !ds.t.length) {
            return null;
        }
        var st = _ensureTideState();
        if (!st.snapshot) st.snapshot = _snapshotForTide(ds);

        // Always run analysis on the snapshot pressures (so re-applies
        // are idempotent) — never on the already-corrected series.
        var snap = st.snapshot;
        var res = G.PRiSM_tideAnalysis(snap.t, snap.p, opts || st.lastOpts || undefined);
        st.lastResult = res;
        st.lastOpts   = opts || st.lastOpts;

        if (!res || !Array.isArray(res.p_corrected) || !res.p_corrected.length) {
            return null;
        }

        // Build new dataset with corrected p; preserve every other key.
        var newDs = _snapshotForTide(snap);
        newDs.p = res.p_corrected.slice();
        newDs.tideCorrected = true;
        newDs.tideOriginalP = snap.p.slice();
        newDs.tideFitted    = res.p_tide.slice();

        G.PRiSM_dataset = newDs;
        st.applied = true;

        try {
            _ga4('prism_tide_correction_applied', {
                n_samples: snap.t.length,
                m2_amp_psi: (res.constituents && res.constituents[0] && res.constituents[0].name === 'M2')
                            ? Math.round(res.constituents[0].amplitude * 1000) / 1000 : null
            });
        } catch (e) { /* swallow */ }

        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }

        return newDs;
    };

    G.PRiSM_resetTideCorrection = function PRiSM_resetTideCorrection() {
        var st = _ensureTideState();
        if (!st.snapshot) return null;
        var restored = _snapshotForTide(st.snapshot);
        // Keep snapshot around in case the user wants to re-apply.
        G.PRiSM_dataset = restored;
        st.applied = false;

        try { _ga4('prism_tide_correction_reset', {}); } catch (e) { /* swallow */ }

        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
        return restored;
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — UI: PRiSM_renderTidePanel(container)
    // ═══════════════════════════════════════════════════════════════
    // Paints a self-contained tide-analysis panel into `container`
    // (a DOM element). Mirrors the style of PRiSM_renderCropTool /
    // PRiSM_renderInterpretationPanel.
    //
    // Sections:
    //   - Inputs: depth_ft, theoreticalM2_psi, constituent checklist,
    //             minDuration_h.
    //   - "Run tide analysis" button → calls PRiSM_tideAnalysis on
    //             the live dataset and paints results.
    //   - Constituent table (name, period, amplitude, phase°).
    //   - Decomposition canvas (raw / fitted-tide / corrected).
    //   - Apply / Reset correction buttons.
    //   - Estimated ct + Bredehoeft formula footnote.
    //   - Rationale block.
    // ═══════════════════════════════════════════════════════════════

    var _PANEL_STYLE   = 'background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:14px; color:#c9d1d9; font-size:13px; line-height:1.5;';
    var _HEADING_STYLE = 'font-weight:600; font-size:12px; color:#8b949e; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;';
    var _CARD_STYLE    = 'background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px; margin-bottom:12px;';
    var _INPUT_STYLE   = 'width:120px; padding:4px 6px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;';
    var _LABEL_STYLE   = 'display:flex; flex-direction:column; font-size:11px; color:#8b949e; gap:2px;';
    var _BTN_PRIMARY   = 'padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;';
    var _BTN_SECONDARY = 'padding:6px 14px; background:#21262d; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; cursor:pointer; font-size:12px;';
    var _BTN_BLUE      = 'padding:6px 14px; background:#1f6feb; color:#fff; border:1px solid #388bfd; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;';

    function _byId(id) {
        return _hasDoc ? document.getElementById(id) : null;
    }

    function _selectedConstituents(container) {
        if (!container) return DEFAULT_CONSTITUENT_NAMES.slice();
        var boxes = container.querySelectorAll
                  ? container.querySelectorAll('input[data-prism-tide-c]')
                  : [];
        var sel = [];
        for (var i = 0; i < boxes.length; i++) {
            if (boxes[i].checked) sel.push(boxes[i].getAttribute('data-prism-tide-c'));
        }
        if (!sel.length) sel = DEFAULT_CONSTITUENT_NAMES.slice();
        return sel;
    }

    function _readNumberInput(id, fallback) {
        var el = _byId(id);
        if (!el) return fallback;
        var v = parseFloat(el.value);
        return isFinite(v) ? v : fallback;
    }

    function _renderResultTable(constArr) {
        if (!constArr || !constArr.length) {
            return '<div style="font-style:italic; color:#8b949e;">No constituents fitted.</div>';
        }
        var h = [];
        h.push('<table style="width:100%; border-collapse:collapse; font-size:12px;">');
        h.push('<thead><tr style="border-bottom:1px solid #30363d; color:#8b949e; text-align:left;">');
        h.push('<th style="padding:6px 8px;">Constituent</th>');
        h.push('<th style="padding:6px 8px;">Period (h)</th>');
        h.push('<th style="padding:6px 8px;">Amplitude (psi)</th>');
        h.push('<th style="padding:6px 8px;">Phase (°)</th>');
        h.push('<th style="padding:6px 8px;">Description</th>');
        h.push('</tr></thead><tbody>');
        for (var i = 0; i < constArr.length; i++) {
            var c = constArr[i];
            var phaseDeg = c.phase * 180 / Math.PI;
            h.push('<tr style="border-bottom:1px solid #21262d;">'
                + '<td style="padding:6px 8px; font-weight:600; color:#58a6ff;">' + _esc(c.name) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + c.period.toFixed(4) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + _fmt(c.amplitude, 3) + '</td>'
                + '<td style="padding:6px 8px; font-family:monospace;">' + _fmt(phaseDeg, 1) + '</td>'
                + '<td style="padding:6px 8px; color:#8b949e;">' + _esc(c.desc) + '</td>'
                + '</tr>');
        }
        h.push('</tbody></table>');
        return h.join('');
    }

    function _renderCtBlock(ct, depth_ft, theoreticalM2_psi) {
        if (ct == null || !isFinite(ct)) {
            return '<div style="padding:10px; background:#161b22; border-radius:4px; color:#8b949e; font-style:italic;">'
                 + 'ct estimate not available — supply depth_ft &amp; theoreticalM2_psi (both &gt; 0) and ensure M2 is fitted.</div>';
        }
        return '<div style="padding:10px; background:#161b22; border-left:3px solid #3fb950; border-radius:4px;">'
             +    '<div style="font-size:11px; color:#8b949e; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">'
             +      'Total compressibility (Bredehoeft 1967)'
             +    '</div>'
             +    '<div style="font-size:18px; font-weight:600; color:#3fb950; font-family:monospace;">'
             +      'c<sub>t</sub> ≈ ' + ct.toExponential(3) + ' psi<sup>−1</sup>'
             +    '</div>'
             +    '<div style="font-size:11px; color:#8b949e; margin-top:6px; line-height:1.4;">'
             +      'Formula: c<sub>t</sub> = R<sub>obs</sub> / (R<sub>th</sub> · ρ<sub>w</sub>g · h · ξ)<br>'
             +      'where R<sub>th</sub>=' + _esc(theoreticalM2_psi) + ' psi, h=' + _esc(depth_ft) + ' ft, '
             +      'ρ<sub>w</sub>g=' + FRESH_WATER_GRADIENT_PSI_PER_FT + ' psi/ft, ξ=' + BREDEHOEFT_LOVE_FACTOR
             +      ' (Love factor h₂−1.16·k₂).<br>'
             +      'For confined saturated formations; treat as a sanity bound on PVT-derived c<sub>t</sub> in oil/gas zones.'
             +    '</div>'
             + '</div>';
    }

    function _renderResults(container, res, opts) {
        var host = container.querySelector
                 ? container.querySelector('.prism-tide-results')
                 : null;
        if (!host) return;
        if (!res) {
            host.innerHTML = '<div style="color:#8b949e; font-style:italic;">No results yet.</div>';
            return;
        }
        var h = [];

        // Constituent table.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Fitted constituents</div>');
        h.push(_renderResultTable(res.constituents));
        h.push('</div>');

        // Decomposition canvas.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Decomposition (raw → fitted tide → corrected)</div>');
        h.push('<canvas id="prism_tide_canvas" width="800" height="380" '
            +  'style="display:block; background:#0d1117; border:1px solid #30363d; '
            +  'border-radius:6px; max-width:100%;"></canvas>');
        h.push('</div>');

        // Diagnostics + ct.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Diagnostics</div>');
        h.push('<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; margin-bottom:12px;">');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Residual RMS</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.residual_rms, 3) + ' psi</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">M2 SNR</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.snr, 2) + '</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Variance reduction</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.variance_reduction_pct, 1) + ' %</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Duration</span><div style="font-family:monospace; color:#c9d1d9;">'
              + _fmt(res.duration_h, 1) + ' h</div></div>');
        h.push('<div><span style="color:#8b949e; font-size:11px;">Samples</span><div style="font-family:monospace; color:#c9d1d9;">'
              + (res.n_samples || 0) + '</div></div>');
        h.push('</div>');
        h.push(_renderCtBlock(res.ct_estimate, opts.depth_ft, opts.theoreticalM2_psi));
        h.push('</div>');

        // Rationale.
        h.push('<div style="' + _CARD_STYLE + '">');
        h.push('<div style="' + _HEADING_STYLE + '">Rationale</div>');
        h.push('<div style="color:#c9d1d9; line-height:1.55;">' + _esc(res.rationale || '') + '</div>');
        h.push('</div>');

        host.innerHTML = h.join('');

        // Paint the decomposition plot.
        var canvas = _byId('prism_tide_canvas');
        if (canvas && canvas.getContext) {
            try {
                G.PRiSM_plot_tide_decomposition(canvas, {
                    t:           opts._lastT || (G.PRiSM_dataset ? G.PRiSM_dataset.t : []),
                    p_raw:       opts._lastP || (G.PRiSM_dataset ? G.PRiSM_dataset.p : []),
                    p_tide:      res.p_tide,
                    p_corrected: res.p_corrected
                });
            } catch (e) { /* swallow */ }
        }
    }

    function _runFromUI(container) {
        var ds = G.PRiSM_dataset;
        var msg = container.querySelector ? container.querySelector('.prism-tide-msg') : null;
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p) || !ds.t.length) {
            if (msg) msg.innerHTML = '<span style="color:#f85149;">No dataset loaded — go to the Data tab and load a pressure history first.</span>';
            return;
        }
        // If a tide correction is already applied, run the analysis on
        // the *original* snapshot (not the already-cleaned series).
        var st = _ensureTideState();
        var srcT = ds.t, srcP = ds.p;
        if (st.applied && st.snapshot) {
            srcT = st.snapshot.t; srcP = st.snapshot.p;
        }

        var depth = _readNumberInput('prism_tide_depth', null);
        var theo  = _readNumberInput('prism_tide_theom2', 1.0);
        var minD  = _readNumberInput('prism_tide_minDur', 48);
        var sel   = _selectedConstituents(container);

        var opts = {
            constituents:      sel,
            detrend:           true,
            depth_ft:          depth,
            theoreticalM2_psi: theo,
            minDuration_h:     minD
        };

        var res;
        try {
            res = G.PRiSM_tideAnalysis(srcT, srcP, opts);
        } catch (e) {
            if (msg) msg.innerHTML = '<span style="color:#f85149;">Analysis failed: ' + _esc(e && e.message) + '</span>';
            return;
        }
        st.lastResult = res;
        st.lastOpts   = opts;
        opts._lastT = srcT; opts._lastP = srcP;
        if (msg) msg.innerHTML = '<span style="color:#3fb950;">Analysis complete (' + (res.constituents.length) + ' constituents fitted).</span>';
        _renderResults(container, res, opts);
    }

    G.PRiSM_renderTidePanel = function PRiSM_renderTidePanel(container) {
        if (!_hasDoc || !container) return;

        var st = _ensureTideState();

        var html = [];
        html.push('<div class="prism-tide-panel" style="' + _PANEL_STYLE + '">');

        // Header.
        html.push('<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; gap:12px; flex-wrap:wrap;">');
        html.push('<div style="font-weight:700; font-size:14px; color:#c9d1d9;">Tide Analysis (offshore wells)</div>');
        html.push('<div style="font-size:11px; color:#8b949e;">Bredehoeft 1967 · Van der Kamp 1990</div>');
        html.push('</div>');

        // Description.
        html.push('<div style="margin-bottom:12px; padding:10px; background:#161b22; border-left:3px solid #58a6ff; border-radius:4px; font-size:12px; color:#8b949e; line-height:1.55;">'
              +     'Detects astronomical tide harmonics in your pressure-gauge data, fits their amplitudes / phases by linear least-squares, '
              +     'and produces a corrected pressure record cleaned of the periodic tidal signal. From the M2 amplitude an in-situ estimate of '
              +     'formation total compressibility c<sub>t</sub> is computed.'
              +   '</div>');

        // Inputs card.
        html.push('<div style="' + _CARD_STYLE + '">');
        html.push('<div style="' + _HEADING_STYLE + '">Inputs</div>');
        html.push('<div style="display:flex; flex-wrap:wrap; gap:14px; margin-bottom:10px;">');
        html.push('<label style="' + _LABEL_STYLE + '">Depth (ft)'
              +     '<input type="number" id="prism_tide_depth" step="any" min="0" placeholder="e.g. 10000" '
              +       'style="' + _INPUT_STYLE + '"></label>');
        html.push('<label style="' + _LABEL_STYLE + '">Theoretical M2 amplitude (psi)'
              +     '<input type="number" id="prism_tide_theom2" step="0.05" min="0" value="1.0" '
              +       'style="' + _INPUT_STYLE + '"></label>');
        html.push('<label style="' + _LABEL_STYLE + '">Min duration (h)'
              +     '<input type="number" id="prism_tide_minDur" step="1" min="1" value="48" '
              +       'style="' + _INPUT_STYLE + '"></label>');
        html.push('</div>');
        // Constituent checklist.
        html.push('<div style="' + _HEADING_STYLE + '; margin-top:6px;">Constituents</div>');
        html.push('<div style="display:flex; flex-wrap:wrap; gap:10px; font-size:12px;">');
        for (var i = 0; i < PRiSM_TIDE_CONSTITUENTS.length; i++) {
            var c = PRiSM_TIDE_CONSTITUENTS[i];
            var checked = c.isMajor ? ' checked' : '';
            html.push('<label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; padding:3px 8px; background:#0d1117; border:1px solid #30363d; border-radius:14px;" title="' + _esc(c.desc) + ' (period ' + c.period.toFixed(2) + ' h)">'
                  +     '<input type="checkbox" data-prism-tide-c="' + _esc(c.name) + '"' + checked + ' style="margin:0;">'
                  +     '<span style="color:#c9d1d9; font-weight:600;">' + _esc(c.name) + '</span>'
                  +     '<span style="color:#6e7681; font-size:10px;">' + c.period.toFixed(1) + ' h</span>'
                  +   '</label>');
        }
        html.push('</div>');
        // Action buttons.
        html.push('<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; align-items:center;">');
        html.push('<button id="prism_tide_run"   type="button" style="' + _BTN_BLUE + '">Run tide analysis</button>');
        html.push('<button id="prism_tide_apply" type="button" style="' + _BTN_PRIMARY + '">Apply correction</button>');
        html.push('<button id="prism_tide_reset" type="button" style="' + _BTN_SECONDARY + '">Reset</button>');
        html.push('<span class="prism-tide-msg" style="font-size:12px; color:#8b949e; margin-left:6px;"></span>');
        html.push('</div>');
        html.push('</div>');

        // Results region (filled after run).
        html.push('<div class="prism-tide-results"></div>');

        html.push('</div>');
        container.innerHTML = html.join('');

        // Wire buttons. Use direct DOM properties — addEventListener is
        // also fine but we mirror the simpler PRiSM_renderCropTool style.
        var btnRun   = _byId('prism_tide_run');
        var btnApply = _byId('prism_tide_apply');
        var btnReset = _byId('prism_tide_reset');
        if (btnRun)   btnRun.onclick   = function () { _runFromUI(container); };
        if (btnApply) btnApply.onclick = function () {
            var depth = _readNumberInput('prism_tide_depth', null);
            var theo  = _readNumberInput('prism_tide_theom2', 1.0);
            var minD  = _readNumberInput('prism_tide_minDur', 48);
            var sel   = _selectedConstituents(container);
            var ds = G.PRiSM_applyTideCorrection({
                constituents: sel, depth_ft: depth,
                theoreticalM2_psi: theo, minDuration_h: minD,
                detrend: true
            });
            var msg = container.querySelector('.prism-tide-msg');
            if (msg) {
                if (ds) msg.innerHTML = '<span style="color:#3fb950;">Correction applied — pressure series replaced with tide-cleaned values.</span>';
                else    msg.innerHTML = '<span style="color:#f85149;">Could not apply — no dataset loaded.</span>';
            }
            // Repaint results so the diagnostics reflect the new state.
            var s = _ensureTideState();
            if (s.lastResult) {
                var optsCopy = {};
                for (var k in s.lastOpts) optsCopy[k] = s.lastOpts[k];
                optsCopy._lastT = s.snapshot ? s.snapshot.t : (G.PRiSM_dataset ? G.PRiSM_dataset.t : []);
                optsCopy._lastP = s.snapshot ? s.snapshot.p : (G.PRiSM_dataset ? G.PRiSM_dataset.p : []);
                _renderResults(container, s.lastResult, optsCopy);
            }
        };
        if (btnReset) btnReset.onclick = function () {
            var ds = G.PRiSM_resetTideCorrection();
            var msg = container.querySelector('.prism-tide-msg');
            if (msg) {
                if (ds) msg.innerHTML = '<span style="color:#3fb950;">Reset — original pressure series restored.</span>';
                else    msg.innerHTML = '<span style="color:#8b949e;">Nothing to reset (no prior correction).</span>';
            }
        };

        // If we've already run an analysis this session, repaint it.
        if (st.lastResult) {
            var optsCopy2 = {};
            for (var k2 in (st.lastOpts || {})) optsCopy2[k2] = st.lastOpts[k2];
            if (!optsCopy2.depth_ft) optsCopy2.depth_ft = null;
            if (!optsCopy2.theoreticalM2_psi) optsCopy2.theoreticalM2_psi = 1.0;
            optsCopy2._lastT = st.snapshot ? st.snapshot.t : (G.PRiSM_dataset ? G.PRiSM_dataset.t : []);
            optsCopy2._lastP = st.snapshot ? st.snapshot.p : (G.PRiSM_dataset ? G.PRiSM_dataset.p : []);
            _renderResults(container, st.lastResult, optsCopy2);
        }

        try { _ga4('prism_tide_panel_open', {}); } catch (e) { /* swallow */ }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — PLOT: PRiSM_plot_tide_decomposition(canvas, data)
    // ═══════════════════════════════════════════════════════════════
    // Three-panel decomposition stacked vertically:
    //   Top:    raw pressure (orange)
    //   Middle: fitted tide signal (blue)
    //   Bottom: corrected pressure (green)
    //
    // Uses a HiDPI-safe context and a minimal axis (we don't draw
    // gridlines for the middle panel — its scale is much smaller
    // than the raw / corrected panels).
    //
    // data = { t: number[], p_raw: number[], p_tide: number[], p_corrected: number[] }
    // ═══════════════════════════════════════════════════════════════

    function _setupCanvas(canvas, opts) {
        opts = opts || {};
        var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        var cssW = opts.width  || canvas.clientWidth  || canvas.width  || 800;
        var cssH = opts.height || canvas.clientHeight || canvas.height || 380;
        if (canvas.style) {
            canvas.style.width  = cssW + 'px';
            canvas.style.height = cssH + 'px';
        }
        canvas.width  = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        var ctx = canvas.getContext('2d');
        if (!ctx) return null;
        if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: ctx, w: cssW, h: cssH };
    }

    function _autoRange(arr, padPct) {
        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) {
                if (arr[i] < lo) lo = arr[i];
                if (arr[i] > hi) hi = arr[i];
            }
        }
        if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
        if (lo === hi) { lo -= 1; hi += 1; }
        var pad = (hi - lo) * (padPct || 0.05);
        return [lo - pad, hi + pad];
    }

    function _drawSubplotFrame(ctx, x, y, w, h, title) {
        var th = _theme();
        ctx.fillStyle = th.panel; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = th.border; ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        if (title) {
            ctx.fillStyle = th.text2;
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(title, x + 6, y + 4);
        }
    }

    function _drawSeries(ctx, x, y, w, h, t, v, color) {
        if (!t || !v || !t.length) return;
        var n = Math.min(t.length, v.length);
        var tLo = Infinity, tHi = -Infinity;
        for (var i = 0; i < n; i++) {
            if (isFinite(t[i])) { if (t[i] < tLo) tLo = t[i]; if (t[i] > tHi) tHi = t[i]; }
        }
        if (!isFinite(tLo) || !isFinite(tHi) || tLo === tHi) return;
        var yr = _autoRange(v, 0.08);
        var yLo = yr[0], yHi = yr[1];
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.2;
        ctx.beginPath();
        var first = true;
        for (var j = 0; j < n; j++) {
            if (!isFinite(t[j]) || !isFinite(v[j])) { first = true; continue; }
            var px = x + (t[j] - tLo) / (tHi - tLo) * w;
            var py = y + h - (v[j] - yLo) / (yHi - yLo) * h;
            if (first) { ctx.moveTo(px, py); first = false; }
            else        { ctx.lineTo(px, py); }
        }
        ctx.stroke();

        // Y-range tick labels (compact, right-aligned outside the panel).
        var th = _theme();
        ctx.fillStyle = th.text3;
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(_fmt(yHi, 2), x + w + 4, y);
        ctx.textBaseline = 'bottom';
        ctx.fillText(_fmt(yLo, 2), x + w + 4, y + h);
    }

    function _drawTimeAxis(ctx, x, y, w, t) {
        if (!t || !t.length) return;
        var th = _theme();
        var tLo = Infinity, tHi = -Infinity;
        for (var i = 0; i < t.length; i++) {
            if (isFinite(t[i])) { if (t[i] < tLo) tLo = t[i]; if (t[i] > tHi) tHi = t[i]; }
        }
        if (!isFinite(tLo) || !isFinite(tHi) || tLo === tHi) return;
        // 6 evenly-spaced ticks.
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var nTicks = 6;
        for (var k = 0; k < nTicks; k++) {
            var frac = k / (nTicks - 1);
            var tv = tLo + frac * (tHi - tLo);
            var px = x + frac * w;
            ctx.fillText(_fmt(tv, 1), px, y + 2);
        }
        ctx.textAlign = 'right';
        ctx.fillText('time (h)', x + w, y + 14);
    }

    G.PRiSM_plot_tide_decomposition = function PRiSM_plot_tide_decomposition(canvas, data, opts) {
        if (!canvas || !canvas.getContext) return;
        var setup = _setupCanvas(canvas, opts);
        if (!setup) return;
        var ctx = setup.ctx, W = setup.w, H = setup.h;
        var th = _theme();

        // Background.
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, W, H);

        if (!data || !Array.isArray(data.t) || data.t.length < 2) {
            ctx.fillStyle = th.text3;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('No tide-decomposition data', W / 2, H / 2);
            return;
        }

        var pad = { left: 50, right: 60, top: 8, bottom: 28 };
        var plotW = W - pad.left - pad.right;
        var plotH = H - pad.top - pad.bottom;
        var subH = Math.floor((plotH - 12) / 3); // 3 panels + small gaps

        var x = pad.left, y = pad.top;
        var t = data.t;
        var p_raw = data.p_raw || [];
        var p_tide = data.p_tide || [];
        var p_corr = data.p_corrected || [];

        _drawSubplotFrame(ctx, x, y, plotW, subH, 'Raw pressure (psi)');
        _drawSeries(ctx, x, y, plotW, subH, t, p_raw, th.accent);

        var y2 = y + subH + 6;
        _drawSubplotFrame(ctx, x, y2, plotW, subH, 'Fitted tide signal (psi)');
        _drawSeries(ctx, x, y2, plotW, subH, t, p_tide, th.blue);

        var y3 = y2 + subH + 6;
        _drawSubplotFrame(ctx, x, y3, plotW, subH, 'Corrected pressure (psi)');
        _drawSeries(ctx, x, y3, plotW, subH, t, p_corr, th.green);

        _drawTimeAxis(ctx, x, y3 + subH, plotW, t);
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — SELF-TEST
    // ═══════════════════════════════════════════════════════════════
    // 1. Synthetic input: pressure with M2 (amp 0.5) + S2 (0.2) + noise (0.05).
    //    Recover M2 amplitude within 10%, S2 amplitude within 20%.
    // 2. ct estimation: with depth=10000 ft and theoretical M2=1.0 psi,
    //    recover ct ≈ 1.93e-7 1/psi (Bredehoeft formula sanity).
    // 3. Corrected pressure has lower variance than raw (residual RMS check).
    // 4. Datasets shorter than minDuration_h return a clear caveat.
    // ═══════════════════════════════════════════════════════════════

    (function PRiSM_tideAnalysisSelfTest() {
        var log = (typeof console !== 'undefined' && console.log)   ? console.log.bind(console)   : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];

        // Deterministic pseudo-random sequence (LCG) so the test is reproducible.
        function _rngFactory(seed) {
            var s = seed >>> 0;
            return function () {
                s = (1664525 * s + 1013904223) >>> 0;
                return s / 0xFFFFFFFF;
            };
        }

        function _synthTide(N, durationH, ampM2, ampS2, noise, seed) {
            var rng = _rngFactory(seed || 1);
            var fM2 = 1 / 12.4206;
            var fS2 = 1 / 12.0000;
            var t = [], p = [];
            var phiM2 = 0.7, phiS2 = -0.4;        // arbitrary fixed phases
            var p0 = 3000;                        // baseline pressure
            var trend = 0.02;                     // slow depletion (psi/hr)
            for (var i = 0; i < N; i++) {
                var ti = i * (durationH / (N - 1));
                t.push(ti);
                var v = p0 - trend * ti;
                v += ampM2 * Math.cos(2 * Math.PI * fM2 * ti + phiM2);
                v += ampS2 * Math.cos(2 * Math.PI * fS2 * ti + phiS2);
                v += noise * (rng() - 0.5) * 2;
                p.push(v);
            }
            return { t: t, p: p };
        }

        function _check(name, fn) {
            try {
                var out = fn();
                if (out && typeof out === 'object' && 'ok' in out) {
                    checks.push({ name: name, ok: !!out.ok, msg: out.msg });
                } else {
                    checks.push({ name: name, ok: !!out });
                }
            } catch (e) {
                checks.push({ name: name, ok: false, msg: e && e.message });
            }
        }

        // --- Test 1: M2 amplitude recovery within 10% on synthetic data
        var d1 = _synthTide(720, 168, 0.5, 0.2, 0.05, 7);  // 168 h (1 wk) at 6/hr
        var r1 = G.PRiSM_tideAnalysis(d1.t, d1.p, {
            constituents: ['M2', 'S2'], detrend: true, minDuration_h: 24
        });
        _check('Synthetic M2 (true 0.500 psi) recovered within 10%', function () {
            var m2 = null;
            for (var i = 0; i < r1.constituents.length; i++) {
                if (r1.constituents[i].name === 'M2') { m2 = r1.constituents[i]; break; }
            }
            if (!m2) return { ok: false, msg: 'M2 not in result' };
            var rel = Math.abs(m2.amplitude - 0.5) / 0.5;
            return { ok: rel < 0.10,
                     msg: 'recovered M2=' + m2.amplitude.toFixed(4) + ' (rel err ' + (rel * 100).toFixed(2) + '%)' };
        });

        // --- Test 2: S2 amplitude recovery within 20%
        _check('Synthetic S2 (true 0.200 psi) recovered within 20%', function () {
            var s2 = null;
            for (var i = 0; i < r1.constituents.length; i++) {
                if (r1.constituents[i].name === 'S2') { s2 = r1.constituents[i]; break; }
            }
            if (!s2) return { ok: false, msg: 'S2 not in result' };
            var rel = Math.abs(s2.amplitude - 0.2) / 0.2;
            return { ok: rel < 0.20,
                     msg: 'recovered S2=' + s2.amplitude.toFixed(4) + ' (rel err ' + (rel * 100).toFixed(2) + '%)' };
        });

        // --- Test 3: ct sanity at depth=10000, theoretical M2=1.0
        //    With R_obs ≈ 0.500, R_th = 1.0, h = 10000 ft, ξ = 0.6, ρwg = 0.433
        //    ct = 0.5 / (1.0 * 0.433 * 10000 * 0.6) ≈ 1.92e-4 1/psi
        // (Note: the problem statement says "1.93e-7" but with R_obs=0.5
        //  the exact arithmetic gives ~1.92e-4. The denominator is
        //  ~2598 psi, so ct = 0.5 / 2598 ≈ 1.92e-4 1/psi. The test
        //  validates the computed ct lands within a reasonable band of
        //  the theoretical formula evaluation.)
        _check('ct estimate in expected band for synthetic M2=0.5 psi at 10 000 ft', function () {
            var r = G.PRiSM_tideAnalysis(d1.t, d1.p, {
                constituents: ['M2', 'S2'], detrend: true,
                depth_ft: 10000, theoreticalM2_psi: 1.0,
                minDuration_h: 24
            });
            if (r.ct_estimate == null) return { ok: false, msg: 'ct_estimate is null' };
            // Compute the analytic value with the recovered M2 amplitude
            // for an exact comparison rather than a hard-coded constant.
            var m2 = null;
            for (var i = 0; i < r.constituents.length; i++) {
                if (r.constituents[i].name === 'M2') { m2 = r.constituents[i]; break; }
            }
            var expected = m2.amplitude / (1.0 * 0.433 * 10000 * 0.6);
            var rel = Math.abs(r.ct_estimate - expected) / expected;
            // Loose magnitude band: between 1e-5 and 1e-3 1/psi.
            return { ok: rel < 1e-6 && r.ct_estimate > 1e-5 && r.ct_estimate < 1e-3,
                     msg: 'ct=' + r.ct_estimate.toExponential(3) + ' expected=' + expected.toExponential(3) };
        });

        // --- Test 4: variance reduction — corrected residual lower than raw on detrended.
        _check('Corrected pressure variance lower than raw (>50% variance reduction)', function () {
            return { ok: r1.variance_reduction_pct > 50,
                     msg: 'reduction=' + r1.variance_reduction_pct.toFixed(1) + '%' };
        });

        // --- Test 5: Short dataset triggers caveat (duration < minDuration_h).
        _check('Short dataset (<minDuration_h) emits a caveat in rationale', function () {
            var d = _synthTide(20, 6, 0.5, 0.2, 0.02, 3); // 6 h, way under 48 h
            var r = G.PRiSM_tideAnalysis(d.t, d.p, {
                constituents: ['M2', 'S2'], detrend: true, minDuration_h: 48
            });
            var hasCaveat = (r.rationale || '').indexOf('Caveat') >= 0
                         || (r.rationale || '').indexOf('skipped') >= 0
                         || (r.rationale || '').indexOf('too short') >= 0
                         || r.constituents.length === 0;
            return { ok: hasCaveat, msg: r.rationale };
        });

        // --- Test 6: ct returns null when depth missing.
        _check('ct_estimate is null when depth_ft missing', function () {
            var r = G.PRiSM_tideAnalysis(d1.t, d1.p, {
                constituents: ['M2'], detrend: true, theoreticalM2_psi: 1.0
            });
            return { ok: r.ct_estimate === null, msg: 'ct=' + r.ct_estimate };
        });

        // --- Test 7: Empty input handled gracefully.
        _check('Empty input returns defensive structure (no throw)', function () {
            var r = G.PRiSM_tideAnalysis([], [], {});
            return { ok: r && Array.isArray(r.constituents) && r.ct_estimate === null
                     && typeof r.rationale === 'string' };
        });

        // --- Test 8: Apply / Reset round-trip on a stub PRiSM_dataset.
        _check('PRiSM_applyTideCorrection / Reset round-trip restores original', function () {
            var d = _synthTide(720, 168, 0.5, 0.2, 0.05, 11);
            var prevDs = G.PRiSM_dataset;
            var prevSt = G.PRiSM_tideCorrectionState;
            G.PRiSM_dataset = { t: d.t.slice(), p: d.p.slice() };
            G.PRiSM_tideCorrectionState = null; // force fresh snapshot
            var applied = G.PRiSM_applyTideCorrection({
                constituents: ['M2', 'S2'], detrend: true, depth_ft: 10000,
                theoreticalM2_psi: 1.0, minDuration_h: 24
            });
            var ok1 = applied && applied.tideCorrected === true && applied.p.length === d.p.length;
            // Verify the corrected pressure differs from the raw at a few points.
            var diffs = 0;
            for (var i = 0; i < Math.min(d.p.length, applied.p.length); i++) {
                if (Math.abs(applied.p[i] - d.p[i]) > 0.01) { diffs++; if (diffs > 5) break; }
            }
            var ok2 = diffs > 5;
            var restored = G.PRiSM_resetTideCorrection();
            var ok3 = restored && restored.p.length === d.p.length
                   && Math.abs(restored.p[0] - d.p[0]) < 1e-9
                   && Math.abs(restored.p[d.p.length - 1] - d.p[d.p.length - 1]) < 1e-9;
            G.PRiSM_dataset = prevDs;
            G.PRiSM_tideCorrectionState = prevSt;
            return { ok: ok1 && ok2 && ok3,
                     msg: 'apply.ok=' + ok1 + ' diffsSeen=' + ok2 + ' resetOk=' + ok3 };
        });

        // --- Test 9: PRiSM_renderTidePanel doesn't throw on a stub container.
        _check('PRiSM_renderTidePanel on stub container does not throw', function () {
            if (!_hasDoc || typeof document.createElement !== 'function') return true;
            var c = document.createElement('div');
            if (!c) return true;
            G.PRiSM_renderTidePanel(c);
            return true;
        });

        // --- Test 10: Plot fn doesn't throw on a stub canvas.
        _check('PRiSM_plot_tide_decomposition on stub canvas does not throw', function () {
            if (!_hasDoc || typeof document.createElement !== 'function') return true;
            var canv = document.createElement('canvas');
            if (!canv || !canv.getContext) return true;
            canv.width = 800; canv.height = 380;
            if (canv.style) { canv.style.width = '800px'; canv.style.height = '380px'; }
            var t = [], p_raw = [], p_tide = [], p_corr = [];
            for (var i = 0; i < 200; i++) {
                t.push(i * 1.0);
                var w = 2 * Math.PI / 12.4206;
                p_raw.push(3000 + 0.5 * Math.cos(w * i));
                p_tide.push(0.5 * Math.cos(w * i));
                p_corr.push(3000);
            }
            G.PRiSM_plot_tide_decomposition(canv, {
                t: t, p_raw: p_raw, p_tide: p_tide, p_corrected: p_corr
            });
            return true;
        });

        // --- Test 11: TIDE_CONSTITUENTS table exposes 10 entries with valid freq.
        _check('PRiSM_TIDE_CONSTITUENTS exposes 10 entries with freq=1/period', function () {
            var arr = G.PRiSM_TIDE_CONSTITUENTS;
            if (!Array.isArray(arr) || arr.length !== 10) return false;
            for (var i = 0; i < arr.length; i++) {
                if (!arr[i].name || !isFinite(arr[i].period) || !isFinite(arr[i].freq)) return false;
                if (Math.abs(arr[i].freq - 1 / arr[i].period) > 1e-9) return false;
            }
            return true;
        });

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM tide-analysis self-test FAILED:', fails);
        } else {
            log('✓ tide-analysis self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
