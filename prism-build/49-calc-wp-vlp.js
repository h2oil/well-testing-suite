// =============================================================================
// WTS — 49-calc-wp-vlp.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance vertical lift (WP3, increment A1) — docs/WELL-PERFORMANCE-PLAN.md §3.4, §4.4, §4.5, §15.1, §15.2, D3, D5, D17.
//
// ONE MARCHER (D3). This file adds no pressure march of its own: it registers point-gradient correlations into the registry of
// 49-calc-flowline.js (window.WTS_flowline_corr, merge, never replace) and drives WTS_flowline_march with the registry KEY STRING
// (opt.corr) along the true inclination of every well segment (hydrostatic on the segment's TVD change, friction on its MD length:
// the marcher takes θ = asin(dz / len) per segment). The only closed form here is the dry-gas average-T-and-Z method (gasDry).
//
// CORRELATIONS (each grad(inp) returns the shape of WTS_flowline_bb: hl, lambdaL, pattern, rhoS, rhoN, grad, gradEl, gradF, gradAcc,
// Ek, vm, vsl, vsg, fn; inp = {vsl, vsg ft/s, d in, rhoL, rhoG lbm/ft³, muL, muG cp, sigma dyn/cm, theta ° (+ = flow up), rough in,
// p psia, payne, accel, props, mult}; units are converted INSIDE each function, written next to each equation)
//   hb      Hagedorn & Brown (1965), modified (Brill & Mukherjee 1999 §4.2.1): Griffith (1961) bubble flow when the no-slip gas
//           fraction λg < L_B = 1.071 − 0.2218·v_m²/d (v_m ft/s, d FT), L_B ≥ 0.13, slip velocity v_s = 0.8 ft/s; otherwise the
//           three published charts as curve fits (source table: the polynomial fits printed in Economides, Hill, Ehlig-Economides &
//           Zhu, "Petroleum Production Systems", and Guo, Lyons & Ghalambor, "Petroleum Production Engineering", Hagedorn-Brown
//           section — Q9: the books were not available to this work package, so the fits are pinned to their own values and the
//           correlation ships provisional):
//             N_Lv = 1.938·v_sl·(ρ_L/σ)^¼, N_gv = 1.938·v_sg·(ρ_L/σ)^¼, N_D = 120.872·d_ft·(ρ_L/σ)^½,
//             N_L = 0.15726·μ_L·(1/(ρ_L·σ³))^¼          (ρ lbm/ft³, σ dyn/cm, μ cp, v ft/s, d ft)
//             CN_L = (0.0019 + 0.0322 N_L − 0.6642 N_L² + 4.9951 N_L³) / (1 − 10.0147 N_L + 33.8696 N_L² + 277.2817 N_L³)
//             X1 = N_Lv·(p/14.7)^0.1·CN_L / (N_gv^0.575·N_D)            (p psia)
//             H_L/ψ = √[(0.0047 + 1123.32 X1 + 729489.64 X1²) / (1 + 1097.1566 X1 + 722153.97 X1²)]
//             X2 = N_gv·N_L^0.38 / N_D^2.14 (clamped to the chart, 0.01–0.09)
//             ψ = (1.0886 − 69.9473 X2 + 2334.3497 X2² − 12896.683 X2³) / (1 − 53.4401 X2 + 1517.9369 X2² − 8419.8115 X2³), ψ ≥ 1
//           H_L = clamp((H_L/ψ)·ψ, λ_L, 1) (the "holdup ≥ no-slip" rule); friction f (Moody, Colebrook) at the slip-viscosity
//           Reynolds number N_Re = 1488·ρ_n·v_m·d_ft / (μ_L^H_L·μ_g^(1−H_L)), dp/dL_f = f·ρ_n²·v_m² / (2·g_c·d_ft·ρ_s) / 144 (psi/ft).
//           Bubble flow: H_L = 1 − ½[1 + v_m/v_s − √((1 + v_m/v_s)² − 4·v_sg/v_s)], friction on the liquid in-situ velocity
//           v_L = v_sl/H_L, N_Re = 1488·ρ_L·v_L·d_ft/μ_L, dp/dL_f = f·ρ_L·v_L² / (2·g_c·d_ft) / 144.
//           Vertical-only correlation: with a deviated segment the elevation term uses the true inclination (ρ_s·sin θ) and the
//           friction the measured length — the inclination correction — and the traverse warns above 30° from vertical (§4.4).
//   gray    Gray (1974), gas / condensate wells (API RP 14B form, Brill & Mukherjee §4.2.4):
//             R = v_sl/v_sg; N_v = ρ_n²·v_m⁴ / (g·σ·(ρ_L − ρ_g)); N_D = g·(ρ_L − ρ_g)·d_ft² / σ   (σ in lbm/s² = dyn/cm × 0.00220462,
//             g = 32.174 ft/s², ρ lbm/ft³, v ft/s: both dimensionless)
//             B = 0.0814·[1 − 0.0554·ln(1 + 730·R/(R + 1))]; A = −2.314·[N_v·(1 + 205/N_D)]^B; H_L = 1 − (1 − λ_L)·(1 − e^A)
//           pseudo wall roughness ε' = 28.5·σ/(ρ_n·v_m²) (ft) for R ≥ 0.007, else ε + R·(ε' − ε)/0.007; ε' ≥ 2.77e-5 ft;
//           f (Moody, Colebrook) at N_Re = 1e7 on ε'/d; dp/dL_f = f·ρ_n·v_m² / (2·g_c·d_ft) / 144.
//           Range (Appendix A): v_m < 50 ft/s, d ≤ 3.5 in, condensate ≤ 50 bbl/MMscf, water ≤ 5 bbl/MMscf (both ratios checked).
//   nsl     homogeneous no-slip: H_L = λ_L, ρ_s = ρ_n, f at N_Re = 1488·ρ_n·v_m·d_ft/μ_n, μ_n = λ_L·μ_L + λ_g·μ_g (a lower bound)
//   single  single-phase Darcy-Weisbach with the Colebrook factor of 49-calc-flowline.js (WTS_flowline_friction.colebrook):
//           water injectors, dead oil; with two phases present it falls back to the homogeneous mixture and the traverse warns
//   gasTZ   dry gas, average temperature and Z (Katz et al. form; Economides et al.):
//             p_in² = e^s·p_out² + 25·γ·T̄·Z̄·f·L·q²·(e^s − 1) / (s·d⁵),  s = 0.0375·γ·Δz / (T̄·Z̄)
//           (p psia, q MMscf/d, T̄ °R, d in, f Moody, L = MD length and Δz = TVD rise in ft); (e^s − 1)/s → 1 as s → 0; Z̄ by
//           DAK at (p̄, T̄) through WTS_flowline_props (the same Z path as the marcher, incl. the impurity correction), iterated;
//           f (Colebrook) at N_Re = 20.09·γ·q_Mscfd / (d_in·μ_g). Applied segment by segment (tapered strings, deviation).
//           Its registry entry is the differential form of the same model (gas phase only, no slip, Darcy friction): the
//           marcher with corr 'gasTZ' is the cross-check of the closed form (§15.2, within 1 %).
//
// VERIFICATION GATE (D17, §15.1). Q9 — the owner's textbooks were not provided — so no correlation of this file has a verified
// published traverse: hb, gray, nsl, single and gasTZ ship with verified:false and the label
// "provisional — not verified against a published example". A provisional correlation cannot be a default, so defaultCorr()
// returns the verified Beggs & Brill ('bb', Brill & Mukherjee Ex. 4.7 in calc-flowline) for every fluid until a WP flips the flag
// with a verified example; the preferred defaults (D5: hb for oil, gray for gas / condensate) are named in its result.
//
// Interfaces (field units, §3.0; psia inside the engine; every result {ok, errors[], warnings[{code, msg, sev}], …}):
//   WTS_wp_vlp
//     .traverse(F, W, q, o /*{from:'top'|'bottom', p0 psia (or p0_psig), corr, mult, tProfile(md) °F, grid, stepFt, pMax psia,
//                             rough in, accel, refine, eroC, coarse}*/)
//         → {ok, corr, from, profile:[{md, tvd, inc, p psia, t, hl, pattern, vm, vsl, vsg, rhoS, gradEl, gradF, gradAcc, ero, restr?}]
//            (ordered by MD, top → bottom), pEnd psia | null, pTop, pBottom, lost {md, reason} | null, grid, segments, restrictionsDp,
//            restrictions[], vmMax, eroMax, warnings, errors}
//     .curve(F, W, o /*{qList, p0, corr, mult, coarse, grid, from}*/) → [{q, pwf psia | null, lost}] (+ .grid, .warnings, .corr)
//     .family(F, W, o, vary /*{key, values[], apply?(value, {F, W, o}) → {F, W, o}}*/) → [{value, curve}]
//     .gasDry(F, W, q /*Mscf/d*/, o /*{from, p0 psia, tProfile}*/) → {ok, pwf, pEnd, pTop, zAvg, tAvg, segments[], warnings}
//     .singlePhase(F, W, q, o) → {ok, pEnd, profile, warnings}  (traverse with corr 'single')
//     .defaultCorr(typeOrF) → {key, preferred, provisional, reason}; .list(kind?) → registry entries (well / gas / single / any)
//     .hbBubbleLimit(vm ft/s, dFt) → L_B; ._charts {cnl, hlPsi, psi} (the HB curve fits); .PROVISIONAL; .KEYS
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var GRAV = 32.174, GC = 32.174;            // ft/s², lbm·ft/(lbf·s²)
    var PATM = 14.696;                         // psia (the marcher's atmosphere)
    var RANK = 459.67;
    var SIG_LBM = 0.00220462;                  // dyn/cm → lbm/s²
    var HB_VS = 0.8;                           // ft/s, Griffith bubble-rise slip velocity
    var VERT_WARN_DEG = 30;                    // vertical-only correlations: warn above this inclination (§4.4)
    var PROVISIONAL = 'provisional — not verified against a published example';
    var KEYS = ['hb', 'gray', 'nsl', 'single', 'gasTZ'];

    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _log10(x) { return Math.log(x) / Math.LN10; }
    function _w(code, msg, sev) { return { code: code, msg: msg, sev: sev || 'warn' }; }
    function _fmt(v, d) {
        if (!_fin(v)) return '—';
        return G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, d == null ? 1 : d) : Number(v).toLocaleString('en-US', { maximumFractionDigits: d == null ? 1 : d });
    }
    // Moody (Darcy) friction factor: the Colebrook factor of 49-calc-flowline.js when loaded (reuse), else Swamee-Jain
    function _fMoody(nre, relRough) {
        var FF = G.WTS_flowline_friction;
        if (FF && typeof FF.colebrook === 'function') return FF.colebrook(nre, relRough);
        if (!(nre > 0)) return 0;
        if (nre < 2000) return 64 / nre;
        var a = _log10(Math.max(0, relRough || 0) / 3.7 + 5.74 / Math.pow(nre, 0.9));
        return 0.25 / (a * a);
    }
    function _num(v) { return Math.max(0, Number(v) || 0); }
    // common part of every result: the inputs read back as numbers
    function _base(inp) {
        var i = inp || {};
        var vsl = _num(i.vsl), vsg = _num(i.vsg), vm = vsl + vsg;
        var thDeg = Number(i.theta) || 0;
        return { vsl: vsl, vsg: vsg, vm: vm, theta: thDeg, th: thDeg * Math.PI / 180, dFt: Number(i.d) / 12, dIn: Number(i.d),
            rL: Number(i.rhoL), rG: Number(i.rhoG), muL: Number(i.muL), muG: Number(i.muG), sig: Number(i.sigma),
            rough: Number(i.rough) || 0, p: Number(i.p), accel: !!i.accel };
    }
    // the no-flow / no-diameter case (as WTS_flowline_bb)
    function _static(b) {
        var lam = b.vsl > 0 ? 1 : 0, rhoS = b.rL * lam + b.rG * (1 - lam);
        var gEl = rhoS * Math.sin(b.th) / 144;
        return { vsl: b.vsl, vsg: b.vsg, vm: b.vm, theta: b.theta, lambdaL: lam, hl: lam, pattern: 'none', rhoS: rhoS, rhoN: rhoS,
            gradEl: gEl, gradF: 0, gradAcc: 0, grad: gEl, Ek: 0, fn: 0 };
    }
    // assemble a result: elevation on ρ_s and the true inclination, the acceleration factor as Beggs & Brill (Ek = ρ_s·v_m·v_sg/(g_c·p·144))
    function _finish(b, r, rhoS, gF) {
        var gEl = rhoS * Math.sin(b.th) / 144;
        var Ek = (b.accel && b.p > 0) ? rhoS * b.vm * b.vsg / (GC * b.p * 144) : 0;
        var tot = Ek < 1 ? (gEl + gF) / (1 - Ek) : Infinity;
        r.vsl = b.vsl; r.vsg = b.vsg; r.vm = b.vm; r.theta = b.theta; r.rhoS = rhoS;
        r.gradEl = gEl; r.gradF = gF; r.Ek = Ek; r.grad = tot; r.gradAcc = tot - gEl - gF;
        return r;
    }

    // ── Hagedorn & Brown, modified ───────────────────────────────────────────────────────────────────────────────────
    function _cnl(NL) {
        var x = Math.max(0, NL);
        var v = (0.0019 + 0.0322 * x - 0.6642 * x * x + 4.9951 * x * x * x) / (1 - 10.0147 * x + 33.8696 * x * x + 277.2817 * x * x * x);
        return v > 0 ? v : 0.0019;
    }
    function _hlPsi(X1) {
        var x = Math.max(0, X1);
        var v = Math.sqrt((0.0047 + 1123.32 * x + 729489.64 * x * x) / (1 + 1097.1566 * x + 722153.97 * x * x));
        return Math.min(1, v);
    }
    function _psi(X2) {
        var x = Math.min(0.09, Math.max(0.01, X2));
        var v = (1.0886 - 69.9473 * x + 2334.3497 * x * x - 12896.683 * x * x * x) / (1 - 53.4401 * x + 1517.9369 * x * x - 8419.8115 * x * x * x);
        return (X2 <= 0.01 || !(v > 1)) ? 1 : v;
    }
    // Griffith bubble-flow limit, v_m in ft/s, d in FT (not inches): L_B = 1.071 − 0.2218·v_m²/d, at least 0.13
    function hbBubbleLimit(vm, dFt) { return Math.max(0.13, 1.071 - 0.2218 * vm * vm / dFt); }
    function _hbFrictionNonBubble(hl, b, rhoN) {
        var rhoS = b.rL * hl + b.rG * (1 - hl);
        var muS = Math.pow(Math.max(b.muL, 1e-9), hl) * Math.pow(Math.max(b.muG, 1e-9), 1 - hl);
        var nre = 1488 * rhoN * b.vm * b.dFt / muS;
        var f = _fMoody(nre, b.rough / 12 / b.dFt);
        return { f: f, nre: nre, gF: f * rhoN * rhoN * b.vm * b.vm / (2 * GC * b.dFt * rhoS) / 144 };
    }
    function _hbFrictionBubble(hl, b) {
        var vL = hl > 0 ? b.vsl / hl : 0, nre = 1488 * b.rL * vL * b.dFt / Math.max(b.muL, 1e-9);
        var f = _fMoody(nre, b.rough / 12 / b.dFt);
        return { f: f, nre: nre, gF: f * b.rL * vL * vL / (2 * GC * b.dFt) / 144 };
    }
    function hb(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var lam = b.vsl / b.vm, lamG = 1 - lam;
        var rhoN = b.rL * lam + b.rG * lamG, muN = b.muL * lam + b.muG * lamG;
        var r = { lambdaL: lam, rhoN: rhoN, muN: muN, corr: 'hb' };
        if (lam < 1e-7 || lam > 1 - 1e-9) {               // single phase: Darcy-Weisbach on the no-slip mixture
            r.pattern = lam < 1e-7 ? 'gas' : 'liquid'; r.hl = lam < 1e-7 ? 0 : 1;
            var nre0 = 1488 * rhoN * b.vm * b.dFt / Math.max(muN, 1e-9), f0 = _fMoody(nre0, b.rough / 12 / b.dFt);
            r.fn = f0; r.NRe = nre0;
            return _finish(b, r, rhoN, f0 * rhoN * b.vm * b.vm / (2 * GC * b.dFt) / 144);
        }
        var LB = hbBubbleLimit(b.vm, b.dFt);
        r.LB = LB;
        var hl, fr;
        if (lamG < LB) {                                   // Griffith bubble flow
            var a = 1 + b.vm / HB_VS, disc = a * a - 4 * b.vsg / HB_VS;
            hl = 1 - 0.5 * (a - Math.sqrt(Math.max(0, disc)));
            if (hl < lam) hl = lam;
            if (hl > 1) hl = 1;
            r.pattern = 'bubble'; r.bubble = true;
            fr = _hbFrictionBubble(hl, b);
        } else {
            var ql = Math.pow(b.rL / b.sig, 0.25);
            var NLv = 1.938 * b.vsl * ql, Ngv = 1.938 * b.vsg * ql;
            var ND = 120.872 * b.dFt * Math.sqrt(b.rL / b.sig);
            var NL = 0.15726 * b.muL * Math.pow(1 / (b.rL * b.sig * b.sig * b.sig), 0.25);
            var CNL = _cnl(NL);
            var X1 = NLv * Math.pow(Math.max(b.p, 1) / 14.7, 0.1) * CNL / (Math.pow(Ngv, 0.575) * ND);
            var X2 = Ngv * Math.pow(NL, 0.38) / Math.pow(ND, 2.14);
            var hp = _hlPsi(X1), ps = _psi(X2);
            hl = hp * ps;
            r.NLv = NLv; r.Ngv = Ngv; r.ND = ND; r.NL = NL; r.CNL = CNL; r.X1 = X1; r.X2 = X2; r.hlPsi = hp; r.psi = ps; r.hlChart = hl;
            if (!(hl >= lam)) hl = lam;                    // holdup ≥ no-slip
            if (hl > 1) hl = 1;
            r.pattern = 'slug'; r.bubble = false;
            fr = _hbFrictionNonBubble(hl, b, rhoN);
        }
        r.hl = hl; r.fn = fr.f; r.NRe = fr.nre;
        return _finish(b, r, b.rL * hl + b.rG * (1 - hl), fr.gF);
    }
    // friction rebuilt at a scaled holdup (opt.mult, D10): the slip-viscosity Reynolds number and ρ_n²/ρ_s, or the bubble-flow form
    function hbFriction(hl, inp, g) {
        if (!g || g.pattern === 'gas' || g.pattern === 'liquid' || g.pattern === 'none' || !(hl > 0)) return g ? g.gradF : 0;
        var b = _base(inp);
        return g.bubble ? _hbFrictionBubble(hl, b).gF : _hbFrictionNonBubble(hl, b, g.rhoN).gF;
    }

    // ── Gray (1974) ──────────────────────────────────────────────────────────────────────────────────────────────────
    function gray(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var lam = b.vsl / b.vm, lamG = 1 - lam;
        var rhoN = b.rL * lam + b.rG * lamG, muN = b.muL * lam + b.muG * lamG;
        var r = { lambdaL: lam, rhoN: rhoN, muN: muN, corr: 'gray' };
        var epsFt = b.rough / 12, hl, f, epsEff = epsFt;
        if (lam < 1e-9 || lam > 1 - 1e-9 || !(b.rL > b.rG) || !(b.sig > 0)) {
            hl = lam; r.pattern = lam < 0.5 ? 'gas' : 'liquid';       // single phase (or no surface tension): no slip
            var nre0 = 1488 * rhoN * b.vm * b.dFt / Math.max(muN, 1e-9);
            f = _fMoody(nre0, epsFt / b.dFt); r.NRe = nre0;
        } else {
            var sigM = b.sig * SIG_LBM;                                         // lbm/s²
            var R = b.vsl / b.vsg;
            var Nv = rhoN * rhoN * Math.pow(b.vm, 4) / (GRAV * sigM * (b.rL - b.rG));
            var ND = GRAV * (b.rL - b.rG) * b.dFt * b.dFt / sigM;
            var B = 0.0814 * (1 - 0.0554 * Math.log(1 + 730 * R / (R + 1)));
            var A = -2.314 * Math.pow(Nv * (1 + 205 / ND), B);
            hl = 1 - (1 - lam) * (1 - Math.exp(A));
            if (hl < lam) hl = lam;
            if (hl > 1) hl = 1;
            var e2 = 28.5 * sigM / (rhoN * b.vm * b.vm);                        // ft
            epsEff = R >= 0.007 ? e2 : epsFt + R * (e2 - epsFt) / 0.007;
            if (epsEff < 2.77e-5) epsEff = 2.77e-5;
            f = _fMoody(1e7, epsEff / b.dFt);
            r.R = R; r.Nv = Nv; r.ND = ND; r.B = B; r.A = A; r.NRe = 1e7;
            r.pattern = 'mist';
        }
        r.hl = hl; r.fn = f; r.epsEff = epsEff;
        return _finish(b, r, b.rL * hl + b.rG * (1 - hl), f * rhoN * b.vm * b.vm / (2 * GC * b.dFt) / 144);
    }

    // ── homogeneous no-slip ──────────────────────────────────────────────────────────────────────────────────────────
    function nsl(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var lam = b.vsl / b.vm, rhoN = b.rL * lam + b.rG * (1 - lam), muN = b.muL * lam + b.muG * (1 - lam);
        var nre = 1488 * rhoN * b.vm * b.dFt / Math.max(muN, 1e-9), f = _fMoody(nre, b.rough / 12 / b.dFt);
        var r = { lambdaL: lam, rhoN: rhoN, muN: muN, hl: lam, fn: f, NRe: nre, corr: 'nsl',
            pattern: lam < 1e-7 ? 'gas' : lam > 1 - 1e-9 ? 'liquid' : 'homogeneous' };
        return _finish(b, r, rhoN, f * rhoN * b.vm * b.vm / (2 * GC * b.dFt) / 144);
    }

    // ── single phase (Darcy-Weisbach, Colebrook) ─────────────────────────────────────────────────────────────────────
    function single(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var lam = b.vsl / b.vm, two = lam > 1e-6 && lam < 1 - 1e-6;
        var liq = lam >= 0.5;
        var rho = two ? b.rL * lam + b.rG * (1 - lam) : (liq ? b.rL : b.rG);
        var mu = two ? b.muL * lam + b.muG * (1 - lam) : (liq ? b.muL : b.muG);
        var nre = 1488 * rho * b.vm * b.dFt / Math.max(mu, 1e-9), f = _fMoody(nre, b.rough / 12 / b.dFt);
        var r = { lambdaL: two ? lam : (liq ? 1 : 0), rhoN: rho, muN: mu, hl: two ? lam : (liq ? 1 : 0), fn: f, NRe: nre, corr: 'single',
            pattern: two ? 'homogeneous' : (liq ? 'liquid' : 'gas'), twoPhase: two };
        return _finish(b, r, rho, f * rho * b.vm * b.vm / (2 * GC * b.dFt) / 144);
    }

    // ── dry gas: point form (gas phase only, no slip, Darcy friction) ────────────────────────────────────────────────
    function gasPoint(inp) {
        var b = _base(inp);
        var r = { corr: 'gasTZ', lambdaL: 0, hl: 0, rhoN: b.rG, muN: b.muG, pattern: 'gas', liquidIgnored: b.vsl > 0 };
        b.vsl = 0; b.vm = b.vsg;
        if (!(b.vm > 0) || !(b.dFt > 0)) { r.fn = 0; return _finish(b, r, b.rG, 0); }
        var nre = 1488 * b.rG * b.vm * b.dFt / Math.max(b.muG, 1e-9), f = _fMoody(nre, b.rough / 12 / b.dFt);
        r.fn = f; r.NRe = nre;
        return _finish(b, r, b.rG, f * b.rG * b.vm * b.vm / (2 * GC * b.dFt) / 144);
    }

    // ── registry (merge, never replace; D3) ──────────────────────────────────────────────────────────────────────────
    // 49-calc-flowline.js owns WTS_flowline_corr (it loads first in Round 9); the entries are added to it when it exists — at load
    // and again at call time (_reg) — and the registry is never created here, so an older marcher without it stays untouched.
    var ENTRIES = {
        hb: { key: 'hb', label: 'Hagedorn & Brown (1965), modified (Griffith bubble flow, holdup ≥ no-slip)', kind: 'well', vertical: true,
            range: { incl: [0, VERT_WARN_DEG], dMaxIn: 4.5, note: 'vertical oil wells; original tubing 1–2-1/2 in nominal' },
            grad: hb, friction: hbFriction },
        gray: { key: 'gray', label: 'Gray (1974), gas and condensate wells', kind: 'gas', vertical: true,
            range: { incl: [0, VERT_WARN_DEG], vmMax: 50, dMaxIn: 3.5, cgrMax: 50, wgrMax: 5, note: 'vertical gas wells' },
            grad: gray },
        nsl: { key: 'nsl', label: 'Homogeneous no-slip (lower bound)', kind: 'any', vertical: false, range: { incl: [-90, 90] }, grad: nsl },
        single: { key: 'single', label: 'Single phase, Darcy-Weisbach with Colebrook', kind: 'single', vertical: false, range: { incl: [-90, 90] },
            grad: single },
        gasTZ: { key: 'gasTZ', label: 'Dry gas, average temperature and Z', kind: 'gas', vertical: false, range: { incl: [-90, 90], note: 'gas only' },
            grad: gasPoint }
    };
    KEYS.forEach(function (k) {
        var e = ENTRIES[k];
        e.verified = false;                 // D17 gate: Q9 — no verified published example yet
        e.provisional = PROVISIONAL;
        e.source = k === 'hb' ? 'Hagedorn & Brown (1965); Griffith (1961); chart fits as printed by Economides et al. and Guo et al.' :
            k === 'gray' ? 'Gray (1974), as given in API RP 14B and Brill & Mukherjee (1999)' :
            k === 'gasTZ' ? 'average temperature and Z method (Katz et al.; Economides et al.)' :
            k === 'single' ? 'Darcy-Weisbach with the Colebrook (1939) friction factor' : 'homogeneous mixture';
    });
    function _reg() {
        var R = G.WTS_flowline_corr;
        if (!R || typeof R !== 'object') return ENTRIES;
        KEYS.forEach(function (k) { if (!R[k]) R[k] = ENTRIES[k]; });
        return R;
    }
    _reg();

    // D5 preferred defaults; D17: a provisional correlation is never a default → Beggs & Brill until verified
    var PREFERRED = { oil: 'hb', gas: 'gray', condensate: 'gray', water: 'single', waterinj: 'single', gasinj: 'gasTZ' };
    function defaultCorr(t) {
        var type = (t && typeof t === 'object') ? t.type : t;
        var pref = PREFERRED[type] || 'hb', e = _reg()[pref];
        if (e && e.verified === true) return { key: pref, preferred: pref, provisional: false, reason: 'default for ' + (type || 'oil') + ' wells (D5)' };
        return { key: 'bb', preferred: pref, provisional: true,
            reason: (e ? e.label : pref) + ' is ' + PROVISIONAL + ', so the verified Beggs & Brill is the default (D17)' };
    }
    function list(kind) {
        var out = [];
        var CORR = _reg();
        Object.keys(CORR).forEach(function (k) {
            var e = CORR[k];
            if (!e || typeof e.grad !== 'function') return;
            if (kind && e.kind !== kind && e.kind !== 'any') return;
            out.push({ key: e.key || k, label: e.label || k, kind: e.kind || 'any', verified: e.verified === true, vertical: !!e.vertical,
                provisional: e.verified === true ? null : PROVISIONAL, range: e.range || {} });
        });
        return out;
    }

    // ── fluid: the flowline fluid at a rate (WP1's flowlineFluid; the same split rules locally while WP1 is a stub) ─────
    function _ff(F, q) {
        var WF = G.WTS_wp_fluid;
        if (WF && typeof WF.flowlineFluid === 'function' && (G.__WP_STUBS || []).indexOf('WTS_wp_fluid.flowlineFluid') === -1) {
            var r = WF.flowlineFluid(F, q);
            if (r && _fin(r.qo) && _fin(r.qg)) return r;
        }
        // fallback (documented in 49-calc-wp-fluid.js): a number on F.rateBasis or {qo, qw, qg_Mscfd}
        var t = F.type || 'oil', qo = 0, qw = 0, qg = 0;
        if (q && typeof q === 'object') { qo = _num(q.qo); qw = _num(q.qw); qg = _num(q.qg_Mscfd); }
        else {
            var v = _num(q);
            if (t === 'oil') { var wc = _fin(F.wc) ? F.wc : 0; qo = v * (1 - wc); qw = v * wc; qg = qo * (_num(F.gor)) / 1000; }
            else if (t === 'water' || t === 'waterinj') qw = v;
            else { qg = v; qo = _num(F.cgr) * v / 1000; qw = _num(F.wgr) * v / 1000; }
        }
        return { qo: qo, qw: qw, qg: qg / 1000, qg_MMscfd: qg / 1000, api: _fin(F.api) ? F.api : 35, sgg: _fin(F.sgg) ? F.sgg : 0.65,
            sgw: _fin(F.sgw) ? F.sgw : 1.07, pvt: F.pvt || {} };
    }

    // ── well path: W.segments (flow order, bottom → top; WP4 contract) → march segments with an MD / TVD map ─────────────
    function _path(W) {
        var src = (W && Array.isArray(W.segments)) ? W.segments : [];
        var segs = src.filter(function (s) { return s && +s.len > 0 && +s.id > 0; }).map(function (s) {
            var len = +s.len, inc = _fin(+s.inc) ? +s.inc : NaN, dz = _fin(+s.dz) ? +s.dz : NaN;
            if (!_fin(dz) && _fin(+s.tvd0) && _fin(+s.tvd1)) dz = Math.abs(+s.tvd1 - +s.tvd0);
            if (!_fin(dz) && _fin(inc)) dz = len * Math.cos(inc * Math.PI / 180);
            if (!_fin(dz)) dz = len;
            if (!_fin(inc)) inc = Math.acos(Math.max(-1, Math.min(1, dz / len))) * 180 / Math.PI;
            var o = { name: s.name || '', len: len, id: +s.id, dz: dz, inc: inc, rough: _fin(+s.rough) ? +s.rough : null };
            if (+s.area > 0) o.area = +s.area;
            if (s.restr && +s.restr.d > 0) o.restr = { d: +s.restr.d, k: s.restr.k == null ? null : +s.restr.k, kind: s.restr.kind || null };
            var m0 = +s.md0, m1 = +s.md1;
            if (_fin(m0) && _fin(m1)) { o.mdTop = Math.min(m0, m1); o.mdBot = Math.max(m0, m1); }
            var t0 = +s.tvd0, t1 = +s.tvd1;
            if (_fin(t0) && _fin(t1)) { o.tvdTop = (m0 <= m1) ? t0 : t1; o.tvdBot = (m0 <= m1) ? t1 : t0; if (!(o.tvdTop <= o.tvdBot)) { var x = o.tvdTop; o.tvdTop = o.tvdBot; o.tvdBot = x; } }
            return o;
        });
        var haveMd = segs.length && segs.every(function (s) { return _fin(s.mdTop); });
        if (haveMd) segs.sort(function (a, b) { return b.mdTop - a.mdTop; });       // flow order: deepest first
        else {
            // contiguous from the wellhead (W.nodes.wellheadMd or 0), flow order as given
            var md = (W && W.nodes && _fin(+W.nodes.wellheadMd)) ? +W.nodes.wellheadMd : 0;
            for (var i = segs.length - 1; i >= 0; i--) { segs[i].mdTop = md; segs[i].mdBot = md + segs[i].len; md += segs[i].len; }
        }
        // TVD where WP4 did not give it: cumulative from the top
        var tvd = null;
        for (var j = segs.length - 1; j >= 0; j--) {
            var s2 = segs[j];
            if (!_fin(s2.tvdTop)) { s2.tvdTop = tvd == null ? s2.mdTop : tvd; s2.tvdBot = s2.tvdTop + s2.dz; }
            tvd = s2.tvdBot;
        }
        return segs;
    }
    function _roughOf(o, segs) {
        if (o && +o.rough > 0) return { v: +o.rough, mixed: false };
        var rs = segs.map(function (s) { return s.rough; }).filter(function (v) { return v > 0; });
        if (!rs.length) return { v: 0.0006, mixed: false };                          // Q10 default for wells (new steel)
        // one roughness per march: the length-weighted mean of the strings (the marcher takes one value)
        var L = 0, S = 0;
        segs.forEach(function (s) { if (s.rough > 0) { L += s.len; S += s.len * s.rough; } });
        var v = S / L, mixed = rs.some(function (x) { return Math.abs(x - rs[0]) > 1e-12; });
        return { v: v, mixed: mixed };
    }
    function _tFn(W, o) {
        if (o && typeof o.tProfile === 'function') return o.tProfile;
        if (W && typeof W.tAt === 'function') return W.tAt;
        if (o && _fin(+o.tTop) && _fin(+o.tBot)) {
            var a = +o.tTop, bT = +o.tBot, top = _fin(+o.mdTop) ? +o.mdTop : 0, bot = _fin(+o.mdBot) ? +o.mdBot : null;
            return function (md) { return bot > top ? a + (bT - a) * (md - top) / (bot - top) : a; };
        }
        return null;
    }
    function _corrKey(F, o) {
        if (o && o.corr != null && o.corr !== '') return String(o.corr);
        return defaultCorr(F && F.type).key;
    }

    // ── traverse ─────────────────────────────────────────────────────────────────────────────────────────────────────
    function traverse(F, W, q, o) {
        o = o || {};
        var errors = [], warnings = [];
        var fail = function (code, msg) { return { ok: false, code: code, errors: [msg], warnings: warnings, profile: [], pEnd: null, lost: null }; };
        if (typeof G.WTS_flowline_march !== 'function') return fail('MISSING_ENGINE', 'WTS_flowline_march is not loaded');
        if (!F || F.ok === false) return fail('NO_FLUID', 'the fluid is not built');
        var segs = _path(W);
        if (!segs.length) return fail('NO_PATH', 'the well has no flow path (segments)');
        var key = _corrKey(F, o), REG = _reg(), E = (REG === G.WTS_flowline_corr && Object.prototype.hasOwnProperty.call(REG, key)) ? REG[key] : null;
        if (!E || typeof E.grad !== 'function') return { ok: false, code: 'UNKNOWN_CORR', corr: key, errors: ['unknown correlation key ' + String(key).slice(0, 40)], warnings: warnings, profile: [], pEnd: null, lost: null };
        var from = o.from === 'bottom' ? 'bottom' : 'top';
        var p0 = _fin(+o.p0) ? +o.p0 : (_fin(+o.p0_psig) ? +o.p0_psig + PATM : NaN);
        if (!(p0 > 0)) return fail('NO_P0', 'the start pressure p0 (psia) is missing');
        var tF = _tFn(W, o);
        if (!tF) return fail('NO_TEMP', 'no temperature profile (W.tAt or o.tProfile)');
        var ff = _ff(F, q);
        // march order: top → bottom (against the flow) from the wellhead, or bottom → top (with the flow) from the bottom
        var mseg = from === 'top' ? segs.slice().reverse() : segs.slice();
        var xs = [], x = 0;
        mseg.forEach(function (s) { var a = from === 'top' ? s.mdTop : s.mdBot, bE = from === 'top' ? s.mdBot : s.mdTop; xs.push({ x0: x, x1: x + s.len, md0: a, md1: bE, s: s }); x += s.len; });
        var mdOf = function (xx) {
            for (var i = 0; i < xs.length; i++) { var r = xs[i]; if (xx <= r.x1 + 1e-9 || i === xs.length - 1) { var fr = r.x1 > r.x0 ? Math.min(1, Math.max(0, (xx - r.x0) / (r.x1 - r.x0))) : 0; return { md: r.md0 + (r.md1 - r.md0) * fr, r: r, fr: fr }; } }
            return { md: xs[0].md0, r: xs[0], fr: 0 };
        };
        var tAt = function (xx) { return tF(mdOf(xx).md); };
        var rough = _roughOf(o, segs);
        if (rough.mixed) warnings.push(_w('ROUGH_MIXED', 'The strings have different roughness: one length-weighted value ' + _fmt(rough.v, 5) + ' in is used for the whole path.', 'info'));
        var stepFt = +o.stepFt > 0 ? +o.stepFt : 100;
        if (o.coarse) stepFt *= 2;
        var mo = { corr: key, reverse: from === 'top', tAt: tAt, stepFt: stepFt, detail: true, rough: rough.v,
            accel: o.accel !== false, payne: o.payne !== false, refine: o.refine !== false };
        if (o.mult && typeof o.mult === 'object' && (+o.mult.hl !== 1 || +o.mult.f !== 1)) mo.mult = o.mult;
        if (+o.pMax > 0) mo.pMax = +o.pMax;
        if (o.grid) mo.grid = o.grid;
        if (+o.eroC > 0) mo.eroC = +o.eroC;
        var m = G.WTS_flowline_march(mseg.map(function (s) { var c = { name: s.name, len: s.len, id: s.id, dz: s.dz }; if (s.area) c.area = s.area; if (s.restr) c.restr = s.restr; return c; }),
            ff, p0 - PATM, NaN, NaN, mo);
        if (!m) return fail('MISSING_ENGINE', 'the fluid-property library is not loaded');
        if (m.ok === false) return { ok: false, code: m.code || 'MARCH_FAILED', corr: key, errors: m.errors || ['march failed'], warnings: warnings, profile: [], pEnd: null, lost: null };
        // profile in MD order (top → bottom), pressures psia
        var prof = [], last = null;
        m.profile.forEach(function (e) {
            var w = mdOf(e.x), r = w.r, s = r.s;
            var tvdTop = s.tvdTop, tvdBot = s.tvdBot;
            var frTop = (w.md - s.mdTop) / (s.mdBot - s.mdTop || 1);
            var row = { md: w.md, tvd: tvdTop + (tvdBot - tvdTop) * Math.min(1, Math.max(0, frTop)), inc: s.inc, p: e.p + PATM, t: e.t,
                hl: e.hl != null ? e.hl : null, pattern: e.pattern || null, vm: e.vm, vsl: e.vsl, vsg: e.vsg, rhoS: e.rhoS,
                gradEl: e.gradEl, gradF: e.gradF, gradAcc: e.gradAcc, ero: e.ero };
            if (e.restr) { row.restr = true; row.dpRestr = e.dp; }
            prof.push(row);
        });
        // fill the start point and the restriction rows from their neighbours (the marcher records no gradient there)
        for (var i = 0; i < prof.length; i++) {
            if (prof[i].hl == null) {
                var nb = null;
                for (var j = i + 1; j < prof.length && !nb; j++) if (prof[j].hl != null) nb = prof[j];
                for (var k2 = i - 1; k2 >= 0 && !nb; k2--) if (prof[k2].hl != null) nb = prof[k2];
                if (nb) ['hl', 'pattern', 'vm', 'vsl', 'vsg', 'rhoS', 'gradEl', 'gradF', 'gradAcc', 'ero'].forEach(function (f) { if (prof[i][f] == null) prof[i][f] = nb[f]; });
            }
        }
        if (from === 'bottom') prof.reverse();         // MD order, top → bottom (restriction rows keep their place)
        var lost = m.lost ? { md: mdOf(m.lost.x).md, reason: m.lost.reason } : null;
        var pEnd = lost ? null : m.pOut + PATM;
        var restr = [], dpR = 0, vmMax = 0, eroMax = 0;
        var segOut = m.segments.map(function (r, idx) {
            var s = mseg[idx];
            if (r.dpRestr > 0) { dpR += r.dpRestr; restr.push({ md: s.mdBot /* the segment's flow inlet */, dp: r.dpRestr, d: r.restr.d, beta: r.restr.beta, K: r.restr.K, v: r.restr.v, kind: s.restr && s.restr.kind }); }
            if (r.vmMax > vmMax) vmMax = r.vmMax;
            if (r.eroMax > eroMax) eroMax = r.eroMax;
            return { name: s.name, mdTop: s.mdTop, mdBot: s.mdBot, tvdTop: s.tvdTop, tvdBot: s.tvdBot, inc: s.inc, len: s.len, id: s.id,
                pIn: r.pIn == null ? null : r.pIn + PATM, pOut: r.pOut == null ? null : r.pOut + PATM, dpEl: r.dpEl, dpF: r.dpF, dpAcc: r.dpAcc,
                dpRestr: r.dpRestr || 0, patterns: r.patterns, vmMax: r.vmMax, eroMax: r.eroMax };
        });
        // warnings: vertical-only correlations on deviated sections, ranges, provisional label
        if (E.vertical) {
            var incMax = 0, mdAt = null;
            segs.forEach(function (s) { if (s.inc > incMax) { incMax = s.inc; mdAt = s.mdTop; } });
            if (incMax > VERT_WARN_DEG) warnings.push(_w('VERTICAL_ONLY', E.label + ' is a vertical-well correlation; the path reaches ' + _fmt(incMax, 0) +
                '° from vertical (MD ' + _fmt(mdAt, 0) + ' ft). The elevation term uses the true inclination; Beggs & Brill is suggested for this well.'));
        }
        var R = E.range || {};
        var dMax = 0; segs.forEach(function (s) { if (s.id > dMax) dMax = s.id; });
        if (R.dMaxIn && dMax > R.dMaxIn) warnings.push(_w('RANGE_D', E.label + ': flow diameter ' + _fmt(dMax, 3) + ' in is above the data range (≤ ' + R.dMaxIn + ' in).'));
        if (R.vmMax && vmMax > R.vmMax) warnings.push(_w('RANGE_VM', E.label + ': mixture velocity ' + _fmt(vmMax, 1) + ' ft/s is above the data range (< ' + R.vmMax + ' ft/s).'));
        if (R.cgrMax != null && _num(F.cgr) > R.cgrMax) warnings.push(_w('RANGE_CGR', E.label + ': condensate ratio ' + _fmt(F.cgr, 1) + ' bbl/MMscf is above the data range (≤ ' + R.cgrMax + ').'));
        if (R.wgrMax != null && _num(F.wgr) > R.wgrMax) warnings.push(_w('RANGE_WGR', E.label + ': water ratio ' + _fmt(F.wgr, 1) + ' bbl/MMscf is above the data range (≤ ' + R.wgrMax + ').'));
        if (key === 'single' && prof.some(function (r) { return r.pattern === 'homogeneous'; })) warnings.push(_w('SINGLE_TWO_PHASE', 'Single-phase method with free gas present: a homogeneous mixture is used; choose a multiphase correlation.'));
        if (key === 'gasTZ' && (ff.qo > 0 || ff.qw > 0)) warnings.push(_w('GAS_ONLY', 'Dry-gas method: the liquids are not included in the gradient.'));
        if (E.verified !== true) warnings.push(_w('PROVISIONAL', E.label + ': ' + PROVISIONAL + '.', 'info'));
        if (lost) warnings.push(_w('LOST', 'The traverse stops at MD ' + _fmt(lost.md, 0) + ' ft (' + lost.reason + ').'));
        var res = { ok: !lost, corr: key, from: from, label: E.label, verified: E.verified === true, profile: prof, pEnd: pEnd,
            pTop: prof.length ? prof[0].p : null, pBottom: prof.length ? prof[prof.length - 1].p : null, lost: lost,
            grid: m.grid || null, segments: segOut, restrictionsDp: dpR, restrictions: restr, vmMax: vmMax, eroMax: eroMax,
            rough: rough.v, stepFt: stepFt, warnings: warnings, errors: errors };
        if (lost) { res.code = 'LOST'; res.errors = ['traverse lost (' + lost.reason + ')']; res.pTop = from === 'top' ? p0 : null; res.pBottom = from === 'bottom' ? p0 : null; }
        return res;
    }

    // ── curve: the tubing (outflow) curve, pwf(q) from a fixed wellhead pressure ─────────────────────────────────────────
    function curve(F, W, o) {
        o = o || {};
        var qs = (Array.isArray(o.qList) ? o.qList : []).map(Number).filter(function (v) { return _fin(v) && v > 0; });
        var out = [];
        out.warnings = []; out.corr = _corrKey(F, o); out.grid = null;
        if (!qs.length) { out.warnings.push(_w('NO_RATES', 'no rates for the curve')); return out; }
        var from = o.from === 'bottom' ? 'bottom' : 'top';
        var grid = (o.grid && typeof o.grid === 'object') ? o.grid : null;
        if (o.grid === true) {                         // freeze the step layout at the mid rate (§4.5 smoothness)
            var qRef = qs.slice().sort(function (a, b) { return a - b; })[Math.floor(qs.length / 2)];
            var tr0 = traverse(F, W, qRef, Object.assign({}, o, { grid: true, from: from }));
            if (tr0 && tr0.grid) grid = tr0.grid;
        }
        out.grid = grid;
        var seen = {};
        qs.forEach(function (q) {
            var tr = traverse(F, W, q, Object.assign({}, o, { grid: grid || undefined, from: from }));
            (tr.warnings || []).forEach(function (w) { if (!seen[w.code]) { seen[w.code] = 1; out.warnings.push(w); } });
            out.push({ q: q, pwf: tr.ok ? (from === 'top' ? tr.pEnd : tr.pTop) : null, pwh: tr.ok ? (from === 'top' ? tr.pTop : tr.pEnd) : null, lost: tr.lost || (tr.ok ? null : { reason: tr.code || 'failed' }) });
        });
        return out;
    }

    // ── family: several curves, one input varied ───────────────────────────────────────────────────────────────────────
    function family(F, W, o, vary) {
        vary = vary || {};
        var vals = Array.isArray(vary.values) ? vary.values : [];
        return vals.map(function (v) {
            var ctx = { F: F, W: W, o: Object.assign({}, o || {}) };
            if (typeof vary.apply === 'function') { var r = vary.apply(v, ctx); if (r) ctx = { F: r.F || ctx.F, W: r.W || ctx.W, o: r.o || ctx.o }; }
            else if (vary.key) ctx.o[vary.key] = v;
            return { value: v, curve: curve(ctx.F, ctx.W, ctx.o) };
        });
    }

    // ── gasDry: average T and Z, segment by segment ───────────────────────────────────────────────────────────────────
    function gasDry(F, W, q, o) {
        o = o || {};
        var warnings = [];
        var fail = function (code, msg) { return { ok: false, code: code, errors: [msg], warnings: warnings, pwf: null, pEnd: null }; };
        if (typeof G.WTS_flowline_props !== 'function') return fail('MISSING_ENGINE', 'WTS_flowline_props is not loaded');
        if (!F || F.ok === false) return fail('NO_FLUID', 'the fluid is not built');
        var segs = _path(W);
        if (!segs.length) return fail('NO_PATH', 'the well has no flow path (segments)');
        var tF = _tFn(W, o);
        if (!tF) return fail('NO_TEMP', 'no temperature profile (W.tAt or o.tProfile)');
        var from = o.from === 'bottom' ? 'bottom' : 'top';
        var p0 = _fin(+o.p0) ? +o.p0 : (_fin(+o.p0_psig) ? +o.p0_psig + PATM : NaN);
        if (!(p0 > 0)) return fail('NO_P0', 'the start pressure p0 (psia) is missing');
        var ffq = _ff(F, q);
        var qMM = _num(ffq.qg), qM = qMM * 1000, sg = _fin(+ffq.sgg) ? +ffq.sgg : 0.65;
        if (ffq.qo > 0 || ffq.qw > 0) warnings.push(_w('GAS_ONLY', 'Dry-gas method: the liquids are not included.'));
        if (segs.some(function (s) { return s.restr; })) warnings.push(_w('RESTR_IGNORED', 'Dry-gas method: restriction losses are not included.', 'info'));
        var gasOnly = { qo: 0, qw: 0, qg: Math.max(qMM, 1e-9), api: ffq.api, sgg: sg, sgw: ffq.sgw, pvt: ffq.pvt };
        var rough = _roughOf(o, segs).v;
        var order = from === 'top' ? segs.slice().reverse() : segs.slice();      // top-down: wellhead first
        var p = p0, zS = 0, tS = 0, Ls = 0, out = [];
        for (var i = 0; i < order.length; i++) {
            var s = order[i], tTop = tF(s.mdTop), tBot = tF(s.mdBot), Tb = (tTop + tBot) / 2 + RANK;
            var d = s.id, L = s.len, dz = s.dz;
            var pk = p, pOther = p, Z = 0.9, mu = 0.015;
            for (var it = 0; it < 40; it++) {
                var pr = G.WTS_flowline_props(gasOnly, Math.max((pk + pOther) / 2, 1), Tb - RANK);
                if (!pr || !_fin(pr.z)) return fail('PVT', 'Z could not be evaluated');
                Z = pr.z; mu = pr.mug;
                var sx = 0.0375 * sg * dz / (Tb * Z), es = Math.exp(sx), fac = Math.abs(sx) > 1e-9 ? (es - 1) / sx : 1 + sx / 2;
                var nre = qM > 0 ? 20.09 * sg * qM / (d * mu) : 0, f = qM > 0 ? _fMoody(nre, rough / d) : 0;
                var Cf = 25 * sg * Tb * Z * f * L * qMM * qMM * fac / Math.pow(d, 5);
                var pn;
                if (from === 'top') pn = Math.sqrt(es * pk * pk + Cf);                       // p_in (bottom) from p_out (top)
                else { var v = (pk * pk - Cf) / es; if (!(v > PATM * PATM)) return Object.assign(fail('LOST', 'the gas cannot reach the wellhead at this rate'), { lost: { md: s.mdTop, reason: 'pressure' } }); pn = Math.sqrt(v); }
                var done = Math.abs(pn - pOther) < 1e-7 * pn;
                pOther = pn;
                if (done) break;
            }
            out.push({ name: s.name, mdTop: s.mdTop, mdBot: s.mdBot, inc: s.inc, pTop: from === 'top' ? p : pOther, pBot: from === 'top' ? pOther : p, zAvg: Z, tAvg: Tb - RANK, s: 0.0375 * sg * dz / (Tb * Z) });
            zS += Z * L; tS += (Tb - RANK) * L; Ls += L;
            p = pOther;
        }
        var res = { ok: true, corr: 'gasTZ', from: from, pEnd: p, pwf: from === 'top' ? p : p0, pwh: from === 'top' ? p0 : p, pTop: from === 'top' ? p0 : p,
            zAvg: zS / Ls, tAvg: tS / Ls, segments: from === 'top' ? out : out.slice().reverse(), warnings: warnings, errors: [] };
        warnings.push(_w('PROVISIONAL', ENTRIES.gasTZ.label + ': ' + PROVISIONAL + '.', 'info'));
        return res;
    }

    function singlePhase(F, W, q, o) {
        var r = traverse(F, W, q, Object.assign({}, o || {}, { corr: 'single' }));
        return { ok: r.ok, code: r.code, pEnd: r.pEnd, profile: r.profile, warnings: r.warnings || [], errors: r.errors || [], lost: r.lost || null };
    }

    var NS = G.WTS_wp_vlp = G.WTS_wp_vlp || {};
    NS.traverse = traverse; NS.curve = curve; NS.family = family; NS.gasDry = gasDry; NS.singlePhase = singlePhase;
    NS.defaultCorr = defaultCorr; NS.list = list; NS.hbBubbleLimit = hbBubbleLimit;
    NS._charts = { cnl: _cnl, hlPsi: _hlPsi, psi: _psi };
    NS.PROVISIONAL = PROVISIONAL; NS.KEYS = KEYS.slice(); NS.PREFERRED = PREFERRED;
    // WP3 implements every WTS_wp_vlp function: drop them from the WP0 stub list
    var STUBS = G.__WP_STUBS;
    if (Array.isArray(STUBS)) {
        ['WTS_wp_vlp.traverse', 'WTS_wp_vlp.curve', 'WTS_wp_vlp.family', 'WTS_wp_vlp.gasDry', 'WTS_wp_vlp.singlePhase'].forEach(function (n) {
            var i = STUBS.indexOf(n); if (i >= 0) STUBS.splice(i, 1);
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var V = G.WTS_wp_vlp, C = G.WTS_flowline_corr, bad = [];
    if (!V || typeof V.traverse !== 'function') bad.push('WTS_wp_vlp.traverse missing');
    ['hb', 'gray', 'nsl', 'single', 'gasTZ'].forEach(function (k) { if (!C || !C[k] || typeof C[k].grad !== 'function') bad.push(k + ' not registered'); });
    if (V && V.hbBubbleLimit && Math.abs(V.hbBubbleLimit(1, 0.5) - (1.071 - 0.2218 / 0.5)) > 1e-12) bad.push('HB bubble limit');
    // water column at a creeping rate: gradEl = ρ_L/144, no friction to speak of
    if (C && C.hb) {
        var g = C.hb.grad({ vsl: 1e-6, vsg: 0, d: 2.441, rhoL: 62.4, rhoG: 0.1, muL: 1, muG: 0.01, sigma: 70, theta: 90, rough: 0.0006, p: 1000 });
        if (Math.abs(g.gradEl - 62.4 / 144) > 1e-12 || g.gradF > 1e-9) bad.push('HB hydrostatic');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-vlp.js self-test] ' + bad.join('; '));
})();
