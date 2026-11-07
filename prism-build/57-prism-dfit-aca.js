// =============================================================================
// PRiSM — 57-prism-dfit-aca.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT after-closure analysis, the pure pipeline and the results layer (docs/DFIT-PLAN.md §3.3a, §3.6, §4.12, §4.13,
// §4.20, §6.4, §6.6, §6.8, §6.9, §6.10; owner WP3). Shapes: prism-build/tests/_dfit-shapes.js (frozen).
//
// Pure engine: no DOM, no storage, no timers, no events, no Math.random (randomness only from PRiSM_rng(seed), or the
// identical local generator when 05's export is absent). Every cross-file call (56, 58, 49-calc-dfit-triage,
// WTS_wellbore, PRiSM_lm, PRiSM_mpTable, PRiSM_gasPseudoTime, PRiSM_MODELS, PRiSM_autoInterp) is resolved at call time
// behind a typeof guard. Public functions never throw: they return {ok:false, code, errors, bad}.
//
// Units (§3.0): time in hours (record clock t; injection clock tInj = t − tStart; AcaResult.t0 / tcInj / diag.x on the
// injection clock, x = tInj − t0), pressure psia, V bbl, rates in DFIT objects bbl/min, leak rates bbl/d, k md,
// kh/μ md·ft/cp, μ cp, c_t 1/psi, lengths ft, CL ft/√min.
//
// Sections
//   1  helpers (numbers, warnings, statistics, the O(n) two-pointer Bourdet window, seeded generator, hashes)
//   2  after-closure kernels and constants (PRiSM_dfit_acaKernels — exported for tests, plots and the generator check)
//   3  time functions, centroid, p_i-free diagnosis, Nolte and impulse lines, bounds, p_i consensus
//   4  gas adjustment, constant-rate transform, model-library match
//   5  PRiSM_dfit_aca, leak plot, k constraint
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ═════════════════════════════════════════════════════════════════════
    // 1. Helpers
    // ═════════════════════════════════════════════════════════════════════
    function fin(v) { return typeof v === 'number' && isFinite(v); }
    function pos(v) { return fin(v) && v > 0; }
    function nn(v) { return fin(v) ? v : null; }                      // finite or null (§3.0)
    function rnd(v, dp) { if (!fin(v)) return null; var f = Math.pow(10, dp); return Math.round(v * f) / f; }
    function sig(v, n) { return fin(v) ? +v.toPrecision(n) : null; }
    function fail(code, msg, bad) { return { ok: false, code: code, errors: [String(msg).slice(0, 290)], bad: bad || [] }; }
    function W(code, level, text, ev) { return { code: code, level: level, text: _txt(text), ev: ev || [] }; }
    // plain text < 300 characters without the words the GUI sweep scans for
    function _txt(s) {
        s = String(s == null ? '' : s).replace(/\b(null|undefined|NaN|Infinity)\b/g, '–').replace(/\[object Object\]/g, '–');
        return s.length > 299 ? s.slice(0, 296) + '…' : s;
    }
    function fmt(v, dp) {
        if (!fin(v)) return '–';
        var s = Math.abs(v).toFixed(dp == null ? 0 : dp), parts = s.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (v < 0 && +s !== 0 ? '-' : '') + parts.join('.');
    }
    function fmtSig(v, n) { if (!fin(v)) return '–'; var a = Math.abs(v); return (a !== 0 && (a < 1e-3 || a >= 1e6)) ? v.toExponential(n - 1) : String(+v.toPrecision(n)); }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function arrOk(a) { return Array.isArray(a) || (a && typeof a.length === 'number' && ArrayBuffer.isView && ArrayBuffer.isView(a)); }
    function realFn(f) { return typeof f === 'function' && !f._dfitStub; }

    function sortNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }
    function quant(sorted, f) {                                    // linear interpolation between order statistics
        var n = sorted.length; if (!n) return null; if (n === 1) return sorted[0];
        var h = (n - 1) * f, i = Math.floor(h), j = Math.min(n - 1, i + 1);
        return sorted[i] + (h - i) * (sorted[j] - sorted[i]);
    }
    function median(a) { var f = []; for (var i = 0; i < a.length; i++) if (fin(a[i])) f.push(a[i]); return f.length ? quant(sortNum(f), 0.5) : null; }
    function mean(a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (fin(a[i])) { s += a[i]; n++; } return n ? s / n : null; }
    function wmedian(vals, ws) {
        var it = []; for (var i = 0; i < vals.length; i++) if (fin(vals[i]) && pos(ws[i])) it.push([vals[i], ws[i]]);
        if (!it.length) return null;
        it.sort(function (a, b) { return a[0] - b[0]; });
        var tot = 0, k; for (k = 0; k < it.length; k++) tot += it[k][1];
        var acc = 0; for (k = 0; k < it.length; k++) { acc += it[k][1]; if (acc >= tot / 2 - 1e-12) return it[k][0]; }
        return it[it.length - 1][0];
    }
    // weighted least squares y = b + m·x → {m, b, seM, seB, n, ssr, sigma}
    function linfit(X, Y, Wt) {
        var n = 0, sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, i, w;
        for (i = 0; i < X.length; i++) {
            if (!fin(X[i]) || !fin(Y[i])) continue;
            w = Wt ? Wt[i] : 1; if (!pos(w)) continue;
            n++; sw += w; sx += w * X[i]; sy += w * Y[i]; sxx += w * X[i] * X[i]; sxy += w * X[i] * Y[i];
        }
        if (n < 2) return null;
        var den = sw * sxx - sx * sx; if (!(Math.abs(den) > 1e-300)) return null;
        var m = (sw * sxy - sx * sy) / den, b = (sy - m * sx) / sw, ssr = 0;
        for (i = 0; i < X.length; i++) { if (!fin(X[i]) || !fin(Y[i])) continue; w = Wt ? Wt[i] : 1; if (!pos(w)) continue; var r = Y[i] - b - m * X[i]; ssr += w * r * r; }
        var s2 = n > 2 ? ssr / (n - 2) : 0;
        return { m: m, b: b, seM: Math.sqrt(Math.max(0, s2 * sw / den)), seB: Math.sqrt(Math.max(0, s2 * sxx / den)), n: n, ssr: ssr, sigma: Math.sqrt(s2) };
    }
    // small dense solve (Gauss-Jordan with partial pivoting) → x, or null; also returns the inverse when asked
    function solve(A, b, wantInv) {
        var n = A.length, M = [], i, j, k;
        for (i = 0; i < n; i++) { M.push(A[i].slice()); for (j = 0; j < n; j++) M[i].push(i === j ? 1 : 0); M[i].push(b[i]); }
        for (k = 0; k < n; k++) {
            var piv = k; for (i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
            if (!(Math.abs(M[piv][k]) > 1e-300)) return null;
            var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp;
            var d = M[k][k]; for (j = 0; j < 2 * n + 1; j++) M[k][j] /= d;
            for (i = 0; i < n; i++) if (i !== k) { var f = M[i][k]; if (f !== 0) for (j = 0; j < 2 * n + 1; j++) M[i][j] -= f * M[k][j]; }
        }
        var x = [], inv = []; for (i = 0; i < n; i++) { x.push(M[i][2 * n]); if (wantInv) inv.push(M[i].slice(n, 2 * n)); }
        return wantInv ? { x: x, inv: inv } : x;
    }
    function interp(xs, ys, x) {                                    // xs ascending; linear, clamped at the ends
        var n = xs.length; if (!n) return null;
        if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
        var lo = 0, hi = n - 1; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
        var f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1); return ys[lo] + f * (ys[hi] - ys[lo]);
    }

    // O(n) two-pointer Bourdet window on an ascending log-time axis lx (the PRiSM_compute_bourdet formula, 02): for each i
    // the left point is the nearest j < i with lx_i − lx_j ≥ L (else 0), the right point the nearest j > i with
    // lx_j − lx_i ≥ L (else n − 1); the end points use the one-sided slope over the same window instead of NaN.
    // End points: the slope at the end of a local quadratic fitted over the last (first) 2L of the axis.
    function bourdet(lx, y, L, opsBox, spans) {
        var n = lx.length, d = new Array(n), i1 = 0, i2 = 1, i;
        for (i = 0; i < n; i++) d[i] = NaN;
        if (n < 2) return d;
        for (i = 0; i < n; i++) {
            while (i1 + 1 < i && lx[i] - lx[i1 + 1] >= L) i1++;
            if (i2 <= i) i2 = i + 1;
            while (i2 < n - 1 && lx[i2] - lx[i] < L) i2++;
            if (opsBox) opsBox.n++;
            if (!fin(y[i])) continue;
            if (i === 0 || i === n - 1) { d[i] = _endSlope(lx, y, i, L); continue; }
            var a = i1, b = i2; if (a >= i) a = i - 1;
            if (!fin(y[a]) || !fin(y[b])) continue;
            var dl1 = lx[i] - lx[a], dl2 = lx[b] - lx[i], dlT = lx[b] - lx[a];
            if (!(dl1 > 0) || !(dl2 > 0) || !(dlT > 0)) continue;
            d[i] = (y[i] - y[a]) / dl1 * (dl2 / dlT) + (y[b] - y[i]) / dl2 * (dl1 / dlT);
            if (spans) spans[i] = [dl1, dl2];
        }
        return d;
    }
    function _endSlope(lx, y, i, L) {
        var n = lx.length, sgn = i === 0 ? 1 : -1, U = [], Y = [], j;
        for (j = i; j >= 0 && j < n; j += sgn) { var u = lx[j] - lx[i]; if (Math.abs(u) > 2 * L && U.length >= 3) break; if (fin(y[j])) { U.push(u); Y.push(y[j]); } }
        if (U.length < 2) return NaN;
        if (U.length === 2) return (Y[1] - Y[0]) / (U[1] - U[0]);
        // least-squares polynomial (cubic with ≥ 6 points, else quadratic) in u = lx − lx_end; the slope at u = 0
        var deg = U.length >= 6 ? 3 : 2, m = deg + 1, A = [], b = [], r, c, k;
        for (r = 0; r < m; r++) { A.push([]); b.push(0); for (c = 0; c < m; c++) A[r].push(0); }
        for (k = 0; k < U.length; k++) {
            var pw = [1]; for (r = 1; r < 2 * m; r++) pw.push(pw[r - 1] * U[k]);
            for (r = 0; r < m; r++) { b[r] += pw[r] * Y[k]; for (c = 0; c < m; c++) A[r][c] += pw[r + c]; }
        }
        var sol = solve(A, b);
        return sol ? sol[1] : NaN;
    }
    // window factor of the Bourdet difference on a local power law y ∝ x^s: estimate / truth
    function _winFactor(s, dl1, dl2) {
        if (!fin(s) || Math.abs(s) < 1e-9) return 1;
        var dlT = dl1 + dl2;
        return ((1 - Math.exp(-s * dl1)) / dl1 * (dl2 / dlT) + (Math.exp(s * dl2) - 1) / dl2 * (dl1 / dlT)) / s;
    }

    // Seeded generator: PRiSM_rng (05, WPH) when present, else the same mulberry32 as 05's _makeRng (seed null → 1).
    function makeRng(seed) {
        var s0 = (seed == null || !fin(+seed)) ? 1 : (+seed);
        if (typeof G.PRiSM_rng === 'function') { try { var r = G.PRiSM_rng(s0); if (typeof r === 'function') return r; } catch (e) { /* fall through */ } }
        var s = (s0 | 0) || 1;
        return function () {
            s |= 0; s = (s + 0x6D2B79F5) | 0;
            var t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
        };
    }
    function gauss(r) { var u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

    // Hashes (§3.0 / §3.13): 53's canon + hash16 when present, else a local FNV-1a over JSON (flagged weak by callers).
    function _fnv16(s) {
        var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995, i, c;
        for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0; h2 ^= c + i; h2 = Math.imul(h2, 0x01000193) >>> 0; }
        var a = ('00000000' + (h1 >>> 0).toString(16)).slice(-8), b = ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
        return a + b;
    }
    function hashOf(obj, mode) {
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.canon === 'function' && typeof AI.hash16 === 'function') {
            try { return { h: AI.hash16(AI.canon(obj, mode || 'inputs')), weak: false }; } catch (e) { /* fall through */ }
        }
        var s; try { s = JSON.stringify(obj); } catch (e2) { s = String(obj); }
        return { h: _fnv16(s || ''), weak: true };
    }

    // ═════════════════════════════════════════════════════════════════════
    // 2. Kernels and constants (§4.12)
    // ═════════════════════════════════════════════════════════════════════
    // Every after-closure kernel is Δp = 5.6146·V/(φc_t)·G_d(t) with η_d = 0.0002637·k/(φμc_t) ft²/h:
    //   radial 5.614583/(4π·η_c) = 1,694.5 · V·μ/(kh·t);   linear 5.614583/√(4π·η_c) = 97.54 · (V/A)·√(μ/(kφc_t))/√t
    //   (A = one face of both wings = 2·L·h);  spherical 5.614583/(4π·η_c)^1.5 = 29,437;  bilinear 264.8.
    //   Nolte radial kh/μ = 4·1,694.5/χ · V/(m_R·t_c) = 4,181 (t_c in h) = 250,856 (t_c in min), χ = 16/π².
    //   Linear m_L = 845.5·CL·√(μ/(kφc_t)) with CL in ft/√min (109.15 with ft/√h); k = μ/(φc_t)·(CL/(1.1827e-3·m_L))².
    var KC = {
        etaC: 0.000263679, bbl: 5.614583, unit: 141.2, rad: 1694.5, lin: 97.54, sph: 29437, bil: 264.8,
        khmuH: 4181, khmuMin: 250856, mLmin: 845.5, mLh: 109.15, invmL: 1.1827e-3, chi: 16 / (Math.PI * Math.PI)
    };

    function erfc(x) {                                              // Chebyshev fit, fractional error < 1.2e-7
        var z = Math.abs(x), t = 1 / (1 + 0.5 * z);
        var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
                t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
        return x >= 0 ? r : 2 - r;
    }
    function erf(x) { return 1 - erfc(x); }
    function E1(x) {                                                // exponential integral E1(x), x > 0
        if (!(x > 0)) return NaN;
        if (x <= 1) {
            var s = 0, term = 1, k;
            for (k = 1; k < 60; k++) { term *= -x / k; var add = -term / k; s += add; if (Math.abs(add) < 1e-16 * Math.abs(s)) break; }
            return -0.5772156649015329 - Math.log(x) + s;
        }
        var b = x + 1, c = 1e300, d = 1 / b, h = d, i;           // modified Lentz continued fraction
        for (i = 1; i < 200; i++) {
            var an = -i * i; b += 2; d = 1 / (an * d + b); c = b + an / c; var del = c * d; h *= del;
            if (Math.abs(del - 1) < 1e-15) break;
        }
        return h * Math.exp(-x);
    }
    // uniform-flux fracture (full height, observed at the centre): pD = √(πtD)·erf(1/(2√tD)) + ½E1(1/(4tD));
    // pD′ = tD·dpD/dtD = (√(πtD)/2)·erf(1/(2√tD))   (exactly; the E1 term cancels)
    function ufPdPrime(tD) { return tD > 0 ? 0.5 * Math.sqrt(Math.PI * tD) * erf(1 / (2 * Math.sqrt(tD))) : 0; }
    function ufPd(tD) { return tD > 0 ? Math.sqrt(Math.PI * tD) * erf(1 / (2 * Math.sqrt(tD))) + 0.5 * E1(1 / (4 * tD)) : 0; }
    function etaD(P) { return KC.etaC * P.k / (P.phi * P.mu * P.ct); }
    // impulse response of the whole volume V released at t = 0 into a uniform-flux fracture of half-length L (psi)
    function ufImpulse(t, P) { if (!(t > 0)) return NaN; var tD = etaD(P) * t / (P.L * P.L); return 24 * P.V * KC.unit * P.mu / (P.k * P.h) * ufPdPrime(tD) / t; }
    // constant-rate response per bbl/d (psi)
    function ufRate(t, P) { if (!(t > 0)) return 0; var tD = etaD(P) * t / (P.L * P.L); return KC.unit * P.mu / (P.k * P.h) * ufPd(tD); }
    // penny-shaped (uniform-flux disc of radius R in a thick zone) impulse shape at the centre, τ = η·t/R²
    function pennyShape(tau) { return tau > 0 ? (1 - Math.exp(-1 / (4 * tau))) / Math.sqrt(tau) : NaN; }
    // uniform-flux impulse shape (∝ dpD/dtD), t_DL = η·t/L²
    function ufShape(tDL) { return tDL > 0 ? ufPdPrime(tDL) / tDL : NaN; }
    // Θ = pD/pD′ of the uniform-flux fracture (leak budget, §6.4)
    function theta(tDL) { var a = ufPdPrime(tDL); return a > 0 ? ufPd(tDL) / a : null; }

    var _GL = null;                                                 // 64-point Gauss–Legendre on [−1, 1]
    function gl64() {
        if (_GL) return _GL;
        var n = 64, x = [], w = [], i, j;
        for (i = 1; i <= n; i++) {
            var z = Math.cos(Math.PI * (i - 0.25) / (n + 0.5)), z1, pp, it = 0;
            do {
                var p1 = 1, p2 = 0;
                for (j = 1; j <= n; j++) { var p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
                pp = n * (z * p1 - p2) / (z * z - 1); z1 = z; z = z1 - p1 / pp;
            } while (Math.abs(z - z1) > 1e-15 && ++it < 100);
            x.push(z); w.push(2 / ((1 - z * z) * pp * pp));
        }
        _GL = { x: x, w: w }; return _GL;
    }
    // Carter source (constant area, leak-off rate ∝ 1/√τ on 0 < τ < t_c, mean release time t_c/3): with τ = t_c·u² the
    // convolution of an impulse kernel f (response to the whole V) is Δp(t) = ∫₀¹ f(t − t_c·u²) du.
    function carter(f, t, tc, panels) {
        if (!(t > tc)) return NaN;
        var Q = gl64(), N = panels || 8, s = 0, k, i;
        for (k = 0; k < N; k++) {
            var a = k / N, b = (k + 1) / N;
            for (i = 0; i < Q.x.length; i++) { var u = 0.5 * (a + b) + 0.5 * (b - a) * Q.x[i]; s += 0.5 * (b - a) * Q.w[i] * f(t - tc * u * u); }
        }
        return s;
    }
    // log-log slope of the pure-radial Carter response Δp ∝ u·artanh(u) (u = √(t_c/t)) or of its D, against the time
    // since an origin t0 (fraction of t_c): 'sinceClosure' 1, 'centroid' 1/3, 'total' 0 (§4.12 origin table)
    function originSlope(origin, tOverTc, what) {
        var t0 = origin === 'sinceClosure' ? 1 : origin === 'centroid' ? 1 / 3 : origin === 'midInjection' ? 0.5 * (fin(what && what.teOverTc) ? what.teOverTc : 0) : 0;
        var useD = what === 'D' || (what && what.D);
        var dp = function (t) { var u = Math.sqrt(1 / t); return u * 0.5 * Math.log((1 + u) / (1 - u)); };
        var Df = function (t) { var e = 1e-6; return Math.abs((dp(t * (1 + e)) - dp(t * (1 - e))) / (2 * e * t)) * (t - t0); };
        var f = useD ? Df : dp, x = tOverTc - t0, e2 = 1e-4;
        if (!(x > 0)) return null;
        return (Math.log(f(t0 + x * Math.exp(e2))) - Math.log(f(t0 + x * Math.exp(-e2)))) / (2 * e2);
    }
    // leak tolerance q_k,max = ε·V/(Θ·t_end) (bbl/d; V bbl, t h)
    function qkMaxRule(eps, V, th, tEnd) { return (pos(V) && pos(th) && pos(tEnd)) ? (fin(eps) ? eps : 0.05) * V / (th * tEnd) * 24 : null; }
    // gas properties at p (reservoir temperature and gravity from the well): {mu cp, cg 1/psi, z}
    function gasProps(p, well) {
        var C = G.PRiSM_pvt_correlations; well = well || {};
        var T = fin(well.T_F) ? well.T_F : (fin(well.T_res) ? well.T_res : null), sg = pos(well.SG_g) ? well.SG_g : null;
        if (!C || !fin(T) || !sg || !(p > 0)) return null;
        try {
            var Tpr = (T + 459.67) / C.Tpc_sutton(sg), Ppr = p / C.Ppc_sutton(sg), z = C.Z_dranchukAbouKassem(Tpr, Ppr);
            var mu = C.mu_g_leeGonzalezEakin(sg, T, z, p), cg = typeof C.cg_realGas === 'function' ? C.cg_realGas(p, T, z, sg) : 1 / p;
            if (!pos(mu) || !pos(cg)) return null;
            return { mu: mu, cg: cg, z: z };
        } catch (e) { return null; }
    }

    G.PRiSM_dfit_acaKernels = {
        K: KC, erf: erf, erfc: erfc, E1: E1, ufPd: ufPd, ufPdPrime: ufPdPrime, ufImpulse: ufImpulse, ufRate: ufRate,
        ufShape: ufShape, pennyShape: pennyShape, theta: theta, carter: carter, originSlope: originSlope,
        qkMax: qkMaxRule, gasProps: gasProps, bourdet: bourdet
    };

    // ═════════════════════════════════════════════════════════════════════
    // 3. Time functions, centroid, diagnosis, lines, bounds, p_i consensus
    // ═════════════════════════════════════════════════════════════════════
    function FL1(t, tc) { return t > tc ? 2 / Math.PI * Math.asin(Math.sqrt(tc / t)) : (t > 0 ? 1 : null); }
    function FR1(t, tc) { return t > tc ? 0.25 * Math.log(1 + KC.chi * tc / (t - tc)) : null; }
    function FRc1(t, tc) { if (!(t > tc)) return null; var u = Math.sqrt(tc / t); return KC.chi / 4 * u * 0.5 * Math.log((1 + u) / (1 - u)); }

    G.PRiSM_dfit_timeFns = function (tInj, tcInj, opts) {
        try {
            opts = opts || {};
            var useA = arrOk(opts.ta), tc = useA && pos(opts.tcA) ? opts.tcA : tcInj;
            if (!pos(tc)) return fail('BAD_INPUT', 'The closure time on the injection clock must be positive.', ['tcInj']);
            var single = !arrOk(tInj), T = single ? [tInj] : tInj, out = { FL: [], FR: [], FRc: [] };
            for (var i = 0; i < T.length; i++) {
                var t = useA ? opts.ta[i] : T[i];
                out.FL.push(fin(t) ? nn(FL1(t, tc)) : null);
                out.FR.push(fin(t) ? nn(FR1(t, tc)) : null);
                out.FRc.push(fin(t) ? nn(FRc1(t, tc)) : null);
            }
            if (opts.carterExact) out.FR = out.FRc.slice();
            if (single) { out.FL = out.FL[0]; out.FR = out.FR[0]; out.FRc = out.FRc[0]; }
            out.ok = true;
            return out;
        } catch (e) { return fail('TIMEFNS_FAILED', e && e.message || e); }
    };

    G.PRiSM_dfit_centroid = function (src) {
        if (!src) return null;
        if (pos(src.tcInj) && !arrOk(src.tau)) return src.tcInj / 3;
        if (arrOk(src.tau) && arrOk(src.qL) && src.tau.length === src.qL.length && src.tau.length > 1) {
            var a = 0, b = 0;
            for (var i = 1; i < src.tau.length; i++) {
                var dt = src.tau[i] - src.tau[i - 1]; if (!(dt > 0)) continue;
                var q0 = fin(src.qL[i - 1]) ? src.qL[i - 1] : 0, q1 = fin(src.qL[i]) ? src.qL[i] : 0;
                a += 0.5 * (q0 * src.tau[i - 1] + q1 * src.tau[i]) * dt; b += 0.5 * (q0 + q1) * dt;
            }
            return b > 0 ? a / b : null;
        }
        return null;
    };

    // ── p_i-free diagnosis (§4.12) ──
    var BANDS = [['linear', -0.5, 0.07], ['bilinear', -0.75, 0.07], ['radial', -1.0, 0.07], ['spherical', -1.5, 0.1]];
    function bandOf(s) {
        if (!fin(s)) return null;
        for (var i = 0; i < BANDS.length; i++) if (Math.abs(s - BANDS[i][1]) <= BANDS[i][2] + 1e-12) return BANDS[i][0];
        if (s < -1.6) return 'artefact';
        return 'transition';
    }
    G.PRiSM_dfit_acaDiag = function (t, p, opts) {
        try {
            opts = opts || {};
            if (!arrOk(t) || !arrOk(p) || t.length !== p.length) return fail('BAD_INPUT', 'Time and pressure arrays of equal length are needed.', ['t', 'p']);
            var t0 = fin(opts.t0) ? opts.t0 : 0, LB = pos(opts.LB) ? opts.LB : 0.25, sigma = fin(opts.sigma) && opts.sigma > 0 ? opts.sigma : 0;
            var x = [], pp = [], i;
            for (i = 0; i < t.length; i++) if (fin(t[i]) && fin(p[i]) && t[i] - t0 > 0 && (!x.length || t[i] - t0 > x[x.length - 1])) { x.push(t[i] - t0); pp.push(p[i]); }
            var n = x.length;
            var out = { x: x, D: [], sD: [], n: [], piLo: [], piHi: [], piPoint: [], noiseD: [], regimes: [], sequenceOk: true, p: pp, kinds: [], ok: true };
            if (n < 3) { out.ok = n > 0; for (i = 0; i < n; i++) { out.D.push(null); out.sD.push(null); out.n.push(null); out.piLo.push(null); out.piHi.push(null); out.piPoint.push(null); out.noiseD.push(null); out.kinds.push(null); } out.sequenceOk = false; return out; }
            var lx = x.map(Math.log), spans = new Array(n), dd = bourdet(lx, pp, LB, null, spans), D = [], lD = [];
            for (i = 0; i < n; i++) { var v = fin(dd[i]) ? Math.abs(dd[i]) : null; D.push(v); lD.push(v > 0 ? Math.log(v) : NaN); }
            var sd = bourdet(lx, lD, LB), sD = [];
            for (i = 0; i < n; i++) sD.push(fin(sd[i]) ? sd[i] : null);
            // remove the window bias of the difference on a local power law (D ∝ x^s_D): D/f(s_D, Δ₁, Δ₂)
            for (i = 0; i < n; i++) {
                if (D[i] == null || !spans[i] || !fin(sD[i])) continue;
                var wf = _winFactor(sD[i], spans[i][0], spans[i][1]);
                if (wf > 0.5 && wf < 2) { D[i] = D[i] / wf; lD[i] = Math.log(D[i]); }
            }
            var sigD = sigma > 0 ? sigma / (Math.SQRT2 * LB) : 0, kinds = [], seenBand = false;
            for (i = 0; i < n; i++) {
                var acc = D[i] != null && (sigD === 0 || D[i] >= 10 * sigD), kd = acc ? bandOf(sD[i]) : null;
                // steep s_D right after closure (closure proximity, before any regime band) is a transition, not an artefact
                if (kd === 'artefact' && !seenBand) kd = 'transition';
                if (kd && kd !== 'transition' && kd !== 'artefact') seenBand = true;
                kinds.push(kd);
            }
            // storage call: s_D > −0.40 from the first accepted points (before any point steeper than −0.43) for ≥ 0.2 log
            // cycle, or s_D > −0.40 held for more than one log cycle anywhere; the linear-to-radial hump (≤ 0.5 cycle) is not
            var storage = false, firstSteep = -1, runStart = -1, LN10 = Math.LN10;
            for (i = 0; i < n; i++) { if (kinds[i] != null && sD[i] <= -0.43) { firstSteep = i; break; } }
            var iFirst = -1; for (i = 0; i < n; i++) if (kinds[i] != null) { iFirst = i; break; }
            if (iFirst >= 0) {
                var lim = firstSteep < 0 ? n : firstSteep, allShallow = true;
                for (i = iFirst; i < lim; i++) if (kinds[i] != null && !(sD[i] > -0.40)) { allShallow = false; break; }
                if (allShallow && lim - 1 > iFirst && (lx[lim - 1] - lx[iFirst]) / LN10 >= 0.2) storage = true;
            }
            for (i = 0; i < n; i++) {
                if (kinds[i] != null && sD[i] > -0.40) { if (runStart < 0) runStart = i; if ((lx[i] - lx[runStart]) / LN10 > 1) storage = true; }
                else runStart = -1;
            }
            // gate for the bracket p − 2D ≤ p_i ≤ p − D: the sequence so far is linear → (hump) → radial-ward; no storage
            // call; points steeper than −1.1 never carry it, and after a steepening past −1.1 that follows at least 0.3
            // cycle of regime-band data (penny / spherical trend), no later point carries it
            // steepening: after ≥ 0.3 log cycle of regime-band progress, a run with s_D < −1.1 that lasts ≥ 0.3 log cycle or
            // reaches the end of the data (closure proximity makes s_D steep right after closure and then rises: not this)
            var progressed = -1, steepened = false, steepFrom = n, rs = -1;
            for (i = 0; i < n; i++) {
                var s1 = sD[i];
                if (fin(s1) && s1 >= -1.07 && s1 <= -0.43 && kinds[i] != null && progressed < 0) progressed = i;
                if (progressed >= 0 && i > progressed && fin(s1) && s1 < -1.1 && (lx[i] - lx[progressed]) / LN10 >= 0.3) {
                    if (rs < 0) rs = i;
                    if ((lx[i] - lx[rs]) / LN10 >= 0.3 || (i === n - 1 && i - rs >= 2 && (lx[i] - lx[rs]) / LN10 >= 0.15)) { steepened = true; steepFrom = rs; break; }
                } else rs = -1;
            }
            for (i = 0; i < n; i++) {
                var s = sD[i], g = !storage && D[i] != null && fin(s) && s >= -1.1 && i < steepFrom;
                out.D.push(D[i] == null ? null : D[i]);
                out.sD.push(s == null ? null : s);
                out.n.push(fin(s) ? -2 * s : null);
                out.piLo.push(g ? pp[i] - 2 * D[i] : null);
                out.piHi.push(g ? pp[i] - D[i] : null);
                out.noiseD.push(sigD);
                // point estimate only where s_D is locally constant (|Δs_D| < 0.1 over 0.5 log cycle) inside a regime band
                var pt = null, k = kinds[i];
                if (g && (k === 'linear' || k === 'bilinear' || k === 'radial' || k === 'spherical')) {
                    var la = lx[i] - 0.25 * LN10, lb = lx[i] + 0.25 * LN10;
                    if (la >= lx[0] && lb <= lx[n - 1]) {
                        var sa = _interpFinite(lx, sD, la), sb = _interpFinite(lx, sD, lb);
                        if (fin(sa) && fin(sb) && Math.abs(sb - sa) < 0.1) pt = pp[i] - (2 / (-2 * s)) * D[i];
                    }
                }
                out.piPoint.push(fin(pt) ? pt : null);
            }
            out.kinds = kinds;
            // regimes: merged runs of one kind (≥ 0.1 log cycle, storage always kept)
            var runs = [], cur = null;
            for (i = 0; i < n; i++) {
                var kk = kinds[i]; if (kk === 'transition' && fin(sD[i]) && sD[i] > -0.40 && storage) kk = 'storage';
                if (kk == null) { cur = null; continue; }
                if (cur && cur.kind === kk) { cur.i1 = i; cur.s.push(sD[i]); }
                else { cur = { kind: kk, i0: i, i1: i, s: [sD[i]] }; runs.push(cur); }
            }
            runs.forEach(function (r) {
                var span = (lx[r.i1] - lx[r.i0]) / LN10;
                if (span >= 0.1 || r.kind === 'storage') out.regimes.push({ kind: r.kind, t0: x[r.i0] + t0, t1: x[r.i1] + t0, slope: rnd(median(r.s), 4), _span: span });
            });
            out.storage = storage;
            out.steepened = steepened;
            out.sequenceOk = !storage && !steepened && !out.regimes.some(function (r) { return r.kind === 'artefact'; });
            return out;
        } catch (e) { return fail('ACADIAG_FAILED', e && e.message || e); }
    };
    function _interpFinite(xs, ys, x) {
        var lo = -1, hi = -1, i;
        for (i = 0; i < xs.length; i++) { if (!fin(ys[i])) continue; if (xs[i] <= x) lo = i; else { hi = i; break; } }
        if (lo < 0 || hi < 0) return lo >= 0 && xs[lo] === x ? ys[lo] : null;
        return ys[lo] + (x - xs[lo]) / (xs[hi] - xs[lo]) * (ys[hi] - ys[lo]);
    }

    function _inWin(t, w) { return w && fin(w[0]) && fin(w[1]) && t >= w[0] - 1e-12 && t <= w[1] + 1e-12; }
    function _winPts(t, p, w, fx) {
        var X = [], Y = [];
        for (var i = 0; i < t.length; i++) if (fin(p[i]) && _inWin(t[i], w)) { var v = fx(t[i], i); if (fin(v)) { X.push(v); Y.push(p[i]); } }
        return { X: X, Y: Y };
    }

    // Nolte / Talley lines (t, t_c from the start of injection): p = p_r + m_L·F_L and p = p_r + m_R·F_R (F_Rc when exact)
    G.PRiSM_dfit_nolte = function (ctx) {
        try {
            ctx = ctx || {};
            var t = ctx.tInj, p = ctx.p, tc = ctx.tcInj;
            if (!arrOk(t) || !arrOk(p) || !pos(tc)) return fail('BAD_INPUT', 'Nolte lines need the injection-clock times, pressures and t_c.', ['tInj', 'p', 'tcInj']);
            var ta = arrOk(ctx.ta) ? ctx.ta : null, tcA = ta && pos(ctx.tcA) ? ctx.tcA : tc;
            var out = { lin: null, rad: null, ok: true };
            if (ctx.linWin) {
                var L = _winPts(ta || t, p, ctx.linWin, function (v) { return FL1(v, tcA); });
                var fl = L.X.length >= 3 ? linfit(L.X, L.Y) : null;
                if (fl && fl.m > 0) {
                    var kL = (pos(ctx.CL) && pos(ctx.mu) && pos(ctx.phi) && pos(ctx.ct)) ? ctx.mu / (ctx.phi * ctx.ct) * Math.pow(ctx.CL / (KC.invmL * fl.m), 2) : null;
                    out.lin = { pr: fl.b, mL: fl.m, k: nn(kL), win: [ctx.linWin[0], ctx.linWin[1]], seB: fl.seB, n: fl.n };
                }
            }
            if (ctx.radWin) {
                var fR = ctx.carterExact ? FRc1 : FR1;
                var R = _winPts(ta || t, p, ctx.radWin, function (v) { return fR(v, tcA); });
                var fr = R.X.length >= 3 ? linfit(R.X, R.Y) : null;
                if (fr && fr.m > 0 && pos(ctx.V)) {
                    var khmu = KC.khmuH * ctx.V / (fr.m * tcA);
                    out.rad = { pr: fr.b, mR: fr.m, khmu: khmu, k: (pos(ctx.mu) && pos(ctx.h)) ? khmu * ctx.mu / ctx.h : null, win: [ctx.radWin[0], ctx.radWin[1]], seB: fr.seB, n: fr.n, exact: !!ctx.carterExact };
                }
            }
            return out;
        } catch (e) { return fail('NOLTE_FAILED', e && e.message || e); }
    };

    // Impulse lines p = p_i + m·g(t − t0): linear t′^−½ (A√k), radial 1/t′ (kh/μ), spherical t′^−3/2 (k_s), bilinear t′^−¾
    G.PRiSM_dfit_impulseLines = function (ctx) {
        try {
            ctx = ctx || {};
            var t = ctx.t, p = ctx.p, t0 = fin(ctx.t0) ? ctx.t0 : 0, reg = ctx.regime || 'linear', V = ctx.V;
            if (!arrOk(t) || !arrOk(p) || !pos(V)) return fail('BAD_INPUT', 'Impulse lines need times, pressures and the volume.', ['t', 'p', 'V']);
            var ex = reg === 'radial' ? 1 : reg === 'spherical' ? 1.5 : reg === 'bilinear' ? 0.75 : 0.5;
            var w = ctx.win || [-Infinity, Infinity];
            var P = _winPts(t, p, w, function (v) { var x = v - t0; return x > 0 ? Math.pow(x, -ex) : NaN; });
            var f = P.X.length >= 3 ? linfit(P.X, P.Y) : null;
            if (!f || !(f.m > 0)) return fail('NO_LINE', 'Fewer than three usable points, or no decline, in the impulse window.', ['win']);
            var mu = ctx.mu, phi = ctx.phi, ct = ctx.ct, out = { ok: true, pi: f.b, m: f.m, group: 'Ask', value: null, seB: f.seB, n: f.n, regime: reg };
            if (reg === 'linear') {
                out.group = 'Ask';
                out.value = (pos(mu) && pos(phi) && pos(ct)) ? KC.lin * V * Math.sqrt(mu / (phi * ct)) / f.m : null;
                if (pos(ctx.A) && pos(out.value)) out.k = Math.pow(out.value / ctx.A, 2);
            } else if (reg === 'radial') {
                out.group = 'khmu'; out.value = KC.rad * V / f.m;
                if (pos(mu) && pos(ctx.h)) out.k = out.value * mu / ctx.h;
            } else if (reg === 'spherical') {
                out.group = 'ks';
                out.value = (pos(mu) && pos(phi) && pos(ct)) ? Math.pow(KC.sph * V * Math.pow(mu, 1.5) * Math.sqrt(phi * ct) / f.m, 2 / 3) : null;
            } else {
                out.group = 'kfw';
                out.value = (pos(mu) && pos(ctx.h)) ? KC.bil * V * mu / (ctx.h * f.m) : null;
            }
            return out;
        } catch (e) { return fail('IMPULSE_FAILED', e && e.message || e); }
    };

    // Bounds on k when radial flow is not reached (§4.12), at the conservative ends of the input ranges
    G.PRiSM_dfit_acaBounds = function (ctx) {
        try {
            ctx = ctx || {};
            var dg = ctx.diag, rg = ctx.ranges || {};
            if (!dg || !arrOk(dg.x) || !dg.x.length) return fail('BAD_INPUT', 'Bounds need the after-closure diagnosis.', ['diag']);
            var hiOf = function (k, def) { var r = rg[k]; return r && fin(r[1]) ? r[1] : def; };
            var loOf = function (k, def) { var r = rg[k]; return r && fin(r[0]) ? r[0] : def; };
            var phi = ctx.phi, mu = ctx.mu, ct = ctx.ct, h = ctx.h, V = ctx.V;
            var props = typeof ctx.props === 'function' ? ctx.props : null;
            var n = dg.x.length, iEnd = n - 1;
            while (iEnd > 0 && !(fin(dg.D[iEnd]) && dg.D[iEnd] > 0)) iEnd--;
            var xEnd = fin(ctx.tEnd) && fin(ctx.t0) ? ctx.tEnd - ctx.t0 : dg.x[iEnd], DEnd = dg.D[iEnd], pEnd = dg.p ? dg.p[iEnd] : null;
            var sEnd = null; for (var i = iEnd; i >= 0 && sEnd == null; i--) if (fin(dg.sD[i])) sEnd = dg.sD[i];
            var reversed = fin(sEnd) && sEnd < -1.1;
            var his = [], los = [], trend = { khmuPi: null, khmuD: null };
            var muHi = hiOf('mu', mu), hHi = hiOf('h', h), VHi = hiOf('V', V), phiHi = hiOf('phi', phi), ctHi = hiOf('ct', ct);
            var muLo = loOf('mu', mu), VLo = loOf('V', V);
            if (props && fin(ctx.piLo)) { var pr = props(ctx.piLo); if (pr) { if (pos(pr.mu)) { muLo = pr.mu; muHi = pr.mu; } if (pos(pr.ct)) { ctHi = pr.ct; } } }
            // k_hi from the trend (kh/μ ≤ 1,694.5·V/(Δp_end·t′_end) and ≤ 1,694.5·V/(D_end·t′_end)); reversed for n > 2
            if (pos(VHi) && pos(xEnd)) {
                if (fin(ctx.piHi) && fin(pEnd) && pEnd - ctx.piHi > 0) trend.khmuPi = KC.rad * VHi / ((pEnd - ctx.piHi) * xEnd);
                if (pos(DEnd)) trend.khmuD = KC.rad * VHi / (DEnd * xEnd);
                [['trend', trend.khmuPi], ['trend-pfree', trend.khmuD]].forEach(function (r) {
                    if (!pos(r[1]) || !pos(muHi) || !pos(h)) return;
                    var kk = r[1] * (reversed ? muLo : muHi) / (reversed ? hHi : h);
                    (reversed ? los : his).push({ edge: reversed ? 'lo' : 'hi', rule: r[0], value: rnd(ctx.tEnd != null ? ctx.tEnd : xEnd, 4), k: kk });
                });
            }
            // k_hi when radial flow is not reached (s_D > −0.90 at t_end): k < 1.6·φμc_t·L_max²/(0.0002637·t′_end)
            if (pos(ctx.Lmax) && pos(xEnd) && fin(sEnd) && sEnd > -0.90 && pos(phiHi) && pos(muHi) && pos(ctHi)) {
                his.push({ edge: 'hi', rule: 'radial-not-reached', value: rnd(ctx.Lmax, 1), k: 1.6 * phiHi * muHi * ctHi * ctx.Lmax * ctx.Lmax / (KC.etaC * xEnd) });
            }
            // k_lo, linear flow with the largest plausible area: k = (97.54·V/(A_max·m_L′))²·μ/(φc_t)
            if (pos(ctx.Amax) && pos(ctx.mImpLin) && pos(VLo) && pos(muLo) && pos(phiHi) && pos(ctHi)) {
                los.push({ edge: 'lo', rule: 'linear-Amax', value: rnd(ctx.Amax / (2 * (pos(h) ? h : 1)), 1), k: Math.pow(KC.lin * VLo / (ctx.Amax * ctx.mImpLin), 2) * muLo / (phiHi * ctHi) });
            }
            // k_lo, leak-off cannot exceed its reservoir-controlled limit: k ≥ μ/(φc_t)·(CL_lo/(1.1827e-3·Δp_hi)),
            // Δp_hi = p_mid,hi − p_i,lo (the Δp_CL convention ½·(ISIP + σ_c) − p_r at the conservative ends, §4.22)
            var dpCL = (fin(ctx.pMidHi) && fin(ctx.piLo)) ? ctx.pMidHi - ctx.piLo : null;
            var CLlo = pos(ctx.CLlo) ? ctx.CLlo : (pos(ctx.CL) ? ctx.CL : null);
            if (pos(dpCL) && CLlo && pos(muLo) && pos(phiHi) && pos(ctHi)) {
                los.push({ edge: 'lo', rule: 'leakoff-limit', value: rnd(dpCL, 1), k: muLo / (phiHi * ctHi) * Math.pow(CLlo / (KC.invmL * dpCL), 2) });
            }
            var kHi = null, kLo = null, bHi = null, bLo = null;
            his.forEach(function (b) { if (pos(b.k) && (kHi == null || b.k < kHi)) { kHi = b.k; bHi = b; } });
            los.forEach(function (b) { if (pos(b.k) && (kLo == null || b.k > kLo)) { kLo = b.k; bLo = b; } });
            var warnings = [];
            if (kLo != null && kHi != null && kLo > kHi) {
                warnings.push(W('BOUNDS_CROSSED', 'warn', 'The lower and upper k bounds cross; the inputs (area, CL or the trend) are inconsistent.', ['A1']));
                var tmp = kLo; kLo = kHi; kHi = tmp;
            }
            var binding = [];
            if (bLo) binding.push({ edge: 'lo', rule: bLo.rule, value: fin(bLo.value) ? bLo.value : 0 });
            if (bHi) binding.push({ edge: 'hi', rule: bHi.rule, value: fin(bHi.value) ? bHi.value : 0 });
            return { ok: true, kLo: nn(kLo), kHi: nn(kHi), binding: binding, direction: reversed ? 'reversed' : 'normal', dpCL: nn(dpCL), trend: trend,
                     candidates: { lo: los, hi: his }, warnings: warnings };
        } catch (e) { return fail('BOUNDS_FAILED', e && e.message || e); }
    };

    // p_i consensus: intersect the brackets, weighted median of the candidates inside, label (§4.12)
    G.PRiSM_dfit_piConsensus = function (ctx) {
        try {
            ctx = ctx || {};
            var br = ctx.brackets || {}, lo = -Infinity, hi = Infinity, eLo = null, eHi = null, names = ['cart', 'imp', 'deriv'], any = false;
            names.forEach(function (k) {
                var b = br[k]; if (!b || !fin(b[0]) || !fin(b[1])) return;
                any = true;
                if (b[0] > lo) { lo = b[0]; eLo = k; }
                if (b[1] < hi) { hi = b[1]; eHi = k; }
            });
            var cands = (ctx.candidates || []).filter(function (c) { return c && fin(c.value); });
            var reasons = [], crossed = any && lo > hi;
            var vals = cands.map(function (c) { return c.value; }), ws = cands.map(function (c) { return pos(c.w) ? c.w : 1; });
            var value = wmedian(vals, ws);
            if (!any || crossed) {
                if (crossed) reasons.push('The brackets do not overlap; only the candidate lines are used.');
                if (value == null) return fail('NO_PI', 'Neither a bracket nor a candidate line gives p_i.', ['candidates']);
                var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
                lo = mn; hi = mx; eLo = eLo || 'candidates'; eHi = eHi || 'candidates';
                if (crossed) { eLo = 'candidates'; eHi = 'candidates'; }
            }
            if (value == null) value = 0.5 * (lo + hi);
            if (value < lo) value = lo; if (value > hi) value = hi;
            var width = hi - lo, label = 'low';
            var hiTol = Math.max(10, 0.005 * Math.abs(value));
            var stable = fin(ctx.stableCycles) ? ctx.stableCycles >= 0.5 : false;
            var epsOk = fin(ctx.eps) ? ctx.eps < 0.05 : true;
            var matchOk = !ctx.matchCI || (ctx.matchCI[0] >= lo - 1e-9 && ctx.matchCI[1] <= hi + 1e-9);
            if (!crossed && any && width <= hiTol && stable && epsOk && matchOk && !ctx.storage && !ctx.steepened) label = 'high';
            else if (!crossed && !ctx.storage && !ctx.steepened && (width <= 50 || (ctx.linearOnly && fin(ctx.flVsImp) && Math.abs(ctx.flVsImp) <= 10))) label = 'medium';
            if (label === 'high') reasons.push('Bracket width ' + fmt(width, 1) + ' psi is within ' + fmt(hiTol, 1) + ' psi and the regime is stable for at least half a log cycle.');
            else if (label === 'medium') {
                if (width <= 50) reasons.push('Bracket width ' + fmt(width, 1) + ' psi is within 50 psi.');
                else reasons.push('Linear flow only: the F_L line and the impulse line agree within 10 psi.');
            }
            if (ctx.storage) reasons.push('After-closure storage: straight lines are withheld and p_i is uncertain.');
            if (ctx.steepened) reasons.push('Penny or spherical flow suspected: the derivative keeps steepening past −1.1.');
            if (ctx.surface) reasons.push('Surface gauge: the column temperature is not modelled.');
            if (label === 'low' && !reasons.length) reasons.push('Bracket width ' + fmt(width, 1) + ' psi exceeds 50 psi.');
            return { ok: true, value: value, lo: lo, hi: hi, label: label, reasons: reasons.map(_txt), edges: { lo: eLo, hi: eHi } };
        } catch (e) { return fail('PICONS_FAILED', e && e.message || e); }
    };

    // ═════════════════════════════════════════════════════════════════════
    // 4. Gas adjustment, constant-rate transform, model-library match
    // ═════════════════════════════════════════════════════════════════════
    // p_a = p_i + (μz/p)_i·∫_{p_i}^{p} p′/(μz) dp′ = p_i + (m(p) − m(p_i))/m′(p_i)   (so p_a(p_i) = p_i, intercepts in psia)
    // t_a = (μc_t)_i·∫ dt′/(μc_t)(p(t′))  (PRiSM_gasPseudoTime normalised at p_i)
    G.PRiSM_dfit_gasAdjust = function (t, p, ctx) {
        try {
            ctx = ctx || {};
            if (!arrOk(t) || !arrOk(p) || t.length !== p.length || t.length < 2) return fail('BAD_INPUT', 'Gas adjustment needs matching time and pressure arrays.', ['t', 'p']);
            if (!pos(ctx.pi)) return fail('BAD_INPUT', 'Gas adjustment needs a reference p_i.', ['pi']);
            if (typeof G.PRiSM_mpTable !== 'function') return fail('NO_MP', 'The pseudo-pressure table (16-pvt) is not loaded.', []);
            var pmax = 1.2 * Math.max(ctx.pi, Math.max.apply(null, p.filter(fin)));
            var tbl = G.PRiSM_mpTable({ T_F: ctx.T_F, SG_g: ctx.SG_g, pi: ctx.pi, pmax: pmax });
            var mi = tbl.mOf(ctx.pi), dpi = Math.max(0.5, 1e-4 * ctx.pi), dm = (tbl.mOf(ctx.pi + dpi) - tbl.mOf(ctx.pi - dpi)) / (2 * dpi);
            if (!pos(dm)) return fail('NO_MP', 'dm/dp is not positive at p_i.', ['pi']);
            var pa = p.map(function (v) { return fin(v) ? ctx.pi + (tbl.mOf(v) - mi) / dm : null; });
            var ta = null, info = null;
            if (typeof G.PRiSM_gasPseudoTime === 'function') {
                var tt = [], pp = [], idx = [];
                for (var i = 0; i < t.length; i++) if (fin(t[i]) && t[i] > 0 && fin(p[i]) && (!tt.length || t[i] > tt[tt.length - 1])) { tt.push(t[i]); pp.push(p[i]); idx.push(i); }
                var r = tt.length >= 2 ? G.PRiSM_gasPseudoTime(tt, pp, { T_F: ctx.T_F, SG_g: ctx.SG_g, pNorm: ctx.pi, p0: pp[0], ct: ctx.ct, Sg: ctx.Sg }) : null;
                if (r && r.ok) { ta = t.map(function () { return null; }); idx.forEach(function (j, k) { ta[j] = r.ta[k]; }); info = r.info; }
            }
            if (!ta) return fail('NO_PSEUDOTIME', 'Pseudo-time is not available (52-prism-gas or the gas properties are missing).', ['T_F', 'SG_g']);
            return { ok: true, pa: pa, ta: ta, iterations: 0, converged: true, info: info };
        } catch (e) { return fail('GAS_FAILED', e && e.message || e); }
    };

    // impulse → constant-rate transform (§6.8): y = t′·(p − p_i)/(24·V) psi per STB/d; p_i-free t′·D/(24·V)
    G.PRiSM_dfit_crTransform = function (t, p, ctx) {
        try {
            ctx = ctx || {};
            if (!arrOk(t) || !arrOk(p) || !pos(ctx.V)) return fail('BAD_INPUT', 'The transform needs times, pressures and V.', ['t', 'p', 'V']);
            var t0 = fin(ctx.t0) ? ctx.t0 : 0, x = [], pp = [];
            for (var i = 0; i < t.length; i++) if (fin(t[i]) && fin(p[i]) && t[i] - t0 > 0 && (!x.length || t[i] - t0 > x[x.length - 1])) { x.push(t[i] - t0); pp.push(p[i]); }
            var d = bourdet(x.map(Math.log), pp, pos(ctx.L) ? ctx.L : 0.25), V24 = 24 * ctx.V;
            return { ok: true, t: x, y: x.map(function (xx, k) { return fin(ctx.pi) ? xx * (pp[k] - ctx.pi) / V24 : null; }),
                     yPiFree: x.map(function (xx, k) { return fin(d[k]) ? xx * Math.abs(d[k]) / V24 : null; }) };
        } catch (e) { return fail('CR_FAILED', e && e.message || e); }
    };

    // model library match (§6.8): p(t′) = p_i + 24·V·(141.2·μ/(kh))·pd′(t_D)/t′, p_i by variable projection inside the bracket
    var RW_REF = 0.3;
    function _pdPrimeFor(model, tDarr, prm) {
        if (model === 'infiniteFrac') return tDarr.map(ufPdPrime);       // uniform flux, the closed form of the registry kernel
        var M = G.PRiSM_MODELS && G.PRiSM_MODELS[model];
        if (!M || typeof M.pdPrime !== 'function') return null;
        var r = M.pdPrime(tDarr, prm);
        return arrOk(r) ? Array.prototype.slice.call(r) : tDarr.map(function (td) { return M.pdPrime(td, prm); });
    }
    var MATCH_SPEC = {
        homogeneous: { free: ['k'], refL: function () { return RW_REF; }, prm: function () { return { Cd: 0, S: 0 }; } },
        infiniteFrac: { free: ['k', 'L'], refL: function (q) { return q.L; }, prm: function () { return { Cd: 0, S: 0, uniformFlux: true }; } },
        finiteFrac: { free: ['k', 'L', 'FcD'], refL: function (q) { return q.L; }, prm: function (q) { return { Cd: 0, S: 0, FcD: q.FcD }; } },
        radialComposite: { free: ['k', 'M', 'Rin'], refL: function () { return RW_REF; }, prm: function (q) { return { Cd: 0, S: 0, M: q.M, F: 1, R: Math.max(1.5, q.Rin / RW_REF) }; } }
    };
    function _matchPrep(ctx) {
        var t0 = fin(ctx.t0) ? ctx.t0 : 0, tMin = pos(ctx.tcInj) ? 3 * ctx.tcInj : 0, x = [], pp = [];
        for (var i = 0; i < ctx.t.length; i++) { var xx = ctx.t[i] - t0; if (fin(xx) && xx > 0 && xx >= tMin && fin(ctx.p[i])) { x.push(xx); pp.push(ctx.p[i]); } }
        var maxPts = pos(ctx.maxPts) ? ctx.maxPts : 120;
        if (x.length > maxPts) {                                      // ≤ 120 log-spaced points
            var lx0 = Math.log(x[0]), lx1 = Math.log(x[x.length - 1]), X = [], P = [], j = 0;
            for (var k = 0; k < maxPts; k++) {
                var target = lx0 + (lx1 - lx0) * k / (maxPts - 1);
                while (j < x.length - 1 && Math.abs(Math.log(x[j + 1]) - target) <= Math.abs(Math.log(x[j]) - target)) j++;
                if (!X.length || x[j] > X[X.length - 1]) { X.push(x[j]); P.push(pp[j]); }
            }
            x = X; pp = P;
        }
        return { x: x, p: pp };
    }
    function _matchOne(model, D, ctx, bracket, counter) {
        var S = MATCH_SPEC[model]; if (!S) return { model: model, ok: false, why: 'unknown model' };
        var mu = ctx.mu, h = ctx.h, phi = ctx.phi, ct = ctx.ct, V = ctx.V;
        function curve(q) {
            var L = S.refL(q), eta = KC.etaC * q.k / (phi * mu * ct), tD = D.x.map(function (x) { return eta * x / (L * L); });
            var pd = _pdPrimeFor(model, tD, S.prm(q)); if (!pd) return null;
            var c = 24 * V * KC.unit * mu / (q.k * h);
            return D.x.map(function (x, i) { return c * pd[i] / x; });
        }
        function project(f) {
            var r = []; for (var i = 0; i < f.length; i++) r.push(D.p[i] - f[i]);
            var pi = mean(r); if (bracket) { if (pi < bracket[0]) pi = bracket[0]; if (pi > bracket[1]) pi = bracket[1]; }
            return pi;
        }
        var fn = function (tArr, q) {
            if (counter) counter.n++;
            var f = curve(q); if (!f) return tArr.map(function () { return NaN; });
            var pi = project(f); return f.map(function (v) { return v + pi; });
        };
        var p0 = { k: pos(ctx.kInit) ? ctx.kInit : 0.01 }, bounds = { k: [1e-7, 1e5] }, logKeys = ['k'];
        if (S.free.indexOf('L') >= 0) { p0.L = pos(ctx.LInit) ? ctx.LInit : 100; bounds.L = [1, 5000]; logKeys.push('L'); }
        if (S.free.indexOf('FcD') >= 0) { p0.FcD = 10; bounds.FcD = [0.1, 1e4]; logKeys.push('FcD'); }
        if (S.free.indexOf('M') >= 0) { p0.M = 2; bounds.M = [0.01, 100]; logKeys.push('M'); p0.Rin = pos(ctx.LInit) ? ctx.LInit : 50; bounds.Rin = [1, 5000]; logKeys.push('Rin'); }
        var res;
        try { res = G.PRiSM_lm(fn, { t: D.x, p: D.p }, p0, bounds, null, { logKeys: logKeys, maxIter: 60 }); }
        catch (e) { return { model: model, ok: false, why: String(e && e.message || e) }; }
        if (!res || !res.params) return { model: model, ok: false, why: 'no fit' };
        var f = curve(res.params), pi = f ? project(f) : null, ssr = 0;
        if (f) for (var i = 0; i < f.length; i++) { var r = D.p[i] - f[i] - pi; ssr += r * r; }
        var n = D.x.length, npar = S.free.length + 1, bic = n * Math.log(Math.max(ssr, 1e-300) / n) + npar * Math.log(n);
        return { model: model, ok: !!f && fin(ssr), k: res.params.k, L: res.params.L != null ? res.params.L : null, pi: pi, ssr: ssr, bic: bic,
                 ci95: res.ci95 || null, params: res.params, converged: !!res.converged, n: n };
    }
    function _matchFinish(cands) {
        var best = null;
        cands.forEach(function (c) { if (c.ok && fin(c.bic) && (!best || c.bic < best.bic)) best = c; });
        if (!best) return fail('NO_MATCH', 'No library model could be matched to the after-closure data.', ['models']);
        var ci = best.ci95 && best.ci95.k ? best.ci95.k : null;
        return { ok: true, best: { model: best.model, k: best.k, L: best.L, pi: best.pi, ci95: ci ? { k: ci } : null, bic: best.bic, params: best.params },
                 candidates: cands.map(function (c) { return { model: c.model, ok: c.ok, k: nn(c.k), L: nn(c.L), pi: nn(c.pi), bic: nn(c.bic), ssr: nn(c.ssr) }; }) };
    }
    function _matchSetup(ctx, opts) {
        ctx = ctx || {}; opts = opts || {};
        if (typeof G.PRiSM_lm !== 'function') return { err: fail('NO_LM', 'The regression engine (05) is not loaded.', []) };
        if (!arrOk(ctx.t) || !arrOk(ctx.p) || !pos(ctx.V) || !pos(ctx.mu) || !pos(ctx.h) || !pos(ctx.phi) || !pos(ctx.ct))
            return { err: fail('BAD_INPUT', 'The match needs t, p, V, μ, h, φ and c_t.', ['t', 'p', 'V', 'mu', 'h', 'phi', 'ct']) };
        var D = _matchPrep(ctx);
        if (D.x.length < 8) return { err: fail('TOO_FEW', 'Fewer than eight after-closure points beyond 3 t_c.', ['t']) };
        var models = (opts.models || ['infiniteFrac', 'finiteFrac', 'homogeneous', 'radialComposite']).filter(function (m) { return MATCH_SPEC[m]; });
        var br = opts.piBracket || ctx.piBracket || null;
        return { D: D, models: models, bracket: br && fin(br[0]) && fin(br[1]) && br[0] <= br[1] ? br : null };
    }
    G.PRiSM_dfit_acaMatch = function (ctx, opts) {
        try {
            var S = _matchSetup(ctx, opts); if (S.err) return S.err;
            var counter = { n: 0 }, cands = S.models.map(function (m) { return _matchOne(m, S.D, ctx, S.bracket, counter); });
            var r = _matchFinish(cands); if (r.ok) r.evals = counter.n; return r;
        } catch (e) { return fail('MATCH_FAILED', e && e.message || e); }
    };
    G.PRiSM_dfit_acaMatchJob = function (ctx, opts) {
        var S = null, cands = [], i = 0, done = false, cancelled = false, res = null, counter = { n: 0 };
        try { S = _matchSetup(ctx, opts); } catch (e) { S = { err: fail('MATCH_FAILED', e && e.message || e) }; }
        if (S.err) { done = true; res = S.err; }
        return {
            step: function () {
                if (done || cancelled) return { done: true, progress: 1, label: cancelled ? 'cancelled' : 'done' };
                try { cands.push(_matchOne(S.models[i], S.D, ctx, S.bracket, counter)); } catch (e) { cands.push({ model: S.models[i], ok: false }); }
                i++;
                if (i >= S.models.length) { done = true; res = _matchFinish(cands); if (res.ok) res.evals = counter.n; }
                return { done: done, progress: i / S.models.length, label: 'model ' + i + ' of ' + S.models.length };
            },
            result: function () { return res || fail('CANCELLED', 'The match was cancelled.', []); },
            cancel: function () { cancelled = true; }
        };
    };

    // ═════════════════════════════════════════════════════════════════════
    // 5. PRiSM_dfit_aca, leak plot, k constraint
    // ═════════════════════════════════════════════════════════════════════
    function _acaCore(tInj, p, A) {
        // A: {t0, tcInj, V, LB, sigma, well, CL, isip, pClosure, linWin, radWin, carterExactFR, VwCw, ta, tcA, geometry, hp}
        var dg = G.PRiSM_dfit_acaDiag(A.ta ? A.ta : tInj, p, { t0: A.t0, LB: A.LB, sigma: A.sigma });
        if (!dg || dg.ok === false) return { err: dg || fail('ACADIAG_FAILED', 'diagnosis failed') };
        var w = A.well, mu = w.mu, phi = w.phi, ct = w.ct, h = w.h, tAx = A.ta ? A.ta : tInj, tc = A.tcA || A.tcInj;
        var runs = dg.regimes, linRun = null, radRun = null, sphRun = null, bilRun = null;
        runs.forEach(function (r) {
            if (r.kind === 'linear' && (!linRun || r._span > linRun._span)) linRun = r;
            if (r.kind === 'radial' && r._span >= 0.3 && (!radRun || r._span > radRun._span)) radRun = r;
            if (r.kind === 'spherical' && (!sphRun || r._span > sphRun._span)) sphRun = r;
            if (r.kind === 'bilinear' && (!bilRun || r._span > bilRun._span)) bilRun = r;
        });
        var summary = dg.storage ? 'storage' : radRun ? (linRun ? 'linear-radial' : 'radial') : (sphRun || dg.steepened) ? 'spherical' : linRun ? 'linear' : 'none';
        var mapW = function (w) { return (w && A.ta) ? [interp(tInj, A.ta, w[0]), interp(tInj, A.ta, w[1])] : w; };   // user windows: injection clock
        var uLin = mapW(A.linWin), uRad = mapW(A.radWin);
        var linWin = uLin || (linRun ? [linRun.t0, linRun.t1] : null), radWin = uRad || (radRun ? [radRun.t0, radRun.t1] : null);
        if (dg.storage) { linWin = uLin || null; radWin = uRad || null; }
        var withhold = dg.storage && !A.linWin && !A.radWin;
        var CL = A.CL;
        var nol = withhold ? { lin: null, rad: null } : G.PRiSM_dfit_nolte({ tInj: tInj, p: p, tcInj: A.tcInj, ta: A.ta, tcA: A.tcA, V: A.V, linWin: linWin, radWin: radWin, CL: CL, mu: mu, phi: phi, ct: ct, h: h, carterExact: A.carterExactFR });
        if (!nol || nol.ok === false) nol = { lin: null, rad: null };
        var Aface = pos(A.L) && pos(A.hp) ? 2 * A.L * A.hp : null;
        var imp = { lin: null, rad: null, sph: null };
        if (!withhold) {
            if (linWin) { var il = G.PRiSM_dfit_impulseLines({ t: tAx, p: p, t0: A.t0, V: A.V, win: linWin, regime: 'linear', A: Aface, h: h, mu: mu, phi: phi, ct: ct }); if (il.ok) imp.lin = il; }
            if (radWin) { var ir = G.PRiSM_dfit_impulseLines({ t: tAx, p: p, t0: A.t0, V: A.V, win: radWin, regime: 'radial', h: h, mu: mu, phi: phi, ct: ct }); if (ir.ok) imp.rad = ir; }
            if (sphRun) { var is = G.PRiSM_dfit_impulseLines({ t: tAx, p: p, t0: A.t0, V: A.V, win: [sphRun.t0, sphRun.t1], regime: 'spherical', h: h, mu: mu, phi: phi, ct: ct }); if (is.ok) imp.sph = is; }
        }
        // brackets on the latest data (the last half log cycle, ≥ 5 points)
        var n = dg.x.length, xEnd = dg.x[n - 1], late = [], i;
        for (i = 0; i < n; i++) if (dg.x[i] >= xEnd / Math.sqrt(10)) late.push(i);
        if (late.length < 5) { late = []; for (i = Math.max(0, n - 5); i < n; i++) late.push(i); }
        var lt = late.map(function (j) { return dg.x[j] + A.t0; }), lp = late.map(function (j) { return dg.p[j]; });
        var cart = null, impB = null, deriv = null;
        if (!dg.storage && lt.length >= 3) {
            var fL = linfit(lt.map(function (v) { return FL1(v, tc); }), lp), fRc = linfit(lt.map(function (v) { return FRc1(v, tc); }), lp);
            if (fL && fRc) cart = [Math.min(fL.b, fRc.b), Math.max(fL.b, fRc.b)];
            var gL = linfit(lt.map(function (v) { return Math.pow(v - A.t0, -0.5); }), lp), gR = linfit(lt.map(function (v) { return 1 / (v - A.t0); }), lp);
            if (gL && gR) impB = [Math.min(gL.b, gR.b), Math.max(gL.b, gR.b)];
            if (dg.steepened) { cart = cart ? [cart[0], Infinity] : null; impB = impB ? [impB[0], Infinity] : null; }
        }
        for (i = n - 1; i >= 0; i--) if (fin(dg.piLo[i]) && fin(dg.piHi[i])) { deriv = [dg.piLo[i], dg.piHi[i]]; break; }
        if (deriv && i < n - 1 && (dg.storage || dg.steepened)) deriv = null;
        if (cart && !fin(cart[1])) cart = null;
        if (impB && !fin(impB[1])) impB = null;
        // p_i candidates
        var cands = [], tr = null;
        if (summary === 'radial' || summary === 'linear-radial') { if (nol.rad) cands.push({ method: 'nolte-radial', value: nol.rad.pr, w: 2 }); if (imp.rad) cands.push({ method: 'impulse-radial', value: imp.rad.pi, w: 2 }); }
        else { if (nol.lin) cands.push({ method: 'nolte-linear', value: nol.lin.pr, w: 1 }); if (imp.lin) cands.push({ method: 'impulse-linear', value: imp.lin.pi, w: 1 }); if (imp.sph) cands.push({ method: 'impulse-spherical', value: imp.sph.pi, w: 1 }); }
        // derivative trajectory: point estimates flat over ≥ 0.3 log cycle at the end
        var pts = []; for (i = n - 1; i >= 0; i--) { if (!fin(dg.piPoint[i])) { if (pts.length) break; continue; } pts.push(i); }
        if (pts.length >= 2 && Math.log10(dg.x[pts[0]] / dg.x[pts[pts.length - 1]]) >= 0.3) { tr = median(pts.map(function (j) { return dg.piPoint[j]; })); cands.push({ method: 'derivative', value: tr, w: 1 }); }
        var stableCycles = 0, regRun = radRun || (summary === 'linear' ? linRun : null);
        if (regRun) stableCycles = regRun._span;
        var VwCw = A.VwCw, epsNow = null, epsC = null;
        var piC = G.PRiSM_dfit_piConsensus({
            candidates: cands, brackets: { cart: cart, imp: impB, deriv: deriv }, stableCycles: stableCycles,
            linearOnly: summary === 'linear', flVsImp: nol.lin && imp.lin ? nol.lin.pr - imp.lin.pi : null,
            storage: dg.storage, steepened: dg.steepened, surface: A.surface,
            eps: (pos(VwCw) && pos(A.V)) ? VwCw * Math.max(0, p[p.length - 1] - (cands.length ? median(cands.map(function (c) { return c.value; })) : p[p.length - 1])) / A.V : null
        });
        if (!piC.ok) {
            var pE = p[p.length - 1], dE = null; for (i = n - 1; i >= 0 && dE == null; i--) if (fin(dg.D[i])) dE = dg.D[i];
            var lo0 = fin(dE) ? Math.max(1, pE - 2 * dE) : pE;
            piC = { value: 0.5 * (lo0 + pE), lo: lo0, hi: pE, label: 'low', edges: { lo: 'derivative', hi: 'data' },
                    reasons: [dg.storage ? 'After-closure storage: straight lines are withheld and p_i is uncertain.' : dg.steepened ? 'Penny or spherical flow suspected: no line or bracket holds.' : 'No p_i estimate is possible from these data.'] };
        }
        if (pos(VwCw) && pos(A.V)) { epsC = VwCw * Math.max(0, A.pClosure - piC.value) / A.V; epsNow = VwCw * Math.max(0, p[p.length - 1] - piC.value) / A.V; }
        return { dg: dg, nol: nol, imp: imp, summary: summary, cart: cart, impB: impB, deriv: deriv, pi: piC, linRun: linRun, radRun: radRun, epsC: epsC, epsNow: epsNow };
    }

    // PRiSM_dfit_aca(run, opts): opts {well, inputs, picks, match:false, matchModels, sigma}
    G.PRiSM_dfit_aca = function (run, opts) {
        try {
            opts = opts || {};
            if (!run || !run.prep || !run.events || run.prep.ok === false || run.events.ok === false) return fail('BAD_INPUT', 'After-closure analysis needs a run with prepared data and events.', ['prep', 'events']);
            var prep = run.prep, ev = run.events, inputs = opts.inputs || {}, iop = (inputs.options && inputs.options.aca) || {};
            var picksA = (opts.picks && opts.picks.aca) || {};
            var well = opts.well || {}, chosen = run.frac && (run.frac.chosen || _firstFamily(run.frac.byFamily));
            if (!chosen || !pos(chosen.dtc)) return fail('NO_CLOSURE', 'No closure is chosen; after-closure analysis needs a closure time.', ['frac']);
            var mu = pos(well.mu) ? well.mu : null, phi = pos(well.phi) ? well.phi : null, ct = pos(well.ct) ? well.ct : null, h = pos(well.h) ? well.h : null;
            var warnings = [];
            if (!mu || !phi || !ct || !h) warnings.push(W('ACA_INPUTS', 'warn', 'Reservoir μ, φ, c_t or h is missing: permeability values are not computed.', ['A1']));
            var tStart = fin(ev.tStart) ? ev.tStart : 0, tcRec = ev.ts + chosen.dtc, tcInj = tcRec - tStart;
            var tpe = fin(ev.ts) ? ev.ts - tStart : 0;
            var origin = picksA.origin || iop.origin || 'centroid';
            var t0 = origin === 'total' ? 0 : origin === 'midInjection' ? tpe / 2 : origin === 'sinceClosure' ? tcInj : tcInj / 3;
            var V = (fin(ev.Vi) ? ev.Vi : 0) - (fin(ev.Vfb) ? ev.Vfb : 0);
            if (!pos(V)) return fail('NO_VOLUME', 'The injected volume net of flowback is not positive.', ['events.Vi']);
            var tInj = [], p = [], i;
            for (i = 0; i < prep.t.length; i++) if (prep.t[i] > tcRec * (1 + 1e-9) + 1e-12 && fin(prep.pw[i])) { tInj.push(prep.t[i] - tStart); p.push(prep.pw[i]); }
            if (tInj.length < 5) return fail('TOO_FEW', 'Fewer than five samples after closure.', ['prep']);
            var geomModel = chosen.geometry && chosen.geometry.model || 'PKN', gm = chosen.geometry && chosen.geometry.byModel ? chosen.geometry.byModel[geomModel] : null;
            var CL = gm && pos(gm.CL) ? gm.CL : null, L = gm ? (pos(gm.xf) ? gm.xf : (pos(gm.R) ? gm.R : null)) : null;
            var isipV = run.isip && fin(run.isip.value) ? run.isip.value : null;
            var hp = inputs.rock && pos(inputs.rock.hp) ? inputs.rock.hp : h;
            var VwCw = pos(chosen.VwCw) ? chosen.VwCw : (pos(ev.VwCwMeasured) ? ev.VwCwMeasured : null);
            var A = { t0: t0, tcInj: tcInj, V: V, LB: pos(iop.LB) ? iop.LB : 0.25, sigma: fin(opts.sigma) ? opts.sigma : prep.sigma, well: { mu: mu, phi: phi, ct: ct, h: h },
                      CL: CL, L: L, hp: hp, pClosure: chosen.pClosure, linWin: picksA.linWin || null, radWin: picksA.radWin || null, carterExactFR: !!iop.carterExactFR,
                      VwCw: VwCw, surface: prep.src === 'surface-converted' };
            var core = _acaCore(tInj, p, A);
            if (core.err) return core.err;
            // gas: adjusted variables, p_i iterated (≤ 3 passes, |Δp_i| < 0.1 psi); forced when (p_c − p_i)/p_i > 0.1 or p_i < 3,000
            var gas = null;
            if (well.fluid === 'gas') {
                var pi0 = core.pi.value, iters = 0, conv = false;
                if ((chosen.pClosure - pi0) / pi0 > 0.1 || pi0 < 3000) {
                    var tAll = [], pAll = [];
                    for (i = 0; i < prep.t.length; i++) if (prep.t[i] - tStart > 0 && fin(prep.pw[i])) { tAll.push(prep.t[i] - tStart); pAll.push(prep.pw[i]); }
                    var piCur = pi0, coreG = null;
                    for (iters = 1; iters <= 3; iters++) {
                        var ga = G.PRiSM_dfit_gasAdjust(tAll, pAll, { pi: piCur, T_F: well.T_F, SG_g: well.SG_g, ct: ct, Sg: well.Sg });
                        if (!ga.ok) { warnings.push(W('GAS_ADJUST', 'warn', 'Gas adjustment unavailable: ' + (ga.errors && ga.errors[0] || ''), ['A1'])); break; }
                        var tcA = interp(tAll, ga.ta, tcInj), off = tAll.length - tInj.length;
                        var A2 = {}; for (var kk in A) A2[kk] = A[kk];
                        A2.ta = ga.ta.slice(off); A2.tcA = tcA; A2.t0 = origin === 'total' ? 0 : origin === 'sinceClosure' ? tcA : origin === 'midInjection' ? interp(tAll, ga.ta, tpe / 2) : tcA / 3;
                        coreG = _acaCore(tInj, ga.pa.slice(off), A2);
                        if (coreG.err) break;
                        var d = Math.abs(coreG.pi.value - piCur); piCur = coreG.pi.value;
                        if (d < 0.1) { conv = true; break; }
                    }
                    if (coreG && !coreG.err) { core = coreG; core._t0 = A2.t0; core._tcA = A2.tcA; }
                    gas = { iterations: Math.min(iters, 3), converged: conv };
                    warnings.push(W('GAS_LABEL', 'info', 'Effective gas permeability; water invasion and imbibition are not modelled.', ['A1']));
                }
            }
            var dg = core.dg, nol = core.nol, imp = core.imp;
            var kh = null;
            if (nol.rad && pos(nol.rad.khmu)) kh = { khmu: nol.rad.khmu, k: pos(nol.rad.k) ? nol.rad.k : 0, biasDirection: 'upper' };
            else if (imp.rad && pos(imp.rad.value)) kh = { khmu: imp.rad.value, k: pos(imp.rad.k) ? imp.rad.k : 0, biasDirection: 'upper' };
            var bounds = null;
            if (!kh && !dg.storage) {
                var Lmax = pos(L) ? 2 * L : null, Amax = Lmax && pos(hp) ? 2 * Lmax * hp : null;
                var sigmaHi = run.consensus && run.consensus.range ? run.consensus.range.hi : chosen.pClosure;
                var isipHi = fin(isipV) ? isipV + (run.isip && fin(run.isip.spread) ? run.isip.spread / 2 : 0) : null;
                var CLlo = CL;                                       // the lowest CL among the family chains (range mode)
                if (run.frac && run.frac.byFamily) Object.keys(run.frac.byFamily).forEach(function (k) {
                    var f = run.frac.byFamily[k], g = f && f.geometry && f.geometry.byModel && f.geometry.byModel[geomModel];
                    if (g && pos(g.CL) && (!CLlo || g.CL < CLlo)) CLlo = g.CL;
                });
                var b = G.PRiSM_dfit_acaBounds({ diag: dg, Lmax: Lmax, Amax: Amax, CL: CL, CLlo: CLlo, pMidHi: fin(isipHi) ? 0.5 * (isipHi + sigmaHi) : null,
                    piLo: core.pi.lo, piHi: core.pi.value, tEnd: tInj[tInj.length - 1], t0: core._t0 != null ? core._t0 : t0, mImpLin: imp.lin ? imp.lin.m : null,
                    phi: phi, mu: mu, ct: ct, h: h, V: V, props: well.fluid === 'gas' ? function (pp) { var g = gasProps(pp, well); return g ? { mu: g.mu, ct: ct } : null; } : null });
                if (b.ok && (b.kLo != null || b.kHi != null)) {
                    bounds = { kLo: b.kLo != null ? b.kLo : 0, kHi: b.kHi != null ? b.kHi : (b.kLo || 0), binding: b.binding, direction: b.direction, dpCL: b.dpCL };
                    if (b.warnings) warnings = warnings.concat(b.warnings);
                }
            }
            var match = null;
            if (opts.match && mu && phi && ct && h) {
                var tArr = core._tcA ? null : tInj;
                if (tArr) {
                    var mt = G.PRiSM_dfit_acaMatch({ t: tInj, p: p, t0: t0, V: V, mu: mu, phi: phi, ct: ct, h: h, tcInj: tcInj, kInit: kh ? kh.k : (nol.lin && nol.lin.k) || 0.01, LInit: L || 100 },
                                                   { models: opts.matchModels, piBracket: [core.pi.lo, core.pi.hi] });
                    match = mt.ok ? mt : null;
                    if (!mt.ok) warnings.push(W('MATCH_FAILED', 'warn', 'Model match: ' + (mt.errors && mt.errors[0] || 'failed'), ['A1']));
                }
            }
            if (dg.storage) warnings.push(W('ACA_STORAGE', 'warn', 'After-closure storage: the derivative stays shallower than −0.4 before any linear segment; straight lines are withheld.', ['A1']));
            if (dg.steepened) warnings.push(W('ACA_STEEP', 'warn', 'The derivative steepens past −1.1 after a regime: penny or spherical flow suspected; no radial kh/μ is reported.', ['A1']));
            var pMid = fin(isipV) ? 0.5 * (isipV + chosen.pClosure) : null;
            var ratios = null;
            if (nol.lin && fin(pMid)) {
                var kForA = kh ? kh.k : (match ? match.best.k : null), AacaR = null;
                if (imp.lin && pos(imp.lin.value) && pos(kForA) && pos(CL)) {
                    var Acarter = V * KC.bbl / (4 * CL * Math.sqrt(tcInj * 60));
                    AacaR = (imp.lin.value / Math.sqrt(kForA)) / Acarter;
                }
                ratios = { AacaOverAcarter: nn(AacaR), lambda: nn(nol.lin.mL / (pMid - core.pi.value)) };
            }
            var regimes = dg.regimes.map(function (r) { return { kind: r.kind, t0: r.t0, t1: r.t1, slope: fin(r.slope) ? r.slope : 0 }; });
            var diag = { x: dg.x, D: dg.D, sD: dg.sD, n: dg.n, piLo: dg.piLo, piHi: dg.piHi, piPoint: dg.piPoint, noiseD: dg.noiseD, regimes: regimes, sequenceOk: dg.sequenceOk, p: dg.p };
            var combined = null;
            if (core.pi && fin(core.pi.lo) && fin(core.pi.hi)) combined = [core.pi.lo, core.pi.hi];
            return {
                ok: true, regimeSummary: core.summary, origin: origin, t0: core._t0 != null ? core._t0 : t0, tcInj: tcInj, V: V, diag: diag,
                nolte: { lin: nol.lin ? { pr: nol.lin.pr, mL: nol.lin.mL, k: nol.lin.k, win: nol.lin.win } : null,
                         rad: nol.rad ? { pr: nol.rad.pr, mR: nol.rad.mR, khmu: nol.rad.khmu, k: nn(nol.rad.k), win: nol.rad.win } : null },
                impulse: { lin: imp.lin ? { pi: imp.lin.pi, m: imp.lin.m, group: 'Ask', value: nn(imp.lin.value) } : null,
                           rad: imp.rad ? { pi: imp.rad.pi, m: imp.rad.m, group: 'khmu', value: nn(imp.rad.value) } : null,
                           sph: imp.sph ? { pi: imp.sph.pi, m: imp.sph.m, group: 'ks', value: nn(imp.sph.value) } : null },
                brackets: { cart: core.cart, imp: core.impB, deriv: core.deriv, combined: combined, edges: { lo: core.pi.edges.lo, hi: core.pi.edges.hi } },
                pi: { value: core.pi.value, lo: core.pi.lo, hi: core.pi.hi, label: core.pi.label, reasons: core.pi.reasons },
                kh: kh, bounds: bounds, match: match, gas: gas, tidalCt: null,
                eps: { atClosure: fin(core.epsC) ? core.epsC : 0, now: fin(core.epsNow) ? core.epsNow : 0 }, ratios: ratios,
                warnings: warnings, ev: ['A1']
            };
        } catch (e) { return fail('ACA_FAILED', e && e.message || e); }
    };
    function _firstFamily(by) { if (!by) return null; var ks = ['F1', 'F2', 'F4', 'F0', 'F3']; for (var i = 0; i < ks.length; i++) if (by[ks[i]]) return by[ks[i]]; return null; }

    // Leak plot (§6.4): linear y = −2·t′^1.5·dp/dt′ = A + B·t′ − 2d·t′^1.5, q_k = (B/A)·V/2 (bbl/h); radial y = −t′²·dp/dt′ =
    // A + B·t′ − d·t′², q_k = (B/A)·V. Huber IRLS with the drift d held by a Gaussian prior N(0, s_d²) (a pseudo-observation),
    // block-bootstrap interval, detection floor at 2σ of B, leak-corrected p_i.
    G.PRiSM_dfit_leakPlot = function (aca, ctx) {
        try {
            ctx = ctx || {};
            if (!aca || aca.ok === false || !aca.diag || !arrOk(aca.diag.x)) return fail('BAD_INPUT', 'The leak plot needs an after-closure result.', ['aca']);
            var dg = aca.diag, x = dg.x, D = dg.D, pArr = dg.p || [], V = pos(ctx.V) ? ctx.V : aca.V;
            var form = ctx.form || ((aca.regimeSummary === 'radial' || aca.regimeSummary === 'linear-radial') ? 'radial' : 'linear');
            var tcI = aca.tcInj, t0 = aca.t0, xMin = 2 * tcI - t0;
            var win = ctx.win || null, idx = [], i;
            for (i = 0; i < x.length; i++) {
                if (!fin(D[i]) || !(D[i] > 0) || !fin(pArr[i])) continue;
                var tI = x[i] + t0;
                if (win) { if (!_inWin(tI, win)) continue; }
                else if (x[i] < xMin) continue;
                idx.push(i);
            }
            if (idx.length < 6) return fail('TOO_FEW', 'Fewer than six points in the leak-plot window (t′ ≥ 2 t_c).', ['win']);
            var lin = form === 'linear';
            // impulse shape ψ normalised to t′^−½ (linear) or 1/t′ (radial) at late time: the exact Carter shapes F_L and F_Rc,
            // so y = (dp/dt′)/ψ′ = A + B·X₁ + d·X₂ with X₁ ≈ t′, X₂ ≈ −2t′^1.5 (linear) or −t′² (radial) — the §6.4 forms
            // without the near-closure curvature of the source
            var psiOf = function (xx) {
                var t = xx + t0; if (!(t > tcI) || !(tcI > 0)) return null;
                var u = Math.sqrt(tcI / t), du = -u / (2 * t), f, df;
                if (lin) { f = Math.asin(u) / Math.sqrt(tcI); df = du / Math.sqrt(1 - u * u) / Math.sqrt(tcI); }
                else { var at = 0.5 * Math.log((1 + u) / (1 - u)); f = u * at / tcI; df = (at + u / (1 - u * u)) * du / tcI; }
                return (fin(f) && fin(df) && df < 0) ? { f: f, df: df } : null;
            };
            idx = idx.filter(function (j) { return !!psiOf(x[j]); });
            if (idx.length < 6) return fail('TOO_FEW', 'Fewer than six points in the leak-plot window after closure.', ['win']);
            var PS = idx.map(function (j) { return psiOf(x[j]); });
            var X = idx.map(function (j, k) { var t = x[j], dfk = PS[k].df; return [1, lin ? -1 / (2 * Math.sqrt(t) * dfk) : -1 / (t * dfk), 1 / dfk]; });
            var Y = idx.map(function (j, k) { return (-D[j] / x[j]) / PS[k].df; });
            var sigma = fin(ctx.sigma) ? ctx.sigma : 0, LB = 0.25;
            var sigY = idx.map(function (j, k) { var sd = sigma > 0 ? sigma / (Math.SQRT2 * LB) : 0; return sd / (x[j] * Math.abs(PS[k].df)); });
            var drift = fin(ctx.driftSpec) ? ctx.driftSpec : 0.02, sd_ = Math.max(drift, 1e-6) / 24;     // psi/h
            var noiseY = median(sigY) || 0;
            function fitW(Yv, wts) {
                var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0], r, c, k;
                for (k = 0; k < Yv.length; k++) { var w = wts[k]; for (r = 0; r < 3; r++) { b[r] += w * X[k][r] * Yv[k]; for (c = 0; c < 3; c++) A[r][c] += w * X[k][r] * X[k][c]; } }
                return { A: A, b: b };
            }
            function solveFit(Yv, sres) {
                var wts = Yv.map(function () { return 1; }), beta = null, inv = null, s2 = 1, it, k;
                for (it = 0; it < 12; it++) {
                    var NE = fitW(Yv, wts), s = Math.max(sres, 1e-12);
                    NE.A[2][2] += 1 / (sd_ * sd_) * s * s;           // prior pseudo-observation on d, scaled to the residual variance
                    var sol = solve(NE.A, NE.b, true); if (!sol) return null;
                    beta = sol.x; inv = sol.inv;
                    var res = Yv.map(function (y, j) { return y - (beta[0] * X[j][0] + beta[1] * X[j][1] + beta[2] * X[j][2]); });
                    var med = median(res), mad = median(res.map(function (r) { return Math.abs(r - med); })) * 1.4826;
                    var noise = noiseY;
                    s2 = Math.max(mad, noise, 1e-9 * Math.abs(beta[0] || 1));
                    var c = 1.345 * s2, nw = res.map(function (r) { var a = Math.abs(r); return a <= c ? 1 : c / a; });
                    var dw = 0; for (k = 0; k < nw.length; k++) dw = Math.max(dw, Math.abs(nw[k] - wts[k]));
                    wts = nw; sres = s2;
                    if (dw < 1e-4) break;
                }
                var cov = inv.map(function (row) { return row.map(function (v) { return v * s2 * s2; }); });
                return { beta: beta, cov: cov, s: s2 };
            }
            var s0 = Math.max(median(sigY) || 0, 1e-9);
            var F = solveFit(Y, s0); if (!F) return fail('LEAK_FIT', 'The leak-plot regression is singular.', []);
            var Aa = F.beta[0], Bb = F.beta[1], dd = F.beta[2];
            var fac = (lin ? V / 2 : V) * 24;
            var qk = Aa !== 0 ? Bb / Aa * fac : 0;
            var seB = Math.sqrt(Math.max(0, F.cov[1][1])), seD = Math.sqrt(Math.max(0, F.cov[2][2]));
            var corrBd = (seB > 0 && seD > 0) ? F.cov[1][2] / (seB * seD) : 0;
            var floor = Aa !== 0 ? Math.abs(2 * seB / Aa * fac) : 0;
            // block bootstrap of the residuals (seeded)
            var r = makeRng(fin(ctx.seed) ? ctx.seed : 1), nB = pos(ctx.nBoot) ? Math.min(400, ctx.nBoot) : 120, res0 = Y.map(function (y, j) { return y - (Aa * X[j][0] + Bb * X[j][1] + dd * X[j][2]); });
            var blk = Math.max(3, Math.round(Y.length / 10)), qs = [];
            for (var bI = 0; bI < nB; bI++) {
                var Yb = [], k2;
                while (Yb.length < Y.length) { var st = Math.floor(r() * Math.max(1, Y.length - blk + 1)); for (k2 = 0; k2 < blk && Yb.length < Y.length; k2++) Yb.push(res0[st + k2]); }
                Yb = Yb.map(function (e, j) { return Aa * X[j][0] + Bb * X[j][1] + dd * X[j][2] + e; });
                var Fb = solveFit(Yb, F.s); if (Fb && Fb.beta[0] !== 0) qs.push(Fb.beta[1] / Fb.beta[0] * fac);
            }
            qs = sortNum(qs);
            var ci = qs.length >= 10 ? [quant(qs, 0.025), quant(qs, 0.975)] : [qk - 2 * floor / 2, qk + 2 * floor / 2];
            if (ci[0] > qk) ci[0] = qk; if (ci[1] < qk) ci[1] = qk;
            var separable = !(Math.abs(corrBd) > 0.95);
            // leak-corrected p_i (linear form p − A/√t′ + B·√t′ − d·t′; radial p − A/t′ + B·ln … uses the same window median)
            var pc = idx.map(function (j, k) { var t = x[j], ps = PS[k].f; return lin ? pArr[j] - Aa * ps + Bb * Math.sqrt(t) - dd * t : pArr[j] - Aa * ps + Bb * Math.log(t) - dd * t; });
            var pu = idx.map(function (j, k) { return pArr[j] - Aa * PS[k].f; });
            var piCorr = median(pc), piUncorr = (aca.pi && fin(aca.pi.value)) ? aca.pi.value : median(pu);
            var tEnd = pos(ctx.tEnd) ? ctx.tEnd : x[x.length - 1], th = fin(ctx.theta) ? ctx.theta : (lin ? 2 : null), qkMax = null;
            if (!fin(th) && !lin) { var eta = (aca.kh && pos(aca.kh.k) && pos(ctx.phi) && pos(ctx.mu) && pos(ctx.ct) && pos(ctx.L)) ? KC.etaC * aca.kh.k / (ctx.phi * ctx.mu * ctx.ct) : null; th = eta ? theta(eta * tEnd / (ctx.L * ctx.L)) : 4; }
            if (typeof G.PRiSM_dfit_leakBudget === 'function' && !G.PRiSM_dfit_leakBudget._dfitStub && ctx.useBudget !== false) {
                try { var lb = G.PRiSM_dfit_leakBudget(V, tEnd, { sigmaP: sigma, VwCw: ctx.VwCw, driftSpec: drift }); if (lb && pos(lb.qkMax)) { qkMax = lb.qkMax; if (fin(lb.theta)) th = lb.theta; } } catch (e) { /* local rule */ }
            }
            if (qkMax == null) qkMax = qkMaxRule(fin(ctx.eps) ? ctx.eps : 0.05, V, th, tEnd);
            var verdict = 'none';
            if (!separable && qk > floor) verdict = 'leak-or-drift';
            else if (ci[0] > 0 && qk > floor) verdict = 'leak';
            else if (qk > 0 && qk <= floor) verdict = 'below-floor';
            return {
                ok: true, form: form, A: Aa, B: Bb, d: dd, dPrior: sd_, corrBd: corrBd, separable: separable, qk: qk, qkCI: ci, floor: floor,
                piCorr: fin(piCorr) ? piCorr : piUncorr, piUncorr: piUncorr,
                windowBiasNote: _txt('A window bias remains in the corrected p_i (a few psi) even with no leak; the floor is ' + fmtSig(floor, 2) + ' bbl/d.'),
                qkMax: fin(qkMax) ? qkMax : 0, theta: fin(th) ? th : 0, verdict: verdict, n: idx.length,
                piCorrSeries: { t: idx.map(function (j) { return x[j] + t0; }), p: pc }
            };
        } catch (e) { return fail('LEAKPLOT_FAILED', e && e.message || e); }
    };

    // k for the RTA fallback (35): reads the active test's summary; {k, kLo, kHi, source} or null
    G.PRiSM_dfit_kConstraint = function () {
        try {
            var st = G.PRiSM_state, d = st && st.dfit;
            if (!d || !Array.isArray(d.tests)) return null;
            var T = null; for (var i = 0; i < d.tests.length; i++) if (d.tests[i] && d.tests[i].id === d.active) { T = d.tests[i]; break; }
            var s = T && T.summary;
            if (!s || s.stale || s.forOtherDataset) return null;
            if (pos(s.k)) return { k: s.k, kLo: pos(s.kLo) ? s.kLo : null, kHi: pos(s.kHi) ? s.kHi : null, source: pos(s.khmu) ? 'aca-radial' : 'aca-match' };
            if (pos(s.kLo) && pos(s.kHi)) return { k: Math.sqrt(s.kLo * s.kHi), kLo: s.kLo, kHi: s.kHi, source: 'bounds' };
            return null;
        } catch (e) { return null; }
    };

    // ═════════════════════════════════════════════════════════════════════
    // Stubs still to be replaced in later WP3 milestones
    // ═════════════════════════════════════════════════════════════════════
    function _ni(name) { return { ok: false, code: 'NOT_IMPLEMENTED', errors: [name + ' is not implemented yet (DFIT WP3 milestone).'], bad: [] }; }
    function _stub(name) { var f = function () { return _ni(name); }; f._dfitStub = true; return f; }
    function _jobStub(name) {
        var f = function () { var r = _ni(name); return { step: function () { return { done: true, progress: 1, label: 'not implemented' }; }, result: function () { return r; }, cancel: function () {} }; };
        f._dfitStub = true; return f;
    }
    ['PRiSM_dfit_pipeline', 'PRiSM_dfit_summarise', 'PRiSM_dfit_uncertainty', 'PRiSM_dfit_replay', 'PRiSM_dfit_evidence', 'PRiSM_dfit_reportModel',
     'PRiSM_dfit_checkQuoted', 'PRiSM_dfit_exportText', 'PRiSM_dfit_fracSheet', 'PRiSM_dfit_handoff'].forEach(function (n) { if (!G[n] || G[n]._dfitStub) G[n] = _stub(n); });
    ['PRiSM_dfit_pipelineJob', 'PRiSM_dfit_uncertaintyJob', 'PRiSM_dfit_replayJob'].forEach(function (n) { if (!G[n] || G[n]._dfitStub) G[n] = _jobStub(n); });
    G.PRiSM_dfit_live = G.PRiSM_dfit_live || {};
    if (!G.PRiSM_dfit_live.create || G.PRiSM_dfit_live.create._dfitStub) G.PRiSM_dfit_live.create = _stub('PRiSM_dfit_live.create');

    // internal helpers shared by the later sections of this file
    G.PRiSM_dfit_acaKernels._h = { fin: fin, pos: pos, nn: nn, rnd: rnd, sig: sig, fail: fail, W: W, txt: _txt, fmt: fmt, fmtSig: fmtSig, clone: clone,
        sortNum: sortNum, quant: quant, median: median, mean: mean, linfit: linfit, interp: interp, makeRng: makeRng, gauss: gauss, hashOf: hashOf, realFn: realFn };
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis, bad = [], K = G.PRiSM_dfit_acaKernels;
    if (Math.abs(K.theta(5) - 4.509) > 0.01) bad.push('theta(5)');
    var tf = G.PRiSM_dfit_timeFns([4], 2);
    if (!tf.ok || Math.abs(tf.FL[0] - 0.5) > 1e-9 || Math.abs(tf.FR[0] / tf.FRc[0] - 0.9538) > 2e-4) bad.push('timeFns');
    if (Math.abs(K.originSlope('sinceClosure', 1.5) + 0.52) > 0.005) bad.push('originSlope');
    if (G.PRiSM_dfit_kConstraint() !== null && !G.PRiSM_state) bad.push('kConstraint');
    if (bad.length && typeof console !== 'undefined') console.warn('[57-prism-dfit-aca self-test] ' + bad.join('; '));
})();
