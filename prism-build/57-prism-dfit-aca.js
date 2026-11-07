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
    // 6. Uncertainty budget and what-if propagator (§6.6)
    // ═════════════════════════════════════════════════════════════════════
    // Closed-form, storage-consistent chain per draw (§4.6, §4.9, §4.10): G_c(σ_c) by monotone interpolation of p(G), η with
    // the matched α (½ here: G type of the run), p_n = ISIP − σ_c, C_sys = η_G·V_i*/p_n, A_f·c_f = C_sys − V_w·c_w,
    // R_vis, PKN xf = A_f·c_f·E′/(π·h_f²), CL = 2·m_G·C_sys/(π·r_p·A_f·√tp[min]), Γ = 2·m_G/(π·√tp[min]),
    // k from CL at Δp_CL = ½·(ISIP + σ_c) − p_r.
    var BBL = KC.bbl;
    function _g1(d) { return 4 / 3 * (Math.pow(1 + d, 1.5) - Math.pow(d, 1.5)); }
    function _G1(d) { return 4 / Math.PI * (_g1(d) - 4 / 3); }
    function _uncCtx(run, opts) {
        var d = run.derivs || {}, ev = run.events || {}, inp = opts.inputs || {}, rock = inp.rock || {}, well = opts.well || {};
        var ch = run.frac && (run.frac.chosen || _firstFamily(run.frac.byFamily)) || {};
        var Garr = [], parr = [], dDarr = [];
        if (arrOk(d.G) && arrOk(d.p)) for (var i = 0; i < d.G.length; i++) if (fin(d.G[i]) && fin(d.p[i]) && (!Garr.length || d.G[i] > Garr[Garr.length - 1])) { Garr.push(d.G[i]); parr.push(d.p[i]); dDarr.push(arrOk(d.dtD) ? d.dtD[i] : null); }
        var tp = pos(d.tp) ? d.tp : (ev.tp && pos(ev.tp.pump) ? ev.tp.pump : null);
        var aca = run.aca && run.aca.ok !== false ? run.aca : null;
        return {
            G: Garr, p: parr, dtD: dDarr, tp: tp, mG: pos(d.mG) ? d.mG : (pos(ch.mG) ? ch.mG : null), alpha: fin(d.alpha) ? d.alpha : 0.5,
            isip: run.isip && fin(run.isip.value) ? run.isip.value : null, isipSd: run.isip && fin(run.isip.spread) ? Math.max(run.isip.spread / 2, 0.5) : 1,
            ViStar: pos(ev.ViStar) ? ev.ViStar : (pos(ch.ViStar) ? ch.ViStar : null),
            VwCw: pos(ch.VwCw) ? ch.VwCw : (pos(ev.VwCwMeasured) ? ev.VwCwMeasured : 0), VwCwTheory: !pos(ev.VwCwMeasured),
            Ep: pos(rock.Ep) ? rock.Ep : null, hf: pos(rock.hf) ? rock.hf : null, hp: pos(rock.hp) ? rock.hp : (pos(rock.hf) ? rock.hf : null),
            barrier: pos(rock.barrierSpacing) ? rock.barrierSpacing : null,
            mu: pos(well.mu) ? well.mu : null, phi: pos(well.phi) ? well.phi : null, ct: pos(well.ct) ? well.ct : null,
            pi: aca && aca.pi && fin(aca.pi.value) ? aca.pi.value : (pos(well.pi) ? well.pi : null),
            piLo: aca && aca.pi ? aca.pi.lo : null, piHi: aca && aca.pi ? aca.pi.hi : null,
            khmu: aca && aca.kh && pos(aca.kh.khmu) ? aca.kh.khmu : null
        };
    }
    function _GcOf(C, pc) {                                         // G at p = σ_c along the recorded falloff (p falls with G)
        var n = C.G.length; if (!n) return pos(C.mG) && fin(C.isip) ? (C.isip - pc) / C.mG : null;
        if (pc >= C.p[0]) return pos(C.mG) && fin(C.isip) ? Math.max(0, (C.isip - pc) / C.mG) : C.G[0];
        if (pc <= C.p[n - 1]) return C.G[n - 1];
        var lo = 0, hi = n - 1; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (C.p[m] >= pc) lo = m; else hi = m; }
        var f = (C.p[lo] - pc) / ((C.p[lo] - C.p[hi]) || 1);
        return C.G[lo] + f * (C.G[hi] - C.G[lo]);
    }
    function _dtDOf(C, Gc) {
        var n = C.G.length, ok = n && C.dtD.every(fin);
        if (ok && Gc >= C.G[0] && Gc <= C.G[n - 1]) return interp(C.G, C.dtD, Gc);
        var lo = Math.log(1e-9), hi = Math.log(1e7), G05 = function (d) { return 4 / Math.PI * ((1 + d) * Math.asin(1 / Math.sqrt(1 + d)) + Math.sqrt(d) - Math.PI / 2); };
        for (var i = 0; i < 100; i++) { var m = 0.5 * (lo + hi); if (G05(Math.exp(m)) < Gc) lo = m; else hi = m; }
        return Math.exp(0.5 * (lo + hi));
    }
    function _chain(pc, C, x) {
        x = x || {};
        var isip = fin(x.isip) ? x.isip : C.isip, Ep = fin(x.Ep) ? x.Ep : C.Ep, hf = fin(x.hf) ? x.hf : C.hf, hp = fin(x.hp) ? x.hp : C.hp;
        var VwCw = fin(x.VwCw) ? x.VwCw : C.VwCw, mu = fin(x.mu) ? x.mu : C.mu, phi = fin(x.phi) ? x.phi : C.phi, ct = fin(x.ct) ? x.ct : C.ct;
        var pi = fin(x.pi) ? x.pi : C.pi, out = { closure: pc };
        var Gc = _GcOf(C, pc);
        if (!fin(isip) || !fin(Gc) || !(Gc > 0) || !pos(C.ViStar) || !pos(C.tp) || !pos(C.mG)) return out;
        var pn = isip - pc; out.pn = pn;
        var dtD = _dtDOf(C, Gc), Gc1 = _G1(dtD);
        var etaG = Gc / (Gc + 2), eta1 = Gc1 / (Gc1 + 16 / (3 * Math.PI));
        out.eta = etaG; out.eta1 = eta1; out.Gc = Gc; out.dtc = dtD * C.tp;
        if (!(pn > 0)) return out;
        var Vs = C.ViStar * BBL, Csys = etaG * Vs / pn, AfCf = Csys - VwCw * BBL, Rvis = AfCf / Csys;
        out.Csys = Csys / BBL; out.AfCf = AfCf / BBL; out.Rvis = Rvis;
        var Vf = AfCf * pn, VLts = Vs * (1 - etaG); out.etaF = Vf + VLts > 0 ? Vf / (Vf + VLts) : null;
        var sqtp = Math.sqrt(C.tp * 60);
        out.Gamma = 2 * C.mG / (Math.PI * sqtp);
        if (pos(Ep) && pos(hf) && AfCf > 0) {
            var rp = Math.min(1, (pos(hp) ? hp : hf) / hf), xf = AfCf * Ep / (Math.PI * hf * hf), Af = 2 * xf * hf;
            out.xf = xf; out.CL = 2 * C.mG * Csys / (Math.PI * rp * Af * sqtp);
            var dpCL = 0.5 * (isip + pc) - pi;
            if (pos(dpCL) && pos(mu) && pos(phi) && pos(ct)) out.k = mu / (phi * ct) * Math.pow(out.CL / (KC.invmL * dpCL), 2);
        }
        if (fin(pi)) out.pi = pi;
        if (pos(C.khmu)) out.khmu = C.khmu;
        return out;
    }
    var OUT_UNITS = { closure: 'psia', pn: 'psi', eta: '–', etaF: '–', Csys: 'bbl/psi', AfCf: 'bbl/psi', Rvis: '–', xf: 'ft', CL: 'ft/√min', Gamma: 'psi/√min', k: 'md', khmu: 'md·ft/cp', pi: 'psia' };
    var CLOSURE_FREE = { Gamma: true, khmu: true, pi: true };
    function _lognormalOf(r, med, sdLn) { return med * Math.exp(sdLn * gauss(r)); }
    function _triangular(r, a, m, b) { var u = r(), F = (m - a) / ((b - a) || 1); return u < F ? a + Math.sqrt(u * (b - a) * (m - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - m)); }
    function _uncSetup(run, opts) {
        opts = opts || {};
        if (!run || !run.derivs || run.derivs.ok === false) return { err: fail('BAD_INPUT', 'The uncertainty needs a run with derivatives.', ['run']) };
        var n = Math.max(100, Math.min(2000, Math.round(fin(opts.n) ? opts.n : 1000))), seed = fin(opts.seed) ? Math.max(1, Math.round(opts.seed)) : 1;
        var C = _uncCtx(run, opts), cons = run.consensus || run.consensusLite || {};
        var mode = cons.mode === 'range' ? 'range' : 'single';
        var wF1 = fin(opts.familyWeightF1) ? Math.max(0, Math.min(1, opts.familyWeightF1)) : 0.5;
        var fixAll = !!opts.fixAll, fixed = {}; (opts.fixed || []).forEach(function (k) { fixed[k] = true; });
        var isFixed = function (k) { return fixAll || fixed[k]; };
        var S = cons.samples || {}, fam = cons.families || {};
        var famSamples = function (F) { return arrOk(S[F]) ? S[F].filter(fin) : []; };
        var centre = fin(cons.value) ? cons.value : (run.frac && run.frac.chosen ? run.frac.chosen.pClosure : null);
        var pools = {};
        if (mode === 'single') {
            var pool = famSamples('F1').concat(famSamples('F2')).concat(famSamples('F4'));
            pools.all = pool;
        } else {
            pools.F1 = famSamples('F1'); pools.F2 = famSamples('F2');
            var f4 = famSamples('F4');
            if (f4.length) { var m4 = median(f4), m1 = median(pools.F1), m2 = median(pools.F2); if (fin(m1) && fin(m2)) (Math.abs(m4 - m1) <= Math.abs(m4 - m2) ? pools.F1 : pools.F2).push.apply(Math.abs(m4 - m1) <= Math.abs(m4 - m2) ? pools.F1 : pools.F2, f4); }
            ['F1', 'F2'].forEach(function (F) { if (!pools[F].length && fam[F] && fin(fam[F].p50)) pools[F] = [fam[F].p50]; });
            if (!pools.F1.length || !pools.F2.length) mode = 'single';
            if (mode === 'single') pools.all = pools.F1.concat(pools.F2);
        }
        var famCentre = { F1: median(pools.F1 || []), F2: median(pools.F2 || []) };
        var inputs = [], add = function (name, dist, params, prov) { inputs.push({ name: name, dist: isFixed(name) ? 'fixed' : dist, params: params, provenance: prov }); };
        add('closure', 'empirical', { samples: mode === 'single' ? (pools.all || []).length : (pools.F1.length + pools.F2.length), mode: mode }, 'stability');
        if (fin(C.isip)) add('isip', 'normal', { mu: C.isip, sd: C.isipSd }, 'dfit');
        if (pos(C.Ep)) add('Ep', 'lognormal', { p50: C.Ep, sdLn: 0.15 }, 'user');
        if (pos(C.hf)) add('hf', 'triangular', { a: pos(C.hp) ? Math.min(C.hp, C.hf) : C.hf * 0.8, m: C.hf, b: pos(C.barrier) ? Math.max(C.barrier, C.hf) : 1.5 * C.hf }, 'user');
        if (pos(C.hp)) add('hp', 'uniform', { lo: 0.9 * C.hp, hi: 1.1 * C.hp }, 'user');
        if (pos(C.mu)) add('mu', 'lognormal', { p50: C.mu, sdLn: 0.1 }, 'C1');
        if (pos(C.ct)) add('ct', 'lognormal', { p50: C.ct, sdLn: 0.3 }, 'C1');
        if (pos(C.phi)) add('phi', 'lognormal', { p50: C.phi, sdLn: 0.1 }, 'C1');
        if (pos(C.VwCw)) add('VwCw', 'normal', { mu: C.VwCw, sd: (C.VwCwTheory ? 0.5 : 0.1) * C.VwCw }, C.VwCwTheory ? 'theory' : 'ramp');
        if (fin(C.pi)) add('pi', 'normal', { mu: C.pi, sd: fin(C.piLo) && fin(C.piHi) ? Math.max(0.5, (C.piHi - C.piLo) / 4) : 5, lo: C.piLo, hi: C.piHi }, 'after-closure');
        add('tp', 'fixed', { choice: 'pump' }, 'events');
        var byName = {}; inputs.forEach(function (it) { byName[it.name] = it; });
        var rho = fin(opts.rhoPhiCt) ? opts.rhoPhiCt : -0.3;
        return { C: C, n: n, seed: seed, mode: mode, wF1: wF1, pools: pools, famCentre: famCentre, centre: centre, inputs: inputs, byName: byName, rho: rho,
                 draws: { all: [], F1: [], F2: [] }, rngs: mode === 'single' ? { all: makeRng(seed) } : { F1: makeRng(seed), F2: makeRng(seed + 7919) },
                 targets: mode === 'single' ? { all: n } : { F1: Math.ceil(n / 2), F2: Math.floor(n / 2) }, counts: { draws: 0, chainEvals: 0, ops: 0 },
                 opts: opts };
    }
    function _drawX(U, key) {
        var r = U.rngs[key], C = U.C, b = U.byName, x = {}, it;
        var pool = key === 'all' ? U.pools.all : U.pools[key];
        it = b.closure;
        if (it.dist === 'fixed' || !pool || !pool.length) x.closure = key === 'all' ? U.centre : U.famCentre[key];
        else x.closure = pool[Math.min(pool.length - 1, Math.floor(r() * pool.length))];
        var z1 = gauss(r), z2 = gauss(r), zz = U.rho * z1 + Math.sqrt(1 - U.rho * U.rho) * z2;   // φ–c_t correlation
        function num(name, f) { var q = b[name]; if (!q) return; x[name] = q.dist === 'fixed' ? q.params.mu != null ? q.params.mu : q.params.p50 != null ? q.params.p50 : q.params.m : f(q.params); }
        num('isip', function (p) { return p.mu + p.sd * gauss(r); });
        num('Ep', function (p) { return _lognormalOf(r, p.p50, p.sdLn); });
        num('hf', function (p) { return _triangular(r, p.a, p.m, p.b); });
        if (b.hp) x.hp = b.hp.dist === 'fixed' ? C.hp : b.hp.params.lo + r() * (b.hp.params.hi - b.hp.params.lo);
        num('mu', function (p) { return _lognormalOf(r, p.p50, p.sdLn); });
        if (b.ct) x.ct = b.ct.dist === 'fixed' ? C.ct : b.ct.params.p50 * Math.exp(b.ct.params.sdLn * zz);
        if (b.phi) x.phi = b.phi.dist === 'fixed' ? C.phi : b.phi.params.p50 * Math.exp(b.phi.params.sdLn * z1);
        num('VwCw', function (p) { return Math.max(0, p.mu + p.sd * gauss(r)); });
        num('pi', function (p) { var v = p.mu + p.sd * gauss(r); if (fin(p.lo) && v < p.lo) v = p.lo; if (fin(p.hi) && v > p.hi) v = p.hi; return v; });
        if (x.hp != null && x.hf != null && x.hp > x.hf) x.hp = x.hf;
        return x;
    }
    function _uncStep(U, k) {                                       // up to k draws; returns true when all are done
        var keys = Object.keys(U.targets), done = true;
        for (var a = 0; a < keys.length && k > 0; a++) {
            var key = keys[a];
            while (U.draws[key].length < U.targets[key] && k > 0) {
                var x = _drawX(U, key), y = _chain(x.closure, U.C, x);
                U.counts.draws++; U.counts.chainEvals++; U.counts.ops++;
                U.draws[key].push({ x: x, y: y }); k--;
            }
            if (U.draws[key].length < U.targets[key]) done = false;
        }
        for (var b2 = 0; b2 < keys.length; b2++) if (U.draws[keys[b2]].length < U.targets[keys[b2]]) done = false;
        return done;
    }
    // first-order variance index by 20 quantile bins of each input (no extra runs)
    function _shares(xs, ys, nBins, opsBox) {
        var n = ys.length; if (n < 4) return 0;
        var m = 0, i; for (i = 0; i < n; i++) m += ys[i]; m /= n;
        var vt = 0; for (i = 0; i < n; i++) vt += (ys[i] - m) * (ys[i] - m); vt /= n;
        if (!(vt > 1e-300)) return 0;
        var idx = []; for (i = 0; i < n; i++) idx.push(i);
        idx.sort(function (a, b) { if (opsBox) opsBox.n++; return xs[a] - xs[b]; });
        var B = Math.min(nBins || 20, n), vb = 0;
        for (var b = 0; b < B; b++) {
            var i0 = Math.floor(b * n / B), i1 = Math.floor((b + 1) * n / B); if (i1 <= i0) continue;
            var s = 0; for (i = i0; i < i1; i++) s += ys[idx[i]];
            var mb = s / (i1 - i0); vb += (i1 - i0) / n * (mb - m) * (mb - m);
        }
        return Math.max(0, Math.min(1, vb / vt));
    }
    function _p3(vals, opsBox) {
        var v = vals.filter(fin); if (!v.length) return null;
        v.sort(function (a, b) { if (opsBox) opsBox.n++; return a - b; });
        return { p10: quant(v, 0.1), p50: quant(v, 0.5), p90: quant(v, 0.9) };
    }
    function _uncFinish(U) {
        var opsBox = { n: 0 }, outputs = {}, keys = Object.keys(OUT_UNITS), names = U.inputs.filter(function (it) { return it.dist !== 'fixed'; }).map(function (it) { return it.name; });
        var single = U.mode === 'single', wF = { F1: U.wF1, F2: 1 - U.wF1 };
        keys.forEach(function (k) {
            var o = { unit: OUT_UNITS[k], shares: [], closureShare: 0, bimodal: false, byFamily: null, envelope: null, p10: null, p50: null, p90: null };
            if (single || CLOSURE_FREE[k]) {
                var D = single ? U.draws.all : U.draws.F1.concat(U.draws.F2), ys = [], X = {};
                D.forEach(function (d) { if (fin(d.y[k])) { ys.push(d.y[k]); names.forEach(function (nm) { (X[nm] = X[nm] || []).push(d.x[nm]); }); } });
                if (!ys.length) return;
                var q = _p3(ys, opsBox); o.p10 = q.p10; o.p50 = q.p50; o.p90 = q.p90;
                names.forEach(function (nm) { var s = _shares(X[nm], ys, 20, opsBox); o.shares.push({ input: nm, s: rnd(s, 4) }); if (nm === 'closure') o.closureShare = rnd(s, 4); });
            } else {
                var fams = {}, allY = [], allW = [], within = {};
                ['F1', 'F2'].forEach(function (F) {
                    var ys2 = [], X2 = {};
                    U.draws[F].forEach(function (d) { if (fin(d.y[k])) { ys2.push(d.y[k]); names.forEach(function (nm) { (X2[nm] = X2[nm] || []).push(d.x[nm]); }); } });
                    fams[F] = { ys: ys2, q: _p3(ys2, opsBox) };
                    within[F] = names.map(function (nm) { return _shares(X2[nm] || [], ys2, 20, opsBox); });
                    ys2.forEach(function (y) { allY.push(y); allW.push(wF[F] / Math.max(1, ys2.length)); });
                });
                if (!fams.F1.q || !fams.F2.q) return;
                o.bimodal = true;
                o.byFamily = { F1: fams.F1.q, F2: fams.F2.q };
                // envelope [P10 of the low family, P90 of the high family]; when the family columns overlap, the outer edges
                o.envelope = [Math.min(fams.F1.q.p10, fams.F2.q.p10), Math.max(fams.F1.q.p90, fams.F2.q.p90)];
                // interpretation share: between-family variance of the weighted mixture over its total variance
                var mT = 0, wT = 0, i;
                for (i = 0; i < allY.length; i++) { mT += allW[i] * allY[i]; wT += allW[i]; }
                mT = wT > 0 ? mT / wT : 0;
                var vT = 0; for (i = 0; i < allY.length; i++) vT += allW[i] * (allY[i] - mT) * (allY[i] - mT); vT = wT > 0 ? vT / wT : 0;
                var vB = 0; ['F1', 'F2'].forEach(function (F) { var mf = mean(fams[F].ys); if (fin(mf)) vB += wF[F] * (mf - mT) * (mf - mT); });
                var share = vT > 0 ? Math.max(0, Math.min(1, vB / vT)) : 0;
                o.closureShare = rnd(share, 4);
                names.forEach(function (nm, j) {
                    var s = (1 - share) * (wF.F1 * within.F1[j] + wF.F2 * within.F2[j]);
                    o.shares.push({ input: nm, s: rnd(Math.max(0, Math.min(1, s)), 4) });
                });
            }
            outputs[k] = o;
        });
        // tornado: one-at-a-time P10 / P90 of each input, others central (per family in range mode)
        var tornado = [], C = U.C, centres = single ? { all: U.centre } : { F1: U.famCentre.F1, F2: U.famCentre.F2 };
        var tOut = ['closure', 'pn', 'eta', 'xf', 'CL'];
        Object.keys(centres).forEach(function (fk) {
            var pc = centres[fk]; if (!fin(pc)) return;
            U.inputs.forEach(function (it) {
                if (it.dist === 'fixed' || it.name === 'closure' || it.name === 'tp') return;
                var lo = {}, hi = {}, pp = it.params;
                if (it.dist === 'normal') { lo[it.name] = pp.mu - 1.2816 * pp.sd; hi[it.name] = pp.mu + 1.2816 * pp.sd; }
                else if (it.dist === 'lognormal') { lo[it.name] = pp.p50 * Math.exp(-1.2816 * pp.sdLn); hi[it.name] = pp.p50 * Math.exp(1.2816 * pp.sdLn); }
                else if (it.dist === 'uniform') { lo[it.name] = pp.lo + 0.1 * (pp.hi - pp.lo); hi[it.name] = pp.lo + 0.9 * (pp.hi - pp.lo); }
                else if (it.dist === 'triangular') { lo[it.name] = pp.a + Math.sqrt(0.1 * (pp.b - pp.a) * (pp.m - pp.a)); hi[it.name] = pp.b - Math.sqrt(0.1 * (pp.b - pp.a) * (pp.b - pp.m)); }
                var ylo = _chain(pc, C, lo), yhi = _chain(pc, C, hi); U.counts.chainEvals += 2;
                tOut.forEach(function (ok) {
                    if (fin(ylo[ok]) && fin(yhi[ok]) && ylo[ok] !== yhi[ok]) tornado.push(Object.assign({ output: ok, input: it.name, lo: ylo[ok], hi: yhi[ok] }, single ? {} : { family: fk }));
                });
            });
        });
        U.counts.ops += opsBox.n;
        var log = [];
        if (fin(U.opts.prevFamilyWeightF1) && Math.abs(U.opts.prevFamilyWeightF1 - U.wF1) > 1e-12)
            log.push({ item: 'options.familyWeightF1', old: U.opts.prevFamilyWeightF1, new: U.wF1, reason: 'Interpretive weight, not a probability.' });
        return {
            ok: true, n: U.n, seed: U.seed, mode: U.mode, familyWeight: { F1: U.wF1, F2: 1 - U.wF1 },
            inputs: U.inputs.map(function (it) { return { name: it.name, dist: it.dist, params: it.params, provenance: it.provenance }; }),
            outputs: outputs, tornado: tornado, ev: ['U1'], counts: { draws: U.counts.draws, chainEvals: U.counts.chainEvals, ops: U.counts.ops }, log: log,
            note: U.mode === 'range' ? 'Range mode: closure-dependent outputs are given per family; the family weight is an interpretive weight, not a probability.' : null
        };
    }
    G.PRiSM_dfit_uncertainty = function (run, opts) {
        try {
            var U = _uncSetup(run, opts); if (U.err) return U.err;
            _uncStep(U, Infinity);
            return _uncFinish(U);
        } catch (e) { return fail('UNC_FAILED', e && e.message || e); }
    };
    G.PRiSM_dfit_uncertaintyJob = function (run, opts) {
        var U = null, done = false, cancelled = false, res = null;
        try { U = _uncSetup(run, opts); } catch (e) { U = { err: fail('UNC_FAILED', e && e.message || e) }; }
        if (U.err) { done = true; res = U.err; }
        return {
            step: function () {
                if (done || cancelled) return { done: true, progress: 1, label: cancelled ? 'cancelled' : 'done' };
                try { if (_uncStep(U, 250)) { done = true; res = _uncFinish(U); } } catch (e) { done = true; res = fail('UNC_FAILED', e && e.message || e); }
                return { done: done, progress: done ? 1 : U.counts.draws / U.n, label: 'draws ' + U.counts.draws + ' of ' + U.n };
            },
            result: function () { return res || fail('CANCELLED', 'The uncertainty run was cancelled.', []); },
            cancel: function () { cancelled = true; }
        };
    };
    G.PRiSM_dfit_uncertainty.chain = function (pc, run, opts, x) { return _chain(pc, _uncCtx(run, opts || {}), x || {}); };
    G.PRiSM_dfit_uncertainty.shares = function (xs, ys, nBins) { return _shares(xs, ys, nBins || 20); };

    // ═════════════════════════════════════════════════════════════════════
    // 7. Live engine and replay (§6.9)
    // ═════════════════════════════════════════════════════════════════════
    // A session keeps the samples in time order (out-of-order and duplicate samples are merged; psig is converted with
    // the test's atmPsia), resamples the falloff with the pressure-increment rule (|Δp| ≥ dpMin or Δln Δt ≥ 0.01), uses the
    // closed-form G (α = ½), fits the early G line p = ISIP − m_G·G on the first third of the G range (frozen once a
    // departure is called), and runs a one-sided CUSUM on the pressure residuals r = p − (ISIP − m_G·G), made close to
    // independent by decimation to one point per 2L in ln G (default) or by lag-1 prewhitening when the decimated series
    // has fewer than 30 points before the departure. σ includes the line's own parameter variance at G.
    function _G05(d) { return d > 0 ? 4 / Math.PI * ((1 + d) * Math.asin(1 / Math.sqrt(1 + d)) + Math.sqrt(d) - Math.PI / 2) : 0; }
    function _G05inv(Gv) { var lo = Math.log(1e-9), hi = Math.log(1e7); for (var i = 0; i < 100; i++) { var m = 0.5 * (lo + hi); if (_G05(Math.exp(m)) < Gv) lo = m; else hi = m; } return Math.exp(0.5 * (lo + hi)); }
    function _lagK(a, K) {
        var v = a.filter(fin), n = v.length; if (n < K + 3) return null;
        var m = mean(v), num = 0, den = 0, i;
        for (i = 0; i < n; i++) den += (v[i] - m) * (v[i] - m);
        for (i = K; i < n; i++) num += (v[i] - m) * (v[i - K] - m);
        return den > 0 ? num / den : null;
    }
    function _lag1(a) { return _lagK(a, 1); }
    function _liveCreate(ctx) {
        ctx = ctx || {};
        var T = ctx.test || {}, inp = T.inputs || {}, ch = inp.channels || {}, opt = inp.options || {}, ev = inp.events || {};
        var atm = fin(ch.atmPsia) ? ch.atmPsia : 14.696, L = pos(opt.L) ? opt.L : 0.1;
        var cus = ctx.cusum || {}, kC = fin(cus.k) ? cus.k : 0.5, hC = fin(cus.h) ? cus.h : 5;
        var cal = G.PRiSM_dfit_cal; if (!ctx.cusum && cal && cal.cusum) { if (fin(cal.cusum.k)) kC = cal.cusum.k; if (fin(cal.cusum.h)) hC = cal.cusum.h; }
        var pri = inp.priors || {}, datum = inp.datumTvd;
        var prior = ctx.sigmaPrior || (pos(pri.sigmaGrad) && pos(datum) ? { p50: pri.sigmaGrad * datum, sd: (pos(pri.sigmaGradSd) ? pri.sigmaGradSd : 0.02) * datum } : null);
        if (!prior && ctx.plan && ctx.plan.ranges && ctx.plan.ranges.sigmaGrad && pos(ctx.plan.ranges.datumTvd)) prior = { p50: ctx.plan.ranges.sigmaGrad.p50 * ctx.plan.ranges.datumTvd, sd: ctx.plan.ranges.sigmaGrad.sd * ctx.plan.ranges.datumTvd };
        var S = { t: [], p: [], q: [], T: [] }, timeline = [], last = null, frozen = null, closedAt = null, stats = null, firsts = {};
        var tStart0 = fin(ctx.tStart) ? ctx.tStart : (fin(ev.tStart) ? ev.tStart : null), ts0 = fin(ctx.ts) ? ctx.ts : (fin(ev.ts) ? ev.ts : null), tp0 = pos(ctx.tp) ? ctx.tp : null;
        var sigmaG = fin(ctx.sigma) && ctx.sigma > 0 ? ctx.sigma : 0;
        function insert(t, p, q, Tm) {
            var n = S.t.length, lo = 0, hi = n;
            while (lo < hi) { var m = (lo + hi) >> 1; if (S.t[m] < t) lo = m + 1; else hi = m; }
            if (lo < n && Math.abs(S.t[lo] - t) < 1e-12) { if (fin(q) && !fin(S.q[lo])) S.q[lo] = q; return false; }   // duplicate
            S.t.splice(lo, 0, t); S.p.splice(lo, 0, p); S.q.splice(lo, 0, fin(q) ? q : null); S.T.splice(lo, 0, fin(Tm) ? Tm : null);
            return true;
        }
        function events() {
            var n = S.t.length, qmax = 0, i, tS = tStart0, tSh = ts0;
            for (i = 0; i < n; i++) if (fin(S.q[i]) && S.q[i] > qmax) qmax = S.q[i];
            if (qmax > 0) {
                if (tS == null) for (i = 0; i < n; i++) if (fin(S.q[i]) && S.q[i] > 0.02 * qmax) { tS = S.t[i]; break; }
                if (tSh == null) {
                    var lastOn = -1; for (i = 0; i < n; i++) if (fin(S.q[i]) && S.q[i] > 0.05 * qmax) lastOn = i;
                    if (lastOn >= 0 && lastOn < n - 1) { for (i = lastOn + 1; i < n; i++) if (fin(S.q[i])) break; if (i < n) tSh = S.t[lastOn]; }
                }
            }
            var tp = tp0 || (tS != null && tSh != null && tSh > tS ? tSh - tS : null);
            return { tStart: tS, ts: tSh, tp: tp };
        }
        function verdictOf(state, t, fam, p, fc, text, evs) { return { t: t, state: state, family: fam, p: fin(p) ? p : null, forecast: fc, text: _txt(text), ev: evs || [] }; }
        function run() {
            var E = events(), n = S.t.length, tNow = n ? S.t[n - 1] : 0;
            if (E.ts == null || !pos(E.tp) || n < 3) { last = verdictOf('none', tNow, null, n ? S.p[n - 1] : null, null, 'Waiting for the shut-in.', []); return record(last); }
            // falloff, resampled (pressure increment or 1 % in ln Δt)
            var dpMin = fin(ctx.dpMin) ? ctx.dpMin : Math.max(0.05, 3 * sigmaG), F = { dt: [], p: [], t: [] }, lastP = null, lastL = null, i;
            for (i = 0; i < n; i++) {
                var dt = S.t[i] - E.ts; if (!(dt > 0)) continue;
                var l = Math.log(dt);
                // 1 % in Δt, with rounding slack
                if (lastP == null || Math.abs(S.p[i] - lastP) >= dpMin || l - lastL >= 0.0099) { F.dt.push(dt); F.p.push(S.p[i]); F.t.push(S.t[i]); lastP = S.p[i]; lastL = l; }
            }
            if (F.dt.length < 8) { last = verdictOf('continue', tNow, null, S.p[n - 1], null, 'Continue: too few falloff samples yet.', []); return record(last); }
            var Gs = F.dt.map(function (d) { return _G05(d / E.tp); }), Gnow = Gs[Gs.length - 1], gMin = 0.05;
            // samples used from G ≥ 0.05; the initial line on G ≤ G0 = max(0.5, min(2, G_now/3)) gives ρ (lag-1 of its residuals)
            var keep = [], i2;
            for (i = 0; i < Gs.length; i++) if (Gs[i] >= gMin) keep.push(i);
            if (keep.length < 8) { last = verdictOf('continue', tNow, null, S.p[n - 1], null, 'Continue: the early G line is not defined yet.', []); return record(last); }
            var G0 = Math.max(0.5, Math.min(2, Gnow / 3)), X0 = [], Y0 = [];
            keep.forEach(function (ii) { if (Gs[ii] <= G0) { X0.push(Gs[ii]); Y0.push(F.p[ii]); } });
            var fit0 = X0.length >= 5 ? linfit(X0, Y0) : null;
            if (!fit0 || !(fit0.m < 0)) { last = verdictOf('continue', tNow, null, S.p[n - 1], null, 'Continue: no falling G line yet.', []); return record(last); }
            var res0 = Y0.map(function (y, q) { return y - (fit0.b + fit0.m * X0[q]); });
            var rho = _lag1(res0), rr2 = _lagK(res0, 2);                     // AR part under white gauge noise: ρ ≈ r₂/r₁
            if (fin(rho) && fin(rr2) && rho > 0.2 && rr2 > 0) rho = Math.max(rho, Math.min(0.95, rr2 / rho));
            rho = fin(rho) ? Math.max(-0.95, Math.min(0.95, rho)) : 0;
            // the line's parameter variance is inflated by n/n_eff = (1 + ρ)/(1 − ρ) for serially correlated noise
            var infl = rho > 0 ? Math.min(50, (1 + rho) / (1 - rho)) : 1, p00 = Y0[0];
            // running least squares over the samples before a candidate point (recursive residuals: each candidate is predicted
            // from the line through all earlier data, leaving a gap of one 2L block, so a line error does not accumulate)
            var R = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }, fp = 0;
            var addTo = function (Gv) { while (fp < keep.length && Gs[keep[fp]] <= Gv) { var gx = Gs[keep[fp]], py = F.p[keep[fp]] - p00; R.n++; R.sx += gx; R.sy += py; R.sxx += gx * gx; R.sxy += gx * py; R.syy += py * py; fp++; } };
            var lineOf = function () {
                if (R.n < 20) return null;
                var mx = R.sx / R.n, my = R.sy / R.n, Sxx = R.sxx - R.n * mx * mx, Sxy = R.sxy - R.n * mx * my, Syy = R.syy - R.n * my * my;
                if (!(Sxx > 0)) return null;
                var m = Sxy / Sxx, b = my - m * mx + p00, s2v = Math.max(0, (Syy - m * Sxy) / Math.max(1, R.n - 2));
                return { m: m, b: b, s2: Math.max(s2v, sigmaG * sigmaG, 1e-8), xb: mx, sxx: Sxx, n: R.n, gMax: fp > 0 ? Gs[keep[fp - 1]] : 0 };
            };
            var lineVarOf = function (ln, Gv) { return ln.s2 * infl * (1 / ln.n + (Gv - ln.xb) * (Gv - ln.xb) / ln.sxx); };
            // candidates: one point per 2L in ln G (decimation, the default) or 2L blocks of prewhitened innovations when the
            // decimated series before the departure would be short (< 30 points) and the residuals are correlated
            var dec = [], lastLG = -Infinity;
            keep.forEach(function (ii, k) { var lg = Math.log(Gs[ii]); if (lg >= lastLG + 2 * L) { dec.push(k); lastLG = lg; } });
            var useWhite = dec.length < 30 && Math.abs(rho) > 0.2;
            var Sp = 0, Sm = 0, alarm = null, sgnA = 0, seqN = 0, lnA = null;
            if (!frozen) {
                var cands = [];
                if (useWhite) {
                    var blk = null;
                    for (var k = 1; k < keep.length; k++) {
                        var lgk = Math.log(Gs[keep[k]]);
                        if (!blk || lgk >= blk.lg0 + 2 * L) { blk = { lg0: lgk, k0: k, k1: k }; cands.push(blk); }
                        blk.k1 = k;
                    }
                } else dec.forEach(function (k) { cands.push({ k0: k, k1: k, lg0: Math.log(Gs[keep[k]]) }); });
                for (var c = 0; c < cands.length && !alarm; c++) {
                    var cd = cands[c], Gc0 = Gs[keep[cd.k0]];
                    addTo(Gc0 * Math.exp(-2 * L));
                    var ln = lineOf();
                    // detection starts once the line spans G 0.05 … ≥ 2 and the candidate lies beyond G 3
                    if (!ln || ln.gMax < 2 || Gc0 < 3 || !(ln.m < 0)) continue;
                    var zc;
                    if (useWhite) {
                        var s = 0, mm = 0, rPrev = F.p[keep[cd.k0 - 1]] - (ln.b + ln.m * Gs[keep[cd.k0 - 1]]);
                        for (var kq = cd.k0; kq <= cd.k1; kq++) { var rq = F.p[keep[kq]] - (ln.b + ln.m * Gs[keep[kq]]); s += rq - rho * rPrev; rPrev = rq; mm++; }
                        var Gm = Gs[keep[cd.k1]], vz = mm * ln.s2 * (1 - rho * rho) + mm * mm * (1 - rho) * (1 - rho) * lineVarOf(ln, Gm);
                        zc = s / Math.sqrt(Math.max(vz, 1e-12));
                    } else {
                        var Gq = Gs[keep[cd.k0]], rq2 = F.p[keep[cd.k0]] - (ln.b + ln.m * Gq);
                        zc = rq2 / Math.sqrt(ln.s2 + lineVarOf(ln, Gq));
                    }
                    seqN++;
                    Sp = Math.max(0, Sp + zc - kC); Sm = Math.max(0, Sm - zc - kC);
                    if (Sp > hC || Sm > hC) { alarm = cd; sgnA = Sp > hC ? 1 : -1; lnA = ln; }
                }
                if (alarm) frozen = { line: lnA, tA: F.t[keep[alarm.k1]], sgn: sgnA, Gw: lnA.gMax };
            }
            // statistics of the pre-departure residuals (about the line through all of them): ρ, decimated and prewhitened lag-1
            addTo(frozen ? frozen.line.gMax : Gnow);
            var lnAll = frozen ? frozen.line : lineOf();
            if (lnAll) {
                var rPre = [], rDec = [];
                keep.forEach(function (ii, k) { if (Gs[ii] <= lnAll.gMax) { var v0 = F.p[ii] - (lnAll.b + lnAll.m * Gs[ii]); rPre.push(v0); if (dec.indexOf(k) >= 0) rDec.push(v0); } });
                stats = { rho1: rho, useWhite: useWhite, decLag1: _lag1(rDec), whiteLag1: _lag1(rPre.slice(1).map(function (v, q) { return v - rho * rPre[q]; })),
                          nDec: rDec.length, isip: lnAll.b, mG: -lnAll.m, Gw: lnAll.gMax, candidates: seqN };
            }
            var lnF = frozen ? frozen.line : (lnAll || { b: fit0.b, m: fit0.m, s2: Math.max(fit0.sigma * fit0.sigma, 1e-8), xb: mean(X0), sxx: 1, n: X0.length, gMax: G0 });
            var isip = lnF.b, mG = -lnF.m, Gw = lnF.gMax;
            var r = keep.map(function (ii) { return F.p[ii] - (isip - mG * Gs[ii]); });
            var sigAt = function (Gv) { return Math.sqrt(Math.max(lnF.s2 + (lnF.sxx > 0 ? lineVarOf(lnF, Gv) : 0), sigmaG * sigmaG, 1e-6)); };
            if (frozen) { sgnA = frozen.sgn; alarm = { k1: 0 }; for (var ka = 0; ka < keep.length; ka++) if (F.t[keep[ka]] >= frozen.tA - 1e-12) { alarm.k1 = ka; break; } }
            // forecast before closure: G_c = (ISIP − σ_prior)/m_G at σ_prior ± sd
            var fc = null;
            if (prior && pos(mG)) {
                var Ghi = (isip - (prior.p50 - prior.sd)) / mG, Glo = (isip - (prior.p50 + prior.sd)) / mG;
                if (Glo > 0 && Ghi > 0) fc = { lo: E.tp * _G05inv(Glo), hi: E.tp * _G05inv(Ghi) };
            }
            if (!alarm) {
                var txt = fc ? 'Continue: closure expected ' + fmt(fc.lo, 1) + '–' + fmt(fc.hi, 1) + ' h after shut-in.' : 'Continue: closure not yet seen.';
                last = verdictOf('continue', tNow, null, S.p[n - 1], fc, txt, []);
                return record(last);
            }
            // change point on the full-resolution residuals: back from the alarm while |r| > 2σ on the alarm side
            var kA = alarm.k1, kD = kA;
            while (kD > 0 && sgnA * r[kD - 1] > 2 * sigAt(Gs[keep[kD - 1]]) && Gs[keep[kD - 1]] > Gw) kD--;
            // the departure starts where the residual leaves the line (first point of the run beyond 2σ, stepped back once)
            if (kD > 0 && Gs[keep[kD - 1]] > Gw) kD--;
            var iD = keep[kD], tDep = F.t[iD], pDep = F.p[iD], GD = Gs[iD];
            // confirmed when the departure is held over ≥ 0.05 in log G (≥ 90 % of the points since beyond 2σ, on the same side)
            var held = 0, tot2 = 0, tConf = null, tProv = F.t[keep[kA]];
            for (var kk = kD; kk < r.length; kk++) {
                tot2++; if (sgnA * r[kk] > 2 * sigAt(Gs[keep[kk]])) held++;
                if (tConf == null && kk >= kA && Math.log10(Gs[keep[kk]] / GD) >= 0.05 && held / tot2 >= 0.9 && Math.log10(Gw / gMin) >= 0.3) tConf = F.t[keep[kk]];
            }
            var confirmed = tConf != null && held / tot2 >= 0.9;
            closedAt = { t: tDep, dt: tDep - E.ts, p: pDep, G: GD, tProvisional: tProv, tConfirmed: tConf };
            if (!confirmed) {
                last = verdictOf('provisional', tNow, 'F1', pDep, fc, 'Contact reading (family F1) provisional at ' + fmt(pDep, 0) + ' psia.', ['C2']);
                last.tProv = tProv;
                return record(last);
            }
            // after closure: p_i bracket (and the radial check) on the injection clock with the centroid origin
            var out = verdictOf('confirmed', tNow, 'F1', pDep, null, 'Contact reading (family F1) confirmed: ' + fmt(pDep, 0) + ' psia.', ['C2']);
            out.tProv = tProv; out.tConf = tConf;
            if (E.tStart != null) {
                var tcInj = tDep - E.tStart, t0 = tcInj / 3, ta = [], pa = [];
                for (i = 0; i < n; i++) if (S.t[i] > tDep * 1.0001) { ta.push(S.t[i] - E.tStart); pa.push(S.p[i]); }
                if (ta.length >= 8 && Math.log10((ta[ta.length - 1] - t0) / (ta[0] - t0)) >= 0.3) {
                    var dg = G.PRiSM_dfit_acaDiag(ta, pa, { t0: t0, LB: 0.25, sigma: sigmaG });
                    if (dg && dg.ok !== false) {
                        var lo = null, hi = null, sEnd = null;
                        for (i = dg.x.length - 1; i >= 0; i--) { if (lo == null && fin(dg.piLo[i])) { lo = dg.piLo[i]; hi = dg.piHi[i]; } if (sEnd == null && fin(dg.sD[i])) sEnd = dg.sD[i]; if (lo != null && sEnd != null) break; }
                        if (lo != null) {
                            var hw = (hi - lo) / 2;
                            out.piHalfWidth = hw; out.pi = { lo: lo, hi: hi };
                            if (hw <= 25) { out = verdictOf('enough-pi', tNow, 'F1', 0.5 * (lo + hi), null, 'Enough for p_i ± ' + fmt(Math.max(1, Math.ceil(hw)), 0) + ' psi (' + fmt(lo, 0) + '–' + fmt(hi, 0) + ' psia).', ['A1']); out.piHalfWidth = hw; }
                        }
                        if (fin(sEnd) && sEnd <= -0.9) out.radialSeen = true;
                    }
                }
            }
            var pl = ctx.plan;
            if (pl && pl.tRadial && pos(pl.allowedShutInD) && fin(pl.tRadial.p10) && pl.tRadial.p10 > pl.allowedShutInD * 24 && out.state === 'confirmed')
                out = verdictOf('radial-unreachable', tNow, 'F1', pDep, null, 'Radial flow is not reachable in the allowed time: plan for bounds on k.', ['A1']);
            if (pl && pl.corridor && arrOk(pl.corridor.t) && pl.corridor.t.length > 1) {
                var outN = 0, tot = 0, tLo = Math.max(1e-6, (tNow - E.ts) / 10);
                for (i = 0; i < F.dt.length; i++) if (F.dt[i] >= tLo) { var c10 = interp(pl.corridor.t, pl.corridor.p10, F.dt[i]), c90 = interp(pl.corridor.t, pl.corridor.p90, F.dt[i]); tot++; if (F.p[i] < Math.min(c10, c90) || F.p[i] > Math.max(c10, c90)) outN++; }
                if (tot > 5 && outN / tot > 0.1) out = verdictOf('outside-corridor', tNow, null, S.p[n - 1], null, 'Outside the designer corridor: check the gauge.', []);
            }
            out.tProv = tProv; out.tConf = tConf;
            last = out;
            return record(last);
        }
        // timeline of state transitions; the "first available" times use the sample at which a call became true
        // (inside a block), not the end of the block
        function record(v) {
            var prev = timeline.length ? timeline[timeline.length - 1] : null;
            if (fin(v.tProv) && firsts.closureProvisional == null) firsts.closureProvisional = v.tProv;
            if (fin(v.tConf) && firsts.closureConfirmed == null) firsts.closureConfirmed = v.tConf;
            var vv = clone(v); delete vv.tProv; delete vv.tConf; delete vv.piHalfWidth; delete vv.radialSeen; delete vv.pi;
            if (!prev || prev.state !== v.state) {
                if (v.state !== 'provisional' && v.state !== 'continue' && v.state !== 'none' && prev && prev.state === 'continue' && fin(v.tProv))
                    timeline.push(Object.assign(clone(vv), { t: v.tProv, state: 'provisional', text: _txt('Contact reading (family F1) provisional at ' + fmt(v.p, 0) + ' psia.') }));
                timeline.push(vv);
            }
            if (v.state === 'provisional' && firsts.closureProvisional == null) firsts.closureProvisional = v.t;
            if ((v.state === 'confirmed' || v.state === 'enough-pi' || v.state === 'radial-unreachable') && firsts.closureConfirmed == null) firsts.closureConfirmed = v.t;
            if (fin(v.piHalfWidth) && v.piHalfWidth <= 25 && firsts.piW25 == null) firsts.piW25 = v.t;
            if (fin(v.piHalfWidth) && v.piHalfWidth <= 10 && firsts.piW10 == null) firsts.piW10 = v.t;
            if (v.radialSeen && firsts.radialSeen == null) firsts.radialSeen = v.t;
            return v;
        }
        return {
            push: function (samples) {
                var added = 0;
                (samples || []).forEach(function (s) {
                    if (!s || !fin(s.t) || !fin(s.p)) return;
                    var p = s.p + ((s.unit === 'psig' || (ctx.psig && s.unit !== 'psia')) ? atm : 0);
                    if (insert(s.t, p, s.q, s.T)) added++;
                });
                return { changed: added > 0, added: added };
            },
            run: run,
            verdict: function () { return last ? clone(last) : verdictOf('none', 0, null, null, null, 'No data yet.', []); },
            timeline: function () { return clone(timeline); },
            firsts: function () { return { closureProvisional: nn(firsts.closureProvisional), closureConfirmed: nn(firsts.closureConfirmed), piW25: nn(firsts.piW25), piW10: nn(firsts.piW10), radialSeen: nn(firsts.radialSeen) }; },
            closure: function () { return closedAt ? clone(closedAt) : null; },
            stats: function () { return stats ? clone(stats) : null; },
            size: function () { return S.t.length; },
            close: function () { S = { t: [], p: [], q: [], T: [] }; frozen = null; }
        };
    }
    G.PRiSM_dfit_live = G.PRiSM_dfit_live || {};
    G.PRiSM_dfit_live.create = function (ctx) { try { return _liveCreate(ctx); } catch (e) { return fail('LIVE_FAILED', e && e.message || e); } };

    function _replaySetup(ds, ctx) {
        ctx = ctx || {};
        if (!ds || !arrOk(ds.t) || !arrOk(ds.p) || ds.t.length !== ds.p.length) return { err: fail('BAD_INPUT', 'Replay needs a dataset with t and p.', ['ds']) };
        var ses = _liveCreate(ctx), block = pos(ctx.block) ? Math.round(ctx.block) : 50, rows = [];
        for (var i = 0; i < ds.t.length; i++) rows.push({ t: ds.t[i], p: ds.p[i], q: ds.q && fin(ds.q[i]) ? ds.q[i] / 1440 : null, T: ds.T && fin(ds.T[i]) ? ds.T[i] : null, unit: ctx.unit || null });
        return { ses: ses, rows: rows, block: block, i: 0 };
    }
    function _replayStep(R) { var end = Math.min(R.rows.length, R.i + R.block); R.ses.push(R.rows.slice(R.i, end)); R.i = end; R.ses.run(); return R.i >= R.rows.length; }
    function _replayFinish(R) { return { ok: true, timeline: R.ses.timeline(), firsts: R.ses.firsts(), tEnd: R.rows.length ? R.rows[R.rows.length - 1].t : 0, closure: R.ses.closure(), verdict: R.ses.verdict() }; }
    G.PRiSM_dfit_replay = function (ds, ctx) {
        try { var R = _replaySetup(ds, ctx); if (R.err) return R.err; var guard = 0; while (!_replayStep(R) && guard++ < 1e6); return _replayFinish(R); }
        catch (e) { return fail('REPLAY_FAILED', e && e.message || e); }
    };
    G.PRiSM_dfit_replayJob = function (ds, ctx) {
        var R = null, done = false, cancelled = false, res = null;
        try { R = _replaySetup(ds, ctx); } catch (e) { R = { err: fail('REPLAY_FAILED', e && e.message || e) }; }
        if (R.err) { done = true; res = R.err; }
        return {
            step: function () {
                if (done || cancelled) return { done: true, progress: 1, label: cancelled ? 'cancelled' : 'done' };
                try { if (_replayStep(R)) { done = true; res = _replayFinish(R); } } catch (e) { done = true; res = fail('REPLAY_FAILED', e && e.message || e); }
                return { done: done, progress: R.rows.length ? R.i / R.rows.length : 1, label: 'samples ' + R.i + ' of ' + R.rows.length };
            },
            result: function () { return res || fail('CANCELLED', 'The replay was cancelled.', []); },
            cancel: function () { cancelled = true; }
        };
    };

    // ═════════════════════════════════════════════════════════════════════
    // 8. Results layer: evidence index, report model, quoted-value check, data + picks export, frac sheet, hand-off,
    //    summary, grade fallback (§6.10, §6.8, §2.10, §2.11, §3.3)
    // ═════════════════════════════════════════════════════════════════════
    var EV_GROUPS = 'QXEIHSGCKMFALUPO';
    var EV_TITLES = { Q: 'Triage', X: 'Conversion', E: 'Events', I: 'ISIP', H: 'Water hammer', S: 'Step tests and ramps', G: 'Pre-closure derivatives',
                      C: 'Closure', K: 'Confidence rule', M: 'Leak-off type', F: 'Fracture outputs', A: 'After-closure', L: 'Leak-off model',
                      U: 'Uncertainty', P: 'Plan', O: 'Overrides' };
    var EV_RE = /^[QXEIHSGCKMFALUPO]\d+$/;
    function _getPath(o, path) {
        if (!path) return o;
        var parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.'), a = o;
        for (var i = 0; i < parts.length; i++) { if (a == null) return undefined; a = a[parts[i]]; }
        return a;
    }
    function _evValues(o, id) {
        var V = [], v = function (label, value, unit, dp) { if (value != null && (fin(value) || typeof value === 'string')) V.push({ label: label, value: fin(value) ? +value : String(value).slice(0, 80), unit: unit, dp: dp }); };
        if (!o || typeof o !== 'object') return V;
        if (id === 'C1' && o.mode) { if (fin(o.value)) v('closure', o.value, 'psia', 0); if (o.range) { v('lo', o.range.lo, 'psia', 0); v('hi', o.range.hi, 'psia', 0); } v('mode', o.mode, '', 0); return V; }
        if (fin(o.value) && o.candidates) { v('ISIP', o.value, 'psia', 0); v('spread', o.spread, 'psi', 1); return V; }
        if (o.pi && o.regimeSummary) { v('p_i', o.pi.value, 'psia', 0); if (o.kh) v('kh/μ', o.kh.khmu, 'md·ft/cp', 2); else if (o.bounds) { v('k_lo', o.bounds.kLo, 'md', 6); v('k_hi', o.bounds.kHi, 'md', 6); } v('regime', o.regimeSummary, '', 0); return V; }
        if (o.geometry && fin(o.pClosure)) { v('closure', o.pClosure, 'psia', 0); v('p_n', o.pn, 'psi', 0); if (o.eta) v('η', o.eta.a05, '', 3); if (o.geometry.byModel && o.geometry.byModel.PKN) v('xf', o.geometry.byModel.PKN.xf, 'ft', 0); return V; }
        if (fin(o.n) && fin(o.seed) && o.outputs) { v('n', o.n, 'draws', 0); v('seed', o.seed, '', 0); return V; }
        if (fin(o.mG) && arrOk(o.G)) { v('m_G', o.mG, 'psi', 2); v('α', o.alpha, '', 2); return V; }
        if (o.tp && fin(o.Vi)) { v('tp', o.tp.pump * 60, 'min', 1); v('V_i', o.Vi, 'bbl', 1); return V; }
        if (o.light) { v('light', o.light, '', 0); return V; }
        if (o.type && o.scores) { v('type', o.type, '', 0); return V; }
        if (o.method && fin(o.p)) { v('p', o.p, 'psia', 0); v('G', o.G, '', 2); return V; }
        if (o.method && fin(o.value)) { v(o.method, o.value, 'psia', 1); return V; }
        if (o.id && /^K/.test(o.id)) { v('value', o.value, '', 3); v('threshold', o.threshold, '', 3); return V; }
        if (fin(o.value)) v('value', o.value, '', 3);
        return V;
    }
    function _evText(o, g) {
        var t = null;
        if (o) {
            if (typeof o.why === 'string') t = o.why; else if (arrOk(o.why) && o.why.length) t = o.why[0];
            if (!t && typeof o.text === 'string') t = o.text;
            if (!t && arrOk(o.evidence) && o.evidence.length) t = typeof o.evidence[0] === 'string' ? o.evidence[0] : o.evidence[0].text;
            if (!t && o.pi && arrOk(o.pi.reasons) && o.pi.reasons.length) t = o.pi.reasons[0];
            if (!t && typeof o.preferredWhy === 'string') t = o.preferredWhy;
        }
        return _txt(t || (EV_TITLES[g] + ' result of this run.'));
    }
    G.PRiSM_dfit_evidence = function (run) {
        try {
            if (!run || typeof run !== 'object') return fail('BAD_INPUT', 'The evidence index needs a run.', ['run']);
            var items = {}, seen = {};
            function add(id, o, path) {
                if (!EV_RE.test(id) || items[id]) return;
                var g = id[0], ttl = EV_TITLES[g] + (o && o.method ? ': ' + o.method : (o && o.title ? ': ' + o.title : (g === 'K' && o && o.id ? ' ' + o.id : '')));
                items[id] = { id: id, group: g, title: _txt(ttl), values: _evValues(o, id), path: path, text: _evText(o, g) };
            }
            function walk(o, path, depth) {
                if (!o || typeof o !== 'object' || depth > 6 || seen[path]) return;
                seen[path] = true;
                if (arrOk(o)) { if (o.length > 0 && typeof o[0] === 'object') for (var i = 0; i < Math.min(o.length, 200); i++) walk(o[i], path + '[' + i + ']', depth + 1); return; }
                if (typeof o.id === 'string' && EV_RE.test(o.id) && o.id[0] === 'K') add(o.id, o, path);
                if (arrOk(o.ev)) o.ev.forEach(function (id) { add(id, o, path); });
                for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && k !== 'ev' && k !== 'evidence' && k !== 'report' && k !== 'summary' && k !== 'samples' && k !== 'stability' && o[k] && typeof o[k] === 'object')
                    walk(o[k], path ? path + '.' + k : k, depth + 1);
                if (arrOk(o.evidence)) o.evidence.forEach(function (e, i) { if (e && arrOk(e.ev)) e.ev.forEach(function (id) { add(id, o, path); }); });
            }
            ['triage', 'prep', 'events', 'isip', 'derivs', 'picks', 'consensus', 'consensusLite', 'classification', 'frac', 'whatIf', 'aca', 'leak', 'unc', 'warnings']
                .forEach(function (k) { if (run[k] != null) walk(run[k], k, 0); });
            var order = Object.keys(items).sort(function (a, b) { var ga = EV_GROUPS.indexOf(a[0]), gb = EV_GROUPS.indexOf(b[0]); return ga !== gb ? ga - gb : (+a.slice(1)) - (+b.slice(1)); });
            return { items: items, order: order };
        } catch (e) { return fail('EVIDENCE_FAILED', e && e.message || e); }
    };

    function _closureOf(run) {
        var c = run.consensus || run.consensusLite || {};
        return { mode: c.mode || 'none', value: fin(c.value) ? c.value : null, range: c.range || null, label: run.consensus ? run.consensus.confidence : 'low',
                 families: c.families || {}, preferred: run.consensus ? run.consensus.preferred : null };
    }
    function _localGrade(run) {
        var tri = run.triage, cl = _closureOf(run), aca = run.aca && run.aca.ok !== false ? run.aca : null, why = [];
        var light = tri && tri.light ? tri.light : null, piL = aca && aca.pi ? aca.pi.label : null;
        var letter = 'D';
        if (cl.mode !== 'none') letter = 'C';
        if (cl.mode !== 'none' && light !== 'red' && aca) letter = 'B';
        if (cl.mode === 'single' && (cl.label === 'high' || cl.label === 'medium') && light !== 'red' && light !== 'amber' && (piL === 'high' || piL === 'medium')) letter = 'A';
        why.push('Triage ' + (light || 'not run') + '; closure ' + (cl.mode === 'single' ? 'single with label ' + cl.label : cl.mode === 'range' ? 'a range (' + cl.label + ')' : 'not estimable') + ' (uncalibrated); p_i label ' + (piL || 'not available') + '.');
        return { letter: letter, why: why.map(_txt) };
    }
    function _gradeOf(run) {
        if (realFn(G.PRiSM_dfit_grade)) {
            try { var g = G.PRiSM_dfit_grade(run.triage, run.consensus, run.aca); if (g && /^[ABCD]$/.test(g.letter) && arrOk(g.why)) return { letter: g.letter, why: g.why.map(_txt) }; } catch (e) { /* fallback */ }
        }
        return _localGrade(run);
    }

    // ── report model ──
    function _evOk(EVI, ids) { return (ids || []).filter(function (id) { return EVI && EVI.items[id]; }); }
    G.PRiSM_dfit_reportModel = function (run, opts) {
        try {
            opts = opts || {};
            if (!run || typeof run !== 'object') return fail('BAD_INPUT', 'The report model needs a run.', ['run']);
            var EVI = run.evidence && run.evidence.items ? run.evidence : G.PRiSM_dfit_evidence(run);
            if (!EVI || !EVI.items) EVI = { items: {}, order: [] };
            var groups = opts.groups || null, want = function (id) { return !groups || groups.indexOf(id) >= 0 || groups.indexOf(id.replace('dfit-', '')) >= 0; };
            var cl = _closureOf(run), ch = run.frac ? run.frac.chosen : null, aca = run.aca && run.aca.ok !== false ? run.aca : null;
            var isip = run.isip && run.isip.ok !== false ? run.isip : null, unc = run.unc && run.unc.ok !== false ? run.unc : null;
            var grade = run.grade && /^[ABCD]$/.test(run.grade.letter) ? run.grade : _gradeOf(run);
            var quotes = [], sections = [];
            function sec(id, title, order) { var s = { id: id, title: title, order: order, blocks: [] }; sections.push(s); return s; }
            function q(s, b, r, c, path, dp, ref) { quotes.push({ ref: ref, s: sections.indexOf(s), b: b, r: r, c: c, path: path, dp: dp }); }
            function kvRow(s, blk, label, val, dp, unit, path, ev) {
                var text = fin(val) ? fmt(val, dp) + (unit ? ' ' + unit : '') : '–';
                blk.rows.push([label, text, _evOk(EVI, ev)]);
                if (fin(val) && path) q(s, s.blocks.indexOf(blk), blk.rows.length - 1, 1, path, dp, label);
            }
            var piHalf = aca && aca.pi && fin(aca.pi.hi) && fin(aca.pi.lo) ? Math.round((aca.pi.hi - aca.pi.lo) / 2) : null;
            var piTxt = aca && aca.pi ? 'p_i ' + fmt(aca.pi.value, 0) + (piHalf != null ? ' ±' + piHalf : '') + ' psia' : 'p_i not available';
            var keyLine = cl.mode === 'single' ? 'DFIT · closure ' + fmt(cl.value, 0) + ' psia (single, ' + cl.label + ') · ' + piTxt
                : cl.mode === 'range' ? 'DFIT · closure range ' + fmt(cl.range.lo, 0) + '–' + fmt(cl.range.hi, 0) + ' psia (medians ' + fmt(cl.range.medians ? cl.range.medians.low : null, 0) + ' / ' + fmt(cl.range.medians ? cl.range.medians.high : null, 0) + '; ' + cl.label + ') · ' + piTxt
                : 'DFIT · closure not estimable · ' + piTxt;
            var keyRows = [
                ['Closure', cl.mode === 'single' ? fmt(cl.value, 0) + ' psia (single, ' + cl.label + ', uncalibrated)' : cl.mode === 'range' ? fmt(cl.range.lo, 0) + '–' + fmt(cl.range.hi, 0) + ' psia (range, ' + cl.label + ')' : 'not estimable'],
                ['ISIP', isip ? fmt(isip.value, 0) + ' psia' : '–'],
                ['Net pressure', ch && fin(ch.pn) ? fmt(ch.pn, 0) + ' psi' : (cl.mode === 'range' ? 'per family (range mode)' : '–')],
                ['p_i', aca && aca.pi ? fmt(aca.pi.value, 0) + ' psia (' + aca.pi.label + ')' : '–'],
                ['Grade', grade.letter]
            ];
            // 10 headline
            if (want('dfit-headline')) {
                var s1 = sec('dfit-headline', 'DFIT headline', 10), kv = { kind: 'kv', rows: [] }; s1.blocks.push(kv);
                if (cl.mode === 'single') kvRow(s1, kv, 'Closure', cl.value, 0, 'psia', run.consensus ? 'consensus.value' : 'consensusLite.value', ['C1']);
                else if (cl.mode === 'range') { kvRow(s1, kv, 'Closure (low end)', cl.range.lo, 0, 'psia', (run.consensus ? 'consensus' : 'consensusLite') + '.range.lo', ['C1']); kvRow(s1, kv, 'Closure (high end)', cl.range.hi, 0, 'psia', (run.consensus ? 'consensus' : 'consensusLite') + '.range.hi', ['C1']); }
                else kv.rows.push(['Closure', 'not estimable', _evOk(EVI, ['C1'])]);
                if (isip) kvRow(s1, kv, 'ISIP', isip.value, 0, 'psia', 'isip.value', ['I1']);
                if (ch) { kvRow(s1, kv, 'Net pressure', ch.pn, 0, 'psi', 'frac.chosen.pn', ['F1']); kvRow(s1, kv, 'Efficiency (α = ' + (ch.eta && ch.eta.alphaUsed === 1 ? '1' : '½') + ')', ch.eta ? ch.eta.matched : null, 3, '', 'frac.chosen.eta.matched', ['F1']);
                          kvRow(s1, kv, 'Closure gradient', ch.gradClosure, 3, 'psi/ft', 'frac.chosen.gradClosure', ['F1']); }
                if (aca && aca.pi) kvRow(s1, kv, 'p_i', aca.pi.value, 0, 'psia', 'aca.pi.value', ['A1']);
                if (aca && aca.kh) kvRow(s1, kv, 'kh/μ (late radial)', aca.kh.khmu, 2, 'md·ft/cp', 'aca.kh.khmu', ['A1']);
                else if (aca && aca.bounds) { kvRow(s1, kv, 'k lower bound', aca.bounds.kLo, 6, 'md', 'aca.bounds.kLo', ['A1']); kvRow(s1, kv, 'k upper bound', aca.bounds.kHi, 6, 'md', 'aca.bounds.kHi', ['A1']); }
                kv.rows.push(['Grade', grade.letter, []]);
                if (unc) {
                    var outs = [['Closure', 'closure', 'C1'], ['Net pressure', 'pn', 'F1'], ['Efficiency', 'eta', 'F1'], ['xf (PKN)', 'xf', 'F1'], ['CL', 'CL', 'F1'], ['p_i', 'pi', 'A1']];
                    if (unc.mode === 'range') {
                        var tb = { kind: 'table', head: ['Output', 'F1 P10', 'F1 P50', 'F1 P90', 'F2 P10', 'F2 P50', 'F2 P90', 'Unit', 'Ev.'], ev: true, rows: [] };
                        outs.forEach(function (o) { var u = unc.outputs[o[1]]; if (!u) return; var bf = u.byFamily; var ev = _evOk(EVI, [o[2]]);
                            if (bf) tb.rows.push([o[0], sig(bf.F1.p10, 5), sig(bf.F1.p50, 5), sig(bf.F1.p90, 5), sig(bf.F2.p10, 5), sig(bf.F2.p50, 5), sig(bf.F2.p90, 5), u.unit, ev.join(' ')]);
                            else tb.rows.push([o[0], sig(u.p10, 5), sig(u.p50, 5), sig(u.p90, 5), null, null, null, u.unit, ev.join(' ')]); });
                        s1.blocks.push(tb);
                    } else {
                        var tb2 = { kind: 'table', head: ['Output', 'P10', 'P50', 'P90', 'Unit', 'Ev.'], ev: true, rows: [] };
                        outs.forEach(function (o) { var u = unc.outputs[o[1]]; if (!u) return; tb2.rows.push([o[0], sig(u.p10, 5), sig(u.p50, 5), sig(u.p90, 5), u.unit, _evOk(EVI, [o[2]]).join(' ')]); });
                        s1.blocks.push(tb2);
                    }
                }
                var vl = cl.mode === 'single' ? (cl.label === 'high' ? 'ok' : 'warn') : cl.mode === 'range' ? 'warn' : 'bad';
                var vt = cl.mode === 'single' ? '✓ Closure ' + fmt(cl.value, 0) + ' psia (single, ' + cl.label + ', uncalibrated).'
                    : cl.mode === 'range' ? '⚠ Closure is a range ' + fmt(cl.range.lo, 0) + '–' + fmt(cl.range.hi, 0) + ' psia: every closure-dependent value is given per family.'
                    : '✗ No closure can be estimated from this falloff.';
                if (vl !== 'ok' && cl.mode === 'single') vt = '⚠' + vt.slice(1);
                s1.blocks.push({ kind: 'verdict', level: vl, text: _txt(vt) });
            }
            // 11 closure board
            if (want('dfit-board') && arrOk(run.picks) && run.picks.length) {
                var s2 = sec('dfit-board', 'Closure board', 11), tbB = { kind: 'table', head: ['Method', 'Family', 'Vote', 'Closure (psia)', 'P10', 'P90', 'Ev.'], ev: true, rows: [] };
                s2.blocks.push(tbB);
                run.picks.forEach(function (p, i) {
                    tbB.rows.push([p.method, p.family, p.vote ? 'yes' : 'no', rnd(p.p, 0), p.band ? rnd(p.band.p10, 0) : null, p.band ? rnd(p.band.p90, 0) : null, _evOk(EVI, p.ev).join(' ')]);
                    if (fin(p.p)) q(s2, 0, tbB.rows.length - 1, 3, 'picks[' + i + '].p', 0, 'pick ' + p.method);
                });
                if (run.consensus && run.consensus.counterfactual && run.consensus.counterfactual.text) s2.blocks.push({ kind: 'notes', text: _txt(run.consensus.counterfactual.text) });
                s2.blocks.push({ kind: 'plot', key: 'dfitG', title: 'G-function plot' }, { kind: 'plot', key: 'dfitStrip', title: 'Closure strip' });
            }
            // 12 what-if
            if (want('dfit-whatif') && arrOk(run.whatIf) && run.whatIf.length) {
                var s3 = sec('dfit-whatif', 'What-if closure table', 12), tbW = { kind: 'table', head: ['Candidate', 'Family', 'Closure (psia)', 'G_c', 'η', 'p_n (psi)', 'C_sys (bbl/psi)', 'R_vis', 'xf (ft)', 'CL (ft/√min)', 'Ev.'], ev: true, rows: [] };
                s3.blocks.push(tbW);
                run.whatIf.forEach(function (w) {
                    var pk = w.geometry && w.geometry.byModel ? w.geometry.byModel.PKN : null;
                    tbW.rows.push([w.label || '', w.family || '–', rnd(w.pClosure, 0), rnd(w.Gc, 2), rnd(w.eta ? w.eta.matched : null, 3), rnd(w.pn, 0), sig(w.Csys, 4), rnd(w.Rvis, 3), pk ? rnd(pk.xf, 1) : null, pk ? sig(pk.CL, 4) : null, _evOk(EVI, w.ev).join(' ')]);
                });
                s3.blocks.push({ kind: 'notes', text: 'Each row is the consistent chain of one closure candidate; values are never mixed between rows.' });
            }
            // 13 after-closure
            if (want('dfit-aca') && aca) {
                var s4 = sec('dfit-aca', 'After-closure analysis', 13), kvA = { kind: 'kv', rows: [] }; s4.blocks.push(kvA);
                kvA.rows.push(['Regime', aca.regimeSummary, _evOk(EVI, ['A1'])]);
                kvA.rows.push(['Time origin', aca.origin + ' (t0 ' + fmt(aca.t0, 3) + ' h)', _evOk(EVI, ['A1'])]);
                kvRow(s4, kvA, 'p_i (' + aca.pi.label + ')', aca.pi.value, 0, 'psia', 'aca.pi.value', ['A1']);
                kvRow(s4, kvA, 'p_i bracket low', aca.pi.lo, 0, 'psia', 'aca.pi.lo', ['A1']); kvRow(s4, kvA, 'p_i bracket high', aca.pi.hi, 0, 'psia', 'aca.pi.hi', ['A1']);
                if (aca.kh) { kvRow(s4, kvA, 'kh/μ', aca.kh.khmu, 2, 'md·ft/cp', 'aca.kh.khmu', ['A1']); kvRow(s4, kvA, 'k (kh/μ·μ/h)', aca.kh.k, 4, 'md', 'aca.kh.k', ['A1']); }
                if (aca.nolte && aca.nolte.lin && fin(aca.nolte.lin.k)) kvRow(s4, kvA, 'k (F_L line, CL)', aca.nolte.lin.k, 6, 'md', 'aca.nolte.lin.k', ['A1']);
                if (aca.bounds) { kvRow(s4, kvA, 'k lower bound', aca.bounds.kLo, 6, 'md', 'aca.bounds.kLo', ['A1']); kvRow(s4, kvA, 'k upper bound', aca.bounds.kHi, 6, 'md', 'aca.bounds.kHi', ['A1']);
                                  kvA.rows.push(['Binding', aca.bounds.binding.map(function (b) { return b.edge + ': ' + b.rule; }).join('; '), _evOk(EVI, ['A1'])]); }
                var tbBr = { kind: 'table', head: ['Bracket', 'Low (psia)', 'High (psia)'], ev: false, rows: [] };
                [['Cartesian', aca.brackets.cart], ['Impulse', aca.brackets.imp], ['Derivative', aca.brackets.deriv], ['Combined', aca.brackets.combined]].forEach(function (b) { if (b[1]) tbBr.rows.push([b[0], rnd(b[1][0], 1), rnd(b[1][1], 1)]); });
                s4.blocks.push(tbBr);
                if (run.leak && run.leak.ok) s4.blocks.push({ kind: 'verdict', level: run.leak.verdict === 'leak' ? 'bad' : run.leak.verdict === 'leak-or-drift' ? 'warn' : 'ok',
                    text: _txt((run.leak.verdict === 'leak' ? '✗ Leak ' : run.leak.verdict === 'leak-or-drift' ? '⚠ Leak or drift (not separable): ' : '✓ No leak above the floor: ') + 'q_k ' + fmtSig(run.leak.qk, 2) + ' bbl/d against q_k,max ' + fmtSig(run.leak.qkMax, 2) + ' bbl/d (Θ ' + fmt(run.leak.theta, 1) + ').') });
                s4.blocks.push({ kind: 'notes', text: 'Δp_CL = ½·(ISIP + σ_c) − p_r is used for every CL ↔ k conversion (fracture outputs, after-closure bounds and the leak-off model). ' + (aca.pi.reasons || []).join(' ') });
                s4.blocks.push({ kind: 'plot', key: 'dfitAcaLogLog', title: 'After-closure log-log' }, { kind: 'plot', key: 'dfitPiTraj', title: 'p_i trajectory' });
            }
            // 14 leak-off type
            if (want('dfit-type') && run.classification && run.classification.ok !== false) {
                var c = run.classification, s5 = sec('dfit-type', 'Leak-off type', 14), kvT = { kind: 'kv', rows: [] }; s5.blocks.push(kvT);
                kvT.rows.push(['Type', c.type + (c.alt && c.alt.length ? ' (alternative: ' + c.alt.join(', ') + ')' : ''), _evOk(EVI, c.ev)]);
                if (c.features) kvT.rows.push(['R_vis', fin(c.features.Rvis) ? fmt(c.features.Rvis, 3) : '–', _evOk(EVI, c.ev)]);
                if (arrOk(c.evidence) && c.evidence.length) s5.blocks.push({ kind: 'notes', text: c.evidence.map(_txt).join(' ') });
            }
            // 15 triage
            if (want('dfit-triage') && run.triage && run.triage.ok !== false) {
                var tr = run.triage, s6 = sec('dfit-triage', 'Test triage', 15), tbQ = { kind: 'table', head: ['Check', 'Level', 'Value', 'Note', 'Ev.'], ev: true, rows: [] };
                s6.blocks.push(tbQ);
                (tr.checks || []).forEach(function (k) { tbQ.rows.push([k.title, k.level, fin(k.value) ? k.value : (typeof k.value === 'string' ? k.value : null), _txt(k.text), _evOk(EVI, k.ev).join(' ')]); });
                s6.blocks.push({ kind: 'verdict', level: tr.light === 'green' ? 'ok' : tr.light === 'amber' ? 'warn' : 'bad', text: _txt((tr.light === 'green' ? '✓ ' : tr.light === 'amber' ? '⚠ ' : '✗ ') + 'Triage ' + tr.light + ': the test is ' + tr.verdict + '.') });
            }
            // 16 step tests
            if (want('dfit-steps') && run.events && arrOk(run.events.steps) && run.events.steps.length) {
                var s7 = sec('dfit-steps', 'Step tests and ramps', 16), tbS = { kind: 'table', head: ['Step', 'Rate (bbl/min)', 'Settled p (psia)', 'Direction'], ev: false, rows: [] };
                s7.blocks.push(tbS);
                run.events.steps.forEach(function (st, i) { tbS.rows.push([String(i + 1), rnd(st.q, 3), rnd(st.pSettled, 1), st.dir]); });
            }
            // 17 leak-off model (from the stored fit of the test)
            if (want('dfit-model') && opts.lk && opts.lk.fit) {
                var s8 = sec('dfit-model', 'Leak-off model', 17), kvL = { kind: 'kv', rows: [] }; s8.blocks.push(kvL);
                var fp = opts.lk.fit.params || {};
                Object.keys(fp).forEach(function (k) { kvL.rows.push([k, fin(fp[k]) ? fmtSig(fp[k], 4) : '–', []]); });
                if (opts.lk.fit.groups) kvL.rows.push(['Γ', fin(opts.lk.fit.groups.Gamma) ? fmt(opts.lk.fit.groups.Gamma, 2) + ' psi/√min' : '–', []]);
            }
            // 18 uncertainty
            if (want('dfit-unc') && unc) {
                var s9 = sec('dfit-unc', 'Uncertainty', 18), tbU = unc.mode === 'range'
                    ? { kind: 'table', head: ['Output', 'F1 P10–P90', 'F2 P10–P90', 'Envelope', 'Unit', 'Interpretation share', 'Ev.'], ev: true, rows: [] }
                    : { kind: 'table', head: ['Output', 'P10', 'P50', 'P90', 'Unit', 'Largest driver', 'Ev.'], ev: true, rows: [] };
                s9.blocks.push(tbU);
                Object.keys(unc.outputs).forEach(function (k) {
                    var u = unc.outputs[k], drv = u.shares.slice().sort(function (a, b) { return b.s - a.s; })[0];
                    if (unc.mode === 'range' && u.byFamily) tbU.rows.push([k, fmtSig(u.byFamily.F1.p10, 4) + ' – ' + fmtSig(u.byFamily.F1.p90, 4), fmtSig(u.byFamily.F2.p10, 4) + ' – ' + fmtSig(u.byFamily.F2.p90, 4), fmtSig(u.envelope[0], 4) + ' – ' + fmtSig(u.envelope[1], 4), u.unit, rnd(u.closureShare, 2), _evOk(EVI, ['U1']).join(' ')]);
                    else if (unc.mode === 'range') tbU.rows.push([k, fmtSig(u.p10, 4) + ' – ' + fmtSig(u.p90, 4), 'same', '–', u.unit, rnd(u.closureShare, 2), _evOk(EVI, ['U1']).join(' ')]);
                    else tbU.rows.push([k, sig(u.p10, 5), sig(u.p50, 5), sig(u.p90, 5), u.unit, drv ? drv.input : '–', _evOk(EVI, ['U1']).join(' ')]);
                });
                s9.blocks.push({ kind: 'notes', text: _txt('Seeded draws: n ' + unc.n + ', seed ' + unc.seed + (unc.mode === 'range' ? '; family weight F1 ' + fmt(unc.familyWeight.F1, 2) + ' (an interpretive weight, not a probability).' : '.')) });
            }
            // 19 hand-off and geomechanics
            if (want('dfit-handoff') && ch) {
                var s10 = sec('dfit-handoff', 'Hand-off and geomechanics', 19), kvH = { kind: 'kv', rows: [] }; s10.blocks.push(kvH);
                kvRow(s10, kvH, 'Closure gradient', ch.gradClosure, 3, 'psi/ft', 'frac.chosen.gradClosure', ['F1']);
                kvRow(s10, kvH, 'ISIP gradient', ch.gradIsip, 3, 'psi/ft', 'frac.chosen.gradIsip', ['F1']);
                kvRow(s10, kvH, 'Γ', ch.Gamma, 2, 'psi/√min', 'frac.chosen.Gamma', ['F1']);
            }
            // 20 pick log and evidence appendix
            if (want('dfit-log')) {
                var s11 = sec('dfit-log', 'Pick log and evidence', 20), log = arrOk(opts.log) ? opts.log : [];
                if (log.length) {
                    var tbLg = { kind: 'table', head: ['Seq', 'Time', 'Who', 'Item', 'Old → new', 'Reason'], ev: false, rows: [] };
                    log.forEach(function (e) { tbLg.rows.push([e.seq, String(e.at || ''), String(e.who || ''), String(e.item || ''), _txt(_logVal(e.old) + ' → ' + _logVal(e.new)), _txt(e.reason || '')]); });
                    s11.blocks.push(tbLg);
                } else s11.blocks.push({ kind: 'notes', text: 'No user picks or overrides.' });
                if (opts.appendix !== false) {
                    var tbE = { kind: 'table', head: ['Id', 'Group', 'Title', 'Values'], ev: false, rows: [] };
                    EVI.order.forEach(function (id) { var it = EVI.items[id]; tbE.rows.push([id, EV_TITLES[it.group], it.title, _txt(it.values.map(function (v) { return v.label + ' ' + (fin(v.value) ? fmt(v.value, v.dp) : v.value) + (v.unit ? ' ' + v.unit : ''); }).join(', '))]); });
                    s11.blocks.push(tbE);
                }
            }
            var model = { title: _txt('DFIT analysis' + (opts.zone ? ' — ' + opts.zone : '')), keyRows: keyRows.map(function (r) { return [r[0], _txt(r[1])]; }), keyLine: _txt(keyLine),
                          grade: { letter: grade.letter, why: grade.why.map(_txt) }, sections: sections, appendix: EVI, quoted: { ok: true, nFailed: 0 }, quotes: quotes };
            var chk = G.PRiSM_dfit_checkQuoted(model, run, { annotate: true });
            model.quoted = { ok: !!chk.ok, nFailed: chk.nFailed || 0 };
            return model;
        } catch (e) { return fail('REPORT_FAILED', e && e.message || e); }
    };
    function _logVal(v) { if (v == null) return '–'; if (fin(v)) return String(+v.toPrecision(6)); if (typeof v === 'string') return v.slice(0, 60); try { return JSON.stringify(v).slice(0, 60); } catch (e) { return '–'; } }
    function _parseNum(s) {
        if (fin(s)) return s;
        if (typeof s !== 'string') return null;
        var m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
        return m ? +m[0] : null;
    }
    // Quoted-value self-check (§6.10): every number the report quotes is re-read from the displayed cell and compared with
    // the run; it fails when |quoted − recomputed| > half a unit in the last displayed digit. With {annotate:true} a single
    // ⚠ verdict line naming the failures is put into the headline section (nothing is printed when it passes).
    G.PRiSM_dfit_checkQuoted = function (model, run, opts) {
        try {
            opts = opts || {};
            if (!model || !arrOk(model.sections)) return fail('BAD_INPUT', 'The check needs a report model.', ['model']);
            var Q = arrOk(model.quotes) ? model.quotes : [], failures = [], n = 0;
            Q.forEach(function (qq) {
                var s = model.sections[qq.s], b = s && s.blocks[qq.b], cell = null;
                if (!b) return;
                if (b.kind === 'kv') cell = b.rows[qq.r] ? b.rows[qq.r][1] : null;
                else if (b.kind === 'table') cell = b.rows[qq.r] ? b.rows[qq.r][qq.c] : null;
                else if (b.kind === 'kpi') cell = b.items[qq.r] ? b.items[qq.r].value : null;
                var quoted = _parseNum(cell), recomputed = _getPath(run, qq.path);
                if (!fin(recomputed)) return;
                n++;
                if (!fin(quoted) || Math.abs(quoted - recomputed) > 0.5 * Math.pow(10, -qq.dp) + 1e-9 * Math.abs(recomputed)) failures.push({ ref: qq.ref, quoted: fin(quoted) ? quoted : null, recomputed: recomputed });
            });
            var res = { ok: failures.length === 0, nChecked: n, nFailed: failures.length, failures: failures };
            if (opts.annotate) {
                model.sections.forEach(function (s) { s.blocks = s.blocks.filter(function (b) { return !b._quotedCheck; }); });
                if (failures.length && model.sections.length) {
                    var head = model.sections[0];
                    head.blocks.push({ kind: 'verdict', level: 'warn', text: _txt('⚠ Quoted-value self-check failed for: ' + failures.map(function (f) { return f.ref + ' (quoted ' + fmtSig(f.quoted, 6) + ', run ' + fmtSig(f.recomputed, 6) + ')'; }).join('; ') + '.'), _quotedCheck: true });
                }
                model.quoted = { ok: res.ok, nFailed: res.nFailed };
            }
            return res;
        } catch (e) { return fail('CHECK_FAILED', e && e.message || e); }
    };

    // ── data + picks export (§6.10) ──
    var EXPORT_COLS = { t: { label: 't_h', unit: 'h', dp: 6 }, dt: { label: 'dt_h', unit: 'h', dp: 6 }, p: { label: 'p_psia', unit: 'psia', dp: 3 },
                        q: { label: 'q_bbl_min', unit: 'bbl/min', dp: 4 }, flag: { label: 'after_closure', unit: '', dp: 0 }, pSurf: { label: 'p_surf_psia', unit: 'psia', dp: 3 }, T: { label: 'T_F', unit: '°F', dp: 2 } };
    G.PRiSM_dfit_exportText = function (run, template) {
        try {
            if (!run || !run.prep || run.prep.ok === false) return fail('BAD_INPUT', 'The export needs a run with prepared data.', ['run']);
            var tpl = (template && typeof template === 'object') ? template : {}, sep = typeof tpl.sep === 'string' && tpl.sep ? tpl.sep : '\t';
            var cols = arrOk(tpl.columns) && tpl.columns.length ? tpl.columns.map(function (c) { return typeof c === 'string' ? { key: c } : c; }) : [{ key: 't' }, { key: 'p' }, { key: 'q' }, { key: 'flag' }];
            cols = cols.filter(function (c) { return EXPORT_COLS[c.key]; });
            var dec = tpl.decimals || {}, L = [], ev = run.events || {}, ch = run.frac ? run.frac.chosen : null, cl = _closureOf(run);
            var name = String(tpl.name || 'test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'test';
            var h8 = String(run.dsHash || '').slice(0, 8) || '00000000';
            L.push('# DFIT data and picks export');
            (arrOk(tpl.header) ? tpl.header : []).forEach(function (h) { L.push('# ' + String(h).replace(/[\r\n]+/g, ' ')); });
            var inp = tpl.inputs || null;
            if (inp) {
                L.push('# datum TVD ft: ' + (fin(inp.datumTvd) ? inp.datumTvd : '–') + '; gauge TVD ft: ' + (inp.gauge && fin(inp.gauge.bhTvd) ? inp.gauge.bhTvd : 'at datum'));
                if (inp.fluid) L.push('# fluid: ' + inp.fluid.kind + ', ' + inp.fluid.rhoPpg + ' ppg, ' + inp.fluid.muCp + ' cp');
                if (inp.rock) L.push('# rock: Ep psi ' + (fin(inp.rock.Ep) ? inp.rock.Ep : '–') + ' (' + inp.rock.EpSource + '), hf ft ' + (fin(inp.rock.hf) ? inp.rock.hf : '–') + ', hp ft ' + (fin(inp.rock.hp) ? inp.rock.hp : '–'));
            }
            L.push('# app version: ' + String(tpl.appVersion || (G.RELEASE_NOTES && G.RELEASE_NOTES[0] && G.RELEASE_NOTES[0].ver) || 'not stated'));
            L.push('# input hash: ' + (run.inputsHash || '–') + '; data hash: ' + (run.dsHash || '–') + (run.summary && run.summary.resultHash ? '; result hash: ' + run.summary.resultHash : ''));
            L.push('# EVENTS');
            L.push('# pump start h: ' + fmtSig(ev.tStart, 9) + '; breakdown h: ' + fmtSig(ev.tb, 9) + '; shut-in h: ' + fmtSig(ev.ts, 9) + '; Vi bbl: ' + fmtSig(ev.Vi, 6) + '; Vi* bbl: ' + fmtSig(ev.ViStar, 6) + '; tp h: ' + (ev.tp ? fmtSig(ev.tp.pump, 6) : '–'));
            L.push('# PICKS');
            (run.picks || []).forEach(function (p) { L.push('# ' + p.method + ' (' + p.family + (p.vote ? ', votes' : '') + '): ' + fmt(p.p, 1) + ' psia at G ' + fmt(p.G, 3) + (p.band ? '; P10–P90 ' + fmt(p.band.p10, 1) + '–' + fmt(p.band.p90, 1) : '')); });
            if (run.isip && fin(run.isip.value)) L.push('# ISIP: ' + fmt(run.isip.value, 1) + ' psia (spread ' + fmt(run.isip.spread, 1) + ' psi, ' + run.isip.confidence + ')');
            L.push('# CLOSURE');
            L.push('# ' + (cl.mode === 'single' ? 'single ' + fmt(cl.value, 1) + ' psia (' + cl.label + ')' : cl.mode === 'range' ? 'range ' + fmt(cl.range.lo, 1) + '–' + fmt(cl.range.hi, 1) + ' psia (' + cl.label + ')' : 'not estimable'));
            (arrOk(tpl.log) ? tpl.log : []).forEach(function (e) { L.push('# log ' + e.seq + ' ' + (e.at || '') + ' ' + (e.who || '') + ': ' + e.item + ' ' + _logVal(e.old) + ' → ' + _logVal(e.new) + (e.reason ? ' (' + String(e.reason).replace(/[\r\n]+/g, ' ') + ')' : '')); });
            L.push('# RESULTS');
            if (ch) L.push('# p_n psi ' + fmt(ch.pn, 1) + '; eta ' + fmt(ch.eta ? ch.eta.matched : null, 4) + '; Gamma ' + fmt(ch.Gamma, 3) + '; CL ' + fmtSig(ch.geometry && ch.geometry.byModel.PKN ? ch.geometry.byModel.PKN.CL : null, 4) + '; xf ft ' + fmt(ch.geometry && ch.geometry.byModel.PKN ? ch.geometry.byModel.PKN.xf : null, 1));
            if (run.unc && run.unc.outputs) Object.keys(run.unc.outputs).forEach(function (k) {
                var u = run.unc.outputs[k];
                L.push('# ' + k + ' ' + (u.byFamily ? 'F1 ' + fmtSig(u.byFamily.F1.p10, 5) + '/' + fmtSig(u.byFamily.F1.p50, 5) + '/' + fmtSig(u.byFamily.F1.p90, 5) + ' F2 ' + fmtSig(u.byFamily.F2.p10, 5) + '/' + fmtSig(u.byFamily.F2.p50, 5) + '/' + fmtSig(u.byFamily.F2.p90, 5)
                    : 'P10/P50/P90 ' + fmtSig(u.p10, 5) + '/' + fmtSig(u.p50, 5) + '/' + fmtSig(u.p90, 5)) + ' ' + u.unit);
            });
            if (run.aca && run.aca.pi) L.push('# p_i psia ' + fmt(run.aca.pi.value, 1) + ' [' + fmt(run.aca.pi.lo, 1) + ', ' + fmt(run.aca.pi.hi, 1) + '] (' + run.aca.pi.label + ')');
            var gr = run.grade && run.grade.letter ? run.grade : _gradeOf(run);
            L.push('# GRADE ' + gr.letter + ': ' + (gr.why || []).join(' '));
            L.push('# DATA');
            L.push(cols.map(function (c) { return c.label || EXPORT_COLS[c.key].label; }).join(sep));
            var P = run.prep, tc = fin(ev.ts) && ch && fin(ch.dtc) ? ev.ts + ch.dtc : null;
            for (var i = 0; i < P.t.length; i++) {
                L.push(cols.map(function (c) {
                    var dp = fin(dec[c.key]) ? dec[c.key] : EXPORT_COLS[c.key].dp, v;
                    if (c.key === 't') v = P.t[i]; else if (c.key === 'dt') v = fin(ev.ts) ? P.t[i] - ev.ts : null; else if (c.key === 'p') v = P.pw[i];
                    else if (c.key === 'q') v = P.q ? P.q[i] : null; else if (c.key === 'flag') v = tc != null ? (P.t[i] >= tc ? 1 : 0) : 0;
                    else if (c.key === 'pSurf') v = P.pSurf ? P.pSurf[i] : null; else if (c.key === 'T') v = P.T ? P.T[i] : null;
                    return fin(v) ? v.toFixed(dp) : '';
                }).join(sep));
            }
            return { ok: true, text: L.join('\n') + '\n', filename: 'dfit-' + name + '-' + h8 + '.txt' };
        } catch (e) { return fail('EXPORT_FAILED', e && e.message || e); }
    };

    // ── frac-design sheet (§2.11) ──
    G.PRiSM_dfit_fracSheet = function (run) {
        try {
            if (!run || !run.frac) return fail('BAD_INPUT', 'The frac sheet needs a run with fracture outputs.', ['frac']);
            var rows = [], unc = run.unc && run.unc.outputs ? run.unc : null, cl = _closureOf(run);
            function uq(k, fam) { var u = unc && unc.outputs[k]; if (!u) return null; if (fam && u.byFamily) return u.byFamily[fam]; return fin(u.p50) ? u : null; }
            function row(name, fam, v, unit, lens, ev, ukey) { var u = ukey ? uq(ukey, fam) : null; rows.push([name, fam, u ? u.p10 : null, fin(v) ? v : (u ? u.p50 : null), u ? u.p90 : null, unit, lens, ev]); }
            function chainRows(f, fam) {
                if (!f) return;
                var pk = f.geometry && f.geometry.byModel ? f.geometry.byModel.PKN : null, rd = f.geometry && f.geometry.byModel ? f.geometry.byModel.radial : null;
                row('Closure stress', fam, f.pClosure, 'psia', 'default', 'C1', 'closure');
                row('Closure gradient', fam, f.gradClosure, 'psi/ft', 'default', 'F1', null);
                row('Net pressure', fam, f.pn, 'psi', 'default', 'F1', 'pn');
                row('Efficiency (upper bound, spurt unknown)', fam, f.eta ? f.eta.matched : null, '–', 'default', 'F1', 'eta');
                row('Pad fraction (low)', fam, f.padFraction ? f.padFraction.lo : null, '–', 'default', 'F1', null);
                row('Pad fraction (high)', fam, f.padFraction ? f.padFraction.hi : null, '–', 'default', 'F1', null);
                row('CL (conditional on the geometry)', fam, pk ? pk.CL : null, 'ft/√min', 'default', 'F1', 'CL');
                row('xf (PKN)', fam, pk ? pk.xf : null, 'ft', 'default', 'F1', 'xf');
                row('R (radial)', fam, rd ? rd.R : null, 'ft', 'default', 'F1', null);
                row('C_sys', fam, f.Csys, 'bbl/psi', 'default', 'F1', 'Csys');
                row('R_vis', fam, f.Rvis, '–', 'default', 'F1', 'Rvis');
                if (fin(f.pdlMult)) row('PDL multiplier at ISIP', fam, f.pdlMult, '–', 'default', 'M1', null);
            }
            row('ISIP', null, run.isip ? run.isip.value : null, 'psia', 'default', 'I1', null);
            var any = run.frac.chosen || run.frac.byFamily && Object.keys(run.frac.byFamily).length;
            if (cl.mode === 'range' && run.frac.byFamily) { ['F1', 'F2'].forEach(function (F) { chainRows(run.frac.byFamily[F], F); }); }
            else chainRows(run.frac.chosen || _firstFamily(run.frac.byFamily), null);
            if (run.frac.chosen || any) row('Γ = r_p·CL·A_f/C_sys', null, (run.frac.chosen || _firstFamily(run.frac.byFamily) || {}).Gamma, 'psi/√min', 'default', 'F1', 'Gamma');
            if (run.aca && run.aca.pi) row('p_i', null, run.aca.pi.value, 'psia', 'default', 'A1', 'pi');
            if (run.aca && run.aca.kh) row('k (after-closure radial)', null, run.aca.kh.k, 'md', 'default', 'A1', null);
            else if (run.aca && run.aca.bounds) { row('k lower bound', null, run.aca.bounds.kLo, 'md', 'default', 'A1', null); row('k upper bound', null, run.aca.bounds.kHi, 'md', 'default', 'A1', null); }
            var head = ['name', 'family', 'p10', 'p50', 'p90', 'unit', 'lens', 'ev'];
            var esc = function (v) { if (v == null) return ''; if (fin(v)) return String(+v.toPrecision(8)); var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
            var csv = [head.join(',')].concat(rows.map(function (r) { return r.map(esc).join(','); })).join('\n') + '\n';
            return { ok: true, rows: rows, csv: csv, head: head };
        } catch (e) { return fail('FRACSHEET_FAILED', e && e.message || e); }
    };

    // ── hand-off packets (§2.11, §6.8) ──
    G.PRiSM_dfit_handoff = function (run, target, opts) {
        try {
            opts = opts || {};
            if (!run || !run.events || run.events.ok === false) return fail('BAD_INPUT', 'The hand-off needs a run with events.', ['run']);
            if (target !== 'pta' && target !== 'rta' && target !== 'frac') return fail('BAD_INPUT', 'Target must be pta, rta or frac.', ['target']);
            var ev = run.events, cl = _closureOf(run), fam = opts.family === 'F1' || opts.family === 'F2' || opts.family === 'F4' ? opts.family : null;
            var notes = [], blockers = [], aca = run.aca && run.aca.ok !== false ? run.aca : null;
            var f = fam && run.frac && run.frac.byFamily ? run.frac.byFamily[fam] : (run.frac ? run.frac.chosen : null);
            if (cl.mode === 'range' && !fam) blockers.push('Range mode: choose the closure family whose chain is handed over.');
            if (fam && !f) blockers.push('No fracture chain exists for family ' + fam + '.');
            var tpV = ev.tp && pos(ev.tp.veq) ? ev.tp.veq : (ev.tp && pos(ev.tp.pump) ? ev.tp.pump : null);
            var Vnet = (fin(ev.Vi) ? ev.Vi : 0) - (fin(ev.Vfill) ? ev.Vfill : 0) - (fin(ev.Vfb) ? ev.Vfb : 0);
            var qEq = pos(tpV) && Vnet > 0 ? Vnet / (tpV * 60) : 0;          // bbl/min
            var piOk = aca && aca.pi && (aca.pi.label === 'high' || aca.pi.label === 'medium');
            if (aca && aca.pi && !piOk) blockers.push('p_i label is ' + aca.pi.label + ': it is not handed over unless you override it.');
            var model = null;
            if (aca && aca.match && aca.match.best) model = aca.match.best.model;
            else if (aca && aca.regimeSummary) {
                var bil = aca.diag && aca.diag.regimes && aca.diag.regimes.some(function (r) { return r.kind === 'bilinear'; });
                model = aca.regimeSummary === 'linear' || aca.regimeSummary === 'linear-radial' ? (bil ? 'finiteFrac' : 'infiniteFrac') : aca.regimeSummary === 'radial' ? (bil ? 'finiteFrac' : 'homogeneous') : null;
            }
            var pk = f && f.geometry && f.geometry.byModel ? f.geometry.byModel[f.geometry.model || 'PKN'] : null;
            var xf = aca && aca.match && aca.match.best && pos(aca.match.best.L) ? aca.match.best.L : (pk ? (pos(pk.xf) ? pk.xf : pk.R) : null);
            var k = aca && aca.match && aca.match.best && pos(aca.match.best.k) ? aca.match.best.k : aca && aca.kh && pos(aca.kh.k) ? aca.kh.k
                : aca && aca.nolte && aca.nolte.lin && pos(aca.nolte.lin.k) ? aca.nolte.lin.k : aca && aca.bounds && pos(aca.bounds.kLo) && pos(aca.bounds.kHi) ? Math.sqrt(aca.bounds.kLo * aca.bounds.kHi) : null;
            var pi = aca && aca.pi ? aca.pi.value : null;
            var pkt = { target: target, family: fam, setWell: {}, multiRate: [], qEq: qEq, model: null, seeds: { xf: nn(xf), k: nn(k), pi: nn(pi) }, notes: notes, blockers: blockers };
            if (target === 'pta') {
                pkt.setWell = { testType: 'falloff', tShut: ev.ts, tp: tpV, pwf0: run.isip && fin(run.isip.value) ? run.isip.value : null };
                if (piOk) pkt.setWell.pi = pi;
                if (fin(ev.ts) && pos(tpV) && qEq > 0) pkt.multiRate = [{ t: ev.ts - tpV, q: qEq * 1440 }, { t: ev.ts, q: 0 }];
                pkt.model = model;
                notes.push('Idealised schedule at q_eq = (V_i − V_fill − V_fb)/tp_veq = ' + fmt(qEq, 3) + ' bbl/min; the wellbore compression volume is part of the impulse.');
                if (model) notes.push('Model ' + model + ' seeded with xf ' + fmt(xf, 1) + ' ft and k ' + fmtSig(k, 3) + ' md.');
            } else if (target === 'rta') {
                pkt.rta = { k: nn(k), kLo: aca && aca.bounds ? aca.bounds.kLo : (aca && aca.kh ? aca.kh.k : null), kHi: aca && aca.bounds ? aca.bounds.kHi : (aca && aca.kh ? aca.kh.k : null),
                            source: aca && aca.match ? 'aca-match' : aca && aca.kh ? 'aca-radial' : 'bounds' };
                notes.push('k for the RTA linear-flow analysis from the after-closure analysis.');
                if (!pos(k)) blockers.push('No after-closure permeability is available.');
            } else {
                var sh = G.PRiSM_dfit_fracSheet(run);
                pkt.sheet = sh.ok ? sh.rows : [];
                notes.push('Frac-design sheet with ' + (sh.ok ? sh.rows.length : 0) + ' rows' + (cl.mode === 'range' ? ', both family columns.' : '.'));
            }
            pkt.notes = notes.map(_txt); pkt.blockers = blockers.map(_txt);
            return pkt;
        } catch (e) { return fail('HANDOFF_FAILED', e && e.message || e); }
    };

    // ── summary for the rail, report key line, Quick Report and the tests table (§3.3) ──
    var RESULT_KEYS = ['isip', 'closure', 'pn', 'eta', 'CL', 'Gamma', 'xf', 'R', 'pi', 'khmu', 'k', 'kLo', 'kHi', 'triage', 'grade'];
    G.PRiSM_dfit_summarise = function (run, opts) {
        try {
            opts = opts || {};
            if (!run || typeof run !== 'object' || run.ok === false && !run.prep) return fail('BAD_INPUT', 'The summary needs a run.', ['run']);
            var cl = _closureOf(run), ch = run.frac ? run.frac.chosen : null, aca = run.aca && run.aca.ok !== false ? run.aca : null;
            var fams = cl.families || {}, famP = function (F) { var f = fams[F]; return f && fin(f.p50) ? { p50: f.p50 } : null; };
            var label = cl.mode === 'none' ? 'not-estimable' : (cl.label === 'high' || cl.label === 'medium' || cl.label === 'low') ? cl.label : 'low';
            if (cl.mode === 'single' && label === 'not-estimable') label = 'low';
            var pk = ch && ch.geometry && ch.geometry.byModel ? ch.geometry.byModel : null, gm = ch && ch.geometry ? ch.geometry.model : null;
            var k = aca && aca.kh && pos(aca.kh.k) ? aca.kh.k : aca && aca.match && aca.match.best && pos(aca.match.best.k) ? aca.match.best.k : aca && aca.nolte && aca.nolte.lin && pos(aca.nolte.lin.k) ? aca.nolte.lin.k : null;
            var d = run.derivs || {}, gx = [], gy = [], Gc = ch && pos(ch.Gc) ? ch.Gc : null;
            if (arrOk(d.G) && arrOk(d.GdPdG) && pos(d.mG)) {
                var Gmax = 0; d.G.forEach(function (g) { if (fin(g) && g > Gmax) Gmax = g; });
                var norm = Gc || Gmax || 1, step = Math.max(1, Math.floor(d.G.length / 60));
                for (var i = 0; i < d.G.length && gx.length < 60; i += step) if (d.G[i] > 0 && fin(d.GdPdG[i])) { gx.push(rnd(d.G[i] / norm, 4)); gy.push(rnd(d.GdPdG[i] / (d.mG * d.G[i]), 4)); }
            }
            var unc = run.unc && run.unc.ok !== false ? run.unc : null;
            var s = {
                at: opts.at || run.at || new Date().toISOString(), dsHash: run.dsHash, inputHash: run.inputsHash, resultHash: '0000000000000000',
                stale: !!run.fast, forOtherDataset: false,
                isip: { value: run.isip && fin(run.isip.value) ? run.isip.value : null, spread: run.isip && fin(run.isip.spread) ? run.isip.spread : null,
                        label: run.isip && (run.isip.confidence === 'high' || run.isip.confidence === 'medium' || run.isip.confidence === 'low') ? run.isip.confidence : null },
                closure: { mode: cl.mode, value: cl.mode === 'single' ? cl.value : null, lo: cl.mode === 'range' ? cl.range.lo : null, hi: cl.mode === 'range' ? cl.range.hi : null,
                           label: label, families: { F1: famP('F1'), F2: famP('F2'), F4: famP('F4') } },
                pn: ch ? nn(ch.pn) : null, eta: ch && ch.eta ? nn(ch.eta.matched) : null, CL: pk && gm && pk[gm] ? nn(pk[gm].CL) : null, Gamma: ch ? nn(ch.Gamma) : null,
                xf: pk && pk.PKN && gm !== 'radial' ? nn(pk[gm || 'PKN'].xf) : null, R: pk && gm === 'radial' && pk.radial ? nn(pk.radial.R) : null, model: gm || null,
                pi: aca && aca.pi ? { value: aca.pi.value, lo: aca.pi.lo, hi: aca.pi.hi, label: aca.pi.label } : { value: null, lo: null, hi: null, label: null },
                khmu: aca && aca.kh ? nn(aca.kh.khmu) : null, k: nn(k), kLo: aca && aca.bounds ? nn(aca.bounds.kLo) : null, kHi: aca && aca.bounds ? nn(aca.bounds.kHi) : null,
                triage: run.triage && run.triage.light ? run.triage.light : null, grade: run.grade && run.grade.letter ? run.grade.letter : null,
                unc: { seed: unc ? unc.seed : (fin(run.seed) ? run.seed : 1), n: unc ? unc.n : 0 }, gdpdgN: { x: gx, y: gy }
            };
            if (s.isip.value != null && s.isip.spread == null) s.isip.spread = 0;
            var o = {}; RESULT_KEYS.forEach(function (kk) { o[kk] = s[kk]; });
            s.resultHash = hashOf(o, 'display').h;
            return s;
        } catch (e) { return fail('SUMMARY_FAILED', e && e.message || e); }
    };

    // ═════════════════════════════════════════════════════════════════════
    // 9. The pure pipeline and its Job twin (§3.3a, §4.20) — the only place that knows the stage order
    // ═════════════════════════════════════════════════════════════════════
    function _call(name, args, warnings, code) {
        var f = G[name];
        if (!realFn(f)) { warnings.push(W('STAGE_UNAVAILABLE', 'info', name.replace('PRiSM_dfit_', '') + ' is not available in this build.', [])); return fail('NOT_IMPLEMENTED', name + ' is not available.', []); }
        try { var r = f.apply(null, args); if (r && r.ok === false) warnings.push(W(code || 'STAGE_FAILED', 'warn', name.replace('PRiSM_dfit_', '') + ': ' + (r.errors && r.errors[0] || r.code), [])); return r; }
        catch (e) { warnings.push(W(code || 'STAGE_FAILED', 'warn', name.replace('PRiSM_dfit_', '') + ' failed: ' + (e && e.message || e), [])); return fail('STAGE_FAILED', e && e.message || e); }
    }
    function _wb(name, args, warnings) {
        var W2 = G.WTS_wellbore, f = W2 && W2[name];
        if (!realFn(f)) return null;
        try { var r = f.apply(null, args); return r && r.ok !== false ? r : null; } catch (e) { warnings.push(W('WELLBORE_FAILED', 'warn', 'Wellbore ' + name + ' failed.', [])); return null; }
    }
    function _pipeInit(ds, inputs, well, picks, opts) {
        opts = opts || {};
        var warnings = [], IR = G.PRiSM_dfit_inputRanges, inp = inputs || {};
        if (IR && typeof IR.clamp === 'function') { var c = IR.clamp(inputs || {}); if (c && c.inputs) { inp = c.inputs; (c.warnings || []).forEach(function (w) { if (w && w.code) warnings.push(W(w.code, w.level || 'info', w.text || w.code, w.ev || [])); }); } }
        picks = picks || { isip: null, closure: null, user: {}, aca: { origin: 'centroid', linWin: null, radWin: null, piLevel: null } };
        var o = inp.options || {}, uo = o.unc || {};
        var dsH = realFn(G.PRiSM_dfit_dsHash) ? G.PRiSM_dfit_dsHash(ds) : null;
        if (typeof dsH !== 'string' || !/^[0-9a-f]{16}$/.test(dsH)) dsH = hashOf({ t: ds && ds.t, p: ds && ds.p, q: ds && ds.q || null }, 'inputs').h;
        var run = { v: 1, ok: false, fast: !!opts.fast, dsHash: dsH, inputsHash: hashOf(inp, 'inputs').h, picksHash: hashOf(picks, 'inputs').h,
                    seed: fin(opts.seed) ? Math.max(1, Math.round(opts.seed)) : (fin(uo.seed) ? uo.seed : 1),
                    prep: null, events: null, triage: null, isip: null, derivs: null, picks: [], consensus: null, consensusLite: null, classification: null,
                    frac: { chosen: null, byFamily: {} }, whatIf: [], aca: null, leak: null, unc: null, evidence: null, report: null, grade: null, summary: null,
                    warnings: warnings, counts: { evals: 0, refits: 0, draws: 0 } };
        var alphaOpt = o.alpha === 'general' ? (fin(o.alphaGeneral) ? o.alphaGeneral : 0.75) : o.alpha;
        return { ds: ds, inputs: inp, well: well || {}, picks: picks, opts: opts, run: run, W: warnings,
                 dOpts: { alpha: alphaOpt == null ? 'auto' : alphaOpt, tp: o.tp || 'pump', L: fin(o.L) ? o.L : 0.1, gMin: o.gMin == null ? 'auto' : o.gMin },
                 extra: { ramps: [], hammer: null, stepDown: null, stepRate: null }, consJob: null, uncJob: null };
    }
    function _ctxOf(P) { var r = P.run; return { events: r.events, isip: r.isip, inputs: P.inputs, well: P.well, prep: r.prep, user: P.picks.closure, ramps: P.extra.ramps, lkFit: P.opts.lkFit || null }; }
    var STAGES = [
        { id: 'prepare', fn: function (P) {
            P.run.prep = _call('PRiSM_dfit_prepare', [P.ds, P.inputs, P.well], P.W, 'PREPARE_FAILED');
        } },
        { id: 'events', fn: function (P) {
            var r = P.run;
            r.events = _call('PRiSM_dfit_events', [r.prep, P.inputs.events || {}, {}], P.W, 'EVENTS_FAILED');
            if (r.events && r.events.ok !== false && arrOk(r.events.cycles) && r.prep && r.prep.ok !== false) r.events.cycles.forEach(function (cy) {
                if (cy && cy.rampWin) { var rp = _wb('ramp', [r.prep.t, r.prep.pw, r.prep.q, cy.rampWin, { VwCw: r.events.VwCwMeasured, seed: r.seed }], P.W); if (rp) P.extra.ramps.push(rp); }
            });
        } },
        { id: 'isip', fn: function (P) {
            var r = P.run;
            var d0 = _call('PRiSM_dfit_derivs', [r.prep, r.events, P.dOpts], P.W, 'DERIVS_FAILED');
            var ev = r.events && r.events.ok !== false ? r.events : null;
            if (ev && r.prep && r.prep.hf && arrOk(r.prep.hf.windows) && r.prep.hf.windows.length) {
                var w = r.prep.hf.windows[0]; P.extra.hammer = _wb('hammerQuick', [w.t || w.tHz, w.p, ev.ts, { qShut: ev.qLast }], P.W);
            }
            if (ev && arrOk(ev.steps)) {
                var down = ev.steps.filter(function (s) { return s.dir === 'down'; }), up = ev.steps.filter(function (s) { return s.dir === 'up'; });
                if (down.length >= 3) P.extra.stepDown = _wb('stepDown', [down.map(function (s) { return { q: s.q, p: s.pSettled, n: s.n, t: s.t1 }; }), { beta: 0.5, drift: true, perfs: P.inputs.perfs, rhoPpg: P.inputs.fluid && P.inputs.fluid.rhoPpg }], P.W);
                if (up.length >= 3) P.extra.stepRate = _wb('stepRate', [up.map(function (s) { return { q: s.q, t0: s.t0, t1: s.t1 }; }), { seed: r.seed, t: r.prep.t, p: r.prep.pw }], P.W);
            }
            r.isip = _call('PRiSM_dfit_isip', [r.prep, r.events, d0, { hammer: P.extra.hammer, stepDown: P.extra.stepDown, bleed: null, lumped: null }], P.W, 'ISIP_FAILED');
            var ui = P.picks.isip;
            if (r.isip && r.isip.ok !== false && ui && ui.source === 'user' && fin(ui.value)) { r.isip.value = ui.value; r.isip.why = (r.isip.why || []).concat([_txt('User ISIP pick: ' + (ui.reason || 'no reason given') + '.')]).slice(0, 8); }
            if (realFn(G.PRiSM_dfit_triage)) r.triage = _call('PRiSM_dfit_triage', [r.prep, r.events, { isip: r.isip, derivs: d0, hammer: P.extra.hammer, ramps: P.extra.ramps, stepDown: P.extra.stepDown, inputs: P.inputs, well: P.well, plan: P.opts.plan || null }], P.W, 'TRIAGE_FAILED');
            if (r.triage && r.triage.ok === false) r.triage = null;
            P.d0 = d0;
        } },
        { id: 'derivs', fn: function (P) {
            var r = P.run, dO = {}; for (var k in P.dOpts) dO[k] = P.dOpts[k];
            if (r.isip && fin(r.isip.value)) { dO.isip = r.isip.value; r.derivs = _call('PRiSM_dfit_derivs', [r.prep, r.events, dO], P.W, 'DERIVS_FAILED'); r.counts.refits++; }
            else r.derivs = P.d0;
            var pk = _call('PRiSM_dfit_closurePicks', [r.derivs, { ramps: P.extra.ramps, lkFit: P.opts.lkFit || null, user: P.picks.user || {}, events: r.events, isip: r.isip, inputs: P.inputs, well: P.well }], P.W, 'PICKS_FAILED');
            r.picks = arrOk(pk) ? pk : [];
            r.consensusLite = _call('PRiSM_dfit_consensusLite', [r.picks, r.derivs, _ctxOf(P)], P.W, 'CONSENSUS_FAILED');
        } },
        { id: 'consensus', skipFast: true, job: true, fn: function (P) {
            var r = P.run, c = _call('PRiSM_dfit_consensus', [r.picks, r.derivs, _ctxOf(P)], P.W, 'CONSENSUS_FAILED');
            r.consensus = c && c.ok !== false ? c : null;
        }, start: function (P) {
            var r = P.run;
            if (!realFn(G.PRiSM_dfit_consensusJob)) return null;
            try { return G.PRiSM_dfit_consensusJob(r.picks, r.derivs, _ctxOf(P)); } catch (e) { return null; }
        }, finish: function (P, res) { P.run.consensus = res && res.ok !== false ? res : null; if (res && res.ok === false) P.W.push(W('CONSENSUS_FAILED', 'warn', 'consensus: ' + (res.errors && res.errors[0] || res.code), [])); } },
        { id: 'frac', fn: function (P) {
            var r = P.run, c = r.consensus || (r.consensusLite && r.consensusLite.ok !== false ? r.consensusLite : null) || {}, uc = P.picks.closure, fams = c.families || {};
            var pc = null, fam = null, method = 'consensus';
            if (uc && uc.mode === 'user' && fin(uc.p)) { pc = uc.p; fam = uc.family || null; method = uc.method || 'user'; }
            else if (uc && uc.mode === 'family' && uc.family && fams[uc.family] && fin(fams[uc.family].p50)) { pc = fams[uc.family].p50; fam = uc.family; method = uc.method || 'family'; }
            else if (c.mode === 'single' && fin(c.value)) pc = c.value;
            var fctx = function (f, m) { return { events: r.events, isip: r.isip, inputs: P.inputs, well: P.well, family: f, method: m }; };
            if (fin(pc)) { var ch = _call('PRiSM_dfit_frac', [pc, r.derivs, fctx(fam, method)], P.W, 'FRAC_FAILED'); r.frac.chosen = ch && ch.ok !== false ? ch : null; }
            ['F0', 'F1', 'F2', 'F3', 'F4'].forEach(function (F) {
                var f = fams[F]; if (!f || !fin(f.p50)) return;
                var o = _call('PRiSM_dfit_frac', [f.p50, r.derivs, fctx(F, F)], P.W, 'FRAC_FAILED');
                if (o && o.ok !== false) r.frac.byFamily[F] = o;
            });
            var cands = [];
            if (c.mode === 'single' && fin(c.value)) cands.push({ label: 'Consensus', family: null, p: c.value, method: 'consensus' });
            ['F1', 'F2', 'F4'].forEach(function (F) { if (fams[F] && fin(fams[F].p50)) cands.push({ label: 'Family ' + F, family: F, p: fams[F].p50, method: F }); });
            if (P.opts.whatIf && fin(P.opts.whatIf.p)) cands.push({ label: 'What-if ' + fmt(P.opts.whatIf.p, 0) + ' psia', family: null, p: P.opts.whatIf.p, method: 'user' });
            if (cands.length) { var wi = _call('PRiSM_dfit_whatIf', [cands, r.derivs, fctx(null, null)], P.W, 'WHATIF_FAILED'); r.whatIf = arrOk(wi) ? wi.filter(function (x) { return x && x.ok !== false && x.label; }) : []; }
            r.classification = _call('PRiSM_dfit_classify', [r.derivs, { frac: r.frac.chosen || _firstFamily(r.frac.byFamily), curvExpRun: null, VwCwTheory: null, VwCwMeasured: r.events ? r.events.VwCwMeasured : null, events: r.events, inputs: P.inputs }], P.W, 'CLASSIFY_FAILED');
        } },
        { id: 'aca', fn: function (P) {
            var r = P.run;
            if (!(r.frac.chosen || Object.keys(r.frac.byFamily).length)) return;
            var a = G.PRiSM_dfit_aca(r, { well: P.well, inputs: P.inputs, picks: P.picks, match: !!P.opts.match, matchModels: P.opts.matchModels });
            if (a && a.ok !== false) {
                r.aca = a;
                if (a.match && fin(a.match.evals)) r.counts.evals += a.match.evals;
                var lp = G.PRiSM_dfit_leakPlot(a, { V: a.V, driftSpec: P.opts.driftSpec, sigma: r.prep ? r.prep.sigma : 0, seed: r.seed, nBoot: P.opts.fast ? 30 : 120 });
                r.leak = lp && lp.ok !== false ? lp : null;
            } else if (a && a.code !== 'NO_CLOSURE') P.W.push(W('ACA_FAILED', 'info', 'After-closure analysis: ' + (a.errors && a.errors[0] || a.code), ['A1']));
        } },
        { id: 'uncertainty', skipFast: true, job: true, fn: function (P) {
            var u = G.PRiSM_dfit_uncertainty(P.run, P.uncOpts());
            P.run.unc = u && u.ok !== false ? u : null; if (P.run.unc) P.run.counts.draws = u.counts.draws;
        }, start: function (P) { return G.PRiSM_dfit_uncertaintyJob(P.run, P.uncOpts()); },
           finish: function (P, u) { P.run.unc = u && u.ok !== false ? u : null; if (P.run.unc) P.run.counts.draws = u.counts.draws; } },
        { id: 'report', fn: function (P) {
            var r = P.run;
            r.ok = !!(r.prep && r.prep.ok !== false && r.events && r.events.ok !== false && r.derivs && r.derivs.ok !== false);
            r.grade = _gradeOf(r);
            r.evidence = G.PRiSM_dfit_evidence(r); if (r.evidence && r.evidence.ok === false) r.evidence = null;
            r.summary = G.PRiSM_dfit_summarise(r, { at: P.opts.at }); if (r.summary && r.summary.ok === false) r.summary = null;
            var T = P.opts.test || null;
            r.report = G.PRiSM_dfit_reportModel(r, { zone: P.opts.zone || (T && T.zone) || '', log: P.opts.log || (T && T.log) || [], lk: T && T.lk, groups: P.opts.groups || null });
            if (r.report && r.report.ok === false) r.report = null;
            if (r.consensus && fin(r.consensus.evalCount)) r.counts.evals += r.consensus.evalCount;
            if (r.consensus && r.consensus.counts && fin(r.consensus.counts.evals)) r.counts.evals += r.consensus.counts.evals;
            if (!r.isip) r.isip = fail('NOT_IMPLEMENTED', 'ISIP stage did not run.', []);
            ['prep', 'events', 'derivs', 'consensusLite', 'classification'].forEach(function (k) { if (!r[k]) r[k] = fail('NOT_IMPLEMENTED', k + ' stage did not run.', []); });
        } }
    ];
    function _stagesFor(P) { return STAGES.filter(function (s) { return !(s.skipFast && P.opts.fast); }); }
    function _finishRun(P) { return P.run; }
    function _mkP(ds, inputs, well, picks, opts) {
        var P = _pipeInit(ds, inputs, well, picks, opts);
        P.uncOpts = function () {
            var o = P.inputs.options || {}, uo = o.unc || {};
            return { n: fin(P.opts.uncN) ? P.opts.uncN : (fin(uo.n) ? uo.n : 1000), seed: P.run.seed, inputs: P.inputs, well: P.well,
                     familyWeightF1: fin(o.familyWeightF1) ? o.familyWeightF1 : 0.5, prevFamilyWeightF1: P.opts.prevFamilyWeightF1 };
        };
        return P;
    }
    G.PRiSM_dfit_pipeline = function (ds, inputs, well, picks, opts) {
        try {
            if (!ds || !arrOk(ds.t) || !arrOk(ds.p)) return fail('BAD_INPUT', 'The pipeline needs a dataset with t and p.', ['ds']);
            var P = _mkP(ds, inputs, well, picks, opts);
            _stagesFor(P).forEach(function (s) { s.fn(P); });
            return _finishRun(P);
        } catch (e) { return fail('PIPELINE_FAILED', e && e.message || e); }
    };
    G.PRiSM_dfit_pipelineJob = function (ds, inputs, well, picks, opts) {
        var P = null, list = [], i = 0, sub = null, done = false, cancelled = false, res = null;
        try {
            if (!ds || !arrOk(ds.t) || !arrOk(ds.p)) { done = true; res = fail('BAD_INPUT', 'The pipeline needs a dataset with t and p.', ['ds']); }
            else { P = _mkP(ds, inputs, well, picks, opts); list = _stagesFor(P); }
        } catch (e) { done = true; res = fail('PIPELINE_FAILED', e && e.message || e); }
        return {
            step: function () {
                if (done || cancelled) return { done: true, progress: 1, label: cancelled ? 'cancelled' : 'done' };
                try {
                    var s = list[i];
                    if (s.job && !sub && s.start) { sub = s.start(P) || { _sync: true }; if (sub._sync) { s.fn(P); sub = null; i++; } }
                    else if (sub) { var st = sub.step(); if (st && st.done) { s.finish(P, sub.result()); sub = null; i++; } }
                    else { s.fn(P); i++; }
                    if (i >= list.length) { done = true; res = _finishRun(P); }
                } catch (e) { done = true; res = fail('PIPELINE_FAILED', e && e.message || e); }
                return { done: done, progress: done ? 1 : Math.min(0.99, i / list.length), label: done ? 'done' : (list[i] ? list[i].id : 'done') };
            },
            result: function () { return res || fail('CANCELLED', 'Analyse was cancelled — previous results kept.', []); },
            cancel: function () { cancelled = true; if (sub && typeof sub.cancel === 'function') sub.cancel(); }
        };
    };

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
