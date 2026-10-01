// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Multiphase Flowline Pressure Drop (flowline)
//
// PURPOSE
//   Steady-state pressure profile of the surface lines of a well test:
//     route 1  wellhead / choke manifold → separator (oil + water + gas),
//     route 2  separator gas outlet → flare tip (separator gas only).
//   Each route is a list of segments (length, inside diameter, elevation
//   change). Each segment is marched in short steps with the pressure
//   gradient evaluated at the step's average pressure and temperature.
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
//   Linear from the inlet to the arrival temperature (default), or a coupled
//   pressure–temperature march: each step loses heat by the Line Heat Loss model
//   (49-calc-lineheat.js WTS_lineheat_ua, bare / insulated pipe in air, inside film
//   neglected): T_out = Ta + (T_in − Ta)·exp(−UA′·dx/(ṁ·cp)) (Holman §10; Incropera
//   §3.3), minus μJT·Δp_step (isenthalpic throttling), and the step's pressure
//   gradient is evaluated at the step's mean temperature (3 fixed-point passes).
//   Gas rate = separator gas at standard conditions (22-units WTS_baseConditions,
//   default 60 °F / 14.696 psia). Free gas = qg − qo·Rs.
//
// PUBLIC API (window.*)
//   WTS_flowline_bb(input)        Beggs & Brill gradient at one point (no PVT)
//   WTS_flowline_props(fluid, p, t)  in-situ fluid properties
//   WTS_flowline_compute(input)   full routes → {ok, routes[], …} or {ok:false, errors, bad}
//   WTS_flowline_march(segments, fluid, p0, t0, t1, opt)  pressure traverse (opt.reverse = against the flow)
//   renderFlowline(body), calcFlowline(), WTS_flowlineUseHeat()
//
// STATE  WTS_state.flowline = {pArr, dpSep, pFlare, dpFlare, ok, ts, result}
// Registers window.WTS_calcRegistry.flowline (group "Well Test & Flowlines").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var GRAV = 32.174, GC = 32.174;         // ft/s², lbm·ft/(lbf·s²)
    var PATM = 14.696;                      // psia
    var MW_AIR = 28.9647, R_GAS = 10.7316;  // lb/lb-mol, psia·ft³/(lb-mol·°R)
    var RANK = 459.67;
    var FT3_BBL = 5.614583;
    var RHO_W = 62.366;                     // lb/ft³, fresh water at 60 °F
    var PSIFT_KPAM = 6.894757 / 0.3048;     // kPa/m per psi/ft
    var NSEG_W = 6, NSEG_F = 4;

    // ── Helpers ─────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
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
    // fluid = {qo STB/d, qw BWPD, qg MMSCFD, api, sgg, sgw}; p psia; t °F
    function props(fluid, p, t) {
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
    function _steps(len) { return Math.min(400, Math.max(10, Math.ceil(len / 50))); }
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
    function march(route, fluid, p0g, t0, t1, opt) {
        var segs = route.segments, total = 0;
        segs.forEach(function (s) { total += s.len; });
        var P = p0g + PATM, x = 0, out = [], profile = [], lost = null;
        var first = null, heat = opt.heat || null, Tc = t0, sgn = opt.reverse ? -1 : 1;
        function pt(xx) { return heat ? Tc : (total > 0 ? t0 + (t1 - t0) * xx / total : t0); }
        function gAt(pp, tt, s) {
            var pr = props(fluid, pp, tt), A = Math.PI * Math.pow(s.id / 12, 2) / 4;
            var g = bb({
                vsl: pr.qL / A, vsg: pr.qG / A, d: s.id, rhoL: pr.rhoL, rhoG: pr.rhoG, muL: pr.muL, muG: pr.mug,
                sigma: pr.sigL, theta: s.theta, rough: opt.rough, p: pp, payne: opt.payne, accel: opt.accel
            });
            g.props = pr;
            return g;
        }
        profile.push({ x: 0, p: P - PATM, t: t0 });
        for (var k = 0; k < segs.length && !lost; k++) {
            var s = segs[k];
            s.theta = s.len > 0 ? Math.asin(Math.max(-1, Math.min(1, s.dz / s.len))) * 180 / Math.PI : 0;
            var n = _steps(s.len), dx = s.len / n;
            var r = { name: s.name, len: s.len, id: s.id, dz: s.dz, theta: s.theta, pIn: P - PATM, tIn: pt(x),
                dpEl: 0, dpF: 0, dpAcc: 0, patterns: [], hlIn: null, hlOut: null, vmMax: 0, eroMax: 0 };
            for (var j = 0; j < n; j++) {
                var ta = pt(x), tb = heat ? _heatStep(heat, s, ta, dx, 0) : pt(x + dx), tm = (ta + tb) / 2;
                var g = gAt(P, ta, s);
                if (j === 0) { r.hlIn = g.hl; r.in = g; if (!first) first = g; }
                var P2 = P - sgn * g.grad * dx;
                for (var it = 0; it < 3; it++) {
                    if (heat && _fin(P2)) { tb = _heatStep(heat, s, ta, dx, sgn * (P - Math.max(P2, PATM))); tm = (ta + tb) / 2; }
                    var pm = (P + Math.max(P2, 1)) / 2;
                    g = gAt(pm, tm, s);
                    P2 = P - sgn * g.grad * dx;
                }
                if (heat && _fin(P2)) tb = _heatStep(heat, s, ta, dx, sgn * (P - Math.max(P2, PATM)));
                if (!_fin(P2) || P2 < PATM || g.Ek >= 0.95) {
                    lost = { seg: k, x: x, reason: g.Ek >= 0.95 ? 'critical' : 'pressure' };
                    break;
                }
                r.dpEl += g.gradEl * dx; r.dpF += g.gradF * dx; r.dpAcc += g.gradAcc * dx;
                if (r.patterns.indexOf(g.pattern) === -1) r.patterns.push(g.pattern);
                r.hlOut = g.hl; r.out = g;
                if (g.vm > r.vmMax) r.vmMax = g.vm;
                var ve = g.rhoN > 0 ? 100 / Math.sqrt(g.rhoN) : Infinity;       // API RP 14E, C = 100
                if (g.vm / ve > r.eroMax) r.eroMax = g.vm / ve;
                P = P2; x += dx; Tc = tb;
                profile.push({ x: x, p: P - PATM, t: tb, hl: g.hl, pattern: g.pattern });
            }
            r.pOut = lost ? null : P - PATM;
            r.dp = lost ? null : r.pIn - r.pOut;
            r.tOut = pt(x);
            out.push(r);
        }
        return { segments: out, profile: profile, pIn: p0g, pOut: lost ? null : P - PATM, dp: lost ? null : p0g - (P - PATM),
            length: total, lost: lost, inlet: first, tIn: t0, tOut: lost ? null : pt(x), coupled: !!heat };
    }

    var PAT_NAME = { segregated: 'Segregated', transition: 'Transition', intermittent: 'Intermittent', distributed: 'Distributed',
        gas: 'Single-phase gas', liquid: 'Single-phase liquid', none: 'No flow' };

    // input = {qo, qw, qg, api, sgg, sgw, pwh psig, t0, t1 °F, psep psig, rough in, payne, accel,
    //          well: [{name,len,id,dz}], flare: [{name,len,id,dz}],
    //          tmode 'linear' (default: T linear t0 → t1) | 'heat' (coupled P–T march; t1 ignored) with
    //          tair °F, wind mph, eps, wall in, ins in (0 = bare), kp, kins Btu/hr·ft·°F, cpo, cpw, cpg Btu/lb·°F,
    //          jt °F/psi}
    function compute(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var qo = +i.qo, qw = +i.qw, qg = +i.qg, api = +i.api, sgg = +i.sgg, sgw = +i.sgw;
        var pwh = +i.pwh, t0 = +i.t0, t1 = +i.t1, psep = +i.psep, rough = +i.rough;
        var rOk = need(_fin(qo) && qo >= 0 && qo <= 200000, 'qo', 'Oil rate must be between 0 and 200,000 STB/d.');
        rOk = need(_fin(qw) && qw >= 0 && qw <= 200000, 'qw', 'Water rate must be between 0 and 200,000 BWPD.') && rOk;
        rOk = need(_fin(qg) && qg >= 0 && qg <= 500, 'qg', 'Gas rate must be between 0 and 500 MMSCFD.') && rOk;
        if (rOk) need(qo + qw + qg > 0, 'qo', 'Enter at least one non-zero rate.');
        need(_fin(api) && api >= 10 && api <= 70, 'api', 'Oil gravity must be between 10 and 70 °API.');
        need(_fin(sgg) && sgg >= 0.55 && sgg <= 1.5, 'sgg', 'Gas gravity must be between 0.55 and 1.5.');
        need(_fin(sgw) && sgw >= 0.95 && sgw <= 1.3, 'sgw', 'Water specific gravity must be between 0.95 and 1.3.');
        need(_fin(pwh) && pwh > 0 && pwh <= 15000, 'pwh', 'Line inlet pressure must be above 0 and no more than 15,000 psig.');
        need(_fin(t0) && t0 >= 0 && t0 <= 400, 't0', 'Inlet temperature must be between 0 and 400 °F.');
        need(i.tmode === 'heat' || (_fin(t1) && t1 >= 0 && t1 <= 400), 't1', 'Arrival temperature must be between 0 and 400 °F.');
        need(_fin(psep) && psep >= 0 && psep <= 15000, 'psep', 'Separator pressure must be between 0 and 15,000 psig.');
        need(_fin(rough) && rough >= 0 && rough <= 0.1, 'rough', 'Pipe roughness must be between 0 and 0.1 in.');
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
            if (req && !o.length) need(false, pre + '1_len', 'Enter at least one wellhead-to-separator segment (length and inside diameter).');
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
        function heatFor(f) {
            if (!coupled) return null;
            var mf = G.WTS_lineheat_massFlow({ qo: f.qo, qw: f.qw, qg: f.qg, api: api, sgg: sgg, sgw: sgw, cpo: H.cpo, cpw: H.cpw, cpg: H.cpg });
            // Inside film neglected (hi blank on the Line Heat Loss page): conservative, more heat lost.
            return { mcp: mf.mcp, m: mf.m, jt: H.jt, wall: H.wall, ins: H.ins,
                env: { hi: 0, kp: H.kp, kins: H.kins, eps: H.eps, tair: H.tair, wind: H.wind, tsoil: H.tair, ksoil: 1 } };
        }
        var fluid = { qo: qo, qw: qw, qg: qg, api: api, sgg: sgg, sgw: sgw };
        var r1 = march({ segments: well }, fluid, pwh, t0, t1, Object.assign({ heat: heatFor(fluid) }, opt));
        r1.key = 'well'; r1.name = 'Wellhead to separator';
        r1.reaches = r1.pOut != null && r1.pOut >= psep - 1e-9;
        r1.margin = r1.pOut != null ? r1.pOut - psep : null;
        var r2 = null;
        if (flare.length && qg > 0) {
            var gasOnly = { qo: 0, qw: 0, qg: qg, api: api, sgg: sgg, sgw: sgw }, tSep = coupled && r1.tOut != null ? r1.tOut : t1;
            r2 = march({ segments: flare }, gasOnly, psep, tSep, tSep, Object.assign({ heat: heatFor(gasOnly) }, opt));
            r2.key = 'flare'; r2.name = 'Separator to flare';
            r2.reaches = r2.pOut != null && r2.pOut > 0;
        }
        var warnings = [];
        [r1, r2].forEach(function (r) {
            if (!r) return;
            r.segments.forEach(function (s) {
                if (s.eroMax > 1) warnings.push(r.name + ', ' + s.name + ': mixture velocity is ' + _fmt(100 * s.eroMax, 0) + ' % of the API RP 14E erosional velocity (C = 100).');
            });
        });
        return {
            ok: true, routes: [r1].concat(r2 ? [r2] : []), well: r1, flare: r2, psep: psep,
            inlet: r1.inlet ? r1.inlet.props : null, inletBB: r1.inlet, fluid: fluid, opt: opt, warnings: warnings,
            flareSkipped: flare.length && !(qg > 0), coupled: coupled, heat: H,
            tArr: r1.tOut != null ? r1.tOut : null
        };
    }

    G.WTS_flowline_bb = bb;
    G.WTS_flowline_props = function (fluid, p, t) { return _lib() ? props(fluid, p, t) : null; };
    G.WTS_flowline_compute = compute;
    // Pressure traverse along a list of segments (used by the gas-lift design page, 49-calc-gaslift.js):
    //   segments [{name, len ft, id in, dz ft (+ = flow goes up)}], fluid {qo, qw, qg MMSCFD, api, sgg, sgw},
    //   p0 psig at the start of the march, t0 → t1 °F linear along the march, opt {rough in, payne, accel,
    //   reverse: march against the flow direction (e.g. down a producing tubing from the wellhead)}.
    //   → {profile [{x, p psig, t, hl, pattern}], segments[], pOut, lost, …}, or null without the PVT library.
    G.WTS_flowline_march = function (segments, fluid, p0, t0, t1, opt) {
        if (!_lib()) return null;
        var segs = (segments || []).map(function (q) { return { name: q.name || '', len: +q.len, id: +q.id, dz: +q.dz || 0 }; });
        var o = opt || {};
        return march({ segments: segs }, fluid, +p0, +t0, (t1 == null ? +t0 : +t1),
            { rough: o.rough == null ? 0.0018 : +o.rough, payne: o.payne !== false, accel: !!o.accel, reverse: !!o.reverse });
    };
    G.WTS_flowline_friction = { smooth: fSmooth, colebrook: fColebrook };
    G.WTS_flowline_sigma = { oil: sigmaOil, water: sigmaWater };

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Multiphase Flowline Pressure Drop';
    var SUB = 'Beggs & Brill with Payne corrections: flow pattern, holdup, elevation, friction and acceleration, segment by segment from the wellhead to the separator and the flare';
    var UNITS = {
        fl_qo: 'liquidRate', fl_qw: 'liquidRate', fl_qg: 'gasRate', fl_api: 'api', fl_sgg: 'sg', fl_sgw: 'sg',
        fl_pwh: 'pressureG', fl_t0: 'temperature', fl_t1: 'temperature', fl_psep: 'pressureG', fl_rough: 'lengthSmall',
        fl_tair: 'temperature', fl_wind: 'windSpeed', fl_wall: 'lengthSmall', fl_ins: 'lengthSmall',
        fl_kp: 'thermalConductivity', fl_kins: 'thermalConductivity', fl_cpo: 'specificHeat', fl_cpw: 'specificHeat',
        fl_cpg: 'specificHeat', fl_jt: 'jtCoefficient'
    };
    function _segIds(pre, n) {
        var o = [];
        for (var k = 1; k <= n; k++) o.push({ name: 'fl_' + pre + k + '_name', len: 'fl_' + pre + k + '_len', id: 'fl_' + pre + k + '_id', dz: 'fl_' + pre + k + '_dz' });
        return o;
    }
    var WELL_IDS = _segIds('w', NSEG_W), FLARE_IDS = _segIds('f', NSEG_F);
    var DEF_W = [['Choke manifold to heater', 150, 2.9, 0], ['Heater to separator', 250, 2.9, 5], ['Separator inlet riser', 20, 2.9, 15]];
    var DEF_F = [['Separator to knock-out drum', 300, 3.826, 0], ['Flare line and boom', 200, 3.826, 25]];

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
        pwh: function () { return 'Line inlet pressure must be above 0 and no more than ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        psep: function () { return 'Separator pressure must be between 0 and ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        t0: function () { return 'Inlet temperature must be between ' + _u(0, 'temperature', 0, '°F') + ' and ' + _u(400, 'temperature', 0, '°F') + '.'; },
        t1: function () { return 'Arrival temperature must be between ' + _u(0, 'temperature', 0, '°F') + ' and ' + _u(400, 'temperature', 0, '°F') + '.'; },
        rough: function () { return 'Pipe roughness must be between 0 and ' + _u(0.1, 'lengthSmall', 1, 'in', 2) + '.'; },
        tair: function () { return 'Air temperature must be between ' + _u(-60, 'temperature', 0, '°F') + ' and ' + _u(140, 'temperature', 0, '°F') + '.'; }
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
                items += '<li>' + (MSG[k] ? MSG[k]() : r.errors[n]) + '</li>';
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
        var vel = function (v) { return _u(v, 'velocity', 2, 'ft/s'); };
        var dens = function (v) { return _u(v, 'density', 2, 'lb/ft³', 1); };
        var h = '';
        var w = r.well, pr = r.inlet, bI = r.inletBB;

        // Summary
        var v = '';
        if (w.lost) v += _bad('Pressure falls to atmospheric ' + (w.lost.reason === 'critical' ? '(critical, choked flow) ' : '') + 'in segment ' + (w.lost.seg + 1) + ': the line cannot carry this rate from the inlet pressure.');
        else if (w.reaches) v += _ok('Arrives at the separator at ' + P(w.pOut) + ', ' + dP(w.margin) + ' above the separator pressure.');
        else v += _bad('Arrival pressure ' + P(w.pOut) + ' is below the separator pressure ' + P(r.psep) + ': raise the inlet pressure, open the choke or use a larger line.');
        if (r.flare) {
            if (r.flare.lost) v += _bad('Flare line: pressure falls to atmospheric in segment ' + (r.flare.lost.seg + 1) + '; the separator cannot vent this gas rate through it.');
            else v += _ok('Flare line: ' + dP(r.flare.dp) + ' from the separator to the flare tip; tip pressure ' + P(r.flare.pOut) + '.');
        } else if (r.flareSkipped) v += _warn('Flare line not calculated: gas rate is zero.');
        r.warnings.forEach(function (x) { v += _warn(x); });
        h += '<div class="rbox"><div class="rbox-title">Line Summary</div>' +
            _row('Line inlet pressure', P(w.pIn)) +
            _row('Arrival pressure at separator', w.pOut == null ? '—' : P(w.pOut)) +
            _row('Pressure drop, wellhead to separator', w.dp == null ? '—' : dP(w.dp)) +
            _row('Line length, wellhead to separator', ft(w.length)) +
            _row('Temperature model', r.coupled ? 'Coupled pressure–temperature march (line heat loss)' : 'Linear, inlet to arrival') +
            (r.coupled ? _row('Arrival temperature at separator, calculated', w.tOut == null ? '—' : T(w.tOut)) : '') +
            (r.flare ? _row('Pressure drop, separator to flare tip', r.flare.dp == null ? '—' : dP(r.flare.dp)) +
                _row('Flare tip pressure', r.flare.pOut == null ? '—' : P(r.flare.pOut)) : '') +
            v + '</div>';

        // Inlet conditions
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

        // Segment tables
        r.routes.forEach(function (rt) {
            h += '<div class="rbox"><div class="rbox-title">Segments: ' + rt.name + '</div>' +
                _tbl(['Segment', 'Length', 'ID', 'Angle', 'Flow pattern', 'Holdup in → out', 'Inlet pressure', 'Outlet pressure',
                    'Elevation', 'Friction', 'Acceleration', 'Total drop', 'Max velocity', 'Erosional ratio', 'Temperature in → out'], rt.segments.map(function (s) {
                    return [s.name, ft(s.len), inch(s.id), _fmt(s.theta, 1) + '°',
                        s.patterns.map(function (p) { return PAT_NAME[p] || p; }).join(' → ') || '—',
                        _fmt(s.hlIn, 3) + ' → ' + _fmt(s.hlOut, 3), P(s.pIn), s.pOut == null ? '—' : P(s.pOut),
                        dP(s.dpEl), dP(s.dpF), dP(s.dpAcc), s.dp == null ? '—' : dP(s.dp), vel(s.vmMax), _fmt(s.eroMax, 2),
                        T(s.tIn) + ' → ' + T(s.tOut)];
                })) + '</div>';
        });

        h += '<div class="rbox"><div class="rbox-title">Pressure vs Distance</div>' +
            '<div class="chart-wrap"><canvas id="fl_chart" width="600" height="320"></canvas></div>' +
            _note('Beggs &amp; Brill (1973) in the form of Brill &amp; Mukherjee (1999). With the Payne et al. (1979) option the holdup is ' +
                'multiplied by 0.924 uphill and 0.685 downhill (horizontal unchanged) and the no-slip friction factor is the rough-pipe ' +
                'Colebrook value; without it the original smooth-pipe factor is used. Holdup is held at or above the no-slip value in ' +
                'horizontal and uphill flow. Fluid properties at each step: Standing Rs and Bo, Beggs-Robinson oil viscosity, DAK Z, ' +
                'Lee-Gonzalez-Eakin gas viscosity, Baker-Swerdloff and Hough surface tensions. Temperature: linear from the inlet to the ' +
                'arrival temperature, or (v3.0 option) a coupled march: each step loses heat by the Line Heat Loss model ' +
                '(T = Ta + (T − Ta)·e^(−UA′·dx/ṁcp), bare or insulated pipe in air, inside film neglected) and cools by μJT × the ' +
                'step pressure drop, and the step pressure drop uses the fluid properties at the step temperature. The flare line ' +
                'carries the separator gas from the separator temperature. ' +
                'Steady state: slugging and terrain surges are not modelled. Erosional ratio = mixture velocity over the API RP 14E ' +
                'velocity with C = 100.') +
            '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
        _drawChart(r);
    }

    function _drawChart(r) {
        var cv = _byId('fl_chart');
        var draw = (typeof drawLineChart === 'function') ? drawLineChart : (typeof G.drawLineChart === 'function' ? G.drawLineChart : null); // eslint-disable-line no-undef
        if (!cv || !draw) return;
        var ds = [], L0 = r.well.length;
        var cols = ['#f0883e', '#58a6ff'];
        r.routes.forEach(function (rt, k) {
            var off = k === 0 ? 0 : L0;
            ds.push({ label: rt.name, color: cols[k], points: false, width: 2,
                data: rt.profile.map(function (q) { return { x: _dv(q.x + off, 'length'), y: _dv(q.p, 'pressureG') }; }) });
        });
        ds.push({ label: 'Separator pressure', color: '#3fb950', points: false, width: 1, dash: [6, 4],
            data: [{ x: 0, y: _dv(r.psep, 'pressureG') }, { x: _dv(L0, 'length'), y: _dv(r.psep, 'pressureG') }] });
        try {
            draw(cv, ds, { xLabel: 'Distance from line inlet (' + _lab('length', 'ft') + ')', yLabel: 'Pressure (' + _lab('pressureG', 'psig') + ')', xMin: 0, xDec: 0, yDec: 0 });
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
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.flowline = {
            ok: !!r.ok,
            pArr: r.ok ? r.well.pOut : null, dpSep: r.ok ? r.well.dp : null,
            pFlare: r.ok && r.flare ? r.flare.pOut : null, dpFlare: r.ok && r.flare ? r.flare.dp : null,
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
            _fg('fl_pwh', 'Line inlet pressure, downstream of the choke (psig)', '600', ' min="0"') +
            _fg('fl_t0', 'Inlet temperature (°F)', '120') +
            _fg('fl_t1', 'Arrival temperature at separator (°F)', '100') +
            _fg('fl_psep', 'Separator operating pressure (psig)', '250', ' min="0"') +
            _fg('fl_rough', 'Pipe roughness (in)', '0.0018', ' min="0"') +
            _sel('fl_payne', 'Payne et al. corrections', [{ v: 'yes', t: 'Yes: holdup factors and rough-pipe friction' }, { v: 'no', t: 'No: original Beggs & Brill' }], 'yes') +
            _sel('fl_accel', 'Acceleration term', [{ v: 'yes', t: 'Include' }, { v: 'no', t: 'Neglect' }], 'yes') +
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
            '<div class="card"><div class="card-title">Segments: Wellhead to Separator</div>' + _segTable('w', WELL_IDS, DEF_W) + '</div>' +
            '<div class="card"><div class="card-title">Segments: Separator to Flare</div>' + _segTable('f', FLARE_IDS, DEF_F) + '</div>' +
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
        desc: 'Beggs & Brill with Payne corrections: flow pattern, holdup and pressure drop per segment from the wellhead to the separator and the flare.',
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
