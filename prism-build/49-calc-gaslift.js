// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Gas Lift Quick Design (gaslift)
//
// PURPOSE
//   Continuous-flow gas lift with injection-pressure-operated (IPO) valves,
//   one vertical well (MD = TVD):
//     • injection-gas pressure in the annulus vs depth;
//     • point of injection (POI) from the flowing traverse below it;
//     • gas requirement: injection rate for a target total GLR, and the
//       minimum total GLR that lifts the target rate at the wellhead pressure;
//     • unloading-valve spacing (kill-fluid gradient, kickoff and operating
//       pressures, design tubing line, pressure drop per valve, bottom valve);
//     • valve schedule with dome and test-rack opening pressures;
//     • pressure–depth chart.
//
// METHOD (field units: psig, ft, °F, STB/d, scf/STB, MMSCFD)
//   Design procedure: API RP 11V6 (1999), "Design of Continuous Flow Gas Lift
//   Installations Using Injection Pressure Operated Valves", §5–6, and Brown,
//   K.E. (1980), "The Technology of Artificial Lift Methods", Vol. 2a, Ch. 3
//   (graphical IPO design with a pressure drop per valve), written numerically:
//   1. Injection gas at depth (static gas column), in layers of ≤ 500 ft each with
//      its own average T and Z:
//        p_bot = (p_top + 14.7)·exp(0.018743·γg·Δz/(Z̄·T̄)) − 14.7
//      via WTS_gradient_compute (48-calc-wellkill.js); Z̄ at the layer's mean
//      pressure and temperature from DAK with the Sutton pseudo-criticals of
//      WTS_gaspvt_pseudoCriticals (46-calc-gaspvt.js), iterated to convergence.
//      The annulus gas is taken at the flowing temperature, linear from the
//      wellhead to the bottomhole temperature.
//   2. Flowing bottomhole pressure from a straight-line PI: p_wf = p_r − q_L/J.
//   3. Traverse below the POI: formation GLR, from p_wf at the perforations
//      upward (Beggs & Brill with the Payne corrections, 49-calc-flowline.js
//      WTS_flowline_march). POI = the deepest depth where
//        p_c(D) − Δp_valve ≥ p_below(D)      (point of balance less the valve
//      differential, RP 11V6 §5), limited to the deepest mandrel.
//   4. Traverse above the POI: total GLR (formation + injection gas, gas gravity
//      mixed by rate), from the wellhead pressure downward. Lift is achieved at
//      the target rate when p_above(POI) ≤ p_below(POI). Injection rate
//        q_inj = (GLR_total − GLR_formation)·q_L; the minimum total GLR is found
//      by bisection on p_above(POI) = p_below(POI).
//   5. Design tubing line (transfer line): straight from
//        p_wh + f·(p_so − p_wh) at surface (f = design tubing effect, 20 % in
//        Brown) to the flowing tubing pressure at the POI.
//   6. Spacing: top valve where the kickoff casing line meets the kill-fluid
//      column from the unloading wellhead pressure,
//        p_c(D₁; p_ko) = p_wh + g_s·D₁ ;
//      valve k+1 where the casing line of valve k+1 (surface pressure
//      p_so − k·Δp_drop) meets the kill-fluid gradient from the design tubing
//      pressure at valve k,
//        p_c(D_{k+1}; p_so − k·Δp_drop) = p_td(D_k) + g_s·(D_{k+1} − D_k),
//      at least the minimum spacing apart; the last (operating) valve is at the
//      POI. The POI is re-found with the operating valve's casing pressure until
//      the valve count is stable.
//   7. Valve setting (IPO, nitrogen-charged bellows, force balance):
//        p_d = p_vo·(1 − R) + p_t·R,   R = A_port/A_bellows,
//        p_d(60 °F) = C_t·p_d with C_t from the real-gas nitrogen dome at constant
//        volume (DAK Z, Tc 227.16 °R, Pc 493.1 psia; absolute pressures),
//        p_tro = p_d(60 °F)/(1 − R)   (test-rack opening pressure, API RP 11V2);
//      the Winkler approximation C_t ≈ 1/(1 + 0.00215·(T − 60)) is shown for
//      comparison. Surface closing pressure = surface casing pressure whose gas
//      column gives p_d at the valve.
//
// PUBLIC API (window.*)
//   WTS_gaslift_compute(input) → {ok, poi, valves[], qinj, glrMin, …} or {ok:false, errors, bad}
//   WTS_gaslift_casingP(psurf psig, D ft, sg, tTop, tBot °F) → {p psig, z}
//   WTS_gaslift_ct(pdPsia, tF) → {ct, winkler}
//   renderGasLift(body), calcGasLift()
//
// STATE  WTS_state.gaslift = {ok, poi, poiValve, nValves, qinj, glrMin, ts, result}
// Registers window.WTS_calcRegistry.gaslift (group "Production & Reservoir").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var PATM = 14.696, RANK = 459.67;
    var N2 = { Tc: 227.16, Pc: 493.1 };            // nitrogen, °R / psia (GPSA; as 46-calc-gaspvt.js)
    var MAXV = 20;
    var PSIFT_KPAM = 6.894757 / 0.3048;

    (function _cats() {
        var U = G.WTS_units, C = U && U.CATEGORIES;
        if (!C) return;
        if (!C.pressureGradient) C.pressureGradient = { imperial: { unit: 'psi/ft', label: 'psi/ft', factor: PSIFT_KPAM, offset: 0 }, metric: { unit: 'kPa/m', label: 'kPa/m', factor: 1, offset: 0 } };
    })();

    // ── Helpers ─────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
        if (v == null || !isFinite(v)) return '—';
        if (_metric() && U.format && U.CATEGORIES && U.CATEGORIES[cat]) { var f = U.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _dv(v, cat) { var U = G.WTS_units; return (_metric() && U && U.format && U.CATEGORIES && U.CATEGORIES[cat]) ? U.format(v, cat).value : v; }
    function _lab(cat, imp) { var U = G.WTS_units; return (_metric() && U && U.CATEGORIES && U.CATEGORIES[cat]) ? U.CATEGORIES[cat].metric.label : imp; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _lib() { return G.PRiSM_pvt_correlations || null; }
    function _bisect(f, a, b, n) {             // f(a) > 0 ≥ f(b) assumed
        var fa = f(a);
        for (var k = 0; k < (n || 60); k++) {
            var m = (a + b) / 2, fm = f(m);
            if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
            if (b - a < 1e-3) break;
        }
        return (a + b) / 2;
    }

    // ── Injection gas column ────────────────────────────────────────
    var _pcCache = {};
    function _pcFor(sg) {
        if (_pcCache[sg]) return _pcCache[sg];
        var p = (typeof G.WTS_gaspvt_pseudoCriticals === 'function') ? G.WTS_gaspvt_pseudoCriticals(sg, 0, 0, 0) : null;
        if (!(p && p.Tpc > 0)) { var L = _lib(); p = { Tpc: L.Tpc_sutton(sg), Ppc: L.Ppc_sutton(sg) }; }
        _pcCache[sg] = { Tpc: p.Tpc, Ppc: p.Ppc };
        return _pcCache[sg];
    }
    // Layers of at most 500 ft, each with its own average T and Z (iterated), so the
    // temperature profile and Z(p, T) are followed (a single average over 10,000 ft with
    // 80 → 250 °F is ≈ 3 % low on the pressure gain).
    function _layer(L, pc, ps, dz, sg, tAvg) {
        var TR = tAvg + RANK, z = L.Z_dranchukAbouKassem(TR / pc.Tpc, (ps + PATM) / pc.Ppc), pb = ps;
        for (var k = 0; k < 8; k++) {
            var r = G.WTS_gradient_compute({ dir: 's2b', p: ps, tvd: dz, gasLen: dz, mixLen: 0, hl: 0, rho: 8.33, sg: sg, t: tAvg, z: z });
            if (!r || !r.ok) return { p: NaN, z: z };
            var zn = L.Z_dranchukAbouKassem(TR / pc.Tpc, ((ps + r.pBot) / 2 + PATM) / pc.Ppc);
            pb = r.pBot;
            if (Math.abs(zn - z) < 1e-7) { z = zn; break; }
            z = zn;
        }
        return { p: pb, z: z };
    }
    function casingP(psurf, D, sg, tTop, tBot) {
        if (!(D > 0)) return { p: psurf, z: null };
        var L = _lib(), pc = _pcFor(sg), n = Math.max(1, Math.ceil(D / 500)), dz = D / n, p = psurf, zs = 0, lay = null;
        for (var k = 0; k < n; k++) {
            var tMid = tTop + (tBot - tTop) * (k + 0.5) / n;
            lay = _layer(L, pc, p, dz, sg, tMid);
            p = lay.p; zs += lay.z;
        }
        return { p: p, z: zs / n };
    }

    // ── Nitrogen dome temperature correction ────────────────────────
    // Constant dome volume: p/(Z·T) constant → p60 = pT·(T60/T)·(Z60/ZT), fixed point on Z60.
    function ct(pdPsia, tF) {
        var L = _lib(), T = tF + RANK, T60 = 60 + RANK;
        var zT = L.Z_dranchukAbouKassem(T / N2.Tc, pdPsia / N2.Pc), p60 = pdPsia * T60 / T;
        for (var k = 0; k < 50; k++) {
            var z60 = L.Z_dranchukAbouKassem(T60 / N2.Tc, p60 / N2.Pc);
            var pn = pdPsia * (T60 / T) * (z60 / zT);
            if (Math.abs(pn - p60) < 1e-9 * pn) { p60 = pn; break; }
            p60 = pn;
        }
        return { ct: p60 / pdPsia, winkler: 1 / (1 + 0.00215 * (tF - 60)), p60: p60 };
    }

    // ── Pure compute ────────────────────────────────────────────────
    // input = {qo, qw STB/d, gor scf/STB, api, sgg, sgw, sginj, pr psig, pi STB/d/psi, dperf ft, dmax ft,
    //          tub (WTS_tubulars key) | tubId in, rough in, pwh psig, twh °F, bht °F,
    //          pko, pso psig, glr scf/STB (target total), dpv psi, dpdrop psi, gs psi/ft, ftub %, minsp ft, R}
    function compute(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var n = function (k) { var v = i[k]; return (v === '' || v == null) ? NaN : Number(v); };
        var qo = n('qo'), qw = n('qw'), gor = n('gor'), api = n('api'), sgg = n('sgg'), sgw = n('sgw'), sginj = n('sginj');
        var pr = n('pr'), pi = n('pi'), dperf = n('dperf'), dmax = n('dmax'), rough = _fin(n('rough')) ? n('rough') : 0.0018;
        var pwh = n('pwh'), twh = n('twh'), bht = n('bht'), pko = n('pko'), pso = n('pso'), glr = n('glr');
        var dpv = n('dpv'), dpdrop = n('dpdrop'), gs = n('gs'), ftub = n('ftub'), minsp = n('minsp'), R = n('R');
        var T = G.WTS_tubulars, tub = (i.tub && T && T.find) ? T.find(String(i.tub)) : null;
        var tid = tub ? tub.id : n('tubId');
        need(_fin(qo) && qo >= 0 && qo <= 50000, 'qo', 'Oil rate must be between 0 and 50,000 STB/d.');
        need(_fin(qw) && qw >= 0 && qw <= 50000, 'qw', 'Water rate must be between 0 and 50,000 BWPD.');
        if (_fin(qo) && _fin(qw)) need(qo + qw >= 10, 'qo', 'Liquid rate (oil + water) must be at least 10 STB/d.');
        need(_fin(gor) && gor >= 0 && gor <= 20000, 'gor', 'Formation GOR must be between 0 and 20,000 scf/STB.');
        need(_fin(api) && api >= 10 && api <= 60, 'api', 'Oil gravity must be between 10 and 60 °API.');
        need(_fin(sgg) && sgg >= 0.55 && sgg <= 1.2, 'sgg', 'Formation gas gravity must be between 0.55 and 1.2.');
        need(_fin(sgw) && sgw >= 0.95 && sgw <= 1.3, 'sgw', 'Water specific gravity must be between 0.95 and 1.3.');
        need(_fin(sginj) && sginj >= 0.55 && sginj <= 1.0, 'sginj', 'Injection gas gravity must be between 0.55 and 1.0.');
        need(_fin(pr) && pr > 0 && pr <= 15000, 'pr', 'Reservoir pressure must be above 0 and no more than 15,000 psig.');
        need(_fin(pi) && pi > 0 && pi <= 1000, 'pi', 'Productivity index must be above 0 and no more than 1,000 STB/d/psi.');
        var dOk = need(_fin(dperf) && dperf >= 500 && dperf <= 20000, 'dperf', 'Mid-perforation depth must be between 500 and 20,000 ft.');
        need(_fin(dmax) && dmax >= 200 && (!dOk || dmax < dperf), 'dmax', 'Deepest mandrel depth must be at least 200 ft and above the perforations.');
        need(_fin(tid) && tid >= 1 && tid <= 7, 'tub', 'Select a tubing size.');
        need(_fin(rough) && rough >= 0 && rough <= 0.01, 'rough', 'Pipe roughness must be between 0 and 0.01 in.');
        need(_fin(pwh) && pwh >= 0 && pwh <= 3000, 'pwh', 'Flowing wellhead pressure must be between 0 and 3,000 psig.');
        need(_fin(twh) && twh >= 32 && twh <= 300, 'twh', 'Wellhead temperature must be between 32 and 300 °F.');
        need(_fin(bht) && bht >= 32 && bht <= 400 && (!_fin(twh) || bht >= twh), 'bht', 'Bottomhole temperature must be between 32 and 400 °F and not below the wellhead temperature.');
        var psoOk = need(_fin(pso) && pso > 0 && pso <= 5000 && (!_fin(pwh) || pso > pwh), 'pso', 'Surface operating injection pressure must be above the wellhead pressure and no more than 5,000 psig.');
        need(_fin(pko) && pko <= 5000 && (!psoOk || pko >= pso), 'pko', 'Kickoff pressure must be at least the operating pressure and no more than 5,000 psig.');
        need(_fin(glr) && glr > 0 && glr <= 20000, 'glr', 'Target total GLR must be above 0 and no more than 20,000 scf/STB.');
        need(_fin(dpv) && dpv >= 0 && dpv <= 500, 'dpv', 'Valve differential at the point of injection must be between 0 and 500 psi.');
        need(_fin(dpdrop) && dpdrop >= 0 && dpdrop <= 100, 'dpdrop', 'Pressure drop per valve must be between 0 and 100 psi.');
        need(_fin(gs) && gs >= 0.3 && gs <= 0.8, 'gs', 'Kill-fluid gradient must be between 0.3 and 0.8 psi/ft.');
        need(_fin(ftub) && ftub >= 0 && ftub <= 100, 'ftub', 'Design tubing effect at surface must be between 0 and 100 %.');
        need(_fin(minsp) && minsp >= 0 && minsp <= 2000, 'minsp', 'Minimum valve spacing must be between 0 and 2,000 ft.');
        need(_fin(R) && R >= 0 && R < 0.5, 'R', 'Valve port-to-bellows area ratio R must be 0 or more and below 0.5.');
        if (!errors.length && (typeof G.WTS_flowline_march !== 'function' || typeof G.WTS_gradient_compute !== 'function' || !_lib())) {
            errors.push('The flowline, gradient or PVT engines are not loaded.'); bad.push('lib');
        }
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var qL = qo + qw, glrF = qo * gor / qL, qgF = qo * gor / 1e6;
        var pwf = pr - qL / pi;
        if (!(pwf > 0)) return { ok: false, errors: ['The target liquid rate needs a flowing bottomhole pressure below zero (p_r − q_L/J): lower the rate or check the PI.'], bad: ['pi'] };
        var tAt = function (D) { return twh + (bht - twh) * D / dperf; };
        var seg = function (L) { return [{ name: 'Tubing', len: L, id: tid, dz: L }]; };
        var opt = { rough: rough, payne: true, accel: false };
        var fluidF = { qo: qo, qw: qw, qg: qgF, api: api, sgg: sgg, sgw: sgw };

        // 3. Traverse below the POI: from the perforations upward, formation GLR.
        var below = G.WTS_flowline_march(seg(dperf), fluidF, pwf, bht, twh, opt);
        var bp = below.profile.map(function (q) { return { d: dperf - q.x, p: q.p }; }).reverse();   // shallow → deep
        function pBelow(D) {
            if (D >= bp[bp.length - 1].d) return bp[bp.length - 1].p;
            if (D <= bp[0].d) return bp[0].d > 0 ? -Infinity : bp[0].p;              // traverse died above: no support
            for (var k = 1; k < bp.length; k++) {
                if (bp[k].d >= D) { var a = bp[k - 1], b = bp[k]; return a.p + (b.p - a.p) * (D - a.d) / (b.d - a.d); }
            }
            return bp[bp.length - 1].p;
        }
        var naturalWh = below.lost ? null : below.pOut;
        var pc = function (ps, D) { return casingP(ps, D, sginj, twh, tAt(D)).p; };

        function findPoi(psoOp) {
            var f = function (D) { return pc(psoOp, D) - dpv - pBelow(D); };
            if (f(dperf) >= 0) return { poi: dperf, balance: dperf, atPerfs: true };
            // scan upward on the traverse points, then bisect
            var prev = dperf;
            for (var k = bp.length - 1; k >= 0; k--) {
                var D = bp[k].d;
                if (f(D) >= 0) {
                    var x = _bisect(function (z) { return f(z); }, D, prev, 60);
                    return { poi: x, atPerfs: false };
                }
                prev = D;
            }
            return null;
        }

        var sgMix = function (glrT) {
            var qi = Math.max(0, glrT - glrF) * qL / 1e6;
            return (qgF + qi) > 0 ? (qgF * sgg + qi * sginj) / (qgF + qi) : sgg;
        };
        function above(glrT, D) {
            var fl = { qo: qo, qw: qw, qg: Math.max(glrT, glrF) * qL / 1e6, api: api, sgg: sgMix(glrT), sgw: sgw };
            return G.WTS_flowline_march(seg(D), fl, pwh, twh, tAt(D), Object.assign({ reverse: true }, opt));
        }

        // Iterate POI ↔ valve count (the operating valve opens at p_so − (n−1)·Δp_drop).
        var nPrev = 1, P = null, valves = null, spacingFail = null, it;
        for (it = 0; it < 6; it++) {
            var psoOp = pso - (nPrev - 1) * dpdrop;
            var fp = findPoi(psoOp);
            if (!fp) return { ok: false, errors: ['The injection gas cannot reach the flowing tubing pressure at any depth: raise the injection pressure or lower the valve differential.'], bad: ['pso'] };
            var poi = fp.poi, poiV = Math.min(poi, dmax);
            var ab = above(glr, poiV);
            var pAbove = ab.pOut, pBel = pBelow(poiV);
            var pts = pwh + ftub / 100 * (pso - pwh), ptPoi = pAbove;
            var ptd = function (D) { return pts + (ptPoi - pts) * D / poiV; };
            // 6. Spacing
            valves = []; spacingFail = null;
            var fTop = function (D) { return pc(pko, D) - (pwh + gs * D); };
            var D1 = fTop(poiV) > 0 ? poiV : _bisect(fTop, 0, poiV, 80);
            valves.push({ n: 1, d: D1, pso: pso, kick: true });
            while (valves[valves.length - 1].d < poiV - 1e-6 && valves.length < MAXV) {
                var k = valves.length, Dk = valves[k - 1].d, psoK = pso - k * dpdrop, ptk = ptd(Dk);
                var h = function (D) { return pc(psoK, D) - (ptk + gs * (D - Dk)); };
                if (!(h(Dk) > 0)) { spacingFail = { after: k, d: Dk }; break; }
                var Dn = h(poiV) > 0 ? poiV : _bisect(h, Dk, poiV, 80);
                if (Dn - Dk < minsp) Dn = Math.min(poiV, Dk + minsp);
                if (poiV - Dn < 1e-6 || poiV - Dn < 0.5 * minsp) Dn = poiV;
                valves.push({ n: k + 1, d: Dn, pso: psoK });
            }
            P = { psoOp: psoOp, poi: poi, poiV: poiV, atPerfs: fp.atPerfs, ab: ab, pAbove: pAbove, pBelow: pBel, pts: pts, ptPoi: ptPoi, ptd: ptd };
            if (valves.length === nPrev) break;
            nPrev = valves.length;
        }
        var last = valves[valves.length - 1];
        var reachesPoi = !spacingFail && last.d >= P.poiV - 1e-6;
        valves.forEach(function (v, k) {
            v.role = (k === valves.length - 1 && reachesPoi) ? 'Operating' : 'Unloading';
            v.t = tAt(v.d);
            v.pvo = pc(v.pso, v.d);
            v.pt = P.ptd(v.d);
            v.spacing = k === 0 ? v.d : v.d - valves[k - 1].d;
            v.pd = v.pvo * (1 - R) + v.pt * R;
            var c = ct(v.pd + PATM, v.t);
            v.ct = c.ct; v.ctW = c.winkler;
            v.pd60 = c.ct * (v.pd + PATM) - PATM;
            v.ptro = v.pd60 / (1 - R);
            var pdAt = v.pd;
            v.pvcs = _bisect(function (ps) { return pdAt - pc(ps, v.d); }, 0, v.pso, 60);
        });

        // 4. Gas requirement: target and minimum total GLR.
        var qinj = Math.max(0, glr - glrF) * qL / 1e6;
        var lifts = P.pAbove != null && P.pAbove <= P.pBelow + 1e-6;
        function excess(g) { var a = above(g, P.poiV); return (a.pOut == null ? Infinity : a.pOut) - P.pBelow; }
        var glrMin = null, glrMinNote = null;
        if (excess(glrF) <= 0) { glrMin = glrF; glrMinNote = 'natural'; }
        else {
            var lo = glrF, hi = null, grid = 16, gMax = 12000;
            for (var s = 1; s <= grid; s++) {
                var g = glrF + (gMax - glrF) * (s / grid) * (s / grid);
                if (excess(g) <= 0) { hi = g; break; }
                lo = g;
            }
            if (hi != null) {
                for (var b = 0; b < 30 && hi - lo > 0.5; b++) {
                    var m = (lo + hi) / 2;
                    if (excess(m) <= 0) hi = m; else lo = m;
                }
                glrMin = hi;
            } else glrMinNote = 'none';
        }
        var qinjMin = glrMin != null ? Math.max(0, glrMin - glrF) * qL / 1e6 : null;
        // Gas gradient at surface (psi/ft) for display
        var gGrad = (pc(pso, 1000) - pso) / 1000;

        // Curves for the chart (depth, pressure)
        var N = 24, curves = { pko: [], pso: [], psoOp: [], ptd: [], above: [], below: [], load: [] };
        for (var q = 0; q <= N; q++) {
            var D = dperf * q / N;
            curves.pko.push({ d: D, p: pc(pko, D) });
            curves.pso.push({ d: D, p: pc(pso, D) });
        }
        curves.ptd = [{ d: 0, p: P.pts }, { d: P.poiV, p: P.ptPoi }];
        curves.above = P.ab.profile.map(function (x) { return { d: x.x, p: x.p }; });
        curves.below = bp.slice();
        curves.load.push({ d: 0, p: pwh }, { d: valves[0].d, p: pwh + gs * valves[0].d });
        for (var v2 = 1; v2 < valves.length; v2++) {
            curves.load.push(null, { d: valves[v2 - 1].d, p: P.ptd(valves[v2 - 1].d) }, { d: valves[v2].d, p: P.ptd(valves[v2 - 1].d) + gs * (valves[v2].d - valves[v2 - 1].d) });
        }

        var warnings = [];
        if (naturalWh != null && naturalWh >= pwh) warnings.push('The well flows naturally at this rate: the formation-GLR traverse reaches surface at ' + _fmt(naturalWh, 0) + ' psig, above the wellhead pressure.');
        if (P.poi > dmax + 1e-6) warnings.push('The point of balance (' + _fmt(P.poi, 0) + ' ft) is below the deepest mandrel: the operating valve is at the deepest mandrel, ' + _fmt(dmax, 0) + ' ft.');
        if (glr <= glrF) warnings.push('Target total GLR is not above the formation GLR (' + _fmt(glrF, 0) + ' scf/STB): no injection gas is needed for it.');
        if (P.ab.lost) warnings.push('The traverse above the point of injection fails (pressure or critical flow): check the rate and tubing size.');
        return {
            ok: true, pwh: pwh, pko: pko, pso: pso, qL: qL, glrF: glrF, qgF: qgF, pwf: pwf, glr: glr, qinj: qinj, injGlr: Math.max(0, glr - glrF),
            glrMin: glrMin, glrMinNote: glrMinNote, qinjMin: qinjMin, lifts: lifts,
            poi: P.poi, poiValve: P.poiV, poiAtPerfs: P.atPerfs, psoOp: P.psoOp,
            pAbove: P.pAbove, pBelow: P.pBelow, pcPoi: pc(P.psoOp, P.poiV), tPoi: tAt(P.poiV),
            dpPoi: pc(P.psoOp, P.poiV) - P.pAbove,
            pts: P.pts, ptPoi: P.ptPoi, valves: valves, spacingFail: spacingFail, reachesPoi: reachesPoi,
            gasGrad: gGrad, sgMix: sgMix(glr), naturalWh: naturalWh, curves: curves, dperf: dperf, dmax: dmax,
            tubing: tub ? tub.label : null, tid: tid, warnings: warnings, iterations: it + 1
        };
    }

    G.WTS_gaslift_compute = compute;
    G.WTS_gaslift_casingP = function (ps, D, sg, tTop, tBot) { return _lib() && G.WTS_gradient_compute ? casingP(ps, D, sg, tTop, tBot == null ? tTop : tBot) : null; };
    G.WTS_gaslift_ct = function (pdPsia, tF) { return _lib() ? ct(pdPsia, tF) : null; };

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Gas Lift Quick Design';
    var SUB = 'Continuous gas lift with IPO valves: injection-gas gradient, point of injection, gas requirement, unloading-valve spacing, valve schedule and pressure–depth chart (API RP 11V6)';
    var UNITS = {
        gl_qo: 'liquidRate', gl_qw: 'liquidRate', gl_gor: 'gor', gl_api: 'api', gl_sgg: 'sg', gl_sgw: 'sg', gl_sginj: 'sg',
        gl_pr: 'pressureG', gl_pi: 'productivityIndex', gl_dperf: 'length', gl_dmax: 'length', gl_rough: 'lengthSmall',
        gl_pwh: 'pressureG', gl_twh: 'temperature', gl_bht: 'temperature', gl_pko: 'pressureG', gl_pso: 'pressureG',
        gl_glr: 'gor', gl_dpv: 'pressure', gl_dpdrop: 'pressure', gl_gs: 'pressureGradient', gl_ftub: 'percent', gl_minsp: 'length'
    };
    var IDS = ['qo', 'qw', 'gor', 'api', 'sgg', 'sgw', 'sginj', 'pr', 'pi', 'dperf', 'dmax', 'rough', 'pwh', 'twh', 'bht',
        'pko', 'pso', 'glr', 'dpv', 'dpdrop', 'gs', 'ftub', 'minsp', 'R'];
    var MSG = {
        pwh: function () { return 'Flowing wellhead pressure must be between 0 and ' + _u(3000, 'pressureG', 0, 'psig') + '.'; },
        pr: function () { return 'Reservoir pressure must be above 0 and no more than ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        dperf: function () { return 'Mid-perforation depth must be between ' + _u(500, 'length', 0, 'ft') + ' and ' + _u(20000, 'length', 0, 'ft') + '.'; },
        gs: function () { return 'Kill-fluid gradient must be between ' + _u(0.3, 'pressureGradient', 2, 'psi/ft') + ' and ' + _u(0.8, 'pressureGradient', 2, 'psi/ft') + '.'; }
    };

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
    function _tubOpts() {
        var T = G.WTS_tubulars;
        if (!T || !T.tubing) return [{ v: 'tubing-2.875-6.5', t: '2-7/8 in 6.5 lb/ft' }];
        return T.tubing.map(function (e) { return { v: e.key, t: e.label }; });
    }

    function _paint(r) {
        var res = _byId('gl_res');
        if (!res) return;
        if (!r.ok) {
            var items = '', seen = {};
            r.bad.forEach(function (k, n) {
                var el = _byId('gl_' + k);
                if (el && el.classList) el.classList.add('input-err');
                if (seen[k]) return; seen[k] = 1;
                items += '<li>' + (MSG[k] ? MSG[k]() : r.errors[n]) + '</li>';
            });
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
            return;
        }
        var P = function (v) { return _u(v, 'pressureG', 0, 'psig', 0); };
        var dP = function (v) { return _u(v, 'pressure', 0, 'psi', 0); };
        var ft = function (v) { return _u(v, 'length', 0, 'ft', 1); };
        var T = function (v) { return _u(v, 'temperature', 0, '°F'); };
        var glrU = function (v) { return _u(v, 'gor', 0, 'scf/STB', 1); };
        var gas = function (v) { return _u(v, 'gasRate', 3, 'MMSCFD'); };
        var grad = function (v) { return _metric() ? _fmt(v * PSIFT_KPAM, 4) + ' kPa/m' : _fmt(v, 4) + ' psi/ft'; };
        var h = '';

        // Point of injection and gas requirement
        var v = '';
        if (r.lifts) v += _ok('The target GLR lifts ' + _u(r.qL, 'liquidRate', 0, 'STB/d') + ' against ' + P(r.pwh) + ' at the wellhead: tubing pressure at the point of injection ' + P(r.pAbove) + ', the well supports ' + P(r.pBelow) + '.');
        else v += _bad('The target GLR does not lift the target rate: tubing pressure at the point of injection would be ' + P(r.pAbove) + ', above the ' + P(r.pBelow) + ' the well can support. Use at least the minimum GLR.');
        if (r.glrMinNote === 'none') v += _bad('No total GLR up to 12,000 scf/STB lifts this rate: friction dominates. Check the rate, tubing size and injection depth.');
        r.warnings.forEach(function (x) { v += _warn(x); });
        h += '<div class="rbox"><div class="rbox-title">Point of Injection and Gas Requirement</div>' +
            _row('Liquid rate', _u(r.qL, 'liquidRate', 0, 'STB/d')) +
            _row('Flowing bottomhole pressure, p_r − q/J', P(r.pwf)) +
            _row('Formation GLR', glrU(r.glrF)) +
            _row('Target total GLR', glrU(r.glr)) +
            _row('Injection GLR', glrU(r.injGlr)) +
            _row('Injection gas rate at target GLR', gas(r.qinj)) +
            _row('Minimum total GLR to lift the target rate', r.glrMin == null ? '—' : glrU(r.glrMin) + (r.glrMinNote === 'natural' ? ' (flows naturally)' : '')) +
            _row('Minimum injection gas rate', r.qinjMin == null ? '—' : gas(r.qinjMin)) +
            _row('Point of balance less valve differential', ft(r.poi) + (r.poiAtPerfs ? ' (at the perforations)' : '')) +
            _row('Point of injection (operating valve)', ft(r.poiValve)) +
            _row('Temperature at the point of injection', T(r.tPoi)) +
            _row('Casing pressure at the point of injection', P(r.pcPoi)) +
            _row('Tubing pressure at the point of injection, above (total GLR)', P(r.pAbove)) +
            _row('Tubing pressure the well supports at the point of injection (formation GLR)', P(r.pBelow)) +
            _row('Casing − tubing differential at the operating valve', dP(r.dpPoi)) +
            _row('Injection gas gradient near surface', grad(r.gasGrad)) +
            v + '</div>';

        // Valve schedule
        var sv = '';
        if (r.spacingFail) sv += _bad('Unloading stops after valve ' + r.spacingFail.after + ' at ' + ft(r.spacingFail.d) + ': the casing pressure less the drop per valve no longer exceeds the design tubing pressure. Raise the injection pressure or lower the drop per valve.');
        else if (r.valves.length >= MAXV && !r.reachesPoi) sv += _bad('More than ' + MAXV + ' valves would be needed.');
        else sv += _ok(r.valves.length + ' valve' + (r.valves.length > 1 ? 's' : '') + ' unload the well to the point of injection at ' + ft(r.poiValve) + '.');
        h += '<div class="rbox"><div class="rbox-title">Valve Schedule</div>' +
            _tbl(['Valve', 'Role', 'Depth', 'Spacing', 'Temperature', 'Surface opening', 'Casing opening at depth', 'Design tubing', 'Dome at T',
                'Ct (N2)', 'Test-rack opening, 60 °F', 'Surface closing'], r.valves.map(function (x) {
                return [String(x.n), x.role, ft(x.d), ft(x.spacing), T(x.t), P(x.pso) + (x.kick ? ' (kickoff ' + P(r.pko) + ')' : ''), P(x.pvo), P(x.pt), P(x.pd),
                    _fmt(x.ct, 4), P(x.ptro), P(x.pvcs)];
            })) +
            _row('Design tubing pressure at surface', P(r.pts)) +
            _row('Design tubing pressure at the point of injection', P(r.ptPoi)) +
            sv +
            _note('Spacing: top valve where the kickoff casing pressure meets the kill fluid from the wellhead pressure; each ' +
                'next valve where the next valve\'s casing line (surface pressure less the drop per valve) meets the kill-fluid ' +
                'gradient from the design tubing pressure at the valve above (API RP 11V6; Brown 1980, Vol. 2a). The well is taken ' +
                'full of kill fluid to surface (conservative). Valves: injection-pressure operated, p_d = p_vo·(1 − R) + p_t·R, ' +
                'test-rack opening p_d(60 °F)/(1 − R) with the real-gas nitrogen correction Ct (Winkler 1/(1 + 0.00215(T − 60)) ' +
                'agrees within about 1 % up to about 1,200 psi dome pressure). Valve temperature = flowing temperature, linear from wellhead to bottomhole. Screening ' +
                'design: confirm with the valve maker\'s data, the casing / tubing ratings and a full nodal analysis.') +
            '</div>';

        // Chart
        h += '<div class="rbox"><div class="rbox-title">Pressure vs Depth</div>' +
            '<div class="chart-wrap"><canvas id="gl_chart" width="600" height="420"></canvas></div>' +
            _note('Injection gas: static gas column with average Z (DAK, Sutton pseudo-criticals) and temperature. Flowing ' +
                'traverses: Beggs &amp; Brill with the Payne corrections (Flowline page engine), linear flowing temperature; ' +
                'below the point of injection at the formation GLR from p_wf, above it at the total GLR from the wellhead pressure. ' +
                'Straight-line PI. Vertical well (depth = TVD).') +
            '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
        _chart(r);
    }

    // Own pressure–depth plot: pressure across, depth down (drawLineChart has no inverted axis).
    function _chart(r) {
        var cv = _byId('gl_chart');
        if (!cv || !cv.getContext) return;
        var ctx = cv.getContext('2d');
        if (!ctx) return;
        try {
            var W = cv.width, H = cv.height, pad = { t: 36, r: 16, b: 20, l: 64 };
            var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
            var C = r.curves, series = [
                { k: 'pko', c: '#d29922', label: 'Kickoff casing', dash: [6, 4] },
                { k: 'pso', c: '#f0883e', label: 'Operating casing' },
                { k: 'ptd', c: '#a371f7', label: 'Design tubing', dash: [3, 3] },
                { k: 'above', c: '#58a6ff', label: 'Flowing, total GLR' },
                { k: 'below', c: '#3fb950', label: 'Flowing, formation GLR' },
                { k: 'load', c: '#8b949e', label: 'Kill fluid' }
            ];
            var pMax = 0;
            series.forEach(function (s) { (C[s.k] || []).forEach(function (q) { if (q && q.p > pMax) pMax = q.p; }); });
            pMax = pMax * 1.05 || 1;
            var dMax = r.dperf;
            var toX = function (p) { return pad.l + Math.max(0, p) / pMax * pw; };
            var toY = function (d) { return pad.t + d / dMax * ph; };
            ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
            ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1; ctx.fillStyle = '#6e7681'; ctx.font = '11px sans-serif';
            for (var i = 0; i <= 5; i++) {
                var y = pad.t + ph * i / 5, x = pad.l + pw * i / 5;
                ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
                ctx.textAlign = 'right'; ctx.fillText(_fmt(_dv(dMax * i / 5, 'length'), 0), pad.l - 6, y + 4);
                ctx.textAlign = 'center'; ctx.fillText(_fmt(_dv(pMax * i / 5, 'pressureG'), 0), x, pad.t - 8);
            }
            ctx.fillStyle = '#8b949e'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Pressure (' + _lab('pressureG', 'psig') + ')', pad.l + pw / 2, 14);
            ctx.save(); ctx.translate(14, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('Depth (' + _lab('length', 'ft') + ')', 0, 0); ctx.restore();
            series.forEach(function (s) {
                var pts = C[s.k] || [];
                ctx.strokeStyle = s.c; ctx.lineWidth = 2; ctx.setLineDash(s.dash || []);
                ctx.beginPath();
                var pen = false;
                pts.forEach(function (q) {
                    if (!q) { pen = false; return; }
                    var X = toX(q.p), Y = toY(q.d);
                    if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y);
                });
                ctx.stroke(); ctx.setLineDash([]);
            });
            // valves
            ctx.fillStyle = '#e6edf3';
            r.valves.forEach(function (v) {
                var Y = toY(v.d);
                ctx.fillRect(toX(v.pvo) - 4, Y - 1.5, 8, 3);
                ctx.textAlign = 'left'; ctx.fillText(String(v.n), toX(v.pvo) + 6, Y + 4);
            });
            // legend
            var ly = pad.t + ph - 6 * 15;
            series.forEach(function (s, k) {
                ctx.fillStyle = s.c; ctx.fillRect(pad.l + 8, ly + k * 15, 12, 3);
                ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
                ctx.fillText(s.label, pad.l + 24, ly + k * 15 + 4);
            });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _read() {
        var o = {};
        IDS.forEach(function (k) { o[k] = _num('gl_' + k); });
        o.tub = _str('gl_tub');
        return o;
    }
    function _calcImpl() {
        var root = _byId('gl_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        var inp = _read();
        var r = compute(inp);
        _paint(r);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.gaslift = {
            ok: !!r.ok, poi: r.ok ? r.poi : null, poiValve: r.ok ? r.poiValve : null, nValves: r.ok ? r.valves.length : null,
            qinj: r.ok ? r.qinj : null, glrMin: r.ok ? r.glrMin : null, ts: Date.now(), result: r
        };
        return r;
    }
    G.calcGasLift = function () { return _canon(_calcImpl); };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="gl_root">' +
            '<div class="card"><div class="card-title">Well, Fluids &amp; Inflow</div><div class="fg">' +
            _fg('gl_qo', 'Target oil rate (STB/d)', '800', ' min="0"') +
            _fg('gl_qw', 'Water rate (BWPD)', '400', ' min="0"') +
            _fg('gl_gor', 'Formation GOR (scf/STB)', '300', ' min="0"') +
            _fg('gl_api', 'Oil gravity (°API)', '35') +
            _fg('gl_sgg', 'Formation gas gravity, air = 1', '0.7') +
            _fg('gl_sgw', 'Water specific gravity', '1.07') +
            _fg('gl_pr', 'Static reservoir pressure (psig)', '3000', ' min="0"') +
            _fg('gl_pi', 'Productivity index, liquid (STB/d/psi)', '2', ' min="0"') +
            _fg('gl_dperf', 'Mid-perforation depth, TVD (ft)', '8000', ' min="0"') +
            _fg('gl_dmax', 'Deepest mandrel depth, above the packer (ft)', '7700', ' min="0"') +
            _sel('gl_tub', 'Tubing', _tubOpts(), 'tubing-2.875-6.5') +
            _fg('gl_rough', 'Tubing roughness (in)', '0.0018', ' min="0"') +
            _fg('gl_pwh', 'Flowing wellhead pressure (psig)', '120', ' min="0"') +
            _fg('gl_twh', 'Flowing wellhead temperature (°F)', '110') +
            _fg('gl_bht', 'Bottomhole temperature (°F)', '190') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Gas Lift System</div><div class="fg">' +
            _fg('gl_sginj', 'Injection gas gravity, air = 1', '0.65') +
            _fg('gl_pko', 'Kickoff injection pressure at surface (psig)', '1100', ' min="0"') +
            _fg('gl_pso', 'Operating injection pressure at surface (psig)', '1000', ' min="0"') +
            _fg('gl_glr', 'Target total GLR (scf/STB of liquid)', '800', ' min="0"') +
            _fg('gl_dpv', 'Casing − tubing differential at the operating valve (psi)', '100', ' min="0"') +
            _fg('gl_dpdrop', 'Surface pressure drop per valve (psi)', '25', ' min="0"') +
            _fg('gl_gs', 'Kill-fluid gradient (psi/ft)', '0.465', ' min="0"') +
            _fg('gl_ftub', 'Design tubing effect at surface, share of p_so − p_wh (%)', '20', ' min="0" max="100"') +
            _fg('gl_minsp', 'Minimum valve spacing (ft)', '250', ' min="0"') +
            _fg('gl_R', 'Valve port / bellows area ratio R (e.g. 1½-in valve, ¼-in port 0.067)', '0.067', ' min="0" max="0.5"') +
            '</div><div class="btn-row"><button class="btn btn-primary" id="gl_calc" onclick="calcGasLift()">Calculate</button></div></div>' +
            '<div id="gl_res"></div>' +
            '</div>';
        _tag(UNITS);
        var root = _byId('gl_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^gl_/.test(e.target.id || '')) G.calcGasLift();
            });
        }
        G.calcGasLift();
    }
    G.renderGasLift = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.gaslift = {
        key: 'gaslift',
        title: TITLE,
        navTitle: 'Gas Lift Design',
        sub: SUB,
        group: 'Production & Reservoir',
        icon: '&#8593;',
        badge: 'Artificial lift',
        bc: 'dc-b-green',
        desc: 'Injection-gas gradient, point of injection, gas requirement, unloading-valve spacing and valve schedule with a pressure–depth chart.',
        render: function (body) { return G.renderGasLift(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('gl_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcGasLift();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (!G.PRiSM_pvt_correlations || typeof G.WTS_gradient_compute !== 'function' || typeof G.WTS_flowline_march !== 'function') return;
    var fails = [], n = 0;
    function yes(c, what) { n++; if (!c) fails.push(what); }
    // Gas column: exponential with the average Z (independent of the iteration's start)
    var c = G.WTS_gaslift_casingP(1000, 8000, 0.65, 110, 190);
    var b = 0.01875 * 0.65 / (c.z * (150 + 459.67));
    yes(Math.abs(c.p - ((1014.696) * Math.exp(b * 8000) - 14.696)) < 0.02 * (c.p - 1000), 'gas column');
    var ct = G.WTS_gaslift_ct(1000, 160);
    yes(Math.abs(ct.ct - ct.winkler) < 0.02, 'Ct vs Winkler');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[gaslift self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[gaslift self-test] ' + n + '/' + n + ' checks passed');
    }
})();
