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
//   ork, agf, mb, ansari, hk  (WP21, increment B): Orkiszewski (1967), Aziz-Govier-Fogarasi (1972), Mukherjee-Brill (1985, inclined;
//           kind 'any', also a flowline choice), Ansari et al. (1994, mechanistic) and Hasan-Kabir (1988, drift flux, inclined) —
//           equations and units at the code (section "Increment B"); explicit equations, no chart readings.
//   PER-SECTION CORRELATIONS (WP21): traverse o.sections = [{by:'md'|'inc', from, to, corr}] — the segments are split at MD ends and
//           each segment takes the first matching row's key (segment.corr of the marcher); result .sections (runs) and .corrs; warnings
//           per correlation in use. patternMap() places a traverse on the AGF / Mukherjee-Brill / mechanistic map.
//
// VERIFICATION GATE (D17, §15.1). Q9 — the owner's textbooks were not provided — so no correlation of this file has a verified
// published traverse: hb, gray, nsl, single, gasTZ (A1), dr, gasCS (A2) and ork, agf, mb, ansari, hk (B) ship with verified:false and the label
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
//     .traverse o.sections (B, WP21) → also {sections:[{corr, label, verified, vertical, row, mdTop, mdBot, tvdTop, tvdBot, incMin, incMax}],
//         corrs[]}, profile rows and segments carry corr; absent / [] → the A2 result exactly
//     .normSections(list) → {rows, warnings}; .sectionsFor(W, list, base) → {ok, active, runs, warnings, rows}
//     .patternMap(F, q, traverse, {kind:'agf'|'mb'|'mech', corr}) → {ok, kind, corr, axes, points:[{md, tvd, inc, p, x, y, pattern}],
//         counts, lines:[{key, label, pts}], labels, ref}; .agfMap, .mbPattern, .mbHoldup, .mbFr, .orkGamma, .ansariPattern(inp),
//         .hkPattern(inp), .MB_C (the closed-form pieces, pinned by wellperf-mech)
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
    var KEYS = ['hb', 'gray', 'nsl', 'single', 'gasTZ', 'dr', 'gasCS', 'ork', 'agf', 'mb', 'ansari', 'hk'];   // dr, gasCS: WP12 (A2); ork … hk: WP21 (B)

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

    // ══ Increment B (v4.5, WP21): Orkiszewski, Aziz-Govier-Fogarasi, Mukherjee-Brill, Ansari et al., Hasan-Kabir ══════════════════
    // Equations as given in Brill & Mukherjee, "Multiphase Flow in Wells" (1999) ch. 4, and Hasan & Kabir, "Fluid Flow and Heat Transfer
    // in Wellbores" (2002) ch. 4 — Q9: the books were not available to this work package, so every method below ships verified:false
    // with the D17 label; the explicit equations are pinned by hand calculations in wellperf-vlp3 (no chart readings are used).
    // Units: v ft/s, ρ lbm/ft³, μ cp (× 6.7197e-4 → lbm/(ft·s) where a consistent group needs it), σ dyn/cm (× 0.00220462 → lbm/s²),
    // d ft, g = 32.174 ft/s², gradients psi/ft (lbf/ft² per ft ÷ 144); θ = inclination from HORIZONTAL (+ = flow up), as the marcher passes.
    // Every function returns the bb result shape (hl, lambdaL, pattern, rhoS, rhoN, grad, gradEl, gradF, gradAcc, Ek, vm, vsl, vsg, fn)
    // plus its own diagnostic numbers.

    // single phase (or no surface tension): Darcy-Weisbach on the no-slip mixture (as hb / dr)
    function _onePhase(b, r) {
        var lam = r.lambdaL, rhoN = r.rhoN, muN = r.muN;
        r.pattern = lam < 1e-7 ? 'gas' : 'liquid'; r.hl = lam < 1e-7 ? 0 : (lam > 1 - 1e-9 ? 1 : lam);
        var nre0 = 1488 * rhoN * b.vm * b.dFt / Math.max(muN, 1e-9), f0 = _fMoody(nre0, b.rough / 12 / b.dFt);
        r.fn = f0; r.NRe = nre0;
        return _finish(b, r, rhoN, f0 * rhoN * b.vm * b.vm / (2 * GC * b.dFt) / 144);
    }
    function _head(b, key) {
        var lam = b.vsl / b.vm, lamG = 1 - lam;
        var r = { lambdaL: lam, rhoN: b.rL * lam + b.rG * lamG, muN: b.muL * lam + b.muG * lamG, corr: key };
        r.single = lam < 1e-7 || lam > 1 - 1e-9 || !(b.sig > 0) || !(b.rL > b.rG);
        return r;
    }
    // assemble with the region's own elevation density, friction and acceleration factor
    function _assemble(b, r, rhoS, gF, Ek) {
        var gEl = rhoS * Math.sin(b.th) / 144, tot = Ek < 1 ? (gEl + gF) / (1 - Ek) : Infinity;
        r.vsl = b.vsl; r.vsg = b.vsg; r.vm = b.vm; r.theta = b.theta; r.rhoS = rhoS;
        r.gradEl = gEl; r.gradF = gF; r.Ek = Ek; r.grad = tot; r.gradAcc = tot - gEl - gF;
        return r;
    }
    function _ekOf(b, rho) { return (b.accel && b.p > 0) ? rho * b.vm * b.vsg / (GC * b.p * 144) : 0; }
    function _clampHl(hl, lam, up) { if (!(hl === hl)) hl = lam; if (up && hl < lam) hl = lam; if (hl < 0) hl = 0; if (hl > 1) hl = 1; return hl; }

    // ── Orkiszewski (1967) ─────────────────────────────────────────────────────────────────────────────────────────────
    // Patterns: Griffith bubble flow when λ_g < L_B (the Hagedorn & Brown limit above, v_s = 0.8 ft/s); slug while N_gv < L_S = 50 + 36·N_Lv
    // (the Duns & Ros groups); the Duns & Ros transition (L_S ≤ N_gv < L_M) and mist (N_gv ≥ L_M) above it — Orkiszewski's own choice.
    // Slug (Griffith & Wallis bubble rise with Orkiszewski's liquid distribution coefficient Γ):
    //   N_ReL = 1488·ρ_L·v_m·d/μ_L, N_Reb = 1488·ρ_L·v_b·d/μ_L (d ft, μ cp), iterated on v_b:
    //     N_Reb ≤ 3000: v_b = (0.546 + 8.74e-6·N_ReL)·√(g·d);  N_Reb ≥ 8000: v_b = (0.35 + 8.74e-6·N_ReL)·√(g·d);
    //     between: v_b = ½[v_bs + √(v_bs² + 13.59·μ_L/(ρ_L·√d))], v_bs = (0.251 + 8.74e-6·N_ReL)·√(g·d)        (v ft/s, d ft)
    //   Γ, water-continuous liquid (water fraction of the liquid > 0.75) / oil-continuous, log = log10, v_m ft/s, d ft, μ_L cp:
    //     water, v_m < 10: Γ = 0.013·log μ_L / d^1.38 − 0.681 + 0.232·log v_m − 0.428·log d
    //     water, v_m ≥ 10: Γ = 0.045·log μ_L / d^0.799 − 0.709 − 0.162·log v_m − 0.888·log d
    //     oil,   v_m < 10: Γ = 0.0127·log(μ_L + 1) / d^1.415 − 0.284 + 0.167·log v_m + 0.113·log d
    //     oil,   v_m ≥ 10: Γ = 0.0274·log(μ_L + 1) / d^1.371 + 0.161 + 0.569·log d + X,
    //                      X = −log v_m·[0.01·log(μ_L + 1) / d^1.571 + 0.397 + 0.63·log d]
    //     lower limits: v_m < 10: Γ ≥ −0.065·v_m;  v_m ≥ 10: Γ ≥ −v_b/(v_m + v_b)·(1 − ρ_s0/ρ_L)
    //   ρ_s = [ρ_L·(v_sl + v_b) + ρ_g·v_sg]/(v_m + v_b) + Γ·ρ_L  (= ρ_s0 + Γ·ρ_L), held within [ρ_n, ρ_L] (holdup ≥ no-slip)
    //   dp/dL_f = f·ρ_L·v_m²/(2·g_c·d)·[(v_sl + v_b)/(v_m + v_b) + Γ] / 144, f Moody at N_ReL; no acceleration term in slug flow.
    function _orkVb(b, nreL) {
        var sq = Math.sqrt(GRAV * b.dFt), vb = 0.5 * sq, it = 0;
        for (; it < 40; it++) {
            var nreb = 1488 * b.rL * vb * b.dFt / Math.max(b.muL, 1e-9), v2;
            if (nreb <= 3000) v2 = (0.546 + 8.74e-6 * nreL) * sq;
            else if (nreb >= 8000) v2 = (0.35 + 8.74e-6 * nreL) * sq;
            else { var vbs = (0.251 + 8.74e-6 * nreL) * sq; v2 = 0.5 * (vbs + Math.sqrt(vbs * vbs + 13.59 * b.muL / (b.rL * Math.sqrt(b.dFt)))); }
            if (Math.abs(v2 - vb) < 1e-9 * Math.max(1, vb)) { vb = v2; break; }
            vb = 0.5 * (vb + v2);
        }
        return { vb: vb, iters: it + 1, nreb: 1488 * b.rL * vb * b.dFt / Math.max(b.muL, 1e-9) };
    }
    function orkGamma(vm, dFt, muL, water) {
        var lv = _log10(Math.max(vm, 1e-9)), ld = _log10(dFt);
        if (water) return vm < 10 ? 0.013 * _log10(Math.max(muL, 1e-9)) / Math.pow(dFt, 1.38) - 0.681 + 0.232 * lv - 0.428 * ld
            : 0.045 * _log10(Math.max(muL, 1e-9)) / Math.pow(dFt, 0.799) - 0.709 - 0.162 * lv - 0.888 * ld;
        var lm = _log10(muL + 1);
        if (vm < 10) return 0.0127 * lm / Math.pow(dFt, 1.415) - 0.284 + 0.167 * lv + 0.113 * ld;
        return 0.0274 * lm / Math.pow(dFt, 1.371) + 0.161 + 0.569 * ld - lv * (0.01 * lm / Math.pow(dFt, 1.571) + 0.397 + 0.63 * ld);
    }
    function ork(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var r = _head(b, 'ork');
        if (r.single) return _onePhase(b, r);
        var lam = r.lambdaL, LB = hbBubbleLimit(b.vm, b.dFt);
        r.LB = LB;
        if (1 - lam < LB) {                                  // Griffith bubble flow (as Hagedorn & Brown)
            var a = 1 + b.vm / HB_VS, hl = 1 - 0.5 * (a - Math.sqrt(Math.max(0, a * a - 4 * b.vsg / HB_VS)));
            hl = _clampHl(hl, lam, true);
            var fr = _hbFrictionBubble(hl, b);
            r.pattern = 'bubble'; r.hl = hl; r.fn = fr.f; r.NRe = fr.nre;
            return _finish(b, r, b.rL * hl + b.rG * (1 - hl), fr.gF);
        }
        var gp = _drGroups(b), LS = 50 + 36 * gp.NLv;
        r.NLv = gp.NLv; r.Ngv = gp.Ngv; r.Nd = gp.Nd; r.LS = LS;
        if (gp.Ngv >= LS) {                                  // the Duns & Ros transition and mist regions
            var d = dr(inp);
            d.corr = 'ork'; d.LB = LB; d.drRegion = d.region;
            return d;
        }
        var nreL = 1488 * b.rL * b.vm * b.dFt / Math.max(b.muL, 1e-9), v = _orkVb(b, nreL), vb = v.vb;
        var fw = (inp && inp.props && _fin(+inp.props.fw)) ? +inp.props.fw : 0, water = fw > 0.75;
        var G0 = orkGamma(b.vm, b.dFt, b.muL, water);
        var rs0 = (b.rL * (b.vsl + vb) + b.rG * b.vsg) / (b.vm + vb);
        var gMin = b.vm < 10 ? -0.065 * b.vm : -vb / (b.vm + vb) * (1 - rs0 / b.rL);
        var Gm = G0 < gMin ? gMin : G0;
        var rhoS = rs0 + Gm * b.rL, rhoN = r.rhoN;
        if (rhoS < rhoN) rhoS = rhoN;
        if (rhoS > b.rL) rhoS = b.rL;
        var f = _fMoody(nreL, b.rough / 12 / b.dFt);
        var gF = f * b.rL * b.vm * b.vm / (2 * GC * b.dFt) * ((b.vsl + vb) / (b.vm + vb) + Gm) / 144;
        if (gF < 0) gF = 0;
        r.pattern = 'slug'; r.vb = vb; r.NReb = v.nreb; r.NReL = nreL; r.Gamma = Gm; r.Gamma0 = G0; r.GammaMin = gMin; r.water = water;
        r.rhoS0 = rs0; r.fn = f; r.NRe = nreL;
        r.hl = _clampHl((rhoS - b.rG) / (b.rL - b.rG), lam, true);
        return _assemble(b, r, rhoS, gF, 0);
    }

    // ── Aziz, Govier & Fogarasi (1972) ──────────────────────────────────────────────────────────────────────────────────
    // Map coordinates (v ft/s, ρ lbm/ft³, σ dyn/cm): N_x = v_sg·(ρ_g/0.0764)^⅓·[(ρ_L/62.4)·(72/σ)]^¼, N_y = v_sl·[(ρ_L/62.4)·(72/σ)]^¼
    // Boundaries: N1 = 0.51·(100·N_y)^0.172, N2 = 8.6 + 3.8·N_y, N3 = 70·(100·N_y)^−0.152.
    //   bubble N_x < N1; N_y < 4: slug N1 ≤ N_x < N2, transition N2 ≤ N_x < N3, mist N_x ≥ N3; N_y ≥ 4: slug N_x < 26.5, mist above.
    // Bubble: v_bs = 1.41·[g·σ·(ρ_L − ρ_g)/ρ_L²]^¼ (σ lbm/s²), v_bf = 1.2·v_m + v_bs, H_L = 1 − v_sg/v_bf;
    //   dp/dL_f = f·ρ_s·v_m²/(2·g_c·d)/144, f Moody at N_Re = 1488·ρ_L·v_m·d/μ_L.
    // Slug: N_E = g·d²·(ρ_L − ρ_g)/σ (σ lbm/s²), N_v = √(g·d³·ρ_L·(ρ_L − ρ_g))/μ_L (μ_L lbm/(ft·s)); m = 25 (N_v ≤ 18),
    //   69·N_v^−0.35 (18 < N_v < 250), 10 (N_v ≥ 250); C = 0.345·[1 − e^(−0.029·N_v)]·[1 − e^((3.37 − N_E)/m)];
    //   v_bs = C·√(g·d·(ρ_L − ρ_g)/ρ_L), v_bf = 1.2·v_m + v_bs, H_L = 1 − v_sg/v_bf; dp/dL_f = f·ρ_L·H_L·v_m²/(2·g_c·d)/144.
    // Mist: the Duns & Ros mist region (no slip, film roughness). Transition: A = (N3 − N_x)/(N3 − N2), slug × A + mist × (1 − A).
    function agfMap(b) {
        var cL = Math.pow((b.rL / 62.4) * (72 / b.sig), 0.25);
        var Nx = b.vsg * Math.pow(Math.max(b.rG, 0) / 0.0764, 1 / 3) * cL, Ny = b.vsl * cL;
        var y100 = Math.max(100 * Ny, 1e-12), N1 = 0.51 * Math.pow(y100, 0.172), N2 = 8.6 + 3.8 * Ny, N3 = 70 * Math.pow(y100, -0.152);
        var pat;
        if (Nx < N1) pat = 'bubble';
        else if (Ny < 4) pat = Nx < N2 ? 'slug' : (Nx < N3 ? 'transition' : 'mist');
        else pat = Nx < 26.5 ? 'slug' : 'mist';
        return { Nx: Nx, Ny: Ny, N1: N1, N2: N2, N3: N3, pattern: pat };
    }
    function _agfSlug(b) {
        var sigM = b.sig * SIG_LBM, dr0 = b.rL - b.rG, muLb = Math.max(b.muL, 1e-9) * MU_LBM;
        var NE = GRAV * b.dFt * b.dFt * dr0 / sigM, Nv = Math.sqrt(GRAV * Math.pow(b.dFt, 3) * b.rL * dr0) / muLb;
        var m = Nv <= 18 ? 25 : (Nv >= 250 ? 10 : 69 * Math.pow(Nv, -0.35));
        var C = 0.345 * (1 - Math.exp(-0.029 * Nv)) * (1 - Math.exp((3.37 - NE) / m));
        var vbs = C * Math.sqrt(GRAV * b.dFt * dr0 / b.rL), vbf = 1.2 * b.vm + vbs;
        var lam = b.vsl / b.vm, hl = _clampHl(1 - b.vsg / vbf, lam, true);
        var nre = 1488 * b.rL * b.vm * b.dFt / Math.max(b.muL, 1e-9), f = _fMoody(nre, b.rough / 12 / b.dFt);
        return { hl: hl, rhoS: b.rL * hl + b.rG * (1 - hl), gF: f * b.rL * hl * b.vm * b.vm / (2 * GC * b.dFt) / 144, f: f, NRe: nre, C: C, NE: NE, Nv: Nv, m: m, vbs: vbs, vbf: vbf };
    }
    function agf(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var r = _head(b, 'agf');
        if (r.single) return _onePhase(b, r);
        var mp = agfMap(b), lam = r.lambdaL;
        r.Nx = mp.Nx; r.Ny = mp.Ny; r.N1 = mp.N1; r.N2 = mp.N2; r.N3 = mp.N3; r.pattern = mp.pattern;
        if (mp.pattern === 'bubble') {
            var vbs = 1.41 * Math.pow(GRAV * b.sig * SIG_LBM * (b.rL - b.rG) / (b.rL * b.rL), 0.25), vbf = 1.2 * b.vm + vbs;
            var hl = _clampHl(1 - b.vsg / vbf, lam, true), rhoS = b.rL * hl + b.rG * (1 - hl);
            var nre = 1488 * b.rL * b.vm * b.dFt / Math.max(b.muL, 1e-9), f = _fMoody(nre, b.rough / 12 / b.dFt);
            r.hl = hl; r.vbs = vbs; r.vbf = vbf; r.fn = f; r.NRe = nre;
            return _assemble(b, r, rhoS, f * rhoS * b.vm * b.vm / (2 * GC * b.dFt) / 144, 0);
        }
        if (mp.pattern === 'slug') {
            var s = _agfSlug(b);
            r.hl = s.hl; r.C = s.C; r.NE = s.NE; r.Nv = s.Nv; r.vbs = s.vbs; r.vbf = s.vbf; r.fn = s.f; r.NRe = s.NRe;
            return _assemble(b, r, s.rhoS, s.gF, 0);
        }
        var mi = _drMist(b, b.rG);
        if (mp.pattern === 'mist') { r.hl = mi.hl; r.fn = mi.f; r.eps = mi.eps; return _assemble(b, r, mi.rhoS, mi.gF, mi.Ek); }
        var A = (mp.N3 - mp.Nx) / (mp.N3 - mp.N2), s2 = _agfSlug(b);
        var rhoT = A * s2.rhoS + (1 - A) * mi.rhoS;
        r.A = A; r.fn = A * s2.f + (1 - A) * mi.f;
        r.hl = _clampHl((rhoT - b.rG) / (b.rL - b.rG), lam, true);
        return _assemble(b, r, rhoT, A * s2.gF + (1 - A) * mi.gF, (1 - A) * mi.Ek);
    }

    // ── Mukherjee & Brill (1985) ────────────────────────────────────────────────────────────────────────────────────────
    // Groups N_Lv, N_gv, N_L as Hagedorn & Brown; θ from horizontal (+ up), s = sin θ, log = log10.
    //   slug / annular:   N_gvSM = 10^(1.401 − 2.694·N_L + 0.521·N_Lv^0.329)            annular when N_gv > N_gvSM
    //   uphill (θ > 0):   N_gvBS = 10^(log N_Lv + 0.940 + 0.074·s − 0.855·s² + 3.695·N_L)   bubble when N_gv < N_gvBS, else slug
    //   level / downhill: N_LvBS = 10^(0.431 − 3.003·N_L − 1.138·log N_gv·s − 0.429·(log N_gv)²·s + 1.132·s)
    //                     N_LvST = 10^(0.321 − 0.017·N_gv − 4.267·s − 2.972·N_L − 0.033·(log N_gv)² − 3.925·s²)
    //                     bubble when N_Lv > N_LvBS; slug when N_LvST < N_Lv ≤ N_LvBS; stratified otherwise
    //   holdup H_L = exp[(C1 + C2·s + C3·s² + C4·N_L²)·N_gv^C5 / N_Lv^C6] with the three published coefficient sets (MB_C below: uphill
    //   for θ ≥ 0, downhill stratified, downhill other); in upward flow H_L ≥ λ_L (as the other correlations of this page).
    //   bubble / slug: dp/dL_f = f·ρ_s·v_m²/(2·g_c·d)/144, f Moody at the no-slip N_Re = 1488·ρ_n·v_m·d/μ_n;
    //   annular: f = f_R·f_n with f_R from H_R = λ_L/H_L (MB_FR table, linear in log10 H_R), dp/dL_f = f·ρ_n·v_m²/(2·g_c·d)/144;
    //   stratified: the separated-flow geometry from H_L = (δ − sin δ)/(2π) (δ the liquid-wetted angle), A_L = H_L·A, P_L = δ·d/2,
    //   P_g = (2π − δ)·d/2, S_i = d·sin(δ/2), d_hL = 4·A_L/P_L, d_hg = 4·A_g/(P_g + S_i); τ_wk = f_k·ρ_k·v_k²/(2·g_c) with f_k Moody at
    //   1488·ρ_k·v_k·d_hk/μ_k, v_L = v_sl/H_L, v_g = v_sg/(1 − H_L); dp/dL_f = (τ_wL·P_L + τ_wg·P_g)/A/144 (the interfacial shear cancels in
    //   the combined momentum balance). Acceleration factor Ek = ρ_s·v_m·v_sg/(g_c·p·144) in every pattern.
    var MB_C = {
        up: [-0.380113, 0.129875, -0.119788, 2.343227, 0.475686, 0.288657],
        downStrat: [-1.330282, 4.808139, 4.171584, 56.262268, 0.079951, 0.504887],
        downOther: [-0.516644, 0.789805, 0.551627, 15.519214, 0.371771, 0.393952]
    };
    var MB_FR = [[0.01, 1.00], [0.2, 0.98], [0.3, 1.20], [0.4, 1.25], [0.5, 1.30], [0.7, 1.25], [1.0, 1.00], [10, 1.00]];
    function mbFr(HR) {
        if (!(HR > 0)) return 1;
        if (HR <= MB_FR[0][0]) return MB_FR[0][1];
        for (var i = 1; i < MB_FR.length; i++) if (HR <= MB_FR[i][0]) {
            var a = _log10(MB_FR[i - 1][0]), c = _log10(MB_FR[i][0]);
            return MB_FR[i - 1][1] + (MB_FR[i][1] - MB_FR[i - 1][1]) * (_log10(HR) - a) / (c - a);
        }
        return 1;
    }
    function mbPattern(NLv, Ngv, NL, th) {
        var s = Math.sin(th), lg = _log10(Math.max(Ngv, 1e-12));
        var SM = Math.pow(10, 1.401 - 2.694 * NL + 0.521 * Math.pow(Math.max(NLv, 0), 0.329));
        var out = { NgvSM: SM, NgvBS: null, NLvBS: null, NLvST: null, up: th > 0 };
        if (th > 0) out.NgvBS = Math.pow(10, _log10(Math.max(NLv, 1e-12)) + 0.940 + 0.074 * s - 0.855 * s * s + 3.695 * NL);
        else {
            out.NLvBS = Math.pow(10, 0.431 - 3.003 * NL - 1.138 * lg * s - 0.429 * lg * lg * s + 1.132 * s);
            out.NLvST = Math.pow(10, 0.321 - 0.017 * Ngv - 4.267 * s - 2.972 * NL - 0.033 * lg * lg - 3.925 * s * s);
        }
        if (Ngv > SM) out.pattern = 'annular';
        else if (th > 0) out.pattern = Ngv < out.NgvBS ? 'bubble' : 'slug';
        else out.pattern = NLv > out.NLvBS ? 'bubble' : (NLv > out.NLvST ? 'slug' : 'stratified');
        return out;
    }
    function mbHoldup(NLv, Ngv, NL, th, set) {
        var C = MB_C[set], s = Math.sin(th);
        return Math.exp((C[0] + C[1] * s + C[2] * s * s + C[3] * NL * NL) * Math.pow(Ngv, C[4]) / Math.pow(NLv, C[5]));
    }
    // the liquid-wetted angle δ of a stratified layer: H_L = (δ − sin δ)/(2π), bisection on [0, 2π]
    function _mbDelta(hl) {
        var lo = 0, hi = 2 * Math.PI;
        for (var k = 0; k < 80; k++) { var m = 0.5 * (lo + hi); if ((m - Math.sin(m)) / (2 * Math.PI) < hl) lo = m; else hi = m; }
        return 0.5 * (lo + hi);
    }
    function mb(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var r = _head(b, 'mb');
        if (r.single) return _onePhase(b, r);
        var gp = _drGroups(b), lam = r.lambdaL, up = b.th > 0;
        var pt = mbPattern(gp.NLv, gp.Ngv, gp.NL, b.th);
        r.NLv = gp.NLv; r.Ngv = gp.Ngv; r.NL = gp.NL; r.pattern = pt.pattern; r.NgvSM = pt.NgvSM; r.NgvBS = pt.NgvBS; r.NLvBS = pt.NLvBS; r.NLvST = pt.NLvST;
        var set = b.th >= 0 ? 'up' : (pt.pattern === 'stratified' ? 'downStrat' : 'downOther');
        var hl = _clampHl(mbHoldup(gp.NLv, gp.Ngv, gp.NL, b.th, set), lam, up);
        if (hl < 1e-6) hl = 1e-6;
        r.hl = hl; r.set = set; r.hlRaw = mbHoldup(gp.NLv, gp.Ngv, gp.NL, b.th, set);
        var rhoS = b.rL * hl + b.rG * (1 - hl), nreN = 1488 * r.rhoN * b.vm * b.dFt / Math.max(r.muN, 1e-9), fn = _fMoody(nreN, b.rough / 12 / b.dFt), gF;
        r.NRe = nreN;
        if (pt.pattern === 'annular') {
            var HR = lam / hl, fR = mbFr(HR);
            r.HR = HR; r.fR = fR; r.fn = fR * fn;
            gF = fR * fn * r.rhoN * b.vm * b.vm / (2 * GC * b.dFt) / 144;
        } else if (pt.pattern === 'stratified') {
            var dl = _mbDelta(hl), d = b.dFt, A = Math.PI * d * d / 4, AL = hl * A, Ag = A - AL;
            var PL = dl * d / 2, Pg = (2 * Math.PI - dl) * d / 2, Si = d * Math.sin(dl / 2);
            var dhL = 4 * AL / Math.max(PL, 1e-12), dhg = 4 * Ag / Math.max(Pg + Si, 1e-12);
            var vL = b.vsl / hl, vG = b.vsg / Math.max(1 - hl, 1e-9);
            var fL = _fMoody(1488 * b.rL * vL * dhL / Math.max(b.muL, 1e-9), b.rough / 12 / Math.max(dhL, 1e-9));
            var fG = _fMoody(1488 * b.rG * vG * dhg / Math.max(b.muG, 1e-9), b.rough / 12 / Math.max(dhg, 1e-9));
            var tL = fL * b.rL * vL * vL / (2 * GC), tG = fG * b.rG * vG * vG / (2 * GC);
            r.delta = dl; r.dhL = dhL; r.dhg = dhg; r.fL = fL; r.fG = fG; r.tauL = tL; r.tauG = tG; r.fn = fn;
            gF = (tL * PL + tG * Pg) / A / 144;
        } else { r.fn = fn; gF = fn * rhoS * b.vm * b.vm / (2 * GC * b.dFt) / 144; }
        return _assemble(b, r, rhoS, gF, _ekOf(b, rhoS));
    }

    // ── Ansari, Sylvester, Sarica, Shoham & Brill (1994), mechanistic, upward flow ──────────────────────────────────────
    // Consistent units (v ft/s, ρ lbm/ft³, σ lbm/s², μ lbm/(ft·s), d ft, g ft/s²; dp/dL lbf/ft² per ft ÷ 144 → psi/ft):
    //   bubble rise v_s = 1.53·[g·σ·(ρ_L − ρ_g)/ρ_L²]^¼; bubble / slug: v_sg = 0.25·v_s + 0.333·v_sl, bubble flow only when
    //   d > d_min = 19.01·[(ρ_L − ρ_g)·σ/(ρ_L²·g)]^½; annular: v_sg > 3.1·[g·σ·(ρ_L − ρ_g)/ρ_g²]^¼;
    //   dispersed bubble (Barnea): 2·[0.4·σ/((ρ_L − ρ_g)·g)]^½·(ρ_L/σ)^0.6·[f_n/(2·d)]^0.4·v_m^1.2 > 0.725 + 4.15·(v_sg/v_m)^½ while
    //   λ_g ≤ 0.52.
    //   bubble: v_sg/(1 − H_L) = 1.2·v_m + v_s·H_L^½ (solved for H_L); dispersed bubble: no slip; friction f·ρ_s·v_m²/(2·g_c·d) at
    //     N_Re = 1488·ρ_L·v_m·d/μ_L (dispersed: ρ_n, μ_n);
    //   slug (fully developed): v_TB = 1.2·v_m + 0.35·√(g·d·(ρ_L − ρ_g)/ρ_L); H_LLS = 1/[1 + (v_m/28.4)^1.39] (Gregory et al.; v_m ft/s);
    //     v_gLS = 1.2·v_m + v_s·H_LLS^½, v_LLS = (v_m − v_gLS·(1 − H_LLS))/H_LLS; film H_LTB from (v_TB − v_LLS)·H_LLS =
    //     (v_TB + v_LTB)·H_LTB, v_LTB = 9.916·√(g·d·(1 − √(1 − H_LTB))); β = L_TB/L_SU = [v_sg − v_gLS·(1 − H_LLS)] /
    //     [v_TB·(1 − H_LTB) − v_gLS·(1 − H_LLS)]; ρ_s = (1 − β)·ρ_LS + β·ρ_g (the film's weight neglected, as published);
    //     dp/dL_f = f·ρ_LS·v_m²/(2·g_c·d)·(1 − β), f Moody at N_Re = 1488·ρ_LS·v_m·d/μ_LS;
    //   annular (Alves et al. film model): entrainment F_E = 1 − exp[−0.125·(v_crit − 1.5)], v_crit = 1e4·v_sg·μ_g/σ·(ρ_g/ρ_L)^½ in SI
    //     (v m/s, μ Pa·s, σ N/m: = 3048·v_sg(ft/s)·μ_g(cp)/σ(dyn/cm)·(ρ_g/ρ_L)^½); core λ_LC = F_E·v_sl/(v_sg + F_E·v_sl),
    //     ρ_c, μ_c by λ_LC, v_sc = v_sg + F_E·v_sl; (dp/dL)_SC = f_SC·ρ_c·v_sc²/(2·g_c·d), (dp/dL)_SL = f_SL·ρ_L·v_sl²/(2·g_c·d);
    //     X_M² = (1 − F_E)²·(dp/dL)_SL/(dp/dL)_SC (film friction factor taken equal to f_SL), Y_M = sin θ·(ρ_L − ρ_c)/(dp/dL)_SC;
    //     Z = 1 + 300·δ (F_E > 0.9) else 1 + 24·(ρ_L/ρ_g)^⅓·δ; δ (film thickness / d) from
    //       Y_M − Z/[4δ(1 − δ)·(1 − 4δ(1 − δ))^2.5] + X_M²/[4δ(1 − δ)]³ = 0      (bisection on 0 < δ < ½)
    //     dp/dL = Z/(1 − 2δ)⁵·(dp/dL)_SC + ρ_c·sin θ (core), H_L = 4δ(1 − δ) + λ_LC·(1 − 2δ)².
    function _ansariProps(b) {
        var sigM = b.sig * SIG_LBM, drho = b.rL - b.rG;
        return { sigM: sigM, drho: drho, vs: 1.53 * Math.pow(GRAV * sigM * drho / (b.rL * b.rL), 0.25),
            vsgA: b.rG > 0 ? 3.1 * Math.pow(GRAV * sigM * drho / (b.rG * b.rG), 0.25) : Infinity,
            dMin: 19.01 * Math.sqrt(drho * sigM / (b.rL * b.rL * GRAV)) };
    }
    // dispersed-bubble criterion (Barnea) — > 0 when dispersed
    function _barnea(b, sigM, drho, fn) {
        var lhs = 2 * Math.sqrt(0.4 * sigM / (drho * GRAV)) * Math.pow(b.rL / sigM, 0.6) * Math.pow(fn / (2 * b.dFt), 0.4) * Math.pow(b.vm, 1.2);
        return lhs - (0.725 + 4.15 * Math.sqrt(b.vsg / b.vm));
    }
    function ansariPattern(b) {
        var a = _ansariProps(b), lam = b.vsl / b.vm;
        var rhoN = b.rL * lam + b.rG * (1 - lam), muN = b.muL * lam + b.muG * (1 - lam);
        var fn = _fMoody(1488 * rhoN * b.vm * b.dFt / Math.max(muN, 1e-9), b.rough / 12 / b.dFt);
        var vsgBS = 0.25 * a.vs + 0.333 * b.vsl, bar = _barnea(b, a.sigM, a.drho, fn);
        var pat = b.vsg > a.vsgA ? 'annular' : ((bar > 0 && 1 - lam <= 0.52) ? 'dispersed bubble' : ((b.vsg < vsgBS && b.dFt > a.dMin) ? 'bubble' : 'slug'));
        return { pattern: pat, vs: a.vs, vsgBS: vsgBS, vsgA: a.vsgA, dMin: a.dMin, barnea: bar, fn: fn, sigM: a.sigM, drho: a.drho };
    }
    function ansari(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var r = _head(b, 'ansari');
        if (r.single) return _onePhase(b, r);
        var lam = r.lambdaL, P = ansariPattern(b), up = b.th > 0;
        r.pattern = P.pattern; r.vs = P.vs; r.vsgBS = P.vsgBS; r.vsgA = P.vsgA;
        var nreL = 1488 * b.rL * b.vm * b.dFt / Math.max(b.muL, 1e-9), rel = b.rough / 12 / b.dFt;
        if (P.pattern === 'dispersed bubble') {
            r.hl = lam; r.fn = P.fn; r.NRe = 1488 * r.rhoN * b.vm * b.dFt / Math.max(r.muN, 1e-9);
            return _assemble(b, r, r.rhoN, P.fn * r.rhoN * b.vm * b.vm / (2 * GC * b.dFt) / 144, _ekOf(b, r.rhoN));
        }
        if (P.pattern === 'bubble') {
            var lo = 1e-9, hi = 1 - 1e-9;
            for (var k = 0; k < 56; k++) { var m = 0.5 * (lo + hi); if (b.vsg / (1 - m) - 1.2 * b.vm - P.vs * Math.sqrt(m) < 0) lo = m; else hi = m; }
            var hl = _clampHl(0.5 * (lo + hi), lam, up), rhoS = b.rL * hl + b.rG * (1 - hl), f = _fMoody(nreL, rel);
            r.hl = hl; r.fn = f; r.NRe = nreL;
            return _assemble(b, r, rhoS, f * rhoS * b.vm * b.vm / (2 * GC * b.dFt) / 144, _ekOf(b, rhoS));
        }
        if (P.pattern === 'slug') {
            var vTB = 1.2 * b.vm + 0.35 * Math.sqrt(GRAV * b.dFt * P.drho / b.rL);
            var HLLS = 1 / (1 + Math.pow(b.vm / 28.4, 1.39)), aLS = 1 - HLLS;
            var vgLS = 1.2 * b.vm + P.vs * Math.sqrt(HLLS), vLLS = (b.vm - vgLS * aLS) / HLLS;
            var rhsF = (vTB - vLLS) * HLLS, l2 = 1e-9, h2 = HLLS;
            var hf = function (h) { return (vTB + 9.916 * Math.sqrt(GRAV * b.dFt * (1 - Math.sqrt(Math.max(0, 1 - h))))) * h - rhsF; };
            if (rhsF <= 0) h2 = l2;
            else for (var k2 = 0; k2 < 56; k2++) { var m2 = 0.5 * (l2 + h2); if (hf(m2) < 0) l2 = m2; else h2 = m2; }
            var HLTB = 0.5 * (l2 + h2);
            var den = vTB * (1 - HLTB) - vgLS * aLS, beta = den > 1e-12 ? (b.vsg - vgLS * aLS) / den : 0;
            if (!(beta >= 0)) beta = 0; if (beta > 1) beta = 1;
            var rhoLS = b.rL * HLLS + b.rG * aLS, muLS = b.muL * HLLS + b.muG * aLS;
            var rhoS2 = (1 - beta) * rhoLS + beta * b.rG;
            var nreLS = 1488 * rhoLS * b.vm * b.dFt / Math.max(muLS, 1e-9), f2 = _fMoody(nreLS, rel);
            r.vTB = vTB; r.HLLS = HLLS; r.HLTB = HLTB; r.beta = beta; r.vgLS = vgLS; r.vLLS = vLLS; r.rhoLS = rhoLS; r.fn = f2; r.NRe = nreLS;
            r.hl = _clampHl((rhoS2 - b.rG) / (b.rL - b.rG), lam, up);
            return _assemble(b, r, rhoS2, f2 * rhoLS * b.vm * b.vm / (2 * GC * b.dFt) * (1 - beta) / 144, 0);
        }
        // annular
        var vcrit = 3048 * b.vsg * b.muG / b.sig * Math.sqrt(b.rG / b.rL);
        var FE = 1 - Math.exp(-0.125 * (vcrit - 1.5)); if (FE < 0) FE = 0; if (FE > 0.9999) FE = 0.9999;
        var vsc = b.vsg + FE * b.vsl, lLC = FE * b.vsl / vsc, rhoC = b.rL * lLC + b.rG * (1 - lLC), muC = b.muL * lLC + b.muG * (1 - lLC);
        var fSC = _fMoody(1488 * rhoC * vsc * b.dFt / Math.max(muC, 1e-9), rel), dpSC = fSC * rhoC * vsc * vsc / (2 * GC * b.dFt);
        var fSL = b.vsl > 0 ? _fMoody(1488 * b.rL * b.vsl * b.dFt / Math.max(b.muL, 1e-9), rel) : 0, dpSL = fSL * b.rL * b.vsl * b.vsl / (2 * GC * b.dFt);
        var XM2 = dpSC > 0 ? (1 - FE) * (1 - FE) * dpSL / dpSC : 0, YM = dpSC > 0 ? Math.sin(b.th) * (b.rL - rhoC) / dpSC : 0;
        var hiZ = FE > 0.9, zc = 24 * Math.pow(b.rL / Math.max(b.rG, 1e-9), 1 / 3);
        var Zf = function (dd) { return hiZ ? 1 + 300 * dd : 1 + zc * dd; };
        var fd = function (dd) { var w = 4 * dd * (1 - dd); return YM - Zf(dd) / (w * Math.pow(1 - w, 2.5)) + XM2 / (w * w * w); };
        var dlo = 1e-7, dhi = 0.5 - 1e-7;
        if (fd(dlo) <= 0) dhi = dlo;
        else for (var k3 = 0; k3 < 48; k3++) { var dm = Math.sqrt(dlo * dhi); if (fd(dm) > 0) dlo = dm; else dhi = dm; }
        var dl = Math.sqrt(dlo * dhi), Z = Zf(dl), coreF = Z / Math.pow(1 - 2 * dl, 5) * dpSC / 144;
        r.FE = FE; r.vcrit = vcrit; r.delta = dl; r.Z = Z; r.XM2 = XM2; r.YM = YM; r.lambdaLC = lLC; r.rhoC = rhoC; r.fn = fSC;
        r.hl = _clampHl(4 * dl * (1 - dl) + lLC * Math.pow(1 - 2 * dl, 2), 0, false);
        return _assemble(b, r, rhoC, coreF, _ekOf(b, rhoC));
    }

    // ── Hasan & Kabir (1988; 2002 text), drift flux, inclined wells ─────────────────────────────────────────────────────
    // θ from horizontal; consistent units as Ansari above (σ lbm/s²). Drift velocities:
    //   bubbles v_∞ = 1.53·[g·σ·(ρ_L − ρ_g)/ρ_L²]^¼; Taylor bubbles v_∞T = 0.35·√(g·d·(ρ_L − ρ_g)/ρ_L)·√(sin θ)·(1 + cos θ)^1.2
    // Patterns: annular v_sg > 3.1·[g·σ·(ρ_L − ρ_g)/ρ_g²]^¼; dispersed bubble v_m > 4·[d^0.429·(σ/ρ_L)^0.089/ν_L^0.072·(g·(ρ_L − ρ_g)/ρ_L)^0.446]
    //   (SI inside: d m, σ N/m, ρ kg/m³, ν_L m²/s, g m/s² → m/s); bubble v_sg < 0.429·v_sl + 0.357·v_∞·sin θ; churn
    //   v_sg > 1.083·v_sl + 0.52·v_∞T; slug otherwise.
    // Void fraction α = v_sg/(C0·v_m + v_d): bubble and dispersed bubble C0 = 1.2, v_d = v_∞·sin θ; slug C0 = 1.2, v_d = v_∞T; churn
    //   C0 = 1.15, v_d = v_∞T; H_L = 1 − α (≥ λ_L in upward flow). Friction f·ρ_s·v_m²/(2·g_c·d)/144 at N_Re = 1488·ρ_L·v_m·d/μ_L.
    // Annular: α = (1 + X^0.8)^−0.378 with the Lockhart-Martinelli X = √[(dp/dL)_SL/(dp/dL)_SG] (superficial-phase Moody friction);
    //   core entrainment E as Ansari (Wallis v_crit), core density ρ_c = (ρ_g·v_sg + ρ_L·E·v_sl)/v_sc, v_sc = v_sg + E·v_sl;
    //   dp/dL_f = f_c·ρ_c·v_sc²/(2·g_c·d)/144 with the interfacial factor f_c = 4 × 0.079·(1 + 75·H_L)/N_Re,c^0.25 (Darcy form of the
    //   Fanning Blasius factor with the Wallis film term; N_Re,c = 1488·ρ_c·v_sc·d/μ_c); elevation on ρ_s = ρ_L·H_L + ρ_g·α.
    //   Acceleration factor Ek = ρ_s·v_m·v_sg/(g_c·p·144) except slug / churn.
    function hkPattern(b) {
        var sigM = b.sig * SIG_LBM, drho = b.rL - b.rG, s = Math.sin(b.th), c = Math.cos(b.th);
        var vinf = 1.53 * Math.pow(GRAV * sigM * drho / (b.rL * b.rL), 0.25);
        var vinfT = 0.35 * Math.sqrt(GRAV * b.dFt * drho / b.rL) * Math.sqrt(Math.max(0, s)) * Math.pow(1 + c, 1.2);
        var vsgA = b.rG > 0 ? 3.1 * Math.pow(GRAV * sigM * drho / (b.rG * b.rG), 0.25) : Infinity;
        var dM = b.dFt * 0.3048, sigSI = b.sig * 1e-3, rLSI = b.rL * 16.0185, nuL = b.muL * 1e-3 / rLSI;
        var vDB = 4 * Math.pow(dM, 0.429) * Math.pow(sigSI / rLSI, 0.089) / Math.pow(nuL, 0.072) * Math.pow(9.80665 * drho / b.rL, 0.446) / 0.3048;   // ft/s
        var vsgB = 0.429 * b.vsl + 0.357 * vinf * Math.max(0, s), vsgC = 1.083 * b.vsl + 0.52 * vinfT;
        var pat = b.vsg > vsgA ? 'annular' : (b.vm > vDB ? 'dispersed bubble' : (b.vsg < vsgB ? 'bubble' : (b.vsg > vsgC ? 'churn' : 'slug')));
        return { pattern: pat, vinf: vinf, vinfT: vinfT, vsgA: vsgA, vDB: vDB, vsgB: vsgB, vsgC: vsgC, sigM: sigM, drho: drho };
    }
    function hk(inp) {
        var b = _base(inp);
        if (!(b.vm > 0) || !(b.dFt > 0)) return _static(b);
        var r = _head(b, 'hk');
        if (r.single) return _onePhase(b, r);
        var lam = r.lambdaL, P = hkPattern(b), up = b.th > 0, s = Math.max(0, Math.sin(b.th)), rel = b.rough / 12 / b.dFt;
        r.pattern = P.pattern; r.vinf = P.vinf; r.vinfT = P.vinfT; r.vsgA = P.vsgA; r.vDB = P.vDB; r.vsgB = P.vsgB; r.vsgC = P.vsgC;
        var nreL = 1488 * b.rL * b.vm * b.dFt / Math.max(b.muL, 1e-9);
        if (P.pattern !== 'annular') {
            var C0 = P.pattern === 'churn' ? 1.15 : 1.2, vd = (P.pattern === 'slug' || P.pattern === 'churn') ? P.vinfT : P.vinf * s;
            var alpha = b.vsg / (C0 * b.vm + vd), hl = _clampHl(1 - alpha, lam, up), rhoS = b.rL * hl + b.rG * (1 - hl), f = _fMoody(nreL, rel);
            r.C0 = C0; r.vd = vd; r.alpha = 1 - hl; r.hl = hl; r.fn = f; r.NRe = nreL;
            var ek = (P.pattern === 'slug' || P.pattern === 'churn') ? 0 : _ekOf(b, rhoS);
            return _assemble(b, r, rhoS, f * rhoS * b.vm * b.vm / (2 * GC * b.dFt) / 144, ek);
        }
        var fSL = b.vsl > 0 ? _fMoody(1488 * b.rL * b.vsl * b.dFt / Math.max(b.muL, 1e-9), rel) : 0, fSG = _fMoody(1488 * b.rG * b.vsg * b.dFt / Math.max(b.muG, 1e-9), rel);
        var dpSL = fSL * b.rL * b.vsl * b.vsl, dpSG = fSG * b.rG * b.vsg * b.vsg, X = dpSG > 0 ? Math.sqrt(dpSL / dpSG) : 0;
        var al = Math.pow(1 + Math.pow(X, 0.8), -0.378), hl2 = _clampHl(1 - al, lam, up); al = 1 - hl2;
        var vcrit = 3048 * b.vsg * b.muG / b.sig * Math.sqrt(b.rG / b.rL), E = 1 - Math.exp(-0.125 * (vcrit - 1.5)); if (E < 0) E = 0; if (E > 0.9999) E = 0.9999;
        var vsc = b.vsg + E * b.vsl, rhoC = (b.rG * b.vsg + b.rL * E * b.vsl) / vsc, lC = E * b.vsl / vsc, muC = b.muL * lC + b.muG * (1 - lC);
        var nreC = 1488 * rhoC * vsc * b.dFt / Math.max(muC, 1e-9), fi = 4 * 0.079 * (1 + 75 * hl2) / Math.pow(Math.max(nreC, 1), 0.25), vc = vsc;
        var rhoS3 = b.rL * hl2 + b.rG * al;
        r.X = X; r.alpha = al; r.hl = hl2; r.E = E; r.rhoC = rhoC; r.vc = vc; r.fi = fi; r.fn = fi; r.NRe = nreC;
        return _assemble(b, r, rhoS3, fi * rhoC * vc * vc / (2 * GC * b.dFt) / 144, _ekOf(b, rhoS3));
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
            grad: csPoint },
        // WP21 (B): two more empirical vertical-well methods, one inclined-pipe method and two mechanistic models
        ork: { key: 'ork', label: 'Orkiszewski (1967), Griffith bubble, Griffith-Wallis slug, Duns & Ros mist', kind: 'well', vertical: true,
            range: { incl: [0, VERT_WARN_DEG], note: 'vertical oil wells; slug flow with the liquid distribution coefficient' }, map: 'ros', grad: ork },
        agf: { key: 'agf', label: 'Aziz, Govier & Fogarasi (1972), flow-pattern map N_x / N_y', kind: 'well', vertical: true,
            range: { incl: [0, VERT_WARN_DEG], note: 'vertical oil wells; bubble and slug from bubble-rise physics' }, map: 'agf', grad: agf },
        mb: { key: 'mb', label: 'Mukherjee & Brill (1985), inclined pipe (holdup and pattern by inclination)', kind: 'any', vertical: false,
            range: { incl: [-90, 90], note: 'any inclination, uphill and downhill; stratified flow in level and downhill pipe' }, map: 'mb', grad: mb },
        ansari: { key: 'ansari', label: 'Ansari et al. (1994), mechanistic (bubble, dispersed bubble, slug, annular)', kind: 'well', vertical: true,
            range: { incl: [0, VERT_WARN_DEG], note: 'vertical upward flow' }, map: 'mech', grad: ansari },
        hk: { key: 'hk', label: 'Hasan & Kabir (1988), drift flux for inclined wells', kind: 'well', vertical: false,
            range: { incl: [0, 90], note: 'upward flow, vertical to near-horizontal (the Taylor-bubble drift falls to zero at horizontal)' }, map: 'mech', grad: hk }
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
            k === 'gasCS' ? 'Cullender & Smith (1956), as given by Economides et al. and Brill & Mukherjee (1999)' :
            k === 'ork' ? 'Orkiszewski (1967); Griffith (1961); Griffith & Wallis (1961); Duns & Ros (1963) — as given by Brill & Mukherjee (1999) §4.2.3' :
            k === 'agf' ? 'Aziz, Govier & Fogarasi (1972) — as given by Brill & Mukherjee (1999) §4.2.5' :
            k === 'mb' ? 'Mukherjee & Brill (1985) — as given by Brill & Mukherjee (1999) §4.3.3' :
            k === 'ansari' ? 'Ansari, Sylvester, Sarica, Shoham & Brill (1994); Barnea (1987); Gregory et al. (1978); Alves et al. (1991)' :
            k === 'hk' ? 'Hasan & Kabir (1988), Fluid Flow and Heat Transfer in Wellbores (2002) ch. 4; Wallis (1969)' : 'homogeneous mixture';
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

    // ── per-section correlations (WP21, increment B) ───────────────────────────────────────────────────────────────────
    // o.sections = [{by:'md'|'inc', from, to, corr}] — 'md': the MD interval [from, to) ft (segments are split at its ends); 'inc': every
    // segment whose average inclination FROM VERTICAL is in [from, to) degrees (from ≤ inc < to; to ≥ 90 includes horizontal). Rows apply
    // in the listed order: the first row that covers a segment sets its correlation; elsewhere the base correlation (o.corr / the model's)
    // applies. A row with an unknown key, no range or an empty range is skipped with a SECTION_SKIPPED warning. The marcher takes the key
    // per segment (segment.corr, 49-calc-flowline.js v4.5), so one march, one frozen step layout and one profile carry every section.
    var SEC_MAX = 12;
    function normSections(list) {
        var rows = [], warnings = [], REG = _reg();
        (Array.isArray(list) ? list : []).slice(0, SEC_MAX).forEach(function (r, i) {
            if (!r || typeof r !== 'object') return;
            var by = r.by === 'inc' ? 'inc' : 'md', a = +r.from, z = +r.to, k = r.corr == null ? '' : String(r.corr);
            if (by === 'md' && !_fin(a)) a = 0;
            if (by === 'inc' && !_fin(a)) a = 0;
            if (!_fin(z)) z = by === 'inc' ? 180 : Infinity;
            var ok = k && Object.prototype.hasOwnProperty.call(REG, k) && REG[k] && typeof REG[k].grad === 'function';
            if (!ok) { warnings.push(_w('SECTION_SKIPPED', 'Section ' + (i + 1) + ': unknown correlation ' + (k ? k.slice(0, 24) : '(none)') + ' — skipped.', 'info')); return; }
            if (!(z > a)) { warnings.push(_w('SECTION_SKIPPED', 'Section ' + (i + 1) + ': the range is empty (from ≥ to) — skipped.', 'info')); return; }
            rows.push({ by: by, from: a, to: z, corr: k, row: i });
        });
        return { rows: rows, warnings: warnings };
    }
    // split the flow-order segment list (deepest first) at the given MDs (straight segments: length, Δz and TVD in proportion; a
    // restriction stays with the piece that holds the segment's flow inlet, the deeper end)
    function _splitAt(segs, mds) {
        var out = [];
        segs.forEach(function (s) {
            var cuts = mds.filter(function (m) { return m > s.mdTop + 0.01 && m < s.mdBot - 0.01; }).sort(function (a, b) { return b - a; });
            if (!cuts.length) { out.push(s); return; }
            var hiMd = s.mdBot;
            cuts.concat([s.mdTop]).forEach(function (m, j) {
                var len = hiMd - m, fr = len / s.len, c = {};
                Object.keys(s).forEach(function (k) { c[k] = s[k]; });
                c.mdTop = m; c.mdBot = hiMd; c.len = len; c.dz = s.dz * fr;
                c.tvdTop = s.tvdTop + (s.tvdBot - s.tvdTop) * (m - s.mdTop) / s.len; c.tvdBot = s.tvdTop + (s.tvdBot - s.tvdTop) * (hiMd - s.mdTop) / s.len;
                if (j > 0) delete c.restr;
                out.push(c); hiMd = m;
            });
        });
        return out;
    }
    function _applySections(segs, list, base) {
        var n = normSections(list), rows = n.rows;
        if (!rows.length) return { segs: segs, active: false, warnings: n.warnings, rows: rows };
        var mds = [];
        rows.forEach(function (r) { if (r.by === 'md') { if (_fin(r.from)) mds.push(r.from); if (_fin(r.to)) mds.push(r.to); } });
        var sp = mds.length ? _splitAt(segs, mds) : segs.slice();
        var hit = rows.map(function () { return 0; });
        sp.forEach(function (s) {
            var mid = 0.5 * (s.mdTop + s.mdBot), key = base, rule = -1;
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i], inside = r.by === 'md' ? (mid >= r.from && mid < r.to) : (s.inc >= r.from - 1e-9 && s.inc < r.to - 1e-9 || (r.to >= 90 && s.inc >= r.from && s.inc <= 180));
                if (inside) { key = r.corr; rule = i; hit[i]++; break; }
            }
            s.corr = key; s.secRow = rule >= 0 ? rows[rule].row : -1;
        });
        rows.forEach(function (r, i) { if (!hit[i]) n.warnings.push(_w('SECTION_EMPTY', 'Section ' + (r.row + 1) + ' (' + (r.by === 'md' ? 'MD ' + _fmt(r.from, 0) + '–' + (_fin(r.to) ? _fmt(r.to, 0) : 'TD') + ' ft' : _fmt(r.from, 0) + '–' + _fmt(r.to, 0) + '° from vertical') + ') covers no part of this flow path.', 'info')); });
        return { segs: sp, active: true, warnings: n.warnings, rows: rows };
    }
    // the contiguous runs of one correlation along a segment list, top → bottom
    function _runs(segs, REG) {
        var a = segs.slice().sort(function (x, y) { return x.mdTop - y.mdTop; }), out = [];
        a.forEach(function (s) {
            var l = out[out.length - 1], k = s.corr;
            if (l && l.corr === k && Math.abs(l.mdBot - s.mdTop) < 0.5) { l.mdBot = s.mdBot; l.tvdBot = s.tvdBot; l.incMin = Math.min(l.incMin, s.inc); l.incMax = Math.max(l.incMax, s.inc); return; }
            var e = REG[k] || {};
            out.push({ corr: k, label: e.label || k, verified: e.verified === true, vertical: !!e.vertical, row: s.secRow, mdTop: s.mdTop, mdBot: s.mdBot, tvdTop: s.tvdTop, tvdBot: s.tvdBot, incMin: s.inc, incMax: s.inc });
        });
        return out;
    }
    // the sections resolved on a well path (for the page, the schematic and the report): runs top → bottom
    function sectionsFor(W, list, base) {
        var segs = _path(W);
        if (!segs.length) return { ok: false, code: 'NO_PATH', runs: [], warnings: [] };
        var b = base || 'bb', ap = _applySections(segs, list, b);
        if (!ap.active) ap.segs.forEach(function (s) { s.corr = b; s.secRow = -1; });
        return { ok: true, active: ap.active, runs: _runs(ap.segs, _reg()), warnings: ap.warnings, rows: ap.rows };
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
        // per-section correlations (WP21): o.sections absent, false, null or [] → one correlation for the whole path (as before)
        var SEC = (Array.isArray(o.sections) && o.sections.length) ? _applySections(segs, o.sections, key) : null;
        if (SEC) { SEC.warnings.forEach(function (w) { warnings.push(w); }); if (SEC.active) segs = SEC.segs; else SEC = null; }
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
        var m = G.WTS_flowline_march(mseg.map(function (s) { var c = { name: s.name, len: s.len, id: s.id, dz: s.dz }; if (s.area) c.area = s.area; if (s.restr) c.restr = s.restr; if (SEC) c.corr = s.corr; return c; }),
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
            if (SEC) row.corr = s.corr;
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
            var so = { name: s.name, mdTop: s.mdTop, mdBot: s.mdBot, tvdTop: s.tvdTop, tvdBot: s.tvdBot, inc: s.inc, len: s.len, id: s.id,
                pIn: r.pIn == null ? null : r.pIn + PATM, pOut: r.pOut == null ? null : r.pOut + PATM, dpEl: r.dpEl, dpF: r.dpF, dpAcc: r.dpAcc,
                dpRestr: r.dpRestr || 0, patterns: r.patterns, vmMax: r.vmMax, eroMax: r.eroMax };
            if (SEC) so.corr = s.corr;
            return so;
        });
        // warnings: vertical-only correlations on deviated sections, ranges, provisional label — for every correlation in use (one
        // without sections; each section's own with them, judged on the segments it covers)
        var used = [];
        if (SEC) segs.forEach(function (s) { if (used.indexOf(s.corr) === -1) used.push(s.corr); }); else used.push(key);
        used.forEach(function (uk) {
            var Eu = REG[uk], Ru = (Eu && Eu.range) || {}, mine = SEC ? segs.filter(function (s) { return s.corr === uk; }) : segs;
            if (!Eu) return;
            if (Eu.vertical) {
                var incMax = 0, mdAt = null;
                mine.forEach(function (s) { if (s.inc > incMax) { incMax = s.inc; mdAt = s.mdTop; } });
                if (incMax > VERT_WARN_DEG) warnings.push(_w('VERTICAL_ONLY', Eu.label + ' is a vertical-well correlation; ' + (SEC ? 'its section' : 'the path') + ' reaches ' + _fmt(incMax, 0) +
                    '° from vertical (MD ' + _fmt(mdAt, 0) + ' ft). The elevation term uses the true inclination; Beggs & Brill is suggested for ' + (SEC ? 'that section.' : 'this well.')));
            }
            var dMax = 0; mine.forEach(function (s) { if (s.id > dMax) dMax = s.id; });
            var vmU = 0; if (SEC) segOut.forEach(function (so) { if (so.corr === uk && so.vmMax > vmU) vmU = so.vmMax; }); else vmU = vmMax;
            if (Ru.dMaxIn && dMax > Ru.dMaxIn) warnings.push(_w('RANGE_D', Eu.label + ': flow diameter ' + _fmt(dMax, 3) + ' in is above the data range (≤ ' + Ru.dMaxIn + ' in).'));
            if (Ru.vmMax && vmU > Ru.vmMax) warnings.push(_w('RANGE_VM', Eu.label + ': mixture velocity ' + _fmt(vmU, 1) + ' ft/s is above the data range (< ' + Ru.vmMax + ' ft/s).'));
            if (Ru.cgrMax != null && _num(F.cgr) > Ru.cgrMax) warnings.push(_w('RANGE_CGR', Eu.label + ': condensate ratio ' + _fmt(F.cgr, 1) + ' bbl/MMscf is above the data range (≤ ' + Ru.cgrMax + ').'));
            if (Ru.wgrMax != null && _num(F.wgr) > Ru.wgrMax) warnings.push(_w('RANGE_WGR', Eu.label + ': water ratio ' + _fmt(F.wgr, 1) + ' bbl/MMscf is above the data range (≤ ' + Ru.wgrMax + ').'));
            if (uk === 'single' && prof.some(function (r) { return r.pattern === 'homogeneous' && (!SEC || r.corr === 'single'); })) warnings.push(_w('SINGLE_TWO_PHASE', 'Single-phase method with free gas present: a homogeneous mixture is used; choose a multiphase correlation.'));
            if ((uk === 'gasTZ' || uk === 'gasCS' || (Ru.note === 'gas only')) && (ff.qo > 0 || ff.qw > 0)) warnings.push(_w('GAS_ONLY', 'Dry-gas method: the liquids are not included in the gradient.'));
            if (Eu.verified !== true) warnings.push(_w('PROVISIONAL', Eu.label + ': ' + PROVISIONAL + '.', 'info'));
        });
        if (lost) warnings.push(_w('LOST', 'The traverse stops at MD ' + _fmt(lost.md, 0) + ' ft (' + lost.reason + ').'));
        var res = { ok: !lost, corr: key, from: from, label: E.label, verified: E.verified === true, profile: prof, pEnd: pEnd,
            pTop: prof.length ? prof[0].p : null, pBottom: prof.length ? prof[prof.length - 1].p : null, lost: lost,
            grid: m.grid || null, segments: segOut, restrictionsDp: dpR, restrictions: restr, vmMax: vmMax, eroMax: eroMax,
            rough: rough.v, stepFt: stepFt, warnings: warnings, errors: errors };
        if (SEC) { res.sections = _runs(segs, REG); res.corrs = used; }
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

    // ── WP21 (B): a traverse on the flow-pattern map of another correlation ──────────────────────────────────────────────
    // patternMap(F, q, traverse, {kind:'agf'|'mb'|'mech', corr?}) — each station of any traverse placed on the map of Aziz-Govier-Fogarasi
    // (N_x, N_y), Mukherjee-Brill (N_Lv, N_gv; boundaries at the stations' median inclination) or the mechanistic superficial-velocity
    // map (v_sg, v_sl ft/s; corr 'hk' → the Hasan-Kabir boundaries, else Ansari), classified by that correlation's own pattern rules with
    // the in-situ properties at the station (WTS_flowline_props) — so the colours are the map correlation's patterns, not the traverse's.
    // The boundary lines are drawn at the median station's properties (diameter, densities, σ, N_L, inclination).
    // → {ok, kind, corr, axes:{x, y}, points:[{md, tvd, inc, p, x, y, pattern}], counts{pattern: n}, lines:[{key, label, pts:[[x, y]]}],
    //    labels:[{x, y, text, pattern}], ref:{inc, theta, d, NL, rhoL, rhoG, sigma}}
    var MAP_KINDS = { agf: 'agf', mb: 'mb', mech: 'ansari' };
    function _logspace(a, b, n) { var out = [], la = _log10(a), lb = _log10(b); for (var i = 0; i < n; i++) out.push(Math.pow(10, la + (lb - la) * i / (n - 1))); return out; }
    function patternMap(F, q, tr, o) {
        o = o || {};
        var kind = MAP_KINDS[o.kind] ? o.kind : 'agf', corr = kind === 'mech' ? (o.corr === 'hk' ? 'hk' : 'ansari') : MAP_KINDS[kind];
        if (!tr || !Array.isArray(tr.profile) || !tr.profile.length) return { ok: false, code: 'NO_TRAVERSE', errors: ['no traverse'], points: [], kind: kind, corr: corr };
        if (typeof G.WTS_flowline_props !== 'function') return { ok: false, code: 'MISSING_ENGINE', errors: ['WTS_flowline_props is not loaded'], points: [], kind: kind, corr: corr };
        var ff = _ff(F, q), segs = Array.isArray(tr.segments) ? tr.segments : [], rough = _fin(+tr.rough) ? +tr.rough : 0.0006;
        var idAt = function (md) { for (var i = 0; i < segs.length; i++) { var s = segs[i]; if (md >= s.mdTop - 1e-6 && md <= s.mdBot + 1e-6) return s.id; } return segs.length ? segs[segs.length - 1].id : null; };
        var pts = [], counts = {}, refs = [];
        tr.profile.forEach(function (r) {
            if (r.restr || !_fin(r.p) || !_fin(r.t)) return;
            var d = idAt(r.md); if (!(d > 0)) return;
            var pr = G.WTS_flowline_props(ff, r.p, r.t); if (!pr) return;
            var vsl = _num(r.vsl), vsg = _num(r.vsg);
            if (!(vsl > 0) || !(vsg > 0) || !(pr.sigL > 0) || !(pr.rhoL > pr.rhoG)) { counts.single = (counts.single || 0) + 1; return; }
            var inc = _fin(r.inc) ? r.inc : 0;
            var b = _base({ vsl: vsl, vsg: vsg, d: d, rhoL: pr.rhoL, rhoG: pr.rhoG, muL: pr.muL, muG: pr.mug, sigma: pr.sigL, theta: 90 - inc, rough: rough, p: r.p });
            var x, y, pat;
            if (kind === 'agf') { var am = agfMap(b); x = am.Nx; y = am.Ny; pat = am.pattern; }
            else if (kind === 'mb') { var gp = _drGroups(b); x = gp.NLv; y = gp.Ngv; pat = mbPattern(gp.NLv, gp.Ngv, gp.NL, b.th).pattern; b.NL = gp.NL; }
            else { x = vsg; y = vsl; pat = corr === 'hk' ? hkPattern(b).pattern : ansariPattern(b).pattern; }
            counts[pat] = (counts[pat] || 0) + 1;
            pts.push({ md: r.md, tvd: r.tvd, inc: inc, p: r.p, x: x, y: y, pattern: pat });
            refs.push(b);
        });
        var out = { ok: pts.length > 0, kind: kind, corr: corr, points: pts, counts: counts, lines: [], labels: [], ref: null,
            axes: kind === 'agf' ? { x: { label: 'N_x', log: true }, y: { label: 'N_y', log: true } } : kind === 'mb' ? { x: { label: 'N_Lv', log: true }, y: { label: 'N_gv', log: true } }
                : { x: { label: 'v_sg', unit: 'ft/s', log: true }, y: { label: 'v_sl', unit: 'ft/s', log: true } } };
        if (!refs.length) return out;
        var B = refs[Math.floor(refs.length / 2)];
        out.ref = { inc: 90 - B.theta, theta: B.theta, d: B.dIn, rhoL: B.rL, rhoG: B.rG, sigma: B.sig, muL: B.muL, NL: kind === 'mb' ? _drGroups(B).NL : null };
        var L = out.lines, LB = out.labels;
        if (kind === 'agf') {
            var ys = _logspace(1e-3, 100, 60), ysLo = ys.filter(function (v) { return v < 4; }).concat([4]);
            L.push({ key: 'n1', label: 'N1 (bubble / slug)', pts: ys.map(function (v) { return [0.51 * Math.pow(100 * v, 0.172), v]; }) });
            L.push({ key: 'n2', label: 'N2 (slug / transition)', pts: ysLo.map(function (v) { return [8.6 + 3.8 * v, v]; }) });
            L.push({ key: 'n3', label: 'N3 (transition / mist)', pts: ysLo.map(function (v) { return [70 * Math.pow(100 * v, -0.152), v]; }) });
            L.push({ key: 'n4', label: 'N_x = 26.5 (N_y ≥ 4)', pts: _logspace(4, 100, 12).map(function (v) { return [26.5, v]; }) });
            LB.push({ x: 0.05, y: 2, text: 'bubble', pattern: 'bubble' }, { x: 3, y: 0.3, text: 'slug', pattern: 'slug' }, { x: 30, y: 0.02, text: 'transition', pattern: 'transition' }, { x: 300, y: 0.3, text: 'mist', pattern: 'mist' });
        } else if (kind === 'mb') {
            var NL = out.ref.NL, th = B.th, xs = _logspace(1e-3, 100, 60), ys2 = _logspace(1e-2, 1000, 60);
            L.push({ key: 'sm', label: 'slug / annular boundary', pts: xs.map(function (v) { return [v, mbPattern(v, 1, NL, th).NgvSM]; }) });
            if (th > 0) L.push({ key: 'bs', label: 'bubble / slug', pts: xs.map(function (v) { return [v, mbPattern(v, 1, NL, th).NgvBS]; }) });
            else {
                L.push({ key: 'bs', label: 'bubble / slug', pts: ys2.map(function (v) { return [mbPattern(1, v, NL, th).NLvBS, v]; }) });
                L.push({ key: 'st', label: 'slug / stratified', pts: ys2.map(function (v) { return [mbPattern(1, v, NL, th).NLvST, v]; }) });
            }
            LB.push({ x: 10, y: 0.05, text: 'bubble', pattern: 'bubble' }, { x: 0.05, y: 3, text: 'slug', pattern: 'slug' }, { x: 0.05, y: 300, text: 'annular', pattern: 'annular' });
            if (!(th > 0)) LB.push({ x: 0.002, y: 0.05, text: 'stratified', pattern: 'stratified' });
        } else {
            var vl = _logspace(0.01, 50, 50);
            if (corr === 'hk') {
                var P = hkPattern(B);
                L.push({ key: 'bs', label: 'bubble / slug', pts: vl.map(function (v) { return [0.429 * v + 0.357 * P.vinf * Math.max(0, Math.sin(B.th)), v]; }) });
                L.push({ key: 'sc', label: 'slug / churn', pts: vl.map(function (v) { return [1.083 * v + 0.52 * P.vinfT, v]; }) });
                L.push({ key: 'db', label: 'dispersed-bubble boundary', pts: vl.filter(function (v) { return P.vDB - v > 1e-3; }).map(function (v) { return [P.vDB - v, v]; }) });
                L.push({ key: 'an', label: 'annular boundary', pts: vl.map(function (v) { return [P.vsgA, v]; }) });
            } else {
                var A0 = _ansariProps(B);
                L.push({ key: 'bs', label: 'bubble / slug', pts: vl.map(function (v) { return [0.25 * A0.vs + 0.333 * v, v]; }) });
                var db = [];
                vl.forEach(function (v) {
                    var gfun = function (vg) { var bb2 = _base({ vsl: v, vsg: vg, d: B.dIn, rhoL: B.rL, rhoG: B.rG, muL: B.muL, muG: B.muG, sigma: B.sig, theta: B.theta, rough: B.rough, p: B.p });
                        var lam = v / (v + vg), rn = B.rL * lam + B.rG * (1 - lam), mn = B.muL * lam + B.muG * (1 - lam);
                        return _barnea(bb2, A0.sigM, A0.drho, _fMoody(1488 * rn * bb2.vm * bb2.dFt / Math.max(mn, 1e-9), B.rough / 12 / bb2.dFt)); };
                    var hiV = v * 0.52 / 0.48, loV = 1e-4;
                    if (!(gfun(loV) > 0)) return;
                    if (gfun(hiV) > 0) { db.push([hiV, v]); return; }
                    for (var k = 0; k < 50; k++) { var mid = Math.sqrt(loV * hiV); if (gfun(mid) > 0) loV = mid; else hiV = mid; }
                    db.push([Math.sqrt(loV * hiV), v]);
                });
                L.push({ key: 'db', label: 'dispersed-bubble boundary', pts: db });
                L.push({ key: 'an', label: 'annular boundary', pts: vl.map(function (v) { return [A0.vsgA, v]; }) });
            }
            LB.push({ x: 0.05, y: 8, text: 'bubble', pattern: 'bubble' }, { x: 3, y: 0.05, text: 'slug', pattern: 'slug' }, { x: 300, y: 0.1, text: 'annular', pattern: 'annular' }, { x: 0.3, y: 30, text: 'dispersed', pattern: 'bubble' });
            if (corr === 'hk') LB.push({ x: 25, y: 0.03, text: 'churn', pattern: 'churn' });
        }
        return out;
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
    // WP21 (B): per-section correlations, the pattern maps of the new correlations and their closed-form pieces (tests)
    NS.normSections = normSections; NS.sectionsFor = sectionsFor; NS.patternMap = patternMap;
    NS.agfMap = agfMap; NS.mbPattern = mbPattern; NS.mbHoldup = mbHoldup; NS.mbFr = mbFr; NS.orkGamma = orkGamma;
    NS.ansariPattern = function (inp) { return ansariPattern(_base(inp)); }; NS.hkPattern = function (inp) { return hkPattern(_base(inp)); };
    NS.MB_C = JSON.parse(JSON.stringify(MB_C)); NS.SEC_MAX = SEC_MAX;
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
    ['hb', 'gray', 'nsl', 'single', 'gasTZ', 'dr', 'gasCS', 'ork', 'agf', 'mb', 'ansari', 'hk'].forEach(function (k) { if (!C || !C[k] || typeof C[k].grad !== 'function') bad.push(k + ' not registered'); });
    // WP21: every new correlation is hydrostatic for a creeping water column
    if (C) ['ork', 'agf', 'mb', 'ansari', 'hk'].forEach(function (k) { if (C[k]) { var gw = C[k].grad({ vsl: 1e-6, vsg: 0, d: 2.441, rhoL: 62.4, rhoG: 0.1, muL: 1, muG: 0.01, sigma: 70, theta: 90, rough: 0.0006, p: 1000 }); if (Math.abs(gw.gradEl - 62.4 / 144) > 1e-12) bad.push(k + ' hydrostatic'); } });
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
