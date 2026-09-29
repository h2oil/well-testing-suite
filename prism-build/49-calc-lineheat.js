// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Line Heat Loss & Arrival Temperature (lineheat)
//
// PURPOSE
//   Temperature profile along the surface lines of a well test: bare pipe in
//   air, insulated pipe in air, or buried pipe. Joule–Thomson cooling across a
//   choke at the inlet of any segment. Arrival temperature per segment, heat
//   lost, and a hydrate check against the Hydrate Management correlation.
//
// METHOD (field units; convection correlations evaluated in SI)
//   Heat flow per unit length through series resistances (Incropera & DeWitt,
//   "Fundamentals of Heat and Mass Transfer", 6th ed., §3.3.1 eq. 3.33):
//     R' = 1/(hi·π·Di) + ln(Do/Di)/(2π·kp) + ln(Ds/Do)/(2π·kins) + R'out
//     UA' = 1/R'   [Btu/hr·ft·°F];   U (outer surface) = UA'/(π·Ds)
//   Outside, pipe in air: h = hconv + hrad,
//     forced   Churchill & Bernstein (1977), Incropera eq. 7.54:
//              Nu = 0.3 + 0.62 Re^½ Pr^⅓ / [1 + (0.4/Pr)^⅔]^¼ · [1 + (Re/282000)^⅝]^⅘
//     natural  Churchill & Chu (1975), horizontal cylinder, Incropera eq. 9.34:
//              Nu = {0.60 + 0.387 Ra^⅙ / [1 + (0.559/Pr)^(9/16)]^(8/27)}²
//     mixed    Nu³ = NuF³ + NuN³  (Incropera eq. 9.64, n = 3)
//     radiation hrad = ε·σ·(Ts² + Ta²)(Ts + Ta), σ = 0.1714e-8 Btu/hr·ft²·°R⁴
//     air properties at the film temperature, Incropera Table A.4 (250–450 K);
//     the surface temperature Ts is iterated.
//   Buried pipe: conduction shape factor of a cylinder buried in a
//     semi-infinite medium (Incropera Table 4.1 case 2):
//     R'soil = cosh⁻¹(2z/Ds)/(2π·ksoil), z = depth to the pipe centreline,
//     with the undisturbed soil temperature as the sink.
//   Temperature decay (constant UA' over a step, fluid of constant ṁ·cp):
//     T(L) = Ta + (T0 − Ta)·exp(−UA'·L/(ṁ·cp))
//     (e.g. Holman, "Heat Transfer", §10.x; the steady line-heat-loss equation
//     used in pipeline design). Each segment is marched in 20 steps with UA'
//     re-evaluated at each step.
//   Joule–Thomson at a choke: ΔT = μJT·Δp, default μJT = 0.07 °F/psi, the
//   usual "7 °F per 100 psi" rule for natural gas (GPSA Engineering Data Book,
//   Sect. 20, hydrate-formation guidance). The same coefficient is applied to
//   the whole stream (conservative for oil-rich streams; enter a lower value).
//   Mass flow: oil 5.6146·62.366·γo lb/bbl, water 5.6146·62.366·γw, gas from the
//   ideal-gas molar volume at the standard conditions (22-units
//   WTS_baseConditions, default 379.48 scf/lb-mol at 60 °F / 14.696 psia).
//   ṁ·cp = Σ ṁi·cpi with user cp values (no phase change or latent heat).
//   Hydrate temperature: window.WTS_hydrate_temp (25-hydrate.js, Towler &
//   Mokhatab 2005) at the pressure downstream of each choke.
//
// PUBLIC API (window.*)
//   WTS_lineheat_compute(input)   → {ok, segments[], profile[], …} or {ok:false, errors, bad}
//   WTS_lineheat_outsideH(o)      outside film coefficient for a pipe in air
//   WTS_lineheat_air(TK)          air properties (Incropera Table A.4)
//   renderLineHeat(body), calcLineHeat()
//
// STATE  WTS_state.lineheat = {ok, tIn, tArr, hydrateRisk, ts, result}
// Registers window.WTS_calcRegistry.lineheat (group "Well Testing").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var RANK = 459.67, PATM = 14.696;
    var FT3_BBL = 5.614583, RHO_W = 62.366, MW_AIR = 28.9647, R_GAS = 10.7316;
    var SIGMA_SB = 0.1714e-8;                 // Btu/hr·ft²·°R⁴
    var H_SI = 5.678263;                      // W/m²·K per Btu/hr·ft²·°F
    var NSEG = 6, NSTEP = 20, MARGIN = 5;     // hydrate margin warning, °F
    // Air at 1 atm, Incropera Table A.4: T (K), ν (1e-6 m²/s), k (1e-3 W/m·K), Pr
    var AIR = [[250, 11.44, 22.3, 0.720], [300, 15.89, 26.3, 0.707], [350, 20.92, 30.0, 0.700],
        [400, 26.41, 33.8, 0.690], [450, 32.39, 37.3, 0.686]];

    // Unit categories this page needs (merged into WTS_units when absent).
    (function _cats() {
        var U = G.WTS_units, C = U && U.CATEGORIES;
        if (!C) return;
        function add(k, iu, il, f, mu, ml) {
            if (!C[k]) C[k] = { imperial: { unit: iu, label: il, factor: f, offset: 0 }, metric: { unit: mu, label: ml, factor: 1, offset: 0 } };
        }
        add('heatTransferCoef', 'Btu/hr/ft2/F', 'Btu/hr·ft²·°F', H_SI, 'W/m2/K', 'W/m²·K');
        add('thermalConductivity', 'Btu/hr/ft/F', 'Btu/hr·ft·°F', 1.730735, 'W/m/K', 'W/m·K');
        add('specificHeat', 'Btu/lb/F', 'Btu/lb·°F', 4.1868, 'kJ/kg/K', 'kJ/kg·K');
        add('jtCoefficient', 'F/psi', '°F/psi', (5 / 9) / 0.0689476, 'C/bar', '°C/bar');
        add('windSpeed', 'mph', 'mph', 0.44704, 'm/s(wind)', 'm/s');
        add('tempDiff', 'dF', '°F', 5 / 9, 'dC', '°C');
        add('heatFlow', 'Btu/hr', 'Btu/hr', 0.29307107e-3, 'kW', 'kW');
        add('heatLossLength', 'Btu/hr/ft/F', 'Btu/hr·ft·°F', 1.730735, 'W/m/K(UA)', 'W/m·K');
    })();

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
        if (_metric() && U.format && U.CATEGORIES && U.CATEGORIES[cat]) {
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
    function _dv(v, cat) { var U = G.WTS_units; return (_metric() && U && U.format && U.CATEGORIES && U.CATEGORIES[cat]) ? U.format(v, cat).value : v; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _blank(x) { return x == null || x === '' || (typeof x === 'number' && isNaN(x)); }
    function _acosh(x) { return Math.log(x + Math.sqrt(x * x - 1)); }

    // ── Air properties and outside film coefficient ─────────────────
    function air(TK) {
        var T = Math.max(AIR[0][0], Math.min(AIR[AIR.length - 1][0], TK));
        for (var k = 0; k < AIR.length - 1; k++) {
            var a = AIR[k], b = AIR[k + 1];
            if (T <= b[0]) {
                var f = (T - a[0]) / (b[0] - a[0]);
                return { nu: (a[1] + f * (b[1] - a[1])) * 1e-6, k: (a[2] + f * (b[2] - a[2])) * 1e-3, pr: a[3] + f * (b[3] - a[3]) };
            }
        }
        var z = AIR[AIR.length - 1];
        return { nu: z[1] * 1e-6, k: z[2] * 1e-3, pr: z[3] };
    }
    function _K(tF) { return (tF - 32) * 5 / 9 + 273.15; }
    // o = {dFt, windMph, tsF, taF, eps} → {h, hc, hr, nuF, nuN, re, ra}  (h in Btu/hr·ft²·°F)
    function outsideH(o) {
        var D = o.dFt * 0.3048, V = Math.max(0, o.windMph) * 0.44704;
        var ts = _K(o.tsF), ta = _K(o.taF), tf = (ts + ta) / 2;
        var p = air(tf);
        var re = V * D / p.nu;
        var nuF = 0.3 + 0.62 * Math.sqrt(re) * Math.pow(p.pr, 1 / 3) / Math.pow(1 + Math.pow(0.4 / p.pr, 2 / 3), 0.25) *
            Math.pow(1 + Math.pow(re / 282000, 5 / 8), 4 / 5);
        var alpha = p.nu / p.pr;
        var ra = 9.80665 * (1 / tf) * Math.abs(ts - ta) * D * D * D / (p.nu * alpha);
        var nuN = Math.pow(0.60 + 0.387 * Math.pow(ra, 1 / 6) / Math.pow(1 + Math.pow(0.559 / p.pr, 9 / 16), 8 / 27), 2);
        var nu = Math.pow(nuF * nuF * nuF + nuN * nuN * nuN, 1 / 3);
        var hc = nu * p.k / D / H_SI;
        var TsR = o.tsF + RANK, TaR = o.taF + RANK;
        var hr = (o.eps || 0) * SIGMA_SB * (TsR * TsR + TaR * TaR) * (TsR + TaR);
        return { h: hc + hr, hc: hc, hr: hr, nuF: nuF, nuN: nuN, re: re, ra: ra, film: p };
    }

    // ── Overall UA' per foot for one segment at fluid temperature T ──
    function ua(seg, T, e) {
        var Di = seg.di / 12, Do = seg.od / 12, Ds = seg.ds / 12;
        var Ri = e.hi > 0 ? 1 / (e.hi * Math.PI * Di) : 0;
        var Rw = Math.log(Do / Di) / (2 * Math.PI * e.kp);
        var Rins = Ds > Do + 1e-12 ? Math.log(Ds / Do) / (2 * Math.PI * e.kins) : 0;
        var Rin = Ri + Rw + Rins, Ro, ta, ho = null, ts = null;
        if (seg.type === 'buried') {
            ta = e.tsoil;
            Ro = _acosh(2 * seg.depth / Ds) / (2 * Math.PI * e.ksoil);
        } else {
            ta = e.tair;
            ts = T;
            for (var k = 0; k < 60; k++) {
                ho = outsideH({ dFt: Ds, windMph: e.wind, tsF: ts, taF: ta, eps: e.eps });
                Ro = 1 / (ho.h * Math.PI * Ds);
                var q = (T - ta) / (Rin + Ro);
                var tn = T - q * Rin;
                if (Math.abs(tn - ts) < 1e-6) { ts = tn; break; }
                ts = 0.5 * (ts + tn);
            }
            ho = outsideH({ dFt: Ds, windMph: e.wind, tsF: ts, taF: ta, eps: e.eps });
            Ro = 1 / (ho.h * Math.PI * Ds);
        }
        var R = Rin + Ro;
        return { ua: 1 / R, R: R, Ri: Ri, Rw: Rw, Rins: Rins, Ro: Ro, ta: ta, ho: ho, ts: ts, U: 1 / R / (Math.PI * Ds) };
    }

    // ── Pure compute ─────────────────────────────────────────────────
    // input = {qo, qw, qg, api, sgg, sgw, cpo, cpw, cpg, p0 psig, t0 °F, hi (blank = neglected), kp, kins,
    //          eps, tair, wind mph, tsoil, ksoil, jt °F/psi,
    //          segs: [{name, len ft, od in, wall in, ins in, type 'bare'|'ins'|'buried', depth ft, dpc psi}]}
    function compute(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var qo = +i.qo, qw = +i.qw, qg = +i.qg, api = +i.api, sgg = +i.sgg, sgw = +i.sgw;
        var cpo = +i.cpo, cpw = +i.cpw, cpg = +i.cpg, p0 = +i.p0, t0 = +i.t0;
        var hi = _blank(i.hi) ? 0 : +i.hi, kp = +i.kp, kins = +i.kins, eps = +i.eps;
        var tair = +i.tair, wind = +i.wind, tsoil = +i.tsoil, ksoil = +i.ksoil, jt = +i.jt;
        var rOk = true;
        rOk = need(_fin(qo) && qo >= 0 && qo <= 200000, 'qo', 'Oil rate must be between 0 and 200,000 STB/d.') && rOk;
        rOk = need(_fin(qw) && qw >= 0 && qw <= 200000, 'qw', 'Water rate must be between 0 and 200,000 BWPD.') && rOk;
        rOk = need(_fin(qg) && qg >= 0 && qg <= 500, 'qg', 'Gas rate must be between 0 and 500 MMSCFD.') && rOk;
        if (rOk) need(qo + qw + qg > 0, 'qo', 'Enter at least one non-zero rate.');
        need(_fin(api) && api >= 10 && api <= 70, 'api', 'Oil gravity must be between 10 and 70 °API.');
        need(_fin(sgg) && sgg >= 0.55 && sgg <= 1.5, 'sgg', 'Gas gravity must be between 0.55 and 1.5.');
        need(_fin(sgw) && sgw >= 0.95 && sgw <= 1.3, 'sgw', 'Water specific gravity must be between 0.95 and 1.3.');
        need(_fin(cpo) && cpo >= 0.2 && cpo <= 1.2, 'cpo', 'Oil heat capacity must be between 0.2 and 1.2 Btu/lb·°F.');
        need(_fin(cpw) && cpw >= 0.5 && cpw <= 1.2, 'cpw', 'Water heat capacity must be between 0.5 and 1.2 Btu/lb·°F.');
        need(_fin(cpg) && cpg >= 0.2 && cpg <= 1.5, 'cpg', 'Gas heat capacity must be between 0.2 and 1.5 Btu/lb·°F.');
        need(_fin(p0) && p0 >= 0 && p0 <= 15000, 'p0', 'Inlet pressure must be between 0 and 15,000 psig.');
        need(_fin(t0) && t0 >= -40 && t0 <= 400, 't0', 'Inlet temperature must be between -40 and 400 °F.');
        need(_fin(hi) && hi >= 0 && hi <= 5000, 'hi', 'Inside film coefficient must be between 0 and 5,000 Btu/hr·ft²·°F, or blank.');
        need(_fin(kp) && kp > 0 && kp <= 250, 'kp', 'Pipe wall conductivity must be above 0 and no more than 250 Btu/hr·ft·°F.');
        need(_fin(kins) && kins > 0 && kins <= 5, 'kins', 'Insulation conductivity must be above 0 and no more than 5 Btu/hr·ft·°F.');
        need(_fin(eps) && eps >= 0 && eps <= 1, 'eps', 'Surface emissivity must be between 0 and 1.');
        need(_fin(tair) && tair >= -60 && tair <= 140, 'tair', 'Air temperature must be between -60 and 140 °F.');
        need(_fin(wind) && wind >= 0 && wind <= 150, 'wind', 'Wind speed must be between 0 and 150 mph.');
        need(_fin(tsoil) && tsoil >= -40 && tsoil <= 140, 'tsoil', 'Soil temperature must be between -40 and 140 °F.');
        need(_fin(ksoil) && ksoil > 0 && ksoil <= 5, 'ksoil', 'Soil conductivity must be above 0 and no more than 5 Btu/hr·ft·°F.');
        need(_fin(jt) && jt >= -0.1 && jt <= 0.2, 'jt', 'Joule–Thomson coefficient must be between -0.1 and 0.2 °F/psi.');
        var segs = [];
        (i.segs || []).slice(0, NSEG).forEach(function (s, k) {
            var len = +s.len, od = +s.od;
            if (!_fin(len) && !_fin(od)) return;
            var key = 's' + (k + 1), tag = 'Segment ' + (k + 1) + ': ';
            var wall = +s.wall, ins = _blank(s.ins) ? 0 : +s.ins, depth = _blank(s.depth) ? NaN : +s.depth, dpc = _blank(s.dpc) ? 0 : +s.dpc;
            var type = (s.type === 'ins' || s.type === 'buried') ? s.type : 'bare';
            need(_fin(len) && len > 0 && len <= 500000, key + '_len', tag + 'length must be above 0 and no more than 500,000 ft.');
            var odOk = need(_fin(od) && od >= 0.5 && od <= 60, key + '_od', tag + 'pipe OD must be between 0.5 and 60 in.');
            need(_fin(wall) && wall > 0 && (!odOk || wall < od / 2), key + '_wall', tag + 'wall thickness must be above 0 and less than half the OD.');
            need(_fin(ins) && ins >= 0 && ins <= 12, key + '_ins', tag + 'insulation thickness must be between 0 and 12 in.');
            if (type === 'ins') need(ins > 0, key + '_ins', tag + 'an insulated segment needs an insulation thickness.');
            var ds = od + (type === 'bare' ? 0 : 2 * (_fin(ins) ? ins : 0));
            if (type === 'buried') need(_fin(depth) && depth > ds / 24 && depth <= 100, key + '_depth', tag + 'burial depth to the centreline must be more than half the outside diameter and no more than 100 ft.');
            need(_fin(dpc) && dpc >= 0 && dpc <= 15000, key + '_dpc', tag + 'choke pressure drop must be between 0 and 15,000 psi.');
            segs.push({ name: String(s.name || '').trim() || ('Segment ' + (k + 1)), len: len, od: od, wall: wall, di: od - 2 * wall,
                ins: type === 'bare' ? 0 : ins, ds: ds, type: type, depth: depth, dpc: dpc, key: key });
        });
        if (!segs.length) need(false, 's1_len', 'Enter at least one segment (length and pipe OD).');
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var pAt = p0, tot = 0;
        segs.forEach(function (s) { pAt -= s.dpc; tot += s.dpc; });
        if (pAt < 0) return { ok: false, errors: ['The choke pressure drops add up to more than the inlet pressure.'], bad: ['chokes'] };

        // Mass flows (lb/hr) and ṁ·cp (Btu/hr·°F)
        var B = G.WTS_baseConditions, b = (B && B.resolve) ? B.resolve(60, 14.696) : null;
        if (!(b && _fin(b.Tb_F) && _fin(b.Pb_psia))) b = { Tb_F: 60, Pb_psia: 14.696 };
        var vm = R_GAS * (b.Tb_F + RANK) / b.Pb_psia;              // scf/lb-mol
        var go = 141.5 / (131.5 + api);
        var mo = qo * FT3_BBL * RHO_W * go / 24, mw = qw * FT3_BBL * RHO_W * sgw / 24;
        var mg = qg * 1e6 / vm * MW_AIR * sgg / 24;
        var m = mo + mw + mg, mcp = mo * cpo + mw * cpw + mg * cpg;
        var env = { hi: hi, kp: kp, kins: kins, eps: eps, tair: tair, wind: wind, tsoil: tsoil, ksoil: ksoil };
        var hyd = typeof G.WTS_hydrate_temp === 'function' ? G.WTS_hydrate_temp : null;

        var T = t0, P = p0, x = 0, out = [], profile = [{ x: 0, t: t0 }], risk = false, near = false;
        segs.forEach(function (s) {
            var r = { name: s.name, type: s.type, len: s.len, od: s.od, di: s.di, ds: s.ds, ins: s.ins, depth: s.depth, dpc: s.dpc };
            r.tUp = T;
            r.jt = jt * s.dpc;
            T = T - r.jt;
            P = P - s.dpc;
            r.p = P;
            r.tStart = T;
            if (s.dpc > 0) profile.push({ x: x, t: T });
            var dx = s.len / NSTEP, u0 = null, Tstart = T;
            for (var k = 0; k < NSTEP; k++) {
                var u = ua(s, T, env);
                if (!u0) u0 = u;
                T = u.ta + (T - u.ta) * Math.exp(-u.ua * dx / mcp);
                x += dx;
                profile.push({ x: x, t: T });
            }
            r.tOut = T;
            r.q = mcp * (Tstart - T);
            r.ua = u0.ua; r.U = u0.U; r.ta = u0.ta; r.ho = u0.ho ? u0.ho.h : null; r.hc = u0.ho ? u0.ho.hc : null; r.hr = u0.ho ? u0.ho.hr : null;
            r.ts = u0.ts; r.Rsoil = s.type === 'buried' ? u0.Ro : null;
            r.tMin = Math.min(r.tStart, r.tOut);
            r.tHyd = hyd ? hyd(P + PATM, sgg) : null;
            r.margin = r.tHyd != null ? r.tMin - r.tHyd : null;
            r.risk = r.margin != null && r.margin < 0;
            r.near = r.margin != null && !r.risk && r.margin < MARGIN;
            if (r.risk) risk = true; else if (r.near) near = true;
            r.xEnd = x;
            out.push(r);
        });
        // Line inlet for the flowline page: downstream of the last choke (inlet temperature if none).
        var tDown = t0;
        out.forEach(function (s) { if (s.dpc > 0) tDown = s.tStart; });
        return {
            ok: true, segments: out, profile: profile, t0: t0, p0: p0, tIn: tDown, tArr: T, pArr: P, length: x,
            mo: mo, mw: mw, mg: mg, m: m, mcp: mcp, cpMix: mcp / m, gasFrac: mg / m, molarVolume: vm,
            hydrateRisk: risk, hydrateNear: near, hydrateAvailable: !!hyd
        };
    }

    G.WTS_lineheat_compute = compute;
    G.WTS_lineheat_outsideH = outsideH;
    G.WTS_lineheat_air = air;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Line Heat Loss & Arrival Temperature';
    var SUB = 'Bare, insulated or buried lines: overall U, exponential temperature decay per segment, Joule–Thomson cooling at chokes, arrival temperature and hydrate check';
    var UNITS = {
        lh_qo: 'liquidRate', lh_qw: 'liquidRate', lh_qg: 'gasRate', lh_api: 'api', lh_sgg: 'sg', lh_sgw: 'sg',
        lh_cpo: 'specificHeat', lh_cpw: 'specificHeat', lh_cpg: 'specificHeat',
        lh_p0: 'pressureG', lh_t0: 'temperature', lh_hi: 'heatTransferCoef', lh_kp: 'thermalConductivity', lh_kins: 'thermalConductivity',
        lh_tair: 'temperature', lh_wind: 'windSpeed', lh_tsoil: 'temperature', lh_ksoil: 'thermalConductivity', lh_jt: 'jtCoefficient'
    };
    var SEG_IDS = [];
    for (var sk = 1; sk <= NSEG; sk++) {
        SEG_IDS.push({ name: 'lh_s' + sk + '_name', len: 'lh_s' + sk + '_len', od: 'lh_s' + sk + '_od', wall: 'lh_s' + sk + '_wall',
            ins: 'lh_s' + sk + '_ins', type: 'lh_s' + sk + '_type', depth: 'lh_s' + sk + '_depth', dpc: 'lh_s' + sk + '_dpc' });
    }
    var SEG_CATS = { len: 'length', od: 'lengthSmall', wall: 'lengthSmall', ins: 'lengthSmall', depth: 'length', dpc: 'pressure' };
    // name, length ft, OD in, wall in, insulation in, type, depth ft, choke dP psi
    var DEF = [['Wellhead to choke manifold', 60, 3.5, 0.3, '', 'bare', '', ''],
        ['Choke manifold to heater', 150, 3.5, 0.3, '', 'bare', '', 1500],
        ['Heater to separator', 250, 3.5, 0.3, 1.5, 'ins', '', '']];
    var TYPES = [{ v: 'bare', t: 'Bare, in air' }, { v: 'ins', t: 'Insulated, in air' }, { v: 'buried', t: 'Buried' }];

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
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
    var HEADS = [['len', 'Length', 'length', 'ft'], ['od', 'Pipe OD', 'lengthSmall', 'in'], ['wall', 'Wall', 'lengthSmall', 'in'],
        ['ins', 'Insulation', 'lengthSmall', 'in'], ['depth', 'Depth to centreline', 'length', 'ft'], ['dpc', 'Choke drop at inlet', 'pressure', 'psi']];
    function _headText(hd) { return hd[1] + ' (' + _lab(hd[2], hd[3]) + ')'; }
    function _segTable() {
        var head = ['#', 'Segment', '<span id="lh_h_len">' + _headText(HEADS[0]) + '</span>', '<span id="lh_h_od">' + _headText(HEADS[1]) + '</span>',
            '<span id="lh_h_wall">' + _headText(HEADS[2]) + '</span>', '<span id="lh_h_ins">' + _headText(HEADS[3]) + '</span>', 'Installation',
            '<span id="lh_h_depth">' + _headText(HEADS[4]) + '</span>', '<span id="lh_h_dpc">' + _headText(HEADS[5]) + '</span>'];
        var rows = SEG_IDS.map(function (s, k) {
            var d = DEF[k] || ['', '', '', '', '', 'bare', '', ''];
            var inp = function (id, v, w) { return '<input type="number" id="' + id + '" value="' + v + '" step="any" min="0" style="width:' + w + 'px">'; };
            var sel = '<select id="' + s.type + '">' + TYPES.map(function (o) { return '<option value="' + o.v + '"' + (o.v === d[5] ? ' selected' : '') + '>' + o.t + '</option>'; }).join('') + '</select>';
            return [String(k + 1), '<input type="text" id="' + s.name + '" value="' + d[0] + '" style="min-width:120px">',
                inp(s.len, d[1], 80), inp(s.od, d[2], 60), inp(s.wall, d[3], 60), inp(s.ins, d[4], 60), sel, inp(s.depth, d[6], 60), inp(s.dpc, d[7], 70)];
        });
        return _tbl(head, rows);
    }
    function _refreshHeads() {
        HEADS.forEach(function (hd) { var e = _byId('lh_h_' + hd[0]); if (e) e.textContent = _headText(hd); });
    }

    function _read() {
        return {
            qo: _num('lh_qo'), qw: _num('lh_qw'), qg: _num('lh_qg'), api: _num('lh_api'), sgg: _num('lh_sgg'), sgw: _num('lh_sgw'),
            cpo: _num('lh_cpo'), cpw: _num('lh_cpw'), cpg: _num('lh_cpg'), p0: _num('lh_p0'), t0: _num('lh_t0'),
            hi: _num('lh_hi'), kp: _num('lh_kp'), kins: _num('lh_kins'), eps: _num('lh_eps'),
            tair: _num('lh_tair'), wind: _num('lh_wind'), tsoil: _num('lh_tsoil'), ksoil: _num('lh_ksoil'), jt: _num('lh_jt'),
            segs: SEG_IDS.map(function (s) {
                return { name: _str(s.name), len: _num(s.len), od: _num(s.od), wall: _num(s.wall), ins: _num(s.ins),
                    type: _str(s.type), depth: _num(s.depth), dpc: _num(s.dpc) };
            })
        };
    }
    function _idFor(key) {
        var m = /^s(\d)_(\w+)$/.exec(key);
        if (key === 'chokes') return 'lh_p0';
        return m ? 'lh_s' + m[1] + '_' + m[2] : 'lh_' + key;
    }
    var MSG = {
        p0: function () { return 'Inlet pressure must be between 0 and ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        t0: function () { return 'Inlet temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(400, 'temperature', 0, '°F') + '.'; },
        tair: function () { return 'Air temperature must be between ' + _u(-60, 'temperature', 0, '°F') + ' and ' + _u(140, 'temperature', 0, '°F') + '.'; },
        tsoil: function () { return 'Soil temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(140, 'temperature', 0, '°F') + '.'; },
        wind: function () { return 'Wind speed must be between 0 and ' + _u(150, 'windSpeed', 0, 'mph', 1) + '.'; },
        jt: function () { return 'Joule–Thomson coefficient must be between ' + _u(-0.1, 'jtCoefficient', 2, '°F/psi', 3) + ' and ' + _u(0.2, 'jtCoefficient', 2, '°F/psi', 3) + '.'; }
    };

    function _paint(r) {
        var res = _byId('lh_res');
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
        var T = function (v) { return _u(v, 'temperature', 1, '°F'); };
        var dT = function (v) { return _u(v, 'tempDiff', 1, '°F'); };
        var P = function (v) { return _u(v, 'pressureG', 0, 'psig'); };
        var ft = function (v) { return _u(v, 'length', 0, 'ft', 1); };
        var Q = function (v) { return _u(v, 'heatFlow', 0, 'Btu/hr', 1); };
        var UAf = function (v) { return _u(v, 'heatLossLength', 3, 'Btu/hr·ft·°F', 3); };
        var Uf = function (v) { return _u(v, 'heatTransferCoef', 3, 'Btu/hr·ft²·°F', 2); };
        var h = '';

        var v = '';
        if (!r.hydrateAvailable) v += _warn('Hydrate correlation not loaded: check the arrival temperatures on the Hydrate Management page.');
        else if (r.hydrateRisk) v += _bad('Temperature falls below the hydrate temperature in ' + r.segments.filter(function (s) { return s.risk; }).map(function (s) { return s.name; }).join(', ') + '. Heat the stream or inject inhibitor.');
        else if (r.hydrateNear) v += _warn('Temperature is within ' + dT(MARGIN) + ' of the hydrate temperature in ' + r.segments.filter(function (s) { return s.near; }).map(function (s) { return s.name; }).join(', ') + '.');
        else v += _ok('Temperature stays at least ' + dT(MARGIN) + ' above the hydrate temperature in every segment.');
        h += '<div class="rbox"><div class="rbox-title">Arrival Temperature</div>' +
            _row('Inlet temperature', T(r.t0)) +
            _row('Temperature downstream of the last choke', T(r.tIn)) +
            _row('Arrival temperature', T(r.tArr)) +
            _row('Arrival pressure, chokes only', P(r.pArr)) +
            _row('Total line length', ft(r.length)) +
            _row('Mass flow: oil / water / gas', _u(r.mo, 'massRate', 0, 'lb/hr') + ' / ' + _u(r.mw, 'massRate', 0, 'lb/hr') + ' / ' + _u(r.mg, 'massRate', 0, 'lb/hr')) +
            _row('Mixture heat capacity', _u(r.cpMix, 'specificHeat', 3, 'Btu/lb·°F', 3)) +
            _row('Gas mass fraction', _fmt(100 * r.gasFrac, 1) + ' %') +
            v +
            ((r.hydrateRisk || r.hydrateNear || !r.hydrateAvailable) ? '<div class="btn-row"><button class="btn btn-secondary" id="lh_gohyd" data-lh-nav="hydrate">Open Hydrate Management</button></div>' : '') +
            '</div>';

        h += '<div class="rbox"><div class="rbox-title">Segment Temperatures</div>' +
            _tbl(['Segment', 'Installation', 'Length', 'Temperature in', 'J-T drop', 'After choke', 'Pressure after choke', 'UA per length',
                'U, outer surface', 'Arrival temperature', 'Heat lost', 'Hydrate temperature', 'Margin'], r.segments.map(function (s) {
                return [s.name, ({ bare: 'Bare, in air', ins: 'Insulated, in air', buried: 'Buried' })[s.type], ft(s.len), T(s.tUp), dT(s.jt), T(s.tStart),
                    P(s.p), UAf(s.ua), Uf(s.U), T(s.tOut), Q(s.q), s.tHyd == null ? '—' : T(s.tHyd),
                    s.margin == null ? '—' : dT(s.margin) + (s.risk ? ' ✗' : s.near ? ' ⚠' : '')];
            })) +
            '<div class="chart-wrap"><canvas id="lh_chart" width="600" height="320"></canvas></div>' +
            _note('T(L) = Ta + (T0 − Ta)·exp(−UA·L/(ṁ·cp)), marched in 20 steps per segment. UA from the inside film (blank = neglected, ' +
                'which gives the most heat loss), the pipe wall, the insulation and the outside: Churchill-Bernstein forced and Churchill-Chu ' +
                'natural convection combined as Nu³ = NuF³ + NuN³ plus radiation for pipe in air, or the buried-cylinder shape factor ' +
                'cosh⁻¹(2z/D)/(2π·k) for buried pipe. J-T cooling = coefficient × choke drop, applied to the whole stream (the gas rule ' +
                '7 °F per 100 psi overstates cooling of oil-rich streams). Pressure between chokes ignores line friction: use Multiphase ' +
                'Flowline Pressure Drop for it. Hydrate temperature: Towler-Mokhatab correlation of the Hydrate Management page, for sweet ' +
                'gas with free water, no inhibitor; checked at the coldest point of each segment. No phase change or latent heat.') +
            '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
        _drawChart(r);
    }

    function _drawChart(r) {
        var cv = _byId('lh_chart');
        var draw = (typeof drawLineChart === 'function') ? drawLineChart : (typeof G.drawLineChart === 'function' ? G.drawLineChart : null); // eslint-disable-line no-undef
        if (!cv || !draw) return;
        var X = function (x) { return _dv(x, 'length'); }, Y = function (t) { return _dv(t, 'temperature'); };
        var ds = [{ label: 'Fluid', color: '#f0883e', points: false, width: 2, data: r.profile.map(function (q) { return { x: X(q.x), y: Y(q.t) }; }) }];
        if (r.hydrateAvailable) {
            var hy = [], x0 = 0;
            r.segments.forEach(function (s) { hy.push({ x: X(x0), y: Y(s.tHyd) }, { x: X(s.xEnd), y: Y(s.tHyd) }); x0 = s.xEnd; });
            ds.push({ label: 'Hydrate temperature', color: '#f85149', points: false, width: 1.5, dash: [6, 4], data: hy });
        }
        var am = [], x1 = 0;
        r.segments.forEach(function (s) { am.push({ x: X(x1), y: Y(s.ta) }, { x: X(s.xEnd), y: Y(s.ta) }); x1 = s.xEnd; });
        ds.push({ label: 'Ambient', color: '#58a6ff', points: false, width: 1, dash: [2, 3], data: am });
        try {
            draw(cv, ds, { xLabel: 'Distance from inlet (' + _lab('length', 'ft') + ')', yLabel: 'Temperature (' + _lab('temperature', '°F') + ')', xMin: 0, xDec: 0, yDec: 0 });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _calcImpl() {
        var root = _byId('lh_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        _refreshHeads();
        var r = compute(_read());
        _paint(r);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.lineheat = {
            ok: !!r.ok, tIn: r.ok ? r.tIn : null, tArr: r.ok ? r.tArr : null,
            hydrateRisk: r.ok ? r.hydrateRisk : null, ts: Date.now(), result: r
        };
        return r;
    }
    G.calcLineHeat = function () { return _canon(_calcImpl); };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="lh_root"><div class="cols-2">' +
            '<div class="card"><div class="card-title">Stream</div><div class="fg">' +
            _fg('lh_qo', 'Oil rate (BPD)', '1000', ' min="0"') +
            _fg('lh_qw', 'Water rate (BPD)', '200', ' min="0"') +
            _fg('lh_qg', 'Gas rate (MMSCFD)', '5', ' min="0"') +
            _fg('lh_api', 'Oil gravity (°API)', '38') +
            _fg('lh_sgg', 'Gas gravity, air = 1', '0.7') +
            _fg('lh_sgw', 'Water specific gravity', '1.05') +
            _fg('lh_cpo', 'Oil heat capacity (Btu/lb·°F)', '0.5') +
            _fg('lh_cpw', 'Water heat capacity (Btu/lb·°F)', '1.0') +
            _fg('lh_cpg', 'Gas heat capacity (Btu/lb·°F)', '0.55') +
            _fg('lh_p0', 'Inlet pressure, upstream of the chokes (psig)', '2500', ' min="0"') +
            _fg('lh_t0', 'Inlet temperature (°F)', '150') +
            _fg('lh_jt', 'Joule–Thomson coefficient (°F/psi)', '0.07') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Pipe &amp; Surroundings</div><div class="fg">' +
            _fg('lh_hi', 'Inside film coefficient, blank = neglected (Btu/hr·ft²·°F)', '') +
            _fg('lh_kp', 'Pipe wall conductivity (Btu/hr·ft·°F)', '26') +
            _fg('lh_kins', 'Insulation conductivity (Btu/hr·ft·°F)', '0.025') +
            _fg('lh_eps', 'Outer surface emissivity', '0.9', ' min="0" max="1"') +
            _fg('lh_tair', 'Air temperature (°F)', '40') +
            _fg('lh_wind', 'Wind speed (mph)', '15', ' min="0"') +
            _fg('lh_tsoil', 'Soil temperature at pipe depth (°F)', '50') +
            _fg('lh_ksoil', 'Soil conductivity (Btu/hr·ft·°F)', '0.7') +
            '</div></div></div>' +
            '<div class="card"><div class="card-title">Segments, Inlet to Outlet</div>' + _segTable() +
            '<div class="btn-row"><button class="btn btn-primary" id="lh_calc" onclick="calcLineHeat()">Calculate</button></div></div>' +
            '<div id="lh_res"></div>' +
            '</div>';
        var tags = {};
        for (var k in UNITS) tags[k] = UNITS[k];
        SEG_IDS.forEach(function (s) { for (var c in SEG_CATS) tags[s[c]] = SEG_CATS[c]; });
        _tag(tags);
        var root = _byId('lh_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^lh_/.test(e.target.id || '')) G.calcLineHeat();
            });
            root.addEventListener('click', function (e) {
                var b = e && e.target && e.target.closest ? e.target.closest('[data-lh-nav]') : null;
                if (!b) return;
                var nb = document.querySelector('.nav-btn[data-p="' + b.getAttribute('data-lh-nav') + '"]');
                if (nb && nb.click) nb.click();
            });
        }
        G.calcLineHeat();
    }
    G.renderLineHeat = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.lineheat = {
        key: 'lineheat',
        title: TITLE,
        navTitle: 'Line Heat Loss',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9832;',
        badge: 'Hydrates',
        bc: 'dc-b-orange',
        desc: 'Arrival temperature through bare, insulated or buried lines, with J-T cooling at chokes and a hydrate check.',
        render: function (body) { return G.renderLineHeat(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('lh_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcLineHeat();
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
    // Buried bare pipe, water only: closed form.
    var r = G.WTS_lineheat_compute({ qo: 0, qw: 5000, qg: 0, api: 35, sgg: 0.7, sgw: 1, cpo: 0.5, cpw: 1, cpg: 0.55, p0: 100, t0: 150,
        hi: '', kp: 26, kins: 0.025, eps: 0, tair: 40, wind: 0, tsoil: 50, ksoil: 0.7, jt: 0.07,
        segs: [{ name: 'a', len: 5000, od: 4.5, wall: 0.25, ins: 0, type: 'buried', depth: 3, dpc: 0 }] });
    var Rw = Math.log(4.5 / 4) / (2 * Math.PI * 26), Rs = Math.acosh(2 * 3 / (4.5 / 12)) / (2 * Math.PI * 0.7);
    var mcp = 5000 * 5.614583 * 62.366 / 24;
    rel(r.tArr, 50 + 100 * Math.exp(-5000 / (Rw + Rs) / mcp), 1e-9, 'buried arrival');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[lineheat self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[lineheat self-test] ' + n + '/' + n + ' checks passed');
    }
})();
