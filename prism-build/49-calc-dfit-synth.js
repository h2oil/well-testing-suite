// =============================================================================
// WTS — 49-calc-dfit-synth.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// Synthetic DFIT generator and scorer: window.PRiSM_dfit_synth (docs/DFIT-PLAN.md §3.9, §8.1–§8.3; owner WP5).
// Pure and seeded: no DOM, storage, timers or events; randomness only from PRiSM_rng(seed) (05, resolved at call time; the
// identical mulberry32 stream is used when 05 is absent, so a case never depends on the load order). Field units, time in
// hours, rates in bbl/min inside the generator (bbl/d in the dataset, §3.0).
//
//   version 'g1'
//   make(caseSpec, seed)   → {ok:true, ds, truth, artefacts, caseSpec} | failure        (ds in the §3.1 format)
//   demo(name)             → ds | failure      'reference' | 'tight-linear' | 'conventional-radial' | 'contact' | 'pdl' |
//                                               'surface-gauge' | 'two-cycle'
//   demoSpec(name)         → {spec, seed} (the case behind a demo; make(spec, seed).truth is its truth)
//   demoCsv(name), toCsv(ds) → role-header CSV text (time_h, pressure_psia, rate_bbl_d, pressure_surf_psia, …) for the Data tab
//   cases(kind)            → [CaseSpec]        'integration' (3) | 'quick' (12) | 'benchmark' (900) | 'artefact' (60)
//   score(run, truth)      → {closure, isip, classify, pi, k, regime, frac, labels}   (§8.3)
//   acaExact(aca, tInj, o) → {ok, dp, D, sD, t0}  exact convolution of a Carter source (§4.12 kernels; independent of 57)
//   kernel(geometry, aca)  → K(s) psi per bbl (impulse kernels: 'full' uniform-flux full height, 'penny', 'box')
//   artefacts              → {kind: {target, stage, levels, apply}} — the injectors (§8.1); inject(ds, art, ctx, seed)
//   inputsFor(spec, made), wellFor(spec, made) → DfitInputs (through PRiSM_dfit_inputRanges, call time) / a C1-like well
//   classOf(mechanism), g / G / Ginv (α = ½ and 1)
//
// Sources (§8.1): 'lk' calls PRiSM_dfit_lkSimulate (58) at call time (failure LK_UNAVAILABLE until it exists); 'gdomain'
// integrates the variable-compliance G-domain decline (normal, matrix, PDL, storage, tip extension, height recession: hard
// closure, then the exact after-closure convolution with k chosen for continuity; asperity contact hyp/exp: the damped
// G-domain model throughout); 'aca-exact' is the closed-form Carter-source convolution (examples A and B, penny, box) after
// a normal G-line falloff to the continuity closure p_i + Δp(t_c).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var S = G.PRiSM_dfit_synth = G.PRiSM_dfit_synth || {};   // merge, never replace
    S.version = 'g1';

    var BBL = 5.614583;              // ft³ per bbl
    var ETA_C = 2.63679e-4;          // η = ETA_C·k/(φμc_t) ft²/h
    var ATM = 14.696;
    var PI = Math.PI, SQRTPI = Math.sqrt(Math.PI);
    var GRAD_W = 8.43 * 0.052;       // psi/ft, 8.43 ppg column
    var MAX_PTS = 4000;

    // ═════════════════════════════════════════════════════════════════════════
    // 1. Small helpers
    // ═════════════════════════════════════════════════════════════════════════
    function fin(x) { return typeof x === 'number' && isFinite(x); }
    function pos(x) { return fin(x) && x > 0; }
    function num(x, d) { return fin(x) ? x : d; }
    function rnd(x, d) { var m = Math.pow(10, d); return Math.round(x * m) / m; }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function fail(code, msg, bad) { return { ok: false, code: code, errors: [String(msg)], bad: bad || [] }; }
    function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function merge(dst, src) {
        if (!isObj(src)) return dst;
        Object.keys(src).forEach(function (k) {
            if (isObj(src[k]) && isObj(dst[k])) merge(dst[k], src[k]);
            else dst[k] = clone(src[k]);
        });
        return dst;
    }
    function seedOf(s) { s = Math.round(+s); return (fin(s) && s >= 1 && s <= 2147483647) ? s : 1; }
    // independent sub-streams: one per purpose and artefact index
    function subSeed(seed, k) {
        var h = (Math.imul(seedOf(seed), 2654435761) ^ Math.imul(k + 1, 40503)) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
        return (h % 2147483646) + 1;
    }
    function rng(seed) {
        var s = seedOf(seed);
        if (typeof G.PRiSM_rng === 'function') { try { var r = G.PRiSM_rng(s); if (typeof r === 'function') return r; } catch (e) { /* fall back */ } }
        var a = s | 0;   // the 05 mulberry32 stream (PRiSM_rng → _makeRng)
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
        };
    }
    function gauss(r) { var u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * PI * r()); }
    function interpLin(xs, ys, x) {
        var n = xs.length;
        if (!n) return NaN;
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
        var f = (x - xs[lo]) / (xs[hi] - xs[lo]);
        return ys[lo] + f * (ys[hi] - ys[lo]);
    }
    function bisect(fn, lo, hi, it) {           // root of a monotone fn on [lo, hi]
        var flo = fn(lo);
        for (var i = 0; i < (it || 80); i++) {
            var m = 0.5 * (lo + hi), fm = fn(m);
            if ((fm < 0) === (flo < 0)) { lo = m; flo = fm; } else hi = m;
        }
        return 0.5 * (lo + hi);
    }

    // erf to ~1e-15 (series below 2.5, continued fraction above)
    function erf(x) {
        var s = x < 0 ? -1 : 1; x = Math.abs(x);
        if (x > 6) return s;
        if (x < 2.5) {
            var sum = x, term = x, x2 = x * x, n = 0;
            while (Math.abs(term) > 1e-17 * Math.abs(sum) && n < 300) { n++; term *= -x2 / n; sum += term / (2 * n + 1); }
            return s * 2 / SQRTPI * sum;
        }
        var t = 0;
        for (var k = 60; k >= 1; k--) t = k / 2 / (x + t);
        return s * (1 - Math.exp(-x * x) / SQRTPI / (x + t));
    }

    // 12-point Gauss–Legendre on [-1, 1]
    var GLX = [-0.9815606342467192, -0.9041172563704749, -0.7699026741943047, -0.5873179542866175, -0.3678314989981802, -0.1252334085114689,
        0.1252334085114689, 0.3678314989981802, 0.5873179542866175, 0.7699026741943047, 0.9041172563704749, 0.9815606342467192];
    var GLW = [0.0471753363865118, 0.1069393259953184, 0.1600783285433462, 0.2031674267230659, 0.2334925365383548, 0.2491470458134028,
        0.2491470458134028, 0.2334925365383548, 0.2031674267230659, 0.1600783285433462, 0.1069393259953184, 0.0471753363865118];

    // ═════════════════════════════════════════════════════════════════════════
    // 2. G-function (§4.5; α = ½ and α = 1 closed forms — the generator's own copy)
    // ═════════════════════════════════════════════════════════════════════════
    function gFn(d, a) { return a === 1 ? 4 / 3 * (Math.pow(1 + d, 1.5) - Math.pow(d, 1.5)) : (1 + d) * Math.asin(1 / Math.sqrt(1 + d)) + Math.sqrt(d); }
    function GFn(d, a) { return 4 / PI * (gFn(d, a) - (a === 1 ? 4 / 3 : PI / 2)); }
    function GinvFn(Gv, a) {
        if (!(Gv > 0)) return 0;
        var lo = Math.log(1e-12), hi = Math.log(1e9);
        for (var i = 0; i < 90; i++) { var m = 0.5 * (lo + hi); if (GFn(Math.exp(m), a) < Gv) lo = m; else hi = m; }
        return Math.exp(0.5 * (lo + hi));
    }
    S.g = gFn; S.G = GFn; S.Ginv = GinvFn;

    // ═════════════════════════════════════════════════════════════════════════
    // 3. Impulse kernels and the exact Carter-source convolution (§4.12; independent of 57)
    // ═════════════════════════════════════════════════════════════════════════
    // aca: {k md, L ft (half-length or penny radius), h ft (zone height, 'full'), hf ft (box height), phi, ct 1/psi, mu cp}
    function kernel(geometry, aca) {
        var eta = ETA_C * aca.k / (aca.phi * aca.mu * aca.ct);
        var L = aca.L, base = BBL / (aca.phi * aca.ct);
        if (geometry === 'penny') {
            var R2 = L * L;
            return function (s) { var f = 4 * eta * s; return base * (1 - Math.exp(-R2 / f)) / (PI * R2 * Math.sqrt(PI * f)); };
        }
        if (geometry === 'box') {
            var hb = pos(aca.hf) ? aca.hf : aca.h;
            return function (s) { var r = Math.sqrt(4 * eta * s); return base * erf(L / r) / (2 * L) * erf(0.5 * hb / r) / hb / Math.sqrt(PI) / r; };
        }
        var h = aca.h;
        return function (s) { var r = Math.sqrt(4 * eta * s); return base / h * erf(L / r) / (2 * L * SQRTPI * r); };
    }
    S.kernel = function (geometry, aca) { return kernel(geometry || 'full', aca); };

    // Δp(t) for a Carter source (rate ∝ τ^-½ on 0 < τ < t_c, volume V) on the injection clock, t ≥ t_c.
    // τ = t_c·cos²φ: Δp = V·∫₀^{π/2} K((t − t_c) + t_c·sin²φ)·sin φ dφ, graded panels near φ = 0 (the near-singular end).
    function convAt(K, V, tc, t) {
        var e = Math.max(0, t - tc), rt = Math.sqrt(e / tc);
        var edges = [0];
        if (rt < 0.3) {
            var ph = Math.max(rt / 4, 1e-7);
            edges.push(ph);
            while (ph * 2 < PI / 2) { ph *= 2; edges.push(ph); }
        } else { edges.push(PI / 6); edges.push(PI / 3); }
        edges.push(PI / 2);
        var sum = 0;
        for (var i = 0; i < edges.length - 1; i++) {
            var a = edges[i], b = edges[i + 1], hw = 0.5 * (b - a), c = 0.5 * (a + b);
            for (var j = 0; j < 12; j++) {
                var ph2 = c + hw * GLX[j], sp = Math.sin(ph2);
                var s = e + tc * sp * sp;
                if (s > 0) sum += GLW[j] * hw * K(s) * sp;
            }
        }
        return V * sum;
    }
    // aca: {k, L, h, phi, ct, mu, V bbl, tcInj h, pi, geometry?, hf?}; tInj: times on the injection clock (≥ t_c).
    // opts {geometry, t0 (origin for D; default t_c/3), dlnStep}. D = |dΔp/d ln(t − t0)|, sD = d ln D / d ln(t − t0).
    function acaExact(aca, tInj, opts) {
        opts = opts || {};
        if (!isObj(aca)) return fail('BAD_INPUT', 'acaExact needs the aca block', ['aca']);
        var bad = ['k', 'L', 'phi', 'ct', 'mu', 'V', 'tcInj'].filter(function (k) { return !pos(aca[k]); });
        var geo = opts.geometry || aca.geometry || 'full';
        if (geo === 'full' && !pos(aca.h)) bad.push('h');
        if (bad.length) return fail('BAD_INPUT', 'acaExact: missing or non-positive ' + bad.join(', '), bad);
        var K = kernel(geo, aca), tc = aca.tcInj, V = aca.V;
        var t0 = fin(opts.t0) ? opts.t0 : tc / 3;
        var dp = [], D = [], sD = [], i;
        for (i = 0; i < tInj.length; i++) {
            var t = tInj[i];
            if (!(t >= tc)) { dp.push(null); D.push(null); sD.push(null); continue; }
            var x = t - t0, d0 = convAt(K, V, tc, t);
            dp.push(d0);
            if (t - tc <= 0 || !(x > 0)) { D.push(null); sD.push(null); continue; }
            var hstep = Math.min(1e-4 * (t - tc), 1e-4 * x);
            var dpdt = (convAt(K, V, tc, t + hstep) - convAt(K, V, tc, t - hstep)) / (2 * hstep);
            D.push(Math.abs(dpdt) * x);
            // local slope of D over ±0.05 in ln x
            var xl = x * Math.exp(-0.05), xh = x * Math.exp(0.05);
            if (xl + t0 > tc * (1 + 1e-6)) {
                var Dl = derivD(K, V, tc, xl + t0, xl), Dh = derivD(K, V, tc, xh + t0, xh);
                sD.push(Dl > 0 && Dh > 0 ? (Math.log(Dh) - Math.log(Dl)) / 0.1 : null);
            } else sD.push(null);
        }
        return { ok: true, geometry: geo, t0: t0, dp: dp, D: D, sD: sD };
    }
    function derivD(K, V, tc, t, x) {
        var hstep = Math.min(1e-4 * (t - tc), 1e-4 * x);
        return Math.abs((convAt(K, V, tc, t + hstep) - convAt(K, V, tc, t - hstep)) / (2 * hstep)) * x;
    }
    S.acaExact = acaExact;
    function regimeFromSD(s) {
        if (!fin(s)) return null;
        if (Math.abs(s + 0.5) <= 0.07) return 'linear';
        if (Math.abs(s + 0.75) <= 0.07) return 'bilinear';
        if (Math.abs(s + 1) <= 0.07) return 'radial';
        if (Math.abs(s + 1.5) <= 0.1) return 'spherical';
        if (s < -1.6) return 'artefact';
        return 'transition';
    }
    S.regimeFromSD = regimeFromSD;

    // ═════════════════════════════════════════════════════════════════════════
    // 4. Case defaults (the §4.21 reference well)
    // ═════════════════════════════════════════════════════════════════════════
    var REF = {
        datumTvd: 10000, rhoPpg: 8.43, idIn: 4.778, odIn: 5.5, wallIn: 0.361, nPerf: 12, dPerf: 0.40, cdPerf: 0.6,
        q: 5, Vstar: 25, tStartH: 2 / 60, pStart: 4500, isip: 7600, sigmaC: 7000, Gc: 18, Ep: 5.0e6, nu: 0.25, hf: 50, hp: 40,
        pr: 4500, phi: 0.06, ct: 1e-5, mu: 0.5, VwCw: 7.91e-4, nwbA: 1.505, nwbB: 140.9, bdOver: 235, tauBdMin: 0.25,
        sigmaGauge: 0.0029, quantum: 0.01, tEndShutH: 72
    };
    S.REF = REF;
    function nwb(gd, q) { return q > 0 ? gd.nwbA * q * q + gd.nwbB * Math.sqrt(q) : 0; }

    // gdomain parameter block (CaseSpec extra key `gd`; every field optional)
    function gdDefaults() {
        return {
            mechanism: 'normal', isip: REF.isip, sigmaC: REF.sigmaC, pr: REF.pr, pStart: null, Gc: REF.Gc, alpha: 0.5,
            AfCf: null, Rvis: null, VwCw: null, q: REF.q, Vstar: null, tStartH: REF.tStartH, stepDown: null,
            nwbA: REF.nwbA, nwbB: REF.nwbB, bdOver: REF.bdOver,
            Ep: REF.Ep, hf: REF.hf, hp: REF.hp, geometry: 'PKN', phi: REF.phi, ct: REF.ct, mu: REF.mu, k: null, kSolve: 'k',
            matrixN: 1, Cd: 0, pfo: null, tipFrac: 0.6, tipG: 3, hrRs: 2.5, hrP: null, hrW: 40,
            law: 'none', sh: 60, sc: 100, fres: 0.1, sr: null, cwFrac: 0.9
        };
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 5. gdomain: the variable-compliance decline integrated in G (§4.7 model; §8.1)
    // ═════════════════════════════════════════════════════════════════════════
    // C(p) [bbl/psi] = A_f·c_f(p) + V_w·c_w(p); dp/dG = −X·f_L(p)·f_PDL(p)·(1 + tip(G))/C(p).
    function gdModel(gd, VwCw0, cwOfP) {
        var mech = gd.mechanism, isip = gd.isip, sc = gd.sigmaC, pr = gd.pr;
        var pn = isip - sc, AfCf;
        if (pos(gd.AfCf)) AfCf = gd.AfCf;
        else if (pos(gd.Rvis) && gd.Rvis < 1) AfCf = VwCw0 * gd.Rvis / (1 - gd.Rvis);
        else AfCf = 0.2061 / BBL;                                     // the reference A_f·c_f (0.2061 ft³/psi)
        if (pos(gd.Rvis) && gd.Rvis < 1 && pos(gd.AfCf)) VwCw0 = AfCf * (1 / gd.Rvis - 1);
        var gas = cwOfP === 'gas' || cwOfP === 'air';
        function vwcw(p) { return gas ? VwCw0 * ((1 - gd.cwFrac) + gd.cwFrac * sc / Math.max(p, 50)) : VwCw0; }
        var contact = (gd.law === 'hyp' || gd.law === 'exp') || mech === 'contact-hyp' || mech === 'contact-exp';
        var law = mech === 'contact-hyp' ? 'hyp' : mech === 'contact-exp' ? 'exp' : gd.law;
        var hrP = fin(gd.hrP) ? gd.hrP : sc + 0.5 * pn;
        function cfRatio(p) {                                         // fracture compliance / open compliance
            var r = 1;
            if (mech === 'height-recession') r *= 1 - (1 - 1 / gd.hrRs) / (1 + Math.exp(-(hrP - p) / gd.hrW));
            if (contact && p < sc) {
                var x = sc - p;
                if (law === 'hyp') r *= Math.pow(gd.sh / (gd.sh + x), 2);
                else { var sr = pos(gd.sr) ? gd.sr : 10 * gd.sc; r *= gd.fres * Math.exp(-x / sr) + (1 - gd.fres) * Math.exp(-x / gd.sc); }
            }
            return r;
        }
        function C(p) { return AfCf * cfRatio(p) + vwcw(p); }
        var Cnom = AfCf + VwCw0;
        var X = Cnom * pn / gd.Gc;                                    // nominal: a normal case closes at Gc
        var pfo = fin(gd.pfo) ? gd.pfo : isip - 350;
        function rhs(p, Gv) {
            var f = 1;
            if (mech === 'matrix') f *= Math.pow(Math.max(0, (p - pr) / (isip - pr)), gd.matrixN);
            if ((mech === 'pdl' || gd.Cd > 0) && p > pfo) f *= Math.exp(gd.Cd * (p - pfo));
            if (contact && p < sc) f *= Math.max(0, (p - pr) / (sc - pr));
            if (mech === 'tip') f *= 1 + gd.tipFrac * Math.exp(-Gv / gd.tipG);
            return -X * f / C(p);
        }
        return { AfCf: AfCf, VwCw0: VwCw0, vwcw: vwcw, C: C, X: X, rhs: rhs, contact: contact, law: law, cfRatio: cfRatio, hrP: hrP, pfo: pfo };
    }
    // integrate p(G) from ISIP; hard closure stops at σ_c. → {G:[], p:[], Gc|null}
    function gdIntegrate(gd, M, Gmax) {
        var N = 6000, dG = Gmax / N, Gs = [0], ps = [gd.isip], p = gd.isip, Gc = null;
        for (var i = 0; i < N; i++) {
            var g0 = i * dG;
            var k1 = M.rhs(p, g0), k2 = M.rhs(p + 0.5 * dG * k1, g0 + 0.5 * dG), k3 = M.rhs(p + 0.5 * dG * k2, g0 + 0.5 * dG), k4 = M.rhs(p + dG * k3, g0 + dG);
            var pn = p + dG / 6 * (k1 + 2 * k2 + 2 * k3 + k4);
            if (!M.contact && pn <= gd.sigmaC) {
                var f = (p - gd.sigmaC) / (p - pn);
                Gc = g0 + f * dG;
                Gs.push(Gc); ps.push(gd.sigmaC);
                return { G: Gs, p: ps, Gc: Gc };
            }
            p = pn; Gs.push(g0 + dG); ps.push(p);
        }
        return { G: Gs, p: ps, Gc: null };
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 6. Record assembly: schedule, pumping pressure, sampling grid
    // ═════════════════════════════════════════════════════════════════════════
    // segments of the injection schedule in h from pump start: [{t0, t1, q}]
    function buildSchedule(qMain, Vi, stepDown) {
        var steps = [], Vsd = 0, dts = 0;
        if (stepDown && Array.isArray(stepDown.rates) && stepDown.rates.length) {
            dts = (pos(stepDown.dtS) ? stepDown.dtS : 10) / 3600;
            stepDown.rates.forEach(function (r) { if (pos(r)) { steps.push(r); Vsd += r * dts * 60; } });
        }
        var tMain = Math.max(0.2 * Vi, Vi - Vsd) / qMain / 60;      // h
        var seg = [{ t0: 0, t1: tMain, q: qMain }], t = tMain;
        steps.forEach(function (r) { seg.push({ t0: t, t1: t + dts, q: r }); t += dts; });
        return { seg: seg, tp: t, Vi: qMain * tMain * 60 + Vsd };
    }
    function qAt(seg, tInj) { for (var i = 0; i < seg.length; i++) if (tInj >= seg[i].t0 && tInj < seg[i].t1) return seg[i].q; return 0; }
    // pumping-phase pressure (gdomain / aca-exact): wellbore ramp, breakdown, decay onto the propagation line + near-wellbore loss
    function pumpModel(gd, sch, pStart, VwCw) {
        var tp = sch.tp, q0 = sch.seg[0].q;
        var pProp0 = gd.isip - 20, isip = gd.isip;
        var pb = isip + nwb(gd, q0) + gd.bdOver;
        var slope = q0 / VwCw * 60;                                   // psi/h
        var tRamp = (pb - pStart) / slope, scaled = false;
        if (tRamp > 0.5 * tp) { tRamp = 0.5 * tp; slope = (pb - pStart) / tRamp; scaled = true; }
        var tau = (gd.tauBdMin || REF.tauBdMin) / 60;
        function pFrac(tInj) { return pProp0 + (isip - pProp0) * Math.min(1, Math.max(0, (tInj - tRamp) / Math.max(1e-9, tp - tRamp))); }
        function p(tInj) {
            if (tInj <= 0) return pStart;
            if (tInj <= tRamp) return pStart + slope * tInj;
            var q = qAt(sch.seg, Math.min(tInj, tp - 1e-12));
            var target = pFrac(tInj) + nwb(gd, q), target0 = pFrac(tInj) + nwb(gd, q0);
            return target + (pb - target0) * Math.exp(-(tInj - tRamp) / tau);
        }
        return { p: p, tb: tRamp, pb: pb, rampSlopePsiMin: slope / 60, rampScaled: scaled };
    }
    // sampling grid (record clock): static samples, pumping at dtS, falloff uniform at dtS then log-spaced
    function sampleGrid(tStart, ts, tEndRec, dtS, perDecade) {
        var t = [], i;
        for (i = 0; i < 10; i++) t.push(i * tStart / 10);
        var dth = dtS / 3600;
        for (i = 0; tStart + i * dth < ts - 1e-12; i++) t.push(tStart + i * dth);
        var dtEnd = tEndRec - ts, step0 = dth, d = dth, f = Math.pow(10, 1 / perDecade) - 1;
        while (d < dtEnd) { t.push(ts + d); d += Math.max(step0, d * f); }
        t.push(tEndRec);
        return t;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 7. Truth helpers (§4.9, §4.10 chain from the model's own parameters)
    // ═════════════════════════════════════════════════════════════════════════
    function geometryFromAfCf(AfCfBbl, Ep, hf, hp, geometry) {
        var A = AfCfBbl * BBL, out = {};
        if (geometry === 'KGD') { out.xf = Math.sqrt(A * Ep / (2 * PI * hf)); out.Af = 2 * out.xf * hf; out.rp = Math.min(1, hp / hf); }
        else if (geometry === 'radial') {
            out.xf = Math.pow(3 * Ep * A / 16, 1 / 3); out.Af = PI * out.xf * out.xf;
            var u = Math.min(1, hp / (2 * out.xf)); out.rp = 2 / PI * (u * Math.sqrt(1 - u * u) + Math.asin(u));
        } else { out.xf = A * Ep / (PI * hf * hf); out.Af = 2 * out.xf * hf; out.rp = Math.min(1, hp / hf); }
        return out;
    }
    function kFromCL(CL, isip, sc, pr, mu, phi, ct) {
        var dpCL = 0.5 * (isip + sc) - pr;
        return dpCL > 0 ? 1000 * Math.pow(CL / (0.0374 * dpCL), 2) * mu / (phi * ct) : null;
    }
    function sigmaCF2From(cfRatio, AfCf, vwcw, sc, pr) {        // end of stiffening: max of f_L(p)/C(p) below σ_c
        var best = sc, bestV = -1;
        for (var x = 0; x <= sc - pr; x += Math.max(0.5, (sc - pr) / 4000)) {
            var p = sc - x, v = ((p - pr) / (sc - pr)) / (AfCf * cfRatio(p) + vwcw(p));
            if (v > bestV) { bestV = v; best = p; }
        }
        return best;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 8. Sources → a continuous record function {p(tInj), seg, ts, …} plus the truth
    // ═════════════════════════════════════════════════════════════════════════
    function caseWellbore(spec) {
        var wb = spec.wellbore || {};
        var VwCw = pos(wb.VwCw) ? wb.VwCw : REF.VwCw, cw = wb.cwOfP || null;
        (spec.artefacts || []).forEach(function (a) { if (a && a.kind === 'air') { VwCw *= pos(a.factor) ? a.factor : 3; cw = 'air'; } });
        return { VwCw: VwCw, cwOfP: cw };
    }
    function tEndFactor(spec) { return pos(spec.tEndFactor) ? spec.tEndFactor : 14; }

    // gdomain (and the pre-closure half of aca-exact)
    function srcGdomain(spec) {
        var gd = merge(gdDefaults(), spec.gd || {});
        if (spec.mechanism && !(spec.gd && spec.gd.mechanism)) gd.mechanism = spec.mechanism;
        var wb = caseWellbore(spec);
        var pStart = fin(gd.pStart) ? gd.pStart : gd.pr;
        if (!(gd.isip > gd.sigmaC && gd.sigmaC > gd.pr)) return fail('BAD_INPUT', 'gdomain needs isip > sigmaC > pr', ['gd']);
        var M = gdModel(gd, wb.VwCw, wb.cwOfP);
        var Vstar = pos(gd.Vstar) ? gd.Vstar : M.X * (gd.Gc + 4 * (PI / 2) / PI);   // V_L(t_c) = X·(G_c + 4g0/π)
        var Vi = Vstar + M.vwcw(gd.sigmaC) * (gd.sigmaC - pStart);
        var sch = buildSchedule(gd.q, Vi, gd.stepDown);
        var tp = sch.tp;                                             // pump definition (t_s − t_start)
        var fac = tEndFactor(spec);
        // integrate in G far enough for the record end
        var GendGuess = GFn(Math.max(10, (gd.Gc > 0 ? GinvFn(gd.Gc, 0.5) : 60) * fac * 1.2), 0.5);
        var I = gdIntegrate(gd, M, Math.max(GendGuess, 4 * gd.Gc));
        var hard = !M.contact;
        if (hard && !(I.Gc > 0)) return fail('NO_CLOSURE', 'gdomain: the decline does not reach closure', ['gd']);
        var Gc = hard ? I.Gc : null;
        var dtDc, dtc;
        if (hard) { dtDc = GinvFn(Gc, 0.5); dtc = dtDc * tp; }
        else {                                                       // contact: σ_c = contact onset (first p ≤ σ_c)
            var gOn = interpLin(I.p.slice().reverse(), I.G.slice().reverse(), gd.sigmaC);
            Gc = gOn; dtDc = GinvFn(gOn, 0.5); dtc = dtDc * tp;
        }
        var tcInj = tp + dtc, dtEnd = fac * dtc;
        var geo = geometryFromAfCf(M.AfCf, gd.Ep, gd.hf, gd.hp, gd.geometry);
        var tpMin = tp * 60, pn = gd.isip - gd.sigmaC;
        var mG0 = -M.rhs(gd.isip, 0);
        var CL = 2 * M.X * BBL / (PI * geo.rp * geo.Af * Math.sqrt(tpMin));
        var kCL = kFromCL(CL, gd.isip, gd.sigmaC, gd.pr, gd.mu, gd.phi, gd.ct);
        var etaG = Gc / (Gc + 2);
        // after closure (hard closure): exact convolution, k chosen for continuity at closure (or p_i)
        var aca = null, kTrue = kCL, pi = gd.pr, kSolved = false;
        if (hard) {
            aca = { k: kCL, L: geo.xf, h: gd.hp, phi: gd.phi, ct: gd.ct, mu: gd.mu, V: Vstar, tcInj: tcInj, pi: gd.pr, geometry: 'full' };
            if (pos(gd.k) && gd.kSolve === 'pi') {
                aca.k = gd.k; kTrue = gd.k;
                pi = gd.sigmaC - convAt(kernel('full', aca), Vstar, tcInj, tcInj);
                aca.pi = pi;
            } else {
                var target = gd.sigmaC - gd.pr;
                var lk = bisect(function (lnk) { var a2 = clone(aca); a2.k = Math.exp(lnk); return convAt(kernel('full', a2), Vstar, tcInj, tcInj) - target; }, Math.log(1e-7), Math.log(1e3), 52);
                aca.k = Math.exp(lk); kTrue = aca.k; kSolved = true;
            }
        }
        var Kc = aca ? kernel('full', aca) : null;
        var pump = pumpModel(gd, sch, pStart, M.vwcw(gd.isip));
        // shut-in clock functions
        function pFall(dt) {
            var Gv = GFn(dt / tp, 0.5);
            if (hard && Gv >= Gc) return pi + convAt(Kc, Vstar, tcInj, tp + dt);
            return interpLin(I.G, I.p, Gv);
        }
        function p(tInj) { return tInj < tp ? pump.p(tInj) : pFall(tInj - tp); }
        var sF2 = hard ? gd.sigmaC : sigmaCF2From(M.cfRatio, M.AfCf, M.vwcw, gd.sigmaC, gd.pr);
        var sHyd = gd.sigmaC;
        if (!hard) { for (var x = 0; x < gd.sigmaC - gd.pr; x += 1) { if (M.cfRatio(gd.sigmaC - x) <= 0.05) { sHyd = gd.sigmaC - x; break; } } }
        var regimeAtEnd = null;
        if (hard) {                                                  // s_D of the exact solution at the record end (injection clock tp + dtEnd)
            var ex = acaExact(aca, [tp + dtEnd], { geometry: 'full' });
            regimeAtEnd = ex.ok ? regimeFromSD(ex.sD[0]) : null;
        }
        var truth = {
            sigmaC: gd.sigmaC, sigmaCHyd: sHyd, sigmaCF2: sF2, isip: gd.isip, pi: pi, k: kTrue, khmu: kTrue * gd.hp / gd.mu, L: geo.xf,
            mechanism: gd.mechanism, regimeAtEnd: regimeAtEnd, tcInj: tcInj, eta: etaG, CL: CL, Gamma: 2 * mG0 / (PI * Math.sqrt(tpMin)),
            AfCf: M.AfCf, Rvis: M.AfCf / (M.AfCf + M.vwcw(gd.sigmaC)), xf: geo.xf,
            // extras
            source: 'gdomain', Gc: Gc, dtc: dtc, dtDc: dtDc, tp: tp, Vi: sch.Vi, ViStar: Vstar, pn: pn, mG: mG0, VwCw: M.vwcw(gd.sigmaC), Csys: M.AfCf + M.vwcw(gd.sigmaC),
            kCL: kCL, kSolved: kSolved, acaScored: hard, geometry: gd.geometry, rampSlopePsiMin: pump.rampSlopePsiMin, rampScaled: pump.rampScaled,
            pb: pump.pb, tbInj: pump.tb, pfo: (gd.mechanism === 'pdl' || gd.Cd > 0) ? M.pfo : null, pHr: gd.mechanism === 'height-recession' ? M.hrP : null,
            fluid: 'water', gasApprox: false
        };
        return { ok: true, p: p, seg: sch.seg, tp: tp, dtEnd: dtEnd, pStart: pStart, truth: truth, gd: gd, M: M, aca: aca, pump: pump };
    }

    // aca-exact: given k, L, V, t_c, p_i → σ_c = p_i + Δp(t_c) (continuity), a normal G line before closure
    function srcAca(spec) {
        var a = clone(spec.aca);
        if (!isObj(a)) return fail('BAD_INPUT', "source 'aca-exact' needs the aca block", ['aca']);
        var geo = a.geometry || 'full';
        var te = pos(a.te) ? a.te : 5 / 60;
        if (!(a.tcInj > te)) return fail('BAD_INPUT', 'aca-exact: tcInj must exceed the pumping time te', ['aca.tcInj']);
        var ex0 = acaExact(a, [a.tcInj], { geometry: geo });
        if (!ex0.ok) return ex0;
        var sc = a.pi + ex0.dp[0];
        var pn = pos(a.pn) ? a.pn : 600;
        var wb = caseWellbore(spec);
        var gd = merge(gdDefaults(), {
            mechanism: 'normal', isip: sc + pn, sigmaC: sc, pr: a.pi, pStart: a.pi, Gc: GFn((a.tcInj - te) / te, 0.5), q: a.V / (te * 60), Vstar: a.V,
            Ep: pos(a.Ep) ? a.Ep : REF.Ep, hf: pos(a.hfrac) ? a.hfrac : (geo === 'box' && pos(a.hf) ? a.hf : a.h), hp: a.h, phi: a.phi, ct: a.ct, mu: a.mu,
            geometry: geo === 'penny' ? 'radial' : 'PKN'
        });
        gd.Vstar = a.V;
        var M = gdModel(gd, wb.VwCw, null);
        // the pre-closure line closes exactly at the given t_c: X from the balance, A_f·c_f = X·G_c/p_n − V_w·c_w
        var Gc = gd.Gc, X = a.V / (Gc + 2), Csys = X * Gc / pn, AfCf = Math.max(1e-9, Csys - wb.VwCw);
        var Vi = a.V + wb.VwCw * (sc - a.pi);
        var sch = { seg: [{ t0: 0, t1: te, q: Vi / (te * 60) }], tp: te, Vi: Vi };
        var mG = pn / Gc;
        var K = kernel(geo, a), fac = tEndFactor(spec);
        var dtc = a.tcInj - te, dtEnd = pos(a.tEnd) ? a.tEnd - te : fac * dtc;
        var pump = pumpModel(gd, sch, a.pi, wb.VwCw);
        var gas = a.fluid === 'gas' ? gasMap(a) : null;
        if (a.fluid === 'gas' && !gas) return fail('GAS_PVT_UNAVAILABLE', 'aca-exact gas case: PRiSM_mpTable is not available', ['aca.fluid']);
        function pFall(dt) {
            var Gv = GFn(dt / te, 0.5);
            var pa = Gv < Gc ? (sc + pn) - mG * Gv : a.pi + convAt(K, a.V, a.tcInj, te + dt);
            return gas ? gas(pa) : pa;
        }
        function p(tInj) { return tInj < te ? pump.p(tInj) : pFall(tInj - te); }
        var geom = geometryFromAfCf(AfCf, gd.Ep, gd.hf, gd.hp, gd.geometry);
        var tpMin = te * 60;
        var CL = 2 * X * BBL / (PI * geom.rp * geom.Af * Math.sqrt(tpMin));
        var exEnd = acaExact(a, [te + dtEnd], { geometry: geo });
        var truth = {
            sigmaC: sc, sigmaCHyd: sc, sigmaCF2: sc, isip: sc + pn, pi: a.pi, k: a.k, khmu: a.k * a.h / a.mu, L: a.L, mechanism: 'normal',
            regimeAtEnd: exEnd.ok ? regimeFromSD(exEnd.sD[0]) : null, tcInj: a.tcInj, eta: Gc / (Gc + 2), CL: CL, Gamma: 2 * mG / (PI * Math.sqrt(tpMin)),
            AfCf: AfCf, Rvis: AfCf / (AfCf + wb.VwCw), xf: geom.xf,
            source: 'aca-exact', Gc: Gc, dtc: dtc, dtDc: dtc / te, tp: te, Vi: Vi, ViStar: a.V, pn: pn, mG: mG, VwCw: wb.VwCw, Csys: AfCf + wb.VwCw,
            kCL: kFromCL(CL, sc + pn, sc, a.pi, a.mu, a.phi, a.ct), kSolved: false, acaScored: true, geometry: geo, rampSlopePsiMin: pump.rampSlopePsiMin,
            rampScaled: pump.rampScaled, pb: pump.pb, tbInj: pump.tb, pfo: null, pHr: null, fluid: a.fluid === 'gas' ? 'gas' : 'water', gasApprox: !!gas
        };
        return { ok: true, p: p, seg: sch.seg, tp: te, dtEnd: dtEnd, pStart: a.pi, truth: truth, gd: gd, M: M, aca: a, pump: pump };
    }
    // gas: the convolution gives the adjusted pressure p_a = p_i + (μz/p)_i·∫ p/(μz) dp; map back with PRiSM's own m(p)
    // (PRiSM_mpTable, call time). The clock is not stretched (pseudo-time not applied; truth.gasApprox).
    function gasMap(a) {
        if (typeof G.PRiSM_mpTable !== 'function') return null;
        var tbl;
        try { tbl = G.PRiSM_mpTable({ T_F: pos(a.T_F) ? a.T_F : 200, SG_g: pos(a.SG_g) ? a.SG_g : 0.65, pi: a.pi, pmax: 2.5 * a.pi + 3000 }); } catch (e) { return null; }
        if (!tbl || typeof tbl.mOf !== 'function' || typeof tbl.pOf !== 'function') return null;
        var mi = tbl.mOf(a.pi), dm = (tbl.mOf(a.pi + 0.5) - tbl.mOf(a.pi - 0.5));
        return function (pa) { return tbl.pOf(mi + (pa - a.pi) * dm); };
    }

    // lk: the leak-off mini-model (58), resolved at call time
    function lkAvailable() {
        var f = G.PRiSM_dfit_lkSimulate;
        return typeof f === 'function' && !f._dfitStub;
    }
    function srcLk(spec) {
        if (!lkAvailable()) return fail('LK_UNAVAILABLE', 'The leak-off mini-model (PRiSM_dfit_lkSimulate) is not available.', ['source']);
        var cfg = clone(spec.lk);
        if (!isObj(cfg)) return fail('BAD_INPUT', "source 'lk' needs an LkConfig", ['lk']);
        var wb = caseWellbore(spec);
        cfg.VwCw = wb.VwCw;
        if (wb.cwOfP) cfg.cwOfP = wb.cwOfP;
        var res;
        try { res = G.PRiSM_dfit_lkSimulate(cfg, { grid: 'display' }); } catch (e) { return fail('LK_FAILED', 'lkSimulate threw: ' + (e && e.message)); }
        if (!res || res.ok !== true || !Array.isArray(res.t) || res.t.length < 3) return fail('LK_FAILED', 'lkSimulate failed: ' + ((res && (res.why || (res.errors && res.errors[0]))) || 'no result'), ['lk']);
        var ev = res.events || {};
        var ts = fin(ev.ts) ? ev.ts : cfg.schedule[cfg.schedule.length - 1].t;
        var tcInj = fin(ev.tcMech) ? ev.tcMech : null;
        var fac = tEndFactor(spec);
        if (tcInj && ts + fac * (tcInj - ts) > res.t[res.t.length - 1] * 1.0001 && pos(spec.tEndFactor)) {
            cfg.tEnd = ts + fac * (tcInj - ts);
            try { var r2 = G.PRiSM_dfit_lkSimulate(cfg, { grid: 'display' }); if (r2 && r2.ok === true) res = r2; } catch (e2) { /* keep the first run */ }
        }
        var T = res.t, P = res.pw, tt = [], pp = [];
        for (var i = 0; i < T.length; i++) if (fin(T[i]) && fin(P[i])) { tt.push(T[i]); pp.push(P[i]); }
        var dtEnd = tcInj ? Math.min(tt[tt.length - 1] - ts, fac * (tcInj - ts)) : tt[tt.length - 1] - ts;
        var seg = [];
        for (var j = 0; j < cfg.schedule.length; j++) {
            var s = cfg.schedule[j], nx = cfg.schedule[j + 1];
            if (s.q > 0) seg.push({ t0: s.t, t1: nx ? nx.t : ts, q: s.q });
        }
        var tStartInj = seg.length ? seg[0].t0 : 0;
        // log-time interpolation after shut-in (the display grid is log-spaced)
        var lnT = [], lnP = [];
        for (i = 0; i < tt.length; i++) if (tt[i] > ts) { lnT.push(Math.log(tt[i] - ts)); lnP.push(pp[i]); }
        function p(tInj) {
            if (tInj > ts && lnT.length && tInj - ts >= Math.exp(lnT[0])) return interpLin(lnT, lnP, Math.log(tInj - ts));
            return interpLin(tt, pp, tInj);
        }
        var tsI = idxNear(tt, ts);
        var ap = cfg.aperture || { law: 'none' };
        var geoName = cfg.geometry || 'PKN';
        var Ep = cfg.Ep, hf = cfg.hf, xf = res.xf && fin(res.xf.ts) ? res.xf.ts : null;
        var Af = Array.isArray(res.A) && fin(res.A[tsI]) ? res.A[tsI] : (xf ? 2 * xf * hf : null);
        var cfFt = geoName === 'KGD' ? PI * xf / Ep : geoName === 'radial' ? 16 * xf / (3 * PI * Ep) : PI * hf / (2 * Ep);
        var AfCf = Af && cfFt ? Af * cfFt / BBL : null;
        var VwCw = wb.VwCw;
        var law = ap.law || 'none', sc = cfg.sigmaC, pr = cfg.pr;
        function cfRatio(pv) {
            if (pv >= sc || law === 'none') return 1;
            var x = sc - pv;
            if (law === 'hyp') return Math.pow(ap.sh / (ap.sh + x), 2);
            var sr = pos(ap.sr) ? ap.sr : 10 * ap.sc;
            return ap.fres * Math.exp(-x / sr) + (1 - ap.fres) * Math.exp(-x / ap.sc);
        }
        var vwcw = function () { return VwCw; };
        var sF2 = (law === 'none' || !AfCf) ? sc : sigmaCF2From(cfRatio, AfCf, vwcw, sc, pr);
        var Gc05 = ev.Gc && fin(ev.Gc.a05) ? ev.Gc.a05 : null;
        var isip = fin(ev.isip) ? ev.isip : p(ts + 1e-6);
        var tpMin = (ts - tStartInj) * 60;
        var mG = Gc05 ? (isip - sc) / Gc05 : null;
        var grp = null;
        if (typeof G.PRiSM_dfit_lkGroups === 'function') { try { grp = G.PRiSM_dfit_lkGroups(cfg); } catch (e3) { grp = null; } }
        var CLeq = fin(res.CLeq) ? res.CLeq : null;
        var k = pos(cfg.k) ? cfg.k : (CLeq ? kFromCL(CLeq, isip, sc, pr, cfg.muRes, cfg.phi, cfg.ct) : null);
        var L = xf || (res.xf && res.xf.tc) || null;
        var etaD = ETA_C * (k || 0) / (cfg.phi * cfg.muRes * cfg.ct);
        var tDL = (k && L && tcInj) ? etaD * (ts + dtEnd - tcInj / 3) / (L * L) : null;
        var reg = tDL == null ? null : tDL <= 0.051 ? 'linear' : tDL >= 2.32 ? 'radial' : 'transition';
        var mech = spec.mechanism;
        var truth = {
            sigmaC: sc, sigmaCHyd: fin(ev.tcHyd) ? p(ev.tcHyd) : sc, sigmaCF2: sF2, isip: isip, pi: pr, k: k, khmu: k ? k * cfg.hp / cfg.muRes : null, L: L,
            mechanism: mech, regimeAtEnd: reg, tcInj: tcInj != null ? tcInj - tStartInj : null,
            eta: Gc05 ? Gc05 / (Gc05 + 2) : null, CL: CLeq, Gamma: grp && fin(grp.Gamma) ? grp.Gamma : (mG ? 2 * mG / (PI * Math.sqrt(tpMin)) : null),
            AfCf: AfCf, Rvis: AfCf ? AfCf / (AfCf + VwCw) : null, xf: xf,
            source: 'lk', Gc: Gc05, dtc: tcInj != null ? tcInj - ts : null, dtDc: (tcInj != null && tpMin > 0) ? (tcInj - ts) / (tpMin / 60) : null, tp: tpMin / 60,
            Vi: seg.reduce(function (s2, g) { return s2 + g.q * (g.t1 - g.t0) * 60; }, 0), ViStar: null, pn: isip - sc, mG: mG, VwCw: VwCw,
            Csys: AfCf ? AfCf + VwCw : null, kCL: CLeq ? kFromCL(CLeq, isip, sc, pr, cfg.muRes, cfg.phi, cfg.ct) : null, kSolved: false,
            acaScored: true, geometry: geoName, rampSlopePsiMin: VwCw > 0 && seg.length ? seg[0].q / VwCw : null, rampScaled: false,
            pb: fin(ev.pb) ? ev.pb : null, tbInj: fin(ev.tb) ? ev.tb - tStartInj : null, pfo: cfg.pdl && cfg.pdl.Cd > 0 ? cfg.pdl.pfo : null, pHr: null,
            fluid: 'water', gasApprox: false
        };
        // shift the schedule clock so that pump start is 0
        var seg0 = seg.map(function (g) { return { t0: g.t0 - tStartInj, t1: g.t1 - tStartInj, q: g.q }; });
        return { ok: true, p: function (tInj) { return p(tInj + tStartInj); }, seg: seg0, tp: ts - tStartInj, dtEnd: dtEnd, pStart: p(tStartInj), truth: truth, lkRes: res, cfg: cfg };
    }
    function idxNear(a, x) { var b = 0; for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - x) < Math.abs(a[b] - x)) b = i; return b; }

    // ═════════════════════════════════════════════════════════════════════════
    // 9. Artefact injectors (§8.1): pure transforms ds → ds; each changes only its target channel
    // ═════════════════════════════════════════════════════════════════════════
    function copyDs(ds) {
        var o = {};
        Object.keys(ds).forEach(function (k) { o[k] = Array.isArray(ds[k]) ? ds[k].slice() : (isObj(ds[k]) ? clone(ds[k]) : ds[k]); });
        return o;
    }
    var CH = ['p', 'q', 'pSurf', 'pBh', 'qFb', 'T', 'pAnn'];
    function mapP(ds, ch, fn) { var o = copyDs(ds); if (Array.isArray(o[ch])) o[ch] = o[ch].map(function (v, i) { return fn(v, i, ds.t[i]); }); return o; }
    function keepRows(ds, keep) {
        var o = copyDs(ds);
        ['t'].concat(CH).forEach(function (k) { if (Array.isArray(o[k])) o[k] = o[k].filter(function (_, i) { return keep[i]; }); });
        return o;
    }
    function after(ctx, t) { return t - ctx.ts; }
    var A = {};
    A.white = { target: 'p', stage: 3, levels: [{ sigma: 0.01 }, { sigma: 0.1 }, { sigma: 0.3 }, { sigma: 1 }],
        apply: function (ds, a, ctx, r) { return mapP(ds, a.channel || 'p', function (v) { return v + (a.sigma || 0.05) * gauss(r); }); } };
    A.ar1 = { target: 'p', stage: 3, levels: [{ sigma: 0.05, rho1: 0.5 }, { sigma: 0.1, rho1: 0.9 }, { sigma: 0.3, rho1: 0.95 }, { sigma: 1, rho1: 0.99 }],
        apply: function (ds, a, ctx, r) {
            var rho = Math.min(0.99, Math.max(0, num(a.rho1, 0.9))), s = num(a.sigma, 0.1), e = s * gauss(r), w = s * Math.sqrt(1 - rho * rho);
            return mapP(ds, a.channel || 'p', function (v, i) { if (i > 0) e = rho * e + w * gauss(r); return v + e; });
        } };
    A.quantise = { target: 'p', stage: 4, levels: [{ quantum: 0.01 }, { quantum: 0.05 }, { quantum: 0.2 }, { quantum: 1 }],
        apply: function (ds, a) { var qn = num(a.quantum, 0.01); return mapP(ds, a.channel || 'p', function (v) { return Math.round(v / qn) * qn; }); } };
    A.sampling = { target: 't', stage: 6, levels: [{ dtS: 1 }, { dtS: 5 }, { dtS: 30 }, { dtS: 120 }],
        apply: function (ds, a) {      // keep samples no closer than dtS (thins the record; values unchanged)
            var dth = num(a.dtS, 1) / 3600, last = -Infinity, keep = ds.t.map(function (t) { if (t - last >= dth - 1e-12) { last = t; return true; } return false; });
            return keepRows(ds, keep);
        } };
    A.tides = { target: 'p', stage: 1, levels: [{ amp: 0.05 }, { amp: 0.15 }, { amp: 0.3 }, { amp: 0.5 }],
        apply: function (ds, a, ctx, r) {
            var amp = num(a.amp, 0.2), ph1 = 2 * PI * r(), ph2 = 2 * PI * r();
            return mapP(ds, 'p', function (v, i, t) { return v + amp * (Math.cos(2 * PI * t / 12.4206 + ph1) + 0.58 * Math.cos(2 * PI * t / 23.9345 + ph2)); });
        } };
    A.barometric = { target: 'pSurf', stage: 1, levels: [{ amp: 0.02 }, { amp: 0.05 }, { amp: 0.1 }, { amp: 0.2 }],
        apply: function (ds, a, ctx, r) {
            if (!Array.isArray(ds.pSurf)) return copyDs(ds);
            var amp = num(a.amp, 0.05), ph = 2 * PI * r();
            return mapP(ds, 'pSurf', function (v, i, t) { return v + amp * Math.cos(2 * PI * t / 12 + ph); });
        } };
    // surface channel from the BH channel: constant-gradient column plus displacement warm-back (§4.2)
    function surfaceOf(ds, a, ctx) {
        var grad = num(a.grad, GRAD_W), tvd = num(a.tvd, ctx.datumTvd || REF.datumTvd), tauT = num(a.tauT, 2), W = num(a.warm, 18);
        return ds.p.map(function (v, i) {
            var dt = ds.t[i] - ctx.ts, warm = dt > 0 ? W * (1 - Math.exp(-dt / tauT)) : 0;
            return v - grad * tvd + warm;
        });
    }
    A.surface = { target: 'pSurf', stage: 0, levels: [{ tauT: 0.5 }, { tauT: 1.5 }, { tauT: 3 }, { tauT: 5 }],
        apply: function (ds, a, ctx) { var o = copyDs(ds); o.pSurf = surfaceOf(ds, a, ctx); return o; } };
    A.vacuum = { target: 'pSurf', stage: 4, levels: [{ pVap: 0.4 }, { pVap: 1 }, { pVap: 3 }, { pVap: 8 }],
        apply: function (ds, a, ctx, r) {
            var ch = Array.isArray(ds.pSurf) ? 'pSurf' : 'p', pv = num(a.pVap, 0.4), hit = false;
            return mapP(ds, ch, function (v, i, t) {    // the column hangs: the gauge reads the vapour pressure (sticky after shut-in)
                if (t > ctx.ts && v <= pv + 0.5) hit = true;
                return (hit || v < pv) ? Math.max(0.05, pv + 0.02 * gauss(r)) : v;
            });
        } };
    A.leak = { target: 'p', stage: 1, levels: [{ qk: 0.02 }, { qk: 0.05 }, { qk: 0.1 }, { qk: 0.2 }],
        apply: function (ds, a, ctx) {        // a constant-rate sink after shut-in: dp/dt = −q_k/C (C_sys before closure, 5·V_w·c_w after)
            var qk = num(a.qk, 0.05) / 24, C1 = ctx.Csys || 0.0375, C2 = 5 * (ctx.VwCw || REF.VwCw), tc = ctx.tsRec + (ctx.dtc || 1);
            return mapP(ds, 'p', function (v, i, t) {
                if (t <= ctx.ts) return v;
                var d1 = Math.min(t, tc) - ctx.ts, d2 = Math.max(0, t - tc);
                return v - qk * (d1 / C1 + d2 / C2);
            });
        } };
    A.clock = { target: 'q', stage: 5, levels: [{ offsetH: 10 / 3600 }, { offsetH: 37.4 / 3600 }, { offsetH: 0.1 }, { offsetH: 1 }],
        apply: function (ds, a) {
            if (!Array.isArray(ds.q)) return copyDs(ds);
            var off = num(a.offsetH, 37.4 / 3600), t = ds.t, q = ds.q;
            return mapP(ds, 'q', function (v, i, ti) { var tt = ti - off; if (tt < t[0]) return q[0]; var j = 0; while (j + 1 < t.length && t[j + 1] <= tt) j++; return q[j]; });
        } };
    A.psig = { target: 'p', stage: 5, levels: [{ atm: ATM }, { atm: ATM }, { atm: ATM }, { atm: ATM }],
        apply: function (ds, a) { var at = num(a.atm, ATM); return mapP(ds, a.channel || 'p', function (v) { return v - at; }); } };
    A.datum = { target: 'p', stage: 5, levels: [{ dz: 50 }, { dz: 200 }, { dz: 500 }, { dz: 1000 }],
        apply: function (ds, a) { var d = num(a.dz, 200) * num(a.grad, GRAD_W); return mapP(ds, 'p', function (v) { return v - d; }); } };
    A.units = { target: 'q', stage: 5, levels: [{ factor: 1440 }, { factor: 1440 }, { factor: 1440 }, { factor: 1440 }],
        apply: function (ds, a) { if (!Array.isArray(ds.q)) return copyDs(ds); var f = num(a.factor, 1440); return mapP(ds, 'q', function (v) { return v * f; }); } };
    A.hammer = { target: 'p', stage: 1, levels: [{ A: 30, Ts: 8.8, tau: 4 }, { A: 115, Ts: 8.8, tau: 6.5 }, { A: 200, Ts: 8.8, tau: 12 }, { A: 300, Ts: 8.8, tau: 25 }],
        apply: function (ds, a, ctx) {
            var Am = num(a.A, 115), T = num(a.Ts, 8.8) / 3600, tau = num(a.tau, 6.5) / 3600;
            return mapP(ds, 'p', function (v, i, t) { var d = t - ctx.ts; return d > 0 ? v + Am * Math.exp(-d / tau) * Math.cos(2 * PI * d / T) : v; });
        } };
    A.bleed = { target: 'p', stage: 1, levels: [{ b: 60 }, { b: 140.9 }, { b: 250 }, { b: 400 }],
        apply: function (ds, a, ctx) {        // pure q^½ friction bleed-off: 1/Δ = 1/Δ0 + t/(b²·V_w·c_w) (t in min)
            var b = num(a.b, 140.9), VwCw = num(a.VwCw, ctx.VwCw || REF.VwCw), d0 = b * Math.sqrt(ctx.qLast || 5);
            return mapP(ds, 'p', function (v, i, t) { var d = (t - ctx.ts) * 60; return d > 0 ? v + 1 / (1 / d0 + d / (b * b * VwCw)) : v; });
        } };
    A.thermal = { target: 'p', stage: 1, levels: [{ A: 1, tauH: 0.05 }, { A: 3, tauH: 0.1 }, { A: 6, tauH: 0.25 }, { A: 10, tauH: 0.5 }],
        apply: function (ds, a, ctx) {
            var Am = num(a.A, 3), tau = num(a.tauH, 0.1);
            return mapP(ds, 'p', function (v, i, t) { var d = t - ctx.ts; return d > 0 ? v - Am * (1 - Math.exp(-d / tau)) * Math.exp(-d / (6 * tau)) * 2.5 : v; });
        } };
    A['early-stop'] = { target: 't', stage: 6, levels: [{ factor: 3 }, { factor: 1.5 }, { factor: 1 }, { factor: 0.5 }],
        apply: function (ds, a, ctx) {
            var tEnd = ctx.ts + num(a.factor, 1.5) * (ctx.dtc || 1);
            return keepRows(ds, ds.t.map(function (t) { return t <= tEnd + 1e-12; }));
        } };
    A['closed-line'] = { target: 'p', stage: 2, levels: [{ afterH: 24 }, { afterH: 6 }, { afterH: 1 }, { afterH: 0.1 }],
        apply: function (ds, a, ctx) {        // the gauge-side valve closes: the reading freezes and drifts slightly
            var tv = ctx.ts + num(a.afterH, 2), frozen = null;
            return mapP(ds, 'p', function (v, i, t) { if (t < tv) return v; if (frozen === null) frozen = v; return frozen - 0.02 * (t - tv); });
        } };
    A.air = { target: 'model', stage: -1, levels: [{ factor: 2 }, { factor: 3 }, { factor: 5 }, { factor: 10 }],
        apply: function (ds) { return copyDs(ds); } };       // applied at generation (V_w·c_w × factor, c_w(p) of air)
    S.artefacts = A;
    S.ARTEFACT_KINDS = ['tides', 'barometric', 'surface', 'vacuum', 'leak', 'clock', 'psig', 'datum', 'units', 'hammer', 'bleed', 'thermal',
        'early-stop', 'closed-line', 'air'];
    S.inject = function (ds, art, ctx, seed) {
        var inj = art && A[art.kind];
        if (!inj) return fail('BAD_INPUT', 'unknown artefact kind', ['kind']);
        return inj.apply(ds, art, ctx || {}, rng(seed));
    };

    // ═════════════════════════════════════════════════════════════════════════
    // 10. make(caseSpec, seed)
    // ═════════════════════════════════════════════════════════════════════════
    function roundDs(ds) {
        ds.t = ds.t.map(function (x) { return rnd(x, 9); });
        ['p', 'pSurf', 'pBh', 'pAnn'].forEach(function (k) { if (Array.isArray(ds[k])) ds[k] = ds[k].map(function (x) { return rnd(x, 3); }); });
        ['q', 'qFb'].forEach(function (k) { if (Array.isArray(ds[k])) ds[k] = ds[k].map(function (x) { return rnd(x, 4); }); });
        if (Array.isArray(ds.T)) ds.T = ds.T.map(function (x) { return rnd(x, 3); });
        return ds;
    }
    // the context the injectors read (shut-in time, closure time, compliances) from a truth object
    function ctxOf(truth, qLast) {
        return { ts: truth.ts, tsRec: truth.ts, tStart: truth.tStart, dtc: truth.dtc, Csys: truth.Csys, VwCw: truth.VwCw, qLast: pos(qLast) ? qLast : 5,
                 datumTvd: REF.datumTvd };
    }
    S.ctxOf = ctxOf;
    function make(caseSpec, seed) {
        try {
            if (!isObj(caseSpec)) return fail('BAD_INPUT', 'make needs a CaseSpec', ['caseSpec']);
            var spec = clone(caseSpec), sd = seedOf(seed == null ? 1 : seed);
            var src = spec.source === 'lk' ? srcLk(spec) : spec.source === 'aca-exact' ? srcAca(spec) : spec.source === 'gdomain' ? srcGdomain(spec) : fail('BAD_INPUT', 'unknown source', ['source']);
            if (!src.ok) return src;
            var tStart = pos(spec.gd && spec.gd.tStartH) ? spec.gd.tStartH : REF.tStartH;
            var dtS = pos(spec.sampling && spec.sampling.dtS) ? spec.sampling.dtS : 2.5;
            var ts = tStart + src.tp, tEndRec = ts + src.dtEnd;
            var perDecade = 120, t = sampleGrid(tStart, ts, tEndRec, dtS, perDecade);
            while (t.length > MAX_PTS && perDecade > 20) { perDecade = Math.round(perDecade * 0.75); t = sampleGrid(tStart, ts, tEndRec, Math.max(dtS, 1), perDecade); }
            if (t.length > MAX_PTS) return fail('TOO_LONG', 'the record would exceed ' + MAX_PTS + ' samples', ['sampling']);
            var p = [], q = [];
            for (var i = 0; i < t.length; i++) {
                var ti = t[i] - tStart;
                p.push(ti < 0 ? src.pStart : src.p(ti));
                q.push(ti >= 0 && ti < src.tp ? qAt(src.seg, ti) * 1440 : 0);
            }
            var ds = { t: t, p: p, q: q, name: spec.id, source: 'dfit-synth', timeUnit: 'h', timeUnitOriginal: 'h', rateUnit: 'bbl/d', ratePhase: 'water',
                       meta: { synth: { version: S.version, caseId: spec.id, seed: sd, source: spec.source } } };
            var truth = src.truth;
            truth.tStart = tStart; truth.ts = ts; truth.tEnd = tEndRec; truth.dtEnd = src.dtEnd; truth.artefacts = (spec.artefacts || []).map(function (a) { return a.kind; });
            var ctx = ctxOf(truth, src.seg.length ? src.seg[src.seg.length - 1].q : 5);
            // artefacts in stage order; noise (caseSpec.noise) between the physical artefacts (stages 0–2) and the blunders (5–6)
            var arts = (spec.artefacts || []).map(function (a, k) { return { a: a, k: k, st: A[a.kind] ? A[a.kind].stage : 99 }; })
                .filter(function (x) { return x.st >= 0; }).sort(function (x, y) { return x.st - y.st || x.k - y.k; });
            var applied = [], noiseDone = false;
            function noise() {
                var nz = spec.noise || {};
                if (pos(nz.sigma)) {
                    var r = rng(subSeed(sd, 0)), rho = Math.min(0.99, Math.max(0, num(nz.rho1, 0))), e = nz.sigma * gauss(r), w = nz.sigma * Math.sqrt(1 - rho * rho);
                    ds.p = ds.p.map(function (v, k) { if (k > 0) e = rho * e + w * gauss(r); return v + e; });
                    if (Array.isArray(ds.pSurf)) { var r2 = rng(subSeed(sd, 1)); ds.pSurf = ds.pSurf.map(function (v) { return v + nz.sigma * gauss(r2); }); }
                }
                if (pos(nz.quantum)) { ['p', 'pSurf'].forEach(function (ch) { if (Array.isArray(ds[ch])) ds[ch] = ds[ch].map(function (v) { return Math.round(v / nz.quantum) * nz.quantum; }); }); }
                noiseDone = true;
            }
            arts.forEach(function (x) {
                if (!noiseDone && x.st >= 3) noise();
                var inj = A[x.a.kind];
                if (!inj) return;
                ds = inj.apply(ds, x.a, ctx, rng(subSeed(sd, 10 + x.k)));
                applied.push({ kind: x.a.kind, target: inj.target });
            });
            if (!noiseDone) noise();
            (spec.artefacts || []).forEach(function (a) { if (a.kind === 'air') applied.push({ kind: 'air', target: 'model' }); });
            if (spec.primary === 'surface' && Array.isArray(ds.pSurf)) { ds.p = ds.pSurf; delete ds.pSurf; ds.meta.primary = 'surface'; }
            else ds.meta.primary = 'bh';
            roundDs(ds);
            return { ok: true, ds: ds, truth: truth, artefacts: applied, caseSpec: spec };
        } catch (e) {
            return fail('SYNTH_FAILED', 'make failed: ' + (e && e.message ? e.message : 'error'));
        }
    }
    S.make = make;

    // ═════════════════════════════════════════════════════════════════════════
    // 11. Case specifications
    // ═════════════════════════════════════════════════════════════════════════
    function baseSpec(id, source, mechanism) {
        return { id: id, source: source, mechanism: mechanism, lk: null, aca: null, wellbore: { VwCw: REF.VwCw, cwOfP: null },
                 noise: { sigma: 0, rho1: 0, quantum: 0 }, sampling: { dtS: 2.5 }, tEndFactor: 14, artefacts: [], tags: [] };
    }
    // the §5.4 / §4.21 base LkConfig (display units)
    function lkBase() {
        return {
            mode: 'propagate', geometry: 'PKN', schedule: [{ t: 0, q: 5 }, { t: 5 / 60, q: 0 }],
            Ep: REF.Ep, nu: 0.25, hf: REF.hf, hp: REF.hp, muCp: 1.0, KIc: 14000, viscCal: 1, Cw: 0, k: 2.75e-3, Sp: 0,
            pdl: { Cd: 0, pfo: null, fmax: 50 }, sigmaC: 7000, pr: 4500, VwCw: REF.VwCw, nwb: { a: REF.nwbA, b: REF.nwbB, beta: 0.5 }, pBd: null, L0: 1,
            aperture: { law: 'none', sh: 60, sc: 100, fres: 0.1, sr: null }, tip: { tauX: null }, farField: false,
            tEnd: 72, phi: REF.phi, ct: REF.ct, muRes: REF.mu, CL: null, wc: null
        };
    }
    function lkSpec(id, mechanism, patch, wb) {
        var s = baseSpec(id, 'lk', mechanism);
        s.lk = merge(lkBase(), patch || {});
        if (wb) s.wellbore = merge(s.wellbore, wb);
        return s;
    }
    var EXAMPLE_A = { k: 1, L: 50, h: 40, phi: 0.12, ct: 1.2e-5, mu: 0.8, V: 15, tcInj: 0.5, pi: 4500, te: 5 / 60, geometry: 'full' };
    var EXAMPLE_B = { k: 0.01, L: 50, h: 40, phi: 0.12, ct: 1.2e-5, mu: 0.8, V: 15, tcInj: 2, pi: 4500, te: 5 / 60, geometry: 'full' };
    S.EXAMPLE_A = EXAMPLE_A; S.EXAMPLE_B = EXAMPLE_B;
    function acaSpec(id, aca, extra) {
        var s = baseSpec(id, 'aca-exact', 'normal');
        s.aca = merge(clone(aca), extra || {});
        s.tEndFactor = 1;
        s.aca.tEnd = pos(s.aca.tEnd) ? s.aca.tEnd : 300;
        return s;
    }
    function gdSpec(id, mechanism, gd) {
        var s = baseSpec(id, 'gdomain', mechanism);
        s.gd = merge({ mechanism: mechanism }, gd || {});
        return s;
    }
    // mechanism → LkConfig patch (the eight pre-closure strata, lk part)
    var LK_MECH = {
        normal: { Cw: 1.903e-4, k: 2.75e-3 },
        matrix: { Cw: 0, k: 2.75e-3 },
        pdl: { Cw: 1.0e-4, k: 2.75e-3, pdl: { Cd: 0.004, pfo: 7250, fmax: 50 } },
        'contact-hyp': { aperture: { law: 'hyp', sh: 60, sc: 100, fres: 0.1, sr: null } },
        'contact-exp': { aperture: { law: 'exp', sh: 60, sc: 100, fres: 0.1, sr: 1000 } },
        storage: { Cw: 0, k: 2.75e-3 }
    };
    function caseRef(id) { var s = lkSpec(id || 'reference', 'matrix', {}); s.tags = ['reference']; s.sampling = { dtS: 1 }; return s; }
    function cases(kind) {
        var out = [];
        if (kind === 'integration') {
            out.push(caseRef('int-reference'));
            out.push(lkSpec('int-contact', 'contact-hyp', LK_MECH['contact-hyp']));
            out.push(acaSpec('int-example-b', EXAMPLE_B));
            out.forEach(function (s) { s.tags.push('integration'); });
            return out;
        }
        if (kind === 'quick') {
            out.push(caseRef('q-reference'));
            out.push(lkSpec('q-contact', 'contact-hyp', LK_MECH['contact-hyp']));
            out.push(lkSpec('q-pdl', 'pdl', LK_MECH.pdl));
            out.push(lkSpec('q-storage-gas', 'storage', LK_MECH.storage, { VwCw: 0.178 / BBL, cwOfP: 'gas' }));
            out.push(lkSpec('q-matrix', 'matrix', LK_MECH.matrix));
            out.push(gdSpec('q-tip', 'tip', {}));
            out.push(gdSpec('q-height-recession', 'height-recession', {}));
            out.push(acaSpec('q-example-a', EXAMPLE_A));
            out.push(acaSpec('q-example-b', EXAMPLE_B));
            out.push(acaSpec('q-penny', { k: 0.1, L: 60, h: 400, phi: 0.1, ct: 1e-5, mu: 0.6, V: 20, tcInj: 1, pi: 4500, te: 5 / 60, geometry: 'penny' }));
            out.push(acaSpec('q-gas-linear', merge(clone(EXAMPLE_B), { fluid: 'gas', T_F: 200, SG_g: 0.65 })));
            var sg = gdSpec('q-surface-vacuum', 'normal', { pr: vacuumPr(), pStart: vacuumPr() });
            sg.artefacts = [{ kind: 'surface', tauT: 2, warm: 18 }, { kind: 'vacuum', pVap: 0.4 }];
            sg.primary = 'surface'; sg.noise = { sigma: 0.2, rho1: 0, quantum: 0.1 };
            out.push(sg);
            out.forEach(function (s) { s.tags.push('quick'); });
            return out;
        }
        if (kind === 'benchmark') return benchPre().concat(benchAca(), cases('artefact'));
        if (kind === 'artefact') {
            S.ARTEFACT_KINDS.forEach(function (k) {
                A[k].levels.forEach(function (lv, j) {
                    var s = gdSpec('art-' + k + '-' + (j + 1), 'normal', {});
                    s.noise = { sigma: 0.05, rho1: 0, quantum: 0.01 };
                    var a = merge({ kind: k }, lv);
                    s.artefacts = k === 'vacuum' || k === 'barometric' ? [{ kind: 'surface' }, a] : [a];
                    if (k === 'vacuum') { s.gd.pr = vacuumPr(); s.gd.pStart = s.gd.pr; }
                    s.tags = ['artefact', k, 'severity-' + (j + 1)];
                    out.push(s);
                });
            });
            return out;
        }
        return fail('BAD_INPUT', "cases(kind): kind is 'integration', 'quick', 'benchmark' or 'artefact'", ['kind']);
    }
    // §8.2 pre-closure: 8 mechanisms × 3 storage × 3 noise × 2 shut-in × 5 seeds = 720
    function benchPre() {
        var out = [], RV = [0.95, 0.6, 0.3], NZ = [{ sigma: 0.05, rho1: 0 }, { sigma: 0.3, rho1: 0 }, { sigma: 1, rho1: 0.9 }], SH = [1.5, 5];
        var AfCfRef = 0.2061 / BBL;
        ['normal', 'matrix', 'pdl', 'contact-hyp', 'contact-exp', 'storage', 'tip', 'height-recession'].forEach(function (m) {
            RV.forEach(function (rv, iv) {
                NZ.forEach(function (nz, inz) {
                    SH.forEach(function (sh) {
                        for (var sdI = 1; sdI <= 5; sdI++) {
                            var id = 'pre-' + m + '-r' + iv + '-n' + inz + '-s' + sh + '-' + sdI, s;
                            var VwCw = AfCfRef * (1 / rv - 1), cw = iv === 2 ? 'gas' : null;
                            if (m === 'tip' || m === 'height-recession') {
                                s = gdSpec(id, m, { Rvis: rv, AfCf: AfCfRef });
                                s.wellbore = { VwCw: VwCw, cwOfP: cw };
                            } else s = lkSpec(id, m, LK_MECH[m], { VwCw: VwCw, cwOfP: cw });
                            s.noise = { sigma: nz.sigma, rho1: nz.rho1, quantum: 0.01 };
                            s.tEndFactor = sh; s.tags = ['benchmark', 'pre', m, 'seed-' + sdI]; s.seed = 1000 + out.length;
                            out.push(s);
                        }
                    });
                });
            });
        });
        return out;
    }
    // §8.2 after-closure: k (6) × geometry (3) × shut-in (3) × fluid (2) = 108 cells, one seed, noise alternating; plus 12 second-noise
    // copies of the full-height liquid cells → 120
    function benchAca() {
        var out = [], KS = [1e-4, 1e-3, 1e-2, 1e-1, 1, 10], GEO = ['full', 'penny', 'box'];
        KS.forEach(function (k) {
            GEO.forEach(function (g) {
                ['linear', 'transition', 'radial'].forEach(function (reg) {
                    ['water', 'gas'].forEach(function (fl) {
                        var a = { k: k, L: 50, h: g === 'penny' ? 400 : 40, hf: 30, phi: 0.1, ct: 1e-5, mu: fl === 'gas' ? 0.025 : 0.6, V: 15, tcInj: 1, pi: 4500, te: 5 / 60, geometry: g };
                        if (fl === 'gas') { a.fluid = 'gas'; a.T_F = 200; a.SG_g = 0.65; a.ct = 2e-4; }
                        var eta = ETA_C * a.k / (a.phi * a.mu * a.ct), tDL = reg === 'linear' ? 0.03 : reg === 'transition' ? 0.4 : 5;
                        a.tEnd = Math.min(2000, Math.max(3 * a.tcInj, a.tcInj / 3 + tDL * a.L * a.L / eta));
                        var s = acaSpec('aca-k' + k + '-' + g + '-' + reg + '-' + fl, a);
                        s.noise = { sigma: out.length % 2 ? 0.3 : 0.05, rho1: 0, quantum: 0.01 };
                        s.tags = ['benchmark', 'aca', g, reg, fl]; s.seed = 5000 + out.length;
                        out.push(s);
                    });
                });
            });
        });
        var extra = out.filter(function (s) { return s.aca.geometry === 'full' && !s.aca.fluid; }).slice(0, 12).map(function (s) {
            var c = clone(s); c.id += '-n2'; c.noise = { sigma: s.noise.sigma === 0.05 ? 0.3 : 0.05, rho1: 0, quantum: 0.01 }; c.seed += 1000; return c;
        });
        return out.concat(extra);
    }
    S.cases = cases;

    // ═════════════════════════════════════════════════════════════════════════
    // 12. Demo datasets (deterministic seeds)
    // ═════════════════════════════════════════════════════════════════════════
    function demoSpec(name) {
        var s;
        switch (name) {
            case 'reference':
                s = gdSpec('demo-reference', 'normal', { stepDown: { rates: [3.75, 2.5, 1.25], dtS: 10 } });
                s.sampling = { dtS: 1 }; s.noise = { sigma: REF.sigmaGauge, rho1: 0, quantum: REF.quantum };
                s.artefacts = [{ kind: 'hammer', A: 115, Ts: 8.81, tau: 6.5 }];
                s.hf = { shutin: true, hz: 50 };
                return { spec: s, seed: 41 };
            case 'tight-linear':
                s = acaSpec('demo-tight-linear', EXAMPLE_B); s.sampling = { dtS: 1 }; s.noise = { sigma: 0.01, rho1: 0, quantum: 0.01 };
                return { spec: s, seed: 42 };
            case 'conventional-radial':
                s = acaSpec('demo-conventional-radial', EXAMPLE_A); s.sampling = { dtS: 1 }; s.noise = { sigma: 0.01, rho1: 0, quantum: 0.01 };
                return { spec: s, seed: 43 };
            case 'contact':
                s = gdSpec('demo-contact', 'contact-hyp', { sh: 60 }); s.sampling = { dtS: 1 }; s.tEndFactor = 4;
                s.noise = { sigma: 0.01, rho1: 0, quantum: 0.01 };
                return { spec: s, seed: 44 };
            case 'pdl':
                s = gdSpec('demo-pdl', 'pdl', { Cd: 0.004 }); s.sampling = { dtS: 1 }; s.noise = { sigma: 0.01, rho1: 0, quantum: 0.01 };
                return { spec: s, seed: 45 };
            case 'surface-gauge':
                s = gdSpec('demo-surface-gauge', 'normal', { pr: vacuumPr(), pStart: vacuumPr() });
                s.sampling = { dtS: 1 }; s.noise = { sigma: 0.2, rho1: 0, quantum: 0.1 };
                s.artefacts = [{ kind: 'surface', tauT: 2, warm: 18 }, { kind: 'vacuum', pVap: 0.4 }];
                s.primary = 'surface';
                return { spec: s, seed: 46 };
            case 'two-cycle':
                s = gdSpec('demo-two-cycle', 'normal', {}); s.sampling = { dtS: 1 }; s.tEndFactor = 2;
                s.noise = { sigma: 0.01, rho1: 0, quantum: 0.01 };
                s.cycle2 = { q: 2, V: 10, afterDtc: 2, pn: 300, Gc: 8, tEndFactor: 3 };
                return { spec: s, seed: 47 };
            default: return null;
        }
    }
    // p_r for which the constant-gradient surface equivalent of the reference falls to 0.5 psia 31 h after shut-in (with warm-back)
    // (solved once by solveVacuumPr: 3,323.9 psia; S2 checks that the demo reaches vacuum 31 h after shut-in)
    var VAC_PR = 3323.9, _vacPr = null;
    function vacuumPr() { return VAC_PR; }
    S.solveVacuumPr = function () { _vacPr = null; return solveVacuumPr(); };
    function solveVacuumPr() {
        if (_vacPr != null) return _vacPr;
        var col = GRAD_W * REF.datumTvd, warm = 18;
        _vacPr = rnd(bisect(function (pr) {
            var s = srcGdomain(gdSpec('vac', 'normal', { pr: pr, pStart: pr }));
            if (!s.ok) return 1;
            return s.p(s.tp + 31) - col + warm * (1 - Math.exp(-31 / 2)) - 0.5;
        }, 2500, 4500, 24), 1);
        return _vacPr;
    }
    S.demoSpec = function (name) { var d = demoSpec(name); return d ? clone(d) : null; };
    S.DEMOS = ['reference', 'tight-linear', 'conventional-radial', 'contact', 'pdl', 'surface-gauge', 'two-cycle'];
    var _demoCache = {};
    function demo(name) {
        var d = demoSpec(name);
        if (!d) return fail('BAD_INPUT', "demo(name): one of " + S.DEMOS.join(', '), ['name']);
        if (!_demoCache[name]) {
            var r = d.spec.cycle2 ? makeTwoCycle(d.spec, d.seed) : make(d.spec, d.seed);
            if (!r.ok) return r;
            r.ds.name = 'DFIT demo — ' + name;
            r.ds.source = 'dfit-demo';
            r.ds.meta.demo = name;
            if (d.spec.hf && d.spec.hf.shutin) r.ds.meta.hfWindows = [hfShutin(d.spec, d.seed, r.truth)];
            _demoCache[name] = r;
        }
        return clone(_demoCache[name].ds);
    }
    S.demo = demo;
    S.demoTruth = function (name) { if (!demoSpec(name)) return null; demo(name); return _demoCache[name] ? clone(_demoCache[name].truth) : null; };

    // 50 Hz shut-in window (−10 s … +120 s) with the water hammer, as 59 stores it (§3.11; plain arrays here)
    function hfShutin(spec, seed, truth) {
        var src = srcGdomain(spec), hz = spec.hf.hz || 50, dt = 1 / hz / 3600, r = rng(subSeed(seed, 99));
        var ham = (spec.artefacts || []).filter(function (a) { return a.kind === 'hammer'; })[0] || { A: 115, Ts: 8.81, tau: 6.5 };
        var p = [], t0 = truth.ts - 10 / 3600, n = Math.round(130 * hz);
        for (var i = 0; i < n; i++) {
            var t = t0 + i * dt, ti = t - truth.tStart, v = src.p(ti), d = t - truth.ts;
            if (d > 0) v += ham.A * Math.exp(-d / (ham.tau / 3600)) * Math.cos(2 * PI * d / (ham.Ts / 3600));
            p.push(rnd(v + REF.sigmaGauge * gauss(r), 3));
        }
        return { kind: 'shutin', t0: rnd(t0, 9), dtS: 1 / hz, n: n, p: p, pSurf: null, q: null };
    }
    // two cycles: the reference, then a second injection after closure with a reopening ramp (family F4), then its falloff
    function makeTwoCycle(spec, seed) {
        var c2 = spec.cycle2, base = clone(spec);
        delete base.cycle2;
        var src = srcGdomain(base);
        if (!src.ok) return src;
        var tr = src.truth, gd = src.gd, M = src.M;
        var tStart = REF.tStartH, ts1 = tStart + src.tp;
        var t2 = ts1 + c2.afterDtc * tr.dtc, tp2 = c2.V / c2.q / 60, ts2 = t2 + tp2;
        var VwCw = tr.VwCw, AfCf = tr.AfCf, p0 = src.p(t2 - tStart);
        var pK = gd.sigmaC + nwb(gd, c2.q), isip2 = gd.sigmaC + c2.pn, pProp = isip2 + nwb(gd, c2.q);
        var s1 = c2.q / VwCw * 60, tK = t2 + Math.max(0, (pK - p0) / s1);
        var tau2 = (VwCw + AfCf) * (pProp - pK) / (c2.q * 60);
        var mG2 = c2.pn / c2.Gc, dtc2 = GinvFn(c2.Gc, 0.5) * tp2, tc2 = ts2 + dtc2;
        var tEnd = ts2 + c2.tEndFactor * dtc2;
        function pRec(t) {
            if (t < t2) return t < tStart ? src.pStart : src.p(t - tStart);
            if (t < ts2) { if (t < tK) return p0 + s1 * (t - t2); return pK + (pProp - pK) * (1 - Math.exp(-(t - tK) / tau2)); }
            var pShut = (t < tK ? p0 + s1 * (ts2 - t2) : pK + (pProp - pK) * (1 - Math.exp(-(ts2 - tK) / tau2))) - nwb(gd, c2.q);
            var dt = t - ts2, Gv = GFn(dt / tp2, 0.5);
            if (t < tc2) return Math.max(gd.sigmaC, pShut - (pShut - gd.sigmaC) * Gv / c2.Gc);
            var base1 = src.p(t - tStart), b1c = src.p(tc2 - tStart);
            return base1 + (gd.sigmaC - b1c) * (2 / PI) * Math.asin(Math.sqrt(Math.min(1, (tc2 - t2) / (t - t2))));
        }
        var t = sampleGrid(tStart, ts1, t2, 1, 100);
        t.pop();
        var dth = 1 / 3600;
        for (var x = t2; x < ts2 - 1e-12; x += dth) t.push(x);
        var d = dth, f = Math.pow(10, 1 / 100) - 1;
        while (ts2 + d < tEnd) { t.push(ts2 + d); d += Math.max(dth, d * f); }
        t.push(tEnd);
        var r = rng(subSeed(seed, 0)), nz = spec.noise || {};
        var p = t.map(function (ti) { var v = pRec(ti); if (pos(nz.sigma)) v += nz.sigma * gauss(r); if (pos(nz.quantum)) v = Math.round(v / nz.quantum) * nz.quantum; return v; });
        var q = t.map(function (ti) { if (ti >= tStart && ti < ts1) return qAt(src.seg, ti - tStart) * 1440; if (ti >= t2 && ti < ts2) return c2.q * 1440; return 0; });
        var ds = roundDs({ t: t, p: p, q: q, name: spec.id, source: 'dfit-synth', timeUnit: 'h', timeUnitOriginal: 'h', rateUnit: 'bbl/d', ratePhase: 'water',
                           meta: { synth: { version: S.version, caseId: spec.id, seed: seed, source: 'gdomain' }, primary: 'bh' } });
        var truth = clone(tr);
        truth.tStart = tStart; truth.ts = ts1; truth.tEnd = tEnd; truth.dtEnd = tEnd - ts1; truth.artefacts = [];
        truth.cycle2 = { tStart: t2, ts: ts2, tp: tp2, q: c2.q, V: c2.V, reopenKnee: pK, tKnee: tK, isip: isip2, sigmaC: gd.sigmaC, dtc: dtc2, Gc: c2.Gc, mG: mG2 };
        return { ok: true, ds: ds, truth: truth, artefacts: [], caseSpec: spec };
    }

    // role-header CSV (the 07 roles time / pressure / rate and, once 07 knows them, pressure_surf, pressure_ann, temp, rate_fb)
    var CSV_COLS = [['t', 'time_h'], ['p', 'pressure_psia'], ['q', 'rate_bbl_d'], ['pSurf', 'pressure_surf_psia'], ['pAnn', 'pressure_ann_psia'],
                    ['T', 'temp_degF'], ['qFb', 'rate_fb_bbl_d']];
    function toCsv(ds) {
        if (!ds || !Array.isArray(ds.t)) return '';
        var cols = CSV_COLS.filter(function (c) { return Array.isArray(ds[c[0]]); });
        var lines = [cols.map(function (c) { return c[1]; }).join(',')];
        for (var i = 0; i < ds.t.length; i++) lines.push(cols.map(function (c) { var v = ds[c[0]][i]; return fin(v) ? String(v) : ''; }).join(','));
        return lines.join('\n');
    }
    S.toCsv = toCsv;
    S.demoCsv = function (name) { var ds = demo(name); return ds && ds.ok === false ? '' : toCsv(ds); };

    // ═════════════════════════════════════════════════════════════════════════
    // 13. Inputs and well for a case (what dfit-validate and the integration tests pass to the pipeline)
    // ═════════════════════════════════════════════════════════════════════════
    S.inputsFor = function (spec, made) {
        var IR = G.PRiSM_dfit_inputRanges;
        if (!IR || typeof IR.defaults !== 'function' || typeof IR.clamp !== 'function') return fail('INPUTS_UNAVAILABLE', 'PRiSM_dfit_inputRanges is not available.', []);
        var inp = IR.defaults(), lk = spec && spec.lk, gd = spec && spec.gd, aca = spec && spec.aca;
        inp.datumTvd = REF.datumTvd;
        inp.strings = [{ tubKey: null, id: REF.idIn, od: REF.odIn, wall: REF.wallIn, topMd: 0, botMd: REF.datumTvd }];
        inp.fluid.kind = 'slickwater'; inp.fluid.rhoPpg = REF.rhoPpg;
        inp.perfs.n = REF.nPerf; inp.perfs.dIn = REF.dPerf; inp.perfs.cd = REF.cdPerf;
        inp.rock.Ep = (lk && lk.Ep) || (gd && gd.Ep) || (aca && aca.Ep) || REF.Ep;
        inp.rock.EpSource = 'static';
        inp.rock.hf = (lk && lk.hf) || (gd && gd.hf) || (aca && (aca.hfrac || aca.h)) || REF.hf;
        inp.rock.hp = (lk && lk.hp) || (gd && gd.hp) || (aca && aca.h) || REF.hp;
        if (spec && spec.primary === 'surface') inp.channels.primary = 'surface';
        var r = IR.clamp(inp);
        return r && r.inputs ? r.inputs : r;
    };
    S.wellFor = function (spec) {
        var lk = spec && spec.lk, aca = spec && spec.aca, gd = spec && spec.gd;
        var src = aca || {};
        var w = {
            testType: 'falloff', fluid: aca && aca.fluid === 'gas' ? 'gas' : 'water',
            phi: (lk && lk.phi) || src.phi || (gd && gd.phi) || REF.phi, ct: (lk && lk.ct) || src.ct || (gd && gd.ct) || REF.ct,
            mu: (lk && lk.muRes) || src.mu || (gd && gd.mu) || REF.mu, h: (lk && lk.hp) || src.h || (gd && gd.hp) || REF.hp,
            B: 1, rw: 0.354, pi: null, q: null
        };
        if (w.fluid === 'gas') { w.T_F = src.T_F || 200; w.SG_g = src.SG_g || 0.65; }
        return w;
    };

    // ═════════════════════════════════════════════════════════════════════════
    // 14. Scoring (§8.3)
    // ═════════════════════════════════════════════════════════════════════════
    var CLASS_OF = { normal: 'normal', matrix: 'matrix', pdl: 'pdl', tip: 'tip', storage: 'storage', spurt: 'normal',
                     'contact-hyp': 'hr-contact', 'contact-exp': 'hr-contact', 'height-recession': 'hr-contact', contact: 'hr-contact' };
    S.classOf = function (m) { return CLASS_OF[m] || 'undetermined'; };
    function concaveUp(m) { return S.classOf(m) === 'hr-contact'; }
    function gDecades(dt, tp) { var g = GFn(dt / tp, 0.5); return g > 0 ? Math.log(g) / Math.LN10 : -Infinity; }
    function score(run, truth) {
        var out = { ok: !!(run && run.ok === true), closure: { mode: null, right: false, partial: false, err: null, inBand: null, intervalScore: null },
                    isip: { right: false, partial: false, err: null }, classify: { right: false, partial: false, type: null, truth: truth ? S.classOf(truth.mechanism) : null },
                    pi: { right: false, partial: false, err: null }, k: { right: false, partial: false }, regime: { right: false, partial: false, value: null, truth: truth ? truth.regimeAtEnd : null },
                    frac: { AfCf: null, Rvis: null, xf: null, sigmaCF2: null }, labels: { closure: null, mode: null, pi: null } };
        if (!run || run.ok !== true || !truth) return out;
        var sc = truth.sigmaC;
        // closure
        var cons = run.consensus || run.consensusLite || null;
        if (cons) {
            var mode = cons.mode;
            out.closure.mode = mode; out.labels.mode = mode; out.labels.closure = cons.confidence || null;
            if (mode === 'single' && fin(cons.value)) {
                var err = cons.value - sc, tolR = Math.max(25, 0.005 * sc), tolP = Math.max(75, 0.015 * sc);
                out.closure.err = err; out.closure.right = Math.abs(err) <= tolR; out.closure.partial = Math.abs(err) <= tolP;
                var fam = cons.families || {}, lo = Infinity, hi = -Infinity;
                ['F1', 'F2', 'F4'].forEach(function (f) { var s = fam[f]; if (s && fin(s.p10) && fin(s.p90)) { lo = Math.min(lo, s.p10); hi = Math.max(hi, s.p90); } });
                out.closure.inBand = lo <= hi ? (sc >= lo && sc <= hi) : null;
                if (fin(truth.sigmaCF2) && truth.sigmaCF2 !== sc) out.frac.sigmaCF2 = cons.value - truth.sigmaCF2;
            } else if (mode === 'range' && cons.range && fin(cons.range.lo) && fin(cons.range.hi)) {
                var l = cons.range.lo, u = cons.range.hi, aIS = 0.2, inR = sc >= l && sc <= u;
                out.closure.inBand = inR; out.closure.partial = inR; out.closure.right = inR && concaveUp(truth.mechanism);
                out.closure.err = sc < l ? sc - l : sc > u ? sc - u : 0;
                out.closure.intervalScore = (u - l) + (2 / aIS) * (l - sc) * (sc < l ? 1 : 0) + (2 / aIS) * (sc - u) * (sc > u ? 1 : 0);
                if (cons.range.medians && fin(truth.sigmaCF2)) out.frac.sigmaCF2 = cons.range.medians.low - truth.sigmaCF2;
            } else if (mode === 'none') {
                var dtEnd = truth.dtEnd, dtc = truth.dtc;
                var notReached = fin(dtc) && fin(dtEnd) && (dtc >= dtEnd || gDecades(dtc, truth.tp) - gDecades(dtEnd, truth.tp) <= 0.3);
                out.closure.right = !!notReached; out.closure.partial = !!notReached;
            }
        }
        // ISIP
        if (run.isip && fin(run.isip.value) && fin(truth.isip)) {
            var pn = fin(truth.pn) ? truth.pn : truth.isip - sc, ei = run.isip.value - truth.isip;
            out.isip.err = ei; out.isip.right = Math.abs(ei) <= Math.max(10, 0.02 * pn); out.isip.partial = Math.abs(ei) <= Math.max(25, 0.05 * pn);
        }
        // mechanism
        if (run.classification && run.classification.type) {
            var tc = S.classOf(truth.mechanism), ty = run.classification.type;
            out.classify.type = ty; out.classify.right = ty === tc;
            out.classify.partial = out.classify.right || (Array.isArray(run.classification.alt) && run.classification.alt.indexOf(tc) !== -1);
        }
        // after closure
        var aca = run.aca;
        if (aca && aca.ok !== false && truth.acaScored) {
            var pr = aca.pi;
            if (pr && fin(pr.lo) && fin(pr.hi) && fin(truth.pi)) {
                var inside = truth.pi >= pr.lo && truth.pi <= pr.hi;
                var width = pr.label === 'high' ? Math.max(10, 0.005 * truth.pi) : pr.label === 'medium' ? 50 : Math.max(50, 0.5 * (pr.hi - pr.lo));
                out.pi.err = fin(pr.value) ? pr.value - truth.pi : null;
                out.pi.partial = inside; out.pi.right = inside && fin(pr.value) && Math.abs(pr.value - truth.pi) <= width;
                out.labels.pi = pr.label || null;
            }
            if (fin(truth.k) && truth.k > 0) {
                if (aca.bounds && fin(aca.bounds.kLo) && fin(aca.bounds.kHi)) {
                    out.k.right = truth.k >= aca.bounds.kLo && truth.k <= aca.bounds.kHi;
                    out.k.partial = out.k.right || (truth.k >= aca.bounds.kLo / 2 && truth.k <= aca.bounds.kHi * 2);
                } else {
                    var kv = (aca.kh && fin(aca.kh.k) && aca.kh.k) || (aca.nolte && aca.nolte.lin && fin(aca.nolte.lin.k) && aca.nolte.lin.k) || null;
                    var ci = aca.match && aca.match.ci95 && aca.match.ci95.k;
                    if (Array.isArray(ci) && fin(ci[0]) && fin(ci[1])) out.k.right = truth.k >= ci[0] && truth.k <= ci[1];
                    else if (kv) out.k.right = Math.abs(Math.log(kv / truth.k)) <= Math.log(1.1);
                    if (kv) out.k.partial = out.k.right || Math.abs(Math.log(kv / truth.k)) <= Math.log(2);
                }
            }
            var rs = aca.regimeSummary, rv = rs === 'linear-radial' ? 'radial' : rs === 'none' ? null : rs;
            out.regime.value = rv;
            if (truth.regimeAtEnd) {
                var order = ['linear', 'transition', 'radial', 'spherical'];
                out.regime.right = rv === truth.regimeAtEnd;
                var i1 = order.indexOf(rv), i2 = order.indexOf(truth.regimeAtEnd);
                out.regime.partial = out.regime.right || (i1 >= 0 && i2 >= 0 && Math.abs(i1 - i2) === 1);
            }
        }
        // pre-closure chain
        var ch = run.frac && run.frac.chosen;
        if (ch) {
            function rel(v, t) { return (fin(v) && fin(t) && t !== 0) ? (v - t) / t : null; }
            var xf = ch.geometry && ch.geometry.byModel && ch.geometry.byModel[ch.geometry.model || 'PKN'];
            out.frac.AfCf = rel(ch.AfCf, truth.AfCf); out.frac.Rvis = rel(ch.Rvis, truth.Rvis);
            out.frac.xf = rel(xf && (fin(xf.xf) ? xf.xf : xf.R), truth.xf);
        }
        return out;
    }
    S.score = score;
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var S = G.PRiSM_dfit_synth, bad = [];
    try {
        if (Math.abs(S.G(1, 0.5) - 4 / Math.PI) > 1e-9) bad.push('G(1)');
        var r = S.acaExact(S.EXAMPLE_B, [2.5, 300]);
        if (!r.ok || Math.abs(r.dp[0] / 2134.326 - 1) > 1e-3) bad.push('example B');
        var m = S.make(S.cases('quick')[7], 3);
        if (!m.ok || m.ds.t.length < 100) bad.push('make');
    } catch (e) { bad.push(String(e && e.message)); }
    if (bad.length && typeof console !== 'undefined') console.warn('[49-calc-dfit-synth self-test] ' + bad.join(', '));
})();
