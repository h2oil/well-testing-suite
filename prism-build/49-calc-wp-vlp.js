// =============================================================================
// WTS — 49-calc-wp-vlp.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance vertical lift (WP3, increment A1; WP12, increment A2) — docs/WELL-PERFORMANCE-PLAN.md §3.4, §4.4, §4.5, §15.1,
// §15.2, D3, D5, D17.
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
//   dr      Duns & Ros (1963), WP12 (A2): Ros flow-pattern regions I (bubble / plug), II (slug), transition, III (mist) by N_gv against
//           N_Lv with the N_d-dependent L1 / L2; slip velocity per region (F1–F7 chart readings); mist friction on the liquid-film
//           roughness (Weber rule); the transition interpolated. Equations and units at the code (section "Duns & Ros"). Vertical-only.
//   gasCS   Cullender & Smith (1956), WP12 (A2): ∫ (p/TZ)/[F² + (p/TZ)²(TVD/MD)/1000] dp = 18.75·γ·MD, F² = 0.667·f·q²/d⁵ (q MMscf/d,
//           d in, T °R, f Moody); the registry entry is the differentiated integrand (gas phase only), the closed form (two half-
//           lengths, then Simpson, per segment) is gasCS() / gasDry(…, {method:'cs'}) — the cross-check of gasTZ and of the marcher.
//
// VERIFICATION GATE (D17, §15.1). Q9 — the owner's textbooks were not provided — so no correlation of this file has a verified
// published traverse: hb, gray, nsl, single, gasTZ (A1) and dr, gasCS (A2) ship with verified:false and the label
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
//     .gasDry(F, W, q /*Mscf/d*/, o /*{from, p0 psia, tProfile, method:'tz' (default) | 'cs' (A2)}*/) → {ok, pwf, pEnd, pTop, zAvg, tAvg,
//         segments[], warnings}; method 'cs' returns gasCS()
//     .gasCS(F, W, q, o /*{from, p0 psia, tProfile}*/) (A2) → {ok, corr:'gasCS', method, pwf, pEnd, pTop, pBottom, q_MMscfd, sg,
//         segments:[{name, mdTop, mdBot, tvdTop, tvdBot, inc, len, id, pTop, pMid, pBot, tTop, tMid, tBot, iTop, iMid, iBot, f, F2}],
//         stations:[{md, tvd, p}] (top, middle and bottom of each segment), iters, warnings} | {ok:false, code: LOST | PVT | NO_* …}
//     .drMap(F, q, traverse) (A2) → {ok, corr, points:[{md, tvd, inc, p, NLv, Ngv, Nd, region, pattern}], counts{I, II, transition,
//         III, single}, NdRef, NdMin, NdMax, boundaries} — any correlation's traverse placed on the Ros map
//     .drRegion(NLv, Ngv, Nd) → {region:'I'|'II'|'transition'|'III', LB, LS, LM, L1, L2}; .drBoundaries(Nd, n?) → {Nd, L1, L2,
//         lines:{bs, st, tm}: [[NLv, Ngv]]}; ._drCharts {F(name, NL), L(Nd), f2(x), table} (the Duns & Ros chart readings)
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
    var KEYS = ['hb', 'gray', 'nsl', 'single', 'gasTZ', 'dr', 'gasCS'];        // dr, gasCS: WP12 (A2)

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

    // ── Duns & Ros (1963) — WP12, increment A2 ───────────────────────────────────────────────────────────────────────────
    // Ros flow-pattern map in the dimensionless velocities (N_Lv, N_gv) with the pipe-diameter number N_d; slip velocity per region;
    // the mist region with the liquid-film roughness rule. Units next to each equation; the group definitions are the ones of the
    // Hagedorn & Brown block above (ρ lbm/ft³, σ dyn/cm, μ cp, v ft/s, d ft):
    //   N_Lv = 1.938·v_sl·(ρ_L/σ)^¼, N_gv = 1.938·v_sg·(ρ_L/σ)^¼, N_d = 120.872·d_ft·(ρ_L/σ)^½, N_L = 0.15726·μ_L·(1/(ρ_L·σ³))^¼
    // Region boundaries (Ros map):  I / II   N_gv = L1 + L2·N_Lv          (L1, L2 = chart functions of N_d)
    //                               II / tr  N_gv = L_S = 50 + 36·N_Lv
    //                               tr / III N_gv = L_M = 75 + 84·N_Lv^0.75
    // Region I  (bubble, plug, part of froth)  S = F1 + F2·N_Lv + F3'·(N_gv/(1 + N_Lv))²,     F3' = F3 − F4/N_d
    // Region II (slug, rest of froth)          S = (1 + F5)·(N_gv^0.982 + F6')/(1 + F7·N_Lv)², F6' = 0.029·N_d + F6
    //   v_s = S/(1.938·(ρ_L/σ)^¼) (ft/s); holdup from v_s = v_sg/(1 − H_L) − v_sl/H_L:
    //   H_L = [v_s − v_m + √((v_m − v_s)² + 4·v_s·v_sl)]/(2·v_s), clamped to [λ_L, 1]
    //   friction (I, II): dp/dL_f = f_m·ρ_L·v_sl·v_m/(2·g_c·d_ft)/144 (psi/ft), f_m = f1·f2/f3, f1 = Moody(N_Re = 1488·ρ_L·v_sl·d_ft/μ_L),
    //   f2 = chart of f1·R·N_d^(2/3) with R = v_sg/v_sl, f3 = 1 + f1·√(R/50); no acceleration term in regions I and II.
    // Region III (mist)  no slip (H_L = λ_L, ρ_s = ρ_n); friction on the gas: dp/dL_f = f·ρ_g·v_sg²/(2·g_c·d_ft)/144 with the film
    //   roughness ε (ft) from the Weber rule: X = N_We·N_μ = ρ_g·v_sg²·μ_L²/(ρ_L·σ²) (consistent units: μ_L lbm/(ft·s) = cp × 6.7197e-4,
    //   σ lbm/s² = dyn/cm × 0.00220462; ε cancels), ε = 0.0749·σ/(ρ_g·v_sg²) when X ≤ 0.005 else ε = 0.3713·σ·X^0.302/(ρ_g·v_sg²)
    //   (σ dyn/cm, ρ lbm/ft³, v ft/s → ε ft); ε/d between the wall roughness and 0.5; f = Moody below ε/d = 0.05, else
    //   f = 4·[1/(4·log10(0.27·ε/d))² + 0.067·(ε/d)^1.73]; d → d − ε and v_sg → v_sg·d²/(d − ε)² (two passes); the acceleration factor
    //   Ek = ρ_n·v_m·v_sg/(g_c·p·144) when acceleration is on.
    // Transition: A = (L_M − N_gv)/(L_M − L_S); gradients = A·(region II) + (1 − A)·(region III with ρ_g' = ρ_g·N_gv/L_M).
    // CHART FITS. The ten chart functions (F1–F7 against N_L; L1, L2 against N_d; f2 against f1·R·N_d^(2/3)) are tabulated readings of
    // the published Duns & Ros figures (as reproduced by Brill & Mukherjee, "Multiphase Flow in Wells", §4.2.2), interpolated linearly
    // in log10 of the abscissa and held constant beyond the ends. Q9: the owner's books were not available to this work package, so the
    // readings could not be checked against the printed figures — the table is pinned to its own values by tests (three readings per
    // curve) and the correlation ships provisional (D17). Replacing a reading after verification is a table edit plus its pin.
    var DR_NLX = [0.001, 0.01, 0.1, 0.2, 0.5, 1, 10];
    var DR_CH = {
        F1: [1.00, 1.35, 1.95, 2.00, 1.60, 1.25, 0.90],
        F2: [0.24, 0.50, 1.00, 1.05, 0.80, 0.60, 0.30],
        F3: [0.80, 1.40, 2.40, 2.80, 3.20, 3.40, 3.80],
        F4: [25, 32, 45, 52, 55, 56, 58],
        F5: [0.22, 0.14, 0.08, 0.075, 0.085, 0.10, 0.12],
        F6: [0.80, 1.30, 2.10, 2.15, 1.60, 0.90, -0.60],
        F7: [0.14, 0.10, 0.06, 0.05, 0.04, 0.035, 0.025]
    };
    var DR_NDX = [10, 20, 30, 40, 50, 70, 100, 300];
    var DR_L1 = [2.00, 2.00, 1.65, 1.35, 1.20, 1.00, 1.00, 1.00];
    var DR_L2 = [0.50, 0.50, 0.70, 0.88, 1.00, 1.10, 1.10, 1.10];
    var DR_F2X = [0.001, 0.01, 0.05, 0.1, 0.5, 1, 10, 100];
    var DR_F2Y = [1.00, 0.94, 0.75, 0.60, 0.32, 0.22, 0.08, 0.05];
    var MU_LBM = 6.7197e-4;                    // cp → lbm/(ft·s)
    // linear in log10(x), constant beyond the table ends
    function _tab(xs, ys, x) {
        if (!(x > 0)) return ys[0];
        if (x <= xs[0]) return ys[0];
        var n = xs.length;
        if (x >= xs[n - 1]) return ys[n - 1];
        var lx = _log10(x);
        for (var i = 1; i < n; i++) if (x <= xs[i]) {
            var a = _log10(xs[i - 1]), bb = _log10(xs[i]);
            return ys[i - 1] + (ys[i] - ys[i - 1]) * (lx - a) / (bb - a);
        }
        return ys[n - 1];
    }
    function _drF(name, NL) { return _tab(DR_NLX, DR_CH[name], NL); }
    function _drL(Nd) { return { L1: _tab(DR_NDX, DR_L1, Nd), L2: _tab(DR_NDX, DR_L2, Nd) }; }
    function _drF2(x) { return _tab(DR_F2X, DR_F2Y, x); }
    // the region of a point of the Ros map: 'I' | 'II' | 'transition' | 'III', with the boundary values at that N_Lv
    function drRegion(NLv, Ngv, Nd) {
        var L = _drL(Nd), LB = L.L1 + L.L2 * NLv, LS = 50 + 36 * NLv, LM = 75 + 84 * Math.pow(Math.max(0, NLv), 0.75);
        var reg = Ngv <= LB ? 'I' : (Ngv <= LS ? 'II' : (Ngv < LM ? 'transition' : 'III'));
        return { region: reg, LB: LB, LS: LS, LM: LM, L1: L.L1, L2: L.L2 };
    }
    var DR_PATTERN = { I: 'bubble', II: 'slug', transition: 'transition', III: 'mist' };
    // dimensionless groups of a point
    function _drGroups(b) {
        var q4 = Math.pow(b.rL / b.sig, 0.25);
        return { NLv: 1.938 * b.vsl * q4, Ngv: 1.938 * b.vsg * q4, Nd: 120.872 * b.dFt * Math.sqrt(b.rL / b.sig),
            NL: 0.15726 * b.muL * Math.pow(1 / (b.rL * b.sig * b.sig * b.sig), 0.25), q4: q4 };
    }
    // slip holdup of regions I / II
    function _drHoldup(S, q4, b, lam) {
        var vs = S / (1.938 * q4);
        if (!(vs > 1e-12)) return { hl: lam, vs: vs };
        var hl = (vs - b.vm + Math.sqrt(Math.pow(b.vm - vs, 2) + 4 * vs * b.vsl)) / (2 * vs);
        if (!(hl >= lam)) hl = lam;
        if (hl > 1) hl = 1;
        return { hl: hl, vs: vs };
    }
    // regions I / II: elevation on the slip holdup, friction f_m on the liquid
    function _drBubbleSlug(b, gp, reg) {
        var lam = b.vsl / b.vm, S, F1, F2, F3, F4, F5, F6, F7;
        if (reg === 'I') {
            F1 = _drF('F1', gp.NL); F2 = _drF('F2', gp.NL); F3 = _drF('F3', gp.NL); F4 = _drF('F4', gp.NL);
            var F3p = F3 - F4 / gp.Nd;
            S = F1 + F2 * gp.NLv + F3p * Math.pow(gp.Ngv / (1 + gp.NLv), 2);
        } else {
            F5 = _drF('F5', gp.NL); F6 = _drF('F6', gp.NL); F7 = _drF('F7', gp.NL);
            var F6p = 0.029 * gp.Nd + F6;
            S = (1 + F5) * (Math.pow(gp.Ngv, 0.982) + F6p) / Math.pow(1 + F7 * gp.NLv, 2);
        }
        var h = _drHoldup(S, gp.q4, b, lam);
        var nreL = 1488 * b.rL * b.vsl * b.dFt / Math.max(b.muL, 1e-9), f1 = _fMoody(nreL, b.rough / 12 / b.dFt);
        var R = b.vsl > 0 ? b.vsg / b.vsl : 0, f2 = _drF2(f1 * R * Math.pow(gp.Nd, 2 / 3)), f3 = 1 + f1 * Math.sqrt(R / 50);
        var fm = f1 * f2 / f3;
        return { S: S, vs: h.vs, hl: h.hl, rhoS: b.rL * h.hl + b.rG * (1 - h.hl), f1: f1, f2: f2, f3: f3, fm: fm, NReL: nreL,
            gF: fm * b.rL * b.vsl * b.vm / (2 * GC * b.dFt) / 144 };
    }
    // region III (mist): no slip, gas friction on the film roughness
    function _drMist(b, rhoG) {
        var lam = b.vsl / b.vm, rhoN = b.rL * lam + rhoG * (1 - lam);
        var sigLbm = b.sig * SIG_LBM, muLbm = b.muL * MU_LBM, v = b.vsg, d = b.dFt, eps = 0, rel = 0, f = 0;
        for (var pass = 0; pass < 3; pass++) {
            var rv2 = rhoG * v * v;
            if (!(rv2 > 0)) break;
            var X = rv2 * muLbm * muLbm / (b.rL * sigLbm * sigLbm);
            eps = X <= 0.005 ? 0.0749 * b.sig / rv2 : 0.3713 * b.sig * Math.pow(X, 0.302) / rv2;           // ft
            rel = eps / b.dFt;
            var relWall = b.rough / 12 / b.dFt;
            if (rel < relWall) rel = relWall;
            if (rel > 0.5) rel = 0.5;
            eps = rel * b.dFt;
            if (pass === 2) break;
            d = b.dFt - eps; if (!(d > 0.1 * b.dFt)) d = 0.1 * b.dFt;
            v = b.vsg * b.dFt * b.dFt / (d * d);
        }
        var relD = eps / d;
        if (relD < 0.05) { var nreG = 1488 * rhoG * v * d / Math.max(b.muG, 1e-9); f = _fMoody(nreG, relD); }
        else { var lg = _log10(0.27 * relD); f = 4 * (1 / (16 * lg * lg) + 0.067 * Math.pow(relD, 1.73)); }
        var gF = f * rhoG * v * v / (2 * GC * d) / 144;
        var Ek = (b.accel && b.p > 0) ? rhoN * b.vm * b.vsg / (GC * b.p * 144) : 0;
        return { hl: lam, rhoS: rhoN, rhoN: rhoN, gF: gF, f: f, eps: eps, relRough: relD, Ek: Ek };
    }
    function dr(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var lam = b.vsl / b.vm, lamG = 1 - lam;
        var rhoN = b.rL * lam + b.rG * lamG, muN = b.muL * lam + b.muG * lamG;
        var r = { lambdaL: lam, rhoN: rhoN, muN: muN, corr: 'dr' };
        if (lam < 1e-7 || lam > 1 - 1e-9 || !(b.sig > 0) || !(b.rL > 0)) {        // single phase: Darcy-Weisbach on the no-slip mixture
            r.pattern = lam < 1e-7 ? 'gas' : 'liquid'; r.hl = lam < 1e-7 ? 0 : (lam > 1 - 1e-9 ? 1 : lam);
            var nre0 = 1488 * rhoN * b.vm * b.dFt / Math.max(muN, 1e-9), f0 = _fMoody(nre0, b.rough / 12 / b.dFt);
            r.fn = f0; r.NRe = nre0;
            return _finish(b, r, rhoN, f0 * rhoN * b.vm * b.vm / (2 * GC * b.dFt) / 144);
        }
        var gp = _drGroups(b), rg = drRegion(gp.NLv, gp.Ngv, gp.Nd);
        r.NLv = gp.NLv; r.Ngv = gp.Ngv; r.Nd = gp.Nd; r.NL = gp.NL; r.region = rg.region; r.LB = rg.LB; r.LS = rg.LS; r.LM = rg.LM;
        r.pattern = DR_PATTERN[rg.region];
        var hl, rhoS, gF, Ek = 0;
        if (rg.region === 'I' || rg.region === 'II') {
            var bs = _drBubbleSlug(b, gp, rg.region);
            hl = bs.hl; rhoS = bs.rhoS; gF = bs.gF; r.S = bs.S; r.vs = bs.vs; r.fn = bs.fm; r.f1 = bs.f1; r.f2 = bs.f2; r.f3 = bs.f3; r.NRe = bs.NReL;
        } else if (rg.region === 'III') {
            var m = _drMist(b, b.rG);
            hl = m.hl; rhoS = m.rhoS; gF = m.gF; Ek = m.Ek; r.fn = m.f; r.eps = m.eps; r.relRough = m.relRough;
        } else {
            var A = (rg.LM - gp.Ngv) / (rg.LM - rg.LS);
            var b2 = _drBubbleSlug(b, gp, 'II'), m2 = _drMist(b, b.rG * gp.Ngv / rg.LM);
            rhoS = A * b2.rhoS + (1 - A) * m2.rhoS; gF = A * b2.gF + (1 - A) * m2.gF; Ek = (1 - A) * m2.Ek;
            hl = (b.rL > b.rG) ? (rhoS - b.rG) / (b.rL - b.rG) : lam;
            if (!(hl >= lam)) hl = lam;
            if (hl > 1) hl = 1;
            r.A = A; r.S = b2.S; r.fn = A * b2.fm + (1 - A) * m2.f; r.eps = m2.eps;
        }
        r.hl = hl;
        // assemble (elevation on ρ_s and the true inclination, the region's own acceleration factor)
        var gEl = rhoS * Math.sin(b.th) / 144, tot = Ek < 1 ? (gEl + gF) / (1 - Ek) : Infinity;
        r.vsl = b.vsl; r.vsg = b.vsg; r.vm = b.vm; r.theta = b.theta; r.rhoS = rhoS;
        r.gradEl = gEl; r.gradF = gF; r.Ek = Ek; r.grad = tot; r.gradAcc = tot - gEl - gF;
        return r;
    }

    // ── Cullender & Smith (1956) — WP12, increment A2: point form ─────────────────────────────────────────────────────────
    // The integrand of the Cullender-Smith method,  ∫ (p/TZ) / [F² + (p/TZ)²·(TVD/MD)/1000] dp = 18.75·γ·MD,  F² = 0.667·f·q²/d⁵
    // (p psia, T °R, q MMscf/d, d in, f Moody, MD / TVD ft), differentiated along the path:
    //   dp/dL = 18.75·γ·[F² + 0.001·(p/TZ)²·sin θ] / (p/TZ) = 0.01875·γ·(p/TZ)·sin θ + 18.75·γ·F²·(TZ/p)      (psi/ft)
    // with T and Z from the fluid-property path of the marcher (inp.props: z, t), γ from the gas density (ρ_g = 2.7·γ·p/(Z·T) form:
    // γ = ρ_g·10.7316·T·Z/(28.9647·p)), and q the gas rate at standard conditions that gives the in-situ velocity v_sg in a circle of
    // diameter d (q_MMscfd = v_sg·(π·d_ft²/4)·(p/(Z·T))·(519.67/14.696)·86400/1e6 — on the hydraulic diameter for an annulus);
    // f = Moody at N_Re = 20.09·γ·q_Mscfd/(d·μ_g). Gas phase only (the liquids are ignored and the traverse says so); no kinetic-energy
    // term (the method has none). The closed form (two half-lengths, then Simpson) is WTS_wp_vlp.gasCS / gasDry(…, {method:'cs'}).
    function csPoint(inp) {
        var b = _base(inp), pr = (inp && inp.props) || null;
        var r = { corr: 'gasCS', lambdaL: 0, hl: 0, rhoN: b.rG, muN: b.muG, pattern: 'gas', liquidIgnored: b.vsl > 0 };
        b.vsl = 0; b.vm = b.vsg;
        if (!pr || !_fin(+pr.z) || !_fin(+pr.t) || !(b.p > 0)) { r.noProps = true; return gasPoint(inp); }
        var TR = +pr.t + RANK, Z = +pr.z, pz = b.p / (TR * Z);
        var gam = b.rG > 0 ? b.rG * 10.7316 / (28.9647 * pz) : 0.65;
        var dIn = b.dIn, qMM = b.vsg * Math.PI * b.dFt * b.dFt / 4 * pz * (519.67 / 14.696) * 86400 / 1e6;
        var nre = qMM > 0 ? 20.09 * gam * qMM * 1000 / (dIn * Math.max(b.muG, 1e-9)) : 0, f = qMM > 0 ? _fMoody(nre, b.rough / dIn) : 0;
        var F2 = 0.667 * f * qMM * qMM / Math.pow(dIn, 5);
        var gEl = 0.01875 * gam * pz * Math.sin(b.th), gF = 18.75 * gam * F2 / pz;
        r.fn = f; r.NRe = nre; r.F2 = F2; r.gamma = gam; r.q_MMscfd = qMM; r.pTZ = pz;
        r.vsl = b.vsl; r.vsg = b.vsg; r.vm = b.vm; r.theta = b.theta; r.rhoS = 0.01875 * gam * pz * 144;
        r.gradEl = gEl; r.gradF = gF; r.Ek = 0; r.grad = gEl + gF; r.gradAcc = 0;
        return r;
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
            grad: gasPoint },
        // WP12 (A2): Duns & Ros for oil and gas wells (vertical); Cullender-Smith for dry / wet gas (gas phase only, any inclination)
        dr: { key: 'dr', label: 'Duns & Ros (1963), flow-pattern regions I–III', kind: 'well', vertical: true,
            range: { incl: [0, VERT_WARN_DEG], note: 'vertical wells; wide gas-liquid ratio range; mist region extrapolated for high liquid rates' },
            grad: dr },
        gasCS: { key: 'gasCS', label: 'Cullender-Smith (1956), dry gas', kind: 'gas', vertical: false, range: { incl: [-90, 90], note: 'gas only' },
            grad: csPoint }
    };
    KEYS.forEach(function (k) {
        var e = ENTRIES[k];
        e.verified = false;                 // D17 gate: Q9 — no verified published example yet
        e.provisional = PROVISIONAL;
        e.source = k === 'hb' ? 'Hagedorn & Brown (1965); Griffith (1961); chart fits as printed by Economides et al. and Guo et al.' :
            k === 'gray' ? 'Gray (1974), as given in API RP 14B and Brill & Mukherjee (1999)' :
            k === 'gasTZ' ? 'average temperature and Z method (Katz et al.; Economides et al.)' :
            k === 'single' ? 'Darcy-Weisbach with the Colebrook (1939) friction factor' :
            k === 'dr' ? 'Duns & Ros (1963); chart readings as reproduced by Brill & Mukherjee (1999) §4.2.2 — not checked against the figures (Q9)' :
            k === 'gasCS' ? 'Cullender & Smith (1956), as given by Economides et al. and Brill & Mukherjee (1999)' : 'homogeneous mixture';
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
        if ((key === 'gasTZ' || key === 'gasCS' || (R.note === 'gas only')) && (ff.qo > 0 || ff.qw > 0)) warnings.push(_w('GAS_ONLY', 'Dry-gas method: the liquids are not included in the gradient.'));
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
        if (o.method === 'cs') return gasCS(F, W, q, o);           // WP12 (A2): Cullender-Smith; default (absent / 'tz') = the A1 method
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

    // ── gasCS: Cullender-Smith closed form, segment by segment (WP12, A2) ────────────────────────────────────────────────
    // Per segment (MD length L, TVD rise Δz, sin θ = Δz/L; temperatures at its top, middle and bottom from the profile):
    //   I(p, T) = (p/TZ) / [F² + 0.001·(p/TZ)²·sin θ],   F² = 0.667·f·q²/d⁵   (p psia, T °R, q MMscf/d, d in, f Moody)
    //   upper half:  p_mf − p_tf = 18.75·γ·L / (I_tf + I_mf)       lower half:  p_wf − p_mf = 18.75·γ·L / (I_mf + I_wf)
    //   Simpson:     p_wf − p_tf = 112.5·γ·L / (I_tf + 4·I_mf + I_wf)        (each solved by fixed-point iteration on Z)
    // (18.75·γ·L/2 per half-length with the trapezoid's ½ cancelling; 6 × 18.75 = 112.5.) f is the Moody factor at
    // N_Re = 20.09·γ·q_Mscfd/(d·μ_g) with μ_g at the segment's mean pressure and temperature (one f per segment, as the method
    // takes F constant). Z (and μ_g) through WTS_flowline_props on the gas phase — the same Z path as the marcher, impurities
    // included. Bottom-up (from 'bottom') solves the same three equations for the upper pressures. A tapered or deviated well
    // is the sum of its segments (the method's TVD/MD per segment).
    function gasCS(F, W, q, o) {
        o = o || {};
        var warnings = [];
        var fail = function (code, msg) { return { ok: false, code: code, corr: 'gasCS', errors: [msg], warnings: warnings, pwf: null, pEnd: null }; };
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
        if (ffq.qo > 0 || ffq.qw > 0) warnings.push(_w('GAS_ONLY', 'Cullender-Smith: the liquids are not included.'));
        if (segs.some(function (s) { return s.restr; })) warnings.push(_w('RESTR_IGNORED', 'Cullender-Smith: restriction losses are not included.', 'info'));
        var gasOnly = { qo: 0, qw: 0, qg: Math.max(qMM, 1e-9), api: ffq.api, sgg: sg, sgw: ffq.sgw, pvt: ffq.pvt };
        var rough = _roughOf(o, segs).v;
        var zmu = function (p, T) { var pr = G.WTS_flowline_props(gasOnly, Math.max(p, 1), T); return pr && _fin(pr.z) ? pr : null; };
        var order = from === 'top' ? segs.slice().reverse() : segs.slice();
        var p = p0, out = [], iters = 0;
        for (var i = 0; i < order.length; i++) {
            var s = order[i], L = s.len, d = s.id, sn = Math.max(-1, Math.min(1, s.dz / L));
            var mdMid = (s.mdTop + s.mdBot) / 2, Tt = tF(s.mdTop), Tm = tF(mdMid), Tb = tF(s.mdBot);
            var K = 18.75 * sg * L;
            // f from μ_g at the segment's mean conditions (iterated once on the solved pressures)
            var f = 0, F2 = 0, pOther = p;
            var Ifn = function (pp, T) {
                var pr = zmu(pp, T); if (!pr) return NaN;
                var pz = pp / ((T + RANK) * pr.z), den = F2 + 0.001 * pz * pz * sn;
                return den > 1e-30 ? pz / den : Infinity;
            };
            var halfStep = function (pa, Ia, T, sgn) {     // pb with (pb − pa)·sgn·(Ia + I(pb)) = K
                var pb = pa;
                for (var k = 0; k < 60; k++) {
                    var Ib = Ifn(pb, T); iters++;
                    if (!_fin(Ib) && Ib !== Infinity) return NaN;
                    var dp = (Ia === Infinity || Ib === Infinity) ? 0 : K / (Ia + Ib), pn = pa + sgn * dp;
                    if (!(pn > 0)) return NaN;
                    var done = Math.abs(pn - pb) < 1e-9 * pn; pb = pn;
                    if (done) break;
                }
                return pb;
            };
            var pt, pm, pb2, It, Im, Ib2;
            for (var outer = 0; outer < 2; outer++) {
                var pMean = outer === 0 ? p : 0.5 * (p + pOther), tMean = Tm;
                var pr0 = zmu(pMean, tMean);
                if (!pr0) return fail('PVT', 'Z could not be evaluated');
                var nre = qM > 0 ? 20.09 * sg * qM / (d * pr0.mug) : 0;
                f = qM > 0 ? _fMoody(nre, rough / d) : 0;
                F2 = 0.667 * f * qMM * qMM / Math.pow(d, 5);
                if (from === 'top') {
                    pt = p; It = Ifn(pt, Tt);
                    pm = halfStep(pt, It, Tm, 1); if (!_fin(pm)) return fail('PVT', 'Cullender-Smith did not converge');
                    Im = Ifn(pm, Tm);
                    pb2 = halfStep(pm, Im, Tb, 1); if (!_fin(pb2)) return fail('PVT', 'Cullender-Smith did not converge');
                    // Simpson over the whole segment
                    for (var k2 = 0; k2 < 60; k2++) {
                        Ib2 = Ifn(pb2, Tb); iters++;
                        var sum = (It === Infinity || Im === Infinity || Ib2 === Infinity) ? Infinity : It + 4 * Im + Ib2;
                        var pn2 = pt + (sum === Infinity ? 0 : 6 * K / sum);
                        var dn2 = Math.abs(pn2 - pb2) < 1e-9 * pn2; pb2 = pn2;
                        if (dn2) break;
                    }
                    pOther = pb2;
                } else {
                    pb2 = p; Ib2 = Ifn(pb2, Tb);
                    pm = halfStep(pb2, Ib2, Tm, -1);
                    if (!_fin(pm) || pm < PATM) return Object.assign(fail('LOST', 'the gas cannot reach the wellhead at this rate'), { lost: { md: s.mdBot, reason: 'pressure' } });
                    Im = Ifn(pm, Tm);
                    pt = halfStep(pm, Im, Tt, -1);
                    if (!_fin(pt) || pt < PATM) return Object.assign(fail('LOST', 'the gas cannot reach the wellhead at this rate'), { lost: { md: mdMid, reason: 'pressure' } });
                    for (var k3 = 0; k3 < 60; k3++) {
                        It = Ifn(pt, Tt); iters++;
                        var sum3 = (It === Infinity || Im === Infinity || Ib2 === Infinity) ? Infinity : It + 4 * Im + Ib2;
                        var pn3 = pb2 - (sum3 === Infinity ? 0 : 6 * K / sum3);
                        if (!(pn3 > PATM)) return Object.assign(fail('LOST', 'the gas cannot reach the wellhead at this rate'), { lost: { md: s.mdTop, reason: 'pressure' } });
                        var dn3 = Math.abs(pn3 - pt) < 1e-9 * pn3; pt = pn3;
                        if (dn3) break;
                    }
                    pOther = pt;
                }
            }
            out.push({ name: s.name, mdTop: s.mdTop, mdBot: s.mdBot, tvdTop: s.tvdTop, tvdBot: s.tvdBot, inc: s.inc, len: L, id: d,
                pTop: pt, pMid: pm, pBot: pb2, tTop: Tt, tMid: Tm, tBot: Tb, iTop: It, iMid: Im, iBot: Ib2, f: f, F2: F2 });
            p = pOther;
        }
        var segsOut = from === 'top' ? out : out.slice().reverse();          // top → bottom
        var res = { ok: true, corr: 'gasCS', method: 'Cullender-Smith (two half-lengths, then Simpson)', from: from, pEnd: p,
            pwf: from === 'top' ? p : p0, pwh: from === 'top' ? p0 : p, pTop: from === 'top' ? p0 : p, pBottom: from === 'top' ? p : p0,
            q_MMscfd: qMM, sg: sg, segments: segsOut, iters: iters, warnings: warnings, errors: [],
            stations: segsOut.reduce(function (a, sg2, j) { if (!j) a.push({ md: sg2.mdTop, tvd: sg2.tvdTop, p: sg2.pTop }); a.push({ md: (sg2.mdTop + sg2.mdBot) / 2, tvd: (sg2.tvdTop + sg2.tvdBot) / 2, p: sg2.pMid }); a.push({ md: sg2.mdBot, tvd: sg2.tvdBot, p: sg2.pBot }); return a; }, []) };
        warnings.push(_w('PROVISIONAL', ENTRIES.gasCS.label + ': ' + PROVISIONAL + '.', 'info'));
        return res;
    }

    // ── drMap: the Ros flow-pattern map of a traverse (WP12; the page's flow-regime map) ───────────────────────────────────
    // Every traverse station (any correlation) placed on the Duns & Ros map: N_Lv, N_gv and N_d from the station's superficial
    // velocities, the local flow diameter and the liquid density / surface tension of the fluid-property path at (p, T); the region
    // by drRegion. boundaries(Nd) gives the three boundary lines for drawing (N_Lv from 0.1 to 1,000 on a log grid).
    function drBoundaries(Nd, n) {
        var L = _drL(Nd), pts = { bs: [], st: [], tm: [] }, k = n || 41;
        for (var i = 0; i < k; i++) {
            var x = Math.pow(10, -1 + 4 * i / (k - 1));
            pts.bs.push([x, L.L1 + L.L2 * x]); pts.st.push([x, 50 + 36 * x]); pts.tm.push([x, 75 + 84 * Math.pow(x, 0.75)]);
        }
        return { Nd: Nd, L1: L.L1, L2: L.L2, lines: pts };
    }
    function drMap(F, q, tr) {
        if (!tr || !Array.isArray(tr.profile) || !tr.profile.length) return { ok: false, code: 'NO_TRAVERSE', errors: ['no traverse'], points: [] };
        if (typeof G.WTS_flowline_props !== 'function') return { ok: false, code: 'MISSING_ENGINE', errors: ['WTS_flowline_props is not loaded'], points: [] };
        var ff = _ff(F, q), segs = Array.isArray(tr.segments) ? tr.segments : [];
        var idAt = function (md) { for (var i = 0; i < segs.length; i++) { var s = segs[i]; if (md >= s.mdTop - 1e-6 && md <= s.mdBot + 1e-6) return s.id; } return segs.length ? segs[segs.length - 1].id : null; };
        var pts = [], counts = { I: 0, II: 0, transition: 0, III: 0, single: 0 }, nds = [];
        tr.profile.forEach(function (r) {
            if (r.restr || !_fin(r.p) || !_fin(r.t)) return;
            var d = idAt(r.md); if (!(d > 0)) return;
            var pr = G.WTS_flowline_props(ff, r.p, r.t); if (!pr) return;
            var rL = pr.rhoL, sig = pr.sigL, vsl = _num(r.vsl), vsg = _num(r.vsg);
            if (!(rL > 0) || !(sig > 0)) return;
            var q4 = Math.pow(rL / sig, 0.25), NLv = 1.938 * vsl * q4, Ngv = 1.938 * vsg * q4, Nd = 120.872 * (d / 12) * Math.sqrt(rL / sig);
            var single = !(vsl > 0) || !(vsg > 0), rg = single ? null : drRegion(NLv, Ngv, Nd);
            var reg = single ? 'single' : rg.region;
            counts[reg]++; nds.push(Nd);
            pts.push({ md: r.md, tvd: r.tvd, inc: r.inc, p: r.p, NLv: NLv, Ngv: Ngv, Nd: Nd, region: reg, pattern: r.pattern || null });
        });
        nds.sort(function (a, b) { return a - b; });
        var NdRef = nds.length ? nds[Math.floor(nds.length / 2)] : null;
        return { ok: pts.length > 0, corr: tr.corr || null, points: pts, counts: counts, NdRef: NdRef, NdMin: nds.length ? nds[0] : null, NdMax: nds.length ? nds[nds.length - 1] : null,
            boundaries: NdRef ? drBoundaries(NdRef) : null };
    }

    function singlePhase(F, W, q, o) {
        var r = traverse(F, W, q, Object.assign({}, o || {}, { corr: 'single' }));
        return { ok: r.ok, code: r.code, pEnd: r.pEnd, profile: r.profile, warnings: r.warnings || [], errors: r.errors || [], lost: r.lost || null };
    }

    var NS = G.WTS_wp_vlp = G.WTS_wp_vlp || {};
    NS.traverse = traverse; NS.curve = curve; NS.family = family; NS.gasDry = gasDry; NS.singlePhase = singlePhase;
    NS.defaultCorr = defaultCorr; NS.list = list; NS.hbBubbleLimit = hbBubbleLimit;
    // WP12 (A2): Cullender-Smith closed form, the Ros flow-pattern map and the Duns & Ros chart readings
    NS.gasCS = gasCS; NS.drMap = drMap; NS.drRegion = drRegion; NS.drBoundaries = drBoundaries;
    NS._drCharts = { F: _drF, L: _drL, f2: _drF2, table: { NL: DR_NLX.slice(), F: JSON.parse(JSON.stringify(DR_CH)), Nd: DR_NDX.slice(), L1: DR_L1.slice(), L2: DR_L2.slice(), f2x: DR_F2X.slice(), f2y: DR_F2Y.slice() } };
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
    ['hb', 'gray', 'nsl', 'single', 'gasTZ', 'dr', 'gasCS'].forEach(function (k) { if (!C || !C[k] || typeof C[k].grad !== 'function') bad.push(k + ' not registered'); });
    if (V && V.drRegion) { var rg = V.drRegion(1, 100, 30); if (rg.region !== 'transition' || Math.abs(rg.LS - 86) > 1e-9) bad.push('Duns & Ros regions'); }
    if (C && C.dr) { var gd = C.dr.grad({ vsl: 1e-6, vsg: 0, d: 2.441, rhoL: 62.4, rhoG: 0.1, muL: 1, muG: 0.01, sigma: 70, theta: 90, rough: 0.0006, p: 1000 }); if (Math.abs(gd.gradEl - 62.4 / 144) > 1e-12) bad.push('DR hydrostatic'); }
    if (V && V.hbBubbleLimit && Math.abs(V.hbBubbleLimit(1, 0.5) - (1.071 - 0.2218 / 0.5)) > 1e-12) bad.push('HB bubble limit');
    // water column at a creeping rate: gradEl = ρ_L/144, no friction to speak of
    if (C && C.hb) {
        var g = C.hb.grad({ vsl: 1e-6, vsg: 0, d: 2.441, rhoL: 62.4, rhoG: 0.1, muL: 1, muG: 0.01, sigma: 70, theta: 90, rough: 0.0006, p: 1000 });
        if (Math.abs(g.gradEl - 62.4 / 144) > 1e-12 || g.gradF > 1e-9) bad.push('HB hydrostatic');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-vlp.js self-test] ' + bad.join('; '));
})();
