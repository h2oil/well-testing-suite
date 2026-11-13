// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Multiphase Flowline Pressure Drop (flowline)
//
// PURPOSE
//   Steady-state pressure profile of the surface lines of a well test:
//     route 1  choke outlet (choke manifold) → heater → separator (oil + water + gas),
//     route 2  separator gas PCV outlet → knock-out drum → flare line and boom → flare tip
//              (separator gas only).
//   Each route is a list of segments (length, inside diameter, elevation
//   change). Each segment is marched in short steps with the pressure
//   gradient evaluated at the step's average pressure and temperature.
//
// BOUNDARIES (both routes are marched BACKWARDS from their known downstream pressure)
//   In a well-test spread the choke takes the well's pressure drop and the separator gas PCV
//   (back-pressure valve) holds the separator pressure, so neither line starts at a known pressure:
//   • Route 1 starts at the separator operating pressure (the PCV set point) at the separator inlet
//     and is marched against the flow to the choke outlet → P2, the pressure needed just downstream
//     of the choke. The choke then takes WHP − P2; p2/p1 (absolute) against the critical ratio:
//     0.588 for gas–liquid flow (Gilbert 1954, p1 ≥ 1.7·p2, as the Choke Performance page) or
//     (2/(k+1))^(k/(k−1)) for dry gas (k from the Gas PVT engine). WHP < P2 → the well cannot deliver
//     this rate into the separator.
//   • Route 2 starts at the flare tip, 14.696 psia + the tip pressure drop (input), and is marched
//     against the flow to the PCV outlet → the flare-header back-pressure. The PCV takes
//     Psep − P_out: choked when x = ΔP/p1 ≥ Fγ·xT (IEC 60534-2-1, Fγ = k/1.4, xT input, default 0.7
//     for a globe valve); p2/p1 is also reported against the ideal-nozzle ratio (2/(k+1))^(k/(k−1))
//     (ideal-gas k at the separator temperature, 46-calc-gaspvt.js WTS_gaspvt_k).
//     The flare line always includes the acceleration term (compressible flow).
//   Reverse march: the step pressure change is evaluated at the step's mid pressure (3 fixed-point
//   passes) and, on these routes, a step whose predicted change exceeds 3 % of the pressure is split
//   (≤ 200 sub-steps) — the gas density changes several-fold near the flare tip. The B&B kinetic
//   energy term Ek = ρs·vm·vSg/(gc·p) (= ρv²/p, the isothermal Mach² of a gas) makes dp/dx ∝ 1/(1 − Ek)
//   singular at Ek = 1, the isothermal choked-flow limit (v = √(ZRT/M), Mach v/c ≈ 1/√k). Ek ≥ 1 at a
//   segment outlet: the segment chokes, its outlet sits at the pressure where Ek = 1 (a pressure step down
//   to the downstream pressure) and the route is flagged ✗. From Ek = 0.9 to the outlet (≈ 0.1 ft of
//   pipe) the pressure change is taken in one step, booked as acceleration. The page routes stop above
//   15,000 psig (lost, reason 'high': the well cannot deliver / the separator cannot vent the rate).
//   Coupled temperature model: the temperature profile comes from a forward P–T march from the
//   result, and the backward march is repeated until P2 changes by < 0.005 psi.
//
// GAS PCV AND FLARE CHECKS
//   PCV outlet temperature: isenthalpic expansion dT/dp = μJT(p, T) integrated by Heun's method
//   (3–10 steps) from the separator to the PCV outlet, μJT = R·T²·(∂Z/∂T)p/(p·Cp) from the DAK Z and
//   the real-gas Cp (46-calc-gaspvt.js WTS_gaspvt_state; fallback 0.07 °F/psi, the GPSA "7 °F per
//   100 psi" rule). ⚠ when the gas anywhere in the flare line is below the hydrate temperature at its
//   pressure (25-hydrate.js WTS_hydrate_temp, Towler & Mokhatab 2005), or the coldest gas (linear model:
//   the isenthalpic temperature at the line exit) is below the minimum design metal temperature (input).
//   With no flow through the PCV (back-pressure ≥ Psep) only that ✗ is shown.
//   Mach = v/c at each segment's inlet and outlet, c = the real-gas speed of sound (WTS_gaspvt_state):
//   API Std 521 practice — ⚠ above 0.5 (continuous flow, headers and long lines), ✗ above 0.7 and
//   ✗ when the line chokes. ρv² ⚠ above 200,000 kg/m·s² (134,400 lb/ft·s²), a common screening limit
//   for flare and relief lines (noise and flow-induced vibration). Back-pressure at the PCV outlet
//   against 10 % of the separator PSV set pressure: the limit for a conventional PSV discharging into
//   the same header at the same rate (API Std 520 Part I); default set pressure 1,440 psig, a common
//   well-test separator working pressure (blank skips the check). The API RP 14E erosional ratio is
//   reported for the well line only: the dry separator gas downstream of the PCV is judged by Mach and ρv².
//
// METHOD (all field units)
//   Beggs, H.D. & Brill, J.P. (1973), "A Study of Two-Phase Flow in Inclined
//   Pipes", JPT May 1973, 607-617, in the revised form given by Brill, J.P. &
//   Mukherjee, H. (1999), "Multiphase Flow in Wells", SPE Monograph 17, §4.2.x:
//     λL = vSL/vm,  NFr = vm²/(g·d)
//     L1 = 316 λL^0.302,  L2 = 0.0009252 λL^−2.4684,
//     L3 = 0.10 λL^−1.4516,  L4 = 0.5 λL^−6.738
//     segregated   λL < 0.01 & NFr < L1,  or λL ≥ 0.01 & NFr < L2
//     transition   λL ≥ 0.01 & L2 ≤ NFr ≤ L3
//     intermittent 0.01 ≤ λL < 0.4 & L3 < NFr ≤ L1,  or λL ≥ 0.4 & L3 < NFr ≤ L4
//     distributed  λL < 0.4 & NFr ≥ L1,  or λL ≥ 0.4 & NFr > L4
//     HL(0) = a λL^b / NFr^c ≥ λL  (seg 0.980/0.4846/0.0868, int 0.845/0.5351/0.0173,
//                                   dist 1.065/0.5824/0.0609)
//     C = (1−λL)·ln(e λL^f NLV^g NFr^h) ≥ 0   (uphill seg 0.011/−3.768/3.539/−1.614,
//         uphill int 2.96/0.305/−0.4473/0.0978, uphill dist C = 0,
//         downhill all 4.70/−0.3692/0.1244/−0.5056),  NLV = 1.938 vSL (ρL/σL)^¼
//     ψ = 1 + C·[sin(1.8θ) − 0.333 sin³(1.8θ)],  HL(θ) = HL(0)·ψ
//     transition: HL = A·HL_seg + (1−A)·HL_int,  A = (L3 − NFr)/(L3 − L2)
//     y = λL/HL²,  S = ln y / (−0.0523 + 3.182 ln y − 0.8725 (ln y)² + 0.01853 (ln y)⁴),
//         S = ln(2.2y − 1.2) for 1 < y < 1.2;   ftp = fn·e^S
//     dp/dL = [ftp ρn vm²/(2 gc d) + ρs (g/gc) sin θ] / (1 − Ek),
//         Ek = ρs vm vSg / (gc p)   (acceleration, optional)
//   fn (no-slip) from NRe = 1488 ρn vm d / μn: original smooth-pipe form
//     fn = 1/[2 log(NRe/(4.5223 log NRe − 3.8215))]²; with the Payne option,
//     the Colebrook (Moody) rough-pipe factor.
//   Payne, G.A., Palmer, C.M., Brill, J.P. & Beggs, H.D. (1979), "Evaluation of
//   Inclined-Pipe Two-Phase Liquid Holdup and Pressure-Loss Correlations Using
//   Experimental Data", JPT Sept 1979, 1198-1208: HL × 0.924 uphill, × 0.685
//   downhill, rough-pipe friction factor.
//
// FLUID PROPERTIES (at each step's P, T)
//   16-pvt.js window.PRiSM_pvt_correlations: Standing Rs (capped at the
//   producing GOR) and Bo, Beggs-Robinson live-oil viscosity, Meehan Bw and
//   McCain water viscosity, DAK Z with Sutton pseudo-criticals
//   (window.WTS_gaspvt_pseudoCriticals when present), Lee-Gonzalez-Eakin μg.
//   Oil density ρo = (62.37 γo + 0.01361 Rs γg)/Bo (Brill & Mukherjee eq. 2.x).
//   Surface tension (not in 16-pvt.js): Baker & Swerdloff (1956) dead oil
//   σ68 = 39 − 0.2571 API, σ100 = 37.5 − 0.2571 API (linear between 68 and
//   100 °F), live oil σo = σod·(1 − 0.024 p^0.45) (Beggs 1991, "Production
//   Optimization Using Nodal Analysis"); water after Hough et al. (1951) as
//   fitted by Beggs (1991): σw74 = 75 − 1.108 p^0.349, σw280 = 53 − 0.1048 p^0.637.
//   Liquid properties are in-situ volume-fraction averages (no emulsion).
//
// TEMPERATURE (v3.0 option "coupled")
//   Linear from the line inlet (downstream of the choke) to the arrival temperature (default), or a
//   coupled pressure–temperature march: each step loses heat by the Line Heat Loss model
//   (49-calc-lineheat.js WTS_lineheat_ua, bare / insulated pipe in air, inside film
//   neglected): T_out = Ta + (T_in − Ta)·exp(−UA′·dx/(ṁ·cp)) (Holman §10; Incropera
//   §3.3), minus μJT·Δp_step (isenthalpic throttling), and the step's pressure
//   gradient is evaluated at the step's mean temperature (3 fixed-point passes).
//   The line inlet temperature is downstream of the choke, so the choke's own J-T cooling is not
//   applied again. The flare line starts at the PCV outlet temperature. Linear model: adiabatic, the gas
//   keeps expanding isenthalpically to the tip, T(x) = T_h(p(x)) on the PCV's expansion curve. That is the
//   stagnation-equivalent temperature: the static gas temperature is lower by v²/(2·cp) (≈ 3 % of the
//   absolute temperature at Mach 0.5), while the pipe wall sees about the recovery temperature, ≈ 0.9 of
//   the way back to it (recovery factor ≈ Pr^⅓). Coupled model: line heat loss + μJT along the line.
//   Gas rate = separator gas at standard conditions (22-units WTS_baseConditions,
//   default 60 °F / 14.696 psia). Free gas = qg − qo·Rs.
//
// PUBLIC API (window.*)
//   WTS_flowline_bb(input)        Beggs & Brill gradient at one point (no PVT)
//   WTS_flowline_props(fluid, p, t)  in-situ fluid properties
//   WTS_flowline_compute(input)   full routes → {ok, routes[], choke, pcv, psv, flareCheck, …} or {ok:false, errors, bad}
//   WTS_flowline_march(segments, fluid, p0, t0, t1, opt)  pressure traverse (opt.reverse = against the flow,
//                                 opt.refine = split steps with > 3 % pressure change; the Well Performance options
//                                 corr / mult / tAt / pMax / stepFt / grid / eroC / detail and segment area / restr — below)
//   WTS_flowline_corr             gradient-correlation registry {key: {key, label, kind, range, verified, grad(inp) → G}};
//                                 this file registers 'bb' (Beggs & Brill); 49-calc-wp-vlp.js adds the well correlations
//
// WELL PERFORMANCE OPTIONS (v4.3 WP0b, docs/WELL-PERFORMANCE-PLAN.md §2.3, §4.5; every one is additive: absent, the march and
// the page routes are exactly as before — wellperf-identity FI1–FI6)
//   opt.corr      registry key string (D3): the step gradient is WTS_flowline_corr[key].grad(inp), inp = the object bb takes
//                 + {props, mult}; an unknown key → {ok:false, code:'UNKNOWN_CORR'}; absent → bb as before
//   opt.mult      {hl, f}: H_L' = clamp(m_h·H_L, λ_L, 1), then ρ_s, the gradients and the acceleration factor are rebuilt
//                 (gradEl from ρ_s; gradF from the entry's friction(hl, inp, G) when it has one — bb recomputes its slip
//                 factor S(y = λ_L / H_L'²) — else × 1; then × m_f; grad = (gradEl + gradF) / (1 − Ek), Ek with ρ_s)
//   opt.stepFt    step length per segment (ft), clamped to 10–400 steps (default 50 ft as before)
//   opt.grid      true → the march records its step / sub-step layout and returns it as .grid; a grid object from an
//                 earlier march → that layout is used (no refine decisions: p(q) stays smooth within one solve, §4.5)
//   segment.corr  (v4.5 WP21) a registry key for this segment only (per-section correlation); absent → opt.corr (or bb) as before
//   opt.eroC      API RP 14E C for the erosional ratio (default 100)
//   opt.detail    each profile entry also carries seg, vm, vsl, vsg, rhoS, gradEl, gradF, gradAcc, ero
//   segment.area  flow area (in²) for the velocities when it differs from the circle of segment.id (annulus: id = the
//                 hydraulic diameter); segment.restr {d in, k?}: a restriction at the segment's flow inlet,
//                 Δp = K·ρ_n·v_m²/(2·g_c·144) at the bore velocity, K = 0.5(1 − β²) + (1 − β²)² (β = d / id) unless k is given
//   fluid.pvt     property options for WTS_flowline_props (see props below); absent → Standing / Beggs-Robinson / DAK-Sutton
//   WTS_flowline_isenthalp(sgg, p1 psia, t1 °F, p2 psia)  gas temperature after a throttling valve
//   renderFlowline(body), calcFlowline(), WTS_flowlineUseHeat()
//
// STATE  WTS_state.flowline = {ok, pArr (separator inlet, psig), dpSep (choke outlet → separator),
//        pFlare (flare tip), dpFlare (PCV outlet → tip), pPcvOut, dpPcv, pcvChoked, tPcvOut,
//        flareMachMax, p2Choke, dpChoke, chokeCritical, ts, result}; dpPcv and tPcvOut are null when the PCV
//        cannot pass the gas, dpChoke when WHP < P2 (pcvChoked / chokeCritical false); pcvChoked = x ≥ Fγ·xT.
// Registers window.WTS_calcRegistry.flowline (group "Well Test & Flowlines").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var GRAV = 32.174, GC = 32.174;         // ft/s², lbm·ft/(lbf·s²)
    var PATM = 14.696;                      // psia (also the flare-tip atmosphere)
    var MW_AIR = 28.9647, R_GAS = 10.7316;  // lb/lb-mol, psia·ft³/(lb-mol·°R)
    var R_FT_LBF = 1545.35;                 // ft·lbf/(lb-mol·°R)
    var RANK = 459.67;
    var FT3_BBL = 5.614583;
    var RHO_W = 62.366;                     // lb/ft³, fresh water at 60 °F
    var PSIFT_KPAM = 6.894757 / 0.3048;     // kPa/m per psi/ft
    var NSEG_W = 6, NSEG_F = 4;
    var EK_LOST = 0.95;                     // B&B kinetic-energy term Ek at which a march step fails
    var EK_CRIT = 1, EK_NEAR = 0.9;         // choked (isothermal limit, 1/(1 − Ek) singular) / near-exit margin
    var P_CAP = 15000;                      // psig: page routes stop above the input limit (PVT range)
    var REFINE = 0.03, MAX_SUB = 200;       // sub-step when a step changes p by > 3 %
    var GILBERT_CRIT = 0.588;               // p2/p1 for critical multiphase choke flow (49-calc-chokeperf.js)
    var MUJT_RULE = 0.07;                   // °F/psi, GPSA rule when the Gas PVT engine is absent
    var MACH_WARN = 0.5, MACH_BAD = 0.7;    // API Std 521 practice
    var PA_LBFT = 1.488164;                 // kg/m·s² per lb/ft·s²
    var RHOV2_LIM = 200000 / PA_LBFT;       // lb/ft·s² (200,000 kg/m·s²)
    var PSV_FRAC = 0.10;                    // conventional PSV built-up back-pressure limit (API Std 520 Part I)
    var DP_PCV_MIN = 5;                     // psi: below this the PCV runs nearly wide open
    var DEF = { dptip: 1.5, mdmt: -20, psvset: 1440, xt: 0.7 };   // xt: globe-valve pressure differential ratio factor

    // ρv² unit (merged into WTS_units when absent): lb/ft·s² ↔ kg/m·s² (= Pa).
    (function _cats() {
        var U = G.WTS_units, C = U && U.CATEGORIES;
        if (!C || C.momentumFlux) return;
        C.momentumFlux = { imperial: { unit: 'lb/ft/s2', label: 'lb/ft·s²', factor: PA_LBFT, offset: 0 },
            metric: { unit: 'kg/m/s2', label: 'kg/m·s²', factor: 1, offset: 0 } };
    })();

    // ── Helpers ─────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
        if (v == null || !isFinite(v)) return '—';
        if (_metric() && U.format) {
            var f = U.format(v, cat);
            return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label;
        }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _lab(cat, imp) {
        var U = G.WTS_units;
        if (_metric() && U && U.CATEGORIES && U.CATEGORIES[cat]) return U.CATEGORIES[cat].metric.label;
        return imp;
    }
    function _dv(v, cat) { var U = G.WTS_units; return (_metric() && U && U.format) ? U.format(v, cat).value : v; }
    function _grad(psiFt) { return _metric() ? _fmt(psiFt * PSIFT_KPAM, 3) + ' kPa/m' : _fmt(psiFt, 4) + ' psi/ft'; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _log10(x) { return Math.log(x) / Math.LN10; }

    // ── Friction factors (Darcy / Moody) ────────────────────────────
    // Beggs & Brill (1973) smooth-pipe no-slip factor.
    function fSmooth(nre) {
        if (!(nre > 0)) return 0;
        if (nre < 2000) return 64 / nre;
        var a = _log10(nre / (4.5223 * _log10(nre) - 3.8215));
        return 1 / Math.pow(2 * a, 2);
    }
    // Colebrook (1939) rough pipe, fixed-point on 1/√f from the Swamee-Jain start.
    function fColebrook(nre, relRough) {
        if (!(nre > 0)) return 0;
        if (nre < 2000) return 64 / nre;
        var e = Math.max(0, relRough || 0);
        var x = -2 * _log10(e / 3.7 + 5.74 / Math.pow(nre, 0.9));   // 1/√f
        for (var k = 0; k < 50; k++) {
            var xn = -2 * _log10(e / 3.7 + 2.51 * x / nre);
            if (Math.abs(xn - x) < 1e-12) { x = xn; break; }
            x = xn;
        }
        return 1 / (x * x);
    }

    // ── Beggs & Brill gradient at one point ─────────────────────────
    // input = {vsl, vsg ft/s, d in, rhoL, rhoG lb/ft³, muL, muG cp, sigma dyn/cm,
    //          theta deg (+ uphill), rough in, p psia, payne bool, accel bool}
    var HCOEF = { seg: [0.980, 0.4846, 0.0868], int: [0.845, 0.5351, 0.0173], dist: [1.065, 0.5824, 0.0609] };
    var UPC = { seg: [0.011, -3.768, 3.539, -1.614], int: [2.96, 0.305, -0.4473, 0.0978] };
    var DNC = [4.70, -0.3692, 0.1244, -0.5056];
    function _holdup(pat, lam, nfr, nlv, th, payne) {
        var c = HCOEF[pat];
        var h0 = c[0] * Math.pow(lam, c[1]) / Math.pow(nfr, c[2]);
        if (h0 < lam) h0 = lam;
        var C = 0;
        if (th !== 0) {
            var k = th > 0 ? UPC[pat] : DNC;
            if (k) {
                var arg = k[0] * Math.pow(lam, k[1]) * Math.pow(nlv, k[2]) * Math.pow(nfr, k[3]);
                C = arg > 0 ? (1 - lam) * Math.log(arg) : 0;
                if (!(C > 0)) C = 0;
            }
        }
        var s18 = Math.sin(1.8 * th);
        var psi = 1 + C * (s18 - 0.333 * s18 * s18 * s18);
        var hl = h0 * psi;
        var pf = 1;
        if (payne) pf = th > 0 ? 0.924 : th < 0 ? 0.685 : 1;
        hl *= pf;
        if (th >= 0 && hl < lam) hl = lam;          // B&B constraint HL ≥ λL (horizontal and uphill)
        if (hl > 1) hl = 1;
        return { h0: h0, C: C, psi: psi, hl: hl, payneFactor: pf };
    }
    function bb(input) {
        var i = input || {};
        var vsl = Math.max(0, Number(i.vsl) || 0), vsg = Math.max(0, Number(i.vsg) || 0);
        var dFt = Number(i.d) / 12, rL = Number(i.rhoL), rG = Number(i.rhoG);
        var muL = Number(i.muL), muG = Number(i.muG), sig = Number(i.sigma);
        var thDeg = Number(i.theta) || 0, th = thDeg * Math.PI / 180;
        var rough = Number(i.rough) || 0, p = Number(i.p);
        var payne = !!i.payne, accel = !!i.accel;
        var vm = vsl + vsg;
        var r = { vsl: vsl, vsg: vsg, vm: vm, theta: thDeg };
        if (!(vm > 0) || !(dFt > 0)) {
            r.lambdaL = vsl > 0 ? 1 : 0; r.hl = r.lambdaL; r.pattern = 'none';
            r.rhoS = rL * r.hl + rG * (1 - r.hl); r.rhoN = r.rhoS;
            r.gradEl = r.rhoS * Math.sin(th) / 144; r.gradF = 0; r.gradAcc = 0; r.grad = r.gradEl; r.Ek = 0;
            return r;
        }
        var lam = vsl / vm;
        var nfr = vm * vm / (GRAV * dFt);
        var nlv = (vsl > 0 && sig > 0) ? 1.938 * vsl * Math.pow(rL / sig, 0.25) : 0;
        r.lambdaL = lam; r.NFr = nfr; r.NLV = nlv;
        var hl, pat, h = null;
        if (lam < 1e-7) { pat = 'gas'; hl = 0; }
        else if (lam > 1 - 1e-9) { pat = 'liquid'; hl = 1; }
        else {
            var L1 = 316 * Math.pow(lam, 0.302), L2 = 0.0009252 * Math.pow(lam, -2.4684),
                L3 = 0.10 * Math.pow(lam, -1.4516), L4 = 0.5 * Math.pow(lam, -6.738);
            r.L1 = L1; r.L2 = L2; r.L3 = L3; r.L4 = L4;
            if ((lam < 0.01 && nfr < L1) || (lam >= 0.01 && nfr < L2)) pat = 'segregated';
            else if (lam >= 0.01 && nfr >= L2 && nfr <= L3) pat = 'transition';
            else if ((lam >= 0.01 && lam < 0.4 && nfr > L3 && nfr <= L1) || (lam >= 0.4 && nfr > L3 && nfr <= L4)) pat = 'intermittent';
            else pat = 'distributed';
            if (pat === 'transition') {
                var hs = _holdup('seg', lam, nfr, nlv, th, payne), hi = _holdup('int', lam, nfr, nlv, th, payne);
                var A = (L3 - nfr) / (L3 - L2);
                hl = A * hs.hl + (1 - A) * hi.hl;
                r.A = A; r.hlSeg = hs.hl; r.hlInt = hi.hl;
                h = { h0: A * hs.h0 + (1 - A) * hi.h0, C: null, psi: null, payneFactor: hs.payneFactor };
            } else {
                h = _holdup(pat === 'segregated' ? 'seg' : pat === 'intermittent' ? 'int' : 'dist', lam, nfr, nlv, th, payne);
                hl = h.hl;
            }
        }
        r.pattern = pat; r.hl = hl;
        if (h) { r.HL0 = h.h0; r.C = h.C; r.psi = h.psi; r.payneFactor = h.payneFactor; }
        var rhoN = rL * lam + rG * (1 - lam);
        var muN = muL * lam + muG * (1 - lam);
        var rhoS = rL * hl + rG * (1 - hl);
        var nre = 1488 * rhoN * vm * dFt / muN;
        var single = (pat === 'gas' || pat === 'liquid');
        var fn = (payne || single) ? fColebrook(nre, rough / 12 / dFt) : fSmooth(nre);
        var S = 0, y = 1;
        if (!single) {
            y = lam / (hl * hl);
            if (y > 1 && y < 1.2) S = Math.log(2.2 * y - 1.2);
            else {
                var x = Math.log(y);
                var den = -0.0523 + 3.182 * x - 0.8725 * x * x + 0.01853 * Math.pow(x, 4);
                S = den !== 0 ? x / den : 0;
            }
        }
        var ftp = fn * Math.exp(S);
        var gEl = rhoS * Math.sin(th) / 144;                          // psi/ft (g/gc = 1)
        var gF = ftp * rhoN * vm * vm / (2 * GC * dFt) / 144;         // psi/ft
        var Ek = (accel && p > 0) ? rhoS * vm * vsg / (GC * p * 144) : 0;
        var tot = Ek < 1 ? (gEl + gF) / (1 - Ek) : Infinity;
        r.rhoN = rhoN; r.muN = muN; r.rhoS = rhoS; r.NRe = nre; r.fn = fn; r.y = y; r.S = S; r.ftp = ftp;
        r.gradEl = gEl; r.gradF = gF; r.Ek = Ek; r.grad = tot; r.gradAcc = tot - gEl - gF;
        return r;
    }

    // ── Gradient-correlation registry (D3; merge, never replace) ──────
    var CORR = G.WTS_flowline_corr = G.WTS_flowline_corr || {};
    // bb's two-phase friction rebuilt at a scaled holdup (opt.mult): Darcy no-slip factor × e^S, S(y = λ_L / H_L²)
    function _bbFriction(hl, inp, g) {
        if (!(g.fn > 0) || g.pattern === 'gas' || g.pattern === 'liquid' || !(hl > 0)) return g.gradF;
        var y = g.lambdaL / (hl * hl), S;
        if (y > 1 && y < 1.2) S = Math.log(2.2 * y - 1.2);
        else { var x = Math.log(y), den = -0.0523 + 3.182 * x - 0.8725 * x * x + 0.01853 * Math.pow(x, 4); S = den !== 0 ? x / den : 0; }
        return g.fn * Math.exp(S) * g.rhoN * g.vm * g.vm / (2 * GC * (Number(inp.d) / 12)) / 144;
    }
    CORR.bb = {
        key: 'bb', label: 'Beggs & Brill (1973), Payne corrections', kind: 'any', verified: true, vertical: false,
        range: { incl: [-90, 90] },
        grad: function (inp) { return bb(inp); },
        friction: _bbFriction
    };
    function _corrOf(key) { var e = (key != null && Object.prototype.hasOwnProperty.call(CORR, key)) ? CORR[key] : null; return (e && typeof e.grad === 'function') ? e : null; }
    // opt.mult: H_L' = clamp(m_h·H_L, λ_L, 1); ρ_s, gradEl, gradF, Ek and grad rebuilt (§3.4 / D10)
    function _applyMult(g, inp, mult, E) {
        var mh = _fin(+mult.hl) ? +mult.hl : 1, mf = _fin(+mult.f) ? +mult.f : 1;
        if (mh === 1 && mf === 1) return g;
        var lam = _fin(g.lambdaL) ? g.lambdaL : 0;
        var hl = Math.min(1, Math.max(lam, mh * g.hl));
        var rL = Number(inp.rhoL), rG = Number(inp.rhoG), th = (Number(inp.theta) || 0) * Math.PI / 180;
        var rhoS = rL * hl + rG * (1 - hl);
        var gEl = rhoS * Math.sin(th) / 144;
        var gF = (E && typeof E.friction === 'function') ? E.friction(hl, inp, g) : g.gradF;
        gF = (_fin(gF) ? gF : g.gradF) * mf;
        var p = Number(inp.p), Ek = (inp.accel && p > 0) ? rhoS * g.vm * g.vsg / (GC * p * 144) : 0;
        var tot = Ek < 1 ? (gEl + gF) / (1 - Ek) : Infinity;
        var o = {}; for (var k in g) o[k] = g[k];
        o.hl = hl; o.rhoS = rhoS; o.gradEl = gEl; o.gradF = gF; o.Ek = Ek; o.grad = tot; o.gradAcc = tot - gEl - gF;
        o.mult = { hl: mh, f: mf, hlRaw: g.hl };
        return o;
    }

    // ── Fluid properties ────────────────────────────────────────────
    function _lib() { var L = G.PRiSM_pvt_correlations; return (L && L.Z_dranchukAbouKassem && L.Rs_standing) ? L : null; }
    function _pc(sg) {
        if (typeof G.WTS_gaspvt_pseudoCriticals === 'function') {
            var p = G.WTS_gaspvt_pseudoCriticals(sg, 0, 0, 0);
            if (p && p.Tpc > 0 && p.Ppc > 0) return p;
        }
        var L = _lib();
        return { Tpc: L.Tpc_sutton(sg), Ppc: L.Ppc_sutton(sg) };
    }
    function _basis() {
        var B = G.WTS_baseConditions;
        var b = (B && B.resolve) ? B.resolve(60, 14.696) : null;
        return (b && _fin(b.Tb_F) && _fin(b.Pb_psia)) ? b : { Tb_F: 60, Pb_psia: 14.696 };
    }
    // Baker & Swerdloff dead oil, Beggs (1991) live-oil factor; Hough water (Beggs 1991 fit).
    function sigmaOil(api, tF, p) {
        var s68 = 39 - 0.2571 * api, s100 = 37.5 - 0.2571 * api;
        var sod = tF <= 68 ? s68 : tF >= 100 ? s100 : s68 + (tF - 68) * (s100 - s68) / 32;
        var c = 1 - 0.024 * Math.pow(Math.max(0, p), 0.45);
        return Math.max(1, sod * Math.max(0, c));
    }
    function sigmaWater(tF, p) {
        var P = Math.max(0, p);
        var s74 = 75 - 1.108 * Math.pow(P, 0.349), s280 = 53 - 0.1048 * Math.pow(P, 0.637);
        var s = tF <= 74 ? s74 : tF >= 280 ? s280 : s74 + (tF - 74) * (s280 - s74) / 206;
        return Math.max(1, s);
    }
    // fluid = {qo STB/d, qw BWPD, qg MMSCFD, api, sgg, sgw, pvt?}; p psia; t °F
    // fluid.pvt (Well Performance, WP0b; absent → the path below, unchanged):
    //   corr {rs, bo, muod, muo, z, mug}  correlation keys looked up in PRiSM_pvt_correlations as Rs_<k>, Bo_<k>, mu_oD_<k>,
    //                                     mu_o_<k>, Z_<k>, mu_g_<k> (same signatures as the Standing / Beggs-Robinson / DAK /
    //                                     Lee-Gonzalez-Eakin functions; an unknown key falls back to those)
    //   pbFactor     one-point bubble-point shift: Rs is evaluated at p·pbFactor (pbFactor = Pb_corr / Pb_user at reservoir T)
    //   undersat     true: above the bubble point (Rs(p) ≥ GOR) Bo = Bo_undersaturated and μo = mu_o_vasquezBeggs (16-pvt)
    //   mult         {rs, bo, muo, mug, z} matched multipliers (B), default 1
    //   imp          {n2, co2, h2s} mol %: Z from WTS_gaspvt_z (impurity-corrected) when it is loaded
    //   liquidNoTransfer  wet gas (D14): the liquid "oil" is condensate with Rs = 0 and a constant volume factor bc (default 1),
    //                     dead-oil viscosity; all the gas is free gas
    //   injGas       {qg_MMscfd, sg} lift gas: added to the free gas only (no dissolution), gas properties at the mixed gravity
    //   table        true | {dp psi, dT °F}: the (p, T)-dependent properties are binned (default 5 psi × 2 °F) and interpolated
    //                bilinearly; the cache lives in a WeakMap keyed by the pvt object (never on it)
    //   (A2, WP13; each absent → the path above, unchanged)
    //   sep          {psep_psig, tsep_F} passed as the 5th argument of Rs_<k> / Bo_<k> / Pb_<k> (the Vasquez-Beggs family normalises
    //                the gas gravity to a 100 psig separator with it; the other families ignore it)
    //   corr.co      undersaturated oil compressibility key co_<k> (signature of co_vasquezBeggs): above the bubble point
    //                Bo = Bob·exp(−∫ co dp from pb to p) by 6-point Gauss-Legendre; absent or 'vasquezBeggs' → Bo_undersaturated
    //   corr.sigma   gas-oil surface tension key sigma_og_<k>(API, T_F, Rs) at the in-situ Rs; absent → Baker & Swerdloff
    //   (B, WP23; each absent → the paths above, unchanged)
    //   shift        {rs, bo, muo} the additive part of the lab match y = a·y_corr + b (a = mult, default 0): Rs = max(0, a·Rs + b),
    //                Bo = a·Bo + b, μo = max(1e-4, a·μo + b); with a matched Rs (mult.rs or shift.rs) the bubble point of the
    //                undersaturated branch is the correlation's Pb at the GOR mapped back through the match, (GOR − b) / a;
    //                shift.rsPb (psia, optional) tapers the Rs shift: b·min(1, p / rsPb) (review fix v4.5: Rs at standard conditions unchanged)
    //   rv           {rows: [[p psia, Rv STB/MMscf]] ascending, pd psia} modified black oil for a wet gas (liquidNoTransfer): the
    //                vaporised condensate Rv(p) (≤ the stream CGR; = CGR at and above the dew point pd, linear to the last row
    //                below it) travels in the gas — its standard volume and mass are added with the Standing well-stream
    //                constants, so the gas gravity rises and the free liquid falls; mass is conserved exactly
    //   emul         {model 'woelflin'|'brinkman'|'table', tight 'loose'|'medium'|'tight', inv 0..1, rows [[fw, ratio]]} the liquid
    //                viscosity of an oil-water stream (WTS_flowline_emulsion); absent → the volume-weighted mixture
    var _TABS = (typeof WeakMap === 'function') ? new WeakMap() : null;
    function _pvtFn(L, prefix, key, dflt) { var f = (key && L[prefix + key]); return typeof f === 'function' ? f : dflt; }
    function _pvtCore(fluid, pv, p, t, sgMix) {
        // (p, T)-only properties for this fluid's api / sgg / sgw (and the gas gravity in use)
        var L = _lib(), c = pv.corr || {}, m = pv.mult || {};
        var api = +fluid.api, sgg = +fluid.sgg;
        var rsF = _pvtFn(L, 'Rs_', c.rs, L.Rs_standing), muodF = _pvtFn(L, 'mu_oD_', c.muod, L.mu_oD_beggsRobinson);
        var zF = _pvtFn(L, 'Z_', c.z, L.Z_dranchukAbouKassem), mugF = _pvtFn(L, 'mu_g_', c.mug, L.mu_g_leeGonzalezEakin);
        var pbF = _fin(+pv.pbFactor) && pv.pbFactor > 0 ? +pv.pbFactor : 1;
        var rsRaw = pv.liquidNoTransfer ? 0 : Math.max(0, pv.sep ? rsF(api, sgg, p * pbF, t, pv.sep) : rsF(api, sgg, p * pbF, t)) * (_fin(+m.rs) ? +m.rs : 1);
        // the Rs shift b of a lab match: with shift.rsPb (the lab bubble point, psia) it is applied as b·min(1, p / rsPb), so Rs at stock-tank
        // and separator pressures stays the correlation's (review fix v4.5); without rsPb as before (b at every pressure)
        if (pv.shift && _fin(+pv.shift.rs) && !pv.liquidNoTransfer) rsRaw = Math.max(0, rsRaw + +pv.shift.rs * ((+pv.shift.rsPb > 0) ? Math.min(1, p / +pv.shift.rsPb) : 1));
        var z = NaN, TR = t + RANK;
        var imp = pv.imp;
        if (imp && typeof G.WTS_gaspvt_z === 'function' && ((+imp.n2 || 0) + (+imp.co2 || 0) + (+imp.h2s || 0)) > 0) {
            try { var zr = G.WTS_gaspvt_z({ sg: sgMix, p: p, t: t, n2: +imp.n2 || 0, co2: +imp.co2 || 0, h2s: +imp.h2s || 0 }); if (zr && zr.ok && _fin(zr.z)) z = zr.z; } catch (e) { z = NaN; }
        }
        if (!_fin(z)) { var pc = _pc(sgMix); z = zF(TR / pc.Tpc, p / pc.Ppc); }
        z *= (_fin(+m.z) ? +m.z : 1);
        return { rsRaw: rsRaw, z: z, mug: mugF(sgMix, t, z, p) * (_fin(+m.mug) ? +m.mug : 1), bw: L.Bw_meehan(p, t), muw: L.mu_w_meehan(t, 0),
                 muod: muodF(api, t), sigO: sigmaOil(api, t, p), sigW: sigmaWater(t, p) };
    }
    function _pvtCoreTab(fluid, pv, p, t, sgMix) {
        var o = pv.table === true ? {} : pv.table, dp = (+o.dp > 0) ? +o.dp : 5, dT = (+o.dT > 0) ? +o.dT : 2;
        if (pv.rv) return _pvtCoreTabSg(fluid, pv, p, t, sgMix, dp, dT);
        var tab = _TABS.get(pv), sig = [fluid.api, fluid.sgg, sgMix, dp, dT].join('|');
        if (!tab || tab.sig !== sig) { tab = { sig: sig, map: {} }; _TABS.set(pv, tab); }
        var ip = Math.floor(p / dp), it = Math.floor(t / dT), fp = p / dp - ip, ft = t / dT - it;
        function at(a, b) {
            var k = a + ',' + b, v = tab.map[k];
            if (!v) v = tab.map[k] = _pvtCore(fluid, pv, Math.max(1, a * dp), b * dT, sgMix);
            return v;
        }
        var c00 = at(ip, it), c10 = at(ip + 1, it), c01 = at(ip, it + 1), c11 = at(ip + 1, it + 1), out = {};
        for (var k in c00) out[k] = (c00[k] * (1 - fp) + c10[k] * fp) * (1 - ft) + (c01[k] * (1 - fp) + c11[k] * fp) * ft;
        return out;
    }
    // Rv (WP23): the free-gas gravity changes with p, so the table is also binned in the gravity (0.005) and interpolated trilinearly
    function _pvtCoreTabSg(fluid, pv, p, t, sgMix, dp, dT) {
        var dS = 0.005, tab = _TABS.get(pv), sig = [fluid.api, fluid.sgg, 'rv', dp, dT].join('|');
        if (!tab || tab.sig !== sig) { tab = { sig: sig, map: {} }; _TABS.set(pv, tab); }
        var ip = Math.floor(p / dp), it = Math.floor(t / dT), is = Math.floor(sgMix / dS), fp = p / dp - ip, ft = t / dT - it, fs = sgMix / dS - is, out = {};
        function at(a, b, c) {
            var k = a + ',' + b + ',' + c, v = tab.map[k];
            if (!v) v = tab.map[k] = _pvtCore(fluid, pv, Math.max(1, a * dp), b * dT, c * dS);
            return v;
        }
        var c000 = at(ip, it, is), c100 = at(ip + 1, it, is), c010 = at(ip, it + 1, is), c110 = at(ip + 1, it + 1, is);
        var c001 = at(ip, it, is + 1), c101 = at(ip + 1, it, is + 1), c011 = at(ip, it + 1, is + 1), c111 = at(ip + 1, it + 1, is + 1);
        for (var k in c000) {
            var lo = (c000[k] * (1 - fp) + c100[k] * fp) * (1 - ft) + (c010[k] * (1 - fp) + c110[k] * fp) * ft;
            var hi = (c001[k] * (1 - fp) + c101[k] * fp) * (1 - ft) + (c011[k] * (1 - fp) + c111[k] * fp) * ft;
            out[k] = lo * (1 - fs) + hi * fs;
        }
        return out;
    }
    // Rv(p) of a modified black oil (WP23), STB/MMscf, capped at the stream CGR: the CGR at and above the dew point; between the last row
    // and the dew point linear to the CGR; inside the rows linear; below the first row its value
    function _rvAt(rv, p, cgr) {
        var rows = rv.rows || [], pd = +rv.pd, n = rows.length;
        if (!(cgr > 0)) return 0;
        if (_fin(pd) && p >= pd) return cgr;
        if (!n) return 0;
        var v;
        if (p <= rows[0][0]) v = rows[0][1];
        else if (p >= rows[n - 1][0]) {
            var a = rows[n - 1];
            v = (_fin(pd) && pd > a[0]) ? a[1] + (cgr - a[1]) * (p - a[0]) / (pd - a[0]) : a[1];
        } else {
            for (var i = 1; i < n; i++) if (p <= rows[i][0]) { var r0 = rows[i - 1], r1 = rows[i]; v = r0[1] + (r1[1] - r0[1]) * (p - r0[0]) / (r1[0] - r0[0]); break; }
        }
        return Math.max(0, Math.min(cgr, _fin(v) ? v : 0));
    }
    // the Standing well-stream constants at the base conditions: A = ρw·Vm / M_air (scf·lb/(bbl·lb)), B = ρw·Vm (scf per bbl of water-
    // equivalent mass ÷ lb-mol) — the same as WTS_wp_fluid.recombine, so moles and mass of the vaporised condensate balance exactly
    function _wsAB() { var b = _basis(), vm = R_GAS * (b.Tb_F + RANK) / b.Pb_psia, rb = 62.37 * FT3_BBL; return { A: rb * vm / MW_AIR, B: rb * vm }; }
    // Emulsion viscosity (WP23; docs/WELL-PERFORMANCE-PLAN.md §1.4 B7): the liquid viscosity of an oil-water stream at the in-situ water
    // fraction fw of the liquid. Oil-continuous below the inversion fraction inv (default 0.6), water-continuous above it.
    //   brinkman  Brinkman (1952): μ = μ_c·(1 − φ)^−2.5, φ = the dispersed fraction (capped at 0.9)
    //   woelflin  Woelflin (1942) loose / medium / tight emulsion curves (oil-continuous) as tabulated chart readings, log-linear between
    //             them — readings to verify against the published figure (owner Q9); above the inversion the Brinkman water-continuous
    //             branch
    //   table     the user's μ_em / μo against fw (0..1), log-linear, constant beyond the ends; no inversion rule
    // Returns {mu, ratio (μ / μo), cont 'oil'|'water'} or null for an unknown model.
    var WOELFLIN = { fw: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        loose: [1, 1.25, 1.65, 2.3, 3.3, 4.9, 7.4], medium: [1, 1.45, 2.2, 3.5, 5.6, 9.0, 14.5], tight: [1, 1.75, 3.1, 5.6, 10.0, 18.0, 32.0] };
    function _logInterp(xs, ys, x) {
        var n = xs.length; if (!n) return 1;
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) {
            if (n < 2 || !(ys[n - 1] > 0 && ys[n - 2] > 0) || xs[n - 1] === xs[n - 2]) return ys[n - 1];
            return ys[n - 1] * Math.pow(ys[n - 1] / ys[n - 2], (x - xs[n - 1]) / (xs[n - 1] - xs[n - 2]));
        }
        for (var i = 1; i < n; i++) if (x <= xs[i]) {
            var y0 = ys[i - 1], y1 = ys[i], f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
            return (y0 > 0 && y1 > 0) ? y0 * Math.pow(y1 / y0, f) : y0 + (y1 - y0) * f;
        }
        return ys[n - 1];
    }
    function emulsion(fw, muo, muw, e) {
        e = e || {};
        fw = Math.max(0, Math.min(1, +fw || 0)); muo = +muo; muw = +muw;
        if (!(muo > 0) || !(muw > 0)) return null;
        var inv = _fin(+e.inv) && +e.inv > 0.05 && +e.inv < 0.95 ? +e.inv : 0.6, m = e.model;
        var brink = function (muc, phi) { return muc * Math.pow(1 - Math.min(0.9, Math.max(0, phi)), -2.5); };
        if (m === 'table') {
            var rows = (Array.isArray(e.rows) ? e.rows : []).filter(function (r) { return Array.isArray(r) && _fin(+r[0]) && _fin(+r[1]) && +r[1] > 0; })
                .map(function (r) { return [+r[0], +r[1]]; }).sort(function (a, b) { return a[0] - b[0]; });
            if (!rows.length) return null;
            var rt = _logInterp(rows.map(function (r) { return r[0]; }), rows.map(function (r) { return r[1]; }), fw);
            // constant beyond the last row (a user table is not extrapolated)
            if (fw > rows[rows.length - 1][0]) rt = rows[rows.length - 1][1];
            return { mu: muo * rt, ratio: rt, cont: 'table' };
        }
        if (m !== 'woelflin' && m !== 'brinkman') return null;
        if (fw >= inv) { var mw = brink(muw, 1 - fw); return { mu: mw, ratio: mw / muo, cont: 'water' }; }
        if (m === 'brinkman') { var mb = brink(muo, fw); return { mu: mb, ratio: mb / muo, cont: 'oil' }; }
        var curve = WOELFLIN[e.tight === 'loose' || e.tight === 'tight' ? e.tight : 'medium'], r = _logInterp(WOELFLIN.fw, curve, fw);
        return { mu: muo * r, ratio: r, cont: 'oil' };
    }
    function _propsPvt(fluid, p, t) {
        var L = _lib(), pv = fluid.pvt, c = pv.corr || {}, m = pv.mult || {};
        var f = fluid, qo = Math.max(0, +f.qo || 0), qw = Math.max(0, +f.qw || 0), qg = Math.max(0, +f.qg || 0);
        var api = +f.api, sgg = +f.sgg, sgw = +f.sgw;
        var inj = pv.injGas && +pv.injGas.qg_MMscfd > 0 ? { q: +pv.injGas.qg_MMscfd * 1e6, sg: +pv.injGas.sg > 0 ? +pv.injGas.sg : sgg } : null;
        var gor = qo > 0 ? qg * 1e6 / qo : 0;
        var go = 141.5 / (131.5 + api);
        var noTr = !!pv.liquidNoTransfer;
        // the gas gravity of the free gas: formation free gas mixed with lift gas (mass weighted by standard volume)
        var sgMix = sgg;
        if (inj) {
            var rs0 = noTr || !(qo > 0) ? 0 : Math.min(gor, Math.max(0, _pvtFn(L, 'Rs_', c.rs, L.Rs_standing)(api, sgg, p * ((+pv.pbFactor > 0) ? +pv.pbFactor : 1), t, pv.sep)));
            var fr0 = Math.max(0, qg * 1e6 - qo * rs0);
            sgMix = (fr0 + inj.q) > 0 ? (fr0 * sgg + inj.q * inj.sg) / (fr0 + inj.q) : sgg;
        }
        // modified black oil (WP23): the vaporised condensate travels in the gas (standard volume B·γo/Mo per STB, mass A·γo per STB)
        var vap = 0, vapScf = 0;
        if (noTr && pv.rv && qo > 0 && qg > 0) {
            var cgrT = qo / qg, rvp = _rvAt(pv.rv, p, cgrT), AB = _wsAB(), mo = 5954 / Math.max(1, api - 8.811);
            vap = Math.min(qo, qg * rvp); vapScf = vap * AB.B * go / mo;
            var gasScf = qg * 1e6;
            sgMix = (gasScf * sgMix + vap * AB.A * go) / (gasScf + vapScf);
        }
        var C = (pv.table && _TABS) ? _pvtCoreTab(f, pv, p, t, sgMix) : _pvtCore(f, pv, p, t, sgMix);
        var rs = (qo > 0 && !noTr) ? Math.min(gor, C.rsRaw) : 0;
        var boF = _pvtFn(L, 'Bo_', c.bo, L.Bo_standing), muoF = _pvtFn(L, 'mu_o_', c.muo, L.mu_o_beggsRobinson);
        var bo, muo, pb = null;
        if (!(qo > 0)) { bo = 1; muo = 0; }
        else if (noTr) { bo = (+pv.bc > 0 ? +pv.bc : 1); muo = C.muod; }
        else {
            bo = pv.sep ? boF(api, sgg, rs, t, pv.sep) : boF(api, sgg, rs, t); muo = muoF(C.muod, rs);
            if (pv.undersat && C.rsRaw >= gor && gor > 0) {
                pb = _pbFor(L, c, api, sgg, _gorCorr(pv, gor), t, pv.pbFactor, pv.sep);
                if (_fin(pb) && p > pb) {
                    var coF = (c.co && c.co !== 'vasquezBeggs') ? L['co_' + c.co] : null;
                    // the Vasquez-Beggs co (Bo_undersaturated) is defined on the 100 psig separator gas gravity, like Rs / Bo / Pb
                    // of the family: with pv.sep the gravity is normalised the same way (review fix; no pv.sep → unchanged)
                    var sgCo = sgg;
                    if (typeof coF !== 'function' && pv.sep && typeof L.sg_gas100_vasquezBeggs === 'function') {
                        var g100 = L.sg_gas100_vasquezBeggs(sgg, api, +pv.sep.tsep_F, +pv.sep.psep_psig);
                        if (_fin(g100) && g100 > 0) sgCo = g100;
                    }
                    bo = typeof coF === 'function' ? _boCoInt(coF, bo, api, sgg, rs, p, t, pb) : L.Bo_undersaturated(bo, api, sgCo, rs, p, t, pb);
                    muo = L.mu_o_vasquezBeggs(muo, p, pb);
                }
            }
        }
        bo *= (_fin(+m.bo) ? +m.bo : 1); muo *= (_fin(+m.muo) ? +m.muo : 1);
        if (pv.shift && qo > 0 && !noTr) {
            if (_fin(+pv.shift.bo)) bo = Math.max(0.5, bo + +pv.shift.bo);
            if (_fin(+pv.shift.muo)) muo = Math.max(1e-4, muo + +pv.shift.muo);
        }
        var z = C.z, TR = t + RANK, mug = C.mug, bw = C.bw, muw = C.muw;
        var b = _basis();
        var bg = b.Pb_psia * z * TR / ((b.Tb_F + RANK) * p);          // ft³/scf
        var rhoG = p * MW_AIR * sgMix / (z * R_GAS * TR);
        var rhoO = (62.37 * go + 0.01361 * rs * sgg) / bo;
        var rhoW = RHO_W * sgw / bw;
        var qoR = (qo - vap) * bo * FT3_BBL / 86400, qwR = qw * bw * FT3_BBL / 86400;
        var free = Math.max(0, qg * 1e6 - qo * rs) + vapScf + (inj ? inj.q : 0);
        var qgR = free * bg / 86400;
        var qL = qoR + qwR, fo = qL > 0 ? qoR / qL : 0, fw = qL > 0 ? qwR / qL : 0;
        var sgF = c.sigma ? L['sigma_og_' + c.sigma] : null;
        var so = qo > 0 ? (typeof sgF === 'function' ? Math.max(1, sgF(api, t, rs)) : C.sigO) : 0, sw = qw > 0 ? C.sigW : 0;
        var muL = qL > 0 ? fo * muo + fw * muw : (muo || muw), em = null;
        if (pv.emul && qoR > 0 && qwR > 0) { em = emulsion(fw, muo, muw, pv.emul); if (em && _fin(em.mu)) muL = em.mu; else em = null; }
        var out = {
            p: p, t: t, gor: gor, rs: rs, bo: bo, bw: bw, z: z, bg: bg, muo: muo, muw: muw, mug: mug,
            rhoO: rhoO, rhoW: rhoW, rhoG: rhoG, sigO: so, sigW: sw, freeGas: free,
            qL: qL, qG: qgR, fo: fo, fw: fw,
            rhoL: qL > 0 ? fo * rhoO + fw * rhoW : rhoO || rhoW,
            muL: muL,
            sigL: qL > 0 ? fo * so + fw * sw : (so || sw || 30),
            pb: pb, sgGas: sgMix, pvt: true
        };
        if (pv.rv) { out.qoVap = vap; out.qoFree = Math.max(0, qo - vap); }
        if (em) { out.emulRatio = em.ratio; out.emulCont = em.cont; }
        return out;
    }
    // the GOR seen by the correlation when Rs is matched (WP23): Rs_m = a·Rs_c + b reaches the GOR where Rs_c = (GOR − b) / a
    // review fix (v4.5): only for a lab match (pvt.matchRs, or a shift.rs) — a plain mult.rs keeps the A2 bubble point bit for bit
    function _gorCorr(pv, gor) {
        if (!pv.matchRs && !(pv.shift && _fin(+pv.shift.rs) && +pv.shift.rs !== 0)) return gor;
        var m = pv.mult || {}, a = _fin(+m.rs) && +m.rs > 0 ? +m.rs : 1, b = pv.shift && _fin(+pv.shift.rs) ? +pv.shift.rs : 0;
        if (a === 1 && b === 0) return gor;
        return Math.max(1e-6, (gor - b) / a);
    }
    // bubble point for the undersaturated branch: Pb_<rs key> when the library has it, else bisection on Rs(p) = GOR
    function _pbFor(L, c, api, sgg, gor, t, pbFactor, sep) {
        var k = c.rs || 'standing', f = L['Pb_' + k], pf = (_fin(+pbFactor) && pbFactor > 0) ? +pbFactor : 1;
        if (typeof f === 'function') { var v = sep ? f(api, sgg, gor, t, sep) : f(api, sgg, gor, t); if (_fin(v) && v > 0) return v / pf; }
        var rsF = _pvtFn(L, 'Rs_', k, L.Rs_standing), lo = 14.7, hi = 30000;
        if (!(rsF(api, sgg, hi * pf, t, sep) >= gor)) return NaN;
        for (var i = 0; i < 80 && hi - lo > 1e-6 * hi; i++) { var mid = (lo + hi) / 2; if (rsF(api, sgg, mid * pf, t, sep) >= gor) hi = mid; else lo = mid; }
        return hi;
    }
    // undersaturated Bo from a compressibility correlation (WP13 corr.co): Bo = Bob·exp(−∫ co dp, pb → p), 6-point Gauss-Legendre
    var GL6 = [[-0.9324695142031521, 0.1713244923791704], [-0.6612093864662645, 0.3607615730481386], [-0.2386191860831909, 0.4679139345726910],
               [0.2386191860831909, 0.4679139345726910], [0.6612093864662645, 0.3607615730481386], [0.9324695142031521, 0.1713244923791704]];
    function _boCoInt(coF, bob, api, sgg, rsb, p, t, pb) {
        var h = (p - pb) / 2, m = (p + pb) / 2, s = 0;
        for (var i = 0; i < 6; i++) { var c = coF(api, sgg, rsb, m + h * GL6[i][0], t); if (!_fin(c)) return bob; s += GL6[i][1] * c; }
        return bob * Math.exp(-s * h);
    }
    function props(fluid, p, t) {
        if (fluid && fluid.pvt && typeof fluid.pvt === 'object') return _propsPvt(fluid, p, t);
        var L = _lib();
        var f = fluid || {}, qo = Math.max(0, +f.qo || 0), qw = Math.max(0, +f.qw || 0), qg = Math.max(0, +f.qg || 0);
        var api = +f.api, sgg = +f.sgg, sgw = +f.sgw;
        var gor = qo > 0 ? qg * 1e6 / qo : 0;
        var go = 141.5 / (131.5 + api);
        var rs = qo > 0 ? Math.min(gor, Math.max(0, L.Rs_standing(api, sgg, p, t))) : 0;
        var bo = qo > 0 ? L.Bo_standing(api, sgg, rs, t) : 1;
        var muo = qo > 0 ? L.mu_o_beggsRobinson(L.mu_oD_beggsRobinson(api, t), rs) : 0;
        var bw = L.Bw_meehan(p, t), muw = L.mu_w_meehan(t, 0);
        var pc = _pc(sgg), TR = t + RANK;
        var z = L.Z_dranchukAbouKassem(TR / pc.Tpc, p / pc.Ppc);
        var mug = L.mu_g_leeGonzalezEakin(sgg, t, z, p);
        var b = _basis();
        var bg = b.Pb_psia * z * TR / ((b.Tb_F + RANK) * p);          // ft³/scf
        var rhoG = p * MW_AIR * sgg / (z * R_GAS * TR);
        var rhoO = (62.37 * go + 0.01361 * rs * sgg) / bo;
        var rhoW = RHO_W * sgw / bw;
        var qoR = qo * bo * FT3_BBL / 86400, qwR = qw * bw * FT3_BBL / 86400;    // ft³/s in situ
        var free = Math.max(0, qg * 1e6 - qo * rs);                              // scf/d
        var qgR = free * bg / 86400;
        var qL = qoR + qwR, fo = qL > 0 ? qoR / qL : 0, fw = qL > 0 ? qwR / qL : 0;
        var so = qo > 0 ? sigmaOil(api, t, p) : 0, sw = qw > 0 ? sigmaWater(t, p) : 0;
        return {
            p: p, t: t, gor: gor, rs: rs, bo: bo, bw: bw, z: z, bg: bg, muo: muo, muw: muw, mug: mug,
            rhoO: rhoO, rhoW: rhoW, rhoG: rhoG, sigO: so, sigW: sw, freeGas: free,
            qL: qL, qG: qgR, fo: fo, fw: fw,
            rhoL: qL > 0 ? fo * rhoO + fw * rhoW : rhoO || rhoW,
            muL: qL > 0 ? fo * muo + fw * muw : (muo || muw),
            sigL: qL > 0 ? fo * so + fw * sw : (so || sw || 30)
        };
    }

    // ── Route marching ───────────────────────────────────────────────
    function _steps(len, stepFt) { return Math.min(400, Math.max(10, Math.ceil(len / (stepFt > 0 ? stepFt : 50)))); }
    // Coupled temperature step (opt.heat): the line-heat model of 49-calc-lineheat.js over dx at the
    // step's inlet temperature, T_out = Ta + (T_in − Ta)·exp(−UA'·dx/(ṁ·cp)), then Joule–Thomson
    // cooling μJT·Δp for the step's pressure drop (enthalpy balance of a throttled stream, as the
    // line-heat page applies at chokes; potential/kinetic energy terms neglected).
    function _heatStep(h, s, T, dx, dp) {
        var seg = _thermSeg(h, s), u = G.WTS_lineheat_ua(seg, T, h.env);
        return u.ta + (T - u.ta) * Math.exp(-u.ua * dx / h.mcp) - h.jt * dp;
    }
    function _thermSeg(h, s) {
        if (s._therm) return s._therm;
        var od = s.id + 2 * h.wall;
        s._therm = { di: s.id, od: od, ds: od + 2 * h.ins, type: h.ins > 0 ? 'ins' : 'bare', depth: NaN };
        return s._therm;
    }
    // Beggs & Brill gradient with the fluid properties at (p psia, t °F) in segment s.
    function _gAt(fluid, pp, tt, s, opt) {
        var pr = props(fluid, pp, tt), A = (s.area > 0) ? s.area / 144 : Math.PI * Math.pow(s.id / 12, 2) / 4;
        var inp = {
            vsl: pr.qL / A, vsg: pr.qG / A, d: s.id, rhoL: pr.rhoL, rhoG: pr.rhoG, muL: pr.muL, muG: pr.mug,
            sigma: pr.sigL, theta: s.theta, rough: opt.rough, p: pp, payne: opt.payne, accel: opt.accel
        };
        var E = null, g, ck = (s.corr != null) ? s.corr : opt.corr;          // segment.corr (v4.5 WP21): a per-segment registry key
        if (ck != null) { E = _corrOf(ck); inp.props = pr; inp.mult = opt.mult || null; g = E.grad(inp); }
        else g = bb(inp);
        if (opt.mult) g = _applyMult(g, inp, opt.mult, E || CORR.bb);
        g.props = pr;
        return g;
    }
    // Pressure (psia) at which Ek falls to `target` (Ek decreases with pressure: v ∝ 1/p, ρ ∝ p).
    // Infinity when it would lie above cap (psia), NaN when it cannot be bracketed.
    function _raiseEk(fluid, P, T, s, opt, target, cap) {
        var lo = P, hi = P * 1.25, n = 0;
        while (_gAt(fluid, hi, T, s, opt).Ek >= target) {
            lo = hi; hi *= 1.25;
            if (cap && lo > cap) return Infinity;
            if (++n > 80) return NaN;
        }
        for (var k = 0; k < 60 && hi / lo - 1 > 1e-9; k++) {
            var mid = Math.sqrt(lo * hi);
            if (_gAt(fluid, mid, T, s, opt).Ek >= target) lo = mid; else hi = mid;
        }
        return (cap && hi > cap) ? Infinity : hi;
    }
    // opt: {rough, payne, accel, reverse, heat (coupled P–T, forward only), tAt (x → °F along the march),
    //       refine (split steps with > 3 % pressure change), chokeRaise (reverse only: choked-exit pressure),
    //       pMax (psia: the march stops, lost 'high', when the pressure would pass it)}
    function march(route, fluid, p0g, t0, t1, opt) {
        if (opt.corr != null && !_corrOf(opt.corr)) return { ok: false, code: 'UNKNOWN_CORR', corr: String(opt.corr), errors: ['unknown correlation key ' + String(opt.corr).slice(0, 40)] };
        var segs = route.segments, total = 0;
        for (var ks = 0; ks < segs.length; ks++) if (segs[ks].corr != null && !_corrOf(segs[ks].corr)) return { ok: false, code: 'UNKNOWN_CORR', corr: String(segs[ks].corr), errors: ['unknown correlation key ' + String(segs[ks].corr).slice(0, 40)] };
        var gridIn = (opt.grid && typeof opt.grid === 'object' && Array.isArray(opt.grid.segs) && opt.grid.segs.length === segs.length) ? opt.grid : null;
        var gridOut = opt.grid ? { v: 1, segs: [] } : null;
        var eroC = (opt.eroC > 0) ? opt.eroC : 100;
        segs.forEach(function (s) { total += s.len; });
        var P = p0g + PATM, x = 0, out = [], profile = [], lost = null, chokes = [];
        var first = null, heat = opt.heat || null, Tc = t0, sgn = opt.reverse ? -1 : 1, tFn = opt.tAt || null;
        function pt(xx) { return heat ? Tc : tFn ? tFn(xx) : (total > 0 ? t0 + (t1 - t0) * xx / total : t0); }
        function gAt(pp, tt, s) { return _gAt(fluid, pp, tt, s, opt); }
        // One step of length dx: predictor at (P, T), then 3 passes at the mid pressure / temperature.
        function step(s, r, k, dx, g0) {
            var ta = pt(x), tb = heat ? _heatStep(heat, s, ta, dx, 0) : pt(x + dx), tm = (ta + tb) / 2;
            var g = g0 || gAt(P, ta, s);
            if (!r.in) { r.hlIn = g.hl; r.in = g; if (!first) first = g; }
            var P2 = P - sgn * g.grad * dx;
            for (var it = 0; it < 3; it++) {
                if (heat && _fin(P2)) { tb = _heatStep(heat, s, ta, dx, sgn * (P - Math.max(P2, PATM))); tm = (ta + tb) / 2; }
                var pm = (P + Math.max(P2, 1)) / 2, Pp = P2;
                g = gAt(pm, tm, s);
                P2 = P - sgn * g.grad * dx;
                if (opt.refine && !heat && it > 0 && Math.abs(P2 - Pp) < 1e-7 * P) break;   // converged (page routes only)
            }
            if (heat && _fin(P2)) tb = _heatStep(heat, s, ta, dx, sgn * (P - Math.max(P2, PATM)));
            if (!_fin(P2) || P2 < PATM || g.Ek >= EK_LOST || (opt.pMax && P2 > opt.pMax)) {
                lost = { seg: k, x: x, reason: g.Ek >= EK_LOST ? 'critical' : (opt.pMax && P2 > opt.pMax) ? 'high' : 'pressure' };
                return false;
            }
            r.dpEl += g.gradEl * dx; r.dpF += g.gradF * dx; r.dpAcc += g.gradAcc * dx;
            if (r.patterns.indexOf(g.pattern) === -1) r.patterns.push(g.pattern);
            r.hlOut = g.hl; r.out = g;
            if (g.vm > r.vmMax) r.vmMax = g.vm;
            var ve = g.rhoN > 0 ? eroC / Math.sqrt(g.rhoN) : Infinity;      // API RP 14E, C = 100 unless opt.eroC
            if (g.vm / ve > r.eroMax) r.eroMax = g.vm / ve;
            P = P2; x += dx; Tc = tb;
            if (opt.detail) profile.push({ x: x, p: P - PATM, t: tb, hl: g.hl, pattern: g.pattern, seg: k, vm: g.vm, vsl: g.vsl, vsg: g.vsg,
                rhoS: g.rhoS, gradEl: g.gradEl, gradF: g.gradF, gradAcc: g.gradAcc, ero: g.vm / ve });
            else profile.push({ x: x, p: P - PATM, t: tb, hl: g.hl, pattern: g.pattern });
            return true;
        }
        // restriction loss Δp = K·ρ_n·v²/(2·g_c·144) at the bore velocity (homogeneous, §4.5)
        function _restr(s, r, k) {
            var d = +s.restr.d, Tx = pt(x);
            if (!(d > 0) || !(s.id > 0)) return;
            var g = gAt(P, Tx, s), beta = Math.min(1, d / s.id), b2 = beta * beta;
            var K = (s.restr.k != null && _fin(+s.restr.k)) ? +s.restr.k : 0.5 * (1 - b2) + (1 - b2) * (1 - b2);
            var Ac = (s.area > 0) ? s.area : Math.PI * s.id * s.id / 4, v = g.vm * Ac / (Math.PI * d * d / 4);
            var dp = K * g.rhoN * v * v / (2 * GC * 144);
            var P2 = P - sgn * dp;
            if (!_fin(P2) || P2 < PATM || (opt.pMax && P2 > opt.pMax)) { lost = { seg: k, x: x, reason: (opt.pMax && P2 > opt.pMax) ? 'high' : 'pressure' }; return; }
            P = P2; r.dpRestr = (r.dpRestr || 0) + dp; r.restr = { d: d, beta: beta, K: K, v: v };
            profile.push(opt.detail ? { x: x, p: P - PATM, t: Tx, seg: k, restr: true, dp: dp } : { x: x, p: P - PATM, t: Tx });
        }
        var tStart = pt(0);
        profile.push({ x: 0, p: P - PATM, t: tStart });
        for (var k = 0; k < segs.length && !lost; k++) {
            var s = segs[k];
            s.theta = s.len > 0 ? Math.asin(Math.max(-1, Math.min(1, s.dz / s.len))) * 180 / Math.PI : 0;
            var pSegOut = P, dpNear = 0;
            if (opt.chokeRaise && sgn < 0) {
                // Marching against the flow, P here is this segment's outlet pressure. Ek ≥ 1 there: the
                // segment chokes (isothermal limit, gas velocity √(ZRT/M)) and its outlet sits at the pressure
                // where Ek = 1 (a pressure step down to P outside the segment). Ek ≥ 0.9: the last ~0.1 ft,
                // where 1/(1 − Ek) is near-singular, is taken in one step to the pressure where Ek = 0.9
                // (booked as acceleration; its length, ≈ D·[(1 − M²)/M² + ln M²]/f for M² = 0.9, is neglected).
                var Tx = pt(x), gc0 = gAt(P, Tx, s), cap = opt.pMax || 0;
                if (gc0.Ek >= EK_CRIT) {
                    var Ps = _raiseEk(fluid, P, Tx, s, opt, EK_CRIT, cap);
                    if (!_fin(Ps)) lost = { seg: k, x: x, reason: Ps === Infinity ? 'high' : 'critical' };
                    else {
                        chokes.push({ seg: k, x: x, pBefore: P - PATM, pAfter: Ps - PATM, ek: gc0.Ek });
                        P = Ps; pSegOut = P;
                        profile.push({ x: x, p: P - PATM, t: Tx });
                    }
                }
                if (!lost && gc0.Ek >= EK_NEAR) {
                    var Pn = _raiseEk(fluid, P, Tx, s, opt, EK_NEAR, cap);
                    if (!_fin(Pn)) lost = { seg: k, x: x, reason: Pn === Infinity ? 'high' : 'critical' };
                    else if (Pn > P) { dpNear = Pn - P; P = Pn; profile.push({ x: x, p: P - PATM, t: Tx }); }
                }
            }
            var gs = gridIn ? gridIn.segs[k] : null;
            var n = (gs && gs.n > 0) ? gs.n : _steps(s.len, opt.stepFt), dx = s.len / n;
            var gso = gridOut ? { n: n, m: [] } : null;
            if (gso) gridOut.segs.push(gso);
            var r = { name: s.name, len: s.len, id: s.id, dz: s.dz, theta: s.theta, pIn: pSegOut - PATM, tIn: pt(x),
                dpEl: 0, dpF: 0, dpAcc: dpNear, patterns: [], hlIn: null, hlOut: null, vmMax: 0, eroMax: 0 };
            // a restriction at the segment's flow inlet: before the segment when marching with the flow, after it against the flow
            if (s.restr && !lost && sgn > 0) _restr(s, r, k);
            for (var j = 0; j < n && !lost; j++) {
                var m = 1, gp = null;
                if (gs && gs.m && gs.m[j] > 0) m = gs.m[j];
                else if (opt.refine && !heat) {
                    gp = gAt(P, pt(x), s);
                    var dPp = Math.abs(gp.grad * dx);
                    if (_fin(dPp) && gp.Ek < EK_LOST) m = Math.min(MAX_SUB, Math.max(1, Math.ceil(dPp / (REFINE * P))));
                }
                if (gso) gso.m.push(m);
                for (var q = 0; q < m; q++) if (!step(s, r, k, dx / m, q === 0 ? gp : null)) break;
            }
            if (s.restr && !lost && sgn < 0) _restr(s, r, k);
            r.pOut = lost ? null : P - PATM;
            r.dp = lost ? null : r.pIn - r.pOut;
            r.tOut = pt(x);
            out.push(r);
        }
        var res = { segments: out, profile: profile, pIn: p0g, pOut: lost ? null : P - PATM, dp: lost ? null : p0g - (P - PATM),
            length: total, lost: lost, inlet: first, tIn: tStart, tOut: lost ? null : pt(x), coupled: !!heat, chokes: chokes };
        if (gridOut) res.grid = gridIn || gridOut;
        return res;
    }

    function _segCopy(list) { return list.map(function (q) { return { name: q.name, len: q.len, id: q.id, dz: q.dz }; }); }
    function _len(list) { var L = 0; list.forEach(function (s) { L += s.len; }); return L; }
    function _constT(t) { return function () { return t; }; }
    // Temperature (or, key 'p', pressure) along a forward profile, linear between points (x ascending;
    // repeated x allowed).
    function _interpT(profile, key) {
        var xs = profile.map(function (q) { return q.x; }), ts = profile.map(function (q) { return q[key || 't']; }), n = xs.length;
        return function (x) {
            if (!(n > 1) || x <= xs[0]) return ts[0];
            if (x >= xs[n - 1]) return ts[n - 1];
            var lo = 0, hi = n - 1;
            while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
            var d = xs[hi] - xs[lo];
            return d > 0 ? ts[lo] + (ts[hi] - ts[lo]) * (x - xs[lo]) / d : ts[hi];
        };
    }
    // Adiabatic flare line (linear model): T(x) = T_h(p(x)) on the isenthalpic curve from the separator,
    // shifted to tOut at the PCV outlet, with p(x) from the backward-march result r (flow order; at and past
    // the pipe exit the exit pressure, which is above the tip back-pressure when the line chokes).
    function _tAlong(curve, r, tOut) {
        var L = r.length, pExit = r.pOut, pOf = _interpT(r.profile, 'p'), base = curve(r.pIn + PATM);
        return function (x) { return tOut + curve((x >= L ? pExit : pOf(x)) + PATM) - base; };
    }
    // March a route (segments in flow order) BACKWARDS from the known pressure at its outlet, pEndG psig,
    // with the temperature tFlow(x) at distance x from the route inlet; the result is presented in the
    // flow direction (segment inlet → outlet, profile x from the route inlet).
    function _back(segsFlow, fluid, pEndG, tFlow, opt) {
        var L = _len(segsFlow), nS = segsFlow.length, rev = _segCopy(segsFlow).reverse();
        var m = march({ segments: rev }, fluid, pEndG, NaN, NaN, Object.assign({}, opt, {
            reverse: true, heat: null, tAt: function (xm) { return tFlow(Math.max(0, L - xm)); } }));
        var segs = [];
        for (var i = 0; i < nS; i++) {
            var r = m.segments[nS - 1 - i], f = segsFlow[i];
            if (!r) {                                    // not reached (the march stopped downstream)
                segs.push({ name: f.name, len: f.len, id: f.id, dz: f.dz, theta: null, pIn: null, pOut: null, tIn: null, tOut: null,
                    dpEl: null, dpF: null, dpAcc: null, dp: null, patterns: [], hlIn: null, hlOut: null, vmMax: null, eroMax: null, skipped: true });
                continue;
            }
            segs.push({ name: r.name, len: r.len, id: r.id, dz: r.dz, theta: r.theta,
                pIn: r.pOut, pOut: r.pIn, tIn: r.tOut, tOut: r.tIn, dpEl: r.dpEl, dpF: r.dpF, dpAcc: r.dpAcc,
                dp: r.pOut == null ? null : r.pOut - r.pIn, patterns: r.patterns.slice().reverse(),
                hlIn: r.hlOut, hlOut: r.hlIn, in: r.out, out: r.in, vmMax: r.vmMax, eroMax: r.eroMax });
        }
        var profile = m.profile.map(function (q) { return { x: L - q.x, p: q.p, t: q.t, hl: q.hl, pattern: q.pattern }; }).reverse();
        var pIn = m.pOut, pOut = segs.length && segs[nS - 1].pOut != null ? segs[nS - 1].pOut : pEndG;
        var inlet = null;
        if (pIn != null && rev[nS - 1] && rev[nS - 1].theta != null) inlet = _gAt(fluid, pIn + PATM, tFlow(0), rev[nS - 1], opt);
        return {
            segments: segs, profile: profile, length: L, reverse: true, coupled: false,
            pIn: pIn, pOut: pOut, pEnd: pEndG, dp: pIn == null ? null : pIn - pOut,
            lost: m.lost ? { seg: nS - 1 - m.lost.seg, x: L - m.lost.x, reason: m.lost.reason } : null,
            chokes: m.chokes.map(function (c) { return { seg: nS - 1 - c.seg, x: L - c.x, pUp: c.pAfter, pDown: c.pBefore }; }),
            inlet: inlet, tIn: tFlow(0), tOut: tFlow(L)
        };
    }

    // ── Gas PCV and flare-line helpers ───────────────────────────────
    function _kIdeal(sgg, tF) {
        var k = (typeof G.WTS_gaspvt_k === 'function') ? G.WTS_gaspvt_k(sgg, tF, 0, 0, 0) : NaN;
        return (_fin(k) && k > 1) ? k : 1.27;
    }
    function _critRatio(k) {
        var f = G.WTS_chokeperf_criticalRatio;
        var r = (typeof f === 'function') ? f(k) : NaN;
        return _fin(r) ? r : Math.pow(2 / (k + 1), k / (k - 1));
    }
    function _gasState(sgg, pA, tF) {
        var S = G.WTS_gaspvt_state;
        return (typeof S === 'function' && _fin(tF) && tF > -150) ? S(sgg, pA, tF, 0, 0, 0) : null;
    }
    function _jtAt(sgg, pA, tF) {
        var s = _gasState(sgg, pA, tF);
        return (s && _fin(s.muJT)) ? { mu: s.muJT, real: true } : { mu: MUJT_RULE, real: false };
    }
    // Isenthalpic (throttling) expansion of the gas from p1 to p2 psia: dT/dp = μJT(p, T), Heun's method.
    function isenthalp(sgg, p1a, t1, p2a) {
        if (!(p2a < p1a)) return { t: t1, dT: 0, mu: null, real: null, n: 0 };
        var n = Math.min(10, Math.max(3, Math.ceil((p1a - p2a) / 100))), h = (p2a - p1a) / n, T = t1, p = p1a, real = true;
        for (var k = 0; k < n; k++) {
            var a = _jtAt(sgg, p, T), b = _jtAt(sgg, p + h, T + h * a.mu);
            real = real && a.real && b.real;
            T += h * (a.mu + b.mu) / 2; p += h;
        }
        return { t: T, dT: t1 - T, mu: (t1 - T) / (p1a - p2a), real: real, n: n };
    }
    // The same expansion tabulated from p1a down to p2a psia (Heun, ≤ 50 psi steps): pa → T °F, linear
    // between nodes, extended along the end slopes (T = t1 at and above p1a).
    function _isenthCurve(sgg, p1a, t1, p2a) {
        if (!(p2a < p1a)) return function () { return t1; };
        var n = Math.min(40, Math.max(6, Math.ceil((p1a - p2a) / 50))), h = (p2a - p1a) / n;
        var ps = [p1a], ts = [t1], T = t1, p = p1a;
        for (var k = 0; k < n; k++) {
            var a = _jtAt(sgg, p, T), b = _jtAt(sgg, p + h, T + h * a.mu);
            T += h * (a.mu + b.mu) / 2; p += h; ps.push(p); ts.push(T);
        }
        return function (pa) {
            if (!(pa < ps[0])) return ts[0];
            var lo = 0, hi = n;
            if (pa <= ps[n]) lo = n - 1;
            else while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ps[mid] > pa) lo = mid; else hi = mid; }
            return ts[lo] + (ts[lo + 1] - ts[lo]) * (pa - ps[lo]) / (ps[lo + 1] - ps[lo]);
        };
    }
    // Gas velocity, speed of sound, Mach and ρv² at (pG psig, tF) in segment s.
    function _gasPoint(fluid, s, pG, tF) {
        var pA = pG + PATM, pr = props(fluid, pA, tF), A = Math.PI * Math.pow(s.id / 12, 2) / 4;
        var v = pr.qG / A, st = _gasState(fluid.sgg, pA, tF);
        var c = (st && _fin(st.c)) ? st.c : Math.sqrt(_kIdeal(fluid.sgg, tF) * GC * pr.z * R_FT_LBF * (tF + RANK) / (MW_AIR * fluid.sgg));
        return { v: v, c: c, mach: v / c, rv2: pr.rhoG * v * v, rho: pr.rhoG, real: !!st };
    }

    var PAT_NAME = { segregated: 'Segregated', transition: 'Transition', intermittent: 'Intermittent', distributed: 'Distributed',
        gas: 'Single-phase gas', liquid: 'Single-phase liquid', none: 'No flow' };

    // input = {qo, qw, qg, api, sgg, sgw, pwh psig (wellhead, upstream of the choke), t0 (line inlet,
    //          downstream of the choke), t1 °F (arrival), psep psig (held by the gas PCV), rough in, payne, accel,
    //          well: [{name,len,id,dz}] (choke outlet → separator), flare: [{name,len,id,dz}] (PCV outlet → tip),
    //          dptip psi (flare tip drop, default 1.5), mdmt °F (default −20), psvset psig (default 1440;
    //          '' / NaN = no PSV check), xt (gas PCV pressure differential ratio factor, default 0.7),
    //          tmode 'linear' (default: T linear t0 → t1) | 'heat' (coupled P–T march; t1 ignored) with
    //          tair °F, wind mph, eps, wall in, ins in (0 = bare), kp, kins Btu/hr·ft·°F, cpo, cpw, cpg Btu/lb·°F,
    //          jt °F/psi}
    // Inputs missing from an older saved page (undefined) take their defaults.
    function compute(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        function dflt(k) { var v = i[k]; return v === undefined ? DEF[k] : ((v === '' || v === null) ? NaN : +v); }
        var qo = +i.qo, qw = +i.qw, qg = +i.qg, api = +i.api, sgg = +i.sgg, sgw = +i.sgw;
        var pwh = +i.pwh, t0 = +i.t0, t1 = +i.t1, psep = +i.psep, rough = +i.rough;
        var dptip = dflt('dptip'), mdmt = dflt('mdmt'), xt = dflt('xt');
        var psvset = i.psvset === undefined ? DEF.psvset : ((i.psvset === '' || i.psvset === null || (typeof i.psvset === 'number' && isNaN(i.psvset))) ? null : +i.psvset);
        var rOk = need(_fin(qo) && qo >= 0 && qo <= 200000, 'qo', 'Oil rate must be between 0 and 200,000 STB/d.');
        rOk = need(_fin(qw) && qw >= 0 && qw <= 200000, 'qw', 'Water rate must be between 0 and 200,000 BWPD.') && rOk;
        rOk = need(_fin(qg) && qg >= 0 && qg <= 500, 'qg', 'Gas rate must be between 0 and 500 MMSCFD.') && rOk;
        if (rOk) need(qo + qw + qg > 0, 'qo', 'Enter at least one non-zero rate.');
        need(_fin(api) && api >= 10 && api <= 70, 'api', 'Oil gravity must be between 10 and 70 °API.');
        need(_fin(sgg) && sgg >= 0.55 && sgg <= 1.5, 'sgg', 'Gas gravity must be between 0.55 and 1.5.');
        need(_fin(sgw) && sgw >= 0.95 && sgw <= 1.3, 'sgw', 'Water specific gravity must be between 0.95 and 1.3.');
        need(_fin(pwh) && pwh > 0 && pwh <= 15000, 'pwh', 'Wellhead pressure (upstream of the choke) must be above 0 and no more than 15,000 psig.');
        need(_fin(t0) && t0 >= 0 && t0 <= 400, 't0', 'Line inlet temperature must be between 0 and 400 °F.');
        need(i.tmode === 'heat' || (_fin(t1) && t1 >= 0 && t1 <= 400), 't1', 'Arrival temperature must be between 0 and 400 °F.');
        need(_fin(psep) && psep >= 0 && psep <= 15000, 'psep', 'Separator pressure must be between 0 and 15,000 psig.');
        need(_fin(rough) && rough >= 0 && rough <= 0.1, 'rough', 'Pipe roughness must be between 0 and 0.1 in.');
        need(_fin(dptip) && dptip >= 0 && dptip <= 50, 'dptip', 'Flare tip pressure drop must be between 0 and 50 psi.');
        need(_fin(mdmt) && mdmt >= -320 && mdmt <= 200, 'mdmt', 'Minimum design metal temperature must be between -320 and 200 °F.');
        need(_fin(xt) && xt >= 0.05 && xt <= 1, 'xt', 'Gas PCV pressure differential ratio factor xT must be between 0.05 and 1.');
        need(psvset == null || (_fin(psvset) && psvset > 0 && psvset <= 15000), 'psvset', 'Separator PSV set pressure must be above 0 and no more than 15,000 psig (leave it blank to skip the check).');
        function segs(list, pre, max, req) {
            var o = [];
            (list || []).slice(0, max).forEach(function (s, k) {
                var len = +s.len, id = +s.id, dz = (s.dz === '' || s.dz == null || !_fin(+s.dz)) ? 0 : +s.dz;
                var blankLen = !_fin(len), blankId = !_fin(id);
                if (blankLen && blankId) return;
                var key = pre + (k + 1);
                var lok = need(_fin(len) && len > 0 && len <= 200000, key + '_len', 'Segment ' + (k + 1) + ': length must be above 0 and no more than 200,000 ft.');
                need(_fin(id) && id >= 0.5 && id <= 60, key + '_id', 'Segment ' + (k + 1) + ': inside diameter must be between 0.5 and 60 in.');
                need(!lok || Math.abs(dz) <= len + 1e-9, key + '_dz', 'Segment ' + (k + 1) + ': elevation change cannot exceed the segment length.');
                o.push({ name: String(s.name || '').trim() || ('Segment ' + (k + 1)), len: len, id: id, dz: dz });
            });
            if (req && !o.length) need(false, pre + '1_len', 'Enter at least one choke-to-separator segment (length and inside diameter).');
            return o;
        }
        var well = segs(i.well, 'w', NSEG_W, true), flare = segs(i.flare, 'f', NSEG_F, false);
        var coupled = i.tmode === 'heat', H = null;
        if (coupled) {
            var hv = function (k, d) { var v = i[k]; return (v === '' || v == null || (typeof v === 'number' && isNaN(v))) ? d : +v; };
            H = { tair: hv('tair', NaN), wind: hv('wind', NaN), eps: hv('eps', NaN), wall: hv('wall', NaN), ins: hv('ins', 0),
                kp: hv('kp', NaN), kins: hv('kins', NaN), cpo: hv('cpo', NaN), cpw: hv('cpw', NaN), cpg: hv('cpg', NaN), jt: hv('jt', 0) };
            need(_fin(H.tair) && H.tair >= -60 && H.tair <= 140, 'tair', 'Air temperature must be between -60 and 140 °F.');
            need(_fin(H.wind) && H.wind >= 0 && H.wind <= 150, 'wind', 'Wind speed must be between 0 and 150 mph.');
            need(_fin(H.eps) && H.eps >= 0 && H.eps <= 1, 'eps', 'Surface emissivity must be between 0 and 1.');
            need(_fin(H.wall) && H.wall > 0 && H.wall <= 3, 'wall', 'Wall thickness must be above 0 and no more than 3 in.');
            need(_fin(H.ins) && H.ins >= 0 && H.ins <= 12, 'ins', 'Insulation thickness must be between 0 and 12 in.');
            need(_fin(H.kp) && H.kp > 0 && H.kp <= 250, 'kp', 'Pipe wall conductivity must be above 0 and no more than 250 Btu/hr·ft·°F.');
            need(_fin(H.kins) && H.kins > 0 && H.kins <= 5, 'kins', 'Insulation conductivity must be above 0 and no more than 5 Btu/hr·ft·°F.');
            need(_fin(H.cpo) && H.cpo >= 0.2 && H.cpo <= 1.2, 'cpo', 'Oil heat capacity must be between 0.2 and 1.2 Btu/lb·°F.');
            need(_fin(H.cpw) && H.cpw >= 0.5 && H.cpw <= 1.2, 'cpw', 'Water heat capacity must be between 0.5 and 1.2 Btu/lb·°F.');
            need(_fin(H.cpg) && H.cpg >= 0.2 && H.cpg <= 1.5, 'cpg', 'Gas heat capacity must be between 0.2 and 1.5 Btu/lb·°F.');
            need(_fin(H.jt) && H.jt >= -0.1 && H.jt <= 0.2, 'jt', 'Joule–Thomson coefficient must be between -0.1 and 0.2 °F/psi.');
            if (typeof G.WTS_lineheat_ua !== 'function' || typeof G.WTS_lineheat_massFlow !== 'function') {
                errors.push('The Line Heat Loss engine is not loaded: use the linear temperature model.'); bad.push('tmode');
            }
        }
        if (!_lib()) { errors.push('The PVT correlation library (PRiSM) is not loaded.'); bad.push('lib'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var opt = { rough: rough, payne: !!i.payne, accel: !!i.accel };
        var pMax = P_CAP + PATM;
        var optW = Object.assign({}, opt, { refine: true, chokeRaise: true, pMax: pMax });
        var optF = Object.assign({}, opt, { accel: true, refine: true, chokeRaise: true, pMax: pMax });   // compressible flow
        function heatFor(f) {
            if (!coupled) return null;
            var mf = G.WTS_lineheat_massFlow({ qo: f.qo, qw: f.qw, qg: f.qg, api: api, sgg: sgg, sgw: sgw, cpo: H.cpo, cpw: H.cpw, cpg: H.cpg });
            // Inside film neglected (hi blank on the Line Heat Loss page): conservative, more heat lost.
            return { mcp: mf.mcp, m: mf.m, jt: H.jt, wall: H.wall, ins: H.ins,
                env: { hi: 0, kp: H.kp, kins: H.kins, eps: H.eps, tair: H.tair, wind: H.wind, tsoil: H.tair, ksoil: 1 } };
        }
        var fluid = { qo: qo, qw: qw, qg: qg, api: api, sgg: sgg, sgw: sgw };

        // Route 1: separator inlet (psep) → backwards → choke outlet.
        var Lw = _len(well), r1 = null, iters = 0;
        var tFn = coupled ? _constT(t0) : function (x) { return Lw > 0 ? t0 + (t1 - t0) * x / Lw : t0; };
        // Coupled: the temperature profile of a forward P–T march from the result, until the arrival
        // temperature changes by < 0.02 °F between passes (P2 depends weakly on T; 2–3 passes).
        var hw = heatFor(fluid);
        for (var it = 0; it < (coupled ? 8 : 1); it++) {
            iters++;
            r1 = _back(well, fluid, psep, tFn, optW);
            if (!coupled || r1.lost) break;
            var fw = march({ segments: _segCopy(well) }, fluid, r1.pIn, t0, t0, Object.assign({}, opt, { heat: hw }));
            if (fw.lost) break;
            var tNew = _interpT(fw.profile), dT = Math.abs(tNew(Lw) - tFn(Lw));
            tFn = tNew;
            if (it > 0 && dT < 0.02) break;
        }
        r1.key = 'well'; r1.name = 'Choke outlet to separator'; r1.iterations = iters;
        r1.chokedExit = r1.chokes.length > 0;
        r1.reaches = !r1.lost && !r1.chokedExit;
        r1.high = !!(r1.lost && r1.lost.reason === 'high');
        r1.margin = r1.pIn != null ? pwh - r1.pIn : null;

        // Choke: WHP upstream, P2 downstream (dp < 0 when WHP < P2: the shortfall; deliver false).
        var choke = null;
        if (r1.pIn != null) {
            var multi = (qo + qw) > 0, kc = multi ? null : _kIdeal(sgg, t0), rc = multi ? GILBERT_CRIT : _critRatio(kc);
            var ratio = (r1.pIn + PATM) / (pwh + PATM), deliver = pwh >= r1.pIn;
            choke = { whp: pwh, p2: r1.pIn, dp: pwh - r1.pIn, ratio: ratio, rc: rc, k: kc, basis: multi ? 'multiphase' : 'gas',
                deliver: deliver, critical: deliver && ratio <= rc };
        }

        // Route 2: flare tip (atmosphere + tip drop) → backwards → PCV outlet; the PCV takes the rest.
        var r2 = null, pcv = null, fc = null, psv = null, tSep = coupled && r1.tOut != null ? r1.tOut : t1;
        if (flare.length && qg > 0) {
            var gasOnly = { qo: 0, qw: 0, qg: qg, api: api, sgg: sgg, sgw: sgw }, hg = heatFor(gasOnly), Lf = _len(flare);
            // Pass 1 at the separator temperature, then passes at the PCV outlet temperature until P_out changes
            // by < 0.01 psi. T_out(P_out) moves by μJT·ΔP_out between passes (≈ 0.06 °F/psi), so the expansion
            // is integrated once and then shifted along it. Along the line: linear model — adiabatic, the gas
            // keeps expanding isenthalpically from the separator, T(x) = T_h(p(x)) from the previous pass's
            // pressure profile (the isenthalpic curve shifted to T_out at the PCV outlet); coupled model — the
            // forward P–T march from the PCV outlet (line heat loss + μJT).
            var curve = (!coupled && psep > dptip) ? _isenthCurve(sgg, psep + PATM, tSep, dptip + PATM) : null;
            var tFnF = _constT(tSep), jt = null, jtP = null, pPrevF = null, tPcv = tSep;
            for (var itf = 0; itf < 6; itf++) {
                r2 = _back(flare, gasOnly, dptip, tFnF, optF);
                if (r2.lost) break;
                var pNew = r2.pIn;
                if (pNew >= psep) { tPcv = tSep; jt = null; }
                else if (jt == null || Math.abs(pNew - jtP) > 5) { jt = isenthalp(sgg, psep + PATM, tSep, pNew + PATM); jtP = pNew; tPcv = jt.t; }
                else { tPcv = jt.t + _jtAt(sgg, pNew + PATM, jt.t).mu * (pNew - jtP); }
                if (pPrevF != null && Math.abs(pNew - pPrevF) < 0.01) break;
                if (coupled) {
                    var ff = march({ segments: _segCopy(flare) }, gasOnly, pNew, tPcv, tPcv, Object.assign({}, optF, { chokeRaise: false, refine: false, pMax: 0, heat: hg }));
                    tFnF = ff.profile.length > 1 ? _interpT(ff.profile) : _constT(tPcv);
                } else tFnF = (curve && pNew < psep) ? _tAlong(curve, r2, tPcv) : _constT(tPcv);
                pPrevF = pNew;
            }
            r2.key = 'flare'; r2.name = 'PCV outlet to flare tip';
            r2.chokedExit = r2.chokes.length > 0;
            r2.reaches = !r2.lost;
            r2.high = !!(r2.lost && r2.lost.reason === 'high');
            if (!r2.lost) {
                var pSepA = psep + PATM, pOutA = r2.pIn + PATM, kp = _kIdeal(sgg, tSep), rcp = _critRatio(kp);
                var passes = r2.pIn < psep, xv = (psep - r2.pIn) / pSepA, fgam = kp / 1.4;
                // choked: the valve (IEC 60534-2-1, x ≥ Fγ·xT); nozzleCritical: p2/p1 at or below the ideal-nozzle ratio.
                pcv = { pIn: psep, pOut: r2.pIn, dp: psep - r2.pIn, ratio: pOutA / pSepA, rc: rcp, k: kp, passes: passes,
                    x: xv, xT: xt, fGamma: fgam, xChoke: fgam * xt,
                    choked: passes && xv >= fgam * xt, nozzleCritical: passes && pOutA / pSepA <= rcp,
                    tIn: tSep, tOut: passes ? tPcv : null, dT: passes ? tSep - tPcv : null,
                    muJT: passes && jt ? (tSep - tPcv) / (psep - r2.pIn) : null, jtReal: passes && jt ? jt.real : null };
                var machMax = 0, machSeg = null, rv2Max = 0, rv2Seg = null, tMin = Infinity, hydW = null;
                r2.segments.forEach(function (s) {
                    if (s.pIn == null || s.pOut == null) return;
                    var a = _gasPoint(gasOnly, s, s.pIn, s.tIn), b = _gasPoint(gasOnly, s, s.pOut, s.tOut);
                    s.vIn = a.v; s.vOut = b.v; s.machIn = a.mach; s.machOut = b.mach; s.mach = Math.max(a.mach, b.mach);
                    s.rhoV2 = Math.max(a.rv2, b.rv2); s.cOut = b.c;
                    if (s.mach > machMax) { machMax = s.mach; machSeg = s.name; }
                    if (s.rhoV2 > rv2Max) { rv2Max = s.rhoV2; rv2Seg = s.name; }
                });
                // Coldest gas and hydrate margin point by point (the hydrate temperature falls with the pressure).
                var hydFn = typeof G.WTS_hydrate_temp === 'function' ? G.WTS_hydrate_temp : null;
                r2.profile.forEach(function (q) {
                    if (!_fin(q.t)) return;
                    if (q.t < tMin) tMin = q.t;
                    var th = hydFn ? hydFn(q.p + PATM, sgg) : NaN;
                    if (_fin(th) && (!hydW || q.t - th < hydW.margin)) hydW = { margin: q.t - th, t: q.t, tHyd: th, p: q.p, x: q.x };
                });
                if (!_fin(tMin)) tMin = passes ? tPcv : tSep;
                var hyd = hydFn ? hydFn(pOutA, sgg) : null;
                fc = { machMax: machMax, machSeg: machSeg, rhoV2Max: rv2Max, rhoV2Seg: rv2Seg, tMin: tMin,
                    tHyd: _fin(hyd) ? hyd : null, hydAt: hydW, hydrate: passes && hydW ? hydW.margin < 0 : null,
                    belowMdmt: passes ? tMin < mdmt : null,
                    pTip: dptip, length: Lf, machLevel: r2.chokedExit || machMax > MACH_BAD ? 'bad' : machMax > MACH_WARN ? 'warn' : 'ok',
                    rhoV2High: rv2Max > RHOV2_LIM };
                // No flow through the PCV: no PSV back-pressure check at this rate.
                if (psvset != null && passes) psv = { set: psvset, valid: psvset > psep, bp: pcv.pOut, frac: pcv.pOut / psvset,
                    ok: pcv.pOut <= PSV_FRAC * psvset, nearSet: psep >= 0.9 * psvset };
            }
        }
        var warnings = [];
        r1.segments.forEach(function (s) {
            if (s.eroMax > 1) warnings.push(r1.name + ', ' + s.name + ': mixture velocity is ' + _fmt(100 * s.eroMax, 0) + ' % of the API RP 14E erosional velocity (C = 100).');
        });
        return {
            ok: true, routes: [r1].concat(r2 ? [r2] : []), well: r1, flare: r2, psep: psep, pwh: pwh,
            choke: choke, pcv: pcv, flareCheck: fc, psv: psv, dptip: dptip, mdmt: mdmt, psvset: psvset, xt: xt, tSep: tSep, pCap: P_CAP,
            inlet: r1.inlet ? r1.inlet.props : null, inletBB: r1.inlet, fluid: fluid, opt: opt, warnings: warnings,
            flareSkipped: flare.length && !(qg > 0), coupled: coupled, heat: H,
            tArr: r1.tOut != null ? r1.tOut : null
        };
    }

    G.WTS_flowline_bb = bb;
    G.WTS_flowline_props = function (fluid, p, t) { return _lib() ? props(fluid, p, t) : null; };
    G.WTS_flowline_compute = compute;
    // Well Dynamics (v4.6, plan §2.5 R5): the private gradient call exactly as the march makes it (correlation + VLP-tuning multipliers)
    G.WTS_flowline_gradAt = function (fluid, p, T, seg, opt) { return _gAt(fluid, p, T, seg, opt || {}); };
    G.WTS_flowline_isenthalp = isenthalp;
    // Pressure traverse along a list of segments (used by the gas-lift design page, 49-calc-gaslift.js):
    //   segments [{name, len ft, id in, dz ft (+ = flow goes up)}], fluid {qo, qw, qg MMSCFD, api, sgg, sgw},
    //   p0 psig at the start of the march, t0 → t1 °F linear along the march, opt {rough in, payne, accel,
    //   reverse: march against the flow direction (e.g. down a producing tubing from the wellhead),
    //   refine: split a step whose pressure change exceeds 3 % of the pressure (off by default)}.
    //   → {profile [{x, p psig, t, hl, pattern}], segments[], pOut, lost, …}, or null without the PVT library.
    //   Well Performance options (v4.3 WP0b, passed through when present; see the header): corr, mult, tAt (x ft along the march →
    //   °F, overrides t0 → t1), pMax (psia), stepFt, grid, eroC, detail; segments may carry area (in²), restr {d, k?} and (v4.5) corr.
    G.WTS_flowline_march = function (segments, fluid, p0, t0, t1, opt) {
        if (!_lib()) return null;
        var segs = (segments || []).map(function (q) {
            var o2 = { name: q.name || '', len: +q.len, id: +q.id, dz: +q.dz || 0 };
            if (+q.area > 0) o2.area = +q.area;
            if (q.restr && +q.restr.d > 0) o2.restr = { d: +q.restr.d, k: q.restr.k == null ? null : +q.restr.k };
            if (q.corr != null && q.corr !== '') o2.corr = String(q.corr);
            return o2;
        });
        var o = opt || {};
        var mo = { rough: o.rough == null ? 0.0018 : +o.rough, payne: o.payne !== false, accel: !!o.accel, reverse: !!o.reverse, refine: !!o.refine };
        if (o.corr != null) mo.corr = String(o.corr);
        if (o.mult && typeof o.mult === 'object') mo.mult = { hl: o.mult.hl == null ? 1 : +o.mult.hl, f: o.mult.f == null ? 1 : +o.mult.f };
        if (typeof o.tAt === 'function') mo.tAt = o.tAt;
        if (+o.pMax > 0) mo.pMax = +o.pMax;
        if (+o.stepFt > 0) mo.stepFt = +o.stepFt;
        if (o.grid) mo.grid = o.grid;
        if (+o.eroC > 0) mo.eroC = +o.eroC;
        if (o.detail) mo.detail = true;
        return march({ segments: segs }, fluid, +p0, +t0, (t1 == null ? +t0 : +t1), mo);
    };
    G.WTS_flowline_friction = { smooth: fSmooth, colebrook: fColebrook };
    G.WTS_flowline_sigma = { oil: sigmaOil, water: sigmaWater };
    G.WTS_flowline_emulsion = emulsion;                       // WP23: the emulsion viscosity used by props (fluid.pvt.emul)
    G.WTS_flowline_emulsion.WOELFLIN = JSON.parse(JSON.stringify(WOELFLIN));
    G.WTS_flowline_rvAt = function (rv, p, cgr) { return _rvAt(rv || {}, +p, +cgr); };

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Multiphase Flowline Pressure Drop';
    var SUB = 'Beggs & Brill with Payne corrections, marched back from the separator to the choke and from the flare tip to the separator gas PCV: choke and PCV pressure drops, flow pattern, holdup, Mach and back-pressure';
    var UNITS = {
        fl_qo: 'liquidRate', fl_qw: 'liquidRate', fl_qg: 'gasRate', fl_api: 'api', fl_sgg: 'sg', fl_sgw: 'sg',
        fl_pwh: 'pressureG', fl_t0: 'temperature', fl_t1: 'temperature', fl_psep: 'pressureG', fl_rough: 'lengthSmall',
        fl_tair: 'temperature', fl_wind: 'windSpeed', fl_wall: 'lengthSmall', fl_ins: 'lengthSmall',
        fl_kp: 'thermalConductivity', fl_kins: 'thermalConductivity', fl_cpo: 'specificHeat', fl_cpw: 'specificHeat',
        fl_cpg: 'specificHeat', fl_jt: 'jtCoefficient',
        fl_dptip: 'pressure', fl_mdmt: 'temperature', fl_psvset: 'pressureG'
    };
    function _segIds(pre, n) {
        var o = [];
        for (var k = 1; k <= n; k++) o.push({ name: 'fl_' + pre + k + '_name', len: 'fl_' + pre + k + '_len', id: 'fl_' + pre + k + '_id', dz: 'fl_' + pre + k + '_dz' });
        return o;
    }
    var WELL_IDS = _segIds('w', NSEG_W), FLARE_IDS = _segIds('f', NSEG_F);
    var DEF_W = [['Choke manifold to heater', 150, 2.9, 0], ['Heater to separator', 250, 2.9, 5], ['Separator inlet riser', 20, 2.9, 15]];
    var DEF_F = [['Gas PCV to knock-out drum', 300, 3.826, 0], ['Flare line and boom', 200, 3.826, 25]];

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _sel(id, label, opts, val) {
        var h = '<div class="fg-item"><label for="' + id + '">' + label + '</label><select id="' + id + '">';
        opts.forEach(function (o) { h += '<option value="' + o.v + '"' + (o.v === val ? ' selected' : '') + '>' + o.t + '</option>'; });
        return h + '</select></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _bad(t) { return '<div style="color:var(--red)">✗ ' + t + '</div>'; }
    function _note(t) { return '<div style="margin-top:10px;font-size:12px;color:var(--text2)"><b>Notes</b> ' + t + '</div>'; }
    function _tbl(head, rows) {
        return '<div style="overflow-x:auto"><table class="dtable"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }
    function _segHead(pre) {
        return ['#', 'Segment',
            '<span id="fl_' + pre + 'h_len">Length (' + _lab('length', 'ft') + ')</span>',
            '<span id="fl_' + pre + 'h_id">Inside diameter (' + _lab('lengthSmall', 'in') + ')</span>',
            '<span id="fl_' + pre + 'h_dz">Elevation change, out − in (' + _lab('length', 'ft') + ')</span>'];
    }
    function _segTable(pre, ids, defs) {
        var rows = ids.map(function (s, k) {
            var d = defs[k] || ['', '', '', ''];
            return [String(k + 1),
                '<input type="text" id="' + s.name + '" value="' + d[0] + '" style="min-width:120px">',
                '<input type="number" id="' + s.len + '" value="' + d[1] + '" step="any" min="0" style="width:80px">',
                '<input type="number" id="' + s.id + '" value="' + d[2] + '" step="any" min="0" style="width:70px">',
                '<input type="number" id="' + s.dz + '" value="' + d[3] + '" step="any" style="width:70px">'];
        });
        return _tbl(_segHead(pre), rows);
    }
    function _refreshHeads() {
        ['w', 'f'].forEach(function (pre) {
            var set = function (id, t) { var e = _byId(id); if (e) e.textContent = t; };
            set('fl_' + pre + 'h_len', 'Length (' + _lab('length', 'ft') + ')');
            set('fl_' + pre + 'h_id', 'Inside diameter (' + _lab('lengthSmall', 'in') + ')');
            set('fl_' + pre + 'h_dz', 'Elevation change, out − in (' + _lab('length', 'ft') + ')');
        });
    }

    function _read() {
        var rd = function (ids) {
            return ids.map(function (s) { return { name: _str(s.name), len: _num(s.len), id: _num(s.id), dz: _num(s.dz) }; });
        };
        return {
            qo: _num('fl_qo'), qw: _num('fl_qw'), qg: _num('fl_qg'), api: _num('fl_api'), sgg: _num('fl_sgg'), sgw: _num('fl_sgw'),
            pwh: _num('fl_pwh'), t0: _num('fl_t0'), t1: _num('fl_t1'), psep: _num('fl_psep'), rough: _num('fl_rough'),
            payne: _str('fl_payne') !== 'no', accel: _str('fl_accel') !== 'no',
            well: rd(WELL_IDS), flare: rd(FLARE_IDS),
            dptip: _byId('fl_dptip') ? _num('fl_dptip') : undefined,
            mdmt: _byId('fl_mdmt') ? _num('fl_mdmt') : undefined,
            psvset: _byId('fl_psvset') ? _num('fl_psvset') : undefined,
            xt: _byId('fl_xt') ? _num('fl_xt') : undefined,
            tmode: _str('fl_tmode') === 'heat' ? 'heat' : 'linear',
            tair: _num('fl_tair'), wind: _num('fl_wind'), eps: _num('fl_eps'), wall: _num('fl_wall'), ins: _num('fl_ins'),
            kp: _num('fl_kp'), kins: _num('fl_kins'), cpo: _num('fl_cpo'), cpw: _num('fl_cpw'), cpg: _num('fl_cpg'), jt: _num('fl_jt')
        };
    }
    function _idFor(key) {
        var m = /^([wf])(\d)_(len|id|dz)$/.exec(key);
        if (m) return 'fl_' + m[1] + m[2] + '_' + m[3];
        return 'fl_' + key;
    }
    var MSG = {
        pwh: function () { return 'Wellhead pressure (upstream of the choke) must be above 0 and no more than ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        psep: function () { return 'Separator pressure must be between 0 and ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        t0: function () { return 'Line inlet temperature must be between ' + _u(0, 'temperature', 0, '°F') + ' and ' + _u(400, 'temperature', 0, '°F') + '.'; },
        t1: function () { return 'Arrival temperature must be between ' + _u(0, 'temperature', 0, '°F') + ' and ' + _u(400, 'temperature', 0, '°F') + '.'; },
        rough: function () { return 'Pipe roughness must be between 0 and ' + _u(0.1, 'lengthSmall', 1, 'in', 2) + '.'; },
        tair: function () { return 'Air temperature must be between ' + _u(-60, 'temperature', 0, '°F') + ' and ' + _u(140, 'temperature', 0, '°F') + '.'; },
        dptip: function () { return 'Flare tip pressure drop must be between 0 and ' + _u(50, 'pressure', 0, 'psi') + '.'; },
        mdmt: function () { return 'Minimum design metal temperature must be between ' + _u(-320, 'temperature', 0, '°F') + ' and ' + _u(200, 'temperature', 0, '°F') + '.'; },
        psvset: function () { return 'Separator PSV set pressure must be above 0 and no more than ' + _u(15000, 'pressureG', 0, 'psig') + ' (leave it blank to skip the check).'; }
    };

    function _paint(r) {
        var res = _byId('fl_res');
        if (!res) return;
        if (!r.ok) {
            var items = '', seen = {};
            r.bad.forEach(function (k, n) {
                var el = _byId(_idFor(k));
                if (el && el.classList) el.classList.add('input-err');
                if (seen[k]) return; seen[k] = 1;
                items += '<li>' + (MSG[k] ? MSG[k]() : _esc(r.errors[n])) + '</li>';
            });
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
            return;
        }
        var P = function (v) { return _u(v, 'pressureG', 1, 'psig', 0); };
        var dP = function (v) { return _u(v, 'pressure', 1, 'psi', 1); };
        var ft = function (v) { return _u(v, 'length', 0, 'ft', 1); };
        var inch = function (v) { return _metric() ? _u(v, 'lengthSmall', 3, 'in', 1) : _fmt(v, 3) + ' in'; };
        var T = function (v) { return _u(v, 'temperature', 1, '°F'); };
        var dT = function (v) { return _u(v, 'tempDelta', 1, '°F'); };
        var vel = function (v) { return _u(v, 'velocity', 2, 'ft/s'); };
        var vel0 = function (v) { return _u(v, 'velocity', 0, 'ft/s'); };
        var dens = function (v) { return _u(v, 'density', 2, 'lb/ft³', 1); };
        var rv2 = function (v) { return _u(v, 'momentumFlux', 0, 'lb/ft·s²'); };
        var mach = function (v) { return _fmt(v, 3); };
        var nm = function (s) { return _esc(s); };
        var h = '';
        var w = r.well, pr = r.inlet, bI = r.inletBB, ch = r.choke, f = r.flare, pc = r.pcv, fc = r.flareCheck;

        // ── Line summary: separator → choke ──
        var v = '', cap = P(r.pCap);
        if (w.lost) {
            v += _bad(w.lost.reason === 'critical'
                ? 'The line reaches critical (choked) flow in ' + nm(w.segments[w.lost.seg].name) + ': it cannot carry this rate to the separator.'
                : w.lost.reason === 'high'
                ? 'Marching back from the separator, more than ' + cap + ' would be needed in ' + nm(w.segments[w.lost.seg].name) + ': the well cannot deliver this rate into the separator through this line. Use a larger line or expect a lower rate.'
                : 'Marching back from the separator, the pressure falls below atmospheric in ' + nm(w.segments[w.lost.seg].name) + ' (a downhill line running partly full): the steady model does not apply.');
        } else {
            if (w.chokedExit) {
                var cw = w.chokes[w.chokes.length - 1];
                v += _bad('The line chokes (critical velocity) at the outlet of ' + nm(w.segments[cw.seg].name) + ': the outlet sits at ' + P(cw.pUp) + ', above the ' + P(cw.pDown) + ' downstream. Use a larger line.');
            }
            if (!ch.deliver) v += _bad('WHP ' + P(ch.whp) + ' is below the ' + P(ch.p2) + ' needed downstream of the choke: the well cannot deliver this rate into the separator at ' + P(r.psep) + '. Lower the separator pressure or use a larger line, or expect a lower rate.');
            else if (ch.critical) v += _ok('Choke: ' + P(ch.whp) + ' → ' + P(ch.p2) + ' (ΔP ' + dP(ch.dp) + '), p2/p1 = ' + _fmt(ch.ratio, 3) + ' ≤ ' + _fmt(ch.rc, 3) + ': critical flow, the well rate does not depend on the separator pressure.');
            else v += _warn('Choke: ' + P(ch.whp) + ' → ' + P(ch.p2) + ' (ΔP ' + dP(ch.dp) + '), p2/p1 = ' + _fmt(ch.ratio, 3) + ' > ' + _fmt(ch.rc, 3) + ': subcritical, separator pressure changes will change the well rate.');
            // The line verdict only when it carries the rate to the separator pressure (a choked outlet or a
            // WHP shortfall has its own ✗ above).
            if (w.reaches && ch.deliver) v += _ok('Line: ' + dP(w.dp) + ' from the choke outlet to the separator at ' + P(r.psep) + '.');
        }
        r.warnings.forEach(function (x) { v += _warn(_esc(x)); });
        h += '<div class="rbox"><div class="rbox-title">Line Summary</div>' +
            _row('Wellhead pressure, upstream of the choke (WHP)', P(r.pwh)) +
            _row('Required pressure downstream of the choke', ch ? P(ch.p2) : w.high ? 'More than ' + cap : '—') +
            _row('Choke pressure drop', ch && ch.deliver ? dP(ch.dp) : '—') +
            _row('Choke pressure ratio p2/p1, absolute', ch ? _fmt(ch.ratio, 3) + ' (critical at ≤ ' + _fmt(ch.rc, 3) + (ch.basis === 'gas' ? ', gas, k = ' + _fmt(ch.k, 3) : ', gas–liquid') + ')' : '—') +
            _row('Choke flow', !ch ? (w.high ? 'Cannot deliver: more than ' + cap + ' needed downstream of the choke' : '—') : !ch.deliver ? 'Cannot deliver: WHP below the required pressure' : ch.critical ? 'Critical' : 'Subcritical') +
            _row('Pressure drop, choke outlet to separator', w.dp == null ? '—' : dP(w.dp) + (w.chokedExit ? ', to the choked line outlet' : '')) +
            (w.chokedExit && w.pOut != null ? _row('Line outlet pressure, choked (above the separator pressure)', P(w.pOut)) : '') +
            _row('Separator operating pressure, held by the gas PCV', P(r.psep)) +
            _row('Line length, choke outlet to separator', ft(w.length)) +
            _row('Temperature model', r.coupled ? 'Coupled pressure–temperature march (line heat loss)' : 'Linear, line inlet to arrival') +
            (r.coupled ? _row('Arrival temperature at separator, calculated', w.tOut == null ? '—' : T(w.tOut)) : '') +
            v + '</div>';

        // ── Gas PCV and flare line ──
        if (f) {
            var vf = '';
            if (f.lost) vf += _bad(f.lost.reason === 'high'
                ? 'The flare line cannot carry ' + _u(r.fluid.qg, 'gasRate', 2, 'MMSCFD') + ': more than ' + cap + ' would be needed at the PCV outlet (passed in ' + nm(f.segments[f.lost.seg].name) + '). Use a larger line.'
                : 'The flare line cannot carry ' + _u(r.fluid.qg, 'gasRate', 2, 'MMSCFD') + ' (the march back from the tip failed in ' + nm(f.segments[f.lost.seg].name) + '): use a larger line.');
            else {
                var cf = f.chokedExit ? f.chokes[f.chokes.length - 1] : null, cfs = cf ? f.segments[cf.seg] : null;
                // Choked at the isothermal limit Ek = 1: v = √(ZRT/M), i.e. Mach (v/c) = 1/√k on the table.
                var chokeTxt = cf ? 'The flare line chokes at the outlet of ' + nm(cfs.name) + ' (isothermal limit, gas velocity √(ZRT/M), Mach ' +
                    mach(cfs.machOut) + '): the exit pressure rises to ' + P(cf.pUp) + ', above the ' + P(cf.pDown) + ' beyond it. Use a larger line.' : '';
                if (!pc.passes) {
                    // No flow: the checks below would be at a rate that cannot pass, so only the cause is shown.
                    vf += _bad('Back-pressure at the PCV outlet ' + P(pc.pOut) + ' is not below the separator pressure ' + P(r.psep) + ': the separator cannot vent this gas through the flare line. Raise the separator pressure or enlarge the line.');
                    if (cf) vf += _bad(chokeTxt);
                } else {
                    var pcvHead = 'Gas PCV: ' + P(r.psep) + ' → ' + P(pc.pOut) + ' (ΔP ' + dP(pc.dp) + '), x = ΔP/p1 = ' + _fmt(pc.x, 3);
                    vf += _ok(pc.choked
                        ? pcvHead + ' ≥ Fγ·xT = ' + _fmt(pc.xChoke, 3) + ': choked flow through the valve (IEC 60534-2-1); size it for choked flow and check its noise.'
                        : pc.nozzleCritical
                        ? pcvHead + ' < Fγ·xT = ' + _fmt(pc.xChoke, 3) + ': not choked (IEC 60534-2-1), subcritical flow through the valve, although p2/p1 = ' + _fmt(pc.ratio, 3) + ' is below the ideal-nozzle ratio ' + _fmt(pc.rc, 3) + '.'
                        : pcvHead + ' < Fγ·xT = ' + _fmt(pc.xChoke, 3) + ': not choked, subcritical flow.');
                    if (pc.dp < DP_PCV_MIN) vf += _warn('Only ' + dP(pc.dp) + ' across the PCV: it runs nearly wide open with little margin to hold the separator pressure.');
                    if (cf) vf += _bad(chokeTxt);
                    if (fc.machLevel === 'bad' && !cf) vf += _bad('Mach ' + mach(fc.machMax) + ' in ' + nm(fc.machSeg) + ' is above 0.7 (API 521 upper limit, short-duration relief only): enlarge the flare line.');
                    else if (fc.machLevel === 'warn') vf += _warn('Mach ' + mach(fc.machMax) + ' in ' + nm(fc.machSeg) + ' is above 0.5 (API 521 guidance for continuous flow in headers and long lines): noise and vibration; consider a larger line.');
                    else if (fc.machLevel === 'ok') vf += _ok('Mach ≤ 0.5 in the flare line (highest ' + mach(fc.machMax) + ', ' + nm(fc.machSeg) + ').');
                    if (fc.rhoV2High) vf += _warn('ρv² ' + rv2(fc.rhoV2Max) + ' in ' + nm(fc.rhoV2Seg) + ' is above ' + rv2(RHOV2_LIM) + ', a common screening limit for flare lines: noise and flow-induced vibration.');
                    if (fc.hydrate) vf += _warn('Gas in the flare line reaches ' + T(fc.hydAt.t) + ' at ' + P(fc.hydAt.p) + ', below the hydrate temperature ' + T(fc.hydAt.tHyd) + ' there: hydrates can form. Heat the gas or inject inhibitor upstream of the PCV.');
                    if (fc.belowMdmt) vf += _warn('Gas downstream of the PCV cools to ' + T(fc.tMin) + (r.coupled ? '' : ' (isenthalpic expansion to the line exit)') + ', below the minimum design metal temperature ' + T(r.mdmt) + ': check the PCV and flare line materials.');
                }
                if (r.psv) {
                    if (!r.psv.valid) vf += _warn('The PSV set pressure ' + P(r.psv.set) + ' is not above the separator pressure: check the input (back-pressure check skipped).');
                    else {
                        vf += r.psv.ok
                            ? _ok('Flare header back-pressure ' + P(r.psv.bp) + ' is ' + _fmt(100 * r.psv.frac, 1) + ' % of the PSV set pressure ' + P(r.psv.set) + ': within the 10 % limit for a conventional PSV relieving this rate into the header (API 520).')
                            : _warn('Flare header back-pressure ' + P(r.psv.bp) + ' is ' + _fmt(100 * r.psv.frac, 1) + ' % of the PSV set pressure ' + P(r.psv.set) + ', above 10 %: use a balanced-bellows or pilot PSV, or a larger flare line (API 520).');
                        if (r.psv.nearSet) vf += _warn('The separator runs above 90 % of its PSV set pressure: the PSV may simmer.');
                    }
                }
            }
            h += '<div class="rbox"><div class="rbox-title">Gas PCV and Flare Line</div>' +
                _row('Separator gas to the flare', _u(r.fluid.qg, 'gasRate', 2, 'MMSCFD', 1)) +
                _row('PCV inlet: separator pressure / temperature', P(r.psep) + ' / ' + T(r.tSep)) +
                _row('Flare tip back-pressure, atmosphere + tip drop', P(r.dptip)) +
                _row('Pressure at the PCV outlet (flare header back-pressure)', pc ? P(pc.pOut) : f.high ? 'More than ' + cap : '—') +
                _row('PCV pressure drop', pc && pc.passes ? dP(pc.dp) : '—') +
                _row('PCV pressure ratio p2/p1, absolute', pc ? _fmt(pc.ratio, 3) + ' (ideal-nozzle critical ratio ' + _fmt(pc.rc, 3) + ', k = ' + _fmt(pc.k, 3) + ')' : '—') +
                _row('PCV pressure differential ratio x = ΔP/p1', pc && pc.passes ? _fmt(pc.x, 3) + ' (choked at ≥ Fγ·xT = ' + _fmt(pc.xChoke, 3) + ', xT = ' + _fmt(pc.xT, 2) + ')' : '—') +
                _row('PCV flow', !pc ? (f.high ? 'No flow: more than ' + cap + ' needed at the PCV outlet' : '—') : !pc.passes ? 'No flow: back-pressure at or above the separator pressure' : pc.choked ? 'Choked (IEC 60534-2-1)' : 'Not choked (subcritical)') +
                _row('Temperature downstream of the PCV, isenthalpic', pc && pc.passes ? T(pc.tOut) : '—') +
                _row('Joule–Thomson cooling across the PCV', pc && pc.passes ? dT(pc.dT) + ' (mean μJT ' + _u(pc.muJT, 'jtCoefficient', 4, '°F/psi', 4) + (pc.jtReal ? ', real gas' : ', 7 °F/100 psi rule') + ')' : '—') +
                _row('Hydrate temperature at the PCV outlet pressure', fc && fc.tHyd != null ? T(fc.tHyd) : '—') +
                _row('Coldest gas temperature in the flare line', fc && pc.passes ? T(fc.tMin) : '—') +
                _row('Minimum design metal temperature', T(r.mdmt)) +
                _row('Pressure drop, PCV outlet to flare tip', f.dp == null ? '—' : dP(f.dp)) +
                _row('Line length, PCV outlet to flare tip', ft(f.length)) +
                _row('Highest Mach number in the flare line', fc ? mach(fc.machMax) + ' (' + nm(fc.machSeg) + ')' : '—') +
                _row('Highest ρv² in the flare line', fc ? rv2(fc.rhoV2Max) + ' (' + nm(fc.rhoV2Seg) + ')' : '—') +
                (r.psv && r.psv.valid ? _row('Back-pressure / separator PSV set pressure', _fmt(100 * r.psv.frac, 1) + ' % of ' + P(r.psv.set)) : '') +
                vf + '</div>';
        } else if (r.flareSkipped) {
            h += '<div class="rbox"><div class="rbox-title">Gas PCV and Flare Line</div>' + _warn('Flare line not calculated: gas rate is zero.') + '</div>';
        }

        // ── Line inlet (choke outlet) conditions ──
        if (pr && bI) {
            h += '<div class="rbox"><div class="rbox-title">Inlet Conditions and Fluid Properties</div>' +
                _row('Producing GOR', _u(pr.gor, 'gor', 0, 'SCF/STB', 1)) +
                _row('Solution GOR at inlet, Standing', _u(pr.rs, 'gor', 0, 'SCF/STB', 1)) +
                _row('Oil FVF, Standing', _fmt(pr.bo, 4) + (_metric() ? ' m³/Sm³ (rb/STB)' : ' rb/STB'))   /* v3.1: same number in both systems */ +
                _row('Gas Z-factor, DAK', _fmt(pr.z, 4)) +
                _row('Liquid density, in situ', dens(pr.rhoL)) +
                _row('Gas density, in situ', dens(pr.rhoG)) +
                _row('Liquid viscosity / gas viscosity', _fmt(pr.muL, 3) + ' / ' + _fmt(pr.mug, 4) + ' cp') +
                _row('Liquid surface tension', _fmt(pr.sigL, 1) + ' dyn/cm') +
                _row('Superficial liquid / gas velocity', vel(bI.vsl) + ' / ' + vel(bI.vsg)) +
                _row('No-slip liquid holdup, λL', _fmt(bI.lambdaL, 4)) +
                _row('Froude number, NFr', _fmt(bI.NFr, 3)) +
                _row('Flow pattern at inlet', PAT_NAME[bI.pattern] || bI.pattern) +
                _row('Liquid holdup at inlet, HL', _fmt(bI.hl, 4)) +
                _row('Pressure gradient at inlet', _grad(bI.grad)) +
                '</div>';
        }

        // ── Segment tables (flow direction; the march ran backwards) ──
        var dash = function (x, fn) { return x == null ? '—' : fn(x); };
        h += '<div class="rbox"><div class="rbox-title">Segments: ' + w.name + '</div>' +
            _tbl(['Segment', 'Length', 'ID', 'Angle', 'Flow pattern', 'Holdup in → out', 'Inlet pressure', 'Outlet pressure',
                'Elevation', 'Friction', 'Acceleration', 'Total drop', 'Max velocity', 'Erosional ratio', 'Temperature in → out'], w.segments.map(function (s) {
                return [nm(s.name), ft(s.len), inch(s.id), s.theta == null ? '—' : _fmt(s.theta, 1) + '°',
                    s.patterns.map(function (p) { return PAT_NAME[p] || p; }).join(' → ') || '—',
                    _fmt(s.hlIn, 3) + ' → ' + _fmt(s.hlOut, 3), dash(s.pIn, P), dash(s.pOut, P),
                    dash(s.dpEl, dP), dash(s.dpF, dP), dash(s.dpAcc, dP), dash(s.dp, dP), dash(s.vmMax, vel), _fmt(s.eroMax, 2),
                    dash(s.tIn, T) + ' → ' + dash(s.tOut, T)];
            })) + '</div>';
        if (f) {
            h += '<div class="rbox"><div class="rbox-title">Segments: ' + f.name + '</div>' +
                _tbl(['Segment', 'Length', 'ID', 'Angle', 'Inlet pressure', 'Outlet pressure', 'Elevation', 'Friction', 'Acceleration',
                    'Total drop', 'Gas velocity in → out', 'Mach in → out', 'Max ρv²', 'Temperature in → out'], f.segments.map(function (s) {
                    return [nm(s.name), ft(s.len), inch(s.id), s.theta == null ? '—' : _fmt(s.theta, 1) + '°', dash(s.pIn, P), dash(s.pOut, P),
                        dash(s.dpEl, dP), dash(s.dpF, dP), dash(s.dpAcc, dP), dash(s.dp, dP),
                        dash(s.vIn, vel0) + ' → ' + dash(s.vOut, vel0), dash(s.machIn, mach) + ' → ' + dash(s.machOut, mach), dash(s.rhoV2, rv2),
                        dash(s.tIn, T) + ' → ' + dash(s.tOut, T)];
                })) + '</div>';
        }

        h += '<div class="rbox"><div class="rbox-title">Pressure vs Distance</div>' +
            '<div class="chart-wrap"><canvas id="fl_chart" width="600" height="320"></canvas></div>' +
            (f && !f.lost ? '<div class="chart-wrap"><canvas id="fl_chart2" width="600" height="260"></canvas></div>' : '') +
            _note('Beggs &amp; Brill (Payne) with Standing, DAK and Lee-Gonzalez-Eakin properties. The gas PCV holds the ' +
                'separator pressure: the well line is marched back from it to the choke outlet and the choke takes WHP − P2 ' +
                '(critical at p2/p1 ≤ 0.588 gas–liquid). The flare line is marched back from the tip (1 atm + tip drop) to ' +
                'the PCV outlet; the PCV takes the rest (choked at x ≥ Fγ·xT, IEC 60534-2-1) and the gas cools ' +
                'isenthalpically (real-gas μJT) on to the tip. Lines choke at v = √(ZRT/M). Mach ≤ 0.5 continuous, 0.7 ' +
                'maximum (API 521); ρv² ≤ 200,000 kg/m·s²; back-pressure ≤ 10 % of PSV set (API 520).') +
            '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
        _drawChart(r);
    }

    function _draw() { return (typeof drawLineChart === 'function') ? drawLineChart : (typeof G.drawLineChart === 'function' ? G.drawLineChart : null); } // eslint-disable-line no-undef
    function _drawChart(r) {
        var cv = _byId('fl_chart'), draw = _draw();
        if (!cv || !draw) return;
        var ds = [], w = r.well, f = r.flare, L0 = w.length;
        var pt = function (x, p) { return { x: _dv(x, 'length'), y: _dv(p, 'pressureG') }; };
        var wp = w.profile.map(function (q) { return pt(q.x, q.p); });
        if (r.choke && r.choke.deliver) wp.unshift(pt(0, r.pwh));                 // choke: WHP → P2 at x = 0
        ds.push({ label: 'Choke and line to separator', color: '#f0883e', points: false, width: 2, data: wp });
        if (f) {
            var fp = [pt(L0, r.psep)].concat(f.profile.map(function (q) { return pt(q.x + L0, q.p); }));   // PCV: Psep → P_out at the separator
            if (!f.lost && f.pOut > f.pEnd + 1e-9) fp.push(pt(L0 + f.length, f.pEnd));
            ds.push({ label: 'Gas PCV and flare line', color: '#58a6ff', points: false, width: 2, data: fp });
        }
        ds.push({ label: 'Separator pressure', color: '#3fb950', points: false, width: 1, dash: [6, 4], data: [pt(0, r.psep), pt(L0, r.psep)] });
        if (r.choke && !r.choke.deliver) ds.push({ label: 'Wellhead pressure (too low)', color: '#f85149', points: false, width: 1, dash: [4, 4], data: [pt(0, r.pwh), pt(L0, r.pwh)] });
        try {
            draw(cv, ds, { xLabel: 'Distance from the choke outlet (' + _lab('length', 'ft') + ')', yLabel: 'Pressure (' + _lab('pressureG', 'psig') + ')', xMin: 0, xDec: 0, yDec: 0 });
        } catch (e) { /* chart is cosmetic */ }
        var cv2 = _byId('fl_chart2');
        if (!cv2 || !f || f.lost) return;
        var d2 = [{ label: 'Flare line, downstream of the PCV', color: '#58a6ff', points: false, width: 2,
            data: f.profile.map(function (q) { return pt(q.x, q.p); }).concat(f.pOut > f.pEnd + 1e-9 ? [pt(f.length, f.pEnd)] : []) },
        { label: 'Flare tip back-pressure', color: '#d29922', points: false, width: 1, dash: [6, 4], data: [pt(0, f.pEnd), pt(f.length, f.pEnd)] }];
        try {
            draw(cv2, d2, { xLabel: 'Distance from the PCV outlet (' + _lab('length', 'ft') + ')', yLabel: 'Flare line pressure (' + _lab('pressureG', 'psig') + ')', xMin: 0, yMin: 0, xDec: 0, yDec: 1 });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _calcImpl() {
        var root = _byId('fl_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        _refreshHeads();
        var r = compute(_read());
        _paint(r);
        var ok = !!r.ok, f = ok ? r.flare : null, pc = ok ? r.pcv : null, ch = ok ? r.choke : null;
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.flowline = {
            ok: ok,
            pArr: ok ? r.well.pOut : null,                       // separator inlet (= separator pressure unless the line chokes)
            dpSep: ok ? r.well.dp : null,                        // choke outlet → separator
            pFlare: f && !f.lost ? f.pOut : null,                // flare tip (pipe exit)
            dpFlare: f && !f.lost ? f.dp : null,                 // PCV outlet → flare tip
            // No flow through the PCV / choke: the pressure drop (and PCV outlet temperature) is null, as on
            // the page; pcvChoked / chokeCritical are then false.
            pPcvOut: pc ? pc.pOut : null, dpPcv: pc && pc.passes ? pc.dp : null, pcvChoked: pc ? pc.choked : null,
            tPcvOut: pc && pc.passes ? pc.tOut : null,
            flareMachMax: ok && r.flareCheck ? r.flareCheck.machMax : null,
            p2Choke: ch ? ch.p2 : null, dpChoke: ch && ch.deliver ? ch.dp : null, chokeCritical: ch ? ch.critical : null,
            ts: Date.now(), result: r
        };
        return r;
    }
    G.calcFlowline = function () { return _canon(_calcImpl); };

    // "Use temperatures from Line Heat Loss": WTS_state.lineheat {tIn, tArr} in °F.
    G.WTS_flowlineUseHeat = function () {
        var st = G.WTS_state && G.WTS_state.lineheat;
        var a = _byId('fl_t0'), b = _byId('fl_t1');
        if (!a || !b) return false;
        if (!(st && st.ok && _fin(st.tIn) && _fin(st.tArr))) {
            var m = _byId('fl_heatmsg');
            if (m) m.innerHTML = _warn('Open Line Heat Loss &amp; Arrival Temperature and calculate first.');
            return false;
        }
        _canon(function () { a.value = String(Number(st.tIn.toFixed(2))); b.value = String(Number(st.tArr.toFixed(2))); });
        [a, b].forEach(function (el) {
            try {
                if (typeof Event === 'function' && el.dispatchEvent) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) { /* ignore */ }
        });
        var m2 = _byId('fl_heatmsg'); if (m2) m2.innerHTML = '';
        G.calcFlowline();
        return true;
    };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="fl_root">' +
            '<div class="card"><div class="card-title">Stream &amp; Conditions</div><div class="fg">' +
            _fg('fl_qo', 'Oil rate (BPD)', '2000', ' min="0"') +
            _fg('fl_qw', 'Water rate (BPD)', '500', ' min="0"') +
            _fg('fl_qg', 'Separator gas rate (MMSCFD)', '3', ' min="0"') +
            _fg('fl_api', 'Oil gravity (°API)', '35') +
            _fg('fl_sgg', 'Gas gravity, air = 1', '0.7') +
            _fg('fl_sgw', 'Water specific gravity', '1.05') +
            _fg('fl_pwh', 'Wellhead pressure, upstream of the choke, WHP (psig)', '600', ' min="0"') +
            _fg('fl_t0', 'Line inlet temperature, downstream of the choke (°F)', '120') +
            _fg('fl_t1', 'Arrival temperature at separator (°F)', '100') +
            _fg('fl_psep', 'Separator operating pressure, held by the gas PCV (psig)', '250', ' min="0"') +
            _fg('fl_rough', 'Pipe roughness (in)', '0.0018', ' min="0"') +
            _sel('fl_payne', 'Payne et al. corrections', [{ v: 'yes', t: 'Yes: holdup factors and rough-pipe friction' }, { v: 'no', t: 'No: original Beggs & Brill' }], 'yes') +
            _sel('fl_accel', 'Acceleration term (well line; always on in the flare line)', [{ v: 'yes', t: 'Include' }, { v: 'no', t: 'Neglect' }], 'yes') +
            _sel('fl_tmode', 'Temperature model', [{ v: 'linear', t: 'Linear, inlet to arrival temperature' }, { v: 'heat', t: 'Coupled P–T march with line heat loss' }], 'linear') +
            '</div><div class="btn-row"><button class="btn btn-primary" id="fl_calc" onclick="calcFlowline()">Calculate</button>' +
            '<button class="btn btn-secondary" id="fl_useheat" onclick="WTS_flowlineUseHeat()">Use temperatures from Line Heat Loss</button></div>' +
            '<div id="fl_heatmsg"></div></div>' +
            '<div class="card"><div class="card-title">Heat Loss (coupled temperature model only)</div><div class="fg">' +
            _fg('fl_tair', 'Air temperature (°F)', '60') +
            _fg('fl_wind', 'Wind speed (mph)', '10', ' min="0"') +
            _fg('fl_eps', 'Outer surface emissivity', '0.9', ' min="0" max="1"') +
            _fg('fl_wall', 'Pipe wall thickness (in)', '0.3', ' min="0"') +
            _fg('fl_ins', 'Insulation thickness, 0 = bare (in)', '0', ' min="0"') +
            _fg('fl_kp', 'Pipe wall conductivity (Btu/hr·ft·°F)', '26') +
            _fg('fl_kins', 'Insulation conductivity (Btu/hr·ft·°F)', '0.025') +
            _fg('fl_cpo', 'Oil heat capacity (Btu/lb·°F)', '0.5') +
            _fg('fl_cpw', 'Water heat capacity (Btu/lb·°F)', '1.0') +
            _fg('fl_cpg', 'Gas heat capacity (Btu/lb·°F)', '0.55') +
            _fg('fl_jt', 'Joule–Thomson coefficient along the line (°F/psi)', '0.07') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Segments: Choke Outlet to Separator</div>' + _segTable('w', WELL_IDS, DEF_W) + '</div>' +
            '<div class="card"><div class="card-title">Flare System, Downstream of the Separator Gas PCV</div><div class="fg">' +
            _fg('fl_dptip', 'Flare tip pressure drop (psi)', String(DEF.dptip), ' min="0"') +
            _fg('fl_mdmt', 'Minimum design metal temperature (°F)', String(DEF.mdmt)) +
            _fg('fl_psvset', 'Separator PSV set pressure, blank = no check (psig)', String(DEF.psvset), ' min="0"') +
            _fg('fl_xt', 'Gas PCV pressure differential ratio factor xT (valve data)', String(DEF.xt), ' min="0" max="1"') +
            '</div><div style="font-size:12px;color:var(--text2);margin-top:6px">The flare line is calculated back from the tip ' +
            '(atmosphere + tip drop) to the PCV outlet. The default PSV set pressure (1,440 psig, 9,928 kPa(g)) is a common ' +
            'well-test separator working pressure; enter the actual set pressure. xT is on the valve data sheet ' +
            '(IEC 60534-2-1; about 0.7 for a globe valve): the PCV chokes when ΔP/p1 ≥ (k/1.4)·xT.</div></div>' +
            '<div class="card"><div class="card-title">Segments: Gas PCV Outlet to Flare Tip</div>' + _segTable('f', FLARE_IDS, DEF_F) + '</div>' +
            '<div id="fl_res"></div>' +
            '</div>';
        var tags = {};
        for (var k in UNITS) tags[k] = UNITS[k];
        WELL_IDS.concat(FLARE_IDS).forEach(function (s) { tags[s.len] = 'length'; tags[s.id] = 'lengthSmall'; tags[s.dz] = 'length'; });
        _tag(tags);
        var root = _byId('fl_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^fl_/.test(e.target.id || '')) G.calcFlowline();
            });
        }
        G.calcFlowline();
    }
    G.renderFlowline = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.flowline = {
        key: 'flowline',
        title: TITLE,
        navTitle: 'Flowline Pressure Drop',
        sub: SUB,
        group: 'Well Test & Flowlines',
        icon: '&#8652;',
        badge: 'Multiphase',
        bc: 'dc-b-blue',
        desc: 'Beggs & Brill with Payne corrections: choke outlet to separator and gas PCV to flare tip, marched back from the separator pressure and the flare tip, with choke, PCV, Mach and back-pressure checks.',
        render: function (body) { return G.renderFlowline(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('fl_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcFlowline();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var fails = [], n = 0;
    function rel(a, b, tol, what) {
        n++;
        if (!(isFinite(a) && Math.abs(a - b) <= (tol || 1e-3) * Math.max(1e-12, Math.abs(b)))) fails.push(what + ': got ' + a + ', expected ' + b);
    }
    // Brill & Mukherjee (1999) example data set: vSL 3.97, vSg 3.86 ft/s, 6 in, vertical.
    var r = G.WTS_flowline_bb({ vsl: 3.97, vsg: 3.86, d: 6, rhoL: 47.61, rhoG: 5.88, muL: 0.97, muG: 0.016, sigma: 8.41, theta: 90, rough: 0.00072, p: 1700, payne: false, accel: false });
    n++; if (r.pattern !== 'intermittent') fails.push('pattern ' + r.pattern);
    rel(r.lambdaL, 0.507, 2e-3, 'lambda'); rel(r.HL0, 0.574, 3e-3, 'HL0'); rel(r.gradEl, 0.207, 5e-3, 'elevation gradient');
    // Single-phase water, horizontal: Darcy-Weisbach.
    var w = G.WTS_flowline_bb({ vsl: 5, vsg: 0, d: 4, rhoL: 62.4, rhoG: 0.1, muL: 1, muG: 0.01, sigma: 70, theta: 0, rough: 0, p: 100, payne: true });
    rel(w.gradF, w.fn * 62.4 * 25 / (2 * 32.174 * 4 / 12) / 144, 1e-12, 'Darcy');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[flowline self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[flowline self-test] ' + n + '/' + n + ' checks passed');
    }
})();
