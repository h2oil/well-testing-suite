// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Gas PVT (gaspvt)
//
// PURPOSE
//   Quick natural-gas properties at one pressure and temperature, with an
//   optional second point at separator conditions:
//     • pseudo-critical properties — Sutton (1985) for the hydrocarbon part,
//       Kay's mixing rule for N2 / CO2 / H2S, Wichert–Aziz (1972) sour-gas
//       correction;
//     • Z by Dranchuk–Abou-Kassem (1975) AND Hall–Yarborough (1973), with
//       the difference;
//     • Bg (ft³/scf and rb/Mscf), gas density, viscosity (Lee–Gonzalez–Eakin
//       1966, with the Standing N2/CO2/H2S correction), gas compressibility cg,
//       heat-capacity ratio k (ideal and real gas) and the real-gas speed of sound;
//     • a Z-vs-pressure table and chart at the given temperature.
//
// REUSE
//   The correlations come from PRiSM 16-pvt.js (window.PRiSM_pvt_correlations:
//   Tpc_sutton, Ppc_sutton, Z_dranchukAbouKassem, Z_hallYarborough,
//   mu_g_leeGonzalezEakin). Only what 16-pvt does not have is here:
//   impurity handling + Wichert–Aziz, cg from the corrected pseudo-criticals,
//   ideal-gas Cp/Cv and the speed of sound.
//
// UNITS
//   Field units in and out: psia, °F, mole %, ft³/scf, rb/Mscf, lb/ft³, cp,
//   1/psi, ft/s. Standard conditions 14.696 psia and 60 °F. The units layer
//   converts tagged inputs, so the calc always reads imperial values;
//   results are shown in the active unit system.
//
// PUBLIC API (window.*)
//   renderGasPVT(body)          paints the page into #pgBody
//   calcGasPVT()                reads the DOM, validates, computes, renders
//   WTS_gaspvt_compute(input)   pure: {sg, p, t, co2, h2s, n2, psep?, tsep?}
//                               → {ok, …} or {ok:false, errors[], bad[]}
//   WTS_gaspvt_pseudoCriticals(sg, co2, h2s, n2)   (mole fractions)
//   WTS_gaspvt_k(sg, tF, co2, h2s, n2)            ideal-gas Cp/Cv
//   WTS_gaspvt_viscosity(sg, tF, Z, p, yco2, yh2s, yn2)  LGE + Standing impurity correction
//   (compute() also returns kReal, cpReal, cvReal: real-gas values from the DAK departure functions)
//
// STATE
//   WTS_state.gaspvt = {ok, z, zDAK, zHY, Tpc, Ppc, Bg_ft3scf, rho, mu, cg, c, k, ts}
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var MW_AIR = 28.9647;              // lb/lb-mol
    var R_GAS = 10.7316;               // psia·ft³/(lb-mol·°R)
    var R_FT_LBF = 1545.35;            // ft·lbf/(lb-mol·°R)
    var GC = 32.174;                   // lbm·ft/(lbf·s²)
    var R_J = 8.31446;                 // J/(mol·K)
    var P_SC = 14.696, T_SC = 519.67;  // standard conditions, psia / °R
    var RANKINE = 459.67;
    var FT3_PER_BBL = 5.614583;
    // Non-hydrocarbons: molecular weight, critical temperature (°R) and pressure (psia) — GPSA.
    var NHC = {
        n2:  { M: 28.0134, Tc: 227.16, Pc: 493.1 },
        co2: { M: 44.010,  Tc: 547.58, Pc: 1071.0 },
        h2s: { M: 34.082,  Tc: 672.12, Pc: 1300.0 }
    };
    // Ideal-gas heat capacity Cp° = a + bT + cT² + dT³ (J/mol·K, T in K) —
    // Reid, Prausnitz & Poling, The Properties of Gases and Liquids (4th ed.), App. A.
    var CP = {
        c1:  { M: 16.043, a: 19.25,  b: 5.213e-2,  c: 1.197e-5,  d: -1.132e-8 },
        c2:  { M: 30.070, a: 5.409,  b: 1.781e-1,  c: -6.938e-5, d: 8.713e-9 },
        c3:  { M: 44.097, a: -4.224, b: 3.063e-1,  c: -1.586e-4, d: 3.215e-8 },
        n2:  { a: 31.15, b: -1.357e-2, c: 2.680e-5, d: -1.168e-8 },
        co2: { a: 19.80, b: 7.344e-2,  c: -5.602e-5, d: 1.715e-8 },
        h2s: { a: 31.94, b: 1.436e-3,  c: 2.432e-5, d: -1.176e-8 }
    };

    // ── Helpers ──────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _sig(v, s) {   // significant figures, no grouping ambiguity for small numbers
        if (v == null || !isFinite(v)) return '—';
        if (v === 0) return '0';
        var a = Math.abs(v), d = Math.max(0, (s || 4) - 1 - Math.floor(Math.log(a) / Math.LN10));
        if (a < 1e-3) return Number(v).toExponential((s || 4) - 1);
        return _fmt(v, Math.min(d, 8));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    function _u(v, cat, d, impLabel) {
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, d) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _us(v, cat, s, impLabel) {   // significant-figure variant
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _sig(f.value, s) + ' ' + f.label; }
        return _sig(v, s) + ' ' + impLabel;
    }
    function _dv(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(1, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _lib() { return G.PRiSM_pvt_correlations || null; }

    // ── Pure compute ─────────────────────────────────────────────────

    // Pseudo-criticals of a gas with impurities (mole fractions).
    //   γ_hc   = (γ − Σ yᵢ·Mᵢ/28.9647) / (1 − Σ yᵢ)                 hydrocarbon gravity
    //   Tpc_hc, Ppc_hc = Sutton(γ_hc)
    //   Tpc_m  = (1 − Σ yᵢ)·Tpc_hc + Σ yᵢ·Tcᵢ   (Kay), same for Ppc_m
    //   ε      = 120·(A^0.9 − A^1.6) + 15·(B^0.5 − B^4),  A = y_CO2 + y_H2S, B = y_H2S
    //   Tpc'   = Tpc_m − ε ;  Ppc' = Ppc_m·Tpc' / (Tpc_m + B·(1 − B)·ε)
    function pseudoCriticals(sg, yco2, yh2s, yn2) {
        var L = _lib();
        if (!L) return null;
        var yi = yco2 + yh2s + yn2, yh = 1 - yi;
        var sgHc = (sg - (yn2 * NHC.n2.M + yco2 * NHC.co2.M + yh2s * NHC.h2s.M) / MW_AIR) / yh;
        var TpcHc = L.Tpc_sutton(sgHc), PpcHc = L.Ppc_sutton(sgHc);
        var TpcM = yh * TpcHc + yn2 * NHC.n2.Tc + yco2 * NHC.co2.Tc + yh2s * NHC.h2s.Tc;
        var PpcM = yh * PpcHc + yn2 * NHC.n2.Pc + yco2 * NHC.co2.Pc + yh2s * NHC.h2s.Pc;
        var A = yco2 + yh2s, B = yh2s;
        var eps = 120 * (Math.pow(A, 0.9) - Math.pow(A, 1.6)) + 15 * (Math.pow(B, 0.5) - Math.pow(B, 4));
        var Tpc = TpcM - eps;
        var Ppc = PpcM * Tpc / (TpcM + B * (1 - B) * eps);
        return { sgHc: sgHc, TpcHc: TpcHc, PpcHc: PpcHc, TpcM: TpcM, PpcM: PpcM, eps: eps, Tpc: Tpc, Ppc: Ppc };
    }

    // Ideal-gas heat capacity (J/mol·K) at T (K) of the mixture. The hydrocarbon
    // part is a paraffin gas of molecular weight 28.9647·γ_hc, its Cp° taken
    // linearly in M between methane, ethane and propane (beyond propane the
    // ethane–propane slope is extended; below methane, methane).
    function _cpPoly(c, TK) { return c.a + TK * (c.b + TK * (c.c + TK * c.d)); }
    function _cpHc(M, TK) {
        var c1 = _cpPoly(CP.c1, TK), c2 = _cpPoly(CP.c2, TK), c3 = _cpPoly(CP.c3, TK);
        if (M <= CP.c1.M) return c1;
        if (M <= CP.c2.M) return c1 + (c2 - c1) * (M - CP.c1.M) / (CP.c2.M - CP.c1.M);
        return c2 + (c3 - c2) * (M - CP.c2.M) / (CP.c3.M - CP.c2.M);
    }
    function heatCapacity(sgHc, tF, yco2, yh2s, yn2) {
        var TK = (tF + RANKINE) / 1.8, yh = 1 - yco2 - yh2s - yn2;
        var cp = yh * _cpHc(MW_AIR * sgHc, TK) + yn2 * _cpPoly(CP.n2, TK) + yco2 * _cpPoly(CP.co2, TK) + yh2s * _cpPoly(CP.h2s, TK);
        return { cp: cp, cv: cp - R_J, k: cp / (cp - R_J) };
    }

    function _zBoth(L, Tpr, Ppr) {
        return { dak: L.Z_dranchukAbouKassem(Tpr, Ppr), hy: L.Z_hallYarborough(Tpr, Ppr) };
    }

    // ── Gas viscosity with the Standing impurity correction ──────────
    // Standing, M.B. (1977, SPE reprint 1981), "Volumetric and Phase Behavior of
    // Oil Field Hydrocarbon Systems", fits of the Carr–Kobayashi–Burrows (1954)
    // chart inserts: the 1-atm viscosity read at the gravity of the whole gas is
    // raised by (cp, log = log10)
    //   Δμ_N2  = y_N2 ·(8.48e-3·log γg + 9.59e-3)
    //   Δμ_CO2 = y_CO2·(9.08e-3·log γg + 6.24e-3)
    //   Δμ_H2S = y_H2S·(8.49e-3·log γg + 3.73e-3)
    // (also Ahmed, "Reservoir Engineering Handbook", eqs. 2-54…2-57).
    // Lee–Gonzalez–Eakin (1966) writes μg = 1e-4·K·exp(X·ρ^Y), where 1e-4·K is the
    // dilute-gas (low-pressure) viscosity and exp(X·ρ^Y) the dense-gas ratio. The
    // correction is added to the dilute term and carried by the same ratio:
    //   μg = (1e-4·K + ΣΔμ)·exp(X·ρ^Y),   K, X, Y, ρ at the total gravity and the
    // Wichert–Aziz-corrected Z. With no N2/CO2/H2S it is plain LGE.
    function standingDelta(sg, yco2, yh2s, yn2) {
        var lg = Math.log(sg) / Math.LN10;
        var dn2 = yn2 * (8.48e-3 * lg + 9.59e-3), dco2 = yco2 * (9.08e-3 * lg + 6.24e-3), dh2s = yh2s * (8.49e-3 * lg + 3.73e-3);
        return { n2: dn2, co2: dco2, h2s: dh2s, total: dn2 + dco2 + dh2s };
    }
    function viscosity(L, sg, tF, Z, p, yco2, yh2s, yn2) {
        var mu0 = L.mu_g_leeGonzalezEakin(sg, tF, Z, p);             // plain LGE
        var M = MW_AIR * sg, TR = tF + RANKINE;
        var K = (9.4 + 0.02 * M) * Math.pow(TR, 1.5) / (209 + 19 * M + TR);
        var mu1 = 1e-4 * K, ratio = mu0 / mu1;
        var d = standingDelta(sg, yco2 || 0, yh2s || 0, yn2 || 0);
        return { mu: (mu1 + d.total) * ratio, muLGE: mu0, mu1: mu1, ratio: ratio, delta: d };
    }

    // ── Real-gas heat capacities and speed of sound ─────────────────
    // Residual (departure) functions from the DAK Z(Tpr, Ppr) by numerical
    // differentiation and integration (Smith, Van Ness & Abbott, "Introduction to
    // Chemical Engineering Thermodynamics", 7th ed., §6.3, eqs. 6.46–6.49;
    // Poling, Prausnitz & O'Connell, 5th ed., §6-4):
    //   Cp − Cp° = −R·∫0^Ppr [2·Tpr·(∂Z/∂Tpr) + Tpr²·(∂²Z/∂Tpr²)]_Ppr dPpr/Ppr
    //   Cp − Cv  =  R·[Z + Tpr·(∂Z/∂Tpr)]² / [Z − Ppr·(∂Z/∂Ppr)]
    //   (∂p/∂ρ)_T = Z·R·T / (M·[1 − (Ppr/Z)(∂Z/∂Ppr)])
    //   c = √(k·g_c·(∂p/∂ρ)_T),   k = Cp/Cv (real gas)
    // Derivatives by central differences (h = 1e-3·Tpr, 1e-4·Ppr), integral by
    // composite Simpson on 120 panels. At low pressure k → Cp°/Cv° and
    // c → √(k°·R·T/M).
    function realGas(L, Tpr, Ppr, cpIdeal) {
        var Zf = function (t, q) { return L.Z_dranchukAbouKassem(t, q); };
        var ht = 1e-3 * Tpr;
        function g(q) {                                // integrand 2T·Z_T + T²·Z_TT at Ppr = q, divided by q
            var zp = Zf(Tpr + ht, q), z0 = Zf(Tpr, q), zm = Zf(Tpr - ht, q);
            var zt = (zp - zm) / (2 * ht), ztt = (zp - 2 * z0 + zm) / (ht * ht);
            return (2 * Tpr * zt + Tpr * Tpr * ztt) / q;
        }
        var N = 120, hq = Ppr / N, s = 0;
        for (var j = 0; j <= N; j++) {
            var q = j === 0 ? 1e-6 * Ppr : j * hq;          // integrand is finite at 0 (second virial)
            var w = (j === 0 || j === N) ? 1 : (j % 2 ? 4 : 2);
            s += w * g(q);
        }
        var cpRes = -R_J * s * hq / 3;
        var Z = Zf(Tpr, Ppr);
        var zT = (Zf(Tpr + ht, Ppr) - Zf(Tpr - ht, Ppr)) / (2 * ht);
        var hp = Math.max(1e-4 * Ppr, 1e-7);
        var zP = (Zf(Tpr, Ppr + hp) - Zf(Tpr, Math.max(1e-9, Ppr - hp))) / (Ppr + hp - Math.max(1e-9, Ppr - hp));
        var cp = cpIdeal + cpRes;
        var cpMinusCv = R_J * Math.pow(Z + Tpr * zT, 2) / (Z - Ppr * zP);
        var cv = cp - cpMinusCv;
        return { cp: cp, cv: cv, k: cp / cv, cpRes: cpRes, dZdT: zT, dZdP: zP, Z: Z, compFactor: 1 - Ppr * zP / Z };
    }

    // Properties at one (p, T) given the pseudo-criticals.
    function _state(L, pc, sg, p, tF, full, imp) {
        var TR = tF + RANKINE, Tpr = TR / pc.Tpc, Ppr = p / pc.Ppc;
        var z = _zBoth(L, Tpr, Ppr), Z = z.dak;
        var M = MW_AIR * sg;
        var y = imp || {};
        var vis = viscosity(L, sg, tF, Z, p, y.co2, y.h2s, y.n2);
        var s = {
            p: p, t: tF, Tpr: Tpr, Ppr: Ppr, zDAK: z.dak, zHY: z.hy,
            zDiff: z.hy - z.dak, zDiffPct: 100 * (z.hy - z.dak) / z.dak, z: Z,
            Bg_ft3scf: P_SC * Z * TR / (T_SC * p),
            // rb/Mscf from the same standard conditions (PRiSM Bg() rounds the constant to 5.035).
            Bg_rbMscf: 1000 * P_SC * Z * TR / (T_SC * p) / FT3_PER_BBL,
            rho: p * M / (Z * R_GAS * TR),
            mu: vis.mu, muLGE: vis.muLGE, muDelta: vis.delta.total * vis.ratio
        };
        s.E = 1 / s.Bg_ft3scf;
        s.Fpv = 1 / Math.sqrt(Z);
        if (full) {
            // cg = 1/p − (1/Z)·dZ/dp, dZ/dp from DAK by central difference in Ppr.
            var h = Math.max(1e-4 * Ppr, 1e-5);
            var zp = L.Z_dranchukAbouKassem(Tpr, Ppr + h), zm = L.Z_dranchukAbouKassem(Tpr, Math.max(1e-9, Ppr - h));
            var dZdPpr = (zp - zm) / (Ppr + h - Math.max(1e-9, Ppr - h));
            s.cpr = 1 / Ppr - dZdPpr / Z;
            s.cg = s.cpr / pc.Ppc;
        }
        return s;
    }

    function _niceMax(v) {
        var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), m = v / e;
        var n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
        return n * e;
    }

    function compute(input) {
        var i = input || {};
        var sg = Number(i.sg), p = Number(i.p), t = Number(i.t);
        var co2 = (i.co2 === '' || i.co2 == null) ? 0 : Number(i.co2);
        var h2s = (i.h2s === '' || i.h2s == null) ? 0 : Number(i.h2s);
        var n2 = (i.n2 === '' || i.n2 == null) ? 0 : Number(i.n2);
        var psep = (i.psep === '' || i.psep == null) ? NaN : Number(i.psep);
        var tsep = (i.tsep === '' || i.tsep == null) ? NaN : Number(i.tsep);
        var sepGiven = _fin(psep) || _fin(tsep);
        var errors = [], bad = [], keys = [];
        function err(k, m) { errors.push(m); keys.push(k); if (bad.indexOf(k) === -1) bad.push(k); }
        if (!(_fin(sg) && sg >= 0.55 && sg <= 3)) err('sg', 'Gas gravity must be between 0.55 and 3.0 (air = 1).');
        if (!(_fin(p) && p > 0 && p <= 30000)) err('p', 'Pressure must be above 0 and no more than 30,000 psia.');
        if (!(_fin(t) && t >= -40 && t <= 700)) err('t', 'Temperature must be between -40 and 700 °F.');
        if (!(_fin(co2) && co2 >= 0 && co2 < 100)) err('co2', 'CO2 must be between 0 and 100 mol %.');
        if (!(_fin(h2s) && h2s >= 0 && h2s < 100)) err('h2s', 'H2S must be between 0 and 100 mol %.');
        if (!(_fin(n2) && n2 >= 0 && n2 < 100)) err('n2', 'N2 must be between 0 and 100 mol %.');
        if (!bad.length && co2 + h2s + n2 >= 95) { err('sum', 'CO2 + H2S + N2 must be below 95 mol % (the gas must be mostly hydrocarbon).'); bad.push('h2s', 'n2'); }
        if (sepGiven) {
            if (!(_fin(psep) && psep > 0 && psep <= 30000)) err('psep', 'Separator pressure must be above 0 and no more than 30,000 psia (or leave both separator fields blank).');
            if (!(_fin(tsep) && tsep >= -40 && tsep <= 700)) err('tsep', 'Separator temperature must be between -40 and 700 °F (or leave both separator fields blank).');
        }
        var L = _lib();
        if (!L) { errors.push('The PVT correlation library (PRiSM) is not loaded.'); keys.push('lib'); }
        if (errors.length) return { ok: false, errors: errors, keys: keys, bad: bad };

        var yco2 = co2 / 100, yh2s = h2s / 100, yn2 = n2 / 100;
        var pc = pseudoCriticals(sg, yco2, yh2s, yn2);
        if (!(pc.sgHc >= 0.55)) {
            return { ok: false, bad: ['sg'], keys: ['sghc'], errors: ['Gas gravity ' + _fmt(sg, 3) + ' is too low for the stated CO2/H2S/N2: the hydrocarbon part would be lighter than methane (gravity ' + _fmt(pc.sgHc, 3) + ').'] };
        }
        var TR = t + RANKINE;
        var imp = { co2: yco2, h2s: yh2s, n2: yn2 };
        var st = _state(L, pc, sg, p, t, true, imp);
        if (!(_fin(st.zDAK) && _fin(st.zHY) && pc.Tpc > 0 && TR / pc.Tpc >= 1.0)) {
            return { ok: false, bad: ['t'], keys: ['tpc'], tpcF: pc.Tpc - RANKINE, errors: ['Temperature is below the pseudo-critical temperature (' + _fmt(pc.Tpc - RANKINE, 1) + ' °F); the gas correlations do not apply (Tpr must be at least 1.0).'] };
        }
        var hc = heatCapacity(pc.sgHc, t, yco2, yh2s, yn2);
        var M = MW_AIR * sg;
        // Real-gas Cp, Cv, k and speed of sound from the DAK departure functions.
        var rg = realGas(L, st.Tpr, st.Ppr, hc.cp);
        var c = Math.sqrt(rg.k * GC * st.z * R_FT_LBF * TR / (M * rg.compFactor));
        // Before v3.0: c = √(k°·Z·g_c·R·T/M) with the ideal-gas k° (kept for comparison).
        var cIdealK = Math.sqrt(hc.k * st.z * GC * R_FT_LBF * TR / M);

        var warnings = [];
        if (st.Tpr < 1.05 || st.Tpr > 3.0) warnings.push('Tpr = ' + _fmt(st.Tpr, 3) + ' is outside 1.05–3.0, the range the Z correlations were fitted over.');
        if (st.Ppr > 15) warnings.push('Ppr = ' + _fmt(st.Ppr, 2) + ' is above 15; Z is extrapolated beyond the Standing–Katz chart.');
        if (pc.sgHc < 0.57 || pc.sgHc > 1.68) warnings.push('Hydrocarbon gravity ' + _fmt(pc.sgHc, 3) + ' is outside the Sutton data range (0.57–1.68).');
        if (yco2 > 0.544 || yh2s > 0.738) warnings.push('CO2 or H2S is above the Wichert–Aziz data range (CO2 54.4 %, H2S 73.8 %).');
        if (Math.abs(st.zDiffPct) >= 1) warnings.push('DAK and Hall–Yarborough differ by ' + _fmt(Math.abs(st.zDiffPct), 2) + ' %.');

        // Z vs pressure at T (both correlations).
        var pMax = _niceMax(Math.max(1.5 * p, 1000)), table = [], curve = [];
        var N = 40;
        for (var k = 0; k <= N; k++) {
            var pk = k === 0 ? P_SC : pMax * k / N;
            var zb = _zBoth(L, TR / pc.Tpc, pk / pc.Ppc);
            curve.push({ p: pk, zDAK: zb.dak, zHY: zb.hy });
            if (k % 4 === 0) table.push({ p: pk, Ppr: pk / pc.Ppc, zDAK: zb.dak, zHY: zb.hy, Bg_ft3scf: P_SC * zb.dak * TR / (T_SC * pk) });
        }

        // Separator point: the same Tpr ≥ 1.0 limit as the main point (below the
        // pseudo-critical temperature DAK/HY return a liquid-like root, e.g. γ 1.2 at
        // −40 °F: Tpr 0.87, Z 0.25, 31 lb/ft³), plus the same range warnings.
        var sep = null;
        if (sepGiven) {
            sep = _state(L, pc, sg, psep, tsep, false, imp);
            if (!(_fin(sep.zDAK) && _fin(sep.zHY) && sep.Tpr >= 1.0)) {
                return { ok: false, bad: ['tsep'], keys: ['tsepTpc'], tpcF: pc.Tpc - RANKINE, errors: ['Separator temperature is below the pseudo-critical temperature (' + _fmt(pc.Tpc - RANKINE, 1) + ' °F); the gas correlations do not apply (Tpr must be at least 1.0).'] };
            }
            if (sep.Tpr < 1.05) warnings.push('Separator Tpr = ' + _fmt(sep.Tpr, 3) + ' is below 1.05, the lower limit of the range the Z correlations were fitted over.');
            if (sep.Ppr > 15) warnings.push('Separator Ppr = ' + _fmt(sep.Ppr, 2) + ' is above 15; Z is extrapolated beyond the Standing–Katz chart.');
        }

        return {
            ok: true, sg: sg, p: p, t: t, co2: co2, h2s: h2s, n2: n2, M: M,
            sgHc: pc.sgHc, TpcHc: pc.TpcHc, PpcHc: pc.PpcHc, TpcM: pc.TpcM, PpcM: pc.PpcM,
            eps: pc.eps, Tpc: pc.Tpc, Ppc: pc.Ppc, sour: (yco2 + yh2s) > 0,
            Tpr: st.Tpr, Ppr: st.Ppr, zDAK: st.zDAK, zHY: st.zHY, zDiff: st.zDiff, zDiffPct: st.zDiffPct, z: st.z,
            Bg_ft3scf: st.Bg_ft3scf, Bg_rbMscf: st.Bg_rbMscf, E: st.E, rho: st.rho, mu: st.mu,
            cg: st.cg, cpr: st.cpr, cp: hc.cp, cv: hc.cv, k: hc.k, c: c, cIdealK: cIdealK,
            cpReal: rg.cp, cvReal: rg.cv, kReal: rg.k, cpRes: rg.cpRes,
            muLGE: st.muLGE, muDelta: st.muDelta,
            sep: sep, table: table, curve: curve, pMax: pMax, warnings: warnings
        };
    }

    G.WTS_gaspvt_compute = compute;
    G.WTS_gaspvt_pseudoCriticals = pseudoCriticals;
    G.WTS_gaspvt_viscosity = function (sg, tF, Z, p, yco2, yh2s, yn2) { var L = _lib(); return L ? viscosity(L, sg, tF, Z, p, yco2, yh2s, yn2) : null; };
    G.WTS_gaspvt_standingDelta = standingDelta;
    G.WTS_gaspvt_k = function (sg, tF, yco2, yh2s, yn2) {
        var pc = pseudoCriticals(sg, yco2 || 0, yh2s || 0, yn2 || 0);
        return pc ? heatCapacity(pc.sgHc, tF, yco2 || 0, yh2s || 0, yn2 || 0).k : NaN;
    };

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Gas PVT';
    var SUB = 'Z-factor (DAK and Hall–Yarborough), Bg, density, viscosity, cg and speed of sound, with sour-gas correction';
    var UNITS = {
        gp_sg: 'sg', gp_p: 'pressure', gp_t: 'temperature',
        gp_co2: 'percent', gp_h2s: 'percent', gp_n2: 'percent',
        gp_psep: 'pressure', gp_tsep: 'temperature'
    };
    var IDS = { sum: 'gp_co2', sg: 'gp_sg', p: 'gp_p', t: 'gp_t', co2: 'gp_co2', h2s: 'gp_h2s', n2: 'gp_n2', psep: 'gp_psep', tsep: 'gp_tsep' };
    // Validation messages in the display system (limits are imperial).
    var MSG = {
        p: function () { return 'Pressure must be above 0 and no more than ' + _u(30000, 'pressure', 0, 'psia') + '.'; },
        t: function () { return 'Temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(700, 'temperature', 0, '°F') + '.'; },
        psep: function () { return 'Separator pressure must be above 0 and no more than ' + _u(30000, 'pressure', 0, 'psia') + ' (or leave both separator fields blank).'; },
        tsep: function () { return 'Separator temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(700, 'temperature', 0, '°F') + ' (or leave both separator fields blank).'; },
        tpc: function (r) { return 'Temperature is below the pseudo-critical temperature (' + _u(r.tpcF, 'temperature', 1, '°F') + '); the gas correlations do not apply (Tpr must be at least 1.0).'; },
        tsepTpc: function (r) { return 'Separator temperature is below the pseudo-critical temperature (' + _u(r.tpcF, 'temperature', 1, '°F') + '); the gas correlations do not apply (Tpr must be at least 1.0).'; }
    };

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }

    function _resultsHtml(r) {
        var h = '';
        // 1 — pseudo-criticals
        h += '<div class="rbox"><div class="rbox-title">Pseudo-critical Properties</div>' +
            _row('Apparent molecular weight', _fmt(r.M, 2) + ' lb/lb-mol') +
            _row('Hydrocarbon gas gravity', _fmt(r.sgHc, 4)) +
            _row('Tpc, hydrocarbon (Sutton)', _u(r.TpcHc, 'tempAbsolute', 1, '°R')) +
            _row('Ppc, hydrocarbon (Sutton)', _u(r.PpcHc, 'pressure', 1, 'psia')) +
            _row('Wichert–Aziz ε', _u(r.eps, 'tempAbsolute', 2, '°R')) +
            _row('Tpc, corrected', _u(r.Tpc, 'tempAbsolute', 1, '°R')) +
            _row('Ppc, corrected', _u(r.Ppc, 'pressure', 1, 'psia')) +
            _row('Tpr', _fmt(r.Tpr, 4)) +
            _row('Ppr', _fmt(r.Ppr, 4)) +
            '</div>';
        // 2 — Z both ways
        var agree = Math.abs(r.zDiffPct) < 1;
        h += '<div class="rbox"><div class="rbox-title">Z-factor</div>' +
            _row('Z, Dranchuk–Abou-Kassem', _fmt(r.zDAK, 4)) +
            _row('Z, Hall–Yarborough', _fmt(r.zHY, 4)) +
            _row('Difference (HY − DAK)', (r.zDiff >= 0 ? '+' : '') + _fmt(r.zDiff, 4) + ' (' + (r.zDiffPct >= 0 ? '+' : '') + _fmt(r.zDiffPct, 2) + ' %)') +
            (agree ? _ok('DAK and Hall–Yarborough agree within 1 %.') : _warn('DAK and Hall–Yarborough differ by ' + _fmt(Math.abs(r.zDiffPct), 2) + ' %; check the Tpr/Ppr range.')) +
            '</div>';
        // 3 — gas properties (DAK Z)
        var met = _metric();
        h += '<div class="rbox"><div class="rbox-title">Gas Properties</div>' +
            _row('Bg', met ? _sig(r.Bg_ft3scf, 4) + ' rm³/sm³' : _sig(r.Bg_ft3scf, 4) + ' ft³/scf') +
            _row('Bg (reservoir barrels)', met ? _sig(r.Bg_ft3scf * 1000, 4) + ' rm³/10³ sm³' : _sig(r.Bg_rbMscf, 4) + ' rb/Mscf') +
            _row('Expansion factor E', _sig(r.E, 4) + (met ? ' sm³/rm³' : ' scf/ft³')) +
            _row('Gas density', _us(r.rho, 'density', 4, 'lb/ft³')) +
            _row('Viscosity (Lee–Gonzalez–Eakin)', _us(r.mu, 'viscosity', 4, 'cp')) +
            ((r.co2 + r.h2s + r.n2) > 0 ? _row('Standing N2/CO2/H2S viscosity correction (included)', (r.muDelta >= 0 ? '+' : '') + _us(r.muDelta, 'viscosity', 3, 'cp')) : '') +
            _row('Gas compressibility cg', _us(r.cg, 'compressibility', 4, '1/psi')) +
            _row('Pseudo-reduced compressibility cpr', _sig(r.cpr, 4)) +
            _row('Cp/Cv (k), ideal gas', _fmt(r.k, 4)) +
            _row('Cp/Cv (k), real gas at p and T', _fmt(r.kReal, 4)) +
            _row('Speed of sound', _u(r.c, 'velocity', 1, 'ft/s')) +
            _row('Speed of sound with ideal-gas k (pre-v3.0 method)', _u(r.cIdealK, 'velocity', 1, 'ft/s')) +
            '</div>';
        // 4 — separator
        if (r.sep) {
            var s = r.sep;
            h += '<div class="rbox"><div class="rbox-title">At Separator Conditions</div>' +
                _row('Separator pressure', _u(s.p, 'pressure', 1, 'psia')) +
                _row('Separator temperature', _u(s.t, 'temperature', 1, '°F')) +
                _row('Z, Dranchuk–Abou-Kassem', _fmt(s.zDAK, 4)) +
                _row('Z, Hall–Yarborough', _fmt(s.zHY, 4)) +
                _row('Bg', met ? _sig(s.Bg_ft3scf, 4) + ' rm³/sm³' : _sig(s.Bg_ft3scf, 4) + ' ft³/scf') +
                _row('Gas density', _us(s.rho, 'density', 4, 'lb/ft³')) +
                _row('Viscosity (Lee–Gonzalez–Eakin)', _us(s.mu, 'viscosity', 4, 'cp')) +
                _row('Supercompressibility Fpv = √(1/Z)', _fmt(s.Fpv, 4)) +
                '</div>';
        }
        // 5 — verdicts
        var v = '';
        for (var i = 0; i < r.warnings.length; i++) v += _warn(r.warnings[i]);
        if (r.sour) v += _warn('Sour gas: Wichert–Aziz correction applied (ε = ' + _u(r.eps, 'tempAbsolute', 1, '°R') + ').');
        if (!r.warnings.length) v += _ok('Inputs are inside the fitted range of the correlations.');
        h += '<div class="rbox"><div class="rbox-title">Checks</div>' + v + '</div>';
        // 6 — Z vs pressure
        h += '<div class="rbox"><div class="rbox-title">Z vs Pressure at ' + _u(r.t, 'temperature', 1, '°F') + '</div>' +
            '<div style="overflow-x:auto"><table class="dtable"><thead><tr><th>Pressure (' + _lab('pressure', 'psia') + ')</th><th>Ppr</th>' +
            '<th>Z (DAK)</th><th>Z (HY)</th><th>Bg (' + (met ? 'rm³/sm³' : 'ft³/scf') + ')</th></tr></thead><tbody>';
        for (var j = 0; j < r.table.length; j++) {
            var t = r.table[j];
            h += '<tr><td>' + _fmt(_dv(t.p, 'pressure'), 0) + '</td><td>' + _fmt(t.Ppr, 3) + '</td><td>' + _fmt(t.zDAK, 4) +
                '</td><td>' + _fmt(t.zHY, 4) + '</td><td>' + _sig(t.Bg_ft3scf, 4) + '</td></tr>';
        }
        h += '</tbody></table></div>' +
            '<div class="chart-wrap"><canvas id="gp_chart" width="600" height="320"></canvas></div></div>';
        // 7 — notes
        h += '<div><b>Notes</b> Pseudo-criticals: Sutton (1985) for the hydrocarbon part, Kay mixing for N2, CO2 and H2S, ' +
            'then the Wichert–Aziz (1972) correction. Bg, density, viscosity, cg and the speed of sound use the DAK Z. ' +
            'Standard conditions 14.696 psia and 60 °F. Viscosity is Lee–Gonzalez–Eakin at the total gas gravity; with N2, CO2 or ' +
            'H2S the Standing (1981) corrections (Carr–Kobayashi–Burrows chart inserts) are added to the low-pressure term and ' +
            'scaled by the same dense-gas ratio (v3.0; before, no impurity correction). Ideal k is Cp°/Cv° at the flowing ' +
            'temperature: Cp° of a paraffin gas of the hydrocarbon molecular weight (interpolated between methane, ethane and ' +
            'propane) mixed with N2, CO2 and H2S (Reid–Prausnitz–Poling heat capacities). Real-gas k adds the departure ' +
            'functions of the DAK Z (numerical derivatives and integration: Cp − Cp° = −R∫[2T·Z_T + T²·Z_TT]dp/p, ' +
            'Cp − Cv = R(Z + T·Z_T)²/(Z − p·Z_p)). Speed of sound c = √(k·(∂p/∂ρ)_T) with the real-gas k (v3.0; the ' +
            'pre-v3.0 √(k°·Z·R·T/M) understated c by up to ≈ 10 % at high pressure; methane at 100 °F, 2,015 psia: NIST ' +
            '1,552 ft/s). Fpv takes base Z as 1.</div>';
        return h;
    }

    function _drawChart(r) {
        var cv = _byId('gp_chart');
        if (!cv || typeof drawLineChart !== 'function') return;   // host-scope helper when injected
        var dak = [], hy = [];
        for (var i = 0; i < r.curve.length; i++) {
            var q = r.curve[i], x = _dv(q.p, 'pressure');
            if (_fin(q.zDAK)) dak.push({ x: x, y: q.zDAK });
            if (_fin(q.zHY)) hy.push({ x: x, y: q.zHY });
        }
        var ds = [
            { label: 'DAK', color: '#f0883e', data: dak, points: false, width: 2 },
            { label: 'Hall–Yarborough', color: '#58a6ff', data: hy, points: false, dash: [6, 4], width: 2 },
            { label: 'Given pressure', color: '#3fb950', data: [{ x: _dv(r.p, 'pressure'), y: r.zDAK }], points: true, width: 0.001 }
        ];
        try {
            drawLineChart(cv, ds, { xLabel: 'Pressure (' + _lab('pressure', 'psia') + ')', yLabel: 'Z', xMin: 0, xDec: 0, yDec: 2 });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _readInputs() {
        return {
            sg: _num('gp_sg'), p: _num('gp_p'), t: _num('gp_t'),
            co2: _num('gp_co2'), h2s: _num('gp_h2s'), n2: _num('gp_n2'),
            psep: _num('gp_psep'), tsep: _num('gp_tsep')
        };
    }

    function _calcImpl() {
        var root = _byId('gp_root'), res = _byId('gp_res');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');
        var inp = _readInputs();
        // Blank impurity fields mean 0 mol %.
        ['co2', 'h2s', 'n2'].forEach(function (k) { if (!_fin(inp[k])) { var e = _byId(IDS[k]); if (e && String(e.value).trim() === '') inp[k] = 0; } });
        var r = compute(inp);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.gaspvt = { ok: false, errors: r.errors.slice(), z: null, ts: Date.now() };
            var items = '';
            for (var j = 0; j < r.errors.length; j++) {
                var k = r.keys && r.keys[j];
                items += '<li>' + (k && MSG[k] ? MSG[k](r) : r.errors[j]) + '</li>';
            }
            for (var b = 0; b < r.bad.length; b++) { var el = _byId(IDS[r.bad[b]]); if (el && el.classList) el.classList.add('input-err'); }
            if (res) {
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
                res.setAttribute('data-done', '1');
            }
            return r;
        }
        G.WTS_state.gaspvt = {
            ok: true, z: r.z, zDAK: r.zDAK, zHY: r.zHY, Tpc: r.Tpc, Ppc: r.Ppc, Tpr: r.Tpr, Ppr: r.Ppr,
            Bg_ft3scf: r.Bg_ft3scf, Bg_rbMscf: r.Bg_rbMscf, rho: r.rho, mu: r.mu, cg: r.cg, k: r.k, kReal: r.kReal, c: r.c,
            sep: r.sep ? { z: r.sep.z, zDAK: r.sep.zDAK, zHY: r.sep.zHY, Bg_ft3scf: r.sep.Bg_ft3scf, rho: r.sep.rho, mu: r.sep.mu } : null,
            ts: Date.now()
        };
        if (res) {
            res.innerHTML = _resultsHtml(r);
            res.setAttribute('data-done', '1');
            _drawChart(r);
        }
        return r;
    }

    G.calcGasPVT = function () { return _canon(_calcImpl); };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="gp_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Gas and Conditions</div>' +
            '<div class="fg">' +
            _fg('gp_sg', 'Gas gravity (air = 1)', '0.7', ' min="0.55"') +
            _fg('gp_p', 'Pressure, absolute (psia)', '3000', ' min="0"') +
            _fg('gp_t', 'Temperature (°F)', '200') +
            _fg('gp_co2', 'CO2 (mol %)', '0', ' min="0" max="100"') +
            _fg('gp_h2s', 'H2S (mol %)', '0', ' min="0" max="100"') +
            _fg('gp_n2', 'N2 (mol %)', '0', ' min="0" max="100"') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Separator Conditions (optional)</div>' +
            '<div class="fg">' +
            _fg('gp_psep', 'Separator pressure, absolute (psia)', '', ' min="0" placeholder="blank = skip"') +
            _fg('gp_tsep', 'Separator temperature (°F)', '', ' placeholder="blank = skip"') +
            '</div>' +
            '<div class="btn-row"><button class="btn btn-primary" id="gp_calc" onclick="calcGasPVT()">Calculate</button></div>' +
            '</div>' +
            '</div>' +
            '<div id="gp_res"></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('gp_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^gp_/.test(e.target.id || '')) G.calcGasPVT();
            });
        }
        G.calcGasPVT();
    }
    G.renderGasPVT = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.gaspvt = {
        key: 'gaspvt',
        title: TITLE,
        sub: SUB,
        group: 'Fluid & Field Calcs',
        icon: '&#9679;',
        badge: 'PVT',
        bc: 'dc-b-blue',
        desc: 'Z by DAK and Hall–Yarborough, Bg, density, viscosity, cg and speed of sound, with Wichert–Aziz sour-gas correction.',
        render: function (body) { return G.renderGasPVT(body); }
    };

    // Unit flip: recalculate a page that has already shown results.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('gp_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcGasPVT();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (!G.PRiSM_pvt_correlations || typeof G.WTS_gaspvt_compute !== 'function') return;   // needs 16-pvt.js
    var fails = [], n = 0;
    function near(a, b, tol, what) { n++; if (!(isFinite(a) && Math.abs(a - b) <= tol)) fails.push(what + ': got ' + a + ', expected ' + b); }
    var F = G.WTS_gaspvt_compute;
    // Sweet 0.7 gas: Sutton Tpc 377.59 °R, Ppc 663.34 psia
    var a = F({ sg: 0.7, p: 3000, t: 200, co2: 0, h2s: 0, n2: 0 });
    near(a.Tpc, 377.59, 0.01, 'Tpc'); near(a.Ppc, 663.34, 0.01, 'Ppc'); near(a.eps, 0, 1e-12, 'eps sweet');
    near(a.zDAK, a.zHY, 0.01, 'DAK ≈ HY');
    // Standing–Katz chart: Tpr 1.5, Ppr 2 → 0.82 ; Tpr 2.0, Ppr 3 → 0.94
    var L = G.PRiSM_pvt_correlations;
    near(L.Z_dranchukAbouKassem(1.5, 2), 0.82, 0.015, 'SK 1.5/2 DAK'); near(L.Z_hallYarborough(2, 3), 0.94, 0.015, 'SK 2/3 HY');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[gaspvt self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[gaspvt self-test] ' + n + '/' + n + ' checks passed');
    }
})();
