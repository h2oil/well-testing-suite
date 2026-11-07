// =============================================================================
// PRiSM — 58-prism-dfit-leakoff.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT leak-off mini-model, history match, identifiability, designer and leak budget (docs/DFIT-PLAN.md §3.7, §5, §6.1,
// §6.4, §6.5, §6.7; owner WP4). Pure engine: no DOM, no storage, no timers, no events, no unseeded random numbers.
//
// Public (window):
//   PRiSM_dfit_lkDefaults()                  LkConfig of the §5.4 base case (display units)
//   PRiSM_dfit_lkToEngine(cfg)               {ok, e} engine config (h, ft, psi, ft³, ft³/h, psi·h, ft/√h, ft²)
//   PRiSM_dfit_lkSimulate(cfg, opts)         LkResult (display units: h, psia, ft, ft², in, bbl, bbl/min); opts.surface adds p_s
//   PRiSM_dfit_lkSample(res, t)              p_w at the times t (linear in t)
//   PRiSM_dfit_lkQuick(cfg)                  quick table (q_L at shut-in / 5 / 25 / 100 min and at closure, η, t_c …)
//   PRiSM_dfit_lkSolveCL(cfg, dtcObserved)   CL (wall) or k (reservoir) for an observed closure time (h after shut-in)
//   PRiSM_dfit_lkGoalSeek / …Job             V × q scan for a visible closure within goal.tH hours (≤ 25 coarse runs)
//   PRiSM_dfit_lkFit / …Job                  history match (LM in transformed parameters: log k, log C_w, …; optional
//                                            derivative residuals, MAP priors, structural spread)
//   PRiSM_dfit_lkProfile / …Job              profile likelihood of one free parameter (σ_c, p_r), one refit per step
//   PRiSM_dfit_lkFisher(cfg, design)         noise-only Fisher information, CI, correlations, sloppy directions
//   PRiSM_dfit_lkGroups(cfg | LkResult)      identifiable groups Γ and Γ_PKN
//   PRiSM_dfit_identify(fit, ctx)            "what this test can tell you" (§6.7)
//   PRiSM_dfit_lkVerify()                    the §5.4 V1–V14 numbers
//   PRiSM_dfit_design / …Job                 pre-job designer ensemble (§6.5)
//   PRiSM_dfit_leakBudget(V, tEnd, ctx)      leak tolerance with Θ and the pressure-test hold (§6.4)
//
// Cross-file calls are resolved at call time: PRiSM_dfit_G (56; local closed forms when absent or a stub), PRiSM_rng (05,
// WPH; a local seeded mulberry32 when absent), WTS_wellbore (Round 9; constant-gradient fallbacks), PRiSM_autoInterp.drive is
// not used here (59 drives the Jobs).
// Literature: Nolte 1979 (SPE 8341); Carter 1957; Howard and Fast 1957; Spence and Sharp 1985; Adachi and Detournay 2002;
// Savitski and Detournay 2002; Gringarten, Ramey and Raghavan 1974 (uniform-flux fracture).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    // Local aliases: inside an embedding sandbox a global lookup per element is an intercepted call.
    var _sqrt = Math.sqrt, _exp = Math.exp, _log = Math.log, _abs = Math.abs, _min = Math.min, _max = Math.max,
        _pow = Math.pow, _floor = Math.floor, _asin = Math.asin, _isFinite = isFinite, PI = Math.PI;
    var SQPI = _sqrt(PI);
    var _now = function () { try { return Date.now(); } catch (e) { return 0; } };

    // ─────────────────────────────────────────────────────────────────────
    // Units (engine: h, ft, psi, ft³, ft³/h, psi·h, ft/√h, ft, psi·√ft, ft²) — §3.5 table when 56 is loaded
    // ─────────────────────────────────────────────────────────────────────
    function _units() {
        var t = (G.PRiSM_dfit_units && G.PRiSM_dfit_units.table) || {};
        function f(k, d) { var v = +t[k]; return (_isFinite(v) && v > 0) ? v : d; }
        return {
            bpm: f('bbl/min->ft3/h', 336.875),
            sqmin: f('ft/sqrt(min)->ft/sqrt(h)', 7.745966692),
            galp100: f('gal/100ft2->ft', 1 / 748.05),
            psiin: f('psi*sqrt(in)->psi*sqrt(ft)', 0.288675135),
            cp: f('cp->psi*h', 4.02883e-11),
            md: f('md->ft2', 1.062315e-14),
            bbl: f('bbl/psi->ft3/psi', 5.614583)
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Small helpers
    // ─────────────────────────────────────────────────────────────────────
    function _fail(code, msg, bad) { return { ok: false, code: code, errors: [String(msg)], bad: bad || [] }; }
    function _num(v) { return (typeof v === 'number' && _isFinite(v)) ? v : null; }
    function _w(code, level, text) { return { code: code, level: level, text: String(text).slice(0, 299), ev: [] }; }
    function _clone(o) { return JSON.parse(JSON.stringify(o)); }
    function _okn(v) { return typeof v === 'number' && _isFinite(v); }   // isFinite(null) is true: guard the type too
    function _sig(v, n) { if (!_okn(v)) return '-'; return (+v.toPrecision(n || 3)).toString(); }
    function _fx(v, n) { if (!_okn(v)) return '-'; return v.toFixed(n == null ? 1 : n); }
    function _sci(v, n) {
        if (!_okn(v) || v === 0) return _okn(v) ? '0' : '-';
        var e = _floor(_log(_abs(v)) / Math.LN10), m = v / _pow(10, e);
        if (_abs(+m.toFixed(n == null ? 2 : n)) >= 10) { e += 1; m = v / _pow(10, e); }
        return m.toFixed(n == null ? 2 : n) + 'e' + e;
    }
    function _arr(a) { var o = new Array(a.length); for (var i = 0; i < a.length; i++) o[i] = a[i]; return o; }
    function _pct(sorted, q) {
        var n = sorted.length; if (!n) return null;
        var x = q * (n - 1), i = _floor(x), w = x - i;
        return i + 1 < n ? sorted[i] * (1 - w) + sorted[i + 1] * w : sorted[n - 1];
    }
    function _p3(vals) {
        var a = []; for (var i = 0; i < vals.length; i++) if (_isFinite(vals[i])) a.push(vals[i]);
        a.sort(function (x, y) { return x - y; });
        if (!a.length) return { p10: null, p50: null, p90: null };
        return { p10: _pct(a, 0.1), p50: _pct(a, 0.5), p90: _pct(a, 0.9) };
    }

    // seeded PRNG: PRiSM_rng (05, WPH) at call time; local seeded mulberry32 otherwise
    function _rng(seed) {
        if (typeof G.PRiSM_rng === 'function') { try { var r = G.PRiSM_rng(seed); if (typeof r === 'function') return r; } catch (e) { /* fall through */ } }
        var a = (seed == null ? 1 : seed) >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    // inverse standard normal (Acklam)
    function _qnorm(p) {
        if (p <= 0) return -8; if (p >= 1) return 8;
        var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00],
            b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01],
            c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00],
            d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
        var q, r;
        if (p < 0.02425) { q = _sqrt(-2 * _log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
        if (p > 1 - 0.02425) { q = _sqrt(-2 * _log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
        q = p - 0.5; r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Special functions (§5.3)
    // ─────────────────────────────────────────────────────────────────────
    function erf(x) {
        var s = x < 0 ? -1 : 1; x = _abs(x);
        if (x < 3) {
            var sum = x, term = x, n = 0;
            while (_abs(term) > 1e-17 * _abs(sum) && n < 200) { n++; term *= -x * x / n; sum += term / (2 * n + 1); }
            return s * 2 / SQPI * sum;
        }
        var t = 0; for (var k = 60; k >= 1; k--) t = k / 2 / (x + t);
        return s * (1 - _exp(-x * x) / SQPI / (x + t));
    }
    function erfcx(x) {   // e^(x²)·erfc(x), x ≥ 0: series below 3, continued fraction above (the naive product overflows near 27)
        if (x < 3) return _exp(x * x) * (1 - erf(x));
        var t = 0; for (var k = 60; k >= 1; k--) t = k / 2 / (x + t);
        return 1 / SQPI / (x + t);
    }
    function E1(x) {      // exponential integral, x > 0: series ≤ 1, continued fraction above
        if (x <= 1) {
            var s = 0, term = 1;
            for (var k = 1; k < 80; k++) { term *= -x / k; s += term / k; if (_abs(term / k) < 1e-17) break; }
            return -0.5772156649015329 - _log(x) - s;
        }
        var b = x + 1, c = 1e300, d = 1 / b, h = d;
        for (var i = 1; i < 300; i++) { var a = -i * i; b += 2; d = 1 / (a * d + b); c = b + a / c; var del = c * d; h *= del; if (_abs(del - 1) < 1e-16) break; }
        return h * _exp(-x);
    }
    // uniform-flux vertical fracture, infinite reservoir: p_D,uf(t_D) and t_D·dp_D/dt_D
    function pDuf(tD) { return SQPI * _sqrt(tD) * erf(1 / (2 * _sqrt(tD))) + 0.5 * E1(1 / (4 * tD)); }
    function pDufPrime(tD) { return 0.5 * SQPI * _sqrt(tD) * erf(1 / (2 * _sqrt(tD))); }
    function theta(tD) { return (tD > 0) ? pDuf(tD) / pDufPrime(tD) : 2; }

    // Nolte g / G closed forms (fallback; 56's PRiSM_dfit_G is used when it is a real function)
    function gN(d, a) { return a === 1 ? (4 / 3) * (_pow(1 + d, 1.5) - _pow(d, 1.5)) : (1 + d) * _asin(1 / _sqrt(1 + d)) + _sqrt(d); }
    function GN(d, a) { return (4 / PI) * (gN(d, a) - gN(0, a)); }
    function Gfn() {
        var f = G.PRiSM_dfit_G;
        if (typeof f === 'function' && !f._dfitStub) {
            return function (d, a) { var v; try { v = f(d, a); } catch (e) { v = null; } return (typeof v === 'number' && _isFinite(v)) ? v : GN(d, a === 1 ? 1 : 0.5); };
        }
        return function (d, a) { return GN(d, a === 1 ? 1 : 0.5); };
    }
    function GinvLocal(Gv, a, Gf) {
        var lo = 1e-12, hi = 1e9;
        for (var i = 0; i < 200; i++) { var m = _sqrt(lo * hi); if (Gf(m, a) < Gv) lo = m; else hi = m; if (hi / lo < 1 + 1e-14) break; }
        return _sqrt(lo * hi);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Geometry and propagation (§5.2): lumped PKN / KGD / radial
    // ─────────────────────────────────────────────────────────────────────
    // κ (viscous prefactor) per geometry. PKN from the constant-flux elliptic channel; KGD / radial calibrated so that the lumped
    // no-leak-off laws reproduce the zero-toughness similarity constants 0.6152 (KGD) and 0.6955 (radial) under μ′ = 12μ,
    // Q₀ = the total injection rate (per unit height for KGD), K′ = 4·√(2/π)·K_Ic. Gate G4: those two constants are not
    // re-verified against the original papers in WP4, so KGD / radial pumping pressures carry "viscous term uncalibrated".
    var KVISC = {
        PKN: _pow(32 / PI, 0.25) / 1.25,
        KGD: _pow(0.6152 / _pow(1.5, 1 / 6), -1.5) / PI,
        radial: 3 / (16 * _pow(0.6955 / _pow(12, 1 / 9), 9 / 4))
    };
    var LAMBDA = { PKN: 1.25, KGD: 1, radial: 1 };

    function makeGeom(e) {
        var g = e.geom, E = e.Ep, hf = e.hf, hp = e.hp, KI = e.KIc || 0, mu = e.mu, kap = (e.viscCal || 1) * KVISC[g];
        var o = { name: g, lam: LAMBDA[g] };
        o.A = function (L) { return g === 'radial' ? PI * L * L : 2 * L * hf; };
        o.AL = function (L) {
            if (g !== 'radial') return o.A(L) * _min(1, hp / hf);
            if (!(L > 0)) return 0;
            var u = _min(1, hp / (2 * L));
            return L * L * 2 * (u * _sqrt(1 - u * u) + _asin(u));
        };
        o.cf = function (L) { return g === 'PKN' ? PI * hf / (2 * E) : g === 'KGD' ? PI * L / E : 16 * L / (3 * PI * E); };
        o.ptip = function (L) {
            if (!KI || !(L > 0)) return 0;
            return g === 'PKN' ? KI / _sqrt(PI * hf / 2) : g === 'KGD' ? KI / _sqrt(PI * L) : KI * SQPI / (2 * _sqrt(L));
        };
        o.pvis = function (L, q) {   // volume-equivalent mean viscous net pressure; q = total rate ft³/h
            if (!(q > 0) || !(mu > 0) || !(L > 0)) return 0;
            if (g === 'PKN') return kap * _pow(mu * (q / 2) * E * E * E * L / _pow(hf, 4), 0.25);
            if (g === 'KGD') return kap * _pow(mu * (q / 2) * E * E * E / (hf * L * L), 0.25);
            return kap * _pow(mu * q * E * E * E / (L * L * L), 0.25);
        };
        return o;
    }

    // Aperture laws (§5.2): W(p̄; c_f0) and the relative compliance c/c_f0 (positive for every x below σ_c)
    function makeAperture(ap) {
        var law = (ap && ap.law) || 'none';
        var sh = (ap && ap.sh) || 60, sc = (ap && ap.sc) || 100, fres = (ap && ap.fres != null) ? ap.fres : 0.1;
        var sr = (ap && ap.sr) ? ap.sr : 20 * sc;
        var wsig = fres * sr + (1 - fres) * sc;   // w_σ / c_f0 for 'exp'
        var o = { law: law, sh: sh, sc: sc, fres: fres, sr: sr };
        o.W = function (pb, cf0) {
            var w;
            if (law === 'none') w = pb > 0 ? cf0 * pb : 0;
            else if (law === 'exp') {
                if (pb >= 0) w = cf0 * (wsig + pb);
                else { var x = -pb; w = cf0 * (fres * sr * _exp(-x / sr) + (1 - fres) * sc * _exp(-x / sc)); }
            } else {
                if (pb >= 0) w = cf0 * (sh + pb);
                else w = cf0 * sh * sh / (sh - pb);
            }
            return w > 0 ? w : 0;
        };
        o.rel = function (pb) {
            if (pb >= 0) return 1;
            if (law === 'none') return 0;
            var x = -pb;
            if (law === 'exp') return fres * _exp(-x / sr) + (1 - fres) * _exp(-x / sc);
            var r = 1 + x / sh; return 1 / (r * r);
        };
        // wall-part open fraction over a step: hard law → step-averaged open fraction (continuous in p̄_n+1);
        // contact laws → c(p̄_m)/c_f0 at the mid-step pressure (§5.2)
        o.relStep = function (pb0, pb1) {
            if (law !== 'none') return o.rel(0.5 * (pb0 + pb1));
            if (pb0 > 0 && pb1 > 0) return 1;
            if (pb0 <= 0 && pb1 <= 0) return 0;
            return pb0 > 0 ? pb0 / (pb0 - pb1) : pb1 / (pb1 - pb0);
        };
        // net pressure (p̄ = p − σ_c) at hydraulic closure (c/c_f0 = ½)
        o.pbHyd = function () {
            if (law === 'none') return 0;
            if (law === 'hyp') return -sh * (_sqrt(2) - 1);
            var lo = 0, hi = 50 * sr;
            for (var i = 0; i < 200; i++) { var m = 0.5 * (lo + hi); if (o.rel(-m) > 0.5) lo = m; else hi = m; }
            return -0.5 * (lo + hi);
        };
        return o;
    }

    // Root finder: non-decreasing f on [lo, hi] with f(lo) < 0 < f(hi) (Illinois); relative tolerance, iteration cap
    function illinois(f, lo, hi, flo, fhi, tol, cap, cnt) {
        var side = 0, x = lo;
        for (var it = 0; it < (cap || 60); it++) {
            x = (lo * fhi - hi * flo) / (fhi - flo);
            if (!(x > lo && x < hi)) x = 0.5 * (lo + hi);
            var fx = f(x); if (cnt) cnt.n++;
            if (fx === 0 || _abs(hi - lo) <= tol * (1 + _abs(x))) return x;
            if (fx > 0) { hi = x; fhi = fx; if (side === -1) flo /= 2; side = -1; }
            else { lo = x; flo = fx; if (side === 1) fhi /= 2; side = 1; }
        }
        return x;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Configuration: defaults (display) and the engine conversion
    // ─────────────────────────────────────────────────────────────────────
    var BASE_VWCW_FT3 = 4.98e-3;   // §5.4 common input (the prototype's), ft³/psi

    function lkDefaults() {
        var u = _units(), VwCw = BASE_VWCW_FT3 / u.bbl;
        return {
            mode: 'propagate', geometry: 'PKN',
            schedule: [{ t: 0, q: 5 }, { t: 5 / 60, q: 0 }],
            Ep: 5.0e6, nu: 0.25, hf: 50, hp: 40, muCp: 1, KIc: 14000, viscCal: 1,
            Cw: 1.863e-4, k: null, Sp: 0,
            pdl: { Cd: 0, pfo: null, fmax: 50 }, sigmaC: 7000, pr: 4500, VwCw: VwCw,
            nwb: null, pBd: null, L0: 1,
            aperture: { law: 'none', sh: 60, sc: 100, fres: 0.1, sr: null }, tip: { tauX: null }, farField: false,
            tEnd: 5 / 60 + 300, phi: 0.06, ct: 1e-5, muRes: 0.5,
            CL: null, wc: null
        };
    }

    // schedule [{t, q bbl/min}] → segments [{t0, t1, q ft³/h}] up to tEnd
    function _segments(schedule, tEnd, bpm) {
        var s = schedule.slice().sort(function (a, b) { return a.t - b.t; }), seg = [];
        for (var i = 0; i < s.length; i++) {
            var t0 = +s[i].t, t1 = (i + 1 < s.length) ? +s[i + 1].t : tEnd;
            if (t1 > t0) seg.push({ t0: t0, t1: t1, q: _max(0, +s[i].q || 0) * bpm });
        }
        return seg;
    }

    // κ_k = √(kφc_t/(πμ_r)) (ft/(psi·√h)) from k in md
    function _kappa(kMd, phi, ct, muCp, u) {
        if (!(kMd > 0)) return 0;
        return _sqrt(kMd * u.md * phi * ct / (PI * muCp * u.cp));
    }
    function _kFromKappa(kap, phi, ct, muCp, u) { return (kap > 0) ? kap * kap * PI * muCp * u.cp / (phi * ct) / u.md : 0; }

    function lkToEngine(cfg) {
        try {
            if (!cfg || typeof cfg !== 'object') return _fail('BAD_CONFIG', 'LkConfig expected.', ['cfg']);
            var u = _units(), bad = [], warnings = [];
            var d = lkDefaults();
            function num(key, def, lo) {
                var v = cfg[key]; v = (v == null) ? def : +v;
                if (!_isFinite(v) || (lo != null && !(v > lo))) { bad.push(key); return def; }
                return v;
            }
            var mode = cfg.mode || 'propagate';
            if (mode !== 'propagate' && mode !== 'prescribed' && mode !== 'constP') { bad.push('mode'); mode = 'propagate'; }
            var geom = cfg.geometry || 'PKN';
            if (geom === 'auto') geom = 'PKN';
            if (geom !== 'PKN' && geom !== 'KGD' && geom !== 'radial') { bad.push('geometry'); geom = 'PKN'; }
            var sched = Array.isArray(cfg.schedule) && cfg.schedule.length ? cfg.schedule : null;
            if (!sched) return _fail('BAD_SCHEDULE', 'A pumping schedule [{t, q}] is required.', ['schedule']);
            for (var i = 0; i < sched.length; i++) if (!sched[i] || !_isFinite(+sched[i].t) || !_isFinite(+sched[i].q) || +sched[i].q < 0) return _fail('BAD_SCHEDULE', 'Schedule rows need finite t (h) and q ≥ 0 (bbl/min).', ['schedule']);
            var tEnd = num('tEnd', d.tEnd, 0);
            var segs = _segments(sched, tEnd, u.bpm), ts = null, tStart = null, Vi = 0;
            for (i = 0; i < segs.length; i++) if (segs[i].q > 0) { if (tStart === null) tStart = segs[i].t0; ts = segs[i].t1; Vi += segs[i].q * (segs[i].t1 - segs[i].t0); }
            if (ts === null) return _fail('NO_INJECTION', 'The schedule has no injection.', ['schedule']);
            if (!(tEnd > ts)) return _fail('BAD_TEND', 'tEnd must be after the shut-in.', ['tEnd']);
            var last = segs[segs.length - 1];
            if (last.q > 0) return _fail('NO_SHUTIN', 'The schedule must end with a shut-in (q = 0) before tEnd.', ['schedule']);
            var gaps = 0; for (i = 0; i < segs.length; i++) if (segs[i].q === 0 && segs[i].t1 <= ts && segs[i].t0 >= tStart) gaps++;
            if (gaps) warnings.push(_w('MULTI_CYCLE', 'info', 'The schedule has a pause between injections; re-opening is represented, not modelled in detail (multi-cycle is a later increment).'));

            var Ep = num('Ep', d.Ep, 0), hf = num('hf', d.hf, 0), hp = num('hp', d.hp, 0);
            var muCp = (cfg.muCp === 0) ? 0 : num('muCp', d.muCp, 0), KIc = cfg.KIc == null ? d.KIc : +cfg.KIc;
            if (!_isFinite(KIc) || KIc < 0) { bad.push('KIc'); KIc = d.KIc; }
            var sigmaC = num('sigmaC', d.sigmaC, 0), pr = num('pr', d.pr, 0);
            if (pr >= sigmaC) { bad.push('pr'); }
            var phi = num('phi', d.phi, 0), ct = num('ct', d.ct, 0), muRes = num('muRes', d.muRes, 0);
            var VwCwB = (cfg.VwCw == null) ? d.VwCw : +cfg.VwCw;
            if (!_isFinite(VwCwB) || VwCwB < 0) { bad.push('VwCw'); VwCwB = d.VwCw; }
            var Sp = (cfg.Sp == null) ? 0 : +cfg.Sp; if (!_isFinite(Sp) || Sp < 0) { bad.push('Sp'); Sp = 0; }

            // leak-off: fit parameters C_w (wall) and k (reservoir). CL / w_c (display inputs) convert at Δp_CL.
            var Cw = (cfg.Cw == null) ? 0 : +cfg.Cw, kMd = (cfg.k == null) ? 0 : +cfg.k, fromCL = false;
            if (!_isFinite(Cw) || Cw < 0) { bad.push('Cw'); Cw = 0; }
            if (!_isFinite(kMd) || kMd < 0) { bad.push('k'); kMd = 0; }
            var CLin = (cfg.CL == null) ? null : +cfg.CL, wcIn = (cfg.wc == null) ? 0 : +cfg.wc, dpConv = null;
            if (CLin != null) {
                if (!_isFinite(CLin) || CLin < 0) { bad.push('CL'); CLin = null; }
                if (!_isFinite(wcIn) || wcIn < 0 || wcIn > 1) { bad.push('wc'); wcIn = 0; }
            }
            if (bad.length) return _fail('BAD_CONFIG', 'Invalid leak-off model inputs: ' + bad.join(', ') + '.', bad);
            if (CLin != null) {
                fromCL = true;
                Cw = CLin * (1 - wcIn);
                dpConv = (cfg.dpRef != null && +cfg.dpRef > 0) ? +cfg.dpRef : null;   // optional fixed conversion pressure
            }
            var pdl = cfg.pdl || {}, Cd = +pdl.Cd || 0, pfo = (pdl.pfo == null) ? sigmaC : +pdl.pfo, fmax = (+pdl.fmax > 0) ? +pdl.fmax : 50;
            if (pfo < sigmaC) { pfo = sigmaC; warnings.push(_w('PFO_RAISED', 'info', 'The fissure-opening pressure was raised to the closure stress (it is constrained to be at or above it).')); }
            var ap = cfg.aperture || {};
            var law = ap.law || 'none'; if (law !== 'none' && law !== 'exp' && law !== 'hyp') law = 'none';
            var nwb = cfg.nwb && typeof cfg.nwb === 'object' ? { a: +cfg.nwb.a || 0, b: +cfg.nwb.b || 0, beta: +cfg.nwb.beta || 0.5 } : null;
            if (cfg.tip && cfg.tip.tauX) warnings.push(_w('TIP_NOT_MODELLED', 'info', 'Tip extension after shut-in is a later increment; it is not modelled in this run.'));
            var pBd = (cfg.pBd == null) ? 0 : +cfg.pBd; if (!_isFinite(pBd) || pBd < 0) pBd = 0;
            var L0 = (+cfg.L0 > 0) ? +cfg.L0 : 1;
            var p0 = (cfg.p0 != null && _isFinite(+cfg.p0)) ? +cfg.p0 : (pBd ? pr : sigmaC);
            var e = {
                mode: mode, geom: geom, segs: segs, tStart: tStart, ts: ts, tEnd: tEnd, ViFt3: Vi,
                Ep: Ep, hf: hf, hp: hp, mu: muCp * u.cp, KIc: KIc * u.psiin, viscCal: (+cfg.viscCal > 0) ? +cfg.viscCal : 1,
                Cw: Cw * u.sqmin, kap: _kappa(kMd, phi, ct, muRes, u), kMd: kMd, Sp: Sp * u.galp100,
                pdl: Cd > 0 ? { Cd: Cd, pfo: pfo, fmax: fmax } : null,
                sigmaC: sigmaC, pr: pr, VwCw: VwCwB * u.bbl, nwb: nwb, pBd: pBd, L0: L0, p0: p0,
                aperture: { law: law, sh: +ap.sh || 60, sc: +ap.sc || 100, fres: (ap.fres != null && _isFinite(+ap.fres)) ? +ap.fres : 0.1, sr: (+ap.sr > 0) ? +ap.sr : null },
                farField: !!cfg.farField, phi: phi, ct: ct, muRes: muRes,
                fromCL: fromCL, CLc: fromCL ? CLin * wcIn * u.sqmin : 0, dpConv: dpConv,
                prescribed: cfg.prescribed || null, constPbar: (+cfg.constPbar > 0) ? +cfg.constPbar : null,
                u: u, warnings: warnings
            };
            if (mode === 'prescribed') {
                var pz = e.prescribed;
                if (!pz || !(+pz.Ap > 0) || !(+pz.cf > 0) || !(+pz.alpha >= 0)) return _fail('BAD_CONFIG', "Mode 'prescribed' needs prescribed {Ap ft², cf ft/psi, alpha, rp, tp h}.", ['prescribed']);
                e.prescribed = { Ap: +pz.Ap, cf: +pz.cf, alpha: +pz.alpha, rp: (+pz.rp > 0) ? +pz.rp : _min(1, hp / hf), tp: (+pz.tp > 0) ? +pz.tp : (ts - tStart) };
            }
            if (mode === 'constP' && !e.constPbar) return _fail('BAD_CONFIG', "Mode 'constP' needs constPbar (psi).", ['constPbar']);
            return { ok: true, e: e, warnings: warnings };
        } catch (err) {
            return _fail('ENGINE_CONFIG', err && err.message || err, []);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Time grid (§5.3): fixed by the schedule and t_end, never by the parameters
    // ─────────────────────────────────────────────────────────────────────
    var GRIDS = {
        fit: { dt0: 0.5 / 3600, r: 1.1, maxFrac: 1 / 40, nShut: 500 },
        display: { dt0: 0.25 / 3600, r: 1.05, maxFrac: 1 / 100, nShut: 1700 },
        coarse: { dt0: 1 / 3600, r: 1.15, maxFrac: 1 / 20, nShut: 180 }
    };
    function _gridSpec(g) {
        if (g && typeof g === 'object') {
            var b = GRIDS.fit;
            return { dt0: (+g.dt0 > 0) ? +g.dt0 : b.dt0, r: (+g.r > 1) ? +g.r : b.r, maxFrac: (+g.maxFrac > 0) ? +g.maxFrac : b.maxFrac, nShut: (+g.nShut >= 10) ? _floor(+g.nShut) : b.nShut, dtShut0: (+g.dtShut0 > 0) ? +g.dtShut0 : null };
        }
        return GRIDS[g] || GRIDS.fit;
    }
    function buildGrid(e, gs) {
        var t = [e.segs[0].t0], dt0 = gs.dt0, segs = e.segs, ts = e.ts;
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i]; if (s.t0 >= ts - 1e-15) break;
            var x = s.t0, dt = dt0, cap = (s.t1 - s.t0) * gs.maxFrac;
            while (x < s.t1 - 1e-12) {
                dt = _min(dt, cap);
                var xn = _min(s.t1, x + dt);
                if (s.t1 - xn < 0.3 * dt) xn = s.t1;
                t.push(xn); x = xn; dt *= gs.r;
            }
        }
        var d0 = gs.dtShut0 || dt0, a = _log(d0), b = _log(e.tEnd - ts), n = gs.nShut;
        for (var j = 0; j <= n; j++) {
            var tt = ts + _exp(a + (b - a) * j / n);
            if (j === n) tt = e.tEnd;
            if (tt > t[t.length - 1] + 1e-12) t.push(tt);
        }
        return t;
    }
    function _rateAt(segs, ta, tb) {
        var v = 0;
        for (var i = 0; i < segs.length; i++) { var s = segs[i], lo = _max(ta, s.t0), hi = _min(tb, s.t1); if (hi > lo) v += s.q * (hi - lo); }
        return v / (tb - ta);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 2-D far-field correction table (optional): D(lag) = P_2D − P_1D per unit flux (psi per ft³/h)
    // ─────────────────────────────────────────────────────────────────────
    function _farFieldTable(e, kFt2, xe, tMax) {
        var mu = e.muRes * e.u.cp, eta = kFt2 / (e.phi * mu * e.ct);
        var coef = mu / (2 * PI * kFt2 * e.hp), n = 600, lmin = _log(1e-6), lmax = _log(tMax * 2), tab = new Float64Array(n + 1);
        for (var i = 0; i <= n; i++) {
            var lag = _exp(lmin + (lmax - lmin) * i / n), tD = eta * lag / (xe * xe);
            tab[i] = tD < 1e-3 ? 0 : coef * (pDuf(tD) - SQPI * _sqrt(tD));
        }
        var f = function (lag) {
            if (lag <= 0) return 0;
            var x = (_log(lag) - lmin) / (lmax - lmin) * n;
            if (x <= 0) return tab[0]; if (x >= n) return tab[n];
            var i0 = _floor(x), w = x - i0; return tab[i0] * (1 - w) + tab[i0 + 1] * w;
        };
        f.eta = eta; f.xe = xe;
        return f;
    }

    // ─────────────────────────────────────────────────────────────────────
    // The simulator (engine units). Returns raw arrays; lkSimulate converts.
    // ─────────────────────────────────────────────────────────────────────
    function _simulateEngine(e, grid, budgetMs, maxSteps, counter) {
        var geo = makeGeom(e), ap = makeAperture(e.aperture), segs = e.segs, mode = e.mode;
        var t = grid, N = t.length, ts = e.ts, sig = e.sigmaC, pr = e.pr;
        var Cw = e.Cw, kap = e.kap, Sp = e.Sp, VwCw = e.VwCw, pdl = e.pdl, nwb = e.nwb, pbd = e.pBd, L0 = e.L0;
        var P = new Float64Array(N), PW = new Float64Array(N), L = new Float64Array(N), AL = new Float64Array(N), A = new Float64Array(N),
            Y = new Float64Array(N), VL = new Float64Array(N), VLw = new Float64Array(N), VLc = new Float64Array(N), VS = new Float64Array(N),
            VF = new Float64Array(N), VI = new Float64Array(N), QC = new Float64Array(N), DEL = new Float64Array(N), BW = new Float64Array(N),
            PTIP = new Float64Array(N), PVIS = new Float64Array(N);
        var IA = 0, IY = 0, frac = false, warnings = [], why = null, nDone = N - 1, t0ms = _now(), nEval = 0, holdWarned = false;
        var ff = null, ffWanted = e.farField && kap > 0;
        if (e.farField && !(kap > 0)) warnings.push(_w('FARFIELD_OFF', 'info', 'The 2-D far-field correction needs reservoir-controlled leak-off (k > 0); it was not applied.'));
        function fP(p) { if (!pdl) return 1; return p > pdl.pfo ? _min(pdl.fmax, _exp(pdl.Cd * (p - pdl.pfo))) : 1; }
        function dpN(q) { if (!nwb || !(q > 0)) return 0; var qb = q / e.u.bpm; return nwb.a * qb * qb + nwb.b * _pow(qb, nwb.beta); }
        P[0] = e.p0; PW[0] = e.p0;
        if (mode === 'prescribed' || mode === 'constP') frac = true;
        if (mode === 'prescribed') {   // area at the first node (α = 0: a constant area from the start, Nolte's limit)
            var pz0 = e.prescribed, A0 = pz0.Ap * _pow(_min(1, _max(0, t[0] - e.tStart) / pz0.tp), pz0.alpha);
            A[0] = A0; AL[0] = pz0.rp * A0; VF[0] = A0 * ap.W(P[0] - sig, pz0.cf);
        }
        L[0] = mode === 'constP' ? 1e-6 : 0;
        if (mode === 'propagate' && !pbd) { frac = true; L[0] = L0; }
        if (mode !== 'prescribed') {
            A[0] = frac ? geo.A(L[0]) : 0;
            AL[0] = frac ? geo.AL(L[0]) : 0;
            VF[0] = frac ? A[0] * ap.W(P[0] - sig, geo.cf(L[0] || 1e-9)) : 0;
        }
        Y[0] = AL[0] * (P[0] - pr);
        var tb = null, pb = null;
        var _s = _sqrt;
        for (var n = 0; n < N - 1; n++) {
            if (maxSteps && n >= maxSteps) { why = 'step cap reached'; nDone = n; break; }
            if (budgetMs && (n & 63) === 0 && _now() - t0ms > budgetMs) { why = 'run budget exceeded'; nDone = n; break; }
            var ta = t[n], t1 = t[n + 1], dt = t1 - ta, q = _rateAt(segs, ta, t1), pumping = q > 0, Qin = q * dt;
            VI[n + 1] = VI[n] + Qin;
            // history sums at T = t1, one loop with two accumulators sharing the kernel weights (§5.3)
            var hA = 0, hY = 0, sPrev = _s(t1 - t[0]);
            for (var j = 1; j <= n; j++) {
                var sb = _s(t1 - t[j]), den = sPrev + sb, d1 = (t[j] - t[j - 1]) / den, wq = (2 / 3) * (1 + sPrev / den);
                hA += d1 * (2 * AL[j - 1] + wq * (AL[j] - AL[j - 1]));
                hY += d1 * (2 * Y[j - 1] + wq * (Y[j] - Y[j - 1]));
                sPrev = sb;
            }
            var s3 = _s(dt), del = 0;
            if (ffWanted && !ff && ta >= ts - 1e-12 && L[n] > 0) {
                var xe = (e.geom === 'radial') ? AL[n] / (2 * e.hp) : L[n];
                ff = _farFieldTable(e, e.kMd * e.u.md, xe, t[N - 1]);
            }
            if (ff) { for (var jj = 1; jj <= n; jj++) del += QC[jj] * (ff(t1 - t[jj - 1]) - ff(t1 - t[jj])); }
            DEL[n + 1] = del;
            var fricN = pumping ? dpN(q) : 0;
            var dVL = (function (nn, hAx, hYx, s3x, delx) {
                return function (ALn1, pf1) {
                    var Ia = hAx + s3x * ((2 / 3) * AL[nn] + (4 / 3) * ALn1);
                    var Yn1 = ALn1 * (pf1 - pr - delx);
                    var Iy = hYx + s3x * ((2 / 3) * Y[nn] + (4 / 3) * Yn1);
                    var pm = 0.5 * (P[nn] + pf1), f = fP(pm);
                    var dw = Cw > 0 ? 2 * Cw * (Ia - IA) * ap.relStep(P[nn] - sig, pf1 - sig) * f : 0;
                    var dc = kap > 0 ? 2 * kap * (Iy - IY) * f : 0;
                    var ds = Sp > 0 ? 2 * Sp * _max(0, ALn1 - AL[nn]) : 0;
                    return { v: dw + dc + ds, dw: dw, dc: dc, ds: ds, Ia: Ia, Iy: Iy, Y: Yn1 };
                };
            })(n, hA, hY, s3, del);
            var Ln1 = L[n], pf1, pw1, r;
            // ---- breakdown (no fracture yet): wellbore only ----
            if (!frac) {
                pw1 = PW[n] + Qin / _max(VwCw, 1e-6);
                if (pw1 >= pbd) {
                    frac = true; tb = ta; pb = PW[n];
                    L[n] = L0; A[n] = geo.A(L0); AL[n] = geo.AL(L0); Y[n] = AL[n] * (P[n] - pr); Ln1 = L0; VF[n] = 0;
                    dVL = (function (nn, hAx, hYx, s3x, delx) {   // AL[n] changed: rebuild the step closure
                        return function (ALn1, pf1x) {
                            var Ia = hAx + s3x * ((2 / 3) * AL[nn] + (4 / 3) * ALn1);
                            var Yn1 = ALn1 * (pf1x - pr - delx);
                            var Iy = hYx + s3x * ((2 / 3) * Y[nn] + (4 / 3) * Yn1);
                            var pm = 0.5 * (P[nn] + pf1x), f = fP(pm);
                            var dw = Cw > 0 ? 2 * Cw * (Ia - IA) * ap.relStep(P[nn] - sig, pf1x - sig) * f : 0;
                            var dc = kap > 0 ? 2 * kap * (Iy - IY) * f : 0;
                            var ds = Sp > 0 ? 2 * Sp * _max(0, ALn1 - AL[nn]) : 0;
                            return { v: dw + dc + ds, dw: dw, dc: dc, ds: ds, Ia: Ia, Iy: Iy, Y: Yn1 };
                        };
                    })(n, hA, hY, s3, del);
                } else {
                    P[n + 1] = pw1; PW[n + 1] = pw1; L[n + 1] = 0; VL[n + 1] = VL[n]; VLw[n + 1] = VLw[n]; VLc[n + 1] = VLc[n]; VS[n + 1] = VS[n]; VF[n + 1] = 0;
                    BW[n + 1] = 0;
                    continue;
                }
            }
            if (mode === 'prescribed') {
                var pz = e.prescribed;
                var An1 = pz.Ap * _pow(_min(1, _max(0, t1 - e.tStart) / pz.tp), pz.alpha), ALp = pz.rp * An1;
                var fpp = (function (An, ALx, nn, Qx) { return function (pf) { nEval++; return VwCw * (pf - PW[nn]) + An * ap.W(pf - sig, pz.cf) - VF[nn] + dVL(ALx, pf).v - Qx; }; })(An1, ALp, n, Qin);
                pf1 = solveP(fpp, P[n]);
                r = dVL(ALp, pf1);
                commit(n, pf1, pf1, 0, An1, ALp, An1 * ap.W(pf1 - sig, pz.cf), r, 0, 0);
                if (!okState(n + 1)) break;
                continue;
            }
            // ---- trial: fixed L ----
            var Afx = geo.A(Ln1), ALfx = geo.AL(Ln1), cfn = geo.cf(Ln1);
            var exc = (pumping && mode === 'propagate') ? (geo.lam - 1) * geo.pvis(Ln1, q) : 0;
            var fnp = (function (An, ALx, cfx, nn, Qx, ex, fr) { return function (pf) { nEval++; return VwCw * (pf + fr + ex - PW[nn]) + An * ap.W(pf - sig, cfx) - VF[nn] + dVL(ALx, pf).v - Qx; }; })(Afx, ALfx, cfn, n, Qin, exc, fricN);
            pf1 = solveP(fnp, P[n]);
            var canProp = pumping && (mode === 'propagate' || mode === 'constP');
            var pprop = canProp ? (mode === 'constP' ? e.constPbar : geo.ptip(Ln1) + geo.pvis(Ln1, q)) : Infinity;
            if (canProp && pf1 - sig > pprop) {
                var qq = q, nn2 = n, Qx2 = Qin;
                var pbarL = function (Lx) { return mode === 'constP' ? e.constPbar : geo.ptip(Lx) + geo.pvis(Lx, qq); };
                var pwL = function (Lx) { if (mode === 'constP') return sig + e.constPbar; return sig + geo.ptip(Lx) + geo.lam * geo.pvis(Lx, qq) + fricN; };
                var FL = function (Lx) { nEval++; var pbx = pbarL(Lx); return VwCw * (pwL(Lx) - PW[nn2]) + geo.A(Lx) * ap.W(pbx, geo.cf(Lx)) - VF[nn2] + dVL(geo.AL(Lx), sig + pbx).v - Qx2; };
                var lo = Ln1, flo = FL(lo), hi = _max(lo * 1.2, 1e-3), fhi = FL(hi), kx = 0;
                while (fhi < 0 && kx < 200 && hi < 5000) { lo = hi; flo = fhi; hi *= 1.5; fhi = FL(hi); kx++; }
                if (fhi < 0) { why = 'geometry runaway (length above 5,000 ft)'; nDone = n; break; }
                if (flo >= 0) Ln1 = lo; else Ln1 = illinois(FL, lo, hi, flo, fhi, 1e-10, 60);
                var pb1 = pbarL(Ln1); pf1 = sig + pb1; pw1 = pwL(Ln1);
                r = dVL(geo.AL(Ln1), pf1);
                commit(n, pf1, pw1, Ln1, geo.A(Ln1), geo.AL(Ln1), geo.A(Ln1) * ap.W(pb1, geo.cf(Ln1)), r, geo.ptip(Ln1), mode === 'constP' ? 0 : geo.pvis(Ln1, q));
            } else {
                r = dVL(ALfx, pf1);
                commit(n, pf1, pf1 + fricN + exc, Ln1, Afx, ALfx, Afx * ap.W(pf1 - sig, cfn), r, PTIP[n], PVIS[n]);
            }
            if (!okState(n + 1)) break;
        }
        if (counter) counter.evals = (counter.evals || 0) + nEval;
        function okState(i) {
            if (!_isFinite(P[i]) || !_isFinite(PW[i]) || !_isFinite(L[i]) || !_isFinite(VL[i]) || !_isFinite(VF[i])) { why = 'non-finite state at step ' + i; nDone = i - 1; return false; }
            return true;
        }
        function commit(nn, pf, pw, Lx, Ax, ALx, Vf, rr, ptip, pvis) {
            P[nn + 1] = pf; PW[nn + 1] = pw; L[nn + 1] = Lx; A[nn + 1] = Ax; AL[nn + 1] = ALx; VF[nn + 1] = Vf; Y[nn + 1] = rr.Y;
            VL[nn + 1] = VL[nn] + rr.v; VLw[nn + 1] = VLw[nn] + rr.dw; VLc[nn + 1] = VLc[nn] + rr.dc; VS[nn + 1] = VS[nn] + rr.ds;
            QC[nn + 1] = rr.dc / (t[nn + 1] - t[nn]); IA = rr.Ia; IY = rr.Iy; BW[nn + 1] = rr.Ia; PTIP[nn + 1] = ptip; PVIS[nn + 1] = pvis;
        }
        function solveP(f, pguess) {
            var lo = _min(pguess, pr) - 50, hi = pguess + 50, flo = f(lo), fhi = f(hi), k = 0, stp = 100;
            while (flo > 0 && k < 100) { hi = lo; fhi = flo; lo -= stp; stp *= 2; flo = f(lo); k++; }
            stp = 100;
            while (fhi < 0 && k < 200) { lo = hi; flo = fhi; hi += stp; stp *= 2; fhi = f(hi); k++; }
            if (!(flo <= 0 && fhi >= 0) || fhi === flo) {
                // flat balance (no storage, no open fracture, no leak-off): the pressure is undetermined — hold it
                if (!holdWarned) { holdWarned = true; warnings.push(_w('PRESSURE_HELD', 'info', 'With no wellbore storage and a closed fracture the pressure is undetermined; it was held at its last value.')); }
                return pguess;
            }
            return illinois(f, lo, hi, flo, fhi, 1e-13, 60);
        }
        return { t: t, N: nDone + 1, P: P, PW: PW, L: L, A: A, AL: AL, VL: VL, VLw: VLw, VLc: VLc, VS: VS, VF: VF, VI: VI, DEL: DEL, BW: BW,
                 PTIP: PTIP, PVIS: PVIS, tb: tb, pb: pb, why: why, warnings: warnings, ff: ff, geo: geo, ap: ap, evals: nEval };
    }

    // ─────────────────────────────────────────────────────────────────────
    // lkSimulate: engine run → LkResult (display units)
    // ─────────────────────────────────────────────────────────────────────
    function _crossTime(t, y, level, from, n) {   // first downward crossing of level after index from (linear in t)
        for (var i = from + 1; i < n; i++) if (y[i - 1] >= level && y[i] < level) return t[i - 1] + (t[i] - t[i - 1]) * (y[i - 1] - level) / (y[i - 1] - y[i]);
        return null;
    }
    // extrapolate the last two open samples (p ≥ σ_c) linearly on the axis X to σ_c → X_c
    function _xcAtClosure(X, p, sig, from, n) {
        var i = -1;
        for (var k = from + 1; k < n; k++) { if (p[k] < sig) { i = k - 1; break; } }
        if (i < 0) return null;
        if (i - 1 < from || X[i] == null || X[i - 1] == null) return null;
        var x1 = X[i - 1], x2 = X[i], p1 = p[i - 1], p2 = p[i];
        if (!(p1 !== p2)) return x2;
        return x2 + (sig - p2) * (x2 - x1) / (p2 - p1);
    }

    function lkSimulate(cfg, opts) {
        try {
            opts = opts || {};
            var conv = lkToEngine(cfg);
            if (!conv.ok) return conv;
            var e = conv.e;
            if (e.fromCL) _resolveCL(e, opts);
            var res = _runAndPack(e, opts);
            if (opts.surface) _surfacePressure(res, cfg, opts.surface);
            return res;
        } catch (err) {
            return _fail('SIMULATION_FAILED', err && err.message || err, []);
        }
    }
    // Optional surface pressure (§5.5): p_s = p_w − p_hyd + Δp_pipe(q) through WTS_wellbore (resolved at call time). The column
    // head is integrated at 5 bottomhole-pressure nodes and interpolated per sample; pipe friction once per distinct rate.
    // surface = {column, fluid, T (°F or fn(tvd)), datumTvd | datumMd}; res.ps stays null (with a note) without the engine.
    var ATM = 14.696;
    function _surfacePressure(res, cfg, sp) {
        var W = G.WTS_wellbore, col = sp && sp.column;
        res.ps = null;
        function note(code, text) { res.warnings.push(_w(code, 'info', text)); }
        if (!W || typeof W.hydrostatic !== 'function' || W.hydrostatic._dfitStub) return note('SURFACE_UNAVAILABLE', 'Surface pressure not computed: the wellbore engine is not available.');
        if (!col || typeof col !== 'object') return note('SURFACE_UNAVAILABLE', 'Surface pressure not computed: no wellbore column was given.');
        var datum = _num(sp.datumTvd);
        if (datum == null && _num(sp.datumMd) != null && typeof col.tvdAt === 'function') datum = _num(col.tvdAt(sp.datumMd));
        if (!(datum > 0)) return note('SURFACE_UNAVAILABLE', 'Surface pressure not computed: the gauge datum depth is missing.');
        var pw = res.pw, n = pw.length, lo = Infinity, hi = -Infinity, i;
        for (i = 0; i < n; i++) if (pw[i] != null) { if (pw[i] < lo) lo = pw[i]; if (pw[i] > hi) hi = pw[i]; }
        if (!(hi >= lo)) return note('SURFACE_UNAVAILABLE', 'Surface pressure not computed: no bottomhole pressure.');
        var NN = 5, nodes = [], heads = [];
        for (i = 0; i < NN; i++) {
            var pn = (hi > lo) ? lo + (hi - lo) * i / (NN - 1) : lo, h = W.hydrostatic(pn, datum, 0, col, sp.T);
            if (!h || h.ok === false || !_isFinite(+h.p)) return note('SURFACE_UNAVAILABLE', 'Surface pressure not computed: the column integration failed.');
            nodes.push(pn); heads.push(+h.p);
            if (hi === lo) break;
        }
        function pStatic(p) {
            if (nodes.length === 1) return heads[0] + (p - nodes[0]);
            var j = 1; while (j < nodes.length - 1 && nodes[j] < p) j++;
            var w = (p - nodes[j - 1]) / (nodes[j] - nodes[j - 1]); return heads[j - 1] + w * (heads[j] - heads[j - 1]);
        }
        var sch = (cfg.schedule || []).slice().sort(function (a, b) { return a.t - b.t; }), fric = {};
        function qAt(t) { var q = 0; for (var k = 0; k < sch.length; k++) { if (sch[k].t <= t + 1e-12) q = +sch[k].q || 0; else break; } return q; }
        function dpPipe(q) {
            if (!q) return 0;
            if (fric[q] != null) return fric[q];
            var s = 0, segs = Array.isArray(col.segments) ? col.segments : [];
            if (typeof W.pipeFriction === 'function') for (var k = 0; k < segs.length; k++) {
                var f = W.pipeFriction(_abs(q), segs[k], sp.fluid, sp.T), len = (+segs[k].botMd) - (+segs[k].topMd);
                if (f && f.ok !== false && _isFinite(+f.dpdl) && len > 0) s += _abs(+f.dpdl) * len;
            }
            fric[q] = q > 0 ? s : -s;   // injection: p_s = p_w − p_hyd + Δp_pipe; the sign flips for flowback
            return fric[q];
        }
        var ps = new Array(n), tVac = null, tLow = null;
        for (i = 0; i < n; i++) {
            if (pw[i] == null) { ps[i] = null; continue; }
            var tt = res.t[i], q = qAt(tt);
            ps[i] = pStatic(pw[i]) + dpPipe(q);
            if (tt > res.events.ts) { if (tVac == null && ps[i] < ATM) tVac = tt; if (tLow == null && ps[i] < ATM + 15) tLow = tt; }
        }
        res.ps = ps;
        if (tVac != null) res.warnings.push(_w('SURFACE_VACUUM', 'bad', 'The surface pressure falls below 0 psig ' + _sig((tVac - res.events.ts), 3) + ' h after shut-in: after-closure analysis needs a bottomhole gauge.'));
        else if (tLow != null) res.warnings.push(_w('SURFACE_LOW', 'warn', 'The surface pressure falls below 15 psig ' + _sig((tLow - res.events.ts), 3) + ' h after shut-in: the column may not stay liquid-supported.'));
    }

    // CL / w_c display inputs: κ_k from the reservoir share at Δp_CL = ½(ISIP + σ_c) − p_r (two coarse fixed-point passes)
    function _resolveCL(e, opts) {
        if (!(e.CLc > 0)) { e.kap = 0; e.kMd = 0; return; }
        var dp = e.dpConv || (e.sigmaC - e.pr + 300);
        if (!e.dpConv) {
            for (var it = 0; it < 2; it++) {
                e.kap = e.CLc / dp;
                var raw = _simulateEngine(e, buildGrid(e, GRIDS.coarse), opts.budgetMs || 2000, 0, opts.counts);
                var iS = _idxAtOrAfter(raw.t, e.ts, raw.N), isip = raw.P[iS];
                if (_isFinite(isip)) dp = _max(1, 0.5 * (isip + e.sigmaC) - e.pr);
            }
        }
        e.kap = e.CLc / dp; e.kMd = _kFromKappa(e.kap, e.phi, e.ct, e.muRes, e.u);
    }
    function _idxAtOrAfter(t, x, n) { for (var i = 0; i < n; i++) if (t[i] >= x - 1e-12) return i; return n - 1; }

    function _runAndPack(e, opts) {
        var gs = _gridSpec(opts.grid || 'fit'), grid = opts.tGrid || buildGrid(e, gs);
        var raw = _simulateEngine(e, grid, opts.budgetMs == null ? 2000 : opts.budgetMs, opts.maxSteps || 0, opts.counts);
        if (opts.counts) opts.counts.runs = (opts.counts.runs || 0) + 1;
        return _pack(e, raw, opts);
    }

    function _pack(e, raw, opts) {
        var u = e.u, N = raw.N, t = raw.t, sig = e.sigmaC, bbl = u.bbl, warnings = e.warnings.slice().concat(raw.warnings), validity = [];
        var Gf = Gfn();
        var out = { ok: !raw.why, why: raw.why || null, t: [], pw: [], pf: [], L: [], A: [], AL: [], W: [], Vf: [], Vi: [], VL: [], VLw: [], VLc: [], VS: [], qL: [], eta: [], Bw: [], Ggen: [] };
        var iS = _idxAtOrAfter(t, e.ts, N), tp = e.ts - e.tStart, ALs = raw.AL[iS] || 0, gS = (ALs > 0 && tp > 0) ? raw.BW[iS] / (ALs * _sqrt(tp)) : null;
        var Xa05 = new Array(N), Xa1 = new Array(N), Xgen = new Array(N), bal = 0;
        for (var i = 0; i < N; i++) {
            var pw = raw.PW[i], pf = raw.P[i];
            out.t.push(t[i]);
            out.pw.push(pw > 0 && pw < 1e5 ? pw : null);
            out.pf.push(pf > 0 && pf < 1e5 ? pf : null);
            out.L.push(raw.L[i] >= 0 ? raw.L[i] : 0); out.A.push(raw.A[i]); out.AL.push(raw.AL[i]);
            out.W.push(raw.A[i] > 0 ? raw.VF[i] / raw.A[i] * 12 : 0);
            out.Vf.push(raw.VF[i] / bbl); out.Vi.push(raw.VI[i] / bbl); out.VL.push(raw.VL[i] / bbl);
            out.VLw.push(raw.VLw[i] / bbl); out.VLc.push(raw.VLc[i] / bbl); out.VS.push(raw.VS[i] / bbl);
            out.qL.push(i === 0 ? 0 : (raw.VL[i] - raw.VL[i - 1]) / (t[i] - t[i - 1]) / u.bpm);
            out.Bw.push(raw.BW[i]);
            var gg = (i >= iS && gS != null) ? (4 / PI) * (raw.BW[i] / (ALs * _sqrt(tp)) - gS) : null;
            out.Ggen.push(gg);
            var dD = (t[i] - e.ts) / tp;
            Xa05[i] = i >= iS ? Gf(_max(0, dD), 0.5) : null; Xa1[i] = i >= iS ? Gf(_max(0, dD), 1) : null; Xgen[i] = gg;
            var b = _abs(raw.VI[i] - (raw.VF[i] - raw.VF[0] + raw.VL[i] + e.VwCw * (raw.PW[i] - raw.PW[0])));   // the initial flaw may hold a residual aperture
            if (b > bal) bal = b;
        }
        // ISIP: the fracture pressure once the wellbore over-pressure (viscous excess, friction) has redistributed — the first
        // shut-in node when there is an excess, else the pressure at the shut-in itself
        var isip = (iS + 1 < N && raw.PW[iS] > raw.P[iS] + 1e-9) ? raw.P[iS + 1] : raw.P[iS];
        var Gc05 = _xcAtClosure(Xa05, raw.P, sig, iS, N), Gc1 = _xcAtClosure(Xa1, raw.P, sig, iS, N), Gcg = _xcAtClosure(Xgen, raw.P, sig, iS, N);
        var tcMech = null;
        if (Gc05 != null && Gc05 >= 0) tcMech = e.ts + tp * GinvLocal(Gc05, 0.5, Gf);
        if (tcMech == null) tcMech = _crossTime(t, raw.P, sig, iS, N);
        var pbH = raw.ap.pbHyd(), tcHyd = (raw.ap.law === 'none') ? tcMech : _crossTime(t, raw.P, sig + pbH, iS, N);
        var Lts = raw.L[iS], Ltc = tcMech != null ? raw.L[_idxAtOrAfter(t, tcMech, N)] : null;
        var pmax = null; for (i = 0; i <= iS; i++) if (pmax === null || raw.PW[i] > pmax) pmax = raw.PW[i];
        var tStart = e.tStart, tb = raw.tb != null ? raw.tb : tStart, pb = raw.pb != null ? raw.pb : pmax;
        out.events = { tb: tb, pb: (pb > 0 && pb < 1e5) ? pb : null, ts: e.ts, isip: (isip > 0 && isip < 1e5) ? isip : null, tcMech: tcMech, tcHyd: tcHyd,
                       Gc: { a05: (Gc05 != null && Gc05 >= 0) ? Gc05 : null, a1: (Gc1 != null && Gc1 >= 0) ? Gc1 : null, gen: (Gcg != null && Gcg >= 0) ? Gcg : null } };
        out.xf = { ts: Lts, tc: Ltc };
        var dpCL = (isip > 0) ? 0.5 * (isip + sig) - e.pr : sig - e.pr;
        var CcEq = e.kap * dpCL / u.sqmin, CwD = e.Cw / u.sqmin, CLeq = CwD + CcEq;
        out.CLeq = CLeq; out.dpCL = dpCL; out.wcEq = CLeq > 0 ? CcEq / CLeq : 0;
        out.k = e.kMd > 0 ? e.kMd : null;
        var etaR = (e.kMd > 0) ? e.kMd * u.md / (e.phi * e.muRes * u.cp * e.ct) : 0;
        out.tDxfMax = (etaR > 0 && Lts > 0) ? etaR * (t[N - 1] - e.ts) / (Lts * Lts) : 0;
        out.balanceErr = bal / bbl;
        var tipS = raw.PTIP[iS], visS = raw.PVIS[iS];
        out.regime = { tipShare: (tipS + visS) > 0 ? tipS / (tipS + visS) : (e.KIc > 0 ? 1 : 0) };
        // validity diagnostics (§5.3)
        if (e.mode === 'propagate') {
            if (e.geom === 'PKN' && Lts > 0 && Lts / e.hf < 1.5) validity.push(_w('PKN_SHORT', 'warn', 'PKN needs a half-length at least 1.5 × the height; here xf/h_f = ' + _fx(Lts / e.hf, 2) + '. KGD or radial may describe it better.'));
            if (e.geom === 'KGD' && Lts > 0 && Lts / e.hf > 1) validity.push(_w('KGD_LONG', 'warn', 'KGD assumes a half-length below the height; here xf/h_f = ' + _fx(Lts / e.hf, 2) + '. PKN may describe it better.'));
            if (e.geom === 'radial' && 2 * Lts > e.hf) validity.push(_w('RADIAL_CONTAINED', 'warn', 'The radial fracture (2R = ' + _fx(2 * Lts, 0) + ' ft) exceeds the barrier spacing h_f = ' + _fx(e.hf, 0) + ' ft: a contained geometry (PKN) is more likely.'));
            if (e.geom !== 'PKN') validity.push(_w('VISC_UNCALIBRATED', 'info', 'KGD / radial pumping pressures: viscous term uncalibrated (the similarity constants are pending verification).'));
            validity.push(_w('APPARENT_TOUGHNESS', 'info', 'Apparent toughness stands in for tip and scale effects; it is not a rock property.'));
        }
        if (!(e.kap > 0)) validity.push(_w('WALL_ONLY', 'info', 'After-closure not modelled: wall-controlled leak-off does not feed the reservoir pressure.'));
        if (bal > 1e-6 * _max(raw.VI[N - 1], 1e-9)) warnings.push(_w('VOLUME_BALANCE', 'warn', 'The volume balance closes only to ' + _sci(bal / bbl, 2) + ' bbl.'));
        if (tcMech == null) warnings.push(_w('NO_CLOSURE', 'info', 'The fracture does not close within the simulated time.'));
        if (raw.why) warnings.push(_w('RUN_STOPPED', 'bad', 'The run stopped early: ' + raw.why + '. The partial result is kept.'));
        out.validity = validity; out.warnings = warnings;
        out.Vw = []; for (i = 0; i < N; i++) out.Vw.push(e.VwCw * (raw.PW[i] - raw.PW[0]) / bbl);   // wellbore compression volume (partition)
        out.ViFrac = []; for (i = 0; i < N; i++) out.ViFrac.push(out.Vi[i] - out.Vw[i]);
        // η(t) = V_f/V_i,frac (§5.5): the efficiency of the volume that entered the fracture and formation; the pumped-volume
        // efficiency V_f/V_i at shut-in is the scalar etaS (0.814 against 0.916 in the breakdown example)
        for (i = 0; i < N; i++) out.eta.push(out.ViFrac[i] > 0 ? out.Vf[i] / out.ViFrac[i] : null);
        out.parts = { qLw: [], qLc: [], qLs: [] };
        for (i = 0; i < N; i++) {
            if (i === 0) { out.parts.qLw.push(0); out.parts.qLc.push(0); out.parts.qLs.push(0); continue; }
            var dtt = (t[i] - t[i - 1]) * u.bpm;
            out.parts.qLw.push((raw.VLw[i] - raw.VLw[i - 1]) / dtt); out.parts.qLc.push((raw.VLc[i] - raw.VLc[i - 1]) / dtt); out.parts.qLs.push((raw.VS[i] - raw.VS[i - 1]) / dtt);
        }
        out.tStart = e.tStart; out.tp = tp; out.Vinj = e.ViFt3 / bbl; out.evals = raw.evals; out.N = N;
        out.etaS = raw.VI[iS] > 0 ? raw.VF[iS] / raw.VI[iS] : null;
        out.geometry = e.geom; out.sigmaC = sig; out.pr = e.pr;
        out.Af = raw.A[iS]; out.ALs = ALs; out.cf = raw.geo.cf(Lts || 1e-9); out.VwCw = e.VwCw / bbl;
        out.engine = { kap: e.kap, Cw: e.Cw, kMd: e.kMd };
        out.cfgEcho = { hf: e.hf, hp: e.hp, Ep: e.Ep, geometry: e.geom };
        return out;
    }

    function lkSample(res, t) {
        if (!res || !Array.isArray(res.t) || !res.t.length) return [];
        var ts = Array.isArray(t) ? t : [t], out = new Array(ts.length), rt = res.t, rp = res.pw, n = rt.length, i = 1;
        var sorted = true; for (var k = 1; k < ts.length; k++) if (ts[k] < ts[k - 1]) { sorted = false; break; }
        for (k = 0; k < ts.length; k++) {
            var x = ts[k];
            if (!sorted) i = 1;
            if (x <= rt[0]) { out[k] = rp[0]; continue; }
            if (x >= rt[n - 1]) { out[k] = rp[n - 1]; continue; }
            while (i < n - 1 && rt[i] < x) i++;
            var a = rp[i - 1], b = rp[i];
            if (a == null || b == null) { out[k] = null; continue; }
            var w = (x - rt[i - 1]) / (rt[i] - rt[i - 1]); out[k] = a * (1 - w) + b * w;
        }
        return Array.isArray(t) ? out : out[0];
    }
    function _atT(res, arr, x) {
        var rt = res.t, n = rt.length;
        if (x <= rt[0]) return arr[0]; if (x >= rt[n - 1]) return arr[n - 1];
        var lo = 0, hi = n - 1; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (rt[m] < x) lo = m; else hi = m; }
        var w = (x - rt[lo]) / (rt[hi] - rt[lo]); return arr[lo] * (1 - w) + arr[hi] * w;
    }
    function _qLAt(res, x) {   // leak-off rate on the step that holds x (bbl/min)
        var rt = res.t, n = rt.length; if (x >= rt[n - 1]) return res.qL[n - 1];
        for (var i = 1; i < n; i++) if (rt[i] >= x) return res.qL[i];
        return res.qL[n - 1];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Quick answers (§5.6): quick table, CL for an observed closure time, volume and rate for a visible closure
    // ─────────────────────────────────────────────────────────────────────
    function lkQuick(cfg, opts) {
        try {
            var res = lkSimulate(cfg, { grid: (opts && opts.grid) || 'display' });
            if (!res || res.ok !== true) return res && res.ok === false && res.code ? res : _fail('SIMULATION_FAILED', (res && res.why) || 'The model run failed.', []);
            var ts = res.events.ts, tc = res.events.tcMech, rows = [];
            [[1 / 60, 'At shut-in'], [5, '5 min'], [25, '25 min'], [100, '100 min']].forEach(function (r) {
                var x = ts + r[0] / 60;
                rows.push({ label: r[1], dtMin: r[0], qL: _qLAt(res, x) });
            });
            if (tc != null) rows.push({ label: 'At closure', dtMin: (tc - ts) * 60, qL: _qLAt(res, tc) });
            var n = res.t.length, xAt = tc != null ? tc : res.t[n - 1];
            var Vi = _atT(res, res.Vi, xAt), Vf = _atT(res, res.Vf, xAt), VL = _atT(res, res.VL, xAt), Vw = _atT(res, res.Vw, xAt);
            var iS = _idxAtOrAfter(res.t, ts, n);
            return {
                ok: true, rows: rows, VL: res.VL[n - 1], VLclosure: tc != null ? VL : null, eta: res.etaS,
                tc: tc != null ? tc - ts : null, tcHyd: res.events.tcHyd != null ? res.events.tcHyd - ts : null,
                xf: res.xf.ts, wAvg: res.W[iS], wMax: res.W[iS] * (res.geometry === 'radial' ? 1.5 : 4 / PI),
                partition: { frac: Vi > 0 ? Vf / Vi : null, form: Vi > 0 ? VL / Vi : null, wb: Vi > 0 ? Vw / Vi : null, at: xAt },
                CLeq: res.CLeq, wcEq: res.wcEq, k: res.k, isip: res.events.isip, warnings: res.warnings.concat(res.validity)
            };
        } catch (err) { return _fail('QUICK_FAILED', err && err.message || err, []); }
    }

    // CL (wall) or k (reservoir) that gives an observed closure time dtc (h after shut-in): bisection in log, ≈ 25 runs
    function lkSolveCL(cfg, dtcObserved, opts) {
        try {
            opts = opts || {};
            if (!(dtcObserved > 0)) return _fail('BAD_INPUT', 'An observed closure time (h after shut-in) is required.', ['dtcObserved']);
            var conv = lkToEngine(cfg); if (!conv.ok) return conv;
            var useK = (cfg.k != null && +cfg.k > 0) || (cfg.CL != null && +cfg.wc > 0.5);
            var base = _clone(cfg); base.CL = null; base.wc = null;
            var x0 = useK ? (+cfg.k > 0 ? +cfg.k : conv.e.kMd || 1e-3) : (+cfg.Cw > 0 ? +cfg.Cw : (+cfg.CL > 0 ? +cfg.CL : 1e-4));
            var runs = 0, grid = opts.grid || 'fit';
            function dtcOf(x) {
                var c = _clone(base);
                if (useK) { c.k = x; c.Cw = 0; } else { c.Cw = x; c.k = null; }
                var r = lkSimulate(c, { grid: grid }); runs++;
                if (!r || !r.ok) return null;
                return r.events.tcMech != null ? r.events.tcMech - r.events.ts : Infinity;   // no closure → longer than any observation
            }
            // closure time falls as the leak-off rises: bracket in log x, then bisect
            var lo = x0, hi = x0, dLo = dtcOf(lo), dHi = dLo, k = 0;
            if (dLo == null) return _fail('SIMULATION_FAILED', 'The model run failed.', []);
            while (dHi > dtcObserved && k < 12) { hi *= 4; dHi = dtcOf(hi); k++; if (dHi == null) return _fail('SIMULATION_FAILED', 'The model run failed.', []); }
            while (dLo < dtcObserved && k < 24) { lo /= 4; dLo = dtcOf(lo); k++; if (dLo == null) return _fail('SIMULATION_FAILED', 'The model run failed.', []); }
            if (!(dLo >= dtcObserved && dHi <= dtcObserved)) return _fail('NOT_BRACKETED', 'No leak-off coefficient in range reproduces that closure time.', ['dtcObserved']);
            var mid = _sqrt(lo * hi);
            for (var it = 0; it < 30 && hi / lo > 1 + 1e-4; it++) {
                mid = _sqrt(lo * hi);
                var dm = dtcOf(mid); if (dm == null) return _fail('SIMULATION_FAILED', 'The model run failed.', []);
                if (dm > dtcObserved) lo = mid; else hi = mid;
            }
            mid = _sqrt(lo * hi);
            var out = { ok: true, CL: null, k: null, runs: runs, solvedFor: useK ? 'k' : 'Cw' };
            if (useK) {
                out.k = mid;
                var cc = _clone(base); cc.k = mid; cc.Cw = 0;
                var rr = lkSimulate(cc, { grid: grid }); out.runs = ++runs;
                out.CL = rr && rr.ok ? rr.CLeq : null;
            } else out.CL = mid;
            return out;
        } catch (err) { return _fail('SOLVE_FAILED', err && err.message || err, []); }
    }

    // Volume × rate for a closure that is visible (R_vis ≥ 0.7) within goal.tH hours (§5.6, §6.1). A Job of ≤ 25 coarse runs
    // (opts.maxRuns) on the 6 × 6 V × q grid. A probe along V at the lowest rate (the most visible one: R_vis falls slightly
    // with the rate) finds the first visible volume; from that row on each row is scanned by rising rate, a row stops at its
    // first feasible cell and the scan at the first feasible row (the smallest volume, then the lowest rate). 3 runs are kept
    // for the refinement between the next smaller volume and the best cell; a scan cut by the budget says so. One run per step.
    function _rvis(res) { var cf = res.cf, Af = res.Af, C = Af * cf, Vw = res.VwCw * 5.614583; return (C + Vw) > 0 ? C / (C + Vw) : null; }
    function lkGoalSeekJob(cfg, goal, opts) {
        var done = false, cancelled = false, result = null, st = null, label = 'starting';
        opts = opts || {};
        function finish(r) { result = r; done = true; }
        function one(V, q) {
            var c = _clone(cfg), tp = V / q / 60, t0 = 0;
            c.schedule = [{ t: t0, q: q }, { t: t0 + tp, q: 0 }];
            c.tEnd = t0 + tp + _max(st.tH * 1.5, 1);
            var r = lkSimulate(c, { grid: 'coarse', counts: st.counts }); st.runs++;
            if (!r || !r.ok) return { V: V, q: q, dtc: null, Rvis: null, ok: false };
            var dtc = r.events.tcMech != null ? r.events.tcMech - r.events.ts : null, Rv = _rvis(r);
            return { V: V, q: q, dtc: dtc, Rvis: Rv, ok: dtc != null && dtc <= st.tH && Rv != null && Rv >= 0.7 };
        }
        function init() {
            if (!cfg || typeof cfg !== 'object') return finish(_fail('BAD_CONFIG', 'LkConfig expected.', ['cfg']));
            if (!goal || goal.kind !== 'visibleClosureBy' || !(+goal.tH > 0)) return finish(_fail('BAD_GOAL', "goal {kind:'visibleClosureBy', tH} is required.", ['goal']));
            var conv = lkToEngine(cfg); if (!conv.ok) return finish(conv);
            var Vs = (goal.V || [2, 5, 10, 20, 40, 80]).slice().sort(function (x, y) { return x - y; }), qs = (goal.q || [1, 2, 3, 5, 8, 12]).slice().sort(function (x, y) { return x - y; });
            var maxRuns = (+opts.maxRuns > 0) ? _floor(+opts.maxRuns) : 25;
            st = { tH: +goal.tH, Vs: Vs, qs: qs, iV: 0, iq: 0, table: [], best: null, runs: 0, counts: opts.counts || {}, maxRuns: maxRuns,
                   scanCap: _max(1, maxRuns - 3), phase: 'scan', ref: [], budgetHit: false, probe: true };
        }
        function scanStep() {
            if (st.runs >= st.scanCap) { st.budgetHit = st.iV < st.Vs.length; st.phase = 'refine'; return; }
            var r = one(st.Vs[st.iV], st.qs[st.iq]); st.table.push(r);
            if (r.ok) { st.best = r; st.phase = 'refine'; return; }
            if (st.probe) {   // probe along V at the lowest rate (the most visible one) for the first visible volume
                if (r.Rvis != null && r.Rvis >= 0.7) { st.probe = false; st.iq = 1; if (st.iq >= st.qs.length) endRow(); return; }
                st.iV++; if (st.iV >= st.Vs.length) st.phase = 'refine';
                return;
            }
            st.iq++;
            if (st.iq >= st.qs.length) endRow();
        }
        function endRow() { st.iq = 0; st.iV++; if (st.iV >= st.Vs.length) st.phase = 'refine'; }
        function refineInit() {
            st.phase = 'refining';
            if (!st.best) return;
            var iV = st.Vs.indexOf(st.best.V);
            if (iV > 0) { var vLo = st.Vs[iV - 1]; for (var m = 1; m <= 3; m++) st.ref.push(+(vLo + (st.best.V - vLo) * m / 4).toPrecision(3)); }
        }
        function finalise() {
            var best = st.best, tH = st.tH;
            var text = best ? ('A closure visible within ' + _sig(tH, 3) + ' h needs about ' + _sig(best.V, 3) + ' bbl at ' + _sig(best.q, 3) + ' bbl/min.')
                            : ('No scanned volume and rate gives a visible closure within ' + _sig(tH, 3) + ' h' + (st.budgetHit ? ' (the scan stopped at its ' + st.maxRuns + '-run budget at ' + _sig(st.Vs[_min(st.iV, st.Vs.length - 1)], 3) + ' bbl).' : '.'));
            finish({ ok: true, V: best ? best.V : null, q: best ? best.q : null, runs: st.runs, table: st.table, budgetHit: st.budgetHit, text: text.slice(0, 299) });
        }
        function step() {
            if (done) return { done: true, progress: 1, label: label };
            try {
                if (!st) { init(); if (done) return { done: true, progress: 1, label: 'failed' }; label = 'scan'; return { done: false, progress: 0, label: label }; }
                if (cancelled) { finish(_fail('CANCELLED', 'The goal-seek was cancelled.', [])); return { done: true, progress: 1, label: 'cancelled' }; }
                if (st.phase === 'scan') scanStep();
                else {
                    if (st.phase === 'refine') refineInit();
                    if (st.ref.length && st.runs < st.maxRuns) {
                        var rr = one(st.ref.shift(), st.best.q); st.table.push(rr);
                        if (rr.ok && rr.V < st.best.V) { st.best = rr; st.ref = []; }
                    } else st.ref = [];
                    if (!st.ref.length) { finalise(); return { done: true, progress: 1, label: 'done' }; }
                }
                label = (st.phase === 'scan' ? 'scan' : 'refinement') + ', run ' + st.runs + ' of at most ' + st.maxRuns;
                return { done: false, progress: _min(0.99, st.runs / st.maxRuns), label: label };
            } catch (err) { finish(_fail('GOALSEEK_FAILED', err && err.message || err, [])); return { done: true, progress: 1, label: 'failed' }; }
        }
        return { step: step, result: function () { return result; }, cancel: function () { cancelled = true; } };
    }
    function lkGoalSeek(cfg, goal, opts) {
        try { return _drain(lkGoalSeekJob(cfg, goal, opts)); } catch (err) { return _fail('GOALSEEK_FAILED', err && err.message || err, []); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Identifiable groups (§5.6, D15): Γ = r_p·CL·A_f/C_sys = 2·m_G/(π·√tp), Γ_PKN = r_p·CL·E′/h_f
    // ─────────────────────────────────────────────────────────────────────
    function lkGroups(x) {
        try {
            var res = x, cfg = null;
            if (!x || !x.events) { cfg = x; res = lkSimulate(x, { grid: 'fit' }); }
            if (!res || res.ok !== true) return _fail('SIMULATION_FAILED', (res && (res.why || (res.errors && res.errors[0]))) || 'The model run failed.', []);
            var hf = cfg ? +cfg.hf : null, hp = cfg ? +cfg.hp : null, Ep = cfg ? +cfg.Ep : null;
            if (res.cfgEcho) { hf = res.cfgEcho.hf; hp = res.cfgEcho.hp; Ep = res.cfgEcho.Ep; }
            var rp = (hf > 0 && hp > 0) ? _min(1, hp / hf) : (res.Af > 0 ? res.ALs / res.Af : 1);
            var C = res.Af * res.cf + res.VwCw * 5.614583;
            var Gamma = C > 0 ? rp * res.CLeq * res.Af / C : null;
            var GammaPKN = (Ep > 0 && hf > 0) ? rp * res.CLeq * Ep / hf : null;
            var tpMin = res.tp * 60, mG = Gamma != null ? Gamma * PI * _sqrt(tpMin) / 2 : null, Rvis = C > 0 ? res.Af * res.cf / C : null;
            return { ok: true, Gamma: Gamma, GammaPKN: GammaPKN, mG: mG, Rvis: Rvis, CL: res.CLeq,
                     text: 'This falloff fixes Γ = r_p·CL·A_f/C_sys = 2·m_G/(π·√tp) = ' + _sig(Gamma, 4) + ' psi/√min' +
                           (GammaPKN != null ? ' (' + (res.geometry === 'PKN' ? 'PKN form' : 'PKN-equivalent') + ' r_p·CL·E′/h_f = ' + _sig(GammaPKN, 5) + '); CL is conditional on E′ = ' + _sci(Ep, 2) + ' psi and h_f = ' + _sig(hf, 3) + ' ft.' : '.') };
        } catch (err) { return _fail('GROUPS_FAILED', err && err.message || err, []); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Leak budget (§6.4): q_k,max = ε·V/(Θ·t_end), Θ = p_D/p_D′ of the expected regime at t_end; pressure-test hold
    // The regime comes from t_DL(t_end), in order of precedence:
    //   ctx.tDLDraws  t_DL(t_end) per draw (dimensionless; the designer passes these) → the P90 is used
    //   ctx.tDL       one t_DL(t_end)
    //   ctx.kDraws    permeability draws in md (the §3.7 name): converted with t_DL = C_TDL·k·t_end/(φ·μ·c_t·L²), which needs
    //                 ctx.phi, ctx.muRes (cp), ctx.ct (1/psi) and ctx.L (ft); without them the draws are not used (warning
    //                 LEAK_KDRAWS_UNUSED) and the budget assumes linear flow
    // ─────────────────────────────────────────────────────────────────────
    function leakBudget(V, tEnd, ctx) {
        try {
            ctx = ctx || {};
            if (!(V > 0) || !(tEnd > 0)) return _fail('BAD_INPUT', 'Injected volume (bbl) and shut-in duration (h) are required.', ['V', 'tEnd']);
            var eps = (+ctx.eps > 0) ? +ctx.eps : 0.05, tDL = null, warnings = [];
            var finiteList = function (a) { return a.filter(function (v) { return _okn(v) && v >= 0; }); };
            if (Array.isArray(ctx.tDLDraws) && finiteList(ctx.tDLDraws).length) tDL = _p3(finiteList(ctx.tDLDraws)).p90;
            else if (_okn(ctx.tDL)) tDL = ctx.tDL;
            else if (Array.isArray(ctx.kDraws) && finiteList(ctx.kDraws).length) {
                var phi = +ctx.phi, mu = +ctx.muRes, ct = +ctx.ct, Lx = +ctx.L;
                if (phi > 0 && mu > 0 && ct > 0 && Lx > 0) {
                    tDL = _p3(finiteList(ctx.kDraws).map(function (k) { return C_TDL * k * tEnd / (phi * mu * ct * Lx * Lx); })).p90;
                } else {
                    warnings.push(_w('LEAK_KDRAWS_UNUSED', 'warn', 'Permeability draws need φ, μ, c_t and the leak-off length L to give t_DL; linear flow (Θ = 2) is assumed.'));
                }
            }
            var radial = tDL != null && tDL >= 1, th = radial ? theta(tDL) : 2;
            var tD = tEnd / 24, qkMax = eps * V / (th * tD);   // bbl/d
            var sigmaP = (+ctx.sigmaP > 0) ? +ctx.sigmaP : 0.05, VwCw = (+ctx.VwCw > 0) ? +ctx.VwCw : null;
            var holdMin = VwCw != null ? 5 * sigmaP * VwCw / qkMax * 1440 : null;
            var dpdT = (+ctx.dpdT > 0) ? +ctx.dpdT : (_isFinite(+ctx.tempF) && ctx.tempF != null ? 65 + _max(0, _min(1, (+ctx.tempF - 100) / 150)) * 40 : 65);
            var dTneeded = 5 * sigmaP / dpdT, realistic = dTneeded >= ((+ctx.dTmin > 0) ? +ctx.dTmin : 0.05);
            var regime = radial ? 'radial' : 'linear';
            var text = 'A leak below ' + _sig(qkMax, 2) + ' bbl/d biases the after-closure signal by less than ' + _fx(eps * 100, 0) + ' % at ' + _sig(tEnd, 3) + ' h (' + regime +
                       ' flow, Θ = ' + _fx(th, 2) + ').' + (holdMin != null ? ' A pressure-test hold of ' + _sig(holdMin, 2) + ' min proves it only if the column stays within ' + _sig(dTneeded, 1) + ' °F' +
                       (realistic ? '.' : ', which is unrealistic: prove the leak after the fact with the leak plot instead.') : '');
            return { ok: true, qkMax: qkMax, theta: th, regime: regime, tDL: tDL, holdMin: holdMin, dTneeded: dTneeded, holdRealistic: realistic, dpdT: dpdT, text: text.slice(0, 299), warnings: warnings };
        } catch (err) { return _fail('LEAK_BUDGET_FAILED', err && err.message || err, []); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Verification vectors (§5.4): V1–V14 (each case can be run alone with {only:[ids]})
    // ─────────────────────────────────────────────────────────────────────
    // general-α Nolte g by quadrature (a = 1 − (1 − u)², 400 midpoints): used for η with the model's own α (V4)
    function gGeneral(d, al) {
        var n = 400, s = 0;
        for (var i = 0; i < n; i++) { var u = (i + 0.5) / n, a = 1 - (1 - u) * (1 - u), da = 2 * (1 - u) / n; s += _sqrt(_max(0, 1 + d - _pow(a, 1 / al))) * da; }
        return 2 * s;
    }
    function _baseCfg(o) { var c = lkDefaults(); for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k]; return c; }
    var TP = 5 / 60;
    var VCASES = {
        V1a: function () { return _vNolte(1, 0); },
        V1b: function () { return _vNolte(0.5, 0); },
        V1c: function () {
            var out = [];
            [[50, 2], [200, 0.5], [800, 0.25], [3200, 0.1]].forEach(function (g) {
                var r = _vNolteRun(0.5, 0, { dt0: g[1] / 3600, r: 1.08, maxFrac: 1 / 60, nShut: g[0] });
                out.push({ N: r.t.length, Gc: _gcExtrap(r, 0.5) });
            });
            return { grids: out };
        },
        V1d: function () {
            var r = _vNolteRun(0.5, BASE_VWCW_FT3), iS = _idxAtOrAfter(r.t, r.events.ts, r.t.length), isip = r.pf[iS];
            return { isip: isip, Gc: _gcExtrap(r, 0.5), GcExpected: (isip - 7000) * (1 + BASE_VWCW_FT3 / (13404 * 1.571e-5)) / 33.322 };
        },
        V2: function () {
            var u = _units(), out = [];
            [[1.863e-4, 0], [1.863e-4, 2], [1e-3, 0], [1e-3, 5], [5e-3, 0]].forEach(function (cs) {
                var r = lkSimulate(_baseCfg({ mode: 'constP', constPbar: 600, hp: 50, Cw: cs[0], Sp: cs[1], VwCw: 0, KIc: 0, schedule: [{ t: 0, q: 5 }, { t: 0.5, q: 0 }], tEnd: 0.51, p0: 7600 }),
                    { grid: { dt0: 0.25 / 3600, r: 1.05, maxFrac: 1 / 200, nShut: 10 } });
                var w = PI * 50 / (2 * 5e6) * 600, C = cs[0] * u.sqmin, we = w + 2 * cs[1] * u.galp100, q = 5 * u.bpm, maxe = 0, Aend = null;
                for (var i = 1; i < r.t.length; i++) {
                    if (r.t[i] > 0.5 + 1e-12) break;
                    var x = 2 * C * _sqrt(PI * r.t[i]) / we, Aex = q * we / (4 * PI * C * C) * (erfcx(x) + 2 * x / SQPI - 1);
                    if (r.t[i] > 10 / 3600) maxe = _max(maxe, _abs(r.A[i] - Aex) / Aex);
                    Aend = r.A[i];
                }
                var xe = 2 * C * _sqrt(PI * 0.5) / we;
                out.push({ CL: cs[0], Sp: cs[1], A: Aend, Acarter: q * we / (4 * PI * C * C) * (erfcx(xe) + 2 * xe / SQPI - 1), maxRelErr: maxe });
            });
            return { cases: out };
        },
        V3: function () {
            var u = _units(), out = [], K = KVISC, Ep = 5e6, hf = 50, mu = u.cp, q = 5 * u.bpm;
            function law(g, t, KI) {
                if (g === 'PKN') return _pow(2 / (PI * K.PKN), 0.8) * _pow(Ep * _pow(q / 2, 3) * _pow(t, 4) / (mu * _pow(hf, 4)), 0.2);
                if (g === 'KGD') return KI ? _pow(q * t * Ep / (2 * SQPI * hf * KI), 2 / 3) : _pow(PI * K.KGD, -2 / 3) * _pow(Ep * _pow(q / 2, 3) * _pow(t, 4) / (mu * _pow(hf, 3)), 1 / 6);
                if (KI) { var Kp = 4 * _sqrt(2 / PI) * KI; return 0.8546 * _pow(Ep * q * t / Kp, 0.4); }
                return _pow(3 / (16 * K.radial), 4 / 9) * _pow(Ep * q * q * q * _pow(t, 4) / mu, 1 / 9);
            }
            [['PKN', 0], ['KGD', 0], ['radial', 0], ['KGD', 1000], ['radial', 1000]].forEach(function (cs) {
                var r = lkSimulate(_baseCfg({ geometry: cs[0], KIc: cs[1], muCp: cs[1] ? 0 : 1, L0: 0.01, Cw: 0, VwCw: 0, hp: 50, tEnd: TP + 0.01, p0: 7000 }),
                    { grid: { dt0: 0.1 / 3600, r: 1.05, maxFrac: 1 / 300, nShut: 10 } });
                var i5 = _idxAtOrAfter(r.t, TP, r.t.length), ia = _idxAtOrAfter(r.t, 2.5 / 60, r.t.length), maxDev = 0;
                for (var i = 1; i <= i5; i++) if (r.t[i] >= 0.1 / 60) maxDev = _max(maxDev, _abs(r.L[i] / law(cs[0], r.t[i], cs[1] * u.psiin) - 1));
                out.push({ geometry: cs[0], vertex: cs[1] ? 'K' : 'M', L5: r.L[i5], exponent: _log(r.L[i5] / r.L[ia]) / _log(r.t[i5] / r.t[ia]), eta: r.etaS, maxLawDev: maxDev });
            });
            var KIp = 1000 * u.psiin;   // toughness prefactors under K′ = 4·√(2/π)·K_Ic: KGD (2√2/π)^(2/3), radial 0.8546
            return { cases: out, prefKGD: _pow(2 * _sqrt(2) / PI, 2 / 3), prefRadial: 0.8546, KIp: KIp };
        },
        V4: function () {
            var out = [];
            [1e-6, 1e-4, 1e-3, 3e-2].forEach(function (cl) {
                var r = lkSimulate(_baseCfg({ KIc: 0, hp: 50, Cw: cl, VwCw: 0, L0: 0.01, p0: 7000, tEnd: TP + (cl < 1e-5 ? 1 : 400) }),
                    { grid: { dt0: 0.1 / 3600, r: 1.05, maxFrac: 1 / 300, nShut: cl < 1e-5 ? 50 : 1500 } });
                var i5 = _idxAtOrAfter(r.t, TP, r.t.length), ia = _idxAtOrAfter(r.t, TP / 2, r.t.length);
                var al = _log(r.A[i5] / r.A[ia]) / _log(r.t[i5] / r.t[ia]), etaG = null;
                if (r.events.Gc.a05 != null) {
                    var Gf = Gfn(), dtc = GinvLocal(r.events.Gc.a05, 0.5, Gf), gc = gGeneral(dtc, al), g0 = gGeneral(0, al);
                    etaG = (gc - g0) / gc;
                }
                out.push({ CL: cl, alphaA: al, etaS: r.etaS, etaG: etaG });
            });
            return { cases: out };
        },
        V5: function () {
            var u = _units(), VwCwB = BASE_VWCW_FT3 / u.bbl;
            var r = lkSimulate(_baseCfg({ pBd: 9500, p0: 4500, KIc: 0, k: null, CL: 1.863e-4, wc: 1, dpRef: 2500, VwCw: VwCwB }), { grid: { dt0: 0.25 / 3600, r: 1.08, maxFrac: 1 / 60, nShut: 300 } });
            return { dpdt: (r.pw[5] - r.pw[0]) / (r.t[5] - r.t[0]) / 60, expected: 5 * u.bpm / BASE_VWCW_FT3 / 60, ok: r.ok };
        },
        V6: function () {
            var r = lkSimulate(_baseCfg({ KIc: 0, CL: 1.863e-4, wc: 1, dpRef: 2500, Cw: 0, tEnd: TP + 500 }), { grid: { dt0: 0.25 / 3600, r: 1.08, maxFrac: 1 / 60, nShut: 1900 } });
            var u = _units(), Cc = 1.863e-4 * u.sqmin, n = r.t.length, ALf = r.AL[n - 1], out = [];
            [20, 50, 100, 200].forEach(function (th) {
                var i = _idxAtOrAfter(r.t, TP + th, n), j = i; while (r.t[j] > r.t[i] / 1.2) j--;
                var Vt = r.VLc[i] * u.bbl / (2 * ALf), asym = Vt * 2500 / (PI * Cc);
                out.push({ tH: th, ratio: (r.pf[i] - 4500) * _sqrt(r.t[i]) / asym, slope: _log((r.pf[i] - 4500) / (r.pf[j] - 4500)) / _log(r.t[i] / r.t[j]) });
            });
            return { k: r.k, points: out };
        },
        V7: function () {
            var u = _units(), r = lkSimulate(_baseCfg({ KIc: 3000, pBd: 9500, p0: 4500, CL: 1.863e-4, wc: 0.5, dpRef: 2500, Sp: 1, VwCw: BASE_VWCW_FT3 / u.bbl,
                pdl: { Cd: 0.002, pfo: 7000, fmax: 20 }, aperture: { law: 'hyp', sh: 60, sc: 100, fres: 0.1, sr: null }, nwb: { a: 1.528, b: 140.9, beta: 0.5 }, tEnd: TP + 200 }),
                { grid: { dt0: 0.25 / 3600, r: 1.08, maxFrac: 1 / 60, nShut: 800 } });
            var n = r.t.length;
            return { balanceErr: r.balanceErr, Vi: r.Vi[n - 1], ok: r.ok };
        },
        V8: function () {
            var r = lkSimulate(lkDefaults(), { grid: { dt0: 0.25 / 3600, r: 1.08, maxFrac: 1 / 60, nShut: 1600 } });
            return { xf: r.xf.ts, pn: r.events.isip - 7000, eta: r.etaS, dtc: (r.events.tcMech - r.events.ts) * 60, ref: { xf: 131.2, pn: 600, eta: 0.900, dtc: 305.1 } };
        },
        V9: function () {
            var r = lkSimulate(_baseCfg({ KIc: 0, Cw: 0, k: 0.1, farField: true, tEnd: TP + 2000 }), { grid: { dt0: 0.25 / 3600, r: 1.08, maxFrac: 1 / 60, nShut: 1900 } });
            var u = _units(), n = r.t.length, kk = 0.1 * u.md, eta = kk / (0.06 * 0.5 * u.cp * 1e-5), xe = r.xf.ts, Vtot = r.VLc[n - 1] * u.bbl, out = [];
            [50, 200, 500, 1000, 2000].forEach(function (th) {
                var i = _idxAtOrAfter(r.t, TP + th - 1e-9, n), j = i; while (r.t[j] > r.t[i] / 1.2) j--;
                var rad = Vtot * 0.5 * u.cp / (4 * PI * kk * 40 * r.t[i]);
                out.push({ tH: th, tD: eta * r.t[i] / (xe * xe), slope: _log((r.pf[i] - 4500) / (r.pf[j] - 4500)) / _log(r.t[i] / r.t[j]), dpOverRadial: (r.pf[i] - 4500) / rad });
            });
            return { xe: xe, points: out };
        },
        V10: function () {
            var r = lkSimulate(_baseCfg({ pBd: 9500, p0: 4500 }), { grid: { dt0: 0.25 / 3600, r: 1.08, maxFrac: 1 / 60, nShut: 1600 } });
            var Gf = Gfn(), out = [], n = r.t.length, ts = r.events.ts;
            [1, 5, 15, 30, 60, 120, 240].forEach(function (m) {
                var i = _idxAtOrAfter(r.t, ts + m / 60, n), j = i + 1, dG = r.Ggen[j] - r.Ggen[i - 1];
                var dGn = Gf((r.t[j] - ts) / r.tp, 0.5) - Gf((r.t[i - 1] - ts) / r.tp, 0.5);
                out.push({ dtMin: m, dPdGgen: (r.pf[j] - r.pf[i - 1]) / dG, dPdGa05: (r.pf[j] - r.pf[i - 1]) / dGn });
            });
            return { points: out };
        },
        V13: function () {
            var out = [];
            [[0.5, 'a05'], [1, 'a1'], [0, 'const']].forEach(function (cs) {
                var r = _vNolteRun(cs[0], 0, { dt0: 0.001 / 3600, r: 1.03, maxFrac: 1 / 400, nShut: 600 }), n = r.t.length, ts = r.events.ts, maxe = 0, ALs = r.AL[_idxAtOrAfter(r.t, ts, n)];
                for (var i = 0; i < n; i++) {
                    if (r.t[i] < ts + 1 / 60) continue;
                    var d = (r.t[i] - ts) / TP, g = r.Bw[i] / (ALs * _sqrt(TP)), gx = cs[0] === 0 ? 2 * _sqrt(1 + d) : gN(d, cs[0]);
                    maxe = _max(maxe, _abs(g - gx) / gx);
                }
                out.push({ alpha: cs[1], maxRelErr: maxe });
            });
            return { cases: out };
        },
        V14: function () {
            var ex = makeAperture({ law: 'exp', sc: 100, fres: 0.1, sr: 2000 }), hy = makeAperture({ law: 'hyp', sh: 60 }), exInf = makeAperture({ law: 'exp', sc: 100, fres: 0.1, sr: 1e9 });
            var minW = Infinity, minC = Infinity;
            for (var x = 0; x <= 3000; x += 5) { minW = _min(minW, ex.W(-x, 1), hy.W(-x, 1)); minC = _min(minC, ex.rel(-x), hy.rel(-x)); }
            return { minW: minW, minC: minC, hydExp: -ex.pbHyd() / 100, hydExpInf: -exInf.pbHyd() / 100, hydHyp: -hy.pbHyd() / 60, hydHypExpected: _sqrt(2) - 1 };
        }
    };
    function _vNolteRun(alpha, VwCwFt3, grid) {
        var u = _units();
        return lkSimulate(_baseCfg({ mode: 'prescribed', prescribed: { tp: TP, Ap: 13404, alpha: alpha, rp: 0.8, cf: 1.571e-5 }, Cw: 1.863e-4, k: null,
            VwCw: VwCwFt3 / u.bbl, tEnd: TP + 12, p0: 7000 }), { grid: grid || { dt0: 0.25 / 3600, r: 1.08, maxFrac: 1 / 60, nShut: 1500 } });
    }
    function _gcExtrap(r, al) {   // G_c from the last two open samples, linear in G (exact for Nolte)
        var Gf = Gfn(), n = r.t.length, ts = r.events.ts, i = n - 1;
        while (i > 0 && r.pf[i] < 7000) i--;
        var G1 = Gf((r.t[i - 1] - ts) / TP, al), G2 = Gf((r.t[i] - ts) / TP, al);
        return G2 + (7000 - r.pf[i]) * (G2 - G1) / (r.pf[i] - r.pf[i - 1]);
    }
    function _vNolte(alpha, VwCwFt3) {
        var r = _vNolteRun(alpha, VwCwFt3), u = _units(), n = r.t.length, ts = r.events.ts, iS = _idxAtOrAfter(r.t, ts, n), isip = r.pf[iS];
        var CL = 1.863e-4 * u.sqmin, mG = PI * 0.8 * CL * _sqrt(TP) / (2 * 1.571e-5), maxV = 0, maxP = 0, Gf = Gfn();
        for (var i = iS + 1; i < n; i++) {
            if (r.pf[i] <= 7000) break;
            var d = (r.t[i] - ts) / TP, VLex = 2 * 0.8 * 13404 * CL * _sqrt(TP) * gN(d, alpha);
            maxV = _max(maxV, _abs(r.VL[i] * u.bbl - VLex) / VLex);
            maxP = _max(maxP, _abs(r.pf[i] - (isip - mG * Gf(d, alpha))));
        }
        var Gc = _gcExtrap(r, alpha);
        return { isip: isip, eta: r.etaS, Gc: Gc, dtcMin: GinvLocal(Gc, alpha, Gf) * TP * 60, maxRelErrVL: maxV, maxDevP: maxP, mG0: mG, N: n };
    }
    function lkVerify(opts) {
        try {
            var only = opts && Array.isArray(opts.only) ? opts.only : Object.keys(VCASES), out = { ok: true };
            only.forEach(function (id) { if (VCASES[id]) out[id] = VCASES[id](); });
            return out;
        } catch (err) { return _fail('VERIFY_FAILED', err && err.message || err, []); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // History match (§5.7): Levenberg–Marquardt in transformed parameters (log k, log C_w, …), forward-difference Jacobian
    // (n_p + 1 runs per iteration), run budget, honest uncertainty (n_eff inflation, structural spread), sloppy directions.
    // Exposed as a Job (one LM iteration per step) next to the synchronous function with the identical result.
    // ─────────────────────────────────────────────────────────────────────
    // parameter catalogue: transform, how to read / write it on an LkConfig, default bounds
    var PDEF = {
        k: { log: true, get: function (c) { return c.k; }, set: function (c, v) { c.k = v; }, lo: 1e-7, hi: 100, label: 'permeability', unit: 'md' },
        Cw: { log: true, get: function (c) { return c.Cw; }, set: function (c, v) { c.Cw = v; }, lo: 1e-7, hi: 1e-1, label: 'the wall coefficient', unit: 'ft/√min' },
        Sp: { log: true, get: function (c) { return c.Sp; }, set: function (c, v) { c.Sp = v; }, lo: 1e-3, hi: 20, label: 'spurt', unit: 'gal/100 ft²' },
        sigmaC: { log: false, get: function (c) { return c.sigmaC; }, set: function (c, v) { c.sigmaC = v; }, lo: null, hi: null, label: 'closure stress', unit: 'psia', pressure: true },
        pr: { log: false, get: function (c) { return c.pr; }, set: function (c, v) { c.pr = v; }, lo: 0, hi: null, label: 'pore pressure', unit: 'psia', pressure: true },
        Ep: { log: true, get: function (c) { return c.Ep; }, set: function (c, v) { c.Ep = v; }, lo: 3e5, hi: 1e7, label: 'E′', unit: 'psi' },
        hf: { log: true, get: function (c) { return c.hf; }, set: function (c, v) { c.hf = v; }, lo: null, hi: null, label: 'fracture height', unit: 'ft' },
        KIc: { log: true, get: function (c) { return c.KIc; }, set: function (c, v) { c.KIc = v; }, lo: 500, hi: 50000, label: 'apparent toughness', unit: 'psi·√in' },
        sh: { log: true, get: function (c) { return c.aperture.sh; }, set: function (c, v) { c.aperture.sh = v; }, lo: 1, hi: 2000, label: 'contact scale', unit: 'psi' },
        sc: { log: true, get: function (c) { return c.aperture.sc; }, set: function (c, v) { c.aperture.sc = v; }, lo: 1, hi: 2000, label: 'contact scale', unit: 'psi' },
        Cd: { log: false, get: function (c) { return c.pdl.Cd; }, set: function (c, v) { c.pdl.Cd = _max(0, v); }, lo: 0, hi: 0.05, label: 'the PDL coefficient', unit: '1/psi' },
        pfo: { log: false, get: function (c) { return c.pdl.pfo == null ? c.sigmaC : c.pdl.pfo; }, set: function (c, v) { c.pdl.pfo = v; }, lo: null, hi: null, label: 'the fissure-opening pressure', unit: 'psia', pressure: true },
        VwCw: { log: true, get: function (c) { return c.VwCw; }, set: function (c, v) { c.VwCw = v; }, lo: null, hi: null, label: 'wellbore storage', unit: 'bbl/psi' }
    };
    function _presetFree(preset, cfg) {
        var res = (cfg.k != null && +cfg.k > 0) || (+cfg.Cw > 0 === false), lk = res ? 'k' : 'Cw', law = (cfg.aperture && cfg.aperture.law) || 'none';
        var contact = law === 'hyp' ? ['sh'] : (law === 'exp' ? ['sc'] : []);
        var wall = (+cfg.Cw > 0 && res) ? ['Cw'] : [];
        var f;
        if (preset === 'falloff') f = [lk, 'sigmaC'].concat(contact);
        else if (preset === 'geometry') f = [lk, 'KIc', 'sigmaC'].concat(contact, res ? ['pr'] : [], wall, ['Ep']);
        else if (preset === 'pdl') f = [lk, 'KIc', 'sigmaC'].concat(contact, res ? ['pr'] : [], wall, ['Cd', 'pfo']);
        else if (preset === 'spurt') f = [lk, 'sigmaC'].concat(contact, res ? ['pr'] : [], wall, ['Sp']);
        else f = [lk, 'KIc', 'sigmaC'].concat(contact, res ? ['pr'] : [], wall);
        return f;
    }
    function _freeRules(free) {
        var w = [];
        if (free.indexOf('Ep') >= 0 && free.indexOf('hf') >= 0) w.push(_w('GROUP_FREE', 'warn', 'E′ and the fracture height are both free: only their group is determined; free one member, read σ_c from that fit and report Γ.'));
        if (free.indexOf('KIc') >= 0 && free.indexOf('Ep') >= 0) w.push(_w('TOUGHNESS_EP', 'warn', 'Apparent toughness is best freed only with E′ fixed: the two trade off along the Γ direction.'));
        return w;
    }

    // n_eff = n·(1 − ρ1)/(1 + ρ1) from the lag-1 autocorrelation of the residuals; intervals inflate by √(n/n_eff)
    function _neff(e) {
        var n = e.length, sumE2 = 0, sumL = 0;
        for (var i = 0; i < n; i++) { sumE2 += e[i] * e[i]; if (i > 0) sumL += e[i] * e[i - 1]; }
        var rho1 = sumE2 > 0 ? sumL / sumE2 : 0, nEff = rho1 > 0 ? n * (1 - rho1) / (1 + rho1) : n;
        return { rho1: rho1, nEff: nEff, inflation: _sqrt(n / _max(nEff, 1)) };
    }
    function _median(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b.length ? _pct(b, 0.5) : 0; }
    function _sigmaFromData(t, p) {   // late falloff: σ_p = 1.4826·MAD(second differences)/√6 over the last 30 % of the points
        var n = p.length, i0 = _max(1, _floor(n * 0.7)), d = [];
        for (var i = i0; i < n - 1; i++) d.push(p[i + 1] - 2 * p[i] + p[i - 1]);
        if (d.length < 5) return null;
        var m = _median(d), dev = d.map(function (x) { return _abs(x - m); });
        var s = 1.4826 * _median(dev) / _sqrt(6);
        return s > 0 ? s : null;
    }
    // falloff data → ≤ nMax log-spaced points after the shut-in (injection weight 0 by default)
    function _prepData(data, ts, nMax) {
        var t = [], p = [], w = [];
        for (var i = 0; i < data.t.length; i++) {
            var ti = +data.t[i], pi = +data.p[i], wi = data.w ? +data.w[i] : 1;
            if (!_isFinite(ti) || !_isFinite(pi) || !(wi > 0)) continue;
            if (ti <= ts + 1e-9 && !(data.w && wi > 0 && data.injection)) continue;
            t.push(ti); p.push(pi); w.push(wi);
        }
        if (t.length > nMax) {
            var lt0 = _log(t[0] - ts), lt1 = _log(t[t.length - 1] - ts), pick = [], j = 0;
            for (var k = 0; k < nMax; k++) {
                var target = ts + _exp(lt0 + (lt1 - lt0) * k / (nMax - 1));
                while (j < t.length - 1 && _abs(t[j + 1] - target) <= _abs(t[j] - target)) j++;
                if (!pick.length || pick[pick.length - 1] !== j) pick.push(j);
            }
            t = pick.map(function (q) { return t[q]; }); p = pick.map(function (q) { return p[q]; }); w = pick.map(function (q) { return w[q]; });
        }
        return { t: t, p: p, w: w };
    }
    function _solveLin(A, b) {   // Gaussian elimination with partial pivoting (small systems)
        var n = b.length, M = A.map(function (r, i) { return r.slice().concat([b[i]]); });
        for (var i = 0; i < n; i++) {
            var pv = i; for (var k = i + 1; k < n; k++) if (_abs(M[k][i]) > _abs(M[pv][i])) pv = k;
            var tmp = M[i]; M[i] = M[pv]; M[pv] = tmp;
            if (!(_abs(M[i][i]) > 1e-300)) return null;
            for (k = i + 1; k < n; k++) { var f = M[k][i] / M[i][i]; for (var j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
        }
        var x = new Array(n);
        for (i = n - 1; i >= 0; i--) { var s = M[i][n]; for (j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
        return x;
    }
    function _inv(A) {
        var n = A.length, cols = [];
        for (var j = 0; j < n; j++) { var e = new Array(n); for (var i = 0; i < n; i++) e[i] = i === j ? 1 : 0; var c = _solveLin(A, e); if (!c) return null; cols.push(c); }
        var out = []; for (i = 0; i < n; i++) { out.push([]); for (j = 0; j < n; j++) out[i].push(cols[j][i]); }
        return out;
    }
    function _jacobiEig(S) {
        var n = S.length, a = S.map(function (r) { return r.slice(); }), V = [];
        for (var i = 0; i < n; i++) { V.push([]); for (var j = 0; j < n; j++) V[i].push(i === j ? 1 : 0); }
        for (var sweep = 0; sweep < 100; sweep++) {
            var off = 0; for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
            if (off < 1e-24) break;
            for (var p = 0; p < n; p++) for (var q = p + 1; q < n; q++) {
                if (_abs(a[p][q]) < 1e-300) continue;
                var th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = (th >= 0 ? 1 : -1) / (_abs(th) + _sqrt(th * th + 1)), c = 1 / _sqrt(t * t + 1), s = t * c, k;
                for (k = 0; k < n; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
                for (k = 0; k < n; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
                for (k = 0; k < n; k++) { var vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
            }
        }
        var idx = []; for (i = 0; i < n; i++) idx.push(i);
        idx.sort(function (x, y) { return a[x][x] - a[y][y]; });
        return { vals: idx.map(function (i2) { return a[i2][i2]; }), vecs: idx.map(function (i2) { return V.map(function (r) { return r[i2]; }); }) };
    }

    // ln G(Δt_D, α = ½) at the falloff times (null before or at the shut-in)
    function _lnGAt(t, ts, tp) {
        var Gf = Gfn(), out = new Array(t.length);
        for (var i = 0; i < t.length; i++) { var d = (t[i] - ts) / tp, gv = d > 0 ? Gf(d, 0.5) : 0; out[i] = gv > 0 ? _log(gv) : null; }
        return out;
    }
    // Bourdet derivative −dp/dx with the window L in x (x = ln G, so −dp/dln G = −G·dP/dG); null without a point L away on both sides
    function _bourdetLn(x, p, L) {
        var n = x.length, out = new Array(n), j, k;
        for (var i = 0; i < n; i++) {
            out[i] = null;
            if (x[i] == null || p[i] == null) continue;
            var l = -1, r = -1;
            for (j = i - 1; j >= 0; j--) { if (x[j] == null) break; if (x[i] - x[j] >= L) { l = j; break; } }
            for (k = i + 1; k < n; k++) { if (x[k] != null && x[k] - x[i] >= L) { r = k; break; } }
            if (l < 0 || r < 0 || p[l] == null || p[r] == null) continue;
            var dl = x[i] - x[l], dr = x[r] - x[i], sl = (p[i] - p[l]) / dl, sr = (p[r] - p[i]) / dr;
            out[i] = -(sl * dr + sr * dl) / (dl + dr);
        }
        return out;
    }

    // model: transformed vector → pressures at the data times (one forward run on the fixed grid)
    function _makeModel(cfg0, keys, tData, opts, counts) {
        var conv = lkToEngine(cfg0);
        if (!conv.ok) return { ok: false, fail: conv };
        var e0 = conv.e, gs = _gridSpec(opts.grid || 'fit'), grid = buildGrid(e0, gs);   // grid fixed by schedule and t_end only
        function cfgOf(x) {
            var c = _clone(cfg0); c.CL = null; c.wc = null;
            for (var i = 0; i < keys.length; i++) { var d = PDEF[keys[i]], v = d.log ? _exp(x[i]) : x[i]; d.set(c, v); }
            if (c.pr >= c.sigmaC - 1) c.pr = c.sigmaC - 1;
            if (c.pdl && c.pdl.pfo != null && c.pdl.pfo < c.sigmaC) c.pdl.pfo = c.sigmaC;
            return c;
        }
        function run(x) {
            var c = cfgOf(x), cv = lkToEngine(c);
            if (!cv.ok) return null;
            var raw = _simulateEngine(cv.e, grid, opts.budgetMs == null ? 2000 : opts.budgetMs, 0, counts);
            counts.runs++;
            if (raw.why) return null;
            var res = _pack(cv.e, raw, {});
            return { res: res, p: lkSample(res, tData), cfg: c };
        }
        return { ok: true, cfgOf: cfgOf, run: run, e0: e0, grid: grid };
    }

    function _toX(keys, cfg) { return keys.map(function (k) { var v = PDEF[k].get(cfg); return PDEF[k].log ? _log(v) : v; }); }

    function lkFitJob(data, cfg, preset, opts) {
        var done = false, cancelled = false, result = null, st = null, lastLabel = 'starting';
        opts = opts || {};
        preset = preset || 'full';
        function finish(r) { result = r; done = true; }
        function init() {
            if (!data || !Array.isArray(data.t) || !Array.isArray(data.p) || data.t.length !== data.p.length) return finish(_fail('BAD_DATA', 'data {t, p} arrays of equal length are required.', ['data']));
            if (['falloff', 'full', 'geometry', 'pdl', 'spurt'].indexOf(preset) < 0) return finish(_fail('BAD_PRESET', "preset must be 'falloff', 'full', 'geometry', 'pdl' or 'spurt'.", ['preset']));
            var c0 = _clone(cfg);
            if (c0.CL != null) {   // CL / w_c display inputs → {C_w, k} once, never fitted as such
                var cv0 = lkToEngine(c0); if (!cv0.ok) return finish(cv0);
                _resolveCL(cv0.e, {});
                c0.Cw = cv0.e.Cw / cv0.e.u.sqmin; c0.k = cv0.e.kMd > 0 ? cv0.e.kMd : null; c0.CL = null; c0.wc = null;
            }
            c0.aperture = c0.aperture || { law: 'none', sh: 60, sc: 100, fres: 0.1, sr: null };
            c0.pdl = c0.pdl || { Cd: 0, pfo: null, fmax: 50 };
            var keys = Array.isArray(opts.free) && opts.free.length ? opts.free.slice() : _presetFree(preset, c0);
            for (var i = 0; i < keys.length; i++) if (!PDEF[keys[i]]) return finish(_fail('BAD_PARAM', 'Unknown free parameter ' + keys[i] + '.', ['free']));
            if (keys.indexOf('Cd') >= 0 && !(c0.pdl.Cd > 0)) c0.pdl.Cd = 0.002;
            if (keys.indexOf('k') >= 0 && !(c0.k > 0)) c0.k = 1e-3;
            if (keys.indexOf('Cw') >= 0 && !(c0.Cw > 0)) c0.Cw = 1e-4;
            if (keys.indexOf('Sp') >= 0 && !(c0.Sp > 0)) c0.Sp = 0.5;
            var conv = lkToEngine(c0); if (!conv.ok) return finish(conv);
            var ts = conv.e.ts, pd = _prepData(data, ts, opts.nMax || 300);
            if (pd.t.length < keys.length + 3) return finish(_fail('TOO_FEW_POINTS', 'Too few falloff points for ' + keys.length + ' free parameters.', ['data']));
            var tLast = pd.t[pd.t.length - 1];
            c0.tEnd = tLast + 1e-6 * (tLast - ts) + 1e-6;   // the grid is fixed by the schedule and the data end
            var pMax = -Infinity, pMin = Infinity; pd.p.forEach(function (v) { if (v > pMax) pMax = v; if (v < pMin) pMin = v; });
            // bounds in transformed space
            var lo = [], hi = [];
            keys.forEach(function (k) {
                var d = PDEF[k], v = d.get(c0), L = d.lo, H = d.hi;
                if (k === 'sigmaC') { L = _max(+c0.pr + 10, 1); H = pMax; }
                if (k === 'pr') { L = 1; H = (keys.indexOf('sigmaC') >= 0 ? pMax : +c0.sigmaC) - 1; }
                if (k === 'pfo') { L = +c0.sigmaC; H = pMax + 500; }
                if (k === 'hf') { L = +c0.hp; H = 10 * c0.hp; }
                if (k === 'VwCw') { L = v * 0.5; H = v * 1.5; }
                if (opts.bounds && opts.bounds[k]) { L = opts.bounds[k][0]; H = opts.bounds[k][1]; }
                lo.push(d.log ? _log(L) : L); hi.push(d.log ? _log(H) : H);
            });
            var counts = { runs: 0, evals: 0 };
            var model = _makeModel(c0, keys, pd.t, opts, counts);
            if (!model.ok) return finish(model.fail);
            var sigmaP = (+opts.sigmaP > 0) ? +opts.sigmaP : (_sigmaFromData(pd.t, pd.p) || 0.5);
            // starts: the given one plus (optionally) 4 deterministic perturbations
            var x0 = _toX(keys, c0).map(function (v, i) { return _min(hi[i], _max(lo[i], v)); });
            var starts = [x0];
            if (opts.multiStart) {
                var band = (+opts.sigmaBand > 0) ? +opts.sigmaBand : 50, pert = [[4, 1, 3], [0.25, -1, 1 / 3], [4, -1, 1 / 3], [0.25, 1, 3]];
                pert.forEach(function (pp) {
                    var x = x0.slice();
                    keys.forEach(function (k, i) {
                        if (k === 'k' || k === 'Cw') x[i] += _log(pp[0]);
                        else if (k === 'sigmaC') x[i] += pp[1] * band;
                        else if (k === 'sh' || k === 'sc') x[i] += _log(pp[2]);
                        x[i] = _min(hi[i], _max(lo[i], x[i]));
                    });
                    starts.push(x);
                });
            }
            var priors = [];
            if (opts.priors && typeof opts.priors === 'object') keys.forEach(function (k, j) {
                var pz = opts.priors[k]; if (!pz || !(+pz.value > 0 || (!PDEF[k].log && _isFinite(+pz.value)))) return;
                var sd = PDEF[k].log ? +pz.sdLn : +pz.sd; if (!(sd > 0)) return;
                priors.push({ j: j, mu: PDEF[k].log ? _log(+pz.value) : +pz.value, sd: sd, key: k });
            });
            // optional derivative residuals on ln(G·dP/dG) (§5.7): the same Bourdet engine and L on data and model; fixed index set
            var dv = null, wD = (+opts.derivWeight > 0) ? +opts.derivWeight : (opts.deriv ? 0.2 : 0);
            if (wD > 0) {
                var tpD = ts - conv.e.tStart, LD = (+opts.derivL > 0) ? +opts.derivL : 0.1, xG = _lnGAt(pd.t, ts, tpD), Dd = _bourdetLn(xG, pd.p, LD), idxD = [], DdKeep = [];
                for (var q0 = 0; q0 < Dd.length; q0++) if (Dd[q0] != null && Dd[q0] > 0) { idxD.push(q0); DdKeep.push(Dd[q0]); }
                if (idxD.length >= 5) {
                    var scaleD = _median(DdKeep);
                    dv = { w: wD, L: LD, x: xG, idx: idxD, lnD: DdKeep.map(function (v) { return _log(v); }), scale: scaleD, floor: _log(1e-3 * scaleD) };
                }
            }
            st = { keys: keys, lo: lo, hi: hi, model: model, pd: pd, sigmaP: sigmaP, counts: counts, starts: starts, iStart: -1, runsOut: [], priors: priors, dv: dv,
                   maxRuns: (+opts.maxRuns > 0) ? +opts.maxRuns : 400, maxIter: (+opts.maxIter > 0) ? +opts.maxIter : 60, budgetMs: (+opts.budgetMs > 0) ? +opts.budgetMs : 5000,
                   t0: _now(), cur: null, c0: c0 };
        }
        function resid(x) {
            var r = st.model.run(x);
            if (!r) return null;
            var nd = st.pd.t.length, dv = st.dv, nD = dv ? dv.idx.length : 0, e = new Array(nd + nD + st.priors.length), S = 0;
            for (var i = 0; i < nd; i++) { var v = r.p[i]; if (v == null) return null; e[i] = (v - st.pd.p[i]) * _sqrt(st.pd.w[i]); S += e[i] * e[i]; }
            var Sd = S;
            if (dv) {   // derivative pseudo-residuals in psi: w·D̃·(ln D_model − ln D_data), D̃ = the median data derivative
                var Dm = _bourdetLn(dv.x, r.p, dv.L);
                for (var m = 0; m < nD; m++) {
                    var dmv = Dm[dv.idx[m]], lm = (dmv != null && dmv > 0) ? _max(_log(dmv), dv.floor) : dv.floor;
                    e[nd + m] = dv.w * dv.scale * (lm - dv.lnD[m]); S += e[nd + m] * e[nd + m];
                }
            }
            for (var q = 0; q < st.priors.length; q++) {   // MAP priors as pseudo-residuals in psi: σ_p·(θ − θ_prior)/σ_θ (log for log parameters)
                var pz = st.priors[q]; e[nd + nD + q] = st.sigmaP * (x[pz.j] - pz.mu) / pz.sd; S += e[nd + nD + q] * e[nd + nD + q];
            }
            return { e: e, S: S, Sd: Sd, r: r };
        }
        function jac(x, base) {
            var J = [];
            for (var j = 0; j < st.keys.length; j++) {
                var d = PDEF[st.keys[j]], h = d.log ? 1e-4 : _max(1e-3, _abs(x[j]) * 1e-6) * 10;
                if (x[j] + h > st.hi[j]) h = -h;
                var x2 = x.slice(); x2[j] += h;
                var r2 = resid(x2); if (!r2) return null;
                var col = new Array(base.e.length);
                for (var k = 0; k < col.length; k++) col[k] = (r2.e[k] - base.e[k]) / h;
                J.push(col);
            }
            return J;
        }
        function normal(J, e) {
            var np = J.length, A = [], g = [];
            for (var i = 0; i < np; i++) {
                A.push(new Array(np)); var gi = 0;
                for (var k = 0; k < e.length; k++) gi += J[i][k] * e[k];
                g.push(gi);
                for (var j = 0; j < np; j++) { var s = 0; for (k = 0; k < e.length; k++) s += J[i][k] * J[j][k]; A[i][j] = s; }
            }
            return { A: A, g: g };
        }
        function startNext() {
            st.iStart++;
            if (st.iStart >= st.starts.length) return false;
            var x = st.starts[st.iStart], r = resid(x);
            if (!r) { st.runsOut.push({ ok: false }); return startNext(); }
            st.cur = { x: x, r: r, lam: 1e-2, it: 0, stop: null };
            return true;
        }
        function iterate() {   // one LM iteration of the current start
            var c = st.cur;
            if (st.counts.runs >= st.maxRuns) { c.stop = 'budget'; return; }
            if (_now() - st.t0 > st.budgetMs) { c.stop = 'time budget'; return; }
            if (c.it >= st.maxIter) { c.stop = 'maxIter'; return; }
            var J = jac(c.x, c.r); if (!J) { c.stop = 'failed run'; return; }
            var ne = normal(J, c.r.e), improved = false;
            for (var tries = 0; tries < 12; tries++) {
                var B = ne.A.map(function (row, i) { var r2 = row.slice(); r2[i] *= (1 + c.lam); if (!(r2[i] > 0)) r2[i] = c.lam; return r2; });
                var dx = _solveLin(B, ne.g.map(function (v) { return -v; }));
                if (!dx) { c.lam *= 4; continue; }
                var xn = c.x.map(function (v, i) { return _min(st.hi[i], _max(st.lo[i], v + dx[i])); });
                var rn = resid(xn);
                if (rn && rn.S < c.r.S) {
                    var rel = (c.r.S - rn.S) / _max(c.r.S, 1e-300), step = 0;
                    for (var i = 0; i < dx.length; i++) step = _max(step, _abs(xn[i] - c.x[i]) / (PDEF[st.keys[i]].log ? 1 : _max(1, _abs(c.x[i]))));
                    c.x = xn; c.r = rn; c.lam = _max(c.lam / 5, 1e-7); improved = true;
                    if (rel < 1e-7 || step < 1e-8) c.stop = 'converged';
                    break;
                }
                c.lam *= 4;
                if (st.counts.runs >= st.maxRuns) break;
            }
            c.it++;
            if (!improved && !c.stop) c.stop = 'converged';
        }
        function finalise() {
            var best = null;
            st.runsOut.forEach(function (o) { if (o.ok && (!best || o.S < best.S)) best = o; });
            if (!best) return finish(_fail('FIT_FAILED', 'Every model run of the history match failed.', []));
            var keys = st.keys, np = keys.length, n = st.pd.t.length, x = best.x, base = best.r;
            var J = jac(x, base);
            var warnings = _freeRules(keys).concat(base.r.res.warnings.filter(function (w) { return w.level !== 'info'; }));
            var ne = J ? normal(J, base.e) : null, C = ne ? _inv(ne.A) : null;
            var s2 = base.Sd / _max(1, n - np), sd = [], corr = {}, params = {}, ci95 = {}, ci95I = {};
            var ne1 = _neff(base.e.slice(0, n)), rho1 = ne1.rho1, nEff = ne1.nEff, infl = ne1.inflation, i;
            keys.forEach(function (k, j) {
                var d = PDEF[k], v = d.log ? _exp(x[j]) : x[j];
                params[k] = v;
                var s = (C && C[j][j] > 0) ? _sqrt(C[j][j] * s2) : null; sd.push(s);
                if (s == null) { ci95[k] = null; ci95I[k] = null; return; }
                ci95[k] = d.log ? [v * _exp(-1.96 * s), v * _exp(1.96 * s)] : [v - 1.96 * s, v + 1.96 * s];
                ci95I[k] = d.log ? [v * _exp(-1.96 * s * infl), v * _exp(1.96 * s * infl)] : [v - 1.96 * s * infl, v + 1.96 * s * infl];
            });
            if (C) for (i = 0; i < np; i++) for (var j = i + 1; j < np; j++) if (sd[i] && sd[j]) corr[keys[i] + '_' + keys[j]] = C[i][j] * s2 / (sd[i] * sd[j]);
            // sloppy directions: correlation-scaled Fisher, λ_min/λ_max < 1e-4
            var sloppy = [], eig = null;
            if (ne) {
                var Fs = ne.A.map(function (row, a) { return row.map(function (v, b) { return v / _sqrt(ne.A[a][a] * ne.A[b][b]); }); });
                eig = _jacobiEig(Fs);
                var lmax = eig.vals[eig.vals.length - 1];
                eig.vals.forEach(function (lv, m) { if (lv / lmax < 1e-4) sloppy.push(_sloppyEntry(keys, eig.vecs[m], best.r.r.cfg, best.r.r.res, C, s2, infl)); });
            }
            var bestRes = best.r.r.res, bestCfg = best.r.r.cfg, grp = lkGroups(bestRes);
            var rmse = _sqrt(base.Sd / n), chi2 = base.Sd / (st.sigmaP * st.sigmaP);
            if (st.sigmaP > 0 && rmse > 5 * st.sigmaP) warnings.push(_w('FIT_MISFIT', 'warn', 'The model does not fit (rmse ' + _sig(rmse, 3) + ' psi against a noise of ' + _sig(st.sigmaP, 2) + ' psi): a fixed height or E′ may be wrong; free one member of the {E′, h_f} group.'));
            var conv = st.runsOut.filter(function (o) { return o.ok && o.S <= best.S * 1.05; }).length;
            var structural = { sigmaC: null, pr: null, k: null, CLeq: null };
            var out = {
                ok: true, preset: preset, params: params, ci95: ci95, ci95Inflated: ci95I, corr: corr, nEff: nEff, rho1: rho1, inflation: infl,
                structural: structural, groups: grp.ok ? { Gamma: grp.Gamma, GammaPKN: grp.GammaPKN == null ? 0 : grp.GammaPKN, text: grp.text.slice(0, 299) } : { Gamma: 0, GammaPKN: 0, text: 'The identifiable group could not be computed.' },
                sloppy: sloppy, starts: { n: st.starts.length, converged: conv }, runs: st.counts.runs, chi2: chi2, rmse: rmse, sigmaP: st.sigmaP,
                stopReason: best.stop || 'converged', warnings: warnings,
                free: keys.slice(), cfg: bestCfg, CLeq: bestRes.CLeq, dpCL: bestRes.dpCL, wcEq: bestRes.wcEq, kEq: bestRes.k, evals: st.counts.evals,
                design: { t: st.pd.t.slice(), p: st.pd.p.slice(), w: st.pd.w.slice(), sigmaP: st.sigmaP }, eig: eig ? eig.vals : null, priors: st.priors.map(function (pz) { return pz.key; }),
                S: base.S, Sd: base.Sd, deriv: st.dv ? { weight: st.dv.w, L: st.dv.L, n: st.dv.idx.length, scale: st.dv.scale } : null,
                fitOpts: { nMax: opts.nMax || 300, sigmaP: st.sigmaP, bounds: opts.bounds || null, priors: opts.priors || null, derivWeight: st.dv ? st.dv.w : 0, derivL: st.dv ? st.dv.L : null, grid: opts.grid || 'fit', budgetMs: opts.budgetMs || null }
            };
            finish(out);
        }
        function step() {
            if (done) return { done: true, progress: 1, label: lastLabel };
            try {
                if (!st) { init(); if (done) return { done: true, progress: 1, label: 'failed' }; startNext(); lastLabel = 'start 1'; return { done: false, progress: 0, label: lastLabel }; }
                if (cancelled) { finish(_fail('CANCELLED', 'The history match was cancelled.', [])); return { done: true, progress: 1, label: 'cancelled' }; }
                if (st.cur && !st.cur.stop) iterate();
                if (st.cur && st.cur.stop) {
                    st.runsOut.push({ ok: true, x: st.cur.x, r: st.cur.r, S: st.cur.r.S, stop: st.cur.stop });
                    if (!startNext()) { finalise(); return { done: true, progress: 1, label: 'done' }; }
                }
                var prog = _min(0.99, (st.iStart + (st.cur ? st.cur.it / st.maxIter : 0)) / st.starts.length);
                lastLabel = 'start ' + (st.iStart + 1) + ' of ' + st.starts.length + ', iteration ' + (st.cur ? st.cur.it : 0);
                return { done: false, progress: prog, label: lastLabel };
            } catch (err) { finish(_fail('FIT_FAILED', err && err.message || err, [])); return { done: true, progress: 1, label: 'failed' }; }
        }
        return { step: step, result: function () { return result; }, cancel: function () { cancelled = true; } };
    }
    function _drain(job, cap) { var n = 0, s; do { s = job.step(); n++; } while (!s.done && n < (cap || 100000)); return job.result(); }
    function lkFit(data, cfg, preset, opts) {
        try {
            var r = _drain(lkFitJob(data, cfg, preset, opts));
            if (r && r.ok && opts && opts.structural) _structural(r, data, preset, opts);
            return r;
        } catch (err) { return _fail('FIT_FAILED', err && err.message || err, []); }
    }
    // structural spread: refit with each aperture law and PDL on/off; ranges over the structures with Δχ²/s² ≤ 4 + 2·|Δn_p|
    function _structural(fit, data, preset, opts) {
        var laws = ['none', 'exp', 'hyp'], rows = [];
        laws.forEach(function (law) {
            [false, true].forEach(function (pdl) {
                var c = _clone(fit.cfg); c.aperture.law = law; c.pdl.Cd = pdl ? 0.002 : 0;
                var free = fit.free.filter(function (k) { return k !== 'sh' && k !== 'sc' && k !== 'Cd'; });
                if (law === 'hyp') free.push('sh'); if (law === 'exp') free.push('sc'); if (pdl) free.push('Cd');
                var o = _clone(opts); o.free = free; o.structural = false; o.multiStart = false;
                var f = _drain(lkFitJob(data, c, preset, o));
                if (f && f.ok) rows.push(f);
            });
        });
        // kept: Δχ²/s² ≤ 4 + 2·|Δn_p| against the best structure (s² = χ²_best/(n − n_p,best), the residual variance). The
        // ratio rule χ² ≤ 1.5·χ²_best depended on n: noise-free it kept only the true structure (a one-point range), on noisy
        // data with n ≈ 500 it admitted structures up to Δχ²/s² ≈ 250
        var best = null; rows.forEach(function (f) { if (!best || f.chi2 < best.chi2) best = f; });
        var nD = data && data.t ? data.t.length : 0, npB = best && best.free ? best.free.length : 0;
        var s2B = best ? Math.max(best.chi2 / Math.max(1, nD - npB), 1e-30) : 1;
        var keep = rows.filter(function (f) { var dnp = Math.abs((f.free ? f.free.length : 0) - npB); return (f.chi2 - best.chi2) / s2B <= 4 + 2 * dnp; });
        function rng(get) { var v = keep.map(get).filter(function (x) { return _isFinite(x); }); if (!v.length) return null; return [_min.apply(null, v), _max.apply(null, v)]; }
        fit.structural = { sigmaC: rng(function (f) { return f.params.sigmaC != null ? f.params.sigmaC : f.cfg.sigmaC; }), pr: rng(function (f) { return f.params.pr != null ? f.params.pr : f.cfg.pr; }),
                           k: rng(function (f) { return f.kEq; }), CLeq: rng(function (f) { return f.CLeq; }), n: keep.length };
    }
    // ─────────────────────────────────────────────────────────────────────
    // Profile likelihood (§5.7 item 4, §6.7): fix one parameter at n values around the estimate, refit the others (warm start
    // from the neighbour), Δχ² = (S(v) − S_best)/s², s² = S_d,best/(n − n_p); the 95 % interval is where Δχ² ≤ 3.84 (× the
    // n_eff inflation² for the inflated interval). One refit per Job step.
    // ─────────────────────────────────────────────────────────────────────
    function lkProfileJob(fit, key, opts) {
        var done = false, cancelled = false, result = null, st = null, label = 'starting';
        opts = opts || {};
        function finish(r) { result = r; done = true; }
        function init() {
            if (!fit || fit.ok !== true || !fit.cfg || !fit.design) return finish(_fail('BAD_FIT', 'A successful history match (LkFit) is required.', ['fit']));
            key = key || 'sigmaC';
            if (fit.free.indexOf(key) < 0 || !PDEF[key]) return finish(_fail('NOT_FREE', 'The profiled parameter must be free in the match.', ['key']));
            var others = fit.free.filter(function (k) { return k !== key; });
            if (!others.length) return finish(_fail('NOTHING_TO_PROFILE', 'A profile needs at least one other free parameter.', ['key']));
            var d = PDEF[key], n = (+opts.n >= 3) ? _floor(+opts.n) : 15, span = (+opts.span > 0) ? +opts.span : 2.5;
            var v0 = fit.params[key], x0 = d.log ? _log(v0) : v0, ci = fit.ci95[key];
            var sdX = ci ? (d.log ? (_log(ci[1]) - _log(ci[0])) : (ci[1] - ci[0])) / (2 * 1.96) : null;
            var half = span * 1.96 * (sdX > 0 ? sdX : (d.log ? 0.05 : 5));
            if (!d.log) half = _max(half, (+opts.minHalf > 0) ? +opts.minHalf : 1);
            var xs = [];
            if (Array.isArray(opts.values) && opts.values.length) xs = opts.values.map(function (v) { return d.log ? _log(+v) : +v; });
            else for (var i = 0; i < n; i++) xs.push(x0 - half + 2 * half * i / (n - 1));
            xs = xs.filter(function (x) { return _isFinite(x) && _abs(x - x0) > 1e-12 * _max(1, _abs(x0)); }).sort(function (a, b) { return a - b; });
            var up = xs.filter(function (x) { return x > x0; }), dn = xs.filter(function (x) { return x < x0; }).reverse();
            var np = fit.free.length, nd = fit.design.t.length, s2 = fit.Sd / _max(1, nd - np);
            var fo = fit.fitOpts || {};
            st = { key: key, d: d, x0: x0, others: others, queue: up.map(function (x) { return { x: x, side: 1 }; }).concat(dn.map(function (x) { return { x: x, side: -1 }; })),
                   pts: [{ x: x0, S: fit.S, cfg: fit.cfg, ok: true }], prev: { '1': fit.cfg, '-1': fit.cfg }, s2: s2, runs: 0, total: up.length + dn.length,
                   data: opts.data || { t: fit.design.t, p: fit.design.p, w: fit.design.w },
                   fo: { nMax: fo.nMax || 300, sigmaP: fo.sigmaP || fit.sigmaP, bounds: fo.bounds || undefined, priors: fo.priors || undefined, derivWeight: fo.derivWeight || 0, derivL: fo.derivL || undefined,
                         grid: fo.grid || 'fit', maxRuns: (+opts.maxRunsPerFit > 0) ? +opts.maxRunsPerFit : 150 } };
        }
        function one() {
            var q = st.queue.shift(), c = _clone(st.prev[String(q.side)]), v = st.d.log ? _exp(q.x) : q.x;
            st.d.set(c, v);
            if (st.key === 'sigmaC' && c.pr >= v - 1) c.pr = v - 10;
            var o = _clone(st.fo); o.free = st.others.slice(); o.multiStart = false;
            if (o.bounds && o.bounds[st.key]) delete o.bounds[st.key];
            var f = _drain(lkFitJob(st.data, c, fit.preset, o));
            st.runs += f && f.runs ? f.runs : 0;
            if (f && f.ok) { st.pts.push({ x: q.x, S: f.S, cfg: f.cfg, ok: true }); st.prev[String(q.side)] = f.cfg; }
            else st.pts.push({ x: q.x, S: null, ok: false });
        }
        function bound(pts, side, lim) {   // first crossing of Δχ² = lim walking out from the minimum on one side, linear in √Δχ²
            var seq = pts.filter(function (p) { return p.ok && (side > 0 ? p.x >= st.x0 : p.x <= st.x0); }).sort(function (a, b) { return side * (a.x - b.x); });
            var rl = _sqrt(lim), rt = function (v) { return _sqrt(_max(0, v)); };
            for (var i = 1; i < seq.length; i++) {
                var a = seq[i - 1], b = seq[i], ra = rt(a.dchi2), rb = rt(b.dchi2);
                if (ra <= rl && rb > rl) return a.x + (rl - ra) * (b.x - a.x) / (rb - ra);
            }
            return null;
        }
        function finalise() {
            var Smin = Infinity; st.pts.forEach(function (p) { if (p.ok && p.S < Smin) Smin = p.S; });
            st.pts.forEach(function (p) { p.dchi2 = p.ok ? (p.S - fit.S) / st.s2 : null; });
            var infl = fit.inflation || 1, d = st.d, tr = function (x) { return x == null ? null : (d.log ? _exp(x) : x); };
            var lo = bound(st.pts, -1, 3.84), hi = bound(st.pts, 1, 3.84), loI = bound(st.pts, -1, 3.84 * infl * infl), hiI = bound(st.pts, 1, 3.84 * infl * infl);
            var pts = st.pts.slice().sort(function (a, b) { return a.x - b.x; });
            var lin = fit.ci95[st.key], v0 = fit.params[st.key], agree = null, text;
            var lbl = _cap(LABEL[st.key] || st.key), unit = d.pressure ? ' psi' : '';
            var fmtHw = function (a, b) { return d.pressure ? _sig(_abs(b - a), 2) + unit : _fx(100 * _abs(b / a - 1), 0) + ' %'; };
            if (lo != null && hi != null && lin) {
                var rL = d.log ? (st.x0 - lo) / (st.x0 - _log(lin[0])) : (v0 - lo) / (v0 - lin[0]);
                var rH = d.log ? (hi - st.x0) / (_log(lin[1]) - st.x0) : (hi - v0) / (lin[1] - v0);
                agree = _abs(rL - 1) <= 0.25 && _abs(rH - 1) <= 0.25;
                text = lbl + ': the profile gives −' + fmtHw(tr(lo), v0) + ' / +' + fmtHw(v0, tr(hi)) + ' (linearised ±' + fmtHw(lin[0], v0) + '): ' +
                       (agree ? 'the linearised interval holds.' : (rL > 1.25 || rH > 1.25 ? 'the linearised interval is too narrow; quote the profile.' : 'the linearised interval is conservative.'));
            } else {
                text = lbl + ': the profile does not reach Δχ² = 3.84 on ' + (lo == null && hi == null ? 'either side' : (lo == null ? 'the low side' : 'the high side')) + ' within the scanned range; the interval is wider than the scan.';
            }
            if (Smin < fit.S * (1 - 1e-6) - 1e-9) text += ' A lower misfit was found at ' + _sig(tr(pts.filter(function (p) { return p.ok && p.S === Smin; })[0].x), 5) + unit + ': the match had not reached its minimum.';
            finish({ ok: true, key: st.key, values: pts.map(function (p) { return tr(p.x); }), S: pts.map(function (p) { return p.S; }), dchi2: pts.map(function (p) { return p.dchi2; }),
                     ci95: [tr(lo), tr(hi)], ci95Inflated: [tr(loI), tr(hiI)], linear: lin ? lin.slice() : null, agree: agree, runs: st.runs, refits: st.total, text: text.slice(0, 299) });
        }
        function step() {
            if (done) return { done: true, progress: 1, label: label };
            try {
                if (!st) { init(); if (done) return { done: true, progress: 1, label: 'failed' }; label = 'profile of ' + key; return { done: false, progress: 0, label: label }; }
                if (cancelled) { finish(_fail('CANCELLED', 'The profile was cancelled.', [])); return { done: true, progress: 1, label: 'cancelled' }; }
                if (st.queue.length) one();
                if (!st.queue.length) { finalise(); return { done: true, progress: 1, label: 'done' }; }
                var k = st.total - st.queue.length;
                label = 'profile of ' + key + ': refit ' + k + ' of ' + st.total;
                return { done: false, progress: _min(0.99, k / st.total), label: label };
            } catch (err) { finish(_fail('PROFILE_FAILED', err && err.message || err, [])); return { done: true, progress: 1, label: 'failed' }; }
        }
        return { step: step, result: function () { return result; }, cancel: function () { cancelled = true; } };
    }
    function lkProfile(fit, key, opts) {
        try { return _drain(lkProfileJob(fit, key, opts)); } catch (err) { return _fail('PROFILE_FAILED', err && err.message || err, []); }
    }
    var LABEL = { k: 'permeability', Cw: 'the wall coefficient', Sp: 'spurt', sigmaC: 'closure stress', pr: 'pore pressure', Ep: 'E′', hf: 'fracture height',
                  KIc: 'apparent toughness', sh: 'the contact scale', sc: 'the contact scale', Cd: 'the PDL coefficient', pfo: 'the fissure-opening pressure', VwCw: 'wellbore storage' };
    function _sloppyEntry(keys, vec, cfg, res, C, s2, infl) {
        var comps = keys.map(function (k, i) { return { k: k, v: vec[i] }; }).sort(function (a, b) { return _abs(b.v) - _abs(a.v); });
        var top = comps.filter(function (c) { return _abs(c.v) > 0.3; }).slice(0, 3), vobj = {};
        keys.forEach(function (k, i) { vobj[k] = vec[i]; });
        var names = top.map(function (c) { return c.k; }), text;
        var geo = names.indexOf('Ep') >= 0 || names.indexOf('hf') >= 0 || names.indexOf('KIc') >= 0;
        if (geo) {
            var g = lkGroups(res), pm = _groupPm(keys, cfg, res, C, s2, infl);
            text = (names.indexOf('Ep') >= 0 && names.indexOf('hf') >= 0 ? 'E′ and fracture height cannot be separated by this test' : top.map(function (c) { return LABEL[c.k]; }).join(', ').replace(/^./, function (m) { return m.toUpperCase(); }) + ' cannot be separated by this test') +
                ': only Γ = ' + _sig(g.Gamma, 3) + ' psi/√min (r_p·CL·E′/h_f = ' + _sig(g.GammaPKN, 3) + ') is determined (±' + _sig(pm, 1) + ' %). CL = ' + _sci(res.CLeq, 2) +
                ' ft/√min assumes E′ = ' + _sci(cfg.Ep, 1) + ' psi and h_f = ' + _sig(cfg.hf, 3) + ' ft.';
        } else {
            text = top.map(function (c) { return LABEL[c.k]; }).join(' and ').replace(/^./, function (m) { return m.toUpperCase(); }) + ' cannot be separated by this test; only their combination is determined.';
        }
        return { vec: vobj, text: text.slice(0, 299) };
    }
    // relative 95 % half-width (%) of Γ_PKN = r_p·CL·E′/h_f from the parameter covariance (linear propagation)
    function _groupPm(keys, cfg, res, C, s2, infl) {
        if (!C) return 0;
        var dl = keys.map(function (k) {
            if (k === 'Ep') return 1;
            if (k === 'hf') return (cfg.hp < cfg.hf) ? -2 : -1;
            if (k === 'Cw') return res.CLeq > 0 ? (cfg.Cw || 0) / res.CLeq : 0;
            if (k === 'k') return res.CLeq > 0 ? 0.5 * (res.CLeq - (cfg.Cw || 0)) / res.CLeq : 0;
            return 0;
        });
        var v = 0; for (var i = 0; i < keys.length; i++) for (var j = 0; j < keys.length; j++) v += dl[i] * dl[j] * C[i][j] * s2;
        return 100 * 1.96 * _sqrt(_max(0, v)) * (infl || 1);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Fisher information on a planned design (noise only): {tEnd, sigma, nPts, free, priors?}
    // ─────────────────────────────────────────────────────────────────────
    function lkFisher(cfg, design) {
        try {
            design = design || {};
            var c0 = _clone(cfg); c0.aperture = c0.aperture || { law: 'none', sh: 60, sc: 100, fres: 0.1, sr: null }; c0.pdl = c0.pdl || { Cd: 0, pfo: null, fmax: 50 };
            var conv = lkToEngine(c0); if (!conv.ok) return conv;
            var ts = conv.e.ts, tEnd = (+design.tEnd > ts) ? +design.tEnd : c0.tEnd, nPts = (+design.nPts >= 5) ? _floor(+design.nPts) : 250;
            var sigma = (+design.sigma > 0) ? +design.sigma : 0.5;
            var keys = Array.isArray(design.free) && design.free.length ? design.free.slice() : _presetFree('full', c0);
            var t = [], t0 = 10 / 3600;
            for (var i = 0; i < nPts; i++) t.push(ts + _exp(_log(t0) + (_log(tEnd - ts) - _log(t0)) * i / (nPts - 1)));
            c0.tEnd = tEnd * (1 + 1e-9) + 1e-6;
            var counts = { runs: 0, evals: 0 }, model = _makeModel(c0, keys, t, design, counts);
            if (!model.ok) return model.fail;
            var lin = {}; keys.forEach(function (k) { lin[k] = !PDEF[k].log || !(PDEF[k].get(c0) > 0); });
            var x = keys.map(function (k) { var v = PDEF[k].get(c0); return lin[k] ? v : _log(v); });
            var cfgOf = function (xx) { var c = _clone(c0); c.CL = null; c.wc = null; keys.forEach(function (k, j) { PDEF[k].set(c, lin[k] ? xx[j] : _exp(xx[j])); }); if (c.pr >= c.sigmaC - 1) c.pr = c.sigmaC - 1; return c; };
            function runAt(xx) {
                var c = cfgOf(xx), cv = lkToEngine(c); if (!cv.ok) return null;
                var raw = _simulateEngine(cv.e, model.grid, 2000, 0, counts); counts.runs++;
                if (raw.why) return null;
                return lkSample(_pack(cv.e, raw, {}), t);
            }
            var p0 = runAt(x); if (!p0) return _fail('SIMULATION_FAILED', 'The base run failed.', []);
            var J = [];
            for (var j = 0; j < keys.length; j++) {
                var hh = lin[keys[j]] ? (keys[j] === 'Cw' || keys[j] === 'k' ? _max(1e-9, _abs(x[j]) * 1e-3) : _max(1e-3, _abs(x[j]) * 1e-6) * 10) : 1e-4;
                var x2 = x.slice(); x2[j] += hh;
                var p2 = runAt(x2); if (!p2) return _fail('SIMULATION_FAILED', 'A perturbed run failed.', []);
                J.push(p2.map(function (v, m) { return (v - p0[m]) / hh; }));
            }
            var F = keys.map(function (a, ia) { return keys.map(function (b, ib) { var s = 0; for (var m = 0; m < t.length; m++) s += J[ia][m] * J[ib][m]; return s / (sigma * sigma); }); });
            var pri = design.priors || {};
            keys.forEach(function (k, ia) { if (pri[k] > 0) F[ia][ia] += 1 / (pri[k] * pri[k]); });
            if (design.gaugeFactor > 0) F = F.map(function (row) { return row.map(function (v) { return v * design.gaugeFactor; }); });
            var C = _inv(F), ci = {}, corr = {}, sd = {};
            keys.forEach(function (k, ia) {
                var s = (C && C[ia][ia] > 0) ? _sqrt(C[ia][ia]) : null, v = PDEF[k].get(c0);
                sd[k] = s;
                ci[k] = s == null ? null : (lin[k] ? 1.96 * s : (_exp(1.96 * s) - 1) * v);
            });
            if (C) for (var a = 0; a < keys.length; a++) for (var b = a + 1; b < keys.length; b++) if (sd[keys[a]] && sd[keys[b]]) corr[keys[a] + '_' + keys[b]] = C[a][b] / (sd[keys[a]] * sd[keys[b]]);
            var Fs = F.map(function (row, ia) { return row.map(function (v, ib) { return v / _sqrt(F[ia][ia] * F[ib][ib]); }); }), eg = _jacobiEig(Fs), sloppy = [];
            var res0 = (function () { var cv = lkToEngine(cfgOf(x)); return _pack(cv.e, _simulateEngine(cv.e, model.grid, 2000, 0, counts), {}); })();
            eg.vals.forEach(function (lv, m) { if (lv / eg.vals[eg.vals.length - 1] < 1e-4) sloppy.push(_sloppyEntry(keys, eg.vecs[m], c0, res0, C, 1, 1)); });
            return { ok: true, ci: ci, sd: sd, corr: corr, eig: eg.vals, sloppy: sloppy, free: keys, logParam: keys.map(function (k) { return !lin[k]; }), F: F, C: C, runs: counts.runs, t: t, res: null };
        } catch (err) { return _fail('FISHER_FAILED', err && err.message || err, []); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // "What this test can tell you" (§6.7)
    // ─────────────────────────────────────────────────────────────────────
    // ctx (all optional):
    //   extendTimesH       shut-in durations of the extension table (h; default 0.5, 1, 2, 3, 5, 7, 14 days)
    //   tDLPerHourDraws    per designer / uncertainty draw, the t_DL rate C_TDL·k/(φ·μ·c_t·L²) in 1/h (t_DL(t_end) = value·t_end);
    //                      P(radial) = share of draws with t_DL(t_end) ≥ 1.6. Without it P(radial) is 0 or 1 from the fitted model
    //   profile, profileN  run the 1-D σ_c profile (≈ 10 refits) on demand
    // The extension table's σ(p_i) comes from the Fisher matrix of the match's free set plus p_r (at its configured value, the
    // linearisation point) when the match held p_r fixed, so a fall-off-preset match still reports how p_i narrows; a wall-only
    // model (no reservoir term) cannot estimate p_r and flags its rows pFixed:true (σ(p_i) 0, no keep-or-pull comparison).
    // The k range is the inflated Fisher interval of log k on the extended shut-in (kBasis 'fisher'); the §4.12 bounds with the
    // forecast D belong to the after-closure analysis (57) and replace it once that engine is wired in.
    function identify(fit, ctx) {
        try {
            if (!fit || fit.ok !== true) return _fail('BAD_FIT', 'A successful history match (LkFit) is required.', ['fit']);
            ctx = ctx || {};
            var rows = [], infl = fit.inflation || 1, sloppyKeys = {}, structural = fit.structural || {};
            fit.sloppy.forEach(function (s) { Object.keys(s.vec).forEach(function (k) { if (_abs(s.vec[k]) > 0.3) sloppyKeys[k] = true; }); });
            var cfg = fit.cfg, sigma = fit.sigmaP || 0.5, tData = fit.design && fit.design.t, ts = lkToEngine(cfg).e.ts;
            var tEndData = tData && tData.length ? tData[tData.length - 1] : cfg.tEnd, nPts = tData && tData.length ? tData.length : 250;
            var keys = fit.free.slice(), priorsBase = {};   // the information content of THIS match: its free parameters only
            var base = lkFisher(cfg, { tEnd: tEndData, sigma: sigma, nPts: nPts, free: keys, priors: priorsBase });
            var res = lkSimulate(cfg, { grid: 'fit' }), xf = res && res.ok ? res.xf.ts : null;
            fit.free.forEach(function (k) {
                var v = fit.params[k], ci = fit.ci95Inflated[k], d = PDEF[k], status, pm = null, text, widened = false;
                if (ci) pm = (ci[1] - ci[0]) / 2;
                // widened by the structural spread (aperture law, PDL on/off) when lkFit computed it: linear sum (conservative)
                var sr = (k === 'sigmaC' || k === 'pr' || k === 'k') ? structural[k] : null;
                if (pm != null && sr && _okn(sr[0]) && _okn(sr[1])) { var dev = _max(_abs(sr[1] - v), _abs(v - sr[0])); if (dev > 0) { pm += dev; widened = true; } }
                var relOk = ci && (d.pressure ? pm < _max(25, 0.01 * v) : pm / v < 0.25);
                if (relOk && !sloppyKeys[k]) {
                    status = 'determined';
                    text = _cap(LABEL[k]) + ' is determined to ±' + (d.pressure ? _sig(pm, 2) + ' psi' : _sig(100 * pm / v, 2) + ' %') + (widened ? ' (including the structural spread).' : '.');
                }
                else if (sloppyKeys[k]) { status = 'group'; text = _cap(LABEL[k]) + ' is determined only as part of a group' + (k === 'Ep' || k === 'hf' ? '; a log-derived height or a core E′ would determine it.' : '.'); }
                else { status = 'not'; text = _cap(LABEL[k]) + ' is not determined by this test' + (k === 'pr' ? '; a longer shut-in would determine it.' : '.'); }
                rows.push({ param: k, status: status, pm: pm, text: text.slice(0, 299) });
            });
            // the group Γ: relative 95 % half-width (%) of r_p·CL·E′/h_f from the match's Fisher covariance (inflated)
            var gPm = (base.ok && base.C && res && res.ok) ? _groupPm(keys, cfg, res, base.C, 1, infl) : null;
            if (gPm != null && !(gPm > 0)) gPm = null;
            var pknWord = (res && res.ok && res.geometry !== 'PKN') ? 'PKN-equivalent' : 'PKN form';
            rows.push({ param: 'Gamma', status: 'determined', pm: gPm, text: ('The group Γ = ' + _sig(fit.groups.Gamma, 3) + ' psi/√min is determined' + (gPm != null ? ' (±' + _sig(gPm, 2) + ' %)' : '') +
                       ' (' + pknWord + ' ' + _sig(fit.groups.GammaPKN, 4) + ').').slice(0, 299) });
            var sloppyText = fit.sloppy.length ? fit.sloppy[0].text : 'No parameter combination is poorly determined by this test.';
            // value of information: Fisher on the fitted model (its free set) with the candidate priors / designs
            var outs = ['sigmaC', 'pr', 'k', 'Cw'].filter(function (k) { return keys.indexOf(k) >= 0; });
            function varsOf(f) { var o = {}; outs.forEach(function (k) { var s = f.sd[k]; o[k] = s == null ? null : s * s; }); return o; }
            var voi = [];
            if (base.ok) {
                var v0 = varsOf(base);
                var cands = [
                    { source: 'height from logs ±10 %', d: { priors: Object.assign({}, priorsBase, { hf: 0.10 }) }, text: 'A log-derived fracture height (±10 %)', needs: 'hf' },
                    { source: 'E′ from core ±15 %', d: { priors: Object.assign({}, priorsBase, { Ep: 0.15 }) }, text: 'A core E′ (±15 %)', needs: 'Ep' },
                    { source: 'offset p_i ±50 psi', d: { priors: Object.assign({}, priorsBase, { pr: 50 }) }, text: 'An offset pore pressure (±50 psi)', needs: 'pr' },
                    { source: 'gauge with half the noise', d: { priors: priorsBase, gaugeFactor: 4 }, text: 'A gauge with half the noise' },
                    { source: 'longer shut-in', d: { priors: priorsBase, tEnd: ts + 2 * (tEndData - ts) }, text: 'Doubling the shut-in' }
                ];
                cands.forEach(function (cd) {
                    if (cd.needs && keys.indexOf(cd.needs) < 0) {
                        voi.push({ source: cd.source, reduction: 0, text: (cd.text + ' does not change this match: that quantity is fixed in it (the results are conditional on it).').slice(0, 299) });
                        return;
                    }
                    var f = lkFisher(cfg, Object.assign({ tEnd: tEndData, sigma: sigma, nPts: nPts, free: keys }, cd.d));
                    if (!f.ok) return;
                    var v1 = varsOf(f), lsum = 0, m = 0;
                    outs.forEach(function (k) { if (v0[k] > 0 && v1[k] > 0) { lsum += _log(v1[k] / v0[k]); m++; } });
                    var red = m ? 1 - _exp(lsum / m) : 0;
                    voi.push({ source: cd.source, reduction: red, text: (cd.text + ' narrows the key outputs by ' + _fx(100 * red, 0) + ' % (variance, geometric mean).').slice(0, 299) });
                });
                voi.sort(function (a, b) { return b.reduction - a.reduction; });
            }
            // extension table
            var extend = [], times = Array.isArray(ctx.extendTimesH) ? ctx.extendTimesH : [0.5, 1, 2, 3, 5, 7, 14].map(function (d) { return d * 24; });
            var resCtl = cfg.k != null && +cfg.k > 0, extKeys = keys.slice();
            if (resCtl && extKeys.indexOf('pr') < 0) extKeys.push('pr');   // p_r at its configured value is the linearisation point
            var kF = extKeys.indexOf('k') >= 0, rateDraws = Array.isArray(ctx.tDLPerHourDraws) ? ctx.tDLPerHourDraws.filter(_okn) : null;
            var etaR = resCtl ? cfg.k * _units().md / (cfg.phi * cfg.muRes * _units().cp * cfg.ct) : 0;
            times.forEach(function (th) {
                var f = lkFisher(_clone(cfg), { tEnd: ts + th, sigma: sigma, nPts: nPts, free: extKeys, priors: priorsBase });
                if (!f.ok) return;
                var pFixed = !(f.sd.pr != null && f.sd.pr > 0), sdPi = pFixed ? 0 : f.sd.pr * infl, kr = null;
                if (kF && f.sd.k != null) kr = [cfg.k * _exp(-1.96 * f.sd.k * infl), cfg.k * _exp(1.96 * f.sd.k * infl)];
                var tDL = (etaR > 0 && xf > 0) ? etaR * th / (xf * xf) : 0;
                var pRad = (rateDraws && rateDraws.length) ? rateDraws.filter(function (v) { return v * th >= 1.6; }).length / rateDraws.length : (tDL >= 1.6 ? 1 : 0);
                extend.push({ tEndD: th / 24, tEndH: th, sdPi: sdPi, pFixed: pFixed, kRange: kr, kBasis: kr ? 'fisher' : null, pRadial: pRad });
            });
            var keepText = null, anyFixed = extend.some(function (r) { return r.pFixed; });
            if (extend.length > 1 && !anyFixed) {
                var a0 = extend[0].sdPi, a1 = extend[extend.length - 1].sdPi;
                keepText = a1 < 0.5 * a0 ? 'Keep the gauge in: p_i narrows from ±' + _sig(1.96 * a0, 2) + ' to ±' + _sig(1.96 * a1, 2) + ' psi over the table.' : 'Pulling the gauge early costs little: p_i barely narrows with a longer shut-in.';
            } else if (anyFixed) {
                keepText = 'This model has no reservoir term, so a longer shut-in cannot determine p_i here; the table gives the k range only.';
            }
            // on demand: a 1-D profile on σ_c (≈ 10 refits) checks the linearised interval (the UI runs lkProfileJob for progress)
            var profile = null;
            if (ctx.profile && fit.free.indexOf('sigmaC') >= 0 && fit.free.length > 1) {
                profile = lkProfile(fit, 'sigmaC', { n: (+ctx.profileN >= 3) ? +ctx.profileN : 10 });
                if (profile && profile.ok && profile.agree === false) rows.forEach(function (r) { if (r.param === 'sigmaC') r.text = (r.text + ' ' + profile.text).slice(0, 299); });
            }
            return { ok: true, rows: rows, sloppyText: sloppyText.slice(0, 299), voi: voi, extend: extend, keepText: keepText, profile: profile };
        } catch (err) { return _fail('IDENTIFY_FAILED', err && err.message || err, []); }
    }
    function _cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

    // ─────────────────────────────────────────────────────────────────────
    // Pre-job designer (§6.5): seeded Latin-hypercube ensemble on the coarse grid, after-closure timing from the s_D
    // thresholds, outcome label, minimum volume, vacuum and gauge advice, leak budget, step-down plan, precision, corridor.
    // Exposed as a Job (opts.perStep draws per step, by count) next to the synchronous function with the identical result.
    // ─────────────────────────────────────────────────────────────────────
    var T_REC = 6068, T_BAND = 8800, T_CONF = 27800, TDL_REC = 1.6, TDL_CONF = 7.34, C_TDL = 0.0002637;
    function _lnPR(r) { var a = _log(r.p10), b = _log(r.p90); return { m: 0.5 * (a + b), s: (b - a) / (2 * 1.2815516) }; }
    function _wellboreVwCw(ranges, opts) {
        if (opts && +opts.VwCw > 0) return { VwCw: +opts.VwCw, src: 'given' };
        var W = G.WTS_wellbore;
        if (W && typeof W.column === 'function' && !W.column._dfitStub && typeof W.csys === 'function') {
            try {
                var col = W.column({ survey: [], strings: ranges.strings || [], fluid: ranges.fluid || {}, temp: null, datumTvd: ranges.datumTvd, datumMd: ranges.datumTvd });
                var cs = col && col.ok ? W.csys(col, ranges.fluid || {}, null) : null;
                if (cs && cs.ok && cs.VwCw > 0) return { VwCw: cs.VwCw, src: 'wellbore' };
            } catch (e) { /* fall through */ }
        }
        // fallback: string capacity × c_sys = 144/(ρ·c²) with c 4,539 ft/s (water-filled steel string)
        var rho = ((ranges.fluid && +ranges.fluid.rhoPpg > 0) ? +ranges.fluid.rhoPpg : 8.43) * 7.48052 / 32.174, cSys = 144 / (rho * 4539 * 4539), V = 0;
        (ranges.strings || []).forEach(function (s) { var id = +s.id, len = +s.botMd - +s.topMd; if (id > 0 && len > 0) V += PI / 4 * (id / 12) * (id / 12) * len; });
        if (!(V > 0)) V = PI / 4 * (4.778 / 12) * (4.778 / 12) * (+ranges.datumTvd || 10000);
        return { VwCw: V * cSys / 5.614583, src: 'string capacity' };
    }
    function _vacuum(pi, ranges) {
        var W = G.WTS_wellbore, atm = 14.696, r = null;
        if (W && typeof W.vacuum === 'function' && !W.vacuum._dfitStub) {
            try {
                var col = (typeof W.column === 'function' && !W.column._dfitStub) ? W.column({ survey: [], strings: ranges.strings || [], fluid: ranges.fluid || {}, temp: null, datumTvd: ranges.datumTvd, datumMd: ranges.datumTvd }) : null;
                r = W.vacuum(pi, col, null, atm);
            } catch (e) { r = null; }
        }
        var pS, src;
        if (r && _isFinite(+r.pSurfAtPi)) { pS = +r.pSurfAtPi; src = 'column'; }
        else { pS = pi - 0.052 * ((ranges.fluid && +ranges.fluid.rhoPpg > 0) ? +ranges.fluid.rhoPpg : 8.43) * (+ranges.datumTvd || 0); src = 'constant gradient'; }
        var risk = (r && (r.risk === 'none' || r.risk === 'surface-zero')) ? r.risk : ((pS - atm < 15) ? 'surface-zero' : 'none');   // the engine's own risk first
        var text = risk === 'none' ? ('The column stays liquid-supported at the expected p_i (surface ' + _fx(pS, 0) + ' psia): a surface gauge sees closure and after-closure.')
            : (pS - atm < 0 ? 'The surface goes on vacuum before p_i (surface ' + _fx(pS, 0) + ' psia at p_i): surface gauge sufficient for closure; BH gauge required for ACA.'
                            : 'The surface falls below 15 psig near p_i (surface ' + _fx(pS, 0) + ' psia): surface gauge sufficient for closure; BH gauge recommended for ACA.');
        return { risk: risk, text: text.slice(0, 299), pSurfAtPi: pS, src: src };
    }
    function designJob(ranges, opts) {
        opts = opts || {};
        var done = false, cancelled = false, result = null, st = null;
        function finish(r) { result = r; done = true; }
        function need(o, k) { return o && o[k] && _isFinite(+o[k].p10) && _isFinite(+o[k].p90) && +o[k].p10 > 0 && +o[k].p90 >= +o[k].p10; }
        function init() {
            var R = ranges || {}, bad = [];
            ['k', 'phi', 'ct', 'muRes', 'h', 'hf'].forEach(function (k) { if (!need(R, k)) bad.push(k); });
            if (!R.Ep || !(+R.Ep.p50 > 0)) bad.push('Ep');
            if (!R.sigmaGrad || !(+R.sigmaGrad.p50 > 0)) bad.push('sigmaGrad');
            if (!R.piGrad || !(+R.piGrad.p50 > 0)) bad.push('piGrad');
            if (!(+R.datumTvd > 0)) bad.push('datumTvd');
            if (!(+R.allowedShutInD > 0)) bad.push('allowedShutInD');
            if (bad.length) return finish(_fail('BAD_RANGES', 'Designer inputs missing or invalid: ' + bad.join(', ') + '.', bad));
            var n = _floor(+opts.n > 0 ? +opts.n : 500); if (n > 2000) n = 2000;
            var seed = (opts.seed == null) ? 1 : _floor(+opts.seed), rnd = _rng(seed);
            var vw = _wellboreVwCw(R, opts), epsMax = (+R.epsMax > 0) ? +R.epsMax : 0.05;
            var sig50 = R.sigmaGrad.p50 * R.datumTvd, pi50 = R.piGrad.p50 * R.datumTvd;
            var Vmin = vw.VwCw * _max(0, sig50 - pi50) / epsMax;
            var V = (+R.V > 0) ? +R.V : (R.suggest === false ? 25 : _min(50, _max(5, Math.ceil(Vmin)))), q = (+R.q > 0) ? +R.q : 5;
            // Latin-hypercube: one stratified permutation per variable (seeded)
            var vars = ['k', 'phi', 'ct', 'muRes', 'h', 'hf', 'Ep', 'sg', 'pg'], U = {};
            vars.forEach(function (vn) {
                var perm = []; for (var i = 0; i < n; i++) perm.push(i);
                for (i = n - 1; i > 0; i--) { var j = _floor(rnd() * (i + 1)), tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp; }
                U[vn] = perm.map(function (p) { return (p + rnd()) / n; });
            });
            var allowedH = R.allowedShutInD * 24;
            st = { R: R, n: n, seed: seed, U: U, i: 0, draws: [], VwCw: vw.VwCw, VwSrc: vw.src, Vmin: Vmin, V: V, q: q, epsMax: epsMax, allowedH: allowedH,
                   counts: { evals: 0, fisherRuns: 0, steps: 0 }, perStep: (+opts.perStep > 0) ? _floor(+opts.perStep) : 25,
                   tCorr: (function () { var a = []; for (var m = 0; m < 60; m++) a.push(_exp(_log(10 / 3600) + (_log(allowedH) - _log(10 / 3600)) * m / 59)); return a; })() };
        }
        function q2(vn, i, pr, isLog) {
            var u = st.U[vn][i], z = _qnorm(u);
            if (isLog) { var L = _lnPR(pr); return _exp(L.m + z * L.s); }
            return pr.p50 + z * pr.sd;
        }
        function oneDraw(i) {
            var R = st.R;
            var d = { k: q2('k', i, R.k, true), phi: q2('phi', i, R.phi, true), ct: q2('ct', i, R.ct, true), muRes: q2('muRes', i, R.muRes, true),
                      h: q2('h', i, R.h, true), hf: q2('hf', i, R.hf, true), Ep: _exp(_log(R.Ep.p50) + _qnorm(st.U.Ep[i]) * (+R.Ep.sdLn || 0)),
                      sg: q2('sg', i, R.sigmaGrad, false), pg: q2('pg', i, R.piGrad, false) };
            d.sigmaC = d.sg * R.datumTvd; d.pi = d.pg * R.datumTvd;
            if (d.pi >= d.sigmaC - 50) d.pi = d.sigmaC - 50;
            var hp = (+R.hp > 0) ? +R.hp : _min(d.h, d.hf), tp = st.V / st.q / 60;
            var cfg = lkDefaults();
            cfg.schedule = [{ t: 0, q: st.q }, { t: tp, q: 0 }]; cfg.Ep = d.Ep; cfg.nu = (R.nu != null) ? +R.nu : 0.25; cfg.hf = _max(d.hf, hp); cfg.hp = hp;
            cfg.muCp = (R.fluid && +R.fluid.muCp > 0) ? +R.fluid.muCp : 1; cfg.Cw = 0; cfg.k = d.k; cfg.sigmaC = d.sigmaC; cfg.pr = d.pi; cfg.VwCw = st.VwCw;
            cfg.phi = d.phi; cfg.ct = d.ct; cfg.muRes = d.muRes; cfg.tEnd = tp + st.allowedH;
            var r = lkSimulate(cfg, { grid: opts.grid || 'coarse' });
            st.counts.evals++;
            var out = { d: d, ok: !!(r && r.ok), cfg: cfg };
            if (!out.ok) { st.draws.push(out); return; }
            var ts = r.events.ts;
            out.tc = r.events.tcMech != null ? r.events.tcMech - ts : null;
            out.xf = r.xf.ts; out.eta = r.etaS; out.Vf = r.Vf[_idxAtOrAfter(r.t, ts, r.t.length)]; out.Rvis = _rvis(r);
            out.p = st.tCorr.map(function (x) { return _atT(r, r.pf, ts + x); });
            var L = (+opts.L > 0) ? +opts.L : out.xf, fmc = d.phi * d.muRes * d.ct * L * L / d.k;
            out.L = L; out.tRec = T_REC * fmc; out.tBand = T_BAND * fmc; out.tConf = T_CONF * fmc;
            out.t3tc = out.tc != null ? 3 * out.tc : null;
            out.tEps = 33890 * st.VwCw * d.muRes / (d.k * d.h);
            out.tW = null;
            if (+R.targetW > 0) {
                var A = 2 * L * hp, mL = 97.54 * (st.V / A) * _sqrt(d.muRes / (d.k * d.phi * d.ct)), tWl = _pow(mL / (2 * R.targetW), 2), tWr = 1694.5 * st.V * d.muRes / (d.k * d.h * R.targetW);
                out.tW = (out.tRec <= tWl) ? tWr : tWl;
            }
            var cand = [['radial', out.tConf], ['3tc', out.t3tc], ['afterflow', out.tEps], ['precision', out.tW]], best = null;
            cand.forEach(function (c) { if (c[1] != null && _isFinite(c[1]) && (!best || c[1] > best[1])) best = c; });
            out.shutIn = best[1]; out.binding = best[0];
            out.signal = 0.4468 * st.V / (TDL_REC * d.phi * d.ct * d.h * L * L);
            out.signalConf = 0.4468 * st.V / (TDL_CONF * d.phi * d.ct * d.h * L * L);
            out.tDLat = function (tH) { return C_TDL * d.k * tH / (d.phi * d.muRes * d.ct * L * L); };
            st.draws.push(out);
        }
        function finalise() {
            var R = st.R, ok = st.draws.filter(function (d) { return d.ok; }), n = ok.length, warnings = [];
            if (!n) return finish(_fail('DESIGN_FAILED', 'Every designer run failed.', []));
            if (n < st.draws.length) warnings.push(_w('DESIGN_RUNS_FAILED', 'warn', (st.draws.length - n) + ' of ' + st.draws.length + ' designer runs failed and were left out.'));
            var tcs = ok.map(function (d) { return d.tc; }), tcP = _p3(tcs);
            var nClosed = tcs.filter(function (v) { return v != null; }).length;
            var nRad = ok.filter(function (d) { return d.tRec <= st.allowedH; }).length;
            var nLin = ok.filter(function (d) { return d.tc != null && 2 * d.tc <= st.allowedH; }).length;
            var label = nRad >= 0.5 * n ? 'radial' : (nLin >= 0.5 * n ? 'linear' : 'closure-only');
            var shutP = _p3(ok.map(function (d) { return d.shutIn; })), bindCount = {};
            ok.forEach(function (d) { bindCount[d.binding] = (bindCount[d.binding] || 0) + 1; });
            var binding = Object.keys(bindCount).sort(function (a, b) { return bindCount[b] - bindCount[a]; })[0];
            var bindWords = { radial: 'radial confirmation', '3tc': 'three closure times', afterflow: 'afterflow', precision: 'p_i precision' }[binding] || binding;
            var tRad = _p3(ok.map(function (d) { return d.tRec; })), tConf = _p3(ok.map(function (d) { return d.tConf; })), sig = _p3(ok.map(function (d) { return d.signal; }));
            var sigConf = _p3(ok.map(function (d) { return d.signalConf; }));
            var kP = _p3(ok.map(function (d) { return d.d.k; })), days = function (h) { return h / 24; };
            var text;
            if (label === 'radial') text = 'Radial flow is expected within the allowed ' + _sig(R.allowedShutInD, 3) + ' days (recognisable after ' + _sig(tRad.p50, 2) + ' h at P50): kh/μ can be read; the spread comes from the k range (' + _sci(kP.p10, 1) + '–' + _sci(kP.p90, 1) + ' md).';
            else if (label === 'linear') text = 'Closure and after-closure linear flow are expected within ' + _sig(R.allowedShutInD, 3) + ' days; radial flow needs about ' + _sig(days(tRad.p50), 2) + ' days at P50: plan for p_i and bounds on k (the spread comes from the k range).';
            else text = 'Only closure is expected within ' + _sig(R.allowedShutInD, 3) + ' days (' + nClosed + ' of ' + n + ' draws close): after-closure analysis needs a longer shut-in.';
            var vac = _vacuum(R.piGrad.p50 * R.datumTvd, R);
            var gaugeKind = (R.gauge && R.gauge.kind) || 'bh', gSigma = (R.gauge && +R.gauge.sigma > 0) ? +R.gauge.sigma : 0.05, why = [];
            var bhReq = false;
            if (vac.risk !== 'none') { bhReq = true; why.push('The surface reaches vacuum near p_i: a bottomhole gauge is required for after-closure analysis.'); }
            if (sig.p10 != null && sig.p10 < 35 * gSigma) { bhReq = true; why.push('The radial-onset signal (P10 ' + _sig(sig.p10, 2) + ' psi) is below 35 × the gauge noise: use a quartz bottomhole gauge.'); }
            if (!why.length) why.push(gaugeKind === 'surface' ? 'Surface gauge adequate: the column stays liquid-filled and the signal is well above the noise.' : 'A bottomhole gauge meets the closure and after-closure needs.');
            var hz = _max(1, Math.ceil(10 * 4539 / (2 * R.datumTvd)));
            var resPsi = sig.p10 != null ? _max(0.001, sig.p10 / 50) : 0.01, drift = (sig.p10 != null && tRad.p50 > 0) ? sig.p10 / _max(1, days(tRad.p50)) / 10 : 0.02;
            var tEndLeak = _min(st.allowedH, shutP.p50 || st.allowedH);
            var tdl = ok.map(function (d) { return d.tDLat(tEndLeak); });
            var tempF = (R.fluid && _isFinite(+R.fluid.TF)) ? +R.fluid.TF : ((_isFinite(+R.tempF)) ? +R.tempF : 100);
            var lb = leakBudget(st.V, tEndLeak, { tDLDraws: tdl, sigmaP: gSigma, VwCw: st.VwCw, tempF: tempF });
            var leak = lb.ok ? { qkMax: lb.qkMax, theta: lb.theta, holdMin: lb.holdMin == null ? 0 : lb.holdMin, dTneeded: lb.dTneeded, regime: lb.regime, holdRealistic: lb.holdRealistic, text: lb.text }
                             : { qkMax: 0, theta: 2, holdMin: 0, dTneeded: 0 };
            var rates = [1, 0.8, 0.6, 0.4, 0.2].map(function (f) { return +(st.q * f).toPrecision(3); });
            var sigP = _p3(ok.map(function (d) { return d.d.sigmaC; }));
            var rep = R.repressurise ? { q: 0.35, V: 1.5, kneeP: sigP } : null;
            // pre-job precision of p_i on the planned schedule (P50 case, Fisher, noise-free design)
            var precision = [];
            if (opts.precision !== false && tcP.p50 != null) {
                var mid = ok.slice().sort(function (a, b) { return a.d.k - b.d.k; })[_floor(n / 2)];
                // the multiples of t_c are taken on the median-k draw's own closure time (its configuration is the one simulated),
                // so "1.5 t_c" is never before that draw's closure; the ensemble P50 t_c only when the draw does not close
                var tcMid = (mid.tc != null && mid.tc > 0) ? mid.tc : tcP.p50;
                [1.5, 2, 3, 5, 10, 20].forEach(function (m) {
                    var c = _clone(mid.cfg), tEndH = mid.cfg.schedule[1].t + m * tcMid;
                    var f = lkFisher(c, { tEnd: tEndH, sigma: gSigma, nPts: 250, free: ['k', 'sigmaC', 'pr'], grid: 'coarse' });
                    if (f.ok) { st.counts.fisherRuns += f.runs; if (f.sd.pr != null) precision.push({ tEndD: (m * tcMid) / 24, sdPi: f.sd.pr, tcMult: m }); }
                });
            }
            var checklist = [
                { id: 'C1', text: 'Pressure-test the surface lines and the string; record the hold on the same gauge.' },
                { id: 'C2', text: 'Remove air from the lines and the gauge dead spaces; use anti-freeze in exposed gauge lines.' },
                { id: 'C3', text: 'Use one clock for pumps and gauges and mark it with a pressure blip before pumping.' },
                { id: 'C4', text: 'Record at least 60 min concurrently with the pump unit before and after the injection.' },
                { id: 'C5', text: 'Shut in with the valve on the pump side of the gauge, then close in quickly and leave it closed.' },
                { id: 'C6', text: 'Pump ' + _sig(st.V, 3) + ' bbl at ' + _sig(st.q, 3) + ' bbl/min; skip the step-down unless a friction split is needed.' },
                { id: 'C7', text: 'Sample at ' + hz + ' Hz or faster around the shut-in to resolve the water hammer.' },
                { id: 'C8', text: shutP.p50 <= st.allowedH ? 'Keep the gauge in for ' + _sig(days(shutP.p50), 2) + ' days (P50 recommendation, set by ' + bindWords + ').'
                                                            : 'Keep the gauge in for the full ' + _sig(R.allowedShutInD, 3) + ' days allowed; the P50 recommendation (' + _sig(days(shutP.p50), 2) + ' days, set by ' + bindWords + ') exceeds it.' }
            ];
            var corridor = { t: st.tCorr.slice(), p10: [], p50: [], p90: [] };
            st.tCorr.forEach(function (x, m) {
                var pp = _p3(ok.map(function (d) { return d.p[m]; }));
                corridor.p10.push(pp.p10); corridor.p50.push(pp.p50); corridor.p90.push(pp.p90);
            });
            if (nClosed < n) warnings.push(_w('NO_CLOSURE_SOME', 'info', (n - nClosed) + ' of ' + n + ' draws do not close within the allowed shut-in.'));
            if (st.V < st.Vmin) warnings.push(_w('VOLUME_BELOW_VMIN', 'warn', 'The planned ' + _sig(st.V, 3) + ' bbl is below V_min ≈ ' + _sig(st.Vmin, 3) + ' bbl: afterflow may bias the after-closure analysis.'));
            var shut = { p10: shutP.p10, p50: shutP.p50, p90: shutP.p90, binding: binding };
            var vmn = _p3(ok.map(function (d) { return d.Rvis; }));
            finish({
                ok: true, n: n, seed: st.seed, outcome: { label: label, text: text.slice(0, 299) },
                tc: tcP, shutIn: shut, tRadial: tRad, tConfirm: tConf, signalPsi: sig, signalConfirmPsi: sigConf, Vmin: st.Vmin, V: st.V, q: st.q, Rvis: { p50: vmn.p50 },
                vacuum: { risk: vac.risk, text: vac.text }, vacuumDetail: vac,
                gauge: { bhRequired: bhReq, why: why.map(function (s) { return s.slice(0, 299); }), hz: hz, resolutionPsi: resPsi, driftPsiPerDay: drift },
                leak: leak, stepDown: { rates: rates }, repressurise: rep, precision: precision, checklist: checklist, corridor: corridor,
                VwCw: st.VwCw, VwCwSource: st.VwSrc, shares: { radial: nRad / n, linear: nLin / n, closed: nClosed / n },
                counts: { evals: st.counts.evals, refits: 0, draws: st.draws.length, fisherRuns: st.counts.fisherRuns, steps: st.counts.steps },
                warnings: warnings
            });
        }
        function step() {
            if (done) return { done: true, progress: 1, label: 'done' };
            try {
                if (!st) { init(); if (done) return { done: true, progress: 1, label: 'failed' }; return { done: false, progress: 0, label: 'drawing ' + st.n + ' cases' }; }
                if (cancelled) { finish(_fail('CANCELLED', 'The design was cancelled.', [])); return { done: true, progress: 1, label: 'cancelled' }; }
                st.counts.steps++;
                if (st.i < st.n) {
                    var stop = _min(st.n, st.i + st.perStep);
                    for (; st.i < stop; st.i++) oneDraw(st.i);
                    return { done: false, progress: 0.95 * st.i / st.n, label: st.i + ' of ' + st.n + ' runs' };
                }
                finalise();
                return { done: true, progress: 1, label: 'done' };
            } catch (err) { finish(_fail('DESIGN_FAILED', err && err.message || err, [])); return { done: true, progress: 1, label: 'failed' }; }
        }
        return { step: step, result: function () { return result; }, cancel: function () { cancelled = true; } };
    }
    function design(ranges, opts) {
        try { return _drain(designJob(ranges, opts)); } catch (err) { return _fail('DESIGN_FAILED', err && err.message || err, []); }
    }

    // ─────────────────────────────────────────────────────────────────────

    G.PRiSM_dfit_lkDefaults = lkDefaults;
    G.PRiSM_dfit_lkToEngine = lkToEngine;
    G.PRiSM_dfit_lkSimulate = lkSimulate;
    G.PRiSM_dfit_lkSample = lkSample;
    G.PRiSM_dfit_lkQuick = lkQuick;
    G.PRiSM_dfit_lkSolveCL = lkSolveCL;
    G.PRiSM_dfit_lkGoalSeek = lkGoalSeek;
    G.PRiSM_dfit_lkGoalSeekJob = lkGoalSeekJob;
    G.PRiSM_dfit_lkProfile = lkProfile;
    G.PRiSM_dfit_lkProfileJob = lkProfileJob;
    G.PRiSM_dfit_lkGroups = lkGroups;
    G.PRiSM_dfit_lkVerify = lkVerify;
    G.PRiSM_dfit_leakBudget = leakBudget;
    G.PRiSM_dfit_lkFit = lkFit;
    G.PRiSM_dfit_lkFitJob = lkFitJob;
    G.PRiSM_dfit_lkFisher = lkFisher;
    G.PRiSM_dfit_identify = identify;
    G.PRiSM_dfit_design = design;
    G.PRiSM_dfit_designJob = designJob;
    G._PRiSM_dfit_lk = { erf: erf, erfcx: erfcx, E1: E1, pDuf: pDuf, theta: theta, gN: gN, GN: GN, KVISC: KVISC, units: _units, atT: _atT, qLAt: _qLAt, neff: _neff };
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis, bad = [];
    try {
        var v = G.PRiSM_dfit_lkVerify({ only: ['V1d', 'V8', 'V14'] });
        if (!v.ok || Math.abs(v.V1d.Gc - 18.004) > 1e-3) bad.push('V1d G_c');
        if (!v.ok || Math.abs(v.V8.xf - 133.8) > 0.2 || Math.abs(v.V8.dtc - 307.1) > 0.2) bad.push('V8 base case');
        if (!v.ok || !(v.V14.minW > 0)) bad.push('V14 aperture');
        var lb = G.PRiSM_dfit_leakBudget(25, 300, { tDL: 5 });
        if (!lb.ok || Math.abs(lb.theta - 4.509) > 0.01) bad.push('theta(5)');
    } catch (e) { bad.push(String(e && e.message || e)); }
    if (bad.length && typeof console !== 'undefined') console.warn('[58-prism-dfit-leakoff self-test] ' + bad.join('; '));
})();
