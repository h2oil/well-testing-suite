// =============================================================================
// WTS — Round-9 helper module — Build-up Surveillance: synthetic generator (synth)
// helper module: does not add a page to window.WTS_calcRegistry
// -----------------------------------------------------------------------------
// window.WTS_buildup.synth — plan docs/BUILDUP-SURVEILLANCE-PLAN.md §3.9 (interface),
// §5.2 (benchmark design), §5.3 ("fully right"), §5.6 and §9 WP4. Owner: WP4.
//
// What it does
//   • rng(seed): the only PRNG of the feature (integer state, Math.imul only, so the
//     uniform stream is bit-identical on every JS engine).
//   • An INDEPENDENT forward model (no inverse crime): its own scaled Bessel functions
//     (power series, Temme/Steed continued fraction, asymptotic series), its own
//     exponential integral and ∫K0, its own Stehfest inversion with N = 16 (weights
//     computed here), its own Laplace kernels and a 40-per-decade evaluation grid with
//     cubic Hermite interpolation in ln tD. Kernels: homogeneous, sealing fault,
//     constant-pressure line, two parallel faults (lattice sums), two-zone radial
//     composite (with F), closed circle, dual porosity (pseudo-steady state), partial
//     penetration (uniform-flux series with a precomputed tail), infinite-conductivity
//     fracture (uniform flux read at 0.732·xf), plus the line source for checks.
//     Wellbore storage and skin are folded in Laplace space; S < 0 uses the effective
//     wellbore radius (lengths × e^S, tD and Cd × e^2S, λ × e^−2S).
//   • Real-time records: the full, uncompacted daily rate history (day variation,
//     earlier shut-ins, flush after reopening, intra-day changes, closing ramps, partial
//     cuts, truncated histories), superposition per sample, then noise (white, AR(1),
//     an Ornstein–Uhlenbeck low-frequency component, slugging while flowing,
//     quantisation, spikes, drift, M2/K1 tides). Gas in pseudo-pressure from its own
//     z-factor (Dranchuk–Abou-Kassem, Sutton pseudo-criticals, Wichert–Aziz) and
//     viscosity (Lee–Gonzalez–Eakin) tables, rate-dependent skin through superposition,
//     optional pseudo-time for the test build-up. Water-injector fall-offs.
//   • Daily allocation with its own day / zone code (allocation error, bias, rounding,
//     "ignores the shut-in", conflicting hours, production-day offset).
//   • The input-consistent truth of §5.3 (f, q_correct, k*, S*, first-plateau truth,
//     visibility), computed here only; the scorer never reads the engine's Δq.
//   • caseFromSeed (fixed seed table, Latin hypercube per stratum from master seed 3300),
//     generate / generateJob (count-sliced work units), sequences (seeds 200000–200119),
//     the oil and gas demos (seeds 3301 / 3302), IN_APP and score.
//
// Independence (test GE7). This file never calls the data layer of the page, the PRiSM
// model registry or PRiSM's storage/skin fold, and uses no unseeded random numbers. The
// scorer compares the engine's chosen model by its display label (chosen.label), so the
// fitted-model registry keys are never named here.
//
// Field units throughout: psia, hours, STB/d (oil), bbl/d (water injection), Mscf/d
// (gas), md, ft, cp, 1/psi, bbl/psi; °F in, °R inside. Gas B is Bg in rb/Mscf (5.035·z·T/p).
// Record times are epoch ms UTC; scenario times are hours on the history clock (hours since
// the first sample).
//
// Conventions shared with the engines
//   • Closing time: with a closing ramp, t_c is the ramp midpoint and Δp is referenced to the
//     flowing pressure extrapolated to t_c with the pre-ramp rate (§4.3 M§A3); truth tc_ms,
//     Δt_end and the noise-free reference curve all use it.
//   • Record hash: the data layer's construction (hash16 of "n|t0|tN|digest") with the
//     generator's own copy of the frozen hash16, so a bare load and the app agree.
//   • generateJob work units are count-based (UNIT_FWD / UNIT_GRID / UNIT_FIN ops per step,
//     OPS weights); job.stats() reports the largest step per phase.
//
// Load rules: no document, no timers, nothing from other modules at load time. The
// namespace is merged (window.WTS_buildup = window.WTS_buildup || {}) and this file owns
// exactly the `synth` sub-object.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var BU = G.WTS_buildup = G.WTS_buildup || {};
    var SY = {};
    // One local binding of Math: inside a vm context (the acceptance harness, buildup-validate.js) every global
    // lookup goes through the context's interceptor and costs ~40× a local one; the forward loop is the hot path.
    var MM = Math;

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 1 — constants
    // ═════════════════════════════════════════════════════════════════════
    var VERSION = 'synth-1';
    var LN10 = MM.LN10, LN2 = MM.LN2, EULER = 0.5772156649015329;
    var HOUR_MS = 3600000, DAY_MS = 86400000;
    var C_TD = 0.0002637;          // tD per hour = C_TD·k/(φ μ ct rw²)
    var C_CD = 0.8936;             // Cd = C_CD·C/(φ ct h rw²)
    var C_P = 141.2;               // Δp = C_P·q·B·μ/(k·h)·pD   (oil, water)
    var C_GAS = 1422;              // Δm = C_GAS·q·T/(k·h)·pD   (gas, q Mscf/d, T °R)
    var GRID_PER_DECADE = 40;
    var STEHFEST_N = 16;
    var MAX_SAMPLES = 500000;
    var IARF_C = 0.80907;          // 0.5·(ln tD + 0.80907) + S
    var UNIT_FWD = 500000;         // sample-step grid evaluations per generateJob step (count-based, ≈ 15–30 ms desktop)
    var UNIT_GRID = 60000;         // Laplace-kernel evaluations (cost-weighted) per step

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 2 — PRNG (Math.imul only; bit-identical uniform stream)
    // ═════════════════════════════════════════════════════════════════════
    function _mix32(x) {
        x = x | 0;
        x = MM.imul(x ^ (x >>> 16), 0x85ebca6b);
        x = MM.imul(x ^ (x >>> 13), 0xc2b2ae35);
        return (x ^ (x >>> 16)) | 0;
    }
    function rng(seed) {
        var a = _mix32(((seed | 0) ^ 0x9e3779b9) + MM.imul((seed / 4294967296) | 0, 0x632be5ab));
        var spare = null;
        function next() {
            a = (a + 0x6D2B79F5) | 0;
            var t = MM.imul(a ^ (a >>> 15), 1 | a);
            t = (t + MM.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
        function normal() {
            if (spare !== null) { var s = spare; spare = null; return s; }
            var u = next(); while (u <= 0) u = next();
            var v = next(), r = MM.sqrt(-2 * MM.log(u));
            spare = r * MM.sin(2 * MM.PI * v);
            return r * MM.cos(2 * MM.PI * v);
        }
        return {
            next: next,
            normal: normal,
            int: function (lo, hi) { return lo + MM.floor(next() * (hi - lo + 1)); },
            pick: function (arr) { return arr[MM.floor(next() * arr.length)]; },
            uniform: function (lo, hi) { return lo + (hi - lo) * next(); }
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 3 — special functions (own implementations)
    // ═════════════════════════════════════════════════════════════════════
    var _K = [0, 0], _I = [0, 0];
    // e^x·K0(x), e^x·K1(x) into _K. x ≤ 2: power series (A&S 9.6.13 / 9.6.11);
    // x > 2: Steed's continued fraction CF2 (Temme), relative accuracy ≈ 1e-15.
    function besselKe(x) {
        if (x <= 2) {
            var y = 0.25 * x * x, lnx = MM.log(0.5 * x);
            var t0 = 1, t1 = 1, H = 0, i0 = 1, i1s = 1, s0 = 0, s1 = 1 - 2 * EULER;
            for (var k = 1; k < 60; k++) {
                t0 *= y / (k * k); t1 *= y / (k * (k + 1)); H += 1 / k;
                i0 += t0; i1s += t1; s0 += H * t0; s1 += (2 * (H - EULER) + 1 / (k + 1)) * t1;
                if (t0 < 1e-18 * i0 && t1 < 1e-18 * i1s) break;
            }
            var i1 = 0.5 * x * i1s, ex = MM.exp(x);
            _K[0] = (-(lnx + EULER) * i0 + s0) * ex;
            _K[1] = (1 / x + lnx * i1 - 0.25 * x * s1) * ex;
            return _K;
        }
        if (x >= 25) {   // asymptotic series (smallest term ≈ e^−2x ≪ 1e-17)
            var c0 = 1, c1 = 1, a0 = 1, b1 = 1, xi = 1 / (8 * x);
            for (var m = 1; m < 30; m++) {
                a0 *= (2 * m - 1) * (2 * m - 1) * xi / m * -1;
                b1 *= (4 - (2 * m - 1) * (2 * m - 1)) * xi / m;
                c0 += a0; c1 += b1;
                if (MM.abs(a0) < 1e-17 && MM.abs(b1) < 1e-17) break;
            }
            var pre = MM.sqrt(MM.PI / (2 * x));
            _K[0] = pre * c0; _K[1] = pre * c1;
            return _K;
        }
        var b = 2 * (1 + x), d = 1 / b, h = d, delh = d, q1 = 0, q2 = 1, a1 = 0.25, q = a1, c = a1, a = -a1, s = 1 + q * delh;
        for (var i = 2; i < 1000; i++) {
            a -= 2 * (i - 1); c = -a * c / i;
            var qn = (q1 - b * q2) / a; q1 = q2; q2 = qn; q += c * qn;
            b += 2; d = 1 / (b + a * d); delh = (b * d - 1) * delh; h += delh;
            var dels = q * delh; s += dels;
            if (MM.abs(dels / s) < 1e-16) break;
        }
        h = a1 * h;
        _K[0] = MM.sqrt(MM.PI / (2 * x)) / s;
        _K[1] = _K[0] * (x + 0.5 - h) / x;
        return _K;
    }
    // e^−x·I0(x), e^−x·I1(x) into _I: positive power series below 25, asymptotic above.
    function besselIe(x) {
        if (x < 25) {
            var y = 0.25 * x * x, t0 = 1, s0 = 1, t1 = 0.5 * x, s1 = t1;
            for (var k = 1; k < 300; k++) {
                t0 *= y / (k * k); s0 += t0; t1 *= y / (k * (k + 1)); s1 += t1;
                if (t0 < 1e-18 * s0 && t1 < 1e-18 * s1) break;
            }
            var e = MM.exp(-x);
            _I[0] = s0 * e; _I[1] = s1 * e;
            return _I;
        }
        var c = 1 / MM.sqrt(2 * MM.PI * x), a0 = 1, b0 = 1, a1 = 1, b1 = 1;
        var prev0 = Infinity, prev1 = Infinity;
        for (var j = 1; j < 60; j++) {
            var n0 = a0 * (2 * j - 1) * (2 * j - 1) / (8 * j * x);
            var n1 = a1 * ((2 * j - 1) * (2 * j - 1) - 4) / (8 * j * x);
            if (MM.abs(n0) < prev0) { b0 += n0; prev0 = MM.abs(n0); a0 = n0; } else prev0 = -1;
            if (MM.abs(n1) < prev1) { b1 += n1; prev1 = MM.abs(n1); a1 = n1; } else prev1 = -1;
            if ((prev0 < 1e-17 || prev0 === -1) && (prev1 < 1e-17 || prev1 === -1)) break;
        }
        _I[0] = c * b0; _I[1] = c * b1;
        return _I;
    }
    function besselK0(x) { besselKe(x); return _K[0] * MM.exp(-x); }
    // E1(x) = −Ei(−x): series for x ≤ 1, Lentz continued fraction above.
    function expE1(x) {
        if (!(x > 0)) return Infinity;
        if (x > 1) {
            var b = x + 1, c = 1e300, d = 1 / b, h = d;
            for (var i = 1; i < 500; i++) {
                var an = -i * i; b += 2;
                d = 1 / (an * d + b); c = b + an / c;
                var del = c * d; h *= del;
                if (MM.abs(del - 1) < 1e-16) break;
            }
            return h * MM.exp(-x);
        }
        var ans = -MM.log(x) - EULER, fact = 1;
        for (var k = 1; k < 200; k++) {
            fact *= -x / k;
            var dd = -fact / k; ans += dd;
            if (MM.abs(dd) < MM.abs(ans) * 1e-17) break;
        }
        return ans;
    }
    // ∫0^z K0(t) dt: term-by-term series for z < 8; π/2 − Ki1(z) above, with the asymptotic
    // Ki1(z) = √(π/2z)·e^−z·Σ b_k z^−k (b_k = a_k − (k − ½)·b_{k−1}) for z ≥ 16 and
    // Ki1(z) = Ki1(16) + ∫_z^16 K0 (24-point Gauss–Legendre) for 8 ≤ z < 16.
    var GL24 = (function () {   // Gauss–Legendre nodes and weights on [−1, 1], Newton on P_n
        var n = 24, x = [], w = [];
        for (var i = 1; i <= n; i++) {
            var z = MM.cos(MM.PI * (i - 0.25) / (n + 0.5)), pp = 0;
            for (var it = 0; it < 100; it++) {
                var p1 = 1, p2 = 0;
                for (var j = 1; j <= n; j++) { var p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
                pp = n * (z * p1 - p2) / (z * z - 1);
                var dz = p1 / pp; z -= dz;
                if (MM.abs(dz) < 1e-16) break;
            }
            x.push(z); w.push(2 / ((1 - z * z) * pp * pp));
        }
        return { x: x, w: w };
    })();
    function _ki1Asym(z) {
        var a = 1, bk = 1, tot = 1, last = Infinity, zi = 1 / z, pw = 1;
        for (var j = 1; j < 60; j++) {
            a *= -(2 * j - 1) * (2 * j - 1) / (8 * j);
            bk = a - (j - 0.5) * bk;
            pw *= zi;
            var t = bk * pw;
            if (MM.abs(t) >= last) break;
            tot += t; last = MM.abs(t);
            if (last < 1e-17) break;
        }
        return MM.sqrt(MM.PI / (2 * z)) * MM.exp(-z) * tot;
    }
    var KI1_16 = null;
    function intK0(z) {
        if (!(z > 0)) return 0;
        if (z >= 8 && z < 16) {
            if (KI1_16 === null) KI1_16 = _ki1Asym(16);
            var c = 0.5 * (16 + z), hw = 0.5 * (16 - z), s = 0;
            for (var g = 0; g < 24; g++) s += GL24.w[g] * besselK0(c + hw * GL24.x[g]);
            return 0.5 * MM.PI - (KI1_16 + hw * s);
        }
        if (z < 8) {
            var L = MM.log(0.5 * z) + EULER, y = 0.25 * z * z, ck = 1, H = 0, zp = z, sum = 0;
            for (var k = 0; k < 120; k++) {
                if (k > 0) { ck *= y / (k * k); H += 1 / k; zp = z * ck; }
                var m = 2 * k + 1;
                var term = (k === 0 ? z : zp) * (-L / m + 1 / (m * m) + H / m);
                sum += term;
                if (k > 2 && MM.abs(term) < 1e-17 * MM.abs(sum)) break;
            }
            return sum;
        }
        return 0.5 * MM.PI - _ki1Asym(z);
    }
    // Σ_{n≥1} K0(n·x)·e^off. x ≥ 1: direct; x < 1: lattice-sum form
    // π/(2x) + ½(γ + ln(x/4π)) + π·Σ_m [1/√(x² + (2πm)²) − 1/(2πm)] with an Euler–Maclaurin tail.
    function sumK0n(x, off) {
        var s = 0, n, y;
        if (x >= 1) {
            for (n = 1; n < 5000; n++) {
                y = n * x;
                if (y - off > 745) break;
                besselKe(y);
                var t = _K[0] * MM.exp(off - y);
                s += t;
                if (t < 1e-18 * s) break;
            }
            return s;
        }
        var M = 64, acc = 0, x2 = x * x;
        for (var m = 1; m <= M; m++) { var w = 2 * MM.PI * m; acc += 1 / MM.sqrt(x2 + w * w) - 1 / w; }
        // tail Σ_{m>M} [−x²/(2w³) + 3x⁴/(8w⁵)], w = 2πm, Σ_{m>M} m^−p ≈ M^(1−p)/(p−1) − M^−p/2 + p·M^(−p−1)/12
        var z3 = 1 / (2 * M * M) - 1 / (2 * M * M * M) + 3 / (12 * MM.pow(M, 4));
        var z5 = 1 / (4 * MM.pow(M, 4)) - 1 / (2 * MM.pow(M, 5)) + 5 / (12 * MM.pow(M, 6));
        var tp = 2 * MM.PI;
        acc += -x2 / (2 * tp * tp * tp) * z3 + 3 * x2 * x2 / (8 * MM.pow(tp, 5)) * z5;
        s = MM.PI / (2 * x) + 0.5 * (EULER + MM.log(x / (4 * MM.PI))) + MM.PI * acc;
        return s * MM.exp(off);
    }
    // Σ_{n∈Z} K0(x·|n + α|)·e^off, 0 < α < 1. x ≥ 1: direct; x < 1: Poisson form
    // π/x + 2π·Σ_m cos(2πmα)·[1/√(x² + (2πm)²) − 1/(2πm)] − ln(2·sin πα).
    function sumK0shift(x, alpha, off) {
        var s = 0, n;
        if (x >= 1) {
            for (n = 0; n < 5000; n++) {
                var y1 = x * (n + alpha), y2 = x * (n + 1 - alpha), t = 0;
                if (y1 - off < 745) { besselKe(y1); t += _K[0] * MM.exp(off - y1); }
                if (y2 - off < 745) { besselKe(y2); t += _K[0] * MM.exp(off - y2); }
                s += t;
                if (t < 1e-18 * s || (y1 - off > 745 && y2 - off > 745)) break;
            }
            return s;
        }
        var acc = 0, x2 = x * x;
        for (var m = 1; m <= 400; m++) {
            var w = 2 * MM.PI * m;
            acc += MM.cos(w * alpha) * (1 / MM.sqrt(x2 + w * w) - 1 / w);
        }
        s = MM.PI / x + 2 * MM.PI * acc - MM.log(2 * MM.sin(MM.PI * alpha));
        return s * MM.exp(off);
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 4 — Stehfest inversion, N = 16 (weights computed here)
    // ═════════════════════════════════════════════════════════════════════
    function _fact(n) { var f = 1; for (var i = 2; i <= n; i++) f *= i; return f; }
    function stehfestWeights(N) {
        var N2 = N / 2, V = new Array(N);
        for (var i = 1; i <= N; i++) {
            var s = 0;
            for (var k = MM.floor((i + 1) / 2); k <= MM.min(i, N2); k++) {
                s += MM.pow(k, N2) * _fact(2 * k) / (_fact(N2 - k) * _fact(k) * _fact(k - 1) * _fact(i - k) * _fact(2 * k - i));
            }
            V[i - 1] = ((i + N2) % 2 === 0 ? 1 : -1) * s;
        }
        return V;
    }
    var STEH = stehfestWeights(STEHFEST_N);

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 5 — Laplace kernels (reservoir response at the well, unit rate)
    // ═════════════════════════════════════════════════════════════════════
    // Parameters are dimensionless (lengths in wellbore radii):
    //   fault / constp {dF}; channel {a, b} (distances to the two faults); composite {M, F, R}
    //   (M = inner/outer mobility, F = inner/outer storativity, R = inner radius); closed {reD};
    //   dualpor {omega, lambda}; partpen {hD = h/rw, kvkh, hw (open fraction), ztop (top of the
    //   open interval as a fraction of h)}; frac {xfD}.
    var KERNEL_COST = { line: 1, homogeneous: 1, dualpor: 1, fault: 2, constp: 2, frac: 3, closed: 3, composite: 4, channel: 25, partpen: 400 };
    function lapRes(model, s, P) {
        var x = MM.sqrt(s), k0, k1, y, img;
        switch (model) {
            case 'line':
                return besselK0(x) / s;
            case 'homogeneous':
                besselKe(x);
                return _K[0] / (s * x * _K[1]);
            case 'dualpor': {
                var om = P.omega, la = P.lambda;
                var u = s * (om * (1 - om) * s + la) / ((1 - om) * s + la);
                var xu = MM.sqrt(u);
                besselKe(xu);
                return _K[0] / (s * xu * _K[1]);
            }
            case 'fault':
            case 'constp':
                besselKe(x); k0 = _K[0]; k1 = _K[1];
                y = 2 * P.dF * x;
                img = (y - x < 745) ? (besselKe(y), _K[0] * MM.exp(x - y)) : 0;
                return (k0 + (model === 'fault' ? img : -img)) / (s * x * k1);
            case 'channel': {
                besselKe(x); k0 = _K[0]; k1 = _K[1];
                var W = P.a + P.b, z = 2 * W * x;
                img = 2 * sumK0n(z, x) + sumK0shift(z, P.a / W, x);
                return (k0 + img) / (s * x * k1);
            }
            case 'composite': {
                var R = P.R, a = x * R, b = a * MM.sqrt(P.M / P.F);
                besselKe(b);
                var gam = (_K[1] / _K[0]) / MM.sqrt(P.M * P.F);
                besselKe(a); var k0a = _K[0], k1a = _K[1];
                besselIe(a); var i0a = _I[0], i1a = _I[1];
                var th = (k1a - gam * k0a) / (i1a + gam * i0a);
                besselKe(x); k0 = _K[0]; k1 = _K[1];
                besselIe(x);
                var E = MM.exp(2 * x * (1 - R));
                return (k0 + th * _I[0] * E) / (s * x * (k1 - th * _I[1] * E));
            }
            case 'closed': {
                var bb = x * P.reD;
                besselKe(bb); var k1b = _K[1];
                besselIe(bb); var rr = k1b / _I[1];
                besselKe(x); k0 = _K[0]; k1 = _K[1];
                besselIe(x);
                var E2 = MM.exp(2 * x * (1 - P.reD));
                return (k0 + rr * _I[0] * E2) / (s * x * (k1 - rr * _I[1] * E2));
            }
            case 'partpen': {
                besselKe(x);
                var base = _K[0] / (s * x * _K[1]);
                var pp = P._pp, nC = P._nCut || 1, sum = pp.tail[nC];
                for (var n = 1; n <= nC; n++) {
                    var arg = MM.sqrt(s + pp.a[n]);
                    if (arg > 745) break;
                    besselKe(arg);
                    sum += pp.c[n] * _K[0] * MM.exp(-arg);
                }
                return base + sum / s;
            }
            case 'frac': {
                var X = P.xfD;
                return (intK0(x * X * 1.732) + intK0(x * X * 0.268)) / (2 * s * x * X);
            }
        }
        throw new Error('synth: unknown kernel ' + model);
    }
    // Uniform-flux, interval-averaged partial-penetration series (Gringarten–Ramey form):
    // p̄ = K0/(s√s K1) + (1/s)·Σ c_n K0(√(s + a_n)), c_n = (2/hw²)·((sin nπz2 − sin nπz1)/(nπ))²,
    // a_n = (kv/kh)·(nπ/hD)². Terms past the per-time cut use K0(√a_n) (precomputed tail).
    // Count-sliced preparation (generateJob): step(nTerms) evaluates nTerms more series terms; one term costs about one
    // Bessel evaluation (one cost unit of KERNEL_COST). The last prepared table is memoised by its parameters.
    var _ppMemo = { key: null, val: null };
    function _ppKey(P) { return [P.hD, P.kvkh, P.hw, P.ztop].map(function (v) { return (+v).toPrecision(12); }).join('|'); }
    function _ppPrepareJob(P) {
        var key = _ppKey(P);
        if (_ppMemo.key === key) return { done: true, result: _ppMemo.val, step: function () { return 0; } };
        var hD = P.hD, kap = P.kvkh, hw = P.hw, z1 = P.ztop, z2 = P.ztop + P.hw;
        var nMax = MM.max(20, MM.min(200000, MM.ceil(40 * hD / (MM.PI * MM.sqrt(kap)))));
        var c = new Float64Array(nMax + 2), a = new Float64Array(nMax + 2), tail = new Float64Array(nMax + 2), t = new Float64Array(nMax + 2);
        var job = { done: false, result: null, next: 1 };
        job.step = function (nTerms) {
            var end = MM.min(nMax, job.next + MM.max(1, nTerms) - 1), n;
            for (n = job.next; n <= end; n++) {
                var w = n * MM.PI, d = (MM.sin(w * z2) - MM.sin(w * z1)) / w;
                c[n] = 2 * d * d / (hw * hw);
                a[n] = kap * (w / hD) * (w / hD);
                t[n] = c[n] * besselK0(MM.sqrt(a[n]));
            }
            var used = end - job.next + 1;
            job.next = end + 1;
            if (job.next > nMax) {
                tail[nMax] = 0;
                for (n = nMax - 1; n >= 0; n--) tail[n] = tail[n + 1] + t[n + 1];
                job.result = { c: c, a: a, tail: tail, nMax: nMax, Spp: tail[0] };
                job.done = true;
                _ppMemo.key = key; _ppMemo.val = job.result;
            }
            return used;
        };
        return job;
    }
    function _ppPrepare(P) {
        var j = _ppPrepareJob(P);
        while (!j.done) j.step(1e9);
        return j.result;
    }
    // Terms with a_n ≥ 25·s_max are replaced by K0(√a_n) (≤ 2 % in the argument, smooth in s within one
    // inversion); the cap of 300 only affects times where wellbore storage dominates.
    function _ppCut(P, sMax) {
        var nc = MM.ceil(MM.sqrt(25 * sMax / P.kvkh) * P.hD / MM.PI);
        return MM.max(10, MM.min(P._pp.nMax, MM.min(300, nc)));
    }
    // Effective-wellbore-radius transform for S < 0 (e = e^S).
    function _scaled(model, P, e) {
        var Q = {}, k;
        for (k in P) if (Object.prototype.hasOwnProperty.call(P, k) && k.charAt(0) !== '_') Q[k] = P[k];
        ['dF', 'a', 'b', 'R', 'reD', 'hD', 'xfD'].forEach(function (key) { if (typeof Q[key] === 'number') Q[key] *= e; });
        if (typeof Q.lambda === 'number') Q.lambda /= (e * e);
        return Q;
    }
    function _prep(model, P) {
        if (model === 'partpen' && !P._pp) P._pp = _ppPrepare(P);
        return P;
    }
    // Wellbore storage and skin, folded in Laplace space: p̄w = (s·p̄r + S)/(s·(1 + Cd·s·(s·p̄r + S))).
    function _fold(sp, s, Cd, S) {
        var w = sp + S;
        return w / (s * (1 + Cd * s * w));
    }
    // One Stehfest inversion at tD: returns [pwD, tD·dpwD/dtD].
    function _invert(model, P, Cd, S, ta) {
        var sum = 0, sumD = 0, f = LN2 / ta;
        if (model === 'partpen') P._nCut = _ppCut(P, STEHFEST_N * f);
        for (var i = 0; i < STEHFEST_N; i++) {
            var s = (i + 1) * f;
            var F = _fold(s * lapRes(model, s, P), s, Cd, S);
            sum += STEH[i] * F; sumD += STEH[i] * s * F;
        }
        return [f * sum, LN2 * sumD];
    }
    // Direct (grid-free) pwD at each tD: pwd(model, {Cd, S, ...}, tD[]).
    function pwd(model, params, tD) {
        params = params || {};
        var Cd = +params.Cd || 0, S = +params.S || 0, P = params, tScale = 1;
        if (S < 0) { var e = MM.exp(S); P = _scaled(model, params, e); Cd = Cd * e * e; tScale = e * e; S = 0; }
        else P = _scaled(model, params, 1);
        _prep(model, P);
        var arr = Array.isArray(tD) || ArrayBuffer.isView(tD) ? tD : [tD], out = [];
        for (var i = 0; i < arr.length; i++) out.push(arr[i] > 0 ? _invert(model, P, Cd, S, arr[i] * tScale)[0] : 0);
        return out;
    }
    function pwdPrime(model, params, tD) {
        params = params || {};
        var Cd = +params.Cd || 0, S = +params.S || 0, P = params, tScale = 1;
        if (S < 0) { var e = MM.exp(S); P = _scaled(model, params, e); Cd = Cd * e * e; tScale = e * e; S = 0; }
        else P = _scaled(model, params, 1);
        _prep(model, P);
        var arr = Array.isArray(tD) || ArrayBuffer.isView(tD) ? tD : [tD], out = [];
        for (var i = 0; i < arr.length; i++) out.push(arr[i] > 0 ? _invert(model, P, Cd, S, arr[i] * tScale)[1] : 0);
        return out;
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 6 — evaluation grid: 40 points per decade, cubic Hermite in ln tD
    // ═════════════════════════════════════════════════════════════════════
    var DX = LN10 / GRID_PER_DECADE;
    // A grid job: build(n) fills n more points; done when g.ready.
    function gridJob(model, params, Cd, S, tDmin, tDmax) {
        var P, tScale = 1, Cde = Cd, Se = S;
        if (S < 0) { var e = MM.exp(S); P = _scaled(model, params, e); Cde = Cd * e * e; tScale = e * e; Se = 0; }
        else P = _scaled(model, params, 1);
        var x0 = MM.log(tDmin), n = MM.max(4, MM.ceil((MM.log(tDmax) - x0) / DX) + 2);
        var g = { model: model, x0: x0, dx: DX, idx: 1 / DX, n: n, P: new Float64Array(n), D: new Float64Array(n), Cd: Cd, S: S, ready: false, filled: 0,
                  cost: (KERNEL_COST[model] || 1) * STEHFEST_N };
        var prepared = false, ppJob = null;
        // build(budget): evaluates grid points (and, for partial penetration, its series preparation first) until
        // `budget` cost units are used (at least one point); returns the cost units used.
        g.build = function (budget) {
            var used = 0;
            if (!prepared) {
                if (model === 'partpen' && !P._pp) {
                    if (!ppJob) ppJob = _ppPrepareJob(P);
                    if (!ppJob.done) used += ppJob.step(MM.max(1, MM.floor(budget)));
                    if (!ppJob.done) return used;
                    P._pp = ppJob.result;
                }
                _prep(model, P); prepared = true;
            }
            var i = g.filled;
            while (i < n && (used === 0 || used + g.cost <= budget)) {
                var tD = MM.exp(x0 + i * DX), r = _invert(model, P, Cde, Se, tD * tScale);
                g.P[i] = r[0]; g.D[i] = r[1];
                i++; used += g.cost;
            }
            g.filled = i;
            if (i >= n) { g.ready = true; g.P0 = g.P[0]; g.tD0 = MM.exp(x0); }
            return used;
        };
        return g;
    }
    function buildGrid(model, params, Cd, S, tDmin, tDmax) {
        var g = gridJob(model, params, Cd, S, tDmin, tDmax);
        while (!g.ready) g.build(Infinity);
        return g;
    }
    // pwD at tD from a grid (early: pure storage or log extrapolation; late: log-linear).
    function gEval(g, tD) {
        if (!(tD > 0)) return 0;
        var x = MM.log(tD), f = (x - g.x0) * g.idx;
        if (f < 0) {
            if (g.Cd > 0) return g.P0 * tD / g.tD0;
            var v = g.P[0] + g.D[0] * (x - g.x0);
            return v > 0 ? v : 0;
        }
        var i = MM.floor(f);
        if (i >= g.n - 1) { var j = g.n - 1; return g.P[j] + g.D[j] * (x - g.x0 - j * g.dx); }
        var u = f - i, u2 = u * u, u3 = u2 * u, dx = g.dx;
        return (2 * u3 - 3 * u2 + 1) * g.P[i] + (u3 - 2 * u2 + u) * dx * g.D[i] + (3 * u2 - 2 * u3) * g.P[i + 1] + (u3 - u2) * dx * g.D[i + 1];
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 7 — gas PVT (own correlations) and the m(p) table
    // ═════════════════════════════════════════════════════════════════════
    var DAK = [0, 0.3265, -1.0700, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210];
    function gasPVT(gas, pmax) {
        var yN = (gas.n2 || 0) / 100, yC = (gas.co2 || 0) / 100, yH = (gas.h2s || 0) / 100, yI = yN + yC + yH;
        var sgHC = MM.max(0.55, (gas.sg - (yN * 0.9672 + yC * 1.5196 + yH * 1.1767)) / MM.max(1e-6, 1 - yI));
        var TpcH = 169.2 + 349.5 * sgHC - 74.0 * sgHC * sgHC, PpcH = 756.8 - 131.0 * sgHC - 3.6 * sgHC * sgHC;
        var Tpc = (1 - yI) * TpcH + yN * 227.3 + yC * 547.6 + yH * 672.4;
        var Ppc = (1 - yI) * PpcH + yN * 493.1 + yC * 1071.0 + yH * 1306.0;
        var A = yC + yH, Bh = yH;
        var eps = 120 * (MM.pow(A, 0.9) - MM.pow(A, 1.6)) + 15 * (MM.sqrt(Bh) - MM.pow(Bh, 4));
        var TpcS = Tpc - eps, PpcS = Ppc * TpcS / (Tpc + Bh * (1 - Bh) * eps);
        var T = gas.T_F + 459.67, Ma = 28.97 * gas.sg, Tr = T / TpcS;
        var c1 = DAK[1] + DAK[2] / Tr + DAK[3] / MM.pow(Tr, 3) + DAK[4] / MM.pow(Tr, 4) + DAK[5] / MM.pow(Tr, 5);
        var c2 = DAK[6] + DAK[7] / Tr + DAK[8] / (Tr * Tr), c3 = DAK[9] * (DAK[7] / Tr + DAK[8] / (Tr * Tr)), T3 = Tr * Tr * Tr;
        function zOf(p) {
            if (!(p > 0)) return 1;
            var Pr = p / PpcS, rho = 0.27 * Pr / Tr;
            for (var it = 0; it < 80; it++) {
                var r2 = rho * rho, ex = MM.exp(-DAK[11] * r2);
                var zz = 1 + c1 * rho + c2 * r2 - c3 * r2 * r2 * rho + DAK[10] * (1 + DAK[11] * r2) * (r2 / T3) * ex;
                var f = zz - 0.27 * Pr / (rho * Tr);
                var dz = c1 + 2 * c2 * rho - 5 * c3 * r2 * r2 + (2 * DAK[10] * rho / T3) * (1 + DAK[11] * r2 - DAK[11] * DAK[11] * r2 * r2) * ex;
                var dr = f / (dz + 0.27 * Pr / (rho * rho * Tr));
                rho -= dr;
                if (rho <= 1e-9) rho = 1e-9;
                if (MM.abs(dr) < 1e-13 * MM.max(1, rho)) break;
            }
            return 0.27 * Pr / (rho * Tr);
        }
        var Kv = (9.4 + 0.02 * Ma) * MM.pow(T, 1.5) / (209 + 19 * Ma + T), Xv = 3.5 + 986 / T + 0.01 * Ma, Yv = 2.4 - 0.2 * Xv;
        function muOf(p, z) { var rho = 1.4935e-3 * p * Ma / (z * T); return 1e-4 * Kv * MM.exp(Xv * MM.pow(rho, Yv)); }
        var N = 2400, dp = pmax / (N - 1), pp = new Float64Array(N), zz = new Float64Array(N), mu = new Float64Array(N), fm = new Float64Array(N), mm = new Float64Array(N);
        for (var i = 0; i < N; i++) {
            var p = i * dp; pp[i] = p;
            var z = zOf(MM.max(p, 1e-3)); zz[i] = z; mu[i] = muOf(MM.max(p, 1e-3), z);
            fm[i] = 2 * p / (mu[i] * z);
            if (i > 0) {
                var fdl = (i > 1) ? (fm[i] - fm[i - 2]) / (2 * dp) : (fm[i] - fm[i - 1]) / dp;
                mm[i] = mm[i - 1] + 0.5 * dp * (fm[i - 1] + fm[i]);
                if (!isFinite(fdl)) mm[i] = mm[i - 1] + 0.5 * dp * (fm[i - 1] + fm[i]);
            }
        }
        function _seg(p) { var j = MM.floor(p / dp); return j < 0 ? 0 : (j > N - 2 ? N - 2 : j); }
        function mOf(p) {
            var j = _seg(p), u = (p - pp[j]) / dp, u2 = u * u, u3 = u2 * u;
            return (2 * u3 - 3 * u2 + 1) * mm[j] + (u3 - 2 * u2 + u) * dp * fm[j] + (3 * u2 - 2 * u3) * mm[j + 1] + (u3 - u2) * dp * fm[j + 1];
        }
        function pOfM(m) {
            if (m <= 0) return 0;
            var lo = 0, hi = N - 1;
            if (m >= mm[N - 1]) return pp[N - 1] + (m - mm[N - 1]) / fm[N - 1];
            while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (mm[mid] <= m) lo = mid; else hi = mid; }
            var p = pp[lo] + dp * (m - mm[lo]) / (mm[lo + 1] - mm[lo]);
            for (var it = 0; it < 4; it++) {
                var f = mOf(p) - m, j = _seg(p), u = (p - pp[j]) / dp;
                var slope = fm[j] + (fm[j + 1] - fm[j]) * u;
                if (!(slope > 0)) break;
                p -= f / slope;
            }
            return p;
        }
        // Bg in rb/Mscf (gas rates are Mscf/d): 5.035·z·T/p, the unit the engines use for gas B (§3.7 WellInput).
        function props(p) {
            var z = zOf(p), m = muOf(p, z), h = MM.max(0.5, p * 1e-4);
            var dzdp = (zOf(p + h) - zOf(p - h)) / (2 * h);
            var cg = 1 / p - dzdp / z;
            return { p: p, z: z, mu: m, cg: cg, Bg: 5.035 * z * T / p };
        }
        return { T_R: T, zOf: zOf, muOf: function (p) { return muOf(p, zOf(p)); }, mOf: mOf, pOfM: pOfM, props: props, Tpc: TpcS, Ppc: PpcS };
    }
    var GAS_SW = 0.25, GAS_CW = 3e-6, GAS_CF = 4e-6;
    function gasCt(cg) { return (1 - GAS_SW) * cg + GAS_SW * GAS_CW + GAS_CF; }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 8 — small helpers
    // ═════════════════════════════════════════════════════════════════════
    function lin(u, a, b) { return a + (b - a) * u; }
    function logU(u, a, b) { return a * MM.pow(b / a, u); }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function median(arr) {
        var s = arr.filter(function (v) { return isFinite(v); }).sort(function (a, b) { return a - b; }), n = s.length;
        if (!n) return null;
        return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function dateOf(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
    function round6(v) { return (v === 0 || !isFinite(v)) ? v : parseFloat(v.toPrecision(6)); }
    function roundTo(v, r) { return r > 0 ? MM.round(v / r) * r : v; }
    function fin(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
    function deepCopy(o) {
        if (o === null || typeof o !== 'object') return o;
        if (ArrayBuffer.isView(o)) return new o.constructor(o);
        if (Array.isArray(o)) return o.map(deepCopy);
        var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = deepCopy(o[k]);
        return r;
    }
    function bsearchFirstAbove(arr, v) {   // first index i with arr[i] > v
        var lo = 0, hi = arr.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] > v) hi = mid; else lo = mid + 1; }
        return lo;
    }
    // ═════════════════════════════════════════════════════════════════════
    // SECTION 9 — scenario: rate schedule, steps, skins
    // ═════════════════════════════════════════════════════════════════════
    // SC (internal scenario) = {
    //   name, fluid, T0_ms, tEnd_h, res: {k, h, phi, mu, B, ct, rw, C, pi, D, model, mp}, gas: null|{...},
    //   prod: {tStart_h, qHist, qDay: [], dayShift_h, flushPct, flushDecay_h},
    //   events: [{kind:'shutin'|'partial', tc, dur, f, ramp_s, pb:{f, lead}|null, intra:{lead, factor}|null,
    //             Safter: number|null, isTest, label}],
    //   S0, sampling: {base_s, dense_s, burst}, noise: {...}, extras: {...}, gap: null|{t0, t1},
    //   alloc: {...}, rateSource, given, history, zones, seedNoise }
    // Hold the true day rate of the QUIET_DAYS days before day index dc at the closing day's rate qDay[dc] (no day-boundary
    // step over the closing day and the 4 days before it; the variation there lives in the allocation error). A softer
    // ±2 % compression was measured too: it made no difference to the detection reach, because the pressure step of even
    // a 1–2 % rate change exceeds the 5 psi rise threshold on most wells.
    var QUIET_DAYS = 4;
    function _quietWindow(qDay, dc) {
        if (!(dc >= 0 && dc < qDay.length)) return;
        for (var d = MM.max(0, dc - QUIET_DAYS); d < dc; d++) qDay[d] = qDay[dc];
    }
    function _qDayAt(SC, t) {
        var pr = SC.prod, d = MM.floor((t - pr.dayShift_h) / 24) - pr.dayIndex0;
        return pr.qDay[clamp(d, 0, pr.qDay.length - 1)];
    }
    function _qAt(SC, t) {
        var pr = SC.prod;
        if (t < pr.tStart_h) return 0;
        if (t < 0) return pr.qHist;
        var base = _qDayAt(SC, t), mult = 1, lastOpen = -Infinity, i, ev;
        for (i = 0; i < SC.events.length; i++) {
            ev = SC.events[i];
            var tr = ev.tc + ev.dur;
            if (ev.kind === 'shutin') {
                if (t >= ev.tc && t < tr) return 0;
                if (tr <= t && tr > lastOpen) lastOpen = tr;
            } else if (ev.kind === 'partial') {
                if (t >= ev.tc && t < tr) mult *= (1 - ev.f);
            }
            if (ev.ramp_s > 0) {
                var rh = ev.ramp_s / 3600;
                if (t >= ev.tc - rh && t < ev.tc) mult *= (ev.tc - t) / rh;
            }
            if (ev.pb && t >= ev.tc - ev.pb.lead && t < ev.tc) mult *= (1 - ev.pb.f);
            if (ev.intra && t >= ev.tc - ev.intra.lead && t < ev.tc) mult *= ev.intra.factor;
        }
        var fl = 1;
        if (isFinite(lastOpen) && pr.flushPct > 0) {
            var dtr = t - lastOpen;
            if (dtr < 3 * pr.flushDecay_h) fl = 1 + pr.flushPct / 100 * MM.exp(-dtr / pr.flushDecay_h);
        }
        return base * mult * fl;
    }
    function buildSteps(SC) {
        var pr = SC.prod, B = [pr.tStart_h, 0], i, m;
        var dLast = MM.ceil((SC.tEnd_h - pr.dayShift_h) / 24) + 1;
        for (var d = pr.dayIndex0; d <= dLast; d++) { var tb = pr.dayShift_h + 24 * d; if (tb > 0 && tb < SC.tEnd_h) B.push(tb); }
        SC.events.forEach(function (ev) {
            B.push(ev.tc, ev.tc + ev.dur);
            if (ev.ramp_s > 0) { var rh = ev.ramp_s / 3600; for (m = 0; m < 5; m++) B.push(ev.tc - rh + m * rh / 5); }
            if (ev.pb) B.push(ev.tc - ev.pb.lead);
            if (ev.intra) B.push(ev.tc - ev.intra.lead);
            if (ev.kind === 'shutin' && pr.flushPct > 0) for (m = 1; m <= MM.ceil(3 * pr.flushDecay_h); m++) B.push(ev.tc + ev.dur + m);
        });
        B = B.filter(function (t) { return t >= pr.tStart_h && t < SC.tEnd_h; }).sort(function (a, b) { return a - b; });
        var uniq = [];
        for (i = 0; i < B.length; i++) if (!uniq.length || B[i] - uniq[uniq.length - 1] > 1e-9) uniq.push(B[i]);
        var steps = [], prevQ = 0;
        for (i = 0; i < uniq.length; i++) {
            var a = uniq[i], b = (i + 1 < uniq.length) ? uniq[i + 1] : SC.tEnd_h;
            var q = _qAt(SC, 0.5 * (a + b));
            if (MM.abs(q - prevQ) > 1e-9 * MM.max(1, MM.abs(q))) { steps.push({ t: a, q: q }); prevQ = q; }
        }
        // period skin: S0, then each shut-in's Safter from its reopening on
        var opens = SC.events.filter(function (ev) { return ev.kind === 'shutin' && ev.Safter != null; })
            .map(function (ev) { return { t: ev.tc + ev.dur, S: ev.Safter }; }).sort(function (a, b) { return a.t - b.t; });
        function Smech(t) { var S = SC.S0; for (var j = 0; j < opens.length; j++) if (opens[j].t <= t + 1e-9) S = opens[j].S; return S; }
        var D = SC.res.D || 0, prevSq = 0;
        for (i = 0; i < steps.length; i++) {
            var st = steps[i], Sp = Smech(st.t) + D * st.q;
            var sq = st.q * Sp, dq = st.q - (i ? steps[i - 1].q : 0);
            st.dq = dq;
            st.Sstep = (sq - prevSq) / dq;
            st.Smech = Smech(st.t);
            prevSq = sq;
        }
        SC.steps = steps;
        SC.SmechAt = Smech;
        return steps;
    }
    function qBeforeAt(SC, t) {   // step rate in effect just before t
        var q = 0;
        for (var i = 0; i < SC.steps.length && SC.steps[i].t < t - 1e-9; i++) q = SC.steps[i].q;
        return q;
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 10 — grids for a scenario (exact per skin value, or skin nodes)
    // ═════════════════════════════════════════════════════════════════════
    function _skinPlan(steps) {
        var vals = [];
        steps.forEach(function (st) { var s = st.Sstep; if (!vals.some(function (v) { return MM.abs(v - s) < 1e-9; })) vals.push(s); });
        vals.sort(function (a, b) { return a - b; });
        if (vals.length <= 16) return { mode: 'exact', values: vals };
        var lo = MM.floor((vals[0] - 0.5) * 4) / 4, hi = MM.ceil((vals[vals.length - 1] + 0.5) * 4) / 4, nodes = [];
        for (var v = lo; v <= hi + 1e-9; v += 0.25) nodes.push(MM.round(v * 4) / 4);
        return { mode: 'nodes', values: nodes };
    }
    // Attach to each step either .g (one grid) or .gw = [[grid, weight] × 4] (cubic Lagrange in S).
    function _attachGrids(steps, plan, grids) {
        steps.forEach(function (st) {
            if (plan.mode === 'exact') {
                for (var i = 0; i < plan.values.length; i++) if (MM.abs(plan.values[i] - st.Sstep) < 1e-9) { st.g = grids[i]; break; }
                st.gw = null;
                return;
            }
            var v = plan.values, j = clamp(MM.floor((st.Sstep - v[0]) / 0.25) - 1, 0, v.length - 4), w = [];
            for (var a = 0; a < 4; a++) {
                var L = 1;
                for (var b = 0; b < 4; b++) if (b !== a) L *= (st.Sstep - v[j + b]) / (v[j + a] - v[j + b]);
                w.push([grids[j + a], L]);
            }
            st.g = null; st.gw = w;
        });
    }
    function _stepEval(st, tD) {
        if (st.g) return gEval(st.g, tD);
        var s = 0; for (var k = 0; k < 4; k++) s += st.gw[k][1] * gEval(st.gw[k][0], tD);
        return s;
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 11 — the generation job (count-sliced): scenario → record, allocation, truth
    // ═════════════════════════════════════════════════════════════════════
    function _tdc(res, muct) { return C_TD * res.k / (res.phi * muct * res.rw * res.rw); }

    function _sampleTimes(SC, maxSamples) {
        var tEndMs = MM.round(SC.tEnd_h * HOUR_MS);
        function segs(baseS, denseS) {
            var L = [{ a: 0, b: tEndMs, st: baseS * 1000 }];
            SC.events.forEach(function (ev) {
                var tcm = MM.round(ev.tc * HOUR_MS), te = MM.min(tEndMs, MM.round((ev.tc + ev.dur) * HOUR_MS));
                var a = MM.max(0, tcm - DAY_MS);
                if (SC.sampling.burst) {
                    L.push({ a: a, b: te, st: 60000 });
                    L.push({ a: tcm, b: MM.min(te, tcm + 2 * HOUR_MS), st: 1000 });
                } else L.push({ a: a, b: te, st: denseS * 1000 });
            });
            return L;
        }
        var base = SC.sampling.base_s, dense = SC.sampling.dense_s, L, count, guard = 0;
        for (;;) {
            L = segs(base, dense);
            count = 0;
            L.forEach(function (s) { count += MM.floor(s.b / s.st) - MM.ceil(s.a / s.st) + 1; });
            if (count <= maxSamples || guard++ > 12) break;
            if (base < 3600) base *= 2; else { dense *= 2; SC.sampling.burst = false; }
        }
        SC.sampling.base_eff = base; SC.sampling.dense_eff = dense;
        // k-way merge of the segments' arithmetic progressions (each ascending), duplicates dropped: O(n·segments), no sort
        var nSeg = L.length, kNext = new Float64Array(nSeg), kLast = new Float64Array(nSeg), stp = new Float64Array(nSeg), j;
        for (j = 0; j < nSeg; j++) { stp[j] = L[j].st; kNext[j] = MM.ceil(L[j].a / L[j].st); kLast[j] = MM.floor(L[j].b / L[j].st); }
        var out = new Float64Array(count), m = 0;
        for (;;) {
            var best = Infinity;
            for (j = 0; j < nSeg; j++) if (kNext[j] <= kLast[j]) { var v = kNext[j] * stp[j]; if (v < best) best = v; }
            if (best === Infinity) break;
            if (!m || best > out[m - 1]) out[m++] = best;
            for (j = 0; j < nSeg; j++) if (kNext[j] <= kLast[j] && kNext[j] * stp[j] === best) kNext[j]++;
        }
        return out.slice(0, m);   // ms after T0, strictly ascending
    }

    // Work units are count-based (the §4.8 slicing rule: a static cost table, never a clock). The forward phase does
    // UNIT_FWD sample-step evaluations per step (a single superposition step is split across units when needed), the
    // grid phase UNIT_GRID cost units (Bessel evaluations, KERNEL_COST), and the finishing phase UNIT_FIN ops on the same
    // scale as the forward phase (one op ≈ one interpolated grid evaluation) with the per-item weights of OPS. An
    // indivisible item (one allocation pass, one truth tail) waits for a fresh unit when it does not fit the rest of one.
    // job.stats() reports the largest step of each phase against its cap (test GE1).
    var UNIT_FIN = UNIT_FWD;
    // (weights measured on desktop V8: one op ≈ 30 ns; pseudo-time per sample = pseudoEval·(steps evaluated) + pseudoSample)
    var OPS = { setupSample: 3, pOil: 1, pGas: 40, pseudoEval: 3, pseudoSample: 450, extra: 5, extraOffset: 75, flow: 2, noise: 10, post: 2, gap: 1,
                record: 4, allocCell: 6, curvePoint: 5, plateauPoint: 4, reachPoint: 100, gradeOp: 0.4 };

    function GenJob(SC, opts) {
        opts = opts || {};
        var self = this;
        this.SC = SC; this.phase = 0; this.res = null; this.cancelled = false;
        var steps, plan, grids = [], gridJobs = [], refPlan, refGrids = [], tms, th, acc, nS, stepIdx = 0, fwdI = -1, isGas = SC.fluid === 'gas';
        var res = SC.res, muct = res.mu * res.ct;
        var unitsTotal = 1, unitsDone = 0, lastOps = 0;
        var stats = { steps: 0, max: { setup: 0, grid: 0, fwd: 0, fin: 0 }, cap: { setup: null, grid: UNIT_GRID, fwd: UNIT_FWD, fin: UNIT_FIN }, worst: null };
        // setup in two steps: (A) gas tables, the rate steps and the sample times; (B) hours, grids and the unit plan
        function setupA() {
            if (isGas) { _gasSetup(SC); _fillGasGiven(SC); }
            muct = SC.res.muct || (res.mu * res.ct);
            steps = buildSteps(SC);
            tms = _sampleTimes(SC, opts.maxSamples || MAX_SAMPLES);
            return tms.length * OPS.setupSample;
        }
        function setup() {
            nS = tms.length; th = new Float64Array(nS);
            for (var i = 0; i < nS; i++) th[i] = tms[i] / HOUR_MS;
            acc = new Float64Array(nS);
            SC.tdc = _tdc(res, muct);
            SC.Cd = C_CD * res.C / (res.phi * (SC.res.ctRef || res.ct) * res.h * res.rw * res.rw);
            var span = SC.tEnd_h - SC.prod.tStart_h;
            var tDmin = SC.tdc * 0.25 / 3600, tDmax = SC.tdc * span * 1.05;
            plan = _skinPlan(steps);
            plan.values.forEach(function (S) { var gj = gridJob(res.model, res.mp || {}, SC.Cd, S, tDmin, tDmax); grids.push(gj); gridJobs.push(gj); });
            refPlan = plan;
            if (res.model !== 'homogeneous') {
                plan.values.forEach(function (S) { var gj = gridJob('homogeneous', {}, SC.Cd, S + (SC.Sgeo || 0), tDmin, tDmax); refGrids.push(gj); gridJobs.push(gj); });
            } else refGrids = grids;
            var gridUnits = 0, maxCost = 0; gridJobs.forEach(function (g) { gridUnits += g.n * g.cost; maxCost = MM.max(maxCost, g.cost); });
            stats.cap.grid = UNIT_GRID + maxCost;   // a step may finish the point it started
            var fwd = 0, j = 0, wNode = plan.mode === 'nodes' ? 4 : 1; steps.forEach(function (st) { while (j < nS && th[j] <= st.t) j++; fwd += (nS - j) * wNode; });
            SC._fwdOps = fwd;
            unitsTotal = gridUnits / UNIT_GRID + fwd / UNIT_FWD + 2;
            return nS * OPS.setupSample;
        }
        function gridsStep() {
            var budget = UNIT_GRID, used = 0;
            for (var i = 0; i < gridJobs.length && used < budget; i++) {
                if (gridJobs[i].ready) continue;
                used += gridJobs[i].build(budget - used);
            }
            unitsDone += used / UNIT_GRID;
            lastOps = used;
            return gridJobs.every(function (g) { return g.ready; });
        }
        function forwardStep() {
            var ops = 0, tdc = SC.tdc;
            while (stepIdx < steps.length && ops < UNIT_FWD) {
                var st = steps[stepIdx], dq = st.dq, t0 = st.t, i;
                if (fwdI < 0) fwdI = bsearchFirstAbove(th, t0);
                var w = st.g ? 1 : 4, iEnd = MM.min(nS, fwdI + MM.max(1, MM.ceil((UNIT_FWD - ops) / w)));
                if (st.g) {
                    var g = st.g, P = g.P, D = g.D, x0 = g.x0, idx = g.idx, n1 = g.n - 1, gdx = g.dx;
                    for (i = fwdI; i < iEnd; i++) {
                        var tD = tdc * (th[i] - t0), x = MM.log(tD), f = (x - x0) * idx, v;
                        if (f < 0 || f >= n1) v = gEval(g, tD);
                        else {
                            var k = MM.floor(f), u = f - k, u2 = u * u, u3 = u2 * u;
                            v = (2 * u3 - 3 * u2 + 1) * P[k] + (u3 - 2 * u2 + u) * gdx * D[k] + (3 * u2 - 2 * u3) * P[k + 1] + (u3 - u2) * gdx * D[k + 1];
                        }
                        acc[i] += dq * v;
                    }
                } else {
                    for (i = fwdI; i < iEnd; i++) acc[i] += dq * _stepEval(st, tdc * (th[i] - t0));   // four skin-node grids
                }
                ops += (iEnd - fwdI) * w;
                fwdI = iEnd;
                if (fwdI >= nS) { stepIdx++; fwdI = -1; }
            }
            unitsDone += ops / UNIT_FWD;
            lastOps = ops;
            return stepIdx >= steps.length;
        }
        var fin = null;
        function finishStep() {
            if (!fin) fin = new _Finisher(SC, steps, refGrids, refPlan, tms, th, acc, opts);
            var done = fin.step();
            lastOps = fin.lastOps;
            if (done) { self.res = fin.result; return true; }
            return false;
        }
        function note(phase) {
            stats.steps++;
            if (lastOps > stats.max[phase]) stats.max[phase] = lastOps;
            var cap = stats.cap[phase], ratio = cap ? lastOps / cap : 0;
            if (cap && (!stats.worst || ratio > stats.worst.ratio)) stats.worst = { phase: phase, ops: lastOps, cap: cap, ratio: ratio, detail: phase === 'fin' && fin ? fin.lastDetail.slice() : null };
        }
        this.step = function () {
            if (self.cancelled) return { done: true, progress: 1, label: 'cancelled' };
            if (self.phase === 0) { lastOps = setupA(); note('setup'); self.phase = 0.5; return { done: false, progress: 0.01, label: 'Preparing the synthetic well' }; }
            if (self.phase === 0.5) { lastOps = setup(); note('setup'); self.phase = 1; return { done: false, progress: 0.02, label: 'Preparing the synthetic well' }; }
            if (self.phase === 1) {
                var gd = gridsStep(); note('grid');
                if (gd) { _attachGrids(steps, plan, grids); self.phase = 2; }
                return { done: false, progress: MM.min(0.95, unitsDone / unitsTotal), label: 'Tabulating the forward model' };
            }
            if (self.phase === 2) {
                var fd = forwardStep(); note('fwd');
                if (fd) self.phase = 3;
                return { done: false, progress: MM.min(0.95, unitsDone / unitsTotal), label: 'Computing gauge pressures' };
            }
            if (self.phase === 3) {
                var dn = finishStep(); note('fin');
                if (dn) { self.phase = 4; return { done: true, progress: 1, label: 'Synthetic data ready' }; }
                return { done: false, progress: 0.96, label: 'Noise, allocation and truth' };
            }
            return { done: true, progress: 1, label: 'Synthetic data ready' };
        };
        this.result = function () { return self.res; };
        this.cancel = function () { self.cancelled = true; };
        this.stats = function () { return deepCopy(stats); };
    }

    function _gasSetup(SC) {
        var res = SC.res, g = SC.gas, pmax = MM.max(res.pi * 1.6, 2000);
        var T = gasPVT(g, pmax);
        SC.gasT = T;
        // reference μ·ct at the build-up average pressure (estimated once from the test's expected levels)
        var pr = SC._pRefEst || res.pi, ref = T.props(pr);
        res.mu = ref.mu; res.B = ref.Bg; res.ctRef = gasCt(ref.cg); res.ct = res.ctRef; res.muct = ref.mu * res.ctRef;
        res.zRef = ref.z; res.pRef = pr; res.T_R = T.T_R;
        SC.mi = T.mOf(res.pi);
    }

    // superposition at one time (all steps), the given grids; returns Σ Δq·pwD
    function _accAt(SC, steps, t, useRef) {
        var s = 0, tdc = SC.tdc;
        for (var i = 0; i < steps.length && steps[i].t < t; i++) {
            var st = steps[i], tD = tdc * (t - st.t);
            s += st.dq * (useRef ? _stepEval(st._ref, tD) : _stepEval(st, tD));
        }
        return s;
    }
    function _pOfAcc(SC, a) {
        var res = SC.res;
        if (SC.fluid === 'gas') return SC.gasT.pOfM(SC.mi - C_GAS * res.T_R / (res.k * res.h) * a);
        var c = C_P * res.B * res.mu / (res.k * res.h);
        return SC.fluid === 'water_inj' ? res.pi + c * a : res.pi - c * a;
    }
    // extras in psi at hours t (depletion, offset well, test humps)
    function _extraAt(SC, t) {
        var x = SC.extras, res = SC.res, v = 0;
        if (!x) return 0;
        if (x.dpdt) v += x.dpdt * t;
        if (x.offset && t > x.offset.t_on) {
            var dt = t - x.offset.t_on;
            v -= 70.6 * x.offset.q * res.B * res.mu / (res.k * res.h) * expE1(948.1 * res.phi * res.mu * res.ct * x.offset.r_ft * x.offset.r_ft / (res.k * dt));
        }
        if (x.hump && t > x.hump.tc) {
            var d = t - x.hump.tc;
            if (x.hump.type === 'fair') v += x.hump.A * (1 - MM.exp(-d / x.hump.tau));
            else v += x.hump.A * (d / x.hump.tau) * MM.exp(1 - d / x.hump.tau);
        }
        return v;
    }
    // The record hash is the data layer's construction exactly (§3.6 GaugeRecord.hash): hash16 of
    // "n|t0|tN|digest", digest = FNV-1a (Math.imul) over the sample spacing and round(p·1000), unpadded hex.
    // hash16 here is the generator's own copy of the frozen §3.1 algorithm (two FNV-1a passes, offset bases
    // 0x811c9dc5 and 0x050c5d1f), so a bare load and the app give the same hash.
    function _hash16(str) {
        function pass(h) { for (var i = 0; i < str.length; i++) h = MM.imul(h ^ str.charCodeAt(i), 16777619); return ('0000000' + (h >>> 0).toString(16)).slice(-8); }
        return pass(0x811c9dc5 | 0) + pass(0x050c5d1f);
    }
    function _digestStep(h, dt, pv) { h = MM.imul(h ^ dt, 16777619); return MM.imul(h ^ MM.round(pv * 1000), 16777619); }
    function _digestHash(n, t0, tN, h) { return n ? _hash16(n + '|' + t0 + '|' + tN + '|' + (h >>> 0).toString(16)) : _hash16('0||'); }
    function recordHash(t, p) {
        var n = t ? t.length : 0, h = 0x811c9dc5;
        for (var i = 0; i < n; i++) h = _digestStep(h, i ? t[i] - t[i - 1] : 0, p[i]);
        return _digestHash(n, n ? t[0] : 0, n ? t[n - 1] : 0, h);
    }

    // Finishing work in count-sliced stages: noise-free pressures, the gas pseudo-time march, the noise-free reference
    // values of each test, extras and noise, the record, the allocation, then each test's truth (TruthJob).
    function _Finisher(SC, steps, refGrids, refPlan, tms, th, acc, opts) {
        var self = this, res = SC.res, nS = th.length, isGas = SC.fluid === 'gas';
        var rN = rng(SC.seedNoise >>> 0), stage = 0, cur = 0, p = null, test = null, ptQueue = [], ptState = null, al = null, record = null, flowing = null;
        var truths = [], ti = 0, tj = null, perEval = 0, nf = [], nz = SC.noise, si = 0, ar = 0, ou = 0, tideP1 = 0, tideP2 = 0, t0h = th[0];
        var keep = null, nOut = 0, Tm = null, Pp = null, hDig = 0x811c9dc5, pmin = Infinity;
        this.result = null;
        this.lastOps = 0;
        function chunk(budget, w, n, body) {   // body(i0, i1): process [i0, i1); returns true when the whole range is done
            var cnt = MM.max(1, MM.floor(budget / w)), i1 = MM.min(n, cur + cnt), used = (i1 - cur) * w;
            body(cur, i1);
            cur = i1;
            if (cur >= n) { cur = 0; stage++; }
            return MM.max(1, used);
        }
        var STAGES = [
            function init() {
                steps.forEach(function (st) {
                    var r = { g: null, gw: null };
                    if (refPlan.mode === 'exact') { for (var j = 0; j < refPlan.values.length; j++) if (MM.abs(refPlan.values[j] - st.Sstep) < 1e-9) r.g = refGrids[j]; }
                    else {
                        var v = refPlan.values, jj = clamp(MM.floor((st.Sstep - v[0]) / 0.25) - 1, 0, v.length - 4), w = [];
                        for (var a = 0; a < 4; a++) { var L = 1; for (var b = 0; b < 4; b++) if (b !== a) L *= (st.Sstep - v[jj + b]) / (v[jj + a] - v[jj + b]); w.push([refGrids[jj + a], L]); }
                        r.gw = w;
                    }
                    st._ref = r;
                });
                p = new Float64Array(nS);
                test = SC.events.filter(function (ev) { return ev.isTest; });
                if (isGas && SC.gas.pseudoTime) ptQueue = test.slice();
                perEval = steps.length * (steps[0] && steps[0].gw ? 4 : 1);
                stage++;
                return 1 + 4 * steps.length;
            },
            function pressures(budget) {   // noise-free pressures from the superposed pwD
                return chunk(budget, isGas ? OPS.pGas : OPS.pOil, nS, function (i0, i1) { for (var i = i0; i < i1; i++) p[i] = _pOfAcc(SC, acc[i]); });
            },
            function pseudo(budget) {   // gas pseudo-time on the test build-up (Δt → Δt_a, marched with the wellbore pressure)
                if (!ptQueue.length && !ptState) { stage++; return 1; }
                var used = 0, T = SC.gasT, ref = res.muct, per = OPS.pseudoEval * perEval + OPS.pseudoSample;
                function ratio(pp) { var pr = T.props(MM.max(pp, 20)); return ref / (pr.mu * gasCt(pr.cg)); }
                while (used === 0 || used + per <= budget) {
                    if (!ptState) {
                        if (!ptQueue.length) { stage++; return MM.max(1, used); }
                        var ev = ptQueue.shift();
                        ptState = { ev: ev, k: bsearchFirstAbove(th, ev.tc), ta: 0, tPrev: ev.tc, pPrev: _pOfAcc(SC, _accAt(SC, steps, ev.tc, false)) };
                        used += perEval;
                    }
                    var stt = ptState, e2 = stt.ev;
                    if (!(stt.k < nS && th[stt.k] <= e2.tc + e2.dur + 1e-9)) { ptState = null; continue; }
                    var dt = th[stt.k] - stt.tPrev, r1 = ratio(stt.pPrev), taP = stt.ta + dt * r1;
                    var pP = _pOfAcc(SC, _accAt(SC, steps, e2.tc + taP, false));
                    stt.ta = stt.ta + dt * 0.5 * (r1 + ratio(pP));
                    var pk = _pOfAcc(SC, _accAt(SC, steps, e2.tc + stt.ta, false));
                    p[stt.k] = pk; stt.tPrev = th[stt.k]; stt.pPrev = pk; stt.k++;
                    used += per;
                }
                return used;
            },
            function noiseFree() {   // the noise-free pwf0 at t_c and the last build-up pressure of each test (gas truth, §5.3)
                test.forEach(function (ev) {
                    var ps = _preSteps(SC, ev), kEnd = bsearchFirstAbove(th, ev.tc + ev.dur + 1e-9) - 1;
                    nf.push({ pwf0: _pOfAcc(SC, _accList(SC, ps.pre, _tcOf(ev), false)), pEnd: kEnd >= 0 ? p[kEnd] : null });
                });
                stage++;
                return 1 + test.length * (steps.length + 10);
            },
            function extras(budget) {   // depletion, offset well, test humps (oil and injector strata only)
                if (!SC.extras) { stage++; return 1; }
                return chunk(budget, SC.extras.offset ? OPS.extraOffset : OPS.extra, nS, function (i0, i1) { for (var i = i0; i < i1; i++) p[i] += _extraAt(SC, th[i]); });
            },
            function flows(budget) {   // flowing flags (slugging noise while flowing)
                if (!flowing) flowing = new Uint8Array(nS);
                return chunk(budget, OPS.flow, nS, function (i0, i1) {
                    for (var i = i0; i < i1; i++) { while (si + 1 < steps.length && steps[si + 1].t < th[i]) si++; flowing[i] = (steps[si] && steps[si].t < th[i] && steps[si].q > 0) ? 1 : 0; }
                });
            },
            function noise(budget) {   // white, AR(1), low-frequency, drift, tides (one sequential stream)
                if (cur === 0) { tideP1 = rN.uniform(0, 2 * MM.PI); tideP2 = rN.uniform(0, 2 * MM.PI); }
                return chunk(budget, OPS.noise, nS, function (i0, i1) {
                    for (var i = i0; i < i1; i++) {
                        var sig = nz.sigma * (flowing[i] ? nz.sigmaFlowFactor : 1), e = rN.normal() * sig;
                        if (nz.ar1Rho) { ar = nz.ar1Rho * ar + MM.sqrt(1 - nz.ar1Rho * nz.ar1Rho) * sig * rN.normal(); e = ar; }
                        if (nz.lf) {
                            var dt2 = i ? th[i] - th[i - 1] : 0, dec = MM.exp(-dt2 / nz.lf.tau_h);
                            ou = ou * dec + nz.lf.sigma * MM.sqrt(1 - dec * dec) * rN.normal();
                            e += ou;
                        }
                        if (nz.drift) e += nz.drift * (th[i] - t0h) / 24;
                        if (nz.tideM2 || nz.tideK1) e += nz.tideM2 * MM.sin(2 * MM.PI * th[i] / 12.4206 + tideP1) + nz.tideK1 * MM.sin(2 * MM.PI * th[i] / 23.9345 + tideP2);
                        p[i] += e;
                    }
                });
            },
            function spikes() {
                if (nz.spikes > 0) {
                    var protect = SC.events.map(function (ev) { return bsearchFirstAbove(th, ev.tc); });
                    for (var sp = 0; sp < nz.spikes; sp++) {
                        var at = rN.int(5, nS - 6), ok = true;
                        for (var q2 = 0; q2 < protect.length; q2++) if (MM.abs(at - protect[q2]) <= 4) ok = false;
                        if (!ok) continue;
                        var mag = MM.max(1, 20 * nz.sigma) * rN.uniform(1, 3) * (rN.next() < 0.5 ? -1 : 1), run = rN.int(1, 2);
                        for (var r = 0; r < run; r++) p[at + r] += mag;
                    }
                }
                stage++;
                return 1 + 10 * (nz.spikes || 0);
            },
            function post(budget) {   // quantisation, 0.1 mpsi rounding, the lowest flowing pressure
                return chunk(budget, OPS.post, nS, function (i0, i1) {
                    for (var i = i0; i < i1; i++) {
                        if (nz.quant > 0) p[i] = MM.round(p[i] / nz.quant) * nz.quant;
                        p[i] = MM.round(p[i] * 1e4) / 1e4; if (p[i] < 1) p[i] = 1;
                        if (flowing[i] && p[i] < pmin) pmin = p[i];
                    }
                });
            },
            function gaps(budget) {   // data gaps (baddata)
                if (!SC.gap) { nOut = nS; stage++; return 1; }
                if (!keep) keep = [];
                var used = chunk(budget, OPS.gap, nS, function (i0, i1) { for (var i = i0; i < i1; i++) if (!(th[i] > SC.gap.t0 && th[i] < SC.gap.t1)) keep.push(i); });
                nOut = keep.length;
                return used;
            },
            function rec(budget) {   // the GaugeRecord arrays and the record hash, incrementally
                if (!Tm) { Tm = new Float64Array(nOut); Pp = new Float64Array(nOut); }
                var before = stage, used = chunk(budget, OPS.record, nOut, function (i0, i1) {
                    for (var i = i0; i < i1; i++) {
                        var src = keep ? keep[i] : i;
                        Tm[i] = SC.T0_ms + tms[src]; Pp[i] = p[src];
                        hDig = _digestStep(hDig, i ? Tm[i] - Tm[i - 1] : 0, Pp[i]);
                    }
                });
                if (stage !== before) {
                    record = { ok: true, origin_ms: Tm[0], t: Tm, p: Pp, T: null, n: nOut, source: 'demo', name: SC.name, zone: { mode: 'utc' }, pUnitIn: 'psia',
                               patm: 14.696, elapsed: false, rollup: false, hash: _digestHash(nOut, Tm[0], Tm[nOut - 1], hDig), warnings: [] };
                }
                return used;
            },
            function alloc(budget, fresh) {   // allocation / rate table (one pass)
                var days = MM.ceil((SC.tEnd_h - MM.min(0, SC.prod.dayShift_h)) / 24) + 2, est = days * steps.length * OPS.allocCell;
                if (!fresh && est > budget) return -1;
                al = _allocation(SC, rN);
                stage++;
                return MM.max(1, est);
            },
            function truthsStage(budget, fresh) {   // one TruthJob per test
                if (ti >= test.length) { stage++; return 1; }
                if (!tj) tj = new TruthJob(SC, steps, test[ti], al, nf[ti]);
                var used = tj.step(budget, fresh);
                if (used < 0) return -1;
                if (tj.done) { truths.push(tj.result); tj = null; ti++; }
                return MM.max(1, used);
            },
            function assemble() {
                var well = _wellInput(SC, pmin);
                self.result = {
                    record: record, allocation: { rows: al.rows }, rateTable: al.table, well: well, truths: truths,
                    history: SC.history, zones: SC.zones, completion: SC.completion || null, workovers: SC.workovers || [],
                    info: { nSamples: record.n, nSteps: steps.length, fwdOps: SC._fwdOps, base_s: SC.sampling.base_eff, dense_s: SC.sampling.dense_eff,
                            gridModel: res.model, Cd: SC.Cd, tdc: SC.tdc, Sgeo: SC.Sgeo || 0, gasRef: isGas ? { p: res.pRef, mu: res.mu, z: res.zRef, ct: res.ctRef, Bg: res.B } : null }
                };
                stage++;
                return 1;
            }
        ];
        this.step = function () {
            var used = 0, detail = [];
            while (stage < STAGES.length && used < UNIT_FIN) {
                var name = STAGES[stage].name, r = STAGES[stage](UNIT_FIN - used, used === 0);
                if (r < 0) break;   // an indivisible item waits for a fresh unit
                used += r; detail.push(name + ' ' + r);
            }
            self.lastOps = used; self.lastDetail = detail;
            return stage >= STAGES.length;
        };
    }

    // One test's truth in count-sliced phases: the head (rates, f, k*, S*), the noise-free build-up curve and its
    // homogeneous reference (points per step), then the plateaus, visibility and reach, then the grade prediction.
    function TruthJob(SC, steps, ev, al, nf) {
        var self = this, phase = 0, head = null, cv = null, rcv = null, tail = null;
        var shareRef = SC.res.model === 'homogeneous' && !SC.extras;   // the reference curve is the curve itself
        this.done = false; this.result = null;
        this.step = function (budget, fresh) {
            var used = 0, est;
            while (!self.done && (used < budget || used === 0)) {
                if (phase === 0) { head = _truthHead(SC, steps, ev, al, nf); cv = _curveJob(SC, steps, ev, false, _icPre(SC, ev, al, head)); phase = 1; used += 20; continue; }
                if (phase === 1) {
                    used += cv.step(MM.max(1, budget - used));
                    if (cv.done()) { rcv = shareRef ? cv : _curveJob(SC, steps, ev, true); phase = 2; }
                    if (used >= budget) break;
                    continue;
                }
                if (phase === 2) {
                    if (rcv !== cv) used += rcv.step(MM.max(1, budget - used));
                    if (rcv.done()) phase = 3;
                    if (used >= budget) break;
                    continue;
                }
                if (phase === 3) {
                    est = cv.out.X.length * OPS.plateauPoint + (_reachCached(SC, head.Stest) ? 1 : _reachPoints(SC, head.Stest) * OPS.reachPoint);
                    if ((used > 0 || !fresh) && used + est > budget) break;
                    tail = _truthTail1(SC, ev, head, cv.out, rcv.out);
                    used += est; phase = 4;
                    continue;
                }
                est = _gradeOps(cv.out) * OPS.gradeOp;
                if ((used > 0 || !fresh) && used + est > budget) break;
                self.result = _truthTail2(SC, ev, head, cv.out, tail);
                used += est; self.done = true;
            }
            if (used === 0 && !fresh && !self.done) return -1;
            return used;
        };
    }

    // ── allocation (own day code) ──
    function _allocation(SC, rN) {
        var al = SC.alloc, pr = SC.prod, rows = [], days = [];
        var tEnd = SC.tEnd_h, d0 = MM.floor((0 - pr.dayShift_h) / 24), d1 = MM.floor((tEnd - 1e-9 - pr.dayShift_h) / 24);
        var steps = SC.steps;
        for (var d = d0; d <= d1; d++) {
            var a = MM.max(0, pr.dayShift_h + 24 * d), b = MM.min(tEnd, pr.dayShift_h + 24 * (d + 1));
            var V = 0, hOn = 0;
            for (var i = 0; i < steps.length; i++) {
                var s0 = steps[i].t, s1 = (i + 1 < steps.length) ? steps[i + 1].t : tEnd, q = steps[i].q;
                var o0 = MM.max(a, s0), o1 = MM.min(b, s1);
                if (o1 > o0 && q > 0) { V += q * (o1 - o0) / 24; hOn += o1 - o0; }
            }
            days.push({ d: d, t0: pr.dayShift_h + 24 * d, a: a, b: b, V: V, hOn: hOn, date: dateOf(SC.T0_ms + (pr.dayShift_h + 24 * d) * HOUR_MS) });
        }
        var testEv = SC.events.filter(function (ev) { return ev.isTest; });
        function dayOf(t) { for (var k = 0; k < days.length; k++) if (t >= days[k].t0 && t < days[k].t0 + 24) return k; return -1; }
        var closeDays = testEv.map(function (ev) { return dayOf(ev.tc); });
        var bias = 1 + (al.bias || 0);
        days.forEach(function (dy, k) {
            var err = MM.exp(rN.normal() * al.errPct / 100 - 0.5 * MM.pow(al.errPct / 100, 2));
            var Vg = dy.V * bias * err, hrs = dy.hOn;
            var isClose = closeDays.indexOf(k) !== -1;
            if (isClose && al.ignoresShutin && k > 0) {
                var qPrev = days[k - 1].hOn > 0 ? 24 * days[k - 1].V / days[k - 1].hOn : 0;
                Vg = qPrev * (dy.b - dy.a) / 24 * bias * err;
                hrs = dy.b - dy.a;
            }
            if (isClose && al.hoursConflict_h > 0) hrs = MM.max(0, hrs + (rN.next() < 0.5 ? -1 : 1) * al.hoursConflict_h);
            Vg = MM.max(0, roundTo(Vg, al.resolution));
            dy.Vg = Vg;
            var row = { date: dy.date, oil: null, gas: null, water: null, hours: MM.round(MM.min(24, MM.max(0, hrs)) * 100) / 100 };
            if (SC.fluid === 'oil') {
                row.oil = Vg;
                row.gas = MM.max(0, MM.round(Vg * (SC.Rs || 400) / 1000 * (1 + 0.02 * rN.normal()) * 10) / 10);
                row.water = MM.max(0, roundTo(Vg * SC.wc / (1 - SC.wc), al.resolution));
            } else if (SC.fluid === 'gas') {
                row.gas = Vg; row.oil = 0; row.water = MM.max(0, MM.round(Vg * 0.001 * 10) / 10);
            } else {
                row.water = Vg;
            }
            rows.push(row);
        });
        var table = null;
        if (SC.rateSource === 'table') {
            table = steps.filter(function (st) { return st.t >= 0; }).map(function (st) {
                return { t_ms: SC.T0_ms + MM.round(st.t * HOUR_MS), q: st.q > 0 ? MM.round(st.q * (1 + 0.01 * rN.normal()) * 10) / 10 : 0 };
            });
            if (!table.length || table[0].t_ms > SC.T0_ms) table.unshift({ t_ms: SC.T0_ms, q: MM.round(_qAt(SC, 0.001) * 10) / 10 });
            rows = [];
        }
        return { rows: rows, days: days, table: table };
    }

    // ── truth for one test event (§5.3) ──
    // Closing-time convention (§4.3 M§A3): with a closing ramp the closing time t_c is the ramp midpoint, Δt is measured
    // from it, and Δp is referenced to the flowing pressure extrapolated to it with the pre-ramp rate (pwf0 = trend(t_c));
    // the ramp itself acts like two half-rate steps. Without a ramp t_c is the closing.
    function _tcOf(ev) { return ev.tc - 0.5 * (ev.ramp_s || 0) / 3600; }
    // head: rates, f, k*, S* (the input-consistent truth of §5.3)
    function _truthHead(SC, steps, ev, al, nf) {
        var res = SC.res, tc = ev.tc, rampH = (ev.ramp_s || 0) / 3600, tm = _tcOf(ev);
        var qTrue = qBeforeAt(SC, tc - rampH);   // the rate before the closing ramp (after any partial cut)
        var qCorrect = qTrue, dqSource = 'closingDay';
        if (ev.kind === 'partial') { qCorrect = qTrue; dqSource = 'partial'; }
        else if (al.table) {
            var tq = null; for (var a = 0; a < al.table.length; a++) if ((al.table[a].t_ms - SC.T0_ms) / HOUR_MS < tc - rampH - 1e-6) tq = al.table[a].q;
            qCorrect = tq; dqSource = 'table';
        } else {
            var days = al.days, k = -1;
            for (var j = 0; j < days.length; j++) if (tc >= days[j].t0 && tc < days[j].t0 + 24) k = j;
            var dy = days[k];
            // A partial cut before the closing: the post-cut rate (§5.3). That is the generator's pb factor, or an intra-day
            // rate decrease of at least 10 %: the engine's classification gate (§4.3 M§A4) makes a removed fraction f̂ ≥ 0.1
            // a partial cut, so a correct reading of the pressure and the volumes gives the rate after it. A smaller
            // decrease or an increase makes no event, and the day's volume over its flowing hours stays the reading.
            var pb = ev.pb || ((ev.intra && 1 - ev.intra.factor >= 0.1) ? { f: 1 - ev.intra.factor, lead: ev.intra.lead } : null);
            var cut = pb ? (1 - pb.f) : 1;
            if (SC.alloc.ignoresShutin && k > 0) {
                var ref = [];
                for (var m = k - 1; m >= 0 && ref.length < 3; m--) if (days[m].hOn >= 23.5) ref.push(24 * days[m].Vg / days[m].hOn);
                qCorrect = median(ref) * cut; dqSource = 'qref';
            } else if (dy && dy.hOn < 6 && k > 0 && days[k - 1].hOn > 0) {
                qCorrect = 24 * days[k - 1].Vg / days[k - 1].hOn * cut; dqSource = 'previousDay';
            } else if (dy && dy.hOn > 0) {
                // a closing ramp counts as half its length (two half-rate steps, t_c at its midpoint, §4.3): the true
                // flowing hours up to t_c are hOn − ramp/2, so 24·V/h reads the pre-ramp rate exactly
                var rIn = MM.max(0, MM.min(rampH, tc - dy.a)), base = 24 * dy.Vg / MM.max(1e-6, dy.hOn - 0.5 * rIn);
                if (pb) {
                    var h2 = MM.max(0, tc - MM.max(dy.a, tc - pb.lead)), h1 = MM.max(0, dy.hOn - h2), f0 = pb.f;
                    base = (1 - f0) * 24 * dy.Vg / (h1 + (1 - f0) * MM.max(1e-6, h2 - 0.5 * rIn));
                }
                qCorrect = base;
            }
        }
        if (!(qCorrect > 0)) qCorrect = qTrue;
        var f = qCorrect / qTrue, g = SC.given;
        var Stest = SC.SmechAt(tc - 1e-6) + (res.D || 0) * qTrue;
        // f is the closing-day factor only; the engine superposes the given rate on every day, so the input-consistent k lies
        // between k and f·k and this truth overstates the expected k error by up to |f − 1| (plan §5.3 calibration note).
        var kStar = f * res.k * (g.B / res.B0) * (g.mu / res.mu0) * (res.h / g.h);
        var inTerm = 1.1513 * MM.log10((g.h / res.h) * (g.phi / res.phi) * (g.ct / res.ct)) + 2.3026 * MM.log10(g.rw / res.rw) - 1.1513 * MM.log10((g.B / res.B0) * f);
        // Gas (§4.6 item 1, "μ·ct at the build-up average pressure"): the engine takes μ from its own table at
        // 0.5·(pwf0 + p_end), not the given μ, and S in pseudo-pressure depends on the μ in t_D. The truth therefore
        // evaluates μ with the generator's table at the realised noise-free mean of pwf0 (at t_c) and the last build-up
        // pressure: S* += 1.1513·log10(μ(p̄)/μ′). k* is unaffected (k from the normalised pseudo-pressure does not depend
        // on the reference). Residual: the engine's own z/μ correlations may differ from the generator's slightly.
        var gasMu = null;
        if (SC.fluid === 'gas' && nf && nf.pwf0 > 0 && nf.pEnd > 0) {
            var pBar = 0.5 * (nf.pwf0 + nf.pEnd), muBar = SC.gasT.props(pBar).mu;
            gasMu = { pBar: pBar, mu: muBar, term: 1.1513 * MM.log10(muBar / g.mu) };
            inTerm += gasMu.term;
        }
        return { tc: tc, tm: tm, rampH: rampH, qTrue: qTrue, qCorrect: qCorrect, dqSource: dqSource, f: f, Stest: Stest, kStar: kStar, inTerm: inTerm,
                 SStar: Stest + inTerm, gasMu: gasMu };
    }
    // tail 1: plateaus (first-plateau truth), visibility, reach
    function _truthTail1(SC, ev, hd, curve, refCurve) {
        return { plateaus: _plateaus(curve, SC.res, hd.inTerm, hd.kStar / SC.res.k), visible: _visibility(SC, curve, refCurve), reach: _reach(SC, hd.Stest, ev) };
    }
    // tail 2: the grade prediction and the truth object
    function _truthTail2(SC, ev, hd, curve, t1) {
        var res = SC.res, grade = _predictGrade(curve), plateaus = t1.plateaus;
        var distractor = DISTRACTORS.indexOf(SC.stratum) !== -1 || (SC.stratum === 'inj' && res.model === 'frac');
        var refPl = null;
        for (var r = 0; r < plateaus.length; r++) if (MM.log10(plateaus[r]._dte1 / plateaus[r]._dte0) >= 0.5) { refPl = plateaus[r]; break; }
        var kS = hd.kStar, SS = hd.SStar;
        if (distractor && refPl) { kS = refPl.kStar; SS = refPl.SStar; }
        var dteEnd = curve.dte[curve.dte.length - 1];
        return {
            tc_ms: SC.T0_ms + MM.round(hd.tm * HOUR_MS), tc_h: hd.tm, label: ev.label || null, kind: ev.kind, ramp_s: ev.ramp_s || 0, gasMu: hd.gasMu,
            k: res.k, S: hd.Stest, Smech: SC.SmechAt(hd.tc - 1e-6), model: SC.truthModel || res.model, f: hd.f, qTrue: hd.qTrue, qCorrect: hd.qCorrect, dqSource: hd.dqSource,
            kStar: kS, SStar: SS, kStarInputs: hd.kStar, SStarInputs: hd.SStar,
            plateaus: plateaus.map(function (pl) { return { dt0_h: pl.dt0_h, dt1_h: pl.dt1_h, kStar: pl.kStar, SStar: pl.SStar }; }),
            visible: t1.visible, notAnalysable: !!SC.notAnalysable && ev.isTest, partial: ev.kind === 'partial',
            dtEnd_h: ev.dur + 0.5 * hd.rampH, dteEnd_h: dteEnd, reach: t1.reach,
            grade: grade.grade, gradeInfo: grade, distractor: distractor
        };
    }
    // the truth of one test event (synchronous; generateJob uses TruthJob)
    function _truthFor(SC, steps, ev, al, nf) {
        var tj = new TruthJob(SC, steps, ev, al, nf);
        while (!tj.done) tj.step(1e15, true);
        return tj.result;
    }
    // Δp_D(Δt) per unit last rate, Δt_e, exact-ish derivative (central differences in ln Δt_e)
    // Steps before the closing that define Δt_e: the steps before a closing ramp (≤ 5 min). The ramp's own steps are
    // not in Δt_e: the build-up is normalised by the rate before the ramp (the generator's q_true), Δt runs from the ramp
    // midpoint t_c (_tcOf) and Δp from the flowing pressure extrapolated to t_c with the pre-ramp steps (§4.3).
    function _preSteps(SC, ev) {
        var rampH = (ev.ramp_s || 0) / 3600, tcut = ev.tc - rampH - 1e-9, pre = [], i, qN = 0;
        for (i = 0; i < SC.steps.length && SC.steps[i].t < tcut; i++) { pre.push(SC.steps[i]); qN = SC.steps[i].q; }
        return { pre: pre, qN: qN };
    }
    // The rate history a correct reading of the GIVEN data yields before the closing (input-consistent, §5.3), the abscissa of
    // the grade prediction: the engine differentiates the build-up against the superposition time of the rates it reads, and
    // the given rates differ from the smooth true ones by the allocation noise (the oil demo's 3 % day-to-day variation lives
    // in the allocation only). The true steps before the closing (split at production-day boundaries), each scaled by its
    // day's given / true volume; the closing day's by f = q_correct/q_true (the head's reading, so the last rate is
    // q_correct); with a rate table, each step by its tabled rate. Steps before the record (truncated history) and the
    // closing days of other tests whose allocation ignores the shut-in (a correct reading takes the reference rate) are kept.
    // → {steps: [{t, q}], qN}
    function _icPre(SC, ev, al, hd) {
        var ps = _preSteps(SC, ev), pre = ps.pre, tc = _tcOf(ev), out = [], i, k;
        if (!pre.length || !(hd && hd.qCorrect > 0)) return null;
        var days = (al && al.days) || [], tbl = al && al.table;
        function dayOf(t) { for (var j = 0; j < days.length; j++) if (t >= days[j].t0 && t < days[j].t0 + 24) return j; return -1; }
        var kc = dayOf(ev.tc), ign = {};
        if (SC.alloc && SC.alloc.ignoresShutin) SC.events.forEach(function (e2) { if (e2.isTest && e2 !== ev) { var d2 = dayOf(e2.tc); if (d2 > 0) ign[d2] = 1; } });
        var cuts = [];
        for (i = 0; i < pre.length; i++) {
            var t0 = pre[i].t, t1 = i + 1 < pre.length ? pre[i + 1].t : tc;
            cuts.push({ t: t0, q: pre[i].q });
            if (!tbl) for (k = 0; k < days.length; k++) if (days[k].t0 > t0 && days[k].t0 < t1) cuts.push({ t: days[k].t0, q: pre[i].q });
        }
        cuts.sort(function (a, b) { return a.t - b.t; });
        cuts.forEach(function (c) {
            var r = 1;
            if (tbl) {
                if (c.t >= 0 && c.q > 0) {
                    var tm = SC.T0_ms + MM.round(c.t * HOUR_MS);
                    for (var j = 0; j < tbl.length; j++) if (tbl[j].t_ms === tm) { r = tbl[j].q / c.q; break; }
                }
            } else {
                var d = dayOf(c.t);
                if (d === kc && d >= 0) r = hd.f;
                else if (d >= 0 && !ign[d] && days[d].V > 0 && days[d].Vg > 0) r = days[d].Vg / days[d].V;
            }
            out.push({ t: c.t, q: c.q * r });
        });
        out[out.length - 1].q = hd.qCorrect;
        return { steps: out, qN: hd.qCorrect };
    }
    // Σ Δq·pwD over a list of steps (all before t)
    function _accList(SC, list, t, useRef) {
        var s = 0, tdc = SC.tdc;
        for (var i = 0; i < list.length; i++) { var st = list[i]; if (st.t < t) s += st.dq * (useRef ? _stepEval(st._ref, tdc * (t - st.t)) : _stepEval(st, tdc * (t - st.t))); }
        return s;
    }
    // The noise-free build-up curve as a count-sliced job: step(budget) evaluates points until `budget` ops are used
    // (at least one point; one point ≈ 3 superpositions over the steps, OPS.curvePoint per step evaluation).
    // icPre (optional): the input-consistent rate history (_icPre); the curve then also carries Xg / dg, the derivative of the
    // same noise-free Δp against the superposition time of that history (the abscissa of the grade prediction).
    function _curveJob(SC, steps, ev, useRef, icPre) {
        var tc = _tcOf(ev), dur = ev.dur + (ev.tc - tc), res = SC.res, ps = _preSteps(SC, ev), qN = ps.qN, pre = ps.pre;
        var cP = (SC.fluid === 'gas') ? 1 : C_P * res.B * res.mu / (res.k * res.h);
        var a0 = _accList(SC, pre, tc, useRef);   // the flowing level at t_c with the pre-ramp rate (= the acc at t_c without a ramp)
        function lnDte(dt) {
            var v = MM.log(dt);
            for (var j = 0; j < pre.length; j++) { var w = pre[j].dq / qN; v += w * (MM.log(tc - pre[j].t) - MM.log(tc + dt - pre[j].t)); }
            return v;
        }
        function lnDteG(dt) {
            var v = MM.log(dt), L = icPre.steps, qG = icPre.qN, qp = 0;
            for (var j = 0; j < L.length; j++) { var w = (L[j].q - qp) / qG; qp = L[j].q; v += w * (MM.log(tc - L[j].t) - MM.log(tc + dt - L[j].t)); }
            return v;
        }
        function dpD(dt) {
            var v = (a0 - _accAt(SC, steps, tc + dt, useRef)) / qN;
            if (!useRef && SC.extras && SC.fluid !== 'gas') {
                var sgn = SC.fluid === 'water_inj' ? -1 : 1;
                v += sgn * (_extraAt(SC, tc + dt) - _extraAt(SC, tc)) / (cP * qN);
            }
            return v;
        }
        var dt0 = MM.max(2e-3, 1 / 3600), n = MM.max(8, MM.ceil(20 * MM.log10(dur / dt0))), h = 0.01, k = 0;
        var withG = !!(icPre && icPre.steps && icPre.steps.length && icPre.qN > 0);
        var wNode = (steps[0] && (useRef ? (steps[0]._ref && steps[0]._ref.gw) : steps[0].gw)) ? 4 : 1, perPoint = OPS.curvePoint * steps.length * wNode + 3 * pre.length + (withG ? 3 * icPre.steps.length : 0);
        var out = { dt: [], dte: [], X: [], dp: [], d: [] };
        if (withG) { out.Xg = []; out.dg = []; }
        return {
            out: out,
            done: function () { return k > n; },
            step: function (budget) {
                var used = 0;
                while (k <= n && (used === 0 || used + perPoint <= budget)) {
                    var dt = dt0 * MM.pow(dur / dt0, k / n);
                    var lp = lnDte(dt * MM.exp(h)), lm = lnDte(dt * MM.exp(-h));
                    var dpP = dpD(dt * MM.exp(h)), dpM = dpD(dt * MM.exp(-h));
                    var dd = (dpP - dpM) / (lp - lm);
                    var le = lnDte(dt);
                    out.dt.push(dt); out.dte.push(MM.exp(le)); out.X.push(le / LN10); out.dp.push(dpD(dt)); out.d.push(dd);
                    if (withG) { out.Xg.push(lnDteG(dt) / LN10); out.dg.push((dpP - dpM) / (lnDteG(dt * MM.exp(h)) - lnDteG(dt * MM.exp(-h)))); }
                    k++; used += perPoint;
                }
                return used;
            }
        };
    }
    function _buildupCurve(SC, steps, ev, useRef) {
        var cj = _curveJob(SC, steps, ev, useRef);
        while (!cj.done()) cj.step(1e15);
        return cj.out;
    }
    // first-plateau truth: k* from the level, S* = pD − ½(ln tD + 0.80907) at the plateau middle (apparent k)
    function _plateaus(cv, res, inTerm, fk) {
        var n = cv.X.length, sl = [], i;
        var hump = 0; for (i = 1; i < n; i++) if (cv.d[i] > cv.d[hump]) hump = i;
        for (i = 0; i < n; i++) {
            var a = MM.max(0, i - 1), b = MM.min(n - 1, i + 1);
            sl.push((cv.d[a] > 0 && cv.d[b] > 0) ? (MM.log10(cv.d[b]) - MM.log10(cv.d[a])) / (cv.X[b] - cv.X[a]) : Infinity);
        }
        var runs = [], cur = null;
        for (i = hump; i < n; i++) {
            if (MM.abs(sl[i]) <= 0.05 && cv.d[i] > 0) { if (!cur) cur = { i0: i, i1: i }; else cur.i1 = i; }
            else if (cur) { runs.push(cur); cur = null; }
        }
        if (cur) runs.push(cur);
        runs.forEach(function (r) { r.level = median(cv.d.slice(r.i0, r.i1 + 1)); });
        var merged = [];
        runs.forEach(function (r) {
            var last = merged[merged.length - 1];
            if (last && MM.abs(r.level / last.level - 1) <= 0.05 && cv.X[r.i0] - cv.X[last.i1] < 0.2) { last.i1 = r.i1; last.level = median(cv.d.slice(last.i0, last.i1 + 1)); }
            else merged.push({ i0: r.i0, i1: r.i1, level: r.level });
        });
        var out = [];
        merged.forEach(function (r) {
            if (cv.X[r.i1] - cv.X[r.i0] < 0.2) return;
            var ratio = 0.5 / r.level;                 // k_app / k
            var mid = MM.round(0.5 * (r.i0 + r.i1));
            var tdc = C_TD * res.k / (res.phi * (res.muct || res.mu * res.ct) * res.rw * res.rw);
            var pDapp = cv.dp[mid] * ratio, tDapp = tdc * cv.dte[mid] * ratio;
            var Sapp = pDapp - 0.5 * (MM.log(tDapp) + IARF_C);
            out.push({ dt0_h: cv.dt[r.i0], dt1_h: cv.dt[r.i1], _dte0: cv.dte[r.i0], _dte1: cv.dte[r.i1],
                       kStar: fk * res.k * ratio, SStar: Sapp + inTerm });
        });
        return out;
    }
    function _visibility(SC, cv, ref) {
        var n = cv.d.length, st = SC.stratum, model = SC.res.model;
        var endDep = MM.abs(cv.d[n - 1] / ref.d[n - 1] - 1);
        var hump = 0; for (var i = 1; i < n; i++) if (ref.d[i] > ref.d[hump]) hump = i;
        var maxDep = 0; for (i = hump; i < n; i++) if (ref.d[i] > 0) maxDep = MM.max(maxDep, MM.abs(cv.d[i] / ref.d[i] - 1));
        var vis = { fault: false, comp: false, closed: false, distractor: false };
        if (model === 'fault') vis.fault = endDep >= 0.10;
        if (model === 'composite') vis.comp = endDep >= 0.10;
        if (model === 'closed') vis.closed = endDep >= 0.10;
        if (DISTRACTORS.indexOf(st) !== -1 || (st === 'inj' && model === 'frac')) vis.distractor = maxDep >= 0.10;
        vis._endDep = endDep; vis._maxDep = maxDep;
        return vis;
    }
    // own numeric reach (homogeneous, Cd and the test's skin): last tD outside ±10 % / ±5 % of 0.5
    var _reachCache = {};
    function _reachKey(SC, S) { return SC.Cd.toPrecision(8) + '|' + S.toPrecision(8); }
    function _reachRange(SC, S) { var lo = MM.max(1, SC.Cd * 0.1), hi = MM.max(1e6, SC.Cd * 1e5 * MM.exp(2 * MM.max(0, S))); return { lo: lo, hi: hi, n: MM.ceil(MM.log10(hi / lo) * 60) }; }
    function _reachCached(SC, S) { return !!_reachCache[_reachKey(SC, S)]; }
    function _reachPoints(SC, S) { return _reachRange(SC, S).n + 1; }
    // static op count of the grade prediction (windows × fit lengths over the 20-per-cycle bins)
    function _gradeOps(cv) { var nb = MM.max(0, MM.floor((cv.X[cv.X.length - 1] - 0.1 - cv.X[0]) * 20) + 1); return 100 + nb * nb * nb / 3; }
    function _reach(SC, S, ev) {
        var key = _reachKey(SC, S);
        var tD10 = null, tD5 = null;
        if (_reachCache[key]) { tD10 = _reachCache[key][0]; tD5 = _reachCache[key][1]; }
        else {
            var rr = _reachRange(SC, S), lo = rr.lo, hi = rr.hi;
            var n = rr.n, xs = [], ds = [];
            var P = (S < 0) ? { e: MM.exp(S) } : null;
            for (var i = 0; i <= n; i++) {
                var tD = lo * MM.pow(hi / lo, i / n);
                var r = (S < 0) ? _invert('homogeneous', {}, SC.Cd * P.e * P.e, 0, tD * P.e * P.e) : _invert('homogeneous', {}, SC.Cd, S, tD);
                xs.push(tD); ds.push(r[1]);
            }
            for (i = n; i >= 0; i--) {
                var dev = MM.abs(ds[i] / 0.5 - 1);
                if (tD5 === null && dev > 0.05) tD5 = xs[i];
                if (tD10 === null && dev > 0.10) tD10 = xs[i];
                if (tD5 !== null && tD10 !== null) break;
            }
            _reachCache[key] = [tD10, tD5];
        }
        var t10 = (tD10 || 0) / SC.tdc, t5 = (tD5 || 0) / SC.tdc;
        var fair = MM.pow(10, 0.6) * t5, good = MM.pow(10, 1.1) * t5;
        var tp = _effTp(SC, ev);
        return { t10_h: t10, t5_h: t5, fair_h: fair, good_h: good, fairShut_h: fair < tp ? fair * tp / (tp - fair) : null, goodShut_h: good < tp ? good * tp / (tp - good) : null, tp_h: tp };
    }
    function _effTp(SC, ev) {   // single-rate equivalent tp from Δt_e at the end: tp = Δt·Δt_e/(Δt − Δt_e)
        var c = _buildupCurveTp(SC, ev);
        return c;
    }
    function _buildupCurveTp(SC, ev) {
        var tc = _tcOf(ev), ps = _preSteps(SC, ev), qN = ps.qN, dt = MM.max(1, ev.dur + (ev.tc - tc)), v = MM.log(dt);
        ps.pre.forEach(function (st) { v += st.dq / qN * (MM.log(tc - st.t) - MM.log(tc + dt - st.t)); });
        var dte = MM.exp(v);
        return dte < dt ? dt * dte / (dt - dte) : 1e9;
    }
    // IARF grade on the noise-free derivative, by the engine's definition (§4.6 item 3 as built in WP1, at the fixed
    // tolerances of a noise-free derivative; the generator's own code, no engine call):
    //   - abscissa: ln Δt_e of the input-consistent rate history (_icPre: what a correct reading of the given data yields),
    //     so the derivative is the one the engine sees on noise-free data; bins at 20 per log cycle, ending one Bourdet
    //     distance (0.1 cycle) before Δt_e,end (full-window bins only);
    //   - gate: the derivative maximum confirmed by a 10 % decline (the storage hump), the scan starting at the next bin;
    //     without one, at the first bin whose local log-log slope falls below 0.25;
    //   - windows of ≥ 0.5 cycle and ≥ 3 bins: band ±10 % around the window MEDIAN, OLS slope of Δp′/ℓ per ln Δt_e within
    //     ±0.03, the level-drift guard (mean of the first and of the last 0.1 cycle within ±5 % of each other, and the last
    //     no more than 5 % above the lowest 3-bin running mean) and the valley guard (the centre bin not a local minimum
    //     ≥ 15 % below the highest bin within 0.5 cycle on each side);
    //   - overlapping windows form plateau runs; runs with levels within 5 % and less than 0.2 cycle apart merge; the
    //     window is the longest in the EARLIEST run (ties: the smaller rms);
    //   - good: that window spans ≥ 1 cycle and the OLS slope over its last 0.5 cycle (divided by the median there) is
    //     within ±0.01; fair: ≥ 0.5 cycle; none: no window.
    // margin: the normalised distance of the predicted grade from the nearest other grade (≥ 0; small = near a threshold):
    // good → the chosen window's min((span − 1)/1, (0.01 − |s_last|)/0.01, band and slope slack); fair → min(the best fair
    // slack of the qualifying windows, the chosen window's distance to good); none → the best slack of the rejected windows,
    // negated.
    function _predictGrade(cv) {
        var srcX = cv.Xg || cv.X, srcD = cv.dg || cv.d, i;
        var X = [], D = [];
        var Xend = srcX[srcX.length - 1], x0 = srcX[0], nb = MM.floor((Xend - 0.1 - x0) * 20);
        for (i = 0; i <= nb; i++) {
            var x = x0 + i / 20, j = 1;
            while (j < srcX.length - 1 && srcX[j] < x) j++;
            var uu = (x - srcX[j - 1]) / (srcX[j] - srcX[j - 1]);
            X.push(x); D.push(srcD[j - 1] + uu * (srcD[j] - srcD[j - 1]));
        }
        var n = X.length;
        if (n < 10) return { grade: 'none', span: 0, margin: null, toFair: null };
        // gate (the engine's hump index: the running maximum confirmed by a 10 % decline)
        var iMax = -1, hump = -1;
        for (i = 0; i < n; i++) {
            if (!(D[i] > 0)) continue;
            if (iMax < 0 || D[i] > D[iMax]) { iMax = i; continue; }
            if (D[i] < 0.9 * D[iMax]) { hump = iMax; break; }
        }
        var a0 = n;
        if (hump >= 0) a0 = hump + 1;
        else for (i = 1; i < n - 1; i++) { if (D[i] > 0 && D[i + 1] > 0 && (MM.log(D[i + 1]) - MM.log(D[i])) / ((X[i + 1] - X[i]) * LN10) < 0.25) { a0 = i; break; } }
        var m = n - a0;
        if (m < 3) return { grade: 'none', span: 0, margin: null, toFair: null, a0: a0 };
        var u = [], y = [];
        for (i = a0; i < n; i++) { u.push(X[i] * LN10); y.push(D[i]); }
        var Su = [0], Suu = [0], Sy = [0], Suy = [0], Syy = [0];
        for (i = 0; i < m; i++) { Su.push(Su[i] + u[i]); Suu.push(Suu[i] + u[i] * u[i]); Sy.push(Sy[i] + y[i]); Suy.push(Suy[i] + u[i] * y[i]); Syy.push(Syy[i] + y[i] * y[i]); }
        var HC = 0.1 * LN10, fwd = [], bwd = [], rm = [];
        for (i = 0; i < m; i++) {
            var fe = i; while (fe + 1 < m && u[fe + 1] - u[i] <= HC + 1e-12) fe++; fwd.push(fe);
            var bs = i; while (bs - 1 >= 0 && u[i] - u[bs - 1] <= HC + 1e-12) bs--; bwd.push(bs);
            var lo = MM.max(0, i - 1), hi = MM.min(m - 1, i + 1), sm = 0; for (var q = lo; q <= hi; q++) sm += y[q]; rm.push(sm / (hi - lo + 1));
        }
        function valleyAt(c) {   // c in scan indices; neighbours over every bin (the engine's valley guard)
            var ii = a0 + c, maxL = -Infinity, maxR = -Infinity, k;
            for (k = ii - 1; k >= 0 && (X[ii] - X[k]) <= 0.5 + 1e-12; k--) if (D[k] > maxL) maxL = D[k];
            for (k = ii + 1; k < n && (X[k] - X[ii]) <= 0.5 + 1e-12; k++) if (D[k] > maxR) maxR = D[k];
            var locMin = (c === 0 || y[c] <= y[c - 1]) && (c === m - 1 || y[c] <= y[c + 1]);
            return locMin && D[ii] <= 0.85 * maxL && D[ii] <= 0.85 * maxR;
        }
        function olsSlope(a, b, lvl) { var nn = b - a + 1, su = Su[b + 1] - Su[a], mu = su / nn, Sxx = (Suu[b + 1] - Suu[a]) - nn * mu * mu; return Sxx > 0 ? ((Suy[b + 1] - Suy[a]) - mu * (Sy[b + 1] - Sy[a])) / Sxx / lvl : 0; }
        function slack(w) { return MM.min((w.span - 0.5) / 0.5, (0.10 - w.band) / 0.10, (0.03 - MM.abs(w.slope)) / 0.03); }
        function ins(arr, v) { var l2 = 0, h2 = arr.length; while (l2 < h2) { var md = (l2 + h2) >> 1; if (arr[md] < v) l2 = md + 1; else h2 = md; } arr.splice(l2, 0, v); }
        var wins = [], bestNear = -Infinity;
        for (var a = 0; a < m; a++) {
            var sorted = [y[a]], mn = y[a], mx = y[a], rmMin = rm[a];
            for (var b = a + 1; b < m; b++) {
                ins(sorted, y[b]); if (y[b] < mn) mn = y[b]; if (y[b] > mx) mx = y[b]; if (rm[b] < rmMin) rmMin = rm[b];
                if (b < a + 2) continue;
                var span = (u[b] - u[a]) / LN10;
                if (span < 0.5 - 1e-9) continue;
                var nn = b - a + 1, hm = nn >> 1, lvl = (nn % 2) ? sorted[hm] : 0.5 * (sorted[hm - 1] + sorted[hm]);
                if (!(lvl > 0) || !(mn > 0)) continue;
                var band = MM.max(mx / lvl - 1, 1 - mn / lvl), sl = olsSlope(a, b, lvl), w0 = { a: a, b: b, span: span, band: band, slope: sl, level: lvl };
                if (band > 0.10 || MM.abs(sl) > 0.03) { bestNear = MM.max(bestNear, slack(w0)); continue; }
                var hEnd = MM.min(fwd[a], b), tSt = MM.max(bwd[b], a);
                var headL = (Sy[hEnd + 1] - Sy[a]) / (hEnd - a + 1), tailL = (Sy[b + 1] - Sy[tSt]) / (b - tSt + 1);
                if (MM.abs(tailL / headL - 1) > 0.05 || tailL / rmMin - 1 > 0.05) continue;
                var cX = 0.5 * (u[a] + u[b]), c = a;
                while (c + 1 <= b && MM.abs(u[c + 1] - cX) < MM.abs(u[c] - cX)) c++;
                if (valleyAt(c)) continue;
                var ssq = (Syy[b + 1] - Syy[a] - 2 * lvl * (Sy[b + 1] - Sy[a]) + nn * lvl * lvl) / (lvl * lvl);
                w0.rms = MM.sqrt(MM.max(0, ssq) / nn);
                wins.push(w0);
            }
        }
        if (!wins.length) return { grade: 'none', span: 0, margin: isFinite(bestNear) ? -bestNear : null, toFair: isFinite(bestNear) ? -bestNear : null, a0: a0 };
        wins.sort(function (p1, p2) { return p1.a - p2.a || p1.b - p2.b; });
        function pick(ws) { return ws.reduce(function (p1, p2) { return (p2.span > p1.span + 1e-12 || (MM.abs(p2.span - p1.span) <= 1e-12 && p2.rms < p1.rms)) ? p2 : p1; }); }
        var runs = [];
        wins.forEach(function (w) { var r = runs[runs.length - 1]; if (r && w.a <= r.end) { r.w.push(w); if (w.b > r.end) r.end = w.b; } else runs.push({ start: w.a, end: w.b, w: [w] }); });
        runs.forEach(function (r) { r.best = pick(r.w); r.level = r.best.level; });
        var merged = [];
        runs.forEach(function (r) {
            var pr = merged[merged.length - 1];
            if (pr && MM.abs(r.level / pr.level - 1) <= 0.05 && (u[r.start] - u[pr.end]) / LN10 < 0.2) { pr.w = pr.w.concat(r.w); pr.end = MM.max(pr.end, r.end); pr.best = pick(pr.w); pr.level = pr.best.level; }
            else merged.push(r);
        });
        var ch = merged[0].best, il = ch.b;
        while (il > ch.a && (u[ch.b] - u[il - 1]) / LN10 <= 0.5 + 1e-9) il--;
        var lastY = y.slice(il, ch.b + 1).sort(function (p1, p2) { return p1 - p2; }), lh = lastY.length >> 1;
        var lvlL = (lastY.length % 2) ? lastY[lh] : 0.5 * (lastY[lh - 1] + lastY[lh]), sL = olsSlope(il, ch.b, lvlL);
        var g = MM.min((ch.span - 1) / 1, (0.01 - MM.abs(sL)) / 0.01, (0.10 - ch.band) / 0.10, (0.03 - MM.abs(ch.slope)) / 0.03);
        var out = { span: ch.span, slopeLast: sL, a0: a0, dte0: MM.pow(10, X[a0 + ch.a]), dte1: MM.pow(10, X[a0 + ch.b]) };
        if (g >= 0) { out.grade = 'good'; out.margin = g; }
        else {
            // fair needs any qualifying window: its distance to none is the best slack among them (the chosen window is the
            // longest, so its own slack is small by construction)
            var fs = -Infinity; wins.forEach(function (w) { fs = MM.max(fs, slack(w)); });
            out.grade = 'fair'; out.margin = MM.min(fs, -g); out.toGood = -g; out.fairSlack = fs;
        }
        return out;
    }

    function _wellInput(SC, pmin) {
        var g = SC.given, res = SC.res, inj = SC.fluid === 'water_inj', gas = SC.fluid === 'gas';
        var pb = isFinite(pmin) ? MM.max(100, MM.round(0.6 * pmin)) : null;
        return {
            fluid: SC.fluid, h: round6(g.h), phi: round6(g.phi), mu: round6(g.mu), B: round6(g.B), ct: round6(g.ct), rw: round6(g.rw), re_ft: null,
            Pb: (SC.fluid === 'oil') ? pb : null, Rs: (SC.fluid === 'oil') ? (SC.Rs || 400) : null,
            gas: gas ? { sg: SC.gas.sg, T_F: SC.gas.T_F, co2: SC.gas.co2, h2s: SC.gas.h2s, n2: SC.gas.n2, pseudoTime: !!SC.gas.pseudoTime, pdew: null, apiCond: null, Mo: null } : null,
            Bw: inj ? round6(g.B) : 1.02, muw: inj ? round6(g.mu) : 0.5, allocAccPct: 5, driftPsiPerDay: 0.01, defaulted: [],
            sens: { h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 }
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 12 — seed table, Latin hypercube, caseFromSeed (§5.2)
    // ═════════════════════════════════════════════════════════════════════
    var STRATA = [
        ['hom', 232], ['fault', 60], ['comp', 60], ['closed', 36], ['gas', 80], ['inj', 24], ['dualpor', 36], ['channel', 24],
        ['wbschange', 18], ['partpen', 12], ['frac', 12], ['constp', 12], ['interf', 12], ['partial', 10], ['baddata', 12]
    ];
    var SINGLE0 = 100000, SEQ0 = 200000, N_SEQ = 120, MASTER = 3300;
    var DISTRACTORS = ['dualpor', 'channel', 'wbschange', 'partpen', 'frac', 'constp', 'interf'];
    var SEED_TABLE = (function () {
        var t = [], s = SINGLE0;
        STRATA.forEach(function (e, i) { t.push({ stratum: e[0], n: e[1], from: s, to: s + e[1] - 1, index: i }); s += e[1]; });
        return t;
    })();
    var DIMS = ['k', 'h', 'S', 'C', 'phi', 'mu', 'ct', 'rw', 'q', 'B', 'dur', 'durClass', 'pi', 'closeHour', 'closeEarly', 'histDays', 'variation',
        'earlier', 'flush', 'flushDecay', 'intraDay', 'truncate', 'truncYears', 'sampling', 'sigmaLevel', 'coloured', 'colouredKind', 'ar1', 'lfTau',
        'slug', 'slugFactor', 'quant', 'spikes', 'drift', 'driftVal', 'tide', 'tideM2', 'tideK1', 'ramp', 'rampVal', 'allocHigh', 'resolution',
        'ignores', 'hoursConflict', 'partialBefore', 'pbFrac', 'pbLead', 'zoneMismatch', 'givenSigma', 'highKh', 'rateTable', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
    var _lhs = {};
    function _lhsFor(entry) {
        if (_lhs[entry.stratum]) return _lhs[entry.stratum];
        var r = rng(MASTER + entry.index), perms = {};
        DIMS.forEach(function (d) {
            var p = []; for (var i = 0; i < entry.n; i++) p.push(i);
            for (i = entry.n - 1; i > 0; i--) { var j = MM.floor(r.next() * (i + 1)), tmp = p[i]; p[i] = p[j]; p[j] = tmp; }
            perms[d] = p;
        });
        _lhs[entry.stratum] = perms;
        return perms;
    }
    function seedEntry(seed) {
        for (var i = 0; i < SEED_TABLE.length; i++) if (seed >= SEED_TABLE[i].from && seed <= SEED_TABLE[i].to) return SEED_TABLE[i];
        return null;
    }
    var RANGES = { k: [1, 2000], h: [15, 300], S: [-2, 15], C: [0.002, 0.2], phi: [0.08, 0.30], mu: [0.2, 10], ct: [3e-6, 3e-5], rw: [0.25, 0.40],
                   q: [100, 8000], qGas: [500, 30000], B: [1.05, 1.8] };
    function _rinv(k, dt, phi, mu, ct) { return 0.0325 * MM.sqrt(k * dt / (phi * mu * ct)); }
    function _distFor(tdev, k, phi, mu, ct) { return MM.sqrt(tdev * C_TD * k * LN10 / (phi * mu * ct)); }
    // rough drawdown and build-up checks for the rejection rule (Δp(Δt_end) ≥ 5 psi, pwf ≥ 50 psia)
    function _roughCheck(cs, pvt) {
        var t = cs.truth, days = cs.history.days, tp = MM.max(24, days * 24) + (cs.history.truncate ? cs.truncYears * 8760 : 0);
        var dur = cs.test.dtEnd_h, dte = tp * dur / (tp + dur);
        if (cs.fluid === 'gas') {
            var ref = pvt.props(cs.pi), muctG = ref.mu * gasCt(ref.cg), tdcG = C_TD * t.k / (t.phi * muctG * t.rw * t.rw);
            var cG = C_GAS * pvt.T_R / (t.k * t.h), Sp = t.S + (t.extra.Dq || 0), mi = pvt.mOf(cs.pi);
            var mwf = mi - cG * t.q * MM.max(0.1, 0.5 * (MM.log(tdcG * tp) + IARF_C) + Sp);
            var pwfG = mwf > 0 ? pvt.pOfM(mwf) : 0;
            var pEndG = pvt.pOfM(mwf + cG * t.q * MM.max(0.05, 0.5 * (MM.log(tdcG * dte) + IARF_C) + Sp));
            return { dpEnd: pEndG - pwfG, pwf: pwfG, ddown: cs.pi - pwfG, ok: (pEndG - pwfG) >= 5 && pwfG >= MM.max(50, 0.25 * cs.pi) };
        }
        // oil / water: the generator's own kernel (wellbore storage and skin included), single-rate superposition,
        // with 30 % rate headroom for the daily variation and the depletion / offset-well extras
        var kn = _kernelFor(t), tdc = C_TD * t.k / (t.phi * t.mu * t.ct * t.rw * t.rw), Cd = C_CD * t.C / (t.phi * t.ct * t.h * t.rw * t.rw);
        var prm = {}; for (var key in kn.mp) prm[key] = kn.mp[key];
        // partial penetration: homogeneous plus its pseudo-skin (the full series is too slow for a rejection loop)
        var km = kn.model === 'partpen' ? 'homogeneous' : kn.model;
        prm.Cd = Cd; prm.S = t.S + (kn.model === 'partpen' ? kn.Sgeo : 0);
        var pw = pwd(km, prm, [tdc * tp, tdc * dur, tdc * (tp + dur)]);
        var cP = C_P * t.B * t.mu / (t.k * t.h);
        var dpEnd = cP * t.q * (pw[1] - pw[2] + pw[0]);
        var ddown = 1.3 * cP * t.q * pw[0];
        if (t.extra && t.extra.dpdt) ddown += MM.abs(t.extra.dpdt) * tp;
        if (t.extra && t.extra.qo) ddown += 70.6 * t.extra.qo * t.B * t.mu / (t.k * t.h) * expE1(948.1 * t.phi * t.mu * t.ct * t.extra.r_ft * t.extra.r_ft / (t.k * (dur + 1)));
        if (!isFinite(dpEnd)) dpEnd = 0;
        if (!isFinite(ddown)) ddown = 1e9;
        var pwf = cs.pi - ddown * (cs.fluid === 'water_inj' ? -1 : 1);
        return { dpEnd: dpEnd, pwf: pwf, ddown: ddown, ok: dpEnd >= 5 && pwf >= 50 && pwf <= 15000 };
    }
    // CaseSpec truth → kernel name, dimensionless parameters and geometric pseudo-skin
    var _sppMemo = {};
    function _kernelFor(t) {
        var rw = t.rw, x = t.extra || {};
        switch (t.model) {
            case 'fault': return { model: 'fault', mp: { dF: x.dF_ft / rw }, Sgeo: 0 };
            case 'constp': return { model: 'constp', mp: { dF: x.dF_ft / rw }, Sgeo: 0 };
            case 'composite': return { model: 'composite', mp: { M: x.M, F: x.F || 1, R: x.R_ft / rw }, Sgeo: 0 };
            case 'closed': return { model: 'closed', mp: { reD: x.re_ft / rw }, Sgeo: 0 };
            case 'dualpor': return { model: 'dualpor', mp: { omega: x.omega, lambda: x.lambda }, Sgeo: 0 };
            case 'channel': return { model: 'channel', mp: { a: x.a_ft / rw, b: (x.width_ft - x.a_ft) / rw }, Sgeo: 0 };
            case 'frac': return { model: 'frac', mp: { xfD: x.xf_ft / rw }, Sgeo: _fracSkin(x.xf_ft / rw) };
            case 'partpen': {
                var mp = { hD: t.h / rw, kvkh: x.kvkh, hw: x.hwFrac, ztop: x.ztopFrac };
                var key = [mp.hD, mp.kvkh, mp.hw, mp.ztop].map(function (v) { return v.toPrecision(10); }).join('|');
                if (_sppMemo[key] == null) _sppMemo[key] = _ppPrepare(mp).Spp;
                return { model: 'partpen', mp: mp, Sgeo: _sppMemo[key] };
            }
        }
        return { model: 'homogeneous', mp: {}, Sgeo: 0 };
    }
    // gas: build-up average pressure (pwf0 and the end of the test, closed form) and the table values there
    function _gasRef(cs, pvt) {
        var t = cs.truth, days = cs.history.days, tp = MM.max(24, days * 24), dur = cs.test.dtEnd_h;
        var r0 = pvt.props(cs.pi), tdc0 = C_TD * t.k / (t.phi * r0.mu * gasCt(r0.cg) * t.rw * t.rw);
        var cG = C_GAS * pvt.T_R / (t.k * t.h), Sp = t.S + (t.D || 0) * t.q, mi = pvt.mOf(cs.pi);
        var dmFlow = cG * t.q * MM.max(0.1, 0.5 * (MM.log(tdc0 * tp) + IARF_C) + Sp);
        var dte = tp * dur / (tp + dur), dmEnd = cG * t.q * MM.max(0.05, 0.5 * (MM.log(tdc0 * dte) + IARF_C) + Sp);
        var pwf0 = pvt.pOfM(mi - dmFlow), pEnd = pvt.pOfM(mi - dmFlow + dmEnd), pr = 0.5 * (pwf0 + pEnd), ref = pvt.props(pr);
        return { p: round6(pr), mu: round6(ref.mu), z: round6(ref.z), ct: round6(gasCt(ref.cg)), Bg: round6(ref.Bg) };
    }
    function caseFromSeed(seed, opts) {
        var entry = seedEntry(seed);
        if (!entry) throw new Error('synth.caseFromSeed: seed ' + seed + ' is outside the single-case table ' + SINGLE0 + '–' + (SINGLE0 + 639));
        var row = seed - entry.from, perms = _lhsFor(entry), n = entry.n;
        var U = {}; DIMS.forEach(function (d) { U[d] = (perms[d][row] + 0.5) / n; });
        var r = rng(seed);
        var st = entry.stratum, fluid = st === 'gas' ? 'gas' : (st === 'inj' ? 'water_inj' : 'oil');
        var t = {
            model: 'homogeneous', k: logU(U.k, 1, 2000), S: lin(U.S, -2, 15), C: logU(U.C, 0.002, 0.2), h: lin(U.h, 15, 300), phi: lin(U.phi, 0.08, 0.30),
            mu: logU(U.mu, 0.2, 10), B: lin(U.B, 1.05, 1.8), ct: logU(U.ct, 3e-6, 3e-5), rw: lin(U.rw, 0.25, 0.40), q: logU(U.q, 100, 8000), D: null, extra: {}
        };
        var highKh = U.highKh < 0.10 && st !== 'gas';
        if (highKh) { var kh = logU(U.x6, 20000, 100000); t.h = MM.max(t.h, kh / 2000); t.h = MM.min(300, t.h); t.k = clamp(kh / t.h, 1, 2000); }
        var dur = (st === 'hom' && U.durClass < 0.2) ? logU(U.dur, 2, 8) : ((st === 'partial' || st === 'baddata') ? logU(U.dur, 8, 72) : logU(U.dur, 8, 200));
        var cs = {
            seed: seed, stratum: st, row: row, fluid: fluid, truth: t, given: null,
            history: { days: MM.round(lin(U.histDays, 30, 180)), variationPct: lin(U.variation, 5, 25), earlierShutins: MM.min(3, MM.floor(U.earlier * 4)),
                       truncate: U.truncate < 0.15, intraDayChange: U.intraDay < 0.10, flushPct: lin(U.flush, 10, 40), flushDecay_h: lin(U.flushDecay, 2, 12) },
            test: { closeHour: U.closeEarly < 0.05 ? lin(U.closeHour, 0, 0.999) : lin(U.closeHour, 1, 23.99), dtEnd_h: dur, dtSample_s: [1, 10, 60, 300, 600][MM.min(4, MM.floor(U.sampling * 5))],
                    sigma: [0.005, 0.02, 0.1, 0.5][MM.min(3, MM.floor(U.sigmaLevel * 4))], sigmaFlowFactor: 1, ar1Rho: null, quant: U.quant < 0.5 ? 0.01 : 0,
                    spikes: U.spikes < 0.3 ? 3 + MM.floor(U.x1 * 20) : 0, drift_psi_d: U.drift < 0.3 ? lin(U.driftVal, 0, 0.05) : 0,
                    tide: { M2: U.tide < 0.15 ? lin(U.tideM2, 0.05, 0.5) : 0, K1: U.tide < 0.15 ? lin(U.tideK1, 0.05, 0.5) * 0.6 : 0 },
                    ramp_s: U.ramp < 0.3 ? lin(U.rampVal, 0, 300) : 0, partialBefore: U.partialBefore < 0.10 ? lin(U.pbFrac, 0.2, 0.6) : null },
            alloc: { errPct: U.allocHigh < 0.25 ? 10 : 3, bias: lin(U.x2, -0.05, 0.05), ignoresShutin: U.ignores < 0.10, hoursConflict_h: U.hoursConflict < 0.10 ? lin(U.x3, 2, 4) : 0,
                     resolution: U.resolution < 0.5 ? 1 : 10 },
            pi: fluid === 'gas' ? lin(U.pi, 2500, 8000) : lin(U.pi, 2000, 6000),
            rateSource: (U.rateTable < 0.10 && st !== 'partial' && st !== 'baddata') ? 'table' : 'allocation',
            dayStart: { trueHour: U.zoneMismatch < 0.10 ? 6 : 0, statedHour: 0 },
            pbLead_h: lin(U.pbLead, 2, 12)
        };
        if (U.coloured < 0.3) {
            if (U.colouredKind < 0.5) cs.test.ar1Rho = lin(U.ar1, 0.5, 0.95);
            else cs.test.lf = { tau_h: logU(U.lfTau, 0.5, 5), sigma: cs.test.sigma * lin(U.ar1, 0.5, 2) };
        }
        if (U.slug < 0.3) cs.test.sigmaFlowFactor = lin(U.slugFactor, 2, 20);
        if (highKh) { cs.test.sigma = lin(U.sigmaLevel, 0.02, 0.1); cs.test.sigmaFlowFactor = MM.max(cs.test.sigmaFlowFactor, lin(U.slugFactor, 2, 20)); }
        if (cs.history.truncate) cs.truncYears = lin(U.truncYears, 1, 5);
        // stratum physics
        var k = t.k, phi = t.phi, mu = t.mu, ct = t.ct;
        switch (st) {
            case 'fault': {
                var ratio = [0.1, 0.5, 2][MM.min(2, MM.floor(U.x2 * 3))];
                t.model = 'fault'; t.extra.dF_ft = _distFor(ratio * dur, k, phi, mu, ct); t.extra.ratio = ratio; break;
            }
            case 'constp': {
                var ratio2 = [0.1, 0.5, 2][MM.min(2, MM.floor(U.x2 * 3))];
                t.model = 'constp'; t.extra.dF_ft = _distFor(ratio2 * dur, k, phi, mu, ct); t.extra.ratio = ratio2; break;
            }
            case 'comp':
                t.model = 'composite'; t.extra.M = logU(U.x2, 0.3, 3); t.extra.R_ft = _rinv(k, dur, phi, mu, ct) * lin(U.x3, 0.2, 1.5);
                t.extra.F = U.x4 < 2 / 3 ? 1 : logU(U.x5, 0.5, 2); break;
            case 'closed': {
                var tDA = logU(U.x2, 0.05, 1);
                t.model = 'closed'; t.extra.re_ft = MM.sqrt(C_TD * k * dur / (phi * mu * ct * MM.PI * tDA)); t.extra.tDA = tDA;
                cs.history.days = MM.min(cs.history.days, 30 + MM.round(U.histDays * 15)); cs.history.truncate = false; break;
            }
            case 'gas':
                t.q = logU(U.q, 500, 30000);
                cs.gas = { sg: 0, T_F: lin(U.x3, 150, 300), co2: lin(U.x4, 0, 10), h2s: lin(U.x5, 0, 10) * (U.x1 < 0.5 ? 1 : 0), n2: lin(U.x6, 0, 10), pseudoTime: U.x1 < 0.5 };
                var imp = (cs.gas.n2 * 0.9672 + cs.gas.co2 * 1.5196 + cs.gas.h2s * 1.1767) / 100, yI = (cs.gas.n2 + cs.gas.co2 + cs.gas.h2s) / 100;
                cs.gas.sg = MM.round((lin(U.B, 0.58, 0.75) * (1 - yI) + imp) * 1000) / 1000;
                var dq = lin(U.x2, 0, 2); t.D = dq / t.q; t.extra.Dq = dq;
                break;
            case 'inj':
                t.B = lin(U.B, 1.05, 1.08); t.mu = lin(U.mu, 0.3, 1.0); mu = t.mu;
                if (U.x3 < 4 / 24) { t.model = 'frac'; t.extra.xf_ft = lin(U.x4, 30, 200); }
                else if (U.x2 < 0.5) { t.model = 'composite'; t.extra.M = lin(U.x4, 0.2, 1); t.extra.F = 1; t.extra.R_ft = _rinv(k, dur, phi, mu, ct) * lin(U.x5, 0.2, 1.0); }
                break;
            case 'dualpor': t.model = 'dualpor'; t.extra.omega = lin(U.x2, 0.05, 0.3); t.extra.lambda = logU(U.x3, 1e-8, 1e-5); break;
            case 'channel': {
                var th = dur * lin(U.x2, 0.05, 0.5), alpha = lin(U.x3, 0.25, 0.5), bft = _distFor(th, k, phi, mu, ct);
                t.model = 'channel'; t.extra.width_ft = bft / (1 - alpha); t.extra.a_ft = alpha * t.extra.width_ft; break;
            }
            case 'wbschange':
                t.model = 'wbschange'; t.extra.hump_psi = logU(U.x2, 1, 20); t.extra.type = U.x3 < 0.5 ? 'fair' : 'transient';
                t.extra.tau_h = t.extra.type === 'fair' ? logU(U.x4, 0.05, 1) : logU(U.x4, 0.1, 2); break;
            case 'partpen': t.model = 'partpen'; t.extra.hwFrac = lin(U.x2, 0.1, 0.5); t.extra.kvkh = logU(U.x3, 0.01, 1); t.extra.ztopFrac = lin(U.x4, 0, 1 - t.extra.hwFrac); break;
            case 'frac': t.model = 'frac'; t.extra.xf_ft = logU(U.x2, 20, 300); break;
            case 'interf':
                t.model = 'interf';
                if (U.x2 < 0.5) { t.extra.type = 'offset'; t.extra.r_ft = logU(U.x3, 300, 3000); t.extra.qo = t.q * lin(U.x4, 0.5, 2); t.extra.ton_rel_h = lin(U.x5, -0.5, 0.5) * dur; }
                else { t.extra.type = 'depletion'; t.extra.dpdt = -lin(U.x3, 0.002, 0.05); }
                break;
            case 'partial': t.model = 'partial'; t.extra.f = lin(U.x2, 0.3, 0.85); break;
            case 'baddata':
                t.model = 'baddata'; t.extra.type = U.x2 < 0.5 ? 'gapAtClosing' : 'closingInGap';
                if (t.extra.type === 'gapAtClosing') { t.extra.gapBefore_min = lin(U.x3, 0, 10); t.extra.gapAfter_min = lin(U.x4, 15, 90); }
                else { t.extra.gapBefore_min = 60 * lin(U.x3, 1, 6); t.extra.gapAfter_min = 60 * lin(U.x4, 1, 6); }
                break;
        }
        // rejection: Δp(Δt_end) ≥ 5 psi and pwf ≥ 50 psia (rate rescaled first, then k / h redrawn)
        // gas: keep the formation volume factor inside the engines' accepted range (gas B 0.3–5 rb/Mscf): a very high p_i
        // at a low temperature (Bg < 0.32 at p_i) is lowered until Bg(p_i) = 0.33 (flagged gasPiLimited)
        if (fluid === 'gas') {
            var pv0 = gasPVT(cs.gas, MM.max(cs.pi * 1.6, 2000));
            for (var lim0 = 0; lim0 < 8; lim0++) { var bg0 = pv0.props(cs.pi).Bg; if (bg0 >= 0.32) break; cs.pi *= bg0 / 0.33; cs.gasPiLimited = true; }
        }
        var pvt = fluid === 'gas' ? gasPVT(cs.gas, MM.max(cs.pi * 1.6, 2000)) : null;
        // A rescale aims at a Δp(Δt_end) level drawn per case (log-uniform 6–60 psi), so rescaled cases do not pile up at
        // the rule's edge; a drawdown limit halves the aim. A redraw keeps the stratum's own design draws (composite
        // R ratio) and, for high-kh cases, kh in 20,000–100,000 md·ft.
        var qRange = fluid === 'gas' ? RANGES.qGas : RANGES.q, attempts = 0, chk = _roughCheck(cs, pvt);
        var dpTarget = logU(r.next(), 6, 60);
        while (!chk.ok && attempts < 40) {
            attempts++;
            var pwfMin = fluid === 'gas' ? MM.max(50, 0.25 * cs.pi) : 50, pwfBad = chk.pwf < pwfMin || chk.pwf > 15000;
            if (pwfBad) {
                var lim = (fluid === 'water_inj') ? (15000 - cs.pi) * 0.5 : (fluid === 'gas' ? 0.5 * cs.pi : (cs.pi - 50) * 0.6);
                t.q = MM.max(qRange[0], t.q * MM.min(0.7, lim / MM.max(chk.ddown, 1e-6)));
                dpTarget = MM.max(6, 0.5 * dpTarget);
            } else if (chk.dpEnd < 5) t.q = MM.min(qRange[1], t.q * dpTarget / MM.max(chk.dpEnd, 1e-3));
            chk = _roughCheck(cs, pvt);
            if (!chk.ok && attempts > 8) {
                if (highKh) { var kh2 = logU(r.next(), 20000, 100000); t.h = MM.min(300, MM.max(lin(r.next(), 15, 300), kh2 / 2000)); t.k = clamp(kh2 / t.h, 1, 2000); }
                else { t.k = logU(r.next(), 1, 2000); t.h = lin(r.next(), 15, 300); }
                t.q = logU(r.next(), qRange[0], qRange[1]);
                if (st === 'fault' || st === 'constp') t.extra.dF_ft = _distFor(t.extra.ratio * dur, t.k, phi, mu, ct);
                if (st === 'comp') t.extra.R_ft = _rinv(t.k, dur, phi, mu, ct) * lin(U.x3, 0.2, 1.5);
                if (st === 'inj' && t.model === 'composite') t.extra.R_ft = _rinv(t.k, dur, phi, mu, ct) * lin(U.x5, 0.2, 1.0);
                if (st === 'closed') t.extra.re_ft = MM.sqrt(C_TD * t.k * dur / (phi * mu * ct * MM.PI * t.extra.tDA));
                if (st === 'channel') { var bf = _distFor(dur * lin(U.x2, 0.05, 0.5), t.k, phi, mu, ct); t.extra.width_ft = bf / (1 - lin(U.x3, 0.25, 0.5)); t.extra.a_ft = lin(U.x3, 0.25, 0.5) * t.extra.width_ft; }
                chk = _roughCheck(cs, pvt);
            }
        }
        cs.rejections = attempts;
        cs.highKh = highKh;
        cs.check = { dpEnd_psi: round6(chk.dpEnd), pwf_psia: round6(chk.pwf), ok: chk.ok, dpTarget_psi: round6(dpTarget) };
        if (fluid === 'gas') {
            if (t.extra.Dq != null) t.D = t.extra.Dq / t.q;
            var gref = _gasRef(cs, pvt);
            cs.gasRef = gref; t.mu = gref.mu; t.B = gref.Bg; t.ct = gref.ct;
        }
        // given inputs (lognormal 0–10 %, per case); gas: B and μ come from the gas table (not perturbed)
        var gs = lin(U.givenSigma, 0, 0.10), fac = function () { return MM.exp(clamp(r.normal(), -2, 2) * gs); };
        cs.given = { h: t.h * fac(), phi: MM.min(0.99, t.phi * fac()), ct: t.ct * fac(), rw: t.rw * fac(), B: t.B * fac(), mu: t.mu * fac() };
        if (fluid === 'gas') { cs.given.B = t.B; cs.given.mu = t.mu; }
        cs.given.sigma = round6(gs);
        if (opts && (opts.lite || opts.maxDays || opts.dtSample_s)) cs.lite = { maxDays: (opts.maxDays || (opts.lite ? 30 : null)), dtSample_s: (opts.dtSample_s || (opts.lite ? 60 : null)) };
        return cs;
    }
    var LITE = { dtSample_s: 60, maxDays: 30 };
    // Effects in a CaseSpec that the engine does not model (§5.2 asks the generator to report the exact share):
    // distractor physics, coloured noise, slugging, spikes, gauge drift, tides, flush after reopening, an intra-day
    // rate change, a truncated history and a production-day offset.
    function unmodelledEffects(cs) {
        var e = [], t = cs.test, h = cs.history;
        if (DISTRACTORS.indexOf(cs.stratum) !== -1 || (cs.stratum === 'inj' && cs.truth.model === 'frac')) e.push('physics');
        if (t.ar1Rho || t.lf) e.push('colouredNoise');
        if (t.sigmaFlowFactor > 1) e.push('slugging');
        if (t.spikes > 0) e.push('spikes');
        if (t.drift_psi_d > 0) e.push('drift');
        if (t.tide.M2 > 0 || t.tide.K1 > 0) e.push('tide');
        if (h.earlierShutins > 0 && h.flushPct > 0) e.push('flush');
        if (h.intraDayChange) e.push('intraDayChange');
        if (h.truncate) e.push('truncatedHistory');
        if (cs.dayStart && cs.dayStart.trueHour !== cs.dayStart.statedHour) e.push('dayOffset');
        return e;
    }
    function unmodelledShare() {
        var n = 0, k = 0, by = {};
        for (var s = SINGLE0; s < SINGLE0 + 640; s++) {
            var e = unmodelledEffects(caseFromSeed(s)); n++;
            if (e.length) k++;
            e.forEach(function (x) { by[x] = (by[x] || 0) + 1; });
        }
        return { n: n, withEffect: k, share: k / n, byEffect: by };
    }

    // The intra-day rate change before the closing: lead 2–12 h, factor 0.8–1.2 (both drawn, so the stream is the same with
    // or without an override); CaseSpec.history.intra {lead, factor} pins them (tests of the §5.3 scorer rule).
    function _intraOf(hist, r) {
        var o = { lead: r.uniform(2, 12), factor: r.uniform(0.8, 1.2) }, p = hist.intra;
        if (p && isFinite(p.lead) && p.lead > 0 && isFinite(p.factor) && p.factor > 0) o = { lead: +p.lead, factor: +p.factor };
        return o;
    }
    // CaseSpec → internal scenario
    function _scenarioFromCase(cs, opts) {
        opts = opts || {};
        var lite = cs.lite || (opts.lite ? LITE : null) || {};
        var t = cs.truth, r = rng((cs.seed * 7919 + 17) | 0), hist = cs.history;
        var days = MM.max(4, MM.round(hist.days));
        if (lite.maxDays) days = MM.min(days, lite.maxDays);
        var dayShift = cs.dayStart ? cs.dayStart.trueHour : 0;
        var tc = (days - 1) * 24 + clamp(cs.test.closeHour, 0, 23.99) + dayShift;
        var dur = cs.test.dtEnd_h, tEnd = tc + dur;
        var qDay = [], q = t.q, nD = days + MM.ceil(dur / 24) + 3, v = hist.variationPct / 100, level = 1;
        // day rates: an AR(1) day-to-day variation around the nominal rate with a slow decline (the closing day is not pinned:
        // q_true is whatever rate flows before the closing, and the truth uses it)
        for (var d = 0; d < nD; d++) { level = 1 + (level - 1) * 0.6 + 0.4 * v * r.normal(); qDay.push(q * clamp(level, 0.5, 1.6) * MM.pow(0.9995, d)); }
        // Quiet window before the test (§5.2): the true rate is held at the closing day's rate over the closing day and the
        // QUIET_DAYS days before it (the day-to-day variation there lives in the allocation error); a 5–25 % day-to-day step
        // right before a closing is a partial cut in its own right and would hide the test from detection.
        _quietWindow(qDay, MM.floor((tc - dayShift) / 24) - MM.floor((0 - dayShift) / 24));
        var events = [];
        // earlier shut-ins
        for (var e = 0; e < hist.earlierShutins; e++) {
            for (var tries = 0; tries < 20; tries++) {
                var dd = r.int(3, MM.max(3, days - 5)), tce = dd * 24 + dayShift + r.uniform(0, 23.5), du = r.uniform(6, 48);
                if (tce + du > tc - 48) continue;
                if (events.some(function (o) { return tce < o.tc + o.dur + 24 && o.tc < tce + du + 24; })) continue;
                events.push({ kind: 'shutin', tc: tce, dur: du, f: 1, ramp_s: 0, pb: null, intra: null, Safter: null, isTest: false });
                break;
            }
        }
        var testEv = { kind: cs.stratum === 'partial' ? 'partial' : 'shutin', tc: tc, dur: dur, f: cs.stratum === 'partial' ? t.extra.f : 1,
                       ramp_s: cs.test.ramp_s || 0, pb: cs.test.partialBefore ? { f: cs.test.partialBefore, lead: cs.pbLead_h || 4 } : null,
                       intra: hist.intraDayChange ? _intraOf(hist, r) : null, Safter: null, isTest: true, label: 'test' };
        if (testEv.intra && testEv.pb) testEv.intra = null;
        events.push(testEv);
        events.sort(function (a, b) { return a.tc - b.tc; });
        var model = t.model, kn = _kernelFor(t), resModel = kn.model, mp = kn.mp, sgeo = kn.Sgeo;
        var dt = lite.dtSample_s || cs.test.dtSample_s;
        var SC = {
            name: 'Synthetic case ' + cs.seed + ' (' + cs.stratum + ')', stratum: cs.stratum, fluid: cs.fluid,
            T0_ms: Date.UTC(2025, 0, 6) + ((cs.seed * 7) % 180) * DAY_MS, tEnd_h: tEnd,
            res: { k: t.k, h: t.h, phi: t.phi, mu: t.mu, B: t.B, ct: t.ct, rw: t.rw, C: t.C, pi: cs.pi, D: t.D || 0, model: resModel, mp: mp, mu0: t.mu, B0: t.B },
            gas: cs.gas || null, truthModel: model === 'homogeneous' ? 'homogeneous' : model, Sgeo: sgeo,
            // truncated history: years of production at a rate within ±3 % of the first record day (an unknown start,
            // §5.2, without a rate step at the first sample)
            prod: { tStart_h: hist.truncate ? -cs.truncYears * 8760 : 0, qHist: qDay[0] * r.uniform(0.97, 1.03), qDay: qDay, dayShift_h: dayShift,
                    dayIndex0: MM.floor((0 - dayShift) / 24), flushPct: hist.earlierShutins > 0 ? hist.flushPct : 0, flushDecay_h: hist.flushDecay_h },
            events: events, S0: t.S,
            sampling: dt === 1 ? { base_s: 300, dense_s: 60, burst: true } : { base_s: MM.max(300, dt), dense_s: dt, burst: false },
            noise: { sigma: cs.test.sigma, sigmaFlowFactor: cs.test.sigmaFlowFactor || 1, ar1Rho: cs.test.ar1Rho, lf: cs.test.lf || null, quant: cs.test.quant,
                     spikes: cs.test.spikes || 0, drift: cs.test.drift_psi_d || 0, tideM2: cs.test.tide.M2, tideK1: cs.test.tide.K1 },
            extras: null, gap: null, alloc: cs.alloc, rateSource: cs.rateSource, given: cs.given,
            notAnalysable: cs.stratum === 'baddata', Rs: MM.round(r.uniform(150, 600)), wc: r.uniform(0, 0.03),
            history: hist.truncate ? { mode: 'unknown', date: null, cum: null } : { mode: 'date', date: null, cum: null },
            zones: { gauge: { mode: 'utc' }, day: { zone: { mode: 'utc' }, startHour: cs.dayStart ? cs.dayStart.statedHour : 0 } },
            seedNoise: (cs.seed * 2654435761) >>> 0
        };
        SC.history.date = hist.truncate ? null : dateOf(SC.T0_ms);
        if (model === 'interf') {
            SC.extras = t.extra.type === 'offset' ? { offset: { r_ft: t.extra.r_ft, q: t.extra.qo, t_on: tc + t.extra.ton_rel_h } } : { dpdt: t.extra.dpdt };
        }
        if (model === 'wbschange') SC.extras = { hump: { tc: tc, A: t.extra.hump_psi, tau: t.extra.tau_h, type: t.extra.type } };
        if (model === 'baddata') SC.gap = { t0: tc - t.extra.gapBefore_min / 60, t1: tc + t.extra.gapAfter_min / 60 };
        if (cs.fluid === 'gas') SC._pRefEst = cs.gasRef.p;   // μ·ct at the build-up average pressure (caseFromSeed)
        return SC;
    }
    function _fracSkin(xfD) {   // late-time equivalent skin of the fracture kernel (numeric)
        var tD = 1e4 * xfD * xfD;
        var p = _invert('frac', { xfD: xfD }, 0, 0, tD)[0];
        return p - 0.5 * (MM.log(tD) + IARF_C);
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 13 — generate / generateJob → SynthCase
    // ═════════════════════════════════════════════════════════════════════
    function _toSynthCase(cs, g) {
        var tr = g.truths[0];
        return {
            spec: cs, record: g.record, allocation: { rows: g.allocation.rows }, rateTable: g.rateTable, well: g.well,
            truth: {
                tc_ms: tr.tc_ms, k: tr.k, S: tr.S, model: tr.model, f: tr.f, qCorrect: tr.qCorrect, kStar: tr.kStar, SStar: tr.SStar,
                plateaus: tr.plateaus, visible: { fault: tr.visible.fault, comp: tr.visible.comp, closed: tr.visible.closed, distractor: tr.visible.distractor },
                notAnalysable: tr.notAnalysable, partial: tr.partial,
                stratum: cs.stratum, qTrue: tr.qTrue, dqSource: tr.dqSource, kStarInputs: tr.kStarInputs, SStarInputs: tr.SStarInputs,
                dtEnd_h: tr.dtEnd_h, dteEnd_h: tr.dteEnd_h, reach: tr.reach, grade: tr.grade, gradeMargin: fin(tr.gradeInfo.margin), distractor: tr.distractor, ramp_s: tr.ramp_s, gasMu: tr.gasMu,
                departure: { end: tr.visible._endDep, max: tr.visible._maxDep }, fluid: cs.fluid
            },
            history: g.history, zones: g.zones, completion: g.completion, workovers: g.workovers, settings: defaultSettings(), info: g.info
        };
    }
    function _jobWrap(SC, opts, finish) {
        var j = new GenJob(SC, opts), out = null;
        return {
            step: function () {
                var r = j.step();
                if (r.done && !j.cancelled && out === null) out = finish(j.result());
                return r;
            },
            result: function () { return out; },
            cancel: function () { j.cancel(); },
            stats: function () { return j.stats(); }   // largest step per phase against its cap (count-based units)
        };
    }
    function generateJob(spec, opts) {
        opts = opts || {};
        if (typeof spec === 'string') return demoJob(spec);
        if (typeof spec === 'number') spec = (spec >= SEQ0 && spec < SEQ0 + N_SEQ) ? sequenceFromSeed(spec) : caseFromSeed(spec, opts);
        if (spec && spec.sequence) return _jobWrap(_scenarioFromSeq(spec, opts), opts, function (g) { return _toSequenceCase(spec, g); });
        var cs = spec;
        var SC = _scenarioFromCase(cs, opts);
        return _jobWrap(SC, opts, function (g) { return _toSynthCase(cs, g); });
    }
    function _run(job) { var guard = 0; while (!job.step().done && guard++ < 1e6) { /* drive synchronously */ } return job.result(); }
    function generate(spec, opts) { return _run(generateJob(spec, opts)); }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 14 — sequences (seeds 200000–200119)
    // ═════════════════════════════════════════════════════════════════════
    var SEQ_PATHS = [['constant', 48], ['step', 24], ['linear', 24], ['stimulation', 12], ['gasRate', 12]];
    function sequenceFromSeed(seed) {
        var i = seed - SEQ0;
        if (!(i >= 0 && i < N_SEQ)) throw new Error('synth.sequenceFromSeed: seed ' + seed + ' is outside ' + SEQ0 + '–' + (SEQ0 + N_SEQ - 1));
        var path = null, c = 0;
        for (var p = 0; p < SEQ_PATHS.length; p++) { if (i < c + SEQ_PATHS[p][1]) { path = SEQ_PATHS[p][0]; break; } c += SEQ_PATHS[p][1]; }
        var r = rng(seed), gas = path === 'gasRate';
        var nT = r.int(6, 12), days = r.int(90, 365), longShut = (i % 2) === 1;
        var spec = {
            sequence: true, seed: seed, path: path, fluid: gas ? 'gas' : 'oil', nTests: nT, days: days, shutClass: longShut ? '48-120' : '24-48',
            truth: { k: logU(r.next(), 5, 800), h: lin(r.next(), 20, 200), S0: lin(r.next(), -1, 5), C: logU(r.next(), 0.005, 0.05), phi: lin(r.next(), 0.1, 0.28),
                     mu: gas ? 0.02 : logU(r.next(), 0.3, 5), B: gas ? 1 : lin(r.next(), 1.1, 1.6), ct: logU(r.next(), 5e-6, 2e-5), rw: lin(r.next(), 0.25, 0.4),
                     q: gas ? logU(r.next(), 3000, 20000) : logU(r.next(), 300, 3000), D: null },
            pi: gas ? lin(r.next(), 3000, 7000) : lin(r.next(), 2500, 6000),
            sigma: lin(r.next(), 0.005, 0.05), errPct: 3, workoverEntered: false, given: null
        };
        var t = spec.truth;
        if (gas) { spec.gas = { sg: lin(r.next(), 0.6, 0.72), T_F: lin(r.next(), 160, 260), co2: lin(r.next(), 0, 4), h2s: 0, n2: lin(r.next(), 0, 3), pseudoTime: false }; t.D = lin(r.next(), 0.5, 1.5) / t.q; }
        // test schedule: evenly spread with jitter, shut-ins 24–48 h or 48–120 h
        var tests = [], gap = days / (nT + 0.5);
        for (var k = 0; k < nT; k++) {
            var day = MM.floor(gap * (k + 0.5) + r.uniform(-0.2, 0.2) * gap);
            tests.push({ day: MM.max(5, MM.min(days - 6, day)), hour: r.uniform(1, 22), dur: longShut ? r.uniform(48, 120) : r.uniform(24, 48), S: t.S0, qFactor: 1 });
        }
        for (k = 1; k < tests.length; k++) if (tests[k].day <= tests[k - 1].day + MM.ceil(tests[k - 1].dur / 24) + 2) tests[k].day = tests[k - 1].day + MM.ceil(tests[k - 1].dur / 24) + 2;
        tests = tests.filter(function (x) { return x.day + MM.ceil(x.dur / 24) < days + 10; });
        spec.days = MM.max(days, tests[tests.length - 1].day + MM.ceil(tests[tests.length - 1].dur / 24) + 1);
        var onsetIdx = null, slope = null, step = null, wo = null;
        if (path === 'step') { onsetIdx = r.int(3, MM.max(3, tests.length - 3)); step = lin(r.next(), 3, 8); for (k = onsetIdx; k < tests.length; k++) tests[k].S = t.S0 + step; }
        if (path === 'linear') { onsetIdx = r.int(2, MM.max(2, tests.length - 3)); slope = lin(r.next(), 0.5, 3); var d0 = tests[onsetIdx - 1].day; for (k = onsetIdx; k < tests.length; k++) tests[k].S = t.S0 + slope * (tests[k].day - d0) / 30; }
        if (path === 'stimulation') {
            onsetIdx = r.int(2, MM.max(2, tests.length - 4)); var rise = lin(r.next(), 3, 8);
            for (k = onsetIdx; k < tests.length; k++) tests[k].S = t.S0 + rise;
            var woIdx = MM.min(tests.length - 2, onsetIdx + 2), drop = lin(r.next(), 5, 8);
            for (k = woIdx; k < tests.length; k++) tests[k].S = t.S0 + rise - drop;
            wo = { afterTest: woIdx - 1 }; spec.workoverEntered = (i % 2) === 0;
        }
        if (path === 'gasRate') { for (k = 0; k < tests.length; k++) tests[k].qFactor = (k % 2) ? 0.55 : 1; }
        spec.tests = tests; spec.onsetIdx = onsetIdx; spec.slopePer30d = slope; spec.step = step; spec.workover = wo;
        var e = function () { return 1 + lin(r.next(), -0.2, 0.2); };
        spec.given = { h: t.h * e(), phi: MM.min(0.99, t.phi * e()), ct: t.ct * e(), rw: t.rw * e(), B: t.B * e(), mu: t.mu };
        if (gas) { spec.ctFactor = e(); spec.given.B = null; spec.given.mu = null; spec.given.ct = null; }
        return spec;
    }
    function _scenarioFromSeq(spec, opts) {
        var t = spec.truth, r = rng((spec.seed * 104729 + 3) | 0), days = spec.days + 2;
        var qDay = [], level = 1, tests = spec.tests;
        for (var d = 0; d < days + 2; d++) { level = 1 + (level - 1) * 0.6 + 0.4 * 0.08 * r.normal(); qDay.push(t.q * clamp(level, 0.7, 1.3) * MM.pow(0.9997, d)); }
        tests.forEach(function (x) { _quietWindow(qDay, x.day); });   // constant over each closing day and the 4 days before it
        if (spec.path === 'gasRate') {
            for (d = 0; d < qDay.length; d++) {
                var fac = 1;
                for (var k = 0; k < tests.length; k++) if (d <= tests[k].day) { fac = tests[k].qFactor; break; }
                qDay[d] = t.q * fac;
            }
        }
        var events = tests.map(function (x, k) {
            var next = tests[k + 1];
            return { kind: 'shutin', tc: x.day * 24 + x.hour, dur: x.dur, f: 1, ramp_s: 0, pb: null, intra: null,
                     Safter: next ? next.S : null, isTest: true, label: 'T' + (k + 1) };
        });
        var tEnd = MM.min(days * 24, events[events.length - 1].tc + events[events.length - 1].dur + 24);
        var SC = {
            name: 'Synthetic sequence ' + spec.seed + ' (' + spec.path + ')', stratum: spec.fluid === 'gas' ? 'gas' : 'hom', fluid: spec.fluid,
            T0_ms: Date.UTC(2024, 6, 1) + ((spec.seed * 11) % 90) * DAY_MS, tEnd_h: tEnd,
            res: { k: t.k, h: t.h, phi: t.phi, mu: t.mu, B: t.B, ct: t.ct, rw: t.rw, C: t.C, pi: spec.pi, D: t.D || 0, model: 'homogeneous', mp: {}, mu0: t.mu, B0: t.B },
            gas: spec.gas || null, truthModel: 'homogeneous', Sgeo: 0,
            prod: { tStart_h: 0, qHist: t.q, qDay: qDay, dayShift_h: 0, dayIndex0: 0, flushPct: 15, flushDecay_h: 4 },
            events: events, S0: tests[0].S,
            sampling: (opts && opts.lite) ? { base_s: 600, dense_s: 60, burst: false } : { base_s: 300, dense_s: 60, burst: false },
            noise: { sigma: spec.sigma, sigmaFlowFactor: 3, ar1Rho: null, lf: null, quant: 0.01, spikes: 0, drift: 0, tideM2: 0, tideK1: 0 },
            extras: null, gap: null, alloc: { errPct: spec.errPct, bias: 0, ignoresShutin: false, hoursConflict_h: 0, resolution: 1 }, rateSource: 'allocation',
            given: spec.given, notAnalysable: false, Rs: 400, wc: 0.01,
            history: { mode: 'date', date: null, cum: null },
            zones: { gauge: { mode: 'utc' }, day: { zone: { mode: 'utc' }, startHour: 0 } },
            seedNoise: (spec.seed * 2246822519) >>> 0
        };
        SC.history.date = dateOf(SC.T0_ms);
        // gas: μ·ct at a mid build-up level (0.85·p_i, stated); given B, μ, ct follow the table (ct × the well's input factor)
        if (spec.fluid === 'gas') { SC._pRefEst = 0.85 * spec.pi; SC.ctFactor = spec.ctFactor || 1; }
        return SC;
    }
    function _toSequenceCase(spec, g) {
        var wo = null;
        if (spec.workover && spec.workoverEntered) wo = dateOf(g.truths[spec.workover.afterTest].tc_ms + 36 * HOUR_MS);
        return {
            spec: spec, record: g.record, allocation: { rows: g.allocation.rows }, rateTable: null, well: g.well,
            history: g.history, zones: g.zones, completion: null, workovers: wo ? [wo] : [], settings: defaultSettings(), info: g.info,
            truth: {
                path: spec.path, constantS: spec.path === 'constant' || spec.path === 'gasRate', onsetIdx: spec.onsetIdx, slopePer30d: spec.slopePer30d, step: spec.step,
                workover: spec.workover ? { afterTest: spec.workover.afterTest, entered: !!spec.workoverEntered, date: wo } : null,
                tests: g.truths.map(function (tr, k) {
                    return { id: 'T' + (k + 1), tc_ms: tr.tc_ms, k: tr.k, S: tr.S, Smech: tr.Smech, kStar: tr.kStar, SStar: tr.SStar, f: tr.f, qCorrect: tr.qCorrect, qTrue: tr.qTrue,
                             dtEnd_h: tr.dtEnd_h, dteEnd_h: tr.dteEnd_h, grade: tr.grade, reach: tr.reach,
                             tDays: (tr.tc_ms - g.truths[0].tc_ms) / DAY_MS };
                })
            }
        };
    }
    function generateSequence(seedOrSpec, opts) {
        var spec = (typeof seedOrSpec === 'number') ? sequenceFromSeed(seedOrSpec) : seedOrSpec;
        return generate(spec, opts);
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 15 — demos (oil 3301, gas 3302)
    // ═════════════════════════════════════════════════════════════════════
    // Oil: 135 days, k 45 md, h 50 ft, μ 1 cp, C 0.01 bbl/psi; 9 analysable build-ups on the skin path
    // 1.2 → 7.4 (B6 at 4.0: its excess over the delta threshold, 0.8, stays below 1, so no immediate confirmation), one 1.5 h shut-in (too short) and one 40 % partial cut; B3 closes at 15:00 on a day that
    // starts at 00:00 (the 24·V/15 example); 1 min sampling inside events and the day before, 5 min elsewhere.
    var DEMO_OIL = {
        seed: 3301, start: Date.UTC(2026, 0, 5), days: 135,
        res: { k: 45, h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, C: 0.01, pi: 4200, q: 800 },
        // [day, closing hour, duration h, skin before the closing]; the durations put every expected grade (the engine's
        // definition on the input-consistent derivative, _predictGrade) at least 0.1 from the nearest other grade (GE4):
        // B1 (168 h) good, B2–B9 fair
        tests: [[6, 9, 168, 1.2], [26, 10, 64, 1.3], [40, 15, 32, 1.1], [52, 8, 30, 1.8], [68, 9, 48, 2.9], [82, 7, 54, 4.0], [95, 10, 48, 5.9], [108, 9, 60, 6.8], [122, 8, 66, 7.4]],
        short: [33, 14, 1.5], partial: [60, 11, 24, 0.4],
        expect: { analysable: 9, tooShort: 1, partial: 1, delta: { raisedAt: 'B6', confirmedAt: 'B7' }, absolute: { raisedAt: 'B7', confirmedAt: 'B8' } }
    };
    // Gas: 8 build-ups; 6 at constant mechanical S on two rates 2.0× apart (high, low, …), D·q = 2.0 at the
    // high rate; then 2 at the high rate with the mechanical skin up by +2.5 and +5 (the excess at test 7 stays
    // below 1 on both the S′ and the mechanical basis, so the alert confirms at test 8, not immediately).
    var DEMO_GAS = {
        seed: 3302, start: Date.UTC(2026, 1, 2), days: 140,
        res: { k: 20, h: 40, phi: 0.15, rw: 0.354, C: 0.02, pi: 5200 },
        gas: { sg: 0.68, T_F: 220, co2: 2, h2s: 0, n2: 1, pseudoTime: false },
        qHigh: 10000, ratio: 2.0, DqHigh: 2.0, Smech0: 2.0, rises: [2.5, 5],
        tests: [[12, 9, 48], [28, 10, 48], [44, 9, 48], [60, 8, 48], [76, 10, 48], [92, 9, 48], [108, 9, 48], [124, 10, 48]],
        expect: { tests: 8, constantSkinTests: 6, rateRatio: 2.0, DqHigh: 2.0, delta: { raisedAt: 'B7', confirmedAt: 'B8' }, DResolved: true }
    };
    function _demoScenario(kind) {
        var D = kind === 'gas' ? DEMO_GAS : DEMO_OIL, r = rng(D.seed), i;
        var qDay = [], events = [];
        if (kind === 'oil') {
            // a smooth true rate (0.08 % decline per day, steps of about 0.4 psi): the day-to-day variation of the demo lives
            // in the 3 % allocation error, so no day boundary produces a pressure step a detector could take for a closing
            for (i = 0; i < D.days + 5; i++) qDay.push(D.res.q * (1 - 0.0008 * i));
            D.tests.forEach(function (x, k) {
                var next = D.tests[k + 1];
                events.push({ kind: 'shutin', tc: x[0] * 24 + x[1], dur: x[2], f: 1, ramp_s: 0, pb: null, intra: null, Safter: next ? next[3] : null, isTest: true, label: 'B' + (k + 1) });
            });
            events.push({ kind: 'shutin', tc: D.short[0] * 24 + D.short[1], dur: D.short[2], f: 1, ramp_s: 0, pb: null, intra: null, Safter: null, isTest: false, label: 'short' });
            events.push({ kind: 'partial', tc: D.partial[0] * 24 + D.partial[1], dur: D.partial[2], f: D.partial[3], ramp_s: 0, pb: null, intra: null, Safter: null, isTest: false, label: 'partial' });
        } else {
            var qLow = D.qHigh / D.ratio;
            for (i = 0; i < D.days + 5; i++) {
                var fac = 1;
                for (var k = 0; k < D.tests.length; k++) if (i <= D.tests[k][0]) { fac = (k < 6 && (k % 2) === 1) ? 1 / D.ratio : 1; break; }
                qDay.push(fac === 1 ? D.qHigh : qLow);
            }
            var Sm = [D.Smech0, D.Smech0, D.Smech0, D.Smech0, D.Smech0, D.Smech0, D.Smech0 + D.rises[0], D.Smech0 + D.rises[1]];
            D.tests.forEach(function (x, k) {
                events.push({ kind: 'shutin', tc: x[0] * 24 + x[1], dur: x[2], f: 1, ramp_s: 0, pb: null, intra: null, Safter: k + 1 < Sm.length ? Sm[k + 1] : null, isTest: true, label: 'B' + (k + 1) });
            });
        }
        events.sort(function (a, b) { return a.tc - b.tc; });
        var res = kind === 'gas'
            ? { k: D.res.k, h: D.res.h, phi: D.res.phi, mu: 0.02, B: 1, ct: 1e-4, rw: D.res.rw, C: D.res.C, pi: D.res.pi, D: D.DqHigh / D.qHigh, model: 'homogeneous', mp: {}, mu0: 0.02, B0: 1 }
            : { k: D.res.k, h: D.res.h, phi: D.res.phi, mu: D.res.mu, B: D.res.B, ct: D.res.ct, rw: D.res.rw, C: D.res.C, pi: D.res.pi, D: 0, model: 'homogeneous', mp: {}, mu0: D.res.mu, B0: D.res.B };
        var lastEv = events.filter(function (e) { return e.isTest; }).pop();
        var SC = {
            name: kind === 'gas' ? 'Demo gas well' : 'Demo oil well', stratum: kind === 'gas' ? 'gas' : 'hom', fluid: kind === 'gas' ? 'gas' : 'oil',
            T0_ms: D.start, tEnd_h: kind === 'oil' ? D.days * 24 : lastEv.tc + lastEv.dur + 48,
            res: res, gas: kind === 'gas' ? D.gas : null, truthModel: 'homogeneous', Sgeo: 0,
            prod: { tStart_h: 0, qHist: qDay[0], qDay: qDay, dayShift_h: 0, dayIndex0: 0, flushPct: 0, flushDecay_h: 4 },
            events: events, S0: kind === 'gas' ? D.Smech0 : D.tests[0][3],
            sampling: { base_s: 300, dense_s: 60, burst: false },
            noise: { sigma: 0.01, sigmaFlowFactor: 2, ar1Rho: null, lf: null, quant: 0.001, spikes: 0, drift: 0, tideM2: 0, tideK1: 0 },
            extras: null, gap: null, alloc: { errPct: 3, bias: 0, ignoresShutin: false, hoursConflict_h: 0, resolution: kind === 'gas' ? 1 : 1 }, rateSource: 'allocation',
            given: null, notAnalysable: false, Rs: 450, wc: 0.01,
            history: { mode: 'date', date: dateOf(D.start), cum: null },
            zones: { gauge: { mode: 'utc' }, day: { zone: { mode: 'utc' }, startHour: 0 } },
            seedNoise: D.seed
        };
        SC.given = kind === 'gas'
            ? { h: D.res.h, phi: D.res.phi, ct: null, rw: D.res.rw, B: null, mu: null }
            : { h: D.res.h, phi: D.res.phi, ct: D.res.ct, rw: D.res.rw, B: D.res.B, mu: D.res.mu };
        if (kind === 'gas') SC._pRefEst = D.res.pi - 250;   // μ·ct near the build-up average pressure (stated)
        SC.completion = { hp_ft: D.res.h, htop_ft: 0, theta_deg: 0, kvkh: [0.1, 0.5], perf: null };
        return { SC: SC, D: D };
    }
    function _fillGasGiven(SC) {   // gas: B, μ and ct follow the generator's table at the reference pressure
        if (SC.fluid !== 'gas') return;
        if (SC.given.B == null) SC.given.B = SC.res.B;
        if (SC.given.mu == null) SC.given.mu = SC.res.mu;
        if (SC.given.ct == null) SC.given.ct = SC.res.ct * (SC.ctFactor || 1);
        SC.res.B0 = SC.res.B; SC.res.mu0 = SC.res.mu;
    }
    function demoJob(kind) {
        kind = kind === 'gas' ? 'gas' : 'oil';
        var d = _demoScenario(kind), SC = d.SC, D = d.D;
        var origSetup = null; void origSetup;
        return _jobWrap(SC, {}, function (g) { return _toDemo(kind, D, SC, g); });
    }
    function _toDemo(kind, D, SC, g) {
        var tests = g.truths.map(function (tr, k) {
            return { id: 'B' + (k + 1), tc_ms: tr.tc_ms, k: tr.k, S: tr.S, Smech: tr.Smech, dtEnd_h: tr.dtEnd_h, dteEnd_h: tr.dteEnd_h, grade: tr.grade,
                     gradeMargin: tr.gradeInfo.margin, reachFair_h: tr.reach.fair_h, reachGood_h: tr.reach.good_h, reachFairShut_h: tr.reach.fairShut_h,
                     kStar: tr.kStar, SStar: tr.SStar, f: tr.f, qTrue: tr.qTrue, qCorrect: tr.qCorrect, closeHour: new Date(tr.tc_ms).getUTCHours() + new Date(tr.tc_ms).getUTCMinutes() / 60 };
        });
        var evs = SC.events.map(function (ev) {
            return { kind: ev.label === 'short' ? 'short' : ev.kind, label: ev.label, tc_ms: SC.T0_ms + MM.round(ev.tc * HOUR_MS), dur_h: ev.dur, f: ev.kind === 'partial' ? ev.f : null };
        });
        var out = {
            name: SC.name, kind: kind, seed: D.seed, record: g.record,
            allocation: { rows: g.allocation.rows, gUnit: 'Mscf', resolution: { oil: kind === 'oil' ? 1 : null, gas: kind === 'gas' ? 1 : 0.1, water: kind === 'oil' ? 1 : 0.1 } },
            rateTable: null, well: g.well, completion: g.completion, settings: defaultSettings(), history: g.history, zones: g.zones, workovers: [],
            truth: { tests: tests, events: evs, k: SC.res.k, C: SC.res.C, h: SC.res.h },
            expect: deepCopy(D.expect), info: g.info
        };
        if (kind === 'gas') {
            out.truth.D = SC.res.D; out.truth.qHigh = D.qHigh; out.truth.qLow = D.qHigh / D.ratio;
            out.truth.rateRatio = D.ratio; out.truth.DqHigh = SC.res.D * D.qHigh; out.truth.constantSkinTests = 6;
        }
        return out;
    }
    var _demoMemo = {};
    function demo(kind) {
        kind = kind === 'gas' ? 'gas' : 'oil';
        if (!_demoMemo[kind]) _demoMemo[kind] = _run(demoJob(kind));
        return deepCopy(_demoMemo[kind]);
    }
    // The plan's reference case (US4, §4.8 timings in buildup-validate.js --perf): k 45 md, S 5, C 0.02 bbl/psi, h 50 ft,
    // μ 1 cp, B 1.2, q 800 STB/d, φ 0.2, ct 1e-5 1/psi, rw 0.354 ft, p_i 4000 psia; a 72 h build-up after `days` days of
    // production (30 → t_p 720 h). opts {days = 30, variationPct = 0, rateTable = false} (365 days at ±15 % with rateTable gives
    // the 365-daily-step case: a time-stamped rate table, so day steps are rates, not candidate closings); 1 min sampling in the
    // build-up and the day before, σ 0.01 psi, exact allocation (rounded to 1 STB).
    function reference(opts) {
        opts = opts || {};
        var days = MM.max(2, MM.round(opts.days || 30)), vp = +opts.variationPct || 0, r = rng(3303), qDay = [];
        for (var i = 0; i < days + 6; i++) qDay.push(800 * (1 + (vp / 100) * clamp(r.normal(), -2, 2) / 2));
        var tc = days * 24, ev = { kind: 'shutin', tc: tc, dur: 72, f: 1, ramp_s: 0, pb: null, intra: null, Safter: null, isTest: true, label: 'B1' };
        var SC = {
            name: 'Reference case (72 h)', stratum: 'hom', fluid: 'oil', T0_ms: Date.UTC(2026, 0, 5, 12), tEnd_h: tc + 72,
            res: { k: 45, h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, C: 0.02, pi: 4000, D: 0, model: 'homogeneous', mp: {}, mu0: 1, B0: 1.2 },
            gas: null, truthModel: 'homogeneous', Sgeo: 0,
            // the record starts at 12:00 and production days at 00:00, so the closing (t_p = 24·days h) is at 12:00
            prod: { tStart_h: 0, qHist: qDay[0], qDay: qDay, dayShift_h: 12, dayIndex0: -1, flushPct: 0, flushDecay_h: 4 },
            events: [ev], S0: 5, sampling: { base_s: 300, dense_s: 60, burst: false },
            noise: { sigma: 0.01, sigmaFlowFactor: 1, ar1Rho: null, lf: null, quant: 0, spikes: 0, drift: 0, tideM2: 0, tideK1: 0 },
            extras: null, gap: null, alloc: { errPct: 0, bias: 0, ignoresShutin: false, hoursConflict_h: 0, resolution: 1 }, rateSource: opts.rateTable ? 'table' : 'allocation',
            given: { h: 50, phi: 0.2, ct: 1e-5, rw: 0.354, B: 1.2, mu: 1 }, notAnalysable: false, Rs: 450, wc: 0.01,
            history: { mode: 'date', date: dateOf(Date.UTC(2026, 0, 5, 12)), cum: null },
            zones: { gauge: { mode: 'utc' }, day: { zone: { mode: 'utc' }, startHour: 0 } }, seedNoise: 3303,
            completion: { hp_ft: 50, htop_ft: 0, theta_deg: 0, kvkh: [0.1, 0.5], perf: null }
        };
        var g = _run(_jobWrap(SC, {}, function (x) { return x; })), tr = g.truths[0];
        return {
            name: SC.name, record: g.record, allocation: { rows: g.allocation.rows, gUnit: 'Mscf', resolution: { oil: 1, gas: 0.1, water: 1 } }, rateTable: g.rateTable || null,
            well: g.well, completion: g.completion, settings: defaultSettings(), history: g.history, zones: g.zones, workovers: [],
            truth: { tests: [{ id: 'B1', tc_ms: tr.tc_ms, k: tr.k, S: tr.S, kStar: tr.kStar, SStar: tr.SStar, dtEnd_h: tr.dtEnd_h, grade: tr.grade, reach: tr.reach }] },
            info: g.info
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 16 — settings, AnalysisInput, IN_APP
    // ═════════════════════════════════════════════════════════════════════
    function defaultSettings() {
        return {
            detect: { winMin: 5, riseMin: 5, riseSig: 10, persistMin: 30, minDur_h: 2, gapN: 5, spike: 'off', partial: true },
            interp: { Lcyc: 0.1, band: 0.10, slope: 0.03, minCycles: 0.5, rivals: 'auto', cheld: 'auto', kHeld: 'auto', tide: 'auto' },
            trend: { baseN: 3, delta: 2, abs: 5, basevar: false, confirm: 'next', price: null, enabled: 'auto' },
            report: { detail: 'selected' }
        };
    }
    // SynthCase / sequence / demo → AnalysisInput (§3.7). The record is passed as generated (typed arrays).
    function toInput(sc, opts) {
        opts = opts || {};
        var rows = (sc.allocation && sc.allocation.rows) || [];
        // volume resolution of each column as the generator rounds it (_allocation): the main phase to spec.alloc.resolution
        // (sequences 1); oil wells' gas column to 0.1, gas wells' water column to 0.1
        var vr = (sc.spec && sc.spec.alloc) ? sc.spec.alloc.resolution : 1, fl = sc.well ? sc.well.fluid : 'oil';
        var res = (sc.allocation && sc.allocation.resolution) ||
            (fl === 'gas' ? { oil: null, gas: vr, water: 0.1 } : fl === 'water_inj' ? { oil: null, gas: null, water: vr } : { oil: vr, gas: 0.1, water: vr });
        var appV = '';
        try { if (typeof G.WTS_appVersion === 'function') appV = String(G.WTS_appVersion() || ''); } catch (e) { appV = ''; }
        return {
            record: sc.record, stored: null,
            allocation: (rows.length && !sc.rateTable) ? { rows: rows, gUnit: 'Mscf', resolution: res } : null,
            rateTable: sc.rateTable || null,
            well: deepCopy(sc.well), completion: sc.completion ? deepCopy(sc.completion) : null, depth: null,
            history: deepCopy(sc.history), zones: deepCopy(sc.zones), settings: deepCopy(sc.settings || defaultSettings()),
            overrides: [], workovers: (sc.workovers || []).slice(), meta: { wellName: sc.name || (sc.record && sc.record.name) || 'Synthetic well', engineer: '', appVersion: opts.appVersion || appV }
        };
    }
    // 24 in-app validation cases (lite: 60 s sampling, ≤ 30 days). Provisional selection covering the strata;
    // once file 55 is calibrated, IN_APP follows its inApp list (WP8 selects seeds with margin ≥ 0.1).
    var IN_APP_DEFAULT = [
        [100003, 'hom'], [100017, 'hom'], [100041, 'hom'], [100088, 'hom'], [100120, 'hom'], [100160, 'hom'], [100205, 'hom'],
        [100236, 'fault'], [100270, 'fault'], [100300, 'comp'], [100340, 'comp'], [100360, 'closed'], [100380, 'closed'],
        [100400, 'gas'], [100430, 'gas'], [100460, 'gas'], [100470, 'inj'], [100485, 'inj'], [100500, 'dualpor'], [100530, 'channel'],
        [100555, 'wbschange'], [100598, 'constp'], [100620, 'partial'], [100630, 'baddata']
    ].map(function (e) { return { seed: e[0], stratum: e[1], lite: true }; });
    // A calibrated file 55 is authoritative for the list, whatever its length (buildup-validate.js --write refuses to
    // write calibrated:true unless all 24 cases meet the margin), so the page and file 55 always agree.
    function inAppList() {
        var cal = G.PRiSM_autoInterpCal;
        if (cal && cal.calibrated && Array.isArray(cal.inApp) && cal.inApp.length) {
            return cal.inApp.map(function (c) { return { seed: c.seed, stratum: c.stratum, lite: true }; });
        }
        return IN_APP_DEFAULT.map(function (c) { return { seed: c.seed, stratum: c.stratum, lite: true }; });
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 17 — matching and scoring (§5.3); never reads the engine's Δq for the outcome
    // ═════════════════════════════════════════════════════════════════════
    var RIVAL_LABEL = { fault: 'Sealing fault', composite: 'Radial composite', closed: 'Closed circle' };
    // nearest event / test of an Analysis to the truth closing time (within 1 h)
    function match(analysis, truth, opts) {
        var tol = ((opts && opts.tol_h) || 1) * HOUR_MS, ev = null, test = null, best = Infinity, i;
        var evs = (analysis && analysis.events) || [], tests = (analysis && analysis.tests) || [];
        for (i = 0; i < evs.length; i++) { var d = MM.abs(evs[i].tc_ms - truth.tc_ms); if (d < best && d <= tol) { best = d; ev = evs[i]; } }
        if (ev) { for (i = 0; i < tests.length; i++) if (tests[i].eventId === ev.id) test = tests[i]; }
        if (!test) { best = Infinity; for (i = 0; i < tests.length; i++) { var d2 = MM.abs(tests[i].tc_ms - truth.tc_ms); if (d2 < best && d2 <= tol) { best = d2; test = tests[i]; } } }
        return { event: ev, test: test };
    }
    function _status(test, ev) {
        if (test) return test.status;
        if (ev) {
            if (ev.kind === 'partial' || ev.status === 'partial') return 'partial';
            if (ev.status === 'too_short' || ev.status === 'gap_at_closing') return 'not_analysable';
            return ev.status;
        }
        return 'missed';
    }
    function score(test, truth, opts) {
        opts = opts || {};
        var ev = opts.event || null, st = _status(test, ev), r = test && test.result ? test.result : null;
        var label = (r && r.confidence) ? { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline } : null;
        var analysableTruth = !truth.notAnalysable && !truth.partial;
        var statusRight = truth.partial ? st === 'partial' : (truth.notAnalysable ? (st === 'not_analysable' || st === 'missed') : st === 'interpreted');
        var out = { matched: !!(test || ev), status: st, abstained: false, fullyRight: false, ksRight: false, kRight: false, sRight: false, modelRight: false, strict: false,
                    falseSeen: false, distractorCaught: null, dkPct: null, dS: null, rateErrPct: null, label: label };
        if (test && isFinite(test.Dq) && truth.qCorrect > 0) out.rateErrPct = fin(100 * (test.Dq / truth.qCorrect - 1));   // rate-accuracy table only
        if (!analysableTruth) {
            out.kRight = out.sRight = out.ksRight = out.modelRight = statusRight;
            out.fullyRight = out.strict = statusRight;
            return out;
        }
        var fin1 = r && r.final ? r.final : null;
        var kHat = fin1 ? fin(fin1.k) : null;
        var sHat = fin1 ? fin((fin1.gas && isFinite(fin1.gas.Sprime)) ? fin1.gas.Sprime : fin1.S) : null;
        if (st !== 'interpreted' || kHat === null || sHat === null) { out.abstained = true; return out; }
        out.dkPct = fin(100 * (kHat / truth.kStar - 1));
        out.dS = fin(sHat - truth.SStar);
        out.kRight = MM.abs(kHat / truth.kStar - 1) <= 0.10;
        out.sRight = MM.abs(sHat - truth.SStar) <= 0.5;
        out.ksRight = out.kRight && out.sRight && statusRight;
        var chosen = r.chosen || {}, lbl = chosen.label || '', seen = chosen.fullySeen ? chosen.fullySeen.status : 'n/a';
        var flags = (r.flags || []).length > 0, fired = r.triggers && r.triggers.fired && r.triggers.fired.length > 0;
        var anomaly = flags || fired || (lbl && lbl !== 'Homogeneous');
        var tm = truth.model, vis = truth.visible || {};
        var rivalTruth = (tm === 'fault' || tm === 'composite' || tm === 'closed');
        var visibleRival = (tm === 'fault' && vis.fault) || (tm === 'composite' && vis.comp) || (tm === 'closed' && vis.closed);
        var isDistractor = !!truth.distractor || DISTRACTORS.indexOf(truth.stratum) !== -1;
        if (tm === 'homogeneous') out.modelRight = lbl === 'Homogeneous';
        else if (rivalTruth) out.modelRight = visibleRival ? lbl === RIVAL_LABEL[tm] : (lbl === 'Homogeneous' || lbl === RIVAL_LABEL[tm]);
        else if (isDistractor) {
            out.modelRight = vis.distractor ? anomaly : lbl === 'Homogeneous';
            out.distractorCaught = vis.distractor ? !!(flags || fired) : null;
        } else out.modelRight = lbl === 'Homogeneous';
        if (tm === 'constp' && lbl === 'Closed circle' && seen === 'full') out.modelRight = false;
        // false "fully seen": a rival reported fully seen that the truth does not show
        if (lbl && lbl !== 'Homogeneous' && seen === 'full') out.falseSeen = !(rivalTruth && visibleRival && lbl === RIVAL_LABEL[tm]);
        out.fullyRight = out.ksRight && out.modelRight && !out.falseSeen;
        out.strict = out.fullyRight && MM.abs(kHat / truth.kStar - 1) <= 0.05 && MM.abs(sHat - truth.SStar) <= 0.3;
        return out;
    }
    function scoreAnalysis(analysis, synthCase, opts) {
        var m = match(analysis, synthCase.truth, opts);
        var s = score(m.test, synthCase.truth, { event: m.event });
        return { score: s, test: m.test, event: m.event };
    }

    // ═════════════════════════════════════════════════════════════════════
    // exports
    // ═════════════════════════════════════════════════════════════════════
    SY.version = VERSION;
    SY.rng = rng;
    SY.pwd = pwd;
    SY.pwdPrime = pwdPrime;
    SY.caseFromSeed = caseFromSeed;
    SY.generate = generate;
    SY.generateJob = generateJob;
    SY.sequenceFromSeed = sequenceFromSeed;
    SY.generateSequence = generateSequence;
    SY.demo = demo;
    SY.demoJob = demoJob;
    SY.reference = reference;
    SY.toInput = toInput;
    SY.defaultSettings = defaultSettings;
    SY.match = match;
    SY.score = score;
    SY.scoreAnalysis = scoreAnalysis;
    SY.inAppList = inAppList;
    SY.unmodelledEffects = unmodelledEffects;
    SY.unmodelledShare = unmodelledShare;
    SY.LITE = LITE;
    SY.SEED_TABLE = SEED_TABLE.map(function (e) { return { stratum: e.stratum, n: e.n, from: e.from, to: e.to }; });
    SY.SEQUENCES = { from: SEQ0, to: SEQ0 + N_SEQ - 1, paths: SEQ_PATHS.map(function (p) { return { path: p[0], n: p[1] }; }) };
    SY.RANGES = deepCopy(RANGES);
    SY.DISTRACTORS = DISTRACTORS.slice();
    SY.DEMOS = { oil: deepCopy(DEMO_OIL), gas: deepCopy(DEMO_GAS) };
    SY.special = { besselKe: function (x) { besselKe(x); return [_K[0], _K[1]]; }, besselIe: function (x) { besselIe(x); return [_I[0], _I[1]]; },
                   E1: expE1, intK0: intK0, sumK0n: function (x) { return sumK0n(x, 0); }, sumK0shift: function (x, a) { return sumK0shift(x, a, 0); },
                   stehfestWeights: stehfestWeights, gasPVT: gasPVT };
    SY.UNIT = { fwd: UNIT_FWD, grid: UNIT_GRID, fin: UNIT_FIN, maxSamples: MAX_SAMPLES };
    Object.defineProperty(SY, 'IN_APP', { enumerable: true, get: inAppList });
    BU.synth = SY;
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var SY = G.WTS_buildup && G.WTS_buildup.synth;
    if (!SY) return;
    var fails = [];
    function near(a, b, tol, what) { if (!(Math.abs(a - b) <= tol)) fails.push(what + ': ' + a + ' vs ' + b); }
    var k = SY.special.besselKe(1); near(k[0] * Math.exp(-1), 0.4210244382, 1e-9, 'K0(1)'); near(k[1] * Math.exp(-1), 0.6019072302, 1e-9, 'K1(1)');
    k = SY.special.besselKe(10); near(k[0] * Math.exp(-10), 1.778006232e-5, 1e-13, 'K0(10)');
    var i = SY.special.besselIe(1); near(i[0] * Math.exp(1), 1.266065878, 1e-8, 'I0(1)');
    near(SY.special.E1(1), 0.2193839344, 1e-10, 'E1(1)');
    near(SY.special.intK0(50), Math.PI / 2, 1e-12, '∫K0 → π/2');
    var a = SY.rng(42), b = SY.rng(42); for (var n = 0; n < 5; n++) if (a.next() !== b.next()) fails.push('rng repeatability');
    var p = SY.pwd('homogeneous', { Cd: 0, S: 0 }, [1e6])[0]; near(p, 0.5 * (Math.log(1e6) + 0.80907), 1e-3, 'IARF asymptote');
    if (fails.length) console.warn('[49-calc-buildup-synth self-test] ' + fails.join('; '));
    else console.log('[49-calc-buildup-synth self-test] ok');
})();
